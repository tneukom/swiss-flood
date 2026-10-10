//! Flood model for the web app, compiled to WASM. Holds the height grid and all per-cell state in
//! WASM memory; JS passes in the compressed height map and dams, and gets back an RGBA overlay
//! (read directly from WASM memory), statistics, and lakes with their overflow paths.
//!
//! Build: `./build.sh` (wasm-pack, output in web/pkg).
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
//! and the whole flood is a single O(n) pass. FIFO order spreads evenly across flat areas, so
//! drainage paths across them are short and straight. `parent` records which neighbour each cell
//! was reached from; following it always leads downhill to an outlet.
//!
//! The flood runs once without dams (baseline, fills natural depressions) and again with dams;
//! only cells where the level with dams is above the baseline count as flooded.
//!
//! # Recomputing only upstream of the dams
//!
//! Dams only raise heights, so a cell's level can only change if its baseline drainage path
//! (following `base_parent`) runs through a dam cell; every other cell keeps its baseline level
//! exactly. `compute` therefore finds that region (walking upstream from the dam cells: neighbour
//! `j` drains into `i` iff `base_parent[j] == i`) and re-floods only it, seeded from the cells
//! bordering it, whose levels are final. Colouring, statistics and the lake search also only
//! visit the region, and the next `compute` resets just the previous region, so no step touches
//! the whole grid. Levels are identical to a full recompute; `parent` inside the region may differ
//! on perfectly flat ground (different but equally valid drainage paths).

use std::io::Read;
use wasm_bindgen::prelude::*;

/// Depth at which the colour ramp reaches its darkest blue.
const RAMP_MAX_DEPTH: f64 = 200.0;
/// Dam cells in the overlay, as RGBA bytes in memory order (little-endian u32 ABGR).
const DAM_COLOR: u32 = u32::from_le_bytes([220, 0, 0, 255]);
/// Values of `FloodModel::mark`.
const REGION: u8 = 1;
const SEED: u8 = 2;

struct Dam {
    cells: Vec<u32>,
    crest: u16,
}

struct Lake {
    start: u32,
    /// Lowest cell index in the lake, to number lakes in grid order.
    first: u32,
    cells: u32,
    level: u16,
    /// Overflow point: last lake cell on the drainage chain before the pour cell.
    spill: u32,
    /// Last cell at lake level on the chain; after it the chain descends.
    pour: u32,
    /// Index of the dam the water overflows, or -1.
    dam: i32,
}

#[wasm_bindgen]
pub struct Stats {
    /// Number of flooded cells (level above baseline, not a dam cell).
    pub flooded_cells: u32,
    /// Sum over flooded cells of (level - baseline) in metres; × cell area = volume.
    pub volume_cell_metres: f64,
}

#[wasm_bindgen]
pub struct DamInfo {
    pub cells: u32,
    /// Lowest and highest terrain under the dam, 0 if it has no cells.
    pub terrain_min: u16,
    pub terrain_max: u16,
}

#[wasm_bindgen]
pub struct FloodModel {
    cols: usize,
    rows: usize,
    /// LV95 coordinates of the grid's north-west corner (cell edge) and cell size in metres.
    west: f64,
    north: f64,
    cellsize: f64,
    /// Metres, 0 = outside Switzerland.
    terrain: Vec<u16>,
    /// Water level without dams.
    base_level: Vec<u16>,
    /// Terrain with dam crests applied.
    dam_height: Vec<u16>,
    /// Water level with dams.
    level: Vec<u16>,
    /// Cell each cell was reached from without dams, -1 for outlets.
    base_parent: Vec<i32>,
    /// Cell each cell was reached from with dams, -1 for outlets.
    parent: Vec<i32>,
    lake_id: Vec<i32>,
    is_dam: Vec<u8>,
    rgba: Vec<u32>,
    /// Cells whose level may differ from the baseline in the last compute (dam cells and their
    /// upstream catchment). Outside of it, every per-cell array holds its baseline state.
    region: Vec<u32>,
    /// REGION / SEED marks during compute, 0 otherwise.
    mark: Vec<u8>,
    /// Cells bordering the region, used as starting points of the region flood.
    seeds: Vec<u32>,
    outlets: Vec<u32>,
    buckets: Vec<Vec<u32>>,
    ramp: [u32; 256],
    dams: Vec<Dam>,
    lakes: Vec<Lake>,
}

