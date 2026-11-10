import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { versionStamp } from "./scripts/version.mjs";

const host = process.env.TAURI_DEV_HOST;

/**
 * 把版本号注入前端：`__APP_VERSION__` = `26.11.5.3`。
 *
 * 只在 `vite build` 时累加当日计数 —— dev 反复热更新不该把计数刷爆。
 * Tauri 的 beforeBuildCommand 就是 `npm run build`，所以打包进 exe 的版本号与 dist 一致。
 */
function versionPlugin() {
  let version = "0.0.0.0";
  return {
    name: "rfr-version",
    config(config, env) {
      version = versionStamp(env.command === "build");
      return { define: { __APP_VERSION__: JSON.stringify(version) } };
    },
  };
}

export default defineConfig({
  plugins: [versionPlugin(), react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**", "**/node_modules/**"],
    },
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
