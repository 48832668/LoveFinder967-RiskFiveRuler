# RiskFiveRuler

面向 WCH CH32（青稞 RISC-V）MCU 的图形化外设配置与代码生成工具，Windows 桌面端。
交互范式参考 STM32CubeMX：左边选外设、中间配参数、右边点引脚，最后一键出 WCH SDK 风格的 C 代码。

当前器件库：**WCH：CH32L103（6 个型号）/ CH32X035（7 个封装）/ CH32X033（TSSOP20）/ CH32V407（4 个封装）；小华 HDSC：HC32F401B（LQFP64 / LQFP32 / QFN32-4×4 / QFN32-5×5 / QFN24）**。

![引脚与外设](docs/screenshots/pinout.png)

```
┌──────────────────────────────────────────────────────────────────┐
│ 器件(只读)+更换 │ 工程名 │ 引脚与外设 · 时钟树 · 生成代码 · 工程设置 │
├──────────┬──────────────────────┬────────────────────────────────┤
│ 外设树    │ 参数 / 引脚 / 通道    │ 封装引脚图（可缩放、可点选）      │
│          │ NVIC / DMA           │                                │
├──────────┴──────────────────────┴────────────────────────────────┤
│ SYSCLK 48 MHz · PCLK1 · PCLK2 · ADCCLK │ 已用引脚 5/20 │ 无冲突  │
└──────────────────────────────────────────────────────────────────┘
```

| 点引脚 → 弹出可选模式 | GPIO 配置后引脚块着色 + 右下角图例 |
| --- | --- |
| ![引脚菜单](docs/screenshots/pinmenu.png) | ![GPIO 配色与图例](docs/screenshots/gpio-fill.png) |

| 更换器件：三级联动 + 资源表 | 浅色主题 |
| --- | --- |
| ![更换器件](docs/screenshots/picker.png) | ![浅色](docs/screenshots/pinmenu-light.png) |

| 调试接口（单线/双线 SDI） | DMA 汇总：用了几条、谁在用、还剩几条 |
| --- | --- |
| ![调试接口](docs/screenshots/dbg.png) | ![DMA 汇总](docs/screenshots/dma.png) |

| 时钟树 | 生成代码 |
| --- | --- |
| ![时钟树](docs/screenshots/clock.png) | ![代码](docs/screenshots/code.png) |

## 目前支持

| 系列 | 型号（封装） | 状态 |
| --- | --- | --- |
| CH32L103 | F8P6 (TSSOP20) · F8U6 (QFN20) · G8R6 (QSOP28) · K8U6 (QFN32) · **K8U7 (QFN32，−40~105 ℃)** · C8T6 (LQFP48) | 引脚号已逐脚核对 |
| CH32X035 | R8T6 (LQFP64M) · C8T6 (LQFP48) · G8U6 (QFN28) · G8R6 (QSOP28) · F8U6 (QFN20) · F7P6 (TSSOP20) · D8U6 (QFN12) | 引脚号已逐脚核对 |
| CH32X033 | F8P6 (TSSOP20) | 引脚号已逐脚核对 |
| CH32V407 | VET6 (LQFP100) · WEU6 (QFN68) · RET6 (LQFP64) · KEU6 (QFN32) | 按 DS0 V1.4 + RM V1.3 重录，717 条复用项全核对 |

外设树按 系统 / 通信 / 定时器 / 模拟 / 安全 分组。
**Flash 等待周期不在里面** —— 它不是可配置的外设，而是主频的函数，
工具按 `SYSCLK ≤ 24 MHz → 0、≤ 48 → 1、其余 → 2` 自动推导并写进 `RFR_ClockInit()`。
系统组里的「时钟源」管 HSE / LSE 外部晶振（OSC_IN/OSC_OUT 接 HSE，PC14/PC15 接 LSE）。

**封装决定可用引脚。** 同一个系列的小封装不会引出全部端口，
所以 `USART3_TX` 在大封装上有、在 QFN20 上可能没有。
判定标准是**必需信号是否齐全**：SPI 缺了 SCK，就算 MOSI/MISO 都在也算不可用。

这类外设**不再留在外设树里划掉**（和「引脚被别人占了」长得太像，容易误判成冲突），
而是收进树底部一行灰字：`⌀ 本封装未引出：I2C2 · SPI2`。
如果它已经被启用过，仍然留在树里并标「不可用」，否则它会在界面上消失、却还在生成代码。

### 串口参数页的组织（对齐 PY32Studio）

参数按三组排列，顺序固定：

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 基本参数 | 波特率 · 字长 · 停止位 · 校验 | 决定一帧的格式 |
| 高级参数 | **数据方向** · 过采样 · 硬件流控 (RS232) · RS485 (DE) · 自动波特率 · TX/RX 互换与极性 · 接收超时 | 默认折叠 |
| **时钟参数（同步模式）** | 时钟极性 CPOL · 时钟相位 CPHA · 最后一位时钟 (Last Bit) | 只在 `Synchronous` 下出现 |

**数据方向是一个下拉三选一**，不是两个勾选框：
`Receive and Transmit 收发` / `Transmit only 仅发送` / `Receive only 仅接收`。
选「仅发送」就不占 RX、选「仅接收」就不占 TX（`affectsPins` 会让引脚当场跟着变）。
单线半双工只有一根线，方向对它不生效，生成代码固定 `USART_Mode_Tx | USART_Mode_Rx`。

**切到异步模式时「时钟参数」整组消失**，不需要额外的显隐开关 ——
那三项都带 `visibleIf: mode == Synchronous`，分组内没有可见字段时 `ParamsTab` 直接不渲染该组。

同步模式的 CPOL/CPHA/LastBit 会写进 `USART_ClockInit()`，不再是硬编码的 Low/1Edge/Disable。

