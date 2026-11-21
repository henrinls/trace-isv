'use strict';
// Filet de sécurité : toute erreur s'affiche au lieu de laisser une carte vide
window.addEventListener('error', e => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Erreur : ' + (e.message || 'inconnue') + ' — ferme et rouvre l\'appli'; t.classList.remove('hidden'); }
});
// iPhone : après la fermeture du clavier, iOS laisse parfois la page décalée et les appuis tombent à côté de ce qu'on voit
// (ex. « −1 » de la longueur qui corrige le cap). On remet la page en place dès qu'une case perd le focus.
document.addEventListener('focusout', e => {
  if (!e.target || !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  setTimeout(() => { const a = document.activeElement; if (!a || !/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) window.scrollTo(0, 0); }, 60);
});
const VERSION = '0.5.1';
const APP_ID = 'isv';
// Fonds de carte : Esri (monde entier) ou photos aériennes IGN (France, licence ouverte : hors-ligne et PDF autorisés)
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagerie © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
  ign: { url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', attr: 'Photos aériennes © IGN – Géoplateforme', maxNative: 19 }
};
const TILE_CACHE = 'isv-tiles-v1';
const KT = 1.943844; // m/s → nœuds
const C_LOW = '#ffe600', C_START = '#1ec83c', C_END = '#ff2020', C_TRACE = '#ff3fb4', C_RELAX = '#00e5ff', C_PTU = '#ffd400', C_ZMT = '#ff8c00';
const isDark = c => c === '#000000';
/* Vx, Vz et vitesse de chute : vraies à 1 000 m en atmosphère standard, pour une MTE de 150 kg. La MTE est celle du PARA
   (lui + parachute + charge), saisie dans l'équipe, 150 kg par défaut : ce n'est pas une caractéristique de la voile (v0.4.1). */
const MTE_DEF = 150;
const DEFAULT_PARAMS = { canopies: [{ id: 'ph', name: 'Phantom', vx: 9, vz: 2 }], margin: 20, openLoss: 100, vff: 50 };
const n360 = h => ((h % 360) + 360) % 360;
const pad2 = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function nowWhen() { const d = new Date(); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
function shiftWhen(w, hours) { const d = new Date(w + ':00'); d.setHours(d.getHours() + hours); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
function fmtWhen(w) { const d = new Date(w + ':00'); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}h`; }
const fmt1 = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
const fmtInt = v => Math.round(v).toLocaleString('fr-FR');
const fmtKm = m => (m / 1000).toFixed(1).replace('.', ',') + ' km';
const fmtMin = s => { const m = Math.floor(s / 60), r = Math.round(s - m * 60); return r === 60 ? `${m + 1} min 00 s` : `${m} min ${pad2(r)} s`; };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- Stockage (clés isv.* : séparées des autres applis, même site) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Enregistrement impossible sur cet appareil'); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- Météo en ligne (Open-Meteo) : grille de 3 × 3 points autour du PTU ----------
const PLEV = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 275, 250, 225, 200];
const HLEV_MF = [10, 100, 200], HLEV_EC = [10, 100];
const GRID_KM = 45; // demi-côté de la grille par défaut ; agrandie toute seule si la trace en sort
function wxSource(date) {
  const days = Math.round((new Date(date + 'T12:00') - new Date(dayStr(new Date()) + 'T12:00')) / 864e5);
  if (days <= 3) return { kind: 'mf', name: 'Météo-France (AROME, puis ARPEGE)', base: 'https://api.open-meteo.com/v1/meteofrance', models: 'meteofrance_seamless', hlev: HLEV_MF };
  return { kind: 'ec', name: 'ECMWF IFS (mondial)', base: 'https://api.open-meteo.com/v1/forecast', models: 'ecmwf_ifs025', hlev: HLEV_EC };
}
function wxUrl(lats, lngs, date, src, minimal, lite) {
  const v = [];
  (minimal ? [10] : src.hlev).forEach(h => v.push(`wind_speed_${h}m`, `wind_direction_${h}m`));
  v.push('temperature_2m'); if (!minimal) v.push('relative_humidity_2m'); // humidité : pas dans la requête allégée (secours si refusée)
  PLEV.filter(p => !lite || p >= 250).forEach(p => v.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`, ...(minimal ? [] : [`relative_humidity_${p}hPa`])));
  return `${src.base}?latitude=${lats.map(x => x.toFixed(4)).join(',')}&longitude=${lngs.map(x => x.toFixed(4)).join(',')}&hourly=${v.join(',')}&models=${src.models}` +
    `&wind_speed_unit=ms&timezone=auto&start_date=${date}&end_date=${date}`;
}
const wxKey = (zid, date) => `isv.wx.${zid || 'tmp'}.${date}`;
const wxMem = {};
function wxCached(zid, date) { const k = wxKey(zid, date); return wxMem[k] || (wxMem[k] = store.get(k, null)); }
function wxWanted() { const I = isv(); return { center: I.ptu || I.zmt || { lat: current.center.lat, lng: current.center.lng }, halfKm: Math.max(GRID_KM, current.gridKm || 0) }; }
function wxFits(rec) { if (!rec || !rec.center) return false; const w = wxWanted(); return Calc.dist(rec.center, w.center) < 5000 && rec.halfKm >= w.halfKm - 0.5; }
async function wxFetch(z, date) {
  const src = wxSource(date), w = wxWanted(), c = w.center;
  const dLat = w.halfKm * 1000 / 111320, dLng = dLat / Math.cos(c.lat * Math.PI / 180), lats = [], lngs = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { lats.push(c.lat - dLat + i * dLat); lngs.push(c.lng - dLng + j * dLng); }
  let r = null, js = null, used = src;
  // Essais : modèle prévu, puis requête allégée, puis ECMWF (secours mondial)
  const ec = wxSource('9999-12-31'), tries = [[src, false, false], [src, true, true]].concat(src.kind === 'mf' ? [[ec, false, false], [ec, true, true]] : []);
  for (const [s2, minimal, lite] of tries) {
    try { r = await fetch(wxUrl(lats, lngs, date, s2, minimal, lite)); if (r.ok) { js = await r.json(); used = s2; break; } } catch (e) { r = null; if (navigator.onLine === false) break; }
  }
  const arr = Array.isArray(js) ? js : (js ? [js] : []);
  if (arr.length !== 9 || !arr[0].hourly) throw new Error(r ? 'HTTP ' + r.status : 'réseau');
  const slim = H => { const o = {}; Object.keys(H).forEach(k => { if (k !== 'time') o[k] = H[k].map(x => typeof x === 'number' ? Math.round(x * 10) / 10 : null); }); return o; };
  const rec = { date, fetched: Date.now(), model: used.name, rh: Object.keys(arr[0].hourly).some(k => /^relative_humidity/.test(k)), center: { lat: c.lat, lng: c.lng }, halfKm: w.halfKm, lat0: c.lat - dLat, lng0: c.lng - dLng, dLat, dLng, n: 3,
    time: arr[0].hourly.time, nodes: arr.map(a => ({ elev: typeof a.elevation === 'number' ? a.elevation : 0, h: slim(a.hourly) })) };
  const k = wxKey(z.id, date); wxMem[k] = rec;
  // ménage avant d'enregistrer : on ne garde que les 2 derniers jours téléchargés de chaque zone
  try { Object.keys(localStorage).filter(x => x.startsWith(`isv.wx.${z.id || 'tmp'}.`) && x !== k).sort().slice(0, -1).forEach(x => { store.del(x); delete wxMem[x]; }); } catch (e) {}
  store.set(k, rec);
  return rec;
}
// Champ de vent pour le calcul, à une heure donnée (altitudes en m au-dessus de la mer)
let zeroWind = (() => { try { return localStorage.getItem('isv.zeroWind') === 'true'; } catch (e) { return false; } })();
const fieldMem = { k: null, F: null };
function fieldOf(rec, when) {
  if (!rec || !rec.time) return null;
  const key = rec.fetched + '|' + when + '|' + zeroWind; if (fieldMem.k === key) return fieldMem.F;
  const i = rec.time.indexOf(when); let F = null;
  if (i >= 0) {
    const nodes = rec.nodes.map(nd => {
      const H = nd.h, val = k => (H[k] && typeof H[k][i] === 'number') ? H[k][i] : null, lv = [], pz = [];
      const add = (z, spd, dir, T, RH) => { if (spd == null || dir == null) return; const a = dir * Math.PI / 180; lv.push({ z, u: zeroWind ? 0 : -spd * Math.sin(a), v: zeroWind ? 0 : -spd * Math.cos(a), T, RH: RH == null ? null : RH }); };
      Object.keys(H).filter(k => /^wind_speed_\d+m$/.test(k)).map(k => +k.match(/\d+/)[0]).sort((a, b) => a - b)
        .forEach(h => add(nd.elev + h, val(`wind_speed_${h}m`), val(`wind_direction_${h}m`), h === 10 ? val('temperature_2m') : null, h === 10 ? val('relative_humidity_2m') : null));
      const top = lv.length ? lv[lv.length - 1].z : nd.elev;
      PLEV.forEach(p => { const z = val(`geopotential_height_${p}hPa`); if (z == null) return; pz.push({ p, z }); if (z > top + 30) add(z, val(`wind_speed_${p}hPa`), val(`wind_direction_${p}hPa`), val(`temperature_${p}hPa`), val(`relative_humidity_${p}hPa`)); });
      lv.sort((a, b) => a.z - b.z); pz.sort((a, b) => b.p - a.p);
      return { elev: nd.elev, lv, pz };
    });
    if (nodes.every(nd => nd.lv.length > 3)) F = { lat0: rec.lat0, lng0: rec.lng0, dLat: rec.dLat, dLng: rec.dLng, n: rec.n, nodes };
  }
  fieldMem.k = key; fieldMem.F = F; return F;
}

// ---------- Zones, ISV, paramètres ----------
function newPara(canopy) { return { id: uid('p'), name: '', canopy: canopy || (prm && prm.canopies[0] ? prm.canopies[0].id : 'ph'), mte: MTE_DEF, dt: 3 }; }
function newIsv(name) {
  return { id: uid('i'), name: name || 'ISV 1', zmt: null, ptu: null, hPtu: 300, ptuElev: null, team: [newPara(), newPara(), newPara(), newPara()],
    tGreen: 4, tRed: 10, fl: 295, acMs: 65, tFall: 4, capManual: null, vecHeading: null, reversed: false, dropId: null, manual: null, relaxRef: 'green',
    secLong: 1000, secLat: 500, alti: null };
}
function upIsv(I) {
  const d = newIsv(I && I.name); if (!I) return d;
  Object.keys(d).forEach(k => { if (I[k] === undefined) I[k] = d[k]; });
  if (!Array.isArray(I.team) || !I.team.length) I.team = [newPara()];
  I.team.forEach(p => { if (!p.id) p.id = uid('p'); if (p.dt === undefined) p.dt = 3; if (p.name === undefined) p.name = ''; if (!(+p.mte > 0)) p.mte = MTE_DEF; if (prm && Array.isArray(prm.canopies) && prm.canopies.length && !prm.canopies.some(c => c.id === p.canopy)) p.canopy = prm.canopies[0].id; });
  return I;
}
function upgrade(z) {
  if (!z) return z;
  z.isvs = (Array.isArray(z.isvs) && z.isvs.length ? z.isvs : [newIsv()]).map(upIsv);
  if (!z.isvs.some(i => i.id === z.cur)) z.cur = z.isvs[0].id;
  z.points = Array.isArray(z.points) ? z.points : [];
  z.zrt = Array.isArray(z.zrt) ? z.zrt : [];
  z.show = Object.assign({ relax: true, label: true }, typeof z.show === 'object' && z.show ? z.show : {});
  if (typeof z.when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:00$/.test(z.when)) z.when = nowWhen(); // date et heure du saut
  return z;
}
let prm = store.get('isv.profile', null) || {};
Object.keys(DEFAULT_PARAMS).forEach(k => { if (prm[k] === undefined) prm[k] = clone(DEFAULT_PARAMS[k]); });
if (!Array.isArray(prm.canopies) || !prm.canopies.length) prm.canopies = clone(DEFAULT_PARAMS.canopies);
if (!prm.noPbo) { /* v0.4.0 : la PBO d'origine est retirée des données enregistrées (une fois) */
  const keep = prm.canopies.filter(c => !(c.id === 'pbo' && c.name === 'PBO')); prm.canopies = keep.length ? keep : clone(DEFAULT_PARAMS.canopies); prm.noPbo = true;
}
prm.canopies.forEach(c => { delete c.mte; });
if (!prm.openV2) { if (+prm.openLoss === 200) prm.openLoss = 100; prm.openV2 = true; } /* v0.5.0 : 100 m en chute stabilisée à 1 000 m (les 200 m d'origine étaient un ordre de grandeur) */
function saveProfile() { store.set('isv.profile', prm); }
saveProfile();
function newZone(center) { return upgrade({ id: null, name: 'Nouvelle zone', center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 12 : 6 }); }
let zones = store.get('isv.zones', []).map(upgrade);
let current = upgrade(store.get('isv.current', null)) || newZone(null);
function isv() { return current.isvs.find(i => i.id === current.cur) || current.isvs[0]; }
function persist() {
  current.center = map.getCenter(); current.zoom = map.getZoom(); current.updated = Date.now();
  store.set('isv.current', current);
  if (current.id) {
    const i = zones.findIndex(z => z.id === current.id);
    if (i >= 0) { zones[i] = clone(current); store.set('isv.zones', zones); }
  }
}
// Tous les caps affichés sont magnétiques (cap vrai − déclinaison du lieu) ; la géométrie et les vents restent en vrai
let _dz = { k: null, v: 0 };
function declCur() {
  const I = isv(), c = I.ptu || I.zmt || current.center; if (!c) return 0;
  const k = c.lat.toFixed(1) + ',' + c.lng.toFixed(1);
  if (_dz.k !== k) { let v = 0; try { v = magDeclination(c.lat, c.lng, new Date()); } catch (e) { v = 0; } _dz = { k, v: isFinite(v) ? v : 0 }; }
  return _dz.v;
}
const hdgN = h => String(Math.round(n360(h - declCur())) % 360).padStart(3, '0') + '°'; // magnétique, sans suffixe (tableaux)
const hdg = h => hdgN(h) + ' M';
const magOf = h => Math.round(n360(h - declCur())) % 360;
const trueOf = m => n360(m + declCur());

// ---------- Coordonnées : degrés et minutes décimales, MGRS ----------
function fmtDmm(p) {
  const f = (v, pos, neg, w) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; let ms = m.toFixed(3); let dd = d; if (ms === '60.000') { ms = '0.000'; dd = d + 1; } return `${v >= 0 ? pos : neg} ${String(dd).padStart(w, '0')}°${ms.padStart(6, '0').replace('.', ',')}'`; };
  return f(p.lat, 'N', 'S', 2) + ' ' + f(p.lng, 'E', 'O', 3);
}
function fmtMgrs(p) { try { const s = mgrs.forward([p.lng, p.lat], 5), m = s.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/); return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : s; } catch (e) { return ''; } }
const fmtPos = p => `${fmtDmm(p)} · ${fmtMgrs(p)}`;
function parseCoords(s0) {
  let s = String(s0 || '').trim(); if (!s) return null;
  const ok = (lat, lng) => (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ? { lat, lng } : null;
  const d = s.replace(/[,;]/g, ' ').trim().split(/\s+/);
  if (d.length === 2 && d.every(x => /^-?\d+(\.\d+)?$/.test(x))) return ok(+d[0], +d[1]);
  const mg = s.replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d\d){1,5}$/.test(mg)) { try { const q = mgrs.toPoint(mg); return ok(q[1], q[0]); } catch (e) { return null; } }
  s = s.replace(/(\d),(\d)/g, '$1.$2').toUpperCase().replace(/W/g, 'O');
  const num = "(\\d{1,3})\\s*[°\\s]\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*['’′]?\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*[\"”″])?";
  const pre = /^[NSEO]/.test(s), re = new RegExp(pre ? '([NSEO])\\s*' + num : num + '\\s*([NSEO])', 'g'), parts = []; let m;
  while ((m = re.exec(s)) && parts.length < 2) { const a = pre ? 2 : 1; parts.push({ h: pre ? m[1] : m[4], v: +m[a] + (+m[a + 1]) / 60 + (m[a + 2] ? +m[a + 2] / 3600 : 0) }); }
  if (parts.length === 2) {
    const la = parts.find(q => /[NS]/.test(q.h)), lo = parts.find(q => /[EO]/.test(q.h));
    if (la && lo) return ok(la.v * (la.h === 'S' ? -1 : 1), lo.v * (lo.h === 'O' ? -1 : 1));
  }
  return null;
}

// ---------- Altitude du terrain (Open-Meteo Elevation : relevé Copernicus 90 m) ----------
async function fetchElev(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const part = pts.slice(i, i + 100);
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${part.map(p => p.lat.toFixed(5)).join(',')}&longitude=${part.map(p => p.lng.toFixed(5)).join(',')}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const js = await r.json(); if (!js || !Array.isArray(js.elevation)) throw new Error('altitudes');
    js.elevation.forEach(e => out.push(typeof e === 'number' ? e : null));
  }
  return out;
}
async function refreshPtuElev() {
  const I = isv(); if (!I.ptu) return; const k = I.ptu.lat.toFixed(5) + ',' + I.ptu.lng.toFixed(5);
  if (I.ptuElevKey === k && typeof I.ptuElev === 'number') return;
  try { const [e] = await fetchElev([I.ptu]); if (isv() !== I || !I.ptu || typeof e !== 'number') return; I.ptuElev = Math.round(e); I.ptuElevKey = k; persist(); fillInputs(); redraw(); }
  catch (e) { /* pas de réseau : on garde l'altitude du modèle météo */ }
}
function elev0() {
  const I = isv(); if (typeof I.ptuElev === 'number') return I.ptuElev;
  const rec = wxCached(current.id, current.when.slice(0, 10)); if (rec && rec.nodes && rec.nodes[4]) return Math.round(rec.nodes[4].elev);
  return 0;
}

