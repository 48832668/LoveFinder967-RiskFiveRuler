/**
 * 通道配置页（TIM CH1-4 / ADC INx / EXTI LINEx）。
 */
import type { ClockDerived, DeviceDef, PeripheralConfig, PeripheralDef, Project } from "../../model/types";
import { timBase } from "../../engine/clock";
import { schemaFor } from "../../semantic/schemas";
import { channelKeysOf } from "../../semantic/pinmux";
import { evalCond, toBool } from "../../engine/expr";

export function ChannelTab({ dev, project, periph, cfg, clock, onChange, beginner }: {
  dev: DeviceDef; project: Project; periph: PeripheralDef; cfg: PeripheralConfig;
  clock: ClockDerived; onChange: (id: string, next: PeripheralConfig) => void; beginner: boolean;
}) {
  const schema = schemaFor(periph.schema);
  const spec = schema?.channelSpec;
  if (!spec) return null;

  const chans = cfg.channels ?? {};
  const arr = Number(cfg.params["arr"] ?? 999);
  const patch = (p: Partial<PeripheralConfig>) => onChange(periph.id, { ...cfg, ...p });
  const setCh = (key: string, c: typeof chans[string]) =>
    patch({ channels: { ...chans, [key]: c } });

  const keys = channelKeysOf(dev, periph);
  const params = spec.params ?? [];

  return (
    <div className="channel-tab">
      {beginner && spec.hint && <p className="hint-block">{spec.hint}</p>}
      {keys.map((key) => {
        const ch = chans[key] ?? { enabled: false, mode: "disable", pin: null, params: {} };
        const modeVal = ch.mode ?? "disable";
        return (
          <section key={key} className={`chan-card card ${ch.enabled ? "on" : ""}`}>
            <header>
              <label className="field-label">
                <input type="checkbox" checked={ch.enabled} onChange={(e) => setCh(key, { ...ch, enabled: e.target.checked })} />
                <span>{key}</span>
              </label>
              <select value={modeVal} onChange={(e) => setCh(key, { ...ch, mode: e.target.value, enabled: e.target.value !== "disable" })}>
                {spec.modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </header>
            {ch.enabled && (
              <div className="chan-body">
                {spec.needsPin && (
                  <div className="field">
                    <div className="field-row">
                      <label className="field-label">引脚</label>
                      <select value={ch.pin ?? ""} onChange={(e) => setCh(key, { ...ch, pin: e.target.value || null })}>
                        <option value="">— 未分配 —</option>
                        {(dev.package.pins.filter((p) => (p.signals ?? []).some((s) => s.fn === `${periph.id}_${key}`))).map((c) => (
                          <option key={c.name} value={c.name}>{c.name} · pin {c.num}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {params.map((p) => {
                  const vis = evalCond(p.visibleIf, { ...(ch.params ?? {}), "@mode": ch.mode }, ch.mode);
                  if (!vis) return null;
                  const val = ch.params?.[p.key] ?? p.default;
                  const setVal = (v: string | number | boolean) => setCh(key, { ...ch, params: { ...(ch.params ?? {}), [p.key]: v } });
                  if (p.type === "boolean") {
                    return (
                      <div className="field" key={p.key}>
                        <label className="field-label">
                          <input type="checkbox" checked={toBool(val)} onChange={(e) => setVal(e.target.checked)} />
                          <span>{p.label}</span>
                        </label>
                        {beginner && p.hint && <p className="field-hint">{p.hint}</p>}
                      </div>
                    );
                  }
                  if (p.type === "select") {
                    return (
                      <div className="field" key={p.key}>
                        <div className="field-row">
                          <label className="field-label">{p.label}</label>
                          <select value={String(val)} onChange={(e) => setVal(e.target.value)}>
                            {p.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                        {beginner && p.hint && <p className="field-hint">{p.hint}</p>}
                      </div>
                    );
                  }
                  return null;
                })}
                {periph.kind === "TIM" && modeVal === "pwm" && (
                  <div className="chan-calc">
                    <span>占空比 </span>
                    <b>{(((Number(ch.params?.["pulse"] ?? 0) / (arr + 1)) * 100) || 0).toFixed(1)} %</b>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
