'use strict';
/* Roof Measure - satellite roof measurement & takeoff
 * Plain browser app. Uses Google Maps JavaScript API (satellite imagery, geometry),
 * Geocoding API (address lookup), Solar API (3D roof planes & pitch), Static Maps API (report photo).
 */

// ------------------------------------------------------------------ constants
const SQFT_PER_M2 = 10.7639104;
const FT_PER_M = 3.28084;
const SNAP_PX = 12;
const TOUCH_M = 0.75;            // facets closer than this are the same structure

// Line types, named and colored like Roofr's length report.
const EDGE_TYPES = {
  eave:        { label: 'Eave',          plural: 'Eaves',         color: '#4caf50', slope: 'flat' },
  valley:      { label: 'Valley',        plural: 'Valleys',       color: '#e5533d', slope: 'hip'  },
  hip:         { label: 'Hip',           plural: 'Hips',          color: '#8e5bd6', slope: 'hip'  },
  ridge:       { label: 'Ridge',         plural: 'Ridges',        color: '#b5d46a', slope: 'flat' },
  rake:        { label: 'Rake',          plural: 'Rakes',         color: '#f5c242', slope: 'rake' },
  wall:        { label: 'Wall flashing', plural: 'Wall flashing', color: '#3b8be6', slope: 'flat', dashed: true },
  step:        { label: 'Step flashing', plural: 'Step flashing', color: '#e0902a', slope: 'rake', dashed: true },
  transition:  { label: 'Transition',    plural: 'Transitions',   color: '#e26ee6', slope: 'flat' },
  parapet:     { label: 'Parapet wall',  plural: 'Parapet wall',  color: '#f0a030', slope: 'flat' },
  unspecified: { label: 'Unspecified',   plural: 'Unspecified',   color: '#4fc3f7', slope: 'flat' },
};
const FACET_COLOR = '#00d8ff';
const PITCH_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 24];
const TOOL_KEYS = { s: 'select', f: 'facet', e: 'eave', v: 'valley', h: 'hip', r: 'ridge', k: 'rake', w: 'wall', t: 'step', n: 'transition', p: 'parapet', u: 'unspecified' };

// ------------------------------------------------------------------ state
const state = {
  key: localStorage.getItem('rm.key') || '',
  address: '',
  location: null,          // {lat,lng}
  defaultPitch: 6,
  waste: 10,
  facets: [],              // {id, name, pitch, shape(Polygon), twoStory, twoLayer, excluded}
  edges: [],               // {id, type, pitch(null=default), shape(Polyline)}
  solar: null,             // Solar API response for the main building
  otherSolar: [],          // Solar API responses for other buildings found by the scan
  solarShapes: [],
  showSolar: true,
  showFacetEdges: true,
  selected: null,          // {kind:'facet'|'edge', id}
  tool: 'select',
  jobName: '',
  mat: { ridgeCapLF: 33, starterLF: 105, underlaySq: 10, iwLF: 66.7, dripStick: 10, valleyStick: 10, nailsPerSq: 320, nailsPerBox: 7200 },
};
let map = null, labels = null, geocoder = null, draft = null, nextId = 1;

// ------------------------------------------------------------------ helpers
const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 0) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const ftIn = (ft) => { const f = Math.floor(ft); let i = Math.round((ft - f) * 12); let F = f; if (i === 12) { F += 1; i = 0; } return `${F}' ${i}"`; };
const ftInR = (ft) => { const f = Math.floor(ft); let i = Math.round((ft - f) * 12); let F = f; if (i === 12) { F += 1; i = 0; } return `${F}ft ${i}in`; };   // Roofr style
const pitchFactor = (p) => Math.sqrt(144 + p * p) / 12;                 // rake / slope factor
const hipFactor = (p) => Math.sqrt(1 + (p * p) / 288);                   // hip & valley (equal pitch, 90 deg corner)
const degToPitch = (deg) => 12 * Math.tan(deg * Math.PI / 180);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pathToLiteral = (shape) => shape.getPath().getArray().map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
const edgeFactor = (type, pitch) => {
  const s = EDGE_TYPES[type].slope;
  return s === 'flat' ? 1 : s === 'rake' ? pitchFactor(pitch) : hipFactor(pitch);
};
const dashedIcons = (color) => [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, strokeWeight: 4, scale: 2.5 }, offset: '0', repeat: '12px' }];

function pitchLabel(p) { return p === 0 ? 'Flat' : `${fmt(p, Number.isInteger(p) ? 0 : 1)}/12`; }
function setHint(t) { $('#hint').textContent = t || ''; }
function toast(msg, isErr) { const h = $('#hint'); h.textContent = msg; h.style.color = isErr ? '#ffb4ae' : ''; clearTimeout(toast._t); toast._t = setTimeout(() => { h.style.color = ''; updateHint(); }, 3500); }

