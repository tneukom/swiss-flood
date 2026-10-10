// Reference copy of the JS flood from web/flood.js before it moved to Rust/WASM (flood-wasm/),
// kept for benchmarks and result comparisons in bench.js. Expects globals `dem` ({ cols, rows })
// and `outlets` (Int32Array).
"use strict";

// Priority-flood (Barnes et al.) with a bucket queue: heights are integer metres, so each
// bucket is a FIFO array of cells and the whole fill is a single linear pass. FIFO makes the
// fill spread evenly across flat areas, so drainage paths across them are short and straight.
// Buckets are growable Int32Arrays kept between runs: reading them is sequential, which is ~1.5×
// faster than linked lists through a per-cell next[] (see flood-bench/).
// parent (optional) receives the neighbour each cell was reached from, -1 for outlets. Following
// parents always leads downhill (non-increasing level) to an outlet, i.e. where the water drains.

const buckets = new Array(65536).fill(null);
const bucketSize = new Int32Array(65536);

function pushBucket(v, i) {
  let bucket = buckets[v];
  const size = bucketSize[v];
  if (bucket === null || size === bucket.length) {
    const grown = new Int32Array(bucket === null ? 1024 : 2 * bucket.length);
    if (bucket !== null) grown.set(bucket);
    bucket = buckets[v] = grown;
  }
  bucket[size] = i;
  bucketSize[v] = size + 1;
}

function flood(height, level, parent) {
  const { cols, rows } = dem;
  level.fill(0); // 0 = not yet visited
  bucketSize.fill(0);
  for (const i of outlets) {
    level[i] = height[i];
    if (parent) parent[i] = -1;
    pushBucket(height[i], i);
  }
  for (let b = 1; b < 65536; b++) {
    // Cells at the current level are appended to bucket b while it's read (which may replace it
    // with a grown copy), so re-read buckets[b] and bucketSize[b] each iteration.
    for (let k = 0; k < bucketSize[b]; k++) {
      const i = buckets[b][k];
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (level[j] !== 0 || height[j] === 0) continue;
          const v = height[j] > b ? height[j] : b;
          level[j] = v;
          if (parent) parent[j] = i;
          pushBucket(v, j);
        }
      }
    }
  }
}
