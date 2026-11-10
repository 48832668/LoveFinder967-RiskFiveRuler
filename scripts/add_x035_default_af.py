# -*- coding: utf-8 -*-
"""从 CH32X035DS0 表2-1 补齐复用功能（按引脚逐行）。

为什么需要它：X035 的组号原本是从表2-3（引脚复用矩阵）提取的，
但那次提取**丢了「默认复用功能」整列** —— 于是 `PB11` 只记了 `RX1_2`（组 2），
没记默认的 `RX1`（组 0）。界面按重映射组分配时，组 0 就只剩 TX 没有 RX，
USART1 被判定「凑不成一套引脚」。组校验的 21 条警告全是这一个原因。

表2-1 是**按引脚**列的，一行给出该脚的全部复用项：
    <各封装引脚号>  PORT[(注)]  I/O[类型]  PORT  <默认复用>  <重映射>
带 `_N` 后缀的进组 N，不带的是组 0（复位默认，不用动 AFIO）。

策略：**只增不删**。表2-1 与表2-3 有个别出入（PC7 的 I2C 只在表2-3 里），
取并集最安全。另外只收「外设真的声明了这个信号」的条目 —— 否则引脚菜单里
会冒出点了没反应的功能。

用法：
    python scripts/add_x035_default_af.py                        # X035，只报告
    python scripts/add_x035_default_af.py --write                # X035，写回
    python scripts/add_x035_default_af.py <data.json> --existing-only --write   # X033 这类子集
"""
import json
import re
import sys
from collections import defaultdict

# X033 与 X035 同 die、共用表2-1；它的 ports 只列本封装引出的脚，
# 所以给它跑的时候要加 --existing-only，免得把 X035 独有的端口塞进来。
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
DATA = ARGS[0] if ARGS else "src/devices/data/ch32x035.json"
TABLE = ".tmp/x035_table21.txt"
WRITE = "--write" in sys.argv
EXISTING_ONLY = "--existing-only" in sys.argv

# 数据手册 2.1 节图例的缩写 → 本项目信号名
EXPAND = [
    (r"^T(\d)C(\d)(N?)$", lambda m: f"TIM{m.group(1)}_CH{m.group(2)}{m.group(3)}"),
    (r"^T(\d)ET$", lambda m: f"TIM{m.group(1)}_ETR"),
    (r"^T(\d)BK$", lambda m: f"TIM{m.group(1)}_BKIN"),
    (r"^TX(\d)$", lambda m: f"USART{m.group(1)}_TX"),
    (r"^RX(\d)$", lambda m: f"USART{m.group(1)}_RX"),
    (r"^CK(\d)$", lambda m: f"USART{m.group(1)}_CK"),
    (r"^CTS(\d)$", lambda m: f"USART{m.group(1)}_CTS"),
    (r"^RTS(\d)$", lambda m: f"USART{m.group(1)}_RTS"),
    (r"^A(\d+)$", lambda m: f"ADC1_IN{m.group(1)}"),
    (r"^C(\d)P(\d)$", lambda m: f"CMP{m.group(1)}_P{m.group(2)}"),
    (r"^C(\d)N(\d)$", lambda m: f"CMP{m.group(1)}_N{m.group(2)}"),
    (r"^C(\d)O$", lambda m: f"CMP{m.group(1)}_OUT"),
    (r"^O(\d)P(\d)$", lambda m: f"OPA{m.group(1)}_P{m.group(2)}"),
    (r"^O(\d)N(\d)$", lambda m: f"OPA{m.group(1)}_N{m.group(2)}"),
    (r"^O(\d)O(\d)$", lambda m: f"OPA{m.group(1)}_OUT{m.group(2)}"),
    (r"^SCL$", lambda m: "I2C1_SCL"),
    (r"^SDA$", lambda m: "I2C1_SDA"),
    (r"^SMBA$", lambda m: "I2C1_SMBA"),
    (r"^MOSI$", lambda m: "SPI1_MOSI"),
    (r"^MISO$", lambda m: "SPI1_MISO"),
    (r"^SCK$", lambda m: "SPI1_SCK"),
    (r"^(CS|NSS)$", lambda m: "SPI1_NSS"),
    (r"^UDM$", lambda m: "USB1_DM"),
    (r"^UDP$", lambda m: "USB1_DP"),
    (r"^CC1$", lambda m: "USBPD_CC1"),
    (r"^CC2$", lambda m: "USBPD_CC2"),
    (r"^DIO$", lambda m: "SYSTEM_SWDIO"),
    (r"^DCK$", lambda m: "SYSTEM_SWCLK"),
    (r"^PIOC_IO(\d+)$", lambda m: f"PIOC_IO{m.group(1)}"),
]

