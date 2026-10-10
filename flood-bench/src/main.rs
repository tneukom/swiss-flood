//! Native port of `flood()` from web/flood.js, to see how much faster Rust (and so at best a
//! WASM module) would be. Reads web/data/dem.json + dem.bin.zst.
//!
//!     cargo run --release -- [data dir, default ../web/data]

use std::time::Instant;

struct Grid {
    cols: usize,
    rows: usize,
    height: Vec<u16>,
}

fn load(dir: &str) -> Grid {
    let header = std::fs::read_to_string(format!("{dir}/dem.json")).unwrap();
    let field = |key: &str| -> usize {
        let rest = &header[header.find(&format!("\"{key}\"")).unwrap()..];
        let value = rest.split(':').nth(1).unwrap().split([',', '\n']).next().unwrap();
        value.trim().parse::<f64>().unwrap() as usize
    };
    let (cols, rows) = (field("cols"), field("rows"));
    let n = cols * rows;
    let compressed = std::fs::read(format!("{dir}/dem.bin.zst")).unwrap();
    let planes = zstd::bulk::decompress(&compressed, 2 * n).unwrap();
    let mut height = vec![0u16; n];
    let mut prev = 0u16;
    for i in 0..n {
        prev = prev.wrapping_add(planes[i] as u16 | (planes[n + i] as u16) << 8);
        height[i] = prev;
    }
    Grid { cols, rows, height }
}

/// Valid cells adjacent to NODATA or the grid border.
fn find_outlets(g: &Grid) -> Vec<u32> {
    let mut outlets = Vec::new();
    for r in 0..g.rows {
        for c in 0..g.cols {
            let i = r * g.cols + c;
            if g.height[i] == 0 {
                continue;
            }
            let edge = r == 0 || c == 0 || r == g.rows - 1 || c == g.cols - 1 || {
                let mut nodata_neighbour = false;
                for rr in r - 1..=r + 1 {
                    for cc in c - 1..=c + 1 {
                        nodata_neighbour |= g.height[rr * g.cols + cc] == 0;
                    }
                }
                nodata_neighbour
            };
            if edge {
                outlets.push(i as u32);
            }
        }
    }
    outlets
}

/// Scratch buffers, allocated once like in the web app.
struct Flood {
    level: Vec<u16>,
    parent: Vec<i32>,
    next: Vec<i32>,
    head: Vec<i32>,
    tail: Vec<i32>,
}

impl Flood {
    fn new(n: usize) -> Self {
        Self { level: vec![0; n], parent: vec![0; n], next: vec![0; n], head: vec![0; 65536], tail: vec![0; 65536] }
    }

    fn push(&mut self, i: usize, v: usize) {
        self.next[i] = -1;
        if self.head[v] == -1 {
            self.head[v] = i as i32;
        } else {
            self.next[self.tail[v] as usize] = i as i32;
        }
        self.tail[v] = i as i32;
    }

    /// Priority-flood with FIFO bucket queue, same as web/flood.js.
    fn run(&mut self, g: &Grid, outlets: &[u32]) {
        let (cols, rows) = (g.cols, g.rows);
        self.level.fill(0);
        self.head.fill(-1);
        for &i in outlets {
            let i = i as usize;
            self.level[i] = g.height[i];
            self.parent[i] = -1;
            self.push(i, g.height[i] as usize);
        }
        for b in 1..65536usize {
            while self.head[b] != -1 {
                let i = self.head[b] as usize;
                self.head[b] = self.next[i];
                let (r, c) = (i / cols, i % cols);
                for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                    for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                        let j = rr * cols + cc;
                        if self.level[j] != 0 || g.height[j] == 0 {
                            continue;
                        }
                        let v = g.height[j].max(b as u16);
                        self.level[j] = v;
                        self.parent[j] = i as i32;
                        self.push(j, v as usize);
                    }
                }
            }
        }
    }
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or("../web/data".into());
    let g = load(&dir);
    let outlets = find_outlets(&g);
    let mut flood = Flood::new(g.height.len());
    flood.run(&g, &outlets); // warm-up
    let times: Vec<f64> = (0..5)
        .map(|_| {
            let t = Instant::now();
            flood.run(&g, &outlets);
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    let min = times.iter().cloned().fold(f64::MAX, f64::min);
    let max = times.iter().cloned().fold(0.0, f64::max);
    println!("{}x{}: native flood {min:.0}–{max:.0} ms", g.cols, g.rows);
}