#[wasm_bindgen]
impl FloodModel {
    /// `compressed`: dem.bin.zst (zstd of delta-encoded u16 heights split into low/high byte
    /// planes, see preprocess/). `west`/`north`: LV95 north-west corner.
    #[wasm_bindgen(constructor)]
    pub fn new(
        compressed: &[u8],
        cols: u32,
        rows: u32,
        west: f64,
        north: f64,
        cellsize: f64,
    ) -> Result<FloodModel, JsError> {
        let (cols, rows) = (cols as usize, rows as usize);
        let terrain = decode(compressed, cols * rows)?;
        Ok(Self::from_terrain(terrain, cols, rows, west, north, cellsize))
    }

    pub fn cols(&self) -> u32 {
        self.cols as u32
    }

    pub fn rows(&self) -> u32 {
        self.rows as u32
    }

    /// Rasterizes a dam polyline without adding it, e.g. to pick a default crest.
    /// `xy`: LV95 coordinates as [x0, y0, x1, y1, ...].
    pub fn dam_info(&self, xy: &[f64]) -> DamInfo {
        let cells = self.dam_cells(xy);
        let heights = cells.iter().map(|&i| self.terrain[i as usize]);
        DamInfo {
            cells: cells.len() as u32,
            terrain_min: heights.clone().min().unwrap_or(0),
            terrain_max: heights.max().unwrap_or(0),
        }
    }

    pub fn clear_dams(&mut self) {
        self.dams.clear();
    }

    /// Adds a dam (LV95 polyline as [x0, y0, x1, y1, ...]) with its crest in metres a.s.l.
    /// Dams are numbered in the order they're added, which `lake_dam` refers to.
    pub fn add_dam(&mut self, xy: &[f64], crest: u16) {
        let cells = self.dam_cells(xy);
        self.dams.push(Dam { cells, crest });
    }

