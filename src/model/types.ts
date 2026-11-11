/**
 * RiskFiveRuler — 核心数据模型
 *
 * 三层结构：
 *   1. DeviceDef   器件包（封装 / 引脚 / 外设 / 时钟 / 中断），静态、可扩展
 *   2. Project     用户工程（每个外设的使能、参数、引脚分配、GPIO 属性）
 *   3. Derivation  由 1+2 推导出来的视图（引脚占用表、时钟频率、冲突列表、生成的代码）
 *
 * 设计原则：器件包只描述「硬件有什么」，界面与代码生成全部由参数模式（schema）驱动，
 * 这样新增一颗芯片 = 新增一个 JSON/TS 器件包，不需要动任何界面代码。
 */

/* ────────────────────────────── 条件表达式 ────────────────────────────── */

export type Cond =
  | { k: string; op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "notin"; v: string | number | boolean | (string | number)[] }
  | { and: Cond[] }
  | { or: Cond[] }
  | { not: Cond }
  | { always: boolean };

/* ────────────────────────────── 参数模式 ────────────────────────────── */

export type ParamType = "select" | "number" | "text" | "boolean" | "note";

export interface ParamOption {
  label: string;
  value: string;
  /** 选中该项时，该外设需要占用的信号（如 USART 同步模式需要 CK） */
  signals?: string[];
  /**
   * 选中该项时**必须分配**的信号，会覆盖器件包给的默认必需信号。
   *
   * 例：USART 器件包写死 required = TX/RX（异步的最小配置），
   * 但单线半双工只用 TX、同步模式只用 TX+CK —— 模式声明了自己的清单后，
   * 就按模式的来，否则会出现「选了单线却还逼着分配 RX」。
   */
  required?: string[];
  /** 该项不可选的条件（例如 SmartCard 模式下 8 位字长非法） */
  disabledIf?: Cond;
  /**
   * 该项需要的**设备能力**门槛（如 "usb.hs"：dev.usb.speeds 含 "hs" 才可选）。
   *
   * 用于「同一 schema 服务多个芯片，但某档只有部分芯片有硬件」的场景——
   * FS-only 的 X035/X033/L103 不该在 USB 速度下拉里看到「高速 480 Mbps」。
   * 没写 cap 的选项视为无门槛。
   */
  cap?: string;
  hint?: string;
}

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  default: string | number | boolean;
  options?: ParamOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** 参数下方的灰字说明，来自参考手册的位域含义 */
  hint?: string;
  /** 单位换算提示，如 "fPCLK2 / (16 × USARTDIV)" */
  formula?: string;
  visibleIf?: Cond;
  enabledIf?: Cond;
  /** 所属折叠分组；不填则直接挂在外设根上 */
  group?: string;
  /** 高级参数默认收起 */
  advanced?: boolean;
  /** 只在某个模式下出现（等价于 visibleIf，写起来更短） */
  whenMode?: string[];
  placeholder?: string;
  /**
   * 改这个参数会改变「必须占哪几根线」。
   *
   * 例：USART 的数据方向选「仅发送」时 RX 不该再占引脚，选「仅接收」时 TX 不该占 ——
   * 界面据此在改完参数后立刻重排引脚，而不是等用户切模式。
   */
  affectsPins?: boolean;
}

export interface ParamGroup {
  key: string;
  label: string;
  /** 默认展开 */
  open?: boolean;
  advanced?: boolean;
  hint?: string;
}

/** 通道表（TIM 的 CH1..CH4、ADC 的通道、DMA 的通道） */
export interface ChannelSchema {
  label: string;
  /** 通道数量 */
  count: number;
  /** 通道名前缀，如 CH */
  prefix: string;
  /** 通道编号起点，默认 1；EXTI 这类从 0 开始的填 0 */
  startAt?: number;
  /** 每通道的模式选项 */
  modes: ParamOption[];
  /** 每通道额外的参数 */
  params?: ParamDef[];
  /** 通道是否需要绑定引脚 */
  needsPin?: boolean;
  hint?: string;
}

