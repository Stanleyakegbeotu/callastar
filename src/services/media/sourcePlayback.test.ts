import { expect, it } from "vitest"
import { isUsableSourceVideo } from "./sourcePlayback"

const frame = {
  duration: 5.125,
  videoWidth: 640,
  videoHeight: 360,
  readyState: 4,
}
it("uses actual finite media duration and a decoded frame", () =>
  expect(isUsableSourceVideo(frame)).toBe(true))
it.each([0, NaN, Infinity, -1])(
  "rejects unusable media duration %s",
  (duration) => expect(isUsableSourceVideo({ ...frame, duration })).toBe(false),
)
it.each([{ videoWidth: 0 }, { videoHeight: 0 }, { readyState: 1 }])(
  "does not authorize playback before video readiness %j",
  (change) => expect(isUsableSourceVideo({ ...frame, ...change })).toBe(false),
)
