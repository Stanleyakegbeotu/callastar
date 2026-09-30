import { expect, test } from "@playwright/test";

/**
 * The Pose Landmarker, against the real official model.
 *
 * As with the face milestone, the fixture is drawn rather than photographed:
 * it keeps a picture of a person out of the repository and it is deterministic.
 * A drawn figure is a hard case for a pose model, so the assertions separate
 * "the runtime works" from "this drawing was recognised" — a negative detection
 * here is not evidence the model is broken.
 */

/**
 * Draws a plain upper-body figure with roughly human proportions.
 *
 * Shared by both tests so the fixture is defined once, and inlined into the
 * page rather than imported because it runs inside `page.evaluate`.
 */
const DRAW_FIGURE = `
(canvas) => {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  const w = canvas.width;
  const h = canvas.height;

  context.fillStyle = "#dfe6ee";
  context.fillRect(0, 0, w, h);

  // Torso: shoulders noticeably wider than the waist.
  context.fillStyle = "#2f4f7f";
  context.beginPath();
  context.moveTo(w * 0.30, h * 0.52);
  context.lineTo(w * 0.70, h * 0.52);
  context.lineTo(w * 0.64, h * 1.0);
  context.lineTo(w * 0.36, h * 1.0);
  context.closePath();
  context.fill();

  // Neck.
  context.fillStyle = "#e0b89a";
  context.fillRect(w * 0.46, h * 0.40, w * 0.08, h * 0.14);

  // Head.
  context.beginPath();
  context.ellipse(w * 0.5, h * 0.28, w * 0.11, h * 0.15, 0, 0, Math.PI * 2);
  context.fill();

  // Eyes and mouth, which help the detector find a head at all.
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.ellipse(w * 0.455, h * 0.26, w * 0.028, h * 0.018, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(w * 0.545, h * 0.26, w * 0.028, h * 0.018, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#3a2a1a";
  context.beginPath();
  context.ellipse(w * 0.455, h * 0.26, w * 0.011, h * 0.011, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(w * 0.545, h * 0.26, w * 0.011, h * 0.011, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#8a5a4a";
  context.lineWidth = Math.max(2, w * 0.008);
  context.beginPath();
  context.moveTo(w * 0.47, h * 0.335);
  context.quadraticCurveTo(w * 0.5, h * 0.352, w * 0.53, h * 0.335);
  context.stroke();

  // Upper arms, angled away from the body.
  context.strokeStyle = "#e0b89a";
  context.lineWidth = Math.max(8, w * 0.045);
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(w * 0.32, h * 0.56);
  context.lineTo(w * 0.22, h * 0.80);
  context.stroke();
  context.beginPath();
  context.moveTo(w * 0.68, h * 0.56);
  context.lineTo(w * 0.78, h * 0.80);
  context.stroke();
}
`;

