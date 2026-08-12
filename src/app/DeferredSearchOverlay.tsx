import * as React from "react"

import type { MarkdownEditorController } from "@/editor/MarkdownEditorController"
import type { MarkdownSearchStatus } from "@/editor/types"
import { DeferredSurfaceErrorBoundary } from "@/app/DeferredSurface"
import { SearchLoadingOverlay } from "@/app/SearchLoadingOverlay"
import {
  clearSearchHandoff,
  DEFAULT_SEARCH_UI_STATE,
  drainSearchHandoff,
  EMPTY_SEARCH_STATUS,
  enqueueSearchHandoff,
  searchStateWithQueuedConfiguration,
  type SearchHandoffQueue,
  type SearchUiState,
} from "@/app/search-handoff"
import { searchOverlayLoader } from "@/app/search-overlay-loader"

export interface DeferredSearchOverlayProps {
  focusRequest: number
  getController: () => MarkdownEditorController | null
  handoffQueue: SearchHandoffQueue
  open: boolean
  onClose: () => void
}

export interface SearchOverlayHandle {
  navigate(direction: "next" | "previous"): void
  reset(): void
  updateStatus(status: MarkdownSearchStatus): void
}

export const DeferredSearchOverlay = React.forwardRef<
  SearchOverlayHandle,
  DeferredSearchOverlayProps
