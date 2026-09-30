import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  AUDIO_PROFILE,
  CALLER,
  gumCalls,
  instrumentGetUserMedia,
  instrumentPeerConnections,
  rtcStates,
  seedAdminSession,
  seedProfile,
  bringHostOnline,
} from "./support/seed";

/**
 * Audio calling, between two desktop browsers.
 *
 * Desktop on both sides on purpose: audio is explicitly a cross-device product,
 * and the video suite already covers phones. The two assertions that matter most
 * are negative ones — no camera is ever requested, and no video track is ever
 * published — because the easy way to implement audio is to build a video call
 * and hide the picture, and that would leak a camera indicator.
 */

const DESKTOP = {
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
} as const;

/**
 * Records the constraints every `getUserMedia` call asked for, and what the
 * peer connection ended up sending.
 */
async function instrumentMediaDetail(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const store = window as unknown as {
      __gumConstraints: string[];
      __senderKinds: string[];
    };
    store.__gumConstraints = [];
    store.__senderKinds = [];

    const devices = navigator.mediaDevices;
    if (devices?.getUserMedia) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
        store.__gumConstraints.push(JSON.stringify(constraints ?? {}));
        return original(constraints);
      };
    }

    const Original = window.RTCPeerConnection;
    if (!Original) return;
    const originalAddTrack = Original.prototype.addTrack;
    Original.prototype.addTrack = function patched(
      this: RTCPeerConnection,
      track: MediaStreamTrack,
      ...streams: MediaStream[]
    ) {
      store.__senderKinds.push(track.kind);
      return originalAddTrack.call(this, track, ...streams);
    };
  });
}

async function mediaDetail(page: Page): Promise<{ constraints: string[]; senderKinds: string[] }> {
  return page.evaluate(() => {
    const store = window as unknown as { __gumConstraints?: string[]; __senderKinds?: string[] };
    return { constraints: store.__gumConstraints ?? [], senderKinds: store.__senderKinds ?? [] };
  });
}

async function prepareContext(context: BrowserContext): Promise<void> {
  await seedAdminSession(context);
  await instrumentPeerConnections(context);
  await instrumentGetUserMedia(context);
  await instrumentMediaDetail(context);
  // Only the microphone is granted. A camera request would therefore also be
  // visible as a failure, not merely as a counter.
  await context.grantPermissions(["microphone"]);
}

async function guestDialsAudio(page: Page): Promise<void> {
  await page.goto("/connect");

  await page.getByRole("radio", { name: /audio call/i }).click();
  // Audio says it works on desktop too, right on the card.
  await expect(page.getByText(/mobile & desktop/i)).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();

  await page.getByLabel("Full Name").fill(CALLER.fullName);
  await page.getByLabel("Phone Number").fill(CALLER.phone);
  await page.getByLabel("Email Address").fill(CALLER.email);
  await page.getByRole("button", { name: /^next$/i }).click();

  await page.getByLabel("Call ID").fill(AUDIO_PROFILE.callId);
  await page.getByRole("button", { name: /find profile/i }).click();
  await page.getByRole("button", { name: /start call/i }).click();
}

