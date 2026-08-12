import { syntaxTree } from "@codemirror/language"
import { insertNewline, insertNewlineAndIndent } from "@codemirror/commands"
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown"
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import type { Command, EditorView } from "@codemirror/view"

import { completeMarkdownSyntaxTree } from "./complete-markdown-tree"
import {
  inferOrderedListMarkerFamily,
  orderedListMarkerLength,
  orderedListMarkerOrdinal,
  orderedListMarkerToken,
  parseOrderedListMarker,
  parsePotentialOrderedListMarker,
  type OrderedListMarkerFamily,
} from "./list-markers"
import {
  markdownContainerPrefix,
  sourceColumn,
  sourceColumnWidth,
} from "./markdown-prefix"

interface LinePrefix {
  containerLength: number
  containerNeedsCanonicalPadding: boolean
  containerTrailingPaddingLength: number
  quoteDepth: number
  indent: string
  indentColumns: number
  markerLength: number
  contentIndentColumns: number
}

interface ListItemBlock {
  dedentContainerPadding: "" | " "
  dedentDestinationNested: boolean
  dedentMarkerTokenReplacement: string | null
  dedentTargetColumns: number
  dedentTargetSource: string
  endLine: number
  indentColumns: number
  indentTargetColumns: number | null
  indentTargetSource: string | null
  markerTokenFrom: number | null
  indentMarkerTokenReplacement: string | null
  markerTokenTo: number | null
  node: SyntaxNode
  quoteDepth: number
  startLine: number
}

interface ListItemModel {
  containerPadding: "" | " "
  contentIndentColumns: number
  endLine: number
  indent: string
  indentColumns: number
  node: SyntaxNode
  quoteDepth: number
  startLine: number
}

interface SourceChange {
  from: number
  insert: string
  to: number
}

const insertNewlineContinueCommonMarkList = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
})

interface EmptyOrderedListItem {
  item: SyntaxNode
  list: SyntaxNode
  marker: SyntaxNode
}

function structuralListContentIndentColumns(
  text: string,
  markerFrom: number,
  markerTo: number,
  spacingTo: number,
  tabSize: number
) {
  const markerColumns = sourceColumnWidth(text, markerFrom, markerTo, tabSize)
  const spacingColumns = sourceColumnWidth(text, markerTo, spacingTo, tabSize)
  // CommonMark treats one to four columns after a list marker as its
  // structural padding. With no padding (an empty item), or five-plus
  // columns, the structural padding is one column and the remainder belongs
  // to the item's content.
  return (
    markerColumns +
    (spacingColumns >= 1 && spacingColumns <= 4 ? spacingColumns : 1)
  )
}

function hasCommonMarkMarkerPadding(
  text: string,
  from: number,
  to: number,
  tabSize: number
) {
  const columns = sourceColumnWidth(text, from, to, tabSize)
  return columns >= 1 && columns <= 4
}

function linePrefix(
  text: string,
  tabSize: number,
  allowContextualAlphabeticMarker = false,
  maximumQuoteDepth = Number.POSITIVE_INFINITY
): LinePrefix {
  const container = markdownContainerPrefix(text, tabSize, maximumQuoteDepth)
  const remainder = text.slice(container.length)
  const indent = /^[\t ]*/.exec(remainder)?.[0] ?? ""
  const source = remainder.slice(indent.length)
  const markerFrom = container.length + indent.length
  const potentialTask = /^([-+*])([\t ]+)\[[ xX]\](?:[\t ]+|$)/.exec(source)
  const task =
    potentialTask &&
    hasCommonMarkMarkerPadding(
      text,
      markerFrom + potentialTask[1]!.length,
      markerFrom + potentialTask[1]!.length + potentialTask[2]!.length,
      tabSize
    )
      ? potentialTask
      : null
  const contextualOrdered = allowContextualAlphabeticMarker
    ? parsePotentialOrderedListMarker(source)
    : null
  const orderedLength = contextualOrdered
    ? contextualOrdered.token.length + 1
    : orderedListMarkerLength(source)
  const orderedSpacing =
    orderedLength > 0
      ? (/^[\t ]+/.exec(source.slice(orderedLength))?.[0] ?? "")
      : ""
  const bullet = /^([-+*])([\t ]+|$)/.exec(source)
  const marker = task
    ? task[0]
    : orderedLength > 0
      ? source.slice(0, orderedLength) + orderedSpacing
      : (bullet?.[0] ?? "")
  const structuralTokenLength = task
    ? task[1]!.length
    : orderedLength > 0
      ? orderedLength
      : (bullet?.[1]?.length ?? 0)
  const structuralSpacingLength = task
    ? task[2]!.length
    : orderedLength > 0
      ? orderedSpacing.length
      : (bullet?.[2]?.length ?? 0)
  const markerTo = markerFrom + structuralTokenLength
  return {
    containerLength: container.length,
    containerNeedsCanonicalPadding: container.containerNeedsCanonicalPadding,
    containerTrailingPaddingLength: container.trailingPaddingLength,
    quoteDepth: container.quoteDepth,
    indent,
    indentColumns: sourceColumnWidth(
      text,
      container.length,
      markerFrom,
      tabSize
    ),
    markerLength: marker.length,
    contentIndentColumns:
      structuralTokenLength > 0
        ? structuralListContentIndentColumns(
            text,
            markerFrom,
            markerTo,
            markerTo + structuralSpacingLength,
            tabSize
          )
        : 0,
  }
}

function indentationColumnsFromSource(
  source: string,
  baseColumn: number,
  tabSize: number
) {
  return (
    sourceColumn(
      `${" ".repeat(baseColumn)}${source}`,
      baseColumn + source.length,
      tabSize
    ) - baseColumn
  )
}

interface ListIndentationReplacement {
  readonly columns: number
  readonly from: number
  readonly source: string
  readonly to: number
}

function listIndentationReplacement(
  state: EditorState,
  line: Line,
  prefix: LinePrefix,
  targetColumns: number,
  roundTabsUp: boolean,
  preferredSource: string | null = null,
  preferredContainerPadding: "" | " " | null = null
): ListIndentationReplacement {
  return listIndentationReplacementForText(
    state,
    line.text,
    prefix,
    targetColumns,
    roundTabsUp,
    preferredSource,
    preferredContainerPadding
  )
}

function listIndentationReplacementForText(
  state: EditorState,
  text: string,
  prefix: LinePrefix,
  targetColumns: number,
  roundTabsUp: boolean,
  preferredSource: string | null = null,
  preferredContainerPadding: "" | " " | null = null
): ListIndentationReplacement {
  const target = Math.max(0, targetColumns)
  const currentContainerPadding = prefix.containerTrailingPaddingLength
    ? " "
    : ""
  // A generated indent after an unpadded quote needs a literal optional quote
  // space. Space-derived indentation counts that padding toward the requested
  // physical column; a reused authored source pattern follows it verbatim. An
  // explicit padding target restores the parent's quote style when dedenting,
  // including the authored unpadded form.
  const containerPadding =
    preferredContainerPadding ??
    (target > 0 && prefix.containerNeedsCanonicalPadding
      ? " "
      : currentContainerPadding)
  const from = prefix.containerLength - prefix.containerTrailingPaddingLength
  const to = prefix.containerLength + prefix.indent.length
  const baseColumn =
    sourceColumn(text, from, state.tabSize) + containerPadding.length
  if (preferredSource != null) {
    const preferredColumns = indentationColumnsFromSource(
      preferredSource,
      baseColumn,
      state.tabSize
    )
    return {
      columns: preferredColumns,
      from,
      source: containerPadding + preferredSource,
      to,
    }
  }

  const indentationTarget = target

  if (!prefix.indent.includes("\t")) {
    return {
      columns: indentationTarget,
      from,
      source: containerPadding + " ".repeat(indentationTarget),
      to,
    }
  }

  const targetColumn = baseColumn + indentationTarget
  let column = baseColumn
  let source = ""
  while (column < targetColumn) {
    const remainder = column % state.tabSize
    const nextTabStop =
      column + (remainder === 0 ? state.tabSize : state.tabSize - remainder)
    if (nextTabStop <= targetColumn || roundTabsUp) {
      source += "\t"
      column = nextTabStop
    } else {
      source += " ".repeat(targetColumn - column)
      column = targetColumn
    }
  }
  return {
    columns: column - baseColumn,
    from,
    source: containerPadding + source,
    to,
  }
}

