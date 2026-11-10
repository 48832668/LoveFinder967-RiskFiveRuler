import { useEffect, useMemo, useRef, useState } from "react";
import type { ClockConfig, DeviceDef, GpioCfg, PeripheralConfig, PeripheralDef, Project, ProjectSettings } from "./model/types";
import { DEVICE_MAP, deviceById, defaultDeviceId, seriesOf } from "./devices/index";
import { createProject, createDemoProject, freePeripheral, retarget } from "./app/project";
import { solveClock } from "./engine/clock";
import { applyModePins, applyRelocations, collectUsage, findConflicts, groupPinsFor, modeForSignal, normalizeModes, paramSignals, pinTableSignals, planEnableSmart, planPins, remapOf, remapsAt, requiredInMode } from "./semantic/pinmux";
import { schemaFor } from "./semantic/schemas";
import { mrsProjectName } from "./backends/wch/codegen";
import { generate, pinmapOnly } from "./backends/index";
import { exportTree, inTauri, openExternal, openProjectFile, readProjectAt, saveProjectFile, saveProjectToPath } from "./platform/io";
import { clearRecent, dropRecent, loadRecent, pushRecent } from "./platform/recent";
import type { RecentEntry } from "./platform/recent";
import { DEFAULT_UI_PREFS, loadUiPrefs, saveUiPrefs } from "./platform/settings";
import type { UiPrefs } from "./platform/settings";
import { setKindColorOverrides } from "./semantic/pinmux";
import { MenuBar } from "./ui/MenuBar";
import type { MenuAction } from "./ui/MenuBar";
import { AboutDialog } from "./ui/AboutDialog";
import { WelcomeScreen } from "./ui/WelcomeScreen";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { SettingsDialog } from "./ui/SettingsDialog";
import { AUTHOR_GITEE } from "./platform/appInfo";
import { Tree } from "./ui/Tree";
import { ConfigPanel } from "./ui/config/ConfigPanel";
import { PinoutView } from "./ui/PinoutView";
import { ClockPanel } from "./ui/ClockPanel";
import { CodePanel } from "./ui/CodePanel";
import { ProjectPanel } from "./ui/ProjectPanel";
import { DevicePicker } from "./ui/DevicePicker";

type Tab = "pinout" | "clock" | "code" | "project";

/**
 * 「会丢掉当前工程」的动作，都要先问一句保存。
 *
 * start = 选定型号后新建空白工程（new / switch 只是入口文案不同）；
 * close = 关闭工程回欢迎页；quit = 点窗口 X 退出。
 * 用一个联合类型而不是几个互斥的 boolean，避免同时弹出两个确认框。
 */
type PendingConfirm =
  | { kind: "start"; id: string; purpose: "new" | "switch" }
  | { kind: "close" }
  | { kind: "quit" };

/**
 * 点引脚 = 选定重映射组。
 *
 * WCH 的 AFIO 整组切换：只改一条线，很容易配出「SCL 在组 0、SDA 在组 3」这种
 * 硬件做不到的状态 —— 引脚图上看是两个干净的脚，烧进去只有一个组生效。
 * 所以这里把本外设当前用到的其它线一起挪到点中那根脚所在的组。
 *
 * 目标组装不下整套组合时**保持原样**：为了对齐反而把必需信号清空更糟。
 */
function alignToGroup(
  dev: DeviceDef,
  periph: PeripheralDef,
  cfg: PeripheralConfig,
  project: Project,
  signal: string,
  pin: string,
): void {
  const group = remapOf(dev, pin, `${periph.id}_${signal}`);
  const usage = collectUsage(project, dev);
  const pinned = { signal, pin };

  // 普通信号
  const sigs = Object.keys(cfg.pins).filter((k) => cfg.pins[k]);
  if (sigs.length > 1) {
    const cur: Record<string, string | null> = {};
    for (const k of sigs) cur[k] = cfg.pins[k] ?? null;
    const aligned = groupPinsFor(dev, periph, sigs, group, cur, usage, pinned);
    if (sigs.every((k) => aligned[k])) Object.assign(cfg.pins, aligned);
  }

  // 通道表的引脚（TIM 的 CHx / CHxN）
  const keys = Object.keys(cfg.channels ?? {}).filter((k) => cfg.channels![k]!.pin);
  if (keys.length > 1) {
    const list: string[] = [];
    const cur: Record<string, string | null> = {};
    for (const k of keys) {
      const ch = cfg.channels![k]!;
      list.push(k);
      cur[k] = ch.pin ?? null;
      if (ch.pinN) {
        list.push(`${k}N`);
        cur[`${k}N`] = ch.pinN;
      }
    }
    const aligned = groupPinsFor(dev, periph, list, group, cur, usage, pinned);
    if (list.every((s) => aligned[s])) {
      for (const k of keys) {
        const ch = cfg.channels![k]!;
        if (aligned[k] !== undefined) ch.pin = aligned[k];
        if (ch.pinN && aligned[`${k}N`] !== undefined) ch.pinN = aligned[`${k}N`];
      }
    }
  }
}


