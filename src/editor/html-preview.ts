import { syntaxTree } from "@codemirror/language"
import {
  countColumn,
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

import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import { MemoryWeightedFragmentCache } from "./fragment-render-cache"
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
import { sanitizedFragment } from "./sanitized-dom"
import { boundedPreviewMaxWidth } from "./theme"

const inlineTagNames = new Set([
  "abbr",
  "b",
  "br",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
])

const blockTagNames = new Set([
  ...inlineTagNames,
  "blockquote",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "summary",
  "ul",
])

const voidTagNames = new Set(["br", "hr"])

interface DocumentRange {
  readonly from: number
  readonly to: number
}

interface HtmlTagToken {
  readonly closing: boolean
  readonly from: number
  readonly name: string
  readonly selfClosing: boolean
  readonly to: number
}

export interface SanitizedHtmlBlock {
  readonly block: true
  readonly from: number
  readonly source: string
  readonly to: number
}

export interface SanitizedHtmlInlineElement {
  readonly block: false
  readonly closeFrom: number
  readonly closeTo: number
  readonly contentFrom: number
  readonly contentTo: number
  readonly from: number
  readonly kind: "element"
  readonly openFrom: number
  readonly openTo: number
  readonly tagName: string
  readonly to: number
}

export interface SanitizedHtmlBreak {
  readonly block: false
  readonly from: number
  readonly kind: "break"
  readonly tagName: "br"
  readonly to: number
}

export type SanitizedHtmlPreview =
  SanitizedHtmlBlock | SanitizedHtmlBreak | SanitizedHtmlInlineElement

interface ParsedTag {
  readonly closing: boolean
  readonly name: string
  readonly selfClosing: boolean
}

function parseHtmlTag(source: string): ParsedTag | null {
  const closing = /^<\s*\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(source)
  if (closing?.[1]) {
    return {
      closing: true,
      name: closing[1].toLowerCase(),
      selfClosing: false,
    }
  }

  const opening =
    /^<\s*([A-Za-z][A-Za-z0-9-]*)(?:\s+[^<>]*?)?\s*(\/\s*)?>$/.exec(source)
  if (!opening?.[1]) return null
  const name = opening[1].toLowerCase()
  return {
    closing: false,
    name,
    selfClosing: opening[2] != null || voidTagNames.has(name),
  }
}

/**
 * Returns true when a block contains a coherent safe structure worth passing
 * through the sanitizer. Attributes and unsupported nested tags may be
 * present in source, but are never copied directly to the preview DOM.
 */
export function basicHtmlSourceIsSupported(source: string) {
  if (/<!--[\s\S]*?-->|<![A-Z]|<\?/i.test(source)) return false
  if (source.length > 50_000) return false

  const stack: string[] = []
  let safeTagCount = 0
  const candidateTags = source.matchAll(/<[^>]*>/gs)
  for (const match of candidateTags) {
    const parsed = parseHtmlTag(match[0])
    if (!parsed) return false
    if (!blockTagNames.has(parsed.name)) continue
    if (parsed.selfClosing && !voidTagNames.has(parsed.name)) return false
    safeTagCount += 1

    if (parsed.closing) {
      if (voidTagNames.has(parsed.name) || stack.pop() !== parsed.name) {
        return false
      }
    } else if (!parsed.selfClosing) {
      stack.push(parsed.name)
    }
  }
  return safeTagCount > 0 && stack.length === 0
}

function htmlListIndentColumns(state: EditorState, item: SyntaxNode) {
  const marker = item.getChild("ListMark")
  if (!marker) return 0
  const line = state.doc.lineAt(marker.from)
  const markerEnd = marker.to - line.from
  const spacing = /^[\t ]*/.exec(line.text.slice(markerEnd))![0]
  const baseColumn = countColumn(line.text.slice(0, item.from - line.from), 4)
  const markerColumn = countColumn(line.text.slice(0, markerEnd), 4)
  const contentColumn = countColumn(
    line.text.slice(0, markerEnd + spacing.length),
    4
  )
  const padding = contentColumn - markerColumn
  return (
    markerColumn - baseColumn + (padding >= 1 && padding <= 4 ? padding : 1)
  )
}

/** Remove parser-owned quote/list containers while preserving HTML whitespace. */
function htmlBlockSource(state: EditorState, node: SyntaxNode) {
  // Preserve the authored-source budget before expanding container structure.
  if (node.to - node.from > 50_000) return null
  const containers: Array<
    { kind: "quote" } | { kind: "list"; columns: number }
  > = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") containers.push({ kind: "quote" })
    else if (parent.name === "ListItem") {
      containers.push({
        kind: "list",
        columns: htmlListIndentColumns(state, parent),
      })
    }
  }
  if (containers.length === 0) return state.sliceDoc(node.from, node.to)
  containers.reverse()

  const quoteMarks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "QuoteMark") quoteMarks.push(child)
  }
  const firstLine = state.doc.lineAt(node.from)
  const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
  const pieces = [state.sliceDoc(node.from, Math.min(firstLine.to, node.to))]
  let quoteIndex = 0
  for (
    let number = firstLine.number + 1;
    number <= lastLine.number;
    number += 1
  ) {
    const line = state.doc.line(number)
    let from = line.from
    let remainingTabSpaces = 0
    for (const container of containers) {
      if (container.kind === "quote") {
        const marker = quoteMarks[quoteIndex]
        if (!marker || marker.from < line.from || marker.from > line.to)
          continue
        from = marker.to
        const padding = line.text[from - line.from]
        const column = countColumn(line.text.slice(0, from - line.from), 4)
        remainingTabSpaces = padding === "\t" ? 4 - (column % 4) - 1 : 0
        if (padding === " " || padding === "\t") from += 1
        quoteIndex += 1
      } else {
        let column = countColumn(line.text.slice(0, from - line.from), 4)
        const target = column + container.columns - remainingTabSpaces
        while (from < line.to && column < target) {
          const character = line.text[from - line.from]
          if (character !== " " && character !== "\t") break
          column += character === "\t" ? 4 - (column % 4) : 1
          from += 1
        }
        remainingTabSpaces = Math.max(0, column - target)
      }
    }
    pieces.push(
      " ".repeat(remainingTabSpaces) +
        state.sliceDoc(from, Math.min(line.to, node.to))
    )
  }
  return pieces.join("\n")
}

