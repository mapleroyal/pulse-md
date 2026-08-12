export interface SaveTurnState {
  pendingSaveCount: number
  saveQueue: Promise<void>
}

/** Acquires a FIFO turn and prevents later saves from starting until release. */
export async function acquireSaveTurn(
  state: SaveTurnState,
  onReleased: () => void
): Promise<() => void> {
  const previous = state.saveQueue
  let releaseTurn!: () => void
  state.saveQueue = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  state.pendingSaveCount += 1
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    state.pendingSaveCount -= 1
    releaseTurn()
    onReleased()
  }
}
