"use strict";
/* Analisi Flare: trova i flare in un file FlySight e li misura.
   Tutto gira nel browser, i file non lasciano il computer.

   Metodo (quello usato nelle analisi dei flare con la CR+):
   - angolo di traiettoria γ = atan2(-velD, vel orizzontale), positivo in salita;
     "dive angle" = -γ, positivo in picchiata (come FlySight Viewer);
   - carico n = V·dγ/dt / g + cos γ (pressione sulle ali nel piano verticale);
   - orizzontale = primo istante in cui la velocità verticale passa da discesa a salita;
   - guadagno = quota all'apice − quota del punto più basso;
   - guadagno ideale = (V orizzontale² − V apice²) / 2g, efficienza = guadagno / ideale;
   - L/D: accelerazione aerodinamica = dv/dt − g, divisa in resistenza (opposta alla velocità)
     e portanza (perpendicolare); L/D = portanza / resistenza. */

const G = 9.80665;
const KMH = 3.6;

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

  // accelerazioni aerodinamiche per l'L/D: derivate su ~0,8 s per contenere il rumore del GPS
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

// punti di un flare su cui misurare l'L/D: da V max all'apice, solo dove la resistenza è misurabile
function polarRange(tr, f) {
  const out = [];
  for (let i = f.ipk; i <= f.top; i++) if (tr.vt[i] > 20 && tr.aD[i] > 0.3) out.push(i);
  return out;
}

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
  const flares = findFlares(tr, lo, hi).map((lv) => measure(tr, lv, lo, hi, ground)).filter(Boolean);
  return { tr, lo, hi, ground, groundAuto, flares };
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

function measure(tr, lv, lo, hi, ground) {
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
  const t45 = crossBack(45), t25 = crossBack(25);
  const pk = argmax(tr.n, ipk, top);

  // picchiata prima del flare: tratto continuo oltre 15° che finisce alla V max
  let ds = ipk;
  while (ds > lo && da(ds - 1) > 15) ds--;
  let angSum = 0;
  for (let i = ds; i <= ipk; i++) angSum += da(i);
  const diveDur = tr.t[ipk] - tr.t[ds];
  // V max "già stabile" se negli ultimi 3 s la velocità è salita di meno di 5 km/h
  const vRise = (tr.vt[ipk] - at(tr, tr.vt, tr.t[ipk] - 3)) * KMH;

  const loadAt = (sec) => (sec == null ? null : at(tr, tr.n, sec));

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
    climb: tr.gam[kmc], climbDt: tr.t[kmc] - tl,
    vApex: vr * KMH, apexDt: tr.t[top] - tl,
    gain,
    eloss: tr.E[ipk] - tr.E[lv],
    diveDur: diveDur >= 1 ? diveDur : null,
    diveAng: diveDur >= 1 ? angSum / (ipk - ds + 1) : null,
    diveLoss: diveDur >= 1 ? tr.alt[ds] - tr.alt[ipk] : null,
    vStable: vRise < 5,
    rot1: t45 != null && t25 != null ? 20 / (t25 - t45) : null,
    rot2: t25 != null ? 25 / (tl - t25) : null,
    t45: t45 != null ? tl - t45 : null,
    ideal, drag: ideal - gain, eff: ideal > 5 ? (gain / ideal) * 100 : null,
    ldMax: ldMax(tr, { ipk, top }),
  };
  return f;
}

// L/D massimo lungo il flare
function ldMax(tr, f) {
  let best = null;
  for (const i of polarRange(tr, f)) best = Math.max(best ?? -Infinity, tr.aL[i] / tr.aD[i]);
  return best;
}

if (typeof module !== "undefined") module.exports = { parseTrack, analyzeTrack, buildTrack };

// ===================================================================== interfaccia

