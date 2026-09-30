/**
 * The Studio's camera.
 *
 * Deliberately separate from `useLocalMedia`, which owns the camera for a CALL:
 * that hook manages mute state, call-scoped teardown and audio tracks, none of
 * which belong here. The Studio needs video only, must never touch the
 * microphone, and has to survive a camera flip without disturbing the models.
 *
 * Kept as a plain class rather than a hook so the flip and failure paths can be
 * tested without a renderer.
 */

export type CameraFacing = "user" | "environment";

/**
 * Why a camera could not start.
 *
 * Mapped from the DOMException names `getUserMedia` actually throws, because
 * each one means something different to the person reading the screen: a
 * refused permission is fixed in browser settings, a missing camera is not.
 */
export type CameraErrorCode =
  | "permission_denied"
  | "not_found"
  | "in_use"
  | "overconstrained"
  | "insecure_context"
  | "unsupported"
  | "unknown";

export interface CameraError {
  code: CameraErrorCode;
  message: string;
}

export interface CameraState {
  stream: MediaStream | null;
  facing: CameraFacing;
  /** The camera's actual frame size, once known. */
  width: number | null;
  height: number | null;
  /** Whether the preview should be mirrored — true for a front camera. */
  mirrored: boolean;
}

export function describeCameraError(error: unknown): CameraError {
  const name = error instanceof DOMException ? error.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        code: "permission_denied",
        message: "Camera access is blocked. Allow camera access in your browser settings to use Transformation Studio.",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { code: "not_found", message: "No camera was found on this device." };
    case "NotReadableError":
    case "TrackStartError":
      return { code: "in_use", message: "The camera is already in use by another application." };
    case "OverconstrainedError":
      return { code: "overconstrained", message: "This camera does not support the requested settings." };
    default:
      return { code: "unknown", message: "The camera could not be started. Please try again." };
  }
}

/**
 * Constraints for one facing direction.
 *
 * Everything is `ideal`. A hard `exact` on resolution makes `getUserMedia`
 * throw `OverconstrainedError` on any device that cannot deliver it, which is
 * most phones for most numbers — and a working camera at an unexpected size is
 * far better than no camera.
 *
 * `facingMode` is also ideal, so a laptop with one webcam still starts when the
 * Studio asks for the rear camera; the flip path checks what it actually got.
 */
export function cameraConstraints(facing: CameraFacing): MediaStreamConstraints {
  return {
    // Never the microphone. The Studio previews appearance, and nothing here
    // needs to hear the room.
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  };
}

export class StudioCamera {
  private stream: MediaStream | null = null;
  private facing: CameraFacing = "user";
  private disposed = false;

  /** Guards against two flips overlapping, which would strand a track. */
  private switching = false;

  get state(): CameraState {
    const track = this.stream?.getVideoTracks()[0];
    const settings = track?.getSettings();

    return {
      stream: this.stream,
      facing: this.facing,
      width: settings?.width ?? null,
      height: settings?.height ?? null,
      // A front camera is shown mirrored because that is what people expect of
      // a selfie view; the tracker still receives the unmirrored frame.
      mirrored: this.facing === "user",
    };
  }

  get isSwitching(): boolean {
    return this.switching;
  }

  /**
   * Starts the camera. Only ever called from an explicit user action.
   *
   * Never on route load: a permission prompt nobody asked for is a prompt people
   * dismiss, and a dismissed prompt is expensive to recover from.
   */
  async start(facing: CameraFacing = "user"): Promise<MediaStream> {
    if (this.disposed) throw new Error("StudioCamera has been disposed");

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("Camera capture is not supported in this browser."), {
        cameraError: { code: "unsupported", message: "This browser cannot use a camera." } satisfies CameraError,
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing));

    // Disposal can land during the permission prompt, which a person can leave
    // sitting for a long time.
    if (this.disposed) {
      stopStream(stream);
      throw new Error("StudioCamera was disposed while starting");
    }

    stopStream(this.stream);
    this.stream = stream;
    this.facing = facing;
    return stream;
  }

  /**
   * Flips front to rear, or back.
   *
   * The previous stream is kept until the replacement is actually in hand, so a
   * device with no rear camera keeps working rather than being left with a black
   * preview. Some phones will only run one camera at a time and refuse the
   * second while the first is live — the fallback below stops the old one and
   * tries again, and restores the original facing if even that fails.
   */
  async flip(): Promise<{ stream: MediaStream; facing: CameraFacing }> {
    if (this.disposed) throw new Error("StudioCamera has been disposed");
    if (this.switching) throw new Error("A camera switch is already in progress");

    // Reassigned to null once released, so the success path below cannot stop
    // the same tracks a second time.
    let previous = this.stream;
    const previousFacing = this.facing;
    const target: CameraFacing = previousFacing === "user" ? "environment" : "user";

    this.switching = true;

    try {
      let replacement: MediaStream;

      try {
        // Preferred: acquire first, so a failure costs nothing.
        replacement = await navigator.mediaDevices.getUserMedia(cameraConstraints(target));
      } catch (firstAttempt) {
        // Plenty of phones will only run one camera at a time.
        stopStream(previous);
        previous = null;
        this.stream = null;

        try {
          replacement = await navigator.mediaDevices.getUserMedia(cameraConstraints(target));
        } catch {
          // The target is genuinely unavailable. Put the original back rather
          // than leaving the Studio with no camera at all.
          try {
            const restored = await navigator.mediaDevices.getUserMedia(cameraConstraints(previousFacing));
            this.stream = restored;
            this.facing = previousFacing;
          } catch {
            // Nothing left to restore; the caller is told via the throw below.
          }
          throw firstAttempt;
        }
      }

      if (this.disposed) {
        stopStream(replacement);
        throw new Error("StudioCamera was disposed while switching");
      }

      // Only now is the old one released.
      stopStream(previous);
      this.stream = replacement;
      this.facing = target;
      return { stream: replacement, facing: target };
    } finally {
      this.switching = false;
    }
  }

  /** Stops every track. The browser's camera indicator goes out here. */
  stop(): void {
    stopStream(this.stream);
    this.stream = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }
}

/** Idempotent, and safe on a stream whose tracks have already ended. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that cannot be stopped has already ended.
    }
  }
}
