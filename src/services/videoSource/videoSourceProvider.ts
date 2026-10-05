import { logDiagnostic } from "@/lib/utils";
import { mediaAssetProvider } from "@/services/media/mediaAssetProvider";
import { requestLocalStream, stopStream } from "@/services/media/mediaDevices";
import type { VideoSourceKind } from "@/services/signaling";

/**
 * How a host appears on a call.
 *
 * A provider per source so the call screen never learns what any of them
 * involve. Today that is the phone camera or a video the operator uploaded;
 * FilterCore will be a third, and it must be able to arrive without the call UI
 * changing — which is the whole reason this interface exists rather than an
 * `if (usingCamera)` inside the call page.
 *
 * `prepare` and `start` are separate on purpose. Preparing may check that an
 * asset exists, or that the browser can do this at all; starting is what asks
 * for the camera. Keeping them apart is what lets the source-selection sheet
 * disable an option it knows will fail instead of finding out after the host has
 * already answered and the caller is waiting.
 */

export type { VideoSourceKind };

/**
 * What starting a source produced.
 *
 * Two genuinely different shapes, because the two sources reach the other person
 * by different routes. A camera yields a track this side publishes. An uploaded
 * source does not: the far end plays the file itself from an authorised URL,
 * because re-encoding an MP4 into a camera track through a canvas is unreliable
 * across mobile browsers and would cost a phone its battery to do badly.
 */
export type VideoSourceResult =
  /** A live track to publish on the peer connection. */
  | { mode: "track"; kind: VideoSourceKind; stream: MediaStream; videoTrack: MediaStreamTrack | null }
  /** Nothing to publish here; the far end plays this asset. */
  | { mode: "remote-playback"; kind: VideoSourceKind; mediaAssetId: string };

export type VideoSourceAvailability =
  | { available: true }
  /**
   * `storage_unreachable` is not the same as `not_uploaded`, and the UI must not
   * conflate them: one is an operator who has not uploaded a video, the other is
   * a deployment whose media storage is not connected.
   */
  | { available: false; reason: "not_uploaded" | "storage_unreachable" | "not_implemented" };

export interface VideoSourceProvider {
  readonly kind: VideoSourceKind;
  /** Checks this source can actually be used, without acquiring anything. */
  prepare(): Promise<VideoSourceAvailability>;
  start(): Promise<VideoSourceResult>;
  stop(): Promise<void>;
}

/**
 * The phone's own camera.
 *
 * `facingMode: "user"` is the intent — a call starts on the front camera — and
 * the flip control swaps it later through the sender rather than by restarting
 * anything. Constraints stay as ideals so a phone that cannot do 1080×1920
 * negotiates down instead of failing outright.
 */
export function createLiveCameraSource(callType: "video" | "audio" = "video"): VideoSourceProvider {
  let stream: MediaStream | null = null;

  return {
    kind: "live-camera",

    async prepare() {
      if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
        return { available: false, reason: "not_implemented" };
      }
      return { available: true };
    },

    async start() {
      // The permission prompt happens here and nowhere earlier: by this point the
      // host has chosen this source for a call that is already answered.
      stream = await requestLocalStream({ callType, facingMode: "user" });
      const [videoTrack] = stream.getVideoTracks();
      return { mode: "track", kind: "live-camera", stream, videoTrack: videoTrack ?? null };
    },

    async stop() {
      stopStream(stream);
      stream = null;
    },
  };
}

/**
 * A video the operator uploaded for this profile.
 *
 * Only the asset id leaves this provider. Resolving it to a playable URL is the
 * media provider's job on the side that plays it, so a browser never puts a
 * storage URL on the wire — a URL minted by one client is not something the
 * other should trust.
 */
export function createUploadedSource(mediaAssetId: string | null): VideoSourceProvider {
  return {
    kind: "uploaded-source",

    async prepare() {
      if (!mediaAssetId) return { available: false, reason: "not_uploaded" };

      // An asset that exists but cannot be reached from another device is not
      // usable for a call, however present it looks in the dashboard.
      if (!mediaAssetProvider.reachableAcrossDevices) {
        return { available: false, reason: "storage_unreachable" };
      }

      const resolution = await mediaAssetProvider.resolvePlayback(mediaAssetId);
      if (!resolution.available) return { available: false, reason: resolution.reason };

      // Prepared, not consumed: release the probe's URL immediately.
      resolution.source.release();
      return { available: true };
    },

    async start() {
      if (!mediaAssetId) throw new Error("No call source is uploaded for this profile.");
      return { mode: "remote-playback", kind: "uploaded-source", mediaAssetId };
    },

    async stop() {
      // Nothing is held on this side; the playing end releases its own URL.
    },
  };
}

/**
 * FilterCore — the seam only.
 *
 * Not implemented, and deliberately not offered anywhere in the UI: no button,
 * no "coming soon". It is declared so the day it arrives is a new provider and a
 * `replaceTrack`, not a change to the call screen.
 *
 * The intended shape:
 *
 *   camera → FilterCore → transformed MediaStreamTrack → videoSender.replaceTrack
 *
 * which is why `RtcCallEngine` keeps its senders and replaces tracks instead of
 * rebuilding the peer connection whenever a source changes.
 */
export function createFilterCoreSource(): VideoSourceProvider {
  return {
    kind: "filter-core",
    async prepare() {
      return { available: false, reason: "not_implemented" };
    },
    async start() {
      throw new Error("FilterCore is not implemented.");
    },
    async stop() {},
  };
}

export interface VideoSourceSelection {
  kind: VideoSourceKind;
  /** Required for `uploaded-source`. */
  mediaAssetId?: string | null;
  callType?: "video" | "audio";
}

export function createVideoSource(selection: VideoSourceSelection): VideoSourceProvider {
  switch (selection.kind) {
    case "live-camera":
      return createLiveCameraSource(selection.callType ?? "video");
    case "uploaded-source":
      return createUploadedSource(selection.mediaAssetId ?? null);
    case "filter-core":
      return createFilterCoreSource();
  }
}

/**
 * What the source-selection sheet needs to draw itself.
 *
 * Asked before the sheet is shown so an unusable option is disabled with a
 * reason rather than failing after the host has already committed to it.
 */
export async function describeSourceOptions(
  mediaAssetId: string | null,
): Promise<{ liveCamera: VideoSourceAvailability; uploadedSource: VideoSourceAvailability }> {
  const camera = createLiveCameraSource();
  const uploaded = createUploadedSource(mediaAssetId);

  const [liveCamera, uploadedSource] = await Promise.all([
    camera.prepare().catch((error: unknown) => {
      logDiagnostic("source-prepare-camera", error);
      return { available: false, reason: "not_implemented" } as VideoSourceAvailability;
    }),
    uploaded.prepare().catch((error: unknown) => {
      logDiagnostic("source-prepare-uploaded", error);
      return { available: false, reason: "storage_unreachable" } as VideoSourceAvailability;
    }),
  ]);

  return { liveCamera, uploadedSource };
}
