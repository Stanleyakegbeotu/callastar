/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEMO_VIDEO?: string;
  readonly VITE_ADMIN_DATA_MODE?: string;
  readonly VITE_ADMIN_AUTH_MODE?: string;
  readonly VITE_CALL_BACKEND?: string;
  readonly VITE_SUBSCRIPTION_PREVIEW_MS?: string;
  readonly VITE_SUBSCRIPTION_CHECK_MS?: string;
  readonly VITE_SUBSCRIPTION_CONFIRMED_MS?: string;
  readonly VITE_RING_TIMEOUT_MS?: string;
  readonly VITE_SOURCE_SELECTION_MS?: string;
  readonly VITE_SUPPORT_WHATSAPP_NUMBER?: string;
  readonly VITE_ENABLE_DEV_ADMIN_SHORTCUT?: string;

  /** Real-time calling. See `server/signaling/README.md`. */
  readonly VITE_SIGNALING_TRANSPORT?: string;
  readonly VITE_SIGNALING_URL?: string;
  /** Development only — see `hostSignalingToken` in `lib/config.ts`. */
  readonly VITE_SIGNALING_HOST_TOKEN?: string;
  readonly VITE_RTC_STUN_URLS?: string;
  readonly VITE_RTC_TURN_URLS?: string;
  readonly VITE_RTC_TURN_USERNAME?: string;
  readonly VITE_RTC_TURN_CREDENTIAL?: string;
}
