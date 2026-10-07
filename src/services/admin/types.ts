import type { CallType } from "@/types/call";

/**
 * The admin domain model.
 *
 * These names deliberately mirror the columns in
 * `supabase/migrations/*_callastar_core.sql` (hosts, host_media, call_ids,
 * call_sessions) so the Supabase repository can return the same shapes without
 * the admin UI changing. Nothing IndexedDB-specific — no Blob, no object URL —
 * appears in these types; binary data is fetched deliberately, by id.
 */

export type ProfileStatus = "active" | "inactive";

export type AssetKind = "avatar" | "cover" | "remote_video" | "remote_audio";

export interface HostProfile {
  id: string;
  displayName: string;
  shortBio: string;
  status: ProfileStatus;
  /** Counts entered by an administrator, before activity collected in CallaStar. */
  baseFollowerCount?: number;
  baseLikeCount?: number;
  trackedFollowerCount?: number;
  trackedLikeCount?: number;
  /** Display form, e.g. CS-7K4P-Q9MX-2J8R. One current Call ID per profile. */
  callId: string;
  /** Normalised lookup key for the same code; this is what the index holds. */
  callIdKey: string;
  avatarAssetId: string | null;
  coverAssetId?: string | null;
  remoteVideoAssetId: string | null;
  /**
   * The voice this profile is heard with on an audio call. Zero or one, like
   * the video: an audio call plays this rather than the video's soundtrack.
   */
  remoteAudioAssetId: string | null;
  /** ISO timestamps, as the database will return them. */
  createdAt: string;
  updatedAt: string;
}

/** Everything about a stored file except the bytes. */
export interface StoredAssetMeta {
  id: string;
  profileId: string;
  kind: AssetKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /** Extracted from the file where the browser can; null when it could not. */
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  onProgress?: (stage: string) => void;
  displayName: string;
  shortBio: string;
  status: ProfileStatus;
  baseFollowerCount?: number;
  baseLikeCount?: number;
  avatarFile?: File | null;
  coverFile?: File | null;
  remoteVideoFile?: File | null;
  remoteAudioFile?: File | null;
}

export interface UpdateProfileInput {
  displayName?: string;
  shortBio?: string;
  status?: ProfileStatus;
  baseFollowerCount?: number;
  baseLikeCount?: number;
}

/** A profile plus its remote media metadata, for the media overview. */
export interface RemoteVideoRow {
  profile: HostProfile;
  video: StoredAssetMeta | null;
  audio: StoredAssetMeta | null;
}

/**
 * What the public app is allowed to know about a host. The avatar arrives as a
 * self-contained data URL: it is small, it survives being held in call session
 * state across screens, and it needs no object-URL lifecycle. Video never does
 * this — it is fetched as a Blob, by reference, only when a call goes active.
 */
export interface PublicHostProfile {
  id: string;
  displayName: string;
  shortBio: string;
  followerCount?: number;
  likeCount?: number;
  avatarDataUrl: string;
  coverDataUrl: string | null;
  remoteVideoAssetId: string | null;
  /** Played instead of the video on an audio call, when one was uploaded. */
  remoteAudioAssetId: string | null;
  /**
   * Whether the host is taking calls.
   *
   * An inactive profile is still resolvable by Call ID, so the caller can be
   * told who is unavailable instead of being shown a dead end. Resolving it is
   * not permission to call it: the flow checks this before asking for any
   * device, and `startCallSession` refuses it outright.
   */
  status: ProfileStatus;
}

export type ProfileReadiness = "ready" | "incomplete" | "inactive";


/**
 * One call attempt, recorded from the moment devices are granted.
 *
 * The shape follows the `call_sessions` table in the Supabase migration, with
 * one addition: `callIdSnapshot` keeps the code that was dialled, so history
 * still reads correctly after a profile regenerates its Call ID.
 *
 * One optional screenshot is stored separately as private call evidence. This
 * record contains call history only, never image data or public media URLs.
 */
/**
 * `declined` and `no_answer` are outcomes in their own right rather than
 * flavours of `cancelled`. An operator reading history needs to know whether
 * they turned a call down or never saw it, and a caller support is helping needs
 * the same distinction.
 */
