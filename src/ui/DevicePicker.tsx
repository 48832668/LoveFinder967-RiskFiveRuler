/**
 * 器件选择：上半部分筛选 + 联想，下半部分「系列 / 型号 / 资源」三栏。
 *
 * 点型号卡片只是「选中」并把资源表切过去，**不会立刻换器件** ——
 * 只有点「确定」或双击卡片才真正应用，避免误点把工程配置清掉。
 *
 * 拆分：筛选区在 picker/FilterBar.tsx，资源栏在 picker/ResourcePanel.tsx；
 * 这里只保留选择状态（系列 / 选中型号 / 查询）与「系列 / 型号」两栏。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DEVICE_MAP, SERIES, type DeviceSeries } from "../devices/index";
import { deviceResources } from "../app/resources";
import type { DeviceQuery, PartHit } from "../app/deviceFilter";
import { countBySeries, emptyQuery, filterParts, queryIsEmpty } from "../app/deviceFilter";
import { FilterBar } from "./picker/FilterBar";
import { ResourcePanel } from "./picker/ResourcePanel";

interface Props {
  current: string;
  onPick: (deviceId: string) => void;
  onClose: () => void;
  /**
   * new = 新建工程（不预选型号、可新建同型号工程）；
   * switch = 更换器件（预选当前型号、不允许选回自己）。
   * 两者共用同一套筛选 / 联想 / 资源界面。
   */
  mode?: "new" | "switch";
}

const ALL_SERIES = "__all__";

