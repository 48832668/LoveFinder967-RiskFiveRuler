/**
 * 引脚弹出菜单：点画布上的引脚后，列出可承载的复用功能 / EXTI 线 / GPIO 模式。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DeviceDef, PinDef, Project } from "../../model/types";
import { colorOf } from "../../semantic/pinmux";
import { describeSignal, GPIO_MODES, KIND_ORDER, remapMark, remapHint } from "./constants";

interface MenuEntry {
  fn: string;
  kind: string;
  desc: string;
  remaps: string[];
}

export function PinMenu({
  pin,
  dev,
  project,
  x,
  y,
  pinLocked = false,
  onToggleLock,
  onEditName,
  onClose,
  onAssign,
  onGpioMode,
  onSelectPeripheral,
}: {
  pin: PinDef;
  dev: DeviceDef;
  project: Project;
  x: number;
  y: number;
  /** 该引脚是否被用户锁定（右键菜单切换） */
  pinLocked?: boolean;
  onToggleLock: () => void;
  /** 跳转 GPIO 表格面板编辑自定义名称 */
  onEditName: () => void;
  onClose: () => void;
  onAssign: (pin: string, fn: string | null) => void;
  onGpioMode: (pin: string, mode: string) => void;
  onSelectPeripheral: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + 12, top: y - 8 });

  // 先渲染再量尺寸：菜单永远贴着鼠标右侧弹出，右边放不下就翻到左侧
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 12;
    const margin = 10;
    let left = x + gap;
    if (left + w > window.innerWidth - margin) left = Math.max(margin, x - w - gap);
    let top = y - 10;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - h);
    setPos({ left, top });
  }, [x, y]);

  // 用 pointerdown 而不是 click 做「点外面关闭」：
  // click 会和打开菜单的那一次点击在同一条事件链里跑，菜单刚挂上就被关掉；
  // pointerdown 早于 click，天然避开这个顺序问题。
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const gpio = project.gpio[pin.name];
  /** 本系列的 GPIO 支不支持开漏（X035 只有推挽） */
  const openDrainOk = dev.api?.gpioOpenDrain ?? true;

  const ownerOf = (fn: string) => {
    const owner = fn.split("_")[0];
    const cfg = project.configs[owner];
    if (!cfg?.enabled) return null;
    const sig = fn.slice(owner.length + 1);
    return cfg.pins[sig] === pin.name ? fn : null;
  };
  const channelOwnerOf = (fn: string) => {
    const owner = fn.split("_")[0];
    const cfg = project.configs[owner];
    if (!cfg?.enabled) return null;
    const key = fn.slice(owner.length + 1);    // 互补输出（TIM1_CH1N）记在通道的 pinN 上，不是独立通道
    const complement = /^(.+)N$/.exec(key);
    if (complement && cfg.channels?.[complement[1]]?.pinN === pin.name) {
      return `${owner}_${key}`;
    }
    if (cfg.channels?.[key]?.pin === pin.name) return fn;
    return null;
  };
  const activeFn = (fn: string) => ownerOf(fn) ?? channelOwnerOf(fn);

  // 同一个信号可能出现在多个重映射组里，菜单里合并成一条，只标注重映射号
  const entries = useMemo(() => {
    const map = new Map<string, MenuEntry>();
    for (const s of pin.signals ?? []) {
      const owner = s.fn.split("_")[0];
      const kind = dev.peripherals.find((p) => p.id === owner)?.kind ?? "SYSTEM";
      const cur = map.get(s.fn);
      if (cur) {
        if (s.remap && !cur.remaps.includes(s.remap)) cur.remaps.push(s.remap);
        continue;
      }
      map.set(s.fn, { fn: s.fn, kind, desc: describeSignal(s.fn, kind), remaps: s.remap ? [s.remap] : [] });
    }
    const rank = (k: string) => {
      const i = KIND_ORDER.indexOf(k);
      return i < 0 ? KIND_ORDER.length : i;
    };
    return [...map.values()].sort((a, b) => {
      const r = rank(a.kind) - rank(b.kind);
      return r !== 0 ? r : a.fn.localeCompare(b.fn);
    });
  }, [pin, dev]);

  const exti = entries.filter((e) => e.kind === "EXTI" || e.fn.startsWith("EXTI_"));
  const funcs = entries.filter((e) => !exti.includes(e));
  const activeOwner = pin.signals?.map((s) => activeFn(s.fn)).find(Boolean)?.split("_")[0] ?? null;

  return (
    <div
      className="pin-menu dropdown"
      ref={ref}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="pin-menu-head">
        <b>{pin.name}</b>
        <span>pin {pin.num}</span>
        {pin.kind !== "io" && <em className="tag warn">{pin.kind}</em>}
        {pin.kind === "io" && gpio && <em className="pin-menu-gm">{GPIO_MODES.find((g) => g.m === gpio.mode)?.label ?? gpio.mode}</em>}
      </div>
      {pin.note && <p className="pin-menu-note">{pin.note}</p>}

      {pin.kind === "io" ? (
        <>
          {/* 锁定 / 解锁：锁定的引脚不能分配外设、不能改 GPIO 模式（自动规划也会绕开） */}
          <button
            className={`pin-menu-item dropdown-item ${pinLocked ? "is-danger" : ""}`}
            onClick={() => {
              onToggleLock();
              onClose();
            }}
          >
            {pinLocked ? "🔓 解除锁定" : "🔒 锁定该引脚"}
          </button>
          {pinLocked && <div className="pin-menu-empty">已锁定：不能分配给外设，也不能改 GPIO 模式</div>}

          <button
            className="pin-menu-item dropdown-item"
            onClick={() => {
              onEditName();
              onClose();
            }}
            title="跳转到 GPIO 表格面板，给这颗引脚设置自定义名称"
          >
            ✏ 设置自定义名称
          </button>

          <div className="pin-menu-group">
            复用功能 <em>{funcs.length}</em>
          </div>
          {funcs.length === 0 && <div className="pin-menu-empty">该封装未定义复用</div>}
          {funcs.map((e) => {
            const active = activeFn(e.fn);
            return (
              <button
                key={e.fn}
                className={`pin-menu-item dropdown-item ${active ? "active" : ""}`}
                disabled={pinLocked && !active}
                onClick={() => {
                  onAssign(pin.name, e.fn);
                  onClose();
                }}
              >
                <i style={{ background: colorOf(e.kind) }} />
                <span className="fn">{e.fn}</span>
                {e.remaps.length > 0 && (
                  <span className="rp" title={remapHint(dev)}>
                    {remapMark(dev)}
                    {e.remaps.join("/")}
                  </span>
                )}
                <span className="desc">{active ? "已用" : e.desc}</span>
              </button>
            );
          })}

          <div className="pin-menu-group">
            外部中断 <em>{exti.length}</em>
          </div>
          {exti.length === 0 && <div className="pin-menu-empty">该引脚没有 EXTI 线</div>}
          {exti.map((e) => {
            const active = activeFn(e.fn);
            return (
              <button
                key={e.fn}
                className={`pin-menu-item dropdown-item ${active ? "active" : ""}`}
                disabled={pinLocked && !active}
                onClick={() => {
                  onAssign(pin.name, e.fn);
                  onClose();
                }}
              >
                <i style={{ background: colorOf("EXTI") }} />
                <span className="fn">{e.fn.replace("EXTI_LINE", "EXTI")}</span>
                <span className="desc">{active ? "已用" : e.desc}</span>
              </button>
            );
          })}

          <div className="pin-menu-group">
            GPIO 模式
            {!openDrainOk && <em className="no-od" title="本系列的 GPIO 只有推挽输出（数据手册 GPIO 章节）">无开漏</em>}
          </div>
          <div className="pin-menu-gpio">
            {GPIO_MODES.map((o) => {
              // X035 的 GPIO_Mode 里只有 Out_PP / AF_PP，没有开漏 —— 灰掉而不是藏起来
              const od = o.m === "output_od";
              const blocked = (od && !openDrainOk) || pinLocked;
              return (
                <button
                  key={o.m}
                  className={`btn btn-outline btn-sm${gpio?.mode === o.m ? " btn-soft is-active" : ""}`}
                  disabled={blocked}
                  title={blocked ? (pinLocked ? "引脚已锁定" : `${dev.family} 的 GPIO 不支持开漏输出`) : undefined}
                  onClick={() => {
                    if (blocked) return;
                    onGpioMode(pin.name, o.m);
                    onClose();
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          <div className="pin-menu-sep dropdown-divider" />
          <button
            className="pin-menu-item dropdown-item danger is-danger"
            disabled={pinLocked}
            onClick={() => {
              onAssign(pin.name, null);
              onClose();
            }}
          >
            释放该引脚
          </button>
        </>
      ) : (
        <div className="pin-menu-empty">
          {pin.kind === "reset"
            ? "复位引脚（NRST），硬件固定、上电默认生效，不可改作他用"
            : "固定功能引脚，不可配置"}
        </div>
      )}

      <div className="pin-menu-foot">
        <button
          className="link"
          disabled={!activeOwner}
          onClick={() => {
            if (!activeOwner) return;
            onSelectPeripheral(activeOwner);
            onClose();
          }}
        >
          {activeOwner ? `查看 ${activeOwner}` : "查看外设"}
        </button>
      </div>
    </div>
  );
}