    /// Floods with the current dams, renders the overlay and finds lakes. Only recomputes the
    /// region upstream of the dams, see the module docs.
    pub fn compute(&mut self) -> Stats {
        let (cols, rows) = (self.cols, self.rows);

        // Undo the previous compute: outside the region everything is in its baseline state.
        for &i in &self.region {
            let i = i as usize;
            self.level[i] = self.base_level[i];
            self.parent[i] = self.base_parent[i];
            self.dam_height[i] = self.terrain[i];
            self.is_dam[i] = 0;
            self.rgba[i] = 0;
            self.lake_id[i] = -1;
            self.mark[i] = 0;
        }
        self.region.clear();

        // Apply dams; dam cells start the region.
        for dam in &self.dams {
            for &i in &dam.cells {
                let i = i as usize;
                self.dam_height[i] = self.dam_height[i].max(dam.crest);
                self.is_dam[i] = 1;
                if self.mark[i] == 0 {
                    self.mark[i] = REGION;
                    self.region.push(i as u32);
                }
            }
        }

        // Grow the region upstream: neighbour j drains into i in the baseline iff
        // base_parent[j] == i.
        let mut k = 0;
        while k < self.region.len() {
            let i = self.region[k] as usize;
            k += 1;
            let (r, c) = (i / cols, i % cols);
            for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                    let j = rr * cols + cc;
                    if self.mark[j] == 0 && self.base_parent[j] == i as i32 {
                        self.mark[j] = REGION;
                        self.region.push(j as u32);
                    }
                }
            }
        }

        // Re-flood the region. Seeds: outlets inside it (at their dammed height) and the valid
        // cells bordering it (at their baseline level, which can't change).
        for &i in &self.region {
            self.level[i as usize] = 0;
        }
        for &i in &self.region {
            let i = i as usize;
            if self.base_parent[i] == -1 {
                self.level[i] = self.dam_height[i];
                self.parent[i] = -1;
                self.buckets[self.dam_height[i] as usize].push(i as u32);
            }
            let (r, c) = (i / cols, i % cols);
            for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                    let j = rr * cols + cc;
                    if self.mark[j] == 0 && self.terrain[j] != 0 {
                        self.mark[j] = SEED;
                        self.seeds.push(j as u32);
                        self.buckets[self.level[j] as usize].push(j as u32);
                    }
                }
            }
        }
        drain(cols, rows, &self.dam_height, &mut self.level, &mut self.parent, &mut self.buckets);
        for &j in &self.seeds {
            self.mark[j as usize] = 0;
        }
        self.seeds.clear();

        let mut stats = Stats { flooded_cells: 0, volume_cell_metres: 0.0 };
        for &i in &self.region {
            let i = i as usize;
            self.rgba[i] = if self.is_dam[i] != 0 {
                DAM_COLOR
            } else if self.level[i] > self.base_level[i] {
                let depth = (self.level[i] - self.terrain[i]) as f64;
                stats.flooded_cells += 1;
                stats.volume_cell_metres += (self.level[i] - self.base_level[i]) as f64;
                self.ramp[((depth * 255.0 / RAMP_MAX_DEPTH).round() as usize).min(255)]
            } else {
                0
            };
        }
        self.find_lakes();
        stats
    }

    /// Pointer to the RGBA overlay (cols × rows × 4 bytes) in WASM memory. Create the JS view
    /// after `compute`: if WASM memory grew, older views are detached.
    pub fn rgba_ptr(&self) -> *const u32 {
        self.rgba.as_ptr()
    }

    /// Pointer to the water levels with dams (cols × rows u16), for tests and benchmarks.
    pub fn level_ptr(&self) -> *const u16 {
        self.level.as_ptr()
    }

    /// Pointer to the terrain with dam crests applied (cols × rows u16), for tests and benchmarks.
    pub fn dam_height_ptr(&self) -> *const u16 {
        self.dam_height.as_ptr()
    }

    /// Number of cells the last compute re-flooded (dam cells and their upstream catchment).
    pub fn region_cells(&self) -> u32 {
        self.region.len() as u32
    }

    pub fn terrain_at(&self, i: u32) -> u16 {
        self.terrain[i as usize]
    }

    pub fn level_at(&self, i: u32) -> u16 {
        self.level[i as usize]
    }

    pub fn base_level_at(&self, i: u32) -> u16 {
        self.base_level[i as usize]
    }

    pub fn lake_count(&self) -> u32 {
        self.lakes.len() as u32
    }

    pub fn lake_cells(&self, k: u32) -> u32 {
        self.lakes[k as usize].cells
    }

    pub fn lake_level(&self, k: u32) -> u16 {
        self.lakes[k as usize].level
    }

    pub fn lake_spill(&self, k: u32) -> u32 {
        self.lakes[k as usize].spill
    }

    pub fn lake_pour(&self, k: u32) -> u32 {
        self.lakes[k as usize].pour
    }

    /// Index of the dam the lake overflows, or -1.
    pub fn lake_dam(&self, k: u32) -> i32 {
        self.lakes[k as usize].dam
    }

    /// True if the pour cell is an outlet, i.e. the lake drains straight across the border.
    pub fn lake_drains_to_border(&self, k: u32) -> bool {
        self.parent[self.lakes[k as usize].pour as usize] == -1
    }

    /// Cells from the overflow point down to the border.
    pub fn lake_path(&self, k: u32) -> Vec<u32> {
        let mut path = Vec::new();
        let mut j = self.lakes[k as usize].spill as i32;
        while j != -1 {
            path.push(j as u32);
            j = self.parent[j as usize];
        }
        path
    }
}

