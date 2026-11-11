import type { ClockConfig, ClockDerived, ClockTopology } from "../model/types";

/**
 * 时钟树求解。
 *
 * CH32V 系列的时钟结构和 STM32F1 同源：HSI / HSE → PLL → SYSCLK → AHB → APB1/APB2。
 * 差别在于 CH32V003 没有 HSE、PLL 输入固定为 HSI/2。这里把差异全部收进 ClockTopology，
 * 求解逻辑保持通用，新增芯片只要给出拓扑即可。
 */
export function solveClock(topo: ClockTopology, cfg: ClockConfig): ClockDerived {
  const errors: string[] = [];
  const warnings: string[] = [];

  const hsi = topo.hsi;
  const hse = cfg.hseFreq;
  const hasHse = topo.hseOptions.length > 0;
  const hasPll = topo.pllMax > 1;

  let pllIn = 0;
  let pllOut = 0;
  let sysclk = 0;

  /**
   * PLL 是时钟树里独立的一级，与「SYSCLK 取自哪」无关 ——
   * 即使系统时钟直接跑 HSI，PLL 卡片也要显示它本来会输出多少。
   * 以前这段算在 else 分支里，选 HSI 作 SYSCLK 之后 PLL 就变成
   * 「0 MHz × 8 = 0 MHz」，看着像配置坏了。
   */
  if (hasPll) {
    if (topo.pllSource === "HSI_DIV2") pllIn = hsi / 2;
    else if (topo.pllSource === "HSI") pllIn = hsi;
    else pllIn = hse;

    if (topo.pllSource === "HSE" && !hasHse) {
      errors.push("PLL 输入为 HSE，但该器件没有外部晶振");
    }
    if (cfg.pllMul < topo.pllMin || cfg.pllMul > topo.pllMax) {
      errors.push(`PLL 倍频 ${cfg.pllMul} 超出范围 ${topo.pllMin}..${topo.pllMax}`);
    }
    if (pllIn > 0) pllOut = pllIn * cfg.pllMul;
  }

  if (cfg.sysclkSource === "HSI") {
    sysclk = hsi;
  } else if (cfg.sysclkSource === "HSE") {
    if (!hasHse) {
      errors.push("该器件没有 HSE，无法选择外部晶振作为系统时钟");
      sysclk = hsi;
    } else {
      sysclk = hse;
    }
  } else {
    if (!hasPll) {
      errors.push("该器件没有 PLL，SYSCLK 只能取自 HSI");
      sysclk = hsi;
    } else {
      sysclk = pllOut;
    }
  }

  if (sysclk > topo.maxSysclk) {
    errors.push(`SYSCLK ${fmt(sysclk)} MHz 超过器件上限 ${topo.maxSysclk} MHz`);
  }

  const hclk = sysclk / cfg.ahbDiv;
  const pclk1 = hclk / cfg.apb1Div;
  const pclk2 = hclk / cfg.apb2Div;
  const adcclk = pclk2 / cfg.adcDiv;

  if (adcclk > 14) {
    warnings.push(`ADCCLK = ${fmt(adcclk)} MHz 超过 14 MHz，转换精度会下降`);
  }
  if (cfg.sysclkSource === "PLL" && sysclk >= 24 && sysclk <= 48) {
    warnings.push("建议在 Flash 面板把等待周期设为 1（fSYSCLK ≤ 48 MHz）");
  }
  if (cfg.sysclkSource === "PLL" && sysclk > 48) {
    warnings.push("fSYSCLK > 48 MHz 时需要 2 个 Flash 等待周期");
  }

  return {
    sysclk,
    hclk,
    pclk1,
    pclk2,
    adcclk,
    pllIn,
    pllOut,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function defaultClock(topo: ClockTopology): ClockConfig {
  // 没有 PLL 的器件（如 CH32X035）只能跑内部 RC
  const hasPll = topo.pllMax > 1;
  const mul = hasPll
    ? Math.min(
    topo.pllMax,
        Math.round(topo.maxSysclk / (topo.pllSource === "HSI_DIV2" ? topo.hsi / 2 : topo.hsi)),
      )
    : 1;
  // ADC 分频要保证 ADCCLK ≤ 14 MHz，挑第一个满足条件的
  const sysclk = hasPll
    ? topo.pllSource === "HSI_DIV2"
      ? (topo.hsi / 2) * mul
      : topo.hsi * mul
    : topo.hsi;
  const pclk2 = sysclk;
  const divs = topo.adcDivs ?? [2, 4, 6, 8];
  const adcDiv = divs.find((d) => pclk2 / d <= 14) ?? divs[divs.length - 1] ?? 6;

  return {
    sysclkSource: hasPll ? "PLL" : "HSI",
    hseFreq: topo.hseOptions[0] ?? 0,
    pllMul: mul,
    ahbDiv: 1,
    apb1Div: 1,
    apb2Div: 1,
    adcDiv,
    lsiEnabled: true,
    hseBypass: false,
  };
}

/**
 * 一键设定目标工作频率（对齐 STM32CubeMX 的体验）。
 *
 * 用户只给一个 SYSCLK 期望值，时钟源 / 倍频 / 总线分频全部由这里求解：
 *   · 穷举 HSI 直驱、HSE 直驱、PLL 每一档倍频（含 HSE 全部可选晶振）；
 *   · 超 maxSysclk 的组合直接丢弃；
 *   · 按「|实际 − 目标| 最小」挑，误差相同优先先出现的（HSI → HSE → PLL）；
 *   · 总线全速（AHB / APB1 / APB2 分频 = 1），ADC 分频取第一个满足 ≤ 14 MHz 的档。
 * 找不到任何可达组合返回 null（目标 < 最低直驱频率之类），调用方提示用户。
 */
export function solveClockForTarget(topo: ClockTopology, targetMhz: number): ClockConfig | null {
  if (!Number.isFinite(targetMhz) || targetMhz <= 0) return null;
  const target = Math.min(targetMhz, topo.maxSysclk);
  const divs = topo.adcDivs ?? [2, 4, 6, 8];

  const build = (sysclkSource: ClockConfig["sysclkSource"], hseFreq: number, pllMul: number): ClockConfig => ({
    sysclkSource,
    hseFreq,
    pllMul,
    ahbDiv: 1,
    apb1Div: 1,
    apb2Div: 1,
    // ADC 全速跑不动时取最后一档（最慢），至少不超标
    adcDiv: divs.find((d) => target / d <= 14) ?? divs[divs.length - 1] ?? 6,
    lsiEnabled: true,
    hseBypass: false,
  });

  const cands: { cfg: ClockConfig; sysclk: number }[] = [];
  const consider = (cfg: ClockConfig, sysclk: number) => {
    if (sysclk <= 0 || sysclk > topo.maxSysclk) return;
    cands.push({ cfg, sysclk });
  };

  // HSI 直驱
  consider(build("HSI", 0, 1), topo.hsi);
  // HSE 直驱
  for (const f of topo.hseOptions) consider(build("HSE", f, 1), f);
  // PLL（输入源由拓扑决定；HSE 源时每档可选晶振都试）
  if (topo.pllMax > 1) {
    const pllIn = topo.pllSource === "HSI_DIV2" ? topo.hsi / 2 : topo.pllSource === "HSI" ? topo.hsi : 0;
    if (pllIn > 0) {
      for (let m = topo.pllMin; m <= topo.pllMax; m++) {
        consider(build("PLL", topo.hseOptions[0] ?? 0, m), pllIn * m);
      }
    } else {
      for (const f of topo.hseOptions) {
        for (let m = topo.pllMin; m <= topo.pllMax; m++) {
          consider(build("PLL", f, m), f * m);
        }
      }
    }
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => Math.abs(a.sysclk - target) - Math.abs(b.sysclk - target));
  return cands[0]!.cfg;
}

/**
 * USB 全速 PHY 对 SYSCLK 的要求：48 MHz 由 PLL/分频派生，
 * 常见可用主频为 48 / 72 / 96 / 144 MHz（分别对应 /1、/1.5、/2、/3）。
 * 只要主频落在这几个值上就能给出 48 MHz 的 USB 时钟。
 */
export const USB_SYSCLK_VALUES = [48, 72, 96, 144];

export function usbClockValid(sysclkMhz: number): boolean {
  return USB_SYSCLK_VALUES.includes(Math.round(sysclkMhz));
}

/** 某份 ClockConfig 实际跑出来的 SYSCLK（MHz） */
export function actualSysclk(cfg: ClockConfig, topo: ClockTopology): number {
  if (cfg.sysclkSource === "HSI") return topo.hsi;
  if (cfg.sysclkSource === "HSE") return cfg.hseFreq;
  const pllIn =
    topo.pllSource === "HSI_DIV2" ? topo.hsi / 2 : topo.pllSource === "HSI" ? topo.hsi : cfg.hseFreq;
  return pllIn * cfg.pllMul;
}

export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, "");
}

