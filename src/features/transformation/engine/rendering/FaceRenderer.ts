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
import { faceWorldTransform, meshEyeSpan, type FaceRenderFraming } from "./faceFraming";
import { ExpressionDeformer } from "./expressionDeformer";
import { faceWebGLContext, FACE_WEBGL_UNAVAILABLE } from './webglPreflight';
import { VideoFrameReader } from '../../source/videoFrameReader';
import { drawWarpedMouth, mouthTextureTarget, mouthMaskMetrics, oralFrameFresh, oralFeedAllowed, oralContentFit, type MouthPoint, type OralInteriorMode } from './liveMouthCompositor';
import { INNER_LIP_RING } from './sourceMesh';
import { EyeGazeWarper } from "./eyeGazeWarper";
import { EYE_RENDER_CHANNELS, eyeGazeForRenderer } from '../eyeControls';
import { noseCavityData, nostrilVisibility } from './noseCavities';

export type FaceRendererStatus = "loading" | "ready" | "lost" | "failed" | "disposed";

export interface FaceRendererStats {
  expressionLeakage?: boolean;
  /** Live eye diagnostics: aperture per eye, and the blink state machine. */
  eyes?: {
    aperture: { left: number | null; right: number | null } | null;
    state: import("../expressionMotion").ExpressionMotion["blinkState"] | null;
  } | null;
  meshVertices?: number;
  meshTriangles?: number;
  depthRange?: number;
  dpr?: number;
  contextLossCount?: number;
  status: FaceRendererStatus;
  fps: number | null;
  renderMs: number | null;
  /** Age of the latest face/expression result when this display frame rendered. */
  displayInputAgeMs?: number | null;
  displayFrameAtMs?: number | null;
  renderStartMs?: number | null;
  renderEndMs?: number | null;
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
  mouthCompositorMs?: number | null;
  mouthMaskStatus?: 'disabled'|'closed'|'unavailable'|'stale'|'invalid'|'ready';
  oral?: OralDiagnostics;
  nosePerspective?: {depth:number;visibility:number;requestedPitch:number;appliedPitch:number};
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
  mouthFeedOpacity?: number;
  mouthMeshAperturePx?: { neutral: number; applied: number } | null;
  jawChinMovementPx?: number | null;
}

export interface OralDiagnostics {
  mode: OralInteriorMode;
  active: boolean;
  frameAvailable: boolean;
  polygonValid: boolean;
  maskAreaPx: number;
  warpedPixels: number;
  averageLuminance: number | null;
  teethVisibleEstimate: number | null;
  cropBounds: NonNullable<ReturnType<typeof mouthMaskMetrics>>['bounds'] | null;
  maskBounds: {minX:number;maxX:number;minY:number;maxY:number} | null;
  frameAgeMs: number | null;
  cameraTimestampMs: number | null;
  faceResultTimestampMs: number | null;
  controlsTimestampMs: number | null;
  oralSourceTimestampMs: number | null;
  renderTimestampMs: number | null;
  droppedFrames: number;
  tongueMaskActive: boolean;
  tongueConfidence: number | null;
  extendedMaskActive: boolean;
}

export interface FaceScreenProbe {
  pivot: { x: number; y: number };
  nose: { x: number; y: number };
  /** Outer eye corner to outer eye corner. */
  eyeSpanPx: number;
  /** Angle of the line from landmark 33 to 263, screen degrees (y down). */
  eyeAngleDeg: number;
}

export interface FaceRendererOptions {
  canvas: HTMLCanvasElement;
  asset: SourceAsset;
  profile: TransformationSourceProfile;
  /** Existing Studio preview element, reused for a video's primary frame. */
  sourceVideoRef?: { current: HTMLVideoElement | null };
  /** Existing operator camera element; sampled only by the renderer's frame loop. */
  liveMouthVideoRef?: { current: HTMLVideoElement | null };
  /** Experimental live-interior switch, read through a ref without restarting. */
  liveMouthEnabled?: { current: boolean };
  oralInteriorMode?: { current: OralInteriorMode };
  /** The tracking loop owns writes to this ref. Rendering never starts inference. */
  motion: { current: CalibrationMotion };
  expression?: { current: ExpressionMotion | null };
  manualExpression?: { current: ExpressionMotion | null };
  manualPose?: { current: FaceRenderPose | null };
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
  /**
   * Where the operator's neutral face sat in the camera frame. Present once
   * calibrated: the face is then drawn where, and as large as, the camera
   * preview shows it — see `faceFraming.ts`.
   */
  framing?: { current: FaceRenderFraming | null };
  onStats?: (stats: FaceRendererStats) => void;
}

/**
 * An orthographic camera is intentional for M7. It makes calibration-relative
 * translation and scale predictable and avoids inventing a camera distance
 * from a single source photo. Perspective can be introduced when a source has
 * a true depth model; until then it would make a fake face pulse toward camera.
 */
