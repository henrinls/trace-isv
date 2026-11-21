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
const VERSION = '0.38.0';
const APP_ID = 'isv';
// Fonds de carte : Esri (monde entier) ou photos aériennes IGN (France, licence ouverte : hors-ligne et PDF autorisés)
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagerie © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
  ign: { url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', attr: 'Photos aériennes © IGN – Géoplateforme', maxNative: 19 }
};
const TILE_CACHE = 'isv-tiles-v1', dlProgress = {}; /* dlProgress : zone → « 120/3 400 » pendant le téléchargement hors-ligne (déclaré tôt : renderZones s'en sert au démarrage) */
const KT = 1.943844; // m/s → nœuds
const C_LOW = '#ffe600', C_START = '#1ec83c', C_END = '#ff2020', C_TRACE = '#ff3fb4', C_RELAX = '#00e5ff', C_PTU = '#ffd400', C_ZMT = '#ff8c00';
const isDark = c => c === '#000000';
/* Vx, Vz et vitesse de chute : vraies à 1 000 m en atmosphère standard, pour une MTE de 150 kg. La MTE est celle du PARA
   (lui + parachute + charge), saisie dans l'équipe, 150 kg par défaut : ce n'est pas une caractéristique de la voile (v0.4.1). */
const MTE_DEF = 150;
const DEFAULT_PARAMS = { canopies: [{ id: 'ph', name: 'Phantom', vx: 9, vz: 2, hM: 1000, mteM: 150, hOpenM: 1000, mteOpenM: 150, lossM: 100 }], margin: 20, openLoss: 100, vff: 50, sumMargin: 300, courtKm: 5, osoKm: 2, osoFt: 1900, offKm: 200, tRef: 4 }; /* tRef (v0.37.0, Henri) : temps de chute de référence « 4 s », valeur arbitraire → réglable */ /* v0.32.0 : rayon du hors-ligne d'une zone (km) */ /* v0.30.0 : hauteur de déclenchement de l'ouvreur de sécurité (ft au-dessus du point haut), réglable */ /* v0.28.0 : point court à moins de 5 km de la ZMT */ /* v0.24.0 : marge au-dessus d'un sommet S (m) */
const n360 = h => ((h % 360) + 360) % 360;
const pad2 = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function nowWhen() { const d = new Date(); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
function shiftWhen(w, hours) { const d = new Date(w + ':00'); d.setHours(d.getHours() + hours); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
const isvAutoBase = I => `${I.when.slice(0, 10).replace(/-/g, '')}-${I.when.slice(11, 16)}`; /* « 20261122-20:00 » (v0.17.0 : date collée, Henri) */
const isvAutoName = I => isvAutoBase(I) + (I.autoSuf ? '-' + I.autoSuf : ''); /* v0.26.0 : ISV dupliquées « 20261122-20:00-1 », « -2 »… */
function fmtWhenY(w) { const d = new Date(w + ':00'); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} à ${pad2(d.getHours())}h`; }
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
function wxWanted() { const I = isv(); return { center: I.ptu || current.zmt || { lat: current.center.lat, lng: current.center.lng }, halfKm: Math.max(GRID_KM, current.gridKm || 0) }; }
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
let zeroWind = false; try { localStorage.removeItem('isv.zeroWind'); } catch (e) {} /* v0.18.0 : essai « Vent 0 » retiré */
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
  return { id: uid('i'), name: name || 'ISV 1', ptu: null, hPtu: 300, ptuElev: null, team: [newPara(), newPara(), newPara(), newPara()],
    tGreen: 4, tRed: 10, fl: 295, acMs: 65, tFall: (typeof prm !== 'undefined' && +prm.tRef > 0) ? +prm.tRef : 4, capManual: null, vecHeading: null, reversed: false, dropId: null, manual: null, relaxRef: 'green',
    secLong: 1000, secLat: 500, alti: null, points: [], when: null };
}
function upIsv(I) {
  const d = newIsv(I && I.name); if (!I) return d;
  Object.keys(d).forEach(k => { if (I[k] === undefined) I[k] = d[k]; });
  if (Array.isArray(I.points)) I.points = I.points.filter(q => q.auto !== 'P'); /* v0.21.0 : le point P de v0.20.0 est remplacé par le nom du point de la trace */
  if (!Array.isArray(I.team) || !I.team.length) I.team = [newPara()];
  if (!Array.isArray(I.points)) I.points = [];
  I.points.forEach(q => { if (q.kind !== 'alt') q.color = '#ffffff'; }); /* v0.19.1 : points libres tous blancs */
  /* v0.14.0 : nom par défaut = date et heure du saut (« 2026-11-22-20:00 ») tant que l'utilisateur ne l'a pas forcé */
  if (I.nameAuto === undefined) I.nameAuto = /^ISV \d+( \(copie\))?$/.test(String(I.name || ''));
  I.team.forEach(p => { if (!p.id) p.id = uid('p'); if (p.dt === undefined) p.dt = 3; if (p.name === undefined) p.name = ''; if (!(+p.mte > 0)) p.mte = MTE_DEF; if (prm && Array.isArray(prm.canopies) && prm.canopies.length && !prm.canopies.some(c => c.id === p.canopy)) p.canopy = prm.canopies[0].id; });
  return I;
}
function upgrade(z) {
  if (!z) return z;
  z.isvs = Array.isArray(z.isvs) && z.isvs.length ? z.isvs : [newIsv()];
  /* v0.8.0 : les points (zones de posé alternatives, repères) appartiennent à l'ISV, plus à la zone.
     Anciens points de zone recopiés une fois dans chaque ISV existante, pour ne rien perdre. */
  if (Array.isArray(z.points)) { const old = z.points; z.isvs.forEach(i => { if (!Array.isArray(i.points)) i.points = clone(old); }); delete z.points; }
  /* v0.8.0 : la ZMT appartient à la zone (commune à ses ISV) ; reprise de celle de l'ISV ouverte, sinon de la première qui en a une */
  if (z.zmt === undefined) { const c = z.isvs.find(i => i.id === z.cur && i.zmt) || z.isvs.find(i => i.zmt); z.zmt = c ? c.zmt : null; }
  z.isvs.forEach(i => { delete i.zmt; });
  z.isvs = z.isvs.map(upIsv);
  if (!z.isvs.some(i => i.id === z.cur)) z.cur = z.isvs[0].id;
  z.zrt = Array.isArray(z.zrt) ? z.zrt : [];
  z.show = Object.assign({ relax: true, label: true }, typeof z.show === 'object' && z.show ? z.show : {});
  if (typeof z.when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:00$/.test(z.when)) z.when = nowWhen(); // date et heure du saut
  /* v0.14.0 : chaque ISV a sa date et son heure (current.when = copie de celle de l'ISV ouverte) */
  z.isvs.forEach(i => { if (typeof i.when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:00$/.test(i.when)) i.when = z.when; if (i.nameAuto) i.name = isvAutoName(i); });
  { const c = z.isvs.find(i => i.id === z.cur) || z.isvs[0]; z.when = c.when; }
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
prm.canopies.forEach(c => { if (!isFinite(+c.hM)) c.hM = 1000; if (!(+c.mteM > 0)) c.mteM = 150; if (!isFinite(+c.hOpenM)) c.hOpenM = 1000; if (!(+c.lossM >= 0) || c.lossM === null) c.lossM = +prm.openLoss >= 0 ? +prm.openLoss : 100; if (!(+c.mteOpenM > 0)) c.mteOpenM = 150; }); /* v0.33.0 : ouverture mesurée par voile (reprend l'ancienne valeur générale) */
function openLossNow() { const I = isv(), v = I.team.map(p => { const c = prm.canopies.find(q => q.id === p.canopy) || prm.canopies[0], r = Calc.canOpenRef(c); return r == null ? null : r * Math.sqrt((+p.mte > 0 ? +p.mte : MTE_DEF) / Calc.MTE_REF); }).filter(x => x != null); return v.length ? Math.max(...v) : +prm.openLoss || 0; } /* la plus forte perte de l'équipe (choix validé par Henri : sécurité), MTE de chaque para comprise */ /* v0.31.0 : anciennes voiles = mesure de référence (1 000 m, 150 kg) */
{ const f0 = window.fetch.bind(window), TILE = /^(server\.arcgisonline\.com|data\.geopf\.fr|s3\.amazonaws\.com)$/;
  window.fetch = (u, o) => { /* v0.31.0 : mode autonome — rien vers Internet ; les tuiles passent au service worker qui ne sert que son cache */
    try { const url = new URL(typeof u === 'string' ? u : u.url, location.href); if (prm.offline && url.origin !== location.origin && !TILE.test(url.hostname)) return Promise.reject(new Error('Mode autonome : pas d\'Internet')); } catch (e) {}
    return f0(u, o); }; }
saveProfile();
function newZone(center) { return upgrade({ id: null, name: 'Nouvelle zone', center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 12 : 6 }); }
let zones = store.get('isv.zones', []).map(upgrade);
let current = upgrade(store.get('isv.current', null)) || newZone(null);
function isv() { return current.isvs.find(i => i.id === current.cur) || current.isvs[0]; }
let stepRaf = 0;
function persist() {
  if (window._stepsReady && !stepRaf) stepRaf = requestAnimationFrame(() => { stepRaf = 0; syncSteps(); }); /* v0.28.0 : étapes à jour après chaque changement */
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
  const I = isv(), c = I.ptu || current.zmt || current.center; if (!c) return 0;
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
/* v0.5.7 : altitudes du point haut tirées de tuiles d'altitude (Terrarium, AWS Open Data : SRTM / Copernicus, environ 30 m)
   au lieu de l'API Open-Meteo. Cause du blocage : Open-Meteo compte chaque point comme un appel (limite 600 par minute,
   10 000 par jour) ; avec 1 600 points par calcul, les demandes étaient refusées et le point haut restait sur « … ».
   Une zone de sécurité tient en 1 à 4 tuiles : rapide, et les tuiles sont gardées sur le téléphone (service worker). */
const DEM_Z = 12, DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, demTiles = new Map();
async function demTile(x, y) {
  const k = x + '/' + y; if (demTiles.has(k)) return demTiles.get(k);
  const pr = (async () => {
    const r = await fetch(DEM_URL(DEM_Z, x, y), { mode: 'cors' }); if (!r.ok) throw new Error('tuile ' + r.status);
    const bmp = await createImageBitmap(await r.blob()), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    return { w: c.width, d: g.getImageData(0, 0, c.width, c.height).data };
  })();
  demTiles.set(k, pr); pr.catch(() => demTiles.delete(k)); return pr;
}
async function elevTiles(pts) {
  const n = 2 ** DEM_Z, pos = pts.map(p => { const la = p.lat * Math.PI / 180; return { fx: (p.lng + 180) / 360 * n, fy: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n }; });
  const keys = [...new Set(pos.map(q => Math.floor(q.fx) + '/' + Math.floor(q.fy)))];
  await Promise.all(keys.map(k => { const [x, y] = k.split('/').map(Number); return demTile(x, y); }));
  return Promise.all(pos.map(async q => {
    const x = Math.floor(q.fx), y = Math.floor(q.fy), t = await demTile(x, y), px = Math.min(t.w - 1, Math.floor((q.fx - x) * t.w)), py = Math.min(t.w - 1, Math.floor((q.fy - y) * t.w)), i = (py * t.w + px) * 4;
    return (t.d[i] * 256 + t.d[i + 1] + t.d[i + 2] / 256) - 32768;
  }));
}
async function fetchElev(pts) {
  /* v0.5.4 : paquets de 100 points demandés 4 par 4 en parallèle (avant : l'un après l'autre, 16 allers-retours pour
     1 600 points). Tout est asynchrone : l'appli reste utilisable pendant le calcul. */
  const parts = []; for (let i = 0; i < pts.length; i += 100) parts.push(pts.slice(i, i + 100));
  const res = new Array(parts.length);
  const one = async k => {
    const part = parts[k];
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${part.map(p => p.lat.toFixed(5)).join(',')}&longitude=${part.map(p => p.lng.toFixed(5)).join(',')}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const js = await r.json(); if (!js || !Array.isArray(js.elevation)) throw new Error('altitudes');
    res[k] = js.elevation.map(e => typeof e === 'number' ? e : null);
  };
  let next = 0; const worker = async () => { while (next < parts.length) await one(next++); };
  await Promise.all([0, 1, 2, 3].map(worker));
  return res.flat();
}
async function refreshPtuElev() {
  const I = isv(); if (!I.ptu) return; const k = I.ptu.lat.toFixed(5) + ',' + I.ptu.lng.toFixed(5);
  if (I.ptuElevKey === k && typeof I.ptuElev === 'number') return;
  try { const [e] = await fetchElev([I.ptu]); if (isv() !== I || !I.ptu || typeof e !== 'number') return; I.ptuElev = Math.round(e); I.ptuElevKey = k; persist(); fillInputs(); redraw(); }
  catch (e) { /* pas de réseau : on garde l'altitude du modèle météo */ }
}
/* v0.8.0 : altitude du terrain à la ZMT (tableau des vents à la verticale de la ZMT), gardée dans la zone */
let zmtElevBusy = null;
async function refreshZmtElev() {
  const z = current, c = z.zmt; if (!c) return; const k = c.lat.toFixed(5) + ',' + c.lng.toFixed(5);
  if ((z.zmtElevKey === k && typeof z.zmtElev === 'number') || zmtElevBusy === k) return;
  zmtElevBusy = k;
  try { const [e] = await fetchElev([c]); if (current !== z || !z.zmt || z.zmt.lat.toFixed(5) + ',' + z.zmt.lng.toFixed(5) !== k || typeof e !== 'number') return; z.zmtElev = Math.round(e); z.zmtElevKey = k; persist(); fillInputs(); redraw(); if (!$('windsBox').classList.contains('hidden')) renderWinds(); }
  catch (e) { /* pas de réseau : altitude du modèle météo en attendant */ }
  finally { if (zmtElevBusy === k) zmtElevBusy = null; }
}
function zmtElev() { const z = current; return z.zmt && typeof z.zmtElev === 'number' && z.zmtElevKey === z.zmt.lat.toFixed(5) + ',' + z.zmt.lng.toFixed(5) ? z.zmtElev : null; }
/* v0.10.0 (Henri) : toutes les hauteurs sont comptées au-dessus du sol de la ZMT (avant : sol sous le PTU).
   v0.13.1 : le sol sous le PTU ne sert plus jamais de référence quand il y a une ZMT (en attendant son altitude : modèle météo).
   Sans ZMT seulement : sol sous le PTU, sinon modèle météo. */
function elev0() {
  const ze = zmtElev(); if (ze != null) return ze;
  if (current.zmt) refreshZmtElev();
  const I = isv(); if (!current.zmt && typeof I.ptuElev === 'number') return I.ptuElev;
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
  const phOn = !!($('bmPhoto') && $('bmPhoto').classList.contains('on')); $('bmEsri').classList.toggle('on', !phOn && basemap === 'esri'); $('bmIgn').classList.toggle('on', !phOn && basemap === 'ign');
  if (msg) toast(basemap === 'ign' ? 'Fond : photos aériennes IGN (France)' : 'Fond : satellite Esri (monde)');
}
setBasemap(basemap);
$('bmEsri').addEventListener('click', () => { if (typeof Photo !== 'undefined') Photo.hide(); setBasemap('esri', true); }); /* photo calée = 3e choix du fond (21 nov. 2026) */
$('bmIgn').addEventListener('click', () => { if (typeof Photo !== 'undefined') Photo.hide(); setBasemap('ign', true); }); /* photo calée = 3e choix du fond (21 nov. 2026) */
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
map.on('rotate', () => { syncCompass(); if (typeof drawBarb === 'function' && current.zmt) drawBarb(); current.bearing = map.getBearing(); clearTimeout(rotT); rotT = setTimeout(persist, 400); });

const fig = L.layerGroup().addTo(map);     // tracé recalculé à chaque dessin
const handles = L.layerGroup().addTo(map); // points déplaçables, gardés d'un dessin à l'autre
let placing = null, posMarker = null, ptOpen = false, ptPal = false, suspended = null; /* suspended (v0.36.0) : pose de point mise de côté pendant la mesure 📏 / la coupe */ /* ptOpen / ptPal : choix du type de point ouvert, palette ouverte (v0.17.0) */      // placing : null | 'Z' (ZMT) | 'P' (PTU) | { kind, color } (point)
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
    const p = pt(e); start = { x: p.clientX, y: p.clientY }; marker._lpMoved = false;
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
    /* 21 nov. 2026 : rien ne bouge tant que le doigt n'a pas glissé (sinon, relâché sur place = menu « Déplacer », lpmove.js) */
    if (!marker._lpMoved) { if (Math.hypot(p.clientX - start.x, p.clientY - start.y) <= MOVE_TOL) return; marker._lpMoved = true; }
    const r = map.getContainer().getBoundingClientRect();
    const ll = map.containerPointToLatLng([p.clientX - r.left, p.clientY - r.top]);
    marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
  };
  const up = () => {
    clearTimeout(timer); timer = null; off();
    if (marker._lpDragging) {
      marker._lpDragging = false; el.classList.remove('lifting'); map.dragging.enable();
      suppressClickUntil = Date.now() + 400;
      if (marker._lpMoved || typeof LPMove === 'undefined') onEnd();
      else { /* relâché sans glisser : menu « Déplacer » (puis toucher la carte), ou les choix propres à l'objet (marker._lpMenu) */
        const r = map.getContainer().getBoundingClientRect(), q = map.containerPointToLatLng([start.x - r.left, start.y - r.top]), P = { lat: q.lat, lng: q.lng };
        LPMove.open(start.x, start.y, marker._lpMenu ? marker._lpMenu(P) : LPMove.defaultItems(marker, P, onMove, onEnd, onStart)); }
    }
  };
  el.addEventListener('touchstart', down, { passive: true }); el.addEventListener('mousedown', down);
}

// ---------- Calcul ----------
function calcInput(I) {
  const di = I.team.findIndex(p => p.id === I.dropId), ri = I.team.findIndex(p => p.id === I.relaxRef);
  return { ptu: I.ptu, zmt: current.zmt, hPtu: +I.hPtu, team: I.team.map(p => ({ name: p.name, canopy: p.canopy, mte: +p.mte > 0 ? +p.mte : null, dt: +p.dt })), tGreen: +I.tGreen, tRed: +I.tRed, fl: +I.fl, acMs: +I.acMs, tFall: +I.tFall, tRef: +prm.tRef > 0 ? +prm.tRef : 4,
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
/* v0.26.0 (Henri) : barbule du vent au sol de la ZMT (pictogramme des cartes aéronautiques / Windy), en cyan, côté au vent de la ZMT :
   trait dans le sens du vent avec une pointe vers la ZMT, empennage côté au vent : demi-barre = 5 kt, barre = 10 kt, triangle = 50 kt.
   Toujours affichée (carte et PDF), décalée de côté si elle chevauche la trace, le PTU ou le vecteur. */
function groundWind() { if (!current.zmt || !F) return null; try { const w = Calc.spdDir(Calc.windAt(F, current.zmt.lat, current.zmt.lng, elev0() + 10)); return isFinite(w.spd) ? w : null; } catch (e) { return null; } }
/* v0.35.3 (Henri) : barbule juste SOUS l'étiquette « ZMT » ; hampe courte et fine, barres et triangles plus larges pour bien les voir.
   Géométrie en pixels × s (1 sur la carte, u dans le PDF), centrée sur C ; d = sens où va le vent (écran). */
function barbGeom(kt, C, d, s) {
  const n = { x: -d.y, y: d.x }, L0 = 16 * s, T = { x: C.x - d.x * L0 / 2, y: C.y - d.y * L0 / 2 }, H = { x: C.x + d.x * L0 / 2, y: C.y + d.y * L0 / 2 };
  const P = (a, m) => ({ x: T.x + d.x * a + n.x * m, y: T.y + d.y * a + n.y * m });
  const lines = [[T, H]], tris = []; /* v0.35.3 (Henri) : plus de pointe de flèche, « inutile » */
  let k5 = Math.round(kt / 5), a = 0; const F50 = Math.floor(k5 / 10); k5 -= F50 * 10; const B10 = Math.floor(k5 / 2), B5 = k5 % 2;
  if (!F50 && !B10 && !B5) return { lines: [], tris, calm: true, T: C };
  for (let i = 0; i < F50; i++) { tris.push([P(a, 0), P(a + 4 * s, 0), P(a, 9 * s)]); a += 5 * s; }
  for (let i = 0; i < B10; i++) { const b = P(a, 9 * s); lines.push([P(a, 0), { x: b.x - d.x * 2.5 * s, y: b.y - d.y * 2.5 * s }]); a += 3.5 * s; }
  if (B5) { if (!F50 && !B10) a += 3.5 * s; const b = P(a, 5 * s); lines.push([P(a, 0), { x: b.x - d.x * 1.4 * s, y: b.y - d.y * 1.4 * s }]); }
  return { lines, tris, T };
}
function barbBox(g) { const pts = g.lines.flat().concat(g.tris.flat()); if (g.calm) pts.push({ x: g.T.x - 3, y: g.T.y - 3 }, { x: g.T.x + 3, y: g.T.y + 3 }); return { x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) }; }
function barbWind(toPx) { /* sens écran du vent au sol et sa force (kt) */
  const w = groundWind(); if (!w || !current.zmt) return null;
  const z = toPx(current.zmt), r = (w.dir + 180) * Math.PI / 180, far = toPx(Calc.fromLocal(current.zmt, { x: Math.sin(r) * 1000, y: Math.cos(r) * 1000 }));
  let d = { x: far.x - z.x, y: far.y - z.y }; const l = Math.hypot(d.x, d.y) || 1; return { z, d: { x: d.x / l, y: d.y / l }, kt: w.spd * KT };
}
/* place la barbule centrée sous l'étiquette (cx = milieu de l'étiquette, top = bas de l'étiquette + 2) */
function barbUnder(bw, s, cx, top) { const g0 = barbGeom(bw.kt, { x: 0, y: 0 }, bw.d, s), b = barbBox(g0), dx = cx - (b.x0 + b.x1) / 2, dy = top - b.y0, mv = q => ({ x: q.x + dx, y: q.y + dy });
  return { lines: g0.lines.map(l => l.map(mv)), tris: g0.tris.map(t => t.map(mv)), calm: g0.calm, T: mv(g0.T) }; }
let barbMk = null;
function drawBarb() { /* v0.35.7 (Henri) : barbule DANS le marqueur ZMT, pile sous le texte « ZMT » — elle suit l'étiquette au zoom, au pincement et au glissement ; elle peut être recouverte */
  if (barbMk) { map.removeLayer(barbMk); barbMk = null; }
  document.querySelectorAll('.barbIn').forEach(e => e.remove());
  const el = mk.zmt && mk.zmt.getElement(); if (!el) return;
  const bw = barbWind(ll => map.latLngToContainerPoint(LL(ll))); if (!bw) return;
  const lb = el.querySelector('b'); let cx = 52, top = 26; /* repli : étiquette à droite de la cible (ancre 17,17) */
  if (lb && lb.offsetWidth) { const r = lb.getBoundingClientRect(), e = el.getBoundingClientRect(); cx = (r.left + r.right) / 2 - e.left - el.clientLeft; top = r.bottom - e.top - el.clientTop + 1; }
  const g = barbUnder(bw, 1, cx, top), B = barbBox(g), x0 = B.x0 - 2, y0 = B.y0 - 2, x1 = B.x1 + 2, y1 = B.y1 + 2, f = q => `${(q.x - x0).toFixed(1)},${(q.y - y0).toFixed(1)}`;
  const body = g.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join('');
  const d = document.createElement('div'); d.className = 'barbIn';
  Object.assign(d.style, { position: 'absolute', left: `${x0.toFixed(1)}px`, top: `${y0.toFixed(1)}px`, width: `${(x1 - x0).toFixed(1)}px`, height: `${(y1 - y0).toFixed(1)}px`, pointerEvents: 'none', zIndex: '-1' });
  d.innerHTML = `<svg width="${x1 - x0}" height="${y1 - y0}" style="overflow:visible;display:block"><path d="${body}" stroke="#000" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".55"/>${g.tris.map(t => `<path d="M${t.map(f).join('L')}Z" fill="#00e5ff" stroke="#000" stroke-width=".6"/>`).join('')}<path d="${body}" stroke="#00e5ff" stroke-width="1.1" stroke-linecap="round" fill="none"/>${g.calm ? `<circle cx="${(g.T.x - x0).toFixed(1)}" cy="${(g.T.y - y0).toFixed(1)}" r="2.5" stroke="#00e5ff" stroke-width="1.1" fill="none"/>` : ''}</svg>`;
  el.appendChild(d);
}
const zmtIcon = L.divIcon({ className: 'tgt zmt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span><b>ZMT</b>' });
const triIcon = L.divIcon({ className: 'tri', iconSize: [22, 20], iconAnchor: [11, 13], html: '<span></span>' });
const lbl = (ll, html, cls) => L.marker(LL(ll), { interactive: false, icon: L.divIcon({ className: cls || 'glabel', iconSize: [0, 0], html: `<span>${html}</span>` }) });
const mk = {}; // marqueurs gardés : zmt, ptu, drop, rot, et un par point (pt_<id>)
let vecHit = null;
function vecMoveFn(ll) {
      if (!sol || !sol.ok) return; const I2 = isv();
      if (!vecHit.off) vecHit.off = Calc.toLocal(ll, sol.vec.attach); // écart entre le doigt et le point de largage, gardé pendant tout le glissement
      I2.manual = clampToCircle(Calc.fromLocal(ll, vecHit.off)); I2.capManual = null; dragRecalc();
}
const vecEndFn = () => { vecHit.off = null; persist(); fillInputs(); redraw(); toast(sol && sol.ok ? `${sol.openLowered ? 'Ouverture à ' + fmtInt(sol.hOpen) + ' m' : fmt1(sol.tFall) + ' s de chute'} · cap para ${hdg(sol.cap)}` : (sol && sol.err) || ''); };
function vecHitLine(V, I) {
  const pts = [LL(V.green), LL(V.red)];
  if (!vecHit) {
    const line = L.polyline(pts, { color: '#fff', weight: 30, opacity: 0, interactive: true, bubblingMouseEvents: true }).addTo(handles);
    vecHit = { line, h: { _lpDragging: false, getElement: () => line._path, setLatLng: () => {} }, el: null, off: null };
  } else if (!vecHit.h._lpDragging) vecHit.line.setLatLngs(pts);
  if (!handles.hasLayer(vecHit.line)) vecHit.line.addTo(handles);
  /* Leaflet recrée l'élément <path> quand le trait revient sur la carte : rebrancher l'appui long sur le nouvel élément
     (piège connu, voir Setup PSV / vecteur-largage : jamais de simple booléen « déjà branché ») */
  if (vecHit.line._path && vecHit.el !== vecHit.line._path) {
    vecHit.el = vecHit.line._path;
    /* v0.26.0 (Henri) : appui long relâché sur le vecteur → « Déplacer » (toucher la carte : le vecteur va là) ou « Rentrer »
       (le vecteur glisse le long de l'axe de la trace jusqu'au point le plus proche de l'endroit touché : la trace ne change pas de cap) */
    vecHit.h._lpMenu = P => [
      { label: '✥ Déplacer', fn: () => LPMove.pick('Touche la carte : le vecteur va là', ll => LPMove.replay(vecHit.h, P, ll, vecMoveFn, vecEndFn, () => { vecHit.off = null; })) },
      { label: '⇢ Rentrer le long de la trace', fn: () => LPMove.pick('Touche la carte : le vecteur glisse le long de la trace jusque-là', ll => {
        if (!sol || !sol.ok) return; const T = sol.trace, a = Calc.toLocal(T[0], T[T.length - 1]), la = Math.hypot(a.x, a.y) || 1, u = { x: a.x / la, y: a.y / la }, d = Calc.toLocal(P, ll), k = d.x * u.x + d.y * u.y;
        const I2 = isv(); I2.manual = clampToCircle(Calc.fromLocal(sol.vec.attach, { x: u.x * k, y: u.y * k })); I2.capManual = null; vecEndFn(); }) }];
    longPressDrag(vecHit.h, vecMoveFn, vecEndFn, () => { vecHit.off = null; });
  }
}
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
/* Nom affiché d'un point = nom donné + numéro (si homonymes) + écart de hauteur avec la ZMT (P12 / N18, zones alternatives).
   v0.15.0 (Henri) : points de même nom ET même écart de hauteur numérotés 1, 2, 3… collés au nom (sans zéro), dans l'ordre
   de la trace (du vecteur de largage vers la ZMT) — « PONT1 », « ALT2 P12 » ; un point seul garde son nom tel quel. */
function ptSuffix(pt) {
  const I = isv();
  if (pt.kind === 'alt') { if (typeof pt.elev !== 'number' || (zmtElev() == null && typeof I.ptuElev !== 'number' && !wxRec)) return ''; const d = Math.round(pt.elev - elev0()); return `${d >= 0 ? 'P' : 'N'}${Math.abs(d)}`; }
  /* v0.20.0 (Henri) : sommet S créé depuis la coupe : hauteur de la trace au-dessus du terrain à cet endroit.
     v0.21.0 : plus de point P séparé, c'est le point précédent de la trace qui prend « -MINIxxxx » (traceMini) */
  if (pt.kind === 'zd') return pt.role === 'deb' ? 'DEB' : 'FIN'; /* v0.27.0 : ZD-DEB / ZD-FIN (ZD1-DEB… si plusieurs zones) */
  if (pt.auto === 'S') {
    if (typeof pt.elev !== 'number') { if (!ptElevAsked.has(pt.id)) { ptElevAsked.add(pt.id); pointElev(pt); } return pt.val != null ? String(pt.val) : ''; }
    if (sol && sol.ok && sol.trace.length > 1) pt.val = Math.round(Calc.nearestOn(sol.trace, pt).h + elev0() - pt.elev);
    return pt.val != null ? String(pt.val) : '';
  }
  return '';
}
/* marge au-dessus d'un sommet (m) : 300 m donnés par Henri le 21 nov. 2026, réglable dans Param. depuis v0.24.0 */
/* v0.21.0 (Henri) : pour chaque sommet S, le point de la trace juste avant (côté OUV) est renommé « <hauteur>-MINI<hauteur alti mini> » :
   hauteur alti (altimètre calé sur le sol de la ZMT) minimale en passant ce point pour passer S avec 300 m de marge
   = altitude du sommet + 300 − sol ZMT + descente prévue de la trace entre ce point et S. Plusieurs sommets → la plus grande valeur.
   Recalculé à chaque fois (la trace bouge avec le vent, le PTU…), rien n'est stocké. */
function sumVertex(T, S) { const n = Calc.nearestOn(T, S); let k = n.seg - 1; if (n.f < 1e-3 && k > 0) k--; return { k: Math.max(0, k - (S.back || 0)), h: n.h }; } /* v0.25.0 : S.back = nombre de points remontés vers l'OUV */
/* v0.25.0 (Henri) : appui sur un point de passage -MINI de la carte → proposer de basculer le MINI sur le point de la trace d'avant
   (il reprend son nom d'origine ; le précédent prend -MINI recalculé pour sa propre hauteur). Répétable jusqu'à l'OUV. */
async function miniBack(i) { /* v0.35.5 (Henri) : on peut aussi rebasculer vers l'avant (vers le sommet), jusqu'au point de départ */
  if (!sol || !sol.ok) return; const T = sol.trace, M = traceMini(), S = M.src[i] || [];
  if (!S.length) return;
  const canBack = i > 0, canFwd = S.some(q => (q.back || 0) > 0);
  if (!canBack && !canFwd) { toast('C\'est déjà le point d\'ouverture : impossible de remonter plus loin'); return; }
  $('dlgDel').classList.remove('danger'); /* « Avancer » n'est pas une suppression : bouton neutre */
  const r = await ask(`Point d'alerte ${fmtInt(T[i].h)}-MINI${M[i]}.${canBack ? ` Reculer : la hauteur mini passe sur le point d'avant (${i === 1 ? 'OUV ' : ''}${fmtInt(T[i - 1].h)}).` : ' (Déjà au point d\'ouverture.)'}${canFwd ? ` Avancer : elle revient sur le point suivant (${fmtInt(T[i + 1].h)}).` : ''}`, undefined, canFwd && canBack ? '◀ Reculer d\'un point' : null, canFwd ? 'Avancer d\'un point ▶' : '◀ Reculer d\'un point'); /* v0.35.6 (Henri) : Reculer à gauche, Avancer à droite */
  $('dlgDel').classList.add('danger');
  const back = () => S.forEach(q => { q.back = (q.back || 0) + 1; }), fwd = () => S.forEach(q => { if ((q.back || 0) > 0) q.back--; });
  if (r === 'DELETE') back(); else if (r === true) { if (canFwd) fwd(); else back(); }
  else return;
  persist(); redraw();
}
/* v0.27.0 (Henri) : zones délicates = deux points sur la trace (ZD-DEB, ZD-FIN). Le point de la trace avant le début prend
   « -MINI » = hauteur alti mini pour arriver à la fin de la zone avec la marge (même calcul qu'un sommet, avec l'altitude du terrain
   à la fin). Un sommet S situé dans la zone utilise le point d'alerte de la zone : le nom affiche la plus grande des deux valeurs.
   Bascule vers l'arrière comme pour les sommets (deb.back). */
