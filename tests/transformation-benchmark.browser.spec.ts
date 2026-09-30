import { expect, test } from "@playwright/test";

/**
 * What the tracking pipeline costs, on whatever graphics stack this browser
 * actually chose.
 *
 * The engine proofs run under a forced software rasteriser so they are
 * reproducible anywhere. That makes their timings useless as a baseline, which
 * is what this file is for — and why the first thing it does is read the
 * renderer string and print it beside every number. A timing without the
 * renderer that produced it is not a measurement, and quoting a SwiftShader
 * figure as a device baseline would be worse than quoting nothing.
 *
 * This asserts almost nothing on purpose. A performance threshold on a shared
 * machine is a flaky test that eventually gets deleted; the value here is the
 * printed report, read by a person deciding what a phone can carry.
 */

interface Measurement {
  trackingSize: number;
  frames: number;
  faceMeanMs: number | null;
  faceFirstMs: number | null;
  poseMeanMs: number | null;
  poseFirstMs: number | null;
  combinedMeanMs: number;
  combinedP95Ms: number;
}

interface Report {
  renderer: string;
  vendor: string;
  webgl2: boolean;
  hardwareAccelerated: boolean;
  faceInitMs: number | null;
  poseInitMs: number | null;
  cameraWidth: number;
  cameraHeight: number;
  measurements: Measurement[];
}

const TRACKING_SIZES = [320, 480, 640];
const FRAMES_PER_SIZE = 40;

test("measures the tracking pipeline and names the renderer that produced the numbers", async ({ page }) => {
  await page.goto("/");

  const report: Report = await page.evaluate(
    async ({ sizes, frames }) => {
      /** What the browser is actually rendering with. */
      const describeRenderer = () => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (!gl) return { renderer: "none", vendor: "none", webgl2: false };

        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = info
          ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER));
        const vendor = info
          ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL))
          : String(gl.getParameter(gl.VENDOR));

        return { renderer, vendor, webgl2: canvas.getContext("webgl2") !== null };
      };

      const { renderer, vendor, webgl2 } = describeRenderer();
      // SwiftShader and llvmpipe both name themselves. Anything else is the
      // machine's own graphics stack.
      const software = /swiftshader|llvmpipe|softwarerasterizer|software/i.test(renderer);

      const [{ FaceTracker }, { PoseTracker }, { MonotonicClock }, { computeTrackingSize }] = await Promise.all([
        import("/src/features/transformation/engine/faceTracker.ts"),
        import("/src/features/transformation/engine/poseTracker.ts"),
        import("/src/features/transformation/engine/monotonicClock.ts"),
        import("/src/features/transformation/engine/coordinateMapping.ts"),
      ]);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise<void>((resolve) => {
        if (video.videoWidth > 0) return resolve();
        video.onloadedmetadata = () => resolve();
      });

      const clock = new MonotonicClock();
      const face = new FaceTracker({ delegate: webgl2 ? "GPU" : "CPU" }, clock);
      const pose = new PoseTracker({ delegate: webgl2 ? "GPU" : "CPU" }, clock);

      await face.initialize();
      await pose.initialize();

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");

      const measurements = [];

      for (const trackingSize of sizes) {
        const size = computeTrackingSize(video.videoWidth, video.videoHeight, trackingSize);
        canvas.width = size.width;
        canvas.height = size.height;

        const combined: number[] = [];

        // A few frames before recording: the first inference after a resize is
        // slower than steady state and would skew a mean of forty.
        for (let warmup = 0; warmup < 5; warmup += 1) {
          context.drawImage(video, 0, 0, size.width, size.height);
          face.detect(canvas, performance.now());
          pose.detect(canvas, performance.now());
        }

        for (let frame = 0; frame < frames; frame += 1) {
          context.drawImage(video, 0, 0, size.width, size.height);
          const started = performance.now();
          face.detect(canvas, performance.now());
          pose.detect(canvas, performance.now());
          combined.push(performance.now() - started);
          // Yield, so this measures inference rather than a blocked main thread.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const sorted = [...combined].sort((a, b) => a - b);
        measurements.push({
          trackingSize: Math.max(size.width, size.height),
          frames: combined.length,
          faceMeanMs: face.getTimings().averageInferenceMs,
          faceFirstMs: face.getTimings().firstInferenceMs,
          poseMeanMs: pose.getTimings().averageInferenceMs,
          poseFirstMs: pose.getTimings().firstInferenceMs,
          combinedMeanMs: combined.reduce((sum, value) => sum + value, 0) / combined.length,
          combinedP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
        });
      }

      const result = {
        renderer,
        vendor,
        webgl2,
        hardwareAccelerated: !software && renderer !== "none",
        faceInitMs: face.getTimings().initMs,
        poseInitMs: pose.getTimings().initMs,
        cameraWidth: video.videoWidth,
        cameraHeight: video.videoHeight,
        measurements,
      };

      face.dispose();
      pose.dispose();
      for (const track of stream.getTracks()) track.stop();

      return result;
    },
    { sizes: TRACKING_SIZES, frames: FRAMES_PER_SIZE },
  );

  const heading = report.hardwareAccelerated
    ? `HARDWARE — ${report.renderer}`
    : `SOFTWARE RASTERISER — ${report.renderer} · these are NOT device baselines`;

  const lines = [
    "",
    "──────── Transformation tracking benchmark ────────",
    heading,
    `vendor: ${report.vendor} · webgl2: ${report.webgl2}`,
    `camera: ${report.cameraWidth}×${report.cameraHeight}`,
    `model init: face ${report.faceInitMs?.toFixed(0) ?? "?"}ms · pose ${report.poseInitMs?.toFixed(0) ?? "?"}ms`,
    "",
    "tracking   face      pose      face+pose   p95",
  ];

  for (const measurement of report.measurements) {
    lines.push(
      [
        `${String(measurement.trackingSize).padEnd(10)}`,
        `${(measurement.faceMeanMs?.toFixed(1) ?? "—").padEnd(9)}`,
        `${(measurement.poseMeanMs?.toFixed(1) ?? "—").padEnd(9)}`,
        `${measurement.combinedMeanMs.toFixed(1).padEnd(11)}`,
        `${measurement.combinedP95Ms.toFixed(1)}`,
      ].join(""),
    );
  }

  lines.push("", `(mean of ${FRAMES_PER_SIZE} frames per size, after 5 warm-up frames, in ms)`, "");
  console.log(lines.join("\n"));

  // The only assertions worth making: the pipeline ran, and every number is
  // real. A threshold here would be a flaky test on a shared machine.
  expect(report.measurements).toHaveLength(TRACKING_SIZES.length);
  for (const measurement of report.measurements) {
    expect(measurement.frames).toBe(FRAMES_PER_SIZE);
    expect(Number.isFinite(measurement.combinedMeanMs)).toBe(true);
    expect(measurement.combinedMeanMs).toBeGreaterThan(0);
  }
});

