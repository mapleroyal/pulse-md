import * as React from "react"

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { AppPlatform } from "@/shared/contracts"

export type OutlineHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * The document-owned heading data needed by the transient outline.
 *
 * Keeping this type structural lets the editor's heading index remain the
 * source of truth without mirroring document text into React.
 */
export interface OutlineHeading {
  from: number
  to: number
  level: OutlineHeadingLevel
  plainText: string
  slug: string
}

export interface OutlinePopoverProps {
  anchor: React.RefObject<Element | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  headings: readonly OutlineHeading[]
  platform: AppPlatform
  activeHeading?: OutlineHeading | null
  onHeadingSelect: (heading: OutlineHeading) => void
  /** Focuses the document (or another owner-selected target) after closing. */
  restoreFocus?: () => void
  /** The top-chrome button that opens the transient outline. */
  trigger: React.ReactElement
}

interface SearchableHeading {
  heading: OutlineHeading
  searchText: string
  value: string
}

const levelIndent: Record<OutlineHeadingLevel, string> = {
  1: "pl-3",
  2: "pl-6",
  3: "pl-9",
  4: "pl-12",
  5: "pl-15",
  6: "pl-18",
}
const OUTLINE_ROW_HEIGHT = 36
const OUTLINE_LIST_PADDING = 6
const OUTLINE_WINDOW_SIZE = 48
const OUTLINE_WINDOW_OVERSCAN = 12

function headingValue(heading: OutlineHeading) {
  return `${heading.from}:${heading.level}:${heading.slug}`
}

function headingLabel(heading: OutlineHeading) {
  return heading.plainText.trim() || "Untitled heading"
}

function normalizedSearchText(value: string) {
  return value.trim().toLocaleLowerCase()
}

function matchesQuery(entry: SearchableHeading, query: string) {
  const terms = normalizedSearchText(query).split(/\s+/).filter(Boolean)
  return terms.every((term) => entry.searchText.includes(term))
}

interface OutlineCommandProps {
  headings: readonly OutlineHeading[]
  activeHeading: OutlineHeading | null
  onHeadingSelect: (heading: OutlineHeading) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  platform: AppPlatform
}

