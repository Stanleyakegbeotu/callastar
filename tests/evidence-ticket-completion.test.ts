import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  insert: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/utils.ts", () => ({
  corsHeaders: {},
  hash: async (value: string) => `hash:${value}`,
  normalizeCode: (value: string) => value.replace(/[^A-Z0-9]/g, ""),
  randomToken: () => "capture-proof",
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  serviceClient: () => ({
    from: (table: string) => {
      const filters = new Map<string, unknown>();
      let inserting = false;
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.set(column, value); return query; },
        insert: (body: unknown) => { inserting = true; fixture.insert(body); return query; },
        maybeSingle: async () => {
          if (table === "call_sessions") return { data: filters.get("session_token_hash") === `hash:${"proof".repeat(10)}` ? fixture.session : null };
          if (table === "call_ids") {
            const ticket: Record<string, unknown> = { id: "original-ticket", host_id: "host", status: "exhausted",
              code_hash: "hash:CSOLDTESTCODE", host: { display_name: "Host", status: "active" } };
            return { data: [...filters].every(([column, value]) => ticket[column] === value) ? ticket : null };
          }
          return { data: inserting ? { id: "private-evidence" } : null, error: null };
        },
      };
      return query;
    },
  }),
}));

let handle: (request: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal("Deno", { serve: (handler: typeof handle) => { handle = handler; } });
  await import("../supabase/functions/begin-call-evidence/index.ts");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  fixture.insert.mockClear();
  fixture.session = {
    id: "52f36694-5bfe-48fb-b80b-8bff31574b94", host_id: "host", call_id_id: "original-ticket",
    call_type: "video", status: "ended", connected_at: "2026-10-20T10:00:00Z",
    created_at: "2026-10-20T09:59:00Z", visitor_name: "Caller", visitor_email: "caller@example.test",
  };
});
const request = (patch: Record<string, unknown> = {}) => handle(new Request("https://edge.test/begin-call-evidence", {
  method: "POST", body: JSON.stringify({
    callSessionId: fixture.session.id, sessionToken: "proof".repeat(10), hostId: "host", callId: "CS-OLD-TEST-CODE",
    sessionStartedAt: "2026-10-20T09:59:00Z", answeredAt: "2026-10-20T10:00:00Z", ...patch,
  }),
}));

it("allows late evidence for the authenticated completed session after its ticket rotates", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe("private-evidence");
  expect(fixture.insert).toHaveBeenCalledOnce();
});
it("does not attach evidence to another ticket, including the new rotated ID", async () => {
  fixture.session.call_id_id = "replacement-ticket";
  expect((await request()).status).toBe(404);
  expect(fixture.insert).not.toHaveBeenCalled();
});
it("requires the original session proof even when the old Call ID is known", async () => {
  expect((await request({ sessionToken: "wrong".repeat(10) })).status).toBe(404);
  expect(fixture.insert).not.toHaveBeenCalled();
});
it("rejects a terminal attempt that never reached active playback", async () => {
  fixture.session.connected_at = null;
  expect((await request()).status).toBe(404);
  expect(fixture.insert).not.toHaveBeenCalled();
});
