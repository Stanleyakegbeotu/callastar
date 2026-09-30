import type { AdminRepository } from "./repository";

/**
 * The Supabase side of the seam, deliberately unimplemented in this phase.
 *
 * The project decision is that no remote Supabase project is connected yet, so
 * rather than half-wire it — or worse, quietly fall back to another browser's
 * local data — every method fails loudly and says exactly what is missing.
 *
 * Finishing this file is the migration:
 *  - profiles        -> `hosts` (display_name, short_bio, status, avatar_path)
 *  - assets/blobs    -> Storage buckets + `host_media` rows
 *  - callId          -> `call_ids` (hashed; only the last four are stored plain)
 *  - resolveCallId   -> the `resolve-call-id` Edge Function
 *  - sessions/events -> `call_sessions` and `call_events`, written by the Edge Functions
 *
 * The domain types in `types.ts` already match those columns, so the admin
 * screens do not change when this lands.
 */
function notConnected(): never {
  throw new Error(
    "Supabase admin repository is not connected.",
  );
}

export const supabaseAdminRepository: AdminRepository = {
  mode: "supabase",

  listProfiles: notConnected,
  getProfile: notConnected,
  createProfile: notConnected,
  updateProfile: notConnected,
  deleteProfile: notConnected,
  regenerateCallId: notConnected,
  setAvatar: notConnected,
  removeAvatar: notConnected,
  setRemoteVideo: notConnected,
  removeRemoteVideo: notConnected,
  setRemoteAudio: notConnected,
  removeRemoteAudio: notConnected,
  getAssetMeta: notConnected,
  getAssetBlob: notConnected,
  listRemoteVideos: notConnected,
  resolveCallId: notConnected,
  getPublicProfile: notConnected,
  createCallSession: notConnected,
  getCallSession: notConnected,
  listCallSessions: notConnected,
  updateCallSession: notConnected,
  appendCallEvent: notConnected,
  getCallEvents: notConnected,
  listProfileSessions: notConnected,
  countProfileSessions: notConnected,
  getSessionMetrics: notConnected,
};
