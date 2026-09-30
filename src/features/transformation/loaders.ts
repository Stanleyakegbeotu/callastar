/** Import boundaries only. Importing this file does not start any CV runtime. */
export async function loadMediaPipeVision() {
  return import("@mediapipe/tasks-vision");
}

let openCvPromise: Promise<typeof import("@techstark/opencv-js")> | undefined;

export function loadOpenCv(): Promise<typeof import("@techstark/opencv-js")> {
  openCvPromise ??= import("@techstark/opencv-js").then(async (module) => {
    const candidate = (module.default ?? module) as unknown;
    const runtime = await Promise.resolve(candidate);
    if (typeof runtime !== "object" || runtime === null) throw new Error("OpenCV module is unavailable");
    if ("Mat" in runtime && typeof runtime.Mat === "function") return runtime as typeof import("@techstark/opencv-js");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OpenCV initialization timed out")), 30_000);
      (runtime as { onRuntimeInitialized?: () => void }).onRuntimeInitialized = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    if (!("Mat" in runtime) || typeof runtime.Mat !== "function") throw new Error("OpenCV Mat unavailable");
    return runtime as typeof import("@techstark/opencv-js");
  }).catch((error: unknown) => {
    openCvPromise = undefined;
    throw error;
  });
  return openCvPromise;
}

export async function loadThreeRenderer() {
  return import("three");
}

export async function loadComlink() {
  return import("comlink");
}