// ---------- Carte ----------
const map = L.map('map', { zoomControl: false, maxZoom: 22, zoomSnap: 0.05, attributionControl: true,
  rotate: true, touchRotate: true, bearing: current.bearing || 0, rotateControl: false, touchPitch: false, pitchDrag: false, shiftKeyRotate: true })
  .setView([current.center.lat, current.center.lng], current.zoom);
let basemap = (store.get('isv.basemap', 'esri') in BASEMAPS) ? store.get('isv.basemap', 'esri') : 'esri';
let baseLayer = null, tileFails = 0;
function setBasemap(k, msg) {
  basemap = BASEMAPS[k] ? k : 'esri'; store.set('isv.basemap', basemap);
  if (baseLayer) map.removeLayer(baseLayer);
  const B = BASEMAPS[basemap]; tileFails = 0;
  baseLayer = L.tileLayer(B.url, { maxNativeZoom: B.maxNative, maxZoom: 22, crossOrigin: 'anonymous', attribution: B.attr }).addTo(map);
  baseLayer.on('tileerror', () => { if (++tileFails === 12 && basemap === 'ign') toast('Photos IGN indisponibles ici (hors France ou pas de réseau) : repasse sur « Satellite »'); });
  $('bmEsri').classList.toggle('on', basemap === 'esri'); $('bmIgn').classList.toggle('on', basemap === 'ign');
  if (msg) toast(basemap === 'ign' ? 'Fond : photos aériennes IGN (France)' : 'Fond : satellite Esri (monde)');
}
setBasemap(basemap);
$('bmEsri').addEventListener('click', () => setBasemap('esri', true));
$('bmIgn').addEventListener('click', () => setBasemap('ign', true));
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('moveend', () => { current.center = map.getCenter(); current.zoom = map.getZoom(); store.set('isv.current', current); });
// Boussole : indique le nord quand la carte est tournée ; un appui remet le nord en haut
function syncCompass() {
  const b = map.getBearing ? map.getBearing() : 0;
  $('compassNeedle').style.transform = `rotate(${b}deg)`; // la carte tourne de +b : le nord aussi
  $('btnNorth').classList.toggle('rotated', Math.abs(((b % 360) + 360) % 360) > 0.5);
}
let rotT = 0;
map.on('rotate', () => { syncCompass(); current.bearing = map.getBearing(); clearTimeout(rotT); rotT = setTimeout(persist, 400); });

const fig = L.layerGroup().addTo(map);     // tracé recalculé à chaque dessin
const handles = L.layerGroup().addTo(map); // points déplaçables, gardés d'un dessin à l'autre
let placing = null, posMarker = null;      // placing : null | 'Z' (ZMT) | 'P' (PTU) | { kind, color } (point)
let sol = null, solKey = '', F = null, wxRec = null;
function dotIcon(color, size, label, cls) {
  return L.divIcon({
    className: 'dot ' + (cls || ''),
    html: `<span style="background:${color};width:${size}px;height:${size}px"></span>${label ? `<b class="${isDark(color) ? 'onlight' : ''}" style="color:${color}">${label}</b>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}
const LL = p => [p.lat, p.lng];
let raf = 0;
function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => draw()); } // draw(false) : dessin complet
let lightT = 0;
function drawLight() { const n = performance.now(); if (n - lightT > 60) { lightT = n; draw(true); } }
const mPerPx = ll => 40075016.686 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
const isDragging = m => !!(m && (m._lpDragging || (m.dragging && m.dragging._draggable && m.dragging._draggable._moving)));

// ---------- Appui long pour déplacer un point (portes, mesure) ----------
// Un glissement immédiat déplace la carte ; il faut rester appuyé HOLD_MS sans bouger pour « soulever » le point.
const HOLD_MS = 450, MOVE_TOL = 10;
let suppressClickUntil = 0;
function longPressDrag(marker, onMove, onEnd, onStart) {
  const el = marker.getElement(); if (!el) return;
  let timer = null, start = null;
  const pt = e => (e.touches ? (e.touches[0] || e.changedTouches[0]) : e);
  const off = () => {
    document.removeEventListener('touchmove', move); document.removeEventListener('mousemove', move);
    document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up); document.removeEventListener('mouseup', up);
  };
  const down = e => {
    if (e.touches && e.touches.length > 1) return; // deux doigts : c'est pour la carte
    const p = pt(e); start = { x: p.clientX, y: p.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null; marker._lpDragging = true; if (onStart) onStart();
      const d = map.dragging && map.dragging._draggable; if (d) d.finishDrag(true); // stoppe le déplacement de carte commencé
      map.dragging.disable(); el.classList.add('lifting');
      if (navigator.vibrate) try { navigator.vibrate(25); } catch (er) {}
    }, HOLD_MS);
    document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('mousemove', move);
    document.addEventListener('touchend', up); document.addEventListener('touchcancel', up); document.addEventListener('mouseup', up);
  };
  const move = e => {
    if (e.touches && e.touches.length > 1) { clearTimeout(timer); timer = null; return; }
    const p = pt(e); if (!p) return;
    if (!marker._lpDragging) {
      if (timer && Math.hypot(p.clientX - start.x, p.clientY - start.y) > MOVE_TOL) { clearTimeout(timer); timer = null; }
      return;
    }
    e.preventDefault();
    const r = map.getContainer().getBoundingClientRect();
    const ll = map.containerPointToLatLng([p.clientX - r.left, p.clientY - r.top]);
    marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
  };
  const up = () => {
    clearTimeout(timer); timer = null; off();
    if (marker._lpDragging) {
      marker._lpDragging = false; el.classList.remove('lifting'); map.dragging.enable();
      suppressClickUntil = Date.now() + 400; onEnd();
    }
  };
  el.addEventListener('touchstart', down, { passive: true }); el.addEventListener('mousedown', down);
}

// ---------- Calcul ----------
function calcInput(I) {
  const di = I.team.findIndex(p => p.id === I.dropId), ri = I.team.findIndex(p => p.id === I.relaxRef);
  return { ptu: I.ptu, zmt: I.zmt, hPtu: +I.hPtu, team: I.team.map(p => ({ name: p.name, canopy: p.canopy, mte: +p.mte > 0 ? +p.mte : null, dt: +p.dt })), tGreen: +I.tGreen, tRed: +I.tRed, fl: +I.fl, acMs: +I.acMs, tFall: +I.tFall,
    capManual: I.capManual, vecHeading: I.vecHeading, reversed: !!I.reversed, dropIdx: di >= 0 ? di : null, manual: I.manual, relaxRef: I.relaxRef === 'red' ? 'red' : (ri >= 0 ? ri : 'green') };
}
let gridAsked = '';
function compute() {
  const I = isv();
  wxRec = wxCached(current.id, current.when.slice(0, 10));
  F = fieldOf(wxRec, current.when);
  const inp = calcInput(I), e0 = elev0();
  const key = JSON.stringify([inp, prm, e0, wxRec && wxRec.fetched, current.when, zeroWind]);
  if (key === solKey) return;
  try { sol = Calc.solve(inp, prm, F, e0); } catch (e) { console.error(e); sol = { ok: false, err: 'Erreur de calcul : ' + (e && e.message) }; }
  solKey = key;
  if (sol.ok) {
    // La grille de vents doit couvrir toute la zone utile : sinon on la retélécharge plus grande (une fois par besoin)
    const need = Math.max(Calc.dist(I.ptu, sol.ouv), Calc.dist(I.ptu, sol.circleOuv.c) + sol.circleOuv.R) / 1000;
    if (wxRec && need > wxRec.halfKm) { const g = Math.ceil(need * 1.15 / 5) * 5; if ((current.gridKm || 0) < g) current.gridKm = g; const k2 = current.id + '|' + current.when.slice(0, 10) + '|' + current.gridKm; if (gridAsked !== k2) { gridAsked = k2; setTimeout(() => ensureWx(false).then(() => { compute(); if (sol && sol.ok) fitFigure(); }), 50); } }
    scheduleAlti();
  }
}
function pName(i) { const p = isv().team[i]; return p ? `n° ${i + 1}${p.name ? ' ' + p.name : ''}` : ''; }

