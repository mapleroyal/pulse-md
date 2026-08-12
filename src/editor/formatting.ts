import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { EditorView, type KeyBinding } from "@codemirror/view"

import { completeMarkdownSyntaxTree } from "./complete-markdown-tree"
import {
  listMarkerPrefixLength,
  parseOrderedListMarker,
  parsePotentialOrderedListMarker,
} from "./list-markers"
import { markdownContainerPrefix, sourceColumnWidth } from "./markdown-prefix"
import {
  normalizeTransformedListMarkerPadding,
  shiftTransformedListLineIndentation,
} from "./list-editing"
import { markdownLinkLikeSource } from "./input-wrapping"

export type MarkdownHeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type MarkdownFormattingCommand =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "strikethrough" }
  | { type: "inline-code" }
  | { type: "link" }
  | { type: "image" }
  | { type: "heading"; level: MarkdownHeadingLevel }
  | { type: "bullet-list" }
  | { type: "ordered-list" }
  | { type: "task-list" }
  | { type: "blockquote" }
  | { type: "code-block"; language?: string }
  | { type: "horizontal-rule" }
  | { type: "table"; columns: number; rows: number }

function directedRange(range: SelectionRange, from: number, to: number) {
  return range.anchor <= range.head
    ? EditorSelection.range(from, to)
    : EditorSelection.range(to, from)
}

function repeatedBefore(
  state: EditorState,
  position: number,
  character: string
) {
  let count = 0
  while (
    position - count - 1 >= 0 &&
    state.sliceDoc(position - count - 1, position - count) === character
  ) {
    count += 1
  }
  return count
}

function repeatedAfter(
  state: EditorState,
  position: number,
  character: string
) {
  let count = 0
  while (
    position + count < state.doc.length &&
    state.sliceDoc(position + count, position + count + 1) === character
  ) {
    count += 1
  }
  return count
}

function removableMarkerLength(
  marker: string,
  beforeCount: number,
  afterCount: number
) {
  const matched = Math.min(beforeCount, afterCount)
  if (marker === "*") return matched === 1 || matched >= 3 ? 1 : 0
  return matched >= marker.length ? marker.length : 0
}

function removableContainedMarkerLength(marker: string, source: string) {
  if (source.length < marker.length * 2) return 0
  if (marker !== "*") {
    return source.startsWith(marker) && source.endsWith(marker)
      ? marker.length
      : 0
  }

  const start = /^\*+/.exec(source)?.[0].length ?? 0
  const end = /\*+$/.exec(source)?.[0].length ?? 0
  const matched = Math.min(start, end)
  return matched === 1 || matched >= 3 ? 1 : 0
}

function toggleSymmetricMarker(view: EditorView, marker: string) {
  const { state } = view
  const character = marker[0]!
  const transaction = state.changeByRange((range) => {
    const source = state.sliceDoc(range.from, range.to)
    const contained = removableContainedMarkerLength(marker, source)
    if (contained > 0) {
      const inner = source.slice(contained, source.length - contained)
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: directedRange(range, range.from, range.from + inner.length),
      }
    }

    const remove = removableMarkerLength(
      marker,
      repeatedBefore(state, range.from, character),
      repeatedAfter(state, range.to, character)
    )
    if (remove > 0) {
      return {
        changes: [
          { from: range.from - remove, to: range.from },
          { from: range.to, to: range.to + remove },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.head - remove)
          : directedRange(range, range.from - remove, range.to - remove),
      }
    }

    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.head + marker.length)
        : EditorSelection.range(
            range.anchor + marker.length,
            range.head + marker.length
          ),
    }
  })

  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input.type",
    })
  )
  return true
}

function longestRun(source: string, character: string) {
  let longest = 0
  let current = 0
  for (const candidate of source) {
    if (candidate === character) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

function toggleInlineCode(view: EditorView) {
  const { state } = view
  const transaction = state.changeByRange((range) => {
    const before = repeatedBefore(state, range.from, "`")
    const after = repeatedAfter(state, range.to, "`")
    // Only remove a delimiter pair when the complete adjacent runs match.
    // Taking the shorter side corrupts source such as ``foo`, which is not a
    // valid symmetric code span around the selection.
    const existingFence = before > 0 && before === after ? before : 0
    if (existingFence > 0) {
      return {
        changes: [
          { from: range.from - existingFence, to: range.from },
          { from: range.to, to: range.to + existingFence },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.head - existingFence)
          : directedRange(
              range,
              range.from - existingFence,
              range.to - existingFence
            ),
      }
    }

    const source = state.sliceDoc(range.from, range.to)
    const fence = "`".repeat(Math.max(1, longestRun(source, "`") + 1))
    const pad =
      source.length > 0 &&
      (source.startsWith("`") ||
        source.endsWith("`") ||
        (source.startsWith(" ") && source.endsWith(" ")))
        ? " "
        : ""
    const open = fence + pad
    const close = pad + fence
    if (before > 0 || after > 0) {
      const innerFrom = range.from - before + open.length
      return {
        changes: [
          { from: range.from - before, to: range.from, insert: open },
          { from: range.to, to: range.to + after, insert: close },
        ],
        range: range.empty
          ? EditorSelection.cursor(innerFrom)
          : directedRange(range, innerFrom, innerFrom + source.length),
      }
    }
    return {
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: close },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.head + open.length)
        : EditorSelection.range(
            range.anchor + open.length,
            range.head + open.length
          ),
    }
  })

  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input.type",
    })
  )
  return true
}

