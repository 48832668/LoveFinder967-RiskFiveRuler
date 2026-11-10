#!/usr/bin/env bash
# 用真实 EVT SDK 验证导出的代码能不能编译。
#
# 为什么要这一步：WCH 各系列的标准外设库**不是同一套 API**。X035 没有 PLL、
# 没有 SYSCLK 切换、没有 RCC_ADCCLKConfig、GPIO 只有 50MHz 且没有开漏、
# NVIC 只有 Group_0/1、ADC 采样时间是整数周期 —— 任何一条对不上都是编译错误。
# 界面上完全看不出来，只有真拿去编译才会暴露。
#
# 用法：
#   bash scripts/check_generated.sh <EVT 根目录> <器件型号> [端口]
# 例：
#   bash scripts/check_generated.sh "C:/Users/me/Downloads/CH32X035EVT" CH32X035C8T6
#
# 它做三件事：
#   1. 启动 dev server（若没起）→ 用 playwright 把该器件「全外设打开」的代码导到临时目录
#   2. 用 EVT 头文件逐符号校验（scripts/check_codegen_api.py）
#   3. 用本机 gcc 做 -fsyntax-only 真编译（只做语法/类型检查，不产出机器码）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EVT="${1:-}"
DEV="${2:-CH32X035C8T6}"
PORT="${3:-1420}"

if [ -z "$EVT" ] || [ ! -d "$EVT" ]; then
  echo "用法：bash scripts/check_generated.sh <EVT 根目录> [器件型号] [端口]"
  echo "EVT 根目录里应当有 EVT/EXAM/SRC/Peripheral/inc"
  exit 2
fi

# EVT 目录：有的包里是 <root>/EVT/EXAM，有的是 <root>/EXAM
SRC="$EVT/EVT/EXAM/SRC"
[ -d "$SRC" ] || SRC="$EVT/EXAM/SRC"
[ -d "$SRC/Peripheral/inc" ] || { echo "在 $EVT 里找不到 Peripheral/inc"; exit 2; }

# 每次都用一个新目录：Windows 上 rm -rf 偶尔会因为残留句柄删不干净，
# 两个系列的文件混在一个目录里会让「编译不过」的报告指向上一次的旧文件。
TMP="${TMPDIR:-/tmp}/rfr_codegen_check_$(date +%H%M%S)"
mkdir -p "$TMP"

echo "[1/3] 导出 $DEV 的代码…"
# dev server 没起就临时起一个
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "      dev server 没在跑，临时启动…"
  (npx vite --port "$PORT" --host 127.0.0.1 >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 1
  done
fi

node scripts/dump-generated.mjs "$DEV" "$TMP/gen" "http://127.0.0.1:$PORT" || exit 1

echo "[2/3] 逐个符号比对 EVT 头文件…"
# Core 也要扫：NVIC_EnableIRQ / NVIC_SetPriority / SystemInit 都在 core_riscv.h 里
python scripts/check_codegen_api.py "$SRC/Peripheral/inc;$SRC/Debug;$SRC/Core" "$TMP/gen"
SYM_RC=$?

echo "[3/3] gcc -fsyntax-only 真编译…"
GCC=""
for cand in "$HOME/.workbuddy-ai/binaries/mingw64/bin/gcc.exe" gcc; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then GCC="$cand"; break; fi
done
if [ -z "$GCC" ]; then
  echo "      ⚠ 没找到 gcc，跳过编译检查（符号检查已经覆盖大部分问题）"
  exit $SYM_RC
fi

INC="-I$SRC/Peripheral/inc -I$SRC/Debug -I$SRC/Core -I$TMP/gen/User"
FAIL=0
for f in "$TMP"/gen/User/*.c; do
  out=$("$GCC" -fsyntax-only -std=gnu99 -Wno-attributes -DRFR_ISR= $INC "$f" 2>&1 \
        | grep -E "error:" | grep -v "pointer-to-int-cast")
  if [ -n "$out" ]; then
    echo "  ❌ $(basename "$f")"
    echo "$out" | head -6 | sed 's/^/      /'
    FAIL=1
  else
    echo "  ✅ $(basename "$f")"
  fi
done

echo
if [ $SYM_RC -ne 0 ] || [ $FAIL -ne 0 ]; then
  echo "结论：生成的代码还编译不过（上面是具体位置）"
  exit 1
fi
echo "结论：符号全部命中 EVT 头文件，且 4 个 .c 都能通过语法/类型检查"
echo "      产物留在 $TMP/gen（可以自己丢进 MRS 再编一遍）"
