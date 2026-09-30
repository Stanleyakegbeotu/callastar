import type { HostProfile, ProfileReadiness } from "./types";

/**
 * Readiness and dashboard arithmetic, defined once.
 *
 * Several screens ask "is this profile ready?" and "how many are?" — if each
 * answered for itself the KPI cards and the profile badge would eventually
 * disagree. Everything derives from these functions.
 */

/**
 * A profile is only reachable for a real call when it is active, has a face to
 * show before the call connects, and has the video that plays once it does.
 */
export function getProfileReadiness(profile: HostProfile): ProfileReadiness {
  if (profile.status !== "active") return "inactive";
  if (!profile.avatarAssetId || !profile.remoteVideoAssetId) return "incomplete";
  return "ready";
}

export interface ReadinessCheck {
  label: string;
  done: boolean;
  hint?: string;
}

export function getReadinessChecklist(profile: HostProfile): ReadinessCheck[] {
  return [
    { label: "Profile created", done: true },
    { label: "Call ID assigned", done: Boolean(profile.callId) },
    { label: "Avatar uploaded", done: Boolean(profile.avatarAssetId), hint: "Shown while the call connects." },
    {
      label: "Remote video uploaded",
      done: Boolean(profile.remoteVideoAssetId),
      hint: "Plays as the other participant once the call is active.",
    },
    { label: "Profile active", done: profile.status === "active", hint: "Inactive profiles cannot be called." },
  ];
}

export interface ProfileStats {
  total: number;
  active: number;
  ready: number;
  missingVideo: number;
  missingAvatar: number;
  inactive: number;
}

export function getProfileStats(profiles: HostProfile[]): ProfileStats {
  return profiles.reduce<ProfileStats>(
    (stats, profile) => ({
      total: stats.total + 1,
      active: stats.active + (profile.status === "active" ? 1 : 0),
      ready: stats.ready + (getProfileReadiness(profile) === "ready" ? 1 : 0),
      missingVideo: stats.missingVideo + (profile.remoteVideoAssetId ? 0 : 1),
      missingAvatar: stats.missingAvatar + (profile.avatarAssetId ? 0 : 1),
      inactive: stats.inactive + (profile.status === "inactive" ? 1 : 0),
    }),
    { total: 0, active: 0, ready: 0, missingVideo: 0, missingAvatar: 0, inactive: 0 },
  );
}

export type ProfileFilter = "all" | "active" | "inactive" | "ready" | "missing-video";

export function matchesFilter(profile: HostProfile, filter: ProfileFilter): boolean {
  switch (filter) {
    case "active":
      return profile.status === "active";
    case "inactive":
      return profile.status === "inactive";
    case "ready":
      return getProfileReadiness(profile) === "ready";
    case "missing-video":
      return profile.remoteVideoAssetId === null;
    case "all":
      return true;
  }
}

/** Name or Call ID, however the code was typed. */
export function matchesSearch(profile: HostProfile, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const compact = needle.replace(/[^a-z0-9]/g, "");
  return (
    profile.displayName.toLowerCase().includes(needle) ||
    profile.callId.toLowerCase().includes(needle) ||
    (compact.length > 0 && profile.callIdKey.toLowerCase().includes(compact))
  );
}
