import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { config } from "@/lib/config";
import { isDevelopmentAdminEnabled, startDevelopmentSession } from "@/features/admin/auth/adminAuth";

/**
 * A hidden way into the dashboard while building.
 *
 * Five deliberate taps on the onboarding brand mark open `/admin`. It exists so
 * a developer can look at the CRM without going through the login screen on
 * every reload, and it is NOT an authentication mechanism:
 *
 *  - `config.enableDevAdminShortcut` requires both `import.meta.env.DEV` and an
 *    explicit `VITE_ENABLE_DEV_ADMIN_SHORTCUT=true`, so a production bundle
 *    evaluates it to false at build time and the taps do nothing at all.
 *  - It grants no privileges of its own. It starts the same development session
 *    the login screen already offers, which `AdminRoute` is free to reject —
 *    and does reject, whenever development auth is off. When real Supabase
 *    authentication lands, that guard stays authoritative and this goes away.
 */
const TAPS_REQUIRED = 5;
/** Rolling window. Long enough to be deliberate, short enough to be private. */
const WINDOW_MS = 2500;
/** How long the confirmation shows before navigating. */
const FEEDBACK_MS = 600;

export interface DevAdminShortcut {
  /** Spread onto the brand hit area. Empty when the shortcut is not armed. */
  handlers: { onPointerUp?: (event: React.PointerEvent) => void };
  /** True between the fifth tap and the navigation. */
  activating: boolean;
}

export function useDevAdminShortcut(): DevAdminShortcut {
  const navigate = useNavigate();
  const [activating, setActivating] = useState(false);
  const taps = useRef(0);
  const windowTimer = useRef<number | null>(null);
  const navigateTimer = useRef<number | null>(null);

  const enabled = config.enableDevAdminShortcut;

  useEffect(
    () => () => {
      if (windowTimer.current !== null) window.clearTimeout(windowTimer.current);
      if (navigateTimer.current !== null) window.clearTimeout(navigateTimer.current);
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      // Primary button only, so a right-click or a stray secondary touch is not
      // a tap. Pointer events cover mouse and touch without the synthetic
      // duplicates that listening for both would produce.
      if (event.button !== 0) return;

      taps.current += 1;

      if (windowTimer.current !== null) window.clearTimeout(windowTimer.current);
      windowTimer.current = window.setTimeout(() => {
        taps.current = 0;
      }, WINDOW_MS);

      if (taps.current < TAPS_REQUIRED) return;

      taps.current = 0;
      window.clearTimeout(windowTimer.current);
      windowTimer.current = null;

      // The same development session the login screen starts. If development
      // auth is off, this is a no-op and AdminRoute sends us to the login page —
      // which is the correct outcome, not a bug.
      if (isDevelopmentAdminEnabled()) startDevelopmentSession();

      setActivating(true);
      navigateTimer.current = window.setTimeout(() => navigate("/admin"), FEEDBACK_MS);
    },
    [navigate],
  );

  return { handlers: enabled ? { onPointerUp } : {}, activating };
}
