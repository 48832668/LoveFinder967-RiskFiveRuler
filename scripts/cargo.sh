#!/usr/bin/env bash
# RiskFiveRuler — 本机隔离工具链构建脚本（Git Bash）
#
# 这台机器没有 MSVC，Rust 装在 %USERPROFILE%\.workbuddy-ai\binaries 下，
# 目标三元组固定 x86_64-pc-windows-gnu，链接器用 mingw64 的 gcc。
# PATH 必须用 MSYS 的 /c/... 写法，写成 C:/... 时 bash 自己找不到 cargo。
set -euo pipefail

BIN_ROOT="${USERPROFILE}/.workbuddy-ai/binaries"
BIN_ROOT_U="/c/Users/${USERNAME}/.workbuddy-ai/binaries"

export RUSTUP_HOME="${BIN_ROOT}/rust/rustup"
export CARGO_HOME="${BIN_ROOT}/rust/cargo"
export PATH="${BIN_ROOT_U}/rust/rustup/toolchains/stable-x86_64-pc-windows-gnu/bin:${BIN_ROOT_U}/mingw64/bin:${PATH}"

export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=gcc
export CC_x86_64_pc_windows_gnu=gcc
export CXX_x86_64_pc_windows_gnu=g++
export AR_x86_64_pc_windows_gnu=ar

# ⚠️ 不要加 -C target-feature=+crt-static。
# mingw-w64 的 UCRT 只有 import lib（libucrt.a → ucrtbase.dll），没有真正的
# 静态 UCRT；强行静态化会链接通过、加载即崩。api-ms-win-crt-*.dll 是
# Windows 10+ 自带的 API set，由系统加载器解析，不算额外依赖。
# （FinderSkin 踩过这个坑，结论写在其 .cargo/config.toml 里。）

# cargo 不读 HTTP_PROXY，必须显式给 CARGO_HTTP_PROXY
if [ -n "${HTTPS_PROXY:-}" ]; then export CARGO_HTTP_PROXY="${HTTPS_PROXY}"; fi
export CARGO_HTTP_TIMEOUT=120
export CARGO_NET_RETRY=5

cd "$(dirname "$0")/../src-tauri"
exec cargo "$@"
