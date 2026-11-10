/**
 * DMA 建模与汇总。
 *
 * CH32 的通用 DMA 是「固定映射」的：每个通道只能接固定的几个硬件请求
 * （RM「DMA 请求映射」）。所以这里把「请求」当成一等公民：
 *
 * ```
 * 外设 → 它能发出哪些请求（SPI1_RX / SPI1_TX / TIM1_CH1 …）
 *      → 每个请求只能落到某个通道上
 * ```
 *
 * 界面上的三处都读这一份数据：外设的 DMA 页、左侧 DMA 汇总、生成的代码。
 */

import type {
  DeviceDef,
  DmaChannelCfg,
  DmaController,
  PeripheralConfig,
  PeripheralDef,
  Project,
} from "../model/types";

/** 一个可分配的 DMA 请求 */
export interface DmaRequest {
  /** 与 RM 表同名的请求名：`SPI1_RX` / `USART1_TX` / `ADC` / `TIM1_CH1` */
  name: string;
  /** 一句话说明 */
  label: string;
  /** 硬件决定的方向（不能随便改：RX 只能外设→内存） */
  dir: "p2m" | "m2p";
  /** 该请求可用的通道（来自器件包的 dmaMap；空数组 = 未知） */
  channels: number[];
}

/** 全工程里一条已分配的 DMA 通道 */
export interface DmaAlloc {
  owner: string;
  request: string;
  channel: number;
  dir: "p2m" | "m2p";
  mode: "normal" | "circular";
  priority: string;
  width: string;
  incMem: boolean;
  cfg: DmaChannelCfg;
}

/**
 * 请求名。ADC 在 RM 的映射表里就叫 `ADC`（不分通道号），
 * 所以不能一律拼成 `ADC1_xxx`，否则和表对不上。
 */
export function requestName(periphId: string, suffix: string): string {
  if (periphId.startsWith("ADC")) return "ADC";
  return `${periphId}_${suffix}`;
}

/** 这台外设能发出哪些 DMA 请求（决定性来自外设类型，不是器件包） */
export function dmaRequestsOf(dev: DeviceDef, periph: PeripheralDef): Omit<DmaRequest, "channels">[] {
  const mk = (suffix: string, label: string, dir: "p2m" | "m2p"): DmaRequest => {
    const name = requestName(periph.id, suffix);
    return { name, label, dir, channels: channelsFor(dev, name) };
  };

  let list: DmaRequest[];
  switch (periph.kind) {
    case "USART":
      list = [mk("RX", "接收 RX", "p2m"), mk("TX", "发送 TX", "m2p")];
      break;
    case "SPI":
      list = [mk("RX", "接收 RX", "p2m"), mk("TX", "发送 TX", "m2p")];
      break;
    case "I2C":
      list = [mk("RX", "接收 RX", "p2m"), mk("TX", "发送 TX", "m2p")];
      break;
    case "ADC":
      // ADC 的 DMA 是「转换结果 → 内存」，固定 p2m
      list = [mk("EOC", "转换结果", "p2m")];
      break;
    case "TIM": {
      const out: DmaRequest[] = [];
      for (let n = 1; n <= 4; n++) out.push(mk(`CH${n}`, `通道 ${n}`, "m2p"));
      out.push(mk("UP", "更新事件", "m2p"));
      out.push(mk("TRIG", "触发事件", "m2p"));
      out.push(mk("COM", "换相事件", "m2p"));
      list = out;
      break;
    }
    case "DVP": {
      // 摄像头 FIFO → 内存，固定 p2m；请求名与 RM 映射表一致（无后缀）
      const name = "DVP";
      list = [{ name, label: "视频数据 FIFO", dir: "p2m", channels: channelsFor(dev, name) }];
      break;
    }
    default:
      return [];
  }

  // 器件包里有 RM 的映射表时，表里没有的请求就是「硬件上不支持 DMA」，
  // 不该出现在下拉框里（例如 X035 的 TIM3 没有 DMA 通道）
  const hasMap = Boolean(dev.dmaMap && Object.keys(dev.dmaMap).length > 0);
  return hasMap ? list.filter((r) => r.channels.length > 0) : list;
}

