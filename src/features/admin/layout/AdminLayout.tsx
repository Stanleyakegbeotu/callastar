import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { Icon } from "@/components/ui/Icon";
import { config } from "@/lib/config";
import { supabase } from "@/lib/supabase/client";

import { HostCallProvider } from "@/features/host-calls/HostCallProvider";
import { HostCallSurface } from "@/features/host-calls/HostCallSurface";
import { supportRepository } from "@/services/support/repository";

import { ToastProvider } from "../components/ToastProvider";
import { AdminSidebar } from "./AdminSidebar";

/**
 * The CRM shell: navigation on the left, the page canvas on the right.
 *
 * Below the tablet breakpoint the sidebar becomes a drawer, which closes on
 * navigation so a tap on a link never leaves the overlay covering the page.
 */
export function AdminLayout() {
  supportRepository.setCustomerIdentity?.(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [adminName, setAdminName] = useState("");

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("admin_profiles").select("display_name").eq("user_id", user.id).maybeSingle();
      if (active && data?.display_name) setAdminName(data.display_name);
    })();
    return () => { active = false; };
  }, []);

  const signOut = async () => {
    await supabase?.auth.signOut();
    navigate("/admin/login", { replace: true });
  };

  return (
    <ToastProvider>
      {/*
        Live calling wraps the whole workspace, not one page.
        The provider holds the operator's signalling connection and the surface
        draws whatever it produces, so an incoming call reaches an operator who is
        reading a support thread just as readily as one sitting on a profile.
      */}
      <HostCallProvider>
      <div className={`admin-app ${drawerOpen ? "is-drawer-open" : ""}`}>
        <AdminSidebar open={drawerOpen} onNavigate={() => setDrawerOpen(false)} onSignOut={() => void signOut()} />

        {drawerOpen && (
          <button
            type="button"
            className="admin-scrim"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        <main className="admin-canvas">
          <div className="admin-topbar">
            <div className="admin-topbar-start">
              <button
                type="button"
                className="admin-icon-button"
                onClick={() => setDrawerOpen((open) => !open)}
                aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={drawerOpen}
              >
                <Icon name={drawerOpen ? "close" : "menu"} className="size-5" />
              </button>
              <strong className="admin-topbar-label">{adminName || "Admin"}</strong>
            </div>
            <CallaStarLogo className="admin-topbar-logo" size={30} />
            {config.adminDataMode === "local" && <span className="admin-chip">Local data</span>}
          </div>
          <div className="admin-page-content">
            <PageErrorBoundary key={location.pathname} admin><Outlet /></PageErrorBoundary>
          </div>
        </main>
      </div>
        <HostCallSurface />
      </HostCallProvider>
    </ToastProvider>
  );
}

export default AdminLayout;
