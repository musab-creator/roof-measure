'use strict';
/* permits.js - permit history and roof age for the property on the report.
 *
 * Sources (all public, no login):
 *  - Florida Department of Revenue statewide parcels (FGIO ArcGIS): county, parcel id, actual / effective year built.
 *    Works from any website.
 *  - City of Jacksonville parcels (maps.coj.net): Duval RE number and the city's own address for the parcel.
 *  - City of Jacksonville JAXEPICS permit search API: every permit at the address with type, status, submitted and
 *    issued dates. The city's server only answers browser requests from the city's site and from localhost, so this
 *    works when Roof Measure runs from the desktop shortcut (local server), not on the public GitHub page.
 *  - Duval County Property Appraiser record (roof structure, roof cover, year built) and Clay County's permit search,
 *    relayed by the local server (serve.ps1) because those sites block cross-site requests.
 * Other jurisdictions get a link to their permit portal and a manual entry for the last roof permit.
 */

const PERMIT_URL = {
  fdor: 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query',
  cojParcels: 'https://maps.coj.net/coj/rest/services/CityBiz/Parcels/MapServer/0/query',
  jax: 'https://jaxepicsapi.coj.net/api/Searches/Permits/AddressSearch',
  jaxSite: 'https://jaxepics.coj.net',
  pao: 'https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=',
};
const PERMIT_COUNTY = { 26: 'Duval', 65: 'St. Johns', 20: 'Clay', 55: 'Nassau', 10: 'Baker', 54: 'Putnam' };
const PERMIT_PORTAL = {
  coj: { name: 'City of Jacksonville (JAXEPICS)', url: 'https://jaxepics.coj.net/Search/SearchResults' },
  beaches: { name: 'Jacksonville Beach / Atlantic Beach / Neptune Beach building department', url: 'https://www.jacksonvillebeach.org/207/Building-Inspection' },
  'St. Johns': { name: 'St. Johns County permit search (WATS)', url: 'https://webapp.sjcfl.us/WATSWebX/Permit/SearchPermit.aspx' },
  Clay: { name: 'Clay County permit portal (EnerGov)', url: 'https://claycountyfl-energovpub.tylerhost.net/apps/selfservice' },
  Nassau: { name: 'Nassau County permit portal', url: 'https://aca-prod.accela.com/NASSAU/Cap/CapHome.aspx?module=Building' },
};
const BEACH_CITIES = /JACKSONVILLE BEACH|JAX BEACH|ATLANTIC BEACH|NEPTUNE BEACH|BALDWIN/i;
const permit = { key: null, data: null, pending: null, manual: JSON.parse(localStorage.getItem('rm.permitManual') || '{}') };

// date-only values ("2026-05-06") are calendar dates: read them as local dates, not midnight UTC (which shows a day early)
const pDate = (s) => { if (!s) return null; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s); };
const pFmt = (s) => { const d = pDate(s); return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; };
const yearsSince = (d, now = new Date()) => (d && !isNaN(d) ? (now - d) / (365.25 * 86400000) : null);
const isLocalApp = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';