function inlineHtmlContainer(node: SyntaxNode) {
  return (
    node.name === "Paragraph" ||
    node.name === "TableCell" ||
    /^(?:ATX|Setext)Heading[1-6]$/.test(node.name)
  )
}

function inlinePreviewsForTags(
  state: EditorState,
  nodes: readonly SyntaxNode[],
  requireCompleteContainer: boolean
): readonly SanitizedHtmlPreview[] {
  const tokens: HtmlTagToken[] = []
  for (const node of nodes) {
    const parsed = parseHtmlTag(state.sliceDoc(node.from, node.to))
    if (!parsed || !inlineTagNames.has(parsed.name)) continue
    tokens.push({ ...parsed, from: node.from, to: node.to })
  }
  tokens.sort((left, right) => left.from - right.from)

  const previews: SanitizedHtmlPreview[] = []
  const stack: HtmlTagToken[] = []
  let invalidNesting = false
  for (const token of tokens) {
    if (token.selfClosing) {
      if (token.name === "br") {
        previews.push({
          block: false,
          from: token.from,
          kind: "break",
          tagName: "br",
          to: token.to,
        })
      }
      continue
    }
    if (!token.closing) {
      stack.push(token)
      continue
    }

    const opening = stack.pop()
    if (!opening || opening.name !== token.name) {
      if (requireCompleteContainer) {
        invalidNesting = true
        break
      }
      if (opening) stack.push(opening)
      continue
    }
    previews.push({
      block: false,
      closeFrom: token.from,
      closeTo: token.to,
      contentFrom: opening.to,
      contentTo: token.from,
      from: opening.from,
      kind: "element",
      openFrom: opening.from,
      openTo: opening.to,
      tagName: token.name,
      to: token.to,
    })
  }

  return invalidNesting || (requireCompleteContainer && stack.length > 0)
    ? []
    : previews
}

function inlinePreviewTagStarts(previews: readonly SanitizedHtmlPreview[]) {
  const starts = new Set<number>()
  for (const preview of previews) {
    if (preview.block) continue
    if (preview.kind === "break") {
      starts.add(preview.from)
    } else {
      starts.add(preview.openFrom)
      starts.add(preview.closeFrom)
    }
  }
  return starts
}

interface ParsedHtmlTagNode {
  readonly node: SyntaxNode
  readonly token: ParsedTag
}

interface BoundarySpanningHtmlTags {
  readonly tags: readonly SyntaxNode[]
  readonly valid: boolean
}

/**
 * Recovers inline elements whose source tags sit outside a materialized
 * range. Syntax siblings let this skip arbitrarily large text gaps without
 * slicing the container or walking each character in it.
 */