**没有 FIFO 相关字段**（PY32 有 `FIFO Mode` / `Txfifo Threshold` / `Rxfifo Threshold`）：
CH32 系列的 USART 没有收发 FIFO，放出这三项会生成不存在的寄存器操作。
以后遇到带 FIFO 的系列，在 `ApiProfile` 里加一个能力位再开这三行。

### 一个概念只给一个地方：引脚页与通道页

| 外设 | 引脚页 | 通道页 |
| --- | --- | --- |
| USART / I2C / SPI / CAN / USB | 全部信号（TX/RX、SCL/SDA、SCK/MOSI…） | 无 |
| TIM | 只有 BKIN / ETR | CH1~CH4，含互补输出 **CHxN**（同一个通道的另一根线，放在卡片里一起配） |
| ADC | **没有引脚页** | IN0~IN9 —— ADC 的通道就是引脚，不拆成两处 |
| EXTI | 无 | LINEx |

从引脚图点任何信号，面板会**自动跳到它真正落到的页**：点 `ADC1_IN4` 跳到通道页并把 IN4 那张卡片打开，
点 `TIM1_CH1N` 跳到通道页并写进 CH1 的互补引脚。点完什么都不变，是新手最容易迷路的地方。

通道清单按器件包里的**真实信号**生成（ADC1 是 IN0~IN9 十个），不是 schema 里写死的数量 ——
否则 IN0 / IN9 永远没有卡片，从引脚图点它们会「消失」。

### 换器件：先看资源，再按确定

顶部只读显示当前型号，点「更换」弹出三段式选择器：

| 列 | 内容 |
| --- | --- |
| 系列 | CH32L103 / CH32X035 / CH32X033 |
| 型号 | 该系列的全部封装，**点一下只是选中**，不会立刻换器件 |
| 资源 | 选中型号的完整资源表 |

资源表按四组列出：外设（USART / SPI / I²C / CAN / TIM / ADC 通道 / OPA / CMP / DMA / EXTI 各多少条）、
存储与主频（主频 / Flash / SRAM）、接口 PHY（USB FS / USB PD 有没有）、封装（封装形式 / 引脚数 / GPIO / 供电）。

外设条数是**按当前封装算的**：数据手册的资源表也是这个口径，比如 X035 的 QFN20 只标 3 个串口。
本封装引不全时会在右侧补一句「共 4，本封装完整引出 3」。

只有点「确定」（或双击型号卡片）才真正切换；`↑↓` 选、`Enter` 确定、`Esc` 取消。

筛选条支持：内核、**主频区间**（最低 / 最高 MHz，附 `≥48/96/144/200` 快捷键）、外设数量；
勾选 **USB** 后会展开进阶条件 —— `USB FS` / `USB HS`（可多选）+ `USB DEVICE / USB HOST / USB DUALROLE`（select）。
弹窗高度固定，切换「全部系列 / 某系列」时不会跳动。

外设参数模式已覆盖：USART、SPI、I2C、TIM（含四通道 + 互补 + 死区 + 刹车）、
ADC（规则组/注入组/看门狗）、IWDG、WWDG、RTC、PWR、EXTI、FLASH、USB、CAN、OPA、CMP。

**USART 目前只放开三种模式**，每种占几条线由模式决定，切换模式引脚会当场增删：

| 模式 | 占用的线 | 说明 |
| --- | --- | --- |
| Asynchronous 异步 | TX + RX | 最常用 |
| Synchronous 同步 | TX + RX + CK | CK 输出波特率时钟（`CTLR2.CLKEN`） |
| Single Wire 单线半双工 | TX | 收发共用一根线（`CTLR3.HDSEL`） |

三种模式都受「数据方向」约束：选**仅发送**就不再占 RX，选**仅接收**就不再占 TX
（单线半双工只有一根线，方向参数不生效）。引脚页会跟着增减，不会出现「只用 RX 却还占着 TX」。

多机 / IrDA / LIN / 智能卡这几种模式的数据还留在 `schemas.ts` 的 `USART_MODE_OPTIONS` 里，
只是没进 `USART_VISIBLE_MODES` —— 它们的专属参数还没在生成器里落地，补齐后加个名字就能放出来。

**I2C 的 SMBus 是一个模式，不是开关**：只有选「SMBus 主机 / 设备」时才会出现 SMBA 告警引脚
（`CTLR1.SMBUS=1`），普通主/从机没有这条线；X035 / X033 系列本身没有引出 SMBA，那一行不会出现。

**USBPD 和 USBFS 是两个外设**。USBFS 走 DP/DM，USBPD 走 CC1/CC2（Type-C 的配置通道），
所以 PD 有自己的参数模式（Sink / Source / DRP + PDO 电压电流），不复用 USB 的模式 ——
否则 PD 会被当成「缺 DP/DM」，永远无法启用。L103 与 X035 都有这个外设。

### 视觉类问题怎么处理

本仓库的开发环境没有 OCR / 视觉能力，看不了截图和 PDF 表格。
需要从图里读信息时，用 [`docs/ocr-prompts.md`](docs/ocr-prompts.md) 里的提示词交给有视觉能力的大模型，
它按固定格式回话（编号列表 / JSON / 一行一条记录），再照着改数据。

文档末尾有一节「资源表 vs 器件包核对结果」，列了六款 L103 目前对得上与对不上的地方。

### 复用映射的来源

L103 的整个器件包（6 个型号的封装引脚 + 全部复用功能）由
`scripts/rebuild_l103_from_ds.py` 从 **DS0 表 2-1-1**（已存为 [`docs/ch32l103-pin-table.md`](docs/ch32l103-pin-table.md)）自动生成，不要手改 JSON：

```bash
python scripts/rebuild_l103_from_ds.py docs/ch32l103-pin-table.md
```

- `ports` 里的 `remap` 就是手册的 **AFIO 配置位数值**（`USART3_TX[11]` → `3`），
  引脚菜单的 `⟲n` 角标显示的就是它，和手册能逐条对上。