if (typeof document !== "undefined") {

const $ = (sel) => document.querySelector(sel);
// un colore per file nel confronto (ordine fisso, al massimo 8)
const FILE_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
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
  const opts = { da: readNumber("#da"), a: readNumber("#a"), ground: readNumber("#ground") };
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
function shortName(name) {
  const m = stem(name).match(/^(\d\d)-(\d\d)-(\d\d)_.*_(\d\d)-(\d\d)$/);
  return m ? `${+m[3]}/${+m[2]} ${m[4]}:${m[5]}` : stem(name);
}

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

const SUMMARY_HEADERS = ["flare", "quota orizz. (m)", "picchiata (°)", "V max", "V orizz.",
  "rot. 45→25 (°/s)", "45°→orizz. (s)", "picco g", "picco a (° giù)", "g +1 s", "salita max (°)", "V apice",
  "guadagno (m)", "ideale (m)", "efficienza (%)", "L/D max"];

function summaryRow(label, f) {
  return [label, nf(f.altLevel), nf(f.dive), nf(f.vmax), nf(f.vLevel), nf(f.rot1, 1), nf(f.t45, 1),
    nf(f.peak, 2), nf(Math.max(0, f.peakAngle)), nf(f.n1, 2), nf(f.climb), nf(f.vApex), signed(f.gain, 1),
    nf(f.ideal), nf(f.eff), nf(f.ldMax, 2)];
}

// riepilogo: le misure divise per fase, una colonna per flare.
// best: "max" o "min" dice in che verso il valore è migliore (per i colori e il grassetto)
const PHASES = [
  { name: "Picchiata", cls: "ph-dive", rows: [
    { label: "Picchiata prima del flare",
      text: (f) => (f.diveDur == null ? "–" : `${nf(f.diveDur)} s a circa ${nf(Math.round(f.diveAng / 5) * 5)}°, ${nf(Math.round(f.diveLoss / 10) * 10)} m`) },
    { label: "V max", text: (f) => `${nf(f.vmax)} km/h, ${f.vStable ? "già stabile" : "ancora in aumento"}`,
      value: (f) => f.vmax, best: "max" },
  ] },
  { name: "Richiamata", cls: "ph-pull", rows: [
    { label: "Rotazione 45°→25°", text: (f) => (f.rot1 == null ? "–" : `${nf(f.rot1, 1)} °/s`), value: (f) => f.rot1, best: "min" },
    { label: "Da 45° all'orizzontale", text: (f) => (f.t45 == null ? "–" : `${nf(f.t45, 1)} s`), value: (f) => f.t45, best: "max" },
    { label: "V in orizzontale", text: (f) => `${nf(f.vLevel)} km/h`, value: (f) => f.vLevel, best: "max" },
    { label: "Picco di carico",
      text: (f) => `${nf(f.peak, 1)} g ${Math.abs(f.peakAngle) < 1 ? "esattamente all'orizzonte"
        : f.peakAngle > 0 ? `a ${nf(f.peakAngle)}° di picchiata` : `a ${nf(-f.peakAngle)}° di salita`}` },
  ] },
  { name: "Salita", cls: "ph-climb", rows: [
    { label: "Carico 1 s dopo l'orizzontale", text: (f) => (f.n1 == null ? "–" : `${nf(f.n1, 1)} g`), value: (f) => f.n1, best: "max" },
    { label: "Salita max", text: (f) => `${nf(f.climb)}°`, value: (f) => f.climb, best: "max" },
    { label: "V apice", text: (f) => `${nf(f.vApex)} km/h` },
    { label: "Guadagno", text: (f) => `${signed(f.gain)} m`, value: (f) => f.gain, best: "max", key: true },
    { label: "Efficienza della salita", text: (f) => (f.eff == null ? "–" : `${nf(f.eff)}%`), value: (f) => f.eff, best: "max" },
    { label: "L/D massimo", text: (f) => nf(f.ldMax, 2), value: (f) => f.ldMax, best: "max" },
  ] },
];

// posizione di v tra il peggiore (0) e il migliore (1) della riga
function scores(vals, best) {
  const ok = vals.filter((v) => v != null && Number.isFinite(v));
  if (ok.length < 2) return vals.map(() => null);
  const lo = Math.min(...ok), hi = Math.max(...ok);
  if (hi - lo < 1e-9) return vals.map(() => null);
  return vals.map((v) => (v == null || !Number.isFinite(v) ? null : best === "max" ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo)));
}

