import type { ParamDef, ParamGroup, PeripheralSchema } from "../model/types";

/**
 * 外设参数模式库。
 *
 * 这里是「配置详细程度」的全部来源：每个外设的每一项都对应参考手册里的一个位域，
 * hint 写清楚它落在哪个寄存器的哪一位，formula 写清楚它怎么算出来。
 * 界面不需要知道任何具体外设——它只会照着这份模式渲染表单。
 */

const g = (key: string, label: string, open = false, advanced = false, hint?: string): ParamGroup => ({
  key,
  label,
  open,
  advanced,
  hint,
});

const sel = (
  key: string,
  label: string,
  def: string,
  options: {
    l: string;
    v: string;
    signals?: string[];
    required?: string[];
    disabledIf?: ParamDef["visibleIf"];
    /** 设备能力门槛（如 "usb.hs"）——由 pinmux.modeOptionSupported 消费 */
    cap?: string;
    hint?: string;
  }[],
  extra: Partial<ParamDef> = {},
): ParamDef => ({
  key,
  label,
  type: "select",
  default: def,
  options: options.map((o) => ({
    label: o.l,
    value: o.v,
    signals: o.signals,
    required: o.required,
    disabledIf: o.disabledIf,
    cap: o.cap,
    hint: o.hint,
  })),
  ...extra,
});

const num = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  extra: Partial<ParamDef> = {},
): ParamDef => ({ key, label, type: "number", default: def, min, max, ...extra });

const bool = (key: string, label: string, def = false, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  type: "boolean",
  default: def,
  ...extra,
});

const note = (key: string, label: string, text: string, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  type: "note",
  default: text,
  ...extra,
});

/* ══════════════════════════════ USART ══════════════════════════════ */

/**
 * USART 工作模式的完整清单。
 *
 * 现在只放开「异步 / 同步 / 单线半双工」三种：多机、IrDA、LIN、智能卡虽然
 * 寄存器位都能配，但它们的专属参数（断帧长度、IrDA 分频、卡时钟分频）在生成器里
 * 还没落地，放出来只会让人以为选了就能用。补齐之后把名字加进 USART_VISIBLE_MODES 即可。
 *
 * required 写的是「这个模式必须占几根线」—— 器件包给的 TX/RX 是异步的最小配置，
 * 同步和单线都由模式自己声明，否则选了单线还会被逼着分配 RX。
 */
const USART_MODE_OPTIONS: {
  l: string;
  v: string;
  signals?: string[];
  required?: string[];
  hint?: string;
}[] = [
  { l: "Disable", v: "disable" },
  {
    l: "Asynchronous 异步",
    v: "Asynchronous",
    signals: ["TX", "RX"],
    required: ["TX", "RX"],
    hint: "最常用：TX / RX 两线，波特率由 BRR 决定",
  },
  {
    l: "Synchronous 同步",
    v: "Synchronous",
    signals: ["TX", "RX", "CK"],
    required: ["TX", "RX", "CK"],
    hint: "同步模式：TX 发、RX 收、CK 输出波特率时钟（CTLR2.CLKEN=1）；只开一个方向时另一条不占引脚",
  },
  {
    l: "Single Wire 单线半双工",
    v: "SingleWire",
    signals: ["TX"],
    required: ["TX"],
    hint: "只占 TX 一根线，收发共用（CTLR3.HDSEL=1）",
  },
  // —— 以下模式暂时收起：生成器还没落地它们的专属参数 ——
  { l: "Multiprocessor 多机通信", v: "Multiprocessor", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "地址唤醒，需配合 WAKE 与 ADDR 位" },
  { l: "IrDA 红外", v: "IrDA", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "需要 IREN=1 与 IrDA_LP 分频" },
  { l: "LIN 总线", v: "LIN", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "需 LBDL 设定断帧长度" },
  { l: "SmartCard 智能卡", v: "SmartCard", signals: ["TX"], required: ["TX"], hint: "单线；强制 9 位字长 + 偶校验 + 0.5 停止位" },
  { l: "SmartCard + Card Clock", v: "SmartCardWithClock", signals: ["TX", "CK"], required: ["TX", "CK"], hint: "额外输出 3/5 分频卡时钟" },
];

/** 当前放开的模式（Disable 永远在） */
const USART_VISIBLE_MODES = new Set(["Asynchronous", "Synchronous", "SingleWire"]);