// ------------------------------------------------------------------ geometry
function facetMetrics(f) {
  const path = pathToLiteral(f.shape);
  const planM2 = google.maps.geometry.spherical.computeArea(path);
  const plan = planM2 * SQFT_PER_M2;
  const sloped = plan * pitchFactor(f.pitch);
  const perimeterFt = google.maps.geometry.spherical.computeLength([...path, path[0]]) * FT_PER_M;
  return { path, plan, sloped, perimeterFt };
}
// pitch of the facet this line runs along (so rakes and hips on a 4/12 shed use 4/12, not the default)
function adjoiningPitch(path) {
  if (path.length < 2) return null;
  const mid = midpoint(path[0], path[1]);
  let best = null, bestD = 0.6;
  for (const f of state.facets) {
    if (f.excluded) continue;
    const fp = pathToLiteral(f.shape);
    for (let i = 0; i < fp.length; i++) { const d = pointSegM(mid, fp[i], fp[(i + 1) % fp.length]); if (d < bestD) { bestD = d; best = f.pitch; } }
  }
  return best;
}
function edgeMetrics(e) {
  const path = pathToLiteral(e.shape);
  const planFt = google.maps.geometry.spherical.computeLength(path) * FT_PER_M;
  const adj = e.pitch == null ? adjoiningPitch(path) : null;
  const pitch = e.pitch != null ? e.pitch : adj != null ? adj : state.defaultPitch;
  const factor = edgeFactor(e.type, pitch);
  return { path, planFt, trueFt: planFt * factor, factor, pitch };
}
function centroid(path) {
  // planar polygon centroid, computed relative to the first vertex to avoid floating-point cancellation on raw lat/lng
  const o = path[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i], q = path[(i + 1) % path.length];
    const px = p.lng - o.lng, py = p.lat - o.lat, qx = q.lng - o.lng, qy = q.lat - o.lat;
    const cross = px * qy - qx * py;
    a += cross; cx += (px + qx) * cross; cy += (py + qy) * cross;
  }
  if (Math.abs(a) < 1e-18) { return { lat: path.reduce((s, p) => s + p.lat, 0) / path.length, lng: path.reduce((s, p) => s + p.lng, 0) / path.length }; }
  a *= 0.5;
  return { lng: o.lng + cx / (6 * a), lat: o.lat + cy / (6 * a) };
}
function midpoint(a, b) { return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }; }
function segFt(a, b) { return google.maps.geometry.spherical.computeDistanceBetween(a, b) * FT_PER_M; }
function distM(a, b) { return google.maps.geometry.spherical.computeDistanceBetween(a, b); }
// true when a traced line segment already runs along this facet edge (so we do not label it twice)
function coveredByEdge(a, b, edgePaths) {
  const close = (p, q) => distM(p, q) < 0.4;
  for (const path of edgePaths) for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i];
    if ((close(a, p) && close(b, q)) || (close(a, q) && close(b, p))) return true;
  }
  return false;
}
// distance (m) from point p to segment a-b, planar approximation at roof scale
function pointSegM(p, a, b) {
  const k = Math.cos(a.lat * Math.PI / 180);
  const bx = (b.lng - a.lng) * k, by = b.lat - a.lat, px = (p.lng - a.lng) * k, py = p.lat - a.lat;
  const l2 = bx * bx + by * by;
  let t = l2 ? (px * bx + py * by) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy) * 111320;
}
function polysTouch(A, B) {
  const pa = A.m.path, pb = B.m.path;
  for (const p of pa) {
    if (google.maps.geometry.poly.containsLocation(new google.maps.LatLng(p.lat, p.lng), B.f.shape)) return true;
    for (let i = 0; i < pb.length; i++) if (pointSegM(p, pb[i], pb[(i + 1) % pb.length]) < TOUCH_M) return true;
  }
  for (const p of pb) if (google.maps.geometry.poly.containsLocation(new google.maps.LatLng(p.lat, p.lng), A.f.shape)) return true;
  return false;
}
// Group facets into structures (connected components of touching polygons); lines join the nearest structure.
function groupStructures(facetsAll, edges) {
  const n = facetsAll.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (polysTouch(facetsAll[i], facetsAll[j])) parent[find(i)] = find(j);
  const groups = new Map();
  facetsAll.forEach((x, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, { facets: [], cutouts: [], edges: [] }); (x.f.excluded ? groups.get(r).cutouts : groups.get(r).facets).push(x); });
  const list = [...groups.values()];
  for (const ed of edges) {
    let best = null, bestD = Infinity;
    for (const g of list) for (const x of [...g.facets, ...g.cutouts]) for (const p of ed.m.path) {
      const path = x.m.path;
      for (let i = 0; i < path.length; i++) { const d = pointSegM(p, path[i], path[(i + 1) % path.length]); if (d < bestD) { bestD = d; best = g; } }
    }
    if (best) best.edges.push(ed); else if (list.length) list[0].edges.push(ed);
  }
  return list;
}
function summarize(fs, cs, es) {
  const byType = {};
  for (const t of Object.keys(EDGE_TYPES)) byType[t] = { plan: 0, true: 0, count: 0 };
  for (const { e, m } of es) { byType[e.type].plan += m.planFt; byType[e.type].true += m.trueFt; byType[e.type].count++; }
  const sum = (arr, k) => arr.reduce((s, x) => s + x.m[k], 0);
  const plan = sum(fs, 'plan') - sum(cs, 'plan');
  const sloped = sum(fs, 'sloped') - sum(cs, 'sloped');
  const pitchGroups = {};
  for (const x of fs) pitchGroups[x.f.pitch] = (pitchGroups[x.f.pitch] || 0) + x.m.sloped;
  for (const x of cs) if (pitchGroups[x.f.pitch] != null) pitchGroups[x.f.pitch] -= x.m.sloped;
  const pitches = Object.keys(pitchGroups).map(Number).sort((a, b) => a - b);
  let predominant = null, predArea = -1;
  for (const p of pitches) if (pitchGroups[p] > predArea) { predArea = pitchGroups[p]; predominant = p; }
  const flat = pitchGroups[0] || 0;
  const twoStory = fs.filter((x) => x.f.twoStory).reduce((s, x) => s + x.m.sloped, 0);
  const twoLayer = fs.filter((x) => x.f.twoLayer).reduce((s, x) => s + x.m.sloped, 0);
  const wp = sloped > 0 ? fs.reduce((s, x) => s + x.m.sloped * x.f.pitch, 0) / sum(fs, 'sloped') : state.defaultPitch;
  return { facets: fs, cutouts: cs, edges: es, plan, sloped, pitched: sloped - flat, flat, twoStory, twoLayer, byType, pitchGroups, pitches, predominant, predArea: Math.max(predArea, 0), facetCount: fs.length, weightedPitch: wp, squares: sloped / 100, squaresWaste: sloped / 100 * (1 + state.waste / 100) };
}
// Roofr-style recommended waste. Fitted to Roofr reports: cut edges (hips + valleys + rakes + step flashing) per square.
// Matches Roofr on every structure checked: 6%, 7%, 10% (flat), 11%, 12% and 33%.
function roofrWaste(S) {
  if (!S || !S.sloped || S.pitched <= 0) return 10;
  const cut = S.byType.hip.true + S.byType.valley.true + S.byType.rake.true + S.byType.step.true;
  const perSq = cut / (S.sloped / 100);
  return Math.max(1, Math.round(1 + 1.18 * perSq));
}
function computeTotals() {
  const facetsAll = state.facets.map((f) => ({ f, m: facetMetrics(f) }));
  const edges = state.edges.map((e) => ({ e, m: edgeMetrics(e) }));
  const groups = groupStructures(facetsAll, edges).map((g) => summarize(g.facets, g.cutouts, g.edges)).sort((a, b) => b.sloped - a.sloped);
  groups.forEach((g, i) => { g.index = i + 1; });
  const all = summarize(facetsAll.filter((x) => !x.f.excluded), facetsAll.filter((x) => x.f.excluded), edges);
  all.structures = groups;
  all.recWaste = roofrWaste(all);
  for (const g of groups) g.recWaste = roofrWaste(g);
  all.facetsAll = facetsAll;
  return all;
}

function computeMaterials(t) {
  const m = state.mat;
  const bt = t.byType;
  const eaveRake = bt.eave.true + bt.rake.true;
  const ridgeHip = bt.ridge.true + bt.hip.true;
  const items = [];
  const add = (name, qty, unit, basis) => items.push({ name, qty, unit, basis });
  add('Shingles', Math.ceil(t.squaresWaste * 3), 'bundles', `${fmt(t.squares, 2)} sq + ${state.waste}% waste = ${fmt(t.squaresWaste, 2)} sq, 3 bundles/sq`);
  add('Synthetic underlayment', Math.ceil(t.squares * 1.1 / m.underlaySq), 'rolls', `${fmt(t.squares, 2)} sq + 10% laps, ${m.underlaySq} sq/roll`);
  add('Ice & water shield', Math.ceil((bt.eave.true + bt.valley.true) / m.iwLF), 'rolls', `eaves ${fmt(bt.eave.true)} LF + valleys ${fmt(bt.valley.true)} LF, ${m.iwLF} LF/roll`);
  add('Starter strip', Math.ceil(eaveRake / m.starterLF), 'bundles', `eaves + rakes ${fmt(eaveRake)} LF, ${m.starterLF} LF/bundle`);
  add('Ridge cap', Math.ceil(ridgeHip / m.ridgeCapLF), 'bundles', `ridges + hips ${fmt(ridgeHip)} LF, ${m.ridgeCapLF} LF/bundle`);
  add('Drip edge', Math.ceil(eaveRake * 1.05 / m.dripStick), 'sticks', `eaves + rakes ${fmt(eaveRake)} LF + 5%, ${m.dripStick}' sticks`);
  if (bt.valley.true > 0) add('Valley metal (if open valley)', Math.ceil(bt.valley.true / m.valleyStick), 'sticks', `${fmt(bt.valley.true)} LF, ${m.valleyStick}' sticks`);
  if (bt.step.true > 0) add('Step flashing', Math.ceil(bt.step.true * 2.2), 'pieces', `${fmt(bt.step.true)} LF at 5 5/8" exposure`);
  if (bt.wall.true > 0) add('Wall / apron flashing', Math.ceil(bt.wall.true / 10), 'sticks', `${fmt(bt.wall.true)} LF, 10' sticks`);
  if (bt.ridge.true > 0) add('Ridge vent (if vented ridge)', Math.ceil(bt.ridge.true / 4), 'pieces', `${fmt(bt.ridge.true)} LF ridge, 4' pieces`);
  add('Coil nails', Math.ceil(t.squaresWaste * m.nailsPerSq / m.nailsPerBox), 'boxes', `${m.nailsPerSq} nails/sq, ${m.nailsPerBox}/box`);
  return items;
}