function insertLinkLike(view: EditorView, image: boolean) {
  const { state } = view
  const transaction = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)
    const placeholder = image ? "alt text" : "text"
    const selectedIsUrl = /^https?:\/\/\S+$/i.test(selected)
    const label = selectedIsUrl
      ? image
        ? "alt text"
        : "link"
      : selected || placeholder
    const target = selectedIsUrl ? selected : "https://"
    const inserted = markdownLinkLikeSource(label, target, image)
    const selectionFrom =
      range.from +
      (selectedIsUrl || !selected
        ? inserted.labelFrom
        : inserted.destinationFrom)
    const selectionTo =
      range.from +
      (selectedIsUrl || !selected ? inserted.labelTo : inserted.destinationTo)
    return {
      changes: { from: range.from, to: range.to, insert: inserted.source },
      range: directedRange(range, selectionFrom, selectionTo),
    }
  })

  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

function selectedLines(state: EditorState) {
  const selected = new Map<number, Line>()
  for (const range of state.selection.ranges) {
    const finalPosition = range.empty
      ? range.head
      : Math.max(range.from, range.to - 1)
    let line = state.doc.lineAt(range.from)
    const finalLine = state.doc.lineAt(finalPosition).number
    while (line.number <= finalLine) {
      selected.set(line.from, line)
      if (line.number === state.doc.lines) break
      line = state.doc.line(line.number + 1)
    }
  }
  return [...selected.values()].sort((left, right) => left.from - right.from)
}

function leadingWhitespace(text: string) {
  return /^[\t ]*/.exec(text)?.[0] ?? ""
}

const markdownHeadingName = /^(ATXHeading|SetextHeading)([1-6])$/

function directHeadingMarks(node: SyntaxNode) {
  const marks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") marks.push(child)
  }
  return marks
}

interface HeadingSourceChange {
  from: number
  insert?: string
  to?: number
}

function atxHeadingChanges(
  state: EditorState,
  node: SyntaxNode,
  level: MarkdownHeadingLevel
) {
  const marks = directHeadingMarks(node)
  const opening = marks[0]
  if (!opening) return []
  const line = state.doc.lineAt(opening.from)
  const closing = marks.length > 1 ? marks.at(-1)! : null
  const openingLimit = closing?.from ?? line.to
  let openingTo = opening.to
  while (
    openingTo < openingLimit &&
    /[\t ]/.test(state.sliceDoc(openingTo, openingTo + 1))
  ) {
    openingTo += 1
  }

  const replacement = level === 0 ? "" : `${"#".repeat(level)} `
  const changes: HeadingSourceChange[] = []
  if (state.sliceDoc(opening.from, openingTo) !== replacement) {
    changes.push({ from: opening.from, to: openingTo, insert: replacement })
  }

  if (closing) {
    let closingFrom = closing.from
    while (
      closingFrom > openingTo &&
      /[\t ]/.test(state.sliceDoc(closingFrom - 1, closingFrom))
    ) {
      closingFrom -= 1
    }
    changes.push({ from: closingFrom, to: line.to, insert: "" })
  }
  return changes
}

function setextHeadingChanges(
  state: EditorState,
  node: SyntaxNode,
  level: MarkdownHeadingLevel
) {
  const underline = directHeadingMarks(node).at(-1)
  if (!underline) return []
  const underlineLine = state.doc.lineAt(underline.from)
  const changes: HeadingSourceChange[] = []
  if (level > 0) {
    changes.push({
      from: node.from,
      insert: `${"#".repeat(level)} `,
    })
  }
  changes.push({
    // A Setext heading may contain multiple content lines. Remove only the
    // final line break and underline so no authored heading content is lost.
    from: Math.max(node.from, underlineLine.from - 1),
    to: underlineLine.to,
    insert: "",
  })
  return changes
}

function setHeading(view: EditorView, level: MarkdownHeadingLevel) {
  const { state } = view
  const lines = selectedLines(state)
  const selectedLineNumbers = new Set(lines.map((line) => line.number))
  const coveredLineNumbers = new Set<number>()
  const headings = new Map<string, SyntaxNode>()
  const tree = completeMarkdownSyntaxTree(state)
  const collectHeadings = (from: number, to: number) => {
    tree.iterate({
      from,
      to,
      enter(reference) {
        if (!markdownHeadingName.test(reference.name)) return
        const node = reference.node
        const firstNumber = state.doc.lineAt(node.from).number
        const lastNumber = state.doc.lineAt(
          Math.max(node.from, node.to - 1)
        ).number
        let selected = false
        for (let number = firstNumber; number <= lastNumber; number += 1) {
          if (selectedLineNumbers.has(number)) {
            coveredLineNumbers.add(number)
            selected = true
          }
        }
        if (selected) headings.set(`${node.from}:${node.to}`, node)
      },
    })
  }
  let runStart = lines[0]
  let runEnd = runStart
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (runEnd && line.number === runEnd.number + 1) {
      runEnd = line
      continue
    }
    if (runStart && runEnd) collectHeadings(runStart.from, runEnd.to)
    runStart = line
    runEnd = line
  }
  if (runStart && runEnd) collectHeadings(runStart.from, runEnd.to)

  const changes: HeadingSourceChange[] = []
  for (const node of headings.values()) {
    changes.push(
      ...(node.name.startsWith("Setext")
        ? setextHeadingChanges(state, node, level)
        : atxHeadingChanges(state, node, level))
    )
  }
  for (const line of lines) {
    if (coveredLineNumbers.has(line.number)) continue
    const prefix = listPrefix(line.text, state.tabSize)
    const contentOffset =
      prefix.containerLength + prefix.indent.length + prefix.length
    const remainder = line.text.slice(contentOffset)
    const existing = /^#{1,6}(?:[\t ]+|$)/.exec(remainder)?.[0] ?? ""
    changes.push({
      from: line.from + contentOffset,
      to: line.from + contentOffset + existing.length,
      insert: level === 0 ? "" : `${"#".repeat(level)} `,
    })
  }
  changes.sort((left, right) => left.from - right.from)
  if (changes.length > 0) dispatchBlockPrefixChanges(view, changes)
  return true
}