- 手册里的 `PD0 / PD1` 是内部短接到 `OSC_IN / OSC_OUT` 的（没有任何 L103 封装单独引出 PD），
  所以 USART3 / CAN1 的那些重映射落在 OSC 引脚上 —— 与手册一致，不是错位。
- **合封引脚**（TSSOP20 的 PA13↔PB6、QFN20 的 PA12↔PA14…）用 `aliases` 表达，
  引脚图上两边的功能都能选；GPIO 计数仍按物理脚算，不会因为合封多算一个。
- `MCO / WKUP / TAMPER / RTC` 这几个多功能没有建模成外设信号，引脚菜单里不出现（记在 `pending`）。

脚本跑完会自己校验：封装脚数是否等于封装名、引脚号是否 1..N 连续、GPIO 数是否与资源表一致。

改完再用独立脚本双向核对一遍（它自己重新解析 markdown，能抓出重建脚本的解析 bug）：

```bash
python scripts/check_l103_pins.py docs/ch32l103-pin-table.md
# 核对 1327 条，缺失 0 条 / 多余的条目 0 条
```

V407 同理（它的表多一层 RM 侧的「重映射配置组总表」，两个脚本都会一起解析）：

```bash
python scripts/rebuild_v407_from_ds.py docs/ch32v407-pin-table.md
python scripts/check_v407_pins.py     docs/ch32v407-pin-table.md
# 手册条目核对 717 条，缺失 0 条 / 引脚号问题: 无 / 配置组冲突 22 处
```

`check_v407_pins.py` 除了查漏，还会报「同一封装内同一信号的同一配置组落到两个引脚」——
这是源表自相矛盾的信号，只能回查 DS0 原表，工具不去猜哪一边对。

### 重映射组会写进生成代码的提示

`collectUsage` 现在带着每个信号的重映射组（来自器件包的 `remap`）。
用到非默认组的信号时，`rfr_init.c` 开头会列出清单：

```
/* ⚠ 下列信号用的不是默认复用组，必须先把 AFIO 重映射配到对应组，
 *     I2C1_SCL  PB8  配置组 1
 *   参考手册的「复用功能重映射」章节（V407: RM 10.2.11 AFIO_PCFR1/PCFR2）。*/
```

工具还没内置各系列的 `GPIO_PinRemapConfig` 宏名表，所以只提示不代配 ——
这比生成一段看着对、跑起来外设不动（引脚配成 AF 但 AFIO 还在默认脚）的代码安全。

释放一个引脚等于**回到未配置**：GPIO 模式退回复位默认的「模拟」，引脚图上和从没配过的脚长得完全一样，
不会留下一个浅色的「GPIO 输入」。

### 启用不了的时候

顶部的启用开关只有三种结局，界面会把原因说清楚：

| 情形 | 表现 |
| --- | --- |
| 有空闲引脚 | 开关可用，直接启用，引脚自动分配 |
| 目标引脚被占，但占用者**自己还有别的空脚** | 开关仍可用，上方给黄色警告：`USART1_TX：PB6 → PA9（为 I2C1_SCL 让位）`；点开启用会连重映射一起提交 |
| 目标引脚被占且占用者无处可去 | 开关禁用，列红框：哪个外设占了哪个脚、本外设要拿它做什么，每条后面一个「关闭」按钮 —— 点一下就关掉那个外设并释放它的全部引脚，冲突随之消失 |

## 代码分层（3 层）

按「dbio → funcHANDLE → UI render & funcall」切分，前端与 Rust 各有一套边界：

| 层 | 前端（TS） | Rust 外壳 | 职责 |
| --- | --- | --- | --- |
| **1 dbio** | `platform/` | `layer1_fsio` · `layer1_env` | 文件、目录、宿主能力；不碰业务 |
| **2 funcHANDLE** | `model/` `engine/` `semantic/` `packs/` `devices/` `backends/` `app/` | `layer2_project` · `layer2_export` · `layer2_app` | 数据模型、引脚/时钟、器件包、代码生成、编排 |
| **3 UI render & funcall** | `ui/` + `App.tsx` | `commands.rs` | 只渲染 + 调命令；不持有文件句柄 |

依赖**只允许向下**（`scripts/check_layers.mjs` 会检查，挂进 `npm test`）：

```
model/       纯类型，零本地 import        DeviceDef / Project / ParamDef …
engine/      纯函数，只依赖 model         clock（时钟求解）/ dma / expr
semantic/    参数与引脚语义                schemas.ts / pinmux.ts（模式规则读 schema）
packs/       器件包加载与校验              types / loader / validate
devices/     器件注册表 + 厂商元数据        registry.ts / wch.ts / data/*.json
backends/    代码生成后端                  index.ts / generic.ts / wch/codegen.ts
platform/    宿主能力                      io（Tauri 命令）/ recent / appInfo
app/         应用编排                      工程默认值、资源汇总、器件筛选
ui/          React 组件                    只调下层，不反向被依赖
core/        **过渡期兼容层**：只做 re-export，新代码不要 import
```

两条容易放错位置的边界：

- **`pinmux` 在 `semantic/`，不在 `engine/`**：它要读 `schemas.ts` 的模式选项。
  `engine/` 保持纯函数；`semantic/` 允许依赖 `engine/`（表达式求值）。
- **`codegen` 在 `backends/wch/`**：它只依赖 model / engine / semantic / devices，
  不依赖 `app/`，所以新增后端不需要动编排层。

**加一家新厂商要改什么**：一份 `devices/data/<系列>.json`（含 `meta`）+ 在
`devices/registry.ts` 注册一行。**不需要**改 model / engine / semantic / ui。

Rust 侧的铁律：`commands.rs` 只转发；`layer2_*` 只调 `layer1_*`；`layer1_*` 不认识
工程/外设/UI。所有文件句柄与缓冲区都在 Rust 内创建并释放。

### 引脚图重绘时机