function boundarySpanningHtmlTags(
  state: EditorState,
  container: SyntaxNode,
  range: DocumentRange,
  includeVisibleOpenings: boolean
): BoundarySpanningHtmlTags {
  const from = Math.max(container.from, range.from)
  const to = Math.min(container.to, range.to)
  if (from >= to) return { tags: [], valid: true }

  const activeInnerFirst: ParsedHtmlTagNode[] = []
  const unmatchedClosings: string[] = []
  let preceding = container.childBefore(from)
  if (preceding && preceding.to > from) preceding = preceding.prevSibling
  for (let node = preceding; node; node = node.prevSibling) {
    if (node.name !== "HTMLTag") continue
    const token = parseHtmlTag(state.sliceDoc(node.from, node.to))
    if (!token || !inlineTagNames.has(token.name) || token.selfClosing) continue
    if (token.closing) {
      unmatchedClosings.push(token.name)
      continue
    }
    if (unmatchedClosings.length > 0) {
      if (unmatchedClosings.at(-1) !== token.name) {
        return { tags: [], valid: false }
      }
      unmatchedClosings.pop()
      continue
    }
    activeInnerFirst.push({ node, token })
  }
  if (unmatchedClosings.length > 0) return { tags: [], valid: false }

  const stack = activeInnerFirst.reverse()
  const candidates = new Set(stack.map(({ node }) => node.from))
  const recovered = new Map<number, SyntaxNode>()
  for (let node = container.childAfter(from); node; node = node.nextSibling) {
    if (node.from >= to && candidates.size === 0 && stack.length === 0) break
    if (node.name !== "HTMLTag") {
      if (node.from >= to && candidates.size === 0) break
      continue
    }
    const token = parseHtmlTag(state.sliceDoc(node.from, node.to))
    if (!token || !inlineTagNames.has(token.name) || token.selfClosing) {
      if (node.from >= to && candidates.size === 0) break
      continue
    }
    if (!token.closing) {
      stack.push({ node, token })
      if (includeVisibleOpenings && node.from < to) candidates.add(node.from)
      continue
    }

    const opening = stack.pop()
    if (!opening || opening.token.name !== token.name) {
      return { tags: [], valid: false }
    }
    if (candidates.delete(opening.node.from)) {
      recovered.set(opening.node.from, opening.node)
      recovered.set(node.from, node)
    }
    if (node.from >= to && candidates.size === 0) break
  }
  return candidates.size === 0
    ? { tags: [...recovered.values()], valid: true }
    : { tags: [], valid: false }
}

function htmlPreviewsInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  includeBlocks = true
) {
  const previews: SanitizedHtmlPreview[] = []
  const seenBlocks = new Set<number>()
  const seenTags = new Set<number>()
  const containerTags = new Map<
    number,
    {
      readonly node: SyntaxNode
      readonly ranges: DocumentRange[]
      readonly tags: SyntaxNode[]
    }
  >()
  const tree = syntaxTree(state)
  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        if (inlineHtmlContainer(node.node) && range) {
          const existing = containerTags.get(node.from)
          if (existing) existing.ranges.push(range)
          else
            containerTags.set(node.from, {
              node: node.node,
              ranges: [range],
              tags: [],
            })
        }
        if (node.name === "HTMLBlock") {
          if (!includeBlocks) return false
          if (seenBlocks.has(node.from)) return false
          seenBlocks.add(node.from)
          const source = htmlBlockSource(state, node.node)
          if (source != null && basicHtmlSourceIsSupported(source)) {
            previews.push({
              block: true,
              from: node.from,
              source,
              to: node.to,
            })
          }
          return false
        }
        if (node.name === "HTMLTag") {
          if (seenTags.has(node.from)) return false
          seenTags.add(node.from)
          let container = node.node.parent
          while (container && !inlineHtmlContainer(container)) {
            container = container.parent
          }
          if (!container) return false
          const existing = containerTags.get(container.from)
          if (existing) existing.tags.push(node.node)
          else
            containerTags.set(container.from, {
              node: container,
              ranges: range ? [range] : [],
              tags: [node.node],
            })
          return false
        }
      },
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan(null)
  }
  for (const {
    node,
    ranges: containerRanges,
    tags,
  } of containerTags.values()) {
    const completeContainer =
      ranges == null ||
      ranges.some((range) => range.from <= node.from && range.to >= node.to)
    let inline = inlinePreviewsForTags(state, tags, completeContainer)
    if (!completeContainer) {
      const covered = inlinePreviewTagStarts(inline)
      const incomplete = tags.some((tag) => !covered.has(tag.from))
      const includeVisibleOpenings = tags.length === 0 || incomplete
      const recovered = new Map(tags.map((tag) => [tag.from, tag]))
      let valid = true
      for (const range of containerRanges) {
        if (!includeVisibleOpenings && range.from <= node.from) continue
        const boundary = boundarySpanningHtmlTags(
          state,
          node,
          range,
          includeVisibleOpenings
        )
        if (!boundary.valid) {
          valid = false
          break
        }
        for (const tag of boundary.tags) {
          recovered.set(tag.from, tag)
        }
      }
      if (!valid) {
        inline = []
      } else if (recovered.size > tags.length) {
        inline = inlinePreviewsForTags(
          state,
          [...recovered.values()],
          completeContainer
        )
      }
    }
    previews.push(...inline)
  }
  return previews
    .filter(
      (preview) =>
        ranges == null ||
        ranges.some(
          (range) => preview.from < range.to && preview.to > range.from
        )
    )
    .sort((left, right) => left.from - right.from)
}

/** Extracts supported, complete raw-HTML constructs from the Markdown tree. */
export function sanitizedHtmlPreviews(
  state: EditorState
): readonly SanitizedHtmlPreview[] {
  return htmlPreviewsInRanges(state, null)
}

