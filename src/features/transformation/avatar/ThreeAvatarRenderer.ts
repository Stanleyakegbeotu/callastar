import type { ExpressionKey } from "../engine/expressionMotion";
import { loadThreeRenderer } from "../loaders";
import { mirrorScaleX, type RenderMirrorMode } from "../engine/rendering/rendererMotion";

import { NEUTRAL_AVATAR_MOTION, easeTowardsNeutral, smoothAvatarMotion } from "./avatarMotion";
import { AvatarRigAdapter, type RigApplication } from "./avatarRigAdapter";
import type { AnalyzedAvatarModel } from "./modelAnalyzer";
import { disposeAvatarScene } from "./modelAnalyzer";
import type { AvatarMotion } from "./avatarTypes";

/**
 * The avatar renderer.
 *
 * Drives a loaded GLB from `AvatarMotion` and nothing else. It never sees a
 * MediaPipe result, a blendshape name or a calibration profile — the motion
 * contract and the rig adapter stand between them, which is what keeps tracking
 * from being wired into GLTF nodes across the UI.
 *
 * The model is a puppet. It has no mixer and plays no clip, deliberately: a file
 * shipping an idle animation must not animate itself, because the operator's
 * camera is the only thing entitled to move it.
 */

export type AvatarRendererStatus = "loading" | "ready" | "lost" | "failed" | "disposed";

export interface AvatarRendererStats {
  status: AvatarRendererStatus;
  fps: number | null;
  renderMs: number | null;
  frames: number;
  message: string | null;
  /** What the tracker asked for, in render conventions. */
  requestedHead: AvatarMotion["head"] | null;
  /** What was actually written to the model after smoothing. */
  appliedHead: AvatarMotion["head"] | null;
  requestedExpressions: Record<ExpressionKey, number> | null;
  appliedExpressions: Record<ExpressionKey, number> | null;
  /** Expressions the rig cannot perform, so a live value has nowhere to go. */
  unsupported: readonly ExpressionKey[];
  faceTracked: boolean;
  calibrated: boolean;
  webglAvailable: boolean;
}

export interface AvatarRendererOptions {
  canvas: HTMLCanvasElement;
  model: AnalyzedAvatarModel;
  /** The tracking loop owns writes to this ref. Rendering never starts inference. */
  motion: { current: AvatarMotion };
  /** Development rig panel. Takes precedence, through the SAME adapter. */
  manualMotion?: { current: AvatarMotion | null };
  paused?: { current: boolean };
  /** `selfie` mirrors the scene, matching the camera preview. */
  mirror?: RenderMirrorMode;
  onStats?: (stats: AvatarRendererStats) => void;
}

/** Hold this long after tracking is lost, then ease to neutral over the same. */
const LOST_HOLD_MS = 420;
const LOST_RELEASE_MS = 520;

export class ThreeAvatarRenderer {
  private status: AvatarRendererStatus = "loading";
  private disposed = false;
  private raf = 0;
  private frame = 0;
  private lastFrameAt = 0;
  private lastStatsAt = 0;
  private framesSinceStats = 0;
  private lastTrackedAt = 0;
  private contextFailed = false;

  private three: Awaited<ReturnType<typeof loadThreeRenderer>> | null = null;
  private renderer: import("three").WebGLRenderer | null = null;
  private scene: import("three").Scene | null = null;
  private camera: import("three").PerspectiveCamera | null = null;
  /** Wraps the model so rotation happens about the head pivot, not the origin. */
  private pivot: import("three").Group | null = null;
  private root: import("three").Group | null = null;
  private jawBone: import("three").Object3D | null = null;
  private jawRestX = 0;

  /** Meshes by name, so the adapter's influences can be written without a search. */
  private readonly meshes = new Map<string, import("three").Mesh>();

  private readonly adapter: AvatarRigAdapter;
  private smoothed: AvatarMotion = NEUTRAL_AVATAR_MOTION;
  private lastApplication: RigApplication | null = null;

  constructor(private readonly options: AvatarRendererOptions) {
    const profile = options.model.profile;
    this.adapter = new AvatarRigAdapter({
      mappedMorphs: profile.mappedMorphs,
      capabilities: profile.capabilities,
      jawBoneRange: undefined,
    });
  }

