import { EXPRESSION_KEYS, type ExpressionKey } from "../engine/expressionMotion";
import { loadThreeRenderer } from "../loaders";

import { capabilitiesFromMapping } from "./avatarRigAdapter";
import {
  AVATAR_LIMITS,
  AVATAR_PROFILE_VERSION,
  type AvatarBounds,
  type AvatarNormalization,
  type AvatarRigClass,
  type AvatarWarning,
  type MorphTargetLocation,
  type Transformation3DSourceProfile,
} from "./avatarTypes";
import { findHeadBone, findJawBone, matchMorphTargets, unmappedMorphNames } from "./morphAliases";

/**
 * Reading a GLB well enough to say what it can and cannot do.
 *
 * Uploading a 3D file does not make it suitable for facial animation, and the
 * whole point of this analyzer is to say which of the three it is — rigged with
 * facial morphs, rigged head only, or static — rather than letting an operator
 * discover it by watching an avatar refuse to blink.
 *
 * Three.js is loaded lazily, here and in the renderer, so opening the Studio
 * still costs nothing until a model is actually chosen.
 */

/** The renderer needs the loaded scene; the profile is the part the UI reads. */
export interface AnalyzedAvatarModel {
  profile: Transformation3DSourceProfile;
  /** The live GLTF scene. Owned by the caller, disposed via `disposeAvatarScene`. */
  scene: import("three").Group;
  animations: import("three").AnimationClip[];
}

export type AvatarAnalysisResult =
  | { ok: true; model: AnalyzedAvatarModel }
  | { ok: false; failure: AvatarAnalysisFailure; message: string };

export type AvatarAnalysisFailure = "too-large" | "parse-failed" | "no-mesh" | "cancelled" | "unsupported";

const FAILURE_COPY: Record<AvatarAnalysisFailure, string> = {
  "too-large": "This model is too large to load safely in a browser.",
  "parse-failed": "This file could not be read as a GLB or glTF model.",
  "no-mesh": "This model contains no geometry to render.",
  cancelled: "Model loading was cancelled.",
  unsupported: "This browser cannot load 3D models.",
};

/**
 * How much of the frame a head should fill.
 *
 * Normalisation targets the model's LARGEST dimension rather than its height,
 * because an uploaded model may be a bare head, a bust or a whole body, and
 * scaling a full body by its height would leave the face a few pixels tall.
 */
const TARGET_LARGEST_DIMENSION = 1.6;

