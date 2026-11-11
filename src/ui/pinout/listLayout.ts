/**
 * 列表布局：引脚只排在左侧，竖着往下铺。
 *
 * 用来对付 LQFP64/100 那种「四边都挤」的封装 —— 完整布局里上下两边的标签要竖排、
 * 字号还得压小，读起来很费劲；切成列表后每个脚一行，名字横着写，宽度够。
 *
 * 坐标系和完整布局不同：这里内容从 (0,0) 起、只做 `translate(0,-scroll) + scale`，
 * 不旋转也不居中。滚动靠 scroll，缩放靠 scale，两者互不干扰。
 */
import type { PinDef } from "../../model/types";
import type { Hit } from "./constants";
import { PIN_GAP, PIN_LEN, PIN_TEXT_FONT, PIN_TEXT_PAD, PIN_THICK } from "./constants";
import { drawPin, roundRect } from "./drawPin";

export interface ListBox {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  pins: PinDef[];
  scale: number;
  scroll: number;
  /** 行距倍率（＋/－ 按钮调整），用于几何计算 */
  density: number;
  title: string;
  usageByPin: Map<string, { fn: string; colorKey: string; owner: string }>;
  gpioByPin: Map<string, string>;
  /** 引脚自定义名称（优先于信号名显示在色块里） */
  pinLabels?: Record<string, string>;
  conflictPins: Set<string>;
  matchPins: Set<string>;
  cText: string;
  cDim: string;
  cAccent: string;
  cPins: { unused: string; power: string; reset: string; edge: string };
  cEdgeSoft: string;
}

/** 列表布局的几何：行高、缩进、色块宽度都由这里算，绘制与命中测试共用 */
export function listGeometry(o: Pick<ListBox, "ctx" | "pins" | "usageByPin" | "pinLabels"> & { density: number }) {
  const { ctx, pins, usageByPin, pinLabels } = o;
  ctx.font = PIN_TEXT_FONT;
  let chipW = PIN_LEN;
  for (const p of pins) {
    const text = pinLabels?.[p.name]?.trim() || usageByPin.get(p.name)?.fn;
    if (!text) continue;
    chipW = Math.max(chipW, ctx.measureText(text).width + PIN_TEXT_PAD * 2);
  }
  const padX = 16;
  const numW = 38;
  const railW = 5;
  const railX = padX + numW + 8;
  const chipX = railX + railW + PIN_GAP;
  const rowH = (PIN_THICK + 10) * o.density;
  const top = 46;
  return { padX, numW, railW, railX, chipX, chipW, rowH, top, contentH: top + o.pins.length * rowH + 20 };
}

export function drawListBox(o: ListBox): Hit[] {
  const { ctx, pins, usageByPin, gpioByPin, conflictPins, matchPins } = o;
  const g = listGeometry(o);
  const hits: Hit[] = [];

  // 标题与滚动提示**不缩放**：列表会放大到铺满高度，标题跟着缩放会变成巨字
  ctx.fillStyle = o.cDim;
  ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(o.title, g.padX, 20);

  // 内容放不下时提示怎么滚 —— 不写的话用户会以为滚轮又是缩放
  const visibleH = o.H / o.scale;
  if (g.contentH > visibleH) {
    ctx.fillStyle = o.cDim;
    ctx.font = "9.5px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("滚轮滚动", o.W - 16, 20);
  }

  // 引脚内容：缩放 + 滚动
  ctx.save();
  ctx.translate(0, -o.scroll);
  ctx.scale(o.scale, o.scale);

  // 竖向导轨：读作「芯片这一条边」，引脚都挂在它右边
  ctx.fillStyle = o.cEdgeSoft;
  roundRect(ctx, g.railX, g.top - 10, g.railW, pins.length * g.rowH + 4, g.railW / 2);
  ctx.fill();

  pins.forEach((pin, i) => {
    const y = g.top + i * g.rowH;
    const cy = y + PIN_THICK / 2;

    // 引脚号：列对齐，右对齐成一列
    ctx.fillStyle = o.cDim;
    ctx.font = "8.5px 'Cascadia Mono', Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(pin.num), g.padX + g.numW, cy);

    // 色块 + 信号名 + 引脚名（复用完整布局那一套绘制）
    const x = g.chipX;
    drawPin(ctx, pin, x, y, g.chipW, PIN_THICK, "left", {
      used: usageByPin.get(pin.name),
      label: o.pinLabels?.[pin.name],
      gpioColor: gpioByPin.get(pin.name),
      conflict: conflictPins.has(pin.name),
      match: matchPins.has(pin.name),
      cText: o.cText,
      cDim: o.cDim,
      cAccent: o.cAccent,
      pitch: g.rowH,
      cPins: o.cPins,
      hideNum: true,
    });
    hits.push({ pin, x, y, w: g.chipW, h: PIN_THICK, side: "left" });
  });

  ctx.restore();

  // 滚动条：内容超出视口时才画，位置按「已经滚了多少」算
  const visible = o.H / o.scale;
  if (g.contentH > visible) {
    const barH = Math.max(28, (visible / g.contentH) * o.H);
    const barY = (o.scroll / Math.max(1, g.contentH - visible)) * (o.H - barH);
    ctx.fillStyle = o.cEdgeSoft;
    roundRect(ctx, o.W - 7, Math.max(0, Math.min(o.H - barH, barY)), 4, barH, 2);
    ctx.fill();
  }
  return hits;
}
