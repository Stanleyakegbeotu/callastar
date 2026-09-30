import { expect, test } from "@playwright/test";

/**
 * Sign verification against REAL model output.
 *
 * The calibration spec proves the maths with synthetic geometry. This proves it
 * end to end: the actual Face Landmarker, on a real decoded image, through the
 * real collector, into the real motion helper.
 *
 * The fixture is a face drawn onto a canvas — the same one the Milestone 2
 * proof uses, which this build does detect, with 478 landmarks and a full
 * transformation matrix. Applying a known transform to that canvas and reading
 * the motion back is the closest thing to the physical check that can be done
 * without a person in front of a camera.
 *
 * It covers roll, translation and scale, all of which a 2D image can express
 * honestly. It does NOT cover yaw and pitch: a drawing cannot be turned in three
 * dimensions, and faking one by shifting features would be testing the drawing
 * rather than the pipeline. Those two remain a device check, and the milestone
 * report says so rather than implying otherwise.
 */

test("a known transform of a real tracked face produces the right deltas", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");

  const report = await page.evaluate(async () => {
    const [{ FaceTracker }, { CalibrationCollector }, { computeRelativeMotion }] = await Promise.all([
      import("/src/features/transformation/engine/faceTracker.ts"),
      import("/src/features/transformation/engine/calibrationCollector.ts"),
      import("/src/features/transformation/engine/relativeMotion.ts"),
    ]);

    const WIDTH = 640;
    const HEIGHT = 480;
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");

    interface Transform {
      dx?: number;
      dy?: number;
      scale?: number;
      rotation?: number;
    }

    /** The Milestone 2 fixture, under a transform of the caller's choosing. */
    const draw = (transform: Transform) => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#c8c8c8";
      context.fillRect(0, 0, WIDTH, HEIGHT);

      context.save();
      context.translate(320 + (transform.dx ?? 0), 240 + (transform.dy ?? 0));
      context.rotate(transform.rotation ?? 0);
      context.scale(transform.scale ?? 1, transform.scale ?? 1);
      context.translate(-320, -240);

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

      context.fillStyle = "#3b2c22";
      context.beginPath();
      context.ellipse(280, 205, 9, 9, 0, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(360, 205, 9, 9, 0, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = "#8a6a52";
      context.lineWidth = 6;
      context.beginPath();
      context.moveTo(320, 215);
      context.lineTo(320, 262);
      context.stroke();

      context.beginPath();
      context.moveTo(288, 300);
      context.quadraticCurveTo(320, 320, 352, 300);
      context.stroke();
      context.restore();
    };

    const tracker = new FaceTracker();
    await tracker.initialize();

    let stamp = 0;

    /** Runs a few frames of one pose and returns the last result. */
    const settle = (transform: Transform, frames = 3) => {
      let last: ReturnType<typeof tracker.detect> | null = null;
      for (let index = 0; index < frames; index += 1) {
        draw(transform);
        stamp += 40;
        last = tracker.detect(canvas, stamp);
      }
      return last;
    };

    // Calibrate from the untransformed fixture. A drawing has no shoulders, so
    // this also exercises the face-only path with real tracker output.
    const collector = new CalibrationCollector();
    collector.start(
      "face-only",
      { cameraFacing: "user", trackingWidth: WIDTH, trackingHeight: HEIGHT, mirrored: false },
      0,
    );

    let collectorNow = 0;
    for (let index = 0; index < 30 && collector.getState().phase !== "ready"; index += 1) {
      draw({});
      stamp += 40;
      const result = tracker.detect(canvas, stamp);
      collectorNow += 120;
      collector.accept(result, null, collectorNow);
    }

    const state = collector.getState();
    const profile = state.profile;
    if (!profile) {
      tracker.dispose();
      return {
        calibrated: false as const,
        phase: state.phase,
        rejections: state.rejectionCounts,
      };
    }

    const degrees = (radians: number) => (radians * 180) / Math.PI;
    const measure = (transform: Transform) => {
      const result = settle(transform);
      const motion = computeRelativeMotion(profile, result, null);
      return motion.head
        ? {
            yaw: degrees(motion.head.yawDelta),
            pitch: degrees(motion.head.pitchDelta),
            roll: degrees(motion.head.rollDelta),
            scale: motion.head.scaleDelta,
            x: motion.head.translationX,
            y: motion.head.translationY,
          }
        : null;
    };

    const readings = {
      still: measure({}),
      right: measure({ dx: 60 }),
      left: measure({ dx: -60 }),
      down: measure({ dy: 60 }),
      up: measure({ dy: -60 }),
      closer: measure({ scale: 1.25 }),
      further: measure({ scale: 0.8 }),
      rollPositive: measure({ rotation: (15 * Math.PI) / 180 }),
      rollNegative: measure({ rotation: (-15 * Math.PI) / 180 }),
    };

    tracker.dispose();
    return {
      calibrated: true as const,
      quality: profile.quality.quality,
      frameCount: profile.quality.frameCount,
      neutralRoll: degrees(profile.face.roll),
      readings,
    };
  });

  expect(report.calibrated, `calibration did not complete: ${JSON.stringify(report)}`).toBe(true);
  if (!report.calibrated) return;

  const readings = report.readings;
  console.log(`[calibration] real-tracker motion readings\n${JSON.stringify(readings, null, 2)}`);

  // Face-only, because a drawing has no shoulders.
  expect(report.quality).toBe("limited");

  // The calibrated pose reads as no movement at all — not as its raw angles.
  expect(Math.abs(readings.still!.roll)).toBeLessThan(1);
  expect(Math.abs(readings.still!.x)).toBeLessThan(0.05);
  expect(readings.still!.scale).toBeCloseTo(1, 1);

  // Translation: right is positive, left is negative, and the axes stay apart.
  expect(readings.right!.x).toBeGreaterThan(0.2);
  expect(readings.left!.x).toBeLessThan(-0.2);
  expect(Math.abs(readings.right!.y), "moving sideways is not moving down").toBeLessThan(0.15);

  expect(readings.down!.y).toBeGreaterThan(0.2);
  expect(readings.up!.y).toBeLessThan(-0.2);
  expect(Math.abs(readings.down!.x), "moving down is not moving sideways").toBeLessThan(0.15);

  // Scale is a ratio either side of one, tracking the applied factor.
  expect(readings.closer!.scale).toBeGreaterThan(1.15);
  expect(readings.further!.scale).toBeLessThan(0.9);

  /*
   * Roll: the one rotation a 2D image can genuinely express.
   *
   * Fifteen degrees of in-plane rotation must come back as about fifteen
   * degrees of ROLL — not of yaw or pitch. This is the Milestone 2 failure
   * reproduced deliberately: an axis mix-up anywhere between the model and this
   * line would show up as the rotation landing on the wrong one.
   */
  expect(Math.abs(readings.rollPositive!.roll)).toBeGreaterThan(10);
  expect(Math.abs(readings.rollPositive!.roll)).toBeLessThan(20);
  expect(Math.abs(readings.rollPositive!.yaw), "a tilt is not a turn").toBeLessThan(6);
  expect(Math.abs(readings.rollPositive!.pitch), "a tilt is not a nod").toBeLessThan(6);

  /*
   * And the direction is the one `faceTypes` documents.
   *
   * Rotating the image clockwise moves the top of the head towards the RIGHT of
   * the frame. Unmirrored, the right of the frame is the subject's LEFT — so
   * that is a tilt towards their left ear, and positive roll is defined as a
   * tilt towards their RIGHT. Negative is correct, and the opposite rotation
   * must come back the other way.
   */
  expect(readings.rollPositive!.roll).toBeLessThan(0);
  expect(readings.rollNegative!.roll).toBeGreaterThan(0);
});
