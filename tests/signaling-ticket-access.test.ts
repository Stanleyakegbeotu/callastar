import { afterEach, expect, it, vi } from "vitest"
import { bindTicketAccess } from "../server/signaling/src/ticketAccess.ts"

const proof = { sessionId: "session", sessionToken: "x".repeat(64) }
const id = "att_12345678"
afterEach(() => vi.unstubAllGlobals())
it("rejects a direct signaling request without its reserved-session proof", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  expect(
    await bindTicketAccess(
      "https://project.test/edge",
      "anon",
      "masked",
      null,
      id,
    ),
  ).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})
it("binds the exact reservation and code to the server's proposed attempt", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          authorized: true,
          callAttemptId: id,
          reservedUntil: new Date(Date.now() + 60000).toISOString(),
        }),
      ),
  )
  vi.stubGlobal("fetch", fetch)
  expect(
    (
      await bindTicketAccess(
        "https://project.test/edge",
        "anon",
        "test-code",
        proof,
        id,
      )
    )?.callAttemptId,
  ).toBe(id)
  expect(fetch.mock.calls[0][1].headers).toMatchObject({
    apikey: "anon",
    authorization: "Bearer anon",
  })
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    ...proof,
    action: "bind_signaling",
    code: "test-code",
    callAttemptId: id,
  })
})
it.each([403, 409, 500])(
  "fails closed when backend authorization returns %i",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status })),
    )
    expect(
      await bindTicketAccess(
        "https://project.test/edge",
        "anon",
        "code",
        proof,
        id,
      ),
    ).toBeNull()
  },
)
it("fails closed on an expired lease or an unreachable backend", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authorized: true,
            callAttemptId: id,
            reservedUntil: new Date(0).toISOString(),
          }),
        ),
    ),
  )
  expect(
    await bindTicketAccess(
      "https://project.test/edge",
      "anon",
      "code",
      proof,
      id,
    ),
  ).toBeNull()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline")
    }),
  )
  expect(
    await bindTicketAccess(
      "https://project.test/edge",
      "anon",
      "code",
      proof,
      id,
    ),
  ).toBeNull()
})
