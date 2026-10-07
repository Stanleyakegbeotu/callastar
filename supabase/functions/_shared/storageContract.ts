export const STORAGE_BUCKETS = {
  avatar: "host-avatars", cover: "host-avatars",
  remote_video: "host-call-media", remote_audio: "host-call-media",
  support: "support-attachments", evidence: "call-evidence",
} as const;
// Exceeds a 60-minute call, including setup and retry margin.
export const CALL_MEDIA_TTL_SECONDS = 7200;
