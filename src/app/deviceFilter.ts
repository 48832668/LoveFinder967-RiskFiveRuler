/**
 * 器件选型的筛选与联想。
 *
 * 这是一层纯逻辑，不碰 React：DevicePicker 只负责把界面状态翻译成一个
 * DeviceQuery，再用 filterParts 拿到结果。单独成文件是因为筛选口径
 * （内核怎么归类、外设按什么算一个、数量包不包括没引出的实例）容易各写一套，
 * 换一处就和资源表对不上。
 */

import type { DeviceDef, PeripheralDef } from "../model/types";
import type { DevicePart, DeviceSeries } from "../devices/registry";
import { peripheralUsable } from "../semantic/pinmux";
import { dmaChannelCount } from "../engine/dma";

/* ─────────────────────────── 内核 ─────────────────────────── */

export type CoreKind = "RISC-V" | "ARM" | "Xtensa" | "其他";

export const CORE_KINDS: CoreKind[] = ["RISC-V", "ARM", "Xtensa", "其他"];

/** USB 进阶筛选：速度档（可多选）与角色（select 单选） */
export type UsbSpeedFilter = "fs" | "hs";
export type UsbRoleFilter = "device" | "host" | "dualrole";

/**
 * 器件包里的 `core` 是自由文本（"QingKe V4C · RV32IMAFC" / "Cortex-M4F"），
 * 没有枚举字段。这里按关键字归到几个大族，用于筛选；原文仍显示在资源表里。
 */
export function coreKindOf(core: string): CoreKind {
  const c = core.toLowerCase();
  if (/xtensa|esp32|esp-?[0-9]|lx[0-9]/.test(c)) return "Xtensa";
  if (/cortex|arm\b|m[0-9]\+?\b|armv/.test(c)) return "ARM";
  if (/risc-?v|rv32|rv64|qingke|e[0-9]{2,3}[a-z]?\b/.test(c)) return "RISC-V";
  return "其他";
}

/* ─────────────────────────── 外设维度 ─────────────────────────── */

export interface PeriphFacet {
  key: string;
  label: string;
  /** 该维度在这颗器件（这个封装）上的数量 */
  count: (dev: DeviceDef) => number;
}

/** 数「本封装真正能用」的实例，口径与 core/resources.ts 的资源表一致 */
function usableCount(dev: DeviceDef, pred: (p: PeripheralDef) => boolean): number {
  return dev.peripherals.filter((p) => pred(p) && peripheralUsable(dev, p.id)).length;
}

const byKind = (...kinds: string[]) => (dev: DeviceDef) =>
  usableCount(dev, (p) => kinds.includes(p.kind));

/**
 * USB 与 USB PD 在数据里都是 kind="USB"（USBPD 有自己的 schema），
 * 所以这两个维度按实例 id 区分，其余按 kind。
 */
export const PERIPH_FACETS: PeriphFacet[] = [
  { key: "USB", label: "USB", count: (d) => usableCount(d, (p) => p.kind === "USB" && !/^USBPD/.test(p.id)) },
  { key: "USBPD", label: "USB PD", count: (d) => usableCount(d, (p) => /^USBPD/.test(p.id)) },
  { key: "I2C", label: "I²C", count: byKind("I2C") },
  { key: "SPI", label: "SPI", count: byKind("SPI") },
  { key: "USART", label: "串口", count: byKind("USART", "UART") },
  { key: "CAN", label: "CAN", count: byKind("CAN") },
  { key: "ADC", label: "ADC", count: byKind("ADC") },
  { key: "DAC", label: "DAC", count: byKind("DAC") },
  { key: "TIM", label: "定时器", count: byKind("TIM") },
  { key: "DVP", label: "DVP", count: byKind("DVP") },
  { key: "DMA", label: "DMA 通道", count: (d) => dmaChannelCount(d) },
];

export const FACET_BY_KEY: Record<string, PeriphFacet> = Object.fromEntries(
  PERIPH_FACETS.map((f) => [f.key, f]),
);

/* ─────────────────────────── 查询 ─────────────────────────── */

/** 一个外设维度的数量约束：min..max，max=null 表示不限 */
export interface CountRange {
  min: number;
  max: number | null;
}

