/**
 * 分层依赖检查 —— 让「层次」不只是目录名。
 *
 * 规则（对应 docs/ARCHITECTURE_REFACTOR_PLAN.md §3）：
 *   model/      纯类型，**不允许 import 任何本地模块**（只能 import 类型库）
 *   engine/     只能 import model/
 *   semantic/   只能 import model/
 *   packs/      只能 import model/、packs/、devices/*（厂商元数据）
 *   backends/   只能 import model/、engine/、semantic/、packs/、backends/
 *   platform/   只能 import model/、packs/
 *   app/        可以 import 以上任意层，但不 import ui/
 *   ui/         可以 import 任意层（它是最上层）
 *   core/       兼容层，只允许 re-export
 *
 * 违规就退出码 1。挂进 `npm test`，重构时不会悄悄长出反向依赖。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/**
 * layer -> 允许依赖的 layer（同层允许）。
 *
 * `core` 是**过渡期的兼容层**（只做 re-export），所有层暂时都允许引用它 ——
 * 阶段 6 会把它删掉，届时这条豁免一起去掉。引用它算「待迁移」，会统计出来但不判失败。
 */
const ALLOWED = {
  model: ["core"],
  engine: ["model", "core"],
  // semantic 是「参数/引脚语义」层：schema 驱动的规则需要 engine 的纯表达式求值
  semantic: ["model", "engine", "core"],
  packs: ["model", "packs", "core"],
  devices: ["model", "packs", "devices", "core"],
  backends: ["model", "engine", "semantic", "packs", "devices", "backends", "core"],
  platform: ["model", "packs", "platform", "core"],
  // app 是编排层：允许拿到器件注册表做筛选/默认值
  app: ["model", "engine", "semantic", "packs", "devices", "backends", "platform", "app", "core"],
  ui: ["model", "engine", "semantic", "packs", "devices", "backends", "platform", "app", "ui", "core"],
  core: ["model", "engine", "semantic", "packs", "devices", "backends", "platform", "app", "core"],
};

/** model/ 连 core/ 都不该依赖（它就是最底层） */
const MODEL_FORBIDDEN = new Set(["."]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "templates" || e.name === "data") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 从 `import ... from "x"` / `export ... from "x"` 里取模块路径 */
function importsOf(code) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

/** 模块路径 -> 所属 layer（只在 src 内判断；跨到 src 外的不算本地依赖） */
function layerOfFile(file) {
  const rel = relative(SRC, file).replace(/\\/g, "/");
  const top = rel.split("/")[0];
  return ALLOWED[top] ? top : null;
}

function resolveLayer(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // 第三方依赖不管
  const base = join(dirname(fromFile), spec);
  const rel = relative(SRC, base).replace(/\\/g, "/");
  if (rel.startsWith("..")) return null; // 指向 src 之外
  const top = rel.split("/")[0];
  return ALLOWED[top] ? top : null;
}

const violations = [];
const pending = new Set();
const files = walk(SRC);

for (const file of files) {
  const fromLayer = layerOfFile(file);
  if (!fromLayer) continue;
  const code = readFileSync(file, "utf8");
  for (const spec of importsOf(code)) {
    const toLayer = resolveLayer(file, spec);
    if (!toLayer) continue;
    if (toLayer === fromLayer) continue;
    if (toLayer === "core") {
      pending.add(relative(ROOT, file));
      continue;
    }

    // core/ 只允许 re-export 到新层（shim），不允许有实现
    if (fromLayer === "core") {
      const body = code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*export \* from .*$/gm, "")
        .replace(/^\s*export \{[^}]*\} from .*$/gm, "")
        .replace(/^\s*export type \{[^}]*\} from .*$/gm, "")
        .trim();
      if (body.length > 0) {
        violations.push({
          file,
          spec,
          msg: `core/ 只允许 re-export，但 ${relative(ROOT, file)} 里还有实现代码`,
        });
      }
      continue;
    }

    if (!ALLOWED[fromLayer].includes(toLayer)) {
      violations.push({
        file,
        spec,
        msg: `${fromLayer}/ 不允许依赖 ${toLayer}/（${spec}）`,
      });
    }
  }

  // model 层不允许 import 任何本地模块
  if (fromLayer === "model") {
    for (const spec of importsOf(code)) {
      if (spec.startsWith(".") && !spec.includes("model/")) {
        violations.push({ file, spec, msg: `model/ 必须是纯类型，不能 import 本地模块（${spec}）` });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`✓ 分层依赖检查通过：${files.length} 个文件`);
  if (pending.size) {
    console.log(`  （${pending.size} 个文件仍引用 core/ 兼容层 —— 阶段 6 删除 shim 时一并迁移）`);
  }
  process.exit(0);
}

console.log(`✗ ${violations.length} 处分层违规：\n`);
const seen = new Set();
for (const v of violations) {
  const key = `${v.msg}|${v.file}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${relative(ROOT, v.file)}`);
  console.log(`    ${v.msg}`);
}
process.exit(1);
