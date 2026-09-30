import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudioCamera, cameraConstraints, describeCameraError, stopStream } from "./studioCamera";

/**
 * The Studio's camera.
 *
 * Two things are worth more than the rest here. The first is that it never asks
 * for the microphone — the Studio previews appearance, and an unexplained
 * recording indicator is not something to hand someone. The second is the flip:
 * plenty of phones will only run one camera at a time, so the sequence of
 * acquire, fall back, and restore is where a device ends up with a black preview
 * and no way back.
 */

interface FakeTrack {
  kind: string;
  stop: ReturnType<typeof vi.fn>;
  getSettings: () => MediaTrackSettings;
}

function makeStream(label: string, settings: MediaTrackSettings = { width: 1280, height: 720 }) {
  const track: FakeTrack = {
    kind: "video",
    stop: vi.fn(),
    getSettings: () => settings,
  };

  const stream = {
    label,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };

  return { stream: stream as unknown as MediaStream, track };
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every constraint object `getUserMedia` was called with. */
function requestedConstraints(): MediaStreamConstraints[] {
  return getUserMedia.mock.calls.map((call) => call[0] as MediaStreamConstraints);
}

function facingOf(constraints: MediaStreamConstraints): string | undefined {
  const video = constraints.video as MediaTrackConstraints | undefined;
  const facingMode = video?.facingMode as { ideal?: string } | undefined;
  return facingMode?.ideal;
}

describe("constraints", () => {
  it("never asks for the microphone", () => {
    // The whole point of a separate camera controller: `useLocalMedia` owns the
    // call's microphone, and the Studio has no business touching it.
    for (const facing of ["user", "environment"] as const) {
      expect(cameraConstraints(facing).audio).toBe(false);
    }
  });

  it("asks for a resolution rather than demanding one", () => {
    /*
     * `ideal`, never `exact`.
     *
     * A hard constraint makes `getUserMedia` throw `OverconstrainedError` on any
     * device that cannot deliver the number, which is most phones for most
     * numbers — and a working camera at an unexpected size beats no camera.
     */
    const video = cameraConstraints("user").video as MediaTrackConstraints;

    expect(video.width).toEqual({ ideal: 1280 });
    expect(video.height).toEqual({ ideal: 720 });
    expect(video.facingMode).toEqual({ ideal: "user" });
    expect(JSON.stringify(video)).not.toContain("exact");
  });
});

describe("start", () => {
  it("opens the front camera and reports its real frame size", () => {
    return (async () => {
      const front = makeStream("front", { width: 720, height: 1280 });
      getUserMedia.mockResolvedValue(front.stream);

      const camera = new StudioCamera();
      const stream = await camera.start("user");

      expect(stream).toBe(front.stream);
      expect(camera.state.facing).toBe("user");
      // Reported by the track, not by what was asked for.
      expect(camera.state.width).toBe(720);
      expect(camera.state.height).toBe(1280);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(requestedConstraints()[0]?.audio).toBe(false);
    })();
  });

  it("mirrors a front camera and not a rear one", async () => {
    // A selfie view is mirrored because that is what people expect; a rear
    // camera showing the room is not.
    getUserMedia.mockResolvedValue(makeStream("any").stream);

    const front = new StudioCamera();
    await front.start("user");
    expect(front.state.mirrored).toBe(true);

    const rear = new StudioCamera();
    await rear.start("environment");
    expect(rear.state.mirrored).toBe(false);
  });

  it("reports null dimensions until the track knows them", async () => {
    // Better an honest null than a fabricated 0×0 the overlay would map against.
    getUserMedia.mockResolvedValue(makeStream("pending", {}).stream);

    const camera = new StudioCamera();
    await camera.start();

    expect(camera.state.width).toBeNull();
    expect(camera.state.height).toBeNull();
  });

  it("replaces an earlier stream instead of leaking it", async () => {
    const first = makeStream("first");
    const second = makeStream("second");
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);

    const camera = new StudioCamera();
    await camera.start("user");
    await camera.start("user");

    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(camera.state.stream).toBe(second.stream);
  });

  it("surfaces a refused permission as its own case", async () => {
    // Refused permission is fixed in browser settings; a missing camera is not.
    // Telling someone the wrong one wastes their time.
    getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));

    const camera = new StudioCamera();
    await expect(camera.start()).rejects.toThrow();
    expect(camera.state.stream).toBeNull();
  });

  it("surfaces a missing camera as its own case", async () => {
    getUserMedia.mockRejectedValue(new DOMException("None", "NotFoundError"));

    const camera = new StudioCamera();
    await expect(camera.start()).rejects.toThrow();
    expect(camera.state.stream).toBeNull();
  });

  it("refuses when the browser cannot capture at all", async () => {
    // An insecure origin is the common cause: `mediaDevices` is simply absent.
    vi.stubGlobal("navigator", {});

    const camera = new StudioCamera();
    await expect(camera.start()).rejects.toThrow(/not supported/i);
  });

  it("stops a stream that arrives after the route was left", async () => {
    /*
     * A permission prompt can sit unanswered for a long time, and the operator
     * may well navigate away while it does. The stream still arrives — and if it
     * is kept, the camera light stays on with nothing rendering it.
     */
    const late = makeStream("late");
    let resolveStream: (stream: MediaStream) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      }),
    );

    const camera = new StudioCamera();
    const pending = camera.start();

    camera.dispose();
    resolveStream(late.stream);

    await expect(pending).rejects.toThrow(/disposed/i);
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(camera.state.stream).toBeNull();
  });
});

