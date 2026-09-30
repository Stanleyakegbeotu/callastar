import { STORE_ACCESS_IDS, runTransaction } from "@/services/admin/indexeddb";

import { accessIdLast4, generateAccessCode, hashAccessId, normalizeAccessId } from "./accessCode";
import type { AccessRepository } from "./repository";
import type { GenerateAccessIdInput, SubscriptionAccessId } from "./types";

/**
 * Subscription Access IDs against the local development engine.
 *
 * The hash is computed before any transaction opens: hashing is a Web Crypto
 * promise, not an IndexedDB one, and awaiting it inside a transaction would let
 * the transaction close underneath the write.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** How many times to retry if a generated code somehow already exists. */
const COLLISION_RETRIES = 5;

export const localAccessRepository: AccessRepository = {
  mode: "local",

  async generateAccessId(input: GenerateAccessIdInput) {
    for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
      const code = generateAccessCode();
      const codeHash = await hashAccessId(code);

      // 32^8 is about a thousand billion, so this effectively never repeats —
      // but a credential collision would silently hand one customer another's
      // access, so it is checked rather than assumed.
      const existing = await runTransaction([STORE_ACCESS_IDS], "readonly", (scope) =>
        scope.getAllFromIndex<SubscriptionAccessId>(STORE_ACCESS_IDS, "by_code_hash", codeHash),
      );
      if (existing.length > 0) continue;

      const record: SubscriptionAccessId = {
        id: newId(),
        profileId: input.profileId,
        planId: input.planId,
        codeHash,
        codeLast4: accessIdLast4(code),
        status: "active",
        subscriptionRequestId: input.subscriptionRequestId ?? null,
        customerEmailNormalized: input.customerEmail?.trim().toLowerCase() || null,
        issuedBy: input.issuedBy ?? "admin",
        createdAt: nowIso(),
        revokedAt: null,
        expiresAt: null,
      };

      await runTransaction([STORE_ACCESS_IDS], "readwrite", (scope) => scope.put(STORE_ACCESS_IDS, record));

      // The only time the plaintext exists. It is returned, shown once, and
      // never written anywhere.
      return { record, code };
    }

    throw new Error("Could not issue an access ID. Please try again.");
  },

  async findByCode(code: string) {
    const normalized = normalizeAccessId(code);
    if (normalized.length === 0) return null;

    const codeHash = await hashAccessId(normalized);
    const matches = await runTransaction([STORE_ACCESS_IDS], "readonly", (scope) =>
      scope.getAllFromIndex<SubscriptionAccessId>(STORE_ACCESS_IDS, "by_code_hash", codeHash),
    );
    return matches[0] ?? null;
  },

  async listProfileAccessIds(profileId: string) {
    const records = await runTransaction([STORE_ACCESS_IDS], "readonly", (scope) =>
      scope.getAllFromIndex<SubscriptionAccessId>(STORE_ACCESS_IDS, "by_profile", profileId),
    );
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async revokeAccessId(id: string) {
    return runTransaction([STORE_ACCESS_IDS], "readwrite", async (scope) => {
      const existing = await scope.get<SubscriptionAccessId>(STORE_ACCESS_IDS, id);
      if (!existing) return null;
      // History is kept: a revoked credential stays on the record so an
      // operator can see it was issued and when it stopped working.
      if (existing.status === "revoked") return existing;

      const next: SubscriptionAccessId = { ...existing, status: "revoked", revokedAt: nowIso() };
      await scope.put(STORE_ACCESS_IDS, next);
      return next;
    });
  },

  async countActiveForProfile(profileId: string) {
    const records = await runTransaction([STORE_ACCESS_IDS], "readonly", (scope) =>
      scope.getAllFromIndex<SubscriptionAccessId>(STORE_ACCESS_IDS, "by_profile", profileId),
    );
    return records.filter((record) => record.status === "active").length;
  },
};
