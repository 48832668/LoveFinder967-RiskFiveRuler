/**
 * 外设配置面板 —— 主编排器。各子页拆到 config/ 目录下的独立文件。
 */
import { useMemo, useState, useEffect } from "react";
import type { DeviceDef, PeripheralConfig, PeripheralDef, Project } from "../../model/types";
import type { ClockDerived } from "../../model/types";
import { colorOf, collectUsage, isChannelSignal, pinsForSignal, requiredInMode } from "../../semantic/pinmux";
import { schemaFor } from "../../semantic/schemas";
import { applyModePins, applyRelocations, planEnable, planEnableSmart, diagnoseEnable } from "../../semantic/pinmux";
import { DmaOverview, DmaTab } from "./DmaTab";
import { ParamsTab } from "./ParamsTab";
import { PinsTab } from "./PinsTab";
import { ChannelTab } from "./ChannelTab";
import { NvicTab } from "./NvicTab";

type Tab = "params" | "pins" | "channel" | "nvic" | "dma";

interface Props {
  dev: DeviceDef;
  project: Project;
  periph: PeripheralDef;
  clock: ClockDerived;
  pane?: Tab | null;
  onChange: (id: string, next: PeripheralConfig) => void;
  onChangeMany: (next: Record<string, PeripheralConfig>) => void;
  onFree: (id: string) => void;
  onJumpPeripheral: (id: string) => void;
  beginner: boolean;
}

