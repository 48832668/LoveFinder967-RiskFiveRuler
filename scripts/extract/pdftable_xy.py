# -*- coding: utf-8 -*-
"""Extract a WCH pin-definition table using real text coordinates.

The earlier line-based parser could not tell which row a wrapped table cell
belonged to, because cells are vertically centred: a tall cell spills onto the
lines above *and* below its own pin row.  Reading the glyph coordinates lets us
cut the table into horizontal bands, one per pin row, which is exact.

Usage:
  python pdftable_xy.py <pdf> <first_page> <last_page> <n_pkg_cols> \
         <pkg_ids,comma> <out.json> [header_anchor]
"""
import io
import json
import re
import sys
from collections import Counter, defaultdict

from pypdf import PdfReader

pdf_path = sys.argv[1]
first_page = int(sys.argv[2])
last_page = int(sys.argv[3])
npkg = int(sys.argv[4])
pkg_ids = sys.argv[5].split(",")
out_path = sys.argv[6]
anchor = sys.argv[7] if len(sys.argv) > 7 else "默认复用功能"

PIN_NAME = re.compile(r"^(?:P[A-E]\d+|VDD|VSS|VDDA|VSSA|VBAT|GND|NRST|RST|BOOT0|BOOT1|"
                      r"OSC_IN|OSC_OUT|PC1[345])")


def runs_of(page):
    out = []

    def visit(text, cm, tm, font_dict, font_size):
        t = text.strip()
        if not t:
            return
        out.append({"t": t, "x": round(tm[4], 2), "y": round(tm[5], 2)})

    page.extract_text(visitor_text=visit)
    return out


def cluster(vals, tol=3.0):
    vals = sorted(vals)
    if not vals:
        return []
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def group_lines(runs, tol=2.0):
    """group runs into visual lines (same baseline), left to right"""
    lines = {}
    for r in runs:
        key = round(r["y"] / tol) * tol
        lines.setdefault(key, []).append(r)
    out = []
    for y in sorted(lines, reverse=True):
        rs = sorted(lines[y], key=lambda r: r["x"])
        out.append({"y": y, "runs": rs, "text": "".join(r["t"] for r in rs)})
    return out


CJK_W = 10.5


def find_text_x(line, needle):
    """x where `needle` starts inside the line's joined text"""
    joined = ""
    spans = []
    for r in line["runs"]:
        spans.append((len(joined), r["x"], r["t"]))
        joined += r["t"]
    i = joined.find(needle)
    if i < 0:
        return None
    for start, x, t in spans:
        if start <= i < start + len(t):
            return x + (i - start) * CJK_W
    return None


rows = []
pkg_pos = Counter()
reader = PdfReader(pdf_path)

