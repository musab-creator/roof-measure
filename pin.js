'use strict';
/* pin.js - pick the house on the map instead of typing an address.
 *  - Double-click a house on the map (select tool, empty map area) to lock it in.
 *  - "Pick on map": click the house, or steer the map with the arrow keys (Shift = fine) so the crosshair sits on the
 *    roof and press Enter / "Lock center". Esc cancels.
 *  - The locked house shows a pin; drag the pin to move it.
 * Locking a house sets the location exactly where you clicked (on the roof, which Google's roof data and the parcel
 * lookups need) and fills the address box from Google's reverse geocoder. Uses globals from app.js: map, geocoder,
 * state, setLocation, setTool, toast, $.
 */
const pin = { marker: null, picking: false, busy: false };

function pinSetMarker(loc) {
  if (!(typeof map !== "undefined" && map) || !loc) return;
  if (!pin.marker) {
    pin.marker = new google.maps.Marker({ map, position: loc, draggable: true, zIndex: 900, title: 'Locked house - drag to move' });
    pin.marker.addListener('dragend', (e) => lockHouse(e.latLng, { keepView: true }));
  } else { pin.marker.setPosition(loc); if (!pin.marker.getMap()) pin.marker.setMap(map); }
}

// best street address near the point (prefers an exact rooftop address, then a nearby premise / street address)
async function reverseAddress(ll) {
  try {
    const res = await geocoder.geocode({ location: ll });
    const list = (res && res.results) || [];
    const pick = list.find((r) => r.types.includes('street_address') && r.geometry.location_type === 'ROOFTOP')
      || list.find((r) => r.types.includes('premise') || r.types.includes('subpremise'))
      || list.find((r) => r.types.includes('street_address')) || list[0];
    return pick ? pick.formatted_address : null;
  } catch (_) { return null; }
}

async function lockHouse(latLng, opts = {}) {
  if (!latLng || pin.busy) return;
  pin.busy = true; pinStopPicking();
  const loc = { lat: typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat, lng: typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng };
  toast('Locking in this house...');
  try {
    const addr = await reverseAddress(loc);
    const label = addr || `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
    const view = opts.keepView && (typeof map !== "undefined" && map) ? { c: map.getCenter(), z: map.getZoom() } : null;
    setLocation(loc, label);                      // also resets Solar / permits / commercial for the new house
    if (view) { map.setCenter(view.c); map.setZoom(view.z); }
    pinSetMarker(loc);
    toast(addr ? `Locked: ${addr}` : 'Locked at this point (no street address found here)');
  } finally { pin.busy = false; }
}

// ------------------------------------------------------------------ pick mode
function pinStartPicking() {
  if (!(typeof map !== "undefined" && map)) return;
  if (typeof setTool === 'function') setTool('select');
  pin.picking = true;
  document.body.classList.add('picking');
  map.setOptions({ draggableCursor: 'crosshair' });
  $('#btnPick').classList.add('on'); $('#btnPick').textContent = 'Cancel pick';
  $('#btnLockCenter').hidden = false;
  setHint('Click the house, or move the map with the arrow keys so the + is on the roof and press Enter. Esc cancels.');
}
function pinStopPicking() {
  if (!pin.picking) return;
  pin.picking = false;
  document.body.classList.remove('picking');
  if ((typeof map !== "undefined" && map)) map.setOptions({ draggableCursor: null });
  const b = $('#btnPick'); if (b) { b.classList.remove('on'); b.textContent = 'Pick on map'; }
  const c = $('#btnLockCenter'); if (c) c.hidden = true;
  if (typeof updateHint === 'function') updateHint();
}

(function wirePin() {
  if (!$('#btnPick')) return;
  $('#btnPick').onclick = () => (pin.picking ? pinStopPicking() : pinStartPicking());
  $('#btnLockCenter').onclick = () => { if ((typeof map !== "undefined" && map)) lockHouse(map.getCenter()); };
  // show the pin for addresses typed in the box too
  const prev = setLocation;
  setLocation = function (loc, label) { prev.apply(this, arguments); pinSetMarker(loc); };
  // map clicks: in pick mode a click locks; with the select tool a double-click on the map locks (Google's own
  // double-click zoom is off in this app, and the drawing tools keep their double-click to finish a shape)
  const hook = () => {
    if (!(typeof map !== "undefined" && map) || !window.google) { setTimeout(hook, 300); return; }
    map.addListener('click', (e) => { if (pin.picking && e.latLng) lockHouse(e.latLng); });
    map.addListener('dblclick', (e) => { if (!pin.picking && state.tool === 'select' && e.latLng && !(typeof draft !== 'undefined' && draft)) lockHouse(e.latLng); });
    if (state.location) pinSetMarker(state.location);
  };
  hook();
  // keys while picking: arrows steer the map under the crosshair, Enter locks the center, Esc cancels
  document.addEventListener('keydown', (e) => {
    if (!pin.picking || !(typeof map !== "undefined" && map)) return;
    const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const step = e.shiftKey ? 12 : 80;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) { map.panBy(moves[e.key][0], moves[e.key][1]); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Enter') { lockHouse(map.getCenter()); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Escape') { pinStopPicking(); e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
