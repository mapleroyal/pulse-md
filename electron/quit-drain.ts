export async function closeIngressAndDrainOperations(
  closeIngress: () => Promise<void>,
  drainOperations: () => Promise<void>
): Promise<void> {
  const closing = closeIngress()
  await drainOperations()
  await closing
  // A connection accepted immediately before close can dispatch after the
  // first drain observes no work. Once close resolves, no later dispatch is
  // possible, so this second drain is the stable barrier.
  await drainOperations()
}

export async function runQuiescedOperation<T>(
  setQuiescing: (quiescing: boolean) => void,
  operation: () => Promise<T>,
  retainQuiescence: (result: T) => boolean
): Promise<T> {
  setQuiescing(true)
  let retain = false
  try {
    const result = await operation()
    retain = retainQuiescence(result)
    return result
  } finally {
    if (!retain) setQuiescing(false)
  }
}
