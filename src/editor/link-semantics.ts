import { syntaxTree } from "@codemirror/language"
import {
  Facet,
  RangeSet,
  RangeValue,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Range,
  type Transaction,
} from "@codemirror/state"
import type { SyntaxNode, Tree } from "@lezer/common"

import type { ScratchDocumentIdentity } from "../shared/contracts"
import {
  isScratchLinkScheme,
  parseScratchLinkAddress,
  type ScratchLinkScheme,
} from "../shared/scratch-links"
import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"

const asciiPunctuationEscape = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g
const absoluteScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/
const windowsAbsolutePath = /^[A-Za-z]:[\\/]/
const safeExternalProtocols = new Set(["http:", "https:", "mailto:", "xmpp:"])

const fallbackCharacterReferences: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  Auml: "Ä",
  auml: "ä",
  gt: ">",
  lt: "<",
  Ouml: "Ö",
  ouml: "ö",
  quot: '"',
  Uuml: "Ü",
  uuml: "ü",
}

let entityDecoder: HTMLTextAreaElement | null | undefined
const characterReferenceCache = new Map<string, string>()
const characterReferencePattern =
  /&(?:#(?:[xX][0-9A-Fa-f]{1,6}|[0-9]{1,7})|[A-Za-z][A-Za-z0-9]{1,31});/g

function decodeCharacterReferencesFallback(source: string) {
  return source.replace(
    /&(?:#(?:[xX]([0-9A-Fa-f]{1,6})|([0-9]{1,7}))|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (
      match,
      hexadecimal: string | undefined,
      decimal: string | undefined,
      name: string | undefined
    ) => {
      if (name) return fallbackCharacterReferences[name] ?? match
      const value = Number.parseInt(
        hexadecimal ?? decimal ?? "",
        hexadecimal ? 16 : 10
      )
      if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) {
        return "\ufffd"
      }
      try {
        return String.fromCodePoint(value)
      } catch {
        return "\ufffd"
      }
    }
  )
}

/** Decode CommonMark character references without putting parsed content in the document. */
export function decodeMarkdownCharacterReferences(source: string) {
  if (!source.includes("&")) return source.replaceAll("\0", "\ufffd")
  const cached = characterReferenceCache.get(source)
  if (cached != null) return cached

  if (entityDecoder === undefined) {
    entityDecoder =
      typeof document === "undefined"
        ? null
        : document.createElement("textarea")
  }

  let decoded: string
  if (entityDecoder) {
    decoded = source.replace(characterReferencePattern, (reference) => {
      entityDecoder!.innerHTML = reference
      return entityDecoder!.textContent ?? reference
    })
  } else {
    decoded = decodeCharacterReferencesFallback(source)
  }
  decoded = decoded.replaceAll("\0", "\ufffd")

  // This cache only avoids repeatedly invoking the HTML tokenizer for the same
  // destinations and titles. Keep it bounded across long editing sessions.
  if (characterReferenceCache.size >= 256) characterReferenceCache.clear()
  characterReferenceCache.set(source, decoded)
  return decoded
}

function directChild(node: SyntaxNode, name: string) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child
  }
  return null
}

function directChildren(node: SyntaxNode, name: string) {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) children.push(child)
  }
  return children
}

/** Parse a link destination exactly once after the Markdown parser validates it. */
export function markdownDestination(state: EditorState, node: SyntaxNode) {
  const source = state.sliceDoc(node.from, node.to)
  const withoutAngles =
    source.startsWith("<") && source.endsWith(">")
      ? source.slice(1, -1)
      : source
  const parentName = node.parent?.name
  const withEscapesParsed =
    parentName === "Link" ||
    parentName === "Image" ||
    parentName === "LinkReference"
      ? withoutAngles.replace(asciiPunctuationEscape, "$1")
      : withoutAngles
  return decodeMarkdownCharacterReferences(withEscapesParsed)
}

function markdownTitle(state: EditorState, node: SyntaxNode | null) {
  if (!node) return null
  const source = state.sliceDoc(node.from, node.to)
  if (source.length < 2) return ""
  return decodeMarkdownCharacterReferences(
    source.slice(1, -1).replace(asciiPunctuationEscape, "$1")
  )
}

