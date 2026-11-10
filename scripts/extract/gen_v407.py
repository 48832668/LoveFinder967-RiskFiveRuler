# -*- coding: utf-8 -*-
"""Build the CH32V407 device packs from the parsed pin table + the real EVT headers.

CH32V407 是 V407/V467 两个兄弟型号、4 个封装（QFN32/LQFP64/QFN68/LQFP100）。
和 X035 一样，**它的标准外设库与 V30x 那套不是一套**，差异全部从
`CH32V407EVT/EVT/EXAM/SRC/Peripheral/inc` 里核出来，写进 `api` profile：

| 维度 | V407 实际 | 旧系列 |
| --- | --- | --- |
| 时钟使能 | `RCC_PB2PeriphClockCmd` / `RCC_PB1PeriphClockCmd` / `RCC_HBPeriphClockCmd` | `RCC_APB2PeriphClockCmd` … |
| 时钟宏前缀 | `RCC_PB2Periph_GPIOA` / `RCC_HBPeriph_DMA1` | `RCC_APB2Periph_GPIOA` / `RCC_AHBPeriph_DMA1` |
| NVIC | 只有 core_riscv.h 的 `NVIC_EnableIRQ` / `NVIC_SetPriority`（**没有 NVIC_Init**） | `NVIC_Init` + `NVIC_PriorityGroupConfig` |
| GPIO 速度 | `GPIO_Speed_Low/Medium/High` 枚举 | `GPIO_Speed_10MHz` |
| ADC 采样时间 | `ADC_SampleTime_CyclesMode0..7` | `ADC_SampleTime_55Cycles5` |
| Flash | 没有 `FLASH_SetLatency` / `FLASH_PrefetchBufferCmd` | 有 |

用法：
  python gen_v407.py <v407p.json> <inc 目录> <out 目录>
"""

import io
import json
import os
import re
import sys

src, inc_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]

rows = json.load(io.open(src, encoding="utf-8"))

# ── 1. 补 PB6：PDF 把注标 `（12）` 挤进了引脚号列，四个封装号都读不到。
#       依据是相邻的 PB5/PB7（29/58/60/91 与 31/60/62/93）。
PB6 = {"KEU6": 30, "RET6": 59, "WEU6": 61, "VET6": 92}
if not any(r["name"].startswith("PB6") for r in rows):
    i = next(i for i, r in enumerate(rows) if r["name"].startswith("PB7"))
    rows.insert(i, {"pkg": dict(PB6), "name": "PB6", "type": "I/O", "level": "-",
                    "main": "PB6", "af": ["TIM4_CH1", "I2C1_SCL", "USBHS2_DM", "DVP_D5"],
                    "remap": ["USART1_TX_1"]})

# ── 2. 引脚名归一化 ────────────────────────────────────────────────────
POWER = {"VDD", "VSS", "VDDA", "VSSA", "VREF+", "VREF-", "VBAT", "VDDK", "VDD18", "VDD33"}
POWER_NOTE = {
    "VDDK": "内核电压引脚（外接去耦，不要当 GPIO）",
    "VDD18": "内部 1.8V 稳压输出（外接电容）",
    "VREF-": "ADC 负参考（一般接 VSSA）",
    "VREF+": "ADC 正参考 2.4–3.6V",
    "VDDA": "模拟电源 2.9–3.6V",
    "VSSA": "模拟地",
}


def split_name(raw):
    """`PC13-TAMPER-RTC` -> ("PC13", note)；`OSC_IN` / `VREF-` 原样返回。"""
    n = raw.replace(" ", "")
    n = re.sub(r"（\d+）|\(\d+\)", "", n)
    if n in POWER:
        return n, POWER_NOTE.get(n)
    # 复用脚写法：`PC13-TAMPER-RTC`、`PC14-OSC32_IN`、`PA0-WKUP`
    m = re.match(r"^(P[A-E]\d+)-(.+)$", n)
    if m:
        port, extra = m.group(1), m.group(2)
        notes = {
            "TAMPER-RTC": "兼作侵入检测 / RTC 输出",
            "OSC32_IN": "兼作 LSE 32.768 kHz 输入",
            "OSC32_OUT": "兼作 LSE 32.768 kHz 输出",
            "WKUP": "兼作唤醒输入",
        }
        return port, notes.get(extra, extra)
    m = re.match(r"^(P[A-E]\d+)", n)
    if m:
        return m.group(1), None
    return n, None


def kind_of(name):
    if name in POWER:
        return "power"
    if name == "NRST":
        return "reset"
    if name.startswith(("OSC", "PD0", "PD1")):
        return "osc"
    return "io"


