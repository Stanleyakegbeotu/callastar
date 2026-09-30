import {
  STORE_GRANTS,
  STORE_PLANS,
  STORE_REQUESTS,
  runTransaction,
} from "@/services/admin/indexeddb";

import { DEFAULT_PLANS } from "./defaultPlans";
import type { SubscriptionRepository } from "./repository";
import type {
  CallAccessGrant,
  CreateSubscriptionRequestInput,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionPlanPatch,
  SubscriptionRequest,
  SubscriptionRequestStatus,
} from "./types";

/**
 * Subscriptions against the local development engine.
 *
 * Two rules matter here. Plan prices are global and editable, so every request
 * snapshots the amount and plan name it was created with — editing a price
 * later must never rewrite what somebody was asked to pay. And confirming a
 * request is idempotent: pressing Confirm twice grants access once.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short code a person can read out to support. Not a secret. */
function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const body = Array.from(bytes, (byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join("");
  return `CS-REQ-${body}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Which session spent a grant.
 *
 * Grants written before grants could be claimed have no such field; they were
 * issued for one session and only ever used by it, so that is what they report.
 */
function consumedBy(grant: CallAccessGrant): string | null {
  return grant.consumedBySessionId === undefined ? grant.sessionId : grant.consumedBySessionId;
}

/** Order the plans are always presented in, cheapest first. */
const PLAN_ORDER: SubscriptionPlanId[] = ["regular", "premium", "gold"];

function byPlanOrder(a: SubscriptionPlan, b: SubscriptionPlan): number {
  return PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id);
}

export const localSubscriptionRepository: SubscriptionRepository = {
  mode: "local",

  /**
   * Seeds the three default plans the first time only. An admin who renames a
   * plan or changes a price must not find it reset on the next page load.
   */
  async listPlans() {
    const plans = await runTransaction([STORE_PLANS], "readwrite", async (scope) => {
      const existing = await scope.getAll<SubscriptionPlan>(STORE_PLANS);
      if (existing.length > 0) return existing;

      const timestamp = nowIso();
      const seeded = DEFAULT_PLANS.map((plan) => ({ ...plan, createdAt: timestamp, updatedAt: timestamp }));
      for (const plan of seeded) await scope.put(STORE_PLANS, plan);
      return seeded;
    });

    return plans.sort(byPlanOrder);
  },

  async getPlan(id) {
    const plan = await runTransaction([STORE_PLANS], "readonly", (scope) =>
      scope.get<SubscriptionPlan>(STORE_PLANS, id),
    );
    return plan ?? null;
  },

  async updatePlan(id, patch: SubscriptionPlanPatch) {
    return runTransaction([STORE_PLANS], "readwrite", async (scope) => {
      const existing = await scope.get<SubscriptionPlan>(STORE_PLANS, id);
      if (!existing) throw new Error("That plan no longer exists.");

      // The id is the contract with historical requests; only presentation and
      // pricing may change.
      const next: SubscriptionPlan = { ...existing, ...patch, id: existing.id, updatedAt: nowIso() };

      if (patch.isMostPopular) {
        // At most one plan carries the badge.
        const all = await scope.getAll<SubscriptionPlan>(STORE_PLANS);
        for (const plan of all) {
          if (plan.id !== id && plan.isMostPopular) {
            await scope.put(STORE_PLANS, { ...plan, isMostPopular: false, updatedAt: nowIso() });
          }
        }
      }

      await scope.put(STORE_PLANS, next);
      return next;
    });
  },

  async createRequest(input: CreateSubscriptionRequestInput) {
    const timestamp = nowIso();
    const request: SubscriptionRequest = {
      id: newId(),
      reference: newReference(),
      sessionId: input.sessionId,
      profileId: input.profileId,
      profileName: input.profileName,
      customerEmail: input.customerEmail.trim(),
      customerEmailNormalized: normalizeEmail(input.customerEmail),
      planId: input.planId,
      planNameSnapshot: input.planNameSnapshot,
      amountUsdCents: input.amountUsdCents,
      channel: input.channel,
      status: "awaiting_payment",
      conversationId: null,
      proofMessageId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedAt: null,
    };

    await runTransaction([STORE_REQUESTS], "readwrite", (scope) => scope.put(STORE_REQUESTS, request));
    return request;
  },

  async getRequest(id) {
    const request = await runTransaction([STORE_REQUESTS], "readonly", (scope) =>
      scope.get<SubscriptionRequest>(STORE_REQUESTS, id),
    );
    return request ?? null;
  },

  async listRequests(filters) {
    const requests = await runTransaction([STORE_REQUESTS], "readonly", (scope) =>
      filters?.status && filters.status !== "all"
        ? scope.getAllFromIndex<SubscriptionRequest>(STORE_REQUESTS, "by_status", filters.status)
        : scope.getAll<SubscriptionRequest>(STORE_REQUESTS),
    );

    const matched = requests.filter((request) => {
      if (filters?.channel && filters.channel !== "all" && request.channel !== filters.channel) return false;
      return true;
    });

    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filters?.limit ? matched.slice(0, filters.limit) : matched;
  },

  async listSessionRequests(sessionId) {
    const requests = await runTransaction([STORE_REQUESTS], "readonly", (scope) =>
      scope.getAllFromIndex<SubscriptionRequest>(STORE_REQUESTS, "by_session", sessionId),
    );
    return requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async updateRequest(id, patch) {
    return runTransaction([STORE_REQUESTS], "readwrite", async (scope) => {
      const existing = await scope.get<SubscriptionRequest>(STORE_REQUESTS, id);
      if (!existing) return null;

      // A confirmed request is the end of the line; nothing reopens it.
      if (existing.status === "confirmed" && patch.status && patch.status !== "confirmed") return existing;

      const next: SubscriptionRequest = { ...existing, ...patch, id: existing.id, updatedAt: nowIso() };
      await scope.put(STORE_REQUESTS, next);
      return next;
    });
  },

  /**
   * Confirm a payment and grant access to the session. Safe to call twice: the
   * second call finds the grant already there and returns it unchanged.
   */
  async confirmRequest(id) {
    return runTransaction([STORE_REQUESTS, STORE_GRANTS], "readwrite", async (scope) => {
      const request = await scope.get<SubscriptionRequest>(STORE_REQUESTS, id);
      if (!request) throw new Error("That subscription request no longer exists.");

      const existingGrants = await scope.getAllFromIndex<CallAccessGrant>(STORE_GRANTS, "by_request", request.id);
      const activeGrant = existingGrants.find((grant) => grant.status === "active");

      const timestamp = nowIso();
      const confirmed: SubscriptionRequest = {
        ...request,
        status: "confirmed",
        confirmedAt: request.confirmedAt ?? timestamp,
        updatedAt: timestamp,
      };
      await scope.put(STORE_REQUESTS, confirmed);

      if (activeGrant) return { request: confirmed, grant: activeGrant };

      const grant: CallAccessGrant = {
        id: newId(),
        sessionId: request.sessionId,
        requestId: request.id,
        planId: request.planId,
        customerEmailNormalized: request.customerEmailNormalized,
        // Unclaimed: the call that asked for this has already ended, so the
        // next call the customer starts is the one that spends it.
        consumedBySessionId: null,
        consumedAt: null,
        status: "active",
        grantedAt: timestamp,
      };
      await scope.put(STORE_GRANTS, grant);
      return { request: confirmed, grant };
    });
  },

  async getSessionAccess(sessionId) {
    const grants = await runTransaction([STORE_GRANTS], "readonly", (scope) =>
      scope.getAll<CallAccessGrant>(STORE_GRANTS),
    );
    return grants.find((grant) => grant.status === "active" && consumedBy(grant) === sessionId) ?? null;
  },

  /**
   * What a live call actually asks. Either this session already holds a grant,
   * or an unclaimed one belonging to this customer is spent on it now.
   *
   * Idempotent, because the call checkpoint may ask more than once: a session
   * that already claimed a grant gets the same one back rather than consuming a
   * second.
   */
  async claimAccess({ sessionId, customerEmail }) {
    const email = normalizeEmail(customerEmail);

    return runTransaction([STORE_GRANTS], "readwrite", async (scope) => {
      const all = await scope.getAll<CallAccessGrant>(STORE_GRANTS);
      const active = all.filter((grant) => grant.status === "active");

      const alreadyMine = active.find((grant) => consumedBy(grant) === sessionId);
      if (alreadyMine) return alreadyMine;

      if (email.length === 0) return null;

      // Oldest first, so a customer with two grants spends the one they have
      // been holding longest.
      const unclaimed = active
        .filter((grant) => consumedBy(grant) === null && grant.customerEmailNormalized === email)
        .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));

      const grant = unclaimed[0];
      if (!grant) return null;

      const claimed: CallAccessGrant = {
        ...grant,
        consumedBySessionId: sessionId,
        consumedAt: nowIso(),
      };
      await scope.put(STORE_GRANTS, claimed);
      return claimed;
    });
  },

  async listGrants() {
    const grants = await runTransaction([STORE_GRANTS], "readonly", (scope) =>
      scope.getAll<CallAccessGrant>(STORE_GRANTS),
    );
    return grants.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
  },

  async countRequestsByStatus(status: SubscriptionRequestStatus) {
    const requests = await runTransaction([STORE_REQUESTS], "readonly", (scope) =>
      scope.getAllFromIndex<SubscriptionRequest>(STORE_REQUESTS, "by_status", status),
    );
    return requests.length;
  },
};
