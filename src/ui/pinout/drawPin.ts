/**
 * 单个引脚矩形与网格的 canvas 绘制。
 *
 * 文字一律经 `uprightText` 落笔：传入「视图整体旋转角」后，文字角度按
 * 「芯片坐标系角度 − 视图角」补偿 —— 视图转 90/180/270° 时引脚号、引脚名、
 * 信号名都不会跟着颠倒，保持可读。
 */
import type { PinDef } from "../../model/types";
import { colorOf } from "../../semantic/pinmux";
import {
  contrastOn,
  LABEL_PAD,
  PIN_GAP,
  PIN_LEN,
  PIN_NAME_INSET,
  PIN_TEXT_FONT,
  PIN_TEXT_PAD,
  PIN_THICK,
} from "./constants";

/** 圆角矩形路径（只建路径不落笔，调用方自己 fill/stroke） */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const step = 28;
  ctx.beginPath();
  for (let x = 0; x < W; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y < H; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();
}

/**
 * 在（可能被整体旋转的）画布上写字。
 *
 * `chipAngleDeg` 是文字在**芯片坐标系**里的角度（0 = 水平，45 = 上下排的斜排名，
 * -90 = 竖排信号名）。补偿掉视图旋转角后，屏幕上看到的角度恒等于芯片坐标角度，
 * 视图怎么转文字都不会颠倒。
 */
function uprightText(
  ctx: CanvasRenderingContext2D,
  viewRotDeg: number,
  chipAngleDeg: number,
  ax: number,
  ay: number,
  draw: () => void,
) {
  ctx.save();
  ctx.translate(ax, ay);
  const rad = ((chipAngleDeg - viewRotDeg) * Math.PI) / 180;
  if (rad) ctx.rotate(rad);
  draw();
  ctx.restore();
}

export interface DrawPinOpt {
  used?: { fn: string; colorKey: string; owner: string };
  /** 用户给该引脚设的自定义名称（如 LCD1_CS），优先显示在色块里 */
  label?: string;
  /** 用户配成普通 GPIO 时的填充色（模拟态为 null，不着色） */
  gpioColor?: string;
  conflict: boolean;
  match: boolean;
  /** 锁定映射（图钉样式）：引脚被用户右键锁定 */
  locked?: boolean;
  /** 该脚所属外设锁定了重映射组：信号名画下划线（不画图钉） */
  underline?: boolean;
  cText: string;
  cDim: string;
  cAccent: string;
  /** 同侧引脚间距，用来决定标签是否要旋转/缩小 */
  pitch: number;
  cPins: { unused: string; power: string; reset: string; edge: string };
  /** 列表布局自己画列对齐的引脚号，这时别让 drawPin 再画一个 */
  hideNum?: boolean;
  /**
   * 水平引脚名距色块内端的距离。完整布局传 PIN_GAP + PIN_NAME_INSET，
   * 让名字落在本体内侧；列表布局不传，保持贴着色块右侧的紧凑写法。
   */
  nameGap?: number;
  /** 本体矩形（完整布局）：上下两排的斜排名字要收进这个矩形内侧 */
  body?: { x: number; y: number; w: number; h: number };
  /** 视图整体旋转角（度）。文字据此反向补偿，保持可读。 */
  viewRot?: number;
}

