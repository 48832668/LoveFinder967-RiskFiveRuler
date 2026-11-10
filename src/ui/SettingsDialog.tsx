/**
 * 设置弹窗。
 *
 * 只有两块：主题（一个颜色派生全部主色阶 + 日夜模式）、引脚图图例配色。
 * 所有改动即时生效（props.onApply），并由 App 持久化到 config.json；
 * 导入 / 导出走 platform/settings 的 JSON 通道。
 */

import { useEffect } from "react";
import { KIND_COLORS } from "../semantic/pinmux";
import type { UiPrefs } from "../platform/settings";
import { exportPrefsJson, importPrefsJson } from "../platform/settings";

interface Props {
  prefs: UiPrefs;
  onApply: (p: UiPrefs) => void;
  onClose: () => void;
}

const KIND_LABELS: Record<string, string> = {
  USART: "串口 USART",
  SPI: "SPI",
  I2C: "I²C",
  TIM: "定时器 TIM",
  ADC: "ADC",
  USB: "USB",
  CAN: "CAN",
  OPA: "运放 OPA",
  CMP: "比较器 CMP",
  EXTI: "外部中断",
  DMA: "DMA",
  GPIO: "GPIO",
  CLK: "时钟源",
  DBG: "调试口",
  PWR: "电源 PWR",
  RTC: "RTC",
  IWDG: "独立看门狗",
  WWDG: "窗口看门狗",
  CRC: "CRC",
  SYSTEM: "系统",
};

/** 快速可选的主题色（默认 + 几个常见工业风） */
const THEME_PRESETS = ["#008dd7", "#12a184", "#7a4fd0", "#e29a10", "#e5484d", "#5f7fbf"];

export function SettingsDialog({ prefs, onApply, onClose }: Props) {
  const patch = (p: Partial<UiPrefs>) => onApply({ ...prefs, ...p });

  // Esc 关闭（capture：上层菜单的 Esc 处理不抢）。点背景不关闭 —— 避免误触丢面板。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const setPinColor = (kind: string, color: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    patch({ pinColors: { ...prefs.pinColors, [kind]: color } });
  };

  const resetPinColors = () => patch({ pinColors: {} });

  const doImport = async () => {
    const imported = await importPrefsJson();
    if (imported) onApply(imported);
  };

  const doExport = async () => {
    await exportPrefsJson(prefs);
  };

  const entries = Object.entries(KIND_COLORS);
  const overridden = entries.filter(([k]) => prefs.pinColors[k]).length;

  return (
    <div className="modal">
      <div className="modal-dialog settings-modal" role="dialog" aria-label="设置">
        <header className="modal-header">
          <div>
            <h2 className="modal-title">设置</h2>
            <p>主题与引脚图配色，保存在程序目录的 config.json</p>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </header>

        <div className="modal-body settings-body">
          <section className="settings-group">
            <h3>主题</h3>
            <div className="pref-row">
              <span className="pref-label">主题颜色</span>
              <div className="pref-value theme-picker">
                <input
                  type="color"
                  value={prefs.themeColor}
                  onChange={(e) => patch({ themeColor: e.target.value })}
                  title="主题颜色（按钮 / 选中态 / 链接等由它派生）"
                />
                <code className="mono">{prefs.themeColor}</code>
                <div className="theme-swatches">
                  {THEME_PRESETS.map((c) => (
                    <button
                      key={c}
                      className={`theme-swatch${c.toLowerCase() === prefs.themeColor.toLowerCase() ? " is-active" : ""}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => patch({ themeColor: c })}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="pref-row">
              <span className="pref-label">模式</span>
              <div className="pref-value">
                <div className="segmented">
                  <button
                    className={`segmented-item${prefs.mode === "light" ? " is-active" : ""}`}
                    onClick={() => patch({ mode: "light" })}
                  >
                    ☀ 日间
                  </button>
                  <button
                    className={`segmented-item${prefs.mode === "dark" ? " is-active" : ""}`}
                    onClick={() => patch({ mode: "dark" })}
                  >
                    ☾ 夜间
                  </button>
                </div>
              </div>
            </div>
            <div className="pref-row">
              <span className="pref-label">新手模式</span>
              <div className="pref-value">
                <label className="form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    checked={prefs.beginner}
                    onChange={(e) => patch({ beginner: e.target.checked })}
                  />
                  <span className="form-check-label">
                    显示工作模式说明、寄存器位提示（CTLR1.WL 等）与页内教学注释
                  </span>
                </label>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <h3>
              引脚图图例颜色
              <span className="settings-hint">
                {overridden > 0 ? `已自定义 ${overridden} 项` : "使用默认配色"}
              </span>
            </h3>
            <div className="pin-color-grid">
              {entries.map(([kind, def]) => {
                const color = prefs.pinColors[kind] ?? def;
                return (
                  <label className="pin-color-row" key={kind} title={`${kind} 图例与引脚块颜色`}>
                    <i className="pin-color-dot" style={{ background: color }} />
                    <span className="pin-color-name">{KIND_LABELS[kind] ?? kind}</span>
                    <code className="mono pin-color-hex">{color}</code>
                    <input
                      type="color"
                      className="pin-color-input"
                      value={color}
                      onChange={(e) => setPinColor(kind, e.target.value)}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={doImport}>
            导入
          </button>
          <button className="btn btn-ghost btn-sm" onClick={doExport}>
            导出
          </button>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={resetPinColors} title="图例颜色恢复默认">
            恢复默认配色
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
