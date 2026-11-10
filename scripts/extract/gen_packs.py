# -*- coding: utf-8 -*-
"""Build RiscFiveRuler device packs from the parsed WCH pin tables.

Reads the JSON produced by ``wchtable.py`` and writes
``src/devices/data/<series>.json``.

The output format is the one documented in ``docs/llm-pin-extraction-prompt.md``
-- the same shape an external LLM is asked to produce, so its answer can be
dropped straight in.
"""
import io
import json
import re
import sys

TMP = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/ZWDX_LKJ/AppData/Local/Temp"
OUT = sys.argv[2] if len(sys.argv) > 2 else "src/devices/data"


def load(name):
    return json.load(io.open(f"{TMP}/{name}", encoding="utf-8"))


def load_opt(name):
    try:
        return json.load(io.open(f"{TMP}/{name}", encoding="utf-8"))
    except Exception:
        return None


def bonded_groups(rows):
    """同一封装里共用一个物理引脚的端口（内部短接合封）视为同一组。"""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    by_pin = {}
    for r in rows:
        name = clean_name(r["name"])
        if not re.match(r"^P[A-E]\d+$", name):
            continue
        find(name)
        for pkg, num in r["pkg"].items():
            if num:
                by_pin.setdefault((pkg, num), []).append(name)
    for names in by_pin.values():
        for n in names[1:]:
            union(names[0], n)
    groups = {}
    for n in list(parent):
        groups.setdefault(find(n), set()).add(n)
    return groups


def consensus(rows, rows_xy, siblings=None):
    """Merge the two parses of the same table.

    * layout parse —— 每个 token 都在，但长单元格的尾巴会串到相邻行
    * coordinate parse —— 按坐标精确切格，但跨页溢出的内容会丢

    早期版本会用「另一个端口在两路解析里都认领了它」来删掉串行，
    但那会把真实信号一起删掉（例如 PA5 的 SPI1_SCK 被 PA4 的串行顶掉）。
    现在改成取并集：宁可多列几条候选，也不让某个外设因为缺一个脚被误判成「不可用」。
    """
    if not rows_xy:
        return rows

    def port_of(raw):
        n = clean_name(raw)
        m = re.search(r"(P[A-E]\d+|VDD|VSS|VDDA|VSSA|GND|NRST|BOOT0)", n)
        return m.group(1) if m else n

    xy = {}
    for r in rows_xy:
        xy.setdefault(port_of(r["name"]), set()).update(r.get("af", []) + r.get("remap", []))

    out = []
    for r in rows:
        name = port_of(r["name"])
        keep_af = list(r.get("af", []))
        keep_rm = list(r.get("remap", []))
        seen = set(keep_af) | set(keep_rm)
        for t in sorted(xy.get(name, set())):
            if t not in seen:
                keep_af.append(t)
                seen.add(t)
        nr = dict(r)
        nr["af"], nr["remap"] = keep_af, keep_rm
        out.append(nr)
    return out


# ───────────────────────────── signal normalisation ──────────────────────────

REMAP_SUF = re.compile(r"_(\d)$")

# tokens that survive column slicing but are not signals
JUNK_TOKENS = {
    "T", "TIM", "USART", "SPI", "I2C", "ADC", "CAN", "OPA", "CMP", "LPTIM",
    "PD0", "PD1", "BOOT1", "BOOT0", "WKUP", "RTC", "TAMPER", "MCO",
    "SWDIO", "SWCLK", "NRST", "P", "I", "O", "A", "FT",
}

L103_RULES = [
    (r"^USART(\d)_(.+)$", lambda m: (f"USART{m[0]}", m[1])),
    (r"^SPI(\d)_(.+)$", lambda m: (f"SPI{m[0]}", m[1])),
    (r"^I2C(\d)_(.+)$", lambda m: (f"I2C{m[0]}", m[1])),
    (r"^TIM(\d)_(.+)$", lambda m: (f"TIM{m[0]}", m[1])),
    (r"^LPTIM_(.+)$", lambda m: ("LPTIM", m[0])),
    (r"^ADC_IN(\d+)$", lambda m: ("ADC1", f"IN{m[0]}")),
    (r"^OPA_P(\d+)$", lambda m: ("OPA1", f"P{m[0]}")),
    (r"^OPA_N(\d+)$", lambda m: ("OPA1", f"N{m[0]}")),
    (r"^OPA_O(\d+)$", lambda m: ("OPA1", f"OUT{m[0]}")),
    (r"^CMP(\d)_([PNO].+)$", lambda m: (f"CMP{m[0]}", m[1])),
    (r"^CAN(\d)_(.+)$", lambda m: (f"CAN{m[0]}", m[1])),
    (r"^USBDP$", lambda m: ("USB1", "DP")),
    (r"^USBDM$", lambda m: ("USB1", "DM")),
    (r"^CC(\d)$", lambda m: ("USBPD", f"CC{m[0]}")),
]

