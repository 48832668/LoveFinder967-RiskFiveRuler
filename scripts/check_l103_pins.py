"""L103 引脚表双向校验：把 DS0 表2-1-1 的 markdown 与器件包逐条对照。

    python scripts/check_l103_pins.py "CH32L103_各封装引脚表.md"

它与 `rebuild_l103_from_ds.py` **独立**（自己重新解析一遍 markdown），
用来抓重建脚本的解析错误：先断言手册的每条都进了 JSON，再断言 JSON 里没有手册之外的条目。
"""
import json, re, sys

md = open(sys.argv[1], encoding="utf-8").read()
d = json.load(open("src/devices/data/ch32l103.json", encoding="utf-8"))
ports = d["ports"]

RENAME = {"USBDM": "USB1_DM", "USBDP": "USB1_DP", "CC1": "USBPD_CC1", "CC2": "USBPD_CC2"}
SKIP = {"WKUP", "TAMPER", "RTC", "MCO", "NRST", "BOOT0", "BOOT1", "OSC_IN", "OSC_OUT", "OSC32_IN", "OSC32_OUT", "SWDIO", "SWCLK"}

def names(tok):
    tok = tok.strip()
    if tok in SKIP:
        return []
    if tok in RENAME:
        return [RENAME[tok]]
    m = re.fullmatch(r"ADC_IN(\d+)", tok)
    if m: return [f"ADC1_IN{m.group(1)}"]
    m = re.fullmatch(r"OPA_([PNO])(\d+)", tok)
    if m: return [f"OPA1_{ {'P':'P','N':'N','O':'OUT'}[m.group(1)] }{m.group(2)}"]
    m = re.fullmatch(r"(TIM\d)_CH(\d)_ETR", tok)
    if m: return [f"{m.group(1)}_CH{m.group(2)}", f"{m.group(1)}_ETR"]
    return [tok]

def port_of(label):
    return re.split(r"[-()]", label.strip())[0]

missing, checked = [], 0
for line in md.splitlines():
    if not line.startswith("|"):
        continue
    c = [x.strip() for x in line.strip("|").split("|")]
    if len(c) < 6 or not c[0].isdigit():
        continue
    pin = port_of(c[1])
    af = c[5]
    if af in ("—", "-", ""):
        continue
    for part in af.split("；"):
        for item in re.split(r"[，,]", part):
            item = item.strip()
            if not item:
                continue
            m = re.fullmatch(r"(.+?)\[([01]+)\]", item)
            if m:
                want = {"fn": m.group(1), "remap": int(m.group(2), 2)}
            else:
                want = {"fn": item}
            for fn in names(want["fn"]):
                e = {"fn": fn}
                if want.get("remap"):
                    e["remap"] = str(want["remap"])
                checked += 1
                if e not in (ports.get(pin) or []):
                    missing.append((pin, e))

print(f"核对 {checked} 条，缺失 {len(missing)} 条")
for pin, e in missing[:20]:
    print("  缺:", pin, e)

# 反向：ports 里不该有手册没写的条目（除 CLK / DBG 这类由主功能列推导的）
expected = set()
for line in md.splitlines():
    if not line.startswith("|"):
        continue
    c = [x.strip() for x in line.strip("|").split("|")]
    if len(c) < 6 or not c[0].isdigit():
        continue
    pin = port_of(c[1])
    for part in c[5].split("；"):
        for item in re.split(r"[，,]", part):
            item = re.sub(r"\[[01]+\]$", "", item.strip())
            for fn in names(item):
                expected.add((pin, fn))
extra = [(p, e["fn"]) for p, arr in ports.items() for e in arr
         if (p, e["fn"]) not in expected and not e["fn"].startswith(("CLK_", "DBG_"))]
print(f"多余的条目 {len(extra)} 条")
for x in extra[:15]:
    print("  多:", x)