function OutlineCommand({
  headings,
  activeHeading,
  onHeadingSelect,
  inputRef,
  platform,
}: OutlineCommandProps) {
  const [query, setQuery] = React.useState("")
  const listRef = React.useRef<HTMLDivElement>(null)
  const scrollFrameRef = React.useRef<number | null>(null)

  const searchableHeadings = React.useMemo<readonly SearchableHeading[]>(
    () =>
      headings.map((heading) => ({
        heading,
        searchText: normalizedSearchText(
          `${headingLabel(heading)} ${heading.slug} h${heading.level}`
        ),
        value: headingValue(heading),
      })),
    [headings]
  )
  const filteredHeadings = React.useMemo(
    () =>
      query
        ? searchableHeadings.filter((entry) => matchesQuery(entry, query))
        : searchableHeadings,
    [query, searchableHeadings]
  )
  const headingByValue = React.useMemo(
    () => new Map(searchableHeadings.map((entry) => [entry.value, entry])),
    [searchableHeadings]
  )
  const filteredIndexByValue = React.useMemo(
    () =>
      new Map(
        filteredHeadings.map((entry, index) => [entry.value, index] as const)
      ),
    [filteredHeadings]
  )
  const activeValue = activeHeading ? headingValue(activeHeading) : ""
  const initialSelectedValue = headingByValue.has(activeValue)
    ? activeValue
    : (searchableHeadings[0]?.value ?? "")
  const initialSelectedIndex = Math.max(
    0,
    searchableHeadings.findIndex(
      (entry) => entry.value === initialSelectedValue
    )
  )
  const initialScrollTop = Math.max(
    0,
    OUTLINE_LIST_PADDING +
      (initialSelectedIndex - OUTLINE_WINDOW_OVERSCAN) * OUTLINE_ROW_HEIGHT
  )
  const [selectedValue, setSelectedValue] = React.useState(initialSelectedValue)
  const selectedValueRef = React.useRef(initialSelectedValue)
  const scrollTopRef = React.useRef(initialScrollTop)
  const [virtualScrollTop, setVirtualScrollTop] =
    React.useState(initialScrollTop)
  const effectiveSelectedValue = filteredIndexByValue.has(selectedValue)
    ? selectedValue
    : (filteredHeadings[0]?.value ?? "")
  const selectedIndex = filteredIndexByValue.get(effectiveSelectedValue) ?? -1
  const visibleWindowStart = (windowSize: number) =>
    Math.min(
      Math.max(0, filteredHeadings.length - windowSize),
      Math.max(
        0,
        Math.floor(
          (virtualScrollTop - OUTLINE_LIST_PADDING) / OUTLINE_ROW_HEIGHT
        ) - OUTLINE_WINDOW_OVERSCAN
      )
    )
  let visibleWindowSize = OUTLINE_WINDOW_SIZE
  let windowStart = visibleWindowStart(visibleWindowSize)
  let windowEnd = Math.min(
    filteredHeadings.length,
    windowStart + visibleWindowSize
  )
  const selectedIsOutsideWindow =
    selectedIndex >= 0 &&
    (selectedIndex < windowStart || selectedIndex >= windowEnd)
  if (selectedIsOutsideWindow) {
    visibleWindowSize -= 1
    windowStart = visibleWindowStart(visibleWindowSize)
    windowEnd = Math.min(
      filteredHeadings.length,
      windowStart + visibleWindowSize
    )
  }
  const renderedHeadingIndices = Array.from(
    { length: Math.max(0, windowEnd - windowStart) },
    (_, offset) => windowStart + offset
  )
  if (selectedIsOutsideWindow) {
    renderedHeadingIndices.push(selectedIndex)
    renderedHeadingIndices.sort((left, right) => left - right)
  }

  React.useLayoutEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = scrollTopRef.current
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    }
  }, [])

  const selectHeading = React.useCallback(
    (heading: OutlineHeading) => {
      onHeadingSelect(heading)
    },
    [onHeadingSelect]
  )

  const setListScrollTop = React.useCallback((scrollTop: number) => {
    const next = Math.max(0, scrollTop)
    scrollTopRef.current = next
    setVirtualScrollTop(next)
    const list = listRef.current
    if (list && Math.abs(list.scrollTop - next) > 0.5) {
      list.scrollTop = next
    }
  }, [])

  const selectIndex = React.useCallback(
    (
      index: number,
      alignment: ScrollLogicalPosition = "nearest",
      entries = filteredHeadings
    ) => {
      const entry = entries[index]
      if (!entry) return
      selectedValueRef.current = entry.value
      setSelectedValue(entry.value)

      const list = listRef.current
      const viewportHeight = list?.clientHeight ?? 28 * 16
      const rowTop = OUTLINE_LIST_PADDING + index * OUTLINE_ROW_HEIGHT
      const rowBottom = rowTop + OUTLINE_ROW_HEIGHT
      const currentTop = scrollTopRef.current
      const currentBottom = currentTop + viewportHeight
      let nextScrollTop = currentTop
      if (alignment === "start") {
        nextScrollTop = rowTop
      } else if (alignment === "end") {
        nextScrollTop = rowBottom - viewportHeight
      } else if (alignment === "center") {
        nextScrollTop = rowTop - (viewportHeight - OUTLINE_ROW_HEIGHT) / 2
      } else if (rowTop < currentTop) {
        nextScrollTop = rowTop
      } else if (rowBottom > currentBottom) {
        nextScrollTop = rowBottom - viewportHeight
      }
      setListScrollTop(nextScrollTop)
    },
    [filteredHeadings, setListScrollTop]
  )

  const cycleLevel = React.useCallback(
    (level: OutlineHeadingLevel, direction: 1 | -1) => {
      const matchingIndices = filteredHeadings.flatMap((entry, index) =>
        entry.heading.level === level ? [index] : []
      )
      if (matchingIndices.length === 0) return

      const currentSelectedValue = filteredIndexByValue.has(
        selectedValueRef.current
      )
        ? selectedValueRef.current
        : effectiveSelectedValue
      const exactIndex = matchingIndices.findIndex(
        (index) => filteredHeadings[index]?.value === currentSelectedValue
      )
      let nextIndex: number
      if (exactIndex >= 0) {
        nextIndex =
          matchingIndices[
            (exactIndex + direction + matchingIndices.length) %
              matchingIndices.length
          ]
      } else {
        const selectedFrom =
          headingByValue.get(currentSelectedValue)?.heading.from ??
          (direction === 1
            ? Number.NEGATIVE_INFINITY
            : Number.POSITIVE_INFINITY)
        const relativeIndex =
          direction === 1
            ? matchingIndices.findIndex(
                (index) => filteredHeadings[index]!.heading.from > selectedFrom
              )
            : matchingIndices.findLastIndex(
                (index) => filteredHeadings[index]!.heading.from < selectedFrom
              )
        nextIndex =
          matchingIndices[
            relativeIndex >= 0
              ? relativeIndex
              : direction === 1
                ? 0
                : matchingIndices.length - 1
          ]
      }
      selectIndex(nextIndex)
    },
    [
      effectiveSelectedValue,
      filteredHeadings,
      filteredIndexByValue,
      headingByValue,
      selectIndex,
    ]
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing) return
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        const currentSelectedValue = filteredIndexByValue.has(
          selectedValueRef.current
        )
          ? selectedValueRef.current
          : effectiveSelectedValue
        const currentIndex =
          filteredIndexByValue.get(currentSelectedValue) ?? -1
        const direction = event.key === "ArrowDown" ? 1 : -1
        const nextIndex =
          filteredHeadings.length === 0
            ? -1
            : (Math.max(0, currentIndex) +
                direction +
                filteredHeadings.length) %
              filteredHeadings.length
        selectIndex(nextIndex)
        return
      }
      if (
        (event.key === "Home" || event.key === "End") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        selectIndex(
          event.key === "Home" ? 0 : filteredHeadings.length - 1,
          event.key === "Home" ? "start" : "end"
        )
        return
      }

      const digitMatch = /^Digit([1-6])$/.exec(event.code)
      if (
        digitMatch &&
        event.target !== inputRef.current &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        cycleLevel(Number(digitMatch[1]) as OutlineHeadingLevel, 1)
        return
      }

      if (
        platform === "darwin" &&
        event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault()
        selectIndex(
          event.key === "ArrowUp" ? 0 : filteredHeadings.length - 1,
          event.key === "ArrowUp" ? "start" : "end"
        )
        return
      }

      if (
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return
      }
      const currentSelectedValue = filteredIndexByValue.has(
        selectedValueRef.current
      )
        ? selectedValueRef.current
        : effectiveSelectedValue
      const selectedHeading = headingByValue.get(currentSelectedValue)?.heading
      if (!selectedHeading) return

      event.preventDefault()
      cycleLevel(selectedHeading.level, event.key === "ArrowRight" ? 1 : -1)
    },
    [
      cycleLevel,
      effectiveSelectedValue,
      filteredHeadings,
      filteredIndexByValue,
      headingByValue,
      inputRef,
      platform,
      selectIndex,
    ]
  )

  return (
    <Command
      aria-label="Document outline"
      className="min-h-0"
      label="Document outline"
      loop
      shouldFilter={false}
      value={effectiveSelectedValue}
      vimBindings={false}
      onKeyDown={handleKeyDown}
      onValueChange={(value) => {
        if (!filteredIndexByValue.has(value)) return
        selectedValueRef.current = value
        setSelectedValue(value)
      }}
    >
      <CommandInput
        ref={inputRef}
        value={query}
        placeholder="Go to heading…"
        onValueChange={(value) => {
          const nextHeadings = value
            ? searchableHeadings.filter((entry) => matchesQuery(entry, value))
            : searchableHeadings
          const nextSelectedValue = nextHeadings.some(
            (entry) => entry.value === selectedValueRef.current
          )
            ? selectedValueRef.current
            : (nextHeadings[0]?.value ?? "")
          const nextSelectedIndex = nextHeadings.findIndex(
            (entry) => entry.value === nextSelectedValue
          )
          setQuery(value)
          selectedValueRef.current = nextSelectedValue
          setSelectedValue(nextSelectedValue)
          setListScrollTop(
            Math.max(
              0,
              OUTLINE_LIST_PADDING +
                (nextSelectedIndex - OUTLINE_WINDOW_OVERSCAN) *
                  OUTLINE_ROW_HEIGHT
            )
          )
        }}
      />
      <CommandList
        ref={listRef}
        aria-label="Document headings"
        className="max-h-[min(28rem,calc(var(--available-height)-3rem))] min-h-0 p-1.5"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop
          if (scrollFrameRef.current !== null) return
          scrollFrameRef.current = window.requestAnimationFrame(() => {
            scrollFrameRef.current = null
            setVirtualScrollTop(scrollTopRef.current)
          })
        }}
      >
        <CommandEmpty>
          {headings.length === 0
            ? "No headings in this document."
            : "No matching headings."}
        </CommandEmpty>
        {renderedHeadingIndices.map((headingIndex, renderedIndex) => {
          const { heading, value } = filteredHeadings[headingIndex]!
          const isActive = value === activeValue
          const label = headingLabel(heading)
          const previousHeadingIndex =
            renderedIndex === 0
              ? -1
              : renderedHeadingIndices[renderedIndex - 1]!
          const gapBefore = headingIndex - previousHeadingIndex - 1

          return (
            <React.Fragment key={value}>
              {gapBefore > 0 ? (
                <div
                  aria-hidden="true"
                  style={{ height: gapBefore * OUTLINE_ROW_HEIGHT }}
                />
              ) : null}
              <CommandItem
                aria-current={isActive ? "location" : undefined}
                aria-label={`Heading level ${heading.level}: ${label}`}
                aria-posinset={headingIndex + 1}
                aria-setsize={filteredHeadings.length}
                data-active={isActive || undefined}
                value={value}
                className={cn(
                  "h-9 shrink-0 py-0 pr-3 font-normal data-[active=true]:font-medium",
                  levelIndent[heading.level]
                )}
                onSelect={() => selectHeading(heading)}
              >
                <span
                  aria-hidden="true"
                  data-corner-shape="round"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full bg-ring transition-opacity",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <CommandShortcut className="w-5 shrink-0 text-right tracking-normal">
                  H{heading.level}
                </CommandShortcut>
              </CommandItem>
            </React.Fragment>
          )
        })}
        {(renderedHeadingIndices.at(-1) ?? -1) < filteredHeadings.length - 1 ? (
          <div
            aria-hidden="true"
            style={{
              height:
                (filteredHeadings.length -
                  1 -
                  (renderedHeadingIndices.at(-1) ?? -1)) *
                OUTLINE_ROW_HEIGHT,
            }}
          />
        ) : null}
      </CommandList>
    </Command>
  )
}

