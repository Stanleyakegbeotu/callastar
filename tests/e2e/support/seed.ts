import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Test fixtures for the two-party call suite.
 *
 * Both browsers need the same profile in their own storage, because in local
 * mode a Call ID is resolved against IndexedDB on each side. In production both
 * would resolve against one backend; here the same row is written twice, which is
 * the closest honest equivalent.
 *
 * The contexts stay isolated in every other respect — separate storage, separate
 * sessions, separate media — because a guest and a host sharing state would hide
 * exactly the bugs this suite exists to catch.
 */

export interface TestProfile {
  id: string;
  displayName: string;
  shortBio: string;
  callId: string;
  callIdKey: string;
}

/**
 * A profile fixture, with its own Call ID.
 *
 * Every spec file gets its own, because the signalling service keys its host
 * registry by Call ID and presence expires on a timer rather than instantly. A
 * host socket from a finished spec can still be registered when the next one
 * starts, and a second spec sharing that Call ID would then find the host busy
 * or race its own registration against the stale one — a failure that appears
 * only when the files run together, which is the worst kind to debug.
 */
function makeProfile(suffix: string, displayName: string, callId: string): TestProfile {
  return {
    id: `prof_e2e_${suffix}`,
    displayName,
    shortBio: "CallaStar host",
    callId,
    callIdKey: callId.replace(/[^A-Z0-9]/g, ""),
  };
}

/** Video suite. Also the default, so existing callers keep working. */
export const PROFILE = makeProfile("video", "Amara Vale", "CS-7K4P-Q9MX-2J8R");

/** Audio suite. */
export const AUDIO_PROFILE = makeProfile("audio", "Nadia Brooke", "CS-8L5Q-R7NY-3K9S");

/** Admin layout suite, which never places a call but still seeds a profile. */
export const ADMIN_PROFILE = makeProfile("admin", "Marcus Hale", "CS-9M6R-S8PZ-4L2T");

export const CALLER = {
  fullName: "John Williams",
  email: "john.williams@example.com",
  phone: "+15551234567",
} as const;

const DB_NAME = "callastar-development";
const DEV_SESSION_KEY = "callastar.development-admin";

/** Grants the development admin session. */
export async function seedAdminSession(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ key }) => {
      try {
        sessionStorage.setItem(key, "active");
      } catch {
        // A context without storage simply lands on the login screen.
      }
    },
    { key: DEV_SESSION_KEY },
  );
}

/**
 * Puts the profile into an IndexedDB the app has already built.
 *
 * Deliberately NOT created from scratch here. Writing the schema in a test would
 * duplicate `services/admin/indexeddb.ts` and then drift from it — and worse, a
 * partial database at the app's own version number stops its upgrade ever
 * running, so every other store silently goes missing.
 *
 * So the app opens the database first (the admin profiles page does it on load)
 * and this only adds a row to a store that already exists.
 */
export async function seedProfile(page: Page, profile: TestProfile = PROFILE): Promise<void> {
  await page.goto("/admin/profiles");
  // The list having rendered is the signal that the database is open and fully
  // migrated. Waiting on the UI is more reliable than waiting on a timer.
  await expect(page.getByRole("heading", { name: /profiles/i }).first()).toBeVisible();

  const written = await page.evaluate(
    async ({ dbName, profile }) => {
      const open = (): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          // No version: attach to whatever the app created, so this can never
          // trigger an upgrade of its own.
          const request = indexedDB.open(dbName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

      const db = await open();
      if (!db.objectStoreNames.contains("profiles")) {
        db.close();
        return false;
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("profiles", "readwrite");
        tx.objectStore("profiles").put(profile);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
      return true;
    },
    {
      dbName: DB_NAME,
      profile: {
        ...profile,
        status: "active",
        avatarAssetId: null,
        remoteVideoAssetId: null,
        remoteAudioAssetId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  );

  // A silent failure here would surface later as a confusing "profile not found",
  // so it fails loudly at the point of the actual problem.
  expect(written, "could not write the test profile into IndexedDB").toBe(true);
}

/**
 * Reports the live `RTCPeerConnection` states in a page.
 *
 * Instrumented by wrapping the constructor, because the engine deliberately keeps
 * its peer connection private and a test that reached into it would be testing
 * the wrong thing. This observes only.
 */
export async function instrumentPeerConnections(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const states: string[] = [];
    (window as unknown as { __rtcStates: string[] }).__rtcStates = states;

    const Original = window.RTCPeerConnection;
    if (!Original) return;

    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args: [RTCConfiguration?]) {
        const pc = new target(...args);
        states.push("created");
        pc.addEventListener("connectionstatechange", () => states.push(pc.connectionState));
        return pc;
      },
    });
  });
}

export async function rtcStates(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __rtcStates?: string[] }).__rtcStates ?? []);
}

/** How many times this page asked for a camera or microphone. */
export async function instrumentGetUserMedia(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __gumCalls: number }).__gumCalls = 0;
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) return;

    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      (window as unknown as { __gumCalls: number }).__gumCalls += 1;
      return original(constraints);
    };
  });
}

export async function gumCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gumCalls?: number }).__gumCalls ?? 0);
}

/**
 * Brings a host online for the seeded profile and waits for confirmed presence.
 *
 * Shared by the video and audio suites so the two cannot drift. It waits on the
 * profile page having rendered before looking for the control: on a slow machine
 * the page can take tens of seconds, and a missing button then looks like a
 * missing feature rather than a page that has not arrived yet.
 */
export async function bringHostOnline(page: Page, profile: TestProfile = PROFILE): Promise<void> {
  await page.goto(`/admin/profiles/${profile.id}`);
  await expect(page.getByRole("heading", { name: profile.displayName }).first()).toBeVisible();

  const toggle = page.getByRole("button", { name: /receive calls/i });
  await expect(toggle).toBeVisible();

  const confirmed = page.getByText(/available for incoming calls/i);

  /*
   * Ask, and if the socket did not come up, ask again.
   *
   * Presence is the service's to confirm, never the toggle's — a host that asked
   * to receive calls but has no live socket is deliberately reported Offline
   * rather than Available, which is the whole point of keeping the operator's
   * intent separate from their presence.
   *
   * That invariant means a transient WebSocket failure surfaces here as a
   * correctly-offline host, not as a hung test. On a loaded machine the provider
   * can exhaust its reconnect budget and give up, so this retries the toggle the
   * way an operator would, rather than waiting longer on a connection that has
   * already stopped trying.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await toggle.click();
    try {
      await expect(confirmed).toBeVisible({ timeout: 20_000 });
      return;
    } catch {
      // Switch it back off so the next click is a fresh connect rather than a
      // toggle into the off state.
      await toggle.click().catch(() => {});
      await page.waitForTimeout(1_000);
    }
  }

  // Out of attempts: fail with the assertion, so the report names what was
  // missing rather than a generic timeout.
  await expect(confirmed).toBeVisible();
}