test.describe("Pose Landmarker runtime", () => {
  test("loads the official model and runs inference on a real frame", async ({ page }) => {
    await page.goto("/");

    const report = await page.evaluate(async (drawSource) => {
      const { PoseTracker } = await import("/src/features/transformation/engine/poseTracker.ts");

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      // eslint-disable-next-line no-eval -- the fixture is defined in this file.
      (eval(drawSource) as (target: HTMLCanvasElement) => void)(canvas);

      const tracker = new PoseTracker({ outputSegmentationMasks: true });

      const initStart = performance.now();
      await tracker.initialize();
      const initMs = performance.now() - initStart;

      let last: ReturnType<typeof tracker.detect> | null = null;
      for (let i = 0; i < 10; i += 1) last = tracker.detect(canvas, i * 33);

      const timings = tracker.getTimings();
      tracker.dispose();

      return {
        initMs,
        ready: true,
        disposedReady: tracker.ready,
        status: last?.status ?? "none",
        detected: last?.detected ?? false,
        landmarkCount: last?.landmarks.length ?? 0,
        worldLandmarkCount: last?.worldLandmarks.length ?? 0,
        segmentation: last?.segmentation ?? null,
        derived: last?.derived
          ? {
              trackability: last.derived.trackability,
              shoulderWidth: last.derived.shoulderWidth,
              shoulderAngle: last.derived.shoulderAngle,
              hasLeftShoulder: last.derived.leftShoulder !== null,
              hasRightShoulder: last.derived.rightShoulder !== null,
              hasTorso: last.derived.torsoCenter !== null,
              torsoLean: last.derived.torsoLean,
              visibility: last.derived.visibility,
            }
          : null,
        firstInferenceMs: timings.firstInferenceMs,
        averageInferenceMs: timings.averageInferenceMs,
        inferenceCount: timings.inferenceCount,
      };
    }, DRAW_FIGURE);

    expect(report.inferenceCount).toBe(10);
    expect(report.status, "the runtime must produce a real result, not a skip").not.toBe("skipped");
    expect(report.disposedReady, "dispose() must release the task").toBe(false);

    console.log(
      `[pose] status=${report.status} landmarks=${report.landmarkCount} ` +
        `world=${report.worldLandmarkCount} ` +
        `mask=${report.segmentation?.available}/${report.segmentation?.width}x${report.segmentation?.height}/${report.segmentation?.representation} ` +
        `init=${report.initMs.toFixed(0)}ms first=${report.firstInferenceMs?.toFixed(1)}ms avg=${report.averageInferenceMs?.toFixed(1)}ms`,
    );

    if (report.detected) {
      console.log(
        `[pose] trackability=${report.derived?.trackability} ` +
          `shoulderWidth=${report.derived?.shoulderWidth.toFixed(4)} ` +
          `shoulderAngle=${report.derived?.shoulderAngle.toFixed(4)} ` +
          `torso=${report.derived?.hasTorso} visibility=${report.derived?.visibility?.toFixed(2)}`,
      );

      expect(report.landmarkCount, "the pose topology is 33 points").toBe(33);
      expect(report.derived).not.toBeNull();

      // Every derived value must be finite, or the renderer follows it somewhere
      // absurd.
      expect(Number.isFinite(report.derived!.shoulderWidth)).toBe(true);
      expect(Number.isFinite(report.derived!.shoulderAngle)).toBe(true);
      if (report.derived!.torsoLean !== null) {
        expect(Number.isFinite(report.derived!.torsoLean)).toBe(true);
      }
      expect(["tracked", "partial", "lost"]).toContain(report.derived!.trackability);
    } else {
      console.log("[pose] drawn figure not detected — runtime verified, detection unproven on this fixture");
    }

    expect(report.averageInferenceMs).toBeGreaterThan(0);
  });

  test("reports the combined face and pose cost on one frame", async ({ page }) => {
    /*
     * Informational only (§19).
     *
     * Both models on the same frame, to see what running them together costs
     * before Milestone 4 decides how to schedule them. Under SwiftShader these
     * numbers say nothing about a phone — they are recorded so the ratio between
     * the two is visible, not as a budget.
     */
    await page.goto("/");

    const report = await page.evaluate(async (drawSource) => {
      const [{ FaceTracker }, { PoseTracker }, { MonotonicClock }] = await Promise.all([
        import("/src/features/transformation/engine/faceTracker.ts"),
        import("/src/features/transformation/engine/poseTracker.ts"),
        import("/src/features/transformation/engine/monotonicClock.ts"),
      ]);

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      // eslint-disable-next-line no-eval -- the fixture is defined in this file.
      (eval(drawSource) as (target: HTMLCanvasElement) => void)(canvas);

      // One clock, as the real loop will use.
      const clock = new MonotonicClock();
      const face = new FaceTracker({}, clock);
      const pose = new PoseTracker({ outputSegmentationMasks: false }, clock);

      const bothInitStart = performance.now();
      await Promise.all([face.initialize(), pose.initialize()]);
      const bothInitMs = performance.now() - bothInitStart;

      const combined: number[] = [];
      let faceDetected = false;
      let poseDetected = false;

      for (let i = 0; i < 10; i += 1) {
        const started = performance.now();
        const timestamp = i * 33;
        const faceResult = face.detect(canvas, timestamp);
        const poseResult = pose.detect(canvas, timestamp);
        combined.push(performance.now() - started);
        faceDetected ||= faceResult.detected;
        poseDetected ||= poseResult.detected;
      }

      const faceTimings = face.getTimings();
      const poseTimings = pose.getTimings();
      face.dispose();
      pose.dispose();

      // Exclude the first, which carries both models' warm-up.
      const steady = combined.slice(1);
      const averageCombined = steady.reduce((sum, value) => sum + value, 0) / steady.length;

      return {
        bothInitMs,
        averageCombined,
        faceAvg: faceTimings.averageInferenceMs,
        poseAvg: poseTimings.averageInferenceMs,
        faceDetected,
        poseDetected,
      };
    }, DRAW_FIGURE);

    console.log(
      `[combined] both models init=${report.bothInitMs.toFixed(0)}ms · ` +
        `per-frame face+pose=${report.averageCombined.toFixed(1)}ms ` +
        `(face ${report.faceAvg?.toFixed(1)}ms + pose ${report.poseAvg?.toFixed(1)}ms) · ` +
        `faceDetected=${report.faceDetected} poseDetected=${report.poseDetected}`,
    );

    // Both ran; the numbers themselves are informational.
    expect(report.faceAvg).toBeGreaterThan(0);
    expect(report.poseAvg).toBeGreaterThan(0);
    expect(report.averageCombined).toBeGreaterThan(0);
  });
});
