'use strict';
/* autocomplete.js - address predictions while typing in the address box.
 * Google Places (New) autocomplete, biased to the current map area; falls back to the free ArcGIS World geocoder
 * suggestions if Places is not enabled on the key. Up / Down to move, Enter or click to choose, Esc to close.
 * Choosing a prediction locks the house at Google's location for that address. Uses app.js globals: setLocation, map,
 * goToAddress, toast, $.
 */
const ac = { list: null, items: [], active: -1, timer: null, seq: 0, token: null, lib: null, source: null };

async function acGoogle(text) {
  if (!ac.lib) ac.lib = await google.maps.importLibrary('places');
  if (!ac.token) ac.token = new ac.lib.AutocompleteSessionToken();
  const c = (typeof map !== 'undefined' && map && map.getCenter()) || { lat: () => 30.33, lng: () => -81.66 };
  const r = await ac.lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: text, sessionToken: ac.token, includedRegionCodes: ['us'], locationBias: { center: { lat: c.lat(), lng: c.lng() }, radius: 50000 } });
  return (r.suggestions || []).filter((s) => s.placePrediction).slice(0, 6).map((s) => ({ text: s.placePrediction.text.text, main: s.placePrediction.mainText ? s.placePrediction.mainText.text : '', pred: s.placePrediction, src: 'google' }));
}
async function acArcgis(text) {
  const c = (typeof map !== 'undefined' && map && map.getCenter());
  const q = new URLSearchParams({ text, category: 'Address,Postal', countryCode: 'USA', maxSuggestions: 6, f: 'json' });
  if (c) q.set('location', `${c.lng()},${c.lat()}`);
  const j = await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?' + q).then((r) => r.json());
  return (j.suggestions || []).map((s) => ({ text: s.text, magicKey: s.magicKey, src: 'arcgis' }));
}
function acRender() {
  const L = ac.list; if (!L) return;
  if (!ac.items.length) { L.hidden = true; return; }
  L.innerHTML = ac.items.map((it, i) => `<div class="ac-item${i === ac.active ? ' on' : ''}" data-i="${i}">${esc(it.text)}</div>`).join('') + (ac.source === 'google' ? '<div class="ac-foot">powered by Google</div>' : '<div class="ac-foot">suggestions by Esri</div>');
  L.hidden = false;
}
function acClose() { ac.items = []; ac.active = -1; if (ac.list) ac.list.hidden = true; }
async function acChoose(i) {
  const it = ac.items[i]; if (!it) return;
  acClose(); $('#address').value = it.text;
  try {
    if (it.src === 'google') {
      const place = it.pred.toPlace(); await place.fetchFields({ fields: ['location', 'formattedAddress'] });
      ac.token = null;                                  // a choice ends the billing session
      setLocation({ lat: place.location.lat(), lng: place.location.lng() }, place.formattedAddress || it.text);
    } else if (it.magicKey) {
      const q = new URLSearchParams({ SingleLine: it.text, magicKey: it.magicKey, maxLocations: 1, outFields: 'Match_addr', f: 'json' });
      const j = await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' + q).then((r) => r.json());
      const c = j.candidates && j.candidates[0]; if (!c) throw new Error('not found');
      setLocation({ lat: c.location.y, lng: c.location.x }, c.address || it.text);
    } else goToAddress();
  } catch (_) { goToAddress(); }                       // fall back to the normal geocoder
}
async function acQuery() {
  const inp = $('#address'); const text = inp.value.trim();
  if (text.length < 3 || /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(text) || typeof google === 'undefined') { acClose(); return; }
  const seq = ++ac.seq; let items = [];
  try { items = await acGoogle(text); ac.source = 'google'; } catch (_) { try { items = await acArcgis(text); ac.source = 'esri'; } catch (__) { items = []; } }
  if (seq !== ac.seq || document.activeElement !== inp) return;   // a newer keystroke or the box lost focus
  ac.items = items; ac.active = items.length ? 0 : -1; acRender();
}

(function wireAutocomplete() {
  const inp = $('#address'); if (!inp) return;
  inp.setAttribute('autocomplete', 'off');
  const L = document.createElement('div'); L.className = 'ac-list'; L.hidden = true; ac.list = L;
  inp.closest('.field').appendChild(L);
  inp.addEventListener('input', () => { clearTimeout(ac.timer); ac.timer = setTimeout(acQuery, 180); });
  inp.addEventListener('keydown', (e) => {
    if (L.hidden || !ac.items.length) return;
    if (e.key === 'ArrowDown') { ac.active = (ac.active + 1) % ac.items.length; acRender(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ac.active = (ac.active - 1 + ac.items.length) % ac.items.length; acRender(); e.preventDefault(); }
    else if (e.key === 'Enter' && ac.active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); acChoose(ac.active); }
    else if (e.key === 'Escape') { acClose(); e.preventDefault(); }
  }, true);
  L.addEventListener('mousedown', (e) => { const el = e.target.closest('.ac-item'); if (el) { e.preventDefault(); acChoose(+el.dataset.i); } });
  inp.addEventListener('blur', () => setTimeout(acClose, 150));
  $('#btnGo').addEventListener('mousedown', () => acClose());
})();
