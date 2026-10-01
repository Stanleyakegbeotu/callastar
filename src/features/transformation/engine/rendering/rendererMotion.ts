import type { CalibrationMotion } from "../relativeMotion";
import { rigidMotionFromCalibration } from "../rigidFaceMotion";

/**
 * THE coordinate and sign contract between tracking and the renderer.
 *
 * Every sign inversion between a tracked head and a rendered face lives here
 * and nowhere else. Before this file existed, one negation sat inside
 * `FaceRenderer.renderFrame` (`rotation.set(pitch, -yaw, roll)`) and the rest
 * were implicit, which is how a real device ended up turning the wrong way on
 * two axes at once with nothing obviously wrong in any single line.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE FOUR FRAMES
 * ────────────────────────────────────────────────────────────────────────
 *
 * 1. MEDIAPIPE TRACKING — normalised image space. x grows RIGHT across the
 *    image, y grows DOWN, and landmark z is smaller the CLOSER a point is to
 *    the camera. Head angles: positive yaw is the head turning towards the
 *    subject's own LEFT, positive pitch is looking DOWN, positive roll is a
 *    tilt towards the subject's own RIGHT ear. Yaw and roll were measured in
 *    Milestone 5; pitch was not, and was assumed backwards until M8.3's
 *    round trip measured it (see `rigidFaceMotion.ts`).
 *
 * 2. CALIBRATION MOTION — the same conventions, expressed as deltas from the
 *    operator's neutral pose. `relativeMotion.ts` changes no signs.
 *
 * 2b. RIGID FACE MOTION — `rigidFaceMotion.ts` converts (2) into PHYSICAL
 *    terms: pitch positive looking UP, y positive UP. That conversion and the
 *    one below are the only sign decisions in the pipeline.
 *
 * 3. THREE.JS WORLD — right-handed. x grows RIGHT, y grows UP, and z grows
 *    TOWARDS THE VIEWER (the camera sits at +z looking down −z). Positive
 *    rotation about an axis is counter-clockwise looking back down that axis.
 *
 * 4. THE SCREEN — what the operator sees. In the Studio this is a SELF-VIEW,
 *    mirrored like the camera preview beside it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY EACH SIGN IS WHAT IT IS
 * ────────────────────────────────────────────────────────────────────────
 *
 * The governing asymmetry: tracking angles are in the SUBJECT'S frame, while
 * Three.js rotations are read from the VIEWER'S side. Facing someone, their
 * right hand is on your left. So a subject-frame direction and a viewer-frame
 * direction are mirror images, and the conversion is not optional.
 *
 * YAW → rotation.y, NOT negated.
 *   The mesh faces the viewer, so its forward axis is +z. A positive rotation
 *   about +y carries +z towards +x, swinging the nose to the viewer's RIGHT.
 *   A physical turn towards the subject's right gives a NEGATIVE yaw, and the
 *   subject's right is the viewer's LEFT — which is where a negative
 *   rotation.y puts the nose. The signs already agree; negating here was the
 *   bug.
 *
 * PITCH → rotation.x, NEGATED from PHYSICAL pitch.
 *   Physical pitch (`RigidFaceMotion`) is positive looking UP. A positive Three
 *   rotation about +x carries +z towards −y, pitching the nose DOWN. So the
 *   physical value is negated here — which, because MediaPipe's own pitch is
 *   positive DOWN, means MediaPipe pitch reaches rotation.x with its sign
 *   intact. The earlier code negated MediaPipe pitch directly, believing it
 *   positive-up, and rendered every nod backwards.
 *
 * ROLL → rotation.z, NOT negated.
 *   Positive roll is a tilt towards the subject's right ear. The top of the
 *   head is +y; the subject's right is the viewer's left, −x. A positive
 *   rotation about +z carries +y towards −x. They agree.
 *
 * TRANSLATION X → world x, NOT negated.
 *   Tracking x grows right across the IMAGE, and an unmirrored image puts the
 *   subject's right on the viewer's left. So the sign already describes where
 *   the face should appear.
 *
 * TRANSLATION Y → world y, NOT negated from physical y.
 *   Tracking y grows down; `rigidFaceMotion.ts` makes it physical (up) once.
 *
 * ────────────────────────────────────────────────────────────────────────
 * MIRRORING IS NOT DONE HERE
 * ────────────────────────────────────────────────────────────────────────
 *
 * This produces motion in the UNMIRRORED frame — a faithful view of the
 * person, which is what a caller must eventually receive.
 *
 * The Studio self-view mirrors that at the DISPLAY boundary, exactly as the
 * camera preview does, so an operator turning right sees the rendered face turn
 * right. Baking the mirror into these signs instead would make the motion lie
 * about which way somebody turned, and would have to be undone before the
 * output could ever reach a call. `mirrorMode` below is what a surface passes
 * to say which it wants.
 */

