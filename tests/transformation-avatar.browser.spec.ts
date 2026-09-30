import { expect, test } from "@playwright/test";

/**
 * The 3D avatar path, end to end, against a real GLB.
 *
 * The fixture is GENERATED in the browser rather than committed: a mesh with
 * named morph targets and a small bone chain is built with Three.js, exported
 * through `GLTFExporter`, and the resulting ArrayBuffer is fed to the analyzer as
 * a file would be. That keeps a binary asset out of the repository, makes the rig
 * deterministic, and — because it goes through a real exporter — exercises the
 * real loader rather than a hand-rolled approximation.
 *
 * Two rigs are built: one with facial morphs and a head bone, and one bare mesh
 * with neither, because the milestone's central requirement is that the three
 * model classes are reported honestly.
 */

/**
 * The fixture module, served and transformed by Vite.
 *
 * Imported by path from inside the page rather than inlined, because a bare
 * `import("three")` evaluated in the browser cannot be resolved — nothing has
 * rewritten the specifier. Vite rewrites it for a module it serves.
 */
const FIXTURE_MODULE = "/tests/fixtures/avatarFixture.ts";

const DEV_SESSION_KEY = "callastar.development-admin";

test.describe("3D model analysis", () => {
  test("classifies a rigged head and reports its capabilities honestly", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/");

    const report = await page.evaluate(
      async (fixtureModule) => {
        const { buildAvatarFixtures, fixtureFile } = await import(/* @vite-ignore */ fixtureModule);
        const fixtures = await buildAvatarFixtures();
        const makeFile = fixtureFile;
        const { analyzeAvatarModel, disposeAvatarScene } = await import(
          "/src/features/transformation/avatar/modelAnalyzer.ts"
        );

        const riggedFile = makeFile(fixtures.rigged, "rigged-head.glb");
        const rigged = await analyzeAvatarModel({
          blob: riggedFile,
          fileName: riggedFile.name,
          profileId: "probe",
        });

        const staticFile = makeFile(fixtures.static, "static-head.glb");
        const plain = await analyzeAvatarModel({
          blob: staticFile,
          fileName: staticFile.name,
          profileId: "probe",
        });

        const summarise = (result: Awaited<ReturnType<typeof analyzeAvatarModel>>) => {
          if (!result.ok) return { ok: false as const, failure: result.failure };
          const profile = result.model.profile;
          disposeAvatarScene(result.model.scene);
          return {
            ok: true as const,
            rigClass: profile.rigClass,
            meshCount: profile.meshCount,
            vertexCount: profile.vertexCount,
            hasSkeleton: profile.hasSkeleton,
            headBoneName: profile.headBoneName,
            jawBoneName: profile.jawBoneName,
            morphTargetNames: profile.morphTargetNames,
            mappedKeys: Object.keys(profile.mappedMorphs).sort(),
            unmapped: profile.unmappedMorphNames,
            capabilities: profile.capabilities,
            warnings: profile.warnings,
            pivotSource: profile.normalization.pivotSource,
            normalizationScale: profile.normalization.scale,
            boundsSize: profile.bounds.size,
          };
        };

        return { rigged: summarise(rigged), plain: summarise(plain) };
      },
      FIXTURE_MODULE,
    );

    expect(report.rigged.ok, `rigged analysis failed: ${JSON.stringify(report.rigged)}`).toBe(true);
    expect(report.plain.ok, `static analysis failed: ${JSON.stringify(report.plain)}`).toBe(true);
    if (!report.rigged.ok || !report.plain.ok) return;

    console.log(
      [
        "",
        "──────── 3D model analysis ────────",
        `rigged: ${report.rigged.rigClass} · ${report.rigged.meshCount} mesh · ${report.rigged.vertexCount} verts`,
        `  morphs ${report.rigged.morphTargetNames.length} · mapped [${report.rigged.mappedKeys.join(", ")}]`,
        `  head bone ${report.rigged.headBoneName ?? "—"} · jaw bone ${report.rigged.jawBoneName ?? "—"}`,
        `  pivot ${report.rigged.pivotSource} · scale ${report.rigged.normalizationScale.toFixed(3)}`,
        `  warnings [${report.rigged.warnings.join(", ")}]`,
        `static: ${report.plain.rigClass} · warnings [${report.plain.warnings.join(", ")}]`,
        "",
      ].join(String.fromCharCode(10)),
    );

    // Class A: rigged with facial morphs.
    expect(report.rigged.rigClass).toBe("rigged-facial");
    expect(report.rigged.hasSkeleton).toBe(true);
    // `Neck` is also present, so this is the discovery rule working, not luck.
    expect(report.rigged.headBoneName).toBe("Head");
    expect(report.rigged.jawBoneName).toBe("Jaw");
    // The pivot must come from the head bone, not the scene box — otherwise a
    // model turns about its chest.
    expect(report.rigged.pivotSource).toBe("head-bone");

    // Every expression CallaStar drives was discovered, by name.
    for (const key of [
      "blinkLeft",
      "blinkRight",
      "jawOpen",
      "smileLeft",
      "smileRight",
      "browInnerUp",
      "browOuterUpLeft",
      "browOuterUpRight",
    ]) {
      expect(report.rigged.capabilities.expressions[key], key).toBe(true);
    }

    // Class C: static. Head motion only, and it says so.
    expect(report.plain.rigClass).toBe("static");
    expect(report.plain.capabilities.headPose).toBe(true);
    expect(report.plain.capabilities.expressions.blinkLeft).toBe(false);
    expect(report.plain.warnings).toContain("no-morph-targets");
    expect(report.plain.warnings).toContain("no-skeleton");
  });

  test("refuses a file that is not a model, without breaking the runtime", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");

    const report = await page.evaluate(async () => {
      const { analyzeAvatarModel } = await import("/src/features/transformation/avatar/modelAnalyzer.ts");
      const junk = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "broken.glb", {
        type: "model/gltf-binary",
      });
      const result = await analyzeAvatarModel({ blob: junk, fileName: junk.name, profileId: "probe" });
      return { ok: result.ok, failure: result.ok ? null : result.failure };
    });

    expect(report.ok).toBe(false);
    expect(report.failure).toBe("parse-failed");
  });
});

