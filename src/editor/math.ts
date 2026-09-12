import { syntaxTree } from "@codemirror/language"
import {
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view"
import type { SyntaxNode, Tree } from "@lezer/common"
import type { InlineContext, MarkdownConfig } from "@lezer/markdown"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"
import { createRetryablePromiseLoader } from "../lib/retryable-promise"

import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  firstNearbyPreviewRange,
  livePreviewRefreshRequested,
  preservePreviewDuringPointerSelection,
  previewPositionAtDOM,
  previewScanRanges,
  queuePreviewRebuild,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"
import { PreviewHeightCache } from "./optional-preview-geometry"
import { boundedPreviewMaxWidth } from "./theme"

const INLINE_MATH_NODE = "InlineMath"
const INLINE_DISPLAY_MATH_NODE = "InlineDisplayMath"
const INLINE_MATH_MARK_NODE = "InlineMathMark"
const BLOCK_MATH_NODE = "BlockMath"
const BLOCK_MATH_MARK_NODE = "BlockMathMark"
const MATH_TEXT_NODE = "MathText"

function whitespace(character: number) {
  return (
    character < 0 ||
    character === 9 ||
    character === 10 ||
    character === 13 ||
    character === 32
  )
}

function digit(character: number) {
  return character >= 48 && character <= 57
}

function stringCharacterIsEscaped(text: string, position: number) {
  let backslashes = 0
  for (let cursor = position - 1; text.charCodeAt(cursor) === 92; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

interface InlineCloseCandidate {
  readonly line: number
  readonly position: number
}

interface InlineCloseIndex {
  readonly dollar: readonly InlineCloseCandidate[]
  readonly lineBreaks: readonly number[]
  readonly parenthesis: readonly InlineCloseCandidate[]
}

const inlineCloseIndexes = new WeakMap<InlineContext, InlineCloseIndex>()

function inlineCloseIndex(context: InlineContext): InlineCloseIndex {
  const cached = inlineCloseIndexes.get(context)
  if (cached) return cached

  const dollar: InlineCloseCandidate[] = []
  const lineBreaks: number[] = []
  const parenthesis: InlineCloseCandidate[] = []
  let precedingBackslashes = 0
  let line = 0

  for (let offset = 0; offset < context.text.length; offset += 1) {
    const character = context.text.charCodeAt(offset)
    const escaped = precedingBackslashes % 2 === 1
    const position = context.offset + offset

    if (
      character === 36 &&
      context.text.charCodeAt(offset - 1) !== 36 &&
      context.text.charCodeAt(offset + 1) !== 36 &&
      !escaped &&
      !whitespace(context.text.charCodeAt(offset - 1)) &&
      !digit(context.text.charCodeAt(offset + 1))
    ) {
      dollar.push({ line, position })
    }
    if (
      character === 92 &&
      context.text.charCodeAt(offset + 1) === 41 &&
      !escaped
    ) {
      parenthesis.push({ line, position })
    }

    if (character === 10 || character === 13) {
      lineBreaks.push(position)
      line += 1
    }
    precedingBackslashes = character === 92 ? precedingBackslashes + 1 : 0
  }

  const index = { dollar, lineBreaks, parenthesis }
  inlineCloseIndexes.set(context, index)
  return index
}

function lowerBoundCandidate(
  candidates: readonly InlineCloseCandidate[],
  position: number
) {
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (candidates[middle]!.position < position) low = middle + 1
    else high = middle
  }
  return candidates[low] ?? null
}

function lineAtPosition(lineBreaks: readonly number[], position: number) {
  let low = 0
  let high = lineBreaks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lineBreaks[middle]! < position) low = middle + 1
    else high = middle
  }
  return low
}

function indexedInlineClose(
  context: InlineContext,
  from: number,
  kind: "dollar" | "parenthesis"
) {
  const index = inlineCloseIndex(context)
  const candidate = lowerBoundCandidate(index[kind], from)
  return candidate && candidate.line === lineAtPosition(index.lineBreaks, from)
    ? candidate.position
    : -1
}

function findDollarClose(context: InlineContext, from: number) {
  return indexedInlineClose(context, from, "dollar")
}

function findBackslashClose(
  context: InlineContext,
  from: number,
  closingCharacter: number
) {
  return closingCharacter === 41
    ? indexedInlineClose(context, from, "parenthesis")
    : -1
}

function inlineMathElement(
  context: InlineContext,
  from: number,
  openLength: number,
  closeFrom: number,
  closeLength: number
) {
  const contentFrom = from + openLength
  const to = closeFrom + closeLength
  return context.elt(INLINE_MATH_NODE, from, to, [
    context.elt(INLINE_MATH_MARK_NODE, from, contentFrom),
    context.elt(MATH_TEXT_NODE, contentFrom, closeFrom),
    context.elt(INLINE_MATH_MARK_NODE, closeFrom, to),
  ])
}

function findInlineDisplayClose(context: InlineContext, from: number) {
  const localFrom = from - context.offset
  for (let offset = localFrom; offset <= context.text.length - 2; offset += 1) {
    if (!context.text.startsWith("$$", offset)) continue
    if (stringCharacterIsEscaped(context.text, offset)) continue
    if (
      context.text.charCodeAt(offset - 1) === 36 ||
      context.text.charCodeAt(offset + 2) === 36
    ) {
      continue
    }
    return context.offset + offset
  }
  return -1
}

