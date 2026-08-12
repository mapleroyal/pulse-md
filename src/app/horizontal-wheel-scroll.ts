import type { TabWheelScrollDirection } from "@/shared/contracts"

function wheelDeltaScale(event: WheelEvent, scroller: HTMLElement) {
  if (event.deltaMode === 1) return 16
  if (event.deltaMode === 2) return scroller.clientWidth
  return 1
}

export function hasHorizontalOverflow(scroller: HTMLElement) {
  return scroller.scrollWidth - scroller.clientWidth > 1
}

/**
 * Keeps horizontal overflow gestures attached to one stable surface.
 *
 * Chromium owns ordinary horizontal scrolling when the gesture still targets
 * the scroller. Vertical mouse-wheel input is converted to horizontal motion,
 * and horizontal input is forwarded only when a sibling overlay has moved
 * under the pointer and would otherwise interrupt the active gesture.
 */
export function installHorizontalWheelScrolling(
  eventTarget: HTMLElement,
  scrollTarget: HTMLElement | (() => HTMLElement | null),
  verticalDirection: TabWheelScrollDirection,
  shouldHandle: (event: WheelEvent) => boolean = () => true
) {
  const handleWheel = (event: WheelEvent) => {
    const scroller =
      typeof scrollTarget === "function" ? scrollTarget() : scrollTarget
    if (
      !scroller ||
      event.defaultPrevented ||
      event.ctrlKey ||
      !hasHorizontalOverflow(scroller) ||
      !shouldHandle(event)
    ) {
      return
    }

    const scale = wheelDeltaScale(event, scroller)
    if (event.deltaY !== 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault()
      scroller.scrollLeft +=
        event.deltaY * scale * (verticalDirection === "down-right" ? 1 : -1)
      return
    }

    if (event.deltaX !== 0 && !event.composedPath().includes(scroller)) {
      event.preventDefault()
      scroller.scrollLeft += event.deltaX * scale
    }
  }

  eventTarget.addEventListener("wheel", handleWheel, { passive: false })
  return () => eventTarget.removeEventListener("wheel", handleWheel)
}