const C_ZD = '#b388ff'; /* violet : distinct de l'orange « à revérifier » et du rose de la trace */
function traceSlice(T, s0, s1) { /* morceau de la trace entre les abscisses s0 et s1 (m) */
  const out = [Calc.pointAt(T, s0)]; let acc = 0;
  for (let i = 1; i < T.length; i++) { const a = Calc.toLocal(T[i - 1], T[i]); acc += Math.hypot(a.x, a.y); if (acc > s0 && acc < s1) out.push(T[i]); }
  out.push(Calc.pointAt(T, s1)); return out;
}
function zdSpans() { if (!sol || !sol.ok) return []; const T = sol.trace; return zdPairs().map(z => { const a = Calc.nearestOn(T, z.d).s, b = Calc.nearestOn(T, z.f).s; return { s0: Math.min(a, b), s1: Math.max(a, b), zid: z.d.zid, stale: sStale(z.d) || sStale(z.f) }; }); }
function zdPairs() { const P = isv().points; return P.filter(q => q.kind === 'zd' && q.role === 'deb').map(d => ({ d, f: P.find(q => q.kind === 'zd' && q.role === 'fin' && q.zid === d.zid) })).filter(z => z.f); }
function traceMini() {
  const out = []; out.stale = []; out.src = []; if (!sol || !sol.ok || sol.trace.length < 2) return out;
  const T = sol.trace, mg = +prm.sumMargin || 0, e0 = elev0();
  const add = (k, m, stale, src) => { if (!(out[k] >= m)) out[k] = m; if (stale) out.stale[k] = true; (out.src[k] = out.src[k] || []).includes(src) || out.src[k].push(src); };
  const Z = zdPairs().map(z => { const nd = Calc.nearestOn(T, z.d), nf = Calc.nearestOn(T, z.f), k = sumVertex(T, nd.s <= nf.s ? z.d : z.f).k;
    return { z, s0: Math.min(nd.s, nf.s), s1: Math.max(nd.s, nf.s), k, deb: nd.s <= nf.s ? z.d : z.f, fin: nd.s <= nf.s ? z.f : z.d, hf: nd.s <= nf.s ? nf.h : nd.h }; });
  Z.forEach(Q => { if (typeof Q.fin.elev === 'number') add(Q.k, Math.ceil(Q.fin.elev + mg - e0 + (T[Q.k].h - Q.hf)), sStale(Q.deb) || sStale(Q.fin), Q.deb); });
  isv().points.forEach(S => { if (S.auto !== 'S' || typeof S.elev !== 'number') return;
    const n = Calc.nearestOn(T, S), Q = Z.find(q => n.s >= q.s0 - 1 && n.s <= q.s1 + 1), k = Q ? Q.k : sumVertex(T, S).k;
    add(k, Math.ceil(S.elev + mg - e0 + (T[k].h - n.h)), sStale(S), Q ? Q.deb : S); });
  return out;
}
/* v0.22.0 (Henri) : si la trace a bougé depuis la pose d'un sommet S, bandeau d'alerte sur la carte pour revérifier les sommets
   (ils ne sont peut-être plus sur le point le plus haut sous la trace). S.sig = empreinte de la trace à la pose (ou à l'acquittement). */
function traceSig() { if (!sol || !sol.ok) return ''; let h = 0; const s = sol.trace.map(q => q.lat.toFixed(5) + ',' + q.lng.toFixed(5)).join(';'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); }
const C_WARN = '#ff8c00'; /* v0.23.0 : sommet S pas revérifié depuis que la trace a bougé (et son point de passage) → orange */
function sStale(q) { if ((q.auto !== 'S' && q.kind !== 'zd') || !q.sig) return false; const s = traceSig(); return !!s && q.sig !== s; }
function syncSumWarn() {
  const sig = traceSig(), S = isv().points.filter(q => q.auto === 'S' || q.kind === 'zd');
  if (sig) S.forEach(q => { if (!q.sig) q.sig = sig; });
  $('sumWarn').classList.toggle('hidden', !sig || !S.some(q => q.sig !== sig));
}
$('sumOk').addEventListener('click', () => { const sig = traceSig(); isv().points.forEach(q => { if (q.auto === 'S' || q.kind === 'zd') q.sig = sig; }); persist(); syncSumWarn(); redraw(); });
const miniTag = (M, i) => M[i] != null ? `-MINI${M[i]}` : '';
const ptElevAsked = new Set();
/* v0.28.0 (Henri) : zone alternative nommée toute seule selon sa position (nom gardé tant qu'il n'est pas forcé, pt.nameAuto) :
   LONG = projection sur l'axe de la trace au-delà du PTU ; COURT = projection avant le PTU et à moins de prm.courtKm de la ZMT. */
