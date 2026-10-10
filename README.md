# Swiss Flood

Draw dams on a map of Switzerland and see what floods. Heavily AI assisted.

## Preprocess

Turns the swisstopo DHM25 grid (`DHM25_MM_ASCII_GRID.zip`, 25 m) into coarser grids (min of each
block, rounded to 1 m, delta-encoded, zstd): 50 m in `web/data/50m/` for desktops, 100 m in
`web/data/100m/` for phones and tablets (4× fewer cells, faster and less memory).

    cd preprocess
    cargo run --release -- ../DHM25_MM_ASCII_GRID.zip ../web/data/50m 2
    cargo run --release -- ../DHM25_MM_ASCII_GRID.zip ../web/data/100m 4

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

## UI

`web/ui/` is the SwissFloodUI module (panel / bottom sheet, dam cards, layer menu, draw mode),
originally exported from a design tool; its API is documented at the top of
`swissflood-ui.js`. Local changes: water level/depth in the cursor readout (`getWater`) and an
optional `note` line on dam cards; in touch mode the drawing rubber band follows the crosshair only,
not the mouse; Delete/Backspace deletes the selected dam; Open/Download buttons and file drop
for dams files; an Examples menu; a
notice box (`setNotice`) for loading status and errors, visible on phones too. The phone bottom sheet
collapses to the totals by tapping or swiping its handle. A labelled Share button (round icon
button top right on phones) with a "Link copied" toast (`toast`). `web/flood.js` sets up the LV95 map and connects the UI
callbacks to the WASM model.

## Dams file

The panel's download button saves the dams as `swissflood-dams.json`; the open button (or dropping
the file on the map) replaces the current dams with the file's. Points are LV95 metres
(EPSG:2056). Only `name`, `crest` and `points` are read back; the other fields are informational.

```json
{
  "format": "swissflood-dams",
  "version": 1,
  "crs": "EPSG:2056",
  "flooded_area_km2": 3.1,
  "water_added_km3": 0.12,
  "dams": [
    {
      "name": "Dam 1",
      "crest": 512,
      "points": [[2566120, 1118430], [2566480, 1118210]],
      "length_m": 422,
      "ground_min": 417,
      "ground_max": 427,
      "lake_level": 510
    }
  ]
}
```

`lake_level` is the highest water level touching the dam, `null` if it holds no water.

The "Examples" menu loads dams files from `web/examples/` (listed in `EXAMPLES` in
`web/flood.js`); the first one opens on startup when the URL has no dams.

## Run

    python3 -m http.server -d web 8000

Open http://localhost:8000. Dams are stored in the URL hash, so a link reproduces a scenario.
Touch devices (primary pointer coarse, no hover) load the 100 m grid, others the 50 m grid;
`?grid=50` or `?grid=100` forces one.

Pushes to `main` publish `web/` to GitHub Pages (`.github/workflows/pages.yml`; needs
Settings → Pages → Source: GitHub Actions): https://tneukom.github.io/swiss-flood/
The workflow stamps the commit and its date into `VERSION` in `web/flood.js`, shown at the bottom
of the Map layers menu ("dev" locally).

## How it works

Every cell bordering the outside of Switzerland is an outlet. A priority-flood with a bucket
queue (one bucket per metre) computes the water level everywhere. The flood is run once without
dams as a baseline (fills natural depressions); only cells where the level with dams is higher
than the baseline are shown. When dams change, only the cells whose baseline drainage runs
through a dam are re-flooded; all others keep their baseline level exactly.