# X035 datasheet uses the short forms printed on the package diagrams
X035_RULES = [
    (r"^TX(\d)$", lambda m: (f"USART{m[0]}", "TX")),
    (r"^RX(\d)$", lambda m: (f"USART{m[0]}", "RX")),
    (r"^CK(\d)$", lambda m: (f"USART{m[0]}", "CK")),
    (r"^CTS(\d)$", lambda m: (f"USART{m[0]}", "CTS")),
    (r"^RTS(\d)$", lambda m: (f"USART{m[0]}", "RTS")),
    (r"^T(\d)C(\d)N$", lambda m: (f"TIM{m[0]}", f"CH{m[1]}N")),
    (r"^T(\d)C(\d)$", lambda m: (f"TIM{m[0]}", f"CH{m[1]}")),
    (r"^T(\d)ET$", lambda m: (f"TIM{m[0]}", "ETR")),
    (r"^T(\d)BK$", lambda m: (f"TIM{m[0]}", "BKIN")),
    (r"^A(\d+)$", lambda m: ("ADC1", f"IN{m[0]}")),
    (r"^C(\d)P(\d)$", lambda m: (f"CMP{m[0]}", f"P{m[1]}")),
    (r"^C(\d)N(\d)$", lambda m: (f"CMP{m[0]}", f"N{m[1]}")),
    (r"^C(\d)O$", lambda m: (f"CMP{m[0]}", "OUT")),
    (r"^O(\d)N(\d)$", lambda m: (f"OPA{m[0]}", f"N{m[1]}")),
    (r"^O(\d)P(\d)$", lambda m: (f"OPA{m[0]}", f"P{m[1]}")),
    (r"^O(\d)O(\d)$", lambda m: (f"OPA{m[0]}", f"OUT{m[1]}")),
    (r"^CS(_\d)?$", lambda m: ("SPI1", "NSS")),
    (r"^SCK(_\d)?$", lambda m: ("SPI1", "SCK")),
    (r"^MISO(_\d)?$", lambda m: ("SPI1", "MISO")),
    (r"^MOSI(_\d)?$", lambda m: ("SPI1", "MOSI")),
    (r"^SCL(_\d)?$", lambda m: ("I2C1", "SCL")),
    (r"^SDA(_\d)?$", lambda m: ("I2C1", "SDA")),
    (r"^UDP$", lambda m: ("USB1", "DP")),
    (r"^UDM$", lambda m: ("USB1", "DM")),
    (r"^CC(\d)$", lambda m: ("USBPD", f"CC{m[0]}")),
    (r"^DIO$", lambda m: ("SYSTEM", "SWDIO")),
    (r"^DCK$", lambda m: ("SYSTEM", "SWCLK")),
    (r"^PIOC_IO(\d)$", lambda m: ("PIOC", f"IO{m[0]}")),
]


VALID_SIG = re.compile(
    r"^(CH\d+N?|ETR|BKIN|TX|RX|CK|CTS|RTS|NSS|SCK|MISO|MOSI|SCL|SDA|SMBA"
    r"|IN\d+|P\d+|N\d+|OUT\d*|DP|DM|CC\d|IO\d|SWDIO|SWCLK)$")

# datasheet writes "TIM2_CH1_ETR" for a pin that can be either CH1 or ETR
CH_ETR = re.compile(r"^TIM(\d)_CH(\d)_ETR$")


def normalise(tok, rules):
    """datasheet token -> (peripheralId, signal, remapGroup) or None"""
    if not tok or tok in JUNK_TOKENS:
        return None
    remap = None
    m = REMAP_SUF.search(tok)
    if m and not re.match(r"^(ADC_IN|T\dC\d|A\d+)$", tok):
        remap = m.group(1)
        tok = tok[: m.start()]
    # 数据手册用结尾下划线表示「默认复用功能」（TX4_ / CS_ / T1BK_）
    tok = tok.rstrip("_")
    for pat, fn in rules:
        mm = re.match(pat, tok)
        if mm:
            pid, sig = fn(mm.groups())
            return (pid, sig, remap)
    return None


# 列切片会把一个名字切成两半（"SC" + "K"、"C" + "TS4_4"）。
# 判断依据不是长度，而是「它本身是不是一个完整信号名」——
# 否则 "A5" 这种已经完整的两字符名字会被错误地跟后面的 token 粘起来。
FULL_TOKEN = re.compile(
    r"^(TX|RX|CK|CTS|RTS|CS|SCK|MISO|MOSI|NSS|SCL|SDA|SMBA|UDP|UDM|DIO|DCK"
    r"|RST|MCO|PIOC_IO\d+|T\dC\dN?|T\dET|T\dBK|C\d[PNO]\d?|O\d[PNO]\d"
    r"|O\dO\d|A\d+)$")


def rejoin(tokens):
    out, i = [], 0
    while i < len(tokens):
        t = tokens[i]
        if i + 1 < len(tokens) and not FULL_TOKEN.match(t) and FULL_TOKEN.match(t + tokens[i + 1]):
            out.append(t + tokens[i + 1])
            i += 2
            continue
        out.append(t)
        i += 1
    return out


def port_signals(row, rules):
    out = []
    seen = set()
    toks = []
    # 「主功能」列对 IO 引脚通常是端口名（normalise 会返回 None），
    # 但 X035 的表里偶尔把第一个复用功能写进这一列（如 PC16 的 UDM），所以一并喂进去。
    main = str(row.get("main", "") or "")
    # 主功能列要排在前面：被切开的 "SC" 在它这一列，"K" 在复用列，顺序反了就拼不回来
    raw = [t for t in main.replace("/", " ").split() if t]
    raw += list(row.get("af", [])) + list(row.get("remap", []))
    raw = rejoin(raw)
    for tok in raw:
        m = CH_ETR.match(tok)
        if m:
            toks += [f"TIM{m.group(1)}_CH{m.group(2)}", f"TIM{m.group(1)}_ETR"]
        else:
            toks.append(tok)
    for tok in toks:
        n = normalise(tok, rules)
        if not n:
            continue
        pid, sig, remap = n
        if not VALID_SIG.match(sig):
            continue
        key = (pid, sig, remap)
        if key in seen:
            continue
        seen.add(key)
        entry = {"fn": f"{pid}_{sig}"}
        if remap:
            entry["remap"] = remap
        out.append(entry)
    return out


