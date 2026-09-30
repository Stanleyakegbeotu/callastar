import { looksLikeCallId } from "@/lib/callId";
import { logDiagnostic } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import { callBackend } from "@/services/callBackend";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlan } from "@/services/subscriptions/types";
import type { HostPreview } from "@/types/host";

import { looksLikeAccessId, normalizeAccessId } from "./accessCode";
import { hasUsedPreview } from "./previewAccess";
import { accessRepository } from "./repository";
import type { AccessResolutionFailure, SubscriptionAccessId } from "./types";

/**
 * What happens when somebody submits an ID.
 *
 * One entry point for both credential types, because the person typing does not
 * think of them as different things — they were given "an ID" by a host or by
 * support. The checks happen in a fixed order, and the order is the product
 * rule:
 *
 *   1. what kind of credential is this, and does it resolve at all?
 *   2. is the host available?            availability beats everything
 *   3. is there paid access?             authorised call, no preview gate
 *   4. has this browser had its preview? returning caller, subscribe first
 *   5. otherwise                         the normal first-call preview
 *
 * Nothing here touches a camera or a microphone. Every outcome is decided
 * before any device is requested, which is the whole point of doing it here
 * rather than inside the call screen.
 */
export type EntryOutcome =
  /** Normal first call: the preview has not been used for this host. */
  | { kind: "call"; host: HostPreview }
  /** Host is not taking calls. Wins over every other outcome. */
  | { kind: "inactive"; host: HostPreview }
  /** This browser already spent its preview for this host. */
  | { kind: "returning"; host: HostPreview }
  /** A valid Subscription Access ID: straight to an authorised call. */
  | { kind: "authorized"; host: HostPreview; access: SubscriptionAccessId; plan: SubscriptionPlan }
  | { kind: "not-found" }
  | { kind: "access-invalid"; reason: AccessResolutionFailure };

/** Which resolver to use. Shape only — it authorises nothing. */
export function classifyEntryId(value: string): "access" | "call" | "unknown" {
  const trimmed = value.trim();
  if (looksLikeAccessId(trimmed)) return "access";
  if (looksLikeCallId(trimmed)) return "call";
  // A bare CSUB prefix is a mistyped access ID, not a Call ID; saying so is
  // more useful than "that is not a Call ID".
  if (normalizeAccessId(trimmed).startsWith("CSUB")) return "access";
  return "unknown";
}

export async function resolveEntryId(value: string): Promise<EntryOutcome> {
  const kind = classifyEntryId(value);
  if (kind === "access") return resolveAccess(value);
  return resolveCall(value);
}

/** A host who cannot take calls, whatever the caller is holding. */
function unavailable(host: HostPreview): EntryOutcome {
  return { kind: "inactive", host };
}

async function resolveCall(value: string): Promise<EntryOutcome> {
  const result = await callBackend.resolveCallId(value);
  if (!result.found) return { kind: "not-found" };

  const host = result.host;
  if (host.available === false) return unavailable(host);

  // Asked before permissions, so a returning caller never sees another prompt.
  if (await hasUsedPreview(host.id)) return { kind: "returning", host };

  return { kind: "call", host };
}

async function resolveAccess(value: string): Promise<EntryOutcome> {
  if (!looksLikeAccessId(value)) return { kind: "access-invalid", reason: "malformed" };

  let record: SubscriptionAccessId | null = null;
  try {
    record = await accessRepository.findByCode(value);
  } catch (error) {
    logDiagnostic("access-resolve", error);
    return { kind: "access-invalid", reason: "not_found" };
  }

  // Unknown and revoked are reported the same way to the person typing. Telling
  // somebody a credential "was revoked" confirms it once existed, which is more
  // than a stranger holding a guess should learn.
  if (!record) return { kind: "access-invalid", reason: "not_found" };
  if (record.status !== "active") return { kind: "access-invalid", reason: "revoked" };

  const profile = await adminRepository.getPublicProfile(record.profileId);
  if (!profile) return { kind: "access-invalid", reason: "not_found" };

  const host: HostPreview = {
    id: profile.id,
    displayName: profile.displayName,
    shortName: profile.displayName.split(/\s+/)[0] || profile.displayName,
    avatarUrl: profile.avatarDataUrl,
    shortBio: profile.shortBio,
    remoteVideoRef: profile.remoteVideoAssetId,
    remoteAudioRef: profile.remoteAudioAssetId,
    available: profile.status === "active",
  };

  // Paid access does not override availability: the host still has to be there.
  if (!host.available) return unavailable(host);

  const plans = await subscriptionRepository.listPlans();
  const plan = plans.find((candidate) => candidate.id === record.planId);
  if (!plan || !plan.isActive) return { kind: "access-invalid", reason: "plan_unavailable" };

  return { kind: "authorized", host, access: record, plan };
}