/** 一个外设实例的完整配置界面描述 */
export interface PeripheralSchema {
  /** 模式选择（决定其余参数可见性）；没有模式概念的外设可省略 */
  modeKey?: string;
  groups?: ParamGroup[];
  params: ParamDef[];
  /** 参数之外的特殊面板 */
  panels?: ("nvic" | "dma" | "gpio" | "pins" | "channelTable" | "dmaTable" | "adcTable")[];
  channelSpec?: ChannelSchema;
  /** 顶部说明 */
  about?: string;
}

/* ────────────────────────────── 引脚与封装 ────────────────────────────── */

export type PinKind = "io" | "power" | "reset" | "osc" | "nc" | "boot";

export interface PinSignal {
  /** 完整信号名，必须与 PeripheralDef 的 signal 名称拼法一致：<实例>_<信号> */
  fn: string;
  /** 复用编号（WCH 用 AFIO 重映射组，这里仅作展示） */
  af?: number;
  /** 重映射组，同一组互斥 */
  remap?: string;
}

export interface PinDef {
  /** 物理引脚号，1 起；EP 表示裸露焊盘 */
  num: number | "EP";
  /** 端口名，如 PD5 / VDD / NRST */
  name: string;
  kind: PinKind;
  /** 该引脚可承载的复用信号 */
  signals?: PinSignal[];
  /** 附加说明（如 "5V 容忍"、"上电默认 SWIO"） */
  note?: string;
  /** 内部短接合封的另一个端口名，同样算作可用 IO */
  aliases?: string[];
}

export type PackageShape = "quad" | "dual" | "qfn" | "sop";

/**
 * 引脚编号的来源。
 *   package  —— 数据手册给的物理引脚号（WCH 全系都是）
 *   sequence —— 手册只给了「本封装引出了哪些端口」，引脚号是工具按端口顺序推的序号，
 *               **不等于封装的实际引脚号**。界面必须显著标注，否则用户会照着它画板子。
 */
export type PinNumbering = "package" | "sequence";

/** 复用功能的分组语义，详见 DeviceDef.afGrouping */
export type AfGrouping = "grouped" | "independent";

export interface PackageDef {
  id: string;
  label: string;
  shape: PackageShape;
  /** 按引脚号顺序排列 */
  pins: PinDef[];
  /**
   * 引脚编号的来源，缺省 `package`。
   * `sequence` = 手册只给了「本封装引出哪些端口」，这里的号是按端口顺序推的**序号**，
   * 不是封装的实际引脚号 —— 界面必须标注，否则用户会照着它画板子。
   */
  pinNumbering?: PinNumbering;
}

/* ────────────────────────────── 外设 ────────────────────────────── */

export type PeripheralKind =
  | "USART"
  /** 只能异步的串口（HC32 的 UART4/5、STM32 的 LPUART） */
  | "UART"
  | "SPI"
  /** 四线 QSPI / OSPI 控制器 */
  | "QSPI"
  /** I²S 音频接口 */
  | "I2S"
  | "DAC"
  | "I2C"
  | "TIM"
  | "ADC"
  | "GPIO"
  | "USB"
  | "CAN"
  | "OPA"
  | "CMP"
  /** 电压比较器（HC32 的 VC0..VC2：输出 + 多路输入） */
  | "VCMP"
  | "IWDG"
  | "WWDG"
  | "RTC"
  | "PWR"
  | "EXTI"
  | "CLK"
  | "DBG"
  | "CRC"
  | "DMA"
  /** 数字视频端口（DVP，并行摄像头接口） */
  | "DVP"
  | "SYSTEM";

export type PeripheralGroup = "System" | "Analog" | "Timers" | "Connectivity" | "Middleware" | "Security";

/**
 * 器件包里「这个外设是什么」的元数据。
 *
 * 以前这张表写死在 `devices/wch.ts` 的 `META` 里，并用一条正则从 id 猜类型 ——
 * 那是 WCH 的命名习惯（USART1 / TIM2）。换一家厂商（HC32 的 `FDA0`、`VC1`、
 * `UART4`）就全落到 SYSTEM 兜底。现在它属于**数据**，随器件包一起提供。
 */