// ---------- Dessin ----------
const zmtIcon = L.divIcon({ className: 'tgt zmt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span><b>ZMT</b>' });
const triIcon = L.divIcon({ className: 'tri', iconSize: [22, 20], iconAnchor: [11, 13], html: '<span></span>' });
const lbl = (ll, html, cls) => L.marker(LL(ll), { interactive: false, icon: L.divIcon({ className: cls || 'glabel', iconSize: [0, 0], html: `<span>${html}</span>` }) });
const mk = {}; // marqueurs gardés : zmt, ptu, drop, rot, et un par point (pt_<id>)
function keep(key, ll, icon, z, onMove, onEnd, onClick) {
  let m = mk[key];
  if (!ll) { if (m) { handles.removeLayer(m); delete mk[key]; } return null; }
  if (!m) {
    m = mk[key] = L.marker(LL(ll), { draggable: false, icon, zIndexOffset: z || 0 }).addTo(handles);
    if (onMove) longPressDrag(m, onMove, onEnd || (() => {}));
    if (onClick) m.on('click', () => { if (Date.now() < suppressClickUntil) return; onClick(); });
  } else { if (!isDragging(m)) m.setLatLng(LL(ll)); if (icon && m._icoKey !== icon.options.html + icon.options.className) m.setIcon(icon); }
  m._icoKey = icon.options.html + icon.options.className;
  return m;
}
/* Le vecteur déplacé à la main est retenu dans le cercle de relaxation (zone avec marge). */
function clampToCircle(ll) { if (!sol || !sol.ok) return ll; const z = sol.zone || sol.circle, q = Calc.toLocal(z.c, ll), d = Math.hypot(q.x, q.y), R = Math.max(0, z.R - 20); return d <= R ? ll : Calc.fromLocal(z.c, { x: q.x * R / d, y: q.y * R / d }); }
let dragT = 0;
function dragRecalc() { const n = performance.now(); if (n - dragT > 220) { dragT = n; draw(true); } }
function pointLabel(pt) { if (pt.kind !== 'alt') return pt.name || ''; const I = isv(); if (typeof pt.elev !== 'number' || (typeof I.ptuElev !== 'number' && !wxRec)) return pt.name || ''; const d = Math.round(pt.elev - elev0()); return `${pt.name || ''} ${d >= 0 ? 'P' : 'M'}${Math.abs(d)}`.trim(); }
function draw(light) {
  compute();
  const I = isv(); fig.clearLayers();
  // ZRT : affichage seulement
  current.zrt.forEach(z => { if (z.show === false) return; z.lines.forEach(ln => L.polyline(ln.p, { color: '#ff2020', weight: 2, opacity: .9, dashArray: '10 6', fill: !!ln.c, fillOpacity: .06, interactive: false }).addTo(fig)); });
  // ZMT et PTU
  keep('zmt', I.zmt, zmtIcon, 300, ll => { I.zmt = ll; dragRecalc(); }, () => { persist(); fillInputs(); redraw(); });
  keep('ptu', I.ptu, dotIcon(C_PTU, 16, `PTU ${fmtInt(I.hPtu)} m`, 'big'), 400, ll => { I.ptu = ll; I.manual = null; I.ptuElev = null; dragRecalc(); }, () => { persist(); fillInputs(); redraw(); refreshPtuElev(); ensureWx(false); });
  // Points de la zone
  const seen = {};
  current.points.forEach(pt => {
    seen['pt_' + pt.id] = 1;
    const ic = pt.kind === 'alt' ? L.divIcon({ className: 'tgt alt', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span></span><b>${esc(pointLabel(pt))}</b>` })
      : L.divIcon({ className: 'crossp', iconSize: [26, 26], iconAnchor: [13, 13], html: `<i style="color:${pt.color || '#fff'}">✚</i><b style="color:${pt.color || '#fff'}">${esc(pt.name || '')}</b>` });
    keep('pt_' + pt.id, pt, ic, 250, ll => { pt.lat = ll.lat; pt.lng = ll.lng; }, () => { persist(); if (pt.kind === 'alt') pointElev(pt); }, () => pointMenu(pt));
  });
  Object.keys(mk).filter(k => k.startsWith('pt_') && !seen[k]).forEach(k => { handles.removeLayer(mk[k]); delete mk[k]; });

  if (!sol || !sol.ok) { keep('drop', null); keep('rot', null); if (!light) updateInfo(); return; }
  // Cercle de relaxation (points de largage)
  if (current.show.relax && sol.circle.R > 0) L.circle(LL(sol.circle.c), { radius: sol.circle.R, color: C_RELAX, weight: 2.4, fill: false, interactive: false }).addTo(fig);
  // Trace : tous les segments, de l'ouverture terminée au PTU
  const T = sol.trace.map(LL);
  L.polyline(T, { color: '#000', weight: 7, opacity: .55, interactive: false }).addTo(fig);
  L.polyline(T, { color: C_TRACE, weight: 3.6, interactive: false }).addTo(fig);
  const TP = sol.trace.map(p => map.latLngToContainerPoint(LL(p))), k0 = TP.length - 1;
  const flat = Math.abs(TP[k0].x - TP[0].x) > Math.abs(TP[k0].y - TP[0].y); let lastLab = null;
  sol.trace.forEach((p, i) => {
    if (i === k0) return; // le PTU a son propre point
    const far = !lastLab || TP[i].distanceTo(lastLab) >= (flat ? 26 : 20) || i === 0, farPtu = TP[i].distanceTo(TP[k0]) >= 30;
    const show = current.show.label && far && (farPtu || i === 0); if (show) lastLab = TP[i];
    L.marker(LL(p), { interactive: false, icon: dotIcon(C_TRACE, i === 0 ? 13 : 8, show ? (i === 0 ? `OUV ${fmtInt(p.h)}` : fmtInt(p.h)) : (i === 0 && !current.show.label ? 'OUV' : ''), (i === 0 ? 'big' : '') + (flat ? ' up' : '')) }).addTo(fig);
  });
  // Vecteur de largage
  const V = sol.vec, vl = [LL(V.green), LL(V.red)];
  L.polyline(vl, { color: '#fff', weight: 9, opacity: .9, interactive: false }).addTo(fig);
  L.polyline(vl, { color: '#000', weight: 4.5, interactive: false }).addTo(fig);
  V.exits.forEach(e => L.marker(LL(e), { interactive: false, icon: L.divIcon({ className: 'exitp' + (e.i === sol.dropIdx ? ' ref' : ''), iconSize: [12, 12], iconAnchor: [6, 6], html: '<span></span>' }) }).addTo(fig));
  L.marker(LL(V.red), { interactive: false, icon: dotIcon(C_END, 15, '', 'big') }).addTo(fig);
  // Poignées : point de largage (déplacer le vecteur), point vert (le faire tourner)
  keep('drop', V.attach, L.divIcon({ className: 'hdl', iconSize: [40, 40], iconAnchor: [20, 20], html: '<span></span>' }), 700,
    ll => { const c = clampToCircle(ll); I.manual = c; I.capManual = null; dragRecalc(); }, () => { persist(); fillInputs(); redraw(); toast(sol && sol.ok ? `${sol.openLowered ? 'Ouverture à ' + fmtInt(sol.hOpen) + ' m' : fmt1(sol.tFall) + ' s de chute'} · cap para ${hdg(sol.cap)}` : (sol && sol.err) || ''); });
  keep('rot', V.green, dotIcon(C_START, 15, '', 'big'), 650,
    ll => { if (!sol || !sol.ok) return; const q = Calc.toLocal(ll, sol.vec.attach); if (Math.hypot(q.x, q.y) < 20) return; I.vecHeading = Calc.bearingOf(q); I.reversed = false; dragRecalc(); },
    () => { persist(); fillInputs(); redraw(); if (sol && sol.ok) toast(`Cap du vecteur ${hdg(sol.acHeading)}`); });
  // Indications le long du vecteur et de la trace
  if (current.show.label) {
    const mid = { lat: (V.green.lat + V.red.lat) / 2, lng: (V.green.lng + V.red.lng) / 2 };
    const sideR = map.latLngToContainerPoint(LL(mid)).x <= map.getSize().x / 2; // étiquette vers le milieu de l'écran : jamais sous les boutons
    lbl(mid, `<i class="vcap">${hdg(V.heading)}</i> · ${fmtInt(V.length)} m`, 'vlabel vv ' + (sideR ? 'vr' : 'vl')).addTo(fig);
    const tm = Calc.pointAt(sol.trace, sol.length / 2);
    lbl(tm, `<i class="tcap">CAP ${hdg(sol.cap)}</i> · ${fmtKm(sol.length)}`, 'vlabel vt').addTo(fig);
  }
  // Ouverture basse : un point jaune par para
  (lowPoints() || []).forEach(p => L.circleMarker(LL(p), { radius: 5.5, color: '#000', weight: 1.5, fillColor: C_LOW, fillOpacity: 1, interactive: false }).addTo(fig));
  // Point le plus haut de la zone de sécurité
  if (I.alti && I.alti.max && I.alti.key === altiKey()) L.marker(LL(I.alti.max), { interactive: false, icon: triIcon }).addTo(fig);
  if (!light) updateInfo();
}
function freeRect() {
  // marges serrées (20 nov. 2026) : la figure remplit l'écran, ses bords peuvent frôler les boutons.
  // Tout en coordonnées de la carte (les rectangles des boutons sont ramenés à l'origine de la carte : sur iPhone,
  // la page peut être décalée et la carte ne commence pas forcément au bord de l'écran)
  const W = map.getSize().x, H = map.getSize().y, m = 4, c = map.getContainer().getBoundingClientRect();
  const rel = el => { const q = el.getBoundingClientRect(); return { left: q.left - c.left, right: q.right - c.left, top: q.top - c.top, bottom: q.bottom - c.top, width: q.width }; };
  // bord droit de la colonne de boutons = le plus à droite de ses BOUTONS : sur iPhone (Safari), une colonne qui passe
  // sur 2 ou 3 colonnes en paysage garde la largeur d'une seule (bug flex-wrap) → la figure passait sous les boutons
  const qr = Math.max(rel($('quick')).right, ...[...$('quick').querySelectorAll('button')].map(rel).filter(q => q.width).map(q => q.right));
  const l = Math.max(m, qr + m), r = W - 6;
  // haut : seuls les boutons du haut situés au-dessus de la zone libre comptent (en paysage, Manœuvre/Zones sont
  // au-dessus de la colonne de gauche : la figure peut monter jusqu'au bas des boutons ronds N/AXE/⤢/⌖)
  let t = m;
  const tops = [...document.querySelectorAll('#top button')].map(rel).filter(q => q.width);
  tops.forEach(q => { if (q.right > l && q.left < r) t = Math.max(t, q.bottom + m); });
  return { l, t, r, b: H - 22, tops };
}
// Zones libres candidates : A = sous les boutons du haut, toute la largeur ; B = tout en haut, mais à gauche des
// boutons ronds (en paysage, la figure peut monter jusqu'en haut de l'écran à gauche de N/AXE/⤢/⌖ — photo d'Henri du 20 nov.).
// Le cadrage garde celle qui donne la plus grande figure.
function freeRects() {
  const A = freeRect(), m = 4;
  let rb = Infinity; A.tops.forEach(q => { if (q.left > A.l && q.top < A.t) rb = Math.min(rb, q.left - m); });
  const B = { l: A.l, t: m, r: Math.min(A.r, rb), b: A.b };
  return B.r - B.l >= 120 && B.t < A.t ? [A, B] : [A];
}
// Étiquettes (degrés, chiffres, hauteurs…) : leur débord en pixels au-delà de la figure est réservé en plus,
// sinon le cadrage serré les cache sous les boutons (« 180° » devenu « 80° », 20 nov. 2026)
const FIT_LABELS = '.glabel span, .dot b, .tgt span, .tgt b, .crossp b';
function labelOverhang(x0, x1, y0, y1) {
  const o = { l: 0, r: 0, t: 0, b: 0 }; if (!FIT_LABELS) return o;
  const c = map.getContainer().getBoundingClientRect();
  document.querySelectorAll(FIT_LABELS).forEach(el => {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    const lx0 = r.left - c.left, lx1 = r.right - c.left, ly0 = r.top - c.top, ly1 = r.bottom - c.top;
    o.l = Math.max(o.l, x0 - lx0); o.r = Math.max(o.r, lx1 - x1); o.t = Math.max(o.t, y0 - ly0); o.b = Math.max(o.b, ly1 - y1);
  });
  return o;
}
function fitFigure() {
  const pts = figurePoints(); if (pts.length < 2) return;
  map.invalidateSize({ animate: false }); // taille réelle de l'écran (portrait / paysage)
  const c0 = map.getCenter(), z0 = map.getZoom(); let best = null;
  freeRects().forEach(R => {
    map.setView(c0, z0, { animate: false }); fitInto(pts, R);
    if (!best || map.getZoom() > best.z + 0.01) best = { c: map.getCenter(), z: map.getZoom(), R };
  });
  map.setView(best.c, best.z, { animate: false });
  fitCheck(pts, best.R);
  redraw();
}
// Contrôle après cadrage : boîte réelle (points + étiquettes mesurées à l'écran) dans la zone choisie ; sinon on décale,
// et si elle est trop grande on dézoome d'un cran (photo d'Henri du 20 nov. : figure passée sous la colonne de boutons)
function fitCheck(pts, R) {
  for (let k = 0; k < 6; k++) {
    draw();
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    let x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x)), y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const o = labelOverhang(x0, x1, y0, y1); x0 -= o.l; x1 += o.r; y0 -= o.t; y1 += o.b;
    if (x1 - x0 > R.r - R.l + 1 || y1 - y0 > R.b - R.t + 1) { map.setZoom(map.getZoom() - 0.05, { animate: false }); continue; }
    const dx = x0 < R.l ? R.l - x0 : x1 > R.r ? R.r - x1 : 0, dy = y0 < R.t ? R.t - y0 : y1 > R.b ? R.b - y1 : 0;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    map.panBy([-dx, -dy], { animate: false });
  }
}
function fitInto(pts, R) {
  for (let pass = 0; pass < 3; pass++) { // 3 passes : les étiquettes sont remesurées après chaque zoom
    draw(); // étiquettes à jour pour ce zoom
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    const x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x));
    const y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const o = labelOverhang(x0, x1, y0, y1);
    const aw = Math.max(80, R.r - R.l - o.l - o.r), ah = Math.max(80, R.b - R.t - o.t - o.b);
    const k = Math.min(aw / Math.max(x1 - x0, 1), ah / Math.max(y1 - y0, 1));
    const z = Math.min(19, Math.floor((map.getZoom() + Math.log2(k)) * 20) / 20); // zoom au 1/20 près
    const centerLL = map.containerPointToLatLng([(x0 + x1) / 2, (y0 + y1) / 2]);
    map.setView(centerLL, z, { animate: false });
    // centre de la figure au centre de la zone libre, décalé du débord des étiquettes
    const S = map.getSize(), cx = S.x / 2, cy = S.y / 2, ax = (R.l + R.r + o.l - o.r) / 2, ay = (R.t + R.b + o.t - o.b) / 2;
    map.panBy([cx - ax, cy - ay], { animate: false });
  }
}

function figurePoints() {
  const I = isv(), pts = [];
  if (I.zmt) pts.push(I.zmt); if (I.ptu) pts.push(I.ptu);
  if (sol && sol.ok) {
    sol.trace.forEach(p => pts.push(p)); pts.push(sol.vec.green, sol.vec.red);
    (lowPoints() || []).forEach(p => pts.push(p));
    if (current.show.relax) [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].forEach(a => pts.push(Calc.fromLocal(sol.circle.c, { x: sol.circle.R * Math.sin(a * Math.PI / 180), y: sol.circle.R * Math.cos(a * Math.PI / 180) })));
  }
  return pts.map(p => ({ lat: p.lat, lng: p.lng }));
}
function updateInfo() {
  const I = isv(); let t = null;
  if (placing) return;
  if (!I.zmt && !I.ptu) t = 'Onglet ISV : place la zone de posé (ZMT) puis le point d\'entrée PTU.';
  else if (!I.ptu) t = 'Place le point d\'entrée PTU (onglet ISV).';
  else if (sol && !sol.ok) t = sol.err;
  else if (sol && sol.warn) t = '⚠️ ' + sol.warn;
  else if (!F) t = zeroWind ? null : '⚠️ Pas de prévision de vent pour cette heure : trace calculée SANS VENT.';
  setBanner(t);
}

// ---------- Interface ----------
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); addPlaceCancel(); } }
// Pendant un placement (toucher la carte), bouton « ✕ Annuler » dans le bandeau (21 nov. 2026, demande d'Henri)
function addPlaceCancel() {
  let p = null; try { p = placing; } catch (e) { return; } // placing pas encore déclaré au tout début
  const b = $('banner'); if (!p || b.querySelector('.bcancel')) return;
  const c = document.createElement('button'); c.className = 'bcancel'; c.textContent = '✕ Annuler';
  c.onclick = e => { e.stopPropagation(); cancelPlacing(); toast('Placement annulé'); };
  b.append(document.createElement('br'), c);
}
function cancelPlacing() { placing = null; placeBanner(); fillInputs(); redraw(); }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200); }
const numIn = el => parseFloat(String(el.value).replace(',', '.'));
function setVal(id, v) { const el = $(id); if (document.activeElement !== el) el.value = v == null ? '' : v; }
function changed(fit) { persist(); fillInputs(); draw(); if (fit && sol && sol.ok) fitFigure(); }
function onNum(id, fn, min, max) { $(id).addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v) || (min != null && v < min) || (max != null && v > max)) { toast('Valeur refusée'); fillInputs(); return; } fn(v); changed(); }); }
function fillInputs() {
  compute(); // les champs affichent toujours le dernier calcul
  const I = isv();
  $('zoneName').textContent = current.id ? current.name : 'Nouvelle zone'; $('isvName').textContent = ' · ' + I.name;
  $('ver').textContent = VERSION;
  setVal('i_hPtu', I.hPtu); setVal('i_tGreen', I.tGreen); setVal('i_tRed', I.tRed);
  $('zmtInfo').textContent = I.zmt ? fmtPos(I.zmt) : 'Pas encore placée.';
  $('ptuInfo').textContent = I.ptu ? fmtPos(I.ptu) : 'Pas encore placé.';
  $('ptuElevInfo').textContent = I.ptu ? (typeof I.ptuElev === 'number' ? `Sol sous le PTU : ${fmtInt(I.ptuElev)} m` : `Sol sous le PTU : ${fmtInt(elev0())} m (modèle météo, relevé en attente)`) : '';
  $('btnPlaceZ').classList.toggle('on', placing === 'Z'); $('btnPlaceP').classList.toggle('on', placing === 'P');
  setVal('p_margin', prm.margin); setVal('p_openLoss', prm.openLoss); setVal('p_vff', prm.vff);
  setVal('a_long', I.secLong); setVal('a_lat', I.secLat);
  syncQuick(); syncJump();
  const open = !$('sheet').classList.contains('hidden');
  if (open && lastTab === 'isv') { renderPtList(); renderIsvTab(); }
  if (open && lastTab === 'vol') renderVol();
  if (open && lastTab === 'alti') renderAlti();
  if (open && lastTab === 'params') renderCans();
  if (open && lastTab === 'zones') { renderZones(); renderIsvList(); renderZrt(); }
}
function syncQuick() {
  const I = isv();
  $('qRelax').classList.toggle('on', !!current.show.relax); $('qLabel').classList.toggle('on', !!current.show.label);
  $('qRev').classList.toggle('on', !!I.reversed);
  $('qVecAuto').classList.toggle('hidden', !(I.manual || I.vecHeading != null || I.capManual != null));
  $('qZero').classList.toggle('on', zeroWind); $('qWinds').classList.toggle('on', !$('windsBox').classList.contains('hidden'));
  $('qPoint').classList.toggle('on', !!(placing && typeof placing === 'object'));
}
function quick(fn) { fn(); persist(); fillInputs(); redraw(); }
$('qRelax').addEventListener('click', () => quick(() => { current.show.relax = !current.show.relax; }));
$('qLabel').addEventListener('click', () => quick(() => { current.show.label = !current.show.label; }));
$('qRev').addEventListener('click', () => quick(() => { const I = isv(); I.reversed = !I.reversed; }));
$('qVecAuto').addEventListener('click', () => { quick(() => { const I = isv(); I.manual = null; I.vecHeading = null; I.capManual = null; I.reversed = false; }); toast('Vecteur et cap para recalculés'); });
$('qZero').addEventListener('click', () => { zeroWind = !zeroWind; store.set('isv.zeroWind', zeroWind); fillInputs(); draw(); if (!$('windsBox').classList.contains('hidden')) renderWinds(); toast(zeroWind ? 'ESSAI : vent forcé à 0 partout' : 'Vent réel rétabli'); });
$('qVol').addEventListener('click', () => toggleTab('vol'));
$('qIsv').addEventListener('click', () => toggleTab('isv'));

// ---------- Saut : date et heure ----------
const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${pad2(h)}">${pad2(h)} h</option>`).join('');
$('j_hour').innerHTML = hourOpts; $('t_hour').innerHTML = hourOpts;
function syncJump() {
  $('qWhen').innerHTML = `${fmtWhen(current.when).replace(' ', '<br>')}<br>FL${sol && sol.ok ? sol.fl : isv().fl}`;
  $('j_date').value = current.when.slice(0, 10); $('j_hour').value = current.when.slice(11, 13);
  $('wxInfo').innerHTML = wxStatus(wxCached(current.id, current.when.slice(0, 10)), current.when);
}
const fmtFetched = ts => { const d = new Date(ts); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} à ${pad2(d.getHours())}h${pad2(d.getMinutes())}`; };
const wxFailed = {}; // jour → dernier téléchargement raté
function wxStatus(rec, when) {
  if (!rec) return navigator.onLine === false || wxFailed[when.slice(0, 10)] ? '⚠️ Pas de réseau et aucune prévision gardée pour ce jour.' : 'Prévision en cours de téléchargement…';
  const ok = (rec.time || []).includes(when);
  return `${rec.model.split(' (')[0]} · prévision du ${fmtFetched(rec.fetched)} · 9 points sur ${Math.round(rec.halfKm * 2)} km${Date.now() - rec.fetched > 3 * 3600e3 ? ' <b class="warn">(ancienne : mets à jour si tu as du réseau)</b>' : ''}${ok ? '' : ' <b class="warn">(pas de donnée à cette heure)</b>'}`;
}
let wxBusy = false;
async function ensureWx(force, date) {
  date = date || current.when.slice(0, 10);
  const have = wxCached(current.id, date);
  if (have && !force && wxFits(have) && Date.now() - have.fetched < 3600e3 && have.rh !== undefined) return have; // prévision d'avant l'humidité (rh absent) : retéléchargée
  if (have && !force && !wxFits(have) && navigator.onLine === false) return have;
  if (!force && !isv().ptu && !isv().zmt) return have; // rien à calculer tant qu'aucun point n'est placé
  if (wxBusy) return have; wxBusy = true; $('wxInfo').innerHTML = 'Téléchargement de la prévision…';
  try { const r = await wxFetch(current, date); delete wxFailed[date]; return r; }
  catch (e) { wxFailed[date] = true; toast(have ? 'Pas de réseau : prévision gardée, téléchargée le ' + fmtFetched(have.fetched) : 'Prévision impossible à télécharger (réseau ?)'); return have; }
  finally { wxBusy = false; fillInputs(); redraw(); }
}
function setWhen(w) { current.when = w; persist(); fillInputs(); redraw(); ensureWx(false); }
$('qWhen').addEventListener('click', () => { $('jumpBox').classList.toggle('hidden'); syncJump(); });
$('jumpOk').addEventListener('click', () => { $('jumpBox').classList.add('hidden'); });
$('j_minus').addEventListener('click', () => setWhen(shiftWhen(current.when, -1)));
$('j_plus').addEventListener('click', () => setWhen(shiftWhen(current.when, 1)));
$('j_now').addEventListener('click', () => { current.when = nowWhen(); persist(); fillInputs(); ensureWx(true); });
$('j_date').addEventListener('change', e => { if (e.target.value) setWhen(e.target.value + current.when.slice(10)); });
$('j_hour').addEventListener('change', e => setWhen(current.when.slice(0, 11) + e.target.value + ':00'));

// ---------- Tableau des vents, à la verticale du PTU (date et heure indépendantes de la carte) ----------
let tWhen = null;
function windRows(Fx, pt, e0) { // une ligne par tranche de 1 000 ft (FL), du sol au FL400
  const rows = [], add = (lab, alt) => { const w = Calc.windAt(Fx, pt.lat, pt.lng, alt), sd = Calc.spdDir(w); rows.push({ lab, h: alt - e0, dir: sd.dir, spd: sd.spd, T: w.T, RH: Calc.rhAt(Fx, pt.lat, pt.lng, alt) }); };
  add('Sol (10 m)', e0 + 10);
  for (let fl = 10; fl <= 400; fl += 10) { const alt = Calc.flToAlt(Fx, pt, fl); if (alt > e0 + 30) add('FL' + String(fl).padStart(3, '0'), alt); }
  return rows;
}
function renderWinds() {
  const date = tWhen.slice(0, 10), rec = wxCached(current.id, date), Fx = fieldOf(rec, tWhen), pt = wxWanted().center, e0 = elev0();
  $('t_date').value = date; $('t_hour').value = tWhen.slice(11, 13);
  $('t_info').innerHTML = wxStatus(rec, tWhen) + ` · à la verticale du ${isv().ptu ? 'PTU' : 'centre'} · hauteurs au-dessus du sol (${fmtInt(e0)} m)`;
  const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
  if (!Fx) { tb.innerHTML = '<tr><td colspan="6" class="mut">Pas de donnée pour cette heure.</td></tr>'; return; }
  windRows(Fx, pt, e0).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.lab}</td><td>${fmtInt(r.h)} m</td><td>${hdgN(r.dir)}</td><td>${Math.round(r.spd * KT)} kt</td><td>${fmt1(r.spd)} m/s</td><td>${r.T == null ? '–' : Math.round(r.T) + ' °C'}</td><td>${r.RH == null ? '–' : Math.round(r.RH) + ' %'}</td>`;
    tb.append(tr);
  });
}
async function setTWhen(w) { tWhen = w; renderWinds(); const d = w.slice(0, 10), have = wxCached(current.id, d); if (!have || Date.now() - have.fetched > 3600e3 || have.rh === undefined) { await ensureWx(false, d); renderWinds(); } }
$('qWinds').addEventListener('click', () => { const b = $('windsBox'); if (!b.classList.contains('hidden')) { b.classList.add('hidden'); syncQuick(); return; } b.classList.remove('hidden'); syncQuick(); setTWhen(current.when); });
$('t_close').addEventListener('click', () => { $('windsBox').classList.add('hidden'); syncQuick(); });
$('t_minus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, -1)));
$('t_plus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, 1)));
$('t_now').addEventListener('click', () => setTWhen(nowWhen()));
$('t_date').addEventListener('change', e => { if (e.target.value) setTWhen(e.target.value + tWhen.slice(10)); });
$('t_hour').addEventListener('change', e => setTWhen(tWhen.slice(0, 11) + e.target.value + ':00'));

// ---------- Placement de la ZMT, du PTU et des points ----------
function placeBanner() {
  setBanner(placing === 'Z' ? 'Touche la carte pour placer la zone de posé (ZMT).' : placing === 'P' ? 'Touche la carte pour placer le point d\'entrée PTU.'
    : placing ? (placing.kind === 'move' ? `Touche la carte pour le nouvel emplacement de « ${placing.name} ».` : placing.kind === 'alt' ? 'Touche la carte pour placer la zone de posé alternative.' : 'Touche la carte pour placer le point libre.') : null);
  if (!placing) updateInfo();
}
function startPlacing(what) { placing = placing === what ? null : what; stopMeasure(); if (placing) closeSheet(); placeBanner(); fillInputs(); }
$('btnPlaceZ').addEventListener('click', () => startPlacing('Z'));
$('btnPlaceP').addEventListener('click', () => startPlacing('P'));
function setZmt(p) { const I = isv(); I.zmt = { lat: p.lat, lng: p.lng }; persist(); fillInputs(); draw(); if (!I.ptu) { placing = 'P'; placeBanner(); toast('ZMT placée. Maintenant le point d\'entrée PTU.'); } }
function setPtu(p) { const I = isv(); I.ptu = { lat: p.lat, lng: p.lng }; I.manual = null; I.ptuElev = null; persist(); fillInputs(); draw(); refreshPtuElev(); ensureWx(false).then(() => { compute(); if (sol && sol.ok) fitFigure(); }); }
async function askCoords(what) {
  const t = await ask(`Coordonnées ${what} : degrés et minutes décimales (N 44°18,468' E 001°04,865'), MGRS (31T CK 46949 07851) ou degrés décimaux (44.3078 1.0811).`, '');
  if (!t) return null; const c = parseCoords(t); if (!c) { toast('Coordonnées non comprises'); return null; } return c;
}
$('btnCoordZ').addEventListener('click', async () => { if (!(await askZoneName())) return; const c = await askCoords('de la zone de posé'); if (!c) return; map.setView(LL(c), Math.max(map.getZoom(), 13)); setZmt(c); });
$('btnCoordP').addEventListener('click', async () => { if (!(await askZoneName())) return; const c = await askCoords('du point d\'entrée PTU'); if (!c) return; map.setView(LL(c), Math.max(map.getZoom(), 13)); setPtu(c); });
// Points : zone de posé alternative (rouge, cible) ou point libre (croix, couleur au choix)
const PT_COLORS = ['#ffffff', '#ffd400', '#1ec83c', '#00e5ff', '#2f80ff', '#ff3fb4', '#ff8c00', '#000000'];
let ptColor = PT_COLORS[1];
$('ptColors').innerHTML = PT_COLORS.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join('');
function syncPtColors() { $('ptColors').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === ptColor)); }
$('ptColors').addEventListener('click', e => { const c = e.target && e.target.dataset && e.target.dataset.c; if (c) { ptColor = c; syncPtColors(); } });
$('qPoint').addEventListener('click', () => { if (placing && typeof placing === 'object') { placing = null; placeBanner(); fillInputs(); return; } syncPtColors(); $('ptDlg').classList.remove('hidden'); });
$('ptCancel').addEventListener('click', () => $('ptDlg').classList.add('hidden'));
$('ptAlt').addEventListener('click', () => { $('ptDlg').classList.add('hidden'); startPlacing({ kind: 'alt' }); });
$('ptFree').addEventListener('click', () => { $('ptDlg').classList.add('hidden'); startPlacing({ kind: 'free', color: ptColor }); });
async function pointElev(pt) { try { const [e] = await fetchElev([pt]); if (typeof e === 'number') { pt.elev = Math.round(e); persist(); redraw(); } } catch (e) {} }
async function addPoint(p, spec) {
  const n = await ask(spec.kind === 'alt' ? 'Nom de la zone de posé alternative (l\'écart de hauteur avec le sol sous le PTU est ajouté tout seul, P = plus haut, M = plus bas) :' : 'Nom du point :', '');
  if (n === null) return;
  const pt = { id: uid('q'), kind: spec.kind, name: String(n).trim(), lat: p.lat, lng: p.lng, color: spec.kind === 'alt' ? '#ff2020' : spec.color, elev: null };
  current.points.push(pt); persist(); redraw(); fillInputs(); if (pt.kind === 'alt') pointElev(pt);
}
// Point déjà posé : nom (et couleur pour un point libre) modifiables, ou suppression
function renderPtList() {
  const ul = $('ptList'); ul.innerHTML = '';
  if (!current.points.length) { ul.innerHTML = '<li class="mut">Aucun point posé.</li>'; return; }
  current.points.forEach(pt => {
    const li = document.createElement('li'), alt = pt.kind === 'alt';
    li.innerHTML = `<span class="pic${alt ? ' alt' : ''}" style="color:${alt ? '#ff2020' : (pt.color || '#fff')}">${alt ? '◎' : '✚'}</span><span class="zn">${esc(pointLabel(pt) || '(sans nom)')}<br><small class="mut">${alt ? 'Zone de posé alternative' : 'Point libre'}</small></span>`;
    li.querySelector('.zn').onclick = () => { setSheetSize('mini'); map.setView(LL(pt), Math.max(map.getZoom(), 15)); };
    const ed = document.createElement('button'); ed.textContent = '✏️'; ed.title = 'Modifier'; ed.onclick = () => pointMenu(pt);
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Supprimer';
    del.onclick = async () => { if (!(await ask(`Supprimer « ${pointLabel(pt) || 'ce point'} » ?`))) return; current.points = current.points.filter(x => x.id !== pt.id); persist(); redraw(); fillInputs(); };
    li.append(ed, del); ul.append(li);
  });
}
$('btnAddPt').addEventListener('click', async () => { if (!(await askZoneName())) return; if (placing && typeof placing === 'object') { placing = null; placeBanner(); } syncPtColors(); $('ptDlg').classList.remove('hidden'); });
function pointMenu(pt) {
  let col = pt.color || PT_COLORS[1];
  $('peText').innerHTML = `<b>${pt.kind === 'alt' ? 'Zone de posé alternative' : 'Point libre'}</b><br><small>${fmtPos(pt)}${typeof pt.elev === 'number' ? ' · ' + fmtInt(pt.elev) + ' m' : ''}</small>`;
  $('peName').value = pt.name || '';
  const cs = $('peColors'); cs.classList.toggle('hidden', pt.kind === 'alt');
  const sync = () => cs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === col));
  cs.innerHTML = PT_COLORS.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join(''); sync();
  cs.onclick = e => { const c = e.target && e.target.dataset && e.target.dataset.c; if (c) { col = c; sync(); } };
  const close = () => { $('ptEdit').classList.add('hidden'); $('peOk').onclick = $('peCancel').onclick = $('peDel').onclick = $('peMove').onclick = null; };
  $('peOk').onclick = () => { pt.name = $('peName').value.trim(); if (pt.kind !== 'alt') pt.color = col; close(); persist(); redraw(); fillInputs(); };
  $('peMove').onclick = () => { pt.name = $('peName').value.trim(); if (pt.kind !== 'alt') pt.color = col; close(); persist(); redraw();
    startPlacing({ kind: 'move', id: pt.id, name: pointLabel(pt) || (pt.kind === 'alt' ? 'zone de posé alternative' : 'point libre') }); };
  $('peCancel').onclick = close;
  $('peDel').onclick = async () => { close(); if (!(await ask(`Supprimer « ${pointLabel(pt) || 'ce point'} » ?`))) return; current.points = current.points.filter(x => x.id !== pt.id); persist(); redraw(); fillInputs(); };
  $('ptEdit').classList.remove('hidden');
}

