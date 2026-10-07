import { expect, test, type Page } from "@playwright/test";
const hostId = "7e676a23-ce9c-400b-bc81-28ef625a1378";
const adminId = "52f36694-5bfe-48fb-b80b-8bff31574b94";
const host = { id: hostId, display_name: "Stability Test Host", short_bio: "Test profile", status: "active", created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:00:00Z", remote_video_asset_id: null, avatar_path: null, cover_path: null };
async function setup(page: Page, media = false) {
  await page.addInitScript(({ adminId }) => {
    const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const user = { id: adminId, aud: "authenticated", role: "authenticated", email: "qa@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-10-07T10:00:00Z" };
    const expires = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: adminId, exp: expires, role: "authenticated" })}.fixture`, refresh_token: "fixture-refresh", token_type: "bearer", expires_at: expires, expires_in: 3600, user }));
  }, { adminId });
  await page.route("**/auth/v1/user", (r) => r.fulfill({ json: { id: adminId, email: "qa@example.test" } }));
  await page.route("**/rest/v1/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    const data = path.endsWith("/hosts") ? [{ ...host, remote_video_asset_id: media ? "video-asset" : null }]
      : path.endsWith("/admin_profiles") ? [{ user_id: adminId, role: "admin", is_active: true, display_name: "QA" }]
      : path.endsWith("/host_assets") && media ? [{ id: "video-asset", host_id: hostId, kind: "remote_video", storage_path: "host/source/video.mp4", file_name: "video.mp4", file_size_bytes: 10, mime_type: "video/mp4", created_at: host.created_at, updated_at: host.updated_at }]
      : [];
    return r.fulfill({ json: data, headers: { "Content-Range": "0-0/0" } });
  });
  await page.route("**/functions/v1/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    return r.fulfill({ json: path.endsWith("admin-call-ids") ? { callIds: [{ hostId, id: "code-1", code: "CS-AAAA-BBBB-CCCC" }] } : path.endsWith("admin-call-evidence") ? { evidence: [] } : { settings: {}, grants: [] } });
  });
}
test("production Admin View/Edit/Media, deep link, reload and history remain usable", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await page.goto("/admin/profiles");
  const card = page.locator(".availability-card").first();
  await card.getByRole("link", { name: "View", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stability Test Host", exact: true }).first()).toBeVisible();
  await page.goBack();
  await card.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit profile", exact: true })).toBeVisible();
  await page.goBack();
  await card.getByRole("link", { name: "Media", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/profiles/${hostId}/media$`));
  await expect(page.getByRole("heading", { name: "Remote call video", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Remote call video", exact: true })).toBeVisible();
  await page.goBack(); await expect(card).toBeVisible();
  await page.goForward(); await expect(page.getByRole("heading", { name: "Remote call video", exact: true })).toBeVisible();
  await page.goto(`/admin/profiles/${hostId}/media`);
  await expect(page.getByRole("heading", { name: "Remote call video", exact: true })).toBeVisible();
  await page.goto("/admin/call-evidence"); await expect(page).toHaveURL(/\/admin\/evidence$/);
  await expect(page.getByRole("heading", { name: "Call evidence", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("missing media and failed queries offer clear states and retry", async ({ page }) => {
  await setup(page);
  // Media lists profiles with missing slots, and an empty database has its own state.
  await page.route("**/rest/v1/hosts?**", (r) => r.fulfill({ json: [] }));
  await page.goto("/admin/media");
  await expect(page.getByText("No media added yet.", { exact: true })).toBeVisible();
  await page.route("**/rest/v1/hosts?**", (r) => r.fulfill({ status: 503, json: { message: "unavailable" } }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.route("**/rest/v1/hosts?**", (r) => r.fulfill({ json: [] }));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No media added yet.", { exact: true })).toBeVisible();
});
test("private streaming preview retries with a new signature after media failure", async ({ page }) => {
  await setup(page, true); let signatures = 0;
  await page.route("**/storage/v1/object/sign/host-call-media/host/source/video.mp4", (r) => {
    if (r.request().method() === "POST") {
      signatures++; return r.fulfill({ json: { signedURL: `/object/sign/host-call-media/host/source/video.mp4?token=fixture-${signatures}` } });
    }
    return r.fulfill({ status: 500, body: "unavailable" });
  });
  await page.route("**/storage/v1/object/sign/host-call-media/host/source/video.mp4?**", (r) => r.fulfill({ status: 500, body: "unavailable" }));
  await page.goto(`/admin/profiles/${hostId}/media`);
  await expect(page.getByText("Media could not be loaded. Please retry.")).toBeVisible();
  expect(signatures).toBe(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => signatures).toBe(2);
});