type ListKind = "bullet" | "ordered" | "task"

interface ListPrefix {
  containerLength: number
  quoteDepth: number
  indent: string
  indentColumns: number
  kind: ListKind | null
  length: number
  markerTokenLength: number
  spacingLength: number
  contentIndentColumns: number
}

function listPrefix(
  text: string,
  tabSize: number,
  allowContextualAlphabeticMarker = false
): ListPrefix {
  const container = markdownContainerPrefix(text, tabSize)
  const remainder = text.slice(container.length)
  const indent = leadingWhitespace(remainder)
  const source = remainder.slice(indent.length)
  const markerFrom = container.length + indent.length
  const potentialOrdered = allowContextualAlphabeticMarker
    ? parsePotentialOrderedListMarker(source)
    : parseOrderedListMarker(source)
  const orderedTokenLength = potentialOrdered
    ? potentialOrdered.token.length + 1
    : 0
  const orderedAccepted =
    orderedTokenLength > 0 &&
    (allowContextualAlphabeticMarker || listMarkerPrefixLength(source) > 0)
  const bullet = orderedAccepted ? null : /^[-+*](?=[\t ]|$)/.exec(source)
  const markerTokenLength = orderedAccepted
    ? orderedTokenLength
    : bullet
      ? 1
      : 0
  const spacing =
    markerTokenLength > 0
      ? (/^[\t ]*/.exec(source.slice(markerTokenLength))?.[0] ?? "")
      : ""
  const spacingColumns = sourceColumnWidth(
    text,
    markerFrom + markerTokenLength,
    markerFrom + markerTokenLength + spacing.length,
    tabSize
  )
  const structuralSpacing = spacingColumns >= 1 && spacingColumns <= 4
  const task =
    markerTokenLength > 0 && structuralSpacing
      ? /^\[[ xX]\](?:[\t ]+|$)/.exec(
          source.slice(markerTokenLength + spacing.length)
        )
      : null
  const kind: ListKind | null = task
    ? "task"
    : orderedAccepted
      ? "ordered"
      : bullet
        ? "bullet"
        : null
  const markerLength =
    markerTokenLength + spacing.length + (task?.[0].length ?? 0)
  const structuralColumns =
    markerTokenLength > 0
      ? markerTokenLength + (structuralSpacing ? spacingColumns : 1)
      : 0
  return {
    containerLength: container.length,
    quoteDepth: container.quoteDepth,
    indent,
    indentColumns: sourceColumnWidth(
      text,
      container.length,
      container.length + indent.length,
      tabSize
    ),
    kind,
    length: markerLength,
    markerTokenLength,
    spacingLength: spacing.length,
    // The checkbox is task-item content, not part of the list marker's
    // structural indentation. `length` remains the complete source prefix so
    // formatting commands still replace or skip the complete task prefix.
    contentIndentColumns: structuralColumns,
  }
}

interface ListLine {
  line: Line
  prefix: ListPrefix
}

interface ListItemRange {
  startLine: number
  endLine: number
  node: SyntaxNode | null
}

function directListMark(node: SyntaxNode) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListMark") return child
  }
  return null
}

function parentListItem(node: SyntaxNode | null) {
  while (node) {
    if (node.name === "ListItem") return node
    node = node.parent
  }
  return null
}

function semanticListItemAtLine(
  tree: ReturnType<typeof completeMarkdownSyntaxTree>,
  line: Line,
  preferredPosition: number
) {
  const positions: ReadonlyArray<readonly [number, -1 | 1]> = [
    [Math.max(line.from, Math.min(line.to, preferredPosition)), -1],
    [line.from, 1],
    [Math.max(line.from, line.to - 1), -1],
  ]
  for (const [position, side] of positions) {
    const item = parentListItem(tree.resolveInner(position, side))
    if (item && item.from <= line.to && item.to >= line.from) return item
  }
  return null
}

function listItemRange(state: EditorState, node: SyntaxNode) {
  const mark = directListMark(node)
  if (!mark) return null
  return {
    startLine: state.doc.lineAt(mark.from).number,
    endLine: state.doc.lineAt(Math.max(mark.from, node.to - 1)).number,
    node,
  } satisfies ListItemRange
}

