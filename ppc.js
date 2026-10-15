"use strict";

// Gare PPC: Time / Distance / Speed nella finestra 2500 → 1500 m,
// con lo stesso metodo della modalità PPC di FlySight Viewer.

const G = 9.80665;
const KMH = 3.6;
const LANE_WIDTH = 600;
const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600];
const MODES = {
  time: { label: "Time", unit: "s" },
  distance: { label: "Distance", unit: "km" },
  speed: { label: "Speed", unit: "km/h" },
};
const SPEEDS = [
  { key: "vt", label: "V totale", color: "var(--s1)" },
  { key: "vh", label: "V orizzontale", color: "var(--s2)" },
  { key: "vd", label: "V verticale", color: "var(--s3)" },
];

const $ = (sel) => document.querySelector(sel);

// --------------------------------------------------------------- settings

const DEFAULTS = {
  mode: "time", top: 2500, bottom: 1500,
  laneOn: false, laneLat: 44.6979994, laneLon: 10.6719158,
  view: "exit", model: "gfs_seamless", air: false,
};
const settings = loadSettings();
let jumps = [];
let current = null;

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ppc-settings") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem("ppc-settings", JSON.stringify(settings)); } catch { /* niente */ }
}

// ---------------------------------------------------------------- lettura

function parseTime(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d+)?/.exec(String(text).trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 + (m[7] ? parseFloat(m[7]) : 0);
}

function parseTrack(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const pts = [];
  const num = (v) => (v === undefined || v === "" ? NaN : Number(v));
  const push = (r) => {
    const p = {
      t: parseTime(r.time || ""), lat: num(r.lat), lon: num(r.lon), h: num(r.hMSL),
      vn: num(r.velN), ve: num(r.velE), vd: num(r.velD),
      ha: num(r.hAcc), va: num(r.vAcc),
    };
    if ([p.t, p.lat, p.lon, p.h, p.vn, p.ve, p.vd].every(Number.isFinite)) pts.push(p);
  };

  let format;
  if (lines.slice(0, 200).some((l) => l.startsWith("$GNSS"))) {            // FlySight 2
    format = "FlySight 2";
    let cols = null;
    for (const ln of lines) {
      const a = ln.split(",");
      if (a[0] === "$COL" && a[1] === "GNSS") cols = a.slice(2);
      else if (a[0] === "$GNSS" && cols) push(Object.fromEntries(cols.map((c, i) => [c, a[i + 1]])));
    }
  } else {                                                                  // FlySight 1
    format = "FlySight 1";
    let cols = null;
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const a = ln.split(",").map((x) => x.trim());
      if (!cols) {
        if (a.includes("time") && a.includes("hMSL")) cols = a;
        continue;
      }
      push(Object.fromEntries(cols.map((c, i) => [c, a[i]])));
    }
  }

  // tieni solo i punti in ordine di tempo
  const out = [];
  for (const p of pts) if (!out.length || p.t > out[out.length - 1].t) out.push(p);
  if (out.length < 30) throw new Error("Non trovo dati GPS validi: serve un CSV di FlySight 1 o FlySight 2.");
  return { pts: out, format };
}

// ---------------------------------------------------------------- calcoli

function lerpPoint(p1, p2, a) {
  const out = {};
  for (const k in p1) out[k] = typeof p1[k] === "number" ? p1[k] + a * (p2[k] - p1[k]) : p1[k];
  return out;
}

// regressione lineare su ±4 punti, come getSlope di FlySight Viewer
function slope(pts, center, key) {
  const lo = Math.max(0, center - 4), hi = Math.min(pts.length - 1, center + 4);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const t0 = pts[center].t;
  for (let i = lo; i <= hi; i++) {
    const x = pts[i].t - t0, y = pts[i][key];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = hi - lo + 1;
  return (sxy - (sx * sy) / n) / (sxx - (sx * sx) / n);
}

// raggi di curvatura WGS84 per il piano locale
function radii(latDeg) {
  const a = 6378137, e2 = 6.69437999014e-3;
  const s = Math.sin((latDeg * Math.PI) / 180);
  const w = Math.sqrt(1 - e2 * s * s);
  return { M: (a * (1 - e2)) / (w * w * w), N: a / w };
}

// distanza e azimut sull'ellissoide WGS84 (Vincenty, inversa)
function geodesic(lat1, lon1, lat2, lon2) {
  const a = 6378137, f = 1 / 298.257223563, b = (1 - f) * a;
  const rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * rad)), U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = L, sl, cl, ss, cs, sig, c2a, c2m;
  for (let k = 0; k < 200; k++) {
    sl = Math.sin(lam); cl = Math.cos(lam);
    ss = Math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl);
    if (ss === 0) return { s: 0, azi: 0 };
    cs = sU1 * sU2 + cU1 * cU2 * cl;
    sig = Math.atan2(ss, cs);
    const sa = (cU1 * cU2 * sl) / ss;
    c2a = 1 - sa * sa;
    c2m = c2a ? cs - (2 * sU1 * sU2) / c2a : 0;
    const C = (f / 16) * c2a * (4 + f * (4 - 3 * c2a));
    const prev = lam;
    lam = L + (1 - C) * f * sa * (sig + C * ss * (c2m + C * cs * (-1 + 2 * c2m * c2m)));
    if (Math.abs(lam - prev) < 1e-12) break;
  }
  const u2 = (c2a * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const ds = B * ss * (c2m + (B / 4) * (cs * (-1 + 2 * c2m * c2m) - (B / 6) * c2m * (-3 + 4 * ss * ss) * (-3 + 4 * c2m * c2m)));
  const azi = Math.atan2(cU2 * Math.sin(lam), cU1 * sU2 - sU1 * cU2 * Math.cos(lam)) / rad;
  return { s: b * A * (sig - ds), azi: (azi + 360) % 360 };
}

