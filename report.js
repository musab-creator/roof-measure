'use strict';
/* Roofr-format roof report for Roof Measure (no logo).
 * Pages: cover, Diagram, Length measurement report, Area measurement report, Pitch & direction measurement report,
 * Structure #n summary (when more than one structure), Report summary, Material calculations.
 * Uses globals from app.js: state, computeTotals, EDGE_TYPES, fmt, ftInR, esc, pitchLabel, segFt, centroid,
 * coveredByEdge, solarSummary, FT_PER_M, $, toast, download, fileBase.
 */

// ------------------------------------------------------------------ company details
const COMPANY_DEFAULT = {
  name: 'Diversity Roofing', phone: '(904) 979-0556',
  address: '6620 Southpoint Dr. S., Suite 600, Jacksonville, FL 32216',
  license: 'CCC1337520', email: '', website: 'diversity-roofing.com', rep: '',
};
const company = Object.assign({}, COMPANY_DEFAULT, JSON.parse(localStorage.getItem('rm.company') || '{}'));
const BLUE = '#2d9cdb';

// ------------------------------------------------------------------ material catalog (Roofr product list; coverage per unit)
// sqft per bundle/roll for shingles & synthetic, linear ft per bundle/roll for starter, ice & water and capping.
const MATERIAL_CATALOG = [
  { group: 'Shingle (total sqft)', base: 'pitched', baseUnit: 'sqft', unit: 'bundle', items: [['IKO - Cambridge', 33.3], ['CertainTeed - Landmark', 32.8], ['GAF - Timberline', 32.8], ['Owens Corning - Duration', 32.8], ['Atlas - Pristine', 33.0]] },
  { group: 'Starter (eaves + rakes)', base: 'starter', baseUnit: 'ft', unit: 'bundle', items: [['IKO - Leading Edge Plus', 120], ['CertainTeed - SwiftStart', 116.25], ['GAF - Pro-Start', 120.33], ['Owens Corning - Starter Strip', 105], ['Atlas - Pro-Cut', 137]] },
  { group: 'Ice and Water (eaves + valleys + flashings)', base: 'iw', baseUnit: 'ft', unit: 'roll', items: [['IKO - StormShield', 65.6], ['CertainTeed - WinterGuard', 65.6], ['GAF - WeatherWatch', 66.7], ['Owens Corning - WeatherLock', 75], ['Atlas - Weathermaster', 65.6]] },
  { group: 'Synthetic (total sqft; no laps)', base: 'pitched', baseUnit: 'sqft', unit: 'roll', items: [['IKO - Stormtite', 1000], ['CertainTeed - RoofRunner', 1000], ['GAF - Deck-Armor', 1000], ['Owens Corning - RhinoRoof', 1000], ['Atlas - Summit', 1000]] },
  { group: 'Capping (hips + ridges)', base: 'cap', baseUnit: 'ft', unit: 'bundle', items: [['IKO - Hip and Ridge', 40], ['CertainTeed - Shadow Ridge', 30], ['GAF - Seal-A-Ridge', 25], ['Owens Corning - DecoRidge', 20], ['Atlas - Pro-Cut H&R', 31]] },
];

// ------------------------------------------------------------------ numbers the Roofr way
const sqOf = (sf) => Math.ceil(sf / 100 * 10) / 10;           // squares to 0.1, rounded up
const sqftUp = (sf) => Math.ceil(sf - 1e-9);                   // whole sqft, rounded up
const ftUp = (ft) => Math.ceil(ft - 1e-9);
const sq1 = (sf) => sqOf(sf).toFixed(1);
// Roofr shows seven waste columns: 0, 10, 12, 15, 17, 20, 22 with the recommended value inserted and the farthest column dropped.
function wasteColumns(rec) {
  const std = [0, 10, 12, 15, 17, 20, 22];
  if (std.includes(rec)) return std;
  const cols = [...std, rec].sort((a, b) => a - b);
  let far = -1, idx = -1; cols.forEach((c, i) => { const d = Math.abs(c - rec); if (d >= far) { far = d; idx = i; } });
  cols.splice(idx, 1);
  return cols;
}
// Material page shows 0%, 10%, recommended and 15%.
function matColumns(rec) { const s = new Set([0, 10, 15, rec]); if (s.size < 4) s.add(12); return [...s].sort((a, b) => a - b); }

