import { describe, expect, it } from "vitest";

import {
  hostCallReducer,
  hostIsBusy,
  initialHostCallState,
  type HostCallAction,
  type HostCallState,
  type HostIncomingCall,
} from "./hostCallReducer";

function run(actions: HostCallAction[], from: HostCallState = initialHostCallState): HostCallState {
  return actions.reduce(hostCallReducer, from);
}

const CALL: HostIncomingCall = {
  callAttemptId: "att_1",
  profileId: "prof_1",
  callType: "video",
  caller: { displayName: "John Williams" },
  ringingSince: 1_700_000_000_000,
  ringExpiresAt: 1_700_000_035_000,
};

/** An operator taking calls, as the service has confirmed. */
function available(): HostCallState {
  return run([
    { type: "SET_RECEIVE_CALLS", enabled: true },
    { type: "PRESENCE_CONFIRMED", presence: "available" },
  ]);
}

function incoming(): HostCallState {
  return hostCallReducer(available(), { type: "INCOMING_CALL", call: CALL });
}

describe("host call reducer", () => {
  it("is not available merely because the operator asked", () => {
    // Section 21/23: presence is a live socket the service confirms, not a local
    // flag. A host who has flipped the switch but has no connection is offline —
    // that is what stops a caller ringing a ghost.
    const asked = hostCallReducer(initialHostCallState, { type: "SET_RECEIVE_CALLS", enabled: true });
    expect(asked.receiveCallsRequested).toBe(true);
    expect(asked.presence).toBe("offline");
    expect(asked.phase).toBe("offline");

    // And a call cannot arrive at a host that is not available.
    expect(hostCallReducer(asked, { type: "INCOMING_CALL", call: CALL })).toBe(asked);
  });

  it("becomes available only once the service confirms", () => {
    const state = available();
    expect(state.phase).toBe("available");
    expect(state.presence).toBe("available");
  });

  it("answering opens the source choice rather than publishing video", () => {
    // Section 35: Answer must not start a camera. It opens the choice of how to
    // appear, which is a separate decision made per call.
    const answered = hostCallReducer(incoming(), { type: "ANSWER" });
    expect(answered.phase).toBe("accepting");
    expect(answered.selectedSource).toBeNull();
    expect(answered.startedAt).toBeNull();
  });

  it("keeps the source choice per call and never on the profile", () => {
    // Section 84: choosing Live Camera for one call does not change the profile.
    const chosen = run(
      [{ type: "ANSWER" }, { type: "OPEN_SOURCE_SELECTION", deadline: 1 }, { type: "SELECT_SOURCE", source: "live-camera" }],
      incoming(),
    );
    expect(chosen.selectedSource).toBe("live-camera");

    // The next call starts with no choice carried over.
    const afterCall = run(
      [{ type: "START_CONNECTING" }, { type: "CALL_CONNECTED" }, { type: "CALL_ENDED", outcome: { kind: "ended", durationSeconds: 42 } }],
      chosen,
    );
    expect(afterCall.selectedSource).toBeNull();
    const nextCall = hostCallReducer(afterCall, { type: "INCOMING_CALL", call: CALL });
    expect(nextCall.selectedSource).toBeNull();
  });

  it("clears the incoming call when the caller cancels", () => {
    // Section 109: the incoming screen must disappear at once, and a stale modal
    // must never reappear from a replayed message.
    const cancelled = hostCallReducer(incoming(), { type: "CALLER_CANCELLED" });
    expect(cancelled.phase).toBe("available");
    expect(cancelled.call).toBeNull();
    expect(cancelled.outcome).toEqual({ kind: "cancelled" });

    // A late duplicate cannot put the modal back.
    const replayed = hostCallReducer(cancelled, { type: "CALLER_CANCELLED" });
    expect(replayed.call).toBeNull();
  });

  it("clears the incoming call on ring timeout", () => {
    // Section 110.
    const timedOut = hostCallReducer(incoming(), { type: "RING_TIMED_OUT" });
    expect(timedOut.phase).toBe("available");
    expect(timedOut.call).toBeNull();
    expect(timedOut.outcome).toEqual({ kind: "no_answer" });
  });

  it("ignores a ring timeout once the operator has answered", () => {
    const answered = hostCallReducer(incoming(), { type: "ANSWER" });
    expect(hostCallReducer(answered, { type: "RING_TIMED_OUT" })).toBe(answered);
  });

  it("returns to available after a call, not to offline", () => {
    // Someone taking calls is still taking calls after one finishes.
    const ended = run(
      [
        { type: "ANSWER" },
        { type: "SELECT_SOURCE", source: "live-camera" },
        { type: "START_CONNECTING" },
        { type: "CALL_CONNECTED" },
        { type: "CALL_ENDED", outcome: { kind: "ended", durationSeconds: 90 } },
      ],
      incoming(),
    );
    expect(ended.phase).toBe("available");
    expect(ended.outcome).toEqual({ kind: "ended", durationSeconds: 90 });
  });

  it("stays offline after a call when Receive Calls was switched off", () => {
    const state = run(
      [
        { type: "ANSWER" },
        { type: "SELECT_SOURCE", source: "live-camera" },
        { type: "START_CONNECTING" },
        { type: "CALL_CONNECTED" },
        // Turned off mid-call: means "no more calls", not "hang up on this one".
        { type: "SET_RECEIVE_CALLS", enabled: false },
      ],
      incoming(),
    );
    expect(state.phase).toBe("in_call");

    const ended = hostCallReducer(state, { type: "CALL_ENDED", outcome: { kind: "ended", durationSeconds: 5 } });
    expect(ended.phase).toBe("offline");
  });

  it("never drops a live call because presence flapped", () => {
    const live = run(
      [{ type: "ANSWER" }, { type: "SELECT_SOURCE", source: "live-camera" }, { type: "START_CONNECTING" }, { type: "CALL_CONNECTED" }],
      incoming(),
    );
    const flapped = hostCallReducer(live, { type: "PRESENCE_CONFIRMED", presence: "busy" });
    expect(flapped.phase).toBe("in_call");
    expect(flapped.startedAt).toBe(live.startedAt);
  });

  it("keeps the subscription outcome distinct from a failure", () => {
    // Section 50: an operator must not be shown "Network failed" when the real
    // reason is that the caller needed a subscription.
    const live = run(
      [{ type: "ANSWER" }, { type: "SELECT_SOURCE", source: "live-camera" }, { type: "START_CONNECTING" }, { type: "CALL_CONNECTED" }],
      incoming(),
    );
    const ended = hostCallReducer(live, { type: "CALL_ENDED", outcome: { kind: "subscription_required" } });
    expect(ended.outcome).toEqual({ kind: "subscription_required" });
    expect(ended.error).toBeNull();
  });

  it("goes offline when the socket dies, whatever the operator asked for", () => {
    // Section 24: reachability is a live connection. Without one there is no
    // presence to claim.
    const lost = hostCallReducer(available(), { type: "SIGNALING_LOST", error: "Lost connection to CallaStar." });
    expect(lost.phase).toBe("offline");
    expect(lost.presence).toBe("offline");
    expect(lost.receiveCallsRequested).toBe(true);
  });

  it("takes an audio call straight to connecting, with no source to choose", () => {
    // Section 7: there is one way to be heard, so answering an audio call has
    // nothing to ask about. A source sheet here would be a question with a
    // single answer, and a deadline for it would be a deadline for nothing.
    const audioCall = { ...CALL, callType: "audio" as const };
    const incomingAudio = hostCallReducer(available(), { type: "INCOMING_CALL", call: audioCall });
    expect(incomingAudio.phase).toBe("incoming");

    const answered = hostCallReducer(incomingAudio, { type: "ANSWER" });
    expect(answered.phase).toBe("accepting");

    // The provider dispatches this directly for audio rather than opening a sheet.
    const connecting = hostCallReducer(answered, { type: "START_CONNECTING" });
    expect(connecting.phase).toBe("connecting");
    expect(connecting.selectedSource).toBeNull();
    expect(connecting.sourceDeadline).toBeNull();
  });

  it("runs an audio call through the same lifecycle as a video call", () => {
    // Section 2 and 17: one engine, one set of outcomes. Audio is not a parallel
    // implementation, so it must reach `in_call` and settle identically.
    const audioCall = { ...CALL, callType: "audio" as const };
    const live = run(
      [
        { type: "INCOMING_CALL", call: audioCall },
        { type: "ANSWER" },
        { type: "START_CONNECTING" },
        { type: "CALL_CONNECTED" },
      ],
      available(),
    );
    expect(live.phase).toBe("in_call");
    expect(live.startedAt).not.toBeNull();

    const ended = hostCallReducer(live, {
      type: "CALL_ENDED",
      outcome: { kind: "ended", durationSeconds: 30 },
    });
    expect(ended.phase).toBe("available");
  });

  it("declines an audio call without building anything", () => {
    const audioCall = { ...CALL, callType: "audio" as const };
    const declined = run(
      [{ type: "INCOMING_CALL", call: audioCall }, { type: "DECLINE" }],
      available(),
    );
    expect(declined.phase).toBe("available");
    expect(declined.outcome).toEqual({ kind: "declined" });
    expect(declined.selectedSource).toBeNull();
  });

  it("classifies a denied microphone as a permission failure, not a network one", () => {
    // Section 9: the caller must be told "Unable to connect", never "Network
    // Error", when the real cause is a blocked device.
    const audioCall = { ...CALL, callType: "audio" as const };
    const failed = run(
      [
        { type: "INCOMING_CALL", call: audioCall },
        { type: "ANSWER" },
        { type: "START_CONNECTING" },
        { type: "FAIL", reason: "permission_denied", error: "Microphone access is blocked." },
      ],
      available(),
    );
    expect(failed.outcome).toEqual({ kind: "failed", reason: "permission_denied" });
    expect(failed.phase).toBe("available");
  });

  it("reports busy for every phase a second caller must not interrupt", () => {
    // Section 95/111: one call at a time, and the first is unaffected.
    expect(hostIsBusy("offline")).toBe(false);
    expect(hostIsBusy("available")).toBe(false);
    for (const phase of ["incoming", "accepting", "source_selection", "connecting", "in_call", "ending"] as const) {
      expect(hostIsBusy(phase)).toBe(true);
    }
  });
});