const usart: PeripheralSchema = {
  modeKey: "mode",
  about:
    "USART 支持异步 / 同步 / 单线半双工三种工作模式（多机 / IrDA / LIN / 智能卡暂未放开）。" +
    "切换模式会改变需要占用的信号线 —— 异步是 TX+RX，同步是 TX+CK，单线只有 TX，引脚会自动跟着增减。",
  /**
   * 分组顺序照 PY32Studio 的串口页：Basic Parameters → Advanced Parameters → Clock Parameters。
   * 时钟那组的所有字段都带 `visibleIf: mode == Synchronous`，切到异步时整组会自动消失
   * （ParamsTab 里 `items.length === 0` 就不渲染该组），不需要额外的显隐逻辑。
   */
  groups: [
    g("mode", "工作模式", true),
    g("basic", "基本参数", true),
    g("adv", "高级参数", false, true),
    g("clock", "时钟参数（同步模式）", false, true),
    g("irq", "中断与 DMA"),
  ],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      USART_MODE_OPTIONS.filter((o) => o.v === "disable" || USART_VISIBLE_MODES.has(o.v)),
      { group: "mode", hint: "USART_CTLR1 的 TE/RE/PS 与 CTLR3 的 HDSEL / CTLR2 的 CLKEN 组合" },
    ),
    sel(
      "rs232",
      "硬件流控 (RS232)",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "仅 RTS", v: "RTS", signals: ["RTS"] },
        { l: "仅 CTS", v: "CTS", signals: ["CTS"] },
        { l: "RTS / CTS", v: "RTS_CTS", signals: ["RTS", "CTS"] },
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
        enabledIf: { k: "rs485", op: "=", v: false },
        hint: "CTLR3.RTSE / CTLR3.CTSE",
      },
    ),
    bool("rs485", "RS485 硬件流控 (DE)", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
      enabledIf: { k: "rs232", op: "=", v: "disable" },
      hint: "CTLR3.DEM=1，DE 引脚在发送时自动拉高",
    }),

    num("baud", "波特率", 115200, 245, 6000000, {
      group: "basic",
      unit: "bit/s",
      formula: "USARTDIV = fPCLK / (16 或 8 × 波特率)",
      hint: "自动计算 BRR 整数与小数部分，下方会实时显示实际波特率与误差",
    }),
    sel(
      "wordLength",
      "字长",
      "8",
      [
        { l: "8 位", v: "8", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } },
        { l: "9 位", v: "9" },
      ],
      { group: "basic", hint: "CTLR1.WL" },
    ),
    sel(
      "stopBits",
      "停止位",
      "1",
      [
        { l: "0.5 位", v: "0_5" },
        { l: "1 位", v: "1", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } },
        { l: "1.5 位", v: "1_5" },
        { l: "2 位", v: "2", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } },
      ],
      { group: "basic", hint: "CTLR2.STOP" },
    ),
    sel(
      "parity",
      "校验",
      "None",
      [
        { l: "无校验", v: "None" },
        { l: "偶校验", v: "Even" },
        { l: "奇校验", v: "Odd" },
      ],
      { group: "basic", hint: "CTLR1.PCE / PS" },
    ),
    /**
     * 数据方向。
     *
     * PY32Studio 把它放在 Advanced Parameters，用下拉三选一（不是两个勾选框）：
     * Receive and Transmit / Transmit only / Receive only。这里照抄这套语义与顺序，
     * 默认项放最前 —— 与「收发」是绝大多数场景一致。
     *
     * affectsPins 让改方向时立刻重排引脚：仅发送不再占 RX、仅接收不再占 TX。
     */
    sel(
      "dataDirection",
      "数据方向",
      "TX_RX",
      [
        { l: "Receive and Transmit 收发", v: "TX_RX" },
        { l: "Transmit only 仅发送", v: "TX" },
        { l: "Receive only 仅接收", v: "RX" },
      ],
      {
        group: "adv",
        affectsPins: true,
        hint: "CTLR1.TE / RE；异步与同步都能只开一个方向 —— 仅发送时不占 RX，仅接收时不占 TX",
      },
    ),

    /**
     * 同步模式的三组时钟参数，对应 PY32Studio 的 Clock Parameters 分组。
     *
     * 三项都只在 Synchronous 下出现，切到异步后整组消失 —— 和 PY32 的行为一致，
     * 也不需要额外的显隐开关：ParamsTab 里分组没有可见字段就不渲染。
     * 生成代码用的是 USART_ClockInit()，以前这三项写死在 codegen 里，现在从这里取。
     */
    sel(
      "cpol",
      "时钟极性 (CPOL)",
      "Low",
      [
        { l: "Low 空闲低电平", v: "Low" },
        { l: "High 空闲高电平", v: "High" },
      ],
      { group: "clock", visibleIf: { k: "mode", op: "=", v: "Synchronous" }, hint: "CTLR2.CPOL" },
    ),
    sel(
      "cpha",
      "时钟相位 (CPHA)",
      "1Edge",
      [
        { l: "1 Edge 第一个边沿采样", v: "1Edge" },
        { l: "2 Edge 第二个边沿采样", v: "2Edge" },
      ],
      { group: "clock", visibleIf: { k: "mode", op: "=", v: "Synchronous" }, hint: "CTLR2.CPHA" },
    ),
    sel(
      "lastBit",
      "最后一位时钟 (Last Bit)",
      "Disable",
      [
        { l: "Disable 不输出最后一位时钟", v: "Disable" },
        { l: "Enable 输出最后一位时钟", v: "Enable" },
      ],
      {
        group: "clock",
        visibleIf: { k: "mode", op: "=", v: "Synchronous" },
        hint: "CTLR2.LBCL；智能卡类时序需要它在最后一个数据位补一个时钟",
      },
    ),

    sel(
      "oversampling",
      "过采样",
      "16",
      [
        { l: "8 倍采样", v: "8" },
        { l: "16 倍采样", v: "16" },
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "in", v: ["Asynchronous", "Multiprocessor"] },
        hint: "CTLR1.OVER8；8 倍采样时波特率上限更高，但抗噪更差",
      },
    ),
    bool("autoBaud", "自动波特率检测 (ABR)", false, { group: "adv", hint: "CTLR2.ABREN，硬件从 0x55 帧测速" }),
    sel(
      "wakeup",
      "唤醒方式",
      "Idle",
      [
        { l: "空闲总线唤醒", v: "Idle" },
        { l: "地址标记唤醒", v: "Address" },
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "=", v: "Multiprocessor" },
        hint: "CTLR1.WAKE",
      },
    ),
    num("addr", "本机地址", 0, 0, 15, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Multiprocessor" },
      hint: "CTLR2.ADDR，4 位地址",
    }),
    sel(
      "linBreakLen",
      "LIN 断帧长度",
      "10",
      [
        { l: "10 位", v: "10" },
        { l: "11 位", v: "11" },
      ],
      { group: "adv", visibleIf: { k: "mode", op: "=", v: "LIN" }, hint: "CTLR2.LBDL" },
    ),
    num("irdaPrescaler", "IrDA 低功耗分频", 1, 1, 64, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "IrDA" },
      hint: "CTLR3.IRLP，分频后脉宽 3 个系统时钟",
    }),
    sel(
      "scClockDiv",
      "智能卡时钟分频",
      "5",
      [
        { l: "CK = fCK/5", v: "5" },
        { l: "CK = fCK/3", v: "3" },
      ],
      { group: "adv", visibleIf: { k: "mode", op: "=", v: "SmartCardWithClock" }, hint: "CTLR3.SCEN" },
    ),
    bool("rxTimeout", "接收超时", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
      hint: "RTOR 寄存器，超时后置位 RTOF",
    }),
    num("rxTimeoutVal", "超时值", 0, 0, 0xffffff, {
      group: "adv",
      visibleIf: { k: "rxTimeout", op: "=", v: true },
      hint: "RTOR.RTO，单位为位时间",
    }),
    bool("swap", "TX/RX 引脚互换", false, { group: "adv", hint: "CTLR2.SWAP，方便单层板布线" }),
    bool("invert", "TX/RX 极性反转", false, { group: "adv", hint: "CTLR2.RXINV / TXINV" }),

    bool("irqRxne", "接收非空 (RXNE)", true, { group: "irq", hint: "每收到一个字节进一次中断" }),
    bool("irqIdle", "总线空闲 (IDLE)", false, { group: "irq", hint: "常用于 DMA + 不定长接收" }),
    bool("irqTxe", "发送空中断 (TXE)", false, { group: "irq" }),
    bool("irqTc", "发送完成 (TC)", false, { group: "irq" }),
    bool("irqPe", "校验 / 帧错误", false, { group: "irq" }),
  ],
};

/* ══════════════════════════════ SPI ══════════════════════════════ */

const spi: PeripheralSchema = {
  modeKey: "mode",
  about:
    "SPI 支持全双工主机 / 从机、单线半双工、只收模式。CPOL/CPHA 组合决定 4 种 SPI 时序模式，NSS 可选软件或硬件管理。",
  groups: [g("mode", "模式", true), g("param", "参数", true), g("adv", "高级参数", false, true), g("irq", "中断与 DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "Full-Duplex Master 全双工主机", v: "master", signals: ["SCK", "MOSI", "MISO"] },
        { l: "Full-Duplex Slave 全双工从机", v: "slave", signals: ["SCK", "MOSI", "MISO"] },
        { l: "Half-Duplex Master 半双工主机", v: "half_master", signals: ["SCK", "MOSI"] },
        { l: "Half-Duplex Slave 半双工从机", v: "half_slave", signals: ["SCK", "MOSI"] },
        { l: "Receive Only Master 只收主机", v: "rx_master", signals: ["SCK", "MISO"] },
        { l: "Receive Only Slave 只收从机", v: "rx_slave", signals: ["SCK", "MISO"] },
      ],
      { group: "mode", hint: "CTLR1.MSTR / BIDIMODE / BIDIOE / RXONLY" },
    ),
    sel(
      "nss",
      "NSS 管理",
      "software",
      [
        { l: "软件 NSS（SSM=1）", v: "software" },
        { l: "硬件 NSS 输入（从机片选）", v: "hardware_in", signals: ["NSS"] },
        { l: "硬件 NSS 输出（主机多片选）", v: "hardware_out", signals: ["NSS"] },
      ],
      { group: "mode", hint: "CTLR1.SSM / SSOE" },
    ),
    num("prescaler", "时钟预分频", 8, 2, 256, {
      group: "param",
      step: 2,
      formula: "fSCK = fPCLK / 预分频",
      hint: "CTLR1.BR，仅支持 2 的幂次：2/4/8/16/32/64/128/256",
    }),
    sel(
      "cpol",
      "CPOL 时钟极性",
      "0",
      [
        { l: "Low  空闲低电平", v: "0" },
        { l: "High 空闲高电平", v: "1" },
      ],
      { group: "param", hint: "CTLR1.CPOL" },
    ),
    sel(
      "cpha",
      "CPHA 时钟相位",
      "0",
      [
        { l: "1 Edge 第一个边沿采样", v: "0" },
        { l: "2 Edge 第二个边沿采样", v: "1" },
      ],
      { group: "param", hint: "CTLR1.CPHA" },
    ),
    sel(
      "dataSize",
      "数据帧长度",
      "8",
      [
        { l: "8 位", v: "8" },
        { l: "16 位", v: "16" },
      ],
      { group: "param", hint: "CTLR1.DFF" },
    ),
    sel(
      "firstBit",
      "位序",
      "MSB",
      [
        { l: "MSB 先行", v: "MSB" },
        { l: "LSB 先行", v: "LSB" },
      ],
      { group: "param", hint: "CTLR1.LSBFIRST" },
    ),
    sel(
      "crcLength",
      "CRC 长度",
      "8",
      [
        { l: "8 位", v: "8" },
        { l: "16 位", v: "16" },
      ],
      { group: "adv", hint: "CTLR1.CRCL" },
    ),
    bool("crcEnabled", "硬件 CRC 计算", false, { group: "adv", hint: "CTLR1.CRCEN，多机通信时可校验整帧" }),
    num("crcPoly", "CRC 多项式", 7, 0, 65535, { group: "adv", visibleIf: { k: "crcEnabled", op: "=", v: true } }),
    sel(
      "tiMode",
      "TI 帧格式",
      "motorola",
      [
        { l: "Motorola", v: "motorola" },
        { l: "TI（SS 脉冲同步）", v: "ti" },
      ],
      { group: "adv", hint: "CTLR2.FRF" },
    ),
    bool("irqTxe", "发送缓冲空 (TXE)", false, { group: "irq" }),
    bool("irqRxne", "接收非空 (RXNE)", true, { group: "irq" }),
    bool("irqErr", "错误中断 (ERR)", false, { group: "irq", hint: "模式错误 / 溢出 / CRC 错误" }),
  ],
};

