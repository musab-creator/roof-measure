'use strict';
/* commercial_report.js - the commercial (low-slope) roof report: cover, roof plan, measurements, perimeter / parapets /
 * walls, rooftop equipment & drainage, wind zones & code notes, material estimate, system comparison, method & limits.
 * Uses commercial.js (com, COM, COM_RULES, COM_SYSTEMS, comTotals, comWindZones, comMaterials, SEC_FILL, SQFT, FT)
 * and report.js (REPORT_CSS, FONT_LINK, BLUE, company, page, imageToDataURL).
 */
const COM_CSS = `
.rp .ckpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 14px; }
.rp .ckpi div { background: #f6f7f9; border-radius: 6px; padding: 8px 10px; }
.rp .ckpi b { display: block; font-size: 17px; font-weight: 600; color: #222; }
.rp .ckpi span { font-size: 9.5px; color: #666; text-transform: uppercase; letter-spacing: .3px; }
.rp .lg { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 10.5px; color: #333; margin-top: 8px; }
.rp .lg i { display: inline-block; width: 18px; height: 5px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.rp .lg i.box { height: 10px; width: 12px; border: 1px solid #333; }
.rp .badge { display: inline-block; padding: 1px 6px; border-radius: 9px; font-size: 9.5px; background: #eef4fb; color: #2d6da3; }
.rp td.small, .rp th.small { font-size: 9.5px; color: #555; }
.rp .warn { background: #fff7e6; border: 1px solid #f3d19c; padding: 6px 9px; border-radius: 6px; font-size: 10px; color: #6b4a00; margin-top: 8px; }
.rp ul.notes { margin: 6px 0 0 16px; padding: 0; font-size: 10px; line-height: 1.45; }
.rp table.tight td, .rp table.tight th { padding: 3px 6px; font-size: 10px; }
`;
function comFrame(M, W, H, pad) {
  let phi = M.theta * Math.PI / 180;
  const ext = (ph) => { const c = Math.cos(ph), s = Math.sin(ph); const us = M.outline.map((p) => p[0] * c + p[1] * s), vs = M.outline.map((p) => -p[0] * s + p[1] * c); return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) }; };
  // try the four building-axis rotations; keep north pointing up the page unless that shrinks the drawing by >15%
  const fit = (ee) => Math.min((W - 2 * pad) / Math.max(1e-6, ee.u1 - ee.u0), (H - 2 * pad) / Math.max(1e-6, ee.v1 - ee.v0));
  const opts4 = [0, 1, 2, 3].map((q) => { const ph = phi + q * Math.PI / 2; const ee = ext(ph); return { ph, ee, s: fit(ee), up: -Math.cos(ph) }; });
  const bestS = Math.max(...opts4.map((o) => o.s));
  const pick = opts4.filter((o) => o.s >= 0.85 * bestS).sort((a, b) => a.up - b.up)[0];
  phi = pick.ph; let e = pick.ee;
  const c = Math.cos(phi), s = Math.sin(phi);
  const sc = Math.min((W - 2 * pad) / Math.max(1e-6, e.u1 - e.u0), (H - 2 * pad) / Math.max(1e-6, e.v1 - e.v0));
  const Hfit = Math.min(H, Math.ceil((e.v1 - e.v0) * sc + 2 * pad));   // drawing height fitted to the building
  const ox = (W - (e.u1 - e.u0) * sc) / 2, oy = (Hfit - (e.v1 - e.v0) * sc) / 2;
  const P = (p) => { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; return [ox + (u - e.u0) * sc, oy + (e.v1 - v) * sc]; };
  return { P, sc, phi, H: Hfit, north: [Math.sin(phi), -Math.cos(phi)] };
}
function comDiagram(M, mode, W, H0) {
  const F = comFrame(M, W, H0, mode === 'zones' ? 40 : 56); const P = F.P; const H = F.H;
  const pts = (arr) => arr.map((p) => P(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const line = (a, b, col, wd, extra) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${col}" stroke-width="${wd}" ${extra || ''}/>`;
  let g = '';
  if (mode === 'zones') {
    const T = comTotals(M); const Z = comWindZones(M, T); const wd = Z.widthsFt || { z3: 0, z2: 0, z1: 0 }; const pxOf = (ft) => ft / FT * F.sc;
    g += `<defs><clipPath id="clipOut"><polygon points="${pts(M.outline)}"/></clipPath></defs><polygon points="${pts(M.outline)}" fill="#e8f4fd"/>`;
    g += `<g clip-path="url(#clipOut)"><polygon points="${pts(M.outline)}" fill="none" stroke="#bfe0f7" stroke-width="${(2 * pxOf(wd.z1)).toFixed(1)}" stroke-linejoin="miter" stroke-miterlimit="10"/>`;
    g += `<polygon points="${pts(M.outline)}" fill="none" stroke="#f9d79b" stroke-width="${(2 * pxOf(wd.z2)).toFixed(1)}" stroke-linejoin="miter" stroke-miterlimit="10"/>`;
    for (const sq of (Z.corners || [])) g +=`<polygon points="${pts(sq)}" fill="#f1948a"/>`;
    g += '</g>';
    for (const c of M.courtyards) g += `<polygon points="${pts(c)}" fill="#fff" stroke="#999" stroke-dasharray="4 3"/>`;
    g += `<polygon points="${pts(M.outline)}" fill="none" stroke="#333" stroke-width="1.5"/>`;
  } else {
    M.sections.forEach((s, i) => { if (s.poly.length >= 3) g += `<polygon points="${pts(s.poly)}" fill="${SEC_FILL[i % SEC_FILL.length]}" fill-opacity="0.22" stroke="#9aa" stroke-width="0.6"/>`; });
    for (const c of M.courtyards) g += `<polygon points="${pts(c)}" fill="#fff" stroke="#777" stroke-dasharray="4 3"/>`;
    for (const wl of M.walls) for (const sg of wl.segs) g += line(P(sg[0]), P(sg[1]), wl.kind === 'wall' ? '#2d7dd2' : wl.kind === 'transition' ? '#e67e22' : '#9aa4ad', wl.kind === 'wall' ? 2.6 : 1.4, wl.kind === 'joint' ? 'stroke-dasharray="5 3"' : '');
    for (const e of M.edges) g += line(P(e.a), P(e.b), e.kind === 'parapet' ? '#c0392b' : e.kind === 'tallwall' ? '#2d7dd2' : '#27ae60', e.kind === 'edge' ? 2.6 : 4, 'stroke-linecap="round"');
    if (mode === 'plan') {
      const many = M.objects.length > 60;
      for (const o of M.objects) {
        if (/Obstruction|Expansion/.test(o.type)) continue;
        if (/Vent|penetration/i.test(o.type)) { const c = P(o.center); g += `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="2.2" fill="#555"/>`; continue; }
        g += `<polygon points="${pts(o.corners)}" fill="#fdebd0" stroke="#7d5a1e" stroke-width="0.9"/>`;
        const c = P(o.center); if (!many || o.areaM2 > 4) g += `<text x="${c[0].toFixed(1)}" y="${(c[1] + 3).toFixed(1)}" font-size="7.5" text-anchor="middle" fill="#7d5a1e">${o.id}</text>`;
      }
      for (const s of M.sections) { if (!s.label) continue; const c = P(s.label); const big = s.labelRoomM * F.sc > 24;
        g += `<text x="${c[0].toFixed(1)}" y="${(c[1] - (big ? 2 : -3)).toFixed(1)}" font-size="${big ? 13 : 10}" font-weight="600" text-anchor="middle" fill="#1f3b57">${s.letter}</text>`;
        if (big) g += `<text x="${c[0].toFixed(1)}" y="${(c[1] + 11).toFixed(1)}" font-size="9" text-anchor="middle" fill="#1f3b57">${fmt(s.areaM2 * SQFT)} sf</text>`; }
      for (const wl of M.walls) if (wl.kind === 'wall' && wl.lenM * F.sc > 30) { const c = P(wl.mid); g += `<text x="${(c[0] + 4).toFixed(1)}" y="${(c[1] - 4).toFixed(1)}" font-size="8.5" fill="#2d7dd2">${fmt(wl.heightM * FT, 1)}' wall</text>`; }
    }
    M.edges.forEach((e, i) => {
      const a = P(e.a), b = P(e.b); const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (mode === 'plan' && L < 34) return; if (mode === 'edges' && L < 12) return;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; // outward: CCW in plan becomes clockwise on screen (y down)
      const tx = m[0] + nx * 10, ty = m[1] + ny * 10 + 3; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      g += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${mode === 'edges' ? 9 : 8.5}" text-anchor="middle" fill="${e.kind === 'parapet' ? '#922b21' : e.kind === 'tallwall' ? '#1f5f9e' : '#1e8449'}" transform="rotate(${ang.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})">${mode === 'edges' ? 'E' + (i + 1) : fmt(e.lenM * FT) + "'"}</text>`;
    });
  }
  const nv = F.north;
  g += `<g transform="translate(${W - 30},34)"><line x1="${(-nv[0] * 14).toFixed(1)}" y1="${(-nv[1] * 14).toFixed(1)}" x2="${(nv[0] * 14).toFixed(1)}" y2="${(nv[1] * 14).toFixed(1)}" stroke="#333" stroke-width="1.6" marker-end="url(#arr)"/><text x="${(nv[0] * 25).toFixed(1)}" y="${(nv[1] * 25 + 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="#333">N</text></g>`;
  const ftPerPx = FT / F.sc; const nice = [10, 20, 25, 50, 100, 200, 250, 500].find((v) => v / ftPerPx >= 70) || 500; const bw = nice / ftPerPx;
  g += `<g transform="translate(20,${H - 16})"><rect x="0" y="0" width="${bw.toFixed(1)}" height="5" fill="#333"/><rect x="${(bw / 2).toFixed(1)}" y="0" width="${(bw / 2).toFixed(1)}" height="5" fill="#fff" stroke="#333" stroke-width="0.8"/><text x="0" y="-4" font-size="9" fill="#333">0</text><text x="${bw.toFixed(1)}" y="-4" font-size="9" text-anchor="end" fill="#333">${nice} ft</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>${g}</svg>`;
}
function comCoverUrl(M) {
  if (!state.key || !M.outline.length) return '';
  const xs = M.outline.map((p) => p[0]), ys = M.outline.map((p) => p[1]); const c = M.toLL([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * 640 / 500) * 1.25;
  const z = Math.max(15, Math.min(20, Math.floor(Math.log2(156543.03392 * Math.cos(c.lat * Math.PI / 180) * 640 / Math.max(10, ext)))));
  const path = M.outline.concat([M.outline[0]]).map(M.toLL).map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
  return `https://maps.googleapis.com/maps/api/staticmap?center=${c.lat.toFixed(6)},${c.lng.toFixed(6)}&zoom=${z}&size=640x500&scale=2&maptype=satellite${path.length < 6000 ? `&path=color:0xff3b30ff|weight:3|${path}` : ''}&key=${encodeURIComponent(state.key)}`;
}
function comDir(az) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8]; }
function comPages(M, sat) {
  const T = comTotals(M); const Z = comWindZones(M, T); const sysKey = com.opts.system in COM_SYSTEMS ? com.opts.system : 'tpo_ma';
  const waste = Number.isFinite(com.opts.waste) ? com.opts.waste : 10; const MAT = comMaterials(M, T, sysKey, waste);
  const addr = M.address || state.address || '';
  const head2 = (title) => `<div class="prep">Prepared by ${esc(company.name)}</div><h2>${title}</h2><div class="addr">${esc(addr)}</div>`;
  const imagery = M.imageryDate ? `Google imagery ${new Date(M.imageryDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Google imagery';
  const slopeTxt = (s) => (s.steep ? `${fmt(s.slope * 12, 1)}/12` : `${fmt(s.slope * 12, 2)}"/ft`);
  const pages = [];
  // 1 cover
  pages.push(`<h1>Commercial Roof Report</h1>
    <div class="cover-row"><div class="l">Prepared by ${esc(company.name)}${company.license ? '<br>License ' + esc(company.license) : ''}${company.rep ? '<br>' + esc(company.rep) : ''}</div><div class="r">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${M.buildingName ? '<br>' + esc(M.buildingName) : ''}</div></div>
    <div class="addr">${esc(addr)}</div>
    ${typeof permitCoverLine === 'function' ? permitCoverLine() : ''}
    <div class="ckpi"><div><b>${fmt(T.totalSF)}</b><span>Total roof sqft</span></div><div><b>${fmt(T.squares, 1)}</b><span>Squares</span></div><div><b>${M.sections.length}</b><span>Roof sections</span></div><div><b>${T.heightFt ? fmt(T.heightFt) + "'" : '-'}</b><span>Roof height</span></div>
    <div><b>${fmt(T.perimLF)}'</b><span>Perimeter</span></div><div><b>${fmt(T.parLF)}'</b><span>Parapet wall</span></div><div><b>${T.rtus.length}</b><span>HVAC units</span></div><div><b>${T.predSlope == null ? 'Steep' : fmt(T.predSlope, 2) + '"/ft'}</b><span>Main slope</span></div></div>
    ${sat ? `<img class="cover-img" style="margin-top:.25in;max-height:5in" src="${sat}" alt="">` : '<div class="empty" style="margin-top:.4in">Satellite image unavailable</div>'}
    <div class="cap">${imagery}. Red line: measured roof outline.</div><div style="flex:1"></div>`);
  // 2 roof plan
  pages.push(`${head2('Roof plan')}
    <div class="lg"><span><i style="background:#c0392b"></i>Parapet wall</span><span><i style="background:#27ae60"></i>Open roof edge</span><span><i style="background:#2d7dd2"></i>Wall between levels</span><span><i style="background:#9aa4ad"></i>Level joint</span><span><i style="background:#e67e22"></i>Slope transition</span><span><i class="box" style="background:#fdebd0"></i>Rooftop unit (numbered)</span><span><i style="background:#555;width:6px;height:6px;border-radius:3px"></i>Vent / penetration</span></div>
    <div class="diagram">${comDiagram(M, 'plan', 720, 760)}</div>
    <div class="note">Sections are lettered by size and labelled with plan area. Outline labels are plan lengths in feet. Wall labels give the height of the step between roof levels.</div>`);
  // 3 measurements
  const secRows = M.sections.slice(0, 20).map((s) => `<tr><td>${s.letter}</td><td class="num">${fmt(s.areaM2 * SQFT)}</td><td class="num">${fmt(s.areaM2 * SQFT / 100, 1)}</td><td class="num">${slopeTxt(s)}</td><td>${s.steep ? 'Steep' : 'Low-slope'}</td><td class="num">${s.elevM != null ? fmt(s.elevM * FT, 1) + "'" : '-'}</td><td class="num">${s.azimuth == null || s.slope < 0.004 ? 'Level' : comDir(s.azimuth)}</td></tr>`).join('');
  const kv = [['Total roof area', `${fmt(T.totalSF)} sqft`], ['Total squares', fmt(T.squares, 1)], ['Low-slope area (plan)', `${fmt(T.lowSF)} sqft`], ['Steep-slope area (sloped)', `${fmt(T.steepSF)} sqft`],
    ['Roof sections / levels', String(M.sections.length)], ['Roof height (main section)', T.heightFt ? `${fmt(T.heightFt, 1)} ft` : '-'], ['Highest roof level', M.maxElevM ? `${fmt(M.maxElevM * FT, 1)} ft` : '-'],
    ['Perimeter', `${fmt(T.perimLF)} LF`], ['Parapet wall', `${fmt(T.parLF)} LF`], ['Average parapet height', T.parLF ? `${fmt(T.parAvgFt, 1)} ft` : '-'], ['Open roof edge', `${fmt(T.edgeLF)} LF`],
    ['Walls between levels', `${fmt(T.wallLF)} LF`], ['Wall flashing, parapets', `${fmt(T.parFlashSF)} sqft`], ['Wall flashing, interior walls', `${fmt(T.wallFlashSF)} sqft`], ['Curb flashing, rooftop units', `${fmt(T.curbLF)} LF`],
    ['Penetrations: count / area / perimeter', `${T.pens.length} / ${fmt(T.penAreaSF)} sqft / ${fmt(T.penPerimLF)} LF`], ['Total roof area less penetrations', `${fmt(T.totalSF - T.penAreaSF)} sqft`],
    ['Building corners outside / inside', `${M.convex} / ${M.reflex}`], ['Courtyards / open wells', String(M.courtyards.length)]];
  const wasteCols = [0, 5, 10, 12, 15, 20];
  pages.push(`${head2('Measurements')}
    <div class="two"><div><div class="sec">Summary</div><table class="kv">${kv.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table></div>
    <div><div class="sec">Waste</div><table><tr><th>Waste</th>${wasteCols.map((w) => `<th class="num">${w}%</th>`).join('')}</tr><tr><td>Area (sqft)</td>${wasteCols.map((w) => `<td class="num">${fmt(T.totalSF * (1 + w / 100))}</td>`).join('')}</tr><tr><td>Squares</td>${wasteCols.map((w) => `<td class="num">${fmt(T.squares * (1 + w / 100), 1)}</td>`).join('')}</tr></table>
    <div class="note">Typical waste: 10% for single-ply membranes, 12-15% for modified bitumen on cut-up roofs, 5% for insulation boards.</div>
    <div class="sec">Roof sections</div><table><tr><th>Sec</th><th class="num">Plan sqft</th><th class="num">Sq</th><th class="num">Slope</th><th>Type</th><th class="num">Height</th><th class="num">Falls to</th></tr>${secRows}</table>${M.sections.length > 20 ? `<div class="note">${M.sections.length - 20} small sections not listed; included in totals.</div>` : ''}</div></div>
    <div style="flex:1"></div>`);
  // 4 perimeter, parapets and walls (long perimeters continue on extra pages; rows are budgeted to fit 11 in)
  const flashOf = (e) => (e.kind === 'parapet' ? e.lenM * FT * (e.parapetM * FT <= 4 ? e.parapetM * FT + COM_RULES.wallFlashExtraFt : COM_RULES.wallStepFlashMaxFt) : e.kind === 'tallwall' ? e.lenM * FT * COM_RULES.wallStepFlashMaxFt : 0);
  const edgeRows = M.edges.map((e, i) => `<tr><td>E${i + 1}${e.court ? '*' : ''}</td><td class="num">${fmt(e.lenM * FT, 1)}</td><td>${e.kind === 'parapet' ? 'Parapet' : e.kind === 'tallwall' ? 'High wall' : 'Open edge'}</td><td class="num">${e.kind !== 'edge' ? fmt(e.parapetM * FT, 1) + "'" : (e.parapetM > 0.05 ? fmt(e.parapetM * FT * 12) + '" curb' : '-')}</td><td class="num">${e.kind !== 'edge' ? fmt(flashOf(e)) : '-'}</td><td class="num">${Number.isFinite(e.dropM) ? fmt(e.dropM * FT, 1) + "'" : '-'}</td></tr>`);
  const wallAll = M.walls.map((wl) => `<tr><td>${wl.a} / ${wl.b}</td><td>${wl.kind === 'wall' ? 'Wall (' + wl.higher + ' higher)' : wl.kind === 'joint' ? 'Level joint' : 'Slope transition'}</td><td class="num">${fmt(wl.lenM * FT, 1)}</td><td class="num">${fmt(wl.heightM * FT, 1)}'</td></tr>`);
  const edgeTable = (rows) => `<table class="tight"><tr><th>Edge</th><th class="num">Length ft</th><th>Type</th><th class="num">Parapet</th><th class="num">Flash sqft</th><th class="num">Edge ht</th></tr>${rows.join('')}</table>`;
  const wallTable = (rows) => `<div class="sec">Between roof levels</div><table class="tight"><tr><th>Sections</th><th>Type</th><th class="num">Length ft</th><th class="num">Height</th></tr>${rows.join('')}</table>`;
  const wallsHere = wallAll.slice(0, 6);
  const avail = 935 - 75 - 288 - (T.parLF ? 72 : 0) - (wallsHere.length ? 56 + 19 * wallsHere.length : 0) - 60 - 22;
  const perCol = Math.max(4, Math.floor(avail / 19)); const first = edgeRows.slice(0, perCol * 2); const h1 = Math.ceil(first.length / 2);
  pages.push(`${head2('Perimeter, parapets &amp; walls')}
    <div class="diagram" style="flex:0 0 3in">${comDiagram(M, 'edges', 720, 290)}</div>
    <div class="two"><div>${edgeTable(first.slice(0, h1))}</div><div>${first.length > h1 ? edgeTable(first.slice(h1)) : ''}</div></div>
    ${T.parLF ? `<div class="sec">Parapet wall area by height</div><table class="tight"><tr><th>Height</th>${[1, 2, 3, 4, 5, 6, 7].map((hh) => `<th class="num">${hh} ft</th>`).join('')}<th class="num">Measured</th></tr><tr><td>Area sqft</td>${[1, 2, 3, 4, 5, 6, 7].map((hh) => `<td class="num">${fmt(T.parLF * hh)}</td>`).join('')}<td class="num">${fmt(T.parLF * T.parAvgFt)}</td></tr></table>` : ''}
    ${wallsHere.length ? wallTable(wallsHere) : ''}
    <div class="note">Parapet height runs from the roof surface to the top of the wall. Flashing runs up and over parapets up to 4 ft (height + ${COM_RULES.wallFlashExtraFt} ft); taller walls get ${COM_RULES.wallStepFlashMaxFt} ft with termination bar and counter-flashing. Edge height is the roof surface above the ground or lower roof outside the edge.${M.edges.some((e) => e.court) ? ' * = courtyard edge.' : ''}${edgeRows.length > first.length ? ' Continued on the next page.' : ''}</div><div style="flex:1"></div>`);
  for (let start = first.length, wStart = wallsHere.length; start < edgeRows.length || wStart < wallAll.length;) {
    // a continuation page holds up to 72 edges (36 per column), or a short edge list plus up to 10 wall rows
    const chunk = edgeRows.slice(start, start + 72); const wl = chunk.length <= 30 ? wallAll.slice(wStart, wStart + 10) : []; const hc = Math.ceil(chunk.length / 2);
    pages.push(`${head2('Perimeter, parapets &amp; walls (continued)')}
      ${chunk.length ? `<div class="two" style="margin-top:10px"><div>${edgeTable(chunk.slice(0, hc))}</div><div>${chunk.length > hc ? edgeTable(chunk.slice(hc)) : ''}</div></div>` : ''}
      ${wl.length ? wallTable(wl) : ''}<div style="flex:1"></div>`);
    start += chunk.length; wStart += wl.length; if (!chunk.length && !wl.length) break;
  }
  // 5 rooftop equipment, penetrations and drainage
  const objs = M.objects.filter((o) => !/Obstruction/.test(o.type));
  const objRow = (o) => `<tr><td>${o.id}</td><td>${o.type.replace(/ \/ .*/, '')}</td><td class="num">${fmt(o.lenM * FT, 1)}x${fmt(o.widM * FT, 1)}</td><td class="num">${fmt(o.hM * FT, 1)}'</td></tr>`;
  const objHead = '<tr><th>#</th><th>Type</th><th class="num">Size ft</th><th class="num">Ht</th></tr>';
  const shownObj = objs.slice(0, 44); const oh = Math.ceil(shownObj.length / 2);
  const counts = {}; for (const o of M.objects) counts[o.type] = (counts[o.type] || 0) + 1;
  pages.push(`${head2('Rooftop equipment, penetrations &amp; drainage')}
    <div class="two"><div><div class="sec">Counts</div><table class="kv tight">${Object.entries(counts).map(([kk, v]) => `<tr><td>${kk}</td><td>${v}</td></tr>`).join('') || '<tr><td>No raised objects detected</td><td>0</td></tr>'}
      <tr><td>Penetrations total (area / perimeter)</td><td>${fmt(T.penAreaSF)} sqft / ${fmt(T.penPerimLF)} LF</td></tr><tr><td>Curb flashing, curbed items</td><td>${fmt(T.curbLF)} LF</td></tr><tr><td>Skylights / roof hatches (entered)</td><td>${T.skylights} / ${T.hatches}</td></tr></table></div>
    <div><div class="sec">Drainage</div><table class="kv tight"><tr><td>Primary roof drains</td><td>${T.drains}${!T.drainsEntered ? ' (estimate)' : ''}</td></tr><tr><td>Overflow scuppers / secondary drains</td><td>${T.scuppers}</td></tr><tr><td>Open edges (gutter / edge metal)</td><td>${fmt(T.edgeLF)} LF</td></tr>${M.sections.filter((s) => !s.steep).slice(0, 6).map((s) => `<tr><td>Section ${s.letter} slope</td><td>${fmt(s.slope * 12, 2)}"/ft${s.slope * 12 < 0.25 ? ' <span class="badge">under 1/4"</span>' : ''}</td></tr>`).join('')}</table>
    <div class="note">Drains are estimated at one per ${fmt(COM_RULES.drainSqft)} sqft of low-slope roof unless entered. Sections under 1/4" per ft need tapered insulation or crickets on a new roof.</div></div></div>
    <div class="sec">Detected rooftop objects (numbers match the roof plan)</div>${shownObj.length ? `<div class="two"><div><table class="tight">${objHead}${shownObj.slice(0, oh).map(objRow).join('')}</table></div><div>${oh < shownObj.length ? `<table class="tight">${objHead}${shownObj.slice(oh).map(objRow).join('')}</table>` : ''}</div></div>${objs.length > shownObj.length ? `<div class="note">${objs.length - shownObj.length} more small objects are included in the counts.</div>` : ''}` : '<div class="empty">No rooftop units or penetrations detected.</div>'}
    ${counts['Obstruction / tree overhang'] ? '<div class="warn">Tree canopy or another tall obstruction covers part of the roof. The roof under it is estimated from the surrounding roof.</div>' : ''}<div style="flex:1"></div>`);
  // 6 wind zones and code
  const zz = Z.zones || {}; const zsum = (zz.z1p || 0) + (zz.z1 || 0) + (zz.z2 || 0) + (zz.z3 || 0); const pct = (v) => (zsum ? fmt((v || 0) / zsum * 100) + '%' : '-');
  pages.push(`${head2('Wind zones &amp; code notes')}
    <div class="lg"><span><i class="box" style="background:#e8f4fd"></i>Zone 1' (interior)</span><span><i class="box" style="background:#bfe0f7"></i>Zone 1 (field)</span><span><i class="box" style="background:#f9d79b"></i>Zone 2 (perimeter)</span><span><i class="box" style="background:#f1948a"></i>Zone 3 (corners)</span></div>
    <div class="diagram" style="flex:0 0 3.6in">${comDiagram(M, 'zones', 720, 340)}</div>
    <div class="two"><div><div class="sec">Roof wind zones (ASCE 7-22, roof slope 7&deg; or less)</div><table><tr><th>Zone</th><th class="num">Band</th><th class="num">Area sqft</th><th class="num">Share</th></tr>
      <tr><td>Zone 1' interior</td><td class="num">${Z.widthsFt && Z.widthsFt.z1 ? 'beyond ' + fmt(Z.widthsFt.z1, 1) + "'" : 'none'}</td><td class="num">${fmt(zz.z1p || 0)}</td><td class="num">${pct(zz.z1p)}</td></tr>
      <tr><td>Zone 1 field</td><td class="num">${Z.widthsFt && Z.widthsFt.z1 ? fmt(Z.widthsFt.z2, 1) + "'-" + fmt(Z.widthsFt.z1, 1) + "'" : 'rest'}</td><td class="num">${fmt(zz.z1 || 0)}</td><td class="num">${pct(zz.z1)}</td></tr>
      <tr><td>Zone 2 perimeter</td><td class="num">${Z.widthsFt ? '0-' + fmt(Z.widthsFt.z2, 1) + "'" : '-'}</td><td class="num">${fmt(zz.z2 || 0)}</td><td class="num">${pct(zz.z2)}</td></tr>
      <tr><td>Zone 3 corners</td><td class="num">${Z.tallParapet ? 'as zone 2' : Z.widthsFt ? fmt(Z.widthsFt.z3, 1) + "' x " + fmt(Z.widthsFt.z3d, 1) + "' L" : '-'}</td><td class="num">${fmt(zz.z3 || 0)}</td><td class="num">${pct(zz.z3)}</td></tr></table>
      <div class="note">${Z.note || ''} Mean roof height h = ${fmt(Z.hFt, 1)} ft. Fastening patterns must come from the manufacturer's uplift design for the approved system.</div></div>
    <div><div class="sec">Code notes (Jacksonville, FL)</div><ul class="notes">${COM_CODE_NOTES.map((t) => `<li>${t}</li>`).join('')}</ul></div></div><div style="flex:1"></div>`);
  // 7 material estimate (continues on a second page when the list is long)
  const grp = {}; for (const r of MAT.rows) (grp[r.group] = grp[r.group] || []).push(r);
  const groupHtml = ([gname, rows]) => `<tr class="group"><td colspan="4">${gname}</td></tr>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.qty)}</td><td>${esc(r.unit)}</td><td class="small">${esc(r.note)}</td></tr>`).join('')}`;
  const entries = Object.entries(grp); const matPages = [[]]; let used = 0;
  for (const en of entries) { const n = en[1].length + 1; if (used + n > 25 && matPages[matPages.length - 1].length) { matPages.push([]); used = 0; } matPages[matPages.length - 1].push(en); used += n; }
  const matHead = '<tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="small">Basis</th></tr>';
  matPages.forEach((list, pi) => pages.push(`${head2(pi ? 'Material estimate (continued)' : 'Material estimate')}
    ${pi ? '' : `<div class="addr" style="margin-top:8px"><b>${esc(MAT.system)}</b> &middot; ${MAT.wastePct}% waste on membrane${MAT.insul.length ? ` &middot; insulation ${MAT.insul.map((th) => th + '"').join(' + ')} polyiso${com.opts.cover && sysKey !== 'silicone' ? ' + 1/2" HD cover board' : ''} = R-${fmt(MAT.rTotal, 1)}` : ''}</div>`}
    <table class="mat tight" style="margin-top:10px">${matHead}${list.map(groupHtml).join('')}</table>
    ${pi === matPages.length - 1 ? '<div class="note">Estimates from the measured roof and typical manufacturer coverage. Confirm against the approved system\'s installation guide, Florida Product Approval and the uplift design before ordering. Tear-off, deck repair and wet insulation replacement are not included.</div>' : ''}<div style="flex:1"></div>`));
  // 8 system comparison
  const mats = Object.keys(COM_SYSTEMS).map((kk) => comMaterials(M, T, kk, COM_RULES.wasteDefault[COM_SYSTEMS[kk].mem] || 10));
  const mainQ = (m) => m.rows.filter((r) => /Membrane|Coating|Attachment|Seams/.test(r.group)).map((r) => `${fmt(r.qty)} ${r.unit} - ${esc(r.name)}`).join('<br>');
  pages.push(`${head2('Roof system comparison')}
    <div class="note" style="margin-top:8px">Main membrane quantities for the same measured roof: ${fmt(T.lowSF)} sqft low-slope field, ${fmt(T.parFlashSF + T.wallFlashSF)} sqft wall flashing, ${fmt(T.curbLF)} LF of curbs. Insulation, metal and drainage are the same for every system except coatings (no tear-off, no insulation).</div>
    <table style="margin-top:10px"><tr><th>System</th><th>Main quantities (waste included)</th></tr>${mats.map((m) => `<tr><td style="width:2.2in">${esc(m.system)}<br><span class="small">${m.wastePct}% waste</span></td><td class="small">${mainQ(m)}</td></tr>`).join('')}</table>
    <div class="sec">Shared items</div><table class="kv"><tr><td>Coping cap, parapets</td><td>${Math.ceil(T.parLF / COM_RULES.copingFt)} pcs (${fmt(T.parLF)} LF)</td></tr><tr><td>Edge metal, open edges</td><td>${Math.ceil(T.edgeLF / COM_RULES.edgeMetalFt)} pcs (${fmt(T.edgeLF)} LF)</td></tr><tr><td>Termination bar</td><td>${Math.ceil((T.parLF + T.wallLF) / COM_RULES.termBarFt)} pcs</td></tr><tr><td>Insulation boards per layer (4' x 8', 5% waste)</td><td>${fmt(Math.ceil(T.lowSF / 32 * 1.05))}</td></tr><tr><td>Drains / overflow</td><td>${T.drains} / ${T.scuppers}</td></tr></table><div style="flex:1"></div>`);
  // 9 permit history and roof age
  if (typeof permitReportPage === 'function' && state.location) pages.push(permitReportPage(head2('Permit history &amp; roof age')));
  // 9 method and limits
  pages.push(`${head2('Method, assumptions &amp; limits')}
    <ul class="notes" style="margin-top:12px">
      <li>Measured from Google's roof mask and 3D surface model (${M.px} m pixels; ${imagery}). Low-slope areas are plan areas; steep-slope sections use sloped area.</li>
      <li>The outline is squared to the building's main axes. Roof sections are split by elevation and slope; walls between levels are reported with their height.</li>
      <li>Parapets are perimeter walls standing ${fmt(COM.parapetMinM * FT * 12)}" or more above the roof surface. Lower raised edges are listed as curbs on open edges.</li>
      <li>Rooftop objects are anything ${fmt(COM.objMinH * FT * 12)}" or more above the roof: larger ones are rooftop units or curbs, small ones vents, pipes and fans. Small pipes, drains, flush skylights and hatches may not show in the surface model; enter them in the panel.</li>
      <li>Drain counts are estimates unless entered. Verify drains, scuppers, gutters, deck type, existing layers and moisture on site (core cuts or a moisture survey).</li>
      <li>Imagery can be months or years old; changes after the image date are not shown.</li>
      <li>This report is for estimating. It is not a survey, an engineering document or a wind uplift design.</li>
    </ul>
    <div class="sec">Data</div><table class="kv"><tr><td>Imagery date</td><td>${M.imageryDate || '-'}</td></tr><tr><td>Imagery quality</td><td>${M.quality || '-'}</td></tr><tr><td>Raster pixel size</td><td>${M.px} m</td></tr><tr><td>Roof mask area / squared outline area</td><td>${fmt(M.pixelAreaM2 * SQFT)} / ${fmt(M.planM2 * SQFT)} sqft</td></tr><tr><td>Processing time</td><td>${M.ms ? (M.ms / 1000).toFixed(1) + ' s' : '-'}</td></tr></table><div style="flex:1"></div>`);
  return pages.map((inner, i) => page(inner, i + 1)).join('');
}
const COM_CODE_NOTES = [
  'Florida Building Code 8th Edition (2023), in force since Dec 31, 2023, with ASCE 7-22 wind loads. Reroofing: FBC 1511 and Existing Building Code 706.',
  'Wind (COJ Ordinance 320.103): Risk Category II design speed 125 mph west of the St. Johns River / I-95 line, 130 mph east of it. Many commercial buildings are Risk Category III or IV; confirm with the ASCE 7 Hazard Tool.',
  'Roof covering must be Florida Product Approved and tested for uplift (FM 4474 / UL 580 / UL 1897); edge metal and coping to ANSI/SPRI ES-1 (FBC 1504.5).',
  'New low-slope roofs need 1/4" per ft to drains (FBC 1507); a reroof is exempt if it has positive drainage (FBC 1511.1). Crickets go on the high side of any curb wider than 30" (FBC 1503.6).',
  'Parapet roofs need secondary drainage (FBC-P 1108): overflow scuppers at least 4" high set 2-4" above the roof, or overflow drains, discharging separately. Jacksonville 100-yr 1-hr rainfall is about 4.3 in/hr (NOAA Atlas 14: 5.6).',
  'Insulation: climate zone 2A requires R-25 continuous above the deck when a roof is replaced (FBC-EC Table C402.1.3, C503.2.1); a recover is exempt. Example: 2 x 2.2" polyiso, or 2 x 2.0" polyiso + 1/2" HD cover board.',
  'Tear off to the deck if the roof is wet, deteriorated, blistered, or already has two or more coverings (FBC-EB 706.3). No more than 25% of a roof section may be replaced in 12 months without bringing the section to current code (706.1.1).',
  'Rooftop units sit on curbs at least 8" high (FBC 1510.10). File the Notice of Commencement before the first inspection when the contract is over $5,000 (F.S. 713.135). Permits through JAXEPICS.',
];
async function comBuild(M) {
  if (typeof permitEnsure === 'function') { try { await permitEnsure(); } catch (_) { /* shown as unavailable */ } }
  const url = comCoverUrl(M); const sat = await imageToDataURL(url, 9000); return { html: comPages(M, sat || url), sat, url }; }
