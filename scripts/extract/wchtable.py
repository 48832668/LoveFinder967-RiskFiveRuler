# -*- coding: utf-8 -*-
"""WCH datasheet pin-table parser (layout-mode pypdf text).

Two things make these tables awkward:

* Cells are vertically centred, so a package pin number can appear on a line of
  its own, one line above the pin name.
* Blank cells emit no token at all, so token *order* cannot recover the column.
  Columns are therefore located by character offset.

Usage:
  python wchtable.py <layout.txt> <start_marker> <end_marker> <n_pkg_cols> \
         <pkg_ids,comma> <out.json>
"""
import io
import json
import re
import sys
from collections import Counter

src, start_m, end_m = sys.argv[1], sys.argv[2], sys.argv[3]
npkg = int(sys.argv[4])
pkg_ids = sys.argv[5].split(",")
out_path = sys.argv[6]

lines = io.open(src, encoding="utf-8").read().split("\n")

lo = hi = None
for i, l in enumerate(lines):
    if lo is None and start_m in l:
        lo = i
    elif lo is not None and end_m in l:
        hi = i
        break
if lo is None:
    raise SystemExit("start marker not found: " + start_m)
if hi is None:
    hi = len(lines)
body = lines[lo:hi]

JUNK_PREFIX = ("引脚", "名称", "编号", "引脚名称", "引脚类型", "默认复用功能", "重映射功能",
               "主功能", "名称", "类型", "（复位", "后）", "电平", "注1", "注2",
               "注3", "注4", "注5", "注6", "注7", "注8", "注9", "注10", "表 2-",
               "表2-", "V2.", "===== PAGE", "第 ", "图 ")
FOOTER = re.compile(r"^\s*V\d+\.\d+\s+\d+\s*$")

PREFIX_FRAG = ("TIM", "USART", "SPI", "I2C", "ADC", "CAN", "OPA", "CMP", "LPTIM")
# 列切片会把短名字从中间切断（SCK -> SC + K），这些是拼回来才算完整的名字
SHORT_NAMES = {"SCK", "SDA", "SCL", "MISO", "MOSI", "NSS", "CS", "RST",
               "MCO", "DIO", "DCK", "UDP", "UDM"}
FULL_TOKEN = re.compile(
    r"^(TX|RX|CK|CTS|RTS|CS|SCK|MISO|MOSI|NSS|SCL|SDA|SMBA|UDP|UDM|DIO|DCK"
    r"|RST|MCO|PIOC_IO\d+|T\dC\dN?|T\dET|T\dBK|C\d[PNO]\d?|O\d[PNO]\d"
    r"|O\dO\d|A\d+)$")
AF_RE = re.compile(r"^(TIM|USART|SPI|I2C|ADC|CAN|OPA|CMP|LPTIM|USB|MCO|RTC|TAMPER)"
                   r"[0-9_]")


def junk(l):
    s = l.strip()
    if not s:
        return True
    if FOOTER.match(l):
        return True
    if "https://wch.cn" in s or "数据手册" in s:
        return True
    return any(s.startswith(j) for j in JUNK_PREFIX)


def clean(s):
    s = s.replace("\u3000", " ")
    s = re.sub(r"\(\d+\)", "", s)
    return s.strip()


