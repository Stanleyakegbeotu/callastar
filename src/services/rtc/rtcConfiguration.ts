import { RTC_ENV } from "@/lib/config";

/**
 * Where the ICE servers for a peer connection come from.
 *
 * A provider rather than a constant because the production answer is a
 * short-lived TURN credential fetched per call, not a value baked into a bundle.
 * Everything a browser receives is public, so a long-lived TURN secret in
 * `VITE_*` is a credential given away — the environment variables exist for
 * development and for deployments that front TURN with ephemeral credentials.
 */
export interface RtcConfigurationProvider {
  /** The configuration for one peer connection. */
  getConfiguration(): Promise<RTCConfiguration>;
}

/** What relaying is actually possible with the current configuration. */
export type RtcRelayReadiness =
  /** STUN and TURN both configured: the only combination fit for production. */
  | "turn-configured"
  /** STUN only. Works on permissive networks and fails on carrier NAT. */
  | "stun-only"
  /** Neither. Host candidates only, so effectively same-network. */
  | "no-ice-servers";

export interface RtcReadiness {
  relay: RtcRelayReadiness;
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  /**
   * Whether this configuration may be described as production ready. Only
   * `turn-configured` may, and nothing in the app is allowed to claim otherwise.
   */
  productionReady: boolean;
  /** One plain sentence for a diagnostics panel. Never shown to a caller. */
  summary: string;
}

function hasTurnCredentials(): boolean {
  return RTC_ENV.turnUrls.length > 0 && RTC_ENV.turnUsername !== "" && RTC_ENV.turnCredential !== "";
}

/**
 * States the truth about relay capability.
 *
 * Kept separate from `getConfiguration` so the answer can be surfaced in
 * diagnostics without a peer connection existing. A build with no TURN is a
 * legitimate development setup; calling it production ready is not.
 */
export function describeRtcReadiness(): RtcReadiness {
  const stunUrls = RTC_ENV.stunUrls;
  const turnUrls = hasTurnCredentials() ? RTC_ENV.turnUrls : [];

  if (turnUrls.length > 0) {
    return {
      relay: "turn-configured",
      stunUrls,
      turnUrls,
      productionReady: true,
      summary: "STUN and TURN configured. Calls can fall back to a relay when a direct path is blocked.",
    };
  }

  if (stunUrls.length > 0) {
    return {
      relay: "stun-only",
      stunUrls,
      turnUrls,
      productionReady: false,
      summary:
        "TURN not configured — STUN only. Calls will fail on carrier NAT, CGNAT and restricted Wi-Fi. Not production ready.",
    };
  }

  return {
    relay: "no-ice-servers",
    stunUrls,
    turnUrls,
    productionReady: false,
    summary:
      "TURN not configured, and no STUN either. Only devices on the same network can connect. Not production ready.",
  };
}

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [];

  if (RTC_ENV.stunUrls.length > 0) {
    servers.push({ urls: [...RTC_ENV.stunUrls] });
  }

  // All three parts or none: a TURN entry without credentials is rejected by the
  // browser and would take the whole configuration down with it.
  if (hasTurnCredentials()) {
    servers.push({
      urls: [...RTC_ENV.turnUrls],
      username: RTC_ENV.turnUsername,
      credential: RTC_ENV.turnCredential,
    });
  }

  return servers;
}

/**
 * Reads whatever the environment provides.
 *
 * `iceCandidatePoolSize` stays at 0 deliberately: pre-gathering opens candidate
 * sockets before anyone has answered, which on a phone means burning radio and
 * battery on calls that get declined.
 */
export const envRtcConfigurationProvider: RtcConfigurationProvider = {
  async getConfiguration() {
    return {
      iceServers: buildIceServers(),
      iceCandidatePoolSize: 0,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    };
  },
};

export const rtcConfigurationProvider: RtcConfigurationProvider = envRtcConfigurationProvider;
