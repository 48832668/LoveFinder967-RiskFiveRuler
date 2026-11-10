/**
 * 器件选择器的筛选区：搜索 + 联想、内核 / 主频 / 外设 / USB 进阶、已设条件行。
 *
 * 从 DevicePicker.tsx 拆出 —— 这里只管「把用户点的东西写进 query」，
 * 筛选结果与三栏列表留在主组件。所有 toggle / 区间操作只通过 setQuery 落笔。
 */
import { CORE_KINDS, PERIPH_FACETS, emptyQuery, rangeLabel } from "../../app/deviceFilter";
import type { CoreKind, CountRange, DeviceQuery, PartHit, UsbRoleFilter, UsbSpeedFilter } from "../../app/deviceFilter";

interface Props {
  query: DeviceQuery;
  setQuery: (fn: (q: DeviceQuery) => DeviceQuery) => void;
  /** 全库命中数（顶部「命中 n / m」用） */
  hitCount: number;
  totalCount: number;
  /** 搜索联想（最多 8 条） */
  suggestions: PartHit[];
  suggestOpen: boolean;
  setSuggestOpen: (v: boolean) => void;
  searchFocused: boolean;
  setSearchFocused: (v: boolean) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  picked: string | null;
  jumpTo: (hit: PartHit) => void;
  /** 点联想项 / 清空搜索后立即落到该型号 */
}

