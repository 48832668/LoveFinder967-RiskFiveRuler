import { useMemo, useState } from "react";
import type { DeviceDef, Project } from "../model/types";
import { backendOf, generate, pinmapOnly } from "../backends/index";

interface Props {
  dev: DeviceDef;
  project: Project;
  onExport: () => void;
}

export function CodePanel({ dev, project, onExport }: Props) {
  /**
   * 资料不足的器件不生成初始化代码。
   *
   * 这里刻意**不**回退到 generic 后端那套 TODO 骨架：既然厂商明确说「先别生成」，
   * 页面上就该只有一句解释 + 一个「导出引脚表」的出口，而不是一堆看着像代码的注释。
   */
  const blocked = !dev.codegenEnabled;
  const files = useMemo(
    () => (blocked ? pinmapOnly(project, dev) : generate(project, dev)),
    [project, dev, blocked],
  );
  const [active, setActive] = useState(files[0]?.path ?? "");
  const current = files.find((f) => f.path === active) ?? files[0];
  const [copied, setCopied] = useState(false);
  const backend = backendOf(dev);
  // 后端自报「不完整」时必须在界面上说清楚，否则用户会以为导出的代码能直接编译
  const partial = !backend.complete && !blocked;

  if (blocked) {
    return (
      <div className="code-panel">
        <header className="panel-head">
          <h2>不生成代码</h2>
          <p>
            {dev.vendor} {dev.family} 目前只录入了引脚与复用功能，未提供初始化代码生成。
          </p>
        </header>

        <div className="code-blocked card">
          <div className="cb-mark">⊘</div>
          <div>
            <b>为什么不能生成</b>
            <p>{dev.codegenNote ?? "该器件缺少寄存器与 SDK 资料，生成的初始化代码只能是编的。"}</p>
            <p className="muted">
              编出来的宏名会「看着对、跑起来不对」，比没有更糟。所以这里只保留
              <strong>引脚映射表</strong> —— 它是纯数据，不含任何寄存器假设，手工移植到任何 SDK 都要用。
            </p>
            <button className="btn btn-primary btn-sm" onClick={onExport}>
              导出引脚映射表（rfr_pinmap.h）
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-panel">
      <header className="panel-head">
        <h2>生成代码</h2>
        <p>
          {partial
            ? `${dev.vendor} ${dev.family} 还没有专用的代码生成后端，这里只输出引脚映射表与 TODO 清单。`
            : `${backend.label} 风格的外设初始化代码。引脚宏、时钟、NVIC 全部来自当前配置。`}
        </p>
      </header>

      {partial && (
        <p className="block-note alert alert-warning code-partial">
          <b>未实现初始化生成</b>
          <span>
            <code>rfr_pinmap.h</code> 是完整可用的引脚表（含每个信号要配的复用组编号）；
            <code>rfr_init.c</code> 只是按当前配置列出的 TODO。
            这样处理是刻意的：宏名写错比留 TODO 危险 —— 那种代码能编译过、运行却不对。
          </span>
        </p>
      )}

      <div className="code-toolbar">
        <div className="file-tabs">
          {files.map((f) => (
            <button key={f.path} className={f.path === active ? "active" : ""} onClick={() => setActive(f.path)}>
              {f.path.split("/").pop()}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(current?.content ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
        <button className="btn btn-primary btn-sm" onClick={onExport}>导出到目录</button>
      </div>

      <div className="code-path">{current?.path}</div>
      <pre className="code-view">
        <code>
          {(current?.content ?? "").split("\n").map((line, i) => (
            <div className="code-line" key={i}>
              <span className="ln">{i + 1}</span>
              <span className={`lc ${lineClass(line)}`}>{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function lineClass(line: string): string {
  const t = line.trim();
  if (t.startsWith("/*") || t.startsWith("*") || t.startsWith("//") || t.startsWith("# ") || t.startsWith("#!")) return "cm";
  if (t.startsWith("#")) return "pp";
  if (/\b(void|int|static|const|if|while|for|return|typedef|struct)\b/.test(t)) return "kw";
  return "";
}