  get rigAdapter(): AvatarRigAdapter {
    return this.adapter;
  }

  /** The future WebRTC seam: a canvas this returns can be captured directly. */
  getOutputCanvas(): HTMLCanvasElement {
    return this.options.canvas;
  }

  async initialize(): Promise<void> {
    try {
      this.three = await loadThreeRenderer();
      if (this.disposed) return;
      this.createScene();
      this.status = "ready";
      this.publish(null);
      this.raf = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      if (this.disposed) return;
      this.status = "failed";
      this.publish(error instanceof Error ? error.message : "The avatar renderer could not start.");
      this.releaseGraphics();
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (!this.renderer || !this.camera || width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(Math.max(1, pixelRatio || 1), 2));
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGraphics();
    this.status = "disposed";
    this.publish(null);
  }

  private createScene(): void {
    const three = this.three!;
    const { profile, scene: modelScene } = this.options.model;

    const renderer = new three.WebGLRenderer({ canvas: this.options.canvas, alpha: true, antialias: true });
    this.renderer = renderer;
    this.options.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.options.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    renderer.setClearColor(0x0f172a, 1);
    renderer.outputColorSpace = three.SRGBColorSpace;

    const scene = new three.Scene();

    /*
     * Flat, even light, on purpose.
     *
     * This preview exists to judge whether a blink reads as a blink. Dramatic
     * key lighting and shadows would hide exactly the small facial movement being
     * evaluated, so it is a hemisphere fill plus one soft directional.
     */
    scene.add(new three.HemisphereLight(0xffffff, 0x404050, 2.1));
    const directional = new three.DirectionalLight(0xffffff, 1.1);
    directional.position.set(0.4, 0.8, 1.6);
    scene.add(directional);

    /*
     * Two nested groups, so the model turns about its head.
     *
     * `root` carries the normalisation — the model shifted so its head pivot sits
     * at the local origin, then scaled. `pivot` carries the live rotation and
     * translation. Without the offset a full-body model rotates about its feet,
     * which looks like a door swinging rather than a head turning.
     */
    const root = new three.Group();
    const normalization = profile.normalization;
    root.position.set(
      -normalization.pivot.x * normalization.scale,
      -normalization.pivot.y * normalization.scale,
      -normalization.pivot.z * normalization.scale,
    );
    root.scale.setScalar(normalization.scale);
    root.add(modelScene);

    const pivot = new three.Group();
    pivot.add(root);
    // The mirror is one negative x scale at the scene boundary, exactly as the
    // camera preview and the face renderer do it.
    pivot.scale.x = mirrorScaleX(this.options.mirror ?? "selfie");
    scene.add(pivot);

    // Indexed once. Looking meshes up by name every frame would walk the scene
    // sixty times a second for a map that never changes.
    modelScene.traverse((node) => {
      const mesh = node as import("three").Mesh;
      if (mesh.isMesh) this.meshes.set(mesh.name || mesh.uuid, mesh);
    });

    if (profile.jawBoneName) {
      this.jawBone = modelScene.getObjectByName(profile.jawBoneName) ?? null;
      this.jawRestX = this.jawBone?.rotation.x ?? 0;
    }

    /*
     * Perspective here, unlike the face renderer's orthographic camera.
     *
     * A real 3D head has depth worth seeing, and perspective is what makes a turn
     * read as a turn rather than a flat rotation. The face renderer stays
     * orthographic because it has no true depth to show.
     */
    const camera = new three.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 4.4);
    camera.lookAt(0, 0, 0);

    this.scene = scene;
    this.camera = camera;
    this.pivot = pivot;
    this.root = root;

    this.resize(
      this.options.canvas.clientWidth || 1,
      this.options.canvas.clientHeight || 1,
      window.devicePixelRatio,
    );
  }

