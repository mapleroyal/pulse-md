import { syntaxTree } from "@codemirror/language"
import {
  countColumn,
  RangeSet,
  RangeValue,
  StateField,
  type EditorSelection,
  type EditorState,
  type Range,
  type Transaction,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view"
import type { SyntaxNode, Tree } from "@lezer/common"

import { calloutEditingRange } from "./callout-blocks"
import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  livePreviewRefreshRequested,
  preservePreviewDuringPointerSelection,
} from "./interactive-preview"

interface DocumentRange {
  from: number
  to: number
}

export interface InlineCodeReplacement extends DocumentRange {
  text: string
}

export interface InlineCodeNormalization {
  multiline: boolean
  replacements: readonly InlineCodeReplacement[]
}

/** An inline replacement keeps the surrounding source-backed text editable. */
export class MarkdownTextWidget extends WidgetType {
  readonly text: string
  readonly className: string
  readonly collapseWhitespace: boolean

  constructor(text: string, className: string, collapseWhitespace = false) {
    super()
    this.text = text
    this.className = className
    this.collapseWhitespace = collapseWhitespace
  }

  eq(other: MarkdownTextWidget) {
    return (
      this.text === other.text &&
      this.className === other.className &&
      this.collapseWhitespace === other.collapseWhitespace
    )
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span")
    span.className = this.className
    span.textContent = this.text
    // Numeric references can denote a newline or tab. HTML prose collapses
    // these characters; they must not create untracked editor line boxes.
    if (this.collapseWhitespace) span.style.whiteSpace = "normal"
    return span
  }
}

interface Container {
  node: SyntaxNode
  /** Continuation indentation in physical CommonMark columns. */
  indent: number
}

function column(state: EditorState, position: number) {
  const line = state.doc.lineAt(position)
  return countColumn(state.sliceDoc(line.from, position), 4)
}

function whitespaceEnd(state: EditorState, position: number) {
  const line = state.doc.lineAt(position)
  return (
    position +
    (/^[ \t]*/.exec(state.sliceDoc(position, line.to))?.[0].length ?? 0)
  )
}

function quoteMarksOnLine(tree: Tree, from: number, to: number) {
  const marks: DocumentRange[] = []
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === "QuoteMark" && node.from >= from && node.to <= to) {
        marks.push({ from: node.from, to: node.to })
      }
    },
  })
  return marks
}

/**
 * Recover only consumed container markup. Extra authored indentation remains
 * code content, and lazy paragraph continuations need not repeat a container.
 */
function containerPrefix(
  state: EditorState,
  tree: Tree,
  lineNumber: number,
  containers: readonly Container[]
) {
  const line = state.doc.line(lineNumber)
  if (containers.length === 0)
    return { position: line.from, remainingTabSpaces: 0 }
  const quotes = quoteMarksOnLine(tree, line.from, line.to)
  let position = line.from
  let remainingTabSpaces = 0

  for (const { node, indent } of containers) {
    if (node.name === "Blockquote") {
      const quote = quotes.find((mark) => mark.from >= position)
      if (!quote || !/^[ \t]*$/.test(state.sliceDoc(position, quote.from)))
        continue
      position = quote.to
      const next = state.sliceDoc(position, position + 1)
      remainingTabSpaces =
        next === "\t"
          ? column(state, position + 1) - column(state, position) - 1
          : 0
      if (next === " " || next === "\t") position += 1
      continue
    }

    if (state.doc.lineAt(node.from).number === lineNumber) {
      const marker = node.getChild(
        node.name === "ListItem" ? "ListMark" : "DefinitionMark"
      )
      if (marker) position = whitespaceEnd(state, marker.to)
      else if (node.name === "FootnoteDefinition") {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "FootnoteMark") position = child.to
        }
        position = whitespaceEnd(state, position)
      }
      remainingTabSpaces = 0
      continue
    }

    const initial = position
    const target = column(state, position) + indent - remainingTabSpaces
    while (position < line.to && column(state, position) < target) {
      const character = state.sliceDoc(position, position + 1)
      if (character !== " " && character !== "\t") break
      position += 1
    }
    if (column(state, position) < target) {
      // A lazy continuation has no structural indentation to consume.
      position = initial
    } else {
      remainingTabSpaces = Math.max(0, column(state, position) - target)
    }
  }

  return { position, remainingTabSpaces }
}

