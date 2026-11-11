/**
 * 引脚图主组件：画布、视图状态（缩放/平移/旋转/滚动）、工具条、图例、弹出菜单。
 *
 * 绘制细节拆在同目录 pinout/：
 *   constants.ts     共享常量 / 信号释义
 *   drawPin.ts       单个引脚矩形（文字不随视图旋转颠倒）
 *   listLayout.ts    单边列表布局
 *   layoutOptions.ts 显示模式分段（一条边一段）
 *   PinMenu.tsx      引脚弹出菜单
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceDef, PinDef, Project } from "../model/types";
import { collectUsage, colorOf, findConflicts, gpioColorOf, GPIO_MODE_LABELS } from "../semantic/pinmux";
import { drawGrid, drawPin, roundRect } from "./pinout/drawPin";
import { drawListBox, listGeometry } from "./pinout/listLayout";
import { layoutSegments, rangeLabel } from "./pinout/layoutOptions";
import { PinMenu } from "./pinout/PinMenu";
import type { Hit, LegendRow } from "./pinout/constants";
import { CORNER_MAX, CORNER_MIN, PIN_GAP, PIN_LEN, PIN_NAME_INSET, PIN_TEXT_FONT, PIN_TEXT_PAD, PIN_THICK } from "./pinout/constants";

interface Props {
  dev: DeviceDef;
  project: Project;
  search: string;
  onAssign: (pin: string, fn: string | null) => void;
  onGpioMode: (pin: string, mode: string) => void;
  onSelectPeripheral: (id: string) => void;
  /** 画布右键菜单里的锁定 / 解锁（宿主改 project.lockedPins） */
  onTogglePinLock: (pin: string) => void;
  /** 画布右键菜单「设置自定义名称」→ 跳转 GPIO 表格面板 */
  onEditPinName: (pin: string) => void;
  /** 深链 ?pin=PB6 用：直接把这颗引脚的菜单弹出来（截图回归 / 演示） */
  autoPin?: string | null;
}

