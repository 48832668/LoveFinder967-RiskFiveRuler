// src/core/packs/loader.ts
var GROUP_ORDER = [
  "System",
  "Connectivity",
  "Timers",
  "Analog",
  "Security",
  "Middleware"
];
function buildPins(pack, pkg) {
  const extiMax = pack.extiLines ?? 0;
  return pkg.pins.map((p) => {
    const out = { num: p.num, name: p.name, kind: p.kind };
    if (p.note) out.note = p.note;
    if (p.aliases?.length) out.aliases = p.aliases;
    const names = [p.name, ...p.aliases ?? []];
    const seen = /* @__PURE__ */ new Set();
    const signals = [];
    for (const n of names) {
      for (const s of pack.ports[n] ?? []) {
        const key = `${s.fn}|${s.remap ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push(s.remap ? { fn: s.fn, remap: s.remap } : { fn: s.fn });
      }
    }
    if (p.kind === "io") {
      for (const n of names) {
        const m = /^P[A-Z](\d+)$/.exec(n);
        if (!m) continue;
        const line = Number(m[1]);
        if (line < extiMax && !seen.has(`EXTI_LINE${line}`)) {
          seen.add(`EXTI_LINE${line}`);
          signals.push({ fn: `EXTI_LINE${line}` });
        }
      }
    }
    if (signals.length) out.signals = signals;
    return out;
  });
}
function directionOf(kind, sig) {
  if (/^CH\dN?$/.test(sig)) return "io";
  switch (kind) {
    case "USART":
    case "UART":
      return sig === "TX" || sig === "CK" || sig === "RTS" ? "out" : "in";
    case "SPI":
    case "QSPI":
      return sig === "SCK" || sig === "CLK" || sig === "MOSI" || sig === "NSS" ? "out" : "in";
    case "I2C":
      return "io";
    case "ADC":
    case "DAC":
      return "in";
    case "CMP":
    case "VCMP":
      return sig.startsWith("OUT") ? "out" : "in";
    case "CAN":
      return sig === "TX" ? "out" : "in";
    case "CLK":
      return sig.endsWith("_IN") ? "in" : "out";
    default:
      return "io";
  }
}
function buildPeripherals(pack, legacyMeta) {
  const list = [];
  for (const p of pack.peripherals) {
    const meta = pack.meta?.[p.id] ?? legacyMeta?.(p.id);
    if (!meta) {
      throw new Error(
        `${pack.series}: \u5916\u8BBE ${p.id} \u7F3A\u5C11 meta\uFF0C\u65E0\u6CD5\u786E\u5B9A kind / group / schema`
      );
    }
    const idx = Number(/(\d+)$/.exec(p.id)?.[1] ?? "0");
    const required = new Set(meta.required ?? []);
    const signals = p.signals.map((s) => ({
      name: s,
      required: required.has(s),
      dir: directionOf(meta.kind, s)
    }));
    for (const r of required) {
      if (!signals.some((s) => s.name === r)) {
        signals.push({ name: r, required: true, dir: directionOf(meta.kind, r) });
      }
    }
    list.push({
      id: p.id,
      kind: meta.kind,
      label: meta.label ?? p.id,
      group: meta.group,
      index: idx,
      brief: meta.brief,
      signals,
      schema: meta.schema,
      irq: pack.irqs.filter((i) => i.owner === p.id).map((i) => ({ n: i.n, name: i.name, desc: i.desc, gate: i.gate }))
    });
  }
  list.sort((a, b) => {
    const g2 = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g2 !== 0) return g2;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.index - b.index;
  });
  return list;
}
function loadPack(pack, legacyMeta) {
  const peripherals = buildPeripherals(pack, legacyMeta);
  return pack.packages.map((pkg) => {
    const pkgDef = {
      id: pkg.id,
      label: pkg.label,
      shape: pkg.shape,
      pins: buildPins(pack, pkg),
      pinNumbering: pkg.pinNumbering ?? "package"
    };
    const irqs = pack.irqs ?? [];
    return {
      id: pkg.id,
      family: pack.series,
      vendor: pack.vendor,
      core: pack.core,
      package: pkgDef,
      flashKb: pack.flashKb,
      ramKb: pack.ramKb,
      voltage: pack.voltage,
      peripherals,
      clock: pack.clock,
      extiLines: pack.extiLines,
      dmaChannels: pack.dmaChannels,
      dmaControllers: pack.dmaControllers,
      dmaMap: pack.dmaMap,
      debug: pack.debug,
      api: pack.api,
      // 总线覆盖必须透传：L103 的 USBFS/USBPD 挂在 HB 上，
      // 少了这一行 `dev.buses` 永远是 undefined，生成出来就是 PB1 的错宏
      buses: pack.buses,
      backend: pack.backend ?? backendFor(pack.vendor),
      afGrouping: pack.afGrouping ?? groupingFor(pack.vendor),
      codegenEnabled: pack.codegen !== "disable",
      codegenNote: pack.codegenNote,
      peripheralVersion: pack.peripheralVersion,
      sdkHeader: pack.sdkHeader,
      irqs,
      source: pack.source,
      packVersion: pack.packVersion,
      pending: pack.pending
    };
  });
}
function backendFor(vendor) {
  return vendor === "WCH" ? "wch-spl" : "generic";
}
function groupingFor(vendor) {
  return vendor === "WCH" ? "grouped" : "independent";
}

// src/core/packs/validate.ts
var KIND_VALUES = /* @__PURE__ */ new Set([
  "USART",
  "UART",
  "SPI",
  "QSPI",
  "I2S",
  "DAC",
  "I2C",
  "TIM",
  "ADC",
  "GPIO",
  "USB",
  "CAN",
  "OPA",
  "CMP",
  "VCMP",
  "IWDG",
  "WWDG",
  "RTC",
  "PWR",
  "EXTI",
  "CLK",
  "DBG",
  "CRC",
  "DMA",
  "SYSTEM"
]);
var GROUP_VALUES = /* @__PURE__ */ new Set([
  "System",
  "Analog",
  "Timers",
  "Connectivity",
  "Middleware",
  "Security"
]);
function validatePack(pack, fileName) {
  const out = [];
  const err = (at, msg) => out.push({ level: "error", at, msg });
  const warn = (at, msg) => out.push({ level: "warn", at, msg });
  const need = ["packVersion", "series", "vendor", "core", "source"];
  for (const k of need) {
    if (typeof pack[k] !== "string" || !pack[k]) {
      err(k, `\u7F3A\u5C11\u5FC5\u586B\u5B57\u7B26\u4E32\u5B57\u6BB5 ${k}\uFF08\u6587\u4EF6 ${fileName}\uFF09`);
    }
  }
  for (const k of ["flashKb", "ramKb", "maxSysclk"]) {
    if (typeof pack[k] !== "number") err(k, `${k} \u5FC5\u987B\u662F\u6570\u5B57`);
  }
  const c = pack.clock;
  if (!c) {
    err("clock", "\u7F3A\u5C11 clock \u65F6\u949F\u62D3\u6251");
  } else {
    if (typeof c.hsi !== "number") err("clock.hsi", "hsi \u5FC5\u987B\u662F\u6570\u5B57\uFF08MHz\uFF09");
    if (!Array.isArray(c.hseOptions)) err("clock.hseOptions", "hseOptions \u5FC5\u987B\u662F\u6570\u7EC4");
    for (const k of ["pllMin", "pllMax", "maxSysclk"]) {
      if (typeof c[k] !== "number") err(`clock.${k}`, `${k} \u5FC5\u987B\u662F\u6570\u5B57`);
    }
    for (const k of ["apb1Divs", "apb2Divs", "ahbDivs"]) {
      if (!Array.isArray(c[k])) err(`clock.${k}`, `${k} \u5FC5\u987B\u662F\u6570\u7EC4`);
    }
    if (!["HSI", "HSE", "HSI_DIV2"].includes(c.pllSource)) {
      err("clock.pllSource", `pllSource \u53EA\u80FD\u662F HSI / HSE / HSI_DIV2\uFF0C\u5B9E\u9645 ${c.pllSource}`);
    }
  }
  if (!Array.isArray(pack.packages) || pack.packages.length === 0) {
    err("packages", "\u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u5C01\u88C5");
  } else {
    const ids = /* @__PURE__ */ new Set();
    for (const [i, pkg] of pack.packages.entries()) {
      const at = `packages[${i}]`;
      if (!pkg.id) err(at, "\u5C01\u88C5\u7F3A\u5C11 id");
      if (ids.has(pkg.id)) err(at, `\u5C01\u88C5 id \u91CD\u590D\uFF1A${pkg.id}`);
      ids.add(pkg.id);
      if (!["quad", "dual", "qfn", "sop"].includes(pkg.shape)) {
        err(`${at}.shape`, `shape \u975E\u6CD5\uFF1A${pkg.shape}`);
      }
      if (!Array.isArray(pkg.pins) || pkg.pins.length === 0) {
        err(at, "\u5C01\u88C5\u6CA1\u6709\u5F15\u811A");
        continue;
      }
      const nums = /* @__PURE__ */ new Set();
      const names = /* @__PURE__ */ new Set();
      for (const [j, p] of pkg.pins.entries()) {
        const pat = `${at}.pins[${j}]`;
        const key = String(p.num);
        if (nums.has(key)) err(pat, `\u5F15\u811A\u53F7\u91CD\u590D\uFF1A${key}\uFF08${p.name}\uFF09`);
        nums.add(key);
        if (!p.name) err(pat, "\u5F15\u811A\u7F3A\u5C11 name");
        if (names.has(p.name)) warn(pat, `\u5F15\u811A\u540D\u91CD\u590D\uFF1A${p.name}`);
        names.add(p.name);
        if (!["io", "power", "reset", "osc", "nc", "boot"].includes(p.kind)) {
          err(`${pat}.kind`, `kind \u975E\u6CD5\uFF1A${p.kind}`);
        }
      }
      const numeric = pkg.pins.map((p) => p.num).filter((n) => typeof n === "number");
      const max = Math.max(...numeric);
      const missing = [];
      for (let n = 1; n <= max; n++) if (!numeric.includes(n)) missing.push(n);
      if (missing.length) {
        warn(`${at}.pins`, `\u5F15\u811A\u53F7\u4E0D\u8FDE\u7EED\uFF0C\u7F3A ${missing.join(", ")} \u2014\u2014 \u753B\u5E03\u4F1A\u7559\u7A7A\u4F4D`);
      }
    }
  }
  if (!Array.isArray(pack.peripherals) || pack.peripherals.length === 0) {
    err("peripherals", "\u81F3\u5C11\u8981\u58F0\u660E\u4E00\u4E2A\u5916\u8BBE");
  }
  const periphSignals = /* @__PURE__ */ new Map();
  for (const [i, p] of (pack.peripherals ?? []).entries()) {
    const at = `peripherals[${i}](${p.id})`;
    if (!p.id) err(at, "\u5916\u8BBE\u7F3A\u5C11 id");
    if (!Array.isArray(p.signals) || p.signals.length === 0) {
      warn(at, `${p.id} \u6CA1\u6709\u58F0\u660E\u4EFB\u4F55\u4FE1\u53F7 \u2014\u2014 \u5B83\u5728\u754C\u9762\u4E0A\u4F1A\u662F\u4E00\u4E2A\u70B9\u4E0D\u52A8\u7684\u7A7A\u5916\u8BBE`);
    }
    periphSignals.set(p.id, new Set(p.signals ?? []));
  }
  const isWch = pack.vendor === "WCH";
  for (const p of pack.peripherals ?? []) {
    const m = pack.meta?.[p.id];
    if (!m) {
      if (!isWch) {
        err(
          `meta.${p.id}`,
          `\u7F3A\u5C11\u5916\u8BBE\u5143\u6570\u636E\u3002\u975E WCH \u5668\u4EF6\u5305\u5FC5\u987B\u5728 meta \u91CC\u58F0\u660E { kind, group, schema, brief }\uFF0C\u5426\u5219\u8FD9\u4E2A\u5916\u8BBE\u4F1A\u5F52\u5230 System \u4E14\u7528\u4E0D\u4E86\u53C2\u6570\u9762\u677F`
        );
      }
      continue;
    }
    if (!KIND_VALUES.has(m.kind)) err(`meta.${p.id}.kind`, `kind \u975E\u6CD5\uFF1A${m.kind}`);
    if (!GROUP_VALUES.has(m.group)) err(`meta.${p.id}.group`, `group \u975E\u6CD5\uFF1A${m.group}`);
    if (!m.schema) err(`meta.${p.id}.schema`, "\u7F3A\u5C11 schema \u952E");
    for (const r of m.required ?? []) {
      if (!periphSignals.get(p.id)?.has(r)) {
        warn(`meta.${p.id}.required`, `\u5FC5\u9700\u4FE1\u53F7 ${r} \u4E0D\u5728 signals \u58F0\u660E\u91CC\uFF08\u82E5\u662F\u6709\u610F\u4E3A\u4E4B\u53EF\u5FFD\u7565\uFF09`);
      }
    }
  }
  const portNames = /* @__PURE__ */ new Set();
  for (const pkg of pack.packages ?? []) {
    for (const p of pkg.pins) {
      portNames.add(p.name);
      for (const a of p.aliases ?? []) portNames.add(a);
    }
  }
  const referenced = /* @__PURE__ */ new Set();
  for (const [port, arr] of Object.entries(pack.ports ?? {})) {
    if (!portNames.has(port)) {
      warn(`ports.${port}`, "\u8BE5\u7AEF\u53E3\u4E0D\u5728\u4EFB\u4F55\u5C01\u88C5\u91CC \u2014\u2014 \u5B83\u4E0A\u9762\u7684\u590D\u7528\u9879\u6C38\u8FDC\u4E0D\u4F1A\u663E\u793A");
    }
    for (const [i, e] of arr.entries()) {
      const at = `ports.${port}[${i}]`;
      if (!e.fn) {
        err(at, "\u590D\u7528\u9879\u7F3A\u5C11 fn");
        continue;
      }
      referenced.add(e.fn);
      const [owner, ...rest] = e.fn.split("_");
      const sig = rest.join("_");
      const known = periphSignals.get(owner);
      if (!known) {
        warn(at, `${e.fn} \u7684\u5916\u8BBE ${owner} \u6CA1\u6709\u5728 peripherals \u91CC\u58F0\u660E \u2014\u2014 \u5F15\u811A\u83DC\u5355\u91CC\u70B9\u4E0D\u52A8`);
      } else if (!known.has(sig)) {
        warn(at, `${e.fn} \u7684 ${sig} \u4E0D\u5728 ${owner} \u7684 signals \u91CC \u2014\u2014 \u5F15\u811A\u83DC\u5355\u91CC\u70B9\u4E0D\u52A8`);
      }
      if (e.remap !== void 0 && !/^\d+$/.test(String(e.remap))) {
        err(`${at}.remap`, `remap \u5FC5\u987B\u662F\u6570\u5B57\u5B57\u7B26\u4E32\uFF0C\u5B9E\u9645 ${JSON.stringify(e.remap)}`);
      }
    }
  }
  for (const [id, sigs] of periphSignals) {
    const dead = [...sigs].filter((s) => !referenced.has(`${id}_${s}`));
    if (dead.length && dead.length === sigs.size) {
      warn(`peripherals.${id}`, `${id} \u7684\u6240\u6709\u4FE1\u53F7\u90FD\u6CA1\u6709\u5F15\u811A \u2014\u2014 \u4F1A\u88AB\u5224\u5B9A\u300C\u5668\u4EF6\u6570\u636E\u5F85\u8865\u300D`);
    }
  }
  return out;
}
function formatIssues(pack, issues) {
  if (issues.length === 0) return null;
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const lines = [`\u5668\u4EF6\u5305 ${pack.series}\uFF08${pack.vendor}\uFF09\uFF1A`];
  for (const i of errs) lines.push(`  \u2717 ${i.at}: ${i.msg}`);
  for (const i of warns.slice(0, 8)) lines.push(`  ! ${i.at}: ${i.msg}`);
  if (warns.length > 8) lines.push(`  \u2026 \u8FD8\u6709 ${warns.length - 8} \u6761\u8B66\u544A`);
  return lines.join("\n");
}

// src/core/devices/wch.ts
var META = {
  GPIO: { kind: "GPIO", group: "System", schema: "GPIO", brief: "\u7AEF\u53E3\u6A21\u5F0F\u4E0E\u4E0A/\u4E0B\u62C9" },
  SYSTEM: { kind: "SYSTEM", group: "System", schema: "SYSTEM", brief: "SWD / MCO / \u4E2D\u65AD\u63A7\u5236\u5668" },
  RTC: { kind: "RTC", group: "System", schema: "RTC", brief: "32 \u4F4D\u72EC\u7ACB\u5B9A\u65F6\u5668 + \u540E\u5907\u57DF" },
  PWR: { kind: "PWR", group: "System", schema: "PWR", brief: "\u4F4E\u529F\u8017\u6A21\u5F0F\u4E0E PVD" },
  EXTI: { kind: "EXTI", group: "System", schema: "EXTI", brief: "\u5916\u90E8\u4E2D\u65AD\u7EBF" },
  CLK: { kind: "CLK", group: "System", schema: "CLK", brief: "HSE / LSE \u5916\u90E8\u6676\u632F", label: "\u65F6\u949F\u6E90" },
  DBG: { kind: "DBG", group: "System", schema: "DBG", brief: "2 \u7EBF SDI \u8C03\u8BD5\u53E3 / \u51BB\u7ED3\u70B9", label: "\u8C03\u8BD5\u63A5\u53E3", required: ["SWDIO", "SWCLK"] },
  CRC: { kind: "CRC", group: "Security", schema: "CRC", brief: "CRC \u8BA1\u7B97\u5355\u5143" },
  DMA: { kind: "DMA", group: "System", schema: "DMA", brief: "8 \u901A\u9053\u901A\u7528 DMA" },
  IWDG: { kind: "IWDG", group: "Security", schema: "IWDG", brief: "\u72EC\u7ACB\u770B\u95E8\u72D7" },
  WWDG: { kind: "WWDG", group: "Security", schema: "WWDG", brief: "\u7A97\u53E3\u770B\u95E8\u72D7" },
  LPTIM: { kind: "TIM", group: "Timers", schema: "TIM", brief: "\u4F4E\u529F\u8017\u5B9A\u65F6\u5668", label: "LPTIM" },
  ADC1: { kind: "ADC", group: "Analog", schema: "ADC", brief: "12 \u4F4D\u9010\u6B21\u903C\u8FD1 ADC" },
  // CAN 少了 TX 或 RX 就没法收发，写成必需信号，否则启用后一个引脚都不分
  CAN1: { kind: "CAN", group: "Connectivity", schema: "CAN", brief: "CAN 2.0B \u4E3B\u52A8\u63A7\u5236\u5668", required: ["TX", "RX"] },
  // USB 的全速 PHY 是 DP/DM 一对差分线，缺一根就没法跑 ——
  // 写成必需信号，封装没引出（或只引出一根）时整个外设会从树里隐掉，
  // 而不是留在列表里让人点进去发现「无法启用」。
  USB1: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 \u5168\u901F\u8BBE\u5907/\u4E3B\u673A", required: ["DP", "DM"] },
  USBHS1: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 \u9AD8\u901F\u8BBE\u5907/\u4E3B\u673A", required: ["DP", "DM"] },
  USBHS2: { kind: "USB", group: "Connectivity", schema: "USB", brief: "USB 2.0 \u9AD8\u901F\u8BBE\u5907/\u4E3B\u673A", required: ["DP", "DM"] },
  // PD 控制器是独立外设：走 CC1/CC2，没有 DP/DM，所以有自己的参数模式
  USBPD: {
    kind: "USB",
    group: "Connectivity",
    schema: "USBPD",
    brief: "USB PD / Type-C \u63A7\u5236\u5668\uFF08CC1/CC2\uFF09",
    required: ["CC1", "CC2"]
  },
  PIOC: { kind: "SYSTEM", group: "Middleware", schema: "SYSTEM", brief: "\u53EF\u7F16\u7A0B\u534F\u8BAE I/O \u63A7\u5236\u5668" },
  // DVP：数字视频端口（并行摄像头接口），数据走 DMA（CH32V4x7 的 DMA2_Channel5 / 全局通道 18）。
  // 参数（DVP_CTL / STS / FIFO 等）尚未建模，只生成时钟使能 + TODO，与 ETH/LTDC/FSMC 同级。
  DVP: {
    kind: "DVP",
    group: "Connectivity",
    schema: "DVP",
    brief: "\u6570\u5B57\u89C6\u9891\u7AEF\u53E3\uFF08DVP\uFF0C\u5E76\u884C\u6444\u50CF\u5934\u63A5\u53E3\uFF09",
    required: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "HSYNC", "VSYNC"]
  }
};
function metaOf(id) {
  if (META[id]) return META[id];
  const m = /^([A-Z][A-Z0-9]*?)(\d*)$/.exec(id);
  const base = m?.[1] ?? id;
  switch (base) {
    case "USART":
      return { kind: "USART", group: "Connectivity", schema: "USART", brief: "\u901A\u7528\u540C\u6B65/\u5F02\u6B65\u6536\u53D1\u5668", required: ["TX", "RX"] };
    case "SPI":
      return { kind: "SPI", group: "Connectivity", schema: "SPI", brief: "\u4E32\u884C\u5916\u8BBE\u63A5\u53E3", required: ["SCK", "MOSI", "MISO"] };
    case "I2C":
      return { kind: "I2C", group: "Connectivity", schema: "I2C", brief: "I\xB2C / SMBus \u63A7\u5236\u5668", required: ["SCL", "SDA"] };
    case "TIM":
      return { kind: "TIM", group: "Timers", schema: "TIM", brief: "16 \u4F4D\u5B9A\u65F6\u5668" };
    case "OPA":
      return { kind: "OPA", group: "Analog", schema: "OPA", brief: "\u8FD0\u7B97\u653E\u5927\u5668 / PGA" };
    case "CMP":
      return { kind: "CMP", group: "Analog", schema: "CMP", brief: "\u6A21\u62DF\u7535\u538B\u6BD4\u8F83\u5668" };
    default:
      return { kind: "SYSTEM", group: "System", schema: "SYSTEM", brief: "" };
  }
}
function loadPack2(pack) {
  return loadPack(pack, metaOf);
}

// src/core/devices/data/ch32l103.json
var ch32l103_default = {
  packVersion: "0.2.0",
  series: "CH32L103",
  vendor: "WCH",
  core: "QingKe V4C \xB7 RV32IMAFC",
  source: "CH32L103DS0 \u88682-1-1\uFF08\u5404\u5C01\u88C5\u5F15\u811A\u5B9A\u4E49\uFF0C\u542B AFIO \u914D\u7F6E\u4F4D\uFF09\uFF1B\u590D\u7528\u7EC4\u53F7\u5373 AFIO \u914D\u7F6E\u503C\uFF08USART3_TX[11] \u2192 3\uFF09",
  flashKb: 64,
  ramKb: 20,
  voltage: "1.8 \u2013 3.6 V",
  maxSysclk: 96,
  extiLines: 16,
  dmaChannels: 8,
  dmaMap: {
    "1": [
      "ADC",
      "USART4_TX",
      "TIM2_CH3",
      "TIM4_CH1"
    ],
    "2": [
      "SPI1_RX",
      "USART3_TX",
      "TIM1_CH1",
      "TIM2_UP",
      "TIM3_CH3"
    ],
    "3": [
      "SPI1_TX",
      "USART3_RX",
      "TIM1_CH2",
      "TIM3_CH4",
      "TIM3_UP"
    ],
    "4": [
      "SPI2_RX",
      "USART1_TX",
      "I2C2_TX",
      "TIM1_CH4",
      "TIM1_TRIG",
      "TIM1_COM",
      "TIM4_CH2"
    ],
    "5": [
      "SPI2_TX",
      "USART1_RX",
      "I2C2_RX",
      "TIM1_UP",
      "TIM2_CH1",
      "TIM4_CH3"
    ],
    "6": [
      "USART2_RX",
      "I2C1_TX",
      "TIM1_CH3",
      "TIM3_CH1",
      "TIM3_TRIG"
    ],
    "7": [
      "USART2_TX",
      "I2C1_RX",
      "TIM2_CH2",
      "TIM4_UP"
    ],
    "8": [
      "USART4_RX",
      "TIM2_CH4"
    ]
  },
  debug: {
    twoWire: true,
    singleWire: false,
    note: "\u4E32\u884C 2 \u7EBF\u8C03\u8BD5\u63A5\u53E3\uFF08SDI\uFF09\uFF1ASWDIO + SWCLK\u3002\u7CFB\u7EDF\u4E0A\u7535\u6216\u590D\u4F4D\u540E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u4E3B\u7A0B\u5E8F\u91CC\u53EF\u4EE5\u5173\u6389\u628A\u8FD9\u4E24\u4E2A\u811A\u91CA\u653E\u6210\u666E\u901A GPIO\u3002",
    swdio: "PA13",
    swclk: "PA14"
  },
  api: {
    clockProfile: "full",
    clockApi: "pb",
    nvicApi: "stdlib",
    gpioSpeedStyle: "mhz",
    adcSampleStyle: "cyclesmode",
    flashLatency: true,
    adcClock: "rcc",
    flashPrefetch: false,
    gpioSpeeds: [
      "2",
      "10",
      "50"
    ],
    gpioOpenDrain: true,
    nvicGroups: [
      0,
      1
    ],
    adcSampleTimes: [
      "1.5",
      "7.5",
      "13.5",
      "28.5",
      "41.5",
      "55.5",
      "71.5",
      "239.5"
    ],
    note: "\u6309 V30x \u540C\u65CF API \u63A8\u65AD\uFF0C\u5C1A\u672A\u5BF9\u7167 CH32L103 EVT \u5934\u6587\u4EF6\u9A8C\u8BC1",
    sdiPrintf: false,
    pllHsiPre: true,
    clockAliases: {
      USB1: "USBFS"
    }
  },
  peripheralVersion: "1.0",
  clock: {
    hsi: 8,
    hseOptions: [
      4,
      8,
      12,
      16,
      24
    ],
    lsi: 40,
    pllSource: "HSI",
    pllMin: 5,
    pllMax: 12,
    maxSysclk: 96,
    ahbDivs: [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512
    ],
    apb1Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb2Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    adcDivs: [
      2,
      4,
      6,
      8,
      12,
      16
    ],
    notes: [
      "PLL \u8F93\u5165 3\u201325 MHz\uFF0C\u8F93\u51FA 18\u201396 MHz\uFF08\u88683-16\uFF09",
      "USBFS \u9700\u8981 PLL = 48 / 72 / 96 MHz \u4E4B\u4E00"
    ]
  },
  packages: [
    {
      id: "CH32L103C8T6",
      label: "LQFP48",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 5,
          name: "OSC_IN",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u5165\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 6,
          name: "OSC_OUT",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u51FA\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "VSSA",
          kind: "power"
        },
        {
          num: 9,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 10,
          name: "PA0",
          kind: "io"
        },
        {
          num: 11,
          name: "PA1",
          kind: "io"
        },
        {
          num: 12,
          name: "PA2",
          kind: "io"
        },
        {
          num: 13,
          name: "PA3",
          kind: "io"
        },
        {
          num: 14,
          name: "PA4",
          kind: "io"
        },
        {
          num: 15,
          name: "PA5",
          kind: "io"
        },
        {
          num: 16,
          name: "PA6",
          kind: "io"
        },
        {
          num: 17,
          name: "PA7",
          kind: "io"
        },
        {
          num: 18,
          name: "PB0",
          kind: "io"
        },
        {
          num: 19,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB10 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 20,
          name: "PB2",
          kind: "io"
        },
        {
          num: 21,
          name: "PB10",
          kind: "io"
        },
        {
          num: 22,
          name: "PB11",
          kind: "io"
        },
        {
          num: 23,
          name: "VSS",
          kind: "power"
        },
        {
          num: 24,
          name: "VDD",
          kind: "power"
        },
        {
          num: 25,
          name: "PB12",
          kind: "io"
        },
        {
          num: 26,
          name: "PB13",
          kind: "io",
          note: "\u4E0E PB6 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 27,
          name: "PB14",
          kind: "io"
        },
        {
          num: 28,
          name: "PB15",
          kind: "io"
        },
        {
          num: 29,
          name: "PA8",
          kind: "io"
        },
        {
          num: 30,
          name: "PA9",
          kind: "io"
        },
        {
          num: 31,
          name: "PA10",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 32,
          name: "PA11",
          kind: "io",
          note: "\u4E0E PA13 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 33,
          name: "PA12",
          kind: "io",
          note: "\u4E0E PA14 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 34,
          name: "PA13",
          kind: "io",
          note: "\u4E0E PB6 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 35,
          name: "VSS",
          kind: "power"
        },
        {
          num: 36,
          name: "VDD",
          kind: "power"
        },
        {
          num: 37,
          name: "PA14",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 38,
          name: "PA15",
          kind: "io"
        },
        {
          num: 39,
          name: "PB3",
          kind: "io"
        },
        {
          num: 40,
          name: "PB4",
          kind: "io"
        },
        {
          num: 41,
          name: "PB5",
          kind: "io"
        },
        {
          num: 42,
          name: "PB6",
          kind: "io"
        },
        {
          num: 43,
          name: "PB7",
          kind: "io"
        },
        {
          num: 44,
          name: "BOOT0",
          kind: "boot",
          note: "\u4E0E PB9 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 45,
          name: "PB8",
          kind: "io"
        },
        {
          num: 46,
          name: "PB9",
          kind: "io"
        },
        {
          num: 47,
          name: "VSS",
          kind: "power"
        },
        {
          num: 48,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "CH32L103K8U6",
      label: "QFN32",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 3,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 4,
          name: "OSC_IN",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u5165\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 5,
          name: "OSC_OUT",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u51FA\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PA6",
          kind: "io"
        },
        {
          num: 13,
          name: "PA7",
          kind: "io"
        },
        {
          num: 14,
          name: "PB0",
          kind: "io"
        },
        {
          num: 15,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB10 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 16,
          name: "PB2",
          kind: "io"
        },
        {
          num: 17,
          name: "PB15",
          kind: "io"
        },
        {
          num: 18,
          name: "PA8",
          kind: "io"
        },
        {
          num: 19,
          name: "PA9",
          kind: "io"
        },
        {
          num: 20,
          name: "PA10",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 21,
          name: "PA11",
          kind: "io",
          note: "\u4E0E PA13 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 22,
          name: "PA12",
          kind: "io",
          note: "\u4E0E PA14 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 23,
          name: "PA13",
          kind: "io",
          note: "\u4E0E PB6 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 24,
          name: "PA14",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 25,
          name: "PA15",
          kind: "io"
        },
        {
          num: 26,
          name: "PB3",
          kind: "io"
        },
        {
          num: 27,
          name: "PB4",
          kind: "io"
        },
        {
          num: 28,
          name: "PB5",
          kind: "io"
        },
        {
          num: 29,
          name: "PB6",
          kind: "io"
        },
        {
          num: 30,
          name: "PB7",
          kind: "io"
        },
        {
          num: 31,
          name: "BOOT0",
          kind: "boot",
          aliases: [
            "PB9"
          ],
          note: "\u5185\u90E8\u4E0E PB9 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 32,
          name: "PB8",
          kind: "io"
        }
      ]
    },
    {
      id: "CH32L103K8U7",
      label: "QFN32",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 3,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 4,
          name: "OSC_IN",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u5165\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 5,
          name: "OSC_OUT",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u51FA\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PA6",
          kind: "io"
        },
        {
          num: 13,
          name: "PA7",
          kind: "io"
        },
        {
          num: 14,
          name: "PB0",
          kind: "io"
        },
        {
          num: 15,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB10 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 16,
          name: "PB2",
          kind: "io"
        },
        {
          num: 17,
          name: "PB15",
          kind: "io"
        },
        {
          num: 18,
          name: "PA8",
          kind: "io"
        },
        {
          num: 19,
          name: "PA9",
          kind: "io"
        },
        {
          num: 20,
          name: "PA10",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 21,
          name: "PA11",
          kind: "io",
          note: "\u4E0E PA13 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 22,
          name: "PA12",
          kind: "io",
          note: "\u4E0E PA14 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 23,
          name: "PA13",
          kind: "io",
          note: "\u4E0E PB6 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 24,
          name: "PA14",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 25,
          name: "PA15",
          kind: "io"
        },
        {
          num: 26,
          name: "PB3",
          kind: "io"
        },
        {
          num: 27,
          name: "PB4",
          kind: "io"
        },
        {
          num: 28,
          name: "PB5",
          kind: "io"
        },
        {
          num: 29,
          name: "PB6",
          kind: "io"
        },
        {
          num: 30,
          name: "PB7",
          kind: "io"
        },
        {
          num: 31,
          name: "BOOT0",
          kind: "boot",
          aliases: [
            "PB9"
          ],
          note: "\u5185\u90E8\u4E0E PB9 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 32,
          name: "PB8",
          kind: "io"
        }
      ]
    },
    {
      id: "CH32L103G8R6",
      label: "QSOP28",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PA14",
          kind: "io",
          aliases: [
            "PB5"
          ],
          note: "\u5185\u90E8\u4E0E PB5 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 2,
          name: "PB6",
          kind: "io"
        },
        {
          num: 3,
          name: "PB7",
          kind: "io"
        },
        {
          num: 4,
          name: "PB3",
          kind: "io"
        },
        {
          num: 5,
          name: "PB8",
          kind: "io"
        },
        {
          num: 6,
          name: "VDD",
          kind: "power"
        },
        {
          num: 7,
          name: "VSS",
          kind: "power"
        },
        {
          num: 8,
          name: "OSC_IN",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u5165\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 9,
          name: "PA0",
          kind: "io"
        },
        {
          num: 10,
          name: "PA1",
          kind: "io"
        },
        {
          num: 11,
          name: "PA2",
          kind: "io"
        },
        {
          num: 12,
          name: "PA3",
          kind: "io"
        },
        {
          num: 13,
          name: "PA4",
          kind: "io"
        },
        {
          num: 14,
          name: "PA5",
          kind: "io"
        },
        {
          num: 15,
          name: "PA6",
          kind: "io"
        },
        {
          num: 16,
          name: "PB0",
          kind: "io"
        },
        {
          num: 17,
          name: "PA7",
          kind: "io"
        },
        {
          num: 18,
          name: "PB1",
          kind: "io",
          aliases: [
            "PB10"
          ],
          note: "\u5185\u90E8\u4E0E PB10 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 19,
          name: "PB11",
          kind: "io"
        },
        {
          num: 20,
          name: "PB12",
          kind: "io"
        },
        {
          num: 21,
          name: "PB13",
          kind: "io",
          note: "\u4E0E PB6 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 22,
          name: "PB14",
          kind: "io"
        },
        {
          num: 23,
          name: "PB15",
          kind: "io"
        },
        {
          num: 24,
          name: "PA8",
          kind: "io"
        },
        {
          num: 25,
          name: "PA9",
          kind: "io"
        },
        {
          num: 26,
          name: "PA10",
          kind: "io",
          note: "\u4E0E PB7 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 27,
          name: "PA11",
          kind: "io",
          note: "\u4E0E PA13 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 28,
          name: "PA12",
          kind: "io",
          note: "\u5185\u90E8\u4E0E PA13 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A",
          aliases: [
            "PA13"
          ]
        }
      ]
    },
    {
      id: "CH32L103F8U6",
      label: "QFN20",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PA0",
          kind: "io"
        },
        {
          num: 2,
          name: "PA1",
          kind: "io"
        },
        {
          num: 3,
          name: "PA2",
          kind: "io"
        },
        {
          num: 4,
          name: "PA3",
          kind: "io"
        },
        {
          num: 5,
          name: "PA4",
          kind: "io"
        },
        {
          num: 6,
          name: "PA5",
          kind: "io"
        },
        {
          num: 7,
          name: "PA7",
          kind: "io"
        },
        {
          num: 8,
          name: "PB0",
          kind: "io"
        },
        {
          num: 9,
          name: "PB1",
          kind: "io",
          aliases: [
            "PB10"
          ],
          note: "\u5185\u90E8\u4E0E PB10 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 10,
          name: "PB11",
          kind: "io"
        },
        {
          num: 11,
          name: "PB13",
          kind: "io",
          aliases: [
            "PB6"
          ],
          note: "\u5185\u90E8\u4E0E PB6 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 12,
          name: "PB14",
          kind: "io"
        },
        {
          num: 13,
          name: "PB15",
          kind: "io"
        },
        {
          num: 14,
          name: "PA8",
          kind: "io"
        },
        {
          num: 15,
          name: "PA9",
          kind: "io"
        },
        {
          num: 16,
          name: "PA12",
          kind: "io",
          aliases: [
            "PA14"
          ],
          note: "\u5185\u90E8\u4E0E PA14 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 17,
          name: "PA11",
          kind: "io",
          aliases: [
            "PA13"
          ],
          note: "\u5185\u90E8\u4E0E PA13 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 18,
          name: "PA10",
          kind: "io",
          aliases: [
            "PB7"
          ],
          note: "\u5185\u90E8\u4E0E PB7 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 19,
          name: "VDD",
          kind: "power"
        },
        {
          num: 20,
          name: "PA6",
          kind: "io"
        }
      ]
    },
    {
      id: "CH32L103F8P6",
      label: "TSSOP20",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "BOOT0",
          kind: "boot",
          aliases: [
            "PB8"
          ],
          note: "\u5185\u90E8\u4E0E PB8 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 2,
          name: "OSC_IN",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u5165\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 3,
          name: "OSC_OUT",
          kind: "io",
          note: "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F\u8F93\u51FA\uFF08\u4E5F\u53EF\u914D\u6210\u666E\u901A IO\uFF09"
        },
        {
          num: 4,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 5,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PA6",
          kind: "io"
        },
        {
          num: 13,
          name: "PA7",
          kind: "io"
        },
        {
          num: 14,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB10 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 15,
          name: "VSS",
          kind: "power"
        },
        {
          num: 16,
          name: "VDD",
          kind: "power"
        },
        {
          num: 17,
          name: "PA11",
          kind: "io",
          note: "\u4E0E PA13 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 18,
          name: "PA12",
          kind: "io",
          note: "\u4E0E PA14 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 19,
          name: "PA13",
          kind: "io",
          aliases: [
            "PB6"
          ],
          note: "\u5185\u90E8\u4E0E PB6 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        },
        {
          num: 20,
          name: "PA14",
          kind: "io",
          aliases: [
            "PB7"
          ],
          note: "\u5185\u90E8\u4E0E PB7 \u77ED\u63A5\u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A"
        }
      ]
    }
  ],
  ports: {
    OSC_IN: [
      {
        fn: "CLK_HSE_IN"
      },
      {
        fn: "USART3_TX",
        remap: "3"
      },
      {
        fn: "USART3_RX",
        remap: "2"
      },
      {
        fn: "CAN1_RX",
        remap: "3"
      }
    ],
    OSC_OUT: [
      {
        fn: "CLK_HSE_OUT"
      },
      {
        fn: "USART3_TX",
        remap: "2"
      },
      {
        fn: "USART3_RX",
        remap: "3"
      },
      {
        fn: "CAN1_TX",
        remap: "3"
      }
    ],
    PA0: [
      {
        fn: "ADC1_IN0"
      },
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "TIM2_ETR"
      },
      {
        fn: "USART2_CTS"
      },
      {
        fn: "OPA1_P4"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      },
      {
        fn: "TIM2_ETR",
        remap: "2"
      },
      {
        fn: "USART2_CTS",
        remap: "2"
      },
      {
        fn: "USART2_CTS",
        remap: "3"
      }
    ],
    PA1: [
      {
        fn: "ADC1_IN1"
      },
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "USART2_RTS"
      },
      {
        fn: "OPA1_N4"
      },
      {
        fn: "TIM1_CH1",
        remap: "2"
      },
      {
        fn: "TIM1_CH1",
        remap: "3"
      },
      {
        fn: "TIM2_CH2",
        remap: "2"
      },
      {
        fn: "TIM1_CH2N",
        remap: "5"
      },
      {
        fn: "USART2_RTS",
        remap: "2"
      },
      {
        fn: "USART2_RTS",
        remap: "3"
      }
    ],
    PA10: [
      {
        fn: "TIM1_CH3"
      },
      {
        fn: "USART1_RX"
      },
      {
        fn: "TIM1_CH3",
        remap: "1"
      }
    ],
    PA11: [
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "USB1_DM"
      },
      {
        fn: "CAN1_RX"
      },
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "1"
      },
      {
        fn: "USART2_TX",
        remap: "2"
      },
      {
        fn: "USART2_RX",
        remap: "3"
      }
    ],
    PA12: [
      {
        fn: "USART1_RTS"
      },
      {
        fn: "USB1_DP"
      },
      {
        fn: "CAN1_TX"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "USART1_RTS",
        remap: "1"
      },
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "TIM1_BKIN",
        remap: "4"
      },
      {
        fn: "TIM1_BKIN",
        remap: "5"
      },
      {
        fn: "TIM2_CH1",
        remap: "5"
      },
      {
        fn: "TIM2_ETR",
        remap: "5"
      },
      {
        fn: "TIM2_CH1",
        remap: "7"
      },
      {
        fn: "TIM2_ETR",
        remap: "7"
      },
      {
        fn: "USART1_RX",
        remap: "5"
      },
      {
        fn: "USART2_TX",
        remap: "3"
      },
      {
        fn: "USART2_RX",
        remap: "2"
      },
      {
        fn: "I2C1_SDA",
        remap: "2"
      },
      {
        fn: "SPI1_NSS",
        remap: "2"
      }
    ],
    PA13: [
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "TIM1_ETR",
        remap: "5"
      },
      {
        fn: "TIM1_BKIN",
        remap: "2"
      },
      {
        fn: "TIM1_BKIN",
        remap: "3"
      },
      {
        fn: "USART1_RTS",
        remap: "2"
      },
      {
        fn: "USART1_RTS",
        remap: "4"
      },
      {
        fn: "I2C1_SCL",
        remap: "2"
      }
    ],
    PA14: [
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "TIM1_CH3",
        remap: "2"
      },
      {
        fn: "TIM1_CH3",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N",
        remap: "4"
      },
      {
        fn: "TIM1_CH1N",
        remap: "5"
      },
      {
        fn: "USART1_CTS",
        remap: "4"
      }
    ],
    PA15: [
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "TIM2_ETR",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "3"
      },
      {
        fn: "TIM2_ETR",
        remap: "3"
      },
      {
        fn: "USART4_RTS",
        remap: "1"
      },
      {
        fn: "SPI1_NSS",
        remap: "1"
      }
    ],
    PA2: [
      {
        fn: "ADC1_IN2"
      },
      {
        fn: "CMP1_P0"
      },
      {
        fn: "OPA1_OUT2"
      },
      {
        fn: "TIM2_CH3"
      },
      {
        fn: "USART2_TX"
      },
      {
        fn: "TIM1_CH4",
        remap: "4"
      },
      {
        fn: "TIM2_CH2",
        remap: "4"
      },
      {
        fn: "TIM2_CH2",
        remap: "5"
      },
      {
        fn: "TIM2_CH3",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "2"
      }
    ],
    PA3: [
      {
        fn: "ADC1_IN3"
      },
      {
        fn: "OPA1_OUT0"
      },
      {
        fn: "TIM2_CH4"
      },
      {
        fn: "USART2_RX"
      },
      {
        fn: "TIM1_ETR",
        remap: "3"
      },
      {
        fn: "TIM1_CH4",
        remap: "5"
      },
      {
        fn: "TIM2_CH1",
        remap: "4"
      },
      {
        fn: "TIM2_ETR",
        remap: "4"
      },
      {
        fn: "TIM2_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "2"
      }
    ],
    PA4: [
      {
        fn: "ADC1_IN4"
      },
      {
        fn: "OPA1_OUT3"
      },
      {
        fn: "USART2_CK"
      },
      {
        fn: "SPI1_NSS"
      },
      {
        fn: "TIM2_CH4",
        remap: "7"
      },
      {
        fn: "USART1_TX",
        remap: "2"
      },
      {
        fn: "USART1_RX",
        remap: "3"
      },
      {
        fn: "USART2_CK",
        remap: "2"
      },
      {
        fn: "USART2_CK",
        remap: "3"
      }
    ],
    PA5: [
      {
        fn: "ADC1_IN5"
      },
      {
        fn: "SPI1_SCK"
      },
      {
        fn: "OPA1_N3"
      },
      {
        fn: "TIM2_CH3",
        remap: "7"
      },
      {
        fn: "USART1_TX",
        remap: "3"
      },
      {
        fn: "USART1_RX",
        remap: "2"
      },
      {
        fn: "USART4_TX",
        remap: "1"
      }
    ],
    PA6: [
      {
        fn: "ADC1_IN6"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "SPI1_MISO"
      },
      {
        fn: "OPA1_N1"
      },
      {
        fn: "OPA1_P5"
      },
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "TIM2_CH4",
        remap: "4"
      },
      {
        fn: "TIM2_CH4",
        remap: "5"
      },
      {
        fn: "USART1_CK",
        remap: "3"
      },
      {
        fn: "USART1_CK",
        remap: "4"
      },
      {
        fn: "USART4_CK",
        remap: "1"
      }
    ],
    PA7: [
      {
        fn: "SPI1_MOSI"
      },
      {
        fn: "ADC1_IN7"
      },
      {
        fn: "TIM3_CH2"
      },
      {
        fn: "OPA1_N5"
      },
      {
        fn: "OPA1_P3"
      },
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "TIM1_CH2",
        remap: "2"
      },
      {
        fn: "TIM1_CH2",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "1"
      }
    ],
    PA8: [
      {
        fn: "TIM1_CH1"
      },
      {
        fn: "USART1_CK"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "1"
      }
    ],
    PA9: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "USART1_TX"
      },
      {
        fn: "TIM1_CH2",
        remap: "1"
      }
    ],
    PB0: [
      {
        fn: "ADC1_IN8"
      },
      {
        fn: "TIM3_CH3"
      },
      {
        fn: "USART4_TX"
      },
      {
        fn: "CMP1_OUT0"
      },
      {
        fn: "OPA1_P1"
      },
      {
        fn: "OPA1_OUT4"
      },
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "TIM1_CH2N",
        remap: "2"
      },
      {
        fn: "TIM1_CH2N",
        remap: "3"
      },
      {
        fn: "TIM3_CH3",
        remap: "1"
      }
    ],
    PB1: [
      {
        fn: "ADC1_IN9"
      },
      {
        fn: "TIM3_CH4"
      },
      {
        fn: "USART4_RX"
      },
      {
        fn: "CMP1_N0"
      },
      {
        fn: "OPA1_OUT1"
      },
      {
        fn: "TIM1_CH1",
        remap: "5"
      },
      {
        fn: "TIM1_CH4",
        remap: "2"
      },
      {
        fn: "TIM1_CH4",
        remap: "3"
      },
      {
        fn: "TIM1_CH2N",
        remap: "4"
      },
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "TIM3_CH4",
        remap: "1"
      }
    ],
    PB10: [
      {
        fn: "USART3_TX"
      },
      {
        fn: "I2C2_SCL"
      },
      {
        fn: "CMP1_OUT1"
      },
      {
        fn: "CMP3_P1"
      },
      {
        fn: "OPA1_N2"
      },
      {
        fn: "OPA1_N6"
      },
      {
        fn: "TIM4_CH1",
        remap: "1"
      },
      {
        fn: "TIM2_CH3",
        remap: "2"
      },
      {
        fn: "TIM2_CH3",
        remap: "3"
      }
    ],
    PB11: [
      {
        fn: "CMP2_OUT1"
      },
      {
        fn: "CMP3_N1"
      },
      {
        fn: "OPA1_N0"
      },
      {
        fn: "USART3_RX"
      },
      {
        fn: "I2C2_SDA"
      },
      {
        fn: "TIM1_CH1N",
        remap: "2"
      },
      {
        fn: "TIM1_CH1N",
        remap: "3"
      },
      {
        fn: "TIM2_CH4",
        remap: "2"
      },
      {
        fn: "TIM2_CH4",
        remap: "3"
      },
      {
        fn: "TIM4_CH2",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "4"
      },
      {
        fn: "I2C1_SDA",
        remap: "3"
      }
    ],
    PB12: [
      {
        fn: "CMP3_OUT1"
      },
      {
        fn: "TIM1_BKIN"
      },
      {
        fn: "LPTIM_CH1"
      },
      {
        fn: "USART3_CK"
      },
      {
        fn: "I2C2_SMBA"
      },
      {
        fn: "SPI2_NSS"
      },
      {
        fn: "TIM1_CH3",
        remap: "4"
      },
      {
        fn: "TIM2_CH3",
        remap: "4"
      },
      {
        fn: "TIM2_CH3",
        remap: "5"
      },
      {
        fn: "USART1_TX",
        remap: "5"
      },
      {
        fn: "USART3_CK",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "3"
      },
      {
        fn: "SPI1_NSS",
        remap: "3"
      }
    ],
    PB13: [
      {
        fn: "TIM1_CH1N"
      },
      {
        fn: "LPTIM_CH2"
      },
      {
        fn: "USART3_CTS"
      },
      {
        fn: "SPI2_SCK"
      },
      {
        fn: "USART3_CTS",
        remap: "2"
      },
      {
        fn: "USART3_CTS",
        remap: "3"
      }
    ],
    PB14: [
      {
        fn: "TIM1_CH2N"
      },
      {
        fn: "LPTIM_ETR"
      },
      {
        fn: "USART3_RTS"
      },
      {
        fn: "SPI2_MISO"
      },
      {
        fn: "OPA1_P2"
      },
      {
        fn: "USART3_RTS",
        remap: "2"
      },
      {
        fn: "USART3_RTS",
        remap: "3"
      }
    ],
    PB15: [
      {
        fn: "TIM1_CH3N"
      },
      {
        fn: "LPTIM_OUT"
      },
      {
        fn: "SPI2_MOSI"
      },
      {
        fn: "OPA1_P0"
      }
    ],
    PB2: [
      {
        fn: "USART4_CK"
      },
      {
        fn: "CMP1_P1"
      },
      {
        fn: "LPTIM_OUT",
        remap: "1"
      }
    ],
    PB3: [
      {
        fn: "CMP1_N1"
      },
      {
        fn: "CMP2_N0"
      },
      {
        fn: "CMP3_N0"
      },
      {
        fn: "USART4_CTS"
      },
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "3"
      },
      {
        fn: "SPI1_SCK",
        remap: "1"
      }
    ],
    PB4: [
      {
        fn: "CMP3_OUT0"
      },
      {
        fn: "USART4_RTS"
      },
      {
        fn: "TIM3_CH1",
        remap: "1"
      },
      {
        fn: "SPI1_MISO",
        remap: "1"
      }
    ],
    PB5: [
      {
        fn: "I2C1_SMBA"
      },
      {
        fn: "CMP2_OUT0"
      },
      {
        fn: "CMP3_P0"
      },
      {
        fn: "LPTIM_CH1",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "1"
      },
      {
        fn: "USART4_RX",
        remap: "1"
      },
      {
        fn: "I2C1_SMBA",
        remap: "2"
      },
      {
        fn: "I2C1_SMBA",
        remap: "3"
      },
      {
        fn: "SPI1_MOSI",
        remap: "1"
      }
    ],
    PB6: [
      {
        fn: "TIM4_CH1"
      },
      {
        fn: "I2C1_SCL"
      },
      {
        fn: "USBPD_CC1"
      },
      {
        fn: "CMP2_P1"
      },
      {
        fn: "LPTIM_ETR",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "5"
      },
      {
        fn: "SPI1_SCK",
        remap: "2"
      },
      {
        fn: "SPI1_SCK",
        remap: "3"
      },
      {
        fn: "TIM1_ETR",
        remap: "2"
      },
      {
        fn: "TIM1_ETR",
        remap: "4"
      },
      {
        fn: "TIM1_CH3",
        remap: "5"
      }
    ],
    PB7: [
      {
        fn: "TIM4_CH2"
      },
      {
        fn: "I2C1_SDA"
      },
      {
        fn: "USBPD_CC2"
      },
      {
        fn: "CMP2_N1"
      },
      {
        fn: "LPTIM_CH2",
        remap: "1"
      },
      {
        fn: "USART1_RX",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "3"
      },
      {
        fn: "USART1_CTS",
        remap: "5"
      },
      {
        fn: "SPI1_MOSI",
        remap: "2"
      },
      {
        fn: "SPI1_MOSI",
        remap: "3"
      },
      {
        fn: "TIM1_CH1",
        remap: "4"
      },
      {
        fn: "TIM1_CH3N",
        remap: "5"
      }
    ],
    PB8: [
      {
        fn: "TIM4_CH3"
      },
      {
        fn: "CMP2_P0"
      },
      {
        fn: "TIM4_CH3",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "3"
      },
      {
        fn: "USART1_RTS",
        remap: "5"
      },
      {
        fn: "SPI1_MISO",
        remap: "2"
      },
      {
        fn: "SPI1_MISO",
        remap: "3"
      },
      {
        fn: "CAN1_RX",
        remap: "2"
      },
      {
        fn: "TIM1_CH2",
        remap: "4"
      },
      {
        fn: "TIM1_CH2",
        remap: "5"
      },
      {
        fn: "TIM2_CH2",
        remap: "7"
      }
    ],
    PB9: [
      {
        fn: "TIM4_CH4"
      },
      {
        fn: "TIM4_CH4",
        remap: "1"
      },
      {
        fn: "USART1_RX",
        remap: "4"
      },
      {
        fn: "I2C1_SCL",
        remap: "3"
      },
      {
        fn: "CAN1_TX",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "TIM1_CH3N",
        remap: "4"
      }
    ],
    PC13: [],
    PC14: [
      {
        fn: "CLK_LSE_IN"
      }
    ],
    PC15: [
      {
        fn: "CLK_LSE_OUT"
      }
    ],
    VBAT: [],
    VDDA: [],
    VSSA: []
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN0",
        "IN1",
        "IN2",
        "IN3",
        "IN4",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9"
      ]
    },
    {
      id: "CAN1",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "CLK",
      signals: [
        "HSE_IN",
        "HSE_OUT",
        "LSE_IN",
        "LSE_OUT"
      ]
    },
    {
      id: "CMP1",
      signals: [
        "N0",
        "N1",
        "OUT0",
        "OUT1",
        "P0",
        "P1"
      ]
    },
    {
      id: "CMP2",
      signals: [
        "N0",
        "N1",
        "OUT0",
        "OUT1",
        "P0",
        "P1"
      ]
    },
    {
      id: "CMP3",
      signals: [
        "N0",
        "N1",
        "OUT0",
        "OUT1",
        "P0",
        "P1"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA",
        "SMBA"
      ]
    },
    {
      id: "I2C2",
      signals: [
        "SCL",
        "SDA",
        "SMBA"
      ]
    },
    {
      id: "LPTIM",
      signals: [
        "CH1",
        "CH2",
        "ETR",
        "OUT"
      ]
    },
    {
      id: "OPA1",
      signals: [
        "N0",
        "N1",
        "N2",
        "N3",
        "N4",
        "N5",
        "N6",
        "OUT0",
        "OUT1",
        "OUT2",
        "OUT3",
        "OUT4",
        "P0",
        "P1",
        "P2",
        "P3",
        "P4",
        "P5"
      ]
    },
    {
      id: "SPI1",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI2",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4"
      ]
    },
    {
      id: "TIM4",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART4",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USB1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "USBPD",
      signals: [
        "CC1",
        "CC2"
      ]
    },
    {
      id: "GPIO",
      signals: []
    },
    {
      id: "SYSTEM",
      signals: []
    },
    {
      id: "DBG",
      signals: []
    },
    {
      id: "RTC",
      signals: []
    },
    {
      id: "PWR",
      signals: []
    },
    {
      id: "EXTI",
      signals: []
    },
    {
      id: "CRC",
      signals: []
    },
    {
      id: "DMA",
      signals: []
    },
    {
      id: "IWDG",
      signals: []
    },
    {
      id: "WWDG",
      signals: []
    }
  ],
  irqs: [
    {
      n: 16,
      name: "WWDG",
      owner: "WWDG"
    },
    {
      n: 17,
      name: "PVD",
      owner: "PWR"
    },
    {
      n: 18,
      name: "TAMPER",
      owner: "PWR"
    },
    {
      n: 19,
      name: "RTC",
      owner: "RTC",
      gate: [
        "irqAlarm"
      ]
    },
    {
      n: 20,
      name: "FLASH",
      owner: "FLASH"
    },
    {
      n: 21,
      name: "RCC",
      owner: "SYSTEM"
    },
    {
      n: 22,
      name: "EXTI0",
      owner: "EXTI"
    },
    {
      n: 23,
      name: "EXTI1",
      owner: "EXTI"
    },
    {
      n: 24,
      name: "EXTI2",
      owner: "EXTI"
    },
    {
      n: 25,
      name: "EXTI3",
      owner: "EXTI"
    },
    {
      n: 26,
      name: "EXTI4",
      owner: "EXTI"
    },
    {
      n: 27,
      name: "DMA1_Channel1",
      owner: "DMA"
    },
    {
      n: 28,
      name: "DMA1_Channel2",
      owner: "DMA"
    },
    {
      n: 29,
      name: "DMA1_Channel3",
      owner: "DMA"
    },
    {
      n: 30,
      name: "DMA1_Channel4",
      owner: "DMA"
    },
    {
      n: 31,
      name: "DMA1_Channel5",
      owner: "DMA"
    },
    {
      n: 32,
      name: "DMA1_Channel6",
      owner: "DMA"
    },
    {
      n: 33,
      name: "DMA1_Channel7",
      owner: "DMA"
    },
    {
      n: 34,
      name: "ADC",
      owner: "ADC1",
      gate: "irqEoc"
    },
    {
      n: 35,
      name: "USB_HP_CAN1_TX",
      owner: "USB1"
    },
    {
      n: 36,
      name: "USB_LP_CAN1_RX0",
      owner: "USB1"
    },
    {
      n: 38,
      name: "CAN1_SCE",
      owner: "CAN1"
    },
    {
      n: 39,
      name: "EXTI9_5",
      owner: "EXTI"
    },
    {
      n: 40,
      name: "TIM1_BRK",
      owner: "TIM1",
      gate: "irqBreak"
    },
    {
      n: 41,
      name: "TIM1_UP",
      owner: "TIM1",
      gate: "irqUpdate"
    },
    {
      n: 42,
      name: "TIM1_TRG_COM",
      owner: "TIM1",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 43,
      name: "TIM1_CC",
      owner: "TIM1",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 44,
      name: "TIM2",
      owner: "TIM2",
      gate: "irqUpdate"
    },
    {
      n: 45,
      name: "TIM3",
      owner: "TIM3",
      gate: "irqUpdate"
    },
    {
      n: 46,
      name: "TIM4",
      owner: "TIM4",
      gate: "irqUpdate"
    },
    {
      n: 47,
      name: "I2C1_EV",
      owner: "I2C1",
      gate: "irqEvt"
    },
    {
      n: 48,
      name: "I2C1_ER",
      owner: "I2C1",
      gate: "irqErr"
    },
    {
      n: 49,
      name: "I2C2_EV",
      owner: "I2C2",
      gate: "irqEvt"
    },
    {
      n: 50,
      name: "I2C2_ER",
      owner: "I2C2",
      gate: "irqErr"
    },
    {
      n: 51,
      name: "SPI1",
      owner: "SPI1"
    },
    {
      n: 52,
      name: "SPI2",
      owner: "SPI2"
    },
    {
      n: 53,
      name: "USART1",
      owner: "USART1"
    },
    {
      n: 54,
      name: "USART2",
      owner: "USART2"
    },
    {
      n: 55,
      name: "USART3",
      owner: "USART3"
    },
    {
      n: 56,
      name: "EXTI15_10",
      owner: "EXTI"
    },
    {
      n: 57,
      name: "RTCAlarm",
      owner: "RTC",
      gate: "irqAlarm"
    },
    {
      n: 58,
      name: "LPTIMWakeUp",
      owner: "LPTIM"
    },
    {
      n: 59,
      name: "USBFS",
      owner: "USB1"
    },
    {
      n: 60,
      name: "USBFSWakeUp",
      owner: "USB1"
    },
    {
      n: 61,
      name: "USART4",
      owner: "USART4"
    },
    {
      n: 62,
      name: "DMA1_Channel8",
      owner: "DMA"
    },
    {
      n: 63,
      name: "LPTIM",
      owner: "LPTIM"
    },
    {
      n: 64,
      name: "OPA",
      owner: "OPA1"
    },
    {
      n: 65,
      name: "USBPD",
      owner: "USBPD"
    },
    {
      n: 67,
      name: "USBPDWakeUp",
      owner: "USBPD"
    },
    {
      n: 68,
      name: "CMPWakeUp",
      owner: "CMP1"
    }
  ],
  pending: [
    "packages/ports \u7531 scripts/rebuild_l103_from_ds.py \u4ECE DS0 \u88682-1-1 \u81EA\u52A8\u751F\u6210\uFF0Cremap \u5B57\u6BB5\u5C31\u662F\u8868\u91CC\u7684 AFIO \u914D\u7F6E\u4F4D\u6570\u503C\uFF1B\u6362\u65B0\u5F15\u811A\u8868\u540E\u91CD\u8DD1\u811A\u672C\u5373\u53EF",
    "G8R6\uFF08QSOP28\uFF09\u7684\u5F15\u811A\u884C\u53EA\u5199\u4E86 pin 28 = PA12\uFF0C\u4F46\u8868\u672B\u300C\u5C01\u88C5\u5185\u90E8\u77ED\u63A5\u300D\u5199\u7740 PA12\u2194PA13\uFF0C\u6309\u5408\u5C01\u8868\u628A PA13 \u8865\u6210\u8BE5\u811A\u522B\u540D \u2014\u2014 \u5426\u5219\u8FD9\u9897\u7247\u5B50\u4F1A\u300C\u6709 SWCLK \u6CA1 SWDIO\u300D\u3002\u5F85\u5BF9\u7167 DS0 \u539F\u56FE\u786E\u8BA4",
    "MCO / WKUP / TAMPER / RTC \u8FD9\u51E0\u4E2A\u591A\u529F\u80FD\u6CA1\u6709\u5EFA\u6A21\u6210\u5916\u8BBE\u4FE1\u53F7\uFF0C\u5F15\u811A\u83DC\u5355\u91CC\u4E0D\u51FA\u73B0",
    "\u5DF2\u7528 CH32L103EVT \u7684 ch32l103.h \u6821\u6B63\uFF1ARCC \u662F PB1/PB2/HB \u547D\u540D\uFF08\u975E APB\uFF09\u3001debug.h \u65E0 SDI \u6253\u5370\uFF08\u53EA\u6709 USART_Printf_Init\uFF09\u3001IRQn \u540D\u6309\u679A\u4E3E\u66F4\u6B63\u5E76\u8865\u9F50 USBPDWakeUp/CMPWakeUp"
  ],
  buses: {
    USB1: "AHB",
    USBPD: "AHB"
  }
};

// src/core/devices/data/ch32x035.json
var ch32x035_default = {
  packVersion: "0.1.0",
  series: "CH32X035",
  vendor: "WCH",
  core: "QingKe V4C \xB7 RV32IMAC",
  source: "CH32X035/X033DS0 V2.3 \u88682-1\uFF08\u5F15\u811A\u5B9A\u4E49\uFF09\u3001\u88681-1\uFF08\u8D44\u6E90\uFF09\u3001CH32X035RM V1.9 \u88687-1",
  flashKb: 62,
  ramKb: 20,
  voltage: "2.0 \u2013 5.5 V",
  maxSysclk: 48,
  extiLines: 24,
  dmaChannels: 8,
  dmaMap: {
    "1": [
      "ADC",
      "USART4_TX",
      "TIM2_CH3"
    ],
    "2": [
      "SPI1_RX",
      "USART3_TX",
      "TIM1_CH1",
      "TIM2_UP"
    ],
    "3": [
      "SPI1_TX",
      "USART3_RX",
      "TIM1_CH2"
    ],
    "4": [
      "USART1_TX",
      "TIM1_CH4",
      "TIM1_TRIG",
      "TIM1_COM"
    ],
    "5": [
      "USART1_RX",
      "TIM1_UP",
      "TIM2_CH1"
    ],
    "6": [
      "USART2_RX",
      "I2C1_TX",
      "TIM1_CH3"
    ],
    "7": [
      "USART2_TX",
      "I2C1_RX",
      "TIM2_CH2",
      "TIM2_CH4"
    ],
    "8": [
      "USART4_RX",
      "TIM2_TRIG",
      "TIM2_COM"
    ]
  },
  debug: {
    twoWire: true,
    singleWire: false,
    note: "\u4E32\u884C 2 \u7EBF\u8C03\u8BD5\u63A5\u53E3\uFF08SDI\uFF09\uFF1ASWDIO + SWCLK\u3002\u7CFB\u7EDF\u4E0A\u7535\u6216\u590D\u4F4D\u540E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u4E3B\u7A0B\u5E8F\u91CC\u53EF\u4EE5\u5173\u6389\u628A\u8FD9\u4E24\u4E2A\u811A\u91CA\u653E\u6210\u666E\u901A GPIO\u3002",
    swdio: "PC18",
    swclk: "PC19"
  },
  api: {
    clockProfile: "hsi-only",
    clockAliases: {
      USB1: "USBFS"
    },
    clockApi: "apb",
    nvicApi: "stdlib",
    gpioSpeedStyle: "mhz",
    adcSampleStyle: "cycles",
    flashLatency: true,
    adcClock: "adc",
    flashPrefetch: false,
    gpioSpeeds: [
      "50"
    ],
    gpioOpenDrain: false,
    nvicGroups: [
      0,
      1
    ],
    adcSampleTimes: [
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11"
    ],
    note: "X035: RCC \u65E0 PLL/SYSCLK/PCLK/ADCCLK\uFF1BADC \u65F6\u949F\u7528 ADC_CLKConfig\uFF1BGPIO \u53EA\u6709 50MHz \u4E14\u65E0\u5F00\u6F0F\uFF1BNVIC \u53EA\u6709 Group_0/1\uFF1B\u91C7\u6837\u65F6\u95F4\u662F\u6574\u6570\u5468\u671F"
  },
  peripheralVersion: "1.5",
  clock: {
    hsi: 48,
    hseOptions: [],
    lsi: 47,
    pllSource: "HSI",
    pllMin: 1,
    pllMax: 1,
    maxSysclk: 48,
    ahbDivs: [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512
    ],
    apb1Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb2Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    notes: [
      "CH32X035 \u53EA\u6709\u5185\u90E8 48 MHz RC \u632F\u8361\u5668\uFF0C\u65E0 HSE\u3001\u65E0 PLL\uFF08DS 1.4.6\uFF09",
      "\u590D\u4F4D\u540E HSI/6 = 8 MHz \u4F5C\u4E3A\u9ED8\u8BA4 SYSCLK"
    ]
  },
  packages: [
    {
      id: "CH32X035R8T6",
      label: "LQFP64M",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PA15",
          kind: "io"
        },
        {
          num: 2,
          name: "PA16",
          kind: "io"
        },
        {
          num: 3,
          name: "PA17",
          kind: "io"
        },
        {
          num: 4,
          name: "PA18",
          kind: "io"
        },
        {
          num: 5,
          name: "PA19",
          kind: "io"
        },
        {
          num: 6,
          name: "PA20",
          kind: "io"
        },
        {
          num: 7,
          name: "PA21",
          kind: "io"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "PC3",
          kind: "io"
        },
        {
          num: 12,
          name: "PA22",
          kind: "io"
        },
        {
          num: 13,
          name: "PA23",
          kind: "io"
        },
        {
          num: 14,
          name: "PA0",
          kind: "io"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "PC4",
          kind: "io"
        },
        {
          num: 19,
          name: "PC5",
          kind: "io"
        },
        {
          num: 20,
          name: "PA4",
          kind: "io"
        },
        {
          num: 21,
          name: "PA5",
          kind: "io"
        },
        {
          num: 22,
          name: "PA6",
          kind: "io"
        },
        {
          num: 23,
          name: "PA7",
          kind: "io"
        },
        {
          num: 24,
          name: "PC6",
          kind: "io"
        },
        {
          num: 25,
          name: "PC7",
          kind: "io"
        },
        {
          num: 26,
          name: "PB0",
          kind: "io"
        },
        {
          num: 27,
          name: "PB1",
          kind: "io"
        },
        {
          num: 28,
          name: "PB2",
          kind: "io"
        },
        {
          num: 29,
          name: "PB3",
          kind: "io"
        },
        {
          num: 30,
          name: "PB4",
          kind: "io"
        },
        {
          num: 31,
          name: "GND",
          kind: "io"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power"
        },
        {
          num: 33,
          name: "PB5",
          kind: "io"
        },
        {
          num: 34,
          name: "PB6",
          kind: "io"
        },
        {
          num: 35,
          name: "PB7",
          kind: "io"
        },
        {
          num: 36,
          name: "PB8",
          kind: "io"
        },
        {
          num: 37,
          name: "PB16",
          kind: "io"
        },
        {
          num: 38,
          name: "PB17",
          kind: "io"
        },
        {
          num: 39,
          name: "PB18",
          kind: "io"
        },
        {
          num: 40,
          name: "PB19",
          kind: "io"
        },
        {
          num: 41,
          name: "PB9",
          kind: "io"
        },
        {
          num: 42,
          name: "PB10",
          kind: "io"
        },
        {
          num: 43,
          name: "PB11",
          kind: "io"
        },
        {
          num: 44,
          name: "PC11",
          kind: "io"
        },
        {
          num: 45,
          name: "PC10",
          kind: "io"
        },
        {
          num: 46,
          name: "PC18",
          kind: "io"
        },
        {
          num: 47,
          name: "PB12",
          kind: "io"
        },
        {
          num: 48,
          name: "PB13",
          kind: "io"
        },
        {
          num: 49,
          name: "PC19",
          kind: "io"
        },
        {
          num: 50,
          name: "PB14",
          kind: "io"
        },
        {
          num: 51,
          name: "PB20",
          kind: "io"
        },
        {
          num: 52,
          name: "PB21",
          kind: "io"
        },
        {
          num: 53,
          name: "PB15",
          kind: "io"
        },
        {
          num: 54,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 55,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 56,
          name: "PA8",
          kind: "io"
        },
        {
          num: 57,
          name: "PA9",
          kind: "io"
        },
        {
          num: 58,
          name: "PA10",
          kind: "io"
        },
        {
          num: 59,
          name: "PA11",
          kind: "io"
        },
        {
          num: 60,
          name: "PA12",
          kind: "io"
        },
        {
          num: 61,
          name: "PA13",
          kind: "io"
        },
        {
          num: 62,
          name: "PA14",
          kind: "io"
        },
        {
          num: 63,
          name: "GND",
          kind: "io"
        },
        {
          num: 64,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "CH32X035C8T6",
      label: "LQFP48",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PA15",
          kind: "io"
        },
        {
          num: 2,
          name: "PA16",
          kind: "io"
        },
        {
          num: 3,
          name: "PA17",
          kind: "io"
        },
        {
          num: 4,
          name: "PA18",
          kind: "io"
        },
        {
          num: 5,
          name: "PA19",
          kind: "io"
        },
        {
          num: 6,
          name: "PA20",
          kind: "io"
        },
        {
          num: 7,
          name: "PA21",
          kind: "io"
        },
        {
          num: 8,
          name: "PA22",
          kind: "io"
        },
        {
          num: 9,
          name: "PA23",
          kind: "io"
        },
        {
          num: 10,
          name: "PA0",
          kind: "io"
        },
        {
          num: 11,
          name: "PA1",
          kind: "io"
        },
        {
          num: 12,
          name: "PA2",
          kind: "io"
        },
        {
          num: 13,
          name: "PA3",
          kind: "io"
        },
        {
          num: 14,
          name: "PA4",
          kind: "io"
        },
        {
          num: 15,
          name: "PA5",
          kind: "io"
        },
        {
          num: 16,
          name: "PA6",
          kind: "io"
        },
        {
          num: 17,
          name: "PA7",
          kind: "io"
        },
        {
          num: 18,
          name: "PC6",
          kind: "io"
        },
        {
          num: 19,
          name: "PC7",
          kind: "io"
        },
        {
          num: 20,
          name: "PB0",
          kind: "io"
        },
        {
          num: 21,
          name: "PB1",
          kind: "io"
        },
        {
          num: 22,
          name: "PB2",
          kind: "io"
        },
        {
          num: 23,
          name: "PB3",
          kind: "io"
        },
        {
          num: 24,
          name: "PB4",
          kind: "io"
        },
        {
          num: 25,
          name: "PB5",
          kind: "io"
        },
        {
          num: 26,
          name: "PB6",
          kind: "io"
        },
        {
          num: 27,
          name: "PB7",
          kind: "io"
        },
        {
          num: 28,
          name: "PB8",
          kind: "io"
        },
        {
          num: 29,
          name: "PB9",
          kind: "io"
        },
        {
          num: 30,
          name: "PB10",
          kind: "io"
        },
        {
          num: 31,
          name: "PB11",
          kind: "io"
        },
        {
          num: 32,
          name: "PC11",
          kind: "io"
        },
        {
          num: 33,
          name: "PC10",
          kind: "io"
        },
        {
          num: 34,
          name: "PC18",
          kind: "io"
        },
        {
          num: 35,
          name: "PB12",
          kind: "io"
        },
        {
          num: 36,
          name: "PB13",
          kind: "io"
        },
        {
          num: 37,
          name: "PC19",
          kind: "io"
        },
        {
          num: 38,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 39,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 40,
          name: "PA8",
          kind: "io"
        },
        {
          num: 41,
          name: "PA9",
          kind: "io"
        },
        {
          num: 42,
          name: "PA10",
          kind: "io"
        },
        {
          num: 43,
          name: "PA11",
          kind: "io"
        },
        {
          num: 44,
          name: "PA12",
          kind: "io"
        },
        {
          num: 45,
          name: "PA13",
          kind: "io"
        },
        {
          num: 46,
          name: "PA14",
          kind: "io"
        },
        {
          num: 47,
          name: "GND",
          kind: "io"
        },
        {
          num: 48,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "CH32X035G8U6",
      label: "QFN28",
      shape: "qfn",
      pins: [
        {
          num: 1,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 2,
          name: "VDD",
          kind: "power"
        },
        {
          num: 3,
          name: "PC0",
          kind: "io"
        },
        {
          num: 4,
          name: "PC3",
          kind: "io"
        },
        {
          num: 5,
          name: "PA0",
          kind: "io"
        },
        {
          num: 6,
          name: "PA1",
          kind: "io"
        },
        {
          num: 7,
          name: "PA2",
          kind: "io"
        },
        {
          num: 8,
          name: "PA3",
          kind: "io"
        },
        {
          num: 9,
          name: "PA4",
          kind: "io"
        },
        {
          num: 10,
          name: "PA5",
          kind: "io"
        },
        {
          num: 11,
          name: "PA6",
          kind: "io"
        },
        {
          num: 12,
          name: "PA7",
          kind: "io"
        },
        {
          num: 13,
          name: "PB0",
          kind: "io"
        },
        {
          num: 14,
          name: "PB3",
          kind: "io"
        },
        {
          num: 15,
          name: "PB4",
          kind: "io"
        },
        {
          num: 16,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB5 \u5185\u90E8\u77ED\u63A5",
          aliases: [
            "PB5"
          ]
        },
        {
          num: 17,
          name: "PB6",
          kind: "io"
        },
        {
          num: 18,
          name: "PB7",
          kind: "io"
        },
        {
          num: 19,
          name: "PB8",
          kind: "io"
        },
        {
          num: 20,
          name: "PB9",
          kind: "io"
        },
        {
          num: 21,
          name: "PB10",
          kind: "io"
        },
        {
          num: 22,
          name: "PB11",
          kind: "io"
        },
        {
          num: 23,
          name: "PB12",
          kind: "io"
        },
        {
          num: 24,
          name: "PC19",
          kind: "io"
        },
        {
          num: 25,
          name: "PC18",
          kind: "io"
        },
        {
          num: 26,
          name: "PC11",
          kind: "io"
        },
        {
          num: 27,
          name: "PC10",
          kind: "io"
        },
        {
          num: 28,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        }
      ]
    },
    {
      id: "CH32X035G8R6",
      label: "QSOP28",
      shape: "dual",
      pins: [
        {
          num: 1,
          name: "PC19",
          kind: "io"
        },
        {
          num: 2,
          name: "PC11",
          kind: "io"
        },
        {
          num: 3,
          name: "PC10",
          kind: "io"
        },
        {
          num: 4,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09\uFF1B\u4E0E PA12 \u5185\u90E8\u77ED\u63A5",
          aliases: [
            "PA12"
          ]
        },
        {
          num: 5,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09\uFF1B\u4E0E PA13 \u5185\u90E8\u77ED\u63A5",
          aliases: [
            "PA13"
          ]
        },
        {
          num: 6,
          name: "VDD",
          kind: "power"
        },
        {
          num: 7,
          name: "GND",
          kind: "io"
        },
        {
          num: 8,
          name: "PC3",
          kind: "io",
          note: "\u8BE5\u5C01\u88C5\u6B64\u811A\u517C\u4F5C RST \u590D\u4F4D\u8F93\u5165"
        },
        {
          num: 9,
          name: "PA0",
          kind: "io"
        },
        {
          num: 10,
          name: "PA1",
          kind: "io"
        },
        {
          num: 11,
          name: "PA2",
          kind: "io"
        },
        {
          num: 12,
          name: "PA3",
          kind: "io"
        },
        {
          num: 13,
          name: "PA6",
          kind: "io"
        },
        {
          num: 14,
          name: "PB0",
          kind: "io"
        },
        {
          num: 15,
          name: "PA4",
          kind: "io"
        },
        {
          num: 16,
          name: "PA5",
          kind: "io"
        },
        {
          num: 17,
          name: "PA7",
          kind: "io"
        },
        {
          num: 18,
          name: "PB3",
          kind: "io"
        },
        {
          num: 19,
          name: "PB4",
          kind: "io"
        },
        {
          num: 20,
          name: "PB1",
          kind: "io",
          note: "\u4E0E PB5 \u5185\u90E8\u77ED\u63A5",
          aliases: [
            "PB5"
          ]
        },
        {
          num: 21,
          name: "PB6",
          kind: "io"
        },
        {
          num: 22,
          name: "PB7",
          kind: "io"
        },
        {
          num: 23,
          name: "PB8",
          kind: "io"
        },
        {
          num: 24,
          name: "PB9",
          kind: "io"
        },
        {
          num: 25,
          name: "PB10",
          kind: "io"
        },
        {
          num: 26,
          name: "PB11",
          kind: "io"
        },
        {
          num: 27,
          name: "PB12",
          kind: "io"
        },
        {
          num: 28,
          name: "PC18",
          kind: "io"
        }
      ]
    },
    {
      id: "CH32X035F8U6",
      label: "QFN20",
      shape: "qfn",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PA0",
          kind: "io"
        },
        {
          num: 3,
          name: "PA1",
          kind: "io"
        },
        {
          num: 4,
          name: "PA2",
          kind: "io"
        },
        {
          num: 5,
          name: "PA3",
          kind: "io"
        },
        {
          num: 6,
          name: "PA4",
          kind: "io"
        },
        {
          num: 7,
          name: "PA5",
          kind: "io"
        },
        {
          num: 8,
          name: "PA6",
          kind: "io"
        },
        {
          num: 9,
          name: "PA7",
          kind: "io"
        },
        {
          num: 10,
          name: "PB0",
          kind: "io"
        },
        {
          num: 11,
          name: "PB1",
          kind: "io"
        },
        {
          num: 12,
          name: "PB3",
          kind: "io"
        },
        {
          num: 13,
          name: "PB11",
          kind: "io"
        },
        {
          num: 14,
          name: "PC18",
          kind: "io"
        },
        {
          num: 15,
          name: "PB12",
          kind: "io"
        },
        {
          num: 16,
          name: "PC19",
          kind: "io"
        },
        {
          num: 17,
          name: "PC16",
          kind: "io"
        },
        {
          num: 18,
          name: "PC17",
          kind: "io"
        },
        {
          num: 19,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 20,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        }
      ]
    },
    {
      id: "CH32X035F7P6",
      label: "TSSOP20",
      shape: "dual",
      pins: [
        {
          num: 1,
          name: "PB12",
          kind: "io"
        },
        {
          num: 2,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 3,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        },
        {
          num: 4,
          name: "PC3",
          kind: "io",
          note: "\u8BE5\u5C01\u88C5\u6B64\u811A\u517C\u4F5C RST \u590D\u4F4D\u8F93\u5165"
        },
        {
          num: 5,
          name: "PC1",
          kind: "io"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PA6",
          kind: "io"
        },
        {
          num: 13,
          name: "PA7",
          kind: "io"
        },
        {
          num: 14,
          name: "PB1",
          kind: "io"
        },
        {
          num: 15,
          name: "GND",
          kind: "io"
        },
        {
          num: 16,
          name: "VDD",
          kind: "power"
        },
        {
          num: 17,
          name: "PC11",
          kind: "io"
        },
        {
          num: 18,
          name: "PC10",
          kind: "io"
        },
        {
          num: 19,
          name: "PC18",
          kind: "io"
        },
        {
          num: 20,
          name: "PC19",
          kind: "io"
        }
      ]
    },
    {
      id: "CH32X035D8U6",
      label: "QFN12",
      shape: "qfn",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PA2",
          kind: "io"
        },
        {
          num: 3,
          name: "PA3",
          kind: "io"
        },
        {
          num: 4,
          name: "PA5",
          kind: "io"
        },
        {
          num: 5,
          name: "PA6",
          kind: "io"
        },
        {
          num: 6,
          name: "PA7",
          kind: "io",
          note: "\u4E0E PC7 \u5185\u90E8\u77ED\u63A5",
          aliases: [
            "PC7"
          ]
        },
        {
          num: 7,
          name: "PC16",
          kind: "io"
        },
        {
          num: 8,
          name: "PC17",
          kind: "io"
        },
        {
          num: 9,
          name: "PC18",
          kind: "io"
        },
        {
          num: 10,
          name: "PC19",
          kind: "io"
        },
        {
          num: 11,
          name: "PC14",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u5165\uFF08OSC32_IN\uFF09"
        },
        {
          num: 12,
          name: "PC15",
          kind: "io",
          note: "\u517C\u4F5C LSE 32.768 kHz \u6676\u632F\u8F93\u51FA\uFF08OSC32_OUT\uFF09"
        }
      ]
    }
  ],
  ports: {
    PA15: [
      {
        fn: "USART2_TX",
        remap: "2"
      },
      {
        fn: "USART2_TX",
        remap: "4"
      }
    ],
    PA16: [
      {
        fn: "USART2_RX",
        remap: "2"
      },
      {
        fn: "USART2_RX",
        remap: "4"
      }
    ],
    PA17: [
      {
        fn: "USART2_CTS",
        remap: "2"
      },
      {
        fn: "USART2_CTS"
      }
    ],
    PA18: [
      {
        fn: "USART3_TX",
        remap: "2"
      },
      {
        fn: "TIM2_ETR",
        remap: "1"
      }
    ],
    PA19: [
      {
        fn: "TIM2_ETR"
      },
      {
        fn: "USART2_RX",
        remap: "1"
      },
      {
        fn: "TIM2_ETR",
        remap: "2"
      }
    ],
    PA20: [
      {
        fn: "TIM2_BKIN"
      },
      {
        fn: "USART2_TX",
        remap: "1"
      },
      {
        fn: "TIM2_BKIN",
        remap: "2"
      }
    ],
    PA21: [
      {
        fn: "USART2_RTS",
        remap: "2"
      }
    ],
    PC0: [
      {
        fn: "ADC1_IN10"
      },
      {
        fn: "USART2_TX",
        remap: "3"
      },
      {
        fn: "TIM2_CH4",
        remap: "6"
      },
      {
        fn: "TIM1_CH1",
        remap: "3"
      },
      {
        fn: "TIM2_BKIN",
        remap: "4"
      }
    ],
    PC1: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "ADC1_IN11"
      },
      {
        fn: "TIM2_CH1N",
        remap: "4"
      },
      {
        fn: "USART2_RX",
        remap: "3"
      }
    ],
    PC2: [
      {
        fn: "ADC1_IN12"
      },
      {
        fn: "TIM1_CH3",
        remap: "3"
      },
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "USART2_CTS",
        remap: "3"
      }
    ],
    PC3: [
      {
        fn: "CMP2_N1"
      },
      {
        fn: "CMP3_N1"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      },
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "USART2_RTS"
      },
      {
        fn: "TIM2_CH3N"
      },
      {
        fn: "TIM1_CH4",
        remap: "3"
      },
      {
        fn: "TIM2_CH1N",
        remap: "2"
      },
      {
        fn: "USART2_RTS",
        remap: "4"
      },
      {
        fn: "USART2_RTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH3N",
        remap: "4"
      }
    ],
    PA22: [
      {
        fn: "CMP3_N1"
      },
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "CMP2_N0"
      },
      {
        fn: "USART2_CK",
        remap: "2"
      },
      {
        fn: "TIM2_CH2N"
      },
      {
        fn: "USART2_CK",
        remap: "4"
      }
    ],
    PA23: [
      {
        fn: "TIM2_CH3N"
      },
      {
        fn: "CMP1_N1"
      },
      {
        fn: "USART2_CK",
        remap: "1"
      }
    ],
    PA0: [
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "USART2_CTS"
      },
      {
        fn: "CMP1_P1"
      },
      {
        fn: "ADC1_IN0"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      }
    ],
    PA1: [
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "CMP1_OUT"
      },
      {
        fn: "OPA1_N2"
      },
      {
        fn: "OPA2_N2"
      },
      {
        fn: "ADC1_IN1"
      },
      {
        fn: "USART2_CTS",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "2"
      },
      {
        fn: "USART2_RTS"
      }
    ],
    PA2: [
      {
        fn: "USART2_TX"
      },
      {
        fn: "TIM2_CH3"
      },
      {
        fn: "OPA2_OUT1"
      },
      {
        fn: "CMP3_N0"
      },
      {
        fn: "ADC1_IN2"
      },
      {
        fn: "TIM2_ETR",
        remap: "5"
      },
      {
        fn: "TIM2_CH3",
        remap: "1"
      },
      {
        fn: "TIM2_ETR",
        remap: "6"
      },
      {
        fn: "USART2_RTS",
        remap: "1"
      }
    ],
    PA3: [
      {
        fn: "USART2_RX"
      },
      {
        fn: "OPA1_OUT0"
      },
      {
        fn: "ADC1_IN3"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "TIM2_CH4",
        remap: "1"
      },
      {
        fn: "USART3_CTS",
        remap: "2"
      },
      {
        fn: "TIM2_CH4"
      },
      {
        fn: "TIM3_CH1",
        remap: "3"
      }
    ],
    PC4: [
      {
        fn: "SPI1_NSS",
        remap: "3"
      },
      {
        fn: "TIM1_BKIN",
        remap: "3"
      }
    ],
    PC5: [
      {
        fn: "SPI1_SCK",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N"
      }
    ],
    PA4: [
      {
        fn: "SPI1_NSS"
      },
      {
        fn: "USART2_CK"
      },
      {
        fn: "OPA2_OUT0"
      },
      {
        fn: "ADC1_IN4"
      },
      {
        fn: "USART3_RTS",
        remap: "2"
      },
      {
        fn: "TIM3_CH2",
        remap: "3"
      }
    ],
    PA5: [
      {
        fn: "SPI1_SCK"
      },
      {
        fn: "OPA2_N0"
      },
      {
        fn: "ADC1_IN5"
      },
      {
        fn: "USART4_TX",
        remap: "1"
      },
      {
        fn: "USART4_CTS",
        remap: "4"
      }
    ],
    PA6: [
      {
        fn: "SPI1_MISO"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "OPA1_N0"
      },
      {
        fn: "ADC1_IN6"
      },
      {
        fn: "USART4_CK"
      },
      {
        fn: "USART4_RTS",
        remap: "4"
      },
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "USART4_CK",
        remap: "1"
      }
    ],
    PA7: [
      {
        fn: "SPI1_MOSI"
      },
      {
        fn: "TIM3_CH2"
      },
      {
        fn: "OPA2_P0"
      },
      {
        fn: "ADC1_IN7"
      },
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "1"
      }
    ],
    PC6: [
      {
        fn: "SPI1_MISO",
        remap: "3"
      },
      {
        fn: "TIM1_CH2N"
      }
    ],
    PC7: [
      {
        fn: "SPI1_MOSI",
        remap: "3"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "I2C1_SCL",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "5"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      }
    ],
    PB0: [
      {
        fn: "OPA1_P0"
      },
      {
        fn: "ADC1_IN8"
      },
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "USART4_TX"
      }
    ],
    PB1: [
      {
        fn: "OPA2_N1"
      },
      {
        fn: "ADC1_IN9"
      },
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "USART4_RX"
      }
    ],
    PB2: [
      {
        fn: "USART4_CK"
      },
      {
        fn: "CMP2_OUT"
      },
      {
        fn: "USART1_RX",
        remap: "3"
      },
      {
        fn: "USART4_CK",
        remap: "2"
      },
      {
        fn: "USART4_CK",
        remap: "5"
      }
    ],
    PB3: [
      {
        fn: "CMP3_OUT"
      },
      {
        fn: "OPA2_P1"
      },
      {
        fn: "TIM2_CH3",
        remap: "2"
      },
      {
        fn: "TIM2_CH3N"
      },
      {
        fn: "TIM2_CH3",
        remap: "3"
      },
      {
        fn: "TIM2_CH3N",
        remap: "6"
      },
      {
        fn: "USART3_TX"
      },
      {
        fn: "TIM2_CH3N",
        remap: "5"
      }
    ],
    PB4: [
      {
        fn: "USART3_RX"
      },
      {
        fn: "OPA1_P2"
      },
      {
        fn: "TIM2_CH4",
        remap: "2"
      },
      {
        fn: "TIM3_CH1",
        remap: "1"
      },
      {
        fn: "TIM2_BKIN",
        remap: "5"
      },
      {
        fn: "TIM2_CH4",
        remap: "3"
      },
      {
        fn: "TIM2_BKIN",
        remap: "6"
      }
    ],
    PB5: [
      {
        fn: "USART3_CK"
      },
      {
        fn: "OPA1_OUT1"
      },
      {
        fn: "TIM1_BKIN"
      },
      {
        fn: "USART1_CK",
        remap: "2"
      },
      {
        fn: "TIM3_CH2",
        remap: "1"
      },
      {
        fn: "TIM1_BKIN",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "1"
      }
    ],
    PB6: [
      {
        fn: "TIM1_CH1"
      },
      {
        fn: "USART3_CTS"
      },
      {
        fn: "OPA1_N1"
      },
      {
        fn: "TIM1_CH1N",
        remap: "2"
      },
      {
        fn: "TIM1_CH1N"
      },
      {
        fn: "USART3_CTS",
        remap: "1"
      }
    ],
    PB7: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "OPA2_P2"
      },
      {
        fn: "USART3_RTS"
      },
      {
        fn: "USART3_RTS",
        remap: "1"
      },
      {
        fn: "TIM1_CH2N"
      },
      {
        fn: "TIM1_CH2N",
        remap: "2"
      }
    ],
    PB8: [
      {
        fn: "OPA1_P1"
      },
      {
        fn: "USART3_CK",
        remap: "2"
      },
      {
        fn: "USART4_CK",
        remap: "3"
      },
      {
        fn: "TIM1_CH3N",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N"
      }
    ],
    PB16: [
      {
        fn: "USART3_TX",
        remap: "3"
      },
      {
        fn: "TIM2_CH1",
        remap: "4"
      }
    ],
    PB17: [
      {
        fn: "TIM2_CH2",
        remap: "4"
      },
      {
        fn: "USART3_RX",
        remap: "3"
      }
    ],
    PB18: [
      {
        fn: "TIM2_CH3",
        remap: "4"
      },
      {
        fn: "USART3_CTS",
        remap: "3"
      }
    ],
    PB19: [
      {
        fn: "USART3_RTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH4",
        remap: "4"
      }
    ],
    PB9: [
      {
        fn: "USART1_CK"
      },
      {
        fn: "USART4_TX",
        remap: "3"
      },
      {
        fn: "USART1_CK",
        remap: "1"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "TIM1_CH1"
      },
      {
        fn: "TIM1_CH1",
        remap: "2"
      }
    ],
    PB10: [
      {
        fn: "USART1_TX"
      },
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "TIM1_CH2",
        remap: "1"
      },
      {
        fn: "TIM1_CH2",
        remap: "2"
      },
      {
        fn: "USART1_TX",
        remap: "2"
      }
    ],
    PB11: [
      {
        fn: "TIM1_CH3"
      },
      {
        fn: "TIM1_CH3",
        remap: "1"
      },
      {
        fn: "TIM1_CH3",
        remap: "2"
      },
      {
        fn: "USART1_RX",
        remap: "2"
      },
      {
        fn: "USART1_RX"
      },
      {
        fn: "TIM2_CH1N",
        remap: "6"
      }
    ],
    PC16: [
      {
        fn: "USB1_DM"
      },
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "USART4_TX",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "2"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "5"
      },
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "1"
      }
    ],
    PC11: [
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USB1_DM"
      },
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "USART4_TX",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "2"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "5"
      }
    ],
    PC17: [
      {
        fn: "USB1_DP"
      },
      {
        fn: "USART1_RTS"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "USART4_TX",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "2"
      },
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "1"
      }
    ],
    PC10: [
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "USB1_DP"
      },
      {
        fn: "USART1_RTS"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "USART4_TX",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "2"
      }
    ],
    PC18: [
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "SYSTEM_SWDIO"
      },
      {
        fn: "USART3_TX",
        remap: "1"
      },
      {
        fn: "I2C1_SCL",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "3"
      },
      {
        fn: "TIM1_ETR",
        remap: "2"
      },
      {
        fn: "TIM1_ETR",
        remap: "3"
      },
      {
        fn: "TIM2_CH1N",
        remap: "5"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      }
    ],
    PB12: [
      {
        fn: "USART1_CK",
        remap: "3"
      },
      {
        fn: "TIM1_CH4",
        remap: "2"
      },
      {
        fn: "TIM2_CH2N"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "TIM2_CH2N",
        remap: "6"
      },
      {
        fn: "TIM2_CH2N",
        remap: "5"
      }
    ],
    PB13: [
      {
        fn: "USART4_TX",
        remap: "4"
      }
    ],
    PC19: [
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "SYSTEM_SWCLK"
      },
      {
        fn: "PIOC_IO1"
      },
      {
        fn: "CMP1_P0"
      },
      {
        fn: "TIM2_CH1",
        remap: "5"
      },
      {
        fn: "USART2_TX",
        remap: "2"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "3"
      },
      {
        fn: "I2C1_SDA",
        remap: "5"
      },
      {
        fn: "USART3_RX",
        remap: "1"
      },
      {
        fn: "USART4_RX",
        remap: "4"
      },
      {
        fn: "TIM2_CH1",
        remap: "6"
      }
    ],
    PB14: [
      {
        fn: "I2C1_SDA",
        remap: "5"
      },
      {
        fn: "USART3_RX",
        remap: "2"
      },
      {
        fn: "USART3_RX",
        remap: "1"
      },
      {
        fn: "USART4_RX",
        remap: "4"
      },
      {
        fn: "TIM2_CH1",
        remap: "6"
      }
    ],
    PB20: [
      {
        fn: "USART2_CK",
        remap: "3"
      }
    ],
    PB21: [
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "SPI1_NSS",
        remap: "1"
      },
      {
        fn: "USART4_RTS",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "3"
      }
    ],
    PB15: [
      {
        fn: "USART4_CTS"
      },
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "SPI1_SCK",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "2"
      },
      {
        fn: "USART4_CTS",
        remap: "5"
      }
    ],
    PC14: [
      {
        fn: "USBPD_CC1"
      },
      {
        fn: "TIM1_CH3",
        remap: "4"
      },
      {
        fn: "USART4_CTS",
        remap: "5"
      },
      {
        fn: "TIM2_CH2",
        remap: "6"
      }
    ],
    PC15: [
      {
        fn: "USBPD_CC2"
      },
      {
        fn: "TIM2_CH3",
        remap: "6"
      },
      {
        fn: "TIM1_ETR",
        remap: "4"
      }
    ],
    PA8: [
      {
        fn: "USART1_RTS",
        remap: "2"
      },
      {
        fn: "USART4_CK",
        remap: "4"
      },
      {
        fn: "USART4_RTS",
        remap: "2"
      },
      {
        fn: "USART4_RTS",
        remap: "5"
      },
      {
        fn: "SPI1_MISO",
        remap: "1"
      },
      {
        fn: "USART4_RTS"
      }
    ],
    PA9: [
      {
        fn: "SPI1_MOSI",
        remap: "1"
      },
      {
        fn: "USART4_RX",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "2"
      },
      {
        fn: "SPI1_MISO",
        remap: "2"
      },
      {
        fn: "TIM2_BKIN",
        remap: "1"
      },
      {
        fn: "TIM2_BKIN",
        remap: "3"
      }
    ],
    PA10: [
      {
        fn: "USART1_TX",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI",
        remap: "2"
      },
      {
        fn: "I2C1_SCL"
      },
      {
        fn: "USART4_RX",
        remap: "3"
      }
    ],
    PA11: [
      {
        fn: "I2C1_SDA"
      },
      {
        fn: "CMP2_P1"
      },
      {
        fn: "SPI1_SCK",
        remap: "2"
      },
      {
        fn: "USART1_RX",
        remap: "1"
      }
    ],
    PA12: [
      {
        fn: "CMP2_P0"
      },
      {
        fn: "SPI1_NSS",
        remap: "2"
      },
      {
        fn: "TIM2_CH2",
        remap: "5"
      },
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "TIM2_CH1N",
        remap: "3"
      },
      {
        fn: "TIM2_CH1N",
        remap: "1"
      }
    ],
    PA13: [
      {
        fn: "CMP3_P0"
      },
      {
        fn: "I2C1_SCL",
        remap: "1"
      },
      {
        fn: "USART4_RTS",
        remap: "3"
      },
      {
        fn: "USART1_CTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH3",
        remap: "5"
      },
      {
        fn: "TIM2_CH2N",
        remap: "1"
      },
      {
        fn: "TIM2_CH2N",
        remap: "3"
      }
    ],
    PA14: [
      {
        fn: "TIM2_CH3",
        remap: "5"
      },
      {
        fn: "CMP3_P1"
      },
      {
        fn: "TIM2_CH2N",
        remap: "1"
      },
      {
        fn: "TIM2_CH2N",
        remap: "3"
      },
      {
        fn: "USART1_RTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH3N",
        remap: "1"
      },
      {
        fn: "I2C1_SDA",
        remap: "1"
      },
      {
        fn: "USART4_CTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH3N",
        remap: "3"
      }
    ]
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN0",
        "IN1",
        "IN10",
        "IN11",
        "IN12",
        "IN13",
        "IN2",
        "IN3",
        "IN4",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9"
      ]
    },
    {
      id: "CMP1",
      signals: [
        "N1",
        "OUT",
        "P0",
        "P1"
      ]
    },
    {
      id: "CMP2",
      signals: [
        "N0",
        "N1",
        "OUT",
        "P0",
        "P1"
      ]
    },
    {
      id: "CMP3",
      signals: [
        "N0",
        "N1",
        "OUT",
        "P0",
        "P1"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "OPA1",
      signals: [
        "N0",
        "N1",
        "N2",
        "OUT0",
        "OUT1",
        "P0",
        "P1",
        "P2"
      ]
    },
    {
      id: "OPA2",
      signals: [
        "N0",
        "N1",
        "N2",
        "OUT0",
        "OUT1",
        "P0",
        "P1",
        "P2"
      ]
    },
    {
      id: "PIOC",
      signals: [
        "IO1"
      ]
    },
    {
      id: "SPI1",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SYSTEM",
      signals: [
        "SWCLK",
        "SWDIO"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART4",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USB1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "USBPD",
      signals: [
        "CC1",
        "CC2"
      ]
    },
    {
      id: "GPIO",
      signals: []
    },
    {
      id: "DBG",
      signals: []
    },
    {
      id: "PWR",
      signals: []
    },
    {
      id: "EXTI",
      signals: []
    },
    {
      id: "DMA",
      signals: []
    },
    {
      id: "IWDG",
      signals: []
    },
    {
      id: "WWDG",
      signals: []
    }
  ],
  irqs: [
    {
      n: 16,
      name: "WWDG",
      owner: "WWDG"
    },
    {
      n: 17,
      name: "PVD",
      owner: "PWR"
    },
    {
      n: 18,
      name: "FLASH",
      owner: "FLASH"
    },
    {
      n: 20,
      name: "EXTI7_0",
      owner: "EXTI"
    },
    {
      n: 21,
      name: "AWU",
      owner: "PWR"
    },
    {
      n: 22,
      name: "DMA1_Channel1",
      owner: "DMA"
    },
    {
      n: 23,
      name: "DMA1_Channel2",
      owner: "DMA"
    },
    {
      n: 24,
      name: "DMA1_Channel3",
      owner: "DMA"
    },
    {
      n: 25,
      name: "DMA1_Channel4",
      owner: "DMA"
    },
    {
      n: 26,
      name: "DMA1_Channel5",
      owner: "DMA"
    },
    {
      n: 27,
      name: "DMA1_Channel6",
      owner: "DMA"
    },
    {
      n: 28,
      name: "DMA1_Channel7",
      owner: "DMA"
    },
    {
      n: 29,
      name: "ADC1",
      owner: "ADC1",
      gate: "irqEoc"
    },
    {
      n: 30,
      name: "I2C1_EV",
      owner: "I2C1",
      gate: "irqEvt"
    },
    {
      n: 31,
      name: "I2C1_ER",
      owner: "I2C1",
      gate: "irqErr"
    },
    {
      n: 32,
      name: "USART1",
      owner: "USART1"
    },
    {
      n: 33,
      name: "SPI1",
      owner: "SPI1"
    },
    {
      n: 34,
      name: "TIM1_BRK",
      owner: "TIM1",
      gate: "irqBreak"
    },
    {
      n: 35,
      name: "TIM1_UP",
      owner: "TIM1",
      gate: "irqUpdate"
    },
    {
      n: 36,
      name: "TIM1_TRG_COM",
      owner: "TIM1",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 37,
      name: "TIM1_CC",
      owner: "TIM1",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 38,
      name: "TIM2_UP",
      owner: "TIM2",
      gate: "irqUpdate"
    },
    {
      n: 39,
      name: "USART2",
      owner: "USART2"
    },
    {
      n: 40,
      name: "EXTI15_8",
      owner: "EXTI"
    },
    {
      n: 41,
      name: "EXTI25_16",
      owner: "EXTI"
    },
    {
      n: 42,
      name: "USART3",
      owner: "USART3"
    },
    {
      n: 43,
      name: "USART4",
      owner: "USART4"
    },
    {
      n: 44,
      name: "DMA1_Channel8",
      owner: "DMA"
    },
    {
      n: 45,
      name: "USBFS",
      owner: "USB1"
    },
    {
      n: 46,
      name: "USBFSWakeUp",
      owner: "USB1"
    },
    {
      n: 47,
      name: "PIOC",
      owner: "PIOC"
    },
    {
      n: 48,
      name: "OPA",
      owner: "OPA1"
    },
    {
      n: 49,
      name: "USBPD",
      owner: "USBPD"
    },
    {
      n: 50,
      name: "USBPDWakeUp",
      owner: "USBPD"
    },
    {
      n: 51,
      name: "TIM2_CC",
      owner: "TIM2",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 52,
      name: "TIM2_TRG_COM",
      owner: "TIM2",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 53,
      name: "TIM2_BRK",
      owner: "TIM2",
      gate: "irqBreak"
    },
    {
      n: 54,
      name: "TIM3",
      owner: "TIM3",
      gate: "irqUpdate"
    }
  ],
  pending: [
    "X035 \u7684 AF \u8868\u4F7F\u7528\u6570\u636E\u624B\u518C\u7F29\u5199\uFF08T2C1 / A10 / C1P0\uFF09\uFF0C\u5DF2\u6309 2.1 \u8282\u56FE\u4F8B\u5C55\u5F00",
    "\u5C01\u88C5\u56FE\u4E2D\u7684 OPA/CMP \u7F16\u53F7\uFF08O1N2 \u8868\u793A OPA1_N2\uFF09\u6309\u56FE\u4F8B\u89E3\u91CA\uFF0C\u4E2A\u522B\u578B\u53F7\u53EF\u80FD\u53EA\u5F15\u51FA\u4E00\u7EC4 OPA",
    "\u590D\u7528\u529F\u80FD = DS0 \u88682-3\uFF08\u77E9\u9635\uFF0C\u63D0\u4F9B\u7EC4\u53F7\uFF09\u222A \u88682-1\uFF08\u6309\u5F15\u811A\uFF0C\u63D0\u4F9B\u9ED8\u8BA4\u590D\u7528\u5217\uFF09\uFF0C\u540E\u8005\u7531 scripts/add_x035_default_af.py \u8865\u5165\uFF1B\u4E24\u8868\u4E2A\u522B\u51FA\u5165\u6309\u5E76\u96C6\u5904\u7406"
  ]
};

// src/core/devices/data/ch32x033.json
var ch32x033_default = {
  packVersion: "0.1.0",
  series: "CH32X033",
  vendor: "WCH",
  core: "QingKe V4C \xB7 RV32IMAC",
  source: "CH32X035/X033DS0 V2.3 \u88682-2\uFF08CH32X033\u5F15\u811A\u5B9A\u4E49\uFF09",
  flashKb: 62,
  ramKb: 20,
  voltage: "2.0 \u2013 5.5 V",
  maxSysclk: 48,
  extiLines: 24,
  dmaChannels: 8,
  dmaMap: {
    "1": [
      "ADC",
      "USART4_TX",
      "TIM2_CH3"
    ],
    "2": [
      "SPI1_RX",
      "USART3_TX",
      "TIM1_CH1",
      "TIM2_UP"
    ],
    "3": [
      "SPI1_TX",
      "USART3_RX",
      "TIM1_CH2"
    ],
    "4": [
      "USART1_TX",
      "TIM1_CH4",
      "TIM1_TRIG",
      "TIM1_COM"
    ],
    "5": [
      "USART1_RX",
      "TIM1_UP",
      "TIM2_CH1"
    ],
    "6": [
      "USART2_RX",
      "I2C1_TX",
      "TIM1_CH3"
    ],
    "7": [
      "USART2_TX",
      "I2C1_RX",
      "TIM2_CH2",
      "TIM2_CH4"
    ],
    "8": [
      "USART4_RX",
      "TIM2_TRIG",
      "TIM2_COM"
    ]
  },
  debug: {
    twoWire: true,
    singleWire: false,
    note: "\u4E32\u884C 2 \u7EBF\u8C03\u8BD5\u63A5\u53E3\uFF08SDI\uFF09\uFF1ASWDIO + SWCLK\u3002\u7CFB\u7EDF\u4E0A\u7535\u6216\u590D\u4F4D\u540E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u4E3B\u7A0B\u5E8F\u91CC\u53EF\u4EE5\u5173\u6389\u628A\u8FD9\u4E24\u4E2A\u811A\u91CA\u653E\u6210\u666E\u901A GPIO\u3002",
    swdio: "PC18",
    swclk: "PC19"
  },
  api: {
    clockProfile: "hsi-only",
    clockAliases: {
      USB1: "USBFS"
    },
    clockApi: "apb",
    nvicApi: "stdlib",
    gpioSpeedStyle: "mhz",
    adcSampleStyle: "cycles",
    flashLatency: true,
    adcClock: "adc",
    flashPrefetch: false,
    gpioSpeeds: [
      "50"
    ],
    gpioOpenDrain: false,
    nvicGroups: [
      0,
      1
    ],
    adcSampleTimes: [
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11"
    ],
    note: "X035: RCC \u65E0 PLL/SYSCLK/PCLK/ADCCLK\uFF1BADC \u65F6\u949F\u7528 ADC_CLKConfig\uFF1BGPIO \u53EA\u6709 50MHz \u4E14\u65E0\u5F00\u6F0F\uFF1BNVIC \u53EA\u6709 Group_0/1\uFF1B\u91C7\u6837\u65F6\u95F4\u662F\u6574\u6570\u5468\u671F"
  },
  sdkHeader: "ch32x035",
  peripheralVersion: "1.5",
  clock: {
    hsi: 48,
    hseOptions: [],
    lsi: 47,
    pllSource: "HSI",
    pllMin: 1,
    pllMax: 1,
    maxSysclk: 48,
    ahbDivs: [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512
    ],
    apb1Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb2Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    notes: [
      "CH32X035 \u53EA\u6709\u5185\u90E8 48 MHz RC \u632F\u8361\u5668\uFF0C\u65E0 HSE\u3001\u65E0 PLL\uFF08DS 1.4.6\uFF09",
      "\u590D\u4F4D\u540E HSI/6 = 8 MHz \u4F5C\u4E3A\u9ED8\u8BA4 SYSCLK"
    ]
  },
  packages: [
    {
      id: "CH32X033F8P6",
      label: "TSSOP20",
      shape: "dual",
      pins: [
        {
          num: 1,
          name: "PA6",
          kind: "io"
        },
        {
          num: 2,
          name: "PA7",
          kind: "io",
          note: "\u4E0E PB0 \u5185\u90E8\u77ED\u63A5"
        },
        {
          num: 3,
          name: "PB1",
          kind: "io"
        },
        {
          num: 4,
          name: "PB7",
          kind: "io"
        },
        {
          num: 5,
          name: "PC16",
          kind: "io"
        },
        {
          num: 6,
          name: "PC17",
          kind: "io"
        },
        {
          num: 7,
          name: "GND",
          kind: "io"
        },
        {
          num: 8,
          name: "PC18",
          kind: "io"
        },
        {
          num: 9,
          name: "VDD",
          kind: "power"
        },
        {
          num: 10,
          name: "PA9",
          kind: "io"
        },
        {
          num: 11,
          name: "PA11",
          kind: "io"
        },
        {
          num: 12,
          name: "PA10",
          kind: "io"
        },
        {
          num: 13,
          name: "PC3",
          kind: "io"
        },
        {
          num: 14,
          name: "PA0",
          kind: "io"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "PC19",
          kind: "io"
        },
        {
          num: 19,
          name: "PA4",
          kind: "io"
        },
        {
          num: 20,
          name: "PA5",
          kind: "io"
        }
      ]
    }
  ],
  ports: {
    PC3: [
      {
        fn: "CMP2_N1"
      },
      {
        fn: "CMP3_N1"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      },
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "USART2_RTS"
      },
      {
        fn: "TIM2_CH3N"
      },
      {
        fn: "TIM1_CH4",
        remap: "3"
      },
      {
        fn: "TIM2_CH1N",
        remap: "2"
      },
      {
        fn: "USART2_RTS",
        remap: "4"
      },
      {
        fn: "USART2_RTS",
        remap: "3"
      },
      {
        fn: "TIM2_CH3N",
        remap: "4"
      }
    ],
    PA0: [
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "USART2_CTS"
      },
      {
        fn: "CMP1_P1"
      },
      {
        fn: "ADC1_IN0"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      }
    ],
    PA1: [
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "CMP1_OUT"
      },
      {
        fn: "OPA1_N2"
      },
      {
        fn: "OPA2_N2"
      },
      {
        fn: "ADC1_IN1"
      },
      {
        fn: "USART2_CTS",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "2"
      },
      {
        fn: "USART2_RTS"
      }
    ],
    PA2: [
      {
        fn: "USART2_TX"
      },
      {
        fn: "TIM2_CH3"
      },
      {
        fn: "OPA2_OUT1"
      },
      {
        fn: "CMP3_N0"
      },
      {
        fn: "ADC1_IN2"
      },
      {
        fn: "TIM2_ETR",
        remap: "5"
      },
      {
        fn: "TIM2_CH3",
        remap: "1"
      },
      {
        fn: "TIM2_ETR",
        remap: "6"
      },
      {
        fn: "USART2_RTS",
        remap: "1"
      }
    ],
    PA3: [
      {
        fn: "USART2_RX"
      },
      {
        fn: "OPA1_OUT0"
      },
      {
        fn: "ADC1_IN3"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "TIM2_CH4",
        remap: "1"
      },
      {
        fn: "USART3_CTS",
        remap: "2"
      },
      {
        fn: "TIM2_CH4"
      },
      {
        fn: "TIM3_CH1",
        remap: "3"
      }
    ],
    PA4: [
      {
        fn: "SPI1_NSS"
      },
      {
        fn: "USART2_CK"
      },
      {
        fn: "OPA2_OUT0"
      },
      {
        fn: "ADC1_IN4"
      },
      {
        fn: "USART3_RTS",
        remap: "2"
      },
      {
        fn: "TIM3_CH2",
        remap: "3"
      }
    ],
    PA5: [
      {
        fn: "SPI1_SCK"
      },
      {
        fn: "OPA2_N0"
      },
      {
        fn: "ADC1_IN5"
      },
      {
        fn: "USART4_TX",
        remap: "1"
      },
      {
        fn: "USART4_CTS",
        remap: "4"
      }
    ],
    PA6: [
      {
        fn: "SPI1_MISO"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "OPA1_N0"
      },
      {
        fn: "ADC1_IN6"
      },
      {
        fn: "USART4_CK"
      },
      {
        fn: "USART4_RTS",
        remap: "4"
      },
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "USART4_CK",
        remap: "1"
      }
    ],
    PA7: [
      {
        fn: "SPI1_MOSI"
      },
      {
        fn: "TIM3_CH2"
      },
      {
        fn: "OPA2_P0"
      },
      {
        fn: "ADC1_IN7"
      },
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "1"
      }
    ],
    PB1: [
      {
        fn: "OPA2_N1"
      },
      {
        fn: "ADC1_IN9"
      },
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "USART4_RX"
      }
    ],
    PB7: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "OPA2_P2"
      },
      {
        fn: "USART3_RTS"
      },
      {
        fn: "USART3_RTS",
        remap: "1"
      }
    ],
    PC16: [
      {
        fn: "USB1_DM"
      },
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "USART4_TX",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "2"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "5"
      },
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "1"
      }
    ],
    PC17: [
      {
        fn: "USB1_DP"
      },
      {
        fn: "USART1_RTS"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "USART4_TX",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "USART4_RX",
        remap: "2"
      },
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "1"
      }
    ],
    PC18: [
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "SYSTEM_SWDIO"
      },
      {
        fn: "USART3_TX",
        remap: "1"
      },
      {
        fn: "I2C1_SCL",
        remap: "5"
      },
      {
        fn: "I2C1_SDA",
        remap: "3"
      },
      {
        fn: "TIM1_ETR",
        remap: "2"
      },
      {
        fn: "TIM1_ETR",
        remap: "3"
      },
      {
        fn: "TIM2_CH1N",
        remap: "5"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      }
    ],
    PC19: [
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "SYSTEM_SWCLK"
      },
      {
        fn: "PIOC_IO1"
      },
      {
        fn: "CMP1_P0"
      },
      {
        fn: "TIM2_CH1",
        remap: "5"
      },
      {
        fn: "USART2_TX",
        remap: "2"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "3"
      },
      {
        fn: "I2C1_SDA",
        remap: "5"
      },
      {
        fn: "USART4_RX",
        remap: "4"
      },
      {
        fn: "TIM2_CH1",
        remap: "6"
      }
    ],
    PA9: [
      {
        fn: "SPI1_MOSI",
        remap: "1"
      },
      {
        fn: "USART4_RX",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "2"
      },
      {
        fn: "SPI1_MISO",
        remap: "2"
      },
      {
        fn: "TIM2_BKIN",
        remap: "1"
      },
      {
        fn: "TIM2_BKIN",
        remap: "3"
      }
    ],
    PA10: [
      {
        fn: "USART1_TX",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI",
        remap: "2"
      },
      {
        fn: "I2C1_SCL"
      },
      {
        fn: "USART4_RX",
        remap: "3"
      }
    ],
    PA11: [
      {
        fn: "I2C1_SDA"
      },
      {
        fn: "CMP2_P1"
      },
      {
        fn: "SPI1_SCK",
        remap: "2"
      },
      {
        fn: "USART1_RX",
        remap: "1"
      }
    ]
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN0",
        "IN1",
        "IN13",
        "IN2",
        "IN3",
        "IN4",
        "IN5",
        "IN6",
        "IN7",
        "IN9"
      ]
    },
    {
      id: "CMP1",
      signals: [
        "OUT",
        "P0",
        "P1"
      ]
    },
    {
      id: "CMP2",
      signals: [
        "N1",
        "P1"
      ]
    },
    {
      id: "CMP3",
      signals: [
        "N0",
        "N1"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "OPA1",
      signals: [
        "N0",
        "N2",
        "OUT0"
      ]
    },
    {
      id: "OPA2",
      signals: [
        "N0",
        "N1",
        "N2",
        "OUT0",
        "OUT1",
        "P0",
        "P2"
      ]
    },
    {
      id: "PIOC",
      signals: [
        "IO1"
      ]
    },
    {
      id: "SPI1",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SYSTEM",
      signals: [
        "SWCLK",
        "SWDIO"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "CH1N",
        "CH2",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CTS",
        "RTS",
        "TX"
      ]
    },
    {
      id: "USART4",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USB1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "GPIO",
      signals: []
    },
    {
      id: "DBG",
      signals: []
    },
    {
      id: "PWR",
      signals: []
    },
    {
      id: "EXTI",
      signals: []
    },
    {
      id: "DMA",
      signals: []
    },
    {
      id: "IWDG",
      signals: []
    },
    {
      id: "WWDG",
      signals: []
    }
  ],
  irqs: [
    {
      n: 16,
      name: "WWDG",
      owner: "WWDG"
    },
    {
      n: 17,
      name: "PVD",
      owner: "PWR"
    },
    {
      n: 18,
      name: "FLASH",
      owner: "FLASH"
    },
    {
      n: 20,
      name: "EXTI7_0",
      owner: "EXTI"
    },
    {
      n: 21,
      name: "AWU",
      owner: "PWR"
    },
    {
      n: 22,
      name: "DMA1_Channel1",
      owner: "DMA"
    },
    {
      n: 23,
      name: "DMA1_Channel2",
      owner: "DMA"
    },
    {
      n: 24,
      name: "DMA1_Channel3",
      owner: "DMA"
    },
    {
      n: 25,
      name: "DMA1_Channel4",
      owner: "DMA"
    },
    {
      n: 26,
      name: "DMA1_Channel5",
      owner: "DMA"
    },
    {
      n: 27,
      name: "DMA1_Channel6",
      owner: "DMA"
    },
    {
      n: 28,
      name: "DMA1_Channel7",
      owner: "DMA"
    },
    {
      n: 29,
      name: "ADC1",
      owner: "ADC1",
      gate: "irqEoc"
    },
    {
      n: 30,
      name: "I2C1_EV",
      owner: "I2C1",
      gate: "irqEvt"
    },
    {
      n: 31,
      name: "I2C1_ER",
      owner: "I2C1",
      gate: "irqErr"
    },
    {
      n: 32,
      name: "USART1",
      owner: "USART1"
    },
    {
      n: 33,
      name: "SPI1",
      owner: "SPI1"
    },
    {
      n: 34,
      name: "TIM1_BRK",
      owner: "TIM1",
      gate: "irqBreak"
    },
    {
      n: 35,
      name: "TIM1_UP",
      owner: "TIM1",
      gate: "irqUpdate"
    },
    {
      n: 36,
      name: "TIM1_TRG_COM",
      owner: "TIM1",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 37,
      name: "TIM1_CC",
      owner: "TIM1",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 38,
      name: "TIM2_UP",
      owner: "TIM2",
      gate: "irqUpdate"
    },
    {
      n: 39,
      name: "USART2",
      owner: "USART2"
    },
    {
      n: 40,
      name: "EXTI15_8",
      owner: "EXTI"
    },
    {
      n: 41,
      name: "EXTI25_16",
      owner: "EXTI"
    },
    {
      n: 42,
      name: "USART3",
      owner: "USART3"
    },
    {
      n: 43,
      name: "USART4",
      owner: "USART4"
    },
    {
      n: 44,
      name: "DMA1_Channel8",
      owner: "DMA"
    },
    {
      n: 45,
      name: "USBFS",
      owner: "USB1"
    },
    {
      n: 46,
      name: "USBFSWakeUp",
      owner: "USB1"
    },
    {
      n: 47,
      name: "PIOC",
      owner: "PIOC"
    },
    {
      n: 48,
      name: "OPA",
      owner: "OPA1"
    },
    {
      n: 49,
      name: "USBPD",
      owner: "USBPD"
    },
    {
      n: 50,
      name: "USBPDWakeUp",
      owner: "USBPD"
    },
    {
      n: 51,
      name: "TIM2_CC",
      owner: "TIM2",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 52,
      name: "TIM2_TRG_COM",
      owner: "TIM2",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 53,
      name: "TIM2_BRK",
      owner: "TIM2",
      gate: "irqBreak"
    },
    {
      n: 54,
      name: "TIM3",
      owner: "TIM3",
      gate: "irqUpdate"
    }
  ],
  pending: [
    "X033 \u4E0E X035 \u540Cdie\uFF0C\u590D\u7528\u529F\u80FD\u8868\u6CBF\u7528 X035 \u7684\u7AEF\u53E3\u4FE1\u53F7\uFF08\u88682-2 \u5DF2\u9010\u811A\u6838\u5BF9\uFF09",
    "X033 \u53EA\u6709 USB Device\uFF0C\u65E0 USB Host / USBPD",
    "\u590D\u7528\u529F\u80FD = DS0 \u88682-3\uFF08\u77E9\u9635\uFF0C\u63D0\u4F9B\u7EC4\u53F7\uFF09\u222A \u88682-1\uFF08\u6309\u5F15\u811A\uFF0C\u63D0\u4F9B\u9ED8\u8BA4\u590D\u7528\u5217\uFF09\uFF0C\u540E\u8005\u7531 scripts/add_x035_default_af.py \u8865\u5165\uFF1B\u4E24\u8868\u4E2A\u522B\u51FA\u5165\u6309\u5E76\u96C6\u5904\u7406"
  ]
};

// src/core/devices/data/ch32v407.json
var ch32v407_default = {
  packVersion: "0.2.0",
  series: "CH32V407",
  vendor: "WCH",
  core: "QingKe V3V \xB7 RV32IMAFCXV",
  source: "CH32V407DS0 V1.4 \u88682-1-1\uFF08\u5404\u5C01\u88C5\u5F15\u811A\u5B9A\u4E49\uFF09+ CH32V407RM V1.3 10.2.11\uFF08AFIO_PCFR1/PCFR2 \u590D\u7528\u91CD\u6620\u5C04\u603B\u8868\uFF09",
  sdkHeader: "ch32v4x7",
  flashKb: 512,
  ramKb: 200,
  voltage: "2.9 \u2013 3.6 V",
  maxSysclk: 200,
  extiLines: 16,
  dmaControllers: [
    { id: "DMA1", channels: 13 },
    { id: "DMA2", channels: 11 }
  ],
  dmaChannels: 24,
  dmaMap: {
    "1": ["TIM2_CH3", "TIM4_CH1"],
    "2": ["SPI1_RX", "USART3_TX", "TIM1_CH1", "TIM2_UP", "TIM3_CH3"],
    "3": ["SPI1_TX", "USART3_RX", "TIM1_CH2", "I3C_TX", "TIM3_UP", "TIM3_CH4"],
    "4": ["SPI2_RX", "USART1_TX", "TIM1_TRIG", "TIM1_CH4", "TIM1_COM", "I3C_RX", "TIM2_CH1", "TIM4_CH2"],
    "5": ["SPI2_TX", "USART1_RX", "TIM1_UP", "TIM3_CH1", "TIM4_CH3"],
    "6": ["USART2_RX", "I2C1_TX", "TIM1_CH3", "TIM2_CH2", "TIM3_TRIG"],
    "7": ["USART2_TX", "I2C1_RX", "TIM2_CH4", "TIM4_UP"],
    "8": ["USART9_TX", "I3C_TC"],
    "9": ["USART9_RX"],
    "10": ["USART10_TX", "ARGB"],
    "11": ["USART10_RX"],
    "12": ["ADC"],
    "13": ["ADC"],
    "14": ["TIM5_CH4", "TIM5_TRIG", "SPI3_RX", "TIM8_CH3"],
    "15": ["TIM5_CH3", "TIM5_UP", "SPI3_TX", "TIM8_UP", "USART5_RX"],
    "16": ["TIM6_UP", "TIM8_TRIG", "TIM8_COM", "TIM8_CH4", "DAC1", "DAC2", "USART4_RX"],
    "17": ["TIM5_CH2", "TIM7_UP", "TIM8_CH1", "SDIO", "USART5_TX"],
    "18": ["TIM5_CH1", "USART4_TX", "DVP"],
    "19": ["TIM8_CH2", "USART6_TX"],
    "20": ["USART6_RX"],
    "21": ["USART7_TX"],
    "22": ["USART7_RX"],
    "23": ["USART8_TX"],
    "24": ["USART8_RX"]
  },
  peripheralVersion: "1.0",
  api: {
    clockProfile: "full",
    clockApi: "pb",
    nvicApi: "cmsis",
    adcClock: "rcc",
    flashPrefetch: false,
    flashLatency: false,
    gpioSpeedStyle: "level",
    gpioSpeeds: [
      "Low",
      "Medium",
      "High"
    ],
    gpioOpenDrain: true,
    nvicGroups: [],
    adcSampleStyle: "cyclesmode",
    adcSampleTimes: [
      "CyclesMode0",
      "CyclesMode1",
      "CyclesMode2",
      "CyclesMode3",
      "CyclesMode4",
      "CyclesMode5",
      "CyclesMode6",
      "CyclesMode7"
    ],
    pllMuls: [
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      24,
      26,
      28,
      30,
      32,
      34,
      36,
      38,
      40
    ],
    apb1Divs: [],
    apb2Divs: [
      2,
      4,
      6,
      8
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    note: "V407: RCC \u7528 PB1/PB2/HB \u547D\u540D\uFF1BNVIC \u8D70 core_riscv.h \u7684 CMSIS \u63A5\u53E3\uFF1BGPIO \u901F\u5EA6\u662F Low/Medium/High\uFF1BADC \u91C7\u6837\u65F6\u95F4\u662F CyclesMode0..7\uFF1BFlash \u6CA1\u6709 SetLatency/PrefetchBufferCmd"
  },
  debug: {
    twoWire: true,
    singleWire: true,
    swdio: "PA13",
    swclk: "PA14",
    note: "1/2 \u7EBF\u8C03\u8BD5\u63A5\u53E3\uFF08SDI\uFF09\u3002\u590D\u4F4D\u540E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u53EF\u5728\u4E3B\u7A0B\u5E8F\u91CC\u5173\u95ED\u91CA\u653E PA13/PA14\u3002"
  },
  clock: {
    hsi: 8,
    hseOptions: [
      8,
      16,
      25
    ],
    lsi: 40,
    pllSource: "HSI",
    pllMin: 8,
    pllMax: 40,
    maxSysclk: 200,
    ahbDivs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb1Divs: [
      1
    ],
    apb2Divs: [
      2,
      4,
      6,
      8
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    notes: [
      "HSI 8 MHz \u2192 PLL \u2192 \u6700\u9AD8 200 MHz\uFF08DS \u88681-1\uFF09",
      "PLL \u5206\u9891/\u500D\u9891\u7EC4\u5408\u89C1 CH32V407RM\u300CRCC\u300D\u7AE0\u8282"
    ]
  },
  packages: [
    {
      id: "CH32V407KEU6",
      label: "QFN32",
      shape: "quad",
      pins: [
        {
          num: 0,
          name: "VSS",
          kind: "power"
        },
        {
          num: 1,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 2,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 3,
          name: "PA0",
          kind: "io"
        },
        {
          num: 4,
          name: "PA1",
          kind: "io"
        },
        {
          num: 5,
          name: "PA2",
          kind: "io"
        },
        {
          num: 6,
          name: "PA3",
          kind: "io"
        },
        {
          num: 7,
          name: "PA4",
          kind: "io"
        },
        {
          num: 8,
          name: "PA5",
          kind: "io"
        },
        {
          num: 9,
          name: "PA6",
          kind: "io"
        },
        {
          num: 10,
          name: "PA7",
          kind: "io"
        },
        {
          num: 11,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 12,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 13,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 14,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 15,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 16,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 17,
          name: "PD14",
          kind: "io"
        },
        {
          num: 18,
          name: "PD15",
          kind: "io"
        },
        {
          num: 19,
          name: "PA8",
          kind: "io"
        },
        {
          num: 20,
          name: "PA9",
          kind: "io"
        },
        {
          num: 21,
          name: "PA10",
          kind: "io"
        },
        {
          num: 22,
          name: "PA11",
          kind: "io"
        },
        {
          num: 23,
          name: "PA12",
          kind: "io"
        },
        {
          num: 24,
          name: "PA13",
          kind: "io"
        },
        {
          num: 25,
          name: "PA14",
          kind: "io"
        },
        {
          num: 26,
          name: "PA15",
          kind: "io"
        },
        {
          num: 27,
          name: "PB3",
          kind: "io"
        },
        {
          num: 28,
          name: "PB4",
          kind: "io"
        },
        {
          num: 29,
          name: "PB5",
          kind: "io"
        },
        {
          num: 30,
          name: "PB6",
          kind: "io"
        },
        {
          num: 31,
          name: "PB7",
          kind: "io"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        }
      ]
    },
    {
      id: "CH32V407RET6",
      label: "LQFP64",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io"
        },
        {
          num: 5,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 6,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "PC3",
          kind: "io",
          aliases: [
            "VSS"
          ],
          note: "\u4E0E VSS \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 12,
          name: "VSSA",
          kind: "power",
          aliases: [
            "VREF"
          ],
          note: "\u4E0E VREF \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 13,
          name: "VREF+",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 14,
          name: "VDDA",
          kind: "power",
          aliases: [
            "PA0"
          ],
          note: "\u4E0E PA0 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "VSS",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 19,
          name: "PA4",
          kind: "io"
        },
        {
          num: 20,
          name: "PA5",
          kind: "io"
        },
        {
          num: 21,
          name: "PA6",
          kind: "io"
        },
        {
          num: 22,
          name: "PA7",
          kind: "io"
        },
        {
          num: 23,
          name: "PC4",
          kind: "io"
        },
        {
          num: 24,
          name: "PC5",
          kind: "io"
        },
        {
          num: 25,
          name: "PB0",
          kind: "io"
        },
        {
          num: 26,
          name: "PB1",
          kind: "io"
        },
        {
          num: 27,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power",
          aliases: [
            "MDIRN"
          ],
          note: "\u4E0E MDIRN \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 29,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 30,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 31,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 33,
          name: "VSS",
          kind: "power"
        },
        {
          num: 34,
          name: "PD8",
          kind: "io"
        },
        {
          num: 35,
          name: "PB12",
          kind: "io"
        },
        {
          num: 36,
          name: "PB13",
          kind: "io"
        },
        {
          num: 37,
          name: "PB14",
          kind: "io"
        },
        {
          num: 38,
          name: "PB15",
          kind: "io"
        },
        {
          num: 39,
          name: "PB11",
          kind: "io"
        },
        {
          num: 40,
          name: "PB10",
          kind: "io"
        },
        {
          num: 41,
          name: "PD14",
          kind: "io"
        },
        {
          num: 42,
          name: "PD15",
          kind: "io"
        },
        {
          num: 43,
          name: "PA8",
          kind: "io"
        },
        {
          num: 44,
          name: "PA9",
          kind: "io"
        },
        {
          num: 45,
          name: "PA10",
          kind: "io"
        },
        {
          num: 46,
          name: "PA11",
          kind: "io"
        },
        {
          num: 47,
          name: "VSS",
          kind: "power",
          aliases: [
            "PA12"
          ],
          note: "\u4E0E PA12 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 48,
          name: "PA13",
          kind: "io"
        },
        {
          num: 49,
          name: "VDD",
          kind: "power"
        },
        {
          num: 50,
          name: "PA14",
          kind: "io"
        },
        {
          num: 51,
          name: "PA15",
          kind: "io"
        },
        {
          num: 52,
          name: "PC10",
          kind: "io"
        },
        {
          num: 53,
          name: "PC11",
          kind: "io"
        },
        {
          num: 54,
          name: "PC12",
          kind: "io"
        },
        {
          num: 55,
          name: "PD2",
          kind: "io"
        },
        {
          num: 56,
          name: "PB3",
          kind: "io"
        },
        {
          num: 57,
          name: "PB4",
          kind: "io"
        },
        {
          num: 58,
          name: "PB5",
          kind: "io"
        },
        {
          num: 59,
          name: "PB6",
          kind: "io"
        },
        {
          num: 60,
          name: "PB7",
          kind: "io"
        },
        {
          num: 61,
          name: "PB8",
          kind: "io"
        },
        {
          num: 62,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 63,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 64,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "CH32V407WEU6",
      label: "QFN68",
      shape: "quad",
      pins: [
        {
          num: 0,
          name: "VSS",
          kind: "power"
        },
        {
          num: 1,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io"
        },
        {
          num: 5,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 6,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "VSS",
          kind: "power",
          aliases: [
            "PC3"
          ],
          note: "\u4E0E PC3 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 12,
          name: "VSSA",
          kind: "power",
          aliases: [
            "VREF"
          ],
          note: "\u4E0E VREF \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 13,
          name: "VREF+",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 14,
          name: "VDDA",
          kind: "power",
          aliases: [
            "PA0"
          ],
          note: "\u4E0E PA0 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "VSS",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 19,
          name: "PA4",
          kind: "io"
        },
        {
          num: 20,
          name: "PA5",
          kind: "io"
        },
        {
          num: 21,
          name: "PA6",
          kind: "io"
        },
        {
          num: 22,
          name: "PA7",
          kind: "io"
        },
        {
          num: 23,
          name: "PC4",
          kind: "io"
        },
        {
          num: 24,
          name: "PC5",
          kind: "io"
        },
        {
          num: 25,
          name: "PB0",
          kind: "io"
        },
        {
          num: 26,
          name: "PB1",
          kind: "io"
        },
        {
          num: 27,
          name: "PB2",
          kind: "io"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power",
          aliases: [
            "PE8"
          ],
          note: "\u4E0E PE8 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 29,
          name: "PE9",
          kind: "io"
        },
        {
          num: 30,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 31,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 32,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 33,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 34,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 35,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 36,
          name: "VSS",
          kind: "power",
          aliases: [
            "PD8"
          ],
          note: "\u4E0E PD8 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 37,
          name: "PB12",
          kind: "io"
        },
        {
          num: 38,
          name: "PB13",
          kind: "io"
        },
        {
          num: 39,
          name: "PB14",
          kind: "io"
        },
        {
          num: 40,
          name: "PB15",
          kind: "io"
        },
        {
          num: 41,
          name: "VSS",
          kind: "power",
          aliases: [
            "PB11"
          ],
          note: "\u4E0E PB11 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 42,
          name: "PB10",
          kind: "io"
        },
        {
          num: 43,
          name: "PA8",
          kind: "io"
        },
        {
          num: 44,
          name: "PA9",
          kind: "io"
        },
        {
          num: 45,
          name: "PA10",
          kind: "io"
        },
        {
          num: 46,
          name: "PA11",
          kind: "io"
        },
        {
          num: 47,
          name: "PA12",
          kind: "io"
        },
        {
          num: 48,
          name: "PA13",
          kind: "io"
        },
        {
          num: 49,
          name: "PE10",
          kind: "io"
        },
        {
          num: 50,
          name: "PE11",
          kind: "io"
        },
        {
          num: 51,
          name: "VDD",
          kind: "power"
        },
        {
          num: 52,
          name: "PA14",
          kind: "io"
        },
        {
          num: 53,
          name: "PA15",
          kind: "io"
        },
        {
          num: 54,
          name: "PC10",
          kind: "io"
        },
        {
          num: 55,
          name: "PC11",
          kind: "io"
        },
        {
          num: 56,
          name: "PC12",
          kind: "io"
        },
        {
          num: 57,
          name: "PD2",
          kind: "io"
        },
        {
          num: 58,
          name: "PB3",
          kind: "io"
        },
        {
          num: 59,
          name: "PB4",
          kind: "io"
        },
        {
          num: 60,
          name: "PB5",
          kind: "io"
        },
        {
          num: 61,
          name: "PB6",
          kind: "io"
        },
        {
          num: 62,
          name: "PB7",
          kind: "io"
        },
        {
          num: 63,
          name: "PE12",
          kind: "io"
        },
        {
          num: 64,
          name: "PB8",
          kind: "io"
        },
        {
          num: 65,
          name: "VDD",
          kind: "power"
        },
        {
          num: 66,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 67,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 68,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        }
      ]
    },
    {
      id: "CH32V407VET6",
      label: "LQFP100",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PE2",
          kind: "io"
        },
        {
          num: 2,
          name: "PE3",
          kind: "io"
        },
        {
          num: 3,
          name: "PE4",
          kind: "io"
        },
        {
          num: 4,
          name: "PE5",
          kind: "io"
        },
        {
          num: 5,
          name: "PE6",
          kind: "io"
        },
        {
          num: 6,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 7,
          name: "PC13",
          kind: "io"
        },
        {
          num: 8,
          name: "PC14",
          kind: "io"
        },
        {
          num: 9,
          name: "PC15",
          kind: "io"
        },
        {
          num: 10,
          name: "VSS",
          kind: "power"
        },
        {
          num: 11,
          name: "VDD",
          kind: "power"
        },
        {
          num: 12,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 13,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 14,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 15,
          name: "PC0",
          kind: "io"
        },
        {
          num: 16,
          name: "PC1",
          kind: "io"
        },
        {
          num: 17,
          name: "PC2",
          kind: "io"
        },
        {
          num: 18,
          name: "PC3",
          kind: "io"
        },
        {
          num: 19,
          name: "VSSA",
          kind: "power"
        },
        {
          num: 20,
          name: "VREF",
          kind: "power"
        },
        {
          num: 21,
          name: "VREF+",
          kind: "power"
        },
        {
          num: 22,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 23,
          name: "PA0",
          kind: "io"
        },
        {
          num: 24,
          name: "PA1",
          kind: "io"
        },
        {
          num: 25,
          name: "PA2",
          kind: "io"
        },
        {
          num: 26,
          name: "PA3",
          kind: "io"
        },
        {
          num: 27,
          name: "VSS",
          kind: "power"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power"
        },
        {
          num: 29,
          name: "PA4",
          kind: "io"
        },
        {
          num: 30,
          name: "PA5",
          kind: "io"
        },
        {
          num: 31,
          name: "PA6",
          kind: "io"
        },
        {
          num: 32,
          name: "PA7",
          kind: "io"
        },
        {
          num: 33,
          name: "PC4",
          kind: "io"
        },
        {
          num: 34,
          name: "PC5",
          kind: "io"
        },
        {
          num: 35,
          name: "PB0",
          kind: "io"
        },
        {
          num: 36,
          name: "PB1",
          kind: "io"
        },
        {
          num: 37,
          name: "PB2",
          kind: "io"
        },
        {
          num: 38,
          name: "PE8",
          kind: "io"
        },
        {
          num: 39,
          name: "PE9",
          kind: "io"
        },
        {
          num: 40,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 41,
          name: "VSS",
          kind: "power"
        },
        {
          num: 42,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 43,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 44,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 45,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 46,
          name: "VDD",
          kind: "power"
        },
        {
          num: 47,
          name: "VSS",
          kind: "power"
        },
        {
          num: 48,
          name: "PE7",
          kind: "io"
        },
        {
          num: 49,
          name: "PB10",
          kind: "io"
        },
        {
          num: 50,
          name: "PB11",
          kind: "io"
        },
        {
          num: 51,
          name: "PD8",
          kind: "io"
        },
        {
          num: 52,
          name: "PB12",
          kind: "io"
        },
        {
          num: 53,
          name: "PB13",
          kind: "io"
        },
        {
          num: 54,
          name: "PB14",
          kind: "io"
        },
        {
          num: 55,
          name: "PB15",
          kind: "io"
        },
        {
          num: 56,
          name: "PD9",
          kind: "io"
        },
        {
          num: 57,
          name: "PD10",
          kind: "io"
        },
        {
          num: 58,
          name: "PD11",
          kind: "io"
        },
        {
          num: 59,
          name: "PD12",
          kind: "io"
        },
        {
          num: 60,
          name: "PD13",
          kind: "io"
        },
        {
          num: 61,
          name: "PD14",
          kind: "io"
        },
        {
          num: 62,
          name: "PD15",
          kind: "io"
        },
        {
          num: 63,
          name: "PC6",
          kind: "io"
        },
        {
          num: 64,
          name: "PC7",
          kind: "io"
        },
        {
          num: 65,
          name: "PC8",
          kind: "io"
        },
        {
          num: 66,
          name: "PC9",
          kind: "io"
        },
        {
          num: 67,
          name: "PA8",
          kind: "io"
        },
        {
          num: 68,
          name: "PA9",
          kind: "io"
        },
        {
          num: 69,
          name: "PA10",
          kind: "io"
        },
        {
          num: 70,
          name: "PA11",
          kind: "io"
        },
        {
          num: 71,
          name: "PA12",
          kind: "io"
        },
        {
          num: 72,
          name: "PA13",
          kind: "io"
        },
        {
          num: 73,
          name: "PE10",
          kind: "io"
        },
        {
          num: 74,
          name: "PE11",
          kind: "io"
        },
        {
          num: 75,
          name: "VDD",
          kind: "power"
        },
        {
          num: 76,
          name: "PA14",
          kind: "io"
        },
        {
          num: 77,
          name: "PA15",
          kind: "io"
        },
        {
          num: 78,
          name: "PC10",
          kind: "io"
        },
        {
          num: 79,
          name: "PC11",
          kind: "io"
        },
        {
          num: 80,
          name: "PC12",
          kind: "io"
        },
        {
          num: 81,
          name: "PD0",
          kind: "io"
        },
        {
          num: 82,
          name: "PD1",
          kind: "io"
        },
        {
          num: 83,
          name: "PD2",
          kind: "io"
        },
        {
          num: 84,
          name: "PD3",
          kind: "io"
        },
        {
          num: 85,
          name: "PD4",
          kind: "io"
        },
        {
          num: 86,
          name: "PD5",
          kind: "io"
        },
        {
          num: 87,
          name: "PD6",
          kind: "io"
        },
        {
          num: 88,
          name: "PD7",
          kind: "io"
        },
        {
          num: 89,
          name: "PB3",
          kind: "io"
        },
        {
          num: 90,
          name: "PB4",
          kind: "io"
        },
        {
          num: 91,
          name: "PB5",
          kind: "io"
        },
        {
          num: 92,
          name: "PB6",
          kind: "io"
        },
        {
          num: 93,
          name: "PB7",
          kind: "io"
        },
        {
          num: 94,
          name: "PE12",
          kind: "io"
        },
        {
          num: 95,
          name: "PB8",
          kind: "io"
        },
        {
          num: 96,
          name: "PB9",
          kind: "io"
        },
        {
          num: 97,
          name: "PE0",
          kind: "io"
        },
        {
          num: 98,
          name: "PE1",
          kind: "io"
        },
        {
          num: 99,
          name: "VSS",
          kind: "power"
        },
        {
          num: 100,
          name: "VDD",
          kind: "power"
        }
      ]
    }
  ],
  ports: {
    PA0: [
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "TIM2_ETR",
        remap: "2"
      },
      {
        fn: "TIM2_ETR"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_ETR"
      },
      {
        fn: "TIM8_ETR",
        remap: "1"
      },
      {
        fn: "USART2_CTS"
      }
    ],
    PA1: [
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "TIM5_CH2"
      },
      {
        fn: "LTDC_R4",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "2"
      },
      {
        fn: "USART2_RTS"
      }
    ],
    PA10: [
      {
        fn: "DVP_D1"
      },
      {
        fn: "TIM1_CH3"
      },
      {
        fn: "USART1_RX"
      },
      {
        fn: "USART7_RX",
        remap: "3"
      },
      {
        fn: "TIM1_CH3",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "2"
      },
      {
        fn: "USART7_RX",
        remap: "2"
      }
    ],
    PA11: [
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "1"
      },
      {
        fn: "CAN1_RX"
      }
    ],
    PA12: [
      {
        fn: "CAN1_TX"
      },
      {
        fn: "USBHS1_DP"
      },
      {
        fn: "USART1_RTS",
        remap: "1"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "USART1_RTS"
      }
    ],
    PA13: [
      {
        fn: "LTDC_B5"
      },
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "USART4_CTS"
      },
      {
        fn: "USART3_TX",
        remap: "2"
      },
      {
        fn: "USART6_CK",
        remap: "2"
      },
      {
        fn: "TIM8_CH1N",
        remap: "1"
      }
    ],
    PA14: [
      {
        fn: "LTDC_B6"
      },
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "USART6_CTS",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "2"
      },
      {
        fn: "USART8_TX",
        remap: "1"
      }
    ],
    PA15: [
      {
        fn: "ARGB_OUT"
      },
      {
        fn: "I2S3_WS"
      },
      {
        fn: "LTDC_B7"
      },
      {
        fn: "SPI3_NSS"
      },
      {
        fn: "TIM2_ETR",
        remap: "3"
      },
      {
        fn: "TIM2_ETR",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "3"
      },
      {
        fn: "TIM8_CH3N",
        remap: "1"
      },
      {
        fn: "USART6_RTS",
        remap: "2"
      },
      {
        fn: "USART8_RX",
        remap: "1"
      },
      {
        fn: "SPI1_NSS",
        remap: "1"
      }
    ],
    PA2: [
      {
        fn: "TIM5_CH3"
      },
      {
        fn: "USART2_TX"
      },
      {
        fn: "TIM2_CH3",
        remap: "1"
      },
      {
        fn: "TIM2_CH3"
      }
    ],
    PA3: [
      {
        fn: "TIM5_CH4"
      },
      {
        fn: "USART2_RX"
      },
      {
        fn: "LTDC_R6",
        remap: "1"
      },
      {
        fn: "TIM2_CH4"
      },
      {
        fn: "TIM2_CH4",
        remap: "1"
      }
    ],
    PA4: [
      {
        fn: "SPI1_NSS"
      },
      {
        fn: "USART2_CK"
      },
      {
        fn: "I2S3_WS",
        remap: "1"
      },
      {
        fn: "USART9_TX",
        remap: "1"
      },
      {
        fn: "SPI3_NSS",
        remap: "1"
      }
    ],
    PA5: [
      {
        fn: "DVP_VSYNC"
      },
      {
        fn: "SPI1_SCK"
      },
      {
        fn: "USART6_CK",
        remap: "3"
      },
      {
        fn: "USART1_CK",
        remap: "3"
      },
      {
        fn: "USART1_CTS",
        remap: "2"
      },
      {
        fn: "USART9_RX",
        remap: "1"
      }
    ],
    PA6: [
      {
        fn: "SPI1_MISO"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "USART7_TX",
        remap: "1"
      },
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "TIM8_BKIN"
      },
      {
        fn: "USART1_TX",
        remap: "3"
      }
    ],
    PA7: [
      {
        fn: "TIM3_CH2"
      },
      {
        fn: "USART8_CK"
      },
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "TIM1_CH4",
        remap: "3"
      },
      {
        fn: "TIM8_CH1N"
      },
      {
        fn: "USART1_RX",
        remap: "3"
      },
      {
        fn: "USART7_RX",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI"
      }
    ],
    PA8: [
      {
        fn: "I2S3_MCK"
      },
      {
        fn: "USART1_CK"
      },
      {
        fn: "USART7_CK",
        remap: "2"
      },
      {
        fn: "TIM1_CH1"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "1"
      },
      {
        fn: "USART1_RX",
        remap: "2"
      },
      {
        fn: "USART7_CK",
        remap: "3"
      }
    ],
    PA9: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "USART1_TX"
      },
      {
        fn: "USART7_TX",
        remap: "3"
      },
      {
        fn: "TIM1_CH2",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "2"
      },
      {
        fn: "USART7_TX",
        remap: "2"
      }
    ],
    PB0: [
      {
        fn: "TIM3_CH3"
      },
      {
        fn: "USART6_CK"
      },
      {
        fn: "USART5_CTS",
        remap: "2"
      },
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "TIM3_CH3",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N"
      },
      {
        fn: "USART4_TX",
        remap: "1"
      },
      {
        fn: "USART5_CTS",
        remap: "3"
      },
      {
        fn: "USART7_CK",
        remap: "1"
      },
      {
        fn: "USART8_CTS"
      }
    ],
    PB1: [
      {
        fn: "OPA1_OUT2"
      },
      {
        fn: "TIM8_CH3N"
      },
      {
        fn: "USART8_RTS"
      },
      {
        fn: "USART4_RX",
        remap: "1"
      },
      {
        fn: "USART5_RTS",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "TIM3_CH4"
      },
      {
        fn: "TIM3_CH4",
        remap: "2"
      },
      {
        fn: "USART5_RTS",
        remap: "3"
      },
      {
        fn: "USART9_TX"
      }
    ],
    PB10: [
      {
        fn: "I3C1_SCL"
      },
      {
        fn: "LTDC_B3"
      },
      {
        fn: "USART3_TX"
      },
      {
        fn: "TIM2_CH3",
        remap: "2"
      },
      {
        fn: "TIM2_CH3",
        remap: "3"
      },
      {
        fn: "TIM1_BKIN",
        remap: "3"
      }
    ],
    PB11: [
      {
        fn: "FSMC_D9"
      },
      {
        fn: "LTDC_B2"
      },
      {
        fn: "USART8_CK",
        remap: "3"
      },
      {
        fn: "TIM2_CH4",
        remap: "2"
      },
      {
        fn: "TIM2_CH4",
        remap: "3"
      },
      {
        fn: "USART3_RX"
      },
      {
        fn: "USART8_CK",
        remap: "2"
      }
    ],
    PB12: [
      {
        fn: "FSMC_D10"
      },
      {
        fn: "I2S2_WS"
      },
      {
        fn: "SPI2_NSS"
      },
      {
        fn: "USART3_CK"
      },
      {
        fn: "LTDC_G6",
        remap: "1"
      },
      {
        fn: "USART8_RTS",
        remap: "3"
      },
      {
        fn: "TIM1_BKIN"
      },
      {
        fn: "USART8_RTS",
        remap: "2"
      }
    ],
    PB13: [
      {
        fn: "I2S2_CK"
      },
      {
        fn: "SPI2_SCK"
      },
      {
        fn: "USART3_CTS"
      },
      {
        fn: "USART8_CTS",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N"
      },
      {
        fn: "USART3_CTS",
        remap: "1"
      },
      {
        fn: "USART8_CTS",
        remap: "2"
      }
    ],
    PB14: [
      {
        fn: "FSMC_D12"
      },
      {
        fn: "SPI2_MISO"
      },
      {
        fn: "USART3_RTS"
      },
      {
        fn: "LTDC_B0",
        remap: "1"
      },
      {
        fn: "USART8_RX",
        remap: "3"
      },
      {
        fn: "TIM1_CH2N"
      },
      {
        fn: "USART3_RTS",
        remap: "1"
      },
      {
        fn: "USART8_RX",
        remap: "2"
      }
    ],
    PB15: [
      {
        fn: "I2S2_SD"
      },
      {
        fn: "SDIO_D1"
      },
      {
        fn: "USART8_CK",
        remap: "1"
      },
      {
        fn: "USART8_TX",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N"
      },
      {
        fn: "USART1_TX",
        remap: "2"
      },
      {
        fn: "USART8_TX",
        remap: "3"
      }
    ],
    PB2: [
      {
        fn: "LTDC_G4"
      },
      {
        fn: "USART9_RX"
      },
      {
        fn: "USART5_CK",
        remap: "2"
      },
      {
        fn: "USART4_CK",
        remap: "1"
      },
      {
        fn: "USART5_CK",
        remap: "3"
      }
    ],
    PB3: [
      {
        fn: "I2S3_CK"
      },
      {
        fn: "SPI3_SCK"
      },
      {
        fn: "DVP_D5",
        remap: "1"
      },
      {
        fn: "LTDC_G4",
        remap: "1"
      },
      {
        fn: "SPI1_SCK",
        remap: "1"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "USART5_CK",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "3"
      },
      {
        fn: "USART5_CTS"
      }
    ],
    PB4: [
      {
        fn: "SPI3_MISO"
      },
      {
        fn: "DVP_D3",
        remap: "1"
      },
      {
        fn: "I3C1_SCL",
        remap: "1"
      },
      {
        fn: "SPI1_MISO",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "USART5_TX",
        remap: "1"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "USART5_RTS"
      }
    ],
    PB5: [
      {
        fn: "I2C1_SMBA"
      },
      {
        fn: "SPI3_MOSI"
      },
      {
        fn: "DVP_D10",
        remap: "1"
      },
      {
        fn: "I3C1_SDA",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI",
        remap: "1"
      },
      {
        fn: "USART5_RX",
        remap: "1"
      },
      {
        fn: "USART6_CK",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "USART5_CK"
      },
      {
        fn: "I2S3_SD"
      }
    ],
    PB6: [
      {
        fn: "DVP_D5"
      },
      {
        fn: "I2C1_SCL"
      },
      {
        fn: "TIM4_CH1"
      },
      {
        fn: "USBHS2_DM"
      },
      {
        fn: "FSMC_NADV",
        remap: "1"
      },
      {
        fn: "TIM8_CH1",
        remap: "1"
      },
      {
        fn: "TIM8_CH2",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "1"
      },
      {
        fn: "USART7_CTS",
        remap: "2"
      }
    ],
    PB7: [
      {
        fn: "FSMC_NADV"
      },
      {
        fn: "I2C1_SDA"
      },
      {
        fn: "TIM4_CH2"
      },
      {
        fn: "USBHS2_DP"
      },
      {
        fn: "FSMC_NADV",
        remap: "1"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "USART1_RX",
        remap: "1"
      },
      {
        fn: "USART7_RTS",
        remap: "2"
      },
      {
        fn: "TIM8_CH2",
        remap: "1"
      }
    ],
    PB8: [
      {
        fn: "DVP_D6"
      },
      {
        fn: "TIM8_CH3",
        remap: "1"
      },
      {
        fn: "TIM1_CH3",
        remap: "3"
      },
      {
        fn: "TIM4_CH3"
      },
      {
        fn: "USART4_CTS",
        remap: "2"
      },
      {
        fn: "USART4_CTS",
        remap: "3"
      },
      {
        fn: "USART5_CTS",
        remap: "1"
      },
      {
        fn: "USART6_TX",
        remap: "1"
      },
      {
        fn: "USART10_TX",
        remap: "1"
      },
      {
        fn: "I2C1_SCL",
        remap: "1"
      },
      {
        fn: "CAN1_RX",
        remap: "2"
      }
    ],
    PB9: [
      {
        fn: "FSMC_D11"
      },
      {
        fn: "LTDC_B4"
      },
      {
        fn: "SDIO_D1"
      },
      {
        fn: "SPI2_NSS",
        remap: "1"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "USART10_RX",
        remap: "2"
      },
      {
        fn: "TIM4_CH4"
      },
      {
        fn: "TIM8_BKIN",
        remap: "1"
      },
      {
        fn: "USART4_RTS",
        remap: "2"
      },
      {
        fn: "USART4_RTS",
        remap: "3"
      },
      {
        fn: "USART5_RTS",
        remap: "1"
      },
      {
        fn: "USART6_RX",
        remap: "1"
      },
      {
        fn: "USART10_RX",
        remap: "1"
      },
      {
        fn: "I2C1_SDA",
        remap: "1"
      },
      {
        fn: "CAN1_TX",
        remap: "2"
      }
    ],
    PC0: [
      {
        fn: "ADC1_IN10"
      },
      {
        fn: "LTDC_R0"
      },
      {
        fn: "USART6_TX"
      },
      {
        fn: "LTDC_R0",
        remap: "1"
      },
      {
        fn: "USART6_TX",
        remap: "3"
      }
    ],
    PC1: [
      {
        fn: "ADC1_IN11"
      },
      {
        fn: "USART6_RX"
      },
      {
        fn: "USART6_RX",
        remap: "3"
      },
      {
        fn: "USART7_CK"
      }
    ],
    PC10: [
      {
        fn: "DVP_D8"
      },
      {
        fn: "SDIO_D2"
      },
      {
        fn: "USART4_TX"
      },
      {
        fn: "I2S3_CK",
        remap: "1"
      },
      {
        fn: "USART3_TX",
        remap: "1"
      },
      {
        fn: "SPI3_SCK",
        remap: "1"
      }
    ],
    PC11: [
      {
        fn: "DVP_D4"
      },
      {
        fn: "SDIO_D3"
      },
      {
        fn: "USART4_RX"
      },
      {
        fn: "SDIO_D3",
        remap: "1"
      },
      {
        fn: "SPI3_MISO",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "1"
      }
    ],
    PC12: [
      {
        fn: "USART5_TX"
      },
      {
        fn: "I2S3_SD",
        remap: "1"
      },
      {
        fn: "USART3_CK",
        remap: "1"
      },
      {
        fn: "USART4_CK"
      },
      {
        fn: "SPI3_MOSI",
        remap: "1"
      }
    ],
    PC13: [
      {
        fn: "TIM8_CH4",
        remap: "1"
      }
    ],
    PC14: [
      {
        fn: "OSC32_IN"
      },
      {
        fn: "USART10_CTS"
      },
      {
        fn: "USART10_CTS",
        remap: "1"
      }
    ],
    PC15: [
      {
        fn: "OSC32_OUT"
      },
      {
        fn: "USART10_RTS"
      },
      {
        fn: "USART10_RTS",
        remap: "1"
      }
    ],
    PC2: [
      {
        fn: "USART6_CTS"
      },
      {
        fn: "LTDC_R2",
        remap: "1"
      },
      {
        fn: "USART6_CTS",
        remap: "3"
      },
      {
        fn: "USART7_TX"
      }
    ],
    PC3: [
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "USART6_RTS"
      },
      {
        fn: "USART6_RTS",
        remap: "3"
      },
      {
        fn: "USART7_RX"
      }
    ],
    PC4: [
      {
        fn: "USART7_CTS"
      },
      {
        fn: "USART7_CTS",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "1"
      },
      {
        fn: "USART8_TX"
      }
    ],
    PC5: [
      {
        fn: "ADC1_IN15"
      },
      {
        fn: "USART7_RTS"
      },
      {
        fn: "USART4_RTS",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "3"
      },
      {
        fn: "USART7_RTS",
        remap: "1"
      },
      {
        fn: "USART8_RX"
      }
    ],
    PC6: [
      {
        fn: "I2S2_MCK"
      },
      {
        fn: "SDIO_D6"
      },
      {
        fn: "TIM8_CH1"
      },
      {
        fn: "TIM3_CH1",
        remap: "3"
      }
    ],
    PC7: [
      {
        fn: "I2S3_MCK"
      },
      {
        fn: "TIM8_CH2"
      },
      {
        fn: "TIM3_CH2",
        remap: "3"
      },
      {
        fn: "I2S3_MCK",
        remap: "1"
      }
    ],
    PC8: [
      {
        fn: "DVP_D2"
      },
      {
        fn: "SDIO_D0"
      },
      {
        fn: "USART7_CTS",
        remap: "3"
      },
      {
        fn: "TIM3_CH3",
        remap: "3"
      },
      {
        fn: "TIM8_CH3"
      }
    ],
    PC9: [
      {
        fn: "TIM8_CH4"
      },
      {
        fn: "TIM3_CH4",
        remap: "3"
      },
      {
        fn: "USART7_RTS",
        remap: "3"
      }
    ],
    PD0: [
      {
        fn: "FSMC_D2"
      },
      {
        fn: "CAN1_RX",
        remap: "3"
      },
      {
        fn: "FSMC_D2",
        remap: "1"
      }
    ],
    PD1: [
      {
        fn: "FSMC_D3"
      },
      {
        fn: "FSMC_D3",
        remap: "1"
      },
      {
        fn: "CAN1_TX",
        remap: "3"
      }
    ],
    PD10: [
      {
        fn: "FSMC_D15"
      },
      {
        fn: "USART10_CK",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "3"
      },
      {
        fn: "USART10_CK",
        remap: "3"
      }
    ],
    PD11: [
      {
        fn: "FSMC_A16"
      },
      {
        fn: "USART10_TX",
        remap: "2"
      },
      {
        fn: "USART3_CTS",
        remap: "2"
      },
      {
        fn: "USART3_CTS",
        remap: "3"
      },
      {
        fn: "USART10_TX",
        remap: "3"
      }
    ],
    PD12: [
      {
        fn: "FSMC_A17"
      },
      {
        fn: "USART10_RX",
        remap: "2"
      },
      {
        fn: "TIM4_CH1",
        remap: "1"
      },
      {
        fn: "USART3_RTS",
        remap: "2"
      },
      {
        fn: "USART3_RTS",
        remap: "3"
      },
      {
        fn: "USART10_RX",
        remap: "3"
      }
    ],
    PD13: [
      {
        fn: "FSMC_A18"
      },
      {
        fn: "USART10_CTS",
        remap: "2"
      },
      {
        fn: "TIM4_CH2",
        remap: "1"
      },
      {
        fn: "USART10_CTS",
        remap: "3"
      }
    ],
    PD14: [
      {
        fn: "FSMC_D0"
      },
      {
        fn: "USART10_RTS",
        remap: "3"
      },
      {
        fn: "TIM4_CH3",
        remap: "1"
      },
      {
        fn: "USART10_RTS",
        remap: "2"
      }
    ],
    PD15: [
      {
        fn: "FSMC_D1"
      },
      {
        fn: "TIM4_CH4",
        remap: "1"
      }
    ],
    PD2: [
      {
        fn: "SDIO_CMD"
      },
      {
        fn: "USART5_RX"
      },
      {
        fn: "SDIO_CMD",
        remap: "1"
      },
      {
        fn: "TIM3_ETR"
      },
      {
        fn: "TIM3_ETR",
        remap: "2"
      },
      {
        fn: "TIM3_ETR",
        remap: "3"
      },
      {
        fn: "USART4_RTS"
      }
    ],
    PD3: [
      {
        fn: "FSMC_CLK"
      },
      {
        fn: "FSMC_CLK",
        remap: "1"
      },
      {
        fn: "USART2_CTS",
        remap: "1"
      }
    ],
    PD4: [
      {
        fn: "FSMC_NOE"
      },
      {
        fn: "USART2_RTS",
        remap: "1"
      }
    ],
    PD5: [
      {
        fn: "FSMC_NWE"
      },
      {
        fn: "FSMC_NWE",
        remap: "1"
      },
      {
        fn: "USART2_TX",
        remap: "1"
      }
    ],
    PD6: [
      {
        fn: "DVP_D10"
      },
      {
        fn: "FSMC_NWAIT"
      },
      {
        fn: "FSMC_NWAIT",
        remap: "1"
      },
      {
        fn: "USART2_RX",
        remap: "1"
      }
    ],
    PD7: [
      {
        fn: "FSMC_NCE2"
      },
      {
        fn: "FSMC_NE1"
      },
      {
        fn: "FSMC_NE1",
        remap: "1"
      },
      {
        fn: "USART2_CK",
        remap: "1"
      }
    ],
    PD8: [
      {
        fn: "FSMC_D13"
      },
      {
        fn: "LTDC_G5"
      },
      {
        fn: "USART9_CK"
      },
      {
        fn: "USART9_CK",
        remap: "1"
      },
      {
        fn: "USART3_TX",
        remap: "3"
      }
    ],
    PD9: [
      {
        fn: "FSMC_D14"
      },
      {
        fn: "FSMC_D14",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "3"
      }
    ],
    PE0: [
      {
        fn: "FSMC_NBL0"
      },
      {
        fn: "USART10_TX"
      },
      {
        fn: "TIM4_ETR",
        remap: "1"
      },
      {
        fn: "USART4_TX",
        remap: "2"
      },
      {
        fn: "TIM4_ETR"
      },
      {
        fn: "USART4_TX",
        remap: "3"
      },
      {
        fn: "USART6_CTS",
        remap: "1"
      }
    ],
    PE1: [
      {
        fn: "FSMC_NBL1"
      },
      {
        fn: "USART10_RX"
      },
      {
        fn: "USART4_RX",
        remap: "2"
      },
      {
        fn: "USART4_RX",
        remap: "3"
      },
      {
        fn: "USART6_RTS",
        remap: "1"
      }
    ],
    PE10: [
      {
        fn: "FSMC_D7"
      },
      {
        fn: "USART8_CTS",
        remap: "1"
      },
      {
        fn: "TIM1_CH2N",
        remap: "3"
      },
      {
        fn: "USART6_TX",
        remap: "2"
      }
    ],
    PE11: [
      {
        fn: "FSMC_D8"
      },
      {
        fn: "USART6_RX",
        remap: "2"
      },
      {
        fn: "TIM1_CH2",
        remap: "3"
      },
      {
        fn: "USART8_RTS",
        remap: "1"
      }
    ],
    PE12: [
      {
        fn: "USART10_CK"
      },
      {
        fn: "USART4_CK",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "USART4_CK",
        remap: "3"
      },
      {
        fn: "USART10_CK",
        remap: "1"
      }
    ],
    PE2: [
      {
        fn: "FSMC_A23"
      },
      {
        fn: "USART9_CK",
        remap: "3"
      },
      {
        fn: "USART9_CK",
        remap: "2"
      }
    ],
    PE3: [
      {
        fn: "FSMC_A19"
      },
      {
        fn: "USART9_TX",
        remap: "3"
      },
      {
        fn: "USART9_TX",
        remap: "2"
      }
    ],
    PE4: [
      {
        fn: "FSMC_A20"
      },
      {
        fn: "USART9_RX",
        remap: "3"
      },
      {
        fn: "USART9_RX",
        remap: "2"
      }
    ],
    PE5: [
      {
        fn: "FSMC_A21"
      },
      {
        fn: "USART9_CTS",
        remap: "3"
      },
      {
        fn: "USART9_CTS",
        remap: "2"
      }
    ],
    PE6: [
      {
        fn: "FSMC_A22"
      },
      {
        fn: "USART9_RTS",
        remap: "3"
      },
      {
        fn: "USART9_RTS",
        remap: "2"
      }
    ],
    PE7: [
      {
        fn: "FSMC_D4"
      },
      {
        fn: "TIM1_ETR",
        remap: "3"
      }
    ],
    PE8: [
      {
        fn: "FSMC_D5"
      },
      {
        fn: "USART9_CTS"
      },
      {
        fn: "USART5_TX",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N",
        remap: "3"
      },
      {
        fn: "USART5_TX",
        remap: "2"
      },
      {
        fn: "USART9_CTS",
        remap: "1"
      }
    ],
    PE9: [
      {
        fn: "FSMC_D6"
      },
      {
        fn: "USART9_RTS"
      },
      {
        fn: "TIM1_CH1",
        remap: "3"
      },
      {
        fn: "USART5_RX",
        remap: "3"
      },
      {
        fn: "USART9_RTS",
        remap: "1"
      },
      {
        fn: "USART5_RX",
        remap: "2"
      }
    ]
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN1",
        "IN10",
        "IN11",
        "IN12",
        "IN13",
        "IN14",
        "IN15",
        "IN2",
        "IN3",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9"
      ]
    },
    {
      id: "ARGB",
      signals: [
        "OUT"
      ]
    },
    {
      id: "CAN1",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "DAC2",
      signals: [
        "OUT"
      ]
    },
    {
      id: "DVP",
      signals: [
        "D0",
        "D1",
        "D10",
        "D11",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7",
        "D8",
        "D9",
        "HSYNC",
        "VSYNC"
      ]
    },
    {
      id: "FSMC",
      signals: [
        "A16",
        "A17",
        "A18",
        "A19",
        "A20",
        "A21",
        "A22",
        "A23",
        "CLK",
        "D0",
        "D1",
        "D10",
        "D11",
        "D12",
        "D13",
        "D14",
        "D15",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7",
        "D8",
        "D9",
        "NADV",
        "NBL0",
        "NBL1",
        "NCE2",
        "NE1",
        "NOE",
        "NWAIT",
        "NWE"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA",
        "SMBA"
      ]
    },
    {
      id: "I2S2",
      signals: [
        "CK",
        "MCK",
        "SD",
        "WS"
      ]
    },
    {
      id: "I2S3",
      signals: [
        "CK",
        "MCK",
        "SD",
        "WS"
      ]
    },
    {
      id: "I3C1",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "LTDC",
      signals: [
        "B0",
        "B1",
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "CLK",
        "DE",
        "G0",
        "G1",
        "G2",
        "G3",
        "G4",
        "G5",
        "G6",
        "G7",
        "HSYNC",
        "R0",
        "R1",
        "R2",
        "R3",
        "R4",
        "R5",
        "R6",
        "R7",
        "VSYNC"
      ]
    },
    {
      id: "OPA1",
      signals: [
        "N1",
        "N2",
        "OUT1",
        "OUT2",
        "P1",
        "P2"
      ]
    },
    {
      id: "OSC32",
      signals: [
        "IN",
        "OUT"
      ]
    },
    {
      id: "SDIO",
      signals: [
        "CK",
        "CMD",
        "D0",
        "D1",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7"
      ]
    },
    {
      id: "SPI1",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI2",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI3",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM4",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM5",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4"
      ]
    },
    {
      id: "TIM8",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART10",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART4",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART5",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART6",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART7",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART8",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART9",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USBHS1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "USBHS2",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "GPIO",
      signals: []
    },
    {
      id: "SYSTEM",
      signals: []
    },
    {
      id: "DBG",
      signals: [
        "SWCLK",
        "SWDIO"
      ]
    },
    {
      id: "PWR",
      signals: []
    },
    {
      id: "EXTI",
      signals: []
    },
    {
      id: "DMA",
      signals: []
    },
    {
      id: "IWDG",
      signals: []
    },
    {
      id: "WWDG",
      signals: []
    },
    {
      id: "CRC",
      signals: []
    },
    {
      id: "RTC",
      signals: []
    },
    {
      id: "FLASH",
      signals: []
    }
  ],
  irqs: [
    {
      n: 16,
      name: "WWDG",
      owner: "WWDG"
    },
    {
      n: 17,
      name: "PVD",
      owner: "PWR"
    },
    {
      n: 18,
      name: "TAMPER",
      owner: "PWR"
    },
    {
      n: 19,
      name: "RTC",
      owner: "RTC",
      gate: "irqAlarm"
    },
    {
      n: 20,
      name: "FLASH",
      owner: "FLASH"
    },
    {
      n: 21,
      name: "RCC",
      owner: "SYSTEM"
    },
    {
      n: 22,
      name: "EXTI0",
      owner: "EXTI"
    },
    {
      n: 23,
      name: "EXTI1",
      owner: "EXTI"
    },
    {
      n: 24,
      name: "EXTI2",
      owner: "EXTI"
    },
    {
      n: 25,
      name: "EXTI3",
      owner: "EXTI"
    },
    {
      n: 26,
      name: "EXTI4",
      owner: "EXTI"
    },
    {
      n: 34,
      name: "ADC1_2",
      owner: "ADC1",
      gate: "irqEoc"
    },
    {
      n: 35,
      name: "CAN1_TX",
      owner: "CAN1"
    },
    {
      n: 36,
      name: "CAN1_RX0",
      owner: "CAN1"
    },
    {
      n: 37,
      name: "CAN1_RX1",
      owner: "CAN1"
    },
    {
      n: 38,
      name: "CAN1_SCE",
      owner: "CAN1"
    },
    {
      n: 39,
      name: "EXTI9_5",
      owner: "EXTI"
    },
    {
      n: 40,
      name: "TIM1_BRK",
      owner: "TIM1",
      gate: "irqBreak"
    },
    {
      n: 41,
      name: "TIM1_UP",
      owner: "TIM1",
      gate: "irqUpdate"
    },
    {
      n: 42,
      name: "TIM1_TRG_COM",
      owner: "TIM1",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 43,
      name: "TIM1_CC",
      owner: "TIM1",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 44,
      name: "TIM2",
      owner: "TIM2",
      gate: "irqUpdate"
    },
    {
      n: 45,
      name: "TIM3",
      owner: "TIM3",
      gate: "irqUpdate"
    },
    {
      n: 46,
      name: "TIM4",
      owner: "TIM4",
      gate: "irqUpdate"
    },
    {
      n: 47,
      name: "I2C1_EV",
      owner: "I2C1",
      gate: "irqEvt"
    },
    {
      n: 48,
      name: "I2C1_ER",
      owner: "I2C1",
      gate: "irqErr"
    },
    {
      n: 49,
      name: "I3C_EV",
      owner: "I3C"
    },
    {
      n: 50,
      name: "I3C_ER",
      owner: "I3C"
    },
    {
      n: 51,
      name: "SPI1",
      owner: "SPI1"
    },
    {
      n: 52,
      name: "SPI2",
      owner: "SPI2"
    },
    {
      n: 53,
      name: "USART1",
      owner: "USART1"
    },
    {
      n: 54,
      name: "USART2",
      owner: "USART2"
    },
    {
      n: 55,
      name: "USART3",
      owner: "USART3"
    },
    {
      n: 56,
      name: "EXTI15_10",
      owner: "EXTI"
    },
    {
      n: 57,
      name: "RTCAlarm",
      owner: "RTC",
      gate: "irqAlarm"
    },
    {
      n: 59,
      name: "TIM8_BRK",
      owner: "TIM8",
      gate: "irqBreak"
    },
    {
      n: 60,
      name: "TIM8_UP",
      owner: "TIM8",
      gate: "irqUpdate"
    },
    {
      n: 61,
      name: "TIM8_TRG_COM",
      owner: "TIM8",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 62,
      name: "TIM8_CC",
      owner: "TIM8",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 63,
      name: "RNG",
      owner: "RNG"
    },
    {
      n: 65,
      name: "SDIO",
      owner: "SDIO"
    },
    {
      n: 66,
      name: "TIM5",
      owner: "TIM5",
      gate: "irqUpdate"
    },
    {
      n: 67,
      name: "SPI3",
      owner: "SPI3"
    },
    {
      n: 68,
      name: "USART4",
      owner: "USART4"
    },
    {
      n: 69,
      name: "USART5",
      owner: "USART5"
    },
    {
      n: 70,
      name: "TIM6",
      owner: "TIM6",
      gate: "irqUpdate"
    },
    {
      n: 71,
      name: "TIM7",
      owner: "TIM7",
      gate: "irqUpdate"
    },
    {
      n: 77,
      name: "ETH",
      owner: "ETH"
    },
    {
      n: 78,
      name: "ETH_WKUP",
      owner: "ETH"
    },
    {
      n: 79,
      name: "LTDC",
      owner: "LTDC"
    }
  ],
  pending: [
    "packages/ports \u7531 scripts/rebuild_v407_from_ds.py \u4ECE DS0 \u88682-1-1 + RM 10.2.11 \u81EA\u52A8\u751F\u6210\uFF1Bremap \u5B57\u6BB5 = AFIO \u914D\u7F6E\u7EC4\u7F16\u53F7\uFF0800/01/10/11 \u2192 0/1/2/3\uFF09",
    "OSC_IN/OSC_OUT \u53EF\u7ECF AFIO \u6539\u4F5C PD0/PD1\uFF08DS0 \u6CE84\uFF09\uFF0C\u8FD9\u4E00\u5C42\u590D\u7528\u6CA1\u6709\u5EFA\u6A21 \u2014\u2014 GPIO \u76EE\u524D\u53EA\u6309\u5F15\u811A\u540D\u914D\uFF0C\u6CA1\u6709\u300CPD0 \u501F\u7528 OSC_IN \u811A\u300D\u7684\u5165\u53E3",
    "DS0 \u6CE86/7\uFF1ASDIO_D0/D1\u3001DVP_D5\u3001FSMC_NADV \u6709\u300CETH/SDIO/USB \u540C\u65F6\u5F00\u542F\u65F6\u81EA\u52A8\u6539\u811A\u300D\u7684\u6761\u4EF6\u91CD\u6620\u5C04\uFF0C\u5C1A\u672A\u5EFA\u6A21",
    "KEU6\uFF08QFN32\uFF09\u7684 pin 16 \u5728\u5F15\u811A\u8868\u91CC\u6CA1\u6709\u5BF9\u5E94\u884C\uFF0C\u5DF2\u6309 VDD \u8865\u9F50\uFF0C\u9700\u5BF9\u7167 DS0 \u5F15\u811A\u6392\u5217\u56FE\u786E\u8BA4",
    "TIM8_CH1N/CH2N/CH3N \u5728\u7EC41 \u843D\u5230 PA13/PA14/PA15\uFF0C\u4E0E 2 \u7EBF\u8C03\u8BD5\u53E3\u51B2\u7A81\uFF08\u786C\u4EF6\u4E8B\u5B9E\uFF0C\u4E0D\u662F\u6570\u636E\u9519\uFF09",
    "\u6E90\u8868\u7F3A\u8FD9\u51E0\u6761\u590D\u7528\u9879\uFF0C\u5BF9\u5E94\u5916\u8BBE\u56E0\u6B64\u8FDB\u300C\u5668\u4EF6\u6570\u636E\u5F85\u8865\u300D\uFF08\u5916\u8BBE\u6811\u5E95\u90E8\u7425\u73C0\u8272\u90A3\u884C\uFF09\uFF0C\u9700\u4ECE DS0 \u8865\uFF1ASPI2_MOSI\uFF08\u7591\u4E0E I2S2_SD \u540C\u811A PB15\uFF09\u3001USBHS1_DM\uFF08USBHS1 \u53EA\u5217\u4E86 DP=PA12\uFF09\u3001DAC2 \u5168\u90E8\u8F93\u51FA",
    "\u6E90\u8868\u5185\u90E8\u77DB\u76FE\uFF08\u540C\u4E00\u4FE1\u53F7\u7684\u540C\u4E00\u914D\u7F6E\u7EC4\u843D\u5230\u4E24\u4E2A\u5F15\u811A\uFF09\uFF0C\u4E0B\u5217\u6761\u76EE\u4EE5\u300C\u4E24\u8005\u90FD\u4FDD\u7559\u300D\u5904\u7406\uFF0C\u914D\u7F6E\u7EC4\u7F16\u53F7\u9700\u56DE\u67E5 DS0 \u539F\u8868\uFF1AFSMC_NADV \u7EC41=PB6/PB7\uFF1BI2S3_MCK \u7EC40=PA8/PC7\uFF1BSDIO_D1 \u7EC40=PB15/PB9\uFF1BTIM1_CH1 \u7EC41=PA8/PB9\uFF1BTIM1_CH3N \u7EC43=PB7/PE12\uFF1BTIM3_CH1 \u7EC42=PB3/PB4\uFF1BTIM3_CH2 \u7EC42=PB4/PB5\uFF1BTIM8_CH2 \u7EC41=PB6/PB7\uFF1BUSART10_RX \u7EC42=PB9/PD12",
    "ETH / LTDC / DVP / FSMC / SDIO / ARGB / I3C / USBHS \u53EA\u751F\u6210\u65F6\u949F\u4F7F\u80FD + TODO\uFF0C\u53C2\u6570\u5EFA\u6A21\u5F85\u8865",
    "DMA \u901A\u9053 \u2194 \u786C\u4EF6\u8BF7\u6C42\u6620\u5C04\u5F85\u4ECE RM\u300CDMA \u8BF7\u6C42\u6620\u5C04\u300D\u8865\u5F55\uFF1B\u5F53\u524D\u53EA\u6821\u9A8C\u901A\u9053\u4E0D\u91CD\u590D"
  ]
};

// src/core/devices/data/ch32v467.json
var ch32v467_default = {
  packVersion: "0.2.0",
  series: "CH32V467",
  vendor: "WCH",
  core: "QingKe V3V \xB7 RV32IMAFCXV",
  source: "CH32V467DS0\uFF08= CH32V407 + \u5185\u7F6E 8MB PSRAM\uFF1B\u5916\u8BBE/\u5F15\u811A/DMA \u4E0E CH32V407 \u4E00\u4E00\u5BF9\u5E94\uFF09+ CH32V407RM V1.3",
  sdkHeader: "ch32v4x7",
  flashKb: 512,
  ramKb: 8392,
  voltage: "2.9 \u2013 3.6 V",
  maxSysclk: 200,
  extiLines: 16,
  dmaControllers: [
    {
      id: "DMA1",
      channels: 13
    },
    {
      id: "DMA2",
      channels: 11
    }
  ],
  dmaChannels: 24,
  dmaMap: {
    "1": [
      "TIM2_CH3",
      "TIM4_CH1"
    ],
    "2": [
      "SPI1_RX",
      "USART3_TX",
      "TIM1_CH1",
      "TIM2_UP",
      "TIM3_CH3"
    ],
    "3": [
      "SPI1_TX",
      "USART3_RX",
      "TIM1_CH2",
      "I3C_TX",
      "TIM3_UP",
      "TIM3_CH4"
    ],
    "4": [
      "SPI2_RX",
      "USART1_TX",
      "TIM1_TRIG",
      "TIM1_CH4",
      "TIM1_COM",
      "I3C_RX",
      "TIM2_CH1",
      "TIM4_CH2"
    ],
    "5": [
      "SPI2_TX",
      "USART1_RX",
      "TIM1_UP",
      "TIM3_CH1",
      "TIM4_CH3"
    ],
    "6": [
      "USART2_RX",
      "I2C1_TX",
      "TIM1_CH3",
      "TIM2_CH2",
      "TIM3_TRIG"
    ],
    "7": [
      "USART2_TX",
      "I2C1_RX",
      "TIM2_CH4",
      "TIM4_UP"
    ],
    "8": [
      "USART9_TX",
      "I3C_TC"
    ],
    "9": [
      "USART9_RX"
    ],
    "10": [
      "USART10_TX",
      "ARGB"
    ],
    "11": [
      "USART10_RX"
    ],
    "12": [
      "ADC"
    ],
    "13": [
      "ADC"
    ],
    "14": [
      "TIM5_CH4",
      "TIM5_TRIG",
      "SPI3_RX",
      "TIM8_CH3"
    ],
    "15": [
      "TIM5_CH3",
      "TIM5_UP",
      "SPI3_TX",
      "TIM8_UP",
      "USART5_RX"
    ],
    "16": [
      "TIM6_UP",
      "TIM8_TRIG",
      "TIM8_COM",
      "TIM8_CH4",
      "DAC1",
      "DAC2",
      "USART4_RX"
    ],
    "17": [
      "TIM5_CH2",
      "TIM7_UP",
      "TIM8_CH1",
      "SDIO",
      "USART5_TX"
    ],
    "18": [
      "TIM5_CH1",
      "USART4_TX",
      "DVP"
    ],
    "19": [
      "TIM8_CH2",
      "USART6_TX"
    ],
    "20": [
      "USART6_RX"
    ],
    "21": [
      "USART7_TX"
    ],
    "22": [
      "USART7_RX"
    ],
    "23": [
      "USART8_TX"
    ],
    "24": [
      "USART8_RX"
    ]
  },
  peripheralVersion: "1.0",
  api: {
    clockProfile: "full",
    clockApi: "pb",
    nvicApi: "cmsis",
    adcClock: "rcc",
    flashPrefetch: false,
    flashLatency: false,
    gpioSpeedStyle: "level",
    gpioSpeeds: [
      "Low",
      "Medium",
      "High"
    ],
    gpioOpenDrain: true,
    nvicGroups: [],
    adcSampleStyle: "cyclesmode",
    adcSampleTimes: [
      "CyclesMode0",
      "CyclesMode1",
      "CyclesMode2",
      "CyclesMode3",
      "CyclesMode4",
      "CyclesMode5",
      "CyclesMode6",
      "CyclesMode7"
    ],
    pllMuls: [
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      24,
      26,
      28,
      30,
      32,
      34,
      36,
      38,
      40
    ],
    apb1Divs: [],
    apb2Divs: [
      2,
      4,
      6,
      8
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    note: "V407: RCC \u7528 PB1/PB2/HB \u547D\u540D\uFF1BNVIC \u8D70 core_riscv.h \u7684 CMSIS \u63A5\u53E3\uFF1BGPIO \u901F\u5EA6\u662F Low/Medium/High\uFF1BADC \u91C7\u6837\u65F6\u95F4\u662F CyclesMode0..7\uFF1BFlash \u6CA1\u6709 SetLatency/PrefetchBufferCmd"
  },
  debug: {
    twoWire: true,
    singleWire: true,
    swdio: "PA13",
    swclk: "PA14",
    note: "1/2 \u7EBF\u8C03\u8BD5\u63A5\u53E3\uFF08SDI\uFF09\u3002\u590D\u4F4D\u540E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u53EF\u5728\u4E3B\u7A0B\u5E8F\u91CC\u5173\u95ED\u91CA\u653E PA13/PA14\u3002"
  },
  clock: {
    hsi: 8,
    hseOptions: [
      8,
      16,
      25
    ],
    lsi: 40,
    pllSource: "HSI",
    pllMin: 8,
    pllMax: 40,
    maxSysclk: 200,
    ahbDivs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb1Divs: [
      1
    ],
    apb2Divs: [
      2,
      4,
      6,
      8
    ],
    adcDivs: [
      2,
      4,
      6,
      8
    ],
    notes: [
      "HSI 8 MHz \u2192 PLL \u2192 \u6700\u9AD8 200 MHz\uFF08DS \u88681-1\uFF09",
      "PLL \u5206\u9891/\u500D\u9891\u7EC4\u5408\u89C1 CH32V407RM\u300CRCC\u300D\u7AE0\u8282"
    ]
  },
  packages: [
    {
      id: "CH32V467KEU6",
      label: "QFN32",
      shape: "quad",
      pins: [
        {
          num: 0,
          name: "VSS",
          kind: "power"
        },
        {
          num: 1,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 2,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 3,
          name: "PA0",
          kind: "io"
        },
        {
          num: 4,
          name: "PA1",
          kind: "io"
        },
        {
          num: 5,
          name: "PA2",
          kind: "io"
        },
        {
          num: 6,
          name: "PA3",
          kind: "io"
        },
        {
          num: 7,
          name: "PA4",
          kind: "io"
        },
        {
          num: 8,
          name: "PA5",
          kind: "io"
        },
        {
          num: 9,
          name: "PA6",
          kind: "io"
        },
        {
          num: 10,
          name: "PA7",
          kind: "io"
        },
        {
          num: 11,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 12,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 13,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 14,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 15,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 16,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 17,
          name: "PD14",
          kind: "io"
        },
        {
          num: 18,
          name: "PD15",
          kind: "io"
        },
        {
          num: 19,
          name: "PA8",
          kind: "io"
        },
        {
          num: 20,
          name: "PA9",
          kind: "io"
        },
        {
          num: 21,
          name: "PA10",
          kind: "io"
        },
        {
          num: 22,
          name: "PA11",
          kind: "io"
        },
        {
          num: 23,
          name: "PA12",
          kind: "io"
        },
        {
          num: 24,
          name: "PA13",
          kind: "io"
        },
        {
          num: 25,
          name: "PA14",
          kind: "io"
        },
        {
          num: 26,
          name: "PA15",
          kind: "io"
        },
        {
          num: 27,
          name: "PB3",
          kind: "io"
        },
        {
          num: 28,
          name: "PB4",
          kind: "io"
        },
        {
          num: 29,
          name: "PB5",
          kind: "io"
        },
        {
          num: 30,
          name: "PB6",
          kind: "io"
        },
        {
          num: 31,
          name: "PB7",
          kind: "io"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        }
      ]
    },
    {
      id: "CH32V467RET6",
      label: "LQFP64",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io"
        },
        {
          num: 5,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 6,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "PC3",
          kind: "io",
          aliases: [
            "VSS"
          ],
          note: "\u4E0E VSS \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 12,
          name: "VSSA",
          kind: "power",
          aliases: [
            "VREF"
          ],
          note: "\u4E0E VREF \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 13,
          name: "VREF+",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 14,
          name: "VDDA",
          kind: "power",
          aliases: [
            "PA0"
          ],
          note: "\u4E0E PA0 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "VSS",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 19,
          name: "PA4",
          kind: "io"
        },
        {
          num: 20,
          name: "PA5",
          kind: "io"
        },
        {
          num: 21,
          name: "PA6",
          kind: "io"
        },
        {
          num: 22,
          name: "PA7",
          kind: "io"
        },
        {
          num: 23,
          name: "PC4",
          kind: "io"
        },
        {
          num: 24,
          name: "PC5",
          kind: "io"
        },
        {
          num: 25,
          name: "PB0",
          kind: "io"
        },
        {
          num: 26,
          name: "PB1",
          kind: "io"
        },
        {
          num: 27,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power",
          aliases: [
            "MDIRN"
          ],
          note: "\u4E0E MDIRN \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 29,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 30,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 31,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 33,
          name: "VSS",
          kind: "power"
        },
        {
          num: 34,
          name: "PD8",
          kind: "io"
        },
        {
          num: 35,
          name: "PB12",
          kind: "io"
        },
        {
          num: 36,
          name: "PB13",
          kind: "io"
        },
        {
          num: 37,
          name: "PB14",
          kind: "io"
        },
        {
          num: 38,
          name: "PB15",
          kind: "io"
        },
        {
          num: 39,
          name: "PB11",
          kind: "io"
        },
        {
          num: 40,
          name: "PB10",
          kind: "io"
        },
        {
          num: 41,
          name: "PD14",
          kind: "io"
        },
        {
          num: 42,
          name: "PD15",
          kind: "io"
        },
        {
          num: 43,
          name: "PA8",
          kind: "io"
        },
        {
          num: 44,
          name: "PA9",
          kind: "io"
        },
        {
          num: 45,
          name: "PA10",
          kind: "io"
        },
        {
          num: 46,
          name: "PA11",
          kind: "io"
        },
        {
          num: 47,
          name: "VSS",
          kind: "power",
          aliases: [
            "PA12"
          ],
          note: "\u4E0E PA12 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 48,
          name: "PA13",
          kind: "io"
        },
        {
          num: 49,
          name: "VDD",
          kind: "power"
        },
        {
          num: 50,
          name: "PA14",
          kind: "io"
        },
        {
          num: 51,
          name: "PA15",
          kind: "io"
        },
        {
          num: 52,
          name: "PC10",
          kind: "io"
        },
        {
          num: 53,
          name: "PC11",
          kind: "io"
        },
        {
          num: 54,
          name: "PC12",
          kind: "io"
        },
        {
          num: 55,
          name: "PD2",
          kind: "io"
        },
        {
          num: 56,
          name: "PB3",
          kind: "io"
        },
        {
          num: 57,
          name: "PB4",
          kind: "io"
        },
        {
          num: 58,
          name: "PB5",
          kind: "io"
        },
        {
          num: 59,
          name: "PB6",
          kind: "io"
        },
        {
          num: 60,
          name: "PB7",
          kind: "io"
        },
        {
          num: 61,
          name: "PB8",
          kind: "io"
        },
        {
          num: 62,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 63,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 64,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "CH32V467WEU6",
      label: "QFN68",
      shape: "quad",
      pins: [
        {
          num: 0,
          name: "VSS",
          kind: "power"
        },
        {
          num: 1,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io"
        },
        {
          num: 5,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 6,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "VSS",
          kind: "power",
          aliases: [
            "PC3"
          ],
          note: "\u4E0E PC3 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 12,
          name: "VSSA",
          kind: "power",
          aliases: [
            "VREF"
          ],
          note: "\u4E0E VREF \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 13,
          name: "VREF+",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 14,
          name: "VDDA",
          kind: "power",
          aliases: [
            "PA0"
          ],
          note: "\u4E0E PA0 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "VSS",
          kind: "power",
          aliases: [
            "VDD"
          ],
          note: "\u4E0E VDD \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 19,
          name: "PA4",
          kind: "io"
        },
        {
          num: 20,
          name: "PA5",
          kind: "io"
        },
        {
          num: 21,
          name: "PA6",
          kind: "io"
        },
        {
          num: 22,
          name: "PA7",
          kind: "io"
        },
        {
          num: 23,
          name: "PC4",
          kind: "io"
        },
        {
          num: 24,
          name: "PC5",
          kind: "io"
        },
        {
          num: 25,
          name: "PB0",
          kind: "io"
        },
        {
          num: 26,
          name: "PB1",
          kind: "io"
        },
        {
          num: 27,
          name: "PB2",
          kind: "io"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power",
          aliases: [
            "PE8"
          ],
          note: "\u4E0E PE8 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 29,
          name: "PE9",
          kind: "io"
        },
        {
          num: 30,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 31,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 32,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 33,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 34,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 35,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 36,
          name: "VSS",
          kind: "power",
          aliases: [
            "PD8"
          ],
          note: "\u4E0E PD8 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 37,
          name: "PB12",
          kind: "io"
        },
        {
          num: 38,
          name: "PB13",
          kind: "io"
        },
        {
          num: 39,
          name: "PB14",
          kind: "io"
        },
        {
          num: 40,
          name: "PB15",
          kind: "io"
        },
        {
          num: 41,
          name: "VSS",
          kind: "power",
          aliases: [
            "PB11"
          ],
          note: "\u4E0E PB11 \u5408\u5C01\u5230\u540C\u4E00\u4E2A\u7269\u7406\u5F15\u811A\uFF08\u7981\u6B62\u540C\u65F6\u914D\u6210\u8F93\u51FA\uFF09"
        },
        {
          num: 42,
          name: "PB10",
          kind: "io"
        },
        {
          num: 43,
          name: "PA8",
          kind: "io"
        },
        {
          num: 44,
          name: "PA9",
          kind: "io"
        },
        {
          num: 45,
          name: "PA10",
          kind: "io"
        },
        {
          num: 46,
          name: "PA11",
          kind: "io"
        },
        {
          num: 47,
          name: "PA12",
          kind: "io"
        },
        {
          num: 48,
          name: "PA13",
          kind: "io"
        },
        {
          num: 49,
          name: "PE10",
          kind: "io"
        },
        {
          num: 50,
          name: "PE11",
          kind: "io"
        },
        {
          num: 51,
          name: "VDD",
          kind: "power"
        },
        {
          num: 52,
          name: "PA14",
          kind: "io"
        },
        {
          num: 53,
          name: "PA15",
          kind: "io"
        },
        {
          num: 54,
          name: "PC10",
          kind: "io"
        },
        {
          num: 55,
          name: "PC11",
          kind: "io"
        },
        {
          num: 56,
          name: "PC12",
          kind: "io"
        },
        {
          num: 57,
          name: "PD2",
          kind: "io"
        },
        {
          num: 58,
          name: "PB3",
          kind: "io"
        },
        {
          num: 59,
          name: "PB4",
          kind: "io"
        },
        {
          num: 60,
          name: "PB5",
          kind: "io"
        },
        {
          num: 61,
          name: "PB6",
          kind: "io"
        },
        {
          num: 62,
          name: "PB7",
          kind: "io"
        },
        {
          num: 63,
          name: "PE12",
          kind: "io"
        },
        {
          num: 64,
          name: "PB8",
          kind: "io"
        },
        {
          num: 65,
          name: "VDD",
          kind: "power"
        },
        {
          num: 66,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 67,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        },
        {
          num: 68,
          name: "VDD",
          kind: "power",
          note: "\u539F\u8868\u672A\u5217\u51FA\u8BE5\u811A\uFF0C\u6309 QFN/LQFP \u7535\u6E90\u811A\u8865\u9F50\uFF08\u5F85\u6838\uFF09"
        }
      ]
    },
    {
      id: "CH32V467VET6",
      label: "LQFP100",
      shape: "quad",
      pins: [
        {
          num: 1,
          name: "PE2",
          kind: "io"
        },
        {
          num: 2,
          name: "PE3",
          kind: "io"
        },
        {
          num: 3,
          name: "PE4",
          kind: "io"
        },
        {
          num: 4,
          name: "PE5",
          kind: "io"
        },
        {
          num: 5,
          name: "PE6",
          kind: "io"
        },
        {
          num: 6,
          name: "VBAT",
          kind: "power"
        },
        {
          num: 7,
          name: "PC13",
          kind: "io"
        },
        {
          num: 8,
          name: "PC14",
          kind: "io"
        },
        {
          num: 9,
          name: "PC15",
          kind: "io"
        },
        {
          num: 10,
          name: "VSS",
          kind: "power"
        },
        {
          num: 11,
          name: "VDD",
          kind: "power"
        },
        {
          num: 12,
          name: "OSC_IN",
          kind: "osc"
        },
        {
          num: 13,
          name: "OSC_OUT",
          kind: "osc"
        },
        {
          num: 14,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 15,
          name: "PC0",
          kind: "io"
        },
        {
          num: 16,
          name: "PC1",
          kind: "io"
        },
        {
          num: 17,
          name: "PC2",
          kind: "io"
        },
        {
          num: 18,
          name: "PC3",
          kind: "io"
        },
        {
          num: 19,
          name: "VSSA",
          kind: "power"
        },
        {
          num: 20,
          name: "VREF",
          kind: "power"
        },
        {
          num: 21,
          name: "VREF+",
          kind: "power"
        },
        {
          num: 22,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 23,
          name: "PA0",
          kind: "io"
        },
        {
          num: 24,
          name: "PA1",
          kind: "io"
        },
        {
          num: 25,
          name: "PA2",
          kind: "io"
        },
        {
          num: 26,
          name: "PA3",
          kind: "io"
        },
        {
          num: 27,
          name: "VSS",
          kind: "power"
        },
        {
          num: 28,
          name: "VDD",
          kind: "power"
        },
        {
          num: 29,
          name: "PA4",
          kind: "io"
        },
        {
          num: 30,
          name: "PA5",
          kind: "io"
        },
        {
          num: 31,
          name: "PA6",
          kind: "io"
        },
        {
          num: 32,
          name: "PA7",
          kind: "io"
        },
        {
          num: 33,
          name: "PC4",
          kind: "io"
        },
        {
          num: 34,
          name: "PC5",
          kind: "io"
        },
        {
          num: 35,
          name: "PB0",
          kind: "io"
        },
        {
          num: 36,
          name: "PB1",
          kind: "io"
        },
        {
          num: 37,
          name: "PB2",
          kind: "io"
        },
        {
          num: 38,
          name: "PE8",
          kind: "io"
        },
        {
          num: 39,
          name: "PE9",
          kind: "io"
        },
        {
          num: 40,
          name: "VDDK",
          kind: "power"
        },
        {
          num: 41,
          name: "VSS",
          kind: "power"
        },
        {
          num: 42,
          name: "MDIRN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 43,
          name: "MDIRP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 44,
          name: "MDITN",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 45,
          name: "MDITP",
          kind: "power",
          note: "\u4EE5\u592A\u7F51 PHY \u5185\u90E8\u5DEE\u5206\u5BF9\uFF0C\u4E0D\u5F15\u51FA\u5230\u5916\u90E8"
        },
        {
          num: 46,
          name: "VDD",
          kind: "power"
        },
        {
          num: 47,
          name: "VSS",
          kind: "power"
        },
        {
          num: 48,
          name: "PE7",
          kind: "io"
        },
        {
          num: 49,
          name: "PB10",
          kind: "io"
        },
        {
          num: 50,
          name: "PB11",
          kind: "io"
        },
        {
          num: 51,
          name: "PD8",
          kind: "io"
        },
        {
          num: 52,
          name: "PB12",
          kind: "io"
        },
        {
          num: 53,
          name: "PB13",
          kind: "io"
        },
        {
          num: 54,
          name: "PB14",
          kind: "io"
        },
        {
          num: 55,
          name: "PB15",
          kind: "io"
        },
        {
          num: 56,
          name: "PD9",
          kind: "io"
        },
        {
          num: 57,
          name: "PD10",
          kind: "io"
        },
        {
          num: 58,
          name: "PD11",
          kind: "io"
        },
        {
          num: 59,
          name: "PD12",
          kind: "io"
        },
        {
          num: 60,
          name: "PD13",
          kind: "io"
        },
        {
          num: 61,
          name: "PD14",
          kind: "io"
        },
        {
          num: 62,
          name: "PD15",
          kind: "io"
        },
        {
          num: 63,
          name: "PC6",
          kind: "io"
        },
        {
          num: 64,
          name: "PC7",
          kind: "io"
        },
        {
          num: 65,
          name: "PC8",
          kind: "io"
        },
        {
          num: 66,
          name: "PC9",
          kind: "io"
        },
        {
          num: 67,
          name: "PA8",
          kind: "io"
        },
        {
          num: 68,
          name: "PA9",
          kind: "io"
        },
        {
          num: 69,
          name: "PA10",
          kind: "io"
        },
        {
          num: 70,
          name: "PA11",
          kind: "io"
        },
        {
          num: 71,
          name: "PA12",
          kind: "io"
        },
        {
          num: 72,
          name: "PA13",
          kind: "io"
        },
        {
          num: 73,
          name: "PE10",
          kind: "io"
        },
        {
          num: 74,
          name: "PE11",
          kind: "io"
        },
        {
          num: 75,
          name: "VDD",
          kind: "power"
        },
        {
          num: 76,
          name: "PA14",
          kind: "io"
        },
        {
          num: 77,
          name: "PA15",
          kind: "io"
        },
        {
          num: 78,
          name: "PC10",
          kind: "io"
        },
        {
          num: 79,
          name: "PC11",
          kind: "io"
        },
        {
          num: 80,
          name: "PC12",
          kind: "io"
        },
        {
          num: 81,
          name: "PD0",
          kind: "io"
        },
        {
          num: 82,
          name: "PD1",
          kind: "io"
        },
        {
          num: 83,
          name: "PD2",
          kind: "io"
        },
        {
          num: 84,
          name: "PD3",
          kind: "io"
        },
        {
          num: 85,
          name: "PD4",
          kind: "io"
        },
        {
          num: 86,
          name: "PD5",
          kind: "io"
        },
        {
          num: 87,
          name: "PD6",
          kind: "io"
        },
        {
          num: 88,
          name: "PD7",
          kind: "io"
        },
        {
          num: 89,
          name: "PB3",
          kind: "io"
        },
        {
          num: 90,
          name: "PB4",
          kind: "io"
        },
        {
          num: 91,
          name: "PB5",
          kind: "io"
        },
        {
          num: 92,
          name: "PB6",
          kind: "io"
        },
        {
          num: 93,
          name: "PB7",
          kind: "io"
        },
        {
          num: 94,
          name: "PE12",
          kind: "io"
        },
        {
          num: 95,
          name: "PB8",
          kind: "io"
        },
        {
          num: 96,
          name: "PB9",
          kind: "io"
        },
        {
          num: 97,
          name: "PE0",
          kind: "io"
        },
        {
          num: 98,
          name: "PE1",
          kind: "io"
        },
        {
          num: 99,
          name: "VSS",
          kind: "power"
        },
        {
          num: 100,
          name: "VDD",
          kind: "power"
        }
      ]
    }
  ],
  ports: {
    PA0: [
      {
        fn: "TIM2_CH1"
      },
      {
        fn: "TIM2_ETR",
        remap: "2"
      },
      {
        fn: "TIM2_ETR"
      },
      {
        fn: "TIM2_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_ETR"
      },
      {
        fn: "TIM8_ETR",
        remap: "1"
      },
      {
        fn: "USART2_CTS"
      }
    ],
    PA1: [
      {
        fn: "TIM2_CH2"
      },
      {
        fn: "TIM5_CH2"
      },
      {
        fn: "LTDC_R4",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "2"
      },
      {
        fn: "USART2_RTS"
      }
    ],
    PA10: [
      {
        fn: "DVP_D1"
      },
      {
        fn: "TIM1_CH3"
      },
      {
        fn: "USART1_RX"
      },
      {
        fn: "USART7_RX",
        remap: "3"
      },
      {
        fn: "TIM1_CH3",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "2"
      },
      {
        fn: "USART7_RX",
        remap: "2"
      }
    ],
    PA11: [
      {
        fn: "TIM1_CH4"
      },
      {
        fn: "USART1_CTS"
      },
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "1"
      },
      {
        fn: "CAN1_RX"
      }
    ],
    PA12: [
      {
        fn: "CAN1_TX"
      },
      {
        fn: "USBHS1_DP"
      },
      {
        fn: "USART1_RTS",
        remap: "1"
      },
      {
        fn: "TIM1_ETR"
      },
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "USART1_RTS"
      }
    ],
    PA13: [
      {
        fn: "LTDC_B5"
      },
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "USART4_CTS"
      },
      {
        fn: "USART3_TX",
        remap: "2"
      },
      {
        fn: "USART6_CK",
        remap: "2"
      },
      {
        fn: "TIM8_CH1N",
        remap: "1"
      }
    ],
    PA14: [
      {
        fn: "LTDC_B6"
      },
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "USART6_CTS",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "2"
      },
      {
        fn: "USART8_TX",
        remap: "1"
      }
    ],
    PA15: [
      {
        fn: "ARGB_OUT"
      },
      {
        fn: "I2S3_WS"
      },
      {
        fn: "LTDC_B7"
      },
      {
        fn: "SPI3_NSS"
      },
      {
        fn: "TIM2_ETR",
        remap: "3"
      },
      {
        fn: "TIM2_ETR",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "TIM2_CH1",
        remap: "3"
      },
      {
        fn: "TIM8_CH3N",
        remap: "1"
      },
      {
        fn: "USART6_RTS",
        remap: "2"
      },
      {
        fn: "USART8_RX",
        remap: "1"
      },
      {
        fn: "SPI1_NSS",
        remap: "1"
      }
    ],
    PA2: [
      {
        fn: "TIM5_CH3"
      },
      {
        fn: "USART2_TX"
      },
      {
        fn: "TIM2_CH3",
        remap: "1"
      },
      {
        fn: "TIM2_CH3"
      }
    ],
    PA3: [
      {
        fn: "TIM5_CH4"
      },
      {
        fn: "USART2_RX"
      },
      {
        fn: "LTDC_R6",
        remap: "1"
      },
      {
        fn: "TIM2_CH4"
      },
      {
        fn: "TIM2_CH4",
        remap: "1"
      }
    ],
    PA4: [
      {
        fn: "SPI1_NSS"
      },
      {
        fn: "USART2_CK"
      },
      {
        fn: "I2S3_WS",
        remap: "1"
      },
      {
        fn: "USART9_TX",
        remap: "1"
      },
      {
        fn: "SPI3_NSS",
        remap: "1"
      }
    ],
    PA5: [
      {
        fn: "DVP_VSYNC"
      },
      {
        fn: "SPI1_SCK"
      },
      {
        fn: "USART6_CK",
        remap: "3"
      },
      {
        fn: "USART1_CK",
        remap: "3"
      },
      {
        fn: "USART1_CTS",
        remap: "2"
      },
      {
        fn: "USART9_RX",
        remap: "1"
      }
    ],
    PA6: [
      {
        fn: "SPI1_MISO"
      },
      {
        fn: "TIM3_CH1"
      },
      {
        fn: "USART7_TX",
        remap: "1"
      },
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "TIM8_BKIN"
      },
      {
        fn: "USART1_TX",
        remap: "3"
      }
    ],
    PA7: [
      {
        fn: "TIM3_CH2"
      },
      {
        fn: "USART8_CK"
      },
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "TIM1_CH4",
        remap: "3"
      },
      {
        fn: "TIM8_CH1N"
      },
      {
        fn: "USART1_RX",
        remap: "3"
      },
      {
        fn: "USART7_RX",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI"
      }
    ],
    PA8: [
      {
        fn: "I2S3_MCK"
      },
      {
        fn: "USART1_CK"
      },
      {
        fn: "USART7_CK",
        remap: "2"
      },
      {
        fn: "TIM1_CH1"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "USART1_CK",
        remap: "1"
      },
      {
        fn: "USART1_RX",
        remap: "2"
      },
      {
        fn: "USART7_CK",
        remap: "3"
      }
    ],
    PA9: [
      {
        fn: "TIM1_CH2"
      },
      {
        fn: "USART1_TX"
      },
      {
        fn: "USART7_TX",
        remap: "3"
      },
      {
        fn: "TIM1_CH2",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "2"
      },
      {
        fn: "USART7_TX",
        remap: "2"
      }
    ],
    PB0: [
      {
        fn: "TIM3_CH3"
      },
      {
        fn: "USART6_CK"
      },
      {
        fn: "USART5_CTS",
        remap: "2"
      },
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "TIM3_CH3",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N"
      },
      {
        fn: "USART4_TX",
        remap: "1"
      },
      {
        fn: "USART5_CTS",
        remap: "3"
      },
      {
        fn: "USART7_CK",
        remap: "1"
      },
      {
        fn: "USART8_CTS"
      }
    ],
    PB1: [
      {
        fn: "OPA1_OUT2"
      },
      {
        fn: "TIM8_CH3N"
      },
      {
        fn: "USART8_RTS"
      },
      {
        fn: "USART4_RX",
        remap: "1"
      },
      {
        fn: "USART5_RTS",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "TIM3_CH4"
      },
      {
        fn: "TIM3_CH4",
        remap: "2"
      },
      {
        fn: "USART5_RTS",
        remap: "3"
      },
      {
        fn: "USART9_TX"
      }
    ],
    PB10: [
      {
        fn: "I3C1_SCL"
      },
      {
        fn: "LTDC_B3"
      },
      {
        fn: "USART3_TX"
      },
      {
        fn: "TIM2_CH3",
        remap: "2"
      },
      {
        fn: "TIM2_CH3",
        remap: "3"
      },
      {
        fn: "TIM1_BKIN",
        remap: "3"
      }
    ],
    PB11: [
      {
        fn: "FSMC_D9"
      },
      {
        fn: "LTDC_B2"
      },
      {
        fn: "USART8_CK",
        remap: "3"
      },
      {
        fn: "TIM2_CH4",
        remap: "2"
      },
      {
        fn: "TIM2_CH4",
        remap: "3"
      },
      {
        fn: "USART3_RX"
      },
      {
        fn: "USART8_CK",
        remap: "2"
      }
    ],
    PB12: [
      {
        fn: "FSMC_D10"
      },
      {
        fn: "I2S2_WS"
      },
      {
        fn: "SPI2_NSS"
      },
      {
        fn: "USART3_CK"
      },
      {
        fn: "LTDC_G6",
        remap: "1"
      },
      {
        fn: "USART8_RTS",
        remap: "3"
      },
      {
        fn: "TIM1_BKIN"
      },
      {
        fn: "USART8_RTS",
        remap: "2"
      }
    ],
    PB13: [
      {
        fn: "I2S2_CK"
      },
      {
        fn: "SPI2_SCK"
      },
      {
        fn: "USART3_CTS"
      },
      {
        fn: "USART8_CTS",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N"
      },
      {
        fn: "USART3_CTS",
        remap: "1"
      },
      {
        fn: "USART8_CTS",
        remap: "2"
      }
    ],
    PB14: [
      {
        fn: "FSMC_D12"
      },
      {
        fn: "SPI2_MISO"
      },
      {
        fn: "USART3_RTS"
      },
      {
        fn: "LTDC_B0",
        remap: "1"
      },
      {
        fn: "USART8_RX",
        remap: "3"
      },
      {
        fn: "TIM1_CH2N"
      },
      {
        fn: "USART3_RTS",
        remap: "1"
      },
      {
        fn: "USART8_RX",
        remap: "2"
      }
    ],
    PB15: [
      {
        fn: "I2S2_SD"
      },
      {
        fn: "SDIO_D1"
      },
      {
        fn: "USART8_CK",
        remap: "1"
      },
      {
        fn: "USART8_TX",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N"
      },
      {
        fn: "USART1_TX",
        remap: "2"
      },
      {
        fn: "USART8_TX",
        remap: "3"
      }
    ],
    PB2: [
      {
        fn: "LTDC_G4"
      },
      {
        fn: "USART9_RX"
      },
      {
        fn: "USART5_CK",
        remap: "2"
      },
      {
        fn: "USART4_CK",
        remap: "1"
      },
      {
        fn: "USART5_CK",
        remap: "3"
      }
    ],
    PB3: [
      {
        fn: "I2S3_CK"
      },
      {
        fn: "SPI3_SCK"
      },
      {
        fn: "DVP_D5",
        remap: "1"
      },
      {
        fn: "LTDC_G4",
        remap: "1"
      },
      {
        fn: "SPI1_SCK",
        remap: "1"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "USART5_CK",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "TIM2_CH2",
        remap: "3"
      },
      {
        fn: "USART5_CTS"
      }
    ],
    PB4: [
      {
        fn: "SPI3_MISO"
      },
      {
        fn: "DVP_D3",
        remap: "1"
      },
      {
        fn: "I3C1_SCL",
        remap: "1"
      },
      {
        fn: "SPI1_MISO",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "USART5_TX",
        remap: "1"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "USART5_RTS"
      }
    ],
    PB5: [
      {
        fn: "I2C1_SMBA"
      },
      {
        fn: "SPI3_MOSI"
      },
      {
        fn: "DVP_D10",
        remap: "1"
      },
      {
        fn: "I3C1_SDA",
        remap: "1"
      },
      {
        fn: "SPI1_MOSI",
        remap: "1"
      },
      {
        fn: "USART5_RX",
        remap: "1"
      },
      {
        fn: "USART6_CK",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "USART5_CK"
      },
      {
        fn: "I2S3_SD"
      }
    ],
    PB6: [
      {
        fn: "DVP_D5"
      },
      {
        fn: "I2C1_SCL"
      },
      {
        fn: "TIM4_CH1"
      },
      {
        fn: "USBHS2_DM"
      },
      {
        fn: "FSMC_NADV",
        remap: "1"
      },
      {
        fn: "TIM8_CH1",
        remap: "1"
      },
      {
        fn: "TIM8_CH2",
        remap: "1"
      },
      {
        fn: "USART1_TX",
        remap: "1"
      },
      {
        fn: "USART7_CTS",
        remap: "2"
      }
    ],
    PB7: [
      {
        fn: "FSMC_NADV"
      },
      {
        fn: "I2C1_SDA"
      },
      {
        fn: "TIM4_CH2"
      },
      {
        fn: "USBHS2_DP"
      },
      {
        fn: "FSMC_NADV",
        remap: "1"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "USART1_RX",
        remap: "1"
      },
      {
        fn: "USART7_RTS",
        remap: "2"
      },
      {
        fn: "TIM8_CH2",
        remap: "1"
      }
    ],
    PB8: [
      {
        fn: "DVP_D6"
      },
      {
        fn: "TIM8_CH3",
        remap: "1"
      },
      {
        fn: "TIM1_CH3",
        remap: "3"
      },
      {
        fn: "TIM4_CH3"
      },
      {
        fn: "USART4_CTS",
        remap: "2"
      },
      {
        fn: "USART4_CTS",
        remap: "3"
      },
      {
        fn: "USART5_CTS",
        remap: "1"
      },
      {
        fn: "USART6_TX",
        remap: "1"
      },
      {
        fn: "USART10_TX",
        remap: "1"
      },
      {
        fn: "I2C1_SCL",
        remap: "1"
      },
      {
        fn: "CAN1_RX",
        remap: "2"
      }
    ],
    PB9: [
      {
        fn: "FSMC_D11"
      },
      {
        fn: "LTDC_B4"
      },
      {
        fn: "SDIO_D1"
      },
      {
        fn: "SPI2_NSS",
        remap: "1"
      },
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "USART10_RX",
        remap: "2"
      },
      {
        fn: "TIM4_CH4"
      },
      {
        fn: "TIM8_BKIN",
        remap: "1"
      },
      {
        fn: "USART4_RTS",
        remap: "2"
      },
      {
        fn: "USART4_RTS",
        remap: "3"
      },
      {
        fn: "USART5_RTS",
        remap: "1"
      },
      {
        fn: "USART6_RX",
        remap: "1"
      },
      {
        fn: "USART10_RX",
        remap: "1"
      },
      {
        fn: "I2C1_SDA",
        remap: "1"
      },
      {
        fn: "CAN1_TX",
        remap: "2"
      }
    ],
    PC0: [
      {
        fn: "ADC1_IN10"
      },
      {
        fn: "LTDC_R0"
      },
      {
        fn: "USART6_TX"
      },
      {
        fn: "LTDC_R0",
        remap: "1"
      },
      {
        fn: "USART6_TX",
        remap: "3"
      }
    ],
    PC1: [
      {
        fn: "ADC1_IN11"
      },
      {
        fn: "USART6_RX"
      },
      {
        fn: "USART6_RX",
        remap: "3"
      },
      {
        fn: "USART7_CK"
      }
    ],
    PC10: [
      {
        fn: "DVP_D8"
      },
      {
        fn: "SDIO_D2"
      },
      {
        fn: "USART4_TX"
      },
      {
        fn: "I2S3_CK",
        remap: "1"
      },
      {
        fn: "USART3_TX",
        remap: "1"
      },
      {
        fn: "SPI3_SCK",
        remap: "1"
      }
    ],
    PC11: [
      {
        fn: "DVP_D4"
      },
      {
        fn: "SDIO_D3"
      },
      {
        fn: "USART4_RX"
      },
      {
        fn: "SDIO_D3",
        remap: "1"
      },
      {
        fn: "SPI3_MISO",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "1"
      }
    ],
    PC12: [
      {
        fn: "USART5_TX"
      },
      {
        fn: "I2S3_SD",
        remap: "1"
      },
      {
        fn: "USART3_CK",
        remap: "1"
      },
      {
        fn: "USART4_CK"
      },
      {
        fn: "SPI3_MOSI",
        remap: "1"
      }
    ],
    PC13: [
      {
        fn: "TIM8_CH4",
        remap: "1"
      }
    ],
    PC14: [
      {
        fn: "OSC32_IN"
      },
      {
        fn: "USART10_CTS"
      },
      {
        fn: "USART10_CTS",
        remap: "1"
      }
    ],
    PC15: [
      {
        fn: "OSC32_OUT"
      },
      {
        fn: "USART10_RTS"
      },
      {
        fn: "USART10_RTS",
        remap: "1"
      }
    ],
    PC2: [
      {
        fn: "USART6_CTS"
      },
      {
        fn: "LTDC_R2",
        remap: "1"
      },
      {
        fn: "USART6_CTS",
        remap: "3"
      },
      {
        fn: "USART7_TX"
      }
    ],
    PC3: [
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "USART6_RTS"
      },
      {
        fn: "USART6_RTS",
        remap: "3"
      },
      {
        fn: "USART7_RX"
      }
    ],
    PC4: [
      {
        fn: "USART7_CTS"
      },
      {
        fn: "USART7_CTS",
        remap: "1"
      },
      {
        fn: "USART1_CTS",
        remap: "3"
      },
      {
        fn: "USART4_CTS",
        remap: "1"
      },
      {
        fn: "USART8_TX"
      }
    ],
    PC5: [
      {
        fn: "ADC1_IN15"
      },
      {
        fn: "USART7_RTS"
      },
      {
        fn: "USART4_RTS",
        remap: "1"
      },
      {
        fn: "USART1_RTS",
        remap: "3"
      },
      {
        fn: "USART7_RTS",
        remap: "1"
      },
      {
        fn: "USART8_RX"
      }
    ],
    PC6: [
      {
        fn: "I2S2_MCK"
      },
      {
        fn: "SDIO_D6"
      },
      {
        fn: "TIM8_CH1"
      },
      {
        fn: "TIM3_CH1",
        remap: "3"
      }
    ],
    PC7: [
      {
        fn: "I2S3_MCK"
      },
      {
        fn: "TIM8_CH2"
      },
      {
        fn: "TIM3_CH2",
        remap: "3"
      },
      {
        fn: "I2S3_MCK",
        remap: "1"
      }
    ],
    PC8: [
      {
        fn: "DVP_D2"
      },
      {
        fn: "SDIO_D0"
      },
      {
        fn: "USART7_CTS",
        remap: "3"
      },
      {
        fn: "TIM3_CH3",
        remap: "3"
      },
      {
        fn: "TIM8_CH3"
      }
    ],
    PC9: [
      {
        fn: "TIM8_CH4"
      },
      {
        fn: "TIM3_CH4",
        remap: "3"
      },
      {
        fn: "USART7_RTS",
        remap: "3"
      }
    ],
    PD0: [
      {
        fn: "FSMC_D2"
      },
      {
        fn: "CAN1_RX",
        remap: "3"
      },
      {
        fn: "FSMC_D2",
        remap: "1"
      }
    ],
    PD1: [
      {
        fn: "FSMC_D3"
      },
      {
        fn: "FSMC_D3",
        remap: "1"
      },
      {
        fn: "CAN1_TX",
        remap: "3"
      }
    ],
    PD10: [
      {
        fn: "FSMC_D15"
      },
      {
        fn: "USART10_CK",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "2"
      },
      {
        fn: "USART3_CK",
        remap: "3"
      },
      {
        fn: "USART10_CK",
        remap: "3"
      }
    ],
    PD11: [
      {
        fn: "FSMC_A16"
      },
      {
        fn: "USART10_TX",
        remap: "2"
      },
      {
        fn: "USART3_CTS",
        remap: "2"
      },
      {
        fn: "USART3_CTS",
        remap: "3"
      },
      {
        fn: "USART10_TX",
        remap: "3"
      }
    ],
    PD12: [
      {
        fn: "FSMC_A17"
      },
      {
        fn: "USART10_RX",
        remap: "2"
      },
      {
        fn: "TIM4_CH1",
        remap: "1"
      },
      {
        fn: "USART3_RTS",
        remap: "2"
      },
      {
        fn: "USART3_RTS",
        remap: "3"
      },
      {
        fn: "USART10_RX",
        remap: "3"
      }
    ],
    PD13: [
      {
        fn: "FSMC_A18"
      },
      {
        fn: "USART10_CTS",
        remap: "2"
      },
      {
        fn: "TIM4_CH2",
        remap: "1"
      },
      {
        fn: "USART10_CTS",
        remap: "3"
      }
    ],
    PD14: [
      {
        fn: "FSMC_D0"
      },
      {
        fn: "USART10_RTS",
        remap: "3"
      },
      {
        fn: "TIM4_CH3",
        remap: "1"
      },
      {
        fn: "USART10_RTS",
        remap: "2"
      }
    ],
    PD15: [
      {
        fn: "FSMC_D1"
      },
      {
        fn: "TIM4_CH4",
        remap: "1"
      }
    ],
    PD2: [
      {
        fn: "SDIO_CMD"
      },
      {
        fn: "USART5_RX"
      },
      {
        fn: "SDIO_CMD",
        remap: "1"
      },
      {
        fn: "TIM3_ETR"
      },
      {
        fn: "TIM3_ETR",
        remap: "2"
      },
      {
        fn: "TIM3_ETR",
        remap: "3"
      },
      {
        fn: "USART4_RTS"
      }
    ],
    PD3: [
      {
        fn: "FSMC_CLK"
      },
      {
        fn: "FSMC_CLK",
        remap: "1"
      },
      {
        fn: "USART2_CTS",
        remap: "1"
      }
    ],
    PD4: [
      {
        fn: "FSMC_NOE"
      },
      {
        fn: "USART2_RTS",
        remap: "1"
      }
    ],
    PD5: [
      {
        fn: "FSMC_NWE"
      },
      {
        fn: "FSMC_NWE",
        remap: "1"
      },
      {
        fn: "USART2_TX",
        remap: "1"
      }
    ],
    PD6: [
      {
        fn: "DVP_D10"
      },
      {
        fn: "FSMC_NWAIT"
      },
      {
        fn: "FSMC_NWAIT",
        remap: "1"
      },
      {
        fn: "USART2_RX",
        remap: "1"
      }
    ],
    PD7: [
      {
        fn: "FSMC_NCE2"
      },
      {
        fn: "FSMC_NE1"
      },
      {
        fn: "FSMC_NE1",
        remap: "1"
      },
      {
        fn: "USART2_CK",
        remap: "1"
      }
    ],
    PD8: [
      {
        fn: "FSMC_D13"
      },
      {
        fn: "LTDC_G5"
      },
      {
        fn: "USART9_CK"
      },
      {
        fn: "USART9_CK",
        remap: "1"
      },
      {
        fn: "USART3_TX",
        remap: "3"
      }
    ],
    PD9: [
      {
        fn: "FSMC_D14"
      },
      {
        fn: "FSMC_D14",
        remap: "1"
      },
      {
        fn: "USART3_RX",
        remap: "3"
      }
    ],
    PE0: [
      {
        fn: "FSMC_NBL0"
      },
      {
        fn: "USART10_TX"
      },
      {
        fn: "TIM4_ETR",
        remap: "1"
      },
      {
        fn: "USART4_TX",
        remap: "2"
      },
      {
        fn: "TIM4_ETR"
      },
      {
        fn: "USART4_TX",
        remap: "3"
      },
      {
        fn: "USART6_CTS",
        remap: "1"
      }
    ],
    PE1: [
      {
        fn: "FSMC_NBL1"
      },
      {
        fn: "USART10_RX"
      },
      {
        fn: "USART4_RX",
        remap: "2"
      },
      {
        fn: "USART4_RX",
        remap: "3"
      },
      {
        fn: "USART6_RTS",
        remap: "1"
      }
    ],
    PE10: [
      {
        fn: "FSMC_D7"
      },
      {
        fn: "USART8_CTS",
        remap: "1"
      },
      {
        fn: "TIM1_CH2N",
        remap: "3"
      },
      {
        fn: "USART6_TX",
        remap: "2"
      }
    ],
    PE11: [
      {
        fn: "FSMC_D8"
      },
      {
        fn: "USART6_RX",
        remap: "2"
      },
      {
        fn: "TIM1_CH2",
        remap: "3"
      },
      {
        fn: "USART8_RTS",
        remap: "1"
      }
    ],
    PE12: [
      {
        fn: "USART10_CK"
      },
      {
        fn: "USART4_CK",
        remap: "2"
      },
      {
        fn: "TIM1_CH3N",
        remap: "3"
      },
      {
        fn: "USART4_CK",
        remap: "3"
      },
      {
        fn: "USART10_CK",
        remap: "1"
      }
    ],
    PE2: [
      {
        fn: "FSMC_A23"
      },
      {
        fn: "USART9_CK",
        remap: "3"
      },
      {
        fn: "USART9_CK",
        remap: "2"
      }
    ],
    PE3: [
      {
        fn: "FSMC_A19"
      },
      {
        fn: "USART9_TX",
        remap: "3"
      },
      {
        fn: "USART9_TX",
        remap: "2"
      }
    ],
    PE4: [
      {
        fn: "FSMC_A20"
      },
      {
        fn: "USART9_RX",
        remap: "3"
      },
      {
        fn: "USART9_RX",
        remap: "2"
      }
    ],
    PE5: [
      {
        fn: "FSMC_A21"
      },
      {
        fn: "USART9_CTS",
        remap: "3"
      },
      {
        fn: "USART9_CTS",
        remap: "2"
      }
    ],
    PE6: [
      {
        fn: "FSMC_A22"
      },
      {
        fn: "USART9_RTS",
        remap: "3"
      },
      {
        fn: "USART9_RTS",
        remap: "2"
      }
    ],
    PE7: [
      {
        fn: "FSMC_D4"
      },
      {
        fn: "TIM1_ETR",
        remap: "3"
      }
    ],
    PE8: [
      {
        fn: "FSMC_D5"
      },
      {
        fn: "USART9_CTS"
      },
      {
        fn: "USART5_TX",
        remap: "3"
      },
      {
        fn: "TIM1_CH1N",
        remap: "3"
      },
      {
        fn: "USART5_TX",
        remap: "2"
      },
      {
        fn: "USART9_CTS",
        remap: "1"
      }
    ],
    PE9: [
      {
        fn: "FSMC_D6"
      },
      {
        fn: "USART9_RTS"
      },
      {
        fn: "TIM1_CH1",
        remap: "3"
      },
      {
        fn: "USART5_RX",
        remap: "3"
      },
      {
        fn: "USART9_RTS",
        remap: "1"
      },
      {
        fn: "USART5_RX",
        remap: "2"
      }
    ]
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN1",
        "IN10",
        "IN11",
        "IN12",
        "IN13",
        "IN14",
        "IN15",
        "IN2",
        "IN3",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9"
      ]
    },
    {
      id: "ARGB",
      signals: [
        "OUT"
      ]
    },
    {
      id: "CAN1",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "DAC2",
      signals: [
        "OUT"
      ]
    },
    {
      id: "DVP",
      signals: [
        "D0",
        "D1",
        "D10",
        "D11",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7",
        "D8",
        "D9",
        "HSYNC",
        "VSYNC"
      ]
    },
    {
      id: "FSMC",
      signals: [
        "A16",
        "A17",
        "A18",
        "A19",
        "A20",
        "A21",
        "A22",
        "A23",
        "CLK",
        "D0",
        "D1",
        "D10",
        "D11",
        "D12",
        "D13",
        "D14",
        "D15",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7",
        "D8",
        "D9",
        "NADV",
        "NBL0",
        "NBL1",
        "NCE2",
        "NE1",
        "NOE",
        "NWAIT",
        "NWE"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA",
        "SMBA"
      ]
    },
    {
      id: "I2S2",
      signals: [
        "CK",
        "MCK",
        "SD",
        "WS"
      ]
    },
    {
      id: "I2S3",
      signals: [
        "CK",
        "MCK",
        "SD",
        "WS"
      ]
    },
    {
      id: "I3C1",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "LTDC",
      signals: [
        "B0",
        "B1",
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "CLK",
        "DE",
        "G0",
        "G1",
        "G2",
        "G3",
        "G4",
        "G5",
        "G6",
        "G7",
        "HSYNC",
        "R0",
        "R1",
        "R2",
        "R3",
        "R4",
        "R5",
        "R6",
        "R7",
        "VSYNC"
      ]
    },
    {
      id: "OPA1",
      signals: [
        "N1",
        "N2",
        "OUT1",
        "OUT2",
        "P1",
        "P2"
      ]
    },
    {
      id: "OSC32",
      signals: [
        "IN",
        "OUT"
      ]
    },
    {
      id: "SDIO",
      signals: [
        "CK",
        "CMD",
        "D0",
        "D1",
        "D2",
        "D3",
        "D4",
        "D5",
        "D6",
        "D7"
      ]
    },
    {
      id: "SPI1",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI2",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI3",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM4",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM5",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4"
      ]
    },
    {
      id: "TIM8",
      signals: [
        "BKIN",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART10",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART4",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART5",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART6",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART7",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART8",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART9",
      signals: [
        "CK",
        "CTS",
        "RTS",
        "RX",
        "TX"
      ]
    },
    {
      id: "USBHS1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "USBHS2",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "GPIO",
      signals: []
    },
    {
      id: "SYSTEM",
      signals: []
    },
    {
      id: "DBG",
      signals: [
        "SWCLK",
        "SWDIO"
      ]
    },
    {
      id: "PWR",
      signals: []
    },
    {
      id: "EXTI",
      signals: []
    },
    {
      id: "DMA",
      signals: []
    },
    {
      id: "IWDG",
      signals: []
    },
    {
      id: "WWDG",
      signals: []
    },
    {
      id: "CRC",
      signals: []
    },
    {
      id: "RTC",
      signals: []
    },
    {
      id: "FLASH",
      signals: []
    }
  ],
  irqs: [
    {
      n: 16,
      name: "WWDG",
      owner: "WWDG"
    },
    {
      n: 17,
      name: "PVD",
      owner: "PWR"
    },
    {
      n: 18,
      name: "TAMPER",
      owner: "PWR"
    },
    {
      n: 19,
      name: "RTC",
      owner: "RTC",
      gate: "irqAlarm"
    },
    {
      n: 20,
      name: "FLASH",
      owner: "FLASH"
    },
    {
      n: 21,
      name: "RCC",
      owner: "SYSTEM"
    },
    {
      n: 22,
      name: "EXTI0",
      owner: "EXTI"
    },
    {
      n: 23,
      name: "EXTI1",
      owner: "EXTI"
    },
    {
      n: 24,
      name: "EXTI2",
      owner: "EXTI"
    },
    {
      n: 25,
      name: "EXTI3",
      owner: "EXTI"
    },
    {
      n: 26,
      name: "EXTI4",
      owner: "EXTI"
    },
    {
      n: 34,
      name: "ADC1_2",
      owner: "ADC1",
      gate: "irqEoc"
    },
    {
      n: 35,
      name: "CAN1_TX",
      owner: "CAN1"
    },
    {
      n: 36,
      name: "CAN1_RX0",
      owner: "CAN1"
    },
    {
      n: 37,
      name: "CAN1_RX1",
      owner: "CAN1"
    },
    {
      n: 38,
      name: "CAN1_SCE",
      owner: "CAN1"
    },
    {
      n: 39,
      name: "EXTI9_5",
      owner: "EXTI"
    },
    {
      n: 40,
      name: "TIM1_BRK",
      owner: "TIM1",
      gate: "irqBreak"
    },
    {
      n: 41,
      name: "TIM1_UP",
      owner: "TIM1",
      gate: "irqUpdate"
    },
    {
      n: 42,
      name: "TIM1_TRG_COM",
      owner: "TIM1",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 43,
      name: "TIM1_CC",
      owner: "TIM1",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 44,
      name: "TIM2",
      owner: "TIM2",
      gate: "irqUpdate"
    },
    {
      n: 45,
      name: "TIM3",
      owner: "TIM3",
      gate: "irqUpdate"
    },
    {
      n: 46,
      name: "TIM4",
      owner: "TIM4",
      gate: "irqUpdate"
    },
    {
      n: 47,
      name: "I2C1_EV",
      owner: "I2C1",
      gate: "irqEvt"
    },
    {
      n: 48,
      name: "I2C1_ER",
      owner: "I2C1",
      gate: "irqErr"
    },
    {
      n: 49,
      name: "I3C_EV",
      owner: "I3C"
    },
    {
      n: 50,
      name: "I3C_ER",
      owner: "I3C"
    },
    {
      n: 51,
      name: "SPI1",
      owner: "SPI1"
    },
    {
      n: 52,
      name: "SPI2",
      owner: "SPI2"
    },
    {
      n: 53,
      name: "USART1",
      owner: "USART1"
    },
    {
      n: 54,
      name: "USART2",
      owner: "USART2"
    },
    {
      n: 55,
      name: "USART3",
      owner: "USART3"
    },
    {
      n: 56,
      name: "EXTI15_10",
      owner: "EXTI"
    },
    {
      n: 57,
      name: "RTCAlarm",
      owner: "RTC",
      gate: "irqAlarm"
    },
    {
      n: 59,
      name: "TIM8_BRK",
      owner: "TIM8",
      gate: "irqBreak"
    },
    {
      n: 60,
      name: "TIM8_UP",
      owner: "TIM8",
      gate: "irqUpdate"
    },
    {
      n: 61,
      name: "TIM8_TRG_COM",
      owner: "TIM8",
      gate: [
        "irqUpdate",
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 62,
      name: "TIM8_CC",
      owner: "TIM8",
      gate: [
        "irqCC1",
        "irqCC2",
        "irqCC3",
        "irqCC4"
      ]
    },
    {
      n: 63,
      name: "RNG",
      owner: "RNG"
    },
    {
      n: 65,
      name: "SDIO",
      owner: "SDIO"
    },
    {
      n: 66,
      name: "TIM5",
      owner: "TIM5",
      gate: "irqUpdate"
    },
    {
      n: 67,
      name: "SPI3",
      owner: "SPI3"
    },
    {
      n: 68,
      name: "USART4",
      owner: "USART4"
    },
    {
      n: 69,
      name: "USART5",
      owner: "USART5"
    },
    {
      n: 70,
      name: "TIM6",
      owner: "TIM6",
      gate: "irqUpdate"
    },
    {
      n: 71,
      name: "TIM7",
      owner: "TIM7",
      gate: "irqUpdate"
    },
    {
      n: 77,
      name: "ETH",
      owner: "ETH"
    },
    {
      n: 78,
      name: "ETH_WKUP",
      owner: "ETH"
    },
    {
      n: 79,
      name: "LTDC",
      owner: "LTDC"
    }
  ],
  pending: [
    "packages/ports \u7531 scripts/rebuild_v407_from_ds.py \u4ECE DS0 \u88682-1-1 + RM 10.2.11 \u81EA\u52A8\u751F\u6210\uFF1Bremap \u5B57\u6BB5 = AFIO \u914D\u7F6E\u7EC4\u7F16\u53F7\uFF0800/01/10/11 \u2192 0/1/2/3\uFF09",
    "OSC_IN/OSC_OUT \u53EF\u7ECF AFIO \u6539\u4F5C PD0/PD1\uFF08DS0 \u6CE84\uFF09\uFF0C\u8FD9\u4E00\u5C42\u590D\u7528\u6CA1\u6709\u5EFA\u6A21 \u2014\u2014 GPIO \u76EE\u524D\u53EA\u6309\u5F15\u811A\u540D\u914D\uFF0C\u6CA1\u6709\u300CPD0 \u501F\u7528 OSC_IN \u811A\u300D\u7684\u5165\u53E3",
    "DS0 \u6CE86/7\uFF1ASDIO_D0/D1\u3001DVP_D5\u3001FSMC_NADV \u6709\u300CETH/SDIO/USB \u540C\u65F6\u5F00\u542F\u65F6\u81EA\u52A8\u6539\u811A\u300D\u7684\u6761\u4EF6\u91CD\u6620\u5C04\uFF0C\u5C1A\u672A\u5EFA\u6A21",
    "KEU6\uFF08QFN32\uFF09\u7684 pin 16 \u5728\u5F15\u811A\u8868\u91CC\u6CA1\u6709\u5BF9\u5E94\u884C\uFF0C\u5DF2\u6309 VDD \u8865\u9F50\uFF0C\u9700\u5BF9\u7167 DS0 \u5F15\u811A\u6392\u5217\u56FE\u786E\u8BA4",
    "TIM8_CH1N/CH2N/CH3N \u5728\u7EC41 \u843D\u5230 PA13/PA14/PA15\uFF0C\u4E0E 2 \u7EBF\u8C03\u8BD5\u53E3\u51B2\u7A81\uFF08\u786C\u4EF6\u4E8B\u5B9E\uFF0C\u4E0D\u662F\u6570\u636E\u9519\uFF09",
    "\u6E90\u8868\u7F3A\u8FD9\u51E0\u6761\u590D\u7528\u9879\uFF0C\u5BF9\u5E94\u5916\u8BBE\u56E0\u6B64\u8FDB\u300C\u5668\u4EF6\u6570\u636E\u5F85\u8865\u300D\uFF08\u5916\u8BBE\u6811\u5E95\u90E8\u7425\u73C0\u8272\u90A3\u884C\uFF09\uFF0C\u9700\u4ECE DS0 \u8865\uFF1ASPI2_MOSI\uFF08\u7591\u4E0E I2S2_SD \u540C\u811A PB15\uFF09\u3001USBHS1_DM\uFF08USBHS1 \u53EA\u5217\u4E86 DP=PA12\uFF09\u3001DAC2 \u5168\u90E8\u8F93\u51FA",
    "\u6E90\u8868\u5185\u90E8\u77DB\u76FE\uFF08\u540C\u4E00\u4FE1\u53F7\u7684\u540C\u4E00\u914D\u7F6E\u7EC4\u843D\u5230\u4E24\u4E2A\u5F15\u811A\uFF09\uFF0C\u4E0B\u5217\u6761\u76EE\u4EE5\u300C\u4E24\u8005\u90FD\u4FDD\u7559\u300D\u5904\u7406\uFF0C\u914D\u7F6E\u7EC4\u7F16\u53F7\u9700\u56DE\u67E5 DS0 \u539F\u8868\uFF1AFSMC_NADV \u7EC41=PB6/PB7\uFF1BI2S3_MCK \u7EC40=PA8/PC7\uFF1BSDIO_D1 \u7EC40=PB15/PB9\uFF1BTIM1_CH1 \u7EC41=PA8/PB9\uFF1BTIM1_CH3N \u7EC43=PB7/PE12\uFF1BTIM3_CH1 \u7EC42=PB3/PB4\uFF1BTIM3_CH2 \u7EC42=PB4/PB5\uFF1BTIM8_CH2 \u7EC41=PB6/PB7\uFF1BUSART10_RX \u7EC42=PB9/PD12",
    "ETH / LTDC / DVP / FSMC / SDIO / ARGB / I3C / USBHS \u53EA\u751F\u6210\u65F6\u949F\u4F7F\u80FD + TODO\uFF0C\u53C2\u6570\u5EFA\u6A21\u5F85\u8865",
    "DMA \u901A\u9053 \u2194 \u786C\u4EF6\u8BF7\u6C42\u6620\u5C04\u5F85\u4ECE RM\u300CDMA \u8BF7\u6C42\u6620\u5C04\u300D\u8865\u5F55\uFF1B\u5F53\u524D\u53EA\u6821\u9A8C\u901A\u9053\u4E0D\u91CD\u590D"
  ]
};

// src/core/devices/data/hc32f401b.json
var hc32f401b_default = {
  packVersion: "0.2.0",
  series: "HC32F401B",
  vendor: "HDSC",
  core: "Cortex-M4F",
  source: "HC32F401B \u6570\u636E\u624B\u518C Ver1.1.1 \u7B2C 4.2 \u8282\u300C\u5F15\u811A\u8BF4\u660E\u300D\uFF08\u7AEF\u53E3\u2011AF\u2011\u6A21\u62DF\u6620\u5C04\uFF09\uFF0B\u7528\u6237\u624B\u518C Ver1.0.14\uFF1B\u5C01\u88C5\u5F15\u811A\u5E8F\u53F7\u7531\u7AEF\u53E3\u8303\u56F4\u63A8\u5BFC\uFF0C\u975E\u7269\u7406\u5F15\u811A\u53F7",
  flashKb: 256,
  ramKb: 192,
  voltage: "1.8-3.6V",
  maxSysclk: 168,
  debug: {
    twoWire: true,
    singleWire: false,
    swdio: "PA13",
    swclk: "PA14"
  },
  sdkHeader: "hc32f4xx",
  backend: "generic",
  codegen: "disable",
  codegenNote: "HC32F401B \u76EE\u524D\u53EA\u5F55\u5165\u4E86\u5F15\u811A\u4E0E\u590D\u7528\u529F\u80FD\uFF0C\u5C1A\u65E0\u5B8C\u6574\u7684\u5BC4\u5B58\u5668/SDK \u8D44\u6599\uFF0C\u56E0\u6B64\u4E0D\u751F\u6210\u521D\u59CB\u5316\u4EE3\u7801\uFF1B\u5F15\u811A\u6620\u5C04\u8868\u4ECD\u53EF\u5BFC\u51FA\u3002",
  afGrouping: "independent",
  clock: {
    hsi: 16,
    hseOptions: [
      8,
      16,
      24
    ],
    lsi: 32.768,
    pllSource: "HSI_DIV2",
    pllMin: 2,
    pllMax: 63,
    maxSysclk: 168,
    apb1Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    apb2Divs: [
      1,
      2,
      4,
      8,
      16
    ],
    ahbDivs: [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512
    ],
    adcDivs: [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128
    ],
    notes: [
      "\u65F6\u949F\u6811\u53C2\u6570\u5F85\u6309\u7528\u6237\u624B\u518C\u6838\u5BF9\uFF1AHSI \u9891\u7387\u3001PLL \u8F93\u5165\u5206\u9891\u3001\u5404\u603B\u7EBF\u6700\u9AD8\u9891\u7387"
    ]
  },
  meta: {
    ADC1: {
      kind: "ADC",
      group: "Analog",
      schema: "ADC",
      brief: "12 \u4F4D\u9010\u6B21\u903C\u8FD1 ADC",
      label: "ADC1"
    },
    ADC2: {
      kind: "ADC",
      group: "Analog",
      schema: "ADC",
      brief: "12 \u4F4D\u9010\u6B21\u903C\u8FD1 ADC",
      label: "ADC2"
    },
    CAN1: {
      kind: "CAN",
      group: "Connectivity",
      schema: "CAN",
      brief: "CAN\u2011FD \u63A7\u5236\u5668",
      required: [
        "TX",
        "RX"
      ],
      label: "CAN1"
    },
    CLK: {
      kind: "CLK",
      group: "System",
      schema: "CLK",
      brief: "\u5916\u90E8\u6676\u632F\u4E0E\u65F6\u949F\u8F93\u51FA",
      label: "\u65F6\u949F\u6E90"
    },
    DAC1: {
      kind: "DAC",
      group: "Analog",
      schema: "DAC",
      brief: "12 \u4F4D\u7535\u538B\u8F93\u51FA DAC",
      required: [
        "OUT"
      ],
      label: "DAC1"
    },
    DBG: {
      kind: "DBG",
      group: "System",
      schema: "DBG",
      brief: "JTAG / SWD \u8C03\u8BD5\u53E3",
      required: [
        "SWDIO",
        "SWCLK"
      ],
      label: "DBG"
    },
    FDA0: {
      kind: "OPA",
      group: "Analog",
      schema: "FDA",
      brief: "\u5DEE\u5206\u8FD0\u653E / PGA",
      label: "FDA0"
    },
    FDA1: {
      kind: "OPA",
      group: "Analog",
      schema: "FDA",
      brief: "\u5DEE\u5206\u8FD0\u653E / PGA",
      label: "FDA1"
    },
    I2C1: {
      kind: "I2C",
      group: "Connectivity",
      schema: "I2C",
      brief: "I\xB2C \u63A7\u5236\u5668",
      required: [
        "SCL",
        "SDA"
      ],
      label: "I2C1"
    },
    I2C2: {
      kind: "I2C",
      group: "Connectivity",
      schema: "I2C",
      brief: "I\xB2C \u63A7\u5236\u5668",
      required: [
        "SCL",
        "SDA"
      ],
      label: "I2C2"
    },
    I2S2: {
      kind: "I2S",
      group: "Connectivity",
      schema: "I2S",
      brief: "I\xB2S \u97F3\u9891\u63A5\u53E3",
      required: [
        "WS",
        "CK"
      ],
      label: "I2S2"
    },
    I2S3: {
      kind: "I2S",
      group: "Connectivity",
      schema: "I2S",
      brief: "I\xB2S \u97F3\u9891\u63A5\u53E3",
      required: [
        "WS",
        "CK"
      ],
      label: "I2S3"
    },
    QSPI1: {
      kind: "QSPI",
      group: "Connectivity",
      schema: "QSPI",
      brief: "\u56DB\u7EBF QSPI \u63A7\u5236\u5668",
      required: [
        "NSS",
        "CLK",
        "D0",
        "D1"
      ],
      label: "QSPI1"
    },
    RTC: {
      kind: "RTC",
      group: "System",
      schema: "RTC",
      brief: "\u5B9E\u65F6\u65F6\u949F\uFF08\u542B\u6821\u51C6\u65F6\u949F\u8F93\u51FA\uFF09",
      label: "RTC"
    },
    SPI2: {
      kind: "SPI",
      group: "Connectivity",
      schema: "SPI",
      brief: "\u4E32\u884C\u5916\u8BBE\u63A5\u53E3",
      required: [
        "SCK",
        "MOSI",
        "MISO"
      ],
      label: "SPI2"
    },
    SPI3: {
      kind: "SPI",
      group: "Connectivity",
      schema: "SPI",
      brief: "\u4E32\u884C\u5916\u8BBE\u63A5\u53E3",
      required: [
        "SCK",
        "MOSI",
        "MISO"
      ],
      label: "SPI3"
    },
    TIM1: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM1"
    },
    TIM10: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM10"
    },
    TIM2: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM2"
    },
    TIM3: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM3"
    },
    TIM4: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM4"
    },
    TIM5: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM5"
    },
    TIM6: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM6"
    },
    TIM7: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM7"
    },
    TIM8: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM8"
    },
    TIM9: {
      kind: "TIM",
      group: "Timers",
      schema: "TIM",
      brief: "16 \u4F4D\u5B9A\u65F6\u5668",
      label: "TIM9"
    },
    UART4: {
      kind: "UART",
      group: "Connectivity",
      schema: "UART",
      brief: "\u5F02\u6B65\u4E32\u53E3\uFF08\u65E0 CK\uFF09",
      required: [
        "TX",
        "RX"
      ],
      label: "UART4"
    },
    UART5: {
      kind: "UART",
      group: "Connectivity",
      schema: "UART",
      brief: "\u5F02\u6B65\u4E32\u53E3\uFF08\u65E0 CK\uFF09",
      required: [
        "TX",
        "RX"
      ],
      label: "UART5"
    },
    USART1: {
      kind: "USART",
      group: "Connectivity",
      schema: "USART",
      brief: "\u901A\u7528\u540C\u6B65/\u5F02\u6B65\u6536\u53D1\u5668",
      required: [
        "TX",
        "RX"
      ],
      label: "USART1"
    },
    USART2: {
      kind: "USART",
      group: "Connectivity",
      schema: "USART",
      brief: "\u901A\u7528\u540C\u6B65/\u5F02\u6B65\u6536\u53D1\u5668",
      required: [
        "TX",
        "RX"
      ],
      label: "USART2"
    },
    USART3: {
      kind: "USART",
      group: "Connectivity",
      schema: "USART",
      brief: "\u901A\u7528\u540C\u6B65/\u5F02\u6B65\u6536\u53D1\u5668",
      required: [
        "TX",
        "RX"
      ],
      label: "USART3"
    },
    USB1: {
      kind: "USB",
      group: "Connectivity",
      schema: "USB",
      brief: "USB 2.0 \u5168\u901F\u8BBE\u5907",
      required: [
        "DP",
        "DM"
      ],
      label: "USB1"
    },
    VC0: {
      kind: "VCMP",
      group: "Analog",
      schema: "VCMP",
      brief: "\u7535\u538B\u6BD4\u8F83\u5668",
      required: [
        "OUT"
      ],
      label: "VC0"
    },
    VC1: {
      kind: "VCMP",
      group: "Analog",
      schema: "VCMP",
      brief: "\u7535\u538B\u6BD4\u8F83\u5668",
      required: [
        "OUT"
      ],
      label: "VC1"
    },
    VC2: {
      kind: "VCMP",
      group: "Analog",
      schema: "VCMP",
      brief: "\u7535\u538B\u6BD4\u8F83\u5668",
      required: [
        "OUT"
      ],
      label: "VC2"
    }
  },
  packages: [
    {
      id: "HC32F401BRET6YM",
      label: "LQFP64",
      shape: "quad",
      pinNumbering: "package",
      pins: [
        {
          num: 1,
          name: "PD3",
          kind: "io"
        },
        {
          num: 2,
          name: "PC13",
          kind: "io"
        },
        {
          num: 3,
          name: "PC14",
          kind: "io"
        },
        {
          num: 4,
          name: "PC15",
          kind: "io"
        },
        {
          num: 5,
          name: "PD0",
          kind: "io"
        },
        {
          num: 6,
          name: "PD1",
          kind: "io"
        },
        {
          num: 7,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 8,
          name: "PC0",
          kind: "io"
        },
        {
          num: 9,
          name: "PC1",
          kind: "io"
        },
        {
          num: 10,
          name: "PC2",
          kind: "io"
        },
        {
          num: 11,
          name: "PC3",
          kind: "io"
        },
        {
          num: 12,
          name: "VSSA",
          kind: "power"
        },
        {
          num: 13,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 14,
          name: "PA0",
          kind: "io",
          note: "PA0_WKUP"
        },
        {
          num: 15,
          name: "PA1",
          kind: "io"
        },
        {
          num: 16,
          name: "PA2",
          kind: "io"
        },
        {
          num: 17,
          name: "PA3",
          kind: "io"
        },
        {
          num: 18,
          name: "VSS",
          kind: "power"
        },
        {
          num: 19,
          name: "VDD",
          kind: "power"
        },
        {
          num: 20,
          name: "PA4",
          kind: "io"
        },
        {
          num: 21,
          name: "PA5",
          kind: "io"
        },
        {
          num: 22,
          name: "PA6",
          kind: "io"
        },
        {
          num: 23,
          name: "PA7",
          kind: "io"
        },
        {
          num: 24,
          name: "PC4",
          kind: "io"
        },
        {
          num: 25,
          name: "PC5",
          kind: "io"
        },
        {
          num: 26,
          name: "PB0",
          kind: "io"
        },
        {
          num: 27,
          name: "PB1",
          kind: "io"
        },
        {
          num: 28,
          name: "PB2",
          kind: "io",
          note: "PB2/BOOT1",
          aliases: [
            "BOOT1"
          ]
        },
        {
          num: 29,
          name: "PB10",
          kind: "io"
        },
        {
          num: 30,
          name: "PB11",
          kind: "io"
        },
        {
          num: 31,
          name: "VCAP_1",
          kind: "power"
        },
        {
          num: 32,
          name: "VDD",
          kind: "power"
        },
        {
          num: 33,
          name: "PB12",
          kind: "io"
        },
        {
          num: 34,
          name: "PB13",
          kind: "io"
        },
        {
          num: 35,
          name: "PB14",
          kind: "io"
        },
        {
          num: 36,
          name: "PB15",
          kind: "io"
        },
        {
          num: 37,
          name: "PC6",
          kind: "io"
        },
        {
          num: 38,
          name: "PC7",
          kind: "io"
        },
        {
          num: 39,
          name: "PC8",
          kind: "io"
        },
        {
          num: 40,
          name: "PC9",
          kind: "io"
        },
        {
          num: 41,
          name: "PA8",
          kind: "io"
        },
        {
          num: 42,
          name: "PA9",
          kind: "io"
        },
        {
          num: 43,
          name: "PA10",
          kind: "io"
        },
        {
          num: 44,
          name: "PA11",
          kind: "io"
        },
        {
          num: 45,
          name: "PA12",
          kind: "io"
        },
        {
          num: 46,
          name: "PA13",
          kind: "io",
          note: "JTMS-SWDIO"
        },
        {
          num: 47,
          name: "VCAP_2",
          kind: "power"
        },
        {
          num: 48,
          name: "VDD",
          kind: "power"
        },
        {
          num: 49,
          name: "PA14",
          kind: "io",
          note: "JTCK-SWCLK"
        },
        {
          num: 50,
          name: "PA15",
          kind: "io",
          note: "JTDI"
        },
        {
          num: 51,
          name: "PC10",
          kind: "io"
        },
        {
          num: 52,
          name: "PC11",
          kind: "io"
        },
        {
          num: 53,
          name: "PC12",
          kind: "io"
        },
        {
          num: 54,
          name: "PD2",
          kind: "io"
        },
        {
          num: 55,
          name: "PB3",
          kind: "io",
          note: "JTDO-SWO"
        },
        {
          num: 56,
          name: "PB4",
          kind: "io",
          note: "JTAST"
        },
        {
          num: 57,
          name: "PB5",
          kind: "io"
        },
        {
          num: 58,
          name: "PB6",
          kind: "io"
        },
        {
          num: 59,
          name: "PB7",
          kind: "io"
        },
        {
          num: 60,
          name: "PB8",
          kind: "io"
        },
        {
          num: 61,
          name: "BOOT0",
          kind: "boot"
        },
        {
          num: 62,
          name: "PB9",
          kind: "io"
        },
        {
          num: 63,
          name: "VSS",
          kind: "power"
        },
        {
          num: 64,
          name: "VDD",
          kind: "power"
        }
      ]
    },
    {
      id: "HC32F401BKEU6YM",
      label: "LQFP32",
      shape: "quad",
      pinNumbering: "package",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PD0",
          kind: "io"
        },
        {
          num: 3,
          name: "PD1",
          kind: "io"
        },
        {
          num: 4,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 5,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io",
          note: "PA0_WKUP"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PB0",
          kind: "io"
        },
        {
          num: 13,
          name: "PB1",
          kind: "io"
        },
        {
          num: 14,
          name: "PB2",
          kind: "io",
          note: "PB2/BOOT1",
          aliases: [
            "BOOT1"
          ]
        },
        {
          num: 15,
          name: "PB11",
          kind: "io"
        },
        {
          num: 16,
          name: "VSS",
          kind: "power"
        },
        {
          num: 17,
          name: "VDD",
          kind: "power"
        },
        {
          num: 18,
          name: "PB14",
          kind: "io"
        },
        {
          num: 19,
          name: "PC8",
          kind: "io"
        },
        {
          num: 20,
          name: "PC9",
          kind: "io"
        },
        {
          num: 21,
          name: "PA8",
          kind: "io"
        },
        {
          num: 22,
          name: "PA11",
          kind: "io"
        },
        {
          num: 23,
          name: "PA12",
          kind: "io"
        },
        {
          num: 24,
          name: "PA13",
          kind: "io",
          note: "JTMS-SWDIO"
        },
        {
          num: 25,
          name: "PA14",
          kind: "io",
          note: "JTCK-SWCLK"
        },
        {
          num: 26,
          name: "PA15",
          kind: "io",
          note: "JTDI"
        },
        {
          num: 27,
          name: "PB3",
          kind: "io",
          note: "JTDO-SWO"
        },
        {
          num: 28,
          name: "PB4",
          kind: "io",
          note: "JTAST"
        },
        {
          num: 29,
          name: "PB5",
          kind: "io"
        },
        {
          num: 30,
          name: "PB7",
          kind: "io"
        },
        {
          num: 31,
          name: "BOOT0",
          kind: "boot"
        },
        {
          num: 32,
          name: "PC13",
          kind: "io"
        }
      ]
    },
    {
      id: "HC32F401BKCU6RM1",
      label: "QFN32-4\xD74",
      shape: "qfn",
      pinNumbering: "package",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PD0",
          kind: "io"
        },
        {
          num: 3,
          name: "PD1",
          kind: "io"
        },
        {
          num: 4,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 5,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io",
          note: "PA0_WKUP"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PB0",
          kind: "io"
        },
        {
          num: 13,
          name: "PB1",
          kind: "io"
        },
        {
          num: 14,
          name: "PB2",
          kind: "io",
          note: "PB2/BOOT1",
          aliases: [
            "BOOT1"
          ]
        },
        {
          num: 15,
          name: "PB11",
          kind: "io"
        },
        {
          num: 16,
          name: "VSS",
          kind: "power"
        },
        {
          num: 17,
          name: "VDD",
          kind: "power"
        },
        {
          num: 18,
          name: "PB14",
          kind: "io"
        },
        {
          num: 19,
          name: "PC8",
          kind: "io"
        },
        {
          num: 20,
          name: "PC9",
          kind: "io"
        },
        {
          num: 21,
          name: "PA8",
          kind: "io"
        },
        {
          num: 22,
          name: "PA11",
          kind: "io"
        },
        {
          num: 23,
          name: "PA12",
          kind: "io"
        },
        {
          num: 24,
          name: "PA13",
          kind: "io",
          note: "JTMS-SWDIO"
        },
        {
          num: 25,
          name: "PA14",
          kind: "io",
          note: "JTCK-SWCLK"
        },
        {
          num: 26,
          name: "PA15",
          kind: "io",
          note: "JTDI"
        },
        {
          num: 27,
          name: "PB3",
          kind: "io",
          note: "JTDO-SWO"
        },
        {
          num: 28,
          name: "PB4",
          kind: "io",
          note: "JTAST"
        },
        {
          num: 29,
          name: "PB5",
          kind: "io"
        },
        {
          num: 30,
          name: "PB7",
          kind: "io"
        },
        {
          num: 31,
          name: "BOOT0",
          kind: "boot"
        },
        {
          num: 32,
          name: "PC13",
          kind: "io"
        }
      ]
    },
    {
      id: "HC32F401BKCU6RM2",
      label: "QFN32-5\xD75",
      shape: "qfn",
      pinNumbering: "package",
      pins: [
        {
          num: 1,
          name: "VDD",
          kind: "power"
        },
        {
          num: 2,
          name: "PD0",
          kind: "io"
        },
        {
          num: 3,
          name: "PD1",
          kind: "io"
        },
        {
          num: 4,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 5,
          name: "VDDA",
          kind: "power"
        },
        {
          num: 6,
          name: "PA0",
          kind: "io",
          note: "PA0_WKUP"
        },
        {
          num: 7,
          name: "PA1",
          kind: "io"
        },
        {
          num: 8,
          name: "PA2",
          kind: "io"
        },
        {
          num: 9,
          name: "PA3",
          kind: "io"
        },
        {
          num: 10,
          name: "PA4",
          kind: "io"
        },
        {
          num: 11,
          name: "PA5",
          kind: "io"
        },
        {
          num: 12,
          name: "PB0",
          kind: "io"
        },
        {
          num: 13,
          name: "PB1",
          kind: "io"
        },
        {
          num: 14,
          name: "PB2",
          kind: "io",
          note: "PB2/BOOT1",
          aliases: [
            "BOOT1"
          ]
        },
        {
          num: 15,
          name: "PB11",
          kind: "io"
        },
        {
          num: 16,
          name: "VSS",
          kind: "power"
        },
        {
          num: 17,
          name: "VDD",
          kind: "power"
        },
        {
          num: 18,
          name: "PB14",
          kind: "io"
        },
        {
          num: 19,
          name: "PC8",
          kind: "io"
        },
        {
          num: 20,
          name: "PC9",
          kind: "io"
        },
        {
          num: 21,
          name: "PA8",
          kind: "io"
        },
        {
          num: 22,
          name: "PA11",
          kind: "io"
        },
        {
          num: 23,
          name: "PA12",
          kind: "io"
        },
        {
          num: 24,
          name: "PA13",
          kind: "io",
          note: "JTMS-SWDIO"
        },
        {
          num: 25,
          name: "PA14",
          kind: "io",
          note: "JTCK-SWCLK"
        },
        {
          num: 26,
          name: "PA15",
          kind: "io",
          note: "JTDI"
        },
        {
          num: 27,
          name: "PB3",
          kind: "io",
          note: "JTDO-SWO"
        },
        {
          num: 28,
          name: "PB4",
          kind: "io",
          note: "JTAST"
        },
        {
          num: 29,
          name: "PB5",
          kind: "io"
        },
        {
          num: 30,
          name: "PB7",
          kind: "io"
        },
        {
          num: 31,
          name: "BOOT0",
          kind: "boot"
        },
        {
          num: 32,
          name: "PC13",
          kind: "io"
        }
      ]
    },
    {
      id: "HC32F401BECU6RM",
      label: "QFN24",
      shape: "qfn",
      pinNumbering: "package",
      pins: [
        {
          num: 1,
          name: "PC13",
          kind: "io"
        },
        {
          num: 2,
          name: "PD0",
          kind: "io"
        },
        {
          num: 3,
          name: "PD1",
          kind: "io"
        },
        {
          num: 4,
          name: "NRST",
          kind: "reset"
        },
        {
          num: 5,
          name: "PA0",
          kind: "io",
          note: "PA0_WKUP"
        },
        {
          num: 6,
          name: "PA1",
          kind: "io"
        },
        {
          num: 7,
          name: "PA2",
          kind: "io"
        },
        {
          num: 8,
          name: "PA3",
          kind: "io"
        },
        {
          num: 9,
          name: "PA4",
          kind: "io"
        },
        {
          num: 10,
          name: "PB0",
          kind: "io"
        },
        {
          num: 11,
          name: "PB1",
          kind: "io"
        },
        {
          num: 12,
          name: "PB2",
          kind: "io",
          note: "PB2/BOOT1",
          aliases: [
            "BOOT1"
          ]
        },
        {
          num: 13,
          name: "PB11",
          kind: "io"
        },
        {
          num: 14,
          name: "PB14",
          kind: "io"
        },
        {
          num: 15,
          name: "PA8",
          kind: "io"
        },
        {
          num: 16,
          name: "PA12",
          kind: "io"
        },
        {
          num: 17,
          name: "PA13",
          kind: "io",
          note: "JTMS-SWDIO"
        },
        {
          num: 18,
          name: "PA14",
          kind: "io",
          note: "JTCK-SWCLK"
        },
        {
          num: 19,
          name: "PA15",
          kind: "io",
          note: "JTDI"
        },
        {
          num: 20,
          name: "PB3",
          kind: "io",
          note: "JTDO-SWO"
        },
        {
          num: 21,
          name: "PB4",
          kind: "io",
          note: "JTAST"
        },
        {
          num: 22,
          name: "PB7",
          kind: "io"
        },
        {
          num: 23,
          name: "PB8",
          kind: "io"
        },
        {
          num: 24,
          name: "VDD",
          kind: "power"
        }
      ]
    }
  ],
  ports: {
    PA0: [
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "SPI2_NSS",
        remap: "5"
      },
      {
        fn: "I2S2_WS",
        remap: "5"
      },
      {
        fn: "VC2_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_START",
        remap: "12"
      },
      {
        fn: "SPI3_NSS",
        remap: "13"
      },
      {
        fn: "I2S3_WS",
        remap: "13"
      },
      {
        fn: "ADC2_IN12"
      }
    ],
    PA1: [
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "ADC2_IN13"
      },
      {
        fn: "FDA0_INN0"
      }
    ],
    PA10: [
      {
        fn: "TIM7_ETR",
        remap: "10"
      },
      {
        fn: "ADC1_IN2"
      }
    ],
    PA11: [
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "TIM8_CH1",
        remap: "3"
      },
      {
        fn: "I2C2_SCL",
        remap: "4"
      },
      {
        fn: "SPI2_NSS",
        remap: "5"
      },
      {
        fn: "I2S2_WS",
        remap: "5"
      },
      {
        fn: "UART4_TX",
        remap: "7"
      },
      {
        fn: "ADC1_SQR3_TRGO",
        remap: "12"
      },
      {
        fn: "SPI3_NSS",
        remap: "13"
      },
      {
        fn: "I2S3_WS",
        remap: "13"
      },
      {
        fn: "ADC1_IN3"
      },
      {
        fn: "USB1_DM"
      }
    ],
    PA12: [
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "TIM8_CH1N",
        remap: "3"
      },
      {
        fn: "I2C2_SDA",
        remap: "4"
      },
      {
        fn: "SPI2_SCK",
        remap: "5"
      },
      {
        fn: "I2S2_CK",
        remap: "5"
      },
      {
        fn: "UART4_RX",
        remap: "7"
      },
      {
        fn: "QSPI1_NSS",
        remap: "9"
      },
      {
        fn: "SPI3_SCK",
        remap: "13"
      },
      {
        fn: "I2S3_CK",
        remap: "13"
      },
      {
        fn: "ADC1_IN4"
      },
      {
        fn: "USB1_DP"
      }
    ],
    PA13: [
      {
        fn: "DBG_SWDIO"
      },
      {
        fn: "TIM2_ETR",
        remap: "1"
      },
      {
        fn: "TIM5_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_CH2",
        remap: "3"
      },
      {
        fn: "SPI2_MISO",
        remap: "5"
      },
      {
        fn: "I2S2_SDIN",
        remap: "5"
      },
      {
        fn: "QSPI1_D0",
        remap: "9"
      },
      {
        fn: "SPI3_MISO",
        remap: "13"
      },
      {
        fn: "I2S3_SDIN",
        remap: "13"
      },
      {
        fn: "ADC1_IN5"
      }
    ],
    PA14: [
      {
        fn: "DBG_SWCLK"
      },
      {
        fn: "TIM5_CH2",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N",
        remap: "3"
      },
      {
        fn: "SPI2_MOSI",
        remap: "5"
      },
      {
        fn: "I2S2_SDOUT",
        remap: "5"
      },
      {
        fn: "USART3_TX",
        remap: "6"
      },
      {
        fn: "CAN1_RX",
        remap: "8"
      },
      {
        fn: "QSPI1_D1",
        remap: "9"
      },
      {
        fn: "SPI3_MOSI",
        remap: "13"
      },
      {
        fn: "I2S3_SDOUT",
        remap: "13"
      },
      {
        fn: "ADC1_IN6"
      }
    ],
    PA15: [
      {
        fn: "DBG_JTDI"
      },
      {
        fn: "TIM5_ETR",
        remap: "2"
      },
      {
        fn: "TIM8_CH3",
        remap: "3"
      },
      {
        fn: "I2S2_MCK",
        remap: "5"
      },
      {
        fn: "USART3_RX",
        remap: "6"
      },
      {
        fn: "CAN1_TX",
        remap: "8"
      },
      {
        fn: "QSPI1_D2",
        remap: "9"
      },
      {
        fn: "TIM6_CH1",
        remap: "10"
      },
      {
        fn: "I2S3_MCK",
        remap: "13"
      },
      {
        fn: "ADC1_IN7"
      }
    ],
    PA2: [
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "SPI2_SCK",
        remap: "5"
      },
      {
        fn: "I2S2_CK",
        remap: "5"
      },
      {
        fn: "USART1_TX",
        remap: "6"
      },
      {
        fn: "CAN1_RX",
        remap: "8"
      },
      {
        fn: "ADC1_SQR0_TRGO",
        remap: "12"
      },
      {
        fn: "SPI3_SCK",
        remap: "13"
      },
      {
        fn: "I2S3_CK",
        remap: "13"
      },
      {
        fn: "ADC2_IN14"
      },
      {
        fn: "FDA0_INP0"
      }
    ],
    PA3: [
      {
        fn: "TIM1_CH2",
        remap: "1"
      },
      {
        fn: "TIM3_ETR",
        remap: "2"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "SPI2_MISO",
        remap: "5"
      },
      {
        fn: "I2S2_SDIN",
        remap: "5"
      },
      {
        fn: "USART1_RX",
        remap: "6"
      },
      {
        fn: "CAN1_TX",
        remap: "8"
      },
      {
        fn: "VC0_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_SQR1_TRGO",
        remap: "12"
      },
      {
        fn: "SPI3_MISO",
        remap: "13"
      },
      {
        fn: "I2S3_SDIN",
        remap: "13"
      },
      {
        fn: "ADC2_IN15"
      }
    ],
    PA4: [
      {
        fn: "TIM1_CH3",
        remap: "1"
      },
      {
        fn: "TIM4_CH1",
        remap: "2"
      },
      {
        fn: "SPI2_MOSI",
        remap: "5"
      },
      {
        fn: "I2S2_SDOUT",
        remap: "5"
      },
      {
        fn: "USART1_CK",
        remap: "6"
      },
      {
        fn: "VC1_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_SQR2_TRGO",
        remap: "12"
      },
      {
        fn: "SPI3_MOSI",
        remap: "13"
      },
      {
        fn: "I2S3_SDOUT",
        remap: "13"
      },
      {
        fn: "ADC2_IN16"
      },
      {
        fn: "DAC1_OUT"
      }
    ],
    PA5: [
      {
        fn: "TIM4_CH2",
        remap: "2"
      },
      {
        fn: "ADC2_IN17"
      },
      {
        fn: "FDA1_INN2"
      }
    ],
    PA6: [
      {
        fn: "TIM4_ETR",
        remap: "2"
      },
      {
        fn: "USART2_TX",
        remap: "6"
      },
      {
        fn: "ADC2_IN18"
      },
      {
        fn: "FDA1_INP2"
      }
    ],
    PA7: [
      {
        fn: "TIM5_CH1",
        remap: "2"
      },
      {
        fn: "USART2_RX",
        remap: "6"
      },
      {
        fn: "ADC2_IN19"
      }
    ],
    PA8: [
      {
        fn: "CLK_MCO"
      },
      {
        fn: "TIM5_CH2",
        remap: "2"
      },
      {
        fn: "TIM7_CH1",
        remap: "10"
      },
      {
        fn: "ADC1_IN0"
      },
      {
        fn: "DAC1_OUT"
      }
    ],
    PA9: [
      {
        fn: "TIM5_ETR",
        remap: "2"
      },
      {
        fn: "TIM7_CH2",
        remap: "10"
      },
      {
        fn: "ADC1_IN1"
      }
    ],
    PB0: [
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "TIM8_CH3N",
        remap: "3"
      },
      {
        fn: "USART3_CK",
        remap: "6"
      },
      {
        fn: "QSPI1_D3",
        remap: "9"
      },
      {
        fn: "TIM6_CH2",
        remap: "10"
      },
      {
        fn: "ADC1_IN8"
      }
    ],
    PB1: [
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "TIM8_CH4",
        remap: "3"
      },
      {
        fn: "QSPI1_CLK",
        remap: "9"
      },
      {
        fn: "TIM6_ETR",
        remap: "10"
      },
      {
        fn: "ADC1_IN9"
      },
      {
        fn: "FDA0_INP1"
      }
    ],
    PB10: [
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "TIM4_CH2",
        remap: "2"
      },
      {
        fn: "TIM9_CH4",
        remap: "3"
      },
      {
        fn: "I2C2_SCL",
        remap: "4"
      },
      {
        fn: "USART2_RX",
        remap: "6"
      },
      {
        fn: "QSPI1_D1",
        remap: "9"
      },
      {
        fn: "ADC1_IN18"
      },
      {
        fn: "VC2_CH2"
      }
    ],
    PB11: [
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "TIM4_ETR",
        remap: "2"
      },
      {
        fn: "TIM9_ETR",
        remap: "3"
      },
      {
        fn: "I2C2_SDA",
        remap: "4"
      },
      {
        fn: "USART2_CK",
        remap: "6"
      },
      {
        fn: "QSPI1_D2",
        remap: "9"
      },
      {
        fn: "ADC1_IN19"
      },
      {
        fn: "FDA1_OUTP"
      }
    ],
    PB12: [
      {
        fn: "QSPI1_D3",
        remap: "9"
      },
      {
        fn: "ADC1_IN20"
      },
      {
        fn: "ADC2_IN20"
      },
      {
        fn: "VC2_CH3"
      }
    ],
    PB13: [
      {
        fn: "QSPI1_CLK",
        remap: "9"
      },
      {
        fn: "ADC1_IN21"
      },
      {
        fn: "ADC2_IN21"
      },
      {
        fn: "VC2_CH4"
      }
    ],
    PB14: [
      {
        fn: "TIM1_BKIN2",
        remap: "1"
      },
      {
        fn: "TIM6_CH1",
        remap: "10"
      },
      {
        fn: "ADC2_IN22"
      },
      {
        fn: "FDA1_OUTN"
      }
    ],
    PB15: [
      {
        fn: "TIM6_CH2",
        remap: "10"
      },
      {
        fn: "ADC2_IN23"
      }
    ],
    PB2: [
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "TIM8_BKIN",
        remap: "3"
      },
      {
        fn: "ADC1_IN10"
      },
      {
        fn: "FDA0_INN1"
      }
    ],
    PB3: [
      {
        fn: "DBG_SWO"
      },
      {
        fn: "TIM8_BKIN2",
        remap: "3"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "CAN1_RX",
        remap: "8"
      },
      {
        fn: "ADC1_IN11"
      },
      {
        fn: "FDA0_OUTP"
      },
      {
        fn: "VC1_CH2"
      }
    ],
    PB4: [
      {
        fn: "DBG_JTAG"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_ETR",
        remap: "3"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "CAN1_TX",
        remap: "8"
      },
      {
        fn: "VC0_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_IN12"
      },
      {
        fn: "FDA0_OUTN"
      }
    ],
    PB5: [
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "SPI2_NSS",
        remap: "5"
      },
      {
        fn: "I2S2_WS",
        remap: "5"
      },
      {
        fn: "VC1_OUT",
        remap: "11"
      },
      {
        fn: "SPI3_NSS",
        remap: "13"
      },
      {
        fn: "I2S3_WS",
        remap: "13"
      },
      {
        fn: "ADC1_IN13"
      },
      {
        fn: "FDA0_INP2"
      },
      {
        fn: "VC1_CH3"
      }
    ],
    PB6: [
      {
        fn: "TIM3_ETR",
        remap: "2"
      },
      {
        fn: "SPI2_SCK",
        remap: "5"
      },
      {
        fn: "I2S2_CK",
        remap: "5"
      },
      {
        fn: "VC2_OUT",
        remap: "11"
      },
      {
        fn: "SPI3_SCK",
        remap: "13"
      },
      {
        fn: "I2S3_CK",
        remap: "13"
      },
      {
        fn: "ADC1_IN14"
      },
      {
        fn: "FDA0_INN2"
      },
      {
        fn: "VC1_CH4"
      }
    ],
    PB7: [
      {
        fn: "TIM9_CH1",
        remap: "3"
      },
      {
        fn: "SPI2_MISO",
        remap: "5"
      },
      {
        fn: "I2S2_SDIN",
        remap: "5"
      },
      {
        fn: "UART5_TX",
        remap: "7"
      },
      {
        fn: "RTC_TRIMCLK",
        remap: "11"
      },
      {
        fn: "SPI3_MISO",
        remap: "13"
      },
      {
        fn: "I2S3_SDIN",
        remap: "13"
      },
      {
        fn: "ADC1_IN15"
      },
      {
        fn: "FDA1_INP0"
      }
    ],
    PB8: [
      {
        fn: "TIM9_CH2",
        remap: "3"
      },
      {
        fn: "SPI2_MOSI",
        remap: "5"
      },
      {
        fn: "I2S2_SDOUT",
        remap: "5"
      },
      {
        fn: "UART5_RX",
        remap: "7"
      },
      {
        fn: "QSPI1_NSS",
        remap: "9"
      },
      {
        fn: "SPI3_MOSI",
        remap: "13"
      },
      {
        fn: "I2S3_SDOUT",
        remap: "13"
      },
      {
        fn: "ADC1_IN16"
      },
      {
        fn: "FDA1_INN0"
      },
      {
        fn: "VC2_CH0"
      }
    ],
    PB9: [
      {
        fn: "CLK_MCO"
      },
      {
        fn: "TIM4_CH1",
        remap: "2"
      },
      {
        fn: "TIM9_CH3",
        remap: "3"
      },
      {
        fn: "I2S2_MCK",
        remap: "5"
      },
      {
        fn: "USART2_TX",
        remap: "6"
      },
      {
        fn: "QSPI1_D0",
        remap: "9"
      },
      {
        fn: "I2S3_MCK",
        remap: "13"
      },
      {
        fn: "ADC1_IN17"
      },
      {
        fn: "FDA1_INP1"
      },
      {
        fn: "VC2_CH1"
      }
    ],
    PC0: [
      {
        fn: "TIM10_CH1",
        remap: "3"
      },
      {
        fn: "I2C1_SCL",
        remap: "4"
      },
      {
        fn: "USART3_TX",
        remap: "6"
      },
      {
        fn: "TIM6_ETR",
        remap: "10"
      },
      {
        fn: "ADC1_IN22"
      }
    ],
    PC1: [
      {
        fn: "TIM2_CH1",
        remap: "1"
      },
      {
        fn: "TIM10_CH1N",
        remap: "3"
      },
      {
        fn: "I2C1_SDA",
        remap: "4"
      },
      {
        fn: "USART3_RX",
        remap: "6"
      },
      {
        fn: "TIM7_CH1",
        remap: "10"
      },
      {
        fn: "ADC1_IN23"
      }
    ],
    PC10: [
      {
        fn: "TIM1_CH3N",
        remap: "1"
      },
      {
        fn: "TIM3_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_CH1",
        remap: "3"
      },
      {
        fn: "I2S2_MCK",
        remap: "5"
      },
      {
        fn: "I2S3_MCK",
        remap: "13"
      },
      {
        fn: "ADC2_IN2"
      },
      {
        fn: "VC0_CH2"
      }
    ],
    PC11: [
      {
        fn: "TIM1_CH4",
        remap: "1"
      },
      {
        fn: "TIM3_CH2",
        remap: "2"
      },
      {
        fn: "TIM8_CH1N",
        remap: "3"
      },
      {
        fn: "ADC2_IN3"
      }
    ],
    PC12: [
      {
        fn: "TIM1_ETR",
        remap: "1"
      },
      {
        fn: "TIM3_ETR",
        remap: "2"
      },
      {
        fn: "TIM8_CH2",
        remap: "3"
      },
      {
        fn: "QSPI1_NSS",
        remap: "9"
      },
      {
        fn: "TIM7_CH1",
        remap: "10"
      },
      {
        fn: "ADC2_IN4"
      },
      {
        fn: "VC0_CH3"
      }
    ],
    PC13: [
      {
        fn: "TIM1_BKIN",
        remap: "1"
      },
      {
        fn: "TIM4_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_CH2N",
        remap: "3"
      },
      {
        fn: "QSPI1_D0",
        remap: "9"
      },
      {
        fn: "TIM7_CH2",
        remap: "10"
      },
      {
        fn: "ADC2_IN5"
      },
      {
        fn: "VC0_CH4"
      }
    ],
    PC14: [
      {
        fn: "TIM1_BKIN2",
        remap: "1"
      },
      {
        fn: "TIM4_CH2",
        remap: "2"
      },
      {
        fn: "TIM8_CH3",
        remap: "3"
      },
      {
        fn: "SPI2_NSS",
        remap: "5"
      },
      {
        fn: "I2S2_WS",
        remap: "5"
      },
      {
        fn: "UART4_TX",
        remap: "7"
      },
      {
        fn: "QSPI1_D1",
        remap: "9"
      },
      {
        fn: "TIM7_ETR",
        remap: "10"
      },
      {
        fn: "SPI3_NSS",
        remap: "13"
      },
      {
        fn: "I2S3_WS",
        remap: "13"
      },
      {
        fn: "ADC2_IN6"
      }
    ],
    PC15: [
      {
        fn: "TIM4_ETR",
        remap: "2"
      },
      {
        fn: "TIM8_CH3N",
        remap: "3"
      },
      {
        fn: "SPI2_SCK",
        remap: "5"
      },
      {
        fn: "I2S2_CK",
        remap: "5"
      },
      {
        fn: "UART4_RX",
        remap: "7"
      },
      {
        fn: "QSPI1_D2",
        remap: "9"
      },
      {
        fn: "SPI3_SCK",
        remap: "13"
      },
      {
        fn: "I2S3_CK",
        remap: "13"
      },
      {
        fn: "ADC2_IN7"
      }
    ],
    PC2: [
      {
        fn: "TIM2_CH2",
        remap: "1"
      },
      {
        fn: "TIM10_ETR",
        remap: "3"
      },
      {
        fn: "USART3_CK",
        remap: "6"
      },
      {
        fn: "TIM7_CH2",
        remap: "10"
      },
      {
        fn: "ADC1_IN24"
      },
      {
        fn: "ADC2_IN24"
      }
    ],
    PC3: [
      {
        fn: "TIM2_ETR",
        remap: "1"
      },
      {
        fn: "TIM7_ETR",
        remap: "10"
      },
      {
        fn: "ADC1_START",
        remap: "12"
      },
      {
        fn: "ADC1_IN25"
      },
      {
        fn: "ADC2_IN25"
      }
    ],
    PC4: [
      {
        fn: "VC0_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_SQR0_TRGO",
        remap: "12"
      },
      {
        fn: "ADC1_IN26"
      },
      {
        fn: "ADC2_IN26"
      }
    ],
    PC5: [
      {
        fn: "TIM1_CH1",
        remap: "1"
      },
      {
        fn: "VC1_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_SQR1_TRGO",
        remap: "12"
      },
      {
        fn: "ADC1_IN27"
      },
      {
        fn: "ADC2_IN27"
      }
    ],
    PC6: [
      {
        fn: "TIM1_CH1N",
        remap: "1"
      },
      {
        fn: "UART4_TX",
        remap: "7"
      },
      {
        fn: "VC2_OUT",
        remap: "11"
      },
      {
        fn: "ADC1_SQR2_TRGO",
        remap: "12"
      },
      {
        fn: "ADC1_IN28"
      },
      {
        fn: "ADC2_IN28"
      }
    ],
    PC7: [
      {
        fn: "TIM1_CH2",
        remap: "1"
      },
      {
        fn: "UART4_RX",
        remap: "7"
      },
      {
        fn: "RTC_TRIMCLK",
        remap: "11"
      },
      {
        fn: "ADC1_SQR3_TRGO",
        remap: "12"
      },
      {
        fn: "ADC1_IN29"
      },
      {
        fn: "ADC2_IN29"
      }
    ],
    PC8: [
      {
        fn: "TIM1_CH2N",
        remap: "1"
      },
      {
        fn: "I2C2_SCL",
        remap: "4"
      },
      {
        fn: "USART1_TX",
        remap: "6"
      },
      {
        fn: "UART5_TX",
        remap: "7"
      },
      {
        fn: "CAN1_RX",
        remap: "8"
      },
      {
        fn: "ADC2_IN0"
      },
      {
        fn: "VC0_CH0"
      }
    ],
    PC9: [
      {
        fn: "TIM1_CH3",
        remap: "1"
      },
      {
        fn: "I2C2_SDA",
        remap: "4"
      },
      {
        fn: "USART1_RX",
        remap: "6"
      },
      {
        fn: "UART5_RX",
        remap: "7"
      },
      {
        fn: "CAN1_TX",
        remap: "8"
      },
      {
        fn: "ADC2_IN1"
      },
      {
        fn: "VC0_CH1"
      }
    ],
    PD0: [
      {
        fn: "TIM5_CH1",
        remap: "2"
      },
      {
        fn: "TIM8_CH4",
        remap: "3"
      },
      {
        fn: "SPI2_MISO",
        remap: "5"
      },
      {
        fn: "I2S2_SDIN",
        remap: "5"
      },
      {
        fn: "QSPI1_D3",
        remap: "9"
      },
      {
        fn: "VC0_OUT",
        remap: "11"
      },
      {
        fn: "SPI3_MISO",
        remap: "13"
      },
      {
        fn: "I2S3_SDIN",
        remap: "13"
      },
      {
        fn: "ADC2_IN8"
      }
    ],
    PD1: [
      {
        fn: "TIM5_CH2",
        remap: "2"
      },
      {
        fn: "TIM8_ETR",
        remap: "3"
      },
      {
        fn: "SPI2_MOSI",
        remap: "5"
      },
      {
        fn: "I2S2_SDOUT",
        remap: "5"
      },
      {
        fn: "QSPI1_CLK",
        remap: "9"
      },
      {
        fn: "VC1_OUT",
        remap: "11"
      },
      {
        fn: "SPI3_MOSI",
        remap: "13"
      },
      {
        fn: "I2S3_SDOUT",
        remap: "13"
      },
      {
        fn: "ADC2_IN9"
      }
    ],
    PD2: [
      {
        fn: "TIM5_ETR",
        remap: "2"
      },
      {
        fn: "TIM8_BKIN",
        remap: "3"
      },
      {
        fn: "VC2_OUT",
        remap: "11"
      },
      {
        fn: "ADC2_IN10"
      },
      {
        fn: "VC1_CH0"
      }
    ],
    PD3: [
      {
        fn: "TIM8_BKIN2",
        remap: "3"
      },
      {
        fn: "ADC2_IN11"
      },
      {
        fn: "FDA1_INN1"
      },
      {
        fn: "VC1_CH1"
      }
    ]
  },
  peripherals: [
    {
      id: "ADC1",
      signals: [
        "IN0",
        "IN1",
        "IN10",
        "IN11",
        "IN12",
        "IN13",
        "IN14",
        "IN15",
        "IN16",
        "IN17",
        "IN18",
        "IN19",
        "IN2",
        "IN20",
        "IN21",
        "IN22",
        "IN23",
        "IN24",
        "IN25",
        "IN26",
        "IN27",
        "IN28",
        "IN29",
        "IN3",
        "IN4",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9",
        "SQR0_TRGO",
        "SQR1_TRGO",
        "SQR2_TRGO",
        "SQR3_TRGO",
        "START"
      ]
    },
    {
      id: "ADC2",
      signals: [
        "IN0",
        "IN1",
        "IN10",
        "IN11",
        "IN12",
        "IN13",
        "IN14",
        "IN15",
        "IN16",
        "IN17",
        "IN18",
        "IN19",
        "IN2",
        "IN20",
        "IN21",
        "IN22",
        "IN23",
        "IN24",
        "IN25",
        "IN26",
        "IN27",
        "IN28",
        "IN29",
        "IN3",
        "IN4",
        "IN5",
        "IN6",
        "IN7",
        "IN8",
        "IN9"
      ]
    },
    {
      id: "CAN1",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "CLK",
      signals: [
        "MCO"
      ]
    },
    {
      id: "DAC1",
      signals: [
        "OUT"
      ]
    },
    {
      id: "DBG",
      signals: [
        "JTAG",
        "JTDI",
        "SWCLK",
        "SWDIO",
        "SWO"
      ]
    },
    {
      id: "FDA0",
      signals: [
        "INN0",
        "INN1",
        "INN2",
        "INP0",
        "INP1",
        "INP2",
        "OUTN",
        "OUTP"
      ]
    },
    {
      id: "FDA1",
      signals: [
        "INN0",
        "INN1",
        "INN2",
        "INP0",
        "INP1",
        "INP2",
        "OUTN",
        "OUTP"
      ]
    },
    {
      id: "I2C1",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "I2C2",
      signals: [
        "SCL",
        "SDA"
      ]
    },
    {
      id: "I2S2",
      signals: [
        "CK",
        "MCK",
        "SDIN",
        "SDOUT",
        "WS"
      ]
    },
    {
      id: "I2S3",
      signals: [
        "CK",
        "MCK",
        "SDIN",
        "SDOUT",
        "WS"
      ]
    },
    {
      id: "QSPI1",
      signals: [
        "CLK",
        "D0",
        "D1",
        "D2",
        "D3",
        "NSS"
      ]
    },
    {
      id: "RTC",
      signals: [
        "TRIMCLK"
      ]
    },
    {
      id: "SPI2",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "SPI3",
      signals: [
        "MISO",
        "MOSI",
        "NSS",
        "SCK"
      ]
    },
    {
      id: "TIM1",
      signals: [
        "BKIN",
        "BKIN2",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM10",
      signals: [
        "CH1",
        "CH1N",
        "ETR"
      ]
    },
    {
      id: "TIM2",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM3",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM4",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM5",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM6",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM7",
      signals: [
        "CH1",
        "CH2",
        "ETR"
      ]
    },
    {
      id: "TIM8",
      signals: [
        "BKIN",
        "BKIN2",
        "CH1",
        "CH1N",
        "CH2",
        "CH2N",
        "CH3",
        "CH3N",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "TIM9",
      signals: [
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "ETR"
      ]
    },
    {
      id: "UART4",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "UART5",
      signals: [
        "RX",
        "TX"
      ]
    },
    {
      id: "USART1",
      signals: [
        "CK",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART2",
      signals: [
        "CK",
        "RX",
        "TX"
      ]
    },
    {
      id: "USART3",
      signals: [
        "CK",
        "RX",
        "TX"
      ]
    },
    {
      id: "USB1",
      signals: [
        "DM",
        "DP"
      ]
    },
    {
      id: "VC0",
      signals: [
        "CH0",
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "OUT"
      ]
    },
    {
      id: "VC1",
      signals: [
        "CH0",
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "OUT"
      ]
    },
    {
      id: "VC2",
      signals: [
        "CH0",
        "CH1",
        "CH2",
        "CH3",
        "CH4",
        "OUT"
      ]
    }
  ],
  irqs: [],
  pending: [
    "\u5F15\u811A\u53F7\u6765\u81EA\u5F15\u811A\u5B9A\u4E49\u5927\u56FE\uFF08\u9010\u811A\u5F55\u5165\uFF09\uFF0C\u662F\u5C01\u88C5\u7684\u771F\u5B9E\u7269\u7406\u5F15\u811A\u53F7",
    "\u5C1A\u65E0\u4E2D\u65AD\u5411\u91CF\u8868\uFF08irqs \u4E3A\u7A7A\uFF09\uFF0CNVIC \u9762\u677F\u6682\u65E0\u6761\u76EE",
    "\u5C1A\u65E0 DMA \u8BF7\u6C42\u6620\u5C04\u8868\uFF0CDMA \u9762\u677F\u6309\u901A\u9053\u53F7\u624B\u9009",
    "\u4EE3\u7801\u751F\u6210\u660E\u786E\u7981\u6B62\uFF08codegen = disable\uFF09\uFF1A\u8D44\u6599\u53EA\u5230\u5F15\u811A/AF \u5C42\u7EA7\uFF0C\u5C1A\u65E0\u5BC4\u5B58\u5668\u624B\u518C\u4E0E SDK \u5934\u6587\u4EF6\uFF1B\u5F15\u811A\u6620\u5C04\u8868\u4ECD\u53EF\u5BFC\u51FA",
    "ADC \u901A\u9053\u6309\u672C\u9879\u76EE\u7684 INn \u547D\u540D\uFF08\u624B\u518C\u4E3A ANn\uFF09\uFF0C\u4FBF\u4E8E\u4E0E\u65E2\u6709 ADC \u9762\u677F\u5171\u7528",
    "TIM10 \u7684 TO_GP/TO_GN \u5F52\u4E00\u5316\u4E3A CH1/CH1N\uFF1BTIM1/TIM8 \u7684 BK1/BK2 \u5F52\u4E00\u5316\u4E3A BKIN/BKIN2\uFF08\u8FD9\u4E24\u6761\u662F\u63A8\u65AD\uFF0C\u5F85\u624B\u518C\u786E\u8BA4\uFF09",
    "\u590D\u7528\u7684\u5206\u7EC4\u8BED\u4E49 = independent\uFF08\u9010\u5F15\u811A AF\uFF0C\u65E0\u91CD\u6620\u5C04\u7EC4\uFF09\u3002\u540C\u4E00\u5916\u8BBE\u7684\u4FE1\u53F7\u5141\u8BB8\u843D\u5728\u4E0D\u540C AF \u4E0A\uFF0C\u4E0E WCH \u7684 AFIO \u6574\u7EC4\u5207\u6362\u4E0D\u540C"
  ]
};

// src/core/packs/index.ts
var ENTRIES = [
  { pack: ch32v407_default, load: loadPack2 },
  // V467：V407 + 内置 8MB PSRAM，共用 WCH 历史 META 兜底（DVP 已加入）
  { pack: ch32v467_default, load: loadPack2 },
  { pack: ch32l103_default, load: loadPack2 },
  { pack: ch32x035_default, load: loadPack2 },
  { pack: ch32x033_default, load: loadPack2 },
  // 非 WCH 的包必须自带 meta，走通用加载器（不带历史 META 兜底）
  { pack: hc32f401b_default, load: (p) => loadPack(p) }
];
var loadedDevices = [];
for (const { pack, load } of ENTRIES) {
  const issues = validatePack(pack, pack.series);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new Error(formatIssues(pack, errors) ?? `${pack.series}: \u5668\u4EF6\u5305\u6821\u9A8C\u5931\u8D25`);
  }
  const warns = issues.filter((i) => i.level === "warn");
  if (warns.length && import.meta.env?.DEV) {
    console.warn(formatIssues(pack, warns));
  }
  try {
    loadedDevices.push(...load(pack));
  } catch (e) {
    throw new Error(`${pack.series}: \u52A0\u8F7D\u5931\u8D25 \u2014\u2014 ${e.message}`);
  }
}
var DEVICES = loadedDevices;
var DEVICE_MAP = Object.fromEntries(
  DEVICES.map((d) => [d.id, d])
);
var SERIES = ENTRIES.map(({ pack }) => {
  const first = DEVICE_MAP[pack.packages[0]?.id ?? ""];
  return {
    id: pack.series,
    vendor: pack.vendor,
    label: pack.series,
    core: pack.core,
    voltage: pack.voltage,
    summary: `${pack.flashKb} KB Flash \xB7 ${pack.ramKb} KB RAM \xB7 ${pack.maxSysclk} MHz`,
    parts: pack.packages.map((p) => ({
      id: p.id,
      packageLabel: p.label,
      pins: p.pins.length,
      flashKb: pack.flashKb,
      ramKb: pack.ramKb,
      maxSysclk: first?.clock.maxSysclk ?? pack.maxSysclk
    }))
  };
});
var PACK_OF_SERIES = Object.fromEntries(
  ENTRIES.map(({ pack }) => [pack.series, pack])
);

// src/semantic/schemas.ts
var g = (key, label, open = false, advanced = false, hint) => ({
  key,
  label,
  open,
  advanced,
  hint
});
var sel = (key, label, def, options, extra = {}) => ({
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
    hint: o.hint
  })),
  ...extra
});
var num = (key, label, def, min, max, extra = {}) => ({ key, label, type: "number", default: def, min, max, ...extra });
var bool = (key, label, def = false, extra = {}) => ({
  key,
  label,
  type: "boolean",
  default: def,
  ...extra
});
var USART_MODE_OPTIONS = [
  { l: "Disable", v: "disable" },
  {
    l: "Asynchronous \u5F02\u6B65",
    v: "Asynchronous",
    signals: ["TX", "RX"],
    required: ["TX", "RX"],
    hint: "\u6700\u5E38\u7528\uFF1ATX / RX \u4E24\u7EBF\uFF0C\u6CE2\u7279\u7387\u7531 BRR \u51B3\u5B9A"
  },
  {
    l: "Synchronous \u540C\u6B65",
    v: "Synchronous",
    signals: ["TX", "RX", "CK"],
    required: ["TX", "RX", "CK"],
    hint: "\u540C\u6B65\u6A21\u5F0F\uFF1ATX \u53D1\u3001RX \u6536\u3001CK \u8F93\u51FA\u6CE2\u7279\u7387\u65F6\u949F\uFF08CTLR2.CLKEN=1\uFF09\uFF1B\u53EA\u5F00\u4E00\u4E2A\u65B9\u5411\u65F6\u53E6\u4E00\u6761\u4E0D\u5360\u5F15\u811A"
  },
  {
    l: "Single Wire \u5355\u7EBF\u534A\u53CC\u5DE5",
    v: "SingleWire",
    signals: ["TX"],
    required: ["TX"],
    hint: "\u53EA\u5360 TX \u4E00\u6839\u7EBF\uFF0C\u6536\u53D1\u5171\u7528\uFF08CTLR3.HDSEL=1\uFF09"
  },
  // —— 以下模式暂时收起：生成器还没落地它们的专属参数 ——
  { l: "Multiprocessor \u591A\u673A\u901A\u4FE1", v: "Multiprocessor", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "\u5730\u5740\u5524\u9192\uFF0C\u9700\u914D\u5408 WAKE \u4E0E ADDR \u4F4D" },
  { l: "IrDA \u7EA2\u5916", v: "IrDA", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "\u9700\u8981 IREN=1 \u4E0E IrDA_LP \u5206\u9891" },
  { l: "LIN \u603B\u7EBF", v: "LIN", signals: ["TX", "RX"], required: ["TX", "RX"], hint: "\u9700 LBDL \u8BBE\u5B9A\u65AD\u5E27\u957F\u5EA6" },
  { l: "SmartCard \u667A\u80FD\u5361", v: "SmartCard", signals: ["TX"], required: ["TX"], hint: "\u5355\u7EBF\uFF1B\u5F3A\u5236 9 \u4F4D\u5B57\u957F + \u5076\u6821\u9A8C + 0.5 \u505C\u6B62\u4F4D" },
  { l: "SmartCard + Card Clock", v: "SmartCardWithClock", signals: ["TX", "CK"], required: ["TX", "CK"], hint: "\u989D\u5916\u8F93\u51FA 3/5 \u5206\u9891\u5361\u65F6\u949F" }
];
var USART_VISIBLE_MODES = /* @__PURE__ */ new Set(["Asynchronous", "Synchronous", "SingleWire"]);
var usart = {
  modeKey: "mode",
  about: "USART \u652F\u6301\u5F02\u6B65 / \u540C\u6B65 / \u5355\u7EBF\u534A\u53CC\u5DE5\u4E09\u79CD\u5DE5\u4F5C\u6A21\u5F0F\uFF08\u591A\u673A / IrDA / LIN / \u667A\u80FD\u5361\u6682\u672A\u653E\u5F00\uFF09\u3002\u5207\u6362\u6A21\u5F0F\u4F1A\u6539\u53D8\u9700\u8981\u5360\u7528\u7684\u4FE1\u53F7\u7EBF \u2014\u2014 \u5F02\u6B65\u662F TX+RX\uFF0C\u540C\u6B65\u662F TX+CK\uFF0C\u5355\u7EBF\u53EA\u6709 TX\uFF0C\u5F15\u811A\u4F1A\u81EA\u52A8\u8DDF\u7740\u589E\u51CF\u3002",
  /**
   * 分组顺序照 PY32Studio 的串口页：Basic Parameters → Advanced Parameters → Clock Parameters。
   * 时钟那组的所有字段都带 `visibleIf: mode == Synchronous`，切到异步时整组会自动消失
   * （ParamsTab 里 `items.length === 0` 就不渲染该组），不需要额外的显隐逻辑。
   */
  groups: [
    g("mode", "\u5DE5\u4F5C\u6A21\u5F0F", true),
    g("basic", "\u57FA\u672C\u53C2\u6570", true),
    g("adv", "\u9AD8\u7EA7\u53C2\u6570", false, true),
    g("clock", "\u65F6\u949F\u53C2\u6570\uFF08\u540C\u6B65\u6A21\u5F0F\uFF09", false, true),
    g("irq", "\u4E2D\u65AD\u4E0E DMA")
  ],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      USART_MODE_OPTIONS.filter((o) => o.v === "disable" || USART_VISIBLE_MODES.has(o.v)),
      { group: "mode", hint: "USART_CTLR1 \u7684 TE/RE/PS \u4E0E CTLR3 \u7684 HDSEL / CTLR2 \u7684 CLKEN \u7EC4\u5408" }
    ),
    sel(
      "rs232",
      "\u786C\u4EF6\u6D41\u63A7 (RS232)",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u4EC5 RTS", v: "RTS", signals: ["RTS"] },
        { l: "\u4EC5 CTS", v: "CTS", signals: ["CTS"] },
        { l: "RTS / CTS", v: "RTS_CTS", signals: ["RTS", "CTS"] }
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
        enabledIf: { k: "rs485", op: "=", v: false },
        hint: "CTLR3.RTSE / CTLR3.CTSE"
      }
    ),
    bool("rs485", "RS485 \u786C\u4EF6\u6D41\u63A7 (DE)", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
      enabledIf: { k: "rs232", op: "=", v: "disable" },
      hint: "CTLR3.DEM=1\uFF0CDE \u5F15\u811A\u5728\u53D1\u9001\u65F6\u81EA\u52A8\u62C9\u9AD8"
    }),
    num("baud", "\u6CE2\u7279\u7387", 115200, 245, 6e6, {
      group: "basic",
      unit: "bit/s",
      formula: "USARTDIV = fPCLK / (16 \u6216 8 \xD7 \u6CE2\u7279\u7387)",
      hint: "\u81EA\u52A8\u8BA1\u7B97 BRR \u6574\u6570\u4E0E\u5C0F\u6570\u90E8\u5206\uFF0C\u4E0B\u65B9\u4F1A\u5B9E\u65F6\u663E\u793A\u5B9E\u9645\u6CE2\u7279\u7387\u4E0E\u8BEF\u5DEE"
    }),
    sel(
      "wordLength",
      "\u5B57\u957F",
      "8",
      [
        { l: "8 \u4F4D", v: "8", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } },
        { l: "9 \u4F4D", v: "9" }
      ],
      { group: "basic", hint: "CTLR1.WL" }
    ),
    sel(
      "stopBits",
      "\u505C\u6B62\u4F4D",
      "1",
      [
        { l: "0.5 \u4F4D", v: "0_5" },
        { l: "1 \u4F4D", v: "1", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } },
        { l: "1.5 \u4F4D", v: "1_5" },
        { l: "2 \u4F4D", v: "2", disabledIf: { k: "mode", op: "in", v: ["SmartCard", "SmartCardWithClock"] } }
      ],
      { group: "basic", hint: "CTLR2.STOP" }
    ),
    sel(
      "parity",
      "\u6821\u9A8C",
      "None",
      [
        { l: "\u65E0\u6821\u9A8C", v: "None" },
        { l: "\u5076\u6821\u9A8C", v: "Even" },
        { l: "\u5947\u6821\u9A8C", v: "Odd" }
      ],
      { group: "basic", hint: "CTLR1.PCE / PS" }
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
      "\u6570\u636E\u65B9\u5411",
      "TX_RX",
      [
        { l: "Receive and Transmit \u6536\u53D1", v: "TX_RX" },
        { l: "Transmit only \u4EC5\u53D1\u9001", v: "TX" },
        { l: "Receive only \u4EC5\u63A5\u6536", v: "RX" }
      ],
      {
        group: "adv",
        affectsPins: true,
        hint: "CTLR1.TE / RE\uFF1B\u5F02\u6B65\u4E0E\u540C\u6B65\u90FD\u80FD\u53EA\u5F00\u4E00\u4E2A\u65B9\u5411 \u2014\u2014 \u4EC5\u53D1\u9001\u65F6\u4E0D\u5360 RX\uFF0C\u4EC5\u63A5\u6536\u65F6\u4E0D\u5360 TX"
      }
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
      "\u65F6\u949F\u6781\u6027 (CPOL)",
      "Low",
      [
        { l: "Low \u7A7A\u95F2\u4F4E\u7535\u5E73", v: "Low" },
        { l: "High \u7A7A\u95F2\u9AD8\u7535\u5E73", v: "High" }
      ],
      { group: "clock", visibleIf: { k: "mode", op: "=", v: "Synchronous" }, hint: "CTLR2.CPOL" }
    ),
    sel(
      "cpha",
      "\u65F6\u949F\u76F8\u4F4D (CPHA)",
      "1Edge",
      [
        { l: "1 Edge \u7B2C\u4E00\u4E2A\u8FB9\u6CBF\u91C7\u6837", v: "1Edge" },
        { l: "2 Edge \u7B2C\u4E8C\u4E2A\u8FB9\u6CBF\u91C7\u6837", v: "2Edge" }
      ],
      { group: "clock", visibleIf: { k: "mode", op: "=", v: "Synchronous" }, hint: "CTLR2.CPHA" }
    ),
    sel(
      "lastBit",
      "\u6700\u540E\u4E00\u4F4D\u65F6\u949F (Last Bit)",
      "Disable",
      [
        { l: "Disable \u4E0D\u8F93\u51FA\u6700\u540E\u4E00\u4F4D\u65F6\u949F", v: "Disable" },
        { l: "Enable \u8F93\u51FA\u6700\u540E\u4E00\u4F4D\u65F6\u949F", v: "Enable" }
      ],
      {
        group: "clock",
        visibleIf: { k: "mode", op: "=", v: "Synchronous" },
        hint: "CTLR2.LBCL\uFF1B\u667A\u80FD\u5361\u7C7B\u65F6\u5E8F\u9700\u8981\u5B83\u5728\u6700\u540E\u4E00\u4E2A\u6570\u636E\u4F4D\u8865\u4E00\u4E2A\u65F6\u949F"
      }
    ),
    sel(
      "oversampling",
      "\u8FC7\u91C7\u6837",
      "16",
      [
        { l: "8 \u500D\u91C7\u6837", v: "8" },
        { l: "16 \u500D\u91C7\u6837", v: "16" }
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "in", v: ["Asynchronous", "Multiprocessor"] },
        hint: "CTLR1.OVER8\uFF1B8 \u500D\u91C7\u6837\u65F6\u6CE2\u7279\u7387\u4E0A\u9650\u66F4\u9AD8\uFF0C\u4F46\u6297\u566A\u66F4\u5DEE"
      }
    ),
    bool("autoBaud", "\u81EA\u52A8\u6CE2\u7279\u7387\u68C0\u6D4B (ABR)", false, { group: "adv", hint: "CTLR2.ABREN\uFF0C\u786C\u4EF6\u4ECE 0x55 \u5E27\u6D4B\u901F" }),
    sel(
      "wakeup",
      "\u5524\u9192\u65B9\u5F0F",
      "Idle",
      [
        { l: "\u7A7A\u95F2\u603B\u7EBF\u5524\u9192", v: "Idle" },
        { l: "\u5730\u5740\u6807\u8BB0\u5524\u9192", v: "Address" }
      ],
      {
        group: "adv",
        visibleIf: { k: "mode", op: "=", v: "Multiprocessor" },
        hint: "CTLR1.WAKE"
      }
    ),
    num("addr", "\u672C\u673A\u5730\u5740", 0, 0, 15, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Multiprocessor" },
      hint: "CTLR2.ADDR\uFF0C4 \u4F4D\u5730\u5740"
    }),
    sel(
      "linBreakLen",
      "LIN \u65AD\u5E27\u957F\u5EA6",
      "10",
      [
        { l: "10 \u4F4D", v: "10" },
        { l: "11 \u4F4D", v: "11" }
      ],
      { group: "adv", visibleIf: { k: "mode", op: "=", v: "LIN" }, hint: "CTLR2.LBDL" }
    ),
    num("irdaPrescaler", "IrDA \u4F4E\u529F\u8017\u5206\u9891", 1, 1, 64, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "IrDA" },
      hint: "CTLR3.IRLP\uFF0C\u5206\u9891\u540E\u8109\u5BBD 3 \u4E2A\u7CFB\u7EDF\u65F6\u949F"
    }),
    sel(
      "scClockDiv",
      "\u667A\u80FD\u5361\u65F6\u949F\u5206\u9891",
      "5",
      [
        { l: "CK = fCK/5", v: "5" },
        { l: "CK = fCK/3", v: "3" }
      ],
      { group: "adv", visibleIf: { k: "mode", op: "=", v: "SmartCardWithClock" }, hint: "CTLR3.SCEN" }
    ),
    bool("rxTimeout", "\u63A5\u6536\u8D85\u65F6", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "Asynchronous" },
      hint: "RTOR \u5BC4\u5B58\u5668\uFF0C\u8D85\u65F6\u540E\u7F6E\u4F4D RTOF"
    }),
    num("rxTimeoutVal", "\u8D85\u65F6\u503C", 0, 0, 16777215, {
      group: "adv",
      visibleIf: { k: "rxTimeout", op: "=", v: true },
      hint: "RTOR.RTO\uFF0C\u5355\u4F4D\u4E3A\u4F4D\u65F6\u95F4"
    }),
    bool("swap", "TX/RX \u5F15\u811A\u4E92\u6362", false, { group: "adv", hint: "CTLR2.SWAP\uFF0C\u65B9\u4FBF\u5355\u5C42\u677F\u5E03\u7EBF" }),
    bool("invert", "TX/RX \u6781\u6027\u53CD\u8F6C", false, { group: "adv", hint: "CTLR2.RXINV / TXINV" }),
    bool("irqRxne", "\u63A5\u6536\u975E\u7A7A (RXNE)", true, { group: "irq", hint: "\u6BCF\u6536\u5230\u4E00\u4E2A\u5B57\u8282\u8FDB\u4E00\u6B21\u4E2D\u65AD" }),
    bool("irqIdle", "\u603B\u7EBF\u7A7A\u95F2 (IDLE)", false, { group: "irq", hint: "\u5E38\u7528\u4E8E DMA + \u4E0D\u5B9A\u957F\u63A5\u6536" }),
    bool("irqTxe", "\u53D1\u9001\u7A7A\u4E2D\u65AD (TXE)", false, { group: "irq" }),
    bool("irqTc", "\u53D1\u9001\u5B8C\u6210 (TC)", false, { group: "irq" }),
    bool("irqPe", "\u6821\u9A8C / \u5E27\u9519\u8BEF", false, { group: "irq" })
  ]
};
var spi = {
  modeKey: "mode",
  about: "SPI \u652F\u6301\u5168\u53CC\u5DE5\u4E3B\u673A / \u4ECE\u673A\u3001\u5355\u7EBF\u534A\u53CC\u5DE5\u3001\u53EA\u6536\u6A21\u5F0F\u3002CPOL/CPHA \u7EC4\u5408\u51B3\u5B9A 4 \u79CD SPI \u65F6\u5E8F\u6A21\u5F0F\uFF0CNSS \u53EF\u9009\u8F6F\u4EF6\u6216\u786C\u4EF6\u7BA1\u7406\u3002",
  groups: [g("mode", "\u6A21\u5F0F", true), g("param", "\u53C2\u6570", true), g("adv", "\u9AD8\u7EA7\u53C2\u6570", false, true), g("irq", "\u4E2D\u65AD\u4E0E DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "Full-Duplex Master \u5168\u53CC\u5DE5\u4E3B\u673A", v: "master", signals: ["SCK", "MOSI", "MISO"] },
        { l: "Full-Duplex Slave \u5168\u53CC\u5DE5\u4ECE\u673A", v: "slave", signals: ["SCK", "MOSI", "MISO"] },
        { l: "Half-Duplex Master \u534A\u53CC\u5DE5\u4E3B\u673A", v: "half_master", signals: ["SCK", "MOSI"] },
        { l: "Half-Duplex Slave \u534A\u53CC\u5DE5\u4ECE\u673A", v: "half_slave", signals: ["SCK", "MOSI"] },
        { l: "Receive Only Master \u53EA\u6536\u4E3B\u673A", v: "rx_master", signals: ["SCK", "MISO"] },
        { l: "Receive Only Slave \u53EA\u6536\u4ECE\u673A", v: "rx_slave", signals: ["SCK", "MISO"] }
      ],
      { group: "mode", hint: "CTLR1.MSTR / BIDIMODE / BIDIOE / RXONLY" }
    ),
    sel(
      "nss",
      "NSS \u7BA1\u7406",
      "software",
      [
        { l: "\u8F6F\u4EF6 NSS\uFF08SSM=1\uFF09", v: "software" },
        { l: "\u786C\u4EF6 NSS \u8F93\u5165\uFF08\u4ECE\u673A\u7247\u9009\uFF09", v: "hardware_in", signals: ["NSS"] },
        { l: "\u786C\u4EF6 NSS \u8F93\u51FA\uFF08\u4E3B\u673A\u591A\u7247\u9009\uFF09", v: "hardware_out", signals: ["NSS"] }
      ],
      { group: "mode", hint: "CTLR1.SSM / SSOE" }
    ),
    num("prescaler", "\u65F6\u949F\u9884\u5206\u9891", 8, 2, 256, {
      group: "param",
      step: 2,
      formula: "fSCK = fPCLK / \u9884\u5206\u9891",
      hint: "CTLR1.BR\uFF0C\u4EC5\u652F\u6301 2 \u7684\u5E42\u6B21\uFF1A2/4/8/16/32/64/128/256"
    }),
    sel(
      "cpol",
      "CPOL \u65F6\u949F\u6781\u6027",
      "0",
      [
        { l: "Low  \u7A7A\u95F2\u4F4E\u7535\u5E73", v: "0" },
        { l: "High \u7A7A\u95F2\u9AD8\u7535\u5E73", v: "1" }
      ],
      { group: "param", hint: "CTLR1.CPOL" }
    ),
    sel(
      "cpha",
      "CPHA \u65F6\u949F\u76F8\u4F4D",
      "0",
      [
        { l: "1 Edge \u7B2C\u4E00\u4E2A\u8FB9\u6CBF\u91C7\u6837", v: "0" },
        { l: "2 Edge \u7B2C\u4E8C\u4E2A\u8FB9\u6CBF\u91C7\u6837", v: "1" }
      ],
      { group: "param", hint: "CTLR1.CPHA" }
    ),
    sel(
      "dataSize",
      "\u6570\u636E\u5E27\u957F\u5EA6",
      "8",
      [
        { l: "8 \u4F4D", v: "8" },
        { l: "16 \u4F4D", v: "16" }
      ],
      { group: "param", hint: "CTLR1.DFF" }
    ),
    sel(
      "firstBit",
      "\u4F4D\u5E8F",
      "MSB",
      [
        { l: "MSB \u5148\u884C", v: "MSB" },
        { l: "LSB \u5148\u884C", v: "LSB" }
      ],
      { group: "param", hint: "CTLR1.LSBFIRST" }
    ),
    sel(
      "crcLength",
      "CRC \u957F\u5EA6",
      "8",
      [
        { l: "8 \u4F4D", v: "8" },
        { l: "16 \u4F4D", v: "16" }
      ],
      { group: "adv", hint: "CTLR1.CRCL" }
    ),
    bool("crcEnabled", "\u786C\u4EF6 CRC \u8BA1\u7B97", false, { group: "adv", hint: "CTLR1.CRCEN\uFF0C\u591A\u673A\u901A\u4FE1\u65F6\u53EF\u6821\u9A8C\u6574\u5E27" }),
    num("crcPoly", "CRC \u591A\u9879\u5F0F", 7, 0, 65535, { group: "adv", visibleIf: { k: "crcEnabled", op: "=", v: true } }),
    sel(
      "tiMode",
      "TI \u5E27\u683C\u5F0F",
      "motorola",
      [
        { l: "Motorola", v: "motorola" },
        { l: "TI\uFF08SS \u8109\u51B2\u540C\u6B65\uFF09", v: "ti" }
      ],
      { group: "adv", hint: "CTLR2.FRF" }
    ),
    bool("irqTxe", "\u53D1\u9001\u7F13\u51B2\u7A7A (TXE)", false, { group: "irq" }),
    bool("irqRxne", "\u63A5\u6536\u975E\u7A7A (RXNE)", true, { group: "irq" }),
    bool("irqErr", "\u9519\u8BEF\u4E2D\u65AD (ERR)", false, { group: "irq", hint: "\u6A21\u5F0F\u9519\u8BEF / \u6EA2\u51FA / CRC \u9519\u8BEF" })
  ]
};
var I2C_AS_TARGET = {
  or: [
    { k: "mode", op: "=", v: "slave" },
    { and: [{ k: "mode", op: "=", v: "smbus" }, { k: "smbusRole", op: "=", v: "device" }] }
  ]
};
var i2c = {
  modeKey: "mode",
  about: "I2C \u652F\u6301\u6807\u51C6 / \u5FEB\u901F\u6A21\u5F0F\u30017 \u4F4D\u4E0E 10 \u4F4D\u5BFB\u5740\u3001\u53CC\u5730\u5740\uFF0C\u4EE5\u53CA SMBus \u534F\u8BAE\u3002\u53EA\u6709\u9009 SMBus \u6A21\u5F0F\u65F6\u624D\u4F1A\u51FA\u73B0 SMBA \u544A\u8B66\u5F15\u811A \u2014\u2014 \u666E\u901A I2C \u4E3B/\u4ECE\u673A\u6CA1\u6709\u8FD9\u6761\u7EBF\u3002",
  groups: [g("mode", "\u6A21\u5F0F", true), g("param", "\u53C2\u6570", true), g("adv", "\u9AD8\u7EA7\u53C2\u6570", false, true), g("irq", "\u4E2D\u65AD\u4E0E DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "I2C \u4E3B\u673A", v: "master", signals: ["SCL", "SDA"], hint: "CTLR1.SMBUS=0\uFF0C\u6807\u51C6 I2C \u4E3B\u673A" },
        { l: "I2C \u4ECE\u673A", v: "slave", signals: ["SCL", "SDA"], hint: "CTLR1.SMBUS=0\uFF0C\u6807\u51C6 I2C \u4ECE\u673A" },
        {
          l: "SMBus \u4E3B\u673A / \u8BBE\u5907",
          v: "smbus",
          signals: ["SCL", "SDA", "SMBA"],
          required: ["SCL", "SDA"],
          hint: "CTLR1.SMBUS=1\uFF1B\u989D\u5916\u5F15\u51FA SMBA \u544A\u8B66\u7EBF\uFF08\u53EF\u9009\u5206\u914D\uFF0CX035 \u7CFB\u5217\u6CA1\u6709\u8FD9\u6839\u811A\uFF09\uFF0C\u652F\u6301\u8D85\u65F6\u4E0E PEC"
        }
      ],
      { group: "mode", hint: "CTLR1.SMBUS / SMBTYPE" }
    ),
    sel(
      "smbusRole",
      "SMBus \u89D2\u8272",
      "device",
      [
        { l: "\u8BBE\u5907\uFF08\u4ECE\uFF09", v: "device", hint: "CTLR1.SMBTYPE=0" },
        { l: "\u4E3B\u673A", v: "host", hint: "CTLR1.SMBTYPE=1\uFF0C\u53EF\u53D1\u8D77 SMBus \u4E3B\u673A\u4F20\u8F93" }
      ],
      { group: "param", visibleIf: { k: "mode", op: "=", v: "smbus" }, hint: "CTLR1.SMBTYPE" }
    ),
    sel(
      "speedMode",
      "\u901F\u7387\u6A21\u5F0F",
      "fast",
      [
        { l: "\u6807\u51C6\u6A21\u5F0F 100 kHz", v: "standard" },
        { l: "\u5FEB\u901F\u6A21\u5F0F 400 kHz", v: "fast" }
      ],
      { group: "param", hint: "CKCFGR.FS" }
    ),
    num("speed", "\u76EE\u6807\u901F\u7387", 400, 10, 1e3, {
      group: "param",
      unit: "kHz",
      formula: "CCR = fPCLK1 / (2 \xD7 \u901F\u7387)\uFF0CTRISE = \u5FEB\u901F\u6A21\u5F0F fPCLK1\xD7300ns + 1",
      hint: "\u6807\u51C6\u6A21\u5F0F\u4E0A\u9650 100 kHz\uFF0C\u5FEB\u901F\u6A21\u5F0F\u4E0A\u9650 400 kHz\uFF1B\u586B\u8D85\u4F1A\u81EA\u52A8\u9650\u5E45\u5E76\u7ED9\u51FA\u544A\u8B66"
    }),
    sel(
      "addrBits",
      "\u5BFB\u5740\u4F4D\u6570",
      "7",
      [
        { l: "7 \u4F4D", v: "7" },
        { l: "10 \u4F4D", v: "10" }
      ],
      { group: "param", visibleIf: I2C_AS_TARGET, hint: "OADDR1.ADDMODE" }
    ),
    num("ownAddr1", "\u672C\u673A\u5730\u5740 1", 48, 0, 1023, {
      group: "param",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR1\uFF0C7 \u4F4D\u5730\u5740\u5199 0x30 \u5373 0b0110000"
    }),
    bool("dualAddr", "\u542F\u7528\u7B2C\u4E8C\u5730\u5740", false, {
      group: "param",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR2.ENDUAL"
    }),
    num("ownAddr2", "\u672C\u673A\u5730\u5740 2", 49, 0, 1023, {
      group: "param",
      visibleIf: { k: "dualAddr", op: "=", v: true }
    }),
    bool("generalCall", "\u54CD\u5E94\u5E7F\u64AD\u5730\u5740 0x00", false, {
      group: "adv",
      visibleIf: I2C_AS_TARGET,
      hint: "OADDR1.ENGC"
    }),
    bool("noStretch", "\u7981\u6B62\u65F6\u949F\u5EF6\u5C55", false, {
      group: "adv",
      visibleIf: I2C_AS_TARGET,
      hint: "CTLR1.NOSTRETCH\uFF0C\u7F6E 1 \u540E\u4ECE\u673A\u5FD9\u65F6\u4E0D\u518D\u62C9\u4F4E SCL"
    }),
    bool("ackEnable", "\u81EA\u52A8\u5E94\u7B54 ACK", true, { group: "adv", hint: "CTLR1.ACK" }),
    num("digitalFilter", "\u6570\u5B57\u566A\u58F0\u6EE4\u6CE2", 0, 0, 15, {
      group: "adv",
      hint: "FLTR.DNF\uFF0C\u53EF\u6EE4\u9664\u5C0F\u4E8E DNF+1 \u4E2A PCLK \u7684\u5C16\u5CF0"
    }),
    bool("analogFilter", "\u6A21\u62DF\u566A\u58F0\u6EE4\u6CE2", true, { group: "adv", hint: "FLTR.ANOFF" }),
    bool("smbusAlert", "SMBA \u7528\u4F5C\u544A\u8B66\u8F93\u51FA", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "smbus" },
      hint: "CTLR1.SMBAL\uFF1B\u5206\u5230 SMBA \u811A\u4E4B\u540E\uFF0C\u4E3B\u673A\u6536\u5230\u544A\u8B66\u4F1A\u628A\u8BE5\u811A\u62C9\u4F4E"
    }),
    bool("smbusPec", "SMBus PEC \u6821\u9A8C", false, {
      group: "adv",
      visibleIf: { k: "mode", op: "=", v: "smbus" },
      hint: "CTLR1.ENPEC\uFF0C\u6309 SMBus \u89C4\u8303\u8FFD\u52A0\u5305\u9519\u8BEF\u7801"
    }),
    bool("irqEvt", "\u4E8B\u4EF6\u4E2D\u65AD (EVT)", false, { group: "irq", hint: "SB / ADDR / BTF / STOPF" }),
    bool("irqErr", "\u9519\u8BEF\u4E2D\u65AD (ERR)", false, { group: "irq", hint: "BERR / ARLO / AF / OVR" })
  ]
};
var tim = {
  modeKey: "clockSource",
  about: "\u5B9A\u65F6\u5668\u914D\u7F6E\u5206\u4E09\u5C42\uFF1A\u65F6\u57FA\uFF08PSC/ARR/\u8BA1\u6570\u6A21\u5F0F\uFF09\u2192 \u901A\u9053\uFF08PWM / \u8F93\u51FA\u6BD4\u8F83 / \u8F93\u5165\u6355\u83B7\uFF09\u2192 \u9AD8\u7EA7\u529F\u80FD\uFF08\u6B7B\u533A\u3001\u5239\u8F66\u3001\u4E3B\u4ECE\u89E6\u53D1\uFF09\u3002\u53F3\u4FA7\u5B9E\u65F6\u663E\u793A\u8BA1\u6570\u9891\u7387\u4E0E\u5468\u671F\u3002",
  groups: [g("base", "\u65F6\u57FA\u5355\u5143", true), g("adv", "\u9AD8\u7EA7\u63A7\u5236", false, true), g("irq", "\u4E2D\u65AD\u4E0E DMA")],
  panels: ["pins", "channelTable", "nvic", "dma"],
  params: [
    sel(
      "clockSource",
      "\u65F6\u949F\u6E90",
      "internal",
      [
        { l: "\u5185\u90E8\u65F6\u949F (CK_INT)", v: "internal" },
        { l: "\u5916\u90E8\u65F6\u949F\u6A21\u5F0F 1 (TI1/TI2)", v: "ext1" },
        { l: "\u5916\u90E8\u65F6\u949F\u6A21\u5F0F 2 (ETR)", v: "ext2" },
        { l: "\u7F16\u7801\u5668\u6A21\u5F0F (TI1+TI2)", v: "encoder", signals: ["CH1", "CH2"] }
      ],
      { group: "base", hint: "SMCFGR.ECE / SMS" }
    ),
    num("psc", "\u9884\u5206\u9891 PSC", 0, 0, 65535, {
      group: "base",
      formula: "fCNT = fCK_INT / (PSC + 1)",
      hint: "PSC \u5BC4\u5B58\u5668\uFF0C\u5B9E\u9645\u5206\u9891\u4E3A PSC+1"
    }),
    num("arr", "\u81EA\u52A8\u91CD\u88C5 ARR", 999, 0, 65535, {
      group: "base",
      formula: "T = (ARR + 1) / fCNT",
      hint: "ATRLR \u5BC4\u5B58\u5668\uFF1B\u4E2D\u5FC3\u5BF9\u9F50\u6A21\u5F0F\u4E0B\u5468\u671F\u4E3A 2\xD7ARR"
    }),
    sel(
      "counterMode",
      "\u8BA1\u6570\u6A21\u5F0F",
      "up",
      [
        { l: "\u5411\u4E0A\u8BA1\u6570", v: "up" },
        { l: "\u5411\u4E0B\u8BA1\u6570", v: "down" },
        { l: "\u4E2D\u5FC3\u5BF9\u9F50 1", v: "center1" },
        { l: "\u4E2D\u5FC3\u5BF9\u9F50 2", v: "center2" },
        { l: "\u4E2D\u5FC3\u5BF9\u9F50 3", v: "center3" }
      ],
      { group: "base", hint: "CTLR1.CMS / DIR" }
    ),
    sel(
      "ckd",
      "\u65F6\u949F\u5206\u9891",
      "1",
      [
        { l: "tDTS = tCK_INT", v: "1" },
        { l: "tDTS = 2 tCK_INT", v: "2" },
        { l: "tDTS = 4 tCK_INT", v: "4" }
      ],
      { group: "base", hint: "CTLR1.CKD\uFF0C\u5F71\u54CD\u8F93\u5165\u6EE4\u6CE2\u4E0E\u6B7B\u533A\u7CBE\u5EA6" }
    ),
    num("repetition", "\u91CD\u590D\u8BA1\u6570\u5668 RCR", 0, 0, 255, {
      group: "adv",
      hint: "\u4EC5\u9AD8\u7EA7\u5B9A\u65F6\u5668\u6709\u6548\uFF1BRCR=0 \u65F6\u6BCF\u6B21\u6EA2\u51FA\u90FD\u4EA7\u751F\u66F4\u65B0\u4E8B\u4EF6"
    }),
    bool("arpe", "\u81EA\u52A8\u91CD\u88C5\u9884\u88C5\u8F7D (ARPE)", true, { group: "base", hint: "CTLR1.ARPE\uFF0CPWM \u5FC5\u987B\u5F00\u542F\u624D\u80FD\u65E0\u6BDB\u523A\u6539\u5360\u7A7A\u6BD4" }),
    bool("onePulse", "\u5355\u8109\u51B2\u6A21\u5F0F", false, { group: "adv", hint: "CTLR1.OPM" }),
    bool("updateDisable", "\u7981\u7528\u66F4\u65B0\u4E8B\u4EF6", false, { group: "adv", hint: "CTLR1.UDIS" }),
    bool("updateRequest", "\u8F6F\u4EF6\u4EA7\u751F\u66F4\u65B0\u4E8B\u4EF6", false, { group: "adv", hint: "SWEVGR.UG" }),
    sel(
      "slaveMode",
      "\u4ECE\u6A21\u5F0F",
      "disable",
      [
        { l: "\u4E0D\u4F7F\u7528", v: "disable" },
        { l: "\u590D\u4F4D\u6A21\u5F0F", v: "reset" },
        { l: "\u95E8\u63A7\u6A21\u5F0F", v: "gated" },
        { l: "\u89E6\u53D1\u6A21\u5F0F", v: "trigger" }
      ],
      { group: "adv", hint: "SMCFGR.SMS" }
    ),
    sel(
      "triggerSource",
      "\u89E6\u53D1\u6E90",
      "ITR0",
      [
        { l: "ITR0", v: "ITR0" },
        { l: "ITR1", v: "ITR1" },
        { l: "ITR2", v: "ITR2" },
        { l: "ITR3", v: "ITR3" },
        { l: "TI1F_ED", v: "TI1F_ED" },
        { l: "TI1FP1", v: "TI1FP1" },
        { l: "TI2FP2", v: "TI2FP2" },
        { l: "ETRF", v: "ETRF" }
      ],
      { group: "adv", visibleIf: { k: "slaveMode", op: "!=", v: "disable" }, hint: "SMCFGR.TS" }
    ),
    bool("breakEnable", "\u5239\u8F66\u529F\u80FD (BRK)", false, { group: "adv", hint: "BDTR.BKE\uFF0C\u7528\u4E8E\u7535\u673A\u9A71\u52A8\u8FC7\u6D41\u4FDD\u62A4" }),
    sel(
      "breakPolarity",
      "\u5239\u8F66\u6781\u6027",
      "low",
      [
        { l: "\u4F4E\u7535\u5E73\u6709\u6548", v: "low" },
        { l: "\u9AD8\u7535\u5E73\u6709\u6548", v: "high" }
      ],
      { group: "adv", visibleIf: { k: "breakEnable", op: "=", v: true }, hint: "BDTR.BKP" }
    ),
    bool("automaticOutput", "\u5239\u8F66\u540E\u81EA\u52A8\u6062\u590D\u8F93\u51FA (AOE)", false, {
      group: "adv",
      visibleIf: { k: "breakEnable", op: "=", v: true },
      hint: "BDTR.AOE"
    }),
    num("deadTime", "\u6B7B\u533A\u65F6\u95F4", 0, 0, 1e3, {
      group: "adv",
      unit: "ns",
      formula: "DTG \u7F16\u7801\uFF1A0~127\xD7tDTS / 64~127\xD72tDTS / ...",
      hint: "BDTR.DTG\uFF0C\u4E92\u8865 PWM \u5FC5\u987B\u8BBE\u7F6E\uFF0C\u9632\u6B62\u4E0A\u4E0B\u7BA1\u76F4\u901A"
    }),
    bool("irqUpdate", "\u66F4\u65B0\u4E2D\u65AD (UIE)", false, { group: "irq" }),
    bool("irqCC1", "\u6355\u83B7\u6BD4\u8F83 1 (CC1IE)", false, { group: "irq" }),
    bool("irqCC2", "\u6355\u83B7\u6BD4\u8F83 2 (CC2IE)", false, { group: "irq" }),
    bool("irqCC3", "\u6355\u83B7\u6BD4\u8F83 3 (CC3IE)", false, { group: "irq" }),
    bool("irqCC4", "\u6355\u83B7\u6BD4\u8F83 4 (CC4IE)", false, { group: "irq" }),
    bool("irqBreak", "\u5239\u8F66\u4E2D\u65AD (BIE)", false, { group: "irq", visibleIf: { k: "breakEnable", op: "=", v: true } })
  ],
  channelSpec: {
    label: "\u901A\u9053\u914D\u7F6E",
    count: 4,
    prefix: "CH",
    needsPin: true,
    hint: "\u6BCF\u4E2A\u901A\u9053\u53EF\u72EC\u7ACB\u8BBE\u4E3A\u8F93\u51FA\u6BD4\u8F83\u3001PWM \u8F93\u51FA\u6216\u8F93\u5165\u6355\u83B7\uFF1B\u4E92\u8865\u8F93\u51FA\u4F1A\u81EA\u52A8\u5360\u7528 CHxN \u5F15\u811A\u3002",
    modes: [
      { label: "\u5173\u95ED", value: "disable" },
      { label: "PWM \u8F93\u51FA", value: "pwm", signals: ["PWM"] },
      { label: "\u8F93\u51FA\u6BD4\u8F83", value: "oc" },
      { label: "\u8F93\u5165\u6355\u83B7", value: "ic" },
      { label: "\u5F3A\u5236\u8F93\u51FA", value: "forced" }
    ],
    params: [
      sel(
        "pwmMode",
        "PWM \u6A21\u5F0F",
        "1",
        [
          { l: "PWM \u6A21\u5F0F 1\uFF08\u8BA1\u6570\u503C < CCR \u65F6\u6709\u6548\uFF09", v: "1" },
          { l: "PWM \u6A21\u5F0F 2\uFF08\u8BA1\u6570\u503C < CCR \u65F6\u65E0\u6548\uFF09", v: "2" }
        ],
        { visibleIf: { k: "@mode", op: "=", v: "pwm" }, hint: "CCMRx.OCxM = 110 / 111" }
      ),
      num("pulse", "\u6BD4\u8F83\u503C CCR", 500, 0, 65535, {
        visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc"] },
        formula: "\u5360\u7A7A\u6BD4 = CCR / (ARR + 1)",
        hint: "CHxCV \u5BC4\u5B58\u5668"
      }),
      sel(
        "polarity",
        "\u8F93\u51FA\u6781\u6027",
        "high",
        [
          { l: "\u9AD8\u7535\u5E73\u6709\u6548", v: "high" },
          { l: "\u4F4E\u7535\u5E73\u6709\u6548", v: "low" }
        ],
        { visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc", "forced"] }, hint: "CCER.CCxP" }
      ),
      sel(
        "idleState",
        "\u7A7A\u95F2\u7535\u5E73",
        "reset",
        [
          { l: "\u590D\u4F4D\uFF08\u4F4E\uFF09", v: "reset" },
          { l: "\u7F6E\u4F4D\uFF08\u9AD8\uFF09", v: "set" }
        ],
        { visibleIf: { k: "@mode", op: "in", v: ["pwm", "oc"] }, hint: "CR2.OISx" }
      ),
      bool("complementary", "\u4E92\u8865\u8F93\u51FA (CHxN)", false, {
        visibleIf: { k: "@mode", op: "=", v: "pwm" },
        hint: "CCER.CCxNE\uFF0C\u9700\u8981\u9AD8\u7EA7\u5B9A\u65F6\u5668"
      }),
      sel(
        "icPrescaler",
        "\u6355\u83B7\u9884\u5206\u9891",
        "1",
        [
          { l: "\u6BCF 1 \u4E2A\u4E8B\u4EF6", v: "1" },
          { l: "\u6BCF 2 \u4E2A\u4E8B\u4EF6", v: "2" },
          { l: "\u6BCF 4 \u4E2A\u4E8B\u4EF6", v: "4" },
          { l: "\u6BCF 8 \u4E2A\u4E8B\u4EF6", v: "8" }
        ],
        { visibleIf: { k: "@mode", op: "=", v: "ic" }, hint: "CCMRx.ICxPSC" }
      ),
      num("icFilter", "\u8F93\u5165\u6EE4\u6CE2", 0, 0, 15, {
        visibleIf: { k: "@mode", op: "=", v: "ic" },
        hint: "CCMRx.ICxF\uFF0C\u4EE5 fDTS \u91C7\u6837\uFF0C\u6570\u503C\u8D8A\u5927\u6297\u566A\u8D8A\u5F3A"
      }),
      sel(
        "icPolarity",
        "\u6355\u83B7\u8FB9\u6CBF",
        "rising",
        [
          { l: "\u4E0A\u5347\u6CBF", v: "rising" },
          { l: "\u4E0B\u964D\u6CBF", v: "falling" },
          { l: "\u53CC\u8FB9\u6CBF", v: "both" }
        ],
        { visibleIf: { k: "@mode", op: "=", v: "ic" }, hint: "CCER.CCxP / CCxNP" }
      )
    ]
  }
};
var adc = {
  about: "ADC \u652F\u6301\u89C4\u5219\u7EC4\u4E0E\u6CE8\u5165\u7EC4\u3001\u626B\u63CF\u3001\u8FDE\u7EED\u8F6C\u6362\u3001\u5916\u90E8\u89E6\u53D1\u4E0E\u6A21\u62DF\u770B\u95E8\u72D7\u3002\u91C7\u6837\u65F6\u95F4\u6309\u901A\u9053\u72EC\u7ACB\u8BBE\u7F6E\uFF0C\u91C7\u6837\u5468\u671F\u8D8A\u957F\u6E90\u963B\u6297\u5BB9\u5FCD\u5EA6\u8D8A\u9AD8\u3002",
  groups: [g("base", "\u57FA\u672C\u914D\u7F6E", true), g("adv", "\u9AD8\u7EA7\u914D\u7F6E", false, true), g("irq", "\u4E2D\u65AD\u4E0E DMA")],
  panels: ["adcTable", "nvic", "dma"],
  params: [
    num("clockDiv", "ADC \u65F6\u949F\u5206\u9891", 6, 2, 8, {
      group: "base",
      formula: "fADC = fPCLK2 / \u5206\u9891",
      hint: "ADCCLK \u4E0D\u5F97\u8D85\u8FC7 14 MHz\uFF0C\u5426\u5219\u8F6C\u6362\u7CBE\u5EA6\u4E0B\u964D"
    }),
    sel(
      "dataAlign",
      "\u6570\u636E\u5BF9\u9F50",
      "right",
      [
        { l: "\u53F3\u5BF9\u9F50", v: "right" },
        { l: "\u5DE6\u5BF9\u9F50", v: "left" }
      ],
      { group: "base", hint: "CTLR2.ALIGN" }
    ),
    sel(
      "scanMode",
      "\u626B\u63CF\u6A21\u5F0F",
      "disable",
      [
        { l: "\u5173\u95ED\uFF08\u5355\u901A\u9053\uFF09", v: "disable" },
        { l: "\u5F00\u542F\uFF08\u591A\u901A\u9053\u5E8F\u5217\uFF09", v: "enable" }
      ],
      { group: "base", hint: "CTLR1.SCAN" }
    ),
    sel(
      "continuous",
      "\u8FDE\u7EED\u8F6C\u6362",
      "disable",
      [
        { l: "\u5355\u6B21", v: "disable" },
        { l: "\u8FDE\u7EED", v: "enable" }
      ],
      { group: "base", hint: "CTLR2.CONT" }
    ),
    sel(
      "externalTrig",
      "\u5916\u90E8\u89E6\u53D1\u6E90",
      "none",
      [
        { l: "\u8F6F\u4EF6\u89E6\u53D1", v: "none" },
        { l: "TIM1_CC1", v: "TIM1_CC1" },
        { l: "TIM1_CC2", v: "TIM1_CC2" },
        { l: "TIM1_CC3", v: "TIM1_CC3" },
        { l: "TIM2_CC2", v: "TIM2_CC2" },
        { l: "TIM3_TRGO", v: "TIM3_TRGO" },
        { l: "EXTI_11", v: "EXTI_11" }
      ],
      { group: "base", hint: "CTLR2.EXTSEL / EXTTRIG" }
    ),
    sel(
      "sampleTime",
      "\u5168\u5C40\u91C7\u6837\u65F6\u95F4",
      "55.5",
      [
        { l: "1.5 \u5468\u671F", v: "1.5" },
        { l: "7.5 \u5468\u671F", v: "7.5" },
        { l: "13.5 \u5468\u671F", v: "13.5" },
        { l: "28.5 \u5468\u671F", v: "28.5" },
        { l: "41.5 \u5468\u671F", v: "41.5" },
        { l: "55.5 \u5468\u671F", v: "55.5" },
        { l: "71.5 \u5468\u671F", v: "71.5" },
        { l: "239.5 \u5468\u671F", v: "239.5" }
      ],
      { group: "base", hint: "SAMPTR1/2 \u7684 SMPx \u4F4D\uFF0C\u53EF\u5728\u901A\u9053\u8868\u91CC\u5355\u72EC\u8986\u76D6" }
    ),
    bool("watchdog", "\u6A21\u62DF\u770B\u95E8\u72D7", false, { group: "adv", hint: "CTLR1.AWDEN" }),
    num("wdHigh", "\u770B\u95E8\u72D7\u4E0A\u9650", 4095, 0, 4095, { group: "adv", visibleIf: { k: "watchdog", op: "=", v: true } }),
    num("wdLow", "\u770B\u95E8\u72D7\u4E0B\u9650", 0, 0, 4095, { group: "adv", visibleIf: { k: "watchdog", op: "=", v: true } }),
    bool("injected", "\u542F\u7528\u6CE8\u5165\u7EC4", false, { group: "adv", hint: "\u53EF\u6253\u65AD\u89C4\u5219\u7EC4\u8F6C\u6362\uFF0C\u7528\u4E8E\u7535\u6D41\u73AF\u91C7\u6837" }),
    bool("tempSensor", "\u5185\u90E8\u6E29\u5EA6\u4F20\u611F\u5668", false, { group: "adv", hint: "\u5360\u7528 ADC_IN16" }),
    bool("vrefint", "\u5185\u90E8\u57FA\u51C6 VREFINT", false, { group: "adv", hint: "\u5360\u7528 ADC_IN17\uFF0C\u53EF\u53CD\u63A8 VDDA" }),
    bool("dmaCircular", "DMA \u5FAA\u73AF\u6A21\u5F0F", true, { group: "irq", hint: "\u591A\u901A\u9053\u626B\u63CF\u65F6\u51E0\u4E4E\u5FC5\u5F00" }),
    bool("irqEoc", "\u8F6C\u6362\u5B8C\u6210 (EOC)", false, { group: "irq" }),
    bool("irqAwd", "\u770B\u95E8\u72D7\u8D8A\u754C (AWD)", false, { group: "irq" })
  ],
  channelSpec: {
    label: "\u901A\u9053",
    count: 8,
    prefix: "IN",
    needsPin: true,
    hint: "ADC \u7684\u300C\u901A\u9053\u300D\u5C31\u662F\u300C\u5F15\u811A\u300D\u2014\u2014 \u4E00\u4E2A INx \u5BF9\u5E94\u4E00\u6839\u7269\u7406\u5F15\u811A\uFF0C\u6240\u4EE5\u8FD9\u91CC\u4E0D\u518D\u5355\u8BBE\u5F15\u811A\u9875\u3002\u52FE\u9009\u901A\u9053\u540E\u5728\u540C\u4E00\u5F20\u5361\u7247\u91CC\u6311\u5F15\u811A\uFF1B\u52FE\u9009\u7684\u5148\u540E\u987A\u5E8F\u5C31\u662F\u89C4\u5219\u7EC4\u7684\u8F6C\u6362\u5E8F\u5217\uFF08rank\uFF09\uFF0C\u6BCF\u4E2A\u901A\u9053\u53EF\u5355\u72EC\u8986\u76D6\u91C7\u6837\u65F6\u95F4\u3002",
    modes: [
      { label: "\u5173\u95ED", value: "disable" },
      { label: "\u89C4\u5219\u7EC4", value: "regular" },
      { label: "\u6CE8\u5165\u7EC4", value: "injected" }
    ],
    params: [
      sel(
        "sampleTime",
        "\u91C7\u6837\u65F6\u95F4",
        "55.5",
        [
          { l: "1.5 \u5468\u671F", v: "1.5" },
          { l: "7.5 \u5468\u671F", v: "7.5" },
          { l: "13.5 \u5468\u671F", v: "13.5" },
          { l: "28.5 \u5468\u671F", v: "28.5" },
          { l: "55.5 \u5468\u671F", v: "55.5" },
          { l: "71.5 \u5468\u671F", v: "71.5" },
          { l: "239.5 \u5468\u671F", v: "239.5" }
        ],
        { hint: "SAMPTR.SMP\uFF0C\u8986\u76D6\u5168\u5C40\u8BBE\u7F6E" }
      )
    ]
  }
};
var iwdg = {
  about: "\u72EC\u7ACB\u770B\u95E8\u72D7\u7531\u5185\u90E8 LSI\uFF08\u7EA6 40 kHz\uFF09\u9A71\u52A8\uFF0C\u4E00\u65E6\u542F\u52A8\u65E0\u6CD5\u5173\u95ED\uFF0C\u53EA\u80FD\u590D\u4F4D\u82AF\u7247\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: [],
  params: [
    num("prescaler", "\u9884\u5206\u9891", 64, 4, 256, { group: "base", hint: "IWDG_PSCR\uFF0C\u53D6\u503C 4/8/16/32/64/128/256" }),
    num("reload", "\u91CD\u88C5\u503C", 4095, 0, 4095, { group: "base", formula: "T = \u9884\u5206\u9891 \xD7 (\u91CD\u88C5\u503C+1) / 40000" })
  ]
};
var wwdg = {
  about: "\u7A97\u53E3\u770B\u95E8\u72D7\u7531 APB1 \u65F6\u949F\u9A71\u52A8\uFF0C\u5FC5\u987B\u5728\u7A97\u53E3\u5185\u5582\u72D7\uFF0C\u5582\u65E9\u4E86\u540C\u6837\u590D\u4F4D\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: ["nvic"],
  params: [
    num("prescaler", "\u9884\u5206\u9891", 8, 1, 8, { group: "base", hint: "CFR.WDGTB\uFF0C2 \u7684\u5E42\u6B21 1~8" }),
    num("window", "\u7A97\u53E3\u503C W", 80, 0, 127, { group: "base", hint: "CFR.W\uFF0C\u5FC5\u987B\u5927\u4E8E 0x40" }),
    num("counter", "\u8BA1\u6570\u5668\u521D\u503C", 127, 0, 127, { group: "base", hint: "CR.T\uFF0C\u9012\u51CF\u8BA1\u6570" })
  ]
};
var rtc = {
  about: "RTC \u53EF\u7531 LSI \u6216 LSE \u9A71\u52A8\uFF0C\u63D0\u4F9B\u65E5\u5386\u3001\u95F9\u949F\u4E0E\u5468\u671F\u5524\u9192\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: ["nvic"],
  params: [
    sel(
      "clockSource",
      "\u65F6\u949F\u6E90",
      "lsi",
      [
        { l: "LSI \u5185\u90E8\u4F4E\u901F", v: "lsi" },
        { l: "LSE \u5916\u90E8 32.768 kHz", v: "lse" }
      ],
      { group: "base", hint: "BDCTLR.RTCSEL" }
    ),
    num("asyncPrescaler", "\u5F02\u6B65\u9884\u5206\u9891", 127, 0, 1048575, { group: "base", hint: "RTC_PSCRL" }),
    num("syncPrescaler", "\u540C\u6B65\u9884\u5206\u9891", 255, 0, 65535, { group: "base", hint: "RTC_PSCRH" }),
    bool("alarmA", "\u95F9\u949F A", false, { group: "base" }),
    bool("wakeup", "\u5468\u671F\u5524\u9192", false, { group: "base" }),
    bool("irqAlarm", "\u95F9\u949F\u4E2D\u65AD", false, { group: "base" })
  ]
};
var pwr = {
  about: "\u7535\u6E90\u63A7\u5236\u51B3\u5B9A\u4F4E\u529F\u8017\u6A21\u5F0F\u4E0E\u8C03\u538B\u5668\u72B6\u6001\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: [],
  params: [
    sel(
      "mode",
      "\u4F4E\u529F\u8017\u6A21\u5F0F",
      "none",
      [
        { l: "\u4E0D\u542F\u7528", v: "none" },
        { l: "Sleep \u7761\u7720", v: "sleep" },
        { l: "Stop \u505C\u6B62", v: "stop" },
        { l: "Standby \u5F85\u673A", v: "standby" }
      ],
      { group: "base", hint: "PWR_CTLR.LPDS / PDDS" }
    ),
    bool("pvd", "\u7535\u538B\u76D1\u6D4B PVD", false, { group: "base", hint: "PWR_CTLR.PVDE" }),
    sel(
      "pvdLevel",
      "PVD \u9608\u503C",
      "2.9",
      [
        { l: "2.2 V", v: "2.2" },
        { l: "2.4 V", v: "2.4" },
        { l: "2.6 V", v: "2.6" },
        { l: "2.9 V", v: "2.9" }
      ],
      { group: "base", visibleIf: { k: "pvd", op: "=", v: true } }
    )
  ]
};
var exti = {
  about: "\u5916\u90E8\u4E2D\u65AD\u6309\u7EBF\u914D\u7F6E\uFF1A\u6BCF\u4E2A GPIO \u7684 PXn \u56FA\u5B9A\u5BF9\u5E94 EXTIn\uFF0C\u4E00\u6761\u7EBF\u540C\u4E00\u65F6\u523B\u53EA\u80FD\u63A5\u4E00\u4E2A\u5F15\u811A\u3002\u5728\u5F15\u811A\u56FE\u4E0A\u70B9 PXn \u4E5F\u80FD\u76F4\u63A5\u9009 EXTIn\u3002",
  groups: [g("base", "\u516C\u5171\u53C2\u6570", true)],
  panels: ["nvic", "channelTable"],
  params: [
    bool("eventMode", "\u4E8B\u4EF6\u6A21\u5F0F\uFF08\u53EA\u4EA7\u751F\u4E8B\u4EF6\uFF0C\u4E0D\u8FDB\u5165\u4E2D\u65AD\uFF09", false, {
      group: "base",
      hint: "EXTI_EVCR\uFF1B\u4E0D\u5360\u7528 NVIC"
    }),
    bool("afioRemap", "\u4F7F\u80FD AFIO \u65F6\u949F", true, {
      group: "base",
      hint: "RCC_APB2Periph_AFIO\uFF0CWCH \u7684 EXTI \u7EBF\u6620\u5C04\u6302\u5728 AFIO \u4E0A"
    })
  ],
  channelSpec: {
    label: "\u4E2D\u65AD\u7EBF",
    count: 24,
    prefix: "LINE",
    startAt: 0,
    needsPin: true,
    hint: "EXTIn \u53EA\u80FD\u63A5 PXn\uFF08n \u4E3A\u5F15\u811A\u5E8F\u53F7\uFF09\u3002\u6BCF\u6761\u7EBF\u5355\u72EC\u8BBE\u7F6E\u89E6\u53D1\u8FB9\u6CBF\uFF0C\u8D85\u51FA\u5F53\u524D\u5668\u4EF6\u7EBF\u6570\u7684\u4F1A\u6807\u300C\u4E0D\u53EF\u7528\u300D\u3002",
    modes: [
      { label: "\u5173\u95ED", value: "disable" },
      { label: "\u4E0A\u5347\u6CBF", value: "rising" },
      { label: "\u4E0B\u964D\u6CBF", value: "falling" },
      { label: "\u53CC\u8FB9\u6CBF", value: "both" }
    ]
  }
};
var crc = {
  about: "\u786C\u4EF6 CRC \u5355\u5143\uFF0C\u53EF\u505A Flash \u5B8C\u6574\u6027\u6821\u9A8C\u4E0E\u901A\u4FE1\u6821\u9A8C\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: [],
  params: [
    num("poly", "\u751F\u6210\u591A\u9879\u5F0F", 79764919, 0, 4294967295, { group: "base", hint: "\u9ED8\u8BA4 CRC-32 \u591A\u9879\u5F0F" }),
    num("init", "\u521D\u59CB\u503C", 4294967295, 0, 4294967295, { group: "base" }),
    bool("inputReverse", "\u8F93\u5165\u53CD\u8F6C", false, { group: "base" }),
    bool("outputReverse", "\u8F93\u51FA\u53CD\u8F6C", false, { group: "base" })
  ]
};
var clk = {
  modeKey: "hse",
  about: "\u5916\u90E8\u6676\u632F\u914D\u7F6E\u3002OSC_IN / OSC_OUT \u63A5 HSE \u9AD8\u901F\u6676\u4F53\uFF084\u201324 MHz\uFF09\uFF0CPC14 / PC15 \u63A5 LSE 32.768 kHz \u6676\u4F53\u3002\u9891\u7387\u4E0E PLL \u500D\u9891\u8BF7\u5230\u300C\u65F6\u949F\u6811\u300D\u9875\u8BBE\u7F6E\uFF0C\u8FD9\u91CC\u53EA\u51B3\u5B9A\u6676\u632F\u662F\u5426\u542F\u7528\u3001\u662F\u5426\u65C1\u8DEF\u3002",
  groups: [g("hse", "HSE \u5916\u90E8\u9AD8\u901F\u6676\u632F", true), g("lse", "LSE \u5916\u90E8\u4F4E\u901F\u6676\u632F", true)],
  panels: ["pins"],
  params: [
    sel(
      "hse",
      "HSE \u9A71\u52A8\u65B9\u5F0F",
      "off",
      [
        { l: "\u5173\u95ED", v: "off" },
        { l: "\u6676\u4F53\u632F\u8361\u5668", v: "crystal", signals: ["HSE_IN", "HSE_OUT"], hint: "\u5916\u63A5 4\u201324 MHz \u77F3\u82F1\u6676\u4F53 + \u4E24\u4E2A\u8D1F\u8F7D\u7535\u5BB9" },
        { l: "\u65C1\u8DEF\u65F6\u949F\uFF08Bypass\uFF09", v: "bypass", signals: ["HSE_IN"], hint: "OSC_IN \u76F4\u63A5\u8F93\u5165\u5916\u90E8\u65B9\u6CE2\uFF0COSC_OUT \u60AC\u7A7A" }
      ],
      { group: "hse", hint: "RCC_CTLR.HSEON / HSEBYP" }
    ),
    bool("waitHse", "\u7B49\u5F85 HSERDY \u5C31\u7EEA", true, {
      group: "hse",
      visibleIf: { k: "hse", op: "!=", v: "off" },
      hint: "\u6253\u5F00\u540E\u5361\u5728 while \u91CC\u7B49\u6676\u632F\u8D77\u632F\uFF1B\u8D77\u632F\u5931\u8D25\u4F1A\u6B7B\u7B49\uFF0C\u91CF\u4EA7\u56FA\u4EF6\u5EFA\u8BAE\u6539\u6210\u5E26\u8D85\u65F6"
    }),
    sel(
      "lse",
      "LSE \u9A71\u52A8\u65B9\u5F0F",
      "off",
      [
        { l: "\u5173\u95ED", v: "off" },
        { l: "\u6676\u4F53\u632F\u8361\u5668 32.768 kHz", v: "crystal", signals: ["LSE_IN", "LSE_OUT"] },
        { l: "\u65C1\u8DEF\u65F6\u949F\uFF08Bypass\uFF09", v: "bypass", signals: ["LSE_IN"] }
      ],
      { group: "lse", hint: "RCC_BDCTLR.LSEON / LSEBYP\uFF0C\u7528\u4E8E RTC \u8D70\u65F6" }
    ),
    bool("waitLse", "\u7B49\u5F85 LSERDY \u5C31\u7EEA", true, {
      group: "lse",
      visibleIf: { k: "lse", op: "!=", v: "off" }
    })
  ]
};
var usb = {
  modeKey: "speed",
  about: "USB \u8BBE\u5907\u63A7\u5236\u5668\uFF0C\u652F\u6301\u5168\u901F / \u9AD8\u901F\u3001\u591A\u79CD\u7AEF\u70B9\u914D\u7F6E\u3002",
  groups: [g("base", "\u53C2\u6570", true), g("irq", "\u4E2D\u65AD")],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "speed",
      "\u901F\u5EA6",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "Full Speed \u5168\u901F 12 Mbps", v: "fs", signals: ["DP", "DM"] },
        { l: "High Speed \u9AD8\u901F 480 Mbps", v: "hs", signals: ["DP", "DM"] }
      ],
      { group: "base" }
    ),
    num("ep0Size", "\u7AEF\u70B9 0 \u5927\u5C0F", 64, 8, 64, { group: "base", hint: "\u4EC5\u652F\u6301 8/16/32/64" }),
    num("epNum", "\u7AEF\u70B9\u6570\u91CF", 4, 1, 8, { group: "base" }),
    bool("sof", "\u5E27\u9996\u4E2D\u65AD (SOF)", false, { group: "irq" }),
    bool("reset", "\u603B\u7EBF\u590D\u4F4D\u4E2D\u65AD", true, { group: "irq" })
  ]
};
var usbpd = {
  modeKey: "role",
  about: "USB PD \u63A7\u5236\u5668\u63A5\u5728 Type-C \u7684 CC1 / CC2 \u4E0A\uFF08\u4E0D\u662F DP/DM\uFF09\uFF0C\u8D1F\u8D23 BMC \u7F16\u89E3\u7801\u4E0E PD \u62A5\u6587\u3002\u4E24\u6839 CC \u90FD\u8981\u5F15\u51FA\u6765\u624D\u80FD\u81EA\u52A8\u8BC6\u522B\u6B63\u53CD\u63D2\uFF1B\u53EA\u505A\u56FA\u5B9A\u65B9\u5411\u7684\u53D7\u7535\u7AEF\u65F6\u4E5F\u53EF\u4EE5\u53EA\u63A5 CC1\u3002",
  groups: [g("base", "\u89D2\u8272\u4E0E\u62A5\u6587", true), g("adv", "\u9AD8\u7EA7", false, true), g("irq", "\u4E2D\u65AD")],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "role",
      "\u89D2\u8272",
      "disable",
      [
        { l: "Disable", v: "disable" },
        {
          l: "Sink \u53D7\u7535\u7AEF\uFF08\u8BBE\u5907\uFF09",
          v: "sink",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "\u4ECE\u9002\u914D\u5668\u53D6\u7535\uFF1BRd \u4E0B\u62C9\u7531 PHY \u63A7\u5236\uFF0CCC1/CC2 \u90FD\u8981\u63A5\u624D\u80FD\u8BC6\u522B\u6B63\u53CD\u63D2"
        },
        {
          l: "Source \u4F9B\u7535\u7AEF\uFF08\u4E3B\u673A\uFF09",
          v: "source",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "\u5BF9\u5916\u4F9B\u7535\uFF1BRp \u4E0A\u62C9\u7535\u963B\u51B3\u5B9A\u5E7F\u64AD\u7684\u7535\u6D41\u6863\u4F4D"
        },
        {
          l: "DRP \u53CC\u89D2\u8272",
          v: "drp",
          signals: ["CC1", "CC2"],
          required: ["CC1", "CC2"],
          hint: "\u6309\u8FDE\u63A5\u5BF9\u65B9\u81EA\u52A8\u5207\u6362 Source / Sink"
        }
      ],
      { group: "base", hint: "PD_CTLR \u7684 CC \u89D2\u8272\u4F4D" }
    ),
    sel(
      "pdVersion",
      "\u534F\u8BAE\u7248\u672C",
      "pd3",
      [
        { l: "USB PD 3.0", v: "pd3" },
        { l: "USB PD 2.0", v: "pd2" }
      ],
      { group: "base", visibleIf: { k: "role", op: "!=", v: "disable" }, hint: "\u5F71\u54CD\u62A5\u6587\u5934\u4E0E PPS \u652F\u6301" }
    ),
    num("pdoVoltage", "\u9ED8\u8BA4\u8F93\u51FA\u7535\u538B", 5, 5, 20, {
      group: "base",
      unit: "V",
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "Source \u4E0A\u7535\u540E\u5E7F\u64AD\u7684 PDO \u7535\u538B\uFF085 / 9 / 12 / 15 / 20 V\uFF09"
    }),
    num("pdoCurrent", "\u9ED8\u8BA4\u8F93\u51FA\u7535\u6D41", 3, 0.5, 5, {
      group: "base",
      unit: "A",
      step: 0.25,
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "\u51B3\u5B9A Rp \u5E7F\u64AD\u7684\u7535\u6D41\u6863\u4F4D\uFF1A\u9ED8\u8BA4 / 1.5 A / 3 A"
    }),
    bool("autoPolarity", "\u81EA\u52A8\u8BC6\u522B CC \u6781\u6027", true, {
      group: "base",
      visibleIf: { k: "role", op: "!=", v: "disable" },
      hint: "\u6B63\u63D2\u63A5 CC1\u3001\u53CD\u63D2\u63A5 CC2\uFF0C\u786C\u4EF6\u81EA\u52A8\u5207\u6362"
    }),
    bool("vconn", "\u8F93\u51FA VCONN", false, {
      group: "adv",
      visibleIf: { k: "role", op: "in", v: ["source", "drp"] },
      hint: "\u7ED9\u7EBF\u7F06\u91CC\u7684 E-Marker \u4F9B\u7535\uFF085 V / 1 W\uFF09"
    }),
    bool("pdHardReset", "\u6536\u5230 Hard Reset \u81EA\u52A8\u8F6F\u590D\u4F4D", true, {
      group: "adv",
      visibleIf: { k: "role", op: "!=", v: "disable" }
    }),
    bool("irqCc", "CC \u72B6\u6001\u53D8\u5316\u4E2D\u65AD", true, { group: "irq" }),
    bool("irqPd", "PD \u62A5\u6587\u6536/\u53D1\u4E2D\u65AD", true, { group: "irq" })
  ]
};
var can = {
  about: "CAN \u63A7\u5236\u5668\uFF0C\u652F\u6301\u6807\u51C6\u5E27 / \u6269\u5C55\u5E27\u4E0E\u56DE\u73AF\u81EA\u6D4B\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: ["pins", "nvic"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u6B63\u5E38\u6A21\u5F0F", v: "normal", signals: ["TX", "RX"] },
        { l: "\u56DE\u73AF\u6A21\u5F0F", v: "loopback", signals: ["TX", "RX"] },
        { l: "\u9759\u9ED8\u6A21\u5F0F", v: "silent", signals: ["TX", "RX"] }
      ],
      { group: "base" }
    ),
    num("prescaler", "\u6CE2\u7279\u7387\u9884\u5206\u9891", 4, 1, 1024, { group: "base" }),
    num("bs1", "BS1", 8, 1, 16, { group: "base" }),
    num("bs2", "BS2", 3, 1, 8, { group: "base" }),
    num("sjw", "SJW", 1, 1, 4, { group: "base" })
  ]
};
var opa = {
  about: "\u7247\u5185\u8FD0\u7B97\u653E\u5927\u5668\uFF0C\u53EF\u914D\u7F6E\u4E3A\u72EC\u7ACB\u8FD0\u653E\u3001\u8DDF\u968F\u5668\u6216 PGA\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u72EC\u7ACB\u8FD0\u653E", v: "standalone", signals: ["INP", "INM", "OUT"] },
        { l: "\u7535\u538B\u8DDF\u968F\u5668", v: "follower", signals: ["INP", "OUT"] },
        { l: "\u53EF\u7F16\u7A0B\u589E\u76CA PGA", v: "pga", signals: ["INP", "OUT"] }
      ],
      { group: "base" }
    ),
    sel(
      "gain",
      "\u589E\u76CA",
      "2",
      [
        { l: "\xD72", v: "2" },
        { l: "\xD74", v: "4" },
        { l: "\xD78", v: "8" },
        { l: "\xD716", v: "16" },
        { l: "\xD732", v: "32" }
      ],
      { group: "base", visibleIf: { k: "mode", op: "=", v: "pga" } }
    )
  ]
};
var cmp = {
  about: "\u6A21\u62DF\u6BD4\u8F83\u5668\uFF0C\u8F93\u51FA\u53EF\u9001\u5230\u5B9A\u65F6\u5668\u5239\u8F66\u6216\u5916\u90E8\u4E2D\u65AD\u3002",
  groups: [g("base", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u542F\u7528", v: "enable", signals: ["INP", "INM", "OUT"] }
      ],
      { group: "base" }
    ),
    sel(
      "polarity",
      "\u8F93\u51FA\u6781\u6027",
      "normal",
      [
        { l: "\u540C\u76F8", v: "normal" },
        { l: "\u53CD\u76F8", v: "invert" }
      ],
      { group: "base" }
    ),
    sel(
      "hysteresis",
      "\u8FDF\u6EDE",
      "none",
      [
        { l: "\u65E0", v: "none" },
        { l: "\u4F4E", v: "low" },
        { l: "\u4E2D", v: "mid" },
        { l: "\u9AD8", v: "high" }
      ],
      { group: "base" }
    )
  ]
};
var dbg = {
  modeKey: "iface",
  about: "\u8C03\u8BD5\u63A5\u53E3\u3002\u590D\u4F4D\u540E SDI \u9ED8\u8BA4\u5F00\u542F\u5E76\u5360\u7528 SWDIO / SWCLK \u4E24\u4E2A\u5F15\u811A\uFF1B\u5173\u6389\u4E4B\u540E\u8FD9\u4E24\u4E2A\u811A\u53EF\u4EE5\u5F53\u666E\u901A GPIO \u7528\uFF08\u4EE3\u4EF7\u662F\u6CA1\u6CD5\u518D\u8FDE\u8C03\u8BD5\u5668\uFF09\u3002\u4E0B\u9762\u7684\u300C\u8C03\u8BD5\u65F6\u51BB\u7ED3\u300D\u53EA\u5728\u63A5\u8C03\u8BD5\u5668\u65F6\u751F\u6548\uFF0C\u4E0D\u5F71\u54CD\u8131\u673A\u8FD0\u884C\u3002",
  groups: [g("iface", "\u63A5\u53E3", true), g("freeze", "\u8C03\u8BD5\u65F6\u51BB\u7ED3", false, true)],
  panels: ["pins"],
  params: [
    sel(
      "iface",
      "\u63A5\u53E3\u7C7B\u578B",
      "sdio2",
      [
        { l: "2 \u7EBF SDI\uFF08SWDIO + SWCLK\uFF09", v: "sdio2", signals: ["SWDIO", "SWCLK"], hint: "\u590D\u4F4D\u9ED8\u8BA4\u72B6\u6001\uFF0C\u53EF\u88AB\u8C03\u8BD5\u5668\u8FDE\u63A5" },
        // disabledIf 读的是 @dev.* —— ConfigPanel 会把器件能力并进求值上下文
        {
          l: "1 \u7EBF SWIO\uFF08\u5355\u7EBF\u8C03\u8BD5\uFF09",
          v: "swio1",
          signals: ["SWDIO"],
          disabledIf: { k: "@dev.singleWireDebug", op: "=", v: false },
          hint: "\u53EA\u6709\u5355\u7EBF\u8C03\u8BD5\u7684\u7CFB\u5217\u624D\u53EF\u9009\uFF1BL103/X035/X033 \u4E0D\u652F\u6301"
        },
        { l: "\u5173\u95ED\uFF08\u5F15\u811A\u91CA\u653E\u4E3A GPIO\uFF09", v: "off", hint: "\u751F\u6210 GPIO_PinRemapConfig(GPIO_Remap_SWJ_Disable, ENABLE)" }
      ],
      { group: "iface", hint: "RCC_APB2Periph_AFIO + GPIO_PinRemapConfig(SWJ)" }
    ),
    bool("freezeIwdg", "\u51BB\u7ED3\u72EC\u7ACB\u770B\u95E8\u72D7", true, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_IWDG_STOP\uFF1A\u505C\u5728\u65AD\u70B9\u65F6\u4E0D\u8BA9 IWDG \u628A\u82AF\u7247\u590D\u4F4D\u6389"
    }),
    bool("freezeWwdg", "\u51BB\u7ED3\u7A97\u53E3\u770B\u95E8\u72D7", true, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_WWDG_STOP"
    }),
    bool("freezeTim", "\u51BB\u7ED3\u5B9A\u65F6\u5668\u8BA1\u6570", false, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_TIMx_STOP\uFF1A\u5355\u6B65\u8C03\u8BD5 PWM / \u7F16\u7801\u5668\u65F6\u8981\u5F00\uFF0C\u5426\u5219\u8BA1\u6570\u503C\u4E00\u76F4\u5728\u8DD1"
    }),
    bool("freezeSleep", "\u4F4E\u529F\u8017\u6A21\u5F0F\u4E0B\u4FDD\u6301\u8C03\u8BD5\u8FDE\u63A5", false, {
      group: "freeze",
      visibleIf: { k: "iface", op: "!=", v: "off" },
      hint: "DBGMCU_SLEEP / STOP / STANDBY\uFF0C\u8C03\u8BD5\u4F4E\u529F\u8017\u6D41\u7A0B\u65F6\u6253\u5F00"
    })
  ]
};
var system = {
  about: "\u7CFB\u7EDF\u7EA7\u914D\u7F6E\uFF1A\u8C03\u8BD5\u63A5\u53E3\u3001\u5411\u91CF\u8868\u3001\u4F4E\u529F\u8017\u5524\u9192\u4E0E\u770B\u95E8\u72D7\u884C\u4E3A\u3002",
  groups: [g("base", "\u7CFB\u7EDF", true), g("dbg", "\u8C03\u8BD5\u63A5\u53E3", true)],
  panels: [],
  params: [
    sel(
      "debug",
      "\u8C03\u8BD5\u63A5\u53E3",
      "swd",
      [
        { l: "\u53CC\u7EBF SDI\uFF08SWD \u517C\u5BB9\uFF09", v: "swd" },
        { l: "\u5355\u7EBF SDI", v: "sdw" },
        { l: "\u5173\u95ED\uFF08\u5F15\u811A\u4F5C GPIO\uFF09", v: "off" }
      ],
      { group: "dbg", hint: "\u5173\u95ED\u540E SWIO/SDCK \u91CA\u653E\u4E3A\u666E\u901A GPIO\uFF0C\u4E14\u65E0\u6CD5\u518D\u8FDE\u63A5\u8C03\u8BD5\u5668" }
    ),
    bool("vectorTableRam", "\u5411\u91CF\u8868\u653E RAM", false, { group: "base", hint: "\u652F\u6301\u8FD0\u884C\u65F6\u91CD\u5B9A\u5411\u4E2D\u65AD\u5411\u91CF\uFF0C\u7528\u4E8E Bootloader" }),
    bool("resetOnLockup", "\u6B7B\u9501\u65F6\u590D\u4F4D", true, { group: "base" }),
    bool("wwdgReset", "\u770B\u95E8\u72D7\u6EA2\u51FA\u590D\u4F4D", true, { group: "base" })
  ]
};
var uart = {
  ...usart,
  modeKey: "mode",
  about: "\u5F02\u6B65\u4E32\u53E3\uFF08\u65E0\u540C\u6B65\u65F6\u949F\uFF09\u3002\u53C2\u6570\u4E0E USART \u7684\u5F02\u6B65\u6A21\u5F0F\u4E00\u81F4\uFF0C\u5DEE\u522B\u53EA\u5728\u4E8E\u6CA1\u6709 CK \u811A\uFF0C\u56E0\u6B64\u4E0D\u63D0\u4F9B\u540C\u6B65\u6A21\u5F0F\u4E0E\u65F6\u949F\u53C2\u6570\u3002",
  groups: [g("mode", "\u5DE5\u4F5C\u6A21\u5F0F", true), g("basic", "\u57FA\u672C\u53C2\u6570", true), g("adv", "\u9AD8\u7EA7\u53C2\u6570", false, true), g("irq", "\u4E2D\u65AD\u4E0E DMA")],
  panels: ["pins", "nvic", "dma"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [{ l: "Disable", v: "disable" }, { l: "Asynchronous \u5F02\u6B65", v: "Asynchronous", signals: ["TX", "RX"] }],
      { group: "mode" }
    ),
    ...usart.params.filter((p) => p.key !== "mode" && p.group !== "clock")
  ]
};
var qspi = {
  modeKey: "mode",
  about: "\u56DB\u7EBF QSPI\uFF08\u4E5F\u53EB OSPI / SPI1\uFF09\u3002\u5355\u7EBF\u6A21\u5F0F\u7B49\u4EF7\u4E8E\u666E\u901A SPI\uFF1B\u56DB\u7EBF\u6A21\u5F0F\u4E0B\u4E00\u6B21\u4F20 4 bit\uFF0C\u7247\u9009\u3001\u65F6\u949F\u3001\u6570\u636E\u7EBF\u5FC5\u987B\u843D\u5728\u540C\u4E00\u590D\u7528\u7EC4\u91CC\u3002",
  groups: [g("mode", "\u6A21\u5F0F", true), g("param", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u5355\u7EBF (1-1-1)", v: "single", signals: ["NSS", "CLK", "D0", "D1"] },
        { l: "\u56DB\u7EBF (1-1-4)", v: "quad", signals: ["NSS", "CLK", "D0", "D1", "D2", "D3"] }
      ],
      { group: "mode" }
    ),
    num("prescaler", "\u65F6\u949F\u5206\u9891", 4, 2, 32, { group: "param", step: 2, formula: "fSCK = fHCLK / \u5206\u9891" })
  ]
};
var i2s = {
  modeKey: "mode",
  about: "I\xB2S \u97F3\u9891\u63A5\u53E3\u3002WS \u662F\u58F0\u9053\u9009\u62E9\uFF08\u5B57\u9009\uFF09\uFF0CCK \u662F\u4F4D\u65F6\u949F\uFF0CSD \u662F\u6570\u636E\uFF1BMCK \u53EA\u5728\u9700\u8981\u4E3B\u65F6\u949F\u65F6\u5206\u914D\u3002",
  groups: [g("mode", "\u6A21\u5F0F", true), g("param", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u4E3B\u673A\u53D1\u9001", v: "master_tx", signals: ["WS", "CK", "SDOUT"] },
        { l: "\u4E3B\u673A\u63A5\u6536", v: "master_rx", signals: ["WS", "CK", "SDIN"] },
        { l: "\u4ECE\u673A\u53D1\u9001", v: "slave_tx", signals: ["WS", "CK", "SDOUT"] },
        { l: "\u4ECE\u673A\u63A5\u6536", v: "slave_rx", signals: ["WS", "CK", "SDIN"] }
      ],
      { group: "mode" }
    ),
    sel(
      "format",
      "\u6570\u636E\u683C\u5F0F",
      "i2s",
      [
        { l: "I\xB2S \u6807\u51C6", v: "i2s" },
        { l: "\u5DE6\u5BF9\u9F50", v: "left" },
        { l: "\u53F3\u5BF9\u9F50", v: "right" },
        { l: "PCM", v: "pcm" }
      ],
      { group: "param" }
    ),
    num("mclkDiv", "\u4E3B\u65F6\u949F\u5206\u9891", 256, 1, 512, { group: "param", hint: "\u9700\u8981 MCK \u65F6\u5206\u914D\u8BE5\u5F15\u811A" })
  ]
};
var dac = {
  modeKey: "mode",
  about: "12 \u4F4D\u7535\u538B\u8F93\u51FA DAC\u3002\u8F93\u51FA\u811A\u662F\u56FA\u5B9A\u7684\u6A21\u62DF\u811A\uFF0C\u4E0D\u9700\u8981\u914D\u590D\u7528\u5BC4\u5B58\u5668\u3002",
  groups: [g("param", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u4F7F\u80FD\u8F93\u51FA", v: "enable", signals: ["OUT"] }
      ],
      { group: "param" }
    ),
    num("trigger", "\u89E6\u53D1\u6E90\u9009\u62E9", 0, 0, 15, { group: "param", hint: "0 = \u8F6F\u4EF6\u89E6\u53D1" })
  ]
};
var vcmp = {
  modeKey: "mode",
  about: "\u7535\u538B\u6BD4\u8F83\u5668\u3002\u8F93\u51FA\u65E2\u80FD\u9001\u5B9A\u65F6\u5668\u5239\u8F66\uFF0C\u4E5F\u80FD\u89E6\u53D1\u5916\u90E8\u4E2D\u65AD\uFF1B\u8F93\u5165\u7AEF\u53EF\u4ECE\u591A\u8DEF\u901A\u9053\u91CC\u9009\u3002",
  groups: [g("param", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u4F7F\u80FD", v: "enable", signals: ["OUT"] }
      ],
      { group: "param" }
    ),
    sel(
      "positive",
      "\u540C\u76F8\u8F93\u5165",
      "0",
      [
        { l: "CH0", v: "0" },
        { l: "CH1", v: "1" },
        { l: "CH2", v: "2" },
        { l: "CH3", v: "3" },
        { l: "CH4", v: "4" }
      ],
      { group: "param", hint: "\u5B9E\u9645\u53EF\u9009\u8303\u56F4\u4EE5\u5668\u4EF6\u5F15\u811A\u4E3A\u51C6" }
    ),
    sel(
      "filter",
      "\u6570\u5B57\u6EE4\u6CE2",
      "off",
      [
        { l: "\u5173\u95ED", v: "off" },
        { l: "\u5F00\u542F", v: "on" }
      ],
      { group: "param" }
    )
  ]
};
var fda = {
  modeKey: "mode",
  about: "\u5DEE\u5206\u8FD0\u653E / \u53EF\u7F16\u7A0B\u589E\u76CA\u653E\u5927\u5668\u3002\u8F93\u51FA\u53EF\u5355\u7AEF\u4E5F\u53EF\u5DEE\u5206\uFF0C\u8F93\u5165\u7AEF\u6BCF\u8FB9\u6709 3 \u7EC4\u53EF\u9009\u3002",
  groups: [g("param", "\u53C2\u6570", true)],
  panels: ["pins"],
  params: [
    sel(
      "mode",
      "\u6A21\u5F0F",
      "disable",
      [
        { l: "Disable", v: "disable" },
        { l: "\u5DEE\u5206\u8F93\u51FA", v: "diff", signals: ["OUTP", "OUTN"] },
        { l: "\u5355\u7AEF\u8F93\u51FA", v: "single", signals: ["OUTP"] }
      ],
      { group: "param" }
    ),
    sel(
      "gain",
      "\u589E\u76CA",
      "2",
      [
        { l: "\xD72", v: "2" },
        { l: "\xD74", v: "4" },
        { l: "\xD78", v: "8" },
        { l: "\xD716", v: "16" },
        { l: "\xD732", v: "32" }
      ],
      { group: "param" }
    )
  ]
};

// src/core/pinmux.ts
function pinsForSignal(dev, fn) {
  return dev.package.pins.filter((p) => (p.signals ?? []).some((s) => s.fn === fn));
}
function signalAvailable(dev, fn) {
  return pinsForSignal(dev, fn).length > 0;
}
function peripheralUsable(dev, periphId) {
  const def = dev.peripherals.find((p) => p.id === periphId);
  if (!def) return false;
  if (def.signals.length === 0) return true;
  const required = def.signals.filter((s) => s.required);
  if (required.length > 0) {
    return required.every((s) => signalAvailable(dev, `${periphId}_${s.name}`));
  }
  return def.signals.some((s) => signalAvailable(dev, `${periphId}_${s.name}`));
}

// src/engine/dma.ts
function dmaChannelCount(dev) {
  const cs = dev.dmaControllers;
  if (cs && cs.length > 0) return cs.reduce((s, c) => s + c.channels, 0);
  return dev.dmaChannels ?? 0;
}

// src/core/deviceFilter.ts
function coreKindOf(core) {
  const c = core.toLowerCase();
  if (/xtensa|esp32|esp-?[0-9]|lx[0-9]/.test(c)) return "Xtensa";
  if (/cortex|arm\b|m[0-9]\+?\b|armv/.test(c)) return "ARM";
  if (/risc-?v|rv32|rv64|qingke|e[0-9]{2,3}[a-z]?\b/.test(c)) return "RISC-V";
  return "\u5176\u4ED6";
}
function usableCount(dev, pred) {
  return dev.peripherals.filter((p) => pred(p) && peripheralUsable(dev, p.id)).length;
}
var byKind = (...kinds) => (dev) => usableCount(dev, (p) => kinds.includes(p.kind));
var PERIPH_FACETS = [
  { key: "USB", label: "USB", count: (d) => usableCount(d, (p) => p.kind === "USB" && !/^USBPD/.test(p.id)) },
  { key: "USBPD", label: "USB PD", count: (d) => usableCount(d, (p) => /^USBPD/.test(p.id)) },
  { key: "I2C", label: "I\xB2C", count: byKind("I2C") },
  { key: "SPI", label: "SPI", count: byKind("SPI") },
  { key: "USART", label: "\u4E32\u53E3", count: byKind("USART", "UART") },
  { key: "CAN", label: "CAN", count: byKind("CAN") },
  { key: "ADC", label: "ADC", count: byKind("ADC") },
  { key: "DAC", label: "DAC", count: byKind("DAC") },
  { key: "TIM", label: "\u5B9A\u65F6\u5668", count: byKind("TIM") },
  { key: "DVP", label: "DVP", count: byKind("DVP") },
  { key: "DMA", label: "DMA \u901A\u9053", count: (d) => dmaChannelCount(d) }
];
var FACET_BY_KEY = Object.fromEntries(
  PERIPH_FACETS.map((f) => [f.key, f])
);
function emptyQuery() {
  return { text: "", cores: [], ranges: {} };
}
function haystack(part, series, dev) {
  return [
    part.id,
    part.packageLabel,
    series.id,
    series.label,
    series.vendor,
    series.core,
    dev.core,
    coreKindOf(dev.core),
    `${part.pins}`
  ].join(" ").toLowerCase();
}
function matchesText(part, series, dev, text) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = haystack(part, series, dev);
  return words.every((w) => h.includes(w));
}
function matchesCore(dev, cores) {
  return cores.length === 0 || cores.includes(coreKindOf(dev.core));
}
function matchesRanges(dev, ranges) {
  for (const [key, r] of Object.entries(ranges)) {
    const facet = FACET_BY_KEY[key];
    if (!facet) continue;
    const n = facet.count(dev);
    if (n < r.min) return false;
    if (r.max !== null && n > r.max) return false;
  }
  return true;
}
function filterParts(seriesList, deviceMap, q) {
  const out = [];
  for (const series of seriesList) {
    for (const part of series.parts) {
      const dev = deviceMap[part.id];
      if (!dev) continue;
      if (!matchesCore(dev, q.cores)) continue;
      if (!matchesRanges(dev, q.ranges)) continue;
      if (!matchesText(part, series, dev, q.text)) continue;
      out.push({ part, series, dev });
    }
  }
  return out;
}

// scripts/_filter_verify.ts
var total = SERIES.reduce((n, s) => n + s.parts.length, 0);
console.log(`\u5668\u4EF6\u5E93: ${SERIES.length} \u4E2A\u7CFB\u5217 / ${total} \u4E2A\u578B\u53F7`);
console.log("\u5185\u6838\u5F52\u7C7B:", SERIES.map((s) => `${s.label}=${coreKindOf(s.core)}`).join(", "));
function run(tag, q, expect) {
  const hits = filterParts(SERIES, DEVICE_MAP, q);
  const ids = hits.map((h) => h.part.id);
  const seriesHit = [...new Set(hits.map((h) => h.series.label))];
  console.log(`
[${tag}] ${ids.length} \u4E2A\u578B\u53F7`);
  console.log(`  \u7CFB\u5217: ${seriesHit.join(", ") || "\uFF08\u65E0\uFF09"}`);
  console.log(`  \u578B\u53F7: ${ids.join(", ") || "\uFF08\u65E0\uFF09"}`);
  if (expect && !expect(ids)) throw new Error(`${tag}: \u7ED3\u679C\u4E0D\u7B26\u5408\u9884\u671F`);
  return ids;
}
run("\u4E0D\u9650", emptyQuery(), (ids) => ids.length === total);
run(
  "\u5185\u6838=ARM",
  { ...emptyQuery(), cores: ["ARM"] },
  (ids) => ids.length > 0 && ids.every((id) => id.startsWith("HC32"))
);
run(
  "\u5185\u6838=RISC-V",
  { ...emptyQuery(), cores: ["RISC-V"] },
  (ids) => ids.length > 0 && ids.every((id) => !id.startsWith("HC32"))
);
var arm = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), cores: ["ARM"] }).length;
var rv = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), cores: ["RISC-V"] }).length;
run("\u5185\u6838=ARM+RISC-V", { ...emptyQuery(), cores: ["ARM", "RISC-V"] }, (ids) => ids.length === arm + rv);
run(
  "USB PD \u5177\u5907",
  { ...emptyQuery(), ranges: { USBPD: { min: 1, max: null } } },
  (ids) => ids.length > 0 && ids.every((id) => /^CH32L103|^CH32X035/.test(id))
);
var i2cCount = (id) => FACET_BY_KEY["I2C"].count(DEVICE_MAP[id]);
run(
  "I2C \u22652",
  { ...emptyQuery(), ranges: { I2C: { min: 2, max: null } } },
  (ids) => ids.length > 0 && ids.every((id) => i2cCount(id) >= 2)
);
run(
  "I2C =1",
  { ...emptyQuery(), ranges: { I2C: { min: 1, max: 1 } } },
  (ids) => ids.length > 0 && ids.every((id) => i2cCount(id) === 1)
);
var ge2 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 2, max: null } } }).length;
var eq1 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 1, max: 1 } } }).length;
var eq0 = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { I2C: { min: 0, max: 0 } } }).length;
console.log(`
[\u5206\u533A] I2C \u22652:${ge2}  =1:${eq1}  =0:${eq0}  \u5408\u8BA1\u5E94\u4E3A ${total}`);
if (ge2 + eq1 + eq0 !== total) throw new Error("I2C \u6570\u91CF\u5206\u533A\u4E0D\u5B8C\u5907");
run("RISC-V \u4E14 I2C \u22652", {
  ...emptyQuery(),
  cores: ["RISC-V"],
  ranges: { I2C: { min: 2, max: null } }
}, (ids) => ids.length > 0 && ids.every((id) => !id.startsWith("HC32") && i2cCount(id) >= 2));
run(
  "\u641C\u7D22 V407",
  { ...emptyQuery(), text: "v407" },
  (ids) => ids.length > 0 && ids.every((id) => id.includes("V407"))
);
run("\u641C\u7D22 M4\uFF08\u5185\u6838\u5173\u952E\u5B57\uFF09", { ...emptyQuery(), text: "m4" }, (ids) => ids.length > 0);
run("\u641C\u7D22\u4E0D\u5B58\u5728", { ...emptyQuery(), text: "zzz-not-exist" }, (ids) => ids.length === 0);
console.log("\n=== \u5404\u7CFB\u5217\u9996\u4E2A\u578B\u53F7\u7684\u5916\u8BBE\u6570\u91CF ===");
for (const s of SERIES) {
  const dev = DEVICE_MAP[s.parts[0].id];
  if (!dev) continue;
  const cells = PERIPH_FACETS.map((f) => `${f.key}:${f.count(dev)}`).join(" ");
  console.log(`  ${s.label.padEnd(12)} ${cells}`);
}
var usbOnly = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { USB: { min: 1, max: null } } });
var pdOnly = filterParts(SERIES, DEVICE_MAP, { ...emptyQuery(), ranges: { USBPD: { min: 1, max: null } } });
console.log(`
USB \u5177\u5907 ${usbOnly.length} \u4E2A\u578B\u53F7 / USB PD \u5177\u5907 ${pdOnly.length} \u4E2A\u578B\u53F7\uFF08\u5E94\u4E0D\u540C\uFF09`);
if (usbOnly.length === pdOnly.length) throw new Error("USB \u4E0E USBPD \u7B5B\u9009\u7ED3\u679C\u76F8\u540C\uFF0C\u53E3\u5F84\u53EF\u80FD\u6709\u95EE\u9898");
if (!FACET_BY_KEY["I2C"]) throw new Error("FACET_BY_KEY \u7F3A I2C");
console.log("\n\u2705 \u7B5B\u9009\u903B\u8F91\u9A8C\u8BC1\u901A\u8FC7");