export class FaceRenderer {
  private static owners = new WeakMap<HTMLCanvasElement, FaceRenderer>();
  private initialization: Promise<void> | null = null;
  private contextLossCount = 0;
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
  /** The untextured mouth cavity; see `buildSourceFaceMesh`. */
  private cavityMaterial: import("three").MeshBasicMaterial | null = null;
  private fillMaterial: import("three").MeshBasicMaterial | null = null;
  private liveMouthMaterial: import("three").MeshBasicMaterial | null = null;
  private liveMouthTexture: import("three").CanvasTexture | null = null;
  private liveMouthCanvas: HTMLCanvasElement | null = null;
  private liveMouthGeometry: import("three").BufferGeometry | null = null;
  private liveMouthMesh: import("three").Mesh | null = null;
  private liveMouthTarget: MouthPoint[] = [];
  private liveMouthBasePositions: Float32Array | null = null;
  private liveMouthMidY = 0;
  private liveMouthHalfHeight = 0.001;
  private liveMouthWidth = 0;
  private liveMouthLastTimestamp = -1;
  private liveMouthHasFrame = false;
  private liveMouthOpacity = 0;
  private liveMouthActive = false;
  private mouthMaskStatus:NonNullable<FaceRendererStats['mouthMaskStatus']>='disabled';
  private texture: import("three").Texture | null = null;
  private meshEdges: import("three").LineSegments | null = null;
  private edgeGeometry: import("three").EdgesGeometry | null = null;
  private edgeMaterial: import("three").LineBasicMaterial | null = null;
  private wireframe = false;
  private showMesh = false;
  private deformer: ExpressionDeformer | null = null;
  private gazeWarper: EyeGazeWarper | null = null;
  private lastEyeGaze: import('../eyeGaze').NormalizedGaze | null = null;
  private meshEyeSpan = 0;
  private worldTransform: { x: number; y: number; scale: number; eyeSpanWorld: number } | null = null;
  private expressionEnvelope: ExpressionEnvelope | null = null;
  private expressionState: ExpressionValues = { ...NEUTRAL_EXPRESSION };
  private expressionRequested: ExpressionValues | null = null;
  private expressionApplied: ExpressionValues | null = null;
  private readonly expressionClamped: ExpressionKey[] = [];
  private readonly clampedExpression = { ...NEUTRAL_EXPRESSION };
  private expressionMs: number | null = null;
  private deformationMs: number | null = null;
  private mouthCompositorMs: number | null = null;
  private oralDiagnostics: OralDiagnostics = {mode:'live',active:false,frameAvailable:false,polygonValid:false,maskAreaPx:0,warpedPixels:0,averageLuminance:null,teethVisibleEstimate:null,cropBounds:null,maskBounds:null,frameAgeMs:null,cameraTimestampMs:null,faceResultTimestampMs:null,controlsTimestampMs:null,oralSourceTimestampMs:null,renderTimestampMs:null,droppedFrames:0,tongueMaskActive:false,tongueConfidence:null,extendedMaskActive:false};
  private oralDiagnosticsAt = -Infinity;
  private oralDroppedTimestamp = -1;
  private nostrilMesh: import('three').Mesh | null = null;
  private nostrilGeometry: import('three').BufferGeometry | null = null;
  private nostrilMaterial: import('three').MeshBasicMaterial | null = null;
  private noseDepth = 0;
  private displayInputAgeMs: number | null = null;
  private displayFrameAtMs: number | null = null;
  private renderStartMs: number | null = null;
  private renderEndMs: number | null = null;
  private lastExpressionAt = 0;
  private renderedMotion: RendererMotion | null = null;
  private expressionTrace: ExpressionTrace | null = null;

