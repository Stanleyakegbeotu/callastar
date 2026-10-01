import type { Page } from "@playwright/test";

/**
 * A camera with a real face in it.
 *
 * Chrome's fake device shows a rolling pattern, so nothing past "no face found"
 * could be exercised through the Studio UI. This replaces `getUserMedia` for
 * video with a `canvas.captureStream()` of a real photograph that MediaPipe
 * genuinely detects, drawn every frame under a transform the test drives:
 *
 *   window.__faceCamera.set({ dx, dy, scale, rollDeg })
 *
 * `dx`/`dy` are fractions of the frame, `scale` multiplies the photograph about
 * the frame centre, and `rollDeg` rotates it clockwise AS SEEN in the frame.
 * Yaw and pitch cannot be produced by moving a flat photograph and are not
 * offered: a test that pretended otherwise would prove nothing.
 *
 * `calls` counts video requests, so a test can assert no second stream opened.
 */
/**
 * The test portrait's own head rests at about -14° of roll (measured: source
 * analysis and live tracking agree). Counter-rotated by default, so the operator
 * this camera plays starts LEVEL, as a calibrating person is asked to.
 */
export const LEVEL_PORTRAIT_ROLL_DEG = -14;

export async function installFaceCamera(page: Page, imageUrl = "/media/onboarding/male-participant.jpg"): Promise<void> {
  await page.addInitScript(({ url, level }: { url: string; level: number }) => {
    const transform = { dx: 0, dy: 0, scale: 1, rollDeg: level };
    const camera = {
      calls: 0,
      transform,
      set(next: Partial<typeof transform>) {
        Object.assign(transform, next);
      },
    };
    (window as unknown as { __faceCamera: typeof camera }).__faceCamera = camera;

    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) return;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints?.video) return original(constraints);
      camera.calls += 1;
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 640;
      const context = canvas.getContext("2d")!;
      const draw = () => {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = "#8a8f96";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.translate(canvas.width * (0.5 + transform.dx), canvas.height * (0.5 + transform.dy));
        context.rotate((transform.rollDeg * Math.PI) / 180);
        context.scale(transform.scale, transform.scale);
        context.drawImage(image, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
      };
      draw();
      // An interval, not rAF: a frame loop the test does not own must keep
      // painting while Playwright holds the page between actions.
      const timer = window.setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0]!;
      const stop = track.stop.bind(track);
      track.stop = () => {
        window.clearInterval(timer);
        stop();
      };
      return stream;
    };
  }, { url: imageUrl, level: LEVEL_PORTRAIT_ROLL_DEG });
}
