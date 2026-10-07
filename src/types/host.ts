/**
 * The person on the other side of the call, as the public app is allowed to
 * know them. Produced by a Call ID lookup through `services/callBackend.ts`.
 */
export interface HostPreview {
  id: string;
  /** Full name, e.g. shown on the ringing screen and in the call header. */
  displayName: string;
  /** Short/first name used in tighter spots ("Connecting to Maya…"). */
  shortName: string;
  /** Always a usable image source: an uploaded avatar, or an initials mark. */
  avatarUrl: string;
  coverUrl?: string | null;
  shortBio?: string | null;
  followerCount?: number;
  likeCount?: number;
  /**
   * Opaque handle the backend turns into the remote participant video. Locally
   * it is a stored asset id; with Supabase the media is session-scoped and this
   * stays null.
   */
  remoteVideoRef?: string | null;
  /**
   * The same, for the voice an audio call plays. When a profile has one it is
   * preferred over the video's soundtrack, so an audio call is not quietly
   * streaming a video file nobody can see.
   */
  remoteAudioRef?: string | null;
  /**
   * Whether the host is taking calls right now. False means the flow stops
   * before any device is requested, whatever credential got the caller here.
   */
  available?: boolean;
}
