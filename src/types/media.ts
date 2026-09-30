/** Mirrors the Permissions API states, plus the browsers that cannot report one. */
export type MediaPermissionState = "unknown" | "prompt" | "granted" | "denied" | "unsupported";

export type CameraFacingMode = "user" | "environment";

/** Normalised getUserMedia failures — see `services/media/mediaDevices.ts`. */
export type MediaErrorKind =
  | "permission_denied"
  | "device_not_found"
  | "device_in_use"
  | "overconstrained"
  | "insecure_context"
  | "unsupported"
  | "unknown";

export interface MediaErrorInfo {
  kind: MediaErrorKind;
  title: string;
  message: string;
  /** Whether asking again could plausibly succeed. */
  retryable: boolean;
}

export type LocalMediaStatus = "idle" | "requesting" | "ready" | "error";

/**
 * What the call screen can do with the local camera and microphone.
 * Implemented by `features/call-session/hooks/useLocalMedia.ts`; declared here
 * so presentational components depend on the contract, not on the hook.
 */
export interface LocalMediaController {
  stream: MediaStream | null;
  status: LocalMediaStatus;
  error: MediaErrorInfo | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  hasVideoTrack: boolean;
  facingMode: CameraFacingMode;
  canSwitchCamera: boolean;
  isSwitchingCamera: boolean;
  /** Whether the browser exposes any audio output routing at all (setSinkId). */
  canSelectAudioOutput: boolean;
  request: () => Promise<LocalMediaOutcome>;
  toggleMic: () => void;
  toggleCamera: () => void;
  switchCamera: () => Promise<void>;
  stop: () => void;
}

export type LocalMediaOutcome =
  | { outcome: "granted" }
  | { outcome: "failed"; error: MediaErrorInfo }
  /** A newer request (or teardown) superseded this one - the caller does nothing. */
  | { outcome: "cancelled" };
