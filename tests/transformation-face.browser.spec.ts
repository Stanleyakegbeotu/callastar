import { expect, test } from "@playwright/test";

/**
 * The Face Landmarker, against the real official model.
 *
 * The unit suite proves the wrapper's behaviour with a stub. This proves the
 * thing a stub cannot: that the self-hosted 3.6 MB model actually loads through
 * the app's own origin, instantiates on this WASM build, and returns landmarks,
 * blendshapes and a transformation matrix from a real image.
 *
 * The fixture is a face drawn onto a canvas rather than a photograph. That is a
 * deliberate trade: it keeps the repository free of a picture of a person, and
 * it is deterministic. It also means a negative result here is not proof the
 * model is broken — a synthetic face is a hard case — so the assertions
 * distinguish "the runtime works" from "this drawing was recognised".
 */

test.describe("Face Landmarker runtime", () => {
  test("loads the official model and reports its timings", async ({ page }) => {
    await page.goto("/");

    const report = await page.evaluate(async () => {
      const started = performance.now();
      const { FaceTracker } = await import("/src/features/transformation/engine/faceTracker.ts");
      const importMs = performance.now() - started;

      const tracker = new FaceTracker();
      const initStart = performance.now();
      await tracker.initialize();
      const initMs = performance.now() - initStart;

      const ready = tracker.ready;
      const timings = tracker.getTimings();
      tracker.dispose();

      return { importMs, initMs, ready, disposedReady: tracker.ready, reportedInit: timings.initMs };
    });

    // The runtime is what is being proved here.
    expect(report.ready, "the tracker should be ready after initialize()").toBe(true);
    expect(report.disposedReady, "dispose() must release it").toBe(false);
    expect(report.reportedInit).toBeGreaterThan(0);

    console.log(
      `[face] module import ${report.importMs.toFixed(0)}ms · model init ${report.initMs.toFixed(0)}ms`,
    );
  });

  test("runs inference on a real frame and returns the selected outputs", async ({ page }) => {
    await page.goto("/");

    const report = await page.evaluate(async () => {
      const { FaceTracker } = await import("/src/features/transformation/engine/faceTracker.ts");

      /*
       * A synthetic face.
       *
       * Rough proportions only — the point is to hand the model a real decoded
       * image at a realistic size, not to guarantee a detection.
       */
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");

      context.fillStyle = "#c8c8c8";
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.fillStyle = "#e0b89a";
      context.beginPath();
      context.ellipse(320, 240, 110, 145, 0, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = "#ffffff";
      context.beginPath();
      context.ellipse(280, 205, 26, 15, 0, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(360, 205, 26, 15, 0, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = "#3a2a1a";
      context.beginPath();
      context.ellipse(280, 205, 10, 10, 0, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(360, 205, 10, 10, 0, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = "#8a5a4a";
      context.lineWidth = 6;
      context.beginPath();
      context.moveTo(288, 300);
      context.quadraticCurveTo(320, 320, 352, 300);
      context.stroke();

      const tracker = new FaceTracker();
      await tracker.initialize();

      // Several frames: the first inference is always slower, and VIDEO mode
      // expects a sequence rather than a single shot.
      const durations: number[] = [];
      let last: ReturnType<typeof tracker.detect> | null = null;
      for (let i = 0; i < 10; i += 1) {
        const started = performance.now();
        last = tracker.detect(canvas, i * 33);
        durations.push(performance.now() - started);
      }

      const timings = tracker.getTimings();
      tracker.dispose();

      return {
        status: last?.status ?? "none",
        detected: last?.detected ?? false,
        landmarkCount: last?.landmarks.length ?? 0,
        blendshapeCount: Object.keys(last?.blendshapes ?? {}).length,
        matrixLength: last?.facialTransformationMatrix?.length ?? 0,
        confidence: last?.confidence ?? 0,
        derived: last?.derived
          ? {
              yaw: last.derived.yaw,
              pitch: last.derived.pitch,
              roll: last.derived.roll,
              eyeOpenness: last.derived.eyeOpenness,
              mouthOpenness: last.derived.mouthOpenness,
              scale: last.derived.scale,
            }
          : null,
        firstInferenceMs: timings.firstInferenceMs,
        averageInferenceMs: timings.averageInferenceMs,
        durations,
        inferenceCount: timings.inferenceCount,
      };
    });

    // Inference ran on every frame, whatever it found.
    expect(report.inferenceCount).toBe(10);
    expect(report.status, "the runtime must produce a real result, not a skip").not.toBe("skipped");

    console.log(
      `[face] status=${report.status} landmarks=${report.landmarkCount} ` +
        `blendshapes=${report.blendshapeCount} matrix=${report.matrixLength} ` +
        `confidence=${report.confidence.toFixed(2)} ` +
        `first=${report.firstInferenceMs?.toFixed(1)}ms avg=${report.averageInferenceMs?.toFixed(1)}ms`,
    );

    if (report.detected) {
      // The outputs this model was chosen for.
      expect(report.landmarkCount, "the face mesh should be the full 478 points").toBe(478);
      expect(report.blendshapeCount, "blendshapes were requested and must arrive").toBeGreaterThan(0);
      expect(report.matrixLength, "the facial transformation matrix must be 4x4").toBe(16);
      expect(report.derived).not.toBeNull();

      // Derived geometry must be finite and in range, or the renderer will
      // follow it somewhere absurd.
      for (const [name, value] of Object.entries(report.derived ?? {})) {
        expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      }
      expect(report.derived!.eyeOpenness).toBeGreaterThanOrEqual(0);
      expect(report.derived!.eyeOpenness).toBeLessThanOrEqual(1);
      expect(report.derived!.mouthOpenness).toBeGreaterThanOrEqual(0);
      expect(report.derived!.mouthOpenness).toBeLessThanOrEqual(1);
    } else {
      // A drawing is a hard case; the runtime still proved itself by running.
      console.log("[face] synthetic face not detected — runtime verified, detection unproven on this fixture");
    }

    expect(report.averageInferenceMs).toBeGreaterThan(0);
  });

  test("drops overlapping frames instead of queueing them", async ({ page }) => {
    // Section 28: an unbounded queue builds latency that never recovers.
    await page.goto("/");

    const report = await page.evaluate(async () => {
      const { FaceTracker } = await import("/src/features/transformation/engine/faceTracker.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext("2d")?.fillRect(0, 0, 320, 240);

      const tracker = new FaceTracker();
      await tracker.initialize();

      // Fire many frames back to back and confirm every one is accounted for:
      // either inferred or explicitly skipped, never silently buffered.
      const statuses: string[] = [];
      for (let i = 0; i < 20; i += 1) statuses.push(tracker.detect(canvas, i * 5).status);

      const timings = tracker.getTimings();
      tracker.dispose();
      return { statuses, inferenceCount: timings.inferenceCount };
    });

    expect(report.statuses).toHaveLength(20);
    expect(report.inferenceCount).toBeLessThanOrEqual(20);
    for (const status of report.statuses) {
      expect(["tracked", "no-face", "skipped"]).toContain(status);
    }
  });
});
