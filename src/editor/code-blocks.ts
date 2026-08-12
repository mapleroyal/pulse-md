import { syntaxTree } from "@codemirror/language"
import {
  countColumn,
  EditorSelection,
  findClusterBreak,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state"
import type { SyntaxNode, Tree } from "@lezer/common"
import {
  BlockWrapper,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"

import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import { preservePreviewDuringPointerSelection } from "./interactive-preview"

interface CodeTextSegment {
  readonly from: number
  readonly to: number
}

interface MarkdownCodeBlockBase {
  readonly closed: boolean
  readonly from: number
  readonly to: number
  readonly wrapperFrom: number
  readonly openingLineFrom: number
  readonly toolAnchor: number
  readonly firstContentLine: number
  readonly lastContentLine: number
  readonly info: string
  readonly signature: string
  readonly codeText: readonly CodeTextSegment[]
}

export interface FencedCodeBlock extends MarkdownCodeBlockBase {
  readonly kind: "fenced"
  readonly infoFrom: number | null
  readonly infoTo: number | null
  readonly toolLineFrom: number
}

export interface IndentedCodeBlock extends MarkdownCodeBlockBase {
  readonly kind: "indented"
  readonly closed: true
  readonly toolLineFrom: null
  readonly sourceIndent: readonly CodeTextSegment[]
}

export type MarkdownCodeBlock = FencedCodeBlock | IndentedCodeBlock

export interface CodeBlockExtensionOptions {
  /** Omits blocks whose rendering is currently owned by another preview. */
  readonly include?: (state: EditorState, block: FencedCodeBlock) => boolean
  /** Changes whenever a state-dependent include decision may have changed. */
  readonly filterKey?: (state: EditorState) => unknown
}

interface CodeWrapOverride {
  readonly signature: string
  readonly wrapped: boolean
}

interface CodeBlockState {
  readonly allBlockIndex: RangeSet<IndexedCodeBlock>
  readonly blockIndex: RangeSet<IndexedCodeBlock>
  readonly filterKey: unknown
  readonly tree: Tree
  readonly wraps: ReadonlyMap<number, CodeWrapOverride>
  readonly wrappers: ReturnType<typeof BlockWrapper.set>
  readonly tools: DecorationSet
}

interface SetCodeBlockWrappedValue {
  readonly from: number
  readonly signature: string
  readonly wrapped: boolean
}

export const setCodeBlockWrapped = StateEffect.define<SetCodeBlockWrappedValue>(
  {
    map: (value, changes) => ({
      ...value,
      from: changes.mapPos(value.from, 1),
    }),
  }
)

interface VisibleRange {
  readonly from: number
  readonly to: number
}

interface DocumentRange {
  readonly from: number
  readonly to: number
}

class IndexedCodeBlock extends RangeValue {
  readonly block: MarkdownCodeBlock

  constructor(block: MarkdownCodeBlock) {
    super()
    this.block = block
  }

  eq(other: RangeValue) {
    return other instanceof IndexedCodeBlock && other.block === this.block
  }

  materialize(state: EditorState, from: number, to: number): MarkdownCodeBlock {
    const delta = from - this.block.from
    const firstContentLine =
      state.doc.lineAt(this.block.openingLineFrom + delta).number +
      (this.block.kind === "fenced" ? 1 : 0)
    const common = {
      ...this.block,
      from,
      to,
      wrapperFrom: this.block.wrapperFrom + delta,
      openingLineFrom: this.block.openingLineFrom + delta,
      toolAnchor: this.block.toolAnchor + delta,
      firstContentLine,
      lastContentLine:
        firstContentLine +
        (this.block.lastContentLine - this.block.firstContentLine),
      codeText: this.block.codeText.map((segment) => ({
        from: segment.from + delta,
        to: segment.to + delta,
      })),
    }
    if (this.block.kind === "indented") {
      return {
        ...common,
        kind: "indented",
        closed: true,
        toolLineFrom: null,
        sourceIndent: this.block.sourceIndent.map((segment) => ({
          from: segment.from + delta,
          to: segment.to + delta,
        })),
      }
    }
    return {
      ...common,
      kind: "fenced",
      infoFrom:
        this.block.infoFrom == null ? null : this.block.infoFrom + delta,
      infoTo: this.block.infoTo == null ? null : this.block.infoTo + delta,
      toolLineFrom: this.block.toolLineFrom + delta,
    }
  }
}

function childNodes(node: SyntaxNode) {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

function analyzeFencedCodeNode(
  state: EditorState,
  node: SyntaxNode
): FencedCodeBlock | null {
  const children = childNodes(node)
  const marks = children.filter((child) => child.name === "CodeMark")
  const openingMark = marks[0]
  if (!openingMark) return null

  const openingLine = state.doc.lineAt(openingMark.from)
  const closingMark = marks.find(
    (mark) => state.doc.lineAt(mark.from).number > openingLine.number
  )
  const closingLine = closingMark ? state.doc.lineAt(closingMark.from) : null
  const firstContentLine = openingLine.number + 1
  const lastContentLine = closingLine
    ? closingLine.number - 1
    : state.doc.lineAt(node.to).number
  const infoNode = children.find((child) => child.name === "CodeInfo")
  const toolLineFrom = openingLine.from
  const toolAnchor = Math.min(node.to, openingLine.to + 1)

  return {
    kind: "fenced",
    closed: closingLine != null,
    from: node.from,
    to: node.to,
    wrapperFrom: openingLine.from,
    openingLineFrom: openingLine.from,
    toolLineFrom,
    toolAnchor,
    firstContentLine,
    lastContentLine,
    info: infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : "",
    infoFrom: infoNode?.from ?? null,
    infoTo: infoNode?.to ?? null,
    signature: state.sliceDoc(openingMark.from, openingLine.to),
    codeText: children
      .filter((child) => child.name === "CodeText")
      .map((child) => ({ from: child.from, to: child.to })),
  }
}

function analyzeIndentedCodeNode(
  state: EditorState,
  node: SyntaxNode
): IndentedCodeBlock {
  const children = childNodes(node)
  const codeText = children
    .filter((child) => child.name === "CodeText")
    .map((child) => ({ from: child.from, to: child.to }))
  const firstLine = state.doc.lineAt(node.from)
  const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
  const wrapperFrom = firstLine.from
  // Keep the zero-height tools widget inside the wrapper as a block sibling.
  // That gives its host the same compositor-stable sticky geometry as fenced
  // code without inserting a visible tools row above the first code line.
  const toolAnchor = Math.min(node.to, firstLine.to + 1)

  return {
    kind: "indented",
    closed: true,
    from: wrapperFrom,
    to: node.to,
    wrapperFrom,
    openingLineFrom: wrapperFrom,
    toolLineFrom: null,
    toolAnchor,
    firstContentLine: firstLine.number,
    lastContentLine: lastLine.number,
    info: "",
    signature: "indented-code",
    codeText,
    // Lezer excludes the four-column CommonMark marker from each CodeText
    // node. Keep those source ranges explicit so live preview can collapse
    // the syntax without altering the editable document or copied code.
    sourceIndent: codeText
      .map((segment) => ({
        from: state.doc.lineAt(segment.from).from,
        to: segment.from,
      }))
      .filter((segment) => segment.from < segment.to),
  }
}

function analyzeMarkdownCodeBlocksInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  tree: Tree = completeMarkdownSyntaxTree(state)
) {
  const blocks: MarkdownCodeBlock[] = []
  const seen = new Set<number>()
  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        if (
          (node.name !== "FencedCode" && node.name !== "CodeBlock") ||
          seen.has(node.from)
        ) {
          return
        }
        const block =
          node.name === "FencedCode"
            ? analyzeFencedCodeNode(state, node.node)
            : analyzeIndentedCodeNode(state, node.node)
        if (!block) return
        seen.add(node.from)
        blocks.push(block)
      },
    })
  }

  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan(null)
  }

  return blocks.sort((left, right) => left.from - right.from)
}

function analyzeFencedCodeBlocksInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  tree: Tree = completeMarkdownSyntaxTree(state)
) {
  return analyzeMarkdownCodeBlocksInRanges(state, ranges, tree).filter(
    (block): block is FencedCodeBlock => block.kind === "fenced"
  )
}

/** Extracts literal fence metadata without consulting the syntax-language registry. */
export function analyzeFencedCodeBlocks(
  state: EditorState,
  tree: Tree = completeMarkdownSyntaxTree(state)
): readonly FencedCodeBlock[] {
  return analyzeFencedCodeBlocksInRanges(state, null, tree)
}

/** Extracts every Markdown code block without consulting language parsers. */
export function analyzeMarkdownCodeBlocks(
  state: EditorState,
  tree: Tree = completeMarkdownSyntaxTree(state)
): readonly MarkdownCodeBlock[] {
  return analyzeMarkdownCodeBlocksInRanges(state, null, tree)
}

export function markdownCodeBlockText(
  state: EditorState,
  block: MarkdownCodeBlock
) {
  return block.codeText
    .map((segment) => state.sliceDoc(segment.from, segment.to))
    .join("")
}