def kind_of(name):
    n = name.upper()
    if n in ("VDD", "VSS", "VDDA", "VSSA", "VBAT", "VDDIO"):
        return "power"
    if n.startswith("NRST") or n == "RST":
        return "reset"
    if n.startswith("BOOT"):
        return "boot"
    if n.startswith("PC1") and ("OSC32" in n):
        return "io"
    return "io"


def clean_name(raw):
    """normalise the pin-name cell into a bare port name"""
    n = raw.strip()
    n = re.sub(r"\(\d+\)", "", n)
    fixes = {
        "PC13-MPER-RTC": "PC13",
        "PC13-TAMPER-RTC": "PC13",
        "PC14-SC32_IN": "PC14",
        "PC14-OSC32_IN": "PC14",
        "PC15-C32_OUT": "PC15",
        "PC15-OSC32_OUT": "PC15",
        "PC14-": "PC14",
        "PC15-": "PC15",
        "PC13-": "PC13",
        "PA0-WKUP": "PA0",
        "OSC_IN": "OSC_IN",
        "OSC_OUT": "OSC_OUT",
    }
    if n in fixes:
        return fixes[n]
    # X035/X033 的 RST 复用只出现在 PC3 上（DS 表2-1 注2），
    # 解析时主功能列的 "RST/C1N0/..." 会盖住引脚名列
    if n.startswith("RST"):
        return "PC3"
    m = re.match(r"^(P[A-E]\d+)", n)
    if m:
        return m.group(1)
    # 主功能列的碎片会粘在名字前面（"C1PC3"），在整串里找端口名
    m = re.search(r"(P[A-E]\d+)", n)
    if m:
        return m.group(1)
    # 表格最后一行经常把类型/电平列的碎片粘到引脚名后面（如 "VDD=="）
    m = re.match(r"^(VDD|VSS|VDDA|VSSA|VBAT|GND|NRST|BOOT0|BOOT1|OSC_IN|OSC_OUT)", n)
    if m:
        return m.group(1)
    return n


CLOCK_PIN_NOTE = {
    "OSC_IN": "HSE 外部高速晶振输入（也可配成普通 IO）",
    "OSC_OUT": "HSE 外部高速晶振输出（也可配成普通 IO）",
    "PC14": "兼作 LSE 32.768 kHz 晶振输入（OSC32_IN）",
    "PC15": "兼作 LSE 32.768 kHz 晶振输出（OSC32_OUT）",
}


def build_package(rows, pkg_key, pkg_id, label, shape, extra_note=None):
    pins = []
    for r in rows:
        num = r["pkg"].get(pkg_key)
        if not num:
            continue
        name = clean_name(r["name"])
        pin = {"num": num, "name": name, "kind": kind_of(name)}
        note = extra_note or CLOCK_PIN_NOTE.get(name)
        if str(r["name"]).strip().startswith("RST") and name == "PC3":
            note = "该封装此脚兼作 RST 复位输入"
        if note:
            pin["note"] = note
        pins.append(pin)
    # two ports can share one physical pin when they are bonded together
    # internally; keep one entry and record the alias
    merged = {}
    order = []
    for p in pins:
        n = p["num"]
        if n not in merged:
            merged[n] = dict(p)
            order.append(n)
        elif merged[n]["name"] != p["name"]:
            alias = p["name"]
            prev = merged[n].get("note")
            merged[n]["note"] = (prev + "；" if prev else "") + f"与 {alias} 内部短接"
            # the two ports share one physical pin, so both keep their functions
            merged[n].setdefault("aliases", []).append(alias)
    out = [merged[n] for n in sorted(order)]
    return {"id": pkg_id, "label": label, "shape": shape, "pins": out}


# 数据手册注里写明「内部短接合封」但引脚表里没有同号引脚的端口对
# （X035/X033 表2-1 注4：PC10↔PC17、PC11↔PC16，USB 的 D+/D- 就挂在这两组上）
PORT_ALIAS = {
    "PC10": ["PC17"],
    "PC17": ["PC10"],
    "PC11": ["PC16"],
    "PC16": ["PC11"],
}


def apply_port_alias(ports):
    out = {k: [dict(s) for s in v] for k, v in ports.items()}
    for a, partners in PORT_ALIAS.items():
        if a not in out:
            continue
        for b in partners:
            if b not in out:
                continue
            for src, dst in ((a, b), (b, a)):
                have = {(s["fn"], s.get("remap")) for s in out[dst]}
                for s in out[src]:
                    key = (s["fn"], s.get("remap"))
                    if key not in have:
                        out[dst].append(dict(s))
                        have.add(key)
    return out


# 晶振引脚在数据手册的「默认复用功能」表里不出现（它本身就是晶振专用脚），
# 但用户需要在引脚图上把它们配成 HSE / LSE，所以这里显式补上。
CLOCK_PINS = {
    "OSC_IN": ("CLK", "HSE_IN"),
    "OSC_OUT": ("CLK", "HSE_OUT"),
    "PC14": ("CLK", "LSE_IN"),
    "PC15": ("CLK", "LSE_OUT"),
}


# 调试口（SDI）引脚。数据手册「串行 2 线调试接口」一节只写功能不写引脚，
# 引脚号要从封装图的 SWDIO/SWCLK 标注里读：
#   L103      → PA13 / PA14（表2-1-1 主功能列写着 SWDIO / SWCLK）
#   X035/X033 → PC18 / PC19（引脚图缩写 DIO:SWDIO、DCK:SWCLK）
DEBUG_PINS = {
    "L103": {"PA13": ("DBG", "SWDIO"), "PA14": ("DBG", "SWCLK")},
    "X035": {"PC18": ("DBG", "SWDIO"), "PC19": ("DBG", "SWCLK")},
}


