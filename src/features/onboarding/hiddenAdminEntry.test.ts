import { afterEach, describe, expect, it, vi } from "vitest"

import { createHiddenAdminEntry } from "./hiddenAdminEntry"

describe("hidden admin entry gesture", () => {
  afterEach(() => vi.useRealTimers())

  it("does not navigate after nine taps and navigates on the tenth", () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const entry = createHiddenAdminEntry(onComplete)

    for (let index = 0; index < 9; index += 1) entry.tap()
    expect(onComplete).not.toHaveBeenCalled()
    entry.tap()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it("resets the rolling count after the timeout", () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const entry = createHiddenAdminEntry(onComplete)

    for (let index = 0; index < 5; index += 1) entry.tap()
    vi.advanceTimersByTime(5_001)
    for (let index = 0; index < 5; index += 1) entry.tap()
    expect(onComplete).not.toHaveBeenCalled()
    for (let index = 0; index < 5; index += 1) entry.tap()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it("uses the same click handler for mouse, touch, and keyboard activation", () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const entry = createHiddenAdminEntry(onComplete)

    // Native button click events are emitted for mouse, touch, Enter and Space.
    for (let index = 0; index < 10; index += 1) entry.tap()
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