/* ══════════════════════════════ I2C ══════════════════════════════ */

/**
 * 「需要本机地址」的条件：I2C 从机，或 SMBus 设备角色。
 * 主机不响应地址，所以这些字段对主机没有意义。
 */
const I2C_AS_TARGET: ParamDef["visibleIf"] = {
  or: [
    { k: "mode", op: "=", v: "slave" },
    { and: [{ k: "mode", op: "=", v: "smbus" }, { k: "smbusRole", op: "=", v: "device" }] },
  ],
};

const i2c: PeripheralSchema = {
  modeKey: "mode",
  about:
    "I2C 支持标准 / 快速模式、7 位与 10 位寻址、双地址，以及 SMBus 协议。" +
    "只有选 SMBus 模式时才会出现 SMBA 告警引脚 —— 普通 I2C 主/从机没有这条线。",
  groups: [g("mode", "模式", true), g("param", "参数", true), g("adv", "高级参数", false, true), g("irq", "中断与 DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "I2C 主机", v: "master", signals: ["SCL", "SDA"], hint: "CTLR1.SMBUS=0，标准 I2C 主机" },
        { l: "I2C 从机", v: "slave", signals: ["SCL", "SDA"], hint: "CTLR1.SMBUS=0，标准 I2C 从机" },
        {
          l: "SMBus 主机 / 设备",
          v: "smbus",
          signals: ["SCL", "SDA", "SMBA"],
          required: ["SCL", "SDA"],
          hint: "CTLR1.SMBUS=1；额外引出 SMBA 告警线（可选分配，X035 系列没有这根脚），支持超时与 PEC",
        },
      ],
      { group: "mode", hint: "CTLR1.SMBUS / SMBTYPE" },
    ),
    sel(
      "smbusRole",
      "SMBus 角色",
      "device",
      [
        { l: "设备（从）", v: "device", hint: "CTLR1.SMBTYPE=0" },
        { l: "主机", v: "host", hint: "CTLR1.SMBTYPE=1，可发起 SMBus 主机传输" },
      ],
      { group: "param", visibleIf: { k: "mode", op: "=", v: "smbus" }, hint: "CTLR1.SMBTYPE" },
    ),
    sel(
      "speedMode",
      "速率模式",
      "fast",
      [
        { l: "标准模式 100 kHz", v: "standard" },
        { l: "快速模式 400 kHz", v: "fast" },
      ],
      { group: "param", hint: "CKCFGR.FS" },
    ),
    num("speed", "目标速率", 400, 10, 1000, {
      group: "param",
      unit: "kHz",
      formula: "CCR = fPCLK1 / (2 × 速率)，TRISE = 快速模式 fPCLK1×300ns + 1",
      hint: "标准模式上限 100 kHz，快速模式上限 400 kHz；填超会自动限幅并给出告警",
    }),
    sel(
      "addrBits",
      "寻址位数",
      "7",
      [
        { l: "7 位", v: "7" },
        { l: "10 位", v: "10" },
      ],
      { group: "param", visibleIf: I2C_AS_TARGET, hint: "OADDR1.ADDMODE" },
    ),
    num("ownAddr1", "本机地址 1", 0x30, 0, 0x3ff, {
      group: "param",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR1，7 位地址写 0x30 即 0b0110000",
    }),
    bool("dualAddr", "启用第二地址", false, {
      group: "param",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR2.ENDUAL",
    }),
    num("ownAddr2", "本机地址 2", 0x31, 0, 0x3ff, {
      group: "param",
      visibleIf: { k: "dualAddr", op: "=", v: true },
    }),
    bool("generalCall", "响应广播地址 0x00", false, {
      group: "adv",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR1.ENGC",
    }),
    bool("noStretch", "禁止时钟延展", false, {
      group: "adv",
      visibleIf: I2C_AS_TARGET,
      hint: "CTLR1.NOSTRETCH，置 1 后从机忙时不再拉低 SCL",
    }),
    bool("ackEnable", "自动应答 ACK", true, { group: "adv", hint: "CTLR1.ACK" }),
    num("digitalFilter", "数字噪声滤波", 0, 0, 15, {
      group: "adv",
      hint: "FLTR.DNF，可滤除小于 DNF+1 个 PCLK 的尖峰",
    }),
    bool("analogFilter", "模拟噪声滤波", true, { group: "adv", hint: "FLTR.ANOFF" }),
    bool("smbusAlert", "SMBA 用作告警输出", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "smbus" },
      hint: "CTLR1.SMBAL；分到 SMBA 脚之后，主机收到告警会把该脚拉低",
    }),
    bool("smbusPec", "SMBus PEC 校验", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "smbus" },
      hint: "CTLR1.ENPEC，按 SMBus 规范追加包错误码",
    }),
    bool("irqEvt", "事件中断 (EVT)", false, { group: "irq", hint: "SB / ADDR / BTF / STOPF" }),
    bool("irqErr", "错误中断 (ERR)", false, { group: "irq", hint: "BERR / ARLO / AF / OVR" }),
  ],
};

/* ══════════════════════════════ TIM ══════════════════════════════ */