export interface RendererMotion {
  /** World-space offset, in source face widths. */
  x: number;
  y: number;
  /** Ratio against the source's neutral size. */
  scale: number;
  /** Three.js Euler angles, radians, applied in XYZ order. */
  rotationX: number;
  rotationY: number;
  rotationZ: number;
}

export const NEUTRAL_RENDERER_MOTION: RendererMotion = {
  x: 0,
  y: 0,
  scale: 1,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Tracked head movement, in Three.js terms.
 *
 * The ONLY place tracking signs become renderer signs. Nothing downstream may
 * negate an axis; if a direction is wrong, it is wrong here.
 */
export function rendererMotionFromTracking(motion: CalibrationMotion | null | undefined): RendererMotion {
  if (!motion?.head) return NEUTRAL_RENDERER_MOTION;
  const rigid = rigidMotionFromCalibration(motion.head);
  return rendererMotionFromPose({
    x: rigid.translationX, y: rigid.translationY, scale: rigid.scale,
    yaw: rigid.yaw, pitch: rigid.pitch, roll: rigid.roll,
  });
}

/**
 * Whether a rendering surface shows a mirrored self-view.
 *
 * `selfie` is the Studio: the operator is looking at themselves, and a mirror
 * is what makes turning right look like turning right. `faithful` is what a
 * caller must see, and what any future WebRTC sender must use.
 */
export type RenderMirrorMode = "selfie" | "faithful";

/**
 * The horizontal scale a surface applies to mirror its output.
 *
 * Applied to the scene, not to the motion — so the same tracked movement can
 * feed a mirrored self-view and a faithful outgoing frame at the same time
 * without either being recomputed.
 */
export function mirrorScaleX(mode: RenderMirrorMode): number {
  return mode === "selfie" ? -1 : 1;
}

/**
 * The same mapping, for an already clamped and smoothed pose.
 *
 * `faceRendererMath` clamps and smooths in TRACKING semantics, because the
 * source movement envelope is expressed that way. The conversion to renderer
 * semantics therefore happens after smoothing — but through this function, so
 * there is still exactly one place where a sign changes.
 */
export function rendererMotionFromPose(pose: {
  x: number;
  y: number;
  scale: number;
  yaw: number;
  pitch: number;
  roll: number;
}): RendererMotion {
  return {
    x: finite(pose.x, 0),
    // `faceRendererMath` has already flipped tracking y into world y.
    y: finite(pose.y, 0),
    scale: finite(pose.scale, 1),
    rotationX: -finite(pose.pitch, 0),
    rotationY: finite(pose.yaw, 0),
    rotationZ: finite(pose.roll, 0),
  };
}

/**
 * Where the face is pointing, in world space, for a given motion.
 *
 * Exists so a test can ask the product question — "does a physical right turn
 * send the nose to the viewer's right?" — instead of checking that a number
 * survived a function unchanged. The nose is the mesh's local +z and the top of
 * the head its local +y; rotating those by the same Euler the renderer applies
 * gives two vectors whose signs ARE the visible behaviour.
 *
 * Deliberately duplicates no maths: it composes the rotation in the same XYZ
 * order Three.js uses, which is the thing under test.
 */
export function faceDirectionVectors(motion: RendererMotion): {
  nose: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
} {
  const { rotationX: rx, rotationY: ry, rotationZ: rz } = motion;
  const [sx, cx] = [Math.sin(rx), Math.cos(rx)];
  const [sy, cy] = [Math.sin(ry), Math.cos(ry)];
  const [sz, cz] = [Math.sin(rz), Math.cos(rz)];

  // Three.js Euler "XYZ" builds R = Rx * Ry * Rz, applied to a column vector.
  const m = [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
  ];

  const apply = (x: number, y: number, z: number) => ({
    x: m[0]! * x + m[1]! * y + m[2]! * z,
    y: m[3]! * x + m[4]! * y + m[5]! * z,
    z: m[6]! * x + m[7]! * y + m[8]! * z,
  });

  return { nose: apply(0, 0, 1), up: apply(0, 1, 0) };
}

/**
 * The direction vectors as the operator SEES them on a given surface.
 *
 * A selfie surface is mirrored, so x flips once here — the same single flip the
 * camera preview applies, and the reason turning right looks like turning right.
 */
export function visibleFaceDirection(motion: RendererMotion, mode: RenderMirrorMode) {
  const vectors = faceDirectionVectors(motion);
  const flip = mirrorScaleX(mode);
  return {
    nose: { ...vectors.nose, x: vectors.nose.x * flip },
    up: { ...vectors.up, x: vectors.up.x * flip },
  };
}