function reportData() {
  const t = computeTotals();
  const s = solarSummary();
  const hasTrace = state.facets.length > 0;
  const rec = t.recWaste;                                        // Roofr-method recommended waste (see roofrWaste in app.js)
  return { t, s, hasTrace, rec, wasteCols: wasteColumns(rec), matCols: matColumns(rec) };
}

// ------------------------------------------------------------------ diagram (Roofr style)
const FACET_SHADES = ['#eaf1fa', '#d9e6f5', '#c8daf0', '#b9cfeb', '#aac4e6'];
function facetDirection(x, scope) {
  if (x.f.azimuth != null) { const a = x.f.azimuth * Math.PI / 180; return { dx: Math.sin(a), dy: -Math.cos(a) }; }   // Solar API azimuth: compass direction the plane faces
  // down-slope direction: toward the facet edge that lies on an eave line; else toward the longest edge no other facet shares
  const path = x.m.path;
  const c = centroid(path);
  const eavePaths = scope.edges.filter((e) => e.e.type === 'eave').map((e) => e.m.path);
  let best = null, bestLen = -1, bestEave = false;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    const onEave = coveredByEdge(a, b, eavePaths) || eavePaths.some((ep) => ep.length > 1 && segOnPolyline(a, b, ep));
    const shared = scope.facets.some((y) => y !== x && coveredByEdge(a, b, [[...y.m.path, y.m.path[0]]]));
    const len = segFt(a, b);
    const score = onEave ? 2 : shared ? 0 : 1;
    const bestScore = bestEave ? 2 : best ? 1 : 0;
    if (score > bestScore || (score === bestScore && len > bestLen)) { best = { a, b }; bestLen = len; bestEave = onEave; }
  }
  if (!best) return null;
  const mid = { lat: (best.a.lat + best.b.lat) / 2, lng: (best.a.lng + best.b.lng) / 2 };
  const dx = (mid.lng - c.lng) * Math.cos(c.lat * Math.PI / 180), dy = (mid.lat - c.lat);
  const L = Math.hypot(dx, dy) || 1;
  return { dx: dx / L, dy: -dy / L };                            // screen space: y down
}
function segOnPolyline(a, b, poly) {
  // both endpoints within 0.4 m of the same polyline segment
  for (let i = 1; i < poly.length; i++) if (pointSegM(a, poly[i - 1], poly[i]) < 0.4 && pointSegM(b, poly[i - 1], poly[i]) < 0.4) return true;
  return false;
}
function roofrDiagram(scope, mode, W, H, allShades) {
  const facets = [...scope.facets, ...scope.cutouts];
  const all = [...facets.map((x) => x.m.path), ...scope.edges.map((x) => x.m.path)].flat();
  if (!all.length) return '';
  const o = all[0];
  const kx = 111320 * Math.cos(o.lat * Math.PI / 180) * FT_PER_M, ky = 110540 * FT_PER_M;
  const xy = (p) => ({ x: (p.lng - o.lng) * kx, y: -(p.lat - o.lat) * ky });
  const pts = all.map(xy);
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const pad = 50;
  const sc = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1), (H - 2 * pad) / Math.max(maxY - minY, 1));
  const ox = pad + ((W - 2 * pad) - (maxX - minX) * sc) / 2, oy = pad + ((H - 2 * pad) - (maxY - minY) * sc) / 2;
  const P = (p) => { const q = xy(p); return { x: ox + (q.x - minX) * sc, y: oy + (q.y - minY) * sc }; };
  const pitchRank = {}; (allShades || scope.pitches).forEach((p, i) => { pitchRank[p] = i; });
  const ptsStr = (path) => path.map(P).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, Arial, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>`;
  for (const x of scope.facets) {
    const fill = mode === 'lengths' ? 'none' : FACET_SHADES[(pitchRank[x.f.pitch] || 0) % FACET_SHADES.length];
    s += `<polygon points="${ptsStr(x.m.path)}" fill="${fill}" stroke="${mode === 'lengths' ? '#9fb3c8' : '#4a9bd9'}" stroke-width="${mode === 'lengths' ? 0.6 : 1}" stroke-linejoin="round"/>`;
  }
  for (const x of scope.cutouts) s += `<polygon points="${ptsStr(x.m.path)}" fill="#fff" stroke="#4a9bd9" stroke-width="1" stroke-dasharray="4 3"/>`;
  const text = (x, y, str, size, fill, rot = 0, weight = 'normal') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="middle" dominant-baseline="middle" fill="${fill}" font-weight="${weight}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${esc(str)}</text>`;
  const cx = ox + (maxX - minX) * sc / 2, cy = oy + (maxY - minY) * sc / 2;
  if (mode === 'lengths') {
    for (const { e, m } of scope.edges) {
      const t = EDGE_TYPES[e.type];
      s += `<polyline points="${ptsStr(m.path)}" fill="none" stroke="${t.color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${t.dashed ? 'stroke-dasharray="3 3"' : ''}/>`;
    }
    const edgePaths = scope.edges.map((x) => x.m.path);
    const label = (a, b, ft, fill) => {
      if (ft < 3) return '';
      const A = P(a), B = P(b);
      let ang = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      let nx = -(B.y - A.y), ny = B.x - A.x; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      return text(mx + nx * 8, my + ny * 8, String(ftUp(ft)), 8.5, fill, ang);
    };
    for (const { m } of scope.edges) for (let i = 1; i < m.path.length; i++) s += label(m.path[i - 1], m.path[i], segFt(m.path[i - 1], m.path[i]) * m.factor, '#333');
    for (const x of scope.facets) for (let i = 0; i < x.m.path.length; i++) {
      const a = x.m.path[i], b = x.m.path[(i + 1) % x.m.path.length];
      if (coveredByEdge(a, b, edgePaths)) continue;
      s += label(a, b, segFt(a, b), '#888');
    }
  } else {
    for (const { e, m } of scope.edges) s += `<polyline points="${ptsStr(m.path)}" fill="none" stroke="#4a9bd9" stroke-width="1" stroke-linejoin="round"/>`;
    for (const x of scope.facets) {
      const c = P(centroid(x.m.path));
      if (mode === 'areas') {
        if (x.f.pitch === 0) s += text(c.x, c.y - 7, 'Flat', 9, '#333') + text(c.x, c.y + 5, String(Math.round(x.m.sloped)), 9.5, '#333');
        else s += text(c.x, c.y, String(Math.round(x.m.sloped)), 9.5, '#333');
      } else if (mode === 'pitch') {
        s += text(c.x, c.y, x.f.pitch === 0 ? '0' : String(Number.isInteger(x.f.pitch) ? x.f.pitch : x.f.pitch.toFixed(1)), 10, '#333');
        const d = x.f.pitch === 0 ? null : facetDirection(x, scope);
        if (d) {
          const x1 = c.x + d.dx * 13, y1 = c.y + d.dy * 13, x2 = c.x + d.dx * 24, y2 = c.y + d.dy * 24;
          const ang = Math.atan2(d.dy, d.dx);
          const h1x = x2 - Math.cos(ang - 0.5) * 4, h1y = y2 - Math.sin(ang - 0.5) * 4, h2x = x2 - Math.cos(ang + 0.5) * 4, h2y = y2 - Math.sin(ang + 0.5) * 4;
          s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#333" stroke-width="1"/><polyline points="${h1x.toFixed(1)},${h1y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} ${h2x.toFixed(1)},${h2y.toFixed(1)}" fill="none" stroke="#333" stroke-width="1"/>`;
        }
      }
    }
  }
  // compass rose (Roofr draws a thin cross with a north tick at the bottom right)
  const rx = W - 30, ry = H - 32;
  s += `<g stroke="#555" stroke-width="0.8" fill="none"><line x1="${rx}" y1="${ry - 16}" x2="${rx}" y2="${ry + 16}"/><line x1="${rx - 16}" y1="${ry}" x2="${rx + 16}" y2="${ry}"/><circle cx="${rx}" cy="${ry}" r="3"/></g><polygon points="${rx},${ry - 20} ${rx - 3},${ry - 13} ${rx + 3},${ry - 13}" fill="#555"/><text x="${rx}" y="${ry - 24}" font-size="7" text-anchor="middle" fill="#555">N</text>`;
  return s + '</svg>';
}