/**
 * What preparing a source costs.
 *
 * Same rule as the tracking benchmark above: the renderer string is printed
 * beside every number, because a timing measured under a software rasteriser
 * describes the machine rather than the pipeline.
 *
 * Source analysis is finite rather than real-time, so seconds are acceptable —
 * but a ten-second clip must not take a minute, and that is what this measures.
 */
test("measures source analysis on whatever graphics stack this browser chose", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");

  const report = await page.evaluate(async () => {
    const describeRenderer = () => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return "none";
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    };

    const renderer = describeRenderer();
    const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");

    // The same fictional drawn face the source proofs use.
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#c8c8c8";
    context.fillRect(0, 0, 640, 480);
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

    const imageBlob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));

    const imageAnalyzer = new SourceAnalyzer();
    const imageResult = await imageAnalyzer.analyze({
      asset: { kind: "image", mimeType: "image/png", fileName: "bench.png", blob: imageBlob, assetId: null },
      profileId: "bench",
    });
    const imageTimings = imageAnalyzer.getTimings();

    const videoBlob = await (await fetch("/media/call-demo.mp4")).blob();
    const videoAnalyzer = new SourceAnalyzer();
    const videoResult = await videoAnalyzer.analyze({
      asset: { kind: "video", mimeType: "video/mp4", fileName: "bench.mp4", blob: videoBlob, assetId: null },
      profileId: "bench",
    });
    const videoTimings = videoAnalyzer.getTimings();

    return {
      renderer,
      software: /swiftshader|llvmpipe|softwarerasterizer|software/i.test(renderer),
      imageOk: imageResult.ok,
      imageTimings,
      videoOk: videoResult.ok,
      videoTimings,
      videoDuration: videoResult.ok ? videoResult.profile.durationSeconds : null,
      videoAngles: videoResult.ok ? videoResult.profile.referenceFrames.length : 0,
    };
  });

  const heading = report.software
    ? `SOFTWARE RASTERISER — ${report.renderer} · NOT device baselines`
    : `HARDWARE — ${report.renderer}`;

  console.log(
    [
      "",
      "──────── Source analysis benchmark ────────",
      heading,
      "",
      "IMAGE (640x480 synthetic face)",
      `  decode          ${report.imageTimings.decodeMs?.toFixed(0) ?? "?"} ms`,
      `  model init      ${report.imageTimings.modelInitMs?.toFixed(0) ?? "?"} ms`,
      `  face analysis   ${report.imageTimings.faceMs?.toFixed(0) ?? "?"} ms`,
      `  pose analysis   ${report.imageTimings.poseMs?.toFixed(0) ?? "?"} ms`,
      `  total           ${report.imageTimings.totalMs?.toFixed(0) ?? "?"} ms`,
      "",
      `VIDEO (${report.videoDuration?.toFixed(1) ?? "?"}s clip)`,
      `  metadata load   ${report.videoTimings.decodeMs?.toFixed(0) ?? "?"} ms`,
      `  model init      ${report.videoTimings.modelInitMs?.toFixed(0) ?? "?"} ms`,
      `  frames analysed ${report.videoTimings.framesAnalyzed}`,
      `  per frame       ${report.videoTimings.perFrameMs?.toFixed(0) ?? "?"} ms`,
      `  total           ${report.videoTimings.totalMs?.toFixed(0) ?? "?"} ms`,
      `  reference bank  ${report.videoAngles} angles`,
      "",
    ].join(String.fromCharCode(10)),
  );

  // Only that the work happened and every number is real. A threshold here
  // would be a flaky test on a shared machine.
  expect(report.imageOk).toBe(true);
  expect(report.imageTimings.totalMs).toBeGreaterThan(0);
  expect(report.videoTimings.framesAnalyzed).toBeGreaterThan(0);
  expect(report.videoTimings.framesAnalyzed).toBeLessThanOrEqual(20);
});