// ------------------------------------------------------------------ map init
let mapsRequested = false;
function loadMaps() {
  if (!state.key || mapsRequested) return;
  mapsRequested = true;
  $('#nokey').hidden = true;
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.key)}&libraries=geometry&v=weekly&loading=async&callback=initMap`;
  s.async = true;
  s.onerror = () => { $('#nokey').hidden = false; $('#nokey p').textContent = 'Could not load Google Maps. Check the API key and that Maps JavaScript API is enabled.'; };
  document.head.appendChild(s);
}
window.gm_authFailure = () => { $('#nokey').hidden = false; $('#nokey p').textContent = 'Google rejected this API key. Check the key, billing, and that Maps JavaScript API is enabled.'; };

window.initMap = function initMap() {
  const saved = JSON.parse(localStorage.getItem('rm.lastLoc') || 'null');
  const start = saved || { lat: 30.3322, lng: -81.6557 };
  map = new google.maps.Map($('#map'), {
    center: start, zoom: saved ? 19 : 12, mapTypeId: 'satellite', tilt: 0, heading: 0,
    disableDoubleClickZoom: true, clickableIcons: false, gestureHandling: 'greedy',
    streetViewControl: false, fullscreenControl: false, rotateControl: false, scaleControl: true,
    mapTypeControl: true, mapTypeControlOptions: { mapTypeIds: ['satellite', 'hybrid'], position: google.maps.ControlPosition.LEFT_BOTTOM },
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
  });
  map.addListener('tilt_changed', () => { if (map.getTilt() !== 0) map.setTilt(0); });
  geocoder = new google.maps.Geocoder();

  class LabelLayer extends google.maps.OverlayView {
    constructor(m) { super(); this.items = []; this.div = null; this.setMap(m); }
    onAdd() { this.div = document.createElement('div'); this.div.className = 'labels'; this.getPanes().floatPane.appendChild(this.div); }
    onRemove() { if (this.div) this.div.remove(); this.div = null; }
    setItems(items) { this.items = items; this.draw(); }
    draw() {
      if (!this.div) return;
      const proj = this.getProjection(); if (!proj) return;
      this.div.innerHTML = '';
      for (const it of this.items) {
        const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(it.lat, it.lng));
        const el = document.createElement('div');
        el.className = 'lbl ' + (it.cls || '');
        el.innerHTML = it.html;
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
        this.div.appendChild(el);
      }
    }
    pixel(latLng) { const proj = this.getProjection(); return proj ? proj.fromLatLngToContainerPixel(latLng) : null; }
  }
  labels = new LabelLayer(map);

  map.addListener('click', onMapClick);
  map.addListener('dblclick', (e) => { onMapClick(e, true); });
  map.addListener('mousemove', onMapMove);
  map.addListener('rightclick', () => { if (draft) undoPoint(); });

  $('#btnSolar').disabled = !state.location;
  $('#btnScan').disabled = !state.location;
  if (state.location) { map.setCenter(state.location); map.setZoom(20); }
  updateHint();
};

// ------------------------------------------------------------------ geocoding
async function goToAddress() {
  const q = $('#address').value.trim();
  if (!q || !map) return;
  const m = q.match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) { setLocation({ lat: +m[1], lng: +m[3] }, q); return; }
  try {
    const res = await geocoder.geocode({ address: q });
    const r = res.results && res.results[0];
    if (!r) throw new Error('No results');
    const loc = { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() };
    setLocation(loc, r.formatted_address);
  } catch (err) {
    toast('Address not found: ' + (err.message || err), true);
  }
}
function setLocation(loc, label) {
  state.location = loc; state.address = label || `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
  $('#address').value = state.address;
  localStorage.setItem('rm.lastLoc', JSON.stringify(loc));
  map.setCenter(loc); map.setZoom(20);
  $('#btnSolar').disabled = false;
  $('#btnScan').disabled = false;
  $('#extLinks').hidden = false;
  $('#lnkStreet').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc.lat},${loc.lng}`;
  $('#lnkEarth').href = `https://earth.google.com/web/@${loc.lat},${loc.lng},0a,120d,35y,0h,45t,0r`;
}