test.describe("avatar rendering", () => {
  test("renders frames and follows physical head movement", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/");

    const report = await page.evaluate(
      async (fixtureModule) => {
        const { buildAvatarFixtures, fixtureFile } = await import(/* @vite-ignore */ fixtureModule);
        const fixtures = await buildAvatarFixtures();
        const makeFile = fixtureFile;

        const [{ analyzeAvatarModel }, { ThreeAvatarRenderer }, { avatarMotionFromTracking }] =
          await Promise.all([
            import("/src/features/transformation/avatar/modelAnalyzer.ts"),
            import("/src/features/transformation/avatar/ThreeAvatarRenderer.ts"),
            import("/src/features/transformation/avatar/avatarMotion.ts"),
          ]);

        const file = makeFile(fixtures.rigged, "rigged-head.glb");
        const analysis = await analyzeAvatarModel({ blob: file, fileName: file.name, profileId: "probe" });
        if (!analysis.ok) return { ok: false as const, failure: analysis.failure };

        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 480;
        canvas.style.width = "480px";
        canvas.style.height = "480px";
        document.body.appendChild(canvas);

        const head = (overrides: Record<string, number>) => ({
          head: {
            translationX: 0,
            translationY: 0,
            scaleDelta: 1,
            yawDelta: 0,
            pitchDelta: 0,
            rollDelta: 0,
            ...overrides,
          },
          expression: null,
          upperBody: null,
          tracked: true,
        });

        const motion = { current: avatarMotionFromTracking({ motion: null, expression: null, calibrated: false }) };
        const manual = { current: null as ReturnType<typeof avatarMotionFromTracking> | null };

        let stats: Record<string, unknown> | null = null;
        const renderer = new ThreeAvatarRenderer({
          canvas,
          model: analysis.model,
          motion,
          manualMotion: manual,
          mirror: "selfie",
          onStats: (next) => {
            stats = next as unknown as Record<string, unknown>;
          },
        });

        await renderer.initialize();

        const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

        /*
         * Pixels are NOT sampled here, deliberately.
         *
         * A WebGL drawing buffer is undefined after compositing unless the context
         * was created with `preserveDrawingBuffer`, which production does not set
         * because it costs a full-buffer copy every frame. Reading it back gave a
         * uniform zero — a measurement artefact, not a black render.
         *
         * So the proof that frames are real is the renderer's own frame and fps
         * counters, and the proof that the MODEL is driven is the morph
         * influences and applied head values read straight off the scene.
         */
        const sample = () => 0;

        const probe = async (overrides: Record<string, number>) => {
          motion.current = avatarMotionFromTracking({
            motion: head(overrides),
            expression: null,
            calibrated: true,
          });
          await settle();
          return { brightness: sample(), applied: (stats as Record<string, unknown> | null)?.appliedHead };
        };

        const neutral = await probe({});
        const turnRight = await probe({ yawDelta: -0.35 });
        const turnLeft = await probe({ yawDelta: 0.35 });
        const lookUp = await probe({ pitchDelta: 0.25 });
        const lookDown = await probe({ pitchDelta: -0.25 });
        const tiltRight = await probe({ rollDelta: 0.2 });
        const closer = await probe({ scaleDelta: 1.2 });

        // Manual rig sliders, through the SAME adapter the camera uses.
        motion.current = avatarMotionFromTracking({ motion: head({}), expression: null, calibrated: true });
        manual.current = {
          head: motion.current.head,
          face: {
            blinkLeft: 1,
            blinkRight: 0,
            jawOpen: 0,
            smileLeft: 0,
            smileRight: 0,
            browInnerUp: 0,
            browOuterUpLeft: 0,
            browOuterUpRight: 0,
          },
          tracking: { faceTracked: true, calibrated: true, quality: null },
        };
        await settle();
        const blinkLeftOnly = {
          influences: analysis.model.scene.getObjectByName("HeadMesh") as unknown as {
            morphTargetInfluences?: number[];
          },
        };
        const blinkInfluences = [...(blinkLeftOnly.influences.morphTargetInfluences ?? [])];

        manual.current = {
          ...manual.current,
          face: { ...manual.current.face, blinkLeft: 0, jawOpen: 1 },
        };
        await settle();
        const jawInfluences = [...(blinkLeftOnly.influences.morphTargetInfluences ?? [])];

        const frames = (stats as Record<string, unknown> | null)?.frames as number | undefined;
        const fps = (stats as Record<string, unknown> | null)?.fps as number | null | undefined;

        renderer.dispose();
        canvas.remove();

        return {
          ok: true as const,
          neutral,
          turnRight,
          turnLeft,
          lookUp,
          lookDown,
          tiltRight,
          closer,
          blinkInfluences,
          jawInfluences,
          frames: frames ?? 0,
          fps: fps ?? null,
          disposedStatus: renderer.getOutputCanvas() === canvas,
        };
      },
      FIXTURE_MODULE,
    );

    expect(report.ok, `render harness failed: ${JSON.stringify(report)}`).toBe(true);
    if (!report.ok) return;

    console.log(
      [
        "",
        "──────── 3D avatar rendering ────────",
        `frames ${report.frames} · fps ${report.fps?.toFixed(1) ?? "—"}`,
        `applied yaw right ${(report.turnRight.applied as Record<string, number>).yaw.toFixed(3)} · left ${(report.turnLeft.applied as Record<string, number>).yaw.toFixed(3)}`,
        `blink influences [${report.blinkInfluences.map((v) => v.toFixed(2)).join(", ")}]`,
        `jaw influences   [${report.jawInfluences.map((v) => v.toFixed(2)).join(", ")}]`,
        "",
      ].join(String.fromCharCode(10)),
    );

    // The loop is genuinely running rather than stalled after one frame.
    expect(report.frames).toBeGreaterThan(10);
    expect(report.fps ?? 0).toBeGreaterThan(10);

    // Head direction, as applied to the model.
    const applied = (probe: typeof report.neutral) => probe.applied as Record<string, number> | undefined;
    expect(applied(report.turnRight)!.yaw).toBeLessThan(-0.05);
    expect(applied(report.turnLeft)!.yaw).toBeGreaterThan(0.05);
    // Pitch is inverted exactly once, upstream, so a physical look up is negative
    // rotation.x — see `rendererMotion.ts`.
    expect(applied(report.lookUp)!.pitch).toBeLessThan(-0.05);
    expect(applied(report.lookDown)!.pitch).toBeGreaterThan(0.05);
    expect(applied(report.tiltRight)!.roll).toBeGreaterThan(0.05);
    expect(applied(report.closer)!.scale).toBeGreaterThan(1);

    /*
     * Manual blink drove ONLY the left eyelid morph.
     *
     * Index 0 is eyeBlinkLeft and index 1 is eyeBlinkRight in the fixture, so
     * this is also the independence check: a rig mapping that crossed the sides
     * would make a wink work backwards.
     */
    expect(report.blinkInfluences[0]).toBeGreaterThan(0.8);
    expect(report.blinkInfluences[1]).toBeLessThan(0.05);
    expect(report.blinkInfluences[2]).toBeLessThan(0.05);

    // And the jaw slider drove the jaw morph, releasing the blink.
    expect(report.jawInfluences[2]).toBeGreaterThan(0.8);
    expect(report.jawInfluences[0]).toBeLessThan(0.2);
  });
});

