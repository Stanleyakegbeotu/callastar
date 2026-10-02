export function waitForVideo(video: HTMLVideoElement, signal: AbortSignal, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame: number | null = null;
    let armed = false;
    const timer = setTimeout(() => finish(new Error('Camera not ready: no presented video frame.')), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      for (const event of ['loadeddata', 'timeupdate', 'resize']) video.removeEventListener(event, check);
      if (frame !== null) video.cancelVideoFrameCallback?.(frame);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new DOMException('Tracker cancelled', 'AbortError'));
    const check = () => {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.paused) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        if (!armed) { armed = true; frame = video.requestVideoFrameCallback(() => { frame = null; finish(); }); }
      } else if (video.currentTime > 0) finish();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    for (const event of ['loadeddata', 'timeupdate', 'resize']) video.addEventListener(event, check);
    check();
  });
}

/** Observes camera presentation only; never runs ML or requests a stream. */
export class CameraPresentationClock {
  lastAt: number | null = null;
  droppedFrames = 0;
  private handle: number | null = null;
  private presented: number | null = null;
  private running = false;
  constructor(private video: HTMLVideoElement) {}
  start(): void {
    this.running = true;
    this.schedule();
  }
  private schedule(): void {
    if (!this.running || typeof this.video.requestVideoFrameCallback !== 'function') return;
    this.handle = this.video.requestVideoFrameCallback((now, metadata) => {
      this.handle = null;
      this.lastAt = Math.min(now, metadata.expectedDisplayTime);
      if (this.presented !== null) this.droppedFrames += Math.max(0, metadata.presentedFrames - this.presented - 1);
      this.presented = metadata.presentedFrames;
      this.schedule();
    });
  }
  stop(): void {
    this.running = false;
    if (this.handle !== null) this.video.cancelVideoFrameCallback?.(this.handle);
    this.handle = null;
    this.lastAt = null;
    this.presented = null;
  }
}
