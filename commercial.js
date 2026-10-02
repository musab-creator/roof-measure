'use strict';
/* commercial.js - Commercial (low-slope / flat) roof mode.
 *
 * Measures a commercial building from Google's Solar API data layers (roof mask + digital surface model):
 *   - footprint outline squared to the building axes, courtyards kept as holes
 *   - roof sections by elevation (multi-level roofs), slope in inches per foot, steep-slope sections flagged
 *   - every perimeter edge classified as parapet wall (with its height) or open roof edge (edge metal / gutter)
 *   - interior walls between roof levels (with height) and level joints
 *   - rooftop units, vents / exhaust fans and other raised objects, with sizes and curb flashing length
 *   - building height, ASCE 7 roof wind-zone areas, drain estimate
 *   - a full low-slope material estimate (TPO, PVC, EPDM, SBS modified bitumen, silicone coating)
 * and builds its own multi-page commercial report.
 *
 * Uses globals from app.js (state, $, esc, fmt, toast, fetchSolar, download, fileBase, map), autotrace.js (loadTiff,
 * regionOuterLoop, dpSimplify, dominantAngle), autotrace2.js (localPlanes, growRegions, mergeRegions, fillHoles,
 * PlaneAcc) and report.js (REPORT_CSS, company, esc, imageToDataURL, BLUE).
 */

const COM = {
  maxRadius: 250,          // data layers radius limit at 0.25 m pixels (m)
  sectionMinM2: 25,        // smaller planar pieces are not roof sections
  sectionMinFrac: 0.01,
  levelMergeM: 0.2,        // adjacent flat pieces closer than this in height are one roof level
  wallMinM: 0.3,           // height step that counts as a wall between levels
  parapetMinM: 0.3,        // raised perimeter that counts as a parapet wall (12")
  parapetMaxM: 2.45,       // taller perimeter walls are walls of a higher roof part / screen walls (8 ft)
  objMinH: 0.3,            // rooftop object: at least this high above the roof surface
  objMinM2: 0.12,
  bandM: 1.0,              // parapet band excluded from rooftop object search
  steepSlope: 2 / 12,      // ASTM / FBC: low-slope roofs are below 2:12
};
const SQFT = 10.7639104, FT = 3.28084;

// ------------------------------------------------------------------ materials knowledge (coverage / counts)
// Values are typical manufacturer data; every quantity can be overridden in the panel. See README for sources.
const COM_RULES = {
  // single-ply rolls (Carlisle / GAF data sheets): 10' x 100' = 1,000 sqft; 5.5" side laps leave ~9.54 ft net width
  rollSqft: { tpo: 1000, pvc: 1000, epdm: 1000 },
  rollNetWidthFt: { tpo: 9.54, pvc: 9.54, epdm: 9.75 },
  halfSheetFt: 5,                                          // perimeter half-sheets (GAF 5' x 100'; Carlisle 6')
  boardSqft: 32,                                           // 4' x 8' polyiso / cover board
  insulFastPerBoard: { field: 8, perimeter: 12, corner: 14 },  // JM / FM: perimeter = field + 50%, corner = field + 75%
  cover: { name: '1/2" HD polyiso cover board 4\' x 8\' (R-2.5)', r: 2.5 },
  seamFastSpacingIn: { field: 12, perimeter: 6 },          // Carlisle MF spec: 6"-12" o.c. in the seam
  adhesiveSqftPerGal: 60,                                  // Sure-Weld / 90-8-30A bonding adhesive, finished surface
  adhesivePail: 5,
  wallFlashExtraFt: 1.0,                                   // membrane up the parapet and over the top under the coping
  curbFlashFt: 1.5,                                        // 8"-14" curb + 6" base flange
  wallStepFlashMaxFt: 3,
  tJointPerRoll: 2, cutEdgeLfPerBottle: 225, epdmPrimerSqftPerGal: 250, seamTapeRollFt: 100,
  termBarFt: 10, copingFt: 12, edgeMetalFt: 10,            // Metal-Era coping 12'; fascia / gravel stop 10'
  walkPadsPerRtu: 4,                                       // 30" x 30" pads on the service side
  drainSqft: 5600,                                         // drains ~75 ft apart (RIEI); 4" drain ~4,000 sqft at 4.3 in/hr
  rainInHr: 4.3,                                           // Jacksonville 100-yr 1-hr (FBC-P Fig. 1106.1 table); NOAA Atlas 14 gives 5.6
  modbit: { baseSqftPerRoll: 150, capSqftPerRoll: 96, primerSqftPerGal: 100, flashSqftPerRoll: 96 },   // Ruberoid 20 = 1.5 sq; cap 1 sq gross 107.6
  silicone: { galPerSq: 1.5, galPerSqGranulated: 2.0, primerGalPerSq: 0.5, fabricRollFt: 300, pail: 5 }, // GacoFlex S20 PDS
  polyisoR: [[1.0, 5.6], [1.5, 8.6], [2.0, 11.4], [2.2, 12.6], [2.5, 14.4], [2.6, 15.0], [3.0, 17.4], [3.5, 20.5], [4.0, 23.6]],
  energyR: 25,                                             // FBC-EC 2023 Table C402.1.3, climate zone 2A: R-25ci above deck
  wasteDefault: { tpo: 10, pvc: 10, epdm: 10, modbit: 12, silicone: 10, insulation: 5 },
};
const COM_SYSTEMS = {
  tpo_ma: { name: 'TPO 60 mil, mechanically attached', mem: 'tpo', attach: 'ma' },
  tpo_fa: { name: 'TPO 60 mil, fully adhered', mem: 'tpo', attach: 'fa' },
  pvc_ma: { name: 'PVC 60 mil, mechanically attached', mem: 'pvc', attach: 'ma' },
  epdm_fa: { name: 'EPDM 60 mil, fully adhered', mem: 'epdm', attach: 'fa' },
  modbit: { name: 'SBS modified bitumen, 2-ply (base + granulated cap)', mem: 'modbit' },
  silicone: { name: 'Silicone roof coating (restoration over existing)', mem: 'silicone' },
};

const com = {
  model: null, shapes: [],
  opts: JSON.parse(localStorage.getItem('rm.comOpts') || 'null') || { system: 'tpo_ma', waste: 10, rTarget: 25, cover: true, taper: false, drains: '', scuppers: '', skylights: '', hatches: '', heightFt: '', windMph: 130 },
};
const saveComOpts = () => localStorage.setItem('rm.comOpts', JSON.stringify(com.opts));

