#!/usr/bin/env python3
"""
从 `docs/hc32f401b-pin-table.md` 生成 `src/devices/data/hc32f401b.json`。

    python scripts/rebuild_hc32f401_from_md.py docs/hc32f401b-pin-table.md

与两个 WCH 重建脚本的核心差别：**HC32 的表里没有物理引脚号**。
手册 4.2 只给「端口 → AF 映射」，封装一节只给「本封装引出哪些端口」。
所以这里：

1. 引脚从端口范围展开（PA0..PA15 …），`num` 是**按端口顺序的序号**，
   封装上标 `pinNumbering: "sequence"`，界面必须提示「非封装引脚号」。
2. **按引脚数自洽性筛选封装**：声明引出的 GPIO 数不得超过封装引脚数
   （剩下的要留给电源/复位/BOOT）。不自洽的封装宁可不出，也不编造引脚。
3. `remap` 直接存 AF 编号；因为 `afGrouping: "independent"`，
   引脚规划不会加组约束（同一外设的信号可以落在不同 AF 上，硬件允许）。
"""

import json
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "docs/hc32f401b-pin-table.md"
OUT = "src/devices/data/hc32f401b.json"

DASH = {"-", "‑", "–", "—", ""}

# ───────────────────────── 信号名归一化 ─────────────────────────

DBG_MAP = {
    "JTMS-SWDIO": "DBG_SWDIO",
    "JTCK-SWCLK": "DBG_SWCLK",
    "JTDI": "DBG_JTDI",
    "JTDO-SWO": "DBG_SWO",
    "JTAST": "DBG_JTAG",
    "MCO0": "CLK_MCO",
}
OSC_MAP = {
    "OSC_IN": "CLK_HSE_IN",
    "OSC_OUT": "CLK_HSE_OUT",
    "OSC32_IN": "CLK_LSE_IN",
    "OSC32_OUT": "CLK_LSE_OUT",
}
# TIM 刹车 / TIM10 输出沿用本项目的命名，便于与既有 TIM 面板、通道表共用
FIXED = {
    "TIM1_BK1": "TIM1_BKIN",
    "TIM1_BK2": "TIM1_BKIN2",
    "TIM8_BK1": "TIM8_BKIN",
    "TIM8_BK2": "TIM8_BKIN2",
    "TIM10_TO_GP": "TIM10_CH1",
    "TIM10_TO_GN": "TIM10_CH1N",
}


def rename(raw: str) -> list[str]:
    """手册信号名 → 本项目 `<实例>_<信号>`（可返回多个）"""
    r = raw.strip()
    # 去掉 (FM+) 之类的括注：它描述电气特性，不是名字的一部分
    r = re.sub(r"[（(][^）)]*[）)]", "", r).strip()

    if r in DBG_MAP:
        return [DBG_MAP[r]]
    if r in OSC_MAP:
        return [OSC_MAP[r]]
    if r in FIXED:
        return [FIXED[r]]

    # ADC：手册叫 ANn，本项目通道表按 INn 组织（与 WCH 一致，UI 才能复用）
    m = re.fullmatch(r"ADC12_AN(\d+)", r)
    if m:
        return [f"ADC1_IN{m.group(1)}", f"ADC2_IN{m.group(1)}"]
    m = re.fullmatch(r"ADC(\d+)_AN(\d+)", r)
    if m:
        return [f"ADC{m.group(1)}_IN{m.group(2)}"]
    m = re.fullmatch(r"ADC(\d+)_(START|SQR\d_TRGO)", r)
    if m:
        return [f"ADC{m.group(1)}_{m.group(2)}"]

    if r in ("USB_DM", "USB_DP"):
        return [f"USB1_{r.split('_')[1]}"]
    if r == "DAC_OUT":
        return ["DAC1_OUT"]
    if r in ("CAN_RX", "CAN_TX"):
        return [f"CAN1_{r.split('_')[1]}"]
    if r.startswith("QSPI_"):
        return ["QSPI1_" + r.split("_", 1)[1]]
    if r == "RTC_TRIMCLK":
        return ["RTC_TRIMCLK"]

    if "_" in r:
        return [r]
    raise SystemExit(f"无法归一化的信号名：{raw!r}（请在 rename() 里加一条）")


# ───────────────────────── 元数据模板 ─────────────────────────
# 用「最长前缀匹配」取键：I2C1→I2C、QSPI1→QSPI、TIM10→TIM、SPI2→SPI

