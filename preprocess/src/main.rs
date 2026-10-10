//! Converts the swisstopo DHM25 ASCII grid into a compact downsampled height map.
//!
//! Output:
//!   dem.json     header (dimensions, LV03 origin, cell size)
//!   dem.bin.zst  zstd-compressed u16 heights in metres, row-major from the north-west corner.
//!                0 = NODATA (outside Switzerland). Values are delta-encoded (wrapping,
//!                row-major) and split into a low-byte plane followed by a high-byte plane.
//!   dem.u16      with --raw instead of dem.bin.zst: the same heights as plain little-endian u16,
//!                uncompressed and not delta-encoded, for experiments.
//!
//! Downsampling takes the *minimum* of each block so narrow river channels stay open.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;

const ASC_NAME: &str = "ASCII_GRID_1part/dhm25_grid_raster.asc";

struct Header {
    ncols: usize,
    nrows: usize,
    xllcorner: f64,
    yllcorner: f64,
    cellsize: f64,
    nodata: f64,
}

fn read_header(reader: &mut impl BufRead) -> Header {
    let mut get = |key: &str| -> f64 {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut parts = line.split_whitespace();
        let k = parts.next().unwrap();
        assert!(k.eq_ignore_ascii_case(key), "expected {key}, got {k}");
        parts.next().unwrap().parse().unwrap()
    };
    Header {
        ncols: get("ncols") as usize,
        nrows: get("nrows") as usize,
        xllcorner: get("xllcorner"),
        yllcorner: get("yllcorner"),
        cellsize: get("cellsize"),
        nodata: get("NODATA_value"),
    }
}

/// Fast whitespace-separated number tokenizer over a byte stream.
struct Tokens<R: Read> {
    reader: R,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
}

impl<R: Read> Tokens<R> {
    fn new(reader: R) -> Self {
        Self { reader, buf: vec![0; 1 << 20], pos: 0, len: 0 }
    }

    fn byte(&mut self) -> Option<u8> {
        if self.pos == self.len {
            self.len = self.reader.read(&mut self.buf).unwrap();
            self.pos = 0;
            if self.len == 0 {
                return None;
            }
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Some(b)
    }

    fn next_f64(&mut self) -> f64 {
        let mut b = self.byte().expect("unexpected end of file");
        while b.is_ascii_whitespace() {
            b = self.byte().expect("unexpected end of file");
        }
        let neg = b == b'-';
        if neg {
            b = self.byte().unwrap();
        }
        let mut int: u64 = 0;
        let mut frac: u64 = 0;
        let mut frac_div: f64 = 1.0;
        let mut in_frac = false;
        loop {
            match b {
                b'0'..=b'9' => {
                    if in_frac {
                        frac = frac * 10 + (b - b'0') as u64;
                        frac_div *= 10.0;
                    } else {
                        int = int * 10 + (b - b'0') as u64;
                    }
                }
                b'.' => in_frac = true,
                _ => break,
            }
            match self.byte() {
                Some(next) => b = next,
                None => break,
            }
        }
        let v = int as f64 + frac as f64 / frac_div;
        if neg { -v } else { v }
    }
}

/// Delta encode, split into byte planes for better compression, then zstd.
fn encode(heights: &[u16]) -> Vec<u8> {
    let n = heights.len();
    let mut planes = vec![0u8; 2 * n];
    let mut prev = 0u16;
    for (i, &v) in heights.iter().enumerate() {
        let d = v.wrapping_sub(prev);
        prev = v;
        planes[i] = d as u8;
        planes[n + i] = (d >> 8) as u8;
    }
    zstd::bulk::compress(&planes, 19).unwrap()
}

fn main() {
    let raw = std::env::args().any(|a| a == "--raw");
    let args: Vec<String> = std::env::args().filter(|a| a != "--raw").collect();
    let input = PathBuf::from(args.get(1).map(String::as_str).unwrap_or("../DHM25_MM_ASCII_GRID.zip"));
    let out_dir = PathBuf::from(args.get(2).map(String::as_str).unwrap_or("../web/data/50m"));
    let factor: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(2);

    let mut archive = zip::ZipArchive::new(File::open(&input).expect("open zip")).unwrap();
    let entry = archive.by_name(ASC_NAME).expect("asc file in zip");
    let mut reader = BufReader::with_capacity(1 << 20, entry);
    let h = read_header(&mut reader);
    eprintln!("input {}x{} cellsize {}", h.ncols, h.nrows, h.cellsize);

    let out_cols = h.ncols.div_ceil(factor);
    let out_rows = h.nrows.div_ceil(factor);
    let mut mins = vec![f64::INFINITY; out_cols * out_rows];

    let mut tokens = Tokens::new(reader);
    for row in 0..h.nrows {
        let out_row = row / factor;
        let dst = &mut mins[out_row * out_cols..(out_row + 1) * out_cols];
        for col in 0..h.ncols {
            let v = tokens.next_f64();
            if v != h.nodata {
                let d = &mut dst[col / factor];
                if v < *d {
                    *d = v;
                }
            }
        }
        if row % 1000 == 0 {
            eprintln!("row {row}/{}", h.nrows);
        }
    }

    let heights: Vec<u16> = mins
        .iter()
        .map(|&v| if v.is_finite() { v.round().clamp(1.0, 65535.0) as u16 } else { 0 })
        .collect();

    // Origin = north-west corner of the output grid (cell edges, not centres), in LV03.
    let out_cellsize = h.cellsize * factor as f64;
    let west = h.xllcorner;
    let north = h.yllcorner + h.nrows as f64 * h.cellsize;

    std::fs::create_dir_all(&out_dir).unwrap();
    let (file_name, bytes) = if raw {
        ("dem.u16", heights.iter().flat_map(|v| v.to_le_bytes()).collect())
    } else {
        ("dem.bin.zst", encode(&heights))
    };
    File::create(out_dir.join(file_name)).unwrap().write_all(&bytes).unwrap();
    let json = format!(
        "{{\n  \"cols\": {out_cols},\n  \"rows\": {out_rows},\n  \"west\": {west},\n  \"north\": {north},\n  \"cellsize\": {out_cellsize},\n  \"crs\": \"EPSG:21781\"\n}}\n"
    );
    File::create(out_dir.join("dem.json")).unwrap().write_all(json.as_bytes()).unwrap();

    let valid: Vec<u16> = heights.iter().copied().filter(|&v| v != 0).collect();
    eprintln!(
        "output {out_cols}x{out_rows} @ {out_cellsize}m, height {}..{} m, {} valid cells, {} bytes written to {file_name}",
        valid.iter().min().unwrap(),
        valid.iter().max().unwrap(),
        valid.len(),
        bytes.len()
    );
}
