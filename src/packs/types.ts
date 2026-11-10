/**
 * 器件包（Pack）的 JSON 结构定义 —— L2 层，纯类型。
 *
 * **这一层的目标：任何厂商的 MCU 都能用同一份 JSON 描述，不改代码。**
 * 之前这些接口写在 `devices/wch.ts` 里，混着 WCH 的 META 表和外设命名正则，
 * 加第二家厂商（HC32）时就暴露出问题：外设 id 叫 `LPUART1`、`FDA0`、`VC1`，
 * 正则 `/^([A-Z][A-Z0-9]*?)(\d*)$/` 之外的命名全都落到 SYSTEM 兜底。
 *
 * 现在拆成两条：
 *   - `packages` / `ports` / `clock` / `irqs`  —— 硬件事实，厂商无关；
 *   - `meta` —— 「这个外设是什么、用哪套参数 schema」，**写在 pack 里**，
 *     缺了由加载器报错，而不是靠命名猜。
 */

import type {
  ApiProfile,
  ClockTopology,
  DebugCaps,
  DmaRequestMapping,
  DmaController,
  IrqDef,
  PackMeta,
  PackageShape,
  PinKind,
  UsbCaps,
} from "../model/types";

export interface PackSignal {
  /** 完整信号名，`<实例>_<短名>`，如 `USART1_TX` */
  fn: string;
  /**
   * 复用编号。语义由厂商决定，但对**同一厂商**是同一个含义：
   *   - WCH：AFIO 配置位数值（`USART3_TX[11]` → "3"）
   *   - HC32：AF 编号（`AF4:I2C1_SCL` → "4"）
   * 缺省表示「默认复用功能」，不需要动复用寄存器。
   */
  remap?: string;
}

export interface PackPin {
  num: number | "EP";
  name: string;
  kind: PinKind;
  note?: string;
  /** 内部短接合封的另一个端口，同样能用这个物理引脚的功能 */
  aliases?: string[];
}

export interface PackPackage {
  id: string;
  label: string;
  shape: PackageShape;
  pins: PackPin[];
  /**
   * 本封装**硬件上没有**的外设 id。
   *
   * 同系列同引脚数的封装可能阉割了某个控制器（L103 的 K8U7 没有 CAN1、
   * V467 的 RET6 没有 USBHS2），而引脚复用表是整包共享的 —— 引脚数据
   * 表达不了「 silicon 缺一块」，只能在这里显式排除：外设树不列、
   * 引脚菜单不出它的功能、新建工程筛不到。
   */
  drop?: string[];
  /**
   * 引脚号来源。缺省 `package`（数据手册的物理引脚号）。
   * 手册只给「本封装引出哪些端口」时写 `sequence` —— 引脚号是按端口顺序推的序号，
   * 界面会标注「序号，非封装引脚号」。
   */
  pinNumbering?: "package" | "sequence";
}

export interface PackPeripheral {
  id: string;
  signals: string[];
}

export interface PackFile {
  packVersion: string;
  series: string;
  vendor: string;
  core: string;
  source: string;
  flashKb: number;
  ramKb: number;
  voltage: string;
  maxSysclk: number;
  /** 可用的外部中断线数量；PXn 固定对应 EXTIn */
  extiLines?: number;
  dmaChannels?: number;
  /** USB 能力（速度档 / 角色），用于新建工程时按 USB 条件筛选 */
  usb?: UsbCaps;
  /** DMA 控制器列表（缺省按单颗 DMA1 处理；V407 有 DMA1+DMA2） */
  dmaControllers?: DmaController[];
  /** 通道 → 硬件请求的固定映射（RM「DMA 请求映射」） */
  dmaMap?: DmaRequestMapping;
  /** 调试接口能力 */
  debug?: DebugCaps;
  /** 标准外设库的 API 能力（WCH 专用；其它厂商留空） */
  api?: ApiProfile;
  /**
   * 外设的总线归属覆盖（缺省按 WCH 命名习惯推导）。
   *
   * 存在的理由：L103 的 USBFS / USBPD 挂在 **HB** 总线上，
   * 而默认规则只看名字（`USBPD` → PB1），生成出来是 `RCC_PB1Periph_USBPD` —— 宏不存在。
   */
  buses?: Record<string, 1 | 2 | "AHB">;
  /** MRS .template 的 PeripheralVersion（WCH MRS 专用） */
  peripheralVersion?: string;
  /** SDK 头文件前缀（`ch32l103` → `ch32l103.h`） */
  sdkHeader?: string;
  /**
   * 是否允许生成代码。缺省 `"enable"`。
   *
   * 有些厂商的资料只够做引脚规划（没有完整的寄存器/SDK 手册），此时生成初始化代码
   * 只能是编的。与其产出一段看着对、跑起来不对的代码，不如明确禁止：
   * 界面会隐藏「生成代码」入口，导出也会被拒绝，只保留引脚映射表。
   */
  codegen?: "enable" | "disable";
  /** 禁止生成时给用户看的原因（一句话，说清缺什么资料） */
  codegenNote?: string;
  /**
   * 复用分组语义：`grouped`（WCH 的 AFIO 整组切换）/ `independent`（HC32、STM32 的逐引脚 AF）。
   * 缺省按 vendor 推断：WCH → grouped，其它 → independent。
   */
  afGrouping?: "grouped" | "independent";
  /**
   * 生成器后端 id。缺省按厂商推断：
   *   WCH  → "wch-spl"；其它厂商 → "generic"（只出引脚表 + TODO）
   */
  backend?: string;
  /**
   * 外设元数据：id → { kind, group, schema, brief, required, label }。
   *
   * **非 WCH 器件包必须写全**（加载器会校验）。WCH 包可以省略，
   * 由 `devices/wch.ts` 里那张历史 META 表兜底。
   */
  meta?: Record<string, PackMeta>;
  clock: ClockTopology;
  packages: PackPackage[];
  ports: Record<string, PackSignal[]>;
  peripherals: PackPeripheral[];
  irqs: IrqDef[];
  pending?: string[];
}
