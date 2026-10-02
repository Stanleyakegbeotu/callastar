import { computeTrackingSize } from '../../engine/coordinateMapping';
import type { FaceTrackerProvider, TrackerContext, TrackerSample } from '../trackerProvider';
import { CameraPresentationClock, waitForVideo } from '../videoFrames';
import { jeelizCapabilities } from './jeelizCapabilities';
import { loadJeeliz } from './jeelizLoader';
import { canonicalJeelizPose, copyJeelizState, jeelizCameraPosition, type MeasuredPoseMapping } from './jeelizMapping';
import type { JeelizApi, JeelizModel } from './jeelizTypes';

export class JeelizTracker implements FaceTrackerProvider {
  readonly id = 'jeeliz' as const;
  initializationMs: number | null = null;
  mapping: MeasuredPoseMapping | null = null;
  private api: JeelizApi | null = null;
  private context: TrackerContext | null = null;
  private clock: CameraPresentationClock | null = null;
  private observer: ResizeObserver | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private running = false;
  private disposed = false;
  private initialized = false;
  private initStarted = false;
  private lastAt: number | null = null;
  private lastMediaTime: number | null = null;
  private cancelInit: (() => void) | null = null;
  private removeListeners = () => {};
  private abortController = new AbortController();
  private unlinkAbort = () => {};
  private disposalPromise: Promise<void> | null = null;

  constructor(readonly model: JeelizModel = 'default', private loader = loadJeeliz, private timeoutMs = 20000) {}
  getCapabilities() { return jeelizCapabilities(this.model); }

