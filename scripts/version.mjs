/**
 * 版本号：年月日 + 当日编译次数。
 *
 * 例：2026-11-05 的第 3 次构建 → `26.11.5.3`
 *
 * 计数存在仓库根目录的 `.build-counter.json` 里（日期 + 计数）。
 * `npm run build`（vite build）时 +1；`npm run dev` 只读不写，
 * 免得边调边把计数刷到几百。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COUNTER = ".build-counter.json";

export function versionStamp(bump) {
  const now = new Date();
  const date = `${String(now.getFullYear()).slice(2)}.${now.getMonth() + 1}.${now.getDate()}`;

  let state = { date: "", n: 0 };
  if (existsSync(COUNTER)) {
    try {
      const raw = JSON.parse(readFileSync(COUNTER, "utf8"));
      if (typeof raw?.date === "string" && Number.isFinite(raw?.n)) state = raw;
    } catch {
      // 文件坏了就当没有，重新从 1 开始
    }
  }

  // 跨天就归零：版本号里的日期和计数必须是同一天的
  if (state.date !== date) state = { date, n: 0 };

  if (bump) {
    state.n += 1;
    writeFileSync(COUNTER, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  // dev 且当日还没构建过时是 .0 —— 界面据此显示「开发模式」，不去假装成第 1 次构建
  return `${date}.${state.n}`;
}
