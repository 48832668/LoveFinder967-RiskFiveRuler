/**
 * 重映射组自洽校验。
 *
 * 为什么需要它：引脚页现在以「组」为单位分配（WCH 的 AFIO 是整组切换），
 * 组数据一旦自相矛盾，界面给出的就是一条**看着能选、其实烧进去跑不起来**的配置。
 * 这个脚本把每颗器件 × 每个外设 × 每个模式都算一遍，检查两件事：
 *
 *   1. 同一组内两个信号不能落到同一个物理脚上（器件包的 remap 标注写错就会这样）；
 *   2. 必需信号齐全的外设，每种模式下至少要有一个可行的组 —— 一个都没有，
 *      意味着这个外设在这个模式下永远开不起来，属于数据缺陷。
 *
 * 注意「必需信号」是**按模式**算的：USART 异步只要 TX/RX，同步才要 CK，
 * 拿全体信号去卡可行性会把几乎所有组误判成缺线。
 *
 * 逐引脚独立 AF 的器件（HC32）没有组的概念，跳过。
 *
 * 用法：node scripts/check_groups.mjs
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, "node_modules", ".rfr-groups");
const posix = (p) => p.replace(/\\/g, "/");

const rawPlugin = {
  name: "vite-raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: join(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

async function bundle() {
  const entry = join(BUILD_DIR, "entry.ts");
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(
    entry,
    `export { DEVICES } from "${posix(join(ROOT, "src/devices/index.ts"))}";\n` +
      `export * as P from "${posix(join(ROOT, "src/semantic/pinmux.ts"))}";\n`,
  );
  const out = join(BUILD_DIR, "core.mjs");
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "error",
    plugins: [rawPlugin],
  });
  return import(pathToFileURL(out).href + `?t=${Date.now()}`);
}

const { DEVICES, P } = await bundle();

const errors = [];
const warnings = [];
let checkedGroups = 0;
let checkedCases = 0;

for (const dev of DEVICES) {
  if (dev.afGrouping !== "grouped") continue;
  for (const periph of dev.peripherals) {
    // 只校验真的靠引脚工作的外设：GPIO / RTC / DMA 这类没有复用信号
    const tableSignals = P.pinTableSignals(periph);
    const channelKeys = P.channelKeysOf(dev, periph);
    const all = [...new Set([...tableSignals, ...channelKeys])];
    if (all.length === 0) continue;
    // 本封装一个信号都没引出来 —— 正常（小封装未引出），不用校验
    if (!all.some((s) => P.pinsForSignal(dev, `${periph.id}_${s}`).length > 0)) continue;

    const current = {};
    for (const s of all) current[s] = null;

    // 引脚重复：与模式无关，直接按「全体信号」看
    for (const g of P.remapGroupsOf(dev, periph, all, current, [])) {
      const pins = g.slots.filter((s) => s.pin).map((s) => s.pin);
      if (pins.length < 2) continue;
      checkedGroups++;
      const dup = [...new Set(pins.filter((p, i) => pins.indexOf(p) !== i))];
      if (dup.length) {
        errors.push(`${dev.id} ${periph.id} 组 ${g.group}: 同一组里引脚重复 ${dup.join(", ")}`);
      }
    }

    // 每个模式单独判可行性
    const modeParam = P.modeParamOf(periph);
    const modes = modeParam
      ? modeParam.options.map((o) => String(o.value)).filter((v) => v !== "disable" && v !== "off")
      : [];
    if (modes.length === 0) continue;

    for (const mode of modes) {
      const required = P.requiredInMode(periph, mode, {}).filter(
        (s) => P.pinsForSignal(dev, `${periph.id}_${s}`).length > 0,
      );
      if (required.length === 0) continue;
      checkedCases++;
      // 只看这个模式真正要用的线：把 CK/CTS/SMBA 一起丢进去，它们会先抢走
      // TX/RX 的唯一候选脚，把本来可行的组误判成缺线
      const only = {};
      for (const s of required) only[s] = null;
      const groups = P.remapGroupsOf(dev, periph, required, only, [], required);
      if (!groups.some((g) => g.feasible)) {
        warnings.push(
          `${dev.id} ${periph.id}（${mode}）: 必需信号 ${required.join("/")} 都有引出，却没有一个组能同时容纳 — ` +
            groups.map((g) => `组${g.group}:${g.reason ?? "ok"}`).join("；"),
        );
      }
    }
  }
}

// 同一个外设在不同封装上会重复报，按外设聚合，输出才看得清
const seen = new Set();
const brief = [];
for (const w of warnings) {
  const key = w.split("（")[0] + w.slice(w.indexOf("（"), w.indexOf("）"));
  if (seen.has(key)) continue;
  seen.add(key);
  brief.push(w);
}
for (const w of brief.slice(0, 8)) console.warn(`  ! ${w}`);
if (brief.length > 8) console.warn(`  ! ……另有 ${brief.length - 8} 条同类（按器件 × 外设 × 模式去重后）`);
if (brief.length) {
  console.warn(
    "  提示：这类报警说明「同一外设的几根线凑不到一个组里」。两种可能：\n" +
      "        ① 抄表时把某一列的组号写错（TX/RX 本该同号）；\n" +
      "        ② 这颗小封装确实没有把成对的引脚都引出来 —— 那是真限制，界面会提示无法整套配置。\n" +
      "        先核对数据手册，别改界面逻辑。",
  );
}
for (const e of errors) console.error(`  ✗ ${e}`);
console.log(
  `重映射组校验：${checkedCases} 个模式组合、${checkedGroups} 个组，` +
    `${errors.length} 个错误，${warnings.length} 个警告`,
);
process.exit(errors.length ? 1 : 0);
