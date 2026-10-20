/** Metadata and a decoded frame must exist before source playback owns a call. */
export function isUsableSourceVideo(
  video: Pick<HTMLVideoElement, "duration" | "videoWidth" | "videoHeight" | "readyState">,
): boolean {
  return (
    Number.isFinite(video.duration) &&
    video.duration > 0 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    video.readyState >= 2
  )
}
