import type { ChannelCfg, DeviceDef, GpioCfg, PeripheralConfig, Project, ProjectSettings } from "../model/types";
import { defaultClock } from "../engine/clock";
import { defaultParams, schemaFor } from "../semantic/schemas";
import { defaultDmaChannel } from "../engine/dma";
import { collectUsage, groupPinsFor, planPins, remapGroupsOf, requiredInMode } from "../semantic/pinmux";

export const FORMAT_VERSION = 1;

export function createProject(dev: DeviceDef, name = "RFR_Project"): Project {
  const configs: Record<string, PeripheralConfig> = {};
  for (const p of dev.peripherals) {
    configs[p.id] = emptyConfig(p.id, p.schema);
  }
  const gpio: Record<string, GpioCfg> = {};
  for (const pin of dev.package.pins) {
    if (pin.kind === "io") gpio[pin.name] = { mode: "analog", pull: "none", speed: "2" };
  }
  const project: Project = {
    formatVersion: FORMAT_VERSION,
    deviceId: dev.id,
    clock: defaultClock(dev.clock),
    configs,
    gpio,
    pinLabels: {},
    settings: defaultSettings(name),
    resetPin: firstResetPin(dev),
  };
  enableDebugInterface(project, dev);
  return project;
}

/** 封装上第一个可作 RESET 的引脚（多个候选取第一个 = 上电默认那颗；没有则 undefined） */
export function firstResetPin(dev: DeviceDef): string | undefined {
  return dev.package.pins.find((p) => p.kind === "reset")?.name;
}

/**
 * 调试接口复位后是**默认开启**的，所以新建工程就把 DBG 打开、把 SWDIO/SWCLK
 * 落到数据手册指定的引脚上 —— 否则引脚图上这两个脚看起来是空的，
 * 而实际板子上调试器正连着它们，一配成别的功能就废了。
 */
export function enableDebugInterface(project: Project, dev: DeviceDef): void {
  const cfg = project.configs["DBG"];
  if (!cfg || !dev.debug?.twoWire) return;
  cfg.enabled = true;
  cfg.mode = "sdio2";
  cfg.params["iface"] = "sdio2";
  const pins: Record<string, string | null> = { ...cfg.pins };
  if (dev.debug.swdio) pins["SWDIO"] = dev.debug.swdio;
  if (dev.debug.swclk) pins["SWCLK"] = dev.debug.swclk;
  cfg.pins = pins;
}

/**
 * 老工程文件里是单条 `dma`，现在换成数组 `dmaChannels`。
 * 就地迁移，读一次之后写回去就是新格式。
 */
export function migrateProject(project: Project): Project {
  let touched = false;
  const configs: Record<string, PeripheralConfig> = {};
  for (const [id, cfg] of Object.entries(project.configs)) {
    const old = cfg.dma;
    if (!old) {
      configs[id] = cfg;
      continue;
    }
    touched = true;
    const next: PeripheralConfig = { ...cfg };
    if (!next.dmaChannels?.length) {
      next.dmaChannels = [
        {
          request: `${id}_TX`,
          channel: old.channel,
          dir: old.dir,
          mode: old.mode,
          priority: old.priority,
          width: old.width,
          incMem: old.incMem,
        },
      ];
    }
    delete next.dma;
    configs[id] = next;
  }
  return touched ? { ...project, configs } : project;
}

/**
 * 关掉一个外设并释放它占用的**全部引脚**。
 *
 * 用在「无法启用」的提示里：别的外设霸着引脚时，用户点一下「关闭」就能腾出来。
 * 只清引脚不关外设会留下一个「开着但没引脚」的配置，生成代码是残的，所以一起关掉。
 */
export function freePeripheral(project: Project, id: string): Project {
  const cfg = project.configs[id];
  if (!cfg) return project;
  const channels: typeof cfg.channels = {};
  for (const [key, ch] of Object.entries(cfg.channels ?? {})) {
    channels[key] = { ...ch, pin: null };
  }
  return {
    ...project,
    configs: {
      ...project.configs,
      [id]: { ...cfg, enabled: false, pins: {}, channels },
    },
  };
}

export function emptyConfig(id: string, schemaKey: string): PeripheralConfig {  const schema = schemaFor(schemaKey);
  const params = schema ? defaultParams(schema) : {};
  const mode = schema?.modeKey ? String(params[schema.modeKey] ?? "") : undefined;
  return {
    enabled: false,
    mode,
    params,
    pins: {},
    nvic: { enabled: false, preempt: 0, sub: 0 },
    channels: {},
  };
}

