type DynamicImport<Value> = (url: string) => Promise<Value>
type StylesheetRetry = (url: string) => Promise<void>

const DEFERRED_RETRY_PARAMETER = "pulse-md-retry"
const FAILED_DYNAMIC_IMPORT_URL_PATTERN =
  /Failed to fetch dynamically imported module:\s*([a-z][a-z\d+.-]*:\/\/[^\s"'<>]+)/iu
const FAILED_STYLESHEET_URL_PATTERN =
  /Unable to preload CSS for\s*([a-z][a-z\d+.-]*:\/\/[^\s"'<>]+)/iu

function currentRendererUrl() {
  return typeof location === "undefined" ? null : location.href
}

function safeRendererAssetUrl(
  candidateText: string | undefined,
  rendererUrl: string | null
) {
  if (!rendererUrl) return null
  let renderer: URL
  try {
    renderer = new URL(rendererUrl)
  } catch {
    return null
  }

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

function safeFailedStylesheetUrl(error: unknown, rendererUrl: string | null) {
  const url = safeRendererAssetUrl(
    FAILED_STYLESHEET_URL_PATTERN.exec(String(error))?.[1],
    rendererUrl
  )
  return url && new URL(url).pathname.endsWith(".css") ? url : null
}

function observeStylesheetFailures(
  rendererUrl: string | null,
  failures: Set<string>
) {
  if (typeof document === "undefined") return () => undefined
  const onError = (event: Event) => {
    const link = event.target
    if (!(link instanceof HTMLLinkElement) || link.rel !== "stylesheet") return
    const url = safeRendererAssetUrl(link.href, rendererUrl)
    if (url && new URL(url).pathname.endsWith(".css")) failures.add(url)
  }
  document.addEventListener("error", onError, true)
  return () => document.removeEventListener("error", onError, true)
}

const stylesheetRetries = new WeakMap<Document, Map<string, Promise<void>>>()
let stylesheetRetryRevision = 0

function retryStylesheet(url: string): Promise<void> {
  const ownerDocument = document
  let retries = stylesheetRetries.get(ownerDocument)
  if (!retries) {
    retries = new Map()
    stylesheetRetries.set(ownerDocument, retries)
  }
  const previous = retries.get(url)
  if (previous) return previous

  const links = [
    ...ownerDocument.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"]'
    ),
  ]
  const failed = links.findLast(
    (link) => safeRendererAssetUrl(link.href, url) === url
  )
  const replacement = failed
    ? (failed.cloneNode(false) as HTMLLinkElement)
    : ownerDocument.createElement("link")
  replacement.rel = "stylesheet"
  replacement.crossOrigin = failed?.crossOrigin ?? ""
  if (failed?.nonce) replacement.nonce = failed.nonce
  const retryUrl = new URL(url)
  retryUrl.searchParams.set(
    DEFERRED_RETRY_PARAMETER,
    String(++stylesheetRetryRevision)
  )
  replacement.href = retryUrl.href

  const pending = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      replacement.removeEventListener("load", onLoad)
      replacement.removeEventListener("error", onError)
    }
    const onLoad = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`Unable to preload CSS for ${url}`))
    }
    replacement.addEventListener("load", onLoad)
    replacement.addEventListener("error", onError)
    if (failed) failed.replaceWith(replacement)
    else ownerDocument.head.append(replacement)
  })
  retries.set(url, pending)
  void pending.catch(() => {
    if (retries.get(url) === pending) retries.delete(url)
  })
  return pending
}

/**
 * Shares a dynamic import while allowing a failed browser module fetch to be
 * retried through a fresh module-map URL.
 *
 * Chromium remembers a rejected dynamic import by URL even after an ordinary
 * promise cache is cleared. The rejection includes the resolved chunk URL, so
 * a retry can safely import that same local module with a cache-busting query
 * without emitting a duplicate feature chunk.
 * Vite also remembers failed stylesheet preloads. Restore those links before
 * retrying the root import, retaining their cascade order and waiting for CSS.
 */
export function createRetryableDynamicImport<Value>(
  loadValue: () => Promise<Value>,
  retryImport: DynamicImport<Value> = (url) =>
    import(/* @vite-ignore */ url) as Promise<Value>,
  rendererUrl: () => string | null = currentRendererUrl,
  reloadStylesheet: StylesheetRetry = retryStylesheet
) {
  let loaded = false
  let value: Value | null = null
  let pending: Promise<Value> | null = null
  let failedRootModuleUrl: string | null = null
  const failedStylesheets = new Set<string>()
  let retry = 0

  return () => {
    if (loaded) return Promise.resolve(value as Value)
    if (pending) return pending

    const rendererLocation = rendererUrl()
    const observedStylesheetFailures = new Set<string>()
    const stopObserving = observeStylesheetFailures(
      rendererLocation,
      observedStylesheetFailures
    )
    const importValue = () => {
      if (!failedRootModuleUrl) return loadValue()
      const retryUrl = new URL(failedRootModuleUrl)
      retryUrl.searchParams.set(DEFERRED_RETRY_PARAMETER, String(++retry))
      return retryImport(retryUrl.href)
    }
    const attempt = Promise.resolve()
      .then(() =>
        failedStylesheets.size > 0
          ? Promise.all(
              [...failedStylesheets].map((url) => reloadStylesheet(url))
            ).then(importValue)
          : importValue()
      )
      .then(
        (nextValue) => {
          stopObserving()
          loaded = true
          value = nextValue
          pending = null
          return nextValue
        },
        (error: unknown) => {
          stopObserving()
          pending = null
          const failedStylesheet = safeFailedStylesheetUrl(
            error,
            rendererLocation
          )
          if (failedStylesheet) {
            failedStylesheets.add(failedStylesheet)
            // Vite waits for the whole preload group but reports only its
            // first rejection. Restore every failed stylesheet in that group.
            for (const url of observedStylesheetFailures) {
              failedStylesheets.add(url)
            }
          }
          // Import only Chromium's explicit module target. Other preload
          // errors can name dependencies with a different module namespace.
          failedRootModuleUrl ??= safeRendererAssetUrl(
            FAILED_DYNAMIC_IMPORT_URL_PATTERN.exec(String(error))?.[1],
            rendererLocation
          )
          throw error
        }
      )
    pending = attempt
    return attempt
  }
}
