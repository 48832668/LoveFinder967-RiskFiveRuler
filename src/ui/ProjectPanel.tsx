import type { DeviceDef, PinConflict, Project, ProjectSettings } from "../model/types";
import type { ClockDerived } from "../model/types";
import { SERIES, sdkHeaderOf } from "../devices/index";

interface Props {
  dev: DeviceDef;
  project: Project;
  clock: ClockDerived;
  conflicts: PinConflict[];
  onChange: (s: ProjectSettings) => void;
}

export function ProjectPanel({ dev, project, clock, conflicts, onChange }: Props) {
  const s = project.settings;
  // SDK 头文件名随器件走：L103 是 ch32l103.h，X033 借用 ch32x035.h
  const sdkHeader = sdkHeaderOf(dev);
  const set = (p: Partial<ProjectSettings>) => onChange({ ...s, ...p });

  return (
    <div className="project-panel">
      <header className="panel-head">
        <h2>工程设置</h2>
        <p>工程名、工具链与生成选项。这些设置会写进生成代码的注释与构建脚本。</p>
      </header>

      <section className="psection card">
        <h3>基本</h3>
        <div className="prow">
          <label>工程名</label>
          <input value={s.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="prow">
          <label>作者</label>
          <input value={s.author} onChange={(e) => set({ author: e.target.value })} />
        </div>
        <div className="prow">
          <label>工具链</label>
          <select value={s.toolchain} onChange={(e) => set({ toolchain: e.target.value as ProjectSettings["toolchain"] })}>
            <option value="mrs">MounRiver Studio 工程（.project + .cproject）</option>
            <option value="make">Makefile（命令行 GCC）</option>
            <option value="none">只生成源码</option>
          </select>
        </div>
        <div className="prow">
          <label>SDK</label>
          <select value={s.sdk} onChange={(e) => set({ sdk: e.target.value as ProjectSettings["sdk"] })}>
            <option value="wch-sdk">WCH 官方 SDK（{sdkHeader}.h）</option>
            <option value="bare">裸寄存器</option>
          </select>
        </div>
      </section>

      <section className="psection card">
        <h3>生成选项</h3>
        <label className="field-label">
          <input type="checkbox" checked={s.includeComments} onChange={(e) => set({ includeComments: e.target.checked })} />
          <span>在代码里写寄存器注释</span>
        </label>
        <label className="field-label">
          <input type="checkbox" checked={s.generateIt} onChange={(e) => set({ generateIt: e.target.checked })} />
          <span>生成中断服务函数骨架</span>
        </label>
        <label className="field-label">
          <input type="checkbox" checked={s.generateStartup} onChange={(e) => set({ generateStartup: e.target.checked })} />
          <span>生成启动文件与链接脚本</span>
        </label>
      </section>

      <section className="psection card">
        <h3>原理图绘制</h3>
        <p className="psection-note">（建设中）后续在这里提供原理图绘制相关功能与设置。</p>
      </section>

      <section className="psection card">
        <h3>当前器件</h3>
        <div className="kv">
          <span>型号</span><b>{dev.id}</b>
          <span>家族</span><b>{dev.family}</b>
          <span>内核</span><b>{dev.core}</b>
          <span>封装</span><b>{dev.package.label} · {dev.package.pins.length} 脚</b>
          <span>复位引脚</span><b>{project.resetPin ?? "—"}</b>
          <span>Flash / RAM</span><b>{dev.flashKb} KB / {dev.ramKb} KB</b>
          <span>供电</span><b>{dev.voltage}</b>
          <span>SYSCLK</span><b className={clock.ok ? "" : "bad"}>{clock.sysclk} MHz</b>
        </div>
      </section>

      <section className="psection card">
        <h3>器件包校对</h3>
        <p className="psection-note">
          数据来源：{dev.source}　版本 {dev.packVersion}
        </p>
        {dev.pending?.length ? (
          <ul className="todo-list">
            {dev.pending.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="psection-note">没有待校对项。</p>
        )}
      </section>

      <section className="psection card">
        <h3>诊断</h3>
        {conflicts.length === 0 && clock.errors.length === 0 && (
          <p className="psection-note good">配置无冲突。</p>
        )}
        {clock.errors.map((e) => (
          <div className="diag err" key={e}>✕ {e}</div>
        ))}
        {clock.warnings.map((w) => (
          <div className="diag warn" key={w}>! {w}</div>
        ))}
        {conflicts.map((c) => (
          <div className="diag err" key={`${c.pin}-${c.a.fn}-${c.b.fn}`}>
            ✕ {c.pin} 同时被 {c.a.fn} 与 {c.b.fn} 占用
          </div>
        ))}
      </section>

      <section className="psection card">
        <h3>器件库</h3>
        <div className="catalog">
          {SERIES.map((s) => (
            <div className="catalog-row ready" key={s.id}>
              <div>
                <b>{s.label}</b>
                <span>
                  {s.summary} · {s.parts.map((p) => p.packageLabel).join(" / ")}
                </span>
              </div>
              <em>{s.parts.length} 个型号</em>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