# ── 3. AF 展开：`USART6_TX_3` -> fn=USART6_TX, remap=3 ─────────────────
# 结尾的 `_<数字>` 是重映射组号。注意 ADC_IN12 / TIM3_CH3 这类本身带数字，
# 只有当「去掉尾部数字后仍是合法信号名」时才算重映射。
SIGNAL_TAIL = re.compile(
    r"_(TX|RX|CK|CTS|RTS|SCK|MISO|MOSI|NSS|SDA|SCL|SMBA|CH\dN?|ETR|BKIN|"
    r"IN\d+|OUT\d*|[PN]\d+|D[0-9]+|DP|DM|HSYNC|VSYNC|DE|CLK|R[0-9]|G[0-9]|B[0-9]|"
    r"A\d+|D\d+|NE\d+|NWE|NOE|NADV|NBL\d|CD|WP|MCK|WS|SD|EXT|TRIG|COM|UP|BK)$"
)

REMAP_SUFFIX = re.compile(r"^(.*?)_(\d+)$")


def split_remap(tok):
    m = REMAP_SUFFIX.match(tok)
    if not m:
        return tok, None
    base, num = m.group(1), m.group(2)
    # 只有 base 本身以合法信号结尾时才认这个后缀
    if SIGNAL_TAIL.search(base):
        return base, num
    return tok, None


# 手册里单实例外设的 AF 名不带编号（`I2C_SCL`、`CAN_TX`、`ADC_IN12`），
# 而工具内部（以及 SDK 的时钟宏）用带编号的实例名。这里统一补成 X1。
SINGLETON = {"I2C": "I2C1", "CAN": "CAN1", "OPA": "OPA1", "ADC": "ADC1",
             "I3C": "I3C1", "DAC": "DAC1"}


def norm_fn(fn):
    periph, sig = fn.split("_", 1)
    periph = SINGLETON.get(periph, periph)
    return f"{periph}_{sig}"


def build_ports(rows):
    ports = {}
    for r in rows:
        name, _note = split_name(r["name"])
        if kind_of(name) != "io":
            continue
        sigs = []
        seen = set()
        for tok in list(r.get("af", [])) + list(r.get("remap", [])):
            tok = tok.strip().rstrip("_")
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", tok):
                continue
            base, remap = split_remap(tok)
            # 必须形如 <外设>_<信号>
            if "_" not in base:
                continue
            periph, sig = base.split("_", 1)
            if not SIGNAL_TAIL.search("_" + sig):
                continue
            base = norm_fn(base)
            key = (base, remap)
            if key in seen:
                continue
            seen.add(key)
            sigs.append({"fn": base, "remap": remap} if remap else {"fn": base})
        if sigs:
            ports[name] = sigs
    return ports


# ── 4. IRQ 表：从 ch32v4x7.h 的 IRQn 枚举直接读，handler 名与 startup 一致
IRQ_OWNER = [
    ("WWDG", "WWDG"), ("PVD", "PWR"), ("TAMPER", "PWR"), ("RTC", "RTC"),
    ("FLASH", "FLASH"), ("RCC", "SYSTEM"),
    ("EXTI0", "EXTI"), ("EXTI1", "EXTI"), ("EXTI2", "EXTI"), ("EXTI3", "EXTI"),
    ("EXTI4", "EXTI"),
    ("ADC1_2", "ADC1"), ("CAN1_TX", "CAN1"), ("CAN1_RX0", "CAN1"), ("CAN1_RX1", "CAN1"),
    ("CAN1_SCE", "CAN1"), ("EXTI9_5", "EXTI"),
    ("TIM1_BRK", "TIM1"), ("TIM1_UP", "TIM1"), ("TIM1_TRG_COM", "TIM1"), ("TIM1_CC", "TIM1"),
    ("TIM2", "TIM2"), ("TIM3", "TIM3"), ("TIM4", "TIM4"),
    ("I2C1_EV", "I2C1"), ("I2C1_ER", "I2C1"), ("I3C_EV", "I3C"), ("I3C_ER", "I3C"),
    ("SPI1", "SPI1"), ("SPI2", "SPI2"),
    ("USART1", "USART1"), ("USART2", "USART2"), ("USART3", "USART3"),
    ("EXTI15_10", "EXTI"), ("RTCAlarm", "RTC"),
    ("TIM8_BRK", "TIM8"), ("TIM8_UP", "TIM8"), ("TIM8_TRG_COM", "TIM8"), ("TIM8_CC", "TIM8"),
    ("RNG", "RNG"), ("SDIO", "SDIO"),
    ("TIM5", "TIM5"), ("SPI3", "SPI3"), ("USART4", "USART4"), ("USART5", "USART5"),
    ("TIM6", "TIM6"), ("TIM7", "TIM7"),
    ("ETH", "ETH"), ("ETH_WKUP", "ETH"), ("LTDC", "LTDC"),
]

