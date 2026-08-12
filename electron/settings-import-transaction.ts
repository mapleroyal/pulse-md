export interface SettingsImportReplacement {
  readonly apply: () => Promise<void>
  readonly captureRollback: () => Promise<() => Promise<void>>
}

/**
 * Captures every original value before publishing any replacement. A failed
 * resource write or final settings commit restores each resource that may
 * have been touched, in reverse order, while leaving the staged import alive
 * for a safe retry.
 */
export async function runSettingsImportTransaction<T>(
  replacements: readonly SettingsImportReplacement[],
  commitSettings: () => Promise<T>
): Promise<T> {
  const rollbacks: Array<() => Promise<void>> = []
  for (const replacement of replacements) {
    rollbacks.push(await replacement.captureRollback())
  }
  let touchedCount = 0

  try {
    for (let index = 0; index < replacements.length; index += 1) {
      await replacements[index]!.apply()
      // Concrete replacements publish with atomic rename as their final
      // awaited operation, so a rejection leaves this target untouched.
      touchedCount = index + 1
    }
    return await commitSettings()
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (let index = touchedCount - 1; index >= 0; index -= 1) {
      try {
        await rollbacks[index]!()
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Settings import failed and could not be fully rolled back",
        { cause: error }
      )
    }
    throw error
  }
}
