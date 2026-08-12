import { describe, expect, it, vi } from "vitest"

import { acquireSaveTurn, type SaveTurnState } from "./save-turn"

describe("acquireSaveTurn", () => {
  it("holds later save starts until the active operation releases", async () => {
    const state: SaveTurnState = {
      pendingSaveCount: 0,
      saveQueue: Promise.resolve(),
    }
    const firstReleased = vi.fn()
    const secondReleased = vi.fn()
    const releaseFirst = await acquireSaveTurn(state, firstReleased)
    let secondStarted = false
    const secondTurn = acquireSaveTurn(state, secondReleased).then(
      (release) => {
        secondStarted = true
        return release
      }
    )

    await Promise.resolve()
    expect(secondStarted).toBe(false)
    expect(state.pendingSaveCount).toBe(2)

    releaseFirst()
    const releaseSecond = await secondTurn
    expect(secondStarted).toBe(true)
    expect(state.pendingSaveCount).toBe(1)
    expect(firstReleased).toHaveBeenCalledOnce()

    releaseSecond()
    releaseSecond()
    expect(state.pendingSaveCount).toBe(0)
    expect(secondReleased).toHaveBeenCalledOnce()
  })
})
