/* trace-isv — PASSAGE À PLUSIEURS ÉQUIPES : moteur de placement (v0.51.0, refonte du lot 3 demandée par Henri le 24/11/2026).
   Fichier pur (aucun accès à la carte ni au stockage) : testable sous node, comme calc.js.

   Le passage = toutes les équipes larguées par le même avion sur le même axe. Il est entièrement défini par le point VERT de la
   première équipe (O) et le cap avion (h) : le vert d'une équipe est à « délai » secondes de vol après le rouge de la précédente.

   RÈGLE (Henri) : ce sont les POINTS ROSES (points d'ouverture, roses clairs compris = vert et rouge reportés à l'ouverture) de
   chaque équipe qui doivent être dans SA zone de relaxation. Le vert et le rouge eux-mêmes peuvent dépasser.

   Un « descripteur » d'équipe (voir desc) porte ce qu'il faut pour redessiner ses points roses n'importe où sans refaire le calcul
   complet (20 à 120 ms) : temps de sortie, état de largage (altitude, vitesse vraie, chute) et sa zone de relaxation.
   Le modèle sert à CHERCHER une position ; l'appli vérifie toujours le résultat par le calcul complet de chaque équipe. */
(function (root) {
  'use strict';
  const Calc = root.Calc || (typeof require !== 'undefined' ? require('./calc.js') : null);
  const RAD = Math.PI / 180;
  const move = (p, u, s) => Calc.fromLocal(p, { x: u.x * s, y: u.y * s });
  const mid = (a, b) => { const v = Calc.toLocal(a, b); return Calc.fromLocal(a, { x: v.x / 2, y: v.y / 2 }); };
  /* Angles essayés quand il faut tourner le cap avion : du plus petit au plus grand, des deux côtés (Henri : « d'abord sans tourner,
     puis de l'angle le plus petit possible »). Au degré près : l'arrondi à la dizaine est une étape à part, faite à la main. */
  const DHS = (() => { const o = [0]; for (const a of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 25, 30, 35, 40, 50, 60, 75, 90]) o.push(a, -a); return o; })();

  // Descripteur d'une équipe à partir de son calcul complet (s) ; zone = null pour une équipe dont la ZMT / le PTU ne sont pas posés
  function desc(s, delay, grp, placed) {
    return { te: s.ex.te.slice(), total: s.ex.total, idx: s.dropIdx, delay: Math.max(0, +delay || 0), altRel: s.altRel, tas: s.tas, fallSt: s.fallSt,
      zone: placed === false ? null : (s.zonePlan || s.zoneOuv), grp: grp == null ? null : grp };
  }

  /* Géométrie du passage pour un vert de tête O et un cap h. Par équipe : vert, rouge, point de largage du para sur la trace (att),
     son point d'ouverture (ouv), les deux bouts de la ligne des points roses (pA = vert reporté, pB = rouge reporté), vitesse sol. */
  function model(F, D, O, h) {
    const u = Calc.unit(h), out = []; let G = O, vgPrev = null;
    for (let k = 0; k < D.length; k++) { const d = D[k];
      if (k) G = move(out[k - 1].red, u, vgPrev * d.delay);
      const vg = Calc.groundSpeed(d.tas, Calc.windAt(F, G.lat, G.lng, d.altRel), h);
      const att = move(G, u, vg * d.te[d.idx]), dr = Calc.rseDrift(F, att, d.altRel, d.fallSt, h), ouv = Calc.fromLocal(att, dr);
      out.push({ green: G, red: move(G, u, vg * d.total), att, ouv, rse: dr, vg, pA: move(ouv, u, -vg * d.te[d.idx]), pB: move(ouv, u, vg * (d.total - d.te[d.idx])) });
      vgPrev = vg; }
    return out;
  }
  const passMid = M => mid(M[0].green, M[M.length - 1].red);
  /* Même passage tourné au cap h2 autour de son milieu (la longueur change un peu avec le cap : la vitesse sol dépend du vent) */
  function turned(F, D, O, h, h2) {
    const C = passMid(model(F, D, O, h)), u = Calc.unit(h2), M1 = model(F, D, C, h2), L = Calc.dist(M1[0].green, M1[M1.length - 1].red);
    const O2 = move(C, u, -L / 2); return { O: O2, M: model(F, D, O2, h2) };
  }

  /* Contrôle rapide après une translation t (mètres est / nord) : chaque point rose est ramené dans le repère de sa zone une fois
     pour toutes, il ne reste que de l'arithmétique. zr(zone, x, y) > 0 = dehors. */
  function zr(zone, x, y) { const d = Math.hypot(x, y); return zone.z ? d - Calc.zoneR(zone.z, Math.atan2(x, y)) : d - zone.R; }
  const zc = zone => (zone.z ? zone.z.c : zone.c);
  function prep(M, D) {
    const T = [], G = {};
    M.forEach((m, k) => { const d = D[k]; if (!d.zone) return; const c = zc(d.zone), q = p => Calc.toLocal(c, p);
      T.push({ k, zone: d.zone, pts: [q(m.pA), q(m.pB), q(m.ouv)] });
      if (d.grp != null) { const g = G[d.grp] || (G[d.grp] = { zone: d.zone, a: m.pA, b: m.pB }); g.b = m.pB; } });
    const groups = Object.keys(G).map(id => ({ id, zone: G[id].zone, m: Calc.toLocal(zc(G[id].zone), mid(G[id].a, G[id].b)) }));
    return { T, groups };
  }
  function viol(P, tx, ty) { let v = -Infinity; for (const t of P.T) for (const p of t.pts) { const w = zr(t.zone, p.x + tx, p.y + ty); if (w > v) v = w; } return v; }
  // Équipes dont un point rose dépasse (indices), pour dire laquelle
  function outs(P, tx, ty, m) { return P.T.filter(t => t.pts.some(p => zr(t.zone, p.x + tx, p.y + ty) > -m)).map(t => t.k); }
  /* « Perte » d'un groupe (équipes qui partagent une ZMT) : distance entre le milieu de sa ligne de points roses et le bord de sa zone.
     0 = la trace la plus longue passe pile par son milieu ; plus c'est grand, plus le groupe est rentré. */
  function losses(P, tx, ty) { return P.groups.map(g => Math.max(0, -zr(g.zone, g.m.x + tx, g.m.y + ty))); }
  const rmaxOf = D => 2.4 * Math.max(1000, ...D.filter(d => d.zone).map(d => Calc.zoneSpan(d.zone).max));

  /* Plus petite translation qui fait rentrer tous les points roses (marge m), en partant de t0. null si aucune jusqu'à Rmax. */
  function nearest(P, Rmax, m, t0) {
    const ok = (x, y) => viol(P, x, y) <= -m, x0 = t0 ? t0.x : 0, y0 = t0 ? t0.y : 0;
    if (ok(x0, y0)) return { x: x0, y: y0, r: 0 };
    const ND = 72, st = Math.max(20, Rmax / 500);
    for (let r = st; r <= Rmax; r += st) for (let i = 0; i < ND; i++) { const a = i * 2 * Math.PI / ND, sx = Math.sin(a), sy = Math.cos(a);
      if (!ok(x0 + sx * r, y0 + sy * r)) continue;
      let best = { a, r }; /* affinage : autour de cette direction, le plus petit rayon qui passe */
      for (let j = -6; j <= 6; j++) { const a2 = a + j * Math.PI / ND / 6, s2 = Math.sin(a2), c2 = Math.cos(a2); if (!ok(x0 + s2 * r, y0 + c2 * r)) continue;
        let lo = Math.max(0, r - 2 * st), hi = r; if (ok(x0 + s2 * lo, y0 + c2 * lo)) hi = lo; else for (let q = 0; q < 14; q++) { const md = (lo + hi) / 2; if (ok(x0 + s2 * md, y0 + c2 * md)) hi = md; else lo = md; }
        if (hi < best.r) best = { a: a2, r: hi }; }
      const rr = best.r + 0.5; return { x: x0 + Math.sin(best.a) * rr, y: y0 + Math.cos(best.a) * rr, r: rr }; }
    return null;
  }

  /* DÉCALER : plus petit déplacement du passage qui met toutes les équipes dans leur zone. D'abord sans tourner ; sinon le plus
     petit angle (au degré) pour lequel une translation existe. opt.dhs = [0] interdit de tourner (étape « Arrondir »). */
  function fitShift(F, D, O, h, opt) {
    opt = opt || {}; const m = opt.margin == null ? 15 : opt.margin, Rmax = rmaxOf(D);
    for (const dh of (opt.dhs || DHS)) { const h2 = Calc.n360(h + dh), R = dh ? turned(F, D, O, h, h2) : { O, M: model(F, D, O, h) };
      let P = prep(R.M, D), t = nearest(P, Rmax, m); if (!t) continue;
      /* le vent n'est pas le même partout : après un grand déplacement, la dérive sous RSE a un peu changé. On refait le modèle à
         l'arrivée et on corrige (quelques dizaines de mètres), jusqu'à ce que ça tienne sur place. */
      let O2 = Calc.fromLocal(R.O, t), good = t.r === 0;
      for (let q = 0; q < 5 && !good; q++) { P = prep(model(F, D, O2, h2), D); const t2 = nearest(P, Rmax, m); if (!t2) break; if (t2.r === 0) { good = true; break; } O2 = Calc.fromLocal(O2, t2); }
      if (!good) continue;
      return { ok: true, O: O2, h: h2, dh, dist: Calc.dist(R.O, O2) }; }
    return { ok: false };
  }

  /* VECTEUR AUTOMATIQUE d'un passage mixte (plusieurs ZMT) : le passage est rigide, on ne peut pas donner la trace la plus longue à
     tous les groupes. Henri : « répartir la misère » — la position retenue est celle où le groupe le plus rentré l'est le moins
     possible (puis où la somme des pertes est la plus petite). Départ : (O, h) proposé par l'appli (recalage du groupe de tête). */
  function fitBalance(F, D, O, h, opt) {
    opt = opt || {}; const m = opt.margin == null ? 15 : opt.margin, Rmax = rmaxOf(D);
    for (const dh of (opt.dhs || DHS)) { const h2 = Calc.n360(h + dh), R = dh ? turned(F, D, O, h, h2) : { O, M: model(F, D, O, h) };
      const P = prep(R.M, D), t0 = nearest(P, Rmax, m); if (!t0) continue;
      const cost = (x, y) => { if (viol(P, x, y) > -m) return Infinity; const l = losses(P, x, y); return Math.max(0, ...l) * 1000 + l.reduce((a, b) => a + b, 0); };
      let x = t0.x, y = t0.y, c = cost(x, y);
      for (let st = Math.max(200, Rmax / 20); st >= 4; st /= 2) { let moved = true, guard = 0;
        while (moved && guard++ < 400) { moved = false;
          for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, nx = x + Math.sin(a) * st, ny = y + Math.cos(a) * st, nc = cost(nx, ny); if (nc < c - 1e-6) { x = nx; y = ny; c = nc; moved = true; } } } }
      /* même remarque que pour fitShift : on revérifie sur place avec le modèle recalculé à l'arrivée */
      let O2 = Calc.fromLocal(R.O, { x, y }), P2 = prep(model(F, D, O2, h2), D), good = viol(P2, 0, 0) <= -m;
      for (let q = 0; q < 5 && !good; q++) { const t2 = nearest(P2, Rmax, m); if (!t2) break; O2 = Calc.fromLocal(O2, t2); P2 = prep(model(F, D, O2, h2), D); good = viol(P2, 0, 0) <= -m; }
      if (!good) continue;
      const l = losses(P2, 0, 0);
      return { ok: true, O: O2, h: h2, dh, losses: P2.groups.map((g, i) => ({ grp: g.id, loss: l[i] })) }; }
    return { ok: false };
  }

  /* Où poser le PTU d'une équipe qui n'en a pas encore (indice kNew, zone = null dans D) ?
     Z0 = sa zone de relaxation calculée pour un PTU provisoire ptu0 ; on admet que la zone garde la même forme autour d'un autre PTU
     (exact à vent uniforme et sol à la même altitude ; l'appli refait le calcul complet quand le PTU est posé).
       - intérieur : PTU pour lesquels ses points roses sont dans sa zone SANS RIEN BOUGER ;
       - extérieur : PTU qui deviennent possibles en DÉCALANT le passage (translation, et rotation du cap par pas de 10° jusqu'à 30°)
         tout en gardant les équipes déjà posées dans leur zone.
     Les deux contours sont rendus en points lat/lng (null si vide). */
  function ptuZones(F, D, kNew, O, h, Z0, ptu0, opt) {
    opt = opt || {}; const m = opt.margin == null ? 15 : opt.margin, c0 = zc(Z0), Rz = Calc.zoneSpan(Z0).max, off = Calc.toLocal(c0, ptu0) /* PTU vu du centre de sa zone */;
    const qNew = M => [M[kNew].pA, M[kNew].pB, M[kNew].ouv].map(p => Calc.toLocal(c0, p));
    /* d = déplacement du PTU par rapport à ptu0 : la zone se déplace d'autant, donc on teste le point rose q − d dans Z0 */
    const inD = (q, dx, dy) => { for (const p of q) if (zr(Z0, p.x - dx, p.y - dy) > -m) return false; return true; };
    const M0 = model(F, D, O, h), q0 = qNew(M0), cen = q => ({ x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 });
    const ring = (test, c, Rmax, scan) => { const out = [], N = 90; let any = false;
      for (let i = 0; i < N; i++) { const a = i * 2 * Math.PI / N, sx = Math.sin(a), sy = Math.cos(a); let r = 0;
        if (scan) { const st = Rmax / 60; for (let q = st; q <= Rmax; q += st) if (test(c.x + sx * q, c.y + sy * q)) r = q; /* le plus loin qui passe (contour pas forcément étoilé) */
          if (r > 0 || test(c.x, c.y)) { let lo = r, hi = r + st; for (let q = 0; q < 8; q++) { const md = (lo + hi) / 2; if (test(c.x + sx * md, c.y + sy * md)) lo = md; else hi = md; } r = lo; } }
        else if (test(c.x, c.y)) { let lo = 0, hi = Rmax; for (let q = 0; q < 18; q++) { const md = (lo + hi) / 2; if (test(c.x + sx * md, c.y + sy * md)) lo = md; else hi = md; } r = lo; }
        if (r > 1) any = true; out.push(r); }
      if (!any) return null;
      /* le contour extérieur est une réunion de zones décalées : festonné. Rayon lissé sur ±3 directions (jamais plus grand que le vrai + 2 %). */
      const R2 = scan ? out.map((r, i) => { let s = 0, w = 0; for (let j = -3; j <= 3; j++) { const k = 4 - Math.abs(j); s += out[(i + j + N) % N] * k; w += k; } return Math.min(s / w, r * 1.02 + 30); }) : out;
      return R2.map((r, i) => { const a = i * 2 * Math.PI / N; return Calc.fromLocal(ptu0, { x: c.x + Math.sin(a) * r, y: c.y + Math.cos(a) * r }); }); };
    const cIn = cen(q0), inner = ring((dx, dy) => inD(q0, dx, dy), cIn, 2.2 * Rz, false);
    // Extérieur : positions possibles des points roses de la nouvelle équipe quand le passage bouge sans sortir les autres de leur zone
    const S = [], Rmax = rmaxOf(D.concat([{ zone: Z0 }]));
    const placed = D.some(d => d.zone);
    for (const dh of (opt.dhsOuter || [0, 10, -10, 20, -20, 30, -30])) { const R = dh ? turned(F, D, O, h, Calc.n360(h + dh)) : { M: M0 };
      const P = prep(R.M, D), q = qNew(R.M), add = t => S.push(q.map(p => ({ x: p.x + t.x, y: p.y + t.y })));
      if (!placed) { if (!dh) add({ x: 0, y: 0 }); continue; }
      const t0 = nearest(P, Rmax, m); if (!t0) continue; add(t0);
      const ok = (x, y) => viol(P, x, y) <= -m, st = Math.max(30, Rmax / 240);
      for (let i = 0; i < 40; i++) { const a = i * Math.PI / 20, sx = Math.sin(a), sy = Math.cos(a); let r = 0; while (r + st <= Rmax && ok(t0.x + sx * (r + st), t0.y + sy * (r + st))) r += st;
        if (r > 0) { add({ x: t0.x + sx * r, y: t0.y + sy * r }); if (i % 5 === 0) add({ x: t0.x + sx * r / 2, y: t0.y + sy * r / 2 }); } } }
    let outer = null;
    if (S.length) { const cOut = inner ? cIn : cen(S[0]); outer = ring((dx, dy) => { for (const q of S) if (inD(q, dx, dy)) return true; return false; }, cOut, Rmax + 2.2 * Rz, true); }
    return { inner, outer, ptu0 };
  }
  /* Un PTU donné est-il dans le contour (liste de points lat/lng) ? Test du nombre de croisements, dans un repère local. */
  function inRing(ring, p) { if (!ring || ring.length < 3) return false; const P = ring.map(q => Calc.toLocal(p, q)); let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a.y > 0) !== (b.y > 0) && 0 < (b.x - a.x) * (0 - a.y) / (b.y - a.y) + a.x) c = !c; }
    return c; }

  /* Calcul complet d'une équipe dont le VERT est imposé (target) au cap avion imposé : on cherche le point de largage de son para
     sur la trace (manual) qui met son vert pile sur la cible. Départ au plus près (vert + vitesse sol × temps de sortie du para) :
     une ou deux passes suffisent, contre huit en partant d'un point quelconque. */
  function solveAt(prm, F, inp, e0, target, heading, vg0, m0) {
    const ex = Calc.exitTimes(inp.team, inp.tGreen, inp.tRed), n = inp.team.length, idx = (inp.dropIdx != null && inp.dropIdx >= 0 && inp.dropIdx < n) ? inp.dropIdx : Calc.defaultDropIdx(n), u = Calc.unit(heading);
    const base = Object.assign({}, inp, { vecHeading: heading, reversed: false, capManual: null, along: null });
    const mDef = move(target, u, (vg0 > 5 ? vg0 : 95) * ex.te[idx]), run = m => Calc.solve(Object.assign({}, base, { manual: m }), prm, F, e0);
    let m = m0 || mDef, s = null, best = null;
    for (let k = 0; k < 9; k++) { s = run(m); if (!s.ok || !s.vec) return { s, m };
      const q = Calc.toLocal(s.vec.green, target), e = Math.hypot(q.x, q.y); if (!best || e < best.e) best = { s, m, e }; if (e < 1.5) return { s, m };
      if (k === 2 && m0 && e > 50) { m = mDef; continue; } /* le point gardé en mémoire n'aide pas : on repart du point naturel */
      m = Calc.fromLocal(m, q); }
    /* Pas de point de largage qui mette le vert sur la cible : l'équipe est HORS de sa zone (le solveur ramène alors son vecteur sur
       la trace la plus proche, d'où l'écart). On rend le calcul fait au point naturel, pas un point qui a divagué (piège v0.51.0 :
       repartir d'un tel point faisait échouer « Décaler » alors qu'une position existait). */
    s = run(mDef); return { s, m: mDef, out: true };
  }
  /* RECALAGE d'un groupe d'équipes qui partagent la ZMT de la première équipe : le groupe est traité comme UN SEUL grand vecteur de
     durée T (du vert de sa première équipe au rouge de sa dernière). Le solveur le place comme il place une équipe seule : le point
     du milieu sur la trace la plus longue, rentré le long de cette trace jusqu'à ce que les deux bouts roses soient dans la zone.
     On lui donne pour cela une équipe d'un seul para (le moins performant), qui sort à T/2. Rend le calcul complet de ce para. */
  function virtualSolve(prm, F, inp, e0, T, para, heading) {
    return Calc.solve(Object.assign({}, inp, { team: [Object.assign({}, para, { dt: 0 })], tGreen: T / 2, tRed: T / 2, dropIdx: 0, manual: null, keepH: false, along: null,
      vecHeading: heading != null ? heading : inp.vecHeading }), prm, F, e0);
  }
  // Durée d'un groupe : du vert de sa première équipe (a) au rouge de sa dernière (b), délais compris
  function span(D, a, b) { let t = 0; for (let k = a; k <= b; k++) t += D[k].total + (k > a ? D[k].delay : 0); return t; }

  const api = { DHS, desc, model, turned, passMid, prep, viol, outs, losses, nearest, fitShift, fitBalance, ptuZones, inRing, solveAt, virtualSolve, span, move };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Pass = api;
})(typeof window !== 'undefined' ? window : globalThis);