function altPos(p) { /* position d'une zone alternative : OSO (à moins de prm.osoKm du point jaune le plus proche), LONG (projection au-delà du PTU), COURT (avant le PTU, à moins de prm.courtKm de la ZMT) */
  const r = { oso: false, court: false, long: false }; if (!sol || !sol.ok || sol.trace.length < 2) return r;
  const Y = greyPoints() || []; /* greyPoints = points JAUNES (arrivée au sol après la dérive sous voile) */
  r.oso = Y.some(y => { const q = Calc.toLocal(y, p); return Math.hypot(q.x, q.y) <= (+prm.osoKm || 0) * 1000; });
  const T = sol.trace, a = Calc.toLocal(T[0], T[T.length - 1]), L0 = Math.hypot(a.x, a.y) || 1, q = Calc.toLocal(T[0], p), t = (q.x * a.x + q.y * a.y) / L0;
  if (t > L0) r.long = true;
  else if (current.zmt) { const z = Calc.toLocal(current.zmt, p); r.court = Math.hypot(z.x, z.y) <= (+prm.courtKm || 0) * 1000; }
  return r;
}
function altAutoName(p) { const r = altPos(p); return r.oso ? 'OSO' : r.long ? 'LONG' : r.court ? 'COURT' : ''; } /* v0.29.0 : OSO ajouté (règle validée par Henri : 2 km autour du point jaune le plus proche, réglable) */
function ptName(pt) { return String((pt.kind === 'alt' && pt.nameAuto ? altAutoName(pt) : pt.name) || '').trim(); }
function ptNum(pt) {
  if (pt.kind === 'zd') { /* v0.28.0 : ZD1-DEB / ZD1-FIN, ZD2-… numérotées par zone dans le sens de la trace */
    if (!sol || !sol.ok) return ''; const Z = zdPairs().map(z => ({ zid: z.d.zid, s: Math.min(Calc.nearestOn(sol.trace, z.d).s, Calc.nearestOn(sol.trace, z.f).s) })).sort((a, b) => a.s - b.s);
    return Z.length < 2 ? '' : String(Z.findIndex(z => z.zid === pt.zid) + 1); }
  const nm = ptName(pt); if (!nm) return '';
  const sf = ptSuffix(pt), pts = isv().points, grp = pts.filter(q => q.kind !== 'zd' && ptName(q) === nm && ptSuffix(q) === sf); if (grp.length < 2) return '';
  const pos = q => (sol && sol.ok && sol.trace.length > 1) ? Calc.nearestOn(sol.trace, q).s : pts.indexOf(q);
  grp.sort((a, b) => pos(a) - pos(b) || pts.indexOf(a) - pts.indexOf(b));
  return String(grp.indexOf(pt) + 1);
}
function pointLabel(pt) { const nm = ptName(pt), sf = ptSuffix(pt); return `${nm}${ptNum(pt)}${sf ? (nm ? '-' : '') + sf : ''}`; } /* v0.20.0 : tiret au lieu de l'espace (« ALT2-P12 », « S-4338 ») */
function draw(light) {
  compute();
  if (!light && typeof Photo !== 'undefined') Photo.sync(); /* v0.9.0 : manquait (photo calée pas suivie au changement de zone) */
  const I = isv(); fig.clearLayers();
  // ZRT : affichage seulement
  current.zrt.forEach(z => { if (z.show === false) return; z.lines.forEach(ln => L.polyline(ln.p, { color: '#ff2020', weight: 2, opacity: .9, dashArray: '10 6', fill: !!ln.c, fillOpacity: .06, interactive: false }).addTo(fig)); });
  // ZMT et PTU
  keep('zmt', current.zmt, zmtIcon, 300, ll => { current.zmt = ll; dragRecalc(); }, () => { persist(); fillInputs(); redraw(); });
  drawBarb(); /* v0.35.3 : après la ZMT (on lit la position de son étiquette) */
  keep('ptu', I.ptu, dotIcon(C_PTU, 16, `PTU ${fmtInt(I.hPtu)} m`, 'big'), 400, ll => { I.ptu = ll; I.manual = null; I.ptuElev = null; dragRecalc(); }, () => { persist(); fillInputs(); redraw(); refreshPtuElev(); ensureWx(false); });
  // Points de l'ISV
  const seen = {}, PB = window._stepsReady ? probSet() : { ids: new Set(), ks: new Set() };
  isv().points.forEach(pt => {
    seen['pt_' + pt.id] = 1;
    const ic = pt.kind === 'alt' ? L.divIcon({ className: 'tgt alt', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span></span><b>${esc(pointLabel(pt))}</b>` })
      : L.divIcon({ className: 'crossp', iconSize: [26, 26], iconAnchor: [13, 13], html: `<i class="dia" style="background:${sStale(pt) || PB.ids.has(pt.id) || PB.ids.has(pt.zid) ? C_WARN : pt.auto === 'S' ? C_ZD : pt.color || '#fff'}"></i><b style="color:${sStale(pt) || PB.ids.has(pt.id) || PB.ids.has(pt.zid) ? C_WARN : pt.auto === 'S' ? C_ZD : pt.color || '#fff'}">${esc(pointLabel(pt))}</b>` }); /* v0.19.1 : losange comme les repères de prepo-PA (avant : croix) */
    keep('pt_' + pt.id, pt, ic, 250, ll => { if ((pt.auto === 'S' || pt.kind === 'zd') && sol && sol.ok && sol.trace.length > 1) { ll = Calc.nearestOn(sol.trace, ll).pt; if (mk['pt_' + pt.id]) mk['pt_' + pt.id].setLatLng(LL(ll)); } /* v0.23.0 (Henri) : un sommet S reste sur la trace (projeté à la perpendiculaire) */ pt.lat = ll.lat; pt.lng = ll.lng; }, () => { if (pt.auto === 'S') { placeSummit(pt, { lat: pt.lat, lng: pt.lng }); return; } if (pt.kind === 'zd') pt.sig = traceSig(); persist(); pt.elev = null; pointElev(pt); syncSumWarn(); redraw(); }, () => pointMenu(pt));
  });
  Object.keys(mk).filter(k => k.startsWith('pt_') && !seen[k]).forEach(k => { handles.removeLayer(mk[k]); delete mk[k]; });

  if (!sol || !sol.ok) { keep('drop', null); keep('rot', null); if (vecHit && handles.hasLayer(vecHit.line)) handles.removeLayer(vecHit.line); if (!light) updateInfo(); capInfo(); return; }
  // Cercle de relaxation (points de largage)
  if (current.show.relax && sol.circle.R > 0) L.circle(LL(sol.circle.c), { radius: sol.circle.R, color: C_RELAX, weight: 2.4, fill: false, interactive: false }).addTo(fig);
  // Trace : tous les segments, de l'ouverture terminée au PTU
  const T = sol.trace.map(LL);
  L.polyline(T, { color: '#000', weight: 7, opacity: .55, interactive: false }).addTo(fig);
  L.polyline(T, { color: C_TRACE, weight: 3.6, interactive: false }).addTo(fig);
  zdSpans().forEach(z => L.polyline(traceSlice(sol.trace, z.s0, z.s1).map(LL), { color: z.stale || PB.ids.has(z.zid) ? C_WARN : C_ZD, weight: 7, opacity: .75, dashArray: '10 8', interactive: false }).addTo(fig)); /* v0.27.0 : zones délicates */
  const TP = sol.trace.map(p => map.latLngToContainerPoint(LL(p))), k0 = TP.length - 1;
  const flat = Math.abs(TP[k0].x - TP[0].x) > Math.abs(TP[k0].y - TP[0].y); let lastLab = null;
  const MI = traceMini(); syncSumWarn();
  sol.trace.forEach((p, i) => {
    if (i === k0) return; // le PTU a son propre point
    const far = !lastLab || TP[i].distanceTo(lastLab) >= (flat ? 26 : 20) || i === 0, farPtu = TP[i].distanceTo(TP[k0]) >= 30;
    const show = far && (farPtu || i === 0); if (show) lastLab = TP[i]; /* hauteurs toujours affichées (bouton Infos retiré en v0.5.3) */
    const vm = L.marker(LL(p), { interactive: MI[i] != null, icon: dotIcon(MI[i] != null ? (MI.stale[i] || PB.ks.has(i) ? C_WARN : C_ZD) : C_TRACE, /* v0.29.0 : points d'alerte en violet */ i === 0 ? 13 : MI[i] != null ? 12 : 8, /* v0.22.0 : point de passage -MINI en blanc (appli seulement, pas dans les exports) */ (show || MI[i] != null) ? (i === 0 ? `OUV ${fmtInt(p.h)}` : fmtInt(p.h)) + miniTag(MI, i) : '', (i === 0 ? 'big' : '') + (flat ? ' up' : '')) }).addTo(fig);
    if (MI[i] != null) vm.on('click', () => { if (Date.now() < suppressClickUntil) return; miniBack(i); });
  });
  // Vecteur de largage
  const V = sol.vec, vl = [LL(V.green), LL(V.red)];
  L.polyline(vl, { color: '#fff', weight: 9, opacity: .9, interactive: false }).addTo(fig);
  L.polyline(vl, { color: '#000', weight: 4.5, interactive: false }).addTo(fig);
  V.exits.forEach(e => L.marker(LL(e), { interactive: false, icon: L.divIcon({ className: 'exitp' + (e.i === sol.dropIdx ? ' ref' : ''), iconSize: [12, 12], iconAnchor: [6, 6], html: '<span></span>' }) }).addTo(fig));
  // Poignées : point de largage (déplacer le vecteur), point vert (le faire tourner)
  // v0.5.6 (Henri) : plus de rond blanc ; poignée invisible tout le long du vecteur (trait épais transparent, comme dans les
  // autres applis) : appui long n'importe où sur le vecteur puis glisser = déplacer. Le point attrapé reste sous le doigt.
  keep('drop', null);
  vecHitLine(V, I);
  keep('rot', V.green, dotIcon(C_START, 15, '', 'big'), 650,
    ll => { if (!sol || !sol.ok) return; const q = Calc.toLocal(ll, sol.vec.attach); if (Math.hypot(q.x, q.y) < 20) return; I.vecHeading = Calc.bearingOf(q); I.reversed = false; dragRecalc(); },
    () => { persist(); fillInputs(); redraw(); if (sol && sol.ok) toast(`Cap du vecteur ${hdg(sol.acHeading)}`); });
  /* v0.26.0 (Henri) : le point rouge fait aussi pivoter le vecteur (cap du point de largage vers le doigt) */
  keep('rotR', V.red, dotIcon(C_END, 15, '', 'big'), 650,
    ll => { if (!sol || !sol.ok) return; const q = Calc.toLocal(sol.vec.attach, ll); if (Math.hypot(q.x, q.y) < 20) return; I.vecHeading = Calc.bearingOf(q); I.reversed = false; dragRecalc(); },
    () => { persist(); fillInputs(); redraw(); if (sol && sol.ok) toast(`Cap du vecteur ${hdg(sol.acHeading)}`); });
  // v0.5.3 (Henri) : plus d'étiquettes le long du vecteur et de la trace ; cap avion et cap para en haut à droite (#capInfo)
  // Ouverture basse : un point jaune par para
  /* v0.5.9 (Henri) : gris = ouverture automatique à 1 900 ft au-dessus du point haut ; jaune = arrivée au sol (hauteur du point haut) après la dérive sous voile */
  (lowPoints() || []).forEach(p => L.circleMarker(LL(p), { radius: 5.5, color: '#000', weight: 1.5, fillColor: C_GREY, fillOpacity: 1, interactive: false }).addTo(fig));
  (greyPoints() || []).forEach(p => L.circleMarker(LL(p), { radius: 5.5, color: '#000', weight: 1.5, fillColor: C_LOW, fillOpacity: 1, interactive: false }).addTo(fig));
  // Point le plus haut de la zone de sécurité
  if (I.alti && I.alti.max && I.alti.key === altiKey()) L.marker(LL(I.alti.max), { interactive: false, icon: triIcon }).addTo(fig);
  if (!light) updateInfo();
  capInfo();
  if (!light && window._stepsReady) { syncSteps(); requestAnimationFrame(syncStepBar); } /* v0.28.0 : préparation pas à pas (STEPS est déclaré en fin de fichier : pas avant) */
}
/* Cap avion / longueur du vecteur et cap para / longueur de la trace, sous les boutons ronds du haut (v0.5.3) */
function capInfo() {
  const el = $('capInfo'); if (!el) return;
  if (!sol || !sol.ok) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = `<div>Cap avion : ${hdg(sol.vec.heading)} / ${fmtInt(sol.vec.length)} m</div><div>Cap para : ${hdg(sol.cap)} / ${fmtKm(sol.length)}</div><div class="altil">Altimétrie : <span id="altiState" class="ast wait">…</span></div>`;
  el.classList.remove('hidden'); altiState(); /* v0.13.0 : l'état du point haut (… / ✓ / !) remplace le bouton Alti */
}
/* Bouton Alti : « … » tant que le point haut n'est pas calculé pour le vecteur actuel, coche verte quand c'est fait (v0.5.3) */
function altiState() {
  const el = $('altiState'); if (!el) return;
  const I = isv(), ok = !!(sol && sol.ok && I.alti && I.alti.max && I.alti.key === altiKey());
  const err = !ok && I.altiErr && !altiBusy; /* échec : « ! » rouge ; le calcul repart tout seul au retour dans l'appli ou du réseau */
  el.textContent = ok ? '✓' : err ? '!' : '…'; el.className = 'ast ' + (ok ? 'ok' : err ? 'err' : 'wait');
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
  const tops = [...document.querySelectorAll('#top button, #capInfo')].map(rel).filter(q => q.width);
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
  if (current.zmt) pts.push(current.zmt); if (I.ptu) pts.push(I.ptu);
  if (sol && sol.ok) {
    sol.trace.forEach(p => pts.push(p)); pts.push(sol.vec.green, sol.vec.red);
    (lowPoints() || []).forEach(p => pts.push(p)); (greyPoints() || []).forEach(p => pts.push(p));
    if (current.show.relax) [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].forEach(a => pts.push(Calc.fromLocal(sol.circle.c, { x: sol.circle.R * Math.sin(a * Math.PI / 180), y: sol.circle.R * Math.cos(a * Math.PI / 180) })));
  }
  return pts.map(p => ({ lat: p.lat, lng: p.lng }));
}
function updateInfo() {
  const I = isv(); let t = null;
  if (placing) return;
  let ti = null;
  if (!current.zmt && !I.ptu) { t = 'Onglet Zones : place la zone de posé (ZMT), puis le point d\'entrée PTU dans l\'onglet Prépa ISV.'; ti = 'Pose la ZMT, puis le PTU'; }
  else if (!I.ptu) { t = 'Place le point d\'entrée PTU (onglet Prépa ISV).'; ti = 'Pose le PTU'; }
  else if (sol && !sol.ok) { t = sol.err; ti = 'Calcul impossible'; }
  else if (sol && sol.warn) { t = '⚠️ ' + sol.warn; ti = '⚠️ Attention'; }
  else if (!F) { t = zeroWind ? null : '⚠️ Pas de prévision de vent pour cette heure : trace calculée SANS VENT.'; ti = '⚠️ Trace sans vent'; }
  if (!guideOn() && (ti === 'Pose la ZMT, puis le PTU' || ti === 'Pose le PTU')) t = null; /* guidage seulement ; erreurs et alertes restent */
  setBanner(t, ti);
}

// ---------- Interface ----------
function $(id) { return document.getElementById(id) || document.createElement('div'); }
/* v0.35.7 (Henri : bandeaux trop gros) : titre court + bouton ⓘ ; l'explication s'affiche dans une bulle SOUS le bandeau du haut */
let bannerShut = null; /* v0.35.9 : consigne fermée par sa croix ; elle ne revient que si le texte change */
function setBanner(t, title) { const b = $('banner'); hideBannerInfo();
  let pl = null; try { pl = placing; } catch (e) {}
  if (t !== bannerShut) bannerShut = null;
  if (!t || (!pl && t === bannerShut)) { b.classList.add('hidden'); return; }
  b.dataset.t = t;
  if (title && title !== t) { b.innerHTML = '<span class="bt"></span> <button class="sinfo" title="Explication">i</button>'; b.querySelector('.bt').textContent = title; b.querySelector('.sinfo').onclick = e => { e.stopPropagation(); if (!$('bannerInfo').classList.contains('hidden')) hideBannerInfo(); else showBannerInfo(t); }; }
  else b.textContent = t;
  b.classList.remove('hidden', 'hasx'); addPlaceCancel(); }
function showBannerInfo(t) { const el = $('bannerInfo'), b = $('banner'); el.querySelector('span').textContent = t; el.classList.remove('hidden');
  const r = b.getBoundingClientRect(); Object.assign(el.style, { left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px`, top: `${Math.round(r.bottom + 6)}px` }); }
function hideBannerInfo() { const el = document.getElementById('bannerInfo'); if (el) el.classList.add('hidden'); }
// Pendant un placement (toucher la carte), bouton « ✕ Annuler » dans le bandeau (21 nov. 2026, demande d'Henri)
function addPlaceCancel() {
  let p = null; try { p = placing; } catch (e) { return; } // placing pas encore déclaré au tout début
  const b = $('banner'); if (b.querySelector('.bcancel')) return;
  const c = document.createElement('button'); c.className = 'bcancel'; c.textContent = '✕'; c.title = p ? 'Annuler' : 'Fermer'; /* Henri : plus de gros bouton Annuler, une croix en haut à droite du bandeau */
  /* v0.35.9 (Henri) : croix sur TOUS les bandeaux du haut ; en placement = annuler, sinon (« Pose la ZMT, puis le PTU »…) = fermer la consigne */
  c.onclick = e => { e.stopPropagation(); if (p) { cancelPlacing(); toast('Placement annulé'); } else { bannerShut = b.dataset.t; b.classList.add('hidden'); hideBannerInfo(); } };
  b.classList.add('hasx'); b.append(c);
}
function cancelPlacing() { placing = null; ptOpen = false; ptPal = false; placeBanner(); fillInputs(); redraw(); }
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
  $('zmtInfo').textContent = current.zmt ? fmtPos(current.zmt) : 'Pas encore placée.';
  $('ptuInfo').textContent = I.ptu ? fmtPos(I.ptu) : 'Pas encore placé.';
  $('btnPlaceZ').classList.toggle('on', placing === 'Z'); $('btnPlaceP').classList.toggle('on', placing === 'P');
  setVal('p_margin', prm.margin); setVal('p_vff', prm.vff); setVal('p_sumMargin', prm.sumMargin); setVal('p_courtKm', prm.courtKm); setVal('p_osoKm', prm.osoKm); setVal('p_osoFt', prm.osoFt); setVal('p_tRef', prm.tRef); setVal('p_offKm', prm.offKm);
  setVal('a_long', I.secLong); setVal('a_lat', I.secLat);
  syncQuick(); syncJump();
  const open = !$('sheet').classList.contains('hidden');
  if (open && lastTab === 'isv') { renderIsvList(); renderPtList(); renderIsvTab(); renderVol(); } /* v0.6.2 : onglet Vol fusionné dans ISV ; v0.6.3 : liste des ISV en tête */
  if (open && lastTab === 'brief') renderBrief();
  if (open && lastTab === 'params') renderCans();
  if (open && lastTab === 'zones') { renderZones(); renderZrt(); }
}
function syncQuick() {
  const I = isv();
  $('qRelax').classList.toggle('on', !!current.show.relax);
  $('qRev').classList.toggle('on', !!I.reversed);
  $('qVecAuto').classList.toggle('hidden', !(I.manual || I.vecHeading != null || I.capManual != null));
  if ($('qZero')) $('qZero').classList.toggle('on', zeroWind); $('qWinds').classList.toggle('on', !$('windsBox').classList.contains('hidden'));
  $('qPoint').classList.toggle('on', ptOpen || !!(placing && typeof placing === 'object' && placing.kind !== 'move'));
  if (typeof syncPtPop === 'function') try { syncPtPop(); } catch (e) {}
}
function quick(fn) { fn(); persist(); fillInputs(); redraw(); }
$('qRelax').addEventListener('click', () => quick(() => { current.show.relax = !current.show.relax; }));
$('qRev').addEventListener('click', () => quick(() => { const I = isv(); I.reversed = !I.reversed; }));
$('qVecAuto').addEventListener('click', () => { quick(() => { const I = isv(); I.manual = null; I.vecHeading = null; I.capManual = null; I.reversed = false; }); toast('Vecteur et cap para recalculés'); });
/* v0.18.0 : bouton Vent 0 supprimé (Henri) */ if ($('qZero')) $('qZero').addEventListener('click', () => { zeroWind = !zeroWind; store.set('isv.zeroWind', zeroWind); fillInputs(); draw(); if (!$('windsBox').classList.contains('hidden')) renderWinds(); toast(zeroWind ? 'ESSAI : vent forcé à 0 partout' : 'Vent réel rétabli'); });
$('qIsv').addEventListener('click', () => toggleTab('isv'));
$('qBrief').addEventListener('click', () => toggleTab('brief')); /* v0.16.0 : bouton Briefing sous Prépa ISV */

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
  if (!force && !isv().ptu && !current.zmt) return have; // rien à calculer tant qu'aucun point n'est placé
  if (wxBusy) return have; wxBusy = true; $('wxInfo').innerHTML = 'Téléchargement de la prévision…';
  try { const r = await wxFetch(current, date); delete wxFailed[date]; return r; }
  catch (e) { wxFailed[date] = true; toast(have ? 'Pas de réseau : prévision gardée, téléchargée le ' + fmtFetched(have.fetched) : 'Prévision impossible à télécharger (réseau ?)'); return have; }
  finally { wxBusy = false; fillInputs(); redraw(); }
}
function setWhen(w) { current.when = w; const I = isv(); I.when = w; if (I.nameAuto) I.name = isvAutoName(I); persist(); fillInputs(); redraw(); ensureWx(false); }
$('qWhen').addEventListener('click', () => { $('jumpBox').classList.toggle('hidden'); syncJump(); });
$('jumpOk').addEventListener('click', () => { $('jumpBox').classList.add('hidden'); });
$('j_minus').addEventListener('click', () => setWhen(shiftWhen(current.when, -1)));
$('j_plus').addEventListener('click', () => setWhen(shiftWhen(current.when, 1)));
$('j_now').addEventListener('click', () => { setWhen(nowWhen()); ensureWx(true); });
$('j_date').addEventListener('change', e => { if (e.target.value) setWhen(e.target.value + current.when.slice(10)); });
$('j_hour').addEventListener('change', e => setWhen(current.when.slice(0, 11) + e.target.value + ':00'));

