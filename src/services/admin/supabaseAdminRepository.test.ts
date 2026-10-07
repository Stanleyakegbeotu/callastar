import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  hosts: [] as any[], assets: [] as any[], uploads: [] as string[], removed: [] as string[],
  reads: [] as string[], inFlight: 0, maxInFlight: 0, failUpload: false, failCommit: false,
}));
vi.mock("@/lib/supabase/client", () => ({ requireSupabase: () => ({
  functions: { invoke: async (name: string) => ({ data: name === "generate-call-id" ? { id: "code-id", code: "CS-AAAA-BBBB-CCCC" } : { callIds: [] }, error: null }) },
  storage: { from: () => ({
    upload: async (path: string) => {
      state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10)); state.inFlight--;
      if (state.failUpload && path.includes("cover")) return { error: new Error("upload failed") };
      state.uploads.push(path); return { error: null };
    },
    remove: async (paths: string[]) => { state.removed.push(...paths); return { error: null }; },
  }) },
  rpc: async () => ({ error: state.failCommit ? new Error("commit failed") : null }),
  from: (table: string) => {
    let op = "read"; let values: any; let filter: [string, any] | undefined;
    const run = () => {
      const rows = table === "hosts" ? state.hosts : state.assets;
      if (op === "insert") { const row = { id: values.id ?? "new-host", created_at: "2026-10-07", updated_at: "2026-10-07", ...values }; rows.push(row); return { data: row, error: null }; }
      if (op === "delete") { rows.splice(0, rows.length, ...rows.filter((r) => filter && r[filter[0]] !== filter[1])); return { data: null, error: null }; }
      state.reads.push(table);
      const data = rows.filter((r) => !filter || (Array.isArray(filter[1]) ? filter[1].includes(r[filter[0]]) : r[filter[0]] === filter[1]));
      return { data, error: null };
    };
    const q: any = {
      insert: (v: any) => { op = "insert"; values = v; return q; },
      delete: () => { op = "delete"; return q; }, select: () => q, order: () => q,
      eq: (k: string, v: any) => { filter = [k, v]; return q; }, in: (k: string, v: any) => { filter = [k, v]; return q; },
      single: async () => { const result = run(); return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }; },
      maybeSingle: async () => { const result = run(); return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }; },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    }; return q;
  },
}) }));
import { supabaseAdminRepository } from "./supabaseAdminRepository";
beforeEach(() => {
  Object.assign(state, { hosts: [], assets: [], uploads: [], removed: [], reads: [], inFlight: 0, maxInFlight: 0, failUpload: false, failCommit: false });
});
const png = () => new File([new Uint8Array([137,80,78,71,13,10,26,10])], "image.png", { type: "image/png" });
describe("remote profile creation and media consistency", () => {
  it("uploads independent files together, commits once and reads the final profile once", async () => {
    const stages: string[] = [];
    const profile = await supabaseAdminRepository.createProfile({ displayName: "Test Host", shortBio: "", status: "active", avatarFile: png(), coverFile: png(), onProgress: (stage) => stages.push(stage) });
    expect(profile.id).toBe("new-host"); expect(state.maxInFlight).toBe(2);
    expect(state.reads.filter((t) => t === "hosts")).toHaveLength(1);
    expect(state.hosts).toHaveLength(1); expect(state.assets).toHaveLength(2);
    expect(stages).toEqual(["Creating profile…", "Uploading media…", "Finalizing…"]);
  });
  it("settles outstanding uploads before removing a failed new profile and its files", async () => {
    state.failUpload = true;
    await expect(supabaseAdminRepository.createProfile({ displayName: "Test Host", shortBio: "", status: "active", avatarFile: png(), coverFile: png() })).rejects.toThrow("upload failed");
    expect(state.inFlight).toBe(0); expect(state.hosts).toHaveLength(0);
    expect(state.removed).toEqual(state.uploads);
  });
  it("keeps the old profile reference when a replacement cannot commit", async () => {
    state.hosts.push({ id: "existing", avatar_path: "old/avatar.jpg" }); state.failCommit = true;
    await expect(supabaseAdminRepository.setAvatar("existing", png())).rejects.toThrow("previous source is unchanged");
    expect(state.hosts[0].avatar_path).toBe("old/avatar.jpg"); expect(state.removed).toEqual(state.uploads);
  });
  it("loads all Media metadata in a single query and accepts missing assets", async () => {
    state.hosts.push({ id: "one", display_name: "First", remote_video_asset_id: "video1" }, { id: "two", display_name: "Second", remote_video_asset_id: "gone" });
    state.assets.push({ id: "video1", host_id: "one", kind: "remote_video", file_size_bytes: 10 });
    const rows = await supabaseAdminRepository.listRemoteVideos();
    expect(rows[0].video?.id).toBe("video1"); expect(rows[1].video).toBeNull();
    expect(state.reads.filter((table) => table === "host_assets")).toHaveLength(1);
  });
});
