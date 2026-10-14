"use strict";

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

const SPEEDS = [
  { key: "vt", label: "V totale", color: "var(--s1)" },
  { key: "vh", label: "V orizzontale", color: "var(--s2)" },
  { key: "vd", label: "V verticale", color: "var(--s3)" },
];

const $ = (sel) => document.querySelector(sel);
let lastFiles = [];

// ------------------------------------------------------------------ Python

let pyReady = null;
function loadPython() {
  if (!pyReady) {
    pyReady = (async () => {
      const py = await loadPyodide({ indexURL: PYODIDE_URL });
      const src = await (await fetch("flare.py", { cache: "no-cache" })).text();
      py.FS.writeFile("/home/pyodide/flare.py", src);
      py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
      return py.pyimport("flare");
    })();
    pyReady.catch(() => { pyReady = null; });
  }
  return pyReady;
}

function setStatus(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// lascia al browser il tempo di aggiornare lo stato (rAF non scatta se la scheda è in background)
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

function readNumber(id) {
  const v = $(id).value.trim();
  return v === "" ? null : Number(v);
}

async function run(files) {
  if (!files.length) return;
  lastFiles = files;
  $("#rerun").disabled = false;
  let flare;
  try {
    if (!window.loadPyodide) throw new Error("Pyodide non caricato");
    setStatus("Carico Python nel browser… la prima volta ci vuole qualche secondo.");
    flare = await loadPython();
  } catch (e) {
    console.error(e);
    setStatus("Non riesco a caricare Python nel browser. Controlla la connessione e ricarica la pagina.", true);
    return;
  }

  const da = readNumber("#da");
  const a = readNumber("#a");
  const results = [];
  for (const [k, file] of files.entries()) {
    setStatus(`Analizzo ${file.name} (${k + 1} di ${files.length})…`);
    await nextFrame();
    const text = await file.text();
    const proxy = flare.analyze_text(file.name, text, da, a);
    results.push(proxy.toJs({ dict_converter: Object.fromEntries }));
    proxy.destroy();
  }
  render(results);
  const found = results.reduce((n, r) => n + (r.flares ? r.flares.length : 0), 0);
  setStatus(`${results.length} ${results.length === 1 ? "file analizzato" : "file analizzati"}, ` +
            `${found} ${found === 1 ? "flare trovato" : "flare trovati"}.`);
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

function stem(name) { return name.replace(/\.[^.]+$/, ""); }

function render(results) {
  const root = $("#results");
  root.replaceChildren();

  const compare = results.flatMap((r) => r.compare || []);
  if (results.length > 1 && compare.length) {
    root.append(el("section", { class: "card" },
      el("div", { class: "block-head" },
        el("h2", {}, "Confronto tra i voli"),
        csvButton("confronto_flare.csv", COMPARE_HEADERS, compare)),
      el("p", { class: "hint" }, "Quote in m, velocità in km/h, durata in s."),
      table(COMPARE_HEADERS, compare)));
  }
  for (const r of results) root.append(fileCard(r));
}

const COMPARE_HEADERS = ["file", "flare", "quota inizio", "V tot inizio", "V tot max",
  "V vert min", "quota persa", "quota guadagnata", "durata salita",
  "V tot culmine", "G max", "rendimento %"];

function fileCard(r) {
  const card = el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, r.name)));
  if (r.error) {
    card.append(el("p", { class: "err" }, r.error));
    return card;
  }
  card.append(el("p", { class: "meta" },
    `${r.points} punti a ${r.hz} Hz · volo analizzato dalle ${r.from} alle ${r.to} UTC (${r.duration} s)` +
    (r.hz < 2 ? " · dati a 1 Hz: i valori di picco sono approssimati" : "")));

  card.append(el("div", { class: "block" },
    el("p", { class: "chart-title" }, "Velocità durante il volo (km/h) · secondi dall'uscita · in evidenza i flare"),
    lineChart({
      x: r.flight.t, series: SPEEDS.map((s) => ({ ...s, values: r.flight[s.key] })),
      unit: "km/h", xUnit: "s", height: 240,
      bands: r.flares.map((f, i) => ({ from: f.span[0], to: f.span[1], label: `F${i + 1}` })),
    })));

  if (!r.summary) {
    card.append(el("p", { class: "err" }, "Nessun flare trovato in questo intervallo."));
    return card;
  }

  const base = stem(r.name);
  card.append(el("div", { class: "block" },
    el("div", { class: "block-head" },
      el("h3", {}, "Riepilogo"),
      csvButton(`${base}_flare_riepilogo.csv`, r.summary.headers, r.summary.rows)),
    table(r.summary.headers, r.summary.rows)));

  const list = el("div", { class: "flares" });
  r.flares.forEach((f, i) => list.append(flareBlock(f, i + 1, base)));
  card.append(list);
  return card;
}