// ------------------------------------------------------------------ Solar API
async function fetchSolar(lat, lng) {
  const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${encodeURIComponent(state.key)}`;
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error && j.error.message || msg; } catch (_) { /* ignore */ }
    if (r.status === 404) msg = 'No Solar API coverage for this building. Trace the roof manually.';
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r.json();
}
async function runSolar() {
  if (!state.location) return;
  const out = $('#solarOut');
  out.innerHTML = '<span class="muted">Fetching roof model...</span>';
  try {
    state.solar = await fetchSolar(state.location.lat, state.location.lng);
    drawSolar(); renderSolar(); recompute();
    $('#btnAuto').disabled = false;
  } catch (err) {
    out.innerHTML = `<span class="err">${esc(err.message || err)}</span>`;
  }
}
// Probe a ring of points around the pin and collect every distinct building Google knows about:
// detached garages, sheds, pool houses, workshops. Each probe is one Solar API request.
function offsetLatLng(lat, lng, meters, bearingDeg) {
  const b = bearingDeg * Math.PI / 180;
  return { lat: lat + (meters * Math.cos(b)) / 110540, lng: lng + (meters * Math.sin(b)) / (111320 * Math.cos(lat * Math.PI / 180)) };
}
async function scanStructures() {
  if (!state.location) return;
  const btn = $('#btnScan'); btn.disabled = true; btn.textContent = 'Scanning...';
  const { lat, lng } = state.location;
  const mainName = state.solar && state.solar.name;
  const pts = [];
  for (const r of [12, 24, 36]) for (let a = 0; a < 360; a += 45) pts.push(offsetLatLng(lat, lng, r, a));
  const found = {};
  for (let i = 0; i < pts.length; i += 6) {
    await Promise.all(pts.slice(i, i + 6).map(async (p) => {
      try { const j = await fetchSolar(p.lat, p.lng); if (j.name && j.name !== mainName) found[j.name] = j; } catch (_) { /* no building near this probe */ }
    }));
  }
  state.otherSolar = Object.values(found);
  btn.disabled = false; btn.textContent = 'Scan for other structures';
  drawSolar(); renderSolar(); recompute();
  toast(state.otherSolar.length ? `${state.otherSolar.length} other structure${state.otherSolar.length === 1 ? '' : 's'} found` : 'No other structures found within about 120 ft');
}
function clearSolar() { for (const s of state.solarShapes) s.setMap(null); state.solarShapes = []; }
function drawSolar() {
  clearSolar();
  if (!state.showSolar) return;
  const rect = (bb, opts) => state.solarShapes.push(new google.maps.Rectangle({ map, bounds: { north: bb.ne.latitude, east: bb.ne.longitude, south: bb.sw.latitude, west: bb.sw.longitude }, clickable: false, zIndex: 1, ...opts }));
  if (state.solar && state.solar.solarPotential) {
    if (state.solar.boundingBox) rect(state.solar.boundingBox, { strokeColor: '#ffd60a', strokeOpacity: .9, strokeWeight: 2, fillOpacity: 0 });
    for (const seg of state.solar.solarPotential.roofSegmentStats || []) rect(seg.boundingBox, { strokeColor: '#ffd60a', strokeOpacity: .5, strokeWeight: 1, fillColor: '#ffd60a', fillOpacity: .06 });
  }
  for (const o of state.otherSolar) if (o.boundingBox) rect(o.boundingBox, { strokeColor: '#ff7a00', strokeOpacity: .95, strokeWeight: 2, fillColor: '#ff7a00', fillOpacity: .12 });
}
function solarSummaryOf(resp) {
  const sp = resp && resp.solarPotential;
  if (!sp) return null;
  const segs = (sp.roofSegmentStats || []).map((s) => ({
    pitchDeg: s.pitchDegrees, pitch: degToPitch(s.pitchDegrees), az: s.azimuthDegrees,
    area: s.stats.areaMeters2 * SQFT_PER_M2, ground: (s.stats.groundAreaMeters2 || 0) * SQFT_PER_M2, center: s.center,
  })).sort((a, b) => b.area - a.area);
  const total = sp.wholeRoofStats.areaMeters2 * SQFT_PER_M2;
  const ground = (sp.wholeRoofStats.groundAreaMeters2 || 0) * SQFT_PER_M2;
  const predominant = segs.length ? segs[0].pitch : 0;
  const d = resp.imageryDate;
  return { segs, total, ground, predominant, center: resp.center, imageryDate: d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null, quality: resp.imageryQuality };
}
function solarSummary() { return solarSummaryOf(state.solar); }
function renderSolar() {
  const s = solarSummary();
  const out = $('#solarOut');
  if (!s && !state.otherSolar.length) { out.innerHTML = ''; return; }
  const dir = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  let html = '';
  if (s) {
    html += `
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(s.total)}</div><div class="l">roof sq ft</div></div>
      <div class="kpi"><div class="v">${fmt(s.total / 100, 1)}</div><div class="l">squares</div></div>
      <div class="kpi"><div class="v">${pitchLabel(Math.round(s.predominant))}</div><div class="l">main pitch</div></div>
    </div>
    <div class="muted small">Footprint ${fmt(s.ground)} sq ft &middot; ${s.segs.length} planes &middot; imagery ${s.imageryDate || '?'} (${(s.quality || '').toLowerCase()})</div>
    <div class="row" style="margin:8px 0">
      <button id="btnUseSolarPitch" class="small">Use ${pitchLabel(Math.round(s.predominant))} as default pitch</button>
    </div>
    <table>
      <tr><th>#</th><th>Pitch</th><th>Faces</th><th class="num">Sq ft</th></tr>
      ${s.segs.map((g, i) => `<tr><td>${i + 1}</td><td>${pitchLabel(Math.round(g.pitch))} <span class="muted">(${fmt(g.pitchDeg, 1)}&deg;)</span></td><td>${dir(g.az)}</td><td class="num">${fmt(g.area)}</td></tr>`).join('')}
      <tr class="total"><td colspan="3">Total</td><td class="num">${fmt(s.total)}</td></tr>
    </table>`;
  }
  if (state.otherSolar.length) {
    html += `<h4 style="margin-top:12px">Other structures on the lot</h4><div class="list">${state.otherSolar.map((o, i) => { const q = solarSummaryOf(o); return `<div class="item" data-other="${i}"><span class="sw" style="background:#ff7a00"></span><span class="name">#${i + 2}</span><span>${q ? pitchLabel(Math.round(q.predominant)) : ''}</span><span class="meta">${q ? fmt(q.total) + ' sf roof · ' + fmt(q.ground) + ' sf footprint' : 'no data'}</span><button data-zoom="1">Zoom</button></div>`; }).join('')}</div>
    <p class="muted" style="margin:6px 0 0">Orange boxes on the map. Trace each one with the Facet tool; it is reported as its own structure.</p>`;
  } else if (s) {
    html += `<p class="muted" style="margin:8px 0 0">Only the main building was returned. Use <b>Scan for other structures</b> to look for sheds, detached garages and pool houses around it.</p>`;
  }
  out.innerHTML = html;
  const b = $('#btnUseSolarPitch'); if (b) b.onclick = () => { setDefaultPitch(Math.round(s.predominant)); toast(`Default pitch set to ${pitchLabel(state.defaultPitch)}`); };
  out.querySelectorAll('[data-other]').forEach((el) => { el.onclick = () => { const o = state.otherSolar[+el.dataset.other]; if (o && o.center) { map.panTo({ lat: o.center.latitude, lng: o.center.longitude }); map.setZoom(21); } }; });
}

// ------------------------------------------------------------------ drawing
function setTool(t) {
  if (draft) cancelDraft();
  state.tool = t;
  document.querySelectorAll('#toolbar .tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const drawing = t !== 'select';
  if (map) map.setOptions({ draggableCursor: drawing ? 'crosshair' : null });
  for (const f of state.facets) f.shape.setOptions({ clickable: !drawing });
  for (const e of state.edges) e.shape.setOptions({ clickable: !drawing });
  if (drawing) select(null);
  updateHint();
}
function updateHint() {
  if (draft) {
    const n = draft.points.length;
    if (draft.tool === 'facet') setHint(n < 3 ? `Facet: ${n} point${n === 1 ? '' : 's'} - click corners of this roof plane` : `Facet: ${n} points - double-click, press Enter, or click the first point to close`);
    else setHint(`${EDGE_TYPES[draft.tool].label}: ${n} point${n === 1 ? '' : 's'} - double-click or Enter to finish`);
  } else if (state.tool === 'select') {
    setHint(state.facets.length || state.edges.length ? 'Select: click a shape to edit it. Drag corners, right-click a corner to remove it.' : 'Enter an address, then pick Facet and click the corners of each roof plane.');
  } else if (state.tool === 'facet') setHint('Facet: click the corners of one roof plane');
  else setHint(`${EDGE_TYPES[state.tool].label}: click the start point`);
}
function nearPx(a, b, px) {
  if (!labels) return false;
  const pa = labels.pixel(a), pb = labels.pixel(b);
  if (!pa || !pb) return false;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) <= px;
}
function allVertices() {
  const v = [];
  for (const f of state.facets) f.shape.getPath().forEach((ll) => v.push(ll));
  for (const e of state.edges) e.shape.getPath().forEach((ll) => v.push(ll));
  if (draft) for (const p of draft.points) v.push(p);
  return v;
}
function snap(latLng) {
  let best = null, bestD = SNAP_PX + 1;
  const p0 = labels.pixel(latLng);
  if (!p0) return latLng;
  for (const v of allVertices()) {
    const p = labels.pixel(v);
    const d = Math.hypot(p.x - p0.x, p.y - p0.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best || latLng;
}
function startDraft(tool) {
  const color = tool === 'facet' ? FACET_COLOR : EDGE_TYPES[tool].color;
  draft = {
    tool, points: [],
    line: new google.maps.Polyline({ map, path: [], strokeColor: color, strokeWeight: 3, clickable: false, zIndex: 50 }),
    rubber: new google.maps.Polyline({ map, path: [], strokeColor: color, strokeOpacity: 0, clickable: false, zIndex: 50, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: .8, strokeWeight: 2, scale: 3 }, offset: '0', repeat: '12px' }] }),
    fill: tool === 'facet' ? new google.maps.Polygon({ map, paths: [], fillColor: color, fillOpacity: .15, strokeOpacity: 0, clickable: false, zIndex: 49 }) : null,
    cursor: null,
  };
}
function onMapClick(e, isDbl) {
  if (!e.latLng) return;
  if (state.tool === 'select') { if (!isDbl) select(null); return; }
  if (isDbl) { finishDraft(); return; }
  if (!draft) startDraft(state.tool);
  const pt = snap(e.latLng);
  const pts = draft.points;
  if (pts.length && nearPx(pt, pts[pts.length - 1], 4)) return;             // ignore the 2nd click of a double-click
  if (draft.tool === 'facet' && pts.length >= 3 && pts[0].equals(pt)) { finishDraft(); return; } // close on first point
  pts.push(pt);
  refreshDraft();
}
function onMapMove(e) {
  if (!draft || !e.latLng) return;
  draft.cursor = snap(e.latLng);
  refreshDraft(true);
}
function refreshDraft(moveOnly) {
  const pts = draft.points;
  if (!moveOnly) { draft.line.setPath(pts); if (draft.fill) draft.fill.setPath(pts); }
  const items = [];
  if (pts.length && draft.cursor) {
    draft.rubber.setPath([pts[pts.length - 1], draft.cursor]);
    const ft = segFt(pts[pts.length - 1], draft.cursor);
    const mid = midpoint({ lat: pts[pts.length - 1].lat(), lng: pts[pts.length - 1].lng() }, { lat: draft.cursor.lat(), lng: draft.cursor.lng() });
    items.push({ ...mid, cls: 'draft', html: ftIn(ft) });
  } else draft.rubber.setPath([]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    items.push({ ...midpoint({ lat: a.lat(), lng: a.lng() }, { lat: b.lat(), lng: b.lng() }), cls: 'draft', html: ftIn(segFt(a, b)) });
  }
  if (draft.tool === 'facet' && pts.length >= 3) {
    const lit = pts.map((p) => ({ lat: p.lat(), lng: p.lng() }));
    const plan = google.maps.geometry.spherical.computeArea(lit) * SQFT_PER_M2;
    items.push({ ...centroid(lit), cls: 'facet', html: `${fmt(plan)} sf plan<small>${pitchLabel(state.defaultPitch)} &rarr; ${fmt(plan * pitchFactor(state.defaultPitch))} sf</small>` });
  }
  labels.setItems([...baseLabels(), ...items]);
  updateHint();
}
function undoPoint() {
  if (!draft) return;
  draft.points.pop();
  if (!draft.points.length) { cancelDraft(); return; }
  refreshDraft();
}
function cancelDraft() {
  if (!draft) return;
  draft.line.setMap(null); draft.rubber.setMap(null); if (draft.fill) draft.fill.setMap(null);
  draft = null;
  labels.setItems(baseLabels());
  updateHint();
}
function finishDraft() {
  if (!draft) return;
  const pts = draft.points.map((p) => ({ lat: p.lat(), lng: p.lng() }));
  const tool = draft.tool;
  cancelDraft();
  if (tool === 'facet') { if (pts.length < 3) { toast('A facet needs at least 3 points', true); return; } addFacet(pts, state.defaultPitch); }
  else { if (pts.length < 2) { toast('A line needs at least 2 points', true); return; } addEdge(tool, pts, null); }
}

// ------------------------------------------------------------------ shapes
function attachShape(item, kind) {
  const sh = item.shape;
  sh.addListener('click', () => { if (state.tool === 'select') select({ kind, id: item.id }); });
  sh.addListener('rightclick', (e) => {
    if (e.vertex == null) return;
    const path = sh.getPath();
    const min = kind === 'facet' ? 3 : 2;
    if (path.getLength() > min) path.removeAt(e.vertex);
  });
  const path = sh.getPath();
  ['set_at', 'insert_at', 'remove_at'].forEach((ev) => path.addListener(ev, recompute));
}
function facetStyle(f, selected) {
  if (f.excluded) return { fillColor: '#ffffff', fillOpacity: .35, strokeColor: selected ? '#ff7a00' : '#ffffff', strokeWeight: selected ? 3 : 2, strokeOpacity: .9 };
  return { fillColor: FACET_COLOR, fillOpacity: .22, strokeColor: selected ? '#ff7a00' : '#ffffff', strokeWeight: selected ? 3 : 2, strokeOpacity: 1 };
}
function addFacet(path, pitch, name, flags = {}) {
  const id = nextId++;
  const f = { id, name: name || `F${state.facets.length + 1}`, pitch, twoStory: !!flags.twoStory, twoLayer: !!flags.twoLayer, excluded: !!flags.excluded, azimuth: flags.azimuth == null ? null : flags.azimuth };
  f.shape = new google.maps.Polygon({ map, paths: path, clickable: state.tool === 'select', zIndex: f.excluded ? 12 : 10, geodesic: false, ...facetStyle(f, false) });
  state.facets.push(f); attachShape(f, 'facet'); recompute();
  return f;
}
function edgeStyle(e, selected) {
  const t = EDGE_TYPES[e.type];
  return t.dashed
    ? { strokeColor: t.color, strokeOpacity: 0, strokeWeight: selected ? 7 : 4, icons: dashedIcons(t.color) }
    : { strokeColor: t.color, strokeOpacity: 1, strokeWeight: selected ? 7 : 4, icons: [] };
}
function addEdge(type, path, pitch, name) {
  const id = nextId++;
  const e = { id, type, pitch: pitch == null ? null : pitch, name: name || '' };
  e.shape = new google.maps.Polyline({ map, path, clickable: state.tool === 'select', zIndex: 20, ...edgeStyle(e, false) });
  state.edges.push(e); attachShape(e, 'edge'); recompute();
  return e;
}
function removeItem(kind, id) {
  const arr = kind === 'facet' ? state.facets : state.edges;
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) return;
  arr[i].shape.setMap(null); arr.splice(i, 1);
  if (state.selected && state.selected.id === id) state.selected = null;
  if (kind === 'facet') state.facets.forEach((f, k) => { if (/^F\d+$/.test(f.name)) f.name = `F${k + 1}`; });
  recompute();
}
function findSel() {
  if (!state.selected) return null;
  const arr = state.selected.kind === 'facet' ? state.facets : state.edges;
  return arr.find((x) => x.id === state.selected.id) || null;
}
function select(sel) {
  const prev = findSel();
  if (prev) { prev.shape.setEditable(false); prev.shape.setOptions(state.selected.kind === 'facet' ? facetStyle(prev, false) : edgeStyle(prev, false)); }
  state.selected = sel;
  const cur = findSel();
  if (cur) { cur.shape.setEditable(true); cur.shape.setOptions(sel.kind === 'facet' ? facetStyle(cur, true) : edgeStyle(cur, true)); }
  renderSelection(); renderLists();
}
function clearAll() {
  if (draft) cancelDraft();
  for (const f of state.facets) f.shape.setMap(null);
  for (const e of state.edges) e.shape.setMap(null);
  state.facets = []; state.edges = []; state.selected = null; state.solar = null; state.otherSolar = []; clearSolar();
  $('#solarOut').innerHTML = ''; $('#jobName').value = ''; state.jobName = '';
  recompute();
}

// ------------------------------------------------------------------ labels & rendering
function baseLabels() {
  const items = [];
  const edgePaths = state.edges.map((e) => pathToLiteral(e.shape));
  for (const f of state.facets) {
    const m = facetMetrics(f);
    if (f.excluded) items.push({ ...centroid(m.path), cls: 'facet cut', html: `${esc(f.name)} excluded<small>&minus;${fmt(m.sloped)} sf</small>` });
    else items.push({ ...centroid(m.path), cls: 'facet', html: `${esc(f.name)} &middot; ${pitchLabel(f.pitch)}${f.twoStory ? ' &middot; 2-story' : ''}${f.twoLayer ? ' &middot; 2-layer' : ''}<small>${fmt(m.sloped)} sf</small>` });
    if (state.showFacetEdges && !f.excluded) for (let i = 0; i < m.path.length; i++) {
      const a = m.path[i], b = m.path[(i + 1) % m.path.length];
      if (coveredByEdge(a, b, edgePaths)) continue;
      items.push({ ...midpoint(a, b), cls: 'fe', html: ftIn(segFt(a, b)) });
    }
  }
  for (const e of state.edges) {
    const m = edgeMetrics(e);
    for (let i = 1; i < m.path.length; i++) {
      const a = m.path[i - 1], b = m.path[i];
      items.push({ ...midpoint(a, b), cls: '', html: `<span style="color:${EDGE_TYPES[e.type].color}">&#9632;</span> ${ftIn(segFt(a, b) * m.factor)}` });
    }
  }
  if (state.showSolar) {
    if (state.solar && state.solar.solarPotential) for (const s of state.solar.solarPotential.roofSegmentStats || []) {
      items.push({ lat: s.center.latitude, lng: s.center.longitude, cls: 'solar', html: `${pitchLabel(Math.round(degToPitch(s.pitchDegrees)))} &middot; ${fmt(s.stats.areaMeters2 * SQFT_PER_M2)} sf` });
    }
    state.otherSolar.forEach((o, i) => { const q = solarSummaryOf(o); if (q && o.center) items.push({ lat: o.center.latitude, lng: o.center.longitude, cls: 'solar other', html: `Structure #${i + 2}<small>${fmt(q.total)} sf &middot; ${pitchLabel(Math.round(q.predominant))}</small>` }); });
  }
  return items;
}
function recompute() {
  if (!labels) return;
  labels.setItems(baseLabels());
  renderLists(); renderSummary(); renderSelection();
}
function structureOf(t, facetId) {
  for (const s of t.structures) if ([...s.facets, ...s.cutouts].some((x) => x.f.id === facetId)) return s.index;
  return null;
}
function renderLists() {
  const fl = $('#facetList'), el = $('#edgeList');
  const selId = state.selected && state.selected.id;
  const t = computeTotals();
  const multi = t.structures.length > 1;
  fl.innerHTML = state.facets.length ? state.facets.map((f) => {
    const m = facetMetrics(f);
    const tags = [f.twoStory ? '2-story' : '', f.twoLayer ? '2-layer' : ''].filter(Boolean).join(' ');
    return `<div class="item ${f.id === selId ? 'sel' : ''} ${f.excluded ? 'cut' : ''}" data-kind="facet" data-id="${f.id}"><span class="sw" style="background:${f.excluded ? '#fff' : FACET_COLOR}"></span><span class="name">${esc(f.name)}</span>${multi ? `<span class="tag">S${structureOf(t, f.id)}</span>` : ''}<span>${f.excluded ? 'excluded' : pitchLabel(f.pitch)}</span>${tags ? `<span class="tag">${tags}</span>` : ''}<span class="meta">${f.excluded ? '&minus;' : ''}<b>${fmt(m.sloped)} sf</b></span><button data-del="1" title="Delete">&times;</button></div>`;
  }).join('') : '<div class="empty">No facets yet. Use the Facet tool and click the corners of each roof plane.</div>';
  el.innerHTML = state.edges.length ? state.edges.map((e) => {
    const m = edgeMetrics(e);
    return `<div class="item ${e.id === selId ? 'sel' : ''}" data-kind="edge" data-id="${e.id}"><span class="sw" style="background:${EDGE_TYPES[e.type].color}"></span><span class="name">${EDGE_TYPES[e.type].label}</span><span class="meta">${m.factor !== 1 ? fmt(m.planFt, 1) + ' plan &rarr; ' : ''}<b>${fmt(m.trueFt, 1)} ft</b></span><button data-del="1" title="Delete">&times;</button></div>`;
  }).join('') : '<div class="empty">No lines yet. Trace eaves, ridges, hips, valleys and rakes for linear footage.</div>';
  document.querySelectorAll('.list .item[data-kind]').forEach((it) => {
    it.onclick = (ev) => {
      const kind = it.dataset.kind, id = +it.dataset.id;
      if (ev.target.dataset.del) { removeItem(kind, id); return; }
      if (state.tool !== 'select') setTool('select');
      select({ kind, id });
      const item = findSel(); if (item) { const b = new google.maps.LatLngBounds(); item.shape.getPath().forEach((p) => b.extend(p)); map.panTo(b.getCenter()); }
    };
  });
}
function renderSelection() {
  const box = $('#selection');
  const item = findSel();
  if (!item) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const pitchOpts = (val, allowDefault) => (allowDefault ? `<option value="" ${val == null ? 'selected' : ''}>Default (${pitchLabel(state.defaultPitch)})</option>` : '') + PITCH_OPTIONS.map((p) => `<option value="${p}" ${val === p ? 'selected' : ''}>${pitchLabel(p)}</option>`).join('');
  if (state.selected.kind === 'facet') {
    const m = facetMetrics(item);
    box.innerHTML = `<div class="row" style="justify-content:space-between"><b>Facet ${esc(item.name)}</b><button class="small danger" id="selDel">Delete</button></div>
      <div class="grid2" style="margin-top:6px">
        <label>Name <input id="selName" type="text" value="${esc(item.name)}"></label>
        <label>Pitch <select id="selPitch">${pitchOpts(item.pitch, false)}</select></label>
      </div>
      <div class="row wrap" style="margin-top:8px;gap:12px">
        <label class="chk"><input type="checkbox" id="selTwoStory" ${item.twoStory ? 'checked' : ''}> Two story</label>
        <label class="chk"><input type="checkbox" id="selTwoLayer" ${item.twoLayer ? 'checked' : ''}> Two layers</label>
        <label class="chk"><input type="checkbox" id="selExcluded" ${item.excluded ? 'checked' : ''}> Exclude (skylight, chimney, cutout)</label>
      </div>
      <div class="muted small" style="margin-top:6px">Plan ${fmt(m.plan)} sf &middot; pitch factor ${fmt(pitchFactor(item.pitch), 3)} &middot; <b>${fmt(m.sloped)} sf</b> ${item.excluded ? 'subtracted from the roof it sits on' : 'roof area'} &middot; perimeter ${fmt(m.perimeterFt, 1)} ft &middot; ${m.path.length} corners</div>`;
    $('#selPitch').onchange = (e) => { item.pitch = +e.target.value; recompute(); };
    $('#selTwoStory').onchange = (e) => { item.twoStory = e.target.checked; recompute(); };
    $('#selTwoLayer').onchange = (e) => { item.twoLayer = e.target.checked; recompute(); };
    $('#selExcluded').onchange = (e) => { item.excluded = e.target.checked; item.shape.setOptions({ ...facetStyle(item, true), zIndex: item.excluded ? 12 : 10 }); recompute(); };
  } else {
    const m = edgeMetrics(item);
    box.innerHTML = `<div class="row" style="justify-content:space-between"><b>${EDGE_TYPES[item.type].label} line</b><button class="small danger" id="selDel">Delete</button></div>
      <div class="grid2" style="margin-top:6px">
        <label>Type <select id="selType">${Object.entries(EDGE_TYPES).map(([k, v]) => `<option value="${k}" ${k === item.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label>Pitch for slope length <select id="selPitch">${pitchOpts(item.pitch, true)}</select></label>
      </div>
      <div class="muted small" style="margin-top:6px">Plan ${fmt(m.planFt, 1)} ft &times; ${fmt(m.factor, 3)} = <b>${fmt(m.trueFt, 1)} ft</b> (${ftIn(m.trueFt)}) &middot; ${m.path.length - 1} segment${m.path.length === 2 ? '' : 's'}</div>`;
    $('#selType').onchange = (e) => { item.type = e.target.value; item.shape.setOptions(edgeStyle(item, true)); recompute(); };
    $('#selPitch').onchange = (e) => { item.pitch = e.target.value === '' ? null : +e.target.value; recompute(); };
  }
  $('#selDel').onclick = () => removeItem(state.selected.kind, state.selected.id);
  const nameEl = $('#selName'); if (nameEl) nameEl.onchange = (e) => { item.name = e.target.value.trim() || item.name; recompute(); };
}
function renderSummary() {
  const t = computeTotals();
  const sOut = $('#summaryOut'), mOut = $('#materialsOut');
  if (!state.facets.length && !state.edges.length) { sOut.innerHTML = '<span class="muted">Trace facets and lines to see totals here.</span>'; mOut.innerHTML = ''; return; }
  const rows = Object.entries(EDGE_TYPES).filter(([k]) => t.byType[k].count).map(([k, v]) => `<tr><td><span style="color:${v.color}">&#9632;</span> ${v.plural}</td><td class="num">${fmt(t.byType[k].plan, 1)}</td><td class="num"><b>${fmt(t.byType[k].true, 1)}</b></td></tr>`).join('');
  const structRows = t.structures.length > 1 ? `<table style="margin-top:8px"><tr><th>Structure</th><th class="num">Facets</th><th class="num">Sq ft</th><th>Pitch</th></tr>${t.structures.map((s) => `<tr><td>Structure #${s.index}</td><td class="num">${s.facetCount}</td><td class="num">${fmt(s.sloped)}</td><td>${s.predominant == null ? '-' : pitchLabel(s.predominant)}</td></tr>`).join('')}</table>` : '';
  sOut.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(t.sloped)}</div><div class="l">roof sq ft</div></div>
      <div class="kpi"><div class="v">${fmt(t.squares, 2)}</div><div class="l">squares</div></div>
      <div class="kpi"><div class="v">${fmt(t.squaresWaste, 2)}</div><div class="l">sq with ${state.waste}% waste</div></div>
    </div>
    <div class="muted small">Footprint (plan) ${fmt(t.plan)} sf &middot; ${t.facetCount} facet${t.facetCount === 1 ? '' : 's'}${t.cutouts.length ? ` &middot; ${t.cutouts.length} excluded` : ''} &middot; ${t.structures.length} structure${t.structures.length === 1 ? '' : 's'} &middot; predominant pitch ${t.predominant == null ? '-' : pitchLabel(t.predominant)} &middot; recommended waste (Roofr method) <b>${t.recWaste}%</b>${t.flat ? ` &middot; flat ${fmt(t.flat)} sf` : ''}${t.twoStory ? ` &middot; two story ${fmt(t.twoStory)} sf` : ''}${t.twoLayer ? ` &middot; two layer ${fmt(t.twoLayer)} sf` : ''}</div>
    ${structRows}
    ${rows ? `<table style="margin-top:8px"><tr><th>Line</th><th class="num">Plan ft</th><th class="num">Actual ft</th></tr>${rows}</table>` : ''}`;
  if (t.sloped > 0) {
    mOut.innerHTML = `<table><tr><th>Material</th><th class="num">Qty</th><th>Basis</th></tr>${computeMaterials(t).map((i) => `<tr><td>${i.name}</td><td class="num"><b>${i.qty}</b> ${i.unit}</td><td class="muted small">${i.basis}</td></tr>`).join('')}</table>`;
  } else mOut.innerHTML = '';
}
function setDefaultPitch(p) { state.defaultPitch = p; $('#defaultPitch').value = String(p); recompute(); }

// ------------------------------------------------------------------ serialize / save
function serialize() {
  return {
    app: 'roof-measure', version: 2, savedAt: new Date().toISOString(),
    jobName: state.jobName, address: state.address, location: state.location, defaultPitch: state.defaultPitch, waste: state.waste, mat: state.mat,
    facets: state.facets.map((f) => ({ name: f.name, pitch: f.pitch, twoStory: f.twoStory, twoLayer: f.twoLayer, excluded: f.excluded, azimuth: f.azimuth, path: pathToLiteral(f.shape) })),
    edges: state.edges.map((e) => ({ type: e.type, pitch: e.pitch, path: pathToLiteral(e.shape) })),
    solar: state.solar, otherSolar: state.otherSolar,
  };
}
function restore(d) {
  if (!map) { toast('Load the map first (save your API key), then import.', true); return; }
  clearAll();
  state.jobName = d.jobName || ''; $('#jobName').value = state.jobName;
  if (d.location) setLocation(d.location, d.address);
  if (d.defaultPitch != null) setDefaultPitch(d.defaultPitch);
  if (d.waste != null) { state.waste = d.waste; $('#waste').value = String(d.waste); }
  if (d.mat) { Object.assign(state.mat, d.mat); for (const k of Object.keys(state.mat)) { const el = $('#m_' + k); if (el) el.value = state.mat[k]; } }
  for (const f of d.facets || []) addFacet(f.path, f.pitch, f.name, f);
  for (const e of d.edges || []) addEdge(EDGE_TYPES[e.type] ? e.type : 'unspecified', e.path, e.pitch);
  state.solar = d.solar || null; state.otherSolar = d.otherSolar || [];
  drawSolar(); renderSolar(); $('#btnAuto').disabled = !state.solar;
  recompute();
  if (state.facets.length) { const b = new google.maps.LatLngBounds(); state.facets.forEach((f) => f.shape.getPath().forEach((p) => b.extend(p))); map.fitBounds(b, 80); }
}
function savedProjects() { return JSON.parse(localStorage.getItem('rm.projects') || '{}'); }
function renderSaved() {
  const all = savedProjects();
  const names = Object.keys(all).sort((a, b) => (all[b].savedAt || '').localeCompare(all[a].savedAt || ''));
  $('#savedList').innerHTML = names.length ? names.map((n) => `<div class="item" data-name="${esc(n)}"><span class="name">${esc(n)}</span><span class="meta">${all[n].facets.length} facets &middot; ${new Date(all[n].savedAt).toLocaleDateString()}</span><button data-del="1" title="Delete">&times;</button></div>`).join('') : '<div class="empty">Nothing saved yet.</div>';
  document.querySelectorAll('#savedList .item').forEach((it) => {
    it.onclick = (ev) => {
      const n = it.dataset.name;
      if (ev.target.dataset.del) { if (confirm(`Delete saved roof "${n}"?`)) { const a = savedProjects(); delete a[n]; localStorage.setItem('rm.projects', JSON.stringify(a)); renderSaved(); } return; }
      restore(savedProjects()[n]); toast(`Loaded "${n}"`);
    };
  });
}
function saveProject() {
  const name = (state.jobName || state.address || '').trim() || prompt('Name this roof:');
  if (!name) return;
  const all = savedProjects(); all[name] = serialize();
  try { localStorage.setItem('rm.projects', JSON.stringify(all)); renderSaved(); toast(`Saved "${name}"`); }
  catch (e) { toast('Could not save (browser storage full). Use Export JSON instead.', true); }
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function fileBase() { return ((state.jobName || state.address || 'roof').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_')) || 'roof'; }
function exportCSV() {
  const t = computeTotals();
  const L = [];
  L.push(['Roof Measure export', state.jobName, state.address, new Date().toLocaleString()].map(csv).join(','));
  L.push('');
  L.push('Facet,Structure,Pitch,Plan sq ft,Roof sq ft,Perimeter ft,Corners,Two story,Two layer,Excluded');
  for (const { f, m } of t.facetsAll) L.push([f.name, structureOf(t, f.id), pitchLabel(f.pitch), m.plan.toFixed(1), m.sloped.toFixed(1), m.perimeterFt.toFixed(1), m.path.length, f.twoStory ? 'yes' : '', f.twoLayer ? 'yes' : '', f.excluded ? 'yes' : ''].map(csv).join(','));
  L.push(['TOTAL', '', `${t.weightedPitch.toFixed(1)}/12 avg`, t.plan.toFixed(1), t.sloped.toFixed(1), '', '', '', '', ''].join(','));
  L.push('');
  L.push('Line,Type,Pitch used,Plan ft,Actual ft,Segments');
  t.edges.forEach(({ e, m }, i) => L.push([i + 1, EDGE_TYPES[e.type].label, pitchLabel(m.pitch), m.planFt.toFixed(1), m.trueFt.toFixed(1), m.path.length - 1].map(csv).join(',')));
  L.push('');
  L.push('Line type,Total plan ft,Total actual ft');
  for (const [k, v] of Object.entries(EDGE_TYPES)) if (t.byType[k].count) L.push([v.plural, t.byType[k].plan.toFixed(1), t.byType[k].true.toFixed(1)].join(','));
  L.push('');
  L.push('Structure,Facets,Roof sq ft,Predominant pitch');
  for (const s of t.structures) L.push([`Structure #${s.index}`, s.facetCount, s.sloped.toFixed(1), s.predominant == null ? '' : pitchLabel(s.predominant)].join(','));
  L.push('');
  L.push(`Squares,${t.squares.toFixed(2)}`); L.push(`Waste %,${state.waste}`); L.push(`Squares with waste,${t.squaresWaste.toFixed(2)}`);
  L.push('');
  L.push('Material,Qty,Unit,Basis');
  for (const i of computeMaterials(t)) L.push([i.name, i.qty, i.unit, i.basis].map(csv).join(','));
  download(fileBase() + '_measurements.csv', L.join('\r\n'), 'text/csv');
}
function csv(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

// ------------------------------------------------------------------ UI wiring
function wire() {
  const ps = $('#defaultPitch');
  ps.innerHTML = PITCH_OPTIONS.map((p) => `<option value="${p}" ${p === state.defaultPitch ? 'selected' : ''}>${pitchLabel(p)}</option>`).join('');
  ps.onchange = (e) => setDefaultPitch(+e.target.value);
  $('#btnApplyPitch').onclick = () => { state.facets.forEach((f) => { f.pitch = state.defaultPitch; }); recompute(); };

  $('#apiKey').value = state.key;
  $('#btnSaveKey').onclick = () => {
    const k = $('#apiKey').value.trim();
    if (!k) return;
    localStorage.setItem('rm.key', k);
    if (state.key === k && mapsRequested) { toast('Key saved'); return; }
    if (mapsRequested) { location.reload(); return; }
    state.key = k; loadMaps();
  };
  $('#apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSaveKey').click(); });
  $('#btnShowKey').onclick = () => { const i = $('#apiKey'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('#btnShowKey').textContent = show ? 'Hide' : 'Show'; };
  $('#btnCopyKey').onclick = async () => { const v = $('#apiKey').value.trim(); if (!v) { toast('No key saved yet', true); return; } try { await navigator.clipboard.writeText(v); toast('API key copied'); } catch (e) { $('#apiKey').type = 'text'; $('#apiKey').select(); toast('Press Ctrl+C to copy'); } };
  $('#btnGo').onclick = goToAddress;
  $('#address').addEventListener('keydown', (e) => { if (e.key === 'Enter') goToAddress(); });
  $('#btnSolar').onclick = runSolar;
  $('#btnScan').onclick = scanStructures;
  $('#btnAuto').onclick = async () => { const b = $('#btnAuto'); b.disabled = true; b.textContent = 'Tracing...'; try { await autoTraceRoof(); } catch (e) { toast('Auto-trace failed: ' + e.message, true); } b.disabled = false; b.textContent = 'Auto-trace roof'; };
  $('#chkSolar').onchange = (e) => { state.showSolar = e.target.checked; drawSolar(); recompute(); };
  $('#chkFacetEdges').onchange = (e) => { state.showFacetEdges = e.target.checked; recompute(); };
  $('#waste').onchange = (e) => { state.waste = +e.target.value; recompute(); };
  for (const k of Object.keys(state.mat)) {
    const el = $('#m_' + k); if (!el) continue;
    el.value = state.mat[k];
    el.onchange = () => { state.mat[k] = +el.value || state.mat[k]; recompute(); };
  }
  $('#jobName').oninput = (e) => { state.jobName = e.target.value; };
  $('#btnNew').onclick = () => { if (!state.facets.length && !state.edges.length || confirm('Clear all facets, lines and Solar data?')) clearAll(); };

  document.querySelectorAll('#toolbar .tool[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  $('#btnFinish').onclick = finishDraft;
  $('#btnUndo').onclick = undoPoint;
  $('#btnDelete').onclick = () => { if (state.selected) removeItem(state.selected.kind, state.selected.id); };

  $('#btnCSV').onclick = exportCSV;
  $('#btnJSON').onclick = () => download(fileBase() + '_roof.json', JSON.stringify(serialize(), null, 2), 'application/json');
  $('#fileJSON').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { const d = JSON.parse(rd.result); if (d.app !== 'roof-measure') throw new Error('Not a Roof Measure file'); restore(d); toast('Imported'); } catch (err) { toast('Import failed: ' + err.message, true); } };
    rd.readAsText(f); e.target.value = '';
  };
  $('#btnSave').onclick = saveProject;
  renderSaved();

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Enter') { finishDraft(); e.preventDefault(); }
    else if (e.key === 'Escape') { if (draft) cancelDraft(); else if (state.selected) select(null); else setTool('select'); }
    else if (e.key === 'Backspace') { if (draft) { undoPoint(); e.preventDefault(); } }
    else if (e.key === 'Delete') { if (state.selected) removeItem(state.selected.kind, state.selected.id); }
    else if (!e.ctrlKey && !e.metaKey && TOOL_KEYS[e.key.toLowerCase()]) setTool(TOOL_KEYS[e.key.toLowerCase()]);
  });
  window.addEventListener('afterprint', () => { $('#report').innerHTML = ''; });
}

wire();
if (state.key) loadMaps();
