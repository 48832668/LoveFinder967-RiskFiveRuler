import type { DeviceDef, ParamDef, PeripheralConfig, PeripheralDef, PinConflict, PinDef, PinUsage, Project } from "../model/types";
import { schemaFor } from "./schemas";
import { evalCond } from "../engine/expr";
// 底层原语与重映射组板块拆在同目录；这里按门面方式再导出，外部导入路径不变
import { pinsForSignal, remapsAt, signalAvailable, remapOf } from "./pinmuxBase";
import { assignedGroupOf } from "./pinmuxGroups";
export { signalsOnPin, pinsForSignal, signalAvailable, remapsAt, remapOf } from "./pinmuxBase";
export { remapGroupsOf, groupPinsFor, assignedGroupOf } from "./pinmuxGroups";
export type { GroupSlot, RemapGroup } from "./pinmuxGroups";

export const KIND_COLORS: Record<string, string> = {
  USART: "#4fb3ff",
  SPI: "#ffb454",
  I2C: "#b98cff",
  TIM: "#59d9a5",
  ADC: "#ff7a90",
  GPIO: "#7d8aa0",
  USB: "#f2c94c",
  CAN: "#ff9f43",
  OPA: "#5ad2e0",
  CMP: "#c0e05a",
  IWDG: "#8d8d8d",
  WWDG: "#8d8d8d",
  RTC: "#a0a0a0",
  PWR: "#7f7f7f",
  EXTI: "#ff6b9d",
  CLK: "#d0b060",
  CRC: "#6f7f9f",
  DMA: "#5f7fbf",
  SYSTEM: "#8899aa",
};

export function colorOf(kind: string): string {
  return kindColorOverrides[kind] ?? KIND_COLORS[kind] ?? "#7d8aa0";
}

/**
 * 用户偏好的外设配色（设置界面写入，config.json 持久化）。
 *
 * 放在 semantic 层而不是 UI 层：canvas 绘制、右下角图例、顶部图例条
 * 都要读同一个颜色来源；覆盖表为空时走内置默认。
 */
let kindColorOverrides: Record<string, string> = {};

