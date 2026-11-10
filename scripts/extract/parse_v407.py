# -*- coding: utf-8 -*-
"""Parse the CH32V407/V467 pin-definition table out of pypdf's *layout* text.

为什么单独一个脚本：V407 的表有 4 个封装列（QFN32/LQFP64/QFN68/LQFP100），
而 PDF 里同一行的多个数字有时被画进同一个文本 run（`"- 11"`），
按坐标切 run 会把 `11` 算到第一列去。layout 模式保留了列位置，
而且这张表的列位置在整页内非常稳定，所以按 token 流 + 列位判断最稳。

列位（layout 文本里的字符列，实测）：
    pkg1..pkg4 : 0 / 5 / 10 / 15
    引脚名称    : 22 起（可能跨到 41，如 `PC13- TAMPER-RTC（2）`）
    引脚类型    : 34~43（居中，随名称列宽浮动）
    I/O 电平    : 紧随类型
    主功能      : 49~55
    默认复用功能 : 60~73 起
    重映射功能  : 88 起

用法：
  python parse_v407.py <layout.txt> <out.json> <table_start_marker> <table_end_marker>
"""

import io
import json
import re
import sys

src, out_path = sys.argv[1], sys.argv[2]
start_m = sys.argv[3] if len(sys.argv) > 3 else "表 2-1-1 CH32V407"
end_m = sys.argv[4] if len(sys.argv) > 4 else "表 2-1-2 CH32V467"

PKGS = ["KEU6", "RET6", "WEU6", "VET6"]

TYPES = {"I/O", "I/O/A", "I", "O", "A", "I/A", "O/A", "P", "I/O/FT", "I/O/A/FT"}
LEVELS = {"FT", "-", "TTa", "5V", "HS", "FS", "FT,", "FT,HS", "HS,", "FT/HS"}
PIN_NAME = re.compile(
    r"^(?:P[A-E]\d+|VDD|VSS|VDDA|VSSA|VBAT|VREF[+-]|NRST|BOOT0|BOOT1|"
    r"OSC_IN|OSC_OUT|OSC32_IN|OSC32_OUT)"
)
NUM = re.compile(r"^-\d*$|^\d+$")
JUNK = ("引脚编号", "引脚名称", "引脚类型", "默认复用功能", "重映射功能",
        "主功能", "名称", "类型", "电平", "（复位", "后）", "表 2-1-",
        "https://wch.cn", "数据手册", "===== PAGE", "注", "V1.")


def junk(line):
    s = line.strip()
    if not s:
        return True
    if re.fullmatch(r"V\d+\.\d+\s+\d+", s):
        return True
    return any(s.startswith(j) for j in JUNK)


def clean(s):
    s = s.replace("\u3000", " ")
    s = re.sub(r"（\d+）|\(\d+\)", "", s)     # 注标（2）（3）（9）
    return s.strip()


def toks_with_pos(line):
    return [(m.start(), m.group()) for m in re.finditer(r"\S+", line)]


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
body = lines[lo: hi if hi else len(lines)]

rows = []
cur = None
# 跨行缓存：AF 单元格被换行切断时，续行以 `/` 结尾或纯 token 出现
pending_af = []


def flush_pending():
    global pending_af
    if cur is not None and pending_af:
        cur["af"] += pending_af
        pending_af = []