function unicodeCaseFold(source: string) {
  // Uppercase-then-lowercase has the same equality classes as the Unicode
  // default case fold, including multi-code-point folds such as ß -> ss.
  // Dotless i is the one common false equivalence and must remain distinct.
  let result = ""
  for (const character of source) {
    if (character === "\u0131") result += character
    else if (character === "\u1e9e") result += "ss"
    else result += character.toUpperCase().toLowerCase()
  }
  return result
}

/** Normalize a raw CommonMark reference label (not its parsed inline text). */
export function normalizeMarkdownLinkLabel(source: string) {
  const label =
    source.startsWith("[") && source.endsWith("]")
      ? source.slice(1, -1)
      : source
  return unicodeCaseFold(label)
    .replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "")
    .replace(/[\t\n\r ]+/g, " ")
}

function referenceLabel(state: EditorState, link: SyntaxNode) {
  const explicit = directChild(link, "LinkLabel")
  if (explicit) {
    const source = state.sliceDoc(explicit.from, explicit.to)
    if (source !== "[]") return normalizeMarkdownLinkLabel(source)
  }

  const marks = directChildren(link, "LinkMark")
  if (!marks[0] || !marks[1]) return null
  return normalizeMarkdownLinkLabel(state.sliceDoc(marks[0].to, marks[1].from))
}

export interface MarkdownLinkDefinition {
  destination: string
  title: string | null
}

export interface MarkdownLinkReferenceBlock {
  from: number
  topLevel: boolean
  to: number
  revealTo: number
}

export interface MarkdownLinkReferenceRange {
  from: number
  to: number
}

class IndexedMarkdownLinkDefinition extends RangeValue {
  readonly label: string
  readonly definition: MarkdownLinkDefinition

  constructor(label: string, definition: MarkdownLinkDefinition) {
    super()
    this.label = label
    this.definition = definition
  }

  override eq(other: RangeValue) {
    return (
      other instanceof IndexedMarkdownLinkDefinition &&
      other.label === this.label &&
      other.definition.destination === this.definition.destination &&
      other.definition.title === this.definition.title
    )
  }
}

class IndexedMarkdownLinkReferenceBlock extends RangeValue {
  readonly topLevel: boolean
  readonly hiddenTrailingLength: number

  constructor(topLevel: boolean, hiddenTrailingLength: number) {
    super()
    this.topLevel = topLevel
    this.hiddenTrailingLength = hiddenTrailingLength
  }

  override eq(other: RangeValue) {
    return (
      other instanceof IndexedMarkdownLinkReferenceBlock &&
      other.topLevel === this.topLevel &&
      other.hiddenTrailingLength === this.hiddenTrailingLength
    )
  }

  materialize(from: number, to: number): MarkdownLinkReferenceBlock {
    return {
      from,
      topLevel: this.topLevel,
      to,
      revealTo: to - this.hiddenTrailingLength,
    }
  }
}

class IndexedPotentialMarkdownLinkDefinition extends RangeValue {
  override eq(other: RangeValue) {
    return other instanceof IndexedPotentialMarkdownLinkDefinition
  }
}

interface ScannedMarkdownLinkReferences {
  blocks: readonly Range<IndexedMarkdownLinkReferenceBlock>[]
  definitions: readonly Range<IndexedMarkdownLinkDefinition>[]
  potentialDefinitions: readonly Range<IndexedPotentialMarkdownLinkDefinition>[]
}

interface MarkdownLinkReferenceIndexState {
  blockIndex: RangeSet<IndexedMarkdownLinkReferenceBlock>
  changedBlockRanges: readonly MarkdownLinkReferenceRange[]
  definitionIndex: RangeSet<IndexedMarkdownLinkDefinition>
  definitions: ReadonlyMap<string, MarkdownLinkDefinition>
  pendingTreeChanges: ChangeDesc | null
  potentialDefinitionIndex: RangeSet<IndexedPotentialMarkdownLinkDefinition>
  tree: Tree
}