function inlineDisplayMathElement(
  context: InlineContext,
  from: number,
  closeFrom: number
) {
  const contentFrom = from + 2
  const to = closeFrom + 2
  return context.elt(INLINE_DISPLAY_MATH_NODE, from, to, [
    context.elt(INLINE_MATH_MARK_NODE, from, contentFrom),
    context.elt(MATH_TEXT_NODE, contentFrom, closeFrom),
    context.elt(INLINE_MATH_MARK_NODE, closeFrom, to),
  ])
}

interface DisplayDelimiter {
  readonly close: string
  readonly open: string
}

function displayDelimiterAt(
  text: string,
  position: number
): DisplayDelimiter | null {
  if (text.startsWith("$$", position) && text.charCodeAt(position + 2) !== 36) {
    return { open: "$$", close: "$$" }
  }
  if (text.startsWith("\\[", position)) {
    return { open: "\\[", close: "\\]" }
  }
  return null
}

function findDisplayClose(
  text: string,
  from: number,
  delimiter: DisplayDelimiter
) {
  for (
    let position = from;
    position <= text.length - delimiter.close.length;
    position += 1
  ) {
    if (!text.startsWith(delimiter.close, position)) continue
    if (stringCharacterIsEscaped(text, position)) continue
    if (
      delimiter.close === "$$" &&
      (text.charCodeAt(position - 1) === 36 ||
        text.charCodeAt(position + 2) === 36)
    ) {
      continue
    }
    if (/^[\t ]*$/.test(text.slice(position + delimiter.close.length))) {
      return position
    }
  }
  return -1
}

/** Markdown parser support for `$…$`, `\(…\)`, `$$…$$`, and `\[…\]`. */
export const mathMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    INLINE_MATH_NODE,
    INLINE_DISPLAY_MATH_NODE,
    INLINE_MATH_MARK_NODE,
    { name: BLOCK_MATH_NODE, block: true },
    BLOCK_MATH_MARK_NODE,
    MATH_TEXT_NODE,
  ],
  parseInline: [
    {
      name: "Math",
      before: "Escape",
      parse(context, next, position) {
        if (next === 36) {
          if (
            context.char(position + 1) === 36 &&
            context.char(position + 2) !== 36
          ) {
            const close = findInlineDisplayClose(context, position + 2)
            if (
              close < 0 ||
              context.slice(position + 2, close).trim().length === 0
            ) {
              return -1
            }
            return context.addElement(
              inlineDisplayMathElement(context, position, close)
            )
          }
          if (
            context.char(position - 1) === 36 ||
            context.char(position + 1) === 36 ||
            whitespace(context.char(position + 1))
          ) {
            return -1
          }
          const close = findDollarClose(context, position + 1)
          if (close < 0) return -1
          return context.addElement(
            inlineMathElement(context, position, 1, close, 1)
          )
        }

        if (next !== 92 || context.char(position + 1) !== 40) return -1
        const close = findBackslashClose(context, position + 2, 41)
        if (
          close < 0 ||
          context.slice(position + 2, close).trim().length === 0
        ) {
          return -1
        }
        return context.addElement(
          inlineMathElement(context, position, 2, close, 2)
        )
      },
    },
  ],
  parseBlock: [
    {
      name: "MathBlock",
      after: "IndentedCode",
      before: "FencedCode",
      endLeaf(_context, line) {
        return displayDelimiterAt(line.text, line.pos) != null
      },
      parse(context, line) {
        const delimiter = displayDelimiterAt(line.text, line.pos)
        if (!delimiter) return false

        const from = context.lineStart + line.pos
        const openingTo = from + delimiter.open.length
        const openingBaseIndent = line.baseIndent
        const children = [context.elt(BLOCK_MATH_MARK_NODE, from, openingTo)]
        let to: number
        const firstContentPosition = line.pos + delimiter.open.length
        const firstClose = findDisplayClose(
          line.text,
          firstContentPosition,
          delimiter
        )

        if (firstClose >= 0) {
          if (firstContentPosition < firstClose) {
            children.push(
              context.elt(
                MATH_TEXT_NODE,
                context.lineStart + firstContentPosition,
                context.lineStart + firstClose
              )
            )
          }
          const closingFrom = context.lineStart + firstClose
          to = closingFrom + delimiter.close.length
          children.push(context.elt(BLOCK_MATH_MARK_NODE, closingFrom, to))
          context.nextLine()
        } else {
          if (firstContentPosition < line.text.length) {
            children.push(
              context.elt(
                MATH_TEXT_NODE,
                context.lineStart + firstContentPosition,
                context.lineStart + line.text.length
              )
            )
          }
          to = context.lineStart + line.text.length

          while (context.nextLine() && line.baseIndent >= openingBaseIndent) {
            const contentPosition = line.basePos
            const close = findDisplayClose(
              line.text,
              contentPosition,
              delimiter
            )
            if (close >= 0) {
              if (contentPosition < close) {
                children.push(
                  context.elt(
                    MATH_TEXT_NODE,
                    context.lineStart + contentPosition,
                    context.lineStart + close
                  )
                )
              }
              const closingFrom = context.lineStart + close
              to = closingFrom + delimiter.close.length
              children.push(context.elt(BLOCK_MATH_MARK_NODE, closingFrom, to))
              context.nextLine()
              break
            }

            if (contentPosition < line.text.length) {
              children.push(
                context.elt(
                  MATH_TEXT_NODE,
                  context.lineStart + contentPosition,
                  context.lineStart + line.text.length
                )
              )
            }
            to = context.lineStart + line.text.length
          }
        }

        // Keep an unfinished display construct in one syntax node, like a
        // fenced code block. The preview layer deliberately leaves it as
        // source until a closing delimiter exists.
        context.addElement(context.elt(BLOCK_MATH_NODE, from, to, children))
        return true
      },
    },
  ],
}

