/**
 * Shares one in-flight or fulfilled operation while allowing a later caller to
 * retry after rejection. Deferred local chunks should not poison a renderer
 * session because one filesystem read failed.
 */
export function createRetryablePromiseLoader<Value>(
  load: () => Promise<Value>
): () => Promise<Value> {
  let pending: Promise<Value> | null = null

  return () => {
    if (pending) return pending
    const attempt = Promise.resolve().then(load)
    pending = attempt
    void attempt.catch(() => {
      if (pending === attempt) pending = null
    })
    return attempt
  }
}
