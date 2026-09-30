import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  CALLER,
  PROFILE,
  gumCalls,
  instrumentGetUserMedia,
  instrumentPeerConnections,
  rtcStates,
  seedAdminSession,
  seedProfile,
  bringHostOnline,
} from "./support/seed";

/**
 * A real guest browser and a real host browser, calling each other.
 *
 * This is the acceptance test for the video phase. Two isolated contexts, one
 * signalling service between them, and real `RTCPeerConnection`s — no simulated
 * state changes anywhere in the path.
 *
 * The contexts are isolated on purpose. A guest and a host sharing storage or a
 * session would hide precisely the bugs this suite exists to catch.
 */

/** A phone, so the video product rule is satisfied on both sides. */
const PHONE = {
  viewport: { width: 393, height: 852 },
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
} as const;

/**
 * Instrumentation and permissions for one context.
 *
 * The development admin session is granted to both contexts because seeding the
 * profile goes through the admin page that builds the database. The guest
 * navigates away immediately and never uses it again; the two contexts stay
 * fully isolated from each other, which is what actually matters here.
 */
async function prepareContext(context: BrowserContext): Promise<void> {
  await seedAdminSession(context);
  await instrumentPeerConnections(context);
  await instrumentGetUserMedia(context);
  await context.grantPermissions(["camera", "microphone"]);
}

/**
 * Walks the guest from the landing page to a placed call.
 *
 * Follows the existing join dialog exactly: details, Call ID, confirmation. On
 * the live path "Start Call" creates the session and the call route takes over
 * with the availability check.
 */
