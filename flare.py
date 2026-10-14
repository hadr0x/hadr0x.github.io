#!/usr/bin/env python3
"""Analizza il flare di un volo in tuta alare a partire da un file GPS.

Formati accettati:
  - FlySight 1 (CSV con colonne time,lat,lon,hMSL,velN,velE,velD,...)
  - FlySight 2 (TRACK.CSV con righe $GNSS)
  - CSV esportato da skyderby_csv.py (gps_time, altitude, h_speed, v_speed)

Esempi:
    python3 flare.py volo.csv
    python3 flare.py cartella_voli               # tutti i CSV della cartella + confronto
    python3 flare.py volo.csv --csv            # salva anche le tabelle in CSV in risultati/
    python3 flare.py volo.csv --da 95 --a 130  # cerca il flare solo in quell'intervallo
"""

import argparse
import bisect
import csv
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

G = 9.80665
KMH = 3.6

# soglie di riconoscimento (m/s)
EXIT_VD = 10.0        # discesa oltre questo valore per 2 s = uscita
CANOPY_VT = 16.0      # velocità totale sotto questo valore per 2 s = vela aperta
MIN_DROP = 8.0        # calo minimo di velocità verticale perché sia un flare
MAX_VD_AT_PEAK = 7.0  # al culmine la discesa deve scendere sotto questo valore
MIN_VH_AT_PEAK = 18.0 # velocità orizzontale minima al culmine (esclude l'apertura)
LOOKBACK = 25.0       # secondi prima del culmine in cui cercare l'inizio


# ---------------------------------------------------------------- lettura file

def parse_time(text):
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d+)?", text.strip())
    if not m:
        raise ValueError(text)
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    frac = float(m.group(7) or 0)
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp() + frac


def read_track(path):
    """Restituisce una lista di punti {t, alt, vn, ve, vd} in secondi, metri, m/s."""
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        return parse_track(f)


def parse_track(source):
    """Come read_track, ma da un testo già letto (o da qualsiasi sequenza di righe)."""
    if isinstance(source, str):
        source = source.lstrip("\ufeff").splitlines()
    lines = [ln.rstrip("\r\n") for ln in source if ln.strip()]
    if not lines:
        raise SystemExit("Il file è vuoto.")

    points = []
    if any(ln.startswith("$GNSS") for ln in lines[:200]):          # FlySight 2
        cols = None
        for ln in lines:
            parts = ln.split(",")
            if parts[0] == "$COL" and len(parts) > 1 and parts[1] == "GNSS":
                cols = parts[2:]
            elif parts[0] == "$GNSS" and cols:
                row = dict(zip(cols, parts[1:]))
                try:
                    points.append({
                        "t": parse_time(row["time"]), "alt": float(row["hMSL"]),
                        "vn": float(row["velN"]), "ve": float(row["velE"]),
                        "vd": float(row["velD"]),
                    })
                except (KeyError, ValueError):
                    continue
    else:
        rows = csv.DictReader(lines)
        names = set(rows.fieldnames or [])
        if {"time", "hMSL", "velN", "velE", "velD"} <= names:      # FlySight 1
            for row in rows:
                try:
                    points.append({
                        "t": parse_time(row["time"]), "alt": float(row["hMSL"]),
                        "vn": float(row["velN"]), "ve": float(row["velE"]),
                        "vd": float(row["velD"]),
                    })
                except (TypeError, ValueError):
                    continue  # riga delle unità di misura
        elif {"gps_time", "h_speed", "v_speed"} <= names:           # skyderby
            alt_col = "abs_altitude" if "abs_altitude" in names else "altitude"
            for row in rows:
                try:
                    points.append({
                        "t": parse_time(row["gps_time"]), "alt": float(row[alt_col]),
                        "vn": float(row["h_speed"]) / KMH, "ve": 0.0,
                        "vd": float(row["v_speed"]) / KMH,
                    })
                except (TypeError, ValueError):
                    continue
        else:
            raise SystemExit("Formato non riconosciuto: serve un file FlySight "
                             "o un CSV esportato da skyderby_csv.py.")

    points.sort(key=lambda p: p["t"])
    clean = [p for i, p in enumerate(points) if i == 0 or p["t"] > points[i - 1]["t"]]
    if len(clean) < 10:
        raise SystemExit("Troppi pochi punti validi nel file.")
    return clean


# -------------------------------------------------------------------- calcoli

def smooth(values, n):
    if n <= 1:
        return list(values)
    half = n // 2
    out = []
    for i in range(len(values)):
        chunk = values[max(0, i - half):i + half + 1]
        out.append(sum(chunk) / len(chunk))
    return out


