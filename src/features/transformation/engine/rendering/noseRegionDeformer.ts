import type { NoseControlFrame } from "../noseControls"
import type { Point3 } from "../faceTypes"
import type { SourceFaceMeshData } from "./sourceMesh"
/** Small nostril fields only. Bridge, tip and rigid head perspective are fixed. */
export class NoseRegionDeformer {
  private readonly weights: Float32Array
  private readonly width: number
  constructor(mesh: SourceFaceMeshData, p: readonly Point3[]) {
    p = mesh.localLandmarks ?? p
    this.width = Math.max(
      0.01,
      Math.hypot(p[327]!.x - p[98]!.x, p[327]!.y - p[98]!.y),
    )
    this.weights = new Float32Array((mesh.positions.length / 3) * 2)
    const fixed = new Set([1, 2, 4, 5, 6, 168, 195, 197])
    for (let i = 0; i < Math.min(468, mesh.positions.length / 3); i++) {
      if (fixed.has(i)) continue
      for (const [side, anchor] of [327, 98].entries()) {
        const x = mesh.positions[i * 3]!,
          y = -mesh.positions[i * 3 + 1]!
        const d = Math.hypot(
          (x - p[anchor]!.x) / (this.width * 0.4),
          (y - p[anchor]!.y) / (this.width * 0.45),
        )
        const t = Math.max(0, 1 - d)
        this.weights[i * 2 + side] = t * t * (3 - 2 * t)
      }
    }
  }
  apply(p: Float32Array, n: NoseControlFrame): void {
    for (let i = 0; i < p.length / 3; i++) {
      const l = this.weights[i * 2]! * n.sneerLeft,
        r = this.weights[i * 2 + 1]! * n.sneerRight
      p[i * 3] += (l - r) * this.width * 0.025
      p[i * 3 + 1] += (l + r) * this.width * 0.055
    }
  }
}
