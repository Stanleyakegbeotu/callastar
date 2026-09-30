import { NavLink } from "react-router-dom";

import { Icon, type IconName } from "@/components/ui/Icon";
import { config } from "@/lib/config";

import { useCrmBadges } from "../hooks/useCrmData";

interface AdminSidebarProps {
  open: boolean;
  onNavigate: () => void;
  onSignOut: () => void;
}

/** Which counter, if any, a section carries. Settings deliberately has none. */
type BadgeKey = "openRequests" | "unreadConversations" | "unreadNotifications";

const NAV: { to: string; label: string; icon: IconName; end?: boolean; badge?: BadgeKey }[] = [
  { to: "/admin", label: "Overview", icon: "check", end: true },
  { to: "/admin/profiles", label: "Profiles", icon: "video" },
  { to: "/admin/sessions", label: "Call Sessions", icon: "audio" },
  { to: "/admin/subscriptions", label: "Subscriptions", icon: "crown", badge: "openRequests" },
  { to: "/admin/support", label: "Customer Care", icon: "chat", badge: "unreadConversations" },
  { to: "/admin/media", label: "Media", icon: "camera" },
  { to: "/admin/notifications", label: "Notifications", icon: "bell", badge: "unreadNotifications" },
  { to: "/admin/studio", label: "Transformation", icon: "bolt" },
  { to: "/admin/settings", label: "Settings", icon: "settings" },
];

/**
 * Compact operations navigation. On a narrow screen the same element becomes a
 * drawer rather than a shrunken desktop sidebar.
 */
export function AdminSidebar({ open, onNavigate, onSignOut }: AdminSidebarProps) {
  const badges = useCrmBadges();

  return (
    <nav className={`admin-sidebar ${open ? "is-open" : ""}`} aria-label="Admin sections">
      <div className="admin-brand">
        <span className="brand-mark">
          <Icon name="video" className="size-5" />
        </span>
        <span>
          CallaStar
          <small>Admin</small>
        </span>
      </div>

      <ul className="admin-nav">
        {NAV.map((item) => {
          const count = item.badge ? badges[item.badge] : 0;

          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) => `admin-nav-link ${isActive ? "is-active" : ""}`}
              >
                <Icon name={item.icon} className="size-5" />
                <span>{item.label}</span>
                {count > 0 && (
                  // The number is in the label too, so it is not colour alone
                  // telling somebody there is work waiting.
                  <span className="admin-nav-badge">
                    {count}
                    <span className="admin-visually-hidden"> waiting</span>
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>

      <div className="admin-sidebar-footer">
        {config.adminDataMode === "local" && (
          <p className="admin-mode-note">
            <strong>Local development data</strong>
            Profiles and media are stored in this browser only.
          </p>
        )}
        <NavLink to="/" className="admin-nav-link admin-nav-secondary" onClick={onNavigate}>
          <Icon name="chevron" className="size-5" />
          <span>Back to CallaStar</span>
        </NavLink>
        <button type="button" className="admin-nav-link admin-nav-secondary" onClick={onSignOut}>
          <Icon name="lock" className="size-5" />
          <span>Sign out</span>
        </button>
      </div>
    </nav>
  );
}

export default AdminSidebar;
