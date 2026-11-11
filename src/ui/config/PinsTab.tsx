/**
 * 引脚分配页。
 *
 * grouped（WCH AFIO 整组切换）：一个 select 选组 + 「锁定本组映射」。
 *   混用多个组 → 标记不可用，按组罗列冲突原因。
 *   锁定后其他外设启用时不会自动挪动本外设的引脚，画布上画图钉。
 * independent（HC32 / STM32）：逐引脚独立 AF。
 *
 * 引脚表是**只读**的：改映射只走上面的重映射组（或画布点脚），表里只看结果 ——
 * 信号、状态、引脚、当前复用值（00/01/02…；HC32 显示 AF 编号）。
 */
import { useMemo } from "react";
import type { DeviceDef, PeripheralConfig, PeripheralDef, Project } from "../../model/types";
import {
  assignedGroupOf,
  collectUsage,
  groupPinsFor,
  paramSignals,
  planPins,
  pinTableSignals,
  pinsForSignal,
  remapGroupsOf,
  remapOf,
  requiredInMode,
} from "../../semantic/pinmux";

interface PinsTabProps {
  dev: DeviceDef;
  project: Project;
  periph: PeripheralDef;
  cfg: PeripheralConfig;
  usage: ReturnType<typeof collectUsage>;
  beginner: boolean;
  patch: (p: Partial<PeripheralConfig>) => void;
  onJumpPeripheral: (id: string) => void;
}

