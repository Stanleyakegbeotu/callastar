import { formatFileSize } from "@/lib/utils";

import type { SourceKind } from "./sourceTypes";

/**
 * Deciding what a source file actually is.
 *
 * Deliberately NOT from the filename, and not from `File.type` alone. A browser
 * fills `type` from the extension on most platforms, so a `.jpg` that is really
 * a video arrives claiming to be an image — and the failure lands much later,
 * inside a decoder, as something unrecognisable.
 *
 * So the first bytes are read and matched against the container signature. The
 * declared type is then used only to choose between formats that share one
 * signature, never to overrule what the bytes say.
 *
 * The accepted set is deliberately narrow: the formats this project already
 * accepts elsewhere, and no more. Broadening codecs "because a browser might
 * cope" means shipping a path nobody has run.
 */

/** Accepted image containers. Matches the avatar rules the admin already uses. */
export const SOURCE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Accepted video containers. MP4 first: it plays everywhere, iOS included. */
export const SOURCE_VIDEO_TYPES = ["video/mp4", "video/webm"] as const;

/**
 * Accepted 3D containers. GLB first, and preferred.
 *
 * A single GLB carries geometry, textures, materials, skeleton and morph targets
 * together, so one file is either usable or it is not. A `.gltf` referencing
 * external `.bin` and texture files can only be loaded whole, which a single file
 * input cannot supply — so it is accepted and will fail honestly at parse time if
 * its dependencies are missing, rather than being refused up front.
 *
 * FBX and OBJ are deliberately absent: neither would be trivial, and OBJ has no
 * concept of a skeleton or a morph target at all.
 */
export const SOURCE_MODEL_TYPES = ["model/gltf-binary", "model/gltf+json"] as const;

export const SOURCE_LIMITS = {
  /**
   * A 3D model ceiling, above the video one.
   *
   * A rigged head with 2K textures is routinely 20-40MB, and refusing those would
   * reject most real avatars. `AVATAR_LIMITS` warns about mobile weight
   * separately, from measured vertex and texture counts rather than file size.
   */
  maxModelBytes: 64 * 1024 * 1024,
  /** Same ceiling as an avatar: a source still is a photograph, not a master. */
  maxImageBytes: 10 * 1024 * 1024,
  /**
   * Lower than a call-source video on purpose.
   *
   * A reference clip needs a few seconds of somebody's head, not a scene. The
   * sampler reads a bounded number of frames however long the file is, so a
   * large upload costs decode time and memory for nothing.
   */
  maxVideoBytes: 60 * 1024 * 1024,
  /** Enough header for every signature below. */
  signatureBytes: 16,
} as const;

export type SourceMediaType =
  | (typeof SOURCE_IMAGE_TYPES)[number]
  | (typeof SOURCE_VIDEO_TYPES)[number]
  | (typeof SOURCE_MODEL_TYPES)[number];

export interface SourceAsset {
  kind: SourceKind;
  mimeType: SourceMediaType;
  fileName: string;
  /** The bytes. Held for the analysis and released with the source. */
  blob: Blob;
  /** Set when this came from the admin media library rather than an upload. */
  assetId: string | null;
}

export type SourceValidation =
  | { ok: true; kind: SourceKind; mimeType: SourceMediaType }
  | { ok: false; message: string };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * The container, from the bytes.
 *
 * Returns null when nothing matches — which is the honest answer for a file
 * this project does not accept, and is reported as such rather than guessed at.
 */
export function sniffMediaType(bytes: Uint8Array): SourceMediaType | null {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // WebP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }

  // Matroska/WebM: 1A 45 DF A3. The EBML header is shared with MKV, which this
  // project does not accept — the declared type decides, and anything else is
  // refused rather than hoped for.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";

  // ISO base media (MP4, M4V, MOV): "ftyp" at offset 4.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4";

  // GLB: "glTF" magic, then a little-endian version.
  if (startsWith(bytes, [0x67, 0x6c, 0x54, 0x46])) return "model/gltf-binary";

  return null;
}

/**
 * A `.gltf` is JSON, so it has no binary signature to sniff.
 *
 * Checked separately and only when a filename says `.gltf`, because "starts with
 * a brace" would also match any other JSON somebody dropped in. The parse itself
 * is the real validation.
 */
function looksLikeGltfJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b;
  }
  return false;
}

export function kindOf(mimeType: SourceMediaType): SourceKind {
  if ((SOURCE_IMAGE_TYPES as readonly string[]).includes(mimeType)) return "image";
  if ((SOURCE_MODEL_TYPES as readonly string[]).includes(mimeType)) return "3d-model";
  return "video";
}

/**
 * Whether a file may be used as a source.
 *
 * Size is checked against the kind the BYTES say it is, so a video renamed to
 * `.png` is measured as a video rather than slipping under an image ceiling.
 */
export async function validateSourceFile(file: File): Promise<SourceValidation> {
  const header = new Uint8Array(await file.slice(0, SOURCE_LIMITS.signatureBytes).arrayBuffer());
  let sniffed = sniffMediaType(header);

  // A .gltf carries no magic number. Trusted only when the extension asks for it
  // and the bytes are at least JSON; the loader decides the rest.
  if (!sniffed && file.name.toLowerCase().endsWith(".gltf") && looksLikeGltfJson(header)) {
    sniffed = "model/gltf+json";
  }

  if (!sniffed) {
    return {
      ok: false,
      message:
        "This file is not a supported source. Use a JPEG, PNG or WebP image, an MP4 or WebM video, or a GLB or glTF model.",
    };
  }

  // The bytes decide the family; the declared type only resolves ambiguity
  // within it. A WebM signature with a declared MKV type is still refused.
  if (sniffed === "video/webm" && file.type && file.type !== "video/webm") {
    return { ok: false, message: "This looks like a Matroska file. Use an MP4 or WebM video." };
  }

  const kind = kindOf(sniffed);
  const limit =
    kind === "image"
      ? SOURCE_LIMITS.maxImageBytes
      : kind === "3d-model"
        ? SOURCE_LIMITS.maxModelBytes
        : SOURCE_LIMITS.maxVideoBytes;

  if (file.size > limit) {
    const noun = kind === "image" ? "Images" : kind === "3d-model" ? "Models" : "Videos";
    return { ok: false, message: `${noun} must be ${formatFileSize(limit)} or smaller.` };
  }

  if (file.size === 0) return { ok: false, message: "This file is empty." };

  return { ok: true, kind, mimeType: sniffed };
}

/** A validated upload. Temporary: nothing is written to storage. */
export async function sourceFromFile(file: File): Promise<SourceAsset | { error: string }> {
  const validation = await validateSourceFile(file);
  if (!validation.ok) return { error: validation.message };

  return {
    kind: validation.kind,
    mimeType: validation.mimeType,
    fileName: file.name,
    blob: file,
    assetId: null,
  };
}

/**
 * An asset the admin already stored.
 *
 * Reuses the existing media library rather than adding a second one: the bytes
 * come from `AdminRepository.getAssetBlob`, and the id travels into the profile
 * so a renderer can fetch them again without this layer holding them open.
 */
export async function sourceFromStoredAsset(
  assetId: string,
  fileName: string,
  blob: Blob,
): Promise<SourceAsset | { error: string }> {
  const header = new Uint8Array(await blob.slice(0, SOURCE_LIMITS.signatureBytes).arrayBuffer());
  const sniffed = sniffMediaType(header);

  if (!sniffed) return { error: "This stored file is not a supported image or video." };

  return { kind: kindOf(sniffed), mimeType: sniffed, fileName, blob, assetId };
}
