import { useEffect, useRef, useState } from 'react';
import type { StudioRuntime } from '../useStudioRuntime';
import { physicalOrientation } from '../../engine/rigidFaceMotion';
import { runHybridComparison, type HybridComparisonResult } from '../../tracking/hybridExperiment';

export const EYE_TEST_SEQUENCE = [
  ['A', 'Neutral stare — 5 seconds'], ['B', 'Blink both ×5'], ['C', 'Slow blink ×3'],
  ['D', 'Left wink ×3'], ['E', 'Right wink ×3'], ['F', 'Close both and hold 3 seconds'],
  ['G', 'Open eyes deliberately wide ×3'], ['H', 'Look left/right with head still'],
  ['I', 'Look up/down with head still'], ['J', 'Circular and diagonal gaze'],
  ['K', 'Turn head with gaze centered'], ['L', 'Turn head while looking opposite'],
  ['M', 'Blink while turning head'], ['N', 'Wide eyes while turning head'],
  ['O', 'Repeat wearing glasses'], ['P', 'Moderately dim light'], ['Q', 'Move closer/farther'],
] as const;
const text = (n: number | null | undefined, suffix = '') => typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(3)}${suffix}` : 'unavailable';

export default function EyeDiagnostics({ runtime, rendererFps }: { runtime: StudioRuntime; rendererFps: number | null }) {
  const summaryRef = useRef(runtime.summary); summaryRef.current = runtime.summary;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState('Production: MediaPipe only. Hybrid assistance disabled.');
  const [results, setResults] = useState<HybridComparisonResult[]>([]);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<number | null>(null);
  const camera = runtime.state.camera;
  useEffect(() => { abortRef.current?.abort(); return () => { abortRef.current?.abort(); }; }, [camera]);
  useEffect(() => { const hidden = () => { if (document.hidden) abortRef.current?.abort(); }; document.addEventListener('visibilitychange', hidden); return () => document.removeEventListener('visibilitychange', hidden); }, []);
  const start = async () => {
    const video = runtime.videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || running || abortRef.current) return;
    const controller = new AbortController(); abortRef.current = controller;
    setRunning(true); setResults([]);
    try { setResults(await runHybridComparison(video, canvas, () => summaryRef.current, controller.signal, setProgress)); setProgress('Comparison complete. Hybrid remains disabled; review measurements before retaining assistance.'); }
    catch (e) { setProgress(controller.signal.aborted ? 'Comparison cancelled; assistant disposed.' : `Comparison failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setRunning(false); if (abortRef.current === controller) abortRef.current = null; }
  };
  const { face, expression, stats } = runtime.summary;
  const pose = face?.derived ? physicalOrientation(face.derived) : null;
  return <section className="studio-card eye-diagnostics" aria-label="Eye Diagnostics">
    <details>
      <summary>Eye Diagnostics · Developer</summary>
      <p className="studio-note">Calibrate neutral with both eyes open. Head-local measurements; source eye pixels only.</p>
      {(['left', 'right'] as const).map(side => <div key={side}>
        <h3>{side === 'left' ? 'LEFT' : 'RIGHT'}</h3>
        <dl>{(['openness', 'blink', 'wideOpen', 'gazeX', 'gazeY', 'irisX', 'irisY', 'upperLid', 'lowerLid', 'confidence'] as const).map(key => <div className="tracker-lab-metric" key={key} data-eye-metric={`${side}-${key}`}><dt>{key}</dt><dd>{text(expression?.eyes?.[side][key])}</dd></div>)}</dl>
      </div>)}
      <h3>GLOBAL</h3>
      <dl>{[
        ['Camera FPS', stats?.cameraFps], ['Tracking FPS', stats?.faceFps], ['Frame age estimate ms', stats?.cameraToFaceMs],
        ['Face inference ms', stats?.faceAverageMs], ['Dropped camera frames', stats?.droppedInputFrames], ['Renderer FPS', rendererFps],
        ['Face confidence', face?.confidence], ['Head yaw', pose?.yaw], ['Head pitch', pose?.pitch], ['Head roll', pose?.roll],
      ].map(([label, value]) => <div className="tracker-lab-metric" key={label} data-eye-global={label}><dt>{label}</dt><dd>{text(value as number | null | undefined)}</dd></div>)}</dl>
      {runtime.summary.guidance.label === 'Too close' && <p role="status">TOO CLOSE — MOVE BACK SLIGHTLY</p>}
      {runtime.summary.guidance.label === 'Too far' && <p role="status">TOO FAR — MOVE CLOSER SLIGHTLY</p>}
      <details><summary>Eye Test sequence A–Q</summary>
        <ol>{EYE_TEST_SEQUENCE.map(([id, label], i) => <li key={id} aria-current={step === i ? 'step' : undefined}><strong>TEST {id}</strong> — {label}</li>)}</ol>
        <p role="status">{step === null ? 'Sequence ready' : `TEST ${EYE_TEST_SEQUENCE[step]![0]} — ${EYE_TEST_SEQUENCE[step]![1]}`}</p>
        <div className="tracker-lab-actions"><button className="studio-control" onClick={() => setStep(step === null ? 0 : Math.min(EYE_TEST_SEQUENCE.length - 1, step + 1))}>{step === null ? 'Start eye sequence' : 'Next eye test'}</button><button className="studio-control" onClick={() => setStep(null)}>Reset sequence</button></div>
      </details>
      <details><summary>Bounded hybrid comparison</summary>
        <p className="studio-note">Hold neutral through both 12-second windows. Jeeliz confirms global detection at up to 2 Hz; it supplies no eye signals or unverified pose. Response latency needs a physical timed stimulus and is unavailable here.</p>
        <p role="status" data-testid="hybrid-progress">{progress}</p>
        <div className="tracker-lab-actions"><button className="studio-control" disabled={running || camera !== 'live' || runtime.calibration.phase !== 'ready'} onClick={() => void start()}>Run one hybrid comparison</button><button className="studio-control" disabled={!running} onClick={() => abortRef.current?.abort()}>Cancel comparison</button></div>
        {results.map(result => <details key={result.mode}><summary>{result.mode}</summary><dl>{Object.entries(result).filter(([key]) => key !== 'mode').map(([key, value]) => <div className="tracker-lab-metric" key={key}><dt>{key}</dt><dd>{text(value as number | null)}</dd></div>)}</dl></details>)}
      </details>
    </details>
    <canvas className="tracker-lab-processing" ref={canvasRef} width={480} height={270} aria-hidden="true" />
  </section>;
}
