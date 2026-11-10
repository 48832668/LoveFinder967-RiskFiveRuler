/**
 * 器件包校验 —— 把「JSON 写错了」变成启动时一句人话，而不是运行时诡异行为。
 *
 * 为什么不用 zod：器件包是**外部输入**（将来可能由第三方工具产出），
 * 校验规则本身需要说清楚「为什么这条必须成立」，手写反而更好读，
 * 也避免为了一个 100 行的校验引入运行时依赖。
 *
 * 分两级：
 *   - error：包结构坏了，加载会得到破碎的 DeviceDef → 直接拒绝
 *   - warn：能跑但会在界面上表现异常（例如某个信号没有任何引脚） → 控制台提示
 */

import type { PackFile } from "./types";

export interface PackIssue {
  level: "error" | "warn";
  /** 出错位置，如 `ports.PA1[2]` */
  at: string;
  msg: string;
}

const KIND_VALUES = new Set([
  "USART", "UART", "SPI", "QSPI", "I2S", "DAC", "I2C", "TIM", "ADC", "GPIO",
  "USB", "CAN", "OPA", "CMP", "VCMP", "IWDG", "WWDG", "RTC", "PWR", "EXTI",
  "CLK", "DBG", "CRC", "DMA", "SYSTEM",
]);

const GROUP_VALUES = new Set([
  "System", "Analog", "Timers", "Connectivity", "Middleware", "Security",
]);

