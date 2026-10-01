import { computeFitRect } from "../coordinateMapping";
import type { FaceRenderPose } from "./faceRendererMath";

/**
 * Where the operator's NEUTRAL face sat in the camera frame, from calibration.
 * Normalised, unmirrored tracking space; the eye span is outer-corner to
 * outer-corner, the same unit every calibrated translation is measured in.
 */
export interface FaceRenderFraming {
  neutralCenter: { x: number; y: number };
  neutralEyeSpan: number;
  trackingWidth: number;
  trackingHeight: number;
}

export interface FaceWorldTransform {
  /** Unmirrored world position of the face's pivot. The scene applies any mirror. */
  x: number;
  y: number;
  /** Uniform mesh scale. */
  scale: number;
  /** One neutral eye span, in world units. */
  eyeSpanWorld: number;
}

/**
 * Glued framing: the rendered face sits where the operator's face sits in the
 * camera preview, at the size it appears there, and moves by what the camera
 * measured.
 *
 * The camera preview is `object-fit: cover` on a surface the same size as this
 * canvas, so the same `computeFitRect` places both. Calibration supplies the
 * neutral; the pose adds the calibrated movement in neutral eye spans. Without
 * a calibration (a manual pose, a test harness) the face is centred at the
 * earlier fixed size so the renderer still draws something sensible.
 *
 * World units: the orthographic camera spans 2 vertically and 2·aspect across.
 */
export function faceWorldTransform(
  pose: FaceRenderPose,
  meshEyeSpan: number,
  canvas: { width: number; height: number },
  framing: FaceRenderFraming | null,
): FaceWorldTransform {
  const width = canvas.width > 0 ? canvas.width : 1;
  const height = canvas.height > 0 ? canvas.height : 1;
  const aspect = width / height;
  const worldPerPx = 2 / height;
  const span = meshEyeSpan > 1e-4 ? meshEyeSpan : 0.27;

  let baseX = 0;
  let baseY = 0;
  let eyeSpanWorld = span * 2;
  const rect = framing && framing.neutralEyeSpan > 0
    ? computeFitRect({
        sourceWidth: framing.trackingWidth,
        sourceHeight: framing.trackingHeight,
        displayWidth: width,
        displayHeight: height,
        objectFit: "cover",
        mirrored: false,
      })
    : null;
  if (framing && rect && rect.scale > 0) {
    baseX = (rect.offsetX + framing.neutralCenter.x * rect.width) * worldPerPx - aspect;
    baseY = 1 - (rect.offsetY + framing.neutralCenter.y * rect.height) * worldPerPx;
    eyeSpanWorld = framing.neutralEyeSpan * rect.width * worldPerPx;
  }

  // Keep the pivot on screen: past the edge the face would simply vanish,
  // which reads as a failure rather than as following the operator.
  const x = Math.min(aspect, Math.max(-aspect, baseX + pose.x * eyeSpanWorld));
  const y = Math.min(1, Math.max(-1, baseY + pose.y * eyeSpanWorld));
  return { x, y, scale: (eyeSpanWorld / span) * pose.scale, eyeSpanWorld };
}

/** Outer eye-corner span of a built source mesh, in its local units. */
export function meshEyeSpan(positions: Float32Array): number {
  const [a, b] = [33 * 3, 263 * 3];
  return Math.hypot(positions[a]! - positions[b]!, positions[a + 1]! - positions[b + 1]!);
}
