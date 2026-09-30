import { EMPTY_CALLER } from "@/lib/constants";
import type { VideoSourceKind } from "@/services/signaling/protocol";
import type {
  CallAccessAuthorization,
  CallFailureReason,
  CallPhase,
  CallSession,
  CallType,
  RemoteSourceState,
} from "@/types/call";
import { EMPTY_REMOTE_SOURCE } from "@/types/call";
import type { HostPreview } from "@/types/host";
import type { MediaPermissionState } from "@/types/media";
import type { CallerDetails } from "@/types/user";

export interface CallSessionState extends CallSession {
  /** Last known camera/microphone permission for this session. */
  permission: MediaPermissionState;
  /**
   * Incremented by every REQUEST_PERMISSIONS. The call screen keys its device
   * request on it, so a re-render can never ask for the camera twice while one
   * attempt is already in flight.
   */
  attempt: number;
}

export type CallSessionAction =
  | { type: "SET_CALL_TYPE"; callType: CallType }
  | { type: "SET_CALLER_DETAILS"; caller: CallerDetails }
  | { type: "SET_CALL_ID"; callId: string }
  | { type: "SET_HOST"; host: HostPreview | null }
  /** Paid access, validated before any device was requested. */
  | { type: "SET_ACCESS"; access: CallAccessAuthorization | null }
  /** Caller submitted the join form: a session now exists locally. */
  | { type: "START_SESSION"; id: string }
  /** Checking the Call ID, the profile and host presence — before any device. */
  | { type: "START_RESOLVING" }
  /**
   * The Call ID was authorised and a host is available. Carries the attempt id
   * the signalling service minted alongside the ephemeral token.
   */
  | { type: "HOST_AVAILABLE"; callAttemptId: string }
  | { type: "REQUEST_PERMISSIONS" }
  | { type: "PERMISSIONS_GRANTED" }
  | { type: "PERMISSIONS_DENIED"; error: string }
  /** Invitation going out over signalling. */
  | { type: "START_INVITING" }
  /** The host is being alerted. */
  | { type: "START_RINGING" }
  /** The host tapped Answer. They are now choosing how to appear. */
  | { type: "CALL_ACCEPTED" }
  /** Host-side only: the source sheet is open. */
  | { type: "START_SOURCE_SELECTION" }
  /** What the host chose, and whether it can actually be delivered. */
  | { type: "SET_REMOTE_SOURCE"; source: Partial<RemoteSourceState> }
  | { type: "START_NEGOTIATING" }
  | { type: "START_CONNECTING" }
  /** Media is flowing. Starts the call timer, once. */
  | { type: "CALL_CONNECTED" }
  /** Connectivity degraded. The call is NOT over and the timer keeps running. */
  | { type: "CONNECTION_DEGRADED" }
  /** Connectivity came back on the same peer connection and the same session. */
  | { type: "CONNECTION_RESTORED" }
  /** Teardown has begun; nothing may drag the call back from here. */
  | { type: "START_ENDING" }
  | { type: "END_CALL" }
  | { type: "CALL_DECLINED" }
  | { type: "CALL_NO_ANSWER" }
  | { type: "FAIL_CALL"; reason: CallFailureReason; error: string }
  | { type: "RESET_CALL" };

export const initialCallSessionState: CallSessionState = {
  id: "",
  callAttemptId: "",
  type: "video",
  status: "idle",
  caller: EMPTY_CALLER,
  callId: "",
  host: null,
  startedAt: null,
  endedAt: null,
  error: null,
  failureReason: null,
  access: null,
  remoteSource: EMPTY_REMOTE_SOURCE,
  permission: "unknown",
  attempt: 0,
};

/**
 * Where a call may legitimately be when a given action arrives.
 *
 * This is the whole defence against out-of-order signalling. Messages do not
 * arrive in the order a happy path would like: a decline can land while an offer
 * is still being processed, an ICE state can flap after somebody hung up, and a
 * ring timeout can fire just as an answer arrives. Guarding here means the late
 * one is dropped rather than resurrecting a finished call.
 *
 * An action absent from this table is allowed from anywhere.
 */
const ALLOWED_FROM: Partial<Record<CallSessionAction["type"], readonly CallPhase[]>> = {
  START_RESOLVING: ["preparing", "failed"],
  HOST_AVAILABLE: ["resolving"],
  REQUEST_PERMISSIONS: ["preparing", "resolving", "failed"],
  PERMISSIONS_GRANTED: ["requesting_permissions"],
  PERMISSIONS_DENIED: ["requesting_permissions"],
  START_INVITING: ["requesting_permissions", "resolving", "preparing"],
  START_RINGING: ["inviting", "connecting"],
  CALL_ACCEPTED: ["ringing", "inviting"],
  START_SOURCE_SELECTION: ["accepted"],
  START_NEGOTIATING: ["accepted", "source_selection", "ringing"],
  START_CONNECTING: ["preparing", "requesting_permissions", "negotiating", "accepted", "source_selection"],
  CALL_CONNECTED: ["negotiating", "connecting", "accepted", "source_selection", "ringing", "reconnecting"],
  CONNECTION_DEGRADED: ["active"],
  CONNECTION_RESTORED: ["reconnecting"],
  // A decline or a timeout only means anything while nobody has answered.
  CALL_DECLINED: ["inviting", "ringing"],
  CALL_NO_ANSWER: ["inviting", "ringing"],
  START_ENDING: [
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
  ],
  // Reachable from `ending` as well, so a normal teardown completes.
  END_CALL: [
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
  ],
  FAIL_CALL: [
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
  ],
};