function interpAt(pts, key, value) {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][key] >= value) {
      const p1 = pts[i - 1], p2 = pts[i];
      return lerpPoint(p1, p2, (value - p1[key]) / (p2[key] - p1[key] || 1));
    }
  }
  return pts[pts.length - 1];
}

function prepare(name, text) {
  const { pts, format } = parseTrack(text);

  // uscita: velocità verticale = g, riportata indietro di g / accelerazione verticale
  for (let i = 0; i < pts.length; i++) pts[i].az = slope(pts, i, "vd");
  let exitT = pts[0].t;
  for (let i = 1; i < pts.length; i++) {
    const p1 = pts[i - 1], p2 = pts[i];
    const a = (G - p1.vd) / (p2.vd - p1.vd);
    if (!(a >= 0 && a <= 1)) continue;
    const vAcc = p1.va + a * (p2.va - p1.va);
    if (vAcc > 10) continue;
    const az = p1.az + a * (p2.az - p1.az);
    if (!(az >= G / 5)) continue;
    exitT = p1.t + a * (p2.t - p1.t) - G / az;
    break;
  }

  // piano locale e distanza percorsa
  const lat0 = pts[0].lat, lon0 = pts[0].lon;
  const R = radii(lat0), rad = Math.PI / 180;
  let d3 = 0;
  pts.forEach((p, i) => {
    p.tr = p.t - exitT;
    p.x = (p.lon - lon0) * rad * R.N * Math.cos(lat0 * rad);
    p.y = (p.lat - lat0) * rad * R.M;
    if (i) {
      const q = pts[i - 1];
      d3 += Math.hypot(p.x - q.x, p.y - q.y, p.h - q.h);
    }
    p.d3 = d3;
    const vh = Math.hypot(p.vn, p.ve);
    p.vh = vh * KMH;
    p.vdk = p.vd * KMH;
    p.vt = Math.hypot(vh, p.vd) * KMH;
    p.gr = p.vd > 0.5 ? vh / p.vd : NaN;
  });
  const ex = interpAt(pts, "tr", 0);
  for (const p of pts) { p.d3 -= ex.d3; p.x -= ex.x; p.y -= ex.y; }

  // inizio prestazione per la corsia: 10 m/s in verticale dopo l'uscita, + 9 s
  let perf = ex;
  for (let i = 1; i < pts.length; i++) {
    const p1 = pts[i - 1], p2 = pts[i];
    if (p1.tr > 0 && p1.vd < 10 && p2.vd >= 10) { perf = lerpPoint(p1, p2, (10 - p1.vd) / (p2.vd - p1.vd)); break; }
  }
  const laneStart = interpAt(pts, "tr", perf.tr + 9);

  // apertura: dopo l'uscita la velocità totale scende sotto 16 m/s per 2 s
  let deploy = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].tr < 10 || pts[i].vt / KMH >= 16) continue;
    let j = i;
    while (j < pts.length && pts[j].vt / KMH < 16) j++;
    if (j >= pts.length || pts[j - 1].t - pts[i].t >= 2) { deploy = i; break; }
  }

  return {
    name, format, pts, exitT, ex, laneStart, deploy,
    hz: Math.round((pts.length - 1) / (pts[pts.length - 1].t - pts[0].t)),
    landing: pts[pts.length - 1].h, ground: pts[pts.length - 1].h, groundAuto: true,
    windCache: {},
  };
}

// come PPCScoring::getWindowBounds
function windowBounds(pts, top, bottom) {
  let foundBottom = false, foundTop = false, bi = -1, ti = -1;
  for (let i = pts.length - 1; i >= 0; i--) {
    const z = pts[i].z;
    if (z < bottom) { bi = i; foundBottom = true; }
    if (z < top) { ti = i; foundTop = false; }
    if (z > top) foundTop = true;
    if (pts[i].tr < 0) break;
  }
  if (!foundBottom || !foundTop || bi < 1 || ti < 1) return null;
  const b1 = pts[bi - 1], b2 = pts[bi], t1 = pts[ti - 1], t2 = pts[ti];
  return {
    bottom: lerpPoint(b1, b2, (bottom - b1.z) / (b2.z - b1.z)),
    top: lerpPoint(t1, t2, (top - t1.z) / (t2.z - t1.z)),
    ti, bi,
  };
}

// come PPCScoring::getSEP
function maxSep(pts, top, bottom) {
  let sep = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    if (p.tr < 0) break;
    if (p.z < bottom - 20 || p.z > top + 20) continue;
    const v = 0.5127 * (2 * p.ha + p.va);
    if (Number.isFinite(v) && (sep === null || v > sep)) sep = v;
  }
  return sep;
}

function compute(j) {
  const { top, bottom } = settings;
  for (const p of j.pts) p.z = p.h - j.ground;
  j.exitZ = j.ex.h - j.ground;
  j.win = windowBounds(j.pts, top, bottom);
  j.sep = maxSep(j.pts, top, bottom);
  j.res = null;
  if (j.win) {
    const { top: T, bottom: B } = j.win;
    const time = B.tr - T.tr;
    const g = geodesic(T.lat, T.lon, B.lat, B.lon);
    j.res = { time, distance: g.s, speed: g.s / time, azi: g.azi };
  }
  computeAir(j);
  computeLane(j);
}

