import { CALL_SOURCE_RULES, MEDIA_LIMITS } from "@/lib/config";
import { formatFileSize, logDiagnostic } from "@/lib/utils";

import type { AssetKind } from "./types";

/**
 * File rules and metadata extraction for uploads. The limits themselves live in
 * `lib/config.ts` so a number is never repeated in a component.
 */

export interface FileRejection {
  ok: false;
  message: string;
}

export type FileCheck = { ok: true } | FileRejection;

function describeTypes(types: readonly string[]): string {
  return types.map((type) => type.split("/")[1]?.toUpperCase() ?? type).join(" or ");
}

export function validateAvatarFile(file: File): FileCheck {
  if (!MEDIA_LIMITS.AVATAR_MIME_TYPES.includes(file.type as (typeof MEDIA_LIMITS.AVATAR_MIME_TYPES)[number])) {
    return { ok: false, message: `Choose a ${describeTypes(MEDIA_LIMITS.AVATAR_MIME_TYPES)} image.` };
  }
  if (file.size > MEDIA_LIMITS.MAX_AVATAR_BYTES) {
    return { ok: false, message: `Images must be ${formatFileSize(MEDIA_LIMITS.MAX_AVATAR_BYTES)} or smaller.` };
  }
  return { ok: true };
}

export function validateRemoteVideoFile(file: File): FileCheck {
  if (
    !MEDIA_LIMITS.REMOTE_VIDEO_MIME_TYPES.includes(
      file.type as (typeof MEDIA_LIMITS.REMOTE_VIDEO_MIME_TYPES)[number],
    )
  ) {
    return { ok: false, message: `Choose an ${describeTypes(MEDIA_LIMITS.REMOTE_VIDEO_MIME_TYPES)} video. MP4 plays everywhere.` };
  }
  if (file.size > MEDIA_LIMITS.MAX_REMOTE_VIDEO_BYTES) {
    return {
      ok: false,
      message: `Videos must be ${formatFileSize(MEDIA_LIMITS.MAX_REMOTE_VIDEO_BYTES)} or smaller in local development.`,
    };
  }
  return { ok: true };
}

/**
 * The audio a profile is heard with on an audio call.
 *
 * The ceiling is lower than video on purpose: an hour of speech is a few tens of
 * megabytes, so anything approaching the video limit is a file in the wrong box.
 */
export function validateRemoteAudioFile(file: File): FileCheck {
  if (
    !MEDIA_LIMITS.REMOTE_AUDIO_MIME_TYPES.includes(
      file.type as (typeof MEDIA_LIMITS.REMOTE_AUDIO_MIME_TYPES)[number],
    )
  ) {
    return { ok: false, message: "Choose an MP3, AAC, WAV or OGG audio file. MP3 plays everywhere." };
  }
  if (file.size > MEDIA_LIMITS.MAX_REMOTE_AUDIO_BYTES) {
    return {
      ok: false,
      message: `Audio files must be ${formatFileSize(MEDIA_LIMITS.MAX_REMOTE_AUDIO_BYTES)} or smaller.`,
    };
  }
  return { ok: true };
}

/** Legacy 9:16 recommendation check. Call source uploads now accept every ratio. */
export type AspectCheck =
  | { ok: true; aspect: number }
  /** Dimensions could not be read; the caller decides whether to accept it. */
  | { ok: false; reason: "unknown"; aspect: null }
  | { ok: false; reason: "landscape" | "aspect"; aspect: number };

export function checkPortraitSource(width: number | null, height: number | null): AspectCheck {
  if (!width || !height) return { ok: false, reason: "unknown", aspect: null };

  const aspect = width / height;

  // A square clip is not portrait either; `>=` is deliberate.
  if (width >= height) return { ok: false, reason: "landscape", aspect };

  const drift = Math.abs(aspect - CALL_SOURCE_RULES.targetAspect);
  if (drift > CALL_SOURCE_RULES.aspectTolerance) return { ok: false, reason: "aspect", aspect };

  return { ok: true, aspect };
}

/** Human ratio for the media page: "9:16", "16:9", "3:4". */
export function describeAspect(width: number | null, height: number | null): string {
  if (!width || !height) return "Unknown";

  const divisor = (a: number, b: number): number => (b === 0 ? a : divisor(b, a % b));
  const factor = divisor(width, height) || 1;
  return `${Math.round(width / factor)}:${Math.round(height / factor)}`;
}

/** Validate the supported format and size. Call source uploads accept any ratio. */
export async function validateCallSourceVideo(file: File): Promise<FileCheck> {
  return validateRemoteVideoFile(file);
}

export function validateFile(kind: AssetKind, file: File): FileCheck {
  if (kind === "avatar") return validateAvatarFile(file);
  if (kind === "remote_audio") return validateRemoteAudioFile(file);
  return validateRemoteVideoFile(file);
}

export interface ExtractedMediaMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

const EMPTY_METADATA: ExtractedMediaMetadata = {
  durationSeconds: null,
  width: null,
  height: null,
  hasAudio: true,
};

/**
 * Read duration and dimensions from a video without decoding the whole file.
 *
 * Metadata is a nicety, so every failure path resolves with nulls rather than
 * rejecting: a video that will not report its duration still uploads.
 */
export function readVideoMetadata(file: File): Promise<ExtractedMediaMetadata> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(EMPTY_METADATA);
      return;
    }

    const element = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (metadata: ExtractedMediaMetadata) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(objectUrl);
      resolve(metadata);
    };

    // Never hold up an upload waiting for optional information.
    const timer = window.setTimeout(() => finish(EMPTY_METADATA), 8000);

    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => {
      const withAudioHints = element as HTMLVideoElement & {
        mozHasAudio?: boolean;
        webkitAudioDecodedByteCount?: number;
        audioTracks?: { length: number };
      };
      // No standard way to ask; assume there is audio unless a browser says otherwise.
      const hasAudio =
        withAudioHints.mozHasAudio ??
        (withAudioHints.audioTracks ? withAudioHints.audioTracks.length > 0 : true);

      finish({
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        width: element.videoWidth || null,
        height: element.videoHeight || null,
        hasAudio,
      });
    };
    element.onerror = () => {
      logDiagnostic("video-metadata", element.error);
      finish(EMPTY_METADATA);
    };

    element.src = objectUrl;
  });
}

/**
 * Duration for an audio file. Same contract as video: optional information,
 * never allowed to hold up or fail an upload.
 */
export function readAudioMetadata(file: File): Promise<ExtractedMediaMetadata> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(EMPTY_METADATA);
      return;
    }

    const element = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (metadata: ExtractedMediaMetadata) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(objectUrl);
      resolve(metadata);
    };

    const timer = window.setTimeout(() => finish(EMPTY_METADATA), 8000);

    element.preload = "metadata";
    element.onloadedmetadata = () =>
      finish({
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        width: null,
        height: null,
        hasAudio: true,
      });
    element.onerror = () => {
      logDiagnostic("audio-metadata", element.error);
      finish(EMPTY_METADATA);
    };

    element.src = objectUrl;
  });
}

/** Pixel dimensions of an image, so a chat bubble can reserve the right shape. */
export function readImageMetadata(file: File): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve({ width: null, height: null });
      return;
    }

    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (size: { width: number | null; height: number | null }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      resolve(size);
    };

    const timer = window.setTimeout(() => finish({ width: null, height: null }), 5000);
    image.onload = () => finish({ width: image.naturalWidth || null, height: image.naturalHeight || null });
    image.onerror = () => finish({ width: null, height: null });
    image.src = objectUrl;
  });
}

/** Read an image into a self-contained data URL (used for public host avatars). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
