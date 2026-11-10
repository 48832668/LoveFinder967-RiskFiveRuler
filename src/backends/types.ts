/**
 * 代码生成后端契约（L5 的门面）。
 *
 * 为什么需要它：`codegen.ts` 里的 `genPeripheralInit` 是一个 34 个 case 的 switch，
 * 每个 case 都在拼 WCH 标准外设库的宏（`RCC_APB2PeriphClockCmd`、`GPIO_Mode_AF_PP`…）。
 * 换一家厂商（HC32 的 DDL、STM32 的 HAL）不是「加几个 if」，而是**另一套宏**。
 * 所以按后端分流，每个后端一个目录，互不引用。
 *
 * 约定：
 *   - 后端**只读** Project / DeviceDef，不改它们；
 *   - 后端不 import `ui/`、不 import 其它后端；
 *   - `emit()` 必须返回完整的可落盘文件列表（含 README）。
 */

import type { DeviceDef, Project } from "../model/types";

export interface GenFile {
  path: string;
  /** 仅用于代码面板的高亮与图标 */
  lang: string;
  content: string;
}

export interface CodegenBackend {
  id: string;
  /** 界面上显示的名字，如「WCH 标准外设库 (SPL)」 */
  label: string;
  /**
   * 这个后端是否真的能产出可用代码。
   * false 表示只有引脚表 + TODO —— 界面会显著提示，避免用户以为能直接编译。
   */
  complete: boolean;
  emit(project: Project, dev: DeviceDef): GenFile[];
}