// ---------- Tableau des vents, à la verticale de la ZMT (date et heure indépendantes de la carte) ----------
let tWhen = null;
/* Point choisi sur la carte pour le tableau (windpick.js, v0.6.0) : prévision d'un seul point, gardée en mémoire (pas sur le téléphone) */
let windPt = null; const pickMem = {}, pickFailed = {};
async function wxFetchPoint(p, date) {
  const src = wxSource(date), ec = wxSource('9999-12-31'), tries = [[src, false, false], [src, true, true]].concat(src.kind === 'mf' ? [[ec, false, false], [ec, true, true]] : []);
  let js = null, used = src;
  for (const [s2, minimal, lite] of tries) { try { const r = await fetch(wxUrl([p.lat], [p.lng], date, s2, minimal, lite)); if (r.ok) { js = await r.json(); used = s2; break; } } catch (e) { if (navigator.onLine === false) break; } }
  const a = Array.isArray(js) ? js[0] : js; if (!a || !a.hourly) throw new Error('réseau');
  const slim = H => { const o = {}; Object.keys(H).forEach(k => { if (k !== 'time') o[k] = H[k].map(x => typeof x === 'number' ? Math.round(x * 10) / 10 : null); }); return o; };
  return { date, fetched: Date.now(), model: used.name, rh: true, center: { lat: p.lat, lng: p.lng }, halfKm: 0, lat0: p.lat, lng0: p.lng, dLat: 0.01, dLng: 0.01, n: 1, time: a.hourly.time,
    nodes: [{ elev: typeof a.elevation === 'number' ? a.elevation : 0, h: slim(a.hourly) }] };
}
const pickKey = (p, date) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4) + '|' + date;
async function ensurePick(date) {
  const k = pickKey(windPt, date), have = pickMem[k]; if (have && Date.now() - have.fetched < 3600e3) return have;
  try { const r = await wxFetchPoint(windPt, date); pickMem[k] = r; delete pickFailed[k]; return r; } catch (e) { pickFailed[k] = true; return have; }
}
function windRows(Fx, pt, e0) { // une ligne par tranche de 1 000 ft (FL), du sol au FL400
  const rows = [], add = (lab, alt) => { const w = Calc.windAt(Fx, pt.lat, pt.lng, alt), sd = Calc.spdDir(w); rows.push({ lab, h: alt - e0, dir: sd.dir, spd: sd.spd, T: w.T, RH: Calc.rhAt(Fx, pt.lat, pt.lng, alt) }); };
  add('Sol (10 m)', e0 + 10);
  for (let fl = 10; fl <= 400; fl += 10) { const alt = Calc.flToAlt(Fx, pt, fl); if (alt > e0 + 30) add('FL' + String(fl).padStart(3, '0'), alt); }
  return rows;
}
function renderWinds() {
  const date = tWhen.slice(0, 10);
  $('t_unpick').textContent = current.zmt ? '↺ Revenir à la ZMT' : isv().ptu ? '↺ Revenir au PTU' : '↺ Revenir au centre';
  if (windPt) { /* point choisi sur la carte */
    const k = pickKey(windPt, date), rec = pickMem[k], Fx = rec ? fieldOf(rec, tWhen) : null, e0 = rec ? rec.nodes[0].elev : 0;
    $('t_date').value = date; $('t_hour').value = tWhen.slice(11, 13);
    $('t_info').innerHTML = (rec ? `${rec.model.split(' (')[0]} · prévision du ${fmtFetched(rec.fetched)}` : pickFailed[k] ? '⚠️ Prévision impossible à télécharger pour ce point (réseau ?).' : 'Prévision en cours de téléchargement…') +
      ` · <b>au point choisi</b> (${fmtPos(windPt)})` + (rec ? ` · hauteurs au-dessus du sol (${fmtInt(e0)} m)` : '');
    const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
    if (!Fx) { tb.innerHTML = `<tr><td colspan="6" class="mut">${rec ? 'Pas de donnée pour cette heure.' : '…'}</td></tr>`; return; }
    windRows(Fx, windPt, e0).forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = `<td>${r.lab}</td><td>${fmtInt(r.h)} m</td><td>${hdgN(r.dir)}</td><td>${Math.round(r.spd * KT)} kt</td><td>${fmt1(r.spd)} m/s</td><td>${r.T == null ? '–' : Math.round(r.T) + ' °C'}</td><td>${r.RH == null ? '–' : Math.round(r.RH) + ' %'}</td>`; tb.append(tr); });
    return;
  }
  /* v0.8.0 : par défaut à la verticale de la ZMT (demande d'Henri), visible dès la ZMT posée, avant le PTU */
  const z = current.zmt;
  const rec = wxCached(current.id, date), Fx = fieldOf(rec, tWhen), pt = z || wxWanted().center, e0 = elev0();
  $('t_date').value = date; $('t_hour').value = tWhen.slice(11, 13);
  $('t_info').innerHTML = wxStatus(rec, tWhen) + ` · à la verticale ${z ? 'de la ZMT' : isv().ptu ? 'du PTU' : 'du centre'} · hauteurs au-dessus du sol ${z ? 'de la ZMT ' : ''}(${fmtInt(e0)} m)`;
  const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
  if (!Fx) { tb.innerHTML = '<tr><td colspan="6" class="mut">Pas de donnée pour cette heure.</td></tr>'; return; }
  windRows(Fx, pt, e0).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.lab}</td><td>${fmtInt(r.h)} m</td><td>${hdgN(r.dir)}</td><td>${Math.round(r.spd * KT)} kt</td><td>${fmt1(r.spd)} m/s</td><td>${r.T == null ? '–' : Math.round(r.T) + ' °C'}</td><td>${r.RH == null ? '–' : Math.round(r.RH) + ' %'}</td>`;
    tb.append(tr);
  });
}
async function setTWhen(w) { tWhen = w; renderWinds(); if (windPt) { const p0 = windPt; await ensurePick(w.slice(0, 10)); if (windPt === p0) renderWinds(); return; } const d = w.slice(0, 10), have = wxCached(current.id, d); if (!have || Date.now() - have.fetched > 3600e3 || have.rh === undefined) { await ensureWx(false, d); renderWinds(); } }
$('qWinds').addEventListener('click', () => { const b = $('windsBox'); if (!b.classList.contains('hidden')) { b.classList.add('hidden'); syncQuick(); WindPick.sync(); return; } WindPick.reset(); b.classList.remove('hidden'); syncQuick(); setTWhen(current.when); });
WindPick.init({ map, isOpen: () => !$('windsBox').classList.contains('hidden'),
  open: () => { $('windsBox').classList.remove('hidden'); syncQuick(); setTWhen(tWhen || current.when); },
  close: () => { $('windsBox').classList.add('hidden'); syncQuick(); },
  onPick: p => { windPt = p; if (!$('windsBox').classList.contains('hidden')) setTWhen(tWhen || current.when); }, restoreBanner: () => placeBanner() });
$('t_close').addEventListener('click', () => { $('windsBox').classList.add('hidden'); syncQuick(); });
$('t_minus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, -1)));
$('t_plus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, 1)));
$('t_now').addEventListener('click', () => setTWhen(nowWhen()));
$('t_date').addEventListener('change', e => { if (e.target.value) setTWhen(e.target.value + tWhen.slice(10)); });
$('t_hour').addEventListener('change', e => setTWhen(tWhen.slice(0, 11) + e.target.value + ':00'));

// ---------- Placement de la ZMT, du PTU et des points ----------
function placeBanner() { if (window._stepsReady) requestAnimationFrame(syncStepBar);
  if (ptOpen && !placing) { setBanner('Choisis le type de point à droite du ＋ Point.', 'Type de point ?'); return; }
  setBanner(placing === 'Z' ? 'Touche la carte pour placer la zone de posé (ZMT).' : placing === 'P' ? 'Touche la carte pour placer le point d\'entrée PTU.'
    : placing ? (placing.kind === 'move' ? `Touche la carte pour le nouvel emplacement de « ${placing.name} ».` : placing.kind === 'alt' ? 'Touche la carte pour placer la zone de posé alternative.' : placing.kind === 'zd' ? (placing.stage === 'deb' ? 'Touche la trace au DÉBUT de la zone délicate.' : 'Touche la trace à la FIN de la zone délicate.') : 'Touche la carte pour placer le point libre.') : null,
    placing === 'Z' ? 'Pose de la ZMT' : placing === 'P' ? 'Pose du PTU' : placing ? (placing.kind === 'move' ? `Déplacer « ${placing.name} »` : placing.kind === 'alt' ? 'Pose d\'une zone alternative' : placing.kind === 'zd' ? (placing.stage === 'deb' ? 'Zone délicate : début' : 'Zone délicate : fin') : 'Pose d\'un point libre') : null);
  if (!placing) updateInfo();
}
function startPlacing(what) { placing = placing === what ? null : what; stopMeasure(); if (placing) closeSheet(); placeBanner(); fillInputs(); }
$('btnPlaceZ').addEventListener('click', () => startPlacing('Z'));
$('btnPlaceP').addEventListener('click', () => startPlacing('P'));
function setZmt(p) { const I = isv(); current.zmt = { lat: p.lat, lng: p.lng }; persist(); refreshZmtElev(); fillInputs(); draw(); if (!I.ptu) { placing = 'P'; placeBanner(); toast('ZMT placée. Maintenant le point d\'entrée PTU.'); } }
function setPtu(p) { const I = isv(); I.ptu = { lat: p.lat, lng: p.lng }; I.manual = null; I.ptuElev = null; persist(); fillInputs(); draw(); refreshPtuElev(); ensureWx(false).then(() => { compute(); if (sol && sol.ok) fitFigure(); }); }
async function askCoords(what) {
  const t = await ask(`Coordonnées ${what} : degrés et minutes décimales (N 44°18,468' E 001°04,865'), MGRS (31T CK 46949 07851) ou degrés décimaux (44.3078 1.0811).`, '');
  if (!t) return null; const c = parseCoords(t); if (!c) { toast('Coordonnées non comprises'); return null; } return c;
}
$('btnCoordZ').addEventListener('click', async () => { if (!(await askZoneName())) return; const c = await askCoords('de la zone de posé'); if (!c) return; map.setView(LL(c), Math.max(map.getZoom(), 13)); setZmt(c); });
$('btnCoordP').addEventListener('click', async () => { if (!(await askZoneName())) return; const c = await askCoords('du point d\'entrée PTU'); if (!c) return; map.setView(LL(c), Math.max(map.getZoom(), 13)); setPtu(c); });
// Points : zone de posé alternative (rouge, cible) ou point libre (losange blanc)
const PT_COLORS = ['#ffffff', '#ffd400', '#1ec83c', '#00e5ff', '#2f80ff', '#ff3fb4', '#ff8c00', '#000000'];
let ptColor = '#ffffff'; /* v0.19.1 : plus de choix de couleur (le GPX n'en garde pas) : point libre toujours blanc, comme les repères de prepo-PA */
/* v0.17.0 (Henri) : ＋ Point ouvre deux boutons à droite (zone de posé alternative, point libre + rond de couleur qui ouvre
   la palette), comme les repères de l'appli PA ; pas de fenêtre ; réappui sur ＋ Point ou appui sur un autre bouton = sortie */
function syncPtColors() {}
function syncPtPop() { if (window._stepsReady) requestAnimationFrame(syncStepBar); /* v0.35.12 (photo d'Henri) : le bandeau d'étape cachait les boutons du ＋ Point → masqué pendant le choix du type de point et les placements */
  const pop = $('ptPop'); pop.classList.toggle('hidden', !ptOpen);
  if (!ptOpen) return;
  const k = placing && typeof placing === 'object' ? placing.kind : null;
  $('ptAlt').classList.toggle('on', k === 'alt'); $('ptFree').classList.toggle('on', k === 'free'); $('ptZd').classList.toggle('on', k === 'zd'); syncPtColors();
  const r = $('qPoint').getBoundingClientRect(); pop.style.left = `${Math.round(r.right + 6)}px`; pop.style.top = `${Math.round(r.top + r.height / 2 - 22)}px`;
}
function openPtPop() { closeSheet(); suspended = null; /* v0.19.0 : la mesure reste affichée pour poser un point sur un de ses bouts */ ptOpen = true; ptPal = false; if (placing && typeof placing === 'object' && placing.kind !== 'move') placing = null; placeBanner(); fillInputs(); syncPtPop(); }
function closePtPop() { ptOpen = false; ptPal = false; if (placing && typeof placing === 'object' && placing.kind !== 'move') placing = null; placeBanner(); fillInputs(); syncPtPop(); }
$('qPoint').addEventListener('click', () => { if (ptOpen) closePtPop(); else openPtPop(); });
$('ptAlt').addEventListener('click', () => { ptPal = false; placing = { kind: 'alt' }; placeBanner(); fillInputs(); syncPtPop(); });
$('ptFree').addEventListener('click', () => { ptPal = false; placing = { kind: 'free', color: ptColor }; placeBanner(); fillInputs(); syncPtPop(); });
$('ptZd').addEventListener('click', () => { ptPal = false; if (!sol || !sol.ok) { toast('Il faut d\'abord une trace (ZMT et PTU)'); return; } const P = isv().points, orph = P.find(d => d.kind === 'zd' && d.role === 'deb' && !P.some(f => f.kind === 'zd' && f.role === 'fin' && f.zid === d.zid)); /* v0.36.0 : un début sans fin → on pose sa fin */
  placing = orph ? { kind: 'zd', stage: 'fin', zid: orph.zid } : { kind: 'zd', stage: 'deb' }; if (orph) toast('Zone délicate sans fin : touche la trace à la FIN'); placeBanner(); fillInputs(); syncPtPop(); });
function addZd(p, what) { /* v0.27.0 : début puis fin d'une zone délicate, posés exactement sur la trace */
  if (!sol || !sol.ok) return; const q = Calc.nearestOn(sol.trace, p).pt, zid = what.zid || uid('z');
  const pt = { id: uid('q'), kind: 'zd', auto: 'ZD', role: what.stage, zid, name: 'ZD', lat: q.lat, lng: q.lng, color: C_ZD, elev: null, sig: traceSig() };
  isv().points.push(pt); pointElev(pt);
  if (what.stage === 'deb') { placing = { kind: 'zd', stage: 'fin', zid }; ptOpen = true; } 
  persist(); redraw(); placeBanner(); fillInputs(); syncPtPop();
}
/* un autre bouton de la colonne ferme le choix */
$('quick').addEventListener('click', e => { const b = e.target.closest('button');
  if (b && (b.id === 'qMeasure' || b.id === 'qCut') && (placing || ptOpen)) suspendPlacing(); /* v0.36.0 : la pose en cours attend la fin de la mesure / de la coupe */
  if (ptOpen && b && b.id !== 'qPoint') closePtPop(); }, true);
/* v0.36.0 (Henri, bloqué avec un ZD-DEB sans fin) : pendant une pose de point (n'importe laquelle), on peut faire une mesure 📏 et sa coupe ;
   en quittant la mesure et la coupe, on revient à la pose en cours (ex. la fin d'une zone délicate). */
function suspendPlacing() { if (suspended || !(placing || ptOpen)) return; suspended = { placing, ptOpen }; placing = null; ptOpen = false; ptPal = false; placeBanner(); syncPtPop(); fillInputs(); }
function resumePlacing() {
  if (!suspended || meas.active || !$('cutBox').classList.contains('hidden')) return;
  const s = suspended; suspended = null; placing = s.placing; ptOpen = s.ptOpen; placeBanner(); syncPtPop(); fillInputs(); toast('Retour à la pose du point en cours');
}
async function pointElev(pt) { /* v0.19.4 : tuiles d'altitude d'abord (même relief que la coupe), Open-Meteo en secours */
  let e = null; try { [e] = await elevTiles([pt]); } catch (er) {} if (typeof e !== 'number' || isNaN(e)) { try { [e] = await fetchElev([pt]); } catch (er) {} }
  if (typeof e === 'number' && !isNaN(e)) { pt.elev = Math.round(e); persist(); redraw(); fillInputs(); } }
async function addPoint(p, spec) {
  const auto = spec.kind === 'alt' ? altAutoName(p) : '';
  const n = await ask(spec.kind === 'alt' ? `Nom de la zone de posé alternative (l'écart de hauteur avec le sol de la ZMT est ajouté tout seul, P = plus haut, N = plus bas)${auto ? ` : « ${auto} » proposé d'après sa position, garde-le ou écris un autre nom` : ''} :` : 'Nom du point :', auto);
  if (n === null) return;
  const pt = { id: uid('q'), kind: spec.kind, name: String(n).trim(), nameAuto: !!auto && String(n).trim() === auto, lat: p.lat, lng: p.lng, color: spec.kind === 'alt' ? '#ff2020' : spec.color, elev: typeof p.z === 'number' ? Math.round(p.z) : null };
  isv().points.push(pt); persist(); redraw(); fillInputs(); if (pt.elev == null) pointElev(pt);
}
/* v0.20.0 (Henri) : point libre posé sur le point temporaire de la coupe → sommet « S » sans question de nom ;
   v0.21.0 : le point précédent de la trace prend « -MINI… » (traceMini), plus de point P */
/* v0.24.0 (Henri) : le sommet S n'est pas forcément sur la trace : c'est le point le plus haut du terrain dans un cercle de rayon
   = longueur du vecteur de largage (Henri : « ça multiplie par 2 la marge de sécu » ; fixe, pas dans Param.), centré sur le point de la trace choisi.
   Il s'affiche sur la coupe en projection perpendiculaire sur la trace ; le point de la trace précédent prend le -MINI. */
async function findSummit(c) {
  if (!sol || !sol.ok) return null;
  const R = map.distance(LL(sol.vec.green), LL(sol.vec.red)); if (!(R > 1)) return null;
  const st = Math.max(25, R / 25), pts = [], kLat = 111320, kLng = 111320 * Math.cos(c.lat * Math.PI / 180);
  for (let y = -R; y <= R + 1e-6; y += st) for (let x = -R; x <= R + 1e-6; x += st) if (x * x + y * y <= R * R) pts.push({ lat: c.lat + y / kLat, lng: c.lng + x / kLng });
  let el; try { el = await elevTiles(pts); } catch (e) { return null; }
  let b = -1; el.forEach((v, i) => { if (typeof v === 'number' && !isNaN(v) && (b < 0 || v > el[b])) b = i; });
  return b < 0 ? null : { lat: pts[b].lat, lng: pts[b].lng, z: el[b] };
}
async function placeSummit(S, p) { /* p = point choisi sur la trace (avec son altitude z si connue) → S au point le plus haut autour */
  const c = (sol && sol.ok && sol.trace.length > 1) ? Calc.nearestOn(sol.trace, p).pt : p;
  toast('Recherche du point le plus haut autour…');
  const hi = await findSummit(c);
  if (hi) { S.lat = hi.lat; S.lng = hi.lng; S.elev = Math.round(hi.z); }
  else { S.lat = c.lat; S.lng = c.lng; S.elev = typeof p.z === 'number' ? Math.round(p.z) : null; toast('Relief indisponible : sommet posé sur la trace'); }
  S.val = null; /* v0.25.1 (Henri) : un sommet déplacé GARDE son nombre de points remontés (S.back) — ne pas le remettre à 0 */ S.sig = traceSig(); persist(); redraw(); fillInputs(); syncSumWarn(); if (cutData) { drawCut(); cutText(cutData.cur); }
  if (S.elev == null) pointElev(S);
}
async function addSummit(p) {
  const S = { id: uid('q'), kind: 'free', auto: 'S', name: 'S', lat: p.lat, lng: p.lng, color: '#ffffff', elev: typeof p.z === 'number' ? Math.round(p.z) : null };
  isv().points.push(S); await placeSummit(S, p);
}
// Point déjà posé : nom (et couleur pour un point libre) modifiables, ou suppression
function delPoint(pt) { isv().points = isv().points.filter(x => x.id !== pt.id && x.sum !== pt.id && !(pt.zid && x.zid === pt.zid)); /* v0.27.0 : une zone délicate part avec ses deux points */ persist(); redraw(); fillInputs(); } /* v0.20.0 : supprimer un sommet S supprime son point de passage P */
function renderPtList() {
  const ul = $('ptList'); ul.innerHTML = '';
  if (!isv().points.length) { ul.innerHTML = '<li class="mut">Aucun point posé.</li>'; return; }
  isv().points.forEach(pt => {
    const li = document.createElement('li'), alt = pt.kind === 'alt';
    li.innerHTML = `<span class="pic${alt ? ' alt' : ''}" style="color:${alt ? '#ff2020' : (pt.color || '#fff')}">${alt ? '◎' : '◆'}</span><span class="zn">${esc(pointLabel(pt) || '(sans nom)')}<br><small class="mut">${alt ? 'Zone de posé alternative' : pt.kind === 'zd' ? 'Zone délicate' : pt.auto === 'S' ? 'Sommet' : 'Point libre'}</small></span>`;
    li.querySelector('.zn').onclick = () => { setSheetSize('mini'); map.setView(LL(pt), Math.max(map.getZoom(), 15)); };
    const ed = document.createElement('button'); ed.textContent = '✏️'; ed.title = 'Modifier'; ed.onclick = () => pointMenu(pt);
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Supprimer';
    del.onclick = async () => { if (!(await ask(`Supprimer « ${pointLabel(pt) || 'ce point'} » ?`))) return; delPoint(pt); };
    li.append(ed, del); ul.append(li);
  });
}
$('btnAddPt').addEventListener('click', async () => { if (!(await askZoneName())) return; openPtPop(); });
function pointMenu(pt) {
  $('peText').innerHTML = `<b>${pt.kind === 'alt' ? 'Zone de posé alternative' : pt.kind === 'zd' ? 'Zone délicate' : 'Point libre'}</b><br><small>${fmtPos(pt)}${typeof pt.elev === 'number' ? ' · ' + fmtInt(pt.elev) + ' m' : ''}</small>`;
  $('peName').value = ptName(pt); $('peName').readOnly = !!pt.auto; /* v0.20.0 : S et P nommés tout seuls, pas de renommage */
  const close = () => { $('ptEdit').classList.add('hidden'); $('peOk').onclick = $('peCancel').onclick = $('peDel').onclick = $('peMove').onclick = null; };
  $('peOk').onclick = () => { if (!pt.auto) { const v = $('peName').value.trim(); if (!(pt.nameAuto && v === ptName(pt))) { pt.name = v; pt.nameAuto = false; } } close(); persist(); redraw(); fillInputs(); };
  $('peMove').onclick = () => { if (!pt.auto) { const v = $('peName').value.trim(); if (!(pt.nameAuto && v === ptName(pt))) { pt.name = v; pt.nameAuto = false; } } close(); persist(); redraw();
    startPlacing({ kind: 'move', id: pt.id, name: pointLabel(pt) || (pt.kind === 'alt' ? 'zone de posé alternative' : 'point libre') }); };
  $('peCancel').onclick = close;
  $('peDel').onclick = async () => { close(); if (!(await ask(`Supprimer « ${pointLabel(pt) || 'ce point'} » ?`))) return; delPoint(pt); };
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
  setTimeout(resumePlacing, 0);
}
$('qMeasure').addEventListener('click', () => {
  if (meas.active) { stopMeasure(); return; }
  if (placing) suspendPlacing();
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
  if ((typeof WindPick !== 'undefined') && WindPick.onMapClick(e)) return; // point choisi pour le tableau des vents
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) { if (tempPt) setTempPt(null); return; } /* v0.19.0 : un appui sur la carte efface le point temporaire de la coupe */
  if (!current.id) { if (!namingZone) { namingZone = true; askZoneName().then(ok => { namingZone = false; if (ok) map.fire('click', e); }); } return; } // nom d'abord, puis le point
  const what = placing;
  /* v0.19.0 : un point posé tout près du point temporaire de la coupe ou d'un point de mesure se cale dessus (comme prepo-PA) */
  const sn = snapPlace({ lat: e.latlng.lat, lng: e.latlng.lng }), p = sn.p;
  if (sn.temp) setTempPt(null);
  placing = null; placeBanner();
  if (what === 'Z') setZmt(p); else if (what === 'P') setPtu(p);
  else if (what.kind === 'move') { const pt = isv().points.find(x => x.id === what.id); if (pt) { pt.lat = p.lat; pt.lng = p.lng; pt.elev = typeof p.z === 'number' ? Math.round(p.z) : null; if (pt.elev == null) pointElev(pt); persist(); redraw(); toast(`« ${what.name} » repositionné`); } }
  else { ptOpen = false; ptPal = false; if (what.kind === 'zd') addZd(p, what); else if (what.kind === 'free' && sn.temp) addSummit(p); else addPoint(p, what); }
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
const TABS = ['params', 'zones', 'isv', 'brief']; /* v0.13.0 : onglet Alti fondu dans Prépa ISV */
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
function vzRefNow() { const I = isv(), ids = I.team.map(p => p.canopy); const used = prm.canopies.filter(c => ids.includes(c.id)); return Math.min(...(used.length ? used : prm.canopies).map(c => Calc.canRef(c).vz)); } /* v0.31.0 : Vz ramenée à la référence */
function renderVol() {
  const I = isv(), ok = sol && sol.ok;
  setVal('v_fl', ok ? sol.fl : I.fl); setVal('v_ac', fmt1(+I.acMs)); setVal('v_acKt', Math.round(+I.acMs * KT)); setVal('v_tFall', fmt1(ok ? sol.tFall : +I.tFall)); { const e = $('v_flMin4'), f = ok && sol.flMin4 != null; e.classList.toggle('hidden', !f); if (f) { e.innerHTML = `FL minimal de largage pour la même ouverture terminée (${fmtInt(Math.round(sol.hOpen))} m) avec ${fmt1(+prm.tRef || 4)} s de chute (calculé) : <b>FL${String(sol.flMin4).padStart(3, '0')}</b> <button class="applyFl">Appliquer</button>`; e.querySelector('.applyFl').onclick = applyFlMin4; } } /* v0.35.0 */ setVal('v_hOpen', ok ? Math.round(sol.hOpen) : '');
  setVal('v_cap', ok ? String(magOf(sol.cap)).padStart(3, '0') : ''); setVal('v_acH', ok ? String(magOf(sol.acHeading)).padStart(3, '0') : '');
  $('v_capAuto').classList.toggle('on', I.capManual == null && !I.manual); $('v_acAuto').classList.toggle('on', I.vecHeading == null);
  const dSel = $('v_drop'), rSel = $('v_relax');
  if (document.activeElement !== dSel) dSel.innerHTML = `<option value="">Auto : ${esc(pName(Calc.defaultDropIdx(I.team.length)))}</option>` + I.team.map((p, i) => `<option value="${p.id}"${p.id === I.dropId ? ' selected' : ''}>${esc(pName(i))}</option>`).join('');
  if (document.activeElement !== rSel) rSel.innerHTML = `<option value="green"${I.relaxRef === 'green' ? ' selected' : ''}>Début de largage (vert)</option>` + I.team.map((p, i) => `<option value="${p.id}"${p.id === I.relaxRef ? ' selected' : ''}>${esc(pName(i))}</option>`).join('') + `<option value="red"${I.relaxRef === 'red' ? ' selected' : ''}>Fin de largage (rouge)</option>`;
  $('v_warn').innerHTML = ok ? (sol.warn ? `<b class="warn">⚠️ ${esc(sol.warn)}</b>` : '') : esc(sol && sol.err || '');
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
  rows.push(['Ouverture terminée', `${fmtInt(s.hOpen)} m au-dessus du sol de la ZMT`]);
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
onNum('v_acKt', v => { isv().acMs = Math.round(v / KT * 100) / 100; }, 40, 400); /* v0.14.0 : saisie en KIAS, convertie en m/s badin */
onNum('v_tFall', v => { isv().tFall = v; }, 0, 120);
$('v_hOpen').addEventListener('change', e => {
  const v = numIn(e.target), I = isv(); if (!sol || !sol.ok || isNaN(v)) { fillInputs(); return; }
  const drop = sol.hRel - v; if (drop < 1 || v <= I.hPtu + 50) { toast('Hauteur d\'ouverture terminée impossible avec ce FL'); fillInputs(); return; }
  I.tFall = Calc.tFallFor(drop, sol.tas, Math.max(10, +prm.vff), openLossNow(), vzRefNow(), false, Calc.ffK(F, I.ptu, sol.altRel)); changed();
});
function setCap(m) { const I = isv();
  /* v0.29.0 (Henri) : le vecteur déplacé à la main est prioritaire — on ne le remet plus en automatique : il tourne autour du PTU
     (même distance) jusqu'à donner le cap para voulu (la trace est droite de l'OUV au PTU, donc tourner l'ensemble autour du PTU
     tourne le cap d'autant ; 4 passes pour la dérive en chute qui change un peu) */
  if (I.manual && I.ptu && sol && sol.ok) {
    /* le cap para est celui que vole le para (pas la route au sol) : la relation n'est pas simple avec le vent → recherche
       numérique (sécante) de l'angle de rotation du vecteur autour du PTU qui donne le cap voulu */
    const want = trueOf(n360(m)), base = I.manual, q0 = Calc.toLocal(I.ptu, base);
    const at = th => { const r = th * Math.PI / 180; I.manual = clampToCircle(Calc.fromLocal(I.ptu, { x: q0.x * Math.cos(r) + q0.y * Math.sin(r), y: -q0.x * Math.sin(r) + q0.y * Math.cos(r) })); compute(); return sol && sol.ok ? ((sol.cap - want + 540) % 360) - 180 : NaN; };
    let t0 = 0, f0 = ((sol.cap - want + 540) % 360) - 180, t1 = -f0 || 1, f1 = at(t1), best = { t: 0, f: Math.abs(f0) };
    for (let it = 0; it < 8 && isFinite(f1); it++) {
      if (Math.abs(f1) < best.f) best = { t: t1, f: Math.abs(f1) }; if (Math.abs(f1) < 0.02 || f1 === f0) break;
      const t2 = Math.max(-60, Math.min(60, t1 - f1 * (t1 - t0) / (f1 - f0))); t0 = t1; f0 = f1; t1 = t2; f1 = at(t1);
    }
    if (isFinite(f1) && Math.abs(f1) < best.f) best = { t: t1, f: Math.abs(f1) };
    at(best.t); if (best.f > 0.5) toast('Cap para impossible à obtenir exactement en gardant le vecteur à la main : le plus proche est gardé');
    changed(); return;
  }
  I.capManual = trueOf(n360(m)); I.manual = null; changed(); }
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

// ---------- Onglet Briefing (v0.12.0 ; v0.13.0 : ordre et contenu revus par Henri) : lecture seule ----------
const C_GREEN_DOT = '#1ec83c', C_RED_DOT = '#ff3b30';
function renderBrief() {
  if (window._stepsReady) briefSteps();
  const box = $('briefBody'), I = isv(), s = sol, ok = s && s.ok, out = [];
  const sec = t => out.push(`<h3>${t}</h3><table class="vals"><tbody>`), end = () => out.push('</tbody></table>');
  const row = (k, v, hi) => out.push(`<tr${hi ? ' class="hi"' : ''}><td>${k}</td><td>${v}</td></tr>`);
  const pname = i => I.team[i] && I.team[i].name ? esc(I.team[i].name) : `n° ${i + 1}`;
  sec('Saut');
  { const ze = zmtElev(), e0 = elev0(); /* v0.14.0 : coordonnées et sol de la ZMT avec le nom de la zone (plus de paragraphe Arrivée) */
    row('Zone', `${esc(current.id ? current.name : 'Nouvelle zone')}${current.zmt ? ` (${fmtPos(current.zmt)} · ${fmtInt(e0)} m${ze == null ? ' provisoire' : ''})` : ''}`); }
  row('ISV', esc(I.name));
  row('Date et heure', fmtWhenY(current.when));
  row('Météo', wxRec ? `${esc(wxRec.model.split(' (')[0])}, prévision du ${fmtFetched(wxRec.fetched)}` : '<b class="warn">aucune prévision : calcul sans vent</b>');
  if (zeroWind) row('', '<b class="warn">ESSAI VENT 0</b>');
  if (current.zmt && F) { const w = Calc.spdDir(Calc.windAt(F, current.zmt.lat, current.zmt.lng, elev0() + 10)); row('Vent au sol (ZMT)', `${Math.round(w.spd * KT)} kt du ${hdg(w.dir)}`); }
  end();
  if (!ok) { out.push(`<p class="hint">${esc(s && s.err ? s.err : 'Place la ZMT (onglet Zones) puis le PTU (onglet Prépa ISV).')}</p>`); box.innerHTML = out.join(''); return; }
  if (s.warn) out.push(`<p class="hint"><b class="warn">⚠️ ${esc(s.warn)}</b></p>`);
  sec(`Équipe (${I.team.length})`);
  I.team.forEach((p, i) => { const c = prm.canopies.find(q => q.id === p.canopy) || prm.canopies[0];
    row(`${i + 1}. ${esc(p.name || 'Para ' + (i + 1))}${i === s.dropIdx ? ' · sur le point de largage' : ''}`, `${esc(c.name)} · ${fmtInt(+p.mte || MTE_DEF)} kg · sortie vert +${fmt1(s.ex.te[i])} s`); });
  end();
  const av = altiVals();
  out.push('<div class="paraBox">'); /* v0.37.1 (Henri) : paragraphe Consignes para encadré en rouge */
  sec('Consignes para');
  row('OSO', av && av.max ? `${av.oso} hPa` : 'non calculé');
  row('ALPHA', av ? `${av.alpha} hPa` : '–');
  row('Prise de cap', s.turn ? `à ${s.turn}` : 'dans l\'axe', true);
  row('CDO', s.openLowered ? `${fmtInt(Math.round(s.hCmd))} m` : `${fmt1(s.tFall)} s`, true);
  row('Cap para', hdg(s.cap), true);
  row('Hauteur d\'arrivée au PTU', `${fmtInt(I.hPtu)} m au-dessus du sol de la ZMT`); /* v0.18.1 : en blanc (Henri) */
  row('PTU', s.hand ? `main ${s.hand}` : 'dans l\'axe', true);
  end(); out.push('</div>');
  sec('Largage');
  row('FL de largage', `FL${s.fl}`, true);
  if (s.flMin4 != null) row(`FL pour ${fmt1(+prm.tRef || 4)} s de chute`, `FL${String(s.flMin4).padStart(3, '0')} (même ouverture terminée, ${fmtInt(Math.round(s.hOpen))} m) <button class="applyFl">Appliquer</button>`); /* v0.37.0 / v0.38.0 (Henri) */
  row('Hauteur au-dessus de la ZMT', `${fmtInt(s.hRel)} m`);
  row('Hauteur au-dessus du point haut', av && av.max ? `${fmtInt(av.hRel)} m` : 'non calculé');
  row('Cap avion au largage', hdg(s.acHeading), true);
  row('Point de relaxation', fmtPos(s.relax.pt), true);
  row('Créneau de largage', `${sgn(s.relax.before, false)} / ${sgn(s.relax.after, true)}`, true);
  row('Vecteur de largage', `${fmtInt(s.vec.length)} m · ${fmt1(s.ex.total)} s`);
  row('Vent au largage', `${Math.round(s.windRel.spd * KT)} kt du ${hdg(s.windRel.dir)}`);
  { /* v0.13.1 (Henri) : « (4s) · 3s · 3s · 3s · (10s) », marges de sécurité entre parenthèses */
    const sx = v => `${fmt1(v)}s`, parts = [`(${sx(+I.tGreen)})`].concat(I.team.slice(1).map(p => sx(+p.dt))).concat([`(${sx(+I.tRed)})`]);
    row('Sorties', `<span style="color:${C_GREEN_DOT}">•</span> ${parts.join(' · ')} <span style="color:${C_RED_DOT}">•</span>`); }
  row('Vitesse de largage', `${fmt1(+I.acMs)} m/s badin (${Math.round(I.acMs * KT)} KIAS) = ${Math.round(s.tas * KT)} kt vraie`);
  row('Vitesse sol de l\'avion', `${Math.round(s.vg * KT)} kt (${Math.round(s.vg)} m/s)`);
  end();
  sec('Chute et ouverture');
  row('Hauteur d\'ouverture', `${fmtInt(Math.round(s.hCmd))} m`); /* v0.18.0 : hauteur où le para tire ; arrondie à la centaine seulement si c'est la CDO (ouverture abaissée), exacte à 4 s */ /* v0.14.0 : temps de chute retiré (déjà dans la CDO) */
  row('Ouverture terminée, au-dessus de la ZMT', `${fmtInt(s.hOpen)} m`);
  row('Ouverture terminée, au-dessus du point haut', av && av.max ? `${fmtInt(s.elev0 + s.hOpen - av.max.elev)} m` : 'non calculé');
  row('Perte de hauteur à l\'ouverture', `${fmtInt(s.openDrop)} m`);
  row('Dérive sous RSE', `${fmtInt(s.rseLen)} m`);
  row('Zone de sécurité', `${fmtInt(I.secLong)} m avant / après le vecteur, ${fmtInt(I.secLat)} m de côté, prolongée le long de la dérive sous RSE jusqu'à 1013,25 hPa`);
  end();
  sec('Navigation sous voile');
  row('Trace', fmtKm(s.length));
  row('Distance en ligne droite', fmtKm(s.direct), true);
  row('Temps sous voile', fmtMin(s.own.tCanopy));
  if (s.own.t180 != null) row('Passage du FL180, depuis le vert', fmtMin(s.own.t180), true);
  if (s.own.t120 != null) row('Passage du FL120, depuis le vert', fmtMin(s.own.t120), true);
  { const w = s.weak, i = w.idx >= 0 ? w.idx : 0, nm = I.team[i] && I.team[i].name;
    row('Para le moins performant', nm ? `${esc(nm)} (${esc(w.canopy.name)}, n° ${i + 1})` : `n° ${i + 1} (${esc(w.canopy.name)})`); }
  row('Marge sur le vent', `${prm.margin} %`);
  end();
  if (I.points.length) {
    sec('Points de l\'ISV');
    I.points.forEach(pt => out.push(`<tr><td>${esc(pointLabel(pt) || (pt.kind === 'alt' ? 'Zone de posé alternative' : 'Point'))}</td><td><button class="seept" data-id="${pt.id}">🗺 Voir sur la carte</button></td></tr>`));
    end();
  }
  box.innerHTML = out.join(''); box.querySelectorAll('.applyFl').forEach(b => b.onclick = applyFlMin4);
  box.querySelectorAll('.seept').forEach(b => b.onclick = () => { const pt = isv().points.find(x => x.id === b.dataset.id); if (pt) seePoint(pt); });
}
/* « Voir sur la carte » (v0.13.1, Henri) : le point n'est pas forcément centré, il doit juste être à l'écran avec :
   - s'il est près des points gris / jaunes (dans le cercle centré sur les points gris et passant par le point de largage) :
     les points gris, les points jaunes et le vecteur de largage ;
   - sinon : la trace la plus proche. */
function nearDrop(pt) {
  const low = lowPoints(); if (!sol || !sol.ok || !low || !low.length) return false;
  const c = { lat: low.reduce((a, q) => a + q.lat, 0) / low.length, lng: low.reduce((a, q) => a + q.lng, 0) / low.length };
  const dp = sol.vec.exits[sol.dropIdx] || sol.vec.attach;
  return map.distance(LL(c), LL(pt)) <= map.distance(LL(c), LL(dp));
}
function seePoint(pt) {
  const pts = [pt];
  if (sol && sol.ok) {
    if (nearDrop(pt)) { pts.push(sol.vec.green, sol.vec.red); (lowPoints() || []).forEach(q => pts.push(q)); (greyPoints() || []).forEach(q => pts.push(q)); }
    else if (sol.trace.length > 1) pts.push(Calc.nearestOn(sol.trace, pt).pt);
  }
  closeSheet(); map.invalidateSize({ animate: false }); fitBox(pts);
}
function fitBox(pts) {
  const R0 = freeRects()[0], R = { l: R0.l, r: R0.r - 50, t: R0.t, b: R0.b }, pad = 50; /* 50 px de plus à droite : les noms des points sont écrits à droite */
  for (let k = 0; k < 3; k++) {
    const P = pts.map(q => map.latLngToContainerPoint(LL(q)));
    const x0 = Math.min(...P.map(q => q.x)), x1 = Math.max(...P.map(q => q.x)), y0 = Math.min(...P.map(q => q.y)), y1 = Math.max(...P.map(q => q.y));
    const kk = Math.min((R.r - R.l - 2 * pad) / Math.max(1, x1 - x0), (R.b - R.t - 2 * pad) / Math.max(1, y1 - y0));
    const z = Math.min(17, Math.floor((map.getZoom() + Math.log2(kk)) * 20) / 20);
    map.setView(map.containerPointToLatLng([(x0 + x1) / 2, (y0 + y1) / 2]), z, { animate: false });
  }
  const P = pts.map(q => map.latLngToContainerPoint(LL(q)));
  const cx = (Math.min(...P.map(q => q.x)) + Math.max(...P.map(q => q.x))) / 2, cy = (Math.min(...P.map(q => q.y)) + Math.max(...P.map(q => q.y))) / 2;
  map.panBy([cx - (R.l + R.r) / 2, cy - (R.t + R.b) / 2], { animate: false });
  redraw();
}

/* v0.13.0 (Henri) : appui sur le cadre Cap avion / Cap para → onglet Prépa ISV, paragraphe Données de vol */
$('capInfo').addEventListener('click', () => {
  openSheet('isv');
  /* v0.17.1 : position calculée depuis l'ancre #a_vol (pas collante) : si l'on avait déjà défilé, le titre « Données de vol »
     était collé en haut et sa position ne disait plus rien → rien ne bougeait */
  requestAnimationFrame(() => { const s = $('sheet'), a = $('a_vol'), h = a.nextElementSibling, t = s.querySelector('.tabs');
    const natural = a.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(h).marginTop) || 0);
    s.scrollTop += natural - t.getBoundingClientRect().bottom; });
});
// ---------- Coupe (v0.19.0, demande d'Henri) ----------
/* Bouton « Coupe » : fenêtre avec la coupe verticale le long de la trace (OUV → PTU : trace + terrain dessous), ou, si une
   mesure 📏 est affichée (deux points), le long de la mesure (terrain seul). Curseur au doigt ; un appui bref = retour à la
   carte centrée sur ce point, avec un point temporaire (effacé par un appui sur la carte ; un point posé tout près s'y cale). */
