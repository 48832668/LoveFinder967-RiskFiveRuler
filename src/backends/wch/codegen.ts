import type { ApiProfile, DeviceDef, PeripheralConfig, Project } from "../../model/types";
import { solveClock, timBase, usartBrr } from "../../engine/clock";
import { collectUsage, colorOf, requiredSignals } from "../../semantic/pinmux";
import { schemaFor } from "../../semantic/schemas";
import { sdkHeaderOf } from "../../devices/index";
import { dmaRef } from "../../engine/dma";
import cprojectTpl from "./templates/mrs/cproject.xml?raw";
import { mculibFilesFor } from "../../mculib/index";
import projectTpl from "./templates/mrs/project.xml?raw";

/**
 * 代码生成。
 *
 * 输出的是「WCH 官方 SDK 风格」的工程骨架：使用 ch32xxx.h 里的标准外设库 API，
 * 中断向量与启动文件沿用 SDK。每个 Init 函数都带一行寄存器注释，方便对着手册复核。
 *
 * 两种导出布局（按工程设置里的 toolchain 选择）：
 *   mrs  —— MounRiver Studio 工程，结构对齐 WCH EVT 的 EXAM 例程：
 *           `.project` / `.cproject` / `.template` + `User/`，
 *           Core / Startup / Ld / Peripheral / Debug 是**工程内实体目录**
 *           （内容由 `generateWithLib` 从 src/mculib 写入）——
 *           导出的单个目录在 MRS 里 Import 即用。
 *   core —— 纯源码树 Core/Inc + Core/Src，配 Makefile；库文件落在 SDK/ 前缀下
 *           （Makefile 里的 -ISDK/... 与之一致）。
 */

export interface GenFile {
  path: string;
  content: string;
  lang: "c" | "h" | "make" | "md" | "ld" | "xml" | "txt";
}

const PORT_ALIAS: Record<string, string> = {
  PA: "GPIOA",
  PB: "GPIOB",
  PC: "GPIOC",
  PD: "GPIOD",
  PE: "GPIOE",
};

export function portOf(pin: string): string {
  return PORT_ALIAS[pin.slice(0, 2)] ?? "GPIOA";
}

export function pinOf(pin: string): string {
  return `GPIO_Pin_${pin.slice(2)}`;
}

function hex(v: number): string {
  return `0x${v.toString(16).toUpperCase()}`;
}

/**
 * 本系列的 SDK 能力。器件包没写 `api` 时按最保守的「和 V30x 一样」处理 ——
 * 但 `check_codegen_api.py` 会拿真实 EVT 头文件把这些假设逐条验掉。
 */
function apiOf(dev: DeviceDef): ApiProfile {
  return (
    dev.api ?? {
      clockProfile: "full",
      clockApi: "apb",
      nvicApi: "stdlib",
      gpioSpeedStyle: "mhz",
      adcSampleStyle: "cycles5",
      flashLatency: true,
      adcClock: "rcc",
      flashPrefetch: true,
      gpioSpeeds: ["2", "10", "50"],
      gpioOpenDrain: true,
      nvicGroups: [0, 1, 2, 3, 4],
      adcSampleTimes: ["1.5", "7.5", "13.5", "28.5", "41.5", "55.5", "71.5", "239.5"],
    }
  );
}

/**
 * 把想要的速度映射到本系列真实存在的枚举。
 *
 * 两套写法：
 *   mhz   → `GPIO_Speed_10MHz`（X035 只有 50MHz 一档）
 *   level → `GPIO_Speed_Low/Medium/High`（V407）
 * 引用名（`2`/`10`/`50`）不变，只是渲染成不同的宏。
 */
function gpioSpeedMacro(api: ApiProfile, want: string): string {
  if ((api.gpioSpeedStyle ?? "mhz") === "level") {
    const n = Number(want);
    const lvl = n <= 2 ? "Low" : n <= 25 ? "Medium" : "High";
    return `GPIO_Speed_${lvl}`;
  }
  const speeds = api.gpioSpeeds;
  if (speeds.includes(want)) return `GPIO_Speed_${want}MHz`;
  const up = speeds.map(Number).filter((n) => n >= Number(want)).sort((a, b) => a - b)[0];
  const pick = up ?? Math.max(...speeds.map(Number));
  return `GPIO_Speed_${pick}MHz`;
}

/**
 * 把界面上选的采样时间映射成本系列的真实宏。
 *
 * V30x 是「1.5 / 55.5 …Cycles5」，X035 是「4 ~ 11 Cycles」整数周期 ——
 * 两套名字毫无交集，硬套就是编译错误。
 */
function sampleTimeMacroOf(api: ApiProfile, value: string): string {
  const style = api.adcSampleStyle ?? "cycles5";
  const legal = api.adcSampleTimes.length ? api.adcSampleTimes : ["55.5"];
  const render = (v: string) => {
    if (style === "cyclesmode") {
      // V407 的取值本身就是 CyclesMode0..7；L103 存的是「1.5 / 7.5 …周期」，
      // 宏名却同样是 CyclesModeN —— 按它在档位表里的序号换算，别把 1.5 拼进宏名
      if (/^CyclesMode\d+$/.test(v)) return `ADC_SampleTime_${v}`;
      const idx = legal.indexOf(v);
      return `ADC_SampleTime_CyclesMode${idx < 0 ? 0 : idx}`;
    }
    if (style === "cycles") return `ADC_SampleTime_${v}Cycles`; // X035: 4..11
    return `ADC_SampleTime_${v.replace(".5", "")}Cycles5`;      // V30x: 55Cycles5
  };
  if (legal.includes(value)) return render(value);
  // 不在可选集合里 → 取最接近的一档（CyclesMode 这类不是数字，直接取第一项）
  if (style === "cyclesmode") return render(legal[0]!);
  const want = Number(value);
  const near = legal
    .map((v) => ({ v, d: Math.abs(Number(v) - want) }))
    .sort((a, b) => a.d - b.d)[0]!.v;
  return render(near);
}

/** X035 的 ADC 时钟分频是 ADC_CLK_DivN（不是 RCC_PCLK2_DivN） */
function adcDivMacro(div: number): string {
  return `ADC_CLK_Div${div}`;
}

export function generate(project: Project, dev: DeviceDef): GenFile[] {
  const files: GenFile[] = [];
  const clk = solveClock(dev.clock, project.clock);
  const usage = collectUsage(project, dev);
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  // SDK 头文件名：优先用器件包里的 sdkHeader（X033 与 X035 共用 ch32x035.h），
  // 没写才按系列名推（CH32L103 → ch32l103.h）
  const hdr = sdkHeaderOf(dev);
  const mrs = project.settings.toolchain === "mrs";

  files.push({ path: userPath(mrs, `rfr_pinmap.h`), lang: "h", content: genPinmap(project, dev, usage, hdr) });
  files.push({ path: userPath(mrs, `rfr_init.h`), lang: "h", content: genInitHeader(project, dev, hdr) });
  files.push({ path: userPath(mrs, `rfr_init.c`), lang: "c", content: genInitSource(project, dev, clk, hdr) });
  files.push({ path: userPath(mrs, `main.c`), lang: "c", content: genMain(project, dev, stamp, hdr, mrs) });
  files.push({ path: userPath(mrs, `${hdr}_conf.h`), lang: "h", content: genConfHeader(dev, hdr) });
  files.push({ path: userPath(mrs, `${hdr}_it.h`), lang: "h", content: genItHeader(project, dev, hdr) });
  files.push({ path: userPath(mrs, `${hdr}_it.c`), lang: "c", content: genItSource(project, dev, hdr) });
  files.push({ path: userPath(mrs, `system_${hdr}.h`), lang: "h", content: genSystemHeader(hdr) });
  files.push({ path: userPath(mrs, `system_${hdr}.c`), lang: "c", content: genSystemSource(project, dev, clk, hdr) });

  if (mrs) {
    const name = mrsProjectName(project);
    files.push({ path: ".project", lang: "xml", content: projectTpl.replaceAll("__PROJECT__", name) });
    files.push({ path: ".cproject", lang: "xml", content: cprojectTpl.replaceAll("__PROJECT__", name) });
    files.push({ path: ".template", lang: "txt", content: genMrsTemplate(project, dev, name) });
  } else if (project.settings.toolchain === "make") {
    files.push({ path: "Makefile", lang: "make", content: genMakefile(project, dev, hdr) });
  }
  files.push({ path: "README.md", lang: "md", content: genReadme(project, dev, clk, mrs) });
  return files;
}

/**
 * 生成 + EVT 标准外设库（自包含可编译工程）。
 *
 * 库文件按工具链落位：
 *   - MRS：工程根下的 Core / Debug / Ld / Peripheral / Startup（.project 里是
 *     实体目录，不再是 EVT 的 PARENT-2 链接 —— 导出的工程单个目录即可 Import）；
 *   - Make：SDK/ 前缀（与 Makefile 里的 -ISDK/... / SDK/Ld/Link.ld 一致）。
 * `includeLib` 由宿主决定（浏览器演示环境不掺 200 个库文件）。
 * HC32 没有官方库（codegen=disable），走不到这里。
 */
export async function generateWithLib(
  project: Project,
  dev: DeviceDef,
  includeLib: boolean,
): Promise<GenFile[]> {
  const files = generate(project, dev);
  if (!includeLib || project.settings.toolchain !== "mrs") {
    if (includeLib && project.settings.toolchain === "make") {
      const lib = await mculibFilesFor(sdkHeaderOf(dev));
      return [...files, ...lib.map((f) => ({ path: `SDK/${f.path}`, content: f.content, lang: "c" as const }))];
    }
    return files;
  }
  const lib = await mculibFilesFor(sdkHeaderOf(dev));
  return [
    ...files,
    ...lib.map((f) => ({
      path: f.path,
      content: f.content,
      lang: (f.path.endsWith(".h") || f.path.endsWith(".c")
        ? "c"
        : f.path.endsWith(".ld")
          ? "ld"
          : "txt") as GenFile["lang"],
    })),
  ];
}

/** MRS 布局的源码一律放进 User/；Core 布局下头文件进 Core/Inc、其余进 Core/Src */
function userPath(mrs: boolean, file: string): string {
  if (mrs) return `User/${file}`;
  return file === "rfr_pinmap.h" || file === "rfr_init.h" ? `Core/Inc/${file}` : `Core/Src/${file}`;
}

/** MRS 工程名只允许字母数字下划线（Eclipse 约束），非法字符替换成下划线 */
export function mrsProjectName(project: Project): string {
  const n = (project.settings.name || "RFR_Project").trim();
  return sanitize(n).replace(/^_+/, "") || "RFR_Project";
}

/* ───────────────────────────── pinmap.h ───────────────────────────── */