export function defaultSettings(name: string): ProjectSettings {
  return {
    name,
    toolchain: "mrs",
    sdk: "wch-sdk",
    generateIt: true,
    generateStartup: true,
    includeComments: true,
    outputDir: "",
    author: "RiskFiveRuler",
  };
}

/** 切换器件时保留同 id 外设的配置，其余丢弃 */
export function retarget(project: Project, next: DeviceDef): Project {
  const configs: Record<string, PeripheralConfig> = {};
  for (const p of next.peripherals) {
    const old = project.configs[p.id];
    if (!old) {
      configs[p.id] = emptyConfig(p.id, p.schema);
      continue;
    }
    configs[p.id] = {
      ...old,
      pins: prunePins(old.pins, next, p.id),
      channels: pruneChannels(old.channels, next, p.id),
    };
  }
  const gpio: Record<string, GpioCfg> = {};
  for (const pin of next.package.pins) {
    if (pin.kind === "io") gpio[pin.name] = project.gpio[pin.name] ?? { mode: "analog", pull: "none", speed: "2" };
  }
  const out: Project = {
    ...project,
    deviceId: next.id,
    configs,
    gpio,
    clock: { ...project.clock, hseFreq: next.clock.hseOptions[0] ?? 0 },
    // 复位脚跟封装走：新封装的第一个 RESET 候选
    resetPin: firstResetPin(next),
  };
  // 换器件后调试脚的端口可能完全不同（L103 是 PA13/PA14，X035 是 PC18/PC19），
  // 空的就重新落到新器件手册指定的脚上
  const dbg = out.configs["DBG"];
  if (dbg?.enabled) enableDebugInterface(out, next);
  return out;
}

function prunePins(
  pins: Record<string, string | null>,
  dev: DeviceDef,
  periphId: string,
): Record<string, string | null> {
  const valid = new Set(dev.package.pins.map((p) => p.name));
  const out: Record<string, string | null> = {};
  for (const [sig, pin] of Object.entries(pins)) {
    if (!pin) {
      out[sig] = null;
      continue;
    }
    const ok = valid.has(pin) && dev.package.pins.some((p) => p.name === pin && (p.signals ?? []).some((s) => s.fn === `${periphId}_${sig}`));
    out[sig] = ok ? pin : null;
  }
  return out;
}

