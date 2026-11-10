/**
 * NVIC 中断配置。
 */
import type { DeviceDef, PeripheralConfig, PeripheralDef } from "../../model/types";

export function NvicTab({ dev, periph, cfg, onChange }: {
  dev: DeviceDef; periph: PeripheralDef; cfg: PeripheralConfig; onChange: (id: string, next: PeripheralConfig) => void;
}) {
  const nvic = cfg.nvic ?? { enabled: false, preempt: 0, sub: 0 };
  const patch = (p: Partial<typeof nvic>) => onChange(periph.id, { ...cfg, nvic: { ...nvic, ...p } });
  const irqs = periph.irq ?? [];

  return (
    <div className="nvic-tab">
      <div className="field-row">
        <label className="field-label">
          <input type="checkbox" checked={nvic.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>使能 NVIC 中断</span>
        </label>
      </div>
      {nvic.enabled && (
        <>
          <div className="field-row">
            <label className="field-label">抢占优先级</label>
            <input type="number" min={0} value={nvic.preempt} onChange={(e) => patch({ preempt: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label className="field-label">子优先级</label>
            <input type="number" min={0} value={nvic.sub} onChange={(e) => patch({ sub: Number(e.target.value) })} />
          </div>
        </>
      )}
      {irqs.length === 0 && <p className="field-hint">该外设没有独立中断向量</p>}
      {irqs.map((irq) => (
        <div className="irq-row" key={irq.name}>
          <span className="irq-n mono">{String(irq.n)}</span>
          <span className="irq-name mono">{irq.name}</span>
        </div>
      ))}
    </div>
  );
}
