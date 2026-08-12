import { syntaxTree } from "@codemirror/language"
import {
  Facet,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorState,
  type EditorSelection,
  type Extension,
  type Line,
  type Range,
  type Transaction,
} from "@codemirror/state"
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common"
import {
  BlockWrapper,
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"

import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  livePreviewRefreshRequested,
  preservePreviewDuringPointerSelection,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"
import {
  contextPreservingRegexpSearchSupported,
  searchCursorForRange,
} from "./search-cursor"
import {
  currentSearchMatch,
  editorSearchIssue,
  editorSearchQuery,
} from "./search-state"
import { markdownContainerPrefix } from "./markdown-prefix"
import { boundedPreviewMaxWidth } from "./theme"

export type CalloutFoldModifier = "+" | "-" | null

export type CalloutCategory =
  | "abstract"
  | "bug"
  | "danger"
  | "example"
  | "failure"
  | "important"
  | "info"
  | "question"
  | "quote"
  | "success"
  | "tip"
  | "todo"
  | "warning"

type CalloutPalette =
  "danger" | "example" | "info" | "quote" | "success" | "tip"

export interface CalloutBlock {
  readonly kind: "callout"
  readonly from: number
  readonly to: number
  readonly wrapperFrom: number
  readonly depth: number
  readonly headerFrom: number
  readonly headerTo: number
  readonly headerLineFrom: number
  readonly titleFrom: number | null
  readonly titleTo: number | null
  readonly bodyFrom: number | null
  readonly type: string
  readonly title: string
  readonly category: CalloutCategory
  readonly modifier: CalloutFoldModifier
  readonly foldable: boolean
  readonly initiallyCollapsed: boolean
  readonly signature: string
}

export interface OrdinaryQuoteBlock {
  readonly kind: "quote"
  readonly from: number
  readonly to: number
  readonly wrapperFrom: number
  readonly depth: number
}

export type MarkdownQuoteBlock = CalloutBlock | OrdinaryQuoteBlock

export interface CalloutBlockExtensionOptions {
  /** Mirrors the caret-visibility state used by live preview. */
  readonly selectionActiveState?: (state: EditorState) => boolean
}

export interface CalloutEditingRange {
  readonly from: number
  readonly to: number
}

/** The complete callout source range currently presented for editing. */
export const calloutEditingRange = Facet.define<
  CalloutEditingRange | null,
  CalloutEditingRange | null
>({
  combine: (values) => values.at(-1) ?? null,
  compare: (left, right) =>
    left?.from === right?.from && left?.to === right?.to,
})

export interface CalloutFoldOverride {
  readonly collapsed: boolean
  readonly signature: string
}

interface CalloutBlockState {
  readonly blockIndex: RangeSet<IndexedMarkdownQuoteBlock>
  readonly editing: CalloutBlock | null
  readonly overrides: ReadonlyMap<number, CalloutFoldOverride>
  readonly presentedSelection: EditorSelection
  readonly presentedSelectionActive: boolean
  readonly presentedWordCharacters: string
  readonly transitions: ReadonlyMap<number, CalloutFoldTransition>
  readonly folds: DecorationSet
  readonly headers: DecorationSet
  readonly transitionAtomicRanges: DecorationSet
  readonly tree: Tree
  readonly wrappers: ReturnType<typeof BlockWrapper.set>
}

interface DocumentRange {
  readonly from: number
  readonly to: number
}

class IndexedMarkdownQuoteBlock extends RangeValue {
  readonly block: MarkdownQuoteBlock

  constructor(block: MarkdownQuoteBlock) {
    super()
    this.block = block
  }

  eq(other: RangeValue) {
    return (
      other instanceof IndexedMarkdownQuoteBlock && other.block === this.block
    )
  }

  materialize(from: number, to: number): MarkdownQuoteBlock {
    const delta = from - this.block.wrapperFrom
    if (this.block.kind === "quote") {
      return {
        ...this.block,
        from: this.block.from + delta,
        to,
        wrapperFrom: from,
      }
    }

    return {
      ...this.block,
      from: this.block.from + delta,
      to,
      wrapperFrom: from,
      headerFrom: this.block.headerFrom + delta,
      headerTo: this.block.headerTo + delta,
      headerLineFrom: this.block.headerLineFrom + delta,
      titleFrom:
        this.block.titleFrom == null ? null : this.block.titleFrom + delta,
      titleTo: this.block.titleTo == null ? null : this.block.titleTo + delta,
      bodyFrom:
        this.block.bodyFrom == null ? null : this.block.bodyFrom + delta,
    }
  }
}

interface SetCalloutCollapsedValue {
  readonly from: number
  readonly signature: string
  readonly collapsed: boolean
}

export const setCalloutCollapsed = StateEffect.define<SetCalloutCollapsedValue>(
  {
    map: (value, changes) => ({
      ...value,
      from: changes.mapPos(value.from, 1),
    }),
  }
)

interface CalloutFoldTransition extends SetCalloutCollapsedValue {
  readonly token: number
}

interface FinishCalloutFoldTransitionValue {
  readonly from: number
  readonly signature: string
  readonly token: number
}

const beginCalloutFoldTransition = StateEffect.define<CalloutFoldTransition>({
  map: (value, changes) => ({
    ...value,
    from: changes.mapPos(value.from, 1),
  }),
})

const finishCalloutFoldTransition =
  StateEffect.define<FinishCalloutFoldTransitionValue>({
    map: (value, changes) => ({
      ...value,
      from: changes.mapPos(value.from, 1),
    }),
  })

let nextCalloutFoldTransitionToken = 1

function calloutFoldTransitionToken() {
  const token = nextCalloutFoldTransitionToken
  nextCalloutFoldTransitionToken =
    nextCalloutFoldTransitionToken >= Number.MAX_SAFE_INTEGER ? 1 : token + 1
  return token
}

const typeCategories: Readonly<Record<string, CalloutCategory>> = {
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  bug: "bug",
  danger: "danger",
  error: "danger",
  example: "example",
  fail: "failure",
  failure: "failure",
  missing: "failure",
  important: "important",
  info: "info",
  note: "info",
  faq: "question",
  help: "question",
  question: "question",
  cite: "quote",
  quote: "quote",
  check: "success",
  done: "success",
  success: "success",
  hint: "tip",
  tip: "tip",
  todo: "todo",
  attention: "warning",
  warning: "warning",
  caution: "danger",
}

const categoryPalettes: Readonly<Record<CalloutCategory, CalloutPalette>> = {
  abstract: "info",
  bug: "danger",
  danger: "danger",
  example: "example",
  failure: "danger",
  important: "example",
  info: "info",
  question: "quote",
  quote: "quote",
  success: "success",
  tip: "tip",
  todo: "success",
  warning: "danger",
}

function calloutCategory(type: string): CalloutCategory {
  return typeCategories[type] ?? "info"
}

/**
 * Identifies the shortcut-link node that Lezer emits for a callout marker.
 * The live preview uses this to keep `[!type]` out of ordinary link styling.
 */
export function isCalloutHeaderMarker(
  state: EditorState,
  from: number,
  to: number
) {
  if (!/^\[![^\]\s]+\]$/.test(state.sliceDoc(from, to))) return false
  const line = state.doc.lineAt(from)
  return /^[\t ]*(?:>[\t ]*)+$/.test(state.sliceDoc(line.from, from))
}

/** Whether a syntax blockquote owns callout-card presentation. */
export function isCalloutBlockquote(state: EditorState, node: SyntaxNode) {
  if (node.name !== "Blockquote") return false
  const line = state.doc.lineAt(node.from)
  return /^>\s*\[!([^\]\s]+)\]([+-])?(?:[\t ]+.*?)?[\t ]*$/.test(
    state.sliceDoc(node.from, line.to)
  )
}

function defaultTitle(type: string) {
  const words = type.replace(/[-_]+/g, " ").trim()
  return words.length === 0
    ? "Callout"
    : words.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase())
}

function blockquoteDepth(node: SyntaxNodeRef) {
  let depth = 1
  for (let parent = node.node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") depth += 1
  }
  return depth
}

function parseCalloutHeader(
  state: EditorState,
  node: SyntaxNodeRef,
  depth: number
): CalloutBlock | null {
  const line = state.doc.lineAt(node.from)
  const source = state.sliceDoc(node.from, line.to)
  const match = /^>\s*\[!([^\]\s]+)\]([+-])?(?:[\t ]+(.*?))?[\t ]*$/.exec(
    source
  )
  if (!match?.[1]) return null

  const markerOffset = source.indexOf("[!")
  if (markerOffset < 0) return null
  const markerSource = source.slice(markerOffset)
  const markerMatch = /^\[!([^\]\s]+)\]([+-])?/.exec(markerSource)
  if (!markerMatch) return null

  const type = match[1].toLowerCase()
  const modifier = (match[2] as CalloutFoldModifier | undefined) ?? null
  const authoredTitle = match[3]?.trim()
  const headerFrom = node.from + markerOffset
  const markerTo = markerOffset + markerMatch[0].length
  const titleOffset = authoredTitle
    ? source.indexOf(authoredTitle, markerTo)
    : -1
  const titleFrom = titleOffset >= 0 ? node.from + titleOffset : null
  const nextLineFrom = line.number < state.doc.lines ? line.to + 1 : null
  const bodyFrom =
    nextLineFrom != null && nextLineFrom < node.to ? nextLineFrom : null

  return {
    kind: "callout",
    from: node.from,
    to: node.to,
    wrapperFrom: line.from,
    depth,
    headerFrom,
    headerTo: line.to,
    headerLineFrom: line.from,
    titleFrom,
    titleTo: titleFrom == null ? null : titleFrom + authoredTitle!.length,
    bodyFrom,
    type,
    title: authoredTitle || defaultTitle(type),
    category: calloutCategory(type),
    modifier,
    foldable: modifier != null && bodyFrom != null,
    initiallyCollapsed: modifier === "-" && bodyFrom != null,
    signature: markerMatch[0],
  }
}