/** 由波特率反推 BRR（CH32V/STM32F1 风格：整数 + 4 位小数）。pclk 单位为 MHz */
export function usartBrr(pclkMhz: number, baud: number, oversampling: 8 | 16) {
  if (baud <= 0) return { brr: 0, actual: 0, error: 0 };
  const pclk = pclkMhz * 1e6;
  const div = pclk / (oversampling === 16 ? 16 : 8) / baud;
  const mantissa = Math.floor(div);
  const fraction = Math.round((div - mantissa) * (oversampling === 16 ? 16 : 8));
  const brr = (mantissa << 4) | (fraction & 0xf);
  const actual = pclk / (oversampling === 16 ? 16 : 8) / (mantissa + fraction / (oversampling === 16 ? 16 : 8));
  const error = ((actual - baud) / baud) * 100;
  return { brr, actual, error };
}

/** I2C CCR / TRISE 计算 */
export function i2cTiming(pclk1: number, khz: number, fast: boolean) {
  const target = Math.max(10, Math.min(fast ? 400 : 100, khz));
  const ccr = Math.max(4, Math.round((pclk1 * 1e6) / (2 * target * 1e3)));
  const trise = fast ? Math.round((pclk1 * 1e6 * 300) / 1e9) + 1 : pclk1 + 1;
  const actual = (pclk1 * 1e6) / (2 * ccr) / 1000;
  return { ccr, trise, actual };
}

/** SPI 分频到实际 SCK */
export function spiClock(pclk: number, prescaler: number) {
  return pclk / prescaler;
}

/** 定时器时基 */
export function timBase(pclk: number, psc: number, arr: number, mode: string) {
  const cnt = pclk * 1e6 / (psc + 1);
  const period = mode.startsWith("center") ? (2 * arr) / cnt : (arr + 1) / cnt;
  return { cntFreq: cnt, period, freq: period > 0 ? 1 / period : 0 };
}