export function validatePack(pack: PackFile, fileName: string): PackIssue[] {
  const out: PackIssue[] = [];
  const err = (at: string, msg: string) => out.push({ level: "error", at, msg });
  const warn = (at: string, msg: string) => out.push({ level: "warn", at, msg });

  /* ── 顶层字段 ── */
  const need = ["packVersion", "series", "vendor", "core", "source"] as const;
  for (const k of need) {
    if (typeof (pack as any)[k] !== "string" || !(pack as any)[k]) {
      err(k, `缺少必填字符串字段 ${k}（文件 ${fileName}）`);
    }
  }
  for (const k of ["flashKb", "ramKb", "maxSysclk"] as const) {
    if (typeof (pack as any)[k] !== "number") err(k, `${k} 必须是数字`);
  }

  /* ── 时钟拓扑 ── */
  const c = pack.clock;
  if (!c) {
    err("clock", "缺少 clock 时钟拓扑");
  } else {
    if (typeof c.hsi !== "number") err("clock.hsi", "hsi 必须是数字（MHz）");
    if (!Array.isArray(c.hseOptions)) err("clock.hseOptions", "hseOptions 必须是数组");
    for (const k of ["pllMin", "pllMax", "maxSysclk"] as const) {
      if (typeof c[k] !== "number") err(`clock.${k}`, `${k} 必须是数字`);
    }
    for (const k of ["apb1Divs", "apb2Divs", "ahbDivs"] as const) {
      if (!Array.isArray(c[k])) err(`clock.${k}`, `${k} 必须是数组`);
    }
    if (!["HSI", "HSE", "HSI_DIV2"].includes(c.pllSource)) {
      err("clock.pllSource", `pllSource 只能是 HSI / HSE / HSI_DIV2，实际 ${c.pllSource}`);
    }
  }

  /* ── 封装 ── */
  if (!Array.isArray(pack.packages) || pack.packages.length === 0) {
    err("packages", "至少要有一个封装");
  } else {
    const ids = new Set<string>();
    for (const [i, pkg] of pack.packages.entries()) {
      const at = `packages[${i}]`;
      if (!pkg.id) err(at, "封装缺少 id");
      if (ids.has(pkg.id)) err(at, `封装 id 重复：${pkg.id}`);
      ids.add(pkg.id);
      if (!["quad", "dual", "qfn", "sop"].includes(pkg.shape)) {
        err(`${at}.shape`, `shape 非法：${pkg.shape}`);
      }
      if (!Array.isArray(pkg.pins) || pkg.pins.length === 0) {
        err(at, "封装没有引脚");
        continue;
      }
      const nums = new Set<string>();
      const names = new Set<string>();
      for (const [j, p] of pkg.pins.entries()) {
        const pat = `${at}.pins[${j}]`;
        const key = String(p.num);
        if (nums.has(key)) err(pat, `引脚号重复：${key}（${p.name}）`);
        nums.add(key);
        if (!p.name) err(pat, "引脚缺少 name");
        if (names.has(p.name)) warn(pat, `引脚名重复：${p.name}`);
        names.add(p.name);
        if (!["io", "power", "reset", "osc", "nc", "boot"].includes(p.kind)) {
          err(`${pat}.kind`, `kind 非法：${p.kind}`);
        }
      }
      // 引脚号应连续（0 = 散热焊盘允许缺省）
      const numeric = pkg.pins.map((p) => p.num).filter((n): n is number => typeof n === "number");
      const max = Math.max(...numeric);
      const missing: number[] = [];
      for (let n = 1; n <= max; n++) if (!numeric.includes(n)) missing.push(n);
      if (missing.length) {
        warn(`${at}.pins`, `引脚号不连续，缺 ${missing.join(", ")} —— 画布会留空位`);
      }
    }
  }

  /* ── 外设声明 ── */
  if (!Array.isArray(pack.peripherals) || pack.peripherals.length === 0) {
    err("peripherals", "至少要声明一个外设");
  }
  const periphSignals = new Map<string, Set<string>>();
  for (const [i, p] of (pack.peripherals ?? []).entries()) {
    const at = `peripherals[${i}](${p.id})`;
    if (!p.id) err(at, "外设缺少 id");
    if (!Array.isArray(p.signals) || p.signals.length === 0) {
      warn(at, `${p.id} 没有声明任何信号 —— 它在界面上会是一个点不动的空外设`);
    }
    periphSignals.set(p.id, new Set(p.signals ?? []));
  }

  /* ── 元数据：非 WCH 必须写全 ── */
  const isWch = pack.vendor === "WCH";
  for (const p of pack.peripherals ?? []) {
    const m = pack.meta?.[p.id];
    if (!m) {
      if (!isWch) {
        err(
          `meta.${p.id}`,
          `缺少外设元数据。非 WCH 器件包必须在 meta 里声明 { kind, group, schema, brief }，` +
            `否则这个外设会归到 System 且用不了参数面板`,
        );
      }
      continue;
    }
    if (!KIND_VALUES.has(m.kind)) err(`meta.${p.id}.kind`, `kind 非法：${m.kind}`);
    if (!GROUP_VALUES.has(m.group)) err(`meta.${p.id}.group`, `group 非法：${m.group}`);
    if (!m.schema) err(`meta.${p.id}.schema`, "缺少 schema 键");
    for (const r of m.required ?? []) {
      if (!periphSignals.get(p.id)?.has(r)) {
        // 必需信号可以不在声明表里（加载器会补一条 required），但多半是拼错了
        warn(`meta.${p.id}.required`, `必需信号 ${r} 不在 signals 声明里（若是有意为之可忽略）`);
      }
    }
  }

  /* ── 复用表 ── */
  const portNames = new Set<string>();
  for (const pkg of pack.packages ?? []) {
    for (const p of pkg.pins) {
      portNames.add(p.name);
      for (const a of p.aliases ?? []) portNames.add(a);
    }
  }
  const referenced = new Set<string>();
  for (const [port, arr] of Object.entries(pack.ports ?? {})) {
    if (!portNames.has(port)) {
      warn(`ports.${port}`, "该端口不在任何封装里 —— 它上面的复用项永远不会显示");
    }
    for (const [i, e] of arr.entries()) {
      const at = `ports.${port}[${i}]`;
      if (!e.fn) {
        err(at, "复用项缺少 fn");
        continue;
      }
      referenced.add(e.fn);
      const [owner, ...rest] = e.fn.split("_");
      const sig = rest.join("_");
      const known = periphSignals.get(owner);
      if (!known) {
        warn(at, `${e.fn} 的外设 ${owner} 没有在 peripherals 里声明 —— 引脚菜单里点不动`);
      } else if (!known.has(sig)) {
        warn(at, `${e.fn} 的 ${sig} 不在 ${owner} 的 signals 里 —— 引脚菜单里点不动`);
      }
      if (e.remap !== undefined && !/^\d+$/.test(String(e.remap))) {
        err(`${at}.remap`, `remap 必须是数字字符串，实际 ${JSON.stringify(e.remap)}`);
      }
    }
  }

  /* ── 每个信号是否至少有一个引脚（全系列）── */
  for (const [id, sigs] of periphSignals) {
    const dead = [...sigs].filter((s) => !referenced.has(`${id}_${s}`));
    if (dead.length && dead.length === sigs.size) {
      warn(`peripherals.${id}`, `${id} 的所有信号都没有引脚 —— 会被判定「器件数据待补」`);
    }
  }

  return out;
}

/** 把校验结果打成一段可读文本；没有问题返回 null */
export function formatIssues(pack: PackFile, issues: PackIssue[]): string | null {
  if (issues.length === 0) return null;
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const lines: string[] = [`器件包 ${pack.series}（${pack.vendor}）：`];
  for (const i of errs) lines.push(`  ✗ ${i.at}: ${i.msg}`);
  for (const i of warns.slice(0, 8)) lines.push(`  ! ${i.at}: ${i.msg}`);
  if (warns.length > 8) lines.push(`  … 还有 ${warns.length - 8} 条警告`);
  return lines.join("\n");
}