test.describe("two-party audio call", () => {
  test("desktop guest and desktop host connect over real WebRTC audio, with no camera", async ({ browser }) => {
    const hostContext = await browser.newContext(DESKTOP);
    const guestContext = await browser.newContext(DESKTOP);

    await prepareContext(hostContext);
    await prepareContext(guestContext);

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await seedProfile(hostPage, AUDIO_PROFILE);
      await seedProfile(guestPage, AUDIO_PROFILE);
      await bringHostOnline(hostPage, AUDIO_PROFILE);

      /* 1. A desktop guest chooses Audio and is NOT shown the video gate. */
      await guestDialsAudio(guestPage);
      await expect(guestPage.getByRole("heading", { name: /video calls are available on mobile/i })).toBeHidden();

      /* 2. The microphone is explained, and only the microphone. */
      await expect(guestPage.getByRole("heading", { name: /^microphone$/i })).toBeVisible();
      expect(await gumCalls(guestPage)).toBe(0);
      await guestPage.getByRole("button", { name: /^continue$/i }).click();

      /* 3. Ringing, then a real incoming AUDIO call on the host. */
      await expect(guestPage.getByText(/ringing/i)).toBeVisible();

      const incoming = hostPage.getByRole("alertdialog");
      await expect(incoming).toBeVisible();
      await expect(incoming.getByText(/incoming audio call/i)).toBeVisible();
      await expect(incoming.getByText(CALLER.fullName)).toBeVisible();

      /* 4. A desktop host CAN answer audio — no "answer on mobile" anywhere. */
      await expect(hostPage.getByText(/answer on mobile/i)).toBeHidden();
      await incoming.getByRole("button", { name: /answer/i }).click();

      /* 5. No source sheet: an audio call has nothing to choose. */
      await expect(hostPage.getByRole("heading", { name: /choose how you want to appear/i })).toBeHidden();

      /* 6. Both peer connections reach connected. */
      await expect
        .poll(async () => (await rtcStates(guestPage)).includes("connected"), {
          message: "guest audio RTCPeerConnection never reached connected",
          // Matched to the video suite: negotiation is quick on an idle machine
          // and slow on a loaded one. The assertion is unchanged — it must
          // reach connected.
          timeout: 150_000,
        })
        .toBe(true);

      await expect
        .poll(async () => (await rtcStates(hostPage)).includes("connected"), {
          message: "host audio RTCPeerConnection never reached connected",
          // Matched to the video suite: negotiation is quick on an idle machine
          // and slow on a loaded one. The assertion is unchanged — it must
          // reach connected.
          timeout: 150_000,
        })
        .toBe(true);

      /* 7. Both are on the audio surface, not a video canvas. */
      await expect(guestPage.locator(".audio-call")).toBeVisible();
      await expect(hostPage.locator(".audio-call")).toBeVisible();
      await expect(guestPage.locator(".live-call")).toBeHidden();

      /* 8. The assertions that matter: audio only, on both sides. */
      for (const [label, page] of [
        ["guest", guestPage],
        ["host", hostPage],
      ] as const) {
        const detail = await mediaDetail(page);
        expect(detail.constraints.length, `${label} should have asked for media once`).toBeGreaterThan(0);
        for (const constraints of detail.constraints) {
          // `video: false` is fine; a truthy video constraint is not.
          expect(constraints, `${label} asked for a camera`).not.toMatch(/"video"\s*:\s*(?!false)/);
        }
        expect(detail.senderKinds, `${label} published a video track`).not.toContain("video");
        expect(detail.senderKinds, `${label} published no audio track`).toContain("audio");
      }

      /* 9. No camera controls on an audio call. */
      await expect(guestPage.locator(".live-call-pip")).toBeHidden();

      /* 10. Mute acts on the track without renegotiating. */
      const mute = guestPage.getByRole("button", { name: /microphone on/i });
      await expect(mute).toBeVisible();
      await mute.click();
      await expect(guestPage.getByRole("button", { name: /microphone muted/i })).toBeVisible();
      // Still one peer connection: muting must never rebuild anything.
      expect((await rtcStates(guestPage)).filter((state) => state === "created")).toHaveLength(1);

      /* 11. Clean hangup from the guest, and the host leaves the call. */
      await guestPage.locator(".call-control.is-end").click();
      await expect(guestPage.getByRole("heading", { name: /call ended/i })).toBeVisible();
      await expect(hostPage.locator(".audio-call")).toBeHidden();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("a declined audio call tells the guest and builds no peer connection", async ({ browser }) => {
    const hostContext = await browser.newContext(DESKTOP);
    const guestContext = await browser.newContext(DESKTOP);

    await prepareContext(hostContext);
    await prepareContext(guestContext);

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await seedProfile(hostPage, AUDIO_PROFILE);
      await seedProfile(guestPage, AUDIO_PROFILE);
      await bringHostOnline(hostPage, AUDIO_PROFILE);
      await guestDialsAudio(guestPage);
      await guestPage.getByRole("button", { name: /^continue$/i }).click();

      const incoming = hostPage.getByRole("alertdialog");
      await expect(incoming).toBeVisible();
      await incoming.getByRole("button", { name: /decline/i }).click();

      await expect(guestPage.getByRole("heading", { name: /call declined/i })).toBeVisible();
      expect(await rtcStates(hostPage)).toHaveLength(0);
      expect(await gumCalls(hostPage)).toBe(0);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