export interface PackMeta {
  kind: PeripheralKind;
  group: PeripheralGroup;
  /** 引用 schemas.ts 里的键 */
  schema: string;
  brief: string;
  /** 必需信号（启用后必须全部分配）；缺一根就判定该封装不可用 */
  required?: string[];
  /** 树里显示的短名（缺省用 id） */
  label?: string;
}

export interface SignalDef {
  /** 短名，如 TX / RX / SCK；完整名为 <实例>_<短名> */
  name: string;
  /** 方向，仅用于引脚视图箭头 */
  dir?: "in" | "out" | "io";
  /** 必需信号：启用外设后必须全部分配 */
  required?: boolean;
}

export interface PeripheralDef {
  /** 实例 id，如 USART1 / TIM1 / ADC1 */
  id: string;
  kind: PeripheralKind;
  label: string;
  group: PeripheralGroup;
  /** 实例序号 */
  index: number;
  /** 一句话描述，显示在树节点右侧与配置页头部 */
  brief?: string;
  signals: SignalDef[];
  /** 引用 schemas.ts 中的键 */
  schema: string;
  /** 该实例是否可用（某些封装不引出） */
  available?: boolean;
  /** 中断号，用于 NVIC 面板 */
  irq?: { n: number; name: string; desc?: string; gate?: string | string[] }[];
}

/**
 * 标准外设库的 API 差异。
 *
 * WCH 各系列**不是同一套 API**（这是实测结论，不是猜的）：
 * X035 的 RCC 只有 13 个函数 —— 没有 PLL、没有 SYSCLK 切换、没有 APB 预分频、
 * 也没有 ADC 时钟接口，ADC 的时钟要用 `ADC_CLKConfig(ADC1, ADC_CLK_Div6)` 配；
 * Flash 也没有 `FLASH_PrefetchBufferCmd`。
 *
 * 把这些差异写成数据而不是在生成器里 if-else 系列名，
 * 是因为「哪颗片子有哪些 API」属于硬件事实，该和引脚一起放在器件包里。
 */
