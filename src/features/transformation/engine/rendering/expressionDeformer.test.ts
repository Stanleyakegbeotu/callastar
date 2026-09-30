import { describe, expect, it } from "vitest";
import { clampExpression, deriveExpressionEnvelope, deriveSourceExpression, NEUTRAL_EXPRESSION, smoothExpression } from "../expressionMotion";
import { ExpressionDeformer } from "./expressionDeformer";
import { FACE_RENDER_VERTEX_INDICES, buildSourceFaceMesh } from "./sourceMesh";

function fixture() {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (id: number, x: number, y: number) => { landmarks[id] = { x, y, z: 0 }; };
  const ring = FACE_RENDER_VERTEX_INDICES.slice(1);
  ring.forEach((id, i) => {
    const angle = -Math.PI / 2 - i / ring.length * Math.PI * 2;
    set(id, 0.5 + Math.cos(angle) * 0.22, 0.5 + Math.sin(angle) * 0.30);
  });
  set(1, 0.5, 0.5); set(234, 0.28, 0.5); set(454, 0.72, 0.5);
  set(33, .375, .43); set(133, .465, .43); set(159, .42, .416); set(145, .42, .445);
  set(263, .625, .43); set(362, .535, .43); set(386, .58, .416); set(374, .58, .445);
  set(61, .43, .615); set(291, .57, .615); set(13, .5, .605); set(14, .5, .625);
  set(152, .5, .80); set(107, .46, .36); set(336, .54, .36);
  set(70, .39, .35); set(300, .61, .35);
  const mesh = buildSourceFaceMesh(landmarks);
  const deformer = new ExpressionDeformer(mesh, landmarks);
  return { landmarks, mesh, deformer };
}

function nearest(mesh: ReturnType<typeof buildSourceFaceMesh>, x: number, y: number): number {
  let found = 0, distance = Infinity;
  for (let i = 0; i < mesh.uvs.length / 2; i++) {
    const d = Math.hypot(mesh.uvs[i * 2]! - x, mesh.uvs[i * 2 + 1]! - y);
    if (d < distance) { distance = d; found = i; }
  }
  return found;
}
const delta = (mesh: ReturnType<typeof buildSourceFaceMesh>, changed: Float32Array, i: number, axis: 0 | 1) =>
  changed[i * 3 + axis]! - mesh.positions[i * 3 + axis]!;

