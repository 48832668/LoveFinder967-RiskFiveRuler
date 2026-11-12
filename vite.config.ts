import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { versionStamp } from "./scripts/version.mjs";

const host = process.env.TAURI_DEV_HOST;

/**
 * 把版本号注入前端：`__APP_VERSION__` = `26.11.12`（年月日三段式）。
 *
 * 同日多次构建共用同一版本号，不再按编译次数递增；
 * Tauri 的 beforeBuildCommand 就是 `npm run build`，所以 exe 里与 dist 一致。
 */
function versionPlugin() {
  let version = "0.0.0";
  return {
    name: "rfr-version",
    config() {
      version = versionStamp();
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
