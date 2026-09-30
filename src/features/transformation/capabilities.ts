/** Readiness checks use feature presence only; they never enumerate devices or ask permission. */
export interface TransformationBrowserCapabilities {
  webGl2: boolean;
  offscreenCanvas: boolean;
  webWorker: boolean;
  requestVideoFrameCallback: boolean;
  canvasCaptureStream: boolean;
  replaceTrack: boolean;
  getUserMedia: boolean;
}

export function detectTransformationCapabilities(scope: typeof globalThis = globalThis): TransformationBrowserCapabilities {
  const browser = scope as typeof globalThis & { HTMLCanvasElement?: typeof HTMLCanvasElement };
  let webGl2 = false;
  try {
    const canvas = browser.document?.createElement("canvas");
    webGl2 = !!canvas?.getContext("webgl2");
  } catch {
    // A disabled or unavailable graphics context is a normal negative result.
  }

  return {
    webGl2,
    offscreenCanvas: typeof browser.OffscreenCanvas !== "undefined",
    webWorker: typeof browser.Worker !== "undefined",
    requestVideoFrameCallback: typeof browser.HTMLVideoElement?.prototype.requestVideoFrameCallback === "function",
    canvasCaptureStream: typeof browser.HTMLCanvasElement?.prototype.captureStream === "function",
    replaceTrack: typeof browser.RTCRtpSender?.prototype.replaceTrack === "function",
    getUserMedia: typeof browser.navigator?.mediaDevices?.getUserMedia === "function",
  };
}