export function DevicePicker({ current, onPick, onClose, mode = "switch" }: Props) {
  const isNew = mode === "new";
  const currentSeries = useMemo(
    () => SERIES.find((s) => s.parts.some((p) => p.id === current))?.id ?? SERIES[0]?.id ?? "",
    [current],
  );
  const [seriesId, setSeriesId] = useState(currentSeries);
  // 新建工程不预选型号：型号必须由用户自己挑，而不是一打开就替他定好
  const [picked, setPicked] = useState<string | null>(isNew ? null : current);
  const [query, setQuery] = useState<DeviceQuery>(emptyQuery);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** 全库按条件筛一遍；左侧系列计数、右侧联想、型号列表都从这一个结果派生 */
  const hits = useMemo(() => filterParts(SERIES, DEVICE_MAP, query), [query]);
  const perSeries = useMemo(() => countBySeries(hits), [hits]);
  const visibleSeries = useMemo(
    () => SERIES.filter((s) => (perSeries[s.id] ?? 0) > 0),
    [perSeries],
  );

  /** 当前系列下可见的型号；选「全部」时列出所有命中 */
  const parts = useMemo(() => {
    const list = seriesId === ALL_SERIES ? hits : hits.filter((h) => h.series.id === seriesId);
    return list.map((h) => h.part);
  }, [hits, seriesId]);

  /** 搜索联想：按型号 id 优先，最多 8 条 */
  const suggestions = useMemo<PartHit[]>(() => {
    if (!query.text.trim()) return [];
    return hits.slice(0, 8);
  }, [hits, query.text]);

  const dev = picked ? DEVICE_MAP[picked] : undefined;
  const groups = useMemo(() => (dev ? deviceResources(dev) : []), [dev]);

  // 筛选条件变化后，若当前系列 / 选中型号已被筛掉，自动落到第一个命中项
  useEffect(() => {
    if (hits.length === 0) {
      if (picked !== null) setPicked(null);
      return;
    }
    if (seriesId !== ALL_SERIES && !visibleSeries.some((s) => s.id === seriesId)) {
      setSeriesId(visibleSeries[0]?.id ?? ALL_SERIES);
    }
    if (picked && !hits.some((h) => h.part.id === picked)) {
      setPicked(null);
    }
  }, [hits, visibleSeries, seriesId, picked]);

  const confirm = () => {
    if (picked) onPick(picked);
  };

  const jumpTo = (hit: PartHit) => {
    setSeriesId(hit.series.id);
    setPicked(hit.part.id);
    setSuggestOpen(false);
    setSearchFocused(false);
    searchRef.current?.blur();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (suggestOpen) {
          e.preventDefault();
          setSuggestOpen(false);
          return;
        }
        if (searchFocused && query.text) {
          e.preventDefault();
          setQuery((q) => ({ ...q, text: "" }));
          return;
        }
        e.preventDefault();
        onClose();
        return;
      }
      // 输入框聚焦时把方向键 / 回车留给联想列表，不抢去翻型号
      if (searchFocused) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const i = parts.findIndex((p) => p.id === picked);
        const next = parts[Math.min(i + 1, parts.length - 1)];
        if (next) setPicked(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const i = parts.findIndex((p) => p.id === picked);
        const next = parts[Math.max(i - 1, 0)];
        if (next) setPicked(next.id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 键盘移动选中项时把卡片滚进视野
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".part-row.picked")?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  const series: DeviceSeries | undefined = SERIES.find((s) => s.id === seriesId);
  const hasFilter = !queryIsEmpty(query);

  return (
    <div className="modal">
      <div className="modal-dialog device-modal" role="dialog" aria-label="选择器件">
        <header className="modal-header device-head">
          <div>
            <h2 className="modal-title">{isNew ? "新建工程 · 选择器件" : "更换器件"}</h2>
            <p>
              {isNew
                ? "先按内核 / 外设条件筛选，或搜索型号，选定后创建空白工程。"
                : "先筛再选：点型号只看资源，按「确定」才真正切换。"}
            </p>
          </div>
          <button className="btn btn-icon btn-sm" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </header>

        {/* ── 上半部分：筛选 + 实时联想 ── */}
        <FilterBar
          query={query}
          setQuery={setQuery}
          hitCount={hits.length}
          totalCount={SERIES.reduce((n, s) => n + s.parts.length, 0)}
          suggestions={suggestions}
          suggestOpen={suggestOpen}
          setSuggestOpen={setSuggestOpen}
          searchFocused={searchFocused}
          setSearchFocused={setSearchFocused}
          searchRef={searchRef}
          picked={picked}
          jumpTo={jumpTo}
        />

        <div className="device-modal-body">
          <nav className="series-list">
            <button
              className={`series-item ${seriesId === ALL_SERIES ? "active" : ""}`}
              onClick={() => setSeriesId(ALL_SERIES)}
            >
              <b>全部系列</b>
              <span>{hits.length} 个命中型号</span>
            </button>
            {visibleSeries.length === 0 && <div className="series-empty">没有匹配的系列</div>}
            {visibleSeries.map((s) => (
              <button
                key={s.id}
                className={`series-item ${s.id === seriesId ? "active" : ""}`}
                onClick={() => {
                  setSeriesId(s.id);
                  // new 模式不替用户预选：只把选中项清成「还没选」
                  if (isNew) {
                    setPicked(null);
                  } else {
                    const cur = s.parts.find((p) => p.id === current);
                    const first = hits.find((h) => h.series.id === s.id);
                    setPicked(cur?.id ?? first?.part.id ?? null);
                  }
                }}
              >
                <b>{s.label}</b>
                <span>
                  {s.vendor} · {perSeries[s.id]} / {s.parts.length} 个型号
                </span>
              </button>
            ))}
          </nav>

          <div className="part-list" ref={listRef}>
            {series && (
              <div className="part-series-head">
                <div>
                  <b>{series.label}</b>
                  <span>
                    {series.vendor} · {series.core}
                  </span>
                </div>
                <em>{series.summary}</em>
              </div>
            )}
            <div className="part-rows">
              {parts.length === 0 && <div className="part-empty">没有符合条件的型号</div>}
              {parts.map((p) => (
                <button
                  key={p.id}
                  className={`part-row ${p.id === picked ? "picked" : ""}`}
                  onClick={() => setPicked(p.id)}
                  onDoubleClick={() => onPick(p.id)}
                  title="单击查看资源，双击直接确定"
                >
                  <span className="pr-name">{p.id}</span>
                  {seriesId === ALL_SERIES && (
                    <span className="pr-series">{hits.find((h) => h.part.id === p.id)?.series.label}</span>
                  )}
                  <span className="pr-pkg">{p.packageLabel}</span>
                  <span className="pr-pins">{p.pins} 脚</span>
                  {!isNew && p.id === current && <span className="tag ok">当前</span>}
                </button>
              ))}
            </div>
          </div>

          <ResourcePanel dev={dev} groups={groups} isNew={isNew} />
        </div>

        <footer className="modal-footer device-foot">
          <span className="hint">
            {isNew ? "选定型号后创建空白工程" : "↑↓ 选择 · Enter 确定 · Esc 取消 · 双击卡片直接切换"}
            {hasFilter ? " · 已应用筛选" : ""}
          </span>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!picked || (!isNew && picked === current)}
            onClick={confirm}
            title={!picked ? "请先选一个型号" : isNew ? `以 ${picked} 新建工程` : `切换到 ${picked}`}
          >
            {isNew ? "创建工程" : picked === current ? "当前器件" : "确定"}
          </button>
        </footer>
      </div>
    </div>
  );
}
