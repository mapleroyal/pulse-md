import { describe, expect, test } from "vitest"

import {
  axisInsertionIndex,
  tabInsertionIndex,
  type AxisDropGeometry,
  type TabDropGeometry,
} from "./tab-drag"

const left: TabDropGeometry = { id: "left", left: 0, right: 100 }
const right: TabDropGeometry = { id: "right", left: 106, right: 206 }

describe("tab insertion targeting", () => {
  test("takes over an adjacent tab at either near edge", () => {
    expect(tabInsertionIndex([left, right], "right", 99)).toBe(0)
    expect(tabInsertionIndex([left, right], "left", 107)).toBe(1)
  })

  test("uses the current visual order when a drag reverses direction", () => {
    const dragged = { ...right, left: 0, right: 100 }
    const target = { ...left, left: 106, right: 206 }

    expect(tabInsertionIndex([dragged, target], "right", 107)).toBe(1)
  })

  test("keeps midpoint placement for cross-window and gap drops", () => {
    expect(tabInsertionIndex([left, right], null, 107)).toBe(1)
    expect(tabInsertionIndex([left, right], null, 180)).toBe(2)
    expect(tabInsertionIndex([left, right], "right", 103)).toBe(1)
  })

  test("shares the same targeting along a vertical axis", () => {
    const top: AxisDropGeometry = { id: "top", start: 0, end: 100 }
    const bottom: AxisDropGeometry = { id: "bottom", start: 106, end: 206 }

    expect(axisInsertionIndex([top, bottom], "bottom", 99)).toBe(0)
    expect(axisInsertionIndex([top, bottom], "top", 107)).toBe(1)
    expect(axisInsertionIndex([top, bottom], null, 180)).toBe(2)
  })
})
