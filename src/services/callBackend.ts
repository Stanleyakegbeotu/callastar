import { normalizeCallId } from "@/lib/callId";
import { config } from "@/lib/config";
import { DEMO_CALL_ID, MOCK_HOST } from "@/lib/constants";
import { requireSupabase } from "@/lib/supabase/client";
import { logDiagnostic } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
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
        shortBio: data.host.shortBio,
      },
    };
  },
  async startCallSession(code, callType, caller) {
    const { data, error } = await requireSupabase().functions.invoke("start-call-session", {
      body: { code, callType, caller },
    });
    if (error || !data?.sessionId || !data?.sessionToken) throw new Error("We couldn't start your call.");
    return {
      sessionId: data.sessionId,
      sessionToken: data.sessionToken,
      host: {
        id: data.host.id,
        displayName: data.host.displayName,
        shortName: shortName(data.host.displayName),
        avatarUrl: data.host.avatarUrl ?? "",
      },
    };
  },
  async updateCallSession(credentials, status) {
    const { error } = await requireSupabase().functions.invoke("update-call-session", {
      body: { ...credentials, status },
    });
    if (error) throw new Error("Unable to update call status.");
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
        shortBio: profile.shortBio,
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

const mockBackend: CallBackend = {
  async resolveCallId(code) {
    return normalizeCallId(code) === normalizeCallId(DEMO_CALL_ID) ? { found: true, host: MOCK_HOST } : { found: false };
  },
  async startCallSession() {
    return { sessionId: `mock_${crypto.randomUUID()}`, sessionToken: crypto.randomUUID(), host: MOCK_HOST };
  },
  async updateCallSession() {},
  async getSessionMedia() {
    return { available: false };
  },
  async getRemoteMedia() {
    return { available: false };
  },
};

function selectBackend(): CallBackend {
  switch (config.callBackend) {
    case "local":
      return localBackend;
    case "mock":
      return mockBackend;
    case "supabase":
      return supabaseBackend;
  }
}

/** Mock and local are deliberately opt-in, never a fallback when Supabase fails. */
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
