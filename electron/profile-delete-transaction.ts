export interface ProfileDeleteTransactionOptions<TSnapshot> {
  readonly captureDefinition: () => Promise<TSnapshot>
  readonly clearDefaultProfile: () => Promise<void>
  readonly defaultProfileId: () => Promise<string | null>
  readonly deleteDefinition: () => Promise<void>
  readonly profileId: string
  readonly profileIsOpen: () => boolean
  readonly restoreDefinition: (snapshot: TSnapshot) => Promise<void>
}

/**
 * Deletes a closed profile definition and, when necessary, clears the global
 * default through the caller's ordinary settings commit. The definition is
 * restored if that settings commit cannot be made durable.
 */
export async function runProfileDeleteTransaction<TSnapshot>(
  options: ProfileDeleteTransactionOptions<TSnapshot>
): Promise<void> {
  if (options.profileIsOpen()) {
    throw new Error(`Close profile ${options.profileId} before deleting it`)
  }
  const clearsDefault = (await options.defaultProfileId()) === options.profileId
  if (!clearsDefault) {
    await options.deleteDefinition()
    return
  }

  const rollbackSnapshot = await options.captureDefinition()
  await options.deleteDefinition()
  try {
    await options.clearDefaultProfile()
  } catch (error) {
    try {
      await options.restoreDefinition(rollbackSnapshot)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Profile ${options.profileId} was deleted, its default setting could not be cleared, and the definition could not be restored`,
        { cause: rollbackError }
      )
    }
    throw error
  }
}