export function drawPin(
  ctx: CanvasRenderingContext2D,
  pin: PinDef,
  x: number,
  y: number,
  w: number,
  h: number,
  side: "left" | "right" | "top" | "bottom",
  opt: DrawPinOpt,
) {
  const isPower = pin.kind === "power";
  const isReset = pin.kind === "reset";
  let fill = opt.cPins.unused;
  if (isPower) fill = opt.cPins.power;
  else if (isReset) fill = opt.cPins.reset;
  if (opt.gpioColor) fill = opt.gpioColor;
  if (opt.used) fill = colorOf(opt.used.colorKey);
  const lit = Boolean(opt.used || opt.gpioColor);
  const rot = opt.viewRot ?? 0;

  ctx.save();
  if (opt.match) {
    ctx.shadowColor = opt.cAccent;
    ctx.shadowBlur = 14;
  }
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, 2.5);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = opt.conflict ? 2 : 1;
  ctx.strokeStyle = opt.conflict ? "#ff5f6d" : opt.cPins.edge;
  ctx.stroke();
  ctx.restore();

  // 引脚级锁定：与左侧面板一致，只给引脚文字加下划线（下面各分支绘制时统一补上）

  ctx.font = "8.5px 'Cascadia Mono', Consolas, monospace";
  ctx.fillStyle = opt.cDim;
  ctx.textBaseline = "middle";

  const numLabel = String(pin.num);
  // 复位 / BOOT0 的默认职能直接写在引脚文本上，画板子时一眼能看到
  let nameLabel = pin.name;
  if (pin.kind === "reset") nameLabel = `${nameLabel}（复位）`;
  else if (pin.kind === "boot" && !/BOOT0/i.test(nameLabel)) nameLabel = `${nameLabel}(BOOT0)`;

  /** 锁定（引脚级或外设映射组）时，给引脚名套一个恰好包裹的圆角矩形（与引脚色块同风格） */
  const nameBox = (fontPx: number) => {
    if (!(opt.locked || opt.underline)) return;
    const tw = ctx.measureText(nameLabel).width;
    const padX = 2.5;
    const padY = 1.2;
    const x0 = ctx.textAlign === "right" ? -tw : ctx.textAlign === "center" ? -tw / 2 : 0;
    const top = -fontPx / 2 - padY;
    const hh = fontPx + padY * 2;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle as string;
    ctx.lineWidth = 1;
    roundRect(ctx, x0 - padX, top, tw + padX * 2, hh, Math.min(4, hh / 2));
    ctx.stroke();
    ctx.restore();
  };

  if (side === "left") {
    if (!opt.hideNum) {
      uprightText(ctx, rot, 0, x - LABEL_PAD, y + h / 2, () => {
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(numLabel, 0, 0);
      });
    }
    ctx.font = "9.5px 'Cascadia Mono', Consolas, monospace";
    ctx.fillStyle = lit ? opt.cText : opt.cDim;
    uprightText(ctx, rot, 0, x + w + (opt.nameGap ?? 5), y + h / 2, () => {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(nameLabel, 0, 0);
      nameBox(9.5);
    });
  } else if (side === "right") {
    uprightText(ctx, rot, 0, x + w + LABEL_PAD, y + h / 2, () => {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(numLabel, 0, 0);
    });
    ctx.font = "9.5px 'Cascadia Mono', Consolas, monospace";
    ctx.fillStyle = lit ? opt.cText : opt.cDim;
    uprightText(ctx, rot, 0, x - (opt.nameGap ?? 5), y + h / 2, () => {
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(nameLabel, 0, 0);
      nameBox(9.5);
    });
  } else {
    /*
     * 上下两排引脚排得密：引脚名顺时针斜 45°，**收进本体内侧** ——
     * 以前文字朝外展开，压在封装符号边框外的空白上，和圆角矩形脱节。
     * 现在锚点放在顶 / 底边内侧 5px，文字沿 45° 伸向本体内部；
     * 引脚号仍留在色块外侧，紧挨着各自的色块。
     */
    const size = Math.max(6, Math.min(9.5, opt.pitch * 0.82));
    const top = side === "top";
    uprightText(ctx, rot, 0, x + w / 2, top ? y - 5 : y + h + 7, () => {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(numLabel, 0, 0);
    });

    const body = opt.body ?? { x: 0, y: 0, w: 0, h: 0 };
    ctx.fillStyle = lit ? opt.cText : opt.cDim;
    ctx.font = `${size}px 'Cascadia Mono', Consolas, monospace`;
    uprightText(ctx, rot, 45, x + w / 2, top ? body.y + 5 : body.y + body.h - 5, () => {
      ctx.textAlign = top ? "left" : "right";
      ctx.textBaseline = "middle";
      ctx.fillText(nameLabel, 0, 0);
      nameBox(size);
    });
  }

  /*
   * 已分配信号 / 自定义名称：把文字直接写在色块里。
   *
   * 用户给引脚设了自定义名称（如 LCD1_CS）时优先显示它，其次才是外设信号名。
   * 色块长度已按文字宽度撑开（见 place()），所以能写全。
   * 文字颜色按底色亮度取黑/白，否则黄底白字（USB 是 #f2c94c）等于看不见。
   * 下划线 = 所属外设锁定了重映射组（文字最直观）。
   */
  const pinText = (opt.label?.trim() || opt.used?.fn || "").trim();
  if (pinText) {
    const bg = opt.used ? colorOf(opt.used.colorKey) : (opt.gpioColor ?? opt.cPins.unused);
    ctx.save();
    ctx.font = PIN_TEXT_FONT;
    ctx.fillStyle = contrastOn(bg);
    const drawUnderline = () => {
      if (!(opt.underline || opt.locked)) return;
      const tw = ctx.measureText(pinText).width;
      const x0 = ctx.textAlign === "right" ? -tw : ctx.textAlign === "center" ? -tw / 2 : 0;
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, 4.5); // textBaseline=middle → +4.5 在 8px 字底下沿
      ctx.lineTo(x0 + tw, 4.5);
      ctx.stroke();
    };
    if (side === "left" || side === "right") {
      const tx = side === "left" ? x + PIN_TEXT_PAD : x + w - PIN_TEXT_PAD;
      uprightText(ctx, rot, 0, tx, y + h / 2, () => {
        ctx.textAlign = side === "left" ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillText(pinText, 0, 0);
        drawUnderline();
      });
    } else {
      // 竖排：从靠本体的一端向外写（芯片坐标里转 -90°）
      const top = side === "top";
      uprightText(ctx, rot, -90, x + w / 2, top ? y + h - PIN_TEXT_PAD : y + PIN_TEXT_PAD, () => {
        ctx.textAlign = top ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillText(pinText, 0, 0);
        drawUnderline();
      });
    }
    ctx.restore();
  }
}
