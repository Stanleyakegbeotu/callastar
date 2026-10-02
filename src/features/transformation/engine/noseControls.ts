import type { Point3, BlendshapeScores } from "./faceTypes"
export interface NoseCalibration {
  left: number
  right: number
  shapes: { left: number; right: number }
}
export interface NoseControlFrame {
  sneerLeft: number
  sneerRight: number
  confidence: number
  geometry: { left: number; right: number } | null
  supported: { left: boolean; right: boolean }
}
export function measureNoseGeometry(
  p: readonly Point3[],
): { left: number; right: number } | null {
  if (!p[1] || !p[98] || !p[327] || !p[234] || !p[454]) return null
  const span = Math.hypot(p[454].x - p[234].x, p[454].y - p[234].y)
  if (span < 1e-5) return null
  return { left: (p[1].y - p[327].y) / span, right: (p[1].y - p[98].y) / span }
}
export function noseControls(
  p: readonly Point3[],
  shapes: BlendshapeScores,
  base: NoseCalibration | undefined,
  confidence: number,
  poseDelta = 0,
): NoseControlFrame {
  const geometry = measureNoseGeometry(p),
    dead = 0.025 + 0.1 * Math.min(1, Math.abs(poseDelta) / 0.26)
  const side = (s: "left" | "right") => {
    const raw = shapes[s === "left" ? "noseSneerLeft" : "noseSneerRight"]
    const score =
      typeof raw === "number"
        ? Math.max(
            0,
            (raw - (base?.shapes[s] ?? 0) - dead) /
              Math.max(0.25, 1 - (base?.shapes[s] ?? 0) - dead),
          )
        : 0
    const local =
      geometry && base ? Math.max(0, (geometry[s] - base[s]) / 0.035) : 0
    // Geometry can support a weak score, but cannot manufacture a sneer when
    // the installed model doesn't expose one. No pose is synthesized here.
    return Math.min(
      1,
      typeof raw === "number"
        ? Math.max(score, Math.min(local, score + 0.15))
        : 0,
    )
  }
  return {
    sneerLeft: side("left"),
    sneerRight: side("right"),
    geometry,
    confidence: geometry ? Math.max(0, Math.min(1, confidence)) : 0,
    supported: {
      left: typeof shapes.noseSneerLeft === "number",
      right: typeof shapes.noseSneerRight === "number",
    },
  }
}
