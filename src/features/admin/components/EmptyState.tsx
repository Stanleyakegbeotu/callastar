import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

/** Used instead of an empty table, so a blank screen always explains itself. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="admin-empty">
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <div className="admin-empty-action">{action}</div>}
    </div>
  );
}

export default EmptyState;
