import { expect, test, type Page } from "@playwright/test"

// Controlled input exercises the real Studio scheduler/calibration/controls.
// It proves isolation and mapping, not the physical model's expression accuracy.
const visionMock = `
import { mouthNoseFixture } from '/src/features/transformation/engine/fixtures/mouthNoseRegression.ts';
import { MOUTH_SHAPES } from '/src/features/transformation/engine/mouthControls.ts';
import { Matrix4, Euler, Vector3 } from '/node_modules/three/build/three.module.js';
export async function loadMediaPipeVision(){return {
 FilesetResolver:{forVisionTasks:async()=>({})},
 FaceLandmarker:{createFromOptions:async()=>({detectForVideo(){
  const o=window.__mouthInput??{}, e=new Euler(o.pitch??0,o.yaw??0,o.roll??0,'XYZ');
  const video=document.querySelector('.studio-video'),aspect=video.videoWidth/video.videoHeight;
  const p=mouthNoseFixture(o).map(p=>{const v=new Vector3(p.x-.5,-(p.y-.5),-(p.z+.05)).applyEuler(e).multiplyScalar(.65);return {x:.5+v.x,y:.45-v.y*aspect,z:-v.z};});
  const shapes={...Object.fromEntries([...MOUTH_SHAPES,'noseSneerLeft','noseSneerRight','eyeBlinkLeft','eyeBlinkRight'].map(k=>[k,0])),...o.shapes};
  return {faceLandmarks:[p],faceBlendshapes:[{categories:Object.entries(shapes).map(([categoryName,score])=>({categoryName,score}))}],facialTransformationMatrixes:[{data:new Matrix4().makeRotationFromEuler(e).elements}]};
 },close(){}})},
 PoseLandmarker:{createFromOptions:async()=>({detectForVideo(){const p=Array.from({length:33},()=>({x:.5,y:.7,z:0,visibility:1,presence:1}));p[11]={...p[11],x:.3,y:.72};p[12]={...p[12],x:.7,y:.72};p[23]={...p[23],x:.35,y:.9};p[24]={...p[24],x:.65,y:.9};return {landmarks:[p],worldLandmarks:[]};},close(){}})}
};}
export async function loadThreeRenderer(){return import('/node_modules/three/build/three.module.js');}
export async function loadOpenCv(){throw Error('unused');}
export async function loadComlink(){throw Error('unused');}
`
async function studio(page: Page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5201(?:\/|$))/, (r) =>
    r.abort(),
  )
  await page.addInitScript(() =>
    sessionStorage.setItem("callastar.development-admin", "active"),
  )
  await page.route("**/src/features/transformation/loaders.ts", (r) =>
    r.fulfill({ contentType: "text/javascript", body: visionMock }),
  )
  await page.goto("/admin/studio")
  await page.getByRole("button", { name: "Start camera", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Pause tracking", exact: true }),
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click()
  await expect(page.locator(".studio-calibration-result")).toBeVisible({
    timeout: 30000,
  })
  await page.locator(".mouth-nose-diagnostics > details > summary").click()
  await expect(
    page.locator('[data-mouth-metric="mouthConfidence"] dd'),
  ).toHaveText("1.000")
}
const input = (page: Page, value: unknown) =>
  page.evaluate((value) => {
    ;(window as any).__mouthInput = value
  }, value)
const metric = async (page: Page, key: string) =>
  Number(await page.locator(`[data-mouth-metric="${key}"] dd`).innerText())
const high = (page: Page, key: string, n = 0.9) =>
  expect.poll(() => metric(page, key)).toBeGreaterThan(n)
const low = (page: Page, key: string, n = 0.02) =>
  expect.poll(() => metric(page, key)).toBeLessThan(n)

test("M8.7 Studio jaw progression, independent smile and distinct speech/lip controls", async ({
  page,
}) => {
  await studio(page)
  let previous = -0.01
  for (const jaw of [0, 0.25, 0.5, 0.75, 1]) {
    await input(page, { jaw, shapes: { jawOpen: jaw } })
    await expect.poll(() => metric(page, "jawOpen")).toBeGreaterThan(previous)
    await page.waitForTimeout(300)
    previous = await metric(page, "jawOpen")
    await low(page, "smileLeft")
    await low(page, "smileRight")
  }
  expect(previous).toBeGreaterThan(0.9)
  for (const side of ["Left", "Right"]) {
    await input(page, {
      [side === "Left" ? "leftSmile" : "rightSmile"]: 1,
      shapes: { [`mouthSmile${side}`]: 1 },
    })
    await high(page, `smile${side}`)
    await low(page, `smile${side === "Left" ? "Right" : "Left"}`)
  }
  await input(page, {
    leftSmile: 1,
    rightSmile: 1,
    shapes: { mouthSmileLeft: 1, mouthSmileRight: 1 },
  })
  await high(page, "smileLeft")
  await high(page, "smileRight")
  for (const [shape, key] of [
    ["mouthPucker", "pucker"],
    ["mouthFunnel", "funnel"],
    ["mouthStretchLeft", "stretchLeft"],
    ["mouthPressRight", "pressRight"],
    ["mouthUpperUpLeft", "upperRaiseLeft"],
    ["mouthLowerDownRight", "lowerDownRight"],
    ["mouthFrownLeft", "frownLeft"],
  ] as const) {
    await input(page, { shapes: { [shape]: 1 } })
    await high(page, key)
    await low(page, "jawOpen")
  }
})

test("M8.7 head motion isolates jaw/nose and retains mouth controls plus locked eyes", async ({
  page,
}) => {
  await studio(page)
  await page.locator(".eye-diagnostics > details > summary").click()
  for (const pose of [
    { yaw: 0.3 },
    { yaw: -0.3 },
    { pitch: 0.35 },
    { pitch: -0.35 },
    { yaw: 0.25, pitch: 0.25, roll: 0.2 },
  ]) {
    await input(page, pose)
    await low(page, "jawOpen")
    await low(page, "smileLeft")
    await low(page, "smileRight")
    await low(page, "sneerLeft")
    await low(page, "sneerRight")
    await input(page, {
      ...pose,
      jaw: 0.7,
      leftSmile: 0.8,
      shapes: { jawOpen: 0.7, mouthSmileLeft: 1 },
      eyes: { left: { ratio: 0.25 }, right: { irisX: 0.13 } },
    })
    await high(page, "jawOpen", 0.5)
    await high(page, "smileLeft", 0.55)
    await low(page, "smileRight")
    await expect
      .poll(async () =>
        Number(
          await page.locator('[data-eye-metric="left-blink"] dd').innerText(),
        ),
      )
      .toBeGreaterThan(0.98)
    await expect
      .poll(async () =>
        Number(
          await page.locator('[data-eye-metric="right-gazeX"] dd').innerText(),
        ),
      )
      .toBeGreaterThan(0.8)
  }
  for (const side of ["Left", "Right"]) {
    await input(page, { shapes: { [`noseSneer${side}`]: 1 } })
    await high(page, `sneer${side}`)
    await low(page, `sneer${side === "Left" ? "Right" : "Left"}`)
  }
  console.log(
    "[M8.7 controlled Studio]",
    JSON.stringify(
      await page.evaluate(() =>
        Object.fromEntries(
          Array.from(document.querySelectorAll("[data-metric]")).map((d) => [
            d.getAttribute("data-metric"),
            d.querySelector("dd")?.textContent,
          ]),
        ),
      ),
    ),
  )
})

test("M8.7 developer mouth/nose sequence fits mobile widths with eye diagnostics active", async ({
  page,
}) => {
  await studio(page)
  await page.locator(".eye-diagnostics > details > summary").click()
  await page.getByText("Mouth / Nose sequence A–S", { exact: true }).click()
  await page.getByRole("button", { name: "Start mouth sequence" }).click()
  await expect(
    page.locator('.mouth-nose-diagnostics [role="status"]'),
  ).toHaveText("A: Neutral")
  await page.getByRole("button", { name: "Next mouth test" }).click()
  await expect(
    page.locator('.mouth-nose-diagnostics [role="status"]'),
  ).toContainText("B: Jaw")
  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 844 })
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)
  }
  await page.getByRole("button", { name: "Reset mouth sequence" }).click()
  await expect(
    page.getByRole("button", { name: "Next mouth test" }),
  ).toBeDisabled()
})