function genPinmap(project: Project, dev: DeviceDef, usage: ReturnType<typeof collectUsage>, hdr: string): string {
  const L: string[] = [];
  L.push(`/* ${project.settings.name} — 引脚映射表`);
  L.push(` * 器件: ${dev.id} (${dev.family}, ${dev.core})`);
  L.push(` * 由 RiskFiveRuler 自动生成，请勿手工修改；改动请在工具里做。`);
  L.push(` */`);
  L.push(`#ifndef __RFR_PINMAP_H`);
  L.push(`#define __RFR_PINMAP_H`);
  L.push(``);
  L.push(`#include "${hdr}.h"`);
  L.push(``);

  const byPort = new Map<string, typeof usage>();
  for (const u of usage) {
    const port = portOf(u.pin);
    const arr = byPort.get(port) ?? [];
    arr.push(u);
    byPort.set(port, arr);
  }

  for (const port of [...byPort.keys()].sort()) {
    L.push(`/* ── ${port} ── */`);
    for (const u of byPort.get(port)!) {
      const label = project.pinLabels[u.pin] || u.fn;
      const macro = `${sanitize(label).toUpperCase()}_PIN`;
      const portMacro = `${sanitize(label).toUpperCase()}_PORT`;
      L.push(`#define ${macro.padEnd(26)} ${pinOf(u.pin)}   /* ${u.pin} ← ${u.fn} */`);
      L.push(`#define ${portMacro.padEnd(26)} ${port}`);
    }
    L.push(``);
  }

  // 用户给普通 GPIO 起的标签
  const plain = Object.entries(project.pinLabels).filter(([pin]) => !usage.some((u) => u.pin === pin));
  if (plain.length) {
    L.push(`/* ── 普通 GPIO 标签 ── */`);
    for (const [pin, label] of plain) {
      L.push(`#define ${sanitize(label).toUpperCase()}_PIN`.padEnd(34) + ` ${pinOf(pin)}`);
      L.push(`#define ${sanitize(label).toUpperCase()}_PORT`.padEnd(34) + ` ${portOf(pin)}`);
    }
    L.push(``);
  }

  L.push(`#endif /* __RFR_PINMAP_H */`);
  return L.join("\n") + "\n";
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/* ───────────────────────────── init.h ───────────────────────────── */

function genInitHeader(project: Project, dev: DeviceDef, hdr: string): string {
  const L: string[] = [];
  L.push(`#ifndef __RFR_INIT_H`);
  L.push(`#define __RFR_INIT_H`);
  L.push(``);
  L.push(`#include "${hdr}.h"`);
  L.push(`#include "rfr_pinmap.h"`);
  L.push(``);
  L.push(`void RFR_ClockInit(void);`);
  L.push(`void RFR_GPIOInit(void);`);
  L.push(`void RFR_NVICInit(void);`);
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || p.kind === "GPIO" || p.kind === "SYSTEM") continue;
    L.push(`void RFR_${p.id}_Init(void);`);
  }
  L.push(``);
  L.push(`#endif /* __RFR_INIT_H */`);
  return L.join("\n") + "\n";
}

/* ───────────────────────────── init.c ───────────────────────────── */

function genInitSource(project: Project, dev: DeviceDef, clk: ReturnType<typeof solveClock>, hdr: string): string {
  const L: string[] = [];
  const cm = project.settings.includeComments;
  L.push(`/* ${project.settings.name} — 外设初始化`);
  L.push(` * 目标: ${dev.id} / ${dev.package.label} / ${dev.core}`);
  L.push(` * 时钟: SYSCLK ${clk.sysclk} MHz, HCLK ${clk.hclk} MHz, PCLK1 ${clk.pclk1} MHz, PCLK2 ${clk.pclk2} MHz`);
  L.push(` */`);
  L.push(`#include "rfr_init.h"`);
  L.push(``);

  // 有 DMA 就需要一块内存缓冲区。工具不知道用户的数据放哪，先给一块公用缓冲，
  // 生成出来的是骨架：真正用的时候把 DMA_MemoryBaseAddr 换成自己的数组。
  const anyDma = dev.peripherals.some((p) => (project.configs[p.id]?.dmaChannels ?? []).length > 0);
  if (anyDma) {
    L.push(`/* DMA 缓冲区（骨架）：把 DMA_MemoryBaseAddr 换成你自己的数组 */`);
    L.push(`#define RFR_DMA_BUF_SIZE 64`);
    L.push(`static uint8_t rfr_dma_buf[RFR_DMA_BUF_SIZE];`);
    L.push(``);
  }

  /**
   * 需要配 AFIO 重映射的信号。
   *
   * 数据手册里每个复用功能都分「配置组」，组 0 是复位默认，其余组必须先写
   * AFIO_PCFR1/PCFR2 才能把外设挪到那根脚上。工具目前没有各系列的
   * GPIO_PinRemapConfig 宏名表（每个系列的枚举名都不一样），所以这里**不生成**
   * 配置代码，但必须把清单写出来 —— 否则用户会拿到「引脚配成 AF、外设却还在默认脚」
   * 的代码，现象是外设完全不动，极难查。
   */
  const remapped = collectUsage(project, dev).filter((u) => (u.remap ?? 0) > 0);
  if (remapped.length) {
    L.push(`/* ⚠ 下列信号用的不是默认复用组，必须先把 AFIO 重映射配到对应组，`);
    L.push(` *   否则外设仍然连在默认引脚上（本工具尚未内置 GPIO_PinRemapConfig 宏名表）：`);
    for (const u of remapped) {
      L.push(` *     ${u.fn.padEnd(16)} ${u.pin.padEnd(6)} 配置组 ${u.remap}`);
    }
    L.push(` *   参考手册的「复用功能重映射」章节（V407: RM 10.2.11 AFIO_PCFR1/PCFR2）。`);
    L.push(` */`);
    L.push(``);
  }

  /* ── 时钟 ── */
  L.push(`/* ───────────────── 系统时钟 ───────────────── */`);
  L.push(`void RFR_ClockInit(void)`);
  L.push(`{`);
  if (cm) L.push(`    /* ${dev.clock.notes?.[0] ?? "RCC 配置"} */`);
  const api = apiOf(dev);
  L.push(`    RCC_DeInit();`);
  L.push(`    RCC_HSICmd(ENABLE);`);

  if (api.clockProfile === "full" && project.clock.sysclkSource === "PLL") {
    L.push(`    while (RCC_GetFlagStatus(RCC_FLAG_HSIRDY) == RESET) { }`);
    L.push(``);
    // L103 这类芯片的 PLL 输入就是 HSI 本身（HSI/2 = 4 MHz 低于 PLL 输入下限）
    // 但要靠 EXTEN_CTR.PLL_HSI_PRE 才能让 HSI 不分频进 PLL，且标准库只有 _HSI_Div2 常量
    const hsiDirect = dev.clock.pllSource === "HSI";
    if (hsiDirect && api.pllHsiPre) L.push(`    EXTEN->EXTEN_CTR |= EXTEN_PLL_HSI_PRE;`);
    const pllSrc =
      hsiDirect && !api.pllHsiPre ? "RCC_PLLSource_HSI" : "RCC_PLLSource_HSI_Div2";
    const mul = api.pllMuls?.length ? clampTo(api.pllMuls, project.clock.pllMul) : project.clock.pllMul;
    L.push(`    RCC_PLLConfig(${pllSrc}, RCC_PLLMul_${mul});`);
    L.push(`    RCC_PLLCmd(ENABLE);`);
    L.push(`    while (RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET) { }`);
    L.push(``);
    L.push(`    RCC_HCLKConfig(RCC_SYSCLK_Div${project.clock.ahbDiv});`);
    // PCLK 分频只有本系列真实存在的档位才能写（V407 没有 PCLK1 分频、PCLK2 最多 /8）
    const apb2Div = clampTo(api.apb2Divs?.length ? api.apb2Divs : [project.clock.apb2Div], project.clock.apb2Div);
    L.push(`    RCC_PCLK2Config(RCC_HCLK_Div${apb2Div});`);
    if (api.apb1Divs?.length) {
      const apb1Div = clampTo(api.apb1Divs, project.clock.apb1Div);
      L.push(`    RCC_PCLK1Config(RCC_HCLK_Div${apb1Div});`);
    }
    if (api.adcClock === "rcc") {
      L.push(`    RCC_ADCCLKConfig(RCC_PCLK2_Div${adcDivOf(api, project.clock.adcDiv)});`);
    }
    L.push(``);
    L.push(`    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);`);
    L.push(`    while (RCC_GetSYSCLKSource() != 0x08) { }`);
  } else if (api.clockProfile === "full") {
    L.push(`    while (RCC_GetFlagStatus(RCC_FLAG_HSIRDY) == RESET) { }`);
    L.push(`    RCC_SYSCLKConfig(RCC_SYSCLKSource_HSI);`);
  } else {
    // hsi-only 的系列（X035）：只有 HSI 一路，RCC 里没有 SYSCLKConfig / PCLK 分频，
    // 也没有 ADC 时钟接口 —— 多写一句就是编译错误
    if (project.clock.ahbDiv !== 1) {
      L.push(`    RCC_HCLKConfig(RCC_SYSCLK_Div${project.clock.ahbDiv});`);
    }
  }

  // Flash 等待周期不是外设配置，跟主频走，所以直接推导出来写死在这里
  const latency = clk.sysclk <= 24 ? 0 : clk.sysclk <= 48 ? 1 : 2;
  L.push(``);
  if (api.flashLatency !== false) {
    L.push(`    /* Flash 等待周期由主频推导：${clk.sysclk} MHz → ${latency} */`);
    L.push(`    FLASH_SetLatency(FLASH_Latency_${latency});`);
  }
  if (api.flashPrefetch) {
    L.push(`    FLASH_PrefetchBufferCmd(ENABLE);`);
  }
  L.push(`}`);
  L.push(``);

  /* ── GPIO ── */
  L.push(`/* ───────────────── GPIO ───────────────── */`);
  L.push(`void RFR_GPIOInit(void)`);
  L.push(`{`);
  L.push(`    GPIO_InitTypeDef gpio = {0};`);
  const ports = new Set<string>();
  const portClocks: string[] = [];

  const gpioLines: string[] = [];
  for (const pin of dev.package.pins) {
    if (pin.kind !== "io") continue;
    const g = project.gpio[pin.name];
    if (!g) continue;
    const usedBy = collectUsage(project, dev).find((u) => u.pin === pin.name);
    if (usedBy) continue; // 外设引脚在各自 Init 里配置
    if (g.mode === "analog" && g.pull === "none") continue; // 默认模拟态，跳过
    ports.add(portOf(pin.name));
    const mode = gpioModeOf(g.mode, g.pull, api);
    gpioLines.push(
      `    gpio.GPIO_Pin = ${pinOf(pin.name)}; gpio.GPIO_Speed = ${gpioSpeedMacro(api, g.speed)}; gpio.GPIO_Mode = ${mode};`,
    );
    gpioLines.push(`    GPIO_Init(${portOf(pin.name)}, &gpio);`);
    if (g.mode === "output_pp" || g.mode === "output_od") {
      const bit = g.initial === "high" ? "BSHR" : "BCR";
      gpioLines.push(`    GPIO_${bit === "BSHR" ? "SetBits" : "ResetBits"}(${portOf(pin.name)}, ${pinOf(pin.name)});`);
    }
    if (project.pinLabels[pin.name]) {
      gpioLines.push(`    /* ${project.pinLabels[pin.name]} */`);
    }
  }

  if (ports.size === 0) {
    L.push(`    /* 没有需要单独配置的普通 GPIO */`);
  } else {
    // 端口时钟宏的名字也随 clockApi 变（APB2Periph_ vs PB2Periph_）
    const pfx = (api.clockApi ?? "apb") === "pb" ? "RCC_PB2Periph" : "RCC_APB2Periph";
    for (const p of ports) portClocks.push(`${pfx}_${p}`);
    const fnGpio = (api.clockApi ?? "apb") === "pb" ? "RCC_PB2PeriphClockCmd" : "RCC_APB2PeriphClockCmd";
    L.push(`    ${fnGpio}(${portClocks.join(" | ")}, ENABLE);`);
    L.push(`    /* 默认速度取本系列最接近 10MHz 的一档 */`);
    L.push(`    gpio.GPIO_Speed = ${gpioSpeedMacro(api, "10")};`);
    L.push(...gpioLines);
  }
  L.push(`}`);
  L.push(``);

  /* ── 各外设 ── */
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || p.kind === "GPIO" || p.kind === "SYSTEM") continue;
    const body = genPeripheralInit(p.id, p.kind, cfg, project, dev, clk);
    if (body.length === 0) continue;
    L.push(`/* ───────────────── ${p.id} ───────────────── */`);
    L.push(`void RFR_${p.id}_Init(void)`);
    L.push(`{`);
    L.push(...body);
    L.push(`}`);
    L.push(``);
  }

  /* ── NVIC ── */
  L.push(`/* ───────────────── 中断 ───────────────── */`);
  L.push(`void RFR_NVICInit(void)`);
  L.push(`{`);
  const cmsis = (apiOf(dev).nvicApi ?? "stdlib") === "cmsis";
  if (!cmsis) L.push(`    NVIC_InitTypeDef nvic = {0};`);
  const irqLines: string[] = [];
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || !cfg.nvic?.enabled) continue;
    for (const irq of p.irq ?? []) {
      // gate 决定这个向量是否真的要配：只有对应的中断使能位打开才生成
      if (irq.gate) {
        const gates = Array.isArray(irq.gate) ? irq.gate : [irq.gate];
        const on = gates.some((k) => cfg.params[k] === true || cfg.params[k] === "true");
        if (!on) continue;
      }
      if (cmsis) {
        // V407 这类新系列只有 core_riscv.h 的 CMSIS 接口：
        // 没有 NVIC_Init，也没有 NVIC_PriorityGroupConfig。
        // 优先级写成「抢占<<4 | 子优先级」的原始 8 位值。
        const pri = ((cfg.nvic.preempt & 0xf) << 4) | (cfg.nvic.sub & 0xf);
        irqLines.push(`    NVIC_SetPriority(${irq.name}_IRQn, ${pri});`);
        irqLines.push(`    NVIC_EnableIRQ(${irq.name}_IRQn);`);
      } else {
        irqLines.push(
          `    nvic.NVIC_IRQChannel = ${irq.name}_IRQn; nvic.NVIC_IRQChannelPreemptionPriority = ${cfg.nvic.preempt}; nvic.NVIC_IRQChannelSubPriority = ${cfg.nvic.sub}; nvic.NVIC_IRQChannelCmd = ENABLE;`,
        );
        irqLines.push(`    NVIC_Init(&nvic);`);
      }
    }
  }
  if (irqLines.length === 0) L.push(`    /* 未启用任何外设中断 */`);
  else L.push(...irqLines);
  L.push(`}`);
  return L.join("\n") + "\n";
}

