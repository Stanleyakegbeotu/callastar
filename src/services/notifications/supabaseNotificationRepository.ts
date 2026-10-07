import { requireSupabase } from "@/lib/supabase/client";
import type { NotificationRepository } from "./repository";
import type { AdminNotification, CreateNotificationInput, NotificationFilters, NotificationType } from "./types";

type Row = Record<string, any>;
const supported = new Set<NotificationType>(["subscription_requested", "payment_proof_submitted", "support_message_received", "support_conversation_started"]);
function mapRow(row: Row): AdminNotification {
  const type = supported.has(row.notification_type) ? row.notification_type as NotificationType : "support_message_received";
  return { id: row.id, type, title: row.title, body: row.body ?? "", entityKind: row.entity_kind, entityId: row.entity_id, createdAt: row.created_at, readAt: row.read_at };
}

export const supabaseNotificationRepository: NotificationRepository = {
  mode: "supabase",
  async create(input: CreateNotificationInput) {
    const typeMap: Record<NotificationType, string> = {
      subscription_requested: "purchase_intent", payment_proof_submitted: "payment_help_requested",
      support_message_received: "support_started", support_conversation_started: "support_started",
    };
    const idempotencyKey = `${typeMap[input.type]}:${input.entityKind}:${input.entityId}`.slice(0, 180);
    const { data, error } = await requireSupabase().functions.invoke("notify-admin", { body: { type: typeMap[input.type], idempotencyKey, entityId: input.entityId, summary: input.body } });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Notification service unavailable.");
    return { ...input, id: idempotencyKey, createdAt: new Date().toISOString(), readAt: null };
  },
  async list(filters?: NotificationFilters) {
    let query = requireSupabase().from("admin_notifications").select("*");
    if (filters?.unreadOnly) query = query.is("read_at", null);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapRow).slice(0, filters?.limit ?? 100);
  },
  async markRead(id) {
    const { error } = await requireSupabase().from("admin_notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  },
  async markAllRead() {
    const { error } = await requireSupabase().from("admin_notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
    if (error) throw error;
  },
  async countUnread() {
    const { count, error } = await requireSupabase().from("admin_notifications").select("id", { count: "exact", head: true }).is("read_at", null);
    if (error) throw error;
    return count ?? 0;
  },
};
