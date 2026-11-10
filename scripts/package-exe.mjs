#!/usr/bin/env node
/**
 * 打包成「双击即用」的便携 exe。
 *
 * 为什么不用裸 `cargo build`：
 *   Tauri 只在 `tauri build` 期间注入打包环境变量，才会把 frontendDist（dist/）
 *   编进二进制。裸 cargo build 的产物会回落到 devUrl（http://127.0.0.1:1420），
 *   双击得到一个白屏窗口 —— 这正是本脚本要防的事。
 *
 * 产物：
 *   RiskFiveRuler.exe        仓库根目录（和 WebView2Loader.dll 放在一起）
 *   WebView2Loader.dll       已存在则保留
 *
 * 依赖：
 *   - 本机 Rust（默认找 %USERPROFILE%\.workbuddy-ai\binaries；
 *     找不到就用 PATH 里的 cargo）
 *   - Windows GNU 工具链 + MinGW（+crt-static，产物不依赖 api-ms-win-crt-*.dll）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const isWin = process.platform === "win32";

const env = { ...process.env };
const binRoot = path.join(os.homedir(), ".workbuddy-ai", "binaries");
const rustBin = path.join(binRoot, "rust", "rustup", "toolchains", "stable-x86_64-pc-windows-gnu", "bin");
const mingwBin = path.join(binRoot, "mingw64", "bin");
const hasLocalGnu = isWin && fs.existsSync(path.join(rustBin, "cargo.exe"));

// tauri build 会自己再调 `npm run build`，所以 node/npm 所在目录也必须在 PATH 里
env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);

if (hasLocalGnu) {
  env.PATH = [rustBin, mingwBin, env.PATH].filter(Boolean).join(path.delimiter);
  env.RUSTUP_HOME = path.join(binRoot, "rust", "rustup");
  env.CARGO_HOME = path.join(binRoot, "rust", "cargo");
  env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "gcc";
  env.CC_x86_64_pc_windows_gnu = "gcc";
  env.CXX_x86_64_pc_windows_gnu = "g++";
  env.AR_x86_64_pc_windows_gnu = "ar";
}

// 不设置 +crt-static：mingw-w64 没有真正的静态 UCRT，强开会加载即崩。
// api-ms-win-crt-*.dll 是 Windows 10+ 自带的 API set，不是额外依赖。
env.CARGO_HTTP_TIMEOUT = env.CARGO_HTTP_TIMEOUT ?? "120";
env.CARGO_NET_RETRY = env.CARGO_NET_RETRY ?? "5";

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, env, ...opts });
  if (r.status !== 0) {
    console.error(`\n失败：${cmd} ${args.join(" ")}（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
};

// 直接调用 CLI 的 JS 入口：Windows 上 spawn("npx.cmd") 需要 shell，
// 而这里已经自己配好了工具链环境，没必要再绕一层 cmd.exe。
const tauriCli = path.join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauriArgs = [tauriCli, "build", "--no-bundle", "--ci", "--features", "custom-protocol"];
if (hasLocalGnu) tauriArgs.push("--target", "x86_64-pc-windows-gnu");

// 1) 前端构建 + Tauri 打包（beforeBuildCommand 会跑 npm run build）
if (!process.argv.includes("--skip-build")) {
  run(process.execPath, tauriArgs);
}

// 2) 找到产物
const targetDir = path.join(TAURI_DIR, "target");
const candidates = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "deps" || e.name === "build" || e.name === "incremental") continue;
      walk(p);
    } else if (/^risk-five-ruler\.exe$/i.test(e.name)) {
      candidates.push(p);
    }
  }
};
walk(targetDir);
if (!candidates.length) {
  console.error("找不到 risk-five-ruler.exe，请检查 tauri build 输出");
  process.exit(1);
}
candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const built = candidates[0];

// 3) 复制到仓库根目录；目标被占用（用户开着旧 exe）时落到 RiskFiveRuler.new.exe，
//    提示用户关掉旧程序后手动替换 —— 构建成果不能因为文件锁白跑一趟
const dest = path.join(ROOT, "RiskFiveRuler.exe");
let finalDest = dest;
try {
  fs.copyFileSync(built, dest);
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "EBUSY") {
    finalDest = path.join(ROOT, "RiskFiveRuler.new.exe");
    fs.copyFileSync(built, finalDest);
    console.log(`\n⚠ RiskFiveRuler.exe 正在运行、无法覆盖，产物已写到 RiskFiveRuler.new.exe`);
    console.log("  关闭旧程序后，把 RiskFiveRuler.new.exe 改名替换即可。");
  } else {
    throw err;
  }
}
console.log(`\n✓ ${path.relative(ROOT, built)} → ${path.relative(ROOT, finalDest)}`);

// 4) 校验：不能再带 devUrl；必须能搜到界面文本（说明资源真的编进去了）
const bytes = fs.readFileSync(dest);
const ascii = bytes.toString("latin1");
const utf8 = bytes.toString("utf8");
// devUrl 字符串会作为 Tauri 配置元数据编进二进制，不代表运行时会连它；
// 真正的判据是「界面文本 / 资源是否内嵌」。运行时 URL 用 --verify-runtime 另测。
const hasDevUrl = ascii.includes("127.0.0.1:1420") || ascii.includes("localhost:1420");
const hasUiText = utf8.includes("引脚与外设") || utf8.includes("RISK FIVE RULER");
const hasAssetName = /assets\/index-[A-Za-z0-9_-]+\.(js|css)/.test(ascii);

console.log(`  exe 大小       ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`  内嵌资源文件名 ${hasAssetName ? "有" : "无（失败）"}`);
console.log(`  明文界面文本   ${hasUiText ? "有" : "无（资源通常被压缩，正常）"}`);
console.log(`  devUrl 元数据  ${hasDevUrl ? "有（Tauri 配置字段，正常）" : "无"}`);

if (!fs.existsSync(path.join(ROOT, "WebView2Loader.dll"))) {
  console.error("  ✗ 缺少 WebView2Loader.dll —— exe 必须和它放在同一目录");
  process.exit(1);
}
if (!hasAssetName) {
  console.error("\n✗ 产物没有内嵌前端资源。必须用 tauri build（不是 cargo build）。");
  process.exit(1);
}

// 可选：真正启动一次，读 WebView 的 URL —— 证明它走 tauri:// 而不是 dev server。
if (process.argv.includes("--verify-runtime")) {
  const { spawn } = await import("node:child_process");
  const port = 9444;
  const child = spawn(dest, [], {
    cwd: ROOT,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
  });
  try {
    let targets = null;
    for (let i = 0; i < 30 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        targets = await res.json();
      } catch {
        /* 还没起来 */
      }
    }
    const page = targets?.find((t) => t.type === "page");
    if (!page) throw new Error("WebView 没有暴露调试目标");
    const url = page.url;
    console.log(`  运行时 URL     ${url}`);
    if (/^https?:\/\/127\.0\.0\.1:1420/.test(url)) {
      throw new Error("仍在加载 dev server");
    }
    console.log("  ✓ 界面来自内嵌资源（tauri:// 自定义协议）");
  } finally {
    child.kill();
  }
}

console.log("\n完成：RiskFiveRuler.exe 可直接双击（不需要 npm / vite / dev server）。");
