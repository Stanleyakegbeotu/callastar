import type {
  CallEndReason,
  CallRole,
  PresenceState,
  ServerMessage,
  SignalCaller,
  SignalCallType,
  SignalDescription,
  SignalIceCandidate,
  VideoSourceKind,
} from "./protocol";

/**
 * The seam between the call UI and whatever actually moves signalling messages.
 *
 * The screens know this interface and nothing else — no socket, no channel, no
 * SDK. Moving from the bundled WebSocket service to Supabase Realtime, or to a
 * managed RTC provider, is then a new implementation of this file's contract and
 * no change to a single call screen.
 *
 * Signalling is call control only. Media never passes through here.
 */

export type SignalingStatus =
  /** Nothing attempted yet. */
  | "idle"
  /** Socket opening, or handshake in flight. */
  | "connecting"
  /** Handshake accepted. The only state in which messages really go out. */
  | "open"
  /** Lost and retrying, with backoff. A live call may survive this. */
  | "reconnecting"
  /** Closed deliberately. */
  | "closed"
  /** Gave up, or was refused. `detail` says why. */
  | "failed";

/**
 * How a socket proves what it may do.
 *
 * A guest presents the ephemeral token minted when their Call ID was resolved,
 * good for one call attempt. A host presents its operator credential and names
 * the profile it is operating. A Call ID is never a credential — knowing one is
 * permission to ring a profile, not to act as it.
 */
export interface SignalingCredentials {
  role: CallRole;
  token: string;
  /** Host only. */
  profileId?: string;
  /** Host only: the normalised Call ID this socket answers for. */
  callIdKey?: string;
}

export interface InviteCallInput {
  callAttemptId: string;
  /** Normalised Call ID. The service resolves it; the client never learns more. */
  callIdKey: string;
  callType: SignalCallType;
  caller: SignalCaller;
}

export interface SignalingListener {
  /** Every validated message from the service. Invalid frames never arrive. */
  onMessage?: (message: ServerMessage) => void;
  onStatus?: (status: SignalingStatus, detail?: string) => void;
}

export interface SignalingProvider {
  readonly status: SignalingStatus;
  /** True when this provider has somewhere to connect to at all. */
  readonly configured: boolean;

  connect(credentials: SignalingCredentials): Promise<void>;
  disconnect(): Promise<void>;

  setPresence(profileId: string, presence: PresenceState): Promise<void>;

  inviteCall(input: InviteCallInput): Promise<void>;
  acceptCall(callAttemptId: string): Promise<void>;
  declineCall(callAttemptId: string): Promise<void>;
  cancelCall(callAttemptId: string): Promise<void>;
  endCall(callAttemptId: string, reason: CallEndReason): Promise<void>;

  /** Metadata only: the asset reference, never a storage URL from the browser. */
  selectSource(callAttemptId: string, sourceKind: VideoSourceKind, mediaAssetId?: string): Promise<void>;
  /** Media is flowing, so the other side can retire its connecting UI. */
  markConnected(callAttemptId: string): Promise<void>;

  sendDescription(callAttemptId: string, description: SignalDescription): Promise<void>;
  sendIceCandidate(callAttemptId: string, candidate: SignalIceCandidate): Promise<void>;

  subscribe(listener: SignalingListener): () => void;
}

/**
 * Raised when live calling is used without a configured service.
 *
 * Deliberately an error rather than a quiet no-op. There is no local transport
 * that can reach a second phone, so a provider that silently accepted calls it
 * could not deliver would make a broken deployment look like a working one —
 * the same reason `adminDataMode` never falls back from Supabase to local.
 */
export class SignalingUnavailableError extends Error {
  constructor(message = "Live calling is not configured. Set VITE_SIGNALING_URL.") {
    super(message);
    this.name = "SignalingUnavailableError";
  }
}
