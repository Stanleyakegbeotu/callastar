import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioRuntime } from '../studio/useStudioRuntime';
import { BenchmarkRecorder, type BenchmarkSummary } from './benchmarkRecorder';
import { MediaPipeProvider } from './mediapipeProvider';
import { metricText, MEDIAPIPE_CAPABILITIES, type FaceTrackerProvider, type TrackerId, type TrackerSample } from './trackerProvider';
import { jeelizCapabilities } from './jeeliz/jeelizCapabilities';
import { measurePoseMapping, type MeasuredPoseMapping, type PoseEvidence, type PoseGesture } from './jeeliz/jeelizMapping';
import type { JeelizModel } from './jeeliz/jeelizTypes';
import { drawTrackerOverlay } from './trackerOverlay';

const GESTURES: { id: PoseGesture; label: string }[] = [
  { id: 'neutral', label: 'Neutral' }, { id: 'right', label: 'Turn physical right' },
  { id: 'left', label: 'Turn physical left' }, { id: 'up', label: 'Look up' }, { id: 'down', label: 'Look down' },
  { id: 'tilt-right', label: 'Tilt right' }, { id: 'tilt-left', label: 'Tilt left' },
];
const SEQUENCE = [
  'Neutral — hold still for the first 5 seconds (jitter window).',
  'Turn physical right → center → left → center.',
  'Look up → center → down → center.',
  'Tilt right → center → left → center.',
  'Move closer, then farther.',
  'Mouth: closed → 25% → 50% → 75% → 100%.',
  'Smile, if supported.', 'Frown and raise brows, if supported.',
  'Fast left/right movement.', 'Low light.', 'Strong light.', 'Glasses.',
  'Front camera.', 'Rear camera and controller reacquisition, if practical (start a separate run after flip).',
];

function Row({ name, value }: { name: string; value: string }) {
  return <div className="tracker-lab-metric" data-lab-metric={name}><dt>{name}</dt><dd>{value}</dd></div>;
}
function Summary({ result }: { result: BenchmarkSummary }) {
  return <details className="tracker-lab-result" open>
    <summary>{result.provider === 'jeeliz' ? 'Jeeliz' : 'MediaPipe'} · {result.model} · {(result.durationMs / 1000).toFixed(1)}s</summary>
    <dl>
      <Row name="Samples" value={`${result.samples}${result.capped ? ' (30,000 sample cap reached)' : ''}`} />
      <Row name="Initialization ms" value={metricText(result.initializationMs)} />
      <Row name="Mean confidence" value={metricText(result.confidence)} />
      <Row name="Callback FPS" value={metricText(result.callbackFps)} />
      <Row name="Fresh-frame callback FPS estimate" value={metricText(result.trackingFps)} />
      <Row name="Mean callback interval ms" value={metricText(result.callbackIntervalMs)} />
      <Row name="Exact inference ms" value={metricText(result.inferenceMs)} />
      <Row name="Mean presentation age estimate ms" value={metricText(result.frameAgeMs)} />
      <Row name="Stale callbacks" value={String(result.staleFrames)} />
      <Row name="Camera presentation gaps" value={metricText(result.droppedFrames)} />
      <Row name="Neutral jitter axes" value={result.jitterAxes} />
      <Row name="Neutral jitter standard deviation" value={result.neutralJitter.map(v => metricText(v)).join(' / ')} />
      <Row name="Lost-face events" value={String(result.lostFaceEvents)} />
      <Row name="Mean reacquisition ms" value={`${metricText(result.reacquisitionMs)}${result.unresolvedLoss ? ' · face still lost at Stop' : ''}`} />
      <Row name="Movement cue response estimate ms" value={metricText(result.movementResponseMs)} />
      <Row name="Expression cue response estimate ms" value={metricText(result.expressionResponseMs)} />
      {(['mouthOpen', 'smile', 'browFrown', 'browRaise'] as const).map(key => <Row key={key} name={`${key} observed range`} value={result.expressionRanges[key]?.map(v => metricText(v)).join(' → ') ?? (key !== 'mouthOpen' && result.model === 'default' ? 'unsupported' : 'unavailable')} />)}
    </dl>
  </details>;
}

