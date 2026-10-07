import { generateCallId, normalizeCallId } from "@/lib/callId";
import { initialsAvatarDataUrl } from "@/lib/avatar";
import { PROFILE_LIMITS } from "@/lib/config";

import {
  AdminStorageError,
  STORE_ASSETS,
  STORE_BLOBS,
  STORE_EVENTS,
  STORE_PROFILES,
  STORE_PROFILE_ENGAGEMENT,
  STORE_SESSIONS,
  runTransaction,
  type TransactionScope,
} from "./indexeddb";
import { blobToDataUrl, readAudioMetadata, readVideoMetadata, validateFile } from "./mediaFiles";
import type { AdminRepository } from "./repository";
import { computeSessionMetrics } from "./sessionInsights";
import { assertAudienceCount, engagementDelta, normalizeEngagementEmail, profileAudience, type ProfileEngagement } from "./profileEngagement";
import type {
  AppendCallEventInput,
  AssetKind,
  CallEventRecord,
  CallSessionFilters,
  CallSessionPatch,
  CallSessionRecord,
  CallSessionStatus,
  CreateCallSessionInput,
  CreateProfileInput,
  HostProfile,
  ProfileStatus,
  PublicHostProfile,
  RemoteVideoRow,
  StoredAssetMeta,
  UpdateProfileInput,
} from "./types";

/**
 * The local development engine: profiles, media and call sessions in IndexedDB.
 *
 * This is deliberately temporary. It exists so the dashboard and the call flow
 * can be built and used before Supabase is connected, and it persists only in
 * the browser profile it was created in.
 *
 * Two rules shape the code below:
 *  - Every multi-part write happens in ONE transaction, so a failure rolls the
 *    whole thing back instead of leaving a profile pointing at a missing file.
 *  - Inside a transaction only IndexedDB promises are awaited. File validation
 *    and metadata extraction happen before it opens, because awaiting anything
 *    else would let the transaction close underneath us.
 */

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Timestamps for call events, guaranteed to increase.
 *
 * Several events can be written inside the same millisecond - a call is created
 * and immediately reports permissions and connecting - and `occurredAt` is what
 * orders the timeline. Without this, events sharing a timestamp come back in
 * whatever order their random ids happen to sort in, and the history reads out
 * of sequence.
 */
let lastEventMs = 0;

