/**
 * MCU 代码库（mculib）—— 收录各厂商的标准外设库源文件，生成代码时原样
 * 写进导出的工程，让导出的 MRS / Make 工程开箱可编译。
 *
 * 目录约定：`wch/<sdkHeader>/`，`<sdkHeader>` 与器件包的 `sdkHeader` 一致
 * （ch32l103 / ch32x035 / ch32v4x7）；X033 与 X035 共用 ch32x035 库，
 * V467 与 V407 共用 ch32v4x7 库。目录结构照抄 WCH EVT 的 `EXAM/SRC/`：
 *
 * ```
 * Core/          core_riscv.c|h
 * Debug/         debug.c|h
 * Ld/            Link.ld
 * Peripheral/    inc/*.h  src/*.c
 * Startup/       startup_*.S
 * ```
 *
 * 库文件来源：WCH 官方 EVT（docs/CH32L103EVT.ZIP 等）里的 EXAM/SRC，
 * 逐字节拷贝、未做任何修改。HC32 暂无官方库，器件包 codegen=disable，
 * 不参与本目录。
 */

/** 一个待写入工程的文件（相对工程根的路径 + 文本内容） */
export interface LibFile {
  path: string;
  content: string;
}

/**
 * Vite 只识别**直接调用** `import.meta.glob(...)`（赋值给变量会绕过它的静态改写）。
 * 非 Vite 运行环境（golden 测试的 esbuild 打包）下该函数不存在，调用会抛
 * TypeError —— 捕获后模块表为空，mculibFilesFor 返回空数组，调用方退回纯生成结果。
 */
let modules: Record<string, string> = {};
try {
  modules = import.meta.glob("./wch/**/*", { query: "?raw", import: "default", eager: true });
} catch {
  modules = {};
}

const loaders = new Map<string, () => Promise<string>>(
  Object.entries(modules).map(([k, v]) => [k, () => Promise.resolve(v)]),
);

/** 库目录是否存在（没有官方库的厂商返回 false，调用方不掺库文件） */
export function hasMculib(sdkHeader: string): boolean {
  const prefix = `./wch/${sdkHeader}/`;
  return [...loaders.keys()].some((k) => k.startsWith(prefix));
}

/**
 * 某个 SDK 的全部库文件。
 *
 * eager 模式：文件内容随应用打包（约 3MB），导出工程时零延迟；
 * 库文件本来就是「生成代码」功能的必需资产，不参与启动关键路径。
 */
export async function mculibFilesFor(sdkHeader: string): Promise<LibFile[]> {
  const prefix = `./wch/${sdkHeader}/`;
  const out: LibFile[] = [];
  for (const [key, load] of loaders) {
    if (!key.startsWith(prefix)) continue;
    const rel = key.slice(prefix.length).replace(/^\.\//, "");
    out.push({ path: rel, content: await load() });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
