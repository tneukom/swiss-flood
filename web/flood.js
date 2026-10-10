// Map UI. The height grid, flood, overlay colouring and lake search live in the Rust/WASM module
// (flood-wasm/, built into pkg/); this file handles Leaflet, dam drawing and the panel.
import init, { FloodModel } from "./pkg/flood_wasm.js";

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
const swisstopo = (layer, format = "jpeg", maxNativeZoom = 27) =>
  L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/2056/{z}/{x}/{y}.${format}`, {
    attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
    maxZoom: map.getMaxZoom(), // Leaflet's default (18) would hide tiles below 50 m/px
    maxNativeZoom,
  });
const baseLayers = {
  "Map (grey)": swisstopo("ch.swisstopo.pixelkarte-grau"),
  "Map (colour)": swisstopo("ch.swisstopo.pixelkarte-farbe"),
  "Aerial (SWISSIMAGE)": swisstopo("ch.swisstopo.swissimage"),
  // swissALTI3D (2 m, Switzerland only) over swissALTIRegio, which also covers the surroundings.
  "Relief (swissALTI3D)": L.layerGroup([
    swisstopo("ch.swisstopo.swissaltiregio-reliefschattierung_multidirektional", "png", 26),
    swisstopo("ch.swisstopo.swissalti3d-reliefschattierung", "png", 26),
  ]),
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
let wasm; // WASM exports, for wasm.memory
let model; // FloodModel: terrain, levels, dams, overlay pixels and lakes, all in WASM memory

async function loadDem() {
  const [header, compressed] = await Promise.all([
    fetch("data/dem.json").then((r) => r.json()),
    fetch("data/dem.bin.zst").then((r) => r.arrayBuffer()),
    init().then((exports) => (wasm = exports)),
  ]);
  // LV03 -> LV95 is a pure offset.
  dem = { ...header, west: header.west + 2000000, north: header.north + 1000000 };
  model = new FloodModel(new Uint8Array(compressed), dem.cols, dem.rows, dem.west, dem.north, dem.cellsize);
}

// ---------------------------------------------------------------------------------------------
// Dams

let dams = []; // { pts: [[x, y], ...] LV95 metres, crest: metres a.s.l., line: L.Polyline }

function toCell(x, y) {
  return [Math.floor((x - dem.west) / dem.cellsize), Math.floor((dem.north - y) / dem.cellsize)];
}

const flatten = (pts) => Float64Array.from(pts.flat());

function addDam(pts, crest) {
  const info = model.dam_info(flatten(pts));
  const range = { min: info.terrain_min, max: info.terrain_max };
  const empty = info.cells === 0;
  info.free();
  if (empty) return;
  if (crest === undefined) crest = range.max; // new dams reach the highest ground they cover
  const dam = { pts, crest, range };
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

let canvas, ctx, overflowLayer;

function initRender() {
  canvas = document.createElement("canvas");
  canvas.width = dem.cols;
  canvas.height = dem.rows;
  ctx = canvas.getContext("2d");

  const nw = lv95ToLatLng([dem.west, dem.north]);
  const se = lv95ToLatLng([dem.west + dem.cols * dem.cellsize, dem.north - dem.rows * dem.cellsize]);
  new CanvasOverlay(null, L.latLngBounds(nw, se), { canvas, className: "flood-layer", opacity: 0.8 }).addTo(map);
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
  const lakes = readLakes().filter((lake) => lake.cells * dem.cellsize ** 2 >= MIN_LAKE_AREA);
  drawOverflows(lakes);

  const cellArea = dem.cellsize * dem.cellsize;
  $("stats").textContent = dams.length
    ? `Flooded ${((cells * cellArea) / 1e6).toFixed(1)} km², ` +
      `additional water ${((volume * cellArea) / 1e9).toFixed(2)} km³ ` +
      `(compute ${ms.toFixed(0)} ms, ${(model.region_cells() / 1e6).toFixed(1)}M cells upstream of dams)`
    : "";
  renderLakeList(lakes);
  renderDamList();
  saveHash();
}

// ---------------------------------------------------------------------------------------------
// Lakes and overflow paths

const MIN_LAKE_AREA = 40000; // m², ignore tiny slivers so they don't clutter the map
const OVERFLOW_COLOR = "#d0f"; // magenta: not used by roads or water on the swisstopo maps

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
      pour: model.lake_pour(k),
      dam: model.lake_dam(k),
      toBorder: model.lake_drains_to_border(k),
      path: model.lake_path(k),
    });
  }
  return lakes;
}

function cellCenterLatLng(i) {
  const r = (i / dem.cols) | 0;
  const c = i - r * dem.cols;
  return lv95ToLatLng([dem.west + (c + 0.5) * dem.cellsize, dem.north - (r + 0.5) * dem.cellsize]);
}

function overflowText(lake) {
  if (lake.dam !== -1) return `overflows over dam ${lake.dam + 1}`;
  if (lake.toBorder) return "drains across the border";
  return `overflows over terrain at E ${lv95Of(lake.pour).join(" N ")} (not over a dam)`;
}

function lv95Of(i) {
  const r = (i / dem.cols) | 0;
  const c = i - r * dem.cols;
  return [Math.round(dem.west + (c + 0.5) * dem.cellsize), Math.round(dem.north - (r + 0.5) * dem.cellsize)];
}

function drawOverflows(lakes) {
  overflowLayer.clearLayers();
  lakes.forEach((lake, k) => {
    // White casing under an animated dashed line, so it stands out from roads on the colour map.
    const latlngs = Array.from(lake.path, cellCenterLatLng);
    L.polyline(latlngs, { color: "#fff", weight: 7, opacity: 0.85, interactive: false }).addTo(overflowLayer);
    L.polyline(latlngs, {
      color: OVERFLOW_COLOR, weight: 3, dashArray: "10 6", className: "overflow-flow", interactive: false,
    }).addTo(overflowLayer);
    L.circleMarker(cellCenterLatLng(lake.spill), {
      radius: 7, color: "#fff", weight: 3, fillColor: OVERFLOW_COLOR, fillOpacity: 1,
    })
      .bindTooltip(`Lake ${k + 1} at ${lake.level} m ${overflowText(lake)}`)
      .addTo(overflowLayer);
  });
}

function renderLakeList(lakes) {
  const cellArea = (dem.cellsize * dem.cellsize) / 1e6;
  $("lakes").innerHTML = lakes
    .map((lake, k) => `<div>Lake ${k + 1}: ${lake.level} m, ${(lake.cells * cellArea).toFixed(1)} km², ` +
      `${overflowText(lake)}</div>`)
    .join("");
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
  if (!model) return;
  const [x, y] = latLngToLv95(e.latlng);
  if (drawing && drawing.pts.length) {
    drawing.line.setLatLngs([...drawing.pts, [x, y]].map(lv95ToLatLng));
  }
  const [c, r] = toCell(x, y);
  if (c < 0 || r < 0 || c >= dem.cols || r >= dem.rows || model.terrain_at(r * dem.cols + c) === 0) {
    $("cursor").textContent = "";
    return;
  }
  const i = r * dem.cols + c;
  const terrain = model.terrain_at(i), level = model.level_at(i);
  let text = `E ${Math.round(x)} N ${Math.round(y)} · terrain ${terrain} m`;
  if (level > model.base_level_at(i)) text += ` · water ${level} m (depth ${level - terrain} m)`;
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