/**
 * Extracts ordinary and callout blockquotes from the current incremental
 * Markdown tree. Nested nodes remain separate blocks, with their physical line
 * start recorded so CodeMirror can nest their wrappers around complete lines.
 */
function analyzeMarkdownQuoteBlocksInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  tree: Tree = completeMarkdownSyntaxTree(state)
): readonly MarkdownQuoteBlock[] {
  const blocks: MarkdownQuoteBlock[] = []
  const seen = new Set<number>()

  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        if (node.name !== "Blockquote" || seen.has(node.from)) return
        seen.add(node.from)
        const depth = blockquoteDepth(node)
        const callout = parseCalloutHeader(state, node, depth)
        if (callout) {
          blocks.push(callout)
          return
        }

        blocks.push({
          kind: "quote",
          from: node.from,
          to: node.to,
          wrapperFrom: state.doc.lineAt(node.from).from,
          depth,
        })
      },
    })
  }

  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan(null)
  }

  return blocks.sort(
    (left, right) =>
      left.wrapperFrom - right.wrapperFrom ||
      left.depth - right.depth ||
      left.from - right.from
  )
}

export function analyzeMarkdownQuoteBlocks(
  state: EditorState,
  tree: Tree = completeMarkdownSyntaxTree(state)
): readonly MarkdownQuoteBlock[] {
  return analyzeMarkdownQuoteBlocksInRanges(state, null, tree)
}

/** Finds the deepest parsed callout containing a document position. */
export function calloutAtPosition(
  state: EditorState,
  position: number,
  depth?: number
): CalloutBlock | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  let deepest: CalloutBlock | null = null
  const seen = new Set<number>()

  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (node.name === "Blockquote" && !seen.has(node.from)) {
        seen.add(node.from)
        const callout = parseCalloutHeader(state, node, blockquoteDepth(node))
        if (
          callout &&
          boundedPosition >= callout.from &&
          boundedPosition <= callout.to &&
          (depth == null || callout.depth === depth) &&
          (!deepest || callout.depth > deepest.depth)
        ) {
          deepest = callout
        }
      }
      node = node.parent
    }
  }

  return deepest
}

function buildQuoteBlockIndex(blocks: readonly MarkdownQuoteBlock[]) {
  return RangeSet.of(
    blocks.map((block) =>
      new IndexedMarkdownQuoteBlock(block).range(block.wrapperFrom, block.to)
    ),
    true
  )
}

function quoteBlocksInRanges(
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  ranges: readonly DocumentRange[]
) {
  const blocks: MarkdownQuoteBlock[] = []
  const seen = new Set<IndexedMarkdownQuoteBlock>()
  for (const range of ranges) {
    index.between(range.from, range.to, (from, to, value) => {
      if (seen.has(value)) return
      seen.add(value)
      blocks.push(value.materialize(from, to))
    })
  }
  return blocks.sort(
    (left, right) =>
      left.wrapperFrom - right.wrapperFrom ||
      left.depth - right.depth ||
      left.from - right.from
  )
}

function calloutsInRanges(
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  ranges: readonly DocumentRange[]
) {
  return quoteBlocksInRanges(index, ranges).filter(
    (block): block is CalloutBlock => block.kind === "callout"
  )
}

function completeDocumentRange(state: EditorState): DocumentRange {
  return { from: 0, to: state.doc.length }
}

function rangesAroundPosition(state: EditorState, position: number) {
  return [
    {
      from: Math.max(0, position - 1),
      to: Math.min(state.doc.length, position + 1),
    },
  ]
}

function calloutAtHeaderPosition(
  state: EditorState,
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  position: number
) {
  return calloutsInRanges(index, rangesAroundPosition(state, position)).find(
    (callout) => callout.headerFrom === position
  )
}

function calloutIsCollapsed(
  callout: CalloutBlock,
  overrides: ReadonlyMap<number, CalloutFoldOverride>
) {
  return (
    overrides.get(callout.headerFrom)?.collapsed ?? callout.initiallyCollapsed
  )
}

function calloutIsFolded(
  callout: CalloutBlock,
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>
) {
  return (
    calloutIsCollapsed(callout, overrides) &&
    !transitions.has(callout.headerFrom)
  )
}

function selectionTouchesCalloutBody(
  state: EditorState,
  callout: CalloutBlock
) {
  const bodyFrom = callout.bodyFrom
  if (bodyFrom == null) return false
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= bodyFrom && range.head <= callout.to
      : range.from < callout.to && range.to > bodyFrom
  )
}

function calloutContainingSelection(
  state: EditorState,
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  selectionActive: boolean
) {
  if (!selectionActive) return null

  const position = state.selection.main.head
  let editing: CalloutBlock | null = null
  const callouts = calloutsInRanges(
    index,
    rangesAroundPosition(state, position)
  )
  for (const callout of callouts) {
    const contains = position >= callout.wrapperFrom && position <= callout.to
    if (contains && (!editing || callout.depth > editing.depth)) {
      editing = callout
    }
  }
  return editing
}

function blockIsInsideEditingCallout(
  block: MarkdownQuoteBlock,
  editing: CalloutBlock | null
) {
  return (
    editing != null &&
    block.wrapperFrom >= editing.wrapperFrom &&
    block.to <= editing.to
  )
}

function buildCalloutFoldRanges(
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride> = new Map(),
  editing: CalloutBlock | null = null,
  transitions: ReadonlyMap<number, CalloutFoldTransition> = new Map()
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = []
  const collapsedAncestors: CalloutBlock[] = []

  for (const callout of callouts) {
    if (blockIsInsideEditingCallout(callout, editing)) continue
    if (!callout.foldable || !calloutIsFolded(callout, overrides, transitions))
      continue

    while (
      collapsedAncestors.length > 0 &&
      collapsedAncestors.at(-1)!.to <= callout.wrapperFrom
    ) {
      collapsedAncestors.pop()
    }
    if (
      collapsedAncestors.some(
        (ancestor) =>
          ancestor.wrapperFrom <= callout.wrapperFrom &&
          ancestor.to >= callout.to
      )
    ) {
      continue
    }

    if (callout.bodyFrom != null) {
      ranges.push(
        Decoration.replace({
          inclusive: false,
          markdownPreviewKind: "callout-fold",
        }).range(callout.bodyFrom - 1, callout.to)
      )
      collapsedAncestors.push(callout)
    }
  }

  return ranges
}

