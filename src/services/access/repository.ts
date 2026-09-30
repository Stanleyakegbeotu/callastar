import { config, type AdminDataMode } from "@/lib/config";

import { localAccessRepository } from "./localAccessRepository";
import { supabaseAccessRepository } from "./supabaseAccessRepository";
import type { GenerateAccessIdInput, GeneratedAccessId, SubscriptionAccessId } from "./types";

/**
 * The seam for Subscription Access IDs.
 *
 * `findByCode` takes plaintext and returns a record; it never returns the code,
 * and no implementation may store one. When this moves to Supabase the lookup
 * becomes an Edge Function so the hash comparison happens server-side — the
 * interface does not change.
 */
export interface AccessRepository {
  readonly mode: AdminDataMode;

  /** Issues a credential. The plaintext is returned once and never again. */
  generateAccessId(input: GenerateAccessIdInput): Promise<GeneratedAccessId>;
  findByCode(code: string): Promise<SubscriptionAccessId | null>;
  listProfileAccessIds(profileId: string): Promise<SubscriptionAccessId[]>;
  revokeAccessId(id: string): Promise<SubscriptionAccessId | null>;
  countActiveForProfile(profileId: string): Promise<number>;
}

export function getAccessRepository(): AccessRepository {
  return config.adminDataMode === "local" ? localAccessRepository : supabaseAccessRepository;
}

export const accessRepository = getAccessRepository();
