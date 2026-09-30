import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: number | string;
  /** One short line of context, never decoration. */
  hint?: string;
  tone?: "default" | "warning";
  action?: ReactNode;
}

/** A single dashboard number. Every value is derived from stored records. */
export function StatCard({ label, value, hint, tone = "default", action }: StatCardProps) {
  return (
    <article className={`admin-stat admin-stat-${tone}`}>
      <p className="admin-stat-label">{label}</p>
      <p className="admin-stat-value">{value}</p>
      {hint && <p className="admin-stat-hint">{hint}</p>}
      {action}
    </article>
  );
}

export default StatCard;