export interface ApiProfile {
  /** 时钟树能力：full = PLL + SYSCLK 切换 + APB 分频；hsi-only = 只有 HSI 与 HCLK */
  clockProfile: "full" | "hsi-only";
  /**
   * 外设时钟使能的命名。WCH 有两套：
   *   apb → `RCC_APB2PeriphClockCmd` / `RCC_AHBPeriphClockCmd`（V30x、X035、L103）
   *   pb  → `RCC_PB2PeriphClockCmd` / `RCC_PB1PeriphClockCmd` / `RCC_HBPeriphClockCmd`（V407、M030）
   * 宏前缀也跟着变（`RCC_APB2Periph_GPIOA` vs `RCC_PB2Periph_GPIOA`）。
   */
  clockApi?: "apb" | "pb";
  /**
   * NVIC 接口。V407 只用 core_riscv.h 的 `NVIC_EnableIRQ` / `NVIC_SetPriority`，
   * 没有 `NVIC_Init`，也没有 `NVIC_PriorityGroupConfig`。
   */
  nvicApi?: "stdlib" | "cmsis";
  /**
   * EVT 的 `debug.h` 里有没有 SDI 串口打印（`SDI_PRINT` / `SDI_PR_OPEN` / `SDI_Printf_Enable`）。
   *
   * X035 / V407 有，**L103 没有** —— 它的 debug.h 只有 `USART_Printf_Init`。
   * 生成 `#if (SDI_PRINT == SDI_PR_OPEN)` 在 L103 上是编译错误（宏未定义），
   * 所以这件事必须由器件包声明，不能在生成器里按系列名猜。
   * 缺省 true（早期接进来的三个系列都有）。
   */
  sdiPrintf?: boolean;
  /**
   * PLL 走 HSI 时需要先置 `EXTEN->EXTEN_CTR` 的 `PLL_HSI_PRE` 位，
   * 而且标准库**只有** `RCC_PLLSource_HSI_Div2` 一个常量（没有 `_HSI`）。
   *
   * L103 就是这种情况：RM 3.3.4 说 PLL 源由 `RCC_CFGR0` + `EXTEN_CTR` 共同决定，
   * 官方 `SetSysClockTo96_HSI()` 写的是 `EXTEN_CTR |= PLL_HSI_PRE` +
   * `RCC_PLLSRC_HSI_Div2` + `MULL12`，注释却是「PLLCLK = HSI × 12 = 96 MHz」——
   * 说明置位后 PLL 输入就是 HSI 原频，那个 `_Div2` 只是常量名。
   * 不置位直接写 `RCC_PLLSource_HSI` 在 L103 上是编译错误。
   */
  pllHsiPre?: boolean;
  /** GPIO 速度写法：mhz = `GPIO_Speed_10MHz`；level = `GPIO_Speed_High` */
  gpioSpeedStyle?: "mhz" | "level";
  /** ADC 采样时间写法：cycles5 / cycles / cyclesmode */
  adcSampleStyle?: "cycles5" | "cycles" | "cyclesmode";
  /** 有没有 FLASH_SetLatency（V407 没有） */
  flashLatency?: boolean;
  /** PLL 倍频的可选值（V407 只有 8..40 里的特定几档，没有 25） */
  pllMuls?: number[];
  /** APB1/PAB2 分频的可选值；apb1Divs 为空表示该系列没有 PCLK1 分频寄存器 */
  apb1Divs?: number[];
  apb2Divs?: number[];
  /** ADC 时钟分频的可选值（V407 没有 /12、/16） */
  adcDivs?: number[];
  /**
   * 外设实例名 → 时钟宏里的名字。
   * X035 的外设实例叫 `USB1`，但 SDK 的时钟宏是 `RCC_AHBPeriph_USBFS` ——
   * 按实例名硬拼会得到不存在的宏。
   */
  clockAliases?: Record<string, string>;
  /** ADC 时钟的配置入口：rcc = RCC_ADCCLKConfig；adc = ADC_CLKConfig */
  adcClock: "rcc" | "adc";
  /** 有没有 FLASH_PrefetchBufferCmd（X035 没有） */
  flashPrefetch: boolean;
  /** GPIO 支持的速度档（X035 只有 50MHz，V30x 有 2/10/50） */
  gpioSpeeds: string[];
  /** 支不支持开漏输出（X035 的 GPIO 没有 Out_OD / AF_OD） */
  gpioOpenDrain: boolean;
  /** NVIC 支持的优先级分组（X035 只有 0 / 1，V30x 有 0..4） */
  nvicGroups: number[];
  /** ADC 采样时间可选值（X035 是 4~11 个整数周期，V30x 是 1.5~239.5） */
  adcSampleTimes: string[];
  /** 有没有 RCC_ADCCLKConfig（与 adcClock 同源，保留可读性） */
  note?: string;
}

/** CH32 的调试接口能力（数据手册 1.4.2x「串行 2 线调试接口」）。 */
export interface DebugCaps {
  /** 2 线 SDI（SWDIO + SWCLK）—— L103/X035/X033 都支持，且复位后默认开启 */
  twoWire: boolean;
  /** 1 线 SWIO —— 这三个系列都没有，留字段是为了以后加别的系列 */
  singleWire: boolean;
  /** SDI 引脚（端口名），复位后默认被调试口占用 */
  swdio?: string;
  swclk?: string;
  /** 原厂说明，显示在调试接口页 */
  note?: string;
}

/* ────────────────────────────── DMA ────────────────────────────── */

/**
 * 一个 DMA 控制器。多数 WCH 芯片只有一颗 DMA1，但 CH32V407 等有
 * DMA1（13 通道）+ DMA2（11 通道）两颗，各自的通道号都从 1 起算，
 * 所以全局通道号要做一次重映射（见 engine/dma.ts 的 `dmaRef`）。
 */