// ------------------------------------------------------------------ data
async function comDataLayers(lat, lng, radius, px) {
  const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat.toFixed(7)}&location.longitude=${lng.toFixed(7)}&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=BASE&exactQualityRequired=false&pixelSizeMeters=${px}&key=${encodeURIComponent(state.key)}`;
  const r = await fetch(url);
  if (!r.ok) { let m = 'HTTP ' + r.status; try { const j = await r.json(); m = (j.error && j.error.message) || m; } catch (_) { /* ignore */ } const e = new Error('Data layers: ' + m); e.status = r.status; throw e; }
  return r.json();
}
// Solar API: any radius up to 100 m at 0.1 m pixels; above 100 m the radius must be <= pixelSize x 1000
const pxFor = (radius) => (radius <= 100 ? 0.1 : radius <= 250 ? 0.25 : 0.5);
async function comLoadRasters(lat, lng, radius) {
  let px = pxFor(radius), lastErr = null;
  for (const tryPx of [px, 0.25, 0.5, 1].filter((v, i, a) => v >= px && a.indexOf(v) === i)) {
    const tag = `_ccache_${lat.toFixed(6)}_${lng.toFixed(6)}_${radius}_${tryPx}`.replace(/[^A-Za-z0-9_]/g, '_');
    const cache = (window.__comCache = window.__comCache || {});
    if (cache[tag]) return cache[tag];
    try {
      let mT = null, dT = null, layers = null;
      if (location.hostname === 'localhost') {
        try { if ((await fetch('/reports/' + tag + '_mask.tif')).ok) { mT = await loadTiff('x', tag + '_mask.tif'); dT = await loadTiff('x', tag + '_dsm.tif'); const j = await fetch('/reports/' + tag + '_meta.json'); layers = j.ok ? await j.json() : {}; } } catch (_) { mT = null; }
      }
      if (!mT) {
        layers = await comDataLayers(lat, lng, radius, tryPx);
        if (!layers.maskUrl || !layers.dsmUrl) throw new Error('No roof mask / surface model here');
        [mT, dT] = await Promise.all([loadTiff(layers.maskUrl, tag + '_mask.tif'), loadTiff(layers.dsmUrl, tag + '_dsm.tif')]);
        if (location.hostname === 'localhost') fetch('/save?name=' + encodeURIComponent(tag + '_meta.json'), { method: 'POST', body: JSON.stringify({ imageryDate: layers.imageryDate, imageryQuality: layers.imageryQuality }) }).catch(() => null);
      }
      const out = { mT, dT, px: tryPx, radius, imageryDate: layers.imageryDate, quality: layers.imageryQuality };
      cache[tag] = out; return out;
    } catch (e) { lastErr = e; if (e.status && e.status !== 400) throw e; }
  }
  throw lastErr || new Error('Data layers unavailable');
}
const ymd = (d) => (d && d.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);

// ------------------------------------------------------------------ measuring
// target: {lat,lng}; opts.footprint optional [[lat,lng]...] (batch testing only, to size the request)
async function comMeasure(target, opts = {}) {
  const t0 = performance.now();
  let lat = target.lat, lng = target.lng, half = 35, bi = null;
  try { bi = await fetchSolar(lat, lng); } catch (_) { bi = null; }
  const kx0 = 111320 * Math.cos(lat * Math.PI / 180), ky0 = 110540;
  if (bi && bi.boundingBox) {
    const bb = bi.boundingBox; const cLat = (bb.sw.latitude + bb.ne.latitude) / 2, cLng = (bb.sw.longitude + bb.ne.longitude) / 2;
    const off = Math.hypot((cLng - lng) * kx0, (cLat - lat) * ky0);
    const hd = Math.hypot((bb.ne.longitude - bb.sw.longitude) * kx0, (bb.ne.latitude - bb.sw.latitude) * ky0) / 2;
    if (off < hd + 25) { lat = cLat; lng = cLng; half = Math.max(half, hd); }
  }
  if (opts.footprint && opts.footprint.length) {
    const la = opts.footprint.map((p) => p[0]), lo = opts.footprint.map((p) => p[1]);
    lat = (Math.min(...la) + Math.max(...la)) / 2; lng = (Math.min(...lo) + Math.max(...lo)) / 2;
    half = Math.hypot((Math.max(...lo) - Math.min(...lo)) * kx0, (Math.max(...la) - Math.min(...la)) * ky0) / 2;
  }
  let radius = Math.min(COM.maxRadius, Math.max(25, Math.ceil(half + 12)));
  let R = null, M = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    R = await comLoadRasters(lat, lng, radius);
    M = comAnalyse(R, lat, lng, bi, target);
    if (!M.touchesBorder || radius >= COM.maxRadius) break;
    // the roof runs off the downloaded area: re-centre on what we found and ask for a bigger area
    const xs = M.outline.map((p) => p[0]), ys = M.outline.map((p) => p[1]); const c = M.toLL([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    lat = c.lat; lng = c.lng; radius = Math.min(COM.maxRadius, Math.ceil(radius * 1.7));
  }
  M.radius = radius; M.px = R.px; M.imageryDate = ymd(R.imageryDate) || (bi && ymd(bi.imageryDate)); M.quality = R.quality || (bi && bi.imageryQuality);
  M.solarName = bi ? bi.name : null; M.ms = Math.round(performance.now() - t0);
  return M;
}

function comAnalyse(R, cLat, cLng, bi, target) {
  const { mT, dT, px } = R; const w = mT.w, h = mT.h, N = w * h; const dsm = dT.data;
  const kx = 111320 * Math.cos(cLat * Math.PI / 180), ky = 110540;
  const Ecol = new Float64Array(w + 1), Nrow = new Float64Array(h + 1);
  for (let x = 0; x <= w; x++) Ecol[x] = (mT.toLL(x, 0).lng - cLng) * kx;
  for (let y = 0; y <= h; y++) Nrow[y] = (mT.toLL(0, y).lat - cLat) * ky;
  const geo = {
    ref: { lat: cLat, lng: cLng, kx, ky },
    E: (x) => { const i = Math.max(0, Math.min(w - 1, Math.floor(x))); const f = x - i; return Ecol[i] + f * (Ecol[i + 1] - Ecol[i]); },
    N: (y) => { const i = Math.max(0, Math.min(h - 1, Math.floor(y))); const f = y - i; return Nrow[i] + f * (Nrow[i + 1] - Nrow[i]); },
    X: (E) => (E - Ecol[0]) / (Ecol[w] - Ecol[0]) * w, Y: (Nm) => (Nm - Nrow[0]) / (Nrow[h] - Nrow[0]) * h,
    pxM2: Math.abs((Ecol[1] - Ecol[0]) * (Nrow[1] - Nrow[0])),
  };
  const pxM = Math.sqrt(geo.pxM2);
  const toLL = (p) => ({ lat: cLat + p[1] / ky, lng: cLng + p[0] / kx });
  const mask = new Uint8Array(N); for (let i = 0; i < N; i++) mask[i] = mT.data[i] > 0 ? 1 : 0;
  // ---- connected roof pieces
  const lab = new Int32Array(N).fill(-1); const comps = []; const q = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i] || lab[i] >= 0) continue; const id = comps.length; let hd = 0, tl = 0; q[tl++] = i; lab[i] = id; let x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (hd < tl) { const j = q[hd++]; const x = j % w, y = (j - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[j - 1] && lab[j - 1] < 0) { lab[j - 1] = id; q[tl++] = j - 1; } if (x < w - 1 && mask[j + 1] && lab[j + 1] < 0) { lab[j + 1] = id; q[tl++] = j + 1; }
      if (y > 0 && mask[j - w] && lab[j - w] < 0) { lab[j - w] = id; q[tl++] = j - w; } if (y < h - 1 && mask[j + w] && lab[j + w] < 0) { lab[j + w] = id; q[tl++] = j + w; } }
    comps.push({ id, n: tl, bbox: [x0, y0, x1, y1], inBox: 0, dPin: Infinity });
  }
  if (!comps.length) throw new Error('Google has no roof data at this spot (the building may be newer than the imagery). Measure it by hand on the Residential tab.');
  // ---- pick the building: overlap with Google's building box, else the piece under / nearest the pin
  const pin = [(target.lng - cLng) * kx, (target.lat - cLat) * ky];
  let box = null;
  if (bi && bi.boundingBox) { const bb = bi.boundingBox; box = [(bb.sw.longitude - cLng) * kx - 2, (bb.ne.longitude - cLng) * kx + 2, (bb.sw.latitude - cLat) * ky - 2, (bb.ne.latitude - cLat) * ky + 2]; }
  const step = Math.max(1, Math.round(0.5 / pxM));
  for (let y = 0; y < h; y += step) { const Nm = geo.N(y + 0.5); for (let x = 0; x < w; x += step) { const i = y * w + x; if (lab[i] < 0) continue; const c = comps[lab[i]]; const Em = geo.E(x + 0.5);
    if (box && Em >= box[0] && Em <= box[1] && Nm >= box[2] && Nm <= box[3]) c.inBox++; const d = Math.hypot(Em - pin[0], Nm - pin[1]); if (d < c.dPin) c.dPin = d; } }
  const minN = 40 / geo.pxM2;
  let main = null;
  const underPin = comps.filter((c) => c.dPin < 1.5 && c.n >= minN).sort((a, b) => b.n - a.n)[0];
  if (underPin) main = underPin;
  else if (box) main = comps.filter((c) => c.inBox > 0).sort((a, b) => b.inBox - a.inBox)[0] || null;
  if (!main) main = comps.filter((c) => c.n >= minN && c.dPin < 40).sort((a, b) => a.dPin - b.dPin)[0];
  if (!main) throw new Error('No commercial-size roof near this location');
  const touchesBorder = main.bbox[0] <= 1 || main.bbox[1] <= 1 || main.bbox[2] >= w - 2 || main.bbox[3] >= h - 2;
  const member = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i] === main.id) member[i] = 1;
  // ---- ground and holes (courtyards stay open, unmasked equipment / skylights inside the roof are filled)
  const outside = new Uint8Array(N); { let hd = 0, tl = 0; for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (!member[i] && !outside[i]) { outside[i] = 1; q[tl++] = i; } } for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (!member[i] && !outside[i]) { outside[i] = 1; q[tl++] = i; } }
    while (hd < tl) { const j = q[hd++]; const x = j % w; for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (k < 0 || k >= N || member[k] || outside[k]) continue; outside[k] = 1; q[tl++] = k; } } }
  const gv = []; for (let i = 0; i < N; i += 11) if (outside[i] && !mask[i] && dsm[i] > -1000) gv.push(dsm[i]); gv.sort((a, b) => a - b);
  const groundZ = gv.length ? gv[Math.floor(gv.length * 0.1)] : null;
  const holeLab = new Int32Array(N).fill(-1); const holes = [];
  for (let i = 0; i < N; i++) {
    if (member[i] || outside[i] || holeLab[i] >= 0) continue; const id = holes.length; let hd = 0, tl = 0; q[tl++] = i; holeLab[i] = id; const zs = [];
    while (hd < tl) { const j = q[hd++]; if (dsm[j] > -1000) zs.push(dsm[j]); const x = j % w; for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (k < 0 || k >= N || member[k] || outside[k] || holeLab[k] >= 0) continue; holeLab[k] = id; q[tl++] = k; } }
    zs.sort((a, b) => a - b); holes.push({ id, n: tl, z: zs.length ? zs[zs.length >> 1] : null });
  }
  const openHole = new Set(holes.filter((hl) => hl.n * geo.pxM2 >= 12 && groundZ != null && hl.z != null && hl.z < groundZ + 1.5).map((hl) => hl.id));
  for (let i = 0; i < N; i++) if (holeLab[i] >= 0 && !openHole.has(holeLab[i])) member[i] = 1;
  let memberN = 0; for (let i = 0; i < N; i++) memberN += member[i];
  // ---- outline: trace, simplify, square to the building axes
  const reg = new Int32Array(N).fill(-1); for (let i = 0; i < N; i++) if (member[i]) reg[i] = 0;
  const loop = regionOuterLoop(reg, w, h, 0);
  const P = loop.map((e) => [geo.E(e.a[0]), geo.N(e.a[1])]);
  const simp = comDpRing(P, Math.max(0.3, pxM * 3));
  const theta = (() => { const a = dominantAngle([simp.concat([simp[0]])]); return Number.isFinite(a) ? a : 0; })();
  let outline = comSquare(P, simp, theta);
  if (comArea(outline) < 0) outline.reverse();
  const courtyards = [];
  for (const hl of holes) if (openHole.has(hl.id)) {
    const hreg = new Int32Array(N).fill(-1); for (let i = 0; i < N; i++) if (holeLab[i] === hl.id) hreg[i] = 0;
    const lp2 = regionOuterLoop(hreg, w, h, 0); if (lp2.length < 8) continue;
    const pts = comDpRing(lp2.map((e) => [geo.E(e.a[0]), geo.N(e.a[1])]), Math.max(0.3, pxM * 3)); if (pts.length >= 3) courtyards.push(pts);
  }
  const planM2 = Math.abs(comArea(outline)) - courtyards.reduce((s, c) => s + Math.abs(comArea(c)), 0);
  // ---- roof sections on a coarse grid (plane fits + region growing from autotrace2.js)
  const cellM = Math.max(0.3, Math.sqrt(memberN * geo.pxM2 / 220000)); const k = Math.max(1, Math.round(cellM / pxM));
  const cw = Math.ceil(w / k), chh = Math.ceil(h / k), CN = cw * chh;
  const cmem = new Uint8Array(CN), cz = new Float32Array(CN).fill(-9999);
  { const buf = []; for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) { buf.length = 0; let n = 0;
      for (let y = cy * k; y < Math.min(h, cy * k + k); y++) for (let x = cx * k; x < Math.min(w, cx * k + k); x++) { const i = y * w + x; if (!member[i]) continue; n++; if (dsm[i] > -1000) buf.push(dsm[i]); }
      if (n * 2 >= k * k && buf.length) { buf.sort((a, b) => a - b); const ci = cy * cw + cx; cmem[ci] = 1; cz[ci] = buf[Math.floor(buf.length * 0.3)]; } } }
  const cgeo = { ref: geo.ref, E: (x) => geo.E(Math.min(w, x * k)), N: (y) => geo.N(Math.min(h, y * k)), X: (E) => geo.X(E) / k, Y: (Nm) => geo.Y(Nm) / k, pxM2: geo.pxM2 * k * k };
  const lp = localPlanes(cz, cmem, cw, chh, cgeo);
  let { label: clab, regions } = growRegions(cz, cmem, cw, chh, lp, cgeo);
  clab = mergeRegions(cz, clab, regions, cw, chh, lp, cgeo);
  clab = fillHoles(cz, clab, cmem, cw, chh, regions, lp);
  const cellM2 = cgeo.pxM2;
  const cnt = new Map(); for (let i = 0; i < CN; i++) if (cmem[i] && clab[i] >= 0) cnt.set(clab[i], (cnt.get(clab[i]) || 0) + 1);
  const minSec = Math.max(COM.sectionMinM2, COM.sectionMinFrac * memberN * geo.pxM2);
  let secIds = [...cnt.entries()].filter(([, n]) => n * cellM2 >= minSec).map(([l]) => l);
  if (!secIds.length && cnt.size) secIds = [[...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  if (!secIds.length) {   // no planar region at all (very noisy surface): treat the whole roof as one section
    const id = regions.length; const acc = new PlaneAcc();
    for (let i = 0; i < CN; i++) if (cmem[i] && cz[i] > -1000) { clab[i] = id; acc.add(cgeo.E((i % cw) + 0.5), cgeo.N(Math.floor(i / cw) + 0.5), cz[i]); }
    const pl = acc.solve(); if (!pl) throw new Error('The roof surface could not be read from Google\'s height model here.');
    regions.push({ id, n: CN, plane: pl, acc }); secIds = [id];
  }
  // every roof cell belongs to the nearest section
  const sec = new Int32Array(CN).fill(-1); { const set = new Set(secIds); let hd = 0, tl = 0; const cq = new Int32Array(CN);
    for (let i = 0; i < CN; i++) if (cmem[i] && set.has(clab[i])) { sec[i] = clab[i]; cq[tl++] = i; }
    while (hd < tl) { const j = cq[hd++]; const x = j % cw; for (const kk of [x > 0 ? j - 1 : -1, x < cw - 1 ? j + 1 : -1, j - cw, j + cw]) { if (kk < 0 || kk >= CN || !cmem[kk] || sec[kk] >= 0) continue; sec[kk] = sec[j]; cq[tl++] = kk; } } }
  const ccx = (i) => cgeo.E((i % cw) + 0.5), ccy = (i) => cgeo.N(Math.floor(i / cw) + 0.5);
  const fitPlane = (ids) => { const set = new Set(ids); let pl = null; for (let pass = 0; pass < 2; pass++) { const acc = new PlaneAcc(); for (let i = 0; i < CN; i++) { if (!set.has(sec[i]) || cz[i] < -1000) continue; const E = ccx(i), Nm = ccy(i); if (pl && Math.abs(cz[i] - (pl.a * E + pl.b * Nm + pl.c)) > 0.25) continue; acc.add(E, Nm, cz[i]); } pl = acc.solve() || pl; } return pl; };
  // merge neighbouring sections that are really one roof level
  const pairStats = () => { const m = new Map(); const add = (i, j) => { const a = sec[i], b = sec[j]; if (a < 0 || b < 0 || a === b || cz[i] < -1000 || cz[j] < -1000) return; const key = a < b ? a + ',' + b : b + ',' + a; let s = m.get(key); if (!s) { s = { a: Math.min(a, b), b: Math.max(a, b), n: 0, d: [], pts: [] }; m.set(key, s); } s.n++; if (s.d.length < 3000) s.d.push(a < b ? cz[i] - cz[j] : cz[j] - cz[i]); if (s.pts.length < 3000) s.pts.push(i); };
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) { const i = y * cw + x; if (x < cw - 1) add(i, i + 1); if (y < chh - 1) add(i, i + cw); } return m; };
  let planes = new Map(secIds.map((s) => [s, fitPlane([s])]));
  for (let it = 0; it < 40; it++) {
    const ps = pairStats(); let merged = false;
    for (const s of ps.values()) {
      const A = planes.get(s.a), B = planes.get(s.b); if (!A || !B) continue; const d = s.d.slice().sort((p, r) => p - r); const med = d[d.length >> 1];
      const flat = Math.hypot(A.a, A.b) < COM.steepSlope && Math.hypot(B.a, B.b) < COM.steepSlope;
      if (flat && Math.abs(med) < COM.levelMergeM && angleBetween(A.a, A.b, B.a, B.b) < 3) { for (let i = 0; i < CN; i++) if (sec[i] === s.b) sec[i] = s.a; planes.delete(s.b); planes.set(s.a, fitPlane([s.a])); merged = true; break; }
    }
    if (!merged) break;
  }
  // ---- section records
  const sids = [...planes.keys()];
  const fullCount = new Map(); { for (let y = 0; y < h; y++) { const cy = Math.floor(y / k); for (let x = 0; x < w; x++) { const i = y * w + x; if (!member[i]) continue; const s = sec[cy * cw + Math.floor(x / k)]; fullCount.set(s, (fullCount.get(s) || 0) + 1); } } }
  // pixels whose cell has no section (thin edges) go to the largest section
  const unassigned = fullCount.get(-1) || 0; fullCount.delete(-1);
  let sections = sids.map((s) => {
    const pl = planes.get(s); const slope = pl ? Math.hypot(pl.a, pl.b) : 0; const zs = []; for (let i = 0; i < CN; i++) if (sec[i] === s && cz[i] > -1000 && zs.length < 20000) zs.push(cz[i]); zs.sort((a, b) => a - b);
    return { sid: s, plane: pl, slope, areaM2: (fullCount.get(s) || 0) * geo.pxM2, elevM: groundZ != null && zs.length ? zs[zs.length >> 1] - groundZ : null, z: zs.length ? zs[zs.length >> 1] : null, steep: slope >= COM.steepSlope, azimuth: slope > 0.005 ? ((Math.atan2(-pl.a, -pl.b) * 180 / Math.PI) + 360) % 360 : null };
  }).filter((s) => s.areaM2 > 0).sort((a, b) => b.areaM2 - a.areaM2);
  if (sections.length && unassigned) sections[0].areaM2 += unassigned * geo.pxM2;
  // scale pixel areas to the squared outline area so the sections add up to the measured roof
  const pixArea = sections.reduce((s, x) => s + x.areaM2, 0); const scale = pixArea > 0 ? planM2 / pixArea : 1;
  sections.forEach((s, i) => { s.areaM2 *= scale; s.letter = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); s.slopedM2 = s.areaM2 * Math.sqrt(1 + s.slope * s.slope); });
  const letterOf = new Map(sections.map((s) => [s.sid, s.letter]));
  // label point (deepest cell) and outline for each section
  { const dist = new Int32Array(CN).fill(-1); let hd = 0, tl = 0; const cq = new Int32Array(CN);
    for (let i = 0; i < CN; i++) { if (sec[i] < 0) continue; const x = i % cw; const nb = [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i - cw, i + cw]; if (nb.some((kk) => kk < 0 || kk >= CN || sec[kk] !== sec[i])) { dist[i] = 0; cq[tl++] = i; } }
    while (hd < tl) { const j = cq[hd++]; const x = j % cw; for (const kk of [x > 0 ? j - 1 : -1, x < cw - 1 ? j + 1 : -1, j - cw, j + cw]) { if (kk < 0 || kk >= CN || sec[kk] !== sec[j] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; cq[tl++] = kk; } }
    const best = new Map(); for (let i = 0; i < CN; i++) { if (sec[i] < 0) continue; const b = best.get(sec[i]); if (!b || dist[i] > b.d) best.set(sec[i], { d: dist[i], i }); }
    for (const s of sections) { const b = best.get(s.sid); s.label = b ? [ccx(b.i), ccy(b.i)] : null; s.labelRoomM = b ? b.d * Math.sqrt(cellM2) : 0;
      const lp3 = regionOuterLoop(sec, cw, chh, s.sid); s.poly = lp3.length >= 4 ? comDpRing(lp3.map((e) => [cgeo.E(e.a[0]), cgeo.N(e.a[1])]), Math.max(0.5, Math.sqrt(cellM2) * 1.5)) : []; } }
  // ---- walls / joints between sections: boundary chains from the section raster, simplified to straight lines
  const walls = [];
  const lines = new Map(); {
    const topo = topology(sec, cw, chh); const W1 = topo.W1;
    for (const ch of topo.chains) { const [p, r] = ch.pair; if (p < 0 || r < 0) continue; const key = p < r ? p + ',' + r : r + ',' + p;
      const pts = ch.corners.map((c) => { const x = c % W1, y = (c - x) / W1; return [cgeo.E(x), cgeo.N(y)]; });
      const simp = dpSimplify(pts, Math.max(0.5, Math.sqrt(cellM2) * 1.5)); if (!lines.has(key)) lines.set(key, []); lines.get(key).push(simp); } }
  for (const s of pairStats().values()) {
    const A = sections.find((x) => x.sid === s.a), B = sections.find((x) => x.sid === s.b); if (!A || !B) continue;
    const d = s.d.slice().sort((p, r) => p - r); const med = d[d.length >> 1];
    const polys = lines.get(s.a + ',' + s.b) || []; const segs = []; let lenM = 0;
    for (const pl of polys) for (let i = 1; i < pl.length; i++) { segs.push([pl[i - 1], pl[i]]); lenM += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); }
    if (lenM < 1) continue;
    const kind = A.steep || B.steep ? 'transition' : Math.abs(med) >= COM.wallMinM ? 'wall' : 'joint';
    const mid = s.pts[s.pts.length >> 1];
    walls.push({ a: letterOf.get(s.a), b: letterOf.get(s.b), higher: med > 0 ? letterOf.get(s.a) : letterOf.get(s.b), heightM: Math.abs(med), lenM, kind, segs, mid: [ccx(mid), ccy(mid)] });
  }  // ---- per-pixel roof surface (section plane), parapet band, rooftop objects
  const planeOfPx = (i) => { const x = i % w, y = (i - x) / w; const s = sec[Math.floor(y / k) * cw + Math.floor(x / k)]; return s >= 0 ? planes.get(s) : null; };
  const band = new Uint8Array(N); { const D = Math.max(1, Math.round(COM.bandM / pxM)); const dist = new Int16Array(N).fill(-1); let hd = 0, tl = 0;
    for (let i = 0; i < N; i++) { if (!member[i]) continue; const x = i % w; const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]; if (nb.some((kk) => kk < 0 || kk >= N || !member[kk])) { dist[i] = 0; q[tl++] = i; band[i] = 1; } }
    while (hd < tl) { const j = q[hd++]; if (dist[j] >= D) continue; const x = j % w; for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !member[kk] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; band[kk] = 1; q[tl++] = kk; } } }
  // local roof surface: morphological opening (~4 m) of the coarse roof heights. Tapered insulation makes a 4-16" sawtooth
  // between drains, so one plane per section is not enough; the opening follows it but removes units up to ~3.5 m across.
  const base = (() => {
    const r = Math.max(1, Math.round(2.0 / Math.sqrt(cellM2))); const A = new Float32Array(CN), B = new Float32Array(CN);
    const pass = (src, dst, horiz, isMin) => { const fillV = isMin ? Infinity : -Infinity;
      for (let o = 0; o < (horiz ? chh : cw); o++) for (let t = 0; t < (horiz ? cw : chh); t++) { let m = fillV;
        for (let d = -r; d <= r; d++) { const tt = t + d; if (tt < 0 || tt >= (horiz ? cw : chh)) continue; const v = src[horiz ? o * cw + tt : tt * cw + o]; if (isMin ? v < m : v > m) m = v; }
        dst[horiz ? o * cw + t : t * cw + o] = m; } };
    const src = new Float32Array(CN); for (let i = 0; i < CN; i++) src[i] = cmem[i] && cz[i] > -1000 ? cz[i] : Infinity;
    pass(src, A, true, true); pass(A, B, false, true);                       // erosion
    for (let i = 0; i < CN; i++) if (!cmem[i] || !Number.isFinite(B[i])) B[i] = -Infinity;
    pass(B, A, true, false); pass(A, B, false, false);                       // dilation
    return B; })();
  const objMin = /HIGH/i.test(R.quality || 'HIGH') ? COM.objMinM2 : 0.3;      // MEDIUM / BASE imagery is ~0.25 m effective
  // keep the object search ~1 m away from steps between roof levels too (cells straddling a step read low)
  const stepBand = new Uint8Array(N); {
    const stepCell = new Uint8Array(CN);
    // only boundaries between roof sections at different heights (a height jump alone is also what a rooftop unit looks like)
    const secZ = new Map(); for (const [sid, pl] of planes) secZ.set(sid, pl);
    const zOf = (sid, i) => { const pl = secZ.get(sid); return pl ? pl.a * ccx(i) + pl.b * ccy(i) + pl.c : NaN; };
    for (let i = 0; i < CN; i++) { if (!cmem[i] || sec[i] < 0) continue; const x = i % cw; for (const j of [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i - cw, i + cw]) { if (j < 0 || j >= CN || !cmem[j] || sec[j] < 0 || sec[j] === sec[i]) continue; if (Math.abs(zOf(sec[i], i) - zOf(sec[j], i)) >= COM.wallMinM) { stepCell[i] = 1; break; } } }
    const D = Math.max(1, Math.round(COM.bandM / pxM)); const dist = new Int16Array(N).fill(-1); let hd = 0, tl = 0;
    for (let i = 0; i < N; i++) { if (!member[i]) continue; const x = i % w, y = (i - x) / w; if (stepCell[Math.floor(y / k) * cw + Math.floor(x / k)]) { dist[i] = 0; stepBand[i] = 1; q[tl++] = i; } }
    while (hd < tl) { const j = q[hd++]; if (dist[j] >= D) continue; const x = j % w; for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !member[kk] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; stepBand[kk] = 1; q[tl++] = kk; } }
  }
  const hAbove = new Float32Array(N); const cand = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!member[i] || band[i] || stepBand[i] || !(dsm[i] > -1000)) continue; const pl = planeOfPx(i); if (!pl || Math.hypot(pl.a, pl.b) >= COM.steepSlope) continue;
    const x = i % w, y = (i - x) / w; const ci = Math.floor(y / k) * cw + Math.floor(x / k); let b0 = base[ci];
    const zPl = pl.a * geo.E(x + 0.5) + pl.b * geo.N(y + 0.5) + pl.c;
    if (!Number.isFinite(b0)) b0 = zPl;
    // a narrow raised roof part that the opening erased sits on its own section plane: roof, not equipment
    const v = dsm[i] - b0; hAbove[i] = v; if (v > COM.objMinH && dsm[i] - Math.max(b0, zPl) > COM.objMinH * 0.5) cand[i] = 1;
  }
  const th = theta * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
  const objects = []; { const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!cand[i] || seen[i]) continue; let hd = 0, tl = 0; q[tl++] = i; seen[i] = 1; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; const hs = [];
      while (hd < tl) { const j = q[hd++]; const x = j % w, y = (j - x) / w; const E = geo.E(x + 0.5), Nm = geo.N(y + 0.5); const u = E * ct + Nm * st, v = -E * st + Nm * ct; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; if (hs.length < 5000) hs.push(hAbove[j]);
        for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !cand[kk] || seen[kk]) continue; seen[kk] = 1; q[tl++] = kk; } }
      const areaM2 = tl * geo.pxM2; if (areaM2 < objMin) continue;
      hs.sort((a, b) => a - b); const hM = hs[Math.floor(hs.length * 0.85)];
      const L = u1 - u0 + pxM, W = v1 - v0 + pxM; const fill = areaM2 / Math.max(1e-6, L * W); const lo = Math.max(L, W), sh = Math.min(L, W);
      let type;
      if (hM > 6 || (areaM2 > 25 && fill < 0.35 && hM > 1.5)) type = 'Obstruction / tree overhang';
      else if (areaM2 > 4 && fill < 0.35) type = 'Expansion joint / divider';     // long low raised lines between roof areas
      else if (lo / sh >= 4 && sh < 0.7 && areaM2 >= 0.3) type = 'Duct / pipe run';
      else if (areaM2 < 0.2) type = 'Vent / pipe';
      else if (areaM2 < 1.0) type = 'Exhaust fan / small curb';
      else if (areaM2 <= 15) type = hM >= 0.5 ? 'Rooftop unit (HVAC)' : 'Curb / skylight / hatch';
      else if (areaM2 <= 60 || hM < 2) type = 'Large equipment / platform';
      else type = 'Penthouse / mechanical enclosure';
      const cU = (u0 + u1) / 2, cV = (v0 + v1) / 2; const back = (u, v) => [u * ct - v * st, u * st + v * ct];
      objects.push({ type, areaM2, lenM: lo, widM: sh, hM, curbM: 2 * (L + W), center: back(cU, cV), corners: [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)] });
    } }
  objects.sort((a, b) => b.areaM2 - a.areaM2); objects.forEach((o, i) => { o.id = i + 1; });
  // ---- perimeter: parapet walls vs open edges
  const zAt = (E, Nm) => { const x = Math.floor(geo.X(E)), y = Math.floor(geo.Y(Nm)); if (x < 0 || y < 0 || x >= w || y >= h) return NaN; const z = dsm[y * w + x]; return z > -1000 ? z : NaN; };
  const med = (a) => { const b = a.filter(Number.isFinite).sort((p, r) => p - r); return b.length ? b[b.length >> 1] : NaN; };
  const edges = [];
  // ring must have the roof on its left: the outline is counter-clockwise, courtyards clockwise
  const sampleRing = (ring, court) => { const m = ring.length;
    for (let e = 0; e < m; e++) {
      const a = ring[e], b = ring[(e + 1) % m]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) continue;
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nin = [-d[1], d[0]];
      const hs = [], drops = []; const stn = Math.max(1, Math.floor((L - 0.6) / 0.5));
      for (let s = 0; s < stn; s++) {
        const t = stn === 1 ? L / 2 : 0.3 + (L - 0.6) * s / (stn - 1); const p = [a[0] + d[0] * t, a[1] + d[1] * t];
        let top = -Infinity; for (let o = -0.2; o <= 1.0; o += pxM) { const z = zAt(p[0] + nin[0] * o, p[1] + nin[1] * o); if (z > top) top = z; }
        const surf = []; for (let o = 1.6; o <= 3.6; o += pxM) surf.push(zAt(p[0] + nin[0] * o, p[1] + nin[1] * o));
        const out = []; for (let o = -2.5; o <= -0.8; o += pxM) out.push(zAt(p[0] + nin[0] * o, p[1] + nin[1] * o));
        const sf = med(surf), of = med(out);
        if (Number.isFinite(top) && Number.isFinite(sf)) hs.push(top - sf); if (Number.isFinite(sf) && Number.isFinite(of)) drops.push(sf - of);
      }
      const par = hs.filter((v) => v >= COM.parapetMinM); const frac = hs.length ? par.length / hs.length : 0;
      const ph = frac >= 0.5 ? med(par) : Math.max(0, med(hs) || 0);
      // over ~8 ft it is the wall of a taller roof part or a screen wall, not a parapet
      edges.push({ a, b, lenM: L, kind: frac >= 0.5 ? (ph > COM.parapetMaxM ? 'tallwall' : 'parapet') : 'edge', parapetM: ph, parapetFrac: frac, dropM: med(drops), court: !!court });
    } };
  const n = outline.length;
  sampleRing(outline, false);
  for (const c of courtyards) { const ring = comArea(c) > 0 ? c.slice().reverse() : c; sampleRing(ring, true); }  // corners of the outline: convex = outside corner of the building, reflex = inside corner
  let convex = 0, reflex = 0; for (let e = 0; e < n; e++) { const p0 = outline[(e - 1 + n) % n], p1 = outline[e], p2 = outline[(e + 1) % n]; const cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]); if (cr > 1e-6) convex++; else if (cr < -1e-6) reflex++; }
  const main0 = sections[0] || {};
  return {
    touchesBorder, theta, toLL, geo: { cLat, cLng, kx, ky }, pxM, groundZ, outline, courtyards, planM2, sections, walls, objects, edges, convex, reflex,
    roofHeightM: main0.elevM, maxElevM: Math.max(...sections.map((s) => s.elevM || 0)), pixelAreaM2: memberN * geo.pxM2, cellM: Math.sqrt(cellM2),
  };
}
function comArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
function comDpRing(P, eps) {
  if (P.length < 4) return P.slice();
  let i1 = 0, far = -1; for (let i = 0; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > far) { far = d; i1 = i; } }
  return dpSimplify(P.slice(0, i1 + 1), eps).slice(0, -1).concat(dpSimplify(P.slice(i1).concat([P[0]]), eps).slice(0, -1));
}
function comMergeSegs(segs) {
  // join collinear axis-aligned crack segments into longer lines
  const key = (s) => { const v = Math.abs(s[0][0] - s[1][0]) < 1e-9; return v ? 'v' + s[0][0].toFixed(3) : 'h' + s[0][1].toFixed(3); };
  const groups = new Map(); for (const s of segs) { const kk = key(s); if (!groups.has(kk)) groups.set(kk, []); groups.get(kk).push(s); }
  const out = [];
  for (const [kk, g] of groups) { const vert = kk[0] === 'v'; const iv = g.map((s) => vert ? [Math.min(s[0][1], s[1][1]), Math.max(s[0][1], s[1][1])] : [Math.min(s[0][0], s[1][0]), Math.max(s[0][0], s[1][0])]).sort((p, r) => p[0] - r[0]); const c = vert ? g[0][0][0] : g[0][0][1];
    let cur = iv[0].slice(); for (let i = 1; i <= iv.length; i++) { if (i < iv.length && iv[i][0] <= cur[1] + 1e-6) { cur[1] = Math.max(cur[1], iv[i][1]); continue; } out.push(vert ? [[c, cur[0]], [c, cur[1]]] : [[cur[0], c], [cur[1], c]]); if (i < iv.length) cur = iv[i].slice(); } }
  return out;
}
// square the traced outline: snap runs to the two building axes, drop jogs, intersect consecutive runs
function comSquare(P, simp, thetaDeg) {
  const th = thetaDeg * Math.PI / 180; const ax = [[Math.cos(th), Math.sin(th)], [-Math.sin(th), Math.cos(th)]];
  const idx = simp.map((p) => P.indexOf(p));
  let runs = [];
  for (let kk = 0; kk < simp.length; kk++) {
    const a = simp[kk], b = simp[(kk + 1) % simp.length]; const ia = idx[kk], ib = idx[(kk + 1) % simp.length];
    const pts = []; if (ia >= 0 && ib >= 0) for (let i = ia; ; i = (i + 1) % P.length) { pts.push(P[i]); if (i === ib || pts.length > P.length) break; }
    if (pts.length < 2) { pts.length = 0; pts.push(a, b); }
    const d = [b[0] - a[0], b[1] - a[1]]; const L = Math.hypot(d[0], d[1]) || 1e-9; const du = [d[0] / L, d[1] / L];
    let cls = -1, best = Math.cos((L > 6 ? 12 : 20) * Math.PI / 180); for (let c = 0; c < 2; c++) { const cs = Math.abs(du[0] * ax[c][0] + du[1] * ax[c][1]); if (cs > best) { best = cs; cls = c; } }
    runs.push({ cls, line: cls >= 0 ? lineWithDir(pts, ax[cls]) : lineFromPts(pts), pts, len: L, a, b });
  }
  const off = (r, p) => r.line.n[0] * p[0] + r.line.n[1] * p[1] - r.line.c;
  const join = (p, r, mid) => { const pts = p.pts.concat(mid ? mid.pts : [], r.pts); return { cls: p.cls, pts, len: p.len + r.len + (mid ? mid.len : 0), a: p.a, b: r.b, line: p.cls >= 0 ? lineWithDir(pts, ax[p.cls]) : lineFromPts(pts) }; };
  for (let it = 0; it < 8; it++) {
    let changed = false; const out = [];
    for (let kk = 0; kk < runs.length; kk++) {
      const r = runs[kk], p = out[out.length - 1], nx = runs[kk + 1];
      if (p && r.cls >= 0 && p.cls === r.cls && Math.abs(off(p, r.line.m)) < 0.5) { out[out.length - 1] = join(p, r); changed = true; continue; }
      if (p && nx && r.len < 1.2 && p.cls >= 0 && p.cls === nx.cls && Math.abs(off(p, nx.line.m)) < 0.8) { out[out.length - 1] = join(p, nx, r); kk++; changed = true; continue; }
      out.push(r);
    }
    runs = out; if (!changed || runs.length < 4) break;
  }
  if (runs.length < 3) return simp.slice();
  const poly = [];
  for (let kk = 0; kk < runs.length; kk++) { const a = runs[kk], b = runs[(kk + 1) % runs.length]; const c = intersect2(a.line, b.line); poly.push(c && Math.hypot(c[0] - a.b[0], c[1] - a.b[1]) < 4 ? c : a.b); }
  return poly;
}

// ------------------------------------------------------------------ derived quantities
function comHeightFt(M) { const o = parseFloat(com.opts.heightFt); return o > 0 ? o : (M.roofHeightM != null ? M.roofHeightM * FT : null); }
function comTotals(M) {
  const ftv = (m) => m * FT;
  const low = M.sections.filter((s) => !s.steep), steep = M.sections.filter((s) => s.steep);
  const par = M.edges.filter((e) => e.kind === 'parapet'), open = M.edges.filter((e) => e.kind === 'edge'), tall = M.edges.filter((e) => e.kind === 'tallwall');
  const parLF = ftv(par.reduce((s, e) => s + e.lenM, 0)), edgeLF = ftv(open.reduce((s, e) => s + e.lenM, 0));
  const parAvgFt = parLF ? ftv(par.reduce((s, e) => s + e.lenM * (e.parapetM || 0), 0) / par.reduce((s, e) => s + e.lenM, 0)) : 0;
  const wallList = M.walls.filter((wl) => wl.kind === 'wall');
  const tallLF = ftv(tall.reduce((s, e) => s + e.lenM, 0));
  const wallLF = ftv(wallList.reduce((s, wl) => s + wl.lenM, 0)) + tallLF;
  // flash up and over parapets up to 4 ft; taller walls get 3 ft of flashing with termination bar and counter-flashing
  const flashH = (hFt) => (hFt <= 4 ? hFt + COM_RULES.wallFlashExtraFt : COM_RULES.wallStepFlashMaxFt);
  const parFlashSF = par.reduce((s, e) => s + ftv(e.lenM) * flashH(ftv(e.parapetM || 0)), 0);
  const wallFlashSF = wallList.reduce((s, wl) => s + ftv(wl.lenM) * Math.min(COM_RULES.wallStepFlashMaxFt, ftv(wl.heightM)), 0) + tallLF * COM_RULES.wallStepFlashMaxFt;
  const units = M.objects.filter((o) => /Rooftop unit|Penthouse|equipment|Curb|Exhaust fan/i.test(o.type));   // everything on a curb
  const rtus = M.objects.filter((o) => /Rooftop unit/.test(o.type));
  const vents = M.objects.filter((o) => /Vent/i.test(o.type));
  const ducts = M.objects.filter((o) => /Duct/.test(o.type));
  const pens = M.objects.filter((o) => !/Obstruction|Expansion/.test(o.type));
  const penAreaSF = pens.reduce((s, o) => s + o.areaM2, 0) * SQFT, penPerimLF = pens.reduce((s, o) => s + o.curbM, 0) * FT;
  const obstr = M.objects.filter((o) => /Obstruction/.test(o.type));
  const curbLF = ftv(units.reduce((s, o) => s + o.curbM, 0));
  const lowSF = low.reduce((s, x) => s + x.areaM2, 0) * SQFT, steepSF = steep.reduce((s, x) => s + x.slopedM2, 0) * SQFT;
  const totalSF = lowSF + steepSF;
  const drainsEst = low.length ? Math.max(1, low.reduce((s, x) => s + Math.ceil(x.areaM2 * SQFT / COM_RULES.drainSqft), 0)) : 0;
  const num = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 ? x : null; };
  const drainsEntered = num(com.opts.drains) != null; const drains = drainsEntered ? num(com.opts.drains) : drainsEst;
  const parFrac = (parLF + edgeLF) > 0 ? parLF / (parLF + edgeLF) : 0;
  const scuppers = num(com.opts.scuppers) != null ? num(com.opts.scuppers) : (parFrac >= 0.5 ? drains : 0);   // FBC-P 1108: parapet roofs need overflow drainage   // FBC-P 1108: parapet roofs need overflow drainage
  const predSlope = low.length ? low.slice().sort((a, b) => b.areaM2 - a.areaM2)[0].slope * 12 : null;
  return { lowSF, steepSF, totalSF, squares: totalSF / 100, perimLF: parLF + edgeLF, parLF, edgeLF, parAvgFt, wallLF, parFlashSF, wallFlashSF, curbLF, units, rtus, tallLF, drainsEntered, parFrac, vents, ducts, pens, penAreaSF, penPerimLF, obstr, drains, drainsEst, scuppers, skylights: num(com.opts.skylights) || 0, hatches: num(com.opts.hatches) || 0, predSlope, heightFt: comHeightFt(M), levels: M.sections.length, convex: M.convex, reflex: M.reflex };
}
// ASCE 7-22 components & cladding roof zones for roofs of 7 degrees or less (h <= 60 ft): zone 3 corner squares,
// zone 2 perimeter band, zone 1 field band and zone 1' interior. Widths from mean roof height h (COM_WIND).
const COM_WIND = { z3: (h) => 0.6 * h, z3d: (h) => 0.2 * h, z2: (h) => 0.6 * h, z1: (h) => 1.2 * h, note: 'ASCE 7-16/7-22 (low-slope coefficients unchanged in 7-22): zone 2 perimeter band 0.6h, zone 1 band to 1.2h, zone 1\' beyond; zone 3 is an L at each outside corner, 0.6h long and 0.2h deep. With a parapet of 3 ft or more, zone 3 is treated as zone 2.' };
function comCornerSquares(poly, a, dep) {
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    if ((p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]) <= 0) continue; // convex corners only (CCW outline)
    const d1 = [p0[0] - p1[0], p0[1] - p1[1]], d2 = [p2[0] - p1[0], p2[1] - p1[1]]; const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    const u1 = [d1[0] / l1 * Math.min(a, l1), d1[1] / l1 * Math.min(a, l1)], u2 = [d2[0] / l2 * Math.min(a, l2), d2[1] / l2 * Math.min(a, l2)];
    if (dep == null || dep >= a) { out.push([p1, [p1[0] + u1[0], p1[1] + u1[1]], [p1[0] + u1[0] + u2[0], p1[1] + u1[1] + u2[1]], [p1[0] + u2[0], p1[1] + u2[1]]]); continue; }
    const f1 = Math.min(dep, l1) / Math.max(1e-9, Math.min(a, l1)), f2 = Math.min(dep, l2) / Math.max(1e-9, Math.min(a, l2)); const v1 = [u1[0] * f1, u1[1] * f1], v2 = [u2[0] * f2, u2[1] * f2];
    out.push([p1, [p1[0] + u1[0], p1[1] + u1[1]], [p1[0] + u1[0] + v2[0], p1[1] + u1[1] + v2[1]], [p1[0] + v1[0] + v2[0], p1[1] + v1[1] + v2[1]], [p1[0] + v1[0] + u2[0], p1[1] + v1[1] + u2[1]], [p1[0] + u2[0], p1[1] + u2[1]]]);   // L-shape
  }
  return out;
}
function comWindZones(M, T) {
  const hFt = T.heightFt || 20; const hM = hFt / FT; const out = { hFt, zones: null, note: COM_WIND.note };
  const poly = M.outline; if (poly.length < 3) return out;
  let a3 = COM_WIND.z3(hM), a2 = COM_WIND.z2(hM), a1 = COM_WIND.z1(hM), dep3 = COM_WIND.z3d(hM);
  if (hFt > 60) {   // h > 60 ft: zones 1-3 with a = min(0.1 x least dimension, 0.4h), not less than 0.04 x least dimension or 3 ft; no zone 1'
    const th = M.theta * Math.PI / 180; const us = poly.map((p) => p[0] * Math.cos(th) + p[1] * Math.sin(th)), vs = poly.map((p) => -p[0] * Math.sin(th) + p[1] * Math.cos(th));
    const least = Math.min(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs));
    const a = Math.max(0.04 * least, 0.9144, Math.min(0.1 * least, 0.4 * hM)); a3 = a; a2 = a; a1 = Infinity; dep3 = a;
    out.note = `Mean roof height over 60 ft: ASCE 7-22 Fig. 30.5-1 layout; zone 2 band and zone 3 corners are a = ${fmt(a * FT, 1)} ft wide (10% of the least dimension or 0.4h).`;
  }
  const tallParapet = T.parLF > 0 && T.parAvgFt >= 3 && T.parLF >= 0.8 * T.perimLF; out.tallParapet = tallParapet;
  const sq = tallParapet ? [] : comCornerSquares(poly, a3, dep3); out.corners = sq;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const res = Math.max(0.25, Math.sqrt((x1 - x0) * (y1 - y0) / 160000));
  const W = Math.ceil((x1 - x0) / res) + 1, H = Math.ceil((y1 - y0) / res) + 1;
  const inP = (pts, px, py) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const segD = (px, py, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy; let t = L2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy); };
  const sums = { z1p: 0, z1: 0, z2: 0, z3: 0 }; const cell = res * res;
  for (let yy = 0; yy < H; yy++) {
    const py = y0 + (yy + 0.5) * res;
    for (let xx = 0; xx < W; xx++) {
      const px = x0 + (xx + 0.5) * res; if (!inP(poly, px, py) || M.courtyards.some((c) => inP(c, px, py))) continue;
      if (sq.some((s) => inP(s, px, py))) { sums.z3 += cell; continue; }
      let d = Infinity; for (let i = 0; i < poly.length && d > a2; i++) { const v = segD(px, py, poly[i], poly[(i + 1) % poly.length]); if (v < d) d = v; }
      if (d <= a2) sums.z2 += cell; else if (d <= a1) sums.z1 += cell; else sums.z1p += cell;
    }
  }
  // scale to the measured low-slope area
  const tot = sums.z1p + sums.z1 + sums.z2 + sums.z3; const k = tot > 0 ? (T.lowSF / SQFT) / tot : 1;
  out.widthsFt = { z3: a3 * FT, z3d: dep3 * FT, z2: a2 * FT, z1: Number.isFinite(a1) ? a1 * FT : null };
  out.zones = Object.fromEntries(Object.entries(sums).map(([kk, v]) => [kk, v * k * SQFT]));
  return out;
}
const rFor = (thkIn) => { const tb = COM_RULES.polyisoR; for (let i = tb.length - 1; i >= 0; i--) if (thkIn >= tb[i][0] - 1e-9) return tb[i][1] + (thkIn - tb[i][0]) * 5.7; return thkIn * 5.7; };
function comInsulationPlan(rTarget) {
  // fewest layers of standard polyiso (max 2.6" per layer for staggered joints) that reach the target LTTR R-value
  if (!(rTarget > 0)) return [];
  const sizes = [1.5, 2.0, 2.2, 2.5, 2.6, 3.0];
  for (let layers = 1; layers <= 3; layers++) {
    let best = null;
    const rec = (k, acc) => { if (k === layers) { const r = acc.reduce((s, t) => s + rFor(t), 0); if (r >= rTarget && (!best || acc.reduce((s, t) => s + t, 0) < best.reduce((s, t) => s + t, 0))) best = acc.slice(); return; } for (const sz of sizes) { if (layers > 1 && sz > 2.6) continue; acc.push(sz); rec(k + 1, acc); acc.pop(); } };
    rec(0, []); if (best) return best.sort((a, b) => b - a);
  }
  return [2.6, 2.6, 2.6];
}
function comMaterials(M, T, sysKey, wastePct) {
  const S = COM_SYSTEMS[sysKey]; const r = COM_RULES; const wp = wastePct != null ? wastePct : (r.wasteDefault[S.mem] || 10); const wf = 1 + wp / 100;
  const Z = comWindZones(M, T).zones || { z1p: T.lowSF, z1: 0, z2: 0, z3: 0 };
  const zTot = Z.z1p + Z.z1 + Z.z2 + Z.z3 || 1; const fieldFrac = (Z.z1p + Z.z1) / zTot, perimFrac = Z.z2 / zTot, cornerFrac = Z.z3 / zTot;
  const roofSF = T.lowSF; const curbSF = T.curbLF * r.curbFlashFt; const flashSF = T.parFlashSF + T.wallFlashSF + curbSF;
  const rows = []; const add = (group, name, qty, unit, note) => rows.push({ group, name, qty, unit, note: note || '' });
  const ceil = (v) => Math.max(0, Math.ceil(v - 1e-9));
  const nUnits = T.units.length, nVents = T.vents.length, nRtu = T.rtus.length;
  const insul = sysKey === 'silicone' ? [] : comInsulationPlan((com.opts.rTarget || 0) - (com.opts.cover ? r.cover.r : 0));
  const boards = ceil(roofSF / r.boardSqft * (1 + r.wasteDefault.insulation / 100));
  const perBoard = fieldFrac * r.insulFastPerBoard.field + perimFrac * r.insulFastPerBoard.perimeter + cornerFrac * r.insulFastPerBoard.corner;
  const fmtN = (v) => fmt(v);
  if (S.mem === 'tpo' || S.mem === 'pvc' || S.mem === 'epdm') {
    const roll = r.rollSqft[S.mem], netW = r.rollNetWidthFt[S.mem], netRoll = netW * 100;
    const memName = { tpo: 'TPO 60 mil reinforced membrane', pvc: 'PVC 60 mil reinforced membrane', epdm: 'EPDM 60 mil membrane' }[S.mem];
    const seamLF = roofSF / netW;                                            // side-lap seam length
    if (S.attach === 'ma') {
      const edgeSF = roofSF * (perimFrac + cornerFrac);
      add('Membrane', `${memName}, field sheets 10' x 100'`, ceil((roofSF - edgeSF) * wf / netRoll), 'roll', `${fmtN(roofSF - edgeSF)} sqft zones 1/1'; ${fmt(netRoll)} sqft net per roll after 5.5" laps`);
      if (edgeSF > 0) add('Membrane', `${memName}, perimeter half-sheets ${r.halfSheetFt}' x 100'`, ceil(edgeSF * wf / ((r.halfSheetFt - 0.46) * 100)), 'roll', `${fmtN(edgeSF)} sqft zones 2/3`);
      const fieldSeam = (roofSF - edgeSF) / netW, edgeSeam = edgeSF / (r.halfSheetFt - 0.46);
      add('Attachment', 'Membrane fasteners + 2-3/8" seam plates', ceil((fieldSeam * 12 / r.seamFastSpacingIn.field + edgeSeam * 12 / r.seamFastSpacingIn.perimeter) * 1.05), 'each', `in the seams, ${r.seamFastSpacingIn.field}" o.c. field / ${r.seamFastSpacingIn.perimeter}" o.c. perimeter (final spacing per uplift design)`);
      add('Attachment', 'Bonding adhesive (walls and curbs)', ceil(flashSF / r.adhesiveSqftPerGal / r.adhesivePail), '5-gal pail', `${fmtN(flashSF)} sqft vertical flashing at ${r.adhesiveSqftPerGal} sqft/gal`);
    } else {
      add('Membrane', `${memName} 10' x 100'`, ceil(roofSF * wf / netRoll), 'roll', `${fmtN(roofSF)} sqft field; ${fmt(netRoll)} sqft net per roll`);
      add('Attachment', 'Bonding adhesive (field + flashings)', ceil((roofSF + flashSF) / r.adhesiveSqftPerGal / r.adhesivePail), '5-gal pail', `${r.adhesiveSqftPerGal} sqft per gallon of finished surface`);
    }
    add('Membrane', `${memName}, wall / curb flashing`, ceil(flashSF * wf / roll), "10' x 100' roll", `${fmtN(T.parFlashSF)} sqft parapets + ${fmtN(T.wallFlashSF)} sqft walls + ${fmtN(curbSF)} sqft curbs`);
    if (S.mem === 'epdm') {
      add('Seams', 'Seam tape 3" x 100\'', ceil(seamLF * 1.1 / r.seamTapeRollFt), 'roll', `${fmtN(seamLF)} LF of seams`);
      add('Seams', 'Seam primer', ceil((seamLF * 0.5 + flashSF * 0.15) / r.epdmPrimerSqftPerGal), 'gallon');
      add('Seams', 'Pressure-sensitive cover strip 6" x 100\'', ceil((T.edgeLF + T.parLF) * 1.1 / 100), 'roll', 'metal flanges and terminations');
    } else {
      add('Seams', 'T-joint covers', ceil(roofSF * wf / roll * r.tJointPerRoll), 'each', '60 mil and thicker: every T-joint overlaid (100 per box)');
      const cutLF = T.perimLF + T.wallLF + T.curbLF + seamLF * 0.1;   // cut edges at terminations, curbs and end laps (factory edges need none)
      add('Seams', 'Cut-edge sealant 16 oz', ceil(cutLF / r.cutEdgeLfPerBottle), 'bottle', `${fmt(cutLF)} LF of cut edges, ${r.cutEdgeLfPerBottle} LF per bottle`);
      add('Seams', 'Pressure-sensitive cover strip 6" x 100\'', ceil(T.edgeLF * 1.1 / 100), 'roll', 'edge metal flanges');
    }
    add('Details', 'Molded pipe boots', nVents, 'each', 'one per detected vent / pipe');
    add('Details', 'Curb wrap corners', nUnits * 4, 'each', '4 per curbed unit');
    add('Details', 'Inside / outside corners (parapets)', Math.round((T.convex + T.reflex) * T.parFrac), 'each', 'parapet corners');
    add('Details', 'Sealant pockets / pitch pans', nRtu, 'each', 'gas / electrical lines at HVAC units');
  } else if (S.mem === 'modbit') {
    add('Membrane', 'SBS base sheet (Ruberoid 20 class, 1.5 sq roll)', ceil(roofSF * wf / r.modbit.baseSqftPerRoll), 'roll', `${r.modbit.baseSqftPerRoll} sqft net per roll`);
    add('Membrane', 'SBS granulated FR cap sheet (1 sq roll)', ceil(roofSF * wf / r.modbit.capSqftPerRoll), 'roll', `${r.modbit.capSqftPerRoll} sqft net per roll after laps`);
    add('Membrane', 'SBS flashing, base + cap plies', ceil(flashSF * 2 * wf / r.modbit.flashSqftPerRoll), 'roll', `${fmtN(flashSF)} sqft of walls and curbs, two plies`);
    add('Attachment', 'Asphalt primer', ceil(flashSF / r.modbit.primerSqftPerGal), 'gallon', 'walls and metal flanges (FBC 1511.6)');
    add('Details', 'Pipe flashings (lead or pre-formed)', nVents, 'each');
    add('Details', 'Pitch pans + pourable sealer', nRtu, 'each');
  } else if (S.mem === 'silicone') {
    const sq = (roofSF + flashSF) / 100;
    add('Coating', 'Silicone roof coating (e.g. GacoFlex S20, 95% solids)', ceil(sq * r.silicone.galPerSq * wf / r.silicone.pail), '5-gal pail', `${r.silicone.galPerSq} gal/sq smooth (~22 dry mils); granulated surfaces need ${r.silicone.galPerSqGranulated} gal/sq`);
    add('Coating', 'Primer / bleed-blocker base coat', ceil(sq * r.silicone.primerGalPerSq / r.silicone.pail), '5-gal pail', 'required over SBS / asphalt (BleedTrap class); confirm by adhesion test');
    add('Coating', 'Polyester reinforcing fabric 6"', ceil((T.perimLF + T.wallLF + T.curbLF + nVents * 3) * 1.1 / r.silicone.fabricRollFt), 'roll', 'seams, flashings, penetrations');
    add('Coating', 'Silicone flashing-grade sealant', ceil((nVents + nUnits * 4) / 10) + 1, 'case');
  }
  if (insul.length) {
    insul.forEach((th, i) => add('Insulation', `Polyiso ${th}" 4' x 8' (LTTR R-${rFor(th).toFixed(1)})${i ? ', joints staggered' : ''}`, boards, 'board'));
    add('Insulation', 'Insulation fasteners + 3" plates (base layer)', ceil(boards * perBoard), 'each', `${r.insulFastPerBoard.field}/${r.insulFastPerBoard.perimeter}/${r.insulFastPerBoard.corner} per board field/perimeter/corner`);
    const adhLayers = (insul.length - 1) + (com.opts.cover ? 1 : 0);
    if (adhLayers > 0) add('Insulation', 'Low-rise foam insulation adhesive (upper layers)', ceil(roofSF * adhLayers / 1500), 'twin pack', 'about 1,500 sqft per pack in ribbons');
  }
  if (com.opts.cover && sysKey !== 'silicone') add('Insulation', r.cover.name, boards, 'board');
  if (com.opts.taper && sysKey !== 'silicone') add('Insulation', 'Tapered polyiso 1/4" per ft (X/Y/Z panels 4\' x 4\') + crickets', ceil(roofSF / 16 * 1.08), 'panel', 'engineered taper layout required; crickets at 2x field slope');
  add('Metal', "Coping 12' (parapets, ES-1 tested)", ceil(T.parLF / r.copingFt), 'piece', `${fmtN(T.parLF)} LF; width at least the wall thickness (FBC 1503.3)`);
  add('Metal', "Edge metal / gravel stop 10' (ES-1 tested)", ceil(T.edgeLF / r.edgeMetalFt), 'piece', `${fmtN(T.edgeLF)} LF open edges (FBC 1504.5)`);
  add('Metal', "Termination bar 1\" x 10'", ceil((T.parLF + T.wallLF) / r.termBarFt), 'piece', 'parapets + walls between levels (500 LF per box)');
  if (T.wallLF) add('Metal', "Counter-flashing / reglet 10'", ceil(T.wallLF / 10), 'piece', `${fmtN(T.wallLF)} LF walls between levels`);
  if (T.drains) add('Drainage', 'Roof drains (replace / retrofit)', T.drains, 'each', !T.drainsEntered ? `estimate, 1 per ${fmt(r.drainSqft)} sqft (about 75 ft apart); verify on site` : 'entered');
  if (T.scuppers) add('Drainage', 'Overflow scuppers / secondary drains', T.scuppers, 'each', 'FBC-P 1108: required on parapet roofs; scupper at least 4" high');
  add('Accessories', 'Walkway pads 30" x 30"', nRtu * r.walkPadsPerRtu, 'each', `${r.walkPadsPerRtu} per HVAC unit, service side`);
  if (T.skylights) add('Accessories', 'Skylight curb flashing', T.skylights, 'each');
  if (T.hatches) add('Accessories', 'Roof hatch curb flashing', T.hatches, 'each');
  add('Accessories', 'Lap sealant / water cut-off mastic', ceil((T.perimLF + T.curbLF) / 250) + 1, 'case', '25 tubes per case');
  return { system: S.name, sysKey, wastePct: wp, rows, insul, rTotal: insul.reduce((s, th) => s + rFor(th), 0) + (com.opts.cover && sysKey !== 'silicone' ? r.cover.r : 0) };
}
// ------------------------------------------------------------------ app UI
function comClearShapes() { for (const s of com.shapes) s.setMap(null); com.shapes = []; }
const COM_COL = { parapet: '#e74c3c', tallwall: '#5dade2', edge: '#2ecc71', wall: '#3498db', joint: '#95a5a6', transition: '#e67e22', unit: '#f1c40f', vent: '#ecf0f1' };
const SEC_FILL = ['#5dade2', '#f5b041', '#58d68d', '#af7ac5', '#f1948a', '#76d7c4', '#f7dc6f', '#85929e'];
function comDraw() {
  comClearShapes(); const M = com.model; if (!M || !window.map) return; const LL = M.toLL;
  M.sections.forEach((s, i) => { if (s.poly.length >= 3) com.shapes.push(new google.maps.Polygon({ map, paths: s.poly.map(LL), strokeWeight: 1, strokeColor: '#fff', fillColor: SEC_FILL[i % SEC_FILL.length], fillOpacity: 0.28, clickable: false })); });
  for (const e of M.edges) com.shapes.push(new google.maps.Polyline({ map, path: [LL(e.a), LL(e.b)], strokeColor: COM_COL[e.kind], strokeWeight: e.kind === 'parapet' ? 5 : 3, clickable: false }));
  for (const wl of M.walls) for (const sg of wl.segs) com.shapes.push(new google.maps.Polyline({ map, path: sg.map(LL), strokeColor: COM_COL[wl.kind], strokeWeight: wl.kind === 'wall' ? 4 : 2, clickable: false }));
  for (const o of M.objects) { if (/Obstruction|Expansion/.test(o.type)) continue; com.shapes.push(new google.maps.Polygon({ map, paths: o.corners.map(LL), strokeColor: /Vent|penetration/i.test(o.type) ? COM_COL.vent : COM_COL.unit, strokeWeight: 1.5, fillOpacity: 0.15, fillColor: COM_COL.unit, clickable: false })); }
}
function comRenderPanel() {
  const out = $('#comOut'); if (!out) return; const M = com.model;
  if (!M) { out.innerHTML = '<span class="muted">Enter the address, then press Measure commercial roof.</span>'; return; }
  const T = comTotals(M);
  const secRows = M.sections.map((s) => `<tr><td>${s.letter}</td><td>${fmt(s.areaM2 * SQFT)}</td><td>${s.steep ? fmt(s.slope * 12, 1) + '/12' : fmt(s.slope * 12, 2) + '"/ft'}</td><td>${s.elevM != null ? fmt(s.elevM * FT) + ' ft' : '-'}</td></tr>`).join('');
  out.innerHTML = `<div class="kv"><b>${fmt(T.totalSF)} sqft</b> (${fmt(T.squares, 1)} sq) &middot; ${M.sections.length} section${M.sections.length > 1 ? 's' : ''} &middot; roof ${T.heightFt ? fmt(T.heightFt) + ' ft' : '-'} high</div>
    <div>Perimeter ${fmt(T.perimLF)} LF: parapet ${fmt(T.parLF)} LF (avg ${fmt(T.parAvgFt, 1)} ft), open edge ${fmt(T.edgeLF)} LF</div>
    <div>Interior walls ${fmt(T.wallLF)} LF &middot; HVAC units ${T.rtus.length} &middot; vents/penetrations ${T.vents.length} &middot; drains (est.) ${T.drains}</div>
    <table class="mini"><tr><th>Sec</th><th>sqft</th><th>slope</th><th>height</th></tr>${secRows}</table>
    <div class="muted">Imagery ${M.imageryDate || '-'} &middot; ${M.quality || ''} &middot; ${(M.ms / 1000).toFixed(1)} s</div>`;
}
async function comRun() {
  if (!state.location) { toast('Enter the address first', true); return; }
  const b = $('#btnCom'); b.disabled = true; b.textContent = 'Measuring...';
  try {
    toast('Downloading roof height model...');
    com.model = await comMeasure(state.location);
    com.model.address = state.address;
    comDraw(); comRenderPanel(); toast('Commercial roof measured');
  } catch (e) { toast('Commercial measure failed: ' + e.message, true); console.error(e); }
  finally { b.disabled = false; b.textContent = 'Measure commercial roof'; }
}
function setMode(m) {
  document.body.classList.toggle('mode-com', m === 'com');
  $('#modeRes').classList.toggle('on', m !== 'com'); $('#modeCom').classList.toggle('on', m === 'com');
  localStorage.setItem('rm.mode', m);
  if (m === 'com') { comDraw(); setHint('Commercial: enter the address, then press Measure commercial roof.'); } else { comClearShapes(); setHint(''); }
}
(function wireCommercial() {
  if (!$('#modeCom')) return;
  $('#modeRes').onclick = () => setMode('res'); $('#modeCom').onclick = () => setMode('com');
  $('#btnCom').onclick = comRun;
  const bind = (id, key, kind) => { const el = $('#' + id); if (!el) return; if (kind === 'chk') el.checked = !!com.opts[key]; else el.value = com.opts[key] != null ? com.opts[key] : '';
    el.onchange = el.oninput = () => { com.opts[key] = kind === 'chk' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value; saveComOpts(); comRenderPanel(); }; };
  bind('c_system', 'system'); bind('c_waste', 'waste', 'num'); bind('c_rTarget', 'rTarget', 'num'); bind('c_cover', 'cover', 'chk'); bind('c_taper', 'taper', 'chk');
  bind('c_drains', 'drains'); bind('c_scuppers', 'scuppers'); bind('c_skylights', 'skylights'); bind('c_hatches', 'hatches'); bind('c_height', 'heightFt'); bind('c_wind', 'windMph', 'num');
  const run = (fn) => async () => { if (!com.model) { await comRun(); if (!com.model) return; } await fn(); };
  $('#btnComReport').onclick = run(comPrint); $('#btnComDownload').onclick = run(comDownload);
  // a new address clears the old measurement and the per-building site counts (no stale report under a new name)
  const SITE = { drains: 'c_drains', scuppers: 'c_scuppers', skylights: 'c_skylights', hatches: 'c_hatches', heightFt: 'c_height' };
  const origSet = setLocation;
  setLocation = function (...args) { origSet.apply(this, args); com.model = null; comClearShapes(); for (const [kk, id] of Object.entries(SITE)) { com.opts[kk] = ''; const el = $('#' + id); if (el) el.value = ''; } saveComOpts(); comRenderPanel(); };
  setMode(localStorage.getItem('rm.mode') === 'com' ? 'com' : 'res');
  comRenderPanel();
})();
