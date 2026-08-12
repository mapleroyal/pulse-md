import * as React from "react"

export interface RetryableDeferredLoader<Value> {
  load: () => Promise<Value>
  peek: () => Value | null
  reset: () => void
}

interface DeferredValueHandlerRef<Value> {
  current: ((value: Value) => void) | null
}

/** Registers a deferred surface handler and replays the latest active value. */
export function registerDeferredValueHandler<Value>(
  handlerRef: DeferredValueHandlerRef<Value>,
  handler: ((value: Value) => void) | null,
  active: boolean,
  latestValue: Value | null
) {
  handlerRef.current = handler
  if (handler && active && latestValue !== null) handler(latestValue)
}

export function createRetryableDeferredLoader<Value>(
  loadValue: () => Promise<Value>
): RetryableDeferredLoader<Value> {
  let loaded = false
  let value: Value | null = null
  let pending: Promise<Value> | null = null

  return {
    load() {
      if (loaded) return Promise.resolve(value as Value)
      if (pending) return pending

      const attempt = Promise.resolve()
        .then(loadValue)
        .then(
          (nextValue) => {
            loaded = true
            value = nextValue
            pending = null
            return nextValue
          },
          (error: unknown) => {
            pending = null
            throw error
          }
        )
      pending = attempt
      return attempt
    },
    peek() {
      return loaded ? value : null
    },
    reset() {
      if (!loaded) pending = null
    },
  }
}

export function useDeferredValue<Value>(
  loader: RetryableDeferredLoader<Value>,
  active = true
) {
  const [value, setValue] = React.useState<Value | null>(() => loader.peek())
  const [error, setError] = React.useState<unknown>(null)
  const [revision, setRevision] = React.useState(0)

  React.useEffect(() => {
    if (!active || value) return
    let disposed = false
    void loader.load().then(
      (nextValue) => {
        if (disposed) return
        setError(null)
        setValue(() => nextValue)
      },
      (loadError: unknown) => {
        if (disposed) return
        console.error("Unable to load deferred feature", loadError)
        setError(loadError)
      }
    )
    return () => {
      disposed = true
    }
  }, [active, loader, revision, value])

  const retry = React.useCallback(() => {
    loader.reset()
    setError(null)
    const loadedValue = loader.peek()
    setValue(() => loadedValue)
    setRevision((current) => current + 1)
  }, [loader])

  return { error, retry, value }
}