describe("flip", () => {
  it("acquires the replacement before releasing the original", async () => {
    /*
     * Order matters.
     *
     * Stopping first and then discovering the other camera is unavailable leaves
     * the Studio with a black preview and nothing to fall back to.
     */
    const front = makeStream("front");
    const rear = makeStream("rear");
    getUserMedia.mockResolvedValueOnce(front.stream).mockResolvedValueOnce(rear.stream);

    const camera = new StudioCamera();
    await camera.start("user");
    expect(front.track.stop).not.toHaveBeenCalled();

    const result = await camera.flip();

    expect(result.facing).toBe("environment");
    expect(result.stream).toBe(rear.stream);
    expect(front.track.stop, "the original is released only once the flip worked").toHaveBeenCalledTimes(1);
    expect(camera.state.facing).toBe("environment");
    expect(camera.state.mirrored).toBe(false);
    expect(facingOf(requestedConstraints()[1]!)).toBe("environment");
  });

  it("flips back again", async () => {
    getUserMedia
      .mockResolvedValueOnce(makeStream("front").stream)
      .mockResolvedValueOnce(makeStream("rear").stream)
      .mockResolvedValueOnce(makeStream("front-again").stream);

    const camera = new StudioCamera();
    await camera.start("user");
    await camera.flip();
    const back = await camera.flip();

    expect(back.facing).toBe("user");
    expect(camera.state.mirrored).toBe(true);
  });

  it("retries after releasing the original when the device allows only one camera", async () => {
    // Many phones refuse the second camera while the first is live. Stopping the
    // original and asking again is the documented way through.
    const front = makeStream("front");
    const rear = makeStream("rear");

    getUserMedia
      .mockResolvedValueOnce(front.stream)
      .mockRejectedValueOnce(new DOMException("Busy", "NotReadableError"))
      .mockResolvedValueOnce(rear.stream);

    const camera = new StudioCamera();
    await camera.start("user");
    const result = await camera.flip();

    expect(front.track.stop).toHaveBeenCalledTimes(1);
    expect(result.facing).toBe("environment");
    expect(camera.state.stream).toBe(rear.stream);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("restores the original camera when the other one is genuinely unavailable", async () => {
    /*
     * The recovery path.
     *
     * A laptop with one webcam will fail both attempts. Leaving the Studio with
     * no camera would be a worse outcome than the flip simply not happening, so
     * the original facing is re-acquired and the caller is told why.
     */
    const front = makeStream("front");
    const restored = makeStream("restored");

    getUserMedia
      .mockResolvedValueOnce(front.stream)
      .mockRejectedValueOnce(new DOMException("None", "NotFoundError"))
      .mockRejectedValueOnce(new DOMException("None", "NotFoundError"))
      .mockResolvedValueOnce(restored.stream);

    const camera = new StudioCamera();
    await camera.start("user");

    await expect(camera.flip()).rejects.toThrow();

    expect(camera.state.facing, "the facing reverts with the stream").toBe("user");
    expect(camera.state.stream).toBe(restored.stream);
    expect(camera.state.mirrored).toBe(true);
    expect(camera.isSwitching).toBe(false);
    expect(facingOf(requestedConstraints()[3]!)).toBe("user");
  });

  it("reports the original failure, not the restore failure", async () => {
    // What went wrong is that the rear camera was not readable. That the restore
    // also failed is a second-order detail that would only confuse the message.
    const front = makeStream("front");
    const firstError = new DOMException("Busy", "NotReadableError");

    getUserMedia
      .mockResolvedValueOnce(front.stream)
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(new DOMException("Busy", "NotReadableError"))
      .mockRejectedValueOnce(new DOMException("Gone", "NotFoundError"));

    const camera = new StudioCamera();
    await camera.start("user");

    await expect(camera.flip()).rejects.toBe(firstError);
    expect(camera.state.stream, "nothing was recoverable, and that is reported honestly").toBeNull();
  });

  it("refuses to run two flips at once", async () => {
    // Two overlapping switches would strand a track with no owner to stop it.
    const front = makeStream("front");
    let releaseSecond: (stream: MediaStream) => void = () => {};

    getUserMedia.mockResolvedValueOnce(front.stream).mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        releaseSecond = resolve;
      }),
    );

    const camera = new StudioCamera();
    await camera.start("user");

    const first = camera.flip();
    expect(camera.isSwitching).toBe(true);
    await expect(camera.flip()).rejects.toThrow(/already in progress/i);

    releaseSecond(makeStream("rear").stream);
    await first;
    expect(camera.isSwitching).toBe(false);
  });

  it("stops a replacement that arrives after disposal", async () => {
    const front = makeStream("front");
    const rear = makeStream("rear");
    let releaseRear: (stream: MediaStream) => void = () => {};

    getUserMedia.mockResolvedValueOnce(front.stream).mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        releaseRear = resolve;
      }),
    );

    const camera = new StudioCamera();
    await camera.start("user");

    const pending = camera.flip();
    camera.dispose();
    releaseRear(rear.stream);

    await expect(pending).rejects.toThrow(/disposed/i);
    expect(rear.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stop and disposal", () => {
  it("stops every track, which is what turns the camera light off", async () => {
    const front = makeStream("front");
    getUserMedia.mockResolvedValue(front.stream);

    const camera = new StudioCamera();
    await camera.start();
    camera.stop();

    expect(front.track.stop).toHaveBeenCalledTimes(1);
    expect(camera.state.stream).toBeNull();
  });

  it("is safe to stop repeatedly", async () => {
    // React's StrictMode runs effect cleanup twice in development, so this is
    // the ordinary case rather than a defensive one.
    const front = makeStream("front");
    getUserMedia.mockResolvedValue(front.stream);

    const camera = new StudioCamera();
    await camera.start();

    camera.stop();
    camera.stop();
    camera.stop();

    expect(front.track.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the camera on route disposal and refuses to start again", async () => {
    const front = makeStream("front");
    getUserMedia.mockResolvedValue(front.stream);

    const camera = new StudioCamera();
    await camera.start();
    camera.dispose();

    expect(front.track.stop).toHaveBeenCalledTimes(1);
    await expect(camera.start()).rejects.toThrow(/disposed/i);
    await expect(camera.flip()).rejects.toThrow(/disposed/i);
    // The refusal is not itself a camera request.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("is safe to dispose repeatedly", async () => {
    const front = makeStream("front");
    getUserMedia.mockResolvedValue(front.stream);

    const camera = new StudioCamera();
    await camera.start();

    camera.dispose();
    expect(() => camera.dispose()).not.toThrow();
    expect(front.track.stop).toHaveBeenCalledTimes(1);
  });

  it("disposes cleanly when it never started", () => {
    const camera = new StudioCamera();
    expect(() => camera.dispose()).not.toThrow();
    expect(camera.state.stream).toBeNull();
  });
});