def apply_debug_pins(ports, series):
    pins = DEBUG_PINS.get(series, {})
    out = {k: [dict(s) for s in v] for k, v in ports.items()}
    for pin, (pid, sig) in pins.items():
        # 引脚在复用表里可能被别的外设占满（X035 的 PC18 有 PIOC_IO0），
        # 但调试功能一定要能选到
        out.setdefault(pin, [])
        fn = f"{pid}_{sig}"
        if not any(s["fn"] == fn for s in out[pin]):
            out[pin].insert(0, {"fn": fn})
    return out


def apply_clock_pins(ports):
    out = {k: [dict(s) for s in v] for k, v in ports.items()}
    for pin, (pid, sig) in CLOCK_PINS.items():
        # PC14/PC15 在 L103 的复用表里没有任何功能，build_ports 会把它们丢掉，
        # 但晶振脚必须留在端口表里，否则配不了 LSE
        out.setdefault(pin, [])
        fn = f"{pid}_{sig}"
        if not any(s["fn"] == fn for s in out[pin]):
            out[pin].insert(0, {"fn": fn})
    return out


def build_ports(rows, rules):
    ports = {}
    for r in rows:
        name = clean_name(r["name"])
        if kind_of(name) != "io":
            continue
        sigs = port_signals(r, rules)
        if not sigs:
            continue
        ports.setdefault(name, [])
        have = {json.dumps(s, sort_keys=True) for s in ports[name]}
        for s in sigs:
            k = json.dumps(s, sort_keys=True)
            if k not in have:
                ports[name].append(s)
                have.add(k)
    return ports


def peripherals_from(ports, ids):
    """derive the peripheral list (and signal sets) from the pin data"""
    sigs = {}
    for plist in ports.values():
        for s in plist:
            pid, sig = s["fn"].split("_", 1)
            sigs.setdefault(pid, set()).add(sig)
    out = []
    for pid in sorted(sigs):
        if pid not in ids:
            continue
        out.append({"id": pid, "signals": sorted(sigs[pid])})
    return out


# peripherals with no pin footprint still need a tree entry + config page
L103_CORE = ["GPIO", "SYSTEM", "DBG", "RTC", "PWR", "EXTI", "CRC", "DMA", "IWDG", "WWDG"]
X035_CORE = ["GPIO", "SYSTEM", "DBG", "PWR", "EXTI", "DMA", "IWDG", "WWDG"]


def with_core(periphs, core):
    have = {p["id"] for p in periphs}
    out = list(periphs)
    for cid in core:
        if cid not in have:
            out.append({"id": cid, "signals": []})
    return out


# CH32X035RM §9.2.3「DMA 请求映射」表，逐通道抄录。
# 同一颗 die 的 X033 沿用同一张表（DS 里两者除封装外资源一致）。
X035_DMA_MAP = {
    "1": ["ADC", "USART4_TX", "TIM2_CH3"],
    "2": ["SPI1_RX", "USART3_TX", "TIM1_CH1", "TIM2_UP"],
    "3": ["SPI1_TX", "USART3_RX", "TIM1_CH2"],
    "4": ["USART1_TX", "TIM1_CH4", "TIM1_TRIG", "TIM1_COM"],
    "5": ["USART1_RX", "TIM1_UP", "TIM2_CH1"],
    "6": ["USART2_RX", "I2C1_TX", "TIM1_CH3"],
    "7": ["USART2_TX", "I2C1_RX", "TIM2_CH2", "TIM2_CH4"],
    "8": ["USART4_RX", "TIM2_TRIG", "TIM2_COM"],
}
# 手册里只写 SPI_RX / I2C_TX（该系列各只有一路），工具内部的请求名带实例号，
# 生成器件包时补上，免得界面查不到映射
for _ch, _reqs in X035_DMA_MAP.items():
    X035_DMA_MAP[_ch] = [
        ("SPI1_" + r[4:]) if r.startswith("SPI_") else
        ("I2C1_" + r[4:]) if r.startswith("I2C_") else r
        for r in _reqs
    ]

# 标准外设库的 API 差异。**这两个 profile 是从真实 EVT 头文件里核对出来的，不是猜的**：
#   CH32X035EVT 的 ch32x035_rcc.h 只有 13 个函数（无 HSE/LSE/PLL/SYSCLK/PCLK/ADCCLK），
#   ADC 时钟走 ch32x035_adc.h 的 ADC_CLKConfig(ADCx, ADC_CLK_DivN)，
#   ch32x035_flash.h 里也没有 FLASH_PrefetchBufferCmd。
# L103 的 EVT 本地没有，按 full/rcc 生成 —— 这条在 pending 里标了「未对照 SDK 验证」。
MRS_PERIPHERAL_VERSION = {"CH32X035": "1.5", "CH32X033": "1.5", "CH32L103": "1.0"}

