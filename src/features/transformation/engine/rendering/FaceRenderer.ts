import { loadThreeRenderer } from "../../loaders";
import type { SourceAsset } from "../../source/sourceAsset";
import type { TransformationSourceProfile } from "../../source/sourceTypes";
import type { CalibrationMotion } from "../relativeMotion";
import {
  clampExpression, deriveExpressionEnvelope, deriveSourceExpression,
  clampExpressionInto, NEUTRAL_EXPRESSION, smoothExpressionInto,
  type ExpressionKey, type ExpressionMotion, type ExpressionValues, type ExpressionEnvelope,
  type ExpressionTrace,
} from "../expressionMotion";

import {
  NEUTRAL_FACE_RENDER_POSE,
  poseFromSourceMotion,
  smoothFaceRenderPose,
  type FaceRenderPose,
  type FaceRenderPoseResult,
} from "./faceRendererMath";
import {
  faceDirectionVectors,
  mirrorScaleX,
  rendererMotionFromPose,
  type RenderMirrorMode,
  type RendererMotion,
} from "./rendererMotion";
import { buildSourceFaceMesh } from "./sourceMesh";
import { ExpressionDeformer } from "./expressionDeformer";

export type FaceRendererStatus = "loading" | "ready" | "lost" | "failed" | "disposed";

export interface FaceRendererStats {
  status: FaceRendererStatus;
  fps: number | null;
  renderMs: number | null;
  frames: number;
  droppedFrames: number;
  requested: FaceRenderPoseResult["requested"] | null;
  applied: FaceRenderPoseResult["applied"] | null;
  clamped: readonly string[];
  message: string | null;
  expressionRequested: ExpressionValues | null;
  expressionApplied: ExpressionValues | null;
  expressionLimits: ExpressionEnvelope | null;
  expressionClamped: readonly string[];
  expressionMs: number | null;
  deformationMs: number | null;
  /**
   * How far the current expression actually moved the mesh.
   *
   * The number the real-device failures needed. An applied value of 0.45 next to
   * a displacement of two pixels says the deformer is too weak; the same value
   * next to zero displacement says the vertices are wrong. Without it, both look
   * identical on a phone.
   */
  vertexDisplacementMax: number;
  vertexDisplacementPx: number;
  /** Rendered source face width in canvas pixels, so a displacement can be judged. */
  faceWidthPx: number;
  /** Per-expression input trace: raw blendshape, neutral, normalized, origin. */
  expressionTrace: ExpressionTrace | null;
}

export interface FaceRendererOptions {
  canvas: HTMLCanvasElement;
  asset: SourceAsset;
  profile: TransformationSourceProfile;
  /** Existing Studio preview element, reused for a video's primary frame. */
  sourceVideoRef?: { current: HTMLVideoElement | null };
  /** The tracking loop owns writes to this ref. Rendering never starts inference. */
  motion: { current: CalibrationMotion };
  expression?: { current: ExpressionMotion | null };
  manualExpression?: { current: ExpressionMotion | null };
  paused?: { current: boolean };
  /**
   * Which way round the output is shown.
   *
   * `selfie` mirrors it, like the camera preview beside it, so an operator
   * turning right sees the rendered face turn right. `faithful` is what a caller
   * must receive. Mirroring is applied to the SCENE, never to the motion — see
   * `rendererMotion.ts`.
   */
  mirror?: RenderMirrorMode;
  onStats?: (stats: FaceRendererStats) => void;
}

/**
 * An orthographic camera is intentional for M7. It makes calibration-relative
 * translation and scale predictable and avoids inventing a camera distance
 * from a single source photo. Perspective can be introduced when a source has
 * a true depth model; until then it would make a fake face pulse toward camera.
 */