const tim: PeripheralSchema = {
  modeKey: "clockSource",
  about:
    "定时器配置分三层：时基（PSC/ARR/计数模式）→ 通道（PWM / 输出比较 / 输入捕获）→ 高级功能（死区、刹车、主从触发）。右侧实时显示计数频率与周期。",
  groups: [g("base", "时基单元", true), g("adv", "高级控制", false, true), g("irq", "中断与 DMA")],
  panels: ["pins", "channelTable", "nvic", "dma"],
  params: [
    sel(
      "clockSource",
      "时钟源",
      "internal",
      [
        { l: "内部时钟 (CK_INT)", v: "internal" },
        { l: "外部时钟模式 1 (TI1/TI2)", v: "ext1" },
        { l: "外部时钟模式 2 (ETR)", v: "ext2" },
        { l: "编码器模式 (TI1+TI2)", v: "encoder", signals: ["CH1", "CH2"] },
      ],
      { group: "base", hint: "SMCFGR.ECE / SMS" },
    ),
    num("psc", "预分频 PSC", 0, 0, 65535, {
      group: "base",
      formula: "fCNT = fCK_INT / (PSC + 1)",
      hint: "PSC 寄存器，实际分频为 PSC+1",
    }),
    num("arr", "自动重装 ARR", 999, 0, 65535, {
      group: "base",
      formula: "T = (ARR + 1) / fCNT",
      hint: "ATRLR 寄存器；中心对齐模式下周期为 2×ARR",
    }),
    sel(
      "counterMode",
      "计数模式",
      "up",
      [
        { l: "向上计数", v: "up" },
        { l: "向下计数", v: "down" },
        { l: "中心对齐 1", v: "center1" },
        { l: "中心对齐 2", v: "center2" },
        { l: "中心对齐 3", v: "center3" },
      ],
      { group: "base", hint: "CTLR1.CMS / DIR" },
    ),
    sel(
      "ckd",
      "时钟分频",
      "1",
      [
        { l: "tDTS = tCK_INT", v: "1" },
        { l: "tDTS = 2 tCK_INT", v: "2" },
        { l: "tDTS = 4 tCK_INT", v: "4" },
      ],
      { group: "base", hint: "CTLR1.CKD，影响输入滤波与死区精度" },
    ),
    num("repetition", "重复计数器 RCR", 0, 0, 255, {
      group: "adv",
      hint: "仅高级定时器有效；RCR=0 时每次溢出都产生更新事件",
    }),
    bool("arpe", "自动重装预装载 (ARPE)", true, { group: "base", hint: "CTLR1.ARPE，PWM 必须开启才能无毛刺改占空比" }),
    bool("onePulse", "单脉冲模式", false, { group: "adv", hint: "CTLR1.OPM" }),
    bool("updateDisable", "禁用更新事件", false, { group: "adv", hint: "CTLR1.UDIS" }),
    bool("updateRequest", "软件产生更新事件", false, { group: "adv", hint: "SWEVGR.UG" }),

    sel(
      "slaveMode",
      "从模式",
      "disable",
      [
        { l: "不使用", v: "disable" },
        { l: "复位模式", v: "reset" },
        { l: "门控模式", v: "gated" },
        { l: "触发模式", v: "trigger" },
      ],
      { group: "adv", hint: "SMCFGR.SMS" },
    ),
    sel(
      "triggerSource",
      "触发源",
      "ITR0",
      [
        { l: "ITR0", v: "ITR0" },
        { l: "ITR1", v: "ITR1" },
        { l: "ITR2", v: "ITR2" },
        { l: "ITR3", v: "ITR3" },
        { l: "TI1F_ED", v: "TI1F_ED" },
        { l: "TI1FP1", v: "TI1FP1" },
        { l: "TI2FP2", v: "TI2FP2" },
        { l: "ETRF", v: "ETRF" },
      ],
      { group: "adv", visibleIf: { k: "slaveMode", op: "!=", v: "disable" }, hint: "SMCFGR.TS" },
    ),
    bool("breakEnable", "刹车功能 (BRK)", false, { group: "adv", hint: "BDTR.BKE，用于电机驱动过流保护" }),
    sel(
      "breakPolarity",
      "刹车极性",
      "low",
      [
        { l: "低电平有效", v: "low" },
        { l: "高电平有效", v: "high" },
      ],
      { group: "adv", visibleIf: { k: "breakEnable", op: "=", v: true }, hint: "BDTR.BKP" },
    ),
    bool("automaticOutput", "刹车后自动恢复输出 (AOE)", false, {
      group: "adv",
      visibleIf: { k: "breakEnable", op: "=", v: true },
      hint: "BDTR.AOE",
    }),
    num("deadTime", "死区时间", 0, 0, 1000, {
      group: "adv",
      unit: "ns",
      formula: "DTG 编码：0~127×tDTS / 64~127×2tDTS / ...",
      hint: "BDTR.DTG，互补 PWM 必须设置，防止上下管直通",
    }),

    bool("irqUpdate", "更新中断 (UIE)", false, { group: "irq" }),
    bool("irqCC1", "捕获比较 1 (CC1IE)", false, { group: "irq" }),
    bool("irqCC2", "捕获比较 2 (CC2IE)", false, { group: "irq" }),
    bool("irqCC3", "捕获比较 3 (CC3IE)", false, { group: "irq" }),
    bool("irqCC4", "捕获比较 4 (CC4IE)", false, { group: "irq" }),
    bool("irqBreak", "刹车中断 (BIE)", false, { group: "irq", visibleIf: { k: "breakEnable", op: "=", v: true } }),
  ],
  channelSpec: {
    label: "通道配置",
    count: 4,
    prefix: "CH",
    needsPin: true,
    hint: "每个通道可独立设为输出比较、PWM 输出或输入捕获；互补输出会自动占用 CHxN 引脚。",
    modes: [
      { label: "关闭", value: "disable" },
      { label: "PWM 输出", value: "pwm", signals: ["PWM"] },
      { label: "输出比较", value: "oc" },
      { label: "输入捕获", value: "ic" },
      { label: "强制输出", value: "forced" },
    ],
    params: [
      sel(
        "pwmMode",
        "PWM 模式",
        "1",
        [
          { l: "PWM 模式 1（计数值 < CCR 时有效）", v: "1" },
          { l: "PWM 模式 2（计数值 < CCR 时无效）", v: "2" },
        ],
        { visibleIf: { k: "@mode", op: "=", v: "pwm" }, hint: "CCMRx.OCxM = 110 / 111" },
      ),
      num("pulse", "比较值 CCR", 500, 0, 65535, {
        visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc"] },
        formula: "占空比 = CCR / (ARR + 1)",
        hint: "CHxCV 寄存器",
      }),
      sel(
        "polarity",
        "输出极性",
        "high",
        [
          { l: "高电平有效", v: "high" },
          { l: "低电平有效", v: "low" },
        ],
        { visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc", "forced"] }, hint: "CCER.CCxP" },
      ),
      sel(
        "idleState",
        "空闲电平",
        "reset",
        [
          { l: "复位（低）", v: "reset" },
          { l: "置位（高）", v: "set" },
        ],
        { visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc"] }, hint: "CR2.OISx" },
      ),
      bool("complementary", "互补输出 (CHxN)", false, {
        visibleIf: { k: "@mode", op: "=", v: "pwm" },
        hint: "CCER.CCxNE，需要高级定时器",
      }),
      sel(
        "icPrescaler",
        "捕获预分频",
        "1",
        [
          { l: "每 1 个事件", v: "1" },
          { l: "每 2 个事件", v: "2" },
          { l: "每 4 个事件", v: "4" },
          { l: "每 8 个事件", v: "8" },
        ],
        { visibleIf: { k: "@mode", op: "=", v: "ic" }, hint: "CCMRx.ICxPSC" },
      ),
      num("icFilter", "输入滤波", 0, 0, 15, {
        visibleIf: { k: "@mode", op: "=", v: "ic" },
        hint: "CCMRx.ICxF，以 fDTS 采样，数值越大抗噪越强",
      }),
      sel(
        "icPolarity",
        "捕获边沿",
        "rising",
        [
          { l: "上升沿", v: "rising" },
          { l: "下降沿", v: "falling" },
          { l: "双边沿", v: "both" },
        ],
        { visibleIf: { k: "@mode", op: "=", v: "ic" }, hint: "CCER.CCxP / CCxNP" },
      ),
    ],
  },
};

/* ══════════════════════════════ ADC ══════════════════════════════ */

const adc: PeripheralSchema = {
  about:
    "ADC 支持规则组与注入组、扫描、连续转换、外部触发与模拟看门狗。采样时间按通道独立设置，采样周期越长源阻抗容忍度越高。",
  groups: [g("base", "基本配置", true), g("adv", "高级配置", false, true), g("irq", "中断与 DMA")],
  panels: ["adcTable", "nvic", "dma"],
  params: [
    num("clockDiv", "ADC 时钟分频", 6, 2, 8, {
      group: "base",
      formula: "fADC = fPCLK2 / 分频",
      hint: "ADCCLK 不得超过 14 MHz，否则转换精度下降",
    }),
    sel(
      "dataAlign",
      "数据对齐",
      "right",
      [
        { l: "右对齐", v: "right" },
        { l: "左对齐", v: "left" },
      ],
      { group: "base", hint: "CTLR2.ALIGN" },
    ),
    sel(
      "scanMode",
      "扫描模式",
      "disable",
      [
        { l: "关闭（单通道）", v: "disable" },
        { l: "开启（多通道序列）", v: "enable" },
      ],
      { group: "base", hint: "CTLR1.SCAN" },
    ),
    sel(
      "continuous",
      "连续转换",
      "disable",
      [
        { l: "单次", v: "disable" },
        { l: "连续", v: "enable" },
      ],
      { group: "base", hint: "CTLR2.CONT" },
    ),
    sel(
      "externalTrig",
      "外部触发源",
      "none",
      [
        { l: "软件触发", v: "none" },
        { l: "TIM1_CC1", v: "TIM1_CC1" },
        { l: "TIM1_CC2", v: "TIM1_CC2" },
        { l: "TIM1_CC3", v: "TIM1_CC3" },
        { l: "TIM2_CC2", v: "TIM2_CC2" },
        { l: "TIM3_TRGO", v: "TIM3_TRGO" },
        { l: "EXTI_11", v: "EXTI_11" },
      ],
      { group: "base", hint: "CTLR2.EXTSEL / EXTTRIG" },
    ),
    sel(
      "sampleTime",
      "全局采样时间",
      "55.5",
      [
        { l: "1.5 周期", v: "1.5" },
        { l: "7.5 周期", v: "7.5" },
        { l: "13.5 周期", v: "13.5" },
        { l: "28.5 周期", v: "28.5" },
        { l: "41.5 周期", v: "41.5" },
        { l: "55.5 周期", v: "55.5" },
        { l: "71.5 周期", v: "71.5" },
        { l: "239.5 周期", v: "239.5" },
      ],
      { group: "base", hint: "SAMPTR1/2 的 SMPx 位，可在通道表里单独覆盖" },
    ),
    bool("watchdog", "模拟看门狗", false, { group: "adv", hint: "CTLR1.AWDEN" }),
    num("wdHigh", "看门狗上限", 4095, 0, 4095, { group: "adv", visibleIf: { k: "watchdog", op: "=", v: true } }),
    num("wdLow", "看门狗下限", 0, 0, 4095, { group: "adv", visibleIf: { k: "watchdog", op: "=", v: true } }),
    bool("injected", "启用注入组", false, { group: "adv", hint: "可打断规则组转换，用于电流环采样" }),
    bool("tempSensor", "内部温度传感器", false, { group: "adv", hint: "占用 ADC_IN16" }),
    bool("vrefint", "内部基准 VREFINT", false, { group: "adv", hint: "占用 ADC_IN17，可反推 VDDA" }),
    bool("dmaCircular", "DMA 循环模式", true, { group: "irq", hint: "多通道扫描时几乎必开" }),
    bool("irqEoc", "转换完成 (EOC)", false, { group: "irq" }),
    bool("irqAwd", "看门狗越界 (AWD)", false, { group: "irq" }),
  ],
  channelSpec: {
    label: "通道",
    count: 8,
    prefix: "IN",
    needsPin: true,
    hint:
      "ADC 的「通道」就是「引脚」—— 一个 INx 对应一根物理引脚，所以这里不再单设引脚页。" +
      "勾选通道后在同一张卡片里挑引脚；勾选的先后顺序就是规则组的转换序列（rank），每个通道可单独覆盖采样时间。",
    modes: [
      { label: "关闭", value: "disable" },
      { label: "规则组", value: "regular" },
      { label: "注入组", value: "injected" },
    ],
    params: [
      sel(
        "sampleTime",
        "采样时间",
        "55.5",
        [
          { l: "1.5 周期", v: "1.5" },
          { l: "7.5 周期", v: "7.5" },
          { l: "13.5 周期", v: "13.5" },
          { l: "28.5 周期", v: "28.5" },
          { l: "55.5 周期", v: "55.5" },
          { l: "71.5 周期", v: "71.5" },
          { l: "239.5 周期", v: "239.5" },
        ],
        { hint: "SAMPTR.SMP，覆盖全局设置" },
      ),
    ],
  },
};

/* ══════════════════════════════ 简单外设 ══════════════════════════════ */

const iwdg: PeripheralSchema = {
  about: "独立看门狗由内部 LSI（约 40 kHz）驱动，一旦启动无法关闭，只能复位芯片。",
  groups: [g("base", "参数", true)],
  panels: [],
  params: [
    num("prescaler", "预分频", 64, 4, 256, { group: "base", hint: "IWDG_PSCR，取值 4/8/16/32/64/128/256" }),
    num("reload", "重装值", 4095, 0, 4095, { group: "base", formula: "T = 预分频 × (重装值+1) / 40000" }),
  ],
};

const wwdg: PeripheralSchema = {
  about: "窗口看门狗由 APB1 时钟驱动，必须在窗口内喂狗，喂早了同样复位。",
  groups: [g("base", "参数", true)],
  panels: ["nvic"],
  params: [
    num("prescaler", "预分频", 8, 1, 8, { group: "base", hint: "CFR.WDGTB，2 的幂次 1~8" }),
    num("window", "窗口值 W", 80, 0, 127, { group: "base", hint: "CFR.W，必须大于 0x40" }),
    num("counter", "计数器初值", 127, 0, 127, { group: "base", hint: "CR.T，递减计数" }),
  ],
};

const rtc: PeripheralSchema = {
  about: "RTC 可由 LSI 或 LSE 驱动，提供日历、闹钟与周期唤醒。",
  groups: [g("base", "参数", true)],
  panels: ["nvic"],
  params: [
    sel(
      "clockSource",
      "时钟源",
      "lsi",
      [
        { l: "LSI 内部低速", v: "lsi" },
        { l: "LSE 外部 32.768 kHz", v: "lse" },
      ],
      { group: "base", hint: "BDCTLR.RTCSEL" },
    ),
    num("asyncPrescaler", "异步预分频", 127, 0, 0xfffff, { group: "base", hint: "RTC_PSCRL" }),
    num("syncPrescaler", "同步预分频", 255, 0, 0xffff, { group: "base", hint: "RTC_PSCRH" }),
    bool("alarmA", "闹钟 A", false, { group: "base" }),
    bool("wakeup", "周期唤醒", false, { group: "base" }),
    bool("irqAlarm", "闹钟中断", false, { group: "base" }),
  ],
};

const pwr: PeripheralSchema = {
  about: "电源控制决定低功耗模式与调压器状态。",
  groups: [g("base", "参数", true)],
  panels: [],
  params: [
    sel(
      "mode",
      "低功耗模式",
      "none",
      [
        { l: "不启用", v: "none" },
        { l: "Sleep 睡眠", v: "sleep" },
        { l: "Stop 停止", v: "stop" },
        { l: "Standby 待机", v: "standby" },
      ],
      { group: "base", hint: "PWR_CTLR.LPDS / PDDS" },
    ),
    bool("pvd", "电压监测 PVD", false, { group: "base", hint: "PWR_CTLR.PVDE" }),
    sel(
      "pvdLevel",
      "PVD 阈值",
      "2.9",
      [
        { l: "2.2 V", v: "2.2" },
        { l: "2.4 V", v: "2.4" },
        { l: "2.6 V", v: "2.6" },
        { l: "2.9 V", v: "2.9" },
      ],
      { group: "base", visibleIf: { k: "pvd", op: "=", v: true } },
    ),
  ],
};

const exti: PeripheralSchema = {
  about:
    "外部中断按线配置：每个 GPIO 的 PXn 固定对应 EXTIn，一条线同一时刻只能接一个引脚。" +
    "在引脚图上点 PXn 也能直接选 EXTIn。",
  groups: [g("base", "公共参数", true)],
  panels: ["nvic", "channelTable"],
  params: [
    bool("eventMode", "事件模式（只产生事件，不进入中断）", false, {
      group: "base",
      hint: "EXTI_EVCR；不占用 NVIC",
    }),
    bool("afioRemap", "使能 AFIO 时钟", true, {
      group: "base",
      hint: "RCC_APB2Periph_AFIO，WCH 的 EXTI 线映射挂在 AFIO 上",
    }),
  ],
  channelSpec: {
    label: "中断线",
    count: 24,
    prefix: "LINE",
    startAt: 0,
    needsPin: true,
    hint: "EXTIn 只能接 PXn（n 为引脚序号）。每条线单独设置触发边沿，超出当前器件线数的会标「不可用」。",
    modes: [
      { label: "关闭", value: "disable" },
      { label: "上升沿", value: "rising" },
      { label: "下降沿", value: "falling" },
      { label: "双边沿", value: "both" },
    ],
  },
};

const crc: PeripheralSchema = {
  about: "硬件 CRC 单元，可做 Flash 完整性校验与通信校验。",
  groups: [g("base", "参数", true)],
  panels: [],
  params: [
    num("poly", "生成多项式", 0x04c11db7, 0, 0xffffffff, { group: "base", hint: "默认 CRC-32 多项式" }),
    num("init", "初始值", 0xffffffff, 0, 0xffffffff, { group: "base" }),
    bool("inputReverse", "输入反转", false, { group: "base" }),
    bool("outputReverse", "输出反转", false, { group: "base" }),
  ],
};

/**
 * 外部晶振。
 *
 * OSC_IN / OSC_OUT 接 HSE 晶体，PC14 / PC15 接 LSE 32.768 kHz 晶体。
 * 这里只管「晶振本身怎么驱动」，频率与 PLL 倍频在时钟树页设置 ——
 * 两个页面各管一段，不重复建模。
 */
const clk: PeripheralSchema = {
  modeKey: "hse",
  about:
    "外部晶振配置。OSC_IN / OSC_OUT 接 HSE 高速晶体（4–24 MHz），PC14 / PC15 接 LSE 32.768 kHz 晶体。" +
    "频率与 PLL 倍频请到「时钟树」页设置，这里只决定晶振是否启用、是否旁路。",
  groups: [g("hse", "HSE 外部高速晶振", true), g("lse", "LSE 外部低速晶振", true)],
  panels: ["pins"],
  params: [
    sel(
      "hse",
      "HSE 驱动方式",
      "off",
      [
        { l: "关闭", v: "off" },
        { l: "晶体振荡器", v: "crystal", signals: ["HSE_IN", "HSE_OUT"], hint: "外接 4–24 MHz 石英晶体 + 两个负载电容" },
        { l: "旁路时钟（Bypass）", v: "bypass", signals: ["HSE_IN"], hint: "OSC_IN 直接输入外部方波，OSC_OUT 悬空" },
      ],
      { group: "hse", hint: "RCC_CTLR.HSEON / HSEBYP" },
    ),
    bool("waitHse", "等待 HSERDY 就绪", true, {
      group: "hse",
      visibleIf: { k: "hse", op: "!=", v: "off" },
      hint: "打开后卡在 while 里等晶振起振；起振失败会死等，量产固件建议改成带超时",
    }),
    sel(
      "lse",
      "LSE 驱动方式",
      "off",
      [
        { l: "关闭", v: "off" },
        { l: "晶体振荡器 32.768 kHz", v: "crystal", signals: ["LSE_IN", "LSE_OUT"] },
        { l: "旁路时钟（Bypass）", v: "bypass", signals: ["LSE_IN"] },
      ],
      { group: "lse", hint: "RCC_BDCTLR.LSEON / LSEBYP，用于 RTC 走时" },
    ),
    bool("waitLse", "等待 LSERDY 就绪", true, {
      group: "lse",
      visibleIf: { k: "lse", op: "!=", v: "off" },
    }),
  ],
};

const usb: PeripheralSchema = {
  modeKey: "speed",
  about: "USB 设备控制器，支持全速 / 高速、多种端点配置。",
  groups: [g("base", "参数", true), g("irq", "中断")],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "speed",
      "速度",
      "fs",
      [
        { l: "Full Speed 全速 12 Mbps", v: "fs", signals: ["DP", "DM"] },
        // 高速 PHY 只有 V407 / V467 有；FS-only 芯片（X033 / X035 / L103 / HC32）靠 cap 隐藏
        { l: "High Speed 高速 480 Mbps", v: "hs", signals: ["DP", "DM"], cap: "usb.hs" },
      ],
      { group: "base" },
    ),
    num("ep0Size", "端点 0 大小", 64, 8, 64, { group: "base", hint: "仅支持 8/16/32/64" }),
    num("epNum", "端点数量", 4, 1, 8, { group: "base" }),
    bool("sof", "帧首中断 (SOF)", false, { group: "irq" }),
    bool("reset", "总线复位中断", true, { group: "irq" }),
  ],
};