/** 通道表的引脚同样要按新封装校验，否则会留下这颗芯片根本没有的引脚 */
function pruneChannels(
  channels: Record<string, ChannelCfg> | undefined,
  dev: DeviceDef,
  periphId: string,
): Record<string, ChannelCfg> | undefined {
  if (!channels) return channels;
  const out: Record<string, ChannelCfg> = {};
  for (const [key, ch] of Object.entries(channels)) {
    if (!ch.pin) {
      out[key] = ch;
      continue;
    }
    const ok = dev.package.pins.some(
      (p) => p.name === ch.pin && (p.signals ?? []).some((s) => s.fn === `${periphId}_${key}`),
    );
    out[key] = ok ? ch : { ...ch, pin: null };
  }
  return out;
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

/** 示例工程：串口 + I2C + PWM + ADC，用来快速看清工具的能力边界 */
export function createDemoProject(dev: DeviceDef): Project {
  const p = createProject(dev, "RFR_Demo");
  const cfg = (id: string) => p.configs[id];

  /**
   * 给「同一外设的一组信号」一次性找脚。
   *
   * 以前是逐信号挑「第一个候选脚」，两个毛病都出过：
   *   · TX 和 RX 各挑各的，可能落到同一个物理脚上（L103F8P6 的 PA4 就是）；
   *   · 整组器件（WCH）会把两条线配到不同重映射组，硬件根本不会同时生效。
   * 走 planPins 一次解决这两件事，并且它会把已占用的脚（调试口）排除在外。
   */
  const assign = (periphId: string, signals: string[]): void => {
    const c = p.configs[periphId];
    if (!c) return;
    const plan = planPins(dev, p, periphId, signals, collectUsage(p, dev));
    if (plan) c.pins = { ...c.pins, ...plan };
  };

  /** 通道型信号（TIM 的 CHx、ADC 的 INx）单独挑，返回值可能为 null */
  const pickChannel = (periphId: string, signals: string[]): Record<string, string | null> => {
    const per = dev.peripherals.find((x) => x.id === periphId);
    const c = p.configs[periphId];
    if (!per || !c) return {};
    const current: Record<string, string | null> = {};
    for (const s of signals) current[s] = null;
    const groups = remapGroupsOf(dev, per, signals, current, collectUsage(p, dev), signals);
    const g = groups.find((x) => x.feasible);
    if (!g) return {};
    const out: Record<string, string | null> = {};
    const pins = groupPinsFor(dev, per, signals, g.group, current, collectUsage(p, dev));
    for (const s of signals) out[s] = pins[s] ?? null;
    return out;
  };

  const usart = cfg("USART1");
  if (usart) {
    usart.enabled = true;
    usart.mode = "Asynchronous";
    usart.params["mode"] = "Asynchronous";
    usart.params["baud"] = 115200;
    assign("USART1", ["TX", "RX"]);
    usart.nvic = { enabled: true, preempt: 1, sub: 0 };
    usart.params["irqRxne"] = true;
    // 串口接收走 DMA 循环 + 空闲中断，是最常见的一对组合，示例里带上
    const dmaRx = defaultDmaChannel(dev, [], "USART1_RX", "p2m");
    if (dmaRx) {
      usart.dmaChannels = [{ ...dmaRx, mode: "circular", priority: "high", irqTc: true }];
    }
  }

  /**
   * 小封装上示例外设可能真的配不齐（L103F8P6 的 I2C1 唯一可行组被调试口占着）。
   * 与其留一个「启用了但一根线都没落」的空壳，不如干脆不开 —— 示例要展示的是
   * 能力，不是缺陷。
   */
  const dropIfUnassigned = (id: string): void => {
    const per = dev.peripherals.find((x) => x.id === id);
    const c = p.configs[id];
    if (!per || !c?.enabled) return;
    const need = requiredInMode(per, c.mode, c.params).filter((s) => !c.pins[s]);
    if (need.length) {
      c.enabled = false;
      c.pins = {};
    }
  };

  const i2c = cfg("I2C1");
  if (i2c) {
    i2c.enabled = true;
    i2c.mode = "master";
    i2c.params["mode"] = "master";
    i2c.params["speedMode"] = "fast";
    i2c.params["speed"] = 400;
    assign("I2C1", ["SCL", "SDA"]);
  }

  const tim = cfg("TIM2");
  if (tim) {
    tim.enabled = true;
    tim.params["psc"] = 47;
    tim.params["arr"] = 999;
    const chPins = pickChannel("TIM2", ["CH1", "CH2"]);
    tim.channels = {
      CH1: { enabled: true, mode: "pwm", pin: chPins["CH1"] ?? null, params: { pwmMode: "1", pulse: 500, polarity: "high", idleState: "reset" } },
      CH2: { enabled: true, mode: "pwm", pin: chPins["CH2"] ?? null, params: { pwmMode: "1", pulse: 250, polarity: "high", idleState: "reset" } },
    };
    tim.nvic = { enabled: true, preempt: 2, sub: 0 };
    tim.params["irqUpdate"] = true;
  }

  const adc = cfg("ADC1");
  if (adc) {
    adc.enabled = true;
    adc.params["scanMode"] = "enable";
    adc.params["continuous"] = "enable";
    /**
     * 挑「这颗片子真的有引脚」的前两个通道。
     *
     * 不能写死 IN4/IN5 —— 不同系列的通道分布差别很大（V407 的 ADC 只在 PC0~PC5，
     * 对应 IN10/IN11/IN13/IN15），写死会让示例工程的 ADC 一个通道都没有，
     * 生成代码里也就没有 ADC_RegularChannelConfig。
     */
    const adcDef = dev.peripherals.find((x) => x.id === "ADC1");
    const usable = (adcDef?.signals ?? [])
      .map((s) => s.name)
      .filter((n) => /^IN\d+$/.test(n))
      .filter((n) => dev.package.pins.some((pin) => (pin.signals ?? []).some((s) => s.fn === `ADC1_${n}`)));
    adc.channels = {};
    // 一次把前两个通道一起挑：INx 也要互不重复
    const chosen = pickChannel("ADC1", usable.slice(0, 2));
    for (const key of usable.slice(0, 2)) {
      adc.channels[key] = { enabled: true, mode: "regular", pin: chosen[key] ?? null, params: { sampleTime: "55.5" } };
    }
  }

  dropIfUnassigned("I2C1");

  p.pinLabels = {};
  const tx = usart?.pins["TX"];
  const rx = usart?.pins["RX"];
  if (tx) p.pinLabels[tx] = "DEBUG_TX";
  if (rx) p.pinLabels[rx] = "DEBUG_RX";

  const led = dev.package.pins.find((x) => x.kind === "io" && x.name === "PC13") ?? dev.package.pins.find((x) => x.kind === "io");
  if (led) {
    p.gpio[led.name] = { mode: "output_pp", pull: "none", speed: "2", initial: "low" };
    p.pinLabels[led.name] = "LED_RUN";
  }
  return p;
}
