import { useState } from "react";
import type { ClockConfig, ClockDerived, ClockTopology } from "../model/types";
import { solveClockForTarget } from "../engine/clock";

interface Props {
  topo: ClockTopology;
  clock: ClockConfig;
  derived: ClockDerived;
  onChange: (next: ClockConfig) => void;
  family: string;
  /** 新手模式：教学说明只在开启时显示 */
  beginner: boolean;
}

export function ClockPanel({ topo, clock, derived, onChange, family, beginner }: Props) {
  const set = (p: Partial<ClockConfig>) => onChange({ ...clock, ...p });
  const hasHse = topo.hseOptions.length > 0;
  const hasPll = topo.pllMax > 1;

  /* ── 一键设定目标频率：源 / 倍频 / 分频全部自动求解 ── */
  const [targetText, setTargetText] = useState("");
  const [applyMsg, setApplyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const applyTarget = () => {
    const v = Number(targetText);
    if (!Number.isFinite(v) || v <= 0) {
      setApplyMsg({ text: "请输入有效频率（MHz）", ok: false });
      return;
    }
    const next = solveClockForTarget(topo, v);
    if (!next) {
      setApplyMsg({ text: "该频率超出可配置范围", ok: false });
      return;
    }
    onChange(next);
    const pllIn = topo.pllSource === "HSI_DIV2" ? topo.hsi / 2 : topo.pllSource === "HSI" ? topo.hsi : next.hseFreq;
    const actual =
      next.sysclkSource === "HSI"
        ? topo.hsi
        : next.sysclkSource === "HSE"
          ? next.hseFreq
          : pllIn * next.pllMul;
    const src =
      next.sysclkSource === "HSI"
        ? `HSI ${topo.hsi} MHz`
        : next.sysclkSource === "HSE"
          ? `HSE ${next.hseFreq} MHz`
          : `PLL ${topo.pllSource === "HSI_DIV2" ? `HSI/2=${topo.hsi / 2}` : topo.pllSource === "HSI" ? `HSI=${topo.hsi}` : `HSE=${next.hseFreq}`} × ${next.pllMul}`;
    setApplyMsg({
      text: `已设定：${src} → SYSCLK ${actual} MHz${actual !== v ? "（最接近的组合）" : ""}`,
      ok: true,
    });
  };

  return (
    <div className="clock-panel">
      <header className="panel-head">
        <h2>时钟树</h2>
        <p>{family} 的时钟源、PLL 与总线分频。修改后所有外设的波特率 / 定时器计算会立刻跟着变。</p>
      </header>

      <div className="clock-target card">
        <b>目标工作频率</b>
        <input
          className="ct-input form-control"
          type="text"
          inputMode="numeric"
          placeholder={`如 ${topo.maxSysclk}`}
          value={targetText}
          onChange={(e) => setTargetText(e.target.value.replace(/[^\d.]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && applyTarget()}
          title="想要的 SYSCLK（MHz），时钟源与倍频自动求解"
        />
        <span className="ct-unit">MHz</span>
        <button className="btn btn-primary btn-sm ct-apply" onClick={applyTarget}>一键设定</button>
        {beginner && (
          <p className="ct-note">
            输入最终工作频率，其余交给软件：时钟源 / 倍频自动挑最接近的组合，HCLK 与 APB 全速，ADC 分频保证 ≤ 14 MHz。
          </p>
        )}
        {applyMsg && <p className={`ct-msg ${applyMsg.ok ? "ok" : "bad"}`}>{applyMsg.text}</p>}
      </div>

      <div className="clock-grid">
        {/* 振荡器列 */}
        <div className="clock-col">
          <div className="clock-col-title">时钟源</div>

          <div className={`clock-node card ${clock.sysclkSource === "HSI" ? "sel" : ""}`}>
            <div className="cn-head">
              <b>HSI</b>
              <span>{topo.hsi} MHz</span>
            </div>
            <p>内部 RC 振荡器，精度 ±1%，无需外部器件</p>
            <button className="link" onClick={() => set({ sysclkSource: "HSI" })}>直接作为 SYSCLK</button>
          </div>

          <div className={`clock-node card ${hasHse ? "" : "off"} ${clock.sysclkSource === "HSE" ? "sel" : ""}`}>
            <div className="cn-head">
              <b>HSE</b>
              <span>{hasHse ? `${clock.hseFreq} MHz` : "该器件无 HSE"}</span>
            </div>
            {hasHse ? (
              <>
                <div className="cn-row">
                  <label>晶振频率</label>
                  <select value={clock.hseFreq} onChange={(e) => set({ hseFreq: Number(e.target.value) })}>
                    {topo.hseOptions.map((f) => (
                      <option key={f} value={f}>{f} MHz</option>
                    ))}
                  </select>
                </div>
                <label className="field-label">
                  <input type="checkbox" checked={clock.hseBypass} onChange={(e) => set({ hseBypass: e.target.checked })} />
                  <span>旁路模式（外部有源晶振）</span>
                </label>
                <button className="link" onClick={() => set({ sysclkSource: "HSE" })}>直接作为 SYSCLK</button>
              </>
            ) : (
              <p className="cn-off">{family} 只有内部 RC，没有外部高速晶振引脚。</p>
            )}
          </div>

          <div className="clock-node card">
            <div className="cn-head">
              <b>LSI</b>
              <span>{topo.lsi} kHz</span>
            </div>
            <p>驱动 IWDG 与 RTC</p>
          </div>
        </div>

        {/* PLL 列 */}
        <div className="clock-col">
          <div className="clock-col-title">PLL</div>
          {!hasPll ? (
            <div className="clock-node off">
              <div className="cn-head">
                <b>PLL</b>
                <span>该器件无 PLL</span>
              </div>
              <p className="cn-off">
                {family} 的 SYSCLK 直接取自内部 RC（最高 {topo.maxSysclk} MHz），没有倍频环节。
              </p>
            </div>
          ) : (
          <div className={`clock-node card ${clock.sysclkSource === "PLL" ? "sel" : ""}`}>
            <div className="cn-head">
              <b>PLL</b>
              <span>{derived.pllOut ? `${derived.pllOut} MHz` : "—"}</span>
            </div>
            <div className="cn-row">
              <label>输入</label>
              <span className="mono">
                {topo.pllSource === "HSI_DIV2" ? `HSI / 2 = ${topo.hsi / 2} MHz` : topo.pllSource === "HSI" ? `HSI = ${topo.hsi} MHz` : `HSE = ${clock.hseFreq} MHz`}
              </span>
            </div>
            <div className="cn-row">
              <label>倍频</label>
              <select value={clock.pllMul} onChange={(e) => set({ pllMul: Number(e.target.value) })}>
                {Array.from({ length: topo.pllMax - topo.pllMin + 1 }, (_, i) => topo.pllMin + i).map((m) => (
                  <option key={m} value={m}>×{m}</option>
                ))}
              </select>
            </div>
            <p className="cn-note">
              {derived.pllIn > 0
                ? <>{derived.pllIn} MHz × {clock.pllMul} = <b>{derived.pllOut} MHz</b></>
                : "PLL 输入无效（HSE 未选择），无法倍频"}
            </p>
            {clock.sysclkSource === "PLL" ? (
              <p className="cn-out">当前 SYSCLK 来源</p>
            ) : (
              <button className="link" onClick={() => set({ sysclkSource: "PLL" })}>作为 SYSCLK</button>
            )}
          </div>
          )}
        </div>

        {/* 总线列 */}
        <div className="clock-col wide">
          <div className="clock-col-title">系统时钟与总线</div>

          <div className="clock-node sys">
            <div className="cn-head">
              <b>SYSCLK</b>
              <span className={derived.sysclk > topo.maxSysclk ? "bad" : "good"}>{derived.sysclk} MHz</span>
            </div>
            <div className="cn-row">
              <label>来源</label>
              <select value={clock.sysclkSource} onChange={(e) => set({ sysclkSource: e.target.value as ClockConfig["sysclkSource"] })}>
                <option value="HSI">HSI</option>
                {hasHse && <option value="HSE">HSE</option>}
                {hasPll && <option value="PLL">PLL</option>}
              </select>
            </div>
            <div className="cn-row">
              <label>AHB 分频</label>
              <select value={clock.ahbDiv} onChange={(e) => set({ ahbDiv: Number(e.target.value) })}>
                {topo.ahbDivs.map((d) => (
                  <option key={d} value={d}>/ {d}</option>
                ))}
              </select>
            </div>
            <div className="cn-out">
              HCLK = <b>{derived.hclk} MHz</b>
            </div>
          </div>

          <div className="clock-buses">
            <div className="clock-node card">
              <div className="cn-head">
                <b>APB1 · PCLK1</b>
                <span>{derived.pclk1} MHz</span>
              </div>
              <div className="cn-row">
                <label>分频</label>
                <select value={clock.apb1Div} onChange={(e) => set({ apb1Div: Number(e.target.value) })}>
                  {topo.apb1Divs.map((d) => (
                    <option key={d} value={d}>/ {d}</option>
                  ))}
                </select>
              </div>
              <p className="cn-note">I2C1 · 定时器基准 · 看门狗</p>
            </div>

            <div className="clock-node card">
              <div className="cn-head">
                <b>APB2 · PCLK2</b>
                <span>{derived.pclk2} MHz</span>
              </div>
              <div className="cn-row">
                <label>分频</label>
                <select value={clock.apb2Div} onChange={(e) => set({ apb2Div: Number(e.target.value) })}>
                  {topo.apb2Divs.map((d) => (
                    <option key={d} value={d}>/ {d}</option>
                  ))}
                </select>
              </div>
              <p className="cn-note">USART1 · SPI1 · TIM1</p>
            </div>

            <div className="clock-node card">
              <div className="cn-head">
                <b>ADCCLK</b>
                <span className={derived.adcclk > 14 ? "bad" : "good"}>{derived.adcclk} MHz</span>
              </div>
              <div className="cn-row">
                <label>分频</label>
                <select value={clock.adcDiv} onChange={(e) => set({ adcDiv: Number(e.target.value) })}>
                  {(topo.adcDivs ?? [2, 4, 6, 8]).map((d) => (
                    <option key={d} value={d}>/ {d}</option>
                  ))}
                </select>
              </div>
              <p className="cn-note">上限 14 MHz</p>
            </div>
          </div>
        </div>
      </div>

      {(derived.errors.length > 0 || derived.warnings.length > 0) && (
        <div className="clock-diag">
          {derived.errors.map((e) => (
            <div className="diag err" key={e}>✕ {e}</div>
          ))}
          {derived.warnings.map((w) => (
            <div className="diag warn" key={w}>! {w}</div>
          ))}
        </div>
      )}

      {topo.notes && (
        <div className="clock-notes">
          <div className="clock-notes-title">该系列时钟要点</div>
          <ul>
            {topo.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
