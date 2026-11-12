"use strict";
/* Analisi Flare: trova i flare in un file FlySight e li misura.
   Tutto gira nel browser, i file non lasciano il computer.

   Metodo (quello usato nelle analisi dei flare con la CR+):
   - angolo di traiettoria γ = atan2(-velD, vel orizzontale), positivo in salita;
     "dive angle" = -γ, positivo in picchiata (come FlySight Viewer);
   - carico n = V·dγ/dt / g + cos γ (pressione sulle ali nel piano verticale);
   - carico a pari velocità = n · (250 km/h / V)²: quanto sta lavorando l'ala, indipendente dalla velocità
     (è proporzionale al coefficiente di portanza). Serve per confrontare ingressi a 320 e a 420 km/h;
   - orizzontale = primo istante in cui la velocità verticale passa da discesa a salita;
   - guadagno = quota all'apice − quota del punto più basso;
   - guadagno ideale = (V orizzontale² − V apice²) / 2g, efficienza = guadagno / ideale;
   - drag polar: accelerazione aerodinamica = dv/dt − g, divisa in resistenza (opposta alla velocità)
     e portanza (perpendicolare); CL = 2·m·aL / (ρ·V²·S), CD = 2·m·aD / (ρ·V²·S), ρ dall'atmosfera standard. */

const G = 9.80665;
const KMH = 3.6;

// ------------------------------------------------------------- soglie di giudizio
// Tarate sui flare con la Squirrel CR+ (ottobre-novembre 2026) e verificate su flare da +87…+158 m di altri piloti.
// Carico e rotazione nella parte ripida sono riportati a una velocità fissa: a 420 km/h la stessa ala dà molti
// più g e ruota più in fretta che a 320, senza che il pilota stia tirando di più.
const V_LOAD = 250 / KMH;  // m/s
const V_ROT = 300 / KMH;   // m/s
const T = {
  vLevel: [210, 230],    // km/h in orizzontale: sotto 210 bassa, sopra 230 ottima
  steepLoad: [1.85, 2.4], // carico riportato a 250 km/h, massimo finché la picchiata è oltre 25°
  rot1: [8.5, 12],       // °/s da 45° a 25°, riportati a 300 km/h
  t45: [3.5, 4.5],       // s da 45° all'orizzontale
  peakAngle: [12, 22],   // ° di picchiata al momento del picco di carico
  hold: [1.6, 1.9],      // g un secondo dopo l'orizzontale
  climb: [14, 20],       // ° di salita massima
  apex: [90, 100],       // km/h all'apice (margine dallo stallo)
  eff: [22, 26],         // % efficienza della salita
};

// Il flare record con la CR+ (+59 m, 8/11/2026): carico riportato a 250 km/h per angolo di traiettoria,
// da V max alla salita massima.
const REFERENCE = {
  label: "Riferimento +59 m",
  pts: [[-37.8, 1.10], [-36.5, 1.13], [-35.1, 1.16], [-33.7, 1.16], [-32.3, 1.21], [-30.7, 1.29], [-29.0, 1.38],
    [-27.1, 1.49], [-25.1, 1.56], [-23.1, 1.61], [-21.0, 1.67], [-18.8, 1.75], [-16.6, 1.80], [-14.4, 1.93],
    [-11.9, 2.10], [-9.3, 2.26], [-6.6, 2.42], [-3.7, 2.60], [-0.7, 2.75], [2.3, 2.89], [5.3, 3.04], [8.3, 3.24],
    [11.4, 3.42], [14.3, 3.46], [16.8, 3.39], [19.0, 3.27], [20.7, 3.16], [22.2, 3.24], [23.7, 3.33], [24.7, 3.14]],
};

// Massa in volo e superficie della tuta per i coefficienti della drag polar: cambiano la scala di CL e CD,
// non la forma della polare né il rapporto L/D.
const SUIT_DEFAULTS = { mass: 80, area: 2 };

// densità dell'aria (kg/m³) nell'atmosfera standard
const rho = (h) => 1.225 * Math.max(0, 1 - 2.25577e-5 * h) ** 4.2559;

// ======================================================================= lettura

function parseTime(text) {
  const t = Date.parse(text.trim().replace(" ", "T").replace(/Z?$/, "Z"));
  if (Number.isNaN(t)) throw new Error(text);
  return t / 1000;
}

function parseTrack(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("Il file è vuoto.");
  const pts = [];
  const num = (v) => (v == null || v === "" ? NaN : Number(v));

  if (lines.slice(0, 200).some((l) => l.startsWith("$GNSS"))) {        // FlySight 2
    let cols = null;
    for (const l of lines) {
      const p = l.split(",");
      if (p[0] === "$COL" && p[1] === "GNSS") cols = p.slice(2);
      else if (p[0] === "$GNSS" && cols) {
        const r = Object.fromEntries(cols.map((c, i) => [c, p[i + 1]]));
        try {
          pts.push({ t: parseTime(r.time), alt: num(r.hMSL), vn: num(r.velN), ve: num(r.velE), vd: num(r.velD),
            vacc: num(r.vAcc), sats: num(r.numSV) });
        } catch { /* riga incompleta */ }
      }
    }
  } else {
    const head = lines[0].split(",").map((h) => h.trim());
    const ix = (name) => head.indexOf(name);
    if (["time", "hMSL", "velN", "velE", "velD"].every((c) => ix(c) >= 0)) {   // FlySight 1 / Viewer CSV
      for (const l of lines.slice(1)) {
        const p = l.split(",");
        try {
          pts.push({ t: parseTime(p[ix("time")]), alt: num(p[ix("hMSL")]), vn: num(p[ix("velN")]),
            ve: num(p[ix("velE")]), vd: num(p[ix("velD")]), vacc: num(p[ix("vAcc")]), sats: num(p[ix("numSV")]) });
        } catch { /* riga delle unità di misura */ }
      }
    } else if (["gps_time", "h_speed", "v_speed"].every((c) => ix(c) >= 0)) {   // CSV skyderby
      const altCol = ix("abs_altitude") >= 0 ? "abs_altitude" : "altitude";
      for (const l of lines.slice(1)) {
        const p = l.split(",");
        try {
          pts.push({ t: parseTime(p[ix("gps_time")]), alt: num(p[ix(altCol)]), vn: num(p[ix("h_speed")]) / KMH,
            ve: 0, vd: num(p[ix("v_speed")]) / KMH, vacc: NaN, sats: NaN });
        } catch { /* riga non valida */ }
      }
    } else {
      throw new Error("Formato non riconosciuto: serve un file FlySight 1, FlySight 2 (TRACK.CSV) o un CSV di skyderby.");
    }
  }
  const ok = pts.filter((p) => [p.t, p.alt, p.vn, p.ve, p.vd].every(Number.isFinite))
    .filter((p) => !(p.vacc > 20)) // punti senza fix buono (prima dell'aggancio dei satelliti)
    .sort((a, b) => a.t - b.t)
    .filter((p, i, a) => i === 0 || p.t > a[i - 1].t);
  if (ok.length < 50) throw new Error("Troppi pochi punti validi nel file.");
  return ok;
}

// ======================================================================= calcoli

function movingAvg(v, n) {
  if (n <= 1) return v.slice();
  const h = n >> 1;
  return v.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(v.length - 1, i + h); k++) { s += v[k]; c++; }
    return s / c;
  });
}