export interface MathExpression {
  readonly block: boolean
  readonly display: boolean
  readonly from: number
  readonly source: string
  readonly to: number
}

export const maximumMathSourceLength = 10_000

function directChildren(node: SyntaxNode) {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

function mathExpression(
  state: EditorState,
  node: SyntaxNode
): MathExpression | null {
  const block = node.name === BLOCK_MATH_NODE
  const display = block || node.name === INLINE_DISPLAY_MATH_NODE
  const children = directChildren(node)
  const markName = block ? BLOCK_MATH_MARK_NODE : INLINE_MATH_MARK_NODE
  if (children.filter((child) => child.name === markName).length !== 2) {
    return null
  }

  const sourceNodes = children.filter((child) => child.name === MATH_TEXT_NODE)
  const separatorLength = block ? Math.max(0, sourceNodes.length - 1) : 0
  const rawSourceLength =
    separatorLength +
    sourceNodes.reduce((length, child) => length + child.to - child.from, 0)
  if (rawSourceLength > maximumMathSourceLength) return null

  const source = sourceNodes
    .map((child) => state.sliceDoc(child.from, child.to))
    .join(block ? "\n" : "")
    .replace(display && !block ? /<br(?:\s[^>]*)?\/?>/gi : /$^/, "\n")
    .trim()
  if (!source || source.length > maximumMathSourceLength) return null
  return { block, display, from: node.from, source, to: node.to }
}

interface DocumentRange {
  readonly from: number
  readonly to: number
}

function mathExpressionsInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  tree: Tree = syntaxTree(state),
  kind: "all" | "display" | "inline" = "all"
) {
  const expressions: MathExpression[] = []
  const seen = new Set<number>()
  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        const block = node.name === BLOCK_MATH_NODE
        const inlineDisplay = node.name === INLINE_DISPLAY_MATH_NODE
        if (
          range &&
          (node.to <= range.from || node.from >= range.to) &&
          (node.name === INLINE_MATH_NODE || inlineDisplay || block)
        ) {
          return false
        }
        if (
          (node.name !== INLINE_MATH_NODE && !inlineDisplay && !block) ||
          (kind === "display" && !block) ||
          (kind === "inline" && block) ||
          seen.has(node.from)
        ) {
          return
        }
        seen.add(node.from)
        const expression = mathExpression(state, node.node)
        if (expression) expressions.push(expression)
        return false
      },
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan(null)
  }
  return expressions.sort((left, right) => left.from - right.from)
}

/** Extracts closed math constructs from the configured Markdown syntax tree. */
export function mathExpressions(state: EditorState): readonly MathExpression[] {
  return mathExpressionsInRanges(state, null, completeMarkdownSyntaxTree(state))
}

/** Finds any closed rendered math expression containing a document position. */
export function mathExpressionAt(
  state: EditorState,
  position: number
): MathExpression | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  const names = new Set([
    BLOCK_MATH_NODE,
    INLINE_DISPLAY_MATH_NODE,
    INLINE_MATH_NODE,
  ])
  const seen = new Set<number>()
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (names.has(node.name) && !seen.has(node.from)) {
        seen.add(node.from)
        if (node.from <= boundedPosition && boundedPosition <= node.to) {
          const expression = mathExpression(state, node)
          if (expression) return expression
        }
      }
      node = node.parent
    }
  }
  return null
}

/** Returns only authored math content, excluding its opening and closing marks. */
export function mathSelectionRangeAt(
  state: EditorState,
  position: number
): DocumentRange | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  const names = new Set([
    BLOCK_MATH_NODE,
    INLINE_DISPLAY_MATH_NODE,
    INLINE_MATH_NODE,
  ])
  const seen = new Set<number>()
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (names.has(node.name) && !seen.has(node.from)) {
        seen.add(node.from)
        const expression = mathExpression(state, node)
        const sourceNodes = directChildren(node).filter(
          (child) => child.name === MATH_TEXT_NODE
        )
        const first = sourceNodes.at(0)
        const last = sourceNodes.at(-1)
        if (expression && first && last) {
          return { from: first.from, to: last.to }
        }
      }
      node = node.parent
    }
  }
  return null
}

class IndexedDisplayMathExpression extends RangeValue {
  readonly source: string

  constructor(source: string) {
    super()
    this.source = source
  }

  eq(other: RangeValue) {
    return (
      other instanceof IndexedDisplayMathExpression &&
      other.source === this.source
    )
  }