export function buildCalloutFoldDecorations(
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride> = new Map(),
  editing: CalloutBlock | null = null,
  transitions: ReadonlyMap<number, CalloutFoldTransition> = new Map()
): DecorationSet {
  const ranges = buildCalloutFoldRanges(
    callouts,
    overrides,
    editing,
    transitions
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function buildCalloutTransitionAtomicRangeValues(
  callouts: readonly CalloutBlock[],
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null
) {
  const ranges: Range<Decoration>[] = []
  for (const callout of callouts) {
    if (blockIsInsideEditingCallout(callout, editing)) continue
    if (callout.bodyFrom == null || !transitions.has(callout.headerFrom))
      continue
    ranges.push(
      Decoration.replace({
        inclusive: false,
        markdownPreviewKind: "callout-transition-atomic",
      }).range(callout.bodyFrom - 1, callout.to)
    )
  }
  return ranges
}

function buildCalloutTransitionAtomicRanges(
  callouts: readonly CalloutBlock[],
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null
) {
  const ranges = buildCalloutTransitionAtomicRangeValues(
    callouts,
    transitions,
    editing
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function buildQuoteBlockWrapperRanges(
  blocks: readonly MarkdownQuoteBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride> = new Map(),
  editing: CalloutBlock | null = null,
  transitions: ReadonlyMap<number, CalloutFoldTransition> = new Map()
) {
  const ranges: Range<BlockWrapper>[] = []
  const collapsedAncestors: CalloutBlock[] = []

  for (const block of blocks) {
    while (
      collapsedAncestors.length > 0 &&
      collapsedAncestors.at(-1)!.to <= block.wrapperFrom
    ) {
      collapsedAncestors.pop()
    }
    if (
      collapsedAncestors.some(
        (ancestor) =>
          ancestor.bodyFrom != null &&
          block.wrapperFrom >= ancestor.bodyFrom &&
          block.to <= ancestor.to
      )
    ) {
      continue
    }

    if (blockIsInsideEditingCallout(block, editing)) continue

    if (block.kind === "quote") {
      ranges.push(
        BlockWrapper.create({
          tagName: "blockquote",
          attributes: {
            class: "cm-md-quote-block",
            "data-quote-depth": String(block.depth),
          },
          rank: Math.max(0, 50 - block.depth),
        }).range(block.wrapperFrom, block.to)
      )
      continue
    }

    const folded = calloutIsFolded(block, overrides, transitions)
    const calloutRank = Math.max(0, 50 - block.depth)
    const className = [
      "cm-md-callout",
      `cm-md-callout-${block.category}`,
      `cm-md-callout-palette-${categoryPalettes[block.category]}`,
    ]
      .filter(Boolean)
      .join(" ")

    if (block.depth > 1) {
      ranges.push(
        BlockWrapper.create({
          tagName: "div",
          attributes: {
            class: "cm-md-callout-gap",
            "data-callout-gap-depth": String(block.depth),
          },
          // Keep this outside its card but inside the enclosing depth. Unlike
          // margins, wrapper padding participates in CodeMirror's measured
          // block geometry and cannot desynchronize its height map.
          rank: calloutRank + 0.5,
        }).range(block.wrapperFrom, block.to)
      )
    }

    ranges.push(
      BlockWrapper.create({
        tagName: "div",
        attributes: {
          class: className,
          "data-callout-from": String(block.wrapperFrom),
          "data-callout-to": String(block.to),
          "data-callout-type": block.type,
          "data-callout-depth": String(block.depth),
          "data-callout-palette": categoryPalettes[block.category],
          role: "note",
          "aria-label": `${block.title} callout`,
        },
        rank: calloutRank,
      }).range(block.wrapperFrom, block.to)
    )
    if (block.bodyFrom != null && !folded) {
      ranges.push(
        BlockWrapper.create({
          tagName: "div",
          attributes: {
            class: "cm-md-callout-body",
            "data-callout-body-from": String(block.headerFrom),
          },
          rank: Math.max(0, calloutRank - 0.25),
        }).range(block.bodyFrom, block.to)
      )
    }
    if (folded && block.bodyFrom != null) collapsedAncestors.push(block)
  }

  return ranges
}

export function buildQuoteBlockWrappers(
  blocks: readonly MarkdownQuoteBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride> = new Map(),
  editing: CalloutBlock | null = null,
  transitions: ReadonlyMap<number, CalloutFoldTransition> = new Map()
) {
  return BlockWrapper.set(
    buildQuoteBlockWrapperRanges(blocks, overrides, editing, transitions),
    true
  )
}

function remapOverrides(
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transaction: Transaction
) {
  if (transaction.changes.empty) return new Map(overrides)
  const mapped = new Map<number, CalloutFoldOverride>()
  for (const [from, value] of overrides) {
    let anchorDeleted = false
    transaction.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= from && from < toA) anchorDeleted = true
    })
    if (anchorDeleted) continue
    mapped.set(transaction.changes.mapPos(from, 1), value)
  }
  return mapped
}

function updateOverrides(
  previous: ReadonlyMap<number, CalloutFoldOverride>,
  blockIndex: RangeSet<IndexedMarkdownQuoteBlock>,
  transaction: Transaction
) {
  const overrides = remapOverrides(previous, transaction)
  for (const effect of transaction.effects) {
    if (
      effect.is(setCalloutCollapsed) ||
      effect.is(beginCalloutFoldTransition)
    ) {
      overrides.set(effect.value.from, {
        collapsed: effect.value.collapsed,
        signature: effect.value.signature,
      })
    }
  }

  for (const [from, value] of overrides) {
    if (
      calloutAtHeaderPosition(transaction.state, blockIndex, from)
        ?.signature !== value.signature
    ) {
      overrides.delete(from)
    }
  }
  return overrides
}

function remapTransitions(
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  transaction: Transaction
) {
  if (transaction.changes.empty) return new Map(transitions)
  const mapped = new Map<number, CalloutFoldTransition>()
  for (const [from, transition] of transitions) {
    let anchorDeleted = false
    transaction.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= from && from < toA) anchorDeleted = true
    })
    if (anchorDeleted) continue
    const mappedFrom = transaction.changes.mapPos(from, 1)
    mapped.set(mappedFrom, { ...transition, from: mappedFrom })
  }
  return mapped
}

function updateTransitions(
  previous: ReadonlyMap<number, CalloutFoldTransition>,
  blockIndex: RangeSet<IndexedMarkdownQuoteBlock>,
  editing: CalloutBlock | null,
  transaction: Transaction
) {
  const transitions = remapTransitions(previous, transaction)
  for (const effect of transaction.effects) {
    if (effect.is(setCalloutCollapsed)) {
      transitions.delete(effect.value.from)
    } else if (effect.is(beginCalloutFoldTransition)) {
      transitions.set(effect.value.from, effect.value)
    } else if (effect.is(finishCalloutFoldTransition)) {
      const current = transitions.get(effect.value.from)
      if (
        current?.token === effect.value.token &&
        current.signature === effect.value.signature
      ) {
        transitions.delete(effect.value.from)
      }
    }
  }

  for (const [from, transition] of transitions) {
    const callout = calloutAtHeaderPosition(transaction.state, blockIndex, from)
    if (
      callout?.signature !== transition.signature ||
      (callout && blockIsInsideEditingCallout(callout, editing))
    ) {
      transitions.delete(from)
    }
  }
  return transitions
}

function mergeDocumentRanges(ranges: readonly DocumentRange[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: DocumentRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.from > previous.to + 1) {
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
      if (node.node.parent?.parent != null) return
      if (node.node.parent == null) return
      from = Math.min(from, node.from)
      to = Math.max(to, node.to)
      return false
    },
  })
  return { from, to }
}

/**
 * Blockquote syntax can extend beyond the edited line. Refresh the complete
 * top-level syntax nodes touched in either document while retaining all
 * unrelated indexed subtrees.
 */
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

const quotePairingBlockNodes = new Set([
  "Blockquote",
  "BulletList",
  "CodeBlock",
  "CommentBlock",
  "FencedCode",
  "HTMLBlock",
  "HorizontalRule",
  "LinkReference",
  "ListItem",
  "OrderedList",
  "Paragraph",
  "ProcessingInstructionBlock",
  "Table",
])

function quotePairingBlockStructure(
  state: EditorState,
  tree: Tree,
  line: Line
) {
  const nodes: string[] = []
  const scanTo = Math.min(state.doc.length, Math.max(line.to, line.from + 1))
  tree.iterate({
    from: line.from,
    to: scanTo,
    enter(node) {
      if (
        !quotePairingBlockNodes.has(node.name) &&
        !/^(?:ATX|Setext)Heading[1-6]$/.test(node.name) &&
        !/(?:^|_)(?:DisplayMath|MathBlock)$/.test(node.name)
      ) {
        return
      }
      const starts =
        node.from < line.from ? "before" : node.from === line.from ? "at" : "in"
      const ends =
        node.to > line.to ? "after" : node.to === line.to ? "at" : "in"
      nodes.push(`${node.name}:${starts}:${ends}`)
    },
  })
  return nodes.join(",")
}

function quotePairingLineSignatures(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number
) {
  const clampedFrom = Math.max(0, Math.min(state.doc.length, from))
  const clampedTo = Math.max(clampedFrom, Math.min(state.doc.length, to))
  const first = state.doc.lineAt(clampedFrom)
  const touchedLast = state.doc.lineAt(
    clampedTo > clampedFrom ? clampedTo - 1 : clampedTo
  )
  // Joining or splitting a newline can leave the changed range attributed to
  // the preceding line even though the following line is the one whose quote
  // adjacency changed. Include that immediate neighbor so lazy blockquote
  // groups cannot retain a stale distant pairing after a line-boundary edit.
  const last = state.doc.line(Math.min(state.doc.lines, touchedLast.number + 1))
  const signatures: string[] = []
  for (let number = first.number; number <= last.number; number += 1) {
    const line = state.doc.line(number)
    const text = line.text
    const container = markdownContainerPrefix(text, state.tabSize)
    const contentKind = text.slice(container.length).trim()
      ? "content"
      : "blank"
    const containerSignature =
      container.quoteDepth > 0
        ? `${container.quoteDepth}:${text.slice(0, container.length)}`
        : "none"
    signatures.push(
      `${containerSignature}:${contentKind}:${quotePairingBlockStructure(
        state,
        tree,
        line
      )}`
    )
  }
  return signatures
}

/**
 * CommonMark containers, blank quote content, and block-start classes can all
 * split or join lazy-continuation groups beyond the top-level nodes touching an
 * edit. Compare only the changed line neighborhood's structural signatures so
 * ordinary typing inside an unchanged block remains locally incremental.
 */
function quoteBlockPairingMayChange(
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  let changed = false
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (changed) return
    const before = quotePairingLineSignatures(
      transaction.startState,
      previousTree,
      fromA,
      toA
    )
    const after = quotePairingLineSignatures(
      transaction.state,
      nextTree,
      fromB,
      toB
    )
    changed =
      before.length !== after.length ||
      before.some((signature, index) => signature !== after[index])
  })
  return changed
}

