// Map glue. The height grid, flood, overlay colouring and lake search live in the Rust/WASM module
// (flood-wasm/, built into pkg/); the panel, dam list, map controls and draw mode are the
// SwissFloodUI module (ui/). This file sets up the LV95 map and connects the two.
import init, { FloodModel } from "./pkg/flood_wasm.js";

// Replaced with the commit and its date by the GitHub Pages workflow; shown in the layer menu.
const VERSION = "dev";

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

// Zoom and attribution controls are drawn by the UI.
const map = L.map("map", {
  crs, center: [46.8, 8.2], zoom: 16, minZoom: 14, maxZoom: 26, zoomControl: false, attributionControl: false,
});
const swisstopo = (layer, format = "jpeg", maxNativeZoom = 27, className = "") =>
  L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/2056/{z}/{x}/{y}.${format}`, {
    maxZoom: map.getMaxZoom(), // Leaflet's default (18) would hide tiles below 50 m/px
    maxNativeZoom,
    className,
  });
const baseLayers = {
  grey: { name: "Swiss map (grey)", layer: swisstopo("ch.swisstopo.pixelkarte-grau") },
  color: { name: "Swiss map (colour)", layer: swisstopo("ch.swisstopo.pixelkarte-farbe", "jpeg", 27, "tiles-color") },
  // swissTLM map: no labels, calmer than the national map (Switzerland only).
  light: { name: "Swiss map (light)", layer: swisstopo("ch.swisstopo.swisstlm3d-karte-farbe", "png") },
  photo: { name: "Aerial imagery", layer: swisstopo("ch.swisstopo.swissimage") },
  // swissALTI3D (2 m, Switzerland only) over swissALTIRegio, which also covers the surroundings.
  relief: {
    name: "Relief",
    layer: L.layerGroup([
      swisstopo("ch.swisstopo.swissaltiregio-reliefschattierung_multidirektional", "png", 26),
      swisstopo("ch.swisstopo.swissalti3d-reliefschattierung", "png", 26),
    ]),
  },
};
let activeLayer = "light";
baseLayers[activeLayer].layer.addTo(map);

// Shows the off-screen overlay canvas (one pixel per grid cell) as map tiles, so it zooms and
// pans like the base map. One huge image would be too large for the browser to animate.
const FloodTiles = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize().multiplyBy(window.devicePixelRatio || 1).round();
    tile.width = size.x;
    tile.height = size.y;
    this.drawTile(tile, coords);
    return tile;
  },

  drawTile(tile, coords) {
    const tctx = tile.getContext("2d");
    tctx.clearRect(0, 0, tile.width, tile.height);
    // Tile corners in LV95 metres, then in grid cells (fractional).
    const scale = crs.scale(coords.z);
    const tileSize = this.getTileSize();
    const nw = crs.transformation.untransform(coords.scaleBy(tileSize), scale);
    const se = crs.transformation.untransform(coords.add([1, 1]).scaleBy(tileSize), scale);
    const c0 = (nw.x - dem.west) / dem.cellsize, c1 = (se.x - dem.west) / dem.cellsize;
    const r0 = (dem.north - nw.y) / dem.cellsize, r1 = (dem.north - se.y) / dem.cellsize;
    // Clip the source rectangle to the grid and shrink the destination to match.
    const sc0 = Math.max(c0, 0), sc1 = Math.min(c1, dem.cols);
    const sr0 = Math.max(r0, 0), sr1 = Math.min(r1, dem.rows);
    if (sc1 <= sc0 || sr1 <= sr0) return;
    const kx = tile.width / (c1 - c0), ky = tile.height / (r1 - r0);
    tctx.imageSmoothingEnabled = false; // keep cells as crisp squares
    tctx.drawImage(canvas, sc0, sr0, sc1 - sc0, sr1 - sr0,
      (sc0 - c0) * kx, (sr0 - r0) * ky, (sc1 - sc0) * kx, (sr1 - sr0) * ky);
  },

  // Redraw the loaded tiles in place after the overlay changed (no flicker, unlike redraw()).
  refresh() {
    for (const { el, coords } of Object.values(this._tiles)) this.drawTile(el, coords);
  },
});

const DAM_COLOR = "#C2410C"; // matches the UI's --sf-dam and the dam cells in the overlay
const OVERFLOW_COLOR = "#d0f"; // magenta: not used by roads or water on the swisstopo maps
const MIN_LAKE_AREA = 40000; // m², ignore tiny slivers so they don't clutter the map

// ---------------------------------------------------------------------------------------------
// Coordinates

function lv95ToLatLng([x, y]) {
  return crs.unproject(L.point(x, y));
}

function latLngToLv95(latlng) {
  const p = crs.project(latlng);
  return [p.x, p.y];
}

// "E 2 683 600  N 1 257 800"
function formatLv95(latlng) {
  const group = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const [x, y] = latLngToLv95(latlng);
  return `E ${group(x)}  N ${group(y)}`;
}

// Grid cell index under a map position, or -1 outside the grid / Switzerland.
function cellAt(latlng) {
  const [x, y] = latLngToLv95(latlng);
  const c = Math.floor((x - dem.west) / dem.cellsize);
  const r = Math.floor((dem.north - y) / dem.cellsize);
  if (c < 0 || r < 0 || c >= dem.cols || r >= dem.rows) return -1;
  const i = r * dem.cols + c;
  return model.terrain_at(i) === 0 ? -1 : i;
}

function cellCenterLatLng(i) {
  const r = (i / dem.cols) | 0;
  const c = i - r * dem.cols;
  return lv95ToLatLng([dem.west + (c + 0.5) * dem.cellsize, dem.north - (r + 0.5) * dem.cellsize]);
}

// ---------------------------------------------------------------------------------------------
// Height grid

let dem; // { cols, rows, west, north, cellsize } in LV95
let wasm; // WASM exports, for wasm.memory
let model; // FloodModel: terrain, levels, dams, overlay pixels and lakes, all in WASM memory

// Fetches a file, reporting progress as (loaded bytes, total bytes or 0).
async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get("Content-Length")) || 0;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

// Lets the browser paint (e.g. a status message) before a long synchronous step.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Height grid: 50 m on desktops, 100 m (4x fewer cells, ~4x faster and less memory) on phones and
// tablets, told apart by their primary pointer (a finger, no hover). ?grid=50 / ?grid=100 overrides.
const GRIDS = ["50m", "100m"];
function chooseGrid() {
  const forced = new URLSearchParams(location.search).get("grid");
  if (forced && GRIDS.includes(`${forced}m`)) return `${forced}m`;
  return matchMedia("(pointer: coarse) and (hover: none)").matches ? "100m" : "50m";
}

async function loadDem() {
  const dir = `data/${chooseGrid()}`;
  const t0 = performance.now();
  const mb = (n) => (n / 1e6).toFixed(1);
  const [header, compressed] = await Promise.all([
    fetch(`${dir}/dem.json`).then((r) => r.json()),
    fetchWithProgress(`${dir}/dem.bin.zst`, (loaded, total) =>
      ui.setNotice(`Downloading height map… ${mb(loaded)}${total ? ` / ${mb(total)}` : ""} MB`)),
    init().then((exports) => (wasm = exports)),
  ]);
  const t1 = performance.now();
  // LV03 -> LV95 is a pure offset.
  dem = { ...header, west: header.west + 2000000, north: header.north + 1000000 };
  ui.setNotice("Preparing height model…");
  await nextPaint();
  model = new FloodModel(compressed, dem.cols, dem.rows, dem.west, dem.north, dem.cellsize);
  console.log(`Height map: download + WASM init ${(t1 - t0).toFixed(0)} ms, ` +
    `decompress + baseline flood ${(performance.now() - t1).toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------------------------
// Dams

let dams = []; // { id, name, pts: [[x, y], ...] LV95 metres, crest, groundMin, groundMax, lakeLevel, line }
let nextDamId = 1;

const flatten = (pts) => Float64Array.from(pts.flat());

// Length along the dam line in metres (LV95 points are metres).
const damLength = (pts) => pts.slice(1).reduce((sum, [x, y], k) => sum + Math.hypot(x - pts[k][0], y - pts[k][1]), 0);

function addDam(pts, crest, name) {
  const info = model.dam_info(flatten(pts));
  const empty = info.cells === 0;
  const dam = { pts, groundMin: info.terrain_min, groundMax: info.terrain_max };
  info.free();
  if (empty) return null;
  dam.id = nextDamId++;
  dam.name = name || `Dam ${dam.id}`;
  dam.crest = crest ?? dam.groundMax; // new dams reach the highest ground they cover
  dam.line = L.polyline(pts.map(lv95ToLatLng), { color: DAM_COLOR, weight: 5 }).addTo(map);
  dam.line.on("click", (e) => {
    L.DomEvent.stop(e);
    if (!ui.isDrawing) ui.select(dam.id);
  });
  dams.push(dam);
  return dam;
}

function removeDam(id) {
  const dam = dams.find((d) => d.id === id);
  if (!dam) return;
  map.removeLayer(dam.line);
  dams = dams.filter((d) => d !== dam);
  update();
}

// The selected dam gets a yellow halo and white end/vertex dots, so it stands out on every base map.
const selectionLayer = L.layerGroup().addTo(map);

function styleDamLines() {
  selectionLayer.clearLayers();
  const dam = dams.find((d) => d.id === ui.selected);
  if (!dam) return;
  const latlngs = dam.line.getLatLngs();
  L.polyline(latlngs, {
    color: "#FFD60A", weight: 15, opacity: 0.9, lineCap: "round", interactive: false,
  }).addTo(selectionLayer);
  dam.line.bringToFront();
  for (const ll of latlngs) {
    L.circleMarker(ll, {
      radius: 5, color: DAM_COLOR, weight: 3, fillColor: "#fff", fillOpacity: 1, interactive: false,
    }).addTo(selectionLayer);
  }
}

// Dams are stored in the URL hash so a scenario can be shared as a link.
function saveHash() {
  const data = dams.map((d) => ({ c: d.crest, p: d.pts.map(([x, y]) => [Math.round(x), Math.round(y)]) }));
  history.replaceState(null, "", data.length ? "#" + encodeURIComponent(JSON.stringify(data)) : location.pathname + location.search);
}

function clearDams() {
  for (const dam of dams) map.removeLayer(dam.line);
  dams = [];
  ui.select(null);
}

// Dams file: LV95 points and crests. The other fields are informational and ignored on open.
const FILE_FORMAT = "swissflood-dams";

function downloadDams() {
  const data = {
    format: FILE_FORMAT,
    version: 1,
    crs: "EPSG:2056",
    flooded_area_km2: lastResults.areaKm2,
    water_added_km3: lastResults.volumeKm3,
    dams: dams.map((d) => ({
      name: d.name,
      crest: d.crest,
      points: d.pts.map(([x, y]) => [Math.round(x), Math.round(y)]),
      length_m: Math.round(damLength(d.pts)),
      ground_min: d.groundMin,
      ground_max: d.groundMax,
      lake_level: d.lakeLevel,
    })),
  };
  // Indented, but with each [x, y] point on one line.
  const text = JSON.stringify(data, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, "[$1, $2]");
  const url = URL.createObjectURL(new Blob([text + "\n"], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "swissflood-dams.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openDamsFile(file) {
  if (!model) return;
  try {
    loadDams(JSON.parse(await file.text()));
  } catch (e) {
    alert(`Could not open ${file.name}: ${e.message}`);
  }
}

// Example scenarios in examples/, dams files like the downloads. The first one loads on startup
// when the URL has no dams.
const EXAMPLES = [
  { id: "baden", name: "Baden" },
  { id: "villigen", name: "Villigen" },
  { id: "nolla", name: "Nolla" },
  { id: "alpen", name: "Alps" },
];

async function openExample(id) {
  if (!model) return;
  try {
    const r = await fetch(`examples/${id}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDams(await r.json());
  } catch (e) {
    alert(`Could not load example ${id}: ${e.message}`);
  }
}

// Zooms to the dams and the area they flood: the bounding box of all coloured overlay cells.
function fitScenario() {
  if (!dams.length) return;
  const px = new Uint32Array(wasm.memory.buffer, model.rgba_ptr(), dem.cols * dem.rows);
  let c0 = dem.cols, c1 = -1, r0 = dem.rows, r1 = -1;
  for (let r = 0, i = 0; r < dem.rows; r++) {
    for (let c = 0; c < dem.cols; c++, i++) {
      if (px[i] === 0) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      r1 = r;
    }
  }
  const bounds = L.latLngBounds(dams.flatMap((d) => d.line.getLatLngs()));
  if (c1 >= 0) {
    bounds.extend(lv95ToLatLng([dem.west + c0 * dem.cellsize, dem.north - r0 * dem.cellsize]));
    bounds.extend(lv95ToLatLng([dem.west + (c1 + 1) * dem.cellsize, dem.north - (r1 + 1) * dem.cellsize]));
  }
  // Keep clear of the panel on the left (desktop) or the bottom sheet (phone).
  const phone = window.matchMedia("(max-width: 640px)").matches;
  map.fitBounds(bounds, {
    paddingTopLeft: phone ? [24, 72] : [420, 80], paddingBottomRight: phone ? [24, 300] : [40, 40], maxZoom: 21,
  });
}

// Replaces the dams with those of a dams file (parsed JSON); throws if it isn't one.
function loadDams(data) {
  if (data.format !== FILE_FORMAT || data.crs !== "EPSG:2056" || !Array.isArray(data.dams)) {
    throw new Error("not a Swiss Flood dams file");
  }
  if (data.version > 1) throw new Error(`file version ${data.version} is newer than this app`);
  const loaded = data.dams.filter((d) =>
    Array.isArray(d.points) && d.points.length >= 2 &&
    d.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
  clearDams();
  let skipped = data.dams.length - loaded.length;
  for (const d of loaded) {
    const crest = Number.isFinite(d.crest) ? Math.max(1, Math.min(65535, Math.round(d.crest))) : undefined;
    if (!addDam(d.points, crest, typeof d.name === "string" ? d.name : undefined)) skipped++;
  }
  update();
  fitScenario();
  if (skipped) alert(`${skipped} dam${skipped === 1 ? "" : "s"} skipped (invalid or outside the height map).`);
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

let canvas, ctx, floodTiles, overflowLayer;
let lastResults = { areaKm2: null, volumeKm3: null };

function initRender() {
  canvas = document.createElement("canvas");
  canvas.width = dem.cols;
  canvas.height = dem.rows;
  ctx = canvas.getContext("2d");

  const nw = lv95ToLatLng([dem.west, dem.north]);
  const se = lv95ToLatLng([dem.west + dem.cols * dem.cellsize, dem.north - dem.rows * dem.cellsize]);
  // Own pane: above the base map tiles, below the dam lines and overflow paths.
  map.createPane("flood").style.zIndex = 350;
  floodTiles = new FloodTiles({
    pane: "flood", bounds: L.latLngBounds(nw, se), opacity: 0.8, maxZoom: map.getMaxZoom(),
  }).addTo(map);
  overflowLayer = L.layerGroup().addTo(map);
}

function update() {
  model.clear_dams();
  for (const dam of dams) model.add_dam(flatten(dam.pts), dam.crest);
  const t0 = performance.now();
  const result = model.compute();
  const ms = performance.now() - t0;
  const cells = result.flooded_cells, volume = result.volume_cell_metres;
  result.free();

  // View the overlay pixels in WASM memory directly. Created after compute(): if WASM memory
  // grew, older views are detached.
  const n = dem.cols * dem.rows;
  const pixels = new Uint8ClampedArray(wasm.memory.buffer, model.rgba_ptr(), 4 * n);
  ctx.putImageData(new ImageData(pixels, dem.cols, dem.rows), 0, 0);
  floodTiles.refresh();
  const lakes = readLakes().filter((lake) => lake.cells * dem.cellsize ** 2 >= MIN_LAKE_AREA);
  drawOverflows(lakes);

  const cellArea = dem.cellsize * dem.cellsize;
  lastResults = {
    areaKm2: dams.length ? (cells * cellArea) / 1e6 : null,
    volumeKm3: dams.length ? (volume * cellArea) / 1e9 : null,
  };
  ui.setResults({
    ...lastResults,
    meta: dams.length
      ? `${lakes.length} lake${lakes.length === 1 ? "" : "s"} · ${dem.cellsize} m grid · computed in ${ms.toFixed(0)} ms`
      : "",
  });
  ui.setDams(dams.map((dam, k) => {
    // Water held below the crest escapes elsewhere (e.g. around the dam's end); worth a note.
    const lakeLevel = model.dam_lake_level(k);
    dam.lakeLevel = lakeLevel > 0 ? lakeLevel : null;
    const note = lakeLevel > 0 && lakeLevel < dam.crest
      ? `Lake ${lakeLevel} m · water escapes ${dam.crest - lakeLevel} m below the crest`
      : "";
    return {
      id: dam.id, name: dam.name, crest: dam.crest, length: damLength(dam.pts),
      groundMin: dam.groundMin, groundMax: dam.groundMax, note,
    };
  }));
  styleDamLines();
  saveHash();
}

// Coalesces updates to one per frame, e.g. while a crest slider is dragged: only the latest
// value is computed, nothing queues up behind a slow compute.
let updatePending = false;
function scheduleUpdate() {
  if (updatePending) return;
  updatePending = true;
  requestAnimationFrame(() => {
    updatePending = false;
    update();
  });
}

// ---------------------------------------------------------------------------------------------
// Lakes and overflow paths

// Lakes as found by the model: 8-connected flooded cells sharing one level, each with its
// overflow point (spill), pour cell, the dam it overflows (index into dams, or -1) and the
// drainage path from the overflow point to the border.
function readLakes() {
  const lakes = [];
  for (let k = 0; k < model.lake_count(); k++) {
    lakes.push({
      cells: model.lake_cells(k),
      level: model.lake_level(k),
      spill: model.lake_spill(k),
      dam: model.lake_dam(k),
      toBorder: model.lake_drains_to_border(k),
      path: model.lake_path(k),
    });
  }
  return lakes;
}

function overflowText(lake) {
  if (lake.dam !== -1) return `overflows over ${dams[lake.dam].name}`;
  if (lake.toBorder) return "drains across the border";
  return "flows around the dam over terrain";
}

function drawOverflows(lakes) {
  overflowLayer.clearLayers();
  for (const lake of lakes) {
    // White casing under an animated dashed line, so it stands out from roads on the colour map.
    const latlngs = Array.from(lake.path, cellCenterLatLng);
    L.polyline(latlngs, { color: "#fff", weight: 7, opacity: 0.85, interactive: false }).addTo(overflowLayer);
    L.polyline(latlngs, {
      color: OVERFLOW_COLOR, weight: 3, dashArray: "10 6", className: "overflow-flow", interactive: false,
    }).addTo(overflowLayer);
    L.circleMarker(cellCenterLatLng(lake.spill), {
      radius: 7, color: "#fff", weight: 3, fillColor: OVERFLOW_COLOR, fillOpacity: 1,
    })
      .bindTooltip(`Lake at ${lake.level} m ${overflowText(lake)}`)
      .addTo(overflowLayer);
  }
}

// ---------------------------------------------------------------------------------------------
// UI

const ui = SwissFloodUI.mount(map, {
  layers: Object.entries(baseLayers).map(([id, { name }]) => ({ id, name })),
  activeLayer,
  version: VERSION,
  onLayerChange(id) {
    map.removeLayer(baseLayers[activeLayer].layer);
    activeLayer = id;
    baseLayers[id].layer.addTo(map); // tile pane, always below the flood overlay
  },
  onShare() {
    navigator.clipboard?.writeText(location.href);
  },
  examples: EXAMPLES,
  onExample: openExample,
  onDownload: downloadDams,
  onOpenFile: openDamsFile,
  onDrawFinish(latlngs) {
    if (!model) return;
    const dam = addDam(latlngs.map(latLngToLv95));
    if (!dam) return; // entirely outside Switzerland
    update();
    ui.select(dam.id);
  },
  onCrestChange(id, crest, final) {
    const dam = dams.find((d) => d.id === id);
    if (!dam) return;
    dam.crest = Math.max(1, Math.min(65535, Math.round(crest)));
    if (final) update();
    else scheduleUpdate(); // slider drag: follow live, one compute per frame at most
  },
  onDelete: removeDam,
  onZoomTo(id) {
    const dam = dams.find((d) => d.id === id);
    if (dam) map.fitBounds(dam.line.getBounds(), { padding: [80, 80], maxZoom: 21 });
  },
  onSelect: styleDamLines,
  getGround(latlng) {
    if (!model) return null;
    const i = cellAt(latlng);
    return i === -1 ? null : model.terrain_at(i);
  },
  getWater(latlng) {
    if (!model) return null;
    const i = cellAt(latlng);
    if (i === -1) return null;
    const level = model.level_at(i);
    return level > model.base_level_at(i) ? { level, depth: level - model.terrain_at(i) } : null;
  },
  formatCoord: formatLv95,
});

// Load errors are shown in the panel's notice box, which (unlike the meta line) is visible on phones.
function loadErrorText(e) {
  if (typeof WebAssembly !== "object") {
    return "This site needs WebAssembly, which is turned off here (e.g. by iOS Lockdown Mode). " +
      "To allow it for this site in Safari: tap aA in the address bar → Website Settings → turn off Lockdown Mode.";
  }
  // A failed allocation in Rust aborts, which surfaces as a WebAssembly.RuntimeError ("unreachable").
  if (e instanceof RangeError || e instanceof WebAssembly.RuntimeError || /memory/i.test(e.message)) {
    return `This device most likely doesn't have enough memory for the height map (error: ${e.message}).`;
  }
  return `Failed to load the height map: ${e.message}`;
}

(async () => {
  ui.setNotice("Loading height map…");
  // Each loading step updates the notice, so a hang on a slow device shows where it stopped.
  try {
    if (typeof WebAssembly !== "object") throw new Error("WebAssembly is not available");
    await loadDem();
    initRender();
    loadHash();
    update();
    ui.setNotice(null);
    if (!dams.length) await openExample(EXAMPLES[0].id);
  } catch (e) {
    console.error(e);
    ui.setNotice(loadErrorText(e), { error: true });
  }
})();
