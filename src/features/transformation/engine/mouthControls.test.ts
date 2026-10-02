import { describe, it, expect } from "vitest"
import { Euler, Vector3, Matrix4 } from "three"
import {
  mouthBasis,
  measureMouthGeometry,
  measureMouthControls,
  smoothMouth,
} from "./mouthControls"
import {
  mouthNoseFixture,
  mouthNoseFrame,
} from "./fixtures/mouthNoseRegression"
import { CalibrationCollector } from "./calibrationCollector"
import { computeExpressionMotion } from "./expressionMotion"
import { canonicalFaceLandmarks } from "./faceLocalGeometry"
import { noseControls, measureNoseGeometry } from "./noseControls"
import { mouthNoseLocalLandmarks } from "./mouthNoseLocalGeometry"
export function mouthCalibration(o: Parameters<typeof mouthNoseFrame>[0] = {}) {
  const collector = new CalibrationCollector()
  collector.start(
    "face-only",
    {
      cameraFacing: "user",
      trackingWidth: 640,
      trackingHeight: 640,
      mirrored: false,
    },
    0,
  )
  for (let t = 0; t <= 4000 && collector.getState().phase !== "ready"; t += 100)
    collector.accept(mouthNoseFrame(o, {}, t), null, t)
  const profile = collector.getState().profile
  if (!profile) throw Error(JSON.stringify(collector.getState()))
  return profile
}
describe("M8.7 canonical mouth measurements", () => {
  it("builds orthogonal mouth axes and rejects collapsed/missing geometry", () => {
    const b = mouthBasis(mouthNoseFixture())!
    expect(b.u.x * b.v.x + b.u.y * b.v.y).toBeCloseTo(0)
    expect(b.width).toBeCloseTo(0.18)
    expect(mouthBasis([])).toBeNull()
    expect(
      mouthBasis(Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }))),
    ).toBeNull()
  })
  it("multi-point aperture survives one bad central pair", () => {
    const p = mouthNoseFixture({ jaw: 0.5 }),
      before = measureMouthGeometry(p)!.aperture
    p[14] = { ...p[13]! }
    expect(measureMouthGeometry(p)!.aperture).toBeGreaterThan(before * 0.6)
  })
  it("calibrates parted lips, width, compression and corners independently", () => {
    const profile = mouthCalibration({ aperture: 0.015, leftSmile: 0.1 })
    expect(profile.face.mouth!.geometry.aperture).toBeGreaterThan(0.05)
    const m = computeExpressionMotion(
      mouthNoseFrame({ aperture: 0.015, leftSmile: 0.1 }),
      profile,
    )!.mouth!
    expect(m.jaw.open).toBeLessThan(0.01)
    expect(m.corners.smileLeft).toBeLessThan(0.01)
    expect(m.corners.smileRight).toBeLessThan(0.01)
  })
  it("jaw fuses aperture and chin when a present blendshape under-reports", () => {
    const e = computeExpressionMotion(
      mouthNoseFrame({ jaw: 1 }, { jawOpen: 0 }),
      mouthCalibration(),
    )!
    expect(e.mouth!.jaw.open).toBeGreaterThan(0.7)
  })
  it("jaw opening cannot generate smile with still corners", () => {
    const e = computeExpressionMotion(
      mouthNoseFrame({ jaw: 1 }),
      mouthCalibration(),
    )!
    expect(e.mouth!.corners.smileLeft).toBeLessThan(0.02)
    expect(e.mouth!.corners.smileRight).toBeLessThan(0.02)
  })
  it.each(["left", "right"] as const)(
    "keeps anatomical %s smile independent",
    (side) => {
      const m = computeExpressionMotion(
        mouthNoseFrame({ [side === "left" ? "leftSmile" : "rightSmile"]: 1 }, {
          [side === "left" ? "mouthSmileLeft" : "mouthSmileRight"]: 1,
        }),
        mouthCalibration(),
      )!.mouth!
      expect(
        m.corners[side === "left" ? "smileLeft" : "smileRight"],
      ).toBeGreaterThan(0.9)
      expect(
        m.corners[side === "left" ? "smileRight" : "smileLeft"],
      ).toBeLessThan(0.01)
    },
  )
  it.each([
    ["mouthPucker", "pucker"],
    ["mouthFunnel", "funnel"],
    ["mouthPressLeft", "pressLeft"],
    ["mouthStretchRight", "stretchRight"],
    ["mouthUpperUpLeft", "upperRaiseLeft"],
    ["mouthLowerDownRight", "lowerDownRight"],
    ["mouthRollUpper", "rollUpper"],
  ] as const)("maps %s without changing jaw or opposite lip", (shape, key) => {
    const m = computeExpressionMotion(
      mouthNoseFrame({}, { [shape]: 1 }),
      mouthCalibration(),
    )!.mouth!
    expect(m.lips[key]).toBeGreaterThan(0.95)
    expect(m.jaw.open).toBe(0)
  })
  it.each([
    [0.3, 0, 0],
    [0, -0.35, 0],
    [0, 0, 0.3],
    [0.3, -0.25, 0.2],
  ])("mouth and nose ratios isolate rigid pose %j", (yaw, pitch, roll) => {
    const p = mouthNoseFixture({ jaw: 0.5, leftSmile: 0.6 }),
      aspect = 390 / 844
    const rotated = p.map((point) => {
      const v = new Vector3(point.x - 0.5, -(point.y - 0.5), -(point.z + 0.05))
        .applyEuler(new Euler(pitch, yaw, roll, "XYZ"))
        .multiplyScalar(1.3)
      return { x: 0.6 + v.x, y: 0.4 - v.y * aspect, z: -v.z }
    })
    const local = canonicalFaceLandmarks(rotated, { yaw, pitch, roll }, aspect)
    const a = measureMouthGeometry(p)!,
      b = measureMouthGeometry(local)!
    for (const key of Object.keys(a) as Array<keyof typeof a>)
      expect(b[key]).toBeCloseTo(a[key], 6)
    expect(measureNoseGeometry(local)!.left).toBeCloseTo(
      measureNoseGeometry(p)!.left,
      6,
    )
  })
  it("responsive filtering holds weak confidence briefly then decays and recovers", () => {
    const frame = mouthNoseFrame(),
      profile = mouthCalibration(),
      base = computeExpressionMotion(frame, profile)!.mouth!
    let m = smoothMouth(undefined, base, 16)!
    const open = { ...base, timestampMs: 16, jaw: { ...base.jaw, open: 1 } }
    m = smoothMouth(m, open, 16)!
    expect(m.jaw.open).toBeGreaterThan(0.6)
    const held = smoothMouth(
      m,
      { ...open, timestampMs: 60, confidence: 0 },
      16,
    )!
    expect(held.jaw.open).toBe(m.jaw.open)
    for (let t = 200; t < 1600; t += 50)
      m = smoothMouth(m, { ...open, timestampMs: t, confidence: 0 }, 50)!
    expect(m.jaw.open).toBeLessThan(0.01)
    expect(
      smoothMouth(m, { ...open, timestampMs: 1700 }, 50)!.jaw.open,
    ).toBeGreaterThan(0.9)
  })
  it.each([
    [0.3, 0.25, 0.2],
    [-0.3, -0.35, -0.2],
  ])("full model basis isolates compound rotation %j", (yaw, pitch, roll) => {
    const frame = mouthNoseFrame(),
      e = new Euler(pitch, yaw, roll, "XYZ"),
      aspect = 16 / 9
    const rotation = new Matrix4().makeRotationFromEuler(e)
    frame.landmarks = frame.landmarks.map((p) => {
      const v = new Vector3(p.x - 0.5, -(p.y - 0.5), -(p.z + 0.05))
        .applyEuler(e)
        .multiplyScalar(0.7)
      return { x: 0.6 + v.x, y: 0.4 - v.y * aspect, z: -v.z }
    })
    frame.facialTransformationMatrix = rotation.elements.map((v, i) =>
      i % 4 === 3 || i >= 12 ? v : v * 1.2,
    )
    const local = mouthNoseLocalLandmarks(frame, aspect),
      expected = measureMouthGeometry(mouthNoseFixture())!,
      actual = measureMouthGeometry(local)!
    for (const k of Object.keys(expected) as Array<keyof typeof expected>)
      expect(actual[k]).toBeCloseTo(expected[k], 6)
    const profile = mouthCalibration()
    profile.trackingSpace = {
      ...profile.trackingSpace!,
      width: 1600,
      height: 900,
    }
    const controls = computeExpressionMotion(frame, profile)!
    expect(controls.mouth!.jaw.open).toBeLessThan(0.001)
    expect(controls.mouth!.corners.smileLeft).toBeLessThan(0.001)
    expect(controls.mouth!.corners.smileRight).toBeLessThan(0.001)
  })
  it("unsupported nose channels remain unavailable; supported sneer is unilateral", () => {
    const p = mouthNoseFixture(),
      g = measureNoseGeometry(p)!
    expect(noseControls(p, {}, undefined, 1).supported.left).toBe(false)
    const n = noseControls(
      p,
      { noseSneerLeft: 1, noseSneerRight: 0 },
      { ...g, shapes: { left: 0, right: 0 } },
      1,
    )
    expect(n.sneerLeft).toBeGreaterThan(0.95)
    expect(n.sneerRight).toBe(0)
  })
})
