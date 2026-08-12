import { describe, expect, it } from "vitest"

import {
  drainDeferredExternalRefreshes,
  trackDeferredExternalRefresh,
} from "./tab-mutation-effects"

describe("tab mutation deferred effects", () => {
  it("retains one refresh for each tab that is clean when the mutation unlocks", () => {
    const tabIds = new Set<string>()

    trackDeferredExternalRefresh(tabIds, "first", false)
    trackDeferredExternalRefresh(tabIds, "first", false)
    trackDeferredExternalRefresh(tabIds, "second", false)
    trackDeferredExternalRefresh(tabIds, "second", true)

    expect(drainDeferredExternalRefreshes(tabIds)).toEqual(["first"])
    expect(tabIds.size).toBe(0)
  })

  it("does not let a drained mutation consume effects queued later", () => {
    const tabIds = new Set<string>()
    trackDeferredExternalRefresh(tabIds, "first", false)

    expect(drainDeferredExternalRefreshes(tabIds)).toEqual(["first"])

    trackDeferredExternalRefresh(tabIds, "second", false)
    expect(drainDeferredExternalRefreshes(tabIds)).toEqual(["second"])
  })
})
