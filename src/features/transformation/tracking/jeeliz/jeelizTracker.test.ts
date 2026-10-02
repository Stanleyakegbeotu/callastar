import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JeelizTracker } from './jeelizTracker';
import type { JeelizApi } from './jeelizTypes';
import type { TrackerContext } from '../trackerProvider';

let options: Parameters<JeelizApi['init']>[0];
let video: HTMLVideoElement, canvas: HTMLCanvasElement, context: TrackerContext, api: JeelizApi;
let frames: Map<number, VideoFrameRequestCallback>;
beforeEach(() => {
  frames = new Map(); let id = 0;
  video = Object.assign(new EventTarget(), {
    readyState: 2, videoWidth: 640, videoHeight: 480, paused: false, currentTime: 1,
    requestVideoFrameCallback: vi.fn((cb: VideoFrameRequestCallback) => {
      const key = ++id;
      if (key === 1) queueMicrotask(() => cb(0, { expectedDisplayTime: 0, presentedFrames: 1 } as VideoFrameCallbackMetadata));
      else frames.set(key, cb);
      return key;
    }), cancelVideoFrameCallback: vi.fn((key: number) => frames.delete(key)),
  }) as unknown as HTMLVideoElement;
  canvas = Object.assign(new EventTarget(), { width: 480, height: 270 }) as unknown as HTMLCanvasElement;
  api = { create_new: vi.fn(), init: vi.fn(o => { options = o; o.callbackReady(false, { videoElement: video }); }), toggle_pause: vi.fn(async () => {}), resize: vi.fn(() => true), update_videoElement: vi.fn(), destroy: vi.fn(async () => {}) };
  context = { video, canvas, signal: new AbortController().signal, onSample: vi.fn(), onError: vi.fn() };
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }) })));
});
afterEach(() => vi.unstubAllGlobals());
describe('Jeeliz lifecycle and errors', () => {
  it('initializes on the existing video, separate canvas and local model, then starts and disposes', async () => {
    const nativePause = api.toggle_pause;
    const p = new JeelizTracker('default', async () => api); await p.initialize(context);
    expect(options.videoSettings.videoElement).toBe(video); expect(options.canvas).toBe(canvas); expect(options.NNCPath).toBe('/models/jeeliz/NN_DEFAULT.json');
    expect(options.maxFacesDetected).toBe(1); expect(options.followZRot).toBe(true);
    expect(nativePause).toHaveBeenCalledWith(true, false);
    await p.start(); expect(nativePause).toHaveBeenCalledWith(false, false);
    const raw = { detected: .95, x: 0, y: 0, s: .3, rx: .1, ry: .2, rz: .3, expressions: new Float32Array([.5]) };
    options.callbackTrack(raw); raw.expressions[0] = .9;
    expect(context.onSample).toHaveBeenCalledWith(expect.objectContaining({ mouthOpen: .5, gazeX: null, inferenceMs: null, pose: null }));
    await p.stop(); await p.dispose(); await p.dispose(); expect(api.destroy).toHaveBeenCalledTimes(1);
    options.callbackTrack(raw); expect(context.onSample).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  });
  it('does not retain callbacks after cancellation', async () => {
    const abort = new AbortController(); context.signal = abort.signal;
    const p = new JeelizTracker('default', async () => api); await p.initialize(context); await p.start(); abort.abort();
    options.callbackTrack({ detected: 1, x: 0, y: 0, s: .3, rx: 0, ry: 0, rz: 0, expressions: [] });
    expect(context.onSample).not.toHaveBeenCalled(); await p.dispose();
  });
  it('reports module failures', async () => {
    const p = new JeelizTracker('default', async () => { throw new Error('missing chunk'); });
    await expect(p.initialize(context)).rejects.toThrow('module could not load'); await p.dispose();
  });
  it('reports local model 404 instead of silently using a CDN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers() })));
    const p = new JeelizTracker('default', async () => api); await expect(p.initialize(context)).rejects.toThrow('model unavailable'); await p.dispose();
    expect(api.init).not.toHaveBeenCalled();
    expect(api.destroy).not.toHaveBeenCalled();
  });
  it('reports WebGL initialization failure', async () => {
    api.init = vi.fn(o => o.callbackReady('GL_INCOMPATIBLE'));
    const p = new JeelizTracker('default', async () => api); await expect(p.initialize(context)).rejects.toThrow('GL_INCOMPATIBLE'); await p.dispose();
  });
  it('times out initialization and destroys partial resources', async () => {
    api.init = vi.fn(); const p = new JeelizTracker('default', async () => api, 5);
    await expect(p.initialize(context)).rejects.toThrow('timed out'); await p.dispose(); expect(api.destroy).toHaveBeenCalledTimes(1);
  });
  it('cancels initialization while camera readiness is pending', async () => {
    Object.assign(video, { readyState: 0 }); const abort = new AbortController(); context.signal = abort.signal;
    const loader = vi.fn(async () => api); const p = new JeelizTracker('default', loader);
    const pending = p.initialize(context); abort.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await p.dispose(); expect(loader).not.toHaveBeenCalled();
  });
  it('dispose itself cancels pending camera readiness and removes listeners', async () => {
    Object.assign(video, { readyState: 0 });
    const loader = vi.fn(async () => api); const p = new JeelizTracker('default', loader);
    const pending = p.initialize(context); await p.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader).not.toHaveBeenCalled(); expect(context.signal.aborted).toBe(false);
  });
  it('reports context loss after ready and drops future samples', async () => {
    const p = new JeelizTracker('default', async () => api); await p.initialize(context); await p.start();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(context.onError).toHaveBeenCalledWith(expect.stringContaining('context lost')); await p.dispose();
  });
  it('updates processing dimensions on camera resize without another stream request', async () => {
    const p = new JeelizTracker('4-expression', async () => api); await p.initialize(context);
    expect(options.NNCPath).toContain('NN_4EXPR_3.json');
    Object.assign(video, { videoWidth: 720, videoHeight: 1280 }); video.dispatchEvent(new Event('resize'));
    expect(canvas.width).toBe(270); expect(canvas.height).toBe(480); expect(api.resize).toHaveBeenCalled(); await p.dispose();
  });
  it('prevents the official destroy implementation from shutting off the borrowed stream', async () => {
    const nativePause = api.toggle_pause;
    api.destroy = vi.fn(async () => { await api.toggle_pause(true, true); });
    const p = new JeelizTracker('default', async () => api);
    await p.initialize(context); await p.start(); await p.dispose();
    expect(nativePause).not.toHaveBeenCalledWith(true, true);
    expect(nativePause).toHaveBeenLastCalledWith(true, false);
  });
  it('concurrent dispose calls share completion of GPU teardown', async () => {
    let complete!: () => void;
    api.destroy = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const p = new JeelizTracker('default', async () => api); await p.initialize(context);
    const first = p.dispose(), second = p.dispose();
    expect(second).toBe(first); expect(api.destroy).toHaveBeenCalledTimes(1);
    complete(); await first;
  });
});
