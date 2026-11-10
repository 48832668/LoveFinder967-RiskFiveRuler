# -*- coding: utf-8 -*-
"""用真实 SDK 头文件校验生成代码里的每一个符号。

为什么需要它：WCH 各系列的标准外设库**不是同一套 API**。同一个功能在不同系列上
叫法不同（X035 的 ADC 时钟是 `ADC_CLKConfig(ADC1, ADC_CLK_Div6)`，
V30x 是 `RCC_ADCCLKConfig(RCC_PCLK2_Div8)`），少一个符号就是一条编译错误，
而这种错误在界面上完全看不出来 —— 只有真的拿去编译才会暴露。

用法：
  python scripts/check_codegen_api.py "<头文件目录>[;<头文件目录>...]" <生成代码目录> [更多目录...]

输出：
  每个"未在头文件里找到"的符号一行，最后给汇总。退出码 1 表示有缺失。
"""

import io
import os
import re
import sys
from collections import defaultdict

# 形如 FOO_Bar(...) 的调用，或 FOO_BAR 这种宏
CALL_RE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\s*\(")
MACRO_RE = re.compile(r"\b([A-Z][A-Z0-9_]{2,})\b")

# C 关键字 / 自己定义的标识符 / 标准库，不参与校验
IGNORE = {
    "if", "for", "while", "switch", "return", "sizeof", "defined",
}

# 我们自己的生成物，不属于 SDK
OWN_PREFIX = ("RFR_", "__RFR")

# 生成代码里**我们自己定义**的函数（中断服务函数、启动钩子），
# 它们本来就不该在 SDK 头文件里
OWN_DEFS = {
    "NMI_Handler", "HardFault_Handler", "SystemInit", "SystemCoreClockUpdate",
}


def is_own_symbol(sym):
    if sym.startswith(OWN_PREFIX) or sym in OWN_DEFS:
        return True
    # 中断服务函数：XXX_IRQHandler / XXX_Handler
    if sym.endswith("_IRQHandler") or sym.endswith("_Handler"):
        return True
    # 我们自己生成的引脚宏（rfr_pinmap.h 里定义，形如 DEBUG_TX_PIN / GPIOA_PORT）
    if sym.endswith("_PIN") or sym.endswith("_PORT"):
        return True
    return False


def collect_header_symbols(inc_dirs):
    """把若干目录里所有 .h 的标识符收集起来（函数名 + 宏名）。"""
    funcs = set()
    macros = set()
    headers = []
    for inc_dir in inc_dirs:
        if not os.path.isdir(inc_dir):
            continue
        for name in os.listdir(inc_dir):
            if name.endswith(".h"):
                headers.append(os.path.join(inc_dir, name))
    for path in headers:
        text = io.open(path, encoding="utf-8", errors="replace").read()
        # 去掉注释，避免注释里的示例代码干扰
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
        text = re.sub(r"//[^\n]*", " ", text)
        funcs.update(CALL_RE.findall(text))
        macros.update(MACRO_RE.findall(text))
    return funcs, macros


def collect_code_symbols(code_paths):
    calls = defaultdict(set)
    macros = defaultdict(set)
    for path in code_paths:
        text = io.open(path, encoding="utf-8", errors="replace").read()
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
        text = re.sub(r"//[^\n]*", " ", text)
        rel = os.path.basename(path)
        for m in CALL_RE.findall(text):
            calls[m].add(rel)
        for m in MACRO_RE.findall(text):
            macros[m].add(rel)
    return calls, macros


def main():
    # 头文件目录可以有多个，用 : 分隔（Peripheral/inc 与 Debug 都要扫）
    inc_dirs = [d.strip() for d in sys.argv[1].split(";") if d.strip()]
    code_paths = []
    for root in sys.argv[2:]:
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.endswith((".c", ".h")):
                    code_paths.append(os.path.join(dirpath, f))

    if not code_paths:
        print("没有找到要校验的 .c / .h 文件")
        return 1

    funcs, macros = collect_header_symbols(inc_dirs)
    calls, used_macros = collect_code_symbols(code_paths)

    missing_calls = []
    for sym, where in sorted(calls.items()):
        if sym in IGNORE or is_own_symbol(sym):
            continue
        if sym in funcs or sym in macros:
            continue
        missing_calls.append((sym, sorted(where)))

    missing_macros = []
    for sym, where in sorted(used_macros.items()):
        if sym in IGNORE or is_own_symbol(sym):
            continue
        if sym in macros or sym in funcs:
            continue
        # 纯大写单词可能是我们自己的枚举字符串，只报带下划线且长度 >= 6 的
        if "_" not in sym or len(sym) < 6:
            continue
        missing_macros.append((sym, sorted(where)))

    total_syms = len(calls) + len(used_macros)
    print(f"头文件目录: {', '.join(d for d in inc_dirs if os.path.isdir(d))}")
    print(f"待校验文件: {len(code_paths)} 个，用到 {total_syms} 个符号")
    print(f"头文件里: {len(funcs)} 个函数名 / {len(macros)} 个宏")
    print()

    if not missing_calls and not missing_macros:
        print("✅ 全部符号都能在 SDK 头文件里找到")
        return 0

    if missing_calls:
        print(f"❌ 头文件里找不到的函数调用（{len(missing_calls)}）:")
        for sym, where in missing_calls:
            print(f"   {sym}()   ← {', '.join(where)}")
        print()
    if missing_macros:
        print(f"❌ 头文件里找不到的宏（{len(missing_macros)}）:")
        for sym, where in missing_macros:
            print(f"   {sym}   ← {', '.join(where)}")
        print()

    return 1


if __name__ == "__main__":
    sys.exit(main())
