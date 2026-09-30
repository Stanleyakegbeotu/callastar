import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { supabase } from "@/lib/supabase/client";

import { hasDevelopmentSession, isDevelopmentAdminEnabled } from "./auth/adminAuth";

type Access = "checking" | "allowed" | "denied";

/**
 * Admin access gate.
 *
 * Two mutually exclusive paths. In a development build with
 * `VITE_ADMIN_AUTH_MODE=development`, a local session is enough. Otherwise the
 * Supabase session must exist AND be listed in `admin_profiles` — a production
 * build only ever takes that second path.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Access>(() => (isDevelopmentAdminEnabled() ? "checking" : "checking"));

  useEffect(() => {
    if (isDevelopmentAdminEnabled()) {
      setState(hasDevelopmentSession() ? "allowed" : "denied");
      return;
    }

    const client = supabase;
    if (!client) {
      setState("denied");
      return;
    }

    let active = true;
    const check = async () => {
      const {
        data: { session },
      } = await client.auth.getSession();
      if (!session) {
        if (active) setState("denied");
        return;
      }
      const { data } = await client
        .from("admin_profiles")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (active) setState(data ? "allowed" : "denied");
    };

    void check();
    const { data: listener } = client.auth.onAuthStateChange(() => {
      void check();
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  if (state === "checking") return <main className="admin-auth">Checking access…</main>;
  return state === "allowed" ? <>{children}</> : <Navigate to="/admin/login" replace />;
}

export default AdminRoute;
