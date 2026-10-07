import { config } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";
import { logDiagnostic } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import { sendAdminEvent } from "@/services/notifications/adminEvents";
import type {
  CallEventMetadata,
  CallEventType,
  CallSessionPatch,
  CreateCallSessionInput,
} from "@/services/admin/types";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";
import type { CallerDetails } from "@/types/user";

export interface CallSessionCredentials {
  sessionId: string;
  sessionToken: string;
}

export interface ResolvedHost extends HostPreview {
  shortBio?: string | null;
}

/**
 * The remote participant's media.
 *
 * A Blob comes back from the local engine and the caller owns its object URL;
 * a signed `url` is what Supabase will return. Either way the consumer creates
 * and revokes exactly one URL — see `useRemoteVideo`.
 */
export type RemoteMedia =
  | { available: false }
  | { available: true; blob?: Blob; url?: string; hasAudio: boolean };

export interface CallBackend {
  resolveCallId(code: string): Promise<{ found: true; host: ResolvedHost } | { found: false }>;
  startCallSession(
    code: string,
    callType: CallType,
    caller: CallerDetails,
  ): Promise<CallSessionCredentials & { host: ResolvedHost }>;
  updateCallSession(
    credentials: CallSessionCredentials,
    status: "ringing" | "active" | "ended" | "cancelled" | "failed",
  ): Promise<void>;
  getSessionMedia(credentials: CallSessionCredentials): Promise<{ available: boolean; url?: string; hasAudio?: boolean }>;

  /**
   * Media for a host the caller has already resolved. The call type decides
   * what is served: an audio call plays the profile's audio when it has one.
   */
  getRemoteMedia(host: HostPreview, callType: CallType): Promise<RemoteMedia>;

  /**
   * Call history. The local engine records sessions and their events so the
   * dashboard shows real activity; with Supabase the Edge Functions write
   * `call_sessions` themselves, so this stays undefined there.
   */
  sessions?: CallSessionRecorder;
}

export interface CallSessionRecorder {
  create(input: CreateCallSessionInput): Promise<void>;
  transition(sessionId: string, patch: CallSessionPatch): Promise<void>;
  event(sessionId: string, type: CallEventType, metadata?: CallEventMetadata): Promise<void>;
}

const cloudSessionCredentials = new Map<string, Promise<CallSessionCredentials>>();

/** Opaque credential pair held in memory and used only for this live call. */
export async function getCloudCallSessionCredentials(localSessionId: string): Promise<CallSessionCredentials | null> {
  const pending = cloudSessionCredentials.get(localSessionId);
  return pending ? await pending : null;
}

function shortName(displayName: string): string {
  return displayName.split(/\s+/)[0] || displayName;
}

const supabaseBackend: CallBackend = {
  async resolveCallId(code) {
    const { data, error } = await requireSupabase().functions.invoke("resolve-call-id", { body: { code } });
    if (error) throw new Error("Unable to reach CallaStar.");
    if (!data?.found) return { found: false };
    return {
      found: true,
      host: {
        id: data.host.id,
        displayName: data.host.displayName,
        shortName: shortName(data.host.displayName),
        avatarUrl: data.host.avatarUrl ?? "",
        coverUrl: data.host.coverUrl ?? null,
        shortBio: data.host.shortBio,
        followerCount: data.host.followerCount,
        likeCount: data.host.likeCount,
        available: data.host.status !== "inactive",
      },
    };
  },
  async startCallSession(code, callType, caller) {
    const { data, error } = await requireSupabase().functions.invoke("start-call-session", {
      body: { code, callType, caller },
    });
    if (error || !data?.sessionId || !data?.sessionToken) throw new Error("We couldn't start your call.");
    sendAdminEvent("new_call", data.sessionId, `${caller.fullName} started a ${callType} call with ${data.host.displayName}.`);
    return {
      sessionId: data.sessionId,
      sessionToken: data.sessionToken,
      host: {
        id: data.host.id,
        displayName: data.host.displayName,
        shortName: shortName(data.host.displayName),
        avatarUrl: data.host.avatarUrl ?? "",
        coverUrl: data.host.coverUrl ?? null,
        available: true,
      },
    };
  },
  async updateCallSession(credentials, status) {
    const { error } = await requireSupabase().functions.invoke("update-call-session", {
      body: { ...credentials, status },
    });
    if (error) throw new Error("Unable to update call status.");
    if (status === "active") sendAdminEvent("call_answered", credentials.sessionId, "A host answered the call.");
    if (status === "ended") sendAdminEvent("call_completed", credentials.sessionId, "The call has ended.");
  },
  async getSessionMedia(credentials) {
    const { data, error } = await requireSupabase().functions.invoke("get-session-media", { body: credentials });
    if (error) throw new Error("Unable to load remote media.");
    return data?.available ? { available: true, url: data.media.url, hasAudio: data.media.hasAudio } : { available: false };
  },
  async getRemoteMedia() {
    // Signed media is session-scoped: this arrives once the call session
    // handshake is wired to `startCallSession` / `getSessionMedia`.
    return { available: false };
  },
  sessions: {
    async create(input) {
      const pending = (async () => {
        const { data, error } = await requireSupabase().functions.invoke("start-call-session", {
          body: { code: input.callIdSnapshot, callType: input.callType, caller: input.caller },
        });
        if (error || !data?.sessionId || !data?.sessionToken) throw new Error("Call session could not be recorded.");
        return { sessionId: data.sessionId as string, sessionToken: data.sessionToken as string };
      })();
      cloudSessionCredentials.set(input.id, pending);
      await pending;
    },
    async transition(localSessionId, patch) {
      const credentials = await getCloudCallSessionCredentials(localSessionId);
      if (!credentials) throw new Error("Call session credentials are unavailable.");
      const { error } = await requireSupabase().functions.invoke("update-call-session", {
        body: { ...credentials, status: patch.status, endedAt: patch.endedAt, durationSeconds: patch.durationSeconds, failureCode: patch.failureCode },
      });
      if (error) throw new Error("Call status could not be recorded.");
    },
    async event(localSessionId, type, metadata) {
      const credentials = await getCloudCallSessionCredentials(localSessionId);
      if (!credentials) throw new Error("Call session credentials are unavailable.");
      const { error } = await requireSupabase().functions.invoke("update-call-session", {
        body: { ...credentials, eventType: type, metadata: metadata ?? {} },
      });
      if (error) throw new Error("Call event could not be recorded.");
    },
  },
};

