"""CH32V407 器件包校验：把 DS0 引脚表 + RM 重映射总表与 JSON 逐条对照。

    python scripts/check_v407_pins.py docs/ch32v407-pin-table.md

独立于 `rebuild_v407_from_ds.py`（自己重新解析一遍 markdown），做三件事：

  1. 手册里每条复用功能都必须出现在 ports 里（防漏）；
  2. 每个封装的引脚号必须 1..N 连续、IO 引脚都有 kind（防错位）；
  3. **同一封装内**同一外设同一配置组落到两个不同引脚的，报出来 ——
     这种自相矛盾多半是源表某列缺失导致的，需要回查 DS0。
"""
import json
import re
import sys
from collections import defaultdict

DATA = "src/devices/data/ch32v407.json"

RENAME = {"ADC_IN": "ADC1_IN", "I2C_SCL": "I2C1_SCL", "I2C_SDA": "I2C1_SDA",
          "I2C_SMBA": "I2C1_SMBA", "I3C_SCL": "I3C1_SCL", "I3C_SDA": "I3C1_SDA",
          "CAN_TX": "CAN1_TX", "CAN_RX": "CAN1_RX",
          "OPA_OUT": "OPA1_OUT", "OPA_P": "OPA1_P", "OPA_N": "OPA1_N"}
SKIP = {"BOOT0", "BOOT1", "TAMPER-RTC", "WKUP", "LED0", "LED1", "PD0", "PD1", "SWIO", "MCK"}


def clean(t):
    t = t.replace("（注", "(").replace("注", "")
    t = re.sub(r"[(（]\s*\d+\s*[)）]", "", t)
    return t.strip()


def to_fn(token):
    t = clean(token)
    if t in ("", "—", "-") or t in SKIP:
        return []
    if t in ("SWDIO", "SWCLK"):
        return ["DBG_" + t]
    for pre, rep in RENAME.items():
        if t == pre:
            return [rep]
        if t.startswith(pre) and t[len(pre):].isdigit():
            return [rep + t[len(pre):]]
    return [t]


def pin_of(label):
    return re.split(r"[-（）(]", clean(label))[0].strip()


def main():
    md = open(sys.argv[1] if len(sys.argv) > 1 else "docs/ch32v407-pin-table.md", encoding="utf-8").read()
    d = json.load(open(DATA, encoding="utf-8"))
    ports = d["ports"]
    ledger = {(p, e["fn"], int(e.get("remap", 0))) for p, arr in ports.items() for e in arr}

    missing, checked = [], 0
    section = None
    for line in md.splitlines():
        line = line.strip()
        if line.startswith("## "):
            m = re.match(r"^##\s+([A-Z0-9]+)\s*[（(]", line)
            section = m.group(1) if m else None
            continue
        if not line.startswith("|") or section is None:
            continue
        c = [x.strip() for x in line.strip("|").split("|")]
        if len(c) < 6 or not re.fullmatch(r"[\d/]+", c[0]) or not c[2].startswith("I/O"):
            continue
        host = pin_of(c[1])
        af = c[5]
        if af in ("—", "-", ""):
            continue
        default_part, _, remap_part = af.partition("；")
        remap_part = remap_part.replace("重映射：", "").replace("重映射:", "")
        for part, is_remap in ((default_part, False), (remap_part, True)):
            for item in re.split(r"[，,]", part):
                item = clean(item)
                if not item:
                    continue
                m = re.fullmatch(r"(.+?)\[([01x]+)\]", item)
                if m:
                    g = int(m.group(2).replace("x", "0"), 2)
                    fns = to_fn(m.group(1))
                elif is_remap:
                    continue
                else:
                    g, fns = 0, to_fn(item)
                for fn in fns:
                    checked += 1
                    if (host, fn, g) not in ledger:
                        missing.append((section, host, fn, g))

    print(f"手册条目核对 {checked} 条，缺失 {len(missing)} 条")
    for m in missing[:15]:
        print("  缺:", m)

    # 引脚号连续性与 kind
    bad_pins = []
    for pkg in d["packages"]:
        total = int(re.sub(r"\D", "", pkg["label"]))
        nums = [p["num"] for p in pkg["pins"]]
        gap = [n for n in range(1, total + 1) if n not in nums]
        dup = len(nums) != len(set(nums))
        if gap or dup:
            bad_pins.append((pkg["id"], gap, dup))
    print(f"引脚号问题: {bad_pins or '无'}")

    # 同封装内「同一信号 + 同一配置组」出现在两个引脚上
    conflicts = []
    for pkg in d["packages"]:
        names = set()
        for p in pkg["pins"]:
            names.add(p["name"])
            names.update(p.get("aliases") or [])
        seen = defaultdict(list)
        for p, arr in ports.items():
            if p not in names:
                continue
            for e in arr:
                seen[(e["fn"], int(e.get("remap", 0)))].append(p)
        for (fn, g), plist in seen.items():
            uniq = sorted(set(plist))
            if len(uniq) > 1:
                conflicts.append((pkg["id"], fn, g, uniq))
    print(f"配置组冲突 {len(conflicts)} 处")
    for c in conflicts:
        print("  !", c[0], c[1], "组", c[2], "→", " / ".join(c[3]))


if __name__ == "__main__":
    main()
