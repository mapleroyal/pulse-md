import { describe, expect, it, vi } from "vitest"

import { installHorizontalWheelScrolling } from "./horizontal-wheel-scroll"

describe("horizontal wheel scrolling", () => {
  it("resolves a deferred fallback scroller when the wheel event arrives", () => {
    let wheelListener: ((event: WheelEvent) => void) | null = null
    const eventTarget = {
      addEventListener(_type: string, listener: (event: WheelEvent) => void) {
        wheelListener = listener
      },
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement
    const scroller = {
      clientWidth: 100,
      scrollLeft: 0,
      scrollWidth: 300,
    } as HTMLElement
    let deferredScroller: HTMLElement | null = null
    installHorizontalWheelScrolling(
      eventTarget,
      () => deferredScroller,
      "down-right"
    )
    const preventDefault = vi.fn()
    const wheel = {
      composedPath: () => [eventTarget],
      ctrlKey: false,
      defaultPrevented: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 80,
      preventDefault,
    } as unknown as WheelEvent

    const dispatchWheel = () => {
      if (!wheelListener) throw new Error("Wheel listener was not installed")
      wheelListener(wheel)
    }

    dispatchWheel()
    expect(preventDefault).not.toHaveBeenCalled()

    deferredScroller = scroller
    dispatchWheel()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(scroller.scrollLeft).toBe(80)
  })
})
