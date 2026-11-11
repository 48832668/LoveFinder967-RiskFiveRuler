/**
 * DMA 分配页 + 汇总。
 */
import { useMemo } from "react";
import type { DeviceDef, PeripheralConfig, PeripheralDef, Project } from "../../model/types";
import {
  collectDma,
  defaultDmaChannel,
  dmaChannelCount,
  dmaConflicts,
  dmaRequestsOf,
  formatDmaChannel,
  freeChannels,
  usedChannels,
} from "../../engine/dma";

export function DmaOverview({ dev, project }: { dev: DeviceDef; project: Project }) {
  const allocs = useMemo(() => collectDma(project, dev), [project, dev]);
  const conflicts = useMemo(() => dmaConflicts(allocs), [allocs]);
  const total = dmaChannelCount(dev);
  if (!total) return <p className="hint-block">该系列没有通用 DMA 控制器。</p>;

  return (
    <div className="dma-overview">
      <div className="dma-stats">
        <div className="dma-stat card"><span>已用通道</span><b>{allocs.length}<em> / {total}</em></b></div>
        <div className="dma-stat card"><span>空闲</span><b>{total - allocs.length}</b></div>
        <div className={`dma-stat card${conflicts.length ? " bad" : ""}`}><span>冲突</span><b>{conflicts.length}</b></div>
      </div>
      <div className="dma-strip">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const a = allocs.find((x) => x.channel === n);
          return (
            <div key={n} className={`dma-cell ${a ? "on" : ""}`} title={a ? `${a.owner} · ${a.request}` : "空闲"}>
              <span>{formatDmaChannel(dev, n)}</span>
              <em>{a ? a.owner : "—"}</em>
            </div>
          );
        })}
      </div>
      {conflicts.length > 0 && (
        <div className="dma-note alert alert-danger">
          {conflicts.map((c) => (
            <div key={`${c.channel}-${c.a.owner}-${c.b.owner}`}>
              {formatDmaChannel(dev, c.channel)} 同时被 {c.a.owner} 与 {c.b.owner} 占用
            </div>
          ))}
        </div>
      )}
      {allocs.length > 0 && (
        <table className="table-dense dma-table">
          <thead><tr><th>通道</th><th>外设</th><th>请求</th><th>方向</th></tr></thead>
          <tbody>
            {allocs.map((a) => (
              <tr key={`${a.owner}-${a.request}`}>
                <td className="mono">{formatDmaChannel(dev, a.channel)}</td>
                <td>{a.owner}</td>
                <td className="mono">{a.request}</td>
                <td>{a.dir === "p2m" ? "外设→内存" : "内存→外设"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DmaTab({ dev, project, periph, cfg, onChange, beginner }: {
  dev: DeviceDef; project: Project; periph: PeripheralDef; cfg: PeripheralConfig;
  onChange: (id: string, next: PeripheralConfig) => void; beginner: boolean;
}) {
  const allocs = useMemo(() => collectDma(project, dev), [project, dev]);
  const requests = useMemo(() => dmaRequestsOf(dev, periph), [dev, periph]);
  const mine = cfg.dmaChannels ?? [];
  const total = dmaChannelCount(dev);
  if (total === 0) return <p className="hint-block">该系列没有通用 DMA 控制器。</p>;

  const used = usedChannels(allocs);
  const rest = requests.filter((r) => !mine.some((m) => m.request === r.name));

  const add = (request: string) => {
    const r = requests.find((x) => x.name === request);
    if (!r) return;
    const d = defaultDmaChannel(dev, allocs, request, r.dir, periph.id);
    if (!d) return;
    onChange(periph.id, { ...cfg, dmaChannels: [...mine, d] });
  };
  const remove = (request: string) =>
    onChange(periph.id, { ...cfg, dmaChannels: mine.filter((m) => m.request !== request) });
  const patchCh = (i: number, p: Partial<(typeof mine)[number]>) => {
    const next = [...mine];
    next[i] = { ...next[i]!, ...p };
    onChange(periph.id, { ...cfg, dmaChannels: next });
  };

  return (
    <div className="dma-tab">
      <div className="dma-head-row">
        {beginner && <span>本外设可发出 <b>{requests.length}</b> 个 DMA 请求，已占 <b>{mine.length}</b> 条通道</span>}
        {rest.length > 0 && (
          <select className="dma-add form-select" value="" onChange={(e) => e.target.value && add(e.target.value)}>
            <option value="">＋ 添加 DMA 请求</option>
            {rest.map((r) => <option key={r.name} value={r.name}>{r.label}（{r.name}）</option>)}
          </select>
        )}
      </div>
      {mine.map((d, i) => {
        const taken = allocs.find((a) => a.channel === d.channel && a.owner !== periph.id);
        const legal = freeChannels(dev, allocs.filter((a) => a.owner === periph.id));
        return (
          <section className="dma-card card" key={d.request}>
            <header>
              <b className="mono">{d.request}</b>
              <span className="dma-dir">{d.dir === "p2m" ? "外设→内存" : "内存→外设"}</span>
              <button className="btn btn-danger btn-sm" onClick={() => remove(d.request)}>删除</button>
            </header>
            <div className="dma-fields">
              <div className="field">
                <div className="field-row">
                  <label className="field-label">通道</label>
                  <select value={String(d.channel)} onChange={(e) => patchCh(i, { channel: Number(e.target.value) })}>
                    {Array.from({ length: total }, (_, x) => x + 1)
                      .filter((x) => x === d.channel || legal.includes(x))
                      .map((x) => <option key={x} value={x}>{formatDmaChannel(dev, x)}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <div className="field-row">
                  <label className="field-label">优先级</label>
                  <select value={d.priority} onChange={(e) => patchCh(i, { priority: e.target.value as "low" | "medium" | "high" | "veryhigh" })}>
                    <option value="low">低</option><option value="medium">中</option>
                    <option value="high">高</option><option value="veryhigh">很高</option>
                  </select>
                </div>
              </div>
              {taken && <span className="tag err">⚠ {taken.owner} 占用</span>}
            </div>
          </section>
        );
      })}
      {mine.length === 0 && beginner && <p className="hint-block">还没有分配 DMA。收发两条可以同时开（各占一条通道），也可以只开一条。</p>}
    </div>
  );
}