function gpioModeOf(mode: string, pull: string, api: ApiProfile): string {
  switch (mode) {
    case "input":
      return pull === "up" ? "GPIO_Mode_IPU" : pull === "down" ? "GPIO_Mode_IPD" : "GPIO_Mode_IN_FLOATING";
    case "output_pp":
      return "GPIO_Mode_Out_PP";
    case "output_od":
      // X035 的 GPIO 没有开漏，退成推挽（界面上也会把这一项灰掉）
      return api.gpioOpenDrain ? "GPIO_Mode_Out_OD" : "GPIO_Mode_Out_PP";
    case "af_pp":
      return "GPIO_Mode_AF_PP";
    case "af_od":
      return api.gpioOpenDrain ? "GPIO_Mode_AF_OD" : "GPIO_Mode_AF_PP";
    default:
      return "GPIO_Mode_AIN";
  }
}

/* ─────────────────── 各外设初始化体 ─────────────────── */

/** 一条 DMA 通道的初始化（`DMA_InitTypeDef` 那几行） */
function dmaInitLines(
  L: string[],
  dev: DeviceDef,
  id: string,
  d: NonNullable<PeripheralConfig["dmaChannels"]>[number],
  periphReg: string,
): void {
  const { ctrl, local } = dmaRef(dev, d.channel);
  const ch = `${ctrl}_Channel${local}`;
  // 数据寄存器：USART/SPI/I2C 是 DATAR，ADC 是 RDATAR（规则组结果）
  const datar = id.startsWith("ADC") ? `${id}->RDATAR` : `${id}->DATAR`;
  L.push(`    /* ${d.request} → ${ch}（${d.dir === "p2m" ? "外设→内存" : "内存→外设"}） */`);
  L.push(`    DMA_DeInit(${ch});`);
  L.push(`    dma.DMA_PeripheralBaseAddr = (uint32_t)&${datar};`);
  L.push(`    dma.DMA_MemoryBaseAddr = (uint32_t)${periphReg};`);
  L.push(`    dma.DMA_DIR = DMA_DIR_Peripheral${d.dir === "p2m" ? "SRC" : "DST"};`);
  L.push(`    dma.DMA_BufferSize = ${d.bufferSize && d.bufferSize > 0 ? d.bufferSize : 16};`);
  L.push(`    dma.DMA_PeripheralInc = DMA_PeripheralInc_Disable;`);
  L.push(`    dma.DMA_MemoryInc = DMA_MemoryInc_${d.incMem ? "Enable" : "Disable"};`);
  L.push(`    dma.DMA_PeripheralDataSize = DMA_PeripheralDataSize_${dataSizeMacro(d.width)};`);
  L.push(`    dma.DMA_MemoryDataSize = DMA_MemoryDataSize_${dataSizeMacro(d.width)};`);
  L.push(`    dma.DMA_Mode = DMA_Mode_${d.mode === "circular" ? "Circular" : "Normal"};`);
  L.push(`    dma.DMA_Priority = DMA_Priority_${priorityMacro(d.priority)};`);
  L.push(`    dma.DMA_M2M = DMA_M2M_Disable;`);
  L.push(`    DMA_Init(${ch}, &dma);`);
  if (d.irqTc) L.push(`    DMA_ITConfig(${ch}, DMA_IT_TC, ENABLE);`);
  if (d.irqHt) L.push(`    DMA_ITConfig(${ch}, DMA_IT_HT, ENABLE);`);
  L.push(`    DMA_Cmd(${ch}, ENABLE);`);
}

/**
 * 还没生成初始化的外设，能确定的那部分时钟先开上。
 *
 * 只有「时钟宏在哪种总线上」是确定的，其余（OPA/CMP 的通道选择、USB 的端点）
 * 都是系列专属枚举，硬猜会配出错误的模拟参数 —— 所以宁可留 TODO。
 */
function fallbackClock(
  id: string,
  kind: string,
  api: ApiProfile,
  busOverride?: 1 | 2 | "AHB",
): string | null {
  // 实例名和时钟宏名不一定一样（X035 的 USB1 -> USBFS）
  id = api.clockAliases?.[id] ?? id;
  const pbStyle = (api.clockApi ?? "apb") === "pb";
  const hb = pbStyle ? "RCC_HBPeriphClockCmd" : "RCC_AHBPeriphClockCmd";
  const hbMacro = (n: string) => (pbStyle ? `RCC_HBPeriph_${n}` : `RCC_AHBPeriph_${n}`);
  const pb1 = pbStyle ? "RCC_PB1PeriphClockCmd" : "RCC_APB1PeriphClockCmd";
  const pb1Macro = (n: string) => (pbStyle ? `RCC_PB1Periph_${n}` : `RCC_APB1Periph_${n}`);
  const pb2 = pbStyle ? "RCC_PB2PeriphClockCmd" : "RCC_APB2PeriphClockCmd";
  const pb2Macro = (n: string) => (pbStyle ? `RCC_PB2Periph_${n}` : `RCC_APB2Periph_${n}`);

  // USB：X035 是 USBFS/USBPD，V407 是 USBHS1/USBHS2，都挂在高速总线上
  if (kind === "USB") {
    return `${hb}(${hbMacro(id)}, ENABLE);`;
  }
  // 高速总线上的外设（V407 的 ETH/LTDC/DVP/FSMC/SDIO/ARGB/I3C/RNG）
  if (["ETH", "LTDC", "DVP", "FSMC", "SDIO", "ARGB", "I3C", "RNG"].includes(id)) {
    return `${hb}(${hbMacro(id)}, ENABLE);`;
  }
  // 器件包显式指定的总线优先：L103 的 USBPD 挂在 HB 上，按默认规则会进 PB1
  if (busOverride === "AHB") return `${hb}(${hbMacro(id)}, ENABLE);`;
  if (busOverride === 1) return `${pb1}(${pb1Macro(id)}, ENABLE);`;
  if (busOverride === 2) return `${pb2}(${pb2Macro(id)}, ENABLE);`;
  if (kind === "CAN") return `${pb1}(${pb1Macro(id)}, ENABLE);`;
  if (id.startsWith("DAC")) return `${pb1}(${pb1Macro(id)}, ENABLE);`;
  if (id.startsWith("USART") || id.startsWith("SPI") || id.startsWith("I2C")) {
    const idx = Number(/(\d+)$/.exec(id)?.[1] ?? "1");
    const onPb2 = (id.startsWith("USART") && idx === 1) || (id.startsWith("SPI") && idx === 1);
    return onPb2 ? `${pb2}(${pb2Macro(id)}, ENABLE);` : `${pb1}(${pb1Macro(id)}, ENABLE);`;
  }
  // OPA / CMP / PIOC 没有单独的时钟使能位（常开），只需配寄存器
  return null;
}

function fallbackRegHint(kind: string): string {
  switch (kind) {
    case "OPA":
      return "OPA->CTLR（OPA_InitTypeDef 的 PSEL / NSEL / Mode）";
    case "CMP":
      return "CMP->CTLR（CMP_InitTypeDef 的 PSEL / NSEL / HYEN）";
    case "USB":
      return "USBFS->BASE_CTRL / USBOTG 寄存器";
    case "PIOC":
      return "PIOC 的 IO 通道寄存器（见 PIOC_SFR.h）";
    default:
      return "对应外设的控制寄存器";
  }
}

/** ADC 时钟分频：夹到本系列真实存在的档位（V407 没有 /12、/16） */
function adcDivOf(api: ApiProfile, want: number): number {
  const allowed = api.adcDivs?.length ? api.adcDivs : [want];
  return clampTo(allowed, want);
}

/** 取 allowed 里最接近 want 的那一档（用于 PLL 倍频、APB 分频这类枚举） */
function clampTo(allowed: number[], want: number): number {
  return allowed.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), allowed[0]!);
}