function buildTrack(points) {
  const t0 = points[0].t;
  const t = points.map((p) => p.t - t0);
  const dts = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  const hz = 1 / dts[dts.length >> 1];
  const w = hz >= 8 ? 3 : 1;   // a 10 Hz si media su 3 punti, a 5 Hz si usano i dati grezzi
  const vn = movingAvg(points.map((p) => p.vn), w);
  const ve = movingAvg(points.map((p) => p.ve), w);
  const vd = movingAvg(points.map((p) => p.vd), w);
  const alt = points.map((p) => p.alt);
  const vh = vn.map((v, i) => Math.hypot(v, ve[i]));
  const vt = vh.map((v, i) => Math.hypot(v, vd[i]));
  const gam = vh.map((v, i) => Math.atan2(-vd[i], v));          // rad, + = salita
  const n = gam.map((g, i) => {
    const a = Math.max(0, i - 1), b = Math.min(gam.length - 1, i + 1);
    const dg = (gam[b] - gam[a]) / (t[b] - t[a] || 1);
    return (vt[i] * dg) / G + Math.cos(g);
  });
  const E = alt.map((h, i) => h + vt[i] ** 2 / (2 * G));
  const dist = [0];
  for (let i = 1; i < t.length; i++) dist.push(dist[i - 1] + ((vh[i] + vh[i - 1]) / 2) * (t[i] - t[i - 1]));

  // accelerazioni aerodinamiche per la drag polar: derivate su ~0,8 s per contenere il rumore del GPS
  const k = Math.max(1, Math.round(0.4 * hz));
  const aL = [], aD = [];
  for (let i = 0; i < t.length; i++) {
    const a = Math.max(0, i - k), b = Math.min(t.length - 1, i + k);
    const dt = t[b] - t[a] || 1;
    const ax = (vn[b] - vn[a]) / dt, ay = (ve[b] - ve[a]) / dt, az = (vd[b] - vd[a]) / dt - G;  // NED, senza gravità
    const v = vt[i] || 1;
    const drag = -(ax * vn[i] + ay * ve[i] + az * vd[i]) / v;
    aD.push(drag);
    aL.push(Math.sqrt(Math.max(0, ax * ax + ay * ay + az * az - drag * drag)));
  }
  return { t0, t, hz, alt, vh, vd, vt, gam: gam.map((g) => (g * 180) / Math.PI), n, E, dist, aL, aD };
}

// CL e CD nel punto i (con massa e superficie della tuta)
function coeffs(tr, i, suit) {
  const q = 0.5 * rho(tr.alt[i]) * tr.vt[i] ** 2 * suit.area / suit.mass;
  return { cl: tr.aL[i] / q, cd: tr.aD[i] / q };
}

// indici della drag polar di un flare: da V max all'apice, solo dove la resistenza è misurabile
function polarRange(tr, f) {
  const out = [];
  for (let i = f.ipk; i <= f.top; i++) if (tr.vt[i] > 20 && tr.aD[i] > 0.3) out.push(i);
  return out;
}

// carico riportato a 250 km/h: proporzionale al coefficiente di portanza
function wingLoad(tr, i) { return tr.n[i] * (V_LOAD / tr.vt[i]) ** 2; }

// indice del primo punto con t >= sec
function idx(tr, sec) {
  let lo = 0, hi = tr.t.length - 1;
  if (sec <= tr.t[0]) return 0;
  if (sec >= tr.t[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.t[m] < sec) lo = m; else hi = m; }
  return hi;
}
function at(tr, arr, sec) {
  const i = idx(tr, sec);
  if (i === 0 || tr.t[i] === sec) return arr[i];
  const f = (sec - tr.t[i - 1]) / (tr.t[i] - tr.t[i - 1]);
  return arr[i - 1] + f * (arr[i] - arr[i - 1]);
}
function argmax(arr, a, b) { let k = a; for (let i = a; i <= b; i++) if (arr[i] > arr[k]) k = i; return k; }
function argmin(arr, a, b) { let k = a; for (let i = a; i <= b; i++) if (arr[i] < arr[k]) k = i; return k; }

function sustained(tr, from, cond, seconds) {
  let run = null;
  for (let i = from; i < tr.t.length; i++) {
    if (cond(i)) { if (run == null) run = i; if (tr.t[i] - tr.t[run] >= seconds) return run; }
    else run = null;
  }
  return null;
}

function findGround(tr, endIdx) {
  // quota media dei punti fermi dopo l'atterraggio
  const still = [];
  for (let i = endIdx; i < tr.t.length; i++) if (tr.vt[i] < 1) still.push(tr.alt[i]);
  if (still.length < 20) return null;
  still.sort((a, b) => a - b);
  return still[still.length >> 1];
}

function analyzeTrack(points, opts = {}) {
  const tr = buildTrack(points);
  let lo, hi;
  if (opts.da != null || opts.a != null) {
    lo = idx(tr, opts.da ?? 0); hi = idx(tr, opts.a ?? tr.t[tr.t.length - 1]);
  } else {
    lo = sustained(tr, 0, (i) => tr.vd[i] > 10, 2);
    if (lo == null) throw new Error("Non trovo l'uscita (una discesa sostenuta oltre 36 km/h). Indica l'intervallo a mano.");
    const end = sustained(tr, idx(tr, tr.t[lo] + 8), (i) => tr.vt[i] < 16, 2);
    hi = end ?? tr.t.length - 1;
  }
  const groundAuto = findGround(tr, hi);
  const ground = opts.ground ?? groundAuto ?? 0;
  const suit = { mass: opts.mass || SUIT_DEFAULTS.mass, area: opts.area || SUIT_DEFAULTS.area };
  const flares = findFlares(tr, lo, hi).map((lv) => measure(tr, lv, lo, hi, ground, suit)).filter(Boolean);
  return { tr, lo, hi, ground, groundAuto, suit, flares };
}

function findFlares(tr, lo, hi) {
  // momenti in cui la velocità verticale arriva vicino a zero dopo una picchiata
  const out = [];
  let last = -Infinity;
  for (let i = lo + 1; i < hi; i++) {
    const vd = tr.vd[i];
    if (!(vd < 5 && vd <= tr.vd[i - 1] && vd <= tr.vd[i + 1] && tr.vt[i] > 25)) continue;
    // orizzontale: inizio del tratto in salita che contiene il minimo (la salita può durare parecchi secondi),
    // altrimenti il minimo stesso
    let lv = i;
    while (lv > lo && tr.vd[lv - 1] <= 0) lv--;
    // prima dell'orizzontale ci deve essere una picchiata vera (oltre 54 km/h di velocità verticale)
    const back = idx(tr, tr.t[lv] - 4);
    let maxVd = -Infinity;
    for (let k = back; k < lv; k++) maxVd = Math.max(maxVd, tr.vd[k]);
    if (maxVd < 15) continue;
    if (tr.t[lv] - last < 5) continue;
    last = tr.t[lv];
    out.push(lv);
  }
  return out;
}

