import { describe, it, expect } from "vitest"
import { Euler, Vector3 } from "three"
import { buildSourceFaceMesh, INNER_LIP_RING } from "./sourceMesh"
import { ExpressionDeformer, EYELIDS } from "./expressionDeformer"
import { NEUTRAL_EXPRESSION } from "../expressionMotion"
import {
  mouthNoseFixture,
  mouthNoseFrame,
} from "../fixtures/mouthNoseRegression"
import { measureMouthControls, measureMouthGeometry } from "../mouthControls"
import { noseControls } from "../noseControls"
const rig = (aperture = 0) => {
  const p = mouthNoseFixture({ aperture }),
    mesh = buildSourceFaceMesh(p, { yaw: 0, pitch: 0, roll: 0 }),
    d = new ExpressionDeformer(mesh, p)
  const g = measureMouthGeometry(p)!
  const controls = (shapes: Record<string, number> = {}, jaw = 0) =>
    measureMouthControls(p, shapes, { geometry: g, shapes: {} }, jaw, 1, 0)!
  return { p, mesh, d, controls }
}
describe("M8.7 source-preserving mouth and nose deformation", () => {
  it.each([-0.004, 0, 0.02])(
    "opens a source with aperture %s monotonically from 0 to 100%",
    (aperture) => {
      const { d, controls } = rig(aperture)
      let last = -Infinity
      for (const jaw of [0, 0.25, 0.5, 0.75, 1]) {
        const p = d.update({ ...NEUTRAL_EXPRESSION, mouth: controls({}, jaw) })
        const gap = p[13 * 3 + 1]! - p[14 * 3 + 1]!
        expect(gap).toBeGreaterThan(last + 0.005)
        last = gap
      }
    },
  )
  it("preserves neutral parted appearance and pinned source teeth without any UV writes", () => {
    const { mesh, d, controls } = rig(0.02),
      uv = mesh.uvs.slice(),
      indices = mesh.indices.slice()
    expect(
      d.update({ ...NEUTRAL_EXPRESSION, mouth: controls() })[13 * 3 + 1],
    ).toBeCloseTo(mesh.positions[13 * 3 + 1]!)
    const positions = d.update({
        ...NEUTRAL_EXPRESSION,
        mouth: controls({}, 1),
      }),
      m = mesh.mouth!
    expect(
      positions.slice(m.fillStart * 3, (m.fillStart + m.fillCount) * 3),
    ).toEqual(
      mesh.positions.slice(m.fillStart * 3, (m.fillStart + m.fillCount) * 3),
    )
    expect(mesh.uvs).toEqual(uv)
    expect(mesh.indices).toEqual(indices)
  })
  it.each([
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthUpperUpRight",
    "mouthLowerDownLeft",
    "mouthDimpleRight",
  ])("%s has an independent mouth-side field", (shape) => {
    const { d, controls } = rig()
    const p = d.update({
      ...NEUTRAL_EXPRESSION,
      mouth: controls({ [shape]: 1 }),
    })
    const left = Math.hypot(
      p[291 * 3]! - d.basePositions[291 * 3]!,
      p[291 * 3 + 1]! - d.basePositions[291 * 3 + 1]!,
    )
    const right = Math.hypot(
      p[61 * 3]! - d.basePositions[61 * 3]!,
      p[61 * 3 + 1]! - d.basePositions[61 * 3 + 1]!,
    )
    if (
      shape.includes("Smile") ||
      shape.includes("Frown") ||
      shape.includes("Dimple")
    ) {
      expect(shape.endsWith("Left") ? left : right).toBeGreaterThan(0.003)
      expect(shape.endsWith("Left") ? right : left).toBeLessThan(0.001)
    } else expect(p).not.toEqual(d.basePositions)
  })
  it("pucker narrows and protrudes; funnel opens roundly; EE widens without smile", () => {
    const { d, controls } = rig()
    const width = (p: Float32Array) => p[291 * 3]! - p[61 * 3]!
    const neutralWidth = width(d.basePositions)
    const pucker = d
      .update({ ...NEUTRAL_EXPRESSION, mouth: controls({ mouthPucker: 1 }) })
      .slice()
    const funnel = d
      .update({ ...NEUTRAL_EXPRESSION, mouth: controls({ mouthFunnel: 1 }) })
      .slice()
    const ee = d
      .update({
        ...NEUTRAL_EXPRESSION,
        mouth: controls({ mouthStretchLeft: 1, mouthStretchRight: 1 }),
      })
      .slice()
    expect(width(pucker)).toBeLessThan(neutralWidth * 0.95)
    expect(pucker[13 * 3 + 2]).toBeGreaterThan(d.basePositions[13 * 3 + 2]!)
    expect(funnel[13 * 3 + 1]! - funnel[14 * 3 + 1]!).toBeGreaterThan(
      pucker[13 * 3 + 1]! - pucker[14 * 3 + 1]! + 0.005,
    )
    expect(width(ee)).toBeGreaterThan(neutralWidth * 1.2)
  })
  it("press seals a parted inner contour continuously", () => {
    const { d, controls } = rig(0.015)
    const baseGap = d.basePositions[13 * 3 + 1]! - d.basePositions[14 * 3 + 1]!
    const half = d
      .update({
        ...NEUTRAL_EXPRESSION,
        mouth: controls({ mouthPressLeft: 0.5, mouthPressRight: 0.5 }),
      })
      .slice()
    const full = d.update({
      ...NEUTRAL_EXPRESSION,
      mouth: controls({ mouthPressLeft: 1, mouthPressRight: 1 }),
    })
    expect(half[13 * 3 + 1]! - half[14 * 3 + 1]!).toBeLessThan(baseGap)
    expect(Math.abs(full[13 * 3 + 1]! - full[14 * 3 + 1]!)).toBeLessThan(0.001)
  })
  it("all mouth shapes leave locked eyes, brows, nose bridge and tip unchanged", () => {
    const { mesh, d, controls } = rig()
    const frame: Record<string, number> = Object.fromEntries(
      Object.keys(mouthNoseFrame().blendshapes).map((key) => [key, 1]),
    )
    const p = d.update({ ...NEUTRAL_EXPRESSION, mouth: controls(frame, 1) })
    const protectedIndices = [
      1,
      2,
      6,
      168,
      70,
      107,
      300,
      336,
      ...EYELIDS.left.upper,
      ...EYELIDS.left.lower,
      ...EYELIDS.right.upper,
      ...EYELIDS.right.lower,
    ]
    for (const index of protectedIndices)
      expect(p.slice(index * 3, index * 3 + 3), `anchor ${index}`).toEqual(
        d.basePositions.slice(index * 3, index * 3 + 3),
      )
    expect(p.slice(mesh.eyeInterior!.start * 3)).toEqual(
      d.basePositions.slice(mesh.eyeInterior!.start * 3),
    )
  })
  it("nose sneer moves only its wing, preserves bridge/tip/eye geometry, and never changes source UVs", () => {
    const { mesh, d, p } = rig()
    const uv = mesh.uvs.slice()
    const n = noseControls(
      p,
      { noseSneerLeft: 1, noseSneerRight: 0 },
      undefined,
      1,
    )
    const v = d.update({ ...NEUTRAL_EXPRESSION, nose: n })
    expect(v[327 * 3 + 1]).toBeGreaterThan(d.basePositions[327 * 3 + 1]!)
    expect(v[98 * 3 + 1]).toBe(d.basePositions[98 * 3 + 1])
    for (const index of [1, 2, 6, 168, 159, 386, 13, 14])
      expect(v.slice(index * 3, index * 3 + 3)).toEqual(
        d.basePositions.slice(index * 3, index * 3 + 3),
      )
    expect(mesh.uvs).toEqual(uv)
  })
  it("nose depth and underside projection come from rigid rotation rather than nose translation", () => {
    const { mesh } = rig()
    const point = (i: number) =>
      new Vector3(
        ...Array.from(
          mesh.positions.slice(i * 3, i * 3 + 3),
        ) as [number, number, number],
      )
    expect(point(1).z).toBeGreaterThan(point(234).z + 0.01)
    expect(point(6).z).toBeGreaterThan(point(234).z + 0.005)
    const gap = (pitch: number) =>
      point(1).applyEuler(new Euler(pitch, 0, 0)).y -
      point(2).applyEuler(new Euler(pitch, 0, 0)).y
    expect(Math.abs(gap(-0.35) - gap(0.35))).toBeGreaterThan(0.01)
    const original = point(1).distanceTo(point(6))
    expect(
      point(1)
        .applyEuler(new Euler(0.3, 0.3, 0))
        .distanceTo(point(6).applyEuler(new Euler(0.3, 0.3, 0))),
    ).toBeCloseTo(original, 6)
  })
})