describe("error descriptions", () => {
  it("maps each failure to advice that fits it", () => {
    expect(describeCameraError(new DOMException("", "NotAllowedError")).code).toBe("permission_denied");
    expect(describeCameraError(new DOMException("", "SecurityError")).code).toBe("permission_denied");
    expect(describeCameraError(new DOMException("", "NotFoundError")).code).toBe("not_found");
    expect(describeCameraError(new DOMException("", "NotReadableError")).code).toBe("in_use");
    expect(describeCameraError(new DOMException("", "OverconstrainedError")).code).toBe("overconstrained");
  });

  it("falls back rather than showing a DOMException name to a person", () => {
    expect(describeCameraError(new Error("boom")).code).toBe("unknown");
    expect(describeCameraError(undefined).code).toBe("unknown");
    expect(describeCameraError(new Error("boom")).message).not.toContain("boom");
  });

  it("gives every case a message worth reading", () => {
    for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError"]) {
      const described = describeCameraError(new DOMException("", name));
      expect(described.message.length).toBeGreaterThan(10);
      expect(described.message).not.toContain(name);
    }
  });
});

describe("stopStream", () => {
  it("tolerates nothing to stop", () => {
    expect(() => stopStream(null)).not.toThrow();
    expect(() => stopStream(undefined)).not.toThrow();
  });

  it("keeps going when a track refuses to stop", () => {
    // A track that throws has already ended; the rest still need stopping.
    const bad = { kind: "video", stop: vi.fn(() => { throw new Error("already ended"); }) };
    const good = { kind: "video", stop: vi.fn() };
    const stream = { getTracks: () => [bad, good] } as unknown as MediaStream;

    expect(() => stopStream(stream)).not.toThrow();
    expect(good.stop).toHaveBeenCalledTimes(1);
  });
});