// --------------------------------------------------------------- vento

function windUrl(host, j, model) {
  const ref = j.win ? j.win.top : j.ex;
  const d0 = new Date(j.exitT * 1000);
  const d1 = new Date(j.exitT * 1000 + 86400000);
  const vars = LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]);
  const q = new URLSearchParams({
    latitude: ref.lat.toFixed(2), longitude: ref.lon.toFixed(2),
    start_date: d0.toISOString().slice(0, 10), end_date: d1.toISOString().slice(0, 10),
    hourly: vars.join(","), wind_speed_unit: "ms", timezone: "GMT", models: model,
  });
  return `https://${host}/v1/forecast?${q}`;
}

// profilo del vento all'ora del salto: [{p, gph, e, n}] dal basso verso l'alto
function profileAt(data, tAbs) {
  const h = data.hourly;
  const times = h.time.map((s) => Date.parse(s + "Z") / 1000);
  let i = times.findIndex((t, k) => t <= tAbs && (k === times.length - 1 || times[k + 1] > tAbs));
  if (i < 0) return null;
  const k2 = Math.min(i + 1, times.length - 1);
  const f = k2 === i ? 0 : (tAbs - times[i]) / (times[k2] - times[i]);
  const out = [];
  for (const p of LEVELS) {
    const at = (k) => {
      const s = h[`wind_speed_${p}hPa`]?.[k], d = h[`wind_direction_${p}hPa`]?.[k], z = h[`geopotential_height_${p}hPa`]?.[k];
      if (s == null || d == null || z == null) return null;
      const r = (d * Math.PI) / 180;
      return { z, e: -s * Math.sin(r), n: -s * Math.cos(r) };   // direzione verso cui soffia
    };
    const a = at(i), b = at(k2);
    if (!a || !b) continue;
    out.push({ p, gph: a.z + f * (b.z - a.z), e: a.e + f * (b.e - a.e), n: a.n + f * (b.n - a.n) });
  }
  out.sort((u, v) => u.gph - v.gph);
  return out.length >= 3 ? out : null;
}

function windAt(profile, hMSL) {
  if (hMSL <= profile[0].gph) return profile[0];
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].gph >= hMSL) {
      const a = profile[i - 1], b = profile[i], f = (hMSL - a.gph) / (b.gph - a.gph);
      return { e: a.e + f * (b.e - a.e), n: a.n + f * (b.n - a.n) };
    }
  }
  return profile[profile.length - 1];
}