/** `TIM1_CH2` → `TIM_DMA_CC2`；`TIM1_UP` → `TIM_DMA_Update` */
function timDmaSource(request: string): string | null {
  const sig = request.split("_").slice(1).join("_");
  const m = /^CH([1-4])$/.exec(sig);
  if (m) return `TIM_DMA_CC${m[1]}`;
  if (sig === "UP") return "TIM_DMA_Update";
  if (sig === "TRIG") return "TIM_DMA_Trigger";
  if (sig === "COM") return "TIM_DMA_COM";
  return null;
}

function dataSizeMacro(w: string): string {
  return w === "32" ? "Word" : w === "16" ? "HalfWord" : "Byte";
}

function priorityMacro(p: string): string {
  switch (p) {
    case "veryhigh":
      return "VeryHigh";
    case "high":
      return "High";
    case "low":
      return "Low";
    default:
      return "Medium";
  }
}

function genPeripheralInit(
  id: string,
  kind: string,
  cfg: PeripheralConfig,
  project: Project,
  dev: DeviceDef,
  clk: ReturnType<typeof solveClock>,
): string[] {
  const L: string[] = [];
  const api = apiOf(dev);
  const v = cfg.params;
  const pin = (sig: string) => cfg.pins[sig] ?? null;
  const busClock = (bus: 1 | 2, macro: string) => {
    const fn = bus === 1 ? "RCC_APB1PeriphClockCmd" : "RCC_APB2PeriphClockCmd";
    return `    ${fn}(${macro}, ENABLE);`;
  };

  const gpioSetup = (pinName: string, mode: string) => {
    L.push(`    gpio.GPIO_Pin = ${pinOf(pinName)};`);
    L.push(`    gpio.GPIO_Speed = ${gpioSpeedMacro(api, "10")};`);
    L.push(`    gpio.GPIO_Mode = ${mode};`);
    L.push(`    GPIO_Init(${portOf(pinName)}, &gpio);`);
  };

  /**
   * 外设挂在哪条 APB 上。
   *
   * 这套分配在 CH32X035 与 CH32V30x 的 rcc.h 里完全一致：
   *   APB2 = GPIO / AFIO / ADC1-2 / SPI1 / USART1 / TIM1·TIM8·TIM9·TIM10
   *   APB1 = 其余（I2C、SPI2-3、USART2-4、TIM2-7、CAN、PWR、BKP、WWDG）
   * 之前一律按 APB2 生成，导致 I2C1 / TIM2 / USART2 全部开不到时钟 —— 编译能过、
   * 运行起来是死的，比编译错误更难查。
   */
  const apbOf = (periphId: string): 1 | 2 | "AHB" => {
    const override = dev.buses?.[periphId];
    if (override) return override;
    const m = /^([A-Z]+)(\d*)$/.exec(periphId);
    const base = m?.[1] ?? periphId;
    const idx = Number(m?.[2] ?? "1");
    if (base === "USART" || base === "UART") return idx === 1 ? 2 : 1;
    if (base === "SPI") return idx === 1 ? 2 : 1;
    if (base === "TIM") return [1, 8, 9, 10].includes(idx) ? 2 : 1;
    if (base === "ADC") return 2;
    // USB 控制器一律挂在高速总线上（X035 是 AHB，L103 叫 HB，V407 全是 HB）
    if (base === "USB") return "AHB";
    return 1;
  };

  /**
   * 时钟宏的两种命名（见 ApiProfile.clockApi）：
   *   apb → RCC_APB2PeriphClockCmd / RCC_APB2Periph_GPIOA / RCC_AHBPeriph_DMA1
   *   pb  → RCC_PB2PeriphClockCmd / RCC_PB2Periph_GPIOA / RCC_HBPeriph_DMA1
   */
  const pbStyle = (api.clockApi ?? "apb") === "pb";
  const clkFn = (bus: 1 | 2 | "AHB") =>
    pbStyle
      ? bus === "AHB"
        ? "RCC_HBPeriphClockCmd"
        : `RCC_PB${bus}PeriphClockCmd`
      : bus === "AHB"
        ? "RCC_AHBPeriphClockCmd"
        : `RCC_APB${bus}PeriphClockCmd`;
  const clkMacro = (bus: 1 | 2 | "AHB", rawName: string) => {
    const name = api.clockAliases?.[rawName] ?? rawName;
    return pbStyle
      ? bus === "AHB"
        ? `RCC_HBPeriph_${name}`
        : `RCC_PB${bus}Periph_${name}`
      : bus === "AHB"
        ? `RCC_AHBPeriph_${name}`
        : `RCC_APB${bus}Periph_${name}`;
  };

  const portClocksOf = (names: (string | null)[]) => {
    const set = new Set(names.filter(Boolean).map((n) => portOf(n as string)));
    return [...set].map((p) => clkMacro(2, p)).join(" | ");
  };

  /** 端口时钟（PB2/APB2）+ 外设时钟（按 apbOf），返回要 push 的行 */
  const clockOf = (periphId: string, names: (string | null)[]): string[] => {
    const out: string[] = [];
    const ports = portClocksOf(names);
    if (ports) out.push(`    ${clkFn(2)}(${ports}, ENABLE);`);
    const bus = apbOf(periphId);
    out.push(`    ${clkFn(bus)}(${clkMacro(bus, periphId)}, ENABLE);`);
    return out;
  };


  /** 端口时钟 + 外设宏拼成一条表达式，端口为空时不留下 " | " */
  const apb2Expr = (names: (string | null)[], periphMacro: string) => {
    const ports = portClocksOf(names);
    const periph = clkMacro(2, periphMacro);
    return ports ? `${ports} | ${periph}` : periph;
  };

  /** 采样周期按本系列的真实宏命名（见 sampleTimeMacroOf） */
  const sampleTimeMacro = (v: string) => sampleTimeMacroOf(api, String(v));

  // USBPD 的 kind 是 USB（同属 USB 类外设），但引脚与初始化完全不同，按 id 分流
  const codegenKind = id.startsWith("USBPD") ? "USBPD" : kind;

  switch (codegenKind) {
    case "USBPD": {
      /**
       * USB PD 控制器：只配 CC1 / CC2 两根，没有 DP / DM。
       * CC 线是模拟检测通道，GPIO 配成浮空输入，上下拉与 BMC 收发由 PHY 自己管。
       */
      const cc1 = pin("CC1");
      const cc2 = pin("CC2");
      const role = String(v["role"] ?? "disable");
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(...clockOf(id, [cc1, cc2]));
      for (const [sig, p] of [
        ["CC1", cc1],
        ["CC2", cc2],
      ] as const) {
        if (!p) continue;
        L.push(`    /* ${p} → ${id}_${sig}（Type-C CC，浮空输入交给 PD PHY） */`);
        gpioSetup(p, "GPIO_Mode_IN_FLOATING");
      }
      L.push(`    /* 角色：${role}，协议：${v["pdVersion"] === "pd2" ? "USB PD 2.0" : "USB PD 3.0"} */`);
      if (role === "source" || role === "drp") {
        L.push(`    /* ${v["pdoVoltage"] ?? 5} V / ${v["pdoCurrent"] ?? 3} A 默认 PDO${v["vconn"] ? "，并输出 VCONN" : ""} */`);
      }
      if (v["autoPolarity"]) L.push(`    /* CC 极性自动翻转：正插用 CC1、反插用 CC2 */`);
      L.push(`    /* TODO: ${id} 的 PD 报文收发表（PD_DMA / PD_STAT）按 EVT 的 USBPD 例程填 ——`);
      L.push(`     * 各系列的寄存器命名不同，这里不猜；引脚与角色已经配好。 */`);
      if (v["irqCc"]) L.push(`    /* TODO: 打开 CC 状态变化中断 */`);
      if (v["irqPd"]) L.push(`    /* TODO: 打开 PD 收/发中断 */`);
      break;
    }
    case "USART": {
      const tx = pin("TX");
      const rx = pin("RX");
      const ck = pin("CK");
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(`    USART_InitTypeDef uart = {0};`);
      L.push(...clockOf(id, [tx, rx, ck]));
      if (tx) {
        L.push(`    /* ${tx} → ${id}_TX */`);
        gpioSetup(tx, "GPIO_Mode_AF_PP");
      }
      if (rx) {
        L.push(`    /* ${rx} → ${id}_RX */`);
        gpioSetup(rx, "GPIO_Mode_IPU");
      }
      if (ck) {
        L.push(`    /* ${ck} → ${id}_CK（同步模式时钟输出） */`);
        gpioSetup(ck, "GPIO_Mode_AF_PP");
      }
      const baud = Number(v["baud"] ?? 115200);
      const brr = usartBrr(clk.pclk2, baud, String(v["oversampling"]) === "8" ? 8 : 16);
      L.push(`    /* BRR = ${hex(brr.brr)} → 实际 ${brr.actual.toFixed(1)} bit/s，误差 ${brr.error.toFixed(2)}% */`);
      L.push(`    uart.USART_BaudRate = ${baud};`);
      L.push(`    uart.USART_WordLength = USART_WordLength_${v["wordLength"]}b;`);
      L.push(`    uart.USART_StopBits = USART_StopBits_${String(v["stopBits"]).replace("0_5", "0_5").replace("1_5", "1_5")};`);
      // 真实枚举名是 USART_Parity_No（不是 None）
      L.push(`    uart.USART_Parity = USART_Parity_${String(v["parity"]) === "None" ? "No" : v["parity"]};`);
      L.push(`    uart.USART_HardwareFlowControl = USART_HardwareFlowControl_${flowOf(String(v["rs232"]))};`);
      const usartMode0 = String(v["mode"] ?? "");
      L.push(
        `    uart.USART_Mode = ${
          // 单线半双工收发共用一根线，TE/RE 必须都开，方向参数在这模式下不生效
          usartMode0 === "SingleWire" ? "USART_Mode_Tx | USART_Mode_Rx" : modeOfUsart(String(v["dataDirection"]))
        };`,
      );
      L.push(`    USART_Init(${id}, &uart);`);
      const usartMode = usartMode0;
      if (usartMode.startsWith("SmartCard")) {
        L.push(`    /* 智能卡模式：9 位字长 + 偶校验 + 0.5 停止位 */`);
      }
      if (usartMode === "SingleWire") {
        // 单线半双工：收发共用 TX 一根线，CTLR3.HDSEL=1
        L.push(`    /* 单线半双工：${tx ?? "TX"} 一根线兼顾收发（CTLR3.HDSEL=1） */`);
        L.push(`    USART_HalfDuplexCmd(${id}, ENABLE);`);
      }
      if (usartMode === "Synchronous") {
        // 同步主机：CK 输出波特率时钟，CTLR2.CLKEN=1
        L.push(`    /* 同步模式：${ck ?? "CK"} 输出波特率时钟（CTLR2.CLKEN=1） */`);
        L.push(`    USART_ClockInitTypeDef uartCk = {0};`);
        L.push(`    USART_ClockStructInit(&uartCk);`);
        L.push(`    uartCk.USART_Clock = USART_Clock_Enable;`);
        // 三项来自「时钟参数（同步模式）」分组，默认值与复位值一致
        L.push(`    uartCk.USART_CPOL = USART_CPOL_${v["cpol"] === "High" ? "High" : "Low"};`);
        L.push(`    uartCk.USART_CPHA = USART_CPHA_${v["cpha"] === "2Edge" ? "2Edge" : "1Edge"};`);
        L.push(`    uartCk.USART_LastBit = USART_LastBit_${v["lastBit"] === "Enable" ? "Enable" : "Disable"};`);
        L.push(`    USART_ClockInit(${id}, &uartCk);`);
      }
      L.push(`    USART_Cmd(${id}, ENABLE);`);
      if (v["irqRxne"]) L.push(`    USART_ITConfig(${id}, USART_IT_RXNE, ENABLE);`);
      if (v["irqIdle"]) L.push(`    USART_ITConfig(${id}, USART_IT_IDLE, ENABLE);`);
      if (v["irqTxe"]) L.push(`    USART_ITConfig(${id}, USART_IT_TXE, ENABLE);`);
      if (v["irqTc"]) L.push(`    USART_ITConfig(${id}, USART_IT_TC, ENABLE);`);
      break;
    }
    case "SPI": {
      const sck = pin("SCK");
      const mosi = pin("MOSI");
      const miso = pin("MISO");
      const nss = pin("NSS");
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(`    SPI_InitTypeDef spi = {0};`);
      L.push(...clockOf(id, [sck, mosi, miso, nss]));
      const isMaster = String(v["mode"]).includes("master");
      if (sck) gpioSetup(sck, "GPIO_Mode_AF_PP");
      if (mosi) gpioSetup(mosi, "GPIO_Mode_AF_PP");
      if (miso) gpioSetup(miso, isMaster ? "GPIO_Mode_IPU" : "GPIO_Mode_AF_PP");
      if (nss) gpioSetup(nss, "GPIO_Mode_IPU");
      L.push(`    /* fSCK = ${(clk.pclk2 / Number(v["prescaler"])).toFixed(2)} MHz */`);
      // 真实枚举名：SPI_Direction_1Line_Rx/Tx、SPI_Direction_2Lines_FullDuplex
      // （旧代码拼的 "2Lines" / "1Line" 在 X035 上根本不存在）
      const spiMode = String(v["mode"]);
      const spiDir =
        spiMode === "half_master" || spiMode === "half_slave"
          ? "SPI_Direction_1Line_Tx"
          : spiMode === "rx_master" || spiMode === "rx_slave"
            ? "SPI_Direction_1Line_Rx"
            : "SPI_Direction_2Lines_FullDuplex";
      L.push(`    spi.SPI_Direction = ${spiDir};`);
      L.push(`    spi.SPI_Mode = SPI_Mode_${isMaster ? "Master" : "Slave"};`);
      L.push(`    spi.SPI_DataSize = SPI_DataSize_${v["dataSize"]}b;`);
      L.push(`    spi.SPI_CPOL = SPI_CPOL_${v["cpol"] === "1" ? "High" : "Low"};`);
      L.push(`    spi.SPI_CPHA = SPI_CPHA_${v["cpha"] === "1" ? "2Edge" : "1Edge"};`);
      L.push(`    spi.SPI_NSS = SPI_NSS_${v["nss"] === "software" ? "Soft" : "Hard"};`);
      L.push(`    spi.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_${v["prescaler"]};`);
      L.push(`    spi.SPI_FirstBit = SPI_FirstBit_${v["firstBit"]};`);
      L.push(`    SPI_Init(${id}, &spi);`);
      L.push(`    SPI_Cmd(${id}, ENABLE);`);
      if (v["irqRxne"]) L.push(`    SPI_I2S_ITConfig(${id}, SPI_I2S_IT_RXNE, ENABLE);`);
      break;
    }
    case "I2C": {
      const scl = pin("SCL");
      const sda = pin("SDA");
      const smba = pin("SMBA");
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(`    I2C_InitTypeDef i2c = {0};`);
      L.push(...clockOf(id, [scl, sda, smba]));
      // X035 的 GPIO 没有 AF_OD；WCH 官方 I2C 例程在 X035 上就是用 AF_PP
      const odMode = api.gpioOpenDrain ? "GPIO_Mode_AF_OD" : "GPIO_Mode_AF_PP";
      if (scl) gpioSetup(scl, odMode);
      if (sda) gpioSetup(sda, odMode);
      if (smba) gpioSetup(smba, odMode);
      L.push(`    /* 需要外部 4.7k 上拉；I2C 为开漏复用输出 */`);
      L.push(`    i2c.I2C_ClockSpeed = ${Number(v["speed"]) * 1000};`);
      L.push(`    i2c.I2C_Mode = I2C_Mode_I2C;`);
      L.push(`    i2c.I2C_DutyCycle = I2C_DutyCycle_2;`);
      L.push(`    i2c.I2C_OwnAddress1 = ${hex(Number(v["ownAddr1"] ?? 0x30))};`);
      L.push(`    i2c.I2C_Ack = I2C_Ack_${v["ackEnable"] ? "Enable" : "Disable"};`);
      L.push(`    i2c.I2C_AcknowledgedAddress = I2C_AcknowledgedAddress_${v["addrBits"] === "10" ? "10bit" : "7bit"};`);
      L.push(`    I2C_Init(${id}, &i2c);`);
      if (String(v["mode"]) === "smbus") {
        const host = String(v["smbusRole"]) === "host";
        L.push(`    /* SMBus ${host ? "主机" : "设备"}模式：CTLR1.SMBUS=1${host ? "，主机还要 SMBTYPE=1" : ""} */`);
        L.push(`    ${id}->CTLR1 |= I2C_CTLR1_SMBUS${host ? " | I2C_CTLR1_SMBTYPE" : ""};`);
        if (v["smbusPec"]) L.push(`    ${id}->CTLR1 |= I2C_CTLR1_ENPEC;   /* PEC 校验 */`);
        if (smba) {
          L.push(`    /* ${smba} → ${id}_SMBA（SMBus 告警线，开漏） */`);
          if (v["smbusAlert"]) L.push(`    ${id}->CTLR1 |= I2C_CTLR1_SMBAL;`);
        }
      }
      L.push(`    I2C_Cmd(${id}, ENABLE);`);
      break;
    }
    case "TIM": {
      /*
       * LPTIM 是**另一个外设类型**，不是 TIM_TypeDef。
       *
       * L103 的 ch32l103.h 里 LPTIM 是 `LPTIM_TypeDef *`，初始化要
       * `LPTIM_TimeBaseInit(LPTIM_TimeBaseInitTypeDef*)` —— 把 TIM 那套
       * `TIM_TimeBaseInit(LPTIM, &tb)` 抄过来是「传参类型不兼容」的编译错误。
       * 参数也比 TIM 多得多（时钟源/计数源/采样时间/单脉冲/连续模式…）。
       * 目前只有 L103 有 LPTIM，所以按 id 分支，够用且不会误伤别家。
       */
      if (id === "LPTIM") {
        const chPins = [1, 2].flatMap((n) => {
          const c = cfg.channels?.[`CH${n}`];
          return c?.enabled ? [c.pin ?? null] : [];
        });
        const outPin = cfg.pins["OUT"];
        L.push(`    GPIO_InitTypeDef gpio = {0};`);
        L.push(`    LPTIM_TimeBaseInitTypeDef tb = {0};`);
        L.push(...clockOf(id, [...chPins, outPin ?? null]));
        for (const n of [1, 2]) {
          const pin = cfg.pins[`CH${n}`] ?? cfg.channels?.[`CH${n}`]?.pin;
          if (!pin) continue;
          L.push(`    /* ${pin} → LPTIM_IN${n} */`);
          gpioSetup(pin, "GPIO_Mode_IPU");
        }
        if (outPin) {
          L.push(`    /* ${outPin} → LPTIM_OUT */`);
          gpioSetup(outPin, "GPIO_Mode_AF_PP");
        }
        // LPTIM 的预分频是枚举 DIV1/2/4/…/128，没有 DIV0；TIM 的 psc=0 在这里要落到 DIV1
        const legalPsc = [1, 2, 4, 8, 16, 32, 64, 128];
        const pscN = Number(v["psc"] ?? 0) || 1;
        const psc = String(legalPsc.reduce((a, b) => (Math.abs(b - pscN) < Math.abs(a - pscN) ? b : a), 1));
        const arr = Number(v["arr"] ?? 999);
        L.push(`    tb.LPTIM_ClockSource = LPTIM_ClockSource_In;`);
        L.push(`    tb.LPTIM_CountSource = LPTIM_CountSource_Internal;`);
        L.push(`    tb.LPTIM_InClockSource = LPTIM_InClockSource_PCLK1;`);
        L.push(`    tb.LPTIM_ClockPrescaler = LPTIM_TClockPrescaler_DIV${psc};`);
        L.push(`    tb.LPTIM_ClockPolarity = LPTIM_ClockPolarity_Rising;`);
        L.push(`    tb.LPTIM_ClockSampleTime = LPTIM_ClockSampleTime_0T;`);
        L.push(`    tb.LPTIM_TriggerSampleTime = LPTIM_TriggerSampleTime_0T;`);
        L.push(`    tb.LPTIM_ExTriggerPolarity = LPTIM_ExTriggerPolarity_Disable;`);
        L.push(`    tb.LPTIM_TimeOut = ENABLE;`);
        L.push(`    tb.LPTIM_OutputPolarity = LPTIM_OutputPolarity_High;`);
        L.push(`    tb.LPTIM_UpdateMode = LPTIM_UpdateMode0;`);
        L.push(`    tb.LPTIM_Encoder = DISABLE;`);
        L.push(`    tb.LPTIM_ForceOutHigh = DISABLE;`);
        L.push(`    tb.LPTIM_SingleMode = DISABLE;`);
        L.push(`    tb.LPTIM_ContinuousMode = ENABLE;`);
        L.push(`    tb.LPTIM_PWMOut = ${outPin ? "ENABLE" : "DISABLE"};`);
        L.push(`    tb.LPTIM_CounterDirIndicat = DISABLE;`);
        L.push(`    tb.LPTIM_Pulse = 0;`);
        L.push(`    tb.LPTIM_Period = ${arr};`);
        L.push(`    LPTIM_TimeBaseInit(&tb);`);
        if (v["irqUpdate"]) L.push(`    LPTIM_ITConfig(LPTIM_IT_ARRM, ENABLE);`);
        L.push(`    LPTIM_Cmd(ENABLE);`);
        break;
      }
      const chPins = [1, 2, 3, 4].flatMap((n) => {
        const c = cfg.channels?.[`CH${n}`];
        return c?.enabled ? [c.pin ?? null, c.pinN ?? null] : [];
      });
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(`    TIM_TimeBaseInitTypeDef tb = {0};`);
      L.push(`    TIM_OCInitTypeDef oc = {0};`);
      L.push(...clockOf(id, chPins));
      for (let n = 1; n <= 4; n++) {
        const ch = cfg.channels?.[`CH${n}`];
        if (!ch?.enabled || !ch.pin) continue;
        L.push(`    /* ${ch.pin} → ${id}_CH${n} */`);
        gpioSetup(ch.pin, ch.mode === "ic" ? "GPIO_Mode_IPU" : "GPIO_Mode_AF_PP");
        if (ch.pinN) {
          // 互补输出是同一通道的另一根线，同样是复用推挽
          L.push(`    /* ${ch.pinN} → ${id}_CH${n}N（互补输出） */`);
          gpioSetup(ch.pinN, "GPIO_Mode_AF_PP");
        }
      }
      const psc = Number(v["psc"] ?? 0);
      const arr = Number(v["arr"] ?? 999);
      const tbInfo = timBase(clk.pclk2, psc, arr, String(v["counterMode"]));
      L.push(`    /* fCNT = ${(tbInfo.cntFreq / 1e6).toFixed(3)} MHz, 周期 = ${(tbInfo.period * 1e6).toFixed(2)} us */`);
      L.push(`    tb.TIM_Prescaler = ${psc};`);
      L.push(`    tb.TIM_Period = ${arr};`);
      L.push(`    tb.TIM_CounterMode = ${counterModeOf(String(v["counterMode"]))};`);
      L.push(`    tb.TIM_ClockDivision = TIM_CKD_DIV${v["ckd"]};`);
      L.push(`    tb.TIM_RepetitionCounter = ${v["repetition"] ?? 0};`);
      L.push(`    TIM_TimeBaseInit(${id}, &tb);`);
      for (let n = 1; n <= 4; n++) {
        const ch = cfg.channels?.[`CH${n}`];
        if (!ch?.enabled) continue;
        const p = ch.params ?? {};
        L.push(`    /* CH${n}: ${ch.mode} */`);
        L.push(`    oc.TIM_OCMode = ${ocModeOf(String(ch.mode), String(p["pwmMode"] ?? "1"))};`);
        L.push(`    oc.TIM_OutputState = TIM_OutputState_Enable;`);
        L.push(`    oc.TIM_Pulse = ${p["pulse"] ?? 0};`);
        L.push(`    oc.TIM_OCPolarity = TIM_OCPolarity_${p["polarity"] === "low" ? "Low" : "High"};`);
        L.push(`    TIM_OC${n}Init(${id}, &oc);`);
        L.push(`    TIM_OC${n}PreloadConfig(${id}, TIM_OCPreload_Enable);`);
        if (ch.pinN) {
          // 库函数没有单独开 CHxN 的接口，只能直接置 CCER.CCxNE
          L.push(`    /* CH${n}N 互补输出使能（CCER.CC${n}NE） */`);
          L.push(`    ${id}->CCER |= TIM_CCER_CC${n}NE;`);
        }
      }
      L.push(`    TIM_ARRPreloadConfig(${id}, ${v["arpe"] ? "ENABLE" : "DISABLE"});`);
      if (kind === "TIM" && id === "TIM1") L.push(`    TIM_CtrlPWMOutputs(${id}, ENABLE);`);
      L.push(`    TIM_Cmd(${id}, ENABLE);`);
      if (v["irqUpdate"]) L.push(`    TIM_ITConfig(${id}, TIM_IT_Update, ENABLE);`);
      break;
    }
    case "ADC": {
      const chans = Object.entries(cfg.channels ?? {}).filter(([, c]) => c.enabled && c.pin);
      L.push(`    GPIO_InitTypeDef gpio = {0};`);
      L.push(`    ADC_InitTypeDef adc = {0};`);
      L.push(
        ...clockOf(id, chans.map(([, c]) => c.pin ?? null)),
      );
      // X035 这类系列没有 RCC_ADCCLKConfig，ADC 时钟由 ADC_CLKConfig 在 ADC 侧配
      if (api.adcClock === "adc") {
        L.push(`    ADC_CLKConfig(${id}, ${adcDivMacro(project.clock.adcDiv)});`);
      } else {
        L.push(`    RCC_ADCCLKConfig(RCC_PCLK2_Div${adcDivOf(api, project.clock.adcDiv)});`);
      }
      for (const [key, c] of chans) {
        if (!c.pin) continue;
        L.push(`    /* ${c.pin} → ${id}_${key} */`);
        gpioSetup(c.pin, "GPIO_Mode_AIN");
      }
      L.push(`    ADC_DeInit(${id});`);
      L.push(`    adc.ADC_Mode = ADC_Mode_Independent;`);
      L.push(`    adc.ADC_ScanConvMode = ${v["scanMode"] === "enable" ? "ENABLE" : "DISABLE"};`);
      L.push(`    adc.ADC_ContinuousConvMode = ${v["continuous"] === "enable" ? "ENABLE" : "DISABLE"};`);
      L.push(`    adc.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;`);
      L.push(`    adc.ADC_DataAlign = ADC_DataAlign_${v["dataAlign"] === "left" ? "Left" : "Right"};`);
      L.push(`    adc.ADC_NbrOfChannel = ${Math.max(1, chans.length)};`);
      L.push(`    ADC_Init(${id}, &adc);`);
      let rank = 1;
      for (const [key, c] of chans) {
        const st = String(c.params?.["sampleTime"] ?? v["sampleTime"]);
        L.push(
          `    ADC_RegularChannelConfig(${id}, ADC_Channel_${key.replace("IN", "")}, ${rank++}, ${sampleTimeMacro(st)});`,
        );
      }
      L.push(`    ADC_Cmd(${id}, ENABLE);`);
      L.push(`    ADC_SoftwareStartConvCmd(${id}, ENABLE);`);
      break;
    }
    case "IWDG": {
      L.push(`    IWDG_WriteAccessCmd(IWDG_WriteAccess_Enable);`);
      L.push(`    IWDG_SetPrescaler(IWDG_Prescaler_${v["prescaler"]});`);
      L.push(`    IWDG_SetReload(${v["reload"]});`);
      L.push(`    IWDG_ReloadCounter();`);
      L.push(`    IWDG_Enable();`);
      break;
    }
    case "WWDG": {
      L.push(`    ${clkFn(1)}(${clkMacro(1, "WWDG")}, ENABLE);`);
      L.push(`    WWDG_SetPrescaler(WWDG_Prescaler_${v["prescaler"]});`);
      L.push(`    WWDG_SetWindowValue(${hex(Number(v["window"]))});`);
      L.push(`    WWDG_Enable(${hex(Number(v["counter"]))});`);
      break;
    }
    case "RTC": {
      L.push(`    ${clkFn(1)}(${clkMacro(1, "PWR")} | ${clkMacro(1, "BKP")}, ENABLE);`);
      L.push(`    PWR_BackupAccessCmd(ENABLE);`);
      L.push(`    RCC_LSICmd(ENABLE);`);
      L.push(`    RCC_RTCCLKConfig(RCC_RTCCLKSource_LSI);`);
      L.push(`    RCC_RTCCLKCmd(ENABLE);`);
      L.push(`    RTC_WaitForSynchro();`);
      break;
    }
    case "PWR": {
      L.push(`    ${clkFn(1)}(${clkMacro(1, "PWR")}, ENABLE);`);
      if (v["pvd"]) L.push(`    PWR_PVDLevelConfig(PWR_PVDLevel_${String(v["pvdLevel"]).replace(".", "_")}V);`);
      if (v["pvd"]) L.push(`    PWR_PVDCmd(ENABLE);`);
      break;
    }
    case "EXTI": {
      L.push(`    EXTI_InitTypeDef exti = {0};`);
      if (v["afioRemap"] !== false) {
        L.push(`    ${clkFn(2)}(${clkMacro(2, "AFIO")}, ENABLE);`);
      }
      const lines = Object.entries(cfg.channels ?? {})
        .filter(([, ch]) => ch.enabled && ch.mode && ch.mode !== "disable")
        .map(([key, ch]) => ({ key, ch, n: Number(key.replace(/^LINE/, "")) }))
        .filter((x) => Number.isFinite(x.n))
        .sort((a, b) => a.n - b.n);
      if (lines.length === 0) {
        L.push(`    /* EXTI: 没有启用任何中断线 */`);
        break;
      }
      // 中断源引脚要先开端口时钟并配成输入，否则 EXTI 采样不到电平
      const extiPorts = portClocksOf(lines.map((x) => x.ch.pin ?? null));
      if (extiPorts) {
        L.push(`    GPIO_InitTypeDef gpio = {0};`);
        L.push(`    ${clkFn(2)}(${extiPorts}, ENABLE);`);
        for (const { ch } of lines) {
          if (!ch.pin) continue;
          L.push(`    /* ${ch.pin} 作为中断输入 */`);
          gpioSetup(ch.pin, "GPIO_Mode_IPU");
        }
      }
      for (const { n, ch } of lines) {
        const pin = ch.pin;
        const trig =
          ch.mode === "both" ? "Rising_Falling" : ch.mode === "falling" ? "Falling" : "Rising";
        if (pin) {
          L.push(`    /* ${pin} → EXTI${n} */`);
          L.push(`    GPIO_EXTILineConfig(GPIO_PortSource${portOf(pin)}, GPIO_PinSource${pin.slice(2)});`);
        } else {
          L.push(`    /* EXTI${n}: 未分配引脚，仅配置触发条件 */`);
        }
        L.push(`    exti.EXTI_Line = EXTI_Line${n};`);
        L.push(`    exti.EXTI_Mode = EXTI_Mode_${v["eventMode"] ? "Event" : "Interrupt"};`);
        L.push(`    exti.EXTI_Trigger = EXTI_Trigger_${trig};`);
        L.push(`    exti.EXTI_LineCmd = ENABLE;`);
        L.push(`    EXTI_Init(&exti);`);
      }
      break;
    }
    case "CLK": {
      const hse = String(v["hse"]);
      const lse = String(v["lse"]);
      if (hse !== "off") {
        L.push(`    /* HSE ${hse === "bypass" ? "旁路时钟输入" : "外部晶体"} */`);
        L.push(`    RCC_HSEConfig(${hse === "bypass" ? "RCC_HSE_Bypass" : "RCC_HSE_ON"});`);
        if (v["waitHse"]) {
          L.push(`    while (RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET) { }`);
        }
      }
      if (lse !== "off") {
        L.push(`    /* LSE ${lse === "bypass" ? "旁路时钟输入" : "32.768 kHz 晶体"}（后备域，需要先开 PWR/BKP 时钟） */`);
        L.push(`    ${clkFn(1)}(${clkMacro(1, "PWR")} | ${clkMacro(1, "BKP")}, ENABLE);`);
        L.push(`    PWR_BackupAccessCmd(ENABLE);`);
        L.push(`    RCC_LSEConfig(${lse === "bypass" ? "RCC_LSE_Bypass" : "RCC_LSE_ON"});`);
        if (v["waitLse"]) {
          L.push(`    while (RCC_GetFlagStatus(RCC_FLAG_LSERDY) == RESET) { }`);
        }
      }
      if (hse === "off" && lse === "off") {
        L.push(`    /* HSE / LSE 均未启用 */`);
      }
      break;
    }
    case "DBG": {
      // 关掉 SDI：两个调试脚释放成普通 GPIO。这一句要在最前面，
      // 否则后面给这两个脚配 GPIO 会被调试口抢回去。
      if (String(v["iface"]) === "off") {
        L.push(`    /* 关闭 SDI，释放 ${dev.debug?.swdio ?? "SWDIO"} / ${dev.debug?.swclk ?? "SWCLK"} 为普通 GPIO */`);
        L.push(`    ${clkFn(2)}(${clkMacro(2, "AFIO")}, ENABLE);`);
        L.push(`    GPIO_PinRemapConfig(GPIO_Remap_SWJ_Disable, ENABLE);`);
      }
      const freezes: string[] = [];
      if (v["freezeIwdg"]) freezes.push("DBGMCU_IWDG_STOP");
      if (v["freezeWwdg"]) freezes.push("DBGMCU_WWDG_STOP");
      if (v["freezeTim"]) {
        for (const p of dev.peripherals) {
          if (p.kind !== "TIM") continue;
          if (!project.configs[p.id]?.enabled) continue;
          freezes.push(`DBGMCU_${p.id}_STOP`);
        }
      }
      if (v["freezeSleep"]) freezes.push("DBGMCU_SLEEP", "DBGMCU_STOP", "DBGMCU_STANDBY");
      for (const f of [...new Set(freezes)]) {
        L.push(`    DBGMCU_Config(${f}, ENABLE); /* 调试器停住时冻结，不影响脱机运行 */`);
      }
      if (std_iface_unset(v)) {
        L.push(`    /* 保持 SDI 默认开启（复位状态） */`);
      }
      break;
    }
    default: {
      // 还没建模的外设（OPA / CMP / USB / PIOC / CAN）：至少把时钟开上，
      // 并明确写出「这里要你自己填」。假装生成了一半反而更难查。
      const clkLine = fallbackClock(id, kind, api, dev.buses?.[id]);
      if (clkLine) L.push(`    ${clkLine}`);
      L.push(`    /* TODO: ${id}（${kind}）的初始化还没生成 ——`);
      L.push(`     * 参考 EVT 里 ${kind === "OPA" ? "OPA/OPA" : kind === "CMP" ? "OPA/CMP" : kind} 例程，`);
      L.push(`     * 或在器件手册里查 ${fallbackRegHint(kind)} 的配置位。 */`);
    }
  }

  // ── DMA ──
  // 放在最后：通道初始化要引用已经配好的外设寄存器，且顺序上先开外设再开 DMA。
  const dmas = cfg.dmaChannels ?? [];
  if (dmas.length > 0) {
    L.push(``);
    L.push(`    /* ── DMA（${dmas.length} 条通道） ── */`);
    L.push(`    {`);
    L.push(`    DMA_InitTypeDef dma = {0};`);
    // 多控制器器件（如 CH32V407 有 DMA1+DMA2）要为每个被用到的控制器分别开时钟
    const dmaCtrls = [...new Set(dmas.map((d) => dmaRef(dev, d.channel).ctrl))];
    for (const c of dmaCtrls) {
      L.push(`    ${clkFn("AHB")}(${clkMacro("AHB", c)}, ENABLE);`);
    }
    for (const d of dmas) {
      dmaInitLines(L, dev, id, d, "rfr_dma_buf");
    }
    // 外设侧要把 DMA 请求打开，否则通道开着也不会有请求进来
    const reqs = dmas.map((d) => d.request);
    if (kind === "USART") {
      if (reqs.some((r) => r.endsWith("_RX"))) L.push(`    USART_DMACmd(${id}, USART_DMAReq_Rx, ENABLE);`);
      if (reqs.some((r) => r.endsWith("_TX"))) L.push(`    USART_DMACmd(${id}, USART_DMAReq_Tx, ENABLE);`);
    } else if (kind === "SPI") {
      if (reqs.some((r) => r.endsWith("_RX"))) L.push(`    SPI_I2S_DMACmd(${id}, SPI_I2S_DMAReq_Rx, ENABLE);`);
      if (reqs.some((r) => r.endsWith("_TX"))) L.push(`    SPI_I2S_DMACmd(${id}, SPI_I2S_DMAReq_Tx, ENABLE);`);
    } else if (kind === "I2C") {
      L.push(`    I2C_DMACmd(${id}, ENABLE);`);
    } else if (kind === "ADC") {
      L.push(`    ADC_DMACmd(${id}, ENABLE);`);
    } else if (kind === "TIM") {
      // TIM 侧要把对应的 DMA 请求打开，且源名与请求名不是同一套写法：
      // TIM1_CH2 → TIM_DMA_CC2，TIM1_UP → TIM_DMA_Update，依此类推
      for (const r of [...new Set(reqs)]) {
        const src = timDmaSource(r);
        if (src) L.push(`    TIM_DMACmd(${id}, ${src}, ENABLE);`);
      }
    }
    L.push(`    }`);
  }
  return L;
}