  constructor(private readonly options: FaceRendererOptions) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    FaceRenderer.owners.get(this.options.canvas)?.dispose();
    FaceRenderer.owners.set(this.options.canvas, this);
    this.initialization = this.start();
    return this.initialization;
  }

  private async start(): Promise<void> {
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
    if (this.cavityMaterial) this.cavityMaterial.wireframe = options.wireframe || options.showMesh;
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
    if (FaceRenderer.owners.get(this.options.canvas) === this) FaceRenderer.owners.delete(this.options.canvas);
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
    this.cavityMaterial?.dispose();
    this.fillMaterial?.dispose();
    this.nostrilGeometry?.dispose();
    this.nostrilMaterial?.dispose();
    this.nostrilGeometry=null;this.nostrilMaterial=null;this.nostrilMesh=null;
    this.liveMouthMaterial?.dispose();
    this.liveMouthTexture?.dispose();
    this.liveMouthGeometry?.dispose();
    this.texture?.dispose();
    this.textureBitmap?.close();
    this.geometry = null;
    this.edgeGeometry = null;
    this.edgeMaterial = null;
    this.material = null;
    this.cavityMaterial = null;
    this.fillMaterial = null;
    this.liveMouthMaterial = null;
    this.liveMouthTexture = null;
    this.liveMouthGeometry = null;
    this.liveMouthMesh = null;
    this.liveMouthCanvas?.getContext('2d')?.clearRect(0, 0, this.liveMouthCanvas.width, this.liveMouthCanvas.height);
    this.liveMouthCanvas = null;
    this.liveMouthTarget = [];
    this.liveMouthBasePositions = null;
    this.liveMouthMidY = 0;
    this.liveMouthHalfHeight = 0.001;
    this.liveMouthWidth = 0;
    this.liveMouthLastTimestamp = -1;
    this.liveMouthHasFrame = false;
    this.liveMouthOpacity = 0;
    this.liveMouthActive = false;
    this.texture = null;
    this.textureBitmap = null;
    this.deformer = null;
    this.gazeWarper = null;
    this.lastEyeGaze = null;
    this.expressionEnvelope = null;
    this.mesh = null;
    this.meshEdges = null;
    if (this.renderer) {
      this.renderer.dispose();
      // A source switch reuses the mounted canvas/context. Losing that context
      // here hands the next Three constructor a lost GL object (Safari can
      // return null precision formats). Release only a detached canvas.
      if (!this.contextFailed && !this.options.canvas.isConnected) this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  private createScene(): void {
    const three = this.three!;
    const context = faceWebGLContext(this.options.canvas);
    const renderer = new three.WebGLRenderer({ canvas: this.options.canvas, context, alpha: true, antialias: true });
    this.renderer = renderer;
    this.options.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.options.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    renderer.setClearColor(0x0f172a, 1);
    const scene = new three.Scene();
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    camera.position.z = 2;
    const meshData = buildSourceFaceMesh(this.options.profile.primaryFace.landmarks,
      this.options.profile.primaryFace, this.options.profile.dimensions?.aspectRatio ?? 1);
    this.deformer = new ExpressionDeformer(meshData, this.options.profile.primaryFace.landmarks);
    this.gazeWarper = new EyeGazeWarper(meshData.uvs, this.options.profile.primaryFace.landmarks, meshData.eyeInterior);
    this.meshEyeSpan = meshEyeSpan(meshData.positions);
    this.expressionEnvelope = deriveExpressionEnvelope(
      this.options.profile.expression ?? deriveSourceExpression(this.options.profile.primaryFace),
    );
    const geometry = new three.BufferGeometry();
    geometry.setAttribute("position", new three.BufferAttribute(this.deformer.positions, 3).setUsage(three.DynamicDrawUsage));
    geometry.setAttribute("uv", new three.BufferAttribute(meshData.uvs.slice(), 2).setUsage(three.DynamicDrawUsage));
    geometry.setIndex(new three.BufferAttribute(meshData.indices, 1));
    const mouth = meshData.mouth;
    // Cavity shading: the lip-ring edge is lighter than its depth, so an open
    // mouth reads as a recess rather than a flat patch. Only the cavity
    // material reads this attribute.
    const shade = new Float32Array(meshData.positions.length).fill(1);
    if (mouth) shade.fill(0.35, (mouth.cavityStart + mouth.cavityCount - 1) * 3, (mouth.cavityStart + mouth.cavityCount) * 3);
    geometry.setAttribute("color", new three.BufferAttribute(shade, 3));
    if (mouth) {
      geometry.addGroup(0, mouth.fillIndexStart, 0);
      geometry.addGroup(mouth.cavityIndexStart, mouth.cavityIndexCount, 1);
      geometry.addGroup(mouth.fillIndexStart, mouth.fillIndexCount, 2);
      geometry.addGroup(mouth.cavityIndexStart + mouth.cavityIndexCount, meshData.indices.length - mouth.cavityIndexStart - mouth.cavityIndexCount, 0);
    }
    geometry.computeVertexNormals();
    const texture = new three.Texture(this.textureBitmap!);
    texture.colorSpace = three.SRGBColorSpace;
    texture.wrapS = three.ClampToEdgeWrapping;
    texture.wrapT = three.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    const material = new three.MeshBasicMaterial({ map: texture, transparent: true, side: three.DoubleSide });
    // A fixed dark oral tone: nothing here samples or matches the source's skin.
    const cavityMaterial = mouth
      ? new three.MeshBasicMaterial({ color: 0x4a1a1e, vertexColors: true, transparent: true, side: three.DoubleSide })
      : null;
    const fillMaterial = mouth
      ? new three.MeshBasicMaterial({ map: texture, transparent: true, side: three.DoubleSide })
      : null;
    const mesh = new three.Mesh(geometry, cavityMaterial && fillMaterial ? [material, cavityMaterial, fillMaterial] : material);
    // The source's neutral pose is the local mesh. Only relative live motion is applied.
    scene.add(mesh);
    this.scene = scene;
    this.camera = camera;
    this.geometry = geometry;
    this.texture = texture;
    this.material = material;
    this.cavityMaterial = cavityMaterial;
    this.fillMaterial = fillMaterial;
    this.mesh = mesh;
    const nose=noseCavityData(meshData.positions);
    if(nose){
      const g=new three.BufferGeometry();g.setAttribute('position',new three.BufferAttribute(nose.positions,3));g.setAttribute('color',new three.BufferAttribute(nose.colors,3));g.setIndex(new three.BufferAttribute(nose.indices,1));
      const m=new three.MeshBasicMaterial({color:0x361b1b,vertexColors:true,transparent:true,opacity:0,depthWrite:false,side:three.DoubleSide});
      const recess=new three.Mesh(g,m);recess.renderOrder=1;scene.add(recess);
      this.nostrilGeometry=g;this.nostrilMaterial=m;this.nostrilMesh=recess;this.noseDepth=nose.depth;
    }
    if (mouth && fillMaterial) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 192;
      const context2d = canvas.getContext('2d');
      if (context2d) {
        const liveTexture = new three.CanvasTexture(canvas);
        liveTexture.colorSpace = three.SRGBColorSpace;
        liveTexture.wrapS = three.ClampToEdgeWrapping;
        liveTexture.wrapT = three.ClampToEdgeWrapping;
        const liveMaterial = new three.MeshBasicMaterial({
          map: liveTexture, transparent: true, opacity: 0, depthWrite: false,
          side: three.DoubleSide, toneMapped: false,
        });
        const liveGeometry = new three.BufferGeometry();
        const count = mouth.fillCount;
        const position = new Float32Array(meshData.positions.subarray(mouth.fillStart * 3, (mouth.fillStart + count) * 3));
        // Live interior is in front of the textured fill but remains behind
        // the source face surface and its lips.
        for (let i = 0; i < count; i++) position[i * 3 + 2] += 0.003;
        const minX = Math.min(...INNER_LIP_RING.map(i => meshData.localLandmarks![i]!.x));
        const maxX = Math.max(...INNER_LIP_RING.map(i => meshData.localLandmarks![i]!.x));
        const minY = Math.min(...INNER_LIP_RING.map(i => meshData.localLandmarks![i]!.y));
        const maxY = Math.max(...INNER_LIP_RING.map(i => meshData.localLandmarks![i]!.y));
        const target = INNER_LIP_RING.map(i => ({
          x: (meshData.localLandmarks![i]!.x - minX) / Math.max(1e-6, maxX - minX),
          y: (meshData.localLandmarks![i]!.y - minY) / Math.max(1e-6, maxY - minY),
        }));
        this.liveMouthTarget = target;
        const uv = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
          const point = target[i] ?? { x: 0.5, y: 0.5 };
          uv[i * 2] = point.x;
          uv[i * 2 + 1] = 1 - point.y;
        }
        const indices = new Uint16Array(INNER_LIP_RING.flatMap((_, i) => [INNER_LIP_RING.length, i, (i + 1) % INNER_LIP_RING.length]));
        liveGeometry.setAttribute('position', new three.BufferAttribute(position, 3).setUsage(three.DynamicDrawUsage));
        liveGeometry.setAttribute('uv', new three.BufferAttribute(uv, 2));
        liveGeometry.setIndex(new three.BufferAttribute(indices, 1));
        liveGeometry.computeVertexNormals();
        const liveMesh = new three.Mesh(liveGeometry, liveMaterial);
        liveMesh.renderOrder = 1;
        scene.add(liveMesh);
        this.liveMouthCanvas = canvas;
        this.liveMouthTexture = liveTexture;
        this.liveMouthMaterial = liveMaterial;
        this.liveMouthGeometry = liveGeometry;
        this.liveMouthMesh = liveMesh;
        this.liveMouthBasePositions = position.slice();
        this.liveMouthMidY = -(maxY + minY) / 2;
        this.liveMouthHalfHeight = Math.max(0.001, (maxY - minY) / 2);
        const ringX = INNER_LIP_RING.map((_, i) => position[i * 3]!);
        this.liveMouthWidth = Math.max(...ringX) - Math.min(...ringX);
      }
    }
    this.resize(this.options.canvas.clientWidth || 1, this.options.canvas.clientHeight || 1, window.devicePixelRatio);
  }

  private renderFrame = (now: number): void => {
    if (this.disposed || this.status === "failed") return;
    this.displayFrameAtMs = now;
    const elapsed = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;
    const motion = this.options.motion.current;
    const expression = this.options.manualExpression?.current ?? this.options.expression?.current ?? null;
    this.displayInputAgeMs = expression?.updatedAtMs === undefined ? null : Math.max(0, performance.now() - expression.updatedAtMs);
    if (this.options.paused?.current) {
      if (this.nostrilMaterial) this.nostrilMaterial.opacity = 0;
      smoothExpressionInto(this.expressionState, NEUTRAL_EXPRESSION, elapsed, this.expressionState);
      this.expressionApplied = this.expressionState;
      this.deformer?.update(this.expressionState);
      const position = this.geometry?.getAttribute("position") as import("three").BufferAttribute | undefined;
      if (position) position.needsUpdate = true;
      const uv = this.geometry?.getAttribute('uv') as import('three').BufferAttribute | undefined;
      if (uv && this.gazeWarper) { uv.array.set(this.gazeWarper.update(null)); uv.needsUpdate = true; }
      this.lastEyeGaze = null;
      this.updateLiveMouth(elapsed, true);
      this.renderStartMs = performance.now();
      this.renderer?.render(this.scene!, this.camera!);
      this.renderEndMs = performance.now();
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
      if (this.cavityMaterial) this.cavityMaterial.opacity = this.material.opacity;
    }
    const target = this.options.manualPose?.current ?? this.motionResult(motion).applied;
    // Hold briefly during tracker dropouts, then fade rather than snap to neutral.
    const safeTarget = this.options.manualPose?.current || motion.head ? target : !lost ? this.pose : NEUTRAL_FACE_RENDER_POSE;
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
      const uv = this.geometry?.getAttribute("uv") as import("three").BufferAttribute | undefined;
      if (uv && this.gazeWarper) {
        const measuredGaze = expression?.eyeGaze?.applied ?? (expression?.eyes ? { ...eyeGazeForRenderer(expression.eyes), clamped: false } : null);
        if (expression) this.lastEyeGaze = measuredGaze;
        else if (expressionLost && this.lastEyeGaze) {
          const alpha = Math.exp(-Math.min(100, elapsed) / 90);
          this.lastEyeGaze = { left: { x: this.lastEyeGaze.left.x * alpha, y: this.lastEyeGaze.left.y * alpha }, right: { x: this.lastEyeGaze.right.x * alpha, y: this.lastEyeGaze.right.y * alpha }, clamped: false };
        }
        uv.array.set(this.gazeWarper.update(this.lastEyeGaze, { left: this.expressionState.eyes?.[EYE_RENDER_CHANNELS.left].wideOpen ?? 0, right: this.expressionState.eyes?.[EYE_RENDER_CHANNELS.right].wideOpen ?? 0 }));
        uv.needsUpdate = true;
      }
      this.updateLiveMouth(elapsed, false);
      const started = performance.now();
      this.renderStartMs = started;
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
      this.scene.scale.x = flip;
      // Glued framing: where, and how large, the camera preview shows the face.
      // Unmirrored world position; the scene's negative x scale is the one
      // display flip, exactly as the camera preview does it.
      const canvas = this.options.canvas;
      const world = faceWorldTransform(this.pose, this.meshEyeSpan,
        { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height },
        this.options.framing?.current ?? null);
      this.worldTransform = world;
      this.mesh.position.set(world.x, world.y, 0);
      this.mesh.scale.setScalar(world.scale);
      this.mesh.rotation.set(rendered.rotationX, rendered.rotationY, rendered.rotationZ, "XYZ");
      if(this.nostrilMesh && this.nostrilMaterial){
        this.nostrilMesh.position.copy(this.mesh.position);this.nostrilMesh.scale.copy(this.mesh.scale);this.nostrilMesh.rotation.copy(this.mesh.rotation);
        this.nostrilMaterial.opacity=nostrilVisibility(this.pose.pitch)*(this.material?.opacity ?? 1);
      }
      if (this.liveMouthMesh) {
        this.liveMouthMesh.position.copy(this.mesh.position);
        this.liveMouthMesh.scale.copy(this.mesh.scale);
        this.liveMouthMesh.rotation.copy(this.mesh.rotation);
      }
      this.material!.wireframe = this.wireframe || this.showMesh;
      if (this.cavityMaterial) this.cavityMaterial.wireframe = this.material!.wireframe;
      this.renderer.render(this.scene, this.camera);
      const renderMs = performance.now() - started;
      this.renderEndMs = performance.now();
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
    this.contextLossCount++;
    this.status = "failed";
    this.publish(FACE_WEBGL_UNAVAILABLE);
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
      expressionLeakage: this.options.expression?.current?.leakage ?? false,
      eyes: this.options.expression?.current
        ? { aperture: this.options.expression.current.eyeAperture ?? null, state: this.options.expression.current.blinkState ?? null }
        : null,
      meshVertices: this.geometry?.getAttribute('position').count ?? 0,
      meshTriangles: (this.geometry?.index?.count ?? 0) / 3,
      depthRange: this.depthRange(),
      dpr: this.renderer?.getPixelRatio() ?? 0,
      contextLossCount: this.contextLossCount,
      fps,
      renderMs,
      displayInputAgeMs: this.displayInputAgeMs,
      displayFrameAtMs: this.displayFrameAtMs,
      renderStartMs: this.renderStartMs,
      renderEndMs: this.renderEndMs,
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
      mouthCompositorMs: this.mouthCompositorMs,
      vertexDisplacementMax: probe.vertexDisplacementMax,
      vertexDisplacementPx: probe.vertexDisplacementPx,
      faceWidthPx: probe.faceWidthPx,
      expressionTrace: this.expressionTrace,
      mouthFeedOpacity: this.liveMouthOpacity,
      mouthMaskStatus: this.mouthMaskStatus,
      oral: {...this.oralDiagnostics},
      nosePerspective:{depth:this.noseDepth,visibility:nostrilVisibility(this.pose.pitch),requestedPitch:this.options.manualPose?.current?.pitch ?? this.motionResult(this.options.motion.current).requested.pitch,appliedPitch:this.pose.pitch},
      ...this.mouthGeometryMetrics(),
    });
  }

  private mouthGeometryMetrics(): Pick<FaceRendererStats, "mouthMeshAperturePx" | "jawChinMovementPx"> {
    if (!this.deformer) return { mouthMeshAperturePx: null, jawChinMovementPx: null };
    const base = this.deformer.basePositions;
    const applied = this.deformer.positions;
    const height = this.options.canvas.clientHeight || this.options.canvas.height;
    const pixelsPerUnit = height * (this.mesh?.scale.y ?? 1) / 2;
    const aperture = (positions: Float32Array) => Math.abs(positions[13 * 3 + 1]! - positions[14 * 3 + 1]!) * pixelsPerUnit;
    const chinOffset = Math.abs(applied[152 * 3 + 1]! - base[152 * 3 + 1]!) * pixelsPerUnit;
    return {
      mouthMeshAperturePx: { neutral: aperture(base), applied: aperture(applied) },
      jawChinMovementPx: chinOffset,
    };
  }

  /** The renderer's existing RAF owns this transient warp; there is no extra loop. */
  private updateLiveMouth(elapsedMs: number, suppress: boolean): void {
    const enabled = !suppress && this.options.liveMouthEnabled?.current === true;
    const mode = this.options.oralInteriorMode?.current ?? 'live';
    this.oralDiagnostics.mode = mode;
    if (!enabled && this.liveMouthOpacity === 0 && !this.liveMouthHasFrame) {
      this.liveMouthActive = false;
      this.oralDiagnostics.active = false;
      this.mouthMaskStatus='disabled';
      this.mouthCompositorMs = 0;
      return;
    }
    const started = performance.now();
    const expression = this.options.expression?.current;
    const video = this.options.liveMouthVideoRef?.current ?? null;
    const mouth = expression?.liveMouth;
    const sourceFrame=mouth?.sourceFrame ?? video;
    const sourceWidth=mouth?.sourceFrame?.width ?? video?.videoWidth ?? 0;
    const sourceHeight=mouth?.sourceFrame?.height ?? video?.videoHeight ?? 0;
    const opening = Math.max(this.expressionApplied?.mouth?.jaw.open ?? this.expressionApplied?.jawOpen ?? 0,
      (this.expressionApplied?.mouth?.lips.funnel ?? 0)*.4);
    const canvas = this.liveMouthCanvas;
    const base=this.deformer?.basePositions, current=this.deformer?.positions;
    const sourceGap=base ? Math.abs(base[13*3+1]!-base[14*3+1]!) : 0;
    const renderedGap=current ? Math.abs(current[13*3+1]!-current[14*3+1]!) : 0;
    const feedAllowed=oralFeedAllowed(mode,sourceGap,renderedGap,this.liveMouthWidth);
    if (!enabled || !mouth || !video || video.readyState < 2) this.liveMouthActive = false;
    else if (this.liveMouthActive ? opening <= 0.06 : opening >= 0.12) this.liveMouthActive = !this.liveMouthActive;
    // Legacy unclocked scalar fixtures remain supported; production canonical
    // controls always carry completion time and expire after a bounded hold.
    const fresh = !!mouth && (oralFrameFresh(expression?.updatedAtMs,performance.now()) || (expression?.updatedAtMs===undefined && !expression?.mouth));
    const trustworthy = !expression?.mouth || expression.mouth.confidence >= .35;
    const wantsFeed = enabled && feedAllowed && trustworthy && this.liveMouthActive && fresh && !!mouth && !!video && video.readyState >= 2;
    const metrics=mouth && sourceFrame ? mouthMaskMetrics(mouth.ring,sourceWidth,sourceHeight) : null;
    this.oralDiagnostics.frameAvailable=!!video && video.readyState>=2;
    this.oralDiagnostics.polygonValid=metrics?.valid ?? false;
    this.oralDiagnostics.maskAreaPx=metrics?.area ?? 0;
    this.oralDiagnostics.cropBounds=metrics?.bounds ?? null;
    this.oralDiagnostics.frameAgeMs=expression?.updatedAtMs===undefined ? null : Math.max(0,performance.now()-expression.updatedAtMs);
    this.oralDiagnostics.cameraTimestampMs=mouth?.sourceFrame ? mouth.timestampMs : video ? video.currentTime*1000 : null;
    this.oralDiagnostics.faceResultTimestampMs=mouth?.timestampMs ?? null;
    this.oralDiagnostics.controlsTimestampMs=expression?.mouth?.timestampMs ?? null;
    this.oralDiagnostics.renderTimestampMs=performance.now();
    if(!fresh && mouth && this.oralDroppedTimestamp!==mouth.timestampMs){this.oralDiagnostics.droppedFrames++;this.oralDroppedTimestamp=mouth.timestampMs;}
    this.mouthMaskStatus=!enabled?'disabled':!mouth||!video||video.readyState<2?'unavailable':!fresh?'stale':!trustworthy?'invalid':!feedAllowed||!this.liveMouthActive?'closed':this.liveMouthHasFrame?'ready':'unavailable';
    if (wantsFeed && mouth && video && mouth.timestampMs !== this.liveMouthLastTimestamp && canvas) {
      const context = canvas.getContext('2d');
      const target=mouthTextureTarget(mouth.ring,sourceWidth,sourceHeight,canvas.width,canvas.height);
      if (context && sourceFrame && drawWarpedMouth(context, sourceFrame, mouth.ring, target,
        canvas.width, canvas.height, sourceWidth, sourceHeight)) {
        this.liveMouthLastTimestamp = mouth.timestampMs;
        this.liveMouthHasFrame = true;
        this.mouthMaskStatus='ready';
        this.oralDiagnostics.oralSourceTimestampMs=mouth.timestampMs;
        if(import.meta.env.DEV && performance.now()-this.oralDiagnosticsAt>=250){
          this.oralDiagnosticsAt=performance.now();
          const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
          let count=0,luma=0,teeth=0,minX=canvas.width,maxX=0,minY=canvas.height,maxY=0;
          for(let k=0;k<pixels.length;k+=4){if(pixels[k+3]!<128)continue;count++;const r=pixels[k]!,g=pixels[k+1]!,b=pixels[k+2]!;luma+=.2126*r+.7152*g+.0722*b;if(Math.min(r,g,b)>175 && Math.max(r,g,b)-Math.min(r,g,b)<45)teeth++;const i=k/4,x=i%canvas.width,y=Math.floor(i/canvas.width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
          this.oralDiagnostics.warpedPixels=count;
          this.oralDiagnostics.averageLuminance=count ? luma/count : null;
          this.oralDiagnostics.teethVisibleEstimate=count ? teeth/count : null;
          this.oralDiagnostics.maskBounds=count ? {minX,maxX,minY,maxY} : null;
        }
        if (this.liveMouthTexture) this.liveMouthTexture.needsUpdate = true;
      }else{
        this.liveMouthHasFrame=false;
        this.mouthMaskStatus='invalid';
      }
    }
    const targetOpacity = wantsFeed && this.liveMouthHasFrame ? 1 : 0;
    this.oralDiagnostics.active = targetOpacity === 1;
    const alpha = 1 - Math.exp(-Math.min(100, Math.max(0, elapsedMs)) / 85);
    this.liveMouthOpacity += (targetOpacity - this.liveMouthOpacity) * alpha;
    if (this.liveMouthOpacity < 0.005 && targetOpacity === 0) {
      this.liveMouthOpacity = 0;
      if (this.liveMouthHasFrame && this.liveMouthCanvas) {
        this.liveMouthCanvas.getContext('2d')?.clearRect(0, 0, this.liveMouthCanvas.width, this.liveMouthCanvas.height);
        this.liveMouthHasFrame = false;
        this.liveMouthLastTimestamp = -1;
        this.oralDiagnostics.warpedPixels=0;
        this.oralDiagnostics.averageLuminance=null;
        this.oralDiagnostics.teethVisibleEstimate=null;
        this.oralDiagnostics.maskBounds=null;
        if (this.liveMouthTexture) this.liveMouthTexture.needsUpdate = true;
      }
    }
    if (this.liveMouthMaterial) this.liveMouthMaterial.opacity = this.liveMouthOpacity*(this.material?.opacity ?? 1);
    if (this.fillMaterial) this.fillMaterial.opacity = (1 - this.liveMouthOpacity)*(this.material?.opacity ?? 1);
    const position = this.liveMouthGeometry?.getAttribute('position') as import('three').BufferAttribute | undefined;
    if (position && this.liveMouthBasePositions && this.deformer) {
      const vertices=this.deformer.positions;
      const uv=this.liveMouthGeometry!.getAttribute('uv') as import('three').BufferAttribute;
      const currentRing=INNER_LIP_RING.map(anchor=>({x:vertices[anchor*3]!,y:-vertices[anchor*3+1]!}));
      const mapped=mouthTextureTarget(currentRing,1,1,canvas?.width ?? 256,canvas?.height ?? 192);
      if(mouth && video){
        const liveMapped=mouthTextureTarget(mouth.ring,sourceWidth,sourceHeight,canvas?.width ?? 256,canvas?.height ?? 192);
        const fit=oralContentFit(liveMapped,mapped);
        for(const p of mapped){p.x=.5+(p.x-.5)/fit;p.y=.15+(p.y-.15)/fit;}
      }
      const centreUv=mapped.reduce((sum,p)=>({x:sum.x+p.x/mapped.length,y:sum.y+p.y/mapped.length}),{x:0,y:0});
      let x=0,y=0,z=0;
      for(const [i,anchor] of INNER_LIP_RING.entries()){
        const px=vertices[anchor*3]!,py=vertices[anchor*3+1]!,pz=vertices[anchor*3+2]!-.005;
        position.setXYZ(i,px,py,pz);x+=px;y+=py;z+=pz;
        uv.setXY(i,mapped[i]!.x,1-mapped[i]!.y);
      }
      const n=INNER_LIP_RING.length;
      position.setXYZ(n,x/n,y/n,z/n);
      uv.setXY(n,centreUv.x,1-centreUv.y);
      uv.needsUpdate=true;
      position.needsUpdate = true;
    }
    this.mouthCompositorMs = performance.now() - started;
  }

  /** Apply both the conservative M7 envelope and the measured source envelope. */
  private motionResult(motion: CalibrationMotion): FaceRenderPoseResult {
    return poseFromSourceMotion(motion, this.options.profile.movementEnvelope);
  }

  private depthRange(): number {
    const p = this.deformer?.basePositions;
    if (!p) return 0;
    let min = Infinity, max = -Infinity;
    for (let i = 2; i < p.length; i += 3) { min = Math.min(min, p[i]!); max = Math.max(max, p[i]!); }
    return max - min;
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
    /** On-screen placement after the mirror, in canvas pixels. */
    screen: FaceScreenProbe | null;
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
    let actualNose = vectors ? { ...vectors.nose, x: vectors.nose.x * flip } : null;
    let actualUp = vectors ? { ...vectors.up, x: vectors.up.x * flip } : null;
    if (this.mesh && this.three) {
      this.scene?.updateMatrixWorld(true);
      actualNose = new this.three.Vector3(0, 0, 1).transformDirection(this.mesh.matrixWorld);
      actualUp = new this.three.Vector3(0, 1, 0).transformDirection(this.mesh.matrixWorld);
    }

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
    const scale = this.worldTransform?.scale ?? (motion?.scale ?? 1) * 2.0;
    const pxPerWorld = heightPx / 2;

    /*
     * Where the face actually landed ON SCREEN, after the mirror: the pivot,
     * the two outer eye corners and the nose tip, in canvas pixels. What a
     * person watching the canvas would measure, so a test can compare it with
     * where the camera preview shows the operator.
     */
    let screen: FaceScreenProbe | null = null;
    const deformed = this.deformer?.positions;
    if (this.mesh && this.camera && this.three && deformed) {
      const widthPx = this.options.canvas.clientWidth || this.options.canvas.width || 1;
      const project = (local: [number, number, number]) => {
        const v = new this.three!.Vector3(...local).applyMatrix4(this.mesh!.matrixWorld).project(this.camera!);
        return { x: ((v.x + 1) / 2) * widthPx, y: ((1 - v.y) / 2) * heightPx };
      };
      const vertex = (i: number): [number, number, number] => [deformed[i * 3]!, deformed[i * 3 + 1]!, deformed[i * 3 + 2]!];
      const left = project(vertex(33));
      const right = project(vertex(263));
      screen = {
        pivot: project([0, 0, 0]),
        nose: project(vertex(1)),
        eyeSpanPx: Math.hypot(left.x - right.x, left.y - right.y),
        eyeAngleDeg: (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI,
      };
    }

    return {
      motion,
      nose: actualNose,
      up: actualUp,
      screen,
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
  if (profile.preparedFrame) return createImageBitmap(profile.preparedFrame);
  const reader = new VideoFrameReader();
  try {
    await reader.open(asset.blob);
    const timestamp = profile.baseFrameTime ?? profile.referenceFrames.find(frame => frame.angle === 'front')?.timestampSeconds ?? 0;
    return await createImageBitmap(await reader.frameAt(timestamp));
  } finally { reader.dispose(); }
}
