import { describe, expect, it, vi } from "vitest"

import { createRetryablePromiseLoader } from "./retryable-promise"

describe("retryable promise loader", () => {
  it("shares in-flight work and retains the fulfilled value", async () => {
    const load = vi.fn(async () => ({ value: 1 }))
    const deferred = createRetryablePromiseLoader(load)

    const first = deferred()
    const second = deferred()

    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ value: 1 })
    await expect(deferred()).resolves.toEqual({ value: 1 })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("clears a rejected attempt so a later activation can retry", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue("loaded")
    const deferred = createRetryablePromiseLoader(load)

    await expect(deferred()).rejects.toThrow("temporary failure")
    await expect(deferred()).resolves.toBe("loaded")
    expect(load).toHaveBeenCalledTimes(2)
  })
})