export async function analyzeAvatarModel(options: {
  blob: Blob;
  fileName: string;
  profileId: string;
  /** Checked at each resumption point so a replaced model cannot finish loading. */
  isStale?: () => boolean;
}): Promise<AvatarAnalysisResult> {
  const { blob, fileName, profileId } = options;
  const stale = options.isStale ?? (() => false);

  if (blob.size > AVATAR_LIMITS.maxFileBytes) {
    return { ok: false, failure: "too-large", message: FAILURE_COPY["too-large"] };
  }

  const three = await loadThreeRenderer();
  if (stale()) return { ok: false, failure: "cancelled", message: FAILURE_COPY.cancelled };

  // Lazily, and separately from the core: GLTFLoader is an example module and
  // pulling it into the main chunk would cost every visitor who never uploads one.
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  if (stale()) return { ok: false, failure: "cancelled", message: FAILURE_COPY.cancelled };

  const buffer = await blob.arrayBuffer();
  if (stale()) return { ok: false, failure: "cancelled", message: FAILURE_COPY.cancelled };

  const loader = new GLTFLoader();
  let gltf: Awaited<ReturnType<typeof loader.parseAsync>>;
  try {
    // Parsed from the ArrayBuffer rather than a URL, so there is no object URL to
    // own and no fetch to fail.
    gltf = await loader.parseAsync(buffer, "");
  } catch {
    return { ok: false, failure: "parse-failed", message: FAILURE_COPY["parse-failed"] };
  }

  if (stale()) {
    disposeAvatarScene(gltf.scene);
    return { ok: false, failure: "cancelled", message: FAILURE_COPY.cancelled };
  }

  const scene = gltf.scene;
  const inspection = inspectScene(three, scene);

  if (inspection.meshCount === 0) {
    disposeAvatarScene(scene);
    return { ok: false, failure: "no-mesh", message: FAILURE_COPY["no-mesh"] };
  }

  const headBoneName = findHeadBone(inspection.boneNames);
  const jawBoneName = findJawBone(inspection.boneNames);
  const bounds = measureBounds(three, scene);
  const normalization = deriveNormalization(three, scene, bounds, headBoneName, inspection.headMeshName);
  const capabilities = capabilitiesFromMapping(inspection.mappedMorphs, {
    hasSkeleton: inspection.boneNames.length > 0,
    jawBone: jawBoneName !== null,
  });

  const rigClass = classifyRig({
    hasMorphs: inspection.morphTargetNames.length > 0,
    mappedCount: EXPRESSION_KEYS.filter((key) => capabilities.expressions[key]).length,
    hasSkeleton: inspection.boneNames.length > 0,
    headBone: headBoneName !== null,
  });

  const warnings = deriveWarnings({
    inspection,
    bounds,
    headBoneName,
    capabilities,
    fileSize: blob.size,
    animationCount: gltf.animations.length,
  });

  const format: "glb" | "gltf" = fileName.toLowerCase().endsWith(".gltf") ? "gltf" : "glb";

  return {
    ok: true,
    model: {
      scene,
      animations: gltf.animations,
      profile: {
        kind: "3d-model",
        version: AVATAR_PROFILE_VERSION,
        createdAt: Date.now(),
        fileName,
        fileSizeBytes: blob.size,
        format,
        profileId,
        meshCount: inspection.meshCount,
        skinnedMeshCount: inspection.skinnedMeshCount,
        vertexCount: inspection.vertexCount,
        materialCount: inspection.materialNames.size,
        textureCount: inspection.textureCount,
        largestTextureEdge: inspection.largestTextureEdge,
        hasSkeleton: inspection.boneNames.length > 0,
        boneNames: inspection.boneNames,
        headBoneName,
        jawBoneName,
        hasMorphTargets: inspection.morphTargetNames.length > 0,
        morphTargetNames: inspection.morphTargetNames,
        mappedMorphs: inspection.mappedMorphs,
        unmappedMorphNames: unmappedMorphNames(inspection.morphTargetNames),
        animationNames: gltf.animations.map((clip) => clip.name),
        bounds,
        normalization,
        rigClass,
        capabilities,
        warnings,
      },
    },
  };
}

interface SceneInspection {
  meshCount: number;
  skinnedMeshCount: number;
  vertexCount: number;
  textureCount: number;
  largestTextureEdge: number | null;
  materialNames: Set<string>;
  boneNames: string[];
  morphTargetNames: string[];
  mappedMorphs: Partial<Record<ExpressionKey, MorphTargetLocation[]>>;
  /** The mesh most likely to be the head, for pivoting a model with no head bone. */
  headMeshName: string | null;
}

/**
 * Walks the whole scene.
 *
 * Every mesh, not just the first: a head is routinely split into face, eyes,
 * teeth, tongue, brows and hair, and morph targets can live on several of them.
 * Assuming one mesh is how an eyelid morph gets found on the skin and missed on
 * the eyeball.
 */