// ---------- Mesure : cap et distance entre deux points touchés (dans l'ordre) ----------
const measLayer = L.layerGroup().addTo(map);
const meas = { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null };
function capDeg(a, b) { // cap initial (orthodromie) de a vers b, en degrés
  const r = Math.PI / 180, f1 = a.lat * r, f2 = b.lat * r, dl = (b.lng - a.lng) * r;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`; }
function measBox(t) { const b = $('measureBox'); if (!t) b.classList.add('hidden'); else { b.innerHTML = t; b.classList.remove('hidden'); } }
function stopMeasure() {
  Object.assign(meas, { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null });
  map.getContainer().classList.remove('measuring');
  measLayer.clearLayers(); measBox(null); $('qMeasure').classList.remove('on');
}
$('qMeasure').addEventListener('click', () => {
  if (meas.active) { stopMeasure(); return; }
  if (placing) return toast('Termine d\'abord le placement en cours');
  meas.active = true; $('qMeasure').classList.add('on'); map.getContainer().classList.add('measuring');
  measBox('Mesure : touche le <b>1er point</b>');
});
// Points de mesure déplaçables (comme les portes) : la mesure se met à jour pendant le glissement
const measIcon = L.divIcon({ className: 'measpt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span>' });
function measMarker(key) {
  const m = L.marker(LL(meas[key]), { draggable: false, icon: measIcon, zIndexOffset: 900 }).addTo(measLayer);
  longPressDrag(m, ll => { meas[key] = ll; updateMeasure(); }, () => { const q = snapMeasure(meas[key]); if (q !== meas[key]) { meas[key] = q; m.setLatLng([q.lat, q.lng]); updateMeasure(); } });
  return m;
}
function updateMeasure() {
  if (!meas.a || !meas.b) return;
  const a = meas.a, b = meas.b, d = map.distance(LL(a), LL(b)), mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
  const c = capDeg(a, b); // cap vrai, affiché en magnétique par hdg
  const txt = `${hdg(c)} · ${fmtDist(d)}`;
  if (!meas.line) {
    meas.halo = L.polyline([LL(a), LL(b)], { color: '#000', weight: 3.5, opacity: .5, interactive: false }).addTo(measLayer);
    meas.line = L.polyline([LL(a), LL(b)], { color: '#00e5ff', weight: 2, dashArray: '8 6', interactive: false }).addTo(measLayer);
    meas.lbl = L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'measlbl', iconSize: [0, 0], html: `<span>${txt}</span>` }) }).addTo(measLayer);
  } else {
    meas.halo.setLatLngs([LL(a), LL(b)]); meas.line.setLatLngs([LL(a), LL(b)]); meas.lbl.setLatLng(mid);
    const el = meas.lbl.getElement && meas.lbl.getElement(); if (el) el.querySelector('span').textContent = txt;
  }
  measBox(`<b>Cap ${hdg(c)} · ${fmtDist(d)}</b><br><small>Appui long sur un point puis glisse pour ajuster · 📏 = effacer</small>`);
}
// Pendant la mesure (21 nov. 2026, demande d'Henri) : les autres points ne réagissent plus au doigt (classe « measuring »
// sur la carte, voir style.css), et un point de mesure posé à moins de 22 px d'un point existant se cale exactement dessus.
function snapMeasure(p) {
  const P = map.latLngToContainerPoint([p.lat, p.lng]); let best = p, bd = 22;
  map.eachLayer(l => {
    if (measLayer.hasLayer(l) || !l.getLatLng || (L.Circle && l instanceof L.Circle)) return;
    if (l instanceof L.Marker) { const sz = l.options.icon && l.options.icon.options && l.options.icon.options.iconSize; if (!sz || !(+sz[0] > 0)) return; } // étiquettes : pas de cible
    else if (!(l instanceof L.CircleMarker)) return;
    const ll = l.getLatLng(), d = P.distanceTo(map.latLngToContainerPoint(ll));
    if (d < bd) { bd = d; best = { lat: ll.lat, lng: ll.lng }; }
  });
  return best;
}
function measureClick(p) {
  p = snapMeasure(p);
  if (!meas.a) { meas.a = p; meas.ma = measMarker('a'); measBox('Mesure : touche le <b>2e point</b>'); return; }
  if (!meas.b) { meas.b = p; meas.mb = measMarker('b'); updateMeasure(); }
  // une fois les deux points posés, on les déplace au doigt ; un appui sur la carte ne fait rien
}

let namingZone = false;
map.on('click', e => {
  if (Date.now() < suppressClickUntil) return; // fin d'un déplacement de point : pas un appui
  if ((typeof Photo !== 'undefined') && Photo.onMapClick(e)) return; // calage d'une image en cours
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) return;
  if (!current.id) { if (!namingZone) { namingZone = true; askZoneName().then(ok => { namingZone = false; if (ok) map.fire('click', e); }); } return; } // nom d'abord, puis le point
  const p = { lat: e.latlng.lat, lng: e.latlng.lng }, what = placing;
  placing = null; placeBanner();
  if (what === 'Z') setZmt(p); else if (what === 'P') setPtu(p);
  else if (what.kind === 'move') { const pt = current.points.find(x => x.id === what.id); if (pt) { pt.lat = p.lat; pt.lng = p.lng; if (pt.kind === 'alt') { pt.elev = null; pointElev(pt); } persist(); redraw(); toast(`« ${what.name} » repositionné`); } }
  else addPoint(p, what);
  fillInputs();
});
map.on('zoomend', redraw);
(function delayTouchRotate() {
  const TG = map.touchGestures; if (!TG || !TG._onTouchStart) return;
  const ROT_HOLD_MS = 300, ROT_TOL = 12; // doigts quasi immobiles pendant 0,3 s → la rotation s'active
  const cp = t => map.mouseEventToContainerPoint(t);
  const origStart = TG._onTouchStart, origMove = TG._onTouchMove;
  TG._onTouchStart = function (e) {
    origStart.call(this, e);
    this._rotPending = null;
    if (this._rotating) { // le plug-in voulait tourner tout de suite : on met en attente
      this._rotating = false;
      this._rotPending = { t: Date.now(), p1: cp(e.touches[0]), p2: cp(e.touches[1]) };
    }
  };
  TG._onTouchMove = function (e) {
    const rp = this._rotPending;
    if (rp && e.touches && e.touches.length === 2) {
      const p1 = cp(e.touches[0]), p2 = cp(e.touches[1]);
      const d = Math.max(p1.distanceTo(rp.p1), p2.distanceTo(rp.p2));
      if (d > ROT_TOL) {
        if (Date.now() - rp.t >= ROT_HOLD_MS) { // doigts restés immobiles assez longtemps : on tourne
          const v = rp.p1.subtract(rp.p2);
          this._startTheta = Math.atan(v.x / v.y);
          this._startBearing = map.getBearing() + (v.y < 0 ? 180 : 0);
          this._rotating = true;
        }
        this._rotPending = null; // sinon : déplacement / zoom à deux doigts, sans rotation
      }
    }
    return origMove.call(this, e);
  };
  TG.disable(); TG.enable(); // ré-abonne les écouteurs aux versions modifiées
})();
let lastLand = innerWidth > innerHeight, fitT = 0, fitPending = false;
function onResize() {
  clearTimeout(fitT);
  const land = innerWidth > innerHeight; if (land !== lastLand) { lastLand = land; fitPending = true; }
  fitT = setTimeout(() => {
    map.invalidateSize({ animate: false });
    if (fitPending) { fitPending = false; if (figurePoints().length >= 2) { fitFigure(); setTimeout(() => { map.invalidateSize({ animate: false }); fitFigure(); }, 700); } }
  }, 500);
}
['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, onResize));
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
let sheetSize = 'full';
function setSheetSize(sz) { sheetSize = sz; $('sheet').classList.toggle('mini', sz === 'mini'); $('sheet').classList.toggle('full', sz === 'full'); }
(function sheetGrab() {
  const g = $('grab'); let y0 = null, moved = false;
  const start = y => { y0 = y; moved = false; };
  const end = y => {
    if (y0 === null) return; const dy = y - y0; y0 = null;
    if (Math.abs(dy) < 12) { setSheetSize(sheetSize === 'full' ? 'mini' : 'full'); return; } // simple toucher : bascule
    if (dy < 0) setSheetSize('full');                                        // vers le haut : grand
    else if (sheetSize === 'full') setSheetSize('mini');                     // vers le bas : réduit…
    else closeSheet();                                                       // …puis fermé
  };
  g.addEventListener('touchstart', e => start(e.touches[0].clientY), { passive: true });
  g.addEventListener('touchend', e => end(e.changedTouches[0].clientY));
  g.addEventListener('mousedown', e => start(e.clientY));
  window.addEventListener('mouseup', e => end(e.clientY));
})();
const TABS = ['zones', 'isv', 'vol', 'alti', 'params'];
let lastTab = 'isv';
function openSheet(tab) {
  lastTab = tab;
  $('sheet').classList.remove('hidden'); setSheetSize(sheetSize);
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  TABS.forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  fillInputs();
}
function closeSheet() { $('sheet').classList.add('hidden'); applyFrom = null; }
function toggleTab(t) { if (!$('sheet').classList.contains('hidden') && lastTab === t) closeSheet(); else openSheet(t); }
$('btnParams').addEventListener('click', () => toggleTab('params'));
$('btnZones').addEventListener('click', () => toggleTab('zones'));
$('btnClose').addEventListener('click', closeSheet);
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.tab)));
// Petite fenêtre : texte, champ facultatif, 3e bouton facultatif (renvoie 'DELETE'), libellés au choix
// cancelLabel === false : pas de bouton Annuler
function ask(text, def, delLabel, okLabel, cancelLabel) {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlgInput').value = def || ''; $('dialog').classList.remove('hidden');
    $('dlgInput').classList.toggle('hidden', def === undefined);
    $('dlgDel').classList.toggle('hidden', !delLabel); $('dlgDel').textContent = delLabel || '';
    $('dlgOk').textContent = okLabel || 'OK';
    $('dlgCancel').classList.toggle('hidden', cancelLabel === false); $('dlgCancel').textContent = cancelLabel || 'Annuler';
    const done = v => { $('dialog').classList.add('hidden'); $('dlgOk').onclick = $('dlgCancel').onclick = $('dlgDel').onclick = null; res(v); };
    $('dlgOk').onclick = () => done(def === undefined ? true : $('dlgInput').value.trim());
    $('dlgCancel').onclick = () => done(null);
    $('dlgDel').onclick = () => done('DELETE');
    if (def !== undefined && !delLabel) setTimeout(() => $('dlgInput').focus(), 50);
  });
}

// Réordonner une liste : on tient la poignée ≡ et on glisse la ligne vers le haut ou le bas
function dragReorder(li, handle, onEnd) {
  let y0 = 0, dy = 0, active = false;
  handle.addEventListener('pointerdown', e => { e.preventDefault(); active = true; y0 = e.clientY; dy = 0; try { handle.setPointerCapture(e.pointerId); } catch (er) {} li.classList.add('zdrag'); });
  handle.addEventListener('pointermove', e => {
    if (!active) return;
    dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`;
    const ul = li.parentNode, rows = [...ul.children].filter(x => x !== li && x.dataset.id);
    const yMid = li.getBoundingClientRect().top + li.offsetHeight / 2;
    const before = rows.find(r => { const b = r.getBoundingClientRect(); return yMid < b.top + b.height / 2; }) || null;
    if (li.nextSibling !== before) { const top0 = li.getBoundingClientRect().top - dy; ul.insertBefore(li, before); li.style.transform = ''; const top1 = li.getBoundingClientRect().top; y0 += top1 - top0; dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`; }
  });
  const end = () => { if (!active) return; active = false; li.classList.remove('zdrag'); li.style.transform = ''; onEnd([...li.parentNode.children].map(x => x.dataset.id).filter(Boolean)); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}

// ---------- Onglet ISV : équipe ----------
let applyFrom = null; // id du para dont on recopie l'intervalle sur d'autres
function canOpts(sel) { return prm.canopies.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join(''); }
function renderIsvTab() {
  const I = isv(), ul = $('teamList'); $('teamCount').textContent = `(${I.team.length})`;
  if (ul.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return; // saisie en cours : on ne reconstruit pas la liste
  ul.innerHTML = '';
  const src = applyFrom && I.team.find(p => p.id === applyFrom);
  $('applyHint').innerHTML = src ? `<b class="warn">Touche les paras qui doivent prendre ${fmt1(+src.dt)} s d'intervalle, puis « Terminé ».</b>` : 'Intervalle = temps entre un para et celui qui sort avant lui. ⧉ : recopier l\'intervalle d\'un para sur d\'autres. Tiens ≡ et glisse pour changer l\'ordre de sortie.';
  I.team.forEach((p, i) => {
    const li = document.createElement('li'); li.dataset.id = p.id; li.className = 'para' + (src ? ' pick' : '') + (src && p.id === src.id ? ' src' : '');
    if (src) {
      li.innerHTML = `<span class="pn">${i + 1}</span><span class="pnm">${esc(p.name || 'Para ' + (i + 1))}</span><span class="pdt">${i === 0 ? '1er' : fmt1(+p.dt) + ' s'}</span>`;
      if (i > 0 && p.id !== src.id) li.onclick = () => { p.dt = +src.dt; persist(); draw(); renderIsvTab(); };
    } else {
      li.innerHTML = `<div class="pr1"><span class="zhandle" title="Glisser pour changer l'ordre">≡</span><span class="pn">${i + 1}</span><input class="pname" placeholder="Nom" value="${esc(p.name || '')}"><select class="pcan">${canOpts(p.canopy)}</select><button class="pdel" title="Retirer ce para">🗑</button></div>` +
        `<div class="pr2"><label>MTE (kg)</label><input class="pmte" inputmode="numeric" value="${esc(String(+p.mte > 0 ? +p.mte : MTE_DEF))}">` +
        (i === 0 ? `<span class="mut first">Sort en premier</span>` : `<label>Intervalle (s)</label><input class="pdtin" inputmode="decimal" value="${fmt1(+p.dt)}"><button class="pcopy" title="Recopier cet intervalle sur d'autres paras">⧉</button>`) + `</div>`;
      li.querySelector('.pname').addEventListener('change', e => { p.name = e.target.value.trim(); persist(); draw(); });
      li.querySelector('.pcan').addEventListener('change', e => { p.canopy = e.target.value; changed(); });
      li.querySelector('.pmte').addEventListener('change', e => { const t = e.target.value.trim().replace(',', '.'); if (t !== '' && !(+t >= 30 && +t <= 400)) { toast('MTE refusée (30 à 400 kg)'); e.target.value = p.mte; return; } p.mte = t === '' ? MTE_DEF : +t; e.target.value = p.mte; changed(); });
      li.querySelector('.pdel').addEventListener('click', async () => { if (I.team.length < 2) return toast('Il faut au moins un para'); if (!(await ask(`Retirer le para ${pName(i)} ?`))) return; I.team = I.team.filter(x => x.id !== p.id); changed(); });
      if (i > 0) {
        li.querySelector('.pdtin').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v) || v < 0 || v > 120) { toast('Valeur refusée'); e.target.value = fmt1(+p.dt); return; } p.dt = v; persist(); draw(); });
        li.querySelector('.pcopy').addEventListener('click', () => { applyFrom = p.id; renderIsvTab(); });
      }
      dragReorder(li, li.querySelector('.zhandle'), order => { I.team.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); changed(); });
    }
    ul.append(li);
  });
  if (src) {
    const li = document.createElement('li'); li.className = 'applybar';
    li.innerHTML = '<button class="aall">Appliquer à tous</button><button class="adone primary">Terminé</button>'; ul.append(li);
    li.querySelector('.aall').onclick = () => { I.team.forEach((p, i) => { if (i > 0) p.dt = +src.dt; }); applyFrom = null; changed(); };
    li.querySelector('.adone').onclick = () => { applyFrom = null; changed(); };
  }
  // Résultat en clair
  const r = $('resInfo');
  if (!sol || !sol.ok) r.textContent = sol && sol.err ? sol.err : '';
  else r.innerHTML = `Voile la moins performante : <b>${esc(sol.weak.canopy.name)}</b>${sol.weak.several ? ` (para ${esc(pName(sol.weak.idx))}, ${fmtInt(sol.weak.mte)} kg)` : ''}.<br>` +
    `Trace <b>${fmtKm(sol.length)}</b> · CAP PARA <b>${hdg(sol.cap)}</b>${sol.capAuto ? '' : ' (choisi à la main)'} · ouverture terminée à <b>${fmtInt(sol.hOpen)} m</b>.<br>` +
    `Largage <b>FL${sol.fl}</b> · ${sol.openLowered ? `<b class="warn">ouverture à ${fmtInt(sol.hOpen)} m</b> (${fmt1(sol.tFall)} s de chute, vecteur déplacé à la main)` : `${fmt1(sol.tFall)} s de chute`} · vecteur <b>${hdg(sol.acHeading)}</b>, ${fmtInt(sol.vec.length)} m · para ${esc(pName(sol.dropIdx))} sur le point de largage.` +
    (sol.warn ? `<br><b class="warn">⚠️ ${esc(sol.warn)}</b>` : '') + (F ? '' : '<br><b class="warn">⚠️ Sans prévision de vent.</b>');
}
$('btnAddPara').addEventListener('click', () => { const I = isv(), last = I.team[I.team.length - 1]; const p = newPara(last && last.canopy); p.dt = last ? +last.dt || 3 : 3; I.team.push(p); changed(); });
$('btnAddN').addEventListener('click', async () => {
  const I = isv(), t = await ask('Nombre total de parachutistes dans l\'équipe :', String(I.team.length)); if (!t) return;
  const n = parseInt(t, 10); if (!(n >= 1 && n <= 60)) return toast('Entre 1 et 60');
  while (I.team.length < n) { const last = I.team[I.team.length - 1], p = newPara(last.canopy); p.dt = +last.dt || 3; I.team.push(p); }
  if (I.team.length > n) { if (!(await ask(`Garder seulement les ${n} premiers paras ?`))) return; I.team.length = n; }
  changed();
});
$('btnDtAll').addEventListener('click', () => { const v = numIn($('i_dtAll')); if (isNaN(v) || v < 0 || v > 120) return toast('Saisis un intervalle en secondes'); isv().team.forEach((p, i) => { if (i > 0) p.dt = v; }); applyFrom = null; changed(); toast(`Intervalle de ${fmt1(v)} s pour tous`); });
onNum('i_hPtu', v => { isv().hPtu = Math.round(v); isv().manual = null; }, 0, 5000);
onNum('i_tGreen', v => { isv().tGreen = v; }, 0, 120);
onNum('i_tRed', v => { isv().tRed = v; }, 0, 120);

