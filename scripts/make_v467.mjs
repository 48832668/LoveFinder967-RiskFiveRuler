import { readFileSync, writeFileSync } from "node:fs";

const src = "src/devices/data/ch32v407.json";
const dst = "src/devices/data/ch32v467.json";

const pack = JSON.parse(readFileSync(src, "utf8"));

// V467 = V407 + 内置 8MB PSRAM；其余外设/引脚/DMA 与 V407 一一对应
pack.series = "CH32V467";
pack.ramKb = 200 + 8 * 1024; // 200KB 零等待 SRAM + 8192KB(8MB) 内部 PSRAM
// 型号号同步改为 V467 前缀，避免和 V407 在 DEVICE_MAP 撞键；
// sdkHeader 仍为 ch32v4x7（同 die），RM 参考仍用 V407RM（仅多 PSRAM）。
pack.source =
  "CH32V467DS0（= CH32V407 + 内置 8MB PSRAM；外设/引脚/DMA 与 CH32V407 一一对应）+ CH32V407RM V1.3";

if (!Array.isArray(pack.packages)) {
  throw new Error("packages 不是数组");
}
for (const p of pack.packages) {
  if (typeof p.id === "string" && p.id.startsWith("CH32V407")) {
    p.id = p.id.replace("CH32V407", "CH32V467");
  }
}

writeFileSync(dst, JSON.stringify(pack, null, 2) + "\n", "utf8");
console.log("wrote", dst);
console.log("  series =", pack.series, "| ramKb =", pack.ramKb);
console.log("  packages =", pack.packages.map((p) => p.id).join(", "));
