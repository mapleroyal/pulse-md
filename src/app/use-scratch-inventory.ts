import * as React from "react"

import type {
  ScratchInventory,
  ScratchInventoryScope,
  ScratchSortOrder,
} from "@/shared/contracts"

const SEARCH_DEBOUNCE_MS = 70

export type GetScratchInventory = (
  query: string,
  sort: ScratchSortOrder,
  scope: ScratchInventoryScope
) => Promise<ScratchInventory>

export interface ScratchInventoryProvenance {
  loaded: boolean
  loading: boolean
  resolvedQuery: string | null
  resolvedSort: ScratchSortOrder | null
}

interface ScratchInventoryState extends ScratchInventoryProvenance {
  entries: ScratchInventory["entries"]
  error: string | null
  profileReferencesAvailable: boolean
}

export function scratchInventoryResultsCurrent(
  provenance: ScratchInventoryProvenance,
  active: boolean,
  query: string,
  sort: ScratchSortOrder
) {
  return (
    active &&
    provenance.loaded &&
    !provenance.loading &&
    provenance.resolvedQuery === query &&
    provenance.resolvedSort === sort
  )
}

function errorText(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Scratches could not be loaded."
}

export function useScratchInventory({
  active = true,
  getScratches,
  query,
  sort,
}: {
  active?: boolean
  getScratches: GetScratchInventory
  query: string
  sort: ScratchSortOrder
}) {
  const requestRef = React.useRef(0)
  const [state, setState] = React.useState<ScratchInventoryState>({
    entries: [],
    error: null,
    loaded: false,
    loading: active,
    profileReferencesAvailable: false,
    resolvedQuery: null,
    resolvedSort: null,
  })

  const refresh = React.useCallback(
    async (nextQuery = query, nextSort = sort) => {
      const request = ++requestRef.current
      setState((current) => ({ ...current, error: null, loading: true }))
      try {
        const inventory = await getScratches(
          nextQuery,
          nextSort,
          "scratch-browser"
        )
        if (request === requestRef.current) {
          setState({
            entries: inventory.entries,
            error: null,
            loaded: true,
            loading: false,
            profileReferencesAvailable: inventory.profileReferencesAvailable,
            resolvedQuery: nextQuery,
            resolvedSort: nextSort,
          })
        }
        return inventory
      } catch (error) {
        if (request === requestRef.current) {
          setState((current) => ({
            ...current,
            error: errorText(error),
            loaded: true,
            loading: false,
          }))
        }
        throw error
      }
    },
    [getScratches, query, sort]
  )

  React.useEffect(() => {
    if (!active) {
      requestRef.current += 1
      setState((current) => ({ ...current, loading: false }))
      return
    }
    setState((current) => ({ ...current, error: null, loading: true }))
    const timer = window.setTimeout(
      () => void refresh().catch(() => undefined),
      query ? SEARCH_DEBOUNCE_MS : 0
    )
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [active, query, refresh, sort])

  React.useEffect(
    () => () => {
      requestRef.current += 1
    },
    []
  )

  const current =
    state.error === null &&
    scratchInventoryResultsCurrent(state, active, query, sort)

  return { ...state, current, refresh }
}