/** 关掉 SDI 之外还有一种情况：选了单线（本系列不支持时不该走到这里） */
function std_iface_unset(v: Record<string, string | number | boolean>): boolean {
  return String(v["iface"]) !== "off";
}

function flowOf(v: string): string {
  switch (v) {
    case "RTS":
      return "RTS";
    case "CTS":
      return "CTS";
    case "RTS_CTS":
      return "RTS_CTS";
    default:
      return "None";
  }
}

function modeOfUsart(dir: string): string {
  switch (dir) {
    case "RX":
      return "USART_Mode_Rx";
    case "TX":
      return "USART_Mode_Tx";
    default:
      return "USART_Mode_Tx | USART_Mode_Rx";
  }
}

function counterModeOf(m: string): string {
  switch (m) {
    case "down":
      return "TIM_CounterMode_Down";
    case "center1":
      return "TIM_CounterMode_CenterAligned1";
    case "center2":
      return "TIM_CounterMode_CenterAligned2";
    case "center3":
      return "TIM_CounterMode_CenterAligned3";
    default:
      return "TIM_CounterMode_Up";
  }
}

function ocModeOf(mode: string, pwm: string): string {
  if (mode === "pwm") return pwm === "2" ? "TIM_OCMode_PWM2" : "TIM_OCMode_PWM1";
  if (mode === "oc") return "TIM_OCMode_Toggle";
  if (mode === "ic") return "TIM_OCMode_Timing";
  return "TIM_OCMode_Inactive";
}

