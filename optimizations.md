# Optimizations

Status at 50 m (7701 × 4561 = 35M cells, 23.4M inside Switzerland): one flood takes ~1.3 s in JS
(~0.6 s native Rust), memory is ~1 GB. Benchmarks: `flood-bench/` (`cargo run --release`,
`node bench.js`).

## Recompute only upstream of the dams (biggest win)

Dams only raise heights, so a cell's level can only change if its drainage path in the baseline
(no dams) passes through a dam cell. All other cells keep exactly their baseline level.

1. Mark the catchment of the dam cells: every cell whose baseline parent chain reaches a dam cell
   (one O(n) pass with memoization over the parent tree).
2. Re-flood only the catchment, seeded from the cells bordering it with their (unchanged)
   baseline levels.

Exact, not an approximation. St-Maurice dam: ~2M of 23M cells, so roughly 10× faster. A dam near
Basel drains almost all of Switzerland and gains nothing. Needs the baseline parents kept around.

## Memory trimming (~29 → ~11 bytes per cell, ~1 GB → ~390 MB)

| Array | Now | Change | After |
|---|---|---|---|
| `terrain` | 2 | keep | 2 |
| `baseLevel` | 2 | keep (seeds for the upstream recompute) | 2 |
| `level` | 2 | keep | 2 |
| `next` | 4 | keep (bucket queue needs cell indices) | 4 |
| `parent` | 4 | direction 0–7 (255 = outlet), `i += OFFSETS[parent[i]]` | 1 |
| `lakeId` | 4 | reuse `next`, which is free once the flood is done | 0 |
| `damHeight` | 2 | apply crests to `terrain` in place, keep originals of the few dam cells in a small list to restore | 0 |
| `isDam` | 1 | drop: dam cell = crest above original terrain (dams over higher ground then don't show red) | 0 |
| `ImageData` + canvas | 4 + 4 | size the overlay to the bounding box of flooded/dam cells, reposition it each update | ≈ 0 typically |

Smaller arrays should also speed up the flood (memory-bound, see below).

Not worth it: skipping NODATA cells (saves another third, but neighbour lookups need an index
table: slower and much less readable); storing `level` as an offset from `terrain`.

## Vec per bucket instead of linked lists

The bucket queue in web/flood.js is one FIFO linked list per metre (`head`/`tail` per bucket,
`next` per cell). Popping a cell reads `next[i]` at a scattered position, an extra cache miss per
cell. One growable array per bucket reads sequentially instead. In the Rust benchmark this is
~1.5× faster (850 → 600 ms) at the same memory and with identical results. In JS: one
`Int32Array` per bucket, doubled by hand when full (~4,600 buckets are actually used).

## Web Worker

Doesn't reduce compute time but keeps the map responsive during a recompute. Do it if the above
still feels sluggish.

## Rust/WASM: not worth it for now

With the same linked-list bucket queue, native Rust is only ~1.5× faster than the JS at 50 m
(2× at 100 m); WASM would land around 1.2–1.4×. The flood is memory-bound (random access into
35M-cell arrays), which Rust doesn't fix: data layout matters more than language, see the
Vec-per-bucket change above.
Costs: a build step, data copies or living in WASM memory, and no threads on GitHub Pages
(threaded WASM needs COOP/COEP headers). Reconsider after the above, for memory layout tuning.
