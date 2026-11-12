import { useEffect } from "react";
import { openExternal } from "../platform/io";
import { APP_SERIES, APP_TAGLINE, AUTHOR_GITEE, appVersion } from "../platform/appInfo";

interface Props {
  onClose: () => void;
}

/**
 * 关于本软件。
 *
 * 版本号来自构建时注入的 `__APP_VERSION__`（年月日 + 当日编译次数），
 * 所以截图报 bug 时对方能直接对上是哪一次构建。
 */
export function AboutDialog({ onClose }: Props) {
  // Esc 关闭。点背景不关闭，与其它弹窗保持同一行为契约。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const version = appVersion();
  const [y, m, d, n] = version.split(".");
  const built = y ? `20${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "开发环境";
  // .0 = 开发服务器（当日还没跑过正式构建），别把它说成「第 0 次构建」
  const isDev = version === "dev" || n === "0";

  return (
    <div className="modal">
      <div className="modal-dialog about-modal" role="dialog" aria-label="关于本软件">
        <header className="modal-header">
          <div>
            <h2 className="modal-title">关于本软件</h2>
            <p>{APP_TAGLINE}</p>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </header>

        <div className="modal-body about-body">
          <div className="about-mark">
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
              <path d="M4 7h7v10H4z" fill="currentColor" opacity=".35" />
              <path d="M13 4h7v16h-7z" fill="currentColor" opacity=".7" />
              <path d="M4 12h6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </div>

          <div className="about-title">{APP_SERIES}</div>

          <dl className="about-kv">
            <dt>版本号</dt>
            <dd className="mono">{version}</dd>

            <dt>构建日期</dt>
            <dd>
              {built}
              {isDev ? (
                <span className="muted">（开发模式，当日尚未正式构建）</span>
              ) : (
                <span className="muted">（当日第 {n} 次构建）</span>
              )}
            </dd>

            <dt>版本号规则</dt>
            <dd className="muted">年月日 + 当日编译次数</dd>
          </dl>
        </div>

        <footer className="modal-footer">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void openExternal(AUTHOR_GITEE)}
            title={AUTHOR_GITEE}
          >
            作者 Gitee 主页
          </button>
        </footer>
      </div>
    </div>
  );
}