for pno in range(first_page - 1, min(last_page, len(reader.pages))):
    runs = runs_of(reader.pages[pno])
    if not runs:
        continue

    # ---- locate the header of this page's table -------------------------
    lines = group_lines(runs)
    head = next((l for l in lines if anchor in l["text"]), None)
    if head is None:
        continue
    hy = head["y"]
    af_x = find_text_x(head, anchor) or 0.0
    af_w = len(anchor) * 8.4
    rm_x = find_text_x(head, "重映射功能") or (af_x + 200)
    rm_w = len("重映射功能(2)") * 7.0
    # content is centred inside each cell -> split at the midpoint of centres
    af_center = af_x + af_w / 2
    rm_center = rm_x + rm_w / 2
    split = (af_center + rm_center) / 2

    # column anchors from the header text
    hdr = [l for l in lines if abs(l["y"] - hy) < 40]
    hdr_runs = [r for l in hdr for r in l["runs"]]
    name_x = min((r["x"] for r in hdr_runs if r["t"] == "名称"), default=188.0)
    type_x = min((r["x"] for r in hdr_runs if r["t"] == "类型"), default=name_x + 56)
    lvl_x = min((r["x"] for r in hdr_runs if r["t"] == "I/O"), default=type_x + 42)
    main_x = min((r["x"] for r in hdr_runs if r["t"] == "主功能"), default=lvl_x + 30)

    body = [r for r in runs if r["y"] < hy - 4]
    if not body:
        continue

    # ---- find the pin rows (a run in the name column starting with a pin) --
    name_runs = [
        r for r in body
        if abs(r["x"] - name_x) < 26 and PIN_NAME.match(r["t"])
    ]
    if not name_runs:
        continue
    # one row per y, keep the leftmost run at that y
    by_y = {}
    for r in name_runs:
        by_y.setdefault(round(r["y"], 1), r)
    row_ys = sorted(by_y, reverse=True)          # PDF y grows upwards

    # ---- horizontal bands -------------------------------------------------
    ys_desc = row_ys
    bands = []
    for i, y in enumerate(ys_desc):
        top = (ys_desc[i - 1] + y) / 2 if i > 0 else hy - 2
        bot = (ys_desc[i + 1] + y) / 2 if i + 1 < len(ys_desc) else -1e9
        bands.append((top, bot, by_y[y]))

    for x in (r["x"] for r in body if r["x"] < name_x - 30):
        pkg_pos[round(x)] += 1

    buckets = {i: {"pkg": {}, "name": "", "type": "", "level": "", "main": "",
                   "af": [], "remap": []} for i in range(len(bands))}

    def band_of(y):
        for i, (top, bot, _) in enumerate(bands):
            if bot <= y <= top:
                return i
        return None

    NON_AF = {"I/O", "I/O/A", "FT", "BOOT1", "BOOT0", "SWDIO", "SWCLK", "RST",
              "TAMPER", "RTC", "WKUP", "MCO", "PD0", "PD1", "P", "I", "O", "A"}
    TOKEN = re.compile(r"^[A-Z][A-Za-z0-9_]*$")

    for r in body:
        bi = band_of(r["y"])
        if bi is None:
            continue
        b = buckets[bi]
        x = r["x"]
        t = r["t"]
        if x < name_x - 30:
            b["pkg"].setdefault("cols", []).append((x, t))
        elif abs(x - name_x) < 26:
            b["name"] += t
        elif x < split:
            # the middle band mixes 引脚类型 / I/O 电平 / 主功能 / 默认复用功能.
            # Only real alternate-function tokens survive: single word, long
            # enough, and not a repeat of the pin's own name.
            port = re.sub(r"[^A-Z0-9_]", "", b["name"] or "")
            if (TOKEN.match(t) and len(t) >= 3 and t not in NON_AF
                    and t != port and t not in port):
                b["af"].append(t)
            else:
                b["main"] += t
        else:
            b["remap"].append(t)

    # ---- package column positions for this page ---------------------------
    pcols = cluster([p for p, _ in (c for b in buckets.values() for c in b["pkg"].get("cols", []))], 4.0)
    if len(pcols) > npkg:
        pcols = sorted(pcols)[:npkg]
    while len(pcols) < npkg:
        pcols.append((pcols[-1] if pcols else name_x) - 20)

    for i in range(len(bands)):
        b = buckets[i]
        name = re.sub(r"\(\d+\)", "", b["name"]).strip()
        if not name:
            continue
        pk = {}
        for x, t in b["pkg"].get("cols", []):
            if not re.fullmatch(r"-|\d+", t):
                continue
            ci = min(range(len(pcols)), key=lambda k: abs(pcols[k] - x))
            if abs(pcols[ci] - x) > 5:
                continue
            v = None if t == "-" else int(t)
            if v == 0:
                v = None
            pk[ci] = v
        rows.append({
            "page": pno + 1,
            "pkg": {pkg_ids[k]: pk.get(k) for k in range(npkg)},
            "name": name,
            "type": re.sub(r"\(\d+\)", "", b["type"]).strip(),
            "level": re.sub(r"\(\d+\)", "", b["level"]).strip(),
            "main": re.sub(r"\(\d+\)", "", b["main"]).strip(),
            "af": [t for t in b["af"] if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", t)],
            "remap": [t for t in b["remap"] if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", t)],
        })

json.dump(rows, io.open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(rows)} rows -> {out_path}")