export function ConfigPanel({ dev, project, periph, clock, pane, onChange, onChangeMany, onFree, onJumpPeripheral, beginner }: Props) {
  const schema = schemaFor(periph.schema);
  const cfg = project.configs[periph.id];
  const [tab, setTab] = useState<Tab>(() => {
    const t = pane ?? new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("pane");
    return t === "pins" || t === "channel" || t === "nvic" || t === "dma" ? (t as Tab) : "params";
  });

  useEffect(() => { if (pane) setTab(pane); }, [pane, periph.id]);

  const usage = useMemo(() => collectUsage(project, dev), [project, dev]);
  const plan = useMemo(
    () => (schema && cfg ? planEnable(dev, project, periph, cfg, usage) : null),
    [dev, project, periph, cfg, usage, schema],
  );
  const smart = useMemo(
    () => (schema && cfg && !plan && !cfg.enabled ? planEnableSmart(dev, project, periph, cfg, usage) : null),
    [dev, project, periph, cfg, usage, schema, plan],
  );
  const smartMoves = Boolean(smart && smart.relocations.length > 0);
  const blockers = useMemo(
    () => (schema && cfg && !plan && !smart && !cfg.enabled ? diagnoseEnable(dev, project, periph, cfg, usage) : null),
    [dev, project, periph, cfg, usage, schema, plan, smart],
  );
  const deadRequired = requiredInMode(periph, cfg.mode, cfg.params).filter(
    (s) => pinsForSignal(dev, `${periph.id}_${s}`).length === 0,
  );

  /**
   * 分配落在 BOOT0 职能引脚上的信号：BOOT0 上的电平决定启动模式，
   * 外设把这里当 IO 用，板子上一旦被拉到采样电平就会进错启动模式。
   */
  const bootHits = useMemo(() => {
    if (!cfg.enabled) return [];
    const assigned: { sig: string; pin: string }[] = [];
    for (const [sig, pin] of Object.entries(cfg.pins ?? {})) {
      if (pin) assigned.push({ sig, pin });
    }
    for (const [key, ch] of Object.entries(cfg.channels ?? {})) {
      if (ch.pin) assigned.push({ sig: key, pin: ch.pin });
      if (ch.pinN) assigned.push({ sig: `${key}N`, pin: ch.pinN });
    }
    const bootPins = new Set(dev.package.pins.filter((p) => p.kind === "boot").map((p) => p.name));
    return assigned.filter((a) => bootPins.has(a.pin));
  }, [cfg.enabled, cfg.pins, cfg.channels, dev]);

  const patch = (p: Partial<PeripheralConfig>) => onChange(periph.id, { ...cfg, ...p });
  const setParam = (k: string, v: string | number | boolean) => {
    const next = { ...cfg, params: { ...cfg.params, [k]: v } };
    if (k === (schema?.modeKey ?? "") && cfg.enabled) {
      next.pins = applyModePins(dev, project, periph, next, String(v));
    }
    onChange(periph.id, next);
  };
  const toggle = (on: boolean) => {
    if (!on) { onChange(periph.id, { ...cfg, enabled: false }); return; }
    const chosen = plan ?? smart;
    if (!chosen) return;
    const next: PeripheralConfig = { ...cfg, enabled: true };
    if (schema?.modeKey && chosen.mode) {
      next.mode = chosen.mode;
      next.params = { ...cfg.params, [schema.modeKey]: chosen.mode };
    }
    next.pins = { ...cfg.pins, ...chosen.pins };
    if (smart && smart.relocations.length > 0) {
      onChangeMany({ ...applyRelocations(project, smart.relocations), [periph.id]: next });
      return;
    }
    onChange(periph.id, next);
  };

  if (periph.kind === "DMA") {
    return (
      <div className="cfg">
        <header className="cfg-head">
          <span className="cfg-dot" style={{ background: colorOf(periph.kind) }} />
          <div className="cfg-title"><h2>{periph.label}</h2><p>{periph.brief}</p></div>
        </header>
        {beginner && schema?.about && <p className="cfg-about">{schema.about}</p>}
        <div className="cfg-body"><DmaOverview dev={dev} project={project} /></div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [{ id: "params", label: "参数" }];
  // 有引脚型信号（排除 CHx / INx / LINEx 通道）就给引脚页 —— PIOC（SYSTEM schema）也走这里
  if (periph.signals.some((s) => !isChannelSignal(periph, s.name)))
    tabs.push({ id: "pins", label: "引脚" });
  if (schema?.channelSpec) tabs.push({ id: "channel", label: schema.channelSpec.label });
  tabs.push({ id: "nvic", label: "NVIC" });
  tabs.push({ id: "dma", label: "DMA" });

  return (
    <div className="cfg">
      <header className="cfg-head">
        <span className="cfg-dot" style={{ background: colorOf(periph.kind) }} />
        <div className="cfg-title"><h2>{periph.label}</h2><p>{periph.brief}</p></div>
        <label className={`switch ${cfg.enabled ? "on" : ""}`}
          title={!cfg.enabled && !plan && !smart ? "无法启用" : "启用该外设"}>
          <input type="checkbox" checked={cfg.enabled} disabled={!cfg.enabled && !plan && !smart}
            onChange={(e) => toggle(e.target.checked)} />
          <span />
        </label>
      </header>

      {!cfg.enabled && !plan && smartMoves && smart && (
        <div className="block-note warn">
          <b>可以启用，但需要挪动其它外设的引脚</b>
          <span>
            开启 {periph.id}
            {smart.mode ? `（${smart.mode}）` : ""}，将占用：
          </span>
          <ul className="conflict-list">
            {Object.entries(smart.pins).map(([sig, pin]) => {
              if (!pin) return null;
              const rel = smart.relocations.find((r) => r.from === pin);
              return (
                <li key={sig}>
                  <i style={{ background: colorOf(periph.kind) }} />
                  <span className="mono">
                    {periph.id}_{sig} → <b>{pin}</b>
                  </span>
                  {rel && (
                    <span className="mono">
                      <button className="link mono" onClick={() => onJumpPeripheral(rel.owner)}>
                        {rel.fn}
                      </button>{" "}
                      挪往 {rel.to}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!cfg.enabled && !plan && !smart && (
        <div className="block-note stack">
          <b>无法启用</b>
          {blockers && blockers.length > 0 ? (
            <>
              <span>以下引脚被占用且无法自动挪开：</span>
              <ul className="conflict-list">
                {blockers.map((b) => (
                  <li key={b.owner}>
                    <i style={{ background: colorOf(b.kind) }} />
                    <button className="link mono" onClick={() => onJumpPeripheral(b.owner)}>{b.owner}</button>
                    <span>{b.pins.map((x) => `${x.pin}（${x.fn}）`).join("、")}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => onFree(b.owner)}>关闭 {b.owner}</button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span>当前封装没有引出 <b className="mono">{deadRequired.join(" / ") || "必需信号"}</b>。</span>
          )}
        </div>
      )}

      {beginner && schema?.about && <p className="cfg-about">{schema.about}</p>}

      {bootHits.length > 0 && (
        <div className="block-note warn">
          <b>与 BOOT0 引脚一致</b>
          <span>
            当前外设的 {bootHits.map((h) => `${h.sig}（${h.pin}）`).join("、")}
            {" "}和 BOOT0 引脚一致，请注意上电电平。
          </span>
        </div>
      )}

      <nav className="cfg-tabs nav-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`nav-link ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.badge ? <em className="badge badge-danger">{t.badge}</em> : null}
          </button>
        ))}
      </nav>

      <div className="cfg-body">
        {tab === "params" && schema && (
          <ParamsTab schema={schema} values={cfg.params} mode={cfg.mode} disabled={!cfg.enabled}
            setParam={setParam} periph={periph} clock={clock} cfg={cfg} project={project} dev={dev} beginner={beginner} />
        )}
        {tab === "pins" && (
          <PinsTab dev={dev} project={project} periph={periph} cfg={cfg} usage={usage}
            beginner={beginner} patch={patch} onJumpPeripheral={onJumpPeripheral} />
        )}
        {tab === "channel" && (
          <ChannelTab dev={dev} project={project} periph={periph} cfg={cfg} clock={clock}
            onChange={onChange} beginner={beginner} />
        )}
        {tab === "nvic" && <NvicTab dev={dev} periph={periph} cfg={cfg} onChange={onChange} />}
        {tab === "dma" && <DmaTab dev={dev} project={project} periph={periph} cfg={cfg} onChange={onChange} />}
      </div>
    </div>
  );
}
