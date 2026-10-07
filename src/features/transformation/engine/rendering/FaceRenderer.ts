import { loadThreeRenderer } from "../../loaders";
import type { SourceAsset } from "../../source/sourceAsset";
import type { TransformationSourceProfile } from "../../source/sourceTypes";
import type { CalibrationMotion } from "../relativeMotion";
import type { FaceFrameSnapshot } from "../faceFrame";
import { boundaryCorrectionLimit, coverageExtensionScale, featherExtensionScale, responseGain, scaleFollowRatio, sourceSurfaceAlpha, type TransformationControlsRef } from "../transformationControls";
import { mapNormalizedToDisplay } from "../coordinateMapping";
import {
  EXPRESSION_KEYS, clampExpression, deriveExpressionEnvelope, deriveSourceExpression,
  clampExpressionInto, NEUTRAL_EXPRESSION, smoothExpressionInto,
  type ExpressionKey, type ExpressionMotion, type ExpressionValues, type ExpressionEnvelope,
  type ExpressionTrace,
} from "../expressionMotion";

import {
  FACE_RENDER_LIMITS,
  NEUTRAL_FACE_RENDER_POSE,
  poseFromSourceMotion,
  smoothFaceRenderPose,
  poseFromMotion,
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
import { buildSourceFaceMesh, type FaceBoundaryLoop } from "./sourceMesh";
import { faceWorldTransform, meshEyeSpan, type FaceRenderFraming } from "./faceFraming";
import { ExpressionDeformer } from "./expressionDeformer";
import { faceWebGLContext, FACE_WEBGL_UNAVAILABLE } from './webglPreflight';
import { VideoFrameReader } from '../../source/videoFrameReader';
import { drawPerioralPatch, mouthMaskMetrics, perioralRegion, oralFrameFresh, type MouthPoint, type OralInteriorMode } from './liveMouthCompositor';
import { FACE_LANDMARK_VERTICES, INNER_LIP_RING, OUTER_LIP_RING } from './sourceMesh';
import { CanonicalMouthStabilizer, canonicalMouthRings, measureLiveMouth, mouthMeshIndices, perioralLocalRing, type MouthFilterStats } from './canonicalLiveMouth';
import { EyeGazeWarper } from "./eyeGazeWarper";
import { EYE_RENDER_CHANNELS, eyeGazeForRenderer } from '../eyeControls';
import { noseCavityData, nostrilVisibility } from './noseCavities';
import { buildProjectionBindings, projectLiveMeshPositions, type ProjectionBinding } from "./liveMeshProjection";
import { estimateFacialHairMask } from "./facialHairMask";
import {
  applyBoundaryCorrections,
  BOUNDARY_SKIN_REGIONS,
  estimateBoundaryCorrections,
  NEUTRAL_BOUNDARY_CORRECTION,
  sampleImageRegion,
  smoothBoundaryCorrections,
  type BoundaryColorCorrection,
  type BoundaryRgb,
} from "./boundaryHarmonization";

const LIVE_LIP_INDICES = new Set<number>([
  ...OUTER_LIP_RING, ...INNER_LIP_RING,
  // The source mesh's two oral fans follow the lip rings after vertex 468.
  ...Array.from({ length: OUTER_LIP_RING.length + INNER_LIP_RING.length + 2 },
    (_, index) => FACE_LANDMARK_VERTICES + index),
]);
export type MouthDebugLayer = "rawOuter" | "rawInner" | "stableOuter" | "stableInner" | "mask" | "feather";
const MOUTH_DEBUG_COLORS: Record<MouthDebugLayer, number> = {
  rawOuter: 0x39e779, rawInner: 0x38e4eb, stableOuter: 0x3976ff,
  stableInner: 0xad58ff, mask: 0xff3f55, feather: 0xffd447,
};

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
  boundaryLoops?: readonly FaceBoundaryLoop[];
  faceFrame?: FaceFrameSnapshot | null;
  attachmentProbe?: ReturnType<FaceRenderer["getAttachmentProbe"]>;
  contourAlignment?: readonly ContourAlignmentSample[];
  alphaPipeline?: "straight texture/shader → premultiplied framebuffer/canvas";
  boundaryBlendMs?: number | null;
  boundaryColorCorrection?: readonly BoundaryColorCorrection[];
  poseAlignment?: Readonly<Record<"leftYaw" | "rightYaw" | "upPitch" | "downPitch", { angleDeg: number | null; errorPx: number | null; count: number }>>;
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
  canonicalMouth?: CanonicalMouthDiagnostics | null;
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

export interface ContourAlignmentSample {
  region: "forehead" | "left-temple" | "right-temple" | "left-cheek" | "right-cheek" | "chin" | "nose-center";
  landmarkIndex: number;
  live: { x: number; y: number };
  rendered: { x: number; y: number };
  errorPx: number;
}

/** Temporary developer-only override for proving visible root movement. */
export interface FaceRootMotionDebug {
  mode: "tracking" | "raw-direct" | "manual" | "oscillator";
  /** Absolute orthographic world position while mode is manual. */
  x: number;
  y: number;
  /** Multiplier against the calibrated neutral face size. */
  scale: number;
  rollDeg: number;
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
  faceWidthPx?: number | null;
  mouthWidthPx?: number | null;
  featherSigmaPx?: number | null;
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

export interface CanonicalMouthDiagnostics {
  liveWidth: number;
  renderedWidth: number;
  widthRatio: number;
  liveOuterHeight: number;
  renderedOuterHeight: number;
  liveOpeningHeight: number;
  renderedOpeningHeight: number;
  openingRatio: number;
  liveOpeningWidth: number;
  renderedOpeningWidth: number;
  center: { x: number; y: number };
  leftCorner: { x: number; y: number };
  rightCorner: { x: number; y: number };
  openRatio: number;
  heightRatio: number;
  filter: MouthFilterStats;
  yaw: number;
  pitch: number;
  roll: number;
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
  mouthDebugLayers?: { current: Partial<Record<MouthDebugLayer, boolean>> };
  /** The tracking loop owns writes to this ref. Rendering never starts inference. */
  motion: { current: CalibrationMotion };
  expression?: { current: ExpressionMotion | null };
  /** Atomic transform + expression snapshot from one camera inference frame. */
  faceFrame?: { current: FaceFrameSnapshot | null };
  /** Developer-only forced/manual placement. A tracking mode leaves live motion untouched. */
  rootMotionDebug?: { current: FaceRootMotionDebug | null };
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
  mirror?: RenderMirrorMode | { current: RenderMirrorMode };
  /**
   * Where the operator's neutral face sat in the camera frame. Present once
   * calibrated: the face is then drawn where, and as large as, the camera
   * preview shows it — see `faceFraming.ts`.
   */
  framing?: { current: FaceRenderFraming | null };
  /** One authoritative live control model, read without restarting the renderer. */
  controls?: TransformationControlsRef;
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
  /** Single placement ancestor of skin/mask, nose and live mouth geometry. */
  private faceRoot: import("three").Group | null = null;
  /** Textured skin/mask mesh; eye pixels and gaze UVs are part of this surface. */
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
  private liveMouthLastTimestamp = -1;
  private liveMouthHasFrame = false;
  private liveMouthOpacity = 0;
  private liveMouthActive = false;
  private readonly canonicalMouthFilter = new CanonicalMouthStabilizer();
  private liveMouthCanonical = false;
  private canonicalMouthDiagnostics: CanonicalMouthDiagnostics | null = null;
  private mouthDebugLines: Partial<Record<MouthDebugLayer, import('three').LineLoop>> = {};
  private mouthMaskStatus:NonNullable<FaceRendererStats['mouthMaskStatus']>='disabled';
  private texture: import("three").Texture | null = null;
  private meshEdges: import("three").LineSegments | null = null;
  private edgeGeometry: import("three").EdgesGeometry | null = null;
  private edgeMaterial: import("three").LineBasicMaterial | null = null;
  private boundaryLines: { line: import("three").LineLoop; vertices: number[] }[] = [];
  private faceLockLines: { line: import("three").LineLoop; vertices: number[] }[] = [];
  private coveragePreviewLines: { line: import("three").Line; vertices: number[] }[] = [];
  private boundaryLoopStats: FaceBoundaryLoop[] = [];
  private baseColors: Float32Array | null = null;
  private boundaryAlpha: Float32Array | null = null;
  private coverageBoundaryVertices: number[] = [];
  private coverageExtensionVertices: number[] = [];
  private coverageExtensionRegions: Uint8Array = new Uint8Array();
  private sourceFacialHairWeights: Float32Array | null = null;
  private sourceFacialHairPresent = false;
  private sourceForeheadExtensionLimit: number | null = null;
  private boundarySourceCanvas: HTMLCanvasElement | null = null;
  private boundarySourcePixels: Uint8ClampedArray | null = null;
  private boundarySourceSamples: (BoundaryRgb | null)[] = [];
  private boundaryCurrentCorrection: readonly BoundaryColorCorrection[] = NEUTRAL_BOUNDARY_CORRECTION;
  private boundaryLastLiveSamples: readonly (BoundaryRgb | null)[] = [];
  private boundaryControlSignature = "";
  private boundaryLastSampleAt = -Infinity;
  private boundaryLastUpdateAt = 0;
  private boundaryBlendMs: number | null = null;
  private boundaryRegionAnchors: { x: number; y: number }[] = [];
  private showBoundaries = false;
  private showWeights = false;
  private showFaceLockDebug = false;
  private wireframe = false;
  private showMesh = false;
  private showMask = false;
  private deformer: ExpressionDeformer | null = null;
  private gazeWarper: EyeGazeWarper | null = null;
  private lastEyeGaze: import('../eyeGaze').NormalizedGaze | null = null;
  private meshEyeSpan = 0;
  private worldTransform: { x: number; y: number; scale: number; eyeSpanWorld: number } | null = null;
  private expressionEnvelope: ExpressionEnvelope | null = null;
  private expressionState: ExpressionValues = { ...NEUTRAL_EXPRESSION };
  private responseExpression: ExpressionValues = { ...NEUTRAL_EXPRESSION };
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
  private lastAppliedFaceFrame: FaceFrameSnapshot | null = null;
  private projectionBindings: ProjectionBinding[] = [];
  private contourAlignment: ContourAlignmentSample[] = [];
  private lastAlignmentFrameId = -1;
  private readonly poseAlignmentSamples: Record<"leftYaw" | "rightYaw" | "upPitch" | "downPitch", { angle: number; error: number }[]> = {
    leftYaw: [], rightYaw: [], upPitch: [], downPitch: [],
  };

  constructor(private readonly options: FaceRendererOptions) {}

  private initializeBoundarySampler(
    localLandmarks: readonly { x: number; y: number }[],
    sourceLandmarks: readonly { x: number; y: number }[],
  ): void {
    const appearance = this.options.profile.appearance?.facialHair;
    if (appearance && appearance.mask.length >= 468) {
      this.setSourceFacialHairEstimate({ weights: Float32Array.from(appearance.mask.slice(0, 468)), present: appearance.present });
    }
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 96;
    sourceCanvas.height = 96;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext || !this.textureBitmap) return;
    try {
      sourceContext.drawImage(this.textureBitmap, 0, 0, sourceCanvas.width, sourceCanvas.height);
      this.boundarySourcePixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
    } catch {
      return;
    }
    this.boundarySourceCanvas = sourceCanvas;
    const sourceCenter = sourceLandmarks[1];
    this.boundarySourceSamples = BOUNDARY_SKIN_REGIONS.map(({ landmark }) => {
      const point = sourceLandmarks[landmark];
      if (!point || !sourceCenter || !this.boundarySourcePixels) return null;
      return sampleImageRegion(this.boundarySourcePixels, sourceCanvas.width, sourceCanvas.height, {
        x: point.x + (sourceCenter.x - point.x) * 0.18,
        y: point.y + (sourceCenter.y - point.y) * 0.18,
      });
    });
    this.boundaryRegionAnchors = BOUNDARY_SKIN_REGIONS.flatMap(({ landmark }) => {
      const point = localLandmarks[landmark];
      return point ? [{ x: point.x, y: -point.y }] : [];
    });
    if (!appearance || appearance.mask.length < 468) {
      this.setSourceFacialHairEstimate(estimateFacialHairMask(this.boundarySourcePixels!, sourceCanvas.width, sourceCanvas.height, this.options.profile.primaryFace.landmarks));
    }
  }

  private setSourceFacialHairEstimate(estimated: { weights: Float32Array; present: boolean }): void {
    const count = (this.deformer?.positions.length ?? 0) / 3;
    this.sourceFacialHairWeights = new Float32Array(count);
    this.sourceFacialHairPresent = estimated.present;
    if (estimated.present) {
      for (let vertex = 0; vertex < Math.min(468, count, estimated.weights.length); vertex++) {
        this.sourceFacialHairWeights[vertex] = estimated.weights[vertex]!;
      }
      for (let index = 0; index < this.coverageBoundaryVertices.length; index++) {
        const boundary = this.coverageBoundaryVertices[index]!;
        const extension = this.coverageExtensionVertices[index]!;
        this.sourceFacialHairWeights[extension] = this.sourceFacialHairWeights[boundary] ?? 0;
      }
    }
  }

  private updateBoundaryHarmonization(frame: FaceFrameSnapshot | null, now: number): void {
    if (!this.geometry || !this.baseColors || !this.boundaryAlpha || !this.deformer || this.showMask || this.showWeights) return;
    const startedAt = performance.now();
    const sampleTimestamp = frame?.boundarySkinSampleTimestampMs ?? null;
    const hasNewSample = sampleTimestamp !== null && sampleTimestamp !== this.boundaryLastSampleAt;
    const controls = this.options.controls?.current;
    const blendControls = controls?.blending;
    const preserveTexture = controls?.appearance.preserveSourceTexture !== false;
    const controlSignature = [blendControls?.skinMatch, blendControls?.luminanceMatch, blendControls?.chromaMatch,
      blendControls?.shadowCorrection, preserveTexture].join(":");
    const controlsChanged = controlSignature !== this.boundaryControlSignature;
    if (hasNewSample && frame?.boundarySkinSamples) {
      this.boundaryLastSampleAt = sampleTimestamp;
      this.boundaryLastLiveSamples = frame.boundarySkinSamples;
    }
    if (hasNewSample || controlsChanged) {
      this.boundaryControlSignature = controlSignature;
      try {
        const maxChange = boundaryCorrectionLimit(blendControls?.skinMatch ?? 68, preserveTexture);
        const estimated = estimateBoundaryCorrections(this.boundarySourceSamples, this.boundaryLastLiveSamples, maxChange);
        const luminanceStrength = (blendControls?.luminanceMatch ?? 68) / 100 * (0.25 + 0.75 * (blendControls?.shadowCorrection ?? 40) / 100);
        const chromaStrength = (blendControls?.chromaMatch ?? 68) / 100;
        const target = estimated.map(correction => {
          const luminance = 0.2126 * correction.r + 0.7152 * correction.g + 0.0722 * correction.b;
          const mix = (channel: number) => {
            const chroma = luminance > 1e-5 ? channel / luminance : 1;
            return Math.max(0.7, Math.min(1.3, 1 + (luminance - 1) * luminanceStrength + (chroma - 1) * chromaStrength));
          };
          return { r: mix(correction.r), g: mix(correction.g), b: mix(correction.b) };
        });
        const deltaMs = this.boundaryLastUpdateAt ? now - this.boundaryLastUpdateAt : 125;
        this.boundaryCurrentCorrection = smoothBoundaryCorrections(this.boundaryCurrentCorrection, target, deltaMs, 650);
        this.boundaryLastUpdateAt = now;
        const color = this.geometry.getAttribute("color") as import("three").BufferAttribute;
        applyBoundaryCorrections(
          color.array as Float32Array,
          this.baseColors,
          this.boundaryAlpha,
          this.deformer.positions,
          this.boundaryRegionAnchors,
          this.boundaryCurrentCorrection,
        );
        color.needsUpdate = true;
      } catch {
        // An unavailable sample skips appearance matching without interrupting
        // the tracking/render loop.
      }
    }
    this.boundaryBlendMs = (hasNewSample ? frame?.boundarySkinSampleCostMs ?? 0 : 0) + performance.now() - startedAt;
  }

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

  setDiagnostics(options: { showMesh: boolean; wireframe: boolean; showMask?: boolean; showBoundaries?: boolean; showWeights?: boolean; showFaceLockDebug?: boolean }): void {
    this.showMesh = options.showMesh;
    this.wireframe = options.wireframe;
    this.showMask = options.showMask ?? false;
    this.showBoundaries = options.showBoundaries ?? false;
    this.showWeights = options.showWeights ?? false;
    this.showFaceLockDebug = options.showFaceLockDebug ?? false;
    const showMask = this.showMask || this.showWeights;
    if (this.material) {
      this.material.wireframe = options.wireframe || options.showMesh;
      this.material.map = showMask ? null : this.texture;
      this.material.needsUpdate = true;
    }
    if (this.fillMaterial) {
      this.fillMaterial.wireframe = options.wireframe || options.showMesh;
      this.fillMaterial.map = showMask ? null : this.texture;
      this.fillMaterial.needsUpdate = true;
    }
    if (this.cavityMaterial) {
      this.cavityMaterial.wireframe = options.wireframe || options.showMesh;
      this.cavityMaterial.color.set(showMask ? 0xffffff : 0x4a1a1e);
    }
    if (this.mesh) this.mesh.visible = true;
    if (this.nostrilMesh) this.nostrilMesh.visible = !showMask;
    if (this.liveMouthMesh) this.liveMouthMesh.visible = !showMask;
    if (this.meshEdges) this.meshEdges.visible = options.showMesh;
    for (const { line } of this.boundaryLines) line.visible = this.showBoundaries;
    for (const { line } of this.coveragePreviewLines) line.visible = this.showBoundaries;
    for (const { line } of this.faceLockLines) line.visible = this.showFaceLockDebug;
    const color = this.geometry?.getAttribute("color") as import("three").BufferAttribute | undefined;
    if (color && this.baseColors) {
      const values = color.array as Float32Array;
      for (let vertex = 0; vertex < values.length / 4; vertex++) {
        if (this.showWeights) {
          const alpha = this.deformer && vertex < this.deformer.basePositions.length / 3
            ? this.getBoundaryAlpha(vertex) : 1;
          values[vertex * 4] = 1 - alpha;
          values[vertex * 4 + 1] = alpha;
          values[vertex * 4 + 2] = 0;
          values[vertex * 4 + 3] = 1;
        } else values.set(this.baseColors.subarray(vertex * 4, vertex * 4 + 4), vertex * 4);
      }
      color.needsUpdate = true;
    }
  }

  private getBoundaryAlpha(vertex: number): number {
    // The immutable render alpha is retained alongside its RGBA color.
    return this.baseColors?.[vertex * 4 + 3] ?? 1;
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
    for (const { line } of this.boundaryLines) {
      line.geometry.dispose();
      for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose();
    }
    for (const { line } of this.faceLockLines) {
      line.geometry.dispose();
      for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose();
    }
    for (const { line } of this.coveragePreviewLines) {
      line.geometry.dispose();
      for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose();
    }
    this.boundaryLines = [];
    this.faceLockLines = [];
    this.coveragePreviewLines = [];
    this.boundaryLoopStats = [];
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
    for (const line of Object.values(this.mouthDebugLines)) {
      line.geometry.dispose();
      (line.material as import('three').Material).dispose();
    }
    this.mouthDebugLines = {};
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
    this.boundarySourceCanvas?.getContext("2d")?.clearRect(0, 0, this.boundarySourceCanvas.width, this.boundarySourceCanvas.height);
    this.boundarySourceCanvas = null;
    this.boundarySourcePixels = null;
    this.boundarySourceSamples = [];
    this.boundaryRegionAnchors = [];
    this.boundaryCurrentCorrection = NEUTRAL_BOUNDARY_CORRECTION;
    this.boundaryBlendMs = null;
    this.liveMouthLastTimestamp = -1;
    this.liveMouthHasFrame = false;
    this.liveMouthOpacity = 0;
    this.liveMouthActive = false;
    this.liveMouthCanonical = false;
    this.canonicalMouthDiagnostics = null;
    this.canonicalMouthFilter.reset();
    this.texture = null;
    this.boundaryAlpha = null;
    this.textureBitmap = null;
    this.deformer = null;
    this.gazeWarper = null;
    this.lastEyeGaze = null;
    this.expressionEnvelope = null;
    this.mesh = null;
    this.faceRoot = null;
    this.meshEdges = null;
    this.baseColors = null;
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
    // The live camera is composited underneath this canvas by the Studio. Keep
    // untouched canvas pixels transparent so a renderer background never
    // replaces the operator's video.
    renderer.setClearColor(0x000000, 0);
    const scene = new three.Scene();
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    camera.position.z = 2;
    const meshData = buildSourceFaceMesh(this.options.profile.primaryFace.landmarks,
      this.options.profile.primaryFace, this.options.profile.dimensions?.aspectRatio ?? 1);
    this.projectionBindings = buildProjectionBindings(meshData.uvs, this.options.profile.primaryFace.landmarks);
    this.boundaryLoopStats = meshData.boundaryLoops;
    this.coverageBoundaryVertices = meshData.coverageBoundaryVertices ?? [];
    this.coverageExtensionVertices = meshData.coverageExtensionVertices ?? [];
    this.coverageExtensionRegions = meshData.coverageExtensionRegions ?? new Uint8Array();
    const hairline = this.options.profile.appearance?.hairline;
    const sourceTop = this.options.profile.primaryFace.landmarks[10];
    if (hairline && sourceTop && hairline.confidence >= 0.18 && hairline.foreheadTop < sourceTop.y) {
      const dimensions = this.options.profile.dimensions;
      const sourceFaceWidth = Math.max(1e-4, Math.abs(this.options.profile.primaryFace.landmarks[454]!.x - this.options.profile.primaryFace.landmarks[234]!.x));
      this.sourceForeheadExtensionLimit = 0.44 * (sourceTop.y - hairline.foreheadTop) * (dimensions?.height ?? 1) /
        (sourceFaceWidth * (dimensions?.width ?? 1));
    }
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
    // Texture color stays white except for the cavity centroid shading. Alpha
    // carries the topology-derived face edge ramp, attached to these same
    // deforming vertices so the live frame shows through the outer contour.
    const colors = new Float32Array(meshData.positions.length / 3 * 4).fill(1);
    this.boundaryAlpha = meshData.boundaryAlpha.slice();
    for (let vertex = 0; vertex < meshData.boundaryAlpha.length; vertex++) {
      colors[vertex * 4 + 3] = meshData.boundaryAlpha[vertex]!;
    }
    if (mouth) {
      const cavityCenter = (mouth.cavityStart + mouth.cavityCount - 1) * 4;
      colors[cavityCenter] = 0.35;
      colors[cavityCenter + 1] = 0.35;
      colors[cavityCenter + 2] = 0.35;
    }
    geometry.setAttribute("color", new three.BufferAttribute(colors, 4));
    this.baseColors = colors.slice();
    this.initializeBoundarySampler(
      meshData.localLandmarks ?? this.options.profile.primaryFace.landmarks,
      this.options.profile.primaryFace.landmarks,
    );
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
    // Keep source texels straight-alpha. NormalBlending then applies SRC_ALPHA
    // exactly once into the premultiplied drawing buffer.
    texture.premultiplyAlpha = false;
    texture.needsUpdate = true;
    const material = new three.MeshBasicMaterial({ map: this.showMask ? null : texture, vertexColors: true, transparent: true, premultipliedAlpha: false, side: three.DoubleSide });
    // A fixed dark oral tone: nothing here samples or matches the source's skin.
    const cavityMaterial = mouth
      ? new three.MeshBasicMaterial({ color: this.showMask ? 0xffffff : 0x4a1a1e, vertexColors: true, transparent: true, premultipliedAlpha: false, side: three.DoubleSide })
      : null;
    const fillMaterial = mouth
      ? new three.MeshBasicMaterial({ map: this.showMask ? null : texture, vertexColors: true, transparent: true, premultipliedAlpha: false, side: three.DoubleSide })
      : null;
    const faceRoot = new three.Group();
    faceRoot.name = "CallaStarFaceRoot";
    faceRoot.matrixAutoUpdate = true;
    const mesh = new three.Mesh(geometry, cavityMaterial && fillMaterial ? [material, cavityMaterial, fillMaterial] : material);
    mesh.name = "CallaStarFaceSkinMaskEyes";
    this.boundaryLines = meshData.boundaryLoops.map(loop => this.createBoundaryLine(loop, meshData))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    for (const { line } of this.boundaryLines) { line.visible = this.showBoundaries; mesh.add(line); }
    const outerBoundary = meshData.boundaryLoops.find(loop => loop.kind === "outer");
    if (outerBoundary && this.coverageBoundaryVertices.length >= 3) {
      const innerContour = this.createBoundaryLine({ ...outerBoundary, vertices: this.coverageBoundaryVertices }, meshData, 0x00d9ff, 1.5, 0.9, 10);
      if (innerContour) this.coveragePreviewLines.push(innerContour);
    }
    const foreheadTrace = this.coverageExtensionVertices.filter((_vertex, index) => this.coverageExtensionRegions[index] === 0);
    const hairlineTrace = this.createCoverageTrace(foreheadTrace, meshData, 0x71ffba, 1.7, 11, false);
    if (hairlineTrace) this.coveragePreviewLines.push(hairlineTrace);
    if (this.sourceFacialHairPresent && this.sourceFacialHairWeights) {
      const hairVertices = Array.from(this.sourceFacialHairWeights, (weight, index) => ({ weight, index }))
        .filter(entry => entry.index < 468 && entry.weight >= 0.42)
        .map(entry => entry.index);
      if (hairVertices.length >= 3) {
        const center = hairVertices.reduce((sum, index) => ({
          x: sum.x + meshData.positions[index * 3]!, y: sum.y + meshData.positions[index * 3 + 1]!,
        }), { x: 0, y: 0 });
        center.x /= hairVertices.length; center.y /= hairVertices.length;
        hairVertices.sort((a, b) => Math.atan2(meshData.positions[a * 3 + 1]! - center.y, meshData.positions[a * 3]! - center.x) -
          Math.atan2(meshData.positions[b * 3 + 1]! - center.y, meshData.positions[b * 3]! - center.x));
        const hairTrace = this.createCoverageTrace(hairVertices, meshData, 0xffaa4c, 1.7, 12, true);
        if (hairTrace) this.coveragePreviewLines.push(hairTrace);
      }
    }
    for (const { line } of this.coveragePreviewLines) { line.visible = this.showBoundaries; mesh.add(line); }
    this.faceLockLines = outerBoundary ? [
      this.createBoundaryLine(outerBoundary, meshData, 0x00eaff, 5, 0.85, 8),
      this.createBoundaryLine(outerBoundary, meshData, 0xff22c8, 2, 0.9, 9),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null) : [];
    for (const { line } of this.faceLockLines) { line.visible = this.showFaceLockDebug; mesh.add(line); }
    // The source geometry is canonical/local. One explicit Object3D owns every
    // global placement transform; the skin/mask surface remains its child.
    faceRoot.add(mesh);
    scene.add(faceRoot);
    this.scene = scene;
    this.camera = camera;
    this.faceRoot = faceRoot;
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
      const recess=new three.Mesh(g,m);recess.name="CallaStarNoseCavities";recess.renderOrder=1;recess.visible=!this.showMask;faceRoot.add(recess);
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
        const count = OUTER_LIP_RING.length * 3 + 1;
        const faceLeft = meshData.localLandmarks![234]!, faceRight = meshData.localLandmarks![454]!;
        const faceWidth = Math.hypot(faceRight.x-faceLeft.x,faceRight.y-faceLeft.y);
        const lip = OUTER_LIP_RING.map(i => meshData.localLandmarks![i]!);
        const inner = INNER_LIP_RING.map(i => meshData.localLandmarks![i]!);
        const expanded = perioralLocalRing(lip,faceWidth);
        const all = [...expanded,...lip,...inner];
        const minX=Math.min(...expanded.map(p=>p.x)),maxX=Math.max(...expanded.map(p=>p.x));
        const minY=Math.min(...expanded.map(p=>p.y)),maxY=Math.max(...expanded.map(p=>p.y));
        const position=new Float32Array(count*3);
        all.forEach((p,i)=>position.set([p.x,p.y,p.z+.006],i*3));
        const centre=inner.reduce((sum,p)=>({x:sum.x+p.x/inner.length,y:sum.y+p.y/inner.length,z:sum.z+p.z/inner.length}),{x:0,y:0,z:0});
        position.set([centre.x,centre.y,centre.z+.006],all.length*3);
        const target = all.map(p => ({ x:(p.x-minX)/Math.max(1e-6,maxX-minX), y:(p.y-minY)/Math.max(1e-6,maxY-minY) }));
        const uv = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
          const point = target[i] ?? { x: (centre.x-minX)/Math.max(1e-6,maxX-minX), y: (centre.y-minY)/Math.max(1e-6,maxY-minY) };
          uv[i * 2] = point.x;
          uv[i * 2 + 1] = 1 - point.y;
        }
        const indices = mouthMeshIndices();
        liveGeometry.setAttribute('position', new three.BufferAttribute(position, 3).setUsage(three.DynamicDrawUsage));
        liveGeometry.setAttribute('uv', new three.BufferAttribute(uv, 2));
        liveGeometry.setIndex(new three.BufferAttribute(indices, 1));
        liveGeometry.computeVertexNormals();
        const liveMesh = new three.Mesh(liveGeometry, liveMaterial);
        liveMesh.name = "CallaStarLiveMouth";
        liveMesh.visible = !this.showMask;
        liveMesh.renderOrder = 1;
        // No independent image-space warp is used here: this padded mouth patch
        // is a mesh child of the same faceRoot that places the transformed face.
        faceRoot.add(liveMesh);
        if (import.meta.env.DEV) {
          for (const key of Object.keys(MOUTH_DEBUG_COLORS) as MouthDebugLayer[]) {
            const debugGeometry = new three.BufferGeometry();
            debugGeometry.setAttribute('position', new three.BufferAttribute(new Float32Array(OUTER_LIP_RING.length * 3), 3).setUsage(three.DynamicDrawUsage));
            const debugMaterial = new three.LineBasicMaterial({ color: MOUTH_DEBUG_COLORS[key],
              transparent: true, opacity: .9, depthTest: false, depthWrite: false });
            const line = new three.LineLoop(debugGeometry, debugMaterial);
            line.visible = false;
            line.renderOrder = 12;
            faceRoot.add(line);
            this.mouthDebugLines[key] = line;
          }
        }
        this.liveMouthCanvas = canvas;
        this.liveMouthTexture = liveTexture;
        this.liveMouthMaterial = liveMaterial;
        this.liveMouthGeometry = liveGeometry;
        this.liveMouthMesh = liveMesh;
      }
    }
    this.resize(this.options.canvas.clientWidth || 1, this.options.canvas.clientHeight || 1, window.devicePixelRatio);
  }

  private createBoundaryLine(
    loop: FaceBoundaryLoop,
    meshData: ReturnType<typeof buildSourceFaceMesh>,
    customColor?: number,
    width = 1,
    opacity = 1,
    renderOrder = 9,
  ): { line: import("three").LineLoop; vertices: number[] } | null {
    const three = this.three!;
    if (loop.vertices.length < 3) return null;
    const positions = new Float32Array(loop.vertices.length * 3);
    for (let i = 0; i < loop.vertices.length; i++) positions.set(meshData.positions.slice(loop.vertices[i]! * 3, loop.vertices[i]! * 3 + 3), i * 3);
    const geometry = new three.BufferGeometry();
    geometry.setAttribute("position", new three.BufferAttribute(positions, 3).setUsage(three.DynamicDrawUsage));
    const colors: Record<FaceBoundaryLoop["kind"], number> = { outer: 0xffd400, "left-eye": 0x00d9ff, "right-eye": 0xff37d7, mouth: 0xff7b22, internal: 0x9b7cff };
    const material = new three.LineBasicMaterial({ color: customColor ?? colors[loop.kind], linewidth: width,
      opacity, transparent: opacity < 1, depthTest: false, depthWrite: false });
    const line = new three.LineLoop(geometry, material);
    line.renderOrder = renderOrder;
    return { line, vertices: loop.vertices };
  }

  private createCoverageTrace(
    vertices: number[],
    meshData: ReturnType<typeof buildSourceFaceMesh>,
    color: number,
    width: number,
    renderOrder: number,
    closed: boolean,
  ): { line: import("three").Line; vertices: number[] } | null {
    const three = this.three!;
    if (vertices.length < (closed ? 3 : 2)) return null;
    const positions = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) positions.set(meshData.positions.slice(vertices[i]! * 3, vertices[i]! * 3 + 3), i * 3);
    const geometry = new three.BufferGeometry();
    geometry.setAttribute("position", new three.BufferAttribute(positions, 3).setUsage(three.DynamicDrawUsage));
    const material = new three.LineBasicMaterial({ color, linewidth: width, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false });
    const line = closed ? new three.LineLoop(geometry, material) : new three.Line(geometry, material);
    line.renderOrder = renderOrder;
    return { line, vertices };
  }

  private updateBoundaryLines(): void {
    const positions = this.deformer?.positions;
    if (!positions) return;
    for (const { line, vertices } of [...this.boundaryLines, ...this.faceLockLines, ...this.coveragePreviewLines]) {
      const attribute = line.geometry.getAttribute("position") as import("three").BufferAttribute;
      for (let i = 0; i < vertices.length; i++) {
        const vertex = vertices[i]!;
        attribute.setXYZ(i, positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!);
      }
      attribute.needsUpdate = true;
    }
  }

  /** Update the existing outer ring and its alpha values without rebuilding the mesh. */
  private applyRuntimeMaskControls(): void {
    if (!this.geometry || !this.deformer || !this.boundaryAlpha || !this.baseColors) return;
    const controls = this.options.controls?.current ?? null;
    const coverage = controls?.coverage;
    const feather = featherExtensionScale(controls?.blending.feather ?? 24);
    const positions = this.deformer.positions;
    const base = this.deformer.basePositions;
    for (let index = 0; index < this.coverageExtensionVertices.length; index++) {
      const boundary = this.coverageBoundaryVertices[index];
      const extension = this.coverageExtensionVertices[index]!;
      if (boundary === undefined) continue;
      const region = this.coverageExtensionRegions[index] ?? 1;
      const regional = region === 0 ? coverage?.forehead ?? 82
        : region === 2 ? coverage?.jaw ?? 84
          : region === 3 ? coverage?.chin ?? 84
            : coverage?.temple ?? 76;
      let scale = Math.max(0, Math.min(1.15, coverageExtensionScale(coverage?.overall ?? 88, regional) * feather));
      if (region === 0 && this.sourceForeheadExtensionLimit !== null) {
        const edgeAt = boundary * 3;
        const baseAt = extension * 3;
        const extensionLength = Math.hypot(
          base[baseAt]! - base[edgeAt]!, base[baseAt + 1]! - base[edgeAt + 1]!, base[baseAt + 2]! - base[edgeAt + 2]!,
        );
        if (extensionLength > 1e-6) scale = Math.min(scale, this.sourceForeheadExtensionLimit / extensionLength);
      }
      for (let axis = 0; axis < 3; axis++) {
        const at = extension * 3 + axis;
        const edgeAt = boundary * 3 + axis;
        positions[at] = positions[edgeAt]! + (base[at]! - base[edgeAt]!) * scale;
      }
    }

    const color = this.geometry.getAttribute("color") as import("three").BufferAttribute;
    const values = color.array as Float32Array;
    const sourceOpacity = controls?.blending.sourceOpacity ?? 100;
    const hairStrength = controls?.appearance.facialHairStrength ?? 100;
    for (let vertex = 0; vertex < this.boundaryAlpha.length; vertex++) {
      const offset = vertex * 4;
      const maskAlpha = Math.max(0, Math.min(1, this.boundaryAlpha[vertex] ?? 0));
      const hair = this.sourceFacialHairWeights?.[vertex] ?? 0;
      const appearanceAlpha = sourceSurfaceAlpha(1, sourceOpacity, hair, hairStrength, this.sourceFacialHairPresent);
      const finalAlpha = maskAlpha * appearanceAlpha;
      if (this.showMask) {
        values[offset] = values[offset + 1] = values[offset + 2] = 1;
        values[offset + 3] = finalAlpha * 0.82;
      } else if (this.showWeights) {
        // setDiagnostics owns the red/green weight palette and opaque debug alpha.
        continue;
      } else {
        values[offset] = this.baseColors[offset]!;
        values[offset + 1] = this.baseColors[offset + 1]!;
        values[offset + 2] = this.baseColors[offset + 2]!;
        values[offset + 3] = finalAlpha;
      }
    }
    color.needsUpdate = true;
  }

  private renderFrame = (now: number): void => {
    if (this.disposed || this.status === "failed") return;
    this.displayFrameAtMs = now;
    const elapsed = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;
    const motion = this.options.motion.current;
    const faceFrame = this.options.faceFrame?.current ?? null;
    const frameMotion = faceFrame ? { ...motion, head: faceFrame.globalTransform } : motion;
    const expression = this.options.manualExpression?.current ??
      (faceFrame ? faceFrame.expressionState : this.options.expression?.current) ?? null;
    this.displayInputAgeMs = expression?.updatedAtMs === undefined ? null : Math.max(0, performance.now() - expression.updatedAtMs);
    if (this.options.paused?.current) {
      if (this.nostrilMaterial) this.nostrilMaterial.opacity = 0;
      smoothExpressionInto(this.expressionState, NEUTRAL_EXPRESSION, elapsed, this.expressionState);
      this.expressionApplied = this.expressionState;
      this.deformer?.update(this.expressionState);
      this.updateBoundaryLines();
      const position = this.geometry?.getAttribute("position") as import("three").BufferAttribute | undefined;
      if (position) position.needsUpdate = true;
      const uv = this.geometry?.getAttribute('uv') as import('three').BufferAttribute | undefined;
      if (uv && this.gazeWarper) { uv.array.set(this.gazeWarper.update(null)); uv.needsUpdate = true; }
      this.lastEyeGaze = null;
      this.updateLiveMouth(elapsed, true, expression);
      this.applyRuntimeMaskControls();
      this.renderStartMs = performance.now();
      this.renderer?.render(this.scene!, this.camera!);
      this.renderEndMs = performance.now();
      this.raf = requestAnimationFrame(this.renderFrame);
      return;
    }
    if (frameMotion.head) this.lastTrackedAt = now;
    const lost = !frameMotion.head && now - this.lastTrackedAt > 450;
    this.status = lost ? "lost" : "ready";
    if (this.material) {
      this.material.opacity = frameMotion.head || now - this.lastTrackedAt <= 450
        ? 1
        : Math.max(0, 1 - (now - this.lastTrackedAt - 450) / 450);
      if (this.cavityMaterial) this.cavityMaterial.opacity = this.material.opacity;
    }
    const target = this.options.manualPose?.current ?? this.motionResult(frameMotion).applied;
    // Hold briefly during tracker dropouts, then fade rather than snap to neutral.
    const safeTarget = this.options.manualPose?.current || frameMotion.head ? target : !lost ? this.pose : NEUTRAL_FACE_RENDER_POSE;
    const newCameraFrame = !!faceFrame && faceFrame !== this.lastAppliedFaceFrame;
    if (newCameraFrame) this.lastAppliedFaceFrame = faceFrame;
    if (newCameraFrame && !this.options.manualPose?.current && frameMotion.head) this.pose = safeTarget;
    else if (!this.options.faceFrame || this.options.manualPose?.current) this.pose = smoothFaceRenderPose(this.pose, safeTarget, elapsed);
    if (this.mesh && this.faceRoot && this.renderer && this.scene && this.camera) {
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
      if (expression && !expressionLost) {
        const gain = responseGain(this.options.controls?.current.tracking.facialResponse ?? 70, 70);
        this.responseExpression.eyes = expressionTarget.eyes;
        this.responseExpression.mouth = expressionTarget.mouth;
        this.responseExpression.nose = expressionTarget.nose;
        for (const key of EXPRESSION_KEYS) {
          // Preserve blink timing; the response control tunes mouth, smile and brow movement.
          this.responseExpression[key] = key.startsWith("blink")
            ? expressionTarget[key]
            : expressionTarget[key] * gain;
        }
        smoothExpressionInto(this.expressionState, this.responseExpression, elapsed, this.expressionState);
      } else {
        smoothExpressionInto(this.expressionState, expressionTarget, elapsed, this.expressionState);
      }
      this.expressionApplied = this.expressionState;
      const deformationStarted = performance.now();
      this.deformer?.update(this.expressionState);
      const rootDebugMode = this.options.rootMotionDebug?.current?.mode ?? "tracking";
      const rawDirectGeometry = faceFrame?.livePlacement &&
        (rootDebugMode === "tracking" || rootDebugMode === "raw-direct") &&
        !this.options.manualPose?.current;
      if (rawDirectGeometry && faceFrame?.livePlacement?.center && faceFrame.livePlacement.width) {
        const liveRotation = rendererMotionFromPose(this.pose);
        const inverse = new this.three!.Matrix4()
          .makeRotationFromEuler(new this.three!.Euler(liveRotation.rotationX, liveRotation.rotationY, liveRotation.rotationZ, "XYZ"))
          .invert();
        const positions = this.deformer?.positions;
        if (positions && this.deformer && this.projectionBindings.length) {
          projectLiveMeshPositions(
            positions,
            this.deformer.basePositions,
            positions,
            this.projectionBindings,
            faceFrame.stabilizedLandmarks,
            faceFrame.livePlacement.center,
            faceFrame.livePlacement.width,
            faceFrame.trackingAspect,
            inverse.elements,
            0.44,
            this.options.liveMouthEnabled?.current && this.options.oralInteriorMode?.current !== "source"
              ? LIVE_LIP_INDICES : undefined,
          );
        }
      } else {
        this.contourAlignment = [];
      }
      this.updateBoundaryLines();
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
      this.updateLiveMouth(elapsed, false, expression);
      this.updateMouthDebugVisibility();
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
      const mirror = typeof this.options.mirror === "object" ? this.options.mirror.current : this.options.mirror ?? "selfie";
      const flip = mirrorScaleX(mirror);
      this.scene.scale.x = flip;
      // Glued framing: where, and how large, the camera preview shows the face.
      // Unmirrored world position; the scene's negative x scale is the one
      // display flip, exactly as the camera preview does it.
      const canvas = this.options.canvas;
      const placement = faceFrame?.livePlacement;
      const liveCenter = placement?.center ?? faceFrame?.globalCenter;
      const livePlacement = faceFrame && !this.options.manualPose?.current && frameMotion.head && liveCenter
        ? {
            center: liveCenter,
            scale: placement?.scale ?? this.pose.scale,
          }
        : null;
      const framing = this.options.framing?.current ?? null;
      let world = faceWorldTransform(this.pose, this.meshEyeSpan,
        { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height },
        framing,
        livePlacement);
      let rootRotation = rendered;
      const rootDebug = this.options.rootMotionDebug?.current;
      if (livePlacement && placement?.viewport?.width && canvas.clientHeight > 0 &&
          (!rootDebug || rootDebug.mode === "tracking" || rootDebug.mode === "raw-direct")) {
        // Use the current mapped raw face width as the global scale. Calibration
        // continues to define local source proportions, never screen size.
        const rawScale = faceFrame?.rawScaleRatio ?? 1;
        const scaleFollow = this.options.controls?.current.tracking.scaleFollow ?? 72;
        const adjustedRatio = scaleFollowRatio(rawScale, scaleFollow);
        const correction = rawScale > 0 ? adjustedRatio / rawScale : 1;
        world = { ...world, scale: (placement.viewport.width * 2 / canvas.clientHeight) / 0.44 * correction };
      }
      if (rootDebug && rootDebug.mode !== "tracking" && rootDebug.mode !== "raw-direct") {
        const neutralWorld = faceWorldTransform(NEUTRAL_FACE_RENDER_POSE, this.meshEyeSpan,
          { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height }, framing);
        if (rootDebug.mode === "manual") {
          world = {
            ...world,
            x: Number.isFinite(rootDebug.x) ? Math.max(-0.3, Math.min(0.3, rootDebug.x)) : 0,
            y: Number.isFinite(rootDebug.y) ? Math.max(-0.3, Math.min(0.3, rootDebug.y)) : 0,
            scale: neutralWorld.scale * (Number.isFinite(rootDebug.scale) ? Math.max(0.5, Math.min(1.8, rootDebug.scale)) : 1),
          };
          rootRotation = { ...rendered, rotationX: 0, rotationY: 0,
            rotationZ: (Number.isFinite(rootDebug.rollDeg) ? Math.max(-30, Math.min(30, rootDebug.rollDeg)) : 0) * Math.PI / 180 };
        } else {
          const t = now / 1000;
          const roll = Math.sin(t * 0.6) * (10 * Math.PI / 180);
          world = {
            ...world,
            x: Math.sin(t) * 0.3,
            y: Math.cos(t * 0.7) * 0.22,
            scale: neutralWorld.scale * (1 + Math.sin(t * 0.5) * 0.3),
          };
          rootRotation = { ...rendered, rotationX: 0, rotationY: 0, rotationZ: roll };
        }
      }
      const fit = this.options.controls?.current.faceFit;
      if (fit) {
        const safe = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
        const viewportAspect = (canvas.clientWidth || canvas.width) / Math.max(1, canvas.clientHeight || canvas.height);
        world = {
          ...world,
          x: world.x + safe(fit.x, 0) / 100 * viewportAspect * 0.12,
          y: world.y + safe(fit.y, 0) / 100 * 0.24,
          scale: world.scale * Math.max(0.7, Math.min(1.3, safe(fit.scale, 100) / 100)),
        };
        rootRotation = { ...rootRotation, rotationZ: rootRotation.rotationZ + safe(fit.rotation, 0) * Math.PI / 180 };
      }
      this.worldTransform = world;
      this.faceRoot.position.set(world.x, world.y, 0);
      this.faceRoot.scale.set(
        world.scale * Math.max(0.7, Math.min(1.3, fit ? fit.width / 100 : 1)),
        world.scale * Math.max(0.7, Math.min(1.3, fit ? fit.height / 100 : 1)),
        world.scale,
      );
      this.faceRoot.rotation.set(rootRotation.rotationX, rootRotation.rotationY, rootRotation.rotationZ, "XYZ");
      this.updateContourAlignment(faceFrame);
      this.updateBoundaryHarmonization(faceFrame, now);
      if(this.nostrilMesh && this.nostrilMaterial){
        this.nostrilMaterial.opacity=nostrilVisibility(this.pose.pitch)*(this.material?.opacity ?? 1)*(this.options.controls?.current.blending.sourceOpacity ?? 100)/100;
      }
      this.applyRuntimeMaskControls();
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
    const faceFrame = this.options.faceFrame?.current ?? null;
    const frameMotion = faceFrame ? { ...this.options.motion.current, head: faceFrame.globalTransform } : this.options.motion.current;
    const frameExpression = this.options.manualExpression?.current ??
      (faceFrame ? faceFrame.expressionState : this.options.expression?.current) ?? null;
    const result = this.motionResult(frameMotion);
    const probe = this.getProbe();
    this.options.onStats?.({
      status: this.status,
      expressionLeakage: frameExpression?.leakage ?? false,
      eyes: frameExpression
        ? { aperture: frameExpression.eyeAperture ?? null, state: frameExpression.blinkState ?? null }
        : null,
      meshVertices: this.geometry?.getAttribute('position').count ?? 0,
      meshTriangles: (this.geometry?.index?.count ?? 0) / 3,
      boundaryLoops: this.boundaryLoopStats,
      faceFrame: this.options.faceFrame?.current ?? null,
      attachmentProbe: this.getAttachmentProbe(),
      contourAlignment: this.contourAlignment,
      alphaPipeline: "straight texture/shader → premultiplied framebuffer/canvas",
      boundaryBlendMs: this.boundaryBlendMs,
      boundaryColorCorrection: this.boundaryCurrentCorrection,
      poseAlignment: this.poseAlignmentSummary(),
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
      canonicalMouth: this.canonicalMouthDiagnostics,
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
    const pixelsPerUnit = height * (this.faceRoot?.scale.y ?? 1) / 2;
    const aperture = (positions: Float32Array) => Math.abs(positions[13 * 3 + 1]! - positions[14 * 3 + 1]!) * pixelsPerUnit;
    const chinOffset = Math.abs(applied[152 * 3 + 1]! - base[152 * 3 + 1]!) * pixelsPerUnit;
    return {
      mouthMeshAperturePx: { neutral: aperture(base), applied: aperture(applied) },
      jawChinMovementPx: chinOffset,
    };
  }

  /** The renderer's existing RAF owns this transient warp; there is no extra loop. */
  private updateLiveMouth(elapsedMs: number, suppress: boolean, expression: ExpressionMotion | null): void {
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
    const video = this.options.liveMouthVideoRef?.current ?? null;
    const mouth = expression?.liveMouth;
    const sourceFrame=mouth?.sourceFrame ?? video;
    const sourceWidth=mouth?.sourceFrame?.width ?? video?.videoWidth ?? 0;
    const sourceHeight=mouth?.sourceFrame?.height ?? video?.videoHeight ?? 0;
    const canvas = this.liveMouthCanvas;
    if (!enabled || !mouth || !video || video.readyState < 2) this.liveMouthActive = false;
    else this.liveMouthActive = true;
    // Legacy unclocked scalar fixtures remain supported; production canonical
    // controls always carry completion time and expire after a bounded hold.
    const fresh = !!mouth && (oralFrameFresh(expression?.updatedAtMs,performance.now()) || (expression?.updatedAtMs===undefined && !expression?.mouth));
    const trustworthy = !expression?.mouth || expression.mouth.confidence >= .35;
    // SOURCE is the explicit A/B bypass. AUTO and LIVE restore the current
    // outer-lip/perioral patch; this no longer waits for a jaw-opening threshold.
    const faceFrame = this.options.faceFrame?.current;
    const paired = !faceFrame || faceFrame.timestampMs === mouth?.timestampMs;
    const wantsFeed = enabled && mode !== 'source' && trustworthy && paired && this.liveMouthActive && fresh && !!mouth && !!video && video.readyState >= 2;
    const metrics=mouth && sourceFrame ? mouthMaskMetrics(mouth.ring,sourceWidth,sourceHeight) : null;
    const faceWidthPx=mouth?(mouth.faceWidthRatio || .45)*sourceWidth:0;
    const region=mouth&&sourceFrame?perioralRegion(mouth.ring,sourceWidth,sourceHeight,faceWidthPx):null;
    this.oralDiagnostics.frameAvailable=!!video && video.readyState>=2;
    this.oralDiagnostics.polygonValid=metrics?.valid ?? false;
    this.oralDiagnostics.maskAreaPx=metrics?.area ?? 0;
    this.oralDiagnostics.cropBounds=region?.bounds ?? metrics?.bounds ?? null;
    this.oralDiagnostics.faceWidthPx=region?.faceWidthPx ?? null;
    this.oralDiagnostics.mouthWidthPx=region?.mouthWidth ?? null;
    this.oralDiagnostics.featherSigmaPx=region?.sigma ?? null;
    this.oralDiagnostics.frameAgeMs=expression?.updatedAtMs===undefined ? null : Math.max(0,performance.now()-expression.updatedAtMs);
    this.oralDiagnostics.cameraTimestampMs=mouth?.sourceFrame ? mouth.timestampMs : video ? video.currentTime*1000 : null;
    this.oralDiagnostics.faceResultTimestampMs=mouth?.timestampMs ?? null;
    this.oralDiagnostics.controlsTimestampMs=expression?.mouth?.timestampMs ?? null;
    this.oralDiagnostics.renderTimestampMs=performance.now();
    if(!fresh && mouth && this.oralDroppedTimestamp!==mouth.timestampMs){this.oralDiagnostics.droppedFrames++;this.oralDroppedTimestamp=mouth.timestampMs;}
    this.mouthMaskStatus=!enabled||mode==='source'?'disabled':!mouth||!video||video.readyState<2?'unavailable':!fresh?'stale':!trustworthy?'invalid':this.liveMouthHasFrame?'ready':'unavailable';
    if (wantsFeed && mouth && video && mouth.timestampMs !== this.liveMouthLastTimestamp && canvas) {
      const context = canvas.getContext('2d');
      if (context && sourceFrame && drawPerioralPatch(context, sourceFrame, mouth.ring,
        sourceWidth, sourceHeight, faceWidthPx, mouth.innerRing)) {
        this.liveMouthCanonical = !!(mouth.ring.length === OUTER_LIP_RING.length &&
          faceFrame?.livePlacement?.center && faceFrame.livePlacement.width &&
          mouth.innerRing?.length === INNER_LIP_RING.length &&
          this.writeCanonicalMouthGeometry(faceFrame, mouth.ring, mouth.innerRing, region,
            sourceWidth, sourceHeight, mouth.faceWidthRatio, mouth.timestampMs));
        if (!this.liveMouthCanonical) this.writeLegacyMouthGeometry();
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
        this.liveMouthCanonical=false;
        this.canonicalMouthDiagnostics=null;
        this.canonicalMouthFilter.reset();
        canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
        this.liveMouthLastTimestamp=-1;
        this.liveMouthOpacity=0;
        if(this.liveMouthTexture)this.liveMouthTexture.needsUpdate=true;
        this.mouthMaskStatus='invalid';
      }
    }
    if(!wantsFeed && this.liveMouthHasFrame){
      // Never carry a prior camera mouth across a tracking miss or A/B toggle.
      canvas?.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
      this.liveMouthHasFrame=false;
      this.liveMouthLastTimestamp=-1;
      this.liveMouthOpacity=0;
      if(this.liveMouthTexture)this.liveMouthTexture.needsUpdate=true;
      this.liveMouthCanonical=false;
      this.canonicalMouthDiagnostics=null;
      this.canonicalMouthFilter.reset();
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
    if (!this.liveMouthCanonical) this.writeLegacyMouthGeometry();
    this.mouthCompositorMs = performance.now() - started;
  }

  private writeCanonicalMouthGeometry(
    frame: FaceFrameSnapshot, outerPixels: readonly MouthPoint[], innerPixels: readonly MouthPoint[],
    region: ReturnType<typeof perioralRegion>, sourceWidth: number, sourceHeight: number,
    faceWidthRatio: number,
    timestampMs: number,
  ): boolean {
    const placement = frame.livePlacement;
    if (!placement?.center || !placement.width || !region || !this.three || !this.liveMouthGeometry) return false;
    const rotation = rendererMotionFromPose(this.pose);
    const inverse = new this.three.Matrix4()
      .makeRotationFromEuler(new this.three.Euler(rotation.rotationX, rotation.rotationY, rotation.rotationZ, "XYZ"))
      .invert();
    const raw = canonicalMouthRings(frame.landmarks, placement.center, placement.width,
      frame.trackingAspect, inverse.elements);
    if (!raw) return false;
    const stable = this.canonicalMouthFilter.update(raw, timestampMs);
    const feather = perioralLocalRing(stable.outer, .44 * (faceWidthRatio || .45) / placement.width);
    const positions = this.liveMouthGeometry.getAttribute('position') as import('three').BufferAttribute;
    const uvs = this.liveMouthGeometry.getAttribute('uv') as import('three').BufferAttribute;
    const destination = [...feather, ...stable.outer, ...stable.inner];
    // UVs come from the raw inference frame. Geometry comes from stabilized
    // face-local landmarks, so source pixels and lip contour share one sample.
    const rawUv = [...region.expanded,
      ...outerPixels.map(p => ({ x: p.x * sourceWidth, y: p.y * sourceHeight })),
      ...innerPixels.map(p => ({ x: p.x * sourceWidth, y: p.y * sourceHeight }))];
    const bounds = region.bounds;
    const dx = Math.max(1e-6, bounds.maxX - bounds.minX), dy = Math.max(1e-6, bounds.maxY - bounds.minY);
    for (let i = 0; i < destination.length; i++) {
      const point = destination[i]!, uv = rawUv[i]!;
      positions.setXYZ(i, point.x, point.y, point.z + .006);
      uvs.setXY(i, (uv.x - bounds.minX) / dx, 1 - (uv.y - bounds.minY) / dy);
    }
    const count = destination.length;
    const innerCenter = stable.inner.reduce((sum, p) => ({ x: sum.x + p.x / stable.inner.length,
      y: sum.y + p.y / stable.inner.length, z: sum.z + p.z / stable.inner.length }), { x: 0, y: 0, z: 0 });
    const rawCenter = innerPixels.reduce((sum, p) => ({ x: sum.x + p.x * sourceWidth / innerPixels.length,
      y: sum.y + p.y * sourceHeight / innerPixels.length }), { x: 0, y: 0 });
    positions.setXYZ(count, innerCenter.x, innerCenter.y, innerCenter.z + .006);
    uvs.setXY(count, (rawCenter.x - bounds.minX) / dx, 1 - (rawCenter.y - bounds.minY) / dy);
    positions.needsUpdate = true;
    uvs.needsUpdate = true;
    const span = (a: import('../faceTypes').Point3, b: import('../faceTypes').Point3) => Math.hypot(a.x - b.x, a.y - b.y);
    const rawWidth = span(raw.outer[0]!, raw.outer[10]!);
    const renderedWidth = span(stable.outer[0]!, stable.outer[10]!);
    const rawOpening = Math.max(0, raw.inner[15]!.y - raw.inner[5]!.y);
    const renderedOpening = Math.max(0, stable.inner[15]!.y - stable.inner[5]!.y);
    const measurements = measureLiveMouth(frame.landmarks);
    this.canonicalMouthDiagnostics = {
      liveWidth: rawWidth, renderedWidth, widthRatio: renderedWidth / Math.max(1e-6, rawWidth),
      liveOuterHeight: span(raw.outer[15]!, raw.outer[5]!),
      renderedOuterHeight: span(stable.outer[15]!, stable.outer[5]!),
      liveOpeningHeight: rawOpening, renderedOpeningHeight: renderedOpening,
      openingRatio: rawOpening > 1e-6 ? renderedOpening / rawOpening : renderedOpening < 1e-6 ? 1 : 0,
      liveOpeningWidth: span(raw.inner[0]!, raw.inner[10]!),
      renderedOpeningWidth: span(stable.inner[0]!, stable.inner[10]!),
      center: { x: measurements?.center.x ?? 0, y: measurements?.center.y ?? 0 },
      leftCorner: { x: measurements?.leftCorner.x ?? 0, y: measurements?.leftCorner.y ?? 0 },
      rightCorner: { x: measurements?.rightCorner.x ?? 0, y: measurements?.rightCorner.y ?? 0 },
      openRatio: measurements?.openRatio ?? 0, heightRatio: measurements?.heightRatio ?? 0,
      filter: this.canonicalMouthFilter.stats,
      yaw: this.pose.yaw, pitch: this.pose.pitch, roll: this.pose.roll,
    };
    if (import.meta.env.DEV && (this.canonicalMouthDiagnostics.widthRatio > 1.15 ||
      this.canonicalMouthDiagnostics.widthRatio < .85)) {
      console.warn('Live mouth width departed from measured width', this.canonicalMouthDiagnostics.widthRatio);
    }
    if (import.meta.env.DEV) {
      const featherEdge = feather.map(p => ({ ...p,
        x: p.x + (p.x - innerCenter.x) * .025,
        y: p.y + (p.y - innerCenter.y) * .025 }));
      this.writeMouthDebugLine('rawOuter', raw.outer);
      this.writeMouthDebugLine('rawInner', raw.inner);
      this.writeMouthDebugLine('stableOuter', stable.outer);
      this.writeMouthDebugLine('stableInner', stable.inner);
      this.writeMouthDebugLine('mask', feather);
      this.writeMouthDebugLine('feather', featherEdge);
    }
    return true;
  }

  private writeMouthDebugLine(key: MouthDebugLayer, points: readonly import('../faceTypes').Point3[]): void {
    const line = this.mouthDebugLines[key];
    if (!line) return;
    const attribute = line.geometry.getAttribute('position') as import('three').BufferAttribute;
    points.forEach((point, index) => attribute.setXYZ(index, point.x, point.y, point.z + .012));
    attribute.needsUpdate = true;
  }

  private updateMouthDebugVisibility(): void {
    if (!import.meta.env.DEV) return;
    const selection = this.options.mouthDebugLayers?.current;
    for (const key of Object.keys(this.mouthDebugLines) as MouthDebugLayer[]) {
      this.mouthDebugLines[key]!.visible = !!(this.liveMouthCanonical && this.liveMouthHasFrame && selection?.[key]);
    }
  }

  /** Kept for unpaired developer fixtures; production frames use canonical rings. */
  private writeLegacyMouthGeometry(): void {
    const position = this.liveMouthGeometry?.getAttribute('position') as import('three').BufferAttribute | undefined;
    const uv = this.liveMouthGeometry?.getAttribute('uv') as import('three').BufferAttribute | undefined;
    if (!position || !uv || !this.deformer) return;
    const vertices = this.deformer.positions;
    const outer = OUTER_LIP_RING.map(index => ({ x: vertices[index * 3]!, y: vertices[index * 3 + 1]!, z: vertices[index * 3 + 2]! }));
    const inner = INNER_LIP_RING.map(index => ({ x: vertices[index * 3]!, y: vertices[index * 3 + 1]!, z: vertices[index * 3 + 2]! }));
    const faceWidth = Math.abs(vertices[454 * 3]! - vertices[234 * 3]!);
    const all = [...perioralLocalRing(outer, faceWidth), ...outer, ...inner];
    const xs = all.slice(0, 20).map(p => p.x), ys = all.slice(0, 20).map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    all.forEach((point, i) => {
      position.setXYZ(i, point.x, point.y, point.z + .006);
      uv.setXY(i, (point.x - minX) / Math.max(1e-6, maxX - minX),
        (point.y - minY) / Math.max(1e-6, maxY - minY));
    });
    const center = inner.reduce((sum, p) => ({ x: sum.x + p.x / inner.length,
      y: sum.y + p.y / inner.length, z: sum.z + p.z / inner.length }), { x: 0, y: 0, z: 0 });
    position.setXYZ(all.length, center.x, center.y, center.z + .006);
    uv.setXY(all.length, (center.x - minX) / Math.max(1e-6, maxX - minX),
      (center.y - minY) / Math.max(1e-6, maxY - minY));
    position.needsUpdate = true;
    uv.needsUpdate = true;
  }

  /** Apply both the conservative M7 envelope and the measured source envelope. */
  private motionResult(motion: CalibrationMotion): FaceRenderPoseResult {
    const liveMode = this.options.rootMotionDebug?.current?.mode;
    if (this.options.faceFrame?.current?.livePlacement && (liveMode === undefined || liveMode === "tracking" || liveMode === "raw-direct")) {
      return poseFromMotion(motion, { ...FACE_RENDER_LIMITS, yaw: Math.PI / 2, pitch: Math.PI / 2, roll: Math.PI });
    }
    return poseFromSourceMotion(motion, this.options.profile.movementEnvelope);
  }

  private updateContourAlignment(frame: FaceFrameSnapshot | null): void {
    const placement = frame?.livePlacement;
    const faceRoot = this.faceRoot;
    const camera = this.camera;
    const scene = this.scene;
    const three = this.three;
    const positions = this.geometry?.getAttribute("position") as import("three").BufferAttribute | undefined;
    const viewport = placement?.viewportTransform;
    const width = this.options.canvas.clientWidth;
    const height = this.options.canvas.clientHeight;
    if (!frame || !placement || !viewport || !faceRoot || !camera || !scene || !three || !positions || width <= 0 || height <= 0) {
      this.contourAlignment = [];
      return;
    }
    const regions = [
      ["forehead", 10], ["left-temple", 234], ["right-temple", 454],
      ["left-cheek", 127], ["right-cheek", 356], ["chin", 152], ["nose-center", 1],
    ] as const;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    this.contourAlignment = regions.flatMap(([region, landmarkIndex]) => {
      const point = frame.landmarks[landmarkIndex];
      if (!point) return [];
      const live = mapNormalizedToDisplay(point, viewport);
      const local = new three.Vector3(
        positions.getX(landmarkIndex), positions.getY(landmarkIndex), positions.getZ(landmarkIndex),
      );
      faceRoot.localToWorld(local);
      local.project(camera);
      const rendered = { x: (local.x + 1) * width / 2, y: (1 - local.y) * height / 2 };
      return [{ region, landmarkIndex, live, rendered, errorPx: Math.hypot(rendered.x - live.x, rendered.y - live.y) }];
    });
    if (frame.frameId === this.lastAlignmentFrameId || !this.contourAlignment.length) return;
    this.lastAlignmentFrameId = frame.frameId;
    const error = this.contourAlignment.reduce((sum, sample) => sum + sample.errorPx, 0) / this.contourAlignment.length;
    const yawDeg = (frame.globalTransform?.yawDelta ?? 0) * 180 / Math.PI;
    const pitchDeg = (frame.globalTransform?.pitchDelta ?? 0) * 180 / Math.PI;
    const direction = Math.abs(yawDeg) >= 8 && Math.abs(yawDeg) <= 60
      ? yawDeg > 0 ? this.poseAlignmentSamples.leftYaw : this.poseAlignmentSamples.rightYaw
      : Math.abs(pitchDeg) >= 8 && Math.abs(pitchDeg) <= 60
        ? pitchDeg < 0 ? this.poseAlignmentSamples.upPitch : this.poseAlignmentSamples.downPitch
        : null;
    const angle = direction === this.poseAlignmentSamples.leftYaw ? yawDeg
      : direction === this.poseAlignmentSamples.rightYaw ? yawDeg
        : direction === this.poseAlignmentSamples.upPitch ? pitchDeg : pitchDeg;
    if (direction) {
      direction.push({ angle, error });
      if (direction.length > 120) direction.shift();
    }
  }

  private poseAlignmentSummary(): FaceRendererStats["poseAlignment"] {
    return Object.fromEntries(Object.entries(this.poseAlignmentSamples).map(([key, samples]) => [key, {
      angleDeg: samples.length ? samples.reduce((sum, sample) => sum + sample.angle, 0) / samples.length : null,
      errorPx: samples.length ? samples.reduce((sum, sample) => sum + sample.error, 0) / samples.length : null,
      count: samples.length,
    }])) as FaceRendererStats["poseAlignment"];
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
    const mirror = typeof this.options.mirror === "object" ? this.options.mirror.current : this.options.mirror ?? "selfie";
    const flip = mirrorScaleX(mirror);
    const motion = this.renderedMotion;
    const vectors = motion ? faceDirectionVectors(motion) : null;
    let actualNose = vectors ? { ...vectors.nose, x: vectors.nose.x * flip } : null;
    let actualUp = vectors ? { ...vectors.up, x: vectors.up.x * flip } : null;
    if (this.faceRoot && this.three) {
      this.scene?.updateMatrixWorld(true);
      actualNose = new this.three.Vector3(0, 0, 1).transformDirection(this.faceRoot.matrixWorld);
      actualUp = new this.three.Vector3(0, 1, 0).transformDirection(this.faceRoot.matrixWorld);
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
    const faceRoot = this.faceRoot;
    if (faceRoot && this.camera && this.three && deformed) {
      const widthPx = this.options.canvas.clientWidth || this.options.canvas.width || 1;
      const project = (local: [number, number, number]) => {
        const v = new this.three!.Vector3(...local).applyMatrix4(faceRoot.matrixWorld).project(this.camera!);
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

  /** Geometry-level proof that every global facial layer inherits one root. */
  getAttachmentProbe(): {
    frameId: number | null;
    rootMatrix: number[] | null;
    rootLocal: { x: number; y: number; scaleX: number; scaleY: number; roll: number; matrixAutoUpdate: boolean } | null;
    rootPosition: { x: number; y: number } | null;
    rootScale: number | null;
    skinWorldCenter: { x: number; y: number; z: number } | null;
    eyeWorldCenter: { x: number; y: number; z: number } | null;
    childWorldPosition: { name: string; x: number; y: number; z: number } | null;
    sceneHierarchy: { name: string; type: string; children: { name: string; type: string; children: string[] }[] } | null;
    skinIsRootChild: boolean;
    eyePixelsShareRoot: boolean;
    noseSharesRoot: boolean;
    mouthSharesRoot: boolean;
    maskSharesFaceGeometry: boolean;
    featureLayersShareRoot: boolean;
    debugContoursShareRoot: boolean;
  } {
    this.scene?.updateMatrixWorld(true);
    const root = this.faceRoot;
    const skin = this.mesh;
    const isDescendant = (object: import("three").Object3D | null): boolean => {
      let current = object;
      while (current) {
        if (current === root) return true;
        current = current.parent;
      }
      return false;
    };
    const origin = root && this.three ? new this.three.Vector3(0, 0, 0).applyMatrix4(root.matrixWorld) : null;
    let eyeCenter: import("three").Vector3 | null = null;
    const points = this.deformer?.positions;
    if (skin && this.three && points && points.length > 263 * 3 + 2) {
      const left = 33 * 3, right = 263 * 3;
      eyeCenter = new this.three.Vector3(
        (points[left]! + points[right]!) / 2,
        (points[left + 1]! + points[right + 1]!) / 2,
        (points[left + 2]! + points[right + 2]!) / 2,
      ).applyMatrix4(skin.matrixWorld);
    }
    const child = this.nostrilMesh ?? this.liveMouthMesh ?? skin;
    const childWorld = child && this.three ? child.getWorldPosition(new this.three.Vector3()) : null;
    const hierarchy = root ? {
      name: root.name,
      type: root.type,
      children: root.children.map(object => ({
        name: object.name || "(unnamed)",
        type: object.type,
        children: object.children.map(nested => `${nested.name || "(unnamed)"}:${nested.type}`),
      })),
    } : null;
    return {
      frameId: this.options.faceFrame?.current?.frameId ?? null,
      rootMatrix: root ? Array.from(root.matrixWorld.elements) : null,
      rootLocal: root ? { x: root.position.x, y: root.position.y, scaleX: root.scale.x, scaleY: root.scale.y,
        roll: root.rotation.z, matrixAutoUpdate: root.matrixAutoUpdate } : null,
      rootPosition: root ? { x: root.position.x, y: root.position.y } : null,
      rootScale: root ? root.scale.x : null,
      skinWorldCenter: origin ? { x: origin.x, y: origin.y, z: origin.z } : null,
      eyeWorldCenter: eyeCenter ? { x: eyeCenter.x, y: eyeCenter.y, z: eyeCenter.z } : null,
      childWorldPosition: childWorld ? { name: child?.name ?? "(unnamed)", x: childWorld.x, y: childWorld.y, z: childWorld.z } : null,
      sceneHierarchy: hierarchy,
      skinIsRootChild: !!root && skin?.parent === root,
      eyePixelsShareRoot: !!root && isDescendant(skin),
      noseSharesRoot: !!root && (!this.nostrilMesh || this.nostrilMesh.parent === root),
      mouthSharesRoot: !!root && (!this.liveMouthMesh || this.liveMouthMesh.parent === root),
      maskSharesFaceGeometry: !!root && !!skin && skin.geometry === this.geometry,
      featureLayersShareRoot: !!root && [this.nostrilMesh, this.liveMouthMesh].every(layer => !layer || layer.parent === root),
    debugContoursShareRoot: !!root && [...this.boundaryLines, ...this.faceLockLines, ...this.coveragePreviewLines].every(({ line }) => isDescendant(line)),
    };
  }
}

async function decodeSourceFrame(
  asset: SourceAsset,
  profile: TransformationSourceProfile,
  sourceVideo: HTMLVideoElement | null,
): Promise<ImageBitmap> {
  if (asset.kind === "image") return createImageBitmap(asset.blob, { imageOrientation: "from-image", premultiplyAlpha: "none" });
  if (profile.preparedFrame) return createImageBitmap(profile.preparedFrame, { premultiplyAlpha: "none" });
  const reader = new VideoFrameReader();
  try {
    await reader.open(asset.blob);
    const timestamp = profile.baseFrameTime ?? profile.referenceFrames.find(frame => frame.angle === 'front')?.timestampSeconds ?? 0;
    return await createImageBitmap(await reader.frameAt(timestamp), { premultiplyAlpha: "none" });
  } finally { reader.dispose(); }
}
