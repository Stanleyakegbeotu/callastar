import { useEffect, type Dispatch } from "react";

import { CALL_TIMINGS } from "@/lib/config";
import type { CallSessionAction } from "@/state/callSessionReducer";
import type { CallPhase } from "@/types/call";

/**
 * The SIMULATED connect-and-ring sequence.
 *
 * This is not how a real call is paced. A real call moves when signalling says
 * it does — the host's phone rings, somebody taps Answer, ICE connects — and
 * that path is `useGuestCallFlow`, which has no timers of this kind at all.
 *
 * This hook remains for the configuration where there is no signalling service
 * (`VITE_SIGNALING_URL` unset) and for demo mode. Without it, a build with no
 * service would simply never reach an active call, and the existing product
 * would stop working for anyone who has not deployed one yet. It is deliberately
 * named and documented as a simulation so it cannot be mistaken for the real
 * thing.
 *
 * The cleanup below plus the reducer's transition guards make it impossible for
 * a timer that fired after the call ended to move the session anywhere.
 */
export function useSimulatedCallFlow(
  status: CallPhase,
  dispatch: Dispatch<CallSessionAction>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return undefined;

    if (status === "connecting") {
      const timer = window.setTimeout(() => dispatch({ type: "START_RINGING" }), CALL_TIMINGS.connectingMs);
      return () => window.clearTimeout(timer);
    }

    if (status === "ringing") {
      // Stands in for the host answering. On the real path this arrives as a
      // `call.accept` from the other phone.
      const timer = window.setTimeout(() => dispatch({ type: "CALL_CONNECTED" }), CALL_TIMINGS.ringingMs);
      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [status, dispatch, enabled]);
}

export default useSimulatedCallFlow;
