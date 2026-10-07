import { afterEach, expect, it, vi } from "vitest";
import { captureCallVideoComposition } from "./capture";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function scene(mainReady: boolean, pipReady = false, tainted = false) {
  const drawn: unknown[] = [];
  const bounds = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
  const video = (ready: boolean) => ({ readyState: ready ? 4 : 0, videoWidth: ready ? 640 : 0, videoHeight: ready ? 360 : 0,
    error: null, paused: false, isConnected: true, currentSrc: "", srcObject: null, getBoundingClientRect: () => bounds,
    requestVideoFrameCallback: (cb: () => void) => { setTimeout(cb, 5); return 1; }, cancelVideoFrameCallback: () => {},
  });
  const main = video(mainReady); const pip = video(pipReady);
  const surface = { getBoundingClientRect: () => bounds, querySelector: () => main, querySelectorAll: () => [pip] };
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block", opacity: "1", transform: "none", objectFit: "contain" }));
  vi.stubGlobal("document", { querySelector: () => surface, createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ fillRect: () => {}, drawImage: (source: unknown) => drawn.push(source) }),
    toBlob: (cb: (blob: Blob) => void) => { if (tainted) throw new DOMException("tainted", "SecurityError"); cb(new Blob(["jpeg"], { type: "image/jpeg" })); },
  }) });
  return { main, pip, drawn };
}
it("waits for a presented main frame and succeeds without PiP", async () => {
  vi.useFakeTimers(); const { main, drawn } = scene(true);
  let completed = false;
  const captured = captureCallVideoComposition({} as MediaStream).then((image) => { completed = true; return image; });
  await vi.advanceTimersByTimeAsync(100); expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(200); expect((await captured).blob.size).toBeGreaterThan(0);
  expect(drawn).toEqual([main]);
});
it("rejects a blank main frame even when the local PiP is ready", async () => {
  vi.useFakeTimers(); const { drawn } = scene(false, true);
  const assertion = expect(captureCallVideoComposition({} as MediaStream)).rejects.toThrow("main_call_video_not_rendered");
  await vi.advanceTimersByTimeAsync(1600); await assertion; expect(drawn).toEqual([]);
});
it("does not encode a frame after the call has ended", async () => {
  vi.useFakeTimers(); const { drawn } = scene(true);
  const assertion = expect(captureCallVideoComposition({} as MediaStream, () => false)).rejects.toThrow("call_video_changed");
  await vi.advanceTimersByTimeAsync(300); await assertion; expect(drawn).toEqual([]);
});
it("reports cross-origin canvas taint as a visible capture failure", async () => {
  vi.useFakeTimers(); scene(true, false, true);
  const assertion = expect(captureCallVideoComposition({} as MediaStream)).rejects.toThrow("canvas_tainted_cross_origin_media");
  await vi.advanceTimersByTimeAsync(300);
  await assertion;
});