function removeRanges<T extends RangeValue>(
  set: RangeSet<T>,
  ranges: readonly DocumentRange[],
  removePointRanges = false,
  documentLength = -1
) {
  let updated = set
  for (const range of ranges) {
    updated = updated.update({
      // RangeSet filtering includes boundary-only contact. The syntax refresh
      // region is half-open, so retain an adjacent block ending at `from` or
      // beginning at `to`.
      filter: (from, to) => {
        if (
          removePointRanges &&
          from === to &&
          (rangeContainsPoint(range, from) ||
            (from === documentLength && range.to === documentLength))
        ) {
          return false
        }
        return to <= range.from || from >= range.to
      },
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function discardEmptyRangesInWindows<T extends RangeValue>(
  set: RangeSet<T>,
  ranges: readonly DocumentRange[]
) {
  let updated = set
  for (const range of ranges) {
    updated = updated.update({
      // Filtering deliberately includes both window boundaries: a source range
      // deleted in full may map to either edge, and structural sets never own
      // legitimate points.
      filter: (from, to) => from < to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function refreshRangeSet<T extends RangeValue>(
  previous: RangeSet<T>,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  additions: readonly Range<T>[],
  discardEmptyRanges = false,
  refreshPointRanges = false
) {
  const mapped = previous.map(transaction.changes)
  // Structural ranges can collapse to points when all of their source is
  // deleted. Clear those points only inside the bounded region already being
  // rebuilt, so RangeSet can retain untouched chunks elsewhere in the document.
  // Header decorations deliberately contain real point ranges and request the
  // same bounded refresh without treating distant points as stale.
  const normalized = discardEmptyRanges
    ? discardEmptyRangesInWindows(mapped, ranges)
    : mapped
  const retained = removeRanges(
    normalized,
    ranges,
    refreshPointRanges,
    transaction.state.doc.length
  )
  return additions.length > 0
    ? retained.update({ add: additions, sort: true })
    : retained
}

function refreshQuoteBlockIndex(
  previous: RangeSet<IndexedMarkdownQuoteBlock>,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  freshBlocks: readonly MarkdownQuoteBlock[]
) {
  const mapped = previous.map(transaction.changes)
  // A block deleted in full maps to a zero-width range. Remove it within the
  // syntax region being rebuilt without filtering the entire document index.
  const normalized = discardEmptyRangesInWindows(mapped, ranges)
  const retained = removeRanges(normalized, ranges)
  const additions = freshBlocks.map((block) =>
    new IndexedMarkdownQuoteBlock(block).range(block.wrapperFrom, block.to)
  )
  return additions.length > 0
    ? retained.update({ add: additions, sort: true })
    : retained
}

function rangeContainsPoint(range: DocumentRange, point: number) {
  return range.from === range.to
    ? point === range.from
    : point >= range.from && point < range.to
}

function rangesOverlap(left: DocumentRange, right: DocumentRange) {
  if (left.from === left.to) return rangeContainsPoint(right, left.from)
  if (right.from === right.to) return rangeContainsPoint(left, right.from)
  return left.from < right.to && right.from < left.to
}

function calloutHeaderPresentationRange(callout: CalloutBlock): DocumentRange {
  return {
    from:
      callout.depth > 1 && callout.wrapperFrom > 0
        ? callout.wrapperFrom - 1
        : callout.headerLineFrom,
    to: callout.headerTo,
  }
}

function calloutsWithHeadersInRanges(
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  ranges: readonly DocumentRange[]
) {
  return calloutsInRanges(index, ranges).filter((callout) => {
    const header = calloutHeaderPresentationRange(callout)
    return ranges.some((range) => rangesOverlap(header, range))
  })
}

function selectionTouchesHeaderRange(
  callout: CalloutBlock,
  range: { readonly from: number; readonly to: number; readonly empty: boolean }
) {
  return range.empty
    ? range.from >= callout.headerFrom && range.from <= callout.headerTo
    : range.from < callout.headerTo && range.to > callout.headerFrom
}

function calloutsTouchedBySelection(
  state: EditorState,
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  ranges: readonly {
    readonly from: number
    readonly to: number
    readonly empty: boolean
  }[]
) {
  const documentRanges = ranges.map((range) =>
    range.empty
      ? rangesAroundPosition(state, range.from)[0]!
      : { from: range.from, to: range.to }
  )
  return calloutsInRanges(index, documentRanges).filter((callout) =>
    ranges.some((range) => selectionTouchesHeaderRange(callout, range))
  )
}

function selectionHeaderRefreshRanges(
  transaction: Transaction,
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  previousSelection: EditorSelection,
  previousSelectionActive: boolean,
  nextSelectionActive: boolean
) {
  const touched: CalloutBlock[] = []
  if (previousSelectionActive) {
    const mappedPrevious = previousSelection.ranges.map((range) => {
      const from = transaction.changes.mapPos(range.from, -1)
      const to = transaction.changes.mapPos(range.to, 1)
      return { from, to, empty: from === to }
    })
    touched.push(
      ...calloutsTouchedBySelection(transaction.state, index, mappedPrevious)
    )
  }
  if (nextSelectionActive) {
    touched.push(
      ...calloutsTouchedBySelection(
        transaction.state,
        index,
        transaction.state.selection.ranges
      )
    )
  }
  return mergeDocumentRanges(touched.map(calloutHeaderPresentationRange))
}

function wordCharactersAtSelection(state: EditorState) {
  return (
    state.languageDataAt<string>("wordChars", state.selection.main.head)[0] ??
    ""
  )
}

function searchMatchHeaderRefreshRanges(
  transaction: Transaction,
  previous: ReturnType<typeof currentSearchMatch>,
  next: ReturnType<typeof currentSearchMatch>
) {
  const ranges: DocumentRange[] = []
  if (previous) {
    const from = transaction.changes.mapPos(previous.from, -1)
    const to = transaction.changes.mapPos(previous.to, 1)
    ranges.push(
      from === to
        ? rangesAroundPosition(transaction.state, from)[0]!
        : { from, to }
    )
  }
  if (next) {
    ranges.push(
      next.from === next.to
        ? rangesAroundPosition(transaction.state, next.from)[0]!
        : next
    )
  }
  return mergeDocumentRanges(ranges)
}

function editingPresentationMatches(
  previous: CalloutBlock | null,
  next: CalloutBlock | null,
  transaction: Transaction
) {
  if (!previous || !next) return previous == null && next == null
  return (
    transaction.changes.mapPos(previous.wrapperFrom, -1) === next.wrapperFrom &&
    previous.depth === next.depth
  )
}

function editingRefreshRanges(
  previous: CalloutBlock | null,
  next: CalloutBlock | null,
  transaction: Transaction,
  tree: Tree
) {
  if (editingPresentationMatches(previous, next, transaction)) return []
  const ranges: DocumentRange[] = []
  if (previous) {
    ranges.push(
      expandToTopLevelSyntax(
        transaction.state,
        {
          from: transaction.changes.mapPos(previous.wrapperFrom, -1),
          to: transaction.changes.mapPos(previous.to, 1),
        },
        tree
      )
    )
  }
  if (next) {
    ranges.push(
      expandToTopLevelSyntax(
        transaction.state,
        { from: next.wrapperFrom, to: next.to },
        tree
      )
    )
  }
  return mergeDocumentRanges(ranges)
}

function activeTransitionRefreshRanges(
  state: EditorState,
  index: RangeSet<IndexedMarkdownQuoteBlock>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  tree: Tree
) {
  const ranges: DocumentRange[] = []
  for (const from of transitions.keys()) {
    const callout = calloutAtHeaderPosition(state, index, from)
    if (!callout) continue
    ranges.push(
      expandToTopLevelSyntax(
        state,
        { from: callout.wrapperFrom, to: callout.to },
        tree
      )
    )
  }
  return mergeDocumentRanges(ranges)
}

function refreshCalloutStructure(
  value: CalloutBlockState,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  blocks: readonly MarkdownQuoteBlock[],
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null
) {
  return {
    folds: refreshRangeSet(
      value.folds,
      transaction,
      ranges,
      buildCalloutFoldRanges(callouts, overrides, editing, transitions),
      true
    ),
    transitionAtomicRanges: refreshRangeSet(
      value.transitionAtomicRanges,
      transaction,
      ranges,
      buildCalloutTransitionAtomicRangeValues(callouts, transitions, editing),
      true
    ),
    wrappers: refreshRangeSet(
      value.wrappers,
      transaction,
      ranges,
      buildQuoteBlockWrapperRanges(blocks, overrides, editing, transitions),
      true
    ),
  }
}

function refreshCalloutHeaders(
  previous: DecorationSet,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  state: EditorState,
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null,
  selectionActive: boolean,
  field: StateField<CalloutBlockState>
) {
  // Rebuilding a header adds its replacement, line decoration, and possible
  // nested-gap point as one unit. Remove that same complete presentation first
  // so a narrow search/selection refresh cannot retain one point while adding
  // another copy of it.
  const presentationRanges = mergeDocumentRanges([
    ...ranges,
    ...callouts.map(calloutHeaderPresentationRange),
  ])
  return refreshRangeSet(
    previous,
    transaction,
    presentationRanges,
    buildHeaderDecorationRanges(
      state,
      callouts,
      overrides,
      transitions,
      editing,
      selectionActive,
      field
    ),
    false,
    true
  )
}

function createCalloutBlockState(
  state: EditorState,
  overrides: ReadonlyMap<number, CalloutFoldOverride> = new Map(),
  selectionActive = false,
  tree: Tree = completeMarkdownSyntaxTree(state),
  field?: StateField<CalloutBlockState>
): CalloutBlockState {
  const blocks = analyzeMarkdownQuoteBlocks(state, tree)
  const blockIndex = buildQuoteBlockIndex(blocks)
  const callouts = blocks.filter(
    (block): block is CalloutBlock => block.kind === "callout"
  )
  const editing = calloutContainingSelection(state, blockIndex, selectionActive)
  const transitions = new Map<number, CalloutFoldTransition>()
  return {
    blockIndex,
    editing,
    overrides,
    presentedSelection: state.selection,
    presentedSelectionActive: selectionActive,
    presentedWordCharacters: wordCharactersAtSelection(state),
    transitions,
    folds: buildCalloutFoldDecorations(callouts, overrides, editing),
    headers: buildHeaderDecorations(
      state,
      callouts,
      overrides,
      transitions,
      editing,
      selectionActive,
      field
    ),
    transitionAtomicRanges: Decoration.none,
    tree,
    wrappers: buildQuoteBlockWrappers(blocks, overrides, editing),
  }
}

function calloutMotionIsReduced(view: EditorView) {
  return (
    view.dom.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches ?? false
  )
}

class CalloutHeaderWidget extends WidgetType {
  readonly callout: CalloutBlock
  readonly collapsed: boolean
  readonly field: StateField<CalloutBlockState> | undefined
  readonly titleMatches: readonly CalloutTitleMatch[]

  constructor(
    callout: CalloutBlock,
    collapsed: boolean,
    titleMatches: readonly CalloutTitleMatch[],
    field?: StateField<CalloutBlockState>
  ) {
    super()
    this.callout = callout
    this.collapsed = collapsed
    this.titleMatches = titleMatches
    this.field = field
  }

  eq(other: CalloutHeaderWidget) {
    return (
      this.callout.headerFrom === other.callout.headerFrom &&
      this.callout.signature === other.callout.signature &&
      this.callout.title === other.callout.title &&
      this.callout.category === other.callout.category &&
      this.callout.foldable === other.callout.foldable &&
      this.collapsed === other.collapsed &&
      titleMatchesEqual(this.titleMatches, other.titleMatches)
    )
  }

  updateDOM(dom: HTMLElement, _view: EditorView, previous: this) {
    if (
      this.callout.headerFrom !== previous.callout.headerFrom ||
      this.callout.signature !== previous.callout.signature ||
      this.callout.title !== previous.callout.title ||
      this.callout.category !== previous.callout.category ||
      this.callout.foldable !== previous.callout.foldable
    ) {
      return false
    }
    const title = dom.querySelector<HTMLElement>(".cm-md-callout-title")
    if (!title) return false
    this.renderTitle(title)
    this.updateDisclosure(dom)
    return true
  }

  toDOM(view: EditorView) {
    const document = view.dom.ownerDocument
    const header = this.callout.foldable
      ? document.createElement("button")
      : document.createElement("span")
    header.className = "cm-md-callout-header"

    if (header instanceof HTMLButtonElement) {
      header.classList.add("cm-md-callout-toggle")
      header.type = "button"
      header.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const callout = this.currentCallout(view, header)
        const expanded = header.getAttribute("aria-expanded") === "true"
        const value = {
          from: callout.headerFrom,
          signature: callout.signature,
          collapsed: expanded,
        }
        view.dispatch({
          selection:
            expanded && selectionTouchesCalloutBody(view.state, callout)
              ? { anchor: callout.headerFrom }
              : undefined,
          effects: calloutMotionIsReduced(view)
            ? setCalloutCollapsed.of(value)
            : beginCalloutFoldTransition.of({
                ...value,
                token: calloutFoldTransitionToken(),
              }),
        })
      })
    } else {
      header.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const callout = this.currentCallout(view, header)
        view.focus()
        view.dispatch({
          selection: { anchor: callout.headerFrom },
          scrollIntoView: true,
        })
      })
    }

    const title = document.createElement("span")
    title.className = "cm-md-callout-title"
    this.renderTitle(title)
    header.append(title)

    if (this.callout.foldable) {
      const chevron = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg"
      )
      chevron.setAttribute("class", "cm-md-callout-chevron")
      chevron.setAttribute("viewBox", "0 0 24 24")
      chevron.setAttribute("fill", "none")
      chevron.setAttribute("stroke", "currentColor")
      chevron.setAttribute("stroke-width", "2")
      chevron.setAttribute("stroke-linecap", "round")
      chevron.setAttribute("stroke-linejoin", "round")
      chevron.setAttribute("aria-hidden", "true")
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      )
      path.setAttribute("d", "m6 9 6 6 6-6")
      chevron.append(path)
      header.append(chevron)
    }

    this.updateDisclosure(header)
    return header
  }

  private currentCallout(view: EditorView, dom: HTMLElement) {
    if (!this.field) return this.callout
    let position: number
    try {
      position = view.posAtDOM(dom)
    } catch {
      return this.callout
    }
    const callouts = calloutsInRanges(
      view.state.field(this.field).blockIndex,
      rangesAroundPosition(view.state, position)
    )
    return (
      callouts.find(
        (callout) =>
          position >= callout.headerFrom && position <= callout.headerTo
      ) ?? this.callout
    )
  }

  private updateDisclosure(dom: HTMLElement) {
    const button = dom.matches(".cm-md-callout-toggle")
      ? (dom as HTMLButtonElement)
      : dom.querySelector<HTMLButtonElement>(".cm-md-callout-toggle")
    if (!button) return
    const expanded = !this.collapsed
    button.setAttribute("aria-expanded", String(expanded))
    button.setAttribute(
      "aria-label",
      `${expanded ? "Collapse" : "Expand"} ${this.callout.title} callout`
    )
    button.classList.toggle("cm-md-callout-toggle-collapsed", this.collapsed)
  }

  private renderTitle(title: HTMLElement) {
    const document = title.ownerDocument
    const fragments: Node[] = []
    let offset = 0
    for (const match of this.titleMatches) {
      if (match.from > offset) {
        fragments.push(
          document.createTextNode(this.callout.title.slice(offset, match.from))
        )
      }
      const highlighted = document.createElement("span")
      highlighted.className = match.selected
        ? "cm-searchMatch cm-searchMatch-selected"
        : "cm-searchMatch"
      highlighted.textContent = this.callout.title.slice(match.from, match.to)
      fragments.push(highlighted)
      offset = match.to
    }
    if (offset < this.callout.title.length) {
      fragments.push(document.createTextNode(this.callout.title.slice(offset)))
    }
    title.replaceChildren(...fragments)
  }
}

class CalloutNestedGapWidget extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof CalloutNestedGapWidget
  }

  toDOM(view: EditorView) {
    const gap = view.dom.ownerDocument.createElement("div")
    gap.className = "cm-md-callout-nested-gap"
    gap.setAttribute("aria-hidden", "true")
    return gap
  }
}

