import { normalizeCallId } from "@/lib/callId";
import { initialsAvatarDataUrl } from "@/lib/avatar";
import { PROFILE_LIMITS } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";
import { resolveAdminMedia, STORAGE_BUCKETS } from "@/services/media/privateMedia";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { verifyUpload } from "@/services/media/verifyUpload";
import { blobToDataUrl, readAudioMetadata, readVideoMetadata, validateFile } from "./mediaFiles";
import { computeSessionMetrics } from "./sessionInsights";
import { assertAudienceCount, normalizeEngagementEmail } from "./profileEngagement";
import type { AdminRepository } from "./repository";
import type { AssetKind, CallEventRecord, CallSessionRecord, HostProfile, PublicHostProfile, RemoteVideoRow, StoredAssetMeta } from "./types";
import type { AppendCallEventInput, CallSessionFilters, CallSessionPatch, CreateCallSessionInput, CreateProfileInput, UpdateProfileInput } from "./types";

type Row = Record<string, any>;
const AVATAR_BUCKET = STORAGE_BUCKETS.avatar;
const MEDIA_BUCKET = STORAGE_BUCKETS.remote_video;
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const assetBucket = (kind: AssetKind) => kind === "avatar" || kind === "cover" ? AVATAR_BUCKET : MEDIA_BUCKET;
const assetPath = (hostId: string, kind: AssetKind, file: File) => `${hostId}/${kind}/${newId()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

function fromProfile(row: Row, activeCallId?: Row | null): HostProfile {
  return {
    id: row.id, displayName: row.display_name, shortBio: row.short_bio ?? "", status: row.status,
    baseFollowerCount: Number(row.base_follower_count ?? 0), baseLikeCount: Number(row.base_like_count ?? 0),
    trackedFollowerCount: Number(row.tracked_follower_count ?? 0), trackedLikeCount: Number(row.tracked_like_count ?? 0),
    callId: activeCallId?.code_last4 ? `••••-${activeCallId.code_last4}` : "",
    callIdKey: "",
    avatarAssetId: row.avatar_path ?? null, coverAssetId: row.cover_path ?? null,
    remoteVideoAssetId: row.remote_video_asset_id ?? null, remoteAudioAssetId: row.remote_audio_asset_id ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function withDecryptedCallId(profile: HostProfile, activeCallId?: Row | null): HostProfile {
  const code = activeCallId?.code_display;
  return code ? { ...profile, callId: code, callIdKey: normalizeCallId(code) } : profile;
}
function fromAsset(row: Row): StoredAssetMeta {
  return { id: row.id, profileId: row.host_id, kind: row.kind, fileName: row.file_name, mimeType: row.mime_type, fileSize: Number(row.file_size_bytes), durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds), width: row.width ?? null, height: row.height ?? null, hasAudio: row.has_audio ?? true, createdAt: row.created_at, updatedAt: row.updated_at };
}
function fromSession(row: Row): CallSessionRecord {
  return {
    id: row.id, profileId: row.host_id, profileName: row.profile_name_snapshot ?? row.host?.display_name ?? "Host",
    callIdSnapshot: row.call_id_snapshot ?? "", callType: row.call_type,
    caller: { fullName: row.visitor_name, email: row.visitor_email, phone: row.visitor_phone }, status: row.status,
    createdAt: row.created_at, connectingAt: row.connecting_at ?? row.created_at, ringingAt: row.ringing_at ?? null,
    connectedAt: row.connected_at ?? null, endedAt: row.ended_at ?? null, failureCode: row.failure_code ?? row.error_code ?? null,
    durationSeconds: row.duration_seconds ?? null, sourceKind: row.source_kind ?? null,
  };
}
async function signedDataUrl(bucket: string, path: string | null): Promise<string> {
  if (!path) return "";
  const client = requireSupabase();
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 1800);
  if (error || !data?.signedUrl) return "";
  try { const response = await fetch(data.signedUrl); return response.ok ? await blobToDataUrl(await response.blob()) : ""; }
  catch { return ""; }
}
async function activeIds(hostIds: string[]) {
  if (!hostIds.length) return new Map<string, Row>();
  const { data, error } = await requireSupabase().functions.invoke("admin-call-ids", { body: { hostIds } });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Call IDs could not be loaded.");
  const result = new Map<string, Row>();
  for (const row of data?.callIds ?? []) if (!result.has(row.hostId) && (!row.expiresAt || row.expiresAt > now())) result.set(row.hostId, { id: row.id, host_id: row.hostId, code_last4: row.codeLast4, code_display: row.code });
  return result;
}
async function loadProfile(id: string) {
  const { data, error } = await requireSupabase().from("hosts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const ids = await activeIds([id]);
  return withDecryptedCallId(fromProfile(data, ids.get(id)), ids.get(id));
}
async function prepareAsset(hostId: string, kind: AssetKind, file: File): Promise<{ meta: StoredAssetMeta; path: string }> {
  const check = validateFile(kind, file);
  if (!check.ok) throw new Error(check.message);
  const info = kind === "remote_video" ? await readVideoMetadata(file) : kind === "remote_audio" ? await readAudioMetadata(file) : null;
  const id = newId();
  return { path: assetPath(hostId, kind, file), meta: { id, profileId: hostId, kind, fileName: file.name, mimeType: file.type, fileSize: file.size, durationSeconds: info?.durationSeconds ?? null, width: info?.width ?? null, height: info?.height ?? null, hasAudio: info?.hasAudio ?? true, createdAt: now(), updatedAt: now() } };
}
async function uploadAsset(hostId: string, kind: AssetKind, file: File): Promise<StoredAssetMeta & { storagePath: string }> {
  file = await verifyUpload(kind, file);
  const client = requireSupabase();
  const { path, meta } = await prepareAsset(hostId, kind, file);
  const bucket = assetBucket(kind);
  const { error: uploadError } = await client.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;
  const { data, error } = await client.from("host_assets").insert({ id: meta.id, host_id: hostId, kind, storage_path: path, file_name: meta.fileName, mime_type: meta.mimeType, file_size_bytes: meta.fileSize, duration_seconds: meta.durationSeconds, width: meta.width, height: meta.height, has_audio: meta.hasAudio }).select("*").single();
  if (error) { await client.storage.from(bucket).remove([path]); throw error; }
  return { ...fromAsset(data), id: data.id, storagePath: path };
}
async function setAsset(hostId: string, kind: AssetKind, file: File): Promise<HostProfile> {
  const client = requireSupabase();
  const meta = await uploadAsset(hostId, kind, file);
  const columns: Record<AssetKind, string> = { avatar: "avatar_path", cover: "cover_path", remote_video: "remote_video_asset_id", remote_audio: "remote_audio_asset_id" };
  const { data: prior } = await client.from("hosts").select(columns[kind]).eq("id", hostId).single();
  const priorId = (prior as Row | null)?.[columns[kind]];
  const { error } = await client.rpc("attach_host_assets", { p_host_id: hostId, p_asset_ids: [meta.id] });
  if (error) {
    await client.storage.from(assetBucket(kind)).remove([meta.storagePath]);
    await client.from("host_assets").delete().eq("id", meta.id);
    throw new Error("Media could not be saved. The previous source is unchanged. Please retry.");
  }
  if (priorId) await removeAssetByReference(hostId, kind, priorId).catch(() => productionDiagnostic("MEDIA_LOAD_FAILED", { stage: "old_asset_cleanup" }));
  const profile = await loadProfile(hostId);
  if (!profile) throw new Error("That host profile no longer exists.");
  return profile;
}
async function removeAssetByReference(hostId: string, kind: AssetKind, ref: string) {
  const client = requireSupabase();
  let q = client.from("host_assets").select("id,storage_path").eq("host_id", hostId).eq("kind", kind);
  q = kind === "avatar" || kind === "cover" ? q.eq("storage_path", ref) : q.eq("id", ref);
  const { data: row } = await q.maybeSingle();
  if (!row) return;
  await client.storage.from(assetBucket(kind)).remove([row.storage_path]);
  await client.from("host_assets").delete().eq("id", row.id);
  if (kind === "remote_video" || kind === "remote_audio") await client.from("host_media").delete().eq("host_id", hostId).eq("kind", kind).eq("storage_path", row.storage_path);
}
async function removeAsset(hostId: string, kind: AssetKind): Promise<HostProfile> {
  const client = requireSupabase();
  const col: Record<AssetKind, string> = { avatar: "avatar_path", cover: "cover_path", remote_video: "remote_video_asset_id", remote_audio: "remote_audio_asset_id" };
  const { data: row, error: readError } = await client.from("hosts").select(col[kind]).eq("id", hostId).single();
  if (readError) throw readError;
  const ref = (row as Row | null)?.[col[kind]];
  const { error } = await client.from("hosts").update({ [col[kind]]: null, updated_at: now() }).eq("id", hostId);
  if (error) throw error;
  if (ref) await removeAssetByReference(hostId, kind, ref);
  const profile = await loadProfile(hostId);
  if (!profile) throw new Error("That host profile no longer exists.");
  return profile;
}
function applyPatch(current: CallSessionRecord, patch: CallSessionPatch): CallSessionRecord {
  const terminal = ["ended", "cancelled", "declined", "no_answer", "failed"].includes(current.status);
  return {
    ...current,
    status: terminal && patch.status !== current.status ? current.status : patch.status ?? current.status,
    ringingAt: current.ringingAt ?? patch.ringingAt ?? null, connectedAt: current.connectedAt ?? patch.connectedAt ?? null,
    endedAt: current.endedAt ?? patch.endedAt ?? null, failureCode: current.failureCode ?? patch.failureCode ?? null,
    sourceKind: current.sourceKind ?? patch.sourceKind ?? null, durationSeconds: current.durationSeconds ?? patch.durationSeconds ?? null,
  };
}

export const supabaseAdminRepository: AdminRepository = {
  mode: "supabase",
  async listProfiles() {
    const { data, error } = await requireSupabase().from("hosts").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    const ids = await activeIds((data ?? []).map((row) => row.id));
    return (data ?? []).map((row) => withDecryptedCallId(fromProfile(row, ids.get(row.id)), ids.get(row.id)));
  },
  async getProfile(id) { return loadProfile(id); },
  async createProfile(input: CreateProfileInput) {
    const name = input.displayName.trim(); const bio = input.shortBio.trim();
    if (name.length < PROFILE_LIMITS.NAME_MIN || name.length > PROFILE_LIMITS.NAME_MAX) throw new Error("Enter a valid host name.");
    if (bio.length > PROFILE_LIMITS.BIO_MAX) throw new Error("The bio is too long.");
    const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
      const start = performance.now(); let success = false;
      try { const value = await work(); success = true; return value; }
      finally { productionDiagnostic("PROFILE_CREATE_TIMING", { stage, durationMs: Math.round(performance.now() - start), success }); }
    };
    const client = requireSupabase();
    const files = (["avatar", "cover", "remote_video", "remote_audio"] as AssetKind[])
      .map((kind) => ({ kind, file: ({ avatar: input.avatarFile, cover: input.coverFile, remote_video: input.remoteVideoFile, remote_audio: input.remoteAudioFile })[kind] }))
      .filter((item): item is { kind: AssetKind; file: File } => Boolean(item.file));
    for (const { kind, file } of files) { const check = validateFile(kind, file); if (!check.ok) throw new Error(check.message); }
    input.onProgress?.("Creating profile…");
    const { data, error } = await timed("profile_insert", async () => await client.from("hosts").insert({ display_name: name, short_bio: bio, status: input.status, base_follower_count: assertAudienceCount(input.baseFollowerCount ?? 0), base_like_count: assertAudienceCount(input.baseLikeCount ?? 0) }).select("*").single());
    if (error) throw error;
    const uploaded: Awaited<ReturnType<typeof uploadAsset>>[] = [];
    try {
      input.onProgress?.(files.length ? "Uploading media…" : "Generating Call ID…");
      // Wait for every upload to settle before cleanup, so a late upload cannot orphan a file.
      const results = await Promise.allSettled([
        timed("call_id", async () => {
          const result = await client.functions.invoke("generate-call-id", { body: { hostId: data.id } });
          if (result.error || result.data?.error || !result.data?.code) throw new Error("Call ID could not be created.");
          return result.data.code as string;
        }),
        ...files.map(({ kind, file }) => timed(kind, async () => { const asset = await uploadAsset(data.id, kind, file); uploaded.push(asset); return asset.id; })),
      ]);
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      input.onProgress?.("Finalizing…");
      if (uploaded.length) await timed("media_commit", async () => {
        const { error } = await client.rpc("attach_host_assets", { p_host_id: data.id, p_asset_ids: uploaded.map((a) => a.id) });
        if (error) throw new Error("Profile media could not be finalized.");
      });
      const profile = await timed("final_read", () => loadProfile(data.id));
      if (!profile) throw new Error("Profile could not be loaded.");
      return profile;
    } catch (error) {
      await Promise.allSettled(uploaded.map((a) => client.storage.from(assetBucket(a.kind)).remove([a.storagePath])));
      const { error: cleanupError } = await client.from("hosts").delete().eq("id", data.id);
      if (cleanupError) throw new Error("Creation was interrupted. Check Profiles before retrying to avoid a duplicate.");
      throw error;
    }
  },
  async updateProfile(id, input: UpdateProfileInput) {
    const patch: Row = { updated_at: now() };
    if (input.displayName !== undefined) patch.display_name = input.displayName.trim();
    if (input.shortBio !== undefined) patch.short_bio = input.shortBio.trim();
    if (input.status !== undefined) patch.status = input.status;
    if (input.baseFollowerCount !== undefined) patch.base_follower_count = assertAudienceCount(input.baseFollowerCount);
    if (input.baseLikeCount !== undefined) patch.base_like_count = assertAudienceCount(input.baseLikeCount);
    const { error } = await requireSupabase().from("hosts").update(patch).eq("id", id);
    if (error) throw error;
    const profile = await loadProfile(id); if (!profile) throw new Error("That host profile no longer exists."); return profile;
  },
  async deleteProfile(id) { const { error } = await requireSupabase().from("hosts").delete().eq("id", id); if (error) throw error; },
  async getProfileEngagement(profileId, callerEmail) {
    const email = normalizeEngagementEmail(callerEmail);
    const { data, error } = await requireSupabase().functions.invoke("host-engagement", { body: { action: "get", hostId: profileId, email } });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Host activity is unavailable.");
    return data;
  },
  async setProfileEngagement(profileId, callerEmail, change) {
    const email = normalizeEngagementEmail(callerEmail);
    const { data, error } = await requireSupabase().functions.invoke("host-engagement", { body: { action: "set", hostId: profileId, email, change } });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Host activity could not be updated.");
    return data;
  },
  async regenerateCallId(id) {
    const { data, error } = await requireSupabase().functions.invoke("generate-call-id", { body: { hostId: id } });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Could not generate Call ID.");
    const { error: revokeError } = await requireSupabase().from("call_ids").update({ status: "revoked" }).eq("host_id", id).eq("status", "active").neq("id", data.id);
    if (revokeError) throw revokeError;
    const profile = await loadProfile(id); if (!profile) throw new Error("That host profile no longer exists."); return { ...profile, callId: data.code, callIdKey: normalizeCallId(data.code) };
  },
  async setAvatar(id, file) { return setAsset(id, "avatar", file); }, async removeAvatar(id) { return removeAsset(id, "avatar"); },
  async setCover(id, file) { return setAsset(id, "cover", file); }, async removeCover(id) { return removeAsset(id, "cover"); },
  async setRemoteVideo(id, file) { return setAsset(id, "remote_video", file); }, async removeRemoteVideo(id) { return removeAsset(id, "remote_video"); },
  async setRemoteAudio(id, file) { return setAsset(id, "remote_audio", file); }, async removeRemoteAudio(id) { return removeAsset(id, "remote_audio"); },
  async getAssetMeta(assetId) {
    const client = requireSupabase();
    const { data: byId, error } = await client.from("host_assets").select("*").eq("id", assetId).maybeSingle();
    if (error) throw error;
    if (byId) return fromAsset(byId);
    const { data, error: pathError } = await client.from("host_assets").select("*").eq("storage_path", assetId).maybeSingle();
    if (pathError) throw pathError;
    return data ? fromAsset(data) : null;
  },
  async getAssetBlob(assetId) {
    const client = requireSupabase();
    const { data: byId, error } = await client.from("host_assets").select("kind,storage_path").eq("id", assetId).maybeSingle();
    if (error) throw error;
    let row = byId;
    if (!row) { const { data, error: pathError } = await client.from("host_assets").select("kind,storage_path").eq("storage_path", assetId).maybeSingle(); if (pathError) throw pathError; row = data; }
    if (!row) return null;
    const { data, error: downloadError } = await client.storage.from(assetBucket(row.kind)).download(row.storage_path);
    if (downloadError) throw downloadError; return data;
  },
  async getAssetUrl(assetId, refresh) { return (await resolveAdminMedia(assetId, refresh))?.url ?? null; },
  async listRemoteVideos() {
    const profiles = await this.listProfiles();
    const references = profiles.flatMap((profile) => [profile.remoteVideoAssetId, profile.remoteAudioAssetId]).filter((id): id is string => Boolean(id));
    const { data, error } = references.length
      ? await requireSupabase().from("host_assets").select("*").in("id", references)
      : { data: [], error: null };
    if (error) throw new Error("Unable to load host media. Please retry.");
    const assets = new Map((data ?? []).map((row) => [row.id, fromAsset(row)]));
    return profiles.map((profile) => ({ profile, video: assets.get(profile.remoteVideoAssetId ?? "") ?? null, audio: assets.get(profile.remoteAudioAssetId ?? "") ?? null }));
  },
  async resolveCallId(code) {
    const { data, error } = await requireSupabase().functions.invoke("resolve-call-id", { body: { code } });
    if (error) throw error; if (!data?.found) return null;
    const extra = data.host;
    const toDataUrl = async (url: string | null | undefined) => { if (!url) return ""; const response = await fetch(url); return response.ok ? blobToDataUrl(await response.blob()) : ""; };
    return { id: extra.id, displayName: extra.displayName, shortBio: extra.shortBio ?? "", avatarDataUrl: await toDataUrl(extra.avatarUrl) || initialsAvatarDataUrl(extra.displayName), coverDataUrl: await toDataUrl(extra.coverUrl) || null, followerCount: extra.followerCount ?? 0, likeCount: extra.likeCount ?? 0, remoteVideoAssetId: extra.remoteVideoAssetId ?? null, remoteAudioAssetId: extra.remoteAudioAssetId ?? null, status: extra.status ?? "active" };
  },
  async getPublicProfile(profileId) {
    const { data, error } = await requireSupabase().functions.invoke("get-public-profile", { body: { profileId } });
    if (error) throw error; if (!data?.profile) return null;
    return data.profile as PublicHostProfile;
  },
  async createCallSession(input: CreateCallSessionInput) {
    const { data, error } = await requireSupabase().from("call_sessions").insert({ host_id: input.profileId, call_type: input.callType, visitor_name: input.caller.fullName, visitor_email: input.caller.email.toLowerCase(), visitor_phone: input.caller.phone, session_token_hash: "admin-created", status: "connecting", call_id_snapshot: input.callIdSnapshot, profile_name_snapshot: input.profileName }).select("*,host:hosts(display_name)").single();
    if (error) throw error; return fromSession(data);
  },
  async getCallSession(id) { const { data, error } = await requireSupabase().from("call_sessions").select("*,host:hosts(display_name)").eq("id", id).maybeSingle(); if (error) throw error; return data ? fromSession(data) : null; },
  async listCallSessions(filters?: CallSessionFilters) {
    let q = requireSupabase().from("call_sessions").select("*,host:hosts(display_name)");
    if (filters?.status && filters.status !== "all") q = q.eq("status", filters.status);
    if (filters?.callType && filters.callType !== "all") q = q.eq("call_type", filters.callType);
    if (filters?.profileId && filters.profileId !== "all") q = q.eq("host_id", filters.profileId);
    if (filters?.since) q = q.gte("created_at", filters.since);
    q = q.order("created_at", { ascending: false }).limit(filters?.limit ?? 500);
    const { data, error } = await q; if (error) throw error; return (data ?? []).map(fromSession);
  },
  async updateCallSession(id, patch: CallSessionPatch) {
    const existing = await this.getCallSession(id); if (!existing) return null;
    const next = applyPatch(existing, patch); const columns: Row = {};
    if (patch.status) columns.status = next.status;
    if (patch.ringingAt) columns.ringing_at = next.ringingAt;
    if (patch.connectedAt) columns.connected_at = next.connectedAt;
    if (patch.endedAt) columns.ended_at = next.endedAt;
    if (patch.failureCode !== undefined) columns.failure_code = next.failureCode;
    if (patch.durationSeconds !== undefined) columns.duration_seconds = next.durationSeconds;
    if (patch.sourceKind !== undefined) columns.source_kind = next.sourceKind;
    if (!Object.keys(columns).length) return existing;
    const { data, error } = await requireSupabase().from("call_sessions").update(columns).eq("id", id).select("*,host:hosts(display_name)").maybeSingle();
    if (error) throw error; return data ? fromSession(data) : null;
  },
  async appendCallEvent(input: AppendCallEventInput) { const { error } = await requireSupabase().from("call_events").insert({ session_id: input.sessionId, event_type: input.type, metadata: input.metadata ?? {}, created_at: now() }); if (error && error.code !== "23505") throw error; },
  async getCallEvents(sessionId: string) { const { data, error } = await requireSupabase().from("call_events").select("*").eq("session_id", sessionId).order("created_at").order("id"); if (error) throw error; return (data ?? []).map((r: Row): CallEventRecord => ({ id: r.id, sessionId: r.session_id, type: r.event_type, occurredAt: r.created_at, metadata: r.metadata ?? {} })); },
  async listProfileSessions(profileId, options) { return (await this.listCallSessions({ profileId, limit: options?.limit ?? 500 })); },
  async countProfileSessions(profileId) { const { count, error } = await requireSupabase().from("call_sessions").select("id", { count: "exact", head: true }).eq("host_id", profileId); if (error) throw error; return count ?? 0; },
  async getSessionMetrics() { return computeSessionMetrics(await this.listCallSessions({ limit: 5000 })); },
};