export function fencedCodeText(state: EditorState, block: FencedCodeBlock) {
  return markdownCodeBlockText(state, block)
}

function codeBlockWrapperRange(block: MarkdownCodeBlock) {
  return BlockWrapper.create({
    tagName: "div",
    attributes: {
      class: "cm-md-code-block",
      "data-code-kind": block.kind,
      // Keep the wrapper decoration stable so toggling wrap can preserve its
      // nested controls. The view plugin reconciles this seed attribute with
      // the live block-local state after CodeMirror updates the document DOM.
      "data-code-wrap": "false",
    },
    rank: 10,
  }).range(block.wrapperFrom, block.to)
}

function codeBlockElementAt(view: EditorView, position: number) {
  let node: Node
  try {
    node = view.domAtPos(position).node
  } catch {
    return null
  }
  const element =
    node instanceof HTMLElement ? node : (node.parentElement ?? null)
  return element?.closest<HTMLElement>(
    '.cm-md-code-block[data-code-wrap="false"]'
  )
}

function codeSelectionHeadMeasurement(view: EditorView) {
  const selection = view.state.selection.main
  const side: -1 | 1 =
    selection.assoc || (selection.head > selection.anchor ? -1 : 1)
  let position: ReturnType<EditorView["domAtPos"]>
  try {
    position = view.domAtPos(selection.head, side)
  } catch {
    return null
  }

  const { node, offset } = position
  const parent = node instanceof Element ? node : node.parentElement
  const block = parent?.closest<HTMLElement>(
    '.cm-md-code-block[data-code-wrap="false"]'
  )
  if (!block || block.scrollWidth <= block.clientWidth) return null

  const range = node.ownerDocument?.createRange()
  if (!range) return null
  range.setStart(node, offset)
  range.collapse(true)
  let caret = range.getBoundingClientRect()

  if (caret.height === 0 && node instanceof Text && node.length > 0) {
    const from =
      side < 0
        ? Math.max(0, Math.min(node.length - 1, offset - 1))
        : Math.max(0, Math.min(node.length - 1, offset))
    range.setStart(node, from)
    range.setEnd(node, from + 1)
    const character = range.getBoundingClientRect()
    const x = side < 0 ? character.right : character.left
    caret = DOMRect.fromRect({
      x,
      y: character.top,
      width: 0,
      height: character.height,
    })
  }

  const bounds = block.getBoundingClientRect()
  const scale = block.offsetWidth > 0 ? bounds.width / block.offsetWidth : 1
  const left = bounds.left + block.clientLeft * scale
  const right = left + block.clientWidth * scale
  const margin = 5
  const maximum = Math.max(0, block.scrollWidth - block.clientWidth)
  const line = view.state.doc.lineAt(selection.head)
  if (selection.head === line.from) {
    return { block, scrollLeft: 0 }
  }

  if (selection.head === line.to) {
    const contentX = (caret.right - left) / scale + block.scrollLeft
    const lineElement =
      parent?.closest<HTMLElement>(".cm-line") ??
      (node instanceof HTMLElement
        ? node
        : node.parentElement
      )?.closest<HTMLElement>(".cm-line")
    const paddingEnd = lineElement
      ? Number.parseFloat(
          lineElement.ownerDocument.defaultView?.getComputedStyle(lineElement)
            .paddingInlineEnd ?? "0"
        ) || 0
      : 0
    if (contentX >= block.scrollWidth - paddingEnd - 1) {
      return { block, scrollLeft: maximum }
    }
  }

  const screenDelta =
    caret.right > right - margin
      ? caret.right - (right - margin)
      : caret.left < left + margin
        ? caret.left - (left + margin)
        : 0
  return {
    block,
    scrollLeft: Math.max(
      0,
      Math.min(maximum, block.scrollLeft + screenDelta / scale)
    ),
  }
}

export function buildCodeBlockWrappers(blocks: readonly MarkdownCodeBlock[]) {
  return BlockWrapper.set(
    blocks.map((block) => codeBlockWrapperRange(block)),
    true
  )
}

function buildCodeBlockIndex(blocks: readonly MarkdownCodeBlock[]) {
  return RangeSet.of(
    blocks.map((block) =>
      new IndexedCodeBlock(block).range(block.from, block.to)
    ),
    true
  )
}

function blocksInRanges(
  state: EditorState,
  index: RangeSet<IndexedCodeBlock>,
  ranges: readonly DocumentRange[]
) {
  const blocks: MarkdownCodeBlock[] = []
  const seen = new Set<IndexedCodeBlock>()
  for (const range of ranges) {
    index.between(range.from, range.to, (from, to, value) => {
      if (seen.has(value)) return
      seen.add(value)
      blocks.push(value.materialize(state, from, to))
    })
  }
  return blocks.sort((left, right) => left.from - right.from)
}

function blockAtPosition(
  state: EditorState,
  index: RangeSet<IndexedCodeBlock>,
  position: number
): MarkdownCodeBlock | undefined {
  return blocksInRanges(state, index, [
    { from: position, to: Math.min(state.doc.length, position + 1) },
  ]).find((block) => block.from === position)
}

function blockContainingPosition(
  state: EditorState,
  index: RangeSet<IndexedCodeBlock>,
  position: number
) {
  const from = Math.max(0, position - 1)
  const to = Math.min(state.doc.length, position + 1)
  return blocksInRanges(state, index, [{ from, to }]).find(
    (block) => position >= block.from && position <= block.to
  )
}

function moveCodeSelectionToLineBoundary(
  view: EditorView,
  field: StateField<CodeBlockState>,
  forward: boolean,
  extend: boolean
) {
  const { state } = view
  if (state.selection.ranges.length !== 1) return false
  const range = state.selection.main
  const value = state.field(field)
  const block = blockContainingPosition(state, value.blockIndex, range.head)
  if (!block || value.wraps.get(block.from)?.wrapped === true) return false

  const line = state.doc.lineAt(range.head)
  const head = forward ? line.to : line.from
  const moved = extend
    ? EditorSelection.range(range.anchor, head)
    : EditorSelection.cursor(head, forward ? -1 : 1)
  const selection = EditorSelection.create([moved])
  if (selection.eq(state.selection, true)) return true
  view.dispatch({
    selection,
    effects: EditorView.scrollIntoView(head),
    userEvent: "select.keyboard",
  })
  return true
}

function remapWraps(
  wraps: ReadonlyMap<number, CodeWrapOverride>,
  transaction: Transaction
) {
  if (transaction.changes.empty) return new Map(wraps)
  const mapped = new Map<number, CodeWrapOverride>()
  for (const [from, value] of wraps) {
    let anchorDeleted = false
    transaction.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= from && from < toA) anchorDeleted = true
    })
    // Mapping a deleted opening fence to its successor can otherwise transfer
    // the override to a byte-identical following block.
    if (anchorDeleted) continue
    mapped.set(transaction.changes.mapPos(from, 1), value)
  }
  return mapped
}

