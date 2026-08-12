import { describe, expect, it } from "vitest"

import type { WindowProfileTab } from "@/shared/contracts"

import {
  resolvedWindowProfileScratchIdentity,
  windowProfileScratchIdentityKey,
  windowProfileTabDisplayName,
} from "./window-profile-tabs"

const scratchId = "10000000-0000-4000-8000-000000000001"

describe("window profile tabs", () => {
  it("resolves a scratch solely through its standalone id", () => {
    const tab: WindowProfileTab = {
      id: "notes",
      kind: "scratch",
      scratchId,
      title: "Notes",
    }

    const identity = resolvedWindowProfileScratchIdentity(
      "ignored-profile",
      tab
    )
    expect(identity).toEqual({ scratchId })
    expect(windowProfileScratchIdentityKey(identity!)).toBe(scratchId)
    expect(windowProfileTabDisplayName(tab)).toBe("Notes")
  })

  it("returns no scratch identity for other profile tab kinds", () => {
    expect(
      resolvedWindowProfileScratchIdentity("profile", {
        id: "draft",
        kind: "file",
        path: "/tmp/draft.md",
      })
    ).toBeNull()
  })
})
