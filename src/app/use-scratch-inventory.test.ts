import { describe, expect, it } from "vitest"

import { scratchInventoryResultsCurrent } from "./use-scratch-inventory"

describe("scratch inventory provenance", () => {
  const resolved = {
    loaded: true,
    loading: false,
    resolvedQuery: "notes",
    resolvedSort: "last-opened" as const,
  }

  it("requires results resolved for the current query and sort", () => {
    expect(
      scratchInventoryResultsCurrent(resolved, true, "notes", "last-opened")
    ).toBe(true)
    expect(
      scratchInventoryResultsCurrent(resolved, true, "drafts", "last-opened")
    ).toBe(false)
    expect(
      scratchInventoryResultsCurrent(resolved, true, "notes", "last-edited")
    ).toBe(false)
  })

  it("rejects inactive, loading, and not-yet-loaded inventories", () => {
    expect(
      scratchInventoryResultsCurrent(resolved, false, "notes", "last-opened")
    ).toBe(false)
    expect(
      scratchInventoryResultsCurrent(
        { ...resolved, loading: true },
        true,
        "notes",
        "last-opened"
      )
    ).toBe(false)
    expect(
      scratchInventoryResultsCurrent(
        { ...resolved, loaded: false },
        true,
        "notes",
        "last-opened"
      )
    ).toBe(false)
  })
})
