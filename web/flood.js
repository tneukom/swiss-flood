// Map glue. The height grid, flood, overlay colouring and lake search live in the Rust/WASM module
// (flood-wasm/, built into pkg/); the panel, dam list, map controls and draw mode are the
// SwissFloodUI module (ui/). This file sets up the LV95 map and connects the two.
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

// Zoom and attribution controls are drawn by the UI.
const map = L.map("map", {
  crs, center: [46.8, 8.2], zoom: 16, minZoom: 14, maxZoom: 26, zoomControl: false, attributionControl: false,
});
const swisstopo = (layer, format = "jpeg", maxNativeZoom = 27) =>
  L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/2056/{z}/{x}/{y}.${format}`, {
    maxZoom: map.getMaxZoom(), // Leaflet's default (18) would hide tiles below 50 m/px
    maxNativeZoom,
  });
const baseLayers = {
  grey: { name: "Swiss map (grey)", layer: swisstopo("ch.swisstopo.pixelkarte-grau") },
  color: { name: "Swiss map (colour)", layer: swisstopo("ch.swisstopo.pixelkarte-farbe") },
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
let activeLayer = "grey";
baseLayers[activeLayer].layer.addTo(map);

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

let dams = []; // { id, name, pts: [[x, y], ...] LV95 metres, crest, groundMin, groundMax, line }
let nextDamId = 1;

const flatten = (pts) => Float64Array.from(pts.flat());

function addDam(pts, crest) {
  const info = model.dam_info(flatten(pts));
  const empty = info.cells === 0;
  const dam = { pts, groundMin: info.terrain_min, groundMax: info.terrain_max };
  info.free();
  if (empty) return null;
  dam.id = nextDamId++;
  dam.name = `Dam ${dam.id}`;
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

function styleDamLines() {
  for (const dam of dams) dam.line.setStyle({ weight: dam.id === ui.selected ? 7 : 5 });
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
  ui.setResults({
    areaKm2: dams.length ? (cells * cellArea) / 1e6 : null,
    volumeKm3: dams.length ? (volume * cellArea) / 1e9 : null,
    meta: dams.length
      ? `${lakes.length} lake${lakes.length === 1 ? "" : "s"} · computed in ${ms.toFixed(0)} ms`
      : "",
  });
  ui.setDams(dams.map((dam, k) => {
    // Water held below the crest escapes elsewhere (e.g. around the dam's end); worth a note.
    const lakeLevel = model.dam_lake_level(k);
    const note = lakeLevel > 0 && lakeLevel < dam.crest
      ? `Lake ${lakeLevel} m · water escapes ${dam.crest - lakeLevel} m below the crest`
      : "";
    return { id: dam.id, name: dam.name, crest: dam.crest, groundMin: dam.groundMin, groundMax: dam.groundMax, note };
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
  onLayerChange(id) {
    map.removeLayer(baseLayers[activeLayer].layer);
    activeLayer = id;
    baseLayers[id].layer.addTo(map); // tile pane, always below the flood overlay
  },
  onShare() {
    navigator.clipboard?.writeText(location.href);
  },
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

(async () => {
  ui.setResults({ meta: "Loading height map…" });
  try {
    await loadDem();
    initRender();
    loadHash();
    update();
  } catch (e) {
    console.error(e);
    ui.setResults({ meta: "Failed to load height map: " + e.message });
  }
})();