function codeContainers(state: EditorState, node: SyntaxNode, tree: Tree) {
  const ancestors: SyntaxNode[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.name === "Blockquote" ||
      parent.name === "ListItem" ||
      parent.name === "FootnoteDefinition" ||
      parent.name === "DefinitionDescription"
    ) {
      ancestors.push(parent)
    }
  }

  const containers: Container[] = []
  for (const ancestor of ancestors.reverse()) {
    let indent = 0
    if (ancestor.name === "FootnoteDefinition") indent = 4
    else if (ancestor.name !== "Blockquote") {
      const marker = ancestor.getChild(
        ancestor.name === "ListItem" ? "ListMark" : "DefinitionMark"
      )
      if (marker) {
        const base = containerPrefix(
          state,
          tree,
          state.doc.lineAt(marker.from).number,
          containers
        ).position
        const spacing =
          column(state, whitespaceEnd(state, marker.to)) -
          column(state, marker.to)
        const padding =
          ancestor.name === "ListItem" && (spacing < 1 || spacing > 4)
            ? 1
            : spacing
        indent = column(state, marker.to) - column(state, base) + padding
      }
    }
    containers.push({ node: ancestor, indent })
  }
  return containers
}

/** CommonMark code-span normalization expressed as minimal source replacements. */
export function inlineCodeNormalization(
  state: EditorState,
  node: SyntaxNode,
  tree: Tree = completeMarkdownSyntaxTree(state)
): InlineCodeNormalization {
  const marks = node.getChildren("CodeMark")
  const first = marks[0]
  const last = marks.at(-1)
  if (!first || !last || first === last)
    return { multiline: false, replacements: [] }
  const from = first.to
  const to = last.from
  const firstLine = state.doc.lineAt(from)
  const lastLine = state.doc.lineAt(to)
  const multiline = firstLine.number !== lastLine.number
  const replacements: InlineCodeReplacement[] = []
  if (multiline) {
    const containers = codeContainers(state, node, tree)
    for (
      let lineNumber = firstLine.number + 1;
      lineNumber <= lastLine.number;
      lineNumber++
    ) {
      const line = state.doc.line(lineNumber)
      const prefix = containerPrefix(state, tree, lineNumber, containers)
      replacements.push({
        from: line.from - 1,
        to: Math.min(to, prefix.position),
        text: " ".repeat(1 + prefix.remainingTabSpaces),
      })
    }
  }

  // Most code spans need no padding removal. Inspect only their boundaries
  // before scanning for the special all-spaces exception.
  const leadingReplacement = replacements.find(
    (replacement) => replacement.from === from
  )
  const trailingReplacement = replacements.find(
    (replacement) => replacement.to === to
  )
  const firstCharacter =
    leadingReplacement?.text[0] ?? state.sliceDoc(from, from + 1)
  const lastCharacter =
    trailingReplacement?.text.at(-1) ?? state.sliceDoc(to - 1, to)
  if (firstCharacter !== " " || lastCharacter !== " ") {
    return { multiline, replacements }
  }
  let cursor = from
  let nonSpace = false
  for (const replacement of [...replacements, { from: to, to, text: "" }]) {
    const text = state.doc.iterRange(cursor, replacement.from)
    while (!nonSpace && !text.next().done) nonSpace = /[^ ]/.test(text.value)
    if (nonSpace) break
    cursor = replacement.to
  }
  if (nonSpace) {
    const leading = replacements.find(
      (replacement) => replacement.from === from
    )
    if (leading) leading.text = leading.text.slice(1)
    else replacements.push({ from, to: from + 1, text: "" })
    const trailing = replacements.find((replacement) => replacement.to === to)
    if (trailing) trailing.text = trailing.text.slice(0, -1)
    else replacements.push({ from: to - 1, to, text: "" })
  }
  replacements.sort((left, right) => left.from - right.from)
  return { multiline, replacements }
}

