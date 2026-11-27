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
  /* v0.31.0 (Henri) : Vx et Vz d'une voile saisies telles que mesurées, avec la hauteur (altitude, atmosphère standard) et la MTE de la
     mesure ; ramenées ici aux valeurs de référence (1 000 m, 150 kg) : v_ref = v_mesurée × √(ρ(h mesure) / ρ_ref) × √(150 / MTE mesure) */
  const rhoStd = h => stdP(h) * 100 / (RD * (288.15 - 0.0065 * h));
  /* v0.33.0 (Henri) : hauteur perdue à l'ouverture mesurée par voile, avec la hauteur (altitude) du début d'ouverture ; ramenée à
     1 000 m (même durée d'ouverture, vitesses en √(ρ_ref/ρ)) : perte_ref = perte mesurée × √(ρ(h)/ρ_ref). null si pas de mesure. */
  function canOpenRef(c) { if (!(+c.lossM >= 0) || c.lossM === '' || c.lossM == null) return null; const h = isFinite(+c.hOpenM) ? +c.hOpenM : 1000; const m = +c.mteOpenM > 0 ? +c.mteOpenM : MTE_REF; return +c.lossM * Math.sqrt(rhoStd(h) / RHO_REF) * Math.sqrt(MTE_REF / m); } /* v0.34.0 : et ramenée à 150 kg (vitesses en √MTE) */
  function canRef(c) { const h = isFinite(+c.hM) ? +c.hM : 1000, m = +c.mteM > 0 ? +c.mteM : MTE_REF, k = Math.sqrt(rhoStd(h) / RHO_REF) * Math.sqrt(MTE_REF / m); return { vx: +c.vx * k, vz: +c.vz * k }; }
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
  /* v0.51.0 : meilleur cap et zone de relaxation ne dépendent pas de la position du vecteur ; un passage à plusieurs équipes les
     redemande des dizaines de fois avec les mêmes données (40 ms à chaque fois) → gardés en mémoire, par champ de vent. */
  const memoF = new WeakMap(), memo0 = new Map();
  function memo(F, key, make) { let M = F ? memoF.get(F) : memo0; if (!M) { M = new Map(); memoF.set(F, M); } if (M.has(key)) return M.get(key); if (M.size > 240) M.clear(); /* v0.54.0 : une zone par voile + MTE, plus la zone de l'équipe */ const v = make(); M.set(key, v); return v; }
  const canKey = can => [can.vx, can.vz, can.mk].join('/');
  function bestCap(F, ptu, elev0, hPtu, hOpen, can, margin) { return memo(F, ['bc', ptu.lat, ptu.lng, elev0, hPtu, hOpen, canKey(can), margin].join('|'), () => bestCap0(F, ptu, elev0, hPtu, hOpen, can, margin)); }
  function bestCap0(F, ptu, elev0, hPtu, hOpen, can, margin) {
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
  function relaxCircle(F, ptu, elev0, hPtu, hOpen, can, margin, cap) { return memo(F, ['rc', ptu.lat, ptu.lng, elev0, hPtu, hOpen, canKey(can), margin, cap].join('|'), () => relaxCircle0(F, ptu, elev0, hPtu, hOpen, can, margin, cap)); }
  function relaxCircle0(F, ptu, elev0, hPtu, hOpen, can, margin, cap) {
    const top = (c, m) => trace(F, ptu, elev0, hPtu, hOpen, can, c, m).top;
    let la = 0, lo = 0, n = 0;
    for (let c = 0; c < 360; c += 15) { const q = top(c, 0); la += q.lat; lo += q.lng; n++; }
    const C0 = { lat: la / n, lng: lo / n }, Q = []; let Rin = Infinity, Rm = 0;
    for (let c = 0; c < 360; c += 5) { const p = top(c, margin), q = toLocal(C0, p), h = unit(c), r = -(q.x * h.x + q.y * h.y); Q.push(p); Rin = Math.min(Rin, r); Rm += r / 72; }
    /* v0.47.0 (Henri, 23/11) : la VRAIE zone de relaxation, plus seulement le plus grand cercle qui tient dedans. Son bord = les
       ouvertures de toutes les traces (une tous les 5°, plus celles autour du cap de la trace pour être exact là où le vecteur se
       pose). On la décrit par son rayon en fonction du relèvement vu du centre C0 (z.a croissant, z.r), ce qui suppose qu'elle
       est « étoilée » autour de C0 : vrai tant que le vent ne la replie pas sur elle-même ; sinon z = null et on garde le cercle. */
    const polar = p => { const q = toLocal(C0, p); return { a: Math.atan2(q.x, q.y), r: Math.hypot(q.x, q.y) }; };
    const mkZone = extra => { const P = Q.concat(extra || []).map(polar).sort((u, v) => u.a - v.a), a = [], r = [];
      for (const k of P) { if (a.length && k.a - a[a.length - 1] < 1e-5) continue; a.push(k.a); r.push(k.r); }
      let ok = Rin > 1 && a.length >= 24; /* étoilée : en tournant le cap de 5° en 5°, le relèvement du bord tourne toujours dans le même sens */
      if (ok) { let tot = 0, sg = 0; for (let i = 0; i < Q.length; i++) { let d = polar(Q[(i + 1) % Q.length]).a - polar(Q[i]).a; d = Math.atan2(Math.sin(d), Math.cos(d)); if (!sg) sg = Math.sign(d); if (Math.sign(d) !== sg || Math.abs(d) > 0.6) { ok = false; break; } tot += d; } if (ok && Math.abs(Math.abs(tot) - 2 * Math.PI) > 0.05) ok = false; }
      return ok ? { c: C0, a, r } : null; };
    const centered = { c: C0, R: Math.max(0, Rin), z: mkZone() };
    if (cap == null || !(Rin > 1)) return centered;
    // Repère centré sur l'ouverture T de la trace : c'est là que le cercle doit être exact
    const T = top(cap, margin), A = toLocal(T, top(cap + 2, margin)), B = toLocal(T, top(cap - 2, margin)), c0 = toLocal(T, C0);
    let nx = -(A.y - B.y), ny = A.x - B.x; const nl = Math.hypot(nx, ny); if (nl < 1e-6) return centered;
    nx /= nl; ny /= nl; if (c0.x * nx + c0.y * ny < 0) { nx = -nx; ny = -ny; } // normale au bord, vers l'intérieur
    let rho = Infinity;
    for (const p of Q) { const d = toLocal(T, p), d2 = d.x * d.x + d.y * d.y, dot = d.x * nx + d.y * ny; if (d2 > 0.04 * Rm * Rm && dot > 1e-6) rho = Math.min(rho, d2 / (2 * dot)); }
    if (!isFinite(rho) || rho <= 0) return centered;
    const near = []; for (const d of [-4, -3, -2, -1, 0, 1, 2, 3, 4]) near.push(top(cap + d, margin));
    return { c: fromLocal(T, { x: rho * nx, y: rho * ny }), R: rho, z: mkZone(near) };
  }
  /* Zone de relaxation z = { c, a[], r[] } : rayon du bord dans un relèvement (interpolé entre deux ouvertures voisines), dépassement
     d'un point (> 0 = dehors), et son contour pour le dessin. Sans z (cas dégénéré) : le cercle { c, R }. */
  function zoneR(z, ang) { const a = z.a, r = z.r, n = a.length, P = 2 * Math.PI; let i = n - 1; /* intervalle [a[i], a[i+1]] (périodique) qui contient ang */
    if (ang >= a[0] && ang < a[n - 1]) { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= ang) lo = m; else hi = m; } i = lo; }
    const A = k => a[((k % n) + n) % n] + Math.floor(k / n) * P, Rr = k => r[((k % n) + n) % n], x = i === n - 1 && ang < a[0] ? ang + P : ang;
    const a0 = A(i), a1 = A(i + 1), h = Math.max(1e-9, a1 - a0), t = Math.max(0, Math.min(1, (x - a0) / h));
    const m0 = (Rr(i + 1) - Rr(i - 1)) / Math.max(1e-9, a1 - A(i - 1)), m1 = (Rr(i + 2) - Rr(i)) / Math.max(1e-9, A(i + 2) - a0), t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * Rr(i) + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * Rr(i + 1) + (t3 - t2) * h * m1; }
  function zoneOut(circ, p) { if (!circ.z) return dist(circ.c, p) - circ.R; const q = toLocal(circ.z.c, p); return Math.hypot(q.x, q.y) - zoneR(circ.z, Math.atan2(q.x, q.y)); }
  function zonePts(circ, stepDeg) { const out = [], st = stepDeg || 1;
    for (let d = 0; d < 360; d += st) { const g = d * Math.PI / 180, ang = Math.atan2(Math.sin(g), Math.cos(g)), R = circ.z ? zoneR(circ.z, ang) : circ.R, c = circ.z ? circ.z.c : circ.c; out.push(fromLocal(c, { x: R * Math.sin(g), y: R * Math.cos(g) })); }
    return out; }
  function zoneSpan(circ) { if (!circ.z) return { min: circ.R, max: circ.R }; return { min: Math.min.apply(null, circ.z.r), max: Math.max.apply(null, circ.z.r) }; }
  /* v0.54.0 (Henri, 27/11) — ZONE DE L'ÉQUIPE. Chaque voile + MTE a sa zone de relaxation ; quand elles diffèrent, ce n'est pas la même
     qui limite partout (côté loin, vent dans le dos : la moins fine ou la plus lourde ; côté PTU, face au vent : la plus légère).
     La zone de l'équipe est ce qui est dans TOUTES : tant que les points d'ouverture sont dedans, tous les paras rejoignent le PTU.
     On la rend dans le même format qu'une zone simple ({ c, R, z: { c, a, r } }) : rayon du bord selon le relèvement vu de son point le
     plus profond, un échantillon par degré plus trois aux « coins » (là où la voile qui limite change), pour que zoneR / zoneOut /
     zonePts, le moteur des passages (pass.js) et le dessin marchent sans rien savoir de plus. R = demi-plus-grande largeur.
     Une seule zone → rendue telle quelle (équipe homogène : strictement comme avant). Aucune zone commune → { R: 0, z: null, empty }.
     PIÈGE : ne pas additionner des coordonnées locales de centres différents (cos de la latitude) : toujours repasser par lat/lng. */
  function zoneJoin(parts) {
    if (parts.length === 1) return parts[0];
    const cOf = z => (z.z ? z.z.c : z.c), P2 = 2 * Math.PI;
    const outAt = p => { let v = -Infinity; for (const z of parts) { const w = zoneOut(z, p); if (w > v) v = w; } return v; };
    let la = 0, lo = 0; for (const z of parts) { const c = cOf(z); la += c.lat; lo += c.lng; }
    const C0 = { lat: la / parts.length, lng: lo / parts.length }, Rbig = Math.max.apply(null, parts.map(z => dist(C0, cOf(z)) + zoneSpan(z).max));
    let x = 0, y = 0, f = outAt(C0); // point le plus profond de l'intersection (descente par motifs)
    for (let st = Math.max(50, Rbig / 4); st >= 2; st /= 2) { let moved = true, guard = 0;
      while (moved && guard++ < 60) { moved = false;
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, nx = x + Math.sin(a) * st, ny = y + Math.cos(a) * st, nf = outAt(fromLocal(C0, { x: nx, y: ny })); if (nf < f - 1e-3) { x = nx; y = ny; f = nf; moved = true; } } } }
    const C = fromLocal(C0, { x, y });
    if (!(f < -1) || !isFinite(Rbig)) return { c: C, R: 0, z: null, parts, empty: true };
    const depth = -f, at = (g, r) => fromLocal(C, { x: Math.sin(g) * r, y: Math.cos(g) * r });
    const exit = (g, guess) => { /* rayon où la demi-droite de relèvement g sort de l'intersection */
      let lo2 = null, hi = null;
      if (guess != null) { const a = guess * 0.97, b = guess * 1.03 + 1; if (outAt(at(g, a)) <= 0 && outAt(at(g, b)) > 0) { lo2 = a; hi = b; } }
      if (lo2 == null) { const stp = Math.min(Rbig / 32, Math.max(depth / 2, Rbig / 400)); lo2 = 0; hi = stp; let n = 0; while (outAt(at(g, hi)) <= 0 && n++ < 2000) { lo2 = hi; hi += stp; } }
      for (let k = 0; k < 40 && hi - lo2 > 0.02; k++) { const m = (lo2 + hi) / 2; if (outAt(at(g, m)) <= 0) lo2 = m; else hi = m; }
      return lo2; };
    const owner = (g, r) => { const p = at(g, r); let b = 0, v = -Infinity; parts.forEach((z, j) => { const w = zoneOut(z, p); if (w > v) { v = w; b = j; } }); return b; };
    const N = 360, nodes = []; let prev = null;
    for (let i = 0; i < N; i++) { const g = -Math.PI + (i + 0.5) * P2 / N, r = exit(g, prev); nodes.push({ a: g, r, o: owner(g, r) }); prev = r; }
    const EPS = 3e-4, extra = []; /* coins : on encadre l'endroit où la voile qui limite change, pour que le bord garde son angle */
    for (let i = 0; i < N; i++) { const A = nodes[i], B = nodes[(i + 1) % N]; if (A.o === B.o) continue;
      let ga = A.a, gb = B.a + (i === N - 1 ? P2 : 0), ra = A.r;
      for (let k = 0; k < 14; k++) { const gm = (ga + gb) / 2, rm = exit(gm, ra); if (owner(gm, rm) === A.o) { ga = gm; ra = rm; } else gb = gm; }
      for (const d of [-EPS, 0, EPS]) { let g = (ga + gb) / 2 + d; const r = exit(g, ra); if (g >= Math.PI) g -= P2; extra.push({ a: g, r }); } }
    const all = nodes.concat(extra).sort((u, v) => u.a - v.a), a = [], r = [];
    for (const k of all) { if (a.length && k.a - a[a.length - 1] < 1e-5) continue; a.push(k.a); r.push(k.r); }
    let chord = 0; for (let i = 0; i < N / 2; i++) chord = Math.max(chord, nodes[i].r + nodes[i + N / 2].r);
    return { c: C, R: chord / 2, z: { c: C, a, r }, parts, own: nodes.map(k => k.o) };
  }
  /* Zone de l'équipe pour une liste de voiles effectives (cans) à la hauteur d'ouverture hOpen ; caps[i] = cap autour duquel la zone de
     la voile i doit être exacte (là où sa trace se pose), ou null. Gardée en mémoire comme les zones simples. */
  function teamZone(F, ptu, elev0, hPtu, hOpen, cans, caps, margin) {
    const parts = cans.map((c, i) => relaxCircle(F, ptu, elev0, hPtu, hOpen, c, margin, caps ? caps[i] : null));
    if (parts.length === 1) return parts[0];
    return memo(F, ['tz', ptu.lat, ptu.lng, elev0, hPtu, hOpen, margin].concat(cans.map((c, i) => canKey(c) + '@' + (caps && caps[i] != null ? caps[i] : ''))).join('|'), () => zoneJoin(parts));
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
    const refine = b => { for (const st of [1, 0.3, 0.1, 0.03, 0.01]) { let moved = true, guard = 0; while (moved && guard++ < 8) { moved = false; for (const s of [-1, 1]) { const r = f(b.cap + s * st); if (r.d < b.d) { b = r; moved = true; } } } } return b; };
    const S = []; for (let c = 0; c < 360; c += 3) S.push(f(c));
    /* Par vent fort, deux traces peuvent passer par le même point (une basse, vent dans le dos ; une haute, face au vent).
       v0.44.1 (Henri, 22/11, décision finale) : on garde la plus BASSE, vent dans le dos, face à la zone de posé — MÊME RÈGLE PARTOUT,
       y compris au bord du cercle à l'opposé (plus de cap inversé face au vent). Historique : v0.40.0 la plus basse, v0.43.0 la plus
       haute (cap inversé), v0.44.1 retour à la plus basse.
       « Rentrer le long de la trace » ne passe plus par ici : la route y est figée (isv.along). */
    const n = S.length, mins = []; for (let k = 0; k < n; k++) if (S[k].d <= S[(k + n - 1) % n].d && S[k].d < S[(k + 1) % n].d) mins.push(S[k]);
    if (!mins.length) mins.push(S.reduce((a, b) => (b.d < a.d ? b : a)));
    const R = mins.map(refine), ok = R.filter(r => r.d < 30);
    return ok.length ? ok.reduce((a, b) => (b.h < a.h ? b : a)) : R.reduce((a, b) => (b.d < a.d ? b : a)); // { d (écart restant, m), h (hauteur sur la trace), cap, pt }
  }
  /* (v0.42.0 : fracThrough et la « descente rapide » calculée sont supprimés — voir le bloc keepH de solve.) */

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
    const margin = Math.max(0, +prm.margin || 0) / 100, openLoss0 = Math.max(0, +prm.openLoss || 0), vff = Math.max(10, +prm.vff || 50);
    const ptu = isv.ptu, hPtu = Math.max(0, +isv.hPtu || 0), ias = Math.max(10, +isv.acMs || 65);
    // Voile « effective » d'un para : sa voile + sa MTE (masse totale équipée du para, saisie dans l'équipe ; 150 kg à défaut)
    const effOf = p => { const c = canOf(p), m0 = MTE_REF, m = +p.mte > 0 ? +p.mte : m0; const r = canRef(c); return { c, id: c.id, name: c.name, vx: r.vx, vz: r.vz, mte: m, mk: Math.sqrt(m / m0), key: c.id + '|' + m }; };
    const used = []; team.forEach(p => { const e = effOf(p); if (!used.some(u => u.key === e.key)) used.push(e); });
    /* perte à l'ouverture : la plus forte des voiles de l'équipe (mesures par voile), sinon la valeur générale */
    const ols = used.map(u => { const v = canOpenRef(u.c); return v == null ? null : v * u.mk; }).filter(v => v != null), /* v0.34.0 : × √(MTE du para / 150) */ openLoss = ols.length ? Math.max(...ols) : openLoss0;
    const vzRef = Math.min(...used.map(c => +c.vz)); // fin d'ouverture : vitesse de la voile la plus lente à descendre (effet minime)

    // Largage au FL demandé → hauteur d'ouverture
    const relState = (fl, tf) => {
      const altRel = flToAlt(F, ptu, fl), hRel = altRel - elev0, tas = tasOf(F, ptu, altRel, ias);
      const kff = ffK(F, ptu, altRel), tFall = tf != null ? tf : Math.max(0, +isv.tFall || 0), f = fall(tFall, tas, vff, openLoss, vzRef, kff);
      return { fl, altRel, hRel, tas, tFall, f, kff, hOpen: hRel - f.drop };
    };
    let st = relState(+isv.fl || 295);
    if (st.hOpen <= hPtu + 50) { out.err = `Largage trop bas : ouverture à ${Math.round(st.hOpen)} m pour un PTU à ${Math.round(hPtu)} m.`; return out; }

    /* v0.54.0 (Henri, 27/11) — voiles ou MTE différentes dans l'équipe. Pour une même voile, seules la MTE la plus légère et la plus
       lourde peuvent limiter (la zone d'une MTE intermédiaire contient ce qui est commun aux deux extrêmes) : ext = ces extrêmes. */
    const ext = []; used.forEach(u => { const same = used.filter(v => v.id === u.id); for (const e of [same.reduce((a, b) => (b.mte < a.mte ? b : a)), same.reduce((a, b) => (b.mte > a.mte ? b : a))]) if (!ext.includes(e)) ext.push(e); });
    const reach = (c, hOpen) => { const cap = isv.capManual != null ? isv.capManual : bestCap(F, ptu, elev0, hPtu, hOpen, c, margin); const tr = trace(F, ptu, elev0, hPtu, hOpen, c, cap, margin); return { c, cap, tr }; };
    const cand = ext.map(c => reach(c, st.hOpen)), capsPlan = cand.map(k => k.cap), zoneTeam = (hOpen, caps) => teamZone(F, ptu, elev0, hPtu, hOpen, ext, caps, margin);
    /* Voile de la trace (vecteur automatique ou cap para imposé) : celle dont le bout de trace est dans la zone de toutes les autres,
       c'est-à-dire sur le bord de la zone de l'équipe. Au meilleur cap, c'est celle qui va le moins loin (la règle d'avant) ; à un cap
       imposé face au vent, c'est au contraire la plus légère. Aucune (coin de la zone) : celle qui dépasse le moins. */
    let weak = cand[0];
    if (cand.length > 1) { const zs = cand.map(k => relaxCircle(F, ptu, elev0, hPtu, st.hOpen, k.c, margin, k.cap));
      const sc = cand.map((k, i) => { let v = -Infinity; zs.forEach((z, j) => { if (j !== i) v = Math.max(v, zoneOut(z, k.tr.top)); }); return v; }), okc = cand.filter((k, i) => sc[i] <= 1);
      weak = okc.length ? okc.reduce((a, b) => (b.tr.direct < a.tr.direct ? b : a)) : cand[sc.indexOf(Math.min.apply(null, sc))]; }
    /* Vecteur posé à la main : la voile de la trace est la plus restrictive AU POINT D'OUVERTURE O, celle dont la trace y passe le plus
       haut (c'est elle qui a le moins de hauteur en trop), ou qui ne peut pas rejoindre le PTU depuis là. La voile par défaut garde la
       main à égalité (0,5 m). Route figée (isv.along) : la voile reste celle de la route (along.can), sinon la trace changerait. */
    const pickAt = O => { let best = null; for (const k of [weak].concat(cand.filter(q => q !== weak))) { const r = capThrough(F, ptu, elev0, hPtu, st.hOpen, k.c, margin, O), v = r.d < 30 ? r.h : 1e7 + r.d; if (!best || v > best.v + 0.5) best = { c: k.c, r, v }; } return best; };
    const ouv0 = () => fromLocal(isv.manual, rseDrift(F, isv.manual, st.altRel, st.f, acHeadingOf(F, isv, st, traceDir(weak.tr.pts), isv.manual)));
    const alCan = isv.along && isv.along.can != null ? (ext.find(u => u.key === isv.along.can) || null) : null;

    // Vecteur déplacé à la main : le FL ne change pas. La trace doit passer par le nouveau point d'ouverture ; si elle y passe
    // plus bas que l'ouverture prévue, le para chute plus longtemps : la consigne devient « ouverture à x m » (centaine supérieure).
    let attach = null; const stPlan = st, capPlan = weak.cap;
    const keepH = !!(isv.manual && isv.capManual == null && isv.keepH); let achKeep = null, isAl = false;
    if (keepH) { /* v0.42.0 (Henri, 22/11, décision finale) : hauteur d'ouverture GARDÉE = TOUJOURS LA TRACE NORMALE, construite à rebours
         depuis le PTU à pleine performance, entière, du bord du cercle au PTU : mêmes points, mêmes hauteurs. Le para s'ouvre
         quelque part dessus, bien plus haut qu'elle (« le point s'appelle 5000, je suis à 8700 ») et rattrape petit à petit aux
         oreilles : c'est à lui de se débrouiller. AUCUN calcul de descente rapide, aucune mesure aux oreilles nécessaire.
           - vecteur rentré le long de la trace (isv.along = { cap }) : la trace ne bouge pas du tout, seul le vecteur est ramené dessus ;
           - vecteur déplacé librement dans le cercle : la trace est celle qui passe par le point d'ouverture (capThrough, comme en
             mode « changer »), sauf que la hauteur d'ouverture reste celle du temps de chute.
         NE PAS y revenir : points resserrés (v0.40.0/0.41.0, « mauvaise idée » d'Henri), temps de descente réduit (v0.40.1/0.40.3),
         viser le centre du cercle (v0.40.2).
         Cap de l'avion : il dépend de la trace, qui dépend du point d'ouverture, qui dépend de la dérive en chute donc du cap de
         l'avion — si le côté « face au vent » bascule d'une passe à l'autre, on garde le côté en cours. */
      const al = isv.along && isv.along.cap != null ? isv.along : null, full = c => trace(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, c, margin);
      const perpNear = (d1, prev) => { const c1 = n360(d1 + 90), c2 = n360(d1 - 90), g = c => Math.abs(((c - prev + 540) % 360) - 180); return g(c1) <= g(c2) ? c1 : c2; };
      let O = null, nr = null, capPrev = null, flips = 0; isAl = !!al;
      if (al && alCan) weak = { c: alCan, cap: weak.cap, tr: weak.tr };
      else if (!al && cand.length > 1) { const b = pickAt(ouv0()); weak = { c: b.c, cap: b.r.cap, tr: trace(F, ptu, elev0, hPtu, stPlan.hOpen, b.c, b.r.cap, margin) }; }
      if (al) weak = { c: weak.c, cap: al.cap, tr: full(al.cap) };
      /* v0.51.1 (Henri, 24/11) : hauteur gardée = l'ouverture reste TOUJOURS celle du temps de chute. L'appli ne l'abaisse plus
         d'elle-même quand le para s'ouvre loin au-dessus de la trace (ancienne règle de la v0.44.0, supprimée : NE PAS la remettre).
         Pour ouvrir à la hauteur de la trace, c'est le bouton « Appliquer » (mode « changer »), sur décision de l'utilisateur. */
      for (let pass = 0; pass < 8; pass++) {
        const d1 = traceDir(weak.tr.pts); let ach = acHeadingOf(F, isv, st, d1, isv.manual);
        if (achKeep != null && isv.vecHeading == null) { if (flips >= 2) ach = perpNear(d1, achKeep); else if (Math.abs(((ach - achKeep + 540) % 360) - 180) > 90) flips++; }
        achKeep = ach; const O2 = fromLocal(isv.manual, rseDrift(F, isv.manual, st.altRel, st.f, ach)), still = O && dist(O, O2) < 1; O = O2;
        if (al) { nr = nearestOn(weak.tr.pts, O); if (still) break; }
        else { const sol = capThrough(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, margin, O); nr = sol; weak = { c: weak.c, cap: sol.cap, tr: full(sol.cap) };
          if (capPrev != null && Math.abs(((sol.cap - capPrev + 540) % 360) - 180) < 0.05) break; capPrev = sol.cap; }
      }
      /* out.frac = part de la descente qu'il reste au para sur la trace (1 = il s'ouvre à la hauteur de la trace) : sert seulement à
         afficher la ligne du Briefing « Voile plus performante que la trace » */
      out.manualGap = nr.d; out.frac = Math.max(0, Math.min(1, (nr.h - hPtu) / Math.max(1, st.hOpen - hPtu))); out.along = isAl; attach = nr.pt || O; out.ouvO = attach;
      if (nr.d > 30 && nr.pt) { out.manualFix = fromLocal(isv.manual, toLocal(O, nr.pt)); if (!al) out.warn = 'Vecteur hors de la zone de relaxation : à cette hauteur d\'ouverture, le PTU ne peut pas être rejoint depuis là.'; }
    } else if (isv.manual && isv.capManual == null) {
      let O = null, sol = null, hCmd = null;
      if (isv.along && isv.along.cap != null) { if (alCan) weak = { c: alCan, cap: weak.cap, tr: weak.tr }; }
      else if (cand.length > 1) { const b = pickAt(ouv0()); weak = { c: b.c, cap: b.r.cap, tr: trace(F, ptu, elev0, hPtu, stPlan.hOpen, b.c, b.r.cap, margin) }; }
      for (let pass = 0; pass < 5; pass++) { // la dérive sous RSE dépend du temps de chute, qui dépend du point d'ouverture : on recale
        const ach = acHeadingOf(F, isv, st, traceDir(weak.tr.pts), isv.manual), dr = rseDrift(F, isv.manual, st.altRel, st.f, ach);
        O = fromLocal(isv.manual, dr);
        const alC = isv.along && isv.along.cap != null ? +isv.along.cap : null; /* v0.43.0 : rentré le long de la trace → route figée */
        sol = alC != null ? Object.assign(nearestOn(trace(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, alC, margin).pts, O), { cap: alC }) : capThrough(F, ptu, elev0, hPtu, stPlan.hOpen, weak.c, margin, O);
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
      out.manualGap = sol.d; attach = O; out.ouvO = O; /* v0.41.0 : point d'ouverture qui définit la trace (avant glissement du vecteur) */
      if (sol.d > 30 && sol.pt) out.manualFix = fromLocal(isv.manual, toLocal(O, sol.pt)); /* v0.40.0 : point de largage le plus proche d'où le PTU reste joignable */
      if (sol.d > 100) out.warn = 'Ce point de largage est hors de portée : le PTU ne peut pas être rejoint depuis là.';
    }
    { const wi = team.findIndex(p => effOf(p).key === weak.c.key); /* v0.54.0 : après le choix (il dépend du point d'ouverture quand le vecteur est posé à la main) */
      out.weak = { canopy: weak.c.c, mte: weak.c.mte, idx: wi, name: team[wi] && team[wi].name || '', several: used.length > 1 }; out.wk = weak.c.key; }
    const tr = weak.tr, ptsDown = tr.pts.slice().reverse(); // de l'ouverture terminée vers le PTU
    out.cap = n360(weak.cap); out.capAuto = isv.capManual == null && !isv.manual;
    out.trace = ptsDown; out.direct = tr.direct; out.length = tr.length; out.ouv = ptsDown[0];
    Object.assign(out, { hCmd: st.hCmd != null ? st.hCmd : st.hOpen + (st.f.drop - st.f.dropFF), fl: st.fl, openLowered: st !== stPlan, hOpenPlan: stPlan.hOpen, tFallPlan: stPlan.tFall, hRel: st.hRel, altRel: st.altRel, hOpen: st.hOpen, tas: st.tas, tFall: st.tFall, drop: st.f.drop, openDrop: st.f.drop - st.f.dropFF, tOpen: st.f.tOpen, elev0, vzRef, margin, fallSt: st.f /* v0.51.0 : état de la chute, pour recalculer la dérive sous RSE à un autre cap avion (passage à plusieurs équipes) */ });

    // Cap de l'avion : perpendiculaire au premier segment de la trace, sens le plus face au vent (ou cap choisi), ⇅ Sens l'inverse
    const dir1 = traceDir(tr.pts), acHeading = keepH && achKeep != null ? achKeep : acHeadingOf(F, isv, st, dir1, ptsDown[0]); /* hauteur gardée : cap avion de la dernière passe (cohérent avec le point d'ouverture) */
    const pRel = keepH && attach ? attach : ptsDown[0]; /* v0.42.0 : hauteur gardée, le para n'est pas au début de la trace */
    const wRel = windAt(F, pRel.lat, pRel.lng, st.altRel);
    const vg = groundSpeed(st.tas, wRel, acHeading), a = unit(acHeading);
    const dr = rseDrift(F, pRel, st.altRel, st.f, acHeading);
    Object.assign(out, { acHeading, vg, windRel: spdDir(wRel), rse: dr, rseLen: Math.hypot(dr.x, dr.y) });
    if (vg < 5) { out.err = 'Vent de face plus fort que l\'avion sur ce cap : change le sens ou le cap du vecteur.'; return out; }

    // Cercle de relaxation : en points d'ouverture, puis décalé de la dérive sous RSE pour l'avoir en points de largage
    // Cercle de relaxation affiché = zone avec marge (v0.2.1, choix d'Henri ; en v0.2.0 on affichait le cercle sans marge).
    // La trace, calculée avec la marge, part de son bord ; le vecteur ne peut pas en sortir.
    const man = !!(isv.manual && isv.capManual == null), capShow = man ? capPlan : weak.cap;
    /* v0.40.0 (Henri) : le cercle est TOUJOURS celui de la hauteur d'ouverture réelle. Hauteur gardée : cercle de l'ouverture prévue
       (il ne bouge pas quand on déplace le vecteur dedans). Hauteur changée : cercle recalculé pour la nouvelle hauteur. */
    /* v0.54.0 : zone de l'ÉQUIPE (ce qui est dans la zone de chaque voile + MTE). Une seule voile + MTE : la même zone qu'avant. */
    const circ = keepH ? zoneTeam(stPlan.hOpen, capsPlan) : zoneTeam(st.hOpen, man ? ext.map(e => (e === weak.c ? weak.cap : null)) : capsPlan);
    out.zoneN = ext.length;
    const zonePlan = circ, circShow = circ, drShow = dr;
    if (!(circ.R > 0)) out.warn = (out.warn ? out.warn + ' ' : '') + (circ.empty ? 'Avec ce vent, il n\'existe aucun endroit d\'où tous les paras de l\'équipe rejoignent le PTU : leurs voiles ou leurs MTE sont trop différentes.' : `Avec ce vent et ${Math.round(margin * 100)} % de marge, aucun point de largage ne garantit de rejoindre le PTU.`);
    const toDrop = (c, d) => ({ c: fromLocal(c.c, { x: -d.x, y: -d.y }), R: c.R });
    out.circleOuv = circShow; out.circle = toDrop(circShow, drShow);
    out.zoneOuv = circ; out.zone = toDrop(zonePlan, drShow);
    /* v0.51.0 : zone de la hauteur d'ouverture PRÉVUE (temps de chute), même quand l'ouverture a été abaissée (mode Changer) : c'est d'elle
       que dépend la possibilité de rejoindre le PTU ; sert au placement d'un passage à plusieurs équipes */
    out.zonePlan = (keepH || st === stPlan) ? circ : zoneTeam(stPlan.hOpen, capsPlan);

    // Vecteur : le para choisi s'ouvre sur la trace ; on fait glisser ce point le long de la trace (vers le PTU) jusqu'à ce que
    // le vert et le rouge soient dans la zone avec marge (non affichée). La trace ne change pas.
    const ex = exitTimes(team, isv.tGreen, isv.tRed), n = team.length;
    const idx = (isv.dropIdx != null && isv.dropIdx >= 0 && isv.dropIdx < n) ? isv.dropIdx : defaultDropIdx(n);
    const sBefore = vg * ex.te[idx], sAfter = vg * (ex.total - ex.te[idx]), L = sBefore + sAfter;
    const total = (() => { let s = 0; for (let i = 1; i < ptsDown.length; i++) s += dist(ptsDown[i - 1], ptsDown[i]); return s; })();
    const cO = circ.z ? circ.z.c : circ.c, inside = p => zoneOut(circ, p) <= 0.5; /* v0.47.0 : zone réelle */
    const ends = o => [fromLocal(o, { x: -a.x * sBefore, y: -a.y * sBefore }), fromLocal(o, { x: a.x * sAfter, y: a.y * sAfter })];
    let s0 = attach ? nearestOn(ptsDown, attach).s : 0, sFit = null;
    if (keepH) { /* v0.42.0 — hauteur gardée : le para est à l'abscisse s0 de la trace (entière) ; le vecteur reste là où il est posé. S'il
                    dépasse du cercle : rentré le long de la trace → il glisse encore le long de la trace (vers le PTU comme vers le
                    bord : par vent fort la trace ressort du cercle avant le PTU) ; déplacé librement → on dit de combien le ramener
                    vers le centre (manualFix). Sauf s'il est plus long que le cercle. */
      sFit = s0; const oK = pointAt(ptsDown, s0), e = ends(oK), ex = Math.max(zoneOut(circ, e[0]), zoneOut(circ, e[1]));
      if (ex > 0.5 && !out.manualFix && L <= 2 * circ.R) {
        if (isAl) { let sF = null; const okAt = s => { const e2 = ends(pointAt(ptsDown, s)); return zoneOut(circ, e2[0]) <= -2 && zoneOut(circ, e2[1]) <= -2; }, st2 = Math.max(5, total / 4000);
          for (let k = 1; k * st2 <= total && sF == null; k++) { const s1 = s0 + k * st2, s2 = s0 - k * st2; if (s1 <= total && okAt(s1)) sF = s1; else if (s2 >= 0 && okAt(s2)) sF = s2; }
          if (sF != null) out.manualFix = fromLocal(isv.manual, toLocal(oK, pointAt(ptsDown, sF))); else sFit = null; }
        else { const v = toLocal(oK, cO), lv = Math.hypot(v.x, v.y) || 1, k = Math.min(lv, ex + 5) / lv;
          out.manualFix = fromLocal(isv.manual, { x: v.x * k, y: v.y * k }); out.warn = (out.warn ? out.warn + ' ' : '') + 'Ouvertures hors de la zone de relaxation : à cette hauteur d\'ouverture, les points d\'ouverture et les projections du vert et du rouge après dérive sous RSE doivent rester dedans.'; }
      } else if (L > 2 * circ.R) sFit = null;
    } else
    for (let s = s0; s <= total; s += Math.max(5, total / 4000)) { const o = pointAt(ptsDown, s), e = ends(o); if (inside(e[0]) && inside(e[1])) { sFit = s; break; } }
    if (sFit == null) { out.warn = out.warn || '' ; if (!circ.empty) out.warn = (out.warn ? out.warn + ' ' : '') + (L > 2 * circ.R ? `Vecteur (${Math.round(L)} m) plus long que la zone de relaxation${st !== stPlan ? ' à cette hauteur d\'ouverture' : ''} (${Math.round(2 * circ.R)} m de large) : il ne peut pas y rentrer.` : `Le vecteur ne rentre pas dans la zone de relaxation sur ce cap : tourne-le ou change de para sur la trace.`); sFit = s0; }
    const oAtt = pointAt(ptsDown, sFit), eO = ends(oAtt), shift = p => fromLocal(p, { x: -dr.x, y: -dr.y });
    out.keepH = keepH; out.slide = sFit; out.attachOuv = oAtt; out.attachH = oAtt.h; out.dropIdx = idx;
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
    /* v0.42.0 (Henri) — hauteur gardée, para ouvert au-dessus de la trace :
         - temps sous voile jusqu'au PTU = temps que met la trace depuis l'endroit où le para la rejoint (« comme s'il était sur la
           trace » : il rattrape petit à petit, on ne sait pas quand, et arrive à la hauteur prévue au PTU) ;
         - passage du FL180 et du FL120 (temps sous oxygène) = cas le plus défavorable : descente à la vitesse verticale normale
           depuis l'ouverture réelle, SANS les oreilles. Ne pas réduire ces deux temps. */
    const own = effOf(team[idx]), tCan = tUnder(own, keepH ? Math.min(st.hOpen, Math.max(hPtu, oAtt.h)) : st.hOpen, hPtu);
    const tPass = fl => {
      if (st.fl <= fl) return null;
      const dz = st.altRel - flToAlt(F, ptu, fl); // hauteur à perdre depuis le largage
      if (dz <= st.f.drop) { let t = 0; for (const s2 of st.f.steps) { t += s2.dt; if (s2.z >= dz) break; } return ex.te[idx] + t; }
      return ex.te[idx] + st.f.time + tUnder(own, st.hOpen, Math.max(hPtu, st.hRel - dz));
    };
    out.own = { canopy: own.c, mte: own.mte, tCanopy: tCan, t180: tPass(180), t120: tPass(120) };
    /* v0.35.0 (Henri) : ouverture qui n'est pas à 4 s → FL minimal de largage pour ouvrir à cette même hauteur avec 4 s de chute,
       arrondi au FL multiple de 5 supérieur (relState est croissant avec le FL : recherche par dichotomie) */
    /* v0.37.0 (Henri) : sur l'ouverture RÉELLE (vecteur rentré à la main = ouverture abaissée compris), et « 4 s » réglable (isv.tRef) */
    const tRef = +isv.tRef > 0 ? +isv.tRef : 4;
    if (Math.abs(st.tFall - tRef) > 0.05) { let lo = 0, hi = 600; const target = st.hOpen;
      if (relState(hi, tRef).hOpen >= target) { for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (relState(m, tRef).hOpen >= target) hi = m; else lo = m; } out.flMin4 = Math.ceil(hi / 5 - 1e-9) * 5; if (out.flMin4 >= st.fl) out.flMin4 = null; } } /* v0.38.1 : rien à proposer si ce n'est pas plus bas */
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

  const api = { toLocal, fromLocal, unit, bearingOf, dist, n360, stdP, stdH, RHO_REF, MTE_REF, canRef, canOpenRef, rhoAt, kRho, ffK, windAt, rhAt, windMean, zOfP, pOfZ, flToAlt, altToFl, spdDir, inGrid,
    tasOf, groundSpeed, fall, tFallFor, rseDrift, rsePath, heights, trace, bestCap, relaxCircle, zoneJoin, teamZone, zoneR, zoneOut, zonePts, zoneSpan, nearestOn, pointAt, capThrough, exitTimes, defaultDropIdx, solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