function nextEventIso(): string {
  const now = Date.now();
  lastEventMs = now > lastEventMs ? now : lastEventMs + 1;
  return new Date(lastEventMs).toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function assertDisplayName(value: string): string {
  const name = value.trim();
  if (name.length < PROFILE_LIMITS.NAME_MIN || name.length > PROFILE_LIMITS.NAME_MAX) {
    throw new AdminStorageError(
      "unknown",
      `Display name must be between ${PROFILE_LIMITS.NAME_MIN} and ${PROFILE_LIMITS.NAME_MAX} characters.`,
    );
  }
  return name;
}

function assertShortBio(value: string): string {
  const bio = value.trim();
  if (bio.length > PROFILE_LIMITS.BIO_MAX) {
    throw new AdminStorageError("unknown", `Short bio must be ${PROFILE_LIMITS.BIO_MAX} characters or fewer.`);
  }
  return bio;
}

interface PreparedAsset {
  meta: StoredAssetMeta;
  blob: Blob;
}

/** Validate and describe a file before any transaction opens. */
async function prepareAsset(profileId: string, kind: AssetKind, file: File): Promise<PreparedAsset> {
  const check = validateFile(kind, file);
  if (!check.ok) throw new AdminStorageError("unknown", check.message);

  const metadata =
    kind === "remote_video"
      ? await readVideoMetadata(file)
      : kind === "remote_audio"
        ? await readAudioMetadata(file)
        : null;
  const timestamp = nowIso();

  return {
    meta: {
      id: newId(),
      profileId,
      kind,
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      durationSeconds: metadata?.durationSeconds ?? null,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      hasAudio: metadata?.hasAudio ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    blob: file,
  };
}

/** A fresh code, checked against every profile already stored. */
async function allocateCallId(scope: TransactionScope): Promise<{ callId: string; callIdKey: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const callId = generateCallId();
    const callIdKey = normalizeCallId(callId);
    const clash = await scope.getAllFromIndex<HostProfile>(STORE_PROFILES, "by_call_id_key", callIdKey);
    if (clash.length === 0) return { callId, callIdKey };
  }
  throw new AdminStorageError("unknown", "Could not allocate a unique Call ID. Please try again.");
}

async function requireProfile(scope: TransactionScope, id: string): Promise<HostProfile> {
  const profile = await scope.get<HostProfile>(STORE_PROFILES, id);
  if (!profile) throw new AdminStorageError("unknown", "That profile no longer exists.");
  return profile;
}

async function dropAsset(scope: TransactionScope, assetId: string | null | undefined): Promise<void> {
  if (!assetId) return;
  await scope.remove(STORE_ASSETS, assetId);
  await scope.remove(STORE_BLOBS, assetId);
}

/**
 * How far along a call is. Everything at the last step is finished for good.
 */
const STATUS_ORDER: Record<CallSessionStatus, number> = {
  connecting: 0,
  ringing: 1,
  active: 2,
  // Every terminal outcome shares the last step, so none of them can overwrite
  // another: whichever finished the call is the one history keeps.
  ended: 3,
  cancelled: 3,
  declined: 3,
  no_answer: 3,
  failed: 3,
};

/**
 * Apply a transition idempotently.
 *
 * Each timestamp is written once, a call never moves backwards, and a finished
 * call is history that later events cannot reopen. Returning the original
 * object when nothing changed lets the caller skip the write entirely, which is
 * what keeps a StrictMode double effect from producing a second row.
 */
function applySessionPatch(existing: CallSessionRecord, patch: CallSessionPatch): CallSessionRecord {
  const finished = STATUS_ORDER[existing.status] === 3;
  if (finished && patch.status && patch.status !== existing.status) return existing;

  const status =
    patch.status && STATUS_ORDER[patch.status] >= STATUS_ORDER[existing.status] ? patch.status : existing.status;

  const next: CallSessionRecord = {
    ...existing,
    status,
    ringingAt: existing.ringingAt ?? patch.ringingAt ?? null,
    connectedAt: existing.connectedAt ?? patch.connectedAt ?? null,
    endedAt: existing.endedAt ?? patch.endedAt ?? null,
    failureCode: existing.failureCode ?? patch.failureCode ?? null,
    // Written once, when the source is settled; a later patch never clears it.
    sourceKind: existing.sourceKind ?? patch.sourceKind ?? null,
    durationSeconds: existing.durationSeconds ?? patch.durationSeconds ?? null,
  };

  const unchanged =
    next.status === existing.status &&
    next.ringingAt === existing.ringingAt &&
    next.connectedAt === existing.connectedAt &&
    next.endedAt === existing.endedAt &&
    next.failureCode === existing.failureCode &&
    next.sourceKind === existing.sourceKind &&
    next.durationSeconds === existing.durationSeconds;

  return unchanged ? existing : next;
}

function byNewestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export const localAdminRepository: AdminRepository = {
  mode: "local",

  async listProfiles() {
    // Metadata only: no asset record and no blob is touched to build this list.
    const profiles = await runTransaction([STORE_PROFILES], "readonly", (scope) =>
      scope.getAll<HostProfile>(STORE_PROFILES),
    );
    return profiles.sort(byNewestFirst);
  },

  async getProfile(id) {
    const profile = await runTransaction([STORE_PROFILES], "readonly", (scope) =>
      scope.get<HostProfile>(STORE_PROFILES, id),
    );
    return profile ?? null;
  },

  async createProfile(input) {
    const displayName = assertDisplayName(input.displayName);
    const shortBio = assertShortBio(input.shortBio);
    const baseFollowerCount = assertAudienceCount(input.baseFollowerCount ?? 0);
    const baseLikeCount = assertAudienceCount(input.baseLikeCount ?? 0);
    const id = newId();

    const prepared: PreparedAsset[] = [];
    if (input.avatarFile) prepared.push(await prepareAsset(id, "avatar", input.avatarFile));
    if (input.coverFile) prepared.push(await prepareAsset(id, "cover", input.coverFile));
    if (input.remoteVideoFile) prepared.push(await prepareAsset(id, "remote_video", input.remoteVideoFile));
    if (input.remoteAudioFile) prepared.push(await prepareAsset(id, "remote_audio", input.remoteAudioFile));

    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const { callId, callIdKey } = await allocateCallId(scope);
      const timestamp = nowIso();

      const profile: HostProfile = {
        id,
        displayName,
        shortBio,
        baseFollowerCount,
        baseLikeCount,
        trackedFollowerCount: 0,
        trackedLikeCount: 0,
        status: input.status,
        callId,
        callIdKey,
        avatarAssetId: null,
        coverAssetId: null,
        remoteVideoAssetId: null,
        remoteAudioAssetId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      for (const asset of prepared) {
        await scope.put(STORE_ASSETS, asset.meta);
        await scope.put(STORE_BLOBS, asset.blob, asset.meta.id);
        if (asset.meta.kind === "avatar") profile.avatarAssetId = asset.meta.id;
        else if (asset.meta.kind === "cover") profile.coverAssetId = asset.meta.id;
        else if (asset.meta.kind === "remote_audio") profile.remoteAudioAssetId = asset.meta.id;
        else profile.remoteVideoAssetId = asset.meta.id;
      }

      await scope.put(STORE_PROFILES, profile);
      return profile;
    });
  },

  async updateProfile(id, input) {
    const displayName = input.displayName === undefined ? undefined : assertDisplayName(input.displayName);
    const shortBio = input.shortBio === undefined ? undefined : assertShortBio(input.shortBio);
    const baseFollowerCount = input.baseFollowerCount === undefined ? undefined : assertAudienceCount(input.baseFollowerCount);
    const baseLikeCount = input.baseLikeCount === undefined ? undefined : assertAudienceCount(input.baseLikeCount);

    return runTransaction([STORE_PROFILES], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      const next: HostProfile = {
        ...profile,
        displayName: displayName ?? profile.displayName,
        shortBio: shortBio ?? profile.shortBio,
        baseFollowerCount: baseFollowerCount ?? profile.baseFollowerCount ?? 0,
        baseLikeCount: baseLikeCount ?? profile.baseLikeCount ?? 0,
        status: input.status ?? profile.status,
        updatedAt: nowIso(),
      };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async deleteProfile(id) {
    await runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS, STORE_SESSIONS, STORE_PROFILE_ENGAGEMENT], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);

      // Call history is a record of something that happened, so deleting the
      // profile must not quietly take it with them.
      const sessions = await scope.getAllFromIndex<CallSessionRecord>(STORE_SESSIONS, "by_profile", profile.id);
      if (sessions.length > 0) {
        throw new AdminStorageError("unknown", "This profile has call history. Deactivate it instead.");
      }

      // Only this profile's assets: the index keeps unrelated records safe.
      const assets = await scope.getAllFromIndex<StoredAssetMeta>(STORE_ASSETS, "by_profile", profile.id);
      for (const asset of assets) {
        await dropAsset(scope, asset.id);
      }
      await scope.remove(STORE_PROFILES, profile.id);
      const engagement = await scope.getAllFromIndex<ProfileEngagement>(STORE_PROFILE_ENGAGEMENT, "by_profile", profile.id);
      for (const row of engagement) await scope.remove(STORE_PROFILE_ENGAGEMENT, row.id);
    });
  },

  async getProfileEngagement(profileId, callerEmail) {
    const email = normalizeEngagementEmail(callerEmail);
    const id = JSON.stringify([profileId, email]);
    return runTransaction([STORE_PROFILES, STORE_PROFILE_ENGAGEMENT], "readonly", async (scope) => {
      const profile = await requireProfile(scope, profileId);
      const previous = await scope.get<ProfileEngagement>(STORE_PROFILE_ENGAGEMENT, id);
      return { ...profileAudience(profile), following: previous?.following ?? false, liked: previous?.liked ?? false };
    });
  },

  async setProfileEngagement(profileId, callerEmail, change) {
    const email = normalizeEngagementEmail(callerEmail);
    const id = JSON.stringify([profileId, email]);
    return runTransaction([STORE_PROFILES, STORE_PROFILE_ENGAGEMENT], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, profileId);
      const previous = await scope.get<ProfileEngagement>(STORE_PROFILE_ENGAGEMENT, id);
      const delta = engagementDelta(previous, change);
      const timestamp = nowIso();
      const next: HostProfile = {
        ...profile,
        trackedFollowerCount: Math.max(0, (profile.trackedFollowerCount ?? 0) + delta.followerDelta),
        trackedLikeCount: Math.max(0, (profile.trackedLikeCount ?? 0) + delta.likeDelta),
        updatedAt: timestamp,
      };
      const engagement: ProfileEngagement = {
        id, profileId, callerEmail: email,
        following: delta.following, liked: delta.liked, updatedAt: timestamp,
      };
      await scope.put(STORE_PROFILE_ENGAGEMENT, engagement);
      await scope.put(STORE_PROFILES, next);
      return { ...profileAudience(next), following: delta.following, liked: delta.liked };
    });
  },

  async regenerateCallId(id) {
    return runTransaction([STORE_PROFILES], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      const { callId, callIdKey } = await allocateCallId(scope);
      const next: HostProfile = { ...profile, callId, callIdKey, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async setAvatar(id, file) {
    const prepared = await prepareAsset(id, "avatar", file);

    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      // New file first, old file second, both inside one transaction: the
      // profile never points at an image that is already gone.
      await scope.put(STORE_ASSETS, prepared.meta);
      await scope.put(STORE_BLOBS, prepared.blob, prepared.meta.id);
      await dropAsset(scope, profile.avatarAssetId);

      const next: HostProfile = { ...profile, avatarAssetId: prepared.meta.id, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async removeAvatar(id) {
    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await dropAsset(scope, profile.avatarAssetId);
      const next: HostProfile = { ...profile, avatarAssetId: null, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async setCover(id, file) {
    const prepared = await prepareAsset(id, "cover", file);

    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await scope.put(STORE_ASSETS, prepared.meta);
      await scope.put(STORE_BLOBS, prepared.blob, prepared.meta.id);
      await dropAsset(scope, profile.coverAssetId);

      const next: HostProfile = { ...profile, coverAssetId: prepared.meta.id, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async removeCover(id) {
    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await dropAsset(scope, profile.coverAssetId);
      const next: HostProfile = { ...profile, coverAssetId: null, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async setRemoteVideo(id, file) {
    const prepared = await prepareAsset(id, "remote_video", file);

    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await scope.put(STORE_ASSETS, prepared.meta);
      await scope.put(STORE_BLOBS, prepared.blob, prepared.meta.id);
      // One active video per profile: the previous one goes as the new one lands.
      await dropAsset(scope, profile.remoteVideoAssetId);

      const next: HostProfile = { ...profile, remoteVideoAssetId: prepared.meta.id, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async removeRemoteVideo(id) {
    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await dropAsset(scope, profile.remoteVideoAssetId);
      const next: HostProfile = { ...profile, remoteVideoAssetId: null, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async setRemoteAudio(id, file) {
    const prepared = await prepareAsset(id, "remote_audio", file);

    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await scope.put(STORE_ASSETS, prepared.meta);
      await scope.put(STORE_BLOBS, prepared.blob, prepared.meta.id);
      // One voice per profile, like the video: the old one goes as this lands.
      await dropAsset(scope, profile.remoteAudioAssetId);

      const next: HostProfile = { ...profile, remoteAudioAssetId: prepared.meta.id, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async removeRemoteAudio(id) {
    return runTransaction([STORE_PROFILES, STORE_ASSETS, STORE_BLOBS], "readwrite", async (scope) => {
      const profile = await requireProfile(scope, id);
      await dropAsset(scope, profile.remoteAudioAssetId);
      const next: HostProfile = { ...profile, remoteAudioAssetId: null, updatedAt: nowIso() };
      await scope.put(STORE_PROFILES, next);
      return next;
    });
  },

  async getAssetMeta(assetId) {
    const meta = await runTransaction([STORE_ASSETS], "readonly", (scope) =>
      scope.get<StoredAssetMeta>(STORE_ASSETS, assetId),
    );
    return meta ?? null;
  },

  async getAssetBlob(assetId) {
    const blob = await runTransaction([STORE_BLOBS], "readonly", (scope) => scope.get<Blob>(STORE_BLOBS, assetId));
    return blob ?? null;
  },

  async listRemoteVideos() {
    const rows = await runTransaction([STORE_PROFILES, STORE_ASSETS], "readonly", async (scope) => {
      const profiles = await scope.getAll<HostProfile>(STORE_PROFILES);
      const result: RemoteVideoRow[] = [];
      for (const profile of profiles) {
        const video = profile.remoteVideoAssetId
          ? ((await scope.get<StoredAssetMeta>(STORE_ASSETS, profile.remoteVideoAssetId)) ?? null)
          : null;
        const audio = profile.remoteAudioAssetId
          ? ((await scope.get<StoredAssetMeta>(STORE_ASSETS, profile.remoteAudioAssetId)) ?? null)
          : null;
        result.push({ profile, video, audio });
      }
      return result;
    });

    return rows.sort((a, b) => byNewestFirst(a.profile, b.profile));
  },

  async resolveCallId(code) {
    const key = normalizeCallId(code);
    if (!key) return null;

    const found = await runTransaction([STORE_PROFILES, STORE_BLOBS], "readonly", async (scope) => {
      const matches = await scope.getAllFromIndex<HostProfile>(STORE_PROFILES, "by_call_id_key", key);
      const profile = matches[0];
      // An inactive profile still resolves, carrying its status, so the caller
      // can be shown who is unavailable rather than "no such Call ID". Acting
      // on that status is the flow's job, and it refuses before any device is
      // requested.
      if (!profile) return null;

      const avatar = profile.avatarAssetId
        ? ((await scope.get<Blob>(STORE_BLOBS, profile.avatarAssetId)) ?? null)
        : null;
      const cover = profile.coverAssetId
        ? ((await scope.get<Blob>(STORE_BLOBS, profile.coverAssetId)) ?? null)
        : null;
      return { profile, avatar, cover };
    });

    if (!found) return null;

    const publicProfile: PublicHostProfile = {
      ...profileAudience(found.profile),
      id: found.profile.id,
      displayName: found.profile.displayName,
      shortBio: found.profile.shortBio,
      avatarDataUrl: found.avatar
        ? await blobToDataUrl(found.avatar)
        : initialsAvatarDataUrl(found.profile.displayName),
      coverDataUrl: found.cover ? await blobToDataUrl(found.cover) : null,
      remoteVideoAssetId: found.profile.remoteVideoAssetId,
      remoteAudioAssetId: found.profile.remoteAudioAssetId ?? null,
      status: found.profile.status,
    };

    return publicProfile;
  },

  async getPublicProfile(profileId) {
    if (!profileId) return null;

    const found = await runTransaction([STORE_PROFILES, STORE_BLOBS], "readonly", async (scope) => {
      const profile = await scope.get<HostProfile>(STORE_PROFILES, profileId);
      if (!profile) return null;

      const avatar = profile.avatarAssetId
        ? ((await scope.get<Blob>(STORE_BLOBS, profile.avatarAssetId)) ?? null)
        : null;
      const cover = profile.coverAssetId
        ? ((await scope.get<Blob>(STORE_BLOBS, profile.coverAssetId)) ?? null)
        : null;
      return { profile, avatar, cover };
    });

    if (!found) return null;

    return {
      ...profileAudience(found.profile),
      id: found.profile.id,
      displayName: found.profile.displayName,
      shortBio: found.profile.shortBio,
      avatarDataUrl: found.avatar
        ? await blobToDataUrl(found.avatar)
        : initialsAvatarDataUrl(found.profile.displayName),
      coverDataUrl: found.cover ? await blobToDataUrl(found.cover) : null,
      remoteVideoAssetId: found.profile.remoteVideoAssetId,
      remoteAudioAssetId: found.profile.remoteAudioAssetId ?? null,
      status: found.profile.status,
    };
  },

  async createCallSession(input) {
    return runTransaction([STORE_SESSIONS], "readwrite", async (scope) => {
      // Keyed by the call's own id: a StrictMode remount records one session.
      const existing = await scope.get<CallSessionRecord>(STORE_SESSIONS, input.id);
      if (existing) return existing;

      const createdAt = nowIso();
      const record: CallSessionRecord = {
        ...input,
        status: "connecting",
        createdAt,
        connectingAt: createdAt,
        ringingAt: null,
        connectedAt: null,
        endedAt: null,
        failureCode: null,
        sourceKind: null,
        durationSeconds: null,
      };
      await scope.put(STORE_SESSIONS, record);
      return record;
    });
  },

  async getCallSession(id) {
    const session = await runTransaction([STORE_SESSIONS], "readonly", (scope) =>
      scope.get<CallSessionRecord>(STORE_SESSIONS, id),
    );
    return session ?? null;
  },

  async listCallSessions(filters) {
    const sessions = await runTransaction([STORE_SESSIONS], "readonly", (scope) => {
      // Narrow in the store where an index can do it; the rest is cheap.
      if (filters?.profileId && filters.profileId !== "all") {
        return scope.getAllFromIndex<CallSessionRecord>(STORE_SESSIONS, "by_profile", filters.profileId);
      }
      if (filters?.status && filters.status !== "all") {
        return scope.getAllFromIndex<CallSessionRecord>(STORE_SESSIONS, "by_status", filters.status);
      }
      return scope.getAll<CallSessionRecord>(STORE_SESSIONS);
    });

    const matched = sessions.filter((session) => {
      if (filters?.status && filters.status !== "all" && session.status !== filters.status) return false;
      if (filters?.callType && filters.callType !== "all" && session.callType !== filters.callType) return false;
      if (filters?.profileId && filters.profileId !== "all" && session.profileId !== filters.profileId) return false;
      if (filters?.since && session.createdAt < filters.since) return false;
      return true;
    });

    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filters?.limit ? matched.slice(0, filters.limit) : matched;
  },

  async updateCallSession(id, patch) {
    return runTransaction([STORE_SESSIONS], "readwrite", async (scope) => {
      const existing = await scope.get<CallSessionRecord>(STORE_SESSIONS, id);
      if (!existing) return null;

      const next = applySessionPatch(existing, patch);
      // Nothing changed: a repeated transition must not rewrite the record.
      if (next === existing) return existing;

      await scope.put(STORE_SESSIONS, next);
      return next;
    });
  },

  async appendCallEvent(input) {
    await runTransaction([STORE_EVENTS], "readwrite", async (scope) => {
      const record: CallEventRecord = {
        id: newId(),
        sessionId: input.sessionId,
        type: input.type,
        occurredAt: nextEventIso(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      await scope.put(STORE_EVENTS, record);
    });
  },

  async getCallEvents(sessionId) {
    const events = await runTransaction([STORE_EVENTS], "readonly", (scope) =>
      scope.getAllFromIndex<CallEventRecord>(STORE_EVENTS, "by_session", sessionId),
    );
    // Oldest first, with the id as a stable tiebreak for anything written by an
    // older build that did not have a monotonic clock.
    return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  },

  async listProfileSessions(profileId, options) {
    const sessions = await runTransaction([STORE_SESSIONS], "readonly", (scope) =>
      scope.getAllFromIndex<CallSessionRecord>(STORE_SESSIONS, "by_profile", profileId),
    );
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return options?.limit ? sessions.slice(0, options.limit) : sessions;
  },

  async countProfileSessions(profileId) {
    const sessions = await runTransaction([STORE_SESSIONS], "readonly", (scope) =>
      scope.getAllFromIndex<CallSessionRecord>(STORE_SESSIONS, "by_profile", profileId),
    );
    return sessions.length;
  },

  async getSessionMetrics() {
    const sessions = await runTransaction([STORE_SESSIONS], "readonly", (scope) =>
      scope.getAll<CallSessionRecord>(STORE_SESSIONS),
    );
    return computeSessionMetrics(sessions);
  },
};

/** Exported for the development-only sample profile helper. */
export type { ProfileStatus };
