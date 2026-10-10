/*
 * Swiss Flood UI — panel, dam list, map controls and draw mode for a Leaflet map.
 * No build step, no dependencies besides Leaflet (global `L`).
 *
 *   const ui = SwissFloodUI.mount(map, {
 *     layers: [{ id, name }],  activeLayer: id,
 *     onLayerChange(id),
 *     examples: [{ id, name }],         // scenarios for the "Examples" menu (optional)
 *     onExample(id),
 *     onShare(),
 *     onDownload(),                     // save the dams as a file
 *     onOpenFile(file),                 // a File picked via "Open" or dropped on the map
 *     onDrawFinish(latlngs),            // user finished a new dam (array of L.LatLng)
 *     onCrestChange(id, crest, final),  // final=false while dragging the slider, true on release/enter
 *     onDelete(id),
 *     onZoomTo(id),
 *     onSelect(id | null),
 *     getGround(latlng) -> number|null, // terrain height for the crosshair label (optional)
 *     getWater(latlng) -> { level, depth }|null, // water at the cursor, for the readout (optional)
 *     formatCoord(latlng) -> string,    // e.g. LV95 "E 2 683 600  N 1 257 800" (optional)
 *   });
 *   ui.setResults({ areaKm2, volumeKm3, meta })
 *   ui.setNotice(text | null, { error })  // status/error box in the panel, also shown on phones
 *   ui.setDams([{ id, name, crest, height, length, groundMin, groundMax, crestMin, crestMax, note }])
 *                                       // length: metres along the dam line (optional)
 *                                       // note: optional extra line on the card
 *   ui.select(id | null)
 *   ui.setCursor(latlng, ground, water) // readout bottom-left (desktop); water = { level, depth }
 *   ui.startDraw() / ui.cancelDraw()
 */