引脚图是 canvas，颜色全部来自 CSS 变量（`--pin-body` 等）。切主题时**必须重绘**才看得到变化——
它不会跟着 DOM 自动刷新。所以用 `MutationObserver` 盯 `<html>` 的 `data-theme`，一变就重画。
之前要手动滚一下滚轮（触发重绘）才变色，就是这个原因。

### 引脚下拉：冲突在展开时就能看见

候选引脚按「空闲优先」排序，被占的排在后面并直接注明占用者：

```
CTS:  — 未分配 —  /  PA9 · pin 10  /  PC16 · pin 5　⚠ USB1_DM
```

以前只有**选中之后**才在状态列报冲突 —— 展开一列裸引脚号，挑中一个才发现红的，那一步白点。
`<option>` 只能放纯文本，所以占用信息只能写成后缀；顺序上是「自己的 → 空闲 →
被本外设其它信号占的 → 被别的外设占的」，同外设内部的冲突排在前面，因为那只要换个模式就能解。

### 模式按引脚可用性过滤

模式下拉只列**这颗封装真的做得到**的模式：一个模式要求的信号只要有一条在这颗片子上没有引脚，
就不提供它，并在字段下方说明原因。

```
USART1（CH32X033，TSSOP20）：
  模式：Disable / Asynchronous 异步 / Single Wire 单线半双工
  本封装未引出对应引脚，已隐藏：Synchronous 同步（缺 CK）
```

这条是通用的：X033 一个 CK 都没引出，所以它的 USART1 没有同步模式；同一颗片子的 USART2 有
`CK=PA4`，同步模式照常提供。`normalizeModes` 也会把「换封装后不再可行」的旧模式落回可行项。

### 引脚图：完整布局 / 单侧列表

工具条左侧的布局选择可以切换两种看法：

| 布局 | 适用 | 行为 |
| --- | --- | --- |
| **完整布局** | 20–48 脚 | 四边环绕封装本体，滚轮缩放、拖拽平移 |
| **引脚 1–16 / 17–32 … 列表** | LQFP64/100 这类密集封装 | 引脚只排左侧，一行一脚横着写；滚轮上下滚动，`Ctrl+滚轮` 或 `＋/－` 缩放 |

列表每 16 脚一段（64 脚 → 4 段）。选列表时旋转按钮会禁用（列表没有方向可言），
换器件会自动回到完整布局 —— 否则「64 脚选了 49–64、再切到 32 脚」会得到一个空列表。

引脚色块与本体之间留了 4px 缝隙：两者都是圆角矩形，紧贴时圆角会互相咬进去。

### 引脚图：色块里写信号名

已配置的引脚，色块里直接写完整的信号名（`USB1_DP`、`USART1_RX`），色块长度按文字实测宽度
撑开 —— **矩形长短不一致是刻意的**，装得下字比排得整齐重要。文字颜色按底色亮度取黑/白
（USB 的 `#f2c94c` 用白字等于看不见）。

### 复用功能的两种硬件语义

这一条决定了引脚规划的算法，写错会导致「合法组合被判冲突」或「生成跑不起来的配置」：

| 厂商 | 机制 | 工具表达 | 规划行为 |
| --- | --- | --- | --- |
| WCH CH32 | AFIO 重映射**整组切换** | `afGrouping = "grouped"` | 同一外设的所有信号必须共用一个重映射组；全默认组优先，然后按组号升序试 |
| HC32 / STM32 | 每个引脚**独立**选 AF 编号 | `afGrouping = "independent"` | 不加组约束，各信号各挑各的引脚 |

界面上也分开表达：WCH 显示 `⟲1`（组 1），HC32 显示 `AF4`（该脚要选的复用功能号）。

> 顺带补了一个老漏洞：这个约束以前**两家都没做**。WCH 的 AFIO 是整组切换，
> 混组配置在硬件上根本跑不起来，但工具不检查。现在 `planPins` 会强制组一致。

### 引脚号不一定是物理引脚号

HC32 的数据手册 4.2 只给「端口 → AF 映射」，**没有物理封装引脚号**（那在引脚定义大图里）。
所以器件包可以标 `pinNumbering: "sequence"`：引脚号是按端口顺序推的**序号**，
引脚图上方会显示黄色提示「不是封装的实际引脚号」。WCH 全系是 `package`（真实物理号），不显示提示。

### 代码生成后端

`DeviceDef.backend` 决定用哪个生成器：

| 后端 | 适用 | 产出 |
| --- | --- | --- |
| `wch-spl` | WCH 全系 | 完整可编译的 SPL 初始化代码 + 引脚表 + MRS 工程 |
| `generic` | 刚接入、还没写生成器的厂商 | **完整可用的引脚表**（含 AF 编号）+ TODO 清单，界面显著提示 |
| （禁止） | 资料只到引脚/AF 层级的型号 | 不生成任何初始化代码；`codegen: "disable"`，界面只留「导出引脚表」 |

**HC32F401B 目前是禁止状态**（`codegen: "disable"`）：只有引脚与复用功能资料，
没有寄存器手册与 SDK 头文件。界面顶栏的按钮会变成「导出引脚表」，代码页给一段说明而不是
一堆看似能编译的注释。

`generic` 刻意不生成初始化调用：宁可在注释里写清「I2C1_SCL 需要 AF4」，也不要生成一段宏名相近
但实际不存在的代码 —— 那种代码能编译过、运行却不对，最难查。

## 器件包与校验

器件包是 JSON，但**不要手改**：每份 JSON 都由脚本从手册表格生成，并有独立的双向校验。

| 系列 | 数据源 | 重建 | 校验 |
| --- | --- | --- | --- |
| CH32L103 | `docs/ch32l103-pin-table.md` | `rebuild_l103_from_ds.py` | `check_l103_pins.py`（1327 条） |
| CH32V407 | `docs/ch32v407-pin-table.md` | `rebuild_v407_from_ds.py` | `check_v407_pins.py`（717 条） |
| HC32F401B | `docs/hc32f401b-pin-table.md`（手册 4.2：端口‑AF 映射） | `rebuild_hc32f401_from_md.py` | 内置自校验：引脚序号连续、**GPIO 数 ≤ 封装引脚数**、信号无引脚 |

