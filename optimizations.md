# Optimizations

Status at 50 m (7701 × 4561 = 35M cells, 23.4M inside Switzerland): a full flood takes ~0.85 s in WASM
(~0.6 s native Rust), memory is ~1.2 GB. Benchmarks: `flood-bench/` (`cargo run --release`,
`node bench.js`).

## Recompute only upstream of the dams: done

Dams only raise heights, so a cell's level can only change if its baseline drainage path passes
through a dam cell. `compute()` in flood-wasm finds that region (walking upstream from the dam
cells via `base_parent`), re-floods only it seeded from its border, and colours/searches lakes
only there; the next compute resets just the previous region. Levels are identical to a full
flood (randomized unit test + real-data check in `flood-bench/bench.js`); drainage paths across
perfectly flat ground can differ.

Measured at 50 m in Node: St-Maurice dam 1.9M cells (5% of the grid), ~120 ms instead of
~850 ms. A dam on the Rhine below the Aare drains about half of Switzerland: 12.4M cells, no gain
(~820 ms). Costs ~175 MB extra memory (`base_parent` and a 1-byte mark per cell).

Remaining full-grid step: the page's `putImageData` of the whole overlay after every compute.
Could pass the region's bounding box and update only that rectangle.

## Memory trimming (~29 → ~11 bytes per cell, ~1 GB → ~390 MB)

| Array | Now | Change | After |
|---|---|---|---|
| `terrain` | 2 | keep | 2 |
| `base_level` | 2 | keep (seeds for the upstream recompute) | 2 |
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
~1.5× faster (850 → 600 ms) at the same memory and with identical results.

Done in JS too (one growable `Int32Array` per bucket, doubled when full): identical results, but
only ~10–15% faster (~1300 → ~1140 ms). In JS the per-step `buckets[b][k]` double lookup, the push
helper and bounds checks weigh more, so memory access isn't the only bottleneck there.

## Web Worker

Doesn't reduce compute time but keeps the map responsive during a recompute. Do it if the above
still feels sluggish.

## Rust/WASM: done (flood-wasm/)

The model now lives in Rust/WASM (preferred for the code, even without a big speed gain). At 50 m
in Node: JS reference flood ~0.9–1.1 s, WASM `compute()` ~0.85 s including overlay colouring and
lake search, native Rust flood ~0.6 s. The flood is memory-bound (random access into 35M-cell
arrays), so the layout changes above still matter more than the language. No threads on GitHub
Pages (threaded WASM needs COOP/COEP headers).