export function setKindColorOverrides(overrides: Record<string, string>): void {
  const clean: Record<string, string> = {};
  for (const [kind, color] of Object.entries(overrides ?? {})) {
    if (kind in KIND_COLORS && /^#[0-9a-fA-F]{6}$/.test(color)) clean[kind] = color;
  }
  kindColorOverrides = clean;
}

export function getKindColorOverrides(): Record<string, string> {
  return { ...kindColorOverrides };
}

/**
 * 普通 GPIO 的模式配色。
 *
 * 刻意用同一色相（石板蓝）的不同明度，而不是另起一套饱和色 ——
 * 引脚图上饱和色一律代表「被某个外设占用」，中性明度代表「用户自己配的 GPIO」，
 * 这样一眼就能区分「这是 SPI 的脚」和「这是我设成输出的脚」。
 */
export const GPIO_MODE_COLORS: Record<string, string> = {
  input: "#6b788c",
  output_pp: "#9aa7bb",
  output_od: "#7d8ba1",
  af_pp: "#4fb3ff",
  af_od: "#4fb3ff",
  analog: "#4f5867",
};

export const GPIO_MODE_LABELS: Record<string, string> = {
  input: "GPIO 输入",
  output_pp: "GPIO 推挽输出",
  output_od: "GPIO 开漏输出",
  af_pp: "GPIO 复用推挽",
  af_od: "GPIO 复用开漏",
  analog: "GPIO 模拟",
};

/** 模拟态是复位默认值，引脚图上不着色，否则整颗片子都会亮起来 */
export function gpioColorOf(mode: string | undefined): string | null {
  if (!mode || mode === "analog") return null;
  return GPIO_MODE_COLORS[mode] ?? null;
}

/** 外设在本封装上完全不可用时，返回缺哪些信号；可用则返回空数组 */
export function missingSignals(dev: DeviceDef, periphId: string): string[] {
  const def = dev.peripherals.find((p) => p.id === periphId);
  if (!def) return [];
  if (def.signals.length === 0) return []; // GPIO / RTC 这类没有引脚信号
  return def.signals.filter((s) => !signalAvailable(dev, `${periphId}_${s.name}`)).map((s) => s.name);
}

/**
 * 外设在本封装上是否真的能用。
 *
 * 判定标准不是「有没有任意一个信号」，而是「必需信号是否齐全」——
 * 例如 SPI2 的 SCK 没引出来时，只有 MOSI/MISO 也没法通信，应当算不可用。
 */
export function peripheralUsable(dev: DeviceDef, periphId: string): boolean {
  const def = dev.peripherals.find((p) => p.id === periphId);
  if (!def) return false;
  if (def.signals.length === 0) return true; // GPIO / RTC 这类没有引脚信号
  const required = def.signals.filter((s) => s.required);
  if (required.length > 0) {
    return required.every((s) => signalAvailable(dev, `${periphId}_${s.name}`));
  }
  return def.signals.some((s) => signalAvailable(dev, `${periphId}_${s.name}`));
}

/** 外设是否在本封装上不可用 */
export function peripheralUnavailable(dev: DeviceDef, periphId: string): boolean {
  const def = dev.peripherals.find((p) => p.id === periphId);
  if (!def || def.signals.length === 0) return false;
  return !peripheralUsable(dev, periphId);
}

/**
 * 兼容老工程：模式已经不在下拉里时落回第一个可用模式。
 *
 * USART 的多机 / IrDA / LIN / 智能卡暂时收起，老工程文件里存着这些值的话，
 * 下拉没有对应选项会显示成 Disable，而配置里还是 LIN —— 参数面板整个对不上。
 * 这里把它改成第一个能用的模式，并按新模式重排引脚。
 */
export function normalizeModes(project: Project, dev: DeviceDef): Project {
  let touched = false;
  const configs = { ...project.configs };
  for (const periph of dev.peripherals) {
    const cfg = configs[periph.id];
    if (!cfg) continue;
    const mp = modeParamOf(periph);
    if (!mp?.options?.length) continue;
    const cur = String(cfg.mode ?? "");
    const usable = usableModes(dev, periph);
    // 当前值既要「在 schema 里存在」，也要「这颗封装真能做到」——
    // 老工程可能在带 CK 的封装上存了同步模式，换到小封装后要落回可行模式
    if (mp.options.some((o) => String(o.value) === cur) && (cur === "disable" || usable.includes(cur))) {
      continue;
    }
    const fallback = mp.options.find((o) => usable.includes(String(o.value)));
    if (!fallback) continue;
    const mode = String(fallback.value);
    const next: PeripheralConfig = { ...cfg, mode, params: { ...cfg.params, [mp.key]: mode } };
    if (cfg.enabled) next.pins = applyModePins(dev, { ...project, configs }, periph, next, mode);    configs[periph.id] = next;
    touched = true;
  }
  return touched ? { ...project, configs } : project;
}

/**
 * 某个模式在这颗封装上缺哪些信号（空数组 = 物理可行）。
 *
 * 用来把「硬件做不到」的模式从下拉里去掉，而不是让用户选完才发现没有引脚。
 * 典型例子：CH32X033（TSSOP20）没有引出任何一个 USART 的 CK 脚，
 * 那它的 USART1 就不该提供「同步模式」—— 选了也配不出引脚。
 */
export function modeMissingSignals(
  dev: DeviceDef,
  periph: PeripheralDef,
  mode: string,
): string[] {
  return requiredInMode(periph, mode).filter(
    (sig) => pinsForSignal(dev, `${periph.id}_${sig}`).length === 0,
  );
}

/**
 * 这颗封装上真正可选的模式值（不含 disable / off）。
 *
 * 与 schema 里的模式清单的差别只有一条：每个模式声明的信号必须都能落到引脚。
 */
export function usableModes(dev: DeviceDef, periph: PeripheralDef): string[] {
  return (modeParamOf(periph)?.options ?? [])
    .filter((o) => o.value !== "disable" && o.value !== "off")
    .filter((o) => modeOptionSupported(dev, o))
    .map((o) => String(o.value))
    .filter((v) => modeMissingSignals(dev, periph, v).length === 0);
}

/**
 * 模式选项是否被这颗芯片的**硬件能力**支持（`ParamOption.cap`）。
 *
 * 目前只有 "usb.hs"：高速 480 Mbps 需要 dev.usb.speeds 含 "hs" ——
 * FS-only 的 X033 / X035 / L103 / HC32 没有高速 PHY，速度下拉里不该出现这一档。
 * 没写 cap 的选项视为无门槛。
 */
export function modeOptionSupported(dev: DeviceDef, opt: { cap?: string }): boolean {
  if (!opt.cap) return true;
  if (opt.cap === "usb.hs") return dev.usb?.speeds?.includes("hs") ?? false;
  if (opt.cap === "usb.fs") return dev.usb?.speeds?.includes("fs") ?? false;
  return true;
}

/** 外设实例需要占用哪些信号（模式决定） */
export function requiredSignals(project: Project, dev: DeviceDef, periphId: string): string[] {
  const def = dev.peripherals.find((p) => p.id === periphId);
  if (!def) return [];
  const cfg = project.configs[periphId];
  if (!cfg?.enabled) return [];
  const out = new Set<string>();

  // 1) 外设自身声明的必需信号（模式会改写这份清单，如 USART 单线只留 TX）
  const mode = cfg.mode ?? String(cfg.params["mode"] ?? "");
  for (const s of requiredInMode(def, mode, cfg.params)) out.add(s);

  // 2) 通道表里启用且需要引脚的通道
  for (const [key, ch] of Object.entries(cfg.channels ?? {})) {
    if (ch.enabled && ch.pin) out.add(key);
  }
  return [...out];
}

/**
 * 某个模式选项声明要占用的信号。
 *
 * **唯一真相源是 `schemas.ts` 里 mode 下拉的 option**（`signals` / `required`）。
 * 这里曾经有一张静态表与 schema 并排维护，历史上已经漂移过一次
 * （USART 同步模式一度一处写 TX+CK、一处写 TX+RX+CK），加新厂商外设时更是
 * 改一处漏一处 —— 所以那张表已删除，只从 schema 读。
 */
function modeSignals(schemaKey: string, mode: string): string[] {
  const schema = schemaFor(schemaKey);
  const modeParam = schema?.modeKey ? schema.params.find((p) => p.key === schema.modeKey) : undefined;
  const opt = modeParam?.options?.find((o) => String(o.value) === mode);
  return opt?.signals ?? [];
}

/** 某模式下该外设需要额外占用的信号（引脚补全时用） */
export function signalsForMode(schemaKey: string, mode: string): string[] {
  return modeSignals(schemaKey, mode);
}

/** 模式选择参数（没有模式概念的外设返回 undefined） */
export function modeParamOf(periph: PeripheralDef): ParamDef | undefined {
  const schema = schemaFor(periph.schema);
  return schema?.modeKey ? schema.params.find((p) => p.key === schema.modeKey) : undefined;
}

/**
 * 该外设所有模式选项声明过的信号。
 *
 * 切换模式时用它判断「哪些引脚是模式管的」：
 * 只管这些脚的增删，RTS / CTS 这种由其它参数管的引脚不能碰。
 */
export function modeOwnedSignals(periph: PeripheralDef): Set<string> {
  const out = new Set<string>();
  for (const o of modeParamOf(periph)?.options ?? []) {
    for (const s of o.signals ?? []) out.add(s);
    for (const s of o.required ?? []) out.add(s);
    for (const s of modeSignals(periph.schema, String(o.value))) out.add(s);
  }
  return out;
}

/**
 * 某个模式下必须分配的信号。
 *
 * 器件包给的 required（USART 的 TX/RX）只是「该外设的最小配置」，
 * 具体占几根线由模式决定：单线只用 TX（一根线），同步用 TX+CK，异步才是 TX+RX。
 * 模式自己声明了清单就以模式为准；没声明的（比如 TIM 的时钟源）沿用器件包的。
 *
 * 最后再按「数据方向」收敛一次：异步 / 同步模式下选「仅发送」不该再逼着占 RX，
 * 选「仅接收」也不该再逼着占 TX。单线半双工本来就只有一根线，方向不影响引脚。
 */
export function requiredInMode(
  periph: PeripheralDef,
  mode: string | undefined,
  params?: Record<string, string | number | boolean>,
): string[] {
  const base = periph.signals.filter((s) => s.required).map((s) => s.name);
  const opt = mode
    ? modeParamOf(periph)?.options?.find((o) => String(o.value) === mode)
    : undefined;
  const fromTable = mode ? modeSignals(periph.schema, mode) : [];
  let list: string[];
  if (!opt) list = [...new Set([...base, ...fromTable])];
  else {
    const declared = opt.required ?? opt.signals;
    if (declared === undefined) list = [...new Set([...base, ...fromTable])];
    else {
      // 模式接管了哪些线，器件包的必需信号里这些就让位给模式
      const owned = modeOwnedSignals(periph);
      list = [...new Set([...declared, ...fromTable, ...base.filter((s) => !owned.has(s))])];
    }
  }

  // 只有「真的同时要 TX 和 RX」的模式才受数据方向影响
  const dir = String(params?.["dataDirection"] ?? "");
  if (list.includes("TX") && list.includes("RX")) {
    if (dir === "TX") list = list.filter((s) => s !== "RX");
    else if (dir === "RX") list = list.filter((s) => s !== "TX");
  }
  return list;
}

/**
 * 当前参数组合额外要求占用的信号。
 *
 * 除了「模式」以外，普通下拉选项也能决定占哪几根线：
 * USART 的 RS232 流控选了 RTS/CTS、SPI 的 NSS 选了「硬件片选」、CLK 选了「旁路」……
 * 这些选项在 schema 里已经声明了 `signals`，但此前没有任何地方消费它 ——
 * 结果是「选了硬件 NSS，引脚页却不说 NSS 是必需的」，用户以为配完了。
 *
 * 只统计**当前可见**的选项（visibleIf / enabledIf 都满足），否则切到同步模式时
 * 还会把异步专属的 RTS/CTS 算进来。
 */
export function paramSignals(
  periph: PeripheralDef,
  params?: Record<string, string | number | boolean>,
): string[] {
  const schema = schemaFor(periph.schema);
  if (!schema) return [];
  const mode = String(params?.[schema.modeKey ?? ""] ?? "");
  const values = { ...(params ?? {}), "@mode": mode } as Record<string, unknown>;
  const out = new Set<string>();
  for (const p of schema.params) {
    if (p.type !== "select" || p.key === schema.modeKey) continue;
    if (!p.options?.length) continue;
    if (!evalCond(p.visibleIf, values, mode)) continue;
    if (!evalCond(p.enabledIf, values, mode)) continue;
    const v = String(params?.[p.key] ?? p.default ?? "");
    const opt = p.options.find((o) => String(o.value) === v);
    for (const s of opt?.signals ?? []) out.add(s);
    for (const s of opt?.required ?? []) out.add(s);
  }
  return [...out].filter((s) => periph.signals.some((x) => x.name === s));
}

/** 手动点到某个引脚时，模式该切到哪一项（没有合适的返回 null） */export function modeForSignal(periph: PeripheralDef, signal: string): string | null {
  for (const o of modeParamOf(periph)?.options ?? []) {
    const v = String(o.value);
    if (v === "disable" || v === "off") continue;
    const sigs = new Set([...(o.required ?? o.signals ?? []), ...modeSignals(periph.schema, v)]);
    if (sigs.has(signal)) return v;
  }
  return null;
}

/**
 * 该信号是不是通道表管的（TIM 的 CHx/CHxN、ADC 的 INx、EXTI 的 LINEx）。
 *
 * 通道型信号的引脚存在 `cfg.channels[key].pin` 里，不在 `cfg.pins[signal]`，
 * 所以引脚表不能把它们当成普通信号列出来 —— 否则永远显示「未分配」，
 * 而引脚图上点一下又只写通道表，两边对不上。
 */
export function isChannelSignal(periph: PeripheralDef, sig: string): boolean {
  const spec = schemaFor(periph.schema)?.channelSpec;
  if (!spec) return false;
  // CH1N 是 CH1 的互补输出，同样归通道表管
  return new RegExp(`^${spec.prefix}\\d+N?$`).test(sig);
}

/** 一个外设真正由引脚表管的信号（排除通道型的） */
export function pinTableSignals(periph: PeripheralDef): string[] {
  return periph.signals.map((s) => s.name).filter((n) => !isChannelSignal(periph, n));
}

/**
 * 该外设在本封装上真实存在的通道键。
 *
 * 器件包里的通道信号才是准的（ADC1 有 IN0..IN9 十个），
 * schema 里写死的 count 只是个兜底 —— 按 count 生成会漏掉 IN0、IN9，
 * 从引脚图点了 IN9 却找不到那张卡片。
 */
export function channelKeysOf(dev: DeviceDef, periph: PeripheralDef): string[] {
  const spec = schemaFor(periph.schema)?.channelSpec;
  if (!spec) return [];
  const re = new RegExp(`^${spec.prefix}(\\d+)$`);
  const fromSignals = periph.signals
    .map((s) => re.exec(s.name))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const nums = fromSignals.length
    ? fromSignals
    : Array.from({ length: spec.count }, (_, i) => i + (spec.startAt ?? 1));
  return nums.map((n) => `${spec.prefix}${n}`);
}

/**
 * 切换模式后重新安排引脚。
 *
 * 模式直接决定占几条线，所以换模式必须同时增删引脚 —— 否则会出现
 * 「选了同步却找不到 CK 脚」「选了单线却还占着 RX」这种和引脚图对不上的状态。
 * 只增删模式管的普通信号，通道表（CHx / INx）与其它参数（RS232 的 RTS/CTS）不动。
 */
export function applyModePins(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  cfg: PeripheralConfig,
  mode: string,
): Record<string, string | null> {
  const next: Record<string, string | null> = { ...cfg.pins };
  const owned = modeOwnedSignals(periph);
  const want = new Set(requiredInMode(periph, mode, cfg.params).filter((s) => !isChannelSignal(periph, s)));

  // 1) 新模式不再需要的线收回
  for (const sig of Object.keys(next)) {
    if (owned.has(sig) && !want.has(sig)) next[sig] = null;
  }

  // 2) 新模式新增的线自动挑脚
  const missing = [...want].filter((s) => !next[s]);
  if (missing.length) {
    const staged: Project = {
      ...project,
      configs: { ...project.configs, [periph.id]: { ...cfg, pins: next } },
    };
    const plan = planPins(dev, staged, periph.id, missing, collectUsage(staged, dev));
    if (plan) Object.assign(next, plan);
  }
  return next;
}

/** 全工程的引脚占用 */
export function collectUsage(project: Project, dev: DeviceDef): PinUsage[] {
  const out: PinUsage[] = [];
  for (const def of dev.peripherals) {
    const cfg = project.configs[def.id];
    if (!cfg?.enabled) continue;
    for (const [signal, pin] of Object.entries(cfg.pins ?? {})) {
      if (!pin) continue;
      const fn = `${def.id}_${signal}`;
      out.push({
        pin,
        fn,
        owner: def.id,
        signal,
        colorKey: def.kind,
        remap: remapOf(dev, pin, fn),
      });
    }
    // 通道表里的引脚（TIM 的 CHx、ADC 的 INx）同样占用物理引脚
    for (const [key, ch] of Object.entries(cfg.channels ?? {})) {
      if (!ch.pin) continue;
      out.push({
        pin: ch.pin,
        fn: `${def.id}_${key}`,
        owner: def.id,
        signal: key,
        colorKey: def.kind,
        remap: remapOf(dev, ch.pin, `${def.id}_${key}`),
      });
      // 互补输出是同一个通道的另一根线（CHxN），也是真实占用的引脚
      if (ch.pinN) {
        out.push({
          pin: ch.pinN,
          fn: `${def.id}_${key}N`,
          owner: def.id,
          signal: `${key}N`,
          colorKey: def.kind,
          remap: remapOf(dev, ch.pinN, `${def.id}_${key}N`),
        });
      }
    }
  }
  return out;
}

export function findConflicts(usage: PinUsage[]): PinConflict[] {
  const map = new Map<string, PinUsage[]>();
  for (const u of usage) {
    const arr = map.get(u.pin) ?? [];
    arr.push(u);
    map.set(u.pin, arr);
  }
  const out: PinConflict[] = [];
  for (const [pin, arr] of map) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        if (!a || !b) continue;
        out.push({ pin, a, b });
      }
    }
  }
  return out;
}

