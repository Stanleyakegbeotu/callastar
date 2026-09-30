import { useCallback, useEffect, useRef, useState } from "react";

import { logDiagnostic } from "@/lib/utils";
import {
  createMediaError,
  requestLocalStream,
  stopStream,
  stopTracks,
  supportsAudioOutputSelection,
  toMediaError,
} from "@/services/media/mediaDevices";
import type { CallType } from "@/types/call";
import type {
  CameraFacingMode,
  LocalMediaController,
  LocalMediaOutcome,
  LocalMediaStatus,
  MediaErrorInfo,
} from "@/types/media";

import { useMediaDevices } from "./useMediaDevices";

/** Grab a single camera track, discarding anything else the browser hands back. */
async function acquireVideoTrack(callType: CallType, facingMode: CameraFacingMode): Promise<MediaStreamTrack> {
  const stream = await requestLocalStream({ callType, facingMode, videoOnly: true });
  const [track, ...extra] = stream.getVideoTracks();
  stopTracks([...extra, ...stream.getAudioTracks()]);
  if (!track) {
    stopStream(stream);
    throw createMediaError("device_not_found");
  }
  return track;
}

/**
 * Owns the caller's camera and microphone for one call.
 *
 * Everything the call controls need happens on live tracks: muting and the
 * camera toggle flip `track.enabled` (the stream stays open), a flip swaps the
 * video track while keeping the same audio track, and teardown stops every
 * track so the browser indicator goes out.
 */
export function useLocalMedia(callType: CallType): LocalMediaController {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<LocalMediaStatus>("idle");
  const [error, setError] = useState<MediaErrorInfo | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(callType === "video");
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("user");
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  /**
   * Bumped by every new request and by teardown. An in-flight getUserMedia that
   * resolves against a stale generation is stopped immediately, which is what
   * keeps StrictMode's double mount (and a fast back button) from leaving a
   * second camera running.
   */
  const generationRef = useRef(0);
  const devices = useMediaDevices();
  /**
   * The device list changes as soon as a grant reveals labels. Reading it through
   * a ref keeps `request` and `switchCamera` referentially stable, so the effect
   * that calls them cannot re-fire and open a second camera.
   */
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const canSwitchCamera = devices.canSwitchCamera;

  const adopt = useCallback((next: MediaStream) => {
    streamRef.current = next;
    setStream(next);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setStatus("idle");
    setIsSwitchingCamera(false);
  }, []);

  const request = useCallback(async (): Promise<LocalMediaOutcome> => {
    generationRef.current += 1;
    const generation = generationRef.current;

    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setStatus("requesting");
    setError(null);

    try {
      const next = await requestLocalStream({ callType, facingMode: "user" });

      if (generation !== generationRef.current) {
        stopStream(next);
        return { outcome: "cancelled" };
      }

      adopt(next);
      setStatus("ready");
      setMicEnabled(next.getAudioTracks().some((track) => track.enabled));
      setCameraEnabled(next.getVideoTracks().some((track) => track.enabled));
      setFacingMode("user");
      // Labels and the full camera list only exist after a grant.
      void devicesRef.current.refresh();
      return { outcome: "granted" };
    } catch (rawError) {
      if (generation !== generationRef.current) {
        return { outcome: "cancelled" };
      }
      const mediaError = toMediaError(rawError);
      setStatus("error");
      setError(mediaError);
      return { outcome: "failed", error: mediaError };
    }
  }, [adopt, callType]);

  const toggleMic = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const nextEnabled = !tracks.every((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    setMicEnabled(nextEnabled);
  }, []);

  /**
   * Turning the camera off disables the track rather than stopping it: the call
   * keeps its stream, and turning it back on is instant with no second prompt.
   */
  const toggleCamera = useCallback(() => {
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    if (tracks.length === 0) return;
    const nextEnabled = !tracks.every((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    setCameraEnabled(nextEnabled);
  }, []);

  const switchCamera = useCallback(async () => {
    const current = streamRef.current;
    if (!current || isSwitchingCamera || !canSwitchCamera) return;

    const generation = generationRef.current;
    const nextFacing: CameraFacingMode = facingMode === "user" ? "environment" : "user";
    const previousVideoTracks = current.getVideoTracks();
    setIsSwitchingCamera(true);

    const commit = (track: MediaStreamTrack, facing: CameraFacingMode) => {
      track.enabled = cameraEnabled;
      // The audio tracks are carried over, never stopped, so the microphone
      // (and its mute state) survives the flip.
      const audioTracks = current.getAudioTracks();
      stopTracks(current.getVideoTracks());
      adopt(new MediaStream([track, ...audioTracks]));
      setFacingMode(facing);
    };

    try {
      let replacement: MediaStreamTrack;
      try {
        replacement = await acquireVideoTrack(callType, nextFacing);
      } catch (firstAttempt) {
        // Plenty of phones will only run one camera at a time, so release the
        // current one before asking for the other.
        logDiagnostic("switch-camera-retry", firstAttempt);
        stopTracks(previousVideoTracks);
        try {
          replacement = await acquireVideoTrack(callType, nextFacing);
        } catch (secondAttempt) {
          logDiagnostic("switch-camera-restore", secondAttempt);
          replacement = await acquireVideoTrack(callType, facingMode);
          if (generation === generationRef.current) commit(replacement, facingMode);
          else stopTracks([replacement]);
          return;
        }
      }

      if (generation !== generationRef.current) {
        stopTracks([replacement]);
        return;
      }

      commit(replacement, nextFacing);
      void devicesRef.current.refresh();
    } catch (switchError) {
      // Nothing was swapped in, so the call continues on whatever is left.
      logDiagnostic("switch-camera", switchError);
    } finally {
      setIsSwitchingCamera(false);
    }
  }, [adopt, callType, cameraEnabled, canSwitchCamera, facingMode, isSwitchingCamera]);

  // Leaving the call screen for any reason releases the hardware.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  return {
    stream,
    status,
    error,
    micEnabled,
    cameraEnabled,
    hasVideoTrack: (stream?.getVideoTracks().length ?? 0) > 0,
    facingMode,
    canSwitchCamera,
    isSwitchingCamera,
    canSelectAudioOutput: supportsAudioOutputSelection(),
    request,
    toggleMic,
    toggleCamera,
    switchCamera,
    stop,
  };
}
