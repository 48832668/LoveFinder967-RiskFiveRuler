#!/usr/bin/env node
/**
 * 跑纯 Rust 核心（rfr-core）的单测。
 *
 * 为什么不直接 `cargo test`：
 *   - 本机工具链装在 %USERPROFILE%\.workbuddy-ai\binaries，不在系统 PATH；
 *   - Tauri 的 lib 会链接 WebView2，在 MinGW 下测试进程启动会失败；
 *   所以 layer1/layer2 被抽成独立的 rfr-core crate，这里只测它。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(ROOT, "src-tauri", "Cargo.toml");
const env = { ...process.env };

const binRoot = path.join(os.homedir(), ".workbuddy-ai", "binaries");
const rustBin = path.join(binRoot, "rust", "rustup", "toolchains", "stable-x86_64-pc-windows-gnu", "bin");
const mingwBin = path.join(binRoot, "mingw64", "bin");
const cargoExe = path.join(rustBin, "cargo.exe");

if (process.platform === "win32" && fs.existsSync(cargoExe)) {
  env.PATH = [rustBin, mingwBin, path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
  env.RUSTUP_HOME = path.join(binRoot, "rust", "rustup");
  env.CARGO_HOME = path.join(binRoot, "rust", "cargo");
  env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "gcc";
  env.CC_x86_64_pc_windows_gnu = "gcc";
  env.CXX_x86_64_pc_windows_gnu = "g++";
  env.AR_x86_64_pc_windows_gnu = "ar";
}

const cargo = process.platform === "win32" && fs.existsSync(cargoExe) ? cargoExe : "cargo";
const r = spawnSync(cargo, ["test", "-p", "rfr-core", "--manifest-path", manifest], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

if (r.error) {
  console.error(`找不到 cargo：${r.error.message}`);
  console.error("请安装 Rust，或把工具链放到 %USERPROFILE%\\.workbuddy-ai\\binaries。");
  process.exit(1);
}
process.exit(r.status ?? 1);
