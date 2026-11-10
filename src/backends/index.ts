/**
 * 后端注册表 —— `generate()` 的唯一入口。
 *
 * 器件包里的 `backend` 字段决定用哪个（`DeviceDef.backend` 由加载器按 vendor 兜底）。
 * 新增厂商 = 在本表加一行 + 在那个后端目录里实现 `CodegenBackend`，**不动上层**。
 */

import type { DeviceDef, Project } from "../model/types";
import { generate as generateWchSpl } from "./wch/codegen";
import { genericBackend, pinmapOnly } from "./generic";
import type { CodegenBackend, GenFile } from "./types";

export type { CodegenBackend, GenFile } from "./types";
export { pinmapOnly };

/** WCH 标准外设库后端：实现已迁到 `backends/wch/codegen.ts` */
const wchSpl: CodegenBackend = {
  id: "wch-spl",
  label: "WCH 标准外设库 (SPL)",
  complete: true,
  emit: (project: Project, dev: DeviceDef) => generateWchSpl(project, dev),
};

const REGISTRY: Record<string, CodegenBackend> = {
  [wchSpl.id]: wchSpl,
  [genericBackend.id]: genericBackend,
};

export const BACKENDS = Object.values(REGISTRY);

export function backendOf(dev: DeviceDef): CodegenBackend {
  return REGISTRY[dev.backend] ?? genericBackend;
}

/**
 * 按器件选择后端生成代码。
 *
 * 与旧 `codegen.generate()` 的区别：那个只支持 WCH。现在调用方统一走这里，
 * 未实现后端的厂商会拿到「引脚表 + TODO」而不是一段错的 SPL 代码。
 */
export function generate(project: Project, dev: DeviceDef): GenFile[] {
  // 资料不足的器件一律不生成 —— 编出来的初始化代码比没有更糟
  if (!dev.codegenEnabled) return [];
  return backendOf(dev).emit(project, dev);
}

/** 该器件生成的代码能不能直接编译（界面上要显示提示） */
export function codeIsCompilable(dev: DeviceDef): boolean {
  return dev.codegenEnabled && backendOf(dev).complete;
}
