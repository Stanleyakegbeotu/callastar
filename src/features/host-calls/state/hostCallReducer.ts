import type { PresenceState, SignalCallType, SignalCaller, VideoSourceKind } from "@/services/signaling";
import type { CallFailureReason } from "@/types/call";

/**
 * The operator's side of a call.
 *
 * A separate machine from the guest's, because the two are genuinely different
 * shapes: a host is a long-lived presence that calls arrive at, not a single
 * attempt with a beginning and an end. One operator handles many calls over one
 * connection, so this outlives any of them.
 *
 * One call at a time in this phase. A second caller is answered `busy` by the
 * service before it ever reaches here, and nothing queues — see
 * `SignalingHub.onInvite`.
 */
export type HostCallPhase =
  /** No signalling connection, or Receive Calls is off. */
  | "offline"
  /** Connected and taking calls. */
  | "available"
  /** A call is ringing. */
  | "incoming"
  /** Answer was tapped; about to choose how to appear. */
  | "accepting"
  /** The source sheet is open. */
  | "source_selection"
  /** A source is chosen; negotiating and establishing ICE. */
  | "connecting"
  /** Media is flowing. */
  | "in_call"
  /** Teardown in progress. */
  | "ending";

/**
 * The call currently on this operator's screen.
 *
 * `ringExpiresAt` comes from the service so both ends time out on the same
 * deadline, rather than each guessing when the other gave up.
 */
export interface HostIncomingCall {
  callAttemptId: string;
  profileId: string;
  callType: SignalCallType;
  caller: SignalCaller;
  ringingSince: number;
  ringExpiresAt: number;
}

/** Why the last call on this screen finished, so the operator can be told. */
export type HostCallOutcome =
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "no_answer" }
  | { kind: "ended"; durationSeconds: number | null }
  /**
   * The caller was paywalled. This has to stay distinct: showing an operator
   * "Network failed" would send them looking for a fault that does not exist.
   */
  | { kind: "subscription_required" }
  | { kind: "failed"; reason: CallFailureReason };

export interface HostCallState {
  phase: HostCallPhase;
  /** What the operator has asked for, independent of whether it is achieved. */
  receiveCallsRequested: boolean;
  /** What the service last confirmed. */
  presence: PresenceState;
  call: HostIncomingCall | null;
  /** The source chosen for the CURRENT call only — never saved to the profile. */
  selectedSource: VideoSourceKind | null;
  /** Epoch ms the source-selection window closes. */
  sourceDeadline: number | null;
  startedAt: number | null;
  outcome: HostCallOutcome | null;
  /** Operator-facing sentence, never a raw exception. */
  error: string | null;
}

export const initialHostCallState: HostCallState = {
  phase: "offline",
  receiveCallsRequested: false,
  presence: "offline",
  call: null,
  selectedSource: null,
  sourceDeadline: null,
  startedAt: null,
  outcome: null,
  error: null,
};

export type HostCallAction =
  /** The operator turned Receive Calls on or off. */
  | { type: "SET_RECEIVE_CALLS"; enabled: boolean }
  /** What the service says our presence is. It, not us, is authoritative. */
  | { type: "PRESENCE_CONFIRMED"; presence: PresenceState }
  /** The signalling socket went away; presence cannot be trusted any more. */
  | { type: "SIGNALING_LOST"; error: string | null }
  | { type: "INCOMING_CALL"; call: HostIncomingCall }
  | { type: "ANSWER" }
  | { type: "OPEN_SOURCE_SELECTION"; deadline: number }
  | { type: "SELECT_SOURCE"; source: VideoSourceKind }
  | { type: "START_CONNECTING" }
  | { type: "CALL_CONNECTED" }
  | { type: "DECLINE" }
  /** The guest gave up before we answered. */
  | { type: "CALLER_CANCELLED" }
  | { type: "RING_TIMED_OUT" }
  | { type: "START_ENDING" }
  | { type: "CALL_ENDED"; outcome: HostCallOutcome }
  | { type: "FAIL"; reason: CallFailureReason; error: string }
  /** Clears the finished-call notice so the screen returns to waiting. */
  | { type: "DISMISS_OUTCOME" };

/**
 * Phases an action may arrive in.
 *
 * Same reasoning as the guest reducer: signalling messages do not queue politely.
 * A cancel can land while the operator's thumb is on Answer, and a ring timeout
 * can fire in the same tick as an accept. Guarding here is what stops a stale
 * incoming modal reappearing from a message that arrived late.
 */
