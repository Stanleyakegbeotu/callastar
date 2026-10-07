import { boundedEvidenceSize } from "./capturePolicy";
import { videoHasFrame, waitForRenderedFrame } from "@/services/media/renderedFrame";

export interface CapturedEvidenceImage { blob: Blob; width: number; height: number; videoWidth: number; videoHeight: number; readyState: number }

function drawVideo(context: CanvasRenderingContext2D, video: HTMLVideoElement, x: number, y: number, width: number, height: number) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return false;
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sx = 0; let sy = 0; let sw = video.videoWidth; let sh = video.videoHeight;
  let dx = x; let dy = y; let dw = width; let dh = height;
  const style = getComputedStyle(video);
  if (style.objectFit === "contain") {
    const ratio = Math.min(width / video.videoWidth, height / video.videoHeight);
    dw = video.videoWidth * ratio; dh = video.videoHeight * ratio;
    dx += (width - dw) / 2; dy += (height - dh) / 2;
  } else if (sourceRatio > targetRatio) { sw = video.videoHeight * targetRatio; sx = (video.videoWidth - sw) / 2; }
  else { sh = video.videoWidth / targetRatio; sy = (video.videoHeight - sh) / 2; }
  let mirrored = false;
  if (style.transform !== "none" && typeof DOMMatrix !== "undefined") {
    try { mirrored = new DOMMatrix(style.transform).a < 0; } catch { /* Keep the frame upright if a browser cannot parse the transform. */ }
  }
  if (mirrored) {
    context.save(); context.translate(dx + dw, dy); context.scale(-1, 1);
    context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh); context.restore();
  } else context.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
  return true;
}

export async function captureCallVideoComposition(_localStream: MediaStream, stillActive = () => true): Promise<CapturedEvidenceImage> {
  const surface = document.querySelector<HTMLElement>(".live-call");
  const main = surface?.querySelector<HTMLVideoElement>("video.live-call-main");
  if (!main) throw new Error("main_call_video_missing");
  const source = main.currentSrc; const stream = main.srcObject;
  await waitForRenderedFrame(main);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!stillActive() || !main.isConnected || !videoHasFrame(main) || main.currentSrc !== source || main.srcObject !== stream || surface?.querySelector("video.live-call-main") !== main)
    throw new Error("call_video_changed_before_capture");
  return new Promise((resolve, reject) => {
    const callSurface = document.querySelector<HTMLElement>(".live-call");
    if (!callSurface) return reject(new Error("call_video_surface_missing"));
    const bounds = callSurface.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return reject(new Error("call_video_surface_hidden"));
    const size = boundedEvidenceSize(bounds.width, bounds.height);
    const scale = size.width / bounds.width;
    const canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return reject(new Error("canvas_unavailable"));
    context.fillStyle = "#111820"; context.fillRect(0, 0, canvas.width, canvas.height);
    let drawn = 0; let drawnMain = false; let videoWidth = 0; let videoHeight = 0; let readyState = 0;
    // The main output is required. PiP is optional and painted on top.
    const videos = [main, ...callSurface.querySelectorAll<HTMLVideoElement>(".live-call-pip video")];
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      const left = Math.max(bounds.left, rect.left); const top = Math.max(bounds.top, rect.top);
      const right = Math.min(bounds.right, rect.right); const bottom = Math.min(bounds.bottom, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const style = getComputedStyle(video);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const x = (left - bounds.left) * scale; const y = (top - bounds.top) * scale;
      const width = (right - left) * scale; const height = (bottom - top) * scale;
      try { if (drawVideo(context, video, x, y, width, height)) {
        drawn++;
        if (video === main) drawnMain = true;
        videoWidth = Math.max(videoWidth, video.videoWidth); videoHeight = Math.max(videoHeight, video.videoHeight);
        readyState = Math.max(readyState, video.readyState);
      } } catch (cause) {
        if (cause instanceof DOMException && cause.name === "SecurityError") return reject(new Error("canvas_tainted_cross_origin_media"));
        return reject(new Error("call_video_draw_failed"));
      }
    }
    if (!drawn || !drawnMain) return reject(new Error("main_call_video_not_ready"));
    try {
      canvas.toBlob((blob) => blob?.size && stillActive()
        ? resolve({ blob, width: canvas.width, height: canvas.height, videoWidth, videoHeight, readyState })
        : reject(new Error("jpeg_encode_failed")), "image/jpeg", 0.86);
    } catch (cause) {
      reject(cause instanceof DOMException && cause.name === "SecurityError"
        ? new Error("canvas_tainted_cross_origin_media")
        : new Error("jpeg_encode_failed"));
    }
  });
}
