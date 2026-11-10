/**
 * 「最近打开」列表。
 *
 * 存在 localStorage 里：这类信息是本机偏好，不该写进工程文件
 * （换台机器打开同一个工程，不该带着别人的历史路径）。
 */
const KEY = "rfr.recent";
const LIMIT = 8;

export interface RecentEntry {
  /** 绝对路径（浏览器模式下是文件名） */
  path: string;
  /** 工程名，菜单里显示这个 */
  name: string;
  /** 器件型号，方便一眼认出是哪个片子 */
  deviceId: string;
  /** 最近一次访问的毫秒时间戳 */
  at: number;
}

export function loadRecent(): RecentEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x): x is RecentEntry => typeof x?.path === "string" && typeof x?.name === "string")
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** 记一条。同一个路径只保留一条，并按时间排到最前 */
export function pushRecent(entry: Omit<RecentEntry, "at">): RecentEntry[] {
  const list = loadRecent().filter((x) => x.path !== entry.path);
  list.unshift({ ...entry, at: Date.now() });
  const next = list.slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 隐私模式下 localStorage 可能不可写，静默降级：本次会话仍能用返回值
  }
  return next;
}

export function clearRecent(): RecentEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
  return [];
}

/** 只把路径从菜单里去掉（文件被删了、或路径失效） */
export function dropRecent(path: string): RecentEntry[] {
  const next = loadRecent().filter((x) => x.path !== path);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}

/** 菜单里显示：文件名 + 父目录，太长的路径从中间省略 */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