/** Finds the supported block preview containing a document position. */
export function sanitizedHtmlBlockAt(
  state: EditorState,
  position: number
): SanitizedHtmlBlock | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (
        node.name === "HTMLBlock" &&
        node.from <= boundedPosition &&
        boundedPosition <= node.to
      ) {
        const source = htmlBlockSource(state, node)
        return source != null && basicHtmlSourceIsSupported(source)
          ? { block: true, from: node.from, source, to: node.to }
          : null
      }
      node = node.parent
    }
  }
  return null
}

/** Finds a rendered sanitized HTML line break at a document position. */
export function sanitizedHtmlBreakAt(
  state: EditorState,
  position: number
): SanitizedHtmlBreak | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const from = Math.max(0, boundedPosition - 1)
  const to = Math.min(state.doc.length, boundedPosition + 1)
  const breaks = htmlPreviewsInRanges(state, [{ from, to }], false).filter(
    (preview): preview is SanitizedHtmlBreak =>
      !preview.block &&
      preview.kind === "break" &&
      preview.from <= boundedPosition &&
      boundedPosition <= preview.to
  )
  return (
    breaks.find((preview) => preview.from === boundedPosition) ??
    breaks.at(-1) ??
    null
  )
}

let basicHtmlTagList: readonly string[] | null = null

function allowedBasicHtmlTags() {
  return (basicHtmlTagList ??= [...blockTagNames])
}

const htmlRenderTokens = new WeakMap<HTMLElement, object>()

const maximumCachedHtmlRenders = 64
const maximumCachedHtmlRenderBytes = 16 * 1024 * 1024
const maximumCachedHtmlHeights = 128
const htmlRenderCaches = new WeakMap<Document, MemoryWeightedFragmentCache>()
const htmlHeightCache = new PreviewHeightCache(maximumCachedHtmlHeights)

function htmlRenderCache(ownerDocument: Document) {
  let cache = htmlRenderCaches.get(ownerDocument)
  if (!cache) {
    cache = new MemoryWeightedFragmentCache(
      maximumCachedHtmlRenders,
      maximumCachedHtmlRenderBytes
    )
    htmlRenderCaches.set(ownerDocument, cache)
  }
  return cache
}

function cachedHtmlRender(ownerDocument: Document, source: string) {
  const cache = htmlRenderCache(ownerDocument)
  return cache.get(source)
}

function cacheHtmlRender(
  ownerDocument: Document,
  source: string,
  fragment: DocumentFragment
) {
  return htmlRenderCache(ownerDocument).set(source, fragment)
}

function cachedHtmlHeight(source: string) {
  return htmlHeightCache.get(source)
}

function rememberHtmlHeight(source: string, height: number) {
  htmlHeightCache.set(source, height)
}

export function invalidateSanitizedHtmlPreviewGeometry() {
  htmlHeightCache.invalidate()
}

function requestHtmlMeasure(
  container: HTMLElement,
  view: EditorView,
  source: string
) {
  view.requestMeasure({
    key: container,
    read: (currentView) =>
      container.isConnected
        ? container.getBoundingClientRect().height / currentView.scaleY
        : null,
    write: (height) => {
      if (height != null) {
        rememberHtmlHeight(source, height)
      }
    },
  })
}

function htmlFallback(ownerDocument: Document, source: string) {
  const pre = ownerDocument.createElement("pre")
  pre.className = "cm-md-html-fallback"
  const code = ownerDocument.createElement("code")
  code.textContent = source
  pre.append(code)
  return pre
}

function captureHtmlDetailsOpenState(root: ParentNode) {
  return [...root.querySelectorAll("details")].map((details) => details.open)
}

function restoreHtmlDetailsOpenState(
  root: ParentNode,
  state: readonly boolean[] | null
) {
  if (!state) return
  ;[...root.querySelectorAll("details")].forEach((details, index) => {
    if (index < state.length) details.open = state[index]!
  })
}

export class HtmlDetailsState {
  private open: readonly boolean[] | null = null

  capture(root: ParentNode) {
    const open = captureHtmlDetailsOpenState(root)
    if (open.length > 0) this.open = open
  }

  restore(root: ParentNode) {
    restoreHtmlDetailsOpenState(root, this.open)
  }
}

class SanitizedHtmlBlockWidget extends WidgetType {
  private readonly detailsState = new HtmlDetailsState()
  readonly source: string

  constructor(source: string) {
    super()
    this.source = source
  }

  eq(other: WidgetType) {
    return (
      other instanceof SanitizedHtmlBlockWidget && this.source === other.source
    )
  }

  get estimatedHeight() {
    return (
      cachedHtmlHeight(this.source) ??
      Math.min(320, Math.max(40, this.source.split("\n").length * 24))
    )
  }

  ignoreEvent(event: Event) {
    return (
      event.target instanceof Element && event.target.closest("summary") != null
    )
  }

  destroy(dom: HTMLElement) {
    this.detailsState.capture(dom)
    htmlRenderTokens.delete(dom)
  }

