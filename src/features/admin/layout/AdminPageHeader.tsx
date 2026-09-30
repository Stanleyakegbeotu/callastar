import type { ReactNode } from "react";

interface AdminPageHeaderProps {
  title: string;
  description?: string;
  /** Primary action for the page, aligned to the right on wide screens. */
  actions?: ReactNode;
  /** Optional breadcrumb or back link shown above the title. */
  eyebrow?: ReactNode;
}

/** A restrained page header: what this page is, and the one thing to do on it. */
export function AdminPageHeader({ title, description, actions, eyebrow }: AdminPageHeaderProps) {
  return (
    <header className="admin-page-header">
      <div>
        {eyebrow && <div className="admin-page-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="admin-page-actions">{actions}</div>}
    </header>
  );
}

export default AdminPageHeader;
