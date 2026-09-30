import { logDiagnostic } from "./utils";

/**
 * Cross-tab notice that something in local storage changed.
 *
 * While there is no backend, the admin dashboard and the public app are two tabs
 * over one IndexedDB. A customer waiting for a payment to be confirmed, or a
 * payment screen showing a support number, has no way of knowing that the other
 * tab wrote something — so writers say so here and readers look again.
 *
 * Deliberately only a hint. The message carries no data worth trusting: storage
 * stays the single source of truth, and every listener re-reads it rather than
 * believing what arrived on the channel.
 */
export const LOCAL_EVENT_CHANNEL = "callastar-local-events";

export type LocalEventType =
  | "subscription-confirmed"
  | "support-message"
  | "settings-updated";

export function broadcastLocalEvent(type: LocalEventType, payload: Record<string, string> = {}): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(LOCAL_EVENT_CHANNEL);
    channel.postMessage({ type, ...payload });
    channel.close();
  } catch (error) {
    // A tab that cannot broadcast still works; the other side polls as well.
    logDiagnostic("broadcast", error);
  }
}
