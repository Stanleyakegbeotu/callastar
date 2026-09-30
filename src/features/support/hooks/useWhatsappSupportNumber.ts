import { useEffect, useState } from "react";

import { SUPPORT } from "@/lib/config";
import { LOCAL_EVENT_CHANNEL } from "@/lib/localEvents";
import { normalizePhoneDigits } from "@/lib/phone";
import { logDiagnostic } from "@/lib/utils";
import { settingsRepository } from "@/services/settings/repository";

export interface WhatsappSupportNumber {
  /** Digits only, ready for a `wa.me` link, or null when none is usable. */
  number: string | null;
  loading: boolean;
}

/**
 * The WhatsApp destination the product should use right now.
 *
 * What an admin saved in Settings wins. The environment variable is only a
 * fallback for a fresh workspace where nobody has saved anything yet — a
 * component must never reach for it directly, because then changing the number
 * in the dashboard would not change where customers are sent.
 *
 * A change made in the dashboard reaches an open payment screen through the same
 * broadcast channel the rest of the app uses, so this does not poll.
 */
export function useWhatsappSupportNumber(): WhatsappSupportNumber {
  const [number, setNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const read = () => {
      void settingsRepository
        .getAppSettings()
        .then((settings) => {
          if (cancelled) return;
          const saved = settings.whatsappSupportNumber;
          const resolved = saved && saved.length > 0 ? saved : normalizePhoneDigits(SUPPORT.fallbackWhatsappNumber);
          setNumber(resolved.length > 0 ? resolved : null);
        })
        .catch((error: unknown) => {
          logDiagnostic("support-number", error);
          if (cancelled) return;
          // Storage being unavailable must not silently hide a configured
          // fallback, so the env value still gets its chance.
          const fallback = normalizePhoneDigits(SUPPORT.fallbackWhatsappNumber);
          setNumber(fallback.length > 0 ? fallback : null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    read();

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(LOCAL_EVENT_CHANNEL);
      channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "settings-updated") read();
      };
    }

    return () => {
      cancelled = true;
      channel?.close();
    };
  }, []);

  return { number, loading };
}
