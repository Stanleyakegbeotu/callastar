import { STORE_PREVIEW_ACCESS, runTransaction } from "@/services/admin/indexeddb";
import { config, type AdminDataMode } from "@/lib/config";
import { logDiagnostic } from "@/lib/utils";

/**
 * What this browser has already used.
 *
 * The problem: someone reaches "subscription required", closes the tab, comes
 * back and dials the same host again. Without a memory they would get another
 * free preview every time.
 *
 * The memory is deliberately ordinary first-party storage — the same IndexedDB
 * the rest of the app uses, keyed by profile. There is NO device
 * fingerprinting here: no canvas, no audio, no font probing, no hardware
 * identifiers, nothing that would follow somebody to another site. It knows
 * one thing, about this browser only: "this profile's preview has been used".
 *
 * Which means clearing site data clears it. That is an accepted limitation of a
 * local prototype, not a hole to be plugged with fingerprinting; a server-side
 * record becomes authoritative when Supabase lands.
 */
export type PreviewStatus = "available" | "subscription_required";

export interface PreviewAccessRecord {
  profileId: string;
  status: PreviewStatus;
  firstPreviewAt: string;
  /** Set at the exact moment the checkpoint decided a subscription was needed. */
  subscriptionRequiredAt: string | null;
  updatedAt: string;
}

export interface PreviewAccessRepository {
  readonly mode: AdminDataMode;
  getPreviewAccess(profileId: string): Promise<PreviewAccessRecord | null>;
  /** Called at one point only: when the access check returns "required". */
  markSubscriptionRequired(profileId: string): Promise<PreviewAccessRecord>;
  /** Development tooling only; nothing in the product calls this. */
  resetPreviewAccess(profileId: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const localPreviewAccessRepository: PreviewAccessRepository = {
  mode: "local",

  async getPreviewAccess(profileId) {
    if (!profileId) return null;
    const record = await runTransaction([STORE_PREVIEW_ACCESS], "readonly", (scope) =>
      scope.get<PreviewAccessRecord>(STORE_PREVIEW_ACCESS, profileId),
    );
    return record ?? null;
  },

  async markSubscriptionRequired(profileId) {
    return runTransaction([STORE_PREVIEW_ACCESS], "readwrite", async (scope) => {
      const existing = await scope.get<PreviewAccessRecord>(STORE_PREVIEW_ACCESS, profileId);
      const timestamp = nowIso();

      const next: PreviewAccessRecord = {
        profileId,
        status: "subscription_required",
        firstPreviewAt: existing?.firstPreviewAt ?? timestamp,
        // Written once: the first time the preview was actually spent.
        subscriptionRequiredAt: existing?.subscriptionRequiredAt ?? timestamp,
        updatedAt: timestamp,
      };

      await scope.put(STORE_PREVIEW_ACCESS, next);
      return next;
    });
  },

  async resetPreviewAccess(profileId) {
    await runTransaction([STORE_PREVIEW_ACCESS], "readwrite", (scope) =>
      scope.remove(STORE_PREVIEW_ACCESS, profileId),
    );
  },
};

/**
 * This memory is about a browser, so it has no meaningful Supabase form: a
 * server cannot know what a browser remembers. When access moves server-side it
 * will be enforced against the customer instead, which is a different and
 * better rule. Until then this stays local in every mode.
 */
export const previewAccessRepository: PreviewAccessRepository = localPreviewAccessRepository;

/**
 * Whether this browser has already spent its preview for a host.
 *
 * Never throws: storage being unavailable must not stop somebody making a call,
 * so an unreadable record is treated as "no record" and the call goes ahead.
 */
export async function hasUsedPreview(profileId: string): Promise<boolean> {
  if (config.adminDataMode !== "local") return false;
  try {
    const record = await previewAccessRepository.getPreviewAccess(profileId);
    return record?.status === "subscription_required";
  } catch (error) {
    logDiagnostic("preview-access", error);
    return false;
  }
}