function inspectScene(three: Awaited<ReturnType<typeof loadThreeRenderer>>, scene: import("three").Group): SceneInspection {
  const inspection: SceneInspection = {
    meshCount: 0,
    skinnedMeshCount: 0,
    vertexCount: 0,
    textureCount: 0,
    largestTextureEdge: null,
    materialNames: new Set(),
    boneNames: [],
    morphTargetNames: [],
    mappedMorphs: {},
    headMeshName: null,
  };

  const seenMorphNames = new Set<string>();
  const seenTextures = new Set<unknown>();
  let bestHeadScore = -1;

  scene.traverse((node) => {
    if ((node as import("three").Bone).isBone) {
      inspection.boneNames.push(node.name);
      return;
    }

    const mesh = node as import("three").Mesh;
    if (!mesh.isMesh) return;

    inspection.meshCount += 1;
    if ((mesh as import("three").SkinnedMesh).isSkinnedMesh) inspection.skinnedMeshCount += 1;

    const position = mesh.geometry?.getAttribute("position");
    if (position) inspection.vertexCount += position.count;

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) continue;
      inspection.materialNames.add(material.name || material.uuid);
      for (const value of Object.values(material)) {
        const texture = value as import("three").Texture | null;
        if (!texture || !(texture as { isTexture?: boolean }).isTexture) continue;
        if (seenTextures.has(texture)) continue;
        seenTextures.add(texture);
        inspection.textureCount += 1;
        const image = texture.image as { width?: number; height?: number } | undefined;
        const edge = Math.max(image?.width ?? 0, image?.height ?? 0);
        if (edge > (inspection.largestTextureEdge ?? 0)) inspection.largestTextureEdge = edge;
      }
    }

    const dictionary = mesh.morphTargetDictionary;
    if (dictionary) {
      for (const name of Object.keys(dictionary)) {
        if (!seenMorphNames.has(name)) {
          seenMorphNames.add(name);
          inspection.morphTargetNames.push(name);
        }
      }
      for (const match of matchMorphTargets(dictionary)) {
        const list = inspection.mappedMorphs[match.key] ?? [];
        list.push({ meshName: mesh.name || mesh.uuid, morphName: match.morphName, index: match.index });
        inspection.mappedMorphs[match.key] = list;
      }
    }

    /*
     * Which mesh is the head.
     *
     * Only needed to pivot a model that has no head bone. A name containing
     * "head" or "face" is a strong signal; otherwise the mesh carrying facial
     * morphs is a better guess than the largest one, which on a full body is the
     * torso.
     */
    const normalized = mesh.name.toLowerCase();
    const score =
      (normalized.includes("head") ? 4 : 0) +
      (normalized.includes("face") ? 3 : 0) +
      (dictionary ? 2 : 0) +
      ((mesh as import("three").SkinnedMesh).isSkinnedMesh ? 1 : 0);
    if (score > bestHeadScore) {
      bestHeadScore = score;
      inspection.headMeshName = score > 0 ? mesh.name || mesh.uuid : null;
    }
  });

  void three;
  return inspection;
}

function measureBounds(
  three: Awaited<ReturnType<typeof loadThreeRenderer>>,
  scene: import("three").Object3D,
): AvatarBounds {
  const box = new three.Box3().setFromObject(scene);
  const center = new three.Vector3();
  const size = new three.Vector3();
  box.getCenter(center);
  box.getSize(size);

  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
  };
}

/**
 * Scale and pivot, decided once.
 *
 * The pivot is the reason a turning head looks right or looks like a door
 * swinging. Rotating a full-body model about the scene origin swings it from the
 * feet; rotating about the bounding-box centre swings it from the chest. A head
 * bone is the correct answer where one exists, the head mesh's own bounds where
 * one does not, and the scene centre only as a last resort — recorded either way
 * so a wrong pivot is diagnosable.
 */
