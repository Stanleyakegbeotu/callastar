import type { LocalCallEvidence } from "./types";

/** Volatile development fallback; screenshots are deliberately lost on reload. */
const evidence = new Map<string, LocalCallEvidence>();

export const localCallEvidenceStore = {
  async getBySession(callSessionId: string): Promise<LocalCallEvidence | undefined> {
    return [...evidence.values()].find((record) => record.callSessionId === callSessionId);
  },
  async get(id: string): Promise<LocalCallEvidence | undefined> {
    return evidence.get(id);
  },
  async saveUnique(record: LocalCallEvidence): Promise<{ record: LocalCallEvidence; created: boolean }> {
    const existing = await this.getBySession(record.callSessionId);
    if (existing) return { record: existing, created: false };
    evidence.set(record.id, record);
    return { record, created: true };
  },
  async update(callSessionId: string, patch: Partial<LocalCallEvidence>): Promise<LocalCallEvidence | undefined> {
    const existing = await this.getBySession(callSessionId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    evidence.set(existing.id, updated);
    return updated;
  },
  async list(): Promise<LocalCallEvidence[]> {
    return [...evidence.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
};
