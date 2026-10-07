import type { AccessRepository } from "./repository";

/**
 * Supabase is not connected in this phase.
 *
 * When it lands, resolving a credential must NOT become a client-side table
 * read: the row is found by hash, so a client able to query the table could
 * enumerate which hashes exist and which hosts they belong to. `findByCode`
 * becomes an Edge Function that takes the plaintext, hashes it server-side and
 * returns only the host and plan. Generation moves there too, so the plaintext
 * is created and shown without ever being stored.
 */
async function notConnected(): Promise<never> {
  throw new Error("Subscription Access IDs are unavailable in this deployment.");
}

export const supabaseAccessRepository: AccessRepository = {
  mode: "supabase",
  generateAccessId: notConnected,
  findByCode: notConnected,
  listProfileAccessIds: notConnected,
  revokeAccessId: notConnected,
  countActiveForProfile: notConnected,
};
