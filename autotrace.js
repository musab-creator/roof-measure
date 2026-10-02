'use strict';
/* autotrace.js - automatic roof tracing from Google Solar API data layers.
 * Downloads the building mask and digital surface model (DSM) GeoTIFFs for the building (0.1 m per pixel),
 * assigns every roof pixel to the Solar API roof plane whose height matches, vectorises the plane regions
 * into facets, and classifies every boundary as eave / rake / ridge / hip / valley / step / wall / transition.
 * Uses globals from app.js (state, fetchSolar, solarSummaryOf, addFacet, addEdge, degToPitch, recompute, toast, $).
 * Needs geotiff.js (global GeoTIFF) and proj4 (global proj4) loaded before this file.
 */

var AT = { v2: true, tolM: 0.75, minRegionM2: 3, dpEpsPx: 5, regularize: true, dropBlobM2: 10, maxOtherStructures: 3, minOtherM2: 4, maxOtherM2: 95, maxOtherDistM: 28 };

// ------------------------------------------------------------------ data access
async function solarDataLayers(lat, lng, radius) {
  const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=LOW&pixelSizeMeters=0.1&key=${encodeURIComponent(state.key)}`;
  const r = await fetch(url);
  if (!r.ok) { let m = 'HTTP ' + r.status; try { const j = await r.json(); m = (j.error && j.error.message) || m; } catch (_) { /* ignore */ } throw new Error('Data layers: ' + m); }
  return r.json();
}
async function loadTiff(url, cacheName) {
  let buf = null;
  // local development only: keep downloaded rasters on disk so reloading the page does not re-buy the same data
  const devCache = cacheName && location.hostname === 'localhost';
  if (devCache) { try { const c = await fetch('/reports/' + encodeURIComponent(cacheName)); if (c.ok) buf = await c.arrayBuffer(); } catch (_) { /* not cached */ } }
  if (!buf) {
    const r = await fetch(url + '&key=' + encodeURIComponent(state.key));
    if (!r.ok) throw new Error('GeoTIFF download failed (' + r.status + ')');
    buf = await r.arrayBuffer();
    if (devCache) { try { await fetch('/save?name=' + encodeURIComponent(cacheName), { method: 'POST', body: buf }); } catch (_) { /* best effort */ } }
  }
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const data = (await img.readRasters())[0];
  const w = img.getWidth(), h = img.getHeight();
  const [ox, oy] = img.getOrigin(); const [rx, ry] = img.getResolution();
  const keys = img.getGeoKeys ? (img.getGeoKeys() || {}) : {};
  const epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || 4326;
  const sy = ry > 0 ? -ry : ry;                               // rows run southward: model y decreases as the row index grows
  let toLL;
  if (epsg === 4326 || Math.abs(ox) <= 360) toLL = (x, y) => ({ lng: ox + x * rx, lat: oy + y * sy });
  else {
    let def = null;
    if (epsg >= 32601 && epsg <= 32660) def = `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
    else if (epsg >= 32701 && epsg <= 32760) def = `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
    else if (epsg === 3857) def = 'EPSG:3857';
    if (!def) throw new Error('Unsupported GeoTIFF projection EPSG:' + epsg);
    toLL = (x, y) => { const p = proj4(def, 'EPSG:4326', [ox + x * rx, oy + y * sy]); return { lng: p[0], lat: p[1] }; };
  }
  return { data, w, h, toLL, rx, ry, epsg };
}

// ------------------------------------------------------------------ raster helpers
function floodComponent(mask, w, h, sx, sy) {
  // connected component (4-neighbour) of mask pixels containing (sx,sy); returns Uint8Array membership and pixel count
  const out = new Uint8Array(w * h); const stack = [sy * w + sx]; let n = 0;
  if (!mask[sy * w + sx]) return { out, n: 0 };
  out[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop(); n++;
    const x = i % w, y = (i - x) / w;
    if (x > 0 && mask[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && mask[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && mask[i - w] && !out[i - w]) { out[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && mask[i + w] && !out[i + w]) { out[i + w] = 1; stack.push(i + w); }
  }
  return { out, n };
}
function allComponents(mask, w, h) {
  const seen = new Uint8Array(w * h); const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const x = i % w, y = (i - x) / w;
    const { out, n } = floodComponent(mask, w, h, x, y);
    let sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (let j = 0; j < w * h; j++) if (out[j]) { seen[j] = 1; const px = j % w, py = (j - px) / w; sx += px; sy += py; if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
    comps.push({ member: out, n, cx: sx / n, cy: sy / n, bbox: [minx, miny, maxx, maxy] });
  }
  return comps;
}
function majorityFilter(label, w, h, member, passes, rad = 2) {
  let cur = label;
  for (let p = 0; p < passes; p++) {
    const next = new Int16Array(cur);
    for (let y = rad; y < h - rad; y++) for (let x = rad; x < w - rad; x++) {
      const i = y * w + x; if (!member[i]) continue;
      const counts = new Map(); let best = cur[i], bestN = 0;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { const j = i + dy * w + dx; if (!member[j]) continue; const v = cur[j]; const c = (counts.get(v) || 0) + 1; counts.set(v, c); if (c > bestN || (c === bestN && v === cur[i])) { bestN = c; best = v; } }
      next[i] = best;
    }
    cur = next;
  }
  return cur;
}
function fillUnassigned(label, w, h, member) {
  // iterative nearest-neighbour fill of -2 pixels from labelled neighbours
  for (let it = 0; it < 60; it++) {
    let changed = 0; const next = new Int16Array(label);
    for (let i = 0; i < w * h; i++) {
      if (!member[i] || label[i] !== -2) continue;
      const x = i % w, y = (i - x) / w; const c = new Map(); let best = -2, bestN = 0;
      const nb = [];
      if (x > 0) nb.push(i - 1); if (x < w - 1) nb.push(i + 1); if (y > 0) nb.push(i - w); if (y < h - 1) nb.push(i + w);
      for (const j of nb) { if (member[j] && label[j] >= 0) { const n = (c.get(label[j]) || 0) + 1; c.set(label[j], n); if (n > bestN) { bestN = n; best = label[j]; } } }
      if (best >= 0) { next[i] = best; changed++; }
    }
    label = next; if (!changed) break;
  }
  return label;
}
function regionize(label, w, h, member, pxM2, minM2) {
  // connected components of equal label -> region ids; tiny regions take their dominant neighbour's label
  for (let round = 0; round < 3; round++) {
    const region = new Int32Array(w * h).fill(-1); const regions = [];
    for (let i = 0; i < w * h; i++) {
      if (!member[i] || region[i] >= 0) continue;
      const id = regions.length; const lab = label[i]; const stack = [i]; region[i] = id; let n = 0;
      while (stack.length) {
        const k = stack.pop(); n++;
        const x = k % w, y = (k - x) / w;
        const nb = [];
        if (x > 0) nb.push(k - 1); if (x < w - 1) nb.push(k + 1); if (y > 0) nb.push(k - w); if (y < h - 1) nb.push(k + w);
        for (const j of nb) if (member[j] && region[j] < 0 && label[j] === lab) { region[j] = id; stack.push(j); }
      }
      regions.push({ id, label: lab, n });
    }
    let merged = 0;
    for (const r of regions) {
      if (r.n * pxM2 >= minM2) continue;
      const counts = new Map();
      for (let i = 0; i < w * h; i++) {
        if (region[i] !== r.id) continue;
        const x = i % w, y = (i - x) / w; const nb = [];
        if (x > 0) nb.push(i - 1); if (x < w - 1) nb.push(i + 1); if (y > 0) nb.push(i - w); if (y < h - 1) nb.push(i + w);
        for (const j of nb) if (member[j] && region[j] !== r.id) counts.set(label[j], (counts.get(label[j]) || 0) + 1);
      }
      let best = null, bestN = 0; for (const [k, v] of counts) if (v > bestN) { bestN = v; best = k; }
      if (best != null) { for (let i = 0; i < w * h; i++) if (region[i] === r.id) label[i] = best; merged++; }
    }
    if (!merged) return { region, regions };
  }
  // final pass
  const region = new Int32Array(w * h).fill(-1); const regions = [];
  for (let i = 0; i < w * h; i++) {
    if (!member[i] || region[i] >= 0) continue;
    const id = regions.length; const lab = label[i]; const stack = [i]; region[i] = id; let n = 0;
    while (stack.length) { const k = stack.pop(); n++; const x = k % w, y = (k - x) / w; const nb = []; if (x > 0) nb.push(k - 1); if (x < w - 1) nb.push(k + 1); if (y > 0) nb.push(k - w); if (y < h - 1) nb.push(k + w); for (const j of nb) if (member[j] && region[j] < 0 && label[j] === lab) { region[j] = id; stack.push(j); } }
    regions.push({ id, label: lab, n });
  }
  return { region, regions };
}

// ------------------------------------------------------------------ vectorising
function regionOuterLoop(region, w, h, id) {
  // directed crack edges with the region on the right (clockwise in image coordinates); returns the longest closed loop
  // each edge: {a:[x,y], b:[x,y], inside: pixelIndex, outside: pixelIndex|-1}
  const edges = new Map(); // key start point -> array of edges
  const key = (x, y) => y * (w + 1) + x;
  const add = (ax, ay, bx, by, inside, outside) => { const k = key(ax, ay); const e = { a: [ax, ay], b: [bx, by], inside, outside }; if (!edges.has(k)) edges.set(k, []); edges.get(k).push(e); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (region[i] !== id) continue;
    const up = y > 0 ? i - w : -1, dn = y < h - 1 ? i + w : -1, lf = x > 0 ? i - 1 : -1, rt = x < w - 1 ? i + 1 : -1;
    if (up < 0 || region[up] !== id) add(x, y, x + 1, y, i, up);
    if (rt < 0 || region[rt] !== id) add(x + 1, y, x + 1, y + 1, i, rt);
    if (dn < 0 || region[dn] !== id) add(x + 1, y + 1, x, y + 1, i, dn);
    if (lf < 0 || region[lf] !== id) add(x, y + 1, x, y, i, lf);
  }
  const loops = []; const used = new Set();
  for (const [, arr] of edges) for (const e0 of arr) {
    if (used.has(e0)) continue;
    const loop = []; let e = e0; let guard = 0;
    while (e && !used.has(e) && guard++ < 1e6) {
      used.add(e); loop.push(e);
      const nexts = edges.get(key(e.b[0], e.b[1])) || [];
      // prefer the sharpest right turn to keep separate loops separate at diagonal touches
      const dirIn = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      let best = null, bestScore = -9;
      for (const c of nexts) { if (used.has(c)) continue; const d = [c.b[0] - c.a[0], c.b[1] - c.a[1]]; const cross = dirIn[0] * d[1] - dirIn[1] * d[0]; const dot = dirIn[0] * d[0] + dirIn[1] * d[1]; const score = cross > 0 ? 2 : dot > 0 ? 1 : 0; if (score > bestScore) { bestScore = score; best = c; } }
      e = best;
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  return loops[0] || [];
}
function dpSimplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const L = Math.hypot(bx - ax, by - ay) || 1e-9;
  let maxD = -1, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > maxD) { maxD = d; idx = i; } }
  if (maxD > eps) { const l = dpSimplify(pts.slice(0, idx + 1), eps), r = dpSimplify(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [pts[0], pts[pts.length - 1]];
}
function splitChains(loop, region) {
  // split the loop where the neighbouring region changes; returns chains [{pts:[[x,y]...], outside:regionId|-1, mid:edge}]
  const nbr = (e) => (e.outside < 0 ? -1 : region[e.outside]);
  if (!loop.length) return [];
  // rotate so the loop starts at a change point
  let start = 0;
  for (let i = 0; i < loop.length; i++) { const p = loop[(i - 1 + loop.length) % loop.length]; if (nbr(p) !== nbr(loop[i])) { start = i; break; } }
  const chains = []; let cur = null;
  for (let k = 0; k < loop.length; k++) {
    const e = loop[(start + k) % loop.length]; const nb = nbr(e);
    if (!cur || cur.outside !== nb) { cur = { pts: [e.a], outside: nb, edges: [] }; chains.push(cur); }
    cur.pts.push(e.b); cur.edges.push(e);
  }
  if (chains.length === 1) { // isolated region: split the ring in two at the farthest point
    const c = chains[0]; const half = Math.floor(c.pts.length / 2);
    return [{ pts: c.pts.slice(0, half + 1), outside: c.outside, edges: c.edges.slice(0, half) }, { pts: c.pts.slice(half), outside: c.outside, edges: c.edges.slice(half) }];
  }
  return chains;
}

// ------------------------------------------------------------------ regularisation (straight edges on the building axis and its 45-degree diagonals)
function dominantAngle(chainsPx) {
  // length-weighted direction histogram (mod 90 degrees) of the outside boundary segments
  const bins = new Float64Array(90);
  for (const pts of chainsPx) for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]; const L = Math.hypot(dx, dy); if (L < 4) continue;
    let a = Math.atan2(dy, dx) * 180 / Math.PI; a = ((a % 90) + 90) % 90; bins[Math.floor(a)] += L;
  }
  const score = (i) => bins[i] + bins[(i + 1) % 90] + bins[(i + 89) % 90];
  let best = 0; for (let i = 0; i < 90; i++) if (score(i) > score(best)) best = i;
  let sx = 0, sy = 0;
  for (let d = -6; d <= 6; d++) { const i = (best + d + 90) % 90; const ang = (i + 0.5) * 4 * Math.PI / 180; sx += bins[i] * Math.cos(ang); sy += bins[i] * Math.sin(ang); }
  const refined = ((Math.atan2(sy, sx) * 180 / Math.PI) / 4 + 90) % 90;
  return Number.isFinite(refined) ? refined : best;
}
function regularizeChain(pts, theta) {
  // snap each segment to the nearest of theta + {0, 45, 90, 135}, merge consecutive segments of one direction into a fitted
  // line, and rebuild the vertices where consecutive lines intersect; chain end points stay fixed (shared with neighbours)
  if (pts.length < 3) return pts;
  const dirs = [0, 45, 90, 135].map((d) => { const a = (theta + d) * Math.PI / 180; return [Math.cos(a), Math.sin(a)]; });
  const classOf = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; let best = 0, bestV = -1; for (let k = 0; k < 4; k++) { const v = Math.abs(dx * dirs[k][0] + dy * dirs[k][1]); if (v > bestV) { bestV = v; best = k; } } return best; };
  const runs = [];
  for (let i = 1; i < pts.length; i++) {
    const c = classOf(pts[i - 1], pts[i]); const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const last = runs[runs.length - 1];
    if (last && last.c === c) { last.pts.push(pts[i]); last.len += L; } else runs.push({ c, pts: [pts[i - 1], pts[i]], len: L });
  }
  // a short run squeezed between two runs of the same direction is jitter: merge the three
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].len < 6 && runs[i - 1].c === runs[i + 1].c) {
      runs[i - 1].pts = runs[i - 1].pts.concat(runs[i].pts.slice(1), runs[i + 1].pts.slice(1));
      runs[i - 1].len += runs[i].len + runs[i + 1].len;
      runs.splice(i, 2); i = Math.max(0, i - 2);
    }
  }
  if (runs.length === 1) return [pts[0], pts[pts.length - 1]];
  const lines = runs.map((r) => {
    const d = dirs[r.c]; const n = [-d[1], d[0]]; let s = 0, wsum = 0;
    for (let i = 0; i < r.pts.length; i++) { const wgt = (i === 0 || i === r.pts.length - 1) ? 0.5 : 1; s += wgt * (r.pts[i][0] * n[0] + r.pts[i][1] * n[1]); wsum += wgt; }
    return { d, n, c: s / wsum };
  });
  const intersect = (L1, L2) => { const det = L1.n[0] * L2.n[1] - L1.n[1] * L2.n[0]; if (Math.abs(det) < 1e-6) return null; return [(L1.c * L2.n[1] - L2.c * L1.n[1]) / det, (L1.n[0] * L2.c - L2.n[0] * L1.c) / det]; };
  const out = [pts[0]];
  for (let i = 0; i < lines.length - 1; i++) {
    const p = intersect(lines[i], lines[i + 1]); const orig = runs[i].pts[runs[i].pts.length - 1];
    out.push(p && Math.hypot(p[0] - orig[0], p[1] - orig[1]) <= 25 ? p : orig);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ------------------------------------------------------------------ geometry / classification
function planeModel(seg, ref) {
  const az = seg.azimuthDegrees * Math.PI / 180, tanP = Math.tan(seg.pitchDegrees * Math.PI / 180);
  const e0 = (seg.center.longitude - ref.lng) * ref.kx, n0 = (seg.center.latitude - ref.lat) * ref.ky;
  const ux = Math.sin(az), uy = Math.cos(az);           // unit vector pointing down-slope (east, north)
  return { seg, z0: seg.planeHeightAtCenterMeters, tanP, ux, uy, e0, n0, pitch: Math.round(degToPitch(seg.pitchDegrees)), az: seg.azimuthDegrees,
    h(e, n) { return this.z0 - this.tanP * ((e - this.e0) * this.ux + (n - this.n0) * this.uy); } };
}
function classifyChain(chain, A, B, geo, insidePx, outsidePx) {
  // A: plane model of the region; B: plane model of the neighbour (null for outside the building)
  const p0 = chain.pts[0], p1 = chain.pts[chain.pts.length - 1];
  const e = [geo.E(p1[0]) - geo.E(p0[0]), geo.N(p1[1]) - geo.N(p0[1])]; const L = Math.hypot(e[0], e[1]) || 1e-9; e[0] /= L; e[1] /= L;
  const mid = chain.pts[Math.floor(chain.pts.length / 2)]; const me = geo.E(mid[0]), mn = geo.N(mid[1]);
  const cIn = geo.center(insidePx), cOut = outsidePx >= 0 ? geo.center(outsidePx) : null;
  if (!B) {
    if (A.pitch < 1) return 'eave';
    const c = Math.abs(e[0] * A.ux + e[1] * A.uy);
    if (c > 0.6) return 'rake';
    return A.h(me, mn) <= A.h(A.e0, A.n0) ? 'eave' : 'unspecified';
  }
  const gap = Math.abs(A.h(me, mn) - B.h(me, mn));
  if (gap > 0.6) { const low = A.h(me, mn) < B.h(me, mn) ? A : B; const c = Math.abs(e[0] * low.ux + e[1] * low.uy); return c > 0.6 ? 'step' : 'wall'; }
  const intoA = A.h(cIn.e, cIn.n) - A.h(cOut.e, cOut.n);      // height change moving from the edge into A
  const intoB = cOut ? B.h(cOut.e, cOut.n) - B.h(cIn.e, cIn.n) : 0;
  const descA = intoA < -1e-4, descB = intoB < -1e-4;
  let azDiff = Math.abs(A.az - B.az) % 360; if (azDiff > 180) azDiff = 360 - azDiff;
  if (A.pitch < 1 || B.pitch < 1) return 'transition';
  if (descA && descB) return azDiff > 150 ? 'ridge' : 'hip';
  if (!descA && !descB) return 'valley';
  return azDiff < 30 ? 'transition' : 'unspecified';
}

// ------------------------------------------------------------------ main
async function traceBuilding(resp, tif, mask, comp, geo, opts) {
  if (AT.v2 && typeof traceBuildingV2 === 'function' && !(opts && opts.v1)) {
    try { const r = traceBuildingV2(resp, tif, mask, comp, geo, opts); if (r && r.facets.length) return r; } catch (e) { console.warn('v2 trace failed, falling back to v1', e); }
  }
  return traceBuildingV1(resp, tif, mask, comp, geo, opts);
}
async function traceBuildingV1(resp, tif, mask, comp, geo, opts) {
  // resp: Solar buildingInsights for this component; returns {facets:[{path,pitch,azimuth}], edges:[{type,path}], unassignedPct}
  const { w, h } = tif;
  const segs = (resp && resp.solarPotential && resp.solarPotential.roofSegmentStats) || [];
  const planes = segs.map((s) => planeModel(s, geo.ref));
  const member = comp.member;
  const label = new Int16Array(w * h).fill(-1);
  let unassigned = 0, total = 0;
  let datum = 0;
  if (planes.length) {
    // plane bounding boxes (in metres, padded) limit which planes a pixel may join
    const boxes = segs.map((s) => ({ e0: (s.boundingBox.sw.longitude - geo.ref.lng) * geo.ref.kx - 1.2, e1: (s.boundingBox.ne.longitude - geo.ref.lng) * geo.ref.kx + 1.2, n0: (s.boundingBox.sw.latitude - geo.ref.lat) * geo.ref.ky - 1.2, n1: (s.boundingBox.ne.latitude - geo.ref.lat) * geo.ref.ky + 1.2 }));
    // the DSM and the plane heights can sit on different vertical datums (ellipsoid vs sea level): estimate the offset
    const perPlane = planes.map(() => []);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = y * w + x; if (!member[i]) continue; const z = tif.data[i]; if (!(z > -1000)) continue;
      const E = geo.E(x + 0.5), N = geo.N(y + 0.5);
      for (let k = 0; k < planes.length; k++) if (E >= boxes[k].e0 + 1.2 && E <= boxes[k].e1 - 1.2 && N >= boxes[k].n0 + 1.2 && N <= boxes[k].n1 - 1.2) perPlane[k].push(z - planes[k].h(E, N));
    }
    const med = (a) => { if (!a.length) return null; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const meds = perPlane.map(med).filter((v) => v != null);
    datum = meds.length ? med(meds) : 0;
    for (const p of planes) p.z0 += datum;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!member[i]) continue; total++;
      const z = tif.data[i]; const E = geo.E(x + 0.5), N = geo.N(y + 0.5);
      if (!(z > -1000)) { label[i] = -2; unassigned++; continue; }
      let best = -1, bestD = AT.tolM, bestAny = -1, bestAnyD = Infinity;
      for (let k = 0; k < planes.length; k++) {
        const d = Math.abs(planes[k].h(E, N) - z);
        const inBox = E >= boxes[k].e0 && E <= boxes[k].e1 && N >= boxes[k].n0 && N <= boxes[k].n1;
        if (inBox && d < bestD) { bestD = d; best = k; }
        if (d < bestAnyD) { bestAnyD = d; bestAny = k; }
      }
      if (best < 0 && bestAnyD < AT.tolM) { const k = bestAny; if (E >= boxes[k].e0 - 2 && E <= boxes[k].e1 + 2 && N >= boxes[k].n0 - 2 && N <= boxes[k].n1 + 2) best = k; }
      if (best < 0) { label[i] = -2; unassigned++; } else label[i] = best;
    }
    // a plane may not claim much more ground than Google measured for it (row houses and duplexes share planes with the
    // unit next door): keep the pixels nearest the plane centre, release the rest
    for (let k = 0; k < planes.length; k++) {
      const gA = segs[k].stats && segs[k].stats.groundAreaMeters2; if (!gA) continue;
      const budget = Math.round(gA / geo.pxM2 * 1.2);
      const idx = []; for (let i = 0; i < w * h; i++) if (label[i] === k) idx.push(i);
      if (idx.length <= budget) continue;
      const d2 = (i) => { const x = i % w, y = (i - x) / w; const dE = geo.E(x + 0.5) - planes[k].e0, dN = geo.N(y + 0.5) - planes[k].n0; return dE * dE + dN * dN; };
      idx.sort((a, b) => d2(a) - d2(b));
      for (let j = budget; j < idx.length; j++) { label[idx[j]] = -2; unassigned++; }
    }
    // large blobs that match none of the roof planes are not this roof (an attached neighbour, a carport, a tree over the
    // mask): drop them from the building; small gaps are filled from their neighbours below
    const un = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) un[i] = member[i] && label[i] === -2 ? 1 : 0;
    for (const blob of allComponents(un, w, h)) {
      if (blob.n * geo.pxM2 < AT.dropBlobM2) continue;
      for (let i = 0; i < w * h; i++) if (blob.member[i]) { member[i] = 0; label[i] = -1; }
    }
  } else {
    for (let i = 0; i < w * h; i++) if (member[i]) { label[i] = 0; total++; }
  }
  let lab = fillUnassigned(label, w, h, member);
  lab = majorityFilter(lab, w, h, member, 2, 2);
  lab = majorityFilter(lab, w, h, member, 1, 3);
  const { region, regions } = regionize(lab, w, h, member, geo.pxM2, AT.minRegionM2);
  const facets = [], edges = [];
  // dominant building axis from the outside boundary of the whole component
  const compRegion = new Int32Array(w * h).fill(-1); for (let i = 0; i < w * h; i++) if (member[i]) compRegion[i] = 0;
  const outerLoop = regionOuterLoop(compRegion, w, h, 0);
  const theta = dominantAngle([dpSimplify(outerLoop.map((e) => e.a), AT.dpEpsPx)]);
  for (const r of regions) {
    if (r.n * geo.pxM2 < AT.minRegionM2) continue;
    const loop = regionOuterLoop(region, w, h, r.id);
    if (loop.length < 4) continue;
    const chains = splitChains(loop, region);
    const poly = [];
    for (const ch of chains) {
      const simp = AT.regularize ? regularizeChain(dpSimplify(ch.pts, AT.dpEpsPx), theta) : dpSimplify(ch.pts, AT.dpEpsPx);
      for (let i = 0; i < simp.length - 1; i++) poly.push(simp[i]);
      const nbRegion = ch.outside;
      if (nbRegion >= 0 && nbRegion < r.id) continue;              // shared chain emitted once, by the lower region id
      const A = planes[r.label] || planeModel({ pitchDegrees: 0, azimuthDegrees: 0, center: { latitude: geo.ref.lat, longitude: geo.ref.lng }, planeHeightAtCenterMeters: 0 }, geo.ref);
      const B = nbRegion >= 0 ? (planes[regions[nbRegion].label] || null) : null;
      const midE = ch.edges[Math.floor(ch.edges.length / 2)];
      const type = classifyChain({ pts: simp }, A, nbRegion >= 0 && !B ? A : B, geo, midE.inside, midE.outside);
      edges.push({ type: nbRegion >= 0 && !B ? 'transition' : type, path: simp.map((p) => tif.toLL(p[0], p[1])) });
    }
    if (poly.length < 3) continue;
    const pl = planes[r.label];
    facets.push({ path: poly.map((p) => tif.toLL(p[0], p[1])), pitch: pl ? pl.pitch : (planes.length ? 0 : state.defaultPitch), azimuth: pl ? pl.az : null, areaM2: r.n * geo.pxM2 });
  }
  return { facets, edges, unassignedPct: total ? Math.round(unassigned / total * 1000) / 10 : 0, planes: planes.length, datum: Math.round(datum * 100) / 100 };
}

async function autoTraceRoof(opts = {}) {
  if (!state.solar) throw new Error('Get roof data first');
  const main = state.solar;
  const bb = main.boundingBox;
  const cLat = main.center.latitude, cLng = main.center.longitude;
  const kx = 111320 * Math.cos(cLat * Math.PI / 180), ky = 110540;
  const halfDiag = Math.hypot((bb.ne.longitude - bb.sw.longitude) * kx, (bb.ne.latitude - bb.sw.latitude) * ky) / 2;
  const radius = Math.min(100, Math.max(15, Math.ceil(halfDiag + 12)));
  if (!opts.quiet) toast('Downloading roof height model...');
  // cache the downloaded rasters per building in this session: re-tracing (or re-printing) the same roof costs nothing extra
  const cacheKey = main.name + '|' + radius;
  const cache = (window.__layerCache = window.__layerCache || {});
  let cached = cache[cacheKey];
  if (!cached) {
    const safe = String(main.name || 'b').replace(/[^A-Za-z0-9]/g, '_') + '_' + radius;
    const mName = '_cache_' + safe + '_mask.tif', dName = '_cache_' + safe + '_dsm.tif';
    let mT = null, dT = null, layers = null;
    if (location.hostname === 'localhost') {
      try { const ok = (await fetch('/reports/' + mName)).ok && (await fetch('/reports/' + dName)).ok; if (ok) { mT = await loadTiff('unused', mName); dT = await loadTiff('unused', dName); layers = { imageryDate: main.imageryDate, fromDiskCache: true }; } } catch (_) { mT = null; }
    }
    if (!mT) {
      layers = await solarDataLayers(cLat, cLng, radius);
      if (!layers.maskUrl || !layers.dsmUrl) throw new Error('Data layers did not include a mask and DSM');
      [mT, dT] = await Promise.all([loadTiff(layers.maskUrl, mName), loadTiff(layers.dsmUrl, dName)]);
    }
    cached = cache[cacheKey] = { layers, maskT: mT, dsmT: dT };
  }
  const { layers, maskT, dsmT } = cached;
  if (maskT.w !== dsmT.w || maskT.h !== dsmT.h) throw new Error('Mask and DSM sizes differ');
  const w = maskT.w, h = maskT.h;
  const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = maskT.data[i] > 0 ? 1 : 0;
  // metres frame relative to the building centre
  const ref = { lat: cLat, lng: cLng, kx, ky };
  const Ecol = new Float64Array(w + 1), Nrow = new Float64Array(h + 1);
  for (let x = 0; x <= w; x++) Ecol[x] = (maskT.toLL(x, 0).lng - cLng) * kx;
  for (let y = 0; y <= h; y++) Nrow[y] = (maskT.toLL(0, y).lat - cLat) * ky;
  const geo = {
    ref, E: (x) => { const i = Math.floor(x); const f = x - i; return i >= w ? Ecol[w] : Ecol[i] + f * (Ecol[Math.min(i + 1, w)] - Ecol[i]); }, N: (y) => { const i = Math.floor(y); const f = y - i; return i >= h ? Nrow[h] : Nrow[i] + f * (Nrow[Math.min(i + 1, h)] - Nrow[i]); },
    pxM2: Math.abs((Ecol[1] - Ecol[0]) * (Nrow[1] - Nrow[0])),
    center: (i) => { const x = i % w, y = (i - x) / w; return { e: (Ecol[x] + Ecol[x + 1]) / 2, n: (Nrow[y] + Nrow[y + 1]) / 2 }; },
    X: (E) => (E - Ecol[0]) / (Ecol[w] - Ecol[0]) * w, Y: (N) => (N - Nrow[0]) / (Nrow[h] - Nrow[0]) * h,
  };
  // keep only mask pixels inside the building's own bounding box (padded); attached neighbours and row houses otherwise merge in
  const padM = 2.5;
  const bE0 = (bb.sw.longitude - cLng) * kx - padM, bE1 = (bb.ne.longitude - cLng) * kx + padM, bN0 = (bb.sw.latitude - cLat) * ky - padM, bN1 = (bb.ne.latitude - cLat) * ky + padM;
  const clipped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const N = geo.N(y + 0.5); if (N < bN0 || N > bN1) continue; for (let x = 0; x < w; x++) { const i = y * w + x; if (!mask[i]) continue; const E = geo.E(x + 0.5); if (E >= bE0 && E <= bE1) clipped[i] = 1; } }
  // the main building is the mask piece that fills Google's building box best (the box centre can fall outside an L-shaped house)
  let sx = -1, sy = -1;
  {
    let pieces = allComponents(clipped, w, h);
    const cx0 = (geo.X(0) || w / 2), cy0 = (geo.Y(0) || h / 2);
    if (!pieces.length) {
      // Google's building box missed the mask (box from older imagery): take the nearest roof piece instead
      const near = allComponents(mask, w, h).filter((pc) => pc.n * geo.pxM2 >= 20 && Math.hypot(pc.cx - cx0, pc.cy - cy0) * Math.sqrt(geo.pxM2) < 20);
      for (const pc of near) for (let i = 0; i < w * h; i++) if (pc.member[i]) clipped[i] = 1;
      pieces = near;
    }
    if (!pieces.length) throw new Error('Building mask is empty at this location');
    let best = null, bestScore = -Infinity;
    for (const pc of pieces) { const d = Math.hypot(pc.cx - cx0, pc.cy - cy0) * Math.sqrt(geo.pxM2); const score = pc.n * geo.pxM2 - d * 2; if (score > bestScore) { bestScore = score; best = pc; } }
    for (let i = 0; i < w * h; i++) if (best.member[i]) { sx = i % w; sy = (i - sx) / w; break; }
  }
  const mainFlood = floodComponent(clipped, w, h, sx, sy);
  if (!mainFlood.n) throw new Error('Building mask is empty inside the building bounds');
  let msx = 0, msy = 0, mminx = w, mmaxx = 0, mminy = h, mmaxy = 0;
  for (let j = 0; j < w * h; j++) if (mainFlood.out[j]) { const px = j % w, py = (j - px) / w; msx += px; msy += py; if (px < mminx) mminx = px; if (px > mmaxx) mmaxx = px; if (py < mminy) mminy = py; if (py > mmaxy) mmaxy = py; }
  const mainComp = { member: mainFlood.out, n: mainFlood.n, cx: msx / mainFlood.n, cy: msy / mainFlood.n, bbox: [mminx, mminy, mmaxx, mmaxy] };
  // everything else in the mask (minus the main building) is a candidate outbuilding
  const rest = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) rest[i] = mask[i] && !mainComp.member[i] ? 1 : 0;
  const comps = allComponents(rest, w, h);
  const results = [];
  const mainRes = await traceBuilding(main, dsmT, mask, mainComp, geo, opts);
  results.push({ comp: mainComp, res: mainRes, resp: main });
  // other structures in the frame (sheds, detached garages): nearest-building lookup gives their planes
  // candidate outbuildings: small, fully inside the frame, close to the main building (large components are neighbours)
  const mainDist = (c) => Math.hypot(geo.E(c.cx) - geo.E(mainComp.cx), geo.N(c.cy) - geo.N(mainComp.cy));
  const others = comps.filter((c) => c !== mainComp && c.n * geo.pxM2 >= AT.minOtherM2 && c.n * geo.pxM2 <= AT.maxOtherM2 && c.bbox[0] > 0 && c.bbox[1] > 0 && c.bbox[2] < w - 1 && c.bbox[3] < h - 1 && mainDist(c) <= AT.maxOtherDistM).sort((a, b) => b.n - a.n).slice(0, AT.maxOtherStructures);
  const mainRoofM2 = (main.solarPotential && main.solarPotential.wholeRoofStats && main.solarPotential.wholeRoofStats.areaMeters2) || 0;
  for (const c of others) {
    if (c.n > mainComp.n * 0.45) continue;                                   // too big for an outbuilding: a neighbour
    const ll = maskT.toLL(c.cx + 0.5, c.cy + 0.5);
    let resp = null;
    try {
      const r = await fetchSolar(ll.lat, ll.lng);
      if (r.name === main.name) continue;                                     // Google says this is part of the main building
      const area = r.solarPotential && r.solarPotential.wholeRoofStats ? r.solarPotential.wholeRoofStats.areaMeters2 : 0;
      if (mainRoofM2 && area > mainRoofM2 * 0.5) continue;                   // a neighbouring house, not a shed
      const inside = r.center && Math.abs((r.center.longitude - ll.lng) * kx) < 8 && Math.abs((r.center.latitude - ll.lat) * ky) < 8;
      resp = inside ? r : null;
    } catch (_) { /* no model for this component */ }
    try { const res = await traceBuilding(resp, dsmT, mask, c, geo, opts); results.push({ comp: c, res, resp }); } catch (_) { /* skip */ }
  }
  // load into the app
  for (const f of state.facets) f.shape.setMap(null); for (const e of state.edges) e.shape.setMap(null);
  state.facets = []; state.edges = []; state.selected = null;
  let fi = 0, mainSqft = 0;
  results.forEach(({ res }, idx) => {
    for (const f of res.facets) { const added = addFacet(f.path, f.pitch, `F${++fi}`); added.azimuth = f.azimuth; if (idx === 0) mainSqft += facetMetrics(added).sloped; }
    for (const e of res.edges) addEdge(e.type, e.path, null);
  });
  state.otherSolar = results.slice(1).map((r) => r.resp).filter(Boolean);
  if (typeof drawSolar === 'function') drawSolar();
  recompute();
  const info = { structures: results.length, facets: fi, edges: state.edges.length, mainSqft: Math.round(mainSqft), unassignedPct: mainRes.unassignedPct, planes: mainRes.planes, datum: mainRes.datum, radius, imageryDate: layers.imageryDate, size: `${w}x${h}` };
  if (!opts.quiet) toast(`Auto-traced ${fi} facets, ${state.edges.length} lines, ${results.length} structure${results.length === 1 ? '' : 's'}`);
  return info;
}

// ------------------------------------------------------------------ batch test (run from the console: await batchTest(50))
async function batchTest(n = 50, box = { latMin: 30.17, latMax: 30.42, lngMin: -81.78, lngMax: -81.50 }, addresses = null) {
  const results = (window.__rows = []); const seen = new Set(); let tries = 0; window.__batchDone = false;
  const queue = addresses ? addresses.slice() : null;
  while (results.filter((r) => !r.skipped).length < (queue ? queue.length + 1e9 : n) && tries < (queue ? queue.length : n * 6)) {
    tries++;
    let lat, lng, address = '';
    if (queue) {
      address = queue[tries - 1];
      try { const g = await geocoder.geocode({ address }); const loc = g.results[0].geometry.location; lat = loc.lat(); lng = loc.lng(); } catch (e) { results.push({ skipped: true, reason: 'geocode failed: ' + address }); continue; }
    } else { lat = box.latMin + Math.random() * (box.latMax - box.latMin); lng = box.lngMin + Math.random() * (box.lngMax - box.lngMin); }
    let b = null;
    try { b = await fetchSolar(lat, lng); } catch (e) { results.push({ skipped: true, reason: 'no building: ' + e.message, lat, lng }); continue; }
    if (seen.has(b.name)) continue; seen.add(b.name);
    const sum = solarSummaryOf(b);
    if (!queue && (!sum || sum.total < 900 || sum.total > 7000)) { results.push({ skipped: true, reason: 'size ' + (sum ? Math.round(sum.total) : '?') }); continue; }
    if (!address) { try { const g = await geocoder.geocode({ location: { lat: b.center.latitude, lng: b.center.longitude } }); address = (g.results[0] && g.results[0].formatted_address) || ''; } catch (_) { /* ignore */ } }
    const t0 = performance.now();
    const row = { address, quality: b.imageryQuality, solarSqft: Math.round(sum.total), planes: sum.segs.length, solarPitch: Math.round(sum.predominant) };
    try {
      state.solar = b; state.otherSolar = []; state.location = { lat: b.center.latitude, lng: b.center.longitude }; state.address = address;
      const info = await autoTraceRoof({ quiet: true });
      const t = computeTotals();
      Object.assign(row, { tracedSqft: Math.round(t.sloped), mainSqft: info.mainSqft, ratio: +(info.mainSqft / sum.total).toFixed(3), facets: t.facetCount, structures: t.structures.length, pitch: t.predominant, center: [b.center.latitude, b.center.longitude],
        eaves: Math.round(t.byType.eave.true), ridges: Math.round(t.byType.ridge.true), hips: Math.round(t.byType.hip.true), valleys: Math.round(t.byType.valley.true), rakes: Math.round(t.byType.rake.true),
        step: Math.round(t.byType.step.true), wall: Math.round(t.byType.wall.true), transition: Math.round(t.byType.transition.true), unspecified: Math.round(t.byType.unspecified.true),
        unassignedPct: info.unassignedPct, recWaste: t.recWaste, ms: Math.round(performance.now() - t0) });
      const pitched = t.pitched > 0;
      row.full = t.facetCount > 0 && row.ratio > 0.85 && row.ratio < 1.2 && row.eaves > 0 && (!pitched || (row.ridges + row.hips) > 0);
    } catch (e) { row.error = e.message; row.full = false; }
    results.push(row);
  }
  window.__batchDone = true;
  return results;
}
