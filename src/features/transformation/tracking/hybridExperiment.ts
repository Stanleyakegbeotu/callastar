import type { StudioSummary } from '../studio/useStudioRuntime';
import type { TrackerSample } from './trackerProvider';
import { HybridCoordinator } from './hybridCoordinator';
import { JeelizTracker } from './jeeliz/jeelizTracker';

export interface HybridComparisonResult {
  mode: 'MediaPipe only' | 'MediaPipe + Jeeliz confirmation'; samples: number;
  cameraFps: number | null; trackingFps: number | null; frameAgeMs: number | null; inferenceMs: number | null;
  droppedFrames: number; staleSummaryPolls: number;
  /** RMS dispersion of yaw/pitch/roll, and per-eye gaze X/Y/blink respectively. */
  headJitter: number | null; eyeJitter: number | null;
  faceLosses: number; reacquisitionMs: number | null; assistantCallbacks: number; confirmedSamples: number;
  blinkResponseMs: null; gazeResponseMs: null;
}
const mean = (v: (number | null | undefined)[]) => { const n = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)); return n.length ? n.reduce((a,b) => a+b,0)/n.length : null; };
const jitter = (v: number[]) => { const m = mean(v); return m === null || v.length < 2 ? null : Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/v.length); };
const vectorJitter = (v: number[][]) => v.length < 2 ? null : Math.sqrt(v[0]!.reduce((sum,_,i)=>sum+(jitter(v.map(p=>p[i]!))??0)**2,0)/v[0]!.length);
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Cancelled','AbortError')); return; }
  const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled','AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

/** ONE bounded A/B experiment, 12 seconds each. MediaPipe continues through
 * the existing Studio scheduler. Jeeliz observes bursts at at most 2Hz, stops
 * after each callback, and is fully disposed on completion/cancel/camera flip.
 * Hold neutral during both windows: dispersion is not jitter during gestures.
 * Response latency has no event ground truth here and remains unavailable. */
export async function runHybridComparison(
  video: HTMLVideoElement, canvas: HTMLCanvasElement, getSummary: () => StudioSummary,
  signal: AbortSignal, progress: (text: string) => void, duration = 12000,
): Promise<HybridComparisonResult[]> {
  const results: HybridComparisonResult[] = [];
  const coordinator = new HybridCoordinator({ enabled: true, poseAssist: false, reacquisitionAssist: true });
  let assistant: JeelizTracker | null = null, callbacks = 0, error: string | null = null;
  try {
    for (const mode of ['MediaPipe only', 'MediaPipe + Jeeliz confirmation'] as const) {
      if (mode !== 'MediaPipe only') {
        progress('Initializing Jeeliz; initialization excluded from comparison window');
        assistant = new JeelizTracker();
        const owned = assistant;
        await owned.initialize({ video, canvas, signal, onError: message => { error = message; }, onSample: (sample: TrackerSample) => {
          callbacks++; coordinator.observe(sample); void owned.stop().catch(e => { error = String(e); });
        } });
      }
      progress(`${mode}: hold neutral for ${duration / 1000} seconds`);
      // Numeric summaries only: never retain Studio landmark/result objects.
      const snapshots: Pick<HybridComparisonResult,'cameraFps'|'trackingFps'|'frameAgeMs'|'inferenceMs'>[] = [], head: number[][] = [], eyes: number[][] = [], recoveries: number[] = [];
      let lossAt: number | null = null, losses = 0, stale = 0, confirmed = 0, lastFace = -1, lastBurst = -Infinity;
      const started = performance.now(), firstStats = getSummary().stats, firstDrops = firstStats?.droppedInputFrames ?? 0;
      while (performance.now() - started < duration) {
        const now = performance.now();
        if (assistant && now - lastBurst >= 500) { lastBurst = now; await assistant.start(); }
        const summary = getSummary();
        if (summary.face && summary.face.timestampMs !== lastFace) {
          const timing = summary.stats;
          lastFace = summary.face.timestampMs; snapshots.push({cameraFps:timing?.cameraFps??null,trackingFps:timing?.faceFps??null,frameAgeMs:timing?.cameraToFaceMs??null,inferenceMs:timing?.faceEndMs !== null && timing?.faceEndMs !== undefined && timing.faceStartMs !== null ? timing.faceEndMs - timing.faceStartMs : null});
          if (summary.face.detected && summary.face.derived) {
            if (lossAt !== null) { recoveries.push(now - lossAt); lossAt = null; }
            head.push([summary.face.derived.yaw,summary.face.derived.pitch,summary.face.derived.roll]);
            if (summary.expression?.eyes) { const e=summary.expression.eyes;eyes.push([e.left.gazeX,e.left.gazeY,e.left.blink,e.right.gazeX,e.right.gazeY,e.right.blink]); }
          } else if (lossAt === null) { lossAt = now; losses++; }
          if (coordinator.resolve({ eyes: summary.expression?.eyes ?? null, pose: null, detected: summary.face.detected, confidence: summary.face.confidence }, now).reacquisitionConfirmed) confirmed++;
        } else stale++;
        if (error) throw new Error(error);
        await wait(100, signal);
      }
      await assistant?.stop();
      const lastStats = getSummary().stats, seconds = (performance.now() - started) / 1000;
      results.push({ mode, samples: snapshots.length,
        // Window counter deltas avoid mixing A into B via rolling FPS means.
        cameraFps: firstStats && lastStats ? (lastStats.cameraFrames - firstStats.cameraFrames) / seconds : null,
        trackingFps: firstStats && lastStats ? (lastStats.faceInferences - firstStats.faceInferences) / seconds : null,
        frameAgeMs: mean(snapshots.map(s=>s.frameAgeMs)), inferenceMs: mean(snapshots.map(s=>s.inferenceMs)),
        droppedFrames: Math.max(0, (getSummary().stats?.droppedInputFrames ?? 0) - firstDrops), staleSummaryPolls: stale,
        headJitter: vectorJitter(head), eyeJitter: vectorJitter(eyes), faceLosses: losses, reacquisitionMs: mean(recoveries),
        assistantCallbacks: callbacks, confirmedSamples: confirmed, blinkResponseMs: null, gazeResponseMs: null,
      });
    }
    return results;
  } finally { await assistant?.dispose(); coordinator.reset(); }
}