async function guestDials(page: Page): Promise<void> {
  await page.goto("/connect");

  await page.getByRole("radio", { name: /video call/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();

  await page.getByLabel("Full Name").fill(CALLER.fullName);
  await page.getByLabel("Phone Number").fill(CALLER.phone);
  await page.getByLabel("Email Address").fill(CALLER.email);
  await page.getByRole("button", { name: /^next$/i }).click();

  await page.getByLabel("Call ID").fill(PROFILE.callId);
  await page.getByRole("button", { name: /find profile/i }).click();

  // The profile confirmation, then into the call itself.
  await page.getByRole("button", { name: /start call/i }).click();
}

test.describe("two-party live video call", () => {
  test("guest calls, host answers with Live Camera, both connect, either can hang up", async ({ browser }) => {
    const hostContext = await browser.newContext(PHONE);
    const guestContext = await browser.newContext(PHONE);

    await prepareContext(hostContext);
    await prepareContext(guestContext);

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await seedProfile(hostPage);
      await seedProfile(guestPage);

      /* 1. The host becomes reachable. Registering is not enough — presence is. */
      await bringHostOnline(hostPage);

      /* 2. The guest dials, and the permission screen appears BEFORE any device
            is touched: the Call ID and host availability are checked first. */
      await guestDials(guestPage);

      await expect(guestPage.getByRole("heading", { name: /camera & microphone/i })).toBeVisible();
      expect(await gumCalls(guestPage)).toBe(0);

      await guestPage.getByRole("button", { name: /^continue$/i }).click();

      /* 3. Ringing — driven by signalling, not a timer. */
      await expect(guestPage.getByText(/ringing/i)).toBeVisible();

      /* 4. The host's phone rings, wherever they were in the dashboard. */
      const incoming = hostPage.getByRole("alertdialog");
      await expect(incoming).toBeVisible();
      await expect(incoming.getByText(CALLER.fullName)).toBeVisible();
      await expect(incoming.getByText(/incoming video call/i)).toBeVisible();

      /* 5. Answering opens the source choice rather than starting a camera. */
      await incoming.getByRole("button", { name: /answer/i }).click();

      // The caller stops hearing a ring the moment the call is picked up, even
      // though nothing is connected yet.
      await expect(guestPage.getByText(/connecting/i).first()).toBeVisible();

      await expect(hostPage.getByRole("heading", { name: /choose how you want to appear/i })).toBeVisible();

      /* 6. Live Camera: only now is the host's camera requested. */
      await hostPage.getByRole("button", { name: /live camera/i }).click();

      /* 7. Both peer connections reach `connected`. This is the assertion the
            whole phase exists for — real media between two real browsers. */
      await expect
        .poll(async () => (await rtcStates(guestPage)).includes("connected"), {
          message: "guest RTCPeerConnection never reached connected",
          // Negotiation takes ~20s on an idle machine. The generous ceiling is
          // for a loaded one — the assertion is unchanged: it must reach
          // connected, and a failure here still means it never did.
          timeout: 150_000,
        })
        .toBe(true);

      await expect
        .poll(async () => (await rtcStates(hostPage)).includes("connected"), {
          message: "host RTCPeerConnection never reached connected",
          // Negotiation takes ~20s on an idle machine. The generous ceiling is
          // for a loaded one — the assertion is unchanged: it must reach
          // connected, and a failure here still means it never did.
          timeout: 150_000,
        })
        .toBe(true);

      /* 8. Both are looking at a live call surface with controls. */
      await expect(guestPage.locator(".live-call")).toBeVisible();
      await expect(hostPage.locator(".live-call")).toBeVisible();

      /* 9. The guest hangs up, and the host is told. */
      await guestPage.locator(".call-control.is-end").click();
      await expect(guestPage.getByRole("heading", { name: /call ended/i })).toBeVisible();
      await expect(hostPage.locator(".live-call")).toBeHidden();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("host declines, and the guest is told immediately", async ({ browser }) => {
    const hostContext = await browser.newContext(PHONE);
    const guestContext = await browser.newContext(PHONE);

    await prepareContext(hostContext);
    await prepareContext(guestContext);

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await seedProfile(hostPage);
      await seedProfile(guestPage);
      await bringHostOnline(hostPage);
      await guestDials(guestPage);
      await guestPage.getByRole("button", { name: /^continue$/i }).click();

      const incoming = hostPage.getByRole("alertdialog");
      await expect(incoming).toBeVisible();
      await incoming.getByRole("button", { name: /decline/i }).click();

      await expect(guestPage.getByRole("heading", { name: /call declined/i })).toBeVisible();

      // No peer connection is ever built for a declined call.
      expect(await rtcStates(hostPage)).toHaveLength(0);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("guest cancels while ringing and the host's screen clears", async ({ browser }) => {
    const hostContext = await browser.newContext(PHONE);
    const guestContext = await browser.newContext(PHONE);

    await prepareContext(hostContext);
    await prepareContext(guestContext);

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await seedProfile(hostPage);
      await seedProfile(guestPage);
      await bringHostOnline(hostPage);
      await guestDials(guestPage);
      await guestPage.getByRole("button", { name: /^continue$/i }).click();

      await expect(hostPage.getByRole("alertdialog")).toBeVisible();

      await guestPage.getByRole("button", { name: /cancel/i }).click();

      // The incoming screen must clear at once, and must not come back.
      await expect(hostPage.getByRole("alertdialog")).toBeHidden();
      await hostPage.waitForTimeout(1_500);
      await expect(hostPage.getByRole("alertdialog")).toBeHidden();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("a guest whose host is offline never reaches a camera prompt", async ({ browser }) => {
    // Section 8 and 26: availability is checked before any device is requested.
    const guestContext = await browser.newContext(PHONE);
    await prepareContext(guestContext);
    const guestPage = await guestContext.newPage();

    try {
      // Active and reachable by Call ID, but with no operator online.
      await seedProfile(guestPage);
      await guestDials(guestPage);

      await expect(guestPage.getByRole("heading", { name: /currently unavailable/i })).toBeVisible();
      expect(await gumCalls(guestPage)).toBe(0);
      expect(await rtcStates(guestPage)).toHaveLength(0);
    } finally {
      await guestContext.close();
    }
  });
});

test.describe("desktop device gate", () => {
  test("blocks video before any media or signalling, and offers audio", async ({ browser }) => {
    // Section 114. The assertions that matter are the three counts: no camera,
    // no peer connection, no invitation.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await prepareContext(context);
    const page = await context.newPage();

    try {
      await page.goto("/connect");
      await page.getByRole("radio", { name: /video call/i }).click();

      // The restriction is stated at the point of choosing, not only enforced.
      await expect(page.getByText(/mobile only/i)).toBeVisible();

      await page.getByRole("button", { name: /continue/i }).click();

      await expect(page.getByRole("heading", { name: /video calls are available on mobile/i })).toBeVisible();
      expect(await gumCalls(page)).toBe(0);
      expect(await rtcStates(page)).toHaveLength(0);

      await expect(page.getByRole("button", { name: /copy mobile link/i })).toBeVisible();

      // Audio is still offered, and still works, from this same device.
      await page.getByRole("button", { name: /continue with audio/i }).click();
      await expect(page).toHaveURL(/\/join\/audio/);
    } finally {
      await context.close();
    }
  });

  test("a desktop window narrowed to phone width is still a desktop", async ({ browser }) => {
    // Section 7. Classification reads the physical screen, never the viewport.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await prepareContext(context);
    const page = await context.newPage();

    try {
      await page.goto("/connect");
      await page.getByRole("radio", { name: /video call/i }).click();
      await page.getByRole("button", { name: /continue/i }).click();

      await expect(page.getByRole("heading", { name: /video calls are available on mobile/i })).toBeVisible();
      expect(await gumCalls(page)).toBe(0);
    } finally {
      await context.close();
    }
  });
});
