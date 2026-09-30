import { describe, expect, it } from "vitest";

import { callSessionReducer, initialCallSessionState, type CallSessionAction } from "./callSessionReducer";
import type { CallSessionState } from "./callSessionReducer";

/** Applies a sequence, which is how the real reducer is always driven. */
function run(actions: CallSessionAction[], from: CallSessionState = initialCallSessionState): CallSessionState {
  return actions.reduce(callSessionReducer, from);
}

const HOST = {
  id: "prof_1",
  displayName: "Amara Vale",
  shortName: "Amara",
  avatarUrl: "",
};

/** A guest that has reached the point of ringing a real host. */
function ringing(): CallSessionState {
  return run([
    { type: "SET_HOST", host: HOST },
    { type: "SET_CALL_ID", callId: "CS-7K4P-Q9MX-2J8R" },
    { type: "START_SESSION", id: "cs_1" },
    { type: "START_RESOLVING" },
    { type: "HOST_AVAILABLE", callAttemptId: "att_1" },
    { type: "REQUEST_PERMISSIONS" },
    { type: "PERMISSIONS_GRANTED" },
    { type: "START_INVITING" },
    { type: "START_RINGING" },
  ]);
}

function connected(): CallSessionState {
  return run([{ type: "CALL_ACCEPTED" }, { type: "START_NEGOTIATING" }, { type: "CALL_CONNECTED" }], ringing());
}