// ---------- Onglet Vol : données de vol ----------
function vzRefNow() { const I = isv(), ids = I.team.map(p => p.canopy); const used = prm.canopies.filter(c => ids.includes(c.id)); return Math.min(...(used.length ? used : prm.canopies).map(c => +c.vz)); }
function renderVol() {
  const I = isv(), ok = sol && sol.ok;
  setVal('v_fl', ok ? sol.fl : I.fl); setVal('v_ac', fmt1(+I.acMs)); setVal('v_tFall', fmt1(ok ? sol.tFall : +I.tFall)); setVal('v_hOpen', ok ? Math.round(sol.hOpen) : '');
  setVal('v_cap', ok ? String(magOf(sol.cap)).padStart(3, '0') : ''); setVal('v_acH', ok ? String(magOf(sol.acHeading)).padStart(3, '0') : '');
  $('v_capAuto').classList.toggle('on', I.capManual == null && !I.manual); $('v_acAuto').classList.toggle('on', I.vecHeading == null);
  $('v_flInfo').innerHTML = ok ? `FL${sol.fl} = ${fmtInt(sol.hRel)} m au-dessus du sol sous le PTU${sol.openLowered ? ` · <b class="warn">vecteur déplacé à la main : ouverture à ${fmtInt(sol.hOpen)} m au lieu de ${fmtInt(sol.hOpenPlan)} m (${fmt1(sol.tFall)} s de chute au lieu de ${fmt1(sol.tFallPlan)} s)</b>` : ''} · ${Math.round(I.acMs * KT)} kt badin = ${Math.round(sol.tas * KT)} kt vraie` : '';
  const dSel = $('v_drop'), rSel = $('v_relax');
  if (document.activeElement !== dSel) dSel.innerHTML = `<option value="">Auto : ${esc(pName(Calc.defaultDropIdx(I.team.length)))}</option>` + I.team.map((p, i) => `<option value="${p.id}"${p.id === I.dropId ? ' selected' : ''}>${esc(pName(i))}</option>`).join('');
  if (document.activeElement !== rSel) rSel.innerHTML = `<option value="green"${I.relaxRef === 'green' ? ' selected' : ''}>Début de largage (vert)</option>` + I.team.map((p, i) => `<option value="${p.id}"${p.id === I.relaxRef ? ' selected' : ''}>${esc(pName(i))}</option>`).join('') + `<option value="red"${I.relaxRef === 'red' ? ' selected' : ''}>Fin de largage (rouge)</option>`;
  const tb = $('volTable').querySelector('tbody'); tb.innerHTML = '';
  $('v_warn').innerHTML = ok ? (sol.warn ? `<b class="warn">⚠️ ${esc(sol.warn)}</b>` : '') : esc(sol && sol.err || '');
  if (!ok) return;
  volRows().forEach(([k, v, hi]) => { const tr = document.createElement('tr'); if (hi) tr.className = 'hi'; tr.innerHTML = `<td>${k}</td><td>${v}</td>`; tb.append(tr); });
}
const sgn = (v, plus) => Math.abs(v) < 0.05 ? '0' : `${plus ? '+' : '−'}${fmt1(Math.abs(v))} s`;
function volRows() { // [libellé, valeur, mis en évidence] — sert à l'écran et au PDF
  const I = isv(), s = sol, rows = [];
  rows.push(['Temps de largage (au point de relaxation)', `${sgn(s.relax.before, false)} / ${sgn(s.relax.after, true)}`, true]);
  rows.push(['Vecteur de largage', `${hdg(s.acHeading)} · ${fmtInt(s.vec.length)} m · ${fmt1(s.ex.total)} s`]);
  rows.push(['Vitesse sol de l\'avion', `${Math.round(s.vg * KT)} kt (${Math.round(s.vg)} m/s)`]);
  rows.push(['Vent au largage', `${hdg(s.windRel.dir)} · ${Math.round(s.windRel.spd * KT)} kt`]);
  rows.push(['Dérive sous RSE', `${fmtInt(s.rseLen)} m`]);
  rows.push(['Trace (CAP PARA ' + hdg(s.cap) + ')', `${fmtKm(s.length)} · ${fmtKm(s.direct)} en ligne droite`]);
  rows.push(['Ouverture terminée', `${fmtInt(s.hOpen)} m au-dessus du sol sous le PTU`]);
  rows.push([`Temps sous voile (para ${esc(pName(s.dropIdx))}, ${esc(s.own.canopy.name)})`, fmtMin(s.own.tCanopy)]);
  if (s.own.t180 != null) rows.push(['Passage du FL180, depuis le vert', fmtMin(s.own.t180)]);
  if (s.own.t120 != null) rows.push(['Passage du FL120, depuis le vert', fmtMin(s.own.t120)]);
  rows.push(['Voile la moins performante', `${esc(s.weak.canopy.name)}${s.weak.several ? ' · para ' + esc(pName(s.weak.idx)) + ' (' + fmtInt(s.weak.mte) + ' kg)' : ''}`]);
  if (s.turn) rows.push(['Prise de cap', `à ${s.turn}`, true]);
  if (s.hand) rows.push(['PTU', `main ${s.hand}`, true]);
  rows.push(['Cercle de relaxation', `rayon ${fmtKm(s.circle.R)} (marge comprise)`]);
  rows.push(['Marge sur le vent', `${prm.margin} %${F ? '' : ' · SANS PRÉVISION DE VENT'}${zeroWind ? ' · ESSAI VENT 0' : ''}`]);
  return rows;
}
onNum('v_fl', v => { isv().fl = Math.round(v); }, 20, 400);
onNum('v_ac', v => { isv().acMs = v; }, 20, 200);
onNum('v_tFall', v => { isv().tFall = v; }, 0, 120);
$('v_hOpen').addEventListener('change', e => {
  const v = numIn(e.target), I = isv(); if (!sol || !sol.ok || isNaN(v)) { fillInputs(); return; }
  const drop = sol.hRel - v; if (drop < 1 || v <= I.hPtu + 50) { toast('Hauteur d\'ouverture impossible avec ce FL'); fillInputs(); return; }
  I.tFall = Calc.tFallFor(drop, sol.tas, Math.max(10, +prm.vff), +prm.openLoss, vzRefNow(), false, Calc.ffK(F, I.ptu, sol.altRel)); changed();
});
function setCap(m) { const I = isv(); I.capManual = trueOf(n360(m)); I.manual = null; changed(); }
function setAcH(m) { const I = isv(); I.vecHeading = trueOf(n360(m)); I.reversed = false; changed(); }
$('v_cap').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v)) return fillInputs(); setCap(v); });
$('v_capM').addEventListener('click', () => { if (sol && sol.ok) setCap(magOf(sol.cap) - 1); });
$('v_capP').addEventListener('click', () => { if (sol && sol.ok) setCap(magOf(sol.cap) + 1); });
$('v_capAuto').addEventListener('click', () => { const I = isv(); I.capManual = null; I.manual = null; changed(); toast('CAP PARA : le plus loin possible du PTU'); });
$('v_acH').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v)) return fillInputs(); setAcH(v); });
$('v_acM').addEventListener('click', () => { if (sol && sol.ok) setAcH(magOf(sol.acHeading) - 1); });
$('v_acP').addEventListener('click', () => { if (sol && sol.ok) setAcH(magOf(sol.acHeading) + 1); });
$('v_acAuto').addEventListener('click', () => { const I = isv(); I.vecHeading = null; I.reversed = false; changed(); toast('Vecteur perpendiculaire à la trace, face au vent'); });
$('v_drop').addEventListener('change', e => { isv().dropId = e.target.value || null; e.target.blur(); changed(); });
$('v_relax').addEventListener('change', e => { isv().relaxRef = e.target.value; e.target.blur(); changed(); });

// ---------- Onglet Altimétrie ----------
/* Zone de sécurité (v0.3.0, demande d'Henri) : le para n'est pas à la verticale du vecteur quand son système de sécurité
   déclenche, il a dérivé sous RSE. La zone est donc le rectangle autour du vecteur (marges avant / après et de côté) ET tout ce
   que ce rectangle balaie quand on le fait glisser le long de la dérive d'un para qui chute sans ouvrir, du largage jusqu'à
   1013,25 hPa (plancher fixe : pas besoin de connaître le point haut pour trouver le point haut). Vent prévu, sans marge. */
