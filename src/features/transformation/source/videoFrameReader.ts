import { readyVideoFrame } from "./readyVideoFrame";
/**
 * Getting one decoded frame out of a video at a chosen moment.
 *
 * The trap this exists to avoid: setting `currentTime` does NOT mean the frame
 * is ready. The assignment returns immediately, the decoder works
 * asynchronously, and drawing straight afterwards paints whatever was on the
 * element before — usually the first frame, for every sample. The result looks
 * like a video whose head never moves, and nothing about it reads as a bug.
 *
 * So every seek waits for `seeked`, and where the browser offers
 * `requestVideoFrameCallback` it waits for a presented frame as well, because
 * `seeked` fires when the seek completes rather than when a frame is painted.
 *
 * Everything here is owned and released: the element, the object URL, every
 * listener and every timer.
 */

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
}

export const SEEK = {
  /**
   * A seek that has not landed by now is not going to.
   *
   * Generous, because a seek into a long file on a slow disk is genuinely slow,
   * and a spurious timeout would drop a usable frame.
   */
  timeoutMs: 6_000,
  /** Loading metadata is a header read; it should not take this long. */
  metadataTimeoutMs: 15_000,
} as const;

export class VideoSeekError extends Error {
  constructor(
    message: string,
    readonly reason: "metadata" | "seek-timeout" | "seek-failed" | "decode" | "cancelled",
  ) {
    super(message);
    this.name = "VideoSeekError";
  }
}

/**
 * A video element, its object URL and a reusable draw canvas.
 *
 * One reader per analysis. `dispose` is idempotent and safe at any point,
 * including mid-seek, which is what cancellation needs.
 */
export class VideoFrameReader {
  private video: HTMLVideoElement | null = null;
  private objectUrl: string | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private disposed = false;
  private abort = new AbortController();

  async open(blob: Blob): Promise<VideoMetadata> {
    if (this.disposed) throw new VideoSeekError("Reader disposed", "cancelled");

    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(blob);

    this.video = video;
    this.objectUrl = objectUrl;

    /*
     * `metadata`, not `auto`.
     *
     * `auto` asks the browser to buffer ahead, and on a multi-megabyte file it
     * will happily spend longer doing that than this class is willing to wait —
     * which shows up as a metadata timeout on a video that is perfectly fine.
     * Seeking fetches what it needs regardless.
     */
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    /*
     * Deliberately NO `crossOrigin`.
     *
     * A blob URL is same-origin by construction, so it buys nothing here, and
     * setting it makes Chromium refuse to load some blob-backed sources
     * outright. A future remote source would need a real CORS story rather than
     * this attribute set hopefully in advance.
     */
    video.src = objectUrl;

    const metadata = await new Promise<VideoMetadata>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new VideoSeekError("Video metadata did not load", "metadata"));
      }, SEEK.metadataTimeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
      };

      const onLoaded = () => {
        cleanup();
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        if (duration <= 0 || video.videoWidth === 0) {
          reject(new VideoSeekError("Video reported no usable duration or size", "metadata"));
          return;
        }
        resolve({ durationSeconds: duration, width: video.videoWidth, height: video.videoHeight });
      };

      const onError = () => {
        cleanup();
        reject(new VideoSeekError("This video could not be decoded", "decode"));
      };

      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      video.load();
    });

    if (this.disposed) throw new VideoSeekError("Reader disposed", "cancelled");

    const canvas = document.createElement("canvas");
    canvas.width = metadata.width;
    canvas.height = metadata.height;
    const context = canvas.getContext("2d");
    if (!context) throw new VideoSeekError("Could not create a drawing surface", "decode");

    this.canvas = canvas;
    this.context = context;
    return metadata;
  }

  /**
   * Seeks, waits for a real frame, and draws it.
   *
   * Returns the shared canvas rather than a new bitmap per frame: the caller
   * hands it straight to MediaPipe and is finished with it before the next
   * seek, so allocating twenty canvases would be twenty full-resolution buffers
   * held for no reason.
   */
  async frameAt(timestampSeconds: number): Promise<HTMLCanvasElement> {
    if (this.disposed) throw new VideoSeekError("Reader disposed", "cancelled");
    const video = this.video;
    const canvas = this.canvas;
    const context = this.context;
    if (!video || !canvas || !context) throw new VideoSeekError("Reader is not open", "decode");

    await readyVideoFrame(video, timestampSeconds, this.abort.signal);

    if (this.disposed) throw new VideoSeekError("Reader disposed", "cancelled");

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();

    const video = this.video;
    const objectUrl = this.objectUrl;
    this.video = null;
    this.objectUrl = null;
    this.canvas = null;
    this.context = null;

    if (video) {
      // Removing the attribute and reloading is what actually releases the
      // decoder; clearing `src` alone leaves it holding the file.
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // An element already torn down by the browser.
      }
    }

    // Every URL created here is revoked here — the ownership rule the rest of
    // the app follows.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
