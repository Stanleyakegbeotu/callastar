import { detectTransformationCapabilities, type TransformationBrowserCapabilities } from "./capabilities";
import { loadComlink, loadMediaPipeVision, loadOpenCv, loadThreeRenderer } from "./loaders";
import { transformationModelAssets, transformationWasmBasePath } from "./modelAssets";

export interface TransformationPreflightReport {
  browser: TransformationBrowserCapabilities;
  mediaPipeImport: boolean | null;
  mediaPipeWasmAssetsReachable: boolean | null;
  mediaPipeWasmInitialized: boolean | null;
  faceModelConfigured: boolean;
  poseModelConfigured: boolean;
  openCvInitialized: boolean | null;
  threeRendererInitialized: boolean | null;
  workerComlinkReady: boolean | null;
  failures: readonly string[];
}

export type TransformationPreflightCheck = "mediapipe" | "opencv" | "three" | "worker";

/** Explicit developer action only. Run one heavy check per page on memory-limited devices. */
export async function runTransformationPreflight(
  checks: readonly TransformationPreflightCheck[] = [],
  onProgress?: (stage: string) => void,
): Promise<TransformationPreflightReport> {
  if (!import.meta.env.DEV) throw new Error("Transformation preflight is development-only");

  const browser = detectTransformationCapabilities();
  const failures: string[] = [];
  let mediaPipeImport: boolean | null = null;
  let mediaPipeWasmAssetsReachable: boolean | null = null;
  let openCvInitialized: boolean | null = null;
  let threeRendererInitialized: boolean | null = null;
  let workerComlinkReady: boolean | null = null;

  if (checks.includes("mediapipe")) try {
    onProgress?.("mediapipe-import");
    const vision = await loadMediaPipeVision();
    mediaPipeImport = !!vision.FaceLandmarker && !!vision.PoseLandmarker && !!vision.ImageSegmenter;
    if (mediaPipeImport) {
      const wasm = await vision.FilesetResolver.forVisionTasks(transformationWasmBasePath);
      const response = await fetch(wasm.wasmBinaryPath, { method: "HEAD" });
      mediaPipeWasmAssetsReachable = response.ok;
    }
  } catch (error) {
    failures.push(`MediaPipe: ${String(error)}`);
  }

  if (checks.includes("opencv")) try {
    onProgress?.("opencv-import-and-init");
    const cv = await loadOpenCv();
    const mat = new cv.Mat(1, 1, cv.CV_8UC1);
    try {
      openCvInitialized = mat.rows === 1 && mat.cols === 1;
    } finally {
      mat.delete();
    }
  } catch (error) {
    failures.push(`OpenCV: ${String(error)}`);
  }

  if (checks.includes("three") && browser.webGl2) {
    try {
      onProgress?.("three-renderer");
      const { WebGLRenderer } = await loadThreeRenderer();
      const canvas = document.createElement("canvas");
      const renderer = new WebGLRenderer({ canvas, antialias: false });
      try {
        threeRendererInitialized = !!renderer.getContext();
      } finally {
        renderer.dispose();
        renderer.forceContextLoss();
      }
    } catch (error) {
      failures.push(`Three: ${String(error)}`);
    }
  }

  if (checks.includes("worker") && browser.webWorker) {
    let worker: Worker | undefined;
    try {
      onProgress?.("comlink-worker");
      const { wrap } = await loadComlink();
      worker = new Worker(new URL("./workers/smoke.worker.ts", import.meta.url), { type: "module" });
      const remote = wrap<{ ping(): Promise<"ready"> }>(worker);
      workerComlinkReady = (await Promise.race([
        remote.ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Worker ping timed out")), 10_000)),
      ])) === "ready";
    } catch (error) {
      failures.push(`Worker/Comlink: ${String(error)}`);
    } finally {
      worker?.terminate();
    }
  }

  onProgress?.("done");
  return {
    browser,
    mediaPipeImport,
    mediaPipeWasmAssetsReachable,
    // FilesetResolver locates files. Actual WASM runtime initialization requires a model.
    mediaPipeWasmInitialized: checks.includes("mediapipe") ? false : null,
    faceModelConfigured: !!transformationModelAssets.faceLandmarker,
    poseModelConfigured: !!transformationModelAssets.poseLandmarker,
    openCvInitialized,
    threeRendererInitialized,
    workerComlinkReady,
    failures,
  };
}
