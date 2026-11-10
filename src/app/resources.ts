/**
 * 器件资源摘要
 *
 * 选择器件时用一张表把「这颗片子到底有多少外设」摊开，方便横向比较。
 * 全部从器件包现算，不额外维护一份数据 —— 换了器件包，表自动跟着变。
 *
 * 外设条数按「当前封装上真能引出来的实例」统计：
 * 数据手册的资源表也是这个口径（例如 X035 的 QFN20 只标 3 个串口）。
 */

import type { DeviceDef } from "../model/types";
import { peripheralUnavailable, peripheralUsable, pinsForSignal } from "../semantic/pinmux";
import { dmaChannelCount } from "../engine/dma";

export interface ResRow {
  label: string;
  value: string;
  /** 次要说明，灰字跟在值后面 */
  hint?: string;
  /** 该项为「无」时整体淡化 */
  off?: boolean;
}

export interface ResGroup {
  title: string;
  rows: ResRow[];
}

const DASH = "—";

function countKind(dev: DeviceDef, kind: string) {
  const all = dev.peripherals.filter((p) => p.kind === kind);
  const usable = all.filter((p) => peripheralUsable(dev, p.id));
  return { total: all.length, usable: usable.length };
}

function fmtCount(dev: DeviceDef, kind: string, unit = "个"): ResRow["value"] {
  const { total, usable } = countKind(dev, kind);
  if (total === 0) return DASH;
  if (usable === total) return `${total} ${unit}`;
  return `${usable} ${unit}`;
}

function hintCount(dev: DeviceDef, kind: string): string | undefined {
  const { total, usable } = countKind(dev, kind);
  return usable < total ? `共 ${total}，本封装完整引出 ${usable}` : undefined;
}

/** ADC 外部通道数：数 ADC1 引出来的 INn */
function adcChannels(dev: DeviceDef): number {
  const adc = dev.peripherals.find((p) => p.kind === "ADC");
  if (!adc) return 0;
  /**
   * 按「本封装真的能用的通道」数，而不是控制器声明了几个。
   *
   * 数据手册的资源表就是这么列的：L103 五款是 `10+3`，只有 TSSOP20 是 `9+3`
   * —— 因为 TSSOP20 没引出 PB0（ADC_IN8）。按声明数会把所有封装都显示成 10。
   */
  return adc.signals.filter(
    (s) => /^IN\d+$/.test(s.name) && pinsForSignal(dev, `ADC1_${s.name}`).length > 0,
  ).length;
}

export function deviceResources(dev: DeviceDef): ResGroup[] {
  /**
   * 「可用 GPIO」按**物理引脚**数算。
   *
   * 两个坑：
   *   1. 有的封装把两个端口短接在同一个脚上（F8P6 的 PA13 兼作 PB6），
   *      这时仍只算 1 个 GPIO —— 所以 io 引脚的 aliases 不加。
   *   2. K8U6/K8U7 的 BOOT0 脚同时就是 PB9，手册的资源表把它算进 GPIO（31 个），
   *      而这种「复用成 BOOT0 的脚」在数据里 kind 是 boot、带 PB9 别名，要补上。
   */
  const ioPins = dev.package.pins.reduce((n, p) => {
    if (p.kind === "io") return n + 1;
    if (p.kind === "boot" && (p.aliases?.length ?? 0) > 0) return n + 1;
    return n;
  }, 0);
  const usb = countKind(dev, "USB").total > 0 && dev.peripherals.some((p) => p.id === "USB1" && !peripheralUnavailable(dev, p.id));
  const pd = dev.peripherals.some((p) => p.id === "USBPD" && !peripheralUnavailable(dev, p.id));
  const can = countKind(dev, "CAN");

  const groups: ResGroup[] = [
    {
      title: "外设",
      rows: [
        { label: "串口 USART", value: fmtCount(dev, "USART"), hint: hintCount(dev, "USART") },
        { label: "SPI", value: fmtCount(dev, "SPI"), hint: hintCount(dev, "SPI") },
        { label: "I²C", value: fmtCount(dev, "I2C"), hint: hintCount(dev, "I2C") },
        { label: "CAN", value: can.total === 0 ? DASH : fmtCount(dev, "CAN"), off: can.total === 0 },
        { label: "定时器 TIM", value: fmtCount(dev, "TIM"), hint: hintCount(dev, "TIM") },
        { label: "ADC 外部通道", value: adcChannels(dev) ? `${adcChannels(dev)} 路` : DASH, off: !adcChannels(dev) },
        { label: "运放 OPA", value: fmtCount(dev, "OPA"), off: countKind(dev, "OPA").total === 0 },
        { label: "比较器 CMP", value: fmtCount(dev, "CMP"), off: countKind(dev, "CMP").total === 0 },
        { label: "DMA 通道", value: dmaChannelCount(dev) ? `${dmaChannelCount(dev)} 路` : DASH, off: !dmaChannelCount(dev) },
        { label: "外部中断线", value: dev.extiLines ? `${dev.extiLines} 线` : DASH, off: !dev.extiLines },
      ],
    },
    {
      title: "存储与主频",
      rows: [
        { label: "最高主频", value: `${dev.clock.maxSysclk} MHz` },
        { label: "Flash", value: `${dev.flashKb} KB` },
        { label: "SRAM", value: `${dev.ramKb} KB` },
      ],
    },
    {
      title: "接口 PHY",
      rows: [
        { label: "USB FS PHY", value: usb ? "有" : DASH, off: !usb },
        { label: "USB PD PHY", value: pd ? "有" : DASH, off: !pd },
      ],
    },
    {
      title: "封装",
      rows: [
        { label: "封装形式", value: dev.package.label },
        { label: "引脚数", value: `${dev.package.pins.length} 脚` },
        { label: "可用 GPIO", value: `${ioPins} 个` },
        { label: "供电电压", value: dev.voltage },
      ],
    },
  ];
  return groups;
}