function isTextualListFallback(
  state: EditorState,
  tree: ReturnType<typeof completeMarkdownSyntaxTree>,
  line: Line,
  prefix: ListPrefix
) {
  const markerFrom = line.from + prefix.containerLength + prefix.indent.length
  let node: SyntaxNode | null = tree.resolveInner(
    Math.min(line.to, markerFrom),
    1
  )
  while (node?.parent) {
    if (
      node.name === "CodeBlock" ||
      node.name === "FencedCode" ||
      node.name === "InlineCode"
    ) {
      return false
    }
    if (node.parent.name === "ListItem") {
      if (node.name === "Paragraph") return true
      if (node.name !== "Task") return false
      const ownerMark = directListMark(node.parent)
      if (!ownerMark) return false
      const ownerLine = state.doc.lineAt(ownerMark.from)
      const ownerPrefix = listPrefix(ownerLine.text, state.tabSize, true)
      return (
        prefix.quoteDepth === ownerPrefix.quoteDepth &&
        prefix.indentColumns ===
          ownerPrefix.indentColumns + ownerPrefix.contentIndentColumns
      )
    }
    node = node.parent
  }
  return false
}

function lineIsProtectedCode(
  tree: ReturnType<typeof completeMarkdownSyntaxTree>,
  line: Line
) {
  const positions: ReadonlyArray<readonly [number, -1 | 1]> = [
    [line.from, 1],
    [Math.max(line.from, line.to - 1), -1],
  ]
  for (const [position, side] of positions) {
    let node: SyntaxNode | null = tree.resolveInner(position, side)
    while (node) {
      if (
        node.name === "CodeBlock" ||
        node.name === "FencedCode" ||
        node.name === "InlineCode"
      ) {
        return true
      }
      node = node.parent
    }
  }
  return false
}

function nestedListItemRanges(
  state: EditorState,
  tree: ReturnType<typeof completeMarkdownSyntaxTree>,
  root: SyntaxNode
) {
  const byStart = new Map<number, ListItemRange>()
  const visit = (node: SyntaxNode) => {
    if (node.name === "ListItem") {
      const item = listItemRange(state, node)
      if (item) byStart.set(item.startLine, item)
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child)
    }
  }
  visit(root)

  const rootRange = listItemRange(state, root)
  if (!rootRange) return [...byStart.values()]
  const stacks = new Map<
    number,
    Array<ListItemRange & { indentColumns: number }>
  >()
  for (
    let number = rootRange.startLine;
    number <= rootRange.endLine;
    number += 1
  ) {
    const line = state.doc.line(number)
    const semanticItem = byStart.has(number)
    const prefix = listPrefix(line.text, state.tabSize, semanticItem)
    const fallbackItem =
      prefix.kind !== null &&
      !semanticItem &&
      isTextualListFallback(state, tree, line, prefix)
    const isListMarker = semanticItem || fallbackItem
    if (line.text.trim()) {
      for (const [depth, stack] of stacks) {
        if (depth <= prefix.quoteDepth) continue
        while (stack.length > 0) stack.pop()!.endLine = number - 1
      }
      if (!isListMarker) {
        const stack = stacks.get(prefix.quoteDepth)
        while (
          stack &&
          stack.length > 0 &&
          stack.at(-1)!.indentColumns >= prefix.indentColumns
        ) {
          stack.pop()!.endLine = number - 1
        }
      }
    }
    if (!isListMarker) continue
    const stack = stacks.get(prefix.quoteDepth) ?? []
    while (
      stack.length > 0 &&
      stack.at(-1)!.indentColumns >= prefix.indentColumns
    ) {
      stack.pop()!.endLine = number - 1
    }
    const fallback = {
      startLine: number,
      endLine: rootRange.endLine,
      indentColumns: prefix.indentColumns,
      node: null,
    }
    if (fallbackItem) byStart.set(number, fallback)
    stack.push(fallback)
    stacks.set(prefix.quoteDepth, stack)
  }
  return [...byStart.values()].sort(
    (left, right) => left.startLine - right.startLine
  )
}

function markerForKind(kind: ListKind, ordinal: number) {
  if (kind === "bullet") return "- "
  if (kind === "task") return "- [ ] "
  return `${ordinal}. `
}

function markerTokenForKind(kind: Exclude<ListKind, "task">, ordinal: number) {
  return kind === "bullet" ? "-" : `${ordinal}.`
}

function transformedListLine(
  state: EditorState,
  info: ListLine,
  kind: ListKind,
  ordinal: number,
  removing: boolean,
  nested: boolean
) {
  const { line, prefix } = info
  const markerFrom = prefix.containerLength + prefix.indent.length
  if (prefix.kind === null) {
    return (
      line.text.slice(0, markerFrom) +
      markerForKind(kind, ordinal) +
      line.text.slice(markerFrom)
    )
  }
  if (!removing && prefix.kind === kind && kind !== "ordered") return line.text

  if (removing) {
    if (prefix.kind === "task") {
      return (
        line.text.slice(0, markerFrom) +
        line.text.slice(markerFrom + prefix.length)
      )
    }
    const spacingFrom = markerFrom + prefix.markerTokenLength
    const spacingTo = spacingFrom + prefix.spacingLength
    const spacingColumns = sourceColumnWidth(
      line.text,
      spacingFrom,
      spacingTo,
      state.tabSize
    )
    const retainedIndent =
      spacingColumns > 4 ? " ".repeat(spacingColumns - 1) : ""
    return (
      line.text.slice(0, markerFrom) +
      retainedIndent +
      line.text.slice(spacingTo)
    )
  }

  if (prefix.kind === "task") {
    return (
      line.text.slice(0, markerFrom) +
      markerForKind(kind, ordinal) +
      line.text.slice(markerFrom + prefix.length)
    )
  }

  if (kind === "task") {
    const spacingFrom = markerFrom + prefix.markerTokenLength
    const spacingTo = spacingFrom + prefix.spacingLength
    const contentSpacing = line.text.slice(spacingFrom, spacingTo) || " "
    return (
      line.text.slice(0, markerFrom) +
      "- [ ]" +
      contentSpacing +
      line.text.slice(spacingTo)
    )
  }

  const preliminary =
    line.text.slice(0, markerFrom) +
    markerTokenForKind(kind, ordinal) +
    line.text.slice(markerFrom + prefix.markerTokenLength)
  return normalizeTransformedListMarkerPadding(
    line.text,
    preliminary,
    state.tabSize,
    prefix.quoteDepth,
    nested
  )
}

