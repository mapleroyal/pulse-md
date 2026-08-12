import * as React from "react"
import { ArrowLeftIcon } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const TAB_HEIGHT = 30
const TAB_GAP = 8

export interface StartingTabRailItem {
  readonly id: string
  readonly label: string
}

export function StartingTabRail({
  activeTabId,
  disabled = false,
  items,
  onActiveTabChange,
}: {
  activeTabId: string
  disabled?: boolean
  items: readonly StartingTabRailItem[]
  onActiveTabChange: (tabId: string) => void
}) {
  const railRef = React.useRef<HTMLDivElement>(null)
  const draggingPointerRef = React.useRef<number | null>(null)
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const [tooltipSuppressed, setTooltipSuppressed] = React.useState(false)
  const activeIndex = items.findIndex((item) => item.id === activeTabId)
  const activeItem = items[activeIndex]

  const activateNearest = React.useCallback(
    (clientY: number) => {
      const rail = railRef.current
      if (!rail || items.length === 0) return
      const y = clientY - rail.getBoundingClientRect().top
      const index = Math.max(
        0,
        Math.min(
          items.length - 1,
          Math.round((y - TAB_HEIGHT / 2) / (TAB_HEIGHT + TAB_GAP))
        )
      )
      const item = items[index]
      if (item && item.id !== activeTabId) onActiveTabChange(item.id)
    },
    [activeTabId, items, onActiveTabChange]
  )

  return (
    <div
      ref={railRef}
      aria-label="Starting tab selector"
      className="window-profile-starting-rail"
      data-profile-starting-rail=""
      style={{
        height:
          items.length === 0
            ? 0
            : items.length * TAB_HEIGHT + (items.length - 1) * TAB_GAP,
      }}
    >
      <span aria-hidden="true" className="window-profile-starting-rail-line" />
      <div className="grid gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            aria-label={`Make ${item.label} the starting tab`}
            aria-pressed={item.id === activeTabId}
            className="window-profile-starting-stop"
            disabled={disabled}
            type="button"
            onClick={() => onActiveTabChange(item.id)}
          />
        ))}
      </div>
      {activeItem ? (
        <Tooltip open={tooltipOpen && !tooltipSuppressed}>
          <TooltipTrigger
            render={
              <button
                aria-label={`Starting Tab: ${activeItem.label}`}
                className="window-profile-starting-thumb"
                disabled={disabled}
                style={{
                  top: activeIndex * (TAB_HEIGHT + TAB_GAP) + TAB_HEIGHT / 2,
                }}
                type="button"
                onBlur={() => setTooltipOpen(false)}
                onFocus={() => {
                  if (!tooltipSuppressed) setTooltipOpen(true)
                }}
                onKeyDown={(event) => {
                  let nextIndex = activeIndex
                  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    nextIndex -= 1
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowRight"
                  ) {
                    nextIndex += 1
                  } else if (event.key === "Home") {
                    nextIndex = 0
                  } else if (event.key === "End") {
                    nextIndex = items.length - 1
                  } else {
                    return
                  }
                  event.preventDefault()
                  const item =
                    items[Math.max(0, Math.min(items.length - 1, nextIndex))]
                  if (item) onActiveTabChange(item.id)
                }}
                onMouseEnter={() => {
                  if (!tooltipSuppressed) setTooltipOpen(true)
                }}
                onMouseLeave={() => {
                  setTooltipOpen(false)
                  setTooltipSuppressed(false)
                }}
                onPointerCancel={(event) => {
                  if (draggingPointerRef.current === event.pointerId) {
                    draggingPointerRef.current = null
                  }
                }}
                onPointerDown={(event) => {
                  if (disabled || event.button !== 0) return
                  event.preventDefault()
                  setTooltipOpen(false)
                  setTooltipSuppressed(true)
                  draggingPointerRef.current = event.pointerId
                  event.currentTarget.setPointerCapture(event.pointerId)
                  activateNearest(event.clientY)
                }}
                onPointerMove={(event) => {
                  if (draggingPointerRef.current !== event.pointerId) return
                  activateNearest(event.clientY)
                }}
                onPointerUp={(event) => {
                  if (draggingPointerRef.current !== event.pointerId) return
                  activateNearest(event.clientY)
                  draggingPointerRef.current = null
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
              />
            }
          >
            <ArrowLeftIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="right">Starting Tab</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