def derivative(values, t):
    out = []
    last = len(values) - 1
    for i in range(len(values)):
        a, b = max(0, i - 1), min(last, i + 1)
        out.append((values[b] - values[a]) / (t[b] - t[a]) if t[b] > t[a] else 0.0)
    return out


class Track:
    def __init__(self, points):
        self.t0 = points[0]["t"]
        self.t = [p["t"] - self.t0 for p in points]
        steps = sorted(b - a for a, b in zip(self.t, self.t[1:]))
        self.hz = 1.0 / steps[len(steps) // 2]
        n = max(1, int(round(0.8 * self.hz)) | 1) if self.hz >= 2 else 1

        self.alt = smooth([p["alt"] for p in points], n)
        vn = smooth([p["vn"] for p in points], n)
        ve = smooth([p["ve"] for p in points], n)
        self.vd = smooth([p["vd"] for p in points], n)
        self.vh = [math.hypot(a, b) for a, b in zip(vn, ve)]
        self.vt = [math.hypot(h, d) for h, d in zip(self.vh, self.vd)]

        an, ae, ad = (derivative(v, self.t) for v in (vn, ve, self.vd))
        self.g = [math.sqrt(a * a + b * b + (c - G) ** 2) / G for a, b, c in zip(an, ae, ad)]

        # distanza orizzontale progressiva
        self.dist = [0.0]
        for i in range(1, len(self.t)):
            dt = self.t[i] - self.t[i - 1]
            self.dist.append(self.dist[-1] + (self.vh[i] + self.vh[i - 1]) / 2 * dt)

    def index_at(self, seconds):
        i = bisect.bisect_left(self.t, seconds)
        if i == 0:
            return 0
        if i == len(self.t):
            return i - 1
        return i - 1 if seconds - self.t[i - 1] <= self.t[i] - seconds else i

    def first_sustained(self, start, cond, seconds):
        """Primo indice >= start da cui cond resta vera per almeno `seconds`."""
        run = None
        for i in range(start, len(self.t)):
            if cond(i):
                run = i if run is None else run
                if self.t[i] - self.t[run] >= seconds:
                    return run
            else:
                run = None
        return None


def flight_window(tr):
    exit_i = tr.first_sustained(0, lambda i: tr.vd[i] > EXIT_VD, 2.0)
    if exit_i is None:
        raise SystemExit("Non trovo una fase di caduta nel file "
                         "(usa --da e --a per indicare l'intervallo a mano).")
    after = tr.index_at(tr.t[exit_i] + 5.0)
    end_i = tr.first_sustained(after, lambda i: tr.vt[i] < CANOPY_VT, 2.0)
    return exit_i, (end_i if end_i is not None else len(tr.t) - 1)


def find_flares(tr, lo, hi):
    """Culmini dei flare: minimi locali di velocità verticale dopo un calo netto."""
    last = len(tr.t) - 1
    peaks = []
    for i in range(lo, hi + 1):
        a, b = tr.index_at(tr.t[i] - 3.0), tr.index_at(tr.t[i] + 3.0)
        a, b = max(a, lo), min(b, hi)
        if tr.vd[i] > min(tr.vd[a:b + 1]):
            continue
        if i == hi and hi != last:
            continue  # sta ancora rallentando: è l'apertura, non un culmine
        if tr.vh[i] < MIN_VH_AT_PEAK or tr.vd[i] > MAX_VD_AT_PEAK:
            continue
        back = max(lo, tr.index_at(tr.t[i] - LOOKBACK))
        if max(tr.vd[back:i + 1]) - tr.vd[i] < MIN_DROP:
            continue
        if peaks and tr.t[i] - tr.t[peaks[-1]] < 5.0:
            if tr.vd[i] < tr.vd[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return peaks


def measure(tr, peak, lo, hi):
    back = max(lo, tr.index_at(tr.t[peak] - LOOKBACK))
    vmax = max(tr.vd[back:peak + 1])
    start = max(i for i in range(back, peak + 1) if tr.vd[i] >= vmax - 1.0)

    climbed = tr.vd[peak] < 0
    if climbed:
        bottom = next(i for i in range(start, peak + 1) if tr.vd[i] <= 0)
        stop = peak
        while stop < hi and tr.vd[stop + 1] < 0:
            stop += 1
        stop = min(stop + 1, len(tr.t) - 1)
        top = max(range(bottom, stop + 1), key=lambda i: tr.alt[i])
    else:
        bottom = top = peak

    gain = max(0.0, tr.alt[top] - tr.alt[bottom])
    kinetic = (tr.vt[bottom] ** 2 - tr.vt[top] ** 2) / (2 * G)
    vt_max_i = max(range(back, top + 1), key=lambda i: tr.vt[i])
    return {
        "start": start, "peak": peak, "bottom": bottom, "top": top, "climbed": climbed,
        "gain": gain,
        "lost": tr.alt[start] - tr.alt[bottom],
        "efficiency": gain / kinetic * 100 if climbed and kinetic > 1 else None,
        "vt_max": tr.vt[vt_max_i],
        "g_max": max(tr.g[start:top + 1]),
        "dist": tr.dist[top] - tr.dist[start],
    }


# --------------------------------------------------------------------- tabelle

def kmh(v):
    return f"{v * KMH:.0f}"


def glide(vh, vd):
    return f"{vh / vd:.2f}" if vd > 0.5 else "salita" if vd < 0 else "∞"


def clock(tr, i):
    return datetime.fromtimestamp(tr.t0 + tr.t[i], timezone.utc).strftime("%H:%M:%S")


def summary_rows(tr, flares, exit_i):
    def row(label, fn):
        return [label] + [fn(f) for f in flares]

    return [
        row("Inizio flare (ora UTC)", lambda f: clock(tr, f["start"])),
        row("Inizio flare (s dall'uscita)", lambda f: f"{tr.t[f['start']] - tr.t[exit_i]:.1f}"),
        row("Quota a inizio flare (m)", lambda f: f"{tr.alt[f['start']]:.0f}"),
        row("V totale a inizio flare (km/h)", lambda f: kmh(tr.vt[f["start"]])),
        row("V orizzontale a inizio flare (km/h)", lambda f: kmh(tr.vh[f["start"]])),
        row("V verticale a inizio flare (km/h)", lambda f: kmh(tr.vd[f["start"]])),
        row("Efficienza a inizio flare", lambda f: glide(tr.vh[f["start"]], tr.vd[f["start"]])),
        row("V totale massima (km/h)", lambda f: kmh(f["vt_max"])),
        row("V verticale minima (km/h)", lambda f: kmh(tr.vd[f["peak"]])),
        row("Tempo fino alla V vert. minima (s)",
            lambda f: f"{tr.t[f['peak']] - tr.t[f['start']]:.1f}"),
        row("Quota persa prima di risalire (m)", lambda f: f"{f['lost']:.0f}"),
        row("Quota guadagnata (m)", lambda f: f"{f['gain']:.0f}"),
        row("Durata della salita (s)",
            lambda f: f"{tr.t[f['top']] - tr.t[f['bottom']]:.1f}" if f["climbed"] else "-"),
        row("V totale al culmine (km/h)", lambda f: kmh(tr.vt[f["top"]])),
        row("V orizzontale al culmine (km/h)", lambda f: kmh(tr.vh[f["top"]])),
        row("V totale persa nel flare (km/h)",
            lambda f: kmh(tr.vt[f["start"]] - tr.vt[f["top"]])),
        row("Distanza orizzontale nel flare (m)", lambda f: f"{f['dist']:.0f}"),
        row("G massimi", lambda f: f"{f['g_max']:.2f}"),
        row("Rendimento velocità→quota (%)",
            lambda f: f"{f['efficiency']:.0f}" if f["efficiency"] is not None else "-"),
    ]


def detail_rows(tr, f):
    """Andamento nel tempo, da 2 s prima dell'inizio a 2 s dopo il culmine."""
    step = 0.5 if tr.hz >= 2 else 1.0 / tr.hz
    t_start = tr.t[f["start"]]
    t = max(tr.t[0], t_start - 2.0)
    t_end = min(tr.t[-1], tr.t[f["top"]] + 2.0)
    marks = {f["start"]: "inizio", f["bottom"]: "punto più basso",
             f["peak"]: "V vert. minima", f["top"]: "culmine"}
    if not f["climbed"]:
        marks = {f["start"]: "inizio", f["peak"]: "V vert. minima"}

    rows, seen = [], set()
    wanted = []
    while t <= t_end + 1e-6:
        wanted.append(tr.index_at(t))
        t += step
    for i in sorted(set(wanted) | set(marks)):
        if i in seen:
            continue
        seen.add(i)
        rows.append([
            f"{tr.t[i] - t_start:+.1f}",
            f"{tr.alt[i] - tr.alt[f['start']]:+.0f}",
            kmh(tr.vh[i]), kmh(tr.vd[i]), kmh(tr.vt[i]),
            glide(tr.vh[i], tr.vd[i]), f"{tr.g[i]:.2f}", marks.get(i, ""),
        ])
    return rows


def print_table(headers, rows):
    widths = [max(len(str(r[c])) for r in [headers] + rows) for c in range(len(headers))]
    def line(r):
        cells = [str(r[0]).ljust(widths[0])] + [str(v).rjust(w) for v, w in zip(r[1:], widths[1:])]
        return "  ".join(cells).rstrip()
    print(line(headers))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print(line(r))


RESULTS_DIR = "risultati"


def write_csv(path, headers, rows):
    path.parent.mkdir(exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(headers)
        w.writerows(rows)


DETAIL_HEADERS = ["t (s)", "quota (m)", "V orizz", "V vert", "V tot", "effic.", "G", ""]


COMPARE_HEADERS = ["file", "flare", "quota inizio", "V tot inizio", "V tot max",
                   "V vert min", "quota persa", "quota guadagnata", "durata salita",
                   "V tot culmine", "G max", "rendimento %"]


def collect_files(paths):
    """Espande le cartelle nei CSV che contengono, saltando le tabelle già prodotte."""
    files = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(f for f in p.iterdir()
                            if f.is_file() and f.suffix.lower() == ".csv"
                            and "_flare_" not in f.name and f.name not in ("confronto_flare.csv", "indice.csv"))
        elif p.is_file():
            files.append(p)
        else:
            print(f"Non trovo: {p}", file=sys.stderr)
    return files


def locate(tr, da=None, a=None):
    """Trova l'intervallo di volo e i flare: restituisce (exit_i, lo, hi, flares)."""
    if da is not None or a is not None:
        lo = tr.index_at(da) if da is not None else 0
        hi = tr.index_at(a) if a is not None else len(tr.t) - 1
        exit_i = lo
    else:
        exit_i, hi = flight_window(tr)
        lo = exit_i
    if hi <= lo:
        raise SystemExit("Intervallo non valido.")

    flares = []
    for p in find_flares(tr, lo, hi):
        f = measure(tr, p, lo, hi)
        if flares and flares[-1]["start"] == f["start"]:
            continue  # stesso flare visto due volte
        flares.append(f)
    return exit_i, lo, hi, flares


def compare_rows(name, tr, flares):
    return [[
        name[:30], n,
        f"{tr.alt[f['start']]:.0f}", kmh(tr.vt[f["start"]]), kmh(f["vt_max"]),
        kmh(tr.vd[f["peak"]]), f"{f['lost']:.0f}", f"{f['gain']:.0f}",
        f"{tr.t[f['top']] - tr.t[f['bottom']]:.1f}" if f["climbed"] else "-",
        kmh(tr.vt[f["top"]]), f"{f['g_max']:.2f}",
        f"{f['efficiency']:.0f}" if f["efficiency"] is not None else "-",
    ] for n, f in enumerate(flares, 1)]


def series(tr, a, b, origin=0.0, alt0=None):
    """Valori grezzi (km/h, m) tra gli indici a e b, per i grafici della pagina web."""
    r = range(a, b + 1)
    return {
        "t": [round(tr.t[i] - origin, 2) for i in r],
        "alt": [round(tr.alt[i] - (alt0 or 0.0), 1) for i in r],
        "vh": [round(tr.vh[i] * KMH, 1) for i in r],
        "vd": [round(tr.vd[i] * KMH, 1) for i in r],
        "vt": [round(tr.vt[i] * KMH, 1) for i in r],
        "g": [round(tr.g[i], 2) for i in r],
    }


def analyze_text(name, text, da=None, a=None):
    """Punto d'ingresso per la pagina web: tutto il risultato in un dict serializzabile."""
    try:
        tr = Track(parse_track(text))
        exit_i, lo, hi, flares = locate(tr, da, a)
    except SystemExit as e:
        return {"name": name, "error": str(e)}

    headers = ["RIEPILOGO"] + [f"Flare {n}" for n in range(1, len(flares) + 1)]
    if len(flares) == 1:
        headers[1] = "Valore"
    t_exit = tr.t[exit_i]
    out = {
        "name": name, "points": len(tr.t), "hz": round(tr.hz, 1),
        "from": clock(tr, lo), "to": clock(tr, hi),
        "duration": round(tr.t[hi] - tr.t[lo]),
        "summary": {"headers": headers, "rows": summary_rows(tr, flares, exit_i)} if flares else None,
        "flight": series(tr, lo, hi, origin=t_exit),
        "flares": [],
        "compare": compare_rows(Path(name).stem, tr, flares),
    }
    for f in flares:
        a_i = tr.index_at(tr.t[f["start"]] - 3.0)
        b_i = tr.index_at(tr.t[f["top"]] + 3.0)
        t_start = tr.t[f["start"]]
        marks = [("inizio", f["start"]), ("V vert. minima", f["peak"])]
        if f["climbed"]:
            marks += [("punto più basso", f["bottom"]), ("culmine", f["top"])]
        out["flares"].append({
            "detail": {"headers": DETAIL_HEADERS[:-1] + ["evento"], "rows": detail_rows(tr, f)},
            "series": series(tr, a_i, b_i, origin=t_start, alt0=tr.alt[f["start"]]),
            "marks": [{"label": lbl, "t": round(tr.t[i] - t_start, 2)} for lbl, i in marks],
            "span": [round(tr.t[f["start"]] - t_exit, 2), round(tr.t[f["top"]] - t_exit, 2)],
        })
    return out


def analyze(path, args):
    """Analizza un file, stampa le tabelle e restituisce le righe per il confronto."""
    tr = Track(read_track(path))
    exit_i, lo, hi, flares = locate(tr, args.da, args.a)

    print(f"File: {path.name}  -  {len(tr.t)} punti a {tr.hz:.0f} Hz")
    print(f"Volo analizzato: da {clock(tr, lo)} a {clock(tr, hi)} UTC "
          f"({tr.t[hi] - tr.t[lo]:.0f} s)")
    if tr.hz < 2:
        print("Nota: dati a 1 punto al secondo, i valori di picco (V minima, G) sono approssimati.")

    if not flares:
        print("\nNessun flare trovato in questo intervallo.")
        return []

    headers = ["RIEPILOGO"] + [f"Flare {n}" for n in range(1, len(flares) + 1)]
    if len(flares) == 1:
        headers[1] = "Valore"
    summary = summary_rows(tr, flares, exit_i)
    print()
    print_table(headers, summary)

    base = path.parent / RESULTS_DIR / path.stem
    if args.csv:
        write_csv(base.with_name(f"{base.name}_flare_riepilogo.csv"), headers, summary)

    for n, f in enumerate(flares, 1):
        rows = detail_rows(tr, f)
        print(f"\nANDAMENTO FLARE {n}  (t = 0 all'inizio del flare, quota rispetto all'inizio, "
              "velocità in km/h, V vert positiva = discesa)")
        print_table(DETAIL_HEADERS, rows)
        if args.csv:
            write_csv(base.with_name(f"{base.name}_flare_{n}_andamento.csv"),
                      DETAIL_HEADERS[:-1] + ["evento"], rows)

    if args.csv:
        print(f"\nTabelle salvate in {base}_flare_*.csv")

    return compare_rows(path.stem, tr, flares)


def main():
    ap = argparse.ArgumentParser(description="Analisi del flare da file GPS di tuta alare")
    ap.add_argument("file", nargs="+",
                    help="uno o più file FlySight / CSV skyderby, oppure una cartella che li contiene")
    ap.add_argument("--da", type=float, metavar="SEC",
                    help="inizio dell'intervallo in cui cercare (secondi dall'inizio del file)")
    ap.add_argument("--a", type=float, metavar="SEC",
                    help="fine dell'intervallo in cui cercare (secondi dall'inizio del file)")
    ap.add_argument("--csv", action="store_true",
                    help=f"salva le tabelle in file CSV nella sottocartella '{RESULTS_DIR}'")
    args = ap.parse_args()

    files = collect_files(args.file)
    if not files:
        raise SystemExit("Nessun file CSV da analizzare.")

    compare = []
    for k, path in enumerate(files):
        if k:
            print("\n" + "=" * 80 + "\n")
        try:
            compare += analyze(path, args)
        except SystemExit as e:
            print(f"{path.name}: {e}")

    if len(files) > 1 and compare:
        print("\n" + "=" * 80)
        print("\nCONFRONTO TRA I VOLI  (quote in m, velocità in km/h, durata in s)")
        print_table(COMPARE_HEADERS, compare)
        if args.csv:
            out = files[0].parent / RESULTS_DIR / "confronto_flare.csv"
            write_csv(out, COMPARE_HEADERS, compare)
            print(f"\nConfronto salvato in {out}")

    sys.exit(0 if compare else 1)


if __name__ == "__main__":
    main()