  materialize(from: number, to: number): MathExpression {
    return { block: true, display: true, from, source: this.source, to }
  }
}

function buildDisplayMathIndex(expressions: readonly MathExpression[]) {
  return RangeSet.of(
    expressions.map((expression) =>
      new IndexedDisplayMathExpression(expression.source).range(
        expression.from,
        expression.to
      )
    ),
    true
  )
}

function indexedDisplayMathExpressions(
  state: EditorState,
  index: RangeSet<IndexedDisplayMathExpression>,
  ranges: readonly DocumentRange[] | null = null
) {
  const expressions: MathExpression[] = []
  const seen = new Set<IndexedDisplayMathExpression>()
  const scan = (range: DocumentRange) => {
    index.between(range.from, range.to, (from, to, value) => {
      if (to <= range.from || from >= range.to) return
      if (seen.has(value)) return
      seen.add(value)
      expressions.push(value.materialize(from, to))
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan({ from: 0, to: state.doc.length })
  }
  return expressions
}

function mergeDocumentRanges(ranges: readonly DocumentRange[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: DocumentRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.from > previous.to) {
      merged.push(range)
      continue
    }
    merged[merged.length - 1] = {
      from: previous.from,
      to: Math.max(previous.to, range.to),
    }
  }
  return merged
}

function lineNeighborhood(
  state: EditorState,
  from: number,
  to: number
): DocumentRange {
  const clampedFrom = Math.max(0, Math.min(state.doc.length, from))
  const clampedTo = Math.max(clampedFrom, Math.min(state.doc.length, to))
  const first = state.doc.lineAt(clampedFrom)
  const last = state.doc.lineAt(
    clampedTo > clampedFrom ? clampedTo - 1 : clampedTo
  )
  return {
    from: first.number > 1 ? state.doc.line(first.number - 1).from : first.from,
    to:
      last.number < state.doc.lines
        ? state.doc.line(last.number + 1).to
        : last.to,
  }
}

function expandToTopLevelSyntax(
  state: EditorState,
  range: DocumentRange,
  tree: Tree
): DocumentRange {
  const neighborhood = lineNeighborhood(state, range.from, range.to)
  let from = neighborhood.from
  let to = neighborhood.to
  tree.iterate({
    from: neighborhood.from,
    to: neighborhood.to,
    enter(node) {
      if (node.node.parent?.parent != null || node.node.parent == null) return
      from = Math.min(from, node.from)
      to = Math.max(to, node.to)
      return false
    },
  })
  return { from, to }
}

function changedSyntaxRanges(
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  const candidates: DocumentRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const previous = expandToTopLevelSyntax(
      transaction.startState,
      { from: fromA, to: toA },
      previousTree
    )
    candidates.push({
      from: transaction.changes.mapPos(previous.from, -1),
      to: transaction.changes.mapPos(previous.to, 1),
    })
    candidates.push(
      expandToTopLevelSyntax(
        transaction.state,
        { from: fromB, to: toB },
        nextTree
      )
    )
  })
  return mergeDocumentRanges(
    mergeDocumentRanges(candidates).map((range) =>
      expandToTopLevelSyntax(transaction.state, range, nextTree)
    )
  )
}

function expandSyntaxRangesThroughMappedDisplayMath(
  state: EditorState,
  tree: Tree,
  index: RangeSet<IndexedDisplayMathExpression>,
  ranges: readonly DocumentRange[]
) {
  let expanded = mergeDocumentRanges(ranges)
  for (;;) {
    const candidates = [...expanded]
    for (const range of expanded) {
      index.between(range.from, range.to, (from, to) => {
        if (to > range.from && from < range.to) candidates.push({ from, to })
      })
    }
    const next = mergeDocumentRanges(
      mergeDocumentRanges(candidates).map((range) =>
        expandToTopLevelSyntax(state, range, tree)
      )
    )
    if (
      next.length === expanded.length &&
      next.every(
        (range, rangeIndex) =>
          range.from === expanded[rangeIndex]?.from &&
          range.to === expanded[rangeIndex]?.to
      )
    ) {
      return next
    }
    expanded = next
  }
}

function removeIndexedDisplayMath(
  index: RangeSet<IndexedDisplayMathExpression>,
  ranges: readonly DocumentRange[]
) {
  let updated = index
  for (const range of ranges) {
    updated = updated.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function refreshDisplayMathIndex(
  previous: RangeSet<IndexedDisplayMathExpression>,
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  if (markdownBlockPairingMayChange(transaction)) {
    return {
      index: buildDisplayMathIndex(
        mathExpressionsInRanges(transaction.state, null, nextTree, "display")
      ),
      ranges: [{ from: 0, to: transaction.state.doc.length }],
    }
  }

  const mapped = previous.map(transaction.changes)
  const ranges = expandSyntaxRangesThroughMappedDisplayMath(
    transaction.state,
    nextTree,
    mapped,
    changedSyntaxRanges(transaction, previousTree, nextTree)
  )
  const retained = removeIndexedDisplayMath(mapped, ranges)
  const additions = mathExpressionsInRanges(
    transaction.state,
    ranges,
    nextTree,
    "display"
  ).map((expression) =>
    new IndexedDisplayMathExpression(expression.source).range(
      expression.from,
      expression.to
    )
  )
  return {
    index: additions.length
      ? retained.update({ add: additions, sort: true })
      : retained,
    ranges,
  }
}

/** Finds the closed display expression containing a document position. */
export function displayMathExpressionAt(
  state: EditorState,
  position: number
): MathExpression | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (
        node.name === BLOCK_MATH_NODE &&
        node.from <= boundedPosition &&
        boundedPosition <= node.to
      ) {
        return mathExpression(state, node)
      }
      node = node.parent
    }
  }
  return null
}

