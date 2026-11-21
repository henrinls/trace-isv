// trace-isv — calculs purs (sans écran, testables à part) : champ de vent, chute sous RSE, trace à cap constant,
// cercle de relaxation, vecteur de largage.
// Repère local : x = Est (m), y = Nord (m). Vent (u, v) = vers où va l'air. Caps en degrés VRAIS (l'affichage convertit en magnétique).
(function (root) {
  'use strict';
  const G = 9.81, RD = 287.05, RE = 6378137;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const n360 = h => ((h % 360) + 360) % 360;
  // Latitude moyenne des deux points : aller et retour exacts, distances justes à quelques mètres près sur 100 km (avec la
  // latitude de l'origine seule, l'écart atteignait 0,3 % : des points « sur le cercle » en paraissaient sortis de 100 à 300 m).
  const toLocal = (o, p) => ({ x: rad(p.lng - o.lng) * RE * Math.cos(rad((o.lat + p.lat) / 2)), y: rad(p.lat - o.lat) * RE });
  const fromLocal = (o, v) => { const lat = o.lat + deg(v.y / RE); return { lat, lng: o.lng + deg(v.x / (RE * Math.cos(rad((o.lat + lat) / 2)))) }; };
  const unit = h => ({ x: Math.sin(rad(h)), y: Math.cos(rad(h)) });
  const bearingOf = v => n360(deg(Math.atan2(v.x, v.y)));
  const dist = (a, b) => { const q = toLocal(a, b); return Math.hypot(q.x, q.y); };

  // ---------- Atmosphère standard ----------
  const stdP = hm => 1013.25 * Math.pow(1 - 0.0065 * hm / 288.15, 5.25588);
  const stdH = p => (1 - Math.pow(p / 1013.25, 1 / 5.25588)) * 288.15 / 0.0065;

  // ---------- Champ de vent ----------
  // F = { lat0, lng0, dLat, dLng, n, nodes[] } : grille n × n (ligne i = latitude, colonne j = longitude), rangée par rangée.
  // Chaque nœud : { elev, lv: [{ z, u, v, T }] trié par altitude z (m mer), pz: [{ p, z }] trié par pression décroissante }.
  // F absent : vent nul et atmosphère standard (pas encore de prévision).
  function lvAt(node, z) {
    const L = node.lv; if (!L.length) return { u: 0, v: 0, T: 15 - 0.0065 * z };
    if (z <= L[0].z) return L[0]; if (z >= L[L.length - 1].z) return L[L.length - 1];
    let a = 0, b = L.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (L[m].z <= z) a = m; else b = m; }
    const A = L[a], B = L[b], f = (z - A.z) / (B.z - A.z);
    const mix = k => (A[k] == null || B[k] == null) ? (A[k] != null ? A[k] : B[k]) : A[k] + (B[k] - A[k]) * f;
    return { u: mix('u'), v: mix('v'), T: mix('T'), RH: mix('RH') };
  }
  function zOfPn(node, p) { // altitude (m) d'une pression, interpolée en log p (extrapolée aux bouts)
    const pz = node.pz; if (!pz || pz.length < 2) return stdH(p);
    let a = pz[0], b = pz[1];
    for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (p >= b.p) break; }
    return a.z + (b.z - a.z) * (Math.log(p) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
  }
  function pOfZn(node, z) {
    const pz = node.pz; if (!pz || pz.length < 2) return stdP(z);
    let a = pz[0], b = pz[1];
    for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (z <= b.z) break; }
    return Math.exp(Math.log(a.p) + (Math.log(b.p) - Math.log(a.p)) * (z - a.z) / (b.z - a.z));
  }
  // Poids des 4 nœuds autour d'un point (hors grille : on prend le bord)
  function weights(F, lat, lng) {
    const fi = Math.max(0, Math.min(F.n - 1, (lat - F.lat0) / F.dLat)), fj = Math.max(0, Math.min(F.n - 1, (lng - F.lng0) / F.dLng));
    const i0 = Math.min(F.n - 2, Math.floor(fi)), j0 = Math.min(F.n - 2, Math.floor(fj)), a = fi - i0, b = fj - j0;
    if (F.n < 2) return [[F.nodes[0], 1]];
    return [[F.nodes[i0 * F.n + j0], (1 - a) * (1 - b)], [F.nodes[i0 * F.n + j0 + 1], (1 - a) * b],
      [F.nodes[(i0 + 1) * F.n + j0], a * (1 - b)], [F.nodes[(i0 + 1) * F.n + j0 + 1], a * b]].filter(w => w[1] > 1e-9 && w[0]);
  }
  function inGrid(F, p) { return !F || (p.lat >= F.lat0 && p.lat <= F.lat0 + (F.n - 1) * F.dLat && p.lng >= F.lng0 && p.lng <= F.lng0 + (F.n - 1) * F.dLng); }
  function windAt(F, lat, lng, z) {
    if (!F) return { u: 0, v: 0, T: 15 - 0.0065 * z };
    let u = 0, v = 0, T = 0, s = 0;
    weights(F, lat, lng).forEach(([nd, w]) => { const q = lvAt(nd, z); u += w * (q.u || 0); v += w * (q.v || 0); T += w * (q.T == null ? 15 - 0.0065 * z : q.T); s += w; });
    return s ? { u: u / s, v: v / s, T: T / s } : { u: 0, v: 0, T: 15 - 0.0065 * z };
  }
  // Vent moyen d'une tranche d'altitude, à la verticale d'un point
  function windMean(F, lat, lng, z1, z2) {
    if (!F) return { u: 0, v: 0 };
    const W = weights(F, lat, lng), n = Math.max(2, Math.ceil(Math.abs(z2 - z1) / 100)); let u = 0, v = 0;
    for (let k = 0; k <= n; k++) {
      const z = z1 + (z2 - z1) * k / n, c = (k === 0 || k === n) ? 0.5 : 1; let uu = 0, vv = 0, s = 0;
      W.forEach(([nd, w]) => { const q = lvAt(nd, z); uu += w * (q.u || 0); vv += w * (q.v || 0); s += w; });
      u += c * uu / s; v += c * vv / s;
    }
    return { u: u / n, v: v / n };
  }
  function zOfP(F, lat, lng, p) { if (!F) return stdH(p); let z = 0, s = 0; weights(F, lat, lng).forEach(([nd, w]) => { z += w * zOfPn(nd, p); s += w; }); return z / s; }
  function pOfZ(F, lat, lng, z) { if (!F) return stdP(z); let lp = 0, s = 0; weights(F, lat, lng).forEach(([nd, w]) => { lp += w * Math.log(pOfZn(nd, z)); s += w; }); return Math.exp(lp / s); }
  const flToAlt = (F, pt, fl) => zOfP(F, pt.lat, pt.lng, stdP(fl * 30.48));           // FL → altitude vraie (m mer)
  const altToFl = (F, pt, alt) => stdH(pOfZ(F, pt.lat, pt.lng, alt)) / 30.48;           // altitude vraie → FL
  // Humidité relative (%) à une altitude, à la verticale d'un point (null si la prévision n'en donne pas)
  function rhAt(F, lat, lng, z) {
    if (!F) return null; let h = 0, s = 0;
    weights(F, lat, lng).forEach(([nd, w]) => { // seulement entre les niveaux qui ont une humidité
      if (!nd.rh) nd.rh = nd.lv.filter(l => l.RH != null).map(l => ({ z: l.z, u: 0, v: 0, RH: l.RH }));
      if (!nd.rh.length) return; const q = lvAt({ lv: nd.rh }, z); if (q.RH != null) { h += w * q.RH; s += w; } });
    return s ? h / s : null;
  }
  const spdDir = w => ({ spd: Math.hypot(w.u, w.v), dir: n360(deg(Math.atan2(-w.u, -w.v))) });

  // ---------- Densité de l'air ----------
  // Les vitesses données (voile : Vx, Vz ; chute : vitesse stabilisée) sont vraies à 1 000 m en atmosphère standard.
  // À une autre densité, toute vitesse d'équilibre varie comme racine(densité de référence / densité) : la finesse ne change pas.
  // Pour une voile, elle varie aussi comme racine(MTE du para / 150 kg) (facteur can.mk).
  const RHO_REF = stdP(1000) * 100 / (RD * (288.15 - 6.5)); // 1,112 kg/m3
  const MTE_REF = 150; // kg : MTE pour laquelle les Vx et Vz d'une voile sont données (la MTE n'est PAS une caractéristique de la voile)
  function rhoAt(F, lat, lng, z) { return pOfZ(F, lat, lng, z) * 100 / (RD * (windAt(F, lat, lng, z).T + 273.15)); }
  const kRho = (F, lat, lng, z) => Math.sqrt(RHO_REF / rhoAt(F, lat, lng, z));
  // Facteur de vitesse de chute selon la profondeur z (m) sous l'avion : table par 100 m, remplie à la demande
  function ffK(F, pt, altRel) {
    const tab = [], g = j => tab[j] !== undefined ? tab[j] : (tab[j] = kRho(F, pt.lat, pt.lng, altRel - j * 100));
    return z => { const q = Math.max(0, z) / 100, i = Math.floor(q), a = g(i), b = g(i + 1); return a + (b - a) * (q - i); };
  }

  // ---------- Avion ----------
  // Vitesse indiquée (badin) → vitesse vraie à l'altitude de largage
  function tasOf(F, pt, alt, ias) {
    const p = pOfZ(F, pt.lat, pt.lng, alt) * 100, T = windAt(F, pt.lat, pt.lng, alt).T + 273.15;
    return ias * Math.sqrt(1.225 / (p / (RD * T)));
  }
  // Vitesse sol le long d'une route de cap h (l'avion corrige la dérive)
  function groundSpeed(tas, w, h) {
    const a = unit(h), along = w.u * a.x + w.v * a.y, cross = w.u * a.y - w.v * a.x;
    return Math.sqrt(Math.max(0, tas * tas - cross * cross)) + along;
  }

  // ---------- Chute sous RSE puis ouverture ----------
  // Le para sort à la vitesse de l'avion (vitesse vraie), vitesse verticale nulle ; traînée quadratique (vitesse limite vff).
  // Puis ouverture, sur l'axe de l'air (vitesse horizontale et verticale freinées ensemble jusqu'à la voile) :
  // elle dure toujours le même temps (v0.5.0), celui qui fait perdre openLoss mètres en chute stabilisée à 1 000 m
  // (de vff à vzCan : durée = 2 × openLoss / (vff + vzCan)). La perte de hauteur réelle dépend donc de la vitesse
  // VERTICALE au début de l'ouverture : faible juste après la sortie, forte en chute stabilisée en altitude.
  // (Avant : perte fixe de openLoss mètres quel que soit le cas, donc une ouverture de 12 s après 4 s de chute.)
  // Renvoie la perte de hauteur, la projection dans l'air (m, dans le sens du vol) et les pas (dz, dt) pour la dérive au vent.
  // kOf (facultatif) : facteur de vitesse selon la profondeur sous l'avion (ffK) ; absent : vitesse stabilisée constante.
  function fall(tFall, tas, vff, openLoss, vzCan, kOf) {
    const dt = 0.02, steps = []; let k = G / (vff * vff); let u = tas, w = 0, z = 0, s = 0, t = 0, acc = 0, z0 = 0;
    const N = Math.round(tFall / dt);
    for (let i = 0; i < N; i++) {
      if (kOf && i % 10 === 0) { const vt = vff * kOf(z); k = G / (vt * vt); }
      const sp = Math.hypot(u, w); u += -k * sp * u * dt; w += (G - k * sp * w) * dt; s += u * dt; z += w * dt; t += dt; acc += dt;
      if (acc >= 0.25 || i === N - 1) { steps.push({ z: (z0 + z) / 2, dt: acc, s, ze: z }); acc = 0; z0 = z; }
    }
    const dropFF = z, throwFF = s, w1 = w;
    const tO = openLoss > 0 ? 2 * openLoss / Math.max(1, vff + vzCan) : 0, M = Math.max(1, Math.round(tO / 0.25));
    const vzEnd = vzCan * (kOf ? kOf(z) : 1); // vitesse de la voile à cette hauteur
    for (let i = 0; i < M && tO > 0; i++) {
      const f0 = i / M, f1 = (i + 1) / M, fm = (f0 + f1) / 2, d = tO / M;
      const wz = w1 + (vzEnd - w1) * fm, uu = u * (1 - fm);
      const zm = z + wz * d / 2; z += wz * d; s += uu * d; steps.push({ z: zm, dt: d, s, ze: z });
    }
    return { drop: z, dropFF, throwFF, throwAir: s, tOpen: tO, time: tFall + tO, steps };
  }
  // Temps de chute qui donne une perte de hauteur totale voulue (chute + ouverture)
  function tFallFor(dropTotal, tas, vff, openLoss, vzCan, exact, kOf) {
    let a = 0, b = 400;
    if (fall(a, tas, vff, openLoss, vzCan, kOf).drop >= dropTotal) return 0;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (fall(m, tas, vff, openLoss, vzCan, kOf).drop < dropTotal) a = m; else b = m; }
    return exact ? (a + b) / 2 : Math.round((a + b) / 2 * 10) / 10;
  }
  // Dérive sous RSE : projection (sens du vol) + vent de chaque tranche traversée, du largage à l'ouverture terminée
  function rseDrift(F, pt, altRel, fl, acHeading) {
    const a = unit(acHeading); let x = a.x * fl.throwAir, y = a.y * fl.throwAir;
    fl.steps.forEach(st => { const w = windAt(F, pt.lat, pt.lng, altRel - st.z); x += w.u * st.dt; y += w.v * st.dt; });
    return { x, y };
  }

  // Chemin de la dérive sous RSE : position (m, par rapport au point de sortie) à la fin de chaque pas de la chute.
  // Même calcul que rseDrift (dernier point = rseDrift), mais on garde tout le chemin : il sert à la zone de sécurité.
  function rsePath(F, pt, altRel, fl, acHeading) {
    const a = unit(acHeading), out = [{ z: 0, x: 0, y: 0 }]; let wx = 0, wy = 0;
    fl.steps.forEach(st => { const w = windAt(F, pt.lat, pt.lng, altRel - st.z); wx += w.u * st.dt; wy += w.v * st.dt; out.push({ z: st.ze, x: a.x * st.s + wx, y: a.y * st.s + wy }); });
    return out;
  }

  // ---------- Trace à cap constant, calculée à rebours depuis le PTU ----------
  // Hauteurs : PTU, puis chaque hauteur ronde (pas de 500 m) au-dessus, jusqu'à l'ouverture terminée.
  function heights(hPtu, hOpen) {
    const hs = [hPtu]; let h = Math.floor(hPtu / 500 + 1e-9) * 500 + 500;
    while (h < hOpen - 1e-6) { hs.push(h); h += 500; }
    hs.push(hOpen); return hs;
  }
  // margin (0,2 = 20 %) : erreur possible sur le vent, égale à 20 % de sa force, comptée dans la pire direction pour le para
  // quel que soit son cap (de face). La voile avance donc, dans l'air, de vx − marge × force du vent ; le vent prévu s'ajoute
  // tel quel. La marge est la même à tous les caps : les ouvertures possibles forment un cercle, et toute trace part de son bord.
  // (Avant la v0.2.0 : vent multiplié par 0,8 ou 1,2 selon son signe dans l'axe du cap → marge dans l'axe du vent seulement,
  // zone pincée, traces qui sortaient du cercle. Ne pas y revenir.)
  function trace(F, ptu, elev0, hPtu, hOpen, can, cap, margin) {
    const hd = unit(cap), hs = heights(hPtu, hOpen), pts = [{ h: hPtu, lat: ptu.lat, lng: ptu.lng, t: 0 }];
    let P = { lat: ptu.lat, lng: ptu.lng }, len = 0, time = 0;
    for (let i = 1; i < hs.length; i++) {
      const kv = (can.mk || 1) * kRho(F, P.lat, P.lng, elev0 + (hs[i] + hs[i - 1]) / 2); // densité de la tranche, MTE
      const dt = (hs[i] - hs[i - 1]) / (can.vz * kv), W = windMean(F, P.lat, P.lng, elev0 + hs[i - 1], elev0 + hs[i]);
      const va = can.vx * kv - margin * Math.hypot(W.u, W.v);
      const dx = (va * hd.x + W.u) * dt, dy = (va * hd.y + W.v) * dt;
      P = fromLocal(P, { x: -dx, y: -dy }); len += Math.hypot(dx, dy); time += dt;
      pts.push({ h: hs[i], lat: P.lat, lng: P.lng, t: time });
    }
    const d = toLocal(ptu, P);
    return { pts, cap, length: len, direct: Math.hypot(d.x, d.y), time, top: P };
  }
  // Cap qui met l'ouverture le plus loin du PTU en ligne droite
  function bestCap(F, ptu, elev0, hPtu, hOpen, can, margin) {
    const f = c => trace(F, ptu, elev0, hPtu, hOpen, can, c, margin).direct;
    let best = 0, bd = -1;
    for (let c = 0; c < 360; c += 3) { const d = f(c); if (d > bd) { bd = d; best = c; } }
    for (const st of [1, 0.25, 0.05]) for (const s of [-2, -1, 1, 2]) { const c = best + s * st, d = f(c); if (d > bd) { bd = d; best = c; } }
    return n360(best);
  }
  // Cercle de relaxation (points d'OUVERTURE). La zone d'où le PTU reste atteignable est bordée par les ouvertures de toutes
  // les traces (tous caps, marge comprise) : un cercle exact si le vent est le même sur toute la zone, à peine déformé sinon.
  // Le cercle rendu est le plus grand cercle qui tient dans cette zone ET qui passe par l'ouverture de la trace au cap donné :
  // la trace part toujours pile de son bord. Sans cap (ou cas dégénéré) : cercle centré, de rayon la plus petite portée.
  function relaxCircle(F, ptu, elev0, hPtu, hOpen, can, margin, cap) {
    const top = (c, m) => trace(F, ptu, elev0, hPtu, hOpen, can, c, m).top;
    let la = 0, lo = 0, n = 0;
    for (let c = 0; c < 360; c += 15) { const q = top(c, 0); la += q.lat; lo += q.lng; n++; }
    const C0 = { lat: la / n, lng: lo / n }, Q = []; let Rin = Infinity, Rm = 0;
    for (let c = 0; c < 360; c += 5) { const p = top(c, margin), q = toLocal(C0, p), h = unit(c), r = -(q.x * h.x + q.y * h.y); Q.push(p); Rin = Math.min(Rin, r); Rm += r / 72; }
    const centered = { c: C0, R: Math.max(0, Rin) };
    if (cap == null || !(Rin > 1)) return centered;
    // Repère centré sur l'ouverture T de la trace : c'est là que le cercle doit être exact
    const T = top(cap, margin), A = toLocal(T, top(cap + 2, margin)), B = toLocal(T, top(cap - 2, margin)), c0 = toLocal(T, C0);
    let nx = -(A.y - B.y), ny = A.x - B.x; const nl = Math.hypot(nx, ny); if (nl < 1e-6) return centered;
    nx /= nl; ny /= nl; if (c0.x * nx + c0.y * ny < 0) { nx = -nx; ny = -ny; } // normale au bord, vers l'intérieur
    let rho = Infinity;
    for (const p of Q) { const d = toLocal(T, p), d2 = d.x * d.x + d.y * d.y, dot = d.x * nx + d.y * ny; if (d2 > 0.04 * Rm * Rm && dot > 1e-6) rho = Math.min(rho, d2 / (2 * dot)); }
    if (!isFinite(rho) || rho <= 0) return centered;
    return { c: fromLocal(T, { x: rho * nx, y: rho * ny }), R: rho };
  }
  // Point d'une polyligne (liste de { lat, lng, h }) le plus proche de q : distance, hauteur interpolée, abscisse
  function nearestOn(pts, q) {
    let best = null, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const b = toLocal(pts[i - 1], pts[i]), p = toLocal(pts[i - 1], q), L2 = b.x * b.x + b.y * b.y, L = Math.sqrt(L2);
      const f = L2 ? Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / L2)) : 0, d = Math.hypot(p.x - f * b.x, p.y - f * b.y);
      if (!best || d < best.d) best = { d, h: pts[i - 1].h + (pts[i].h - pts[i - 1].h) * f, s: acc + f * L, seg: i, f, pt: fromLocal(pts[i - 1], { x: f * b.x, y: f * b.y }) };
      acc += L;
    }
    return best;
  }
  // Point d'une polyligne à l'abscisse s (m depuis le premier point)
  function pointAt(pts, s) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const b = toLocal(pts[i - 1], pts[i]), L = Math.hypot(b.x, b.y);
      if (s <= acc + L || i === pts.length - 1) { const f = L ? Math.max(0, Math.min(1, (s - acc) / L)) : 0; return Object.assign(fromLocal(pts[i - 1], { x: f * b.x, y: f * b.y }), { h: pts[i - 1].h + (pts[i].h - pts[i - 1].h) * f }); }
      acc += L;
    }
    return pts[0];
  }
  // Cap et hauteur d'ouverture pour qu'une trace passe par un point d'ouverture donné (vecteur déplacé à la main)
  function capThrough(F, ptu, elev0, hPtu, hMax, can, margin, O) {
    const f = c => { const tr = trace(F, ptu, elev0, hPtu, hMax, can, c, margin); return Object.assign(nearestOn(tr.pts, O), { cap: n360(c) }); };
    let best = null;
    for (let c = 0; c < 360; c += 3) { const r = f(c); if (!best || r.d < best.d) best = r; }
    for (const st of [1, 0.3, 0.1, 0.03, 0.01]) { let moved = true, guard = 0; while (moved && guard++ < 8) { moved = false; for (const s of [-1, 1]) { const r = f(best.cap + s * st); if (r.d < best.d) { best = r; moved = true; } } } }
    return best; // { d (écart restant, m), h (hauteur sur la trace), cap }
  }

  // ---------- Temps de sortie ----------
  // team[i].dt = intervalle avec le para d'avant (le premier sort tGreen après le vert) ; rouge tRed après le dernier
  function exitTimes(team, tGreen, tRed) {
    const te = []; let t = +tGreen || 0;
    team.forEach((p, i) => { if (i > 0) t += Math.max(0, +p.dt || 0); te.push(t); });
    return { te, total: t + (+tRed || 0) };
  }
  const defaultDropIdx = n => Math.floor(n / 2); // celui du milieu ; nombre pair : le second des deux du milieu

  // ---------- Résolution complète d'une ISV ----------
  // isv : { ptu, zmt, hPtu, team[], tGreen, tRed, fl, acMs, tFall, capManual, vecHeading, reversed, dropIdx, manual, relaxRef }
  // prm : { canopies[{ id, name, vx, vz }], margin (%), openLoss, vff }
  function solve(isv, prm, F, elev0) {
    const out = { ok: false };
    if (!isv.ptu) { out.err = 'Place le point d\'entrée PTU.'; return out; }
    const team = isv.team || []; if (!team.length) { out.err = 'Ajoute au moins un parachutiste.'; return out; }
    const cans = prm.canopies || [], canOf = p => cans.find(c => c.id === p.canopy) || cans[0];
    if (!cans.length) { out.err = 'Ajoute au moins un parachute dans les Paramètres.'; return out; }
    for (const c of cans) if (!(+c.vx > 0) || !(+c.vz > 0)) { out.err = `Parachute « ${c.name} » : Vx et Vz doivent être supérieurs à 0.`; return out; }
    const margin = Math.max(0, +prm.margin || 0) / 100, openLoss = Math.max(0, +prm.openLoss || 0), vff = Math.max(10, +prm.vff || 50);
    const ptu = isv.ptu, hPtu = Math.max(0, +isv.hPtu || 0), ias = Math.max(10, +isv.acMs || 65);
    // Voile « effective » d'un para : sa voile + sa MTE (masse totale équipée du para, saisie dans l'équipe ; 150 kg à défaut)
    const effOf = p => { const c = canOf(p), m0 = MTE_REF, m = +p.mte > 0 ? +p.mte : m0; return { c, id: c.id, name: c.name, vx: +c.vx, vz: +c.vz, mte: m, mk: Math.sqrt(m / m0), key: c.id + '|' + m }; };
    const used = []; team.forEach(p => { const e = effOf(p); if (!used.some(u => u.key === e.key)) used.push(e); });
    const vzRef = Math.min(...used.map(c => +c.vz)); // fin d'ouverture : vitesse de la voile la plus lente à descendre (effet minime)

    // Largage au FL demandé → hauteur d'ouverture
    const relState = (fl, tf) => {
      const altRel = flToAlt(F, ptu, fl), hRel = altRel - elev0, tas = tasOf(F, ptu, altRel, ias);
      const kff = ffK(F, ptu, altRel), tFall = tf != null ? tf : Math.max(0, +isv.tFall || 0), f = fall(tFall, tas, vff, openLoss, vzRef, kff);
      return { fl, altRel, hRel, tas, tFall, f, kff, hOpen: hRel - f.drop };
    };
    let st = relState(+isv.fl || 295);
    if (st.hOpen <= hPtu + 50) { out.err = `Largage trop bas : ouverture à ${Math.round(st.hOpen)} m pour un PTU à ${Math.round(hPtu)} m.`; return out; }

    // Voile la moins performante : celle qui va le moins loin (en ligne droite) à son meilleur cap, ou au cap imposé
    const reach = (c, hOpen) => { const cap = isv.capManual != null ? isv.capManual : bestCap(F, ptu, elev0, hPtu, hOpen, c, margin); const tr = trace(F, ptu, elev0, hPtu, hOpen, c, cap, margin); return { c, cap, tr }; };
    let cand = used.map(c => reach(c, st.hOpen)).sort((a, b) => a.tr.direct - b.tr.direct), weak = cand[0];
    const wi = team.findIndex(p => effOf(p).key === weak.c.key);
    out.weak = { canopy: weak.c.c, mte: weak.c.mte, idx: wi, name: team[wi] && team[wi].name || '', several: used.length > 1 };

    // Vecteur déplacé à la main : le FL ne change pas. La trace doit passer par le nouveau point d'ouverture ; si elle y passe
    // plus bas que l'ouverture prévue, le para chute plus longtemps : la consigne devient « ouverture à x m » (centaine supérieure).
    let attach = null; const stPlan = st, capPlan = weak.cap;
    if (isv.manual && isv.capManual == null) {
      let O = null, sol = null, hCmd = null;
      for (let pass = 0; pass < 5; pass++) { // la dérive sous RSE dépend du temps de chute, qui dépend du point d'ouverture : on recale
        const ach = acHeadingOf(F, isv, st, traceDir(weak.tr.pts), isv.manual), dr = rseDrift(F, isv.manual, st.altRel, st.f, ach);
        O = fromLocal(isv.manual, dr);
        sol = capThrough(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, margin, O);
        /* v0.18.0 (Henri) : c'est la hauteur de COMMANDE d'ouverture (CDO, où le para tire) qui est arrondie à la centaine
           supérieure : CDO = arrondi(hauteur de la trace + perte à l'ouverture) ; ouverture terminée = CDO − perte (≥ la trace) */
        const dOpen = st.f.drop - st.f.dropFF;
        hCmd = Math.ceil((sol.h + dOpen) / 100 - 1e-6) * 100;
        const hNeed = Math.max(hPtu + 100, hCmd - dOpen);
        const prev = st.hOpen;
        st = hNeed >= stPlan.hOpen - 1 ? stPlan : relState(stPlan.fl, tFallFor(stPlan.hRel - hNeed, stPlan.tas, vff, openLoss, vzRef, true, stPlan.kff));
        if (st !== stPlan) { st.hOpen = hNeed; st.hCmd = hNeed + dOpen; } // hauteurs exactes (le calcul de chute avance par pas d'un mètre environ)
        weak = { c: weak.c, cap: sol.cap, tr: trace(F, ptu, elev0, hPtu, st.hOpen, weak.c, sol.cap, margin) };
        if (pass > 0 && Math.abs(st.hOpen - prev) < 1) break;
      }
      out.manualGap = sol.d; attach = O;
      if (sol.d > 100) out.warn = 'Ce point de largage est hors de portée : le PTU ne peut pas être rejoint depuis là.';
    }
    const tr = weak.tr, ptsDown = tr.pts.slice().reverse(); // de l'ouverture terminée vers le PTU
    out.cap = n360(weak.cap); out.capAuto = isv.capManual == null && !isv.manual;
    out.trace = ptsDown; out.direct = tr.direct; out.length = tr.length; out.ouv = ptsDown[0];
    Object.assign(out, { hCmd: st.hCmd != null ? st.hCmd : st.hOpen + (st.f.drop - st.f.dropFF), fl: st.fl, openLowered: st !== stPlan, hOpenPlan: stPlan.hOpen, tFallPlan: stPlan.tFall, hRel: st.hRel, altRel: st.altRel, hOpen: st.hOpen, tas: st.tas, tFall: st.tFall, drop: st.f.drop, openDrop: st.f.drop - st.f.dropFF, tOpen: st.f.tOpen, elev0, vzRef, margin });

    // Cap de l'avion : perpendiculaire au premier segment de la trace, sens le plus face au vent (ou cap choisi), ⇅ Sens l'inverse
    const dir1 = traceDir(tr.pts), acHeading = acHeadingOf(F, isv, st, dir1, ptsDown[0]);
    const wRel = windAt(F, ptsDown[0].lat, ptsDown[0].lng, st.altRel);
    const vg = groundSpeed(st.tas, wRel, acHeading), a = unit(acHeading);
    const dr = rseDrift(F, ptsDown[0], st.altRel, st.f, acHeading);
    Object.assign(out, { acHeading, vg, windRel: spdDir(wRel), rse: dr, rseLen: Math.hypot(dr.x, dr.y) });
    if (vg < 5) { out.err = 'Vent de face plus fort que l\'avion sur ce cap : change le sens ou le cap du vecteur.'; return out; }

    // Cercle de relaxation : en points d'ouverture, puis décalé de la dérive sous RSE pour l'avoir en points de largage
    // Cercle de relaxation affiché = zone avec marge (v0.2.1, choix d'Henri ; en v0.2.0 on affichait le cercle sans marge).
    // La trace, calculée avec la marge, part de son bord ; le vecteur ne peut pas en sortir.
    const man = !!(isv.manual && isv.capManual == null), capShow = man ? capPlan : weak.cap;
    const circ = relaxCircle(F, ptu, elev0, hPtu, st.hOpen, weak.c, margin, weak.cap);          // contrôle du vecteur (hauteur d'ouverture réelle)
    const zonePlan = man ? relaxCircle(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, margin, capPlan) : circ; // limite du déplacement à la main
    const circShow = zonePlan; /* v0.2.1 (Henri) : le cercle affiché EST la zone avec marge */
    const drShow = st !== stPlan ? rseDrift(F, circShow.c, stPlan.altRel, stPlan.f, acHeading) : dr;
    if (!(circ.R > 0)) out.warn = (out.warn ? out.warn + ' ' : '') + `Avec ce vent et ${Math.round(margin * 100)} % de marge, aucun point de largage ne garantit de rejoindre le PTU.`;
    const toDrop = (c, d) => ({ c: fromLocal(c.c, { x: -d.x, y: -d.y }), R: c.R });
    out.circleOuv = circShow; out.circle = toDrop(circShow, drShow);
    out.zoneOuv = circ; out.zone = toDrop(zonePlan, drShow);

    // Vecteur : le para choisi s'ouvre sur la trace ; on fait glisser ce point le long de la trace (vers le PTU) jusqu'à ce que
    // le vert et le rouge soient dans la zone avec marge (non affichée). La trace ne change pas.
    const ex = exitTimes(team, isv.tGreen, isv.tRed), n = team.length;
    const idx = (isv.dropIdx != null && isv.dropIdx >= 0 && isv.dropIdx < n) ? isv.dropIdx : defaultDropIdx(n);
    const sBefore = vg * ex.te[idx], sAfter = vg * (ex.total - ex.te[idx]), L = sBefore + sAfter;
    const total = (() => { let s = 0; for (let i = 1; i < ptsDown.length; i++) s += dist(ptsDown[i - 1], ptsDown[i]); return s; })();
    const cO = circ.c, inside = p => dist(cO, p) <= circ.R + 0.5;
    const ends = o => [fromLocal(o, { x: -a.x * sBefore, y: -a.y * sBefore }), fromLocal(o, { x: a.x * sAfter, y: a.y * sAfter })];
    let s0 = attach ? nearestOn(ptsDown, attach).s : 0, sFit = null;
    for (let s = s0; s <= total; s += Math.max(5, total / 4000)) { const o = pointAt(ptsDown, s), e = ends(o); if (inside(e[0]) && inside(e[1])) { sFit = s; break; } }
    if (sFit == null) { out.warn = out.warn || '' ; out.warn = (out.warn ? out.warn + ' ' : '') + (L > 2 * circ.R ? `Vecteur (${Math.round(L)} m) plus long que le cercle de relaxation${st !== stPlan ? ' à cette hauteur d\'ouverture' : ''} (${Math.round(2 * circ.R)} m de diamètre) : il ne peut pas y rentrer.` : `Le vecteur ne rentre pas dans le cercle de relaxation sur ce cap : tourne-le ou change de para sur le point de largage.`); sFit = s0; }
    const oAtt = pointAt(ptsDown, sFit), eO = ends(oAtt), shift = p => fromLocal(p, { x: -dr.x, y: -dr.y });
    out.slide = sFit; out.attachOuv = oAtt; out.attachH = oAtt.h; out.dropIdx = idx;
    out.vec = { heading: acHeading, length: L, green: shift(eO[0]), red: shift(eO[1]), attach: shift(oAtt),
      exits: ex.te.map((t, i) => Object.assign(shift(fromLocal(oAtt, { x: a.x * vg * (t - ex.te[idx]), y: a.y * vg * (t - ex.te[idx]) })), { t, i })) };
    out.ex = ex;

    // Point de relaxation et temps de largage « −5 s / +10 s »
    const ref = isv.relaxRef === 'red' ? ex.total : (typeof isv.relaxRef === 'number' && isv.relaxRef < n ? ex.te[isv.relaxRef] : 0);
    out.relax = { t: ref, before: -ref, after: ex.total - ref, pt: shift(fromLocal(oAtt, { x: a.x * vg * (ref - ex.te[idx]), y: a.y * vg * (ref - ex.te[idx]) })) };

    // Para sur le point de largage, avec sa propre voile : temps sous voile, passage du FL180 et du FL120 depuis le vert
    // Temps de descente d'une voile entre deux hauteurs, le long de la trace (densité de chaque tranche de 250 m)
    const posAtH = h => { const P = tr.pts; for (let i = 1; i < P.length; i++) if (h <= P[i].h || i === P.length - 1) { const f = Math.max(0, Math.min(1, (h - P[i - 1].h) / Math.max(1e-6, P[i].h - P[i - 1].h))); return { lat: P[i - 1].lat + (P[i].lat - P[i - 1].lat) * f, lng: P[i - 1].lng + (P[i].lng - P[i - 1].lng) * f }; } return P[0]; };
    const tUnder = (can, hTop, hBot) => { let t = 0; for (let h = hBot; h < hTop - 1e-6;) { const h2 = Math.min(hTop, h + 250), hm = (h + h2) / 2, q = posAtH(hm); t += (h2 - h) / (can.vz * can.mk * kRho(F, q.lat, q.lng, elev0 + hm)); h = h2; } return t; };
    const own = effOf(team[idx]), tCan = tUnder(own, st.hOpen, hPtu);
    const tPass = fl => {
      if (st.fl <= fl) return null;
      const dz = st.altRel - flToAlt(F, ptu, fl); // hauteur à perdre depuis le largage
      if (dz <= st.f.drop) { let t = 0; for (const s2 of st.f.steps) { t += s2.dt; if (s2.z >= dz) break; } return ex.te[idx] + t; }
      return ex.te[idx] + st.f.time + tUnder(own, st.hOpen, Math.max(hPtu, st.hRel - dz));
    };
    out.own = { canopy: own.c, mte: own.mte, tCanopy: tCan, t180: tPass(180), t120: tPass(120) };
    out.weakTime = tr.time; out.kOpen = weak.c.mk * kRho(F, ptsDown[0].lat, ptsDown[0].lng, elev0 + st.hOpen); out.weakEff = { vx: weak.c.vx, vz: weak.c.vz, mk: weak.c.mk };

    // Prise de cap : le para sort dos au sens de vol ; côté où il tourne pour se mettre au cap para
    const dTurn = ((dir1 - (acHeading + 180) + 720 + 180) % 360) - 180; // côté où part la trace, vu du para qui sort dos au sens de vol
    out.turn = Math.abs(dTurn) < 1 || Math.abs(Math.abs(dTurn) - 180) < 1 ? null : (dTurn > 0 ? 'droite' : 'gauche');
    // PTU main droite / gauche : côté de la trace où se trouve la zone de posé, dans le sens d'arrivée sur le PTU
    if (isv.zmt) {
      const k2 = ptsDown.length, d = toLocal(ptsDown[k2 - 2], ptsDown[k2 - 1]), z = toLocal(ptsDown[k2 - 1], isv.zmt), cr = d.x * z.y - d.y * z.x;
      out.hand = Math.hypot(z.x, z.y) < 1 ? null : (cr > 0 ? 'gauche' : 'droite');
    }
    out.ok = true; return out;
  }
  // Direction du premier segment de la trace (de l'ouverture vers le point suivant), pts donnés du PTU vers le haut
  function traceDir(ptsUp) { const k = ptsUp.length; return bearingOf(toLocal(ptsUp[k - 1], ptsUp[k - 2])); }
  function acHeadingOf(F, isv, st, dir1, pos) {
    let h;
    if (isv.vecHeading != null) h = isv.vecHeading;
    else {
      const q = pos || isv.ptu, w = windAt(F, q.lat, q.lng, st.altRel), c1 = n360(dir1 + 90), c2 = n360(dir1 - 90), u1 = unit(c1);
      h = (w.u * u1.x + w.v * u1.y) <= 0 ? c1 : c2; // le plus face au vent de largage (vent nul : trace à gauche de l'avion)
    }
    return n360(isv.reversed ? h + 180 : h);
  }

  const api = { toLocal, fromLocal, unit, bearingOf, dist, n360, stdP, stdH, RHO_REF, MTE_REF, rhoAt, kRho, ffK, windAt, rhAt, windMean, zOfP, pOfZ, flToAlt, altToFl, spdDir, inGrid,
    tasOf, groundSpeed, fall, tFallFor, rseDrift, rsePath, heights, trace, bestCap, relaxCircle, nearestOn, pointAt, capThrough, exitTimes, defaultDropIdx, solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
