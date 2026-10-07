# Call evidence snapshots

CallaStar captures at most one JPEG snapshot for each consented, connected video call. It does not use `MediaRecorder`, record call audio, or capture browser/device screens.

## Capture behavior

- The caller accepts a separate snapshot notice before requesting camera permission.
- Capture requires the route session to be current, video call type, reducer state `active`, RTC phase `connected`, a local video track, and caller consent.
- After 1.2 seconds, the evidence service checks the displayed call videos for up to four bounded attempts, 300 ms apart. The call composition is downscaled proportionally to at most 1280×720 and encoded as JPEG quality 0.86.
- A persisted session guard and a deterministic IndexedDB key prevent duplicate screenshots across rerenders, reconnects, route remounts, and reloads.
- If the call ends before a usable video frame is available, the same local record is marked `capture_failed`. Capture and storage errors never end the call.

## Local-first storage

The image Blob is saved to IndexedDB before any cloud request. Admin Call Evidence reads IndexedDB first, then merges cloud results when available. Local images use object URLs that are revoked when their thumbnails/viewer unmount. Evidence stays on the same browser profile and device until cloud sync succeeds.

Sync status is `local_only`, `sync_pending`, `sync_failed`, or `synced`. When Supabase is configured, capture starts a non-blocking sync; opening the admin evidence page retries pending/failed local rows. A failed upload retains the local Blob. It never captures a second screenshot to retry.

## Cloud access

Production uses the private `call-evidence` Supabase bucket and `call_evidence` table. Admin listing and image access are authorized by Edge Functions; image URLs expire after five minutes. Uploads use a signed ticket and the capture token is stored as a hash.

Apply migration `20261006190000_call_evidence.sql` and deploy `begin-call-evidence`, `finish-call-evidence`, and `admin-call-evidence` to enable cloud sync. Without those services, local capture, local admin listing, thumbnails, and image viewing remain available in development. Historical recordings are not deleted; the client no longer creates new full-call recordings.

## Metadata and limits

Local and cloud metadata includes caller and host, package/plan (including Free Trial), answer/capture/end timestamps, dimensions, call status, duration, termination reason, and sync state. A still image indicates the video call reached a connected state; it does not establish what was said or how long participants remained on the call. Duration comes from the call state machine.

Physical iOS/Android and PWA restart behavior still require device validation. No commit or push is part of this change.
