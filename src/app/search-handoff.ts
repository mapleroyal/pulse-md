import type { MarkdownSearchStatus } from "@/editor/types"

const MAX_SEARCH_HANDOFF_ACTIONS = 64

export interface SearchUiState {
  caseSensitive: boolean
  expanded: boolean
  preserveCase: boolean
  query: string
  regexp: boolean
  replacement: string
  wholeWord: boolean
}

type SearchHandoffAction =
  | {
      change: Partial<SearchUiState>
      synchronize: boolean
      type: "configure"
    }
  | { direction: "next" | "previous"; type: "navigate" }

export interface SearchHandoffQueue {
  actions: SearchHandoffAction[]
}

export const DEFAULT_SEARCH_UI_STATE: SearchUiState = {
  caseSensitive: false,
  expanded: false,
  preserveCase: false,
  query: "",
  regexp: false,
  replacement: "",
  wholeWord: false,
}

export const EMPTY_SEARCH_STATUS: MarkdownSearchStatus = {
  valid: false,
  pending: false,
  current: null,
  total: 0,
}

export function enqueueSearchHandoff(
  queue: SearchHandoffQueue,
  action: SearchHandoffAction
) {
  const previous = queue.actions.at(-1)
  if (previous?.type === "configure" && action.type === "configure") {
    previous.change = { ...previous.change, ...action.change }
    previous.synchronize ||= action.synchronize
    return
  }
  if (queue.actions.length >= MAX_SEARCH_HANDOFF_ACTIONS) queue.actions.shift()
  queue.actions.push(action)
}

export function clearSearchHandoff(queue: SearchHandoffQueue) {
  queue.actions.length = 0
}

export function searchStateWithQueuedConfiguration(
  state: SearchUiState,
  queue: SearchHandoffQueue
): SearchUiState {
  let configured = state
  for (const action of queue.actions) {
    if (action.type === "configure") {
      configured = { ...configured, ...action.change }
    }
  }
  return configured
}

export function drainSearchHandoff(queue: SearchHandoffQueue) {
  return queue.actions.splice(0)
}