test.describe("the Studio 3D source path", () => {
  test("uploads a model, reports its rig, and opens the avatar preview", async ({ page }) => {
    test.setTimeout(300_000);

    await page.addInitScript(
      ({ key }) => {
        try {
          sessionStorage.setItem(key, "active");
        } catch {
          /* the route lands on the login screen and the test says so */
        }
      },
      { key: DEV_SESSION_KEY },
    );

    await page.goto("/admin/profiles");
    /*
     * Retried, because local IndexedDB occasionally does not answer on a loaded
     * machine and the Studio's source step correctly refuses to work without a
     * profile. A single attempt made this test fail for a reason that had nothing
     * to do with avatars.
     */
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            try {
              const { adminRepository } = await import("/src/services/admin/repository.ts");
              const existing = await adminRepository.listProfiles();
              if (existing.length > 0) return existing.length;
              await adminRepository.createProfile({
                displayName: "Avatar Fixture",
                shortBio: "",
                status: "active",
              });
              return (await adminRepository.listProfiles()).length;
            } catch {
              return 0;
            }
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    await page.goto("/admin/studio");
    await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();

    // The existing image and video controls are still there.
    await expect(page.getByRole("button", { name: "Upload image" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload video" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Upload 3D model/ })).toBeVisible();

    await page.evaluate(
      async (fixtureModule) => {
        const { buildAvatarFixtures, fixtureFile } = await import(/* @vite-ignore */ fixtureModule);
        const fixtures = await buildAvatarFixtures();
        const file = fixtureFile(fixtures.rigged, "studio-avatar.glb");

        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.querySelector<HTMLInputElement>('input[accept*=".glb"]');
        if (!input) throw new Error("no model input");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      FIXTURE_MODULE,
    );

    // Shown by both the source panel and the capability panel, so take the first.
    await expect(page.getByText("studio-avatar.glb").first()).toBeVisible();

    // Consent gates a model exactly as it gates an image.
    const analyze = page.getByRole("button", { name: /Load and analyze model/ });
    await expect(analyze).toBeDisabled();
    await page.getByLabel(/I confirm I have permission/i).check();
    await expect(analyze).toBeEnabled();
    await analyze.click();

    // The capability report, from the file rather than from assumption.
    await expect(page.getByRole("heading", { name: /3D Model · Experimental/ })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Blink left")).toBeVisible();
    await expect(page.getByText(/rigged with facial morphs/)).toBeVisible();

    // And the preview mode it unlocks.
    const avatarMode = page.getByRole("button", { name: "3D Avatar" });
    await expect(avatarMode).toBeEnabled();
    await avatarMode.click();

    /*
     * Asserted from the renderer's own reported frame counter, not from sampled
     * pixels: a WebGL drawing buffer is undefined after compositing unless the
     * context sets `preserveDrawingBuffer`, which production deliberately does not.
     */
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const node = document.querySelector('[data-avatar-metric="frames"]');
            return Number.parseInt(node?.textContent ?? "0", 10) || 0;
          }),
        { timeout: 120_000 },
      )
      .toBeGreaterThan(10);

    // The renderer has a live context and is driving the model.
    await expect(page.locator('[data-avatar-metric="webgl"]')).toHaveText("WebGL ok");
    await expect(page.locator('[data-avatar-metric="head"]')).toContainText("yaw");

    // Switching back to the raw source tears the avatar renderer down, and the
    // image and video paths are untouched by any of this.
    await page.getByRole("button", { name: "Raw source" }).click();
    await expect(page.getByRole("button", { name: "Change source" })).toBeVisible();
  });
});