  toDOM(view: EditorView) {
    const ownerDocument = view.dom.ownerDocument
    const container = ownerDocument.createElement("div")
    container.className = "cm-md-html-block cm-md-html-loading"
    container.setAttribute("aria-label", "Sanitized HTML preview")
    const cached = cachedHtmlRender(ownerDocument, this.source)
    if (cached) {
      container.replaceChildren(cached.fragment.cloneNode(true))
      this.detailsState.restore(container)
      container.classList.remove("cm-md-html-loading")
      requestHtmlMeasure(container, view, this.source)
      return container
    }

    container.style.minHeight = `${this.estimatedHeight}px`
    container.append(htmlFallback(ownerDocument, this.source))
    const token = {}
    htmlRenderTokens.set(container, token)

    void sanitizedFragment(ownerDocument, this.source, {
      ADD_ATTR: (attributeName, tagName) =>
        attributeName === "open" && tagName === "details",
      ALLOWED_ATTR: [],
      ALLOWED_TAGS: [...allowedBasicHtmlTags()],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
    })
      .then((fragment) => {
        if (fragment.childNodes.length === 0) {
          throw new Error("Sanitized HTML fragment is empty")
        }
        cacheHtmlRender(ownerDocument, this.source, fragment)
        if (
          !container.isConnected ||
          htmlRenderTokens.get(container) !== token
        ) {
          return
        }
        container.replaceChildren(fragment)
        this.detailsState.restore(container)
        container.style.minHeight = ""
        container.classList.remove("cm-md-html-loading")
        requestHtmlMeasure(container, view, this.source)
      })
      .catch(() => {
        if (
          !container.isConnected ||
          htmlRenderTokens.get(container) !== token
        ) {
          return
        }
        container.style.minHeight = ""
        container.classList.remove("cm-md-html-loading")
        container.classList.add("cm-md-html-error")
        container.replaceChildren(htmlFallback(ownerDocument, this.source))
        view.requestMeasure()
      })

    return container
  }
}

class HtmlBreakWidget extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof HtmlBreakWidget
  }

  get lineBreaks() {
    return 1
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const lineBreak = view.dom.ownerDocument.createElement("br")
    lineBreak.className = "cm-md-html-break"
    return lineBreak
  }
}

function selectionTouches(
  state: EditorState,
  preview: DocumentRange,
  selectionActive: boolean
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive &&
        range.head >= preview.from &&
        range.head <= preview.to
      : range.from < preview.to && range.to > preview.from
  )
}

function htmlBreakVisualAnchor(lineBreak: HTMLElement) {
  const bounds = lineBreak.getBoundingClientRect()
  if (bounds.height <= 0) return null
  return {
    bottom: bounds.bottom,
    top: bounds.top,
    x: bounds.left,
  }
}

function semanticInlineTag(tagName: string) {
  if (tagName === "b") return "strong"
  if (tagName === "i") return "em"
  if (tagName === "s" || tagName === "strike") return "del"
  return tagName
}

function htmlBlockPresentationRange(
  state: EditorState,
  preview: DocumentRange
) {
  // A whole-line block replacement otherwise leaves CodeMirror boundary
  // lines beside the widget. Consume those line breaks while leaving any
  // authored blank line on the other side intact.
  const firstLine = state.doc.lineAt(preview.from)
  const lastLine = state.doc.lineAt(Math.max(preview.from, preview.to - 1))
  return {
    from:
      preview.from === firstLine.from && preview.from > 0
        ? preview.from - 1
        : preview.from,
    to:
      preview.to === lastLine.to && preview.to < state.doc.length
        ? preview.to + 1
        : preview.to,
  }
}

function decorationRangesForHtmlPreviews(
  state: EditorState,
  previews: readonly SanitizedHtmlPreview[],
  selectionActive: boolean,
  reuseFrom: DecorationSet | null = null
) {
  const ranges: Range<Decoration>[] = []
  for (const preview of previews) {
    const presentation = preview.block
      ? htmlBlockPresentationRange(state, preview)
      : preview
    if (selectionTouches(state, presentation, selectionActive)) continue

    if (preview.block) {
      let reusable: Decoration | null = null
      reuseFrom?.between(
        presentation.from,
        presentation.to,
        (from, to, value) => {
          const widget = value.spec.widget
          if (
            from === presentation.from &&
            to === presentation.to &&
            value.spec.markdownPreviewKind === "sanitized-html-block" &&
            widget instanceof SanitizedHtmlBlockWidget &&
            widget.source === preview.source
          ) {
            reusable = value
          }
        }
      )
      ranges.push(
        (
          reusable ??
          Decoration.replace({
            block: true,
            inclusive: false,
            markdownPreviewKind: "sanitized-html-block",
            widget: new SanitizedHtmlBlockWidget(preview.source),
          })
        ).range(presentation.from, presentation.to)
      )
      continue
    }

    if (preview.kind === "break") {
      ranges.push(
        Decoration.replace({
          inclusive: false,
          markdownPreviewKind: "sanitized-html-break",
          widget: new HtmlBreakWidget(),
        }).range(preview.from, preview.to)
      )
      continue
    }

    ranges.push(
      Decoration.replace({
        markdownPreviewKind: "sanitized-html-tag",
      }).range(preview.openFrom, preview.openTo),
      Decoration.replace({
        markdownPreviewKind: "sanitized-html-tag",
      }).range(preview.closeFrom, preview.closeTo)
    )
    if (preview.contentFrom < preview.contentTo) {
      const tagName = semanticInlineTag(preview.tagName)
      ranges.push(
        Decoration.mark({
          class: `cm-md-html-inline cm-md-html-${tagName}`,
          markdownPreviewKind: "sanitized-html-inline",
          tagName,
        }).range(preview.contentFrom, preview.contentTo)
      )
    }
  }
  return ranges
}