>(function DeferredSearchOverlay(
  { focusRequest, getController, handoffQueue, open, onClose },
  ref
) {
  const fallbackInputRef = React.useRef<HTMLInputElement>(null)
  const appliedSearchStateRef = React.useRef<SearchUiState>({
    ...DEFAULT_SEARCH_UI_STATE,
  })
  const [searchState, setSearchState] = React.useState<SearchUiState>(() => ({
    ...DEFAULT_SEARCH_UI_STATE,
  }))
  const [status, setStatus] = React.useState(EMPTY_SEARCH_STATUS)
  const [loadError, setLoadError] = React.useState<unknown>(null)
  const [loadRevision, setLoadRevision] = React.useState(0)
  const [loaded, setLoaded] = React.useState<{
    Overlay: (typeof import("@/app/SearchOverlay"))["default"]
    support: (typeof import("@/editor/search-support"))["editorSearchSupport"]
    initialFindHandoff?: {
      focused: boolean
      selectionDirection: "backward" | "forward" | "none"
      selectionEnd: number
      selectionStart: number
    }
  } | null>(() => searchOverlayLoader.peek())

  const synchronize = React.useCallback(
    (state: SearchUiState) => {
      const controller = getController()
      if (!controller) return
      if (!state.query) {
        controller.clearSearch()
        return
      }
      controller.setSearchQuery(state.query, {
        caseSensitive: state.caseSensitive,
        regexp: state.regexp,
        replace: state.replacement,
        wholeWord: state.wholeWord,
      })
    },
    [getController]
  )

  const previewQueuedConfiguration = React.useCallback(() => {
    const preview = searchStateWithQueuedConfiguration(
      appliedSearchStateRef.current,
      handoffQueue
    )
    // Closing Find discards pending navigation, but its input state follows the
    // loaded overlay's existing retain-on-close behavior. Store the cold-shell
    // preview before App clears the handoff queue so a later retry/reopen can
    // still synchronize the visible query and options.
    appliedSearchStateRef.current = preview
    setSearchState(preview)
  }, [handoffQueue])

  const consumeHandoff = React.useCallback(() => {
    if (!loaded || handoffQueue.actions.length === 0) {
      if (!loaded) previewQueuedConfiguration()
      return
    }

    const controller = getController()
    controller?.enableSearchSupport(loaded.support)
    const pending = drainSearchHandoff(handoffQueue)
    let applied = appliedSearchStateRef.current
    for (const action of pending) {
      if (action.type === "configure") {
        applied = { ...applied, ...action.change }
        appliedSearchStateRef.current = applied
        if (action.synchronize) synchronize(applied)
      } else {
        synchronize(applied)
        if (action.direction === "next") controller?.findNext()
        else controller?.findPrevious()
      }
    }
    setSearchState(applied)
  }, [
    getController,
    handoffQueue,
    loaded,
    previewQueuedConfiguration,
    synchronize,
  ])

  const queueConfiguration = React.useCallback(
    (change: Partial<SearchUiState>, synchronizeWithEditor = true) => {
      enqueueSearchHandoff(handoffQueue, {
        change,
        synchronize: synchronizeWithEditor,
        type: "configure",
      })
      if (loaded) consumeHandoff()
      else previewQueuedConfiguration()
    },
    [consumeHandoff, handoffQueue, loaded, previewQueuedConfiguration]
  )

  const navigate = React.useCallback(
    (direction: "next" | "previous") => {
      enqueueSearchHandoff(handoffQueue, { direction, type: "navigate" })
      consumeHandoff()
    },
    [consumeHandoff, handoffQueue]
  )

  React.useImperativeHandle(
    ref,
    () => ({
      navigate,
      reset() {
        clearSearchHandoff(handoffQueue)
        const reset = { ...DEFAULT_SEARCH_UI_STATE }
        appliedSearchStateRef.current = reset
        setSearchState(reset)
        setStatus(EMPTY_SEARCH_STATUS)
      },
      updateStatus: setStatus,
    }),
    [handoffQueue, navigate]
  )

  React.useEffect(() => {
    if (!open || loaded) return
    let disposed = false
    void searchOverlayLoader.load().then(
      (module) => {
        if (disposed) return
        const input = fallbackInputRef.current
        setLoadError(null)
        setLoaded({
          Overlay: module.Overlay,
          support: module.support,
          ...(input
            ? {
                initialFindHandoff: {
                  focused: document.activeElement === input,
                  selectionDirection: input.selectionDirection ?? "none",
                  selectionEnd: input.selectionEnd ?? input.value.length,
                  selectionStart: input.selectionStart ?? input.value.length,
                },
              }
            : {}),
        })
      },
      (error: unknown) => {
        if (disposed) return
        console.error("Unable to load search tools", error)
        setLoadError(error)
      }
    )
    return () => {
      disposed = true
    }
  }, [loadRevision, loaded, open])

  React.useLayoutEffect(() => {
    if (!open) return
    if (loaded) {
      getController()?.enableSearchSupport(loaded.support)
      if (handoffQueue.actions.length > 0) consumeHandoff()
      else synchronize(appliedSearchStateRef.current)
    } else {
      previewQueuedConfiguration()
    }
  }, [
    consumeHandoff,
    getController,
    handoffQueue,
    loaded,
    open,
    previewQueuedConfiguration,
    synchronize,
  ])

  React.useEffect(() => {
    if (!open) clearSearchHandoff(handoffQueue)
  }, [handoffQueue, open])

  if (!open && !loaded) return null

  const loadingSurface = (error: boolean, retry: () => void) => (
    <SearchLoadingOverlay
      error={error}
      expanded={searchState.expanded}
      focusRequest={focusRequest}
      inputRef={fallbackInputRef}
      query={searchState.query}
      replacement={searchState.replacement}
      onClose={onClose}
      onNavigate={navigate}
      onQueryChange={(query) => queueConfiguration({ query })}
      onReplacementChange={(replacement) => queueConfiguration({ replacement })}
      onRetry={retry}
    />
  )

  if (!loaded) {
    return loadingSurface(loadError !== null, () => {
      searchOverlayLoader.reset()
      setLoadError(null)
      setLoadRevision((current) => current + 1)
    })
  }

  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_error, retry) => loadingSurface(true, retry)}
    >
      <loaded.Overlay
        caseSensitive={searchState.caseSensitive}
        expanded={searchState.expanded}
        focusRequest={focusRequest}
        initialFindHandoff={loaded.initialFindHandoff}
        open={open}
        preserveCase={searchState.preserveCase}
        query={searchState.query}
        regexp={searchState.regexp}
        replacement={searchState.replacement}
        status={status}
        wholeWord={searchState.wholeWord}
        onCaseSensitiveChange={(caseSensitive) =>
          queueConfiguration({ caseSensitive })
        }
        onClose={onClose}
        onExpandedChange={(expanded) => queueConfiguration({ expanded }, false)}
        onFindNext={() => navigate("next")}
        onFindPrevious={() => navigate("previous")}
        onPreserveCaseChange={(preserveCase) =>
          queueConfiguration({ preserveCase }, false)
        }
        onQueryChange={(query) => queueConfiguration({ query })}
        onRegexpChange={(regexp) => queueConfiguration({ regexp })}
        onReplace={() =>
          getController()?.replaceNext({
            preserveCase: appliedSearchStateRef.current.preserveCase,
          })
        }
        onReplaceAll={() =>
          getController()?.replaceAll({
            preserveCase: appliedSearchStateRef.current.preserveCase,
          })
        }
        onReplacementChange={(replacement) =>
          queueConfiguration({ replacement })
        }
        onWholeWordChange={(wholeWord) => queueConfiguration({ wholeWord })}
      />
    </DeferredSurfaceErrorBoundary>
  )
})