/**
 * The local development backend: the public app resolves Call IDs against the
 * very profiles created in the admin dashboard, from the same IndexedDB engine.
 */
const localBackend: CallBackend = {
  async resolveCallId(code) {
    const profile = await adminRepository.resolveCallId(code);
    if (!profile) return { found: false };

    return {
      found: true,
      host: {
        id: profile.id,
        displayName: profile.displayName,
        shortName: shortName(profile.displayName),
        avatarUrl: profile.avatarDataUrl,
        coverUrl: profile.coverDataUrl,
        shortBio: profile.shortBio,
        followerCount: profile.followerCount,
        likeCount: profile.likeCount,
        remoteVideoRef: profile.remoteVideoAssetId,
        remoteAudioRef: profile.remoteAudioAssetId,
        available: profile.status === "active",
      },
    };
  },

  async startCallSession(code, _callType, _caller) {
    const resolved = await localBackend.resolveCallId(code);
    if (!resolved.found) throw new Error("We couldn't start your call.");
    // Resolving an inactive host is allowed, so the caller can be told who is
    // unavailable. Calling one is not.
    if (resolved.host.available === false) throw new Error("This profile is not available for calls.");
    return { sessionId: `local_${crypto.randomUUID()}`, sessionToken: "local", host: resolved.host };
  },

  async updateCallSession() {},

  async getSessionMedia() {
    return { available: false };
  },

  async getRemoteMedia(host, callType) {
    // An audio call plays the uploaded voice when there is one, and only falls
    // back to the video's soundtrack when there is not.
    const assetId = callType === "audio" && host.remoteAudioRef ? host.remoteAudioRef : host.remoteVideoRef;
    if (!assetId) return { available: false };

    const blob = await adminRepository.getAssetBlob(assetId);
    if (!blob) return { available: false };

    const meta = await adminRepository.getAssetMeta(assetId);
    return { available: true, blob, hasAudio: meta?.hasAudio ?? true };
  },

  sessions: {
    async create(input) {
      await adminRepository.createCallSession(input);
    },
    async transition(sessionId, patch) {
      await adminRepository.updateCallSession(sessionId, patch);
    },
    async event(sessionId, type, metadata) {
      await adminRepository.appendCallEvent({ sessionId, type, metadata });
    },
  },
};

function selectBackend(): CallBackend {
  switch (config.callBackend) {
    case "local":
      return localBackend;
    case "supabase":
      return supabaseBackend;
  }
}

/** Local development and Supabase production paths are selected by configuration. */
export const callBackend: CallBackend = selectBackend();

/** Call logging must never interrupt a call, so failures only reach the console. */
export function logCallSession(work: () => Promise<void> | undefined): void {
  try {
    const result = work();
    if (result) void result.catch((error: unknown) => logDiagnostic("session-log", error));
  } catch (error) {
    logDiagnostic("session-log", error);
  }
}
