// Benchmarks the JS reference flood (flood_reference.js) and the WASM module (web/pkg) in Node,
// and checks that both produce the same water levels.
//
//     node bench.js [data dir, default ../web/data/50m]
//
// Times: JS = full flood only; WASM = compute(), i.e. flood + overlay colouring + lake search,
// which only recomputes the region upstream of the dams.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const dir = process.argv[2] || path.join(__dirname, "../web/data/50m");
const header = JSON.parse(fs.readFileSync(path.join(dir, "dem.json"), "utf8"));
const compressed = fs.readFileSync(path.join(dir, "dem.bin.zst"));
const { cols, rows } = header;
const n = cols * rows;

function time(label, f) {
  f(); // warm-up
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  console.log(`${cols}x${rows}: ${label} ${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)} ms`);
}

// JS reference, compiled as a closure so its variables stay locals (eval at global scope would
// make them slow globals).
const env = {};
const jsFlood = new Function("env", `let dem, outlets;
  ${fs.readFileSync(path.join(__dirname, "flood_reference.js"), "utf8")}
  return (h, l, p) => { dem = env.dem; outlets = env.outlets; flood(h, l, p); };`)(env);

const planes = zlib.zstdDecompressSync(compressed);
const terrain = new Uint16Array(n);
for (let i = 0, prev = 0; i < n; i++) {
  prev = (prev + (planes[i] | (planes[n + i] << 8))) & 0xffff;
  terrain[i] = prev;
}
const outlets = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (terrain[i] === 0) continue;
    let edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
    for (let dr = -1; dr <= 1 && !edge; dr++) {
      for (let dc = -1; dc <= 1 && !edge; dc++) if (terrain[i + dr * cols + dc] === 0) edge = true;
    }
    if (edge) outlets.push(i);
  }
}
env.dem = { cols, rows };
env.outlets = Int32Array.from(outlets);
const jsLevel = new Uint16Array(n);
const jsParent = new Int32Array(n);
time("JS flood", () => jsFlood(terrain, jsLevel, jsParent));

(async () => {
  const { initSync, FloodModel } = await import(path.join(__dirname, "../web/pkg/flood_wasm.js"));
  const wasm = initSync({ module: fs.readFileSync(path.join(__dirname, "../web/pkg/flood_wasm_bg.wasm")) });
  const t = performance.now();
  const model = new FloodModel(compressed, cols, rows, header.west + 2000000, header.north + 1000000, header.cellsize);
  console.log(`WASM load (decompress + decode + outlets + baseline flood): ${(performance.now() - t).toFixed(0)} ms`);
  time("WASM compute, no dams", () => model.compute());

  // Without dams the level is the plain flood of the terrain, so it must match the JS exactly.
  const wasmLevel = () => new Uint16Array(wasm.memory.buffer, model.level_ptr(), n);
  let diff = 0;
  for (let i = 0, level = wasmLevel(); i < n; i++) if (level[i] !== jsLevel[i]) diff++;
  console.log(`levels differing between JS and WASM: ${diff}`);

  // With dams, WASM recomputes only upstream of them; compare with a full JS flood of the same
  // dammed terrain. LV95 polylines and crests.
  const scenarios = {
    "St-Maurice (Rhone)": [[[2565000, 1118300, 2568000, 1118300], 600]],
    "Koblenz (Rhine below the Aare)": [[[2657500, 1268000, 2657500, 1276000], 400]],
  };
  for (const [name, dams] of Object.entries(scenarios)) {
    model.clear_dams();
    for (const [xy, crest] of dams) model.add_dam(Float64Array.from(xy), crest);
    time(`WASM compute, ${name}`, () => model.compute());
    const dammed = new Uint16Array(wasm.memory.buffer, model.dam_height_ptr(), n).slice();
    jsFlood(dammed, jsLevel, jsParent);
    let diff = 0;
    for (let i = 0, level = wasmLevel(); i < n; i++) if (level[i] !== jsLevel[i]) diff++;
    const region = model.region_cells();
    console.log(`  recomputed ${region} cells (${((100 * region) / n).toFixed(1)}% of grid), ` +
      `${model.lake_count()} lakes, levels differing from full JS flood: ${diff}`);
  }
})();