let tempPt = null, tempMk = null, cutData = null;
const tempIcon = L.divIcon({ className: 'tmppt', iconSize: [22, 22], iconAnchor: [11, 11], html: '<span></span>' });
function setTempPt(q) {
  tempPt = q ? { lat: q.lat, lng: q.lng, z: q.z } : null;
  if (tempMk) { map.removeLayer(tempMk); tempMk = null; }
  if (tempPt) tempMk = L.marker(LL(tempPt), { icon: tempIcon, interactive: false, zIndexOffset: 950 }).addTo(map);
}
function snapPlace(q) {
  const P = map.latLngToContainerPoint(LL(q)); let best = { p: q, temp: false }, bd = 22;
  const cand = [];
  if (tempPt) cand.push([tempPt, true]);
  if (meas.a) cand.push([meas.a, false]); if (meas.b) cand.push([meas.b, false]);
  cand.forEach(([c, t]) => { const d = P.distanceTo(map.latLngToContainerPoint(LL(c))); if (d < bd) { bd = d; best = { p: { lat: c.lat, lng: c.lng, z: t ? c.z : undefined }, temp: t }; } });
  return best;
}
function cutPath() { /* tracé de la coupe : polyligne (trace OUV → PTU avec ses hauteurs, ou les deux bouts de la mesure) */
  const line = [];
  if (meas.a && meas.b) line.push({ lat: meas.a.lat, lng: meas.a.lng, h: null }, { lat: meas.b.lat, lng: meas.b.lng, h: null });
  else if (sol && sol.ok && sol.trace.length > 1) sol.trace.forEach(q => line.push({ lat: q.lat, lng: q.lng, h: q.h }));
  else return null;
  const seg = []; let tot = 0;
  for (let i = 1; i < line.length; i++) { const L0 = map.distance(LL(line[i - 1]), LL(line[i])); seg.push(L0); tot += L0; }
  return { line, seg, tot, mode: meas.a && meas.b ? 'meas' : 'trace' };
}
function cutAt(c, D) { /* point du tracé à la distance D (m) depuis le début */
  let d = Math.max(0, Math.min(c.tot, D)), i = 0; while (i < c.seg.length - 1 && d > c.seg[i]) { d -= c.seg[i]; i++; }
  const f = c.seg[i] ? Math.min(1, d / c.seg[i]) : 0, a = c.line[i], b = c.line[i + 1];
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, d: Math.max(0, Math.min(c.tot, D)), h: a.h == null ? null : a.h + (b.h - a.h) * f };
}
async function cutSample(c, d0, d1, N) { /* N+1 échantillons entre d0 et d1, avec l'altitude du terrain */
  const pts = []; for (let k = 0; k <= N; k++) pts.push(cutAt(c, d0 + (d1 - d0) * k / N));
  let el = null;
  try { el = await elevTiles(pts); } catch (e) { try { const sub = pts.filter((q, i) => i % 3 === 0 || i === pts.length - 1); const e2 = await fetchElev(sub); el = pts.map((q, i) => e2[Math.min(sub.length - 1, Math.round(i / 3))]); } catch (e3) {} }
  if (!el || el.some(v => typeof v !== 'number' || isNaN(v))) return null;
  pts.forEach((q, i) => { q.z = el[i]; }); return pts;
}
async function openCut() {
  setTempPt(null); closeSheet();
  const c = cutPath();
  if (!c) return toast('Pas encore de trace : place la ZMT et le PTU, ou fais une mesure 📏');
  $('cutBox').classList.remove('hidden'); $('qCut').classList.add('on');
  $('cutTitle').textContent = c.mode === 'meas' ? 'Coupe le long de la mesure' : 'Coupe le long de la trace (OUV → PTU)';
  $('cutInfo').textContent = 'Relevé du terrain…'; cutData = null; drawCut();
  const pts = await cutSample(c, 0, c.tot, 300);
  if ($('cutBox').classList.contains('hidden')) return;
  if (!pts) { $('cutInfo').textContent = 'Terrain impossible à relever (réseau ?).'; return; }
  c.full = pts; c.pts = pts; c.v0 = 0; c.v1 = c.tot; c.e0 = elev0(); c.cur = null; cutData = c; drawCut(); cutText(null);
}
function closeCut() { $('cutBox').classList.add('hidden'); $('qCut').classList.remove('on'); cutData = null; setTimeout(resumePlacing, 0); }
/* v0.19.1 : zoom sur la coupe (pincement à deux doigts, pincement du trackpad, molette avec Ctrl, boutons － / ＋ / ⤢) ;
   la hauteur s'ajuste à la partie visible et le terrain est relevé finement pour cette partie */
