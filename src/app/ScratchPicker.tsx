import * as React from "react"
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react"
import { FileTextIcon, SearchIcon } from "lucide-react"

import {
  SCRATCH_SORT_LABELS,
  SCRATCH_SORT_OPTIONS,
  nextScratchIndex,
  scratchPickerActionAllowed,
  scratchPickerKeyAction,
  scratchPreviewRevisionMatches,
  scratchTitle,
  type ScratchOpenDisposition,
  type ScratchPreviewDocument,
  type ScratchSort,
  type ScratchSummary,
} from "@/app/scratch-picker-model"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const SCRATCH_ROW_HEIGHT = 84
const SCRATCH_LIST_PADDING = 4
const SCRATCH_WINDOW_SIZE = 32
const SCRATCH_WINDOW_OVERSCAN = 8
const MAX_CACHED_SCRATCH_PREVIEWS = 8
const MAX_SCRATCH_QUERY_LENGTH = 4096
const MAX_SOURCE_PREVIEW_LENGTH = 256 * 1024
const SCRATCH_PREVIEW_DEBOUNCE_MS = 60

export interface ScratchPreviewRenderState {
  error: string | null
  loading: boolean
  preview: ScratchPreviewDocument | null
  scratch: ScratchSummary | null
}

export interface ScratchPickerProps {
  scratches: readonly ScratchSummary[]
  query: string
  sort: ScratchSort
  selectedId: string | null
  loadPreview: (scratchId: string) => Promise<ScratchPreviewDocument>
  onQueryChange: (query: string) => void
  onSortChange: (sort: ScratchSort) => void
  onSelectedIdChange: (scratchId: string | null) => void
  onActivate?: (
    scratch: ScratchSummary,
    disposition: ScratchOpenDisposition
  ) => void
  onEscapeWhenEmpty?: () => void
  renderActions?: (
    scratch: ScratchSummary,
    interactionDisabled: boolean
  ) => React.ReactNode
  renderDetails?: (
    scratch: ScratchSummary,
    interactionDisabled: boolean
  ) => React.ReactNode
  renderPreview?: (state: ScratchPreviewRenderState) => React.ReactNode
  className?: string
  emptyMessage?: string
  errorMessage?: string | null
  inventoryError?: string | null
  inputRef?: React.RefObject<HTMLInputElement | null>
  loading?: boolean
  onRetryInventory?: () => void
  resultsCurrent?: boolean
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

interface ScratchPreviewState {
  error: string | null
  preview: ScratchPreviewDocument | null
  scratchId: string | null
}

function preventBaseUiHandler(event: React.KeyboardEvent<HTMLInputElement>) {
  const baseUiEvent = event as React.KeyboardEvent<HTMLInputElement> & {
    preventBaseUIHandler?: () => void
  }
  baseUiEvent.preventBaseUIHandler?.()
}

function useScratchPreview(
  scratch: ScratchSummary | null,
  loadPreview: ScratchPickerProps["loadPreview"]
) {
  const [cache, setCache] = React.useState(
    () =>
      new Map<
        string,
        {
          preview: ScratchPreviewDocument
          previewRevision: string
          requestedRevision: string
        }
      >()
  )
  const [state, setState] = React.useState<ScratchPreviewState>({
    error: null,
    preview: null,
    scratchId: null,
  })

  React.useEffect(() => {
    if (!scratch) return

    const cached = cache.get(scratch.scratchId)
    if (scratchPreviewRevisionMatches(scratch.revision, cached)) return

    let disposed = false
    const timer = window.setTimeout(() => {
      void loadPreview(scratch.scratchId).then(
        (preview) => {
          if (disposed) return
          if (preview.scratchId !== scratch.scratchId) {
            setState({
              error: "The scratch preview did not match the selected scratch.",
              preview: null,
              scratchId: scratch.scratchId,
            })
            return
          }
          setCache((current) => {
            const next = new Map(current)
            next.delete(scratch.scratchId)
            next.set(scratch.scratchId, {
              preview,
              previewRevision: preview.revision,
              requestedRevision: scratch.revision,
            })
            while (next.size > MAX_CACHED_SCRATCH_PREVIEWS) {
              const oldestId = next.keys().next().value as string | undefined
              if (oldestId === undefined) break
              next.delete(oldestId)
            }
            return next
          })
          setState({
            error: null,
            preview,
            scratchId: scratch.scratchId,
          })
        },
        (error) => {
          if (disposed) return
          setState({
            error: errorText(error, "The scratch preview could not be loaded."),
            preview: null,
            scratchId: scratch.scratchId,
          })
        }
      )
    }, SCRATCH_PREVIEW_DEBOUNCE_MS)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [cache, loadPreview, scratch])

  if (!scratch) {
    return {
      error: null,
      loading: false,
      preview: null,
      scratchId: null,
    }
  }
  const cached = cache.get(scratch.scratchId)
  if (cached && scratchPreviewRevisionMatches(scratch.revision, cached)) {
    return {
      error: null,
      loading: false,
      preview: cached.preview,
      scratchId: scratch.scratchId,
    }
  }
  if (state.scratchId === scratch.scratchId && state.error) {
    return { ...state, loading: false }
  }
  return {
    error: null,
    loading: true,
    preview: null,
    scratchId: scratch.scratchId,
  }
}

export function ScratchSourcePreview({
  error,
  loading,
  preview,
}: ScratchPreviewRenderState) {
  if (loading) {
    return (
      <p className="p-5 text-sm text-muted-foreground" role="status">
        Loading preview…
      </p>
    )
  }
  if (error) {
    return (
      <p className="p-5 text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }
  if (!preview) return null
  if (!preview.content) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This scratch is empty.
      </p>
    )
  }
  const truncated =
    preview.truncated || preview.content.length > MAX_SOURCE_PREVIEW_LENGTH
  return (
    <div className="min-h-full">
      <pre
        className="m-0 p-5 font-mono text-[0.8125rem] leading-6 whitespace-pre-wrap text-foreground"
        data-scratch-preview-source=""
      >
        {truncated
          ? preview.content.slice(0, MAX_SOURCE_PREVIEW_LENGTH)
          : preview.content}
      </pre>
      {truncated ? (
        <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
          Showing the beginning of this large scratch.
        </p>
      ) : null}
    </div>
  )
}

interface VirtualScratchListProps {
  entries: readonly ScratchSummary[]
  interactive: boolean
  selectedId: string | null
  onSelectedIdChange: (scratchId: string) => void
}

function VirtualScratchList({
  entries,
  interactive,
  selectedId,
  onSelectedIdChange,
}: VirtualScratchListProps) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const scrollTopRef = React.useRef(0)
  const scrollFrameRef = React.useRef<number | null>(null)
  const [virtualScrollTop, setVirtualScrollTop] = React.useState(0)
  const selectedIndex = entries.findIndex(
    (entry) => entry.scratchId === selectedId
  )
  const visibleWindowStart = (windowSize: number) =>
    Math.min(
      Math.max(0, entries.length - windowSize),
      Math.max(
        0,
        Math.floor(
          (virtualScrollTop - SCRATCH_LIST_PADDING) / SCRATCH_ROW_HEIGHT
        ) - SCRATCH_WINDOW_OVERSCAN
      )
    )
  let visibleWindowSize = SCRATCH_WINDOW_SIZE
  let windowStart = visibleWindowStart(visibleWindowSize)
  let windowEnd = Math.min(entries.length, windowStart + visibleWindowSize)
  const selectedOutsideWindow =
    selectedIndex >= 0 &&
    (selectedIndex < windowStart || selectedIndex >= windowEnd)
  if (selectedOutsideWindow) {
    visibleWindowSize -= 1
    windowStart = visibleWindowStart(visibleWindowSize)
    windowEnd = Math.min(entries.length, windowStart + visibleWindowSize)
  }
  const renderedIndices = Array.from(
    { length: Math.max(0, windowEnd - windowStart) },
    (_, offset) => windowStart + offset
  )
  if (selectedOutsideWindow) {
    renderedIndices.push(selectedIndex)
    renderedIndices.sort((left, right) => left - right)
  }

  React.useLayoutEffect(() => {
    if (selectedIndex < 0) return
    const list = listRef.current
    if (!list) return
    const rowTop = SCRATCH_LIST_PADDING + selectedIndex * SCRATCH_ROW_HEIGHT
    const rowBottom = rowTop + SCRATCH_ROW_HEIGHT
    const viewportTop = list.scrollTop
    const viewportBottom = viewportTop + list.clientHeight
    let nextScrollTop = viewportTop
    if (rowTop < viewportTop) nextScrollTop = rowTop
    else if (rowBottom > viewportBottom) {
      nextScrollTop = rowBottom - list.clientHeight
    }
    if (Math.abs(nextScrollTop - viewportTop) <= 0.5) return
    list.scrollTop = Math.max(0, nextScrollTop)
    scrollTopRef.current = list.scrollTop
    setVirtualScrollTop(list.scrollTop)
  }, [entries, selectedIndex])

  React.useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    },
    []
  )

  return (
    <AutocompletePrimitive.List
      ref={listRef}
      aria-label="Scratches"
      className="no-scrollbar min-h-0 overflow-x-hidden overflow-y-auto p-1"
      onScroll={(event) => {
        scrollTopRef.current = event.currentTarget.scrollTop
        if (scrollFrameRef.current !== null) return
        scrollFrameRef.current = window.requestAnimationFrame(() => {
          scrollFrameRef.current = null
          setVirtualScrollTop(scrollTopRef.current)
        })
      }}
    >
      {renderedIndices.map((entryIndex, renderedIndex) => {
        const scratch = entries[entryIndex]!
        const previousEntryIndex =
          renderedIndex === 0 ? -1 : renderedIndices[renderedIndex - 1]!
        const gapBefore = entryIndex - previousEntryIndex - 1
        const selected = scratch.scratchId === selectedId
        const excerpt =
          scratch.excerpt.trim() ||
          (scratch.byteLength === 0 ? "Empty scratch" : "No text preview")

        return (
          <React.Fragment key={scratch.scratchId}>
            {gapBefore > 0 ? (
              <div
                aria-hidden="true"
                style={{ height: gapBefore * SCRATCH_ROW_HEIGHT }}
              />
            ) : null}
            <AutocompletePrimitive.Item
              aria-selected={selected}
              aria-posinset={entryIndex + 1}
              aria-setsize={entries.length}
              className="grid h-[5.25rem] w-full content-center gap-1 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[selected=true]:bg-accent"
              data-scratch-id={scratch.scratchId}
              data-selected={selected || undefined}
              disabled={!interactive}
              index={entryIndex}
              tabIndex={-1}
              value={scratch}
              onClick={(event) => {
                event.preventBaseUIHandler()
                onSelectedIdChange(scratch.scratchId)
              }}
              onMouseDown={(event) => event.preventBaseUIHandler()}
              onPointerDownCapture={(event) => event.preventBaseUIHandler()}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {scratchTitle(scratch)}
                </span>
                {scratch.open ? (
                  <span
                    aria-label="Open"
                    className="size-1.5 shrink-0 rounded-full bg-ring"
                    data-corner-shape="round"
                  />
                ) : null}
              </span>
              <span className="line-clamp-2 min-w-0 text-xs leading-4 text-muted-foreground">
                {excerpt}
              </span>
            </AutocompletePrimitive.Item>
          </React.Fragment>
        )
      })}
      {(renderedIndices.at(-1) ?? -1) < entries.length - 1 ? (
        <div
          aria-hidden="true"
          style={{
            height:
              (entries.length - 1 - (renderedIndices.at(-1) ?? -1)) *
              SCRATCH_ROW_HEIGHT,
          }}
        />
      ) : null}
    </AutocompletePrimitive.List>
  )
}