/**
 * USB PD（Type-C 上的 PD 控制器）。
 *
 * 它和 USBFS 是两个独立外设，引脚也完全不同：PD 走 CC1 / CC2 两根，
 * 没有 DP / DM。所以不能复用 USB 的模式（那会把 DP/DM 当成必需信号，
 * 结果 PD 永远「无法启用」）。
 */
const usbpd: PeripheralSchema = {
  modeKey: "role",
  about:
    "USB PD 控制器接在 Type-C 的 CC1 / CC2 上（不是 DP/DM），负责 BMC 编解码与 PD 报文。" +
    "两根 CC 都要引出来才能自动识别正反插；只做固定方向的受电端时也可以只接 CC1。",
  groups: [g("base", "角色与报文", true), g("adv", "高级", false, true), g("irq", "中断")],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "role",
      "角色",
      "disable",
      [
        { l: "Disable", v: "disable" },
        {
          l: "Sink 受电端（设备）",
          v: "sink",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "从适配器取电；Rd 下拉由 PHY 控制，CC1/CC2 都要接才能识别正反插",
        },
        {
          l: "Source 供电端（主机）",
          v: "source",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "对外供电；Rp 上拉电阻决定广播的电流档位",
        },
        {
          l: "DRP 双角色",
          v: "drp",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "按连接对方自动切换 Source / Sink",
        },
      ],
      { group: "base", hint: "PD_CTLR 的 CC 角色位" },
    ),
    sel(
      "pdVersion",
      "协议版本",
      "pd3",
      [
        { l: "USB PD 3.0", v: "pd3" },
        { l: "USB PD 2.0", v: "pd2" },
      ],
      { group: "base", visibleIf: { k: "role", op: "!=", v: "disable" }, hint: "影响报文头与 PPS 支持" },
    ),
    num("pdoVoltage", "默认输出电压", 5, 5, 20, {
      group: "base",
      unit: "V",
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "Source 上电后广播的 PDO 电压（5 / 9 / 12 / 15 / 20 V）",
    }),
    num("pdoCurrent", "默认输出电流", 3, 0.5, 5, {
      group: "base",
      unit: "A",
      step: 0.25,
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "决定 Rp 广播的电流档位：默认 / 1.5 A / 3 A",
    }),
    bool("autoPolarity", "自动识别 CC 极性", true, {
      group: "base",
      visibleIf: { k: "role", op: "!=", v: "disable" },
      hint: "正插接 CC1、反插接 CC2，硬件自动切换",
    }),
    bool("vconn", "输出 VCONN", false, {
      group: "adv",
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "给线缆里的 E-Marker 供电（5 V / 1 W）",
    }),
    bool("pdHardReset", "收到 Hard Reset 自动软复位", true, {
      group: "adv",
      visibleIf: { k: "role", op: "!=", v: "disable" },
    }),
    bool("irqCc", "CC 状态变化中断", true, { group: "irq" }),
    bool("irqPd", "PD 报文收/发中断", true, { group: "irq" }),
  ],
};