function measure(tr, lv, lo, hi, ground, suit) {
  const tl = tr.t[lv];
  const ipk = argmax(tr.vt, Math.max(lo, idx(tr, tl - 12)), lv);           // V max prima della richiamata
  const top = argmax(tr.alt, lv, Math.min(hi, idx(tr, tl + 12)));          // apice
  const bot = argmin(tr.alt, Math.max(lo, idx(tr, tl - 3)), Math.min(hi, idx(tr, tl + 1)));
  if (top <= lv) return null;
  const da = (i) => -tr.gam[i];                                            // dive angle, + = picchiata
  const kmc = argmax(tr.gam, lv, top);                                     // salita massima

  // istante in cui il dive angle vale A, cercando all'indietro dall'orizzontale
  const crossBack = (A) => {
    let k = lv;
    const stop = Math.max(lo, idx(tr, tl - 15));
    while (k > stop && da(k) < A) k--;
    if (da(k) < A || k === lv) return null;
    const f = (da(k) - A) / (da(k) - da(k + 1));
    return tr.t[k] + f * (tr.t[k + 1] - tr.t[k]);
  };
  // istante in cui l'angolo di salita vale A, cercando in avanti dall'orizzontale
  const crossFwd = (A) => {
    for (let k = lv; k < kmc; k++) {
      if (tr.gam[k] <= A && tr.gam[k + 1] > A) {
        const f = (A - tr.gam[k]) / (tr.gam[k + 1] - tr.gam[k]);
        return tr.t[k] + f * (tr.t[k + 1] - tr.t[k]);
      }
    }
    return null;
  };
  const t45 = crossBack(45), t25 = crossBack(25);
  const pk = argmax(tr.n, ipk, top);

  // carico massimo nella parte ripida (oltre 25° di picchiata, da V max in poi)
  let steep = null, steepN = null, steepV = null;
  for (let i = ipk; i <= lv; i++) {
    if (da(i) <= 25) continue;
    const c = tr.n[i] * (V_LOAD / tr.vt[i]) ** 2;
    if (steepN == null || c > steepN) { steepN = c; steepV = tr.vt[i] * KMH; }
    steep = Math.max(steep ?? -Infinity, tr.n[i]);
  }
  // velocità media tra 45° e 25°, per riportare la rotazione a 300 km/h
  let vRot = null;
  if (t45 != null && t25 != null) {
    let sum = 0, c = 0;
    for (let i = idx(tr, t45); i <= idx(tr, t25); i++) { sum += tr.vt[i]; c++; }
    vRot = sum / c;
  }

  const loadAt = (sec) => (sec == null ? null : at(tr, tr.n, sec));
  const byAngle = [
    ...[50, 40, 30, 20, 10].map((A) => ({ label: `${A}° giù`, value: loadAt(crossBack(A)) })),
    { label: "orizz.", value: tr.n[lv] },
    ...[10, 20].map((A) => ({ label: `${A}° su`, value: loadAt(crossFwd(A)) })),
  ];

  const v0 = tr.vt[lv], vr = tr.vt[top];
  const gain = tr.alt[top] - tr.alt[bot];
  const ideal = (v0 ** 2 - vr ** 2) / (2 * G);

  const f = {
    lv, ipk, top, bot, pk, kmc,
    tLevel: tl,
    altLevel: tr.alt[lv] - ground,
    dive: da(ipk),
    vmax: tr.vt[ipk] * KMH,
    vLevel: v0 * KMH,
    peak: tr.n[pk], peakDt: tr.t[pk] - tl, peakAngle: da(pk),
    nLevel: tr.n[lv],
    n06: loadAt(tl + 0.6), n1: loadAt(tl + 1), n16: loadAt(tl + 1.6),
    steep, steepN, steepV,
    climb: tr.gam[kmc], climbDt: tr.t[kmc] - tl,
    vApex: vr * KMH, apexDt: tr.t[top] - tl,
    gain,
    eloss: tr.E[ipk] - tr.E[lv],
    rot1: t45 != null && t25 != null ? 20 / (t25 - t45) : null,
    rot1n: vRot != null ? (20 / (t25 - t45)) * (V_ROT / vRot) : null,
    vRot: vRot != null ? vRot * KMH : null,
    rot2: t25 != null ? 25 / (tl - t25) : null,
    t45: t45 != null ? tl - t45 : null,
    ideal, drag: ideal - gain, eff: ideal > 5 ? (gain / ideal) * 100 : null,
    byAngle,
    ...polarStats(tr, { ipk, top }, suit),
    marks: [
      { t: tr.t[ipk] - tl, label: "V max" },
      ...(t45 != null ? [{ t: t45 - tl, label: "45°" }] : []),
      ...(t25 != null ? [{ t: t25 - tl, label: "25°" }] : []),
      { t: 0, label: "orizz." },
      { t: tr.t[pk] - tl, label: "picco g" },
      { t: tr.t[top] - tl, label: "apice" },
    ],
  };
  f.verdict = judge(f);
  return f;
}

// L/D massimo e CL massimo lungo il flare
function polarStats(tr, f, suit) {
  let ldMax = null, clMax = null, ldAt = null;
  for (const i of polarRange(tr, f)) {
    const ld = tr.aL[i] / tr.aD[i];
    if (ldMax == null || ld > ldMax) { ldMax = ld; ldAt = i; }
    const { cl } = coeffs(tr, i, suit);
    if (clMax == null || cl > clMax) clMax = cl;
  }
  return { ldMax, ldAtV: ldAt == null ? null : tr.vt[ldAt] * KMH, clMax };
}

// ===================================================================== giudizio

function grade(v, [a, b], higherIsBetter = true) {
  if (v == null || !Number.isFinite(v)) return null;
  if (higherIsBetter) return v >= b ? "ok" : v >= a ? "warn" : "bad";
  return v <= a ? "ok" : v <= b ? "warn" : "bad";
}

