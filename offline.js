// v0.52.0 (Henri, 25/11/2026) — version hors ligne, partie A : lignes électriques (OpenStreetMap), appli standalone (un seul fichier
// HTML, toujours en mode autonome), archive automatique des préparations dans un dossier (Edge / Chrome), insignes GAP et STAT
// (version autonome seulement). Les variables de app.js (current, prm, isv, toast…) sont visibles ici : même portée globale.
(function () {
  const SA = !!window.ISV_STANDALONE;
  const IDB = (() => { let p = null;
    const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('trace-isv', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = (m, f) => open().then(db => new Promise((res, rej) => { const t = db.transaction('kv', m), q = f(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
    return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) }; })();
  window.ISV_IDB = IDB;
  const hm = ts => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} à ${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`; };

  // ---------- Lignes électriques ----------
  /* Une couche par zone, gardée dans IndexedDB (pas dans la zone : elle peut peser lourd et la zone est recopiée dans localStorage).
     Source : OpenStreetMap (Overpass), power=line et power=minor_line, dans un carré de prm.plKm autour de la ZMT. Indicatif. */
  const PW = { key: null, v: undefined, busy: false, tried: {} };
  const pwKey = () => 'power:' + (current.id || 'tmp');
  function pwData() { const k = pwKey(); if (PW.key !== k) { PW.key = k; PW.v = undefined;
      IDB.get(k).then(v => { if (PW.key !== k) return; PW.v = v || null; pwFill(); if (current.show.power) redraw(); powerAuto(false); }).catch(() => { if (PW.key === k) PW.v = null; }); }
    return PW.v || null; }
  window.powerLines = () => { const v = pwData(); return v && v.lines ? v.lines : []; };
  const renderer = L.canvas({ padding: 0.3 });
  let attrOn = false;
  window.drawPower = (layer, on) => { const Ls = on ? powerLines() : []; Ls.forEach(l => { L.polyline(l.p, { renderer, color: '#000', weight: l.k === 'minor' ? 3.4 : 4.6, opacity: 0.45, interactive: false }).addTo(layer); L.polyline(l.p, { renderer, color: '#ffc400', weight: l.k === 'minor' ? 1.5 : 2.4, opacity: 0.95, interactive: false }).addTo(layer); });
    const want = Ls.length > 0; if (want !== attrOn && map.attributionControl) { attrOn = want; const t = 'Lignes électriques © contributeurs OpenStreetMap'; if (want) map.attributionControl.addAttribution(t); else map.attributionControl.removeAttribution(t); } };
  /* v0.52.1 (Henri) : carré de prm.plKm autour de la ZMT ET couloir de prm.plTraceKm de part et d'autre de la trace (et autour des points
     OSO), pour choisir les zones de posé alternatives tout du long. Seules les parties pas encore couvertes sont téléchargées. */
  const boxOf = (pts, m) => { let s = 90, w = 180, n = -90, e = -180; pts.forEach(p => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); });
    const dLat = m / 111320, dLng = m / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180)); return [s - dLat, w - dLng, n + dLat, e + dLng]; };
  const inside = (b, c) => b[0] >= c[0] - 1e-4 && b[1] >= c[1] - 1e-4 && b[2] <= c[2] + 1e-4 && b[3] <= c[3] + 1e-4;
  function pwNeeded() { const z = zmtOf(); if (!z) return []; const out = [boxOf([z], Math.max(1, +prm.plKm || 15) * 1000)], W = Math.max(0.2, +prm.plTraceKm || 3) * 1000;
    const traces = []; try { const P = passInfo() ? passSols() : [{ sol }]; P.forEach(p => { if (p.sol && p.sol.ok && p.sol.trace) traces.push(p.sol.trace); }); } catch (e) {}
    traces.forEach(T => { let chunk = [T[0]], d = 0; for (let i = 1; i < T.length; i++) { d += Calc.dist(T[i - 1], T[i]); chunk.push(T[i]); if (d >= 8000 || i === T.length - 1) { out.push(boxOf(chunk, W)); chunk = [T[i]]; d = 0; } } });
    try { (greyPoints() || []).forEach(y => out.push(boxOf([y], W))); } catch (e) {}
    return out; }
  async function powerAuto(force) {
    if (SA || prm.offline) { if (force) toast('Mode autonome : pas de téléchargement. Importe un fichier GeoJSON.'); return; }
    const z = zmtOf(); if (!z) { if (force) toast('Pose d\'abord la ZMT de la zone'); return; }
    const k = pwKey(); pwData(); if (PW.v === undefined && !force) return; /* lecture en cours : relancé à la fin */
    let have = PW.v; if (have && have.src === 'import' && !force) return; if (force || (have && have.src === 'import')) have = null;
    const cover = have ? (have.cover || (have.center ? [boxOf([have.center], (have.km || 15) * 1000)] : [])) : [];
    const miss = pwNeeded().filter(b => !cover.some(c => inside(b, c))); if (!miss.length) { if (force) toast('Lignes électriques déjà à jour pour la ZMT et la trace'); return; }
    const tk = k + '|' + miss.map(b => b.map(v => v.toFixed(3)).join(',')).join(';'); if ((!force && PW.tried[tk]) || PW.busy) return; PW.tried[tk] = 1; PW.busy = true; pwFill();
    try {
      const q = `[out:json][timeout:120];(${miss.map(b => `way["power"~"^(line|minor_line)$"](${b.map(v => v.toFixed(5)).join(',')});`).join('')});out tags geom;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('HTTP ' + r.status); const js = await r.json(), r5 = x => Math.round(x * 1e5) / 1e5;
      const got = (js.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1).map(e => ({ id: e.id, k: e.tags && e.tags.power === 'minor_line' ? 'minor' : 'line', v: (e.tags && e.tags.voltage) || '', p: e.geometry.map(g => [r5(g.lat), r5(g.lon)]) }));
      const ids = new Set(), lines = []; (have ? have.lines : []).concat(got).forEach(l => { if (l.id != null) { if (ids.has(l.id)) return; ids.add(l.id); } lines.push(l); });
      const v = { src: 'osm', name: 'OpenStreetMap', fetched: Date.now(), center: { lat: z.lat, lng: z.lng }, km: Math.max(1, +prm.plKm || 15), wkm: Math.max(0.2, +prm.plTraceKm || 3), cover: cover.concat(miss), lines };
      await IDB.set(k, v); if (PW.key === k) PW.v = v; if (current.show.power) redraw();
      if (force) toast(`Lignes électriques : ${lines.length} tronçon(s), ZMT et trace`);
    } catch (er) { console.warn('Lignes électriques', er); if (force) toast('Lignes électriques : téléchargement impossible (réseau ?)'); }
    finally { PW.busy = false; pwFill(); }
  }
  window.powerAuto = powerAuto;
  function pwFill() { const el = document.getElementById('pwInfo'); if (!el) return; const v = PW.key === pwKey() ? PW.v : undefined;
    el.textContent = PW.busy ? 'Téléchargement des lignes électriques…' : v === undefined ? '' : !v ? 'Aucune ligne électrique pour cette zone.' :
      `${v.lines.length} tronçon(s) · ${v.src === 'import' ? `importées (« ${v.name} »)` : `OpenStreetMap, mises à jour le ${hm(v.fetched)} : ${v.km} km autour de la ZMT et ${v.wkm || 3} km de part et d'autre de la trace`}${current.show.power ? '' : ' · masquées (bouton Affichage)'}`;
    $('btnPwGet').classList.toggle('hidden', SA || !!prm.offline); }
  $('btnPwGet').addEventListener('click', () => powerAuto(true));
  $('btnPwDel').addEventListener('click', async () => { if (!pwData()) return toast('Aucune ligne électrique pour cette zone'); if (!(await ask('Retirer les lignes électriques de cette zone ?'))) return;
    const k = pwKey(); await IDB.del(k); PW.v = null; PW.tried = {}; PW.tried[`${k}|${(zmtOf() || { lat: 0 }).lat.toFixed(3)}`] = 1; pwFill(); redraw(); });
  $('btnPwExp').addEventListener('click', async () => { const v = pwData(); if (!v || !v.lines.length) return toast('Aucune ligne électrique pour cette zone');
    const fc = { type: 'FeatureCollection', name: `Lignes électriques ${current.name || ''}`.trim(), attribution: '© contributeurs OpenStreetMap (ODbL)', trace_isv: { kind: 'power', center: v.center, km: v.km, wkm: v.wkm, cover: v.cover, fetched: v.fetched },
      features: v.lines.map(l => ({ type: 'Feature', properties: Object.assign({ power: l.k === 'minor' ? 'minor_line' : 'line' }, l.v ? { voltage: l.v } : {}), geometry: { type: 'LineString', coordinates: l.p.map(a => [a[1], a[0]]) } })) };
    await shareJson(fc, `${fileSafe(current.name || 'zone')}_lignes_electriques.geojson`); });
  $('btnPwImp').addEventListener('click', async () => { if (!(await askZoneName())) return; $('pwFile').value = ''; $('pwFile').click(); });
  $('pwFile').addEventListener('change', async e => { const f = e.target.files && e.target.files[0]; if (!f) return;
    try { const txt = await f.text(), js = JSON.parse(txt), raw = parseGeoJsonLines(txt); if (!raw.length) return toast('Aucune ligne dans ce fichier');
      const feats = js.type === 'FeatureCollection' ? js.features || [] : [], meta = js.trace_isv || {};
      const lines = raw.map((p, i) => { const pr = (feats[i] && feats[i].properties) || {}; return { k: pr.power === 'minor_line' ? 'minor' : 'line', v: pr.voltage || '', p: Array.from(p) }; });
      const v = { src: 'import', name: f.name, fetched: meta.fetched || Date.now(), center: meta.center || null, km: meta.km || null, wkm: meta.wkm || null, cover: meta.cover || null, lines }, k = pwKey();
      await IDB.set(k, v); PW.key = k; PW.v = v; pwFill(); redraw();
      toast(`Lignes électriques importées : ${lines.length} tronçon(s)${current.show.power ? '' : ' · affiche-les avec le bouton Affichage'}`);
    } catch (er) { console.error(er); toast('Fichier illisible (GeoJSON attendu)'); } });

  // ---------- Appli standalone : un seul fichier HTML ----------
  async function buildStandalone() {
    const get = async p => { const r = await fetch(p, { cache: 'no-cache' }); if (!r.ok) throw new Error(p + ' : HTTP ' + r.status); return r; };
    const b64 = async p => { const u = new Uint8Array(await (await get(p)).arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const safe = s => s.replace(/<\/(script)/gi, '<\\/$1');
    let html = await (await get('index.html')).text();
    let lcss = await (await get('vendor/leaflet.css')).text();
    for (const m of [...new Set(lcss.match(/url\(images\/[a-z0-9-]+\.png\)/gi) || [])]) { const f = m.slice(4, -1); lcss = lcss.split(m).join(`url(data:image/png;base64,${await b64('vendor/' + f)})`); }
    const css = await (await get('style.css')).text();
    html = html.replace(/<link rel="manifest"[^>]*>\s*/, '').replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '')
      .replace(/<link rel="stylesheet" href="vendor\/leaflet\.css">/, () => `<style>${lcss}</style>`)
      .replace(/<link rel="stylesheet" href="style\.css[^"]*">/, () => `<style>${css}</style>`);
    const srcs = [...html.matchAll(/<script src="([^"?]+)(\?[^"]*)?"><\/script>/g)];
    for (const m of srcs) { const js = await (await get(m[1])).text(); html = html.replace(m[0], () => `<script>/* ${m[1]} */\n${safe(js)}\n</script>`); }
    const lazy = ['vendor/jspdf.umd.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js'];
    let extra = ''; for (const p of lazy) extra += `<script type="text/plain" id="sa:${p}">${safe(await (await get(p)).text())}</script>\n`;
    const stamp = { v: VERSION, built: new Date().toISOString() };
    html = html.replace('<body>', () => `<body>\n<script>window.ISV_STANDALONE=${JSON.stringify(stamp)};</script>`).replace('<title>trace-isv</title>', `<title>trace-isv (autonome v${VERSION})</title>`);
    const e = html.lastIndexOf('</body>'); html = html.slice(0, e) + extra + html.slice(e); /* piège : « </body> » figure aussi dans le code intégré (ce fichier) → remplacer le DERNIER */
    return html;
  }
  window.buildStandalone = buildStandalone;
  $('btnStandalone').addEventListener('click', async () => {
    toast('Préparation du fichier…');
    try { const html = await buildStandalone(), name = `${dateStamp()}_trace-isv_autonome_v${VERSION}.html`, file = new File([html], name, { type: 'text/html' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
      const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Fichier « ${name} » créé (${(html.length / 1048576).toFixed(1)} Mo) : ouvre-le avec Edge`);
    } catch (er) { console.error(er); toast('Création impossible : ouvre l\'appli en ligne (avec Internet) une fois, puis réessaie'); } });

  // ---------- Archive automatique des préparations ----------
  /* Un fichier par préparation (ISV, ou passage entier), au format de « Exporter l'ISV », réécrit à chaque modification (4 s après).
     Dossier choisi une fois (File System Access : Edge / Chrome sur ordinateur) ; l'autorisation d'écrire est redemandée par le
     navigateur à chaque ouverture (protection d'Edge) : barre « Archive en pause → Autoriser ». */
  const ARCH = { api: typeof window.showDirectoryPicker === 'function', h: null, ok: false, last: {}, t: null, msg: '' };
  async function archInit() { if (!ARCH.api) return archSync(); try { ARCH.h = (await IDB.get('archDir')) || null; } catch (e) { ARCH.h = null; }
    if (ARCH.h) { try { ARCH.ok = (await ARCH.h.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { ARCH.ok = false; } }
    archSync(); if (ARCH.ok) archSoon(500); }
  async function archChoose() { if (!ARCH.api) return toast('Ce navigateur ne sait pas écrire dans un dossier : ouvre l\'appli avec Edge'); try { const h = await window.showDirectoryPicker({ id: 'trace-isv', mode: 'readwrite' });
      await IDB.set('archDir', h); ARCH.h = h; ARCH.ok = true; ARCH.last = {}; archSync(); archSoon(0); toast(`Archive : dossier « ${h.name} »`); return true; }
    catch (e) { if (!e || e.name !== 'AbortError') { console.error(e); toast('Dossier impossible à choisir'); } return false; } }
  window.archChoose = archChoose;
  async function archAllow() { if (!ARCH.h) return archChoose(); try { ARCH.ok = (await ARCH.h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { ARCH.ok = false; } archSync(); if (ARCH.ok) archSoon(0); }
  function archSoon(ms) { if (!ARCH.h || !ARCH.ok) return; clearTimeout(ARCH.t); ARCH.t = setTimeout(archWrite, ms == null ? 4000 : ms); }
  async function archWrite() { const I = isv(); if (!I || (!I.ptu && !zmtOf(I))) return; const T = passTeams(I), name = isvExportName(T), s = JSON.stringify(isvExportObj(T, store.get('isv.author', '')), (k, v) => (k === 'exported' ? undefined : v), 1);
    if (ARCH.last[name] === s) return;
    try { const fh = await ARCH.h.getFileHandle(name, { create: true }), w = await fh.createWritable(); await w.write(s.replace('"app": "trace-isv",', `"app": "trace-isv",\n "exported": "${new Date().toISOString()}",`)); await w.close(); ARCH.last[name] = s; ARCH.msg = `Dernière archive : « ${name} », ${hm(Date.now())}`; archSync(); }
    catch (e) { console.error(e); ARCH.ok = false; archSync(); } }
  window.onPersist = () => archSoon();
  function archSync() { const el = document.getElementById('archInfo'); if (el) el.textContent = !ARCH.api ? 'Ce navigateur ne sait pas écrire dans un dossier (Firefox, téléphone) : « Archiver maintenant » télécharge le fichier.' : !ARCH.h ? 'Aucun dossier choisi.' : `Dossier « ${ARCH.h.name} » · ${ARCH.ok ? ARCH.msg || 'archive active' : 'en pause : autorisation à redonner'}`;
    $('btnArchDir').classList.toggle('hidden', !ARCH.api); $('archBar').classList.toggle('hidden', !(ARCH.h && !ARCH.ok)); }
  $('btnArchDir').addEventListener('click', archChoose);
  $('archAllow').addEventListener('click', archAllow);
  $('btnArchNow').addEventListener('click', async () => { persist(); if (ARCH.h) { if (!ARCH.ok) await archAllow(); if (ARCH.ok) { ARCH.last = {}; await archWrite(); toast(ARCH.msg || 'Archivé'); } return; }
    const T = passTeams(isv()); await shareJson(isvExportObj(T, store.get('isv.author', '')), isvExportName(T)); });

  // ---------- Insignes (version autonome seulement) ----------
  const insGet = () => store.get('isv.insignes', {}) || {};
  function insSync() { const I = insGet(), box = document.getElementById('insignes'); if (!box) return; const on = SA && (I.gap || I.stat);
    box.classList.toggle('hidden', !on); $('insGapImg').src = (SA && I.gap) || ''; $('insStatImg').src = (SA && I.stat) || ''; $('insBox').classList.toggle('hidden', !SA); }
  function pickImage() { return new Promise(res => { const inp = $('insFile'); inp.value = ''; inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return res(null);
      const rd = new FileReader(); rd.onload = () => { const img = new Image(); img.onload = () => { const s = Math.min(1, 160 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/png')); }; img.onerror = () => res(null); img.src = rd.result; }; rd.readAsDataURL(f); };
    inp.click(); }); }
  async function insSet(k) { const d = await pickImage(); if (!d) return; const I = insGet(); I[k] = d; store.set('isv.insignes', I); insSync(); toast(`Insigne ${k === 'gap' ? 'du GAP' : 'de la STAT'} enregistré`); }
  $('btnInsGap').addEventListener('click', () => insSet('gap'));
  $('btnInsStat').addEventListener('click', () => insSet('stat'));
  $('btnInsDel').addEventListener('click', async () => { if (!(await ask('Retirer les deux insignes ?'))) return; store.set('isv.insignes', {}); insSync(); });

  // ---------- Remplissage (appelé par fillInputs) et premier lancement de la version autonome ----------
  window.offlineFill = () => { pwData(); pwFill(); archSync(); insSync();
    $('saRow').classList.toggle('hidden', SA); $('bmEsri').classList.toggle('hidden', SA); $('bmIgn').classList.toggle('hidden', SA); $('saHint').classList.toggle('hidden', SA);
    $('saNote').innerHTML = SA ? `<b>Version autonome v${esc(window.ISV_STANDALONE.v || VERSION)}</b> (fichier HTML créé le ${esc(String(window.ISV_STANDALONE.built || '').slice(0, 10))}) : jamais d'Internet ; tout se fait par fichiers importés.` : ''; };
  async function firstRun() { if (!SA || store.get('isv.saWelcome', false)) return;
    const txt = ARCH.api ? 'Version autonome de trace-isv : elle ne va jamais sur Internet. Choisis le dossier où ranger automatiquement les préparations (un fichier par ISV, réimportable).' : '⚠️ Ce navigateur ne sait pas ranger les sauvegardes dans un dossier : ouvre ce fichier avec Edge. Sinon, les sauvegardes passeront par Téléchargements (bouton « Archiver maintenant », onglet Zones).';
    const r = await choose(txt, ARCH.api ? [['later', 'Plus tard'], ['dir', 'Choisir le dossier']] : [['ok', 'Compris']]); if (r === 'dir') await archChoose();
    const I = insGet(); if (!I.gap || !I.stat) { const r2 = await choose('Insignes du GAP et de la STAT, affichés en haut de l\'écran : choisis les deux images (une fois pour toutes ; modifiables dans Paramètres).', [['later', 'Plus tard'], ['go', 'Choisir les images']]);
      if (r2 === 'go') { if (!I.gap) await insSet('gap'); if (!insGet().stat) { if ((await choose('Maintenant l\'insigne de la STAT.', [['later', 'Plus tard'], ['go', 'Choisir l\'image']])) === 'go') await insSet('stat'); } } }
    store.set('isv.saWelcome', true); }
  archInit().then(() => setTimeout(firstRun, 600));
  insSync(); pwData(); try { offlineFill(); } catch (e) { console.error(e); }
  setInterval(() => { if (!document.hidden) powerAuto(false); }, 20000); /* ZMT posée ou déplacée : téléchargement automatique (en ligne seulement) */
})();