const can: PeripheralSchema = {
  modeKey: "mode",
  about: "CAN 控制器，支持标准帧 / 扩展帧与回环自测。",
  groups: [g("base", "参数", true)],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "正常模式", v: "normal", signals: ["TX", "RX"] },
        { l: "回环模式", v: "loopback", signals: ["TX", "RX"] },
        { l: "静默模式", v: "silent", signals: ["TX", "RX"] },
      ],
      { group: "base" },
    ),
    num("prescaler", "波特率预分频", 4, 1, 1024, { group: "base" }),
    num("bs1", "BS1", 8, 1, 16, { group: "base" }),
    num("bs2", "BS2", 3, 1, 8, { group: "base" }),
    num("sjw", "SJW", 1, 1, 4, { group: "base" }),
  ],
};

const opa: PeripheralSchema = {
  modeKey: "mode",
  about: "片内运算放大器，可配置为独立运放、跟随器或 PGA。",
  groups: [g("base", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        // OPA 的输入/输出可以全走片内（送 ADC / 定时器），外部引脚是可选的；
        // 具体能用 P0/N0/OUTx 哪些线由器件包的 signals 决定，见引脚页。
        { l: "独立运放", v: "standalone" },
        { l: "电压跟随器", v: "follower" },
        { l: "可编程增益 PGA", v: "pga" },
      ],
      { group: "base" },
    ),
    sel(
      "gain",
      "增益",
      "2",
      [
        { l: "×2", v: "2" },
        { l: "×4", v: "4" },
        { l: "×8", v: "8" },
        { l: "×16", v: "16" },
        { l: "×32", v: "32" },
      ],
      { group: "base", visibleIf: { k: "mode", op: "=", v: "pga" } },
    ),
  ],
};

