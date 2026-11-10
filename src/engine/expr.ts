import type { Cond } from "../model/types";

/**
 * 条件求值。参数模式里的 visibleIf / enabledIf / disabledIf 全部走这里。
 * 用结构化条件而不是字符串表达式，是为了让器件包保持纯 JSON、可跨语言实现，
 * 也避免在 WebView 里跑 eval。
 */
export function evalCond(
  cond: Cond | undefined,
  values: Record<string, unknown>,
  mode?: string,
): boolean {
  if (!cond) return true;
  if ("always" in cond) return cond.always;
  if ("and" in cond) return cond.and.every((c) => evalCond(c, values, mode));
  if ("or" in cond) return cond.or.some((c) => evalCond(c, values, mode));
  if ("not" in cond) return !evalCond(cond.not, values, mode);

  const raw = cond.k === "@mode" ? mode : values[cond.k];

  switch (cond.op) {
    case "=":
      return looseEq(raw, cond.v);
    case "!=":
      return !looseEq(raw, cond.v);
    case "in":
      return Array.isArray(cond.v) && cond.v.some((x) => looseEq(raw, x));
    case "notin":
      return Array.isArray(cond.v) && !cond.v.some((x) => looseEq(raw, x));
    case ">":
      return Number(raw) > Number(cond.v);
    case ">=":
      return Number(raw) >= Number(cond.v);
    case "<":
      return Number(raw) < Number(cond.v);
    case "<=":
      return Number(raw) <= Number(cond.v);
    default:
      return true;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return toBool(a) === toBool(b);
  }
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1" || v === "on";
  return Boolean(v);
}

/** 从参数定义里取出某个模式下应占用的信号集合 */
export function signalsForMode(
  options: { value: string; signals?: string[] }[] | undefined,
  mode: string | undefined,
): string[] {
  if (!options || mode === undefined) return [];
  const hit = options.find((o) => String(o.value) === String(mode));
  return hit?.signals ?? [];
}
