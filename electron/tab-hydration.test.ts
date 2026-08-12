import { describe, expect, it } from "vitest"

import { runPendingHydration, type PendingHydration } from "./tab-hydration"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe("pending tab hydration", () => {
  it("retries a background null once when a replacement renderer joins interactively", async () => {
    const background = deferred<null>()
    const calls: boolean[] = []
    const pending: PendingHydration<string> = {
      inFlight: null,
      async load(interactive) {
        calls.push(interactive)
        if (!interactive) return background.promise
        return "interactive result"
      },
    }

    const originalRenderer = runPendingHydration(pending, false, false)
    const replacementRenderer = runPendingHydration(pending, true, false)
    background.resolve(null)

    await expect(originalRenderer).resolves.toBeNull()
    await expect(replacementRenderer).resolves.toBe("interactive result")
    expect(calls).toEqual([false, true])
    expect(pending.inFlight).toBeNull()
  })

  it("shares the one interactive retry between concurrent replacement requests", async () => {
    const background = deferred<null>()
    const interactive = deferred<string>()
    const calls: boolean[] = []
    const pending: PendingHydration<string> = {
      inFlight: null,
      async load(requestIsInteractive) {
        calls.push(requestIsInteractive)
        return requestIsInteractive ? interactive.promise : background.promise
      },
    }

    const backgroundRequest = runPendingHydration(pending, false, false)
    const firstInteractive = runPendingHydration(pending, true, false)
    const secondInteractive = runPendingHydration(pending, true, false)
    background.resolve(null)
    await backgroundRequest
    await Promise.resolve()
    interactive.resolve("shared result")

    await expect(firstInteractive).resolves.toBe("shared result")
    await expect(secondInteractive).resolves.toBe("shared result")
    expect(calls).toEqual([false, true])
  })

  it("does not retry after the pending tab is no longer eligible", async () => {
    const background = deferred<null>()
    const calls: boolean[] = []
    const pending: PendingHydration<string> = {
      inFlight: null,
      async load(interactive) {
        calls.push(interactive)
        return interactive ? "unexpected" : background.promise
      },
    }

    void runPendingHydration(pending, false, false)
    const replacementRenderer = runPendingHydration(
      pending,
      true,
      false,
      () => false
    )
    background.resolve(null)

    await expect(replacementRenderer).resolves.toBeNull()
    expect(calls).toEqual([false])
  })

  it("does not repeat an interactive failure", async () => {
    const calls: boolean[] = []
    const pending: PendingHydration<string> = {
      inFlight: null,
      async load(interactive) {
        calls.push(interactive)
        return null
      },
    }

    await expect(runPendingHydration(pending, true, false)).resolves.toBeNull()
    expect(calls).toEqual([true])
  })
})