/** 为某外设的某信号自动挑一个空闲引脚 */
export function autoPickPin(
  dev: DeviceDef,
  project: Project,
  periphId: string,
  signal: string,
  usage: PinUsage[],
): string | null {
  const fn = `${periphId}_${signal}`;
  const candidates = pinsForSignal(dev, fn);
  if (candidates.length === 0) return null;
  const taken = new Set(usage.filter((u) => u.owner !== periphId).map((u) => u.pin));
  // 优先挑同外设已用引脚的“邻居”（同一端口的连续引脚），方便布线
  const samePeriphPorts = new Set(
    Object.values(project.configs[periphId]?.pins ?? {})
      .filter(Boolean)
      .map((p) => String(p).slice(0, 2)),
  );
  const sorted = [...candidates].sort((a, b) => {
    const aNear = samePeriphPorts.has(a.name.slice(0, 2)) ? 0 : 1;
    const bNear = samePeriphPorts.has(b.name.slice(0, 2)) ? 0 : 1;
    if (aNear !== bNear) return aNear - bNear;
    return Number(a.num) - Number(b.num);
  });
  for (const c of sorted) if (!taken.has(c.name)) return c.name;
  return sorted[0]?.name ?? null;
}

export const DEFAULT_GPIO = {
  mode: "input" as const,
  pull: "none" as const,
  speed: "2" as const,
};

