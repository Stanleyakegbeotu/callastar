import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { supabase } from "@/lib/supabase/client";

import { hasActiveAdminAccess } from "./auth/adminAccess";

type Access = "checking" | "allowed" | "denied";

/**
 * Admin access gate: an active admin profile attached to the restored
 * Supabase Auth session is required in every build.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Access>("checking");

  useEffect(() => {
    const client = supabase;
    if (!client) {
      setState("denied");
      return;
    }

    let active = true;
    let checkId = 0;
    const check = async () => {
      const currentCheck = ++checkId;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (!session) {
        if (active && currentCheck === checkId) setState("denied");
        return;
      }
      const { data: profile, error } = await client
        .from("admin_profiles")
        .select("user_id, role, is_active")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (error || !hasActiveAdminAccess(profile)) {
        await client.auth.signOut();
        if (active && currentCheck === checkId) setState("denied");
        return;
      }
      if (active && currentCheck === checkId) setState("allowed");
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
