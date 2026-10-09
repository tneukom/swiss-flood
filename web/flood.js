"use strict";

// LV95 (EPSG:2056) map with swisstopo tiles, so the LV03/LV95 height grid is axis-aligned.
const crs = new L.Proj.CRS(
  "EPSG:2056",
  "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 " +
    "+ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs",
  {
    resolutions: [4000, 3750, 3500, 3250, 3000, 2750, 2500, 2250, 2000, 1750, 1500, 1250, 1000, 750, 650,
      500, 250, 100, 50, 20, 10, 5, 2.5, 2, 1.5, 1, 0.5, 0.25, 0.1],
    origin: [2420000, 1350000],
  },
);

const map = L.map("map", { crs, center: [46.8, 8.2], zoom: 16, minZoom: 14, maxZoom: 26 });
const swisstopo = (layer) =>
  L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/2056/{z}/{x}/{y}.jpeg`, {
    attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
    maxNativeZoom: 27,
  });
const baseLayers = {
  "Map (grey)": swisstopo("ch.swisstopo.pixelkarte-grau"),
  "Map (colour)": swisstopo("ch.swisstopo.pixelkarte-farbe"),
  "Aerial (SWISSIMAGE)": swisstopo("ch.swisstopo.swissimage"),
};
baseLayers["Map (grey)"].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);

// ImageOverlay that displays a canvas instead of an <img>, so it can be redrawn without encoding.
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const img = (this._image = this.options.canvas);
    L.DomUtil.addClass(img, "leaflet-image-layer");
    if (this._zoomAnimated) L.DomUtil.addClass(img, "leaflet-zoom-animated");
    if (this.options.className) L.DomUtil.addClass(img, this.options.className);
    img.onselectstart = L.Util.falseFn;
    img.onmousemove = L.Util.falseFn;
  },
});

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Height grid

let dem; // { cols, rows, west, north, cellsize } in LV95
let terrain; // Uint16Array, metres, 0 = outside Switzerland
let outlets; // Int32Array of valid cells adjacent to NODATA or the grid border
let baseLevel; // water level without dams (natural depressions filled)

async function loadDem() {
  const header = await (await fetch("data/dem.json")).json();
  const compressed = new Uint8Array(await (await fetch("data/dem.bin.zst")).arrayBuffer());
  const planes = fzstd.decompress(compressed);
  const n = header.cols * header.rows;
  terrain = new Uint16Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev = (prev + (planes[i] | (planes[n + i] << 8))) & 0xffff;
    terrain[i] = prev;
  }
  // LV03 -> LV95 is a pure offset.
  dem = { ...header, west: header.west + 2000000, north: header.north + 1000000 };
  outlets = findOutlets();
}

function findOutlets() {
  const { cols, rows } = dem;
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (terrain[i] === 0) continue;
      let edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
      for (let dr = -1; dr <= 1 && !edge; dr++) {
        for (let dc = -1; dc <= 1 && !edge; dc++) {
          if (terrain[i + dr * cols + dc] === 0) edge = true;
        }
      }
      if (edge) list.push(i);
    }
  }
  return Int32Array.from(list);
}

// ---------------------------------------------------------------------------------------------
// Priority-flood (Barnes et al.) with a bucket queue: heights are integer metres, so each
// bucket is a linked list of cells and the whole fill is a single linear pass.

const head = new Int32Array(65536);
let next;

function flood(height, level) {
  const { cols, rows } = dem;
  if (!next || next.length !== height.length) next = new Int32Array(height.length);
  level.fill(0); // 0 = not yet visited
  head.fill(-1);
  for (const i of outlets) {
    const h = height[i];
    level[i] = h;
    next[i] = head[h];
    head[h] = i;
  }
  for (let b = 1; b < 65536; b++) {
    while (head[b] !== -1) {
      const i = head[b];
      head[b] = next[i];
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
          next[j] = head[v];
          head[v] = j;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Dams

let dams = []; // { pts: [[x, y], ...] LV95 metres, crest: metres a.s.l., line: L.Polyline }

function toCell(x, y) {
  return [Math.floor((x - dem.west) / dem.cellsize), Math.floor((dem.north - y) / dem.cellsize)];
}

// 4-connected line (Zingl): 4-connected barriers are watertight against the 8-connected flood.
function rasterLine(c0, r0, c1, r1, visit) {
  const dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
  const dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    visit(c0, r0);
    if (c0 === c1 && r0 === r1) break;
    const e2 = 2 * err;
    if (e2 - dy > dx - e2) { err += dy; c0 += sx; } else { err += dx; r0 += sy; }
  }
}

function damCells(pts) {
  const cells = new Set();
  for (let k = 0; k + 1 < pts.length; k++) {
    const [c0, r0] = toCell(...pts[k]);
    const [c1, r1] = toCell(...pts[k + 1]);
    rasterLine(c0, r0, c1, r1, (c, r) => {
      if (c >= 0 && r >= 0 && c < dem.cols && r < dem.rows) cells.add(r * dem.cols + c);
    });
  }
  if (pts.length === 1) {
    const [c, r] = toCell(...pts[0]);
    cells.add(r * dem.cols + c);
  }
  return [...cells].filter((i) => terrain[i] !== 0);
}

function terrainRange(cells) {
  let min = Infinity, max = -Infinity;
  for (const i of cells) {
    min = Math.min(min, terrain[i]);
    max = Math.max(max, terrain[i]);
  }
  return { min, max };
}

function addDam(pts, crest) {
  const cells = damCells(pts);
  if (cells.length === 0) return;
  const range = terrainRange(cells);
  if (crest === undefined) crest = Math.min(range.max, range.min + 100);
  const dam = { pts, crest, cells, range };
  dam.line = L.polyline(pts.map(lv95ToLatLng), { color: "#c00", weight: 3 }).addTo(map);
  dams.push(dam);
}

function removeDam(dam) {
  map.removeLayer(dam.line);
  dams = dams.filter((d) => d !== dam);
  update();
}

function renderDamList() {
  const box = $("dams");
  box.innerHTML = "";
  dams.forEach((dam, k) => {
    const el = document.createElement("div");
    el.className = "dam";
    el.innerHTML = `
      <div class="row">
        <b>Dam ${k + 1}</b>
        <label>crest <input type="number" step="1" value="${dam.crest}"> m</label>
        <button title="Delete">✕</button>
      </div>
      <div class="info">terrain along dam ${dam.range.min}–${dam.range.max} m,
        max height ${Math.max(0, dam.crest - dam.range.min)} m</div>`;
    const input = el.querySelector("input");
    input.addEventListener("change", () => {
      const v = Math.round(Number(input.value));
      if (Number.isFinite(v) && v > 0 && v < 65536) dam.crest = v;
      update();
    });
    el.querySelector("button").addEventListener("click", () => removeDam(dam));
    box.appendChild(el);
  });
}

// Dams are stored in the URL hash so a scenario can be shared as a link.
function saveHash() {
  const data = dams.map((d) => ({ c: d.crest, p: d.pts.map(([x, y]) => [Math.round(x), Math.round(y)]) }));
  history.replaceState(null, "", data.length ? "#" + encodeURIComponent(JSON.stringify(data)) : location.pathname);
}

function loadHash() {
  if (location.hash.length < 2) return;
  try {
    for (const d of JSON.parse(decodeURIComponent(location.hash.slice(1)))) addDam(d.p, d.c);
  } catch (e) {
    console.warn("Ignoring invalid URL hash", e);
  }
}

// ---------------------------------------------------------------------------------------------
// Flood computation and rendering

let damHeight, level, isDam, canvas, ctx, image, pixels;

function initRender() {
  const n = terrain.length;
  damHeight = new Uint16Array(n);
  level = new Uint16Array(n);
  baseLevel = new Uint16Array(n);
  isDam = new Uint8Array(n);
  flood(terrain, baseLevel);

  canvas = document.createElement("canvas");
  canvas.width = dem.cols;
  canvas.height = dem.rows;
  ctx = canvas.getContext("2d");
  image = ctx.createImageData(dem.cols, dem.rows);
  pixels = new Uint32Array(image.data.buffer);

  const nw = lv95ToLatLng([dem.west, dem.north]);
  const se = lv95ToLatLng([dem.west + dem.cols * dem.cellsize, dem.north - dem.rows * dem.cellsize]);
  new CanvasOverlay(null, L.latLngBounds(nw, se), { canvas, className: "flood-layer", opacity: 0.8 }).addTo(map);
}

// Depth colour ramp: light cyan (shallow) to dark blue (>= 200 m), as ABGR little-endian uint32.
const RAMP = (() => {
  const ramp = new Uint32Array(256);
  const a = [170, 230, 255], b = [8, 40, 140];
  for (let k = 0; k < 256; k++) {
    const t = Math.sqrt(k / 255);
    const [r, g, bl] = a.map((v, j) => Math.round(v + (b[j] - v) * t));
    ramp[k] = (255 << 24) | (bl << 16) | (g << 8) | r;
  }
  return ramp;
})();
const DAM_COLOR = (255 << 24) | (0 << 16) | (0 << 8) | 220;

let stats = {};

function update() {
  const t0 = performance.now();
  damHeight.set(terrain);
  isDam.fill(0);
  for (const dam of dams) {
    for (const i of dam.cells) {
      if (dam.crest > damHeight[i]) damHeight[i] = dam.crest;
      isDam[i] = 1;
    }
  }
  flood(damHeight, level);
  const t1 = performance.now();

  let cells = 0, volume = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (isDam[i]) {
      pixels[i] = DAM_COLOR;
    } else if (level[i] > baseLevel[i]) {
      const depth = level[i] - terrain[i];
      pixels[i] = RAMP[Math.min(255, Math.round((depth * 255) / 200))];
      cells++;
      volume += level[i] - baseLevel[i];
    } else {
      pixels[i] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);

  const cellArea = dem.cellsize * dem.cellsize;
  stats = { area: (cells * cellArea) / 1e6, volume: (volume * cellArea) / 1e9, ms: t1 - t0 };
  $("stats").textContent = dams.length
    ? `Flooded ${stats.area.toFixed(1)} km², additional water ${stats.volume.toFixed(2)} km³ ` +
      `(flood ${stats.ms.toFixed(0)} ms)`
    : "";
  renderDamList();
  saveHash();
}

// ---------------------------------------------------------------------------------------------
// Map interaction

function lv95ToLatLng([x, y]) {
  return crs.unproject(L.point(x, y));
}

function latLngToLv95(latlng) {
  const p = crs.project(latlng);
  return [p.x, p.y];
}

let drawing = null; // { pts, line }

function startDrawing() {
  if (drawing) return;
  drawing = { pts: [], line: L.polyline([], { color: "#c00", weight: 2, dashArray: "4 4" }).addTo(map) };
  map.doubleClickZoom.disable();
  $("map").classList.add("drawing");
  $("draw").disabled = true;
}

function stopDrawing(commit) {
  if (!drawing) return;
  map.removeLayer(drawing.line);
  if (commit && drawing.pts.length >= 2) {
    addDam(drawing.pts);
  }
  drawing = null;
  map.doubleClickZoom.enable();
  $("map").classList.remove("drawing");
  $("draw").disabled = false;
  if (commit) update();
}

map.on("click", (e) => {
  if (!drawing) return;
  drawing.pts.push(latLngToLv95(e.latlng));
  drawing.line.setLatLngs(drawing.pts.map(lv95ToLatLng));
});

map.on("dblclick", () => {
  if (!drawing) return;
  // The double-click also fired two clicks at (nearly) the same spot; drop the duplicate.
  const p = drawing.pts;
  if (p.length >= 2) {
    const [a, b] = [p[p.length - 1], p[p.length - 2]];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < dem.cellsize) p.pop();
  }
  stopDrawing(true);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopDrawing(false);
  if (e.key === "Enter") stopDrawing(true);
});

map.on("mousemove", (e) => {
  if (!dem) return;
  const [x, y] = latLngToLv95(e.latlng);
  if (drawing && drawing.pts.length) {
    drawing.line.setLatLngs([...drawing.pts, [x, y]].map(lv95ToLatLng));
  }
  const [c, r] = toCell(x, y);
  if (c < 0 || r < 0 || c >= dem.cols || r >= dem.rows || terrain[r * dem.cols + c] === 0) {
    $("cursor").textContent = "";
    return;
  }
  const i = r * dem.cols + c;
  let text = `E ${Math.round(x)} N ${Math.round(y)} · terrain ${terrain[i]} m`;
  if (level[i] > baseLevel[i]) text += ` · water ${level[i]} m (depth ${level[i] - terrain[i]} m)`;
  $("cursor").textContent = text;
});

$("draw").addEventListener("click", startDrawing);

(async () => {
  try {
    await loadDem();
    initRender();
    loadHash();
    update();
    $("status").textContent = "";
    $("draw").disabled = false;
  } catch (e) {
    console.error(e);
    $("status").textContent = "Failed to load height map: " + e.message;
  }
})();