function minimalLineChange(line: Line, replacement: string): ChangeSpec | null {
  if (replacement === line.text) return null
  let from = 0
  while (
    from < line.text.length &&
    from < replacement.length &&
    line.text[from] === replacement[from]
  ) {
    from += 1
  }
  let oldTo = line.text.length
  let newTo = replacement.length
  while (
    oldTo > from &&
    newTo > from &&
    line.text[oldTo - 1] === replacement[newTo - 1]
  ) {
    oldTo -= 1
    newTo -= 1
  }
  return {
    from: line.from + from,
    to: line.from + oldTo,
    insert: replacement.slice(from, newTo),
  }
}

function hasBlankLineBetween(
  state: EditorState,
  previous: number,
  current: number
) {
  for (let number = previous + 1; number < current; number += 1) {
    if (state.doc.line(number).text.trim() === "") return true
  }
  return false
}

function selectedSubtreeEndLines(
  selected: readonly Line[],
  lineInfo: (number: number) => ListLine
) {
  const endByStart = new Map<number, number>()
  let groupFrom = 0

  while (groupFrom < selected.length) {
    let groupTo = groupFrom + 1
    const quoteDepth = lineInfo(selected[groupFrom]!.number).prefix.quoteDepth
    while (
      groupTo < selected.length &&
      selected[groupTo]!.number === selected[groupTo - 1]!.number + 1 &&
      lineInfo(selected[groupTo]!.number).prefix.quoteDepth === quoteDepth
    ) {
      groupTo += 1
    }

    const candidates: number[] = []
    const finalLine = selected[groupTo - 1]!.number
    for (let index = groupTo - 1; index >= groupFrom; index -= 1) {
      const line = selected[index]!
      const indent = lineInfo(line.number).prefix.indentColumns
      while (
        candidates.length > 0 &&
        lineInfo(selected[candidates.at(-1)!]!.number).prefix.indentColumns >
          indent
      ) {
        candidates.pop()
      }
      const boundary = candidates.at(-1)
      endByStart.set(
        line.number,
        boundary == null ? finalLine : selected[boundary]!.number - 1
      )
      candidates.push(index)
    }
    groupFrom = groupTo
  }

  return endByStart
}

function dispatchBlockPrefixChanges(
  view: EditorView,
  changes: readonly ChangeSpec[]
) {
  const { state } = view
  const changeSet = state.changes(changes)
  view.dispatch({
    changes: changeSet,
    // CodeMirror otherwise associates an empty range with the source before
    // an insertion. A structural prefix belongs before the caret's logical
    // content position, so keep carets after newly inserted prefixes while
    // retaining CodeMirror's ordinary inward mapping for nonempty ranges.
    selection: state.selection.map(changeSet, 1),
    scrollIntoView: true,
    userEvent: "input",
  })
}

