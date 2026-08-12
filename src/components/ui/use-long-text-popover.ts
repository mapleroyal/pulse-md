import * as React from "react"

export interface LongTextPopoverAnchorProps<T extends HTMLElement> {
  onBlur: React.FocusEventHandler<T>
  onFocus: React.FocusEventHandler<T>
  onPointerCancel: React.PointerEventHandler<T>
  onPointerDown: React.PointerEventHandler<T>
  onPointerEnter: React.PointerEventHandler<T>
  onPointerLeave: React.PointerEventHandler<T>
  ref: React.RefCallback<T>
}

export function useLongTextPopover<T extends HTMLElement>() {
  const [anchor, setAnchor] = React.useState<T | null>(null)
  // Bit 1 tracks focus and bit 2 tracks pointer hover. Negative masks clear
  // one reason without closing a popover that remains open for the other.
  const [openReasons, updateOpenReasons] = React.useReducer(
    (current: number, update: number) =>
      update < 0 ? current & update : update ? current | update : 0,
    0
  )

  const close = React.useCallback(() => {
    updateOpenReasons(0)
  }, [])

  const anchorProps = React.useMemo<LongTextPopoverAnchorProps<T>>(
    () => ({
      ref: setAnchor,
      onBlur: (event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return
        }
        updateOpenReasons(-2)
      },
      onFocus: (event) => {
        if (event.target.matches(":focus-visible")) {
          updateOpenReasons(1)
        }
      },
      onPointerCancel: () => updateOpenReasons(-3),
      onPointerDown: close,
      onPointerEnter: (event) => {
        if (event.pointerType !== "touch") {
          updateOpenReasons(2)
        }
      },
      onPointerLeave: (event) => {
        if (event.pointerType !== "touch") {
          updateOpenReasons(-3)
        }
      },
    }),
    [close]
  )

  return {
    anchor,
    anchorProps,
    close,
    open: openReasons > 0,
  }
}
