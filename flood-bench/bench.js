// Runs flood() from web/flood.js unchanged in Node, for comparison with the Rust port.
//
//     node bench.js [data dir, default ../web/data]
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const dir = process.argv[2] || path.join(__dirname, "../web/data");
const src = fs.readFileSync(path.join(__dirname, "../web/flood.js"), "utf8");

// Extract the flood section (bucket arrays + flood()) and compile it as a closure, so its
// variables stay locals; eval at global scope would make them slow globals.
const start = src.indexOf("const head = new Int32Array");
const end = src.indexOf("// ----", start);
const env = {};
const flood = new Function("env", `"use strict"; let dem, outlets; ${src.slice(start, end)}
  return (h, l, p) => { dem = env.dem; outlets = env.outlets; flood(h, l, p); };`)(env);

const { cols, rows } = JSON.parse(fs.readFileSync(path.join(dir, "dem.json"), "utf8"));
const planes = zlib.zstdDecompressSync(fs.readFileSync(path.join(dir, "dem.bin.zst")));
const n = cols * rows;
const terrain = new Uint16Array(n);
let prev = 0;
for (let i = 0; i < n; i++) {
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

const level = new Uint16Array(n);
const parent = new Int32Array(n);
flood(terrain, level, parent); // warm-up
const times = [];
for (let k = 0; k < 5; k++) {
  const t = performance.now();
  flood(terrain, level, parent);
  times.push(performance.now() - t);
}
console.log(`${cols}x${rows}: JS flood ${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)} ms`);
