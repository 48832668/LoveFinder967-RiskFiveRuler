/**
 * 通用后端（generic）—— 给「刚接入、还没有代码生成器」的厂商用。
 *
 * 它**不假装能生成初始化代码**。产出两样东西：
 *   1. `rfr_pinmap.h`：完整的引脚映射表，含每个信号用的复用组编号（AF n）。
 *      这份表是手工移植到任何 SDK 都需要的，本身就有价值；
 *   2. `rfr_init.c`：按外设列出的 TODO 清单，标出每个外设该配哪些寄存器/函数，
 *      但**不写**具体宏名 —— 写错宏名比留 TODO 危险得多。
 *
 * 等某个厂商的后端就位（`backends/<vendor>/`），把它的 `id` 写进器件包即可切换。
 */

import type { DeviceDef, Project } from "../model/types";
import { solveClock } from "../engine/clock";
import { collectUsage } from "../semantic/pinmux";
import { schemaFor } from "../semantic/schemas";
import type { CodegenBackend, GenFile } from "./types";

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 复用编号的人话说明，按厂商语义区分 */
function describeAf(dev: DeviceDef, af: number): string {
  if (af === 0) return "默认功能 / 模拟";
  return dev.afGrouping === "grouped" ? `重映射组 ${af}` : `AF${af}`;
}

function guard(project: Project): string {
  // 工程名本身就带 RFR_ 前缀时不要再叠一层
  const n = (project.settings.name || "PROJECT").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  return n.startsWith("RFR_") ? n : `RFR_${n}`;
}

/** 引脚映射表：每个引脚一行，列出分配到的信号与它需要的复用组 */
function pinmapH(project: Project, dev: DeviceDef): string {
  const usage = collectUsage(project, dev);
  const L: string[] = [];
  const g = guard(project);

  L.push(`/* ${project.settings.name} — 引脚映射表`);
  L.push(` * 器件：${dev.family} / ${dev.id}（${dev.package.label}）`);
  L.push(` * 厂商：${dev.vendor}    内核：${dev.core}`);
  L.push(` * 生成器：generic（该厂商还没有专用后端，只有引脚表与 TODO）`);
  L.push(` * 生成时间：${stamp()}`);
  L.push(` */`);
  L.push(`#ifndef ${g}_PINMAP_H`);
  L.push(`#define ${g}_PINMAP_H`);
  L.push(``);
  if (dev.afGrouping === "grouped") {
    L.push(`/* 每条宏的值 = 该引脚这个信号需要选的重映射组（厂商手册的 AFIO / PCFR）。`);
    L.push(` * 同一外设的所有信号**必须在同一组**（WCH 的重映射是整组切换）。`);
    L.push(` * 0 表示默认功能，不需要配置重映射寄存器。 */`);
  } else {
    L.push(`/* 每条宏的值 = 该引脚要选择的复用功能编号（AFn，逐引脚独立配置）。`);
    L.push(` * 同一外设的各信号**可以落在不同 AF 上**，硬件不要求同组；`);
    L.push(` * 0 表示默认功能 / 模拟通道，不需要配置复用寄存器。 */`);
  }
  L.push(``);

  const byPin = new Map<string, typeof usage>();
  for (const u of usage) {
    const arr = byPin.get(u.pin) ?? [];
    arr.push(u);
    byPin.set(u.pin, arr);
  }

  for (const pin of dev.package.pins) {
    const uses = byPin.get(pin.name);
    if (!uses?.length) continue;
    for (const u of uses) {
      const af = Number(u.remap ?? 0) > 0 ? Number(u.remap) : 0;
      // 宏名用完整的 `外设_信号`，不能只用信号短名 ——
      // 同一根脚上可能同时挂着 USART1_TX 和 UART5_TX，短名会撞成两个同名宏。
      // 宏的值 = 该脚这个信号要选的复用编号，0 = 默认功能 / 模拟，不用动寄存器。
      L.push(
        `#define ${g}_${pin.name}_${u.fn}`.padEnd(52) +
          ` ${af}u  /* ${describeAf(dev, af)} */`,
      );
    }
  }

  L.push(``);
  L.push(`/* ── 未分配的必需信号（启用但缺引脚，会编译不过，先在这里暴露出来）── */`);
  for (const per of dev.peripherals) {
    const cfg = project.configs[per.id];
    if (!cfg?.enabled) continue;
    const missing = per.signals.filter((s) => s.required && !cfg.pins[s.name] && !cfg.channels?.[s.name]?.pin);
    if (missing.length) {
      L.push(`/* ! ${per.id} 缺少 ${missing.map((s) => s.name).join(", ")} */`);
    }
  }
  L.push(``);
  L.push(`#endif`);
  return L.join("\n") + "\n";
}

