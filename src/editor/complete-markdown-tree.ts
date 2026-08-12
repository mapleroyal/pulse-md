import { markdownLanguage } from "@codemirror/lang-markdown"
import {
  DocInput,
  language,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language"
import type {
  ChangeDesc,
  EditorState,
  Text,
  Transaction,
} from "@codemirror/state"
import {
  TreeFragment,
  type ChangedRange,
  type Parser,
  type Tree,
} from "@lezer/common"

interface CachedTree {
  parser: Parser
  tree: Tree
}

const completeTreeCache = new WeakMap<Text, CachedTree>()
const completeTreeParsers = new WeakMap<Tree, Parser>()
const blockPairingChangeCache = new WeakMap<Transaction, boolean>()

const blockPairingOpening =
  /^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+))*[ \t]*(`{3,}|~{3,}|\$\$(?!\$)|\\\[)/
const maximumBlockDelimiterContext = 4 * 1024

function lineExpandedChangedRanges(
  state: EditorState,
  changes: ChangeDesc
): ChangedRange[] {
  const inverted = changes.invertedDesc
  const ranges: ChangedRange[] = []

  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const firstLine = state.doc.lineAt(fromB)
    const changedLastLine = state.doc.lineAt(toB > fromB ? toB - 1 : toB)
    const lastLine =
      changedLastLine.number < state.doc.lines
        ? state.doc.line(changedLastLine.number + 1)
        : changedLastLine
    const expandedFromB = firstLine.from
    const expandedToB =
      lastLine.number < state.doc.lines ? lastLine.to + 1 : lastLine.to
    const candidate: ChangedRange = {
      fromA: inverted.mapPos(expandedFromB, -1),
      toA: inverted.mapPos(expandedToB, 1),
      fromB: expandedFromB,
      toB: expandedToB,
    }
    const previous = ranges.at(-1)
    if (!previous || candidate.fromB > previous.toB) {
      ranges.push(candidate)
      return
    }
    ranges[ranges.length - 1] = {
      fromA: previous.fromA,
      toA: Math.max(previous.toA, candidate.toA),
      fromB: previous.fromB,
      toB: Math.max(previous.toB, candidate.toB),
    }
  })

  return ranges
}

function blockPairingDelimiterRanges(document: Text, from: number, to: number) {
  const clampedFrom = Math.max(0, Math.min(document.length, from))
  const clampedTo = Math.max(clampedFrom, Math.min(document.length, to))
  const firstLine = document.lineAt(Math.max(0, clampedFrom - 1))
  const lastLine = document.lineAt(Math.min(document.length, clampedTo + 1))
  const ranges: Array<{ from: number; to: number }> = []

  for (
    let lineNumber = firstLine.number;
    lineNumber <= lastLine.number;
    lineNumber += 1
  ) {
    const line = document.line(lineNumber)
    const prefix = document.sliceString(
      line.from,
      Math.min(line.to, line.from + maximumBlockDelimiterContext)
    )
    const opening = blockPairingOpening.exec(prefix)
    const openingDelimiter = opening?.[1]
    if (opening && openingDelimiter) {
      const delimiterFrom = line.from + opening[0].lastIndexOf(openingDelimiter)
      ranges.push({
        from: delimiterFrom,
        to: delimiterFrom + openingDelimiter.length,
      })
    }

    const tailFrom = Math.max(line.from, line.to - maximumBlockDelimiterContext)
    const tail = document.sliceString(tailFrom, line.to)
    const trailingMath = /(\$\$(?!\$)|\\\])[ \t]*$/.exec(tail)
    const trailingDelimiter = trailingMath?.[1]
    if (
      trailingMath &&
      trailingDelimiter &&
      !(
        trailingDelimiter === "$$" &&
        trailingMath.index > 0 &&
        tail[trailingMath.index - 1] === "$"
      )
    ) {
      const delimiterFrom =
        tailFrom +
        trailingMath.index +
        trailingMath[0].indexOf(trailingDelimiter)
      ranges.push({
        from: delimiterFrom,
        to: delimiterFrom + trailingDelimiter.length,
      })
    }
  }
  return ranges
}

function changedLinesContainBlockPairingDelimiter(
  document: Text,
  from: number,
  to: number
) {
  return blockPairingDelimiterRanges(document, from, to).length > 0
}

/**
 * Symmetric fenced-code and display-math delimiters can re-pair beyond both
 * syntax nodes touching an edit. Changes on those rare delimiter-bearing
 * lines require document-wide semantic-index invalidation because indentation,
 * line splitting, and fenced-code info strings can activate an existing
 * delimiter without changing its marker bytes. Ordinary prose stays local.
 */
export function markdownBlockPairingMayChange(transaction: Transaction) {
  const cached = blockPairingChangeCache.get(transaction)
  if (cached != null) return cached

  let changed = false
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (changed) return
    changed =
      changedLinesContainBlockPairingDelimiter(
        transaction.startState.doc,
        fromA,
        toA
      ) ||
      changedLinesContainBlockPairingDelimiter(
        transaction.state.doc,
        fromB,
        toB
      )
  })
  blockPairingChangeCache.set(transaction, changed)
  return changed
}

/**
 * Return a full-document Markdown tree without putting full parsing on the
 * ordinary transaction path. The active parser preserves configured Markdown
 * extensions, and the immutable document key makes repeat index lookups free.
 */
export function completeMarkdownSyntaxTree(state: EditorState) {
  const parser = state.facet(language)?.parser ?? markdownLanguage.parser
  const cached = completeTreeCache.get(state.doc)
  if (cached?.parser === parser) return cached.tree

  const incrementalTree = syntaxTree(state)
  // `ensureSyntaxTree` advances CodeMirror's mutable ParseContext without
  // publishing the resulting tree to this immutable EditorState. Calling it
  // while building decorations can therefore make later availability checks
  // disagree with `syntaxTree(state)`. Parse independently when the state's
  // published tree is incomplete so document-wide indexes remain side-effect
  // free and the viewport renderer keeps one coherent syntax-tree snapshot.
  // During a language-compartment reconfiguration, CodeMirror can briefly
  // publish the previous parser's complete tree on the new state. A cache
  // entry for this immutable document under another parser proves that the
  // language changed, so do not relabel that stale tree as belonging to the
  // new parser. Presentation plugins are constructed in the same transaction
  // as the parser change and require the new node set immediately.
  const cachedParserChanged = cached != null && cached.parser !== parser
  const publishedParser = completeTreeParsers.get(incrementalTree)
  const publishedParserChanged =
    publishedParser != null && publishedParser !== parser
  const tree =
    !cachedParserChanged &&
    !publishedParserChanged &&
    syntaxTreeAvailable(state, state.doc.length) &&
    incrementalTree.length >= state.doc.length
      ? incrementalTree
      : parser.parse(new DocInput(state.doc))
  completeTreeCache.set(state.doc, { parser, tree })
  completeTreeParsers.set(tree, parser)
  return tree
}

/**
 * Incrementally update a previously complete Markdown tree after document
 * changes. This keeps state-backed, layout-changing indexes exact without
 * putting a fresh full-document parse on every edit.
 */
export function updateCompleteMarkdownSyntaxTree(
  state: EditorState,
  changes: ChangeDesc,
  previousTree: Tree
) {
  const parser = state.facet(language)?.parser ?? markdownLanguage.parser
  const previousParser = completeTreeParsers.get(previousTree)
  if (
    parser !== previousParser ||
    previousTree.length !== changes.length ||
    state.doc.length !== changes.newLength ||
    changes.empty
  ) {
    return completeMarkdownSyntaxTree(state)
  }

  const cached = completeTreeCache.get(state.doc)
  if (cached?.parser === parser) return cached.tree

  const fragments = TreeFragment.applyChanges(
    TreeFragment.addTree(previousTree),
    lineExpandedChangedRanges(state, changes)
  )
  const tree = parser.parse(new DocInput(state.doc), fragments)
  completeTreeCache.set(state.doc, { parser, tree })
  completeTreeParsers.set(tree, parser)
  return tree
}
