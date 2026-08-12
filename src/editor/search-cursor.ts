import type { SearchQuery } from "@codemirror/search"
import {
  CharCategory,
  findClusterBreak,
  type EditorState,
  type Text,
} from "@codemirror/state"

export interface SearchCursorMatch {
  readonly from: number
  readonly match?: RegExpExecArray
  readonly precise?: boolean
  readonly to: number
}

export interface ContextPreservingRegexpSearch {
  cursor(from: number): Iterator<SearchCursorMatch>
}

const flattenedDocuments = new WeakMap<Text, string>()
export const maximumContextPreservingRegexpDocumentLength = 1_000_000

function flattenedDocument(document: Text) {
  const cached = flattenedDocuments.get(document)
  if (cached != null) return cached
  const content = document.toString()
  flattenedDocuments.set(document, content)
  return content
}

function regexpCharacterEnd(value: string, position: number) {
  while (
    position < value.length &&
    value.charCodeAt(position) >= 0xdc00 &&
    value.charCodeAt(position) < 0xe000
  ) {
    position += 1
  }
  return position
}

function clusterBefore(value: string, position: number) {
  return value.slice(findClusterBreak(value, position, false), position)
}

function clusterAfter(value: string, position: number) {
  return value.slice(position, findClusterBreak(value, position))
}

export function regexpMayCrossLines(query: string) {
  // Keep this in step with CodeMirror's RegExpCursor selection. Expressions
  // outside this set are evaluated one line at a time by CodeMirror itself.
  return /\\[sWDnr]|\n|\r|\[\^/.test(query)
}

export function contextPreservingRegexpSearchSupported(
  state: EditorState,
  query: SearchQuery
) {
  return (
    !query.regexp ||
    !regexpMayCrossLines(query.search) ||
    state.doc.length <= maximumContextPreservingRegexpDocumentLength
  )
}

/**
 * Creates a multiline regexp cursor rooted at document position zero, then
 * seeks with RegExp.lastIndex. Unlike CodeMirror's range-rooted flattened
 * cursor, this preserves lookbehind context without replaying earlier matches.
 */
export function contextPreservingRegexpCursor(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number
): Iterator<SearchCursorMatch> {
  return createContextPreservingRegexpSearch(state, query, to).cursor(from)
}

/**
 * Prepares the shared full-context input for one or more cursors. Arbitrary
 * JavaScript lookbehind and lookahead may depend on the entire prefix or
 * suffix, so callers that need exact semantics cannot safely use a fixed
 * context margin. Sharing this object at least guarantees that a rebuild
 * flattens the document only once.
 */
export function createContextPreservingRegexpSearch(
  state: EditorState,
  query: SearchQuery,
  to = state.doc.length
): ContextPreservingRegexpSearch {
  if (!contextPreservingRegexpSearchSupported(state, query)) {
    throw new RangeError(
      `Multiline regular expressions are limited to ${maximumContextPreservingRegexpDocumentLength.toLocaleString()} UTF-16 code units.`
    )
  }
  const fullDocument = flattenedDocument(state.doc)
  const input =
    to === state.doc.length ? fullDocument : fullDocument.slice(0, to)
  const unicodeFlag = /x/.unicode == null ? "" : "u"
  const flags = `gm${unicodeFlag}${query.caseSensitive ? "" : "i"}`
  const categorizer = query.wholeWord
    ? state.charCategorizer(state.selection.main.head)
    : null

  return {
    cursor(from: number) {
      const expression = new RegExp(query.search, flags)
      let matchPosition = regexpCharacterEnd(input, from)
      let finished = false

      const cursor: IterableIterator<SearchCursorMatch> = {
        [Symbol.iterator]() {
          return cursor
        },
        next: (): IteratorResult<SearchCursorMatch> => {
          while (!finished) {
            const offset = (expression.lastIndex = matchPosition)
            let match = expression.exec(input)
            if (match && match[0].length === 0 && match.index === offset) {
              expression.lastIndex = regexpCharacterEnd(input, offset + 1)
              match = expression.exec(input)
            }
            if (!match) {
              finished = true
              break
            }

            const matchFrom = match.index
            const matchTo = matchFrom + match[0].length
            matchPosition = regexpCharacterEnd(
              input,
              matchTo + (matchFrom === matchTo ? 1 : 0)
            )
            const wholeWordMatch =
              !categorizer ||
              match[0].length === 0 ||
              ((categorizer(clusterBefore(input, matchFrom)) !==
                CharCategory.Word ||
                categorizer(clusterAfter(input, matchFrom)) !==
                  CharCategory.Word) &&
                (categorizer(clusterAfter(input, matchTo)) !==
                  CharCategory.Word ||
                  categorizer(clusterBefore(input, matchTo)) !==
                    CharCategory.Word))
            if (
              !wholeWordMatch ||
              (query.test && !query.test(match[0], state, matchFrom, matchTo))
            ) {
              continue
            }

            return {
              done: false,
              value: {
                from: matchFrom,
                match,
                precise: true,
                to: matchTo,
              },
            }
          }

          return { done: true, value: undefined }
        },
      }
      return cursor
    },
  }
}

export function searchCursorForRange(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number
): Iterator<SearchCursorMatch> {
  return from > 0 && query.regexp && regexpMayCrossLines(query.search)
    ? contextPreservingRegexpCursor(state, query, from, to)
    : (query.getCursor(state, from, to) as Iterator<SearchCursorMatch>)
}