test("M8.7 real portrait: progressive jaw, source teeth/UVs, shapes, nose pose and protected eyes", async ({
  page,
}) => {
  await page.goto("/")
  await page.setViewportSize({ width: 900, height: 1000 })
  await page.evaluate(async () => {
    const [
      { SourceAnalyzer },
      { FaceRenderer },
      { mouthNoseFrame },
      { CalibrationCollector },
      { computeExpressionMotion },
    ] = await Promise.all([
      import("/src/features/transformation/source/sourceAnalyzer.ts"),
      import("/src/features/transformation/engine/rendering/FaceRenderer.ts"),
      import(
        "/src/features/transformation/engine/fixtures/mouthNoseRegression.ts"
      ),
      import("/src/features/transformation/engine/calibrationCollector.ts"),
      import("/src/features/transformation/engine/expressionMotion.ts"),
    ])
    const blob = await (
      await fetch("/media/onboarding/girl-wallpaper.jpg")
    ).blob()
    const asset = {
      kind: "image",
      blob,
      fileName: "portrait.jpg",
      mimeType: "image/jpeg",
      assetId: null,
    }
    const analyzer = new SourceAnalyzer()
    const result = await analyzer.analyze({
      asset,
      profileId: "m87-real-source",
    })
    analyzer.cancel()
    if (!result.ok) throw Error(result.message)
    const c = new CalibrationCollector()
    c.start(
      "face-only",
      {
        cameraFacing: "user",
        trackingWidth: 640,
        trackingHeight: 640,
        mirrored: false,
      },
      0,
    )
    for (let t = 0; t <= 4000 && c.getState().phase !== "ready"; t += 100)
      c.accept(mouthNoseFrame({}, {}, t), null, t)
    const profile = c.getState().profile
    if (!profile) throw Error("calibration failed")
    const canvas = document.createElement("canvas")
    canvas.style.cssText = "width:720px;height:900px;display:block"
    canvas.dataset.testid = "mouth-render"
    document.body.replaceChildren(canvas)
    const expression = { current: null },
      pose = { current: { x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 } },
      stats = { current: null }
    const renderer = new FaceRenderer({
      canvas,
      asset,
      profile: result.profile,
      mirror: "faithful",
      motion: {
        current: {
          tracked: true,
          expression: null,
          upperBody: null,
          head: {
            translationX: 0,
            translationY: 0,
            scaleDelta: 1,
            yawDelta: 0,
            pitchDelta: 0,
            rollDelta: 0,
          },
        },
      },
      manualExpression: expression,
      manualPose: pose,
      onStats: (s) => (stats.current = s),
    })
    await renderer.initialize()
    ;(window as any).__mouthRender = {
      renderer,
      expression,
      pose,
      stats,
      profile,
      mouthNoseFrame,
      computeExpressionMotion,
      canvas,
    }
  })
  const show = async (
    options: unknown = {},
    shapes: Record<string, number> = {},
    pose = { yaw: 0, pitch: 0, roll: 0 },
  ) => {
    await page.evaluate(
      ({ options, shapes, pose }) => {
        const s = (window as any).__mouthRender
        s.expression.current = s.computeExpressionMotion(
          s.mouthNoseFrame(options, shapes, performance.now()),
          s.profile,
        )
        s.pose.current = { x: 0, y: 0, scale: 1, ...pose }
      },
      { options, shapes, pose },
    )
    await page.waitForTimeout(300)
    return page.evaluate(() => {
      const s = (window as any).__mouthRender,
        p = Array.from(s.renderer.deformer.positions) as number[],
        applied = s.renderer.expressionApplied
      const locked = s.renderer.deformer
        .update({ ...applied, mouth: undefined, nose: undefined })
        .slice(510 * 3)
      s.renderer.deformer.update(applied)
      return {
        p,
        locked: Array.from(locked),
        uv: Array.from(s.renderer.geometry.getAttribute("uv").array),
        probe: s.renderer.getProbe(),
        stats: s.stats.current,
      }
    })
  }
  const neutral = await show()
  await page
    .getByTestId("mouth-render")
    .screenshot({ path: test.info().outputPath("mouth-source-neutral.png") })
  let last = neutral.p[13 * 3 + 1]! - neutral.p[14 * 3 + 1]!
  for (const jaw of [0.25, 0.5, 0.75, 1]) {
    const r = await show({ jaw }, { jawOpen: jaw })
    const gap = r.p[13 * 3 + 1]! - r.p[14 * 3 + 1]!
    expect(gap).toBeGreaterThan(last + 0.002)
    last = gap
    expect(r.p.slice(468 * 3, 489 * 3)).toEqual(
      neutral.p.slice(468 * 3, 489 * 3),
    )
    expect(r.uv).toEqual(neutral.uv)
    for (const i of [1, 2, 6, 168, 159, 145, 386, 374])
      expect(r.p.slice(i * 3, i * 3 + 3)).toEqual(
        neutral.p.slice(i * 3, i * 3 + 3),
      )
  }
  await page
    .getByTestId("mouth-render")
    .screenshot({ path: test.info().outputPath("mouth-source-jaw-open.png") })
  const results: Record<string, number[]> = {}
  for (const shape of [
    "mouthPucker",
    "mouthFunnel",
    "mouthStretchLeft",
    "mouthPressLeft",
    "mouthSmileLeft",
    "mouthSmileRight",
  ]) {
    const r = await show({}, { [shape]: 1 })
    results[shape] = r.p
    expect(r.p).not.toEqual(neutral.p)
    expect(r.uv).toEqual(neutral.uv)
    // Preserve the baseline's small smile/cheek contribution to the lower lid.
    // New mouth/nose fields must add exactly zero to the existing eye result.
    expect(r.p.slice(510 * 3)).toEqual(r.locked)
    await page
      .getByTestId("mouth-render")
      .screenshot({ path: test.info().outputPath(`${shape}.png`) })
  }
  expect(results.mouthPucker).not.toEqual(results.mouthFunnel)
  for (const pose of [
    { yaw: 0.3, pitch: 0, roll: 0 },
    { yaw: -0.3, pitch: 0, roll: 0 },
    { yaw: 0, pitch: 0.35, roll: 0 },
    { yaw: 0, pitch: -0.35, roll: 0 },
  ]) {
    const r = await show({ jaw: 0.5 }, { jawOpen: 0.5 }, pose)
    // Judge physical direction after the existing source-safe pose envelope.
    if (pose.yaw) expect(Math.sign(r.probe.nose.x)).toBe(Math.sign(pose.yaw))
    if (pose.pitch)
      expect(Math.sign(r.probe.nose.y)).toBe(Math.sign(pose.pitch))
    for (const i of [1, 2, 6, 168])
      expect(r.p.slice(i * 3, i * 3 + 3)).toEqual(
        neutral.p.slice(i * 3, i * 3 + 3),
      )
    await page
      .getByTestId("mouth-render")
      .screenshot({
        path: test.info().outputPath(`nose-${pose.yaw}-${pose.pitch}.png`),
      })
  }
  const sneer = await show({}, { noseSneerLeft: 1 })
  expect(sneer.p[327 * 3 + 1]).toBeGreaterThan(neutral.p[327 * 3 + 1]!)
  expect(sneer.p[98 * 3 + 1]).toBe(neutral.p[98 * 3 + 1])
  const live = await page.evaluate(async () => {
    const s = (window as any).__mouthRender
    const camera = document.createElement("canvas")
    camera.width = 256
    camera.height = 192
    const c = camera.getContext("2d")!
    c.fillStyle = "#d29682"
    c.fillRect(0, 0, 256, 192)
    c.fillStyle = "#190f14"
    c.beginPath()
    c.ellipse(128, 96, 76.8, 38.4, 0, 0, 2 * Math.PI)
    c.fill()
    c.fillStyle = "white"
    c.fillRect(110, 72, 36, 9)
    c.fillStyle = "#bd2d41"
    c.fillRect(114, 109, 28, 8)
    const stream = camera.captureStream(30),
      video = document.createElement("video")
    video.muted = true
    video.srcObject = stream
    await video.play()
    const ring = Array.from({ length: 20 }, (_, i) => ({
      x: 0.5 - Math.cos((i * Math.PI) / 10) * 0.3,
      y: 0.5 + Math.sin((i * Math.PI) / 10) * 0.2,
    }))
    s.renderer.options.expression = s.expression
    s.renderer.options.liveMouthVideoRef = { current: video }
    s.renderer.options.liveMouthEnabled = { current: true }
    let jaw = 0.6
    const feed = () => {
      s.expression.current = s.computeExpressionMotion(
        s.mouthNoseFrame({ jaw }, { jawOpen: jaw }, performance.now()),
        s.profile,
      )
      s.expression.current.liveMouth.ring = ring
    }
    const timer = setInterval(feed, 33)
    feed()
    await new Promise((r) => setTimeout(r, 800))
    const on = s.renderer.liveMouthOpacity,
      status = s.renderer.mouthMaskStatus,
      compositorMs = s.renderer.mouthCompositorMs
    const p = s.renderer.deformer.positions,
      lp = s.renderer.liveMouthGeometry.getAttribute("position").array
    const { INNER_LIP_RING } = await import(
      "/src/features/transformation/engine/rendering/sourceMesh.ts"
    )
    const error = Math.max(
      ...INNER_LIP_RING.flatMap((anchor, i) => [
        Math.abs(p[anchor * 3] - lp[i * 3]),
        Math.abs(p[anchor * 3 + 1] - lp[i * 3 + 1]),
        Math.abs(p[anchor * 3 + 2] - 0.005 - lp[i * 3 + 2]),
      ]),
    )
    jaw = 0
    await new Promise((r) => setTimeout(r, 800))
    const closed = s.renderer.liveMouthOpacity
    jaw = 0.6
    await new Promise((r) => setTimeout(r, 800))
    clearInterval(timer)
    await new Promise((r) => setTimeout(r, 900))
    const stale = s.renderer.liveMouthOpacity,
      staleStatus = s.renderer.mouthMaskStatus
    stream.getTracks().forEach((t) => t.stop())
    return { on, status, compositorMs, error, closed, stale, staleStatus }
  })
  expect(live.on).toBeGreaterThan(0.98)
  expect(live.status).toBe("ready")
  expect(live.error).toBeLessThan(1e-7)
  expect(live.closed).toBeLessThan(0.02)
  expect(live.stale).toBeLessThan(0.02)
  expect(live.staleStatus).toBe("stale")
  console.log("[M8.7 live compositor]", JSON.stringify(live))
  console.log(
    "[M8.7 desktop renderer]",
    JSON.stringify(
      await page.evaluate(() => {
        const s = (window as any).__mouthRender,
          gl = s.canvas.getContext("webgl2"),
          ext = gl.getExtension("WEBGL_debug_renderer_info")
        return {
          graphics: ext
            ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
          ...s.stats.current,
          expressionTrace: undefined,
          expressionRequested: undefined,
          expressionApplied: undefined,
          expressionLimits: undefined,
        }
      }),
    ),
  )
  await page.evaluate(() => (window as any).__mouthRender.renderer.dispose())
})

