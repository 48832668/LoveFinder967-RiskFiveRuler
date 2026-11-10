# 去耦计划（Decoupling Plan）

> **状态（2026-11-10）**：本文是 2026-11-03 的评估与计划。§3.1（pinmux 拆分）、
> §3.4（App 业务逻辑下沉）以及「三层目录落地」已完成，最终形态与边界见
> [`docs/ARCHITECTURE_LAYERS.md`](docs/ARCHITECTURE_LAYERS.md)。
> 下面保留原始评估，方便对照「当时为什么这么切」。
>
> 记录时间：2026-11-03　代码基线：`src/` 5.7k 行左右。

---

## 1. 现状模块图

```
                     ┌──────────── ui/ ────────────┐
                     │ App  ConfigPanel  PinoutView │
                     │ Tree  ClockPanel  CodePanel  │
                     │ ProjectPanel  DevicePicker   │
                     └───┬────────┬────────┬────────┘
                         │        │        │
             ┌───────────▼──┐ ┌───▼────┐ ┌─▼────────────┐
             │ core/pinmux  │ │schemas │ │ core/codegen │
             │ core/clock   │ │(纯数据)│ │ core/io      │
             └───┬──────────┘ └────────┘ └─┬────────────┘
                 │                         │
        ┌────────▼─────────────────────────▼────────┐
        │ core/types.ts（数据模型，无依赖，最干净） │
        │ core/devices/{index,wch,data/*.json}      │
        └───────────────────────────────────────────┘
```

依赖方向总体是健康的：`types → schemas/pinmux → codegen → ui`。
没有循环依赖（`pinmux → schemas` 是唯一一条"向下再向上"的边，见 §3.1）。

## 2. 已经做得不错的部分

| 决策 | 收益 |
| --- | --- |
| 器件包是纯 JSON + `wch.ts` 查表补元数据 | 加芯片不动 UI，提示词/外部 LLM 可以直接产出 JSON |
| UI 完全由 `PeripheralSchema` 驱动 | `ConfigPanel` 不含任何具体外设知识 |
| `Cond` 是结构化表达式而不是字符串 eval | 器件包可移植、可校验 |
| `collectUsage()` 是引脚占用的唯一真源 | 引脚图 / 状态栏 / 代码生成读同一份数据 |
| `templates/mrs/*.xml?raw` 单独放模板 | 生成器里没有 25 KB 的 XML 字符串 |

## 3. 耦合热点（按收益排序）

### 3.1 `pinmux.ts` 职责过多 ★ 最值得做

现在它同时承担 5 件事：配色（`KIND_COLORS` / `GPIO_MODE_COLORS`）、
信号-引脚查询（`pinsForSignal`）、可用性判定（`peripheralUsable`）、
占用/冲突（`collectUsage` / `findConflicts`）、**分配规划**（`planPins` / `planEnable`）。
而且它 `import { schemaFor } from "./schemas"`，是 core 里唯一一条
"工具层依赖数据定义层"的边。

**计划**
- 拆出 `core/colors.ts`（`KIND_COLORS`、`GPIO_MODE_COLORS`、`colorOf`、`gpioColorOf`）。
- 拆出 `core/assign.ts`（`planPins`、`planEnable`、`signalsForMode`、`autoPickPin`），
  让它显式依赖 `schemas` —— 职责清楚了，那条边也从"隐藏"变"显式"。
- `pinmux.ts` 只留查询与判定：`pinsForSignal` / `signalsOnPin` / `signalAvailable`
  / `missingSignals` / `peripheralUsable` / `collectUsage` / `findConflicts` / `requiredSignals`。

**风险**：低。纯移动 + 改 import，测试用 `scripts/ui-smoke.mjs` 兜底。
**工作量**：半天。

### 3.2 `codegen.ts` 是一个 1000 行的单体

`genPinmap / genInitSource / genPeripheralInit / genMain / genConfHeader / genItSource
/ genSystemSource / genMakefile / genMrsTemplate / genReadme` 全在一个文件里，
`genPeripheralInit` 内部又是一个 14 分支的 switch，每个分支自己拼 GPIO/时钟宏。

**计划**
- 目录化：`core/gen/`
  ```
  core/gen/
    index.ts        generate() 入口 + 布局选择（mrs / core）
    pinmap.ts       rfr_pinmap.h
    init.ts         RFR_ClockInit / RFR_GPIOInit / RFR_NVICInit 的骨架
    periph/         每类外设一个文件：usart.ts spi.ts i2c.ts tim.ts adc.ts
                    clk.ts exti.ts watchdog.ts ...
    mrs.ts          .project / .cproject / .template
    makefile.ts     Makefile
    readme.ts       README.md
  ```