interface CalloutTitleMatch {
  readonly from: number
  readonly selected: boolean
  readonly to: number
}

function titleMatchesEqual(
  left: readonly CalloutTitleMatch[],
  right: readonly CalloutTitleMatch[]
) {
  return (
    left.length === right.length &&
    left.every(
      (match, index) =>
        match.from === right[index]!.from &&
        match.to === right[index]!.to &&
        match.selected === right[index]!.selected
    )
  )
}

function calloutTitleMatches(state: EditorState, callout: CalloutBlock) {
  const { titleFrom, titleTo } = callout
  const query = editorSearchQuery(state)
  if (
    titleFrom == null ||
    titleTo == null ||
    !query?.valid ||
    editorSearchIssue(state) === "multiline-regexp-complexity-limit" ||
    !contextPreservingRegexpSearchSupported(state, query)
  ) {
    return []
  }

  const current = currentSearchMatch(state)
  const matches: CalloutTitleMatch[] = []
  const cursor = searchCursorForRange(state, query, callout.headerFrom, titleTo)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value
    if (from >= titleTo) break
    if (from === to || from < titleFrom || to > titleTo) continue
    matches.push({
      from: from - titleFrom,
      to: to - titleFrom,
      selected: current?.from === from && current.to === to,
    })
  }
  return matches
}

function selectionTouchesHeader(state: EditorState, callout: CalloutBlock) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= callout.headerFrom && range.head <= callout.headerTo
      : range.from < callout.headerTo && range.to > callout.headerFrom
  )
}