export interface DeviceQuery {
  /** 搜索框文本，空格分词，全部命中才算匹配 */
  text: string;
  /** 选中的内核族；空数组 = 不限 */
  cores: CoreKind[];
  /** 外设维度 -> 数量区间；未列出的维度不限制 */
  ranges: Record<string, CountRange>;
  /** 主频区间（MHz）；null = 不限 */
  freqMin: number | null;
  freqMax: number | null;
  /** USB 速度档；空数组 = 不限 */
  usbSpeeds: UsbSpeedFilter[];
  /** USB 角色；null = 不限 */
  usbRole: UsbRoleFilter | null;
}

export function emptyQuery(): DeviceQuery {
  return {
    text: "",
    cores: [],
    ranges: {},
    freqMin: null,
    freqMax: null,
    usbSpeeds: [],
    usbRole: null,
  };
}

export function queryIsEmpty(q: DeviceQuery): boolean {
  return (
    q.text.trim() === "" &&
    q.cores.length === 0 &&
    Object.keys(q.ranges).length === 0 &&
    q.freqMin === null &&
    q.freqMax === null &&
    q.usbSpeeds.length === 0 &&
    q.usbRole === null
  );
}

export interface PartHit {
  part: DevicePart;
  series: DeviceSeries;
  dev: DeviceDef;
}

/** 搜索词的候选文本（型号、系列、厂商、内核、封装都算） */
function haystack(part: DevicePart, series: DeviceSeries, dev: DeviceDef): string {
  return [
    part.id,
    part.packageLabel,
    series.id,
    series.label,
    series.vendor,
    series.core,
    dev.core,
    coreKindOf(dev.core),
    `${part.pins}`,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesText(part: DevicePart, series: DeviceSeries, dev: DeviceDef, text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = haystack(part, series, dev);
  return words.every((w) => h.includes(w));
}

function matchesCore(dev: DeviceDef, cores: CoreKind[]): boolean {
  return cores.length === 0 || cores.includes(coreKindOf(dev.core));
}

function matchesFreq(part: DevicePart, q: DeviceQuery): boolean {
  if (q.freqMin !== null && part.maxSysclk < q.freqMin) return false;
  if (q.freqMax !== null && part.maxSysclk > q.freqMax) return false;
  return true;
}

/**
 * USB 进阶条件。
 *
 * 速度与角色都来自器件包的 `usb` 能力（series 级），不是从外设实例名硬猜；
 * 这样加一颗新芯片时只补 JSON，不用改筛选逻辑。
 */
function matchesUsb(dev: DeviceDef, q: DeviceQuery): boolean {
  if (q.usbSpeeds.length === 0 && q.usbRole === null) return true;
  const caps = dev.usb;
  if (!caps) return false;
  if (q.usbSpeeds.length > 0 && !q.usbSpeeds.some((s) => (caps.speeds ?? []).includes(s))) return false;
  if (q.usbRole !== null) {
    const roles = caps.roles ?? [];
    if (q.usbRole === "dualrole") return roles.includes("device") && roles.includes("host");
    return roles.includes(q.usbRole);
  }
  return true;
}

function matchesRanges(dev: DeviceDef, ranges: Record<string, CountRange>): boolean {
  for (const [key, r] of Object.entries(ranges)) {
    const facet = FACET_BY_KEY[key];
    if (!facet) continue;
    const n = facet.count(dev);
    if (n < r.min) return false;
    if (r.max !== null && n > r.max) return false;
  }
  return true;
}

/** 全库扫描：返回所有满足条件的型号（带所属系列与 DeviceDef） */
export function filterParts(
  seriesList: DeviceSeries[],
  deviceMap: Record<string, DeviceDef>,
  q: DeviceQuery,
): PartHit[] {
  const out: PartHit[] = [];
  for (const series of seriesList) {
    for (const part of series.parts) {
      const dev = deviceMap[part.id];
      if (!dev) continue;
      if (!matchesCore(dev, q.cores)) continue;
      if (!matchesFreq(part, q)) continue;
      if (!matchesUsb(dev, q)) continue;
      if (!matchesRanges(dev, q.ranges)) continue;
      if (!matchesText(part, series, dev, q.text)) continue;
      out.push({ part, series, dev });
    }
  }
  return out;
}

/** 每个系列命中多少型号，用于左侧列表的计数 */
export function countBySeries(hits: PartHit[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const h of hits) m[h.series.id] = (m[h.series.id] ?? 0) + 1;
  return m;
}

/** 人话描述一条数量约束，chip 上显示 */
export function rangeLabel(r: CountRange): string {
  if (r.max === null) return r.min <= 1 ? "具备" : `≥${r.min}`;
  if (r.min === r.max) return `=${r.min}`;
  return `${r.min}–${r.max}`;
}