function updateWraps(
  previous: ReadonlyMap<number, CodeWrapOverride>,
  blockIndex: RangeSet<IndexedCodeBlock>,
  transaction: Transaction
) {
  const wraps = remapWraps(previous, transaction)
  for (const effect of transaction.effects) {
    if (!effect.is(setCodeBlockWrapped)) continue
    wraps.set(effect.value.from, {
      signature: effect.value.signature,
      wrapped: effect.value.wrapped,
    })
  }

  for (const [from, value] of wraps) {
    const block = blockAtPosition(transaction.state, blockIndex, from)
    if (block?.signature !== value.signature) {
      wraps.delete(from)
    }
  }
  return wraps
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

/**
 * Markdown block structure can propagate past the changed line (a newly typed
 * fence may consume a distant closing fence). Refresh the complete top-level
 * nodes touching the edit, while leaving every unrelated subtree indexed.
 */
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

function expandSyntaxRangesThroughMappedBlocks(
  state: EditorState,
  tree: Tree,
  index: RangeSet<IndexedCodeBlock>,
  ranges: readonly DocumentRange[]
) {
  let expanded = mergeDocumentRanges(ranges)
  for (;;) {
    const candidates = [...expanded]
    for (const range of expanded) {
      index.between(range.from, range.to, (from, to) => {
        if (to > range.from && from < range.to) {
          candidates.push({ from, to })
        }
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
        (range, index) =>
          range.from === expanded[index]?.from &&
          range.to === expanded[index]?.to
      )
    ) {
      return next
    }
    expanded = next
  }
}

function removeIndexedRanges(
  index: RangeSet<IndexedCodeBlock>,
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

function removeWrapperRanges(
  wrappers: ReturnType<typeof BlockWrapper.set>,
  ranges: readonly DocumentRange[]
) {
  let updated = wrappers
  for (const range of ranges) {
    updated = updated.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function refreshCodeBlockIndex(
  previous: RangeSet<IndexedCodeBlock>,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  freshBlocks: readonly MarkdownCodeBlock[]
) {
  const mapped = previous.map(transaction.changes)
  const retained = removeIndexedRanges(mapped, ranges)
  const additions = freshBlocks.map((block) =>
    new IndexedCodeBlock(block).range(block.from, block.to)
  )
  return {
    blockIndex:
      additions.length > 0
        ? retained.update({ add: additions, sort: true })
        : retained,
    freshBlocks,
  }
}

function refreshCodeBlockWrappers(
  previous: ReturnType<typeof BlockWrapper.set>,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  freshBlocks: readonly MarkdownCodeBlock[]
) {
  const mapped = previous.map(transaction.changes)
  const retained = removeWrapperRanges(mapped, ranges)
  const additions = freshBlocks.map((block) => codeBlockWrapperRange(block))
  return additions.length > 0
    ? retained.update({ add: additions, sort: true })
    : retained
}

interface CodeToolIcon {
  readonly pathData: string
  readonly viewBox?: string
  readonly filled?: boolean
}

const enableWordWrapIcon: CodeToolIcon = {
  viewBox: "0 0 20 20",
  filled: true,
  pathData:
    "M15.672 2.668c.367 0 .665.298.665.665l-.002 13.333a.665.665 0 0 1-1.33 0l.002-13.333c0-.367.298-.665.665-.665ZM9.586 6.002a3.582 3.582 0 0 1 0 7.163H5.777l.949.948a.665.665 0 1 1-.94.94l-2.084-2.082a.667.667 0 0 1 0-.94l2.083-2.085a.666.666 0 0 1 .94.942l-.947.947h3.808a2.251 2.251 0 0 0 0-4.503H4.169a.666.666 0 0 1 0-1.33h5.417Z",
}

const disableWordWrapIcon: CodeToolIcon = {
  viewBox: "0 0 20 20",
  filled: true,
  pathData:
    "M10.33 12.668c.367 0 .665.298.665.665l.002 3.333a.665.665 0 0 1-1.33.001l-.002-3.334c0-.367.298-.665.665-.665Zm3.364-5.639a.665.665 0 0 1 .94 0l2.5 2.5c.26.26.26.682 0 .942l-2.5 2.5a.666.666 0 0 1-.94-.942l1.365-1.364H3.33a.665.665 0 1 1 0-1.33h11.728l-1.365-1.364a.666.666 0 0 1 0-.942ZM10.33 2.668c.367 0 .665.298.665.665l.002 3.333a.665.665 0 0 1-1.33.001l-.002-3.334c0-.367.298-.665.665-.665Z",
}

const copyCodeIcon: CodeToolIcon = {
  pathData: "M8 8h11v11H8zM5 16H4V5h11v1",
}

let nextCodeToolTooltipId = 0
const codeTooltipCleanups = new WeakMap<HTMLElement, () => void>()
const codeTooltipPositioners = new WeakMap<HTMLElement, () => void>()

function configureIcon(icon: SVGSVGElement, definition: CodeToolIcon) {
  icon.setAttribute("viewBox", definition.viewBox ?? "0 0 24 24")
  if (definition.filled) {
    icon.setAttribute("fill", "currentColor")
    icon.removeAttribute("stroke")
    icon.removeAttribute("stroke-width")
    icon.removeAttribute("stroke-linecap")
    icon.removeAttribute("stroke-linejoin")
  } else {
    icon.setAttribute("fill", "none")
    icon.setAttribute("stroke", "currentColor")
    icon.setAttribute("stroke-width", "2")
    icon.setAttribute("stroke-linecap", "round")
    icon.setAttribute("stroke-linejoin", "round")
  }
}

function createIcon(document: Document, definition: CodeToolIcon) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  configureIcon(icon, definition)
  icon.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", definition.pathData)
  icon.append(path)
  return icon
}

function updateToolButtonLabel(button: HTMLButtonElement, label: string) {
  button.setAttribute("aria-label", label)
  const tooltipId = button.getAttribute("aria-describedby")
  const tooltip = tooltipId
    ? button.ownerDocument.getElementById(tooltipId)
    : null
  if (tooltip) tooltip.textContent = label
  if (tooltip?.dataset.visible) codeTooltipPositioners.get(button)?.()
}

function updateToolButtonIcon(
  button: HTMLButtonElement,
  definition: CodeToolIcon
) {
  const icon = button.querySelector<SVGSVGElement>("svg")
  const path = icon?.querySelector<SVGPathElement>("path")
  if (!icon || !path) {
    button.replaceChildren(createIcon(button.ownerDocument, definition))
    return
  }
  configureIcon(icon, definition)
  path.setAttribute("d", definition.pathData)
}

function attachCodeTooltip(
  view: EditorView,
  trigger: HTMLElement,
  label: string
) {
  const document = view.dom.ownerDocument
  const ownerWindow = document.defaultView

  const tooltip = document.createElement("span")
  tooltip.className = "cm-md-code-tooltip"
  tooltip.id = `cm-md-code-tooltip-${(nextCodeToolTooltipId += 1)}`
  tooltip.setAttribute("role", "tooltip")
  tooltip.textContent = label
  trigger.classList.add("cm-md-code-tooltip-trigger")
  trigger.setAttribute("aria-describedby", tooltip.id)
  view.dom.append(tooltip)

  let positionFrame: number | null = null
  let trackingPosition = false

  const positionTooltip = () => {
    positionFrame = null
    const block = trigger.closest<HTMLElement>(".cm-md-code-block")
    if (!block || !trigger.isConnected || !tooltip.isConnected) return

    const triggerRect = trigger.getBoundingClientRect()
    const blockRect = block.getBoundingClientRect()
    const viewportWidth =
      ownerWindow?.innerWidth ?? document.documentElement.clientWidth
    const viewportHeight =
      ownerWindow?.innerHeight ?? document.documentElement.clientHeight
    tooltip.style.maxWidth = `${Math.max(
      0,
      Math.min(320, viewportWidth - 16, blockRect.width)
    )}px`

    const tooltipRect = tooltip.getBoundingClientRect()
    const left = Math.max(
      blockRect.left,
      Math.min(
        triggerRect.right - tooltipRect.width,
        blockRect.right - tooltipRect.width
      )
    )
    const below = triggerRect.bottom + 6
    const placeBelow = below + tooltipRect.height <= viewportHeight - 8
    const top = placeBelow
      ? below
      : Math.max(8, triggerRect.top - tooltipRect.height - 6)
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
    tooltip.dataset.side = placeBelow ? "bottom" : "top"
    tooltip.style.setProperty(
      "--cm-md-code-tooltip-arrow-left",
      `${Math.max(
        6,
        Math.min(
          tooltipRect.width - 16,
          triggerRect.left + triggerRect.width / 2 - left - 5
        )
      )}px`
    )
  }

  const requestTooltipPosition = () => {
    if (!ownerWindow || positionFrame != null) return
    positionFrame = ownerWindow.requestAnimationFrame(positionTooltip)
  }

  const stopTrackingPosition = () => {
    if (!trackingPosition || !ownerWindow) return
    trackingPosition = false
    ownerWindow.removeEventListener("resize", requestTooltipPosition)
    ownerWindow.removeEventListener("scroll", requestTooltipPosition, true)
    if (positionFrame != null) {
      ownerWindow.cancelAnimationFrame(positionFrame)
      positionFrame = null
    }
  }

  const hideTooltip = () => {
    delete tooltip.dataset.visible
    stopTrackingPosition()
  }

  const showTooltip = () => {
    tooltip.dataset.visible = "true"
    positionTooltip()
    if (!ownerWindow || trackingPosition) return
    trackingPosition = true
    ownerWindow.addEventListener("resize", requestTooltipPosition)
    ownerWindow.addEventListener("scroll", requestTooltipPosition, true)
  }

  const hideTooltipIfInactive = () => {
    ownerWindow?.queueMicrotask(() => {
      if (trigger.matches(":hover") || document.activeElement === trigger)
        return
      hideTooltip()
    })
  }

  trigger.addEventListener("pointerenter", showTooltip)
  trigger.addEventListener("pointerleave", hideTooltipIfInactive)
  trigger.addEventListener("focus", showTooltip)
  trigger.addEventListener("blur", hideTooltipIfInactive)

  codeTooltipCleanups.set(trigger, () => {
    hideTooltip()
    trigger.removeEventListener("pointerenter", showTooltip)
    trigger.removeEventListener("pointerleave", hideTooltipIfInactive)
    trigger.removeEventListener("focus", showTooltip)
    trigger.removeEventListener("blur", hideTooltipIfInactive)
    tooltip.remove()
    codeTooltipCleanups.delete(trigger)
    codeTooltipPositioners.delete(trigger)
  })
  codeTooltipPositioners.set(trigger, positionTooltip)
}

function createToolButton(view: EditorView, label: string, icon: CodeToolIcon) {
  const document = view.dom.ownerDocument
  const button = document.createElement("button")
  button.className = "cm-md-code-tool"
  button.type = "button"
  button.append(createIcon(document, icon))
  attachCodeTooltip(view, button, label)
  updateToolButtonLabel(button, label)

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  return button
}

async function writeClipboardText(view: EditorView, text: string) {
  const ownerWindow = view.dom.ownerDocument.defaultView
  if (ownerWindow?.navigator.clipboard?.writeText) {
    await ownerWindow.navigator.clipboard.writeText(text)
    return
  }

  const document = view.dom.ownerDocument
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Clipboard copy was rejected")
}

class CodeBlockToolsWidget extends WidgetType {
  readonly block: MarkdownCodeBlock
  readonly wrapped: boolean
  readonly field: StateField<CodeBlockState>

  constructor(
    block: MarkdownCodeBlock,
    wrapped: boolean,
    field: StateField<CodeBlockState>
  ) {
    super()
    this.block = block
    this.wrapped = wrapped
    this.field = field
  }

  eq(other: CodeBlockToolsWidget) {
    return (
      this.block.kind === other.block.kind &&
      this.block.info === other.block.info &&
      this.block.signature === other.block.signature &&
      this.wrapped === other.wrapped &&
      this.field === other.field
    )
  }

  updateDOM(dom: HTMLElement, _view: EditorView, previous: this) {
    if (
      this.block.info !== previous.block.info ||
      this.block.signature !== previous.block.signature ||
      this.field !== previous.field
    ) {
      return false
    }
    if (this.wrapped === previous.wrapped) return true

    const wrap = dom.querySelector<HTMLButtonElement>(".cm-md-code-wrap")
    if (!wrap) return false
    updateToolButtonLabel(
      wrap,
      this.wrapped ? "Disable word wrap" : "Enable word wrap"
    )
    updateToolButtonIcon(
      wrap,
      this.wrapped ? disableWordWrapIcon : enableWordWrapIcon
    )
    wrap.setAttribute("aria-pressed", String(this.wrapped))
    return true
  }

  ignoreEvent(event: Event) {
    const target = event.target
    return (
      target instanceof Element && target.closest(".cm-md-code-tool") != null
    )
  }

  toDOM(view: EditorView) {
    const document = view.dom.ownerDocument
    const host = document.createElement("div")
    host.className =
      this.block.kind === "indented"
        ? "cm-md-code-tools-host cm-md-code-tools-host-indented"
        : "cm-md-code-tools-host"
    host.setAttribute("contenteditable", "false")

    const tools = document.createElement("span")
    tools.className = "cm-md-code-tools"
    tools.setAttribute("contenteditable", "false")
    host.append(tools)

    const currentBlock = () => {
      if (!host.isConnected) return null
      let position: number
      try {
        position = view.posAtDOM(host, 0)
      } catch {
        return null
      }
      const value = view.state.field(this.field)
      return (
        blockContainingPosition(view.state, value.blockIndex, position) ?? null
      )
    }

    if (this.block.info.length > 0) {
      const language = document.createElement("span")
      language.className = "cm-md-code-language"
      language.textContent = this.block.info
      tools.append(language)
    }

    const actions = document.createElement("span")
    actions.className = "cm-md-code-actions"

    const wrapLabel = this.wrapped ? "Disable word wrap" : "Enable word wrap"
    const wrap = createToolButton(
      view,
      wrapLabel,
      this.wrapped ? disableWordWrapIcon : enableWordWrapIcon
    )
    wrap.classList.add("cm-md-code-wrap")
    wrap.setAttribute("aria-pressed", String(this.wrapped))
    wrap.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      const block = currentBlock()
      if (!block) return
      const container = wrap.closest<HTMLElement>(".cm-md-code-block")
      if (container) {
        container.scrollLeft = 0
      }
      const value = view.state.field(this.field)
      const wrapped = value.wraps.get(block.from)?.wrapped === true
      view.dispatch({
        effects: setCodeBlockWrapped.of({
          from: block.from,
          signature: block.signature,
          wrapped: !wrapped,
        }),
      })
      view.requestMeasure()
    })
    actions.append(wrap)

    const copy = createToolButton(view, "Copy code", copyCodeIcon)
    copy.classList.add("cm-md-code-copy")
    copy.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      const block = currentBlock()
      if (!block) return
      void writeClipboardText(
        view,
        markdownCodeBlockText(view.state, block)
      ).then(
        () => {
          copy.dataset.copied = "true"
          updateToolButtonLabel(copy, "Copied code")
          view.dom.ownerDocument.defaultView?.setTimeout(() => {
            delete copy.dataset.copied
            updateToolButtonLabel(copy, "Copy code")
          }, 1_200)
        },
        () => {
          updateToolButtonLabel(copy, "Could not copy code")
        }
      )
    })
    actions.append(copy)
    tools.append(actions)

    return host
  }

  destroy(dom: HTMLElement) {
    for (const trigger of dom.querySelectorAll<HTMLElement>(
      ".cm-md-code-tooltip-trigger"
    )) {
      codeTooltipCleanups.get(trigger)?.()
    }
  }
}