function listIndentationSource(
  state: EditorState,
  line: Line,
  prefix: LinePrefix,
  targetColumns: number,
  roundTabsUp: boolean
) {
  return listIndentationReplacement(
    state,
    line,
    prefix,
    targetColumns,
    roundTabsUp
  )
}

interface AuthoredListLineMarker {
  readonly containerLength: number
  readonly contentFrom: number
  readonly delimiter: "." | ")" | null
  readonly indent: string
  readonly indentColumns: number
  readonly kind: "bullet" | "ordered" | "ordered-task" | "task"
  readonly markerFrom: number
  readonly markerTo: number
  readonly quoteDepth: number
  readonly spacing: string
  readonly taskSpacing: string
  readonly token: string
}

interface RawListMarkerPadding {
  readonly delimiter: "." | ")" | null
  readonly markerFrom: number
  readonly markerTo: number
  readonly spacing: string
  readonly spacingTo: number
  readonly token: string
}

const orderedMarkerNeighborLineLimit = 128

function authoredListLineMarker(
  line: Line,
  tabSize: number,
  allowContextualAlphabeticMarker = false
): AuthoredListLineMarker | null {
  const container = markdownContainerPrefix(line.text, tabSize)
  const remainder = line.text.slice(container.length)
  const indent = /^[\t ]*/.exec(remainder)?.[0] ?? ""
  const markerFrom = container.length + indent.length
  const indentColumns = sourceColumnWidth(
    line.text,
    container.length,
    markerFrom,
    tabSize
  )
  const source = line.text.slice(markerFrom)

  const potentialTask = /^([-+*])([\t ]+)\[([ xX])\]([\t ]+|$)/.exec(source)
  const task =
    potentialTask &&
    hasCommonMarkMarkerPadding(
      line.text,
      markerFrom + potentialTask[1]!.length,
      markerFrom + potentialTask[1]!.length + potentialTask[2]!.length,
      tabSize
    )
      ? potentialTask
      : null
  if (task) {
    const markerTo =
      markerFrom + task[1]!.length + task[2]!.length + task[3]!.length + 2
    return {
      containerLength: container.length,
      contentFrom: markerTo + task[4]!.length,
      delimiter: null,
      indent,
      indentColumns,
      kind: "task",
      markerFrom,
      markerTo,
      quoteDepth: container.quoteDepth,
      spacing: task[4]!,
      taskSpacing: task[4]!,
      token: `${task[1]}${task[2]}[ ]`,
    }
  }

  const ordered = allowContextualAlphabeticMarker
    ? parsePotentialOrderedListMarker(source)
    : parseOrderedListMarker(source)
  if (ordered) {
    const markerLength = ordered.token.length + 1
    const spacing =
      /^[\t ]+/.exec(source.slice(markerLength))?.[0] ??
      (source.length === markerLength ? "" : "")
    const task =
      spacing &&
      hasCommonMarkMarkerPadding(
        line.text,
        markerFrom + markerLength,
        markerFrom + markerLength + spacing.length,
        tabSize
      )
        ? /^\[([ xX])\]([\t ]+|$)/.exec(
            source.slice(markerLength + spacing.length)
          )
        : null
    return {
      containerLength: container.length,
      contentFrom:
        markerFrom +
        markerLength +
        spacing.length +
        (task ? task[1]!.length + task[2]!.length + 2 : 0),
      delimiter: ordered.delimiter,
      indent,
      indentColumns,
      kind: task ? "ordered-task" : "ordered",
      markerFrom,
      markerTo: markerFrom + markerLength,
      quoteDepth: container.quoteDepth,
      spacing,
      taskSpacing: task?.[2] ?? "",
      token: ordered.token,
    }
  }

  const bullet = /^([-+*])([\t ]+|$)/.exec(source)
  if (!bullet) return null
  return {
    containerLength: container.length,
    contentFrom: markerFrom + bullet[0].length,
    delimiter: null,
    indent,
    indentColumns,
    kind: "bullet",
    markerFrom,
    markerTo: markerFrom + 1,
    quoteDepth: container.quoteDepth,
    spacing: bullet[2]!,
    taskSpacing: "",
    token: bullet[1]!,
  }
}

function isOrderedMarker(marker: AuthoredListLineMarker) {
  return marker.kind === "ordered" || marker.kind === "ordered-task"
}

/**
 * Locates the CommonMark marker-to-content padding without interpreting a
 * checkbox-looking prefix as task syntax. That distinction matters when a
 * tab crosses a tab stop: the same authored whitespace can move between the
 * structural 1–4-column bucket and the 5+-column content/code bucket.
 */
function rawListMarkerPadding(
  text: string,
  tabSize: number,
  maximumQuoteDepth = Number.POSITIVE_INFINITY
): RawListMarkerPadding | null {
  const container = markdownContainerPrefix(text, tabSize, maximumQuoteDepth)
  const remainder = text.slice(container.length)
  const indent = /^[\t ]*/.exec(remainder)?.[0] ?? ""
  const markerFrom = container.length + indent.length
  const source = text.slice(markerFrom)
  const ordered = parsePotentialOrderedListMarker(source)
  const orderedLength = ordered ? ordered.token.length + 1 : 0
  const bullet = ordered ? null : /^([-+*])(?=[\t ]|$)/.exec(source)
  const markerLength = orderedLength || (bullet ? 1 : 0)
  if (markerLength === 0) return null

  const markerTo = markerFrom + markerLength
  const spacing = /^[\t ]*/.exec(text.slice(markerTo))?.[0] ?? ""
  return {
    delimiter: ordered?.delimiter ?? null,
    markerFrom,
    markerTo,
    spacing,
    spacingTo: markerTo + spacing.length,
    token: ordered?.token ?? bullet![1]!,
  }
}

function rootUppercaseMarkerMinimumSpacingCharacters(
  marker: RawListMarkerPadding,
  nested: boolean
) {
  return !nested && marker.delimiter === "." && /^[A-Z]$/.test(marker.token)
    ? 2
    : 1
}

/**
 * Preserves the authored marker-padding semantics when a marker moves or
 * changes width. Structural padding may remain authored while it stays in
 * CommonMark's 1–4-column range. For 5+ columns, N-1 columns are literal
 * item content indentation, so both the bucket and exact physical width are
 * preserved. Literal spaces are the deterministic fallback when tabs no
 * longer have the same meaning at the transformed source column.
 */
export function normalizeTransformedListMarkerPadding(
  originalText: string,
  transformedText: string,
  tabSize: number,
  quoteDepth: number,
  nested: boolean
) {
  const original = rawListMarkerPadding(originalText, tabSize, quoteDepth)
  const transformed = rawListMarkerPadding(transformedText, tabSize, quoteDepth)
  if (!original || !transformed || !original.spacing) return transformedText

  const originalColumns = sourceColumnWidth(
    originalText,
    original.markerTo,
    original.spacingTo,
    tabSize
  )
  const transformedColumns = sourceColumnWidth(
    transformedText,
    transformed.markerTo,
    transformed.spacingTo,
    tabSize
  )
  const originalIsStructural = originalColumns >= 1 && originalColumns <= 4
  const minimumCharacters = rootUppercaseMarkerMinimumSpacingCharacters(
    transformed,
    nested
  )
  const authoredSourceStillValid = originalIsStructural
    ? transformedColumns >= 1 &&
      transformedColumns <= 4 &&
      transformed.spacing.length >= minimumCharacters
    : transformedColumns === originalColumns
  if (authoredSourceStillValid) return transformedText

  const originalMarkerColumns = sourceColumnWidth(
    originalText,
    original.markerFrom,
    original.markerTo,
    tabSize
  )
  const transformedMarkerColumns = sourceColumnWidth(
    transformedText,
    transformed.markerFrom,
    transformed.markerTo,
    tabSize
  )
  const structuralColumns = Math.max(
    1,
    Math.min(
      4,
      originalColumns - (transformedMarkerColumns - originalMarkerColumns)
    )
  )
  const replacementColumns = originalIsStructural
    ? Math.max(structuralColumns, minimumCharacters)
    : originalColumns
  return (
    transformedText.slice(0, transformed.markerTo) +
    " ".repeat(replacementColumns) +
    transformedText.slice(transformed.spacingTo)
  )
}

