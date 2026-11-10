# -*- coding: utf-8 -*-
"""Parse the CH32L103 pin-definition table out of layout-mode pypdf text."""
import re, json, sys, io

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/l103L.txt"
PKGS = ["F8P6", "F8U6", "G8R6", "K8U", "C8T6"]

text = io.open(SRC, encoding="utf-8").read()
lines = text.split("\n")

cAF = cRM = None
rows = []          # list of dict
cur = None
page = 0

ROW_RE = re.compile(r"^\s*((?:-|\d+)\s+){4}(-|\d+)\s+(.*)$")

def clean(s):
    s = s.replace("\u3000", " ")
    s = re.sub(r"\(\d+\)", "", s)          # footnote markers (1)..(10)
    return s.strip()

def toks(s):
    s = clean(s)
    if not s:
        return []
    return [t for t in re.split(r"[/\s]+", s) if t]

for raw in lines:
    if raw.startswith("===== PAGE"):
        page = int(re.search(r"PAGE (\d+)", raw).group(1))
        cAF = cRM = None
        continue
    if "默认复用功能" in raw and "重映射功能" in raw:
        cAF = raw.index("默认复用功能")
        cRM = raw.index("重映射功能")
        continue
    if "默认复用功能" in raw and cRM is not None:
        cAF = raw.index("默认复用功能")
        continue
    if cAF is None:
        continue
    if "引脚定义" in raw or "引脚编号" in raw or "CH32L103" in raw and "https" in raw:
        continue
    left = raw[:cAF] if cAF else raw
    mid = raw[cAF:cRM] if (cAF is not None and cRM) else ""
    right = raw[cRM:] if cRM else ""

    m = ROW_RE.match(left)
    if m:
        cols = re.findall(r"-|\d+", left[: left.index(m.group(3)) if m.group(3) else len(left)])
        # safer: take the 5 leading package cells
        head = left.split()
        pk = head[:5]
        rest = head[5:]
        name = rest[0] if rest else ""
        typ = rest[1] if len(rest) > 1 else ""
        lvl = rest[2] if len(rest) > 2 else ""
        main = rest[3] if len(rest) > 3 else ""
        cur = {
            "page": page, "pin": {PKGS[i]: (None if pk[i] == "-" else int(pk[i])) for i in range(5)},
            "name": clean(name), "type": clean(typ), "level": clean(lvl), "main": clean(main),
            "af": toks(mid), "remap": toks(right), "_nameCont": rest[4:] if len(rest) > 4 else [],
        }
        rows.append(cur)
        continue
    if cur is None:
        continue
    # continuation line: name fragments only in left column
    lefttoks = [t for t in clean(left).split() if t]
    if lefttoks and len(lefttoks) <= 3 and not lefttoks[0].isdigit():
        cur["name"] += "".join(lefttoks)
    cur["af"] += toks(mid)
    cur["remap"] += toks(right)

# merge: name fragments that were captured in the name continuation
out = []
for r in rows:
    r.pop("_nameCont", None)
    r["name"] = r["name"].replace("-", "-")
    out.append(r)

print(json.dumps(out, ensure_ascii=False, indent=1))
