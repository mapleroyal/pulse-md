export function trackDeferredExternalRefresh<T>(
  tabIds: Set<T>,
  tabId: T,
  dirty: boolean
): void {
  if (dirty) tabIds.delete(tabId)
  else tabIds.add(tabId)
}

export function drainDeferredExternalRefreshes<T>(tabIds: Set<T>): T[] {
  const deferred = [...tabIds]
  tabIds.clear()
  return deferred
}