(function () {
  'use strict';

  const ICON = {
    logo: '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke="#1D5FD1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20c3 0 3-2 6-2s3 2 6 2 3-2 6-2"/><path d="M8 15V5h10v10"/><path d="M8 9h10"/></svg>',
    download: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
    open: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    link: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    plus: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    examples: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#1D5FD1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    layers: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#1D5FD1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
    undo: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
    target: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>',
    crosshair: '<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="#14202B" stroke-width="2"><circle cx="32" cy="32" r="22" fill="rgba(255,255,255,0.35)"/><path d="M32 0v22M32 42v22M0 32h22M42 32h22"/></svg>',
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  function mount(map, opts = {}) {
    const root = map.getContainer().parentElement || document.body;
    root.classList.add('sf');
    const touchUI = window.matchMedia('(max-width: 640px), (pointer: coarse)');

    let dams = [];
    let selected = null;
    let drawing = null; // { points: [], line, rubber, markers: [] }

    // ---------- DOM ----------
    const panel = h(`
      <section class="sf-panel" aria-label="Scenario">
        <span class="sf-handle" aria-hidden="true"></span>
        <header class="sf-header">
          ${ICON.logo}
          <h1>Swiss Flood</h1>
          <button class="sf-icon-btn" data-act="open" aria-label="Open dams file" title="Open dams file">${ICON.open}</button>
          <button class="sf-icon-btn" data-act="download" aria-label="Download dams" title="Download dams">${ICON.download}</button>
          <button class="sf-icon-btn" data-act="share" aria-label="Copy share link" title="Copy share link">${ICON.link}</button>
          <input type="file" accept=".json,application/json" data-ref="file" hidden>
        </header>
        <div class="sf-stats">
          <div class="sf-stat"><div class="sf-stat-label">Flooded area</div><div class="sf-stat-value" data-ref="area">–<small>km²</small></div></div>
          <div class="sf-stat"><div class="sf-stat-label">Water added</div><div class="sf-stat-value" data-ref="volume">–<small>km³</small></div></div>
        </div>
        <div class="sf-notice" data-ref="notice" hidden></div>
        <div class="sf-meta" data-ref="meta"></div>
        <h2 class="sf-section-title" data-ref="title">Dams</h2>
        <div class="sf-dams" data-ref="dams"></div>
        <div class="sf-footer">
          <button class="sf-primary" data-act="draw">${ICON.plus}Draw dam<kbd>D</kbd></button>
        </div>
      </section>`);

    const layers = opts.layers || [];
    let activeLayer = opts.activeLayer || (layers[0] && layers[0].id);
    const topright = h(`
      <div class="sf-topright">
        <div class="sf-layers sf-examples">
          <button class="sf-pill" data-act="examples" aria-haspopup="true" aria-expanded="false">${ICON.examples}Examples</button>
          <div class="sf-layer-menu" role="menu" hidden></div>
        </div>
        <div class="sf-layers sf-maplayers">
          <button class="sf-pill" data-act="layers" aria-haspopup="true" aria-expanded="false">${ICON.layers}Map layers</button>
          <div class="sf-layer-menu" role="menu" hidden></div>
        </div>
      </div>`);
    if (!layers.length) topright.querySelector('.sf-maplayers').remove();
    const examples = opts.examples || [];
    if (!examples.length) topright.querySelector('.sf-examples').remove();

    const zoom = h(`<div class="sf-zoom"><button data-act="zin" aria-label="Zoom in">+</button><span></span><button data-act="zout" aria-label="Zoom out">−</button></div>`);
    const readout = h(`<div class="sf-readout" aria-hidden="true"></div>`);
    const attrib = h(`<div class="sf-attrib">${opts.attribution || '© swisstopo · Leaflet'}</div>`);

    const drawbar = h(`
      <div class="sf-drawbar" hidden>
        <button class="sf-round" data-act="cancel">Cancel</button>
        <div class="sf-drawbar-title"><strong>New dam</strong><span data-ref="count">0 points</span></div>
        <button class="sf-round sf-round-dam" data-act="finish" disabled>Finish</button>
      </div>`);
    const hint = h(`<div class="sf-hint" hidden></div>`);
    const crosshair = h(`<div class="sf-crosshair" hidden>${ICON.crosshair}<div class="sf-crosshair-label"></div></div>`);
    const drawbottom = h(`
      <div class="sf-drawbottom" hidden>
        <button class="sf-undo" data-act="undo" aria-label="Undo last point">${ICON.undo}</button>
        <button class="sf-addpoint" data-act="add">${ICON.target}Add point</button>
      </div>`);

    [panel, topright, zoom, readout, attrib, drawbar, hint, crosshair, drawbottom].forEach((el) => root.appendChild(el));
    [panel, topright, zoom, drawbar, drawbottom].forEach((el) => { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); });

    const ref = (el, name) => el.querySelector(`[data-ref="${name}"]`);
    const damsEl = ref(panel, 'dams');
    const layerMenu = topright.querySelector('.sf-maplayers .sf-layer-menu');
    const exampleMenu = topright.querySelector('.sf-examples .sf-layer-menu');
    const fileInput = ref(panel, 'file');

    // ---------- Rendering ----------
    function renderLayers() {
      if (!layers.length) return;
      layerMenu.innerHTML = layers.map((l) =>
        `<button role="menuitemradio" aria-checked="${l.id === activeLayer}" data-layer="${esc(l.id)}">${esc(l.name)}</button>`).join('');
    }
    if (exampleMenu) {
      exampleMenu.innerHTML = examples.map((x) =>
        `<button role="menuitem" data-example="${esc(x.id)}">${esc(x.name)}</button>`).join('');
    }

    // "206 m tall · 1.4 km long · ground 353–559 m"
    function damSub(d) {
      const height = d.height ?? (d.groundMin != null ? d.crest - d.groundMin : null);
      const length = d.length == null ? null : d.length < 1000 ? `${fmt(d.length)} m long` : `${fmt(d.length / 1000, 1)} km long`;
      return [height != null ? `${fmt(height)} m tall` : null, length,
        d.groundMin != null ? `ground ${fmt(d.groundMin)}–${fmt(d.groundMax)} m` : null].filter(Boolean).join(' · ');
    }

    function damCard(d) {
      const isSel = d.id === selected;
      const min = d.crestMin ?? Math.floor(d.groundMin ?? 0);
      const max = d.crestMax ?? Math.max(min + 100, Math.ceil((d.groundMax ?? d.crest) + 300));
      const sub = damSub(d);
      const field = (cls) => `
        <label class="sf-field ${cls}"><span class="sf-sr">${esc(d.name)} crest elevation</span>
          <input type="number" inputmode="numeric" step="1" value="${Math.round(d.crest)}" data-crest="${esc(d.id)}"><span>m</span></label>`;
      return `
        <div class="sf-dam${isSel ? ' is-selected' : ''}" data-id="${esc(d.id)}">
          <div class="sf-dam-head">
            <button class="sf-dam-select" data-act="select" aria-expanded="${isSel}">
              <span class="sf-dam-name">${esc(d.name)}</span>
              <span class="sf-dam-crest-text">${fmt(d.crest)} m</span>
              <span class="sf-dam-sub">${sub}</span>
              ${d.note ? `<span class="sf-dam-note">${esc(d.note)}</span>` : ''}
            </button>
            ${field('')}
            <button class="sf-dam-close" data-act="deselect" aria-label="Close">${ICON.close}</button>
          </div>
          ${isSel ? `
          <div class="sf-dam-detail">
            ${field('sf-field-big')}
            <div>
              <label class="sf-sr" for="sf-range-${esc(d.id)}">${esc(d.name)} crest elevation</label>
              <input class="sf-range" id="sf-range-${esc(d.id)}" type="range" min="${min}" max="${max}" step="1" value="${Math.round(d.crest)}" data-range="${esc(d.id)}">
              <div class="sf-range-ends"><span>${fmt(min)} m</span><span>${fmt(max)} m</span></div>
            </div>
            <div class="sf-dam-actions">
              <button class="sf-btn" data-act="zoomto">Zoom to dam</button>
              <span class="sf-spacer"></span>
              <button class="sf-btn sf-btn-danger" data-act="delete" aria-label="Delete ${esc(d.name)}">${ICON.trash}<span class="sf-delete-label">Delete</span></button>
            </div>
          </div>` : ''}
        </div>`;
    }

    function renderDams() {
      ref(panel, 'title').textContent = `Dams · ${dams.length}`;
      damsEl.innerHTML = dams.length ? dams.map(damCard).join('')
        : '<div class="sf-empty">No dams yet. Draw one across a valley to flood it.</div>';
      panel.classList.toggle('has-selection', selected != null);
    }

    // Update one dam's numbers without re-rendering (keeps slider drag alive)
    function syncCrest(id, crest, except) {
      const card = damsEl.querySelector(`.sf-dam[data-id="${CSS.escape(String(id))}"]`);
      if (!card) return;
      card.querySelectorAll('[data-crest], [data-range]').forEach((inp) => { if (inp !== except) inp.value = Math.round(crest); });
      const t = card.querySelector('.sf-dam-crest-text'); if (t) t.textContent = `${fmt(crest)} m`;
      const d = dams.find((x) => String(x.id) === String(id));
      if (d && d.groundMin != null) {
        d.crest = crest; d.height = crest - d.groundMin;
        card.querySelector('.sf-dam-sub').textContent = damSub(d);
      }
    }

    // ---------- Events ----------
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act], [data-layer], [data-example]');
      if (!btn || !root.contains(btn)) return;
      const card = btn.closest('.sf-dam');
      const id = card && dams.find((d) => String(d.id) === card.dataset.id)?.id;
      if (btn.dataset.layer) {
        activeLayer = btn.dataset.layer; renderLayers(); toggleLayerMenu(false);
        opts.onLayerChange && opts.onLayerChange(activeLayer); return;
      }
      if (btn.dataset.example) {
        toggleExampleMenu(false);
        if (drawing) api.cancelDraw();
        const x = examples.find((x) => String(x.id) === btn.dataset.example);
        opts.onExample && x && opts.onExample(x.id); return;
      }
      switch (btn.dataset.act) {
        case 'share': opts.onShare && opts.onShare(); break;
        case 'download': opts.onDownload && opts.onDownload(); break;
        case 'open': fileInput.click(); break;
        case 'draw': api.startDraw(); break;
        case 'select': api.select(selected === id && !touchUI.matches ? null : id); break;
        case 'deselect': api.select(null); break;
        case 'zoomto': opts.onZoomTo && opts.onZoomTo(id); break;
        case 'delete': opts.onDelete && opts.onDelete(id); break;
        case 'layers': toggleExampleMenu(false); toggleLayerMenu(); break;
        case 'examples': toggleLayerMenu(false); toggleExampleMenu(); break;
        case 'zin': map.zoomIn(); break;
        case 'zout': map.zoomOut(); break;
        case 'cancel': api.cancelDraw(); break;
        case 'finish': finishDraw(); break;
        case 'undo': undoPoint(); break;
        case 'add': addPoint(map.getCenter()); break;
      }
    });

    function toggleMenu(menu, act, force) {
      if (!menu) return;
      const open = force ?? menu.hidden;
      menu.hidden = !open;
      topright.querySelector(`[data-act="${act}"]`).setAttribute('aria-expanded', String(open));
    }
    const toggleLayerMenu = (force) => toggleMenu(layers.length && layerMenu, 'layers', force);
    const toggleExampleMenu = (force) => toggleMenu(examples.length && exampleMenu, 'examples', force);
    document.addEventListener('click', (e) => {
      if (!topright.contains(e.target)) { toggleLayerMenu(false); toggleExampleMenu(false); }
    });

    const crestFrom = (inp) => { const v = parseFloat(inp.value); return isNaN(v) ? null : v; };
    damsEl.addEventListener('input', (e) => {
      const inp = e.target; const idStr = inp.dataset.range || inp.dataset.crest; if (!idStr) return;
      const v = crestFrom(inp); if (v == null) return;
      const id = dams.find((d) => String(d.id) === idStr)?.id;
      syncCrest(id, v, inp);
      if (inp.dataset.range) opts.onCrestChange && opts.onCrestChange(id, v, false);
    });
    damsEl.addEventListener('change', (e) => {
      const inp = e.target; const idStr = inp.dataset.range || inp.dataset.crest; if (!idStr) return;
      const v = crestFrom(inp); if (v == null) return;
      const id = dams.find((d) => String(d.id) === idStr)?.id;
      opts.onCrestChange && opts.onCrestChange(id, v, true);
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = ''; // so picking the same file again fires 'change'
      if (file && opts.onOpenFile) opts.onOpenFile(file);
    });

    // Dropping a file anywhere on the map opens it too.
    root.addEventListener('dragover', (e) => {
      if (opts.onOpenFile && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    root.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (!file || !opts.onOpenFile) return;
      e.preventDefault();
      if (drawing) api.cancelDraw();
      opts.onOpenFile(file);
    });

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (drawing) {
        if (e.key === 'Escape') { e.preventDefault(); api.cancelDraw(); }
        else if (e.key === 'Enter') { e.preventDefault(); finishDraw(); }
        else if ((e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) && !typing) { e.preventDefault(); undoPoint(); }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); api.startDraw(); }
      else if (e.key === 'Escape' && selected != null) api.select(null);
      // The Mac "delete" key reports Backspace.
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null) { e.preventDefault(); opts.onDelete && opts.onDelete(selected); }
    });

    map.on('mousemove', (e) => {
      // In touch mode points come from the crosshair, so the rubber band follows it, not the mouse.
      if (drawing && drawing.points.length && !touchUI.matches) {
        drawing.rubber.setLatLngs([drawing.points[drawing.points.length - 1], e.latlng]);
      }
      if (!opts.formatCoord && !opts.getGround) return;
      api.setCursor(e.latlng, opts.getGround ? opts.getGround(e.latlng) : null,
        opts.getWater ? opts.getWater(e.latlng) : null);
    });
    map.on('mouseout', () => { readout.innerHTML = ''; });

    // ---------- Draw mode ----------
    function updateDrawUI() {
      const n = drawing.points.length;
      ref(drawbar, 'count').textContent = `${n} point${n === 1 ? '' : 's'}`;
      drawbar.querySelector('[data-act="finish"]').disabled = n < 2;
      drawing.line.setLatLngs(drawing.points);
      if (!n) drawing.rubber.setLatLngs([]);
    }
    function updateCrosshairLabel() {
      if (!drawing || crosshair.hidden || !opts.getGround) return;
      const g = opts.getGround(map.getCenter());
      crosshair.querySelector('.sf-crosshair-label').textContent = g == null ? '' : `ground ${fmt(g)} m`;
      if (drawing.points.length) drawing.rubber.setLatLngs([drawing.points[drawing.points.length - 1], map.getCenter()]);
    }
    function addPoint(latlng) {
      if (!drawing) return;
      drawing.points.push(latlng);
      drawing.markers.push(L.circleMarker(latlng, { radius: 7, color: '#C2410C', weight: 3, fillColor: '#FFFFFF', fillOpacity: 1, interactive: false }).addTo(map));
      updateDrawUI();
    }
    function undoPoint() {
      if (!drawing || !drawing.points.length) return;
      drawing.points.pop(); map.removeLayer(drawing.markers.pop()); updateDrawUI();
    }
    function onMapClick(e) { if (!touchUI.matches) addPoint(e.latlng); }
    function onMapDbl(e) { L.DomEvent.stop(e); if (drawing.points.length >= 2) finishDraw(); }
    function endDraw() {
      if (!drawing) return;
      [drawing.line, drawing.rubber, ...drawing.markers].forEach((l) => map.removeLayer(l));
      map.off('click', onMapClick); map.off('dblclick', onMapDbl); map.off('move', updateCrosshairLabel);
      if (drawing.dblZoom) map.doubleClickZoom.enable();
      drawing = null;
      root.classList.remove('is-drawing');
      [drawbar, hint, crosshair, drawbottom].forEach((el) => { el.hidden = true; });
      panel.querySelector('[data-act="draw"]').disabled = false;
    }
    function finishDraw() {
      if (!drawing || drawing.points.length < 2) return;
      const pts = drawing.points.slice();
      endDraw();
      opts.onDrawFinish && opts.onDrawFinish(pts);
    }

    // ---------- Public API ----------
    const api = {
      setResults({ areaKm2, volumeKm3, meta } = {}) {
        ref(panel, 'area').innerHTML = `${fmt(areaKm2, 0)}<small>km²</small>`;
        ref(panel, 'volume').innerHTML = `${fmt(volumeKm3, 2)}<small>km³</small>`;
        ref(panel, 'meta').textContent = meta || '';
      },
      setNotice(text, { error = false } = {}) {
        const el = ref(panel, 'notice');
        el.hidden = !text;
        el.textContent = text || '';
        el.classList.toggle('is-error', error);
        el.setAttribute('role', error ? 'alert' : 'status');
      },
      setDams(list) {
        dams = (list || []).map((d) => ({ ...d }));
        if (selected != null && !dams.some((d) => d.id === selected)) selected = null;
        // keep an active slider drag intact
        const active = document.activeElement;
        if (active && active.dataset && active.dataset.range && damsEl.contains(active)) {
          const d = dams.find((x) => String(x.id) === active.dataset.range);
          if (d) { syncCrest(d.id, parseFloat(active.value), active); return; }
        }
        renderDams();
      },
      select(id) {
        selected = id;
        renderDams();
        opts.onSelect && opts.onSelect(id);
        if (id != null) {
          const card = damsEl.querySelector('.sf-dam.is-selected');
          card && card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      },
      get selected() { return selected; },
      setCursor(latlng, ground, water) {
        if (!latlng) { readout.innerHTML = ''; return; }
        const c = opts.formatCoord ? opts.formatCoord(latlng) : `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
        readout.innerHTML = `<span>${esc(c)}</span>${ground != null ? `<span class="sf-ground">ground ${fmt(ground)} m</span>` : ''}` +
          (water ? `<span class="sf-water">water ${fmt(water.level)} m · ${fmt(water.depth)} m deep</span>` : '');
      },
      startDraw() {
        if (drawing) return;
        api.select(null);
        toggleLayerMenu(false);
        toggleExampleMenu(false);
        drawing = {
          points: [], markers: [],
          line: L.polyline([], { color: '#C2410C', weight: 5, interactive: false }).addTo(map),
          rubber: L.polyline([], { color: '#C2410C', weight: 3, dashArray: '6 6', interactive: false }).addTo(map),
          dblZoom: map.doubleClickZoom.enabled(),
        };
        map.doubleClickZoom.disable();
        map.on('click', onMapClick); map.on('dblclick', onMapDbl);
        root.classList.add('is-drawing');
        drawbar.hidden = false; hint.hidden = false;
        panel.querySelector('[data-act="draw"]').disabled = true;
        if (touchUI.matches) {
          hint.textContent = 'Drag the map to aim, then add a point';
          crosshair.hidden = false; drawbottom.hidden = false;
          map.on('move', updateCrosshairLabel); updateCrosshairLabel();
        } else {
          hint.textContent = 'Click to add points · double-click or Enter to finish · Esc to cancel';
        }
        updateDrawUI();
      },
      cancelDraw: endDraw,
      get isDrawing() { return !!drawing; },
      destroy() { endDraw(); [panel, topright, zoom, readout, attrib, drawbar, hint, crosshair, drawbottom].forEach((el) => el.remove()); },
    };

    renderLayers();
    renderDams();
    api.setResults({});
    return api;
  }

  window.SwissFloodUI = { mount };
})();