加载时会跑 `packs/validate.ts`：结构错误直接拒绝启动并给出**可读报错**（哪个包、哪个字段、为什么），
警告（某个信号没有引脚之类）在 dev 控制台打印。

## 测试

```bash
npm test            # typecheck + 分层检查 + 金样 + 器件组
npm run test:golden # codegen 快照（445 个 case，逐字节比对）
npm run golden:update  # 只在"输出变更是有意的"时用，且提交说明要写清原因
npm run check:layers   # 分层依赖方向
npm run test:rust      # Rust layer1/2 单测（rfr-core，不需要 WebView）
npm run test:ui        # Playwright 端到端（需要 dev server 在 1420）
```

金样测试用 esbuild 把纯 core 打成 ESM 后直接在 Node 里跑，不需要浏览器：

```bash
node scripts/golden.mjs          # 比对
node scripts/golden.mjs --update # 重写快照
```

覆盖策略：每颗器件跑「示例工程 + 全开」，每个系列再挑一颗代表器件跑「逐外设逐模式」。
`backends/wch/codegen.ts` 有 1500 行、34 个 case —— 没有这层保护，重构只能靠肉眼。

## 界面结构

### 启动：欢迎页

打开软件先落在欢迎页，不直接进编辑器 —— 起点比「一个已建好但空的工程」清楚：

```
最近打开（最多 8 条：工程名 / 器件 / 相对时间 / 路径）    开始
                                                   ┌ 新建工程
                                                   ├ 打开工程
                                                   └ 作者 Gitee 主页
```

三个出口都会进编辑器。带 `?dev=` / `?demo=1` / `?picker=1` 的 URL 直接进编辑器 ——
那是深链和自动化测试的入口。

### 编辑器

窗口从上到下四层，和桌面软件的通行布局一致：

```
┌ 文件  关于 ─────────────────────────────────── 26px 菜单栏
├ RiskFiveRuler  器件 …  引脚与外设/时钟树/生成代码/工程设置  打开 保存 生成代码 ── 46px 工具条
│ 侧栏（器件卡片 + 搜索 + 外设树）  配置面板 / 画布
└ SYSCLK … 已用引脚 … 无冲突 ─────────────────── 24px 状态栏
```

**文件菜单**：新建工程（Ctrl+N）· 打开…（Ctrl+O）· 最近打开 ▸ · 保存（Ctrl+S）·
另存为…（Ctrl+Shift+S）· 导出代码目录…（Ctrl+E）。

- **保存 vs 另存为**：已有路径时「保存」直接覆盖、不再弹对话框；「另存为」总是重新选路径。
  新建工程会清掉当前路径，避免下一次「保存」把旧文件覆盖掉。
- **最近打开**是二级菜单，最多 8 条（工程名 + 器件 + 路径），存 `localStorage` ——
  这是本机偏好，不写进工程文件。桌面端路径失效时会提示并从列表里移除；
  浏览器模式没有按路径读文件的能力，只提示换用「打开…」，不会删记录。

**切换器件 = 开新工程。** 外设集合、引脚、复用表全都不同，硬搬过去只会得到一个
「看着有内容、其实一半对不上」的工程。所以换片前先问：`保存并切换` / `不保存，直接切换` / `取消`。
工程没有改动时直接切换，不打扰。

**「保存」按钮右上角的 `•` 表示有未保存的改动**（标题栏提示也会变）。所有改动都经过
一个统一的 `mutate()` 入口打脏标记 —— 散在各处 `setDirty(true)` 一定会漏，漏掉的那处就是
「关窗口没提示、改动丢了」。

**关于菜单**：关于本软件 · 作者 Gitee 主页。

关于本软件弹窗显示 `LoveFinderSeriesNO.967 - RiskFiveRuler` 与版本号。
**版本号 = 年月日 + 当日编译次数**，例如 `26.11.5.3` 表示 2026-11-05 的第 3 次构建：

- 每次 `npm run build` 自动 +1，计数存在 `.build-counter.json`（已 gitignore）。
- `npm run dev` 只读不写，当日还没构建过时显示 `.0`，弹窗里会写「开发模式」而不是「第 0 次构建」。
- Tauri 的 `beforeBuildCommand` 就是 `npm run build`，所以 exe 里的版本号与 `dist` 一致。

## 运行

### 开发（只有这一种模式会用 http://127.0.0.1:1420）

```bash
npm install
npm run tauri:dev    # Tauri + Vite 热更新
# 或只跑前端（保存/导出退化为下载）
npm run dev
```

### 打包便携 exe（无 dev server、无 Node/Electron）

```bash
npm run package:exe
```

产物在仓库根目录：

```
RiskFiveRuler.exe      ← 前端资源已编进二进制，双击即用
WebView2Loader.dll     ← 必须和 exe 放在同一目录
```

这个脚本内部走的是 **`tauri build --no-bundle --features custom-protocol`**，
不是裸 `cargo build`：

- `tauri build` 会注入打包环境变量，把 `dist/` 编进二进制；裸 `cargo build`
  的产物会回落到 `devUrl`，双击是白屏 + 尝试连 `http://127.0.0.1:1420`。
- `src-tauri/src/lib.rs` 里有一条编译期保险：release 没开 `custom-protocol` 直接
  `compile_error!`，不会再产出「能编译、但指向本地 URL」的 exe。

验证运行时到底加载了什么：

```bash
node scripts/package-exe.mjs --skip-build --verify-runtime
#   运行时 URL     http://tauri.localhost/
#   ✓ 界面来自内嵌资源（tauri:// 自定义协议）
```