async function arcQuery(url, params) {
  const r = await fetch(url + '?' + new URLSearchParams({ ...params, f: 'json' }));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'query failed');
  return j.features || [];
}
// parcel at a point, falling back to the nearest parcel within 25 m (geocoded points can sit on the street)
async function parcelAt(url, loc, outFields) {
  const base = { geometry: `${loc.lng},${loc.lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields, returnGeometry: false };
  let f = await arcQuery(url, base);
  if (!f.length) f = await arcQuery(url, { ...base, distance: 25, units: 'esriSRUnit_Meter' });
  return f.length ? f[0].attributes : null;
}

async function jaxPermits(term) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const u = `${PERMIT_URL.jax}?page=${page}&pageSize=100&filter=&sortActive=Title&sortDirection=desc&forSpreadSheet=false&SearchTerm=${encodeURIComponent(term)}`;
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('permit search HTTP ' + r.status);
    const j = await r.json(); const v = j.values || []; all.push(...v); if (v.length < 100) break;
  }
  return all.filter((v) => v.type === 'Permit' && v.obj).map((v) => ({
    number: v.title, type: v.obj.PermitType || '', use: v.obj.ProposedUse || '', structure: v.obj.StructureType || '', work: v.obj.WorkType || '',
    status: v.obj.Status || '', submitted: v.obj.DateLastSubmitted || null, issued: v.obj.DateIssued || null, finaled: null,
    address: v.obj.Address || '', link: v.link ? PERMIT_URL.jaxSite + v.link : '', roof: /roof/i.test(v.obj.PermitType || '') || /roof/i.test(v.description || ''),
  }));
}
// JAXEPICS advanced search by parcel (RE number "162112 0625"): every permit on the parcel, any type, exact match
const jaxCols = { list: null };
const jaxDate = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
async function jaxByRE(re) {
  const api = 'https://jaxepicsapi.coj.net/api/AdvancedSearches/';
  if (!jaxCols.list) { const r = await fetch(api + 'GetColumns/82'); if (!r.ok) throw new Error('permit search HTTP ' + r.status); jaxCols.list = Object.fromEntries((await r.json()).map((c) => [c.ColumnId, c])); }
  const obj = { SearchString: re };
  const filter = { SavedSearchFilterId: 0, SavedSearchId: 0, ColumnId: 28, Column: jaxCols.list[28], OperatorId: 1, Order: -1, Obj: obj, groupedSectionControls: {}, Completed: true, EvalValueString: JSON.stringify(obj), IsActive: true, SavedSearch: null, DisplayInWidget: true, PinnedInWidget: false, Sort: 0 };
  const body = { SavedSearchColumns: [1, 2, 3, 4, 5, 6, 7, 8, 16, 18, 19, 20, 25, 28].map((id) => ({ ColumnId: id })), SavedSearchFilters: [filter], UserSavedSearches: [], UserSavedSearchWidgets: [], TableId: 82 };
  const r = await fetch(`${api}Advanced?page=1&pageSize=500&filter=&sortActive=DateIssued&sortDirection=desc&forSpreadSheet=false`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('permit search HTTP ' + r.status);
  const j = await r.json();
  return (j.values || []).filter((v) => v.FullPermitNumber).map((v) => ({
    number: v.FullPermitNumber, type: v.PermitTypeDescription || '', use: v.ProposedUseDescription || '', structure: v.StructureTypeDescription || '', work: [v.WorkTypeDescription, v.WorkSubTypeDescription].filter(Boolean).join(' - '),
    status: v.StatusDescription || '', submitted: jaxDate(v.DateLastSubmitted), issued: jaxDate(v.DateIssued), finaled: jaxDate(v.DateFinal), contractor: v.CompanyName || '',
    cost: parseFloat(v.TotalCost) || null, address: v.Address || '', link: v.FullPermitNumber_Click ? PERMIT_URL.jaxSite + '/' + v.FullPermitNumber_Click : '', roof: /roof/i.test(v.PermitTypeDescription || ''),
  }));
}
// published copy of every City of Jacksonville roofing permit, split by the first three digits of the parcel number
// (built by reports/_tools/permitindex.js; used when the city's server will not answer this website directly)
const roofIndex = { meta: null, buckets: {} };
async function roofIndexLookup(reNoSpace, addrKey) {
  const base = new URL('permits/', location.href).href;
  if (!roofIndex.meta) { const r = await fetch(base + 'meta.json', { cache: 'no-cache' }); if (!r.ok) throw new Error('permit index unavailable'); roofIndex.meta = await r.json(); }
  const b = reNoSpace.slice(0, 3);
  if (!roofIndex.buckets[b]) { roofIndex.buckets[b] = fetch(base + 'roof_' + b + '.json').then((r) => (r.ok ? r.json() : {})); }
  let rows = (await roofIndex.buckets[b])[reNoSpace] || [];
  if (!rows.length && addrKey) {   // older permits recorded without a parcel number, matched by street address + ZIP
    if (!roofIndex.addr) roofIndex.addr = fetch(base + 'addr.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    rows = (await roofIndex.addr)[addrKey] || [];
  }
  const st = roofIndex.meta.statuses || [];
  return rows.map((x) => ({ number: x[0], type: 'Roofing Permit', use: x[7] === 'N' ? 'Non-Residential' : 'Residential', structure: '', work: x[4] || '', status: st[x[2]] || '',
    submitted: x[8] || null, issued: x[1] || null, finaled: x[3] || null, contractor: x[5] || '', cost: x[6] || null, address: '', link: x[9] ? PERMIT_URL.jaxSite + '/Permit/View/' + x[9] : '', roof: true }));
}
async function clayPermits(keyword) {
  const body = { Keyword: keyword, ExactMatch: true, SearchModule: 1, FilterModule: 2, SearchMainAddress: false, PlanCriteria: { PageNumber: 0, PageSize: 0 },
    PermitCriteria: { PermitTypeId: 'none', PermitWorkclassId: 'none', PermitStatusId: 'none', PageNumber: 0, PageSize: 0, SortAscending: false },
    InspectionCriteria: { PageNumber: 0, PageSize: 0 }, CodeCaseCriteria: { PageNumber: 0, PageSize: 0 }, RequestCriteria: { PageNumber: 0, PageSize: 0 },
    BusinessLicenseCriteria: { PageNumber: 0, PageSize: 0 }, ProfessionalLicenseCriteria: { PageNumber: 0, PageSize: 0 }, LicenseCriteria: { PageNumber: 0, PageSize: 0 },
    ProjectCriteria: { PageNumber: 0, PageSize: 0 }, PlanSortList: [], PermitSortList: [], InspectionSortList: [], CodeCaseSortList: [], RequestSortList: [], LicenseSortList: [], ProjectSortList: [],
    PageNumber: 1, PageSize: 100, SortBy: 'relevance', SortAscending: false };
  const r = await fetch('/relay/clay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Clay permit search HTTP ' + r.status);
  const j = await r.json(); const rows = (j.Result && j.Result.EntityResults) || [];
  return rows.map((x) => ({ number: x.CaseNumber, type: x.CaseType || '', use: '', structure: '', work: x.CaseWorkclass || '', status: x.CaseStatus || '',
    submitted: x.ApplyDate || null, issued: x.IssueDate || null, finaled: x.FinalDate || x.CompleteDate || null, address: x.AddressDisplay || (x.Address && x.Address.FullAddress) || '',
    link: '', roof: /^ROOF/i.test(x.CaseNumber || '') || /roof/i.test(x.CaseType || '') }));
}
async function paoRecord(re) {
  const r = await fetch('/relay/pao?re=' + encodeURIComponent(re)); if (!r.ok) throw new Error('PAO HTTP ' + r.status);
  const html = await r.text();
  const rowText = (label) => { const m = html.match(new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?' + label + '(?:(?!</tr>)[\\s\\S])*?</tr>', 'i')); if (!m) return null;
    const cells = (m[0].match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return cells.length ? cells[cells.length - 1].replace(/^\d+\s+/, '') : null; };
  const yb = html.match(/lblYearBuilt[^>]*>\s*(\d{4})/i);
  return { yearBuilt: yb ? +yb[1] : null, roofStruct: rowText('Roof Struct'), roofCover: rowText('Roofing Cover'), url: PERMIT_URL.pao + re };
}

const normAddr = (s) => String(s || '').toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
async function permitLookup(loc, address) {
  const out = { checked: new Date().toISOString(), address, county: null, jurisdiction: null, parcel: null, yearBuilt: null, effYear: null, roofCover: null, roofStruct: null,
    permits: [], searched: false, source: null, portal: null, notes: [], errors: [] };
  try {
    const a = await parcelAt(PERMIT_URL.fdor, loc, 'CO_NO,PARCEL_ID,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,ACT_YR_BLT,EFF_YR_BLT,DOR_UC,NO_BULDNG,TOT_LVG_AR');
    if (a) { out.county = PERMIT_COUNTY[a.CO_NO] || `County ${a.CO_NO}`; out.parcel = { id: a.PARCEL_ID, address: a.PHY_ADDR1, city: a.PHY_CITY, zip: a.PHY_ZIPCD, buildings: a.NO_BULDNG, livingArea: a.TOT_LVG_AR };
      out.yearBuilt = a.ACT_YR_BLT > 1800 ? a.ACT_YR_BLT : null; out.effYear = a.EFF_YR_BLT > 1800 ? a.EFF_YR_BLT : null; }
  } catch (e) { out.errors.push('Florida parcel data: ' + e.message); }
  if (out.county === 'Duval') {
    let p = null;
    try { p = await parcelAt(PERMIT_URL.cojParcels, loc, 'RE,RE_NOSPACE,STREET_NO,ST_DIR,ST_NAME,ST_TYPE,UNIT_NO,ADDRCITY,ZIPCODE,DESCPU'); } catch (e) { out.errors.push('City parcel data: ' + e.message); }
    const city = (p && p.ADDRCITY) || (out.parcel && out.parcel.city) || '';
    if (p) out.parcel = { ...(out.parcel || {}), re: p.RE, reNoSpace: p.RE_NOSPACE, cityAddress: [p.STREET_NO, p.ST_DIR, p.ST_NAME, p.ST_TYPE].filter((x) => x && String(x).trim()).join(' '), use: p.DESCPU };
    if (BEACH_CITIES.test(city)) { out.jurisdiction = city; out.portal = PERMIT_PORTAL.beaches; out.notes.push(`${city} issues its own building permits; the City of Jacksonville system does not list them.`); }
    else {
      out.jurisdiction = 'City of Jacksonville'; out.portal = PERMIT_PORTAL.coj;
      const term = (out.parcel && out.parcel.cityAddress) || String(address || '').split(',')[0];
      const lead = normAddr(term).split(' ').slice(0, 2).join(' ');   // street number + first word of the street name
      let live = null, liveErr = null;
      // 1) live city records, matched exactly by parcel number (works from the desktop app)
      if (p && p.RE) { try { live = await jaxByRE(p.RE); } catch (e) { liveErr = e.message; } }
      // condo / multi-unit parcels: roof permits are often filed under the street address of the building
      if (live && !live.some((x) => x.roof)) {
        try { const rows = await jaxPermits(term); const have = new Set(live.map((x) => x.number)); for (const x of rows) if (normAddr(x.address).startsWith(lead) && !have.has(x.number)) live.push(x); } catch (_) { /* parcel results stand */ }
      } else if (!live && !(p && p.RE)) {
        try { live = (await jaxPermits(term)).filter((x) => normAddr(x.address).startsWith(lead)); } catch (e) { liveErr = e.message; }
      }
      out.recordsFrom = 1985;   // City of Jacksonville roofing permits are on line from mid-1984
      if (live) { out.permits = live; out.searched = true; out.source = 'City of Jacksonville JAXEPICS (live)'; out.searchTerm = p && p.RE ? `parcel ${p.RE}` : term; }
      // 2) otherwise the published copy of every city roofing permit (public website)
      else if (p && p.RE_NOSPACE) {
        try {
          out.permits = await roofIndexLookup(p.RE_NOSPACE, normAddr(term) + '|' + String(p.ZIPCODE || '').slice(0, 5)); out.searched = true; out.indexOnly = true; out.searchTerm = `parcel ${p.RE}`;
          out.source = `City of Jacksonville roofing permit records (copy through ${roofIndex.meta.through || roofIndex.meta.updated})`;
          out.notes.push(`Roofing permits issued after ${pFmt(roofIndex.meta.through)} show once the permit copy is refreshed; the desktop app reads the city live.`);
        } catch (e) { out.errors.push('City permit records: ' + (liveErr || e.message)); }
      } else out.errors.push('City permit search: ' + (liveErr || 'no parcel number for this location'));
      if (p && p.RE_NOSPACE) {
        out.paoUrl = PERMIT_URL.pao + p.RE_NOSPACE;
        if (isLocalApp()) { try { const pr = await paoRecord(p.RE_NOSPACE); out.roofCover = pr.roofCover; out.roofStruct = pr.roofStruct; if (pr.yearBuilt) out.yearBuilt = pr.yearBuilt; } catch (e) { out.errors.push('Property appraiser: ' + e.message); } }
      }
    }
  } else if (out.county === 'Clay') {
    out.jurisdiction = 'Clay County'; out.portal = PERMIT_PORTAL.Clay; out.source = 'Clay County EnerGov';
    if (isLocalApp() && out.parcel && out.parcel.address) {
      try {
        let rows = await clayPermits(out.parcel.address);
        if (!rows.length) rows = await clayPermits(out.parcel.address.split(' ').slice(0, -1).join(' '));
        out.permits = rows; out.searched = true; out.searchTerm = out.parcel.address; out.recordsFrom = 2023;
        out.notes.push('Clay County\'s online permit records start in January 2023; older permits are in the county\'s archive.');
      } catch (e) { out.errors.push('Clay County permit search: ' + e.message); }
    } else out.errors.push('Clay County permits are looked up by the Roof Measure desktop app (local server).');
  } else if (out.county) {
    out.jurisdiction = out.county + ' County'; out.portal = PERMIT_PORTAL[out.county] || null;
    out.notes.push(`${out.county} County has no public permit data feed; check its permit portal and enter the last roof permit below.`);
  } else out.errors.push('No Florida parcel found at this location.');
  return out;
}

// roof age from the newest roofing permit that was issued (manual entry wins), else from the year built
function roofAgeInfo(d, now = new Date()) {
  const m = permit.manual[permit.key] || {};
  const roofs = (d ? d.permits : []).filter((p) => p.roof);
  const valid = roofs.filter((p) => !/void|withdr|cancel|denied|reject/i.test(p.status));
  const byDate = (p) => pDate(p.issued || p.finaled || p.submitted) || new Date(0);
  valid.sort((a, b) => byDate(b) - byDate(a)); roofs.sort((a, b) => (pDate(b.submitted) || 0) - (pDate(a.submitted) || 0));
  const lastIssued = valid.find((p) => p.issued || p.finaled) || null;
  const lastSubmitted = roofs[0] || null;
  const all = d ? d.permits.map((p) => pDate(p.submitted || p.issued)).filter((x) => x && !isNaN(x)) : [];
  const oldest = all.length ? new Date(Math.min(...all)) : null;
  let basis = null, age = null, date = null, number = null;
  if (m.date) { date = pDate(m.date); age = yearsSince(date, now); basis = 'entered'; number = m.number || null; }
  else if (lastIssued) { date = pDate(lastIssued.issued || lastIssued.finaled); age = yearsSince(date, now); basis = 'permit'; number = lastIssued.number; }
  else if (d && d.yearBuilt && (!d.searched || !d.recordsFrom || d.yearBuilt >= d.recordsFrom)) { age = now.getFullYear() - d.yearBuilt; basis = 'built'; }   // likely the original roof
  else if (d && d.yearBuilt) basis = 'unknown';   // built before the permit records start and no roof permit since
  return { age, basis, date, number, lastIssued, lastSubmitted, roofCount: roofs.length, oldest };
}
function roofAgeSentence(d) {
  const R = roofAgeInfo(d); const yrs = (a) => (a < 1 ? 'under 1 year' : `${Math.floor(a)} year${Math.floor(a) === 1 ? '' : 's'}`);
  const ageTxt = (a) => (a < 1 ? 'under 1 year' : 'about ' + yrs(a));
  if (R.basis === 'entered') return `Roof age ${ageTxt(R.age)}: last roof permit ${R.number ? R.number + ' ' : ''}dated ${pFmt(R.date)} (entered).`;
  if (R.basis === 'permit') return `Roof age ${ageTxt(R.age)}: last roof permit ${R.number} issued ${pFmt(R.date)}${R.lastIssued && R.lastIssued.status ? ' (' + R.lastIssued.status.toLowerCase() + ')' : ''}.`;
  if (R.basis === 'built') return d && d.searched ? `No roofing permit on file since the building went up in ${d.yearBuilt}: likely the original roof, ${ageTxt(R.age)} old.` : `Built ${d.yearBuilt}; no permit records for this area, so the roof could be up to ${yrs(R.age)} old.`;
  if (R.basis === 'unknown') return `No roofing permit on file since ${d.jurisdiction || 'the'} permit records began in ${d.recordsFrom}. Built ${d.yearBuilt}: the roof's age can't be confirmed from permits, so inspect it.`;
  return 'Roof age unknown: no permit data for this location.';
}

async function permitEnsure(force) {
  if (!state.location) return null;
  const key = state.address || `${state.location.lat.toFixed(6)},${state.location.lng.toFixed(6)}`;
  if (!force && permit.key === key && permit.data) return permit.data;
  if (!force && permit.key === key && permit.pending) return permit.pending;
  permit.key = key;
  permit.pending = permitLookup(state.location, state.address).then((d) => { if (permit.key === key) { permit.data = d; permitRender(); } return d; }).finally(() => { permit.pending = null; });
  permitRender();
  return permit.pending;
}

// ------------------------------------------------------------------ panel
function permitRender() {
  const el = $('#permitOut'); if (!el) return; const d = permit.data;
  if (permit.pending && !d) { el.innerHTML = '<span class="muted">Looking up permits...</span>'; return; }
  if (!d) { el.innerHTML = '<span class="muted">Enter an address to look up the permit history.</span>'; return; }
  const R = roofAgeInfo(d);
  const rows = d.permits.slice().sort((a, b) => (pDate(b.issued || b.submitted) || 0) - (pDate(a.issued || a.submitted) || 0)).slice(0, 6)
    .map((p) => `<tr><td>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.number)}</a>` : esc(p.number)}</td><td>${esc(p.type)}</td><td>${pFmt(p.issued || p.submitted)}</td></tr>`).join('');
  el.innerHTML = `<div class="kv"><b>${esc(roofAgeSentence(d))}</b></div>
    <div class="muted">${[d.jurisdiction, d.yearBuilt ? 'built ' + d.yearBuilt : null, d.roofCover ? 'roof cover: ' + d.roofCover : null].filter(Boolean).map(esc).join(' &middot; ')}</div>
    ${rows ? `<table class="mini"><tr><th>Permit</th><th>Type</th><th>Date</th></tr>${rows}</table>` : (d.searched ? '<div class="muted">No permits found at this address.</div>' : '')}
    ${d.errors.map((e) => `<div class="err">${esc(e)}</div>`).join('')}${d.notes.map((n) => `<div class="muted">${esc(n)}</div>`).join('')}
    ${d.portal ? `<div><a href="${esc(d.portal.url)}" target="_blank" rel="noopener">${esc(d.portal.name)}</a>${d.paoUrl ? ` &middot; <a href="${esc(d.paoUrl)}" target="_blank" rel="noopener">Property appraiser record</a>` : ''}</div>` : ''}`;
  const md = $('#pm_date'), mn = $('#pm_number'); const m = permit.manual[permit.key] || {};
  if (md && document.activeElement !== md) md.value = m.date || ''; if (mn && document.activeElement !== mn) mn.value = m.number || '';
}