function mergeDocumentRanges(
  ranges: readonly MarkdownLinkReferenceRange[]
): MarkdownLinkReferenceRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: MarkdownLinkReferenceRange[] = []
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
): MarkdownLinkReferenceRange {
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

const plainMarkdownCharacter = /^[\p{L}\p{N}]$/u
// Raw blocks and optional display-math syntax can close later on an otherwise
// ordinary line, so edits around their boundary tokens need the exact path.
const midLineBlockBoundary = /[<>]|--|\]\]|\?>|\$\$|\\\]/

function markdownLineContentStart(prefix: string) {
  let index = 0
  const skipSpace = () => {
    while (index < prefix.length && /[ \t]/.test(prefix[index] ?? "")) {
      index += 1
    }
  }

  for (;;) {
    skipSpace()
    if (prefix[index] === ">") {
      index += 1
      if (prefix[index] === " " || prefix[index] === "\t") index += 1
      continue
    }

    const listMarker = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(prefix.slice(index))
    if (!listMarker) break
    index += listMarker[0].length
  }

  skipSpace()
  const taskMarker = /^\[[ xX]\][ \t]+/.exec(prefix.slice(index))
  if (taskMarker) {
    index += taskMarker[0].length
    skipSpace()
  }
  const headingMarker = /^#{1,6}[ \t]+/.exec(prefix.slice(index))
  if (headingMarker) {
    index += headingMarker[0].length
    skipSpace()
  }
  return index
}

function lineChangeKeepsMarkdownBlockShape(
  startState: EditorState,
  state: EditorState,
  fromA: number,
  toA: number,
  fromB: number,
  toB: number
) {
  const oldLine = startState.doc.lineAt(fromA)
  const newLine = state.doc.lineAt(fromB)
  if (
    oldLine.number !== startState.doc.lineAt(toA).number ||
    newLine.number !== state.doc.lineAt(toB).number
  ) {
    return false
  }

  const oldPrefix = startState.sliceDoc(
    oldLine.from,
    Math.min(oldLine.to, oldLine.from + 256)
  )
  const newPrefix = state.sliceDoc(
    newLine.from,
    Math.min(newLine.to, newLine.from + 256)
  )
  const oldContentStart = markdownLineContentStart(oldPrefix)
  const newContentStart = markdownLineContentStart(newPrefix)
  const oldFirstCharacter = Array.from(oldPrefix.slice(oldContentStart))[0]
  const newFirstCharacter = Array.from(newPrefix.slice(newContentStart))[0]
  if (
    !oldFirstCharacter ||
    !newFirstCharacter ||
    !plainMarkdownCharacter.test(oldFirstCharacter) ||
    !plainMarkdownCharacter.test(newFirstCharacter) ||
    fromA <= oldLine.from + oldContentStart ||
    fromB <= newLine.from + newContentStart
  ) {
    return false
  }

  const oldChangedText = startState.sliceDoc(fromA, toA)
  const newChangedText = state.sliceDoc(fromB, toB)
  const oldContext = startState.sliceDoc(
    Math.max(oldLine.from, fromA - 32),
    Math.min(oldLine.to, toA + 32)
  )
  const newContext = state.sliceDoc(
    Math.max(newLine.from, fromB - 32),
    Math.min(newLine.to, toB + 32)
  )
  return ![oldChangedText, newChangedText, oldContext, newContext].some(
    (text) => midLineBlockBoundary.test(text)
  )
}

function canMapMarkdownLinkReferenceIndex(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  blockIndex: RangeSet<IndexedMarkdownLinkReferenceBlock>,
  potentialDefinitionIndex: RangeSet<IndexedPotentialMarkdownLinkDefinition>
) {
  let touchesDefinition = false
  changes.iterChangedRanges((fromA, toA) => {
    if (touchesDefinition) return
    const from = Math.max(0, fromA - 1)
    const to = Math.min(startState.doc.length, toA + 1)
    const markTouched = (): false => {
      touchesDefinition = true
      return false
    }
    blockIndex.between(from, to, markTouched)
    if (!touchesDefinition) {
      potentialDefinitionIndex.between(from, to, markTouched)
    }
  })
  if (touchesDefinition) return false

  let safe = true
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (
      safe &&
      !lineChangeKeepsMarkdownBlockShape(
        startState,
        state,
        fromA,
        toA,
        fromB,
        toB
      )
    ) {
      safe = false
    }
  })
  return safe
}