const ALLOWED_FROM: Partial<Record<HostCallAction["type"], readonly HostCallPhase[]>> = {
  // Only while nothing is in progress: a stray toggle must not drop a live call.
  INCOMING_CALL: ["available"],
  ANSWER: ["incoming"],
  OPEN_SOURCE_SELECTION: ["accepting"],
  SELECT_SOURCE: ["accepting", "source_selection"],
  START_CONNECTING: ["source_selection", "accepting"],
  CALL_CONNECTED: ["connecting", "source_selection"],
  DECLINE: ["incoming"],
  CALLER_CANCELLED: ["incoming", "accepting", "source_selection", "connecting"],
  RING_TIMED_OUT: ["incoming"],
  START_ENDING: ["accepting", "source_selection", "connecting", "in_call"],
  CALL_ENDED: ["incoming", "accepting", "source_selection", "connecting", "in_call", "ending"],
};

function isAllowed(action: HostCallAction, phase: HostCallPhase): boolean {
  const allowed = ALLOWED_FROM[action.type];
  return allowed === undefined || allowed.includes(phase);
}

/** Back to waiting, with the call cleared and the outcome kept to show. */
function settle(state: HostCallState, outcome: HostCallOutcome): HostCallState {
  return {
    ...state,
    // Availability follows the operator's own switch, not the last call: someone
    // who is taking calls is still taking calls after one finishes.
    phase: state.receiveCallsRequested ? "available" : "offline",
    call: null,
    selectedSource: null,
    sourceDeadline: null,
    startedAt: null,
    outcome,
  };
}

export function hostCallReducer(state: HostCallState, action: HostCallAction): HostCallState {
  if (!isAllowed(action, state.phase)) return state;

  switch (action.type) {
    case "SET_RECEIVE_CALLS": {
      // Never let the switch disturb a call in progress. Turning it off during
      // one means "stop taking new calls", not "hang up on this person".
      const busy = state.phase !== "offline" && state.phase !== "available";
      return {
        ...state,
        receiveCallsRequested: action.enabled,
        phase: busy ? state.phase : action.enabled ? state.phase : "offline",
        error: null,
      };
    }

    /**
     * Presence is the service's to confirm, and `busy`/`ringing` are its to
     * assign. We only mirror it — a local guess about being online is exactly
     * how a profile ends up falsely reachable.
     */
    case "PRESENCE_CONFIRMED": {
      const busy = state.phase !== "offline" && state.phase !== "available";
      return {
        ...state,
        presence: action.presence,
        phase: busy ? state.phase : action.presence === "available" ? "available" : "offline",
      };
    }

    case "SIGNALING_LOST":
      // Without a socket there is no presence, whatever the operator asked for.
      return {
        ...state,
        phase: "offline",
        presence: "offline",
        call: null,
        selectedSource: null,
        sourceDeadline: null,
        error: action.error,
      };

    case "INCOMING_CALL":
      return { ...state, phase: "incoming", call: action.call, outcome: null, error: null };

    case "ANSWER":
      // Answering does NOT start publishing video. It opens the choice of how to
      // appear, which is a separate step the operator makes per call.
      return { ...state, phase: "accepting" };

    case "OPEN_SOURCE_SELECTION":
      return { ...state, phase: "source_selection", sourceDeadline: action.deadline };

    case "SELECT_SOURCE":
      // Per call only. The profile is not modified by this choice.
      return { ...state, selectedSource: action.source, sourceDeadline: null };

    case "START_CONNECTING":
      return { ...state, phase: "connecting" };

    case "CALL_CONNECTED":
      return { ...state, phase: "in_call", startedAt: state.startedAt ?? Date.now() };

    case "DECLINE":
      return settle(state, { kind: "declined" });

    case "CALLER_CANCELLED":
      return settle(state, { kind: "cancelled" });

    case "RING_TIMED_OUT":
      return settle(state, { kind: "no_answer" });

    case "START_ENDING":
      return { ...state, phase: "ending" };

    case "CALL_ENDED":
      return settle(state, action.outcome);

    case "FAIL":
      return { ...settle(state, { kind: "failed", reason: action.reason }), error: action.error };

    case "DISMISS_OUTCOME":
      return { ...state, outcome: null };
  }
}

/** Whether a call is on this operator's screen right now. */
export function hostIsBusy(phase: HostCallPhase): boolean {
  return phase !== "offline" && phase !== "available";
}
