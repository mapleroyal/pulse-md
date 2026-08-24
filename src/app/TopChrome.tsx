import * as React from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Code2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FilePenLineIcon,
  FileWarningIcon,
  FolderOpenIcon,
  HashIcon,
  ListTreeIcon,
  PanelTopIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ActiveTabIndicator } from "@/app/ActiveTabIndicator"
import {
  createRetryableDeferredLoader,
  useDeferredValue,
} from "@/app/deferred-loader"
import {
  DeferredPopoverFailure,
  DeferredSurfaceErrorBoundary,
} from "@/app/DeferredSurface"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PathLabel } from "@/app/PathLabel"
import { installHorizontalWheelScrolling } from "@/app/horizontal-wheel-scroll"
import { splitPath } from "@/app/path-label"
import { tabInsertionIndex } from "@/app/tab-drag"
import { topControlGroupWidth } from "@/app/top-control-layout"
import { WindowsMenuStrip } from "@/app/WindowsMenuStrip"
import { useLongTextPopover } from "@/components/ui/use-long-text-popover"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"
import type { MarkdownEditorMode } from "@/editor/types"
import type {
  AppPlatform,
  ChromeSettings,
  TabDragGeometry,
  TabDescriptor,
  TabId,
  TopRightControlKey,
  WindowAction,
} from "@/shared/contracts"

export const TAB_DRAG_MIME = "application/x-pulse-md-tab"
export type TabFocusPolicy = "editor" | "preserve" | "tablist"

const loadLongTextPopoverModule = createRetryableDynamicImport(
  () => import("@/components/ui/long-text-popover")
)
const loadCompactDocumentActionsModule = createRetryableDynamicImport(
  () => import("@/app/CompactDocumentActions")
)

const longTextPopoverLoader = createRetryableDeferredLoader(() =>
  loadLongTextPopoverModule().then((module) => module.default)
)
const compactDocumentActionsLoader = createRetryableDeferredLoader(() =>
  loadCompactDocumentActionsModule().then((module) => module.default)
)

type LongTextPopoverProps = React.ComponentProps<
  (typeof import("@/components/ui/long-text-popover"))["default"]
>