export function inlineCodeReplacementDecoration(
  replacement: InlineCodeReplacement
) {
  return Decoration.replace({
    inclusive: false,
    markdownPreviewKind: "inline-code-normalization",
    ...(replacement.text
      ? { widget: new MarkdownTextWidget(replacement.text, "cm-md-code-space") }
      : {}),
  })
}

class IndexedCodeSpan extends RangeValue {
  readonly replacements: readonly InlineCodeReplacement[]

  constructor(replacements: readonly InlineCodeReplacement[]) {
    super()
    this.replacements = replacements
  }
}

function scanCodeSpans(
  state: EditorState,
  tree: Tree,
  ranges: readonly DocumentRange[]
) {
  const entries: Range<IndexedCodeSpan>[] = []
  const seen = new Set<number>()
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "InlineCode" || seen.has(node.from)) return
        seen.add(node.from)
        if (
          state.doc.lineAt(node.from).number ===
          state.doc.lineAt(node.to).number
        )
          return false
        const normalized = inlineCodeNormalization(state, node.node, tree)
        entries.push(
          new IndexedCodeSpan(
            normalized.replacements.map((replacement) => ({
              ...replacement,
              from: replacement.from - node.from,
              to: replacement.to - node.from,
            }))
          ).range(node.from, node.to)
        )
        return false
      },
    })
  }
  return entries
}

function mergeRanges(ranges: readonly DocumentRange[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: DocumentRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to)
      previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function topLevelRange(state: EditorState, tree: Tree, range: DocumentRange) {
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(range.to)
  let from =
    first.number > 1 ? state.doc.line(first.number - 1).from : first.from
  let to =
    last.number < state.doc.lines ? state.doc.line(last.number + 1).to : last.to
  tree.iterate({
    from,
    to,
    enter(node) {
      if (!node.node.parent || node.node.parent.parent) return
      from = Math.min(from, node.from)
      to = Math.max(to, node.to)
      return false
    },
  })
  return { from, to }
}

function changedCodeRanges(
  transaction: Transaction,
  previousTree: Tree,
  tree: Tree
) {
  if (markdownBlockPairingMayChange(transaction))
    return [{ from: 0, to: transaction.state.doc.length }]
  const ranges: DocumentRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const previous = topLevelRange(transaction.startState, previousTree, {
      from: fromA,
      to: toA,
    })
    ranges.push(
      {
        from: transaction.changes.mapPos(previous.from, -1),
        to: transaction.changes.mapPos(previous.to, 1),
      },
      topLevelRange(transaction.state, tree, { from: fromB, to: toB })
    )
  })
  return mergeRanges(
    mergeRanges(ranges).map((range) =>
      topLevelRange(transaction.state, tree, range)
    )
  )
}

function selectionCodeRanges(
  index: RangeSet<IndexedCodeSpan>,
  selection: EditorSelection,
  active: boolean
) {
  const ranges: DocumentRange[] = []
  for (const range of selection.ranges) {
    if (range.empty && !active) continue
    index.between(range.from, range.to, (from, to) => {
      ranges.push({ from, to })
    })
  }
  return ranges
}

function codeSpanIsActive(
  state: EditorState,
  from: number,
  to: number,
  selectionActive: boolean
) {
  const editing = state.facet(calloutEditingRange)
  if (editing && from >= editing.from && to <= editing.to) return true
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive && range.head >= from && range.head <= to
      : range.from < to && range.to > from
  )
}

interface CodeNormalizationState {
  index: RangeSet<IndexedCodeSpan>
  decorations: DecorationSet
  selection: EditorSelection
  selectionActive: boolean
  tree: Tree
}