function isAllowed(action: CallSessionAction, status: CallPhase): boolean {
  const allowed = ALLOWED_FROM[action.type];
  return allowed === undefined || allowed.includes(status);
}

export function callSessionReducer(state: CallSessionState, action: CallSessionAction): CallSessionState {
  if (!isAllowed(action, state.status)) {
    return state;
  }

  switch (action.type) {
    case "SET_CALL_TYPE":
      return { ...state, type: action.callType };

    case "SET_CALLER_DETAILS":
      return { ...state, caller: action.caller };

    case "SET_CALL_ID":
      return { ...state, callId: action.callId };

    case "SET_HOST":
      return { ...state, host: action.host };

    case "SET_ACCESS":
      return { ...state, access: action.access };

    case "START_SESSION":
      return {
        ...state,
        id: action.id,
        // A new attempt is a new attempt on the service too. Carrying the old id
        // over would let a finished call's messages be applied to this one.
        callAttemptId: "",
        status: "preparing",
        startedAt: null,
        endedAt: null,
        error: null,
        failureReason: null,
        remoteSource: EMPTY_REMOTE_SOURCE,
        // A fresh attempt re-reads the permission rather than trusting the
        // answer a previous attempt got.
        permission: "unknown",
        attempt: 0,
      };

    case "START_RESOLVING":
      return { ...state, status: "resolving", error: null, failureReason: null };

    case "HOST_AVAILABLE":
      return { ...state, callAttemptId: action.callAttemptId };

    case "REQUEST_PERMISSIONS":
      return {
        ...state,
        status: "requesting_permissions",
        permission: "prompt",
        error: null,
        failureReason: null,
        attempt: state.attempt + 1,
      };

    /**
     * Devices are ready. Where that leads depends on whether this call has a
     * real host to ring: with signalling it goes on to invite, and without one
     * the legacy simulated path still starts connecting. Both are decided by the
     * caller of this action, so the reducer only records the grant.
     */
    case "PERMISSIONS_GRANTED":
      return { ...state, permission: "granted", error: null, failureReason: null };

    case "PERMISSIONS_DENIED":
      return {
        ...state,
        status: "failed",
        permission: "denied",
        error: action.error,
        failureReason: "permission_denied",
      };

    case "START_INVITING":
      return { ...state, status: "inviting", error: null, failureReason: null };

    case "START_RINGING":
      return { ...state, status: "ringing" };

    case "CALL_ACCEPTED":
      // Answered, but not yet connected: the host still has to choose a source.
      // The caller sees "Connecting…" from here rather than a continuing ring.
      return { ...state, status: "accepted" };

    case "START_SOURCE_SELECTION":
      return { ...state, status: "source_selection" };

    case "SET_REMOTE_SOURCE":
      return { ...state, remoteSource: { ...state.remoteSource, ...action.source } };

    case "START_NEGOTIATING":
      return { ...state, status: "negotiating" };

    case "START_CONNECTING":
      return { ...state, status: "connecting", error: null };

    /**
     * Written once. A reconnect returns here, and `startedAt` must not move —
     * the call timer counts the conversation, not the current ICE session.
     */
    case "CALL_CONNECTED":
      return { ...state, status: "active", startedAt: state.startedAt ?? Date.now() };

    case "CONNECTION_DEGRADED":
      return { ...state, status: "reconnecting" };

    case "CONNECTION_RESTORED":
      return { ...state, status: "active" };

    case "START_ENDING":
      return { ...state, status: "ending" };

    case "END_CALL":
      return { ...state, status: "ended", endedAt: Date.now() };

    case "CALL_DECLINED":
      return {
        ...state,
        status: "declined",
        endedAt: Date.now(),
        failureReason: "call_declined",
      };

    case "CALL_NO_ANSWER":
      return {
        ...state,
        status: "no_answer",
        endedAt: Date.now(),
        failureReason: "ring_timeout",
      };

    case "FAIL_CALL":
      return {
        ...state,
        status: "failed",
        error: action.error,
        failureReason: action.reason,
        endedAt: Date.now(),
      };

    // The chosen call type survives a reset so returning to the call-type
    // screen shows what the caller picked last.
    case "RESET_CALL":
      return { ...initialCallSessionState, type: state.type };
  }
}
