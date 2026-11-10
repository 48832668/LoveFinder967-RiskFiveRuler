/**
 * 界面冒烟测试 —— 覆盖「Rust 外壳 + 分层前端 + FinderSkin 组件」的关键链路。
 *
 *   npm run dev            # 另开一个终端
 *   node scripts/ui-smoke.mjs
 *
 * 依赖 playwright（devDependency），用本机已装的 Edge，不额外下载浏览器。
 * 若跑在 CI：RFR_URL=http://127.0.0.1:1420
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = process.env.RFR_URL ?? "http://127.0.0.1:1420";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch({ channel: "msedge" });
let failed = 0;

const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("Failed to load resource")) {
    errors.push(m.text());
  }
});

/* ── 0. 分层边界：core/ 只剩 re-export ─────────────────────────── */
{
  const coreDir = path.join(ROOT, "src", "core");
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        const body = fs
          .readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "")
          .trim();
        if (!/^export \* from "[^"]+";$/.test(body)) bad.push(path.relative(ROOT, p));
      }
    }
  };
  walk(coreDir);
  check(bad.length === 0, "core/ 兼容层只做 re-export", bad.join(", "));
}

/* ── 1. 欢迎页 / 编辑器 / 主题切换 ─────────────────────────────── */
{
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  check((await page.locator(".welcome").count()) === 1, "启动落在欢迎页");
  check((await page.locator(".workspace").count()) === 0, "欢迎页不显示编辑器");
  check((await page.getByText("支持 WCH CH32", { exact: false }).count()) === 0, "欢迎页不再显示支持型号文案");

  await page.goto(`${BASE}/?demo=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check((await page.locator(".workspace").count()) === 1, "深链进入编辑器");
  check((await page.locator(".topnav .nav-link").count()) >= 4, "顶部导航使用 FinderSkin .nav-link");

  const bgPixel = () =>
    page.evaluate(() => {
      const cv = document.querySelector(".pinout-canvas canvas");
      const d = cv.getContext("2d").getImageData(2, 2, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    });
  const dark = await bgPixel();
  await page.locator(".top-actions .btn-icon").click();
  await page.waitForTimeout(500);
  const light = await bgPixel();
  check(dark !== light, "切换明暗后引脚图立即重绘", `${dark} → ${light}`);
  await page.locator(".top-actions .btn-icon").click();
  await page.waitForTimeout(300);
}

/* ── 2. 点引脚 → 配 EXTI → 生成代码 ───────────────────────────── */
{
  await page.goto(`${BASE}/?demo=1&dev=CH32L103K8U6&pin=PB3`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  const exti = page.locator(".pin-menu-item").filter({ hasText: /^EXTI/ }).first();
  check((await exti.count()) > 0, "深链 pin=PB3 能定位到该引脚菜单");
  if (await exti.count()) await exti.click();
  await page.waitForTimeout(400);

  const on = await page.locator(".tree-item.enabled .tree-label").allInnerTexts();
  check(on.includes("EXTI"), "选中 EXTI 后外设被启用", on.join(","));

  await page.locator(".topnav button", { hasText: "生成代码" }).click();
  await page.waitForTimeout(500);
  await page.locator(".file-tabs button", { hasText: "rfr_init.c" }).first().click();
  await page.waitForTimeout(400);
  const code = await page.locator(".code-panel").first().innerText();
  check(code.includes("GPIO_EXTILineConfig(GPIO_PortSourceGPIOB, GPIO_PinSource3)"), "生成 EXTI 线映射");
  check(code.includes("exti.EXTI_Line = EXTI_Line3;"), "生成 EXTI_Line3");
}

/* ── 3. 器件选择器（FinderSkin 弹窗 / chip / 表格） ────────────── */
{
  await page.goto(`${BASE}/?picker=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check((await page.locator(".modal-dialog.device-modal").count()) === 1, "器件选择器使用 .modal-dialog");

  // 点背景不关闭（误触不能丢筛选态），Esc 才是快捷关闭
  await page.mouse.click(8, 8);
  await page.waitForTimeout(250);
  check((await page.locator(".modal-dialog.device-modal").count()) === 1, "点背景不关闭弹窗");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check((await page.locator(".modal-dialog.device-modal").count()) === 0, "Esc 关闭弹窗");
  await page.goto(`${BASE}/?picker=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const modalH = async () => Math.round((await page.locator(".device-modal").boundingBox()).height);
  await page.locator(".series-item", { hasText: "全部系列" }).click();
  await page.waitForTimeout(200);
  const hAll = await modalH();
  await page.locator(".series-item", { hasText: "CH32X035" }).first().click();
  await page.waitForTimeout(200);
  const hSeries = await modalH();
  check(hAll === hSeries, "切换「全部系列 / 某系列」时模态框高度固定", `${hAll} / ${hSeries}`);

  // 主频区间
  await page.locator(".df-freq input").first().fill("96");
  await page.waitForTimeout(350);
  check((await page.locator(".df-count").innerText()).includes("19 / 27"), "主频 ≥96 MHz 过滤出 19 个型号");
  await page.locator(".df-freq input").first().fill("");
  await page.waitForTimeout(250);

  // USB 进阶
  await page.locator(".df-line").filter({ hasText: "外设" }).locator(".df-chip").first().click();
  await page.waitForTimeout(250);
  check((await page.locator(".df-usb").count()) === 1, "勾选 USB 后展开进阶筛选");
  await page.locator(".df-chip", { hasText: /^USB HS$/ }).click();
  await page.locator(".df-usb-role").selectOption("dualrole");
  await page.waitForTimeout(350);
  check((await page.locator(".df-count").innerText()).includes("8 / 27"), "USB HS + DualRole 过滤出 8 个型号");
  await page.getByRole("button", { name: "清空筛选" }).click();
  await page.waitForTimeout(300);
  check((await page.locator(".df-usb").count()) === 0, "清空筛选会收起 USB 进阶");

  await page.locator(".series-item", { hasText: "CH32X035" }).first().click();
  await page.locator(".part-row", { hasText: "CH32X035C8T6" }).click();
  await page.waitForTimeout(250);
  check((await page.locator(".df-chip.chip").count()) > 0, "筛选 chip 使用 FinderSkin .chip");
  check((await page.locator(".res-table tr").count()) >= 15, "右侧资源表有内容");
  await page.locator(".modal-footer .btn-primary").click();
  await page.waitForTimeout(500);
  check((await page.locator(".device-readout .dv-id").innerText()) === "CH32X035C8T6", "按确定后才切换器件");
}

/* ── 4. 参数面板 / 页签 / 引脚表 ──────────────────────────────── */
{
  await page.goto(`${BASE}/?dev=CH32L103K8U6&sel=SPI1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  check((await page.locator(".field-row select").first().inputValue()) === "disable", "使能前模式是 Disable");
  await page.locator(".cfg-head .switch").click();
  await page.waitForTimeout(400);
  check((await page.locator(".field-row select").first().inputValue()) === "master", "使能后模式自动落到 master");

  await page.locator(".cfg-tabs button", { hasText: "引脚" }).click();
  await page.waitForTimeout(250);
  // 引脚表是只读的：数「已落引脚」的行
  const vals = await page.$$eval(".pin-table .pin-cell", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check(vals.filter((t) => t && !t.startsWith("—")).length === 3, "SCK/MOSI/MISO 自动分配了 3 个引脚", vals.join(","));
}

/* ── 4a. 引脚图显示模式：←/→ 循环，LQFP 按边分段 ─────────────── */
{
  await page.goto(`${BASE}/?demo=1&dev=CH32L103K8U6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const name = () => page.locator(".layout-name").innerText();
  check((await name()).includes("完整布局"), "默认是完整布局", await name());
  await page.locator(".layout-nav button", { hasText: "→" }).click();
  await page.waitForTimeout(200);
  check((await name()).includes("左列"), "→ 进入左列（一条边一段）", await name());
  await page.locator(".layout-nav button", { hasText: "→" }).click();
  await page.waitForTimeout(200);
  check((await name()).includes("下排"), "再 → 进入下排", await name());
  await page.locator(".layout-nav button", { hasText: "←" }).click();
  await page.waitForTimeout(200);
  check((await name()).includes("左列"), "← 退回左列", await name());
}

/* ── 4c. 窗口标题跟随工程名 / 复位引脚标记 / 一键设定频率 ─────── */
{
  // C8T6（LQFP48）带 NRST；K8U6 这类 32 脚封装没有复位脚，工程设置会显示 —
  await page.goto(`${BASE}/?demo=1&dev=CH32L103C8T6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const title = await page.title();
  check(title.startsWith("RiskFiveRuler - "), "窗口标题 = RiskFiveRuler - 工程名", title);

  // 工程设置里改工程名 → 标题跟着变
  await page.locator(".topnav .nav-link", { hasText: "工程设置" }).click();
  await page.waitForTimeout(250);
  const nameInput = page.locator(".project-panel .prow input").first();
  await nameInput.fill("测试工程A");
  await page.waitForTimeout(400);
  check((await page.title()).endsWith("- 测试工程A"), "改工程名后窗口标题跟随", await page.title());
  const kv = await page.locator(".project-panel .kv").innerText();
  check(kv.includes("复位引脚") && kv.includes("NRST"), "工程设置显示复位引脚（自动标记）");

  // 一键设定目标频率：96 MHz → 自动选源与倍频，SYSCLK 落到 96
  await page.locator(".topnav .nav-link", { hasText: "时钟树" }).click();
  await page.waitForTimeout(250);
  await page.locator(".clock-target .ct-input").fill("96");
  await page.locator(".clock-target .ct-apply").click();
  await page.waitForTimeout(300);
  const sysclk = await page.locator(".clock-node.sys .cn-head span").first().innerText();
  check(sysclk.startsWith("96"), "一键设定后 SYSCLK = 96 MHz", sysclk);

  // 目标频率板块：标题 / 输入框 / 按钮 垂直中心对齐（同一行）
  const tops = await page.evaluate(() =>
    [
      document.querySelector(".clock-target > b"),
      document.querySelector(".clock-target .ct-input"),
      document.querySelector(".clock-target .ct-apply"),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }),
  );
  check(tops.every((t) => Math.abs(t - tops[0]) <= 2), "一键设定板块控件同一行", tops.join(","));

  // 教学说明只在注释模式（新手模式）下显示
  check((await page.locator(".ct-note").innerText().catch(() => "")).includes("时钟源"), "注释模式下显示频率说明");
  await page.locator(".menubar-item", { hasText: "设置" }).click();
  await page.waitForTimeout(400);
  await page.locator(".pref-row", { hasText: "新手模式" }).locator("input").uncheck();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check((await page.locator(".ct-note").count()) === 0, "注释模式关闭后频率说明隐藏");
}

/* ── 4b. 重映射组 select + 锁定本组映射 ───────────────────────── */
{
  await page.goto(`${BASE}/?dev=CH32L103K8U6&sel=I2C1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator(".cfg-head .switch").click();
  await page.waitForTimeout(400);
  await page.locator(".cfg-tabs button", { hasText: "引脚" }).click();
  await page.waitForTimeout(250);
  const sel = page.locator(".remap-bar select");
  check((await sel.count()) === 1, "WCH 外设用单个 select 选重映射组");
  const opts = await sel.locator("option").allInnerTexts();
  check(opts.some((t) => t.includes("默认功能")), "重映射组下拉含默认功能", opts.join("|"));
  const lock = page.locator(".remap-bar input[type=checkbox]");
  await lock.check();
  await page.waitForTimeout(200);
  check(await lock.isChecked(), "锁定本组映射勾选生效");
  // 锁定后引脚分配不丢（后续外设启用不会挤动它）；复用值列显示当前组 00
  const vals = await page.$$eval(".pin-table .pin-cell", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check(vals.filter((t) => t && !t.startsWith("—")).length === 2, "锁定后 I2C1 的 SCL/SDA 保持已分配", vals.join(","));
  const remaps = await page.$$eval(".pin-table .remap-cell", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check(remaps.includes("00"), "引脚表显示当前复用值（00）", remaps.join(","));
}

/* ── 4d. SPI 半双工主机：MISO 不再误报；硬件 NSS 自动落脚 / 组内冲突回退 ── */
{
  // 成功路径：无占用时 NSS 落到第一个候选 PA4
  await page.goto(`${BASE}/?dev=CH32L103K8U6&sel=SPI1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator(".cfg-head .switch").click();
  await page.waitForTimeout(300);
  const modeSel = page.locator(".field-row select").filter({ has: page.locator("option", { hasText: "半双工主机" }) });
  await modeSel.selectOption("half_master");
  await page.waitForTimeout(300);
  await page.locator(".cfg-tabs button", { hasText: "引脚" }).click();
  await page.waitForTimeout(250);
  const notes = await page.locator(".block-note").allInnerTexts();
  check(!notes.some((t) => t.includes("MISO")), "半双工主机不再误报 MISO 未分配", notes.join("|").slice(0, 120));
  await page.locator(".cfg-tabs button", { hasText: "参数" }).click();
  await page.waitForTimeout(250);
  const nssSel = page.locator(".field-row select").filter({ has: page.locator("option", { hasText: "硬件 NSS 输出" }) });
  await nssSel.selectOption("hardware_out");
  await page.waitForTimeout(300);
  await page.locator(".cfg-tabs button", { hasText: "引脚" }).click();
  await page.waitForTimeout(250);
  const nssRow = await page.locator(".pin-table tr", { hasText: "NSS" }).innerText();
  check(nssRow.includes("PA4"), "硬件 NSS 立即自动配置（第一个候选 PA4）", nssRow.replace(/\s+/g, " "));

  // 冲突路径：组内唯一的 NSS 候选 PA4 被 EXTI_LINE4 占 → 改回软件 NSS + toast
  await page.locator(".tree-item", { hasText: "EXTI" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".cfg-head .switch").click();
  await page.waitForTimeout(300);
  await page.locator(".cfg-tabs button", { hasText: "中断线" }).click();
  await page.waitForTimeout(250);
  const card = page.locator(".chan-card", { hasText: "LINE4" }).first();
  await card.locator("input[type=checkbox]").first().check();
  await page.waitForTimeout(150);
  await card.locator(".chan-body select").last().selectOption("PA4");
  await page.waitForTimeout(200);
  await page.locator(".tree-item", { hasText: "SPI1" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".cfg-tabs button", { hasText: "参数" }).click();
  await page.waitForTimeout(250);
  await nssSel.selectOption("software");
  await page.waitForTimeout(250);
  await nssSel.selectOption("hardware_out");
  await page.waitForTimeout(500);
  check((await nssSel.inputValue()) === "software", "NSS 组内候选全被占 → 自动改回软件 NSS");
  const toast = await page.locator(".toast-text").innerText().catch(() => "");
  check(toast.includes("NSS") && toast.includes("冲突"), "冲突提示 toast 出现", toast);
}

/* ── 5. 分层模块可直接调用（不经过 core 兼容层） ─────────────── */

/* ── 5. 分层模块可直接调用（不经过 core 兼容层） ─────────────── */
{
  const ok = await page.evaluate(async () => {
    const dev = await import("/src/devices/index.ts");
    const project = await import("/src/app/project.ts");
    const codegen = await import("/src/backends/index.ts");
    const schemas = await import("/src/semantic/schemas.ts");
    const d = dev.DEVICE_MAP["CH32L103K8U6"];
    const p = project.createDemoProject(d);
    const files = codegen.generate(p, d);
    return {
      devices: dev.DEVICES.length,
      files: files.length,
      init: files.some((f) => f.path.includes("rfr_init.c")),
      schema: !!schemas.schemaFor("USART"),
    };
  });
  check(ok.devices >= 6, "devices/ 注册表可独立加载", `${ok.devices} 个器件`);
  check(ok.files > 5 && ok.init, "backends/ 可独立生成代码", `${ok.files} 个文件`);
  check(ok.schema, "semantic/ 可独立取参数模式");
}

/* ── 6. X033 USART3 数据完整性：PC18=TX / PC19=RX（AFIO 组 1） ── */
{
  await page.goto(`${BASE}/?dev=CH32X033F8P6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const tree = await page.locator(".tree-item .tree-label").allInnerTexts();
  check(tree.includes("USART3"), "X033 外设树里有 USART3");
  const hidden = (await page.locator(".tree-hidden").allInnerTexts()).join(" ");
  check(!hidden.includes("USART3"), "USART3 不再被误报为「器件数据待补」", hidden.slice(0, 60));

  await page.goto(`${BASE}/?dev=CH32X033F8P6&pin=PC19`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const fns = await page.locator(".pin-menu-item .fn").allInnerTexts();
  check(fns.includes("USART3_RX"), "PC19 的引脚菜单里有 USART3_RX（复用组 1）");
}

/* ── 6b. K8U7 无 CAN1、K8U6 有（同一引脚数，硬件阉割用 packages[].drop 表达） ── */
{
  await page.goto(`${BASE}/?dev=CH32L103K8U7`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const tree7 = await page.locator(".tree-item .tree-label").allInnerTexts();
  check(!tree7.includes("CAN1"), "K8U7 外设树里没有 CAN1");
  await page.goto(`${BASE}/?dev=CH32L103K8U6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const tree6 = await page.locator(".tree-item .tree-label").allInnerTexts();
  check(tree6.includes("CAN1"), "K8U6 外设树里有 CAN1");
}

/* ── 7. TIM1/CMP1/OPA1 可以零引脚启用；PIOC 有 IO0+IO1 且归通信 ── */
{
  for (const id of ["TIM1", "CMP1", "OPA1"]) {
    await page.goto(`${BASE}/?dev=CH32X033F8P6&sel=${id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const sw = page.locator(".cfg-head .switch input").first();
    check(!(await sw.isDisabled()), `${id} 未启用时开关可用`);
    check((await page.locator(".block-note.alert-warning").count()) === 0, `${id} 不再误报「需要挪脚」`);
  }

  await page.goto(`${BASE}/?dev=CH32X033F8P6&sel=PIOC`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const groupTitle = await page.locator(".tree-group").evaluateAll((groups) => {
    const g = groups.find((x) =>
      [...x.querySelectorAll(".tree-label")].some((l) => l.textContent?.trim() === "PIOC"),
    );
    return g?.querySelector(".tree-group-title")?.textContent?.trim() ?? "";
  });
  check(groupTitle.includes("通信"), "PIOC 归到「通信」分组", groupTitle);

  await page.locator(".cfg-head .switch").click();
  await page.waitForTimeout(300);
  await page.locator(".cfg-tabs button", { hasText: "引脚" }).click();
  await page.waitForTimeout(250);
  const names = await page.$$eval(".pin-table .sig-name", (els) => els.map((e) => e.textContent?.trim()));
  const vals = await page.$$eval(".pin-table .pin-cell", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check(names.includes("IO0") && names.includes("IO1"), "PIOC 同时有 IO0 和 IO1", names.join(","));
  check(vals.every((v) => v.startsWith("—")), "启用 PIOC 不会自动占用 IO1", vals.join(","));
}

/* ── 7b. 定时器分类：X035 = TIM1/TIM2 高级、TIM3 通用 ── */
{
  await page.goto(`${BASE}/?dev=CH32X035C8T6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const tim1 = await page.locator(".tree-item", { hasText: "TIM1" }).innerText();
  const tim2 = await page.locator(".tree-item", { hasText: "TIM2" }).innerText();
  const tim3 = await page.locator(".tree-item", { hasText: "TIM3" }).innerText();
  check(tim1.includes("高级") && tim2.includes("高级"), "TIM1 / TIM2 标记为高级定时器", `${tim1} | ${tim2}`);
  check(tim3.includes("通用"), "TIM3 标记为通用定时器", tim3);
  await page.goto(`${BASE}/?dev=CH32X035C8T6&sel=TIM1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const brief = await page.locator(".cfg-title p").innerText();
  check(brief.includes("高级定时器"), "定时器页头简介区分高级/通用", brief);
}

/* ── 8. V407WEU6 双 USBHS（DS0 表 2-3-15：USBHS1_DM=PA11） ── */
{
  await page.goto(`${BASE}/?dev=CH32V407WEU6`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const tree = await page.locator(".tree-item .tree-label").allInnerTexts();
  check(tree.includes("USBHS1") && tree.includes("USBHS2"), "WEU6 的 USBHS1 / USBHS2 都在外设树里");
  const hidden = (await page.locator(".tree-hidden").allInnerTexts()).join(" ");
  check(!hidden.includes("USBHS1"), "USBHS1 不再被误报为「器件数据待补」");

  await page.goto(`${BASE}/?dev=CH32V407WEU6&pin=PA11`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const fns = await page.locator(".pin-menu-item .fn").allInnerTexts();
  check(fns.includes("USBHS1_DM"), "PA11 的引脚菜单里有 USBHS1_DM");
}

/* ── 9. 设置弹窗：主题色派生 / 图例配色覆盖 ── */
{
  await page.goto(`${BASE}/?demo=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.locator(".menubar-item", { hasText: "设置" }).click();
  await page.waitForTimeout(500);
  check((await page.locator(".settings-modal").count()) === 1, "「设置」打开设置弹窗");

  // React 受控 color input：必须用原生 setter 触发
  const setColor = (sel, value) =>
    page.locator(sel).first().evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);

  await setColor('.theme-picker input[type="color"]', "#e5484d");
  await page.waitForTimeout(400);
  check(
    (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-theme").trim())) === "#e5484d",
    "主题颜色派生 --app-theme / --fs-primary",
  );
  await setColor('.pin-color-row input[type="color"]', "#ff00ff");
  await page.waitForTimeout(400);
  check(
    (await page.evaluate(async () => (await import("/src/semantic/pinmux.ts")).colorOf("USART"))) === "#ff00ff",
    "图例配色覆盖 colorOf(USART)",
  );
}

check(errors.length === 0, "整个过程没有页面异常", errors.slice(0, 2).join("; "));

await browser.close();
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
