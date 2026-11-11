/**
 * GPIO 已配置引脚总表。
 *
 * 左侧树里的 GPIO 板块一直是「开」的：点进去看到的是一张表，
 * 罗列当前工程里所有已配置的 IO（分配给外设的 + 手工配成 GPIO 的），
 * 列依次为：序号、引脚、外设、IO 类型、速度、自定义名称（可编辑）。
 */
import { useEffect, useRef } from "react";
import type { DeviceDef, Project } from "../../model/types";
import { collectUsage, GPIO_MODE_LABELS, colorOf } from "../../semantic/pinmux";

interface Props {
  dev: DeviceDef;
  project: Project;
  /** 右键菜单「设置自定义名称」跳转过来时要聚焦的引脚 */
  focusPin: string | null;
  onFocusDone: () => void;
  onEditPinLabel: (pin: string, label: string) => void;
  /** 新手模式才显示那句说明 */
  beginner: boolean;
}

export function GpioTablePanel({ dev, project, focusPin, onFocusDone, onEditPinLabel, beginner }: Props) {
  const usage = collectUsage(project, dev);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // 收集所有已配置的 IO：外设分配的 + 手工配成 GPIO 的（非模拟态）
  const rows = (() => {
    const byPin = new Map<string, { owner: string; fn: string; colorKey: string }>();
    for (const u of usage) {
      if (!byPin.has(u.pin)) byPin.set(u.pin, { owner: u.owner, fn: u.fn, colorKey: u.colorKey });
    }
    for (const [pin, g] of Object.entries(project.gpio)) {
      if (byPin.has(pin) || !g || g.mode === "analog") continue;
      byPin.set(pin, { owner: "", fn: "", colorKey: "GPIO" });
    }
    return [...byPin.entries()]
      .sort((a, b) => {
        const pa = dev.package.pins.find((p) => p.name === a[0]);
        const pb = dev.package.pins.find((p) => p.name === b[0]);
        return (typeof pa?.num === "number" ? pa.num : 999) - (typeof pb?.num === "number" ? pb.num : 999);
      })
      .map(([pin, info], i) => {
        const pinDef = dev.package.pins.find((p) => p.name === pin);
        const gpio = project.gpio[pin];
        const mode = info.fn
          ? "复用"
          : gpio && gpio.mode !== "analog"
            ? (GPIO_MODE_LABELS[gpio.mode]?.replace("GPIO ", "") ?? gpio.mode)
            : "—";
        return {
          idx: i + 1,
          pin,
          num: pinDef?.num ?? "?",
          owner: info.owner,
          fn: info.fn,
          mode,
          label: project.pinLabels[pin] ?? "",
        };
      });
  })();

  // 右键菜单跳转过来时聚焦对应的自定义名称输入框
  useEffect(() => {
    if (!focusPin) return;
    const el = inputRefs.current.get(focusPin);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.select();
    }
    onFocusDone();
  }, [focusPin, onFocusDone]);

  return (
    <div className="gpio-table-panel">
      <header className="panel-head">
        <h2>GPIO</h2>
        {beginner && <p>当前工程所有已配置的 IO。自定义名称会显示在生成代码的注释里，方便对照硬件。</p>}
      </header>
      {rows.length === 0 ? (
        <p className="hint-block">还没有已配置的引脚 —— 在引脚图上分配外设或配置 GPIO 后，这里会自动列出。</p>
      ) : (
        <table className="pin-table table-dense gpio-table">
          <thead>
            <tr><th>#</th><th>引脚</th><th>外设</th><th>IO 类型</th><th>自定义名称</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pin} className={focusPin === r.pin ? "focus-row" : ""}>
                <td className="mono">{r.idx}</td>
                <td className="mono">
                  {r.pin} · pin {r.num}
                  <i className="kind-bar" style={{ background: colorOf(r.fn ? (r.owner ? dev.peripherals.find((p) => p.id === r.owner)?.kind ?? "GPIO" : "GPIO") : "GPIO"), marginLeft: 6, verticalAlign: "middle" }} />
                </td>
                <td>{r.owner || <span className="muted">GPIO</span>}{r.fn && <span className="mono muted"> {r.fn}</span>}</td>
                <td>{r.mode}</td>
                <td>
                  <input
                    ref={(el) => { if (el) inputRefs.current.set(r.pin, el); else inputRefs.current.delete(r.pin); }}
                    className="form-control gpio-label-input"
                    value={r.label}
                    placeholder="自定义名称"
                    onChange={(e) => onEditPinLabel(r.pin, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
