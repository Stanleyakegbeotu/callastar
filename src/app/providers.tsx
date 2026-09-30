import type { ReactNode } from "react";

import { CallSessionProvider } from "@/state/CallSessionContext";

/**
 * Application-wide providers. Only the call session for now; anything added
 * later (a theme, an API client) belongs here rather than in App.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <CallSessionProvider>{children}</CallSessionProvider>;
}

export default AppProviders;