/**
 * Markdown block structure may propagate well beyond the edited line. Expand
 * through every complete top-level node that touches the edit so a fence or
 * container change refreshes all definitions whose block context changed.
 */
function expandToTopLevelSyntax(
  state: EditorState,
  tree: Tree,
  range: MarkdownLinkReferenceRange
) {
  const neighborhood = lineNeighborhood(state, range.from, range.to)
  let from = neighborhood.from
  let to = neighborhood.to
  const includeTopLevelAt = (position: number, side: -1 | 1) => {
    let node = tree.resolveInner(position, side)
    while (node.parent?.parent != null) node = node.parent
    if (node.parent == null) return
    from = Math.min(from, node.from)
    to = Math.max(to, node.to)
  }
  includeTopLevelAt(neighborhood.from, 1)
  includeTopLevelAt(neighborhood.to, -1)
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

function changedTopLevelSyntaxRanges(
  transaction: Transaction,
  previousTree: Tree,
  tree: Tree
) {
  const oldCandidates: MarkdownLinkReferenceRange[] = []
  const newCandidates: MarkdownLinkReferenceRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    oldCandidates.push(
      expandToTopLevelSyntax(transaction.startState, previousTree, {
        from: fromA,
        to: toA,
      })
    )
    newCandidates.push(
      expandToTopLevelSyntax(transaction.state, tree, {
        from: fromB,
        to: toB,
      })
    )
  })

  const oldRanges = mergeDocumentRanges(oldCandidates)
  const mappedOldRanges = oldRanges.map((range) => ({
    from: transaction.changes.mapPos(range.from, -1),
    to: transaction.changes.mapPos(range.to, 1),
  }))
  const newRanges = mergeDocumentRanges(
    mergeDocumentRanges([...mappedOldRanges, ...newCandidates]).map((range) =>
      expandToTopLevelSyntax(transaction.state, tree, range)
    )
  )
  return newRanges
}

function scanMarkdownLinkReferences(
  state: EditorState,
  tree: Tree,
  ranges: readonly MarkdownLinkReferenceRange[]
): ScannedMarkdownLinkReferences {
  const blocks: Range<IndexedMarkdownLinkReferenceBlock>[] = []
  const definitions: Range<IndexedMarkdownLinkDefinition>[] = []
  const potentialDefinitions: Range<IndexedPotentialMarkdownLinkDefinition>[] =
    []
  const seen = new Set<string>()
  const seenPotentialDefinitions = new Set<string>()

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "LinkReference") {
          if (node.name === "Paragraph") {
            const identity = `${node.from}:${node.to}`
            if (
              !seenPotentialDefinitions.has(identity) &&
              state
                .sliceDoc(node.from, Math.min(node.to, node.from + 256))
                .trimStart()
                .startsWith("[")
            ) {
              seenPotentialDefinitions.add(identity)
              potentialDefinitions.push(
                new IndexedPotentialMarkdownLinkDefinition().range(
                  node.from,
                  node.to
                )
              )
            }
          }
          // Definitions are leaf blocks. Inline descendants cannot contribute
          // index entries, so avoid walking them in reference-dense documents.
          if (node.type.is("LeafBlock")) return false
          return
        }
        const identity = `${node.from}:${node.to}`
        if (seen.has(identity)) return false
        seen.add(identity)

        const firstLine = state.doc.lineAt(node.from)
        const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
        const topLevel = node.node.parent?.name === "Document"
        const blockFrom = topLevel ? firstLine.from : node.from
        const blockTo = topLevel
          ? lastLine.number < state.doc.lines
            ? state.doc.line(lastLine.number + 1).from
            : lastLine.to
          : node.to
        const revealTo = topLevel ? lastLine.to : node.to
        blocks.push(
          new IndexedMarkdownLinkReferenceBlock(
            topLevel,
            blockTo - revealTo
          ).range(blockFrom, blockTo)
        )

        const label = directChild(node.node, "LinkLabel")
        const url = directChild(node.node, "URL")
        if (label && url) {
          definitions.push(
            new IndexedMarkdownLinkDefinition(
              normalizeMarkdownLinkLabel(state.sliceDoc(label.from, label.to)),
              {
                destination: markdownDestination(state, url),
                title: markdownTitle(
                  state,
                  directChild(node.node, "LinkTitle")
                ),
              }
            ).range(node.from, node.to)
          )
        }
        return false
      },
    })
  }
  return { blocks, definitions, potentialDefinitions }
}