export interface DmaController {
  /** 控制器名，如 DMA1 / DMA2，用于生成 `DMA1_Channel5` 与 `RCC_HBPeriph_DMA1` */
  id: string;
  /** 该控制器的通道数 */
  channels: number;
}

/**
 * DMA 请求 = 「谁要搬数据 + 搬哪个方向」。
 *
 * CH32 的 DMA 通道与硬件请求是**固定映射**的（RM「DMA 请求映射」一节），
 * 所以请求必须在建模层就把名字定下来，界面只是让用户挑通道。
 */
export interface DmaRequestMapping {
  /** 通道号 → 该通道能接的硬件请求（`USART1_TX` / `SPI1_RX` / `TIM1_CH1` …） */
  [channel: string]: string[];
}

/* ────────────────────────────── 时钟 ────────────────────────────── */
export interface ClockTopology {
  /** 内部高速时钟频率 MHz */
  hsi: number;
  /** 外部高速晶振可选频率 */
  hseOptions: number[];
  /** 内部低速 kHz */
  lsi: number;
  /** PLL 输入源 */
  pllSource: "HSI" | "HSE" | "HSI_DIV2";
  pllMin: number;
  pllMax: number;
  maxSysclk: number;
  /** APB1 分频可选值 */
  apb1Divs: number[];
  apb2Divs: number[];
  ahbDivs: number[];
  /** 是否支持 ADC 独立分频 */
  adcDivs?: number[];
  /** 时钟树节点说明 */
  notes?: string[];
}

export interface ClockConfig {
  sysclkSource: "HSI" | "HSE" | "PLL";
  hseFreq: number;
  pllMul: number;
  ahbDiv: number;
  apb1Div: number;
  apb2Div: number;
  adcDiv: number;
  lsiEnabled: boolean;
  hseBypass: boolean;
  /** 「目标工作频率」输入框里用户填的期望 SYSCLK（MHz），随工程保存 */
  targetMhz?: number;
}

/* ────────────────────────────── 中断 ────────────────────────────── */

export interface IrqDef {
  n: number;
  name: string;
  /** 归属外设实例 id */
  owner: string;
  desc?: string;
  /** 生成 NVIC 配置的门控参数：这些参数任一为 true 才生成 */
  gate?: string | string[];
}

/* ────────────────────────────── 器件 ────────────────────────────── */

/** USB 控制器支持的速率档 */
export type UsbSpeed = "fs" | "hs";
/** USB 控制器支持的角色。host + device 同时具备即双角色（OTG）。 */
export type UsbRole = "device" | "host";

export interface UsbCaps {
  /** 支持的速率；HS 控制器通常同时支持 FS */
  speeds?: UsbSpeed[];
  roles?: UsbRole[];
}

