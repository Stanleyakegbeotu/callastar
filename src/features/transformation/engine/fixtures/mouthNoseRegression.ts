import { eyeRegressionFixture, eyeRegressionFrame } from "./eyeRegression"
import { INNER_LIP_RING, OUTER_LIP_RING } from "../rendering/sourceMesh"
import { MOUTH_SHAPES } from "../mouthControls"
export interface MouthFixtureSettings {
  jaw?: number
  aperture?: number
  width?: number
  leftSmile?: number
  rightSmile?: number
  eyes?: Parameters<typeof eyeRegressionFixture>[0]
}
export function mouthNoseFixture(o: MouthFixtureSettings = {}) {
  const p = eyeRegressionFixture(o.eyes),
    jaw = o.jaw ?? 0,
    width = o.width ?? 0.18
  for (const [indices, outer] of [
    [INNER_LIP_RING, false],
    [OUTER_LIP_RING, true],
  ] as const) {
    indices.forEach((index, k) => {
      const a = (k / indices.length) * Math.PI * 2,
        s = Math.sin(a)
      const height = (outer ? 0.018 : 0.004) + (o.aperture ?? 0)
      p[index] = {
        x: 0.5 - (Math.cos(a) * width) / 2,
        y: 0.67 + s * height + (s > 0 ? s * jaw * 0.09 : s * jaw * 0.008),
        z: -0.01,
      }
    })
  }
  for (const [indices, side, amount] of [
    [[291, 308], "left", o.leftSmile ?? 0],
    [[61, 78], "right", o.rightSmile ?? 0],
  ] as const) {
    for (const i of indices) {
      p[i]!.y -= amount * 0.035
      p[i]!.x += (side === "left" ? 1 : -1) * amount * 0.015
    }
  }
  p[152]!.y = 0.8 + jaw * 0.05
  p[1] = { x: 0.5, y: 0.5, z: -0.075 }
  p[2] = { x: 0.5, y: 0.565, z: -0.045 }
  p[6] = { x: 0.5, y: 0.445, z: -0.04 }
  p[168] = { x: 0.5, y: 0.425, z: -0.025 }
  p[98] = { x: 0.468, y: 0.548, z: -0.035 }
  p[327] = { x: 0.532, y: 0.548, z: -0.035 }
  return p
}
export function mouthNoseFrame(
  o: MouthFixtureSettings = {},
  shapes: Record<string, number> = {},
  timestampMs = 0,
) {
  const frame = eyeRegressionFrame(mouthNoseFixture(o), timestampMs)
  frame.blendshapes = {
    ...Object.fromEntries(
      [
        ...MOUTH_SHAPES,
        "noseSneerLeft",
        "noseSneerRight",
        "eyeBlinkLeft",
        "eyeBlinkRight",
      ].map((k) => [k, 0]),
    ),
    ...shapes,
  }
  return frame
}
