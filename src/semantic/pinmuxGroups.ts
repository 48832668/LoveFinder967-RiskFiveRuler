/**
 * 重映射组（WCH AFIO 整组切换）板块。
 *
 * 从 pinmux.ts 拆出：组的枚举、组内落点、按组换脚、判定当前组。
 * 底层查询来自 pinmuxBase（引脚 ↔ 复用原语）；引脚规划（planPins /
 * planEnable…）留在 pinmux.ts，同样基于 pinmuxBase —— 两个板块互不依赖。
 */
import type { DeviceDef, PeripheralConfig, PeripheralDef, PinUsage } from "../model/types";
import { pinsForSignal, remapOf, remapsAt } from "./pinmuxBase";

/**
 * 组内一个信号的落点。
 *
 * `pin === null` 表示**这一组根本没有这根线** —— 不是「引脚被占」，是硬件做不到。
 * 两者必须分开：前者永远不可选，后者只是需要把占着脚的别人挪开。
 */
export interface GroupSlot {
  signal: string;
  pin: string | null;
  /** 选定的脚被别的外设占着时，对方的完整信号名（如 USART1_RX） */
  holder?: string;
  /** 本组下该信号的其它候选脚（同组多脚时才非空） */
  alternatives: string[];
}

export interface RemapGroup {
  /** 0 = 复位默认（不用动 AFIO），> 0 = 重映射组号 */
  group: number;
  slots: GroupSlot[];
  /** 组内每个信号都有脚 = 硬件可行 */
  feasible: boolean;
  /** 不可行的原因（人话，直接显示） */
  reason?: string;
  /** 组内被别的外设占用的脚数量 */
  conflicts: number;
}

/**
 * 给某个组挑脚。
 *
 * 排序意图：先保住「当前已经在这个组里的脚」（用户可能手工微调过），
 * 再找完全空闲的脚，最后才退到「被别的外设占着」的脚 —— 那种情况要界面标红。
 */
function slotsForGroup(
  dev: DeviceDef,
  periph: PeripheralDef,
  signals: string[],
  group: number,
  current: Record<string, string | null>,
  others: PinUsage[],
): GroupSlot[] {
  const used = new Set<string>();
  const out: GroupSlot[] = [];
  const heldBy = (name: string) => others.filter((u) => u.pin === name);

  for (const sig of signals) {
    const fn = `${periph.id}_${sig}`;
    // 用 remapsAt 而不是 remapOf：一个脚可能同时支持多个组，只要包含这一组就能用
    const cands = pinsForSignal(dev, fn).filter((p) => remapsAt(dev, p.name, fn).includes(group));
    const avail = cands.filter((p) => !used.has(p.name));
    const cur = current[sig];
    const same = cur ? avail.find((p) => p.name === cur) : undefined;
    const free = avail.find((p) => heldBy(p.name).length === 0);
    const chosen = (same && heldBy(same.name).length === 0 ? same : undefined) ?? free ?? same ?? avail[0];
    if (chosen) used.add(chosen.name);
    const h = chosen ? heldBy(chosen.name)[0] : undefined;
    out.push({
      signal: sig,
      pin: chosen?.name ?? null,
      holder: h?.fn,
      alternatives: avail.filter((p) => p.name !== chosen?.name).map((p) => p.name),
    });
  }
  return out;
}

/**
 * 枚举该外设在本封装上的所有重映射组。
 *
 * **只对 `afGrouping === "grouped"` 的器件有意义**（WCH 的 AFIO 是整组切换：
 * I2C1 的 SCL 用了组 1，SDA 就不能用组 2 —— 硬件做不到）。逐引脚独立 AF 的
 * 器件（HC32 / STM32）返回空数组，界面继续用逐信号的展示。
 *
 * 组号来自器件包：`PinSignal.remap`。0 是复位默认，排在最前。
 */
export function remapGroupsOf(
  dev: DeviceDef,
  periph: PeripheralDef,
  signals: string[],
  current: Record<string, string | null>,
  usage: PinUsage[],
  /**
   * 只有这些信号决定「这组可不可行」，缺省 = signals 全体。
   *
   * 用来把「可选信号」排除在外：USART 异步模式下 CK 用不上，
   * 若把 CK 也算进可行性，几乎所有组都会被判成缺线而灰掉。
   */
  gating?: string[],
): RemapGroup[] {
  if (dev.afGrouping !== "grouped" || signals.length === 0) return [];
  const gate = new Set(gating ?? signals);
  const nums = new Set<number>();
  for (const sig of signals) {
    const fn = `${periph.id}_${sig}`;
    for (const p of pinsForSignal(dev, fn)) nums.add(remapOf(dev, p.name, fn));
  }
  const others = usage.filter((u) => u.owner !== periph.id);
  return [...nums]
    .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b))
    .map((group) => {
      const slots = slotsForGroup(dev, periph, signals, group, current, others);
      const missing = slots.filter((s) => gate.has(s.signal) && !s.pin).map((s) => s.signal);
      return {
        group,
        slots,
        feasible: missing.length === 0,
        reason: missing.length ? `本组没有 ${missing.join(" / ")} 的引脚` : undefined,
        conflicts: slots.filter((s) => s.holder).length,
      };
    });
}

/**
 * 选定一个组，算出该组下每个信号的引脚。
 *
 * `pinned` 用于「用户点了引脚图上某个脚」：那个信号的脚由点击决定，
 * 其余信号跟着落到同一组 —— 这正是用户要的「选组而不是选线」。
 * `current` 里的已分配脚优先保留（用户手工微调过的不要被冲掉）。
 */
export function groupPinsFor(
  dev: DeviceDef,
  periph: PeripheralDef,
  signals: string[],
  group: number,
  current: Record<string, string | null>,
  usage: PinUsage[],
  pinned?: { signal: string; pin: string },
): Record<string, string | null> {
  const cur = pinned ? { ...current, [pinned.signal]: pinned.pin } : current;
  const slots = slotsForGroup(dev, periph, signals, group, cur, usage.filter((u) => u.owner !== periph.id));
  const out: Record<string, string | null> = {};
  for (const s of slots) out[s.signal] = s.pin;
  return out;
}

/**
 * 当前分配落在哪个组。
 *
 * 返回 `"mixed"` 说明用户（或老工程）把同一外设的几条线配到了不同组 ——
 * 硬件不可能同时生效，界面必须明确提示，而不是让它安静地生成一段跑不起来的代码。
 */
export function assignedGroupOf(
  dev: DeviceDef,
  periph: PeripheralDef,
  signals: string[],
  current: Record<string, string | null>,
): number | "mixed" | null {
  /**
   * 一个脚可能同时支持多个组（PB11 的 USART1_RX 既是组 0 又是组 2），
   * 所以不能「每根线取一个组号再比是否相等」——那样会把本来一致的配置报成混组。
   * 正确做法：找出能解释最多已分配线的组，再看它是否覆盖全部。
   */
  const sets: number[][] = [];
  for (const sig of signals) {
    const pin = current[sig];
    if (!pin) continue;
    sets.push(remapsAt(dev, pin, `${periph.id}_${sig}`));
  }
  if (sets.length === 0) return null;
  const cover = new Map<number, number>();
  for (const s of sets) for (const g of s) cover.set(g, (cover.get(g) ?? 0) + 1);
  const best = [...cover].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  return sets.every((s) => s.includes(best)) ? best : "mixed";
}
