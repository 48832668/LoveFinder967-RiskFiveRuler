"""按 CH32L103DS0 表2-1-1（各封装引脚定义表）重建 L103 器件包的 packages + ports。

输入：`CH32L103_各封装引脚表.md`（每行一个引脚，最后一列是「默认复用；重映射[配置位]」）
输出：就地更新 `src/devices/data/ch32l103.json`

为什么要脚本：引脚表 200 多行，手抄一定会错；而且这张表带精确的 AFIO 配置值
（`USART3_TX[11]` 就是 3，不是「第 2 个重映射」），必须按值写进 remap，
否则引脚菜单的 ⟲n 角标会和手册对不上。

用法：
    python scripts/rebuild_l103_from_ds.py <引脚表.md>
"""
import json
import re
import sys

DATA = "src/devices/data/ch32l103.json"

# 引脚表里那些「不是外设复用功能」的条目：时钟引脚、调试口、杂项
CLOCK_MAIN = {
    "OSC_IN": "CLK_HSE_IN",
    "OSC_OUT": "CLK_HSE_OUT",
    "OSC32_IN": "CLK_LSE_IN",
    "OSC32_OUT": "CLK_LSE_OUT",
}
DEBUG_MAIN = {"SWDIO": "DBG_SWDIO", "SWCLK": "DBG_SWCLK"}
# 表里出现但不建模的功能：直接丢掉，免得引脚菜单点上去没反应
IGNORED_FN = {"WKUP", "TAMPER", "RTC", "MCO", "NRST", "BOOT0", "BOOT1"}


def norm_fns(raw: str) -> list[str]:
    """把表里的一格功能名展开成我们自己的信号名（可能一拆多）。"""
    raw = raw.strip()
    if not raw or raw in ("—", "-"):
        return []
    if raw in IGNORED_FN:
        return []
    if raw in CLOCK_MAIN:
        return [CLOCK_MAIN[raw]]
    if raw in DEBUG_MAIN:
        return [DEBUG_MAIN[raw]]

    # ADC_INn -> ADC1_INn（表里省了实例号）
    m = re.fullmatch(r"ADC_IN(\d+)", raw)
    if m:
        return [f"ADC1_IN{m.group(1)}"]

    if raw == "USBDM":
        return ["USB1_DM"]
    if raw == "USBDP":
        return ["USB1_DP"]
    if raw in ("CC1", "CC2"):
        return [f"USBPD_{raw}"]

    # OPA 在表里写 OPA_O0 / OPA_P4 / OPA_N4，我们的信号名是 OPA1_OUT0 / OPA1_P4 / OPA1_N4
    m = re.fullmatch(r"OPA_([PNO])(\d+)", raw)
    if m:
        kind = {"P": "P", "N": "N", "O": "OUT"}[m.group(1)]
        return [f"OPA1_{kind}{m.group(2)}"]

    # TIM2_CH1_ETR 是「CH1 与 ETR 共用一个复用位」，拆成两条信号
    m = re.fullmatch(r"(TIM\d)_CH(\d)_ETR", raw)
    if m:
        return [f"{m.group(1)}_CH{m.group(2)}", f"{m.group(1)}_ETR"]

    return [raw]


def parse_table(md: str):
    """→ {封装 id: {...}}，以及电源引脚表"""
    pkgs = {}
    power_rows = {}
    section = None
    for line in md.splitlines():
        line = line.strip()
        h = re.match(r"^##\s+(?:([A-Z0-9]+)\s*[（(]([A-Z0-9]+)[）)])?\s*$", line)
        if line.startswith("## "):
            title = line[3:].strip()
            m = re.match(r"^([A-Z0-9]+)\s*[（(]([A-Z0-9]+)[）)]", title)
            if m:
                section = m.group(1)
                pkgs.setdefault(
                    section,
                    {"id": f"CH32L103{m.group(1)}", "label": m.group(2), "rows": []},
                )
            else:
                section = None
            continue
        if not line.startswith("|"):
            continue

        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 6:
            continue
        # 电源/复位/启动汇总表：| VDD | 24/36/48 | 1 | 6 | 19 | 16 |
        if cells[0] in ("VDD", "VSS", "VBAT", "VDDA", "VSSA", "NRST", "BOOT0"):
            power_rows[cells[0]] = cells[1:]
            continue
        if section is None:
            continue
        num, name, typ, _lvl, main, af = cells[:6]
        if not num.isdigit():
            continue
        pkgs[section]["rows"].append(
            {"num": int(num), "name": name, "type": typ, "main": main, "af": af}
        )
    return pkgs, power_rows


def base_name(name: str) -> str:
    """PA0-WKUP → PA0；PB2(BOOT1) → PB2；OSC_IN(PD0) → OSC_IN；PC13-TAMPER-RTC → PC13"""
    n = re.split(r"[-()]", name)[0].strip()
    return n


def pin_kind(name: str, typ: str) -> str:
    if typ.startswith("I/O"):
        return "io"
    b = base_name(name)
    if b.startswith("NRST"):
        return "reset"
    if b.startswith("BOOT"):
        return "boot"
    return "power"


