import { config, type AdminDataMode } from "@/lib/config";

import { localAdminRepository } from "./localAdminRepository";
import { supabaseAdminRepository } from "./supabaseAdminRepository";
import type {
  AppendCallEventInput,
  CallEventRecord,
  CallSessionFilters,
  CallSessionPatch,
  CallSessionRecord,
  CreateCallSessionInput,
  CreateProfileInput,
  HostProfile,
  PublicHostProfile,
  RemoteVideoRow,
  SessionMetrics,
  StoredAssetMeta,
  UpdateProfileInput,
} from "./types";

/**
 * The seam between the admin UI and wherever CallaStar data actually lives.
 *
 * Every page and hook talks to this interface, never to IndexedDB or Supabase
 * directly. Finishing the Supabase implementation is therefore the whole of the
 * eventual migration: no screen changes.
 */
export interface AdminRepository {
  readonly mode: AdminDataMode;

  listProfiles(): Promise<HostProfile[]>;
  getProfile(id: string): Promise<HostProfile | null>;
  createProfile(input: CreateProfileInput): Promise<HostProfile>;
  updateProfile(id: string, input: UpdateProfileInput): Promise<HostProfile>;
  deleteProfile(id: string): Promise<void>;

  /** Replaces the current code; the previous one stops resolving immediately. */
  regenerateCallId(id: string): Promise<HostProfile>;

  setAvatar(id: string, file: File): Promise<HostProfile>;
  removeAvatar(id: string): Promise<HostProfile>;
  setRemoteVideo(id: string, file: File): Promise<HostProfile>;
  removeRemoteVideo(id: string): Promise<HostProfile>;
  /** The voice a profile is heard with on an audio call. Zero or one. */
  setRemoteAudio(id: string, file: File): Promise<HostProfile>;
  removeRemoteAudio(id: string): Promise<HostProfile>;

  /** Metadata only — cheap enough for lists. */
  getAssetMeta(assetId: string): Promise<StoredAssetMeta | null>;
  /** The bytes. Only call this for a preview or for playback in a live call. */
  getAssetBlob(assetId: string): Promise<Blob | null>;
  listRemoteVideos(): Promise<RemoteVideoRow[]>;

  /** Public lookup: active profiles only, and only fields a caller may see. */
  resolveCallId(code: string): Promise<PublicHostProfile | null>;
  /**
   * The public view of a profile by its id, for a caller who arrived with a
   * Subscription Access ID rather than a Call ID.
   */
  getPublicProfile(profileId: string): Promise<PublicHostProfile | null>;

  /** Created once the caller has devices and the call is really starting. */
  createCallSession(input: CreateCallSessionInput): Promise<CallSessionRecord>;
  getCallSession(id: string): Promise<CallSessionRecord | null>;
  /** Newest first. Filtering happens in the store so lists stay cheap. */
  listCallSessions(filters?: CallSessionFilters): Promise<CallSessionRecord[]>;
  /**
   * Applies a lifecycle transition. Implementations must be idempotent: a
   * timestamp is written once, and a finished session never moves backwards.
   */
  updateCallSession(id: string, patch: CallSessionPatch): Promise<CallSessionRecord | null>;
  appendCallEvent(input: AppendCallEventInput): Promise<void>;
  getCallEvents(sessionId: string): Promise<CallEventRecord[]>;
  listProfileSessions(profileId: string, options?: { limit?: number }): Promise<CallSessionRecord[]>;
  countProfileSessions(profileId: string): Promise<number>;
  /**
   * Dashboard numbers. A method rather than a component-side reduction so the
   * Supabase implementation can answer with an aggregate query instead of
   * fetching every row.
   */
  getSessionMetrics(): Promise<SessionMetrics>;
}

/**
 * Mode is configuration, never a runtime fallback: a failing Supabase must not
 * quietly start serving a different browser's local data.
 */
export function getAdminRepository(): AdminRepository {
  return config.adminDataMode === "local" ? localAdminRepository : supabaseAdminRepository;
}

export const adminRepository = getAdminRepository();
