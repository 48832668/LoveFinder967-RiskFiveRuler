/**
 * 引脚图共享常量与小工具。
 *
 * 从 PinoutView.tsx 拆出：绘制（drawPin / 列表布局）、弹出菜单（PinMenu）、
 * 主组件都要用这批值与类型，单独成文件避免互相 import 打环。
 */
import type { DeviceDef, PinDef } from "../../model/types";

/** 命中测试矩形（芯片坐标系；完整布局下屏幕坐标要经逆旋转/缩放换算） */
export interface Hit {
  pin: PinDef;
  x: number;
  y: number;
  w: number;
  h: number;
  side: "left" | "right" | "top" | "bottom";
}

export interface LegendRow {
  key: string;
  name: string;
  color: string;
  owner: string | null;
}

export const PIN_LEN = 26;
/** 色块里写信号名用的字体；长度按它的实测宽度算，见 draw() 里的 widestChip */
export const PIN_TEXT_FONT = "8px 'Cascadia Mono', Consolas, monospace";
/** 文字两侧留白 */
export const PIN_TEXT_PAD = 5;
export const PIN_THICK = 15;
/**
 * 引脚色块与芯片本体之间的缝隙。
 *
 * 原来是紧贴的（x = bx - chip），在本体的 6px 圆角处会出现「引脚的 2.5px 圆角
 * 咬进本体圆角」的视觉干涉。留 4px 之后两者各画各的，读起来是两个零件。
 */
export const PIN_GAP = 9;
/**
 * 水平引脚名与本体边框的内缩量（px）。
 *
 * 以前名字从色块边缘 +5px 开始写，而色块与本体之间还有 PIN_GAP=9 的缝，
 * 等于文字从边框外侧 4px 起笔、横跨边框 —— 在本体圆角处会和描边压在一起。
 * 现在让名字完全落到本体内侧，距边框至少 12px（9.5px 等宽字体约两个字符宽）。
 * 列表布局不走这个内缩：那里没有本体边框，名字本来就该贴着色块右侧。
 */
export const PIN_NAME_INSET = 12;
export const LABEL_PAD = 6;
/** 四角最小留白：防止 1 脚（横排标签）与 N 脚（竖排标签）的名字在角上相撞 */
export const CORNER_MIN = 34;
export const CORNER_MAX = 74;

export const GPIO_MODES: { m: string; label: string }[] = [
  { m: "input", label: "输入" },
  { m: "output_pp", label: "推挽输出" },
  { m: "output_od", label: "开漏输出" },
  { m: "analog", label: "模拟" },
];

export const KIND_ORDER = [
  "USART", "UART", "SPI", "QSPI", "I2S", "I2C", "TIM", "ADC", "DAC", "OPA", "FDA", "CMP", "VCMP",
  "CAN", "USB", "USBPD", "LPTIM", "PIOC", "SYSTEM",
];

/**
 * 信号短名 → 人话。
 *
 * 有些短名在不同外设下含义不同（`TX` 在 USART 是串口发送、在 CAN 是 CAN 发送；
 * `CK` 在 USART 是波特率时钟、在 I2S 是位时钟），所以 `describeSignal` 先按外设
 * 种类查 `KIND_DESC`，查不到再落到这张通用表。
 */
export const KIND_DESC: Record<string, Record<string, string>> = {
  CAN: { TX: "CAN 发送", RX: "CAN 接收" },
  I2S: { CK: "I²S 位时钟", WS: "声道选择", SDIN: "音频输入", SDOUT: "音频输出", MCK: "主时钟" },
  QSPI: { CLK: "QSPI 时钟", NSS: "QSPI 片选" },
  UART: { TX: "串口发送", RX: "串口接收" },
  VCMP: { OUT: "比较器输出" },
  DAC: { OUT: "DAC 输出" },
  DBG: { SWDIO: "调试数据", SWCLK: "调试时钟", SWO: "调试输出", JTDI: "JTAG 数据入", JTAG: "JTAG" },
};

export const SIGNAL_DESC: Record<string, string> = {
  TX: "串口发送",
  RX: "串口接收",
  CK: "串口时钟",
  CTS: "清除发送",
  RTS: "请求发送",
  SCK: "SPI 时钟",
  MISO: "主入从出",
  MOSI: "主出从入",
  NSS: "片选",
  SCL: "I²C 时钟",
  SDA: "I²C 数据",
  SMBA: "SMBus 告警",
  ETR: "外部触发",
  BKIN: "刹车输入",
  DP: "USB D+",
  DM: "USB D−",
  CC1: "PD CC1",
  CC2: "PD CC2",
  SWDIO: "调试数据",
  SWCLK: "调试时钟",
  MCO: "时钟输出",
};

/**
 * 复用编号在角标上的写法。
 *
 * WCH 的 AFIO 是「重映射组」，`⟲1` 读作"组 1"；HC32 是逐引脚选 AF，`AF4` 就是 AF4。
 * 两者共用同一个数据字段（`remap`），但显示的语义必须分开，否则会被误读。
 */
export function remapMark(dev: DeviceDef): string {
  return dev.afGrouping === "grouped" ? "⟲" : "AF";
}

export function remapHint(dev: DeviceDef): string {
  return dev.afGrouping === "grouped"
    ? "复用功能的重映射组编号（同一外设的信号必须在同一组）"
    : "该引脚要选择的复用功能编号（AF，逐引脚独立，不受其它信号影响）";
}

/** 把 SPI1_SCK / TIM1_CH1N / ADC1_IN4 / EXTI6 翻成一句人话 */
export function describeSignal(fn: string, kind?: string): string {
  const sig = fn.slice(fn.indexOf("_") + 1);
  let m: RegExpExecArray | null;
  if ((m = /^D([0-3])$/.exec(sig))) return `QSPI 数据 ${m[1]}`;
  if (kind === "VCMP" && (m = /^CH(\d)$/.exec(sig))) return `比较器输入 CH${m[1]}`;
  if ((m = /^CH(\d)N$/.exec(sig))) return `定时器 CH${m[1]} 互补`;
  if ((m = /^CH(\d)$/.exec(sig))) return `定时器 CH${m[1]}`;
  if ((m = /^IN(\d+)$/.exec(sig))) return `ADC 通道 ${m[1]}`;
  if ((m = /^LINE(\d+)$/.exec(sig))) return `外部中断线 ${m[1]}`;
  if ((m = /^([PN])(\d+)$/.exec(sig))) return `${m[1] === "P" ? "正端" : "负端"}输入 ${m[2]}`;
  if ((m = /^OUT(\d*)$/.exec(sig))) return `输出${m[1]}`;
  if ((m = /^IO(\d+)$/.exec(sig))) return `PIOC 通道 ${m[1]}`;
  if ((m = /^INP(\d+)$/.exec(sig))) return `同相输入 ${m[1]}`;
  if ((m = /^INN(\d+)$/.exec(sig))) return `反相输入 ${m[1]}`;
  if ((m = /^OUT([PN])$/.exec(sig))) return `差分输出 ${m[1] === "P" ? "+" : "−"}`;
  if (kind && KIND_DESC[kind]?.[sig]) return KIND_DESC[kind]![sig]!;
  return SIGNAL_DESC[sig] ?? "";
}

/** 在饱和色块上写字：按亮度选黑或白，否则黄底白字＝看不见 */
export function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#0d1117";
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // 感知亮度（Rec.601）：>0.62 用深字，否则用浅字
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? "#101720" : "#ffffff";
}