interface CachedMathRender {
  readonly byteSize: number
  readonly markup: string
}

const maximumCachedMathRenders = 128
const maximumCachedMathRenderBytes = 16 * 1024 * 1024
const mathRenderCache = new Map<string, CachedMathRender>()
const mathHeightCache = new PreviewHeightCache(maximumCachedMathRenders)
let cachedMathRenderBytes = 0

function mathRenderKey(source: string, display: boolean) {
  return JSON.stringify([display, source])
}

function cachedMathRender(key: string) {
  const cached = mathRenderCache.get(key)
  if (!cached) return null
  mathRenderCache.delete(key)
  mathRenderCache.set(key, cached)
  return cached
}

function cacheMathRender(key: string, markup: string) {
  const cached = mathRenderCache.get(key)
  if (cached) {
    cachedMathRenderBytes -= cached.byteSize
    mathRenderCache.delete(key)
  }
  const byteSize = (key.length + markup.length) * 2
  if (byteSize > maximumCachedMathRenderBytes) return null
  const entry = { byteSize, markup }
  mathRenderCache.set(key, entry)
  cachedMathRenderBytes += byteSize
  while (
    mathRenderCache.size > maximumCachedMathRenders ||
    cachedMathRenderBytes > maximumCachedMathRenderBytes
  ) {
    const oldest = mathRenderCache.keys().next().value
    if (oldest == null) break
    const removed = mathRenderCache.get(oldest)
    if (removed) cachedMathRenderBytes -= removed.byteSize
    mathRenderCache.delete(oldest)
  }
  return entry
}

function rememberMathHeight(key: string, height: number) {
  mathHeightCache.set(key, height)
}

export function invalidateMathPreviewGeometry() {
  mathHeightCache.invalidate()
}

const loadKatexModule = createRetryableDynamicImport(() => import("katex"))
const loadKatexStyles = createRetryableDynamicImport(
  () => import("katex/dist/katex.min.css")
)
const loadKatex = createRetryablePromiseLoader(() =>
  Promise.all([loadKatexModule(), loadKatexStyles()]).then(([katex]) => katex)
)

function requestMathMeasure(
  math: HTMLElement,
  view: EditorView,
  cacheKey: string
) {
  view.requestMeasure({
    key: math,
    read: (currentView) =>
      math.isConnected
        ? math.getBoundingClientRect().height / currentView.scaleY
        : null,
    write: (height) => {
      if (height != null) rememberMathHeight(cacheKey, height)
    },
  })
}

function showRenderedMath(math: HTMLElement, markup: string) {
  math.innerHTML = markup
  math.style.minHeight = ""
  math.classList.remove("cm-md-math-loading", "cm-md-math-error")
}

class MathWidget extends WidgetType {
  readonly block: boolean
  readonly display: boolean
  readonly source: string

  constructor(source: string, display: boolean, block: boolean) {
    super()
    this.source = source
    this.display = display
    this.block = block
  }

  eq(other: MathWidget) {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.block === other.block
    )
  }

  get estimatedHeight() {
    if (!this.display) return -1
    return mathHeightCache.get(mathRenderKey(this.source, this.display)) ?? 80
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const math = view.dom.ownerDocument.createElement(
      this.block ? "div" : "span"
    )
    math.className = this.display
      ? "cm-md-math cm-md-math-block cm-md-math-loading"
      : "cm-md-math cm-md-math-inline cm-md-math-loading"
    math.dataset.mathSource = this.source
    math.dataset.mathDisplay = String(this.display)
    const cacheKey = mathRenderKey(this.source, this.display)
    const cached = cachedMathRender(cacheKey)
    if (cached) {
      showRenderedMath(math, cached.markup)
      requestMathMeasure(math, view, cacheKey)
      return math
    }

    math.textContent = this.source
    if (this.display) math.style.minHeight = `${this.estimatedHeight}px`

    void loadKatex()
      .then((katex) => {
        if (
          !math.isConnected ||
          math.dataset.mathSource !== this.source ||
          math.dataset.mathDisplay !== String(this.display)
        ) {
          return
        }
        const markup = katex.renderToString(this.source, {
          displayMode: this.display,
          output: "htmlAndMathml",
          strict: "ignore",
          throwOnError: false,
          trust: false,
        })
        cacheMathRender(cacheKey, markup)
        showRenderedMath(math, markup)
        requestMathMeasure(math, view, cacheKey)
      })
      .catch(() => {
        if (!math.isConnected || math.dataset.mathSource !== this.source) {
          return
        }
        math.style.minHeight = ""
        math.classList.remove("cm-md-math-loading")
        math.classList.add("cm-md-math-error")
        math.textContent = this.source
        view.requestMeasure()
      })

    return math
  }
}

