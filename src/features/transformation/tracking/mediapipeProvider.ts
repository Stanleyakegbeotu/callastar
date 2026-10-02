import type { FaceTracker } from '../engine/faceTracker';
import { canonicalFaceLandmarks } from '../engine/faceLocalGeometry';
import { measureBinocularGaze } from '../engine/eyeGaze';
import { physicalOrientation } from '../engine/rigidFaceMotion';
import { computeTrackingSize } from '../engine/coordinateMapping';
import { MEDIAPIPE_CAPABILITIES, type FaceTrackerProvider, type TrackerContext } from './trackerProvider';
import { waitForVideo } from './videoFrames';

/** Borrow the Studio's existing task while its scheduler is suspended. Own no camera/model. */
export class MediaPipeProvider implements FaceTrackerProvider {
  readonly id = 'mediapipe' as const;
  get initializationMs() { return this.face.getTimings().initMs; }
  private context: TrackerContext | null = null;
  private running = false;
  private disposed = false;
  private handle: number | null = null;
  private raf = false;
  private lastAt: number | null = null;
  private lastMediaTime: number | null = null;
  private presented: number | null = null;
  private drops = 0;
  private abortController = new AbortController();
  private unlinkAbort = () => {};
  constructor(private face: FaceTracker) {}
  getCapabilities() { return { ...MEDIAPIPE_CAPABILITIES }; }
  async initialize(input: TrackerContext): Promise<void> {
    if (this.disposed) throw new Error('MediaPipe benchmark provider disposed.');
    const abort = () => this.abortController.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    this.unlinkAbort = () => input.signal.removeEventListener('abort', abort);
    if (input.signal.aborted) abort();
    const context = { ...input, signal: this.abortController.signal };
    this.context = context;
    await waitForVideo(context.video, context.signal);
    if (!this.face.ready) throw new Error('Studio MediaPipe face tracker is not ready.');
  }
  async start(): Promise<void> { this.running = true; this.schedule(); }
  private schedule(): void {
    if (!this.running || this.disposed || !this.context || this.context.signal.aborted) return;
    const video = this.context.video;
    this.raf = typeof video.requestVideoFrameCallback !== 'function';
    this.handle = this.raf
      ? requestAnimationFrame(now => this.track(now, null))
      : video.requestVideoFrameCallback((now, metadata) => this.track(now, metadata));
  }
  private track(now: number, metadata: VideoFrameCallbackMetadata | null): void {
    this.handle = null;
    const context = this.context;
    if (!this.running || !context || context.signal.aborted) return;
    const { video, canvas } = context;
    if (this.lastMediaTime === video.currentTime || video.readyState < 2) { this.schedule(); return; }
    this.lastMediaTime = video.currentTime;
    if (metadata) {
      if (this.presented !== null) this.drops += Math.max(0, metadata.presentedFrames - this.presented - 1);
      this.presented = metadata.presentedFrames;
    }
    try {
      const size = computeTrackingSize(video.videoWidth, video.videoHeight, 480);
      if (canvas.width !== size.width || canvas.height !== size.height) { canvas.width = size.width; canvas.height = size.height; }
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('MediaPipe benchmark drawing surface unavailable.');
      drawing.drawImage(video, 0, 0, size.width, size.height);
      const started = performance.now();
      const face = this.face.detect(canvas, now);
      const ended = performance.now();
      const geometry = face.detected ? face.derived : null;
      const shapes = face.blendshapes;
      const local = geometry ? canonicalFaceLandmarks(face.landmarks, geometry, video.videoWidth / video.videoHeight) : [];
      const gaze = measureBinocularGaze(local);
      const mean = (a: number | undefined, b: number | undefined): number | null => a === undefined || b === undefined ? null : (a + b) / 2;
      context.onSample({
        provider: this.id, timestamp: ended, detected: face.detected, confidence: face.confidence,
        centerX: geometry?.center.x ?? null, centerY: geometry?.center.y ?? null, scale: geometry?.scale ?? null,
        pose: geometry ? physicalOrientation(geometry) : null, rawRotation: null,
        mouthOpen: geometry ? shapes.jawOpen ?? geometry.mouthOpenness : null,
        smile: geometry ? mean(shapes.mouthSmileLeft, shapes.mouthSmileRight) : null,
        browFrown: geometry ? mean(shapes.browDownLeft, shapes.browDownRight) : null,
        browRaise: geometry ? shapes.browInnerUp ?? null : null,
        blinkLeft: geometry ? shapes.eyeBlinkLeft ?? null : null, blinkRight: geometry ? shapes.eyeBlinkRight ?? null : null,
        gazeX: gaze ? (gaze.left.x + gaze.right.x) / 2 : null, gazeY: gaze ? (gaze.left.y + gaze.right.y) / 2 : null,
        landmarkCount: face.landmarks.length, callbackIntervalMs: this.lastAt === null ? null : ended - this.lastAt,
        inferenceMs: ended - started, frameAgeMs: metadata ? Math.max(0, ended - metadata.expectedDisplayTime) : null,
        stale: face.status === 'skipped', droppedFrames: metadata ? this.drops : null,
      });
      this.lastAt = ended;
    } catch (error) {
      this.running = false;
      context.onError(error instanceof Error ? error.message : 'MediaPipe benchmark frame failed.');
    }
    this.schedule();
  }
  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      if (this.raf) cancelAnimationFrame(this.handle); else this.context?.video.cancelVideoFrameCallback?.(this.handle);
    }
    this.handle = null;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.abortController.abort(); this.unlinkAbort();
    this.stop(); this.context = null;
  }
}
