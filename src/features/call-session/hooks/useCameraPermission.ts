import { useEffect, useState } from "react";

import { logDiagnostic } from "@/lib/utils";
import type { MediaPermissionState } from "@/types/media";

/**
 * Best-effort read of the camera permission.
 *
 * The Permissions API does not cover `camera` in Safari (it throws on the
 * query), so "unsupported" is a normal answer rather than an error. Used to
 * sharpen the wording on the permission screen — never to decide whether to
 * call getUserMedia, which stays the single source of truth.
 */
export function useCameraPermission(enabled: boolean = true): MediaPermissionState {
  const [permission, setPermission] = useState<MediaPermissionState>("unknown");

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.permissions?.query) {
      setPermission("unsupported");
      return;
    }

    let active = true;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (active && status) setPermission(status.state as MediaPermissionState);
    };

    navigator.permissions
      // `camera` is not in every browser's PermissionName union.
      .query({ name: "camera" as PermissionName })
      .then((result) => {
        if (!active) return;
        status = result;
        setPermission(result.state as MediaPermissionState);
        result.addEventListener("change", onChange);
      })
      .catch((error) => {
        logDiagnostic("permissions-query", error);
        if (active) setPermission("unsupported");
      });

    return () => {
      active = false;
      status?.removeEventListener("change", onChange);
    };
  }, [enabled]);

  return permission;
}