/* ───────────────────────────── main.c ───────────────────────────── */

function genMain(project: Project, dev: DeviceDef, stamp: string, hdr: string, mrs: boolean): string {
  const L: string[] = [];
  L.push(`/*`);
  L.push(` * ${project.settings.name}`);
  L.push(` * 器件   : ${dev.id} (${dev.core})`);
  L.push(` * 封装   : ${dev.package.label}`);
  L.push(` * 生成于 : ${stamp}  by RiskFiveRuler`);
  L.push(` */`);
  if (mrs) {
    // MRS / EVT 例程的惯例：debug.h 提供 Delay_* 与 printf 重定向
    L.push(`#include "debug.h"`);
  } else {
    L.push(`#include "${hdr}.h"`);
  }
  L.push(`#include "rfr_init.h"`);
  L.push(``);
  L.push(`int main(void)`);
  L.push(`{`);
  // 优先级分组：X035 只有 Group_0/1；V407 根本没有这个函数（走 CMSIS 接口）
  const api = apiOf(dev);
  if ((api.nvicApi ?? "stdlib") === "stdlib" && api.nvicGroups.length > 0) {
    const grp = Math.max(...api.nvicGroups);
    L.push(`    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_${grp});`);
  }
  if (mrs) {
    L.push(`    SystemCoreClockUpdate();`);
    L.push(`    Delay_Init();`);
    // L103 的 debug.h 没有 SDI 打印（`SDI_PRINT` 宏都不存在），
    // 无条件生成那段 #if 会直接编译失败 —— 按器件能力选，不按系列名猜
    if (api.sdiPrintf === false) {
      L.push(`    USART_Printf_Init(115200);`);
    } else {
      L.push(`#if (SDI_PRINT == SDI_PR_OPEN)`);
      L.push(`    SDI_Printf_Enable();`);
      L.push(`#else`);
      L.push(`    USART_Printf_Init(115200);`);
      L.push(`#endif`);
    }
    L.push(`    printf("SystemClk:%d\\r\\n", SystemCoreClock);`);
    L.push(`    printf("ChipID:%08x\\r\\n", DBGMCU_GetCHIPID());`);
  }
  L.push(`    RFR_ClockInit();`);
  L.push(`    RFR_GPIOInit();`);
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || p.kind === "GPIO" || p.kind === "SYSTEM") continue;
    L.push(`    RFR_${p.id}_Init();`);
  }
  L.push(`    RFR_NVICInit();`);
  L.push(``);
  L.push(`    while (1)`);
  L.push(`    {`);
  L.push(`    }`);
  L.push(`}`);
  L.push(``);
  return L.join("\n");
}