export default function TrackerLab({ runtime, overlayRef, onClose }: {
  runtime: StudioRuntime; overlayRef: React.RefObject<HTMLCanvasElement | null>; onClose: () => void;
}) {
  const [selected, setSelected] = useState<TrackerId>('mediapipe');
  const [model, setModel] = useState<JeelizModel>('default');
  const [status, setStatus] = useState('Initializing');
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const [revision, setRevision] = useState(0);
  const [sample, setSample] = useState<TrackerSample | null>(null);
  const [rates, setRates] = useState({ callbacks: 0, fresh: 0 });
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [staleCount, setStaleCount] = useState(0);
  const [results, setResults] = useState<BenchmarkSummary[]>([]);
  const [evidence, setEvidence] = useState<PoseEvidence>({});
  const [mapping, setMapping] = useState<MeasuredPoseMapping | null>(null);
  const [captureMessage, setCaptureMessage] = useState('Hold each pose for at least 0.8s, then capture it. Use physical directions, independent of the selfie mirror.');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const providerRef = useRef<FaceTrackerProvider | null>(null);
  const latestRef = useRef<TrackerSample | null>(null);
  const historyRef = useRef<TrackerSample[]>([]);
  const callbacksRef = useRef<{ timestamp: number; fresh: boolean }[]>([]);
  const staleCountRef = useRef(0);
  const recorderRef = useRef(new BenchmarkRecorder());
  const operationRef = useRef<Promise<void>>(Promise.resolve());
  const capabilities = selected === 'jeeliz' ? jeelizCapabilities(model) : MEDIAPIPE_CAPABILITIES;
  const { suspendForTrackerLab, getFaceTracker, videoRef, facing } = runtime;
  const camera = runtime.state.camera;

  const stopBenchmark = useCallback(() => {
    const result = recorderRef.current.stop(performance.now());
    if (result) setResults(previous => [...previous.slice(-7), result]);
    setRecording(false);
  }, []);

  useEffect(() => {
    const release = suspendForTrackerLab();
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      // Release the borrowed task only after old provider teardown is complete.
      queueMicrotask(() => { void operationRef.current.finally(release); });
      recorderRef.current.reset(); historyRef.current = []; latestRef.current = null;
    };
  }, [suspendForTrackerLab]);

  useEffect(() => {
    const abort = new AbortController();
    let provider: FaceTrackerProvider | null = null;
    let alive = true;
    stopBenchmark();
    setSample(null); latestRef.current = null; historyRef.current = []; callbacksRef.current = [];
    staleCountRef.current = 0; setStaleCount(0);
    setEvidence({}); setMapping(null); setError(null);
    setStatus(!visible ? 'Paused while tab is hidden' : camera !== 'live' ? 'Waiting for camera' : 'Initializing');
    const fail = (message: string) => {
      if (!alive) return;
      setError(message); setStatus('Failed'); stopBenchmark();
      abort.abort();
      void Promise.resolve(provider?.dispose()).catch(() => {});
    };
    const initialize = async () => {
      if (!alive || !visible || camera !== 'live') return;
      const video = videoRef.current, canvas = canvasRef.current;
      if (!video || !canvas) { fail('Studio camera or tracking canvas unavailable.'); return; }
      try {
        if (selected === 'jeeliz') {
          const { JeelizTracker } = await import('./jeeliz/jeelizTracker');
          if (!alive) return;
          provider = new JeelizTracker(model);
        } else {
          const face = getFaceTracker();
          if (!face) throw new Error('Start the Studio camera before opening Tracker Lab.');
          provider = new MediaPipeProvider(face);
        }
        providerRef.current = provider;
        await provider.initialize({
          video, canvas, signal: abort.signal, onError: fail,
          onSample: value => {
            if (!alive) return;
            latestRef.current = value;
            recorderRef.current.add(value);
            if (value.stale) staleCountRef.current++;
            callbacksRef.current.push({ timestamp: value.timestamp, fresh: !value.stale });
            while (callbacksRef.current.length && callbacksRef.current[0]!.timestamp < value.timestamp - 1000) callbacksRef.current.shift();
            if (value.detected && !value.stale && value.rawRotation) {
              historyRef.current.push(value);
              while (historyRef.current.length && historyRef.current[0]!.timestamp < value.timestamp - 1000) historyRef.current.shift();
            }
            if (overlayRef.current) drawTrackerOverlay(overlayRef.current, video, value, facing === 'user');
          },
        });
        if (!alive) { await provider.dispose(); return; }
        await provider.start();
        if (alive) setStatus('Running');
      } catch (caught) {
        if (alive && !abort.signal.aborted) fail(caught instanceof Error ? caught.message : 'Tracker could not initialize.');
      }
    };
    operationRef.current = operationRef.current.then(initialize);
    const timer = setInterval(() => {
      if (!alive) return;
      setSample(latestRef.current); setCount(recorderRef.current.count);
      setStaleCount(staleCountRef.current);
      const recent = callbacksRef.current.filter(s => s.timestamp >= performance.now() - 1000);
      setRates({ callbacks: recent.length, fresh: recent.filter(s => s.fresh).length });
    }, 250);
    return () => {
      alive = false; abort.abort(); clearInterval(timer);
      if (providerRef.current === provider) providerRef.current = null;
      if (overlayRef.current) overlayRef.current.getContext('2d')?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
      // Running callbacks stop synchronously; GPU cleanup is serialized before the next initialization.
      const disposing = provider ? Promise.resolve(provider.dispose()).catch(() => {}) : Promise.resolve();
      operationRef.current = operationRef.current.catch(() => {}).then(() => disposing);
    };
  }, [selected, model, camera, facing, visible, revision, videoRef, overlayRef, getFaceTracker, stopBenchmark]);

  const capture = (gesture: PoseGesture) => {
    const now = performance.now();
    const recent = historyRef.current.filter(s => s.timestamp >= now - 1000 && s.rawRotation);
    if (recent.length < 8 || now - recent[0]!.timestamp < 800 || !latestRef.current?.detected || now - latestRef.current.timestamp > 250) {
      setCaptureMessage('Capture needs a detected, steady face for at least 0.8s. Hold the pose and retry.'); return;
    }
    const median = [0, 1, 2].map(i => {
      const values = recent.map(s => s.rawRotation![i]!).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)]!;
    }) as [number, number, number];
    if (recent.some(s => s.rawRotation!.some((v, i) => Math.abs(v - median[i]!) > 0.1))) {
      setCaptureMessage('The pose moved during capture. Hold steady and retry.'); return;
    }
    const next = gesture === 'neutral' ? { neutral: median } : { ...evidence, [gesture]: median };
    const measured = measurePoseMapping(next);
    setEvidence(next); setMapping(measured);
    if (providerRef.current?.id === 'jeeliz') (providerRef.current as import('./jeeliz/jeelizTracker').JeelizTracker).mapping = measured;
    setCaptureMessage(measured ? 'Physical mapping measured from all seven captures. Signs apply only to this model and camera session.' : Object.keys(next).length === 7 ? 'Movements were ambiguous or inconsistent. Recapture neutral and repeat all six movements.' : `Captured ${GESTURES.find(g => g.id === gesture)!.label}. Return to center before the next movement.`);
  };
  const startBenchmark = () => {
    if (!providerRef.current || status !== 'Running') return;
    recorderRef.current.start(selected, selected === 'jeeliz' ? model : 'face only', performance.now(), providerRef.current.initializationMs);
    setRecording(true); setCount(0);
  };
  const value = (key: 'mouthOpen' | 'smile' | 'browFrown' | 'browRaise') => metricText(sample?.[key], capabilities[key]);
  const poseText = (key: 'yaw' | 'pitch' | 'roll') => selected === 'jeeliz' && !mapping ? 'unverified — capture physical movements' : metricText(sample?.pose?.[key]);

  return <section className="studio-card tracker-lab" aria-label="Tracker Lab">
    <div className="tracker-lab-heading"><h2>Tracker Lab</h2><button type="button" className="studio-control" onClick={onClose}>Close Tracker Lab</button></div>
    <p className="studio-note">Live camera is above. Only the selected face tracker runs; normal face/pose tracking and rendered previews are suspended while this lab is open.</p>
    <label>Tracking engine<select aria-label="Tracking engine" value={selected} onChange={e => setSelected(e.target.value as TrackerId)}><option value="mediapipe">MediaPipe</option><option value="jeeliz">Jeeliz</option></select></label>
    {selected === 'jeeliz' && <label>Jeeliz model<select aria-label="Jeeliz model" value={model} onChange={e => setModel(e.target.value as JeelizModel)}><option value="default">Default</option><option value="4-expression">4 Expression</option></select></label>}
    <canvas key={`${selected}-${model}-${camera}-${facing}-${visible}-${revision}`} ref={canvasRef} className="tracker-lab-processing" width="480" height="270" aria-hidden="true" data-testid="jeeliz-tracking-canvas" />
    <p role="status" data-testid="tracker-lab-status">{status}{status === 'Running' && sample ? sample.detected ? ' · face detected' : ' · no face detected' : ''}</p>
    {error && <><p className="studio-alert" role="alert">{error}</p><button type="button" className="studio-control" onClick={() => setRevision(n => n + 1)}>Retry tracker</button></>}
    <details open><summary>Live diagnostics</summary><dl>
      <Row name="Confidence" value={metricText(sample?.confidence)} />
      <Row name="Head X" value={metricText(sample?.centerX)} /><Row name="Head Y" value={metricText(sample?.centerY)} />
      <Row name="Scale" value={metricText(sample?.scale)} />
      <Row name="Yaw" value={poseText('yaw')} /><Row name="Pitch" value={poseText('pitch')} /><Row name="Roll" value={poseText('roll')} />
      {selected === 'jeeliz' && <Row name="Raw rx / ry / rz" value={sample?.rawRotation?.map(v => metricText(v)).join(' / ') ?? 'unavailable'} />}
      <Row name="Initialization ms" value={metricText(providerRef.current?.initializationMs)} />
      <Row name="Tracking FPS estimate" value={status === 'Running' ? String(rates.fresh) : 'unavailable'} />
      <Row name="Callback FPS" value={status === 'Running' ? String(rates.callbacks) : 'unavailable'} />
      <Row name="Callback interval ms" value={metricText(sample?.callbackIntervalMs)} />
      <Row name="Exact inference ms" value={metricText(sample?.inferenceMs)} />
      <Row name="Presentation age estimate ms" value={metricText(sample?.frameAgeMs)} />
      <Row name="Sample age ms" value={sample ? metricText(performance.now() - sample.timestamp) : 'unavailable'} />
      <Row name="Camera presentation gaps" value={metricText(sample?.droppedFrames)} />
      <Row name="Stale callbacks" value={String(staleCount)} />
      <Row name="Mouth open" value={value('mouthOpen')} /><Row name="Smile" value={value('smile')} />
      <Row name="Brow frown" value={value('browFrown')} /><Row name="Brow raise" value={value('browRaise')} />
      <Row name="Dense landmarks" value={metricText(sample?.landmarkCount, capabilities.denseLandmarks)} />
      <Row name="Iris landmarks" value={!capabilities.irisLandmarks ? 'unsupported' : sample?.landmarkCount === 478 ? '10 iris points' : 'unavailable'} />
      <Row name="Blink left" value={metricText(sample?.blinkLeft, capabilities.blinkPerEye)} /><Row name="Blink right" value={metricText(sample?.blinkRight, capabilities.blinkPerEye)} />
      <Row name="Gaze X" value={metricText(sample?.gazeX, capabilities.gaze)} /><Row name="Gaze Y" value={metricText(sample?.gazeY, capabilities.gaze)} />
      <Row name="Multi-face in this lab" value="unsupported" />
    </dl></details>
    <p className="studio-note">X/Y use unmirrored camera coordinates (0–1, Y down). Jeeliz scale is detection-box width; MediaPipe scale is eye span. Scale and confidence definitions differ between providers. Tracking FPS is fresh-video callback rate, not an exposed Jeeliz inference rate. Frame age is an estimate since camera presentation, with no guaranteed association to Jeeliz input.</p>
    {selected === 'jeeliz' && <details open><summary>Measure physical pose conventions</summary>
      <p className="studio-note">{captureMessage}</p><div className="tracker-lab-actions">{GESTURES.map(g => <button type="button" className="studio-control" key={g.id} onClick={() => capture(g.id)} disabled={recording || status !== 'Running'}>Capture {g.label}{evidence[g.id] ? ' ✓' : ''}</button>)}</div>
      {mapping && <p data-testid="measured-pose-mapping">{(['yaw', 'pitch', 'roll'] as const).map(key => `${key} = ${mapping[key].sign > 0 ? '+' : '−'}${['rx', 'ry', 'rz'][mapping[key].axis]} delta`).join(' · ')}</p>}
      <p className="studio-note">Yaw + subject left; pitch + up; roll + subject right. Mapping resets after a camera/model change. It never drives the renderer.</p>
    </details>}
    <details open><summary>Benchmark session</summary>
      <div className="tracker-lab-actions">
        <button type="button" className="studio-control" disabled={recording || status !== 'Running'} onClick={startBenchmark}>Start benchmark</button>
        <button type="button" className="studio-control" disabled={!recording} onClick={stopBenchmark}>Stop benchmark</button>
        <button type="button" className="studio-control" onClick={() => { recorderRef.current.reset(); setRecording(false); setCount(0); setResults([]); }}>Reset benchmark</button>
      </div>
      <p data-testid="benchmark-recording">{recording ? `Recording numeric samples · ${count} · hold neutral for the first 5 seconds` : 'Stopped · numeric samples stay in memory for this visit'}</p>
      <div className="tracker-lab-actions">
        <button type="button" className="studio-control" disabled={!recording || !sample?.detected} onClick={() => recorderRef.current.cue('movement', performance.now(), latestRef.current)}>Cue movement response</button>
        <button type="button" className="studio-control" disabled={!recording || !sample?.detected} onClick={() => recorderRef.current.cue('expression', performance.now(), latestRef.current)}>Cue expression response</button>
      </div>
      <p className="studio-note">Click a cue, then move or change expression. Cue-to-response includes human reaction time; it is not exact tracker latency. A 0.12-radian/channel change ends the cue. Provider/model switches, camera flips and hidden tabs end the run. Compare separate runs with the same resolution, lighting and actions.</p>
      {results.map((result, i) => <Summary key={i} result={result} />)}
    </details>
    <details><summary>Required physical test sequence</summary><ol>{SEQUENCE.map(step => <li key={step}>{step}</li>)}</ol><p className="studio-note">Test separately on iPhone and Android over the existing HTTPS tunnel. Software-rendered browser tests are not device performance evidence.</p></details>
  </section>;
}