SKIP = {"MCO", "RST", "TKEY"}


def expand(tok):
    for pat, fn in EXPAND:
        m = re.match(pat, tok)
        if m:
            return fn(m)
    return None


def parse_rows(text):
    """扁平化后按 `PORT I/O.. PORT` 表头切行，返回 [(port, [token])]"""
    # 只取表2-1 本体：脚注「注1：」之后是别的内容（含表2-3 的矩阵），
    # 不切掉会让最后一行的 range 一路吞到文末
    cut = text.find("注1：")
    if cut > 0:
        text = text[:cut]
    flat = re.sub(r"\s+", " ", text).replace("\u3000", " ")
    flat = re.sub(r"\(\d+\)", " ", flat)          # 脚注号，不是组号
    heads = list(re.finditer(r"(P[A-D]\d+)\s+I/O[A-Za-z/]*\s+\1\b", flat))
    rows = []
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(flat)
        chunk = flat[m.end():end]
        # 只保留「像复用项」的记号：以字母开头、只含大写字母数字下划线
        toks = []
        for raw in re.split(r"[\s/]+", chunk):
            t = raw.strip()
            if not t or not re.match(r"^[A-Z][A-Z0-9_]*$", t):
                continue
            toks.append(t)
        rows.append((m.group(1), toks))
    return rows


def split_default_remap(tokens):
    dft, remap = [], []
    for t in tokens:
        if re.search(r"_\d+$", t):
            remap.append(t)
        else:
            dft.append(t)
    return dft, remap


def main():
    text = open(TABLE, encoding="utf-8").read()
    rows = parse_rows(text)
    print(f"表2-1 解析到 {len(rows)} 行")

    data = json.load(open(DATA, encoding="utf-8"))
    ports = data["ports"]
    # 该系列真正声明过的信号（外设 signals 的并集），避免收进「点了没反应」的功能
    known = set()
    for per in data["peripherals"]:
        for s in per["signals"]:
            known.add(f"{per['id']}_{s}")

    unknown_tok = defaultdict(set)
    not_modeled = defaultdict(set)
    added_default = defaultdict(list)
    added_remap = defaultdict(list)

    for port, toks in rows:
        dft, remap = split_default_remap(toks)
        have = {(e["fn"], str(e.get("remap", ""))) for e in ports.get(port, [])}

        for t in dft + remap:
            base = t.rsplit("_", 1)[0] if re.search(r"_\d+$", t) else t
            num = t.rsplit("_", 1)[1] if re.search(r"_\d+$", t) else ""
            if base in SKIP:
                continue
            fn = expand(base)
            if not fn:
                unknown_tok[port].add(t)
                continue
            if fn not in known:
                not_modeled[port].add(f"{t}→{fn}")
                continue
            if (fn, num) in have:
                continue
            have.add((fn, num))
            if EXISTING_ONLY and port not in ports:
                continue
            entry = {"fn": fn} if not num else {"fn": fn, "remap": num}
            ports.setdefault(port, []).append(entry)
            (added_default if not num else added_remap)[port].append(fn + (f"[{num}]" if num else ""))

    print(f"\n补入组 0（默认复用）：{sum(len(v) for v in added_default.values())} 条")
    for p in sorted(added_default):
        print(f"   {p}: {', '.join(added_default[p])}")
    print(f"\n补入重映射组：{sum(len(v) for v in added_remap.values())} 条")
    for p in sorted(added_remap):
        print(f"   {p}: {', '.join(added_remap[p])}")
    if unknown_tok:
        print("\n未识别的缩写（跳过，需人工确认）：")
        for p, ts in sorted(unknown_tok.items()):
            print(f"   {p}: {', '.join(sorted(ts))}")
    if not_modeled:
        print("\n外设未声明的信号（跳过，属于建模缺口而非抄表问题）：")
        for p, ts in sorted(not_modeled.items()):
            print(f"   {p}: {', '.join(sorted(ts))}")

    if WRITE:
        data["pending"] = [x for x in data.get("pending", []) if "复用功能表由 PDF 自动提取" not in x]
        data["pending"].append(
            "复用功能 = DS0 表2-3（矩阵，提供组号）∪ 表2-1（按引脚，提供默认复用列），"
            "后者由 scripts/add_x035_default_af.py 补入；两表个别出入按并集处理"
        )
        json.dump(data, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n已写回 {DATA}")
    else:
        print("\n（只报告模式；加 --write 才会写回）")


if __name__ == "__main__":
    main()
