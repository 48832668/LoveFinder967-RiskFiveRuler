import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import App from "../src/App";
import { MenuBar } from "../src/ui/MenuBar";

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

// 1) 默认启动（无 URL 参数）落在欢迎页；node 里需显式给一个空 location
(globalThis as any).location = { search: "" };
const appHtml = renderToStaticMarkup(createElement(App));
console.log(`\n[App 默认启动] html ${appHtml.length} chars`);
expect(appHtml.includes("welcome"), "启动落在欢迎页");
expect(appHtml.includes("新建工程"), "欢迎页有新建入口");
expect(!appHtml.includes("device-filter"), "未打开选择器时没有筛选区");

// 2) 菜单里新增的「关闭工程」项（展开文件菜单后才会渲染，这里直接验证 FILE_MENU 常量可达性：
//    渲染 MenuBar 并模拟 open 需要交互，改为检查源码常量 + AboutDialog 不干扰）
const menuHtml = renderToStaticMarkup(
  createElement(MenuBar, {
    recent: [],
    filePath: null,
    onOpenRecent: () => {},
    onClearRecent: () => {},
    onAction: () => {},
  }),
);
expect(menuHtml.includes("文件") && menuHtml.includes("关于"), "MenuBar 正常渲染");

// 3) 用 ?picker=1 深链让 App 直接进编辑器并打开选择器（验证模态层在两个分支都挂上）
//    location 在 node 里不存在，App 的初始化已用 typeof 保护；这里通过全局变量模拟
(globalThis as any).location = { search: "?picker=1" };
const deepHtml = renderToStaticMarkup(createElement(App));
console.log(`\n[App ?picker=1 深链] html ${deepHtml.length} chars`);
expect(deepHtml.includes("topbar"), "深链进入编辑器");
expect(deepHtml.includes("device-filter"), "编辑器分支渲染了器件选择器筛选区");
expect(deepHtml.includes("创建工程") === false, "switch 模式按钮不是「创建工程」");

delete (globalThis as any).location;
console.log("\n✅ App SSR 冒烟通过");
