import type {
  CallEventType,
  CallSourceKind,
  CallSessionRecord,
  CallSessionStatus,
  SessionMetrics,
} from "./types";

/**
 * Everything derived from call sessions, defined once.
 *
 * Duration is the obvious trap: the on-screen timer is a rendering detail, so
 * it is never the stored truth. A call lasts from the moment it connected to
 * the moment it ended, and a call that never connected has no duration at all.
 */

const MILLISECONDS = 1000;

function secondsBetween(fromIso: string, toMs: number): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, Math.floor((toMs - from) / MILLISECONDS));
}

/**
 * Authoritative duration in seconds, or null when the call never connected.
 * A live call reports how long it has been running so far.
 */
export function getCallDuration(session: CallSessionRecord, now: number = Date.now()): number | null {
  if (!session.connectedAt) return null;
  if (session.durationSeconds !== null) return session.durationSeconds;
  if (session.endedAt) return secondsBetween(session.connectedAt, new Date(session.endedAt).getTime());
  return secondsBetween(session.connectedAt, now);
}

export function isSameLocalDay(iso: string, reference: Date = new Date()): boolean {
  const date = new Date(iso);
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

/** A call that connected and then finished normally. */
export function isCompleted(session: CallSessionRecord): boolean {
  return session.status === "ended" && session.connectedAt !== null;
}

export function computeSessionMetrics(sessions: CallSessionRecord[], now: Date = new Date()): SessionMetrics {
  let callsToday = 0;
  let completed = 0;
  let cancelledOrFailed = 0;
  let connectedTotal = 0;
  let connectedCount = 0;

  for (const session of sessions) {
    if (isSameLocalDay(session.createdAt, now)) callsToday += 1;
    if (session.status === "cancelled" || session.status === "failed") cancelledOrFailed += 1;

    if (isCompleted(session)) {
      completed += 1;
      const duration = getCallDuration(session, now.getTime());
      if (duration !== null) {
        connectedTotal += duration;
        connectedCount += 1;
      }
    }
  }

  return {
    total: sessions.length,
    callsToday,
    completed,
    cancelledOrFailed,
    averageConnectedSeconds: connectedCount === 0 ? null : Math.round(connectedTotal / connectedCount),
  };
}

export const SESSION_STATUS_LABELS: Record<CallSessionStatus, string> = {
  connecting: "Connecting",
  ringing: "Ringing",
  active: "Active",
  ended: "Ended",
  cancelled: "Cancelled",
  declined: "Declined",
  no_answer: "No answer",
  failed: "Failed",
};

/**
 * Restrained tones: blue in flight, green live, neutral done, red failed.
 *
 * Declined and unanswered calls are `warning` rather than `danger`: neither is a
 * fault, and colouring them like a failure would have operators investigating
 * calls that simply were not taken.
 */
export const SESSION_STATUS_TONE: Record<CallSessionStatus, string> = {
  connecting: "progress",
  ringing: "progress",
  active: "live",
  ended: "neutral",
  cancelled: "warning",
  declined: "warning",
  no_answer: "warning",
  failed: "danger",
};

/** Plain-language timeline labels. Raw event names never reach the screen. */
export const CALL_EVENT_LABELS: Record<CallEventType, string> = {
  session_created: "Session created",
  permissions_requested: "Device access requested",
  permissions_granted: "Camera and microphone granted",
  permissions_denied: "Device access denied",
  connecting: "Connecting",
  ringing: "Ringing",
  connected: "Connected",
  // Human sentences, per section 97. The operator reads the timeline, so it says
  // what happened rather than naming a protocol state.
  call_invited: "Call placed",
  call_accepted: "Incoming call accepted",
  source_selection_started: "Choosing how to appear",
  source_selected: "Call source selected",
  rtc_connecting: "Establishing connection",
  rtc_connected: "Connection established",
  rtc_reconnecting: "Connection temporarily interrupted",
  rtc_recovered: "Connection restored",
  rtc_failed: "Connection could not be restored",
  call_declined: "Call declined",
  call_no_answer: "No answer",
  camera_disabled: "Camera turned off",
  camera_enabled: "Camera turned on",
  microphone_muted: "Microphone muted",
  microphone_unmuted: "Microphone unmuted",
  subscription_check_started: "Subscription check started",
  subscription_access_granted: "Subscription access confirmed",
  subscription_required: "Subscription required — call ended",
  subscription_requested: "Access plan requested",
  subscription_confirmed: "Subscription confirmed by support",
  session_limit_reached: "Plan session time reached",
  remote_media_ended: "Remote media ended — reconnecting",
  ended: "Call ended",
  cancelled: "Call cancelled",
  failed: "Call failed",
};

export function describeCallEvent(type: CallEventType, callType?: "video" | "audio"): string {
  if (callType === "audio") {
    // An audio call has no camera and no source to choose, so the wording says
    // what actually happened rather than borrowing the video vocabulary.
    if (type === "permissions_granted") return "Microphone granted";
    if (type === "permissions_denied") return "Microphone access denied";
    if (type === "connected" || type === "rtc_connected") return "Microphone call connected";
    if (type === "source_selected") return "Live microphone";
  }
  return CALL_EVENT_LABELS[type];
}

/**
 * How the chosen source reads in a timeline.
 *
 * Kept here with the other wording so no screen invents its own. "Uploaded
 * source" deliberately describes the media MODE, not its origin — calling it AI
 * would assert something about the file that nothing here knows.
 */
export function describeSourceSelection(kind: string): string {
  if (kind === "live-camera") return "Live Camera selected";
  if (kind === "uploaded-source") return "Uploaded Source selected";
  return "Call source selected";
}

/**
 * How a settled source reads in a list.
 *
 * A dash rather than a guess when nothing was settled: a call that never
 * connected has no source, and inventing one would misreport history.
 */
export function describeSourceKind(kind: CallSourceKind | null): string {
  switch (kind) {
    case "live-camera":
      return "Live Camera";
    case "uploaded-source":
      return "Uploaded Source";
    case "live-microphone":
      return "Live Microphone";
    default:
      return "—";
  }
}

export type SessionDateRange = "all" | "today" | "7d" | "30d";

/** Start of a range as an ISO timestamp, or undefined for "all". */
export function rangeStart(range: SessionDateRange, now: Date = new Date()): string | undefined {
  if (range === "all") return undefined;
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = range === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * MILLISECONDS).toISOString();
}

/** Caller name, email, phone or host name — whatever the operator remembers. */
export function matchesSessionSearch(session: CallSessionRecord, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;

  return [
    session.caller.fullName,
    session.caller.email,
    session.caller.phone,
    session.profileName,
    session.callIdSnapshot,
  ].some((field) => field.toLowerCase().includes(needle));
}