describe("call session reducer", () => {
  it("checks the host before asking for any device", () => {
    // Section 29: the device-class check, the profile lookup and host presence
    // all happen before a permission prompt. Reaching `requesting_permissions`
    // must therefore be impossible without having resolved first.
    const straightToPermission = run([
      { type: "START_SESSION", id: "cs_1" },
      { type: "REQUEST_PERMISSIONS" },
    ]);
    expect(straightToPermission.status).toBe("requesting_permissions");

    // ...but HOST_AVAILABLE only lands while resolving, so an attempt id cannot
    // be adopted by a session that never checked.
    expect(straightToPermission.callAttemptId).toBe("");
    const late = callSessionReducer(straightToPermission, {
      type: "HOST_AVAILABLE",
      callAttemptId: "att_x",
    });
    expect(late.callAttemptId).toBe("");
  });

  it("granting permission does not by itself start connecting", () => {
    // The reducer records the grant; what happens next is the orchestrator's
    // decision, because a live call invites and a simulated one connects.
    const state = run([
      { type: "START_SESSION", id: "cs_1" },
      { type: "START_RESOLVING" },
      { type: "REQUEST_PERMISSIONS" },
      { type: "PERMISSIONS_GRANTED" },
    ]);
    expect(state.permission).toBe("granted");
    expect(state.status).toBe("requesting_permissions");
  });

  it("starts the timer once and keeps it across a reconnect", () => {
    // Section 107: a reconnect continues the same session. If `startedAt` moved,
    // the visible timer would jump backwards mid-call.
    const live = connected();
    expect(live.status).toBe("active");
    expect(live.startedAt).not.toBeNull();

    const degraded = callSessionReducer(live, { type: "CONNECTION_DEGRADED" });
    expect(degraded.status).toBe("reconnecting");
    expect(degraded.startedAt).toBe(live.startedAt);

    const restored = callSessionReducer(degraded, { type: "CONNECTION_RESTORED" });
    expect(restored.status).toBe("active");
    expect(restored.startedAt).toBe(live.startedAt);
    expect(restored.id).toBe(live.id);
    expect(restored.callAttemptId).toBe(live.callAttemptId);
  });

  it("reconnecting is not a terminal state and keeps the call", () => {
    const degraded = callSessionReducer(connected(), { type: "CONNECTION_DEGRADED" });
    expect(degraded.endedAt).toBeNull();
    expect(degraded.failureReason).toBeNull();
  });

  it("records a decline as its own outcome", () => {
    // Section 108: `declined` is not a flavour of `ended`. It is a different
    // screen with different actions, and history has to tell them apart.
    const state = callSessionReducer(ringing(), { type: "CALL_DECLINED" });
    expect(state.status).toBe("declined");
    expect(state.failureReason).toBe("call_declined");
    expect(state.endedAt).not.toBeNull();
    // Never connected, so there is no duration to report.
    expect(state.startedAt).toBeNull();
  });

  it("records no answer as its own outcome", () => {
    // Section 110.
    const state = callSessionReducer(ringing(), { type: "CALL_NO_ANSWER" });
    expect(state.status).toBe("no_answer");
    expect(state.failureReason).toBe("ring_timeout");
    expect(state.startedAt).toBeNull();
  });

  it("ignores a decline that arrives after the call was answered", () => {
    // Signalling does not queue politely. A decline racing an accept must not
    // tear down a call that is already up.
    const live = connected();
    expect(callSessionReducer(live, { type: "CALL_DECLINED" })).toBe(live);
    expect(callSessionReducer(live, { type: "CALL_NO_ANSWER" })).toBe(live);
  });

  it("ignores a ring timeout that fires after the host answered", () => {
    const accepted = callSessionReducer(ringing(), { type: "CALL_ACCEPTED" });
    expect(callSessionReducer(accepted, { type: "CALL_NO_ANSWER" })).toBe(accepted);
  });

  it("never brings a finished call back to life", () => {
    // A timer that fires after hangup, or an ICE state flapping on a closing
    // peer connection, must not move the session anywhere.
    const ended = callSessionReducer(connected(), { type: "END_CALL" });
    expect(ended.status).toBe("ended");

    for (const action of [
      { type: "CALL_CONNECTED" },
      { type: "START_RINGING" },
      { type: "CONNECTION_DEGRADED" },
      { type: "CALL_ACCEPTED" },
      { type: "START_NEGOTIATING" },
      { type: "END_CALL" },
      { type: "FAIL_CALL", reason: "rtc_connection_lost", error: "x" },
    ] satisfies CallSessionAction[]) {
      expect(callSessionReducer(ended, action)).toBe(ended);
    }
  });

  it("does not resurrect a declined call either", () => {
    const declined = callSessionReducer(ringing(), { type: "CALL_DECLINED" });
    expect(callSessionReducer(declined, { type: "CALL_ACCEPTED" })).toBe(declined);
    expect(callSessionReducer(declined, { type: "CALL_CONNECTED" })).toBe(declined);
  });

  it("classifies a permission denial rather than storing a raw error", () => {
    const state = run([
      { type: "START_SESSION", id: "cs_1" },
      { type: "START_RESOLVING" },
      { type: "REQUEST_PERMISSIONS" },
      { type: "PERMISSIONS_DENIED", error: "Camera or microphone access is blocked" },
    ]);
    expect(state.status).toBe("failed");
    expect(state.failureReason).toBe("permission_denied");
    expect(state.permission).toBe("denied");
  });

  it("classifies host unavailability without touching permission", () => {
    const state = run([
      { type: "START_SESSION", id: "cs_1" },
      { type: "START_RESOLVING" },
      { type: "FAIL_CALL", reason: "host_offline", error: "Amara isn't available right now." },
    ]);
    expect(state.failureReason).toBe("host_offline");
    expect(state.permission).toBe("unknown");
  });

  it("drops the previous attempt id when a new attempt starts", () => {
    // Start New Call is a NEW call. Carrying the old attempt id over would let a
    // finished call's signalling be applied to this one.
    const fresh = callSessionReducer(connected(), { type: "START_SESSION", id: "cs_2" });
    expect(fresh.id).toBe("cs_2");
    expect(fresh.callAttemptId).toBe("");
    expect(fresh.status).toBe("preparing");
    expect(fresh.startedAt).toBeNull();
    expect(fresh.remoteSource.kind).toBeNull();
  });

  it("tracks the host's chosen source separately from the call phase", () => {
    // A source that cannot be delivered says nothing about whether the call is
    // connected, so it must not be able to move the phase.
    const live = connected();
    const withSource = callSessionReducer(live, {
      type: "SET_REMOTE_SOURCE",
      source: { kind: "uploaded-source", unavailableReason: "storage_unreachable" },
    });
    expect(withSource.status).toBe("active");
    expect(withSource.remoteSource.unavailableReason).toBe("storage_unreachable");
    expect(withSource.remoteSource.playbackUrl).toBeNull();
  });

  it("keeps the chosen call type across a reset", () => {
    const reset = run([{ type: "SET_CALL_TYPE", callType: "audio" }, { type: "RESET_CALL" }]);
    expect(reset.type).toBe("audio");
    expect(reset.status).toBe("idle");
  });
});