def toks(s):
    """Split a table cell into alternate-function tokens.

    Drops Chinese header text and stray punctuation, then re-joins tokens that a
    page break cut in half (``TIM`` + ``2_CH4_1`` -> ``TIM2_CH4_1``).
    """
    raw = [t for t in re.split(r"[/\s]+", clean(s)) if t]
    out = [t for t in raw if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", t)]
    merged, i = [], 0
    while i < len(out):
        t = out[i]
        if i + 1 < len(out):
            cand = t + out[i + 1]
            short = t in PREFIX_FRAG or len(t) <= 2
            if short and AF_RE.match(cand):
                merged.append(cand)
                i += 2
                continue
            if not FULL_TOKEN.match(t) and FULL_TOKEN.match(cand):
                merged.append(cand)
                i += 2
                continue
        merged.append(t)
        i += 1
    return merged


# ---------------------------------------------------------------- pass 1
# Per-page column offsets for the default-AF / remap cells.
page_off = {}
page = 0
for raw in body:
    if raw.startswith("===== PAGE"):
        page = int(re.search(r"PAGE (\d+)", raw).group(1))
        continue
    if "默认复用功能" in raw:
        page_off[page] = (raw.index("默认复用功能"),
                          raw.index("重映射功能") if "重映射功能" in raw else None)

# ---------------------------------------------------------------- pass 2
# Locate the package columns by clustering the start offsets of numeric cells,
# then locate the pin-name column just right of the last package column.
NUMPOS = Counter()
NAMEPOS = Counter()
page = 0
for raw in body:
    if raw.startswith("===== PAGE"):
        page = int(re.search(r"PAGE (\d+)", raw).group(1))
        continue
    if page not in page_off or junk(raw):
        continue
    left = raw[:page_off[page][0]]
    for m in re.finditer(r"(?<!\S)(-|\d+)(?!\S)", left):
        NUMPOS[m.start()] += 1
    for m in re.finditer(r"(?<!\S)([A-Z][A-Z0-9_-]{1,16})(?!\S)", left):
        NAMEPOS[m.start()] += 1


def cluster(pos_counts, k, tol=2):
    pts = sorted(pos_counts)
    if not pts:
        return []
    groups = [[pts[0]]]
    for p in pts[1:]:
        if p - groups[-1][-1] <= tol:
            groups[-1].append(p)
        else:
            groups.append([p])
    groups.sort(key=lambda g: -sum(pos_counts[x] for x in g))
    keep = sorted(groups[:k], key=lambda g: g[0])
    return [round(sum(g) / len(g)) for g in keep]


pkg_cols = cluster(NUMPOS, npkg, tol=2)
right_of = pkg_cols[-1] if pkg_cols else 0
name_cands = [p for p in NAMEPOS if p > right_of]
name_col = min(name_cands) if name_cands else right_of + 5
sys.stderr.write(f"pkg cols at {pkg_cols}, name col at {name_col}\n")


def col_index(start):
    best, bi = 99, -1
    for i, c in enumerate(pkg_cols):
        d = abs(start - c)
        if d < best:
            best, bi = d, i
    return bi if best <= 3 else -1


# ---------------------------------------------------------------- pass 3
rows = []
cur = None
pend_cells = {}
pend_after = []
pend_af = []
pend_remap = []
page = 0
for raw in body:
    if raw.startswith("===== PAGE"):
        page = int(re.search(r"PAGE (\d+)", raw).group(1))
        continue
    if page not in page_off or junk(raw):
        continue
    cAF, cRM = page_off[page]
    left = raw[:cAF]
    mid = raw[cAF:cRM] if cRM else ""
    right = raw[cRM:] if cRM else ""

    cells = {}
    for m in re.finditer(r"(?<!\S)(-|\d+)(?!\S)", left):
        ci = col_index(m.start())
        if ci >= 0:
            v = None if m.group(1) == "-" else int(m.group(1))
            if v == 0:                      # WCH writes 0 for "not bonded out"
                v = None
            cells[ci] = v

    name = None
    after = []
    if name_col < len(left):
        m = re.search(r"(?<!\S)(\S+)(?!\S)", left[name_col:])
        if m:
            name = clean(m.group(1))
            tail = left[name_col + m.start() + len(m.group(1)):]
            after = [clean(t) for t in tail.split() if clean(t)]

    if name and cells:
        merged_cells = dict(pend_cells)
        merged_cells.update({k: v for k, v in cells.items() if v is not None})
        # Cell content is vertically centred, so a tall cell spills onto the
        # lines *above* its own pin row.  Those buffered lines belong to the
        # row we are starting now, not to the previous one.
        cur = {
            "pkg": {pkg_ids[i]: merged_cells.get(i) for i in range(npkg)},
            "name": name,
            "raw": name,
            "type": "", "level": "", "main": "",
            "af": pend_af + toks(mid),
            "remap": pend_remap + toks(right),
        }
        merged_after = pend_after + after
        cur["type"] = merged_after[0] if len(merged_after) > 0 else ""
        cur["level"] = merged_after[1] if len(merged_after) > 1 else ""
        cur["main"] = merged_after[2] if len(merged_after) > 2 else ""
        rows.append(cur)
        pend_cells = {}
        pend_after = []
        pend_af = []
        pend_remap = []
        continue

    # not a row line -> stash cell / attribute fragments for the next row
    pend_cells.update(cells)
    if name and not cells and cur is not None:
        cur["name"] += name          # pin-name cell wrapped onto its own line
    else:
        pend_after += [clean(t) for t in left.split()
                       if clean(t) and not re.fullmatch(r"\d+", clean(t))]
    pend_af += toks(mid)
    pend_remap += toks(right)

json.dump(rows, io.open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(rows)} rows -> {out_path}")
