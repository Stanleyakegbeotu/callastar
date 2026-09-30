import type { ExpressionKey } from "../engine/expressionMotion";

/**
 * A rigged 3D model as a CallaStar source.
 *
 * The experiment this exists for: the M7/M8 renderer stretches a single
 * photograph, so turning a head has to invent the side of a face that was never
 * photographed. A complete 3D head already contains ears, a skull, hair and a
 * neck — turning it reveals real modelled geometry instead.
 *
 * Nothing here is a Three.js type. The analyzer reads a GLTF scene and returns
 * these facts; the renderer is the only thing that touches a node, a mesh or a
 * morph attribute. That boundary is what keeps MediaPipe from being wired into
 * GLTF nodes across the UI.
 */

/** What a model can actually be driven to do. Measured from the file, never assumed. */
export interface AvatarCapabilities {
  /** Whole-model yaw, pitch and roll. Any model can do this. */
  headPose: boolean;
  /** Translation and scale. Any model can do this. */
  headTransform: boolean;
  /** Per-expression, true only where a morph target or bone was actually found. */
  expressions: Record<ExpressionKey, boolean>;
  /** A jaw BONE, which can open a mouth on a model with no jawOpen morph. */
  jawBone: boolean;
}

/**
 * The three honest classes of uploaded model.
 *
 * Reported rather than smoothed over. A static model cannot blink, and telling
 * an operator otherwise wastes their time hunting a rig problem that is really a
 * missing rig.
 */
export type AvatarRigClass =
  /** Rigged with facial morph targets: head motion and expressions. */
  | "rigged-facial"
  /** A head bone but no facial morphs: head motion, and jaw if a jaw bone exists. */
  | "rigged-head"
  /** No rig: whole-model transform only. */
  | "static";

export type AvatarWarning =
  | "no-morph-targets"
  | "no-skeleton"
  | "no-head-bone"
  | "partial-expressions"
  | "heavy-for-mobile"
  | "large-texture"
  | "no-mesh"
  | "has-animations"
  | "unusual-scale";

export interface AvatarBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

/**
 * How a model of arbitrary units and origin is brought into render space.
 *
 * GLB files disagree about everything: metres versus centimetres, origin at the
 * feet or between the eyes, forward down +z or −z. Resolved once, here, so no
 * sign or scale fix ever has to live inside a render loop.
 */
export interface AvatarNormalization {
  /** Multiplier that makes the model's head fill a predictable fraction of frame. */
  scale: number;
  /** Offset applied before rotation, so the model turns about its head. */
  pivot: { x: number; y: number; z: number };
  /** Why that pivot was chosen, so a wrong one is diagnosable rather than mysterious. */
  pivotSource: "head-bone" | "head-mesh-bounds" | "scene-bounds";
}

/** One morph target found on one mesh. A model may repeat a name across meshes. */
export interface MorphTargetLocation {
  meshName: string;
  morphName: string;
  index: number;
}

export interface Transformation3DSourceProfile {
  kind: "3d-model";
  version: number;
  createdAt: number;
  fileName: string;
  fileSizeBytes: number;
  format: "glb" | "gltf";
  /** Which admin profile this model was prepared for. Scoping, as for other sources. */
  profileId: string;

  meshCount: number;
  skinnedMeshCount: number;
  vertexCount: number;
  materialCount: number;
  textureCount: number;
  /** Largest texture edge in pixels, for the mobile weight warning. */
  largestTextureEdge: number | null;

  hasSkeleton: boolean;
  boneNames: string[];
  headBoneName: string | null;
  jawBoneName: string | null;

  hasMorphTargets: boolean;
  /** Every morph name discovered, across every mesh. */
  morphTargetNames: string[];
  /** Which CallaStar expression each mapped morph serves, and where it lives. */
  mappedMorphs: Partial<Record<ExpressionKey, MorphTargetLocation[]>>;
  /** Morphs the model has that CallaStar does not drive. Reported, not hidden. */
  unmappedMorphNames: string[];

  animationNames: string[];
  bounds: AvatarBounds;
  normalization: AvatarNormalization;
  rigClass: AvatarRigClass;
  capabilities: AvatarCapabilities;
  warnings: AvatarWarning[];
}

/**
 * What drives the avatar, and the whole of it.
 *
 * Renderer-independent by construction: no MediaPipe object, no Three.js type,
 * no morph name. The rig adapter turns this into influences for whichever
 * vocabulary the loaded model happens to use.
 *
 * Every head value is already in RENDER conventions — see
 * `avatarCoordinateMapping.ts`, which delegates its signs to the same
 * `rendererMotion.ts` the face renderer uses. Nothing downstream negates an axis.
 */
export interface AvatarMotion {
  head: {
    translationX: number;
    translationY: number;
    translationZ: number;
    scale: number;
    /** Radians, Three.js conventions, applied XYZ. */
    yaw: number;
    pitch: number;
    roll: number;
  };
  face: Record<ExpressionKey, number>;
  tracking: {
    faceTracked: boolean;
    calibrated: boolean;
    /** 0..1 from the tracker, or null when it reported none. */
    quality: number | null;
  };
}

export const AVATAR_PROFILE_VERSION = 1;

/**
 * First-pass weight limits.
 *
 * Chosen to avoid crashing a phone rather than to enforce a standard, and set as
 * warnings rather than refusals wherever a model might still be usable — a
 * dense model that renders at 20fps is a finding, not an error.
 */
export const AVATAR_LIMITS = {
  /** A refusal: past this a mobile browser will usually fail to decode at all. */
  maxFileBytes: 64 * 1024 * 1024,
  /** A warning. Real-time on a phone gets difficult well before this. */
  heavyVertexCount: 250_000,
  heavyFileBytes: 24 * 1024 * 1024,
  /** A warning: 4K maps are the usual cause of a mobile memory spike. */
  largeTextureEdge: 2048,
  /** Beyond these the model's units are probably not what the scene expects. */
  minPlausibleSize: 0.001,
  maxPlausibleSize: 10_000,
} as const;