/* ───────────────────────────── MRS 工程骨架 ───────────────────────────── */

function genMrsTemplate(project: Project, dev: DeviceDef, name: string): string {
  const ports = new Set(dev.package.pins.filter((p) => p.kind === "io").map((p) => p.name.slice(0, 2)));
  const desc =
    `ROM(byte): ${dev.flashKb}K, SRAM(byte): ${dev.ramKb}K, CHIP PINS: ${dev.package.pins.length}, ` +
    `GPIO PORTS: ${ports.size}.\nGenerated by RiskFiveRuler for ${dev.id}.`;
  // 键序与 EVT 自带 .template 一致（照着那份抄的，MRS 读起来最稳）
  return [
    `Mcu Type=${dev.family}`,
    "Address=0x08000000",
    `Target Path=obj/${name}.hex`,
    "Erase All=true",
    "Program=true",
    "Verify=true",
    "Reset=true",
    "",
    "Vendor=WCH",
    "Link=WCH-Link",
    "Toolchain=RISC-V",
    `Series=${dev.family}`,
    `Description=${desc}`,
    `PeripheralVersion=${dev.peripheralVersion ?? "1.0"}`,
    `MCU=${dev.id}`,
    "",
  ].join("\n");
}

function genConfHeader(dev: DeviceDef, hdr: string): string {
  const L: string[] = [];
  L.push(`/* ${dev.id} — 库配置文件，由 RiskFiveRuler 生成 */`);
  L.push(`#ifndef __${hdr.toUpperCase()}_CONF_H`);
  L.push(`#define __${hdr.toUpperCase()}_CONF_H`);
  L.push(``);
  // 每个头文件都用 __has_include 兜底：各系列的驱动集合并不一致
  // （X035 没有 crc.h / bkp.h / can.h / rtc.h / cmp.h / lptim.h，
  //  而 L103 有 cmp.h 却没有 can.h 的可能），硬列清单迟早会踩空。
  const mods = [
    "adc", "awu", "bkp", "can", "cmp", "crc", "dbgmcu", "dma", "exti", "flash",
    "gpio", "i2c", "iwdg", "lptim", "misc", "opa", "pwr", "rcc", "rtc", "spi",
    "tim", "usart", "usb", "usbpd", "wwdg",
  ];
  L.push(`#if defined(__has_include)`);
  for (const m of mods) {
    L.push(`#  if __has_include("${hdr}_${m}.h")`);
    L.push(`#    include "${hdr}_${m}.h"`);
    L.push(`#  endif`);
  }
  L.push(`#endif`);
  L.push(`#include "${hdr}_it.h"`);
  L.push(``);
  L.push(`#endif /* __${hdr.toUpperCase()}_CONF_H */`);
  return L.join("\n") + "\n";
}

