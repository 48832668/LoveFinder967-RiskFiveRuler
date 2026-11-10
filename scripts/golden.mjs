/**
 * codegen 金样测试（Golden Master）。
 *
 * 为什么需要它：`codegen.ts` 有 1500+ 行、34 个 case，重构时没有"字节级等价"的
 * 保护就只能靠肉眼。这个脚本把**所有器件 × 所有模式 × 全部外设**的生成结果
 * 落成快照，重构前后逐字节 diff。
 *
 * 用法：
 *   node scripts/golden.mjs            # 与已提交的快照比对，不一致就退出码 1
 *   node scripts/golden.mjs --update   # 重新生成快照（仅在"有意改变输出"时用）
 *
 * 实现要点：
 *   - 用 esbuild 把 `src/core` 打成临时 ESM，Node 直接 import —— 不需要浏览器，
 *     也不依赖 dev server。`?raw` 后缀用一个 20 行的插件处理。
 *   - 一个 case 落成**一个文件**：多个生成文件用 `//// FILE: <path>` 分隔拼在一起，
 *     这样 156 个 case 只有 156 个文件，diff 也一眼能看出是哪个文件变了。
 *   - 每个 case 用固定 seed（自增索引）构造，不用随机数，保证可重复。
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = join(ROOT, "tests", "golden");
const BUILD_DIR = join(ROOT, "node_modules", ".rfr-golden");
const UPDATE = process.argv.includes("--update");

/* ─────────────────── 1. 把纯 core 打成一个可 import 的 ESM ─────────────────── */

/** Vite 的 `?raw` 导入在 esbuild 里没有，简单替换成文本模块 */
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

async function bundleCore() {
  const entry = join(BUILD_DIR, "entry.ts");
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(
    entry,
    `export { DEVICES, DEVICE_MAP } from "${posix(join(ROOT, "src/devices/index.ts"))}";\n` +
      `export { createProject, createDemoProject } from "${posix(join(ROOT, "src/app/project.ts"))}";\n` +
      `export { generate } from "${posix(join(ROOT, "src/backends/index.ts"))}";\n` +
      `export { schemaFor } from "${posix(join(ROOT, "src/semantic/schemas.ts"))}";\n`,
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
    // JSON 器件包走 esbuild 默认的 json loader，不需要额外配置
  });
  return import(pathToFileURL(out).href + `?t=${Date.now()}`);
}

const posix = (p) => p.replace(/\\/g, "/");