`http://tauri.localhost/` 是 Tauri 的自定义协议，不是网络请求；exe 里残留的
`127.0.0.1:1420` 字符串只是配置字段，不会被访问。

### 用户电脑上需要什么

- **Windows 10 1803+ / Windows 11**（自带 WebView2 Evergreen Runtime；
  Win11 与装了 Edge 的 Win10 都有）。
- `WebView2Loader.dll` 随 exe 一起分发。
- `api-ms-win-crt-*.dll` 是 Windows 自带的 API set，由系统加载器解析，
  **不需要** VC++ Redistributable；也**不要**给 MinGW 加 `+crt-static`
  （链接能过、加载即崩）。
- 不需要 Node、npm、Electron、.NET。
- NSIS 安装包配置为 `offlineInstaller`，安装时不会联网下载 WebView2；
  如果要做到「连 WebView2 都不依赖系统」，改成 `fixedRuntime` 并随包带
  WebView2 固定版本目录（体积 +100 MB 左右）。

## 目录

```
src/model/           纯类型（器件 / 工程 / 派生视图）
src/engine/          纯函数（时钟、DMA、表达式）
src/semantic/        参数模式库 + 引脚语义（schemas / pinmux）
src/packs/           器件包加载与校验
src/devices/         注册表、WCH 元数据、data/*.json
src/backends/        代码生成（generic / wch/codegen.ts）
src/platform/        宿主能力（io / recent / appInfo）
src/app/             工程默认值、资源汇总、器件筛选
src/ui/              React 组件
src/core/            过渡兼容层（只 re-export）
src-tauri/src/
  layer1_fsio.rs     原子写、路径校验、导出树
  layer1_env.rs      用户数据目录
  layer2_project.rs  工程校验 / 保存 / 读取 / 最近打开
  layer2_export.rs   代码导出
  layer2_app.rs      外部链接 / 应用元信息
  commands.rs        IPC 转发（只调 layer2）
  lib.rs             组装与启动
docs/                器件包格式与设计说明
```

## 设计要点

**参数模式驱动界面。** 界面不认识任何具体外设，它只照着 `schemas.ts` 里的
`ParamDef[]` 渲染。新增一颗芯片或一个外设 = 加一份数据，不改界面代码。
每个参数都带 `hint`（落在哪个寄存器的哪一位）和 `formula`（怎么算出来的），
参数之间的联动用结构化条件（`visibleIf` / `enabledIf` / `disabledIf`）表达，
不用字符串 eval，器件包因此可以纯 JSON 化。

**引脚是唯一真源。** 外设只声明它需要哪些信号（`TX/RX/SCK/CH1…`），
具体落在哪个脚由 `pins` 表决定，冲突由 `pinmux` 统一检测。
引脚视图、状态栏、生成代码读的都是同一份 `collectUsage()` 结果。

**配色规则一眼分清"谁的脚"。** 引脚块的颜色只有两种来源：

- **饱和色** = 被某个外设占用（SPI 橙、USART 蓝、TIM 绿、ADC 粉…），画布右下角的
  图例把当前用到的每一项都列出来（外设名 + 色块），点一行可以跳到那个外设；
- **中性石板色** = 用户自己配的普通 GPIO：推挽输出最亮，开漏次之，输入最深，
  模拟态（复位默认值）不着色 —— 否则整颗片子都是亮的，反而看不出配置过什么。

**点引脚就能配。** 在封装图上左键点任意引脚，菜单贴着光标弹出（右边放不下会自动翻到左侧），
按分组列出这个引脚**全部能配成的模式**：

| 分组 | 内容 |
| --- | --- |
| 复用功能 | `USART1_TX`、`SPI1_SCK`、`I2C1_SDA`、`TIM1_CH1N`、`ADC1_IN4`、`OPA1_P1`、`CMP2_OUT` … 右侧跟一句人话说明；带 `⟲n` 角标的是重映射组 |
| 外部中断 | `EXTI3` 之类。`PXn` 天然对应 `EXTIn`，这条不写在数据手册的复用表里，由加载器按引脚序号补齐 |
| GPIO 模式 | 输入 / 推挽输出 / 开漏输出 / 模拟 |

选一项就直接落到对应外设的配置上（选 `EXTI3` 会把 EXTI 外设打开、第 3 条线设成上升沿、
引脚绑到当前脚），右侧参数面板与生成代码立刻跟着变。拖动画布不会误触发菜单，Esc 或点空白处关闭。

**实时计算。** 改波特率立刻看到 BRR 与误差百分比；改 PSC/ARR 立刻看到周期与占空比；
改时钟树立刻看到 ADCCLK 是否超 14 MHz。计算函数集中在 `clock.ts`，界面只负责显示。

## 调试接口（SDI）

系统组里的「**调试接口**」就是 SDI 的配置页。默认**开启** —— 这是复位后的真实状态，
不是可选项：`SWDIO` / `SWCLK` 两个脚在复位后就归调试口所有，
引脚图上会显示成被 `DBG` 占用，你把它配成别的功能时会立刻报冲突。

| 选项 | 说明 |
| --- | --- |
| 2 线 SDI（SWDIO + SWCLK） | 默认。L103 是 `PA13`/`PA14`，X035/X033 是 `PC18`/`PC19` |
| 1 线 SWIO | 数据手册 1.4.2x 明确这三个系列只有 2 线 SDI，所以**这一项按器件禁用**（灰着，但看得见） |
| 关闭 | 生成 `GPIO_PinRemapConfig(GPIO_Remap_SWJ_Disable, ENABLE)`，两个脚释放成普通 GPIO |

「调试时冻结」是另一组开关：`DBGMCU_IWDG_STOP` / `DBGMCU_WWDG_STOP` /
`DBGMCU_TIMx_STOP` / `DBGMCU_SLEEP|STOP|STANDBY`。
只在你接了调试器并停住程序时生效，不影响脱机运行 —— 单步调 PWM 或看门狗时必须要开，
否则计数值一直在跑、看门狗会把芯片复位掉。

