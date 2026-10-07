import { config } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";
import { getCloudCallSessionCredentials } from "@/services/callBackend";
import { logDiagnostic } from "@/lib/utils";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { localCallEvidenceStore } from "./localStore";
import { sendAdminEvent } from "@/services/notifications/adminEvents";
import type { BeginEvidenceInput, CallEvidence, EvidenceHandle, LocalCallEvidence } from "./types";

type CaptureSaveInput = BeginEvidenceInput & {
  blob: Blob;
  capturedAt: string;
  callStatus: string;
};
type CloudBeginResult = EvidenceHandle & { status?: string; imagePath?: string | null };
const cloudHandles = new Map<string, EvidenceHandle>();
const UPDATED_EVENT = "callastar:call-evidence-updated";
function notifyEvidenceUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPDATED_EVENT));
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke(name, { body });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Call evidence service unavailable.");
  return data as T;
}

function cloudEnabled() { return config.callBackend === "supabase"; }

/** Upload the one captured frame immediately; never persist the image in browser storage. */
async function saveCloudCapture(input: CaptureSaveInput & { width: number; height: number }): Promise<LocalCallEvidence> {
  const credentials = await getCloudCallSessionCredentials(input.callSessionId);
  if (!credentials) throw new Error("Secure call session credentials are unavailable for evidence upload.");
  const handle = await invoke<CloudBeginResult>("begin-call-evidence", {
    ...input,
    callSessionId: credentials.sessionId,
    sessionToken: credentials.sessionToken,
    blob: undefined,
    capturedAt: undefined,
    mimeType: undefined,
  } as unknown as Record<string, unknown>);
  if (handle.status !== "ready") {
    const ticket = await invoke<{ path: string; uploadToken: string; alreadyUploaded?: boolean }>("finish-call-evidence", {
      action: "upload", ...handle, capturedAt: input.capturedAt, mimeType: input.blob.type || "image/jpeg", fileSize: input.blob.size,
    });
    if (!ticket.alreadyUploaded) {
      const { error } = await requireSupabase().storage.from("call-evidence").uploadToSignedUrl(ticket.path, ticket.uploadToken, input.blob, { contentType: input.blob.type || "image/jpeg" });
      if (error) throw error;
    }
    await invoke("finish-call-evidence", { action: "complete", ...handle });
  }
  if (input.endedAt && handle.token) await invoke("finish-call-evidence", { action: "finalize", ...handle, endedAt: input.endedAt, durationSeconds: input.durationSeconds, callStatus: input.callStatus, terminationReason: input.terminationReason });
  cloudHandles.set(input.callSessionId, handle);
  return {
    id: handle.id, callSessionId: input.callSessionId, callerName: input.callerName, callerEmail: input.callerEmail,
    hostId: input.hostId, hostName: input.hostName, packageId: input.packageId, packageName: input.packageName,
    planType: input.planType, callType: "video", capturedAt: input.capturedAt, sessionStartedAt: input.sessionStartedAt,
    answeredAt: input.answeredAt, endedAt: input.endedAt, durationSeconds: input.durationSeconds, callStatus: input.callStatus,
    terminationReason: input.terminationReason, status: "ready", syncStatus: "synced", imagePath: handle.imagePath ?? null,
    cloudEvidenceId: handle.id, cloudStoragePath: handle.imagePath ?? null, width: input.width, height: input.height,
    mimeType: input.blob.type || "image/jpeg", createdAt: new Date().toISOString(), failureReason: null,
    imageBlob: null, callIdSnapshot: input.callId, consentAt: input.consentAt,
  };
}

