/**
 * 显示模式分段：**一条边一段**，而不是按引脚号机械切 16。
 *
 * 以前 LQFP64 会被切成「1–16 / 17–32 / 33–48 / 49–64」三/四段，看起来像按号
 * 分页，实际上和封装的边完全对不上（一边 16 个脚只是巧合）。完整布局的摆法
 * 是「数组四等分 = 左/下/右/上」，这里沿用同一套切分 —— 每段正好是一条边，
 * 列表模式的导轨读起来就是「芯片的这一条边」。
 */
import type { DeviceDef, PinDef } from "../../model/types";

export interface LayoutSeg {
  /** 布局值：`side:left` 等，直接存进 layout 状态 */
  key: string;
  /** 人话标签：左列 / 下排 / 右列 / 上排（双列封装只有左右） */
  label: string;
  /** 该边的引脚（数组切片，顺序与完整布局一致） */
  pins: PinDef[];
}

export function layoutSegments(dev: DeviceDef): LayoutSeg[] {
  const pins = dev.package.pins;
  const n = pins.length;
  if (dev.package.shape === "dual") {
    const half = Math.ceil(n / 2);
    return [
      { key: "side:left", label: "左列", pins: pins.slice(0, half) },
      { key: "side:right", label: "右列", pins: pins.slice(half) },
    ];
  }
  const per = Math.ceil(n / 4);
  return [
    { key: "side:left", label: "左列", pins: pins.slice(0, per) },
    { key: "side:bottom", label: "下排", pins: pins.slice(per, per * 2) },
    { key: "side:right", label: "右列", pins: pins.slice(per * 2, per * 3) },
    { key: "side:top", label: "上排", pins: pins.slice(per * 3) },
  ];
}

/** 段内引脚号范围（引脚号可能不是连续数字，取 min–max） */
export function rangeLabel(pins: PinDef[]): string {
  const nums = pins.map((p) => p.num).filter((x): x is number => typeof x === "number");
  if (!nums.length) return "";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}
