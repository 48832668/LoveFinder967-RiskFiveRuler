# -*- coding: utf-8 -*-
"""按 DS0 表2-3-x 仲裁 V407 复用表的 9 处「同组双引脚」矛盾。

这些条目是早期提取时把相邻行/相邻列串了行。逐条与原表核对过：

  信号            原数据                        DS 原文（表2-3-x）            处理
  TIM1_CH1     PA8(0) PA8(1) PB9(1) PE9(3)   PA8 / PA8 / PE9              删 PB9(1)
  TIM1_CH3N    PB15(0) PB1(1) PB7(3) PE12(3)  PB15 / PB1 / PE12            删 PB7(3)
  TIM3_CH1     PA6(0) PB3(2) PB4(2) PC6(3)   PA6 / PB4 / PC6              删 PB3(2)
  TIM3_CH2     PA7(0) PB4(2) PB5(2) PC7(3)   PA7 / PB5 / PC7              删 PB4(2)
  TIM8_CH2     PC7(0) PB6(1) PB7(1)          PC7 / PB7                    删 PB6(1)
  I2S3_MCK     PA8(0) PC7(0) PC7(1)          PC7 / PC7                    删 PA8(0)
  USART10_RX   PE1(0) PB9(1) PB9(2) PD12(2/3) PE1 / PB9 / PD12(RM=1x)      删 PB9(2)
  SDIO_D1      PB15(0) PB9(0)                PC9 / (PB15 条件) / PB15     换成 PC9(0)+PB15(1)
  SDIO_D0      PC8(0)                        PC8 / (PB14 条件) / PB14     补 PB14(1)
  FSMC_NADV    PB6(1) PB7(0) PB7(1)          PB7 / (PD2 条件) / PB7       删 PB6(1)

「条件重映射」列（SDIOEN&ETHMACEN、FSMCEN&USBHS2EN 同开才生效）本工具
没有建模载体，继续留在 pending 里说明。

用法：python scripts/fix_v407_contradictions.py            # 只报告
      python scripts/fix_v407_contradictions.py --write    # 写回
"""
import json
import sys

DATA = "src/devices/data/ch32v407.json"
WRITE = "--write" in sys.argv

# (fn, pin, remap) → 删除
REMOVE = [
    ("TIM1_CH1", "PB9", 1),
    ("TIM1_CH3N", "PB7", 3),
    ("TIM3_CH1", "PB3", 2),
    ("TIM3_CH2", "PB4", 2),
    ("TIM8_CH2", "PB6", 1),
    ("I2S3_MCK", "PA8", 0),
    ("USART10_RX", "PB9", 2),
    ("SDIO_D1", "PB15", 0),
    ("SDIO_D1", "PB9", 0),
    ("FSMC_NADV", "PB6", 1),
]
# (fn, pin, remap) → 新增
ADD = [
    ("SDIO_D1", "PC9", 0),
    ("SDIO_D1", "PB15", 1),
    ("SDIO_D0", "PB14", 1),
]


def main():
    data = json.load(open(DATA, encoding="utf-8"))
    ports = data["ports"]
    removed, added = [], []

    for fn, pin, remap in REMOVE:
        arr = ports.get(pin, [])
        before = len(arr)
        ports[pin] = [e for e in arr if not (e["fn"] == fn and int(e.get("remap", 0)) == remap)]
        if len(ports[pin]) != before:
            removed.append(f"{fn} {pin}[{remap}]")

    for fn, pin, remap in ADD:
        arr = ports.setdefault(pin, [])
        if any(e["fn"] == fn and int(e.get("remap", 0)) == remap for e in arr):
            continue
        arr.append({"fn": fn} if remap == 0 else {"fn": fn, "remap": str(remap)})
        added.append(f"{fn} {pin}[{remap}]")

    print(f"删除 {len(removed)} 条：")
    for r in removed:
        print("   -", r)
    print(f"新增 {len(added)} 条：")
    for a in added:
        print("   +", a)

    if WRITE:
        # pending 里「源表内部矛盾」那条已解决，换成本次的仲裁记录
        data["pending"] = [
            p for p in data.get("pending", []) if "源表内部矛盾" not in p
        ]
        data["pending"].append(
            "表2-3-x 的 9 处「同组双引脚」矛盾已按 DS 原文仲裁"
            "（scripts/fix_v407_contradictions.py，删 10 条串行项、补 SDIO_D0/D1 的 RM=1 重映射）；"
            "SDIO/FSMC 的「条件重映射」列（与 ETHMAC/USBHS2 同开才生效）仍无建模载体"
        )
        json.dump(data, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n已写回 {DATA}")
    else:
        print("\n（只报告模式；加 --write 才会写回）")


if __name__ == "__main__":
    main()
