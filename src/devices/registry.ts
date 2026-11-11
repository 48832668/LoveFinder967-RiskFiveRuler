/**
 * 器件包注册表（L2）。
 *
 * 三件事：
 *   1. 收集所有 `data/*.json`；
 *   2. **加载前校验**（`packs/validate.ts`）—— 坏数据在启动时就说清楚；
 *   3. 导出 `DEVICES` / `DEVICE_MAP` / `SERIES` 给上层。
 *
 * 加一个厂商 = 放一个 JSON 进 `data/` 并在下面 import 一行，**不改任何其它代码**。
 * （阶段 5 会换成 `import.meta.glob` 自动发现，连这一行都不用写。）
 */

import type { DeviceDef } from "../model/types";
import type { PackFile } from "../packs/types";
import { loadPack as loadPackGeneric } from "../packs/loader";
import { formatIssues, validatePack } from "../packs/validate";
import { loadPack as loadWchPack } from "./wch";

/* ───────────────────────────── 数据 ───────────────────────────── */

import l103Pack from "./data/ch32l103.json";
import x035Pack from "./data/ch32x035.json";
import x033Pack from "./data/ch32x033.json";
import v407Pack from "./data/ch32v407.json";
// V467 与 V407 同 die（共用 ch32v4x7.h），仅多内置 8MB PSRAM，外设/引脚/DMA 完全对应
import v467Pack from "./data/ch32v467.json";

// 第二家厂商：Holychip 芯圣 HC32F401B（数据由 scripts/rebuild_hc32f401_from_md.py 生成）
import hc32f401bPack from "./data/hc32f401b.json";

/**
 * 注册表。
 *
 * `loader` 是「怎么把这个厂商的 JSON 变成 DeviceDef」：
 * WCH 的包要带上历史 META 兜底，其它厂商用纯通用加载器（必须自带 meta）。
 */
interface PackEntry {
  pack: PackFile;
  load: (p: PackFile) => DeviceDef[];
}

const ENTRIES: PackEntry[] = [
  { pack: v407Pack as PackFile, load: loadWchPack },
  // V467：V407 + 内置 8MB PSRAM，共用 WCH 历史 META 兜底（DVP 已加入）
  { pack: v467Pack as PackFile, load: loadWchPack },
  { pack: l103Pack as PackFile, load: loadWchPack },
  { pack: x035Pack as PackFile, load: loadWchPack },
  { pack: x033Pack as PackFile, load: loadWchPack },
  // 非 WCH 的包必须自带 meta，走通用加载器（不带历史 META 兜底）
  { pack: hc32f401bPack as PackFile, load: (p) => loadPackGeneric(p) },
];

/* ───────────────────────────── 加载 ───────────────────────────── */

const loadedDevices: DeviceDef[] = [];

for (const { pack, load } of ENTRIES) {
  const issues = validatePack(pack, pack.series);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    // 结构错误直接拒绝加载：带着破碎的数据跑只会让人以为是别处的 bug
    throw new Error(formatIssues(pack, errors) ?? `${pack.series}: 器件包校验失败`);
  }
  const warns = issues.filter((i) => i.level === "warn");
  if (warns.length && import.meta.env?.DEV) {
    console.warn(formatIssues(pack, warns));
  }

  try {
    loadedDevices.push(...load(pack));
  } catch (e) {
    throw new Error(`${pack.series}: 加载失败 —— ${(e as Error).message}`);
  }
}

export const DEVICES: DeviceDef[] = loadedDevices;

export const DEVICE_MAP: Record<string, DeviceDef> = Object.fromEntries(
  DEVICES.map((d) => [d.id, d]),
);

/* ─────────────────────────── 两级器件目录 ─────────────────────────── */

export interface DevicePart {
  id: string;
  packageLabel: string;
  pins: number;
  flashKb: number;
  ramKb: number;
  maxSysclk: number;
}

export interface DeviceSeries {
  id: string;
  /** 厂商，用于选择器分组 */
  vendor: string;
  label: string;
  core: string;
  voltage: string;
  summary: string;
  parts: DevicePart[];
}

/** 模态框里的「一级 = 系列 / 二级 = 型号」列表 */
export const SERIES: DeviceSeries[] = ENTRIES.map(({ pack }) => {
  const first = DEVICE_MAP[pack.packages[0]?.id ?? ""];
  return {
    id: pack.series,
    vendor: pack.vendor,
    label: pack.series,
    core: pack.core,
    voltage: pack.voltage,
    summary: `${pack.flashKb} KB Flash · ${pack.ramKb} KB RAM · ${pack.maxSysclk} MHz`,
    parts: pack.packages.map((p) => ({
      id: p.id,
      packageLabel: p.label,
      pins: p.pins.length,
      flashKb: pack.flashKb,
      ramKb: pack.ramKb,
      maxSysclk: first?.clock.maxSysclk ?? pack.maxSysclk,
    })),
  };
});

/** 器件包元信息（不含引脚），选择器要显示厂商时用 */
export const PACK_OF_SERIES: Record<string, PackFile> = Object.fromEntries(
  ENTRIES.map(({ pack }) => [pack.series, pack]),
);

export function seriesOf(deviceId: string): DeviceSeries | undefined {
  return SERIES.find((s) => s.parts.some((p) => p.id === deviceId));
}

export function deviceById(id: string): DeviceDef {
  const d = DEVICE_MAP[id];
  if (!d) throw new Error(`未知器件: ${id}`);
  return d;
}

export function defaultDeviceId(): string {
  return DEVICE_MAP["CH32L103C8T6"] ? "CH32L103C8T6" : (DEVICES[0]?.id ?? "");
}

/**
 * SDK 头文件名（`ch32l103.h` / `ch32x035.h` / `ch32v4x7.h`）。
 *
 * 优先用器件包里写的 sdkHeader —— X033 与 X035 同 die，共用 ch32x035.h；
 * 没写就按系列名推。工程设置页的 SDK 选项与生成代码都从这里取，
 * 免得固定写死一个 `ch32v00x.h` 挂在 L103 上。
 */
export function sdkHeaderOf(dev: DeviceDef): string {
  return dev.sdkHeader ?? dev.family.toLowerCase();
}