export interface DeviceDef {
  id: string;
  /** 系列名，如 CH32L103 / HC32F401B */
  family: string;
  /** 厂商，如 WCH / Holychip（芯圣）/ ST */
  vendor: string;
  /**
   * 代码生成后端 id（`wch-spl` / `generic` / 未来的 `hc32-ddl`）。
   * 器件包可以显式写，缺省按 vendor 推断。
   */
  backend: string;
  /**
   * 复用功能的**分组语义** —— 两家厂商在这一点的硬件行为完全不同：
   *
   *   grouped     （WCH CH32）：AFIO 重映射寄存器是**整组切换**的。
   *                同一外设的所有信号必须落在同一个重映射组里，
   *                例如 I2C1_SCL 用了组 1，I2C1_SDA 就不能用组 2 —— 硬件做不到。
   *                引脚规划必须强制组一致。
   *
   *   independent （HC32 / STM32 的 AFR）：每个引脚独立选 AF 编号，没有组寄存器。
   *                同一外设的 SCL 和 SDA 可以各用各的引脚，硬件允许自由组合。
   *                引脚规划**不能**加组约束，否则会把合法的组合判成冲突。
   *
   * 缺省按 vendor 推断（WCH → grouped，其它 → independent）。
   */
  afGrouping: AfGrouping;
  /**
   * 能否生成代码。false 时界面不提供「生成代码」，导出只出引脚映射表。
   * 资料不足的厂商（例如还没有完整 SDK 手册的系列）应设为 false ——
   * 编出来的初始化代码比没有更糟。
   */
  codegenEnabled: boolean;
  /** 禁止生成时的原因，显示在代码页与导出提示里 */
  codegenNote?: string;
  /** 内核，如 QingKe V2A (RV32EC) */
  core: string;
  package: PackageDef;
  flashKb: number;
  ramKb: number;
  /** 工作电压 */
  voltage: string;
  peripherals: PeripheralDef[];
  clock: ClockTopology;
  irqs: IrqDef[];
  /** 可用的外部中断线数量（PXn 只能接 EXTIn） */
  extiLines?: number;
  /** 通用 DMA 通道数（单控制器 = 该控制器通道数；多控制器 = 全部之和） */
  dmaChannels?: number;
  /**
   * DMA 控制器列表。多数芯片只有一颗 DMA1；CH32V407 有 DMA1（13 通道）+ DMA2（11 通道）。
   * 缺省按「单颗 DMA1、通道数 = `dmaChannels`」处理，兼容旧器件包。
   */
  dmaControllers?: DmaController[];
  /** DMA 通道 ↔ 硬件请求的固定映射（RM「DMA 请求映射」表）；缺省表示还没有核验过 */
  dmaMap?: DmaRequestMapping;
  /** 调试接口能力 */
  debug?: DebugCaps;
  /** USB 能力（速度档 / 角色），用于器件筛选 */
  usb?: UsbCaps;
  /** 标准外设库的 API 能力（系列之间的差异） */
  api?: ApiProfile;
  /** 个别外设的总线归属覆盖（默认按 WCH 惯例推导） */
  /**
   * 外设的总线归属覆盖。
   *
   * `"AHB"` 是给 L103 这类命名准备的：它的高速总线在 SDK 里叫 **HB**
   * （`RCC_HBPeriphClockCmd` / `RCC_HBPeriph_USBFS`），而 PB1/PB2 就是别家的 APB1/APB2。
   * USBFS / USBPD 都挂在 HB 上，按默认规则会被丢进 PB1，编译直接报宏不存在。
   */
  buses?: Record<string, 1 | 2 | "AHB">;
  /** MRS .template 里的 PeripheralVersion（EVT 自带值，X035 是 1.5） */
  peripheralVersion?: string;
  /**
   * SDK 头文件前缀（`ch32x035` → `ch32x035.h`）。
   * X033 与 X035 同 die，共用 `ch32x035.h`，所以不能按型号名推。
   */
  sdkHeader?: string;
  /** 数据来源标注 */
  source: string;
  /** 器件包版本 */
  packVersion: string;
  /** 尚未建模的封装说明 */
  pending?: string[];
}

/* ────────────────────────────── 工程 ────────────────────────────── */

export interface GpioCfg {
  mode: "input" | "output_pp" | "output_od" | "af_pp" | "af_od" | "analog";
  pull: "none" | "up" | "down";
  speed: "2" | "10" | "50";
  initial?: "low" | "high";
  label?: string;
}

export interface NvicCfg {
  enabled: boolean;
  preempt: number;
  sub: number;
}

/**
 * 一条 DMA 通道的分配。
 *
 * 一台外设**可以同时占多条**通道（SPI 收发各一条、USART 收发各一条），
 * 所以这里存数组而不是单个对象 —— 原来那份 `dma?: DmaCfg` 只能表达一条，
 * 和硬件对不上。
 */
export interface DmaChannelCfg {
  /** 硬件请求名，如 `SPI1_RX` / `USART1_TX` / `TIM1_CH1` */
  request: string;
  /** 通道号（1 起） */
  channel: number;
  dir: "p2m" | "m2p";
  mode: "normal" | "circular";
  priority: "low" | "medium" | "high" | "veryhigh";
  width: "8" | "16" | "32";
  incMem: boolean;
  /** 内存地址自增步长之外，还需要每轮搬多少字节；0 表示由运行时填 */
  bufferSize?: number;
  /** 传输完成中断 */
  irqTc?: boolean;
  /** 半传输中断 */
  irqHt?: boolean;
}