function buildHeaderDecorationRanges(
  state: EditorState,
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null,
  selectionActive: boolean,
  field?: StateField<CalloutBlockState>
) {
  const ranges: Range<Decoration>[] = []
  const calloutsByWrapperFrom = new Map(
    callouts.map((callout) => [callout.wrapperFrom, callout] as const)
  )
  for (const callout of callouts) {
    if (blockIsInsideEditingCallout(callout, editing)) continue
    if (callout.depth > 1 && callout.wrapperFrom > 0) {
      // Keep the inter-card gap outside the nested card while making it a
      // complete state-backed block. A BlockWrapper may be split at viewport
      // boundaries, so leading padding on that wrapper would be repeated each
      // time a new fragment mounts and would move the document while scrolling.
      ranges.push(
        Decoration.widget({
          block: true,
          side: 1,
          widget: new CalloutNestedGapWidget(),
        }).range(callout.wrapperFrom - 1)
      )
    }
    const firstBodyCallout =
      callout.bodyFrom == null
        ? null
        : calloutsByWrapperFrom.get(callout.bodyFrom)
    const bodyStartsWithNestedCallout =
      firstBodyCallout != null &&
      firstBodyCallout.depth > callout.depth &&
      firstBodyCallout.to <= callout.to
    const headerOwnsBodyGap =
      callout.bodyFrom != null &&
      !calloutIsFolded(callout, overrides, transitions) &&
      !bodyStartsWithNestedCallout
    ranges.push(
      Decoration.line({
        class: [
          "cm-md-callout-header-line",
          headerOwnsBodyGap && "cm-md-callout-header-body-gap",
        ]
          .filter(Boolean)
          .join(" "),
      }).range(callout.headerLineFrom)
    )
    if (selectionActive && selectionTouchesHeader(state, callout)) {
      continue
    }

    ranges.push(
      Decoration.replace({
        widget: new CalloutHeaderWidget(
          callout,
          calloutIsCollapsed(callout, overrides),
          calloutTitleMatches(state, callout),
          field
        ),
        markdownPreviewKind: "callout-header",
      }).range(callout.headerFrom, callout.headerTo)
    )
  }
  return ranges
}

function buildHeaderDecorations(
  state: EditorState,
  callouts: readonly CalloutBlock[],
  overrides: ReadonlyMap<number, CalloutFoldOverride>,
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  editing: CalloutBlock | null,
  selectionActive: boolean,
  field?: StateField<CalloutBlockState>
) {
  const ranges = buildHeaderDecorationRanges(
    state,
    callouts,
    overrides,
    transitions,
    editing,
    selectionActive,
    field
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

const calloutFoldAnimationDuration = 150

interface CalloutBodySnapshot {
  readonly height: number
  readonly opacity: number
}

interface ActiveCalloutFoldAnimation {
  readonly animation: Animation
  readonly element: HTMLElement
  from: number
  readonly previousOverflow: string
  readonly previousWillChange: string
  readonly token: number
}

function calloutTransitionWithToken(
  transitions: ReadonlyMap<number, CalloutFoldTransition>,
  token: number
) {
  for (const [from, transition] of transitions) {
    if (transition.token === token) return { from, transition }
  }
  return null
}

class CalloutFoldAnimationPlugin {
  private readonly active = new Map<number, ActiveCalloutFoldAnimation>()
  private destroyed = false
  private readonly field: StateField<CalloutBlockState>
  private readonly finishQueued = new Set<number>()
  private measureFrame: number | null = null
  private readonly ownerWindow: Window
  private readonly pendingSnapshots = new Map<number, CalloutBodySnapshot>()
  private syncFrame: number | null = null
  private readonly view: EditorView

  constructor(view: EditorView, field: StateField<CalloutBlockState>) {
    this.view = view
    this.field = field
    const ownerWindow = view.dom.ownerDocument.defaultView
    if (!ownerWindow) throw new Error("Callout animations require a window")
    this.ownerWindow = ownerWindow
  }

  update(update: ViewUpdate) {
    const previous = update.startState.field(this.field)
    const next = update.state.field(this.field)

    for (const [previousFrom, previousTransition] of previous.transitions) {
      const mappedFrom = update.changes.mapPos(previousFrom, 1)
      const nextTransition = next.transitions.get(mappedFrom)
      if (
        nextTransition &&
        nextTransition.token !== previousTransition.token &&
        !this.pendingSnapshots.has(nextTransition.token)
      ) {
        const element = this.bodyElement(previousFrom)
        if (element) {
          this.pendingSnapshots.set(
            nextTransition.token,
            this.readSnapshot(element)
          )
        }
      }
    }

    for (const active of [...this.active.values()]) {
      const mappedFrom = update.changes.mapPos(active.from, 1)
      const current = next.transitions.get(mappedFrom)
      if (current?.token === active.token) {
        active.from = mappedFrom
        if (update.docChanged) {
          this.pendingSnapshots.set(
            active.token,
            this.readSnapshot(active.element)
          )
        }
        continue
      }

      const snapshot = this.readSnapshot(active.element)
      this.cancel(active)
      if (current) this.pendingSnapshots.set(current.token, snapshot)
    }

    const currentTokens = new Set(
      [...next.transitions.values()].map(({ token }) => token)
    )
    for (const token of this.pendingSnapshots.keys()) {
      if (!currentTokens.has(token)) this.pendingSnapshots.delete(token)
    }

    if (
      previous.transitions !== next.transitions ||
      update.docChanged ||
      update.viewportChanged
    ) {
      this.scheduleSync()
    }
  }

  docViewUpdate() {
    this.cancelSyncFrame()
    this.sync()
  }

  destroy() {
    this.destroyed = true
    this.cancelSyncFrame()
    if (this.measureFrame != null) {
      this.ownerWindow.cancelAnimationFrame(this.measureFrame)
      this.measureFrame = null
    }
    for (const active of [...this.active.values()]) this.cancel(active)
    this.pendingSnapshots.clear()
    this.finishQueued.clear()
  }

  private bodyElement(from: number) {
    return this.view.contentDOM.querySelector<HTMLElement>(
      `.cm-md-callout-body[data-callout-body-from="${from}"]`
    )
  }

  private readSnapshot(element: HTMLElement): CalloutBodySnapshot {
    const opacity = Number.parseFloat(
      this.ownerWindow.getComputedStyle(element).opacity
    )
    return {
      height: element.getBoundingClientRect().height,
      opacity: Number.isFinite(opacity) ? opacity : 1,
    }
  }

  private scheduleSync() {
    if (this.destroyed || this.syncFrame != null) return
    this.syncFrame = this.ownerWindow.requestAnimationFrame(() => {
      this.syncFrame = null
      this.sync()
    })
  }

  private cancelSyncFrame() {
    if (this.syncFrame == null) return
    this.ownerWindow.cancelAnimationFrame(this.syncFrame)
    this.syncFrame = null
  }

  private sync() {
    if (this.destroyed) return
    const transitions = this.view.state.field(this.field).transitions
    const currentTokens = new Set(
      [...transitions.values()].map(({ token }) => token)
    )

    for (const active of [...this.active.values()]) {
      if (!currentTokens.has(active.token)) this.cancel(active)
    }

    for (const [from, transition] of transitions) {
      const element = this.bodyElement(from)
      const active = this.active.get(transition.token)
      if (active?.element === element) {
        active.from = from
        continue
      }

      if (active) {
        if (!this.pendingSnapshots.has(transition.token)) {
          this.pendingSnapshots.set(
            transition.token,
            this.readSnapshot(active.element)
          )
        }
        this.cancel(active)
      }

      if (!element) {
        this.queueFinish(transition.token)
        continue
      }
      this.start(from, transition, element)
    }
  }

  private start(
    from: number,
    transition: CalloutFoldTransition,
    element: HTMLElement
  ) {
    if (
      calloutMotionIsReduced(this.view) ||
      typeof element.animate !== "function"
    ) {
      this.queueFinish(transition.token)
      return
    }

    const pending = this.pendingSnapshots.get(transition.token)
    this.pendingSnapshots.delete(transition.token)
    const naturalHeight = element.scrollHeight
    const current = pending ?? this.readSnapshot(element)
    const startHeight = pending
      ? Math.max(0, Math.min(current.height, naturalHeight))
      : transition.collapsed
        ? current.height
        : 0
    const startOpacity = pending
      ? current.opacity
      : transition.collapsed
        ? current.opacity
        : 0
    const endHeight = transition.collapsed ? 0 : naturalHeight
    const endOpacity = transition.collapsed ? 0 : 1

    if (
      naturalHeight <= 0 ||
      (Math.abs(startHeight - endHeight) < 0.5 &&
        Math.abs(startOpacity - endOpacity) < 0.01)
    ) {
      this.queueFinish(transition.token)
      return
    }

    if (transition.collapsed) {
      element.setAttribute("aria-hidden", "true")
      element.setAttribute("inert", "")
    } else {
      element.removeAttribute("aria-hidden")
      element.removeAttribute("inert")
    }

    const previousOverflow = element.style.overflow
    const previousWillChange = element.style.willChange
    element.style.overflow = "clip"
    element.style.willChange = "height, opacity"
    const animation = element.animate(
      [
        { height: `${startHeight}px`, opacity: startOpacity },
        { height: `${endHeight}px`, opacity: endOpacity },
      ],
      {
        duration: calloutFoldAnimationDuration,
        easing: "ease-out",
        fill: "forwards",
      }
    )
    const active: ActiveCalloutFoldAnimation = {
      animation,
      element,
      from,
      previousOverflow,
      previousWillChange,
      token: transition.token,
    }
    this.active.set(transition.token, active)
    this.ensureMeasureLoop()
    void animation.finished.then(
      () => this.finish(transition.token),
      () => undefined
    )
  }

  private ensureMeasureLoop() {
    if (this.measureFrame != null || this.active.size === 0) return
    this.measureFrame = this.ownerWindow.requestAnimationFrame(() => {
      this.measureFrame = null
      if (this.destroyed || this.active.size === 0) return
      this.view.requestMeasure()
      this.ensureMeasureLoop()
    })
  }

  private queueFinish(token: number) {
    if (this.finishQueued.has(token)) return
    this.finishQueued.add(token)
    this.ownerWindow.queueMicrotask(() => {
      this.finishQueued.delete(token)
      this.finish(token)
    })
  }

  private finish(token: number) {
    if (this.destroyed) return
    const found = calloutTransitionWithToken(
      this.view.state.field(this.field).transitions,
      token
    )
    if (!found) return

    const active = this.active.get(token)
    if (active) this.cancel(active)
    this.pendingSnapshots.delete(token)
    this.view.dispatch({
      effects: finishCalloutFoldTransition.of({
        from: found.from,
        signature: found.transition.signature,
        token,
      }),
    })
  }

  private cancel(active: ActiveCalloutFoldAnimation) {
    if (this.active.get(active.token) === active) {
      this.active.delete(active.token)
    }
    active.animation.cancel()
    active.element.style.overflow = active.previousOverflow
    active.element.style.willChange = active.previousWillChange
    active.element.removeAttribute("aria-hidden")
    active.element.removeAttribute("inert")
    if (this.active.size === 0 && this.measureFrame != null) {
      this.ownerWindow.cancelAnimationFrame(this.measureFrame)
      this.measureFrame = null
    }
  }
}

const calloutBlockTheme = EditorView.baseTheme({
  "&.cm-md-live .cm-md-quote-block": {
    boxSizing: "border-box",
    borderInlineStart:
      "2px solid color-mix(in oklab, currentColor 22%, transparent)",
    color: "color-mix(in oklab, currentColor 78%, transparent)",
    margin: "0",
    maxWidth: boundedPreviewMaxWidth,
    overflowX: "auto",
    paddingInlineStart: "0.85rem",
    scrollbarWidth: "thin",
  },
  "&.cm-md-live .cm-md-quote-block .cm-md-quote-block": {
    marginInlineStart: "0.25rem",
  },
  "&.cm-md-live .cm-md-callout": {
    "--cm-md-callout-background":
      "var(--callout-surface-background, color-mix(in oklab, var(--document-foreground, #171717) 7%, var(--document-background, #fff)))",
    "--cm-md-callout-foreground": "var(--document-foreground, #171717)",
    boxSizing: "border-box",
    border: "0",
    borderRadius: "calc(0.55rem * var(--app-corner-radius-scale, 1))",
    backgroundColor: "var(--cm-md-callout-background)",
    color: "var(--cm-md-callout-foreground)",
    cornerShape: "var(--app-corner-shape, round)",
    // BlockWrapper geometry is measured without outer margins. Vertical
    // margins would make CodeMirror's height map drift from the DOM and cause
    // clicks below callouts to resolve to later document lines. CodeMirror may
    // also mount a viewport fragment that starts in the middle of a wrapper,
    // so keep the top inset on the complete-state header line instead of the
    // fragmentable card.
    margin: "0",
    maxWidth: boundedPreviewMaxWidth,
    overflowX: "clip",
    padding: "0 0.75rem 0.55rem",
  },
  "&.cm-md-live .cm-md-callout-gap": {
    boxSizing: "border-box",
  },
  "&.cm-md-live .cm-md-callout-nested-gap": {
    height: "1lh",
    pointerEvents: "none",
  },
  "&.cm-md-live .cm-md-callout-body": {
    minHeight: "0",
    minWidth: "0",
    overflowX: "auto",
    overscrollBehaviorInline: "contain",
    scrollbarWidth: "thin",
  },
  "&.cm-md-live .cm-md-callout:has(> .cm-md-callout-header-line.cm-md-list-line)":
    {
      // The card already occupies its enclosing list's content lane. Do not
      // apply that list's edge inset a second time to every line in the card.
      "--cm-md-list-edge-indent": "0rem",
    },
  "&.cm-md-live .cm-md-callout *": {
    color: "inherit",
  },
  "&.cm-md-live .cm-md-callout-header-line": {
    color: "var(--cm-md-callout-foreground)",
    fontWeight: "600",
    paddingBlockStart: "calc(2px + 0.55rem)",
    position: "relative",
  },
  "&.cm-md-live .cm-md-callout-header-body-gap": {
    paddingBlockEnd: "calc(2px + 0.45rem)",
  },
  "&.cm-md-live .cm-md-callout-header": {
    alignItems: "center",
    display: "inline-flex",
    gap: "0.625rem",
    width: "100%",
  },
  "&.cm-md-live .cm-md-callout-title": {
    flex: "1 1 auto",
    fontSize: "var(--editor-callout-title-font-size, 20px)",
    lineHeight: "1.15",
    minWidth: "0",
    textTransform: "uppercase",
  },
  "&.cm-md-live .cm-md-callout-palette-info": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-info, #1d4ed8)",
  },
  "&.cm-md-live .cm-md-callout-palette-tip": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-tip, #0f766e)",
  },
  "&.cm-md-live .cm-md-callout-palette-success": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-success, #15803d)",
  },
  "&.cm-md-live .cm-md-callout-palette-danger": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-danger, #dc2626)",
  },
  "&.cm-md-live .cm-md-callout-palette-example": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-example, #7e22ce)",
  },
  "&.cm-md-live .cm-md-callout-palette-quote": {
    "--cm-md-callout-label": "var(--cm-md-syntax-callout-quote, #b45309)",
  },
  "&.cm-md-live .cm-md-callout > .cm-md-callout-header-line .cm-md-callout-title":
    {
      color: "var(--cm-md-callout-label)",
    },
  "&.cm-md-live .cm-md-callout-toggle": {
    alignItems: "center",
    appearance: "none",
    border: "0",
    borderRadius: "0.25rem",
    background: "transparent",
    color: "inherit",
    cursor: "default",
    display: "inline-flex",
    font: "inherit",
    fontWeight: "inherit",
    height: "auto",
    justifyContent: "flex-start",
    padding: "0",
    textAlign: "start",
    width: "100%",
  },
  "&.cm-md-live .cm-md-callout-toggle::before": {
    content: '""',
    insetBlockEnd: "0",
    insetBlockStart: "0",
    insetInlineEnd: "-0.75rem",
    insetInlineStart: "-0.75rem",
    position: "absolute",
  },
  "&.cm-md-live .cm-md-callout-toggle-collapsed::before": {
    insetBlockEnd: "-0.55rem",
  },
  "&.cm-md-live .cm-md-callout-toggle:focus-visible": {
    outline: "2px solid currentColor",
    outlineOffset: "2px",
  },
  "&.cm-md-live .cm-md-callout-chevron": {
    display: "block",
    flex: "0 0 1rem",
    height: "1rem",
    transform: "rotate(0deg)",
    transformOrigin: "center",
    transition: "transform 120ms ease",
    width: "1rem",
  },
  "&.cm-md-live .cm-md-callout-toggle-collapsed .cm-md-callout-chevron": {
    transform: "rotate(-90deg)",
  },
  "@media (prefers-reduced-motion: reduce)": {
    "&.cm-md-live .cm-md-callout-chevron": {
      transition: "none",
    },
  },
})

