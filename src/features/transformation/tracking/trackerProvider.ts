export type TrackerId = 'mediapipe' | 'jeeliz';
export interface TrackerCapabilities {
  headPose: boolean; translation: boolean; scale: boolean;
  mouthOpen: boolean; smile: boolean; browFrown: boolean; browRaise: boolean;
  denseLandmarks: boolean; irisLandmarks: boolean; gaze: boolean; blinkPerEye: boolean;
  multiFace: boolean;
}
export interface CanonicalHeadPose {
  /** CallaStar physical: yaw + subject LEFT; pitch + UP; roll + subject RIGHT. */
  yaw: number; pitch: number; roll: number;
}
export interface TrackerSample {
  timestamp: number; provider: TrackerId; confidence: number; detected: boolean;
  /** Unmirrored camera coordinates, 0..1, y down. */
  centerX: number | null; centerY: number | null; scale: number | null;
  pose: CanonicalHeadPose | null;
  rawRotation: [number, number, number] | null;
  mouthOpen: number | null; smile: number | null; browFrown: number | null; browRaise: number | null;
  blinkLeft: number | null; blinkRight: number | null;
  gazeX: number | null; gazeY: number | null; landmarkCount: number | null;
  callbackIntervalMs: number | null; inferenceMs: number | null;
  /** Time since the latest camera presentation; not sensor-to-inference latency. */
  frameAgeMs: number | null;
  stale: boolean; droppedFrames: number | null;
}
export interface TrackerContext {
  video: HTMLVideoElement; canvas: HTMLCanvasElement; signal: AbortSignal;
  onSample: (sample: TrackerSample) => void; onError: (message: string) => void;
}
export interface FaceTrackerProvider {
  readonly id: TrackerId;
  readonly initializationMs: number | null;
  initialize(context: TrackerContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void> | void;
  dispose(): Promise<void> | void;
  getCapabilities(): TrackerCapabilities;
}
export const MEDIAPIPE_CAPABILITIES: TrackerCapabilities = {
  headPose: true, translation: true, scale: true, mouthOpen: true, smile: true,
  browFrown: true, browRaise: true, denseLandmarks: true, irisLandmarks: true,
  gaze: true, blinkPerEye: true, multiFace: false,
};
export function metricText(value: number | null | undefined, supported = true): string {
  return !supported ? 'unsupported' : value == null || !Number.isFinite(value) ? 'unavailable' : value.toFixed(3);
}
