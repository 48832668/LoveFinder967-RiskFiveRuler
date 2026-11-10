"""按 CH32V407DS0 表2-1-1 + RM 10.2.11 重映射总表重建 V407 器件包。

用法：
    python scripts/rebuild_v407_from_ds.py docs/ch32v407-pin-table.md

V407 这份表比 L103 那份多一层信息：除了每行引脚的复用列，末尾还有
「复用重映射配置组总表」（来自 RM 10.2.11 的 AFIO_PCFR1/PCFR2）。
两边都解析、取并集：

  * 引脚行  → 每个封装到底引出了哪些脚（唯一权威）
  * 配置组表 → 每个信号在哪个配置组下落到哪个脚（完整、含默认组重复项）

只靠引脚行会漏掉「默认组也出现在重映射列」的写法，只靠配置组表则不知道封装引出情况。
"""
import json
import re
import sys

DATA = "src/devices/data/ch32v407.json"

# 引脚表里的信号名 → 器件包里的 <实例>_<信号>
RENAME = {
    "ADC_IN": "ADC1_IN",
    "I2C_SCL": "I2C1_SCL",
    "I2C_SDA": "I2C1_SDA",
    "I2C_SMBA": "I2C1_SMBA",
    "I3C_SCL": "I3C1_SCL",
    "I3C_SDA": "I3C1_SDA",
    "CAN_TX": "CAN1_TX",
    "CAN_RX": "CAN1_RX",
    "OPA_OUT": "OPA1_OUT",
    "OPA_P": "OPA1_P",
    "OPA_N": "OPA1_N",
}
# 不建模成外设信号（没有可配置意义，或者只是复位脚名）
IGNORED = {
    "", "—", "-", "BOOT0", "BOOT1", "TAMPER-RTC", "TAMPER", "RTC", "WKUP",
    "LED0", "LED1", "PD0", "PD1", "SWIO",
}
RESERVED_PINS = {"VDD", "VSS", "VDDK", "VDDA", "VSSA", "VBAT", "VREF+", "VREF-", "VREF"}
ETH_PINS = {"MDIRN", "MDIRP", "MDITN", "MDITP"}

PKG_ORDER = ["KEU6", "RET6", "WEU6", "VET6"]


def clean(text: str) -> str:
    """去掉 DS0 的脚注标记：（注4）、（5）、(11)、以及夹在名字里的全角括号说明。"""
    t = text.replace("（注", "(").replace("注", "")
    t = re.sub(r"[(（]\s*\d+\s*[)）]", "", t)
    t = t.replace("(", "（").replace(")", "）")
    return t.strip()


def af_tokens(fn: str) -> list[str]:
    """`ADC_IN10` 之类要按前缀换成带实例名的写法；一个 token 只产出一个信号。"""
    fn = clean(fn).strip()
    if fn in IGNORED:
        return []
    for pre, rep in RENAME.items():
        if fn == pre:
            return [rep]
        if fn.startswith(pre) and fn[len(pre):].isdigit():
            return [rep + fn[len(pre):]]
    if fn.startswith("OSC32_"):
        return [fn]          # OSC32_IN / OSC32_OUT
    if fn in ("SWDIO", "SWCLK"):
        return ["DBG_" + fn]
    return [fn]


def pin_name_of(raw: str) -> str:
    """PA0-WKUP → PA0；PB2（5） → PB2；PD0（4） → PD0。"""
    n = clean(raw)
    n = re.split(r"[-（）]", n)[0].strip()
    return n


def parse_af(af: str) -> tuple[list[str], list[tuple[str, int]]]:
    """→ (默认组信号, [(信号, 配置组)])

    默认段里也可能带方括号（PE9 的 `TIM1_CH1[11]`），所以两段都认方括号。
    """
    af = af.strip()
    if af in ("—", "-", ""):
        return [], []
    default_part, _, remap_part = af.partition("；")
    remap_part = remap_part.replace("重映射：", "").replace("重映射:", "")
    defaults, remaps = [], []

    for part, is_remap in ((default_part, False), (remap_part, True)):
        for item in re.split(r"[，,]", part):
            # 先清掉（注10）这类脚注，否则 `TIM2_ETR[10]（注10）` 匹配不上方括号
            item = clean(item)
            if not item:
                continue
            m = re.fullmatch(r"(.+?)\[([01x]+)\]", item)
            if m:
                g = int(m.group(2).replace("x", "1"), 2)
                for fn in af_tokens(m.group(1)):
                    remaps.append((fn, g))
            elif is_remap:
                # 重映射段里没写方括号的只有 `PD0（注4）` 这种，af_tokens 会丢掉
                for fn in af_tokens(item):
                    remaps.append((fn, 1))
            else:
                defaults += af_tokens(item)
    return defaults, remaps


