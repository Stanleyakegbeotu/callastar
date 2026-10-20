import { hostSignalingToken, isLiveCallingConfigured } from "@/lib/config";
import { supabase } from "@/lib/supabase/client";

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
 * Production — short-lived credentials signed by the authenticated Supabase
 * Edge Function and validated by the signaling service.
 *
 * The Edge Function verifies the Admin session and active profile, then signs a
 * five-minute credential scoped to both that profile and its current Call ID.
 * The signaling service verifies the signature, expiry and scope at hello.
 * Current Admin permissions cover every active profile; per-operator profile
 * assignment can replace that policy if the product needs it later.
 */
export const serverIssuedHostCredentialProvider: HostSessionCredentialProvider = {
  get available() { return isLiveCallingConfigured && supabase !== null; },
  get unavailableReason() {
    if (!isLiveCallingConfigured) return "Live calling is not configured for this deployment.";
    if (!supabase) return "Live calling requires the authenticated CallaStar Admin service.";
    return null;
  },

  async getCredential(profileId) {
    if (!supabase) return { ok: false, reason: "unavailable", message: this.unavailableReason ?? "Live calling is unavailable." };
    const { data, error } = await supabase.functions.invoke("issue-host-credential", { body: { profileId } });
    if (error || typeof data?.token !== "string" || typeof data?.expiresAt !== "number") {
      const status = error && "context" in error ? String((error as { context?: { status?: number } }).context?.status ?? "") : "";
      return status === "401" || status === "403"
        ? { ok: false, reason: "unauthorized", message: "Your Admin session cannot receive calls for this profile." }
        : { ok: false, reason: "unavailable", message: "Could not obtain a secure Receive Calls credential." };
    }
    return { ok: true, credential: { token: data.token, expiresAt: data.expiresAt } };
  },
};

/**
 * Select the development shared secret only in Vite development builds. A
 * production build always uses the server-issued credential path.
 */
export const hostCredentialProvider: HostSessionCredentialProvider = import.meta.env.DEV
  ? developmentHostCredentialProvider
  : serverIssuedHostCredentialProvider;