/** `dev.dmaMap` 反查：这个请求能落在哪些通道上 */
export function channelsFor(dev: DeviceDef, request: string): number[] {
  const map = dev.dmaMap ?? {};
  return Object.entries(map)
    .filter(([, reqs]) => reqs.includes(request))
    .map(([ch]) => Number(ch))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 该器件的 DMA 控制器列表（缺省：单颗 DMA1，通道数 = `dmaChannels`） */
export function dmaControllers(dev: DeviceDef): DmaController[] {
  if (dev.dmaControllers && dev.dmaControllers.length > 0) return dev.dmaControllers;
  return [{ id: "DMA1", channels: dev.dmaChannels ?? 0 }];
}

/** 该器件一共有几个通用 DMA 通道 */
export function dmaChannelCount(dev: DeviceDef): number {
  const cs = dev.dmaControllers;
  if (cs && cs.length > 0) return cs.reduce((s, c) => s + c.channels, 0);
  return dev.dmaChannels ?? 0;
}

/**
 * 全局通道号 → 控制器 + 本控制器内的通道号。
 *
 * 多控制器器件（V407：DMA1 = 全局 1..13，DMA2 = 全局 14..24）把两颗控制器的
 * 通道号拼成一段连续的全局编号，这样界面和冲突检测都能继续用「通道 1..N」的模型，
 * 只有真正生成代码时才把这个全局号拆回 `DMAy_ChannelX`。
 */
export function dmaRef(dev: DeviceDef, globalChannel: number): { ctrl: string; local: number } {
  let off = 0;
  for (const c of dmaControllers(dev)) {
    if (globalChannel <= off + c.channels) return { ctrl: c.id, local: globalChannel - off };
    off += c.channels;
  }
  // 越界兜底：当成最后一颗控制器的末尾通道
  const last = dmaControllers(dev).at(-1)!;
  return { ctrl: last.id, local: Math.min(globalChannel - off, last.channels) };
}

/** 把全局通道号格式化成「DMA1·5」这种带控制器前缀的展示串 */
export function formatDmaChannel(dev: DeviceDef, globalChannel: number): string {
  const { ctrl, local } = dmaRef(dev, globalChannel);
  return `${ctrl}·${local}`;
}

/** 全工程已分配的 DMA 通道 */
export function collectDma(project: Project, dev: DeviceDef): DmaAlloc[] {
  const out: DmaAlloc[] = [];
  for (const def of dev.peripherals) {
    const cfg = project.configs[def.id];
    if (!cfg?.enabled) continue;
    for (const d of cfg.dmaChannels ?? []) {
      out.push({
        owner: def.id,
        request: d.request,
        channel: d.channel,
        dir: d.dir,
        mode: d.mode,
        priority: d.priority,
        width: d.width,
        incMem: d.incMem,
        cfg: d,
      });
    }
  }
  return out.sort((a, b) => a.channel - b.channel);
}

/** 同一个通道被两个请求占用 → 冲突（硬件上根本跑不起来） */
export function dmaConflicts(allocs: DmaAlloc[]): { channel: number; a: DmaAlloc; b: DmaAlloc }[] {
  const out: { channel: number; a: DmaAlloc; b: DmaAlloc }[] = [];
  const byCh = new Map<number, DmaAlloc[]>();
  for (const a of allocs) {
    const arr = byCh.get(a.channel) ?? [];
    arr.push(a);
    byCh.set(a.channel, arr);
  }
  for (const [channel, arr] of byCh) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!;
        const b = arr[j]!;
        out.push({ channel, a, b });
      }
    }
  }
  return out;
}

/** 已用通道号集合 */
export function usedChannels(allocs: DmaAlloc[]): Set<number> {
  return new Set(allocs.map((a) => a.channel));
}

/** 空闲通道号 */
export function freeChannels(dev: DeviceDef, allocs: DmaAlloc[]): number[] {
  const used = usedChannels(allocs);
  const out: number[] = [];
  for (let n = 1; n <= dmaChannelCount(dev); n++) if (!used.has(n)) out.push(n);
  return out;
}

/**
 * 给某个请求挑一条通道。
 *
 * 有 RM 映射表时只在**合法通道**里挑（且避开已占用的）；
 * 没有映射表（L103 目前还没录 RM）时退化成「挑最小空闲通道」，
 * 调用方要把「未核验」这句话显示出来 —— 通道选错在硬件上是静默失效。
 */
export function suggestChannel(
  dev: DeviceDef,
  allocs: DmaAlloc[],
  request: string,
  exceptOwner?: string,
): number | null {
  const used = new Set(allocs.filter((a) => a.owner !== exceptOwner).map((a) => a.channel));
  const hasMap = Boolean(dev.dmaMap && Object.keys(dev.dmaMap).length > 0);
  const legal = channelsFor(dev, request);
  if (hasMap && legal.length === 0) return null; // 这颗片子上该请求没有 DMA 通道
  const pool = legal.length > 0 ? legal : Array.from({ length: dmaChannelCount(dev) }, (_, i) => i + 1);
  return pool.find((n) => !used.has(n)) ?? null;
}

/**
 * 一条分配是否落在合法通道上。
 *
 * - 没有映射表 → `null`（未知，只能保证不重复）
 * - 有表但请求不在表里 → `false`（这个请求在这颗片子上根本不能走 DMA）
 */
export function channelIsLegal(dev: DeviceDef, request: string, channel: number): boolean | null {
  const hasMap = Boolean(dev.dmaMap && Object.keys(dev.dmaMap).length > 0);
  if (!hasMap) return null;
  return channelsFor(dev, request).includes(channel);
}

/** 默认参数：一条新分配的通道 */
export function defaultDmaChannel(
  dev: DeviceDef,
  allocs: DmaAlloc[],
  request: string,
  dir: "p2m" | "m2p",
  periphId?: string,
): DmaChannelCfg | null {
  const channel = suggestChannel(dev, allocs, request, periphId);
  if (channel == null) return null;
  return {
    request,
    channel,
    dir,
    mode: "normal",
    priority: "medium",
    width: "8",
    incMem: true,
    irqTc: false,
    irqHt: false,
  };
}

/** 某外设当前已分配的请求名集合 */
export function allocatedRequests(cfg: PeripheralConfig): Set<string> {
  return new Set((cfg.dmaChannels ?? []).map((d) => d.request));
}

/** 通道上还空着还是被谁占了 —— 给下拉框显示用 */
export function channelOwner(allocs: DmaAlloc[], channel: number, exceptOwner?: string): DmaAlloc | null {
  return allocs.find((a) => a.channel === channel && a.owner !== exceptOwner) ?? null;
}