export type CallSessionStatus =
  | "connecting"
  | "ringing"
  | "active"
  | "ended"
  | "cancelled"
  | "declined"
  | "no_answer"
  | "failed";

export interface CallSessionCaller {
  fullName: string;
  email: string;
  phone: string;
}

export interface CallSessionRecord {
  id: string;
  profileId: string;
  /** The host name as it was at call time, so a rename cannot rewrite history. */
  profileName: string;
  callIdSnapshot: string;
  callType: CallType;
  caller: CallSessionCaller;
  status: CallSessionStatus;
  /** ISO timestamps. Each one is written once, when that stage is reached. */
  createdAt: string;
  connectingAt: string | null;
  ringingAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  /** Set only for failures, and only with a code we are willing to show. */
  failureCode: string | null;
  durationSeconds: number | null;
  /**
   * How the remote participant appeared on this call.
   *
   * A business fact rather than a protocol one: an operator reviewing history
   * wants to know whether the caller saw a live camera or a recording. Null
   * until a call actually connects and a source is settled.
   */
  sourceKind: CallSourceKind | null;
}

/** `live-microphone` is the audio equivalent: there is only one way to be heard. */
export type CallSourceKind = "live-camera" | "uploaded-source" | "live-microphone";

export interface CreateCallSessionInput {
  id: string;
  profileId: string;
  profileName: string;
  callIdSnapshot: string;
  callType: CallType;
  caller: CallSessionCaller;
}

export interface CallSessionPatch {
  status?: CallSessionStatus;
  ringingAt?: string;
  connectedAt?: string;
  endedAt?: string;
  failureCode?: string | null;
  durationSeconds?: number | null;
  sourceKind?: CallSourceKind | null;
}

/**
 * Operational events only: what the call did, not what the device is. No
 * fingerprinting, no telemetry, and nothing repeated on every render.
 */
export type CallEventType =
  | "session_created"
  | "permissions_requested"
  | "permissions_granted"
  | "permissions_denied"
  | "connecting"
  | "ringing"
  | "connected"
  /**
   * The real-time lifecycle.
   *
   * Deliberately coarse. An SDP exchange and an ICE negotiation produce hundreds
   * of state changes, and a timeline is a business record of what the call did,
   * not a protocol trace — so a whole negotiation is one `rtc_connecting`, and a
   * whole recovery is one `rtc_reconnecting` followed by one `rtc_recovered`.
   * Individual candidates and heartbeats are never events.
   */
  | "call_invited"
  | "call_accepted"
  | "source_selection_started"
  | "source_selected"
  | "rtc_connecting"
  | "rtc_connected"
  | "rtc_reconnecting"
  | "rtc_recovered"
  | "rtc_failed"
  | "call_declined"
  | "call_no_answer"
  | "camera_disabled"
  | "camera_enabled"
  | "microphone_muted"
  | "microphone_unmuted"
  /**
   * The subscription checkpoint. The call keeps running through the check
   * itself; `subscription_required` is the last thing that happens to a call
   * that has no access, because that result ends it.
   */
  | "subscription_check_started"
  | "subscription_access_granted"
  | "subscription_required"
  | "subscription_requested"
  | "subscription_confirmed"
  /** A paid session used the full length its plan sells. */
  | "session_limit_reached"
  /** Remote media reached its natural end; the call itself remained active. */
  | "remote_media_ended"
  | "ended"
  | "cancelled"
  | "failed";

export type CallEventMetadata = Record<string, string | number | boolean | null>;

export interface CallEventRecord {
  id: string;
  sessionId: string;
  type: CallEventType;
  occurredAt: string;
  metadata?: CallEventMetadata;
}

export interface AppendCallEventInput {
  sessionId: string;
  type: CallEventType;
  metadata?: CallEventMetadata;
}

export interface CallSessionFilters {
  status?: CallSessionStatus | "all";
  callType?: CallType | "all";
  profileId?: string | "all";
  /** ISO timestamp; only sessions created at or after it are returned. */
  since?: string;
  limit?: number;
}

export interface SessionMetrics {
  total: number;
  callsToday: number;
  completed: number;
  cancelledOrFailed: number;
  /** Mean duration of calls that actually connected and then ended. */
  averageConnectedSeconds: number | null;
}