export function shiftTransformedListLineIndentation(
  state: EditorState,
  originalText: string,
  transformedText: string,
  quoteDepth: number,
  delta: number,
  nested: boolean
) {
  if (delta === 0) return transformedText
  const prefix = linePrefix(transformedText, state.tabSize, false, quoteDepth)
  if (!transformedText.slice(prefix.containerLength).trim()) {
    return transformedText
  }
  const replacement = listIndentationReplacementForText(
    state,
    transformedText,
    prefix,
    prefix.indentColumns + delta,
    false
  )
  const shifted =
    transformedText.slice(0, replacement.from) +
    replacement.source +
    transformedText.slice(replacement.to)
  return normalizeTransformedListMarkerPadding(
    originalText,
    shifted,
    state.tabSize,
    quoteDepth,
    nested
  )
}

function directListItemAt(
  state: EditorState,
  position: number,
  tree = syntaxTree(state)
) {
  const line = state.doc.lineAt(position)
  const candidates: ReadonlyArray<readonly [number, -1 | 1]> = [
    [Math.min(line.to, Math.max(line.from, position)), -1],
    [line.from, 1],
  ]
  for (const [candidate, side] of candidates) {
    const item = parentListItem(tree.resolveInner(candidate, side))
    const mark = item ? directListMark(item) : null
    if (item && mark && state.doc.lineAt(mark.from).number === line.number) {
      return item
    }
  }
  return null
}

function parsedAuthoredListLineMarker(state: EditorState, line: Line) {
  // Authored marker-like text inside an indented code block is not a list
  // item and must never participate in continuation or renumbering edits.
  if (!directListItemAt(state, line.to, completeMarkdownSyntaxTree(state))) {
    return null
  }
  const conservative = authoredListLineMarker(line, state.tabSize)
  if (conservative) return conservative
  const contextual = authoredListLineMarker(line, state.tabSize, true)
  return contextual
}

function lineBelongsToListItemBranch(
  state: EditorState,
  line: Line,
  root: SyntaxNode
) {
  const tree = syntaxTree(state)
  const positions: ReadonlyArray<readonly [number, -1 | 1]> = [
    [line.from, 1],
    [Math.max(line.from, line.to - 1), -1],
  ]
  for (const [position, side] of positions) {
    let node: SyntaxNode | null = tree.resolveInner(position, side)
    while (node) {
      if (node.name === "ListItem" && node.from === root.from) return true
      node = node.parent
    }
  }
  return false
}

function neighboringOrderedToken(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker,
  direction: -1 | 1
) {
  let number = line.number + direction
  const boundary =
    direction < 0
      ? Math.max(1, line.number - orderedMarkerNeighborLineLimit)
      : Math.min(state.doc.lines, line.number + orderedMarkerNeighborLineLimit)
  while (
    number >= 1 &&
    number <= state.doc.lines &&
    (direction < 0 ? number >= boundary : number <= boundary)
  ) {
    const candidateLine = state.doc.line(number)
    const candidate = parsedAuthoredListLineMarker(state, candidateLine)
    if (candidate) {
      if (
        candidate.quoteDepth < marker.quoteDepth ||
        (candidate.quoteDepth === marker.quoteDepth &&
          candidate.indentColumns < marker.indentColumns)
      ) {
        return null
      }
      if (
        candidate.quoteDepth === marker.quoteDepth &&
        candidate.indentColumns === marker.indentColumns
      ) {
        return isOrderedMarker(candidate) &&
          candidate.delimiter === marker.delimiter
          ? candidate.token
          : null
      }
    } else {
      const prefix = linePrefix(candidateLine.text, state.tabSize)
      const content = candidateLine.text.slice(prefix.containerLength)
      if (
        content.trim() &&
        (prefix.quoteDepth < marker.quoteDepth ||
          (prefix.quoteDepth === marker.quoteDepth &&
            prefix.indentColumns <= marker.indentColumns))
      ) {
        return null
      }
    }
    number += direction
  }
  return null
}

function orderedFamilyAt(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker
) {
  return inferOrderedListMarkerFamily(
    marker.token,
    neighboringOrderedToken(state, line, marker, -1),
    neighboringOrderedToken(state, line, marker, 1)
  )
}

function continuedMarkerSource(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker
) {
  const authoredSpacing = marker.spacing || " "
  if (marker.kind === "bullet") return marker.token + authoredSpacing
  if (marker.kind === "task") return marker.token + authoredSpacing

  const family = orderedFamilyAt(state, line, marker)
  const value = family ? orderedListMarkerOrdinal(marker.token, family) : null
  const next =
    value == null || !family
      ? null
      : orderedListMarkerToken(
          value + 1,
          family,
          family === "decimal" ? decimalMinimumWidth(marker.token) : 0
        )
  // The empty string deliberately means that the marker family has reached a
  // representable limit (nine decimal digits or Roman 3999). The caller can
  // insert an ordinary line without manufacturing invalid Markdown. `null`
  // remains the signal for an unproven authored family.
  if (!next) return value != null && family ? "" : null
  const spacing = orderedSpacingForReplacement(state, line, marker, next)
  const task =
    marker.kind === "ordered-task" ? `[ ]${marker.taskSpacing || " "}` : ""
  return `${next}${marker.delimiter}${spacing}${task}`
}

function decimalMinimumWidth(token: string) {
  return /^0\d/.test(token) ? token.length : 0
}

function orderedSpacingForReplacement(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker,
  replacementToken: string
) {
  const authoredSpacing = marker.spacing || " "
  const delimiter = marker.delimiter ?? "."
  const transformed =
    line.text.slice(0, marker.markerFrom) +
    replacementToken +
    delimiter +
    authoredSpacing +
    line.text.slice(marker.markerTo + marker.spacing.length)
  const item = directListItemAt(
    state,
    line.to,
    completeMarkdownSyntaxTree(state)
  )
  const nested = item ? parentListItem(item.parent) != null : false
  const normalized = normalizeTransformedListMarkerPadding(
    line.text,
    transformed,
    state.tabSize,
    marker.quoteDepth,
    nested
  )
  return (
    rawListMarkerPadding(normalized, state.tabSize, marker.quoteDepth)
      ?.spacing ?? authoredSpacing
  )
}

function orderedMarkerContentColumnDelta(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker,
  replacement: string,
  replacementSpacing: string
) {
  const before = linePrefix(line.text, state.tabSize, true)
  const changedText =
    line.text.slice(0, marker.markerFrom) +
    replacement +
    (marker.delimiter ?? "") +
    replacementSpacing +
    line.text.slice(marker.markerTo + marker.spacing.length)
  const after = linePrefix(changedText, state.tabSize, true)
  return after.contentIndentColumns - before.contentIndentColumns
}

function replaceIndentationInText(
  state: EditorState,
  text: string,
  quoteDepth: number,
  delta: number
) {
  if (delta === 0) return text
  const prefix = linePrefix(text, state.tabSize, false, quoteDepth)
  if (!text.slice(prefix.containerLength).trim()) return text
  const replacement = listIndentationReplacementForText(
    state,
    text,
    prefix,
    prefix.indentColumns + delta,
    false
  )
  return (
    text.slice(0, replacement.from) +
    replacement.source +
    text.slice(replacement.to)
  )
}

