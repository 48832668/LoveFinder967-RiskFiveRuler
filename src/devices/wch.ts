/**
 * WCH 器件包的**厂商专属部分**：外设 id → 元数据。
 *
 * 加载、引脚组装、排序、校验都在 `packs/`（厂商无关）。
 * 这里只留 WCH 的命名约定与历史遗留：
 *   - `META` 表：`peripherals[].meta` 还没写进 JSON 的 4 个老包靠它兜底；
 *   - `metaOf()`：`USART1` → `USART` 的实例拆分（WCH 命名习惯）。
 *
 * 新厂商（HC32 等）**不要**往这里加东西 —— 把 meta 写进自己的器件包 JSON。
 */

import type { PackMeta } from "../model/types";
import type { PackFile } from "../packs/types";
import { loadPack as loadPackGeneric } from "../packs/loader";

export type { PackFile, PackPackage, PackPeripheral, PackPin, PackSignal } from "../packs/types";

/* ───────────────────── 外设 id -> 元数据 ───────────────────── */

const META: Record<string, PackMeta> = {
  GPIO: { kind: "GPIO", group: "System", schema: "GPIO", brief: "端口模式与上/下拉" },
  SYSTEM: { kind: "SYSTEM", group: "System", schema: "SYSTEM", brief: "SWD / MCO / 中断控制器" },
  RTC: { kind: "RTC", group: "System", schema: "RTC", brief: "32 位独立定时器 + 后备域" },
  PWR: { kind: "PWR", group: "System", schema: "PWR", brief: "低功耗模式与 PVD" },
  EXTI: { kind: "EXTI", group: "System", schema: "EXTI", brief: "外部中断线" },
  CLK: { kind: "CLK", group: "System", schema: "CLK", brief: "HSE / LSE 外部晶振", label: "时钟源" },
  DBG: { kind: "DBG", group: "System", schema: "DBG", brief: "2 线 SDI 调试口 / 冻结点", label: "调试接口", required: ["SWDIO", "SWCLK"] },
  CRC: { kind: "CRC", group: "Security", schema: "CRC", brief: "CRC 计算单元" },
  DMA: { kind: "DMA", group: "System", schema: "DMA", brief: "8 通道通用 DMA" },
  IWDG: { kind: "IWDG", group: "Security", schema: "IWDG", brief: "独立看门狗" },
  WWDG: { kind: "WWDG", group: "Security", schema: "WWDG", brief: "窗口看门狗" },
  LPTIM: { kind: "TIM", group: "Timers", schema: "TIM", brief: "低功耗定时器", label: "LPTIM" },
  ADC1: { kind: "ADC", group: "Analog", schema: "ADC", brief: "12 位逐次逼近 ADC" },
  // CAN 少了 TX 或 RX 就没法收发，写成必需信号，否则启用后一个引脚都不分
  CAN1: { kind: "CAN", group: "Connectivity", schema: "CAN", brief: "CAN 2.0B 主动控制器", required: ["TX", "RX"] },
  // USB 的全速 PHY 是 DP/DM 一对差分线，缺一根就没法跑 ——
  // 写成必需信号，封装没引出（或只引出一根）时整个外设会从树里隐掉，
  // 而不是留在列表里让人点进去发现「无法启用」。
  USB1: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 全速设备/主机", required: ["DP", "DM"] },
  USBHS1: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 高速设备/主机", required: ["DP", "DM"] },
  USBHS2: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 高速设备/主机", required: ["DP", "DM"] },
  // PD 控制器是独立外设：走 CC1/CC2，没有 DP/DM，所以有自己的参数模式
  USBPD: {
    kind: "USB",
    group: "Connectivity",
    schema: "USBPD",
    brief: "USB PD / Type-C 控制器（CC1/CC2）",
    required: ["CC1", "CC2"],
  },
  PIOC: { kind: "SYSTEM", group: "Connectivity", schema: "SYSTEM", brief: "可编程协议 I/O 控制器" },
  // DVP：数字视频端口（并行摄像头接口），数据走 DMA（CH32V4x7 的 DMA2_Channel5 / 全局通道 18）。
  // 参数（DVP_CTL / STS / FIFO 等）尚未建模，只生成时钟使能 + TODO，与 ETH/LTDC/FSMC 同级。
  DVP: {
    kind: "DVP",
    group: "Connectivity",
    schema: "DVP",
    brief: "数字视频端口（DVP，并行摄像头接口）",
    required: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "HSYNC", "VSYNC"],
  },
};

export function metaOf(id: string): PackMeta {
  if (META[id]) return META[id];
  // 注意 I2C 这种 id 中间带数字，不能用 ^([A-Z]+)(\d*)$ —— 会把整个 id 当成 base
  const m = /^([A-Z][A-Z0-9]*?)(\d*)$/.exec(id);
  const base = m?.[1] ?? id;
  switch (base) {
    case "USART":
      return { kind: "USART", group: "Connectivity", schema: "USART", brief: "通用同步/异步收发器", required: ["TX", "RX"] };
    case "SPI":
      return { kind: "SPI", group: "Connectivity", schema: "SPI", brief: "串行外设接口", required: ["SCK", "MOSI", "MISO"] };
    case "I2C":
      return { kind: "I2C", group: "Connectivity", schema: "I2C", brief: "I²C / SMBus 控制器", required: ["SCL", "SDA"] };
    case "TIM":
      return { kind: "TIM", group: "Timers", schema: "TIM", brief: "16 位定时器" };
    case "OPA":
      return { kind: "OPA", group: "Analog", schema: "OPA", brief: "运算放大器 / PGA" };
    case "CMP":
      return { kind: "CMP", group: "Analog", schema: "CMP", brief: "模拟电压比较器" };
    default:
      return { kind: "SYSTEM", group: "System", schema: "SYSTEM", brief: "" };
  }
}

/* ───────────────────────────── 加载 ───────────────────────────── */

/**
 * 一个器件包 JSON -> 每个封装一个 DeviceDef。
 *
 * 组装逻辑全在 `packs/loader.ts`；这里只提供 WCH 的元数据兜底，
 * 让历史上没写 `meta` 字段的 4 份 JSON 继续可用。
 */
export function loadPack(pack: PackFile) {
  return loadPackGeneric(pack, metaOf);
}