function genItHeader(project: Project, dev: DeviceDef, hdr: string): string {
  const L: string[] = [];
  L.push(`/* ${project.settings.name} — 中断服务函数声明，由 RiskFiveRuler 生成 */`);
  L.push(`#ifndef __${hdr.toUpperCase()}_IT_H`);
  L.push(`#define __${hdr.toUpperCase()}_IT_H`);
  L.push(``);
  L.push(`#include "debug.h"`);
  L.push(``);
  L.push(`#endif /* __${hdr.toUpperCase()}_IT_H */`);
  return L.join("\n") + "\n";
}

function genItSource(project: Project, dev: DeviceDef, hdr: string): string {
  const L: string[] = [];
  L.push(`/* ${project.settings.name} — 中断服务函数，由 RiskFiveRuler 生成 */`);
  L.push(`#include "${hdr}_it.h"`);
  L.push(``);
  // WCH 的 RISC-V GCC 用 interrupt("WCH-Interrupt-fast") 说明这是硬件中断入口
  // （省掉寄存器压栈，速度更快）。收进一个宏，换编译器时只改这一行。
  L.push(`#ifndef RFR_ISR`);
  L.push(`#  define RFR_ISR __attribute__((interrupt("WCH-Interrupt-fast")))`);
  L.push(`#endif`);
  L.push(``);
  const handled = new Set<string>();
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || !cfg.nvic?.enabled) continue;
    for (const irq of p.irq ?? []) {
      if (irq.gate) {
        const gates = Array.isArray(irq.gate) ? irq.gate : [irq.gate];
        if (!gates.some((k) => cfg.params[k] === true || cfg.params[k] === "true")) continue;
      }
      const h = `${irq.name}_IRQHandler`;
      if (handled.has(h)) continue;
      handled.add(h);
      L.push(`void ${h}(void) RFR_ISR;`);
    }
  }
  L.push(``);
  L.push(`void NMI_Handler(void) RFR_ISR;`);
  L.push(`void HardFault_Handler(void) RFR_ISR;`);
  L.push(``);
  L.push(`void NMI_Handler(void)`);
  L.push(`{`);
  L.push(`    while (1) { }`);
  L.push(`}`);
  L.push(``);
  L.push(`void HardFault_Handler(void)`);
  L.push(`{`);
  L.push(`    while (1) { }`);
  L.push(`}`);
  L.push(``);
  for (const p of dev.peripherals) {
    const cfg = project.configs[p.id];
    if (!cfg?.enabled || !cfg.nvic?.enabled) continue;
    for (const irq of p.irq ?? []) {
      if (irq.gate) {
        const gates = Array.isArray(irq.gate) ? irq.gate : [irq.gate];
        if (!gates.some((k) => cfg.params[k] === true || cfg.params[k] === "true")) continue;
      }
      const h = `${irq.name}_IRQHandler`;
      if (!handled.has(h)) continue;
      handled.delete(h);
      L.push(`/* ${p.id}: ${irq.desc ?? irq.name} */`);
      L.push(`void ${h}(void)`);
      L.push(`{`);
      L.push(`    /* TODO: 读状态位、处理、清标志 */`);
      L.push(`}`);
      L.push(``);
    }
  }
  return L.join("\n");
}

function genSystemHeader(hdr: string): string {
  const H = hdr.toUpperCase();
  return `#ifndef __SYSTEM_${H}_H
#define __SYSTEM_${H}_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern uint32_t SystemCoreClock;
extern const uint8_t AHBPrescTable[16];

void SystemInit(void);
void SystemCoreClockUpdate(void);

#ifdef __cplusplus
}
#endif

#endif /* __SYSTEM_${H}_H */
`;
}

function genSystemSource(project: Project, dev: DeviceDef, clk: ReturnType<typeof solveClock>, hdr: string): string {
  const hz = Math.round(clk.sysclk * 1e6);
  const L: string[] = [];
  L.push(`/* ${project.settings.name} — 系统初始化，由 RiskFiveRuler 生成`);
  L.push(` *`);
  L.push(` * 时钟的具体配置在 main() 里的 RFR_ClockInit() 中完成，`);
  L.push(` * 这里只在启动早期把 SystemCoreClock 对齐到目标频率，`);
  L.push(` * 供 Delay_Init() / USART_Printf_Init() 等依赖主频的例程使用。`);
  L.push(` */`);
  L.push(`#include "${hdr}.h"`);
  L.push(`#include "system_${hdr}.h"`);
  L.push(``);
  L.push(`uint32_t SystemCoreClock = ${hz}; /* ${clk.sysclk} MHz */`);
  L.push(``);
  L.push(`const uint8_t AHBPrescTable[16] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 7, 8, 9};`);
  L.push(``);
  L.push(`void SystemInit(void)`);
  L.push(`{`);
  L.push(`    /* 复位后默认跑 HSI，时钟切换交给 RFR_ClockInit() */`);
  L.push(`}`);
  L.push(``);
  L.push(`void SystemCoreClockUpdate(void)`);
  L.push(`{`);
  L.push(`    SystemCoreClock = ${hz};`);
  L.push(`}`);
  L.push(``);
  return L.join("\n");
}

/* ───────────────────────────── Makefile ───────────────────────────── */

function genMakefile(project: Project, dev: DeviceDef, hdr: string): string {
  const march = dev.core.includes("RV32EC") ? "rv32ec_zicsr" : "rv32imac_zicsr";
  const mabi = dev.core.includes("RV32EC") ? "ilp32e" : "ilp32";
  return `# ${project.settings.name} — 由 RiskFiveRuler 生成
# 工具链：MounRiver / WCH riscv-none-embed-gcc
TOOLCHAIN_PATH ?= C:/MounRiver/MounRiver_Studio/toolchain/RISC-V Embedded GCC/bin
PREFIX        := riscv-none-embed-
CC            := $(TOOLCHAIN_PATH)/$(PREFIX)gcc
OBJCOPY       := $(TOOLCHAIN_PATH)/$(PREFIX)objcopy
SIZE          := $(TOOLCHAIN_PATH)/$(PREFIX)size

TARGET  := ${project.settings.name}
BUILD   := build

CORE    := -march=${march} -mabi=${mabi} -msmall-data-limit=8 -mno-save-restore
CFLAGS  := $(CORE) -Os -g -Wall -ffunction-sections -fdata-sections -fno-common
INCLUDE := -ICore/Inc -ISDK/Core -ISDK/Peripheral/inc -ISDK/Debug
LDFLAGS := $(CORE) -T SDK/Ld/Link.ld -nostartfiles -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map

SRCS := Core/Src/main.c Core/Src/rfr_init.c
SRCS += SDK/Core/core_riscv.c SDK/Startup/startup_${hdr}.S
SRCS += SDK/Debug/debug.c
SRCS += $(wildcard SDK/Peripheral/src/*.c)

OBJS := $(addprefix $(BUILD)/,$(notdir $(SRCS:.c=.o)))
vpath %.c $(sort $(dir $(SRCS)))

all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).hex $(BUILD)/$(TARGET).bin

$(BUILD)/%.o: %.c | $(BUILD)
\t$(CC) -c $(CFLAGS) $(INCLUDE) $< -o $@

$(BUILD)/%.o: %.S | $(BUILD)
\t$(CC) -c $(CFLAGS) $(INCLUDE) $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJS) | $(BUILD)
\t$(CC) $(LDFLAGS) $^ -o $@
\t$(SIZE) $@

$(BUILD)/%.hex: $(BUILD)/%.elf
\t$(OBJCOPY) -O ihex $< $@

$(BUILD)/%.bin: $(BUILD)/%.elf
\t$(OBJCOPY) -O binary $< $@

$(BUILD):
\tmkdir -p $(BUILD)

clean:
\trm -rf $(BUILD)

flash: $(BUILD)/$(TARGET).hex
\twchisp flash $(BUILD)/$(TARGET).hex

.PHONY: all clean flash
`;
}

/* ───────────────────────────── README ───────────────────────────── */

function genReadme(project: Project, dev: DeviceDef, clk: ReturnType<typeof solveClock>, mrs: boolean): string {
  const usage = collectUsage(project, dev);
  const rows = usage
    .map((u) => `| ${u.pin} | ${u.fn} | ${u.owner} |`)
    .join("\n");
  const enabled = dev.peripherals.filter((p) => project.configs[p.id]?.enabled).map((p) => p.id);
  const hdr = dev.family.toLowerCase();
  const name = mrsProjectName(project);
  const layout = mrs
    ? `\`\`\`
.project / .cproject / .template   MounRiver Studio 工程文件
User/main.c                        主程序（MRS 例程风格：debug.h + printf）
User/rfr_pinmap.h                  引脚宏
User/rfr_init.c                    外设初始化
User/${hdr}_it.c                   中断服务函数
User/${hdr}_conf.h                 库配置头
User/system_${hdr}.c               SystemCoreClock
\`\`\`

## 在 MounRiver Studio 里打开

1. 把导出的整个文件夹放到 WCH 官方 EVT 的 \`EXAM/\` 目录下（和 \`GPIO_Toggle\` 等例程平级），
   目录名保持 \`${name}\`。
2. MRS → File → Import → Existing Projects into Workspace，选中该文件夹。
   \`Core\` / \`Startup\` / \`Ld\` / \`Peripheral\` / \`Debug\` 五个目录通过
   linkedResources 指向 \`../SRC/\` 下的公共代码，不需要拷贝。
3. 直接 Build。产物在 \`obj/${name}.hex\`。

> \`.wvproj\` 是 WCH 加密的调试器配置文件，MRS 在首次保存工程时会自动生成，导出时不包含。
`
    : `\`\`\`
Core/Inc/rfr_pinmap.h   引脚宏
Core/Inc/rfr_init.h     初始化声明
Core/Src/rfr_init.c     外设初始化
Core/Src/main.c         主程序
Makefile                构建脚本
\`\`\`

把 \`Core/\` 覆盖到 WCH 官方 EVT 模板的对应目录，\`SDK/\` 指向 EVT 里的 \`Peripheral\` 与 \`Core\` 即可编译。`;

  return `# ${project.settings.name}

由 **RiskFiveRuler** 生成。

## 器件

| 项目 | 值 |
| --- | --- |
| 型号 | ${dev.id} |
| 家族 | ${dev.family} |
| 内核 | ${dev.core} |
| 封装 | ${dev.package.label} |
| Flash / RAM | ${dev.flashKb} KB / ${dev.ramKb} KB |
| 供电 | ${dev.voltage} |

## 时钟

| 节点 | 频率 |
| --- | --- |
| SYSCLK | ${clk.sysclk} MHz |
| HCLK | ${clk.hclk} MHz |
| PCLK1 (APB1) | ${clk.pclk1} MHz |
| PCLK2 (APB2) | ${clk.pclk2} MHz |
| ADCCLK | ${clk.adcclk} MHz |

## 已启用外设

${enabled.length ? enabled.map((e) => `- ${e}`).join("\n") : "_无_"}

## 引脚分配

| 引脚 | 信号 | 外设 |
| --- | --- | --- |
${rows || "| — | — | — |"}

## 目录结构

${layout}
`;
}
