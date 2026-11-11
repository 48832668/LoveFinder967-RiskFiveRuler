/**
 * EXTI 面板。
 *
 * EXTI 不是一个「可以开关的外设」——它只是把画布上配成 EXTIn 的引脚汇总起来，
 * 让用户逐条设置触发边沿（上升 / 下降 / 双边）。没有总开关：
 * 在引脚图上给某颗 PXn 选 EXTIn 就会自动出现在这里。
 */
import type { DeviceDef, PeripheralConfig, PeripheralDef } from "../../model/types";
import { schemaFor } from "../../semantic/schemas";

interface Props {
  dev: DeviceDef;
  periph: PeripheralDef;
  cfg: PeripheralConfig;
  onChange: (id: string, next: PeripheralConfig) => void;
  beginner: boolean;
}

export function ExtiPanel({ dev, periph, cfg, onChange, beginner }: Props) {
  const spec = schemaFor(periph.schema)?.channelSpec;
  const modes = (spec?.modes ?? []).filter((m) => m.value !== "disable");
  const chans = cfg.channels ?? {};

  const lineNum = (key: string) => Number(key.replace(/\D+/g, "")) || 0;
  const rows = Object.entries(chans)
    .filter(([, c]) => c && c.pin)
    .sort((a, b) => lineNum(a[0]) - lineNum(b[0]));

  const writeChans = (next: typeof chans) => {
    const anyOn = Object.values(next).some((c) => c && c.enabled && c.pin);
    onChange(periph.id, { ...cfg, channels: next, enabled: anyOn });
  };

  const setEdge = (key: string, mode: string) => {
    const c = chans[key];
    if (!c) return;
    writeChans({ ...chans, [key]: { ...c, mode, enabled: mode !== "disable" } });
  };

  const remove = (key: string) => {
    const c = chans[key];
    if (!c) return;
    writeChans({ ...chans, [key]: { ...c, enabled: false, pin: null, mode: "disable" } });
  };

  const pinOf = (name: string | null | undefined) =>
    dev.package.pins.find((p) => p.name === name);

  return (
    <div className="exti-panel">
      {beginner && (
        <p className="hint-block">
          这里汇总画布上已配成 EXTI 的引脚：在引脚图上点某颗 PXn 选 EXTIn 就会出现在下表。
          每条线可单独设置触发边沿。
        </p>
      )}
      {rows.length === 0 ? (
        <p className="hint-block">
          还没有 EXTI 中断引脚 —— 在引脚图上点 PXn 选择 EXTIn 即可加入。
        </p>
      ) : (
        <table className="pin-table table-dense exti-table">
          <thead>
            <tr><th>中断线</th><th>引脚</th><th>触发边沿</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(([key, c]) => {
              const pin = pinOf(c.pin);
              return (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">
                    {c.pin} · pin {pin?.num ?? "?"}
                  </td>
                  <td>
                    <select className="form-select" value={c.mode ?? "disable"} onChange={(e) => setEdge(key, e.target.value)}>
                      {modes.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(key)} title="从 EXTI 移除该引脚">
                      移除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