let cutResT = 0;
function cutView(v0, v1) {
  const c = cutData; if (!c) return;
  const span = Math.max(Math.min(200, c.tot), Math.min(c.tot, v1 - v0)), mid = (v0 + v1) / 2;
  let a = mid - span / 2, b = mid + span / 2; if (a < 0) { b -= a; a = 0; } if (b > c.tot) { a -= b - c.tot; b = c.tot; } a = Math.max(0, a);
  c.v0 = a; c.v1 = b; c.cur = null; c.lock = false; c.pts = c.pts.filter(q => q.d >= a && q.d <= b);
  if (c.pts.length < 2) c.pts = [cutAt(c, a), cutAt(c, b)].map(q => Object.assign(q, { z: nearestZ(c, q.d) }));
  drawCut(); cutText(null);
  clearTimeout(cutResT); cutResT = setTimeout(async () => { const k = c.v0 + '|' + c.v1; const pts = await cutSample(c, c.v0, c.v1, 300); if (pts && cutData === c && k === c.v0 + '|' + c.v1) { c.pts = pts; drawCut(); } }, 180);
}
function nearestZ(c, d) { let best = c.full[0]; c.full.forEach(q => { if (Math.abs(q.d - d) < Math.abs(best.d - d)) best = q; }); return best.z; }
function cutZoomAt(f, dAt) { const c = cutData; if (!c) return; const s = (c.v1 - c.v0) / f; const r = (dAt - c.v0) / (c.v1 - c.v0); cutView(dAt - s * r, dAt - s * r + s); }
function cutGeom() {
  const cv = $('cutCv'), W = cv.clientWidth, H = cv.clientHeight, c = cutData, pad = { l: 46, r: 8, t: 10, b: 22 };
  let lo = Infinity, hi = -Infinity;
  c.pts.forEach(q => { const t = q.z - c.e0; lo = Math.min(lo, t); hi = Math.max(hi, t); if (q.h != null) { lo = Math.min(lo, q.h); hi = Math.max(hi, q.h); } });
  const zoomed = c.v1 - c.v0 < c.tot - 1, m = Math.max(20, (hi - lo) * 0.12);
  if (c.mode === 'meas' || zoomed) { lo -= m; hi += m; } else { lo = Math.min(lo, 0) - 50; hi += 200; }
  const sp = c.v1 - c.v0;
  return { W, H, pad, lo, hi, X: d => pad.l + (W - pad.l - pad.r) * (d - c.v0) / sp, D: x => c.v0 + (x - pad.l) / (W - pad.l - pad.r) * sp, Y: v => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo)) };
}
function niceStep(r, n) { const s = r / n, p10 = Math.pow(10, Math.floor(Math.log10(s))), m = s / p10; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10; }
function drawCut() {
  const cv = $('cutCv'), dpr = window.devicePixelRatio || 1; cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
  const c = cutData; $('cutReset').classList.toggle('hidden', !c || c.v1 - c.v0 >= c.tot - 1); if (!c) return;
  const G = cutGeom(), { X, Y, W, H, pad } = G;
  g.font = '10px -apple-system,system-ui,sans-serif'; g.fillStyle = '#999'; g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  const sy = niceStep(G.hi - G.lo, 4); for (let v = Math.ceil(G.lo / sy) * sy; v <= G.hi; v += sy) { const y = Y(v); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.textAlign = 'right'; g.fillText(fmtInt(Math.round(v) || 0) + ' m', pad.l - 4, y + 3); }
  const spanKm = (c.v1 - c.v0) / 1000, sx = niceStep(spanKm, 5), dec = sx < 0.1 ? 2 : sx < 1 ? 1 : 0; g.textAlign = 'center';
  for (let v = Math.ceil(c.v0 / 1000 / sx) * sx; v <= c.v1 / 1000 + 1e-9; v += sx) g.fillText(v.toFixed(dec).replace('.', ',') + ' km', X(v * 1000), H - 6);
  g.save(); g.beginPath(); g.rect(pad.l, 0, W - pad.l - pad.r, H - pad.b + 2); g.clip();
  /* terrain */
  g.beginPath(); g.moveTo(X(c.pts[0].d), Y(G.lo)); c.pts.forEach(q => g.lineTo(X(q.d), Y(q.z - c.e0))); g.lineTo(X(c.pts[c.pts.length - 1].d), Y(G.lo)); g.closePath();
  g.fillStyle = 'rgba(160,110,60,.55)'; g.fill(); g.strokeStyle = '#d9a066'; g.lineWidth = 1.5;
  g.beginPath(); c.pts.forEach((q, i) => { const x = X(q.d), y = Y(q.z - c.e0); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
  /* trace */
  if (c.mode === 'trace') { g.strokeStyle = '#ff3fb4'; g.lineWidth = 2.2; g.beginPath(); c.pts.forEach((q, i) => { const x = X(q.d), y = Y(q.h); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    /* v0.23.0 (Henri) : tous les points ronds de la trace (de 500 en 500) sur la coupe : roses, blancs s'ils portent un -MINI (orange si à revérifier) */
    const PB = probSet(); { let L0 = 0; const T = sol.trace; for (let i = 1; i < T.length; i++) L0 += map.distance(LL(T[i - 1]), LL(T[i])); /* v0.27.0 : zones délicates en bande violette */
      zdPairs().forEach(z => { const a = Calc.nearestOn(T, z.d).s * c.tot / Math.max(1, L0), b = Calc.nearestOn(T, z.f).s * c.tot / Math.max(1, L0), x0 = X(Math.min(a, b)), x1 = X(Math.max(a, b));
        const zc = sStale(z.d) || sStale(z.f) || PB.ids.has(z.d.zid) ? C_WARN : C_ZD; g.fillStyle = zc === C_ZD ? 'rgba(179,136,255,.18)' : 'rgba(255,140,0,.16)'; g.fillRect(x0, pad.t, x1 - x0, H - pad.b - pad.t); g.strokeStyle = zc; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x0, pad.t); g.lineTo(x0, H - pad.b); g.moveTo(x1, pad.t); g.lineTo(x1, H - pad.b); g.stroke(); g.setLineDash([]);
        g.font = 'bold 10px -apple-system,system-ui,sans-serif'; g.fillStyle = zc; g.textAlign = 'center'; g.fillText(pointLabel(z.d).replace('-DEB', ''), (x0 + x1) / 2, pad.t + 11); g.font = '10px -apple-system,system-ui,sans-serif'; }); }
    const MI = traceMini(); { let dv = 0; c.line.forEach((v, i) => { if (i) dv += c.seg[i - 1]; if (dv < c.v0 - 1 || dv > c.v1 + 1) return;
      g.fillStyle = MI[i] != null ? (MI.stale[i] || PB.ks.has(i) ? C_WARN : C_ZD) : '#ff3fb4'; g.strokeStyle = '#111'; g.lineWidth = 1.2; g.beginPath(); g.arc(X(dv), Y(v.h), MI[i] != null ? 4.5 : 3.2, 0, 7); g.fill(); g.stroke(); }); }
    /* v0.20.0 : sommets S et points de passage en blanc sur la trace, avec leur nom */
    const cutMarks = isv().points.filter(q => q.auto === 'S').map(q => ({ q, t: pointLabel(q), below: true, warn: sStale(q) || PB.ids.has(q.id) }))
      .concat(sol.trace.map((v, i) => MI[i] != null ? { q: v, t: String(Math.round(v.h)) + miniTag(MI, i), below: false, warn: !!MI.stale[i] || PB.ks.has(i) } : null).filter(Boolean)); /* v0.21.0 : S sous la trace, points « -MINI » de la trace au-dessus */
    cutMarks.forEach(({ q, t, below, warn }) => { const isS = q.auto === 'S'; let d = cutDOf(q), h = Calc.nearestOn(sol.trace, q).h;
      if (c.dragS && c.dragS.S === q) { const j = cutNear(c.dragS.d); d = c.dragS.d; h = cutAt(c, d).h; warn = false; if (c.pts[j]) t = 'S-' + Math.round(h + c.e0 - c.pts[j].z); } /* v0.23.0 : sommet en cours de déplacement sur la coupe */
      if (d < c.v0 - 1 || d > c.v1 + 1) return; const x = X(d), y = Y(h);
      g.fillStyle = warn ? C_WARN : C_ZD; g.strokeStyle = '#111'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 4.5, 0, 7); /* v0.28.0 : sommets en violet */ g.fill(); g.stroke();
      g.font = 'bold 11px -apple-system,system-ui,sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; const ty = below ? y + 17 : y - 9; g.strokeText(t, x, ty); g.fillText(t, x, ty); g.font = '10px -apple-system,system-ui,sans-serif'; });
    g.fillStyle = '#ff3fb4'; if (c.v0 < 1) { g.textAlign = 'left'; g.fillText('OUV', X(0) + 3, Y(c.pts[0].h) - 4); } if (c.v1 > c.tot - 1) { g.textAlign = 'right'; g.fillText('PTU', X(c.tot) - 3, Y(c.pts[c.pts.length - 1].h) - 4); } }
  /* curseur */
  cutPin(c.lock && c.cur != null && c.pts[c.cur] ? X(c.pts[c.cur].d) : null);
  if (c.cur != null && c.pts[c.cur]) { const q = c.pts[c.cur], x = X(q.d); g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, H - pad.b); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, Y(q.z - c.e0), 3.5, 0, 7); g.fill(); if (q.h != null) { g.fillStyle = '#ff3fb4'; g.beginPath(); g.arc(x, Y(q.h), 4, 0, 7); g.fill(); } }
  g.restore();
}
/* v0.19.2 (Henri) : doigt levé → bouton punaise blanche en haut du pointillé ; un appui dessus montre l'endroit sur la carte */
function cutPin(x) {
  const b = $('cutPin'), s = $('cutAddS'), cv = $('cutCv'); if (x == null) { b.classList.add('hidden'); s.classList.add('hidden'); return; }
  b.classList.remove('hidden'); b.style.left = `${Math.round(cv.offsetLeft + x - b.offsetWidth / 2)}px`; b.style.top = `${Math.round(cv.offsetTop - 2)}px`;
  /* v0.23.0 (Henri) : bouton « +S » sous la punaise : ajoute un sommet S à cet endroit de la trace, sans quitter la coupe */
  s.classList.toggle('hidden', !cutData || cutData.mode !== 'trace');
  s.style.left = `${Math.round(cv.offsetLeft + x - s.offsetWidth / 2)}px`; s.style.top = `${Math.round(cv.offsetTop + 38)}px`;
}
function cutAddS() { const c = cutData; if (!c || c.mode !== 'trace' || c.cur == null || !c.pts[c.cur]) return; const q = c.pts[c.cur];
  addSummit({ lat: q.lat, lng: q.lng, z: q.z }); }
function cutGo() { const c = cutData; if (!c || c.cur == null || !c.pts[c.cur]) return; const q = c.pts[c.cur]; closeCut(); setTempPt(q); map.setView(LL(q), Math.max(map.getZoom(), 14)); }
function cutText(i) {
  const c = cutData; if (!c) return;
  if (i == null || !c.pts[i]) { /* résumé sur toute la coupe : plus faible hauteur au-dessus du terrain (trace) ou point le plus haut (mesure) */
    if (c.mode === 'trace') { let m = null; c.full.forEach(q => { const v = q.h + c.e0 - q.z; if (!m || v < m.v) m = { v, d: q.d }; });
      $('cutInfo').innerHTML = `Hauteur mini au-dessus du terrain : <b>${fmtInt(m.v)} m</b> à ${fmtKm(m.d)} de l'OUV. Doigt sur la coupe pour lire ; doigt levé, la punaise en haut du trait montre l'endroit sur la carte ; pincer pour zoomer.`; }
    else { let m = null; c.full.forEach(q => { if (!m || q.z > m.z) m = q; }); $('cutInfo').innerHTML = `Point le plus haut : <b>${fmtInt(m.z)} m</b> d'altitude à ${fmtDist(m.d)} du 1er point. Doigt sur la coupe, puis la punaise en haut du trait pour voir l'endroit sur la carte ; pincer pour zoomer.`; }
    return;
  }
  const q = c.pts[i];
  $('cutInfo').innerHTML = c.mode === 'trace'
    ? `À ${fmtKm(q.d)} de l'OUV : <b>hauteur terrain ${fmtInt(q.h + c.e0 - q.z)} m</b> · hauteur alti ${fmtInt(q.h)} m · altitude terrain ${fmtInt(q.z)} m` /* v0.19.3 (Henri) : hauteur alti = lue à l'altimètre calé sur le sol de la ZMT */
    : `À ${fmtDist(q.d)} du 1er point : terrain <b>${fmtInt(q.z)} m</b> d'altitude (${fmtInt(q.z - c.e0)} m par rapport à la ZMT)`;
}
/* v0.23.0 (Henri) : déplacer un sommet S le long de la coupe (le prendre, glisser, relâcher = nouvelle place) */
function cutDOf(q) { const c = cutData, T = sol.trace; let L0 = 0; for (let i = 1; i < T.length; i++) L0 += map.distance(LL(T[i - 1]), LL(T[i])); return Calc.nearestOn(T, q).s * c.tot / Math.max(1, L0); }
function cutNear(d) { const c = cutData; let bi = 0; c.pts.forEach((q, i) => { if (Math.abs(q.d - d) < Math.abs(c.pts[bi].d - d)) bi = i; }); return bi; }
function cutHitS(clientX, clientY) {
  const c = cutData; if (!c || c.mode !== 'trace' || !sol || !sol.ok) return null;
  const r = $('cutCv').getBoundingClientRect(), G = cutGeom(), x = clientX - r.left, y = clientY - r.top; let best = null, bd = 20;
  isv().points.forEach(S => { if (S.auto !== 'S') return; const d = cutDOf(S), h = Calc.nearestOn(sol.trace, S).h, dd = Math.hypot(G.X(d) - x, G.Y(h) - y); if (dd < bd) { bd = dd; best = { S, d }; } });
  return best;
}
function cutIndex(clientX) { const c = cutData; if (!c) return null; const r = $('cutCv').getBoundingClientRect(), G = cutGeom(), d = G.D(clientX - r.left);
  let bi = 0; c.pts.forEach((q, i) => { if (Math.abs(q.d - d) < Math.abs(c.pts[bi].d - d)) bi = i; }); return bi; }
(function () {
  const cv = $('cutCv'), ptr = new Map(); let down = null, pinch = null;
  const dAt = clientX => { const r = cv.getBoundingClientRect(); return cutGeom().D(clientX - r.left); };
  cv.addEventListener('pointerdown', e => {
    if (!cutData) return; ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { cv.setPointerCapture(e.pointerId); } catch (er) {}
    if (ptr.size === 2) { const [p1, p2] = [...ptr.values()]; pinch = { dist: Math.abs(p1.x - p2.x) || 1, mid: (p1.x + p2.x) / 2, v0: cutData.v0, v1: cutData.v1 }; down = null; return; }
    const hit = cutHitS(e.clientX, e.clientY); if (hit) { cutData.dragS = hit; down = null; cutData.lock = false; cutData.cur = cutNear(hit.d); drawCut(); cutText(cutData.cur); return; }
    down = { x: e.clientX, y: e.clientY, t: Date.now() }; cutData.lock = false; const i = cutIndex(e.clientX); if (i != null) { cutData.cur = i; drawCut(); cutText(i); }
  });
  cv.addEventListener('pointermove', e => {
    if (!cutData) return; if (ptr.has(e.pointerId)) ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptr.size >= 2) { /* pincer : écarter = zoomer, autour du milieu des deux doigts ; glisser à deux doigts = se déplacer */
      const [p1, p2] = [...ptr.values()], dist = Math.abs(p1.x - p2.x) || 1, mid = (p1.x + p2.x) / 2, r = cv.getBoundingClientRect(), G = cutGeom(), w = G.W - G.pad.l - G.pad.r;
      const span = (pinch.v1 - pinch.v0) * pinch.dist / dist, fr = (pinch.mid - r.left - G.pad.l) / w, dMid = pinch.v0 + fr * (pinch.v1 - pinch.v0);
      const fr2 = (mid - r.left - G.pad.l) / w, a = dMid - fr2 * span; cutView(a, a + span); return;
    }
    if (cutData.dragS) { const d = Math.max(0, Math.min(cutData.tot, dAt(e.clientX))); cutData.dragS.d = d; cutData.cur = cutNear(d); drawCut(); cutText(cutData.cur); return; }
    if (!down && (e.pointerType !== 'mouse' || cutData.lock)) return; const i = cutIndex(e.clientX); if (i != null && i !== cutData.cur) { cutData.cur = i; drawCut(); cutText(i); }
  });
  const end = e => {
    ptr.delete(e.pointerId);
    if (cutData && cutData.dragS) { const { S, d } = cutData.dragS, q = cutData.pts[cutNear(d)]; cutData.dragS = null; /* relâché : nouvelle place du sommet, sur la trace, altitude du terrain de la coupe ; compte comme revérifié */
      if (q) placeSummit(S, { lat: q.lat, lng: q.lng, z: q.z });
      cutData.lock = true; drawCut(); cutText(cutData.cur); return; }
    if (pinch) { if (ptr.size < 2) pinch = null; down = null; return; }
    const d0 = down; down = null; if (!d0 || !cutData) return;
    cutData.lock = true; drawCut(); /* doigt levé (ou clic) : le curseur reste là, avec la punaise pour aller sur la carte */
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  /* trackpad du Mac (pincement = molette avec Ctrl) et molette : zoom ; défilement horizontal : déplacement */
  cv.addEventListener('wheel', e => {
    if (!cutData) return; e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5 && e.deltaMode === 1) { cutZoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.2)), dAt(e.clientX)); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const s = (cutData.v1 - cutData.v0) * e.deltaX / 400; cutView(cutData.v0 + s, cutData.v1 + s); }
    else cutZoomAt(Math.exp(-e.deltaY * 0.004), dAt(e.clientX));
  }, { passive: false });
  window.addEventListener('resize', () => { if (cutData) drawCut(); });
})();
$('qCut').addEventListener('click', () => { if (!$('cutBox').classList.contains('hidden')) closeCut(); else openCut(); });
$('cutClose').addEventListener('click', closeCut);
$('cutPin').addEventListener('click', cutGo);
$('cutAddS').addEventListener('click', cutAddS);
$('cutIn').addEventListener('click', () => { const c = cutData; if (c) cutZoomAt(2, (c.v0 + c.v1) / 2); });
$('cutOut').addEventListener('click', () => { const c = cutData; if (c) cutZoomAt(0.5, (c.v0 + c.v1) / 2); });
$('cutReset').addEventListener('click', () => { const c = cutData; if (c) { c.pts = c.full; cutView(0, c.tot); } });
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
    let el; I.altiErr = false;
    try { el = await elevTiles(pts); }
    catch (e1) { /* secours : Open-Meteo, avec au plus 400 points (limite d'appels) */
      const k = Math.ceil(pts.length / 400), sub = pts.filter((_, i) => i % k === 0); const e2 = await fetchElev(sub); el = pts.map(() => null); sub.forEach((q, i) => { el[i * k] = e2[i]; });
    }
    let best = -1;
    el.forEach((e, i) => { if (typeof e === 'number' && (best < 0 || e > el[best])) best = i; });
    if (best >= 0 && isv() === I) { I.alti = { key, max: { lat: pts[best].lat, lng: pts[best].lng, elev: Math.round(el[best]) }, n: pts.length, step, drift: Math.round(g.drift), t: Date.now() }; persist(); redraw(); if (lastTab === 'alti') renderAlti(); if (lastTab === 'brief' && !$('sheet').classList.contains('hidden')) renderBrief(); }
  } catch (e) { I.altiErr = true; if (manual) toast('Altitudes impossibles à télécharger (réseau ?)'); }
  finally { altiBusy = false; altiState(); }
}
function altiVals() { // valeurs d'altimétrie, ou null si le point haut n'est pas à jour
  const I = isv(); if (!sol || !sol.ok) return null;
  const ref = current.zmt || I.ptu, alpha = Calc.pOfZ(F, ref.lat, ref.lng, sol.elev0) /* v0.10.0 : ALPHA au sol de la ZMT */, o = { alpha: Math.round(alpha), elevPtu: sol.elev0 };
  if (I.alti && I.alti.max && I.alti.key === altiKey()) { const m = I.alti.max; o.max = m; o.oso = Math.round(Calc.pOfZ(F, m.lat, m.lng, m.elev)); o.hRel = sol.altRel - m.elev; }
  return o;
}
// Ouverture basse : pour chaque para, point d'ouverture terminée s'il chutait jusqu'à LOW_FT au-dessus du point haut
// au lieu d'ouvrir comme prévu (projection + vent de chaque tranche, depuis son point de largage). Points GRIS depuis la v0.5.9 (jaunes avant), sans nom.
const lowFt = () => { const v = +prm.osoFt; return isFinite(v) && v >= 0 ? v : 1900; }, lowMem = { k: null, v: null }; /* v0.30.0 : plus de 1 900 ft en dur */
function lowPoints() {
  const av = altiVals(); if (!av || !av.max || !sol || !sol.ok) return null;
  const k = solKey + '|' + altiKey() + '|' + av.max.elev + '|' + lowFt(); if (lowMem.k === k) return lowMem.v;
  let v = null;
  const drop = sol.altRel - (av.max.elev + lowFt() * 0.3048), vff = Math.max(10, +prm.vff || 50), ol = Math.max(0, openLossNow());
  if (drop > ol + 1) {
    const kff = Calc.ffK(F, isv().ptu, sol.altRel), f = Calc.fall(Calc.tFallFor(drop, sol.tas, vff, ol, vzRefNow(), true, kff), sol.tas, vff, ol, vzRefNow(), kff);
    v = sol.vec.exits.map(e => Calc.fromLocal(e, Calc.rseDrift(F, e, sol.altRel, f, sol.acHeading)));
  }
  lowMem.k = k; lowMem.v = v; return v;
}
/* Arrivée au sol (v0.5.8, demande d'Henri ; points JAUNES depuis la v0.5.9) : depuis chaque point d'ouverture automatique
   (points GRIS : voile ouverte à 1 900 ft au-dessus du point haut),
   dérive sous voile jusqu'à la hauteur du point haut (même « sol » pour tout le monde) : vent seul, sans vitesse propre
   horizontale de la voile ; descente à la Vz de la voile du para (corrigée de la densité de l'air et de sa MTE). */
const C_GREY = '#9a9a9a', greyMem = { k: null, v: null };
function greyPoints() {
  const low = lowPoints(), av = altiVals(); if (!low || !av || !av.max) return null;
  const k = lowMem.k; if (greyMem.k === k) return greyMem.v;
  const I = isv(), z0 = av.max.elev + lowFt() * 0.3048, z1 = av.max.elev, STEP = 50;
  const v = low.map((p0, n) => {
    const ex = sol.vec.exits[n], para = I.team[ex ? ex.i : 0] || I.team[0], can = prm.canopies.find(c => c.id === para.canopy) || prm.canopies[0];
    const mk = Math.sqrt((+para.mte > 0 ? +para.mte : MTE_DEF) / Calc.MTE_REF); let p = p0;
    for (let z = z0; z > z1 + 1e-6;) {
      const z2 = Math.max(z1, z - STEP), zm = (z + z2) / 2, w = Calc.windAt(F, p.lat, p.lng, zm), dt = (z - z2) / (Calc.canRef(can).vz * mk * Calc.kRho(F, p.lat, p.lng, zm));
      p = Calc.fromLocal(p, { x: w.u * dt, y: w.v * dt }); z = z2;
    }
    return p;
  });
  greyMem.k = k; greyMem.v = v; return v;
}
function renderAlti() {
  if (!$('altiTable')) return; /* v0.13.0 : tableau retiré (valeurs dans le Briefing) */
  const tb = $('altiTable').querySelector('tbody'), v = altiVals(); tb.innerHTML = '';
  if (!v) { tb.innerHTML = '<tr><td class="mut">Pas encore de vecteur.</td></tr>'; return; }
  const rows = [];
  rows.push(['Point le plus haut de la zone de sécurité', v.max ? `${fmtInt(v.max.elev)} m` : 'calcul en cours…']);
  rows.push(['OSO', v.max ? `${v.oso} hPa` : '…', true]);
  rows.push(['ALPHA', `${v.alpha} hPa`, true]);
  rows.push(['Hauteur de largage', v.max ? `${fmtInt(v.hRel)} m` : '…', true]);
  { const I = isv(); if (v.max && I.alti && I.alti.drift != null) rows.push(['Zone de sécurité', `vecteur et ses marges, prolongés de ${fmtInt(I.alti.drift)} m le long de la dérive sous RSE`]); }
  rows.push(['Sol de la ZMT (référence des hauteurs, ALPHA)', `${fmtInt(v.elevPtu)} m`]);
  if (!F) rows.push(['', '<b class="warn">Sans prévision : pressions en atmosphère standard</b>']);
  rows.forEach(([k, val, hi]) => { const tr = document.createElement('tr'); if (hi) tr.className = 'hi'; tr.innerHTML = `<td>${k}</td><td>${val}</td>`; tb.append(tr); });
}
onNum('a_long', v => { isv().secLong = Math.round(v); scheduleAlti(); }, 0, 20000);
onNum('a_lat', v => { isv().secLat = Math.round(v); scheduleAlti(); }, 0, 10000);
$('btnAlti').addEventListener('click', () => computeAlti(true));
/* v0.5.4 : iOS met l'appli en pause quand on passe sur une autre appli ou l'écran d'accueil (rien ne tourne en
   arrière-plan pour une appli web). Si le calcul du point haut a été coupé, il repart tout seul au retour dans l'appli,
   ou quand le réseau revient. */
function altiResume() { if (document.visibilityState !== 'visible' || !sol || !sol.ok) return; const I = isv(); if (!(I.alti && I.alti.key === altiKey())) { clearTimeout(altiT); altiT = setTimeout(() => computeAlti(false), 400); } }
document.addEventListener('visibilitychange', altiResume);
window.addEventListener('online', altiResume);
window.addEventListener('pageshow', altiResume);

// ---------- Onglet Paramètres : parachutes et calcul ----------
function renderCans() { /* v0.31.0 (Henri) : par voile, hauteur et MTE de la mesure, Vx et Vz mesurées ; ＋ ajouter, modifier, 🗑 supprimer */
  const ul = $('canList'); if (ul.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  ul.innerHTML = '';
  prm.canopies.forEach(c => {
    const li = document.createElement('li'); li.className = 'can';
    li.innerHTML = `<div class="ch"><input class="cn" value="${esc(c.name)}" placeholder="Nom"><button class="cdel">🗑</button></div>
      <div class="csub">Vitesses sous voile</div>
      <div class="grid2"><div><label>Hauteur de la mesure (m)</label><input class="chm" inputmode="numeric" value="${fmtInt(+c.hM)}"></div><div><label>MTE de la mesure (kg)</label><input class="cmte" inputmode="numeric" value="${fmtInt(+c.mteM)}"></div></div>
      <div class="grid2"><div><label>Vx mesurée (m/s)</label><input class="cx" inputmode="decimal" value="${fmt1(+c.vx)}"></div><div><label>Vz mesurée (m/s)</label><input class="cz" inputmode="decimal" value="${fmt1(+c.vz)}"></div></div>
      <div class="csub">Ouverture</div>
      <div class="grid2"><div><label>Hauteur de début d'ouverture de la mesure (m)</label><input class="cho" inputmode="numeric" value="${fmtInt(+c.hOpenM)}"></div><div><label>MTE de la mesure (kg)</label><input class="cmo" inputmode="numeric" value="${fmtInt(+c.mteOpenM)}"></div></div>
      <div class="grid2"><div><label>Hauteur perdue à l'ouverture mesurée (m)</label><input class="clo" inputmode="numeric" value="${fmtInt(+c.lossM)}"></div><div></div></div>`;
    li.querySelector('.cn').addEventListener('change', e => { c.name = e.target.value.trim() || c.name; saveProfile(); changed(); });
    const num = (cls, key, min, max, f) => li.querySelector(cls).addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v) || v < min || v > max) { toast('Valeur refusée'); e.target.value = f(+c[key]); return; } c[key] = v; saveProfile(); changed(); });
    num('.cx', 'vx', 1, 40, fmt1); num('.cz', 'vz', 0.5, 20, fmt1); num('.chm', 'hM', -500, 9000, fmtInt); num('.cmte', 'mteM', 40, 400, fmtInt); num('.cho', 'hOpenM', -500, 9000, fmtInt); num('.clo', 'lossM', 0, 1000, fmtInt); num('.cmo', 'mteOpenM', 40, 400, fmtInt);
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
$('btnAddCan').addEventListener('click', async () => { const n = await ask('Nom du parachute :', ''); if (!n) return; prm.canopies.push({ id: uid('c'), name: String(n).trim(), vx: 9, vz: 2.5, hM: 1000, mteM: 150, hOpenM: 1000, mteOpenM: 150, lossM: 100 }); saveProfile(); changed(); toast('Parachute ajouté : saisis ses mesures'); });
/* v0.31.0 (Henri) : mode autonome — plus aucune requête vers Internet (sauf les tuiles déjà gardées sur le téléphone, servies par le
   service worker sans réseau). L'appli elle-même se met à jour comme avant (même site). */