def table_signal(table: str, sig: str) -> list[str]:
    """配置组表的一行 → 器件包里的信号名（可能一拆多）。

    * `TIM2` 表的 `ETR/CH1` 一行代表两个信号共用同一列 → TIM2_ETR + TIM2_CH1
    * `SPI3 / I2S3` 表两列名 + `NSS/WS` 这种行按位置配对 → SPI3_NSS + I2S3_WS
    * `MCK` 只属于 I2S，别塞给 SPI3
    """
    owners = [t.strip() for t in table.split("/") if t.strip()]
    parts = [p.strip() for p in sig.split("/") if p.strip()]
    if len(owners) > 1 and len(parts) == len(owners):
        raw = [f"{o}_{p}" for o, p in zip(owners, parts)]
    elif len(owners) > 1:
        if parts[0] == "MCK":
            raw = [f"{o}_MCK" for o in owners if o.startswith("I2S")]
        else:
            raw = [f"{owners[0]}_{parts[0]}"]
    else:
        raw = [f"{owners[0]}_{p}" for p in parts]
    # 组装出来的名字还要过一遍 RENAME（`I2C_SCL` → `I2C1_SCL`、`ADC_IN10` → `ADC1_IN10`）
    out = []
    for name in raw:
        out += af_tokens(name) or [name]
    return out


def parse_md(md: str):
    """→ (packages, ports, groups)"""
    pkgs, groups = {}, {}
    section = None      # 引脚表所属封装
    in_group_tables = False
    cur_table = None    # 当前正在解析的配置组表
    table_cols = []

    for raw in md.splitlines():
        line = raw.strip()

        if line.startswith("## "):
            title = line[3:].strip()
            m = re.match(r"^([A-Z0-9]+)\s*[（(]([A-Z0-9]+)[）)]", title)
            if m:
                section = m.group(1)
                pkgs.setdefault(section, {"id": "CH32V407" + m.group(1), "label": m.group(2), "rows": []})
                in_group_tables = False
                cur_table = None
            elif "复用重映射" in title:
                section = None
                in_group_tables = True
            else:
                section, in_group_tables, cur_table = None, False, None
            continue

        if in_group_tables and line.startswith("### "):
            cur_table = clean(line[4:]).split("（")[0].split("(")[0].strip()
            groups.setdefault(cur_table, {})
            table_cols = []
            continue

        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or set(cells[0]) <= set("- "):
            continue

        # ── 配置组总表 ──
        if in_group_tables and cur_table:
            if cells[0] in ("功能", "寄存器位"):
                # 列头会带说明文字（`00 默认`、`00（默认）`），只取前面的二进制位宽
                table_cols = [re.match(r"[01x]+", c.strip()).group(0) if re.match(r"[01x]+", c.strip()) else c
                              for c in cells[1:]]
                continue
            if not table_cols or cells[0].startswith("PCFR"):
                continue
            sig = cells[0]
            for col, cell in zip(table_cols, cells[1:]):
                if cell in ("—", "-", ""):
                    continue
                # 列头可能是 00/01/10/11/0/1/1x
                if not re.fullmatch(r"[01x]+", col):
                    continue
                # `1x` 表示 10/11 两组共享这一格，展开成 [2, 3]
                want = [int(col.replace("x", b), 2) for b in ("0", "1")] if "x" in col else [int(col, 2)]
                for pin in [p.strip() for p in re.split(r"[，,]", cell) if p.strip()]:
                    host = pin_name_of(pin)
                    for fn in table_signal(cur_table, sig):
                        groups[cur_table].setdefault((fn, host), set()).update(want)
            continue

        # ── 引脚定义表 ──
        if section is None or len(cells) < 6:
            continue
        if not re.fullmatch(r"[\d/]+", cells[0]):
            continue
        num_cell, name_raw, typ, _lvl, main, af = cells[:6]
        pname = pin_name_of(name_raw)
        if not typ.startswith("I/O"):
            af = "—"      # 电源/ETH 行的第 6 列是说明文字（如「主V DD」），不是复用功能
        for num in [int(x) for x in num_cell.split("/") if x.strip().isdigit()]:
            pkgs[section]["rows"].append(
                {"num": num, "name": pname, "type": typ, "main": clean(main), "af": af}
            )
    return pkgs, groups