export default function App() {
  const [deviceId, setDeviceId] = useState(() => {
    const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("dev");
    return q && DEVICE_MAP[q] ? q : defaultDeviceId();
  });
  const dev = useMemo(() => deviceById(deviceId), [deviceId]);
  const [project, setProject] = useState<Project>(() => {
    const d = deviceById(deviceId);
    const demo = typeof location !== "undefined" && location.search.includes("demo=1");
    return demo ? createDemoProject(d) : createProject(d, "RFR_Project");
  });
  const [selected, setSelected] = useState<string | null>(() => {
    const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("sel");
    return q || "USART1";
  });
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("tab");
    return t === "clock" || t === "code" || t === "project" ? (t as Tab) : "pinout";
  });
  const [search, setSearch] = useState("");
  /** 从引脚图跳转时要求 ConfigPanel 打开的页签（null = 保持它自己的状态） */
  const [pane, setPane] = useState<"pins" | "channel" | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof location !== "undefined" && new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark",
  );
  /** 界面偏好（主题色 / 模式 / 图例配色），启动时从 config.json 载入 */
  const [prefs, setPrefs] = useState<UiPrefs>(() => ({ ...DEFAULT_UI_PREFS, pinColors: {} }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  /**
   * 是否已经进入编辑器。
   *
   * 启动落在欢迎页而不是直接进编辑器：以前一打开就是一个「已建好但空的」工程，
   * 用户既不知道刚才打开的是哪个文件，也没有明确的开工动作。
   * 带 `dev=` / `demo=1` / `picker=1` 的 URL 直接进编辑器 —— 那是深链与自动化测试的入口。
   */
  const [booted, setBooted] = useState(() => {
    if (typeof location === "undefined") return true;
    const q = new URLSearchParams(location.search);
    return Boolean(q.get("dev") || q.get("demo") || q.get("picker") || q.get("sel"));
  });
  /** 当前工程有没有未保存的改动；保存 / 新建 / 打开后清零 */
  const [dirty, setDirty] = useState(false);
  /**
   * 待确认的「会丢工程」动作。null = 没有待确认。
   * 换器件、新建工程、关闭工程、点窗口 X 都汇到这里，共用一套三按钮确认框。
   */
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  /** 器件选择器的用途：new = 新建工程选型号，switch = 更换器件；null = 关闭 */
  const [pickerMode, setPickerMode] = useState<"new" | "switch" | null>(
    () =>
      typeof location !== "undefined" && new URLSearchParams(location.search).get("picker") === "1"
        ? "switch"
        : null,
  );
  const [welcomeNote, setWelcomeNote] = useState<string | null>(null);

  // 窗口关闭事件注册一次，回调里必须读到「当下」的 dirty / booted / pending，
  // 不能闭包捕获挂载时的旧值 —— 用 ref 同步最新状态。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bootedRef = useRef(booted);
  bootedRef.current = booted;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** 用户已在确认框里选了「退出」：窗口关闭回调直接放行 */
  const forceQuitRef = useRef(false);

  const clock = useMemo(() => solveClock(dev.clock, project.clock), [dev, project.clock]);
  const usage = useMemo(() => collectUsage(project, dev), [project, dev]);
  const conflicts = useMemo(() => findConflicts(usage), [usage]);

  useEffect(() => {
    // data-theme 给旧组件（引脚图重绘）用；data-fs-mode 是 FinderSkin 的开关
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fsMode = theme;
  }, [theme]);

  /** 主题色 / 图例配色：写 CSS 变量 + 通知 semantic 层；style 属性变化会让引脚图重绘 */
  useEffect(() => {
    document.documentElement.style.setProperty("--app-theme", prefs.themeColor);
    setKindColorOverrides(prefs.pinColors);
  }, [prefs]);

  /**
   * 窗口标题跟随工程名：`RiskFiveRuler - <工程名>`。
   * Tauri 用 setTitle 改原生标题栏；浏览器里落到 document.title（自动化测试读这个）。
   * 工程名在「工程设置」里改，这里跟着刷新。
   */
  useEffect(() => {
    const name = project.settings.name.trim();
    const title = name ? `RiskFiveRuler - ${name}` : "RiskFiveRuler";
    document.title = title;
    if (!inTauri()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(title);
      } catch {
        // 非 Tauri 环境 / 权限未就绪：document.title 已经够了
      }
    })();
  }, [project.settings.name]);

  // 启动时读 config.json（浏览器读 localStorage），主题与配色一次到位
  useEffect(() => {
    void loadUiPrefs().then((p) => {
      setPrefs(p);
      setTheme(p.mode);
    });
  }, []);

  /** 设置界面 / 顶栏昼夜按钮共用的应用入口：改状态 + 立即持久化 */
  const applyUiPrefs = (p: UiPrefs) => {
    setPrefs(p);
    setTheme(p.mode);
    void saveUiPrefs(p);
  };

  // 最近打开是 localStorage 里的本机偏好，挂载后读一次即可
  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  /**
   * 点窗口 X 时，有未保存改动要先问一句。
   *
   * Tauri 只要发现前端注册了 close-requested 监听器，原生侧就会自动
   * prevent_close() —— 所以「没改动」的情况必须什么都不做，让 SDK 自己 destroy()；
   * 「有改动」才 preventDefault() 拦下来并弹确认框。
   * 监听器只注册一次，状态全走 ref，避免闭包读到挂载时的旧 dirty。
   */
  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const fn = await getCurrentWindow().onCloseRequested((event) => {
          // 确认框里已经选了「退出」：直接放行，别再拦一次
          if (forceQuitRef.current) return;
          if (!bootedRef.current || !dirtyRef.current) return;
          event.preventDefault();
          // 已经有确认框在等用户（换器件 / 新建 / 关闭），不重复弹
          if (!pendingRef.current) {
            // 先收起其它模态框，避免确认框与选择器 / 关于框叠在一起
            setPickerMode(null);
            setAboutOpen(false);
            setPending({ kind: "quit" });
          }
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // 非 Tauri 环境或权限未就绪时静默跳过，不影响正常使用
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  /** 选外设时清掉「跳页」要求，否则下一次选别处还被迫停在通道页 */
  /**
   * 所有修改工程的入口都走这里。
   *
   * 统一打脏标记，而不是每个调用点自己 setDirty(true) —— 后者一定会漏，
   * 漏掉的那一处就是「关窗口时没提示保存、改动丢了」。
   * `clean=true` 只给「刚载入/刚新建/刚保存」这三种情况用。
   */
  const mutate = (updater: (p: Project) => Project, clean = false) => {
    setProject(updater);
    setDirty(!clean);
  };

  const selectPeriph = (id: string | null) => {
    setPane(null);
    setSelected(id);
  };

  const updateConfig = (id: string, next: PeripheralConfig) => {
    mutate((p) => ({ ...p, configs: { ...p.configs, [id]: next } }));
  };

  /** 一次提交多个外设的配置（启用时顺带把别人的引脚重映射掉） */
  const updateConfigs = (next: Record<string, PeripheralConfig>) => {
    mutate((p) => ({ ...p, configs: { ...p.configs, ...next } }));
  };

  /**
   * 「关闭冲突外设」的真正语义：把这个外设关掉、引脚全释放，
   * **同时**把当前正在配置的外设启用起来。腾出来还不够，用户要的是启用。
   */
  const freeBlockerAndEnable = (ownerId: string) => {
    const target = dev.peripherals.find((p) => p.id === selected) ?? null;
    mutate((prev) => {
      const freed = freePeripheral(prev, ownerId);
      if (!target) return freed;
      const cfg = freed.configs[target.id];
      if (!cfg || cfg.enabled) return freed;

      const plan = planEnableSmart(dev, freed, target, cfg, collectUsage(freed, dev));
      if (!plan) return freed; // 还有别人挡着，界面会接着显示下一个

      const next: PeripheralConfig = { ...cfg, enabled: true };
      const modeKey = schemaFor(target.schema)?.modeKey;
      if (modeKey && plan.mode) {
        next.mode = plan.mode;
        next.params = { ...cfg.params, [modeKey]: plan.mode };
      }
      next.pins = { ...cfg.pins, ...plan.pins };
      const configs = plan.relocations.length
        ? applyRelocations(freed, plan.relocations)
        : freed.configs;
      return { ...freed, configs: { ...configs, [target.id]: next } };
    });
    notify(`已关闭 ${ownerId} 并释放引脚`);
  };

  const setClock = (next: ClockConfig) => mutate((p) => ({ ...p, clock: next }));
  const setSettings = (s: ProjectSettings) => mutate((p) => ({ ...p, settings: s }));

  /** 真正按型号开一个空白工程、清掉文件路径、进编辑器 */
  const startWithDevice = (id: string, purpose: "new" | "switch") => {
    const next = deviceById(id);
    setDeviceId(id);
    mutate(() => createProject(next, "RFR_Project"), true);
    setFilePath(null);
    setSelected("USART1");
    setTab("pinout");
    setBooted(true);
    setPickerMode(null);
    notify(purpose === "new" ? `已新建 ${id} 工程` : `已切换到 ${id}，新建空白工程`);
  };

  /** 关闭工程：回到欢迎页，编辑器里的内容不再挂着 */
  const closeProject = () => {
    mutate(() => createProject(dev, "RFR_Project"), true);
    setFilePath(null);
    setSelected(null);
    setBooted(false);
    setPickerMode(null);
    notify("工程已关闭");
  };

  /** 真正退出窗口（确认框里选了退出之后调用，绕过 close-requested 拦截） */
  const destroyWindow = async () => {
    forceQuitRef.current = true;
    if (!inTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  };

  /** 执行一个「会丢工程」的动作（不负责问保存，那是 requestAction 的事） */
  const runAction = (a: PendingConfirm) => {
    setPending(null);
    if (a.kind === "start") startWithDevice(a.id, a.purpose);
    else if (a.kind === "close") closeProject();
    else void destroyWindow();
  };

  /** 所有会丢弃当前工程的动作统一从这里进：有改动就先问，没改动直接走 */
  const requestAction = (a: PendingConfirm) => {
    if (dirty) setPending(a);
    else runAction(a);
  };

  /** 器件选择器选定型号：新建与更换共用同一个回调 */
  const onPickDevice = (id: string) => {
    const purpose = pickerMode ?? "switch";
    setPickerMode(null);
    // 更换器件时选回自己 = 没换，别把工程白清一遍
    if (purpose === "switch" && id === deviceId) return;
    requestAction({ kind: "start", id, purpose });
  };

  /* 从引脚视图分配复用功能 */
  const assignPin = (pin: string, fn: string | null) => {
    mutate((prev) => {
      const next: Project = JSON.parse(JSON.stringify(prev));
      // 先释放该引脚上原有的分配
      for (const cfg of Object.values(next.configs)) {
        for (const [sig, p] of Object.entries(cfg.pins)) {
          if (p === pin) cfg.pins[sig] = null;
        }
        for (const ch of Object.values(cfg.channels ?? {})) {
          if (ch.pin === pin) ch.pin = null;
          if (ch.pinN === pin) ch.pinN = null;
        }
      }
      if (!fn) {
        /**
         * 完全释放：回到「未配置」状态。
         *
         * 以前这里设成 GPIO 输入 —— 输入态会着色，引脚图上比从没配过的脚浅一档，
         * 看着像「还残留着什么」。复位默认是模拟态，引脚图不着色，才是真正的空白。
         */
        next.gpio[pin] = { mode: "analog", pull: "none", speed: "2" };
        return next;
      }
      const owner = fn.split("_")[0];
      const signal = fn.slice(owner.length + 1);
      const cfg = next.configs[owner];
      const def = dev.peripherals.find((p) => p.id === owner);
      if (!cfg || !def) return next;

      cfg.enabled = true;
      const schema = schemaFor(def.schema);
      const chSpec = schema?.channelSpec;
      // 通道型信号（TIM 的 CH1..CH4、ADC 的 IN0..、EXTI 的 LINE0..）走通道表
      const isChannel = !!chSpec && new RegExp(`^${chSpec.prefix}\\d+$`).test(signal);
      // 互补输出（CH1N）不是独立通道，是同一个通道的另一根线 —— 记进 pinN
      const mN = chSpec ? new RegExp(`^${chSpec.prefix}(\\d+)N$`).exec(signal) : null;
      if (mN) {
        const key = `${chSpec!.prefix}${mN[1]}`;
        const ch = cfg.channels?.[key] ?? { enabled: false, mode: "disable", pin: null, params: {} };
        ch.enabled = true;
        ch.pinN = pin;
        ch.params = { ...(ch.params ?? {}), complementary: true };
        if (!ch.mode || ch.mode === "disable") {
          const first = chSpec!.modes.find((m) => m.value !== "disable");
          ch.mode = first ? String(first.value) : "pwm";
        }
        cfg.channels = { ...(cfg.channels ?? {}), [key]: ch };
      } else if (isChannel) {
        const ch = cfg.channels?.[signal] ?? { enabled: false, mode: "disable", pin: null, params: {} };
        ch.enabled = true;
        ch.pin = pin;
        if (ch.mode === "disable") {
          // 通道的默认模式取 schema 里第一个不是「关闭」的选项
          const first = chSpec!.modes.find((m) => m.value !== "disable");
          ch.mode = first ? String(first.value) : "pwm";
        }
        cfg.channels = { ...(cfg.channels ?? {}), [signal]: ch };
      } else {
        cfg.pins = { ...cfg.pins, [signal]: pin };
        // grouped 器件：点中组外的脚会形成混组（硬件跑不起来）——
        // 整组跟着这次点击走，与引脚表里换组是同一行为
        if (dev.afGrouping === "grouped") {
          const want = new Set([
            ...requiredInMode(def, String(cfg.params[schema?.modeKey ?? ""] ?? cfg.mode ?? ""), cfg.params),
            ...paramSignals(def, cfg.params),
          ]);
          const targets = pinTableSignals(def).filter((s) => want.has(s));
          const g = remapOf(dev, pin, fn);
          const offGroup = targets.some(
            (s) => s !== signal && cfg.pins[s] && !remapsAt(dev, cfg.pins[s]!, `${owner}_${s}`).includes(g),
          );
          if (offGroup) {
            cfg.pins = groupPinsFor(dev, def, targets, g, cfg.pins, collectUsage(next, dev), { signal, pin });
          }
        }
        // 模式栏还停在 Disable：按顺序找第一个「必需信号都能落下去」的模式
        const modeKey = schema?.modeKey;
        const modeParam = modeKey ? schema!.params.find((p) => p.key === modeKey) : undefined;
        if (modeKey && modeParam) {
          let mode = String(cfg.mode ?? "disable");
          // 点的是 CK 这种「模式专属信号」时，模式栏跟着切过去 ——
          // 否则会出现「CK 已经占了引脚，模式却还停在异步」的错配
          if (!requiredInMode(def, mode, cfg.params).includes(signal)) {
            mode = modeForSignal(def, signal) ?? mode;
          }
          // 还停在 Disable：按顺序找第一个「必需信号都能落下去」的模式
          if (mode === "disable") {
            const fresh = collectUsage(next, dev);
            for (const o of modeParam.options ?? []) {
              const m = String(o.value);
              if (m === "disable" || m === "off") continue;
              if (planPins(dev, next, owner, requiredInMode(def, m, cfg.params), fresh)) {
                mode = m;
                break;
              }
            }
          }
          if (mode !== "disable" && mode !== "off") {
            cfg.mode = mode;
            cfg.params[modeKey] = mode;
            // 模式决定占几根线：多退少补（同步补 CK、单线收回 RX）
            cfg.pins = applyModePins(dev, next, def, cfg, mode);
          }
        }
      }
      // 必需信号补全（沿用当前模式；单线只补 TX，同步补 TX+CK）
      {
        const modeKey = schema?.modeKey;
        const mode = modeKey ? String(cfg.params[modeKey] ?? "") : "";
        const chRe = schema?.channelSpec ? new RegExp(`^${schema.channelSpec.prefix}\\d+$`) : null;
        const missing = requiredInMode(def, mode, cfg.params).filter((s) => !cfg.pins[s] && !chRe?.test(s));
        if (missing.length) {
          const planned = planPins(dev, next, owner, missing, collectUsage(next, dev));
          if (planned) cfg.pins = { ...cfg.pins, ...planned };
        }
      }
      // WCH：点一个脚就等于**选定它所在的重映射组**，同组其它线一起落下去
      if (dev.afGrouping === "grouped") alignToGroup(dev, def, cfg, next, signal, pin);
      return next;
    });
    const owner = fn?.split("_")[0];
    if (owner) {
      setSelected(owner);
      // 跳到信号真正落到的那一页：通道型（ADC 的 INx、TIM 的 CHx）→ 通道页，
      // 否则引脚页。新手点完引脚图看到「什么都没变」通常就是这里没跳。
      const def = dev.peripherals.find((p) => p.id === owner);
      const sig = fn ? fn.slice(owner.length + 1) : "";
      if (def && sig) {
        const chSpec = schemaFor(def.schema)?.channelSpec;
        setPane(chSpec && new RegExp(`^${chSpec.prefix}\\d+N?$`).test(sig) ? "channel" : "pins");
      }
    }
  };

  const setGpioMode = (pin: string, mode: string) => {
    mutate((prev) => {
      const next: Project = JSON.parse(JSON.stringify(prev));
      for (const cfg of Object.values(next.configs)) {
        for (const [sig, p] of Object.entries(cfg.pins)) if (p === pin) cfg.pins[sig] = null;
      }
      const g: GpioCfg = next.gpio[pin] ?? { mode: "input", pull: "none", speed: "2" };
      next.gpio[pin] = { ...g, mode: mode as GpioCfg["mode"] };
      return next;
    });
  };

  /** 返回 true = 确实写盘成功（用户取消对话框时是 false） */
  const doSave = async (): Promise<boolean> => {
    const json = JSON.stringify({ ...project, savedAt: Date.now() }, null, 2);
    // 已经有路径就直接覆盖；没有才弹「另存为」——和桌面软件的「保存」一致
    if (filePath) {
      const path = await saveProjectToPath(filePath, json);
      if (path) {
        setRecent(pushRecent({ path, name: project.settings.name || "RFR_Project", deviceId }));
        setDirty(false);
        notify("工程已保存");
        return true;
      }
      return false;
    }
    return doSaveAs();
  };

  const doSaveAs = async (): Promise<boolean> => {
    const json = JSON.stringify({ ...project, savedAt: Date.now() }, null, 2);
    const path = await saveProjectFile(project.settings.name || "RFR_Project", json);
    if (!path) return false;
    setFilePath(path);
    setRecent(pushRecent({ path, name: project.settings.name || "RFR_Project", deviceId }));
    setDirty(false);
    notify("工程已另存");
    return true;
  };

  /** 把解析好的工程装进界面，「打开」与「最近打开」共用 */
  const loadProject = (parsed: Project, path: string) => {
    if (!parsed.deviceId) throw new Error("不是有效的工程文件");
    setDeviceId(parsed.deviceId);
    // 老工程里可能存着暂时收起的模式（LIN / IrDA / 智能卡），先落到合法模式
    const devOpen = deviceById(parsed.deviceId);
    const opened = normalizeModes(parsed, devOpen);
    setProject(opened);
    setFilePath(path);
    setRecent(pushRecent({ path, name: opened.settings.name || "RFR_Project", deviceId: parsed.deviceId }));
    const first = devOpen.peripherals.find((p) => opened.configs[p.id]?.enabled);
    setSelected(first?.id ?? null);
    setDirty(false);
    setBooted(true);
  };

  const doOpen = async () => {
    try {
      const res = await openProjectFile();
      if (!res) return;
      loadProject(JSON.parse(res.content) as Project, res.path);
      notify("工程已打开");
    } catch (e) {
      notify(`打开失败：${(e as Error).message}`);
    }
  };

  /** 从「最近打开」里恢复；路径失效就把它从列表里去掉并提示 */
  const doOpenRecent = async (entry: RecentEntry) => {
    try {
      const content = await readProjectAt(entry.path);
      if (content === null) {
        // 浏览器里根本没有「按路径读文件」的能力，别把记录也删了 —— 换成桌面端还能用
        if (!inTauri()) {
          notify("浏览器模式无法按路径打开，请用「打开…」选择文件");
          return;
        }
        setRecent(dropRecent(entry.path));
        notify(`打不开 ${entry.name}：文件可能已被移动或删除`);
        return;
      }
      loadProject(JSON.parse(content) as Project, entry.path);
      notify(`已打开 ${entry.name}`);
    } catch (e) {
      notify(`打开失败：${(e as Error).message}`);
    }
  };

  /**
   * 新建工程：先弹器件选择器让用户挑型号，不再默认沿用当前器件直接建。
   * 真正的建工程动作在 onPickDevice → startWithDevice。
   */
  const doNew = () => {
    setPickerMode("new");
  };

  /** 关闭工程：有未保存改动时先问一句，然后回欢迎页 */
  const doClose = () => {
    if (!booted) {
      notify("当前没有打开的工程");
      return;
    }
    requestAction({ kind: "close" });
  };

  const doExport = async () => {
    if (!dev.codegenEnabled) {
      notify(dev.codegenNote ?? `${dev.id} 未提供代码生成`);
      return;
    }
    const files = generate(project, dev);
    // MRS 工程整体放进 <工程名>/ 子目录，选 EVT 的 EXAM 目录就能直接 Import
    const subdir = project.settings.toolchain === "mrs" ? mrsProjectName(project) : undefined;
    const dir = await exportTree(files, subdir);
    if (dir) notify(`已导出 ${files.length} 个文件到 ${dir}`);
  };

  /** 资料不足的器件仍然可以导出引脚映射表 —— 那是纯数据，手工移植要用 */
  const doExportPinmap = async () => {
    const dir = await exportTree(pinmapOnly(project, dev));
    if (dir) notify("已导出引脚映射表");
  };

  const onMenuAction = (a: MenuAction) => {
    switch (a) {
      case "new":
        doNew();
        break;
      case "open":
        void doOpen();
        break;
      case "close":
        doClose();
        break;
      case "save":
        void doSave();
        break;
      case "saveAs":
        void doSaveAs();
        break;
      case "export":
        void doExport();
        break;
      case "settings":
        setSettingsOpen(true);
        break;
      case "about":
        setAboutOpen(true);
        break;
      case "author":
        void openExternal(AUTHOR_GITEE);
        break;
    }
  };

  /**
   * 全局快捷键。放在 window 上而不是按钮上，因为菜单里的项是动态渲染的。
   * Ctrl+S 必须 preventDefault，否则 WebView 会弹出「保存网页」。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void (e.shiftKey ? doSaveAs() : doSave());
      } else if (k === "o") {
        e.preventDefault();
        void doOpen();
      } else if (k === "e") {
        e.preventDefault();
        void doExport();
      } else if (k === "n") {
        e.preventDefault();
        doNew();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const periph = dev.peripherals.find((p) => p.id === selected) ?? null;
  const enabledList = dev.peripherals.filter((p) => project.configs[p.id]?.enabled);

  /** 确认框文案按「要做什么」变化，但三按钮流程只有一套 */
  const copyOf = (p: PendingConfirm) => {
    if (p.kind === "start") {
      return p.purpose === "switch"
        ? {
            title: "切换器件前先保存？",
            save: "保存并切换",
            drop: "不保存，直接切换",
            body: (
              <>
                <p>
                  当前工程还有<strong>未保存的改动</strong>。切换到 <code>{p.id}</code>{" "}
                  会新建一个空工程（外设、引脚与复用表都不同，不能直接沿用）。
                </p>
                <p className="muted">选「保存并切换」会把当前工程写回原文件（没保存过则弹窗选路径），然后新建。</p>
              </>
            ),
          }
        : {
            title: "新建工程前先保存？",
            save: "保存并新建",
            drop: "不保存，直接新建",
            body: (
              <>
                <p>
                  当前工程还有<strong>未保存的改动</strong>。以 <code>{p.id}</code> 新建工程会丢弃这些改动。
                </p>
                <p className="muted">选「保存并新建」会先写回当前工程（没保存过则弹窗选路径）。</p>
              </>
            ),
          };
    }
    if (p.kind === "close") {
      return {
        title: "关闭工程前先保存？",
        save: "保存并关闭",
        drop: "不保存，直接关闭",
        body: (
          <>
            <p>
              当前工程还有<strong>未保存的改动</strong>，关闭后这些改动会丢失。
            </p>
            <p className="muted">关闭只是回到欢迎页，不会退出程序；之后可以重新打开保存的文件。</p>
          </>
        ),
      };
    }
    return {
      title: "退出前先保存？",
      save: "保存并退出",
      drop: "不保存，直接退出",
      body: (
        <>
          <p>
            当前工程还有<strong>未保存的改动</strong>，退出后这些改动会丢失。
          </p>
          <p className="muted">选「保存并退出」会先写回当前工程（没保存过则弹窗选路径）。</p>
        </>
      ),
    };
  };

  /**
   * 模态层：欢迎页与编辑器共用。
   * 新建工程的选择器必须也能在欢迎页弹出，所以不能只放在编辑器分支里。
   */
  const dialogs = (
    <>
      {pickerMode && (
        <DevicePicker
          current={deviceId}
          mode={pickerMode}
          onPick={onPickDevice}
          onClose={() => setPickerMode(null)}
        />
      )}

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {settingsOpen && (
        <SettingsDialog prefs={prefs} onApply={applyUiPrefs} onClose={() => setSettingsOpen(false)} />
      )}

      {pending &&
        (() => {
          const c = copyOf(pending);
          return (
            <ConfirmDialog
              title={c.title}
              message={c.body}
              actions={[
                {
                  label: c.save,
                  tone: "primary",
                  onPick: async () => {
                    // 用返回值而不是读 dirty —— 闭包里的 dirty 是渲染时的旧值，
                    // 保存成功后它还是 true，会误判成「没存成功」而拒绝继续。
                    const saved = await doSave();
                    if (!saved) return; // 用户在保存对话框里点了取消：原地不动
                    runAction(pending);
                  },
                },
                { label: c.drop, tone: "danger", onPick: () => runAction(pending) },
              ]}
              onCancel={() => setPending(null)}
            />
          );
        })()}
    </>
  );

  /* ── 欢迎页：启动的落点，不直接进编辑器 ── */
  if (!booted) {
    return (
      <div className="app welcome-app">
        <MenuBar
          recent={recent}
          filePath={filePath}
          onOpenRecent={(e) => void doOpenRecent(e)}
          onClearRecent={() => setRecent(clearRecent())}
          onAction={onMenuAction}
        />
        <WelcomeScreen
          recent={recent}
          note={welcomeNote}
          onNew={doNew}
          onOpen={() => void doOpen()}
          onOpenRecent={(e) => void doOpenRecent(e)}
          onClearRecent={() => setRecent(clearRecent())}
          onOpenAuthor={() => void openExternal(AUTHOR_GITEE)}
        />
        {dialogs}
      </div>
    );
  }

  return (
    <div className="app">
      <MenuBar
        recent={recent}
        filePath={filePath}
        onOpenRecent={(e) => void doOpenRecent(e)}
        onClearRecent={() => setRecent(clearRecent())}
        onAction={onMenuAction}
      />
      <header className="topbar">
        <div className="device-picker">
          <label>器件</label>
          <div className="device-readout">
            <div className="dv-main">
              <span className="dv-id">{dev.id}</span>
              <span className="dv-meta">
                {seriesOf(dev.id)?.label ?? dev.family} · {dev.package.label} · {dev.package.pins.length} 脚
              </span>
            </div>
            <button className="dv-change btn btn-ghost btn-sm" onClick={() => setPickerMode("switch")} title="更换器件">
              更换
            </button>
          </div>
        </div>

        <nav className="topnav nav-tabs">
          {(
            [
              ["pinout", "引脚与外设"],
              ["clock", "时钟树"],
              ["code", "生成代码"],
              ["project", "工程设置"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} className={`nav-link ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        <div className="top-actions">
          <button className="btn btn-ghost btn-sm" onClick={doOpen}>打开</button>
          <button className="btn btn-ghost btn-sm" onClick={doSave}>
            保存{dirty ? " •" : ""}
          </button>
          {dev.codegenEnabled ? (
            <button className="btn btn-primary btn-sm" onClick={doExport}>生成代码</button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={doExportPinmap}
              title={dev.codegenNote ?? "该器件未提供代码生成，只能导出引脚映射表"}
            >
              导出引脚表
            </button>
          )}
          <button
            className="btn btn-icon btn-sm"
            title={theme === "dark" ? "切换浅色" : "切换深色"}
            onClick={() => applyUiPrefs({ ...prefs, mode: theme === "dark" ? "light" : "dark" })}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {dialogs}

      <div className={`workspace ${tab === "pinout" ? "" : "full"}`}>
        <aside className="sidebar">
          <div className="chip-card card">
            <div className="chip-card-top">
              <b>{dev.id}</b>
              <span>{dev.package.label}</span>
            </div>
            <p>{dev.core}</p>
            <div className="chip-specs">
              <div><span>Flash</span><b>{dev.flashKb} KB</b></div>
              <div><span>RAM</span><b>{dev.ramKb} KB</b></div>
              <div><span>SYSCLK</span><b>{clock.sysclk} MHz</b></div>
            </div>
          </div>

          <div className="search-wrap search">
            <input
              className="form-control"
              placeholder="搜索引脚或外设，如 PC5 / SPI / TIM1"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && <button className="clear" onClick={() => setSearch("")}>✕</button>}
          </div>

          <Tree dev={dev} project={project} selected={selected} onSelect={selectPeriph} />
        </aside>

        <main className="center">
          {tab === "pinout" &&
            (periph ? (
              <ConfigPanel
                dev={dev}
                project={project}
                periph={periph}
                clock={clock}
                pane={pane}
                onChange={updateConfig}
                onChangeMany={updateConfigs}
                onFree={freeBlockerAndEnable}
                onJumpPeripheral={selectPeriph}
                onNote={notify}
                beginner={prefs.beginner}
              />
            ) : (
              <div className="overview">
                <h2>从左侧选一个外设开始配置</h2>
                <p>或者直接点击右侧封装图上的引脚，把它分配给某个复用功能。</p>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => mutate(() => createDemoProject(dev))}>
                  载入示例工程
                </button>
                <div className="overview-cards">
                  {enabledList.length === 0 && <div className="ov-empty">还没有启用任何外设。</div>}
                  {enabledList.map((p) => (
                    <button key={p.id} className="ov-card card card-lift" onClick={() => selectPeriph(p.id)}>
                      <b>{p.label}</b>
                      <span>{p.brief}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

          {tab === "clock" && (
            <ClockPanel topo={dev.clock} clock={project.clock} derived={clock} onChange={setClock} family={dev.family} beginner={prefs.beginner} />
          )}

          {tab === "code" && <CodePanel dev={dev} project={project} onExport={doExport} />}

          {tab === "project" && (
            <ProjectPanel dev={dev} project={project} clock={clock} conflicts={conflicts} onChange={setSettings} />
          )}
        </main>

        {tab === "pinout" && (
          <aside className="pinpane">
            <PinoutView
              dev={dev}
              project={project}
              search={search}
              onAssign={assignPin}
              onGpioMode={setGpioMode}
              onSelectPeripheral={selectPeriph}
              autoPin={new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("pin")}
            />
          </aside>
        )}
      </div>

      <footer className="statusbar">
        <span className="status-item"><i className="status-dot is-success" />SYSCLK {clock.sysclk} MHz</span>
        <span className="status-item">HCLK {clock.hclk}</span>
        <span className="status-item">PCLK1 {clock.pclk1}</span>
        <span className="status-item">PCLK2 {clock.pclk2}</span>
        <span className="status-item">ADCCLK {clock.adcclk}</span>
        <span className="spacer" />
        <span className="status-item">已用引脚 {new Set(usage.map((u) => u.pin)).size} / {dev.package.pins.length}</span>
        {conflicts.length > 0 ? (
          <span className="status-item is-danger"><i className="status-dot is-danger" />{conflicts.length} 处冲突</span>
        ) : (
          <span className="status-item is-success"><i className="status-dot is-success" />无冲突</span>
        )}
        {filePath && <span className="status-item is-path">{filePath}</span>}
      </footer>

      {toast && (
        <div className="toast-host br">
          <div className="toast" role="status" aria-live="polite">
            <i className="toast-dot ok" />
            <span className="toast-text">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