function minimalLineSourceChange(line: Line, replacement: string) {
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
  } satisfies SourceChange
}

function descendantListItems(state: EditorState, root: SyntaxNode) {
  const descendants: ListItemModel[] = []
  const visit = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "ListItem") {
        const item = semanticListItem(state, child)
        if (item) descendants.push(item)
      }
      visit(child)
    }
  }
  visit(root)
  return descendants.sort((left, right) => left.startLine - right.startLine)
}

function recursiveListItemBranchIndentChanges(
  state: EditorState,
  root: SyntaxNode,
  rootQuoteDepth: number,
  delta: number
) {
  const rootItem = semanticListItem(state, root)
  if (!rootItem || delta === 0) return []

  const replacements = new Map<number, string>()
  const shiftLines = (
    fromLine: number,
    toLine: number,
    quoteDepth: number,
    amount: number
  ) => {
    if (amount === 0) return
    for (let number = fromLine; number <= toLine; number += 1) {
      const original = state.doc.line(number)
      const current = replacements.get(number) ?? original.text
      const replacement = replaceIndentationInText(
        state,
        current,
        quoteDepth,
        amount
      )
      if (replacement !== original.text) replacements.set(number, replacement)
      else replacements.delete(number)
    }
  }

  shiftLines(rootItem.startLine + 1, rootItem.endLine, rootQuoteDepth, delta)
  for (const item of descendantListItems(state, root)) {
    const original = state.doc.line(item.startLine).text
    const shifted = replacements.get(item.startLine) ?? original
    const replacement = normalizeTransformedListMarkerPadding(
      original,
      shifted,
      state.tabSize,
      item.quoteDepth,
      parentListItem(item.node.parent) != null
    )
    if (replacement !== original) {
      replacements.set(item.startLine, replacement)
    } else {
      replacements.delete(item.startLine)
    }
    if (item.startLine >= item.endLine) continue
    const originalPrefix = linePrefix(
      original,
      state.tabSize,
      true,
      item.quoteDepth
    )
    const replacementPrefix = linePrefix(
      replacement,
      state.tabSize,
      true,
      item.quoteDepth
    )
    const correction =
      replacementPrefix.contentIndentColumns -
      originalPrefix.contentIndentColumns
    shiftLines(item.startLine + 1, item.endLine, item.quoteDepth, correction)
  }

  const changes: SourceChange[] = []
  for (const [number, replacement] of [...replacements].sort(
    ([left], [right]) => left - right
  )) {
    const change = minimalLineSourceChange(state.doc.line(number), replacement)
    if (change) changes.push(change)
  }
  return changes
}

function orderedItemBranchIndentChanges(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker,
  replacement: string,
  replacementSpacing = marker.spacing
): SourceChange[] {
  const delta = orderedMarkerContentColumnDelta(
    state,
    line,
    marker,
    replacement,
    replacementSpacing
  )
  if (delta === 0) return []

  const tree = completeMarkdownSyntaxTree(state)
  const itemNode = semanticListItemAtLine(tree, line, line.to)
  const item = itemNode ? semanticListItem(state, itemNode) : null
  if (!item || item.startLine !== line.number) return []

  return recursiveListItemBranchIndentChanges(
    state,
    item.node,
    item.quoteDepth,
    delta
  )
}

function followingOrderedMarkerChanges(
  state: EditorState,
  line: Line,
  marker: AuthoredListLineMarker,
  family: OrderedListMarkerFamily,
  delta: -1 | 1
): ChangeSpec[] | null {
  const firstValue = orderedListMarkerOrdinal(marker.token, family)
  if (firstValue == null) return []

  const branch = directListItemAt(state, line.to)
  const changes: ChangeSpec[] = []
  let previousValue = firstValue
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidateLine = state.doc.line(number)
    const candidate = parsedAuthoredListLineMarker(state, candidateLine)
    if (!candidate) {
      const prefix = linePrefix(candidateLine.text, state.tabSize)
      const content = candidateLine.text.slice(prefix.containerLength)
      if (
        content.trim() &&
        (prefix.quoteDepth < marker.quoteDepth ||
          (prefix.quoteDepth === marker.quoteDepth &&
            prefix.indentColumns <= marker.indentColumns)) &&
        (!branch || !lineBelongsToListItemBranch(state, candidateLine, branch))
      ) {
        break
      }
      continue
    }

    if (
      candidate.quoteDepth < marker.quoteDepth ||
      (candidate.quoteDepth === marker.quoteDepth &&
        candidate.indentColumns < marker.indentColumns)
    ) {
      break
    }
    if (
      candidate.quoteDepth !== marker.quoteDepth ||
      candidate.indentColumns !== marker.indentColumns
    ) {
      continue
    }
    if (
      !isOrderedMarker(candidate) ||
      candidate.delimiter !== marker.delimiter
    ) {
      break
    }

    const value = orderedListMarkerOrdinal(candidate.token, family)
    if (value !== previousValue + 1) break
    const replacement = orderedListMarkerToken(
      value + delta,
      family,
      family === "decimal" ? decimalMinimumWidth(candidate.token) : 0
    )
    // A sequence cannot be partially renumbered when its final marker would
    // leave the representable CommonMark/family range. Let the caller insert
    // an ordinary line instead, leaving the authored sequence untouched.
    if (!replacement) return null
    const replacementSpacing = orderedSpacingForReplacement(
      state,
      candidateLine,
      candidate,
      replacement
    )
    changes.push({
      from: candidateLine.from + candidate.markerFrom,
      to: candidateLine.from + candidate.markerTo - 1,
      insert: replacement,
    })
    if (replacementSpacing !== candidate.spacing) {
      changes.push({
        from: candidateLine.from + candidate.markerTo,
        to: candidateLine.from + candidate.markerTo + candidate.spacing.length,
        insert: replacementSpacing,
      })
    }
    changes.push(
      ...orderedItemBranchIndentChanges(
        state,
        candidateLine,
        candidate,
        replacement,
        replacementSpacing
      )
    )
    previousValue = value
  }
  return changes
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

function directlyContainingListItem(item: SyntaxNode) {
  const list = item.parent
  return list?.parent?.name === "ListItem" ? list.parent : null
}

interface CustomListEnter {
  readonly changes: ChangeSpec
  readonly cursor: number
}

function customListEnter(
  state: EditorState,
  range: SelectionRange,
  renumber: boolean
): CustomListEnter | null {
  if (!range.empty) return null
  const line = state.doc.lineAt(range.head)
  const marker = authoredListLineMarker(line, state.tabSize, true)
  const item = marker ? directListItemAt(state, range.head) : null
  if (!marker || !item || range.head < line.from + marker.contentFrom) {
    return null
  }

  const contentEmpty = !state
    .sliceDoc(line.from + marker.contentFrom, line.to)
    .trim()
  const contentBeforeCaretEmpty = !state
    .sliceDoc(line.from + marker.contentFrom, range.head)
    .trim()

  const changes: ChangeSpec[] = []
  if (contentEmpty || contentBeforeCaretEmpty) {
    if (renumber && isOrderedMarker(marker)) {
      const family = orderedFamilyAt(state, line, marker)
      if (family) {
        const renumbering = followingOrderedMarkerChanges(
          state,
          line,
          marker,
          family,
          -1
        )
        if (!renumbering) return null
        changes.push(...renumbering)
      }
    }

    // A list inside a blockquote owned by another item is root-level within
    // that quote. Exiting its empty item must preserve the quote instead of
    // jumping across that container and continuing the outer list.
    const parent = directlyContainingListItem(item)
    let insert = ""
    if (parent) {
      const parentMark = directListMark(parent)
      const parentLine = parentMark ? state.doc.lineAt(parentMark.from) : null
      const parentMarker = parentLine
        ? parsedAuthoredListLineMarker(state, parentLine)
        : null
      let continued =
        parentLine && parentMarker
          ? continuedMarkerSource(state, parentLine, parentMarker)
          : null
      if (!parentLine || !parentMarker || continued == null) return null

      if (renumber && continued && isOrderedMarker(parentMarker)) {
        const family = orderedFamilyAt(state, parentLine, parentMarker)
        if (family) {
          const renumbering = followingOrderedMarkerChanges(
            state,
            parentLine,
            parentMarker,
            family,
            1
          )
          if (!renumbering) continued = ""
          else changes.push(...renumbering)
        }
      }
      insert = parentMarker.indent + continued
    }

    const from = line.from + marker.containerLength
    changes.push({ from, to: contentEmpty ? line.to : range.head, insert })
    return { changes, cursor: from + insert.length }
  }

  let continued = continuedMarkerSource(state, line, marker)
  if (continued == null) return null
  const family = isOrderedMarker(marker)
    ? orderedFamilyAt(state, line, marker)
    : null
  if (renumber && family && continued) {
    const renumbering = followingOrderedMarkerChanges(
      state,
      line,
      marker,
      family,
      1
    )
    if (!renumbering) continued = ""
    else changes.push(...renumbering)
  }

  let from = range.head
  while (
    from > line.from + marker.contentFrom &&
    /\s/.test(state.sliceDoc(from - 1, from))
  ) {
    from -= 1
  }
  const authoredPrefix = line.text.slice(0, marker.markerFrom)
  const insert = state.lineBreak + authoredPrefix + continued
  changes.push({ from, to: range.head, insert })
  return { changes, cursor: from + insert.length }
}

