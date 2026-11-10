/**
 * 界面偏好（config.json）。
 *
 * 桌面端：exe 同目录的 config.json —— 用户可以直接复制 / 覆盖这个文件换配置，
 * 客户端启动时自己载入。浏览器端：localStorage 兜底。
 *
 * 形状（扁平，saveUiPrefs 写出的就是这个）：
 * {
 *   "version": 1,
 *   "themeColor": "#008dd7",
 *   "mode": "dark",
 *   "beginner": true,
 *   "pinColors": { "USART": "#4fb3ff", ... }
 * }
 */

import { inTauri, readTextFileBrowser, tauriInvoke } from "./io";

export interface UiPrefs {
  version: 1;
  themeColor: string;
  mode: "dark" | "light";
  /** 新手模式：显示工作模式说明、寄存器位提示等教学注释 */
  beginner: boolean;
  pinColors: Record<string, string>;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  version: 1,
  themeColor: "#008dd7",
  mode: "dark",
  beginner: true,
  pinColors: {},
};

const LS_KEY = "rfr.uiprefs";
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * 容错解析：任何字段不合法就落回默认 —— config.json 用户手改得动，坏了别崩。
 *
 * 字段以 saveUiPrefs 写出的**扁平**结构为准（themeColor / mode / beginner / pinColors）；
 * 同时兼容早期文档里的嵌套 theme:{color,mode} 写法（手改文件的用户可能照旧注释写）。
 */
export function sanitizeUiPrefs(raw: unknown): UiPrefs {
  const out: UiPrefs = { ...DEFAULT_UI_PREFS, pinColors: {} };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  const theme = obj.theme as Record<string, unknown> | undefined;
  if (typeof obj.themeColor === "string" && HEX.test(obj.themeColor)) out.themeColor = obj.themeColor;
  else if (theme && typeof theme.color === "string" && HEX.test(theme.color)) out.themeColor = theme.color;
  if (obj.mode === "dark" || obj.mode === "light") out.mode = obj.mode;
  else if (theme && (theme.mode === "dark" || theme.mode === "light")) out.mode = theme.mode;
  if (typeof obj.beginner === "boolean") out.beginner = obj.beginner;
  if (obj.pinColors && typeof obj.pinColors === "object") {
    for (const [kind, color] of Object.entries(obj.pinColors as Record<string, unknown>)) {
      if (typeof color === "string" && HEX.test(color)) out.pinColors[kind] = color;
    }
  }
  return out;
}

/** 启动时载入。Tauri 读 exe 同目录 config.json；浏览器读 localStorage */
export async function loadUiPrefs(): Promise<UiPrefs> {
  if (inTauri()) {
    try {
      const text = await tauriInvoke<string | null>("config_read");
      if (!text) return { ...DEFAULT_UI_PREFS, pinColors: {} };
      return sanitizeUiPrefs(JSON.parse(text));
    } catch {
      return { ...DEFAULT_UI_PREFS, pinColors: {} };
    }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFS, pinColors: {} };
    return sanitizeUiPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_UI_PREFS, pinColors: {} };
  }
}

/** 保存。Tauri 原子写 config.json；浏览器写 localStorage */
export async function saveUiPrefs(prefs: UiPrefs): Promise<void> {
  const text = JSON.stringify(prefs, null, 2);
  if (inTauri()) {
    await tauriInvoke("config_write", { content: text });
    return;
  }
  try {
    localStorage.setItem(LS_KEY, text);
  } catch {
    // 隐私模式下可能不可写：本次会话仍生效，静默降级
  }
}

/** 导入：桌面弹文件框走 file_read_at；浏览器走 <input type=file> 兜底 */
export async function importPrefsJson(): Promise<UiPrefs | null> {
  if (inTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      title: "导入设置（config.json）",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return null;
    try {
      const text = await tauriInvoke<string>("file_read_at", { path });
      return sanitizeUiPrefs(JSON.parse(text));
    } catch {
      return null;
    }
  }
  const text = await readTextFileBrowser(".json,application/json");
  if (!text) return null;
  try {
    return sanitizeUiPrefs(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 导出：桌面弹保存框走 file_write_at；浏览器下载 config.json */
export async function exportPrefsJson(prefs: UiPrefs): Promise<boolean> {
  const text = JSON.stringify(prefs, null, 2);
  if (inTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "导出设置",
      defaultPath: "config.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return false;
    try {
      await tauriInvoke("file_write_at", { path, content: text });
      return true;
    } catch {
      return false;
    }
  }
  const { downloadTextFile } = await import("./io");
  downloadTextFile("config.json", text);
  return true;
}
