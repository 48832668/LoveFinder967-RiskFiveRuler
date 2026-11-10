/**
 * 软件身份信息。
 *
 * 版本号不在这里写死 —— 它由构建脚本按「年月日 + 当日编译次数」注入
 * （`__APP_VERSION__`，见 `scripts/version.mjs`），避免出现「文档写 1.2、包里是 1.3」。
 */
export const APP_NAME = "RiskFiveRuler";
/** 产品的完整标识，关于本软件的第一行 */
export const APP_SERIES = "LoveFinderSeriesNO.967 - RiskFiveRuler";
export const APP_TAGLINE = "多厂商 32 位 MCU 图形化引脚配置与代码生成";

/** 作者主页：换仓库只改这里 */
export const AUTHOR_GITEE = "https://gitee.com/LoveFinderSeriesOfficial";

/** 构建时注入的版本号；在 `vite build` 之外（如单元测试）兜底成 dev */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}