function selectionTouches(
  state: EditorState,
  expression: MathExpression,
  presentation: DocumentRange,
  selectionActive: boolean
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive &&
        range.head >= presentation.from &&
        range.head <= presentation.to
      : (range.from < presentation.to && range.to > presentation.from) ||
        (!expression.block &&
          selectionActive &&
          (range.head === expression.from || range.head === expression.to))
  )
}

function mathPresentationRange(
  state: EditorState,
  expression: MathExpression
): DocumentRange {
  if (!expression.block) return expression
  // A whole-line block replacement otherwise leaves CodeMirror boundary
  // rows beside the widget. Consume one line break on either side while
  // retaining any authored blank line beyond it, just like block HTML.
  const firstLine = state.doc.lineAt(expression.from)
  const lastLine = state.doc.lineAt(
    Math.max(expression.from, expression.to - 1)
  )
  const from = /^[\t ]*$/.test(state.sliceDoc(firstLine.from, expression.from))
    ? firstLine.from
    : expression.from
  const to = /^[\t ]*$/.test(state.sliceDoc(expression.to, lastLine.to))
    ? lastLine.to
    : expression.to
  return {
    from: from === firstLine.from && from > 0 ? from - 1 : from,
    to: to === lastLine.to && to < state.doc.length ? to + 1 : to,
  }
}

function decorationRangesForExpressions(
  state: EditorState,
  expressions: readonly MathExpression[],
  selectionActive: boolean,
  reuseFrom: DecorationSet | null = null
) {
  const ranges: Range<Decoration>[] = []
  for (const expression of expressions) {
    const presentation = mathPresentationRange(state, expression)
    if (selectionTouches(state, expression, presentation, selectionActive)) {
      continue
    }
    let reusable: Decoration | null = null
    reuseFrom?.between(
      presentation.from,
      presentation.to,
      (from, to, value) => {
        const widget = value.spec.widget
        if (
          from === presentation.from &&
          to === presentation.to &&
          value.spec.markdownPreviewKind === "math" &&
          widget instanceof MathWidget &&
          widget.source === expression.source &&
          widget.display === expression.display &&
          widget.block === expression.block
        ) {
          reusable = value
        }
      }
    )
    ranges.push(
      (
        reusable ??
        Decoration.replace({
          block: expression.block,
          inclusive: false,
          markdownPreviewKind: "math",
          widget: new MathWidget(
            expression.source,
            expression.display,
            expression.block
          ),
        })
      ).range(presentation.from, presentation.to)
    )
  }
  return ranges
}

function decorationsForExpressions(
  state: EditorState,
  expressions: readonly MathExpression[],
  selectionActive: boolean
) {
  return Decoration.set(
    decorationRangesForExpressions(state, expressions, selectionActive),
    true
  )
}

function selectionTouchesDisplayMathIndex(
  index: RangeSet<IndexedDisplayMathExpression>,
  selection: EditorSelection,
  selectionActive: boolean,
  state: EditorState
) {
  return selection.ranges.some((range) => {
    if (range.empty && !selectionActive) return false
    const probeFrom = range.empty ? Math.max(0, range.head - 1) : range.from
    const probeTo = range.empty
      ? Math.min(state.doc.length, range.head + 1)
      : range.to
    let touches = false
    index.between(
      Math.max(0, state.doc.lineAt(probeFrom).from - 1),
      Math.min(state.doc.length, state.doc.lineAt(probeTo).to + 1),
      (from, to, value) => {
        const presentation = mathPresentationRange(
          state,
          value.materialize(from, to)
        )
        if (
          range.empty
            ? range.head >= presentation.from && range.head <= presentation.to
            : range.from < presentation.to && range.to > presentation.from
        ) {
          touches = true
        }
      }
    )
    return touches
  })
}

function displayMathRangesForSelection(
  index: RangeSet<IndexedDisplayMathExpression>,
  selection: EditorSelection,
  selectionActive: boolean,
  state: EditorState
) {
  const ranges: DocumentRange[] = []
  for (const range of selection.ranges) {
    if (range.empty && !selectionActive) continue
    const probeFrom = range.empty ? Math.max(0, range.head - 1) : range.from
    const probeTo = range.empty
      ? Math.min(state.doc.length, range.head + 1)
      : range.to
    index.between(
      Math.max(0, state.doc.lineAt(probeFrom).from - 1),
      Math.min(state.doc.length, state.doc.lineAt(probeTo).to + 1),
      (from, to, value) => {
        const presentation = mathPresentationRange(
          state,
          value.materialize(from, to)
        )
        if (
          range.empty
            ? range.head >= presentation.from && range.head <= presentation.to
            : range.from < presentation.to && range.to > presentation.from
        ) {
          ranges.push({ from, to })
        }
      }
    )
  }
  return mergeDocumentRanges(ranges)
}