## DMA

DMA 的建模是「**请求**优先」：每台外设声明自己能发出哪些请求，界面只负责挑通道。

| 外设 | 能发出的请求 |
| --- | --- |
| USART / SPI / I2C | `接收 RX`（外设→内存）、`发送 TX`（内存→外设），**两条可同时开** |
| ADC | `转换结果`（固定外设→内存） |
| TIM | `CH1..CH4` / `UP` / `TRIG` / `COM` |

一处配置、两处可见：

- **外设页 →「DMA」**：一行一个请求，选通道 / 模式 / 优先级 / 数据宽度 / 内存自增 / 中断。
  一台外设可以同时占两条通道（SPI 收发各一条），这是旧版单个 `dma` 对象表达不了的。
- **左侧「DMA」**：树节点上直接显示 `已用/总数`（如 `2/8`），点开是全工程汇总 ——
  已用通道数、空闲数、冲突数、8 格通道条、以及每条分配的方向与状态。
  冲突（同一个通道被两个请求占）标红；通道与硬件请求对不上时标黄。

**通道映射按参考手册校验**，三个系列的 `dmaMap` 都是从各自的参考手册逐通道抄的：

| 系列 | 来源 | 例 |
| --- | --- | --- |
| X035 / X033 | CH32X035RM §9.2.3 表 | `SPI1_RX`→Ch2、`SPI1_TX`→Ch3，TIM3 无 DMA 通道 |
| L103 | **CH32L103RM V2.2 §11.2.3 图 11-1** | `SPI1_RX`→Ch2、`USART1_RX`→Ch5、`TIM4_CH1`→Ch1 |
| V407 | *尚未录入*（见 `pending`），只校验通道不重复 | — |

L103 那张表以**图 11-1 的连线**为准 —— 同一页的表格版有跨行合并单元格，
自动抽取会错位；两者交叉核对后一致才写进去。手册里没有 DMA 通道的外设
（如 X035 的 TIM3）根本不会列出 DMA 选项。

## 生成的代码能不能真编译？—— 用真实 EVT 验过

WCH 各系列的标准外设库**不是同一套 API**，这一点在界面上完全看不出来，
只有把代码丢进编译才会暴露。实测差异（对照 `CH32X035EVT` 的头文件）：

| 项目 | CH32X035 / X033 | CH32V407 | CH32V30x / L103 |
| --- | --- | --- | --- |
| 时钟使能函数 | `RCC_APB2PeriphClockCmd` | **`RCC_PB2PeriphClockCmd` / `RCC_PB1…` / `RCC_HB…`** | `RCC_APB2PeriphClockCmd` |
| 时钟宏 | `RCC_APB2Periph_GPIOA` | **`RCC_PB2Periph_GPIOA` / `RCC_HBPeriph_DMA1`** | `RCC_APB2Periph_GPIOA` |
| 系统时钟 | 只有 HSI 48 MHz，**RCC 一共 13 个函数**：没有 PLL/SYSCLK/APB 预分频 | 有 PLL，但 `RCC_PLLMul` **没有 25 这一档**；没有 `RCC_PCLK1_Div*` | `RCC_PLLConfig` / `RCC_SYSCLKConfig`… |
| ADC 时钟 | `ADC_CLKConfig(ADC1, ADC_CLK_Div6)` | `RCC_ADCCLKConfig`（只有 /2 /4 /6 /8） | `RCC_ADCCLKConfig(RCC_PCLK2_Div8)` |
| ADC 采样时间 | `ADC_SampleTime_4Cycles` ~ `_11Cycles` | **`ADC_SampleTime_CyclesMode0..7`** | `ADC_SampleTime_55Cycles5` |
| Flash | 只有 `FLASH_SetLatency` | **两者都没有** | 两者都有 |
| GPIO 速度 | 只有 `GPIO_Speed_50MHz` | **`GPIO_Speed_Low/Medium/High`** | `GPIO_Speed_10MHz` |
| GPIO 开漏 | **没有开漏** | 有 | 有 |
| NVIC | `NVIC_Init` + `Group_0/1` | **只有 CMSIS 的 `NVIC_EnableIRQ` / `NVIC_SetPriority`** | `NVIC_Init` + `Group_0..4` |
| SDK 头文件前缀 | `ch32x035`（X033 也用这个） | `ch32v4x7` | `ch32l103` |
| CRC | **没有独立 CRC 外设** | 有 | 有 |

所以器件包里多了一份 `api` 描述，代码生成按它出码，而不是所有系列共用一套写法：

```json
"api": {
  "clockProfile": "hsi-only",      // full | hsi-only
  "adcClock": "adc",               // rcc | adc
  "flashPrefetch": false,
  "gpioSpeeds": ["50"],
  "gpioOpenDrain": false,
  "nvicGroups": [0, 1],
  "adcSampleTimes": ["4", "5", "...", "11"]
}
```

界面上会跟着变：

| X035 的 ADC 采样时间（4~11 周期） | 引脚菜单：「开漏输出」灰掉并标「无开漏」 |
| --- | --- |
| ![X035 ADC](docs/screenshots/x035-adc.png) | ![X035 引脚菜单](docs/screenshots/x035-pinmenu.png) |

调试接口的「1 线 SWIO」同理（按 `@dev.singleWireDebug` 灰掉）。

### 一条命令验证

```bash
# 拿真实 EVT 头文件逐符号比对 + gcc 语法检查
bash scripts/check_generated.sh "C:/Users/xxx/Downloads/CH32X035EVT" CH32X035C8T6
```

它做三件事：
1. 把该器件「全外设打开」的代码导到临时目录
2. `scripts/check_codegen_api.py` 把生成代码里每个 SDK 符号拿去头文件里找（找不到就是编译错误）
3. 用本机 gcc 对 4 个 `.c` 做 `-fsyntax-only`（只查语法/类型，不产机器码）

