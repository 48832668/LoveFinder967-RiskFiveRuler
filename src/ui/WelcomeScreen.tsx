/**
 * 欢迎页。
 *
 * 为什么要有它：以前启动直接进编辑器，用户面对的是一个「已经建好、但什么都没有」的工程，
 * 既不知道自己刚才打开的是哪个文件，也没有显式的「开工」动作。桌面软件的通行做法是
 * 先给一页起点：最近打开的工程 + 新建 / 打开 / 作者主页。
 *
 * 退出条件只有三个：新建、打开、点最近一条 —— 都由父组件负责，这里只管展示。
 */

import type { RecentEntry } from "../platform/recent";
import { shortPath } from "../platform/recent";
import { APP_SERIES, AUTHOR_GITEE } from "../platform/appInfo";
import { inTauri } from "../platform/io";

interface Props {
  recent: RecentEntry[];
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (e: RecentEntry) => void;
  onClearRecent: () => void;
  onOpenAuthor: () => void;
  onSettings: () => void;
  onClose: () => void;
  /** 最近列表里的路径打不开时的原始错误，显示在底部而不是藏起来 */
  note?: string | null;
}

/** 相对时间：最近列表里「3 分钟前」比一串时间戳好读 */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `${d} 天前` : `${Math.floor(d / 30)} 个月前`;
}

export function WelcomeScreen({
  recent,
  onNew,
  onOpen,
  onOpenRecent,
  onClearRecent,
  onOpenAuthor,
  onSettings,
  onClose,
  note,
}: Props) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header className="welcome-head" data-tauri-drag-region>
          <div className="welcome-mark">
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
              <path d="M4 7h7v10H4z" fill="currentColor" opacity=".35" />
              <path d="M13 4h7v16h-7z" fill="currentColor" opacity=".7" />
              <path d="M4 12h6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </div>
          <div>
            <h1>RiskFiveRuler</h1>
            <p>{APP_SERIES.replace(" - RiskFiveRuler", "")} · 图形化引脚配置与代码生成</p>
          </div>
          <span className="spacer" />
          {inTauri() && (
            <div className="win-controls">
              <button className="win-btn close" onClick={onClose} title="关闭">✕</button>
            </div>
          )}
        </header>

        <div className="welcome-grid">
          {/* 左：最近打开 */}
          <section className="welcome-pane card">
            <div className="welcome-pane-head">
              <h2>最近打开</h2>
              {recent.length > 0 && (
                <button className="link sm" onClick={onClearRecent}>
                  清空列表
                </button>
              )}
            </div>

            {recent.length === 0 ? (
              <div className="welcome-empty">
                <p>还没有打开过工程。</p>
                <p className="muted">
                  新建一个，或者用「打开…」选一个 <code>.rfr</code> 工程文件。
                </p>
              </div>
            ) : (
              <ul className="welcome-recent">
                {recent.map((e) => (
                  <li key={e.path}>
                    <button onClick={() => onOpenRecent(e)} title={e.path}>
                      <span className="wr-name">{e.name}</span>
                      <span className="wr-meta">
                        <b>{e.deviceId}</b>
                        <em>{ago(e.at)}</em>
                      </span>
                      <span className="wr-path">{shortPath(e.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 右：动作 */}
          <section className="welcome-pane welcome-actions card">
            <h2>开始</h2>
            <button className="welcome-action primary" onClick={onNew}>
              <span className="wa-icon">＋</span>
              <span>
                <b>新建工程</b>
                <em>选一颗器件，从空白工程开始</em>
              </span>
            </button>
            <button className="welcome-action" onClick={onOpen}>
              <span className="wa-icon">▤</span>
              <span>
                <b>打开工程</b>
                <em>从磁盘读取 .rfr 工程文件</em>
              </span>
            </button>
            <button className="welcome-action" onClick={onOpenAuthor}>
              <span className="wa-icon">◎</span>
              <span>
                <b>作者 Gitee 主页</b>
                <em>{AUTHOR_GITEE.replace("https://", "")}</em>
              </span>
            </button>
            <button className="welcome-action" onClick={onSettings}>
              <span className="wa-icon">⚙</span>
              <span>
                <b>设置</b>
                <em>主题色 / 日夜模式 / 引脚图配色</em>
              </span>
            </button>
          </section>
        </div>

        {note ? (
          <footer className="welcome-foot">
            <span className="welcome-note">{note}</span>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