describe("local expression deformer", () => {
  it("keeps neutral source vertices, UVs, and the position buffer stable", () => {
    const { mesh, deformer } = fixture();
    const uv = mesh.uvs.slice();
    const output = deformer.update(NEUTRAL_EXPRESSION);
    expect(Array.from(output)).toEqual(Array.from(mesh.positions));
    deformer.update({ ...NEUTRAL_EXPRESSION, jawOpen: .4 });
    deformer.update({ ...NEUTRAL_EXPRESSION, blinkLeft: 1 });
    expect(deformer.positions).toBe(output);
    expect(mesh.uvs).toEqual(uv);
  });

  it("closes either eyelid independently and leaves the nose fixed", () => {
    const { mesh, deformer } = fixture();
    const leftUpper = nearest(mesh, .42, .416);
    const rightUpper = nearest(mesh, .58, .416);
    const leftBrow = nearest(mesh, .39, .35);
    const nose = nearest(mesh, .5, .5);
    const left = deformer.update({ ...NEUTRAL_EXPRESSION, blinkLeft: 1 });
    expect(delta(mesh, left, leftUpper, 1)).toBeLessThan(-0.001);
    expect(Math.abs(delta(mesh, left, rightUpper, 1))).toBeLessThan(0.0001);
    expect(Math.abs(delta(mesh, left, leftBrow, 1))).toBeLessThan(0.0001);
    expect(Math.abs(delta(mesh, left, nose, 1))).toBeLessThan(0.0001);
    const right = deformer.update({ ...NEUTRAL_EXPRESSION, blinkRight: 1 });
    expect(delta(mesh, right, rightUpper, 1)).toBeLessThan(-0.001);
    expect(Math.abs(delta(mesh, right, leftUpper, 1))).toBeLessThan(0.0001);
  });

  it("opens the lower lip and chin monotonically without moving the nose", () => {
    const { mesh, deformer } = fixture();
    const lip = nearest(mesh, .5, .625);
    const chin = nearest(mesh, .5, .77);
    const nose = nearest(mesh, .5, .5);
    const half = delta(mesh, deformer.update({ ...NEUTRAL_EXPRESSION, jawOpen: .2 }), lip, 1);
    const full = delta(mesh, deformer.update({ ...NEUTRAL_EXPRESSION, jawOpen: .4 }), lip, 1);
    expect(full).toBeLessThan(half);
    expect(half).toBeLessThan(0);
    expect(delta(mesh, deformer.positions, chin, 1)).toBeLessThan(0);
    expect(Math.abs(delta(mesh, deformer.positions, nose, 1))).toBeLessThan(0.0001);
  });

  it("lifts each mouth corner and brow locally", () => {
    const { mesh, deformer } = fixture();
    const leftCorner = nearest(mesh, .43, .615);
    const rightCorner = nearest(mesh, .57, .615);
    const leftBrow = nearest(mesh, .39, .35);
    const nose = nearest(mesh, .5, .5);
    let output = deformer.update({ ...NEUTRAL_EXPRESSION, smileLeft: .5 });
    expect(delta(mesh, output, leftCorner, 1)).toBeGreaterThan(0);
    expect(Math.abs(delta(mesh, output, rightCorner, 1))).toBeLessThan(0.001);
    output = deformer.update({ ...NEUTRAL_EXPRESSION, browOuterUpLeft: .5 });
    expect(delta(mesh, output, leftBrow, 1)).toBeGreaterThan(0);
    expect(Math.abs(delta(mesh, output, nose, 1))).toBeLessThan(0.0001);
  });

  it("limits a closed-mouth source without silencing it", () => {
    /*
     * This asserted `jawOpen < 0.4`, and a real device showed what that cost: a
     * full request reached the mesh as 0.29, moved the lips about five pixels,
     * and read as a mouth that simply did not respond.
     *
     * Both halves of the contract matter. A closed-mouth photograph has no teeth
     * or tongue behind the lips, so the limit is real and must stay below a full
     * gape. But lips, chin and jaw have every pixel they need, so the limit must
     * still leave enough range to be plainly visible.
     */
    const { landmarks } = fixture();
    const source = deriveSourceExpression({ landmarks, blendshapes: {}, neutralEyeOpenness: .5, neutralMouthOpenness: 0 } as never);
    const envelope = deriveExpressionEnvelope(source);

    expect(envelope.jawOpen, "a closed mouth must still be limited").toBeLessThan(1);
    expect(envelope.jawOpen, "but not so far that the jaw stops reading").toBeGreaterThan(.45);

    const result = clampExpression({ ...NEUTRAL_EXPRESSION, jawOpen: 1 }, envelope);
    expect(result.applied.jawOpen).toBe(envelope.jawOpen);
    expect(result.clamped).toContain("jawOpen");
  });

  it("does not let an expression the source already shows cap that expression", () => {
    /*
     * The other half of the same real-device failure. A source photographed
     * mid-smile with slightly raised brows had every live expression crushed to
     * between 0.15 and 0.32, because an expression already present was treated
     * as a ceiling rather than a starting position.
     *
     * It has every pixel needed to smile further. Only the mouth INTERIOR is a
     * genuine pixel limit.
     */
    const { landmarks } = fixture();
    const expressive = deriveSourceExpression({
      landmarks,
      blendshapes: { mouthSmileLeft: .6, mouthSmileRight: .5, browInnerUp: .75, browOuterUpLeft: .6, browOuterUpRight: .5 },
      neutralEyeOpenness: .5,
      neutralMouthOpenness: 0,
    } as never);
    const envelope = deriveExpressionEnvelope(expressive);

    for (const key of ["smileLeft", "smileRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight"] as const) {
      expect(envelope[key], `${key} was crushed by the source's own expression`).toBeGreaterThan(.5);
    }
  });

  it("responds to blink faster than brow and eases toward neutral after loss", () => {
    const target = { ...NEUTRAL_EXPRESSION, blinkLeft: 1, browInnerUp: 1, jawOpen: 1 };
    const frame = smoothExpression(NEUTRAL_EXPRESSION, target, 16);
    expect(frame.blinkLeft).toBeGreaterThan(frame.browInnerUp);
    expect(frame.jawOpen).toBeGreaterThan(frame.browInnerUp);
    expect(frame.blinkLeft).toBeLessThan(1);
    expect(smoothExpression(frame, NEUTRAL_EXPRESSION, 100).blinkLeft).toBeLessThan(frame.blinkLeft);
  });
});