**当前结论**（6 个型号全部通过）：

| 系列 | 型号 | 符号比对 | gcc 语法检查 |
| --- | --- | --- | --- |
| CH32X035 | C8T6 | ✅ | ✅ 4/4 |
| CH32X033 | F8P6 | ✅ | ✅ 4/4 |
| CH32V407 | KEU6 / RET6 / WEU6 / VET6 | ✅ | ✅ 4/4 |

`CH32L103` 仍无 EVT 可对照，但它的 DMA 映射表与中断向量表**已经从 CH32L103RM 补录**
（见下节），所以 DMA 通道现在也是按手册校验的。
**L103 还没有** EVT 可对照（本地只有 X035 的），已写进器件包 `pending`；
因此它那几个未验证的能力（比如 Flash 预取）按「宁可不生成」处理 —— 少一句是功能缺失，
多一句不存在的函数是编译错误。

### 还没生成初始化的外设

`OPA` / `CMP` / `USB` / `PIOC` 只生成**时钟使能 + TODO 注释**（写明该看哪个寄存器、参考哪个例程）。
原因：它们的通道选择是系列专属枚举（`OPA_InitTypeDef.PSEL = CHP0`、`CMP_CHP2`…），
猜错会静默配出错误的模拟参数 —— 这比明确留 TODO 危险得多。

## 支持的型号

| 系列 | 型号 | 封装 | 器件包 | 代码生成已验证 |
| --- | --- | --- | --- | --- |
| CH32V407 | KEU6 / RET6 / WEU6 / VET6 | QFN32 / LQFP64 / QFN68 / LQFP100 | `ch32v407.json` | ✅ 4 个封装全过 |
| CH32X035 | R8T6 / C8T6 / G8U6 / G8R6 / F8U6 / F7P6 / D8U6 | 见封装表 | `ch32x035.json` | ✅ C8T6 已验 |
| CH32X033 | F8P6 | TSSOP20 | `ch32x033.json` | ✅ 已验 |
| CH32L103 | K8U6 / K8U7 等 | 见封装表 | `ch32l103.json` | ⚠ 无 EVT，未做编译验证 |

V407 的器件包由 `scripts/extract/gen_v407.py` 从数据手册表 2-1-1 + EVT 头文件生成，
引脚号在 4 个封装上都连续（32 / 64 / 68 / 100）；单实例外设的 AF 名（`I2C_SCL`、`CAN_TX`）
会自动补成带编号的实例名（`I2C1_SCL`、`CAN1_TX`），否则会生成不存在的时钟宏。

## 导出：MounRiver Studio 工程

工程设置 → 工具链选 **MounRiver Studio 工程**，「生成代码」会导出一个可以直接 Import 的 MRS 项目：

```
<工程名>/
├── .project / .cproject / .template     Eclipse/MRS 工程描述（模板取自 WCH 官方 EVT）
├── User/main.c                          MRS 例程风格：debug.h + Delay_Init + printf
├── User/rfr_pinmap.h · rfr_init.c/h     引脚宏与外设初始化
├── User/ch32xxx_it.c/h                  中断服务函数骨架（按启用的 NVIC 向量生成）
├── User/ch32xxx_conf.h                  库配置头（系列特有外设头用 __has_include 兜底）
├── User/system_ch32xxx.c/h              SystemCoreClock（时钟本体在 RFR_ClockInit 里配）
└── README.md
```

把整个文件夹放进 WCH 官方 EVT 的 `EXAM/` 目录（和 `GPIO_Toggle` 平级），
MRS → Import → Existing Projects into Workspace 即可。`Core / Startup / Ld /
Peripheral / Debug` 五个目录通过 linkedResources 指向 `../SRC/` 下的公共代码，
和官方例程同一套引用方式，不用拷贝 SDK。

> `.wvproj` 是 WCH 加密的调试配置文件，MRS 首次保存工程时会自己生成，导出里没有。

选 **Makefile** 则导出 `Core/Inc + Core/Src + Makefile` 的经典布局。

## 器件包数据说明

引脚号（`num` ↔ 端口名）已经和数据手册的引脚定义表逐脚核对过，
每个封装的脚数都与封装名一致（LQFP48 = 48、QFN20 = 20、TSSOP20 = 20 …）。

**复用功能表**是从 PDF 自动提取的（`scripts/extract/`），
个别引脚可能漏项或混入相邻引脚的信号。要拿到权威数据，
按 [docs/llm-pin-extraction-prompt.md](docs/llm-pin-extraction-prompt.md)
把提示词连同 DS0 / RM 一起交给外部大模型，把返回的 JSON 覆盖
`src/devices/data/*.json` 即可，不用改任何代码。

「工程设置 → 器件包校对」会列出当前器件包还没核对的条目。
器件包格式见 [docs/device-pack.md](docs/device-pack.md)。

## 冒烟测试

```bash
npm run dev                  # 另开一个终端
node scripts/ui-smoke.mjs    # 用本机 Edge，不下载额外浏览器
```

覆盖：`core/` 只 re-export → 欢迎页 → 深链编辑器 → 明暗切换实时重绘 →
引脚菜单选 EXTI → 生成代码出现 `GPIO_EXTILineConfig` / `EXTI_LineN` →
器件选择器（`.modal-dialog` / `.chip` / 资源表）→ 参数页签与引脚自动分配 →
`devices/` `backends/` `semantic/` 可独立 import → 无页面异常。

Rust 侧另有一组不依赖 WebView 的单测（路径穿越、原子写、导出树、URL 校验）：

```bash
npm run test:rust
```

## 提取脚本

```bash
# 1. PDF -> 文本（layout 模式保留列位置）
python scripts/extract/pdftable_xy.py <pdf> <起始页> <结束页> <封装列数> <封装id,...> <out.json>

# 2. 两路解析结果合并 + 生成器件包
python scripts/extract/gen_packs.py <临时目录> src/devices/data
```