/* ─────────────────────────── 打开外设时的引脚规划 ─────────────────────────── */

/** 候选引脚排序：优先「默认复用功能」（没有重映射编号），再按引脚号 */
function preferDefault(dev: DeviceDef, fn: string, p: PinDef): number {
  const hit = (p.signals ?? []).find((s) => s.fn === fn);
  return hit?.remap ? 1 : 0;
}

function candidatesFor(dev: DeviceDef, periphId: string, signal: string): PinDef[] {
  const fn = `${periphId}_${signal}`;
  return [...pinsForSignal(dev, fn)].sort(
    (a, b) => preferDefault(dev, fn, a) - preferDefault(dev, fn, b) || Number(a.num) - Number(b.num),
  );
}

/**
 * 为一组信号各挑一个空闲引脚。
 *
 * 任意一个信号找不到引脚就返回 null —— 调用方据此判断「这个模式开不起来」。
 * 本外设已占用的引脚不算冲突（重新打开外设时要能沿用原来的分配），
 * 但同一个外设的两条信号不能落到同一个物理脚上。
 */
export function planPins(
  dev: DeviceDef,
  project: Project,
  periphId: string,
  signals: string[],
  usage: PinUsage[],
): Record<string, string | null> | null {
  /*
   * 空信号列表 = 不需要任何引脚，永远可行。
   *
   * 以前这里直接走到 grouped 分支：signals 为空 → groupCandidates 返回 [] →
   * 循环一次都不跑 → 返回 null。于是 TIM1（时基/内部时钟，还没开通道）、
   * PIOC（IO 线全是可选）这类外设被判定成「放不下」，再被宽松规划判成
   * 「可以启用但要挪别人的脚」—— 实际它一根线都不用。
   */
  if (signals.length === 0) return {};
  if (dev.afGrouping !== "grouped") {
    // 逐引脚独立 AF（HC32 / STM32）：没有组的概念，各信号各挑各的，不能加约束
    return assignPins(dev, project, periphId, signals, usage, null);
  }

  // ── grouped（WCH）：同一外设的所有信号必须共用一个重映射组 ──
  // 「默认功能」也算一个组（0）：全默认，或者全在组 N，不能一半默认一半组 N。
  for (const group of groupCandidates(dev, periphId, signals)) {
    const plan = assignPins(dev, project, periphId, signals, usage, group);
    if (plan) return plan;
  }
  return null;
}