function decorationsForHtmlPreviews(
  state: EditorState,
  previews: readonly SanitizedHtmlPreview[],
  selectionActive: boolean
) {
  const ranges = decorationRangesForHtmlPreviews(
    state,
    previews,
    selectionActive
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

/** Builds static HTML preview decorations without loading DOMPurify. */
export function buildSanitizedHtmlPreviewDecorations(
  state: EditorState,
  selectionActive = true,
  visibleRanges: readonly DocumentRange[] | null = null
): DecorationSet {
  return decorationsForHtmlPreviews(
    state,
    htmlPreviewsInRanges(state, visibleRanges),
    selectionActive
  )
}

function buildSanitizedHtmlInlinePreviewDecorations(
  state: EditorState,
  selectionActive: boolean,
  visibleRanges: readonly DocumentRange[]
) {
  return decorationsForHtmlPreviews(
    state,
    htmlPreviewsInRanges(state, visibleRanges, false),
    selectionActive
  )
}

function htmlBlocksInTree(
  state: EditorState,
  tree: Tree,
  ranges: readonly DocumentRange[] | null
) {
  const blocks: SanitizedHtmlBlock[] = []
  const seen = new Set<number>()
  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        if (node.name !== "HTMLBlock") return
        if (range && (node.to <= range.from || node.from >= range.to)) {
          return false
        }
        if (seen.has(node.from)) return false
        seen.add(node.from)
        const source = htmlBlockSource(state, node.node)
        if (source != null && basicHtmlSourceIsSupported(source)) {
          blocks.push({
            block: true,
            from: node.from,
            source,
            to: node.to,
          })
        }
        return false
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

class IndexedHtmlBlock extends RangeValue {
  readonly source: string

  constructor(source: string) {
    super()
    this.source = source
  }

  eq(other: RangeValue) {
    return other instanceof IndexedHtmlBlock && other.source === this.source
  }

  materialize(from: number, to: number): SanitizedHtmlBlock {
    return { block: true, from, source: this.source, to }
  }
}

function buildHtmlBlockIndex(blocks: readonly SanitizedHtmlBlock[]) {
  return RangeSet.of(
    blocks.map((block) =>
      new IndexedHtmlBlock(block.source).range(block.from, block.to)
    ),
    true
  )
}

function indexedHtmlBlocks(
  index: RangeSet<IndexedHtmlBlock>,
  documentLength: number,
  ranges: readonly DocumentRange[] | null = null
) {
  const blocks: SanitizedHtmlBlock[] = []
  const seen = new Set<IndexedHtmlBlock>()
  const scan = (range: DocumentRange) => {
    index.between(range.from, range.to, (from, to, value) => {
      if (to <= range.from || from >= range.to) return
      if (seen.has(value)) return
      seen.add(value)
      blocks.push(value.materialize(from, to))
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan({ from: 0, to: documentLength })
  }
  return blocks
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

function refreshHtmlBlockIndex(
  previous: RangeSet<IndexedHtmlBlock>,
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  if (markdownBlockPairingMayChange(transaction)) {
    return {
      index: buildHtmlBlockIndex(
        htmlBlocksInTree(transaction.state, nextTree, null)
      ),
      ranges: [{ from: 0, to: transaction.state.doc.length }],
    }
  }

  const ranges = changedSyntaxRanges(transaction, previousTree, nextTree)
  let retained = previous.map(transaction.changes)
  for (const range of ranges) {
    retained = retained.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  const additions = htmlBlocksInTree(transaction.state, nextTree, ranges).map(
    (block) => new IndexedHtmlBlock(block.source).range(block.from, block.to)
  )
  return {
    index:
      additions.length > 0
        ? retained.update({ add: additions, sort: true })
        : retained,
    ranges,
  }
}

function selectionTouchesHtmlBlockIndex(
  index: RangeSet<IndexedHtmlBlock>,
  selection: EditorSelection,
  selectionActive: boolean,
  state: EditorState
) {
  return selection.ranges.some((range) => {
    if (range.empty && !selectionActive) return false
    // The presentation can extend one character beyond the indexed source;
    // probe past that half-open edge so its boundary still finds the block.
    const probeFrom = Math.max(0, (range.empty ? range.head : range.from) - 2)
    const probeTo = Math.min(
      state.doc.length,
      (range.empty ? range.head : range.to) + 2
    )
    let touches = false
    index.between(probeFrom, probeTo, (from, to) => {
      const presentation = htmlBlockPresentationRange(state, { from, to })
      if (
        range.empty
          ? range.head >= presentation.from && range.head <= presentation.to
          : range.from < presentation.to && range.to > presentation.from
      ) {
        touches = true
      }
    })
    return touches
  })
}

function htmlBlockRangesForSelection(
  index: RangeSet<IndexedHtmlBlock>,
  selection: EditorSelection,
  selectionActive: boolean,
  state: EditorState
) {
  const ranges: DocumentRange[] = []
  for (const range of selection.ranges) {
    if (range.empty && !selectionActive) continue
    // Match the expanded presentation boundary while returning source ranges
    // for the block index and incremental decoration refresh.
    const probeFrom = Math.max(0, (range.empty ? range.head : range.from) - 2)
    const probeTo = Math.min(
      state.doc.length,
      (range.empty ? range.head : range.to) + 2
    )
    index.between(probeFrom, probeTo, (from, to) => {
      const presentation = htmlBlockPresentationRange(state, { from, to })
      if (
        range.empty
          ? range.head >= presentation.from && range.head <= presentation.to
          : range.from < presentation.to && range.to > presentation.from
      ) {
        ranges.push({ from, to })
      }
    })
  }
  return mergeDocumentRanges(ranges)
}

function refreshHtmlBlockDecorations(
  previous: DecorationSet,
  state: EditorState,
  index: RangeSet<IndexedHtmlBlock>,
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
  const additions = decorationRangesForHtmlPreviews(
    state,
    indexedHtmlBlocks(index, state.doc.length, ranges),
    selectionActive,
    previous
  )
  return additions.length
    ? decorations.update({ add: additions, sort: true })
    : decorations
}

interface HtmlBlockPreviewState {
  readonly blockIndex: RangeSet<IndexedHtmlBlock>
  readonly decorations: DecorationSet
  readonly presentedSelection: EditorSelection
  readonly selectionActive: boolean
  readonly tree: Tree
}

export interface SanitizedHtmlLivePreviewOptions {
  /** Mirrors live-preview focus so an inactive cursor stays rendered. */
  readonly selectionActive?: (state: EditorState) => boolean
}

export const SANITIZED_HTML_MARK_THEME = {
  light: {
    background: "oklch(from var(--syntax-number-color) 25% calc(c * 0.65) h)",
    foreground: "#ffffff",
  },
  dark: {
    background: "oklch(from var(--syntax-number-color) 95% calc(c * 0.65) h)",
    foreground: "#000000",
  },
} as const

const sanitizedHtmlTheme = EditorView.baseTheme({
  ".cm-md-html-block": {
    boxSizing: "border-box",
    display: "block",
    maxWidth: boundedPreviewMaxWidth,
    overflowX: "auto",
    padding: "0.25rem 0",
    // CodeMirror preserves source whitespace on its content surface. Collapse
    // sanitizer-retained indentation so it cannot create anonymous line boxes.
    whiteSpace: "normal",
    width: "100%",
  },
  ".cm-md-html-block > :first-child": {
    marginBlockStart: "0",
  },
  ".cm-md-html-block > :last-child": {
    marginBlockEnd: "0",
  },
  ".cm-md-html-block table": {
    borderCollapse: "collapse",
    maxWidth: "100%",
  },
  ".cm-md-html-block td, .cm-md-html-block th": {
    border: "1px solid var(--border)",
    padding: "0.25rem 0.5rem",
  },
  ".cm-md-html-block pre, .cm-md-html-fallback": {
    fontFamily: "var(--font-mono)",
    overflowX: "auto",
    whiteSpace: "pre",
  },
  ".cm-md-html-loading": {
    opacity: "0.72",
  },
  ".cm-md-html-error": {
    color: "var(--destructive)",
  },
  ".cm-md-html-mark, .cm-md-html-block mark": {
    borderRadius: "0.15em",
    paddingInline: "0.08em",
  },
  "&light .cm-md-html-mark, &light .cm-md-html-block mark": {
    backgroundColor: SANITIZED_HTML_MARK_THEME.light.background,
    color: SANITIZED_HTML_MARK_THEME.light.foreground,
  },
  "&dark .cm-md-html-mark, &dark .cm-md-html-block mark": {
    backgroundColor: SANITIZED_HTML_MARK_THEME.dark.background,
    color: SANITIZED_HTML_MARK_THEME.dark.foreground,
  },
  ".cm-md-html-block details": {
    border: "1px solid var(--border)",
    borderRadius: "calc(0.4rem * var(--app-corner-radius-scale, 1))",
    cornerShape: "var(--app-corner-shape, round)",
    padding: "0.4rem 0.65rem",
  },
  ".cm-md-html-block summary": {
    cursor: "pointer",
    fontWeight: "600",
  },
  ".cm-md-html-block details[open] > summary": {
    marginBlockEnd: "0.4rem",
  },
  ".cm-md-html-kbd": {
    border: "1px solid var(--border)",
    borderRadius: "0.25rem",
    boxShadow: "0 1px 0 var(--border)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    padding: "0.05em 0.3em",
  },
})

/** Renders the safe HTML subset without ever injecting unsanitized markup. */
export function sanitizedHtmlLivePreviewExtension(
  options: SanitizedHtmlLivePreviewOptions = {}
): Extension {
  const selectionIsActive = (state: EditorState) =>
    options.selectionActive?.(state) ?? true

  // Block replacements affect CodeMirror's document height, so seed every one
  // synchronously and retain it across viewport changes. Inline presentation
  // remains in the viewport-scoped field below.
  const blockPreviewField = StateField.define<HtmlBlockPreviewState>({
    create(state) {
      const tree = completeMarkdownSyntaxTree(state)
      const blocks = htmlBlocksInTree(state, tree, null)
      const blockIndex = buildHtmlBlockIndex(blocks)
      const selectionActive = selectionIsActive(state)
      return {
        blockIndex,
        decorations: decorationsForHtmlPreviews(state, blocks, selectionActive),
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
        const previousTouches = selectionTouchesHtmlBlockIndex(
          value.blockIndex,
          value.presentedSelection,
          value.selectionActive,
          transaction.state
        )
        const nextTouches = selectionTouchesHtmlBlockIndex(
          value.blockIndex,
          presentedSelection,
          selectionActive,
          transaction.state
        )
        if (!previousTouches && !nextTouches) return value

        const ranges = mergeDocumentRanges([
          ...htmlBlockRangesForSelection(
            value.blockIndex,
            value.presentedSelection,
            value.selectionActive,
            transaction.state
          ),
          ...htmlBlockRangesForSelection(
            value.blockIndex,
            presentedSelection,
            selectionActive,
            transaction.state
          ),
        ])
        return {
          ...value,
          decorations: refreshHtmlBlockDecorations(
            value.decorations,
            transaction.state,
            value.blockIndex,
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
        : completeTreeAfterSyntaxChange!
      if (!transaction.docChanged) {
        const blockIndex = buildHtmlBlockIndex(
          htmlBlocksInTree(transaction.state, tree, null)
        )
        return {
          blockIndex,
          decorations: decorationsForHtmlPreviews(
            transaction.state,
            indexedHtmlBlocks(blockIndex, transaction.state.doc.length),
            selectionActive
          ),
          presentedSelection,
          selectionActive,
          tree,
        }
      }

      const refreshed = refreshHtmlBlockIndex(
        value.blockIndex,
        transaction,
        value.tree,
        tree
      )
      const blockIndex = refreshed.index
      const mappedPresentedSelection = value.presentedSelection.map(
        transaction.changes
      )
      const ranges = mergeDocumentRanges([
        ...refreshed.ranges,
        ...htmlBlockRangesForSelection(
          blockIndex,
          mappedPresentedSelection,
          value.selectionActive,
          transaction.state
        ),
        ...htmlBlockRangesForSelection(
          blockIndex,
          presentedSelection,
          selectionActive,
          transaction.state
        ),
      ])
      return {
        blockIndex,
        decorations: refreshHtmlBlockDecorations(
          value.decorations.map(transaction.changes),
          transaction.state,
          blockIndex,
          ranges,
          selectionActive
        ),
        presentedSelection,
        selectionActive,
        tree,
      }
    },
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
              buildSanitizedHtmlInlinePreviewDecorations(
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
    resolve(view, target, position, pointer) {
      const block = target.closest<HTMLElement>(".cm-md-html-block")
      if (block) {
        const sourcePosition = previewPositionAtDOM(view, block, position)
        const preview = firstNearbyPreviewRange(
          view.state,
          sourcePosition,
          (candidate) => sanitizedHtmlBlockAt(view.state, candidate)
        )
        return preview
          ? {
              dragSelection: "rendered" as const,
              element: block,
              from: preview.from,
              to: preview.to,
            }
          : null
      }

      let lineBreak = target.closest<HTMLElement>(".cm-md-html-break")
      if (!lineBreak) {
        const line = target.closest<HTMLElement>(".cm-line")
        lineBreak = line
          ? ([...line.querySelectorAll<HTMLElement>(".cm-md-html-break")].find(
              (candidate) => {
                const anchor = htmlBreakVisualAnchor(candidate)
                if (!anchor) return false
                return (
                  Math.abs(pointer.x - anchor.x) <= 6 &&
                  pointer.y >= anchor.top - 1 &&
                  pointer.y <= anchor.bottom + 1
                )
              }
            ) ?? null)
          : null
      }
      if (!lineBreak) return null
      const sourcePosition = previewPositionAtDOM(view, lineBreak, position)
      const preview = firstNearbyPreviewRange(
        view.state,
        sourcePosition,
        (candidate) => sanitizedHtmlBreakAt(view.state, candidate)
      )
      return preview
        ? {
            dragSelection: "atomic" as const,
            element: lineBreak,
            from: preview.from,
            to: preview.to,
          }
        : null
    },
  })

  return [
    Prec.highest([blockPreviewField, inlineDecorationField]),
    preview,
    pointerSelection,
    sanitizedHtmlTheme,
  ]
}