def pin_kind(pname: str, typ: str, main: str) -> str:
    if pname.startswith("OSC"):
        return "osc"
    if typ.startswith("ETH") or pname in ETH_PINS:
        return "power"
    if typ.startswith("I/O"):
        return "io"
    if pname.startswith("NRST"):
        return "reset"
    if pname.startswith("BOOT"):
        return "boot"
    return "power"


def build(md: str, data: dict):
    pkgs, groups = parse_md(md)

    # ① ports：引脚行的复用列
    ports: dict[str, list] = {}
    for key, pkg in pkgs.items():
        for row in pkg["rows"]:
            host = row["name"]
            defaults, remaps = parse_af(row["af"])
            for fn in defaults:
                e = {"fn": fn}
                if e not in ports.setdefault(host, []):
                    ports[host].append(e)
            for fn, g in remaps:
                e = {"fn": fn, "remap": str(g)}
                if e not in ports.setdefault(host, []):
                    ports[host].append(e)
            # 复位主功能里的时钟/调试脚
            for fn in af_tokens(row["main"].split("/")[0]):
                if fn.split("_")[0] in ("CLK", "DBG", "OSC32"):
                    e = {"fn": fn}
                    if e not in ports.setdefault(host, []):
                        ports[host].insert(0, e)

    # ② ports：配置组总表（更完整，且组号来自 RM）
    for table, mapping in groups.items():
        for (fn, host), gset in mapping.items():
            lst = ports.setdefault(host, [])
            for g in sorted(gset):
                e = {"fn": fn} if g == 0 else {"fn": fn, "remap": str(g)}
                if e not in lst:
                    lst.append(e)

    # ③ packages
    packages = []
    for key in PKG_ORDER:
        pkg = pkgs[key]
        total = int(re.sub(r"\D", "", pkg["label"]))
        by_num = {}
        for row in pkg["rows"]:
            by_num.setdefault(row["num"], []).append(row)

        pins = []
        for num in sorted(by_num):
            rows = by_num[num]
            primary = rows[0]
            pname = primary["name"]
            pin = {
                "num": num,
                "name": pname,
                "kind": pin_kind(pname, primary["type"], primary["main"]),
            }
            others = [p for p in (pin_name_of(r["name"]) for r in rows[1:]) if p != pname]
            if others:
                pin["aliases"] = sorted(set(others))
                pin["note"] = "与 " + "、".join(pin["aliases"]) + " 合封到同一个物理引脚（禁止同时配成输出）"
            if pname in ETH_PINS:
                pin["note"] = "以太网 PHY 内部差分对，不引出到外部"
            pins.append(pin)

        # 表里漏掉的脚（KEU6 的 16）补成电源脚，否则画布会缺一格
        have = {p["num"] for p in pins}
        for n in range(1, total + 1):
            if n in have:
                continue
            pins.append(
                {"num": n, "name": "VDD", "kind": "power", "note": "原表未列出该脚，按 QFN/LQFP 电源脚补齐（待核）"}
            )
            print(f"  !! {pkg['id']} 表里缺 pin {n}，已按 VDD 补齐")
        pins.sort(key=lambda p: p["num"])
        packages.append({"id": pkg["id"], "label": pkg["label"], "shape": "quad", "pins": pins})

    return packages, ports


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "docs/ch32v407-pin-table.md"
    md = open(src, encoding="utf-8").read()
    data = json.load(open(DATA, encoding="utf-8"))

    packages, ports = build(md, data)
    data["packages"] = packages
    data["ports"] = {k: v for k, v in sorted(ports.items())}

    # ④ 外设声明的信号表跟着补齐（表里出现的信号才算数）
    found = {}
    for arr in ports.values():
        for e in arr:
            owner = e["fn"].split("_")[0]
            found.setdefault(owner, set()).add(e["fn"][len(owner) + 1:])
    for per in data["peripherals"]:
        extra = sorted(found.get(per["id"], set()) - set(per["signals"]))
        if extra:
            print(f"  ++ {per['id']} 补信号: {' '.join(extra)}")
            per["signals"] = sorted(set(per["signals"]) | set(extra))

    # ⑤ 同封装内「同一信号 + 同一配置组」落到两个引脚 → 源表自相矛盾，写进 pending
    conflicts = []
    for pkg in packages:
        names = set()
        for pin in pkg["pins"]:
            names.add(pin["name"])
            names.update(pin.get("aliases") or [])
        seen = {}
        for host, arr in ports.items():
            if host not in names:
                continue
            for e in arr:
                seen.setdefault((e["fn"], int(e.get("remap", 0))), set()).add(host)
        for (fn, g), hosts in sorted(seen.items()):
            if len(hosts) > 1:
                conflicts.append((pkg["id"], fn, g, sorted(hosts)))
    # 去重成「信号 + 组」维度（同一矛盾会出现在多个封装里）
    uniq = sorted({(fn, g, tuple(h)) for _, fn, g, h in conflicts})
    print(f"  配置组冲突 {len(conflicts)} 处（{len(uniq)} 种）")
    for fn, g, hosts in uniq:
        print(f"    ! {fn} 组{g} → {' / '.join(hosts)}")

    data["packVersion"] = "0.2.0"
    data["source"] = (
        "CH32V407DS0 V1.4 表2-1-1（各封装引脚定义）+ CH32V407RM V1.3 10.2.11"
        "（AFIO_PCFR1/PCFR2 复用重映射总表）"
    )
    data["pending"] = [
        "packages/ports 由 scripts/rebuild_v407_from_ds.py 从 DS0 表2-1-1 + RM 10.2.11 自动生成；"
        "remap 字段 = AFIO 配置组编号（00/01/10/11 → 0/1/2/3）",
        "OSC_IN/OSC_OUT 可经 AFIO 改作 PD0/PD1（DS0 注4），这一层复用没有建模 —— "
        "GPIO 目前只按引脚名配，没有「PD0 借用 OSC_IN 脚」的入口",
        "DS0 注6/7：SDIO_D0/D1、DVP_D5、FSMC_NADV 有「ETH/SDIO/USB 同时开启时自动改脚」的条件重映射，尚未建模",
        "KEU6（QFN32）的 pin 16 在引脚表里没有对应行，已按 VDD 补齐，需对照 DS0 引脚排列图确认",
        "TIM8_CH1N/CH2N/CH3N 在组1 落到 PA13/PA14/PA15，与 2 线调试口冲突（硬件事实，不是数据错）",
        "源表缺这几条复用项，对应外设因此进「器件数据待补」（外设树底部琥珀色那行），需从 DS0 补："
        "SPI2_MOSI（疑与 I2S2_SD 同脚 PB15）、USBHS1_DM（USBHS1 只列了 DP=PA12）、DAC2 全部输出",
        "源表内部矛盾（同一信号的同一配置组落到两个引脚），下列条目以「两者都保留」处理，"
        "配置组编号需回查 DS0 原表：" + "；".join(f"{fn} 组{g}={'/'.join(h)}" for fn, g, h in uniq),
        "ETH / LTDC / DVP / FSMC / SDIO / ARGB / I3C / USBHS 只生成时钟使能 + TODO，参数建模待补",
        "DMA 通道 ↔ 硬件请求映射待从 RM「DMA 请求映射」补录；当前只校验通道不重复",
    ]

    json.dump(data, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    for pkg in packages:
        io = sum(1 for p in pkg["pins"] if p["kind"] == "io")
        nums = [p["num"] for p in pkg["pins"]]
        gaps = [n for n in range(1, int(re.sub(r"\D", "", pkg["label"])) + 1) if n not in nums]
        print(
            f"  {pkg['id']:<15} {pkg['label']:<8} 引脚 {len(pkg['pins']):>3}  GPIO {io:>3}  "
            f"缺口 {gaps or '无'}"
        )
    print(f"端口 {len(ports)} 个，功能条目 {sum(len(v) for v in ports.values())} 条")


if __name__ == "__main__":
    main()
