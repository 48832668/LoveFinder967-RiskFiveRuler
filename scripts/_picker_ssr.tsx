import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DevicePicker } from "../src/ui/DevicePicker";

function render(mode: "new" | "switch") {
  const html = renderToStaticMarkup(
    createElement(DevicePicker, {
      current: "CH32L103C8T6",
      mode,
      onPick: () => {},
      onClose: () => {},
    }),
  );
  return html;
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

for (const mode of ["new", "switch"] as const) {
  const html = render(mode);
  console.log(`\n[mode=${mode}] html ${html.length} chars`);
  expect(html.includes("device-filter"), "筛选区已渲染");
  expect(html.includes("搜索型号"), "搜索框已渲染");
  expect(html.includes("RISC-V") && html.includes("ARM") && html.includes("Xtensa"), "内核筛选齐全");
  expect(html.includes("USB PD") && html.includes("I²C") && html.includes("SPI"), "外设筛选齐全");
  expect(html.includes("全部系列"), "系列列表含「全部系列」");
  expect(html.includes("命中"), "命中计数已渲染");
  // 中间栏默认只列当前系列；其它系列在左侧列表里，点「全部系列」才一起出现
  expect(html.includes("CH32L103C8T6"), "型号列表含当前系列型号");
  expect(html.includes("CH32V407") && html.includes("HC32F401B"), "左侧系列列表含其它系列");
  if (mode === "new") {
    expect(html.includes("新建工程 · 选择器件"), "标题为新建工程");
    expect(html.includes("创建工程"), "确定按钮为「创建工程」");
    expect(!html.includes("part-row picked"), "new 模式不预选任何型号");
  } else {
    expect(html.includes("更换器件"), "标题为更换器件");
    expect(html.includes("CH32L103C8T6"), "switch 模式预选当前型号");
  }
}

console.log("\n✅ DevicePicker SSR 渲染验证通过");