// sfondo della cella: verde verso il migliore, arancio verso il peggiore, neutro a metà
function tint(score) {
  if (score == null) return null;
  const d = score - 0.5;
  if (Math.abs(d) < 0.08) return null;
  const pct = Math.round(Math.abs(d) * 2 * 30);
  return `color-mix(in srgb, var(${d > 0 ? "--good" : "--bad"}) ${pct}%, transparent)`;
}

function summaryTable(items) {
  const n = items.length;
  const head = el("tr", {}, el("th", { scope: "col", class: "corner" }, ""), ...items.map((a) => el("th", { scope: "col" },
    el("span", { class: "col-head" },
      a.color ? el("i", { class: "dot", style: `background:${a.color}` }) : null,
      el("span", { class: "col-name" }, a.name),
      a.sub ? el("span", { class: "col-sub" }, a.sub) : null))));
  if (items.some((a) => a.color)) {
    head.querySelectorAll("th[scope=col]:not(.corner)").forEach((th, k) => th.style.setProperty("--col", items[k].color));
  }
  const body = el("tbody");
  for (const ph of PHASES) {
    body.append(el("tr", { class: `phase ${ph.cls}` }, el("th", { scope: "rowgroup", colspan: n + 1 }, ph.name)));
    for (const row of ph.rows) {
      const sc = row.best && n > 1 ? scores(items.map((a) => row.value(a.f)), row.best) : items.map(() => null);
      body.append(el("tr", { class: `${ph.cls}${row.key ? " key-row" : ""}` }, el("th", { scope: "row" }, row.label),
        ...items.map((a, k) => {
          const bg = tint(sc[k]);
          return el("td", { class: sc[k] === 1 ? "best" : "", ...(bg ? { style: `background:${bg}` } : {}) }, row.text(a.f));
        })));
    }
  }
  return el("div", { class: "scroll" }, el("table", { class: "summary" }, el("thead", {}, head), body));
}

function legend() {
  return el("p", { class: "legend summary-legend" },
    el("span", {}, el("i", { class: "swatch good" }), "migliore della riga"),
    el("span", {}, el("i", { class: "swatch bad" }), "peggiore della riga"),
    el("span", { class: "muted" }, "in grassetto il migliore"));
}

// ---------------------------------------------------------------- render

function render(results) {
  const root = $("#results");
  root.replaceChildren();
  // confronto solo con più file: con un file basta il suo riepilogo
  if (results.length > 1) {
    const all = results.flatMap((r, fi) => (r.flares || []).map((f, i) => ({
      f, label: `${shortName(r.name)} · F${i + 1}`, name: shortName(r.name), sub: `F${i + 1}`,
      color: fi < FILE_COLORS.length ? FILE_COLORS[fi] : null,
    })));
    if (all.length > 1) {
      const rows = all.map((a) => summaryRow(a.label, a.f));
      root.append(el("section", { class: "card" },
        el("div", { class: "card-head" },
          el("h2", {}, "Confronto tra i flare"),
          csvButton("confronto_flare.csv", SUMMARY_HEADERS, rows)),
        legend(),
        summaryTable(all)));
    }
  }
  for (const r of results) root.append(fileCard(r));
}

function fileCard(r) {
  const short = shortName(r.name);
  const card = el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, short),
    short !== stem(r.name) ? el("span", { class: "hint" }, r.name) : null));
  if (r.error) { card.append(el("p", { class: "err" }, r.error)); return card; }
  const tr = r.tr;
  const groundText = r.groundAuto != null ? `suolo a ${nf(r.ground)} m s.l.m.`
    : (r.ground ? `suolo a ${nf(r.ground)} m (inserito a mano)` : "suolo non trovato: quote sul livello del mare");
  card.append(el("p", { class: "meta" },
    `${nf(tr.hz)} Hz · volo da ${nf(tr.t[r.lo])} a ${nf(tr.t[r.hi])} s · ${groundText}` +
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
    r.flares.length > 1 ? legend() : null,
    summaryTable(r.flares.map((f, i) => ({ f, name: `Flare ${i + 1}`,
      sub: `orizzontale a ${nf(f.altLevel)} m` })))));
  return card;
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
}
init();
}