function definitionsFromIndex(index: RangeSet<IndexedMarkdownLinkDefinition>) {
  const definitions = new Map<string, MarkdownLinkDefinition>()
  const cursor = index.iter()
  while (cursor.value) {
    if (!definitions.has(cursor.value.label)) {
      definitions.set(cursor.value.label, cursor.value.definition)
    }
    cursor.next()
  }
  return definitions
}

function removeIndexedRanges<T extends RangeValue>(
  index: RangeSet<T>,
  ranges: readonly MarkdownLinkReferenceRange[]
) {
  let updated = index
  for (const range of ranges) {
    updated = updated.update({
      // RangeSet's filter window includes ranges that only touch either
      // boundary. Refresh regions are half-open, so retain those neighbors;
      // their syntax is outside the region that was rescanned.
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function refreshIndex<T extends RangeValue>(
  previous: RangeSet<T>,
  changes: ChangeDesc,
  ranges: readonly MarkdownLinkReferenceRange[],
  additions: readonly Range<T>[]
) {
  const retained = removeIndexedRanges(previous.map(changes), ranges)
  return additions.length > 0
    ? retained.update({ add: additions, sort: true })
    : retained
}

function indexedRangesIn<T extends RangeValue>(
  index: RangeSet<T>,
  ranges: readonly MarkdownLinkReferenceRange[]
) {
  const indexed: Array<{ from: number; to: number; value: T }> = []
  const seen = new Set<T>()
  for (const range of ranges) {
    index.between(range.from, range.to, (from, to, value) => {
      if (seen.has(value)) return
      seen.add(value)
      indexed.push({ from, to, value })
    })
  }
  return indexed.sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
}

function indexesEqualInRanges<T extends RangeValue>(
  left: RangeSet<T>,
  right: RangeSet<T>,
  ranges: readonly MarkdownLinkReferenceRange[]
) {
  const leftRanges = indexedRangesIn(left, ranges)
  const rightRanges = indexedRangesIn(right, ranges)
  if (leftRanges.length !== rightRanges.length) return false
  return leftRanges.every((leftRange, index) => {
    const rightRange = rightRanges[index]
    return (
      rightRange != null &&
      leftRange.from === rightRange.from &&
      leftRange.to === rightRange.to &&
      (leftRange.value === rightRange.value ||
        leftRange.value.eq(rightRange.value))
    )
  })
}

function createMarkdownLinkReferenceIndex(
  state: EditorState,
  tree = completeMarkdownSyntaxTree(state)
): MarkdownLinkReferenceIndexState {
  const scanned = scanMarkdownLinkReferences(state, tree, [
    { from: 0, to: state.doc.length },
  ])
  const blockIndex = RangeSet.of(scanned.blocks, true)
  const definitionIndex = RangeSet.of(scanned.definitions, true)
  const potentialDefinitionIndex = RangeSet.of(
    scanned.potentialDefinitions,
    true
  )
  return {
    blockIndex,
    changedBlockRanges: [],
    definitionIndex,
    definitions: definitionsFromIndex(definitionIndex),
    pendingTreeChanges: null,
    potentialDefinitionIndex,
    tree,
  }
}

const markdownLinkReferenceIndexFacet = Facet.define<
  MarkdownLinkReferenceIndexState,
  MarkdownLinkReferenceIndexState | null
>({
  combine: (values) => values.at(-1) ?? null,
})

/** Install a complete, incrementally maintained reference-definition index. */
export function markdownLinkReferenceIndexExtension() {
  return StateField.define<MarkdownLinkReferenceIndexState>({
    create: (state) => createMarkdownLinkReferenceIndex(state),
    update(value, transaction) {
      const syntaxChanged =
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      if (!transaction.docChanged && !syntaxChanged) return value

      if (!transaction.docChanged) {
        const tree = completeMarkdownSyntaxTree(transaction.state)
        // Viewport parsing can publish a newer partial tree for the same
        // immutable document. The complete index already represents it.
        if (tree === value.tree) return value
        const rebuilt = createMarkdownLinkReferenceIndex(
          transaction.state,
          tree
        )
        return {
          ...rebuilt,
          changedBlockRanges: [{ from: 0, to: transaction.state.doc.length }],
        }
      }

      const changesFromTree = value.pendingTreeChanges
        ? value.pendingTreeChanges.composeDesc(transaction.changes)
        : transaction.changes
      if (
        canMapMarkdownLinkReferenceIndex(
          transaction.startState,
          transaction.state,
          transaction.changes,
          value.blockIndex,
          value.potentialDefinitionIndex
        )
      ) {
        return {
          ...value,
          blockIndex: value.blockIndex.map(transaction.changes),
          changedBlockRanges: [],
          definitionIndex: value.definitionIndex.map(transaction.changes),
          pendingTreeChanges: changesFromTree,
          potentialDefinitionIndex: value.potentialDefinitionIndex.map(
            transaction.changes
          ),
        }
      }

      const tree = updateCompleteMarkdownSyntaxTree(
        transaction.state,
        changesFromTree,
        value.tree
      )
      if (
        value.pendingTreeChanges ||
        markdownBlockPairingMayChange(transaction)
      ) {
        const rebuilt = createMarkdownLinkReferenceIndex(
          transaction.state,
          tree
        )
        const fullDocument = [{ from: 0, to: transaction.state.doc.length }]
        const mappedBlockIndex = value.blockIndex.map(transaction.changes)
        const mappedDefinitionIndex = value.definitionIndex.map(
          transaction.changes
        )
        const blocksChanged = !indexesEqualInRanges(
          mappedBlockIndex,
          rebuilt.blockIndex,
          fullDocument
        )
        const definitionsChanged = !indexesEqualInRanges(
          mappedDefinitionIndex,
          rebuilt.definitionIndex,
          fullDocument
        )
        return {
          ...rebuilt,
          blockIndex: blocksChanged ? rebuilt.blockIndex : mappedBlockIndex,
          changedBlockRanges: blocksChanged ? fullDocument : [],
          definitionIndex: definitionsChanged
            ? rebuilt.definitionIndex
            : mappedDefinitionIndex,
          definitions: definitionsChanged
            ? rebuilt.definitions
            : value.definitions,
        }
      }
      const newRanges = changedTopLevelSyntaxRanges(
        transaction,
        value.tree,
        tree
      )
      const scanned = scanMarkdownLinkReferences(
        transaction.state,
        tree,
        newRanges
      )
      // Compare mapped persistent indexes. This catches a definition deleted
      // exactly at a refresh boundary without walking either index.
      const mappedBlockIndex = value.blockIndex.map(transaction.changes)
      const mappedDefinitionIndex = value.definitionIndex.map(
        transaction.changes
      )
      const blockIndex = refreshIndex(
        value.blockIndex,
        transaction.changes,
        newRanges,
        scanned.blocks
      )
      const definitionIndex = refreshIndex(
        value.definitionIndex,
        transaction.changes,
        newRanges,
        scanned.definitions
      )
      const potentialDefinitionIndex = refreshIndex(
        value.potentialDefinitionIndex,
        transaction.changes,
        newRanges,
        scanned.potentialDefinitions
      )
      const blocksChanged = !indexesEqualInRanges(
        mappedBlockIndex,
        blockIndex,
        newRanges
      )
      const definitionsChanged = !indexesEqualInRanges(
        mappedDefinitionIndex,
        definitionIndex,
        newRanges
      )
      return {
        blockIndex,
        changedBlockRanges: blocksChanged ? newRanges : [],
        definitionIndex,
        definitions: definitionsChanged
          ? definitionsFromIndex(definitionIndex)
          : value.definitions,
        pendingTreeChanges: null,
        potentialDefinitionIndex,
        tree,
      }
    },
    provide: (field) => markdownLinkReferenceIndexFacet.from(field),
  })
}

/** Ranges whose definition-fold membership changed in the current state. */
export function changedMarkdownLinkReferenceRanges(state: EditorState) {
  return state.facet(markdownLinkReferenceIndexFacet)?.changedBlockRanges ?? []
}

/** Query parsed definition blocks without walking the Markdown tree. */
export function markdownLinkReferenceBlocks(
  state: EditorState,
  ranges: readonly MarkdownLinkReferenceRange[] = [
    { from: 0, to: state.doc.length },
  ]
) {
  const indexed = state.facet(markdownLinkReferenceIndexFacet)
  if (!indexed) {
    const scanned = scanMarkdownLinkReferences(
      state,
      completeMarkdownSyntaxTree(state),
      [{ from: 0, to: state.doc.length }]
    )
    return scanned.blocks
      .map((range) => range.value.materialize(range.from, range.to))
      .filter((block) =>
        ranges.some((range) => block.from <= range.to && block.to >= range.from)
      )
  }

  const blocks: MarkdownLinkReferenceBlock[] = []
  const seen = new Set<IndexedMarkdownLinkReferenceBlock>()
  for (const range of ranges) {
    indexed.blockIndex.between(range.from, range.to, (from, to, value) => {
      if (seen.has(value)) return
      seen.add(value)
      blocks.push(value.materialize(from, to))
    })
  }
  return blocks.sort((left, right) => left.from - right.from)
}

const referenceDefinitionCache = new WeakMap<
  Tree,
  ReadonlyMap<string, MarkdownLinkDefinition>
>()

/** Return the first definition for each normalized CommonMark reference label. */
export function markdownLinkDefinitions(state: EditorState) {
  const indexed = state.facet(markdownLinkReferenceIndexFacet)
  if (indexed) return indexed.definitions

  const tree = completeMarkdownSyntaxTree(state)
  const cached = referenceDefinitionCache.get(tree)
  if (cached) return cached

  const scanned = scanMarkdownLinkReferences(state, tree, [
    { from: 0, to: state.doc.length },
  ])
  const definitionIndex = RangeSet.of(scanned.definitions, true)
  const definitions = definitionsFromIndex(definitionIndex)
  referenceDefinitionCache.set(tree, definitions)
  return definitions
}

function hasInlineDestination(state: EditorState, node: SyntaxNode) {
  return directChildren(node, "LinkMark").some(
    (mark) => state.sliceDoc(mark.from, mark.to) === "("
  )
}

function autolinkDestination(source: string) {
  if (!absoluteScheme.test(source) && source.includes("@")) {
    return `mailto:${source}`
  }
  return source
}

function bareAutolinkDestination(source: string) {
  if (/^www\./i.test(source)) return `http://${source}`
  if (!absoluteScheme.test(source) && source.includes("@")) {
    return `mailto:${source}`
  }
  return source
}

export type MarkdownLinkActivation =
  | {
      kind: "external"
      href: string
      protocol: "http:" | "https:" | "mailto:" | "xmpp:"
    }
  | { kind: "fragment"; fragment: string }
  | { kind: "local"; destination: string; fragment: string | null }
  | {
      kind: "scratch"
      fragment: string | null
      href: string
      identity: ScratchDocumentIdentity
      scheme: ScratchLinkScheme
    }

export interface ResolvedMarkdownLink {
  /** Decoded CommonMark destination, before activation-specific normalization. */
  destination: string
  /** Null means the link renders but is deliberately not executable. */
  activation: MarkdownLinkActivation | null
  title: string | null
}

function decodedFragment(source: string) {
  try {
    return decodeURIComponent(source)
  } catch {
    return source
  }
}

function containsAsciiControl(source: string) {
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function externalUrl(source: string) {
  // WHATWG URLs treat backslashes in special-scheme paths as separators.
  // Markdown keeps a non-escaped backslash literal, so encode it first.
  return new URL(source.replaceAll("\\", "%5C"))
}

/** Classify a rendered destination independently from whether it is a valid link. */
export function markdownLinkActivation(
  destination: string
): MarkdownLinkActivation | null {
  if (destination === "" || destination.startsWith("#")) {
    return {
      kind: "fragment",
      fragment: decodedFragment(
        destination.startsWith("#") ? destination.slice(1) : ""
      ),
    }
  }
  if (containsAsciiControl(destination)) return null

  if (destination.startsWith("//")) {
    try {
      return {
        kind: "external",
        href: externalUrl(`https:${destination}`).href,
        protocol: "https:",
      }
    } catch {
      return null
    }
  }

  const scheme = absoluteScheme.exec(destination)?.[1]?.toLowerCase()
  if (scheme && !windowsAbsolutePath.test(destination)) {
    if (isScratchLinkScheme(scheme)) {
      const scratch = parseScratchLinkAddress(destination)
      return scratch ? { kind: "scratch", ...scratch } : null
    }
    if (scheme === "file") {
      const hash = destination.indexOf("#")
      return {
        kind: "local",
        destination: hash < 0 ? destination : destination.slice(0, hash),
        fragment:
          hash < 0 ? null : decodedFragment(destination.slice(hash + 1)),
      }
    }
    const protocol = `${scheme}:`
    if (!safeExternalProtocols.has(protocol)) return null
    try {
      const href = externalUrl(destination).href
      return {
        kind: "external",
        href,
        protocol: protocol as "http:" | "https:" | "mailto:" | "xmpp:",
      }
    } catch {
      return null
    }
  }

  const hash = destination.indexOf("#")
  return {
    kind: "local",
    destination: hash < 0 ? destination : destination.slice(0, hash),
    fragment: hash < 0 ? null : decodedFragment(destination.slice(hash + 1)),
  }
}

function resolvedDestination(
  state: EditorState,
  node: SyntaxNode
): { destination: string; title: string | null } | null {
  if (node.name === "URL") {
    return {
      destination: bareAutolinkDestination(markdownDestination(state, node)),
      title: null,
    }
  }

  if (node.name === "Autolink") {
    const url = directChild(node, "URL")
    if (!url) return null
    return {
      destination: autolinkDestination(markdownDestination(state, url)),
      title: null,
    }
  }

  if (node.name !== "Link" && node.name !== "Image") return null
  const url = directChild(node, "URL")
  if (url || hasInlineDestination(state, node)) {
    return {
      destination: url ? markdownDestination(state, url) : "",
      title: markdownTitle(state, directChild(node, "LinkTitle")),
    }
  }

  const label = referenceLabel(state, node)
  return label ? (markdownLinkDefinitions(state).get(label) ?? null) : null
}

/** Resolve a parser-recognized link, rejecting unresolved reference syntax. */
export function resolveMarkdownLinkNode(
  state: EditorState,
  node: SyntaxNode
): ResolvedMarkdownLink | null {
  const resolved = resolvedDestination(state, node)
  if (!resolved) return null
  return {
    ...resolved,
    activation: markdownLinkActivation(resolved.destination),
  }
}

function resolvedLinkFromNode(
  state: EditorState,
  initial: SyntaxNode | null
): ResolvedMarkdownLink | null {
  let node = initial
  let bareUrl: SyntaxNode | null = null
  while (node) {
    if (node.name === "LinkReference") return null
    if (node.name === "Link" || node.name === "Autolink") {
      return resolveMarkdownLinkNode(state, node)
    }
    if (
      node.name === "URL" &&
      node.parent?.name !== "Image" &&
      node.parent?.name !== "LinkReference"
    ) {
      bareUrl = node
    }
    node = node.parent
  }
  return bareUrl ? resolveMarkdownLinkNode(state, bareUrl) : null
}

/** Resolve any rendered Markdown link at a document position. */
export function markdownLinkTargetAt(
  state: EditorState,
  position: number
): ResolvedMarkdownLink | null {
  if (position < 0 || position > state.doc.length) return null
  const tree = syntaxTree(state)
  return (
    resolvedLinkFromNode(state, tree.resolveInner(position, -1)) ??
    resolvedLinkFromNode(state, tree.resolveInner(position, 1))
  )
}

/** Return only an allowed activation; unknown schemes remain rendered but inert. */
export function markdownLinkActivationAt(state: EditorState, position: number) {
  return markdownLinkTargetAt(state, position)?.activation ?? null
}
