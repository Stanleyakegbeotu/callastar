import { useEffect, useRef, useState } from "react";

/**
 * The time a paid session is entitled to.
 *
 * Only for calls authorised by a Subscription Access ID: the plan sells a
 * length — 15, 30 or 60 minutes — and this is what counts it down. An unpaid
 * preview is governed by the subscription checkpoint instead, and never by
 * this.
 *
 * Computed from the start timestamp on every tick rather than decremented, so a
 * backgrounded tab that stops getting timers catches up when it returns instead
 * of granting extra minutes.
 */

/** How long before the end the caller is warned. */
const WARNING_SECONDS = 60;

export interface SessionLimit {
  /** Seconds left, or null when this call has no limit. */
  remainingSeconds: number | null;
  /** True inside the last minute, so the call can say so without interrupting. */
  warning: boolean;
  expired: boolean;
}

interface SessionLimitOptions {
  /** Epoch ms the call became active. The limit runs from connection, not dial. */
  startedAt: number | null;
  /** From the plan. Null or zero means no limit applies. */
  minutes: number | null;
  active: boolean;
  /** Called once, when the time is up. */
  onExpire: () => void;
}

export function useSessionLimit({ startedAt, minutes, active, onExpire }: SessionLimitOptions): SessionLimit {
  const limited = active && startedAt !== null && minutes !== null && minutes > 0;
  const [remaining, setRemaining] = useState<number | null>(null);
  const expired = useRef(false);
  // Held in a ref so a re-rendering parent cannot restart the countdown.
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    if (!limited || startedAt === null || minutes === null) {
      setRemaining(null);
      return;
    }

    expired.current = false;
    const total = minutes * 60;

    const tick = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const left = Math.max(0, total - elapsed);
      setRemaining(left);

      if (left === 0 && !expired.current) {
        expired.current = true;
        expire.current();
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [limited, minutes, startedAt]);

  return {
    remainingSeconds: remaining,
    warning: remaining !== null && remaining > 0 && remaining <= WARNING_SECONDS,
    expired: remaining === 0,
  };
}
