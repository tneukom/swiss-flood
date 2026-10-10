# Swiss Flood

Draw dams on a map of Switzerland and see what floods.

## Preprocess

Turns the swisstopo DHM25 grid (`DHM25_MM_ASCII_GRID.zip`, 25 m) into a 50 m grid
(min of each 2×2 block, rounded to 1 m, delta-encoded, zstd) in `web/data/`.

    cd preprocess && cargo run --release -- ../DHM25_MM_ASCII_GRID.zip ../web/data 2

The last argument is the downsampling factor (2 → 50 m, 4 → 100 m). Add `--raw` to write plain
little-endian u16 (`dem.u16`) instead, for experiments.

## Flood model (Rust/WASM)

The height grid, flood, overlay colouring and lake search live in `flood-wasm/`, compiled to
WebAssembly. The build output in `web/pkg/` is committed, so the site needs no build to serve.
After changing the Rust code, rebuild (needs `wasm-pack` and the `wasm32-unknown-unknown`
target):

    flood-wasm/build.sh

Unit tests run natively: `cd flood-wasm && cargo test`. Benchmarks comparing the JS reference
flood and the WASM module: `cd flood-bench && node bench.js` (native Rust: `cargo run --release`).

## Run

    python3 -m http.server -d web 8000

Open http://localhost:8000. Dams are stored in the URL hash, so a link reproduces a scenario.

## How it works

Every cell bordering the outside of Switzerland is an outlet. A priority-flood with a bucket
queue (one bucket per metre) computes the water level everywhere. The flood is run once without
dams as a baseline (fills natural depressions); only cells where the level with dams is higher
than the baseline are shown. When dams change, only the cells whose baseline drainage runs
through a dam are re-flooded; all others keep their baseline level exactly.
