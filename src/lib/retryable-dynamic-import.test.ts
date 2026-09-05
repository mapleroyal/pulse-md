import { describe, expect, it, vi } from "vitest"

import { createRetryableDynamicImport } from "./retryable-dynamic-import"

describe("retryable dynamic import", () => {
  it("bypasses Chromium's rejected module-map entry with a local retry URL", async () => {
    const failure = new TypeError(
      "Failed to fetch dynamically imported module: pulse-md://bundle/assets/SettingsDialog-test.js"
    )
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure)
    const retryImport = vi.fn(async () => "loaded")
    const loadModule = createRetryableDynamicImport(
      load,
      retryImport,
      () => "pulse-md://bundle/index.html"
    )

    await expect(loadModule()).rejects.toBe(failure)
    await expect(loadModule()).resolves.toBe("loaded")
    expect(retryImport).toHaveBeenCalledWith(
      "pulse-md://bundle/assets/SettingsDialog-test.js?pulse-md-retry=1"
    )
    await expect(loadModule()).resolves.toBe("loaded")
    expect(retryImport).toHaveBeenCalledTimes(1)
  })

  it("does not import a failed module URL from outside the renderer origin", async () => {
    const failure = new TypeError(
      "Failed to fetch dynamically imported module: https://example.com/feature.js"
    )
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("loaded")
    const retryImport = vi.fn(async () => "unexpected")
    const loadModule = createRetryableDynamicImport(
      load,
      retryImport,
      () => "pulse-md://bundle/index.html"
    )

    await expect(loadModule()).rejects.toBe(failure)
    await expect(loadModule()).resolves.toBe("loaded")
    expect(load).toHaveBeenCalledTimes(2)
    expect(retryImport).not.toHaveBeenCalled()
  })

  it("retries a dependency preload failure through the root loader", async () => {
    const message =
      "Unable to preload dependency pulse-md://bundle/assets/vendor-test.js for pulse-md://bundle/assets/SettingsDialog-test.js"
    const rootModule = { default: "settings" }
    const wrongNamespace = { dependency: "vendor" }
    const load = vi
      .fn<() => Promise<typeof rootModule>>()
      .mockRejectedValueOnce(new TypeError(message))
      .mockResolvedValueOnce(rootModule)
    const retryImport = vi.fn(async () => wrongNamespace as never)
    const loadModule = createRetryableDynamicImport(
      load,
      retryImport,
      () => "pulse-md://bundle/index.html"
    )

    await expect(loadModule()).rejects.toThrow(message)
    await expect(loadModule()).resolves.toBe(rootModule)
    await expect(loadModule()).resolves.toBe(rootModule)
    expect(load).toHaveBeenCalledTimes(2)
    expect(retryImport).not.toHaveBeenCalled()
  })

  it("restores failed CSS before retrying the root module and retains retry on repeated failure", async () => {
    const stylesheet = "pulse-md://bundle/assets/SettingsDialog-test.css"
    const failure = new Error(`Unable to preload CSS for ${stylesheet}`)
    const rootModule = { default: "settings" }
    const load = vi
      .fn<() => Promise<typeof rootModule>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(rootModule)
    const reloadStylesheet = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const retryImport = vi.fn(async () => rootModule)
    const loadModule = createRetryableDynamicImport(
      load,
      retryImport,
      () => "pulse-md://bundle/index.html",
      reloadStylesheet
    )

    await expect(loadModule()).rejects.toBe(failure)
    await expect(loadModule()).rejects.toBe(failure)
    expect(load).toHaveBeenCalledTimes(1)
    await expect(loadModule()).resolves.toBe(rootModule)
    expect(reloadStylesheet).toHaveBeenNthCalledWith(1, stylesheet)
    expect(reloadStylesheet).toHaveBeenNthCalledWith(2, stylesheet)
    expect(load).toHaveBeenCalledTimes(2)
    expect(retryImport).not.toHaveBeenCalled()
  })

  it("does not reload stylesheet URLs outside the renderer asset scope", async () => {
    const reloadStylesheet = vi.fn(async () => undefined)
    for (const stylesheet of [
      "https://example.com/feature.css",
      "pulse-md://scratch/private.css",
      "pulse-md://bundle/private.css",
      "pulse-md://bundle/assets/feature.js",
    ]) {
      const failure = new Error(`Unable to preload CSS for ${stylesheet}`)
      const load = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue("loaded")
      const loadModule = createRetryableDynamicImport(
        load,
        undefined,
        () => "pulse-md://bundle/index.html",
        reloadStylesheet
      )
      await expect(loadModule()).rejects.toBe(failure)
      await expect(loadModule()).resolves.toBe("loaded")
    }
    expect(reloadStylesheet).not.toHaveBeenCalled()
  })

  it("ignores an unrelated URL before the explicit dynamic-import target", async () => {
    const failure = new TypeError(
      "Dependency pulse-md://bundle/assets/vendor-test.js failed. Failed to fetch dynamically imported module: pulse-md://bundle/assets/SettingsDialog-test.js"
    )
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure)
    const retryImport = vi.fn(async () => "loaded")
    const loadModule = createRetryableDynamicImport(
      load,
      retryImport,
      () => "pulse-md://bundle/index.html"
    )

    await expect(loadModule()).rejects.toBe(failure)
    await expect(loadModule()).resolves.toBe("loaded")
    expect(retryImport).toHaveBeenCalledWith(
      "pulse-md://bundle/assets/SettingsDialog-test.js?pulse-md-retry=1"
    )
  })
})