export function FilterBar({
  query,
  setQuery,
  hitCount,
  totalCount,
  suggestions,
  suggestOpen,
  setSuggestOpen,
  searchFocused,
  setSearchFocused,
  searchRef,
  picked,
  jumpTo,
}: Props) {
  const toggleCore = (c: CoreKind) => {
    setQuery((q) => ({
      ...q,
      cores: q.cores.includes(c) ? q.cores.filter((x) => x !== c) : [...q.cores, c],
    }));
  };

  /** chip 点击 = 加一条「至少 1 个」；再点移除。精确区间在下面的条件行里改 */
  const toggleFacet = (key: string) => {
    setQuery((q) => {
      const ranges = { ...q.ranges };
      if (ranges[key]) {
        delete ranges[key];
        // 去掉 USB 维度时，进阶条件也一起清掉，避免留下看不见的筛选
        if (key === "USB") return { ...q, ranges, usbSpeeds: [], usbRole: null };
      } else {
        ranges[key] = { min: 1, max: null };
      }
      return { ...q, ranges };
    });
  };

  const toggleUsbSpeed = (s: UsbSpeedFilter) => {
    setQuery((q) => ({
      ...q,
      usbSpeeds: q.usbSpeeds.includes(s) ? q.usbSpeeds.filter((x) => x !== s) : [...q.usbSpeeds, s],
    }));
  };

  const setRange = (key: string, patch: Partial<CountRange>) => {
    setQuery((q) => {
      const cur = q.ranges[key] ?? { min: 1, max: null };
      return { ...q, ranges: { ...q.ranges, [key]: { ...cur, ...patch } } };
    });
  };

  const removeRange = (key: string) => {
    setQuery((q) => {
      const ranges = { ...q.ranges };
      delete ranges[key];
      if (key === "USB") return { ...q, ranges, usbSpeeds: [], usbRole: null };
      return { ...q, ranges };
    });
  };

  const activeRanges = Object.entries(query.ranges);
  const hasFilter =
    query.text.trim() !== "" ||
    query.cores.length > 0 ||
    query.freqMin !== null ||
    query.freqMax !== null ||
    query.usbSpeeds.length > 0 ||
    query.usbRole !== null ||
    activeRanges.length > 0;

  return (
    <div className="device-filter">
      <div className="df-search-row">
        <div className="df-search">
          <span className="df-search-icon">⌕</span>
          <input
            ref={searchRef}
            value={query.text}
            placeholder="搜索型号 / 系列 / 厂商 / 内核，如 V407、USB PD、M4…"
            onChange={(e) => {
              setQuery((q) => ({ ...q, text: e.target.value }));
              setSuggestOpen(true);
            }}
            onFocus={() => {
              setSearchFocused(true);
              if (query.text.trim()) setSuggestOpen(true);
            }}
            onBlur={() => {
              setSearchFocused(false);
              // 延迟关闭，让联想项的 mousedown 先触发
              window.setTimeout(() => setSuggestOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSuggestOpen(true);
              } else if (e.key === "Enter" && suggestOpen && suggestions.length) {
                e.preventDefault();
                jumpTo(suggestions[0]!);
              }
            }}
          />
          {query.text && (
            <button
              className="df-search-clear"
              title="清空搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setQuery((q) => ({ ...q, text: "" }))}
            >
              ✕
            </button>
          )}
          {suggestOpen && query.text.trim() && (
            <div className="df-suggest">
              {suggestions.length === 0 ? (
                <div className="df-suggest-empty">没有匹配的型号</div>
              ) : (
                suggestions.map((h) => (
                  <button
                    key={h.part.id}
                    className={`df-suggest-item${picked === h.part.id ? " cur" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      jumpTo(h);
                    }}
                  >
                    <b className="mono">{h.part.id}</b>
                    <span>
                      {h.series.label} · {h.part.packageLabel} · {h.part.pins} 脚
                    </span>
                    <em>{h.series.vendor}</em>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          disabled={!hasFilter}
          onClick={() => {
            setQuery(() => emptyQuery());
            setSuggestOpen(false);
          }}
        >
          清空筛选
        </button>
        <span className="df-count">
          命中 <b>{hitCount}</b> / {totalCount} 个型号
        </span>
      </div>

      <div className="df-line">
        <span className="df-label">内核</span>
        <div className="df-chips">
          <button
            className={`df-chip chip is-clickable${query.cores.length === 0 ? " is-active" : ""}`}
            onClick={() => setQuery((q) => ({ ...q, cores: [] }))}
          >
            不限
          </button>
          {CORE_KINDS.map((c) => (
            <button
              key={c}
              className={`df-chip chip is-clickable${query.cores.includes(c) ? " is-active" : ""}`}
              onClick={() => toggleCore(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 主频区间：最低 / 最高（MHz），空 = 不限 */}
      <div className="df-line">
        <span className="df-label">主频</span>
        <div className="df-freq">
          <label>
            最低
            <input
              type="number"
              min={0}
              step={1}
              placeholder="不限"
              value={query.freqMin ?? ""}
              onChange={(e) =>
                setQuery((q) => ({
                  ...q,
                  freqMin: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                }))
              }
            />
            MHz
          </label>
          <label>
            最高
            <input
              type="number"
              min={0}
              step={1}
              placeholder="不限"
              value={query.freqMax ?? ""}
              onChange={(e) =>
                setQuery((q) => ({
                  ...q,
                  freqMax: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                }))
              }
            />
            MHz
          </label>
          <div className="df-presets">
            {[48, 96, 144, 200].map((v) => (
              <button
                key={v}
                className="link"
                onClick={() => setQuery((q) => ({ ...q, freqMin: v, freqMax: null }))}
                title={`主频 ≥ ${v} MHz`}
              >
                ≥{v}
              </button>
            ))}
          </div>
          {(query.freqMin !== null || query.freqMax !== null) && (
            <button
              className="link"
              onClick={() => setQuery((q) => ({ ...q, freqMin: null, freqMax: null }))}
            >
              不限
            </button>
          )}
        </div>
      </div>

      <div className="df-line">
        <span className="df-label">外设</span>
        <div className="df-chips">
          {PERIPH_FACETS.map((f) => {
            const r = query.ranges[f.key];
            return (
              <button
                key={f.key}
                className={`df-chip chip is-clickable${r ? " is-active" : ""}`}
                title={r ? `${f.label} ${rangeLabel(r)}（点击取消）` : `要求具备 ${f.label}（点击添加）`}
                onClick={() => toggleFacet(f.key)}
              >
                {f.label}
                {r && <em>{rangeLabel(r)}</em>}
              </button>
            );
          })}
        </div>
      </div>

      {/* USB 进阶：只有勾了 USB 维度才展开。速度可多选，角色用 select 单选 */}
      {query.ranges.USB && (
        <div className="df-line">
          <span className="df-label">USB</span>
          <div className="df-usb">
            <div className="df-chips">
              {(["fs", "hs"] as const).map((s) => (
                <button
                  key={s}
                  className={`df-chip chip is-clickable${query.usbSpeeds.includes(s) ? " is-active" : ""}`}
                  onClick={() => toggleUsbSpeed(s)}
                  title={`要求支持 USB ${s.toUpperCase()}`}
                >
                  USB {s.toUpperCase()}
                </button>
              ))}
            </div>
            <select
              className="form-select df-usb-role"
              value={query.usbRole ?? ""}
              title="USB 角色"
              onChange={(e) =>
                setQuery((q) => ({
                  ...q,
                  usbRole: (e.target.value || null) as UsbRoleFilter | null,
                }))
              }
            >
              <option value="">全部角色</option>
              <option value="device">USB DEVICE</option>
              <option value="host">USB HOST</option>
              <option value="dualrole">USB DUALROLE</option>
            </select>
          </div>
        </div>
      )}

      {activeRanges.length > 0 && (
        <div className="df-ranges">
          <span className="df-label">数量</span>
          <div className="df-range-list">
            {activeRanges.map(([key, r]) => (
              <div className="df-range" key={key}>
                <b>{PERIPH_FACETS.find((f) => f.key === key)?.label ?? key}</b>
                <label>
                  最少
                  <input
                    type="number"
                    min={0}
                    value={r.min}
                    onChange={(e) =>
                      setRange(key, { min: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <label>
                  最多
                  <input
                    type="number"
                    min={0}
                    placeholder="不限"
                    value={r.max ?? ""}
                    onChange={(e) =>
                      setRange(key, {
                        max: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                      })
                    }
                  />
                </label>
                <div className="df-presets">
                  <button
                    className="link"
                    onClick={() => setRange(key, { min: 1, max: 1 })}
                    title="必须有且只有 1 个"
                  >
                    仅 1
                  </button>
                  <button
                    className="link"
                    onClick={() => setRange(key, { min: 2, max: null })}
                    title="至少 2 个"
                  >
                    ≥2
                  </button>
                </div>
                <button className="df-range-del" title="移除条件" onClick={() => removeRange(key)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
