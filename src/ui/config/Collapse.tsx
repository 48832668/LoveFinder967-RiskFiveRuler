/**
 * 折叠分组。beginner=false 时隐藏分组说明。
 */
import { useState } from "react";

export function Collapse({
  title,
  hint,
  badge,
  defaultOpen,
  beginner,
  children,
}: {
  title: string;
  hint?: string;
  badge?: number;
  defaultOpen?: boolean;
  beginner: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <section className={`collapse card ${open ? "open" : ""}`}>
      <button className="collapse-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="collapse-title">{title}</span>
        {badge !== undefined && badge > 0 && <span className="collapse-badge">{badge}</span>}
      </button>
      {open && (
        <div className="collapse-body">
          {beginner && hint && <p className="group-hint">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}
