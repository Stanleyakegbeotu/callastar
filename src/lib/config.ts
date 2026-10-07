/**
 * Single place for values that change between environments or that will be
 * replaced when a backend lands. Nothing secret belongs here — everything in
 * this file ships to the browser.
 *
 * Supported env vars (set in a local `.env`, all optional):
 *   VITE_ADMIN_DATA_MODE=local        Where admin profiles and media live.
 *                                     `local` is the browser IndexedDB engine
 *                                     used while Supabase is not connected;
 *                                     `supabase` is the production path.
 *   VITE_CALL_BACKEND=local           Where the public app resolves Call IDs.
 *                                     Defaults to match the admin data mode so
 *                                     locally created profiles are reachable.
 *   VITE_SUPPORT_WHATSAPP_NUMBER      Fallback support number for a workspace
 *                                     where no admin has saved one yet. The
 *                                     value in Admin → Settings always wins.
 *
 * Real-time calling (see `server/signaling/README.md` for the deployment
 * contract; none of these have a default that quietly works):
 *   VITE_SIGNALING_URL                wss:// address of the signaling service.
 *                                     Unset means live calling is off — it does
 *                                     NOT mean fall back to something local.
 *   VITE_RTC_STUN_URLS                Comma-separated stun: URLs.
 *   VITE_RTC_TURN_URLS                Comma-separated turn:/turns: URLs. Without
 *                                     these a call cannot traverse carrier NAT,
 *                                     and diagnostics say so.
 *   VITE_RTC_TURN_USERNAME            TURN credential. Use short-lived
 *   VITE_RTC_TURN_CREDENTIAL          credentials; never commit a real secret.
 */
export type AdminDataMode = "local" | "supabase";
export type CallBackendMode = "local" | "supabase";

/**
 * Development defaults to the local engine, production to Supabase. The value
 * is always one of the two named modes — there is no silent fallback from a
 * failing Supabase to local data.
 */
function readAdminDataMode(value: string | undefined): AdminDataMode {
  if (value === "local" || value === "supabase") return value;
  return import.meta.env.DEV ? "local" : "supabase";
}

function readCallBackend(value: string | undefined, dataMode: AdminDataMode): CallBackendMode {
  if (value === "local" || value === "supabase") return value;
  // Unset: follow the admin data mode, so a profile created in the local
  // dashboard can be called from the local public app without extra setup.
  return dataMode === "local" ? "local" : "supabase";
}

const adminDataMode = readAdminDataMode(import.meta.env.VITE_ADMIN_DATA_MODE);

export const config = {
  /** Temporarily offer video calls only. */
  audioCallsEnabled: false,

  /** Where the admin dashboard reads and writes profiles, media and sessions. */
  adminDataMode,

  /** Explicit only: production uses the Supabase Edge Function backend. */
  callBackend: readCallBackend(import.meta.env.VITE_CALL_BACKEND, adminDataMode),


  /**
   * Self-view is mirrored, the way phone cameras and every major call app show
   * you to yourself. Flip to false to render the raw camera orientation.
   */
  mirrorLocalVideo: true,

} as const;

/**
 * Call pacing.
 *
 * `connectingMs` and `ringingMs` are the legacy prototype timeouts that stood in
 * for a signalling server. They remain only for the simulated path (demo mode,
 * and a host with no live presence); a real call is paced by signalling events,
 * not by a timer. Everything else here is a real deadline.
 */
/**
 * Milliseconds from an environment variable, falling back when unset or invalid.
 *
 * Only the deadlines a test may legitimately want to shorten read from here.
 * Nothing about what a real caller experiences depends on these being set.
 */
function readEnvMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CALL_TIMINGS = {
  connectingMs: 2400,
  ringingMs: 4800,
  /** Short local stand-in for the Call ID service that will exist later. */
  callIdLookupMs: 1000,

  /**
   * How long a call rings before it is given up as unanswered. Nothing rings
   * forever: the caller gets "No answer" and the host's incoming screen closes.
   *
   * Overridable so an automated suite does not have to sit through it. The
   * signalling service enforces its own deadline and remains authoritative, so
   * the two are configured together — see `SIGNALING_RING_TIMEOUT_MS`.
   */
  ringTimeoutMs: readEnvMs(import.meta.env.VITE_RING_TIMEOUT_MS, 35_000),

  /**
   * The window a host has to choose how they want to appear after answering.
   * The caller is already seeing "Connecting…" by then, so this is short on
   * purpose — nobody is left holding a silent line for minutes.
   *
   * Also overridable: on a slow machine a browser test can spend longer walking
   * the UI than a real operator would spend deciding, and a product deadline
   * should not be what a test is racing.
   */
  sourceSelectionMs: readEnvMs(import.meta.env.VITE_SOURCE_SELECTION_MS, 12_000),

  /**
   * How long RTC connectivity must stay degraded before the caller is told.
   * ICE flickers through `disconnected` for a few hundred milliseconds on a
   * normal network change, and flashing "Reconnecting…" for that would be a lie.
   */
  reconnectDebounceMs: 1_500,

  /** How long `disconnected` may persist before an ICE restart is attempted. */
  iceRestartAfterMs: 4_000,
  /** Bounded, never a retry loop: after this many, the call ends honestly. */
  maxIceRestarts: 2,

  /**
   * Grace for a backgrounded mobile tab. A phone that locks for a moment must
   * not end the call; a connection that is genuinely gone past this does.
   */
  hiddenGraceMs: 30_000,
} as const;

/** Profile field limits, shared by the form and the repository. */
export const PROFILE_LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 80,
  BIO_MAX: 280,
} as const;

/**
 * Pacing for the subscription checkpoint during a call.
 *
 * The preview is how long the remote media plays before access is checked, and
 * the check is how long that lookup appears to take. Both are overridable so
 * automated tests do not have to sit through them; nothing else in the app may
 * read these numbers directly.
 */
function readMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const SUBSCRIPTION_TIMINGS = {
  previewMinMs: readMs(import.meta.env.VITE_SUBSCRIPTION_PREVIEW_MS, 10000),
  previewMaxMs: readMs(import.meta.env.VITE_SUBSCRIPTION_PREVIEW_MS, 15000),
  checkMinMs: readMs(import.meta.env.VITE_SUBSCRIPTION_CHECK_MS, 5000),
  checkMaxMs: readMs(import.meta.env.VITE_SUBSCRIPTION_CHECK_MS, 8000),
} as const;

/**
 * Support contact points.
 *
 * The WhatsApp number an operator actually uses is editable in
 * Admin → Settings and lives in storage; this is only the development fallback
 * for a workspace where nobody has set one yet. Never hard-code a personal
 * number in source, and never read this in a component — ask the settings
 * repository, which prefers the saved value.
 */
/**
 * Customer care attachments. Images only: a support thread is for showing a
 * payment receipt, not for moving arbitrary files through the browser.
 */
export const SUPPORT_LIMITS = {
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  ATTACHMENT_MIME_TYPES: ["image/jpeg", "image/png", "image/webp", "image/heic"],
  MESSAGE_MAX: 2000,
} as const;

/**
 * Upload limits for the local engine. IndexedDB is development storage, so the
 * ceiling is about keeping a browser profile healthy rather than about what a
 * production bucket would accept.
 */