API_X035 = {
    "clockProfile": "hsi-only",
    # 实例名 USB1 在 SDK 里叫 USBFS
    "clockAliases": {"USB1": "USBFS"},
    "clockApi": "apb",
    "nvicApi": "stdlib",
    "gpioSpeedStyle": "mhz",
    "adcSampleStyle": "cycles",
    "flashLatency": True,
    "adcClock": "adc",
    "flashPrefetch": False,
    # ch32x035_gpio.h 里只有 GPIO_Speed_50MHz；GPIO_Mode 只有 AF_PP / AIN /
    # IN_FLOATING / IPD / IPU / Out_PP —— **没有开漏**
    "gpioSpeeds": ["50"],
    "gpioOpenDrain": False,
    # ch32x035_misc.h 只有 Group_0 / Group_1
    "nvicGroups": [0, 1],
    # ch32x035_adc.h 的采样时间是整数周期 ADC_SampleTime_4Cycles .. _11Cycles
    "adcSampleTimes": ["4", "5", "6", "7", "8", "9", "10", "11"],
    "note": "X035: RCC 无 PLL/SYSCLK/PCLK/ADCCLK；ADC 时钟用 ADC_CLKConfig；"
            "GPIO 只有 50MHz 且无开漏；NVIC 只有 Group_0/1；采样时间是整数周期",
}
API_L103 = {
    "clockProfile": "full",
    "clockApi": "apb",
    "nvicApi": "stdlib",
    "gpioSpeedStyle": "mhz",
    "adcSampleStyle": "cycles5",
    "flashLatency": True,
    "adcClock": "rcc",
    # 本地没有 CH32L103 EVT，无法确认有没有 FLASH_PrefetchBufferCmd。
    # 宁可少写一句（不加预取）也不要生成一个可能不存在的函数 —— 后者是编译错误。
    "flashPrefetch": False,
    "gpioSpeeds": ["2", "10", "50"],
    "gpioOpenDrain": True,
    "nvicGroups": [0, 1, 2, 3, 4],
    "adcSampleTimes": ["1.5", "7.5", "13.5", "28.5", "41.5", "55.5", "71.5", "239.5"],
    "note": "按 V30x 同族 API 推断，尚未对照 CH32L103 EVT 头文件验证",
}

# CH32L103RM V2.2 §11.2.3「DMA 请求映射」。
# 以**图 11-1**（每个通道的硬件请求连线）为准 —— 表格版有跨行合并单元格，
# 抽出来会错位；两者交叉核对后一致。
L103_DMA_MAP = {
    "1": ["ADC", "USART4_TX", "TIM2_CH3", "TIM4_CH1"],
    "2": ["SPI1_RX", "USART3_TX", "TIM1_CH1", "TIM2_UP", "TIM3_CH3"],
    "3": ["SPI1_TX", "USART3_RX", "TIM1_CH2", "TIM3_CH4", "TIM3_UP"],
    "4": ["SPI2_RX", "USART1_TX", "I2C2_TX", "TIM1_CH4", "TIM1_TRIG", "TIM1_COM", "TIM4_CH2"],
    "5": ["SPI2_TX", "USART1_RX", "I2C2_RX", "TIM1_UP", "TIM2_CH1", "TIM4_CH3"],
    "6": ["USART2_RX", "I2C1_TX", "TIM1_CH3", "TIM3_CH1", "TIM3_TRIG"],
    "7": ["USART2_TX", "I2C1_RX", "TIM2_CH2", "TIM4_UP"],
    "8": ["USART4_RX", "TIM2_CH4"],
}

