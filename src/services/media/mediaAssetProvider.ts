import { logDiagnostic } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import { resolveAdminMedia } from "./privateMedia";

/**
 * How a stored media asset becomes something playable.
 *
 * This is the seam that decides whether an uploaded call source can reach the
 * OTHER person's phone. It matters because the honest answer today is no: call
 * sources live in the operator's own browser, in IndexedDB, and a blob in one
 * browser is not addressable from another device by any means. No amount of
 * signalling changes that.
 *
 * So `reachableAcrossDevices` is part of the contract rather than a footnote.
 * The local implementation reports false, the call flow reads it, and a host who
 * picks Uploaded Source is told plainly instead of a guest being shown a frozen
 * frame that never loads.
 */

export interface PlaybackSource {
  /** Playable by a <video> or <audio> element on THIS device. */
  url: string;
  /** Epoch ms after which the URL should not be used. null when it never expires. */
  expiresAt: number | null;
  /** Called when the consumer is finished; revokes an object URL. */
  release: () => void;
}

export type PlaybackResolution =
  | { available: true; source: PlaybackSource; hasAudio: boolean }
  | { available: false; reason: "not_uploaded" | "storage_unreachable" };

export interface MediaAssetProvider {
  /**
   * Whether a URL from this provider can be opened by a different device.
   *
   * False for browser-local storage. The uploaded-source call path is only
   * complete when this is true.
   */
  readonly reachableAcrossDevices: boolean;

  /** Resolves an opaque asset id into something playable, or says why not. */
  resolvePlayback(assetId: string): Promise<PlaybackResolution>;
}

/**
 * Reads the bytes out of the local IndexedDB engine.
 *
 * Every object URL made here is revoked by the `release` handed back with it —
 * the same ownership rule the rest of the app follows, where whoever created a
 * URL revokes it.
 */
export const localMediaAssetProvider: MediaAssetProvider = {
  // A blob URL is scoped to the document that made it. Not even another tab on
  // the same machine can open it, let alone another phone.
  reachableAcrossDevices: false,

  async resolvePlayback(assetId) {
    try {
      const blob = await adminRepository.getAssetBlob(assetId);
      if (!blob) return { available: false, reason: "not_uploaded" };

      const meta = await adminRepository.getAssetMeta(assetId);
      const url = URL.createObjectURL(blob);

      return {
        available: true,
        hasAudio: meta?.hasAudio ?? true,
        source: {
          url,
          expiresAt: null,
          release: () => URL.revokeObjectURL(url),
        },
      };
    } catch (error) {
      logDiagnostic("media-asset-local", error);
      return { available: false, reason: "storage_unreachable" };
    }
  },
};

/**
 * Remote object storage — deliberately unimplemented.
 *
 * Finishing this is what makes a host's uploaded source usable on a real call
 * between two phones. It needs: the asset uploaded to a bucket rather than to
 * IndexedDB, and an authorised endpoint that exchanges an asset id plus a call
 * attempt for a short-lived signed URL — scoped to that call, so a playback URL
 * cannot be passed around afterwards.
 */
export const remoteMediaAssetProvider: MediaAssetProvider = {
  reachableAcrossDevices: true,

  async resolvePlayback(assetId) {
    try {
      const asset = await resolveAdminMedia(assetId);
      if (!asset) return { available: false, reason: "not_uploaded" };
      return { available: true, hasAudio: asset.hasAudio, source: { url: asset.url, expiresAt: asset.expiresAt, release: () => {} } };
    } catch { return { available: false, reason: "storage_unreachable" }; }
  },
};

/**
 * The local engine, matching `adminDataMode`.
 *
 * Swapped for the remote provider by the same configuration that moves the rest
 * of the app to Supabase, never by a runtime fallback.
 */
export const mediaAssetProvider: MediaAssetProvider =
  adminRepository.mode === "local" ? localMediaAssetProvider : remoteMediaAssetProvider;
