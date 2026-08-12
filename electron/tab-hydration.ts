export interface HydrationFlight<T> {
  readonly interactive: boolean
  readonly promise: Promise<T | null>
}

export interface PendingHydration<T> {
  inFlight: HydrationFlight<T> | null
  load(interactive: boolean, allowEmptyFallback: boolean): Promise<T | null>
}

function startHydration<T>(
  pending: PendingHydration<T>,
  interactive: boolean,
  allowEmptyFallback: boolean
): HydrationFlight<T> {
  const flight: HydrationFlight<T> = {
    interactive,
    promise: Promise.resolve().then(() =>
      pending.load(interactive, allowEmptyFallback)
    ),
  }
  pending.inFlight = flight
  const clear = () => {
    if (pending.inFlight === flight) pending.inFlight = null
  }
  void flight.promise.then(clear, clear)
  return flight
}

/**
 * Joins one hydration read at a time. An interactive request that arrives from
 * a replacement renderer may inherit background work started by the previous
 * renderer. If that background-only attempt reports a silent null result,
 * retry once with interactive error handling instead of returning that result
 * to a renderer which has no local background-request state to recognize it.
 */
export async function runPendingHydration<T>(
  pending: PendingHydration<T>,
  interactive: boolean,
  allowEmptyFallback: boolean,
  canRetry: () => boolean = () => true,
  retryBackgroundFailure = true
): Promise<T | null> {
  const flight =
    pending.inFlight ?? startHydration(pending, interactive, allowEmptyFallback)
  const joinedBackground =
    interactive && pending.inFlight === flight && !flight.interactive
  const result = await flight.promise

  if (
    result !== null ||
    !joinedBackground ||
    !retryBackgroundFailure ||
    !canRetry()
  ) {
    return result
  }

  if (pending.inFlight === flight) pending.inFlight = null
  return runPendingHydration(pending, true, allowEmptyFallback, canRetry, false)
}