// ------------------------------------------------------------------ satellite cover photo (clean, no overlays, like Roofr)
function coverPhotoUrl(R) {
  if (!state.key || !state.location) return '';
  let lat = state.location.lat, lng = state.location.lng;
  if (R.hasTrace) {
    const pts = R.t.facetsAll.flatMap((x) => x.m.path);
    lat = (Math.min(...pts.map((p) => p.lat)) + Math.max(...pts.map((p) => p.lat))) / 2;
    lng = (Math.min(...pts.map((p) => p.lng)) + Math.max(...pts.map((p) => p.lng))) / 2;
  }
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat.toFixed(6)},${lng.toFixed(6)}&zoom=20&size=640x500&scale=2&maptype=satellite&key=${encodeURIComponent(state.key)}`;
}
function imageToDataURL(url, timeoutMs = 7000) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const im = new Image(); im.crossOrigin = 'anonymous';
    const tm = setTimeout(() => resolve(null), timeoutMs);
    im.onload = () => { clearTimeout(tm); try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); resolve(c.toDataURL('image/jpeg', .9)); } catch (e) { resolve(null); } };
    im.onerror = () => { clearTimeout(tm); resolve(null); };
    im.src = url;
  });
}

// ------------------------------------------------------------------ CSS
const REPORT_CSS = `
@page { size: letter; margin: 0; }
.rp { font-family: Inter, "Segoe UI", Arial, Helvetica, sans-serif; color: #222; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.rp * { box-sizing: border-box; }
.rp-page { width: 8.5in; height: 11in; margin: 0 auto; padding: .55in .5in .45in; background: #fff; display: flex; flex-direction: column; position: relative; page-break-after: always; break-after: page; overflow: hidden; font-size: 11px; line-height: 1.4; }
.rp-page:last-child { page-break-after: auto; break-after: auto; }
.rp .prep { position: absolute; top: .3in; right: .5in; font-size: 9px; color: #777; }
.rp h1 { color: ${BLUE}; font-weight: 500; font-size: 34px; margin: 0; letter-spacing: -.3px; }
.rp h2 { color: ${BLUE}; font-weight: 500; font-size: 22px; margin: 0; letter-spacing: -.2px; }
.rp .addr { font-size: 12px; color: #333; margin-top: 4px; }
.rp .cover-row { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 2px; }
.rp .cover-row .l { font-size: 12px; color: #333; }
.rp .cover-row .r { text-align: right; font-size: 12px; color: #333; line-height: 1.6; }
.rp .cover-img { display: block; width: 6.5in; max-height: 5.6in; object-fit: cover; margin: .5in auto 0; }
.rp .cap { width: 6.5in; margin: 6px auto 0; font-size: 11px; color: #333; }
.rp .diagram { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; margin-top: 10px; }
.rp .diagram svg { width: 100%; height: 100%; display: block; }
.rp .legend { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; margin-top: 22px; font-size: 12px; color: #333; }
.rp .legend span::before { content: ""; display: inline-block; width: 18px; height: 4px; background: var(--c); margin-right: 12px; vertical-align: middle; border-radius: 2px; }
.rp .legend span.dashed::before { background: repeating-linear-gradient(90deg, var(--c) 0 4px, transparent 4px 7px); }
.rp .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-top: 22px; font-size: 12.5px; color: #333; }
.rp .note { font-size: 10px; color: #444; margin-top: 10px; line-height: 1.45; }
.rp .foot { display: flex; justify-content: space-between; font-size: 8.5px; color: #555; margin-top: 10px; }
.rp table { width: 100%; border-collapse: collapse; font-size: 11px; }
.rp th, .rp td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #eee; }
.rp th { color: ${BLUE}; font-weight: 500; background: #f6f7f9; }
.rp td.num, .rp th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rp tr.group td { background: #f6f7f9; color: #333; }
.rp .kv td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.rp .sec { color: ${BLUE}; font-weight: 500; font-size: 14px; margin: 16px 0 6px; }
.rp .two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.rp .rec { font-size: 9px; color: #777; font-weight: 400; display: block; }
.rp .mat td, .rp .mat th { padding: 4px 8px; }
.rp .empty { padding: 30px; text-align: center; color: #777; border: 1px dashed #ccc; font-size: 11px; }
.rp table.tight td, .rp table.tight th { padding: 3px 6px; font-size: 10px; }
`;

// ------------------------------------------------------------------ pages
function head(R, title) {
  return `<div class="prep">Prepared by ${esc(company.name)}</div><h2>${title}</h2><div class="addr">${esc(state.address || '')}</div>`;
}
function foot(n) { return `<div class="foot"><span>This report was prepared by ${esc(company.name)}.${company.phone ? ' ' + esc(company.phone) + '.' : ''}</span><span>${n}</span></div>`; }
const page = (inner, n) => `<section class="rp-page">${inner}${foot(n)}</section>`;

function coverPage(R, satSrc, n) {
  const t = R.t;
  const facets = R.hasTrace ? t.facetCount : (R.s ? R.s.segs.length : 0);
  const total = R.hasTrace ? t.sloped : (R.s ? R.s.total : 0);
  const pitch = R.hasTrace ? t.predominant : (R.s ? Math.round(R.s.predominant) : null);
  const imagery = R.s && R.s.imageryDate ? `Google ${new Date(R.s.imageryDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Google satellite imagery';
  return page(`<h1>Roof Report</h1>
    <div class="cover-row"><div class="l">Prepared by ${esc(company.name)}</div><div class="r">${sqftUp(total)} sqft<br>${facets} facets<br>Predominant pitch ${pitch == null ? '-' : pitch === 0 ? 'Flat' : pitchLabel(pitch)}</div></div>
    <div class="addr">${esc(state.address || '')}</div>
    ${typeof permitCoverLine === 'function' ? permitCoverLine() : ''}
    ${satSrc ? `<img class="cover-img" src="${satSrc}" alt="">` : '<div class="empty" style="margin-top:.5in">Satellite image unavailable</div>'}
    <div class="cap">${imagery}</div><div style="flex:1"></div>`, n);
}
function diagramPage(R, n) {
  return page(`${head(R, 'Diagram')}<div class="diagram">${roofrDiagram(R.t, 'outline', 700, 760)}</div>`, n);
}
function lengthPage(R, n) {
  const bt = R.t.byType;
  const legend = `<div class="legend">${Object.entries(EDGE_TYPES).map(([k, v]) => `<span class="${v.dashed ? 'dashed' : ''}" style="--c:${v.color}">${v.plural}: ${ftInR(bt[k].true)}</span>`).join('')}</div>`;
  return page(`${head(R, 'Length measurement report')}${legend}<div class="diagram">${roofrDiagram(R.t, 'lengths', 700, 640)}</div>
    <div class="note">Measurements in diagram are rounded up for display. Some edge lengths may be hidden from diagram to avoid overcrowding.</div>`, n);
}
function areaPage(R, n) {
  const t = R.t;
  return page(`${head(R, 'Area measurement report')}
    <div class="stats"><div>Total roof area: ${sqftUp(t.sloped)} sqft</div><div>Predominant pitch: ${t.predominant == null ? '-' : t.predominant === 0 ? 'Flat' : pitchLabel(t.predominant)}</div>
    <div>Pitched roof area: ${sqftUp(t.pitched)} sqft</div><div>Predominant pitch area: ${sqftUp(t.predArea)} sqft</div>
    <div>Flat roof area: ${sqftUp(t.flat)} sqft</div><div>Unspecified pitch area: 0 sqft</div>
    <div>Two story area: ${sqftUp(t.twoStory)} sqft</div><div></div>
    <div>Two layer area: ${sqftUp(t.twoLayer)} sqft</div><div></div></div>
    <div class="diagram">${roofrDiagram(t, 'areas', 700, 620)}</div>
    <div class="note">Area measurements in diagram are rounded. The totals at the top of the page are the sums of the exact measurements, which are then rounded. Deleted facets (skylights, chimneys, etc.) are designated with a dashed line and are excluded from the calculations.</div>`, n);
}
function pitchPage(R, n) {
  return page(`${head(R, 'Pitch &amp; direction measurement report')}<div class="diagram">${roofrDiagram(R.t, 'pitch', 700, 720)}</div>
    <div class="note">Deleted facets are designated with a dashed line and do not have a pitch.</div>`, n);
}
function measurementsBlock(S, R) {
  const bt = S.byType;
  const rec = S.recWaste != null ? S.recWaste : R.rec, wasteCols = wasteColumns(rec);
  const rows = [
    ['Total roof area', `${sqftUp(S.sloped)} sqft`], ['Total pitched area', `${sqftUp(S.pitched)} sqft`], ['Total flat area', `${sqftUp(S.flat)} sqft`],
    ['Total roof facets', `${S.facetCount} facets`], ['Predominant pitch', S.predominant == null ? '-' : S.predominant === 0 ? '0/12' : pitchLabel(S.predominant)],
    ['Total eaves', ftInR(bt.eave.true)], ['Total valleys', ftInR(bt.valley.true)], ['Total hips', ftInR(bt.hip.true)], ['Total ridges', ftInR(bt.ridge.true)],
    ['Total rakes', ftInR(bt.rake.true)], ['Total wall flashing', ftInR(bt.wall.true)], ['Total step flashing', ftInR(bt.step.true)],
    ['Total transitions', ftInR(bt.transition.true)], ['Total parapet wall', ftInR(bt.parapet.true)], ['Total unspecified', ftInR(bt.unspecified.true)],
    ['Hips + ridges', ftInR(bt.hip.true + bt.ridge.true)], ['Eaves + rakes', ftInR(bt.eave.true + bt.rake.true)],
  ];
  const meas = `<div class="sec">Measurements</div><table class="kv">${rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table>`;
  const pitchT = `<div class="sec">Pitch</div><table><tr><th>Pitch</th>${S.pitches.map((p) => `<th class="num">${p}/12</th>`).join('')}</tr>
    <tr><td>Area (sqft)</td>${S.pitches.map((p) => `<td class="num">${fmt(sqftUp(S.pitchGroups[p]))}</td>`).join('')}</tr>
    <tr><td>Squares</td>${S.pitches.map((p) => `<td class="num">${sq1(S.pitchGroups[p])}</td>`).join('')}</tr></table>`;
  const wasteT = `<div class="sec">Waste</div><table><tr><th>Waste %</th>${wasteCols.map((w) => `<th class="num">${w}%${w === rec ? '<span class="rec">Recommended</span>' : ''}</th>`).join('')}</tr>
    <tr><td>Area (sqft)</td>${wasteCols.map((w) => `<td class="num">${fmt(sqftUp(S.sloped * (1 + w / 100)))}</td>`).join('')}</tr>
    <tr><td>Squares</td>${wasteCols.map((w) => `<td class="num">${sq1(S.sloped * (1 + w / 100))}</td>`).join('')}</tr></table>
    <div class="note">Recommended waste is based on an asphalt shingle roof with a closed valley system (if applicable). Several other factors are involved in determining which waste percentage to use, including the complexity of the roof and individual roof application style. You will also need to calculate the post-waste quantity of other materials needed (hip and ridge caps, starter shingle, etc.).</div>`;
  return `<div class="two"><div>${meas}</div><div>${pitchT}${wasteT}</div></div>`;
}
function structurePage(R, S, n, title) {
  const scope = { facets: S.facets, cutouts: S.cutouts, edges: S.edges, pitches: S.pitches };
  return page(`${head(R, title)}<div class="diagram" style="flex:0 0 3.4in">${roofrDiagram(scope, 'outline', 700, 330, R.t.pitches)}</div>${measurementsBlock(S, R)}<div style="flex:1"></div>`, n);
}
function materialsPage(R, n) {
  const t = R.t, bt = t.byType;
  const bases = { pitched: t.pitched, starter: bt.eave.true + bt.rake.true, iw: bt.eave.true + bt.valley.true + bt.wall.true + bt.step.true, cap: bt.hip.true + bt.ridge.true };
  const cols = R.matCols;
  let rows = '';
  for (const g of MATERIAL_CATALOG) {
    const base = bases[g.base];
    rows += `<tr class="group"><td>${g.group}</td><td></td>${cols.map((w) => `<td class="num">${g.baseUnit === 'sqft' ? fmt(sqftUp(base * (1 + w / 100))) + ' sqft' : ftUp(base * (1 + w / 100)) + ' ft'}</td>`).join('')}</tr>`;
    for (const [name, cov] of g.items) rows += `<tr><td>${name}</td><td>${g.unit}</td>${cols.map((w) => `<td class="num">${base > 0 ? Math.ceil(base * (1 + w / 100) / cov - 1e-9) : 0}</td>`).join('')}</tr>`;
  }
  rows += `<tr class="group"><td>Other</td><td></td>${cols.map(() => '<td></td>').join('')}</tr>`;
  rows += `<tr><td>8' Valley (no laps)</td><td>sheet</td>${cols.map(() => `<td class="num">${Math.ceil(bt.valley.true / 8 - 1e-9)}</td>`).join('')}</tr>`;
  rows += `<tr><td>10' Drip Edge (eaves + rakes; no laps)</td><td>sheet</td>${cols.map(() => `<td class="num">${Math.ceil((bt.eave.true + bt.rake.true) / 10 - 1e-9)}</td>`).join('')}</tr>`;
  return page(`${head(R, 'Material calculations')}
    <table class="mat" style="margin-top:14px"><tr><th>Product</th><th>Unit</th>${cols.map((w) => `<th class="num">Waste (${w}%)</th>`).join('')}</tr>${rows}</table>
    <div class="note">These calculations are estimates and are not guaranteed. Always double check calculations before ordering materials. Estimates are based off of the total pitched area (i.e., flat area is excluded).</div><div style="flex:1"></div>`, n);
}

// ------------------------------------------------------------------ build / print / download
async function buildReportHTML() {
  // permit history / roof age (city permit records, year built); a failed lookup never blocks the report
  if (typeof permitEnsure === 'function') { try { await permitEnsure(); } catch (_) { /* shown as unavailable */ } }
  const R = reportData();
  const url = coverPhotoUrl(R);
  const satSrc = await imageToDataURL(url);
  const satForPrint = satSrc || url;
  const pages = [];
  pages.push((n) => coverPage(R, satForPrint, n));
  if (R.hasTrace) {
    pages.push((n) => diagramPage(R, n), (n) => lengthPage(R, n), (n) => areaPage(R, n), (n) => pitchPage(R, n));
    if (R.t.structures.length > 1) for (const S of R.t.structures) pages.push((n) => structurePage(R, S, n, `Structure #${S.index} summary`));
    pages.push((n) => structurePage(R, R.t, n, 'Report summary'));
  }
  if (typeof permitReportPage === 'function' && state.location) pages.push((n) => page(permitReportPage(head(R, 'Permit history &amp; roof age')), n));
  pages.push((n) => materialsPage(R, n));
  const html = pages.map((fn, i) => fn(i + 1)).join('');
  return { html, R, satSrc, satForPrint };
}
const FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
function standaloneDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Roof Report - ${esc(state.address || '')}</title>${FONT_LINK}<style>${REPORT_CSS}
    body { margin: 0; background: #555; } .rp-page { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
    @media print { body { background: #fff; } .rp-page { margin: 0; box-shadow: none; } }
    .rp-print { position: fixed; top: 10px; right: 10px; background: ${BLUE}; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; font: 600 14px Inter, "Segoe UI", Arial; cursor: pointer; z-index: 9; } @media print { .rp-print { display: none; } }
  </style></head><body><button class="rp-print" onclick="window.print()">Print / Save as PDF</button><div class="rp">${html}</div></body></html>`;
}
async function printReport() {
  toast('Building report...');
  const { html } = await buildReportHTML();
  $('#report').innerHTML = `<style>${REPORT_CSS}</style><div class="rp">${html}</div>`;
  const imgs = [...$('#report').querySelectorAll('img')].filter((i) => !i.complete);
  await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 4000))]);
  window.print();
}
async function downloadReport() {
  toast('Building report...');
  const { html, satSrc, satForPrint } = await buildReportHTML();
  // never ship the API key inside a shareable file: drop the live-URL image if it could not be embedded
  const body = satSrc ? html : html.replace(`<img class="cover-img" src="${satForPrint}" alt="">`, '<div class="empty" style="margin-top:.5in">Satellite image not embedded</div>');
  const doc = standaloneDoc(body);
  const name = fileBase() + '_Roof_Report.html';
  if (location.protocol.startsWith('http') && location.hostname === 'localhost') {
    try { const r = await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: doc }).then((x) => x.json()); if (r.saved) { toast('Saved to reports folder: ' + name); return; } } catch (e) { /* fall through to a browser download */ }
  }
  download(name, doc, 'text/html');
}

// ------------------------------------------------------------------ wiring (runs after app.js)
(function wireReport() {
  if (!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Inter"]')) document.head.insertAdjacentHTML('beforeend', FONT_LINK);
  // the diagram, length, area, pitch and summary pages need a traced roof: trace it automatically when there is none yet
  const ensureTrace = async () => {
    if (state.facets.length) return true;
    if (!state.solar && state.location && typeof runSolar === 'function') await runSolar();
    if (!state.solar) { if (!state.edges.length) { toast('Nothing to report yet. Enter an address and get roof data first.', true); return false; } return true; }
    if (typeof autoTraceRoof !== 'function') return true;
    toast('Tracing the roof for the diagram pages...');
    try { await autoTraceRoof(); } catch (e) { toast('Auto-trace failed (' + e.message + '). Trace the roof by hand to get the diagram pages.', true); }
    return true;
  };
  const run = (fn, btn) => async () => { const b = $(btn); b.disabled = true; try { if (await ensureTrace()) await fn(); } finally { b.disabled = false; } };
  $('#btnReport').onclick = run(printReport, '#btnReport');
  $('#btnReportHTML').onclick = run(downloadReport, '#btnReportHTML');
  for (const k of Object.keys(COMPANY_DEFAULT)) {
    const el = $('#co_' + k); if (!el) continue;
    el.value = company[k] || '';
    el.oninput = () => { company[k] = el.value.trim(); localStorage.setItem('rm.company', JSON.stringify(company)); };
  }
})();
