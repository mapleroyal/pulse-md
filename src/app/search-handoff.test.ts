import { describe, expect, it } from "vitest"

import {
  clearSearchHandoff,
  DEFAULT_SEARCH_UI_STATE,
  drainSearchHandoff,
  enqueueSearchHandoff,
  searchStateWithQueuedConfiguration,
  type SearchHandoffQueue,
} from "./search-handoff"

function emptyQueue(): SearchHandoffQueue {
  return { actions: [] }
}

describe("cold Find handoff", () => {
  it("coalesces adjacent configuration without crossing navigation order", () => {
    const queue = emptyQueue()

    enqueueSearchHandoff(queue, {
      change: { query: "mark" },
      synchronize: false,
      type: "configure",
    })
    enqueueSearchHandoff(queue, {
      change: { caseSensitive: true, query: "markdown" },
      synchronize: true,
      type: "configure",
    })
    enqueueSearchHandoff(queue, { direction: "next", type: "navigate" })
    enqueueSearchHandoff(queue, {
      change: { query: "reader" },
      synchronize: true,
      type: "configure",
    })

    expect(queue.actions).toEqual([
      {
        change: { caseSensitive: true, query: "markdown" },
        synchronize: true,
        type: "configure",
      },
      { direction: "next", type: "navigate" },
      {
        change: { query: "reader" },
        synchronize: true,
        type: "configure",
      },
    ])
  })

  it("keeps the cold queue bounded", () => {
    const queue = emptyQueue()

    for (let index = 0; index < 65; index += 1) {
      enqueueSearchHandoff(queue, {
        direction: index % 2 === 0 ? "next" : "previous",
        type: "navigate",
      })
    }

    expect(queue.actions).toHaveLength(64)
    expect(queue.actions[0]).toEqual({
      direction: "previous",
      type: "navigate",
    })
    expect(queue.actions.at(-1)).toEqual({
      direction: "next",
      type: "navigate",
    })
  })

  it("drains each queued action exactly once", () => {
    const queue = emptyQueue()
    enqueueSearchHandoff(queue, { direction: "next", type: "navigate" })

    expect(drainSearchHandoff(queue)).toEqual([
      { direction: "next", type: "navigate" },
    ])
    expect(drainSearchHandoff(queue)).toEqual([])
  })

  it("retains cold input configuration when close discards queued actions", () => {
    const queue = emptyQueue()
    enqueueSearchHandoff(queue, {
      change: { query: "retained", replacement: "replacement" },
      synchronize: true,
      type: "configure",
    })
    enqueueSearchHandoff(queue, { direction: "next", type: "navigate" })

    const retained = searchStateWithQueuedConfiguration(
      DEFAULT_SEARCH_UI_STATE,
      queue
    )
    clearSearchHandoff(queue)

    expect(retained).toMatchObject({
      query: "retained",
      replacement: "replacement",
    })
    expect(searchStateWithQueuedConfiguration(retained, queue)).toBe(retained)
    expect(queue.actions).toEqual([])
  })
})
