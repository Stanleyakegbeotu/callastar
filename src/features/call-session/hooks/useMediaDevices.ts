import { useCallback, useEffect, useMemo, useState } from "react";

import { listVideoInputs } from "@/services/media/mediaDevices";

export interface MediaDevicesInfo {
  videoInputs: MediaDeviceInfo[];
  /** A flip is only meaningful when the device really has a second camera. */
  canSwitchCamera: boolean;
  refresh: () => Promise<void>;
}

/**
 * Tracks the cameras available to the app.
 *
 * Device lists are deliberately vague before a permission grant (no labels, and
 * on some browsers no entries at all), so this is refreshed after the stream is
 * acquired as well as on `devicechange`.
 */
export function useMediaDevices(): MediaDevicesInfo {
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    const inputs = await listVideoInputs();
    setVideoInputs(inputs);
  }, []);

  useEffect(() => {
    let active = true;

    const update = () => {
      void listVideoInputs().then((inputs) => {
        if (active) setVideoInputs(inputs);
      });
    };

    update();
    navigator.mediaDevices?.addEventListener?.("devicechange", update);

    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", update);
    };
  }, []);

  // Stable identity: hooks that call `refresh` depend on this object, and a new
  // object every render would restart their effects.
  return useMemo(
    () => ({
      videoInputs,
      canSwitchCamera: videoInputs.length > 1,
      refresh,
    }),
    [videoInputs, refresh],
  );
}