function fallbackEnterAt(
  state: EditorState,
  range: SelectionRange
): CustomListEnter {
  const isolatedState = state.update({
    selection: EditorSelection.single(range.anchor, range.head),
  }).state
  const captured: { transaction?: Transaction } = {}
  const target = {
    state: isolatedState,
    dispatch(value: Transaction) {
      captured.transaction = value
    },
  }
  if (!insertNewlineContinueCommonMarkList(target as EditorView)) {
    insertNewlineAndIndent(target)
  }
  const transaction = captured.transaction
  if (!transaction)
    throw new Error("Enter command did not produce a transaction")
  return {
    changes: transaction.changes,
    cursor: transaction.newSelection.main.head,
  }
}

function isSlashSeparatedHtmlTagReferenceLine(
  state: EditorState,
  range: SelectionRange
) {
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const sourceBeforeCaret = state.sliceDoc(line.from, range.head)
  if (
    !/^ {0,3}<[A-Za-z][\w:-]*>\s*\/\s*<[A-Za-z][\w:-]*>/.test(sourceBeforeCaret)
  ) {
    return false
  }

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, -1)
  while (node && node.name !== "HTMLBlock") node = node.parent
  return node?.name === "HTMLBlock"
}

/**
 * A line such as `<details>/<summary> prose` uses slash-separated tag names
 * as references, not as a deliberately nested HTML editing context. Lezer's
 * HTML overlay sees two unclosed elements and CodeMirror consequently indents
 * the following line. Handle only this distinctive prose form with a plain
 * newline, leaving ordinary and multiline raw HTML indentation unchanged.
 */
function insertNewlineAfterHtmlTagReferences(view: EditorView) {
  const { state } = view
  if (
    state.readOnly ||
    !state.selection.ranges.every((range) =>
      isSlashSeparatedHtmlTagReferenceLine(state, range)
    )
  ) {
    return false
  }
  return insertNewline(view)
}

