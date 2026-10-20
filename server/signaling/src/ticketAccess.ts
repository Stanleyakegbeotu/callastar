export interface TicketProof {
  sessionId: string
  sessionToken: string
}
export interface TicketBinding {
  callAttemptId: string
  expiresAt: number
}

/** Fail closed. Credentials travel only to the configured Supabase endpoint. */
export async function bindTicketAccess(
  endpoint: string,
  anonKey: string,
  code: string,
  proof: TicketProof | null,
  proposedAttempt: string,
): Promise<TicketBinding | null> {
  if (
    !proof ||
    typeof proof.sessionId !== "string" ||
    typeof proof.sessionToken !== "string" ||
    proof.sessionToken.length < 40
  )
    return null
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({
        ...proof,
        action: "bind_signaling",
        code,
        callAttemptId: proposedAttempt,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const raw: unknown = await response.json()
    if (!raw || typeof raw !== "object") return null
    const data = raw as Record<string, unknown>
    if (typeof data.reservedUntil !== "string") return null
    const expiresAt = Date.parse(data.reservedUntil)
    if (
      data.authorized !== true ||
      typeof data.callAttemptId !== "string" ||
      !/^att_[a-zA-Z0-9_-]{8,80}$/.test(data.callAttemptId) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      return null
    return { callAttemptId: data.callAttemptId, expiresAt }
  } catch {
    return null
  }
}
