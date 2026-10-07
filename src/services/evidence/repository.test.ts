import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, cloudRows, config, invoke, getCloudCredentials } = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  cloudRows: [] as any[],
  getCloudCredentials: vi.fn(async () => ({ sessionId: "backend-session-uuid", sessionToken: "session-token-opaque-value-long-enough-to-be-valid" })),
  config: { callBackend: "local" as "local" | "supabase", adminDataMode: "local" as "local" | "supabase" },
  invoke: vi.fn(async (name: string, options: any) => {
    const body = options?.body ?? {};
    if (name === "begin-call-evidence") return { data: { id: "cloud-evidence-1", token: "capture-token" }, error: null };
    if (name === "finish-call-evidence" && body.action === "upload") return { data: { path: "host-1/cs_trialtest01/evidence.jpg", uploadToken: "upload-token" }, error: null };
    if (name === "finish-call-evidence" && body.action === "complete") {
      cloudRows.splice(0, cloudRows.length, {
        id: "cloud-evidence-1", callSessionId: "cs_trialtest01", callerName: "Taylor", callerEmail: "taylor@example.com",
        hostId: "host-1", hostName: "Jordan Lee", packageId: null, packageName: null, planType: "free_trial", callType: "video",
        capturedAt: "2026-10-06T10:00:02Z", sessionStartedAt: "2026-10-06T10:00:00Z", answeredAt: "2026-10-06T10:00:01Z",
        endedAt: null, durationSeconds: null, callStatus: "active", terminationReason: null, status: "ready", syncStatus: "synced",
        imagePath: "host-1/cs_trialtest01/evidence.jpg", cloudEvidenceId: "cloud-evidence-1", cloudStoragePath: "host-1/cs_trialtest01/evidence.jpg",
        width: 640, height: 360, mimeType: "image/jpeg", createdAt: "2026-10-06T10:00:02Z", failureReason: null,
      });
      return { data: { status: "ready" }, error: null };
    }
    if (name === "admin-call-evidence" && body.action === "list") return { data: { evidence: cloudRows }, error: null };
    if (name === "admin-call-evidence" && body.action === "view") return { data: { url: "https://storage.test/signed.jpg" }, error: null };
    return { data: {}, error: null };
  }),
}));

vi.mock("@/lib/config", () => ({ config }));
vi.mock("@/lib/supabase/client", () => ({ requireSupabase: () => ({ functions: { invoke }, storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) } }) }));
vi.mock("@/services/callBackend", () => ({ getCloudCallSessionCredentials: getCloudCredentials }));
vi.mock("@/services/notifications/adminEvents", () => ({ sendAdminEvent: vi.fn() }));
vi.mock("./localStore", () => ({
  localCallEvidenceStore: {
    getBySession: async (id: string) => rows.get(id),
    get: async (id: string) => rows.get(id),
    saveUnique: async (record: any) => {
      const existing = rows.get(record.callSessionId);
      if (existing) return { record: existing, created: false };
      rows.set(record.callSessionId, record);
      return { record, created: true };
    },
    update: async (id: string, patch: any) => {
      const existing = rows.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      rows.set(id, updated);
      return updated;
    },
    list: async () => [...rows.values()],
  },
}));

import { callEvidenceRepository } from "./repository";
import type { BeginEvidenceInput } from "./types";

const input: BeginEvidenceInput = {
  callSessionId: "cs_trialtest01", callId: "CALL-ID", hostId: "host-1", hostName: "Jordan Lee",
  callerName: "Taylor", callerEmail: "taylor@example.com", consentAt: null,
  sessionStartedAt: "2026-10-06T10:00:00Z", answeredAt: "2026-10-06T10:00:01Z",
  packageId: null, packageName: null, planType: "free_trial", width: 640, height: 360,
  endedAt: null, durationSeconds: null, callStatus: "active", terminationReason: null,
};

describe("call evidence persistence", () => {
  beforeEach(() => {
    rows.clear(); cloudRows.splice(0); invoke.mockClear();
    config.callBackend = "local"; config.adminDataMode = "local";
  });

  it("saves a local-development screenshot once per call session", async () => {
    const blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    const first = await callEvidenceRepository.saveLocal({ ...input, blob, capturedAt: "2026-10-06T10:00:02Z", width: 640, height: 360 });
    const second = await callEvidenceRepository.saveLocal({ ...input, blob, capturedAt: "2026-10-06T10:00:03Z", width: 640, height: 360 });
    expect(first.created).toBe(true); expect(second.created).toBe(false);
    expect(second.record.imageBlob).toBe(blob); expect(rows.size).toBe(1);
  });

  it("uploads screenshots directly to Supabase without storing image bytes in IndexedDB", async () => {
    config.callBackend = "supabase"; config.adminDataMode = "supabase";
    const blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    const saved = await callEvidenceRepository.saveLocal({ ...input, blob, capturedAt: "2026-10-06T10:00:02Z", width: 640, height: 360 });
    expect(saved.record.imageBlob).toBeNull(); expect(rows.size).toBe(0);
    expect(invoke).toHaveBeenCalledWith("begin-call-evidence", expect.objectContaining({ body: expect.objectContaining({ callSessionId: "backend-session-uuid", sessionToken: "session-token-opaque-value-long-enough-to-be-valid" }) }));
    const adminRows = await callEvidenceRepository.list();
    expect(adminRows).toHaveLength(1); expect(adminRows[0].syncStatus).toBe("synced");
    expect(await callEvidenceRepository.imageUrl(adminRows[0].id)).toBe("https://storage.test/signed.jpg");
  });

  it("updates local-development evidence with call-end duration", async () => {
    const blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    await callEvidenceRepository.saveLocal({ ...input, blob, capturedAt: "2026-10-06T10:00:02Z", width: 640, height: 360 });
    await callEvidenceRepository.finalizeLocal(input.callSessionId, { endedAt: "2026-10-06T10:00:12Z", durationSeconds: 11, callStatus: "ended", terminationReason: "hangup" });
    expect(rows.size).toBe(1); expect(rows.get(input.callSessionId).durationSeconds).toBe(11);
  });
});