const SEC_HPA = 1013.25, secMem = { k: null, v: null };
function secPath() { /* dérive (m, repère local du milieu du vecteur) d'un para qui chute sans ouvrir jusqu'à 1013,25 hPa */
  if (!sol || !sol.ok) return [{ z: 0, x: 0, y: 0 }];
  const g = sol.vec.green, r = sol.vec.red, mid = { lat: (g.lat + r.lat) / 2, lng: (g.lng + r.lng) / 2 };
  const k = [solKey, mid.lat.toFixed(4), mid.lng.toFixed(4), Math.round(sol.altRel), Math.round(sol.tas), prm.vff, Math.round(sol.acHeading * 10)].join('|');
  if (secMem.k === k) return secMem.v;
  const drop = sol.altRel - Calc.zOfP(F, mid.lat, mid.lng, SEC_HPA), vff = Math.max(10, +prm.vff || 50); let v = [{ z: 0, x: 0, y: 0 }];
  if (drop > 1) { const kff = Calc.ffK(F, mid, sol.altRel); v = Calc.rsePath(F, mid, sol.altRel, Calc.fall(Calc.tFallFor(drop, sol.tas, vff, 0, 1, true, kff), sol.tas, vff, 0, 1, kff), sol.acHeading); }
  secMem.k = k; secMem.v = v; return v;
}
function altiKey() {
  if (!sol || !sol.ok) return ''; const I = isv(), r = p => p.lat.toFixed(4) + ',' + p.lng.toFixed(4), P = secPath(), q = p => Math.round(p.x / 20) + ',' + Math.round(p.y / 20);
  return [r(sol.vec.green), r(sol.vec.red), I.secLong, I.secLat, q(P[P.length >> 1]), q(P[P.length - 1])].join('|');
}
/* Points de la zone de sécurité (grille au pas donné), dans le repère du vecteur : s le long (0 = vert), w en travers */
function secGrid(step) {
  const I = isv(), a = Calc.unit(sol.vec.heading), r = { x: a.y, y: -a.x }, L = sol.vec.length, sl = Math.max(0, +I.secLong || 0), sw = Math.max(0, +I.secLat || 0);
  const raw = secPath().map(p => ({ s: p.x * a.x + p.y * a.y, w: p.x * r.x + p.y * r.y })), path = [raw[0]];
  for (let k = 1; k < raw.length; k++) { /* chemin resserré : jamais plus d'un demi-pas entre deux positions du rectangle */
    const A = path[path.length - 1], B = raw[k], d = Math.hypot(B.s - A.s, B.w - A.w), n = Math.ceil(d / (step / 2));
    if (d < step / 2 && k < raw.length - 1) continue;
    for (let m = 1; m <= Math.max(1, n); m++) path.push({ s: A.s + (B.s - A.s) * m / Math.max(1, n), w: A.w + (B.w - A.w) * m / Math.max(1, n) });
  }
  let s0 = 0, s1 = 0, w0 = 0, w1 = 0; path.forEach(p => { s0 = Math.min(s0, p.s); s1 = Math.max(s1, p.s); w0 = Math.min(w0, p.w); w1 = Math.max(w1, p.w); });
  const pts = [], e = 1;
  for (let s = s0 - sl; s <= s1 + L + sl + e; s += step) for (let w = w0 - sw; w <= w1 + sw + e; w += step)
    if (path.some(p => s - p.s >= -sl - e && s - p.s <= L + sl + e && Math.abs(w - p.w) <= sw + e)) pts.push({ s, w });
  return { pts, a, r, drift: Math.hypot(raw[raw.length - 1].s, raw[raw.length - 1].w) };
}
const SEC_MAX_PTS = 1600;
let altiT = 0, altiBusy = false;
function scheduleAlti() { clearTimeout(altiT); altiT = setTimeout(() => computeAlti(false), 2500); }
async function computeAlti(manual) {
  const I = isv(); if (!sol || !sol.ok) return; const key = altiKey();
  if (!manual && I.alti && I.alti.key === key) return;
  if (altiBusy) { if (!manual) scheduleAlti(); return; } altiBusy = true;
  try {
    let step = 100, g = secGrid(step); while (g.pts.length > SEC_MAX_PTS && step < 400) { step += 20; g = secGrid(step); }
    const o = sol.vec.green, pts = g.pts.map(p => Calc.fromLocal(o, { x: g.a.x * p.s + g.r.x * p.w, y: g.a.y * p.s + g.r.y * p.w }));
    const el = await fetchElev(pts); let best = -1;
    el.forEach((e, i) => { if (typeof e === 'number' && (best < 0 || e > el[best])) best = i; });
    if (best >= 0 && isv() === I) { I.alti = { key, max: { lat: pts[best].lat, lng: pts[best].lng, elev: Math.round(el[best]) }, n: pts.length, step, drift: Math.round(g.drift), t: Date.now() }; persist(); redraw(); if (lastTab === 'alti') renderAlti(); }
  } catch (e) { if (manual) toast('Altitudes impossibles à télécharger (réseau ?)'); }
  finally { altiBusy = false; }
}
function altiVals() { // valeurs d'altimétrie, ou null si le point haut n'est pas à jour
  const I = isv(); if (!sol || !sol.ok) return null;
  const alpha = Calc.pOfZ(F, I.ptu.lat, I.ptu.lng, sol.elev0), o = { alpha: Math.round(alpha), elevPtu: sol.elev0 };
  if (I.alti && I.alti.max && I.alti.key === altiKey()) { const m = I.alti.max; o.max = m; o.oso = Math.round(Calc.pOfZ(F, m.lat, m.lng, m.elev)); o.hRel = sol.altRel - m.elev; }
  return o;
}
// Ouverture basse : pour chaque para, point d'ouverture terminée s'il chutait jusqu'à LOW_FT au-dessus du point haut
// au lieu d'ouvrir comme prévu (projection + vent de chaque tranche, depuis son point de largage). Points jaunes, sans nom.
const LOW_FT = 1900, lowMem = { k: null, v: null };
function lowPoints() {
  const av = altiVals(); if (!av || !av.max || !sol || !sol.ok) return null;
  const k = solKey + '|' + altiKey() + '|' + av.max.elev; if (lowMem.k === k) return lowMem.v;
  let v = null;
  const drop = sol.altRel - (av.max.elev + LOW_FT * 0.3048), vff = Math.max(10, +prm.vff || 50), ol = Math.max(0, +prm.openLoss || 0);
  if (drop > ol + 1) {
    const kff = Calc.ffK(F, isv().ptu, sol.altRel), f = Calc.fall(Calc.tFallFor(drop, sol.tas, vff, ol, vzRefNow(), true, kff), sol.tas, vff, ol, vzRefNow(), kff);
    v = sol.vec.exits.map(e => Calc.fromLocal(e, Calc.rseDrift(F, e, sol.altRel, f, sol.acHeading)));
  }
  lowMem.k = k; lowMem.v = v; return v;
}
function renderAlti() {
  const tb = $('altiTable').querySelector('tbody'), v = altiVals(); tb.innerHTML = '';
  if (!v) { tb.innerHTML = '<tr><td class="mut">Pas encore de vecteur.</td></tr>'; return; }
  const rows = [];
  rows.push(['Point le plus haut de la zone de sécurité', v.max ? `${fmtInt(v.max.elev)} m` : 'calcul en cours…']);
  rows.push(['OSO', v.max ? `${v.oso} hPa` : '…', true]);
  rows.push(['ALPHA', `${v.alpha} hPa`, true]);
  rows.push(['Hauteur de largage', v.max ? `${fmtInt(v.hRel)} m` : '…', true]);
  { const I = isv(); if (v.max && I.alti && I.alti.drift != null) rows.push(['Zone de sécurité', `vecteur et ses marges, prolongés de ${fmtInt(I.alti.drift)} m le long de la dérive sous RSE`]); }
  rows.push(['Sol sous le PTU', `${fmtInt(v.elevPtu)} m`]);
  if (!F) rows.push(['', '<b class="warn">Sans prévision : pressions en atmosphère standard</b>']);
  rows.forEach(([k, val, hi]) => { const tr = document.createElement('tr'); if (hi) tr.className = 'hi'; tr.innerHTML = `<td>${k}</td><td>${val}</td>`; tb.append(tr); });
}
onNum('a_long', v => { isv().secLong = Math.round(v); scheduleAlti(); }, 0, 20000);
onNum('a_lat', v => { isv().secLat = Math.round(v); scheduleAlti(); }, 0, 10000);
$('btnAlti').addEventListener('click', () => computeAlti(true));

// ---------- Onglet Paramètres : parachutes et calcul ----------
function renderCans() {
  const ul = $('canList'); if (ul.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  ul.innerHTML = '';
  prm.canopies.forEach(c => {
    const li = document.createElement('li'); li.className = 'can';
    li.innerHTML = `<input class="cn" value="${esc(c.name)}" placeholder="Nom"><label>Vx</label><input class="cx" inputmode="decimal" value="${fmt1(+c.vx)}"><label>Vz</label><input class="cz" inputmode="decimal" value="${fmt1(+c.vz)}"><button class="cdel">🗑</button>`;
    li.querySelector('.cn').addEventListener('change', e => { c.name = e.target.value.trim() || c.name; saveProfile(); changed(); });
    const num = (cls, key, min, max) => li.querySelector(cls).addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v) || v < min || v > max) { toast('Valeur refusée'); e.target.value = fmt1(+c[key]); return; } c[key] = v; saveProfile(); changed(); });
    num('.cx', 'vx', 1, 40); num('.cz', 'vz', 0.5, 20);
    li.querySelector('.cdel').addEventListener('click', async () => {
      if (prm.canopies.length < 2) return toast('Il faut au moins un parachute');
      const used = zones.concat([current]).some(z => z.isvs.some(i => i.team.some(p => p.canopy === c.id)));
      if (!(await ask(`Supprimer le parachute « ${c.name} » ?${used ? ' Les paras qui l\'utilisent passeront sur le premier de la liste.' : ''}`))) return;
      prm.canopies = prm.canopies.filter(x => x.id !== c.id); const first = prm.canopies[0].id;
      zones.concat([current]).forEach(z => z.isvs.forEach(i => i.team.forEach(p => { if (p.canopy === c.id) p.canopy = first; })));
      saveProfile(); store.set('isv.zones', zones); changed();
    });
    ul.append(li);
  });
}
$('btnAddCan').addEventListener('click', async () => { const n = await ask('Nom du parachute :', ''); if (!n) return; prm.canopies.push({ id: uid('c'), name: String(n).trim(), vx: 9, vz: 2.5 }); saveProfile(); changed(); toast('Parachute ajouté : règle Vx et Vz'); });
const onPrm = (id, key, min, max) => onNum(id, v => { prm[key] = v; saveProfile(); }, min, max);
onPrm('p_margin', 'margin', 0, 80); onPrm('p_openLoss', 'openLoss', 0, 1000); onPrm('p_vff', 'vff', 20, 100);