function judge(f) {
  const r = (v, d = 0) => (v == null ? "–" : v.toFixed(d).replace(".", ","));
  const items = [];
  const add = (level, title, text) => { if (level) items.push({ level, title, text }); };

  add(grade(f.vLevel, T.vLevel), "Velocità in orizzontale",
    `${r(f.vLevel)} km/h. È il carburante della salita: conta al quadrato. ` +
    (f.vLevel >= T.vLevel[1] ? "Ottima." : f.vLevel >= T.vLevel[0] ? "Buona, sopra i 230 diventa ottima."
      : "Bassa: la velocità si è consumata nella richiamata, prima di poterla usare."));

  if (f.steepN != null) {
    add(grade(f.steepN, T.steepLoad, false), "Parte ripida",
      `Fino a 25° di picchiata arrivi a ${r(f.steep, 1)} g a ${r(f.steepV)} km/h, cioè ${r(f.steepN, 1)} g riportati a 250 km/h. ` +
      (f.steepN <= T.steepLoad[0] ? "Leggera, come deve essere." :
        f.steepN <= T.steepLoad[1] ? "Un po' carica: in questa fase l'ala deve lavorare poco (sotto 1,8 a 250 km/h)." :
          "Strappo: tanta pressione mentre sei ancora ripido frena e brucia velocità."));
  }
  if (f.rot1n != null) {
    add(grade(f.rot1n, T.rot1, false), "Rotazione da 45° a 25°",
      `${r(f.rot1, 1)} °/s a ${r(f.vRot)} km/h (${r(f.rot1n, 1)} °/s riportati a 300 km/h), ${r(f.t45, 1)} s da 45° all'orizzontale. ` +
      (f.rot1n <= T.rot1[0] ? "Paziente, bene." : f.rot1n <= T.rot1[1] ? "Un po' veloce: a 300 km/h punta a 7–8 °/s e 5 s fino all'orizzontale."
        : "Troppo veloce: è il segno dello strappo."));
  }
  add(grade(f.peakAngle, T.peakAngle, false), "Picco di carico",
    `${r(f.peak, 1)} g quando eri a ${r(Math.max(0, f.peakAngle))}° di picchiata (${r(f.peakDt, 1)} s). ` +
    (f.peakAngle <= T.peakAngle[0] ? "Nel posto giusto, a cavallo dell'orizzonte." :
      f.peakAngle <= T.peakAngle[1] ? "Un po' presto: spostalo verso l'orizzonte." : "Troppo presto, nella parte ripida."));
  add(grade(f.n1, T.hold), "Dopo l'orizzonte",
    `${r(f.n1, 1)} g un secondo dopo. ` +
    (f.n1 >= T.hold[1] ? "Hai tenuto la pressione." : f.n1 >= T.hold[0] ? "Cala un po' presto: continua a ruotare per 2 s."
      : "Hai mollato all'orizzonte: la salita resta piatta."));
  add(grade(f.climb, T.climb), "Salita",
    `Massimo ${r(f.climb)}° dopo ${r(f.climbDt, 1)} s. ` +
    (f.climb >= T.climb[1] ? "Decisa." : f.climb >= T.climb[0] ? "Discreta: con la CR+ punta a 20–25°." : "Piatta."));
  if (f.eff != null) {
    add(grade(f.eff, T.eff), "Efficienza della salita",
      `${r(f.eff)}%: ${r(f.gain)} m su ${r(f.ideal)} m teorici (${r(f.drag)} m persi per resistenza). ` +
      (f.eff >= 35 ? "Molto alta, sopra i flare migliori con la CR+ (~28%)." : f.eff >= T.eff[1] ? "In linea con i flare migliori (~28%)." : "Bassa: hai perso energia volando in piano invece di salire."));
  }
  add(grade(f.vApex, T.apex), "Margine allo stallo",
    `${r(f.vApex)} km/h all'apice. ` +
    (f.vApex >= T.apex[1] ? "Margine buono." : f.vApex >= T.apex[0] ? "Attenzione: inizia a rilasciare un attimo prima."
      : "Molto lento, sei vicino allo stallo: rilascia prima."));

  // consiglio principale: il primo problema nell'ordine del flare
  const order = ["Parte ripida", "Rotazione da 45° a 25°", "Velocità in orizzontale", "Picco di carico",
    "Dopo l'orizzonte", "Salita", "Margine allo stallo"];
  const ADVICE = {
    "Parte ripida": "Nella parte ripida pressione leggera: lascia correre la velocità e tieni la spinta forte per gli ultimi 20°.",
    "Rotazione da 45° a 25°": "Ruota più piano finché sei ripido: da 45° all'orizzontale prenditi almeno 5 secondi.",
    "Velocità in orizzontale": "Arriva più veloce in orizzontale: picchiata più lunga e richiamata più leggera all'inizio.",
    "Picco di carico": "Sposta la spinta più forte verso l'orizzonte, non prima.",
    "Dopo l'orizzonte": "Non mollare all'orizzonte: continua a ruotare per 2 secondi, fino a 20–25° di salita.",
    "Salita": "Continua a ruotare dopo l'orizzonte per salire più ripido.",
    "Margine allo stallo": "Inizia il rilascio prima dell'apice: sei vicino allo stallo.",
  };
  const worst = (lvl) => order.find((t) => items.some((i) => i.title === t && i.level === lvl));
  const key = worst("bad") ?? worst("warn");
  return { items, advice: key ? ADVICE[key] : "Flare pulito: ripetilo uguale e prova ad arrivare ancora più veloce in orizzontale." };
}

if (typeof module !== "undefined") module.exports = { parseTrack, analyzeTrack, buildTrack, coeffs, polarRange };

// ===================================================================== interfaccia

if (typeof document !== "undefined") {

const $ = (sel) => document.querySelector(sel);
const FLARE_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
let lastFiles = [];

function setStatus(text, isError = false) {
  const n = $("#status");
  n.textContent = text;
  n.classList.toggle("error", isError);
}
const nextFrame = () => new Promise((r) => setTimeout(r, 30));
function readNumber(id) {
  const v = $(id).value.trim().replace(",", ".");
  return v === "" ? null : Number(v);
}

async function run(files) {
  if (!files.length) return;
  lastFiles = files;
  $("#rerun").disabled = false;
  const opts = { da: readNumber("#da"), a: readNumber("#a"), ground: readNumber("#ground"),
    mass: readNumber("#mass"), area: readNumber("#area") };
  try {
    localStorage.setItem("flare-suit", JSON.stringify({ mass: $("#mass").value, area: $("#area").value }));
  } catch { /* storage non disponibile */ }
  const results = [];
  for (const [k, file] of files.entries()) {
    setStatus(`Analizzo ${file.name} (${k + 1} di ${files.length})…`);
    await nextFrame();
    try {
      const res = analyzeTrack(parseTrack(await file.text()), opts);
      results.push({ name: file.name, ...res });
    } catch (e) {
      console.error(e);
      results.push({ name: file.name, error: e.message || String(e) });
    }
  }
  render(results);
  const found = results.reduce((n, r) => n + (r.flares ? r.flares.length : 0), 0);
  setStatus(`${results.length} ${results.length === 1 ? "file analizzato" : "file analizzati"}, ` +
    `${found} ${found === 1 ? "flare trovato" : "flare trovati"}.`);
}

// ---------------------------------------------------------------- formattazione

const nf = (v, d = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d).replace(".", ","));
const signed = (v, d = 0) => (v == null || !Number.isFinite(v) ? "–" : (v > 0 ? "+" : "") + nf(v, d));
function stem(name) { return name.replace(/\.[^.]+$/, ""); }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const SUMMARY_HEADERS = ["flare", "quota orizz. (m)", "picchiata (°)", "V max", "V orizz.", "carico ripida (g a 250 km/h)",
  "rot. 45→25 (°/s a 300 km/h)", "45°→orizz. (s)", "picco g", "picco a (° giù)", "g +1 s", "salita max (°)", "V apice",
  "guadagno (m)", "ideale (m)", "efficienza (%)", "L/D max", "CL max"];

function summaryRow(label, f) {
  return [label, nf(f.altLevel), nf(f.dive), nf(f.vmax), nf(f.vLevel), nf(f.steepN, 1), nf(f.rot1n, 1), nf(f.t45, 1),
    nf(f.peak, 2), nf(Math.max(0, f.peakAngle)), nf(f.n1, 2), nf(f.climb), nf(f.vApex), signed(f.gain, 1),
    nf(f.ideal), nf(f.eff), nf(f.ldMax, 2), nf(f.clMax, 2)];
}

// ---------------------------------------------------------------- render

