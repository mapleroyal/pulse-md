type DynamicImport<Value> = (url: string) => Promise<Value>

const DEFERRED_RETRY_PARAMETER = "pulse-md-retry"
const FAILED_DYNAMIC_IMPORT_URL_PATTERN =
  /Failed to fetch dynamically imported module:\s*([a-z][a-z\d+.-]*:\/\/[^\s"'<>]+)/iu

function currentRendererUrl() {
  return typeof location === "undefined" ? null : location.href
}

function safeFailedModuleUrl(error: unknown, rendererUrl: string | null) {
  if (!rendererUrl) return null
  let renderer: URL
  try {
    renderer = new URL(rendererUrl)
  } catch {
    return null
  }

  // Vite preload failures can mention a dependency or stylesheet URL. Importing
  // that URL would return the wrong module namespace (or try to execute CSS as
  // JavaScript), so accept only Chromium's explicit dynamic-import target.
  const candidateText = FAILED_DYNAMIC_IMPORT_URL_PATTERN.exec(
    String(error)
  )?.[1]
  if (candidateText) {
    let candidate: URL
    try {
      candidate = new URL(candidateText.replace(/[),.;:]+$/u, ""))
    } catch {
      return null
    }
    const sameRendererOrigin =
      candidate.protocol === renderer.protocol &&
      candidate.host === renderer.host &&
      candidate.username === "" &&
      candidate.password === ""
    const packagedBundleModule =
      renderer.protocol === "pulse-md:" &&
      renderer.host === "bundle" &&
      candidate.pathname.startsWith("/assets/")
    if (
      !sameRendererOrigin ||
      (renderer.protocol === "pulse-md:" && !packagedBundleModule)
    ) {
      return null
    }
    candidate.hash = ""
    candidate.searchParams.delete(DEFERRED_RETRY_PARAMETER)
    return candidate.href
  }
  return null
}

/**
 * Shares a dynamic import while allowing a failed browser module fetch to be
 * retried through a fresh module-map URL.
 *
 * Chromium remembers a rejected dynamic import by URL even after an ordinary
 * promise cache is cleared. The rejection includes the resolved chunk URL, so
 * a retry can safely import that same local module with a cache-busting query
 * without emitting a duplicate feature chunk.
 */
export function createRetryableDynamicImport<Value>(
  loadValue: () => Promise<Value>,
  retryImport: DynamicImport<Value> = (url) =>
    import(/* @vite-ignore */ url) as Promise<Value>,
  rendererUrl: () => string | null = currentRendererUrl
) {
  let loaded = false
  let value: Value | null = null
  let pending: Promise<Value> | null = null
  let failedRootModuleUrl: string | null = null
  let retry = 0

  return () => {
    if (loaded) return Promise.resolve(value as Value)
    if (pending) return pending

    const attempt = Promise.resolve()
      .then(() => {
        if (!failedRootModuleUrl) return loadValue()
        const retryUrl = new URL(failedRootModuleUrl)
        retryUrl.searchParams.set(DEFERRED_RETRY_PARAMETER, String(++retry))
        return retryImport(retryUrl.href)
      })
      .then(
        (nextValue) => {
          loaded = true
          value = nextValue
          pending = null
          return nextValue
        },
        (error: unknown) => {
          pending = null
          failedRootModuleUrl ??= safeFailedModuleUrl(error, rendererUrl())
          throw error
        }
      )
    pending = attempt
    return attempt
  }
}
