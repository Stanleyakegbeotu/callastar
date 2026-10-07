export type EvidenceSyncStatus = "local_only" | "sync_pending" | "synced" | "sync_failed";
export type EvidenceStatus = "ready" | "pending" | "capture_failed";
export type EvidencePlanType = "free_trial" | "plus" | "pro" | "subscription";

export interface CallEvidence {
  id: string;
  callSessionId: string;
  callerName: string;
  callerEmail: string;
  hostId: string;
  hostName: string;
  packageId: string | null;
  packageName: string | null;
  planType: EvidencePlanType;
  callType: "video";
  capturedAt: string | null;
  sessionStartedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  callStatus: string;
  terminationReason: string | null;
  status: EvidenceStatus;
  syncStatus: EvidenceSyncStatus;
  imagePath: string | null;
  cloudEvidenceId: string | null;
  cloudStoragePath: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  createdAt: string;
  failureReason: string | null;
  thumbnailUrl?: string | null;
}

export interface LocalCallEvidence extends CallEvidence {
  imageBlob: Blob | null;
  callIdSnapshot: string;
  consentAt: string | null;
}

export interface BeginEvidenceInput {
  callSessionId: string;
  callId: string;
  hostId: string;
  hostName: string;
  callerName: string;
  callerEmail: string;
  consentAt: string | null;
  sessionStartedAt: string;
  answeredAt: string;
  packageId: string | null;
  packageName: string | null;
  planType: EvidencePlanType;
  width: number;
  height: number;
  endedAt: string | null;
  durationSeconds: number | null;
  callStatus: string;
  terminationReason: string | null;
}

export interface EvidenceHandle { id: string; token: string }
