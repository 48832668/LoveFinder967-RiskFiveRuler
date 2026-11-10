import { DEVICE_MAP, SERIES } from "../src/core/devices";
import {
  filterParts,
  emptyQuery,
  coreKindOf,
  FACET_BY_KEY,
  PERIPH_FACETS,
  type DeviceQuery,
} from "../src/core/deviceFilter";

const total = SERIES.reduce((n, s) => n + s.parts.length, 0);
console.log(`器件库: ${SERIES.length} 个系列 / ${total} 个型号`);
console.log("内核归类:", SERIES.map((s) => `${s.label}=${coreKindOf(s.core)}`).join(", "));

function run(tag: string, q: DeviceQuery, expect?: (ids: string[]) => boolean) {
  const hits = filterParts(SERIES, DEVICE_MAP, q);
  const ids = hits.map((h) => h.part.id);
  const seriesHit = [...new Set(hits.map((h) => h.series.label))];
  console.log(`\n[${tag}] ${ids.length} 个型号`);
  console.log(`  系列: ${seriesHit.join(", ") || "（无）"}`);
  console.log(`  型号: ${ids.join(", ") || "（无）"}`);
  if (expect && !expect(ids)) throw new Error(`${tag}: 结果不符合预期`);
  return ids;
}

// 1) 空筛选 = 全库
run("不限", emptyQuery(), (ids) => ids.length === total);

// 2) 内核：ARM 只应命中 HC32F401B
run("内核=ARM", { ...emptyQuery(), cores: ["ARM"] }, (ids) =>
  ids.length > 0 && ids.every((id) => id.startsWith("HC32")),
);
// RISC-V 命中 WCH，且不含 HC32
run("内核=RISC-V", { ...emptyQuery(), cores: ["RISC-V"] }, (ids) =>
  ids.length > 0 && ids.every((id) => !id.startsWith("HC32")),
);
// 多选 = 并集
const arm = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), cores: ["ARM"] }).length;
const rv = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), cores: ["RISC-V"] }).length;
run("内核=ARM+RISC-V", { ...emptyQuery(), cores: ["ARM", "RISC-V"] }, (ids) => ids.length === arm + rv);

// 3) 外设具备：USB PD 只在 L103 / X035
run("USB PD 具备", { ...emptyQuery(), ranges: { USBPD: { min: 1, max: null } } }, (ids) =>
  ids.length > 0 && ids.every((id) => /^CH32L103|^CH32X035/.test(id)),
);

// 数量口径 = 本封装真正能用的实例（与资源表一致），小封装可能只引出 1 个 I2C，
// 所以断言直接按 facet.count(dev) 核对每个命中型号，不靠型号前缀猜。
const i2cCount = (id: string) => FACET_BY_KEY["I2C"]!.count(DEVICE_MAP[id]!);

// 4) I2C 至少 2 个
run("I2C ≥2", { ...emptyQuery(), ranges: { I2C: { min: 2, max: null } } }, (ids) =>
  ids.length > 0 && ids.every((id) => i2cCount(id) >= 2),
);

// 5) I2C 恰好 1 个
run("I2C =1", { ...emptyQuery(), ranges: { I2C: { min: 1, max: 1 } } }, (ids) =>
  ids.length > 0 && ids.every((id) => i2cCount(id) === 1),
);

// 4+5 应互补：每个型号要么 ≥2 要么 =1 要么 0
const ge2 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 2, max: null } } }).length;
const eq1 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 1, max: 1 } } }).length;
const eq0 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 0, max: 0 } } }).length;
console.log(`\n[分区] I2C ≥2:${ge2}  =1:${eq1}  =0:${eq0}  合计应为 ${total}`);
if (ge2 + eq1 + eq0 !== total) throw new Error("I2C 数量分区不完备");

// 6) 组合：RISC-V + 至少 2 个 I2C -> 全为 WCH 且 I2C≥2
run("RISC-V 且 I2C ≥2", {
  ...emptyQuery(), cores: ["RISC-V"], ranges: { I2C: { min: 2, max: null } },
}, (ids) => ids.length > 0 && ids.every((id) => !id.startsWith("HC32") && i2cCount(id) >= 2));

// 7) 搜索联想
run("搜索 V407", { ...emptyQuery(), text: "v407" }, (ids) =>
  ids.length > 0 && ids.every((id) => id.includes("V407")),
);
run("搜索 M4（内核关键字）", { ...emptyQuery(), text: "m4" }, (ids) => ids.length > 0);
run("搜索不存在", { ...emptyQuery(), text: "zzz-not-exist" }, (ids) => ids.length === 0);

// 8) 每个 facet 计数打印（确认数量口径）
console.log("\n=== 各系列首个型号的外设数量 ===");
for (const s of SERIES) {
  const dev = DEVICE_MAP[s.parts[0]!.id];
  if (!dev) continue;
  const cells = PERIPH_FACETS.map((f) => `${f.key}:${f.count(dev)}`).join(" ");
  console.log(`  ${s.label.padEnd(12)} ${cells}`);
}

// 9) USB 与 USBPD 不能混为一谈
const usbOnly = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { USB: { min: 1, max: null } } });
const pdOnly = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { USBPD: { min: 1, max: null } } });
console.log(`\nUSB 具备 ${usbOnly.length} 个型号 / USB PD 具备 ${pdOnly.length} 个型号（应不同）`);
if (usbOnly.length === pdOnly.length) throw new Error("USB 与 USBPD 筛选结果相同，口径可能有问题");
if (!FACET_BY_KEY["I2C"]) throw new Error("FACET_BY_KEY 缺 I2C");

console.log("\n✅ 筛选逻辑验证通过");