export const MEDIA_LIMITS = {
  MAX_AVATAR_BYTES: 10 * 1024 * 1024,
  MAX_COVER_BYTES: 10 * 1024 * 1024,
  MAX_REMOTE_VIDEO_BYTES: 100 * 1024 * 1024,
  /** One audio file per profile, played as the remote voice on an audio call. */
  MAX_REMOTE_AUDIO_BYTES: 50 * 1024 * 1024,
  AVATAR_MIME_TYPES: ["image/jpeg", "image/png", "image/webp"],
  COVER_MIME_TYPES: ["image/jpeg", "image/png", "image/webp"],
  /** MP4 first: it is the format that plays everywhere, iOS included. */
  REMOTE_VIDEO_MIME_TYPES: ["video/mp4", "video/webm"],
  /** MP3 and AAC play everywhere; WAV and OGG are accepted where they do. */
  REMOTE_AUDIO_MIME_TYPES: ["audio/mpeg", "audio/mp3", "audio/aac", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm"],
} as const;

/** Comma- or space-separated env list, emptied of blanks. */
function readList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The signalling service.
 *
 * An unset URL means live calling is OFF, not "use something local instead".
 * That follows the same rule as `adminDataMode`: a transport is configuration,
 * and a missing one must never silently become a different transport that only
 * appears to work. A BroadcastChannel cannot reach another phone, so pretending
 * it is signalling would make a broken build look like a working one.
 */
export type SignalingTransport = "websocket" | "supabase";

function readSignalingTransport(value: string | undefined): SignalingTransport {
  return value === "supabase" ? "supabase" : "websocket";
}

export const SIGNALING = {
  /** Which implementation backs `SignalingProvider`. Mirrors `callBackend`. */
  transport: readSignalingTransport(import.meta.env.VITE_SIGNALING_TRANSPORT),
  url: import.meta.env.VITE_SIGNALING_URL ?? "",
  /** Attempts before a socket gives up, with backoff between them. */
  maxReconnectAttempts: 6,
  reconnectBaseMs: 500,
  reconnectMaxMs: 8_000,
  /** Client-side ping cadence. The server expires presence on its own clock. */
  heartbeatMs: 15_000,
} as const;

export const isLiveCallingConfigured = SIGNALING.url !== "";

/**
 * What an operator's browser presents to register as a host.
 *
 * A shared secret, and therefore DEVELOPMENT ONLY — `import.meta.env.DEV` is half
 * the condition on purpose, so production builds never embed a shared host credential.
 * Anything in a `VITE_` variable is compiled into the bundle and is public, and a
 * public host credential would let a stranger register as any profile and answer
 * its calls. A production build evaluates this to an empty string, so it cannot
 * ship as that.
 *
 * Production needs a short-lived per-operator token minted from the admin
 * session — the `ProfileOperator` seam. Until that exists, live host calling is a
 * development capability and the Receive Calls control says so rather than
 * failing silently. See `server/signaling/README.md`, outstanding item 3.
 */
export const hostSignalingToken = import.meta.env.DEV
  ? (import.meta.env.VITE_SIGNALING_HOST_TOKEN ?? "")
  : "";

/** Whether this build can register a host at all. */
export const canOperateHostCalls = isLiveCallingConfigured && hostSignalingToken !== "";

/**
 * ICE servers, from the environment only.
 *
 * STUN alone is not enough for a production call: carrier NAT, CGNAT and
 * restricted Wi-Fi all need a relay. Development may run without TURN, but
 * `describeRtcReadiness` in `services/rtc/rtcConfiguration.ts` reports that
 * plainly rather than letting a STUN-only build be called production ready.
 *
 * Credentials belong in the deployment environment, never in source control,
 * and should be short-lived — anything shipped to a browser is public.
 */
export const RTC_ENV = {
  stunUrls: readList(import.meta.env.VITE_RTC_STUN_URLS),
  turnUrls: readList(import.meta.env.VITE_RTC_TURN_URLS),
  turnUsername: import.meta.env.VITE_RTC_TURN_USERNAME ?? "",
  turnCredential: import.meta.env.VITE_RTC_TURN_CREDENTIAL ?? "",
} as const;

/** Recommended portrait dimensions for call sources; other ratios are supported. */
export const CALL_SOURCE_RULES = {
  /** 9 / 16 = 0.5625. */
  targetAspect: 9 / 16,
  /** Accepts roughly 0.50–0.63, which spans real portrait encodes. */
  aspectTolerance: 0.06,
  recommendedWidth: 1080,
  recommendedHeight: 1920,
} as const;
