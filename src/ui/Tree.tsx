import type { DeviceDef, PeripheralDef, Project } from "../model/types";
import { colorOf, peripheralUnavailable } from "../semantic/pinmux";
import { DEVICES } from "../devices/index";
import { collectDma, dmaChannelCount, dmaConflicts } from "../engine/dma";

const GROUP_ORDER: PeripheralDef["group"][] = ["System", "Connectivity", "Timers", "Analog", "Security", "Middleware"];

const GROUP_LABEL: Record<string, string> = {
  System: "系统",
  Connectivity: "通信",
  Timers: "定时器",
  Analog: "模拟",
  Security: "安全",
  Middleware: "中间件",
};

interface Props {
  dev: DeviceDef;
  project: Project;
  selected: string | null;
  onSelect: (id: string) => void;
}

export function Tree({ dev, project, selected, onSelect }: Props) {
  /**
   * 本封装压根没引出的外设不进列表。
   *
   * 以前是在树里打个「不可用」并划掉 —— 但一眼扫过去跟「引脚被别的外设占了」
   * 长得太像，新手会以为是冲突、跑去关别的外设。这类外设换封装才有意义，
   * 所以收进底部一行灰字里说明，不占列表位置。
   *
   * 例外：已经启用过的仍然留在列表里（否则它在树里消失、却还在生成代码，
   * 用户根本找不到地方关掉它）。
   */
  const deadIds = new Set(
    dev.peripherals
      .filter((p) => peripheralUnavailable(dev, p.id) && !project.configs[p.id]?.enabled)
      .map((p) => p.id),
  );
  const shown = dev.peripherals.filter((p) => !deadIds.has(p.id));

  const grouped = new Map<string, PeripheralDef[]>();
  for (const p of shown) {
    const arr = grouped.get(p.group) ?? [];
    arr.push(p);
    grouped.set(p.group, arr);
  }

  const enabledCount = shown.filter((p) => project.configs[p.id]?.enabled).length;
  const unavail = new Set(dev.peripherals.filter((p) => peripheralUnavailable(dev, p.id)).map((p) => p.id));

  // DMA：树节点上直接给出「用了几条 / 共几条」，冲突时标红 —— 作者要的「汇总」
  const dmaAllocs = collectDma(project, dev);
  const dmaTotal = dmaChannelCount(dev);
  const dmaConflictsN = dmaConflicts(dmaAllocs).length;

  const dead = dev.peripherals.filter((p) => peripheralUnavailable(dev, p.id) && !project.configs[p.id]?.enabled);

  /**
   * 把「本封装没引出」和「器件数据本身就缺」分开。
   *
   * 两者在界面上长得一样（都是外设不见了），但原因完全不同：
   *   - 前者是硬件事实，换封装就能用；
   *   - 后者是数据包漏录了某条复用项（例如 V407 的 SPI2_MOSI），换封装也没用，
   *     得回去补器件包。混在一起说「本封装未引出」会让人白费力气去换片子。
   */
  const familyFns = new Set<string>();
  for (const other of DEVICES) {
    if (other.family !== dev.family) continue;
    for (const pin of other.package.pins) for (const s of pin.signals ?? []) familyFns.add(s.fn);
  }
  const missingData = dead.filter((p) => {
    const anyPinned = p.signals.some((s) => familyFns.has(`${p.id}_${s.name}`));
    // 整个系列一条引脚都没有（DAC2），或必需信号在系列里就不存在（USBHS1_DM）
    if (!anyPinned) return true;
    return p.signals.some((s) => s.required && !familyFns.has(`${p.id}_${s.name}`));
  });
  const missingDataIds = new Set(missingData.map((p) => p.id));
  const hiddenInPackage = dead.filter((p) => !missingDataIds.has(p.id));

  return (
    <div className="tree">
      <div className="tree-summary">
        <span>{shown.length} 个外设</span>
        <span className="dot-sep" />
        <span className="on-count">{enabledCount} 已启用</span>
        {dmaConflictsN > 0 && <span className="off-count">{dmaConflictsN} 处 DMA 冲突</span>}
      </div>

      {GROUP_ORDER.filter((g) => grouped.has(g)).map((g) => (
        <div className="tree-group" key={g}>
          <div className="tree-group-title">
            <span>{GROUP_LABEL[g] ?? g}</span>
            <em>{grouped.get(g)!.length}</em>
          </div>
          {grouped.get(g)!.map((p) => {
            const cfg = project.configs[p.id];
            const dead = unavail.has(p.id);
            const on = cfg?.enabled && !dead;
            const active = selected === p.id;
            const isDma = p.kind === "DMA";
            // 定时器分类徽标：带互补通道（CHxN）= 高级，否则通用（简介由 loader 按数据生成）
            const timerBadge =
              p.kind === "TIM" && /^TIM\d+$/.test(p.id)
                ? p.signals.some((s) => /CH\d+N$/.test(s.name))
                  ? "高级"
                  : "通用"
                : null;
            // USB 徽标：USBHSx = 高速(HS)，USB1 = 全速(FS)。USBPD 走 CC 线，不是 PHY，不标。
            const usbBadge =
              p.kind === "USB" && /^USB(?!PD)/.test(p.id)
                ? /^USBHS/.test(p.id)
                  ? "HS"
                  : "FS"
                : null;
            const badge = timerBadge ?? usbBadge;
            return (
              <button
                key={p.id}
                className={`tree-item ${active ? "active" : ""} ${on ? "enabled" : ""} ${dead ? "disabled" : ""}`}
                onClick={() => onSelect(p.id)}
                title={
                  dead
                    ? `${p.label} 在当前封装（${dev.package.label}）上没有可用引脚`
                    : isDma
                      ? `已分配 ${dmaAllocs.length} / ${dmaTotal} 条通道${dmaConflictsN ? `，${dmaConflictsN} 处冲突` : ""}`
                      : p.brief
                }
              >
                <i className="kind-bar" style={{ background: on ? colorOf(p.kind) : "transparent" }} />
                <span
                  className="tree-label"
                  style={cfg?.locked ? { textDecoration: "underline", textUnderlineOffset: "3px" } : undefined}
                >
                  {p.label}
                </span>
                {badge && <span className={`tree-badge ${badge === "高级" || badge === "HS" ? "is-adv" : ""}`}>{badge}</span>}
                {dead && <span className="tree-unavail">不可用</span>}
                {isDma && !dead && (
                  <span className={`tree-dma ${dmaConflictsN ? "bad" : ""}`}>
                    {dmaAllocs.length}/{dmaTotal}
                  </span>
                )}
                {on && <span className="tree-on" style={{ background: colorOf(p.kind) }} />}
              </button>
            );
          })}
        </div>
      ))}

      {hiddenInPackage.length > 0 && (
        <p className="tree-hidden" title="这些外设在这颗封装上没有引出引脚，换更大封装才会出现">
          本封装未引出：{hiddenInPackage.map((p) => p.id).join(" · ")}
        </p>
      )}
      {missingData.length > 0 && (
        <p
          className="tree-hidden data-gap"
          title="器件包缺少这些外设的关键复用项，换封装也没用 —— 需要补录器件数据"
        >
          器件数据待补：{missingData.map((p) => p.id).join(" · ")}
        </p>
      )}
    </div>
  );
}
