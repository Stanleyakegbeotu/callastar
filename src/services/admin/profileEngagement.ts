import type { HostProfile } from "./types";

export interface ProfileEngagement {
  id: string;
  profileId: string;
  callerEmail: string;
  following: boolean;
  liked: boolean;
  updatedAt: string;
}

export interface EngagementSnapshot {
  followerCount: number;
  likeCount: number;
  following: boolean;
  liked: boolean;
}

export interface EngagementChange {
  following?: boolean;
  liked?: boolean;
}

export function assertAudienceCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new Error("Enter a whole number between 0 and 1,000,000,000,000.");
  }
  return value;
}

/** Accepts a full count or a compact host count such as `12k` or `1.5M`. */
export function parseAudienceCount(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) throw new Error("Use a whole count, or add k for thousands and M for millions (for example, 12k or 1.5M).");
  const magnitude = match[2]?.toLowerCase() === "k" ? 1_000 : match[2] ? 1_000_000 : 1;
  return assertAudienceCount(Number(match[1]) * magnitude);
}

export function formatAudienceCount(value: number): string {
  if (value >= 999_950_000) return `${Number((value / 1_000_000_000).toFixed(1))}B`;
  if (value >= 999_950) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 999) return `${Number((value / 1_000).toFixed(1))}k`;
  return new Intl.NumberFormat().format(value);
}

export function normalizeEngagementEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address before following or liking a host.");
  }
  return email;
}

/** Imported audience counts and activity collected here remain separate. */
export function profileAudience(profile: Pick<HostProfile,
  "baseFollowerCount" | "baseLikeCount" | "trackedFollowerCount" | "trackedLikeCount"
>) {
  return {
    followerCount: (profile.baseFollowerCount ?? 0) + (profile.trackedFollowerCount ?? 0),
    likeCount: (profile.baseLikeCount ?? 0) + (profile.trackedLikeCount ?? 0),
  };
}

/** Explicit states make repeat writes and simultaneous clicks idempotent. */
export function engagementDelta(previous: Pick<ProfileEngagement, "following" | "liked"> | undefined, change: EngagementChange) {
  const following = change.following ?? previous?.following ?? false;
  const liked = change.liked ?? previous?.liked ?? false;
  return {
    following,
    liked,
    followerDelta: Number(following) - Number(previous?.following ?? false),
    likeDelta: Number(liked) - Number(previous?.liked ?? false),
  };
}