const cmp: PeripheralSchema = {
  modeKey: "mode",
  about: "模拟比较器，输出可送到定时器刹车或外部中断。",
  groups: [g("base", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        // 比较器可以只走片内（输出送 TIM 刹车 / EXTI），外部 P/N/OUT 引脚可选；
        // 具体引线名由器件包 signals 给出（CMP1 是 P0/P1/OUT，CMP3 是 N0/N1）。
        { l: "启用", v: "enable" },
      ],
      { group: "base" },
    ),
    sel(
      "polarity",
      "输出极性",
      "normal",
      [
        { l: "同相", v: "normal" },
        { l: "反相", v: "invert" },
      ],
      { group: "base" },
    ),
    sel(
      "hysteresis",
      "迟滞",
      "none",
      [
        { l: "无", v: "none" },
        { l: "低", v: "low" },
        { l: "中", v: "mid" },
        { l: "高", v: "high" },
      ],
      { group: "base" },
    ),
  ],
};

/**
 * 调试接口（SDI）。
 *
 * 数据手册 1.4.2x：内核自带串行 2 线调试接口（SDI），复位后默认开启，
 * 主程序里可以关掉把 SWDIO/SWCLK 释放成普通 GPIO。
 *
 * 「单线」这一项故意留在选项里但按器件能力禁用 —— 作者的原话是
 * 「是单线还是双线都没有」，与其藏起来，不如明确告诉他这颗片子不支持单线，
 * 免得他去翻手册。
 */
const dbg: PeripheralSchema = {
  modeKey: "iface",
  about:
    "调试接口。复位后 SDI 默认开启并占用 SWDIO / SWCLK 两个引脚；" +
    "关掉之后这两个脚可以当普通 GPIO 用（代价是没法再连调试器）。" +
    "下面的「调试时冻结」只在接调试器时生效，不影响脱机运行。",
  groups: [g("iface", "接口", true), g("freeze", "调试时冻结", false, true)],
  panels: ["pins"],
  params: [
    sel(
      "iface",
      "接口类型",
      "sdio2",
      [
        { l: "2 线 SDI（SWDIO + SWCLK）", v: "sdio2", signals: ["SWDIO", "SWCLK"], hint: "复位默认状态，可被调试器连接" },
        // 能力门槛由 pinmux.modeOptionSupported 消费：只有支持单线的系列才出现这一档
        {
          l: "1 线 SWIO（仅 SWDIO）",
          v: "swio1",
          signals: ["SWDIO"],
          cap: "debug.singleWire",
          hint: "只需 SWDIO 一根线即可调试；不支持单线的系列会自动隐藏",
        },
      ],
      { group: "iface", hint: "RCC_APB2Periph_AFIO + GPIO_PinRemapConfig(SWJ)" },
    ),
    bool("freezeIwdg", "冻结独立看门狗", true, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_IWDG_STOP：停在断点时不让 IWDG 把芯片复位掉",
    }),
    bool("freezeWwdg", "冻结窗口看门狗", true, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_WWDG_STOP",
    }),
    bool("freezeTim", "冻结定时器计数", false, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_TIMx_STOP：单步调试 PWM / 编码器时要开，否则计数值一直在跑",
    }),
    bool("freezeSleep", "低功耗模式下保持调试连接", false, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_SLEEP / STOP / STANDBY，调试低功耗流程时打开",
    }),
  ],
};

/**
 * DMA 汇总。
 *
 * 这个外设没有自己的引脚，它的页面是**全工程视角**：所有通道谁在用、
 * 有没有撞车、还剩几条空的。具体某条通道的参数在各自外设的「DMA」页里改。
 */
const dma: PeripheralSchema = {
  about:
    "DMA 控制器。CH32 的每个通道只能接固定的几个硬件请求（见参考手册「DMA 请求映射」），" +
    "所以一条通道被两个外设占用时，硬件上根本跑不起来 —— 这里会把冲突标红。",
  groups: [],
  panels: ["dmaTable"],
  params: [],
};

const gpio: PeripheralSchema = {
  about: "GPIO 面板按端口列出全部引脚，可批量设置模式、上下拉、速度与用户标签。标签会写进生成的宏定义。",
  groups: [],
  panels: ["gpio"],
  params: [],
};

