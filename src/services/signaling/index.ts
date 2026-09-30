import { SIGNALING, isLiveCallingConfigured } from "@/lib/config";

import {
  SignalingUnavailableError,
  type InviteCallInput,
  type SignalingCredentials,
  type SignalingListener,
  type SignalingProvider,
} from "./provider";
import { supabaseSignalingProvider } from "./supabaseSignalingProvider";
import { WebSocketSignalingProvider } from "./websocketSignalingProvider";

export * from "./protocol";
export * from "./provider";

/**
 * Stands in when no signalling service is configured.
 *
 * Every call-control method refuses. That is the point: there is no local
 * transport that can reach a second phone, so a provider that silently accepted
 * an invitation it could not deliver would leave a caller ringing a host who
 * will never hear it. The UI asks `configured` first and offers the simulated
 * path instead, rather than discovering this mid-call.
 */
const unconfiguredProvider: SignalingProvider = {
  status: "idle",
  configured: false,

  async connect(_credentials: SignalingCredentials) {
    throw new SignalingUnavailableError();
  },
  async disconnect() {},
  async setPresence() {
    throw new SignalingUnavailableError();
  },
  async inviteCall(_input: InviteCallInput) {
    throw new SignalingUnavailableError();
  },
  async acceptCall() {
    throw new SignalingUnavailableError();
  },
  async declineCall() {
    throw new SignalingUnavailableError();
  },
  async cancelCall() {
    throw new SignalingUnavailableError();
  },
  async endCall() {
    throw new SignalingUnavailableError();
  },
  async selectSource() {
    throw new SignalingUnavailableError();
  },
  async markConnected() {
    throw new SignalingUnavailableError();
  },
  async sendDescription() {
    throw new SignalingUnavailableError();
  },
  async sendIceCandidate() {
    throw new SignalingUnavailableError();
  },
  subscribe(_listener: SignalingListener) {
    return () => {};
  },
};

/**
 * Transport is configuration, never a runtime fallback — the same rule
 * `getAdminRepository` follows. A failing WebSocket service must not quietly
 * start doing something else that only appears to work.
 */
function selectProvider(): SignalingProvider {
  if (SIGNALING.transport === "supabase") return supabaseSignalingProvider;
  if (!isLiveCallingConfigured) return unconfiguredProvider;
  return new WebSocketSignalingProvider(SIGNALING.url);
}

/**
 * One socket for the whole tab.
 *
 * A module singleton on purpose: a host browsing the dashboard and a call screen
 * mounting are the same connection, so an incoming call reaches whichever page
 * the operator happens to be on.
 */
export const signalingProvider: SignalingProvider = selectProvider();

/** Whether live calling can be attempted at all in this build. */
export const isLiveSignalingAvailable = signalingProvider.configured;
