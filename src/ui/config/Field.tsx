/**
 * 单个参数字段。 beginner=false 时隐藏寄存器位提示与公式。
 */
import { evalCond, toBool } from "../../engine/expr";
import type { ParamDef } from "../../model/types";

export function Field({
  def,
  value,
  mode,
  values,
  onChange,
  hiddenOptions,
  hiddenNote,
  beginner,
}: {
  def: ParamDef;
  value: unknown;
  mode: string | undefined;
  values: Record<string, unknown>;
  onChange: (k: string, v: string | number | boolean) => void;
  hiddenOptions?: Map<string, string>;
  hiddenNote?: string;
  beginner: boolean;
}) {
  const enabled = evalCond(def.enabledIf, values, mode);

  if (def.type === "note") {
    return beginner ? <p className="note-block">{String(def.default)}</p> : null;
  }

  if (def.type === "boolean") {
    const on = toBool(value ?? def.default);
    return (
      <div className="field">
        <label className="field-label">
          <input type="checkbox" checked={on} disabled={!enabled} onChange={(e) => onChange(def.key, e.target.checked)} />
          <span>{def.label}</span>
        </label>
        {beginner && def.hint && <p className="field-hint">{def.hint}</p>}
      </div>
    );
  }

  return (
    <div className="field">
      <div className="field-row">
        <label className="field-label">{def.label}</label>
        {def.type === "select" && (
          <select
            value={String(value ?? def.default)}
            disabled={!enabled}
            onChange={(e) => onChange(def.key, e.target.value)}
          >
            {def.options
              ?.filter((o) => !hiddenOptions?.has(String(o.value)))
              .map((o) => {
                const od = o.disabledIf ? evalCond(o.disabledIf, values, mode) : false;
                return (
                  <option key={o.value} value={o.value} disabled={od}>
                    {o.label}
                  </option>
                );
              })}
          </select>
        )}
        {def.type === "number" && (
          <div className="num-wrap">
            <input
              type="number"
              value={Number(value ?? def.default)}
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              disabled={!enabled}
              onChange={(e) => {
                let v = Number(e.target.value);
                if (def.min !== undefined) v = Math.max(def.min, v);
                if (def.max !== undefined) v = Math.min(def.max, v);
                onChange(def.key, v);
              }}
            />
            {def.unit && <span className="unit">{def.unit}</span>}
          </div>
        )}
        {def.type === "text" && (
          <input
            type="text"
            value={String(value ?? def.default)}
            disabled={!enabled}
            onChange={(e) => onChange(def.key, e.target.value)}
          />
        )}
      </div>
      {beginner && def.formula && <p className="field-formula">{def.formula}</p>}
      {beginner && def.hint && <p className="field-hint">{def.hint}</p>}
      {hiddenNote && <p className="field-hint field-hint-warn">{hiddenNote}</p>}
    </div>
  );
}
