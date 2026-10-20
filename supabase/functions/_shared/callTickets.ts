import { encryptCallId, hash, normalizeCode, randomCode } from "./utils.ts"

/** Generate only on the server. The database receives ciphertext and a lookup hash. */
export async function ticketCandidate() {
  const code = randomCode()
  return {
    code,
    record: {
      code_hash: await hash(normalizeCode(code)),
      code_ciphertext: await encryptCallId(code),
      code_last4: code.slice(-4),
    },
  }
}