function codeBlockToolRange(
  block: MarkdownCodeBlock,
  wraps: ReadonlyMap<number, CodeWrapOverride>,
  field: StateField<CodeBlockState>
) {
  return Decoration.widget({
    widget: new CodeBlockToolsWidget(
      block,
      wraps.get(block.from)?.wrapped === true,
      field
    ),
    block: true,
    side: block.toolAnchor === block.to ? 1 : -1,
    markdownPreviewKind: "code-tools",
  }).range(block.toolAnchor)
}

function buildCodeBlockTools(
  blocks: readonly MarkdownCodeBlock[],
  wraps: ReadonlyMap<number, CodeWrapOverride>,
  field: StateField<CodeBlockState>
) {
  return Decoration.set(
    blocks.map((block) => codeBlockToolRange(block, wraps, field)),
    true
  )
}

function refreshCodeBlockTools(
  previous: DecorationSet,
  transaction: Transaction,
  ranges: readonly DocumentRange[],
  freshBlocks: readonly MarkdownCodeBlock[],
  wraps: ReadonlyMap<number, CodeWrapOverride>,
  field: StateField<CodeBlockState>
) {
  let retained = previous.map(transaction.changes)
  for (const range of ranges) {
    retained = retained.update({
      // Point widgets anchored at the end of a refreshed block still belong
      // to that block, so invalidate the right boundary as well. Retain the
      // left boundary for a preceding block whose tool anchor maps there.
      filter: (from, to) => to <= range.from || from > range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  const additions = freshBlocks.map((block) =>
    codeBlockToolRange(block, wraps, field)
  )
  return additions.length > 0
    ? retained.update({ add: additions, sort: true })
    : retained
}

function visibleLineNumbers(
  state: EditorState,
  visible: VisibleRange,
  firstLine: number,
  lastLine: number
) {
  if (firstLine > lastLine) return []
  const firstBlockLine = state.doc.line(firstLine)
  const lastBlockLine = state.doc.line(lastLine)
  if (visible.to < firstBlockLine.from || visible.from > lastBlockLine.to) {
    return []
  }

  const clippedFrom = Math.max(firstBlockLine.from, visible.from)
  const clippedTo = Math.min(lastBlockLine.to, visible.to)
  const firstVisibleLine = Math.max(
    firstLine,
    state.doc.lineAt(clippedFrom).number
  )
  const clippedEndLine = state.doc.lineAt(clippedTo)
  const lastPosition =
    clippedEndLine.from === clippedTo && clippedEndLine.length === 0
      ? clippedTo
      : Math.max(
          clippedFrom,
          clippedTo > clippedFrom ? clippedTo - 1 : clippedTo
        )
  const lastVisibleLine = Math.min(
    lastLine,
    state.doc.lineAt(lastPosition).number
  )
  const lines: number[] = []
  for (let number = firstVisibleLine; number <= lastVisibleLine; number += 1) {
    lines.push(number)
  }
  return lines
}

function lineIntersectsVisibleRanges(
  state: EditorState,
  lineFrom: number,
  visibleRanges: readonly VisibleRange[]
) {
  const line = state.doc.lineAt(lineFrom)
  return visibleRanges.some(
    (visible) => visible.from <= line.to && visible.to >= line.from
  )
}

function codeIndentIncludesListMarker(
  state: EditorState,
  indent: CodeTextSegment
) {
  let includes = false
  syntaxTree(state).iterate({
    from: indent.from,
    to: indent.to,
    enter(node) {
      if (node.name !== "ListMark") return
      includes = true
      return false
    },
  })
  return includes
}

export function buildCodeBlockDecorations(
  state: EditorState,
  blocks: readonly MarkdownCodeBlock[],
  visibleRanges: readonly VisibleRange[]
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const decoratedLines = new Set<number>()
  const activeLines = new Set(
    state.selection.ranges.map((range) => state.doc.lineAt(range.head).number)
  )

  for (const block of blocks) {
    if (block.kind === "indented") {
      for (const indent of block.sourceIndent) {
        if (!lineIntersectsVisibleRanges(state, indent.from, visibleRanges)) {
          continue
        }
        const selected = state.selection.ranges.some((range) =>
          range.empty
            ? range.head > indent.from && range.head < indent.to
            : range.from < indent.to && range.to > indent.from
        )
        // A list marker line already projects this complete range into its
        // stable marker/separator lanes. For every other indented-code line,
        // keep the source offsets in a negative-start-margin lane instead of
        // collapsing them into a replacement with only two caret positions.
        if (codeIndentIncludesListMarker(state, indent)) continue
        const columns = countColumn(
          state.sliceDoc(indent.from, indent.to),
          state.tabSize
        )
        ranges.push(
          Decoration.mark({
            class: [
              "cm-md-code-indent-source",
              selected ? "" : "cm-md-code-indent-rendered",
            ]
              .filter(Boolean)
              .join(" "),
            attributes: {
              style: `--cm-md-code-indent-width:${columns * 0.25}em`,
            },
            markdownPreviewKind: "code-indent",
          }).range(indent.from, indent.to)
        )
      }
    }

    if (
      block.toolLineFrom != null &&
      lineIntersectsVisibleRanges(state, block.toolLineFrom, visibleRanges)
    ) {
      decoratedLines.add(state.doc.lineAt(block.toolLineFrom).number)
      ranges.push(
        Decoration.line({
          class: "cm-md-code-line cm-md-code-line-first cm-md-code-tools-line",
        }).range(block.toolLineFrom)
      )
    }

    const lastBlockLine = state.doc.lineAt(Math.max(block.from, block.to - 1))
    if (
      block.kind === "fenced" &&
      block.closed &&
      !decoratedLines.has(lastBlockLine.number) &&
      lineIntersectsVisibleRanges(state, lastBlockLine.from, visibleRanges)
    ) {
      decoratedLines.add(lastBlockLine.number)
      ranges.push(
        Decoration.line({
          class: "cm-md-code-line cm-md-code-line-last",
        }).range(lastBlockLine.from)
      )
    }

    for (const visible of visibleRanges) {
      for (const lineNumber of visibleLineNumbers(
        state,
        visible,
        block.firstContentLine,
        block.lastContentLine
      )) {
        if (decoratedLines.has(lineNumber)) continue
        decoratedLines.add(lineNumber)
        const line = state.doc.line(lineNumber)
        const localNumber = lineNumber - block.firstContentLine + 1
        const classNames = [
          "cm-md-code-line",
          "cm-md-code-content-line",
          activeLines.has(lineNumber) ? "cm-md-code-active-line" : "",
          block.kind === "indented" && lineNumber === block.firstContentLine
            ? "cm-md-code-line-first"
            : "",
          lineNumber === block.lastContentLine &&
          (block.kind === "indented" || !block.closed)
            ? "cm-md-code-line-last"
            : "",
        ].filter(Boolean)
        ranges.push(
          Decoration.line({
            class: classNames.join(" "),
            attributes: {
              "data-code-line-number": String(localNumber),
            },
          }).range(line.from)
        )
      }
    }
  }

  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

class CodeBlockDecorationPlugin {
  decorations: DecorationSet

  private readonly field: StateField<CodeBlockState>
  private readonly view: EditorView
  private refreshingDrawnSelection = false
  private selectionRefreshFrame: number | null = null
  private pointerBlock: HTMLElement | null = null
  private pointerId: number | null = null
  private drag:
    | {
        anchor: number | null
        block: HTMLElement
        clientX: number
        clientY: number
        downX: number
        downY: number
        timer: number | null
      }
    | undefined

  constructor(view: EditorView, field: StateField<CodeBlockState>) {
    this.field = field
    this.view = view
    this.decorations = this.build(view)
    view.dom.addEventListener("scroll", this.handleNestedScroll, true)
    view.dom.addEventListener("mousedown", this.handleMouseDown, true)
    view.dom.addEventListener("pointerdown", this.handlePointerDown, true)
    this.updateNativeCodeSelection()
  }

  update(update: ViewUpdate) {
    if (
      !this.refreshingDrawnSelection &&
      (update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.geometryChanged ||
        update.startState.field(this.field) !== update.state.field(this.field))
    ) {
      this.decorations = this.build(update.view)
    }
    if (
      !this.refreshingDrawnSelection &&
      (update.docChanged ||
        update.selectionSet ||
        update.geometryChanged ||
        update.viewportChanged ||
        update.focusChanged ||
        update.startState.field(this.field) !== update.state.field(this.field))
    ) {
      this.updateNativeCodeSelection()
    }
  }

  docViewUpdate() {
    const { state } = this.view
    const value = state.field(this.field)
    for (const element of this.view.contentDOM.querySelectorAll<HTMLElement>(
      ".cm-md-code-block"
    )) {
      // BlockWrapper owns this element's declared attributes and restores its
      // seed attribute set during document-view reconciliation. Reapply the
      // transient pointer marker here so an active drag survives geometry and
      // selection redraws until the real pointer-end lifecycle clears it.
      element.toggleAttribute(
        "data-code-pointer-selecting",
        element === this.pointerBlock
      )
      const anchor = element.querySelector<HTMLElement>(".cm-line") ?? element
      let position: number
      try {
        position = this.view.posAtDOM(anchor, 0)
      } catch {
        continue
      }
      const block = blockContainingPosition(state, value.blockIndex, position)
      element.dataset.codeWrap = String(
        block != null && value.wraps.get(block.from)?.wrapped === true
      )
    }
  }

  private build(view: EditorView) {
    const value = view.state.field(this.field)
    const blocks = blocksInRanges(
      view.state,
      value.blockIndex,
      view.visibleRanges
    )
    return buildCodeBlockDecorations(view.state, blocks, view.visibleRanges)
  }

  private selectionHeadBlock() {
    const { state } = this.view
    if (state.selection.ranges.length !== 1) return null
    const block = codeBlockElementAt(this.view, state.selection.main.head)
    return block && block.scrollWidth > block.clientWidth ? block : null
  }

  private selectionUsesNativeRendering() {
    const { state } = this.view
    if (state.selection.ranges.length !== 1) return false
    const selection = state.selection.main
    // CodeMirror's drawn caret remains authoritative for collapsed
    // selections. Its content DOM is virtualized, so the browser selection
    // can briefly point into stale/replaced DOM after a large edit even when
    // the state selection is already correct.
    if (selection.empty) return false
    if (
      !this.view.visibleRanges.some(
        (range) => range.from <= selection.from && range.to >= selection.to
      )
    ) {
      return false
    }

    const codeState = state.field(this.field)
    const selectedBlocks = blocksInRanges(state, codeState.blockIndex, [
      { from: selection.from, to: selection.to },
    ])
    return selectedBlocks.some((block) => {
      if (
        codeState.wraps.get(block.from)?.wrapped === true ||
        selection.from >= block.to ||
        selection.to <= block.from
      ) {
        return false
      }
      const element = codeBlockElementAt(
        this.view,
        Math.min(block.to, block.openingLineFrom + 1)
      )
      return element != null && element.scrollWidth > element.clientWidth
    })
  }

  private updateNativeCodeSelection() {
    const useNativeRendering = this.selectionUsesNativeRendering()
    this.view.dom.toggleAttribute(
      "data-code-native-selection",
      useNativeRendering
    )
    // Nested horizontal scrolling is still needed for CodeMirror's drawn
    // caret. It is independent of whether a mounted text selection can use
    // native painting.
    if (this.selectionHeadBlock()) {
      this.view.requestMeasure(this.revealSelectionMeasure)
    }
  }

  private readonly revealSelectionMeasure = {
    key: this,
    read: (view: EditorView) => {
      const activeBlock = this.selectionHeadBlock()
      const measurement = codeSelectionHeadMeasurement(view)
      return activeBlock && measurement?.block === activeBlock
        ? measurement
        : null
    },
    write: (
      measurement: { block: HTMLElement; scrollLeft: number } | null,
      view: EditorView
    ) => {
      if (!measurement) return
      const { block, scrollLeft } = measurement
      const previousScrollLeft = block.scrollLeft
      block.scrollLeft = scrollLeft
      if (Math.abs(block.scrollLeft - previousScrollLeft) >= 0.5) {
        view.requestMeasure(this.revealSelectionMeasure)
        if (!view.dom.hasAttribute("data-code-native-selection")) {
          this.queueDrawnSelectionRefresh()
        }
      }
    },
  }

  private queueDrawnSelectionRefresh() {
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    const refresh = () => {
      this.selectionRefreshFrame = null
      this.refreshingDrawnSelection = true
      try {
        this.view.dispatch({ selection: this.view.state.selection })
      } finally {
        this.refreshingDrawnSelection = false
      }
    }
    if (!ownerWindow) {
      refresh()
      return
    }
    if (this.selectionRefreshFrame != null) {
      ownerWindow.cancelAnimationFrame(this.selectionRefreshFrame)
    }
    this.selectionRefreshFrame = ownerWindow.requestAnimationFrame(refresh)
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return
    const target = event.target
    const block =
      target instanceof Element
        ? target.closest<HTMLElement>(".cm-md-code-block")
        : null
    if (
      !block ||
      (target instanceof Element && target.closest(".cm-md-code-tool"))
    ) {
      return
    }

    this.clearPointerBlock()
    this.pointerBlock = block
    this.pointerId = event.pointerId
    block.dataset.codePointerSelecting = "true"
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    ownerWindow?.addEventListener("pointerup", this.handlePointerEnd, true)
    ownerWindow?.addEventListener("pointercancel", this.handlePointerEnd, true)
    ownerWindow?.addEventListener("blur", this.handlePointerWindowBlur, true)
  }

  private readonly handlePointerEnd = (event: PointerEvent) => {
    if (this.pointerId != null && event.pointerId !== this.pointerId) return
    this.clearPointerBlock()
  }

  private readonly handlePointerWindowBlur = () => this.clearPointerBlock()

  private clearPointerBlock() {
    if (this.pointerBlock) {
      delete this.pointerBlock.dataset.codePointerSelecting
    }
    this.pointerBlock = null
    this.pointerId = null
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    ownerWindow?.removeEventListener("pointerup", this.handlePointerEnd, true)
    ownerWindow?.removeEventListener(
      "pointercancel",
      this.handlePointerEnd,
      true
    )
    ownerWindow?.removeEventListener("blur", this.handlePointerWindowBlur, true)
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    const target = event.target
    if (
      event.button !== 0 ||
      event.detail !== 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      this.view.state.selection.ranges.length !== 1
    ) {
      return
    }
    const block =
      target instanceof Element
        ? target.closest<HTMLElement>(
            '.cm-md-code-block[data-code-wrap="false"]'
          )
        : null
    if (
      !block ||
      (target instanceof Element && target.closest(".cm-md-code-tool")) ||
      block.scrollWidth <= block.clientWidth
    ) {
      return
    }

    const position = this.view.posAndSideAtCoords(
      { x: event.clientX, y: event.clientY },
      false
    ).pos
    const selection = this.view.state.selection.main
    if (
      !selection.empty &&
      position >= selection.from &&
      position <= selection.to
    ) {
      return
    }

    this.stopDrag()
    this.drag = {
      anchor: null,
      block,
      clientX: event.clientX,
      clientY: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      timer: null,
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    ownerWindow?.addEventListener("mousemove", this.handleMouseMove, true)
    ownerWindow?.addEventListener("mouseup", this.handleMouseUp, true)
    ownerWindow?.addEventListener("blur", this.handleWindowBlur)
  }

  private readonly handleMouseMove = (event: MouseEvent) => {
    const drag = this.drag
    if (!drag) return
    if ((event.buttons & 1) === 0) {
      this.stopDrag()
      return
    }
    drag.clientX = event.clientX
    drag.clientY = event.clientY
    if (drag.anchor == null) {
      const distance = Math.max(
        Math.abs(event.clientX - drag.downX),
        Math.abs(event.clientY - drag.downY)
      )
      if (distance < 10) return
      if (this.view.state.selection.ranges.length !== 1) {
        this.stopDrag()
        return
      }
      drag.anchor = this.view.state.selection.main.anchor
    }
    const bounds = drag.block.getBoundingClientRect()
    const outside =
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom &&
      (event.clientX < bounds.left || event.clientX > bounds.right)
    if (outside && drag.timer == null) {
      const ownerWindow = this.view.dom.ownerDocument.defaultView
      drag.timer = ownerWindow?.setInterval(this.advanceEdgeDrag, 50) ?? null
    } else if (!outside && drag.timer != null) {
      this.clearDragTimer(drag)
    }
  }

  private readonly advanceEdgeDrag = () => {
    const drag = this.drag
    if (
      !drag ||
      drag.anchor == null ||
      !drag.block.isConnected ||
      drag.block.dataset.codeWrap !== "false"
    ) {
      this.stopDrag()
      return
    }

    const bounds = drag.block.getBoundingClientRect()
    if (drag.clientY < bounds.top || drag.clientY > bounds.bottom) {
      this.clearDragTimer(drag)
      return
    }
    const direction =
      drag.clientX < bounds.left ? -1 : drag.clientX > bounds.right ? 1 : 0
    if (direction === 0) {
      this.clearDragTimer(drag)
      return
    }
    const overshoot =
      direction < 0 ? bounds.left - drag.clientX : drag.clientX - bounds.right
    const distance = 8 + 0.7 * Math.max(0, overshoot)
    const previousScrollLeft = drag.block.scrollLeft
    drag.block.scrollLeft += direction * distance

    const x = direction < 0 ? bounds.left + 4 : bounds.right - 4
    const head = this.view.posAndSideAtCoords({ x, y: drag.clientY }, false)
    const range = EditorSelection.range(
      drag.anchor,
      head.pos,
      undefined,
      undefined,
      head.assoc
    )
    const selection = EditorSelection.create([range])
    if (!selection.eq(this.view.state.selection, true)) {
      this.view.dispatch({ selection, userEvent: "select.pointer" })
    }
    if (drag.block.scrollLeft === previousScrollLeft) {
      this.clearDragTimer(drag)
    }
  }

  private clearDragTimer(drag: NonNullable<typeof this.drag>) {
    if (drag.timer == null) return
    this.view.dom.ownerDocument.defaultView?.clearInterval(drag.timer)
    drag.timer = null
  }

  private readonly handleMouseUp = () => this.stopDrag()
  private readonly handleWindowBlur = () => this.stopDrag()

  private stopDrag() {
    const drag = this.drag
    if (drag) this.clearDragTimer(drag)
    this.drag = undefined
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    ownerWindow?.removeEventListener("mousemove", this.handleMouseMove, true)
    ownerWindow?.removeEventListener("mouseup", this.handleMouseUp, true)
    ownerWindow?.removeEventListener("blur", this.handleWindowBlur)
  }

  private readonly handleNestedScroll = (event: Event) => {
    const target = event.target
    if (
      !(target instanceof HTMLElement) ||
      !target.classList.contains("cm-md-code-block")
    ) {
      return
    }
    if (!this.view.dom.hasAttribute("data-code-native-selection")) {
      this.queueDrawnSelectionRefresh()
    }
  }

  destroy() {
    this.clearPointerBlock()
    this.stopDrag()
    if (this.selectionRefreshFrame != null) {
      this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(
        this.selectionRefreshFrame
      )
      this.selectionRefreshFrame = null
    }
    this.view.dom.removeAttribute("data-code-native-selection")
    this.view.dom.removeEventListener("scroll", this.handleNestedScroll, true)
    this.view.dom.removeEventListener("mousedown", this.handleMouseDown, true)
    this.view.dom.removeEventListener(
      "pointerdown",
      this.handlePointerDown,
      true
    )
  }
}

function textBoundaryX(
  range: globalThis.Range,
  text: Text,
  index: number,
  rightToLeft: boolean
) {
  range.setStart(text, index)
  range.collapse(true)
  const caret = range.getBoundingClientRect()
  if (caret.height > 0 || caret.x !== 0 || caret.y !== 0) return caret.x

  const character = Math.min(text.length - 1, Math.max(0, index))
  range.setStart(text, character)
  range.setEnd(text, character + 1)
  const bounds = range.getBoundingClientRect()
  if (index === text.length) return rightToLeft ? bounds.left : bounds.right
  return rightToLeft ? bounds.right : bounds.left
}

function nearestTextBoundary(element: HTMLElement, clientX: number) {
  const text = element.firstChild
  if (!(text instanceof Text) || !text.data) return 0
  const range = element.ownerDocument.createRange()
  const rightToLeft =
    element.ownerDocument.defaultView?.getComputedStyle(element).direction ===
    "rtl"
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const x = textBoundaryX(range, text, middle, rightToLeft)
    if (rightToLeft ? x > clientX : x < clientX) low = middle + 1
    else high = middle
  }
  const source = text.data
  const following =
    low <= 0
      ? 0
      : low >= source.length
        ? source.length
        : findClusterBreak(source, low - 1, true)
  const preceding =
    following <= 0 ? 0 : findClusterBreak(source, following, false)
  const precedingDistance = Math.abs(
    textBoundaryX(range, text, preceding, rightToLeft) - clientX
  )
  const followingDistance = Math.abs(
    textBoundaryX(range, text, following, rightToLeft) - clientX
  )
  return precedingDistance <= followingDistance ? preceding : following
}

function codeFenceSourcePositionAtX(
  view: EditorView,
  target: Element,
  block: FencedCodeBlock,
  clientX: number,
  languageReferenceLeft: number | null
) {
  const line = view.state.doc.lineAt(block.openingLineFrom)
  const language = target.closest<HTMLElement>(".cm-md-code-language")
  if (
    language &&
    block.infoFrom != null &&
    block.infoTo != null &&
    block.infoTo > block.infoFrom
  ) {
    const currentLeft = language.getBoundingClientRect().left
    const layoutX =
      languageReferenceLeft == null
        ? clientX
        : clientX + currentLeft - languageReferenceLeft
    const boundary = Math.min(
      block.infoTo - block.infoFrom,
      nearestTextBoundary(language, layoutX)
    )
    return block.infoFrom + boundary
  }

  const lineElement = target.closest<HTMLElement>(".cm-line")
  if (!lineElement) return line.from
  const bounds = lineElement.getBoundingClientRect()
  const style =
    lineElement.ownerDocument.defaultView?.getComputedStyle(lineElement)
  const scale = view.scaleX
  const paddingLeft =
    (Number.parseFloat(style?.paddingLeft ?? "0") || 0) * scale
  const paddingRight =
    (Number.parseFloat(style?.paddingRight ?? "0") || 0) * scale
  const textIndent = (Number.parseFloat(style?.textIndent ?? "0") || 0) * scale
  const characterWidth = Math.max(1, view.defaultCharacterWidth * scale)
  const offset =
    style?.direction === "rtl"
      ? Math.round(
          (bounds.right - paddingRight - textIndent - clientX) / characterWidth
        )
      : Math.round(
          (clientX - bounds.left - paddingLeft - textIndent) / characterWidth
        )
  return line.from + Math.max(0, Math.min(line.length, offset))
}

function adjacentCodeFenceClusterPosition(
  view: EditorView,
  target: Element,
  block: FencedCodeBlock,
  position: number,
  direction: -1 | 1
) {
  const language = target.closest(".cm-md-code-language")
  const openingLine = view.state.doc.lineAt(block.openingLineFrom)
  const from =
    language && block.infoFrom != null ? block.infoFrom : openingLine.from
  const to = language && block.infoTo != null ? block.infoTo : openingLine.to
  const source = view.state.sliceDoc(from, to)
  const offset = Math.max(0, Math.min(source.length, position - from))
  return from + findClusterBreak(source, offset, direction > 0)
}

function fencedBlockForBoundaryLine(
  state: EditorState,
  index: RangeSet<IndexedCodeBlock>,
  position: number,
  openingBoundary: boolean,
  closingBoundary: boolean
) {
  const line = state.doc.lineAt(position)
  return blocksInRanges(state, index, [
    {
      from: line.from,
      to: Math.min(state.doc.length, line.to + 1),
    },
  ]).find((block) => {
    if (block.kind !== "fenced") return false
    if (openingBoundary && block.openingLineFrom === line.from) return true
    if (!closingBoundary || !block.closed) return false
    return (
      state.doc.lineAt(Math.max(block.from, block.to - 1)).number ===
      line.number
    )
  })
}

export function codeFenceBoundaryClickSelection(
  startSelection: EditorSelection,
  boundaryEnd: number,
  extend: boolean,
  multiple: boolean
) {
  const range = EditorSelection.cursor(boundaryEnd, -1)
  if (extend) {
    return startSelection.replaceRange(
      startSelection.main.extend(range.from, range.to, range.assoc)
    )
  }
  return multiple
    ? startSelection.addRange(range)
    : EditorSelection.create([range])
}

function clampPositionToDOMLine(
  view: EditorView,
  line: HTMLElement | null,
  position: number
) {
  if (!line) return position
  try {
    const first = view.posAtDOM(line, 0)
    const last = view.posAtDOM(line, line.childNodes.length)
    return Math.min(
      Math.max(first, last),
      Math.max(Math.min(first, last), position)
    )
  } catch {
    // Keep CodeMirror's coordinate result when the row was just replaced.
    return position
  }
}

function fencedContentBoundarySourcePosition(
  view: EditorView,
  index: RangeSet<IndexedCodeBlock>,
  boundary: HTMLElement,
  opening: boolean
) {
  let boundaryPosition: number
  try {
    boundaryPosition = view.posAtDOM(boundary, 0)
  } catch {
    return null
  }
  const block = fencedBlockForBoundaryLine(
    view.state,
    index,
    boundaryPosition,
    opening,
    !opening
  )
  if (!block) return null
  // CodeText starts after any quote/list prefix hidden by live preview. For
  // an empty fence, the point immediately after the opener is the only
  // zero-width rendered-content boundary available.
  const firstContent = block.codeText[0]?.from ?? block.toolAnchor
  const lastContent = block.codeText.at(-1)?.to ?? block.toolAnchor
  return opening
    ? ({ assoc: 1, pos: firstContent } as const)
    : ({ assoc: -1, pos: lastContent } as const)
}

function fencedContentBoundaryAtPointer(
  view: EditorView,
  index: RangeSet<IndexedCodeBlock>,
  event: MouseEvent
) {
  for (const target of view.dom.ownerDocument.elementsFromPoint(
    event.clientX,
    event.clientY
  )) {
    const opening = target.closest<HTMLElement>(".cm-md-code-tools-line")
    const closing = target.closest<HTMLElement>(
      ".cm-md-code-line-last:not(.cm-md-code-content-line)"
    )
    const boundary = opening ?? closing
    const element = target.closest<HTMLElement>(".cm-md-code-block")
    if (!boundary || !element || boundary.parentElement !== element) continue
    const source = fencedContentBoundarySourcePosition(
      view,
      index,
      boundary,
      opening != null
    )
    if (source) return source
  }
  return null
}

function codeFenceMouseSelectionStyle(
  view: EditorView,
  event: MouseEvent,
  field: StateField<CodeBlockState>
) {
  const target = event.target
  const openingBoundary =
    target instanceof Element &&
    (target.closest(".cm-md-code-tools-line") != null ||
      target.closest(".cm-md-code-language") != null)
  const closingBoundary =
    target instanceof Element &&
    target.closest(".cm-md-code-line-last:not(.cm-md-code-content-line)") !=
      null
  const contentOrigin =
    target instanceof Element &&
    target.closest(".cm-md-code-content-line") != null &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  if (
    event.button !== 0 ||
    event.detail !== 1 ||
    !(target instanceof Element) ||
    target.closest(".cm-md-code-tool") ||
    (!openingBoundary && !closingBoundary && !contentOrigin)
  ) {
    return null
  }

  const boundaryLine = target.closest<HTMLElement>(".cm-line")
  const start = view.posAndSideAtCoords(
    { x: event.clientX, y: event.clientY },
    false
  )
  // A block wrapper can make coordinate mapping prefer the adjacent line
  // even though hit testing reached this exact fence row. Preserve the
  // horizontal result when it belongs to the row and otherwise clamp it to
  // the row's source range.
  start.pos = clampPositionToDOMLine(view, boundaryLine, start.pos)
  const startCoordinates = { x: event.clientX, y: event.clientY }
  const blockIndex = view.state.field(field).blockIndex
  const initialBlock = contentOrigin
    ? blockContainingPosition(view.state, blockIndex, start.pos)
    : fencedBlockForBoundaryLine(
        view.state,
        blockIndex,
        start.pos,
        openingBoundary,
        closingBoundary
      )
  if (initialBlock?.kind !== "fenced") return null
  if (!target.closest<HTMLElement>(".cm-md-code-block")) return null
  const initialLastLine = view.state.doc.lineAt(
    Math.max(initialBlock.from, initialBlock.to - 1)
  )
  if (
    closingBoundary &&
    (!initialBlock.closed ||
      view.state.doc.lineAt(start.pos).number !== initialLastLine.number)
  ) {
    return null
  }
  const languageReferenceLeft =
    target.closest<HTMLElement>(".cm-md-code-language")?.getBoundingClientRect()
      .left ?? null
  const headerLine =
    boundaryLine ??
    target
      .closest<HTMLElement>(".cm-md-code-block")
      ?.querySelector<HTMLElement>(".cm-md-code-tools-line") ??
    null
  let startSelection = view.state.selection
  return {
    update(update: ViewUpdate) {
      if (!update.docChanged) return
      start.pos = update.changes.mapPos(start.pos, start.assoc)
      startSelection = startSelection.map(update.changes)
    },
    get(currentEvent: MouseEvent, extend: boolean, multiple: boolean) {
      const pointerDistance = Math.hypot(
        currentEvent.clientX - startCoordinates.x,
        currentEvent.clientY - startCoordinates.y
      )
      if (contentOrigin && pointerDistance === 0) {
        const range = EditorSelection.cursor(start.pos, start.assoc)
        return EditorSelection.create([range])
      }
      const contentBoundary = contentOrigin
        ? fencedContentBoundaryAtPointer(
            view,
            view.state.field(field).blockIndex,
            currentEvent
          )
        : null
      const current = {
        ...(contentBoundary ??
          view.posAndSideAtCoords(
            { x: currentEvent.clientX, y: currentEvent.clientY },
            false
          )),
      }
      if (contentOrigin) {
        if (current.pos === start.pos) {
          const range = EditorSelection.cursor(start.pos, start.assoc)
          return EditorSelection.create([range])
        }
        const range = EditorSelection.range(
          start.pos,
          current.pos,
          undefined,
          undefined,
          current.assoc
        )
        if (extend) {
          return startSelection.replaceRange(
            startSelection.main.extend(range.from, range.to, range.assoc)
          )
        }
        return multiple
          ? startSelection.addRange(range)
          : EditorSelection.create([range])
      }

      const boundaryBounds = boundaryLine?.getBoundingClientRect()
      if (
        boundaryBounds &&
        currentEvent.clientX >= boundaryBounds.left &&
        currentEvent.clientX <= boundaryBounds.right &&
        currentEvent.clientY >= boundaryBounds.top &&
        currentEvent.clientY <= boundaryBounds.bottom
      ) {
        current.pos = clampPositionToDOMLine(view, boundaryLine, current.pos)
      }
      const pointerMoved = pointerDistance > 10
      const horizontalDirection = Math.sign(
        currentEvent.clientX - startCoordinates.x
      )
      const headerBounds = openingBoundary
        ? headerLine?.getBoundingClientRect()
        : null
      const proportionalHeaderDrag =
        openingBoundary &&
        pointerMoved &&
        horizontalDirection !== 0 &&
        headerBounds != null &&
        currentEvent.clientY >= headerBounds.top &&
        currentEvent.clientY <= headerBounds.bottom
      const currentBlock = blockContainingPosition(
        view.state,
        view.state.field(field).blockIndex,
        start.pos
      )
      const fencedBlock =
        currentBlock?.kind === "fenced" ? currentBlock : initialBlock
      const boundaryEnd = openingBoundary
        ? view.state.doc.lineAt(fencedBlock.openingLineFrom).to
        : view.state.doc.lineAt(Math.max(fencedBlock.from, fencedBlock.to - 1))
            .to
      const proportionalStart = proportionalHeaderDrag
        ? codeFenceSourcePositionAtX(
            view,
            target,
            fencedBlock,
            startCoordinates.x,
            languageReferenceLeft
          )
        : start.pos
      let proportionalCurrent = proportionalHeaderDrag
        ? codeFenceSourcePositionAtX(
            view,
            target,
            fencedBlock,
            currentEvent.clientX,
            languageReferenceLeft
          )
        : current.pos
      if (proportionalHeaderDrag && proportionalCurrent === proportionalStart) {
        proportionalCurrent = adjacentCodeFenceClusterPosition(
          view,
          target,
          fencedBlock,
          proportionalStart,
          horizontalDirection as -1 | 1
        )
      }
      if (!pointerMoved) {
        return codeFenceBoundaryClickSelection(
          startSelection,
          boundaryEnd,
          extend,
          multiple
        )
      }
      const range = EditorSelection.range(
        proportionalStart,
        proportionalCurrent,
        undefined,
        undefined,
        current.assoc
      )
      if (extend) {
        return startSelection.replaceRange(
          startSelection.main.extend(range.from, range.to, range.assoc)
        )
      }
      return multiple
        ? startSelection.addRange(range)
        : EditorSelection.create([range])
    },
  }
}

/** Adds Markdown code-card wrappers, stable controls, and viewport-limited line UI. */
export function codeBlockExtension(
  options: CodeBlockExtensionOptions = {}
): Extension {
  const include = options.include ?? (() => true)
  const includeBlock = (state: EditorState, block: MarkdownCodeBlock) =>
    block.kind === "indented" || include(state, block)
  const field: StateField<CodeBlockState> = StateField.define<CodeBlockState>({
    create(state) {
      const tree = completeMarkdownSyntaxTree(state)
      const allBlocks = analyzeMarkdownCodeBlocks(state, tree)
      const blocks = allBlocks.filter((block) => includeBlock(state, block))
      const wraps = new Map<number, CodeWrapOverride>()
      return {
        allBlockIndex: buildCodeBlockIndex(allBlocks),
        blockIndex: buildCodeBlockIndex(blocks),
        filterKey: options.filterKey?.(state),
        tree,
        wraps,
        wrappers: buildCodeBlockWrappers(blocks),
        tools: buildCodeBlockTools(blocks, wraps, field),
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
      const hasWrapEffect = transaction.effects.some((effect) =>
        effect.is(setCodeBlockWrapped)
      )
      if (
        !syntaxChanged &&
        !hasWrapEffect &&
        preservePreviewDuringPointerSelection(transaction)
      ) {
        return value
      }
      const filterKey = options.filterKey?.(transaction.state)
      const filterChanged = !Object.is(filterKey, value.filterKey)
      if (
        !transaction.docChanged &&
        !syntaxChanged &&
        !hasWrapEffect &&
        !filterChanged
      ) {
        return value
      }

      let allBlockIndex = value.allBlockIndex
      let blockIndex = value.blockIndex
      let wrappers = value.wrappers
      let tools = value.tools
      let refreshRanges: readonly DocumentRange[] = []
      let allFreshBlocks: readonly MarkdownCodeBlock[] = []
      const tree = transaction.docChanged
        ? updateCompleteMarkdownSyntaxTree(
            transaction.state,
            transaction.changes,
            value.tree
          )
        : syntaxChanged
          ? completeTreeAfterSyntaxChange!
          : value.tree

      if (transaction.docChanged) {
        const rebuildCompleteIndex = markdownBlockPairingMayChange(transaction)
        refreshRanges = rebuildCompleteIndex
          ? [{ from: 0, to: transaction.state.doc.length }]
          : expandSyntaxRangesThroughMappedBlocks(
              transaction.state,
              tree,
              value.allBlockIndex.map(transaction.changes),
              changedSyntaxRanges(transaction, value.tree, tree)
            )
        allFreshBlocks = analyzeMarkdownCodeBlocksInRanges(
          transaction.state,
          refreshRanges,
          tree
        )
        allBlockIndex = rebuildCompleteIndex
          ? buildCodeBlockIndex(allFreshBlocks)
          : refreshCodeBlockIndex(
              value.allBlockIndex,
              transaction,
              refreshRanges,
              allFreshBlocks
            ).blockIndex
      } else if (syntaxChanged) {
        allFreshBlocks = analyzeMarkdownCodeBlocks(transaction.state, tree)
        allBlockIndex = buildCodeBlockIndex(allFreshBlocks)
      }

      const wraps = updateWraps(value.wraps, allBlockIndex, transaction)

      if (filterChanged) {
        const blocks = blocksInRanges(transaction.state, allBlockIndex, [
          { from: 0, to: transaction.state.doc.length },
        ]).filter((block) => includeBlock(transaction.state, block))
        blockIndex = buildCodeBlockIndex(blocks)
        wrappers = buildCodeBlockWrappers(blocks)
        tools = buildCodeBlockTools(blocks, wraps, field)
      } else if (transaction.docChanged) {
        const freshBlocks = allFreshBlocks.filter((block) =>
          includeBlock(transaction.state, block)
        )
        const rebuildCompleteIndex = markdownBlockPairingMayChange(transaction)
        if (rebuildCompleteIndex) {
          blockIndex = buildCodeBlockIndex(freshBlocks)
          wrappers = buildCodeBlockWrappers(freshBlocks)
          tools = buildCodeBlockTools(freshBlocks, wraps, field)
        } else {
          blockIndex = refreshCodeBlockIndex(
            value.blockIndex,
            transaction,
            refreshRanges,
            freshBlocks
          ).blockIndex
          wrappers = refreshCodeBlockWrappers(
            value.wrappers,
            transaction,
            refreshRanges,
            freshBlocks
          )
          tools = refreshCodeBlockTools(
            value.tools,
            transaction,
            refreshRanges,
            freshBlocks,
            wraps,
            field
          )
        }
      } else if (syntaxChanged) {
        const freshBlocks = allFreshBlocks.filter((block) =>
          includeBlock(transaction.state, block)
        )
        blockIndex = buildCodeBlockIndex(freshBlocks)
        wrappers = buildCodeBlockWrappers(freshBlocks)
        tools = buildCodeBlockTools(freshBlocks, wraps, field)
      }

      if (hasWrapEffect && !filterChanged) {
        tools = buildCodeBlockTools(
          blocksInRanges(transaction.state, blockIndex, [
            { from: 0, to: transaction.state.doc.length },
          ]),
          wraps,
          field
        )
      }

      return {
        allBlockIndex,
        blockIndex,
        filterKey,
        tree,
        wraps,
        wrappers,
        tools,
      }
    },
    provide: (currentField) => [
      EditorView.blockWrappers.from(currentField, (value) => value.wrappers),
      EditorView.decorations.from(currentField, (value) => value.tools),
    ],
  })

  const decorations = ViewPlugin.define(
    (view) => new CodeBlockDecorationPlugin(view, field),
    { decorations: (plugin) => plugin.decorations }
  )

  const boundaryKeys = Prec.highest(
    keymap.of([
      {
        mac: "Cmd-ArrowLeft",
        run: (view) =>
          moveCodeSelectionToLineBoundary(view, field, false, false),
        shift: (view) =>
          moveCodeSelectionToLineBoundary(view, field, false, true),
      },
      {
        mac: "Cmd-ArrowRight",
        run: (view) =>
          moveCodeSelectionToLineBoundary(view, field, true, false),
        shift: (view) =>
          moveCodeSelectionToLineBoundary(view, field, true, true),
      },
    ])
  )

  return [
    Prec.highest(
      EditorView.mouseSelectionStyle.of((view, event) =>
        codeFenceMouseSelectionStyle(view, event, field)
      )
    ),
    Prec.high(field),
    Prec.high(decorations),
    boundaryKeys,
  ]
}