// ---------- Zones et ISV ----------
function resetMarkers() { Object.keys(mk).forEach(k => { handles.removeLayer(mk[k]); delete mk[k]; }); solKey = ''; }
function renderZones() {
  const ul = $('zoneList'); ul.innerHTML = '';
  if (!zones.length) ul.innerHTML = '<li class="mut">Aucune zone enregistrée.</li>';
  zones.forEach(z => {
    const li = document.createElement('li');
    li.className = z.id === current.id ? 'cur' : ''; li.dataset.id = z.id;
    li.innerHTML = `<span class="zhandle" title="Glisser pour réordonner">≡</span><span class="zn">${esc(z.name)} <small class="mut">${z.isvs.length} ISV</small></span>`;
    li.querySelector('.zn').onclick = () => loadZone(z.id);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => {
      const n = await ask('Nouveau nom :', z.name); if (!n) return;
      z.name = n; if (current.id === z.id) current.name = n; store.set('isv.zones', zones); persist(); fillInputs();
    };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (!(await ask(`Supprimer « ${z.name} » et ses ${z.isvs.length} ISV ?`))) return;
      zones = zones.filter(x => x.id !== z.id); store.set('isv.zones', zones); if ((typeof Photo !== 'undefined')) Photo.remove(z.id);
      if (current.id === z.id) { current = newZone(map.getCenter()); current.zoom = map.getZoom(); resetMarkers(); placing = null; persist(); redraw(); }
      fillInputs();
    };
    li.append(ren, del); ul.append(li);
    dragReorder(li, li.querySelector('.zhandle'), order => { zones.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); store.set('isv.zones', zones); });
  });
}
function renderIsvList() {
  const ul = $('isvList'); ul.innerHTML = '';
  current.isvs.forEach(I => {
    const li = document.createElement('li'); li.className = I.id === current.cur ? 'cur' : '';
    li.innerHTML = `<span class="zn">${esc(I.name)} <small class="mut">${I.team.length} para${I.team.length > 1 ? 's' : ''} · FL${I.fl}</small></span>`;
    li.querySelector('.zn').onclick = () => openIsv(I.id);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => { const n = await ask('Nom de l\'ISV :', I.name); if (!n) return; I.name = n; persist(); fillInputs(); };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (current.isvs.length < 2) return toast('Une zone garde au moins une ISV');
      if (!(await ask(`Supprimer l'ISV « ${I.name} » ?`))) return;
      current.isvs = current.isvs.filter(x => x.id !== I.id); if (current.cur === I.id) current.cur = current.isvs[0].id; resetMarkers(); changed(true);
    };
    li.append(ren, del); ul.append(li);
  });
}
function openIsv(id) { current.cur = id; resetMarkers(); placing = null; closeSheet(); persist(); fillInputs(); draw(); if (sol && sol.ok) fitFigure(); ensureWx(false); refreshPtuElev(); toast(`ISV « ${isv().name} »`); }
$('btnNewIsv').addEventListener('click', async () => {
  if (!(await askZoneName())) return;
  const n = await ask('Nom de la nouvelle ISV :', `ISV ${current.isvs.length + 1}`); if (!n) return;
  const I = newIsv(String(n).trim()); current.isvs.push(I); openIsv(I.id); startPlacing('Z');
});
$('btnDupIsv').addEventListener('click', async () => {
  if (!(await askZoneName())) return;
  const n = await ask('Nom de la copie :', isv().name + ' (copie)'); if (!n) return;
  const I = clone(isv()); I.id = uid('i'); I.name = String(n).trim(); I.team.forEach(p => { const old = p.id; p.id = uid('p'); if (I.dropId === old) I.dropId = p.id; if (I.relaxRef === old) I.relaxRef = p.id; });
  current.isvs.push(I); openIsv(I.id);
});
function loadZone(id) {
  const z = zones.find(x => x.id === id); if (!z) return;
  current = upgrade(clone(z));
  resetMarkers(); placing = null; setBanner(null); stopMeasure();
  map.setBearing(current.bearing || 0);
  map.setView([current.center.lat, current.center.lng], current.zoom || 11);
  closeSheet(); fillInputs(); draw(); persist();
  if (sol && sol.ok) fitFigure();
  ensureWx(false); refreshPtuElev();
}
// Zone jamais nommée : on demande son nom AVANT le premier point, et elle s'enregistre ensuite toute seule
async function askZoneName(msg) {
  if (current.id) return true;
  const n = await ask(msg || 'Nom de la zone ? Elle s\'enregistre ensuite toute seule.', current.name && current.name !== 'Nouvelle zone' ? current.name : '');
  if (!n || !String(n).trim()) return false;
  current.name = String(n).trim(); current.id = 'z' + Date.now(); current.updated = Date.now();
  // la prévision déjà téléchargée pour la zone sans nom suit la zone
  try { Object.keys(localStorage).filter(k => k.startsWith('isv.wx.tmp.')).forEach(k => { const nk = k.replace('isv.wx.tmp.', `isv.wx.${current.id}.`); localStorage.setItem(nk, localStorage.getItem(k)); localStorage.removeItem(k); delete wxMem[k]; }); } catch (e) {}
  zones.push(clone(current)); store.set('isv.zones', zones); persist(); fillInputs();
  toast(`Zone « ${current.name} » enregistrée`); return true;
}
async function startNewZone(center, zoom) {
  $('nzDlg').classList.add('hidden');
  const n = await ask('Nom de la nouvelle zone :', ''); if (!n) return;
  current = newZone(center); current.zoom = zoom || 12;
  current.name = n; current.id = 'z' + Date.now(); current.updated = Date.now();
  zones.push(clone(current)); store.set('isv.zones', zones);
  resetMarkers(); stopMeasure();
  map.setView([center.lat, center.lng], current.zoom);
  placing = 'Z'; closeSheet(); fillInputs(); persist(); draw(); placeBanner();
  toast(`« ${n} » créée : touche la carte pour placer la zone de posé (ZMT)`);
}
$('btnNewZone').addEventListener('click', () => { $('searchResults').innerHTML = ''; $('nzDlg').classList.remove('hidden'); });
$('nzCancel').addEventListener('click', () => $('nzDlg').classList.add('hidden'));
$('nzMap').addEventListener('click', () => { const c = map.getCenter(); startNewZone({ lat: c.lat, lng: c.lng }, map.getZoom()); });
$('nzHere').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  $('nzHere').textContent = '📍 Recherche de ta position…';
  navigator.geolocation.getCurrentPosition(pos => { $('nzHere').textContent = '📍 Ma position'; startNewZone({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 13); },
    () => { $('nzHere').textContent = '📍 Ma position'; toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});
async function doSearch() {
  const q = $('searchInput').value.trim(); if (!q) return;
  const ul = $('searchResults'); ul.innerHTML = '';
  const c = parseCoords(q);
  if (c) { startNewZone(c, 13); return; }
  // 1) Clubs FFP enregistrés dans l'appli (sans réseau), proposés en premier (v0.5.1, comme les autres applis)
  const clubs = typeof searchClubs === 'function' ? searchClubs(q) : [];
  clubs.forEach(k => {
    const li = document.createElement('li'); const b = document.createElement('button');
    b.className = 'res club'; b.innerHTML = `<b>🪂 ${esc(k.n)}</b><br><small>Club FFP · ${esc(k.v)}</small>`;
    b.onclick = () => startNewZone({ lat: k.lat, lng: k.lng }, 13);
    li.append(b); ul.append(li);
  });
  // 2) Puis la recherche de lieux habituelle
  const wait = document.createElement('li'); wait.className = 'mut'; wait.textContent = 'Recherche…'; ul.append(wait);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=fr&q=' + encodeURIComponent(q));
    const js = await r.json(); wait.remove();
    if (!js.length && !clubs.length) ul.innerHTML = '<li class="mut">Rien trouvé.</li>';
    js.forEach(x => { const li = document.createElement('li'), b = document.createElement('button'); b.className = 'res'; b.textContent = x.display_name; b.onclick = () => startNewZone({ lat: +x.lat, lng: +x.lon }, 12); li.append(b); ul.append(li); });
  } catch (e) { wait.textContent = clubs.length ? 'Autres lieux : pas de réseau.' : 'Recherche impossible (pas de réseau ?). Tu peux taper des coordonnées.'; }
}
$('btnSearch').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ---------- Position, boussole ----------
function locate(center) {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (posMarker) posMarker.setLatLng(ll);
    else posMarker = L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: '#2f80ff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView(ll, Math.max(map.getZoom(), 17));
  }, () => { if (center) toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('btnLocate').addEventListener('click', () => locate(true));

// Boussole : nord en haut. leaflet-rotate : setBearing(b) tourne la carte de +b, donc le cap h est en haut avec b = -h.
const normB = x => ((x % 360) + 360) % 360, diffB = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
function setMapBearing(b, msg) { map.setBearing(b); current.bearing = b; syncCompass(); persist(); if (msg) toast(msg); }
$('btnNorth').addEventListener('click', () => setMapBearing(0, 'Nord en haut'));
$('btnAxisUp').addEventListener('click', () => { if (!sol || !sol.ok) return toast('Pas encore de trace'); setMapBearing(normB(-sol.cap), `Cap para (${hdg(sol.cap)}) vers le haut`); });
$('btnFit').addEventListener('click', () => { if (figurePoints().length > 1) fitFigure(); else toast('Place d\'abord la ZMT et le PTU'); });

// ---------- ZRT : import de tracés KML, KMZ ou GPX (affichage seulement) ----------
async function unzipFirst(buf, ext) { // lit le premier fichier d'un .kmz (zip) portant l'extension voulue
  const dv = new DataView(buf), u8 = new Uint8Array(buf); let eo = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error('zip');
  let p = dv.getUint32(eo + 16, true); const n = dv.getUint16(eo + 10, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    if (name.toLowerCase().endsWith(ext)) {
      const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = u8.subarray(ds, ds + csize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('compression');
      const st = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(st).text();
    }
    p += 46 + nl + el + cl;
  }
  throw new Error('kml absent');
}
function parseTraces(txt) {
  const doc = new DOMParser().parseFromString(txt, 'text/xml'), lines = [], r5 = v => Math.round(v * 1e5) / 1e5;
  const all = tag => [...doc.getElementsByTagName('*')].filter(e => e.localName === tag);
  all('coordinates').forEach(c => { // KML : « lng,lat,alt lng,lat,alt … »
    const pts = c.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(a => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map(a => [r5(a[1]), r5(a[0])]);
    if (pts.length > 1) { const closed = c.parentNode && c.parentNode.localName === 'LinearRing'; if (closed) pts.closed = true; lines.push(pts); }
  });
  ['trkseg', 'rte'].forEach(tag => all(tag).forEach(seg => { // GPX : traces et itinéraires
    const pts = [...seg.children].filter(e => e.localName === 'trkpt' || e.localName === 'rtept').map(e => [r5(+e.getAttribute('lat')), r5(+e.getAttribute('lon'))]).filter(a => isFinite(a[0]) && isFinite(a[1]));
    if (pts.length > 1) lines.push(pts);
  }));
  return lines;
}
$('btnZrt').addEventListener('click', async () => { if (!(await askZoneName())) return; $('zrtFile').value = ''; $('zrtFile').click(); });
$('zrtFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const txt = /\.kmz$/i.test(f.name) ? await unzipFirst(await f.arrayBuffer(), '.kml') : await f.text();
    const raw = parseTraces(txt); if (!raw.length) return toast('Aucun tracé trouvé dans ce fichier');
    let n = 0; raw.forEach(l => { n += l.length; });
    if (n > 20000) return toast('Fichier trop lourd (plus de 20 000 points)');
    const z = { id: uid('r'), name: f.name.replace(/\.(kml|kmz|gpx)$/i, ''), show: true, lines: raw.map(l => ({ c: !!l.closed, p: Array.from(l) })) };
    current.zrt.push(z);
    persist(); fillInputs(); redraw();
    map.fitBounds(L.latLngBounds([].concat(...z.lines.map(l => l.p))), { padding: [30, 30] });
    toast(`ZRT « ${z.name} » : ${raw.length} tracé(s)`);
  } catch (er) { console.error(er); toast('Fichier illisible (KML, KMZ ou GPX attendu)'); }
});
function renderZrt() {
  const ul = $('zrtList'); ul.innerHTML = '';
  current.zrt.forEach(z => {
    const li = document.createElement('li'); li.innerHTML = `<span class="zn">${esc(z.name)}</span>`;
    const eye = document.createElement('button'); eye.textContent = z.show === false ? '🚫' : '👁'; eye.onclick = () => { z.show = z.show === false; persist(); fillInputs(); redraw(); };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => { if (!(await ask(`Retirer la ZRT « ${z.name} » ?`))) return; current.zrt = current.zrt.filter(x => x.id !== z.id); persist(); fillInputs(); redraw(); };
    li.append(eye, del); ul.append(li);
  });
}

// ---------- Images satellite (cache commun carte / PDF) ----------
const tileUrl = (z, x, y, src) => BASEMAPS[src || basemap].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
async function getTileBlob(url) {
  // Réponse lisible (CORS) obligatoire pour pouvoir dessiner l'image dans le PDF
  if ('caches' in window) {
    try {
      const c = await caches.open(TILE_CACHE); const hit = await c.match(url);
      if (hit && hit.type !== 'opaque') return await hit.blob();
      const r = await fetch(url, { mode: 'cors' });
      if (r.ok) { c.put(url, r.clone()).catch(() => {}); return await r.blob(); }
    } catch (e) { /* on tente sans cache */ }
  }
  const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('tuile'); return r.blob();
}

// ---------- Export GPX ----------
function gpxText() {
  const I = isv(), s = sol, x = t => esc(t).replace(/'/g, '&apos;'), ll = p => `lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"`;
  const wpt = (p, name, sym, ele) => `  <wpt ${ll(p)}>${ele != null ? `<ele>${Math.round(ele)}</ele>` : ''}<name>${x(name)}</name><sym>${sym}</sym></wpt>\n`;
  const trk = (name, pts, color) => `  <trk><name>${x(name)}</name><extensions><gpxx:TrackExtension><gpxx:DisplayColor>${color}</gpxx:DisplayColor></gpxx:TrackExtension></extensions><trkseg>\n` +
    pts.map(p => `    <trkpt ${ll(p)}>${p.h != null ? `<ele>${Math.round(s.elev0 + p.h)}</ele>` : ''}</trkpt>\n`).join('') + `  </trkseg></trk>\n`;
  const tn = (p, i) => i === 0 ? 'OUV' : i === s.trace.length - 1 ? 'PTU' : String(Math.round(p.h));
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="trace-isv ${VERSION}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">\n` +
    `  <metadata><name>${x(current.name + ' - ' + I.name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
  // Points : ZMT, OUV, PTU, début et fin de largage, sorties, points de la zone
  if (I.zmt) o += wpt(I.zmt, 'ZMT', 'Flag, Red');
  o += wpt(s.trace[0], 'OUV', 'Flag, Blue', s.elev0 + s.trace[0].h) + wpt(I.ptu, 'PTU', 'Flag, Green', s.elev0 + I.hPtu);
  o += wpt(s.vec.green, 'DEBUT LARG', 'Navaid, Green', s.altRel) + wpt(s.vec.red, 'FIN LARG', 'Navaid, Red', s.altRel);
  s.vec.exits.forEach(e => { const p = I.team[e.i]; o += wpt(e, `P${e.i + 1}${p.name ? ' ' + p.name : ''}`, 'Navaid, Black', s.altRel); });
  current.points.forEach(pt => { o += wpt(pt, pointLabel(pt) || (pt.kind === 'alt' ? 'ZMT ALT' : 'POINT'), pt.kind === 'alt' ? 'Flag, Red' : 'Pin, Blue', pt.elev); });
  // Trace : itinéraire à suivre, de l'ouverture terminée au PTU (les points intermédiaires portent leur hauteur)
  o += `  <rte><name>${x('TRACE ' + I.name)}</name>\n` + s.trace.map((p, i) => `    <rtept ${ll(p)}><ele>${Math.round(s.elev0 + p.h)}</ele><name>${tn(p, i)}</name><sym>Waypoint</sym></rtept>\n`).join('') + `  </rte>\n`;
  // Trace et vecteur en simples lignes
  o += trk('TRACE ' + I.name, s.trace, 'Magenta') + trk('VECTEUR ' + I.name, [s.vec.green].concat(s.vec.exits, [s.vec.red]).map(p => ({ lat: p.lat, lng: p.lng })), 'Black');
  return o + '</gpx>\n';
}
let pdfFile = null;
function fileReady(file, note) { pdfFile = file; $('pdfName').textContent = file.name + (note || ''); $('pdfReady').classList.remove('hidden'); }
$('btnGpx').addEventListener('click', () => {
  compute(); if (!sol || !sol.ok) return toast(sol && sol.err ? sol.err : 'Pas encore de trace');
  fileReady(new File([gpxText()], `${dateStamp()}_Trace_ISV_${safeName(current.name)}_${safeName(isv().name)}.gpx`, { type: 'application/gpx+xml' }));
});

// ---------- Export PDF ----------
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve();
  if (!jsPdfLoading) jsPdfLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = rej; document.head.append(s);
  });
  return jsPdfLoading;
}
function dateStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
function safeName(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'zone'; }
function pdfUpBearing() { return sol && sol.ok ? sol.cap : 0; } // le haut de la page = le cap para
async function renderPdfCanvas() {
  const pts = figurePoints();
  const CRS = L.CRS.EPSG3857;
  const Z0 = 19; // pixels « monde » au zoom 19
  const th = pdfUpBearing() * Math.PI / 180, cosT = Math.cos(th), sinT = Math.sin(th);
  const P = pts.map(p => CRS.latLngToPoint(L.latLng(p.lat, p.lng), Z0));
  const c0 = { x: P.reduce((a, p) => a + p.x, 0) / P.length, y: P.reduce((a, p) => a + p.y, 0) / P.length };
  // Rotation monde → page : le cap « th » pointe vers le haut de la page
  const rot = q => { const dx = q.x - c0.x, dy = q.y - c0.y; return { x: dx * cosT + dy * sinT, y: -dx * sinT + dy * cosT }; };
  const unrot = r => ({ x: c0.x + r.x * cosT - r.y * sinT, y: c0.y + r.x * sinT + r.y * cosT });
  const R = P.map(rot);
  const minX = Math.min(...R.map(p => p.x)), maxX = Math.max(...R.map(p => p.x));
  const minY = Math.min(...R.map(p => p.y)), maxY = Math.max(...R.map(p => p.y));
  const fw = maxX - minX, fh = maxY - minY;
  // Portrait ou paysage : celui où la figure s'affiche le plus grand
  const fit = (W, H) => {
    const uu = W / 1000, lh = 12 * 1.5 * uu, band = Math.round(7.2 * lh);
    const availW = W * (1 - 2 * 0.1), availH = (H - band) * (1 - 2 * 0.08);
    return { W, H, band, s: Math.min(availW / Math.max(fw, 1), availH / Math.max(fh, 1)) };
  };
  const A = fit(3508, 2480), B = fit(2480, 3508);
  const landscape = A.s >= B.s;
  const { W, H, band, s } = landscape ? A : B;
  const fs = 12, lh = fs * 1.5 * (W / 1000);
  const cxr = (minX + maxX) / 2, cyr = (minY + maxY) / 2, mapCY = (H - band) / 2;
  const toPage = r => ({ x: W / 2 + (r.x - cxr) * s, y: mapCY + (r.y - cyr) * s });
  const toC = ll => toPage(rot(CRS.latLngToPoint(L.latLng(ll.lat, ll.lng), Z0)));
  const pageAngle = deg => deg * Math.PI / 180 - th; // un cap réel → angle sur la page (0 = haut)

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, W, H);

  // Images satellite : zoom assez fin pour la résolution, au plus 19
  let z = Z0;
  while (z > 1 && s * Math.pow(2, Z0 - z) < 1) z--;
  const f = Math.pow(2, Z0 - z);
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([X, Y]) => unrot({ x: (X - W / 2) / s + cxr, y: (Y - mapCY) / s + cyr }));
  const wx0 = Math.min(...corners.map(p => p.x)) / f, wx1 = Math.max(...corners.map(p => p.x)) / f;
  const wy0 = Math.min(...corners.map(p => p.y)) / f, wy1 = Math.max(...corners.map(p => p.y)) / f;
  const jobs = [];
  let fails = 0;
  for (let tx = Math.floor(wx0 / 256); tx <= Math.floor(wx1 / 256); tx++)
    for (let ty = Math.floor(wy0 / 256); ty <= Math.floor(wy1 / 256); ty++) jobs.push({ tx, ty });
  g.save();
  g.translate(W / 2, mapCY); g.scale(s, s); g.translate(-cxr, -cyr); g.rotate(-th); g.translate(-c0.x, -c0.y);
  const run = async () => {
    while (jobs.length) {
      const { tx, ty } = jobs.shift();
      try {
        const img = await createImageBitmap(await getTileBlob(tileUrl(z, tx, ty)));
        const size = 256 * f;
        g.drawImage(img, tx * size, ty * size, size + 0.5 * f, size + 0.5 * f);
      } catch (e) { fails++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, run));
  g.restore();
  if ((typeof Photo !== 'undefined')) { try { await Photo.drawPdf(g, toC); } catch (e) {} }

  // ---- Tracé ----
  const u = W / 1000;
  const pxPerM = ll => { const a = toC(ll), b = toC(Geo.fromLocal(ll, { x: 100, y: 0 })); return Math.hypot(b.x - a.x, b.y - a.y) / 100; };
  const shadowText = (txt, x, y, color, size, align) => {
    g.save(); g.font = `700 ${size * u}px -apple-system, Helvetica, Arial, sans-serif`; g.textBaseline = 'middle';
    const w = g.measureText(txt).width, m = 12 * u;
    if (!align) align = (x + w > W - m) ? 'right' : 'left';
    if (align === 'right' && x - w < m) x = m + w;
    if (align === 'left' && x + w > W - m) x = W - m - w;
    if (align === 'center') x = Math.min(Math.max(x, m + w / 2), W - m - w / 2);
    y = Math.min(Math.max(y, 20 * u), H - band - 14 * u);
    g.textAlign = align;
    g.lineWidth = size * u * 0.28; g.strokeStyle = isDark(color) ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(txt, x, y); g.fillStyle = color; g.fillText(txt, x, y); g.restore();
  };
  const dot = (ll, color, r) => {
    const c = toC(ll); g.save(); g.beginPath(); g.arc(c.x, c.y, r * u, 0, 2 * Math.PI); g.fillStyle = color; g.fill();
    g.lineWidth = 1.2 * u; g.strokeStyle = '#111'; g.stroke(); g.restore(); return c;
  };
  // ---- ZRT, cercle de relaxation, trace, vecteur, points ----
  const I = isv(), line = (pts, color, w, dash) => { if (!pts || pts.length < 2) return; g.save(); g.beginPath(); pts.forEach((ll, i) => { const q = toC(ll); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }); g.strokeStyle = color; g.lineWidth = w * u; g.lineCap = 'round'; g.lineJoin = 'round'; g.setLineDash(dash ? dash.map(d => d * u) : []); g.stroke(); g.restore(); };
  current.zrt.forEach(z => { if (z.show !== false) z.lines.forEach(ln => line(ln.p.map(a => ({ lat: a[0], lng: a[1] })), '#ff2020', 2.2, [10, 6])); });
  if (current.show.relax && sol.circle.R > 0) { const c = toC(sol.circle.c); g.save(); g.strokeStyle = C_RELAX; g.lineWidth = 2.6 * u; g.beginPath(); g.arc(c.x, c.y, sol.circle.R * pxPerM(sol.circle.c), 0, 2 * Math.PI); g.stroke(); g.restore(); }
  line(sol.trace, 'rgba(0,0,0,.6)', 7); line(sol.trace, C_TRACE, 3.6);
  { const cp = toC(I.ptu); sol.trace.forEach((p, i) => { if (i === sol.trace.length - 1) return; const c = dot(p, C_TRACE, i === 0 ? 7 : 4.5); if (i === 0) shadowText(`OUV ${fmtInt(p.h)}`, c.x - 12 * u, c.y - 16 * u, C_TRACE, 11, 'right'); else if (Math.hypot(c.x - cp.x, c.y - cp.y) > 26 * u) shadowText(fmtInt(p.h), c.x + 9 * u, c.y, C_TRACE, 10); }); }
  line([sol.vec.green, sol.vec.red], 'rgba(255,255,255,.9)', 9); line([sol.vec.green, sol.vec.red], '#000', 4.5);
  sol.vec.exits.forEach(e => dot(e, e.i === sol.dropIdx ? '#fff' : '#000', e.i === sol.dropIdx ? 4.2 : 3));
  dot(sol.vec.green, C_START, 8); dot(sol.vec.red, C_END, 8);
  { const m = toC({ lat: (sol.vec.green.lat + sol.vec.red.lat) / 2, lng: (sol.vec.green.lng + sol.vec.red.lng) / 2 }); shadowText(`${hdg(sol.acHeading)} · ${fmtInt(sol.vec.length)} m`, m.x + 12 * u, m.y - 14 * u, '#fff', 11);
    const t = toC(Calc.pointAt(sol.trace, sol.length / 2)); shadowText(`CAP ${hdg(sol.cap)} · ${fmtKm(sol.length)}`, t.x + 12 * u, t.y, '#fff', 11); }
  const cible = (ll, color, name) => { const c = toC(ll), r = 8 * u; g.save(); g.strokeStyle = '#000'; g.lineWidth = 5 * u; g.beginPath(); g.arc(c.x, c.y, r, 0, 2 * Math.PI); g.moveTo(c.x - 1.7 * r, c.y); g.lineTo(c.x + 1.7 * r, c.y); g.moveTo(c.x, c.y - 1.7 * r); g.lineTo(c.x, c.y + 1.7 * r); g.stroke(); g.strokeStyle = color; g.lineWidth = 2.4 * u; g.stroke(); g.restore(); if (name) shadowText(name, c.x + 16 * u, c.y - 12 * u, color, 11); };
  if (I.zmt) cible(I.zmt, C_ZMT, 'ZMT');
  { const c = dot(I.ptu, C_PTU, 8); shadowText(`PTU ${fmtInt(I.hPtu)} m`, c.x - 12 * u, c.y, C_PTU, 11, 'right'); }
  current.points.forEach(pt => { if (pt.kind === "alt") cible(pt, '#ff2020', pointLabel(pt)); else { const c = toC(pt); shadowText('✚', c.x, c.y, pt.color || '#fff', 15, 'center'); if (pt.name) shadowText(pt.name, c.x + 12 * u, c.y, pt.color || '#fff', 10); } });
  (lowPoints() || []).forEach(p => dot(p, C_LOW, 4.5));
  const av = altiVals();
  if (av && av.max) { const c = toC(av.max), r = 9 * u; g.save(); g.beginPath(); g.moveTo(c.x, c.y - r); g.lineTo(c.x + r, c.y + r * .8); g.lineTo(c.x - r, c.y + r * .8); g.closePath(); g.fillStyle = '#ffd400'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.6 * u; g.stroke(); g.restore(); }
  // ---- Flèche du nord (coin haut gauche) ----
  const nx = 85 * u, ny = 95 * u, na = pageAngle(0);
  g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(nx, ny, 40 * u, 0, 2 * Math.PI); g.fill();
  g.translate(nx, ny); g.rotate(na);
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -30 * u); g.lineTo(-12 * u, 12 * u); g.lineTo(0, 4 * u); g.lineTo(12 * u, 12 * u); g.closePath(); g.fill();
  g.restore();
  shadowText('N', nx + Math.sin(na) * 52 * u, ny - Math.cos(na) * 52 * u, '#fff', 13, 'center');

  // ---- Échelle graphique ----
  const by = H - band;
  const tx = (s2, x, y, c, size, bold, align) => { g.save(); g.font = `${bold ? 700 : 500} ${(size || fs) * u}px -apple-system, Helvetica, Arial, sans-serif`; g.fillStyle = c || '#eee'; g.textBaseline = 'middle'; g.textAlign = align || 'left'; g.fillText(s2, x, y); g.restore(); };
  const mppC = 1 / pxPerM(sol.ouv);
  const target = W * 0.18 * mppC, nice = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000].reduce((a, b) => (b <= target ? b : a), 50);
  const barW = nice / mppC, sx = 30 * u, sy = by - 28 * u;
  g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(sx - 10 * u, sy - 16 * u, barW + 100 * u, 32 * u);
  g.fillStyle = '#fff'; g.fillRect(sx, sy - 4 * u, barW, 8 * u); g.fillStyle = '#111'; g.fillRect(sx + barW / 2, sy - 3 * u, barW / 2 - 1 * u, 6 * u); g.restore();
  tx(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, sx + barW + 10 * u, sy, '#fff', 12, true);

  // ---- Bandeau d'informations ----
  g.save(); g.fillStyle = 'rgba(12,12,12,.85)'; g.fillRect(0, by, W, band); g.restore();
  const col1 = 30 * u, col2 = W * 0.36, col3 = W * 0.69, l0 = by + lh * 1.1;
  tx(`${current.name} — ${I.name}`, col1, l0, '#fff', fs * 1.3, true);
  tx(`Saut du ${fmtWhen(current.when).replace(' ', ' à ')} · ${wxRec && F ? wxRec.model.split(' (')[0] : 'SANS PRÉVISION DE VENT'}${zeroWind ? ' · ESSAI VENT 0' : ''}`, col1, l0 + lh * 1.2, '#bbb');
  tx(`Largage FL${sol.fl} · ${hdg(sol.acHeading)} · ${fmtInt(sol.vec.length)} m`, col1, l0 + lh * 2.4, '#fff', fs, true);
  tx(`Temps de largage ${sgn(sol.relax.before, false)} / ${sgn(sol.relax.after, true)} · ${I.team.length} para${I.team.length > 1 ? 's' : ''}`, col1, l0 + lh * 3.4, '#fff', fs);
  tx(`CAP PARA ${hdg(sol.cap)} · trace ${fmtKm(sol.length)}`, col1, l0 + lh * 4.4, C_TRACE, fs, true);
  tx(`Sous voile ${fmtMin(sol.own.tCanopy)} · dérive sous RSE ${fmtInt(sol.rseLen)} m`, col1, l0 + lh * 5.4, '#eee', fs);
  // Mis en évidence
  const big = fs * 1.55, hi = [
    `OSO : ${av && av.max ? av.oso : '....'}`, `ALPHA : ${av ? av.alpha : '....'}`,
    Math.abs(sol.tFall - 4) < 0.05 ? 'Chute : 4 s' : `Ouverture : ${fmtInt(Math.round(sol.hOpen))} m`
  ], hi2 = [sol.turn ? `Prise de cap à ${sol.turn}` : 'Prise de cap : dans l\'axe', sol.hand ? `PTU main ${sol.hand}` : (I.zmt ? 'PTU dans l\'axe' : 'ZMT non placée')];
  hi.forEach((t, i) => tx(t, col2, l0 + lh * (0.3 + i * 1.9), '#ffd400', big, true));
  hi2.forEach((t, i) => tx(t, col3, l0 + lh * (0.3 + i * 1.9), '#00e5ff', big, true));
  tx(`Hauteur de largage : ${av && av.max ? fmtInt(av.hRel) + ' m' : '....'}`, col3, l0 + lh * 4.1, '#ffd400', fs * 1.15, true);
  tx(`${BASEMAPS[basemap].attr} · vents ${wxRec ? wxRec.model.split(' (')[0] : '—'} via Open-Meteo · trace-isv v${VERSION}`, W - 20 * u, H - 10 * u, '#888', 8, false, 'right');
  return { canvas: cv, landscape, fails };
}
// Page 2 : toutes les données de vol, l'altimétrie et l'équipe. Page 3 : vents à la verticale du PTU.
function pdfDataPages(doc) {
  const I = isv(), clean = t => String(t).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[  ]/g, ' ').replace(/−/g, '-').replace(/⚠️ ?/g, '');
  doc.addPage('a4', 'portrait'); let y = 18;
  const title = t => { doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(clean(t), 15, y); y += 7; doc.setFont('helvetica', 'normal'); doc.setFontSize(10); };
  const row = (k, v, bold) => { if (y > 285) { doc.addPage('a4', 'portrait'); y = 18; } doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(clean(k), 15, y); doc.text(clean(v), 110, y); y += 5.6; };
  title(`${current.name} - ${I.name} - saut du ${fmtWhen(current.when).replace(' ', ' à ')}`);
  row('Largage', `FL${sol.fl} = ${fmtInt(sol.hRel)} m au-dessus du sol sous le PTU`, true);
  row('Vitesse de largage', `${fmt1(+I.acMs)} m/s badin (${Math.round(I.acMs * KT)} kt) = ${Math.round(sol.tas * KT)} kt vraie`);
  row(sol.openLowered ? 'Consigne : ouverture à' : 'Temps de chute', sol.openLowered ? `${fmtInt(Math.round(sol.hOpen))} m au-dessus du sol sous le PTU (${fmt1(sol.tFall)} s de chute, ${fmtInt(sol.openDrop)} m d'ouverture compris)` : `${fmt1(sol.tFall)} s, puis ${fmtInt(sol.openDrop)} m de perte de hauteur à l'ouverture (${fmt1(sol.tOpen)} s)`, sol.openLowered);
  volRows().forEach(([k, v, hi]) => row(k, v, hi));
  row('Point d\'entrée PTU', fmtPos(I.ptu)); row('Hauteur d\'arrivée au PTU', `${fmtInt(I.hPtu)} m au-dessus du sol (${fmtInt(sol.elev0)} m)`);
  row('Ouverture terminée (OUV)', fmtPos(sol.ouv));
  row('Début de largage (vert)', fmtPos(sol.vec.green)); row('Fin de largage (rouge)', fmtPos(sol.vec.red));
  if (I.zmt) row('Zone de posé (ZMT)', fmtPos(I.zmt));
  y += 3; title('Altimétrie');
  const av = altiVals();
  row('OSO', av && av.max ? `${av.oso} hPa (point haut ${fmtInt(av.max.elev)} m)` : 'non calculé', true);
  row('ALPHA', av ? `${av.alpha} hPa (sol sous le PTU ${fmtInt(av.elevPtu)} m)` : '-', true);
  row('Hauteur de largage', av && av.max ? `${fmtInt(av.hRel)} m au-dessus du point haut` : 'non calculé', true);
  row('Zone de sécurité', `${fmtInt(I.secLong)} m avant et après le vecteur, ${fmtInt(I.secLat)} m de chaque côté,`);
  row('', `prolongée le long de la dérive sous RSE jusqu'à 1013 hPa${I.alti && I.alti.drift != null && I.alti.key === altiKey() ? ` (${fmtInt(I.alti.drift)} m)` : ''}`);
  y += 3; title(`Équipe (${I.team.length}) - vert + ${fmt1(+I.tGreen)} s, rouge ${fmt1(+I.tRed)} s après le dernier`);
  I.team.forEach((p, i) => { const c = prm.canopies.find(q => q.id === p.canopy) || prm.canopies[0]; row(`${i + 1}. ${p.name || 'Para ' + (i + 1)}${i === sol.dropIdx ? '  (sur le point de largage)' : ''}`, `${c.name} (Vx ${fmt1(+c.vx)}, Vz ${fmt1(+c.vz)} à 1 000 m pour ${MTE_DEF} kg) - MTE ${fmtInt(+p.mte > 0 ? +p.mte : MTE_DEF)} kg - sortie à ${fmt1(sol.ex.te[i])} s`); });
  y += 3; title('Points de la trace (hauteur au-dessus du sol sous le PTU)');
  sol.trace.forEach((p, i) => row(i === 0 ? `OUV  ${fmtInt(p.h)} m` : i === sol.trace.length - 1 ? `PTU  ${fmtInt(p.h)} m` : `${fmtInt(p.h)} m`, fmtPos(p)));
  if (!F) return;
  doc.addPage('a4', 'portrait');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(clean(`Vents à la verticale du PTU - ${fmtWhen(current.when).replace(' ', ' à ')}`), 15, 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(clean(`${wxRec.model} via Open-Meteo, téléchargée le ${new Date(wxRec.fetched).toLocaleString('fr-FR')} - hauteurs au-dessus du sol (${Math.round(sol.elev0)} m)`), 15, 25);
  const cols = [['Niveau', 15], ['Hauteur sol', 42], ['Axe (M)', 78], ['Force', 102], ['', 124], ['Temp.', 152], ['Hum.', 177]];
  y = 35; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); cols.forEach(([t, x]) => doc.text(t, x, y)); doc.setFont('helvetica', 'normal');
  windRows(F, I.ptu, sol.elev0).forEach((r, i) => {
    y += 6.2; if (y > 285) { doc.addPage('a4', 'portrait'); y = 20; }
    if (i % 2 === 0) { doc.setFillColor(238, 238, 238); doc.rect(13, y - 4.4, 184, 6.2, 'F'); }
    [r.lab, clean(fmtInt(r.h)) + ' m', hdgN(r.dir), Math.round(r.spd * KT) + ' kt', fmt1(r.spd) + ' m/s', r.T == null ? '-' : Math.round(r.T) + ' °C', r.RH == null ? '-' : Math.round(r.RH) + ' %'].forEach((t, k) => doc.text(t, cols[k][1], y));
  });
}
$('btnPdf').addEventListener('click', async () => {
  compute(); if (!sol || !sol.ok) return toast(sol && sol.err ? sol.err : 'Pas encore de trace');
  const b = $('btnPdf'); b.disabled = true; const old = b.textContent; b.textContent = 'Préparation du PDF…';
  try {
    await computeAlti(false).catch(() => {});
    await loadJsPdf();
    const { canvas, landscape, fails } = await renderPdfCanvas();
    const doc = new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, landscape ? 297 : 210, landscape ? 210 : 297);
    pdfDataPages(doc);
    fileReady(new File([doc.output('blob')], `${dateStamp()}_Trace_ISV_${safeName(current.name)}_${safeName(isv().name)}.pdf`, { type: 'application/pdf' }), fails ? ` (${fails} morceaux de photo manquants)` : '');
  } catch (e) { console.error(e); toast('Échec du PDF : ' + (e && e.message ? e.message : 'erreur')); }
  finally { b.disabled = false; b.textContent = old; }
});
$('pdfClose').addEventListener('click', () => $('pdfReady').classList.add('hidden'));
$('pdfShare').addEventListener('click', async () => {
  if (!pdfFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) { await navigator.share({ files: [pdfFile] }); /* sans title : iOS en ferait un .txt en plus */ }
    else { const url = URL.createObjectURL(pdfFile); const a = document.createElement('a'); a.href = url; a.download = pdfFile.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('pdfReady').classList.add('hidden');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Partage impossible'); }
});

// ---------- Sauvegarde : zones et paramètres dans deux fichiers séparés ----------
async function shareJson(obj, name) {
  const file = new File([JSON.stringify(obj, null, 1)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); /* sans title : iOS en ferait un .txt en plus */
    else { const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Export impossible'); }
}
async function exportKind(kind) {
  persist();
  const n = await ask('Ton prénom (il sera dans le nom du fichier, pour savoir de qui il vient) :', store.get('isv.author', ''));
  if (n === null) return;
  const who = String(n).trim(); store.set('isv.author', who);
  const obj = { app: 'trace-isv', kind, v: 1, exported: new Date().toISOString(), author: who };
  if (kind === 'zones') obj.zones = zones; else obj.profile = prm;
  await shareJson(obj, `${dateStamp()}_Trace_ISV_${kind === 'zones' ? 'Zones' : 'Parametres'}${who ? '_' + safeName(who) : ''}.json`);
}
async function readJsonFile(input) {
  const f = input.files && input.files[0]; if (!f) return null;
  try { return JSON.parse(await f.text()); } catch (er) { toast('Fichier illisible'); return null; }
}
const fromWho = d => d && d.author ? ` de ${d.author}` : '';
$('btnExportZones').addEventListener('click', () => exportKind('zones'));
$('btnExportProf').addEventListener('click', () => exportKind('profile'));
$('btnImportZones').addEventListener('click', () => { $('importZonesFile').value = ''; $('importZonesFile').click(); });
$('btnImportProf').addEventListener('click', () => { $('importProfFile').value = ''; $('importProfFile').click(); });
// Importer des zones : toujours une fusion, jamais d'écrasement
$('importZonesFile').addEventListener('change', async e => {
  const d = await readJsonFile(e.target); if (!d) return;
  if (d.app && d.app !== 'trace-isv') return toast('Ce fichier vient d\'une autre appli');
  if (!Array.isArray(d.zones)) { toast(d.profile ? 'Ce fichier contient des paramètres : importe-le depuis l\'onglet Paramètres' : 'Fichier illisible'); return; }
  let added = 0, kept = 0;
  d.zones.map(upgrade).forEach(z => {
    if (!z.id) z.id = 'z' + Date.now() + Math.random().toString(36).slice(2, 6);
    if (zones.some(x => x.id === z.id)) { kept++; return; }
    z.isvs.forEach(i => i.team.forEach(p => { if (!prm.canopies.some(c => c.id === p.canopy)) p.canopy = prm.canopies[0].id; }));
    zones.push(z); added++;
  });
  store.set('isv.zones', zones); fillInputs(); redraw();
  toast(`Zones${fromWho(d)} : ${added} ajoutée(s)${kept ? `, ${kept} déjà présente(s) gardée(s) telles quelles` : ''}`);
});
$('importProfFile').addEventListener('change', async e => {
  const d = await readJsonFile(e.target); if (!d) return;
  if (!d.profile || typeof d.profile !== 'object' || !Array.isArray(d.profile.canopies)) { toast(Array.isArray(d.zones) ? 'Ce fichier contient des zones : importe-le depuis l\'onglet Zones' : 'Fichier illisible'); return; }
  Object.keys(DEFAULT_PARAMS).forEach(k => { if (d.profile[k] !== undefined) prm[k] = d.profile[k]; }); saveProfile(); changed();
  toast(`Paramètres${fromWho(d)} importés`);
});
$('btnWipe').addEventListener('click', async () => {
  if (!(await ask('Effacer TOUTES les zones enregistrées (et la zone en cours) ? C\'est définitif. Tes paramètres sont gardés. Pense à exporter les zones avant si besoin.'))) return;
  Object.keys(localStorage).filter(k => k.startsWith('isv.') && !/^isv\.(profile|author|basemap)/.test(k)).forEach(k => { try { localStorage.removeItem(k); } catch (er) {} });
  if ((typeof Photo !== 'undefined')) await Photo.clearAll();
  location.reload();
});
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Démarrage ----------
syncCompass();
fillInputs();
draw();
if (!current.id && current.zoom < 8) locate(true); else locate(false);
if (sol && sol.ok) setTimeout(fitFigure, 60);
ensureWx(false); refreshPtuElev();
window.addEventListener('online', () => { ensureWx(false); refreshPtuElev(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureWx(false); });
// Mise à jour automatique : vérifie une nouvelle version à chaque retour sur l'appli et recharge dès qu'elle est installée
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  // Nouvelle version installée : recharger, mais jamais pendant qu'une question est affichée (sinon la réponse est perdue et la question revient)
  const reloadWhenFree = () => { const d = document.getElementById('dialog'); if (d && !d.classList.contains('hidden')) { setTimeout(reloadWhenFree, 400); return; } location.reload(); };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; reloadWhenFree(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
