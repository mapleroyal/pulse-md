import { describe, expect, it } from "vitest"

import {
  advanceScopedRequest,
  scopedRequestIsCurrent,
} from "./scoped-request-generation"

describe("scoped request generations", () => {
  it("only supersedes older work in the same consumer scope", () => {
    const generations = new Map<string, number>()
    const browserRequest = advanceScopedRequest(generations, "scratch-browser")
    const profilesRequest = advanceScopedRequest(generations, "window-profiles")

    expect(
      scopedRequestIsCurrent(generations, "scratch-browser", browserRequest)
    ).toBe(true)
    expect(
      scopedRequestIsCurrent(generations, "window-profiles", profilesRequest)
    ).toBe(true)

    advanceScopedRequest(generations, "scratch-browser")
    expect(
      scopedRequestIsCurrent(generations, "scratch-browser", browserRequest)
    ).toBe(false)
    expect(
      scopedRequestIsCurrent(generations, "window-profiles", profilesRequest)
    ).toBe(true)
  })
})