/**
 * Adds semantic nested blockquote wrappers, arbitrary callout cards, and
 * state-backed callout folding. Install this only in the live-presentation
 * compartment so source mode remains plain Markdown.
 */
export function calloutBlockExtension(
  options: CalloutBlockExtensionOptions = {}
): Extension {
  const selectionActiveState = options.selectionActiveState ?? (() => false)
  const field: StateField<CalloutBlockState> = StateField.define({
    create: (state): CalloutBlockState =>
      createCalloutBlockState(
        state,
        new Map(),
        selectionActiveState(state),
        undefined,
        field
      ),
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
      const hasOverrideEffect = transaction.effects.some(
        (effect) =>
          effect.is(setCalloutCollapsed) ||
          effect.is(beginCalloutFoldTransition)
      )
      const hasFoldLifecycleEffect = transaction.effects.some(
        (effect) =>
          effect.is(setCalloutCollapsed) ||
          effect.is(beginCalloutFoldTransition) ||
          effect.is(finishCalloutFoldTransition)
      )
      const selectionChanged = !value.presentedSelection.eq(
        transaction.state.selection
      )
      const previousSelectionActive = value.presentedSelectionActive
      const nextSelectionActive = selectionActiveState(transaction.state)
      const selectionActivityChanged =
        previousSelectionActive !== nextSelectionActive
      const previousQuery = editorSearchQuery(transaction.startState)
      const nextQuery = editorSearchQuery(transaction.state)
      const searchIssueChanged =
        editorSearchIssue(transaction.startState) !==
        editorSearchIssue(transaction.state)
      const queryChanged =
        previousQuery !== nextQuery &&
        (previousQuery === null ||
          nextQuery === null ||
          !previousQuery.eq(nextQuery))
      const nextWordCharacters = wordCharactersAtSelection(transaction.state)
      // SearchQuery derives whole-word boundaries from the language at the
      // selection head. A language-context change therefore invalidates every
      // synthetic title match, not only the headers touched by the selection.
      const wholeWordContextChanged =
        nextQuery?.valid === true &&
        nextQuery.wholeWord &&
        value.presentedWordCharacters !== nextWordCharacters
      const previousSearchMatch = currentSearchMatch(transaction.startState)
      const nextSearchMatch = currentSearchMatch(transaction.state)
      const currentSearchMatchChanged =
        previousSearchMatch?.from !== nextSearchMatch?.from ||
        previousSearchMatch?.to !== nextSearchMatch?.to
      const refreshRequested = livePreviewRefreshRequested(transaction)
      if (
        !syntaxChanged &&
        !hasFoldLifecycleEffect &&
        preservePreviewDuringPointerSelection(transaction)
      ) {
        return value
      }
      if (
        !transaction.docChanged &&
        !syntaxChanged &&
        !hasFoldLifecycleEffect &&
        !refreshRequested &&
        !selectionChanged &&
        !selectionActivityChanged &&
        !queryChanged &&
        !searchIssueChanged &&
        !wholeWordContextChanged &&
        !currentSearchMatchChanged
      ) {
        return value
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

      let blockIndex = value.blockIndex
      let syntaxRanges: readonly DocumentRange[] = []
      let freshBlocks: readonly MarkdownQuoteBlock[] = []
      if (transaction.docChanged) {
        const rebuildCompleteIndex =
          markdownBlockPairingMayChange(transaction) ||
          quoteBlockPairingMayChange(transaction, value.tree, tree)
        syntaxRanges = rebuildCompleteIndex
          ? [completeDocumentRange(transaction.state)]
          : changedSyntaxRanges(transaction, value.tree, tree)
        freshBlocks = analyzeMarkdownQuoteBlocksInRanges(
          transaction.state,
          syntaxRanges,
          tree
        )
        blockIndex = rebuildCompleteIndex
          ? buildQuoteBlockIndex(freshBlocks)
          : refreshQuoteBlockIndex(
              value.blockIndex,
              transaction,
              syntaxRanges,
              freshBlocks
            )
      } else if (syntaxChanged) {
        freshBlocks = analyzeMarkdownQuoteBlocks(transaction.state, tree)
        blockIndex = buildQuoteBlockIndex(freshBlocks)
      }

      const overrides =
        transaction.docChanged || syntaxChanged || hasOverrideEffect
          ? updateOverrides(value.overrides, blockIndex, transaction)
          : value.overrides
      const nextEditing = calloutContainingSelection(
        transaction.state,
        blockIndex,
        nextSelectionActive
      )
      const editing =
        !transaction.docChanged &&
        !syntaxChanged &&
        editingPresentationMatches(value.editing, nextEditing, transaction)
          ? value.editing
          : nextEditing
      const editingChanged = !editingPresentationMatches(
        value.editing,
        editing,
        transaction
      )
      const transitions =
        transaction.docChanged ||
        syntaxChanged ||
        hasFoldLifecycleEffect ||
        (value.transitions.size > 0 && editingChanged)
          ? updateTransitions(
              value.transitions,
              blockIndex,
              editing,
              transaction
            )
          : value.transitions

      const fullRange = [completeDocumentRange(transaction.state)]
      const allBlocks = () => quoteBlocksInRanges(blockIndex, fullRange)
      const allCallouts = (blocks: readonly MarkdownQuoteBlock[]) =>
        blocks.filter(
          (block): block is CalloutBlock => block.kind === "callout"
        )

      let folds = value.folds
      let headers = value.headers
      let transitionAtomicRanges = value.transitionAtomicRanges
      let wrappers = value.wrappers

      if (syntaxChanged && !transaction.docChanged) {
        const blocks = freshBlocks
        const callouts = allCallouts(blocks)
        folds = buildCalloutFoldDecorations(
          callouts,
          overrides,
          editing,
          transitions
        )
        headers = buildHeaderDecorations(
          transaction.state,
          callouts,
          overrides,
          transitions,
          editing,
          nextSelectionActive,
          field
        )
        transitionAtomicRanges = buildCalloutTransitionAtomicRanges(
          callouts,
          transitions,
          editing
        )
        wrappers = buildQuoteBlockWrappers(
          blocks,
          overrides,
          editing,
          transitions
        )
      } else if (hasFoldLifecycleEffect) {
        const blocks = allBlocks()
        const callouts = allCallouts(blocks)
        folds = buildCalloutFoldDecorations(
          callouts,
          overrides,
          editing,
          transitions
        )
        headers = buildHeaderDecorations(
          transaction.state,
          callouts,
          overrides,
          transitions,
          editing,
          nextSelectionActive,
          field
        )
        transitionAtomicRanges = buildCalloutTransitionAtomicRanges(
          callouts,
          transitions,
          editing
        )
        wrappers = buildQuoteBlockWrappers(
          blocks,
          overrides,
          editing,
          transitions
        )
      } else {
        const structureRanges = mergeDocumentRanges([
          ...syntaxRanges,
          ...editingRefreshRanges(value.editing, editing, transaction, tree),
          ...(transaction.docChanged
            ? activeTransitionRefreshRanges(
                transaction.state,
                blockIndex,
                transitions,
                tree
              )
            : []),
        ])
        if (transaction.docChanged || structureRanges.length > 0) {
          const blocks = quoteBlocksInRanges(blockIndex, structureRanges)
          const callouts = allCallouts(blocks)
          const structure = refreshCalloutStructure(
            value,
            transaction,
            structureRanges,
            blocks,
            callouts,
            overrides,
            transitions,
            editing
          )
          folds = structure.folds
          transitionAtomicRanges = structure.transitionAtomicRanges
          wrappers = structure.wrappers
        }

        if (queryChanged || wholeWordContextChanged) {
          const blocks = allBlocks()
          headers = buildHeaderDecorations(
            transaction.state,
            allCallouts(blocks),
            overrides,
            transitions,
            editing,
            nextSelectionActive,
            field
          )
        } else {
          const headerRanges = mergeDocumentRanges([
            ...structureRanges,
            ...(currentSearchMatchChanged
              ? searchMatchHeaderRefreshRanges(
                  transaction,
                  previousSearchMatch,
                  nextSearchMatch
                )
              : []),
            ...(selectionChanged || selectionActivityChanged || refreshRequested
              ? selectionHeaderRefreshRanges(
                  transaction,
                  blockIndex,
                  value.presentedSelection,
                  previousSelectionActive,
                  nextSelectionActive
                )
              : []),
          ])
          if (transaction.docChanged || headerRanges.length > 0) {
            const callouts = calloutsWithHeadersInRanges(
              blockIndex,
              headerRanges
            )
            headers = refreshCalloutHeaders(
              value.headers,
              transaction,
              headerRanges,
              transaction.state,
              callouts,
              overrides,
              transitions,
              editing,
              nextSelectionActive,
              field
            )
          }
        }
      }

      return {
        blockIndex,
        editing,
        overrides,
        presentedSelection: transaction.state.selection,
        presentedSelectionActive: nextSelectionActive,
        presentedWordCharacters: nextWordCharacters,
        transitions,
        folds,
        headers,
        transitionAtomicRanges,
        tree,
        wrappers,
      }
    },
    provide: (currentField) => [
      EditorView.decorations.from(currentField, (value) => value.folds),
      EditorView.decorations.from(currentField, (value) => value.headers),
      EditorView.atomicRanges.from(currentField, (value) => () => value.folds),
      EditorView.atomicRanges.from(
        currentField,
        (value) => () => value.transitionAtomicRanges
      ),
      EditorView.blockWrappers.from(currentField, (value) => value.wrappers),
      calloutEditingRange.from(currentField, (value) =>
        value.editing
          ? { from: value.editing.wrapperFrom, to: value.editing.to }
          : null
      ),
    ],
  })

  const animationPlugin = ViewPlugin.define(
    (view) => new CalloutFoldAnimationPlugin(view, field)
  )

  const resolvePointerSelection = (element: HTMLElement | null) => {
    if (!element) return null
    const from = Number(element.dataset.calloutFrom)
    const to = Number(element.dataset.calloutTo)
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to
      ? {
          dragSelection: "rendered" as const,
          element,
          from,
          to,
        }
      : null
  }
  const deepestPointerSelection = (target: Element) =>
    resolvePointerSelection(target.closest<HTMLElement>(".cm-md-callout"))
  const outermostPointerSelection = (target: Element) => {
    let element = target.closest<HTMLElement>(".cm-md-callout")
    if (!element) return null
    for (
      let parent =
        element.parentElement?.closest<HTMLElement>(".cm-md-callout");
      parent;
      parent = element.parentElement?.closest<HTMLElement>(".cm-md-callout")
    ) {
      element = parent
    }
    return resolvePointerSelection(element)
  }
  const pointerSelection = semanticPreviewSelectionResolvers.of({
    priority: 100,
    resolveTarget(_view, target) {
      // A source-origin drag treats a nested card as part of the complete
      // outer rendered unit it first entered. Rendered-origin gestures still
      // use the deepest card below through the precise resolver.
      return outermostPointerSelection(target)
    },
    resolve(_view, target) {
      return deepestPointerSelection(target)
    },
  })

  return [
    Prec.high(field),
    Prec.high(animationPlugin),
    pointerSelection,
    calloutBlockTheme,
  ]
}