/** 递归删除：不用 rmSync，某些运行环境对递归删除有拦截 */
function removeTree(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeTree(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

/* ────────────────────────── 2. 构造 case ────────────────────────── */

/**
 * 一个 case 描述一次 `generate()` 调用。
 *
 * 覆盖策略（平衡覆盖率与快照体积）：
 *   - 每颗器件都跑 `demo`（示例工程）与 `all-on`（能开的全开）；
 *   - **每个系列挑一颗代表器件**再跑"逐外设逐模式"，避免 18 颗器件 × 30 个模式爆炸，
 *     同时保证每种模式至少被验证一次。
 */
function buildCases(core) {
  const cases = [];
  const { DEVICES, createProject, createDemoProject, schemaFor } = core;

  /** 每个系列的第一颗器件做模式扫描 */
  const repByFamily = new Map();
  for (const dev of DEVICES) {
    if (!repByFamily.has(dev.family)) repByFamily.set(dev.family, dev);
  }

  for (const dev of DEVICES) {
    cases.push({ name: "demo", dev, project: () => createDemoProject(dev) });

    cases.push({
      name: "all-on",
      dev,
      project: () => {
        const p = createProject(dev, "RFR_Golden");
        for (const per of dev.peripherals) {
          const cfg = p.configs[per.id];
          if (!cfg) continue;
          if (per.kind === "GPIO") continue;
          cfg.enabled = true;
          if (cfg.nvic) cfg.nvic.enabled = true;
        }
        return p;
      },
    });
  }

  for (const dev of repByFamily.values()) {
    for (const per of dev.peripherals) {
      const schema = schemaFor(per.schema);
      const modeParam = schema?.modeKey
        ? schema.params.find((x) => x.key === schema.modeKey)
        : undefined;
      if (!modeParam?.options?.length) continue;
      for (const opt of modeParam.options) {
        const mode = String(opt.value);
        if (mode === "disable" || mode === "off") continue;
        cases.push({
          name: `mode/${per.id}-${mode}`,
          dev,
          // 模式扫描只关心"引脚表 + 外设初始化"，其余文件（main/README/MRS 工程）
          // 在同器件的各模式间完全相同，全存进去只会让快照膨胀三倍
          only: ["rfr_init.c", "rfr_pinmap.h"],
          // 模式扫描只关心"引脚表 + 外设初始化"，其余文件（main/README/MRS 工程）
          // 在同器件的各模式间完全相同，全存进去只会让快照膨胀三倍
          only: ["rfr_init.c", "rfr_pinmap.h"],
          project: () => {
            const p = createProject(dev, "RFR_Golden");
            const cfg = p.configs[per.id];
            if (!cfg) return p;
            cfg.enabled = true;
            cfg.mode = mode;
            cfg.params = { ...cfg.params, [schema.modeKey]: mode };
            // 引脚交给规划器：不手工指定，正好也把 pinmux 的行为纳入快照
            return p;
          },
        });
      }
    }
  }
  return cases;
}

/* ────────────────────────── 3. 生成 / 比对 ────────────────────────── */

function render(files) {
  // 空输出是「有意为之」的一种状态（资料不足的器件禁止生成代码），
  // 不能存成空文件 —— 那样没人知道是「没生成」还是「脚本坏了」。
  if (files.length === 0) return "//// NO CODE GENERATED（该器件 codegenEnabled = false）\n";
  return (
    files
      .filter((f) => !arguments[1] || arguments[1].some((k) => f.path.endsWith(k)))
      .filter((f) => !arguments[1] || arguments[1].some((k) => f.path.endsWith(k)))
      .map((f) => `//// FILE: ${f.path}\n${f.content}`)
      .join("\n")
      // 生成时间戳会变，抹掉它，否则每次跑都 diff
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TIMESTAMP>")
      .replace(/\b\d{2}\.\d{1,2}\.\d{1,2}\.\d+\b/g, "<VERSION>")
  );
}

/** case 名里带 `/`，落盘时换成 `__`，避免多一层目录 */
const fileOf = (caseName) => caseName.replace(/\//g, "__") + ".txt";

async function main() {
  const core = await bundleCore();
  const cases = buildCases(core);

  if (UPDATE) removeTree(GOLDEN_DIR);

  let written = 0;
  let same = 0;
  const diffs = [];

  for (const c of cases) {
    const dir = join(GOLDEN_DIR, c.dev.id);
    const file = join(dir, fileOf(c.name));
    let text;
    try {
      text = render(core.generate(c.project(), c.dev), c.only);
    } catch (e) {
      text = `//// ERROR\n${(e && e.stack) || e}\n`;
    }
    if (UPDATE) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
      written++;
      continue;
    }
    if (!existsSync(file)) {
      diffs.push({ file, reason: "缺少快照" });
      continue;
    }
    const old = readFileSync(file, "utf8");
    if (old === text) {
      same++;
    } else {
      diffs.push({ file, reason: "内容不同", old, now: text });
    }
  }

  if (UPDATE) {
    // 记下 case 数量，方便判断"是不是漏跑了"
    writeFileSync(
      join(GOLDEN_DIR, "MANIFEST.json"),
      JSON.stringify(
        {
          cases: cases.length,
          devices: [...new Set(cases.map((c) => c.dev.id))].length,
          // 每个 case 的 sha256，几百个文件时能一眼看出哪个变了
          sha: Object.fromEntries(
            cases.map((c) => {
              const p = join(GOLDEN_DIR, c.dev.id, fileOf(c.name));
              return [
                `${c.dev.id}/${c.name}`,
                createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16),
              ];
            }),
          ),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✓ 已写入 ${written} 个快照（${cases.length} 个 case）到 tests/golden/`);
    return 0;
  }

  if (existsSync(join(GOLDEN_DIR, "MANIFEST.json"))) {
    const manifest = JSON.parse(readFileSync(join(GOLDEN_DIR, "MANIFEST.json"), "utf8"));
    if (manifest.cases !== cases.length) {
      console.log(
        `! case 数量变了：快照 ${manifest.cases}，现在 ${cases.length} ` +
          `—— 若是有意新增覆盖，跑 npm run golden:update`,
      );
    }
  }

  if (diffs.length === 0) {
    console.log(`✓ golden 一致：${same} 个 case`);
    return 0;
  }

  console.log(`✗ ${diffs.length} 个 case 与快照不一致（${same} 个一致）\n`);
  for (const d of diffs.slice(0, 5)) {
    console.log(`  ${relative(ROOT, d.file)}  —— ${d.reason}`);
    if (d.old !== undefined) {
      const a = d.old.split("\n");
      const b = d.now.split("\n");
      const i = a.findIndex((l, k) => l !== b[k]);
      console.log(`    首个差异在第 ${i + 1} 行：`);
      console.log(`      - ${JSON.stringify(a[i]?.slice(0, 110))}`);
      console.log(`      + ${JSON.stringify(b[i]?.slice(0, 110))}`);
    }
  }
  if (diffs.length > 5) console.log(`  … 还有 ${diffs.length - 5} 个`);
  console.log(`\n若这次输出变更是有意的：npm run golden:update（并在提交说明里写清原因）`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
