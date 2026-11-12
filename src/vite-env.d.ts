/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

/** 构建时注入：`26.11.12`（年月日，三段式） */
declare const __APP_VERSION__: string;
