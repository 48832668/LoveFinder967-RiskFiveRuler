/**
 * 通用器件包加载器 —— L2 层。
 *
 * 与厂商无关：只认 `PackFile` 的结构，**不认外设命名习惯**。
 * 外设「是什么」由 `pack.meta` 提供；WCH 的旧包没写 meta，
 * 通过 `legacyMeta` 回调把历史上那张 META 表接进来（见 `devices/wch.ts`），
 * 这样既不用回头改 4 份 JSON，也不会让命名约定污染这一层。
 */

import type {
  AfGrouping,
  DeviceDef,
  IrqDef,
  PackageDef,
  PackMeta,
  PeripheralDef,
  PeripheralGroup,
  PeripheralKind,
  PinDef,
  SignalDef,
} from "../model/types";
import type { PackFile, PackPackage } from "./types";

/** 树里的分组顺序；未知分组排到最后 */
const GROUP_ORDER: PeripheralGroup[] = [
  "System",
  "Connectivity",
  "Timers",
  "Analog",
  "Security",
  "Middleware",
];

export const GROUP_ORDER_ALL = GROUP_ORDER;

/** 老包（无 meta 字段）的元数据来源 */
export type LegacyMetaResolver = (id: string) => PackMeta;

function buildPins(pack: PackFile, pkg: PackPackage): PinDef[] {
  const extiMax = pack.extiLines ?? 0;
  // 本封装被排除的外设：它的复用功能在引脚菜单里也不该出现（silicon 没有）
  const drop = pkg.drop ?? [];
  const isDropped = (fn: string) => drop.some((id) => fn === id || fn.startsWith(`${id}_`));
  return pkg.pins.map((p) => {
    const out: PinDef = { num: p.num, name: p.name, kind: p.kind };
    if (p.note) out.note = p.note;
    if (p.aliases?.length) out.aliases = p.aliases;
    // 短接合封的两个端口共用一个物理引脚，两边的复用功能都可用
    const names = [p.name, ...(p.aliases ?? [])];
    const seen = new Set<string>();
    const signals: { fn: string; remap?: string }[] = [];
    for (const n of names) {
      for (const s of pack.ports[n] ?? []) {
        if (isDropped(s.fn)) continue;
        const key = `${s.fn}|${s.remap ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push(s.remap ? { fn: s.fn, remap: s.remap } : { fn: s.fn });
      }
    }
    // 外部中断线不写在数据手册的复用表里：PXn 天然对应 EXTIn，
    // 所以这里按引脚序号补一条，让引脚菜单和 EXTI 通道表都能选到它。
    if (p.kind === "io") {
      for (const n of names) {
        const m = /^P[A-Z](\d+)$/.exec(n);
        if (!m) continue;
        const line = Number(m[1]);
        if (line < extiMax && !seen.has(`EXTI_LINE${line}`)) {
          seen.add(`EXTI_LINE${line}`);
          signals.push({ fn: `EXTI_LINE${line}` });
        }
      }
    }
    if (signals.length) out.signals = signals;
    return out;
  });
}

function directionOf(kind: PeripheralKind, sig: string): "in" | "out" | "io" {
  if (/^CH\dN?$/.test(sig)) return "io";
  switch (kind) {
    case "USART":
    case "UART":
      return sig === "TX" || sig === "CK" || sig === "RTS" ? "out" : "in";
    case "SPI":
    case "QSPI":
      return sig === "SCK" || sig === "CLK" || sig === "MOSI" || sig === "NSS" ? "out" : "in";
    case "I2C":
      return "io";
    case "ADC":
    case "DAC":
      return "in";
    case "CMP":
    case "VCMP":
      return sig.startsWith("OUT") ? "out" : "in";
    case "CAN":
      return sig === "TX" ? "out" : "in";
    case "CLK":
      return sig.endsWith("_IN") ? "in" : "out";
    default:
      return "io";
  }
}

function buildPeripherals(pack: PackFile, legacyMeta?: LegacyMetaResolver): PeripheralDef[] {
  const list: PeripheralDef[] = [];
  for (const p of pack.peripherals) {
    const meta = pack.meta?.[p.id] ?? legacyMeta?.(p.id);
    if (!meta) {
      // 校验器已经报过错了；这里给一个明显不完整的外设，别静默成 SYSTEM 让人以为是数据
      throw new Error(
        `${pack.series}: 外设 ${p.id} 缺少 meta，无法确定 kind / group / schema`,
      );
    }
    const idx = Number(/(\d+)$/.exec(p.id)?.[1] ?? "0");
    const required = new Set(meta.required ?? []);
    const signals: SignalDef[] = p.signals.map((s) => ({
      name: s,
      required: required.has(s),
      dir: directionOf(meta.kind, s),
    }));
    // 必需的信号即便没有引出也要列出来，界面才能显示「不可用」
    for (const r of required) {
      if (!signals.some((s) => s.name === r)) {
        signals.push({ name: r, required: true, dir: directionOf(meta.kind, r) });
      }
    }
    list.push({
      id: p.id,
      kind: meta.kind,
      label: meta.label ?? p.id,
      group: meta.group,
      index: idx,
      brief: meta.brief,
      signals,
      schema: meta.schema,
      irq: pack.irqs.filter((i) => i.owner === p.id).map((i) => ({ n: i.n, name: i.name, desc: i.desc, gate: i.gate })),
    });
  }
  list.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.index - b.index;
  });
  return list;
}

/** 一个器件包 JSON -> 每个封装一个 DeviceDef */
export function loadPack(pack: PackFile, legacyMeta?: LegacyMetaResolver): DeviceDef[] {
  const allPeripherals = buildPeripherals(pack, legacyMeta);
  return pack.packages.map((pkg) => {
    const pkgDef: PackageDef = {
      id: pkg.id,
      label: pkg.label,
      shape: pkg.shape,
      pins: buildPins(pack, pkg),
      pinNumbering: pkg.pinNumbering ?? "package",
    };
    const irqs: IrqDef[] = pack.irqs ?? [];
    // drop：同引脚但硬件阉割的封装（K8U7 无 CAN1、RET6 无 USBHS2）——整棵外设树里不出现
    const dropped = new Set(pkg.drop ?? []);
    const peripherals = dropped.size ? allPeripherals.filter((p) => !dropped.has(p.id)) : allPeripherals;
    return {
      id: pkg.id,
      family: pack.series,
      vendor: pack.vendor,
      core: pack.core,
      package: pkgDef,
      flashKb: pack.flashKb,
      ramKb: pack.ramKb,
      voltage: pack.voltage,
      peripherals,
      clock: pack.clock,
      extiLines: pack.extiLines,
      dmaChannels: pack.dmaChannels,
      dmaControllers: pack.dmaControllers,
      dmaMap: pack.dmaMap,
      debug: pack.debug,
      usb: pack.usb,
      api: pack.api,
      // 总线覆盖必须透传：L103 的 USBFS/USBPD 挂在 HB 上，
      // 少了这一行 `dev.buses` 永远是 undefined，生成出来就是 PB1 的错宏
      buses: pack.buses,
      backend: pack.backend ?? backendFor(pack.vendor),
      afGrouping: pack.afGrouping ?? groupingFor(pack.vendor),
      codegenEnabled: pack.codegen !== "disable",
      codegenNote: pack.codegenNote,
      peripheralVersion: pack.peripheralVersion,
      sdkHeader: pack.sdkHeader,
      irqs,
      source: pack.source,
      packVersion: pack.packVersion,
      pending: pack.pending,
    };
  });
}

/**
 * 没写 backend 时按厂商兜底。
 *
 * 新厂商接入第一天往往还没有代码生成器 —— 那就落到 "generic"：
 * 只出引脚映射表与 TODO，不假装能生成初始化代码。
 */
function backendFor(vendor: string): string {
  return vendor === "WCH" ? "wch-spl" : "generic";
}

/**
 * 复用分组语义的默认值。
 *
 * WCH 的 AFIO 是整组切换，必须 `grouped`；HC32 / STM32 是逐引脚选 AF，必须 `independent`。
 * 这个默认值错了后果很实在：给 HC32 加组约束会把合法的引脚组合判成冲突，
 * 给 WCH 不加组约束会生成跑不起来的配置。
 */
function groupingFor(vendor: string): AfGrouping {
  return vendor === "WCH" ? "grouped" : "independent";
}
