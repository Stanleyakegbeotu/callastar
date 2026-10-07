export const HIDDEN_ADMIN_TAP_COUNT = 10
export const HIDDEN_ADMIN_TAP_TIMEOUT_MS = 5_000

/** A hidden navigation gesture only; it grants no admin access. */
export function createHiddenAdminEntry(
  onComplete: () => void,
  tapCount = HIDDEN_ADMIN_TAP_COUNT,
  timeoutMs = HIDDEN_ADMIN_TAP_TIMEOUT_MS,
) {
  let count = 0
  let timeout: ReturnType<typeof setTimeout> | undefined

  const reset = () => {
    count = 0
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = undefined
  }

  const tap = () => {
    count += 1
    if (count >= tapCount) {
      reset()
      onComplete()
      return
    }

    if (timeout !== undefined) clearTimeout(timeout)
    timeout = setTimeout(reset, timeoutMs)
  }

  return { tap, reset }
}
