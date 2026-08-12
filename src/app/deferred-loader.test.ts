import { describe, expect, it, vi } from "vitest"

import {
  createRetryableDeferredLoader,
  registerDeferredValueHandler,
} from "./deferred-loader"

describe("retryable deferred loader", () => {
  it("shares one in-flight request and retains the loaded value", async () => {
    const load = vi.fn(async () => ({ ready: true }))
    const loader = createRetryableDeferredLoader(load)

    const first = loader.load()
    const second = loader.load()

    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ ready: true })
    await expect(loader.load()).resolves.toEqual({ ready: true })
    expect(loader.peek()).toEqual({ ready: true })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("does not poison later attempts after a rejected load", async () => {
    const failure = new Error("chunk unavailable")
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("loaded")
    const loader = createRetryableDeferredLoader(load)

    await expect(loader.load()).rejects.toBe(failure)
    expect(loader.peek()).toBeNull()
    await expect(loader.load()).resolves.toBe("loaded")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("turns a synchronous loader failure into a retryable rejection", async () => {
    const failure = new Error("loader setup failed")
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockResolvedValueOnce("loaded")
    const loader = createRetryableDeferredLoader(load)

    await expect(loader.load()).rejects.toBe(failure)
    await expect(loader.load()).resolves.toBe("loaded")
  })

  it("replays a value published before an active deferred handler mounts", () => {
    const handlerRef: { current: ((value: number) => void) | null } = {
      current: null,
    }
    let latestZoom: number | null = 1.27
    handlerRef.current?.(latestZoom)
    latestZoom = 1.32
    handlerRef.current?.(latestZoom)
    const handler = vi.fn()

    registerDeferredValueHandler(handlerRef, handler, true, latestZoom)

    expect(handlerRef.current).toBe(handler)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(1.32)
  })

  it("does not replay a deferred value outside its active transaction", () => {
    const handlerRef: { current: ((value: number) => void) | null } = {
      current: null,
    }
    const handler = vi.fn()

    registerDeferredValueHandler(handlerRef, handler, false, 1.32)

    expect(handlerRef.current).toBe(handler)
    expect(handler).not.toHaveBeenCalled()
  })
})