async function comPrint() {
  toast('Building commercial report...');
  const { html } = await comBuild(com.model);
  $('#report').innerHTML = `<style>${REPORT_CSS}${COM_CSS}</style><div class="rp">${html}</div>`;
  const imgs = [...$('#report').querySelectorAll('img')].filter((i) => !i.complete);
  await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 4000))]);
  window.print();
}
function comDoc(html, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${FONT_LINK}<style>${REPORT_CSS}${COM_CSS}
    body { margin: 0; background: #555; } .rp-page { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
    @media print { body { background: #fff; } .rp-page { margin: 0; box-shadow: none; } }
    .rp-print { position: fixed; top: 10px; right: 10px; background: ${BLUE}; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; font: 600 14px Inter, "Segoe UI", Arial; cursor: pointer; z-index: 9; } @media print { .rp-print { display: none; } }
  </style></head><body><button class="rp-print" onclick="window.print()">Print / Save as PDF</button><div class="rp">${html}</div></body></html>`;
}
async function comDownload() {
  toast('Building commercial report...');
  const M = com.model; const { html, sat, url } = await comBuild(M);
  const body = sat ? html : html.split(`src="${url}"`).join('src=""');   // never put the API key into a shareable file
  const doc = comDoc(body, 'Commercial Roof Report - ' + (M.address || state.address || ''));
  const name = fileBase() + '_Commercial_Roof_Report.html';
  if (location.hostname === 'localhost') { try { const r = await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: doc }).then((x) => x.json()); if (r.saved) { toast('Saved to reports folder: ' + name); return; } } catch (_) { /* fall back */ } }
  download(name, doc, 'text/html');
}