function render(results) {
  const root = $("#results");
  root.replaceChildren();
  const all = results.flatMap((r) => (r.flares || []).map((f, i) => ({
    r, f, label: results.length > 1 ? `${stem(r.name)} · F${i + 1}` : `Flare ${i + 1}`,
  })));
  if (all.length > 1) {
    const rows = all.map((a) => summaryRow(a.label, a.f));
    root.append(el("section", { class: "card" },
      el("div", { class: "block-head" },
        el("h2", {}, "Confronto tra i flare"),
        csvButton("confronto_flare.csv", SUMMARY_HEADERS, rows)),
      el("p", { class: "hint" }, "Velocità in km/h. In evidenza il guadagno migliore."),
      table(SUMMARY_HEADERS, rows, { best: 13 }),
      overlay(all)));
  }
  for (const r of results) root.append(fileCard(r));
}

function fileCard(r) {
  const card = el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, r.name)));
  if (r.error) { card.append(el("p", { class: "err" }, r.error)); return card; }
  const tr = r.tr;
  const groundText = r.groundAuto != null ? `suolo a ${nf(r.ground)} m s.l.m.`
    : (r.ground ? `suolo a ${nf(r.ground)} m (inserito a mano)` : "suolo non trovato: quote sul livello del mare");
  card.append(el("p", { class: "meta" },
    `${tr.t.length} punti a ${nf(tr.hz)} Hz · volo da ${nf(tr.t[r.lo])} s a ${nf(tr.t[r.hi])} s · ${groundText} · ` +
    `drag polar con ${nf(r.suit.mass)} kg e ${nf(r.suit.area, 1)} m²` +
    (tr.hz < 4 ? " · dati sotto i 5 Hz: carichi e rotazioni sono approssimati" : "")));

  if (!r.flares.length) {
    card.append(el("p", { class: "err" }, "Nessun flare trovato. Prova a indicare l'intervallo a mano."));
    return card;
  }
  const base = stem(r.name);
  const rows = r.flares.map((f, i) => summaryRow(`F${i + 1}`, f));
  card.append(el("div", { class: "block" },
    el("div", { class: "block-head" }, el("h3", {}, "Riepilogo"),
      csvButton(`${base}_flare.csv`, SUMMARY_HEADERS, rows)),
    table(SUMMARY_HEADERS, rows, { best: 13 })));
  // un flare alla volta: si parte da quello con il guadagno migliore
  const list = el("div", { class: "flares" });
  const show = (k) => {
    list.replaceChildren(flareBlock(tr, r.flares[k], k + 1, r));
    seg.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-checked", String(j === k)));
  };
  const seg = el("div", { class: "seg", role: "radiogroup", "aria-label": "Flare da analizzare" },
    ...r.flares.map((f, i) => el("button", { type: "button", role: "radio", onclick: () => show(i) },
      `F${i + 1} · ${signed(f.gain)} m`)));
  if (r.flares.length > 1) {
    card.append(el("div", { class: "block flare-pick" },
      el("span", { class: "field-label" }, "Flare da analizzare"), seg));
  }
  card.append(list);
  show(r.flares.reduce((b, f, i) => (f.gain > r.flares[b].gain ? i : b), 0));
  return card;
}

function stat(label, value, unit, sub) {
  return el("div", { class: "kpi" }, el("span", { class: "kpi-label" }, label),
    el("span", { class: "kpi-value" }, value, unit ? el("small", {}, ` ${unit}`) : null),
    sub ? el("span", { class: "kpi-sub" }, sub) : null);
}

const ICON = { ok: "✓", warn: "!", bad: "✕" };
const WORD = { ok: "bene", warn: "da migliorare", bad: "problema" };

function flareBlock(tr, f, n, r) {
  const from = Math.max(r.lo, idx(tr, Math.min(tr.t[f.ipk] - 1, f.tLevel - 8)));
  const to = Math.min(r.hi, idx(tr, tr.t[f.top] + 1));
  const range = []; for (let i = from; i <= to; i++) range.push(i);
  const x = range.map((i) => tr.t[i] - f.tLevel);
  const marks = f.marks;

  const ang = range.filter((i) => i >= f.ipk && i <= f.kmc);
  const verdict = f.verdict;

  return el("div", { class: "flare" },
    el("div", { class: "block-head" }, el("h3", {}, `Flare ${n}`),
      el("span", { class: "hint" }, `orizzontale a ${nf(tr.t[f.lv], 1)} s · ${nf(f.altLevel)} m`)),
    el("div", { class: "kpis" },
      stat("Guadagno", signed(f.gain, 1), "m", `ideale ${nf(f.ideal)} m · efficienza ${nf(f.eff)}%`),
      stat("V in orizzontale", nf(f.vLevel), "km/h", `da V max ${nf(f.vmax)} a ${nf(f.dive)}°`),
      stat("Picco di carico", nf(f.peak, 1), "g", `a ${nf(Math.max(0, f.peakAngle))}° di picchiata`),
      stat("Dopo 1 s", nf(f.n1, 1), "g", `salita max ${nf(f.climb)}°`),
      stat("Apice", nf(f.vApex), "km/h", `${nf(f.apexDt, 1)} s dopo l'orizzontale`),
      stat("L/D massimo", nf(f.ldMax, 2), "", `a ${nf(f.ldAtV)} km/h · CL max ${nf(f.clMax, 2)}`)),
    el("div", { class: "verdict" },
      el("p", { class: "advice" }, el("b", {}, "Prossimo salto: "), verdict.advice),
      el("ul", { class: "checks" }, ...verdict.items.map((it) =>
        el("li", { class: it.level },
          el("span", { class: "badge", "aria-hidden": "true" }, ICON[it.level]),
          el("span", {}, el("b", {}, it.title), el("span", { class: "sr" }, ` (${WORD[it.level]})`), ": ", it.text))))),
    el("div", { class: "flare-grid" },
      el("div", {},
        el("p", { class: "chart-title" }, "Quanto lavora l'ala: carico riportato a 250 km/h (g) · ← picchiata · salita →"),
        xyChart({ traces: [
          { label: "Questo flare", color: "var(--s1)", x: ang.map((i) => tr.gam[i]), y: ang.map((i) => wingLoad(tr, i)), t: ang.map((i) => tr.t[i] - f.tLevel) },
          { label: REFERENCE.label, color: "var(--muted)", dash: true, x: REFERENCE.pts.map((p) => p[0]), y: REFERENCE.pts.map((p) => p[1]), t: REFERENCE.pts.map(() => NaN) }],
          xName: "angolo traiettoria", yName: "carico a 250 km/h", xUnit: "°", yUnit: "g", minH: 220, maxH: 300, digits: 1 })),
      el("div", {},
        el("p", { class: "chart-title" }, "Dive angle (°) come in FlySight Viewer · negativo = salita"),
        lineChart({ x, unit: "°", xUnit: "s", height: 240, marks, zero: true,
          series: [{ label: "Dive angle", color: "var(--s1)", values: range.map((i) => -tr.gam[i]) }] })),
      el("div", {},
        el("p", { class: "chart-title" }, "Carico sulle ali (g) · 0 s = orizzontale"),
        lineChart({ x, unit: "g", xUnit: "s", height: 240, marks, digits: 2, zero: true,
          series: [{ label: "Carico", color: "var(--s1)", values: range.map((i) => tr.n[i]) }] })),
      el("div", {},
        el("p", { class: "chart-title" }, "Velocità totale (km/h)"),
        lineChart({ x, unit: "km/h", xUnit: "s", height: 240, marks,
          series: [{ label: "V totale", color: "var(--s1)", values: range.map((i) => tr.vt[i] * KMH) }] })),
      el("div", {},
        el("p", { class: "chart-title" }, "Drag polar · da V max all'apice · rette a L/D costante"),
        polarChart([polarTrace(r, f, "", "var(--s1)", true)])),
      el("div", {},
        el("p", { class: "chart-title" }, "Profilo laterale (m) · 0 = punto in cui diventi orizzontale"),
        xyChart({ traces: [{ label: "", color: "var(--s1)", x: range.map((i) => tr.dist[i] - tr.dist[f.lv]),
          y: range.map((i) => tr.alt[i] - tr.alt[f.bot]), t: x }],
          xName: "distanza", yName: "quota sopra il punto più basso", xUnit: "m", yUnit: "m", minH: 220, maxH: 300 }))),
    el("details", {},
      el("summary", {}, "Carico per inclinazione e dati completi"),
      el("div", { class: "block" },
        table(["", ...f.byAngle.map((b) => b.label)], [["carico (g)", ...f.byAngle.map((b) => nf(b.value, 1))]])),
      el("div", { class: "block" },
        table(["t (s)", "dive angle (°)", "V tot (km/h)", "V orizz.", "V vert.", "carico (g)", "quota (m)"],
          range.filter((_, k) => k % 2 === 0).map((i) => [nf(tr.t[i] - f.tLevel, 1), nf(-tr.gam[i]), nf(tr.vt[i] * KMH),
            nf(tr.vh[i] * KMH), nf(tr.vd[i] * KMH), nf(tr.n[i], 2), nf(tr.alt[i] - r.ground)])))));
}