$('p_offline').addEventListener('change', e => { prm.offline = !!e.target.checked; saveProfile(); syncOffline(); toast(prm.offline ? 'Mode autonome : l\'appli ne va plus sur Internet' : 'Internet réactivé'); changed(); });
function syncOffline() { $('p_offline').checked = !!prm.offline; try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ offline: !!prm.offline }); } catch (e) {} }
const onPrm = (id, key, min, max) => onNum(id, v => { prm[key] = v; saveProfile(); }, min, max);
onPrm('p_margin', 'margin', 0, 80); onPrm('p_vff', 'vff', 20, 100); onPrm('p_sumMargin', 'sumMargin', 0, 2000); onPrm('p_courtKm', 'courtKm', 0, 100); onPrm('p_osoKm', 'osoKm', 0, 100); onPrm('p_osoFt', 'osoFt', 0, 20000); onPrm('p_tRef', 'tRef', 1, 60); onPrm('p_offKm', 'offKm', 1, 500);

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
      if (current.id === z.id) { current = newZone(map.getCenter()); current.zoom = map.getZoom(); resetMarkers(); placing = null; suspended = null; persist(); redraw(); }
      fillInputs();
    };
    /* v0.32.0 (Henri, comme les autres applis) : hors-ligne par zone */
    const off = document.createElement('span'); off.className = 'zoff';
    if (dlProgress[z.id]) off.innerHTML = `<small>⬇︎ ${dlProgress[z.id]}</small>`;
    else if (z.offline) { off.innerHTML = `<small>hors-ligne ${esc(z.offline)}</small>`; const rm = document.createElement('button'); rm.className = 'zoffdel'; rm.textContent = '🗑'; rm.title = 'Supprimer le hors-ligne'; rm.onclick = e => { e.stopPropagation(); removeOffline(z.id); }; off.append(rm); }
    else { const dl = document.createElement('button'); dl.className = 'zoffdel'; dl.textContent = '⬇︎ hors-ligne'; dl.title = 'Tout télécharger pour le hors-ligne'; dl.onclick = e => { e.stopPropagation(); downloadOffline(z.id); }; off.append(dl); }
    li.querySelector('.zn').append(off);
    li.append(ren, del); ul.append(li);
    dragReorder(li, li.querySelector('.zhandle'), order => { zones.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); store.set('isv.zones', zones); });
  });
}
function renderIsvList() {
  const ul = $('isvList'); ul.innerHTML = '';
  /* v0.9.0 : « ISV de la zone <nom> » ; avec plusieurs zones enregistrées, le nom est une liste déroulante qui bascule de zone (onglet ISV gardé ouvert) */
  const zs = $('isvZone'), saved = current.id && zones.some(z => z.id === current.id);
  if (saved && zones.length > 1) {
    zs.innerHTML = '<select id="isvZoneSel"></select>'; const sel = zs.firstChild;
    zones.forEach(z => { const o = document.createElement('option'); o.value = z.id; o.textContent = z.name; o.selected = z.id === current.id; sel.append(o); });
    sel.onchange = () => { if (sel.value !== current.id) loadZone(sel.value, true); };
  } else zs.innerHTML = `<b>${esc(current.name || 'Nouvelle zone')}</b>`;
  current.isvs.forEach(I => {
    const li = document.createElement('li'); li.className = I.id === current.cur ? 'cur' : '';
    li.innerHTML = `<span class="zn">${esc(I.name)} <small class="mut">${I.team.length} para${I.team.length > 1 ? 's' : ''} · FL${I.fl}</small></span>`;
    li.querySelector('.zn').onclick = () => openIsv(I.id);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => {
      /* v0.14.0 : un nom saisi arrête le nommage automatique ; bouton pour revenir au nom par défaut (date et heure) */
      const dd = $('dlgDel'); dd.classList.remove('danger');
      const n = await ask('Nom de l\'ISV :', I.name, I.nameAuto ? '' : '↺ Nom par défaut (date et heure)');
      dd.classList.add('danger');
      if (n === 'DELETE') { I.nameAuto = true; I.name = isvAutoName(I); }
      else if (n) { I.nameAuto = n === isvAutoName(I); I.name = n; } else return;
      persist(); fillInputs(); };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (current.isvs.length < 2) return toast('Une zone garde au moins une ISV');
      if (!(await ask(`Supprimer l'ISV « ${I.name} » ?`))) return;
      current.isvs = current.isvs.filter(x => x.id !== I.id); if (current.cur === I.id) current.cur = current.isvs[0].id; resetMarkers(); changed(true);
    };
    li.append(ren, del); ul.append(li);
  });
}
function openIsv(id) { current.cur = id; current.when = isv().when || current.when; resetMarkers(); placing = null; suspended = null; closeSheet(); persist(); fillInputs(); draw(); if (sol && sol.ok) fitFigure(); ensureWx(false); refreshPtuElev(); toast(`ISV « ${isv().name} »`); }
$('btnNewIsv').addEventListener('click', async () => {
  if (!(await askZoneName())) return;
  const I = newIsv(); I.when = current.when; I.nameAuto = true; I.name = isvAutoName(I); current.isvs.push(I); openIsv(I.id); startPlacing(current.zmt ? 'P' : 'Z');
});
$('btnDupIsv').addEventListener('click', async () => {
  if (!(await askZoneName())) return;
  const src = isv(), I = clone(src); I.id = uid('i');
  /* v0.26.0 (Henri) : nom par défaut → l'originale devient « …-1 », la copie « …-2 » (puis -3, -4…) ; nom forcé → l'originale garde son nom,
     la copie prend le nom par défaut (date et heure) */
  if (src.nameAuto) { if (!src.autoSuf) src.autoSuf = 1; const base = isvAutoBase(src); I.autoSuf = 1 + Math.max(...current.isvs.filter(x => x.nameAuto && isvAutoBase(x) === base).map(x => x.autoSuf || 0)); src.name = isvAutoName(src); }
  else { I.nameAuto = true; I.autoSuf = 0; }
  I.name = isvAutoName(I); I.team.forEach(p => { const old = p.id; p.id = uid('p'); if (I.dropId === old) I.dropId = p.id; if (I.relaxRef === old) I.relaxRef = p.id; }); I.points.forEach(pt => { pt.id = uid('q'); });
  current.isvs.push(I); openIsv(I.id);
});
function loadZone(id, keepIsvTab) {
  const z = zones.find(x => x.id === id); if (!z) return;
  current = upgrade(clone(z));
  resetMarkers(); placing = null; suspended = null; setBanner(null); stopMeasure();
  map.setBearing(current.bearing || 0);
  map.setView([current.center.lat, current.center.lng], current.zoom || 11);
  if (keepIsvTab) openSheet('isv'); else closeSheet(); fillInputs(); draw(); persist();
  if (keepIsvTab) toast(`Zone « ${current.name} »`);
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
    b.className = 'res club'; b.innerHTML = `<b>🪂 ${esc(k.n)}</b><br><small>${esc(k.t || 'Club FFP')} · ${esc(k.v)}</small>`;
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
/* ---------- Hors-ligne d'une zone (v0.32.0, demande d'Henri) : tout ce qui est fixe autour de la ZMT, dans un rayon de prm.offKm (200 km) :
   altitudes (tuiles Terrarium z12, celles du point haut et de la coupe), photos satellite et IGN (France) jusqu'au niveau 12 sur tout le
   rayon, plus fines (jusqu'au niveau 17) dans 5 km autour de la ZMT. Pas la météo (prévision, pas fixe). Tout passe par le même cache que
   la carte (le service worker sert ces tuiles sans réseau). Au-delà du niveau 12 sur 200 km : des centaines de milliers d'images, impossible. */
function tileXY(lat, lng, z) { const n = 2 ** z, r = lat * Math.PI / 180; return { x: Math.floor((lng + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n) }; }
function tilesIn(c, R, z, url) { const out = [], a = tileXY(Calc.fromLocal(c, { x: -R, y: R }).lat, Calc.fromLocal(c, { x: -R, y: R }).lng, z), b = tileXY(Calc.fromLocal(c, { x: R, y: -R }).lat, Calc.fromLocal(c, { x: R, y: -R }).lng, z), n = 2 ** z;
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) { /* seulement les tuiles qui touchent le cercle */
    const lng0 = x / n * 360 - 180, lng1 = (x + 1) / n * 360 - 180, lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI, lat0 = lat(y + 1), lat1 = lat(y);
    const q = Calc.toLocal(c, { lat: Math.max(lat0, Math.min(lat1, c.lat)), lng: Math.max(lng0, Math.min(lng1, c.lng)) }); if (Math.hypot(q.x, q.y) <= R) out.push(url(z, x, y)); }
  return out; }
function offlinePlan(z) {
  const c = z.zmt || z.center, R = Math.max(1, +prm.offKm || 200) * 1000, inFr = c.lat > 41 && c.lat < 51.6 && c.lng > -5.6 && c.lng < 10;
  const dem = tilesIn(c, R, DEM_Z, DEM_URL), sat = [];
  for (const b of inFr ? ['esri', 'ign'] : ['esri']) { for (let k = 5; k <= 12; k++) sat.push(...tilesIn(c, R, k, (q, x, y) => tileUrl(q, x, y, b))); for (let k = 13; k <= 17; k++) sat.push(...tilesIn(c, 5000, k, (q, x, y) => tileUrl(q, x, y, b))); }
  return { dem, sat: [...new Set(sat)], inFr };
}
async function downloadOffline(id) {
  if (!('caches' in window)) { toast('Hors-ligne non pris en charge ici'); return; }
  if (prm.offline) { toast('Mode autonome coché (Param.) : décoche-le pour télécharger'); return; }
  if (dlProgress[id]) return;
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z) return;
  if (!z.zmt) { toast('Pose d\'abord la ZMT de cette zone'); return; }
  const P = offlinePlan(z), mo = Math.round((P.dem.length * 110 + P.sat.length * 25) / 1024);
  if (!(await ask(`Tout télécharger pour « ${z.name} » dans un rayon de ${fmtInt(+prm.offKm || 200)} km autour de la ZMT ?\n• altitudes : ${fmtInt(P.dem.length)} tuiles\n• photos ${P.inFr ? 'satellite et IGN' : 'satellite'} : ${fmtInt(P.sat.length)} images (détail fin à 5 km de la ZMT)\nEnviron ${fmtInt(mo)} Mo, en Wi-Fi de préférence. La météo n'est pas téléchargée (c'est une prévision).`, undefined, null, 'Télécharger'))) return;
  const list = P.dem.concat(P.sat), total = list.length; let done = 0, fail = 0; dlProgress[id] = `0/${fmtInt(total)}`; renderZones();
  const c = await caches.open(TILE_CACHE);
  const worker = async () => { while (list.length) { const u = list.shift();
    try { if (!(await c.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); else fail++; } } catch (e) { fail++; }
    done++; if (done % 50 === 0) { dlProgress[id] = `${fmtInt(done)}/${fmtInt(total)}`; renderZones(); } } };
  await Promise.all(Array.from({ length: 8 }, worker));
  delete dlProgress[id];
  const date = new Date().toLocaleDateString('fr-FR'), ok = fail < total * 0.01, i = zones.findIndex(x => x.id === id);
  if (ok) { if (i >= 0) { zones[i].offline = date; store.set('isv.zones', zones); } if (current.id === id) { current.offline = date; persist(); } }
  renderZones();
  toast(ok ? `« ${z.name} » disponible hors-ligne${fail ? ` (${fail} images manquantes)` : ''}` : `« ${z.name} » : ${fmtInt(fail)} images manquées, relance pour compléter (ce qui est déjà là est gardé)`);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
async function removeOffline(id) {
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z) return;
  if (!(await ask(`Supprimer le hors-ligne de « ${z.name} » ? La zone reste enregistrée ; la carte et les altitudes ne viendront plus que d'Internet.`))) return;
  const keep = new Set(); zones.filter(x => x.id !== id && x.offline && x.zmt).forEach(x => { const P = offlinePlan(x); P.dem.concat(P.sat).forEach(u => keep.add(u)); });
  const P = offlinePlan(z), c = await caches.open(TILE_CACHE); let n = 0;
  for (const u of P.dem.concat(P.sat)) if (!keep.has(u) && await c.delete(u)) n++;
  z.offline = null; const i = zones.findIndex(x => x.id === id); if (i >= 0) zones[i].offline = null; if (current.id === id) current.offline = null;
  store.set('isv.zones', zones); persist(); renderZones(); toast(`Hors-ligne supprimé (${fmtInt(n)} images)`);
}
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
  const MI = traceMini(), tn = (p, i) => (i === 0 ? 'OUV' : i === s.trace.length - 1 ? 'PTU' : String(Math.round(p.h))) + miniTag(MI, i);
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="trace-isv ${VERSION}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">\n` +
    `  <metadata><name>${x(current.name + ' - ' + I.name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
  // Points : ZMT, OUV, PTU, début et fin de largage, sorties, points de l'ISV
  if (current.zmt) o += wpt(current.zmt, 'ZMT', 'Flag, Red');
  o += wpt(s.trace[0], 'OUV', 'Flag, Blue', s.elev0 + s.trace[0].h) + wpt(I.ptu, 'PTU', 'Flag, Green', s.elev0 + I.hPtu);
  o += wpt(s.vec.green, 'DEBUT LARG', 'Navaid, Green', s.altRel) + wpt(s.vec.red, 'FIN LARG', 'Navaid, Red', s.altRel);
  s.vec.exits.forEach(e => { const p = I.team[e.i]; o += wpt(e, `P${e.i + 1}${p.name ? ' ' + p.name : ''}`, 'Navaid, Black', s.altRel); });
  isv().points.forEach(pt => { o += wpt(pt, pointLabel(pt) || (pt.kind === 'alt' ? 'ZMT ALT' : 'POINT'), pt.kind === 'alt' ? 'Flag, Red' : 'Pin, Blue', pt.elev); });
  // Trace : itinéraire à suivre, de l'ouverture terminée au PTU (les points intermédiaires portent leur hauteur)
  o += `  <rte><name>${x('TRACE ' + I.name)}</name>\n` + s.trace.map((p, i) => `    <rtept ${ll(p)}><ele>${Math.round(s.elev0 + p.h)}</ele><name>${tn(p, i)}</name><sym>Waypoint</sym></rtept>\n`).join('') + `  </rte>\n`;
  // Trace et vecteur en simples lignes
  o += trk('TRACE ' + I.name, s.trace, 'Magenta') + trk('VECTEUR ' + I.name, [s.vec.green].concat(s.vec.exits, [s.vec.red]).map(p => ({ lat: p.lat, lng: p.lng })), 'Black');
  return o + '</gpx>\n';
}
let pdfFile = null;
function fileReady(file, note) { pdfFile = file; $('pdfName').textContent = file.name + (note || ''); $('pdfReady').classList.remove('hidden');  $('pdfPreview').classList.toggle('hidden', !/\.pdf$/i.test(file.name)); }
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
  { const cp = toC(I.ptu), MI = traceMini(); sol.trace.forEach((p, i) => { if (i === sol.trace.length - 1) return; const c = dot(p, C_TRACE, i === 0 ? 7 : 4.5); if (i === 0) shadowText(`OUV ${fmtInt(p.h)}${miniTag(MI, i)}`, c.x - 12 * u, c.y - 16 * u, C_TRACE, 11, 'right'); else if (MI[i] != null || Math.hypot(c.x - cp.x, c.y - cp.y) > 26 * u) shadowText(fmtInt(p.h) + miniTag(MI, i), c.x + 9 * u, c.y, C_TRACE, 10); }); }
  line([sol.vec.green, sol.vec.red], 'rgba(255,255,255,.9)', 9); line([sol.vec.green, sol.vec.red], '#000', 4.5);
  sol.vec.exits.forEach(e => dot(e, e.i === sol.dropIdx ? '#fff' : '#000', e.i === sol.dropIdx ? 4.2 : 3));
  dot(sol.vec.green, C_START, 8); dot(sol.vec.red, C_END, 8);
  { const m = toC({ lat: (sol.vec.green.lat + sol.vec.red.lat) / 2, lng: (sol.vec.green.lng + sol.vec.red.lng) / 2 }); shadowText(`${hdg(sol.acHeading)} · ${fmtInt(sol.vec.length)} m`, m.x + 12 * u, m.y - 14 * u, '#fff', 11);
    const t = toC(Calc.pointAt(sol.trace, sol.length / 2)); shadowText(`CAP ${hdg(sol.cap)} · ${fmtKm(sol.length)}`, t.x + 12 * u, t.y, '#fff', 11); }
  const cible = (ll, color, name) => { const c = toC(ll), r = 8 * u; g.save(); g.strokeStyle = '#000'; g.lineWidth = 5 * u; g.beginPath(); g.arc(c.x, c.y, r, 0, 2 * Math.PI); g.moveTo(c.x - 1.7 * r, c.y); g.lineTo(c.x + 1.7 * r, c.y); g.moveTo(c.x, c.y - 1.7 * r); g.lineTo(c.x, c.y + 1.7 * r); g.stroke(); g.strokeStyle = color; g.lineWidth = 2.4 * u; g.stroke(); g.restore(); if (name) shadowText(name, c.x + 16 * u, c.y - 12 * u, color, 11); };
  if (current.zmt) { const bw = barbWind(toC); if (bw) { const bg = barbUnder(bw, u, bw.z.x + 16 * u + 12 * u, bw.z.y - 5 * u); g.save(); g.lineCap = 'round'; /* sous l'étiquette « ZMT » du PDF (écrite à x+16u, y−12u) */
      const st = (col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); bg.lines.forEach(([a, b]) => { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }); if (bg.calm) { g.moveTo(bg.T.x + 2.5 * u, bg.T.y); g.arc(bg.T.x, bg.T.y, 2.5 * u, 0, 7); } g.stroke(); };
      st('rgba(0,0,0,.55)', 2.6 * u); bg.tris.forEach(t => { g.beginPath(); g.moveTo(t[0].x, t[0].y); t.slice(1).forEach(q => g.lineTo(q.x, q.y)); g.closePath(); g.fillStyle = '#00e5ff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = .6 * u; g.stroke(); }); st('#00e5ff', 1.1 * u); g.restore(); } } /* v0.26.0 : barbule du vent au sol */
  if (current.zmt) cible(current.zmt, C_ZMT, 'ZMT');
  { const c = dot(I.ptu, C_PTU, 8); shadowText(`PTU ${fmtInt(I.hPtu)} m`, c.x - 12 * u, c.y, C_PTU, 11, 'right'); }
  isv().points.forEach(pt => { if (pt.kind === "alt") cible(pt, '#ff2020', pointLabel(pt)); else { const c = toC(pt), s = 5.5 * u; g.save(); g.translate(c.x, c.y); g.rotate(Math.PI / 4); g.fillStyle = pt.color || '#fff'; g.strokeStyle = '#111'; g.lineWidth = 1.6 * u; g.fillRect(-s, -s, 2 * s, 2 * s); g.strokeRect(-s, -s, 2 * s, 2 * s); g.restore(); if (pt.name) shadowText(pointLabel(pt), c.x + 12 * u, c.y, pt.color || '#fff', 10); } });
  (lowPoints() || []).forEach(p => dot(p, C_GREY, 4.5));
  (greyPoints() || []).forEach(p => dot(p, C_LOW, 4.5));
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
  // Mis en évidence. v0.6.1 (Henri) : à droite, en bleu, dans l'ordre : prise de cap, CDO (4 s ou hauteur d'ouverture), cap para, PTU main ;
  // au milieu, en jaune : OSO, ALPHA, hauteur de largage.
  const big = fs * 1.55, hi = [
    `OSO : ${av && av.max ? av.oso : '....'}`, `ALPHA : ${av ? av.alpha : '....'}`, `H. largage : ${av && av.max ? fmtInt(av.hRel) + ' m' : '....'}`
  ], hi2 = [
    sol.turn ? `Prise de cap à ${sol.turn}` : 'Prise de cap : dans l\'axe',
    `CDO : ${sol.openLowered ? fmtInt(Math.round(sol.hCmd)) + ' m' : fmt1(sol.tFall) + ' s'}`,
    `Cap para : ${hdg(sol.cap)}`,
    sol.hand ? `PTU main ${sol.hand}` : (current.zmt ? 'PTU dans l\'axe' : 'ZMT non placée')];
  hi.forEach((t, i) => tx(t, col2, l0 + lh * (0.3 + i * 1.9), '#ffd400', big, true));
  hi2.forEach((t, i) => tx(t, col3, l0 + lh * (0.1 + i * 1.4), '#00e5ff', big, true));
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
  row('Largage', `FL${sol.fl} = ${fmtInt(sol.hRel)} m au-dessus du sol de la ZMT`, true);
  if (sol.flMin4 != null) row(`FL pour ${fmt1(+prm.tRef || 4)} s de chute`, `FL${String(sol.flMin4).padStart(3, '0')} (même ouverture terminée, ${fmtInt(Math.round(sol.hOpen))} m)`);
  row('Vitesse de largage', `${fmt1(+I.acMs)} m/s badin (${Math.round(I.acMs * KT)} kt) = ${Math.round(sol.tas * KT)} kt vraie`);
  row(sol.openLowered ? 'Consigne : ouverture à' : 'Temps de chute', sol.openLowered ? `${fmtInt(Math.round(sol.hOpen))} m au-dessus du sol de la ZMT (${fmt1(sol.tFall)} s de chute, ${fmtInt(sol.openDrop)} m d'ouverture compris)` : `${fmt1(sol.tFall)} s, puis ${fmtInt(sol.openDrop)} m de perte de hauteur à l'ouverture (${fmt1(sol.tOpen)} s)`, sol.openLowered);
  volRows().forEach(([k, v, hi]) => row(k, v, hi));
  row('Point d\'entrée PTU', fmtPos(I.ptu)); row('Hauteur d\'arrivée au PTU', `${fmtInt(I.hPtu)} m au-dessus du sol de la ZMT (${fmtInt(sol.elev0)} m)`);
  row('Ouverture terminée (OUV)', fmtPos(sol.ouv));
  row('Début de largage (vert)', fmtPos(sol.vec.green)); row('Fin de largage (rouge)', fmtPos(sol.vec.red));
  if (current.zmt) row('Zone de posé (ZMT)', fmtPos(current.zmt));
  y += 3; title('Altimétrie');
  const av = altiVals();
  row('OSO', av && av.max ? `${av.oso} hPa (point haut ${fmtInt(av.max.elev)} m)` : 'non calculé', true);
  row('ALPHA', av ? `${av.alpha} hPa (sol de la ZMT ${fmtInt(av.elevPtu)} m)` : '-', true);
  row('Hauteur de largage', av && av.max ? `${fmtInt(av.hRel)} m au-dessus du point haut` : 'non calculé', true);
  row('Zone de sécurité', `${fmtInt(I.secLong)} m avant et après le vecteur, ${fmtInt(I.secLat)} m de chaque côté,`);
  row('', `prolongée le long de la dérive sous RSE jusqu'à 1013 hPa${I.alti && I.alti.drift != null && I.alti.key === altiKey() ? ` (${fmtInt(I.alti.drift)} m)` : ''}`);
  y += 3; title(`Équipe (${I.team.length}) - vert + ${fmt1(+I.tGreen)} s, rouge ${fmt1(+I.tRed)} s après le dernier`);
  I.team.forEach((p, i) => { const c = prm.canopies.find(q => q.id === p.canopy) || prm.canopies[0]; row(`${i + 1}. ${p.name || 'Para ' + (i + 1)}${i === sol.dropIdx ? '  (sur le point de largage)' : ''}`, `${c.name} (Vx ${fmt1(+c.vx)}, Vz ${fmt1(+c.vz)} mesurées à ${fmtInt(+c.hM)} m pour ${fmtInt(+c.mteM)} kg) - MTE ${fmtInt(+p.mte > 0 ? +p.mte : MTE_DEF)} kg - sortie à ${fmt1(sol.ex.te[i])} s`); });
  y += 3; title('Points de la trace (hauteur au-dessus du sol de la ZMT)');
  { const MI = traceMini(); sol.trace.forEach((p, i) => row((i === 0 ? `OUV  ${fmtInt(p.h)} m` : i === sol.trace.length - 1 ? `PTU  ${fmtInt(p.h)} m` : `${fmtInt(p.h)} m`) + (MI[i] != null ? `  (mini ${fmtInt(MI[i])} m alti)` : ''), fmtPos(p))); }
  if (!F) return;
  doc.addPage('a4', 'portrait');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(clean(`Vents à la verticale du PTU - ${fmtWhen(current.when).replace(' ', ' à ')}`), 15, 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(clean(`${wxRec.model} via Open-Meteo, téléchargée le ${new Date(wxRec.fetched).toLocaleString('fr-FR')} - hauteurs au-dessus du sol de la ZMT (${Math.round(sol.elev0)} m)`), 15, 25);
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
/* Aperçu du PDF dans l'appli (pdfview.js, 21 nov. 2026) ; bouton masqué pour un autre fichier (GPX, sauvegarde…) */
$('pdfPreview').addEventListener('click', () => { if (pdfFile) PdfView.show(pdfFile); });
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

/* Titres de paragraphe (h3) collés sous les onglets quand on fait défiler le menu (21 nov. 2026, commun à toutes les applis) */
(function () {
  const s = document.getElementById('sheet'), t = s && s.querySelector('.tabs'); if (!t) return;
  const f = () => { if (t.offsetHeight) s.style.setProperty('--h3top', ((parseFloat(getComputedStyle(t).top) || 0) + t.offsetHeight) + 'px'); };
  if (window.ResizeObserver) new ResizeObserver(f).observe(t); window.addEventListener('resize', f); f();
})();

/* Zoom au pincement du trackpad (Mac) : le navigateur l'envoie en « wheel » avec ctrlKey, et Leaflet le divise
   tellement (deltaY / 6 sur Mac) que le zoom est très lent. On le traite ici, plus réactif (21 nov. 2026, commun aux applis carte).
   Sans effet sur iPhone (pincement tactile) ni sur la molette de la souris. */
(function () {
  const el = map.getContainer(); let acc = 0, pt = null, raf = 0;
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    acc += -e.deltaY * (e.deltaMode === 1 ? 0.25 : 0.012); pt = map.mouseEventToContainerPoint(e);
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0; const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + acc)); acc = 0;
      if (Math.abs(z - map.getZoom()) > 1e-3) map.setZoomAround(pt, z, { animate: false });
    });
  }, { capture: true, passive: false });
})();