function toggleList(view: EditorView, kind: ListKind) {
  const { state } = view
  const selected = selectedLines(state)
  const hasOnlyCarets = state.selection.ranges.every((range) => range.empty)
  const tree = completeMarkdownSyntaxTree(state)
  const lineCache = new Map<number, ListLine>()
  const lineInfo = (number: number) => {
    let info = lineCache.get(number)
    if (!info) {
      const line = state.doc.line(number)
      const item = semanticListItemAtLine(tree, line, line.to)
      const mark = item ? directListMark(item) : null
      const semanticItemStart =
        mark != null && mark.from >= line.from && mark.from <= line.to
      info = {
        line,
        prefix: listPrefix(line.text, state.tabSize, semanticItemStart),
      }
      lineCache.set(number, info)
    }
    return info
  }
  const rootsByStart = new Map<number, ListItemRange>()
  const plainTargets = new Set<number>()

  for (const range of state.selection.ranges) {
    const finalPosition = range.empty
      ? range.head
      : Math.max(range.from, range.to - 1)
    let line = state.doc.lineAt(range.from)
    const finalLine = state.doc.lineAt(finalPosition).number
    while (line.number <= finalLine) {
      const info = lineInfo(line.number)
      const content = line.text.slice(
        info.prefix.containerLength + info.prefix.indent.length
      )
      if (hasOnlyCarets && info.prefix.kind === null && content.length === 0) {
        plainTargets.add(line.number)
        if (line.number === finalLine || line.number === state.doc.lines) break
        line = state.doc.line(line.number + 1)
        continue
      }
      const preferredPosition = Math.max(
        line.from,
        Math.min(line.to, range.head)
      )
      const itemNode = semanticListItemAtLine(tree, line, preferredPosition)
      const item = itemNode ? listItemRange(state, itemNode) : null
      const itemPrefix = item ? lineInfo(item.startLine).prefix : null
      const isUnindentedLazyContinuation =
        item != null &&
        itemPrefix != null &&
        line.number !== item.startLine &&
        info.prefix.kind === null &&
        info.prefix.indentColumns <
          itemPrefix.indentColumns + itemPrefix.contentIndentColumns
      if (item && !isUnindentedLazyContinuation) {
        rootsByStart.set(item.startLine, item)
      } else {
        if (
          line.text.slice(info.prefix.containerLength).trim() &&
          !lineIsProtectedCode(tree, line)
        ) {
          plainTargets.add(line.number)
        }
      }
      if (line.number === finalLine || line.number === state.doc.lines) break
      line = state.doc.line(line.number + 1)
    }
  }

  for (const line of selected) {
    const info = lineInfo(line.number)
    const content = line.text.slice(
      info.prefix.containerLength + info.prefix.indent.length
    )
    if (hasOnlyCarets && info.prefix.kind === null && content.length === 0) {
      plainTargets.add(line.number)
    }
  }

  const roots = [...rootsByStart.values()]
  roots.sort(
    (left, right) =>
      left.startLine - right.startLine || right.endLine - left.endLine
  )
  const outerRoots: ListItemRange[] = []
  let containingEndLine = -1
  for (const item of roots) {
    if (item.endLine <= containingEndLine) continue
    outerRoots.push(item)
    containingEndLine = item.endLine
  }

  const targetedItemsByStart = new Map<number, ListItemRange>()
  for (const root of outerRoots) {
    for (const item of nestedListItemRanges(state, tree, root.node!)) {
      targetedItemsByStart.set(item.startLine, item)
    }
  }
  const targetedItems = [...targetedItemsByStart.values()].sort(
    (left, right) => left.startLine - right.startLine
  )
  for (const item of targetedItems) plainTargets.delete(item.startLine)

  const subtreeEndByStart = selectedSubtreeEndLines(selected, lineInfo)
  const targets = [
    ...targetedItems.map((item) => ({
      endLine: item.endLine,
      info: lineInfo(item.startLine),
      node: item.node,
    })),
    ...[...plainTargets].map((number) => {
      const info = lineInfo(number)
      return {
        endLine: subtreeEndByStart.get(number) ?? number,
        info,
        node: null,
      }
    }),
  ].sort((left, right) => left.info.line.from - right.info.line.from)

  if (targets.length === 0) return true
  const removing = targets.every(({ info }) => info.prefix.kind === kind)
  const orderStack: Array<{ column: number; count: number }> = []
  const lineReplacements = new Map<number, string>()
  const shiftEvents = new Map<number, number>()
  let previousTarget: ListLine | null = null

  for (const target of targets) {
    const { info } = target
    if (
      previousTarget &&
      (previousTarget.prefix.quoteDepth !== info.prefix.quoteDepth ||
        (hasBlankLineBetween(
          state,
          previousTarget.line.number,
          info.line.number
        ) &&
          info.prefix.indentColumns <= (orderStack[0]?.column ?? 0)))
    ) {
      orderStack.length = 0
    }
    while (
      orderStack.length > 0 &&
      orderStack.at(-1)!.column > info.prefix.indentColumns
    ) {
      orderStack.pop()
    }
    let level = orderStack.at(-1)
    if (!level || level.column < info.prefix.indentColumns) {
      level = { column: info.prefix.indentColumns, count: 0 }
      orderStack.push(level)
    }
    level.count += 1

    const replacement = transformedListLine(
      state,
      info,
      kind,
      level.count,
      removing,
      target.node ? parentListItem(target.node.parent) != null : false
    )
    if (replacement !== info.line.text) {
      lineReplacements.set(info.line.number, replacement)
    }
    const replacementPrefix = listPrefix(
      replacement,
      state.tabSize,
      target.node != null
    )
    const delta =
      replacementPrefix.contentIndentColumns - info.prefix.contentIndentColumns
    if (delta !== 0 && target.endLine > info.line.number) {
      const from = info.line.number + 1
      shiftEvents.set(from, (shiftEvents.get(from) ?? 0) + delta)
      shiftEvents.set(
        target.endLine + 1,
        (shiftEvents.get(target.endLine + 1) ?? 0) - delta
      )
    }
    previousTarget = info
  }

  let activeShift = 0
  const eventLines = [...shiftEvents.keys()]
  if (eventLines.length > 0) {
    let firstEvent = eventLines[0]!
    let lastEvent = eventLines[0]!
    for (let index = 1; index < eventLines.length; index += 1) {
      firstEvent = Math.min(firstEvent, eventLines[index]!)
      lastEvent = Math.max(lastEvent, eventLines[index]!)
    }
    for (
      let number = firstEvent;
      number <= Math.min(state.doc.lines, lastEvent);
      number += 1
    ) {
      activeShift += shiftEvents.get(number) ?? 0
      if (activeShift === 0) continue
      const info = lineInfo(number)
      if (!info.line.text.slice(info.prefix.containerLength).trim()) continue
      const current = lineReplacements.get(number) ?? info.line.text
      const item = semanticListItemAtLine(tree, info.line, info.line.to)
      const replacement = shiftTransformedListLineIndentation(
        state,
        info.line.text,
        current,
        info.prefix.quoteDepth,
        activeShift,
        item ? parentListItem(item.parent) != null : false
      )
      if (replacement !== info.line.text)
        lineReplacements.set(number, replacement)
      else lineReplacements.delete(number)
    }
  }

  const changes = [...lineReplacements]
    .sort(([left], [right]) => left - right)
    .flatMap(([number, replacement]) => {
      const change = minimalLineChange(state.doc.line(number), replacement)
      return change ? [change] : []
    })
  dispatchBlockPrefixChanges(view, changes)
  return true
}