for raw in body:
    if junk(raw):
        continue
    tk = toks_with_pos(raw)
    if not tk:
        continue

    # ---- 新的一行：前 4 个 token 都是 -/数字，第 5 个落在名称列 ----
    # 名称列在 layout 文本里从第 22 列起；PDF 会把 `VREF-`/`VDDA` 这类
    # 拆成 `V` + `REF-`（两个 token），所以不能靠 PIN_NAME 一次性匹配。
    # ---- 行判定：开头的 n 个 -/数字，之后紧跟名称列 ----
    # pkg 列是右对齐的，列位随数字宽度浮动，所以只能按 token 顺序判；
    # 前面几列的 "-" 又常与上一行合并，于是有的行只剩 2~3 个数字。
    is_row = False
    npk = 0
    name_start = None
    for n in (4, 3, 2, 1):
        if len(tk) >= n + 1 and all(NUM.match(clean(t)) for _, t in tk[:n]):
            posn, tn = tk[n]
            cn = clean(tn)
            if 20 <= posn <= 46 and cn not in TYPES and cn not in LEVELS:
                is_row = True
                npk = n
                name_start = posn
                break

    if is_row:
        flush_pending()
        # npk 个数字之前的列都是被合并掉的 "-"
        pk = [None] * (4 - npk) + [
            None if clean(t) in ("-", "0") else int(clean(t)) for _, t in tk[:npk]
        ]
        rest = [(pos, t) for pos, t in tk if pos >= name_start]
        name_parts = []
        idx = 0
        # 名称可能被拆成多个 token：`PC13-`+`TAMPER-RTC`、`V`+`REF-`、`V`+`DDA`
        while idx < len(rest):
            pos, t = rest[idx]
            frag = clean(t)
            if idx > 0 and (pos >= 42 or frag in TYPES or frag in LEVELS):
                break
            name_parts.append(frag)
            idx += 1
        # `PC13-` + `TAMPER` 之间要留连接符；`V` + `REF-` 要直接拼
        name = ""
        for piece in name_parts:
            if name and not name.endswith("-") and piece.startswith(("TAMPER", "OSC32", "WKUP")):
                name += "-"
            name += piece

        typ = lvl = main = ""
        if idx < len(rest) and clean(rest[idx][1]) in TYPES:
            typ = clean(rest[idx][1]); idx += 1
        if idx < len(rest) and clean(rest[idx][1]) in LEVELS:
            lvl = clean(rest[idx][1]); idx += 1
        # 主功能列在 layout 文本的 49..66 之间；电平/类型的残留可能排在它前面，
        # 所以取这一区间里**最后一个** token。
        main_idx = None
        for k in range(idx, len(rest)):
            pos = rest[k][0]
            if 49 <= pos < 67:
                main_idx = k
        if main_idx is not None:
            main = clean(rest[main_idx][1])
            idx = main_idx + 1

        af, remap = [], []
        for pos, t in rest[idx:]:
            c = clean(t)
            if not c:
                continue
            (remap if pos >= 88 else af).append(c)

        cur = {
            "pkg": {PKGS[i]: pk[i] for i in range(4)},
            "name": name, "type": typ, "level": lvl, "main": main,
            "af": af, "remap": remap,
        }
        rows.append(cur)
        continue

    # ---- 续行：把这一行的 token 归到当前行的 AF/重映射 ----
    if cur is None:
        continue
    for pos, t in tk:
        c = clean(t)
        if not c:
            continue
        if c in TYPES or c in LEVELS:
            continue
        (cur["remap"] if pos >= 88 else cur["af"]).extend(
            pending_af if False else []
        )
        if pos >= 88:
            cur["remap"].append(c)
        else:
            cur["af"].append(c)

# ---- 收尾：拆 token、去碎片、去重 ----
SPLIT = re.compile(r"[/\s]+")
AF_TOKEN = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")

for r in rows:
    def split_tokens(seq):
        out = []
        for chunk in seq:
            for piece in SPLIT.split(chunk):
                piece = piece.strip("_")
                if AF_TOKEN.match(piece) and len(piece) >= 3:
                    out.append(piece)
        return out

    r["af"] = list(dict.fromkeys(split_tokens(r["af"])))
    r["remap"] = list(dict.fromkeys(split_tokens(r["remap"])))
    r["name"] = r["name"].strip()
    # 名称里混进来的类型串（PC13-TAMPER-I/O）
    r["name"] = re.sub(r"(I/O/A|I/O|[IOAP])$", "", r["name"]) or r["name"]

# ---- 补缺号 ------------------------------------------------------------
# 个别行（如 PB6）在 PDF 里把注标 `（12）` 挤进了引脚号列，导致某一列的号
# 读不到。用「前后两行的号相差 2 -> 中间缺的就是它」来补，比硬编码稳。
for key in PKGS:
    seq = [r["pkg"].get(key) for r in rows]
    for i in range(1, len(seq) - 1):
        if seq[i] is None and seq[i - 1] is not None and seq[i + 1] is not None:
            if seq[i + 1] - seq[i - 1] == 2:
                rows[i]["pkg"][key] = seq[i - 1] + 1
                seq[i] = rows[i]["pkg"][key]

json.dump(rows, io.open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(rows)} rows -> {out_path}")