function deriveNormalization(
  three: Awaited<ReturnType<typeof loadThreeRenderer>>,
  scene: import("three").Group,
  bounds: AvatarBounds,
  headBoneName: string | null,
  headMeshName: string | null,
): AvatarNormalization {
  const largest = Math.max(bounds.size.x, bounds.size.y, bounds.size.z) || 1;
  const scale = TARGET_LARGEST_DIMENSION / largest;

  if (headBoneName) {
    const bone = scene.getObjectByName(headBoneName);
    if (bone) {
      const world = new three.Vector3();
      bone.getWorldPosition(world);
      return { scale, pivot: { x: world.x, y: world.y, z: world.z }, pivotSource: "head-bone" };
    }
  }

  if (headMeshName) {
    const mesh = scene.getObjectByName(headMeshName);
    if (mesh) {
      const headBounds = measureBounds(three, mesh);
      return { scale, pivot: headBounds.center, pivotSource: "head-mesh-bounds" };
    }
  }

  return { scale, pivot: bounds.center, pivotSource: "scene-bounds" };
}

function classifyRig(input: {
  hasMorphs: boolean;
  mappedCount: number;
  hasSkeleton: boolean;
  headBone: boolean;
}): AvatarRigClass {
  // Class A needs morphs CallaStar can actually drive, not merely any morphs.
  if (input.mappedCount > 0) return "rigged-facial";
  if (input.hasSkeleton && input.headBone) return "rigged-head";
  return "static";
}

function deriveWarnings(input: {
  inspection: SceneInspection;
  bounds: AvatarBounds;
  headBoneName: string | null;
  capabilities: ReturnType<typeof capabilitiesFromMapping>;
  fileSize: number;
  animationCount: number;
}): AvatarWarning[] {
  const warnings: AvatarWarning[] = [];
  const { inspection } = input;

  if (inspection.morphTargetNames.length === 0) warnings.push("no-morph-targets");
  if (inspection.boneNames.length === 0) warnings.push("no-skeleton");
  else if (!input.headBoneName) warnings.push("no-head-bone");

  const mapped = EXPRESSION_KEYS.filter((key) => input.capabilities.expressions[key]).length;
  if (mapped > 0 && mapped < EXPRESSION_KEYS.length) warnings.push("partial-expressions");

  if (
    inspection.vertexCount > AVATAR_LIMITS.heavyVertexCount ||
    input.fileSize > AVATAR_LIMITS.heavyFileBytes
  ) {
    warnings.push("heavy-for-mobile");
  }

  if ((inspection.largestTextureEdge ?? 0) > AVATAR_LIMITS.largeTextureEdge) warnings.push("large-texture");

  /*
   * An existing animation is worth flagging rather than blocking.
   *
   * The model must not animate itself — the operator's camera is the only thing
   * that drives it — so no mixer is created and no clip is played. A file that
   * ships an idle loop still works; it simply will not play.
   */
  if (input.animationCount > 0) warnings.push("has-animations");

  const largest = Math.max(input.bounds.size.x, input.bounds.size.y, input.bounds.size.z);
  if (largest < AVATAR_LIMITS.minPlausibleSize || largest > AVATAR_LIMITS.maxPlausibleSize) {
    warnings.push("unusual-scale");
  }

  return warnings;
}

/**
 * Releases everything a loaded scene holds.
 *
 * GPU memory is not garbage collected on scene removal: geometries, materials
 * and every texture on them have to be disposed by hand, and a model swapped a
 * few times without this will exhaust a phone's memory. Traverses the whole
 * scene for the same reason the inspector does.
 */
export function disposeAvatarScene(scene: import("three").Object3D | null): void {
  if (!scene) return;

  const disposedMaterials = new Set<unknown>();
  const disposedTextures = new Set<unknown>();

  scene.traverse((node) => {
    const mesh = node as import("three").Mesh;
    if (!mesh.isMesh) return;

    mesh.geometry?.dispose();

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || disposedMaterials.has(material)) continue;
      disposedMaterials.add(material);

      for (const value of Object.values(material)) {
        const texture = value as import("three").Texture | null;
        if (!texture || !(texture as { isTexture?: boolean }).isTexture) continue;
        if (disposedTextures.has(texture)) continue;
        disposedTextures.add(texture);
        texture.dispose();
      }

      material.dispose();
    }
  });
}