  private renderFrame = (now: number): void => {
    if (this.disposed || this.status === "failed") return;
    const elapsed = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;

    const manual = this.options.manualMotion?.current ?? null;
    const live = this.options.motion.current;
    const paused = this.options.paused?.current ?? false;

    // Manual wins, and travels the identical path. A working slider beside a dead
    // live input is only diagnostic if nothing else differs between them.
    const source = manual ?? live;
    if (source.tracking.faceTracked || manual) this.lastTrackedAt = now;

    const sinceTracked = now - this.lastTrackedAt;
    const lost = !manual && !source.tracking.faceTracked && sinceTracked > LOST_HOLD_MS;
    this.status = lost ? "lost" : "ready";

    /*
     * Hold, then ease. Never freeze.
     *
     * An avatar left frozen mid-blink or mid-turn reads as a crash, and the
     * operator cannot tell whether the renderer died or they simply stepped out of
     * frame.
     */
    const target = paused
      ? NEUTRAL_AVATAR_MOTION
      : lost
        ? easeTowardsNeutral(source, Math.min(1, (sinceTracked - LOST_HOLD_MS) / LOST_RELEASE_MS))
        : source;

    this.smoothed = smoothAvatarMotion(this.smoothed, target, elapsed);
    const application = this.adapter.apply(this.smoothed);
    this.lastApplication = application;

    if (this.pivot && this.renderer && this.scene && this.camera) {
      const started = performance.now();
      const head = this.smoothed.head;

      // Every sign already resolved upstream in `rendererMotion.ts`. Nothing is
      // negated here.
      this.pivot.position.set(head.translationX * 0.9, head.translationY * 0.9, head.translationZ);
      this.pivot.rotation.set(head.pitch, head.yaw, head.roll, "XYZ");
      const flip = mirrorScaleX(this.options.mirror ?? "selfie");
      this.pivot.scale.set(head.scale * flip, head.scale, head.scale);

      for (const influence of application.influences) {
        const mesh = this.meshes.get(influence.meshName);
        if (!mesh?.morphTargetInfluences) continue;
        mesh.morphTargetInfluences[influence.index] = influence.value;
      }

      if (this.jawBone && application.jawBoneRotation !== null) {
        this.jawBone.rotation.x = this.jawRestX + application.jawBoneRotation;
      }

      this.renderer.render(this.scene, this.camera);
      const renderMs = performance.now() - started;

      this.frame += 1;
      this.framesSinceStats += 1;
      if (now - this.lastStatsAt > 250) {
        const fps = now - this.lastStatsAt ? (this.framesSinceStats * 1000) / (now - this.lastStatsAt) : null;
        this.publish(null, renderMs, fps);
        this.lastStatsAt = now;
        this.framesSinceStats = 0;
      }
    }

    this.raf = requestAnimationFrame(this.renderFrame);
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextFailed = true;
    this.status = "failed";
    this.publish("WebGL context was lost. The camera and tracker are still available.");
    this.releaseGraphics(false);
  };

  private onContextRestored = (): void => {
    if (!this.contextFailed || this.disposed) return;
    this.status = "failed";
    this.publish("WebGL context returned. Close and reopen the avatar preview to rebuild its resources.");
  };

  /**
   * Everything this renderer holds on the GPU.
   *
   * The model's geometries, materials and textures are disposed too: they were
   * loaded for this renderer, and a model swapped a few times without this will
   * exhaust a phone's memory. `cancelAnimationFrame` first, so no frame can run
   * against a half-released scene.
   */
  private releaseGraphics(removeListeners = true): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (removeListeners) {
      this.options.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.options.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    }

    disposeAvatarScene(this.options.model.scene);
    this.meshes.clear();
    this.jawBone = null;
    this.pivot = null;
    this.root = null;
    this.scene = null;
    this.camera = null;

    if (this.renderer) {
      this.renderer.dispose();
      if (!this.contextFailed) this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  private publish(message: string | null, renderMs: number | null = null, fps: number | null = null): void {
    const profile = this.options.model.profile;
    this.options.onStats?.({
      status: this.status,
      fps,
      renderMs,
      frames: this.frame,
      message,
      requestedHead: (this.options.manualMotion?.current ?? this.options.motion.current).head,
      appliedHead: this.status === "loading" ? null : this.smoothed.head,
      requestedExpressions: this.lastApplication?.requested ?? null,
      appliedExpressions: this.lastApplication?.applied ?? null,
      unsupported: this.lastApplication?.unsupported ?? [],
      faceTracked: this.options.motion.current.tracking.faceTracked,
      calibrated: this.options.motion.current.tracking.calibrated,
      webglAvailable: this.renderer !== null,
    });
    void profile;
  }
}
