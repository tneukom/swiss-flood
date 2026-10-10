//! Native port of `flood()` from web/flood.js, to see how much faster Rust (and so at best a
//! WASM module) would be. Reads web/data/50m/dem.json + dem.bin.zst. Same algorithm and results,
//! but the bucket queue uses a Vec per metre instead of the JS version's linked lists.
//!
//!     cargo run --release -- [data dir, default ../web/data/50m]
//!
//! # Algorithm
//!
//! Priority-flood (Barnes et al. 2014) computes the water level of every cell: the lowest height
//! water at that cell would have to rise to before it can drain off the map.
//!
//! 1. Every valid cell bordering NODATA (outside Switzerland) or the grid edge is an outlet; its
//!    level is its own height. Outlets go into a priority queue keyed by level.
//! 2. Repeatedly take the lowest cell from the queue. Each unvisited 8-neighbour gets
//!    `level = max(own height, level of the cell it was reached from)` and is queued. A neighbour
//!    lower than the current level lies in a depression and is filled up to that level.
//! 3. Because cells are processed in increasing level order, each cell is reached along the
//!    lowest possible route from an outlet, so its level is final when it's first visited.
//!
//! Heights are integer metres, so the priority queue is a bucket queue: one FIFO `Vec` per metre,
//! and the whole flood is a single O(n) pass. FIFO order spreads evenly across flat areas.
//! A `Vec` per bucket is ~1.5× faster than linked lists (`next[i]` per cell, as in web/flood.js)
//! at the same memory: reading a bucket is sequential instead of a scattered `next[i]` load per
//! cell, and this loop is memory-bound. `parent` records which neighbour each cell was
//! reached from; following it always leads downhill to an outlet, which the web app uses for
//! overflow paths.

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

/// Scratch buffers, allocated once like in the web app; bucket capacities are kept between runs.
struct Flood {
    level: Vec<u16>,
    parent: Vec<i32>,
    buckets: Vec<Vec<u32>>,
}

impl Flood {
    fn new(n: usize) -> Self {
        Self { level: vec![0; n], parent: vec![0; n], buckets: (0..65536).map(|_| Vec::new()).collect() }
    }

    /// Priority-flood with FIFO bucket queue.
    fn run(&mut self, g: &Grid, outlets: &[u32]) {
        let (cols, rows) = (g.cols, g.rows);
        self.level.fill(0);
        for &i in outlets {
            let i = i as usize;
            self.level[i] = g.height[i];
            self.parent[i] = -1;
            self.buckets[g.height[i] as usize].push(i as u32);
        }
        for b in 1..65536usize {
            // Take the bucket out so cells at the current level can be appended to it while
            // it's being read; the loop picks them up in FIFO order.
            let mut bucket = std::mem::take(&mut self.buckets[b]);
            let mut k = 0;
            while k < bucket.len() {
                let i = bucket[k] as usize;
                k += 1;
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
                        if v as usize == b {
                            bucket.push(j as u32);
                        } else {
                            self.buckets[v as usize].push(j as u32);
                        }
                    }
                }
            }
            bucket.clear();
            self.buckets[b] = bucket;
        }
    }
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or("../web/data/50m".into());
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