test("M8.7 closed-source rig renders an opening cavity without background holes", async ({
  page,
}) => {
  await page.goto("/")
  const report = await page.evaluate(async () => {
    const [
      { SourceAnalyzer },
      { FaceRenderer },
      { mouthNoseFixture },
      { measureMouthControls, measureMouthGeometry },
      { NEUTRAL_EXPRESSION },
    ] = await Promise.all([
      import("/src/features/transformation/source/sourceAnalyzer.ts"),
      import("/src/features/transformation/engine/rendering/FaceRenderer.ts"),
      import(
        "/src/features/transformation/engine/fixtures/mouthNoseRegression.ts"
      ),
      import("/src/features/transformation/engine/mouthControls.ts"),
      import("/src/features/transformation/engine/expressionMotion.ts"),
    ])
    const blob = await (
        await fetch("/media/onboarding/male-participant.jpg")
      ).blob(),
      analyzer = new SourceAnalyzer()
    const result = await analyzer.analyze({
      asset: {
        kind: "image",
        blob,
        fileName: "p.jpg",
        mimeType: "image/jpeg",
        assetId: null,
      },
      profileId: "closed-rig-template",
    })
    analyzer.cancel()
    if (!result.ok) throw Error(result.message)
    // Explicit synthetic closed source: no photographed hidden anatomy is claimed.
    const source = document.createElement("canvas")
    source.width = source.height = 512
    const ctx = source.getContext("2d")!
    ctx.fillStyle = "#d29682"
    ctx.fillRect(0, 0, 512, 512)
    ctx.strokeStyle = "#912638"
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.moveTo(0.41 * 512, 0.67 * 512)
    ctx.lineTo(0.59 * 512, 0.67 * 512)
    ctx.stroke()
    const pixels = await new Promise<Blob>((resolve) =>
      source.toBlob((b) => resolve(b!), "image/png"),
    )
    const points = result.profile.primaryFace.landmarks.map((p) => ({ ...p }))
    const { INNER_LIP_RING } = await import(
      "/src/features/transformation/engine/rendering/sourceMesh.ts"
    )
    const left = points[78]!,
      right = points[308]!
    for (const i of INNER_LIP_RING) {
      const t = (points[i]!.x - left.x) / (right.x - left.x)
      points[i]!.y = left.y + (right.y - left.y) * t
      points[i]!.z = left.z + (right.z - left.z) * t
    }
    const profile = {
      ...result.profile,
      dimensions: { width: 512, height: 512, aspectRatio: 1 },
      primaryFace: { ...result.profile.primaryFace, landmarks: points },
      expression: { ...result.profile.expression, mouthOpen: 0 },
    }
    const canvas = document.createElement("canvas")
    canvas.style.cssText = "width:600px;height:600px"
    document.body.replaceChildren(canvas)
    const expression = {
      current: {
        ...NEUTRAL_EXPRESSION,
        status: "tracked",
        calculationMs: 0,
        mouth: measureMouthControls(
          points,
          {},
          { geometry: measureMouthGeometry(points)!, shapes: {} },
          0,
          1,
          0,
        ),
      },
    }
    const renderer = new FaceRenderer({
      canvas,
      asset: {
        kind: "image",
        blob: pixels,
        fileName: "synthetic-closed.png",
        mimeType: "image/png",
        assetId: null,
      },
      profile,
      manualExpression: expression,
      motion: {
        current: {
          tracked: true,
          upperBody: null,
          expression: null,
          head: {
            translationX: 0,
            translationY: 0,
            scaleDelta: 1,
            yawDelta: 0,
            pitchDelta: 0,
            rollDelta: 0,
          },
        },
      },
    })
    await renderer.initialize()
    const gl = canvas.getContext("webgl2")!
    const sample = () => {
      ;(renderer as any).renderer.render(
        (renderer as any).scene,
        (renderer as any).camera,
      )
      const data = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      )
      let dark = 0
      for (let k = 0; k < data.length; k += 4)
        if (
          data[k]! > 20 &&
          data[k]! < 100 &&
          data[k + 1]! < 30 &&
          data[k + 2]! < 40
        )
          dark++
      return dark
    }
    await new Promise((r) => setTimeout(r, 300))
    const neutral = sample(),
      gaps = []
    for (const jaw of [0.25, 0.5, 0.75, 1]) {
      expression.current.mouth = measureMouthControls(
        points,
        {},
        { geometry: measureMouthGeometry(points)!, shapes: {} },
        jaw,
        1,
        0,
      )
      await new Promise((r) => setTimeout(r, 200))
      const p = (renderer as any).deformer.positions
      gaps.push(p[13 * 3 + 1] - p[14 * 3 + 1])
    }
    const open = sample()
    const p = (renderer as any).deformer.positions,
      m = (renderer as any).mesh
    const { Vector3 } = await import(
      "/node_modules/three/build/three.module.js"
    )
    m.updateMatrixWorld(true)
    const point = new Vector3(
      (p[13 * 3] + p[14 * 3]) / 2,
      (p[13 * 3 + 1] + p[14 * 3 + 1]) / 2,
      (p[13 * 3 + 2] + p[14 * 3 + 2]) / 2,
    )
      .applyMatrix4(m.matrixWorld)
      .project((renderer as any).camera)
    // The dynamic import above yielded: redraw before reading the transient
    // WebGL buffer (preserveDrawingBuffer is intentionally disabled).
    ;(renderer as any).renderer.render(
      (renderer as any).scene,
      (renderer as any).camera,
    )
    const center = new Uint8Array(4)
    gl.readPixels(
      Math.round(((point.x + 1) * canvas.width) / 2),
      Math.round(((point.y + 1) * canvas.height) / 2),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      center,
    )
    renderer.dispose()
    return { neutral, open, gaps, center: Array.from(center) }
  })
  expect(report.open).toBeGreaterThan(report.neutral + 100)
  for (let i = 1; i < report.gaps.length; i++)
    expect(report.gaps[i]).toBeGreaterThan(report.gaps[i - 1]! + 0.005)
  expect(report.center.slice(0, 3)).not.toEqual([15, 23, 42])
  expect(report.center[3]).toBe(255)
})

