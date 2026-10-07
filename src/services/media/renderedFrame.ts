export function videoHasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error;
}

/** A deadline applies even when an online Safari video never presents a frame. */
export function waitForRenderedFrame(video: HTMLVideoElement, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame: number | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(poll);
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => finish(new Error("main_call_video_not_rendered")), timeoutMs);
    const check = () => {
      if (video.error) return finish(new Error("main_call_video_load_failed"));
      if (!videoHasFrame(video) || video.paused) { poll = setTimeout(check, 50); return; }
      if (typeof video.requestVideoFrameCallback === "function") {
        frame = video.requestVideoFrameCallback(() => videoHasFrame(video) ? finish() : check());
      } else {
        // Two animation frames plus a short paint window for older Safari.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (finished) return;
          poll = setTimeout(() => videoHasFrame(video) && !video.paused ? finish() : check(), 100);
        }));
      }
    };
    check();
  });
}
