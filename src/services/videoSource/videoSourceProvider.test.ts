import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveCameraSource, createUploadedSource } from "./videoSourceProvider";

/**
 * How each source mode is carried, and — the part that keeps being got wrong —
 * what audio comes with it.
 *
 * The product rule these guard:
 *
 *   LIVE CAMERA     live camera  + live microphone
 *   UPLOADED SOURCE the source video, with the audio embedded in that file
 *
 * The two must not be mixed. A microphone published alongside an uploaded source
 * would put the operator's room noise over a recording, and the same media
 * playing on both devices at once is an echo. Neither is something a screen
 * would show you; both are things a test can.
 */

/** A stand-in track, enough for the code under test to inspect `kind`. */
function fakeTrack(kind: "audio" | "video") {
  return { kind, enabled: true, stop: vi.fn(), readyState: "live" } as unknown as MediaStreamTrack;
}

let requested: MediaStreamConstraints[] = [];

beforeEach(() => {
  requested = [];

  const tracks = [fakeTrack("video"), fakeTrack("audio")];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as unknown as MediaStream;

  vi.stubGlobal("window", { isSecureContext: true, RTCPeerConnection: function () {} });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: (constraints: MediaStreamConstraints) => {
        requested.push(constraints);
        return Promise.resolve(stream);
      },
      enumerateDevices: () => Promise.resolve([]),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live camera source", () => {
  it("publishes a real track, and asks for the microphone with it", async () => {
    // Rule 13. A live camera without a live microphone is a silent participant.
    const source = createLiveCameraSource("video");
    const result = await source.start();

    expect(result.mode).toBe("track");
    expect(result.kind).toBe("live-camera");
    if (result.mode === "track") {
      expect(result.videoTrack?.kind).toBe("video");
      expect(result.stream.getAudioTracks()).toHaveLength(1);
    }

    expect(requested.length).toBeGreaterThan(0);
    const [first] = requested;
    expect(first?.audio, "live camera must request the microphone").toBeTruthy();
    expect(first?.video, "live camera must request the camera").toBeTruthy();
  });

  it("asks for the microphone alone on an audio call", async () => {
    // No camera is opened for a call that has no picture — that is what keeps
    // the camera indicator dark during an audio call.
    const source = createLiveCameraSource("audio");
    await source.start();

    const [first] = requested;
    expect(first?.audio).toBeTruthy();
    expect(first?.video, "an audio call must not open a camera").toBeFalsy();
  });

  it("reports availability without acquiring anything", async () => {
    // `prepare` is what lets the sheet disable an option it knows will fail; it
    // must not turn the camera light on to answer that question.
    const source = createLiveCameraSource("video");
    await expect(source.prepare()).resolves.toEqual({ available: true });
    expect(requested, "prepare must not call getUserMedia").toHaveLength(0);
  });
});

describe("uploaded source", () => {
  it("carries no track, so no microphone rides along with it", async () => {
    /*
     * Rule 11 and the echo rule.
     *
     * An uploaded source is played by the FAR end from its own file, so this
     * side publishes nothing: no track, and therefore no live microphone mixed
     * under a recording. The audio the caller hears is the audio in the file.
     */
    const source = createUploadedSource("asset_1");
    const result = await source.start();

    expect(result.mode).toBe("remote-playback");
    expect(result.kind).toBe("uploaded-source");
    if (result.mode === "remote-playback") {
      expect(result.mediaAssetId).toBe("asset_1");
    }

    expect(requested, "an uploaded source must not open any device").toHaveLength(0);
  });

  it("refuses a profile that has nothing uploaded", async () => {
    const source = createUploadedSource(null);
    await expect(source.prepare()).resolves.toEqual({ available: false, reason: "not_uploaded" });
    await expect(source.start()).rejects.toThrow(/no call source/i);
  });

  it("stopping it touches no device", async () => {
    // There is nothing held on this side, so cleanup is a no-op rather than a
    // track being stopped that was never opened.
    const source = createUploadedSource("asset_1");
    await source.start();
    await expect(source.stop()).resolves.toBeUndefined();
  });
});
