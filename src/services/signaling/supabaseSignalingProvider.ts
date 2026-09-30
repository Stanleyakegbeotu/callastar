import {
  SignalingUnavailableError,
  type InviteCallInput,
  type SignalingCredentials,
  type SignalingListener,
  type SignalingProvider,
  type SignalingStatus,
} from "./provider";
import type {
  CallEndReason,
  PresenceState,
  SignalDescription,
  SignalIceCandidate,
  VideoSourceKind,
} from "./protocol";

/**
 * Signalling over Supabase Realtime — deliberately unimplemented.
 *
 * The same pattern as `supabaseAdminRepository.ts`: the seam is real, the
 * implementation is not, and every method says so rather than quietly doing
 * nothing. Supabase must not be connected without that being an explicit
 * decision, and a provider that silently accepted calls it could not deliver
 * would make an unfinished migration look like a working one.
 *
 * What finishing this needs:
 *
 *   - a Realtime channel per call attempt, joined only with a token that
 *     authorises that one attempt (see the ephemeral tokens in
 *     `server/signaling`), so a guest cannot subscribe to every host's channel
 *   - presence through Realtime Presence, which expires on disconnect, rather
 *     than a row somebody has to remember to clear
 *   - an Edge Function to mint the guest token after a Call ID resolves, and a
 *     second to resolve a media asset id into a short-lived playback URL
 *   - server-side rate limiting on Call ID lookup and invitation
 *
 * Until then `VITE_SIGNALING_TRANSPORT=websocket` with the service in
 * `server/signaling` is the working path.
 */
function notImplemented(): never {
  throw new SignalingUnavailableError(
    "Supabase Realtime signalling is not implemented yet. Use VITE_SIGNALING_TRANSPORT=websocket.",
  );
}

export const supabaseSignalingProvider: SignalingProvider = {
  status: "idle" as SignalingStatus,
  configured: false,

  async connect(_credentials: SignalingCredentials) {
    notImplemented();
  },
  async disconnect() {
    // Closing something that was never opened is not an error.
  },
  async setPresence(_profileId: string, _presence: PresenceState) {
    notImplemented();
  },
  async inviteCall(_input: InviteCallInput) {
    notImplemented();
  },
  async acceptCall(_callAttemptId: string) {
    notImplemented();
  },
  async declineCall(_callAttemptId: string) {
    notImplemented();
  },
  async cancelCall(_callAttemptId: string) {
    notImplemented();
  },
  async endCall(_callAttemptId: string, _reason: CallEndReason) {
    notImplemented();
  },
  async selectSource(_callAttemptId: string, _sourceKind: VideoSourceKind, _mediaAssetId?: string) {
    notImplemented();
  },
  async markConnected(_callAttemptId: string) {
    notImplemented();
  },
  async sendDescription(_callAttemptId: string, _description: SignalDescription) {
    notImplemented();
  },
  async sendIceCandidate(_callAttemptId: string, _candidate: SignalIceCandidate) {
    notImplemented();
  },
  subscribe(_listener: SignalingListener) {
    return () => {};
  },
};
