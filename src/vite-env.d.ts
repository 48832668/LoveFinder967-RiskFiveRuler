/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

/** 构建时注入：`26.11.5.3`（年月日 + 当日编译次数） */
declare const __APP_VERSION__: string;