- `periph/*` 统一签名 `(ctx: GenCtx, cfg: PeripheralConfig) => string[]`，
  `GenCtx` 提供 `clk` / `dev` / `portOf` / `pinOf` / `apb2Expr` / `gpioSetup`
  这些现在靠闭包共享的东西。新增外设 = 新增一个文件 + 注册一行。
- 顺着把 `apb2Expr` 的 APB1/APB2 总线归属做成数据（外设 → 总线表），
  而不是每个分支手写 `RCC_APB1PeriphClockCmd` 还是 `RCC_APB2PeriphClockCmd`。

**风险**：中。生成文本必须逐字节不变，建议先加"生成快照"测试再动。
**工作量**：2 天。

### 3.3 生成代码缺一层"抽象后端"

`genPeripheralInit` 直接输出 WCH 标准库调用。要支持寄存器级（`settings.sdk === "bare"`
目前是个没有实现的选项）或别的 SDK，就得再写一个 14 分支的 switch。

**计划**：把 §3.2 的 `periph/*` 产出改成**中间表示**（例如
`[{ op: "clock", bus: "apb2", target: "GPIOA" }, { op: "gpio-init", pin: "PA9", mode: "AF_PP" }, ...]`），
再由 `backend/stdlib.ts` 或 `backend/bare.ts` 渲染成文本。
在出现第二个后端之前**不要做** —— 现在引入 IR 是过度设计，先在计划里占位。

**工作量**：3–5 天，且只有真的要支持第二种 SDK 时才值得。

### 3.4 `App.tsx` 既是状态容器又是业务逻辑

`assignPin` 里有 60 行业务规则（通道判定、模式顺延、必需信号补全），
和 React 状态更新搅在一起；`switchDevice` 里还有一段重复调用 `retarget` 的补偿逻辑。

**计划**
- `core/assign.ts`（§3.1）提供 `assignPinToPeripheral(project, dev, pin, fn): Project`，
  返回**新对象**。`App.assignPin` 退化为 `setProject(prev => assignPinToPeripheral(prev, dev, pin, fn))`
  加一行 `setSelected`。
- `switchDevice` 的"丢了几个引脚"统计改成在 `retarget()` 里返回
  `{ project, dropped }`，别在组件里重算一遍。

**风险**：低。不可变更新本来就是现在的写法。
**工作量**：半天。

### 3.5 小问题清单

| 问题 | 位置 | 处理 |
| --- | --- | --- |
| ` PeripheralKind` 里 `FLASH` 已无人使用 | `types.ts` | 下次动 types 时删掉 |
| `colorOf` 被 UI 和 codegen 双向 import | `pinmux.ts` | §3.1 拆出后消失 |
| `emptyConfig` / `defaultParams` 分属 project / schemas | 两边 | 合并到 `schemas.ts` |
| `ConfigPanel` 里 `DmaTab` 的 DMA 通道数写死 7 | `DmaTab` | 用 `dev.dmaChannels` |
| `seriesOf` / `SERIES` 与 `PACK_CATALOG` 概念重复 | `devices/index.ts` | 只留 `SERIES` |
| `io.ts` 的浏览器降级路径没有测过子目录 | `io.ts` | 加一条冒烟断言 |
| `_shots/`、`s1.mjs` 等调试残留进了仓库根目录 | 根目录 | 移进 `scripts/` 或忽略 |

## 4. 建议的执行顺序

1. **§3.1** + **§3.4**（半天，纯移动，立刻让 `App.tsx` 从 380 行降到 ~250 行）
2. 加"生成快照"测试（把 demo 工程的输出固化成 golden 文件）
3. **§3.2** 目录化 codegen（2 天，有快照兜底）
4. §3.5 小问题顺手清
5. §3.3 —— **挂起**，等真的需要第二个代码后端

## 5. 不做的事

- 不引入状态管理库（Redux/Zustand）。现在只有一个 `project` 状态，
  `useState` + 不可变更新足够，加库是负收益。
- 不把 `schemas.ts` 拆成每外设一个文件。它是"数据字典"，
  1100 行放一起反而方便横向对比各外设的参数建模。
- 不给 `types.ts` 引入 zod / 运行时校验。器件包是构建期导入的静态 JSON，
  构建即校验；运行时校验只有在外部 LLM 直接喂 JSON 时才需要，
  那条链路应该在校验脚本里做，而不是打进运行时。