export const callEvidenceRepository = {
  async saveLocal(input: CaptureSaveInput & { width: number; height: number }): Promise<{ record: LocalCallEvidence; created: boolean }> {
    if (cloudEnabled()) {
      let record: LocalCallEvidence;
      try { record = await saveCloudCapture(input); }
      catch (error) { productionDiagnostic("CALL_EVIDENCE_UPLOAD_FAILED"); throw error; }
      notifyEvidenceUpdated();
      logDiagnostic("CALL_EVIDENCE_CLOUD_SAVED", { recordId: record.id });
      sendAdminEvent("call_evidence_captured", input.callSessionId, `A call evidence screenshot was saved for ${input.hostName}.`);
      return { record, created: true };
    }
    const existing = await localCallEvidenceStore.getBySession(input.callSessionId);
    if (existing) return { record: existing, created: false };
    const record: LocalCallEvidence = {
      id: input.callSessionId,
      callSessionId: input.callSessionId,
      callerName: input.callerName,
      callerEmail: input.callerEmail,
      hostId: input.hostId,
      hostName: input.hostName,
      packageId: input.packageId,
      packageName: input.packageName,
      planType: input.planType,
      callType: "video",
      capturedAt: input.capturedAt,
      sessionStartedAt: input.sessionStartedAt,
      answeredAt: input.answeredAt,
      endedAt: null,
      durationSeconds: null,
      callStatus: input.callStatus,
      terminationReason: null,
      status: "ready",
      syncStatus: cloudEnabled() ? "sync_pending" : "local_only",
      imagePath: null,
      cloudEvidenceId: null,
      cloudStoragePath: null,
      width: input.width,
      height: input.height,
      mimeType: input.blob.type || "image/jpeg",
      createdAt: new Date().toISOString(),
      failureReason: null,
      imageBlob: input.blob,
      callIdSnapshot: input.callId,
      consentAt: input.consentAt,
    };
    const result = await localCallEvidenceStore.saveUnique(record);
    notifyEvidenceUpdated();
    return result;
  },
  async saveCaptureFailure(input: BeginEvidenceInput, reason: string, failureKind: "capture" | "upload" = "capture"): Promise<LocalCallEvidence> {
    if (cloudEnabled()) {
      const credentials = await getCloudCallSessionCredentials(input.callSessionId);
      if (!credentials) throw new Error("Secure call session credentials are unavailable.");
      const handle = await invoke<CloudBeginResult>("begin-call-evidence", { ...input, callSessionId: credentials.sessionId, sessionToken: credentials.sessionToken });
      if (handle.token) await invoke("finish-call-evidence", { action: "failed", ...handle, reason, failureKind });
      return {
        id: handle.id, callSessionId: input.callSessionId, callerName: input.callerName, callerEmail: input.callerEmail,
        hostId: input.hostId, hostName: input.hostName, packageId: input.packageId, packageName: input.packageName,
        planType: input.planType, callType: "video", capturedAt: null, sessionStartedAt: input.sessionStartedAt,
        answeredAt: input.answeredAt, endedAt: input.endedAt, durationSeconds: input.durationSeconds,
        callStatus: input.callStatus, terminationReason: input.terminationReason, status: failureKind === "upload" ? "upload_failed" : "capture_failed", syncStatus: "synced",
        imagePath: null, cloudEvidenceId: handle.id, cloudStoragePath: null, width: null, height: null, mimeType: "image/jpeg",
        createdAt: new Date().toISOString(), failureReason: reason, imageBlob: null, callIdSnapshot: input.callId, consentAt: input.consentAt,
      };
    }
    const existing = await localCallEvidenceStore.getBySession(input.callSessionId);
    if (existing) return existing;
    const record: LocalCallEvidence = {
      id: input.callSessionId, callSessionId: input.callSessionId,
      callerName: input.callerName, callerEmail: input.callerEmail,
      hostId: input.hostId, hostName: input.hostName, packageId: input.packageId, packageName: input.packageName,
      planType: input.planType, callType: "video", capturedAt: null, sessionStartedAt: input.sessionStartedAt, answeredAt: input.answeredAt,
      endedAt: input.endedAt, durationSeconds: input.durationSeconds, callStatus: input.callStatus, terminationReason: input.terminationReason,
      status: failureKind === "upload" ? "upload_failed" : "capture_failed", syncStatus: "local_only", imagePath: null,
      cloudEvidenceId: null, cloudStoragePath: null, width: null, height: null, mimeType: "image/jpeg",
      createdAt: new Date().toISOString(), failureReason: reason, imageBlob: null,
      callIdSnapshot: input.callId, consentAt: input.consentAt,
    };
    const result = await localCallEvidenceStore.saveUnique(record);
    notifyEvidenceUpdated();
    return result.record;
  },
  async finalizeLocal(callSessionId: string, metadata: { endedAt: string; durationSeconds: number | null; callStatus: string; terminationReason: string | null }): Promise<LocalCallEvidence | undefined> {
    if (cloudEnabled()) {
      const handle = cloudHandles.get(callSessionId);
      if (handle?.token) await invoke("finish-call-evidence", { action: "finalize", ...handle, ...metadata });
      return undefined;
    }
    const record = await localCallEvidenceStore.update(callSessionId, metadata);
    if (record) notifyEvidenceUpdated();
    const handle = cloudHandles.get(callSessionId);
    if (record && handle && cloudEnabled()) {
      void invoke("finish-call-evidence", {
        action: "finalize", ...handle, ...metadata,
      }).then(() => cloudHandles.delete(callSessionId)).catch((error) => logDiagnostic("CALL_EVIDENCE_CLOUD_FINALIZE_FAILED", error));
    }
    return record;
  },
  async list(hostId?: string, _options: { retrySync?: boolean } = {}): Promise<CallEvidence[]> {
    if (cloudEnabled()) {
      const remote = (await invoke<{ evidence: CallEvidence[] }>("admin-call-evidence", { action: "list", hostId })).evidence;
      return remote;
    }
    return (await localCallEvidenceStore.list()).filter((row) => !hostId || row.hostId === hostId);
  },
  async imageUrl(id: string): Promise<string> {
    if (cloudEnabled()) return (await invoke<{ url: string }>("admin-call-evidence", { action: "view", id })).url;
    const local = await localCallEvidenceStore.get(id);
    if (local?.imageBlob && local.status === "ready") return URL.createObjectURL(local.imageBlob);
    throw new Error(local?.failureReason ?? "Evidence image unavailable.");
  },
};
