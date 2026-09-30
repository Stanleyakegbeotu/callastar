import { logDiagnostic } from "@/lib/utils";
import type { CallType } from "@/types/call";
import type { CameraFacingMode, MediaErrorInfo, MediaErrorKind } from "@/types/media";

export interface LocalStreamRequest {
  callType: CallType;
  facingMode?: CameraFacingMode;
  /** Ask for a camera track only — a camera flip keeps the microphone alive. */
  videoOnly?: boolean;
}

/** getUserMedia only exists in a secure context (HTTPS, or localhost in dev). */
export function isSecureMediaContext(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === true;
}

export function isMediaCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function supportedConstraints(): MediaTrackSupportedConstraints {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getSupportedConstraints) {
    return {};
  }
  return navigator.mediaDevices.getSupportedConstraints();
}

/** Whether the browser understands `facingMode` at all — it is an optional constraint. */
export function supportsFacingMode(): boolean {
  return supportedConstraints().facingMode === true;
}

/**
 * Speaker / earpiece routing. `setSinkId` is the only standardised audio output
 * control on the web, and it is unavailable in Safari (which covers every
 * browser on iOS), so a web app cannot route audio the way a native call app
 * can. `components/call/CallControls.tsx` documents how the control is gated.
 */
export function supportsAudioOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function"
  );
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Constraint ladder, best rung first. Every hint is `ideal`, so a device that
 * cannot deliver 1080p30 negotiates down instead of failing outright. The lower
 * rungs are for browsers that reject even an ideal hint (OverconstrainedError).
 */
function videoConstraintLadder(facingMode: CameraFacingMode): MediaTrackConstraints[] {
  const facing: MediaTrackConstraints = supportsFacingMode() ? { facingMode } : {};

  return [
    {
      ...facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    { ...facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    facing,
    {},
  ];
}

function audioConstraintLadder(): MediaTrackConstraints[] {
  const tuned = supportedConstraints().echoCancellation === true ? AUDIO_CONSTRAINTS : {};
  return [tuned, {}];
}

function isOverconstrained(error: unknown): boolean {
  return error instanceof Error && error.name === "OverconstrainedError";
}

function toConstraint(value: MediaTrackConstraints | null): boolean | MediaTrackConstraints {
  if (value === null) return false;
  return Object.keys(value).length > 0 ? value : true;
}

/**
 * Acquire the local stream for a call.
 *
 * Video calls ask for camera + microphone, audio calls for the microphone only.
 * `videoOnly` requests just a camera track, which is what a camera flip needs
 * so the existing microphone track is never interrupted.
 */
export async function requestLocalStream(request: LocalStreamRequest): Promise<MediaStream> {
  if (!isSecureMediaContext()) {
    throw createMediaError("insecure_context");
  }
  if (!isMediaCaptureSupported()) {
    throw createMediaError("unsupported");
  }

  const wantsVideo = request.callType === "video";
  const wantsAudio = !request.videoOnly;
  const facingMode = request.facingMode ?? "user";

  const videoOptions: (MediaTrackConstraints | null)[] = wantsVideo
    ? videoConstraintLadder(facingMode)
    : [null];
  const audioOptions: (MediaTrackConstraints | null)[] = wantsAudio ? audioConstraintLadder() : [null];

  let lastError: unknown;

  for (const video of videoOptions) {
    for (const audio of audioOptions) {
      const constraints: MediaStreamConstraints = {
        video: toConstraint(video),
        audio: toConstraint(audio),
      };

      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
        logDiagnostic("getUserMedia", {
          constraints,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          secureContext: isSecureMediaContext(),
          mediaDevicesAvailable: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices),
          getUserMediaAvailable: isMediaCaptureSupported(),
        });
        // Only an unsatisfiable constraint is worth a looser retry. A denial,
        // a missing device or busy hardware fails the same way every time.
        if (!isOverconstrained(error)) {
          throw error;
        }
      }
    }
  }

  throw lastError ?? createMediaError("unknown");
}

/** Stop every track, which is what turns the camera indicator off. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function stopTracks(tracks: MediaStreamTrack[]): void {
  tracks.forEach((track) => track.stop());
}

/** Cameras the browser will report. Labels only populate after a permission grant. */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch (error) {
    logDiagnostic("enumerateDevices", error);
    return [];
  }
}

const MEDIA_ERRORS: Record<MediaErrorKind, Omit<MediaErrorInfo, "kind">> = {
  permission_denied: {
    title: "Camera and microphone are blocked",
    message:
      "Camera and microphone access are required for video calls. Allow access in your browser, then try again.",
    retryable: true,
  },
  device_not_found: {
    title: "No camera or microphone found",
    message: "We could not find a camera or microphone on this device. Connect one and try again.",
    retryable: true,
  },
  device_in_use: {
    title: "We couldn't access your camera",
    message: "Your camera or microphone may be in use by another app. Close the other app, then try again.",
    retryable: true,
  },
  overconstrained: {
    title: "Camera settings unsupported",
    message: "This device could not start the camera with the requested settings. Try again to use the default camera.",
    retryable: true,
  },
  insecure_context: {
    title: "Secure connection required",
    message: "Calls need a secure (HTTPS) connection before the camera and microphone can be used.",
    retryable: false,
  },
  unsupported: {
    title: "This browser doesn't support camera access for this call",
    message: "Try Safari on iOS, or Chrome on Android and desktop.",
    retryable: false,
  },
  unknown: {
    title: "We could not start your call",
    message: "Something went wrong while preparing your camera and microphone. Please try again.",
    retryable: true,
  },
};

export function createMediaError(kind: MediaErrorKind): MediaErrorInfo & Error {
  const info = MEDIA_ERRORS[kind];
  const error = new Error(info.message) as MediaErrorInfo & Error;
  error.name = kind;
  error.kind = kind;
  error.title = info.title;
  error.retryable = info.retryable;
  return error;
}

function kindFromDomError(name: string): MediaErrorKind {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "permission_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "device_not_found";
    case "NotReadableError":
    case "TrackStartError":
      return "device_in_use";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "overconstrained";
    case "SecurityError":
      return "insecure_context";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

function isMediaErrorKind(value: string): value is MediaErrorKind {
  return value in MEDIA_ERRORS;
}

/**
 * Map anything the media stack throws onto a message we are willing to show a
 * user. Raw exception text never reaches the UI; it goes to the dev console.
 */
export function toMediaError(error: unknown): MediaErrorInfo {
  let kind: MediaErrorKind = "unknown";
  if (error instanceof Error) {
    kind = isMediaErrorKind(error.name) ? error.name : kindFromDomError(error.name);
  }

  logDiagnostic("media-error", error);
  return { kind, ...MEDIA_ERRORS[kind] };
}
