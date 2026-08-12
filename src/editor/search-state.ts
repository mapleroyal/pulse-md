import type { SearchQuery } from "@codemirror/search"
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state"

import type { MarkdownSearchIssue } from "./types"

export interface SearchMatchRange {
  readonly from: number
  readonly to: number
}

interface EditorSearchState {
  readonly currentMatch: SearchMatchRange | null
  readonly issue: MarkdownSearchIssue | null
  readonly query: SearchQuery | null
}

export const setEditorSearchQuery = StateEffect.define<SearchQuery>()
export const setEditorSearchIssue =
  StateEffect.define<MarkdownSearchIssue | null>()
export const setCurrentSearchMatch =
  StateEffect.define<SearchMatchRange | null>()

export function searchPatternEqual(
  left: SearchQuery | null,
  right: SearchQuery | null
) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.search === right.search &&
      left.caseSensitive === right.caseSensitive &&
      left.literal === right.literal &&
      left.regexp === right.regexp &&
      left.wholeWord === right.wholeWord &&
      left.test === right.test)
  )
}

const editorSearchStateField = StateField.define<EditorSearchState>({
  create: () => ({ currentMatch: null, issue: null, query: null }),
  update(value, transaction) {
    let currentMatch = value.currentMatch
    let issue = value.issue
    let query = value.query
    if (currentMatch && transaction.docChanged) {
      currentMatch = transaction.changes.touchesRange(
        currentMatch.from,
        currentMatch.to
      )
        ? null
        : {
            from: transaction.changes.mapPos(currentMatch.from),
            to: transaction.changes.mapPos(currentMatch.to),
          }
    }
    for (const effect of transaction.effects) {
      if (effect.is(setEditorSearchQuery)) {
        if (!searchPatternEqual(query, effect.value)) currentMatch = null
        query = effect.value
      } else if (effect.is(setEditorSearchIssue)) {
        issue = effect.value
        if (issue) currentMatch = null
      } else if (effect.is(setCurrentSearchMatch)) {
        currentMatch = effect.value
      }
    }
    return currentMatch === value.currentMatch &&
      issue === value.issue &&
      query === value.query
      ? value
      : { currentMatch, issue, query }
  },
})

export const searchMatchStateExtension: Extension = editorSearchStateField

export function editorSearchQuery(state: EditorState) {
  return state.field(editorSearchStateField, false)?.query ?? null
}

export function editorSearchIssue(state: EditorState) {
  return state.field(editorSearchStateField, false)?.issue ?? null
}

export function currentSearchMatch(state: EditorState) {
  return state.field(editorSearchStateField, false)?.currentMatch ?? null
}