test("M8.7 live interior rejects collapsed/nonfinite masks and preserves tooth aspect", async ({
  page,
}) => {
  await page.goto("/")
  const report = await page.evaluate(async () => {
    const { drawWarpedMouth, mouthTextureTarget } = await import(
      "/src/features/transformation/engine/rendering/liveMouthCompositor.ts"
    )
    const ring = Array.from({ length: 20 }, (_, i) => ({
      x: 0.5 - Math.cos((i * Math.PI) / 10) * 0.3,
      y: 0.5 + Math.sin((i * Math.PI) / 10) * 0.2,
    }))
    const source = document.createElement("canvas")
    source.width = 256
    source.height = 192
    const c = source.getContext("2d")!
    c.fillStyle = "#dc9682"
    c.fillRect(0, 0, 256, 192)
    c.fillStyle = "#190f14"
    c.beginPath()
    c.ellipse(128, 96, 76.8, 38.4, 0, 0, 2 * Math.PI)
    c.fill()
    c.fillStyle = "white"
    c.fillRect(110, 72, 36, 9)
    c.fillStyle = "#bd2d41"
    c.fillRect(114, 109, 28, 8)
    const out = document.createElement("canvas")
    out.width = 256
    out.height = 128
    const ctx = out.getContext("2d", { willReadFrequently: true })!
    const target = mouthTextureTarget(ring, 256, 192, 256, 128),
      drawn = drawWarpedMouth(ctx, source, ring, target, 256, 128, 256, 192)
    const data = ctx.getImageData(0, 0, 256, 128).data
    let x0 = 256,
      y0 = 128,
      x1 = 0,
      y1 = 0,
      skin = 0,
      tongue = 0
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 256; x++) {
        const k = (y * 256 + x) * 4
        if (data[k + 3]! > 250) {
          if (data[k]! > 240 && data[k + 1]! > 240 && data[k + 2]! > 240) {
            x0 = Math.min(x, x0)
            y0 = Math.min(y, y0)
            x1 = Math.max(x, x1)
            y1 = Math.max(y, y1)
          }
          if (data[k] === 220 && data[k + 1] === 150) skin++
          if (data[k]! > 150 && data[k + 1]! < 70 && data[k + 2]! < 100)
            tongue++
        }
      }
    const collapsed = drawWarpedMouth(
      ctx,
      source,
      ring.map((p) => ({ ...p, y: 0.5 })),
      target,
      256,
      128,
      256,
      192,
    )
    const invalid = drawWarpedMouth(
      ctx,
      source,
      [{ x: NaN, y: 0 }, ...ring.slice(1)],
      target,
      256,
      128,
      256,
      192,
    )
    return {
      drawn,
      collapsed,
      invalid,
      aspect: (x1 - x0 + 1) / (y1 - y0 + 1),
      skin,
      tongue,
    }
  })
  expect(report.drawn).toBe(true)
  expect(report.collapsed).toBe(false)
  expect(report.invalid).toBe(false)
  expect(report.aspect).toBeGreaterThan(3.6)
  expect(report.aspect).toBeLessThan(4.4)
  expect(report.skin).toBe(0)
  expect(report.tongue).toBeGreaterThan(10)
})