// ------------------------------------------------------------------ report page (shared by the residential and commercial reports)
function permitReportPage(headHtml) {
  const d = permit.data; const R = roofAgeInfo(d);
  const list = d ? d.permits.slice().sort((a, b) => (pDate(b.issued || b.submitted) || 0) - (pDate(a.issued || a.submitted) || 0)) : [];
  const roofRows = list.filter((p) => p.roof), other = list.filter((p) => !p.roof);
  const roofHead = '<tr><th>Permit</th><th>Work</th><th>Status</th><th>Contractor</th><th class="num">Issued</th><th class="num">Final</th></tr>';
  const roofRow = (p) => `<tr><td>${esc(p.number)}</td><td>${esc((p.work || p.type).slice(0, 40))}</td><td>${esc(p.status.slice(0, 16))}</td><td>${esc((p.contractor || '-').slice(0, 30))}</td><td class="num">${pFmt(p.issued)}</td><td class="num">${pFmt(p.finaled)}</td></tr>`;
  const row = (p) => `<tr><td>${esc(p.number)}</td><td>${esc([p.type, p.work].filter(Boolean).join(' - ').slice(0, 70))}</td><td>${esc(p.status.slice(0, 18))}</td><td class="num">${pFmt(p.submitted)}</td><td class="num">${pFmt(p.issued)}</td></tr>`;
  const head = '<tr><th>Permit</th><th>Type</th><th>Status</th><th class="num">Submitted</th><th class="num">Issued</th></tr>';
  const kv = [
    ['Roof age', R.age == null ? (R.basis === 'unknown' ? `Unknown (no roof permit since ${d.recordsFrom}; built ${d.yearBuilt})` : 'Unknown') : `${R.age < 1 ? 'under 1 year' : Math.floor(R.age) + (Math.floor(R.age) === 1 ? ' year' : ' years')}${R.basis === 'built' ? (d && d.searched ? ' (original roof: no roof permit since construction)' : ' (since construction; permits not checked)') : ''}`],
    ['Last roof permit issued', R.lastIssued ? `${R.lastIssued.number}, ${pFmt(R.lastIssued.issued || R.lastIssued.finaled)} (${R.lastIssued.status || '-'})${R.lastIssued.contractor ? ', ' + R.lastIssued.contractor : ''}` : (R.basis === 'entered' ? `${R.number || ''} ${pFmt(R.date)} (entered)` : 'None on file')],
    ['Last roof permit submitted', R.lastSubmitted ? `${R.lastSubmitted.number}, ${pFmt(R.lastSubmitted.submitted)} (${R.lastSubmitted.status || '-'})` : 'None on file'],
    ['Roof permits on file', String(R.roofCount)],
    ['Year built / effective year', d ? `${d.yearBuilt || '-'} / ${d.effYear || '-'}` : '-'],
    ['Roof structure / cover', d && (d.roofStruct || d.roofCover) ? `${d.roofStruct || '-'} / ${d.roofCover || '-'}` : '-'],
    ['Permit authority', d ? (d.jurisdiction || '-') : '-'],
    ['Parcel', d && d.parcel ? (d.parcel.re || d.parcel.id || '-') : '-'],
  ];
  // row budget for one 11 in page (long permit types wrap to two lines)
  const shownRoof = roofRows.slice(0, 10), shownOther = other.slice(0, Math.max(0, 16 - shownRoof.length));
  return `${headHtml}
    <div class="note" style="font-size:12px;margin-top:12px"><b>${esc(roofAgeSentence(d))}</b></div>
    <div class="sec">Roof age</div><table class="kv">${kv.map(([l, v]) => `<tr><td>${l}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="sec">Roofing permits</div>${shownRoof.length ? `<table class="tight">${roofHead}${shownRoof.map(roofRow).join('')}</table>${roofRows.length > shownRoof.length ? `<div class="note">${roofRows.length - shownRoof.length} older roofing permits not listed.</div>` : ''}` :`<div class="empty">${d && d.searched ? 'No roofing permits on file for this address.' : 'Permit records were not available for this address.'}</div>`}
    ${shownOther.length ? `<div class="sec">Other permits at this address</div><table class="tight">${head}${shownOther.map(row).join('')}</table>${other.length > shownOther.length ? `<div class="note">${other.length - shownOther.length} older permits not listed.</div>` : ''}` : ''}
    <div class="note">Source: ${esc(d && d.source ? d.source : 'public permit records')}${d && d.searchTerm ? ` (address searched: ${esc(d.searchTerm)})` : ''}; year built from the Florida Department of Revenue parcel roll${d && d.roofCover ? ' and the Duval County Property Appraiser' : ''}. Checked ${pFmt(d ? d.checked : null)}. Roof age is counted from the issue date of the newest roofing permit; work done without a permit, or before the city's online records, is not shown.${d && d.notes.length ? ' ' + d.notes.map(esc).join(' ') : ''}</div><div style="flex:1"></div>`;
}
function permitCoverLine() { const d = permit.data; return d ? `<div class="addr" style="margin-top:6px"><b>${esc(roofAgeSentence(d))}</b></div>` : ''; }

// ------------------------------------------------------------------ wiring
(function wirePermits() {
  if (!$('#permitOut')) return;
  $('#btnPermits').onclick = () => permitEnsure(true);
  const saveManual = () => { if (!permit.key) return; permit.manual[permit.key] = { date: $('#pm_date').value || '', number: ($('#pm_number').value || '').trim() }; localStorage.setItem('rm.permitManual', JSON.stringify(permit.manual)); permitRender(); };
  $('#pm_date').onchange = saveManual; $('#pm_number').onchange = saveManual;
  const prev = setLocation;
  setLocation = function (...args) { prev.apply(this, args); permit.data = null; permit.key = null; permitEnsure(); };
  permitRender();
})();
