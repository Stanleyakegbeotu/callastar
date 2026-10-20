import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  queries: [] as [string, string, unknown][],
  assetInterruptions: [{ startMs: 1500, endMs: 2800, type: "connection" }],
  sign: vi.fn(async () => ({ data: { signedUrl: "https://private.test/signed-video" }, error: null })),
}));

vi.mock("../supabase/functions/_shared/utils.ts", () => ({
  corsHeaders: {},
  hash: async () => "token-hash",
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  serviceClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { fixture.queries.push([table, column, value]); return query; },
        maybeSingle: async () => ({
          data: table === "call_sessions" ? fixture.session : {
            storage_path: "private/video.mp4",
            has_audio: true,
            ...(table === "host_assets" ? { interruptions: fixture.assetInterruptions } : {}),
          },
          error: null,
        }),
      };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: fixture.sign }) },
  }),
}));

let handle: (request: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal("Deno", { serve: (handler: typeof handle) => { handle = handler; } });
  await import("../supabase/functions/get-session-media/index.ts");
});
afterEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  fixture.queries = [];
  fixture.assetInterruptions = [{ startMs: 1500, endMs: 2800, type: "connection" }];
  fixture.session = {
    host_id: "host", status: "connecting", call_type: "video", mode_at_start: "free",
    ticket_reserved_until: new Date(Date.now() + 60000).toISOString(), ticket_consumed_at: null,
  };
});

const requestMedia = () => handle(new Request("https://edge.test/get-session-media", {
  method: "POST", body: JSON.stringify({ sessionId: "session", sessionToken: "secret" }),
}));

it("does not disclose private source media for an expired unused ticket reservation", async () => {
  fixture.session.ticket_reserved_until = new Date(Date.now() - 1000).toISOString();
  const response = await requestMedia();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "CALL_ID_RESERVATION_CONFLICT" });
  expect(fixture.sign).not.toHaveBeenCalled();
});

it("allows the current reservation to load its source before a use is consumed", async () => {
  const response = await requestMedia();
  expect(response.status).toBe(200);
  expect((await response.json()).media.url).toBe("https://private.test/signed-video");
  expect(fixture.sign).toHaveBeenCalledOnce();
});

it("keeps a consumed active call's source available after the original ticket expires or rotates", async () => {
  fixture.session.status = "active";
  fixture.session.ticket_reserved_until = new Date(Date.now() - 1000).toISOString();
  fixture.session.ticket_consumed_at = new Date().toISOString();
  expect((await requestMedia()).status).toBe(200);
  expect(fixture.sign).toHaveBeenCalledOnce();
});

it("does not renew source access for a terminal session", async () => {
  fixture.session.status = "ended";
  expect((await requestMedia()).status).toBe(404);
  expect(fixture.sign).not.toHaveBeenCalled();
});

it("loads the source snapshotted on the reservation rather than the current profile video", async () => {
  fixture.session.delivery_kind = "source_video";
  fixture.session.source_asset_id = "reserved-source";
  const response = await requestMedia();
  expect(response.status).toBe(200);
  expect((await response.json()).media.interruptions).toEqual(fixture.assetInterruptions);
  expect(fixture.queries).toContainEqual(["host_assets", "id", "reserved-source"]);
  expect(fixture.queries.some(([table]) => table === "host_media")).toBe(false);
});

it("loads the interruption timeline for an uploaded source selected during a live call", async () => {
  fixture.session.delivery_kind = "live";
  const response = await requestMedia();
  expect(response.status).toBe(200);
  expect((await response.json()).media.interruptions).toEqual(fixture.assetInterruptions);
  expect(fixture.queries).toContainEqual(["host_media", "kind", "remote_video"]);
  expect(fixture.queries).toContainEqual(["host_assets", "storage_path", "private/video.mp4"]);
});
