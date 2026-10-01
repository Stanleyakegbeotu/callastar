/** Register before seeking: a paused video may present its frame before `seeked`.
 * Timeout only rejects; elapsed time can never authorize a bitmap capture.
 */
export function readyVideoFrame(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let callback = 0;
    let presented = false;
    const target = Math.max(0, Math.min(time, Math.max(0, video.duration - .05)));
    const cleanup = () => {
      clearTimeout(timer);
      if (callback) video.cancelVideoFrameCallback?.(callback);
      for (const event of ['seeked', 'loadeddata', 'canplay']) video.removeEventListener(event, check);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', fail);
    };
    const fail = () => { cleanup(); reject(new Error(signal?.aborted ? 'Video read cancelled' : 'The source video frame could not be decoded.')); };
    const check = () => {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) return;
      if (Math.abs(video.currentTime - target) > .06) return;
      if (typeof video.requestVideoFrameCallback === 'function' && !presented) return;
      cleanup(); resolve();
    };
    const timer = setTimeout(fail, 6000);
    for (const event of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(event, check);
    video.addEventListener('error', fail);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) { fail(); return; }
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        presented = Math.abs(metadata.mediaTime - target) < .15;
        if (!presented) callback = video.requestVideoFrameCallback(onFrame);
        check();
      };
      callback = video.requestVideoFrameCallback(onFrame);
    }
    try { video.currentTime = target; } catch { fail(); }
  });
}
