import { describe, expect, it } from "vitest"
import { perioralRegion } from "./liveMouthCompositor"

describe("transform-locked perioral region", () => {
  it("pads the MediaPipe outer-lip contour by mouth and face dimensions", () => {
    const ring = [
      { x: 0.35, y: 0.5 },
      { x: 0.4, y: 0.46 },
      { x: 0.5, y: 0.45 },
      { x: 0.6, y: 0.46 },
      { x: 0.65, y: 0.5 },
      { x: 0.6, y: 0.54 },
      { x: 0.5, y: 0.55 },
      { x: 0.4, y: 0.54 },
    ]
    const region = perioralRegion(ring, 320, 240, 160)

    expect(region).not.toBeNull()
    expect(region!.bounds.minX).toBeCloseTo(320 * 0.35 - 96 * 0.08)
    expect(region!.bounds.maxX).toBeCloseTo(320 * 0.65 + 96 * 0.08)
    expect(region!.bounds.minY).toBeCloseTo(240 * 0.45 - 160 * 0.03)
    expect(region!.bounds.maxY).toBeCloseTo(240 * 0.55 + 160 * 0.035)
    expect(region!.sigma).toBe(1.5)
    expect(region!.expanded).toHaveLength(ring.length)
  })

  it("rejects collapsed, unreasonable, and out-of-frame mouth geometry", () => {
    const collapsed = Array.from({ length: 8 }, () => ({ x: 0.5, y: 0.5 }))
    expect(perioralRegion(collapsed, 320, 240, 160)).toBeNull()
    expect(
      perioralRegion(
        [
          { x: -0.02, y: 0.5 },
          { x: 0.08, y: 0.48 },
          { x: 0.08, y: 0.52 },
        ],
        320,
        240,
        160,
      ),
    ).toBeNull()
  })
})