function refreshDisplayMathDecorations(
  previous: DecorationSet,
  state: EditorState,
  index: RangeSet<IndexedDisplayMathExpression>,
  ranges: readonly DocumentRange[],
  selectionActive: boolean
) {
  let decorations = previous
  for (const range of ranges) {
    decorations = decorations.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  const additions = decorationRangesForExpressions(
    state,
    indexedDisplayMathExpressions(state, index, ranges),
    selectionActive,
    previous
  )
  return additions.length
    ? decorations.update({ add: additions, sort: true })
    : decorations
}

function buildInlineMathPreviewDecorations(
  state: EditorState,
  selectionActive: boolean,
  visibleRanges: readonly DocumentRange[] | null
) {
  return decorationsForExpressions(
    state,
    mathExpressionsInRanges(
      state,
      visibleRanges,
      visibleRanges == null
        ? completeMarkdownSyntaxTree(state)
        : syntaxTree(state),
      "inline"
    ),
    selectionActive
  )
}

/**
 * Builds the production-shaped math replacement set: display replacements are
 * complete, while inline replacements may be limited to materialized ranges.
 */
export function buildMathPreviewDecorations(
  state: EditorState,
  selectionActive = true,
  visibleRanges: readonly DocumentRange[] | null = null
): DecorationSet {
  const displayExpressions = mathExpressionsInRanges(
    state,
    null,
    completeMarkdownSyntaxTree(state),
    "display"
  )
  const inlineExpressions = mathExpressionsInRanges(
    state,
    visibleRanges,
    visibleRanges == null
      ? completeMarkdownSyntaxTree(state)
      : syntaxTree(state),
    "inline"
  )
  return decorationsForExpressions(
    state,
    [...displayExpressions, ...inlineExpressions].sort(
      (left, right) => left.from - right.from
    ),
    selectionActive
  )
}

export interface MathLivePreviewOptions {
  /** Mirrors live preview focus so a stale, inactive cursor stays rendered. */
  readonly selectionActive?: (state: EditorState) => boolean
}

interface DisplayMathPreviewState {
  readonly decorations: DecorationSet
  readonly index: RangeSet<IndexedDisplayMathExpression>
  readonly presentedSelection: EditorSelection
  readonly selectionActive: boolean
  readonly tree: Tree
}

const mathTheme = EditorView.baseTheme({
  ".cm-md-math": {
    color: "inherit",
    // Rendered list lines use a negative first-line text indent for their
    // marker lane. text-indent is inherited, so KaTeX would otherwise apply
    // that offset again inside its own inline box and overlap preceding prose.
    textIndent: "0",
  },
  ".cm-md-math-inline": {
    display: "inline-block",
    maxWidth: "100%",
    verticalAlign: "baseline",
  },
  ".cm-md-math-block": {
    boxSizing: "border-box",
    display: "block",
    maxWidth: boundedPreviewMaxWidth,
    overflowX: "auto",
    padding: "0.45rem 0",
    textAlign: "center",
    width: "100%",
  },
  ".cm-md-math-block .katex-display": {
    margin: "0",
  },
  ".cm-md-math-loading": {
    opacity: "0.72",
  },
  ".cm-md-math-error": {
    color: "var(--destructive)",
    fontFamily: "var(--font-mono)",
    whiteSpace: "pre-wrap",
  },
})

/**
 * Renders display math through complete direct decorations so CodeMirror's
 * height model is document-stable. Inline math remains materialized-range-only.
 */
export function mathLivePreviewExtension(
  options: MathLivePreviewOptions = {}
): Extension {
  const selectionIsActive = (state: EditorState) =>
    options.selectionActive?.(state) ?? true

  const displayField = StateField.define<DisplayMathPreviewState>({
    create(state) {
      const tree = completeMarkdownSyntaxTree(state)
      const index = buildDisplayMathIndex(
        mathExpressionsInRanges(state, null, tree, "display")
      )
      const selectionActive = selectionIsActive(state)
      return {
        decorations: decorationsForExpressions(
          state,
          indexedDisplayMathExpressions(state, index),
          selectionActive
        ),
        index,
        presentedSelection: state.selection,
        selectionActive,
        tree,
      }
    },
    update(value, transaction) {
      const publishedSyntaxChanged =
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      const completeTreeAfterSyntaxChange =
        !transaction.docChanged &&
        (publishedSyntaxChanged || transaction.reconfigured)
          ? completeMarkdownSyntaxTree(transaction.state)
          : null
      const syntaxChanged =
        transaction.docChanged ||
        (completeTreeAfterSyntaxChange !== null &&
          completeTreeAfterSyntaxChange !== value.tree)
      if (
        !syntaxChanged &&
        preservePreviewDuringPointerSelection(transaction)
      ) {
        return value
      }

      const selectionActive = selectionIsActive(transaction.state)
      const presentedSelection = transaction.state.selection
      const selectionPresentationChanged =
        selectionActive !== value.selectionActive ||
        !presentedSelection.eq(value.presentedSelection)
      if (!syntaxChanged && !selectionPresentationChanged) {
        return value
      }

      if (!syntaxChanged) {
        const previousTouches = selectionTouchesDisplayMathIndex(
          value.index,
          value.presentedSelection,
          value.selectionActive,
          transaction.state
        )
        const nextTouches = selectionTouchesDisplayMathIndex(
          value.index,
          presentedSelection,
          selectionActive,
          transaction.state
        )
        if (!previousTouches && !nextTouches) return value

        const ranges = mergeDocumentRanges([
          ...displayMathRangesForSelection(
            value.index,
            value.presentedSelection,
            value.selectionActive,
            transaction.state
          ),
          ...displayMathRangesForSelection(
            value.index,
            presentedSelection,
            selectionActive,
            transaction.state
          ),
        ])
        return {
          ...value,
          decorations: refreshDisplayMathDecorations(
            value.decorations,
            transaction.state,
            value.index,
            ranges,
            selectionActive
          ),
          presentedSelection,
          selectionActive,
        }
      }

      const tree = transaction.docChanged
        ? updateCompleteMarkdownSyntaxTree(
            transaction.state,
            transaction.changes,
            value.tree
          )
        : syntaxChanged
          ? completeTreeAfterSyntaxChange!
          : value.tree
      if (!transaction.docChanged) {
        const index = buildDisplayMathIndex(
          mathExpressionsInRanges(transaction.state, null, tree, "display")
        )
        return {
          decorations: decorationsForExpressions(
            transaction.state,
            indexedDisplayMathExpressions(transaction.state, index),
            selectionActive
          ),
          index,
          presentedSelection,
          selectionActive,
          tree,
        }
      }

      const refreshed = refreshDisplayMathIndex(
        value.index,
        transaction,
        value.tree,
        tree
      )
      const index = refreshed.index
      const mappedPresentedSelection = value.presentedSelection.map(
        transaction.changes
      )
      const ranges = mergeDocumentRanges([
        ...refreshed.ranges,
        ...displayMathRangesForSelection(
          index,
          mappedPresentedSelection,
          value.selectionActive,
          transaction.state
        ),
        ...displayMathRangesForSelection(
          index,
          presentedSelection,
          selectionActive,
          transaction.state
        ),
      ])
      return {
        decorations: refreshDisplayMathDecorations(
          value.decorations.map(transaction.changes),
          transaction.state,
          index,
          ranges,
          selectionActive
        ),
        index,
        presentedSelection,
        selectionActive,
        tree,
      }
    },
    // Block replacements that alter vertical layout must be supplied directly,
    // before CodeMirror computes its viewport.
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  })

  const setInlineDecorations = StateEffect.define<DecorationSet>()
  const inlineDecorationField = StateField.define<DecorationSet>({
    create() {
      return Decoration.none
    },
    update(value, transaction) {
      if (transaction.docChanged) value = value.map(transaction.changes)
      for (const effect of transaction.effects) {
        if (effect.is(setInlineDecorations)) value = effect.value
      }
      return value
    },
    provide: (field) => EditorView.decorations.from(field),
  })

  const preview = ViewPlugin.fromClass(
    class {
      private destroyed = false
      private pending = false
      private revision = 0
      private selectionActive: boolean

      constructor(view: EditorView) {
        this.selectionActive = selectionIsActive(view.state)
        this.schedule(view)
      }

      private schedule(view: EditorView) {
        if (this.pending) return
        this.pending = true
        const revision = this.revision
        queuePreviewRebuild(() => {
          if (this.destroyed || revision !== this.revision) return
          this.pending = false
          this.selectionActive = selectionIsActive(view.state)
          view.dispatch({
            effects: setInlineDecorations.of(
              buildInlineMathPreviewDecorations(
                view.state,
                this.selectionActive,
                previewScanRanges(
                  view.visibleRanges,
                  view.viewport,
                  view.state.field(inlineDecorationField)
                )
              )
            ),
          })
        })
      }

      private cancelScheduledBuild() {
        this.revision += 1
        this.pending = false
      }

      update(update: ViewUpdate) {
        if (update.transactions.some(preservePreviewDuringPointerSelection)) {
          this.cancelScheduledBuild()
          return
        }
        const selectionActive = selectionIsActive(update.state)
        const treeChanged =
          syntaxTree(update.startState) !== syntaxTree(update.state)
        const refreshRequested = update.transactions.some(
          livePreviewRefreshRequested
        )
        if (
          !update.docChanged &&
          !update.viewportChanged &&
          !update.selectionSet &&
          !treeChanged &&
          !refreshRequested &&
          selectionActive === this.selectionActive
        ) {
          return
        }
        this.selectionActive = selectionActive
        this.schedule(update.view)
      }

      destroy() {
        this.destroyed = true
        this.cancelScheduledBuild()
      }
    }
  )

  const pointerSelection = semanticPreviewSelectionResolvers.of({
    priority: 50,
    resolve(view, target, position) {
      const element = target.closest<HTMLElement>(".cm-md-math")
      if (!element) return null
      const sourcePosition = previewPositionAtDOM(view, element, position)
      const expression = firstNearbyPreviewRange(
        view.state,
        sourcePosition,
        (candidate) => {
          const resolved = mathExpressionAt(view.state, candidate)
          return resolved?.source === element.dataset.mathSource
            ? resolved
            : null
        }
      )
      if (!expression) return null
      // A block widget is mounted across a presentation range that can begin
      // one newline before the authored delimiter. Resolve inner selection
      // bounds from the matched expression itself, not that DOM edge.
      const selection = mathSelectionRangeAt(view.state, expression.from)
      return {
        dragSelection: "atomic" as const,
        element,
        from: expression.from,
        selectionFrom: selection?.from,
        selectionTo: selection?.to,
        to: expression.to,
      }
    },
  })

  return [
    Prec.highest(displayField),
    Prec.highest(inlineDecorationField),
    preview,
    pointerSelection,
    mathTheme,
  ]
}