function dispatchSequentialListEnters(view: EditorView) {
  const initialState = view.state
  let state = initialState
  let changes = initialState.changes([])
  const ranges = [...initialState.selection.ranges]

  // Work upward so an insertion or renumbering below a pending caret cannot
  // change which authored item that caret addresses. Each ordered edit then
  // sees the result below it and can renumber the complete remaining family.
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!
    const entry =
      customListEnter(state, range, true) ?? fallbackEnterAt(state, range)

    const transaction = state.update({ changes: entry.changes })
    for (let other = 0; other < ranges.length; other += 1) {
      if (other === index) continue
      ranges[other] = ranges[other]!.map(transaction.changes)
    }
    ranges[index] = EditorSelection.cursor(entry.cursor)
    changes = changes.compose(transaction.changes)
    state = transaction.state
  }

  view.dispatch(
    initialState.update({
      changes,
      selection: EditorSelection.create(
        ranges,
        initialState.selection.mainIndex
      ),
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

/**
 * Continues authored bullet, task, decimal, alphabetic, and Roman markers.
 * Empty items use the same structural path for every marker family so each
 * Enter lifts exactly one level and visibly returns to the parent list's
 * content lane. Continuation lines and non-list contexts retain CodeMirror's
 * Markdown-aware fallback behavior.
 */
export const insertNewlineContinueList: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  if (insertNewlineAfterHtmlTagReferences(view)) return true

  const custom = state.selection.ranges.map((range) =>
    customListEnter(state, range, state.selection.ranges.length === 1)
  )
  if (custom.every((entry) => entry == null)) {
    return insertNewlineContinueCommonMarkList(view)
  }
  if (custom.length > 1) return dispatchSequentialListEnters(view)
  if (custom.some((entry) => entry == null)) return false

  let rangeIndex = 0
  const transaction = state.changeByRange(() => {
    const entry = custom[rangeIndex++]!
    return {
      changes: entry.changes,
      range: EditorSelection.cursor(entry.cursor),
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

/**
 * Shift+Enter ends the current list branch without carrying its authored list
 * indentation onto the next line. Blockquote containers remain intact, but a
 * nested list exits directly to that container's prose column.
 */
export const insertNewlineExitList: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false

  const entries = state.selection.ranges.map((range) => {
    if (!range.empty) return null
    const line = state.doc.lineAt(range.head)
    const marker = authoredListLineMarker(line, state.tabSize, true)
    const item = marker ? directListItemAt(state, range.head) : null
    if (!marker || !item || range.head < line.from + marker.contentFrom) {
      return null
    }

    let from = range.head
    while (
      from > line.from + marker.contentFrom &&
      /[\t ]/.test(state.sliceDoc(from - 1, from))
    ) {
      from -= 1
    }
    const container = line.text.slice(0, marker.containerLength)
    const insert = state.lineBreak + container
    return { from, to: range.head, insert, cursor: from + insert.length }
  })
  if (entries.some((entry) => entry === null)) return false

  let rangeIndex = 0
  const transaction = state.changeByRange(() => {
    const entry = entries[rangeIndex++]!
    return {
      changes: { from: entry.from, to: entry.to, insert: entry.insert },
      range: EditorSelection.cursor(entry.cursor),
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

function emptyOrderedListItemAt(
  state: EditorState,
  position: number
): EmptyOrderedListItem | null {
  const line = state.doc.lineAt(position)
  const authored = authoredListLineMarker(line, state.tabSize, true)
  const item = authored ? directListItemAt(state, position) : null
  const list = item?.parent
  if (
    !authored ||
    !isOrderedMarker(authored) ||
    !item ||
    list?.name !== "OrderedList" ||
    position < line.from + authored.contentFrom ||
    state.sliceDoc(line.from + authored.contentFrom, line.to).trim()
  ) {
    return null
  }

  const marker = directListMark(item)
  if (!marker || state.doc.lineAt(marker.from).number !== line.number) {
    return null
  }
  return { item, list, marker }
}

function orderedMarker(
  state: EditorState,
  item: SyntaxNode
): { from: number; number: number; to: number } | null {
  const marker = directListMark(item)
  if (!marker) return null
  const digits = /^\d+/.exec(state.sliceDoc(marker.from, marker.to))?.[0]
  return digits
    ? {
        from: marker.from,
        number: Number(digits),
        to: marker.from + digits.length,
      }
    : null
}

function orderedListRenumberChanges(
  state: EditorState,
  removedItems: readonly EmptyOrderedListItem[],
  deletion: Transaction
) {
  const confirmed = removedItems.filter(({ marker }) =>
    deletion.changes.touchesRange(marker.from, marker.to)
  )
  const groups = new Map<
    string,
    { list: SyntaxNode; removedItemStarts: Set<number> }
  >()

  for (const { item, list } of confirmed) {
    const key = `${list.from}:${list.to}`
    const group = groups.get(key) ?? {
      list,
      removedItemStarts: new Set<number>(),
    }
    group.removedItemStarts.add(item.from)
    groups.set(key, group)
  }

  const changes: Array<{ from: number; insert: string; to: number }> = []
  for (const { list, removedItemStarts } of groups.values()) {
    const items: SyntaxNode[] = []
    for (let child = list.firstChild; child; child = child.nextSibling) {
      if (child.name === "ListItem") items.push(child)
    }
    const firstRemoved = items.findIndex((item) =>
      removedItemStarts.has(item.from)
    )
    if (firstRemoved < 0) continue

    const firstMarker = orderedMarker(state, items[firstRemoved]!)
    if (!firstMarker) continue
    let previousNumber = firstMarker.number
    let removedCount = 1

    for (let index = firstRemoved + 1; index < items.length; index += 1) {
      const item = items[index]!
      const marker = orderedMarker(state, item)
      if (!marker || marker.number !== previousNumber + 1) break
      previousNumber = marker.number

      if (removedItemStarts.has(item.from)) {
        removedCount += 1
        continue
      }
      const line = state.doc.lineAt(marker.from)
      const authored = parsedAuthoredListLineMarker(state, line)
      const replacement =
        authored && /^\d+$/.test(authored.token)
          ? orderedListMarkerToken(
              marker.number - removedCount,
              "decimal",
              decimalMinimumWidth(authored.token)
            )
          : null
      if (!replacement) break
      changes.push({
        from: marker.from,
        to: marker.to,
        insert: replacement,
      })
      if (authored) {
        const replacementSpacing = orderedSpacingForReplacement(
          state,
          line,
          authored,
          replacement
        )
        if (replacementSpacing !== authored.spacing) {
          changes.push({
            from: line.from + authored.markerTo,
            to: line.from + authored.markerTo + authored.spacing.length,
            insert: replacementSpacing,
          })
        }
        changes.push(
          ...orderedItemBranchIndentChanges(
            state,
            line,
            authored,
            replacement,
            replacementSpacing
          )
        )
      }
    }
  }
  return changes
}

function retainedOrderedListContentIndentChanges(
  state: EditorState,
  removedItems: readonly EmptyOrderedListItem[],
  deletion: Transaction
) {
  const changes: ChangeSpec[] = []

  for (const { item, marker } of removedItems) {
    if (!deletion.changes.touchesRange(marker.from, marker.to)) continue

    let previousItem = item.prevSibling
    while (previousItem && previousItem.name !== "ListItem") {
      previousItem = previousItem.prevSibling
    }
    if (!previousItem) continue

    const previousMarker = directListMark(previousItem)
    if (!previousMarker) continue
    const previousPrefix = linePrefix(
      state.doc.lineAt(previousMarker.from).text,
      state.tabSize,
      true
    )
    const desiredIndent =
      previousPrefix.indentColumns + previousPrefix.contentIndentColumns

    const mappedMarker = deletion.changes.mapPos(marker.from, -1)
    const line = deletion.state.doc.lineAt(mappedMarker)
    const prefix = linePrefix(line.text, deletion.state.tabSize)
    if (line.text.slice(prefix.containerLength).trim()) continue

    const replacement = listIndentationSource(
      deletion.state,
      line,
      prefix,
      desiredIndent,
      true
    )
    const current = line.text.slice(replacement.from, replacement.to)
    if (replacement.source === current) continue
    changes.push({
      from: line.from + replacement.from,
      to: line.from + replacement.to,
      insert: replacement.source,
    })
  }

  return changes
}

function deleteAuthoredOrderedListMarkup(view: EditorView) {
  const { state } = view
  if (state.selection.ranges.length !== 1) return false
  const range = state.selection.main
  if (!range.empty) return false

  const line = state.doc.lineAt(range.head)
  const marker = authoredListLineMarker(line, state.tabSize, true)
  const item = marker ? directListItemAt(state, range.head) : null
  const customDeletion =
    marker?.kind === "ordered-task" ||
    (marker?.kind === "ordered" && !/^\d+$/.test(marker.token))
  if (
    !marker ||
    !item ||
    !customDeletion ||
    range.head < line.from + marker.contentFrom ||
    state.sliceDoc(line.from + marker.contentFrom, line.to).trim()
  ) {
    return false
  }

  const family = orderedFamilyAt(state, line, marker)
  const changes = family
    ? (followingOrderedMarkerChanges(state, line, marker, family, -1) ?? [])
    : []
  const contentColumns = sourceColumnWidth(
    line.text,
    marker.containerLength,
    marker.contentFrom,
    state.tabSize
  )
  const prefix = linePrefix(line.text, state.tabSize, true)
  const replacement = listIndentationSource(
    state,
    line,
    prefix,
    contentColumns,
    false
  )
  const from = line.from + replacement.from
  changes.push({ from, to: line.to, insert: replacement.source })
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(from + replacement.source.length),
    scrollIntoView: true,
    userEvent: "delete",
  })
  return true
}

/**
 * Preserves CodeMirror's Markdown-aware Backspace behavior and also reverses
 * the ordered-sibling renumbering performed by Enter when that newly inserted
 * empty marker is removed. The resulting blank line retains the previous
 * sibling's authored content column so a replacement list belongs to it.
 */
export const deleteListMarkupBackward: Command = (view) => {
  const { state } = view
  const removedItems = state.selection.ranges.flatMap((range) => {
    if (!range.empty) return []
    const item = emptyOrderedListItemAt(state, range.head)
    return item ? [item] : []
  })
  const captured: { deletion?: Transaction } = {}
  const handled = deleteMarkupBackward({
    state,
    dispatch(transaction: Transaction) {
      captured.deletion = transaction
    },
  } as EditorView)
  const deletion = captured.deletion
  if (!handled || !deletion) return deleteAuthoredOrderedListMarkup(view)

  const renumbering = orderedListRenumberChanges(state, removedItems, deletion)
  const mappedRenumbering = renumbering.map((change) => ({
    ...change,
    from: deletion.changes.mapPos(change.from, 1),
    to: deletion.changes.mapPos(change.to, -1),
  }))
  const retainedIndentation = retainedOrderedListContentIndentChanges(
    state,
    removedItems,
    deletion
  )
  const followup = [...mappedRenumbering, ...retainedIndentation]
  if (followup.length === 0) {
    view.dispatch(deletion)
    return true
  }

  const followupChanges = deletion.state.changes(followup)
  view.dispatch(
    state.update({
      changes: deletion.changes.compose(followupChanges),
      selection: deletion.newSelection.map(followupChanges),
      scrollIntoView: deletion.scrollIntoView,
      userEvent: "delete",
    })
  )
  return true
}

function semanticListItem(
  state: EditorState,
  node: SyntaxNode
): ListItemModel | null {
  const mark = directListMark(node)
  if (!mark) return null
  const startLine = state.doc.lineAt(mark.from).number
  const prefix = linePrefix(state.doc.line(startLine).text, state.tabSize, true)
  return {
    containerPadding: prefix.containerTrailingPaddingLength ? " " : "",
    contentIndentColumns: prefix.contentIndentColumns,
    endLine: state.doc.lineAt(Math.max(mark.from, node.to - 1)).number,
    indent: prefix.indent,
    indentColumns: prefix.indentColumns,
    node,
    quoteDepth: prefix.quoteDepth,
    startLine,
  }
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

function previousSiblingListItem(node: SyntaxNode) {
  for (let sibling = node.prevSibling; sibling; sibling = sibling.prevSibling) {
    if (sibling.name === "ListItem") return sibling
  }
  return null
}

function previousAdjacentListItem(node: SyntaxNode) {
  const list = node.parent
  if (list?.name !== "OrderedList" && list?.name !== "BulletList") {
    return null
  }
  const previousList = list.prevSibling
  if (
    previousList?.name !== "OrderedList" &&
    previousList?.name !== "BulletList"
  ) {
    return null
  }

  for (let child = previousList.lastChild; child; child = child.prevSibling) {
    if (child.name === "ListItem") return child
  }
  return null
}

function onlyBlankLinesBetween(
  state: EditorState,
  previousEndLine: number,
  currentStartLine: number
) {
  for (
    let number = previousEndLine + 1;
    number < currentStartLine;
    number += 1
  ) {
    if (state.doc.line(number).text.trim()) return false
  }
  return true
}

function sameParentItem(left: SyntaxNode, right: SyntaxNode) {
  const leftParent = parentListItem(left.parent)
  const rightParent = parentListItem(right.parent)
  return leftParent?.from === rightParent?.from
}

function firstDirectChildListItem(state: EditorState, item: SyntaxNode) {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name !== "OrderedList" && child.name !== "BulletList") continue
    for (let nested = child.firstChild; nested; nested = nested.nextSibling) {
      if (nested.name !== "ListItem") continue
      const model = semanticListItem(state, nested)
      if (model) return model
    }
  }
  return null
}

interface OrderedSequencePosition {
  readonly delimiter: "." | ")"
  readonly family: OrderedListMarkerFamily
  readonly minimumWidth: number
  readonly ordinal: number
}

function orderedSequencePosition(
  state: EditorState,
  item: ListItemModel
): OrderedSequencePosition | null {
  const line = state.doc.line(item.startLine)
  const marker = parsedAuthoredListLineMarker(state, line)
  if (!marker || !isOrderedMarker(marker) || !marker.delimiter) return null
  const family = orderedFamilyAt(state, line, marker)
  const ordinal = family ? orderedListMarkerOrdinal(marker.token, family) : null
  return family && ordinal != null
    ? {
        delimiter: marker.delimiter,
        family,
        minimumWidth:
          family === "decimal" ? decimalMinimumWidth(marker.token) : 0,
        ordinal,
      }
    : null
}

function previousListItem(
  state: EditorState,
  tree: ReturnType<typeof completeMarkdownSyntaxTree>,
  item: ListItemModel
) {
  const semanticSibling = previousSiblingListItem(item.node)
  if (semanticSibling) return semanticListItem(state, semanticSibling)

  const adjacentContainerItem = previousAdjacentListItem(item.node)
  const adjacentContainer = adjacentContainerItem
    ? semanticListItem(state, adjacentContainerItem)
    : null
  if (
    adjacentContainer &&
    adjacentContainer.endLine < item.startLine &&
    onlyBlankLinesBetween(state, adjacentContainer.endLine, item.startLine) &&
    adjacentContainer.indentColumns === item.indentColumns &&
    adjacentContainer.quoteDepth === item.quoteDepth &&
    sameParentItem(adjacentContainer.node, item.node)
  ) {
    return adjacentContainer
  }

  if (item.startLine <= 1) return null

  const previousLine = state.doc.line(item.startLine - 1)
  const adjacentNode = semanticListItemAtLine(
    tree,
    previousLine,
    previousLine.to
  )
  const adjacent = adjacentNode ? semanticListItem(state, adjacentNode) : null
  return adjacent &&
    adjacent.endLine === item.startLine - 1 &&
    adjacent.indentColumns === item.indentColumns &&
    adjacent.quoteDepth === item.quoteDepth &&
    sameParentItem(adjacent.node, item.node)
    ? adjacent
    : null
}

function linesTouchedByRange(state: EditorState, range: SelectionRange) {
  const lines = []
  const finalPosition = range.empty
    ? range.head
    : Math.max(range.from, range.to - 1)
  let line = state.doc.lineAt(range.from)
  const finalLine = state.doc.lineAt(finalPosition).number

  while (line.number <= finalLine) {
    lines.push(line)
    if (line.number === state.doc.lines) break
    line = state.doc.line(line.number + 1)
  }
  return lines
}

function parsedListItemAt(state: EditorState, position: number) {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1)
  while (node) {
    if (node.name === "ListItem") return true
    node = node.parent
  }
  return false
}

function nearbyListMarkerBefore(state: EditorState, line: Line) {
  const iterator = state.doc.iterRange(line.from, 0)
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    if (next.lineBreak) continue
    if (!next.value.trim()) return false
    if (linePrefix(next.value, state.tabSize).markerLength > 0) return true
  }
  return false
}

/**
 * Rejects the overwhelmingly common prose-Tab case without materializing the
 * document-wide list model. A marker, parsed ListItem ancestor, or indented
 * continuation remains eligible for the exact semantic/fallback model below.
 */
function selectionMayTouchListItem(state: EditorState) {
  for (const range of state.selection.ranges) {
    const lines = linesTouchedByRange(state, range)
    for (const line of lines) {
      const prefix = linePrefix(line.text, state.tabSize)
      if (
        prefix.markerLength > 0 ||
        prefix.indentColumns > 0 ||
        parsedListItemAt(
          state,
          Math.min(line.to, Math.max(line.from, range.head))
        )
      ) {
        return true
      }
    }
    const firstLine = lines[0]
    if (firstLine?.text.trim() && nearbyListMarkerBefore(state, firstLine)) {
      return true
    }
  }
  return false
}

function listItemBlocks(state: EditorState): ListItemBlock[] | null {
  if (!selectionMayTouchListItem(state)) return null
  const tree = completeMarkdownSyntaxTree(state)
  const selectedLines = new Map<number, Line>()
  for (const range of state.selection.ranges) {
    for (const line of linesTouchedByRange(state, range)) {
      selectedLines.set(line.number, line)
    }
  }

  const selectedItems = new Map<number, ListItemModel>()
  for (const line of [...selectedLines.values()].sort(
    (left, right) => left.number - right.number
  )) {
    const itemNode = semanticListItemAtLine(tree, line, line.to)
    const item = itemNode ? semanticListItem(state, itemNode) : null
    if (!item || line.number < item.startLine || line.number > item.endLine) {
      if (line.text.trim() === "") continue
      return null
    }
    selectedItems.set(item.startLine, item)
  }

  const sortedItems = [...selectedItems.values()].sort(
    (left, right) =>
      left.startLine - right.startLine || right.endLine - left.endLine
  )
  const outermost: ListItemModel[] = []
  let containingEndLine = -1
  for (const item of sortedItems) {
    if (item.endLine <= containingEndLine) continue
    outermost.push(item)
    containingEndLine = item.endLine
  }
  if (outermost.length === 0) return null

  const blocks: ListItemBlock[] = []
  let previousSelected: ListItemModel | null = null
  let groupIndentTargetColumns: number | null = null
  let groupIndentTargetSource: string | null = null
  let previousOrderedAtTarget: {
    delimiter: "." | ")"
    family: OrderedListMarkerFamily
    finalOrdinal: number
    originalOrdinal: number
  } | null = null
  let previousDedentOrderedAtTarget: OrderedSequencePosition | null = null
  for (const item of outermost) {
    const previous = previousListItem(state, tree, item)
    const parentNode = parentListItem(item.node.parent)
    const parent = parentNode ? semanticListItem(state, parentNode) : null
    const continuesSelectedSiblingGroup =
      previousSelected != null &&
      previous?.node.from === previousSelected.node.from &&
      item.indentColumns === previousSelected.indentColumns &&
      item.quoteDepth === previousSelected.quoteDepth &&
      sameParentItem(item.node, previousSelected.node)
    if (!continuesSelectedSiblingGroup) {
      groupIndentTargetColumns = previous
        ? previous.indentColumns + previous.contentIndentColumns
        : null
      groupIndentTargetSource = previous
        ? (firstDirectChildListItem(state, previous.node)?.indent ?? null)
        : null
      previousOrderedAtTarget = null
      previousDedentOrderedAtTarget = parent
        ? orderedSequencePosition(state, parent)
        : null
    }
    const line = state.doc.line(item.startLine)
    const marker = parsedAuthoredListLineMarker(state, line)
    let indentMarkerTokenReplacement: string | null = null
    let dedentMarkerTokenReplacement: string | null = null
    if (marker && isOrderedMarker(marker) && marker.delimiter) {
      const family = orderedFamilyAt(state, line, marker)
      const originalOrdinal = family
        ? orderedListMarkerOrdinal(marker.token, family)
        : null
      if (family && originalOrdinal != null) {
        const standalone =
          parseOrderedListMarker(
            `${marker.token}${marker.delimiter}${marker.spacing || " "}`
          ) != null &&
          inferOrderedListMarkerFamily(marker.token, null, null) === family
        let finalOrdinal = originalOrdinal
        if (!standalone) {
          const previousOrdered = previousOrderedAtTarget
          const continuesOriginalSequence =
            previousOrdered != null &&
            previousOrdered.family === family &&
            previousOrdered.delimiter === marker.delimiter &&
            originalOrdinal === previousOrdered.originalOrdinal + 1
          finalOrdinal = continuesOriginalSequence
            ? previousOrdered.finalOrdinal + 1
            : 1
          if (finalOrdinal !== originalOrdinal) {
            indentMarkerTokenReplacement = orderedListMarkerToken(
              finalOrdinal,
              family
            )
          }
        }
        previousOrderedAtTarget = {
          delimiter: marker.delimiter,
          family,
          finalOrdinal,
          originalOrdinal,
        }
      } else {
        previousOrderedAtTarget = null
      }
    } else {
      previousOrderedAtTarget = null
    }
    if (
      marker &&
      isOrderedMarker(marker) &&
      marker.delimiter &&
      previousDedentOrderedAtTarget?.delimiter === marker.delimiter &&
      orderedFamilyAt(state, line, marker) ===
        previousDedentOrderedAtTarget.family
    ) {
      const ordinal: number = previousDedentOrderedAtTarget.ordinal + 1
      const replacement = orderedListMarkerToken(
        ordinal,
        previousDedentOrderedAtTarget.family,
        previousDedentOrderedAtTarget.minimumWidth
      )
      if (replacement) {
        if (replacement !== marker.token) {
          dedentMarkerTokenReplacement = replacement
        }
        previousDedentOrderedAtTarget = {
          ...previousDedentOrderedAtTarget,
          ordinal,
        }
      } else {
        previousDedentOrderedAtTarget = null
      }
    } else {
      previousDedentOrderedAtTarget = null
    }
    const replacesMarkerToken =
      indentMarkerTokenReplacement != null ||
      dedentMarkerTokenReplacement != null
    blocks.push({
      dedentContainerPadding: parent?.containerPadding ?? "",
      dedentDestinationNested:
        parent != null && parentListItem(parent.node.parent) != null,
      dedentMarkerTokenReplacement,
      dedentTargetColumns: parent?.indentColumns ?? 0,
      dedentTargetSource: parent?.indent ?? "",
      endLine: item.endLine,
      indentColumns: item.indentColumns,
      indentTargetColumns:
        groupIndentTargetSource != null
          ? indentationColumnsFromSource(
              groupIndentTargetSource,
              sourceColumn(
                line.text,
                linePrefix(line.text, state.tabSize).containerLength,
                state.tabSize
              ),
              state.tabSize
            )
          : groupIndentTargetColumns,
      indentTargetSource: groupIndentTargetSource,
      markerTokenFrom:
        replacesMarkerToken && marker ? line.from + marker.markerFrom : null,
      indentMarkerTokenReplacement,
      markerTokenTo:
        replacesMarkerToken && marker ? line.from + marker.markerTo - 1 : null,
      node: item.node,
      quoteDepth: item.quoteDepth,
      startLine: item.startLine,
    })
    previousSelected = item
  }
  return blocks
}

export function selectionIsInListItem(state: EditorState) {
  return listItemBlocks(state) !== null
}

function changeBlockIndentation(
  state: EditorState,
  block: ListItemBlock,
  targetColumns: number,
  targetSource: string | null,
  targetContainerPadding: "" | " " | null,
  destinationNested: boolean,
  roundTabsUp: boolean,
  changedLines: Set<number>,
  changes: ChangeSpec[]
) {
  const firstLine = state.doc.line(block.startLine)
  const firstPrefix = linePrefix(
    firstLine.text,
    state.tabSize,
    true,
    block.quoteDepth
  )
  const firstReplacement = listIndentationReplacement(
    state,
    firstLine,
    firstPrefix,
    targetColumns,
    roundTabsUp,
    targetSource,
    targetContainerPadding
  )
  const markerTokenReplacement = roundTabsUp
    ? block.indentMarkerTokenReplacement
    : block.dedentMarkerTokenReplacement
  const markerChangedFirstLine =
    markerTokenReplacement != null &&
    block.markerTokenFrom != null &&
    block.markerTokenTo != null
      ? firstLine.text.slice(0, block.markerTokenFrom - firstLine.from) +
        markerTokenReplacement +
        firstLine.text.slice(block.markerTokenTo - firstLine.from)
      : firstLine.text
  const shiftedFirstLine =
    markerChangedFirstLine.slice(0, firstReplacement.from) +
    firstReplacement.source +
    markerChangedFirstLine.slice(firstReplacement.to)
  const firstLineAfter = normalizeTransformedListMarkerPadding(
    firstLine.text,
    shiftedFirstLine,
    state.tabSize,
    block.quoteDepth,
    destinationNested
  )
  const firstPrefixAfter = linePrefix(
    firstLineAfter,
    state.tabSize,
    true,
    block.quoteDepth
  )
  // Descendants align to the item's content lane, not merely to its marker.
  // Moving a marker across a tab stop can change the width of authored tab
  // padding after that marker even when the marker indentation has a smaller
  // delta.
  const delta =
    firstPrefixAfter.containerTrailingPaddingLength +
    firstPrefixAfter.indentColumns +
    firstPrefixAfter.contentIndentColumns -
    (firstPrefix.containerTrailingPaddingLength +
      firstPrefix.indentColumns +
      firstPrefix.contentIndentColumns)

  if (!changedLines.has(firstLine.from)) {
    changedLines.add(firstLine.from)
    const change = minimalLineSourceChange(firstLine, firstLineAfter)
    if (change) changes.push(change)
  }
  for (const change of recursiveListItemBranchIndentChanges(
    state,
    block.node,
    block.quoteDepth,
    delta
  )) {
    const line = state.doc.lineAt(change.from)
    if (changedLines.has(line.from)) continue
    changedLines.add(line.from)
    changes.push({
      from: change.from,
      to: change.to,
      insert: change.insert,
    })
  }
}

export const indentListItems: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  const blocks = listItemBlocks(state)
  if (!blocks) return false
  // A root item without a preceding sibling has no valid parent. Consume Tab
  // so CommonMark cannot reinterpret an inserted indent as a code block.
  if (blocks.some((block) => block.indentTargetColumns === null)) return true

  const changes: ChangeSpec[] = []
  const changedLines = new Set<number>()
  for (const block of blocks) {
    changeBlockIndentation(
      state,
      block,
      block.indentTargetColumns!,
      block.indentTargetSource,
      null,
      true,
      true,
      changedLines,
      changes
    )
  }
  if (changes.length > 0) {
    view.dispatch({
      changes,
      scrollIntoView: true,
      userEvent: "input.indent",
    })
  }
  return true
}

export const dedentListItems: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  const blocks = listItemBlocks(state)
  if (!blocks) return false

  const changes: ChangeSpec[] = []
  const changedLines = new Set<number>()
  for (const block of blocks) {
    if (block.dedentTargetColumns === block.indentColumns) continue
    changeBlockIndentation(
      state,
      block,
      block.dedentTargetColumns,
      block.dedentTargetSource,
      block.dedentContainerPadding,
      block.dedentDestinationNested,
      false,
      changedLines,
      changes
    )
  }
  if (changes.length > 0) {
    view.dispatch({
      changes,
      scrollIntoView: true,
      userEvent: "delete.dedent",
    })
  }
  return true
}
