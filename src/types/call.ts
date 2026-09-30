import type { VideoSourceKind } from "@/services/signaling/protocol";

import type { HostPreview } from "./host";
import type { CallerDetails } from "./user";

export type CallType = "video" | "audio";

/**
 * Lifecycle of a single call attempt.
 *
 * Every stage below is driven by something that really happened — a lookup
 * answering, a host tapping Answer, ICE connecting. The one timer left in this
 * machine is the ring timeout, which is a real product deadline rather than a
 * stand-in for a network event.
 *
 * idle                   nothing started yet
 * preparing              session created locally
 * resolving              checking the Call ID, the profile and host presence.
 *                        Deliberately before any device is touched
 * requesting_permissions waiting on the browser permission prompt
 * inviting               invitation going out over signalling
 * ringing                the host is being alerted
 * accepted               host answered; they are choosing how to appear
 * source_selection       the host's own view of that choice
 * negotiating            SDP offer/answer in flight
 * connecting             negotiated, ICE establishing
 * active                 media is flowing
 * reconnecting           connectivity degraded; the call is NOT over
 * ending                 teardown in progress
 * ended                  finished normally
 * declined               the host declined
 * no_answer              nobody answered before the ring timeout
 * failed                 could not start or could not be recovered
 *
 * Naming follows the repository's existing snake_case statuses rather than the
 * kebab-case in the specification, so the union reads consistently with
 * `requesting_permissions`, which predates it.
 */
export type CallPhase =
  | "idle"
  | "preparing"
  | "resolving"
  | "requesting_permissions"
  | "inviting"
  | "ringing"
  | "accepted"
  | "source_selection"
  | "negotiating"
  | "connecting"
  | "active"
  | "reconnecting"
  | "ending"
  | "ended"
  | "declined"
  | "no_answer"
  | "failed";

/** Long-standing name for the same union; kept so existing imports still read well. */
export type CallStatus = CallPhase;

/**
 * Why a call could not start, or could not continue.
 *
 * A closed set, because each one has its own copy and its own recovery. The
 * reason is what the UI switches on; `error` alongside it is only the sentence
 * shown, and a raw exception is never either of them.
 */
export type CallFailureReason =
  | "permission_denied"
  | "host_offline"
  | "host_busy"
  | "signaling_unavailable"
  | "rtc_negotiation_failed"
  | "rtc_connection_lost"
  | "media_unavailable"
  | "source_unavailable"
  | "ring_timeout"
  | "call_declined";

/**
 * Paid access attached to a call.
 *
 * Present only when the caller arrived with a valid Subscription Access ID.
 * The credential itself is deliberately NOT here — only the record it resolved
 * to — so no plaintext reaches call history, state or a log.
 */
export interface CallAccessAuthorization {
  accessIdRecordId: string;
  planId: string;
  planName: string;
  /** From the plan at validation time; what the in-call limit counts down. */
  sessionDurationMinutes: number;
  validatedAt: number;
}

/**
 * How the remote participant is appearing, as the guest understands it.
 *
 * Kept separate from the call phase on purpose: a source that ends, or one that
 * cannot be delivered at all, says nothing about whether the call is connected.
 * Conflating them is what would make a finished clip look like a dropped call.
 */
export interface RemoteSourceState {
  kind: VideoSourceKind | null;
  /** Short-lived and authorised. Never persisted, never logged. */
  playbackUrl: string | null;
  /**
   * `storage_unreachable` is an infrastructure gap, not an empty profile. The
   * two must stay distinguishable — see `server/signaling/README.md`.
   */
  unavailableReason: "not_uploaded" | "storage_unreachable" | null;
}

export const EMPTY_REMOTE_SOURCE: RemoteSourceState = {
  kind: null,
  playbackUrl: null,
  unavailableReason: null,
};

export interface CallSession {
  /**
   * Route-level id for this attempt, and the key call history is written under.
   * Distinct from `callAttemptId`: this one is ours, that one is the
   * signalling service's. Never the Call ID — see `callId` below.
   */
  id: string;
  /**
   * The signalling service's id for this attempt, issued with the ephemeral
   * token that authorises it. Empty until the Call ID has been authorised.
   */
  callAttemptId: string;
  type: CallType;
  status: CallPhase;
  caller: CallerDetails;
  /**
   * The code the caller dialled. Identifies a profile; it is NOT a credential
   * and never authenticates anything.
   */
  callId: string;
  host: HostPreview | null;
  /** Epoch ms the call became active — the call timer reads from this. */
  startedAt: number | null;
  endedAt: number | null;
  /** User-facing reason the session failed, never a raw exception. */
  error: string | null;
  /** The classified reason, which the UI switches on. */
  failureReason: CallFailureReason | null;
  /** Set when this call was authorised by a Subscription Access ID. */
  access: CallAccessAuthorization | null;
  /** How the host chose to appear. */
  remoteSource: RemoteSourceState;
}

/** Statuses where the call is in flight and owns the camera/microphone. */
export const IN_FLIGHT_STATUSES: readonly CallPhase[] = [
  "preparing",
  "resolving",
  "requesting_permissions",
  "inviting",
  "ringing",
  "accepted",
  "source_selection",
  "negotiating",
  "connecting",
  "active",
  "reconnecting",
  "ending",
];

export function isInFlight(status: CallPhase): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

/**
 * Statuses where the call is over, whatever the outcome.
 *
 * `declined` and `no_answer` are terminal in their own right rather than
 * flavours of `ended`, because each one is a different screen with different
 * actions — and because history has to tell them apart.
 */
export const TERMINAL_STATUSES: readonly CallPhase[] = [
  "ended",
  "declined",
  "no_answer",
  "failed",
];

export function isTerminal(status: CallPhase): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether media is actually up. `reconnecting` counts: the peer connection is
 * still there, the tracks are still live, and the timer keeps running.
 */
export function isConnected(status: CallPhase): boolean {
  return status === "active" || status === "reconnecting";
}