# CH32L103RM V2.2 表9-1「向量表」，编号 16 起逐个抄。
# name 与 startup 里的 handler 前缀一致（V407 同族：USBHP/USBLP 就是 35/36）。
# ⚠ L103 没有 EVT，IRQn 枚举名未用真实头文件验证 —— 已写进 pending。
L103_IRQS = [
    {"n": 16, "name": "WWDG", "owner": "WWDG"},
    {"n": 17, "name": "PVD", "owner": "PWR"},
    {"n": 18, "name": "TAMPER", "owner": "PWR"},
    {"n": 19, "name": "RTC", "owner": "RTC", "gate": ["irqAlarm"]},
    {"n": 20, "name": "FLASH", "owner": "FLASH"},
    {"n": 21, "name": "RCC", "owner": "SYSTEM"},
    {"n": 22, "name": "EXTI0", "owner": "EXTI"},
    {"n": 23, "name": "EXTI1", "owner": "EXTI"},
    {"n": 24, "name": "EXTI2", "owner": "EXTI"},
    {"n": 25, "name": "EXTI3", "owner": "EXTI"},
    {"n": 26, "name": "EXTI4", "owner": "EXTI"},
    {"n": 27, "name": "DMA1_Channel1", "owner": "DMA"},
    {"n": 28, "name": "DMA1_Channel2", "owner": "DMA"},
    {"n": 29, "name": "DMA1_Channel3", "owner": "DMA"},
    {"n": 30, "name": "DMA1_Channel4", "owner": "DMA"},
    {"n": 31, "name": "DMA1_Channel5", "owner": "DMA"},
    {"n": 32, "name": "DMA1_Channel6", "owner": "DMA"},
    {"n": 33, "name": "DMA1_Channel7", "owner": "DMA"},
    {"n": 34, "name": "ADC", "owner": "ADC1", "gate": "irqEoc"},
    {"n": 35, "name": "USBHP", "owner": "USB1"},
    {"n": 36, "name": "USBLP", "owner": "USB1"},
    {"n": 38, "name": "CAN1_SCE", "owner": "CAN1"},
    {"n": 39, "name": "EXTI9_5", "owner": "EXTI"},
    {"n": 40, "name": "TIM1_BRK", "owner": "TIM1", "gate": "irqBreak"},
    {"n": 41, "name": "TIM1_UP", "owner": "TIM1", "gate": "irqUpdate"},
    {"n": 42, "name": "TIM1_TRG_COM", "owner": "TIM1",
     "gate": ["irqUpdate", "irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
    {"n": 43, "name": "TIM1_CC", "owner": "TIM1",
     "gate": ["irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
    {"n": 44, "name": "TIM2", "owner": "TIM2", "gate": "irqUpdate"},
    {"n": 45, "name": "TIM3", "owner": "TIM3", "gate": "irqUpdate"},
    {"n": 46, "name": "TIM4", "owner": "TIM4", "gate": "irqUpdate"},
    {"n": 47, "name": "I2C1_EV", "owner": "I2C1", "gate": "irqEvt"},
    {"n": 48, "name": "I2C1_ER", "owner": "I2C1", "gate": "irqErr"},
    {"n": 49, "name": "I2C2_EV", "owner": "I2C2", "gate": "irqEvt"},
    {"n": 50, "name": "I2C2_ER", "owner": "I2C2", "gate": "irqErr"},
    {"n": 51, "name": "SPI1", "owner": "SPI1"},
    {"n": 52, "name": "SPI2", "owner": "SPI2"},
    {"n": 53, "name": "USART1", "owner": "USART1"},
    {"n": 54, "name": "USART2", "owner": "USART2"},
    {"n": 55, "name": "USART3", "owner": "USART3"},
    {"n": 56, "name": "EXTI15_10", "owner": "EXTI"},
    {"n": 57, "name": "RTCAlarm", "owner": "RTC", "gate": "irqAlarm"},
    {"n": 58, "name": "LPTIM_WKUP", "owner": "LPTIM"},
    {"n": 59, "name": "USBFS", "owner": "USB1"},
    {"n": 60, "name": "USBFS_WKUP", "owner": "USB1"},
    {"n": 61, "name": "USART4", "owner": "USART4"},
    {"n": 62, "name": "DMA1_Channel8", "owner": "DMA"},
    {"n": 63, "name": "LPTIM", "owner": "LPTIM"},
    {"n": 64, "name": "OPA", "owner": "OPA1"},
    {"n": 65, "name": "USBPD", "owner": "USBPD"},
]

DEBUG_CAPS = {
    "twoWire": True,
    "singleWire": False,
    "note": "串行 2 线调试接口（SDI）：SWDIO + SWCLK。系统上电或复位后默认开启，"
            "主程序里可以关掉把这两个脚释放成普通 GPIO。",
}


def main():
    l103 = load("l103p.json")
    x035 = load("x035p.json")
    l103_xy = load_opt("l103xy.json")
    x035_xy = load_opt("x035xy.json")
    def sib_map(rows):
        out = {}
        for g in bonded_groups(rows).values():
            for n in g:
                out[n] = g - {n}
        return out

    l103 = consensus(l103, l103_xy, sib_map(l103))
    x035 = consensus(x035, x035_xy, sib_map(x035))

    # ── CH32L103 ────────────────────────────────────────────────────────────
    l103_pkgs = [
        ("F8P6", "CH32L103F8P6", "TSSOP20", "dual"),
        ("F8U6", "CH32L103F8U6", "QFN20", "qfn"),
        ("G8R6", "CH32L103G8R6", "QSOP28", "dual"),
        ("K8U", "CH32L103K8U6", "QFN32", "qfn"),
        ("C8T6", "CH32L103C8T6", "LQFP48", "quad"),
    ]
    l103_ports = apply_debug_pins(apply_clock_pins(build_ports(l103, L103_RULES)), "L103")
    l103_json = {
        "packVersion": "0.1.0",
        "series": "CH32L103",
        "vendor": "WCH",
        "core": "QingKe V4C · RV32IMAFC",
        "source": "CH32L103DS0 V2.1 表2-1-1（引脚定义）、表1-1（资源）",
        "flashKb": 64,
        "ramKb": 20,
        "voltage": "1.8 – 3.6 V",
        "maxSysclk": 96,
        "extiLines": 16,
        "dmaChannels": 8,
        "dmaMap": L103_DMA_MAP,
        "debug": {**DEBUG_CAPS, "swdio": "PA13", "swclk": "PA14"},
        "api": API_L103,
        "peripheralVersion": "1.0",
        "clock": {
            "hsi": 8,
            "hseOptions": [4, 8, 12, 16, 24],
            "lsi": 40,
            "pllSource": "HSI",
            "pllMin": 5,
            "pllMax": 12,
            "maxSysclk": 96,
            "ahbDivs": [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
            "apb1Divs": [1, 2, 4, 8, 16],
            "apb2Divs": [1, 2, 4, 8, 16],
            "adcDivs": [2, 4, 6, 8, 12, 16],
            "notes": [
                "PLL 输入 3–25 MHz，输出 18–96 MHz（表3-16）",
                "USBFS 需要 PLL = 48 / 72 / 96 MHz 之一",
            ],
        },
        "packages": [build_package(l103, k, i, lab, shp) for k, i, lab, shp in l103_pkgs],
        "ports": l103_ports,
        "peripherals": peripherals_from(
            l103_ports,
            {"USART1", "USART2", "USART3", "USART4", "SPI1", "SPI2", "I2C1", "I2C2",
             "TIM1", "TIM2", "TIM3", "TIM4", "LPTIM", "ADC1", "OPA1",
             "CMP1", "CMP2", "CMP3", "CAN1", "USB1", "USBPD", "SYSTEM", "PIOC", "CLK"},
        ),
        "irqs": L103_IRQS,
        "pending": [
            "中断向量编号已按 CH32L103RM V2.2 表9-1 逐条录入；IRQn 枚举名按同族命名惯例推断，"
            "尚未用 L103 的 EVT 头文件验证（本地没有 L103 EVT）",
            "生成的代码尚未对照 CH32L103 EVT 的 SDK 头文件验证（本地只有 X035 EVT）；"
            "X035 已用真实 EVT 通过符号比对 + gcc 语法检查",

            "CH32L103K8U7 与 K8U6 引脚完全相同，仅温度范围不同",
            "引脚号已按数据手册逐脚核对；复用功能表由 PDF 自动提取，"
            "个别引脚可能漏项或混入相邻引脚的信号，需按 "
            "docs/llm-pin-extraction-prompt.md 复核",
        ],
    }
    l103_json["peripherals"] = with_core(l103_json["peripherals"], L103_CORE)

    # ── CH32X035 ────────────────────────────────────────────────────────────
    x035_pkgs = [
        ("R8T6", "CH32X035R8T6", "LQFP64M", "quad"),
        ("C8T6", "CH32X035C8T6", "LQFP48", "quad"),
        ("G8U6", "CH32X035G8U6", "QFN28", "qfn"),
        ("G8R6", "CH32X035G8R6", "QSOP28", "dual"),
        ("F8U6", "CH32X035F8U6", "QFN20", "qfn"),
        ("F7P6", "CH32X035F7P6", "TSSOP20", "dual"),
        ("D8U6", "CH32X035D8U6", "QFN12", "qfn"),
    ]
    x035_ports = apply_debug_pins(apply_port_alias(build_ports(x035, X035_RULES)), "X035")
    x035_json = {
        "packVersion": "0.1.0",
        "series": "CH32X035",
        "vendor": "WCH",
        "core": "QingKe V4C · RV32IMAC",
        "source": "CH32X035/X033DS0 V2.3 表2-1（引脚定义）、表1-1（资源）、CH32X035RM V1.9 表7-1",
        "flashKb": 62,
        "ramKb": 20,
        "voltage": "2.0 – 5.5 V",
        "maxSysclk": 48,
        "extiLines": 24,
        "dmaChannels": 8,
        "dmaMap": X035_DMA_MAP,
        "debug": {**DEBUG_CAPS, "swdio": "PC18", "swclk": "PC19"},
        "api": API_X035,
        "peripheralVersion": "1.5",
        "clock": {
            "hsi": 48,
            "hseOptions": [],
            "lsi": 47,
            "pllSource": "HSI",
            "pllMin": 1,
            "pllMax": 1,
            "maxSysclk": 48,
            "ahbDivs": [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
            "apb1Divs": [1, 2, 4, 8, 16],
            "apb2Divs": [1, 2, 4, 8, 16],
            "adcDivs": [2, 4, 6, 8],
            "notes": [
                "CH32X035 只有内部 48 MHz RC 振荡器，无 HSE、无 PLL（DS 1.4.6）",
                "复位后 HSI/6 = 8 MHz 作为默认 SYSCLK",
            ],
        },
        "packages": [build_package(x035, k, i, lab, shp) for k, i, lab, shp in x035_pkgs],
        "ports": x035_ports,
        "peripherals": peripherals_from(
            x035_ports,
            {"USART1", "USART2", "USART3", "USART4", "SPI1", "I2C1",
             "TIM1", "TIM2", "TIM3", "ADC1", "OPA1", "OPA2",
             "CMP1", "CMP2", "CMP3", "USB1", "USBPD", "PIOC", "SYSTEM"},
        ),
        "irqs": [
            # 名称与编号逐条抄自 ch32x035.h 的 IRQn 枚举，handler 名与 startup_ch32x035.S 一致。
            # gate 用的是 schemas.ts 里真实的参数键（以前写的 itUp / itBrk 那些键**根本不存在**，
            # 结果是所有带 gate 的中断一个都生成不出来）。
            {"n": 16, "name": "WWDG", "owner": "WWDG"},
            {"n": 17, "name": "PVD", "owner": "PWR"},
            {"n": 18, "name": "FLASH", "owner": "FLASH"},
            {"n": 20, "name": "EXTI7_0", "owner": "EXTI"},
            {"n": 21, "name": "AWU", "owner": "PWR"},
            {"n": 22, "name": "DMA1_Channel1", "owner": "DMA"},
            {"n": 23, "name": "DMA1_Channel2", "owner": "DMA"},
            {"n": 24, "name": "DMA1_Channel3", "owner": "DMA"},
            {"n": 25, "name": "DMA1_Channel4", "owner": "DMA"},
            {"n": 26, "name": "DMA1_Channel5", "owner": "DMA"},
            {"n": 27, "name": "DMA1_Channel6", "owner": "DMA"},
            {"n": 28, "name": "DMA1_Channel7", "owner": "DMA"},
            {"n": 29, "name": "ADC1", "owner": "ADC1", "gate": "irqEoc"},
            {"n": 30, "name": "I2C1_EV", "owner": "I2C1", "gate": "irqEvt"},
            {"n": 31, "name": "I2C1_ER", "owner": "I2C1", "gate": "irqErr"},
            {"n": 32, "name": "USART1", "owner": "USART1"},
            {"n": 33, "name": "SPI1", "owner": "SPI1"},
            {"n": 34, "name": "TIM1_BRK", "owner": "TIM1", "gate": "irqBreak"},
            {"n": 35, "name": "TIM1_UP", "owner": "TIM1", "gate": "irqUpdate"},
            {"n": 36, "name": "TIM1_TRG_COM", "owner": "TIM1",
             "gate": ["irqUpdate", "irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
            {"n": 37, "name": "TIM1_CC", "owner": "TIM1",
             "gate": ["irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
            {"n": 38, "name": "TIM2_UP", "owner": "TIM2", "gate": "irqUpdate"},
            {"n": 39, "name": "USART2", "owner": "USART2"},
            {"n": 40, "name": "EXTI15_8", "owner": "EXTI"},
            {"n": 41, "name": "EXTI25_16", "owner": "EXTI"},
            {"n": 42, "name": "USART3", "owner": "USART3"},
            {"n": 43, "name": "USART4", "owner": "USART4"},
            {"n": 44, "name": "DMA1_Channel8", "owner": "DMA"},
            {"n": 45, "name": "USBFS", "owner": "USB1"},
            {"n": 46, "name": "USBFSWakeUp", "owner": "USB1"},
            {"n": 47, "name": "PIOC", "owner": "PIOC"},
            {"n": 48, "name": "OPA", "owner": "OPA1"},
            {"n": 49, "name": "USBPD", "owner": "USBPD"},
            {"n": 50, "name": "USBPDWakeUp", "owner": "USBPD"},
            {"n": 51, "name": "TIM2_CC", "owner": "TIM2",
             "gate": ["irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
            {"n": 52, "name": "TIM2_TRG_COM", "owner": "TIM2",
             "gate": ["irqUpdate", "irqCC1", "irqCC2", "irqCC3", "irqCC4"]},
            {"n": 53, "name": "TIM2_BRK", "owner": "TIM2", "gate": "irqBreak"},
            {"n": 54, "name": "TIM3", "owner": "TIM3", "gate": "irqUpdate"},
        ],
        "pending": [
            "X035 的 AF 表使用数据手册缩写（T2C1 / A10 / C1P0），已按 2.1 节图例展开",
            "封装图中的 OPA/CMP 编号（O1N2 表示 OPA1_N2）按图例解释，个别型号可能只引出一组 OPA",
            "引脚号已按数据手册逐脚核对；复用功能表由 PDF 自动提取并展开缩写，"
            "个别引脚可能漏项，需按 docs/llm-pin-extraction-prompt.md 复核",
        ],
    }
    x035_json["peripherals"] = with_core(x035_json["peripherals"], X035_CORE)

    # ── CH32X033 ────────────────────────────────────────────────────────────
    # 20-pin TSSOP20; the pin table (表2-2) is short enough to transcribe.
    x033_map = {
        1: "PA6", 2: "PA7", 3: "PB1", 4: "PB7", 5: "PC16", 6: "PC17",
        7: "GND", 8: "PC18", 9: "VDD", 10: "PA9", 11: "PA11", 12: "PA10",
        13: "PC3", 14: "PA0", 15: "PA1", 16: "PA2", 17: "PA3", 18: "PC19",
        19: "PA4", 20: "PA5",
    }
    x033_pins = []
    for num, name in sorted(x033_map.items()):
        pin = {"num": num, "name": name, "kind": kind_of(name)}
        if num == 2:
            pin["note"] = "与 PB0 内部短接"
        x033_pins.append(pin)
    x033_json = {
        "packVersion": "0.1.0",
        "series": "CH32X033",
        "vendor": "WCH",
        "core": "QingKe V4C · RV32IMAC",
        "source": "CH32X035/X033DS0 V2.3 表2-2（CH32X033引脚定义）",
        "flashKb": 62,
        "ramKb": 20,
        "voltage": "2.0 – 5.5 V",
        "maxSysclk": 48,
        "extiLines": 24,
        "dmaChannels": 8,
        "dmaMap": X035_DMA_MAP,
        "debug": {**DEBUG_CAPS, "swdio": "PC18", "swclk": "PC19"},
        "api": API_X035,
        # X033 与 X035 是同一颗 die，**共用同一套 SDK 头文件**（ch32x035.h）。
        # 写成 ch32x033.h 会直接找不到文件 —— 而且 ch32x035.h 自己会
        # #include "ch32x035_conf.h"，所以我们的 conf 也必须叫这个名字。
        "sdkHeader": "ch32x035",
        "peripheralVersion": "1.5",
        "clock": x035_json["clock"],
        "packages": [{"id": "CH32X033F8P6", "label": "TSSOP20",
                      "shape": "dual", "pins": x033_pins}],
        "ports": {k: v for k, v in x035_ports.items()
                  if k in {p["name"] for p in x033_pins}},
        "peripherals": [],
        "irqs": x035_json["irqs"],
        "pending": [
            "X033 与 X035 同die，复用功能表沿用 X035 的端口信号（表2-2 已逐脚核对）",
            "X033 只有 USB Device，无 USB Host / USBPD",
        ],
    }
    x033_json["peripherals"] = with_core(peripherals_from(
        x033_json["ports"],
        {"USART1", "USART2", "USART3", "USART4", "SPI1", "I2C1",
         "TIM1", "TIM2", "TIM3", "ADC1", "OPA1", "OPA2",
         "CMP1", "CMP2", "CMP3", "USB1", "PIOC", "SYSTEM"},
    ), X035_CORE)

    io.open(f"{OUT}/ch32x033.json", "w", encoding="utf-8").write(
        json.dumps(x033_json, ensure_ascii=False, indent=1))

    io.open(f"{OUT}/ch32l103.json", "w", encoding="utf-8").write(
        json.dumps(l103_json, ensure_ascii=False, indent=1))
    io.open(f"{OUT}/ch32x035.json", "w", encoding="utf-8").write(
        json.dumps(x035_json, ensure_ascii=False, indent=1))
    print("wrote ch32l103.json / ch32x035.json")
    print("L103 ports:", len(l103_ports), " X035 ports:", len(x035_ports))


if __name__ == "__main__":
    main()
