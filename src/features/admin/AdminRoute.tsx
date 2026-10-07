import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { supabase } from "@/lib/supabase/client";
import { withDeadline } from "@/lib/withDeadline";
import { productionDiagnostic } from "@/lib/productionDiagnostics";

import { hasActiveAdminAccess } from "./auth/adminAccess";

type Access = "checking" | "allowed" | "denied" | "error";

/**
 * Admin access gate: an active admin profile attached to the restored
 * Supabase Auth session is required in every build.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Access>("checking");
  const [nonce, setNonce] = useState(0);

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
      try {
      const {
        data: { session },
      } = await withDeadline(client.auth.getSession());
      if (!session) {
        if (active && currentCheck === checkId) setState("denied");
        return;
      }
      const { data: profile, error } = await withDeadline(client
        .from("admin_profiles")
        .select("user_id, role, is_active")
        .eq("user_id", session.user.id)
        .maybeSingle());
      if (error) throw error;
      if (!hasActiveAdminAccess(profile)) {
        await client.auth.signOut();
        if (active && currentCheck === checkId) setState("denied");
        return;
      }
      if (active && currentCheck === checkId) setState("allowed");
      } catch {
        productionDiagnostic("ADMIN_ROUTE_LOAD_FAILED", { stage: "auth_check" });
        if (active && currentCheck === checkId) setState("error");
      }
    };

    void check();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const { data: listener } = client.auth.onAuthStateChange(() => {
      // Leave the auth callback before starting any Supabase request.
      const timer = setTimeout(() => { timers.delete(timer); if (active) void check(); }, 0);
      timers.add(timer);
    });

    return () => {
      active = false;
      timers.forEach(clearTimeout);
      listener.subscription.unsubscribe();
    };
  }, [nonce]);

  if (state === "checking") return <main className="admin-auth">Checking access…</main>;
  if (state === "error") return <main className="admin-auth" role="alert">Unable to check Admin access.<button className="admin-button admin-button-primary" onClick={() => { setState("checking"); setNonce((n) => n + 1); }}>Try Again</button></main>;
  return state === "allowed" ? <>{children}</> : <Navigate to="/admin/login" replace />;
}

export default AdminRoute;