// traccia della drag polar (CD in x, CL in y); con marks segna i momenti chiave del flare
function polarTrace(r, f, label, color, marks = false) {
  const tr = r.tr;
  const ix = polarRange(tr, f);
  const c = ix.map((i) => coeffs(tr, i, r.suit));
  const out = { label, color, x: c.map((v) => v.cd), y: c.map((v) => v.cl), t: ix.map((i) => tr.t[i] - f.tLevel),
    extra: ix.map((i) => `L/D ${nf(tr.aL[i] / tr.aD[i], 2)} · ${nf(tr.vt[i] * KMH)} km/h`) };
  if (marks) {
    out.marks = [["V max", f.ipk], ["orizz.", f.lv], ["picco g", f.pk], ["apice", f.top]]
      .map(([lbl, i]) => ({ label: lbl, i: ix.length ? nearest(ix, i) : -1 }))
      .filter((m, k, a) => m.i >= 0 && a.findIndex((o) => o.i === m.i) === k);
  }
  return out;
}

function polarChart(traces, extra = {}) {
  const max = Math.max(0, ...traces.flatMap((t) => t.y.map((y, i) => y / t.x[i]).filter(Number.isFinite)));
  const rays = max < 1.5 ? [0.5, 1] : [];
  for (let v = 1; v <= Math.ceil(max) && max >= 1.5; v++) rays.push(v);
  return xyChart({ traces, xName: "CD", yName: "CL", xUnit: "", yUnit: "", digits: 2, xDigits: 2,
    origin: true, rays, rayLabel: "L/D", minH: 240, maxH: 320, ...extra });
}

// confronto: sovrapposizione dei flare scelti
function overlay(all) {
  const chosen = all.map((_, i) => (i < FLARE_COLORS.length ? i : null));
  const charts = el("div", { class: "flare-grid" });
  const boxes = el("div", { class: "picks" });
  function update() {
    const used = chosen.filter((c) => c != null).length;
    boxes.querySelectorAll("input").forEach((cb, i) => { cb.disabled = chosen[i] == null && used >= FLARE_COLORS.length; });
    const sel = all.flatMap((a, i) => (chosen[i] == null ? [] : [{ ...a, color: FLARE_COLORS[chosen[i]] }]));
    if (!sel.length) { charts.replaceChildren(el("p", { class: "hint" }, "Nessun flare selezionato.")); return; }
    const traceAng = sel.map(({ r, f, label, color }) => {
      const tr = r.tr; const ix = []; for (let i = f.ipk; i <= f.kmc; i++) ix.push(i);
      return { label, color, x: ix.map((i) => tr.gam[i]), y: ix.map((i) => wingLoad(tr, i)), t: ix.map((i) => tr.t[i] - f.tLevel) };
    });
    const traceDive = sel.map(({ r, f, label, color }) => {
      const tr = r.tr; const ix = [];
      for (let i = Math.max(r.lo, idx(tr, f.tLevel - 7)); i <= Math.min(r.hi, idx(tr, f.tLevel + 5)); i++) ix.push(i);
      return { label, color, x: ix.map((i) => tr.t[i] - f.tLevel), y: ix.map((i) => -tr.gam[i]), t: ix.map((i) => tr.t[i] - f.tLevel) };
    });
    charts.replaceChildren(
      el("div", { class: "wide" }, el("p", { class: "chart-title" }, "Drag polar · da V max all'apice · rette a L/D costante"),
        polarChart(sel.map(({ r, f, label, color }) => polarTrace(r, f, label, color)), { legend: false, maxH: 380 })),
      el("div", {}, el("p", { class: "chart-title" }, "Quanto lavora l'ala: carico riportato a 250 km/h (g) · ← picchiata · salita →"),
        xyChart({ traces: traceAng, xName: "angolo traiettoria", yName: "carico a 250 km/h", xUnit: "°", yUnit: "g", minH: 240, maxH: 320, digits: 1, legend: false })),
      el("div", {}, el("p", { class: "chart-title" }, "Dive angle (°) · 0 s = orizzontale"),
        xyChart({ traces: traceDive, xName: "secondi", yName: "dive angle", xUnit: "s", yUnit: "°", minH: 240, maxH: 320, legend: false })));
  }
  all.forEach((a, i) => {
    const key = el("i", { class: "key" });
    const cb = el("input", { type: "checkbox" });
    cb.checked = chosen[i] != null;
    const paint = () => { key.style.background = chosen[i] == null ? "var(--axis)" : FLARE_COLORS[chosen[i]]; };
    paint();
    cb.addEventListener("change", () => {
      if (cb.checked) {
        const free = FLARE_COLORS.findIndex((_, c) => !chosen.includes(c));
        if (free < 0) { cb.checked = false; return; }
        chosen[i] = free;
      } else chosen[i] = null;
      paint(); update();
    });
    boxes.append(el("label", { class: "check small" }, cb, key, `${a.label} (${signed(a.f.gain)} m)`));
  });
  update();
  return el("div", { class: "block" },
    el("p", { class: "hint" }, `Scegli quali flare sovrapporre (al massimo ${FLARE_COLORS.length} insieme).`), boxes, charts);
}

function table(headers, rows, { best = null } = {}) {
  let bestRow = -1;
  if (best != null && rows.length > 1) {
    let bv = -Infinity;
    rows.forEach((row, i) => { const v = Number(String(row[best]).replace(",", ".")); if (v > bv) { bv = v; bestRow = i; } });
  }
  const head = el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, String(h))));
  const body = el("tbody");
  rows.forEach((row, i) => {
    const trow = el("tr", i === bestRow ? { class: "marked" } : {});
    row.forEach((v) => trow.append(el("td", {}, String(v))));
    body.append(trow);
  });
  return el("div", { class: "scroll" }, el("table", {}, el("thead", {}, head), body));
}