async function loadWind(j) {
  const model = settings.model;
  if (j.windCache[model]) return j.windCache[model];
  const tAbs = j.exitT;
  let lastErr = null;
  for (const host of ["historical-forecast-api.open-meteo.com", "api.open-meteo.com"]) {
    try {
      const r = await fetch(windUrl(host, j, model));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const profile = profileAt(await r.json(), tAbs);
      if (profile) {
        j.windCache[model] = { profile, source: host };
        return j.windCache[model];
      }
      lastErr = new Error("dati non disponibili per quest'ora");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function computeAir(j) {
  j.air = null;
  const w = j.windCache[settings.model];
  if (!w) return;
  for (const p of j.pts) {
    const v = windAt(w.profile, p.h);
    p.we = v.e; p.wn = v.n;
    const ah = Math.hypot(p.ve - v.e, p.vn - v.n);
    p.avh = ah * KMH;
    p.avt = Math.hypot(ah, p.vd) * KMH;
    p.agr = p.vd > 0.5 ? ah / p.vd : NaN;
  }
  if (!j.res) return;

  // vento medio incontrato nella finestra (media nel tempo)
  const { top: T, bottom: B, ti, bi } = j.win;
  const seq = [T, ...j.pts.slice(ti, bi), B];
  let se = 0, sn = 0;
  for (let k = 1; k < seq.length; k++) {
    const dt = seq[k].tr - seq[k - 1].tr;
    const w1 = windAt(w.profile, seq[k - 1].h), w2 = windAt(w.profile, seq[k].h);
    se += ((w1.e + w2.e) / 2) * dt;
    sn += ((w1.n + w2.n) / 2) * dt;
  }
  const { time, distance, azi } = j.res;
  const me = se / time, mn = sn / time;
  const r = (azi * Math.PI) / 180;
  const ue = Math.sin(r), un = Math.cos(r);
  const ae = distance * ue - se, an = distance * un - sn;   // spostamento rispetto all'aria
  const airDist = Math.hypot(ae, an);
  j.air = {
    me, mn, ue, un,
    tail: me * ue + mn * un,
    cross: me * un - mn * ue,
    distance: airDist, speed: airDist / time,
  };
}

// ---------------------------------------------------------------- corsia

function toLocal(j, lat, lon) {
  const lat0 = j.pts[0].lat, lon0 = j.pts[0].lon, rad = Math.PI / 180;
  const R = radii(lat0);
  // stesso piano di prepare(), riportato all'uscita
  const x0 = (j.ex.lon - lon0) * rad * R.N * Math.cos(lat0 * rad);
  const y0 = (j.ex.lat - lat0) * rad * R.M;
  return { x: (lon - lon0) * rad * R.N * Math.cos(lat0 * rad) - x0, y: (lat - lat0) * rad * R.M - y0 };
}

function computeLane(j) {
  j.lane = null;
  if (!settings.laneOn || !Number.isFinite(settings.laneLat) || !Number.isFinite(settings.laneLon)) return;
  const S = { x: j.laneStart.x, y: j.laneStart.y };
  const E = toLocal(j, settings.laneLat, settings.laneLon);
  const len = Math.hypot(E.x - S.x, E.y - S.y);
  if (len < 1 || len > 50000) { j.lane = { S, E, bad: true }; return; }
  const ux = (E.x - S.x) / len, uy = (E.y - S.y) / len;
  let maxDev = 0;
  if (j.win) {
    const { top: T, bottom: B, ti, bi } = j.win;
    for (const p of [T, ...j.pts.slice(ti, bi), B]) {
      const d = (p.x - S.x) * uy - (p.y - S.y) * ux;   // > 0 = a destra della corsia
      if (Math.abs(d) > Math.abs(maxDev)) maxDev = d;
    }
  }
  j.lane = { S, E, ux, uy, len, maxDev };
}

// ----------------------------------------------------------------- render

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

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const CARD = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const cardinal = (deg) => CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const fromDir = (e, n) => ((Math.atan2(-e, -n) * 180) / Math.PI + 360) % 360;

function setStatus(text, isError = false) {
  const node = $("#status");
  node.textContent = text;
  node.classList.toggle("error", isError);
}

function formatMode(mode, r) {
  if (mode === "time") return r.time.toFixed(3);
  if (mode === "distance") return (r.distance / 1000).toFixed(3);
  return (r.speed * KMH).toFixed(2);
}

function renderAll() {
  const j = current;
  if (!j) return;
  compute(j);
  renderSettings();
  renderResults(j);
  renderChart(j);
  renderLane(j);
  renderWind(j);
}

function renderSettings() {
  $("#top").value = settings.top;
  $("#bottom").value = settings.bottom;
  $("#ground").value = current.ground.toFixed(1);
  $("#ground-auto").hidden = current.groundAuto;
  $("#lane-on").checked = settings.laneOn;
  $("#lane-lat").value = settings.laneLat;
  $("#lane-lon").value = settings.laneLon;
  $("#lane-lat").disabled = $("#lane-lon").disabled = !settings.laneOn;
  $("#view").value = settings.view;
  $("#model").value = settings.model;
  $("#air").checked = settings.air;
  for (const b of document.querySelectorAll(".seg button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode));
  }
}

function renderResults(j) {
  const root = $("#results");
  root.replaceChildren();
  const r = j.res;
  if (!r) {
    root.append(el("p", { class: "err" },
      j.exitZ < settings.top
        ? `L'uscita è a ${Math.round(j.exitZ)} m dal suolo, sotto il Top: la finestra non è completa.`
        : "Non trovo la finestra in questo salto: controlla Top, Bottom e quota del suolo."));
    return;
  }
  const mode = settings.mode;
  root.append(el("div", { class: "score" },
    el("span", { class: "score-label" }, `${MODES[mode].label} · risultato`),
    el("span", { class: "score-value" }, formatMode(mode, r), el("small", {}, ` ${MODES[mode].unit}`))));

  const rows = [
    ["time", "Time", r.time.toFixed(3), "s"],
    ["distance", "Distance", (r.distance / 1000).toFixed(3), "km"],
    ["speed", "Horizontal speed", (r.speed * KMH).toFixed(2), "km/h"],
    ["sep", "SEP", j.sep == null ? "n/d" : j.sep.toFixed(2), j.sep == null ? "" : "m"],
  ];
  root.append(el("dl", { class: "stats" }, ...rows.flatMap(([k, label, v, u]) => [
    el("dt", { class: k === mode ? "on" : "" }, label),
    el("dd", { class: k === mode ? "on" : "" }, v, el("small", {}, u ? ` ${u}` : "")),
  ])));

  const T = j.win.top;
  root.append(el("p", { class: "hint" },
    `Uscita a ${Math.round(j.exitZ)} m dal suolo · ingresso in finestra ${T.tr.toFixed(1)} s dopo l'uscita, ` +
    `a ${Math.round(T.d3)} m di distanza totale · direzione media ${Math.round(r.azi)}° (${cardinal(r.azi)})`));

  if (j.air) {
    const a = j.air;
    const tail = a.tail * KMH;
    root.append(el("div", { class: "air" },
      el("p", { class: "air-title" }, "Rispetto all'aria (senza vento)"),
      el("dl", { class: "stats small" },
        el("dt", {}, "Distance"), el("dd", {}, (a.distance / 1000).toFixed(3), el("small", {}, " km")),
        el("dt", {}, "Horizontal speed"), el("dd", {}, (a.speed * KMH).toFixed(2), el("small", {}, " km/h"))),
      el("p", { class: "hint" },
        `Vento medio nella finestra ${(Math.hypot(a.me, a.mn) * KMH).toFixed(0)} km/h da ${cardinal(fromDir(a.me, a.mn))}: ` +
        `${Math.abs(tail).toFixed(1)} km/h ${tail >= 0 ? "in coda" : "contro"}, ` +
        `${Math.abs(a.cross * KMH).toFixed(1)} km/h laterale. ` +
        `Il vento ti ha ${tail >= 0 ? "regalato" : "tolto"} circa ${Math.abs(r.distance - a.distance).toFixed(0)} m.`)));
  }
}

// ------------------------------------------------------------- grafico

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}
function ticks(lo, hi, count) {
  const step = niceStep(hi - lo || 1, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return { step, values: out };
}

function viewRange(j) {
  const pts = j.pts;
  const xEnd = pts[j.deploy].d3;
  if (!j.win || settings.view === "all") return [0, Math.max(xEnd, j.win ? j.win.bottom.d3 : 0)];
  const a = j.win.top.d3, b = j.win.bottom.d3;
  if (settings.view === "window") {
    const pad = (b - a) * 0.06;
    return [Math.max(0, a - pad), Math.min(pts[pts.length - 1].d3, b + pad)];
  }
  return [0, Math.min(pts[pts.length - 1].d3, b + b * 0.08)];
}

function renderChart(j) {
  const [x0, x1] = viewRange(j);
  const pts = j.pts.filter((p) => p.d3 >= x0 && p.d3 <= x1);
  const root = $("#chart");
  root.replaceChildren();
  $("#air-wrap").hidden = !j.air;
  if (pts.length < 2) return;
  const air = settings.air && j.air;

  const speedSeries = SPEEDS.map((sp) => ({ ...sp, values: pts.map((p) => (sp.key === "vd" ? p.vdk : p[sp.key])) }));
  if (air) {
    speedSeries.push({ key: "avt", label: "V totale (aria)", color: "var(--s1)", dash: true, values: pts.map((p) => p.avt) });
    speedSeries.push({ key: "avh", label: "V orizzontale (aria)", color: "var(--s2)", dash: true, values: pts.map((p) => p.avh) });
  }
  const glide = [{ key: "gr", label: "Efficienza", color: "var(--ink-2)", values: pts.map((p) => p.gr) }];
  if (air) glide.push({ key: "agr", label: "Efficienza (aria)", color: "var(--ink-2)", dash: true, values: pts.map((p) => p.agr) });

  const hl = [];
  if (j.win) hl.push({ y: settings.top, label: `Top ${settings.top}` }, { y: settings.bottom, label: `Bottom ${settings.bottom}` });

  root.append(stackedChart({
    x: pts.map((p) => p.d3), x0, x1,
    t: pts.map((p) => p.tr),
    band: j.win ? { from: j.win.top.d3, to: j.win.bottom.d3 } : null,
    panels: [
      { title: "Quota dal suolo (m)", unit: "m", height: 170, digits: 0, hlines: hl,
        series: [{ key: "z", label: "Quota", color: "var(--accent)", values: pts.map((p) => p.z) }] },
      { title: "Velocità (km/h)", unit: "km/h", height: 220, digits: 0, legend: true, series: speedSeries },
      { title: "Efficienza (m avanti per m di discesa)", unit: "", height: 150, digits: 2, cap: 6, floor: 0, series: glide },
    ],
  }));
}

function stackedChart({ x, t, x0, x1, band, panels }) {
  const wrap = el("div", { class: "chart" });
  const legendSeries = panels.flatMap((p) => (p.legend ? p.series : []));
  if (legendSeries.length) {
    wrap.append(el("div", { class: "legend" }, ...legendSeries.map((sr) =>
      el("span", {}, el("i", { class: sr.dash ? "key dash" : "key", style: `--c:${sr.color};background:${sr.dash ? "none" : sr.color}` }), sr.label))));
  }
  const total = panels.reduce((n, p) => n + p.height + 22, 0) + 22;
  const svg = s("svg", { role: "img", tabindex: "0",
    "aria-label": "Grafico di quota, velocità ed efficienza in funzione della distanza totale" });
  const tip = el("div", { class: "tip", hidden: "" });
  wrap.append(svg, tip);
  const uid = Math.random().toString(36).slice(2, 8);

  let lastWidth = 0, state = null, current = null;

  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width || wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${width} ${total}`);
    svg.setAttribute("height", total);
    const m = { l: 44, r: width >= 480 ? 72 : 12 };
    const w = width - m.l - m.r;
    const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * w;

    let top = 0;
    const laid = [];
    for (const [pi, p] of panels.entries()) {
      const pt = top + 18, ph = p.height;
      svg.append(s("text", { class: "panel-title", x: m.l, y: pt - 6 }, p.title));

      let lo = Infinity, hi = -Infinity;
      for (const sr of p.series) for (const v of sr.values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      for (const h of p.hlines || []) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
      if (p.cap != null) hi = Math.min(hi, p.cap);
      if (p.floor != null) lo = Math.max(Math.min(lo, hi), p.floor);
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo || 1) * 0.06;
      const yt = ticks(lo - pad, hi + pad, Math.max(3, Math.round(ph / 45)));
      const y0 = Math.min(yt.values[0], lo - pad), y1 = Math.max(yt.values[yt.values.length - 1], hi + pad);
      const Y = (v) => pt + (1 - (v - y0) / (y1 - y0 || 1)) * ph;

      if (band) {
        const bx0 = X(Math.max(x0, band.from)), bx1 = X(Math.min(x1, band.to));
        if (bx1 > bx0) svg.append(s("rect", { class: "band", x: bx0, y: pt, width: bx1 - bx0, height: ph }));
        if (pi === 0 && bx1 > bx0) {
          svg.append(s("text", { class: "band-label", x: (bx0 + bx1) / 2, y: pt - 6, "text-anchor": "middle" }, "Finestra"));
        }
      }
      for (const v of yt.values) {
        if (v < y0 || v > y1) continue;
        const yy = Y(v);
        svg.append(s("line", { class: v === 0 ? "baseline" : "gridline", x1: m.l, x2: m.l + w, y1: yy, y2: yy }));
        svg.append(s("text", { class: "tick", x: m.l - 6, y: yy + 4, "text-anchor": "end" },
          v.toFixed(yt.step < 1 ? (yt.step < 0.1 ? 2 : 1) : 0)));
      }
      svg.append(s("line", { class: "baseline", x1: m.l, x2: m.l + w, y1: pt + ph, y2: pt + ph }));
      for (const h of p.hlines || []) {
        const yy = Y(h.y);
        svg.append(s("line", { class: "mark-line", x1: m.l, x2: m.l + w, y1: yy, y2: yy }));
        svg.append(s("text", { class: "mark-label", x: m.l + w - 4, y: yy - 4, "text-anchor": "end" }, h.label));
      }

      const clip = `c${uid}${pi}`;
      const cp = s("clipPath", { id: clip });
      cp.append(s("rect", { x: m.l, y: pt, width: w, height: ph }));
      svg.append(cp);
      const g = s("g", { "clip-path": `url(#${clip})` });
      for (const sr of p.series) {
        let d = "", pen = false;
        sr.values.forEach((v, i) => {
          if (!Number.isFinite(v)) { pen = false; return; }
          const vv = p.cap != null ? Math.min(v, y1) : v;
          d += `${pen ? "L" : "M"}${X(x[i]).toFixed(1)},${Y(vv).toFixed(1)}`;
          pen = true;
        });
        g.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": sr.dash ? 1.5 : 2,
          "stroke-dasharray": sr.dash ? "5 4" : "none", "stroke-linejoin": "round", "stroke-linecap": "round" }));
      }
      svg.append(g);

      // etichette dirette a destra, per i pannelli con una sola serie piena
      if (m.r > 20) {
        const ends = p.series.filter((sr) => !sr.dash).map((sr) => {
          let k = sr.values.length - 1;
          while (k > 0 && !Number.isFinite(sr.values[k])) k--;
          return { sr, y: Y(Math.min(sr.values[k], y1)) };
        }).sort((a, b) => a.y - b.y);
        for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
        for (const e of ends) {
          const short = e.sr.label.replace("V orizzontale", "V orizz.");
          svg.append(s("text", { class: "direct", x: m.l + w + 6, y: e.y + 4 }, short));
        }
      }
      laid.push({ p, Y, y1, pt, ph });
      top = pt + ph + 4;
    }

    // asse x
    const xt = ticks(x0, x1, Math.max(2, Math.round(w / 90)));
    for (const v of xt.values) {
      svg.append(s("text", { class: "tick", x: X(v), y: top + 12, "text-anchor": "middle" },
        `${v.toFixed(0)}${v === xt.values[xt.values.length - 1] ? " m" : ""}`));
    }

    const cross = s("line", { class: "cross", y1: laid[0].pt, y2: top - 4, visibility: "hidden" });
    const dots = laid.flatMap((L) => L.p.series.map((sr) =>
      ({ L, sr, c: s("circle", { r: 3.5, fill: sr.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }) })));
    svg.append(cross, ...dots.map((d) => d.c));
    state = { X, m, w, cross, dots };
  }

  function show(i) {
    if (!state) return;
    const { X, cross, dots, m, w } = state;
    const xx = X(x[i]);
    cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.setAttribute("visibility", "visible");
    for (const d of dots) {
      const v = d.sr.values[i];
      const ok = Number.isFinite(v);
      d.c.setAttribute("visibility", ok ? "visible" : "hidden");
      if (ok) { d.c.setAttribute("cx", xx); d.c.setAttribute("cy", d.L.Y(Math.min(v, d.L.y1))); }
    }
    tip.replaceChildren(el("div", { class: "tip-head" }, `${x[i].toFixed(0)} m · ${t[i].toFixed(1)} s dall'uscita`),
      ...panels.flatMap((p) => p.series.map((sr) => {
        const v = sr.values[i];
        return el("div", { class: "tip-row" },
          el("i", { class: sr.dash ? "key dash" : "key", style: `--c:${sr.color};background:${sr.dash ? "none" : sr.color}` }),
          el("b", {}, Number.isFinite(v) ? `${v.toFixed(p.digits)}${p.unit ? " " + p.unit : ""}` : "–"),
          el("span", {}, sr.label));
      })));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = xx + 12 + tw > m.l + w ? xx - 12 - tw : xx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${svg.offsetTop + 24}px`;
    current = i;
  }
  function hide() {
    if (!state) return;
    state.cross.setAttribute("visibility", "hidden");
    state.dots.forEach((d) => d.c.setAttribute("visibility", "hidden"));
    tip.hidden = true;
  }
  function nearest(v) {
    let lo = 0, hi = x.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] < v) lo = mid; else hi = mid; }
    return v - x[lo] <= x[hi] - v ? lo : hi;
  }

  svg.addEventListener("pointermove", (e) => {
    if (!state) return;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (lastWidth / rect.width);
    const { m, w } = state;
    if (px < m.l - 8 || px > m.l + w + 8) return hide();
    show(nearest(x0 + ((px - m.l) / w) * (x1 - x0)));
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const i = current == null ? 0 : current + (e.key === "ArrowRight" ? step : -step);
    show(Math.min(x.length - 1, Math.max(0, i)));
  });

  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

// --------------------------------------------------------- vista dall'alto

function renderLane(j) {
  const card = $("#lane-card");
  card.hidden = !settings.laneOn;
  if (!settings.laneOn) return;
  const info = $("#lane-info");
  const root = $("#plan");
  root.replaceChildren();
  const L = j.lane;
  if (!L || L.bad) {
    info.textContent = "Il punto finale della corsia non è valido o è troppo lontano dal salto (oltre 50 km).";
    return;
  }
  if (j.win) {
    const dev = Math.abs(L.maxDev);
    info.textContent = `Corsia lunga ${(L.len / 1000).toFixed(2)} km, larga ${LANE_WIDTH} m. ` +
      `Nella finestra ti sei allontanato al massimo ${dev.toFixed(0)} m dal centro ` +
      `(${L.maxDev >= 0 ? "a destra" : "a sinistra"}): ` +
      (dev <= LANE_WIDTH / 2 ? "sei rimasto dentro la corsia." : "sei uscito dalla corsia.");
  } else {
    info.textContent = "";
  }

  const end = j.win ? j.win.bi + 2 : j.deploy;
  const track = j.pts.filter((p, i) => p.tr >= 0 && i <= Math.max(end, j.deploy));
  const half = LANE_WIDTH / 2;
  const nx = -L.uy * half, ny = L.ux * half;      // normale a sinistra
  const corners = [
    { x: L.S.x + nx, y: L.S.y + ny }, { x: L.E.x + nx, y: L.E.y + ny },
    { x: L.E.x - nx, y: L.E.y - ny }, { x: L.S.x - nx, y: L.S.y - ny },
  ];
  const all = [...track, ...corners];
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);

  const wrap = el("div", { class: "chart" });
  const svg = s("svg", { role: "img", "aria-label": "Vista dall'alto della traccia e della corsia" });
  wrap.append(svg);
  root.append(wrap);

  let lastWidth = 0;
  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width || wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    svg.replaceChildren();
    const pad = 16;
    const k = Math.min((width - 2 * pad) / (bx1 - bx0 || 1), 420 / (by1 - by0 || 1));
    const height = Math.round((by1 - by0) * k + 2 * pad);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    const ox = (width - (bx1 - bx0) * k) / 2;
    const P = (p) => `${(ox + (p.x - bx0) * k).toFixed(1)},${(pad + (by1 - p.y) * k).toFixed(1)}`;

    svg.append(s("polygon", { class: "lane", points: corners.map(P).join(" ") }));
    svg.append(s("polyline", { class: "mark-line", points: [L.S, L.E].map(P).join(" "), fill: "none" }));
    svg.append(s("polyline", { points: track.map(P).join(" "), fill: "none", stroke: "var(--muted)", "stroke-width": 1.5 }));
    if (j.win) {
      const seg = [j.win.top, ...j.pts.slice(j.win.ti, j.win.bi), j.win.bottom];
      svg.append(s("polyline", { points: seg.map(P).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 2.5,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    const dot = (p, label) => {
      const [cx, cy] = P(p).split(",").map(Number);
      svg.append(s("circle", { cx, cy, r: 4, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }));
      const right = cx > width - 90;
      svg.append(s("text", { class: "mark-label", x: right ? cx - 7 : cx + 7, y: cy - 6,
        "text-anchor": right ? "end" : "start" }, label));
    };
    dot(j.pts.find((p) => p.tr >= 0) || j.pts[0], "Uscita");
    dot(L.E, "Fine corsia");
    svg.append(s("text", { class: "tick", x: width - 8, y: 16, "text-anchor": "end" }, "N ↑"));
  }
  new ResizeObserver(draw).observe(wrap);
}

// ------------------------------------------------------------------ vento

let windToken = 0;

function renderWind(j) {
  const root = $("#wind");
  const w = j.windCache[settings.model];
  if (!w) {
    root.replaceChildren(el("p", { class: "hint" }, "Scarico il vento…"));
    const token = ++windToken;
    loadWind(j).then(() => {
      if (token !== windToken || j !== current) return;
      computeAir(j);
      renderResults(j);
      renderChart(j);
      renderWind(j);
    }).catch((e) => {
      if (token !== windToken || j !== current) return;
      console.error(e);
      root.replaceChildren(el("p", { class: "err" },
        `Non riesco a scaricare il vento (${e.message}). Controlla la connessione o prova l'altro modello.`));
    });
    return;
  }

  const { top, bottom } = settings;
  const steps = 4;
  const rows = [];
  for (let k = 0; k <= steps; k++) {
    const z = top - ((top - bottom) * k) / steps;
    const v = windAt(w.profile, z + j.ground);
    const sp = Math.hypot(v.e, v.n);
    const dir = fromDir(v.e, v.n);
    const tail = j.air ? (v.e * j.air.ue + v.n * j.air.un) * KMH : null;
    const cross = j.air ? (v.e * j.air.un - v.n * j.air.ue) * KMH : null;
    rows.push([
      `${Math.round(z)}`,
      `${(sp * KMH).toFixed(0)}`,
      [arrow(dir), ` ${Math.round(dir)}° ${cardinal(dir)}`],
      tail == null ? "–" : `${tail >= 0 ? "+" : "−"}${Math.abs(tail).toFixed(0)}`,
      cross == null ? "–" : `${Math.abs(cross).toFixed(0)} ${cross >= 0.5 ? "da sin." : cross <= -0.5 ? "da des." : ""}`,
    ]);
  }

  const exitTime = new Date(j.exitT * 1000);
  const hh = exitTime.toISOString().slice(11, 16);
  const table = el("table", {},
    el("thead", {}, el("tr", {}, ...["Quota dal suolo (m)", "Vento (km/h)", "Da", "In coda (km/h)", "Laterale (km/h)"]
      .map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, ...(Array.isArray(c) ? c : [c])))))));

  const levels = el("table", {},
    el("thead", {}, el("tr", {}, ...["Livello", "Quota s.l.m. (m)", "Quota dal suolo (m)", "Vento (km/h)", "Da"]
      .map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...[...w.profile].reverse().map((L) => {
      const dir = fromDir(L.e, L.n);
      return el("tr", {},
        el("td", {}, `${L.p} hPa`), el("td", {}, Math.round(L.gph)), el("td", {}, Math.round(L.gph - j.ground)),
        el("td", {}, (Math.hypot(L.e, L.n) * KMH).toFixed(0)), el("td", {}, arrow(dir), ` ${Math.round(dir)}° ${cardinal(dir)}`));
    })));

  root.replaceChildren(
    el("p", { class: "meta" }, `${exitTime.toISOString().slice(0, 10)} alle ${hh} UTC · ` +
      `${(j.win ? j.win.top : j.ex).lat.toFixed(2)}, ${(j.win ? j.win.top : j.ex).lon.toFixed(2)} · ` +
      `modello ${settings.model === "gfs_seamless" ? "GFS (NOAA)" : "ICON (DWD)"}`),
    el("div", { class: "scroll" }, table),
    el("p", { class: "hint" }, "“In coda” positivo = il vento ti spinge nella direzione del volo, negativo = contro. " +
      "Le frecce indicano dove va il vento (in alto = verso nord)."),
    el("details", {}, el("summary", {}, "Livelli del modello"), el("div", { class: "block" }, el("div", { class: "scroll" }, levels))));
}