impl FloodModel {
    fn from_terrain(terrain: Vec<u16>, cols: usize, rows: usize, west: f64, north: f64, cellsize: f64) -> Self {
        let n = cols * rows;
        let mut model = FloodModel {
            cols,
            rows,
            west,
            north,
            cellsize,
            base_level: vec![0; n],
            dam_height: terrain.clone(),
            level: vec![0; n],
            base_parent: vec![0; n],
            parent: vec![0; n],
            lake_id: vec![-1; n],
            is_dam: vec![0; n],
            rgba: vec![0; n],
            region: Vec::new(),
            mark: vec![0; n],
            seeds: Vec::new(),
            outlets: find_outlets(&terrain, cols, rows),
            terrain,
            buckets: (0..65536).map(|_| Vec::new()).collect(),
            ramp: depth_ramp(),
            dams: Vec::new(),
            lakes: Vec::new(),
        };
        flood(
            cols,
            rows,
            &model.terrain,
            &model.outlets,
            &mut model.base_level,
            &mut model.base_parent,
            &mut model.buckets,
        );
        model.level.copy_from_slice(&model.base_level);
        model.parent.copy_from_slice(&model.base_parent);
        model
    }

    fn to_cell(&self, x: f64, y: f64) -> (i64, i64) {
        (((x - self.west) / self.cellsize).floor() as i64, ((self.north - y) / self.cellsize).floor() as i64)
    }

    /// Grid cells under a polyline, inside Switzerland, deduplicated.
    fn dam_cells(&self, xy: &[f64]) -> Vec<u32> {
        let points: Vec<(i64, i64)> = xy.chunks_exact(2).map(|p| self.to_cell(p[0], p[1])).collect();
        let mut cells = Vec::new();
        let mut visit = |c: i64, r: i64| {
            if c >= 0 && r >= 0 && (c as usize) < self.cols && (r as usize) < self.rows {
                cells.push((r as usize * self.cols + c as usize) as u32);
            }
        };
        if points.len() == 1 {
            visit(points[0].0, points[0].1);
        }
        for w in points.windows(2) {
            raster_line(w[0], w[1], &mut visit);
        }
        cells.sort_unstable();
        cells.dedup();
        cells.retain(|&i| self.terrain[i as usize] != 0);
        cells
    }

    fn is_flooded(&self, i: usize) -> bool {
        self.is_dam[i] == 0 && self.level[i] > self.base_level[i]
    }

    /// Groups flooded cells into lakes (8-connected; all cells of a lake share one level) and
    /// traces where each one drains. Following parents from a lake cell stays at lake level
    /// (across the lake, shore cells exactly at lake level, dam crests) until the pour cell, after
    /// which it descends. The overflow point is the last lake cell before the pour cell; the cells
    /// between them tell whether the water goes over a dam.
    fn find_lakes(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        self.lakes.clear();
        let mut stack = Vec::new();
        // Flooded cells are all in the region; lake_id was reset there by compute.
        for k in 0..self.region.len() {
            let s = self.region[k] as usize;
            if self.lake_id[s] != -1 || !self.is_flooded(s) {
                continue;
            }
            let id = self.lakes.len() as i32;
            let (mut cells, mut first) = (0, s);
            self.lake_id[s] = id;
            stack.push(s);
            while let Some(i) = stack.pop() {
                cells += 1;
                first = first.min(i);
                let (r, c) = (i / cols, i % cols);
                for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                    for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                        let j = rr * cols + cc;
                        if self.lake_id[j] == -1 && self.is_flooded(j) {
                            self.lake_id[j] = id;
                            stack.push(j);
                        }
                    }
                }
            }
            self.lakes.push(Lake {
                start: s as u32,
                first: first as u32,
                cells,
                level: self.level[s],
                spill: 0,
                pour: 0,
                dam: -1,
            });
        }

        for k in 0..self.lakes.len() {
            let Lake { start, level, .. } = self.lakes[k];
            let id = self.lake_id[start as usize];
            let (mut spill, mut pour) = (start as usize, start as usize);
            while self.parent[pour] != -1 && self.level[self.parent[pour] as usize] == level {
                pour = self.parent[pour] as usize;
                if self.lake_id[pour] == id {
                    spill = pour;
                }
            }
            let mut dam = -1;
            let mut j = spill;
            loop {
                if self.is_dam[j] != 0 {
                    dam = self.dams.iter().position(|d| d.cells.binary_search(&(j as u32)).is_ok()).map_or(-1, |p| p as i32);
                }
                if j == pour {
                    break;
                }
                j = self.parent[j] as usize;
            }
            let lake = &mut self.lakes[k];
            lake.spill = spill as u32;
            lake.pour = pour as u32;
            lake.dam = dam;
        }
        self.lakes.sort_unstable_by_key(|lake| lake.first);
    }
}

