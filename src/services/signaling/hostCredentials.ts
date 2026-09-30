import { hostSignalingToken, isLiveCallingConfigured } from "@/lib/config";

/**
 * What an operator's browser presents to register as a host.
 *
 * A seam, because the development answer and the production answer are different
 * in kind, not merely in value. Development holds a shared secret in the bundle;
 * production must fetch a short-lived token scoped to the profiles that operator
 * is actually allowed to act for.
 *
 * Making this an interface now means the day that endpoint exists is a new
 * implementation of this file, and not a change to `HostCallProvider`.
 */

export interface HostCredential {
  /** Presented in the signalling `hello`. */
  token: string;
  /** Epoch ms, or null when the credential does not expire (development only). */
  expiresAt: number | null;
}

export type HostCredentialResult =
  | { ok: true; credential: HostCredential }
  /**
   * Distinguished on purpose. `unavailable` is a build that cannot do this at
   * all; `unauthorized` is an operator who may not act for that profile. The
   * first is a deployment note, the second is a permission decision.
   */
  | { ok: false; reason: "unavailable" | "unauthorized"; message: string };

export interface HostSessionCredentialProvider {
  /** Whether this build can register a host at all. */
  readonly available: boolean;
  /** Operator-facing explanation when it cannot. */
  readonly unavailableReason: string | null;
  /** A credential for operating one profile. */
  getCredential(profileId: string): Promise<HostCredentialResult>;
}

/**
 * Development: the shared secret from the environment.
 *
 * `hostSignalingToken` is gated on `import.meta.env.DEV`, so a production build
 * evaluates it to an empty string and this provider reports unavailable rather
 * than shipping a credential. That matters: anything in a `VITE_` variable is
 * compiled into the bundle and is public, and a public host credential would let
 * a stranger register as any profile and answer its calls.
 *
 * It is also not scoped — it authorises any profile — which is precisely why it
 * must never leave development.
 */
export const developmentHostCredentialProvider: HostSessionCredentialProvider = {
  get available() {
    return isLiveCallingConfigured && hostSignalingToken !== "";
  },

  get unavailableReason() {
    if (!isLiveCallingConfigured) return "Live calling is not configured for this deployment.";
    if (hostSignalingToken === "") {
      return "Live calling needs an operator credential, which is only available in a development build.";
    }
    return null;
  },

  async getCredential(_profileId: string) {
    if (!this.available) {
      return { ok: false, reason: "unavailable", message: this.unavailableReason ?? "Live calling is unavailable." };
    }
    // No expiry, and no scope. Both are why this is development-only.
    return { ok: true, credential: { token: hostSignalingToken, expiresAt: null } };
  },
};

/**
 * Production — deliberately unimplemented.
 *
 * What the backend must do before this can exist, and what it must verify on
 * every request:
 *
 *   1. the caller is an AUTHENTICATED operator, from the admin session and not
 *      from anything the browser supplied about itself
 *   2. that operator is permitted to control the requested `profileId` — the
 *      `ProfileOperator` relationship, so "admin" is not hard-wired as "host"
 *   3. the credential EXPIRES, in minutes rather than days, and the browser
 *      renews it rather than holding one indefinitely
 *   4. the credential is SCOPED to the permitted profile ids, and the signalling
 *      service enforces that scope on `hello` — a credential for one profile
 *      must not be able to register as another
 *   5. it can be REVOKED, so removing an operator takes effect without rotating
 *      a secret that every other operator shares
 *
 * The service side of this is `verifyHostToken` in `server/signaling/src/tokens.ts`,
 * which today compares one shared secret in constant time. Replacing it means
 * verifying a signed, scoped, expiring token and checking the claimed profile
 * against its scope.
 */
export const serverIssuedHostCredentialProvider: HostSessionCredentialProvider = {
  available: false,
  unavailableReason:
    "Server-issued operator credentials are not implemented yet. See server/signaling/README.md, outstanding item 3.",

  async getCredential() {
    return {
      ok: false,
      reason: "unavailable",
      message: "Server-issued operator credentials are not implemented yet.",
    };
  },
};

/**
 * The development provider, because it is the only one implemented.
 *
 * It reports `available: false` in a production build of its own accord, so this
 * choice cannot become a production credential by accident.
 */
export const hostCredentialProvider: HostSessionCredentialProvider = developmentHostCredentialProvider;