function csvButton(filename, headers, rows) {
  return el("button", { type: "button", class: "linkbtn", onclick: () => downloadCsv(filename, headers, rows) }, "Scarica CSV");
}
function downloadCsv(filename, headers, rows) {
  const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = [headers, ...rows].map((r) => r.map(esc).join(";")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- grafici

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const q = raw / mag;
  return (q < 1.5 ? 1 : q < 3 ? 2 : q < 7 ? 5 : 10) * mag;
}
function ticks(lo, hi, count) {
  const step = niceStep(hi - lo || 1, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return { step, values: out };
}
function nearest(xs, v) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m; else hi = m; }
  return v - xs[lo] <= xs[hi] - v ? lo : hi;
}
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "–");

function lineChart(opts) {
  const { x, series, unit, xUnit, height = 240, marks = [], bands = [], digits = 0, zero = false } = opts;
  const wrap = el("div", { class: "chart" });
  if (series.length > 1) {
    wrap.append(el("div", { class: "legend" }, ...series.map((sr) =>
      el("span", {}, el("i", { class: "key", style: `background:${sr.color}` }), sr.label))));
  }
  const svg = s("svg", { role: "img", tabindex: "0", "aria-label": `Grafico: ${series.map((sr) => sr.label).join(", ")} (${unit}) nel tempo` });
  const tip = el("div", { class: "tip", hidden: "" });
  wrap.append(svg, tip);
  let lastWidth = 0, state = null, current = null;

  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width || wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    svg.replaceChildren();
    const m = { l: 40, r: 12, t: marks.length ? 34 : bands.length ? 18 : 8, b: 24 };
    const w = width - m.l - m.r, h = height - m.t - m.b;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    const x0 = x[0], x1 = x[x.length - 1];
    let ymin = Infinity, ymax = -Infinity;
    for (const sr of series) for (const v of sr.values) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
    if (zero) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
    const pad = (ymax - ymin || 1) * 0.06;
    const yt = ticks(ymin - pad, ymax + pad, Math.max(3, Math.round(h / 45)));
    const y0 = Math.min(yt.values[0], ymin - pad), y1 = Math.max(yt.values[yt.values.length - 1], ymax + pad);
    const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * w;
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * h;

    for (const b of bands) {
      const bx0 = X(Math.max(x0, b.from)), bx1 = X(Math.min(x1, b.to));
      svg.append(s("rect", { class: "band", x: bx0, y: m.t, width: Math.max(2, bx1 - bx0), height: h }));
      svg.append(s("text", { class: "band-label", x: (bx0 + bx1) / 2, y: m.t - 5, "text-anchor": "middle" }, b.label));
    }
    for (const v of yt.values) {
      if (v < y0 || v > y1) continue;
      const yy = Y(v);
      svg.append(s("line", { class: v === 0 ? "baseline" : "gridline", x1: m.l, x2: m.l + w, y1: yy, y2: yy }));
      svg.append(s("text", { class: "tick", x: m.l - 6, y: yy + 4, "text-anchor": "end" }, fmt(v, yt.step < 1 ? (yt.step < 0.1 ? 2 : 1) : 0)));
    }
    svg.append(s("line", { class: "baseline", x1: m.l, x2: m.l + w, y1: m.t + h, y2: m.t + h }));
    const xt = ticks(x0, x1, Math.max(2, Math.round(w / 80)));
    for (const v of xt.values) {
      svg.append(s("text", { class: "tick", x: X(v), y: m.t + h + 16, "text-anchor": "middle" },
        `${fmt(v, xt.step < 1 ? 1 : 0)}${v === xt.values[xt.values.length - 1] ? " " + xUnit : ""}`));
    }
    [...marks].sort((p, q) => p.t - q.t).forEach((mk, i) => {
      if (mk.t < x0 || mk.t > x1) return;
      const xx = X(mk.t);
      svg.append(s("line", { class: "mark-line", x1: xx, x2: xx, y1: m.t - (i % 2 ? 4 : 18), y2: m.t + h }));
      const anchor = xx < m.l + 40 ? "start" : xx > m.l + w - 40 ? "end" : "middle";
      svg.append(s("text", { class: "mark-label", x: xx, y: m.t - (i % 2 ? 6 : 20), "text-anchor": anchor }, mk.label));
    });
    for (const sr of series) {
      let d = "";
      sr.values.forEach((v, i) => { d += `${i ? "L" : "M"}${X(x[i]).toFixed(1)},${Y(v).toFixed(1)}`; });
      svg.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    const cross = s("line", { class: "cross", y1: m.t, y2: m.t + h, visibility: "hidden" });
    const dots = series.map((sr) => s("circle", { r: 4, fill: sr.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
    svg.append(cross, ...dots);
    state = { X, Y, m, w, cross, dots };
  }
  function show(i) {
    if (!state) return;
    const { X, Y, cross, dots, m, w } = state;
    const xx = X(x[i]);
    cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.setAttribute("visibility", "visible");
    series.forEach((sr, k) => { dots[k].setAttribute("cx", xx); dots[k].setAttribute("cy", Y(sr.values[i])); dots[k].setAttribute("visibility", "visible"); });
    tip.replaceChildren(el("div", { class: "tip-head" }, `${fmt(x[i], 1)} ${xUnit}`),
      ...series.map((sr) => el("div", { class: "tip-row" }, el("i", { class: "key", style: `background:${sr.color}` }),
        el("b", {}, `${fmt(sr.values[i], digits)} ${unit}`), el("span", {}, sr.label))));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, xx + 12 + tw > m.l + w ? xx - 12 - tw : xx + 12)}px`;
    tip.style.top = `${svg.offsetTop + m.t}px`;
    current = i;
  }
  function hide() {
    if (!state) return;
    state.cross.setAttribute("visibility", "hidden");
    state.dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tip.hidden = true;
  }
  svg.addEventListener("pointermove", (e) => {
    if (!state) return;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (lastWidth / rect.width);
    const { m, w } = state;
    if (px < m.l - 8 || px > m.l + w + 8) return hide();
    show(nearest(x, x[0] + ((px - m.l) / w) * (x[x.length - 1] - x[0])));
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowRight" ? 1 : -1);
    show(Math.min(x.length - 1, Math.max(0, current == null ? 0 : current + step)));
  });
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

function xyChart(opts) {
  const { traces, xName, yName, xUnit, yUnit, minH = 200, maxH = 320, legend = true, digits = 0, xDigits = 0,
    origin = false, rays = [], rayLabel = "" } = opts;
  const unitOf = (u) => (u ? ` (${u})` : "");
  const wrap = el("div", { class: "chart" });
  if (traces.length > 1 && legend) {
    wrap.append(el("div", { class: "legend" }, ...traces.map((tr) =>
      el("span", {}, el("i", { class: tr.dash ? "key dash" : "key", style: tr.dash ? `--c:${tr.color}` : `background:${tr.color}` }), tr.label))));
  }
  const svg = s("svg", { role: "img", tabindex: "0", "aria-label": `Grafico: ${yName} in funzione di ${xName}` });
  const tip = el("div", { class: "tip", hidden: "" });
  wrap.append(svg, tip);
  let lastWidth = 0, state = null;

  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width || wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    svg.replaceChildren();
    const m = { l: 44, r: 14, t: 12, b: 40 };
    const w = width - m.l - m.r;
    const h = Math.max(minH, Math.min(maxH, w * 0.62)) - m.t - m.b;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const tr of traces) {
      for (const v of tr.x) { if (v < xmin) xmin = v; if (v > xmax) xmax = v; }
      for (const v of tr.y) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
    }
    ymin = Math.min(ymin, 0);
    if (origin) xmin = Math.min(xmin, 0);
    const px = (xmax - xmin || 1) * 0.04, py = (ymax - ymin || 1) * 0.08;
    const x0 = origin ? xmin : xmin - px, x1 = xmax + px, y0 = ymin - (ymin < 0 ? py : 0), y1 = ymax + py;
    const height = Math.round(h + m.t + m.b);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * w;
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * h;
    const yt = ticks(y0, y1, Math.max(3, Math.round(h / 45)));
    for (const v of yt.values) {
      if (v < y0 || v > y1) continue;
      svg.append(s("line", { class: v === 0 ? "baseline" : "gridline", x1: m.l, x2: m.l + w, y1: Y(v), y2: Y(v) }));
      svg.append(s("text", { class: "tick", x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, fmt(v, yt.step < 1 ? 1 : 0)));
    }
    const xt = ticks(x0, x1, Math.max(2, Math.round(w / 80)));
    for (const v of xt.values) {
      if (v < x0 || v > x1) continue;
      svg.append(s("line", { class: v === 0 ? "baseline" : "gridline", x1: X(v), x2: X(v), y1: m.t, y2: m.t + h }));
      svg.append(s("text", { class: "tick", x: X(v), y: m.t + h + 16, "text-anchor": "middle" },
        fmt(v, Math.max(xDigits && xt.step < 0.1 ? xDigits : 0, xt.step < 1 ? 1 : 0))));
    }
    // rette dall'origine a rapporto y/x costante (L/D nella drag polar)
    for (const rr of rays) {
      let ex = x1, ey = x1 * rr;
      if (ey > y1) { ey = y1; ex = y1 / rr; }
      if (ex <= 0 || ey <= 0) continue;
      svg.append(s("line", { class: "ray", x1: X(0), y1: Y(0), x2: X(ex), y2: Y(ey) }));
      const top = ey >= y1 - 1e-9;
      svg.append(s("text", { class: "ray-label", x: X(ex) + (top ? 4 : -4), y: Y(ey) + (top ? 10 : -4),
        "text-anchor": top ? "start" : "end" }, `${rayLabel} ${fmt(rr, rr % 1 ? 1 : 0)}`));
    }
    const pts = [];
    traces.forEach((tr, k) => {
      let d = "";
      tr.x.forEach((v, i) => {
        const sx = X(v), sy = Y(tr.y[i]);
        d += `${i ? "L" : "M"}${sx.toFixed(1)},${sy.toFixed(1)}`;
        if (!tr.dash) pts.push({ k, i, sx, sy });
      });
      svg.append(s("path", { d, fill: "none", stroke: tr.color, "stroke-width": tr.dash ? 1.5 : 2,
        "stroke-dasharray": tr.dash ? "5 4" : "none", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });
    // eventi: pallino + etichetta, spostata se si sovrappone a un'altra
    const placed = [];
    for (const tr of traces) {
      for (const mk of tr.marks || []) {
        const cx = X(tr.x[mk.i]), cy = Y(tr.y[mk.i]);
        svg.append(s("circle", { cx, cy, r: 4, fill: tr.color, stroke: "var(--surface)", "stroke-width": 2 }));
        const right = cx < m.l + w - 80;
        const lw = mk.label.length * 6.2;
        const bx = right ? cx + 8 : cx - 8 - lw;
        const dy = [0, -14, 14, -28, 28].find((d) => !placed.some((p) =>
          bx < p.x + p.w && p.x < bx + lw && Math.abs(cy + d - p.y) < 13)) ?? 0;
        placed.push({ x: bx, y: cy + dy, w: lw });
        svg.append(s("text", { class: "mark-label", x: cx + (right ? 8 : -8), y: cy + dy + 4,
          "text-anchor": right ? "start" : "end" }, mk.label));
      }
    }
    svg.append(s("text", { class: "tick", x: m.l + w, y: m.t + h + 32, "text-anchor": "end" }, `${xName}${unitOf(xUnit)}`));
    svg.append(s("text", { class: "tick", x: m.l + 6, y: m.t + 12 }, `${yName}${unitOf(yUnit)}`));
    const dot = s("circle", { r: 4, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
    svg.append(dot);
    state = { pts, dot };
  }
  function show(p) {
    const tr = traces[p.k];
    state.dot.setAttribute("cx", p.sx); state.dot.setAttribute("cy", p.sy);
    state.dot.setAttribute("fill", tr.color); state.dot.setAttribute("visibility", "visible");
    tip.replaceChildren(
      el("div", { class: "tip-head" }, `${tr.label ? tr.label + " · " : ""}${fmt(tr.t[p.i], 1)} s`),
      el("div", { class: "tip-row" }, el("b", {}, `${fmt(tr.x[p.i], xDigits)} ${xUnit}`), el("span", {}, xName)),
      el("div", { class: "tip-row" }, el("b", {}, `${fmt(tr.y[p.i], digits)} ${yUnit}`), el("span", {}, yName)),
      tr.extra ? el("div", { class: "tip-row" }, el("span", {}, tr.extra[p.i])) : null);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, p.sx + 12 + tw > lastWidth ? p.sx - 12 - tw : p.sx + 12)}px`;
    tip.style.top = `${svg.offsetTop + Math.max(0, p.sy - 30)}px`;
  }
  function hide() { if (state) { state.dot.setAttribute("visibility", "hidden"); tip.hidden = true; } }
  svg.addEventListener("pointermove", (e) => {
    if (!state) return;
    const rect = svg.getBoundingClientRect();
    const sc = lastWidth / rect.width;
    const qx = (e.clientX - rect.left) * sc, qy = (e.clientY - rect.top) * sc;
    let best = null, bd = 30 * 30;
    for (const p of state.pts) { const d = (p.sx - qx) ** 2 + (p.sy - qy) ** 2; if (d < bd) { bd = d; best = p; } }
    if (best) show(best); else hide();
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

// ---------------------------------------------------------------- input

function init() {
  const drop = $("#drop");
  const input = $("#files");
  const pick = (list) => run([...list].filter((f) => /\.csv$/i.test(f.name)));
  input.addEventListener("change", () => { pick(input.files); input.value = ""; });
  for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "drop" || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove("over");
    });
  }
  document.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files; if (f && f.length) pick(f); });
  $("#rerun").addEventListener("click", () => run(lastFiles));
  try {
    const suit = JSON.parse(localStorage.getItem("flare-suit") || "null");
    if (suit) { $("#mass").value = suit.mass ?? ""; $("#area").value = suit.area ?? ""; }
  } catch { /* storage non disponibile */ }
}
init();
}