export function ScratchPicker({
  scratches,
  query,
  sort,
  selectedId,
  loadPreview,
  onQueryChange,
  onSortChange,
  onSelectedIdChange,
  onActivate,
  onEscapeWhenEmpty,
  renderActions,
  renderDetails,
  renderPreview = ScratchSourcePreview,
  className,
  emptyMessage = "No scratches yet.",
  errorMessage,
  inventoryError,
  inputRef: providedInputRef,
  loading = false,
  onRetryInventory,
  resultsCurrent = !loading,
}: ScratchPickerProps) {
  const ownInputRef = React.useRef<HTMLInputElement>(null)
  const pendingCyclesRef = React.useRef<(1 | -1)[]>([])
  const inputRef = providedInputRef ?? ownInputRef
  const visibleScratches = scratches
  const effectiveSelectedId = visibleScratches.some(
    (scratch) => scratch.scratchId === selectedId
  )
    ? selectedId
    : (visibleScratches[0]?.scratchId ?? null)
  const selectedIndex = visibleScratches.findIndex(
    (scratch) => scratch.scratchId === effectiveSelectedId
  )
  const selectedScratch = visibleScratches[selectedIndex] ?? null
  const previewState = useScratchPreview(selectedScratch, loadPreview)

  React.useLayoutEffect(() => {
    if (resultsCurrent && effectiveSelectedId !== selectedId) {
      onSelectedIdChange(effectiveSelectedId)
    }
  }, [effectiveSelectedId, onSelectedIdChange, resultsCurrent, selectedId])

  React.useLayoutEffect(() => {
    if (!resultsCurrent || pendingCyclesRef.current.length === 0) {
      return
    }
    const pendingCycles = pendingCyclesRef.current
    pendingCyclesRef.current = []
    if (visibleScratches.length === 0) return
    let nextIndex = selectedIndex
    for (const direction of pendingCycles) {
      nextIndex = nextScratchIndex(
        visibleScratches.length,
        nextIndex,
        direction
      )
    }
    onSelectedIdChange(visibleScratches[nextIndex]!.scratchId)
  }, [onSelectedIdChange, resultsCurrent, selectedIndex, visibleScratches])

  const handleSearchKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const action = scratchPickerKeyAction(
        {
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          isComposing: event.nativeEvent.isComposing,
          key: event.key,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
        query.length > 0
      )
      if (!action) return
      if (action.kind === "cycle") {
        event.preventDefault()
        preventBaseUiHandler(event)
        if (!resultsCurrent) {
          if (pendingCyclesRef.current.length < 32) {
            pendingCyclesRef.current.push(action.direction)
          }
        } else if (visibleScratches.length > 0) {
          const nextIndex = nextScratchIndex(
            visibleScratches.length,
            selectedIndex,
            action.direction
          )
          onSelectedIdChange(visibleScratches[nextIndex]!.scratchId)
        }
        return
      }
      if (!scratchPickerActionAllowed(action, resultsCurrent)) {
        event.preventDefault()
        preventBaseUiHandler(event)
        return
      }
      if (action.kind === "clear-query" || action.kind === "close") {
        event.preventDefault()
        event.stopPropagation()
        preventBaseUiHandler(event)
        if (action.kind === "clear-query") {
          onQueryChange("")
        } else {
          onEscapeWhenEmpty?.()
        }
        return
      }
      if (!selectedScratch || !onActivate) return
      event.preventDefault()
      preventBaseUiHandler(event)
      onActivate(selectedScratch, action.disposition)
    },
    [
      onActivate,
      onEscapeWhenEmpty,
      onQueryChange,
      onSelectedIdChange,
      query,
      resultsCurrent,
      selectedIndex,
      selectedScratch,
      visibleScratches,
    ]
  )

  const previewForSelection =
    previewState.scratchId === selectedScratch?.scratchId
      ? previewState.preview
      : null
  const previewLoading =
    previewState.scratchId === selectedScratch?.scratchId &&
    previewState.loading
  const previewError =
    previewState.scratchId === selectedScratch?.scratchId
      ? previewState.error
      : null

  return (
    <AutocompletePrimitive.Root<ScratchSummary>
      filter={null}
      filteredItems={visibleScratches}
      highlightItemOnHover={false}
      inline
      itemToStringValue={(scratch) => scratch.scratchId}
      items={visibleScratches}
      mode="none"
      open
      value={query}
      virtualized
      onValueChange={(inputValue, { reason }) => {
        if (reason === "input-change" || reason === "input-clear") {
          onQueryChange(inputValue)
        }
      }}
    >
      <div
        aria-busy={loading}
        className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}
        data-scratch-picker=""
        data-results-current={resultsCurrent}
      >
        {loading ? (
          <span className="sr-only" role="status">
            Searching scratches…
          </span>
        ) : null}
        <div
          className="flex shrink-0 items-center gap-2 max-sm:flex-wrap"
          data-scratch-picker-controls=""
        >
          <div
            className="relative min-w-48 flex-1"
            data-scratch-picker-search=""
          >
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <AutocompletePrimitive.Input
              ref={inputRef}
              aria-label="Search scratches"
              autoComplete="off"
              className="pl-9"
              maxLength={MAX_SCRATCH_QUERY_LENGTH}
              placeholder="Search scratches…"
              render={<Input />}
              type="search"
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <Select
            value={sort}
            onValueChange={(value) => onSortChange(value as ScratchSort)}
          >
            <SelectTrigger
              aria-label="Sort scratches"
              className="w-44 shrink-0"
              data-scratch-picker-sort=""
            >
              <SelectValue>{SCRATCH_SORT_LABELS[sort]}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {SCRATCH_SORT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {SCRATCH_SORT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {errorMessage ? (
          <div
            className="shrink-0 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        {inventoryError ? (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <span className="min-w-0 flex-1">{inventoryError}</span>
            {onRetryInventory ? (
              <Button
                disabled={loading}
                size="xs"
                type="button"
                variant="outline"
                onClick={onRetryInventory}
              >
                {loading ? "Retrying…" : "Retry"}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(13rem,0.36fr)_minmax(0,1fr)] overflow-hidden rounded-md border border-border/70 bg-muted/20 max-sm:grid-cols-1 max-sm:grid-rows-[minmax(10rem,0.42fr)_minmax(0,1fr)]"
          data-scratch-picker-workspace=""
        >
          <div
            className="grid min-h-0 border-r border-border/70 max-sm:border-r-0 max-sm:border-b"
            data-scratch-picker-list=""
          >
            {visibleScratches.length > 0 ? (
              <VirtualScratchList
                entries={visibleScratches}
                interactive={resultsCurrent}
                selectedId={effectiveSelectedId}
                onSelectedIdChange={onSelectedIdChange}
              />
            ) : loading ? (
              <div
                className="grid min-h-32 place-items-center p-5 text-center text-sm text-muted-foreground"
                role="status"
              >
                Searching…
              </div>
            ) : inventoryError ? (
              <div className="grid min-h-32 place-items-center p-5 text-center text-sm text-muted-foreground">
                Scratch list unavailable.
              </div>
            ) : (
              <div className="grid min-h-32 place-items-center p-5 text-center text-sm text-muted-foreground">
                {query ? "No matching scratches." : emptyMessage}
              </div>
            )}
          </div>

          <section
            aria-label="Scratch preview"
            className={cn(
              "grid min-h-0 overflow-hidden max-sm:overflow-y-auto",
              renderDetails
                ? "grid-rows-[auto_auto_minmax(0,1fr)] max-sm:grid-rows-[auto_auto_minmax(12rem,1fr)]"
                : "grid-rows-[auto_minmax(0,1fr)] max-sm:grid-rows-[auto_minmax(12rem,1fr)]"
            )}
            data-has-selection={selectedScratch ? "true" : undefined}
            data-scratch-picker-preview=""
          >
            {selectedScratch ? (
              <header
                className="flex min-w-0 items-start gap-3 border-b border-border/70 px-4 py-3"
                data-scratch-picker-preview-header=""
              >
                <FileTextIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div
                  className="min-w-0 flex-1"
                  data-scratch-picker-preview-summary=""
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="min-w-0 truncate text-sm font-medium">
                      {scratchTitle(selectedScratch)}
                    </h2>
                    {selectedScratch.open ? (
                      <Badge variant="secondary">Open</Badge>
                    ) : null}
                  </div>
                  <p
                    className="mt-0.5 truncate text-xs text-muted-foreground"
                    data-scratch-picker-preview-meta=""
                  >
                    {selectedScratch.fileName}
                  </p>
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    data-scratch-picker-preview-meta=""
                  >
                    Edited {formatTimestamp(selectedScratch.modifiedAt)}
                  </p>
                </div>
                {renderActions ? (
                  <div
                    className="flex shrink-0 items-center gap-2"
                    data-scratch-picker-preview-actions=""
                  >
                    {renderActions(selectedScratch, !resultsCurrent)}
                  </div>
                ) : null}
              </header>
            ) : null}
            {selectedScratch && renderDetails ? (
              <div
                className="border-b border-border/70 p-4"
                data-scratch-picker-details=""
              >
                {renderDetails(selectedScratch, !resultsCurrent)}
              </div>
            ) : null}
            <div
              key="scratch-preview-body"
              className="min-h-0 overflow-auto bg-background/50 max-sm:min-h-48"
              data-scratch-picker-preview-body=""
              hidden={!selectedScratch}
            >
              {renderPreview({
                error: selectedScratch ? previewError : null,
                loading: selectedScratch ? previewLoading : false,
                preview: selectedScratch ? previewForSelection : null,
                scratch: selectedScratch,
              })}
            </div>
            {!selectedScratch ? (
              <div className="col-span-full grid min-h-40 place-items-center p-5 text-sm text-muted-foreground">
                Select a scratch to preview it.
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </AutocompletePrimitive.Root>
  )
}

export default ScratchPicker
