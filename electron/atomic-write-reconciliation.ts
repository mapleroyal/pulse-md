export interface AtomicWriteReconciliation<T> {
  readonly acceptStableExpectedBytesAfterReplacementMismatch: boolean
  readonly verifyStableExpectedBytes: () => Promise<T>
  readonly verifyStrictReplacement: () => Promise<T>
}

/**
 * An atomic rename can publish the requested bytes and still fail the strict
 * post-rename identity check when a filesystem normalizes metadata. Imported
 * settings transactions may reconcile that ambiguous result, but only by
 * proving that the published path now has the complete expected bytes and was
 * stable for the verification read.
 */
export async function reconcileAtomicWriteAfterRename<T>({
  acceptStableExpectedBytesAfterReplacementMismatch,
  verifyStableExpectedBytes,
  verifyStrictReplacement,
}: AtomicWriteReconciliation<T>): Promise<T> {
  try {
    return await verifyStrictReplacement()
  } catch (replacementError) {
    if (!acceptStableExpectedBytesAfterReplacementMismatch) {
      throw replacementError
    }
    try {
      return await verifyStableExpectedBytes()
    } catch (verificationError) {
      throw new AggregateError(
        [replacementError, verificationError],
        "The save target changed after it was replaced",
        { cause: verificationError }
      )
    }
  }
}
