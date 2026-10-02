import type { MouthControlFrame } from "../mouthControls"
import type { Point3 } from "../faceTypes"
import {
  INNER_LIP_RING,
  OUTER_LIP_RING,
  type SourceFaceMeshData,
} from "./sourceMesh"
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const fade = (v: number) => {
  const t = clamp(1 - v)
  return t * t * (3 - 2 * t)
}
const NOSE_FIXED = new Set([
  1, 2, 4, 5, 6, 19, 45, 48, 64, 94, 97, 98, 115, 168, 195, 197, 220, 275, 278,
  294, 326, 327, 344, 440,
])
/** Precomputed mouth-local fields. No eye surface, topology or UV writes. */
export class MouthRegionDeformer {
  private readonly fields: Float32Array
  private readonly inner: Uint8Array
  private readonly lipRing: Uint8Array
  private readonly width: number
  private readonly faceWidth: number
  private readonly ux: number
  private readonly uy: number
  private readonly vx: number
  private readonly vy: number
  constructor(
    private readonly mesh: SourceFaceMeshData,
    points: readonly Point3[],
  ) {
    points = mesh.localLandmarks ?? points
    const a = points[61]!,
      b = points[291]!,
      upper = points[13]!,
      lower = points[14]!
    this.width = Math.max(0.006, Math.hypot(b.x - a.x, b.y - a.y))
    this.ux = (b.x - a.x) / this.width
    this.uy = (b.y - a.y) / this.width
    this.vx = -this.uy
    this.vy = this.ux
    this.faceWidth = Math.max(
      0.01,
      Math.hypot(
        points[454]!.x - points[234]!.x,
        points[454]!.y - points[234]!.y,
      ),
    )
    const cx = (a.x + b.x) / 2,
      cy = (upper.y + lower.y) / 2
    const upperRing = new Set<number>(INNER_LIP_RING.slice(11)),
      lowerRing = new Set<number>(INNER_LIP_RING.slice(1, 10))
    for (const i of [0, 37, 39, 40, 185, 267, 269, 270, 409]) upperRing.add(i)
    for (const i of [17, 84, 91, 146, 181, 314, 321, 375, 405]) lowerRing.add(i)
    this.fields = new Float32Array((mesh.positions.length / 3) * 8)
    this.inner = new Uint8Array(mesh.positions.length / 3)
    this.lipRing = new Uint8Array(mesh.positions.length / 3)
    for (const index of INNER_LIP_RING) this.inner[index] = 1
    for (const index of [...INNER_LIP_RING,...OUTER_LIP_RING]) this.lipRing[index] = 1
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if (
        NOSE_FIXED.has(i) ||
        i >= (mesh.eyeInterior?.start ?? Infinity) ||
        (mesh.mouth &&
          i >= mesh.mouth.fillStart &&
          i < mesh.mouth.fillStart + mesh.mouth.fillCount)
      )
        continue
      const x = mesh.positions[i * 3]!,
        y = -mesh.positions[i * 3 + 1]!
      const s = ((x - cx) * this.ux + (y - cy) * this.uy) / this.width
      const t = ((x - cx) * this.vx + (y - cy) * this.vy) / this.width
      // Hard upper boundary is below the nose; smooth fields fade before it.
      if (
        y <
        Math.max(points[2]?.y ?? cy - this.width * 0.4, cy - this.width * 0.4)
      )
        continue
      const lip = fade(Math.hypot(s / 0.85, t / 0.48))
      const lower = lowerRing.has(i)
        ? 1
        : upperRing.has(i)
          ? 0
          : clamp(0.5 + t / 0.16)
      const chin = fade(
        Math.hypot(
          (x - points[152]!.x) / (this.faceWidth * 0.46),
          (y - points[152]!.y) / (this.faceWidth * 0.42),
        ),
      )
      const w = i * 8
      this.fields[w] = s
      this.fields[w + 1] = t
      this.fields[w + 2] = lip
      this.fields[w + 3] = lower
      this.fields[w + 4] = chin
      this.fields[w + 5] = fade(Math.hypot((s - 0.5) / 0.48, t / 0.4)) // anatomical left
      this.fields[w + 6] = fade(Math.hypot((s + 0.5) / 0.48, t / 0.4))
      this.fields[w + 7] = 1
    }
  }
  apply(positions: Float32Array, m: MouthControlFrame): void {
    const width = this.width
    for (let i = 0; i < positions.length / 3; i++) {
      const w = i * 8
      if (!this.fields[w + 7]) continue
      const s = this.fields[w]!,
        t = this.fields[w + 1]!,
        lip = this.fields[w + 2]!,
        lo = this.fields[w + 3]!,
        chin = this.fields[w + 4]!
      const left = this.fields[w + 5]!,
        right = this.fields[w + 6]!,
        up = 1 - lo
      const press = Math.max(
        m.lips.pressLeft * clamp(0.5 + s) + m.lips.pressRight * clamp(0.5 - s),
        Math.max(
          0,
          m.shape.compressed - Math.max(m.lips.pressLeft, m.lips.pressRight),
        ),
      )
      const narrow = Math.max(m.lips.pucker, m.lips.funnel)
      // Progressive separation from a seam, not scaling an existing gap.
      let dv =
        m.jaw.open *
        (lip * (lo * 0.42 - up * 0.055) * width + chin * this.faceWidth * 0.13)
      dv += m.lips.funnel * lip * (lo * 0.12 - up * 0.09) * width
      dv +=
        (m.lips.lowerDownLeft * left + m.lips.lowerDownRight * right) *
        lo *
        width *
        0.14
      dv -=
        (m.lips.upperRaiseLeft * left + m.lips.upperRaiseRight * right) *
        up *
        width *
        0.12
      dv -=
        (m.corners.smileLeft * left + m.corners.smileRight * right) *
        width *
        0.16
      dv +=
        (m.corners.frownLeft * left + m.corners.frownRight * right) *
        width *
        0.12
      // Press contracts the aperture to its meeting line, including a source
      // photographed with parted lips. It is distinct from relaxed closure.
      dv -= t * width * press * (this.inner[i] ? 1 : lip)
      // The old generic falloff left only ~11% narrowing at the corners.
      // Measured lip-ring membership gives the full 38% pursing excursion,
      // with a bounded transition through surrounding source tissue.
      const shapeWeight = this.lipRing[i] ? 1 : lip
      let du = -s * width * narrow * 0.38 * shapeWeight
      // Central source vermilion rounds/prominently advances even with a closed
      // jaw. This separates a kiss from neutral closure without opening the jaw.
      const central = Math.max(0, 1-Math.abs(s)*2)
      if (!this.inner[i]) dv += m.lips.pucker * shapeWeight * central * (lo-up) * width * .025
      du +=
        (m.lips.stretchLeft * left - m.lips.stretchRight * right) * width * 0.13
      du +=
        (m.corners.smileLeft * left - m.corners.smileRight * right) *
        width *
        0.08
      du -=
        (m.corners.dimpleLeft * left - m.corners.dimpleRight * right) *
        width *
        0.04
      du += (m.jaw.left - m.jaw.right) * chin * width * 0.12
      positions[i * 3] += du * this.ux + dv * this.vx
      positions[i * 3 + 1] -= du * this.uy + dv * this.vy
      positions[i * 3 + 2] +=
        shapeWeight * width * (m.lips.pucker * (0.04 + central*.06) + m.lips.funnel * 0.035) -
        lip * width * (m.lips.rollUpper * up + m.lips.rollLower * lo) * 0.025 +
        chin * m.jaw.forward * width * 0.04
    }
    const mouth = this.mesh.mouth
    if (!mouth) return
    // Cavity follows the exact source outer contour. The source-visible fill
    // remains pinned, preserving the photograph's teeth instead of stretching.
    let x = 0,
      y = 0,
      z = 0
    for (const [k, anchor] of OUTER_LIP_RING.entries()) {
      const p = (mouth.cavityStart + k) * 3,
        a = anchor * 3
      const setback = this.mesh.positions[p + 2]! - this.mesh.positions[a + 2]!
      positions[p] = positions[a]!
      positions[p + 1] = positions[a + 1]!
      positions[p + 2] = positions[a + 2]! + setback
      x += positions[p]!
      y += positions[p + 1]!
      z += positions[p + 2]!
    }
    const centre = (mouth.cavityStart + OUTER_LIP_RING.length) * 3,
      n = OUTER_LIP_RING.length
    positions[centre] = x / n
    positions[centre + 1] = y / n
    positions[centre + 2] = z / n
  }
}