function DeferredLongTextPopover(props: LongTextPopoverProps) {
  const {
    error,
    retry,
    value: Surface,
  } = useDeferredValue(longTextPopoverLoader)
  const renderFailure = (retryAction: () => void) => (
    <DeferredPopoverFailure
      align="center"
      anchor={props.anchor}
      description="The full file path could not be displayed."
      open={props.open}
      side={props.side}
      title="File path unavailable"
      onOpenChange={props.onOpenChange}
      onRetry={retryAction}
    />
  )
  if (!Surface) return error ? renderFailure(retry) : null
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <Surface {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

type CompactDocumentActionsProps = React.ComponentProps<
  (typeof import("@/app/CompactDocumentActions"))["default"]
>

function DeferredCompactDocumentActions({
  fallback,
  ...props
}: CompactDocumentActionsProps & { fallback: React.ReactElement }) {
  const {
    error,
    retry,
    value: Surface,
  } = useDeferredValue(compactDocumentActionsLoader)
  const renderFailure = (retryAction: () => void) => (
    <DeferredPopoverFailure
      description="Document actions could not be loaded."
      open={props.open}
      title="Document actions unavailable"
      trigger={fallback}
      onOpenChange={props.onOpenChange}
      onRetry={retryAction}
    />
  )
  if (!Surface) return error ? renderFailure(retry) : fallback
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <Surface {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

interface DragEndDetails {
  cancelled: boolean
  dropped: boolean
  screenPoint: { x: number; y: number }
}

interface TopChromeProps {
  activeTabId: TabId
  canNavigateBack: boolean
  canNavigateForward: boolean
  chrome: ChromeSettings
  dragShelfVisible: boolean
  editorMode: MarkdownEditorMode
  editorPanelId: string
  hoverLatched: boolean
  hydratingTabIds: ReadonlySet<TabId>
  markdownControlsEnabled: boolean
  platform: AppPlatform
  tabDragActive: boolean
  tabDragSink: boolean
  tabs: TabDescriptor[]
  tabScrollerRef: React.RefObject<HTMLDivElement | null>
  windowZoomFactor: number
  previewTitle?: string
  onActivateTab: (tabId: TabId, focusPolicy: TabFocusPolicy) => void
  onBeginTabDrag: (tabId: TabId, geometry: TabDragGeometry) => string
  onCloseTab: (tabId: TabId) => void
  onDropTab: (dragToken: string, index: number) => Promise<boolean>
  onEndTabDrag: (
    tabId: TabId,
    dragToken: string,
    details: DragEndDetails
  ) => void
  onDragShelfVisibleChange: (visible: boolean) => void
  onFind: () => void
  onHoverLatchedChange: (latched: boolean) => void
  onHideTopControls: (controls: readonly TopRightControlKey[]) => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onEditScratch: (scratchId: string) => void
  onOpenSettings: () => void
  onOpenOutline: () => void
  outlineAnchorRef: React.RefObject<HTMLDivElement | null>
  outlineOpen: boolean
  renderOutlinePopover?: (trigger: React.ReactElement) => React.ReactNode
  onCopyPath: (tabId: TabId) => void
  onRevealPath: (tabId: TabId) => void
  onToggleFormattingToolbar: () => void
  onToggleMode: () => void
  onWindowAction: (action: WindowAction) => void
}

const WINDOW_CONTROLS_SAFE_INSET = 86
const WINDOWS_CAPTION_CONTROLS_WIDTH = 138

function DocumentContextMenu({
  children,
  finalFocus,
  pathActionsEnabled,
  platform,
  trigger,
  onCopyPath,
  onEditScratch,
  onRevealPath,
}: {
  children: React.ReactNode
  finalFocus?: React.ComponentProps<typeof ContextMenuContent>["finalFocus"]
  pathActionsEnabled: boolean
  platform: AppPlatform
  trigger: React.ReactElement
  onCopyPath: () => void
  onEditScratch?: () => void
  onRevealPath: () => void
}) {
  const revealLabel =
    platform === "darwin"
      ? "Reveal in Finder"
      : platform === "win32"
        ? "Show in File Explorer"
        : "Show in File Manager"

  return (
    <ContextMenu disabled={!pathActionsEnabled && !onEditScratch}>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      {pathActionsEnabled || onEditScratch ? (
        <ContextMenuContent className="min-w-48" finalFocus={finalFocus}>
          {onEditScratch ? (
            <ContextMenuItem onClick={onEditScratch}>
              <FilePenLineIcon />
              Edit Scratch
            </ContextMenuItem>
          ) : null}
          {pathActionsEnabled ? (
            <>
              <ContextMenuItem onClick={onCopyPath}>
                <CopyIcon />
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem onClick={onRevealPath}>
                <FolderOpenIcon />
                {revealLabel}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  )
}

function TopControlContextMenu({
  children,
  onHide,
}: {
  children: React.ReactNode
  onHide: () => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<span className="top-control-context-target" />}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Top-right controls menu"
        className="min-w-32"
        finalFocus={(interactionType) => interactionType === "keyboard"}
        side="left"
        sideOffset={4}
      >
        <ContextMenuItem onClick={onHide}>
          <EyeOffIcon />
          Hide
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function TabChip({
  active,
  detachable,
  display,
  dragging,
  editorPanelId,
  loading,
  tab,
  onActivate,
  onBeginDrag,
  onClose,
  onCopyPath,
  onDragEnd,
  onDragStart,
  onEditScratch,
  onRevealPath,
  platform,
  windowZoomFactor,
}: {
  active: boolean
  detachable: boolean
  display: ChromeSettings["tabDisplay"]
  dragging: boolean
  editorPanelId: string
  loading: boolean
  tab: TabDescriptor
  onActivate: () => void
  onBeginDrag: (geometry: TabDragGeometry) => string
  onClose: () => void
  onCopyPath: () => void
  onDragEnd: (event: React.DragEvent<HTMLDivElement>, token: string) => void
  onDragStart: (tabId: TabId) => void
  onEditScratch?: () => void
  onRevealPath: () => void
  platform: AppPlatform
  windowZoomFactor: number
}) {
  const label = splitPath(tab.filePath, tab.displayName)
  const contextMenuFocusRef = React.useRef<HTMLElement | null>(null)
  const contextMenuFocusTransferredRef = React.useRef(false)
  const dragTokenRef = React.useRef("")
  const dragVisualRef = React.useRef<{
    carrier: HTMLElement
    element: HTMLElement
    frame: number | null
    grabX: number
    grabY: number
    nextX: number
    nextY: number
    stripBounds: { bottom: number; left: number; right: number; top: number }
  } | null>(null)
  const tooltipLabel = tab.filePath ?? tab.displayName
  const accessibleLabel = tab.fileMissing
    ? `${tooltipLabel} — file deleted or moved`
    : tooltipLabel
  const tabAriaLabel = `${loading ? "Loading " : ""}${accessibleLabel}${
    tab.dirty ? ", modified" : ""
  }`
  const pathPopover = useLongTextPopover<HTMLDivElement>()

  const removeDragVisual = React.useCallback(() => {
    const visual = dragVisualRef.current
    dragVisualRef.current = null
    if (!visual) return
    if (visual.frame !== null) cancelAnimationFrame(visual.frame)
    visual.element.remove()
    visual.carrier.remove()
  }, [])

  React.useEffect(() => removeDragVisual, [removeDragVisual])

  const positionDragVisual = React.useCallback(
    (clientX: number, clientY: number) => {
      const visual = dragVisualRef.current
      if (!visual) return
      visual.nextX = clientX
      visual.nextY = clientY
      if (visual.frame !== null) return
      visual.frame = requestAnimationFrame(() => {
        visual.frame = null
        if (dragVisualRef.current !== visual) return
        const withinStrip =
          visual.nextX >= visual.stripBounds.left &&
          visual.nextX <= visual.stripBounds.right &&
          visual.nextY >= visual.stripBounds.top &&
          visual.nextY <= visual.stripBounds.bottom
        visual.element.hidden = !withinStrip
        if (!withinStrip) return
        visual.element.style.transform = `translate3d(${Math.round(
          visual.nextX - visual.grabX
        )}px, ${Math.round(visual.nextY - visual.grabY)}px, 0)`
      })
    },
    []
  )

  return (
    <>
      <DocumentContextMenu
        finalFocus={(interactionType) => {
          const focusTarget = contextMenuFocusRef.current
          contextMenuFocusRef.current = null
          if (contextMenuFocusTransferredRef.current) {
            contextMenuFocusTransferredRef.current = false
            return false
          }
          if (interactionType === "keyboard") return true
          return focusTarget?.isConnected ? focusTarget : false
        }}
        pathActionsEnabled={tab.filePath !== null}
        platform={platform}
        trigger={
          <div
            {...pathPopover.anchorProps}
            className="document-tab"
            data-active={active || undefined}
            data-dragging={dragging || undefined}
            data-loading={loading || undefined}
            data-tab-color={tab.color}
            data-tab-id={tab.id}
            draggable
            onPointerDownCapture={(event) => {
              const opensContextMenu =
                event.button === 2 ||
                (platform === "darwin" && event.button === 0 && event.ctrlKey)
              if (!opensContextMenu) return
              contextMenuFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null
            }}
            onContextMenuCapture={() => {
              pathPopover.close()
              if (contextMenuFocusRef.current) return
              contextMenuFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              pathPopover.close()
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }}
            onDrag={(event) => {
              if (event.clientX === 0 && event.clientY === 0) return
              positionDragVisual(event.clientX, event.clientY)
            }}
            onDragEnd={(event) => {
              removeDragVisual()
              onDragEnd(event, dragTokenRef.current)
            }}
            onDragStart={(event) => {
              pathPopover.close()
              const tabBounds = event.currentTarget.getBoundingClientRect()
              const strip = event.currentTarget.closest<HTMLElement>(
                ".document-tab-strip"
              )
              if (!strip) {
                event.preventDefault()
                return
              }
              const stripBounds = strip.getBoundingClientRect()
              const dragToken = onBeginDrag({
                cursorOffset: {
                  x:
                    (stripBounds.left + event.clientX - tabBounds.left) *
                    windowZoomFactor,
                  y: event.clientY * windowZoomFactor,
                },
                sourceStripBounds: {
                  x: window.screenX + stripBounds.left * windowZoomFactor,
                  y: window.screenY + stripBounds.top * windowZoomFactor,
                  width: stripBounds.width * windowZoomFactor,
                  height: stripBounds.height * windowZoomFactor,
                },
              })
              dragTokenRef.current = dragToken
              event.dataTransfer.effectAllowed = "move"
              event.dataTransfer.setData(TAB_DRAG_MIME, dragToken)
              if (detachable && dragToken) {
                const carrier = document.createElement("span")
                carrier.className = "document-tab-drag-carrier"
                document.body.append(carrier)
                event.dataTransfer.setDragImage(carrier, 0, 0)

                const element = event.currentTarget.cloneNode(
                  true
                ) as HTMLElement
                element.classList.add("document-tab-drag-visual")
                element.removeAttribute("data-tab-id")
                element.removeAttribute("data-dragging")
                element.removeAttribute("draggable")
                element.removeAttribute("role")
                element.removeAttribute("tabindex")
                element.setAttribute("aria-hidden", "true")
                element.inert = true
                const clonedActivation = element.querySelector<HTMLElement>(
                  ".document-tab-activation"
                )
                clonedActivation?.removeAttribute("id")
                clonedActivation?.removeAttribute("role")
                clonedActivation?.removeAttribute("tabindex")
                clonedActivation?.removeAttribute("data-tab-id")
                clonedActivation?.removeAttribute("aria-controls")
                clonedActivation?.removeAttribute("aria-selected")
                document.body.append(element)
                dragVisualRef.current = {
                  carrier,
                  element,
                  frame: null,
                  grabX: event.clientX - tabBounds.left,
                  grabY: event.clientY - tabBounds.top,
                  nextX: event.clientX,
                  nextY: event.clientY,
                  stripBounds: {
                    bottom: stripBounds.bottom,
                    left: stripBounds.left,
                    right: stripBounds.right,
                    top: stripBounds.top,
                  },
                }
                positionDragVisual(event.clientX, event.clientY)
              }
              onDragStart(tab.id)
            }}
          />
        }
        onCopyPath={onCopyPath}
        onEditScratch={
          onEditScratch
            ? () => {
                contextMenuFocusTransferredRef.current = true
                onEditScratch()
              }
            : undefined
        }
        onRevealPath={onRevealPath}
      >
        <ActiveTabIndicator />
        <button
          id={`document-tab-${tab.id}`}
          aria-controls={editorPanelId}
          aria-busy={loading || undefined}
          aria-label={tabAriaLabel}
          aria-selected={active}
          className="document-tab-activation document-tab-content"
          data-tab-id={tab.id}
          role="tab"
          tabIndex={active ? 0 : -1}
          type="button"
          onClick={onActivate}
        >
          {tab.color ? (
            <span
              aria-hidden="true"
              className="tab-color-mark"
              data-tab-color={tab.color}
            >
              <HashIcon strokeWidth={3} />
            </span>
          ) : null}
          <PathLabel
            className="tab-label"
            display={display}
            displayName={tab.displayName}
            filePath={tab.filePath}
          />
          {tab.fileMissing ? (
            <FileWarningIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-destructive"
            />
          ) : null}
          {loading ? (
            <span aria-hidden="true" className="tab-loading-indicator" />
          ) : null}
          {tab.dirty ? (
            <span aria-hidden="true" className="tab-dirty-dot" />
          ) : null}
        </button>
        <button
          aria-label={`Close ${label.filename}`}
          className="tab-close"
          tabIndex={active ? 0 : -1}
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </DocumentContextMenu>
      {pathPopover.open ? (
        <DeferredLongTextPopover
          anchor={pathPopover.anchor}
          label="Full file path"
          open={pathPopover.open}
          side="bottom"
          onOpenChange={(open) => {
            if (!open) pathPopover.close()
          }}
        >
          <span data-tab-path-popover-text="">{accessibleLabel}</span>
        </DeferredLongTextPopover>
      ) : null}
    </>
  )
}

export function TopChrome({
  activeTabId,
  canNavigateBack,
  canNavigateForward,
  chrome,
  dragShelfVisible,
  editorMode,
  editorPanelId,
  hoverLatched,
  hydratingTabIds,
  markdownControlsEnabled,
  platform,
  tabDragActive,
  tabDragSink,
  tabs,
  tabScrollerRef,
  windowZoomFactor,
  previewTitle,
  onActivateTab,
  onBeginTabDrag,
  onCloseTab,
  onCopyPath,
  onDropTab,
  onEndTabDrag,
  onDragShelfVisibleChange,
  onFind,
  onHoverLatchedChange,
  onHideTopControls,
  onNavigateBack,
  onNavigateForward,
  onEditScratch,
  onOpenSettings,
  onOpenOutline,
  onRevealPath,
  outlineAnchorRef,
  outlineOpen,
  renderOutlinePopover,
  onToggleFormattingToolbar,
  onToggleMode,
  onWindowAction,
}: TopChromeProps) {
  const [draggingTabId, setDraggingTabId] = React.useState<TabId | null>(null)
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [documentActionsActivated, setDocumentActionsActivated] =
    React.useState(false)
  const [documentActionsOpen, setDocumentActionsOpen] = React.useState(false)
  const [windowsMenuVisible, setWindowsMenuVisible] = React.useState(false)
  const chromeRef = React.useRef<HTMLElement>(null)
  const dragCancelledRef = React.useRef(false)
  const dragChipBoundsRef = React.useRef<Array<{
    id: string
    left: number
    right: number
  }> | null>(null)
  const revealedActiveTabIdRef = React.useRef<TabId | null>(null)
  const revealedTabStripRef = React.useRef<HTMLDivElement | null>(null)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  const handleTabListKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const currentTab = target.closest<HTMLElement>('[role="tab"]')
      if (!currentTab || target !== currentTab) return

      const tabElements = [
        ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
      ]
      const currentIndex = tabElements.indexOf(currentTab)
      if (currentIndex < 0 || tabElements.length === 0) return

      let nextIndex: number
      switch (event.key) {
        case "ArrowLeft":
          nextIndex =
            (currentIndex - 1 + tabElements.length) % tabElements.length
          break
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % tabElements.length
          break
        case "Home":
          nextIndex = 0
          break
        case "End":
          nextIndex = tabElements.length - 1
          break
        default:
          return
      }

      event.preventDefault()
      const nextTab = tabElements[nextIndex]!
      const tabId = nextTab.closest<HTMLElement>(".document-tab")?.dataset.tabId
      if (tabId) onActivateTab(tabId, "tablist")
      nextTab.focus({ preventScroll: true })
      nextTab.ownerDocument.defaultView?.requestAnimationFrame(() => {
        if (nextTab.isConnected) nextTab.focus({ preventScroll: true })
      })
    },
    [onActivateTab]
  )

  React.useEffect(() => {
    const surface = chromeRef.current
    const strip = tabScrollerRef.current
    if (!surface || !strip) return
    return installHorizontalWheelScrolling(
      surface,
      strip,
      chrome.tabWheelScrollDirection
    )
  }, [
    chrome.tabVisibility,
    chrome.tabWheelScrollDirection,
    previewTitle,
    tabScrollerRef,
  ])

  React.useEffect(() => {
    dragChipBoundsRef.current = null
  }, [
    chrome.tabDisplay,
    chrome.tabVisibility,
    draggingTabId,
    dropIndex,
    tabs,
    windowZoomFactor,
  ])

  React.useLayoutEffect(() => {
    const strip = tabScrollerRef.current
    if (!strip) {
      revealedTabStripRef.current = null
      return
    }
    if (
      revealedTabStripRef.current === strip &&
      revealedActiveTabIdRef.current === activeTabId
    ) {
      return
    }
    const activeChip = strip.querySelector<HTMLElement>(
      ".document-tab[data-active]"
    )
    if (!activeChip) return
    revealedTabStripRef.current = strip
    revealedActiveTabIdRef.current = activeTabId

    const stripBounds = strip.getBoundingClientRect()
    const activeBounds = activeChip.getBoundingClientRect()
    const clippedAtStart = stripBounds.left - activeBounds.left
    const clippedAtEnd = activeBounds.right - stripBounds.right
    if (clippedAtStart > 0.5) {
      strip.scrollLeft -= clippedAtStart
    } else if (clippedAtEnd > 0.5) {
      strip.scrollLeft += clippedAtEnd
    }
  })

  React.useEffect(() => {
    const strip = tabScrollerRef.current
    if (!strip) return
    let previousStripWidth = strip.clientWidth
    const invalidate = () => {
      dragChipBoundsRef.current = null
    }
    const handleResize = () => {
      invalidate()
      const nextStripWidth = strip.clientWidth
      const stripShrank = nextStripWidth < previousStripWidth - 0.5
      previousStripWidth = nextStripWidth
      if (!stripShrank) return

      // Revealed controls move the strip's trailing edge. Preserve the scroll
      // offset unless the resized viewport would clip the active tab.
      const activeChip = strip.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      if (!activeChip) return
      const stripBounds = strip.getBoundingClientRect()
      const activeBounds = activeChip.getBoundingClientRect()
      const clippedAtStart = stripBounds.left - activeBounds.left
      const clippedAtEnd = activeBounds.right - stripBounds.right
      if (clippedAtStart > 0.5) {
        strip.scrollLeft -= clippedAtStart
      } else if (clippedAtEnd > 0.5) {
        strip.scrollLeft += clippedAtEnd
      }
    }
    const ownerWindow = strip.ownerDocument.defaultView
    const resizeObserver = ownerWindow?.ResizeObserver
      ? new ownerWindow.ResizeObserver(handleResize)
      : null
    resizeObserver?.observe(strip)
    const content = strip.querySelector<HTMLElement>(
      ".document-tab-strip-content"
    )
    if (content) resizeObserver?.observe(content)
    strip.addEventListener("scroll", invalidate, { passive: true })
    strip.ownerDocument.fonts.addEventListener("loadingdone", invalidate)
    return () => {
      resizeObserver?.disconnect()
      strip.removeEventListener("scroll", invalidate)
      strip.ownerDocument.fonts.removeEventListener("loadingdone", invalidate)
    }
  }, [
    chrome.tabVisibility,
    dragOver,
    previewTitle,
    tabDragActive,
    tabScrollerRef,
  ])

  React.useEffect(() => {
    if (!draggingTabId) return
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return
      }
      event.stopPropagation()
      dragCancelledRef.current = true
    }
    window.addEventListener("keydown", cancel, true)
    return () => window.removeEventListener("keydown", cancel, true)
  }, [draggingTabId])

  React.useEffect(() => {
    if (!hoverLatched) return
    const handlePointerMove = (event: PointerEvent) => {
      const chromeElement = chromeRef.current
      if (!chromeElement) return
      const chromeBounds = chromeElement.getBoundingClientRect()
      const hoverBounds =
        outlineAnchorRef.current?.getBoundingClientRect() ?? chromeBounds
      if (
        event.clientX < chromeBounds.left ||
        event.clientX >= chromeBounds.right ||
        event.clientY < chromeBounds.top ||
        event.clientY >= hoverBounds.bottom
      ) {
        onHoverLatchedChange(false)
      }
    }
    const clearOnBlur = () => {
      onHoverLatchedChange(false)
    }
    window.addEventListener("pointermove", handlePointerMove, true)
    window.addEventListener("blur", clearOnBlur)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true)
      window.removeEventListener("blur", clearOnBlur)
    }
  }, [hoverLatched, onHoverLatchedChange, outlineAnchorRef])

  const leaveHoverSensor = React.useCallback(
    (
      edge: "top" | "right" | "bottom" | "left",
      event: React.PointerEvent<HTMLDivElement>
    ) => {
      const bounds = event.currentTarget.getBoundingClientRect()
      const exitedChrome =
        (edge === "top" && event.clientY <= bounds.top) ||
        (edge === "right" && event.clientX >= bounds.right) ||
        (edge === "bottom" && event.clientY >= bounds.bottom) ||
        (edge === "left" && event.clientX <= bounds.left)
      if (exitedChrome) onHoverLatchedChange(false)
    },
    [onHoverLatchedChange]
  )

  const insertionIndex = React.useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const strip = event.currentTarget
      const chips =
        dragChipBoundsRef.current ??
        [
          ...strip.querySelectorAll<HTMLElement>(".document-tab[data-tab-id]"),
        ].map((chip) => {
          const bounds = chip.getBoundingClientRect()
          return {
            id: chip.dataset.tabId ?? "",
            left: bounds.left,
            right: bounds.right,
          }
        })
      dragChipBoundsRef.current = chips
      return tabInsertionIndex(chips, draggingTabId, event.clientX)
    },
    [draggingTabId]
  )

  const previewTabs = React.useMemo(() => {
    if (!draggingTabId || dropIndex === null) return tabs
    const dragged = tabs.find((tab) => tab.id === draggingTabId)
    if (!dragged) return tabs
    const next = tabs.filter((tab) => tab.id !== draggingTabId)
    next.splice(Math.min(dropIndex, next.length), 0, dragged)
    return next
  }, [draggingTabId, dropIndex, tabs])
  const receivingDropIndex =
    dragOver && !draggingTabId && dropIndex !== null
      ? Math.min(dropIndex, previewTabs.length)
      : null
  const formattingBarVisible =
    markdownControlsEnabled && chrome.showFormattingBar
  const tabsPinned =
    chrome.tabVisibility === "always" ||
    (chrome.tabVisibility === "multiple-tabs" && tabs.length > 1) ||
    (chrome.tabVisibility === "formatting-bar" && formattingBarVisible)
  const tabsHidden = chrome.tabVisibility === "hidden"

  const tabsVisible =
    !previewTitle &&
    (tabDragActive ||
      dragOver ||
      (!tabsHidden && (tabsPinned || hoverLatched || outlineOpen)))

  const showNavigation =
    !previewTitle &&
    chrome.topRightControls.navigation &&
    (canNavigateBack || canNavigateForward)
  const showBack = showNavigation
  const showForward = showNavigation
  const showViewMode =
    !previewTitle && markdownControlsEnabled && chrome.topRightControls.viewMode
  const showFind = !previewTitle && chrome.topRightControls.find
  const showOutline =
    !previewTitle && markdownControlsEnabled && chrome.topRightControls.outline
  const showFormattingToolbar =
    !previewTitle &&
    markdownControlsEnabled &&
    chrome.topRightControls.formattingToolbar
  const showSettings = !previewTitle && chrome.topRightControls.settings
  const navigationControlCount = Number(showBack) + Number(showForward)
  const actionControlCount =
    Number(showViewMode) +
    Number(showFind) +
    Number(showOutline) +
    Number(showFormattingToolbar) +
    Number(showSettings)
  const showNavigationSeparator =
    navigationControlCount > 0 && actionControlCount > 0
  const wideControlWidth = topControlGroupWidth(
    navigationControlCount + actionControlCount,
    showNavigationSeparator
  )
  const compactControlKeys: TopRightControlKey[] = []
  if (showNavigation) compactControlKeys.push("navigation")
  if (showViewMode) compactControlKeys.push("viewMode")
  if (showFind) compactControlKeys.push("find")
  if (showOutline) compactControlKeys.push("outline")
  if (showFormattingToolbar) compactControlKeys.push("formattingToolbar")
  const showCompactDocumentActions = compactControlKeys.length > 0
  const compactControlWidth = topControlGroupWidth(
    Number(showCompactDocumentActions) + Number(showSettings),
    false
  )
  const showControlCluster = wideControlWidth > 0 || compactControlWidth > 0
  const windowsChrome = platform === "win32"
  const windowsMenuOpen = windowsChrome && !previewTitle && windowsMenuVisible
  const hiddenForWindowsMenuStyle: React.CSSProperties | undefined =
    windowsMenuOpen ? { opacity: 0, pointerEvents: "none" } : undefined

  const documentActionsFallback = (
    <Button
      aria-label="Document actions"
      className="top-chrome-document-menu"
      size="icon-sm"
      type="button"
      variant="ghost"
      onClick={() => {
        setDocumentActionsOpen(true)
        setDocumentActionsActivated(true)
      }}
      onFocus={() =>
        void compactDocumentActionsLoader.load().catch(() => undefined)
      }
      onPointerEnter={() =>
        void compactDocumentActionsLoader.load().catch(() => undefined)
      }
    >
      <span aria-hidden="true" className="top-chrome-document-menu-glyph">
        …
      </span>
    </Button>
  )

  return (
    <TooltipProvider>
      <header
        ref={chromeRef}
        className="top-chrome"
        data-platform={platform}
        data-pinned-tabs={tabsPinned || undefined}
        data-hover-chrome={hoverLatched || undefined}
        data-hover-tabs={(!tabsHidden && hoverLatched) || undefined}
        data-outline-open={outlineOpen || undefined}
        data-compact-zoom={windowZoomFactor <= 1 || undefined}
        data-formatting-bar={formattingBarVisible || undefined}
        data-markdown-controls={markdownControlsEnabled || undefined}
        data-always-show-controls={chrome.alwaysShowTopControls || undefined}
        data-tab-drag-shelf={dragShelfVisible || undefined}
        data-tab-drag-active={tabDragActive || undefined}
        data-drag-over={dragOver || undefined}
        data-windows-menu-open={windowsMenuOpen || undefined}
        style={
          {
            "--top-chrome-controls-reserved-width": `${
              wideControlWidth > 0 ? wideControlWidth + 24 : 8
            }px`,
            "--top-chrome-narrow-controls-reserved-width": `${
              wideControlWidth > 0 ? wideControlWidth + 16 : 8
            }px`,
            "--top-chrome-compact-controls-reserved-width": `${
              compactControlWidth > 0 ? compactControlWidth + 16 : 8
            }px`,
            "--window-controls-safe-inset": `${
              platform === "darwin"
                ? WINDOW_CONTROLS_SAFE_INSET / windowZoomFactor
                : WINDOW_CONTROLS_SAFE_INSET
            }px`,
            "--windows-caption-controls-inset": `${
              windowsChrome
                ? WINDOWS_CAPTION_CONTROLS_WIDTH / windowZoomFactor
                : 0
            }px`,
            "--tc-hover-right": windowsChrome
              ? "var(--windows-caption-controls-safe-inset)"
              : "50px",
            "--tc-left": "auto",
            "--tc-right": windowsChrome
              ? "var(--windows-app-controls-right)"
              : "var(--tc-edge)",
            "--cf-max": windowsChrome
              ? "max(0px, calc(100% - max(var(--windows-caption-controls-safe-inset), var(--cf-rest, 0px)) * 2))"
              : "calc(100% - var(--window-controls-safe-inset) * 2)",
            "--cf-active": windowsChrome
              ? "max(0px, calc(100% - var(--windows-active-top-safe-inset) * 2))"
              : "calc(100% - var(--window-controls-safe-inset) * 2)",
            "--tab-left": windowsChrome
              ? "8px"
              : "var(--window-controls-safe-inset)",
            "--tab-right": windowsChrome
              ? "var(--windows-active-top-safe-inset)"
              : "8px",
            "--tab-active-left": windowsChrome
              ? "8px"
              : "var(--window-controls-safe-inset)",
            "--tab-active-right": windowsChrome
              ? "var(--windows-active-top-safe-inset)"
              : "var(--tc-current)",
            "--tab-inset": windowsChrome
              ? "var(--windows-caption-controls-inset)"
              : "var(--window-controls-safe-inset)",
            "--tab-narrow-offset": windowsChrome ? "66px" : "58px",
            "--tab-compact-offset": windowsChrome ? "94px" : "86px",
            WebkitAppRegion: windowsMenuOpen ? "no-drag" : undefined,
          } as React.CSSProperties
        }
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          if (tabDragSink) return
          setDragOver(true)
          setDropIndex(insertionIndex(event))
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null))
            return
          setDragOver(false)
          setDropIndex(null)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          if (tabDragSink) return
          setDragOver(true)
          setDropIndex(insertionIndex(event))
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          const dragToken = event.dataTransfer.getData(TAB_DRAG_MIME)
          const index = dropIndex ?? insertionIndex(event)
          setDragOver(false)
          setDropIndex(null)
          if (dragToken) void onDropTab(dragToken, index)
        }}
      >
        {windowsChrome && !previewTitle ? (
          <WindowsMenuStrip
            visible={windowsMenuVisible}
            onVisibleChange={setWindowsMenuVisible}
          />
        ) : null}
        {!previewTitle ? (
          <div
            ref={outlineAnchorRef}
            aria-hidden="true"
            className="top-chrome-hover-region"
            style={hiddenForWindowsMenuStyle}
          />
        ) : null}
        {!previewTitle ? (
          <div
            aria-hidden="true"
            className="top-chrome-tab-drag-shelf"
            style={windowsMenuOpen ? { pointerEvents: "none" } : undefined}
          />
        ) : null}
        {!previewTitle &&
        !windowsMenuOpen &&
        !hoverLatched &&
        !dragOver &&
        !tabDragActive ? (
          <div
            aria-hidden="true"
            className="top-chrome-hover-activation"
            onPointerEnter={() => onHoverLatchedChange(true)}
          />
        ) : null}
        {!previewTitle && !windowsMenuOpen ? (
          <>
            <div
              aria-hidden="true"
              className="top-chrome-hover-sensor top-chrome-hover-sensor-top"
              onPointerEnter={() => onHoverLatchedChange(true)}
              onPointerLeave={(event) => leaveHoverSensor("top", event)}
            />
            <div
              aria-hidden="true"
              className="top-chrome-hover-sensor top-chrome-hover-sensor-left"
              onPointerEnter={() => onHoverLatchedChange(true)}
              onPointerLeave={(event) => leaveHoverSensor("left", event)}
            />
            <div
              aria-hidden="true"
              className="top-chrome-hover-sensor top-chrome-hover-sensor-right"
              onPointerEnter={() => onHoverLatchedChange(true)}
              onPointerLeave={(event) => leaveHoverSensor("right", event)}
            />
            <div
              aria-hidden="true"
              className="top-chrome-hover-sensor top-chrome-hover-sensor-bottom"
              onPointerEnter={() => onHoverLatchedChange(true)}
              onPointerLeave={(event) => leaveHoverSensor("bottom", event)}
            />
          </>
        ) : null}
        {platform === "linux" ? (
          <div aria-label="Window controls" className="window-controls">
            <button
              aria-label="Close window"
              className="window-control window-control-close"
              type="button"
              onClick={() => onWindowAction("close")}
            />
            <button
              aria-label="Minimize window"
              className="window-control window-control-minimize"
              type="button"
              onClick={() => onWindowAction("minimize")}
            />
            <button
              aria-label="Maximize or restore window"
              className="window-control window-control-maximize"
              type="button"
              onClick={() => onWindowAction("toggle-maximize")}
            />
          </div>
        ) : null}

        {showControlCluster ? (
          <div
            className="top-chrome-controls"
            style={hiddenForWindowsMenuStyle}
          >
            {showBack ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["navigation"])}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Back"
                        className="top-chrome-navigation-back top-chrome-expandable-control"
                        disabled={!canNavigateBack}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onNavigateBack}
                      />
                    }
                  >
                    <ArrowLeftIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Back</TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showForward ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["navigation"])}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Forward"
                        className="top-chrome-navigation-forward top-chrome-expandable-control"
                        disabled={!canNavigateForward}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onNavigateForward}
                      />
                    }
                  >
                    <ArrowRightIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Forward</TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showNavigationSeparator ? (
              <div
                aria-hidden="true"
                className="top-chrome-navigation-separator top-chrome-expandable-control"
              />
            ) : null}
            {showViewMode ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["viewMode"])}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={
                          editorMode === "live"
                            ? "Switch to Raw Markdown"
                            : "Switch to Rendered Markdown"
                        }
                        className="top-chrome-view-mode top-chrome-expandable-control"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onToggleMode}
                      />
                    }
                  >
                    {editorMode === "live" ? (
                      <Code2Icon aria-hidden="true" />
                    ) : (
                      <EyeIcon aria-hidden="true" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {editorMode === "live"
                      ? "Switch to Raw Markdown"
                      : "Switch to Rendered Markdown"}{" "}
                    ({platform === "darwin" ? "⌘⇧V" : "Ctrl+Shift+V"})
                  </TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showFind ? (
              <TopControlContextMenu onHide={() => onHideTopControls(["find"])}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Find"
                        className="top-chrome-find top-chrome-expandable-control"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onFind}
                      />
                    }
                  >
                    <SearchIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Find ({platform === "darwin" ? "⌘F" : "Ctrl+F"})
                  </TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showOutline ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["outline"])}
              >
                <Tooltip>
                  {renderOutlinePopover?.(
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Document outline"
                          aria-expanded={outlineOpen}
                          className="top-chrome-outline top-chrome-expandable-control"
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={onOpenOutline}
                        />
                      }
                    >
                      <ListTreeIcon aria-hidden="true" />
                    </TooltipTrigger>
                  ) ?? (
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Document outline"
                          aria-expanded={outlineOpen}
                          className="top-chrome-outline top-chrome-expandable-control"
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={onOpenOutline}
                        />
                      }
                    >
                      <ListTreeIcon aria-hidden="true" />
                    </TooltipTrigger>
                  )}
                  <TooltipContent side="bottom">
                    Outline ({platform === "darwin" ? "⌘⇧O" : "Ctrl+Shift+O"})
                  </TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showFormattingToolbar ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["formattingToolbar"])}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Formatting toolbar"
                        aria-pressed={chrome.showFormattingBar}
                        className="top-chrome-formatting-toolbar top-chrome-expandable-control"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onToggleFormattingToolbar}
                      />
                    }
                  >
                    <PanelTopIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Toggle formatting toolbar (
                    {platform === "darwin" ? "⌘⇧B" : "Ctrl+Shift+B"})
                  </TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
            {showCompactDocumentActions ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(compactControlKeys)}
              >
                {documentActionsActivated ? (
                  <DeferredCompactDocumentActions
                    canNavigateBack={canNavigateBack}
                    canNavigateForward={canNavigateForward}
                    controls={chrome.topRightControls}
                    editorMode={editorMode}
                    fallback={documentActionsFallback}
                    formattingBarVisible={chrome.showFormattingBar}
                    markdownControlsEnabled={markdownControlsEnabled}
                    open={documentActionsOpen}
                    onFind={onFind}
                    onNavigateBack={onNavigateBack}
                    onNavigateForward={onNavigateForward}
                    onOpenChange={setDocumentActionsOpen}
                    onOpenOutline={onOpenOutline}
                    onToggleFormattingToolbar={onToggleFormattingToolbar}
                    onToggleMode={onToggleMode}
                  />
                ) : (
                  documentActionsFallback
                )}
              </TopControlContextMenu>
            ) : null}
            {showSettings ? (
              <TopControlContextMenu
                onHide={() => onHideTopControls(["settings"])}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Settings"
                        className="top-chrome-settings"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={onOpenSettings}
                      />
                    }
                  >
                    <SettingsIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Settings</TooltipContent>
                </Tooltip>
              </TopControlContextMenu>
            ) : null}
          </div>
        ) : null}

        {previewTitle ? (
          <div
            className="centered-file-label z-[2]"
            data-preview-title
            style={hiddenForWindowsMenuStyle}
          >
            <span className="centered-file-surface">{previewTitle}</span>
          </div>
        ) : activeTab && chrome.showCenteredPath ? (
          <div
            aria-hidden={tabsVisible}
            className="centered-file-label z-[2]"
            data-hidden={tabsVisible || undefined}
            style={hiddenForWindowsMenuStyle}
            onPointerEnter={() => onHoverLatchedChange(true)}
          >
            <DocumentContextMenu
              pathActionsEnabled={activeTab.filePath !== null}
              platform={platform}
              trigger={<span className="centered-file-surface" />}
              onCopyPath={() => onCopyPath(activeTab.id)}
              onRevealPath={() => onRevealPath(activeTab.id)}
            >
              <PathLabel
                className="file-label-content"
                display={chrome.centeredPathDisplay}
                displayName={activeTab.displayName}
                filePath={activeTab.filePath}
              />
            </DocumentContextMenu>
          </div>
        ) : null}

        {!previewTitle && (!tabsHidden || tabDragActive || dragOver) ? (
          <div
            ref={tabScrollerRef}
            aria-label="Open documents"
            aria-orientation="horizontal"
            className="document-tab-strip"
            data-visible={tabsVisible || undefined}
            role="tablist"
            style={hiddenForWindowsMenuStyle}
            onPointerEnter={() => {
              onHoverLatchedChange(true)
              onDragShelfVisibleChange(true)
            }}
            onPointerMove={() => onDragShelfVisibleChange(true)}
            onKeyDown={handleTabListKeyDown}
          >
            <div className="document-tab-strip-content">
              {previewTabs.map((tab, index) => (
                <React.Fragment key={tab.id}>
                  {receivingDropIndex === index ? (
                    <div
                      aria-hidden="true"
                      className="document-tab-drop-placeholder"
                    />
                  ) : null}
                  <TabChip
                    active={tab.id === activeTabId}
                    detachable={tabs.length > 1}
                    display={chrome.tabDisplay}
                    dragging={tab.id === draggingTabId}
                    editorPanelId={editorPanelId}
                    loading={hydratingTabIds.has(tab.id)}
                    tab={tab}
                    onActivate={() => onActivateTab(tab.id, "editor")}
                    onBeginDrag={(geometry) => onBeginTabDrag(tab.id, geometry)}
                    onClose={() => onCloseTab(tab.id)}
                    onCopyPath={() => onCopyPath(tab.id)}
                    onDragStart={(tabId) => {
                      dragCancelledRef.current = false
                      dragChipBoundsRef.current = null
                      setDraggingTabId(tabId)
                    }}
                    onEditScratch={
                      tab.scratchId
                        ? () => onEditScratch(tab.scratchId!)
                        : undefined
                    }
                    onDragEnd={(event, dragToken) => {
                      const dropped = event.dataTransfer.dropEffect === "move"
                      const cancelled = dragCancelledRef.current
                      setDraggingTabId(null)
                      setDropIndex(null)
                      setDragOver(false)
                      onEndTabDrag(tab.id, dragToken, {
                        cancelled,
                        dropped,
                        screenPoint: { x: event.screenX, y: event.screenY },
                      })
                    }}
                    onRevealPath={() => onRevealPath(tab.id)}
                    platform={platform}
                    windowZoomFactor={windowZoomFactor}
                  />
                </React.Fragment>
              ))}
              {receivingDropIndex === previewTabs.length ? (
                <div
                  aria-hidden="true"
                  className="document-tab-drop-placeholder"
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </header>
    </TooltipProvider>
  )
}