META = {
    "DBG": dict(kind="DBG", group="System", schema="DBG", brief="JTAG / SWD 调试口", required=["SWDIO", "SWCLK"]),
    "CLK": dict(kind="CLK", group="System", schema="CLK", brief="外部晶振与时钟输出", label="时钟源"),
    "RTC": dict(kind="RTC", group="System", schema="RTC", brief="实时时钟（含校准时钟输出）"),
    "USART": dict(kind="USART", group="Connectivity", schema="USART", brief="通用同步/异步收发器", required=["TX", "RX"]),
    "UART": dict(kind="UART", group="Connectivity", schema="UART", brief="异步串口（无 CK）", required=["TX", "RX"]),
    "SPI": dict(kind="SPI", group="Connectivity", schema="SPI", brief="串行外设接口", required=["SCK", "MOSI", "MISO"]),
    "QSPI": dict(kind="QSPI", group="Connectivity", schema="QSPI", brief="四线 QSPI 控制器", required=["NSS", "CLK", "D0", "D1"]),
    "I2S": dict(kind="I2S", group="Connectivity", schema="I2S", brief="I²S 音频接口", required=["WS", "CK"]),
    "I2C": dict(kind="I2C", group="Connectivity", schema="I2C", brief="I²C 控制器", required=["SCL", "SDA"]),
    "CAN": dict(kind="CAN", group="Connectivity", schema="CAN", brief="CAN‑FD 控制器", required=["TX", "RX"]),
    "USB": dict(kind="USB", group="Connectivity", schema="USB", brief="USB 2.0 全速设备", required=["DP", "DM"]),
    "TIM": dict(kind="TIM", group="Timers", schema="TIM", brief="16 位定时器"),
    "ADC": dict(kind="ADC", group="Analog", schema="ADC", brief="12 位逐次逼近 ADC"),
    "DAC": dict(kind="DAC", group="Analog", schema="DAC", brief="12 位电压输出 DAC", required=["OUT"]),
    "FDA": dict(kind="OPA", group="Analog", schema="FDA", brief="差分运放 / PGA"),
    "VC": dict(kind="VCMP", group="Analog", schema="VCMP", brief="电压比较器", required=["OUT"]),
}


def meta_for(pid: str) -> dict:
    base = max((k for k in META if pid.startswith(k)), key=len, default=None)
    if base is None:
        raise SystemExit(f"外设 {pid} 没有元数据模板，请在 META 里加一条")
    m = dict(META[base])
    m.setdefault("label", pid)
    return m


# ───────────────────────── 解析 markdown ─────────────────────────

def parse_af_table(md: str):
    """第二节：| Port | AF0 SYS | ... | AN 模拟 | → ports{port: [entry]}"""
    lines = md.splitlines()
    ports: dict[str, list[dict]] = {}
    started = False
    af_cols: list[int | None] = []  # 列索引 → AF 编号（None = AN 列）

    for line in lines:
        if line.startswith("## 二、"):
            started = True
            continue
        if started and line.startswith("## "):
            break
        if not started or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells[0] == "Port":
            af_cols = []
            for c in cells[1:]:
                m = re.match(r"AF(\d+)", c)
                af_cols.append(int(m.group(1)) if m else None)
            continue
        if set("".join(cells)) <= set("-: "):
            continue
        port = cells[0]
        if not re.fullmatch(r"P[A-Z]\d{1,2}", port):
            continue
        arr: list[dict] = []
        seen = set()
        for idx, cell in enumerate(cells[1:]):
            if idx >= len(af_cols):
                break
            if cell in DASH:
                continue
            af = af_cols[idx]
            if af is None:
                # AN 列：空格分隔，模拟通道不需要配复用寄存器
                for tok in re.split(r"[\s,]+", cell):
                    if tok and tok not in DASH:
                        for fn in rename(tok):
                            if ("fn", fn) not in seen:
                                seen.add(("fn", fn))
                                arr.append({"fn": fn})
            else:
                # AFn 列：斜杠分隔的信号共用这个 AF
                for tok in cell.split("/"):
                    tok = tok.strip()
                    if not tok or tok in DASH:
                        continue
                    for fn in rename(tok):
                        key = ("fn", fn, af)
                        if key in seen:
                            continue
                        seen.add(key)
                        arr.append({"fn": fn, "remap": str(af)} if af else {"fn": fn})
        if arr:
            ports[port] = arr
    if not ports:
        raise SystemExit("没解析到 AF 表（检查第二节的表头是否为 `| Port | AF0 SYS |`）")
    return ports


