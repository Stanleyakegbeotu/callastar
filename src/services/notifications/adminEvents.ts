import { config } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";
import { logDiagnostic } from "@/lib/utils";

/** Best-effort event notification. Call, chat and purchase flows never depend on delivery. */
export function sendAdminEvent(type: string, entityId: string, summary: string): void {
  if (config.adminDataMode !== "supabase") return;
  const eventId = `${type}:${entityId}`.slice(0, 180);
  try {
    void requireSupabase().functions.invoke("notify-admin", { body: { type, entityId, summary, idempotencyKey: eventId } })
      .then(({ error, data }) => { if (error || data?.error) logDiagnostic("admin-notification", error ?? data.error); })
      .catch((error) => logDiagnostic("admin-notification", error));
  } catch (error) { logDiagnostic("admin-notification", error); }
}
