/**
 * 引脚 ↔ 复用 的底层查询原语。
 *
 * 从 pinmux.ts 拆出：它只依赖器件包的引脚数据，不依赖 schema / 工程，
 * 是「引脚规划」「重映射组」两个板块的共同地基 —— 分开存放避免两者互相 import 打环。
 */
import type { DeviceDef, PinDef } from "../model/types";

/** 某个引脚上能承载的信号（按器件包查） */
export function signalsOnPin(dev: DeviceDef, pinName: string): string[] {
  const p = dev.package.pins.find((x) => x.name === pinName);
  return (p?.signals ?? []).map((s) => s.fn);
}

/** 某个信号在这颗器件、这个封装上可选的引脚 */
export function pinsForSignal(dev: DeviceDef, fn: string): PinDef[] {
  return dev.package.pins.filter((p) => (p.signals ?? []).some((s) => s.fn === fn));
}

/**
 * 该信号在当前封装上是否可用。
 *
 * 数据手册的引脚定义表覆盖整个系列，小封装只引出一部分引脚，
 * 所以「USART1_TX 存在」不等于「这个封装的 USART1_TX 存在」。
 * 界面用这个函数把选不到引脚的信号标成「不可用」。
 */
export function signalAvailable(dev: DeviceDef, fn: string): boolean {
  return pinsForSignal(dev, fn).length > 0;
}

/**
 * 该脚上该信号能落在**哪些**重映射组。
 *
 * 必须返回数组：同一个物理脚常把同一信号实现两次以上 ——
 * 例如 X035 的 PB11，`USART1_RX` 既是默认功能（组 0）又在组 2。
 * 早先这里用 `find` 只取第一条，于是「组 0」被永久隐藏，
 * USART1 在组 0 明明能配出 TX+PB11，却被判定缺 RX。
 */
export function remapsAt(dev: DeviceDef, pin: string, fn: string): number[] {
  const def = dev.package.pins.find((p) => p.name === pin);
  const out: number[] = [];
  for (const e of def?.signals ?? []) {
    if (e.fn === fn) out.push(Number(e.remap ?? 0));
  }
  return out.length ? out : [0];
}

/** 该信号在该脚上的**首选**组号（能走默认就不动 AFIO，所以取最小值） */
export function remapOf(dev: DeviceDef, pin: string, fn: string): number {
  return Math.min(...remapsAt(dev, pin, fn));
}