# gate：只有对应中断使能位打开才生成 NVIC 配置
IRQ_GATE = {
    "TIM1_BRK": "irqBreak", "TIM1_UP": "irqUpdate",
    "TIM1_TRG_COM": ["irqUpdate", "irqCC1", "irqCC2", "irqCC3", "irqCC4"],
    "TIM1_CC": ["irqCC1", "irqCC2", "irqCC3", "irqCC4"],
    "TIM8_BRK": "irqBreak", "TIM8_UP": "irqUpdate",
    "TIM8_TRG_COM": ["irqUpdate", "irqCC1", "irqCC2", "irqCC3", "irqCC4"],
    "TIM8_CC": ["irqCC1", "irqCC2", "irqCC3", "irqCC4"],
    "TIM2": "irqUpdate", "TIM3": "irqUpdate", "TIM4": "irqUpdate",
    "TIM5": "irqUpdate", "TIM6": "irqUpdate", "TIM7": "irqUpdate",
    "I2C1_EV": "irqEvt", "I2C1_ER": "irqErr",
    "ADC1_2": "irqEoc", "RTC": "irqAlarm", "RTCAlarm": "irqAlarm",
}


def parse_irqs(inc_dir):
    text = io.open(os.path.join(inc_dir, "ch32v4x7.h"), encoding="utf-8", errors="replace").read()
    found = {}
    for m in re.finditer(r"(\w+)_IRQn\s*=\s*(\d+)", text):
        found[m.group(1)] = int(m.group(2))
    out = []
    owner = dict(IRQ_OWNER)
    for name, n in sorted(found.items(), key=lambda kv: kv[1]):
        if name not in owner:
            continue
        item = {"n": n, "name": name, "owner": owner[name]}
        if name in IRQ_GATE:
            item["gate"] = IRQ_GATE[name]
        out.append(item)
    return out


# ── 5. 外设列表 ────────────────────────────────────────────────────────
# 只要引脚上出现过该实例，就认为这颗片子上有它。核心外设（无引脚）单独补。
CORE = ["GPIO", "SYSTEM", "DBG", "PWR", "EXTI", "DMA", "IWDG", "WWDG", "CRC", "RTC", "FLASH"]


def build_peripherals(ports):
    sigs = {}
    for plist in ports.values():
        for s in plist:
            pid, sig = s["fn"].split("_", 1)
            sigs.setdefault(pid, set()).add(sig)
    out = [{"id": pid, "signals": sorted(v)} for pid, v in sorted(sigs.items())]
    have = {p["id"] for p in out}
    for c in CORE:
        if c not in have:
            out.append({"id": c, "signals": []})
    return out


# ── 6. 封装 ───────────────────────────────────────────────────────────
PKGS = [
    ("KEU6", "CH32V407KEU6", "QFN32", "qfn"),
    ("RET6", "CH32V407RET6", "LQFP64", "quad"),
    ("WEU6", "CH32V407WEU6", "QFN68", "qfn"),
    ("VET6", "CH32V407VET6", "LQFP100", "quad"),
]


def build_package(rows, key, pkg_id, label, shape):
    pins = []
    for r in rows:
        num = r["pkg"].get(key)
        if not num:
            continue
        name, note = split_name(r["name"])
        pin = {"num": num, "name": name, "kind": kind_of(name)}
        if note:
            pin["note"] = note
        pins.append(pin)
    merged, order = {}, []
    for p in pins:
        n = p["num"]
        if n not in merged:
            merged[n] = dict(p)
            order.append(n)
        elif merged[n]["name"] != p["name"]:
            merged[n].setdefault("aliases", []).append(p["name"])
    return {"id": pkg_id, "label": label, "shape": shape,
            "pins": [merged[n] for n in sorted(order)]}


ports = build_ports(rows)
irqs = parse_irqs(inc_dir)