/** @deprecated 旧工程文件里的单通道写法；`project.ts` 会在读取时迁移成 `dmaChannels` */
export interface DmaCfg {
  channel: number;
  dir: "p2m" | "m2p";
  mode: "normal" | "circular";
  priority: "low" | "medium" | "high" | "veryhigh";
  width: "8" | "16" | "32";
  incMem: boolean;
}

export interface PeripheralConfig {
  enabled: boolean;
  mode?: string;
  params: Record<string, string | number | boolean>;
  /** 信号短名 -> 引脚名（PD5）。未分配为 null */
  pins: Record<string, string | null>;
  nvic?: NvicCfg;
  /** 多条 DMA 通道（每外设可收发各一条） */
  dmaChannels?: DmaChannelCfg[];
  /** @deprecated 见 DmaChannelCfg 的说明 */
  dma?: DmaCfg;
  /** 通道表（TIM 各通道 / ADC 各通道） */
  channels?: Record<string, ChannelCfg>;
  /** 锁定当前引脚映射：其他外设启用时不自动挪动本外设的引脚 */
  locked?: boolean;
}

export interface ChannelCfg {
  enabled: boolean;
  mode?: string;
  pin?: string | null;
  /**
   * 互补输出引脚（TIM 的 CHxN）。
   *
   * 它不是一个独立通道，而是同一个通道的另一根线，所以放在通道配置里而不是 `pins` 表 ——
   * 否则「CH1」在通道页、「CH1N」在引脚页，两边各管一半，改起来永远对不上。
   * 只有通道勾了「互补输出」时才会有值。
   */
  pinN?: string | null;
  params?: Record<string, string | number | boolean>;
}

export interface ProjectSettings {
  name: string;
  /** mrs = MounRiver Studio 工程（.project/.cproject/.template）；make = Makefile */
  toolchain: "mrs" | "make" | "none";
  sdk: "wch-sdk" | "bare";
  generateIt: boolean;
  generateStartup: boolean;
  includeComments: boolean;
  outputDir: string;
  author: string;
}

export interface Project {
  formatVersion: number;
  deviceId: string;
  clock: ClockConfig;
  configs: Record<string, PeripheralConfig>;
  gpio: Record<string, GpioCfg>;
  pinLabels: Record<string, string>;
  settings: ProjectSettings;
  /**
   * 复位引脚。新建 / 换器件时自动取封装上第一个可作 RESET 的引脚
   * （多个候选时取第一个 = 上电默认那颗）；NRST 专用脚的器件它就是硬件固定值。
   */
  resetPin?: string;
  /**
   * 用户在画布上手工锁定的引脚（右键 → 锁定）。
   * 锁定的引脚不能分配给任何外设、不能改 GPIO 模式，自动规划也会绕开。
   */
  lockedPins?: Record<string, true>;
  /** 保存时间戳，仅用于最近列表 */
  savedAt?: number;
}

/* ────────────────────────────── 派生视图 ────────────────────────────── */

export interface PinUsage {
  pin: string;
  fn: string;
  owner: string;
  signal: string;
  colorKey: string;
  /**
   * 这个信号落在这根脚上时，AFIO 需要配到哪个「重映射组」。
   * 0 / 缺省 = 默认复用，不需要动 AFIO；> 0 就必须先配 PCFR，否则外设还在默认脚上。
   */
  remap?: number;
}

export interface PinConflict {
  pin: string;
  a: PinUsage;
  b: PinUsage;
}

export interface ClockDerived {
  sysclk: number;
  hclk: number;
  pclk1: number;
  pclk2: number;
  adcclk: number;
  pllIn: number;
  pllOut: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  where: string;
  message: string;
  fix?: string;
}
