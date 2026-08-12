export const DIRECTORY_WATCH_RETRY_LIMIT = 5
export const DIRECTORY_WATCH_RETRY_INITIAL_DELAY_MS = 350
export const DIRECTORY_WATCH_RETRY_MAX_DELAY_MS = 5_600

/**
 * Return the delay following a consecutive directory-watch failure. The first
 * failure permits retry one; failures beyond the limit remain stat-only until
 * a later user activation explicitly starts a new recovery cycle.
 */
export function directoryWatchRetryDelay(
  consecutiveFailureCount: number
): number | null {
  if (
    !Number.isSafeInteger(consecutiveFailureCount) ||
    consecutiveFailureCount <= 0
  ) {
    throw new RangeError("Watch failure count must be a positive integer")
  }
  if (consecutiveFailureCount > DIRECTORY_WATCH_RETRY_LIMIT) return null
  return Math.min(
    DIRECTORY_WATCH_RETRY_INITIAL_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    DIRECTORY_WATCH_RETRY_MAX_DELAY_MS
  )
}