export class FaceRenderer {
  private status: FaceRendererStatus = "loading";
  private disposed = false;
  private frame = 0;
  private raf = 0;
  private lastFrameAt = 0;
  private lastStatsAt = 0;
  private framesSinceStats = 0;
  private droppedFrames = 0;
  private pose: FaceRenderPose = NEUTRAL_FACE_RENDER_POSE;
  private lastTrackedAt = 0;
  private contextFailed = false;
  private textureBitmap: ImageBitmap | null = null;
  private three: Awaited<ReturnType<typeof loadThreeRenderer>> | null = null;
  private renderer: import("three").WebGLRenderer | null = null;
  private scene: import("three").Scene | null = null;
  private camera: import("three").OrthographicCamera | null = null;
  private mesh: import("three").Mesh | null = null;
  private geometry: import("three").BufferGeometry | null = null;
  private material: import("three").MeshBasicMaterial | null = null;
  private texture: import("three").Texture | null = null;
  private meshEdges: import("three").LineSegments | null = null;
  private edgeGeometry: import("three").EdgesGeometry | null = null;
  private edgeMaterial: import("three").LineBasicMaterial | null = null;
  private wireframe = false;
  private showMesh = false;
  private deformer: ExpressionDeformer | null = null;
  private expressionEnvelope: ExpressionEnvelope | null = null;
  private expressionState: ExpressionValues = { ...NEUTRAL_EXPRESSION };
  private expressionRequested: ExpressionValues | null = null;
  private expressionApplied: ExpressionValues | null = null;
  private readonly expressionClamped: ExpressionKey[] = [];
  private readonly clampedExpression = { ...NEUTRAL_EXPRESSION };
  private expressionMs: number | null = null;
  private deformationMs: number | null = null;
  private lastExpressionAt = 0;
  private renderedMotion: RendererMotion | null = null;
  private expressionTrace: ExpressionTrace | null = null;

  constructor(private readonly options: FaceRendererOptions) {}

  async initialize(): Promise<void> {
    try {
      const bitmap = await decodeSourceFrame(
        this.options.asset,
        this.options.profile,
        this.options.sourceVideoRef?.current ?? null,
      );
      this.textureBitmap = bitmap;
      if (this.disposed) {
        bitmap.close();
        this.textureBitmap = null;
        return;
      }
      this.three = await loadThreeRenderer();
      if (this.disposed) return;
      this.createScene();
      this.status = "ready";
      this.publish(null);
      this.raf = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      if (this.disposed) return;
      this.status = "failed";
      this.publish(error instanceof Error ? error.message : "The face renderer could not start.");
      this.releaseGraphics();
    }
  }