export function PinsTab({ dev, project, periph, cfg, usage, beginner, patch, onJumpPeripheral }: PinsTabProps) {
  const grouped = dev.afGrouping === "grouped";
  const live = pinTableSignals(periph);
  const need = useMemo(
    () => new Set([...requiredInMode(periph, cfg.mode, cfg.params), ...paramSignals(periph, cfg.params)]),
    [periph, cfg.mode, cfg.params],
  );
  const pinLive = live.filter((n) => need.has(n));

  const groups = useMemo(
    () => (grouped ? remapGroupsOf(dev, periph, pinLive, cfg.pins, usage, [...need]) : []),
    [grouped, dev, periph, pinLive, cfg.pins, usage, need],
  );
  const curGroup = grouped ? assignedGroupOf(dev, periph, pinLive, cfg.pins) : null;
  const mixed = curGroup === "mixed";

  /** 选组：整组一起落 */
  const pickGroup = (gv: number) => {
    patch({ pins: { ...cfg.pins, ...groupPinsFor(dev, periph, pinLive, gv, cfg.pins, usage) } });
  };
  const autoAssign = () => {
    const plan = planPins(dev, project, periph.id, pinLive, usage);
    if (plan) patch({ pins: { ...cfg.pins, ...plan } });
  };

  const unassigned = pinLive.filter((n) => !cfg.pins[n]);

  return (
    <div className="pins-tab">
      {grouped && (
        <div className="remap-bar">
          <b>重映射组</b>
          <select
            className="form-select"
            value={typeof curGroup === "number" ? String(curGroup) : ""}
            onChange={(e) => e.target.value !== "" && pickGroup(Number(e.target.value))}
          >
            <option value="">— 未分配 —</option>
            {groups.map((g) => {
              const name = g.group === 0 ? "默认功能" : `重映射组 ${g.group}`;
              const suffix = !g.feasible
                ? `（缺 ${g.slots.filter((s) => !s.pin && need.has(s.signal)).map((s) => s.signal).join(" / ")}）`
                : g.conflicts > 0
                  ? `（${g.conflicts} 处占用）`
                  : "";
              return (
                <option key={g.group} value={String(g.group)} disabled={!g.feasible}>
                  {name}{suffix}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {grouped && (
        <div className="lock-row">
          <label className="lock-label">
            <span className="lock-label-text">锁定本组映射</span>
            <label className={`switch ${cfg.locked ? "on" : ""}`}
              title={cfg.locked ? "已锁定：其他外设启用时不会挤动这组脚，点击解除" : "锁定后其他外设启用时不会挤动这组脚"}>
              <input type="checkbox" checked={cfg.locked ?? false} onChange={() => patch({ locked: !cfg.locked })} />
              <span />
            </label>
          </label>
        </div>
      )}

      {grouped && mixed && cfg.enabled && <MixedGroupsNote groups={groups} need={need} />}

      {beginner && (
        <p className="hint-block">
          {grouped
            ? "同一外设的信号必须落在同一组；锁定后其他外设不会挤动这组脚。改组在上方选择。"
            : "每个信号独立选引脚；改引脚在画布上点脚。被占用的引脚会标 ⚠。"}
        </p>
      )}

      <table className="pin-table table-dense">
        <thead>
          <tr><th>信号</th><th>状态</th><th>引脚</th><th>复用</th></tr>
        </thead>
        <tbody>
          {live.map((sig) => {
            const fn = `${periph.id}_${sig}`;
            const cands = pinsForSignal(dev, fn);
            const required = need.has(sig);
            const cur = cfg.pins[sig] ?? "";
            const holder = cur ? usage.find((u) => u.pin === cur && u.owner !== periph.id) : undefined;
            const pinDef = cur ? dev.package.pins.find((p) => p.name === cur) : undefined;
            // 当前复用值：WCH 显示重映射组（00/01/02…），HC32 显示 AF 编号
            const remapText = !cur
              ? "—"
              : grouped
                ? String(remapOf(dev, cur, fn)).padStart(2, "0")
                : (() => {
                    const r = pinDef?.signals?.find((s) => s.fn === fn)?.remap;
                    return r ? `AF${r}` : "默认";
                  })();
            return (
              <tr key={sig} className={!cands.length ? "unavail-row" : !required && !cur ? "standby-row" : ""}>
                <td><span className="sig-name mono">{sig}</span></td>
                <td>
                  {!cands.length && <span className="tag unavail">不可用</span>}
                  {cands.length > 0 && cur && <span className="tag ok">已分配</span>}
                  {cands.length > 0 && !cur && required && <span className="tag err">未分配</span>}
                  {cands.length > 0 && !cur && !required && <span className="muted">可选</span>}
                </td>
                <td className="mono pin-cell">
                  {cur ? `${cur} · pin ${pinDef?.num ?? "?"}` : "—"}
                  {holder && <span className="tag err">⚠ {holder.fn}</span>}
                </td>
                <td className="mono remap-cell">{remapText}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {cfg.enabled && unassigned.length > 0 && (
        <div className="block-note warn">
          <b>{unassigned.length} 条必需信号未分配</b>
          <span className="mono">{unassigned.join(" / ")}</span>
        </div>
      )}

      <div className="pins-actions">
        <button className="btn btn-ghost" onClick={autoAssign}>自动分配</button>
        <button className="btn btn-ghost" onClick={() => patch({ pins: {} })}>全部清空</button>
      </div>
    </div>
  );
}

/** 混组：按组说明为什么放不下 */
function MixedGroupsNote({
  groups, need,
}: {
  groups: ReturnType<typeof remapGroupsOf>;
  need: Set<string>;
}) {
  const rows = groups
    .map((g) => {
      const missing = g.slots.filter((s) => need.has(s.signal) && !s.pin).map((s) => s.signal);
      const held = g.slots.filter((s) => s.pin && s.holder).map((s) => `${s.pin} 被 ${s.holder} 占用`);
      const parts = [...(missing.length ? [`缺 ${missing.join(" / ")}`] : []), ...held];
      return { group: g.group, parts };
    })
    .filter((r) => r.parts.length > 0);
  if (!rows.length) return null;
  return (
    <div className="block-note stack">
      <b>信号落在了不同组，硬件无法同时生效</b>
      <ul className="conflict-list">
        {rows.map((r) => (
          <li key={r.group}>
            <span>{r.group === 0 ? "默认功能" : `组 ${r.group}`}：</span>
            <span>{r.parts.join("；")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