function toggleBlockquote(view: EditorView) {
  const lines = selectedLines(view.state)
  const prefixes = lines.map((line) => {
    const container = markdownContainerPrefix(line.text, view.state.tabSize, 1)
    if (container.quoteDepth === 0) return null
    const markerFrom = line.text.slice(0, container.length).lastIndexOf(">")
    const markerTo =
      markerFrom + 1 + (line.text[markerFrom + 1] === " " ? 1 : 0)
    return { markerFrom, markerTo }
  })
  const removing = prefixes.every((prefix) => prefix != null)
  const changes = lines.flatMap((line, index): ChangeSpec[] => {
    const prefix = prefixes[index]!
    if (!removing && prefix) return []
    return [
      {
        from: line.from + (prefix?.markerFrom ?? 0),
        to: line.from + (prefix?.markerTo ?? 0),
        insert: removing ? "" : "> ",
      },
    ]
  })
  dispatchBlockPrefixChanges(view, changes)
  return true
}

function rangeTouchesBlockContainer(state: EditorState, range: SelectionRange) {
  const finalPosition = range.empty
    ? range.head
    : Math.max(range.from, range.to - 1)
  let line = state.doc.lineAt(range.from)
  const finalLine = state.doc.lineAt(finalPosition).number
  while (line.number <= finalLine) {
    const prefix = listPrefix(line.text, state.tabSize)
    // Block actions need a distinct prefixed representation inside quotes and
    // list items. Refuse those uncommon nested cases instead of emitting a
    // top-level block that silently changes the surrounding hierarchy.
    if (
      prefix.containerLength > 0 ||
      prefix.indent.length > 0 ||
      prefix.kind !== null
    ) {
      return true
    }
    if (line.number === finalLine || line.number === state.doc.lines) break
    line = state.doc.line(line.number + 1)
  }
  return false
}

function structuralContainerEnd(state: EditorState, position: number) {
  const tree = completeMarkdownSyntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(position, -1)
  let end = state.doc.lineAt(position).to
  while (node) {
    if (
      node.name === "Blockquote" ||
      node.name === "BulletList" ||
      node.name === "OrderedList"
    ) {
      end = Math.max(end, state.doc.lineAt(Math.max(node.from, node.to - 1)).to)
    }
    node = node.parent
  }
  return end
}

function selectionTouchesFencedCode(state: EditorState) {
  const ranges = state.selection.ranges
  const tree = completeMarkdownSyntaxTree(state)
  let touchesFence = false

  tree.iterate({
    enter(node) {
      if (touchesFence || node.name !== "FencedCode") return
      touchesFence = ranges.some((range) =>
        range.empty
          ? range.head >= node.from && range.head <= node.to
          : range.from < node.to && range.to > node.from
      )
    },
  })

  return touchesFence
}

