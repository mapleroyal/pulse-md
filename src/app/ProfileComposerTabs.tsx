import * as React from "react"

import { StartingTabRail } from "@/app/StartingTabRail"
import { axisInsertionIndex } from "@/app/tab-drag"
import { WindowProfileTabPreview } from "@/app/WindowProfileTabPreview"
import {
  windowProfileTabDisplayName,
  windowProfileTabDisplayPath,
} from "@/app/window-profile-tabs"
import type { FilePathDisplayMode, WindowProfileTab } from "@/shared/contracts"

const PROFILE_TAB_DRAG_TYPE = "application/x-pulse-md-profile-tab"

function movedTabs(
  tabs: readonly WindowProfileTab[],
  tabId: string,
  destination: number
) {
  const source = tabs.find((tab) => tab.id === tabId)
  if (!source) return [...tabs]
  const next = tabs.filter((tab) => tab.id !== tabId)
  next.splice(Math.max(0, Math.min(destination, next.length)), 0, source)
  return next
}

export function ProfileComposerTabs({
  activeTabId,
  disabled = false,
  display = "path",
  selectedTabId,
  tabs,
  onActiveTabChange,
  onReorder,
  onSelect,
}: {
  activeTabId: string
  disabled?: boolean
  display?: FilePathDisplayMode
  selectedTabId: string | null
  tabs: readonly WindowProfileTab[]
  onActiveTabChange: (tabId: string) => void
  onReorder: (tabs: WindowProfileTab[]) => void
  onSelect: (tabId: string) => void
}) {
  const listRef = React.useRef<HTMLOListElement>(null)
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null)
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)
  const [reorderAnnouncement, setReorderAnnouncement] = React.useState("")

  const previewTabs = React.useMemo(
    () =>
      draggingTabId && dropIndex !== null
        ? movedTabs(tabs, draggingTabId, dropIndex)
        : [...tabs],
    [draggingTabId, dropIndex, tabs]
  )

  const insertionIndex = React.useCallback(
    (clientY: number) => {
      const items = [
        ...(listRef.current?.querySelectorAll<HTMLElement>(
          "[data-profile-tab-id]"
        ) ?? []),
      ].map((item) => {
        const bounds = item.getBoundingClientRect()
        return {
          id: item.dataset.profileTabId ?? "",
          start: bounds.top,
          end: bounds.bottom,
        }
      })
      return axisInsertionIndex(items, draggingTabId, clientY)
    },
    [draggingTabId]
  )

  const moveByKeyboard = (tabId: string, direction: -1 | 1) => {
    const sourceIndex = tabs.findIndex((tab) => tab.id === tabId)
    const destination = sourceIndex + direction
    if (sourceIndex < 0 || destination < 0 || destination >= tabs.length) return
    const next = [...tabs]
    const [moved] = next.splice(sourceIndex, 1)
    if (!moved) return
    next.splice(destination, 0, moved)
    onReorder(next)
    setReorderAnnouncement(
      `${windowProfileTabDisplayName(moved)} moved to position ${destination + 1}.`
    )
  }

  return (
    <div className="flex w-fit max-w-full min-w-0 items-start gap-2">
      <p id="profile-tab-reorder-instructions" className="sr-only">
        Drag tabs to reorder them. With a keyboard, press Alt plus Up Arrow or
        Down Arrow.
      </p>
      <p aria-live="polite" className="sr-only">
        {reorderAnnouncement}
      </p>
      <ol
        ref={listRef}
        aria-label="Profile tabs"
        className="grid min-w-0 flex-none gap-2"
        onDragOver={(event) => {
          if (
            !draggingTabId ||
            !event.dataTransfer.types.includes(PROFILE_TAB_DRAG_TYPE)
          ) {
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          setDropIndex(insertionIndex(event.clientY))
        }}
        onDrop={(event) => {
          if (!draggingTabId) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          const destination = dropIndex ?? insertionIndex(event.clientY)
          const next = movedTabs(tabs, draggingTabId, destination)
          const movedIndex = next.findIndex((tab) => tab.id === draggingTabId)
          const moved = next[movedIndex]
          if (moved) {
            setReorderAnnouncement(
              `${windowProfileTabDisplayName(moved)} moved to position ${movedIndex + 1}.`
            )
          }
          onReorder(next)
          setDraggingTabId(null)
          setDropIndex(null)
        }}
      >
        {previewTabs.map((tab, index) => {
          const displayName = windowProfileTabDisplayName(tab)
          return (
            <li
              key={tab.id}
              className="grid min-w-0 grid-cols-[1.5rem_auto] items-center gap-2"
            >
              <span
                aria-hidden="true"
                className="text-right text-xs text-muted-foreground tabular-nums"
              >
                {index + 1}
              </span>
              <WindowProfileTabPreview
                active={tab.id === activeTabId}
                aria-describedby="profile-tab-reorder-instructions"
                aria-label={`Edit ${index + 1}: ${displayName}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                color={tab.color}
                data-profile-tab-id={tab.id}
                display={display}
                displayName={displayName}
                draggable={!disabled}
                dragging={tab.id === draggingTabId}
                filePath={windowProfileTabDisplayPath(tab)}
                selected={tab.id === selectedTabId}
                onClick={() => onSelect(tab.id)}
                onDragEnd={() => {
                  setDraggingTabId(null)
                  setDropIndex(null)
                }}
                onDragStart={(event) => {
                  setDraggingTabId(tab.id)
                  setDropIndex(
                    tabs.findIndex((candidate) => candidate.id === tab.id)
                  )
                  event.dataTransfer.effectAllowed = "move"
                  event.dataTransfer.setData(PROFILE_TAB_DRAG_TYPE, tab.id)

                  const bounds = event.currentTarget.getBoundingClientRect()
                  const visual = event.currentTarget.cloneNode(
                    true
                  ) as HTMLElement
                  visual.classList.add("document-tab-drag-visual")
                  visual.removeAttribute("data-profile-tab-id")
                  visual.removeAttribute("data-dragging")
                  visual.removeAttribute("draggable")
                  visual.removeAttribute("role")
                  visual.removeAttribute("tabindex")
                  visual.setAttribute("aria-hidden", "true")
                  visual.style.width = `${bounds.width}px`
                  visual.style.maxWidth = `${bounds.width}px`
                  document.body.append(visual)
                  event.dataTransfer.setDragImage(
                    visual,
                    event.clientX - bounds.left,
                    event.clientY - bounds.top
                  )
                  window.requestAnimationFrame(() => visual.remove())
                }}
                onKeyDown={(event) => {
                  if (!event.altKey) return
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveByKeyboard(tab.id, -1)
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveByKeyboard(tab.id, 1)
                  }
                }}
              />
            </li>
          )
        })}
      </ol>
      <StartingTabRail
        activeTabId={activeTabId}
        disabled={disabled}
        items={previewTabs.map((tab) => ({
          id: tab.id,
          label: windowProfileTabDisplayName(tab),
        }))}
        onActiveTabChange={onActiveTabChange}
      />
    </div>
  )
}
