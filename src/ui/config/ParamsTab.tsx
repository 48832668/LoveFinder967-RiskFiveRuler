/**
 * 参数页：字段渲染 + 实时计算框。
 */
import { useMemo } from "react";
import type { ClockDerived, DeviceDef, PeripheralConfig, PeripheralDef, Project } from "../../model/types";
import { modeMissingSignals, modeOptionSupported, pinTableSignals } from "../../semantic/pinmux";
import { evalCond } from "../../engine/expr";
import { schemaFor } from "../../semantic/schemas";
import { spiClock, timBase, usartBrr } from "../../engine/clock";
import { Field } from "./Field";
import { Collapse } from "./Collapse";

export function ParamsTab({
  schema, values, mode, disabled, setParam, periph, clock, cfg, project, dev, beginner,
}: {
  schema: NonNullable<ReturnType<typeof schemaFor>>;
  values: Record<string, unknown>;
  mode: string | undefined;
  disabled: boolean;
  setParam: (k: string, v: string | number | boolean) => void;
  periph: PeripheralDef;
  clock: ClockDerived;
  cfg: PeripheralConfig;
  project: Project;
  dev: DeviceDef;
  beginner: boolean;
}) {
  const paramsForDevice = schema.params.map((p) => {
    if (p.key !== "sampleTime" || !dev.api?.adcSampleTimes?.length) return p;
    const opts = dev.api.adcSampleTimes.map((v) => ({ label: `${v} 周期`, value: v }));
    return { ...p, options: opts, default: opts[0]!.value };
  });

  const hiddenModes = useMemo(() => {
    const modeKey = schema.modeKey;
    if (!modeKey) return { map: undefined as Map<string, string> | undefined, note: undefined };
    const all = schema.params.find((p) => p.key === modeKey)?.options ?? [];
    const map = new Map<string, string>();
    const noPins: string[] = [];
    for (const o of all) {
      const v = String(o.value);
      if (v === "disable" || v === "off") continue;
      // 硬件没有的档位直接从下拉里消失，不打提示 —— 少什么不该由界面念出来
      if (!modeOptionSupported(dev, o)) { map.set(v, ""); continue; }
      const missing = modeMissingSignals(dev, periph, v);
      if (missing.length) { map.set(v, `缺 ${missing.join(" / ")}`); noPins.push(o.label.split("  ")[0]); }
    }
    // 引脚没引出的说明只在注释模式下给：平时切封装看到模式少了，翻新手提示即可
    return {
      map: map.size ? map : undefined,
      note: beginner && noPins.length ? `本封装未引出对应引脚，已隐藏：${noPins.join("、")}` : undefined,
    };
  }, [schema, dev, periph, beginner]);

  const visible = paramsForDevice.filter((p) => evalCond(p.visibleIf, values, mode));
  const ungrouped = visible.filter((p) => !p.group);
  const groups = schema.groups ?? [];

  return (
    <div className={`params ${disabled ? "is-disabled" : ""}`}>
      {ungrouped.map((p) => (
        <Field key={p.key} def={p} value={values[p.key]} mode={mode} values={values} onChange={setParam}
          hiddenOptions={p.key === schema.modeKey ? hiddenModes.map : undefined}
          hiddenNote={p.key === schema.modeKey ? hiddenModes.note : undefined} beginner={beginner} />
      ))}
      {groups.map((g) => {
        const items = visible.filter((p) => p.group === g.key);
        if (!items.length) return null;
        return (
          <Collapse key={g.key} title={g.label} defaultOpen={g.open ?? false} hint={g.hint} badge={items.length} beginner={beginner}>
            {items.map((p) => (
              <Field key={p.key} def={p} value={values[p.key]} mode={mode} values={values} onChange={setParam}
                hiddenOptions={p.key === schema.modeKey ? hiddenModes.map : undefined}
                hiddenNote={p.key === schema.modeKey ? hiddenModes.note : undefined} beginner={beginner} />
            ))}
          </Collapse>
        );
      })}
      <DerivedBox periph={periph} cfg={cfg} clock={clock} project={project} dev={dev} />
    </div>
  );
}

/* ── 实时计算 ── */
function DerivedBox({ periph, cfg, clock, project, dev }: {
  periph: PeripheralDef; cfg: PeripheralConfig; clock: ClockDerived; project: Project; dev: DeviceDef;
}) {
  const v = cfg.params;
  const rows: { k: string; val: string; warn?: boolean }[] = [];
  switch (periph.kind) {
    case "USART": case "UART": {
      const baud = Number(v["baud"] ?? 115200);
      const r = usartBrr(clock.pclk2 || clock.pclk1, baud, 16);
      rows.push({ k: "实际波特率", val: `${r.actual.toFixed(2)} bit/s` });
      rows.push({ k: "BRR", val: `0x${r.brr.toString(16).toUpperCase()}` });
      rows.push({ k: "误差", val: `${r.error >= 0 ? "+" : ""}${r.error.toFixed(2)} %`, warn: Math.abs(r.error) > 2 });
      break;
    }
    case "SPI": {
      const f = spiClock(clock.pclk2, Number(v["prescaler"] ?? 8));
      rows.push({ k: "SCLK", val: `${f.toFixed(3)} MHz` });
      break;
    }
    // I2C 不显示实时计算：CCR/TRISE 由 SPL 的 I2C_Init 按 I2C_ClockSpeed 自行换算，
    // 这里再算一遍只会给出一个与硬件不同步的死数字（曾固定显示 100.0 kHz）。
    case "TIM": {
      const t = timBase(clock.pclk2, Number(v["psc"] ?? 0), Number(v["arr"] ?? 999), String(v["counterMode"] ?? "up"));
      rows.push({ k: "计数频率", val: `${t.freq.toFixed(3)} Hz` });
      rows.push({ k: "周期", val: `${t.period.toFixed(6)} s` });
      const pwmCh = Object.entries(cfg.channels ?? {}).find(([, c]) => c.enabled && c.mode === "pwm");
      if (pwmCh) {
        const ccr = Number(pwmCh[1].params?.["pulse"] ?? 0);
        const arr = Number(v["arr"] ?? 999);
        rows.push({ k: "占空比", val: `${(((ccr / (arr + 1)) * 100) || 0).toFixed(1)} %` });
      }
      break;
    }
    case "IWDG": {
      const lsi = dev.clock.lsi;
      const t = (Number(v["prescaler"] ?? 64) * (Number(v["reload"] ?? 4095) + 1)) / (lsi * 1000);
      rows.push({ k: "溢出时间", val: `${t.toFixed(3)} s` });
      break;
    }
    case "CAN": {
      const brp = Number(v["prescaler"] ?? 4);
      const tq = brp / (clock.pclk1 / 1e6);
      const total = 1 + Number(v["bs1"] ?? 8) + Number(v["bs2"] ?? 3);
      rows.push({ k: "波特率", val: `${(1 / (tq * total) / 1000).toFixed(1)} kbit/s` });
      rows.push({ k: "采样点", val: `${(((1 + Number(v["bs1"] ?? 8)) / total) * 100).toFixed(1)} %` });
      break;
    }
  }
  if (!rows.length) return null;
  return (
    <div className="derived card">
      <div className="derived-head">实时计算</div>
      {rows.map((r) => (
        <div className={`derived-row${r.warn ? " warn" : ""}`} key={r.k}>
          <span>{r.k}</span>
          <b className="mono">{r.val}</b>
        </div>
      ))}
    </div>
  );
}