  async initialize(input: TrackerContext): Promise<void> {
    if (this.disposed) throw new Error('Jeeliz tracker disposed.');
    if (this.context) throw new Error('Jeeliz tracker already initialized.');
    const abort = () => this.abortController.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    this.unlinkAbort = () => input.signal.removeEventListener('abort', abort);
    if (input.signal.aborted) abort();
    const context = { ...input, signal: this.abortController.signal };
    this.context = context;
    const started = performance.now();
    await waitForVideo(context.video, context.signal);
    if (this.disposed || context.signal.aborted) throw new DOMException('Tracker cancelled', 'AbortError');
    try { this.api = await this.loader(); }
    catch { throw new Error('Jeeliz module could not load. Retry Tracker Lab.'); }
    if (this.disposed || context.signal.aborted) {
      // No init was performed, so this fresh API has no GPU resources to destroy.
      this.api = null;
      throw new DOMException('Tracker cancelled', 'AbortError');
    }
    this.resize();
    const api = this.api;
    // In facefilter@3.4.3, destroy() internally calls this public method with
    // (true, true), stopping even an externally supplied video's MediaStream.
    // Shield only our private create_new() instance; StudioCamera owns the stream.
    const pause = api.toggle_pause.bind(api);
    api.toggle_pause = (paused: boolean) => pause(paused, false);
    const url = `${import.meta.env.BASE_URL}models/jeeliz/${this.model === 'default' ? 'NN_DEFAULT.json' : 'NN_4EXPR_3.json'}`;
    const response = await fetch(url, { method: 'HEAD', signal: context.signal });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error(`Jeeliz model unavailable: ${url} (${response.status}). Run pnpm assets:jeeliz.`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        this.cancelInit = null;
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new DOMException('Tracker cancelled', 'AbortError'));
      this.cancelInit = abort;
      const timer = setTimeout(() => finish(new Error('Jeeliz initialization timed out. Check local model and WebGL.')), this.timeoutMs);
      context.signal.addEventListener('abort', abort, { once: true });
      const lost = (event: Event) => {
        event.preventDefault();
        this.running = false;
        const error = new Error('Jeeliz WebGL context lost. Close and reopen Tracker Lab.');
        if (!settled) finish(error); else context.onError(error.message);
      };
      context.canvas.addEventListener('webglcontextlost', lost);
      this.removeListeners = () => context.canvas.removeEventListener('webglcontextlost', lost);
      try {
        this.initStarted = true;
        api.init({
          canvas: context.canvas, NNCPath: url, maxFacesDetected: 1, followZRot: true,
          videoSettings: { videoElement: context.video },
          callbackReady: (error, spec) => {
            if (this.disposed || context.signal.aborted) return;
            if (error) {
              this.running = false;
              const message = `Jeeliz initialization error: ${error}. Check local model, camera readiness and WebGL.`;
              if (!settled) finish(new Error(message)); else context.onError(message);
              return;
            }
            if (spec?.videoElement && spec.videoElement !== context.video) {
              finish(new Error('Jeeliz did not reuse the Studio camera element.'));
              return;
            }
            this.initialized = true;
            this.gl = spec?.GL ?? null;
            void api.toggle_pause(true, false).then(() => finish(), (error: unknown) => finish(new Error(String(error))));
          },
          callbackTrack: (state) => {
            if (!this.running || this.disposed || context.signal.aborted) return;
            const now = performance.now();
            const owned = copyJeelizState(state, this.model, now);
            const position = jeelizCameraPosition(owned);
            const detected = owned.detected >= 0.8;
            const raw: [number, number, number] = [owned.rotationX, owned.rotationY, owned.rotationZ];
            const stale = this.lastMediaTime === context.video.currentTime;
            const sample: TrackerSample = {
              provider: this.id, timestamp: now, detected, confidence: owned.detected,
              centerX: detected ? position.centerX : null,
              centerY: detected ? position.centerY : null, scale: detected ? owned.scale : null,
              pose: detected ? canonicalJeelizPose(raw, this.mapping) : null, rawRotation: detected ? raw : null,
              mouthOpen: detected ? owned.mouthOpen : null, smile: detected ? owned.smile : null,
              browFrown: detected ? owned.browFrown : null, browRaise: detected ? owned.browRaise : null,
              blinkLeft: null, blinkRight: null, gazeX: null, gazeY: null, landmarkCount: null,
              callbackIntervalMs: this.lastAt === null ? null : now - this.lastAt,
              inferenceMs: null, frameAgeMs: this.clock?.lastAt == null ? null : Math.max(0, now - this.clock.lastAt),
              stale, droppedFrames: typeof context.video.requestVideoFrameCallback === 'function' ? this.clock?.droppedFrames ?? 0 : null,
            };
            this.lastAt = now;
            this.lastMediaTime = context.video.currentTime;
            context.onSample(sample);
          },
        });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      if (context.signal.aborted) abort();
    });
    if (this.disposed) throw new DOMException('Tracker cancelled', 'AbortError');
    this.initializationMs = performance.now() - started;
    this.clock = new CameraPresentationClock(context.video);
    const resized = () => this.resize();
    context.video.addEventListener('resize', resized);
    window.addEventListener('orientationchange', resized);
    const previous = this.removeListeners;
    this.removeListeners = () => {
      previous(); context.video.removeEventListener('resize', resized); window.removeEventListener('orientationchange', resized);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(resized);
      this.observer.observe(context.video);
    }
  }

  private resize(): void {
    if (!this.context) return;
    const { canvas, video } = this.context;
    const size = computeTrackingSize(video.videoWidth, video.videoHeight, 480);
    if (!size.width || !size.height) return;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width; canvas.height = size.height;
    }
    if (this.initialized) this.api?.resize();
  }
  async start(): Promise<void> {
    if (!this.initialized || this.disposed || !this.api) throw new Error('Jeeliz is not ready.');
    this.running = true;
    this.clock?.start();
    await this.api.toggle_pause(false, false);
  }
  async stop(): Promise<void> {
    this.running = false;
    this.clock?.stop();
    this.lastAt = null; this.lastMediaTime = null;
    if (this.initialized && this.api) await this.api.toggle_pause(true, false);
  }
  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    this.abortController.abort();
    this.unlinkAbort();
    this.cancelInit?.();
    this.running = false;
    this.clock?.stop();
    this.observer?.disconnect();
    this.removeListeners();
    const api = this.api;
    this.api = null;
    this.context = null;
    this.disposalPromise = (async () => {
      try {
        if (api && this.initStarted) await api.destroy();
      } finally {
        // The dedicated canvas is discarded, so explicitly release its own context.
        this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
        this.gl = null;
      }
    })();
    return this.disposalPromise;
  }
}
