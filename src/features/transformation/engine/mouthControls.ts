import type { Point3, BlendshapeScores } from "./faceTypes"
import { jawDisplacement, mouthOpenness } from "./faceGeometry"

export const MOUTH_SIDES = ["left", "right"] as const
export const MOUTH_ANCHORS = {
  left: 291,
  right: 61,
  upper: 13,
  lower: 14,
} as const
export const MOUTH_RENDER_CHANNELS = { left: "right", right: "left" } as const
export const MOUTH_SHAPES = [
  "jawOpen",
  "jawLeft",
  "jawRight",
  "jawForward",
  "mouthClose",
  "mouthPucker",
  "mouthFunnel",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthRollUpper",
  "mouthRollLower",
] as const
const unit = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
export interface MouthGeometry {
  width: number
  aperture: number
  lipThickness: number
  jaw: number
  cornerLeftX: number
  cornerRightX: number
  cornerLeftY: number
  cornerRightY: number
  centerX: number
  centerY: number
  upperLeftY: number
  upperRightY: number
  lowerLeftY: number
  lowerRightY: number
}
export interface MouthCalibration {
  geometry: MouthGeometry
  shapes: Partial<Record<string, number>>
}
export interface MouthControlFrame {
  timestampMs: number
  lastTrustedAtMs?: number
  jaw: { open: number; left: number; right: number; forward: number }
  aperture: {
    vertical: number
    horizontal: number
    measured: number
    width: number
  }
  lips: {
    pucker: number
    funnel: number
    pressLeft: number
    pressRight: number
    upperRaiseLeft: number
    upperRaiseRight: number
    lowerDownLeft: number
    lowerDownRight: number
    stretchLeft: number
    stretchRight: number
    rollUpper: number
    rollLower: number
  }
  corners: {
    smileLeft: number
    smileRight: number
    frownLeft: number
    frownRight: number
    dimpleLeft: number
    dimpleRight: number
  }
  shape: { rounded: number; widened: number; pursed: number; compressed: number }
  confidence: number
  missing: string[]
  /** Head-local geometry, separate from model availability. Never persisted. */
  measured?: MouthGeometry
}
/** Input has already had head pose removed. u follows image-right, v image-down. */
export function mouthBasis(points: readonly Point3[]) {
  const l = points[61],
    r = points[291]
  if (!l || !r || ![l.x, l.y, r.x, r.y].every(Number.isFinite)) return null
  const width = Math.hypot(r.x - l.x, r.y - l.y)
  if (width < 1e-5) return null
  return {
    width,
    c: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 },
    u: { x: (r.x - l.x) / width, y: (r.y - l.y) / width },
    v: { x: -(r.y - l.y) / width, y: (r.x - l.x) / width },
  }
}
export function measureMouthGeometry(
  points: readonly Point3[],
): MouthGeometry | null {
  const b = mouthBasis(points),
    upper = points[13],
    lo = points[14],
    a = points[234],
    z = points[454]
  if (!b || !upper || !lo || !a || !z) return null
  const span = Math.hypot(z.x - a.x, z.y - a.y)
  if (span < 1e-5) return null
  const ref = points[1] ?? b.c
  const px = (p: Point3) => (p.x - ref.x) / span
  // Upper lip is the vertical reference: lower-jaw travel cannot lift corners.
  // Head-local vertical retains a unilateral corner lift. Projecting corners
  // onto their own moving corner-to-corner perpendicular would cancel it.
  const py = (p: Point3) => (upper.y - p.y) / span
  const thickness =
    points[0] && points[17]
      ? Math.max(
          0,
          Math.abs(
            (points[17]!.x - points[0]!.x) * b.v.x +
              (points[17]!.y - points[0]!.y) * b.v.y,
          ) - Math.abs((lo.x - upper.x) * b.v.x + (lo.y - upper.y) * b.v.y),
        ) / b.width
      : 0
  const g = {
    width: b.width / span,
    aperture: mouthOpenness(points),
    lipThickness: thickness,
    jaw: jawDisplacement(points),
    cornerLeftX: px(points[291]!),
    cornerRightX: px(points[61]!),
    cornerLeftY: py(points[291]!),
    cornerRightY: py(points[61]!),
    centerX: (b.c.x - ref.x) / span,
    centerY: (b.c.y - ref.y) / span,
    upperLeftY: ([312,311,310].reduce((s,i)=>s+(points[i]?.y ?? upper.y),0)/3-ref.y)/span,
    upperRightY: ([82,81,80].reduce((s,i)=>s+(points[i]?.y ?? upper.y),0)/3-ref.y)/span,
    // Chin reference removes lower-jaw travel before measuring lower lip motion.
    lowerLeftY: ([317,402,318].reduce((s,i)=>s+(points[i]?.y ?? lo.y),0)/3-(points[152]?.y ?? lo.y))/span,
    lowerRightY: ([87,178,88].reduce((s,i)=>s+(points[i]?.y ?? lo.y),0)/3-(points[152]?.y ?? lo.y))/span,
  }
  return Object.values(g).every(Number.isFinite) ? g : null
}
export function measureMouthControls(
  points: readonly Point3[],
  shapes: BlendshapeScores,
  neutral: MouthCalibration | undefined,
  jawOpen: number,
  confidence: number,
  timestampMs: number,
  poseDelta = 0,
): MouthControlFrame | null {
  const g = measureMouthGeometry(points)
  if (!g) return null
  const base = neutral?.geometry ?? g
  const dead = 0.02 + 0.12 * Math.min(1, Math.abs(poseDelta) / 0.26)
  const signal = (name: string) =>
    typeof shapes[name] === "number"
      ? unit(
          (shapes[name]! - (neutral?.shapes[name] ?? 0) - dead) /
            Math.max(0.25, 1 - (neutral?.shapes[name] ?? 0) - dead),
        )
      : 0
  const widthRatio = g.width / Math.max(0.01, base.width)
  const narrow = unit((1 - widthRatio) / 0.3),
    wide = unit((widthRatio - 1) / 0.3)
  const aperture = unit(
    (g.aperture - base.aperture) / Math.max(0.25, 1 - base.aperture),
  )
  const pucker = Math.max(signal("mouthPucker"), narrow * (1 - aperture))
  const funnel = Math.max(signal("mouthFunnel"), narrow * aperture)
  const out: MouthControlFrame = {
    timestampMs,
    jaw: {
      open: unit(jawOpen),
      left: signal("jawLeft"),
      right: signal("jawRight"),
      forward: signal("jawForward"),
    },
    aperture: {
      vertical: aperture,
      horizontal: wide,
      measured: g.aperture,
      width: g.width,
    },
    lips: {
      pucker,
      funnel,
      pressLeft: signal("mouthPressLeft"),
      pressRight: signal("mouthPressRight"),
      upperRaiseLeft: signal("mouthUpperUpLeft"),
      upperRaiseRight: signal("mouthUpperUpRight"),
      lowerDownLeft: signal("mouthLowerDownLeft"),
      lowerDownRight: signal("mouthLowerDownRight"),
      stretchLeft: signal("mouthStretchLeft"),
      stretchRight: signal("mouthStretchRight"),
      rollUpper: signal("mouthRollUpper"),
      rollLower: signal("mouthRollLower"),
    },
    corners: {
      smileLeft: 0,
      smileRight: 0,
      frownLeft: signal("mouthFrownLeft"),
      frownRight: signal("mouthFrownRight"),
      dimpleLeft: signal("mouthDimpleLeft"),
      dimpleRight: signal("mouthDimpleRight"),
    },
    shape: { rounded: funnel, widened: wide, pursed: pucker, compressed: 0 },
    confidence: unit(confidence),
    missing: MOUTH_SHAPES.filter((k) => typeof shapes[k] !== "number"),
    measured: g,
  }
  for (const side of MOUTH_SIDES) {
    const suffix = side === "left" ? "Left" : "Right"
    const upperKey = `upper${suffix}Y` as 'upperLeftY'|'upperRightY'
    const lowerKey = `lower${suffix}Y` as 'lowerLeftY'|'lowerRightY'
    // Independent measured lip strips support weak/missing blendshapes. A jaw
    // score cannot manufacture pucker, press or a unilateral lip movement.
    if (base[upperKey] !== undefined && g[upperKey] !== undefined)
      out.lips[`upperRaise${suffix}`] = Math.max(out.lips[`upperRaise${suffix}`], unit((base[upperKey]!-g[upperKey]!-.003)/Math.max(.015,base.width*.12)))
    if (base[lowerKey] !== undefined && g[lowerKey] !== undefined)
      out.lips[`lowerDown${suffix}`] = Math.max(out.lips[`lowerDown${suffix}`], unit((g[lowerKey]!-base[lowerKey]!-.003)/Math.max(.015,base.width*.12)))
    const lift = unit((g[`corner${suffix}Y`] - base[`corner${suffix}Y`]) / 0.08)
    // Jaw alone can raise the model's smile score. Gate that leakage with
    // measured corner elevation, retaining an intentional smile with an open jaw.
    const smileScore = signal(`mouthSmile${suffix}`)
    out.corners[`smile${suffix}`] = Math.max(
      lift,
      smileScore * (1 - unit(jawOpen) * 0.85 * (1 - lift)),
    )
    out.corners[`frown${suffix}`] = Math.max(
      out.corners[`frown${suffix}`],
      unit((base[`corner${suffix}Y`] - g[`corner${suffix}Y`]) / 0.08),
    )
    const extent =
      Math.abs(g[`corner${suffix}X`]) - Math.abs(base[`corner${suffix}X`])
    out.lips[`stretch${suffix}`] = Math.max(
      out.lips[`stretch${suffix}`],
      unit(extent / Math.max(0.01, base.width * 0.15)),
    )
  }
  out.shape.compressed = Math.max(
    out.lips.pressLeft,
    out.lips.pressRight,
    signal("mouthClose"),
  )
  return out
}
/** Renderer-only filter: speech movements stay fast; weak confidence has a
 * finite hold/decay. No expression queue and no changes to the eye filter. */