// ---------- Préparation pas à pas (v0.28.0, demandé et validé par Henri le 21 nov. 2026) ----------
/* Liste d'étapes par ISV (I.steps[id] = { s: 'done' | 'skip', sig }). Bandeau en bas de la carte sur la 1re étape à faire :
   « Aller » (ouvre le bon endroit), « ✓ Fait », « Passer ». Passer est toujours possible et l'étape passée ne revient PAS
   (c'est à l'utilisateur d'y penser ; la liste en tête de Prépa ISV et du Briefing la montre). Une étape faite qui dépend de la
   trace repasse « à revérifier » (orange) si la trace bouge. Certaines étapes se cochent toutes seules (constat de l'appli). */
function goSec(tab, text) {
  openSheet(tab);
  requestAnimationFrame(() => { const s = $('sheet'), h = [...document.querySelectorAll(`#tab-${tab} h3`)].find(x => x.textContent.trim().startsWith(text)); if (!h) return;
    let a = h.previousElementSibling; if (!a || !a.classList.contains('anc')) { a = document.createElement('div'); a.className = 'anc'; h.parentNode.insertBefore(a, h); } /* ancre non collante (piège du titre collant) */
    const t = s.querySelector('.tabs'); s.scrollTop += a.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(h).marginTop) || 0) - t.getBoundingClientRect().bottom; });
}
function placeAlt() { openPtPop(); placing = { kind: 'alt' }; placeBanner(); fillInputs(); syncPtPop(); }
function sOf(T, q) { return Calc.nearestOn(T, q).s; }
function altBetween(T, s0, s1) { return isv().points.some(q => q.kind === 'alt' && (s => s > s0 && s < s1)(sOf(T, q))); }
/* Contrôle : une zone de posé alternative dont la projection sur la trace tombe entre le point d'alerte et le sommet (ou le début de la zone délicate) */
function stepProblems(kind) {
  if (!sol || !sol.ok) return []; const T = sol.trace, out = [], M = traceMini();
  const vS = k => sOf(T, T[k]);
  if (kind === 'zd') zdPairs().forEach(z => { const a = sOf(T, z.d), b = sOf(T, z.f), deb = a <= b ? z.d : z.f, k = sumVertex(T, deb).k;
    if (!altBetween(T, vS(k), Math.min(a, b))) out.push({ k, id: z.d.zid, txt: `${pointLabel(deb).replace('-DEB', '')} : pas de zone de posé entre le point d'alerte ${fmtInt(T[k].h)}${M[k] != null ? '-MINI' + M[k] : ''} et le début de la zone` }); });
  else { const Z = zdSpans(); isv().points.forEach(S => { if (S.auto !== 'S') return; const s = sOf(T, S); if (Z.some(z => s >= z.s0 - 1 && s <= z.s1 + 1)) return; /* sommet dans une zone délicate : contrôlé avec la zone */
    const k = sumVertex(T, S).k; if (!altBetween(T, vS(k), s)) out.push({ k, id: S.id, txt: `${pointLabel(S)} : pas de zone de posé entre le point d'alerte ${fmtInt(T[k].h)}${M[k] != null ? '-MINI' + M[k] : ''} et le sommet` }); }); }
  return out;
}
/* v0.29.0 (Henri) : sommet / zone délicate sans zone de posé avant elle → elle et son point d'alerte en ORANGE (comme « à revérifier ») */
function probSet() { const L = (sol && sol.ok) ? stepProblems('S').concat(stepProblems('zd')) : []; return { ids: new Set(L.map(x => x.id)), ks: new Set(L.map(x => x.k)) }; }
/* v0.35.8 (Henri) : étape « caps » validée toute seule quand les DEUX caps sont à la dizaine (plus de boucle « arrondir » → trace bougée → revérifier → arrondir) */
function capsRound() { if (!sol || !sol.ok) return false; const r = h => Math.round(magOf(h)) % 10 === 0; return r(sol.cap) && r(sol.acHeading); }
function stepRefreshBefore(id) { /* les étapes « trace » faites avant id acceptent la trace actuelle (elle n'a bougé que par l'action de l'étape id) */
  const st = STEPS.find(x => x.id === id), sig = traceSig(), I = isv(); if (!st) return;
  STEPS.slice(0, STEPS.indexOf(st)).forEach(x => { const r = (I.steps || {})[x.id]; if (x.tr && r && r.s === 'done') r.sig = sig; }); }
/* v0.38.0 (Henri) : « Appliquer » le FL pour 4 s de chute : change le FL (et remet le temps de chute de référence) ; la trace ne bouge pas,
   le vecteur oui (vitesse sol plus faible plus bas) → étapes Vecteur et Points OSO à revérifier, retour à la carte */
function applyFlMin4() {
  if (!sol || !sol.ok || sol.flMin4 == null) return; const I = isv(), fl = sol.flMin4;
  /* vecteur rentré à la main → remis en automatique avec le même cap para : l'ouverture à 4 s au nouveau FL est à la même hauteur, la trace ne change pas */
  if (I.manual) { if (I.capManual == null) I.capManual = sol.cap; I.manual = null; }
  I.fl = fl; I.tFall = +prm.tRef > 0 ? +prm.tRef : 4; changed();
  I.steps = I.steps || {}; ['vec', 'oso'].forEach(id => { I.steps[id] = { s: 'done', sig: traceSig(), force: 1 }; });
  stepFocus = 'vec'; persist(); closeSheet(); syncSteps(); redraw();
  toast(`FL${String(fl).padStart(3, '0')} appliqué : revérifie le vecteur de largage puis les points OSO`);
}
function roundCaps() {
  if (!sol || !sol.ok) return; const cp = Math.round(magOf(sol.cap) / 10) * 10 % 360;
  ask(`Arrondir à la dizaine ? Cap para ${hdg(sol.cap)} → ${String(cp).padStart(3, '0')}° M, puis cap avion arrondi aussi. Tu pourras ensuite forcer une autre valeur dans Prépa ISV › Données de vol.`, undefined, null, 'Arrondir').then(ok => {
    if (!ok) return; setCap(cp); compute(); if (sol && sol.ok) { const ca = Math.round(magOf(sol.acHeading) / 10) * 10 % 360; setAcH(ca); }
    stepRefreshBefore('caps'); persist(); redraw(); /* l'arrondi ne rouvre pas « Vecteur de largage » */
    toast(sol && sol.ok ? `Cap para ${hdg(sol.cap)} · cap avion ${hdg(sol.acHeading)}` : '');
  });
}
function fitVec() { if (!sol || !sol.ok) return; const pts = [sol.vec.green, sol.vec.red]; (lowPoints() || []).forEach(p => pts.push(p)); (greyPoints() || []).forEach(p => pts.push(p)); closeSheet(); fitBox(pts); }
const STEPS = [ /* ordre v0.36.1 (Henri) : altitudes avant ZRT, OSO juste après les caps, zones intermédiaires juste avant court/long */
  { id: 'zone', z: 1, t: 'Créer la zone', d: 'Crée la zone (☰ › ＋ Nouvelle zone) : ses documents et sa ZMT lui appartiennent.', auto: () => !!current.id, go: () => { closeSheet(); $('btnNewZone').click(); } },
  { id: 'fond', z: 1, t: 'Fond de carte', d: 'Choisis le fond de carte : satellite, IGN France ou photo calée.', go: () => goSec('zones', 'Fond de carte') },
  { id: 'alti', z: 1, t: 'Carte des altitudes', d: 'Import Internet automatique.', go: () => goSec('zones', 'Carte des altitudes') },
  { id: 'zrt', z: 1, t: 'ZRT', d: 'Importe la ZRT (KML, KMZ ou GPX). Pas de fichier : passe.', auto: () => current.zrt.length > 0, go: () => goSec('zones', 'ZRT') },
  { id: 'wx', z: 1, t: 'Données météo (vents)', d: 'Import Internet automatique : vérifie la date et l\'heure du saut.', auto: () => !!wxRec, go: () => goSec('zones', 'Données météo') },
  { id: 'zmt', z: 1, t: 'Point ZMT', d: 'Pose la zone de posé (ZMT).', auto: () => !!(current.id && current.zmt), go: () => startPlacing('Z') },
  { id: 'ptu', t: 'Point d\'entrée PTU', d: 'Pose le PTU : la trace apparaît.', auto: () => !!isv().ptu, go: () => startPlacing('P') },
  { id: 'team', t: 'Équipe', d: 'Vérifie la composition et la configuration de l\'équipe.', go: () => goSec('isv', 'Équipe') },
  { id: 'vec', t: 'Vecteur de largage', tr: 1, d: 'Vérifie sa position avec les points gris (ouverture OSO) et jaunes (arrivée après dérive sous voile). Appui long sur le vecteur : déplacer ou rentrer le long de la trace ; points vert et rouge : pivoter.', go: fitVec },
  { id: 'caps', t: 'Cap para et cap avion', tr: 1, auto: capsRound, d: 'Arrondis-les à la dizaine pour simplifier les consignes ; tu peux ensuite forcer une autre valeur.', go: roundCaps, goL: 'Arrondir' },
  { id: 'oso', t: 'Points OSO', tr: 1, auto: () => isv().points.some(q => q.kind === 'alt' && altPos(q).oso), d: 'Pose au moins une zone de posé alternative près des points jaunes (déclenchement du système OSO) : elle se nomme OSO toute seule.', go: () => { fitVec(); placeAlt(); }, goL: 'Poser' },
  { id: 'cut', t: 'Coupe et sommets', tr: 1, d: 'Vérifie la coupe et place les sommets S (bouton +S sous la punaise de la coupe).', go: () => { closeSheet(); openCut(); }, goL: 'Coupe' },
  { id: 'sumz', t: 'Zone de posé avant chaque sommet', tr: 1, chk: 'S', d: 'Entre chaque point d\'alerte et son sommet, il faut une zone de posé : recule le point d\'alerte (appui sur le point -MINI) ou pose une zone alternative.' },
  { id: 'zd', t: 'Zones délicates', tr: 1, d: 'Définis les zones délicates : ＋ Point, 3e bouton, début puis fin sur la trace.', go: () => { openPtPop(); placing = { kind: 'zd', stage: 'deb' }; placeBanner(); syncPtPop(); }, goL: 'Poser' },
  { id: 'zdz', t: 'Zone de posé avant chaque zone délicate', tr: 1, chk: 'zd', d: 'Entre le point d\'alerte et le début de chaque zone délicate, il faut une zone de posé.' },
  { id: 'inter', t: 'Zones de posé intermédiaires', tr: 1, d: 'Parcours la trace et pose autant de zones de posé alternatives que nécessaire.', go: placeAlt, goL: 'Poser' },
  { id: 'cl', t: 'Point court et point long', tr: 1, auto: () => isv().points.some(q => q.kind === 'alt' && altPos(q).court) && isv().points.some(q => q.kind === 'alt' && altPos(q).long),
    d: 'Pose une zone alternative en amont de la ZMT (COURT) et une en aval, au-delà du PTU (LONG) : elles se nomment toutes seules.', go: placeAlt, goL: 'Poser' },
];
function stepState(st) { /* 'done' (vert), 'skip' (passée), 'recheck' (orange : faite mais la trace a bougé), 'todo' */
  const H = st.z ? current : isv(), r = (H.steps || {})[st.id]; /* étapes de la zone (documents, ZMT) gardées par la zone, les autres par l'ISV */
  if (r && r.force) return 'recheck'; /* v0.38.0 : revérification demandée (ex. FL changé pour 4 s de chute) */
  if (r && r.s === 'skip') return 'skip';
  if (st.auto && st.auto()) return 'done';
  if (st.chk) { if (st.tr && (!sol || !sol.ok)) return 'todo'; return stepProblems(st.chk).length ? 'todo' : 'done'; }
  if (r && r.s === 'done') return st.tr && r.sig && r.sig !== traceSig() ? 'recheck' : 'done';
  return 'todo';
}
function stepSet(id, s) { const st = STEPS.find(x => x.id === id), H = st && st.z ? current : isv(); H.steps = H.steps || {}; if (s) H.steps[id] = { s, sig: traceSig() }; else delete H.steps[id];
  /* valider une étape = accepter la trace telle qu'elle est : les étapes faites avant ne se rouvrent pas pour ce qu'on vient de faire (ex. caps arrondis) */
  if (s === 'done') stepRefreshBefore(id);
  persist(); syncSteps(); }
const STEP_ICON = { done: '✓', skip: '⏭', recheck: '⚠', todo: '○' };
var stepFocus = null; /* étape remise à faire par ↺ : le bandeau la montre en priorité tant qu'elle n'est ni faite ni passée */
function syncSteps() {
  const I = isv(), states = STEPS.map(stepState), n = STEPS.length, fi = STEPS.findIndex(x => x.id === stepFocus), open = s => s === 'todo' || s === 'recheck';
  if (fi < 0 || !open(states[fi])) stepFocus = null;
  const i = stepFocus ? fi : states.findIndex(open);
  /* liste en tête de Prépa ISV */
  const ul = $('stepList');
  if (ul) { ul.innerHTML = ''; STEPS.forEach((st, k) => { const s = states[k], li = document.createElement('li'); li.className = 'st ' + s;
      li.innerHTML = `<span class="si">${STEP_ICON[s]}</span><span class="sn">${k + 1}. ${esc(st.t)}${s === 'recheck' ? ' <small>à revérifier</small>' : s === 'skip' ? ' <small>passée</small>' : ''}</span>`;
      li.querySelector('.sn').onclick = () => { if (st.go) { closeSheet(); st.go(); } };
      const b = document.createElement('button'); const can = !st.auto && !st.chk;
      if (s === 'done' && can || s === 'skip') { b.textContent = '↺'; b.title = 'Remettre à faire'; b.onclick = () => { stepSet(st.id, null); stepFocus = st.id; closeSheet(); syncSteps(); }; } /* v0.37.0 (Henri) : ↺ = remettre à faire ET retour à la carte, bandeau sur CETTE étape */
      else if (s !== 'done' && can) { b.textContent = '✓'; b.title = 'Fait'; b.onclick = () => stepSet(st.id, 'done'); }
      else b.style.visibility = 'hidden';
      li.append(b); ul.append(li); }); }
  /* bandeau */
  const bar = $('stepBar'); if (!bar) return;
  if (i < 0) { bar.classList.add('hidden'); syncStepBar(); return; }
  const st = STEPS[i], s = states[i], pr = st.chk ? stepProblems(st.chk) : [];
  /* v0.35.7 (Henri : bandeaux trop gros) : explication derrière un bouton ⓘ (bulle au-dessus du bandeau, ✕ pour fermer) ; seul un contrôle en défaut reste écrit */
  bar.innerHTML = `<div class="sh">Étape ${i + 1}/${n} · ${esc(st.t)}${s === 'recheck' ? ' <span class="rc">à revérifier</span>' : ''} <button class="sinfo" title="Explication">i</button></div><div class="sb"></div>`; /* v0.35.11 (Henri) : plus la liste des défauts dans le bandeau (les points en défaut sont orange sur la carte) ; elle reste dans la bulle ⓘ */
  bar.querySelector('.sinfo').onclick = () => !$('stepInfo').classList.contains('hidden') ? hideStepInfo() : showStepInfo( /* v0.35.13 (Henri) : réappui sur ⓘ = fermer */(s === 'recheck' ? 'À revérifier : la trace a bougé depuis que cette étape a été faite. ' : '') + st.d + (pr.length ? ' En défaut (orange sur la carte) : ' + pr.map(x => x.txt).join(' ; ') : ''));
  if (stepInfoFor !== st.id) hideStepInfo(); stepInfoFor = st.id;
  const sb = bar.querySelector('.sb'), btn = (t, f, c) => { const b = document.createElement('button'); b.textContent = t; if (c) b.className = c; b.onclick = f; sb.append(b); };
  if (pr.length) { btn('Reculer le point d\'alerte', () => miniBack(pr[0].k)); btn('Poser une zone', placeAlt); }
  else if (st.go) btn(st.goL || 'Aller', () => st.go(), 'go');
  if ((!st.auto && !st.chk) || s === 'recheck') btn('✓ Fait', () => stepSet(st.id, 'done'), 'ok');
  btn('Passer', () => stepSet(st.id, 'skip'));
  bar.classList.remove('hidden'); syncStepBar();
}
let stepInfoFor = null;
function showStepInfo(t) { const el = $('stepInfo'), bar = $('stepBar'); el.querySelector('span').textContent = t; el.classList.remove('hidden');
  const r = bar.getBoundingClientRect(); Object.assign(el.style, { left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px`, bottom: `${Math.round(innerHeight - r.top + 6)}px` }); }
function hideStepInfo() { const el = $('stepInfo'); if (el) el.classList.add('hidden'); }
/* v0.35.7 (Henri) : coche « bandeaux jaunes » à côté du titre Préparation pas à pas — cochée par défaut ; décochée = aucun bandeau de guidage, la liste continue de suivre ce qui est fait */
function guideOn() { return store.get('isv.guideBar', true) !== false; }
function syncStepBar() { /* masqué quand la feuille du bas ou la coupe est ouverte ; l'alerte « trace a bougé » se pose au-dessus */
  const bar = $('stepBar'), w = $('sumWarn'), busy = (() => { try { return !!(ptOpen || placing || suspended); } catch (e) { return false; } })(), hide = busy || (!guideOn() && !stepFocus) || !$('sheet').classList.contains('hidden') || !$('cutBox').classList.contains('hidden');
  bar.classList.toggle('off', hide); avoidQuick(bar); if (hide || bar.classList.contains('hidden')) hideStepInfo();
  w.style.bottom = !bar.classList.contains('hidden') && !hide ? `calc(${bar.offsetHeight + 52}px + env(safe-area-inset-bottom))` : '';
  avoidQuick(w);
}
/* v0.34.0 (photo d'Henri sur iPhone) : le bandeau d'étape couvrait le bouton 📏 de la colonne de gauche → s'il chevauche un bouton
   de la colonne, il démarre à droite de la colonne. Piège : lire la position des BOUTONS, jamais la largeur de #quick (bug Safari). */
function avoidQuick(el) {
  if (!el || el.classList.contains('hidden') || el.classList.contains('off')) return;
  /* v0.35.2 (2e photo d'Henri : toujours sur le 📏) : dès que le bandeau descend à hauteur de la colonne de gauche, il part à sa droite */
  const q = [...document.querySelectorAll('#quick button')].map(b => b.getBoundingClientRect()).filter(b => b.height); if (!q.length) { el.style.left = ''; return; }
  /* v0.35.4 (Henri : « tantôt à gauche, tantôt sur les boutons, ça me rend fou ») : TOUJOURS aligné sur le bord droit des boutons de gauche */
  el.style.left = `${Math.round(Math.max(...q.map(b => b.right)) + 8)}px`;
}
new MutationObserver(syncStepBar).observe($('sheet'), { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => setTimeout(syncStepBar, 300));
new MutationObserver(syncStepBar).observe($('cutBox'), { attributes: true, attributeFilter: ['class'] });
/* Briefing : étapes non faites en tête */
function briefSteps() { const el = $('briefSteps'); if (!el) return; const L = STEPS.map((st, k) => ({ st, k, s: stepState(st) })).filter(x => x.s !== 'done');
  el.innerHTML = L.length ? `<h3>Étapes non faites</h3><ul class="steps">${L.map(x => `<li class="st ${x.s}"><span class="si">${STEP_ICON[x.s]}</span>${x.k + 1}. ${esc(x.st.t)}${x.s === 'recheck' ? ' <small>à revérifier</small>' : x.s === 'skip' ? ' <small>passée</small>' : ''}</li>`).join('')}</ul>` : ''; }
syncOffline();
$('stepInfoX').addEventListener('click', hideStepInfo); $('bannerInfoX').addEventListener('click', hideBannerInfo);
$('guideBar').checked = guideOn(); $('guideBar').addEventListener('change', e => { store.set('isv.guideBar', e.target.checked); redraw(); syncStepBar(); });
window._stepsReady = true; syncSteps();