def parse_models(md: str):
    """第一节：型号 → 封装标签"""
    out = {}
    for line in md.splitlines():
        if not line.startswith("| HC32"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 20:
            continue
        out[cells[0]] = cells[-2]
    return out


def parse_packages(md: str):
    """第三节：每个 `### 3.x 封装名 — 型号` 下的 `| 引脚 | 引脚名 | 类型 | 说明 |` 表
    → {型号: {label, model, pins:[{num,name,kind,note,aliases}]}}

    引脚表是**权威来源**：它决定这个封装引出了哪些物理脚、引脚号是多少。
    以前那种「端口范围」写法会算出自相矛盾的结果（32 脚装 38 个 GPIO），
    所以改成逐脚录入。
    """
    KIND = {"I/O": "io", "S": "power", "RST": "reset", "B": "boot"}
    pkgs: dict[str, dict] = {}
    cur = None
    in_table = False

    for line in md.splitlines():
        # 只在破折号处切：`QFN32-4×4 — 型号` 里的连字符属于封装名
        m = re.match(r"###\s*3\.\d+\s+(.+?)\s+[—-]\s+(\S+)", line.strip())
        if m:
            cur = {"label": m.group(1).strip(), "model": m.group(2).strip(), "pins": []}
            pkgs[cur["model"]] = cur
            in_table = False
            continue
        if line.startswith("## ") and not line.startswith("###"):
            cur = None
            in_table = False
            continue
        if cur is None or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells[0] == "引脚":
            in_table = True
            continue
        if not in_table or len(cells) < 4 or not cells[0].isdigit():
            continue
        num, name, typ, note = int(cells[0]), cells[1].strip(), cells[2].strip(), cells[3].strip()
        kind = KIND.get(typ)
        if kind is None:
            raise SystemExit(f"{cur['model']} 第 {num} 脚的类型看不懂：{typ!r}")
        pin = {"num": num, "name": name, "kind": kind}
        if note and note not in DASH:
            pin["note"] = note
            # `PB2/BOOT1`：斜杠后面是同一物理脚的第二名称
            if "/" in note:
                alias = note.split("/")[-1].strip()
                if re.fullmatch(r"[A-Z]{2,}\d*", alias) and alias != name:
                    pin["aliases"] = [alias]
        cur["pins"].append(pin)

    return {k: v for k, v in pkgs.items() if v["pins"]}


def pin_count_of(label: str) -> int | None:
    m = re.search(r"(\d+)", label)
    return int(m.group(1)) if m else None



def build(md: str) -> dict:
    ports = parse_af_table(md)
    models = parse_models(md)
    pkg_ranges = parse_packages(md)

    # 外设与信号（来自 ports 的并集）
    periphs: dict[str, set] = {}
    for arr in ports.values():
        for e in arr:
            owner, _, sig = e["fn"].partition("_")
            periphs.setdefault(owner, set()).add(sig)

    packages, rejected = [], []
    for model, info in pkg_ranges.items():
        label = info["label"]
        pins = info["pins"]
        nums = [p["num"] for p in pins]
        if sorted(nums) != list(range(1, len(nums) + 1)):
            missing = sorted(set(range(1, max(nums) + 1)) - set(nums))
            dup = [n for n in set(nums) if nums.count(n) > 1]
            raise SystemExit(f"{model} 引脚号不连续：缺 {missing[:8]}，重复 {dup[:8]}")
        declared = pin_count_of(label)
        if declared is not None and len(pins) != declared:
            # 表里的脚数与封装名不符 —— 这种表不能进仓库，宁可少一个封装
            rejected.append((model, label, declared, len(pins)))
            continue
        packages.append({
            "id": model,
            "label": label,
            "shape": "qfn" if label.startswith("QFN") else "quad",
            # 引脚号来自引脚定义大图，就是封装的真实引脚号
            "pinNumbering": "package",
            "pins": pins,
        })

    if not packages:
        raise SystemExit("没有可用封装（全部被自洽性检查拒绝？）")

    universe = {p["name"] for pkg in packages for p in pkg["pins"]}
    missing_at = [(pid, sig) for pid, sigs in periphs.items() for sig in sigs
                  if not any(f"{pid}_{sig}" in {e["fn"] for e in ports.get(p, [])} for p in universe)]

    pending = [
        "引脚号来自引脚定义大图（逐脚录入），是封装的真实物理引脚号",
        "尚无中断向量表（irqs 为空），NVIC 面板暂无条目",
        "尚无 DMA 请求映射表，DMA 面板按通道号手选",
        "代码生成明确禁止（codegen = disable）：资料只到引脚/AF 层级，"
        "尚无寄存器手册与 SDK 头文件；引脚映射表仍可导出",
        "ADC 通道按本项目的 INn 命名（手册为 ANn），便于与既有 ADC 面板共用",
        "TIM10 的 TO_GP/TO_GN 归一化为 CH1/CH1N；TIM1/TIM8 的 BK1/BK2 归一化为 BKIN/BKIN2"
        "（这两条是推断，待手册确认）",
        "复用的分组语义 = independent（逐引脚 AF，无重映射组）。"
        "同一外设的信号允许落在不同 AF 上，与 WCH 的 AFIO 整组切换不同",
    ]
    if rejected:
        pending.append(
            "以下封装的引脚表与封装名不符，未生成（需回查引脚定义大图）："
            + "；".join(f"{m}({lb}) 表里 {g} 脚 / 封装名 {d} 脚" for m, lb, d, g in rejected)
        )
    if missing_at:
        pending.append("以下信号没有任何封装引出：" + ", ".join(f"{a}_{b}" for a, b in missing_at[:12]))

    data = {
        "packVersion": "0.2.0",
        "series": "HC32F401B",
        "vendor": "HDSC",
        "core": "Cortex-M4F",
        "source": "HC32F401B 数据手册 Ver1.1.1 第 4.2 节「引脚说明」（端口‑AF‑模拟映射）"
                  "＋用户手册 Ver1.0.14；封装引脚序号由端口范围推导，非物理引脚号",
        "flashKb": 256,
        "ramKb": 192,
        "voltage": "1.8-3.6V",
        "maxSysclk": 168,
        "debug": {"twoWire": True, "singleWire": False, "swdio": "PA13", "swclk": "PA14"},
        "sdkHeader": "hc32f4xx",
        "backend": "generic",
        # 资料只到引脚/AF 层级：没有完整的寄存器手册与 SDK 头文件。
        # 生成初始化代码只能靠编，所以明确禁止，只保留引脚映射表。
        "codegen": "disable",
        "codegenNote": "HC32F401B 目前只录入了引脚与复用功能，尚无完整的寄存器/SDK 资料，"
                       "因此不生成初始化代码；引脚映射表仍可导出。",
        # 逐引脚独立 AF，没有重映射组寄存器 —— 引脚规划不加组约束
        "afGrouping": "independent",
        "clock": {
            # 待核：HSI 频率、PLL 输入分频都要对照用户手册「时钟」章节
            "hsi": 16,
            "hseOptions": [8, 16, 24],
            "lsi": 32.768,
            "pllSource": "HSI_DIV2",
            "pllMin": 2,
            "pllMax": 63,
            "maxSysclk": 168,
            "apb1Divs": [1, 2, 4, 8, 16],
            "apb2Divs": [1, 2, 4, 8, 16],
            "ahbDivs": [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
            "adcDivs": [1, 2, 4, 8, 16, 32, 64, 128],
            "notes": ["时钟树参数待按用户手册核对：HSI 频率、PLL 输入分频、各总线最高频率"],
        },
        "meta": {pid: meta_for(pid) for pid in sorted(periphs)},
        "packages": packages,
        "ports": {p: ports[p] for p in sorted(ports)},
        "peripherals": [{"id": pid, "signals": sorted(sigs)} for pid, sigs in sorted(periphs.items())],
        "irqs": [],
        "pending": pending,
    }

    print(f"封装 {len(packages)} 个：{', '.join(p['id'] for p in packages)}")
    if rejected:
        print(f"跳过 {len(rejected)} 个数据不自洽的封装：")
        for m, lb, d, g in rejected:
            print(f"   {m}（{lb}）表里 {g} 个引脚，与封装名的 {d} 脚不符")
    print(f"端口 {len(ports)} 个，外设 {len(periphs)} 个，复用项 {sum(len(v) for v in ports.values())} 条")
    if missing_at:
        print(f"! 没有任何封装引出的信号：{missing_at[:8]}")
    return data


def main():
    md = open(SRC, encoding="utf-8").read()
    data = build(md)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"→ {OUT}")


main()