pack = {
    "packVersion": "0.1.0",
    "series": "CH32V407",
    "vendor": "WCH",
    "core": "QingKe V3V · RV32IMAFCXV",
    "source": "CH32V407DS0 V1.4 表2-1-1（引脚定义）+ CH32V407EVT 头文件",
    "sdkHeader": "ch32v4x7",
    "flashKb": 512,
    "ramKb": 200,
    "voltage": "2.9 – 3.6 V",
    "maxSysclk": 200,
    "extiLines": 16,
    "dmaChannels": 13,
    "peripheralVersion": "1.0",
    "api": {
        "clockProfile": "full",
        # V407 的时钟使能叫 PB1/PB2/HB（不是 APB1/APB2/AHB）
        "clockApi": "pb",
        # 只有 core_riscv.h 的 NVIC_EnableIRQ，没有 NVIC_Init / PriorityGroup
        "nvicApi": "cmsis",
        "adcClock": "rcc",
        "flashPrefetch": False,
        "flashLatency": False,
        "gpioSpeedStyle": "level",
        "gpioSpeeds": ["Low", "Medium", "High"],
        "gpioOpenDrain": True,
        "nvicGroups": [],
        "adcSampleStyle": "cyclesmode",
        "adcSampleTimes": ["CyclesMode0", "CyclesMode1", "CyclesMode2", "CyclesMode3",
                           "CyclesMode4", "CyclesMode5", "CyclesMode6", "CyclesMode7"],
        # ch32v4x7_rcc.h 里 RCC_PLLMul 只有这些档位（注意**没有 25**）
        "pllMuls": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
                    24, 26, 28, 30, 32, 34, 36, 38, 40],
        # 没有 RCC_PCLK1_Div*（APB1 不分频）；PCLK2 只有 2/4/6/8
        "apb1Divs": [],
        "apb2Divs": [2, 4, 6, 8],
        "adcDivs": [2, 4, 6, 8],
        "note": "V407: RCC 用 PB1/PB2/HB 命名；NVIC 走 core_riscv.h 的 CMSIS 接口；"
                "GPIO 速度是 Low/Medium/High；ADC 采样时间是 CyclesMode0..7；"
                "Flash 没有 SetLatency/PrefetchBufferCmd",
    },
    "debug": {
        "twoWire": True,
        # 数据手册：「SWCLK 1/2-wire」—— V407 的调试口支持单线
        "singleWire": True,
        "swdio": "PA13",
        "swclk": "PA14",
        "note": "1/2 线调试接口（SDI）。复位后默认开启，可在主程序里关闭释放 PA13/PA14。",
    },
    "clock": {
        "hsi": 8,
        "hseOptions": [8, 16, 25],
        "lsi": 40,
        "pllSource": "HSI",
        "pllMin": 8,
        "pllMax": 40,
        "maxSysclk": 200,
        "ahbDivs": [1, 2, 4, 8, 16],
        "apb1Divs": [1],
        "apb2Divs": [2, 4, 6, 8],
        "adcDivs": [2, 4, 6, 8],
        "notes": [
            "HSI 8 MHz → PLL → 最高 200 MHz（DS 表1-1）",
            "PLL 分频/倍频组合见 CH32V407RM「RCC」章节",
        ],
    },
    "packages": [build_package(rows, k, pid, lab, shp) for k, pid, lab, shp in PKGS],
    "ports": ports,
    "peripherals": build_peripherals(ports),
    "irqs": irqs,
    "pending": [
        "DMA 通道 ↔ 硬件请求的映射需从 CH32V407RM「DMA 请求映射」补录；"
        "当前只校验通道不重复（V407 有 DMA1 13 通道 + DMA2 5 通道）",
        "PLL 倍频范围、ADC 分频可选值按同族惯例填写，需对照 CH32V407RM 的 RCC 章节复核",
        "ETH / LTDC / DVP / FSMC / SDIO / ARGB / I3C / USBHS 这些外设只生成时钟使能 + TODO，"
        "参数建模待补（它们的配置项是系列专属枚举）",
        "复用功能表由 PDF 自动提取（AF 名带 _N 重映射后缀），个别引脚可能漏项，"
        "需按 docs/llm-pin-extraction-prompt.md 复核",
    ],
}

# ── 7. 输出 ───────────────────────────────────────────────────────────
os.makedirs(out_dir, exist_ok=True)
banner = (
    "/* 由 RiskFiveRuler 生成：scripts/extract/gen_v407.py\n"
    " * 数据来源：CH32V407DS0 V1.4 表2-1-1 + CH32V407EVT 头文件\n"
    " * 复核说明见 JSON 的 pending 字段 */\n"
)
io.open(os.path.join(out_dir, "ch32v407.json"), "w", encoding="utf-8").write(
    banner + json.dumps(pack, ensure_ascii=False, indent=1))

print("V407 ports:", len(ports), " periphs:", len(pack["peripherals"]),
      " irqs:", len(irqs))
for k, pid, lab, _ in PKGS:
    p = next(x for x in pack["packages"] if x["id"] == pid)
    nums = sorted(x["num"] for x in p["pins"])
    print(f"  {pid:<16}{lab:<8}{len(nums):>4} 脚  max={max(nums) if nums else 0}")