export function PinoutView({ dev, project, search, onAssign, onGpioMode, onSelectPeripheral, onTogglePinLock, onEditPinName, autoPin }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<Hit[]>([]);
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0, rot: 0 });
  /**
   * 上一次自动适配算出的缩放。
   *
   * 「复位」要同步拿到这个值 —— 以前它只是把 fitRef 清空、等下一次 draw 重新算，
   * 而那次重算会**覆盖**用户在重算之前做的缩放：点复位后立刻点「－」，
   * 缩放先被改成 fit，看起来就是「点减号反而放大，再点一次才缩小」。
   */
  const lastFitRef = useRef(1);
  const fitRef = useRef<string>("");
  const [menu, setMenu] = useState<{ pin: PinDef; x: number; y: number } | null>(null);
  const [tick, setTick] = useState(0);
  /**
   * 显示模式：`"full"`（整个封装）或 `side:<边>`（只看一条边，竖列表）。
   * 用 ←/→ 在模式序列上循环切换，比 select 快。
   */
  const [layout, setLayout] = useState<string>("full");
  /** 列表模式的滚动偏移（内容坐标，向上为正）。完整布局不用。 */
  const scrollRef = useRef(0);

  /**
   * 列表模式的行距档位（＋/－ 按钮切换）。
   *
   * 列表会自适应铺满可视高度，所以 ＋/－ 不再是放大缩小，而是「密度」：
   * 行距变大 → 一屏放得下的引脚变少；放不下时自动出现上下滚动。
   */
  const DENSITY_STEPS = [0.75, 1, 1.4, 2, 2.8];
  const [densityIdx, setDensityIdx] = useState(1);
  const density = DENSITY_STEPS[Math.min(Math.max(densityIdx, 0), DENSITY_STEPS.length - 1)] ?? 1;

  /** 显示模式分段：完整布局 + 每条边一段（沿用完整布局「数组四等分 = 左/下/右/上」的切分） */
  const segs = useMemo(() => layoutSegments(dev), [dev]);
  const modes = useMemo(
    () => [
      { key: "full", label: `完整布局（${dev.package.pins.length} 脚）` },
      ...segs.map((s) => ({ key: s.key, label: `${s.label}（引脚 ${rangeLabel(s.pins)}）` })),
    ],
    [dev, segs],
  );
  const modeIdx = Math.max(0, modes.findIndex((m) => m.key === layout));

  /** 切模式：换布局等于换了一张图 —— 滚动归零、旋转归零、重新适配 */
  const stepLayout = (dir: 1 | -1) => {
    const next = modes[(modeIdx + dir + modes.length) % modes.length]!;
    setLayout(next.key);
    scrollRef.current = 0;
    viewRef.current = { ...viewRef.current, rot: 0, tx: 0, ty: 0 };
    fitRef.current = "";
    setTick((t) => t + 1);
  };

  // 换器件：回到完整布局
  useEffect(() => {
    setLayout("full");
    scrollRef.current = 0;
    fitRef.current = "";
  }, [dev.id]);

  /** 当前布局要显示的引脚（完整布局 = 全部） */
  const listSeg = useMemo(() => (layout === "full" ? null : (segs.find((s) => s.key === layout) ?? null)), [layout, segs]);
  const listPins = listSeg?.pins ?? null;

  const usage = useMemo(() => collectUsage(project, dev), [project, dev]);
  const conflicts = useMemo(() => findConflicts(usage), [usage]);

  /** 锁定映射的外设占用的引脚 —— 画布上给这些矩形加「图钉」样式 */
  const periphLockedPins = useMemo(() => {
    const s = new Set<string>();
    for (const cfg of Object.values(project.configs)) {
      if (!cfg?.locked || !cfg.enabled) continue;
      for (const p of Object.values(cfg.pins ?? {})) if (p) s.add(p);
      for (const ch of Object.values(cfg.channels ?? {})) {
        if (ch.pin) s.add(ch.pin);
        if (ch.pinN) s.add(ch.pinN);
      }
    }
    return s;
  }, [project.configs]);
  /** 用户右键锁定的引脚 —— 同样画图钉，且不能被配置 */
  const pinLockedPins = useMemo(
    () => new Set(Object.keys(project.lockedPins ?? {})),
    [project.lockedPins],
  );
  const conflictPins = useMemo(() => new Set(conflicts.map((c) => c.pin)), [conflicts]);
  const usageByPin = useMemo(() => {
    const m = new Map<string, (typeof usage)[number]>();
    for (const u of usage) m.set(u.pin, u);
    return m;
  }, [usage]);

  /** 没有被外设占用、但被用户配成了普通 GPIO 的引脚 */
  const gpioByPin = useMemo(() => {
    const m = new Map<string, string>();
    for (const [pin, g] of Object.entries(project.gpio)) {
      const c = gpioColorOf(g?.mode);
      if (c && !usageByPin.has(pin)) m.set(pin, c);
    }
    return m;
  }, [project.gpio, usageByPin]);

  /** 右下角图例：外设实例 + 用到的 GPIO 模式 */
  const legend = useMemo<LegendRow[]>(() => {
    const byOwner = new Map<string, string>();
    for (const u of usage) byOwner.set(u.owner, u.colorKey);
    const rows: LegendRow[] = [...byOwner.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([owner, kind]) => ({ key: owner, name: owner, color: colorOf(kind), owner }));
    const gpioModes = new Set<string>();
    for (const p of dev.package.pins) {
      if (usageByPin.has(p.name)) continue;
      const m = project.gpio[p.name]?.mode;
      if (m && m !== "analog") gpioModes.add(m);
    }
    for (const m of gpioModes) {
      rows.push({ key: `gpio:${m}`, name: GPIO_MODE_LABELS[m] ?? m, color: gpioColorOf(m) ?? "#888", owner: null });
    }
    return rows;
  }, [usage, usageByPin, project.gpio, dev]);

  const matchPins = useMemo(() => {
    const kw = search.trim().toUpperCase();
    if (!kw) return new Set<string>();
    const set = new Set<string>();
    for (const p of dev.package.pins) {
      if (p.name.includes(kw)) set.add(p.name);
      if ((p.signals ?? []).some((s) => s.fn.toUpperCase().includes(kw))) set.add(p.name);
    }
    return set;
  }, [search, dev]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const style = getComputedStyle(document.documentElement);
    const cBody = style.getPropertyValue("--pin-body").trim() || "#1b2433";
    const cBodyEdge = style.getPropertyValue("--pin-body-edge").trim() || "#3a4a63";
    const cText = style.getPropertyValue("--pin-text").trim() || "#c8d4e6";
    const cDim = style.getPropertyValue("--pin-dim").trim() || "#5d6b82";
    const cBg = style.getPropertyValue("--pin-bg").trim() || "#0d1117";
    const cAccent = style.getPropertyValue("--accent").trim() || "#3ecfb2";

    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H, style.getPropertyValue("--pin-grid").trim() || "#161c26");

    const v = viewRef.current;
    const cPins = {
      unused: style.getPropertyValue("--pin-unused").trim() || "#232c3a",
      power: style.getPropertyValue("--pin-power").trim() || "#39424f",
      reset: style.getPropertyValue("--pin-reset").trim() || "#4a3a3a",
      edge: style.getPropertyValue("--pin-body-edge").trim() || "#0c1119",
    };

    /* ── 列表布局：引脚只排左侧，自适应铺满高度，放不下自动滚动 ── */
    if (listPins && listSeg) {
      const g = listGeometry({ ctx, pins: listPins, usageByPin, pinLabels: project.pinLabels, density });
      const fitKey = `list|${dev.id}|${listPins.length}|${W}x${H}|${density}`;
      if (fitRef.current !== fitKey) {
        /*
         * 自适应：内容不满一屏时放大到**正好铺满可视高度**（用户反馈：
         * 切到单侧列表后引脚太小、点四次放大才勉强合适）；
         * 密度调大后内容超出一屏时回落到 1:1，交给滚轮上下滑。
         */
        const fit = g.contentH < H ? H / g.contentH : 1;
        viewRef.current.scale = Math.min(3, Math.max(0.5, fit));
        lastFitRef.current = viewRef.current.scale;
        scrollRef.current = 0;
        viewRef.current.tx = 0;
        viewRef.current.ty = 0;
        viewRef.current.rot = 0;
        fitRef.current = fitKey;
      }
      const visible = H / v.scale;
      const maxScroll = Math.max(0, g.contentH - visible);
      const scroll = Math.max(0, Math.min(maxScroll, scrollRef.current));
      scrollRef.current = scroll;

      hitsRef.current = drawListBox({
        ctx,
        W,
        H,
        pins: listPins,
        scale: v.scale,
        scroll,
        density,
        title: `${dev.id} · ${dev.package.label} · ${listSeg.label}（引脚 ${rangeLabel(listPins)}，共 ${listPins.length} 脚）`,
        usageByPin,
        gpioByPin,
        pinLabels: project.pinLabels,
        conflictPins,
        matchPins,
        cText,
        cDim,
        cAccent,
        cPins,
        cEdgeSoft: style.getPropertyValue("--border-soft").trim() || "#28313f",
      });
      return;
    }

    const cx = W / 2;
    const cy = H / 2;
    ctx.save();
    ctx.translate(cx + v.tx, cy + v.ty);
    ctx.rotate((v.rot * Math.PI) / 180);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-cx, -cy);

    const pins = dev.package.pins;
    const n = pins.length;
    const shape = dev.package.shape;
    const perSide = shape === "dual" ? Math.ceil(n / 2) : Math.ceil(n / 4);

    // 器件本体尺寸：每边引脚数决定跨度，四角再留出标签需要的空白
    const pitch = 26;
    const maxName = pins.reduce((m, p) => Math.max(m, p.name.length), 6);
    const corner =
      shape === "dual"
        ? 0
        : Math.max(CORNER_MIN, Math.min(CORNER_MAX, Math.round(maxName * 6.2 + 10)));
    const span = Math.max(pitch * Math.max(perSide - 1, 0), 110);
    const bodyW = shape === "dual" ? 176 : span + 2 * corner;
    const bodyH = shape === "dual" ? perSide * pitch + 30 : span + 2 * corner;

    /*
     * 已配置的引脚要在色块里写信号名（USB1_DP 比 26px 的引脚块宽得多），
     * 所以色块长度按文字实测宽度撑开 —— 宁可矩形长短不一，也不能把字截掉。
     */
    ctx.font = PIN_TEXT_FONT;
    let widestChip = PIN_LEN;
    for (const pin of pins) {
      const u = usageByPin.get(pin.name);
      if (!u) continue;
      const w = ctx.measureText(u.fn).width + PIN_TEXT_PAD * 2;
      if (w > widestChip) widestChip = w;
    }
    ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";

    // 自动适配：器件变化或画布尺寸变化时重新算一次缩放，让封装图占满可视区
    const fitKey = `${dev.id}|${W}x${H}`;
    if (fitRef.current !== fitKey) {
      const grow = widestChip - PIN_LEN;
      const needW = bodyW + 2 * (PIN_LEN + PIN_GAP + 54 + grow);
      const needH = bodyH + 2 * (PIN_LEN + PIN_GAP + 22 + grow);
      const fit = Math.min(W / needW, H / needH) * 0.94;
      lastFitRef.current = Math.min(2.2, Math.max(0.5, fit));
      viewRef.current.scale = lastFitRef.current;
      viewRef.current.tx = 0;
      viewRef.current.ty = 0;
      fitRef.current = fitKey;
    }

    const bx = cx - bodyW / 2;
    const by = cy - bodyH / 2;

    // 本体
    ctx.fillStyle = cBody;
    roundRect(ctx, bx, by, bodyW, bodyH, 6);
    ctx.fill();
    ctx.strokeStyle = cBodyEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 丝印：器件名 + 封装 + 一脚标记（文字反向补偿视图旋转，保持可读）
    ctx.fillStyle = cDim;
    for (const [txt, ty, font] of [
      [dev.id, cy - 8, "600 11px 'Segoe UI', system-ui, sans-serif"],
      [`${dev.package.label} · ${dev.core.split("·")[0]!.trim()}`, cy + 8, "9px 'Cascadia Mono', Consolas, monospace"],
    ] as const) {
      ctx.save();
      ctx.translate(cx, ty);
      if (v.rot) ctx.rotate((-v.rot * Math.PI) / 180);
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(bx + 12, by + 12, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = cDim;
    ctx.fill();

    const hits: Hit[] = [];
    const nSide = shape === "dual" ? Math.ceil(n / 2) : perSide;

    const place = (
      side: "left" | "right" | "top" | "bottom",
      index: number,
      total: number,
      pin: PinDef,
    ) => {
      // 四边封装：引脚从四角留白之后开始排（corner 起步），避免角上撞标签
      const quad = shape !== "dual";
      const used = usageByPin.get(pin.name);
      let chip = PIN_LEN;
      if (used) {
        ctx.font = PIN_TEXT_FONT;
        chip = Math.max(PIN_LEN, ctx.measureText(used.fn).width + PIN_TEXT_PAD * 2);
      }
      const stepQ = (bodyW - 2 * corner) / Math.max(total - 1, 1);
      const stepD = (side === "left" || side === "right" ? bodyH : bodyW) / (total + 1);
      const off = corner + index * stepQ;
      let x = 0;
      let y = 0;
      let w = 0;
      let h = 0;
      if (side === "left") {
        y = (quad ? by + off : by + stepD * (index + 1) - PIN_THICK / 2);
        x = bx - PIN_GAP - chip;
        w = chip;
        h = PIN_THICK;
      } else if (side === "right") {
        y = quad ? by + bodyH - off - PIN_THICK / 2 : by + bodyH - stepD * (index + 1) - PIN_THICK / 2;
        x = bx + bodyW + PIN_GAP;
        w = chip;
        h = PIN_THICK;
      } else if (side === "top") {
        x = quad ? bx + bodyW - off - PIN_THICK / 2 : bx + bodyW - stepD * (index + 1) - PIN_THICK / 2;
        y = by - PIN_GAP - chip;
        w = PIN_THICK;
        h = chip;
      } else {
        x = quad ? bx + off - PIN_THICK / 2 : bx + stepD * (index + 1) - PIN_THICK / 2;
        y = by + bodyH + PIN_GAP;
        w = PIN_THICK;
        h = chip;
      }
      hits.push({ pin, x, y, w, h, side });
      drawPin(ctx, pin, x, y, w, h, side, {
        used: usageByPin.get(pin.name),
        label: project.pinLabels[pin.name],
        gpioColor: gpioByPin.get(pin.name),
        conflict: conflictPins.has(pin.name),
        match: matchPins.has(pin.name),
        locked: pinLockedPins.has(pin.name),
        underline: periphLockedPins.has(pin.name),
        cText,
        cDim,
        cAccent,
        pitch: quad ? stepQ : stepD,
        cPins,
        viewRot: v.rot,
        // 完整布局有本体边框：水平名字整体内缩，别压在圆角描边上
        nameGap: PIN_GAP + PIN_NAME_INSET,
        // 上下两排的斜排名字也要收进本体内侧
        body: { x: bx, y: by, w: bodyW, h: bodyH },
      });
    };

    if (shape === "dual") {
      for (let i = 0; i < nSide; i++) {
        const p = pins[i];
        if (p) place("left", i, nSide, p);
      }
      for (let i = 0; i < nSide; i++) {
        const p = pins[nSide + i];
        if (p) place("right", i, nSide, p);
      }
    } else {
      for (let i = 0; i < nSide; i++) {
        const p = pins[i];
        if (p) place("left", i, nSide, p);
      }
      for (let i = 0; i < nSide; i++) {
        const p = pins[nSide + i];
        if (p) place("bottom", i, nSide, p);
      }
      for (let i = 0; i < nSide; i++) {
        const p = pins[nSide * 2 + i];
        if (p) place("right", i, nSide, p);
      }
      for (let i = 0; i < nSide; i++) {
        const p = pins[nSide * 3 + i];
        if (p) place("top", i, nSide, p);
      }
    }

    ctx.restore();
    hitsRef.current = hits;
  }, [dev, usageByPin, gpioByPin, conflictPins, matchPins, periphLockedPins, pinLockedPins, listPins, listSeg, density, project.pinLabels]);

  useEffect(() => {
    draw();
  }, [draw, tick]);

  /**
   * 主题切换后立即重绘。
   *
   * `draw` 每次都从 getComputedStyle 读颜色，但它不知道「主题变了」——
   * 之前要等用户滚一下滚轮（触发 tick）才刷新，看起来就是「换个肤色没反应」。
   * 监听 <html data-theme> 的属性变化比把 theme 传下来更稳：
   * 主题也可能被别的入口改（系统偏好、调试面板），都能收到。
   */
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => draw());
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-fs-mode", "class", "style"] });
    return () => mo.disconnect();
  }, [draw]);

  useEffect(() => {
    if (!autoPin) return;
    const p = dev.package.pins.find((x) => x.name === autoPin);
    if (!p) return;
    setMenu({ pin: p, x: Math.round(window.innerWidth * 0.46), y: Math.round(window.innerHeight * 0.34) });
  }, [autoPin, dev]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [draw]);

  const toCanvasPoint = (ev: React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const hitTest = (px: number, py: number): PinDef | null => {
    const v = viewRef.current;
    const wrap = wrapRef.current!;
    let x: number;
    let y: number;
    if (listPins) {
      // 列表布局：屏幕 = (内容 × scale, 内容 × scale − scroll)
      x = px / v.scale;
      y = (py + scrollRef.current) / v.scale;
    } else {
      const cx = wrap.clientWidth / 2;
      const cy = wrap.clientHeight / 2;
      // 逆变换：先平移回中心，再反向旋转缩放
      const dx = px - (cx + v.tx);
      const dy = py - (cy + v.ty);
      const rad = (-v.rot * Math.PI) / 180;
      const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
      x = rx / v.scale + cx;
      y = ry / v.scale + cy;
    }
    for (const h of hitsRef.current) {
      if (x >= h.x - 2 && x <= h.x + h.w + 2 && y >= h.y - 2 && y <= h.y + h.h + 2) return h.pin;
    }
    return null;
  };

  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  // mouseup 会把 dragRef 清空，而 click 在那之后才触发，所以用一个独立标记接力
  const suppressClickRef = useRef(false);

  return (
    <div className="pinout">
      <div className="pinout-toolbar">
        <div className="layout-nav" title="显示模式：←/→ 切换（完整布局 ↔ 逐边列表）">
          <button className="btn btn-ghost btn-sm" onClick={() => stepLayout(-1)} title="上一种显示模式">←</button>
          <span className="layout-name">{modes[modeIdx]!.label}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => stepLayout(1)} title="下一种显示模式">→</button>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          disabled={Boolean(listPins)}
          onClick={() => { viewRef.current.rot += 90; setTick((t) => t + 1); }}
          title={listPins ? "列表布局不支持旋转" : "旋转 90°"}
        >
          ⟳
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title={listPins ? "行距增大（密度减小）" : "放大"}
          onClick={() => {
            if (listPins) setDensityIdx((i) => Math.min(DENSITY_STEPS.length - 1, i + 1));
            else viewRef.current.scale = Math.min(2.4, viewRef.current.scale * 1.15);
            setTick((t) => t + 1);
          }}
        >
          ＋
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title={listPins ? "行距减小（密度增大）" : "缩小"}
          onClick={() => {
            if (listPins) setDensityIdx((i) => Math.max(0, i - 1));
            else viewRef.current.scale = Math.max(0.4, viewRef.current.scale / 1.15);
            setTick((t) => t + 1);
          }}
        >
          －
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="回到初始视图（适配窗口大小）"
          onClick={() => {
            const wrap = wrapRef.current;
            setDensityIdx(1); // 列表布局：密度也回到默认档
            viewRef.current = { scale: lastFitRef.current, tx: 0, ty: 0, rot: 0 };
            scrollRef.current = 0; // 列表布局：复位也把滚动带回顶部
            /*
             * 把 fitRef 标成「当前尺寸已适配」，而不是清空。
             * 清空会让下一次 draw 重新算一遍 fit 并覆盖 scale ——
             * 那次覆盖是异步的，会把用户紧接着的「－」吃掉（现象：点减号反而变大）。
             */
            if (wrap) fitRef.current = `${dev.id}|${wrap.clientWidth}x${wrap.clientHeight}`;
            setTick((t) => t + 1);
          }}
        >
          复位
        </button>
        <span className="spacer" />
        <span className="legend">
          <i style={{ background: colorOf("USART") }} />UART
          <i style={{ background: colorOf("SPI") }} />SPI
          <i style={{ background: colorOf("I2C") }} />I2C
          <i style={{ background: colorOf("TIM") }} />TIM
          <i style={{ background: colorOf("ADC") }} />ADC
        </span>
      </div>

      {dev.package.pinNumbering === "sequence" && (
        <p className="pinout-note alert alert-warning">
          引脚号是<strong>按端口顺序的序号</strong>，不是封装的实际引脚号 ——
          手册 4.2 只给了端口与复用的对应关系。画板子前请对照数据手册的引脚定义图。
        </p>
      )}

      <div
        className="pinout-canvas"
        ref={wrapRef}
        onWheel={(e) => {
          e.preventDefault();
          const v = viewRef.current;
          // 列表模式：滚轮 = 上下滚动（内容放不下才滚）；按住 Ctrl 仍是缩放
          if (listPins && !e.ctrlKey) {
            const wrap = wrapRef.current;
            if (!wrap) return;
            const g = listGeometry({ ctx: canvasRef.current!.getContext("2d")!, pins: listPins, usageByPin, pinLabels: project.pinLabels, density });
            const maxScroll = Math.max(0, g.contentH - wrap.clientHeight / v.scale);
            scrollRef.current = Math.max(0, Math.min(maxScroll, scrollRef.current + e.deltaY / v.scale));
            setTick((t) => t + 1);
            return;
          }
          v.scale = Math.min(2.4, Math.max(0.4, v.scale * (e.deltaY < 0 ? 1.08 : 0.93)));
          setTick((t) => t + 1);
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const p = toCanvasPoint(e);
          dragRef.current = { x: p.x, y: p.y, tx: viewRef.current.tx, ty: viewRef.current.ty, moved: false };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current) return;
          const p = toCanvasPoint(e);
          const dx = p.x - dragRef.current.x;
          const dy = p.y - dragRef.current.y;
          if (!dragRef.current.moved && Math.hypot(dx, dy) > 3) dragRef.current.moved = true;
          viewRef.current.tx = dragRef.current.tx + dx;
          viewRef.current.ty = dragRef.current.ty + dy;
          setTick((t) => t + 1);
        }}
        onMouseUp={() => {
          if (dragRef.current?.moved) suppressClickRef.current = true;
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          if (dragRef.current?.moved) suppressClickRef.current = true;
          dragRef.current = null;
        }}
        onClick={(e) => {
          // 拖动画布之后松手也会触发 click，这种情况不弹菜单
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const p = toCanvasPoint(e);
          const pin = hitTest(p.x, p.y);
          if (!pin) {
            setMenu(null);
            return;
          }
          setMenu({ pin, x: e.clientX, y: e.clientY });
        }}
        onContextMenu={(e) => {
          // 右键 = 打开引脚菜单（锁定 / 解锁就在菜单里），固定功能脚也允许看
          e.preventDefault();
          const p = toCanvasPoint(e);
          const pin = hitTest(p.x, p.y);
          if (!pin) {
            setMenu(null);
            return;
          }
          suppressClickRef.current = true; // 右键松手后的 click 不再弹一次
          setMenu({ pin, x: e.clientX, y: e.clientY });
        }}
      >
        <canvas ref={canvasRef} />

        {legend.length > 0 && (
          <div className="canvas-legend" title="当前已配置的引脚配色">
            <div className="cl-title">
              图例 <em>{legend.length}</em>
            </div>
            {legend.map((r) => (
              <button
                key={r.key}
                className="cl-row"
                onClick={() => r.owner && onSelectPeripheral(r.owner)}
                title={r.owner ? `查看 ${r.owner}` : r.name}
              >
                <span>{r.name}</span>
                <i style={{ background: r.color }} />
              </button>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <PinMenu
          pin={menu.pin}
          dev={dev}
          project={project}
          x={menu.x}
          y={menu.y}
          pinLocked={pinLockedPins.has(menu.pin.name)}
          onToggleLock={() => onTogglePinLock(menu.pin.name)}
          onEditName={() => onEditPinName(menu.pin.name)}
          onClose={() => setMenu(null)}
          onAssign={onAssign}
          onGpioMode={onGpioMode}
          onSelectPeripheral={onSelectPeripheral}
        />
      )}
    </div>
  );
}