  setDiagnostics(options: { showMesh: boolean; wireframe: boolean }): void {
    this.showMesh = options.showMesh;
    this.wireframe = options.wireframe;
    if (this.material) this.material.wireframe = options.wireframe || options.showMesh;
    if (this.mesh) this.mesh.visible = true;
    if (this.meshEdges) this.meshEdges.visible = options.showMesh;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (!this.renderer || !this.camera || width <= 0 || height <= 0) return;
    const aspect = width / height;
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
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

  private releaseGraphics(removeListeners = true): void {
    cancelAnimationFrame(this.raf);
    if (removeListeners) {
      this.options.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.options.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    }
    this.geometry?.dispose();
    this.edgeGeometry?.dispose();
    this.edgeMaterial?.dispose();
    this.material?.dispose();
    this.texture?.dispose();
    this.textureBitmap?.close();
    this.geometry = null;
    this.edgeGeometry = null;
    this.edgeMaterial = null;
    this.material = null;
    this.texture = null;
    this.textureBitmap = null;
    this.deformer = null;
    this.expressionEnvelope = null;
    this.mesh = null;
    this.meshEdges = null;
    if (this.renderer) {
      this.renderer.dispose();
      if (!this.contextFailed) this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  private createScene(): void {
    const three = this.three!;
    const renderer = new three.WebGLRenderer({ canvas: this.options.canvas, alpha: true, antialias: true });
    this.renderer = renderer;
    this.options.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.options.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    renderer.setClearColor(0x0f172a, 1);
    const scene = new three.Scene();
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    camera.position.z = 2;
    const meshData = buildSourceFaceMesh(this.options.profile.primaryFace.landmarks);
    this.deformer = new ExpressionDeformer(meshData, this.options.profile.primaryFace.landmarks);
    this.expressionEnvelope = deriveExpressionEnvelope(
      this.options.profile.expression ?? deriveSourceExpression(this.options.profile.primaryFace),
    );
    const geometry = new three.BufferGeometry();
    geometry.setAttribute("position", new three.BufferAttribute(this.deformer.positions, 3).setUsage(three.DynamicDrawUsage));
    geometry.setAttribute("uv", new three.BufferAttribute(meshData.uvs, 2));
    geometry.setIndex(new three.BufferAttribute(meshData.indices, 1));
    geometry.computeVertexNormals();
    const texture = new three.Texture(this.textureBitmap!);
    texture.colorSpace = three.SRGBColorSpace;
    texture.wrapS = three.ClampToEdgeWrapping;
    texture.wrapT = three.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    const material = new three.MeshBasicMaterial({ map: texture, transparent: true, side: three.DoubleSide });
    const mesh = new three.Mesh(geometry, material);
    // The source's neutral pose is the local mesh. Only relative live motion is applied.
    scene.add(mesh);
    this.scene = scene;
    this.camera = camera;
    this.geometry = geometry;
    this.texture = texture;
    this.material = material;
    this.mesh = mesh;
    this.resize(this.options.canvas.clientWidth || 1, this.options.canvas.clientHeight || 1, window.devicePixelRatio);
  }

  private renderFrame = (now: number): void => {
    if (this.disposed || this.status === "failed") return;
    const elapsed = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;
    const motion = this.options.motion.current;
    const expression = this.options.manualExpression?.current ?? this.options.expression?.current ?? null;
    if (this.options.paused?.current) {
      smoothExpressionInto(this.expressionState, NEUTRAL_EXPRESSION, elapsed, this.expressionState);
      this.expressionApplied = this.expressionState;
      this.deformer?.update(this.expressionState);
      const position = this.geometry?.getAttribute("position") as import("three").BufferAttribute | undefined;
      if (position) position.needsUpdate = true;
      this.renderer?.render(this.scene!, this.camera!);
      this.raf = requestAnimationFrame(this.renderFrame);
      return;
    }
    if (motion.head) this.lastTrackedAt = now;
    const lost = !motion.head && now - this.lastTrackedAt > 450;
    this.status = lost ? "lost" : "ready";
    if (this.material) {
      this.material.opacity = motion.head || now - this.lastTrackedAt <= 450
        ? 1
        : Math.max(0, 1 - (now - this.lastTrackedAt - 450) / 450);
    }
    const target = this.motionResult(motion).applied;
    // Hold briefly during tracker dropouts, then fade rather than snap to neutral.
    const safeTarget = motion.head || !lost ? target : NEUTRAL_FACE_RENDER_POSE;
    this.pose = smoothFaceRenderPose(this.pose, safeTarget, elapsed);
    if (this.mesh && this.renderer && this.scene && this.camera) {
      if (expression) this.lastExpressionAt = now;
      const expressionLost = !expression && now - this.lastExpressionAt > 130;
      this.expressionRequested = expression ? expression : null;
      this.expressionMs = expression?.calculationMs ?? null;
      // A manual override has no input to trace; keep the last live one rather
      // than implying the override came from a blendshape.
      if (expression?.trace) this.expressionTrace = expression.trace;
      clampExpressionInto(expression ?? NEUTRAL_EXPRESSION,
        this.expressionEnvelope ?? NEUTRAL_EXPRESSION, this.clampedExpression, this.expressionClamped);
      this.expressionApplied = this.clampedExpression;
      const expressionTarget = expressionLost ? NEUTRAL_EXPRESSION : expression ? this.clampedExpression : this.expressionState;
      smoothExpressionInto(this.expressionState, expressionTarget, elapsed, this.expressionState);
      this.expressionApplied = this.expressionState;
      const deformationStarted = performance.now();
      this.deformer?.update(this.expressionState);
      const position = this.geometry?.getAttribute("position") as import("three").BufferAttribute | undefined;
      if (position) position.needsUpdate = true;
      this.deformationMs = performance.now() - deformationStarted;
      const started = performance.now();
      /*
       * Every sign comes from `rendererMotion.ts` and none from here.
       *
       * This line used to read `rotation.set(pitch, -yaw, roll)` — a lone
       * negation on one axis, with the other two implicit. That is how a real
       * device turned the wrong way on two axes with nothing wrong in any single
       * line, and why the mapping now lives in one documented place.
       */
      const rendered = rendererMotionFromPose(this.pose);
      this.renderedMotion = rendered;
      const flip = mirrorScaleX(this.options.mirror ?? "selfie");
      this.mesh.position.set(rendered.x * 0.46 * flip, rendered.y * 0.46, 0);
      // The mirror is a negative x scale on the scene: one flip, at the display
      // boundary, exactly as the camera preview does it.
      this.mesh.scale.set(rendered.scale * 2.0 * flip, rendered.scale * 2.0, rendered.scale * 2.0);
      this.mesh.rotation.set(rendered.rotationX, rendered.rotationY, rendered.rotationZ, "XYZ");
      this.material!.wireframe = this.wireframe || this.showMesh;
      this.renderer.render(this.scene, this.camera);
      const renderMs = performance.now() - started;
      this.frame += 1;
      this.framesSinceStats += 1;
      if (elapsed > 42) this.droppedFrames += 1;
      if (now - this.lastStatsAt > 250) {
        this.publish(null, renderMs, now - this.lastStatsAt ? (this.framesSinceStats * 1000) / (now - this.lastStatsAt) : null);
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
    this.publish("WebGL context returned. Close and reopen Face Render to rebuild its resources.");
  };

  private publish(message: string | null, renderMs: number | null = null, fps: number | null = null): void {
    const result = this.motionResult(this.options.motion.current);
    const probe = this.getProbe();
    this.options.onStats?.({
      status: this.status,
      fps,
      renderMs,
      frames: this.frame,
      droppedFrames: this.droppedFrames,
      requested: this.status === "loading" || this.status === "failed" || this.status === "disposed" ? null : result.requested,
      applied: this.status === "loading" || this.status === "failed" || this.status === "disposed" ? null : result.applied,
      clamped: result.clamped,
      message,
      expressionRequested: this.expressionRequested,
      expressionApplied: this.expressionApplied,
      expressionLimits: this.expressionEnvelope,
      expressionClamped: this.expressionClamped,
      expressionMs: this.expressionMs,
      deformationMs: this.deformationMs,
      vertexDisplacementMax: probe.vertexDisplacementMax,
      vertexDisplacementPx: probe.vertexDisplacementPx,
      faceWidthPx: probe.faceWidthPx,
      expressionTrace: this.expressionTrace,
    });
  }

  /** Apply both the conservative M7 envelope and the measured source envelope. */
  private motionResult(motion: CalibrationMotion): FaceRenderPoseResult {
    return poseFromSourceMotion(motion, this.options.profile.movementEnvelope);
  }

  /**
   * Where the rendered face is actually pointing, and how far its vertices moved.
   *
   * The diagnostic the real-device failures needed. It reports the applied Euler
   * and the resulting nose and up vectors AS SEEN on this surface, so a test can
   * ask "does a physical right turn send the nose right?" rather than checking
   * that a number survived a function. It also reports the largest vertex
   * displacement, which is what separates "no signal" from "signal too small".
   */
  getProbe(): {
    motion: RendererMotion | null;
    /** Direction vectors after the surface's mirror; null before the first frame. */
    nose: { x: number; y: number; z: number } | null;
    up: { x: number; y: number; z: number } | null;
    mirror: RenderMirrorMode;
    expressionApplied: ExpressionValues | null;
    /** Max |displacement| from the neutral mesh, in source-local units. */
    vertexDisplacementMax: number;
    /** The same, expressed in rendered canvas pixels. */
    vertexDisplacementPx: number;
    /** Source face width in canvas pixels, so a displacement can be judged. */
    faceWidthPx: number;
  } {
    const mirror = this.options.mirror ?? "selfie";
    const flip = mirrorScaleX(mirror);
    const motion = this.renderedMotion;
    const vectors = motion ? faceDirectionVectors(motion) : null;

    let maxDisplacement = 0;
    const base = this.deformer?.basePositions;
    const live = this.deformer?.positions;
    if (base && live) {
      for (let index = 0; index < live.length; index += 1) {
        const delta = Math.abs(live[index]! - base[index]!);
        if (delta > maxDisplacement) maxDisplacement = delta;
      }
    }

    // World units per canvas pixel: the orthographic camera spans 2 units
    // vertically, whatever the pixel height of the surface.
    const heightPx = this.options.canvas.clientHeight || this.options.canvas.height || 1;
    const scale = (motion?.scale ?? 1) * 2.0;
    const pxPerWorld = heightPx / 2;

    return {
      motion,
      nose: vectors ? { ...vectors.nose, x: vectors.nose.x * flip } : null,
      up: vectors ? { ...vectors.up, x: vectors.up.x * flip } : null,
      mirror,
      expressionApplied: this.expressionApplied,
      vertexDisplacementMax: maxDisplacement,
      vertexDisplacementPx: maxDisplacement * scale * pxPerWorld,
      faceWidthPx: (this.deformer?.faceWidth ?? 0) * scale * pxPerWorld,
    };
  }
}

async function decodeSourceFrame(
  asset: SourceAsset,
  profile: TransformationSourceProfile,
  sourceVideo: HTMLVideoElement | null,
): Promise<ImageBitmap> {
  if (asset.kind === "image") return createImageBitmap(asset.blob, { imageOrientation: "from-image" });
  const video = sourceVideo;
  if (!video || !video.src) throw new Error("The existing source video preview is unavailable.");
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("The primary source video frame could not be decoded."));
    });
  }
  video.pause();
  const timestamp = profile.referenceFrames.find((frame) => frame.angle === "front")?.timestampSeconds ?? 0;
  video.currentTime = Math.min(Math.max(0, timestamp), Math.max(0, video.duration || 0));
  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("The primary source video frame could not be read.")); };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - timestamp) < 0.001) {
      cleanup();
      resolve();
    }
  });
  return createImageBitmap(video);
}