function toggleCodeBlock(view: EditorView, language = "") {
  const { state } = view
  // Applying the block type is idempotent. Removing an enclosing fence for a
  // partial selection would unexpectedly change the whole block, while adding
  // another fence inside it can close and reopen the existing Markdown block.
  if (selectionTouchesFencedCode(state)) return true

  if (
    state.selection.ranges.some(
      (range) => !range.empty && rangeTouchesBlockContainer(state, range)
    )
  ) {
    return false
  }
  const info = language.trim().replace(/[\r\n]+/g, " ")
  const transaction = state.changeByRange((range) => {
    const currentLine = state.doc.lineAt(range.head)
    const nestedInsertion =
      range.empty && rangeTouchesBlockContainer(state, range)
    const from = nestedInsertion
      ? structuralContainerEnd(state, range.head)
      : range.empty
        ? currentLine.from
        : range.from
    const to = nestedInsertion ? from : range.empty ? currentLine.to : range.to
    const selected = state.sliceDoc(from, to)
    const fence = "`".repeat(Math.max(3, longestRun(selected, "`") + 1))
    const leading = nestedInsertion
      ? from > 0
        ? "\n"
        : ""
      : from > 0 && state.sliceDoc(from - 1, from) !== "\n"
        ? "\n"
        : ""
    const trailing =
      to < state.doc.length && state.sliceDoc(to, to + 1) !== "\n" ? "\n" : ""
    const opening = `${leading}${fence}${info}\n`
    const contentEnd = selected.endsWith("\n") ? "" : "\n"
    const inserted = `${opening}${selected}${contentEnd}${fence}${trailing}`
    return {
      changes: { from, to, insert: inserted },
      range: range.empty
        ? EditorSelection.cursor(
            from +
              opening.length +
              (nestedInsertion ? 0 : Math.max(0, range.head - from))
          )
        : directedRange(
            range,
            from + opening.length,
            from + opening.length + selected.length
          ),
    }
  })
  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

function insertHorizontalRule(view: EditorView) {
  const { state } = view
  if (
    state.selection.ranges.some(
      (range) => !range.empty && rangeTouchesBlockContainer(state, range)
    )
  ) {
    return false
  }
  const transaction = state.changeByRange((range) => {
    const nested = range.empty && rangeTouchesBlockContainer(state, range)
    if (range.empty) {
      const line = state.doc.lineAt(range.head)
      const from = nested
        ? structuralContainerEnd(state, range.head)
        : line.text.length === 0
          ? line.from
          : line.to
      const leading = nested || line.text.length > 0 ? "\n" : ""
      return {
        changes: { from, insert: `${leading}---` },
        range: EditorSelection.cursor(from + leading.length + 3),
      }
    }
    const leading =
      range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== "\n"
        ? "\n"
        : ""
    const trailing =
      range.to < state.doc.length &&
      state.sliceDoc(range.to, range.to + 1) !== "\n"
        ? "\n"
        : ""
    const inserted = `${leading}---${trailing}`
    return {
      changes: { from: range.from, to: range.to, insert: inserted },
      range: EditorSelection.cursor(range.from + leading.length + 3),
    }
  })
  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

function tableCells(source: string) {
  if (!source.trim()) return []
  return source
    .split(/\r?\n/)
    .map((line) =>
      (line.includes("\t") ? line.split("\t") : [line]).map((cell) =>
        cell.trim().replace(/\|/g, "\\|")
      )
    )
}

export function createMarkdownTable(
  requestedColumns: number,
  requestedRows: number,
  source = ""
) {
  if (
    !Number.isInteger(requestedColumns) ||
    !Number.isInteger(requestedRows) ||
    requestedColumns < 1 ||
    requestedRows < 1
  ) {
    throw new RangeError("Table rows and columns must be positive integers")
  }

  const supplied = tableCells(source)
  const columns = Math.max(
    requestedColumns,
    supplied.reduce((maximum, row) => Math.max(maximum, row.length), 1)
  )
  const rows = Math.max(requestedRows, supplied.length, 1)
  const rowText = (cells: readonly string[]) =>
    `| ${Array.from({ length: columns }, (_, column) => cells[column] ?? "").join(" | ")} |`
  const header = Array.from(
    { length: columns },
    (_, column) => supplied[0]?.[column] || `Header ${column + 1}`
  )
  const output = [
    rowText(header),
    rowText(Array.from({ length: columns }, () => "---")),
  ]
  for (let row = 1; row < rows; row += 1) {
    output.push(rowText(supplied[row] ?? []))
  }
  return output.join("\n")
}

function insertTable(view: EditorView, columns: number, rows: number) {
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns > 20 ||
    rows > 20
  ) {
    return false
  }

  const { state } = view
  if (
    state.selection.ranges.some(
      (range) => !range.empty && rangeTouchesBlockContainer(state, range)
    )
  ) {
    return false
  }
  const transaction = state.changeByRange((range) => {
    const nested = range.empty && rangeTouchesBlockContainer(state, range)
    const selected = state.sliceDoc(range.from, range.to)
    const table = createMarkdownTable(columns, rows, selected)
    if (range.empty) {
      const line = state.doc.lineAt(range.head)
      const from = nested
        ? structuralContainerEnd(state, range.head)
        : line.text.length === 0
          ? line.from
          : line.to
      const leading = nested || line.text.length > 0 ? "\n" : ""
      const firstCell = table.slice(2, table.indexOf(" |"))
      return {
        changes: { from, insert: `${leading}${table}` },
        range: EditorSelection.range(
          from + leading.length + 2,
          from + leading.length + 2 + firstCell.length
        ),
      }
    }
    const leading =
      range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== "\n"
        ? "\n"
        : ""
    const trailing =
      range.to < state.doc.length &&
      state.sliceDoc(range.to, range.to + 1) !== "\n"
        ? "\n"
        : ""
    const firstCell = table.slice(2, table.indexOf(" |"))
    return {
      changes: {
        from: range.from,
        to: range.to,
        insert: `${leading}${table}${trailing}`,
      },
      range: EditorSelection.range(
        range.from + leading.length + 2,
        range.from + leading.length + 2 + firstCell.length
      ),
    }
  })
  view.dispatch(
    state.update(transaction, {
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

export function applyMarkdownFormatting(
  view: EditorView,
  command: MarkdownFormattingCommand
) {
  if (view.state.readOnly) return false

  switch (command.type) {
    case "bold":
      return toggleSymmetricMarker(view, "**")
    case "italic":
      return toggleSymmetricMarker(view, "*")
    case "strikethrough":
      return toggleSymmetricMarker(view, "~~")
    case "inline-code":
      return toggleInlineCode(view)
    case "link":
      return insertLinkLike(view, false)
    case "image":
      return insertLinkLike(view, true)
    case "heading":
      return setHeading(view, command.level)
    case "bullet-list":
      return toggleList(view, "bullet")
    case "ordered-list":
      return toggleList(view, "ordered")
    case "task-list":
      return toggleList(view, "task")
    case "blockquote":
      return toggleBlockquote(view)
    case "code-block":
      return toggleCodeBlock(view, command.language)
    case "horizontal-rule":
      return insertHorizontalRule(view)
    case "table":
      return insertTable(view, command.columns, command.rows)
  }
}

export const markdownFormattingKeymap: readonly KeyBinding[] = [
  {
    key: "Mod-b",
    run: (view) => applyMarkdownFormatting(view, { type: "bold" }),
  },
  {
    key: "Mod-i",
    run: (view) => applyMarkdownFormatting(view, { type: "italic" }),
  },
]