/**
 * 该外设可用的重映射组，按「优先默认组、然后组号升序」排。
 *
 * 只要有一个信号在某个组下没有候选脚，这个组就不可能成立，直接排除 ——
 * 这样外层循环最多试几个组，不会退化成指数搜索。
 */
function groupCandidates(dev: DeviceDef, periphId: string, signals: string[]): number[] {
  const groups = new Set<number>();
  for (const sig of signals) {
    const fn = `${periphId}_${sig}`;
    for (const p of pinsForSignal(dev, fn)) for (const g of remapsAt(dev, p.name, fn)) groups.add(g);
  }
  // 组 0 放最前（复位默认状态，不用碰 AFIO）
  return [...groups].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

/**
 * 真正挑引脚。`group` 为 null 表示不限组（独立 AF 的器件）。
 */
function assignPins(
  dev: DeviceDef,
  project: Project,
  periphId: string,
  signals: string[],
  usage: PinUsage[],
  group: number | null,
): Record<string, string | null> | null {
  const cfg = project.configs[periphId];
  const taken = new Set(usage.filter((u) => u.owner !== periphId).map((u) => u.pin));

  // 本外设已经占用、但不在本次规划范围内的引脚（例如 USART 的 CTS）
  const ownBusy = new Set<string>();
  for (const [sig, pin] of Object.entries(cfg?.pins ?? {})) {
    if (pin && !signals.includes(sig)) ownBusy.add(pin);
  }
  for (const [key, ch] of Object.entries(cfg?.channels ?? {})) {
    if (ch.pin && !signals.includes(key)) ownBusy.add(ch.pin);
    // 互补引脚（CHxN）同样不能被抢走
    if (ch.pinN && !signals.includes(`${key}N`)) ownBusy.add(ch.pinN);
  }

  const out: Record<string, string | null> = {};
  for (const sig of signals) {
    const fn = `${periphId}_${sig}`;
    const cands = candidatesFor(dev, periphId, sig).filter(
      (p) =>
        !taken.has(p.name) &&
        !ownBusy.has(p.name) &&
        (group === null || remapsAt(dev, p.name, fn).includes(group)),
    );
    if (cands.length === 0) return null;
    const pick = cands[0]!.name;
    taken.add(pick);
    out[sig] = pick;
  }
  return out;
}

export interface EnablePlan {
  /** 打开后应当使用的模式值（没有模式选择的外设原样返回） */
  mode: string;
  pins: Record<string, string | null>;
}

/** 一条「把别的外设的引脚挪开」记录 */
export interface Relocation {
  /** 被挪动的外设，如 I2C1 */
  owner: string;
  /** 外设类型，用于配色 */
  kind: string;
  /** 信号名，如 SDA（通道型则是 CH1 / IN4） */
  signal: string;
  /** 完整信号名，如 I2C1_SDA */
  fn: string;
  from: string;
  to: string;
  /** 是为哪个外设的哪个信号腾的位置 */
  forOwner: string;
  forSignal: string;
  /** 是不是通道表里的引脚（TIM CHx / ADC INx / EXTI LINEx） */
  channel: boolean;
}

export interface SmartPlan extends EnablePlan {
  /** 为了腾出引脚而被挪到别处的其它外设信号；为空表示原样就能放下 */
  relocations: Relocation[];
}

/** 所有模式选项（排除 Disable / off 与设备能力不支持项），当前模式排在最前面 */
function modeOrder(dev: DeviceDef, periph: PeripheralDef, cfg: PeripheralConfig): string[] | null {
  const schema = schemaFor(periph.schema);
  const modeParam = schema?.modeKey ? schema.params.find((p) => p.key === schema.modeKey) : undefined;
  if (!modeParam) return null;
  const cur = String(cfg.mode ?? "");
  const usable = (modeParam.options ?? [])
    .filter((o) => o.value !== "disable" && o.value !== "off")
    .filter((o) => modeOptionSupported(dev, o))
    .map((o) => String(o.value));
  // 已经选过有效模式的，先按原样试；还停在 Disable / off / 空，就从第一项开始
  return usable.includes(cur) ? [cur, ...usable.filter((v) => v !== cur)] : usable;
}

/**
 * 严格规划：只往空闲引脚上放，绝不动别人的引脚。
 *
 * 规则（对应 STM32CubeMX 的行为）：
 *   1. 模式栏默认停在 Disable，一打开就应该落到**第一项**而不是留在 Disable；
 *   2. 第一项因为引脚被别的外设占住而放不下时，**顺延**到下一项；
 *   3. 所有模式都放不下时返回 null。
 */
export function planEnable(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  cfg: PeripheralConfig,
  usage: PinUsage[],
): EnablePlan | null {
  const order = modeOrder(dev, periph, cfg);
  const cur = String(cfg.mode ?? "");
  if (!order) {
    const pins = planPins(dev, project, periph.id, requiredInMode(periph, cur, cfg.params), usage);
    return pins ? { mode: cur, pins } : null;
  }
  for (const mode of order) {
    // 占几根线由模式决定（单线只 TX），不能再无条件把器件包的 TX+RX 都算上
    const pins = planPins(dev, project, periph.id, requiredInMode(periph, mode, cfg.params), usage);
    if (pins) return { mode, pins };
  }
  return null;
}

/** 某个信号被谁占着（本外设自己不算；locked 的外设也不可挪）。按引脚分组 */
function occupantsOf(usage: PinUsage[], periphId: string, project: Project): Map<string, PinUsage[]> {
  const m = new Map<string, PinUsage[]>();
  for (const u of usage) {
    if (u.owner === periphId) continue;
    if (project.configs[u.owner]?.locked) continue; // 锁定的外设：它的引脚不参与自动挪动
    const arr = m.get(u.pin) ?? [];
    arr.push(u);
    m.set(u.pin, arr);
  }
  return m;
}

/**
 * 宽松规划：实在没有空脚时，尝试把占着脚的**别人的信号挪到别的空脚**。
 *
 * 这是「能不能启用」的判定标准 —— 只有当冲突引脚的持有者自己也找不到替代引脚时，
 * 才算真的放不下（返回 null）。挪动结果会作为 relocations 返回，界面据此提示
 * 「启用后 I2C1_SDA 会从 PB11 挪到 PB9」，启用时一并应用。
 */
export function planEnableSmart(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  cfg: PeripheralConfig,
  usage: PinUsage[],
): SmartPlan | null {
  const order = modeOrder(dev, periph, cfg);
  const cur = String(cfg.mode ?? "");
  const modes = order ?? [cur];

  for (const mode of modes) {
    const sigs = requiredInMode(periph, mode, cfg.params);
    const strict = planPins(dev, project, periph.id, sigs, usage);
    if (strict) return { mode, pins: strict, relocations: [] };
    const flex = planPinsRelocating(dev, project, periph, sigs, usage);
    if (flex) return { mode, pins: flex.pins, relocations: flex.relocations };
  }
  return null;
}

/**
 * 规划一组信号，允许把挡路的别人的信号挪走。
 *
 * grouped 器件必须**逐组**尝试 —— 以前的实现不限组，各信号各找各的脚，
 * 结果「启用成功」但几根线落在不同组，烧进去跑不起来（混组）。
 * 现在任何一个组凑不齐（含挪人）就换下一组，全失败才算真的启用不了，
 * 上层据此把开关直接禁掉，而不是开了之后再报错。
 */
function planPinsRelocating(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  signals: string[],
  usage: PinUsage[],
): { pins: Record<string, string | null>; relocations: Relocation[] } | null {
  if (dev.afGrouping !== "grouped") {
    return assignPinsRelocating(dev, project, periph, signals, usage, null);
  }
  for (const group of groupCandidates(dev, periph.id, signals)) {
    const plan = assignPinsRelocating(dev, project, periph, signals, usage, group);
    if (plan) return plan;
  }
  return null;
}

/** 真正挑引脚；`group` 非 null 时（WCH）所有信号必须落在同一组 */
function assignPinsRelocating(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  signals: string[],
  usage: PinUsage[],
  group: number | null,
): { pins: Record<string, string | null>; relocations: Relocation[] } | null {
  const cfg = project.configs[periph.id];
  /** 一个脚上可能同时压着好几个外设（手工分配不会互相清理），所以按引脚分组 */
  const occ = occupantsOf(usage, periph.id, project);
  const free = (pin: string) => !(occ.get(pin)?.length);

  const ownBusy = new Set<string>();
  for (const [sig, pin] of Object.entries(cfg?.pins ?? {})) {
    if (pin && !signals.includes(sig)) ownBusy.add(pin);
  }
  for (const [key, ch] of Object.entries(cfg?.channels ?? {})) {
    if (ch.pin && !signals.includes(key)) ownBusy.add(ch.pin);
    // 互补引脚（CHxN）同样不能被抢走
    if (ch.pinN && !signals.includes(`${key}N`)) ownBusy.add(ch.pinN);
  }

  /**
   * 本外设还需要的候选引脚：挪动别人时不能挪到这些脚上，
   * 否则腾出一个坑又挖了另一个坑。
   */
  const reserved = new Set<string>();
  for (const s of signals) {
    for (const p of candidatesFor(dev, periph.id, s)) {
      if (group === null || remapsAt(dev, p.name, `${periph.id}_${s}`).includes(group)) {
        reserved.add(p.name);
      }
    }
  }

  const relocations: Relocation[] = [];
  const pins: Record<string, string | null> = {};

  /**
   * 给别人的某个信号找一个空脚。
   *
   * 被挪的外设自己若是整组器件，替补必须留在它**当前的组**里 ——
   * 不能「为了启用我把别人的 I2C 挪成了混组」。
   */
  const findAlt = (u: PinUsage): string | null => {
    let ownerGroup: number | null = null;
    if (dev.afGrouping === "grouped") {
      const ownerDef = dev.peripherals.find((p) => p.id === u.owner);
      const g = ownerDef
        ? assignedGroupOf(dev, ownerDef, pinTableSignals(ownerDef), project.configs[u.owner]?.pins ?? {})
        : null;
      if (typeof g === "number") ownerGroup = g;
    }
    return candidatesFor(dev, u.owner, u.signal).find(
      (p) =>
        p.name !== u.pin &&
        free(p.name) &&
        !ownBusy.has(p.name) &&
        !reserved.has(p.name) &&
        !Object.values(pins).includes(p.name) &&
        (ownerGroup === null || remapsAt(dev, p.name, u.fn).includes(ownerGroup)),
    )?.name ?? null;
  };

  for (const sig of signals) {
    const fn = `${periph.id}_${sig}`;
    const cands = candidatesFor(dev, periph.id, sig).filter(
      (p) => group === null || remapsAt(dev, p.name, fn).includes(group),
    );
    let chosen: string | null = null;

    // 1) 先找完全空闲的脚
    chosen = cands.find((c) => free(c.name) && !ownBusy.has(c.name) && !Object.values(pins).includes(c.name))?.name ?? null;

    // 2) 没有空脚：把挡在这个脚上的**所有**外设一起挪走，有一个挪不动就换下一个候选
    if (!chosen) {
      for (const c of cands) {
        const blockers = occ.get(c.name) ?? [];
        if (blockers.length === 0) continue;
        if (ownBusy.has(c.name)) continue;
        const trials: Relocation[] = [];
        let ok = true;
        for (const u of blockers) {
          const alt = findAlt(u);
          if (!alt) {
            ok = false;
            break;
          }
          trials.push({
            owner: u.owner,
            kind: u.colorKey,
            signal: u.signal,
            fn: u.fn,
            from: c.name,
            to: alt,
            forOwner: periph.id,
            forSignal: sig,
            channel: Boolean(project.configs[u.owner]?.channels?.[u.signal]),
          });
          // 立刻占住新位置，后面的信号/外设就看不到它了
          occ.set(alt, [{ ...u, pin: alt }]);
        }
        if (!ok) {
          for (const t of trials) occ.delete(t.to);
          continue;
        }
        relocations.push(...trials);
        occ.delete(c.name);
        chosen = c.name;
        break;
      }
    }

    if (!chosen) return null;
    pins[sig] = chosen;
  }
  return { pins, relocations };
}

/** 一条「谁挡了谁」的冲突 */
export interface BlockerPin {
  /** 挡住的物理引脚 */
  pin: string;
  /** 对方在这个脚上的信号完整名，如 USART2_RX */
  fn: string;
  signal: string;
  /** 我们想拿这个脚做什么（同一个脚可能同时挡住两条信号） */
  wantSignals: string[];
  /** 对方这个信号还有没有别的空脚可去（有就说明它本可让位，但那些脚也得留给本外设） */
  alternative: string | null;
}

/** 按「挡路的外设」汇总的冲突，一个外设一条，方便给一个「关闭」按钮 */
export interface BlockerInfo {
  owner: string;
  kind: string;
  pins: BlockerPin[];
}

/**
 * 为什么启用不了：把挡路的引脚和持有者按外设分组列出来。
 *
 * 只在 planEnableSmart 也返回 null 时调用。
 * grouped 器件按「组」评估：只要有一组能让**全部**信号落下去就不算被拦
 * （否则会把本可启用的外设误报成冲突）；每组都被占满时，把各组候选脚上
 * 的持有者都收集起来 —— 一个脚上可能压着好几个外设，只报一个的话
 * 关掉它还是启用不了。
 */
export function diagnoseEnable(
  dev: DeviceDef,
  project: Project,
  periph: PeripheralDef,
  cfg: PeripheralConfig,
  usage: PinUsage[],
): BlockerInfo[] {
  const order = modeOrder(dev, periph, cfg);
  const mode = order?.[0] ?? String(cfg.mode ?? "");
  const sigs = requiredInMode(periph, mode, cfg.params);
  // 一个脚上可能压着好几个外设，全部列出来 —— 只报一个的话关掉它还是启用不了
  const occ = occupantsOf(usage, periph.id, project);
  const taken = (pin: string) => (occ.get(pin)?.length ?? 0) > 0;
  const groups = new Map<string, BlockerInfo>();

  const reserved = new Set<string>();
  for (const s of sigs) for (const p of candidatesFor(dev, periph.id, s)) reserved.add(p.name);

  /** 把候选脚上占着的外设收集进结果 */
  const collect = (sig: string, cands: PinDef[]) => {
    for (const c of cands) {
      for (const u of occ.get(c.name) ?? []) {
        const g = groups.get(u.owner) ?? { owner: u.owner, kind: u.colorKey, pins: [] };
        const existed = g.pins.find((p) => p.pin === c.name);
        if (existed) {
          if (!existed.wantSignals.includes(sig)) existed.wantSignals.push(sig);
          groups.set(u.owner, g);
          continue;
        }
        const alt =
          candidatesFor(dev, u.owner, u.signal).find(
            (p) => p.name !== c.name && !taken(p.name) && !reserved.has(p.name),
          )?.name ?? null;
        g.pins.push({ pin: c.name, fn: u.fn, signal: u.signal, wantSignals: [sig], alternative: alt });
        groups.set(u.owner, g);
      }
    }
  };

  if (dev.afGrouping !== "grouped") {
    for (const sig of sigs) {
      const cands = candidatesFor(dev, periph.id, sig);
      if (cands.some((c) => !taken(c.name))) continue; // 还有空脚，不挡
      collect(sig, cands);
    }
    return [...groups.values()];
  }

  // grouped：每一组的「组 × 信号 → 候选脚」摊开，全部信号都有空位的组 = 可行
  const byGroup = new Map<number, Map<string, PinDef[]>>();
  for (const sig of sigs) {
    for (const c of candidatesFor(dev, periph.id, sig)) {
      for (const g of remapsAt(dev, c.name, `${periph.id}_${sig}`)) {
        let m = byGroup.get(g);
        if (!m) byGroup.set(g, (m = new Map()));
        const arr = m.get(sig) ?? [];
        arr.push(c);
        m.set(sig, arr);
      }
    }
  }
  let anyViable = false;
  for (const m of byGroup.values()) {
    if (sigs.every((sig) => (m.get(sig) ?? []).some((c) => !taken(c.name)))) {
      anyViable = true;
      break;
    }
  }
  if (!anyViable) {
    for (const m of byGroup.values()) {
      for (const [sig, cands] of m) collect(sig, cands);
    }
  }
  return [...groups.values()];
}

/** 把宽松规划里的重映射写进工程配置（返回新的 configs） */
export function applyRelocations(
  project: Project,
  relocations: Relocation[],
): Record<string, PeripheralConfig> {
  const configs: Record<string, PeripheralConfig> = { ...project.configs };
  for (const r of relocations) {
    const cfg = configs[r.owner];
    if (!cfg) continue;
    const next: PeripheralConfig = { ...cfg, pins: { ...cfg.pins } };
    if (next.pins[r.signal] === r.from) {
      next.pins = { ...next.pins, [r.signal]: r.to };
    } else if (cfg.channels?.[r.signal]?.pin === r.from) {
      const ch = cfg.channels[r.signal]!;
      next.channels = { ...cfg.channels, [r.signal]: { ...ch, pin: r.to } };
    }
    configs[r.owner] = next;
  }
  return configs;
}