def af_entries(af: str) -> list[dict]:
    """`A，B；C[010]，D[011]` → [{fn:A},{fn:B},{fn:C,remap:'2'},{fn:D,remap:'3'}]

    注意：有些格子**整格都是重映射项**、没有分号（如 OSC_IN 的
    `USART3_TX[11]，USART3_RX[10]，CAN1_RX[11]`），所以两段都要认方括号。
    """
    if af.strip() in ("—", "-", ""):
        return []
    default_part, _, remap_part = af.partition("；")
    out = []
    for part in (default_part, remap_part):
        for item in re.split(r"[，,]", part):
            item = item.strip()
            if not item:
                continue
            m = re.fullmatch(r"(.+?)\[([01]+)\]", item)
            if m:
                val = int(m.group(2), 2)
                for fn in norm_fns(m.group(1)):
                    out.append({"fn": fn} if val == 0 else {"fn": fn, "remap": str(val)})
            else:
                for fn in norm_fns(item):
                    out.append({"fn": fn})
    return out


# 合封说明（表末「封装内部短接」一节）。这张表比引脚行可靠：
# 引脚行偶尔只写其中一个端口（G8R6 的 pin 28 只写了 PA12，但合封表明确写着 PA12↔PA13），
# 不补的话 QSOP28 会变成「有 SWCLK 没 SWDIO」，连调试都没法配。
BONDS = {
    "CH32L103F8U6": [("PB1", "PB10"), ("PB6", "PB13"), ("PA12", "PA14"), ("PA11", "PA13"), ("PA10", "PB7")],
    "CH32L103G8R6": [("PA14", "PB5"), ("PB1", "PB10"), ("PA12", "PA13")],
    "CH32L103F8P6": [("PA13", "PB6"), ("PA14", "PB7"), ("BOOT0", "PB8")],
    "CH32L103K8U6": [("BOOT0", "PB9")],
    "CH32L103K8U7": [("BOOT0", "PB9")],
}
BOND_NOTE = "内部与 {other} 短接合封到同一个物理引脚"


def apply_bonds(pkg_id: str, pins: list) -> None:
    """按合封表补 aliases。

    两种情形：
      * 引脚行已经写了两个端口（pin 31 的 BOOT0 + PB9）—— 把对方补进 aliases；
      * 引脚行只写了其中一个（G8R6 的 pin 28 只写 PA12，合封表却说 PA12↔PA13）——
        照合封表把缺的那个补成别名，否则这颗片子在工具里会「有 SWCLK 没 SWDIO」，连调试都配不了。
    """
    by_name = {}
    for p in pins:
        by_name[p["name"]] = p
        for a in p.get("aliases") or []:
            by_name[a] = p

    for a, b in BONDS.get(pkg_id, []):
        pa, pb = by_name.get(a), by_name.get(b)
        if pa is None and pb is None:
            print(f"  !! {pkg_id} 合封 {a}↔{b}：两个端口都不在引脚表里，跳过")
            continue
        if pa is None:
            pa = pb
            print(f"  ++ {pkg_id} 合封表称 {a}↔{b}，引脚行缺 {a} → 按合封表补为 pin {pb['num']} 的别名")
        if pb is None:
            pb = pa
            print(f"  ++ {pkg_id} 合封表称 {a}↔{b}，引脚行缺 {b} → 按合封表补为 pin {pa['num']} 的别名")
        for host, other in ((pa, b), (pb, a)):
            al = host.setdefault("aliases", [])
            if other not in al and other != host["name"]:
                al.append(other)
            if al:
                host["note"] = BOND_NOTE.format(other="、".join(al))


