/**
 * 通用确认框。
 *
 * 只有一个原因让它单独成文件：需要**三个以上**动作（保存并继续 / 不保存继续 / 取消），
 * 而 `confirm()` 只有两个。用例是「切换器件 —— 当前工程还没保存」。
 */

import { useEffect, useRef } from "react";

export interface ConfirmAction {
  /** 按钮文案 */
  label: string;
  /** primary = 主按钮（回车默认触发）；danger = 红色（丢弃数据之类） */
  tone?: "primary" | "danger" | "ghost";
  onPick: () => void;
}

interface Props {
  title: string;
  /** 说明文字，可多段 */
  message: React.ReactNode;
  actions: ConfirmAction[];
  onCancel: () => void;
  /** 取消按钮的文案，默认「取消」 */
  cancelLabel?: string;
}

export function ConfirmDialog({ title, message, actions, onCancel, cancelLabel = "取消" }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  // 默认焦点落在主按钮上：回车立刻执行最常见的选择
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // Esc 取消。注意 stopPropagation —— 上层还有其它 Esc 处理（关菜单等）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="modal">
      <div className="modal-dialog confirm-modal" role="dialog" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2 className="modal-title">{title}</h2>
          </div>
        </header>

        <div className="modal-body confirm-body">{message}</div>

        <footer className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <span className="spacer" />
          {actions.map((a, i) => {
            const tone = a.tone ?? (i === 0 ? "primary" : "ghost");
            const cls = tone === "primary" ? "btn-primary" : tone === "danger" ? "btn-danger" : "btn-ghost";
            return (
              <button
                key={a.label}
                ref={i === 0 ? primaryRef : undefined}
                className={`btn ${cls}`}
                onClick={a.onPick}
              >
                {a.label}
              </button>
            );
          })}
        </footer>
      </div>
    </div>
  );
}