fn decode(compressed: &[u8], n: usize) -> Result<Vec<u16>, JsError> {
    let mut planes = Vec::with_capacity(2 * n);
    ruzstd::decoding::StreamingDecoder::new(compressed)
        .map_err(|e| JsError::new(&format!("zstd: {e}")))?
        .read_to_end(&mut planes)
        .map_err(|e| JsError::new(&format!("zstd: {e}")))?;
    if planes.len() != 2 * n {
        return Err(JsError::new(&format!("expected {} bytes, got {}", 2 * n, planes.len())));
    }
    let mut height = vec![0u16; n];
    let mut prev = 0u16;
    for i in 0..n {
        prev = prev.wrapping_add(planes[i] as u16 | (planes[n + i] as u16) << 8);
        height[i] = prev;
    }
    Ok(height)
}

/// Valid cells adjacent to NODATA or the grid border.
fn find_outlets(height: &[u16], cols: usize, rows: usize) -> Vec<u32> {
    let mut outlets = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let i = r * cols + c;
            if height[i] == 0 {
                continue;
            }
            let edge = r == 0 || c == 0 || r == rows - 1 || c == cols - 1 || {
                let mut nodata_neighbour = false;
                for rr in r - 1..=r + 1 {
                    for cc in c - 1..=c + 1 {
                        nodata_neighbour |= height[rr * cols + cc] == 0;
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

/// Priority-flood with a FIFO bucket queue from the outlets, see the module docs. `buckets`
/// (65536 entries) is scratch space whose capacities are kept between runs.
fn flood(
    cols: usize,
    rows: usize,
    height: &[u16],
    outlets: &[u32],
    level: &mut [u16],
    parent: &mut [i32],
    buckets: &mut [Vec<u32>],
) {
    level.fill(0); // 0 = not yet visited
    for &i in outlets {
        let i = i as usize;
        level[i] = height[i];
        parent[i] = -1;
        buckets[height[i] as usize].push(i as u32);
    }
    drain(cols, rows, height, level, parent, buckets);
}

/// Runs the bucket queue until empty: each queued cell (whose level is final) assigns
/// `max(height, its level)` to its unvisited (level 0) neighbours and queues them.
fn drain(cols: usize, rows: usize, height: &[u16], level: &mut [u16], parent: &mut [i32], buckets: &mut [Vec<u32>]) {
    for b in 1..buckets.len() {
        // Take the bucket out so cells at the current level can be appended to it while it's
        // being read; the loop picks them up in FIFO order.
        let mut bucket = std::mem::take(&mut buckets[b]);
        let mut k = 0;
        while k < bucket.len() {
            let i = bucket[k] as usize;
            k += 1;
            let (r, c) = (i / cols, i % cols);
            for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                    let j = rr * cols + cc;
                    if level[j] != 0 || height[j] == 0 {
                        continue;
                    }
                    let v = height[j].max(b as u16);
                    level[j] = v;
                    parent[j] = i as i32;
                    if v as usize == b {
                        bucket.push(j as u32);
                    } else {
                        buckets[v as usize].push(j as u32);
                    }
                }
            }
        }
        bucket.clear();
        buckets[b] = bucket;
    }
}

/// 4-connected line (Zingl): 4-connected barriers are watertight against the 8-connected flood.
fn raster_line((mut c0, mut r0): (i64, i64), (c1, r1): (i64, i64), visit: &mut impl FnMut(i64, i64)) {
    let (dx, sx) = ((c1 - c0).abs(), if c0 < c1 { 1 } else { -1 });
    let (dy, sy) = (-(r1 - r0).abs(), if r0 < r1 { 1 } else { -1 });
    let mut err = dx + dy;
    loop {
        visit(c0, r0);
        if c0 == c1 && r0 == r1 {
            break;
        }
        let e2 = 2 * err;
        if e2 - dy > dx - e2 {
            err += dy;
            c0 += sx;
        } else {
            err += dx;
            r0 += sy;
        }
    }
}

/// Depth colour ramp: light cyan (shallow) to dark blue (deep), as RGBA bytes in memory order.
fn depth_ramp() -> [u32; 256] {
    let (a, b) = ([170.0, 230.0, 255.0], [8.0, 40.0, 140.0]);
    std::array::from_fn(|k| {
        let t = (k as f64 / 255.0).sqrt();
        let [r, g, bl] = std::array::from_fn(|j| (a[j] + (b[j] - a[j]) * t).round() as u8);
        u32::from_le_bytes([r, g, bl, 255])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a model from heights directly (rows of equal length), bypassing decompression.
    fn model(rows: &[&[u16]]) -> FloodModel {
        FloodModel::from_terrain(rows.concat(), rows[0].len(), rows.len(), 0.0, rows.len() as f64, 1.0)
    }

    /// Cell centre in model coordinates (west = 0, north = rows, cellsize 1).
    fn xy(m: &FloodModel, c: usize, r: usize) -> [f64; 2] {
        [c as f64 + 0.5, m.rows as f64 - r as f64 - 0.5]
    }

    #[test]
    fn natural_depression_is_filled_in_baseline() {
        let m = model(&[
            &[9, 9, 9, 9, 9],
            &[9, 5, 5, 5, 9],
            &[9, 5, 2, 5, 9],
            &[9, 5, 5, 5, 4],
            &[9, 9, 9, 9, 9],
        ]);
        // The pit drains over the 4 m cell on the east edge, so it fills to 5 (its rim).
        assert_eq!(m.base_level[2 * 5 + 2], 5);
        assert_eq!(m.base_level[1 * 5 + 1], 5);
    }

    #[test]
    fn dam_raises_valley_and_overflows_around_its_end() {
        // A valley draining south through column 2. The east side is high (20), the west
        // side lower (12), so a 15 m dam spanning only columns 1..=3 overflows over the west rim.
        let mut m = model(&[
            &[20, 12, 20, 20, 20],
            &[20, 12, 10, 20, 20],
            &[20, 12, 8, 20, 20],
            &[20, 12, 6, 20, 20],
            &[20, 12, 4, 20, 20],
            &[20, 20, 2, 20, 20],
        ]);
        let mut line = Vec::new();
        line.extend(xy(&m, 2, 4));
        line.extend(xy(&m, 3, 4));
        m.add_dam(&line, 15);
        let stats = m.compute();
        assert!(stats.flooded_cells > 0);
        // Water behind the dam rises to the west rim (12) and spills there, not over the dam.
        assert_eq!(m.level[3 * 5 + 2], 12);
        assert_eq!(m.lake_count(), 1);
        assert_eq!(m.lake_level(0), 12);
        assert_eq!(m.lake_dam(0), -1);
    }

    #[test]
    fn dam_overtopped_when_lower_than_the_rim() {
        let mut m = model(&[
            &[20, 20, 20, 20, 20],
            &[20, 20, 10, 20, 20],
            &[20, 20, 8, 20, 20],
            &[20, 20, 6, 20, 20],
            &[20, 20, 4, 20, 20],
            &[20, 20, 2, 20, 20],
        ]);
        let mut line = Vec::new();
        line.extend(xy(&m, 1, 4));
        line.extend(xy(&m, 3, 4));
        m.add_dam(&line, 9);
        m.compute();
        assert_eq!(m.lake_count(), 1);
        assert_eq!(m.lake_level(0), 9);
        assert_eq!(m.lake_dam(0), 0);
        // The overflow path starts at the lake edge just above the dam and runs to the border.
        let path = m.lake_path(0);
        assert_eq!(path[0], 3 * 5 + 2);
        assert_eq!(*path.last().unwrap(), 5 * 5 + 2);
    }

    #[test]
    fn dam_line_is_4_connected() {
        let row: &[u16] = &[20; 6];
        let m = model(&[row; 6]);
        let mut line = Vec::new();
        line.extend(xy(&m, 0, 0));
        line.extend(xy(&m, 5, 5));
        let cells = m.dam_cells(&line);
        let mut sorted: Vec<(usize, usize)> = cells.iter().map(|&i| (i as usize / 6, i as usize % 6)).collect();
        sorted.sort();
        // A diagonal needs 11 cells when every step is horizontal or vertical.
        assert_eq!(sorted.len(), 11);
    }

    /// Full flood of the current dammed heights from scratch, for comparison.
    fn full_levels(m: &FloodModel) -> Vec<u16> {
        let n = m.terrain.len();
        let (mut level, mut parent) = (vec![0; n], vec![0; n]);
        let mut buckets: Vec<Vec<u32>> = (0..65536).map(|_| Vec::new()).collect();
        flood(m.cols, m.rows, &m.dam_height, &m.outlets, &mut level, &mut parent, &mut buckets);
        level
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn upstream_recompute_matches_full_flood() {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        let (mut runs_with_lakes, mut total_runs) = (0, 0);
        for _ in 0..20 {
            let (cols, rows) = (40, 30);
            // Rough terrain: random heights smoothed a little, with some NODATA holes, so there
            // are valleys, pits, flats (from smoothing + integer rounding) and inner outlets.
            let noise: Vec<u64> = (0..cols * rows).map(|_| rng.below(60)).collect();
            let mut terrain = vec![0u16; cols * rows];
            for r in 0..rows {
                for c in 0..cols {
                    let mut sum = 0;
                    let mut count = 0;
                    for rr in r.saturating_sub(1)..=(r + 1).min(rows - 1) {
                        for cc in c.saturating_sub(1)..=(c + 1).min(cols - 1) {
                            sum += noise[rr * cols + cc];
                            count += 1;
                        }
                    }
                    terrain[r * cols + c] = (1 + sum / count) as u16;
                }
            }
            for _ in 0..5 {
                terrain[rng.below((cols * rows) as u64) as usize] = 0;
            }
            let mut m = FloodModel::from_terrain(terrain, cols, rows, 0.0, rows as f64, 1.0);

            // Several dam configurations in a row, so resetting the previous region is tested too.
            for _ in 0..5 {
                m.clear_dams();
                for _ in 0..rng.below(4) {
                    let mut xy = Vec::new();
                    for _ in 0..2 + rng.below(3) {
                        xy.push(rng.below(cols as u64) as f64 + 0.5);
                        xy.push(rng.below(rows as u64) as f64 + 0.5);
                    }
                    m.add_dam(&xy, 20 + rng.below(60) as u16);
                }
                let stats = m.compute();
                assert_eq!(m.level, full_levels(&m));
                total_runs += 1;
                runs_with_lakes += (m.lake_count() > 0) as usize;

                let flooded = (0..m.level.len()).filter(|&i| m.is_flooded(i)).count();
                assert_eq!(stats.flooded_cells as usize, flooded);
                // Outside the region, everything must be back in its baseline state.
                for i in 0..m.level.len() {
                    if m.mark[i] == 0 {
                        assert_eq!(m.parent[i], m.base_parent[i]);
                        assert_eq!(m.rgba[i], 0);
                        assert_eq!(m.dam_height[i], m.terrain[i]);
                    }
                }
                // Every overflow path ends at an outlet and never rises.
                for k in 0..m.lake_count() {
                    let path = m.lake_path(k);
                    assert_eq!(m.parent[*path.last().unwrap() as usize], -1);
                    assert!(path.windows(2).all(|w| m.level[w[1] as usize] <= m.level[w[0] as usize]));
                }
            }
        }
        // Make sure the random cases actually exercise flooding.
        assert!(runs_with_lakes > total_runs / 3, "{runs_with_lakes} of {total_runs} runs had lakes");
    }
}