function refreshCodeDecorations(
  previous: DecorationSet,
  state: EditorState,
  index: RangeSet<IndexedCodeSpan>,
  ranges: readonly DocumentRange[],
  active: boolean
) {
  let decorations = previous
  const additions: Range<Decoration>[] = []
  const seen = new Set<number>()
  for (const range of ranges) {
    decorations = decorations.update({
      filterFrom: range.from,
      filterTo: range.to,
      filter: (from, to) => to <= range.from || from >= range.to,
    })
    index.between(range.from, range.to, (from, to, span) => {
      if (seen.has(from) || to <= range.from || from >= range.to) return
      seen.add(from)
      if (codeSpanIsActive(state, from, to, active)) return
      for (const replacement of span.replacements) {
        additions.push(
          inlineCodeReplacementDecoration(replacement).range(
            from + replacement.from,
            from + replacement.to
          )
        )
      }
    })
  }
  return additions.length
    ? decorations.update({ add: additions, sort: true })
    : decorations
}

/**
 * Joining physical source lines changes document geometry. These replacements
 * must exist before viewport calculation, including for offscreen code spans.
 */
export function inlineCodeNormalizationExtension(
  selectionIsActive: (state: EditorState) => boolean
) {
  return StateField.define<CodeNormalizationState>({
    create(state) {
      const tree = completeMarkdownSyntaxTree(state)
      const ranges = [{ from: 0, to: state.doc.length }]
      const index = RangeSet.of(scanCodeSpans(state, tree, ranges), true)
      const selectionActive = selectionIsActive(state)
      return {
        index,
        decorations: refreshCodeDecorations(
          Decoration.none,
          state,
          index,
          ranges,
          selectionActive
        ),
        selection: state.selection,
        selectionActive,
        tree,
      }
    },
    update(value, transaction) {
      const state = transaction.state
      const tree = transaction.docChanged
        ? updateCompleteMarkdownSyntaxTree(
            state,
            transaction.changes,
            value.tree
          )
        : transaction.reconfigured ||
            syntaxTree(transaction.startState) !== syntaxTree(state)
          ? completeMarkdownSyntaxTree(state)
          : value.tree
      const syntaxChanged = tree !== value.tree
      if (!syntaxChanged && preservePreviewDuringPointerSelection(transaction))
        return value
      const active = selectionIsActive(state)
      const editing = state.facet(calloutEditingRange)
      const previousEditing = transaction.startState.facet(calloutEditingRange)
      const editingChanged =
        editing?.from !== previousEditing?.from ||
        editing?.to !== previousEditing?.to
      const selectionChanged =
        active !== value.selectionActive || !state.selection.eq(value.selection)
      const requested = livePreviewRefreshRequested(transaction)
      if (!syntaxChanged && !selectionChanged && !editingChanged && !requested)
        return value

      let index = transaction.docChanged
        ? value.index.map(transaction.changes)
        : value.index
      let decorations = transaction.docChanged
        ? value.decorations.map(transaction.changes)
        : value.decorations
      const ranges: DocumentRange[] = []
      if (syntaxChanged) {
        const changed = transaction.docChanged
          ? changedCodeRanges(transaction, value.tree, tree)
          : [{ from: 0, to: state.doc.length }]
        for (const range of changed) {
          index = index.update({
            filterFrom: range.from,
            filterTo: range.to,
            filter: (from, to) => to <= range.from || from >= range.to,
          })
        }
        index = index.update({
          add: scanCodeSpans(state, tree, changed),
          sort: true,
        })
        ranges.push(...changed)
      }
      if (selectionChanged || requested) {
        ranges.push(
          ...selectionCodeRanges(
            value.index,
            value.selection,
            value.selectionActive
          ).map((range) => ({
            from: transaction.changes.mapPos(range.from, -1),
            to: transaction.changes.mapPos(range.to, 1),
          })),
          ...selectionCodeRanges(index, state.selection, active)
        )
      }
      if (editingChanged) {
        if (previousEditing)
          ranges.push({
            from: transaction.changes.mapPos(previousEditing.from, -1),
            to: transaction.changes.mapPos(previousEditing.to, 1),
          })
        if (editing) ranges.push(editing)
      }
      decorations = refreshCodeDecorations(
        decorations,
        state,
        index,
        mergeRanges(ranges),
        active
      )
      return {
        index,
        decorations,
        selection: state.selection,
        selectionActive: active,
        tree,
      }
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  })
}
