import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";

import { callSessionReducer, initialCallSessionState } from "./callSessionReducer";
import type { CallSessionAction, CallSessionState } from "./callSessionReducer";

interface CallSessionContextValue {
  session: CallSessionState;
  dispatch: Dispatch<CallSessionAction>;
}

const CallSessionContext = createContext<CallSessionContextValue | null>(null);

/**
 * The call session lives in one reducer for the whole app. Screens read status
 * and render; they never coordinate each other directly.
 */
export function CallSessionProvider({ children }: { children: ReactNode }) {
  const [session, dispatch] = useReducer(callSessionReducer, initialCallSessionState);
  const value = useMemo(() => ({ session, dispatch }), [session]);

  return <CallSessionContext.Provider value={value}>{children}</CallSessionContext.Provider>;
}

export function useCallSession(): CallSessionContextValue {
  const context = useContext(CallSessionContext);
  if (!context) {
    throw new Error("useCallSession must be used inside a CallSessionProvider");
  }
  return context;
}