function flareBlock(f, n, base) {
  const s = f.series;
  const marks = f.marks;
  const details = el("details", {},
    el("summary", {}, "Tabella dati (ogni mezzo secondo)"),
    el("div", { class: "block" }, table(f.detail.headers, f.detail.rows, { eventCol: true })));
  return el("div", { class: "flare" },
    el("div", { class: "block-head" },
      el("h3", {}, `Flare ${n}`),
      csvButton(`${base}_flare_${n}_andamento.csv`, f.detail.headers, f.detail.rows)),
    el("p", { class: "hint" }, "Tempo in secondi dall'inizio del flare. V verticale positiva = discesa."),
    el("div", { class: "flare-grid" },
      el("div", { class: "wide" },
        el("p", { class: "chart-title" }, "Velocità (km/h)"),
        lineChart({ x: s.t, series: SPEEDS.map((sp) => ({ ...sp, values: s[sp.key] })),
          unit: "km/h", xUnit: "s", height: 260, marks })),
      el("div", {},
        el("p", { class: "chart-title" }, "Quota rispetto all'inizio del flare (m)"),
        lineChart({ x: s.t, series: [{ key: "alt", label: "Quota", color: "var(--s1)", values: s.alt }],
          unit: "m", xUnit: "s", height: 180, marks, signed: true })),
      el("div", {},
        el("p", { class: "chart-title" }, "Carico (G)"),
        lineChart({ x: s.t, series: [{ key: "g", label: "G", color: "var(--s1)", values: s.g }],
          unit: "G", xUnit: "s", height: 180, marks, digits: 2 }))),
    details);
}

function table(headers, rows, { eventCol = false } = {}) {
  const head = el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, String(h))));
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((v, c) => {
      const td = el("td", {}, String(v));
      if (eventCol && c === row.length - 1 && v) { td.className = "event"; tr.className = "marked"; }
      tr.append(td);
    });
    body.append(tr);
  }
  return el("div", { class: "scroll" }, el("table", {}, el("thead", {}, head), body));
}

function csvButton(filename, headers, rows) {
  return el("button", { type: "button", class: "linkbtn", onclick: () => downloadCsv(filename, headers, rows) },
    "Scarica CSV");
}

function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ chart

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
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

function ticks(lo, hi, count) {
  const step = niceStep(hi - lo || 1, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return { step, values: out };
}

function nearest(xs, v) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid; else hi = mid;
  }
  return v - xs[lo] <= xs[hi] - v ? lo : hi;
}

function fmt(v, digits) {
  return v.toFixed(digits);
}