def build(md: str, data: dict) -> tuple[dict, dict]:
    pkgs_raw, power_rows = parse_table(md)
    order = ["C8T6", "K8U6", "K8U7", "G8R6", "F8U6", "F8P6"]
    col_of = {"C8T6": 0, "K8U6": 1, "K8U7": 1, "G8R6": 2, "F8U6": 3, "F8P6": 4}

    # 保留原有的引脚 note（HSE 晶振说明之类），按引脚名索引
    old_notes = {}
    for pkg in data["packages"]:
        for p in pkg["pins"]:
            if p.get("note"):
                old_notes.setdefault(p["name"], p["note"])

    ports: dict[str, list] = {}
    packages = []
    for key in order:
        pkg = pkgs_raw.get(key)
        if not pkg:
            raise SystemExit(f"引脚表里缺少封装 {key}")
        by_num: dict[int, list] = {}
        for row in pkg["rows"]:
            by_num.setdefault(row["num"], []).append(row)

        pins = []
        for num in sorted(by_num):
            group = by_num[num]
            primary = group[0]
            others = group[1:]
            pname = base_name(primary["name"])
            pin = {"num": num, "name": pname, "kind": pin_kind(primary["name"], primary["type"])}
            if others:
                pin["aliases"] = [base_name(o["name"]) for o in others]
                bond = "、".join(pin["aliases"])
                pin["note"] = BOND_NOTE.format(other=bond)
            elif pname in old_notes:
                pin["note"] = old_notes[pname]

            # 该引脚的复用功能按**各自的端口名**入库（合封的 PA13 与 PB6 共用一脚，
            # 但 ports 里仍各记各的；引脚上"两边都能用"由 buildPins 按 aliases 合并）
            for row in group:
                host = base_name(row["name"])
                for e in af_entries(row["af"]):
                    lst = ports.setdefault(host, [])
                    if e not in lst:
                        lst.append(e)
                # 复位主功能里的时钟/调试脚（OSC_IN、SWDIO 这些只出现在主功能列）
                main = row["main"].strip()
                for fn in norm_fns(main.split("/")[0]):
                    lst = ports.setdefault(host, [])
                    if fn.split("_")[0] in ("CLK", "DBG") and {"fn": fn} not in lst:
                        lst.insert(0, {"fn": fn})
            pins.append(pin)

        # 电源/复位/启动引脚（表末汇总）。表里也重复列了已经出现在引脚行的脚
        # （VBAT / NRST / VDDA / BOOT0 …），所以先看这个号有没有被占，别加两遍。
        taken = {p["num"] for p in pins}
        for name, cols in power_rows.items():
            cell = cols[col_of[key]] if col_of[key] < len(cols) else "—"
            if cell.strip() in ("—", "-", ""):
                continue
            for n in re.findall(r"\d+", cell):
                if int(n) in taken:
                    continue
                pins.append(
                    {
                        "num": int(n),
                        "name": name,
                        "kind": pin_kind(name, "I" if name in ("NRST", "BOOT0") else "P"),
                    }
                )
                taken.add(int(n))

        pins.sort(key=lambda p: p["num"])
        apply_bonds(pkg["id"], pins)
        packages.append({"id": pkg["id"], "label": pkg["label"], "shape": "quad", "pins": pins})

    # 注意：合封的另一个端口（PA13↔PB6 之类）**不能**在这里并进 ports。
    # ports 是全封装共用的，而合封只发生在个别封装上 —— 并进去会让 C8T6 的 PA12
    # 也冒出 PB5 才有的功能。合封的引脚共用由 wch.ts 的 buildPins 按 aliases 处理。

    return packages, ports


def main():
    md_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not md_path:
        raise SystemExit("用法: python scripts/rebuild_l103_from_ds.py <引脚表.md>")
    md = open(md_path, encoding="utf-8").read()
    data = json.load(open(DATA, encoding="utf-8"))

    packages, ports = build(md, data)
    data["packages"] = packages
    data["ports"] = {k: v for k, v in sorted(ports.items())}

    # CMP3 在表里有 OUT0（PB4），补进外设信号表，否则那个脚选了没反应
    for per in data["peripherals"]:
        if per["id"] == "CMP3" and "OUT0" not in per["signals"]:
            per["signals"] = ["N0", "N1", "OUT0", "OUT1", "P0", "P1"]

    data["source"] = (
        "CH32L103DS0 表2-1-1（各封装引脚定义，含 AFIO 配置位）；"
        "复用组号即 AFIO 配置值（USART3_TX[11] → 3）"
    )
    data["packVersion"] = "0.2.0"
    data["pending"] = [
        "packages/ports 由 scripts/rebuild_l103_from_ds.py 从 DS0 表2-1-1 自动生成，"
        "remap 字段就是表里的 AFIO 配置位数值；换新引脚表后重跑脚本即可",
        "G8R6（QSOP28）的引脚行只写了 pin 28 = PA12，但表末「封装内部短接」写着 PA12↔PA13，"
        "按合封表把 PA13 补成该脚别名 —— 否则这颗片子会「有 SWCLK 没 SWDIO」。待对照 DS0 原图确认",
        "MCO / WKUP / TAMPER / RTC 这几个多功能没有建模成外设信号，引脚菜单里不出现",
        "中断向量编号按 CH32L103RM V2.2 表9-1 录入，IRQn 枚举名按同族惯例推断，未用 L103 EVT 头文件验证",
        "生成的代码尚未对照 CH32L103 EVT 的 SDK 头文件验证（本地没有 L103 EVT，只有 X035 EVT）",
    ]

    json.dump(data, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print("封装：")
    for pkg in packages:
        io = sum(1 for p in pkg["pins"] if p["kind"] == "io")
        boot = sum(1 for p in pkg["pins"] if p["kind"] == "boot" and p.get("aliases"))
        nums = [p["num"] for p in pkg["pins"]]
        print(
            f"  {pkg['id']:<15} {pkg['label']:<8} 引脚 {len(pkg['pins']):>2}  "
            f"GPIO {io + boot:>2}  编号 {min(nums)}..{max(nums)}  "
            f"{'连续' if nums == list(range(min(nums), max(nums) + 1)) else '不连续!'}"
        )
    print(f"端口 {len(ports)} 个，功能条目 {sum(len(v) for v in ports.values())} 条")


if __name__ == "__main__":
    main()