const system: PeripheralSchema = {
  about: "系统级配置：调试接口、向量表、低功耗唤醒与看门狗行为。",
  groups: [g("base", "系统", true), g("dbg", "调试接口", true)],
  panels: [],
  params: [
    sel(
      "debug",
      "调试接口",
      "swd",
      [
        { l: "双线 SDI（SWD 兼容）", v: "swd" },
        { l: "单线 SDI", v: "sdw" },
        { l: "关闭（引脚作 GPIO）", v: "off" },
      ],
      { group: "dbg", hint: "关闭后 SWIO/SDCK 释放为普通 GPIO，且无法再连接调试器" },
    ),
    bool("vectorTableRam", "向量表放 RAM", false, { group: "base", hint: "支持运行时重定向中断向量，用于 Bootloader" }),
    bool("resetOnLockup", "死锁时复位", true, { group: "base" }),
    bool("wwdgReset", "看门狗溢出复位", true, { group: "base" }),
  ],
};

/* ══════════════════ 跨厂商通用外设（HC32 / 其它 M4 系） ══════════════════ */

/**
 * 只能异步的串口（HC32 的 UART4/5、STM32 的 LPUART）。
 *
 * 复用 USART 的全部参数，只把「模式」收窄成「开/关 + 异步」，
 * 并去掉时钟参数组 —— 这些口物理上没有 CK 脚，摆出 CPOL/CPHA 只会误导。
 * 这样参数面板、引脚规划、代码生成都不用为它写第二套逻辑。
 */
const uart: PeripheralSchema = {
  ...usart,
  modeKey: "mode",
  about:
    "异步串口（无同步时钟）。参数与 USART 的异步模式一致，" +
    "差别只在于没有 CK 脚，因此不提供同步模式与时钟参数。",
  groups: [g("mode", "工作模式", true), g("basic", "基本参数", true), g("adv", "高级参数", false, true), g("irq", "中断与 DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [{ l: "Disable", v: "disable" }, { l: "Asynchronous 异步", v: "Asynchronous", signals: ["TX", "RX"] }],
      { group: "mode" },
    ),
    ...usart.params.filter((p) => p.key !== "mode" && p.group !== "clock"),
  ],
};

/** 四线 QSPI：NSS + CLK + D0..D3，单线模式下只用 D0/D1 */
const qspi: PeripheralSchema = {
  modeKey: "mode",
  about:
    "四线 QSPI（也叫 OSPI / SPI1）。单线模式等价于普通 SPI；" +
    "四线模式下一次传 4 bit，片选、时钟、数据线必须落在同一复用组里。",
  groups: [g("mode", "模式", true), g("param", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "单线 (1-1-1)", v: "single", signals: ["NSS", "CLK", "D0", "D1"] },
        { l: "四线 (1-1-4)", v: "quad", signals: ["NSS", "CLK", "D0", "D1", "D2", "D3"] },
      ],
      { group: "mode" },
    ),
    num("prescaler", "时钟分频", 4, 2, 32, { group: "param", step: 2, formula: "fSCK = fHCLK / 分频" }),
  ],
};

/** I²S：WS / CK / SD / MCK。方向决定占 SDIN 还是 SDOUT */
const i2s: PeripheralSchema = {
  modeKey: "mode",
  about: "I²S 音频接口。WS 是声道选择（字选），CK 是位时钟，SD 是数据；MCK 只在需要主时钟时分配。",
  groups: [g("mode", "模式", true), g("param", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "主机发送", v: "master_tx", signals: ["WS", "CK", "SDOUT"] },
        { l: "主机接收", v: "master_rx", signals: ["WS", "CK", "SDIN"] },
        { l: "从机发送", v: "slave_tx", signals: ["WS", "CK", "SDOUT"] },
        { l: "从机接收", v: "slave_rx", signals: ["WS", "CK", "SDIN"] },
      ],
      { group: "mode" },
    ),
    sel(
      "format",
      "数据格式",
      "i2s",
      [
        { l: "I²S 标准", v: "i2s" },
        { l: "左对齐", v: "left" },
        { l: "右对齐", v: "right" },
        { l: "PCM", v: "pcm" },
      ],
      { group: "param" },
    ),
    num("mclkDiv", "主时钟分频", 256, 1, 512, { group: "param", hint: "需要 MCK 时分配该引脚" }),
  ],
};

/** DAC 单路电压输出 */
const dac: PeripheralSchema = {
  modeKey: "mode",
  about: "12 位电压输出 DAC。输出脚是固定的模拟脚，不需要配复用寄存器。",
  groups: [g("param", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "使能输出", v: "enable", signals: ["OUT"] },
      ],
      { group: "param" },
    ),
    num("trigger", "触发源选择", 0, 0, 15, { group: "param", hint: "0 = 软件触发" }),
  ],
};

/**
 * 电压比较器（HC32 的 VC0..VC2）。
 *
 * 与 WCH 的 CMP 不同：它有**多路**同相输入（CH0..CH4）可选，
 * 不是一个固定的 INP/INM。所以单独一套 schema，而不是硬套 CMP。
 */
const vcmp: PeripheralSchema = {
  modeKey: "mode",
  about: "电压比较器。输出既能送定时器刹车，也能触发外部中断；输入端可从多路通道里选。",
  groups: [g("param", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "使能", v: "enable", signals: ["OUT"] },
      ],
      { group: "param" },
    ),
    sel(
      "positive",
      "同相输入",
      "0",
      [
        { l: "CH0", v: "0" },
        { l: "CH1", v: "1" },
        { l: "CH2", v: "2" },
        { l: "CH3", v: "3" },
        { l: "CH4", v: "4" },
      ],
      { group: "param", hint: "实际可选范围以器件引脚为准" },
    ),
    sel(
      "filter",
      "数字滤波",
      "off",
      [
        { l: "关闭", v: "off" },
        { l: "开启", v: "on" },
      ],
      { group: "param" },
    ),
  ],
};

/**
 * 差分运放 / PGA（HC32 的 FDA）。
 *
 * 与 OPA 的区别：它是**差分**的，有 OUTP/OUTN 两个输出、每边 3 组输入。
 * 所以不能复用 OPA 的 INP/INM/OUT。
 */
const fda: PeripheralSchema = {
  modeKey: "mode",
  about: "差分运放 / 可编程增益放大器。输出可单端也可差分，输入端每边有 3 组可选。",
  groups: [g("param", "参数", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "模式",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "差分输出", v: "diff", signals: ["OUTP", "OUTN"] },
        { l: "单端输出", v: "single", signals: ["OUTP"] },
      ],
      { group: "param" },
    ),
    sel(
      "gain",
      "增益",
      "2",
      [
        { l: "×2", v: "2" },
        { l: "×4", v: "4" },
        { l: "×8", v: "8" },
        { l: "×16", v: "16" },
        { l: "×32", v: "32" },
      ],
      { group: "param" },
    ),
  ],
};

export const SCHEMAS: Record<string, PeripheralSchema> = {
  USART: usart,
  SPI: spi,
  I2C: i2c,
  TIM: tim,
  ADC: adc,
  IWDG: iwdg,
  WWDG: wwdg,
  RTC: rtc,
  PWR: pwr,
  EXTI: exti,
  CRC: crc,
  CLK: clk,
  DBG: dbg,
  DMA: dma,
  USB: usb,
  USBPD: usbpd,
  CAN: can,
  OPA: opa,
  CMP: cmp,
  UART: uart,
  QSPI: qspi,
  I2S: i2s,
  DAC: dac,
  VCMP: vcmp,
  FDA: fda,
  GPIO: gpio,
  SYSTEM: system,
};

export function schemaFor(key: string): PeripheralSchema | undefined {
  return SCHEMAS[key];
}

/** 参数默认值集合 */
export function defaultParams(schema: PeripheralSchema): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of schema.params) {
    if (p.type === "note") continue;
    out[p.key] = p.default;
  }
  return out;
}