function arrow(dirFrom) {
  const svg = s("svg", { class: "arrow", viewBox: "-8 -8 16 16", width: 16, height: 16, "aria-hidden": "true" });
  const g = s("g", { transform: `rotate(${(dirFrom + 180) % 360})` });
  g.append(s("path", { d: "M0,-6 L4,2 L1,1 L1,6 L-1,6 L-1,1 L-4,2 Z", fill: "currentColor" }));
  svg.append(g);
  return svg;
}

// ------------------------------------------------------------------- input

async function load(files) {
  if (!files.length) return;
  const out = [];
  const errors = [];
  for (const f of files) {
    try {
      out.push(prepare(f.name, await f.text()));
    } catch (e) {
      console.error(e);
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  if (!out.length) {
    setStatus(errors.join(" · ") || "Nessun file valido.", true);
    return;
  }
  jumps = out;
  const pick = $("#pick");
  pick.replaceChildren(...jumps.map((j, i) => el("option", { value: i }, j.name)));
  $("#pick-wrap").hidden = jumps.length < 2;
  $("#app").hidden = false;
  select(0);
  setStatus(errors.length ? `Alcuni file non letti: ${errors.join(" · ")}` : "", errors.length > 0);
}

function select(i) {
  current = jumps[i];
  $("#pick").value = i;
  const j = current;
  $("#jump-name").textContent = j.name;
  const d = new Date(j.exitT * 1000).toISOString();
  $("#jump-meta").textContent = `${j.format} · ${j.pts.length} punti a ${j.hz} Hz · uscita il ${d.slice(0, 10)} ` +
    `alle ${d.slice(11, 19)} UTC`;
  renderAll();
}

function readNum(id) {
  const v = Number($(id).value);
  return Number.isFinite(v) && $(id).value.trim() !== "" ? v : null;
}

function init() {
  const drop = $("#drop");
  const input = $("#files");
  const pick = (list) => load([...list].filter((f) => /\.csv$/i.test(f.name)));
  input.addEventListener("change", () => { pick(input.files); input.value = ""; });
  for (const ev of ["dragenter", "dragover"]) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "drop" || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove("over");
    });
  }
  document.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) pick(files);
  });

  const update = (fn) => () => { fn(); saveSettings(); renderAll(); };
  $("#pick").addEventListener("change", (e) => select(Number(e.target.value)));
  for (const b of document.querySelectorAll(".seg button")) {
    b.addEventListener("click", update(() => { settings.mode = b.dataset.mode; }));
  }
  $("#top").addEventListener("change", update(() => { const v = readNum("#top"); if (v != null) settings.top = v; }));
  $("#bottom").addEventListener("change", update(() => { const v = readNum("#bottom"); if (v != null) settings.bottom = v; }));
  $("#up").addEventListener("click", update(() => { settings.top += 10; settings.bottom += 10; }));
  $("#down").addEventListener("click", update(() => { settings.top -= 10; settings.bottom -= 10; }));
  $("#fai").addEventListener("click", update(() => { settings.top = 2500; settings.bottom = 1500; }));
  $("#ground").addEventListener("change", update(() => {
    const v = readNum("#ground");
    if (v != null) { current.ground = v; current.groundAuto = false; }
  }));
  $("#ground-auto").addEventListener("click", update(() => { current.ground = current.landing; current.groundAuto = true; }));
  $("#lane-on").addEventListener("change", update(() => { settings.laneOn = $("#lane-on").checked; }));
  $("#lane-lat").addEventListener("change", update(() => { const v = readNum("#lane-lat"); if (v != null) settings.laneLat = v; }));
  $("#lane-lon").addEventListener("change", update(() => { const v = readNum("#lane-lon"); if (v != null) settings.laneLon = v; }));
  $("#view").addEventListener("change", update(() => { settings.view = $("#view").value; }));
  $("#model").addEventListener("change", update(() => { settings.model = $("#model").value; }));
  $("#air").addEventListener("change", update(() => { settings.air = $("#air").checked; }));
}

init();
