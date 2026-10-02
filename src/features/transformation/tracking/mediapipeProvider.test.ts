import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaPipeProvider } from './mediapipeProvider';
import type { FaceTracker } from '../engine/faceTracker';
import { NO_FACE_RESULT } from '../engine/faceTypes';
import type { TrackerContext } from './trackerProvider';

function fixture(ready = true) {
  let id = 0;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  const video = Object.assign(new EventTarget(), {
    readyState: ready ? 2 : 0, paused: false, videoWidth: 640, videoHeight: 480, currentTime: 1,
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
      const handle = ++id;
      if (handle === 1) queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata));
      else callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: vi.fn((handle: number) => callbacks.delete(handle)),
  }) as unknown as HTMLVideoElement;
  const drawImage = vi.fn();
  const canvas = { width: 1, height: 1, getContext: vi.fn(() => ({ drawImage })) } as unknown as HTMLCanvasElement;
  const face = { ready: true, getTimings: () => ({ initMs: 25 }), dispose: vi.fn(), detect: vi.fn((_frame, timestampMs) => ({ ...NO_FACE_RESULT, timestampMs })) } as unknown as FaceTracker;
  const context: TrackerContext = { video, canvas, signal: new AbortController().signal, onSample: vi.fn(), onError: vi.fn() };
  return { face, context, callbacks, drawImage };
}
afterEach(() => vi.unstubAllGlobals());
describe('borrowed MediaPipe benchmark provider', () => {
  it('runs face-only on the existing video and releases callbacks without disposing the Studio task', async () => {
    const f = fixture(), p = new MediaPipeProvider(f.face);
    await p.initialize(f.context); await p.start();
    const [handle, callback] = [...f.callbacks][0]!; f.callbacks.delete(handle);
    callback(100, { expectedDisplayTime: 100, presentedFrames: 1 } as VideoFrameCallbackMetadata);
    expect(f.drawImage).toHaveBeenCalledWith(f.context.video, 0, 0, 480, 360);
    expect(f.face.detect).toHaveBeenCalledTimes(1);
    expect(f.context.onSample).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mediapipe', detected: false, pose: null, landmarkCount: 0 }));
    expect(p.initializationMs).toBe(25);
    p.dispose(); expect(f.callbacks.size).toBe(0); expect(f.face.dispose).not.toHaveBeenCalled();
  });
  it('dispose aborts pending video readiness while leaving the upstream signal and face task untouched', async () => {
    const f = fixture(false), p = new MediaPipeProvider(f.face);
    const pending = p.initialize(f.context); p.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.context.signal.aborted).toBe(false); expect(f.face.dispose).not.toHaveBeenCalled();
  });
  it('reports drawing failures through the controlled provider error callback', async () => {
    const f = fixture(), p = new MediaPipeProvider(f.face);
    vi.mocked(f.context.canvas.getContext).mockReturnValue(null);
    await p.initialize(f.context); await p.start();
    const [handle, callback] = [...f.callbacks][0]!; f.callbacks.delete(handle);
    callback(100, { expectedDisplayTime: 100, presentedFrames: 1 } as VideoFrameCallbackMetadata);
    expect(f.context.onError).toHaveBeenCalledWith(expect.stringContaining('surface unavailable'));
    expect(f.callbacks.size).toBe(0); p.dispose();
  });
});
