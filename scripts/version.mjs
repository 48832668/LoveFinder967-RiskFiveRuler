/**
 * 版本号：YY.M.D（年月日，一律三段式）。
 *
 * 例：2026-11-12 → `26.11.12`
 *
 * 不再按当日编译次数递增：同一天的多次构建共用同一个版本号，
 * 具体构建用构建时间与文件哈希区分（见发布包里的 BUILD-INFO.txt）。
 * dev 与 build 返回相同值；非 Vite 环境由 appVersion() 兜底成 "dev"。
 */
export function versionStamp() {
  const now = new Date();
  const y = String(now.getFullYear()).slice(2);
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${y}.${m}.${d}`;
}
