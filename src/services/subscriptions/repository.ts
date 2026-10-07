import { config, type AdminDataMode } from "@/lib/config";

import { localSubscriptionRepository } from "./localSubscriptionRepository";
import { supabaseSubscriptionRepository } from "./supabaseSubscriptionRepository";
import type {
  CallAccessGrant,
  ClaimAccessInput,
  CreateSubscriptionRequestInput,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionPlanPatch,
  SubscriptionRequest,
  SubscriptionRequestFilters,
  SubscriptionRequestStatus,
} from "./types";

/**
 * The seam for plans, payment requests and call access. Screens talk to this
 * interface only, so moving to Supabase is a change of implementation.
 */
export interface SubscriptionRepository {
  readonly mode: AdminDataMode;

  listPlans(): Promise<SubscriptionPlan[]>;
  getPlan(id: SubscriptionPlanId): Promise<SubscriptionPlan | null>;
  updatePlan(id: SubscriptionPlanId, patch: SubscriptionPlanPatch): Promise<SubscriptionPlan>;

  createRequest(input: CreateSubscriptionRequestInput): Promise<SubscriptionRequest>;
  getRequest(id: string): Promise<SubscriptionRequest | null>;
  listRequests(filters?: SubscriptionRequestFilters): Promise<SubscriptionRequest[]>;
  listSessionRequests(sessionId: string): Promise<SubscriptionRequest[]>;
  updateRequest(id: string, patch: Partial<SubscriptionRequest>): Promise<SubscriptionRequest | null>;
  /** Cancel a customer's still-open request before switching packages. */
  cancelRequest(id: string): Promise<SubscriptionRequest | null>;
  /** Idempotent: confirming twice grants access once. */
  confirmRequest(id: string): Promise<{ request: SubscriptionRequest; grant: CallAccessGrant }>;

  /** Read-only: the grant this session already holds, if any. */
  getSessionAccess(sessionId: string): Promise<CallAccessGrant | null>;
  /**
   * What a live call asks at its checkpoint. Spends an unclaimed grant
   * belonging to this customer on this session, or returns null when they have
   * none. Idempotent for a session that already claimed one.
   */
  claimAccess(input: ClaimAccessInput): Promise<CallAccessGrant | null>;
  listGrants(): Promise<CallAccessGrant[]>;
  countRequestsByStatus(status: SubscriptionRequestStatus): Promise<number>;
}

export function getSubscriptionRepository(): SubscriptionRepository {
  return config.adminDataMode === "local" ? localSubscriptionRepository : supabaseSubscriptionRepository;
}

export const subscriptionRepository = getSubscriptionRepository();
