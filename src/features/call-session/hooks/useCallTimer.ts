import { useEffect, useState } from "react";

/**
 * Seconds elapsed since `since`, ticking once a second while `running`.
 *
 * Each tick recomputes from the timestamp rather than incrementing a counter,
 * so a throttled background tab catches up instead of drifting. Passing a new
 * `since` (a new call) resets the count.
 */
export function useCallTimer(since: number | null, running: boolean = true): number {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(since));

  useEffect(() => {
    if (since === null || !running) {
      setSeconds(elapsedSeconds(since));
      return;
    }

    setSeconds(elapsedSeconds(since));
    const interval = window.setInterval(() => setSeconds(elapsedSeconds(since)), 1000);
    return () => window.clearInterval(interval);
  }, [since, running]);

  return seconds;
}

function elapsedSeconds(since: number | null): number {
  if (since === null) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}
