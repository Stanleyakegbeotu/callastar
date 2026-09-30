import { config } from "@/lib/config";
import { logDiagnostic } from "@/lib/utils";

/**
 * DEVELOPMENT-ONLY ADMIN ACCESS.
 *
 * While Supabase is deliberately not connected, the dashboard still has to be
 * usable. This grants a local session with no credentials at all — which is
 * safe only because `config.useDevelopmentAdminAuth` requires BOTH
 * `import.meta.env.DEV` and an explicit `VITE_ADMIN_AUTH_MODE=development`.
 * A production bundle evaluates that to false at build time, so this path
 * cannot ship as an authentication bypass.
 *
 * Nothing here is a credential, and no password is stored anywhere.
 */
const DEV_SESSION_KEY = "callastar.development-admin";

export function isDevelopmentAdminEnabled(): boolean {
  return config.useDevelopmentAdminAuth;
}

export function hasDevelopmentSession(): boolean {
  if (!isDevelopmentAdminEnabled()) return false;
  try {
    return sessionStorage.getItem(DEV_SESSION_KEY) === "active";
  } catch (error) {
    // Private windows and blocked storage: treat as signed out.
    logDiagnostic("dev-admin-session", error);
    return false;
  }
}

export function startDevelopmentSession(): void {
  if (!isDevelopmentAdminEnabled()) return;
  try {
    sessionStorage.setItem(DEV_SESSION_KEY, "active");
  } catch (error) {
    logDiagnostic("dev-admin-session", error);
  }
}

export function endDevelopmentSession(): void {
  try {
    sessionStorage.removeItem(DEV_SESSION_KEY);
  } catch (error) {
    logDiagnostic("dev-admin-session", error);
  }
}