export function smoothMouth(
  previous: MouthControlFrame | undefined,
  target: MouthControlFrame | undefined,
  elapsed: number,
): MouthControlFrame | undefined {
  if (!target && !previous) return undefined
  const lost = !target
  const result = structuredClone(target ?? previous!),
    dt = Math.max(0, Math.min(80, elapsed))
  result.lastTrustedAtMs =
    target && target.confidence >= 0.35
      ? target.timestampMs
      : previous?.lastTrustedAtMs
  if (!previous) return result
  const weak = lost || result.confidence < 0.35
  if (weak) {
    result.confidence = 0
    const hold =
      !lost &&
      target!.timestampMs - (previous.lastTrustedAtMs ?? previous.timestampMs) <
        120
    for (const group of ["jaw", "lips", "corners", "shape"] as const) {
      const dest = result[group] as unknown as Record<string, number>,
        before = previous[group] as unknown as Record<string, number>
      for (const key of Object.keys(dest))
        dest[key] = before[key]! * (hold ? 1 : Math.exp(-dt / 160))
    }
    result.aperture.vertical =
      previous.aperture.vertical * (hold ? 1 : Math.exp(-dt / 160))
    result.aperture.horizontal =
      previous.aperture.horizontal * (hold ? 1 : Math.exp(-dt / 160))
    return result
  }
  for (const group of [
    "jaw",
    "aperture",
    "lips",
    "corners",
    "shape",
  ] as const) {
    for (const key of Object.keys(result[group])) {
      const r = result[group] as unknown as Record<string, number>,
        p = previous[group] as unknown as Record<string, number>
      const delta = Math.abs(r[key]! - p[key]!)
      const tau = delta > 0.08 ? 14 : 28
      r[key] = p[key]! + (r[key]! - p[key]!) * (1 - Math.exp(-dt / tau))
    }
  }
  return result
}
