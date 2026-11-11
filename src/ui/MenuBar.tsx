import { useEffect, useRef, useState } from "react";
import type { RecentEntry } from "../platform/recent";
import { shortPath } from "../platform/recent";

export type MenuAction =
  | "new"
  | "open"
  | "close"
  | "save"
  | "saveAs"
  | "export"
  | "settings"
  | "about"
  | "author";

interface Props {
  recent: RecentEntry[];
  /** 当前文件的绝对路径；没有就是「未保存」 */
  filePath: string | null;
  /** 最近打开子菜单里点了一条 */
  onOpenRecent: (entry: RecentEntry) => void;
  onClearRecent: () => void;
  onAction: (a: MenuAction) => void;
}

interface Item {
  id?: MenuAction;
  label?: string;
  keys?: string;
  sep?: true;
  recent?: true;
  disabled?: boolean;
}

const FILE_MENU: Item[] = [
  { id: "new", label: "新建工程", keys: "Ctrl+N" },
  { id: "open", label: "打开…", keys: "Ctrl+O" },
  { recent: true },
  { id: "close", label: "关闭工程" },
  { sep: true },
  { id: "save", label: "保存", keys: "Ctrl+S" },
  { id: "saveAs", label: "另存为…", keys: "Ctrl+Shift+S" },
  { sep: true },
  { id: "export", label: "导出代码目录…", keys: "Ctrl+E" },
];

const ABOUT_MENU: Item[] = [
  { id: "settings", label: "设置" },
  { id: "about", label: "关于本软件" },
  { id: "author", label: "作者 Gitee 主页" },
];

/**
 * 顶部菜单栏。
 *
 * 做成点击展开 + 悬停切换（开着的时候鼠标划过去就切过去），键盘 Esc 关闭、
 * 点空白处关闭 —— 这是桌面软件的通行手感，比只支持点击的更顺手。
 */
export function MenuBar({ recent, filePath, onOpenRecent, onClearRecent, onAction }: Props) {
  const [open, setOpen] = useState<"file" | "about" | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 工程没保存过就不给「导出代码目录」入口 —— 生成代码需要落盘目录
  const fileMenu = FILE_MENU.filter((i) => !("id" in i) || i.id !== "export" || Boolean(filePath));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(null);
        setRecentOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setRecentOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (a: MenuAction) => {
    setOpen(null);
    setRecentOpen(false);
    onAction(a);
  };

  const renderItems = (items: Item[]) =>
    items.map((it, i) => {
      if (it.sep) return <div className="menubar-sep dropdown-divider" key={`s${i}`} />;

      // 最近打开：做成二级菜单，没有记录时灰掉
      if (it.recent) {
        return (
          <div
            className={`menu-item dropdown-item has-sub ${recentOpen ? "sub-open" : ""} ${recent.length ? "" : "disabled"}`}
            key="recent"
            onMouseEnter={() => recent.length && setRecentOpen(true)}
            onClick={() => recent.length && setRecentOpen((v) => !v)}
          >
            <span>最近打开</span>
            <span className="menu-arrow">▸</span>
            {recentOpen && recent.length > 0 && (
              <div className="menu-sub menubar-sub dropdown">
                {recent.map((r) => (
                  <button
                    className="menu-item menubar-recent dropdown-item"
                    key={r.path}
                    title={r.path}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(null);
                      setRecentOpen(false);
                      onOpenRecent(r);
                    }}
                  >
                    <span>{r.name}</span>
                    <span className="meta">
                      {r.deviceId} · {shortPath(r.path)}
                    </span>
                  </button>
                ))}
                <div className="menubar-sep dropdown-divider" />
                <button
                  className="menu-item dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearRecent();
                    setRecentOpen(false);
                  }}
                >
                  <span>清空列表</span>
                </button>
              </div>
            )}
          </div>
        );
      }

      // 「保存」在还没有文件路径时也能用（等价于另存为），所以不按 filePath 禁用
      if (it.id === "save" && !filePath) {
        return (
          <button className="menu-item dropdown-item" key={it.id} onClick={() => pick("save")}>
            <span>保存</span>
            <span className="menubar-shortcut">{it.keys}（尚未保存过，将提示选路径）</span>
          </button>
        );
      }

      return (
        <button className="menu-item dropdown-item" key={it.id} disabled={it.disabled} onClick={() => it.id && pick(it.id)}>
          <span>{it.label}</span>
          {it.keys && <span className="menubar-shortcut">{it.keys}</span>}
        </button>
      );
    });

  return (
    <div className="menubar" ref={boxRef}>
      <button
        className={`menubar-item ${open === "file" ? "is-active" : ""}`}
        onClick={() => setOpen(open === "file" ? null : "file")}
        onMouseEnter={() => open && setOpen("file")}
      >
        文件
      </button>
      <button
        className={`menubar-item ${open === "about" ? "is-active" : ""}`}
        onClick={() => setOpen(open === "about" ? null : "about")}
        onMouseEnter={() => open && setOpen("about")}
      >
        关于
      </button>

      {open === "file" && <div className="menu-pop menubar-menu dropdown">{renderItems(fileMenu)}</div>}
      {open === "about" && <div className="menu-pop about-pop menubar-menu dropdown">{renderItems(ABOUT_MENU)}</div>}
    </div>
  );
}