export function OutlinePopover({
  anchor,
  open,
  onOpenChange,
  headings,
  activeHeading = null,
  onHeadingSelect,
  platform,
  restoreFocus,
  trigger,
}: OutlinePopoverProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const handleFinalFocus = React.useCallback(() => {
    if (!restoreFocus) return true
    restoreFocus()
    return false
  }, [restoreFocus])
  const handleHeadingSelect = React.useCallback(
    (heading: OutlineHeading) => {
      onHeadingSelect(heading)
      onOpenChange(false)
    },
    [onHeadingSelect, onOpenChange]
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        anchor={anchor}
        align="end"
        collisionAvoidance={{
          align: "shift",
          fallbackAxisSide: "none",
          side: "none",
        }}
        collisionPadding={8}
        positionMethod="fixed"
        side="bottom"
        sideOffset={4}
        initialFocus={inputRef}
        finalFocus={handleFinalFocus}
        className="max-h-[min(31rem,var(--available-height))] min-h-0 w-[min(26rem,calc(100vw-1rem))] gap-0 overflow-hidden rounded-3xl p-0"
      >
        <PopoverTitle className="sr-only">Document outline</PopoverTitle>
        <OutlineCommand
          activeHeading={activeHeading}
          headings={headings}
          inputRef={inputRef}
          platform={platform}
          onHeadingSelect={handleHeadingSelect}
        />
      </PopoverContent>
    </Popover>
  )
}

export default OutlinePopover
