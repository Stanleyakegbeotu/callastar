import { useEffect, useRef } from "react";

import { useCallSession } from "./CallSessionContext";

/**
 * Clears a leftover call session when a screen outside the call flow mounts.
 *
 * Leaving a call is a navigation, not a state change: React Router runs
 * navigations in a transition, so resetting the session in the same handler
 * lets the call route re-render first, see a session that no longer exists and
 * redirect somewhere nobody asked for. Clearing on arrival instead keeps the
 * two apart.
 *
 * It fires once per mount and reads the status through a ref, so it can never
 * wipe a session that the screen itself has just created (the join form
 * creates one, then navigates).
 */
export function useClearStaleSession(): void {
  const { session, dispatch } = useCallSession();
  const statusRef = useRef(session.status);
  statusRef.current = session.status;
  const cleared = useRef(false);

  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    if (statusRef.current !== "idle") {
      dispatch({ type: "RESET_CALL" });
    }
  }, [dispatch]);
}
