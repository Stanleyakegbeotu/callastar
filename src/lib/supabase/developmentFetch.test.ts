import { expect, it, vi } from "vitest";
import { developmentSupabaseFetch } from "./developmentFetch";

const project = "https://project.supabase.co";
const page = "http://localhost:8443";
it("proxies this project's functions without changing authorization or request options", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  const request = developmentSupabaseFetch(project, page, fetcher);
  const init = { method: "POST", headers: { authorization: "Bearer user-session", apikey: "public-key" }, body: "{}" };
  await request(`${project}/functions/v1/admin-call-ids?test=1`, init);
  expect(fetcher).toHaveBeenCalledWith(`${page}/__supabase/functions/v1/admin-call-ids?test=1`, init);
});
it("preserves a Request object's method, headers and body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  const request = developmentSupabaseFetch(project, page, fetcher);
  await request(new Request(`${project}/functions/v1/admin-call-ids`, {
    method: "POST", headers: { authorization: "Bearer user-session" }, body: '{"hostIds":[]}',
  }));
  const proxied = fetcher.mock.calls[0][0] as unknown as Request;
  expect(proxied.url).toBe(`${page}/__supabase/functions/v1/admin-call-ids`);
  expect(proxied.method).toBe("POST");
  expect(proxied.headers.get("authorization")).toBe("Bearer user-session");
  expect(await proxied.text()).toBe('{"hostIds":[]}');
});
it.each([
  `${project}/rest/v1/hosts`, `${project}/auth/v1/user`, `${project}/storage/v1/object/private`,
  "https://other.supabase.co/functions/v1/admin-call-ids",
])("leaves unrelated requests unchanged: %s", async url => {
  const fetcher = vi.fn(async () => new Response("{}"));
  await developmentSupabaseFetch(project, page, fetcher)(url);
  expect(fetcher).toHaveBeenCalledWith(url, undefined);
});
it("does not proxy already same-origin function fixtures", async () => {
  const fetcher = vi.fn(async () => new Response("{}"));
  const url = `${page}/functions/v1/admin-call-ids`;
  await developmentSupabaseFetch(page, page, fetcher)(url);
  expect(fetcher).toHaveBeenCalledWith(url, undefined);
});
