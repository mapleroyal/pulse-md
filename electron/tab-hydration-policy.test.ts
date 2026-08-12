import { describe, expect, it } from "vitest"

import {
  IDLE_TAB_HYDRATION_SIZE_BUDGET,
  tabSizeAllowsIdleHydration,
} from "./tab-hydration-policy"

describe("inactive tab hydration policy", () => {
  it("keeps ordinary documents eligible for idle hydration", () => {
    expect(tabSizeAllowsIdleHydration(0, null)).toBe(true)
    expect(
      tabSizeAllowsIdleHydration(
        IDLE_TAB_HYDRATION_SIZE_BUDGET - 1,
        IDLE_TAB_HYDRATION_SIZE_BUDGET - 1
      )
    ).toBe(true)
  })

  it("reserves documents at or above either size budget for activation", () => {
    expect(
      tabSizeAllowsIdleHydration(IDLE_TAB_HYDRATION_SIZE_BUDGET, null)
    ).toBe(false)
    expect(tabSizeAllowsIdleHydration(0, IDLE_TAB_HYDRATION_SIZE_BUDGET)).toBe(
      false
    )
  })
})