/** 初始化骨架：按外设列 TODO，不编造宏名 */
function initC(project: Project, dev: DeviceDef): string {
  const L: string[] = [];
  const clk = solveClock(dev.clock, project.clock);

  L.push(`/* ${project.settings.name} — 外设初始化骨架（TODO 清单）`);
  L.push(` * 器件：${dev.id}    厂商：${dev.vendor}`);
  L.push(` *`);
  L.push(` * 该厂商还没有专用代码生成后端，所以本文件**不含**可直接编译的初始化代码；`);
  L.push(` * 每个外设下面列出了「按当前配置，初始化时必须做的事」。`);
  L.push(` * 请对照厂商 SDK（${dev.sdkHeader ?? "?"}.h 等）把 TODO 换成实际调用。`);
  L.push(` *`);
  L.push(` * 引脚映射见 rfr_pinmap.h —— 那份表是完整的，可以直接照抄。`);
  L.push(` * 生成时间：${stamp()}`);
  L.push(` */`);
  L.push(``);
  L.push(`#include "rfr_pinmap.h"`);
  L.push(`#include "${dev.sdkHeader ?? "device"}.h"`);
  L.push(``);
  L.push(`void RFR_Init(void)`);
  L.push(`{`);

  L.push(`    /* ── 时钟：SYSCLK ${clk.sysclk} MHz（来源 ${project.clock.sysclkSource}），HCLK ${clk.hclk} MHz，PCLK1 ${clk.pclk1} MHz，PCLK2 ${clk.pclk2} MHz ── */`);
  L.push(`    /* TODO: 按厂商 DDL 配置 PLL 与总线分频 */`);
  L.push(``);

  const enabled = dev.peripherals.filter((p) => project.configs[p.id]?.enabled && p.kind !== "GPIO");

  // 先列复用配置：这是最容易漏、且漏了之后现象最莫名其妙的一步
  const relocations = collectUsage(project, dev).filter((u) => Number(u.remap ?? 0) > 0);
  if (relocations.length) {
    L.push(
      dev.afGrouping === "grouped"
        ? `    /* ── 复用功能：下列信号不在默认功能上，须把 AFIO 重映射整体切到对应组 ── */`
        : `    /* ── 复用功能：下列引脚须逐个配置 AF 编号（逐引脚独立，无组约束）── */`,
    );
    const bySignal = new Map<string, typeof relocations[number][]>();
    for (const u of relocations) {
      const arr = bySignal.get(u.fn) ?? [];
      arr.push(u);
      bySignal.set(u.fn, arr);
    }
    for (const [fn, list] of bySignal) {
      const u = list[0];
      L.push(
        `    /* TODO: ${fn.padEnd(16)} → ${u.pin}  ${describeAf(dev, Number(u.remap))} */`,
      );
    }
    L.push(``);
  }

  for (const per of enabled) {
    const cfg = project.configs[per.id];
    const schema = schemaFor(per.schema);
    const pins = Object.entries(cfg.pins ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`);
    for (const [k, ch] of Object.entries(cfg.channels ?? {})) {
      if (ch.enabled && ch.pin) pins.push(`${k}=${ch.pin}`);
    }
    L.push(`    /* ── ${per.id}（${per.label}）${schema ? ` schema=${per.schema}` : ""} ── */`);
    if (pins.length) L.push(`    /* 引脚：${pins.join("  ")} */`);
    const params = Object.entries(cfg.params ?? {})
      .filter(([, v]) => v !== "" && v !== false)
      .map(([k, v]) => `${k}=${v}`);
    if (params.length) L.push(`    /* 参数：${params.join("  ")} */`);
    L.push(`    /* TODO: 使能 ${per.id} 时钟 → 配置 GPIO 复用 → 初始化外设 → 按需开中断/DMA */`);
    L.push(``);
  }

  L.push(`}`);
  L.push(``);
  return L.join("\n") + "\n";
}

function readme(project: Project, dev: DeviceDef): string {
  const L: string[] = [];
  L.push(`# ${project.settings.name}`);
  L.push(``);
  L.push(`由 RiskFiveRuler 生成，器件 **${dev.family} / ${dev.id}**（${dev.package.label}，${dev.vendor}）。`);
  L.push(``);
  L.push(`## 注意：这个器件还没有专用的代码生成后端`);
  L.push(``);
  L.push(`本目录只有：`);
  L.push(``);
  L.push(`- \`rfr_pinmap.h\` —— **完整可用**的引脚映射表（含复用组编号）；`);
  L.push(`- \`rfr_init.c\` —— 按当前配置列出的 TODO 清单，不含可直接编译的初始化代码。`);
  L.push(``);
  L.push(`这样处理是刻意的：宁可在 TODO 里写清楚「要配 AF4 才能把 I2C1_SCL 落到 PA2」，`);
  L.push(`也不要生成一段宏名相近但实际不存在的代码 —— 那种代码会编译过、运行错，最难查。`);
  L.push(``);
  L.push(`## 移植步骤`);
  L.push(``);
  L.push(`1. 按 \`rfr_pinmap.h\` 配置每个引脚的复用编号；`);
  L.push(`2. 照着 \`rfr_init.c\` 的 TODO 逐个外设补初始化；`);
  L.push(`3. 若本仓库已提供该厂商的后端（\`src/backends/\`），把器件包的 \`backend\` 字段指向它即可重新生成。`);
  L.push(``);
  return L.join("\n") + "\n";
}

/**
 * 只生成引脚映射表。
 *
 * 资料不足的器件（`codegenEnabled = false`）禁止生成初始化代码，但引脚表是纯数据、
 * 不含任何厂商寄存器假设 —— 手工移植到任何 SDK 都要用它，所以单独留一个出口。
 */
export function pinmapOnly(project: Project, dev: DeviceDef): GenFile[] {
  return [{ path: "rfr_pinmap.h", lang: "h", content: pinmapH(project, dev) }];
}

export const genericBackend: CodegenBackend = {
  id: "generic",
  label: "通用（仅引脚表 + TODO）",
  complete: false,
  emit(project: Project, dev: DeviceDef): GenFile[] {
    return [
      { path: "rfr_pinmap.h", lang: "h", content: pinmapH(project, dev) },
      { path: "rfr_init.c", lang: "c", content: initC(project, dev) },
      { path: "README.md", lang: "md", content: readme(project, dev) },
    ];
  },
};