function lineChart(opts) {
  const { x, series, unit, xUnit, height = 240, marks = [], bands = [], digits = 0, signed = false } = opts;
  const wrap = el("div", { class: "chart" });
  if (series.length > 1) {
    wrap.append(el("div", { class: "legend" }, ...series.map((sr) =>
      el("span", {}, el("i", { class: "key", style: `background:${sr.color}` }), sr.label))));
  }
  const svg = s("svg", { role: "img", tabindex: "0",
    "aria-label": `Grafico: ${series.map((sr) => sr.label).join(", ")} (${unit}) nel tempo` });
  const tip = el("div", { class: "tip", hidden: "" });
  wrap.append(svg, tip);

  let lastWidth = 0;
  let state = null;

  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width || wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    svg.replaceChildren();

    const direct = series.length > 1 && width >= 480;  // su schermi stretti basta la legenda
    const m = { l: 40, r: direct ? 92 : 12, t: marks.length ? 34 : bands.length ? 18 : 8, b: 24 };
    const w = width - m.l - m.r;
    const h = height - m.t - m.b;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);

    const x0 = x[0], x1 = x[x.length - 1];
    let ymin = Infinity, ymax = -Infinity;
    for (const sr of series) for (const v of sr.values) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
    if (unit === "G") ymin = Math.min(ymin, 0);
    const pad = (ymax - ymin || 1) * 0.06;
    const yt = ticks(ymin - pad, ymax + pad, Math.max(3, Math.round(h / 45)));
    const y0 = Math.min(yt.values[0], ymin - pad), y1 = Math.max(yt.values[yt.values.length - 1], ymax + pad);
    const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * w;
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * h;

    // bands (flares on the overview)
    for (const b of bands) {
      const bx0 = X(Math.max(x0, b.from)), bx1 = X(Math.min(x1, b.to));
      svg.append(s("rect", { class: "band", x: bx0, y: m.t, width: Math.max(2, bx1 - bx0), height: h }));
      svg.append(s("text", { class: "band-label", x: (bx0 + bx1) / 2, y: m.t - 5, "text-anchor": "middle" }, b.label));
    }

    // y grid + labels
    for (const v of yt.values) {
      if (v < y0 || v > y1) continue;
      const yy = Y(v);
      svg.append(s("line", { class: v === 0 ? "baseline" : "gridline", x1: m.l, x2: m.l + w, y1: yy, y2: yy }));
      const label = (signed && v > 0 ? "+" : "") + fmt(v, yt.step < 1 ? (yt.step < 0.1 ? 2 : 1) : 0);
      svg.append(s("text", { class: "tick", x: m.l - 6, y: yy + 4, "text-anchor": "end" }, label));
    }
    svg.append(s("line", { class: "baseline", x1: m.l, x2: m.l + w, y1: m.t + h, y2: m.t + h }));

    // x labels
    const xt = ticks(x0, x1, Math.max(2, Math.round(w / 80)));
    for (const v of xt.values) {
      svg.append(s("text", { class: "tick", x: X(v), y: m.t + h + 16, "text-anchor": "middle" },
        `${fmt(v, xt.step < 1 ? 1 : 0)}${v === xt.values[xt.values.length - 1] ? " " + xUnit : ""}`));
    }

    // event marks, labels on two staggered rows
    [...marks].sort((p, q) => p.t - q.t).forEach((mk, i) => {
      if (mk.t < x0 || mk.t > x1) return;
      const xx = X(mk.t);
      svg.append(s("line", { class: "mark-line", x1: xx, x2: xx, y1: m.t - (i % 2 ? 4 : 18), y2: m.t + h }));
      const anchor = xx < m.l + 40 ? "start" : xx > m.l + w - 40 ? "end" : "middle";
      svg.append(s("text", { class: "mark-label", x: xx, y: m.t - (i % 2 ? 6 : 20), "text-anchor": anchor }, mk.label));
    });

    // lines
    for (const sr of series) {
      let d = "";
      sr.values.forEach((v, i) => { d += `${i ? "L" : "M"}${X(x[i]).toFixed(1)},${Y(v).toFixed(1)}`; });
      svg.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }

    // direct labels at the right end, nudged apart
    if (direct) {
      const ends = series.map((sr) => ({ sr, y: Y(sr.values[sr.values.length - 1]) })).sort((p, q) => p.y - q.y);
      for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
      for (const e of ends) {
        const ex = m.l + w + 6;
        svg.append(s("line", { x1: ex, x2: ex + 10, y1: e.y, y2: e.y, stroke: e.sr.color, "stroke-width": 2, "stroke-linecap": "round" }));
        svg.append(s("text", { class: "direct", x: ex + 14, y: e.y + 4 }, e.sr.label));
      }
    }

    // hover layer
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
    series.forEach((sr, k) => {
      dots[k].setAttribute("cx", xx); dots[k].setAttribute("cy", Y(sr.values[i]));
      dots[k].setAttribute("visibility", "visible");
    });
    tip.replaceChildren(el("div", { class: "tip-head" }, `${fmt(x[i], 1)} ${xUnit}`),
      ...series.map((sr) => el("div", { class: "tip-row" },
        el("i", { class: "key", style: `background:${sr.color}` }),
        el("b", {}, `${signed && sr.values[i] > 0 ? "+" : ""}${fmt(sr.values[i], digits)} ${unit}`),
        el("span", {}, sr.label))));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const top = svg.offsetTop + m.t;
    const left = xx + 12 + tw > m.l + w ? xx - 12 - tw : xx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${top}px`;
    current = i;
  }
  function hide() {
    if (!state) return;
    state.cross.setAttribute("visibility", "hidden");
    state.dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tip.hidden = true;
  }

  let current = null;
  svg.addEventListener("pointermove", (e) => {
    if (!state) return;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (lastWidth / rect.width);
    const { m, w } = state;
    if (px < m.l - 8 || px > m.l + w + 8) return hide();
    const v = x[0] + ((px - m.l) / w) * (x[x.length - 1] - x[0]);
    show(nearest(x, v));
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

// ------------------------------------------------------------------- input

function init() {
  const drop = $("#drop");
  const input = $("#files");
  const pick = (list) => run([...list].filter((f) => /\.csv$/i.test(f.name)));

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
  $("#rerun").addEventListener("click", () => run(lastFiles));

  // inizia a scaricare Python subito, così è pronto quando arriva il primo file
  if (window.loadPyodide) loadPython().catch(() => {});
}

init();
