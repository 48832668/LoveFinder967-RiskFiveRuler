/** 导出项：只要「相对路径 + 内容」，structural typing 让 GenFile[] 直接可用 */
export interface ExportFile {
  path: string;
  content: string;
}

/** 是否运行在 Tauri 壳里 */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 给 platform 内其他模块用的 IPC 通道（ui 层不直接碰 @tauri-apps） */
export async function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke: raw } = await import("@tauri-apps/api/core");
  return raw<T>(cmd, args);
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/** 保存工程 JSON */
export async function saveProjectFile(defaultName: string, json: string): Promise<string | null> {
  if (!inTauri()) {
    downloadText(`${defaultName}.rfr`, json);
    return `${defaultName}.rfr`;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "保存 RiskFiveRuler 工程",
    defaultPath: `${defaultName}.rfr`,
    filters: [{ name: "RiskFiveRuler 工程", extensions: ["rfr"] }],
  });
  if (!path) return null;
  await invoke("project_save", { path, content: json });
  return path;
}

/** 打开工程 JSON */
export async function openProjectFile(): Promise<{ path: string; content: string } | null> {
  if (!inTauri()) {
    const content = await pickFileBrowser();
    return content ? { path: "（浏览器）", content } : null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: "打开 RiskFiveRuler 工程",
    multiple: false,
    filters: [{ name: "RiskFiveRuler 工程", extensions: ["rfr", "json"] }],
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  const content = await invoke<string>("project_load", { path });
  return { path, content };
}

/** 导出生成代码目录；subdir 让 MRS 工程整体落进 <工程名>/ 子目录 */
export async function exportTree(files: ExportFile[], subdir?: string): Promise<string | null> {
  const prefix = subdir ? `${subdir.replace(/[\\/]+$/, "")}/` : "";
  const entries = files.map((f) => ({ path: `${prefix}${f.path}`, content: f.content }));
  if (!inTauri()) {
    for (const f of entries) downloadText(f.path.split("/").pop() ?? "file.txt", f.content);
    return "浏览器下载";
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ title: "选择导出目录", directory: true, multiple: false });
  const target = Array.isArray(dir) ? dir[0] : dir;
  if (!target) return null;
  await invoke("write_tree", { root: target, files: entries });
  return `${target}${prefix ? ` → ${prefix}` : ""}`;
}

/**
 * 导出到**已知目录**，不弹目录选择框。
 *
 * 工程已保存过（filePath 存在）时，生成代码直接落在工程所在目录 ——
 * 与「保存后一键生成」的工作流配套；未保存过的工程根本不给生成入口。
 */
export async function exportTreeTo(files: ExportFile[], root: string, subdir?: string): Promise<string | null> {
  const prefix = subdir ? `${subdir.replace(/[\\/]+$/, "")}/` : "";
  const entries = files.map((f) => ({ path: `${prefix}${f.path}`, content: f.content }));
  if (!inTauri()) {
    for (const f of entries) downloadText(f.path.split("/").pop() ?? "file.txt", f.content);
    return "浏览器下载";
  }
  const clean = root.replace(/[\\/]+$/, "");
  await invoke("write_tree", { root: clean, files: entries });
  return `${clean}${prefix ? ` → ${prefix}` : ""}`;
}

/**
 * 保存到**已知路径**，不弹对话框。
 *
 * 「保存」和「另存为」的区别就在这里：前者覆盖当前文件，后者总是重新选。
 * 浏览器里没有可写路径，仍然走下载（并返回文件名）。
 */
export async function saveProjectToPath(path: string, json: string): Promise<string | null> {
  if (!inTauri()) {
    const name = path || "RFR_Project.rfr";
    downloadText(name, json);
    return name;
  }
  await invoke("project_save", { path, content: json });
  return path;
}

/** 读一个已知路径（「最近打开」用）；失败返回 null，由调用方提示并把它从列表里去掉 */
export async function readProjectAt(path: string): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<string>("project_load", { path });
  } catch {
    return null;
  }
}

/**
 * 用系统默认浏览器打开链接。
 *
 * 没接 `plugin-opener` 的 Rust 侧（要额外加依赖），这里走一条自建命令：
 * 各平台直接调用系统打开方式，避免为了一个链接引入新 crate。
 */
export async function openExternal(url: string): Promise<void> {
  if (inTauri()) {
    await invoke("open_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 浏览器 / Tauri 通用：把文本下载成文件（设置导出兜底用） */
export function downloadTextFile(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 浏览器兜底：选一个文本文件读进来（设置导入用） */
export function readTextFileBrowser(accept = ".json,application/json"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.readAsText(f);
    };
    input.click();
  });
}

function downloadText(name: string, text: string) {
  downloadTextFile(name, text);
}

function pickFileBrowser(): Promise<string | null> {
  return readTextFileBrowser(".rfr,.json");
}
