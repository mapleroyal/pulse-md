import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import {
  indentUnit,
  LanguageDescription,
  syntaxTree,
} from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import type { SearchQuery } from "@codemirror/search"
import {
  Annotation,
  Compartment,
  countColumn,
  EditorSelection,
  EditorState,
  findClusterBreak,
  findColumn,
  type Line,
  Prec,
  type StateEffect,
  StateField,
  Transaction,
  type Extension,
  type SelectionRange,
  type Text as StateText,
} from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type MouseSelectionStyle,
  type Rect,
} from "@codemirror/view"

import { normalizeEditorContent } from "./content"
import { fencedCodeText, type FencedCodeBlock } from "./code-blocks"
import {
  applyMarkdownFormatting,
  markdownFormattingKeymap,
  type MarkdownFormattingCommand,
} from "./formatting"
import {
  headingForFragment,
  markdownHeadings,
  type MarkdownHeading,
  type MarkdownOutlineHeadingLevel,
} from "./headings"
import {
  moveSelectionToMarkdownLinkDestination,
  pastedUrlWrappingExtension,
  selectedTextWrappingExtension,
} from "./input-wrapping"
import { pastedHeadingLinkExtension } from "./heading-link-clipboard"
import { renderedMarkdownPasteExtension } from "./rendered-markdown-paste"
import {
  deleteListMarkupBackward,
  dedentListItems,
  indentListItems,
  insertNewlineContinueList,
  insertNewlineExitList,
} from "./list-editing"
import { markdownDocumentPath, markdownRemoteImagesEnabled } from "./media"
import {
  hiddenMarkdownCaretClass,
  livePreviewExtension,
  livePreviewFocusTrackingExtension,
  livePreviewSelectionActive,
  livePreviewSelectionIsActive,
  refreshLivePreview,
  setLivePreviewEditorFocused,
  setLivePreviewFocusRetained,
} from "./live-preview"
import {
  runTableCellRangeClipboardCommand,
  tableCellRangeSelectionContainsCoordinates,
  tableCellRangeSelectionSnapshot,
  tableCellRangeSelectionState,
} from "./table-selection"
import {
  markdownLinkActivationAt,
  markdownLinkTargetAt,
  type MarkdownLinkActivation,
} from "./link-semantics"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"
import type { SearchMatchRange } from "./search-state"
import {
  contextPreservingRegexpCursor,
  regexpMayCrossLines,
  searchCursorForRange,
  type SearchCursorMatch,
} from "./search-cursor"
import type { EditorSearchSupport } from "./search-support"
import {
  selectionAppearanceExtension,
  setSelectionWindowActive,
} from "./selection-appearance"
import {
  semanticPreviewSelectionAtPointer,
  semanticPreviewSelectionAtTarget,
  sourceLinePointerPosition,
} from "./semantic-preview-selection"
import {
  queuePreviewRebuild,
  type SemanticPreviewSelection,
} from "./interactive-preview"
import {
  refreshSpellCheck as refreshSpellCheckEffect,
  spellCheckExtension,
  spellingCandidateAt,
  type SpellCheckWords,
  type SpellingCandidate,
} from "./spellcheck"
import { syntaxThemeExtension } from "./syntax-theme"
import { editorStatus, wordCountExtension, wordCountField } from "./status"
import { contentLayoutTheme, markdownEditorTheme } from "./theme"
import { delimiterAppearanceExtension } from "./delimiter-appearance"
import {
  MAX_SOURCE_INDENT_SIZE,
  MIN_SOURCE_INDENT_SIZE,
  DEFAULT_APP_SETTINGS,
  resolveAppearanceProfile,
  SERIALIZED_EDITOR_SESSION_VERSION,
  type AppearanceProfile,
  type DocumentKind,
  type MarkdownExtensionSettings,
  type SerializedEditorSession,
  type SourceIndentation,
} from "../shared/contracts"
import type {
  EditorStatus,
  OptionalLivePreviewSupport,
  MarkdownEditorControllerOptions,
  MarkdownEditorHandle,
  MarkdownEditorMode,
  MarkdownEditorSession,
  MarkdownLinkTooltip,
  MarkdownNavigationLocation,
  MarkdownNavigationLocationMapper,
  MarkdownNavigationOptions,
  MarkdownReplaceOptions,
  MarkdownSearchOptions,
  MarkdownSearchStatus,
  SetDocumentOptions,
} from "./types"
import { maximumMermaidSourceLength } from "./types"

const suppressChangeNotification = Annotation.define<boolean>()
const openLinkModifierClass = "cm-md-open-link-modifier"
const textLanePointerClass = "cm-md-pointer-in-text-lane"
const textLaneHitSlopEm = 2
const semanticDragThreshold = 4
const semanticDragScrollMargin = 6
const semanticDragScrollInterval = 50
const maxPreciseColumnSelectionOffset = 2_000

function normalizedMarkdownExtensions(
  extensions: Readonly<MarkdownExtensionSettings> | undefined
): MarkdownExtensionSettings {
  const normalized = {
    ...DEFAULT_APP_SETTINGS.markdownExtensions,
    ...extensions,
  }
  if (!normalized.emojiRecognition) normalized.emojiExpansion = false
  return normalized
}

function markdownExtensionsEqual(
  left: Readonly<MarkdownExtensionSettings>,
  right: Readonly<MarkdownExtensionSettings>
) {
  return (
    left.superscriptAndSubscript === right.superscriptAndSubscript &&
    left.emojiRecognition === right.emojiRecognition &&
    left.emojiExpansion === right.emojiExpansion &&
    left.footnotes === right.footnotes &&
    left.definitionLists === right.definitionLists &&
    left.latex === right.latex &&
    left.mermaid === right.mermaid &&
    left.yamlFrontMatter === right.yamlFrontMatter &&
    left.sanitizedHtml === right.sanitizedHtml
  )
}

function markdownParserExtensionsEqual(
  left: Readonly<MarkdownExtensionSettings>,
  right: Readonly<MarkdownExtensionSettings>
) {
  return (
    left.superscriptAndSubscript === right.superscriptAndSubscript &&
    left.emojiRecognition === right.emojiRecognition &&
    left.footnotes === right.footnotes &&
    left.definitionLists === right.definitionLists &&
    left.latex === right.latex &&
    left.yamlFrontMatter === right.yamlFrontMatter
  )
}

function markdownPresentationExtensionsEqual(
  left: Readonly<MarkdownExtensionSettings>,
  right: Readonly<MarkdownExtensionSettings>
) {
  return (
    left.emojiExpansion === right.emojiExpansion &&
    left.footnotes === right.footnotes &&
    left.mermaid === right.mermaid &&
    left.sanitizedHtml === right.sanitizedHtml
  )
}

function markdownParserConfigurationKey(
  extensions: Readonly<MarkdownExtensionSettings>
) {
  return [
    extensions.superscriptAndSubscript,
    extensions.emojiRecognition,
    extensions.footnotes,
    extensions.definitionLists,
    extensions.latex,
    extensions.yamlFrontMatter,
  ]
    .map(Number)
    .join("")
}

function markdownPresentationConfigurationKey(
  extensions: Readonly<MarkdownExtensionSettings>
) {
  return [
    markdownParserConfigurationKey(extensions),
    Number(extensions.emojiExpansion),
    Number(extensions.mermaid),
    Number(extensions.sanitizedHtml),
  ].join(":")
}

function mermaidFenceLanguage(block: FencedCodeBlock) {
  return block.info.trim().split(/\s+/, 1)[0]?.toLowerCase()
}

function mermaidFenceNode(state: EditorState, node: SyntaxNode) {
  if (node.name !== "FencedCode") return false
  const info = node.getChild("CodeInfo")
  if (!info) return false
  return (
    state
      .sliceDoc(info.from, info.to)
      .trim()
      .split(/\s+/, 1)[0]
      ?.toLowerCase() === "mermaid"
  )
}

function mermaidFenceUsesCodePresentation(
  state: EditorState,
  block: FencedCodeBlock
) {
  if (mermaidFenceLanguage(block) !== "mermaid") return true
  const sourceLength = block.codeText.reduce(
    (length, segment) => length + segment.to - segment.from,
    0
  )
  if (
    !block.closed ||
    sourceLength > maximumMermaidSourceLength ||
    !fencedCodeText(state, block).trim()
  ) {
    return true
  }

  return state.selection.ranges.some((range) =>
    range.empty
      ? livePreviewSelectionIsActive(state) &&
        range.head >= block.from &&
        range.head <= block.to
      : range.from < block.to && range.to > block.from
  )
}

function mermaidFencePresentationKey(state: EditorState) {
  const selectionActive = livePreviewSelectionIsActive(state)
  const tree = syntaxTree(state)
  const selectedFenceStarts = new Set<number>()

  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (!selectionActive) continue
      for (const side of [-1, 1] as const) {
        let node: SyntaxNode | null = tree.resolveInner(range.head, side)
        while (node) {
          if (mermaidFenceNode(state, node)) {
            selectedFenceStarts.add(node.from)
            break
          }
          node = node.parent
        }
      }
      continue
    }

    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "FencedCode") return
        if (
          range.from < node.to &&
          range.to > node.from &&
          mermaidFenceNode(state, node.node)
        ) {
          selectedFenceStarts.add(node.from)
        }
        return false
      },
    })
  }

  return [...selectedFenceStarts].sort((left, right) => left - right).join(",")
}
const sourceColumnSelectionOrigin = StateField.define<SelectionRange>({
  create(state) {
    const selection = state.selection.main
    return selection.empty
      ? selection
      : EditorSelection.cursor(selection.anchor)
  },
  update(origin, transaction) {
    const mappedOrigin = origin.map(transaction.changes, origin.assoc || 1)
    const selection = transaction.newSelection
    if (
      selection.ranges.length === 1 &&
      selection.main.empty &&
      !selection.main.eq(mappedOrigin, true)
    ) {
      return selection.main
    }
    return mappedOrigin
  },
})
function documentChromeTopScrollMargin(view: EditorView) {
  const ownerWindow = view.dom.ownerDocument.defaultView
  if (!ownerWindow) return null
  const top = Number.parseFloat(
    ownerWindow.getComputedStyle(view.scrollDOM).scrollPaddingTop
  )
  return Number.isFinite(top) ? top : null
}

function documentChromeBottomScrollMargin(view: EditorView) {
  const ownerWindow = view.dom.ownerDocument.defaultView
  if (!ownerWindow) return null
  const bottom = Number.parseFloat(
    ownerWindow
      .getComputedStyle(view.scrollDOM)
      .getPropertyValue("--status-overlay-height")
  )
  return Number.isFinite(bottom) ? bottom : null
}

const documentChromeScrollMargins = EditorView.scrollMargins.of((view) => {
  const top = documentChromeTopScrollMargin(view)
  const bottom = documentChromeBottomScrollMargin(view)
  if (top === null && bottom === null) return null
  return {
    ...(top === null ? {} : { top }),
    ...(bottom === null ? {} : { bottom }),
  }
})

function sourceColumnSelection(
  state: EditorState,
  anchor: number,
  head: number,
  headColumnOverride?: number
) {
  const anchorLine = state.doc.lineAt(anchor)
  const headLine = state.doc.lineAt(head)
  if (anchorLine.number === headLine.number) {
    return EditorSelection.single(anchor, head)
  }

  const anchorLineOffset = anchor - anchorLine.from
  const headLineOffset = head - headLine.from
  const requestedHeadColumn = headColumnOverride ?? headLineOffset
  const scanVisualColumnsPrecisely =
    anchorLineOffset <= maxPreciseColumnSelectionOffset &&
    requestedHeadColumn <= maxPreciseColumnSelectionOffset
  const anchorColumn = scanVisualColumnsPrecisely
    ? countColumn(anchorLine.text, state.tabSize, anchorLineOffset)
    : anchorLineOffset
  const headColumn =
    headColumnOverride ??
    (scanVisualColumnsPrecisely
      ? countColumn(headLine.text, state.tabSize, headLineOffset)
      : headLineOffset)
  const firstLine = Math.min(anchorLine.number, headLine.number)
  const lastLine = Math.max(anchorLine.number, headLine.number)
  const leftToRight = anchorColumn < headColumn
  const rightToLeft = anchorColumn > headColumn
  const ranges = []
  let mainIndex: number | undefined

  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    let anchorOffset: number
    let headOffset: number
    if (scanVisualColumnsPrecisely) {
      anchorOffset = findColumn(line.text, anchorColumn, state.tabSize)
      headOffset = findColumn(line.text, headColumn, state.tabSize)
      const visibleAnchor = countColumn(line.text, state.tabSize, anchorOffset)
      const visibleHead = countColumn(line.text, state.tabSize, headOffset)

      // Match VS Code's visual-column behavior around tabs and short lines:
      // omit lines that do not reach the rectangle at all, while retaining a
      // partially intersecting range clamped to the line end.
      if (
        (leftToRight &&
          (visibleAnchor > headColumn || visibleHead < anchorColumn)) ||
        (rightToLeft &&
          (visibleHead > anchorColumn || visibleAnchor < headColumn))
      ) {
        continue
      }
    } else {
      // Avoid repeatedly scanning extremely long lines. At this scale, use
      // offsets as approximate columns and retain the same short-line rules.
      if (
        anchorColumn !== headColumn &&
        line.length < Math.min(anchorColumn, headColumn)
      ) {
        continue
      }
      anchorOffset = Math.min(anchorColumn, line.length)
      headOffset = Math.min(headColumn, line.length)
    }

    if (lineNumber === anchorLine.number) mainIndex = ranges.length
    ranges.push(
      EditorSelection.range(line.from + anchorOffset, line.from + headOffset)
    )
  }

  if (ranges.length > 0) {
    return EditorSelection.create(
      ranges,
      mainIndex ?? (anchorLine.number < headLine.number ? 0 : ranges.length - 1)
    )
  }

  // When the whole rectangle is beyond every line end, VS Code leaves one
  // cursor at each line end instead of producing no selection.
  const endCursors = []
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    endCursors.push(EditorSelection.cursor(state.doc.line(lineNumber).to))
  }
  return EditorSelection.create(endCursors, anchorLine.number - firstLine)
}

function sameVisualRow(first: Rect, second: Rect) {
  return first.top < second.bottom && second.top < first.bottom
}

function sourceClusterBoundaries(text: string) {
  const boundaries = [0]
  for (let offset = 0; offset < text.length;) {
    const next = findClusterBreak(text, offset)
    if (next <= offset) break
    boundaries.push(next)
    offset = next
  }
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length)
  return boundaries
}

interface MeasuredSourceLine {
  clusterRects: Array<DOMRect | undefined>
  clusters: number[]
  element: HTMLElement | null
  from: number
  range: Range | null
  rows: MeasuredSourceRow[]
  text: string
  textNode: globalThis.Text | null
  to: number
}

interface MeasuredSourceRow {
  carets: MeasuredSourceCaret[] | null
  from: number
  fromCluster: number
  line: MeasuredSourceLine
  top: number | null
  to: number
  toCluster: number
}

interface MeasuredSourceCaret {
  assoc: number
  pos: number
  x: number
}

class SourceColumnMeasurer {
  private readonly cache = new Map<number, MeasuredSourceLine>()
  private readonly document: Document
  private readonly host: HTMLElement | null
  private readonly lineOffsetFromContent: number
  private readonly lineWidth: number
  private readonly sampleStyle: CSSStyleDeclaration | null
  private readonly scaleX: number
  private readonly textWidth: number
  private readonly view: EditorView
  private destroyed = false

  constructor(view: EditorView) {
    this.view = view
    this.document = view.dom.ownerDocument
    const sampleLine = view.contentDOM.querySelector<HTMLElement>(".cm-line")
    this.scaleX = view.scaleX
    if (!sampleLine) {
      this.host = null
      this.lineOffsetFromContent = 0
      this.lineWidth = 0
      this.sampleStyle = null
      this.textWidth = 0
      return
    }

    const sampleRect = sampleLine.getBoundingClientRect()
    const contentRect = view.contentDOM.getBoundingClientRect()
    const sampleStyle = getComputedStyle(sampleLine)
    const paddingLeft = Number.parseFloat(sampleStyle.paddingLeft) || 0
    const paddingRight = Number.parseFloat(sampleStyle.paddingRight) || 0
    this.lineOffsetFromContent = sampleRect.left - contentRect.left
    this.lineWidth = sampleRect.width / this.scaleX
    this.sampleStyle = sampleStyle
    this.textWidth = Math.max(0, this.lineWidth - paddingLeft - paddingRight)

    const host = this.document.createElement("div")
    host.setAttribute("aria-hidden", "true")
    Object.assign(host.style, {
      left: "-100000px",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      visibility: "hidden",
      width: `${this.lineWidth}px`,
      zIndex: "-1",
    })
    this.document.body.append(host)
    this.host = host
  }

  get available() {
    return !this.destroyed && this.host != null && this.sampleStyle != null
  }

  localX(clientX: number) {
    const contentLeft = this.view.contentDOM.getBoundingClientRect().left
    return (clientX - contentLeft - this.lineOffsetFromContent) / this.scaleX
  }

  prepare(lines: readonly Line[]) {
    if (this.destroyed || !this.host || !this.sampleStyle) return
    const pending: MeasuredSourceLine[] = []

    for (const line of lines) {
      if (this.cache.has(line.number)) continue
      if (!this.mayWrap(line)) {
        const measured: MeasuredSourceLine = {
          clusterRects: [],
          clusters: [],
          element: null,
          from: line.from,
          range: null,
          rows: [],
          text: line.text,
          textNode: null,
          to: line.to,
        }
        measured.rows = [
          {
            carets: null,
            from: line.from,
            fromCluster: 0,
            line: measured,
            top: null,
            to: line.to,
            toCluster: 0,
          },
        ]
        this.cache.set(line.number, measured)
        continue
      }

      const element = this.document.createElement("div")
      this.applyLineStyle(element)
      const textNode = this.document.createTextNode(line.text)
      element.append(textNode)
      this.host.append(element)
      const measured: MeasuredSourceLine = {
        clusterRects: [],
        clusters: sourceClusterBoundaries(line.text),
        element,
        from: line.from,
        range: this.document.createRange(),
        rows: [],
        text: line.text,
        textNode,
        to: line.to,
      }
      this.cache.set(line.number, measured)
      pending.push(measured)
    }

    // All missing mirrors are appended before the first geometry read, so a
    // long selection pays for one layout pass rather than one per line.
    for (const line of pending) this.measureRows(line)
  }

  rows(lineNumber: number) {
    return this.cache.get(lineNumber)?.rows ?? []
  }

  caretAt(row: MeasuredSourceRow, localX: number): MeasuredSourceCaret {
    const line = row.line
    if (!line.element || !line.range || !line.textNode) {
      const paddingLeft = this.sampleStyle
        ? Number.parseFloat(this.sampleStyle.paddingLeft) || 0
        : 0
      const requestedColumn = Math.max(
        0,
        Math.round((localX - paddingLeft) / this.view.defaultCharacterWidth)
      )
      const offset = findColumn(
        line.text,
        requestedColumn,
        this.view.state.tabSize
      )
      const column = countColumn(line.text, this.view.state.tabSize, offset)
      return {
        assoc: 0,
        pos: line.from + offset,
        x: paddingLeft + column * this.view.defaultCharacterWidth,
      }
    }

    const carets = this.rowCarets(row)
    let closest = carets[0]
    let closestDistance = Number.POSITIVE_INFINITY
    for (const caret of carets) {
      const distance = Math.abs(caret.x - localX)
      if (distance < closestDistance) {
        closest = caret
        closestDistance = distance
      }
    }
    return closest ?? { assoc: 0, pos: row.from, x: 0 }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.host?.remove()
    this.cache.clear()
  }

  private mayWrap(line: Line) {
    if (!this.view.lineWrapping || line.length === 0) return false
    const block = this.view.lineBlockAt(line.from)
    if (block.height / this.view.scaleY > this.view.defaultLineHeight * 1.5) {
      return true
    }
    if (line.text.includes("\t") || /[^\u0020-\u007e]/u.test(line.text)) {
      return true
    }
    return line.length * this.view.defaultCharacterWidth > this.textWidth + 0.5
  }

  private applyLineStyle(element: HTMLElement) {
    const source = this.sampleStyle!
    Object.assign(element.style, {
      boxSizing: "border-box",
      direction: source.direction,
      display: "block",
      fontFamily: source.fontFamily,
      fontFeatureSettings: source.fontFeatureSettings,
      fontKerning: source.fontKerning,
      fontSize: source.fontSize,
      fontStretch: source.fontStretch,
      fontStyle: source.fontStyle,
      fontVariant: source.fontVariant,
      fontVariantLigatures: source.fontVariantLigatures,
      fontWeight: source.fontWeight,
      letterSpacing: source.letterSpacing,
      lineHeight: source.lineHeight,
      margin: "0",
      overflowWrap: source.overflowWrap,
      paddingBottom: source.paddingBottom,
      paddingLeft: source.paddingLeft,
      paddingRight: source.paddingRight,
      paddingTop: source.paddingTop,
      tabSize: source.tabSize,
      textIndent: source.textIndent,
      textRendering: source.textRendering,
      unicodeBidi: source.unicodeBidi,
      whiteSpace: source.whiteSpace,
      width: `${this.lineWidth}px`,
      wordBreak: source.wordBreak,
    })
  }

  private measureRows(line: MeasuredSourceLine) {
    const { element, range, textNode } = line
    if (!element || !range || !textNode || textNode.length === 0) {
      line.rows = [
        {
          carets: null,
          from: line.from,
          fromCluster: 0,
          line,
          top: null,
          to: line.to,
          toCluster: 0,
        },
      ]
      return
    }

    range.setStart(textNode, 0)
    range.setEnd(textNode, textNode.length)
    const sortedTops = Array.from(range.getClientRects())
      .filter((rect) => rect.height > 0)
      .map((rect) => rect.top)
      .sort((first, second) => first - second)
    const rowTops: number[] = []
    for (const top of sortedTops) {
      const previous = rowTops.at(-1)
      if (previous == null || Math.abs(previous - top) > 0.5) {
        rowTops.push(top)
      }
    }
    if (rowTops.length <= 1) {
      line.rows = [
        {
          carets: null,
          from: line.from,
          fromCluster: 0,
          line,
          top: rowTops[0] ?? element.getBoundingClientRect().top,
          to: line.to,
          toCluster: line.clusters.length - 1,
        },
      ]
      return
    }

    const starts = [0]
    for (let index = 1; index < rowTops.length; index += 1) {
      starts.push(
        this.firstClusterOnRow(line, starts[index - 1]! + 1, rowTops[index]!)
      )
    }
    line.rows = starts.map((startCluster, index) => {
      const toCluster = starts[index + 1] ?? line.clusters.length - 1
      return {
        carets: null,
        from: line.from + line.clusters[startCluster]!,
        fromCluster: startCluster,
        line,
        top: rowTops[index]!,
        to: line.from + line.clusters[toCluster]!,
        toCluster,
      }
    })
  }

  private firstClusterOnRow(
    line: MeasuredSourceLine,
    fromCluster: number,
    rowTop: number
  ) {
    const lastCluster = line.clusters.length - 2
    let low = Math.min(fromCluster, lastCluster)
    let high = lastCluster
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.clusterRect(line, middle).top < rowTop - 0.5) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low
  }

  private clusterRect(line: MeasuredSourceLine, cluster: number) {
    let rect = line.clusterRects[cluster]
    if (!rect) {
      line.range!.setStart(line.textNode!, line.clusters[cluster]!)
      line.range!.setEnd(line.textNode!, line.clusters[cluster + 1]!)
      rect = line.range!.getBoundingClientRect()
      line.clusterRects[cluster] = rect
    }
    return rect
  }

  private rowCarets(row: MeasuredSourceRow) {
    if (row.carets) return row.carets
    const { line } = row
    const { element, range, textNode } = line
    if (!element || !range || !textNode || row.top == null) {
      row.carets = [{ assoc: 0, pos: row.from, x: 0 }]
      return row.carets
    }

    const lineLeft = element.getBoundingClientRect().left
    const carets: MeasuredSourceCaret[] = []
    // Logical offsets do not have monotonic x coordinates in bidi text.
    // Measure every grapheme-boundary caret on this visual row once, then
    // choose by visual distance in caretAt().
    for (
      let cluster = row.fromCluster;
      cluster <= row.toCluster;
      cluster += 1
    ) {
      const offset = line.clusters[cluster]!
      range.setStart(textNode, offset)
      range.collapse(true)
      for (const rect of Array.from(range.getClientRects())) {
        if (Math.abs(rect.top - row.top) > 0.5) continue
        carets.push({
          assoc:
            cluster === row.fromCluster && row.from > line.from
              ? 1
              : cluster === row.toCluster && row.to < line.to
                ? -1
                : 0,
          pos: line.from + offset,
          x: rect.left - lineLeft,
        })
      }
    }

    if (carets.length === 0) {
      carets.push({ assoc: 0, pos: row.from, x: 0 })
    }
    row.carets = carets
    return carets
  }
}

function rowIndexAt(
  rows: readonly MeasuredSourceRow[],
  position: number,
  assoc: number
) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (position < row.to) return index
    if (position === row.to) {
      if (index === rows.length - 1 || assoc < 0) return index
      return index + 1
    }
  }
  return Math.max(0, rows.length - 1)
}

function measuredVisualColumnSelection(
  view: EditorView,
  measurer: SourceColumnMeasurer,
  anchor: SelectionRange,
  anchorCoords: Rect,
  head: SelectionRange,
  event: MouseEvent
) {
  if (!measurer.available) return null
  const anchorLine = view.state.doc.lineAt(anchor.head)
  const headLine = view.state.doc.lineAt(head.head)
  const firstLine = Math.min(anchorLine.number, headLine.number)
  const lastLine = Math.max(anchorLine.number, headLine.number)
  const lines: Line[] = []
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    lines.push(view.state.doc.line(lineNumber))
  }
  measurer.prepare(lines)

  const anchorRows = measurer.rows(anchorLine.number)
  const headRows = measurer.rows(headLine.number)
  if (anchorRows.length === 0 || headRows.length === 0) return null
  const anchorRowIndex = rowIndexAt(anchorRows, anchor.head, anchor.assoc || 1)
  const headRowIndex = rowIndexAt(headRows, head.head, head.assoc || 1)
  if (
    anchorLine.number === headLine.number &&
    anchorRowIndex === headRowIndex
  ) {
    return EditorSelection.single(anchor.head, head.head)
  }

  const forward =
    anchorLine.number < headLine.number ||
    (anchorLine.number === headLine.number && anchorRowIndex < headRowIndex)
  const anchorX = measurer.localX(anchorCoords.left)
  const headX = measurer.localX(event.clientX)
  const desiredLeft = Math.min(anchorX, headX)
  const desiredRight = Math.max(anchorX, headX)
  const alignedColumn =
    Math.abs(anchorX - headX) <= view.defaultCharacterWidth / 2
  const ranges: SelectionRange[] = []
  const endCursors: SelectionRange[] = []

  for (
    let lineNumber = anchorLine.number;
    forward ? lineNumber <= headLine.number : lineNumber >= headLine.number;
    lineNumber += forward ? 1 : -1
  ) {
    const rows = measurer.rows(lineNumber)
    let rowIndex =
      lineNumber === anchorLine.number
        ? anchorRowIndex
        : forward
          ? 0
          : rows.length - 1
    const finalRowIndex =
      lineNumber === headLine.number
        ? headRowIndex
        : forward
          ? rows.length - 1
          : 0

    for (;;) {
      const row = rows[rowIndex]!
      const rowAnchor = measurer.caretAt(row, anchorX)
      const rowHead = measurer.caretAt(row, headX)
      const actualLeft = Math.min(rowAnchor.x, rowHead.x)
      const actualRight = Math.max(rowAnchor.x, rowHead.x)
      endCursors.push(
        EditorSelection.cursor(row.to, row.to < row.line.to ? -1 : 0)
      )
      if (
        alignedColumn ||
        (actualRight >= desiredLeft - 0.5 && actualLeft <= desiredRight + 0.5)
      ) {
        ranges.push(
          EditorSelection.range(
            rowAnchor.pos,
            rowHead.pos,
            undefined,
            undefined,
            rowHead.assoc
          )
        )
      }
      if (rowIndex === finalRowIndex) break
      rowIndex += forward ? 1 : -1
    }
  }

  const selectedRanges = ranges.length > 0 ? ranges : endCursors
  return selectedRanges.length > 0
    ? EditorSelection.create(selectedRanges, 0)
    : null
}

function visualColumnSelection(
  view: EditorView,
  origin: SelectionRange,
  event: MouseEvent,
  measurer: SourceColumnMeasurer
) {
  const headPosition = view.posAndSideAtCoords(
    { x: event.clientX, y: event.clientY },
    false
  )
  const anchor = EditorSelection.cursor(origin.head, origin.assoc || 1)
  const head = EditorSelection.cursor(headPosition.pos, headPosition.assoc)
  const anchorCoords = view.coordsAtPos(anchor.head, anchor.assoc || 1)
  const headCoords = view.coordsAtPos(head.head, head.assoc || 1)

  if (anchorCoords && headCoords && sameVisualRow(anchorCoords, headCoords)) {
    return EditorSelection.create([
      EditorSelection.range(
        anchor.head,
        head.head,
        undefined,
        undefined,
        head.assoc
      ),
    ])
  }

  if (anchorCoords && headCoords) {
    const anchorX = anchorCoords.left
    const headX = event.clientX
    const desiredLeft = Math.min(anchorX, headX)
    const desiredRight = Math.max(anchorX, headX)
    const alignedColumn =
      Math.abs(anchorX - headX) <= view.defaultCharacterWidth / 2
    const contentLeft = view.contentDOM.getBoundingClientRect().left
    const anchorGoalColumn = anchorX - contentLeft
    const headRowCenter = (headCoords.top + headCoords.bottom) / 2
    const forward = headRowCenter > (anchorCoords.top + anchorCoords.bottom) / 2
    const ranges: SelectionRange[] = []
    const endCursors: SelectionRange[] = []
    let rowCursor = EditorSelection.cursor(
      anchor.head,
      anchor.assoc,
      undefined,
      anchorGoalColumn
    )
    let rowCoords = anchorCoords
    let reachedHeadRow = false
    let traversalInvalid = false
    const maxRows = view.state.doc.length + view.state.doc.lines

    for (let row = 0; row <= maxRows; row += 1) {
      const rowCenter = (rowCoords.top + rowCoords.bottom) / 2
      const rowAnchor = view.posAndSideAtCoords(
        { x: anchorX, y: rowCenter },
        false
      )
      const rowHead = view.posAndSideAtCoords({ x: headX, y: rowCenter }, false)
      const rowAnchorCoords = view.coordsAtPos(
        rowAnchor.pos,
        rowAnchor.assoc || 1
      )
      const rowHeadCoords = view.coordsAtPos(rowHead.pos, rowHead.assoc || 1)

      if (
        rowAnchorCoords &&
        rowHeadCoords &&
        sameVisualRow(rowCoords, rowAnchorCoords) &&
        sameVisualRow(rowCoords, rowHeadCoords)
      ) {
        const actualLeft = Math.min(rowAnchorCoords.left, rowHeadCoords.left)
        const actualRight = Math.max(rowAnchorCoords.left, rowHeadCoords.left)
        endCursors.push(EditorSelection.cursor(rowHead.pos, rowHead.assoc))
        if (
          alignedColumn ||
          (actualRight >= desiredLeft - 0.5 && actualLeft <= desiredRight + 0.5)
        ) {
          ranges.push(
            EditorSelection.range(
              rowAnchor.pos,
              rowHead.pos,
              undefined,
              undefined,
              rowHead.assoc
            )
          )
        }
      } else {
        traversalInvalid = true
        break
      }

      if (sameVisualRow(rowCoords, headCoords)) {
        reachedHeadRow = true
        break
      }

      const nextCursor = view.moveVertically(rowCursor, forward)
      const nextCoords = view.coordsAtPos(
        nextCursor.head,
        nextCursor.assoc || (forward ? 1 : -1)
      )
      if (!nextCoords) break
      const nextCenter = (nextCoords.top + nextCoords.bottom) / 2
      if (
        forward ? nextCenter <= rowCenter + 0.5 : nextCenter >= rowCenter - 0.5
      ) {
        break
      }
      if (Math.abs(nextCenter - rowCenter) > view.defaultLineHeight * 2.5) {
        traversalInvalid = true
        break
      }

      if (
        forward
          ? nextCenter > headRowCenter + 0.5
          : nextCenter < headRowCenter - 0.5
      ) {
        rowCursor = head
        rowCoords = headCoords
      } else {
        rowCursor = nextCursor
        rowCoords = nextCoords
      }
    }

    if (reachedHeadRow && !traversalInvalid) {
      const selectedRanges = ranges.length > 0 ? ranges : endCursors
      if (selectedRanges.length > 0) {
        return EditorSelection.create(selectedRanges, 0)
      }
    }
  }

  if (anchorCoords) {
    const measuredSelection = measuredVisualColumnSelection(
      view,
      measurer,
      anchor,
      anchorCoords,
      head,
      event
    )
    if (measuredSelection) return measuredSelection
  }

  const headLine = view.state.doc.lineAt(head.head)
  const columnReference =
    head.head === headLine.to ? view.coordsAtPos(view.viewport.from) : null
  const headColumn = columnReference
    ? Math.round(
        Math.abs(
          (columnReference.left - event.clientX) / view.defaultCharacterWidth
        )
      )
    : undefined
  return sourceColumnSelection(view.state, anchor.head, head.head, headColumn)
}

function sourceColumnSelectionStyle(
  view: EditorView,
  event: MouseEvent
): MouseSelectionStyle | null {
  if (!event.altKey || event.button !== 0) return null
  if (!event.shiftKey) {
    let selection = view.state.selection
    return {
      get(currentEvent) {
        const position = view.posAndSideAtCoords(
          { x: currentEvent.clientX, y: currentEvent.clientY },
          false
        )
        if (selection.ranges.length > 1) {
          const removedIndex = selection.ranges.findIndex(
            (range) => range.from <= position.pos && range.to >= position.pos
          )
          if (removedIndex >= 0) {
            const ranges = selection.ranges.filter(
              (_, index) => index !== removedIndex
            )
            const mainIndex =
              selection.mainIndex === removedIndex
                ? 0
                : selection.mainIndex -
                  (selection.mainIndex > removedIndex ? 1 : 0)
            return EditorSelection.create(ranges, mainIndex)
          }
        }
        return selection.addRange(
          EditorSelection.cursor(position.pos, position.assoc),
          false
        )
      },
      update(update) {
        if (update.docChanged) selection = selection.map(update.changes)
      },
    }
  }

  let origin = view.state.field(sourceColumnSelectionOrigin)
  let measurer = new SourceColumnMeasurer(view)
  const ownerDocument = view.dom.ownerDocument
  const ownerWindow = ownerDocument.defaultView
  const destroyMeasurer = () => {
    ownerDocument.removeEventListener("mouseup", destroyMeasurer)
    ownerWindow?.removeEventListener("blur", destroyMeasurer)
    if (ownerWindow) ownerWindow.setTimeout(() => measurer.destroy(), 0)
    else measurer.destroy()
  }
  ownerDocument.addEventListener("mouseup", destroyMeasurer)
  ownerWindow?.addEventListener("blur", destroyMeasurer)

  return {
    get(currentEvent) {
      return visualColumnSelection(view, origin, currentEvent, measurer)
    },
    update(update) {
      if (update.docChanged) {
        origin = origin.map(update.changes, origin.assoc || 1)
      }
      if (update.docChanged || update.geometryChanged) {
        measurer.destroy()
        measurer = new SourceColumnMeasurer(view)
      }
      return update.geometryChanged || update.viewportMoved
    },
  }
}

function sourcePresentation(): Extension {
  return [
    sourceColumnSelectionOrigin,
    EditorView.mouseSelectionStyle.of(sourceColumnSelectionStyle),
    EditorView.editorAttributes.of({ class: "cm-md-source" }),
    lineNumbers(),
    highlightActiveLineGutter(),
  ]
}

interface ContentTextMetrics {
  charWidth: number
  lineHeight: number
  textHeight: number
}

interface PinnedEditorViewInternals {
  docView: {
    measureTextSize(): ContentTextMetrics
  }
  inputState: {
    mouseSelection: {
      setScrollSpeed(x: number, y: number): void
    } | null
  }
  observer: {
    ignore<T>(operation: () => T): T
    setSelectionRange(anchor: DOMSelectionPoint, head: DOMSelectionPoint): void
  }
  viewState: {
    mustMeasureContent: boolean | "refresh"
  }
}

const contentTextMetricRefreshers = new WeakMap<EditorView, () => void>()
const contentTextMetricSample = "abc def ghi jkl mno pqr stu"

function measurePlainContentTextSize(
  view: EditorView,
  observer: PinnedEditorViewInternals["observer"]
): ContentTextMetrics {
  const ownerDocument = view.dom.ownerDocument
  const ownerWindow = ownerDocument.defaultView
  const dummy = ownerDocument.createElement("div")
  const text = ownerDocument.createTextNode(contentTextMetricSample)
  dummy.className = "cm-line"
  dummy.setAttribute("aria-hidden", "true")
  dummy.style.position = "absolute"
  dummy.style.width = "99999px"
  dummy.append(text)

  let charWidth = 0
  let lineHeight = 0
  let textHeight = 0
  observer.ignore(() => {
    view.contentDOM.append(dummy)
    try {
      const range = ownerDocument.createRange()
      range.selectNodeContents(text)
      const textRect = range.getClientRects()[0]
      const lineRect = dummy.getBoundingClientRect()
      const style = ownerWindow?.getComputedStyle(dummy)
      const fontSize = Number.parseFloat(style?.fontSize ?? "") || 14
      const computedLineHeight = Number.parseFloat(style?.lineHeight ?? "")
      const paddingBlock =
        (Number.parseFloat(style?.paddingTop ?? "") || 0) +
        (Number.parseFloat(style?.paddingBottom ?? "") || 0)

      lineHeight =
        lineRect.height ||
        (Number.isFinite(computedLineHeight)
          ? computedLineHeight + paddingBlock
          : fontSize + paddingBlock)
      charWidth =
        textRect?.width && textRect.width > 0
          ? textRect.width / contentTextMetricSample.length
          : fontSize * 0.5
      textHeight =
        textRect?.height && textRect.height > 0 ? textRect.height : fontSize
    } finally {
      dummy.remove()
    }
  })

  return { charWidth, lineHeight, textHeight }
}

function installStableContentTextMeasurement(view: EditorView) {
  // CodeMirror normally derives its document-wide height oracle from the
  // first short ASCII line in the mounted viewport. Live preview deliberately
  // gives headings, YAML, code, and other lines different typography, so that
  // viewport-local sample can rescale every unmeasured gap and visibly move the
  // document during scrolling. Keep the pinned view version calibrated to an
  // undecorated line instead.
  const internals = view as unknown as PinnedEditorViewInternals
  let metrics: ContentTextMetrics
  const refresh = () => {
    metrics = measurePlainContentTextSize(view, internals.observer)
    // setState() replaces docView, so reapply the pinned override whenever a
    // deliberate geometry refresh follows a session activation.
    internals.docView.measureTextSize = () => metrics
  }
  contentTextMetricRefreshers.set(view, refresh)
  refresh()
}

function requestContentGeometryRefresh(view: EditorView) {
  contentTextMetricRefreshers.get(view)?.()
  // CodeMirror's one-shot document.fonts.ready hook marks its private view
  // state as a full refresh before measuring. FontFaceSet can finish more
  // faces later, and requestMeasure() alone can skip content measurement when
  // .cm-content's min-height keeps its outer rectangle unchanged. Mirror the
  // library's refresh flag so wrapping, gutters, and drawn selections all use
  // the newly loaded font metrics. @codemirror/view is pinned while this
  // internal flag is required.
  const viewState = (view as unknown as PinnedEditorViewInternals).viewState
  viewState.mustMeasureContent = "refresh"
  view.requestMeasure()
}

interface ScrollAnchor {
  assoc?: -1 | 0 | 1
  pos: number
  screenOffset: number
  scrollLeft: number
}

interface EditorScrollPosition {
  scrollLeft: number
  scrollTop: number
}

interface DOMSelectionPoint {
  readonly node: Node
  readonly offset: number
}

interface SemanticBoundaryEndpoint {
  readonly clientX: number
  readonly clientY: number
  readonly nearStart: boolean
  readonly semantic: SemanticPreviewSelection
}

type SemanticPointerLocation = Pick<
  MouseEvent,
  "clientX" | "clientY" | "target"
>

interface SemanticPointerGesture {
  boundaryEndpoint: SemanticBoundaryEndpoint | null
  boundarySemantic: SemanticPreviewSelection | null
  nativeAnchor: DOMSelectionPoint | null
  nativeBoundaries: {
    readonly end: DOMSelectionPoint
    readonly start: DOMSelectionPoint
  } | null
  readonly origin: SemanticPreviewSelection | null
  readonly pointerScroll: EditorScrollPosition
  readonly startPosition: number | null
  readonly startX: number
  readonly startY: number
  dragged: boolean
  renderedSelection: boolean
}

interface SearchMatchCache {
  checkpointBuffer: number[] | null
  checkpoints: Float64Array
  complete: boolean
  cursor: Iterator<SearchCursorMatch> | null
  doc: StateText
  includeFrom: number
  includeTo: number
  nextLine: number
  nextOffset: number
  query: SearchQuery
  rangesExhausted: boolean
  scanKind: "literal" | "multiline-regexp" | "single-line-regexp"
  state: EditorState
  total: number
}

interface ReplacementMatch {
  from: number
  to: number
  precise: boolean
  regexpMatch?: RegExpExecArray
}

const searchCheckpointStride = 256
const searchScanCharacterBudget = 64 * 1024
const searchScanMatchBudget = 8 * 1024
const searchScanTimeBudget = 6
function literalSearchOverlap(query: SearchQuery) {
  const unquoted = query.literal
    ? query.search
    : query.search.replace(/\\([nrt\\])/g, (_match, character: string) =>
        character === "n"
          ? "\n"
          : character === "r"
            ? "\r"
            : character === "t"
              ? "\t"
              : "\\"
      )
  const normalized =
    typeof unquoted.normalize === "function"
      ? unquoted.normalize("NFKD")
      : unquoted
  const normalizedLength = (
    query.caseSensitive ? normalized : normalized.toLowerCase()
  ).length
  // A contributing Unicode scalar occupies at most two UTF-16 source units
  // and NFKD emits at least one normalized unit, so twice the normalized
  // query length bounds the match's source span. Keep one more full scalar
  // available for whole-word/custom-test context at the right edge.
  return Math.max(1, normalizedLength * 2 + 2)
}

type LetterCase = "capitalized" | "lower" | "mixed" | "none" | "upper"

function matchingQueryEqual(left: SearchQuery, right: SearchQuery) {
  return (
    left.search === right.search &&
    left.caseSensitive === right.caseSensitive &&
    left.literal === right.literal &&
    left.regexp === right.regexp &&
    left.wholeWord === right.wholeWord &&
    left.test === right.test
  )
}

function searchStatusEqual(
  left: MarkdownSearchStatus | null,
  right: MarkdownSearchStatus
) {
  return (
    left?.valid === right.valid &&
    left.pending === right.pending &&
    left.current === right.current &&
    left.total === right.total &&
    left.issue === right.issue
  )
}

function letterCase(value: string): LetterCase {
  const letters = [...value].filter(
    (character) =>
      character.toLocaleLowerCase() !== character.toLocaleUpperCase()
  )
  if (letters.length === 0) return "none"
  if (letters.every((character) => character === character.toLocaleUpperCase()))
    return "upper"
  if (letters.every((character) => character === character.toLocaleLowerCase()))
    return "lower"
  if (
    letters[0] === letters[0]?.toLocaleUpperCase() &&
    letters
      .slice(1)
      .every((character) => character === character.toLocaleLowerCase())
  ) {
    return "capitalized"
  }
  return "mixed"
}

function capitalize(value: string) {
  const characters = [...value.toLocaleLowerCase()]
  const firstLetter = characters.findIndex(
    (character) =>
      character.toLocaleLowerCase() !== character.toLocaleUpperCase()
  )
  if (firstLetter >= 0) {
    characters[firstLetter] = characters[firstLetter]!.toLocaleUpperCase()
  }
  return characters.join("")
}

function applyLetterCase(value: string, sourceCase: LetterCase) {
  switch (sourceCase) {
    case "upper":
      return value.toLocaleUpperCase()
    case "lower":
      return value.toLocaleLowerCase()
    case "capitalized":
      return capitalize(value)
    default:
      return value
  }
}

function preserveReplacementCase(source: string, replacement: string) {
  const sourceCase = letterCase(source)
  if (sourceCase !== "mixed") return applyLetterCase(replacement, sourceCase)

  const sourceWords = source.match(/[\p{L}\p{N}]+/gu) ?? []
  const replacementWords = replacement.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    sourceWords.length <= 1 ||
    sourceWords.length !== replacementWords.length
  ) {
    return replacement
  }

  let wordIndex = 0
  return replacement.replace(/[\p{L}\p{N}]+/gu, (word) =>
    applyLetterCase(word, letterCase(sourceWords[wordIndex++]!))
  )
}

function unquoteReplacement(value: string) {
  return value.replace(/\\([nrt\\])/g, (_, character: string) => {
    if (character === "n") return "\n"
    if (character === "r") return "\r"
    if (character === "t") return "\t"
    return "\\"
  })
}

function expandRegexpReplacement(replacement: string, match: RegExpExecArray) {
  return unquoteReplacement(replacement).replace(
    /\$([$&]|\d+)/g,
    (source, token: string) => {
      if (token === "&") return match[0]
      if (token === "$") return "$"
      for (let length = token.length; length > 0; length -= 1) {
        const group = Number(token.slice(0, length))
        if (group > 0 && group < match.length) {
          return (match[group] ?? "") + token.slice(length)
        }
      }
      return source
    }
  )
}

const caretNavigationKeys = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Home",
  "PageDown",
  "PageUp",
  "Tab",
])

function keyShowsCaret(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey) return false
  return event.key.length === 1 || caretNavigationKeys.has(event.key)
}

function pointHitsScrollbar(element: HTMLElement, x: number, y: number) {
  const rect = element.getBoundingClientRect()
  const verticalWidth = Math.max(element.offsetWidth - element.clientWidth, 12)
  const horizontalHeight = Math.max(
    element.offsetHeight - element.clientHeight,
    12
  )
  const hitsVertical =
    element.scrollHeight > element.clientHeight &&
    x >= rect.right - verticalWidth
  const hitsHorizontal =
    element.scrollWidth > element.clientWidth &&
    y >= rect.bottom - horizontalHeight
  return hitsVertical || hitsHorizontal
}

export class MarkdownEditorController implements MarkdownEditorHandle {
  readonly view: EditorView

  private readonly presentation = new Compartment()
  private readonly markdownLanguageConfiguration = new Compartment()
  private readonly indentation = new Compartment()
  private readonly wrapping = new Compartment()
  private readonly layout = new Compartment()
  private readonly historyConfiguration = new Compartment()
  private readonly caretVisibility = new Compartment()
  private readonly editability = new Compartment()
  private readonly syntaxTheme = new Compartment()
  private readonly surfaceTheme = new Compartment()
  private readonly documentPathConfiguration = new Compartment()
  private readonly remoteImagesConfiguration = new Compartment()
  private readonly searchConfiguration = new Compartment()
  private readonly spellCheckConfiguration = new Compartment()
  private readonly documentBehaviorConfiguration = new Compartment()
  private readonly pathCompletionConfiguration = new Compartment()
  private readonly plainTextLanguageFallback: Extension = []
  private readonly plainTextBehaviorExtension: Extension = []
  private readonly markdownBehaviorExtension: Extension
  private readonly onChange:
    | ((mapNavigationLocation: MarkdownNavigationLocationMapper) => void)
    | undefined
  private readonly onModeChange:
    ((mode: MarkdownEditorMode) => void) | undefined
  private readonly onLineWrappingChange:
    ((enabled: boolean) => void) | undefined
  private readonly onNavigate:
    ((origin: MarkdownNavigationLocation) => void) | undefined
  private readonly onSearchStatusChange:
    ((status: MarkdownSearchStatus) => void) | undefined
  private readonly onStatusChange: ((status: EditorStatus) => void) | undefined
  private readonly onLinkTooltipChange:
    ((tooltip: MarkdownLinkTooltip | null) => void) | undefined
  private readonly openLink:
    ((activation: MarkdownLinkActivation) => void | Promise<void>) | undefined
  private readonly ariaLabel: string
  private readonly platform: "darwin" | "linux" | "win32"
  private readonly ownerWindow: Window | null
  private mode: MarkdownEditorMode
  private documentKind: DocumentKind
  private sourceIndentation: SourceIndentation
  private sourceIndentSize: number
  private lineWrapping: boolean
  private maxContentWidth: number | undefined
  private documentPath: string | null
  private remoteImagesEnabled = false
  private appearanceProfile: AppearanceProfile
  private markdownExtensions: MarkdownExtensionSettings
  private optionalLivePreviewSupport: OptionalLivePreviewSupport | null
  private codeLanguages: readonly LanguageDescription[] = []
  private codeLanguageSupportEnabled = false
  private topLevelLanguageRequest = 0
  private searchSupport: EditorSearchSupport | null = null
  private currentSearchExtension: Extension = []
  private readonly checkSpelling: SpellCheckWords
  private spellCheckEnabled: boolean
  private currentSpellCheckExtension: Extension
  private currentPathCompletionExtension: Extension = []
  private readonly markdownLanguageExtensionCache = new Map<string, Extension>()
  private readonly livePresentationExtensionCache = new Map<string, Extension>()
  private readonly sourcePresentationExtension = sourcePresentation()
  private currentMarkdownLanguageExtension: Extension
  private currentPresentationExtensions: Record<MarkdownEditorMode, Extension>
  private windowActive = true
  private readOnly = false
  private caretVisible = false
  private revealCaretOnEscape = false
  private pendingMode: MarkdownEditorMode | null = null
  private destroyed = false
  private modeFrame: number | null = null
  private caretActivation = 0
  private contextMenuSelectionBeforePointer: EditorSelection | null = null
  private contextMenuPreservesRenderedSelection = false
  private pointerMoveFrame: number | null = null
  private pendingPointerMove: {
    clientX: number
    clientY: number
    target: EventTarget | null
  } | null = null
  private caretMouseUpPending = false
  private caretPointerScroll: EditorScrollPosition | null = null
  private semanticPointerSelection: {
    anchor: number
    head: number
    scroll: EditorScrollPosition
  } | null = null
  private semanticPointerGesture: SemanticPointerGesture | null = null
  private semanticBoundaryCaret: HTMLElement | null = null
  private semanticBoundaryTarget: HTMLElement | null = null
  private renderedSemanticSelection: HTMLElement | null = null
  private semanticDisjointSelection: {
    readonly doc: StateText
    readonly selection: EditorSelection
    readonly text: string
  } | null = null
  private semanticBoundaryFrame: number | null = null
  private semanticBoundaryPointerFrame: number | null = null
  private pendingSemanticBoundaryPointer:
    | (SemanticPointerLocation & {
        readonly gesture: SemanticPointerGesture
        readonly semantic: SemanticPreviewSelection | null
      })
    | null = null
  private semanticBoundaryAutoScrollFrame: number | null = null
  private semanticBoundaryAutoScrollPointer:
    | (SemanticPointerLocation & {
        readonly gesture: SemanticPointerGesture
      })
    | null = null
  private semanticBoundaryAutoScrollTimestamp = 0
  private semanticScrollFrame: number | null = null
  private anchorFrame: number | null = null
  private pendingScrollAnchor: ScrollAnchor | null = null
  private anchorRestoreAttempts = 0
  private searchMatchCache: SearchMatchCache | null = null
  private searchScanTimer: ReturnType<typeof setTimeout> | null = null
  private lastSearchStatus: MarkdownSearchStatus | null = null
  private linkTooltipAnchor: HTMLElement | null = null
  private linkTooltipDestination: string | null = null
  private openLinkModifierActive = false

  constructor(options: MarkdownEditorControllerOptions) {
    this.documentKind = options.documentKind ?? "markdown"
    this.mode = this.modeForDocumentKind(options.mode ?? "live")
    this.sourceIndentation = this.validateSourceIndentation(
      options.sourceIndentation ?? "spaces"
    )
    this.sourceIndentSize = this.validateSourceIndentSize(
      options.sourceIndentSize ?? 2
    )
    this.lineWrapping = options.lineWrapping ?? true
    this.maxContentWidth = this.validateMaxContentWidth(options.maxContentWidth)
    this.documentPath = options.documentPath ?? null
    this.markdownExtensions = normalizedMarkdownExtensions(
      options.markdownExtensions
    )
    this.optionalLivePreviewSupport = options.optionalLivePreviewSupport ?? null
    this.checkSpelling = options.checkSpelling ?? (() => [])
    this.spellCheckEnabled =
      options.spellCheck === true && options.checkSpelling !== undefined
    this.currentSpellCheckExtension = this.spellCheckEnabled
      ? spellCheckExtension(this.checkSpelling)
      : []
    this.currentMarkdownLanguageExtension =
      this.memoizedMarkdownLanguageExtension()
    this.currentPresentationExtensions = {
      live: this.memoizedPresentationExtension("live"),
      source: this.memoizedPresentationExtension("source"),
    }
    this.appearanceProfile = options.appearanceProfile
      ? { ...options.appearanceProfile }
      : {
          backgroundId: "default",
          customBackgroundColor: "#ffffff",
          syntaxThemeId: "default",
        }
    const initialContent = normalizeEditorContent(options.content ?? "")
    this.caretVisible =
      options.autofocus === true || initialContent.length === 0
    this.onChange = options.onChange
    this.onModeChange = options.onModeChange
    this.onLineWrappingChange = options.onLineWrappingChange
    this.onNavigate = options.onNavigate
    this.onSearchStatusChange = options.onSearchStatusChange
    this.onStatusChange = options.onStatusChange
    this.onLinkTooltipChange = options.onLinkTooltipChange
    this.openLink = options.openLink
    this.markdownBehaviorExtension = [
      delimiterAppearanceExtension,
      selectedTextWrappingExtension,
      pastedUrlWrappingExtension,
      ...(options.resolveHeadingLinkPaste
        ? [pastedHeadingLinkExtension(options.resolveHeadingLinkPaste)]
        : []),
      renderedMarkdownPasteExtension(),
      livePreviewFocusTrackingExtension,
    ]
    this.ariaLabel = options.ariaLabel ?? "Text editor"
    this.platform =
      options.platform ??
      (/Mac|iPhone|iPad/.test(
        options.parent.ownerDocument.defaultView?.navigator.platform ?? ""
      )
        ? "darwin"
        : "linux")
    this.ownerWindow = options.parent.ownerDocument.defaultView

    const state = this.createEditorState(
      initialContent,
      this.mode,
      this.lineWrapping,
      this.caretVisible,
      this.documentPath,
      this.documentKind
    )

    this.view = new EditorView({
      state,
      parent: options.parent,
      dispatchTransactions: this.dispatchTransactions,
    })
    installStableContentTextMeasurement(this.view)
    this.view.dom.ownerDocument.fonts.addEventListener(
      "loadingdone",
      this.handleFontLoadingDone
    )
    this.view.dom.ownerDocument.addEventListener(
      "copy",
      this.handleOwnedPointerClipboard,
      true
    )
    this.view.dom.ownerDocument.addEventListener(
      "cut",
      this.handleOwnedPointerClipboard,
      true
    )
    this.setWindowActive(options.windowActive ?? true)
    this.view.dom.addEventListener("mousedown", this.handleMouseDown, true)
    this.view.dom.addEventListener("pointermove", this.handlePointerMove, {
      passive: true,
    })
    this.view.dom.addEventListener("pointerleave", this.handlePointerLeave)
    this.view.scrollDOM.addEventListener("wheel", this.handleEditorWheel, {
      passive: true,
    })
    this.view.scrollDOM.addEventListener("scroll", this.clearLinkTooltip, {
      passive: true,
    })
    this.ownerWindow?.addEventListener(
      "keydown",
      this.handleOpenLinkModifierChange
    )
    this.ownerWindow?.addEventListener(
      "keyup",
      this.handleOpenLinkModifierChange
    )
    this.ownerWindow?.addEventListener(
      "keydown",
      this.handleCaretVisibilityKeyDown
    )
    this.ownerWindow?.addEventListener("blur", this.handleWindowBlur)
    this.ownerWindow?.addEventListener("resize", this.clearLinkTooltip)
    this.view.contentDOM.addEventListener(
      "compositionstart",
      this.handleCompositionStart
    )
    this.view.contentDOM.addEventListener(
      "compositionend",
      this.handleCompositionEnd
    )
    if (options.initialCursor) {
      this.setCursorPosition(
        options.initialCursor.line,
        options.initialCursor.column
      )
    }
    if (this.caretVisible) this.view.focus()
    this.onStatusChange?.(this.getStatus())
    this.reportSearchStatus(this.view.state)
  }

  getContent() {
    return this.view.state.doc.toString()
  }

  enableCodeLanguageSupport(codeLanguages: readonly LanguageDescription[]) {
    if (this.destroyed || this.codeLanguageSupportEnabled) return
    this.codeLanguageSupportEnabled = true
    this.codeLanguages = [...codeLanguages]
    this.markdownLanguageExtensionCache.clear()
    this.currentMarkdownLanguageExtension =
      this.memoizedMarkdownLanguageExtension()
    this.refreshActiveTopLevelLanguage()
  }

  enableSearchSupport(support: EditorSearchSupport) {
    if (this.destroyed || this.searchSupport) return
    this.searchSupport = support
    this.currentSearchExtension = support.extension
    this.view.dispatch({
      effects: this.searchConfiguration.reconfigure(
        this.currentSearchExtension
      ),
    })
    this.reportSearchStatus(this.view.state)
  }

  canUndo() {
    return undoDepth(this.view.state) > 0
  }

  canRedo() {
    return redoDepth(this.view.state) > 0
  }

  hasSelection() {
    const state = this.view.state
    if (
      this.documentKind === "markdown" &&
      state.field(tableCellRangeSelectionState, false) != null
    ) {
      return true
    }

    const renderedElement = this.renderedSemanticSelection
    const renderedSelection = renderedElement?.ownerDocument.getSelection()
    if (
      renderedElement?.isConnected &&
      renderedSelection &&
      !renderedSelection.isCollapsed &&
      renderedSelection.rangeCount > 0 &&
      renderedElement.contains(renderedSelection.anchorNode) &&
      renderedElement.contains(renderedSelection.focusNode)
    ) {
      return true
    }

    const disjoint = this.semanticDisjointSelection
    if (
      disjoint &&
      disjoint.text.length > 0 &&
      state.doc === disjoint.doc &&
      state.selection.eq(disjoint.selection)
    ) {
      return true
    }

    return !state.selection.main.empty
  }

  getSelectedText() {
    const tableSelection =
      this.documentKind === "markdown"
        ? tableCellRangeSelectionSnapshot(this.view.state)
        : null
    if (tableSelection) return tableSelection.text
    const renderedText = this.renderedSemanticSelectionText()
    if (renderedText) return renderedText
    const disjoint = this.semanticDisjointSelection
    if (
      disjoint &&
      this.view.state.doc === disjoint.doc &&
      this.view.state.selection.eq(disjoint.selection)
    ) {
      return disjoint.text
    }
    const selection = this.view.state.selection.main
    return selection.empty
      ? ""
      : this.view.state.sliceDoc(selection.from, selection.to)
  }

  getOwnedPointerSelection() {
    const text =
      this.renderedSemanticSelectionText() ??
      this.validSemanticDisjointSelectionText()
    return text ? text : null
  }

  async copyOwnedPointerSelection() {
    const text = this.getOwnedPointerSelection()
    if (!text) return false
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    try {
      if (ownerWindow?.navigator.clipboard?.writeText) {
        await ownerWindow.navigator.clipboard.writeText(text)
        return true
      }

      const ownerDocument = this.view.dom.ownerDocument
      const textarea = ownerDocument.createElement("textarea")
      textarea.value = text
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      ownerDocument.body.append(textarea)
      textarea.select()
      const copied = ownerDocument.execCommand("copy")
      textarea.remove()
      return copied
    } catch {
      return false
    }
  }

  getTableCellRangeSelection() {
    return this.documentKind === "markdown"
      ? tableCellRangeSelectionSnapshot(this.view.state)
      : null
  }

  tableCellRangeSelectionContainsCoordinates(clientX: number, clientY: number) {
    return (
      this.documentKind === "markdown" &&
      tableCellRangeSelectionContainsCoordinates(this.view, clientX, clientY)
    )
  }

  retargetContextMenuSelection(
    clientX: number,
    clientY: number,
    preferredWord = ""
  ) {
    if (this.destroyed) return
    if (
      this.contextMenuPreservesRenderedSelection &&
      this.renderedSemanticSelectionText()
    ) {
      this.contextMenuPreservesRenderedSelection = false
      return
    }
    this.contextMenuPreservesRenderedSelection = false
    const selectionBeforePointer = this.contextMenuSelectionBeforePointer
    this.contextMenuSelectionBeforePointer = null
    if (
      this.documentKind === "markdown" &&
      tableCellRangeSelectionContainsCoordinates(this.view, clientX, clientY)
    ) {
      return
    }

    const position = this.view.posAtCoords({ x: clientX, y: clientY })
    if (position == null) return
    const previousMain = selectionBeforePointer?.main
    if (
      previousMain &&
      !previousMain.empty &&
      position >= previousMain.from &&
      position <= previousMain.to
    ) {
      if (!this.view.state.selection.eq(selectionBeforePointer)) {
        this.view.dispatch({
          selection: selectionBeforePointer,
          userEvent: "select.pointer",
        })
      }
      return
    }
    let target: SelectionRange | null = null
    if (preferredWord) {
      const line = this.view.state.doc.lineAt(position)
      let offset = line.text.indexOf(preferredWord)
      let nearestDistance = Number.POSITIVE_INFINITY
      while (offset >= 0) {
        const from = line.from + offset
        const to = from + preferredWord.length
        const distance =
          position < from ? from - position : position > to ? position - to : 0
        if (distance < nearestDistance) {
          target = EditorSelection.range(from, to)
          nearestDistance = distance
        }
        offset = line.text.indexOf(preferredWord, offset + 1)
      }
    }
    target ??= this.view.state.wordAt(position)

    this.view.dispatch({
      selection: target ?? EditorSelection.cursor(position),
      userEvent: "select.pointer",
    })
  }

  copyTableCellRange() {
    if (this.documentKind !== "markdown") return Promise.resolve(false)
    return runTableCellRangeClipboardCommand(this.view, "copy")
  }

  async cutTableCellRange() {
    if (this.documentKind !== "markdown") return false
    const completed = await runTableCellRangeClipboardCommand(this.view, "cut")
    if (completed) {
      this.showCaret()
      this.view.focus()
    }
    return completed
  }

  linkActivationAtCoordinates(
    clientX: number,
    clientY: number,
    target?: Element | null
  ) {
    if (this.documentKind !== "markdown" || this.mode !== "live") return null
    const headingActivation = this.headingLinkActivationForElement(
      target === undefined
        ? (this.ownerWindow?.document.elementFromPoint(clientX, clientY) ??
            null)
        : target
    )
    if (headingActivation) return headingActivation
    const position = this.view.posAtCoords({ x: clientX, y: clientY })
    return position == null
      ? null
      : markdownLinkActivationAt(this.view.state, position)
  }

  linkActivationAtSelection() {
    if (this.documentKind !== "markdown" || this.mode !== "live") return null
    const position = this.view.state.selection.main.head
    return (
      markdownLinkActivationAt(this.view.state, position) ??
      this.headingLinkActivationAtPosition(position)
    )
  }

  private headingLinkActivationAtPosition(
    position: number
  ): MarkdownLinkActivation | null {
    const heading = markdownHeadings(this.view.state).find(
      (candidate) => candidate.from <= position && position <= candidate.to
    )
    return heading ? { kind: "fragment", fragment: heading.slug } : null
  }

  private headingLinkActivationForElement(
    element: Element | null
  ): MarkdownLinkActivation | null {
    const anchor = element?.closest<HTMLElement>("[data-markdown-heading-from]")
    if (!anchor || (anchor.isConnected && !this.view.dom.contains(anchor))) {
      return null
    }
    const headingFrom = Number(anchor.dataset.markdownHeadingFrom)
    if (!Number.isSafeInteger(headingFrom)) return null
    const heading = markdownHeadings(this.view.state).find(
      (candidate) => candidate.from === headingFrom
    )
    return heading ? { kind: "fragment", fragment: heading.slug } : null
  }

  spellingAtCoordinates(
    clientX: number,
    clientY: number
  ): SpellingCandidate | null {
    if (this.destroyed || !this.spellCheckEnabled) return null
    const position = this.view.posAtCoords({ x: clientX, y: clientY })
    if (position == null) return null
    const candidate = spellingCandidateAt(this.view.state, position)
    if (!candidate) return null
    try {
      return this.checkSpelling([candidate.word])?.[0] === true
        ? candidate
        : null
    } catch {
      return null
    }
  }

  replaceSpellingSelection(word: string, replacement: string) {
    if (this.destroyed || this.view.state.readOnly || !word || !replacement) {
      return false
    }
    const selection = this.view.state.selection.main
    if (
      selection.empty ||
      this.view.state.sliceDoc(selection.from, selection.to) !== word
    ) {
      return false
    }
    this.showCaret()
    this.view.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: replacement,
      },
      selection: EditorSelection.cursor(selection.from + replacement.length),
      userEvent: "input.replace",
    })
    return true
  }

  createSession(
    content = "",
    mode: MarkdownEditorMode = "live",
    documentPath: string | null = null,
    lineWrapping = true,
    documentKind: DocumentKind = "markdown"
  ): MarkdownEditorSession {
    const normalized = normalizeEditorContent(content)
    const caretVisible = normalized.length === 0
    const resolvedMode = this.modeForDocumentKind(mode, documentKind)
    return {
      state: this.createEditorState(
        normalized,
        resolvedMode,
        lineWrapping,
        caretVisible,
        documentPath,
        documentKind
      ),
      documentKind,
      documentPath,
      mode: resolvedMode,
      lineWrapping,
      caretVisible,
      viewport: { pos: 0, screenOffset: 0, scrollLeft: 0, scrollTop: 0 },
      viewportInitialized: false,
      revision: 0,
    }
  }

  captureSession(revision = 0): MarkdownEditorSession {
    const anchor = this.captureScrollAnchor()
    return {
      state: this.view.state,
      documentKind: this.documentKind,
      documentPath: this.documentPath,
      scrollSnapshot: this.view.scrollSnapshot(),
      mode: this.mode,
      lineWrapping: this.lineWrapping,
      caretVisible: this.caretVisible,
      viewport: {
        pos: anchor.pos,
        screenOffset: anchor.screenOffset,
        scrollLeft: this.view.scrollDOM.scrollLeft,
        scrollTop: this.view.scrollDOM.scrollTop,
      },
      viewportInitialized: true,
      revision,
    }
  }

  private configureSessionForActivation(session: MarkdownEditorSession) {
    const nextPath = session.documentPath || null
    session.mode = this.modeForDocumentKind(session.mode, session.documentKind)
    const effects: StateEffect<unknown>[] = []
    if (session.documentKind === "markdown") {
      effects.push(
        setLivePreviewEditorFocused.of(this.view.hasFocus),
        setLivePreviewFocusRetained.of(false)
      )
    }
    if (session.state.facet(markdownDocumentPath) !== nextPath) {
      effects.push(
        this.documentPathConfiguration.reconfigure(
          markdownDocumentPath.of(nextPath)
        ),
        refreshLivePreview.of(null)
      )
    }
    if (
      session.state.facet(markdownRemoteImagesEnabled) !==
      this.remoteImagesEnabled
    ) {
      effects.push(
        this.remoteImagesConfiguration.reconfigure(
          markdownRemoteImagesEnabled.of(this.remoteImagesEnabled)
        ),
        refreshLivePreview.of(null)
      )
    }
    if (effects.length > 0) {
      session.state = session.state.update({ effects }).state
    }
    this.documentKind = session.documentKind
    this.documentPath = nextPath
  }

  activateSession(session: MarkdownEditorSession): boolean {
    if (this.destroyed || this.view.compositionStarted) return false
    this.resetSemanticPointerInteraction()
    this.cancelSearchScan()
    this.cancelScrollAnchorRestore()
    this.clearLinkTooltip()
    this.pendingMode = null
    this.topLevelLanguageRequest += 1
    session.mode = this.modeForDocumentKind(session.mode, session.documentKind)
    this.mode = session.mode
    this.lineWrapping = session.lineWrapping
    this.caretVisible = session.caretVisible
    this.revealCaretOnEscape = false
    this.configureSessionForActivation(session)
    const documentConfigurationEffects = this.documentConfigurationEffects(
      session.state,
      session.mode,
      session.documentKind,
      session.documentPath
    )
    this.view.setState(session.state)

    const resolvedProfile = resolveAppearanceProfile(this.appearanceProfile)
    const restoreViewport = session.viewportInitialized
    this.view.dispatch({
      effects: [
        ...documentConfigurationEffects,
        this.indentation.reconfigure(
          indentUnit.of(this.indentUnitFor(session.mode))
        ),
        this.layout.reconfigure(
          contentLayoutTheme(session.lineWrapping, this.maxContentWidth)
        ),
        this.syntaxTheme.reconfigure(
          syntaxThemeExtension(
            this.appearanceProfile.syntaxThemeId,
            resolvedProfile.backgroundColor
          )
        ),
        this.surfaceTheme.reconfigure(
          EditorView.darkTheme.of(resolvedProfile.surfaceScheme === "dark")
        ),
        this.caretVisibility.reconfigure(
          this.caretExtension(session.caretVisible)
        ),
        this.editability.reconfigure(this.editabilityExtension(this.readOnly)),
        setSelectionWindowActive.of(this.windowActive),
        ...(restoreViewport
          ? [
              session.scrollSnapshot ??
                EditorView.scrollIntoView(
                  Math.min(session.viewport.pos, session.state.doc.length),
                  { y: "start" }
                ),
            ]
          : []),
      ],
    })
    session.state = this.view.state
    requestContentGeometryRefresh(this.view)
    // setState() leaves the outgoing document's physical scroll offset on the
    // shared scroller. Seed a retained session's exact offset immediately so
    // its virtual viewport is materialized around the saved semantic anchor
    // before the next paint. A never-mounted session starts at physical zero,
    // preserving the content padding that keeps its first line below chrome.
    // The anchor restore still corrects retained sessions for geometry changes
    // made while they were inactive.
    this.view.scrollDOM.scrollTop = restoreViewport
      ? session.viewport.scrollTop
      : 0
    this.view.scrollDOM.scrollLeft = restoreViewport
      ? session.viewport.scrollLeft
      : 0
    if (restoreViewport) {
      this.startScrollAnchorRestore({
        pos: Math.min(session.viewport.pos, this.view.state.doc.length),
        screenOffset: session.viewport.screenOffset,
        scrollLeft: session.viewport.scrollLeft,
      })
    } else {
      session.viewportInitialized = true
    }
    this.onStatusChange?.(this.getStatus())
    this.searchMatchCache = null
    this.reportSearchStatus(this.view.state)
    this.refreshActiveTopLevelLanguage()
    return true
  }

  replaceSessionDocument(
    session: MarkdownEditorSession,
    content: string
  ): boolean {
    const normalized = normalizeEditorContent(content)
    const active = session.state === this.view.state
    if (normalized === session.state.doc.toString()) return true
    if (this.destroyed || (active && this.view.compositionStarted)) return false

    const nextLength = normalized.length
    const selection = EditorSelection.create(
      session.state.selection.ranges.map((range) =>
        EditorSelection.range(
          Math.min(range.anchor, nextLength),
          Math.min(range.head, nextLength)
        )
      ),
      session.state.selection.mainIndex
    )
    const replacement = {
      changes: {
        from: 0,
        to: session.state.doc.length,
        insert: normalized,
      },
      selection,
      annotations: [
        suppressChangeNotification.of(true),
        Transaction.addToHistory.of(false),
      ],
      effects: this.historyConfiguration.reconfigure([]),
    }

    if (active) {
      const anchor = this.captureScrollAnchor()
      const scrollLeft = this.view.scrollDOM.scrollLeft
      const scrollTop = this.view.scrollDOM.scrollTop
      this.view.dispatch(replacement)
      this.view.dispatch({
        effects: this.historyConfiguration.reconfigure(history()),
      })
      session.state = this.view.state
      session.scrollSnapshot = this.view.scrollSnapshot()
      session.viewport = {
        pos: Math.min(anchor.pos, nextLength),
        screenOffset: anchor.screenOffset,
        scrollLeft,
        scrollTop,
      }
      this.view.scrollDOM.scrollTop = scrollTop
      this.view.scrollDOM.scrollLeft = scrollLeft
      this.startScrollAnchorRestore({
        ...session.viewport,
        assoc: anchor.assoc,
      })
      return true
    }

    let nextState = session.state.update(replacement).state
    nextState = nextState.update({
      effects: this.historyConfiguration.reconfigure(history()),
    }).state
    session.state = nextState
    session.scrollSnapshot = undefined
    session.viewport = {
      ...session.viewport,
      pos: Math.min(session.viewport.pos, nextLength),
    }
    return true
  }

  serializeSession(
    session: MarkdownEditorSession,
    baselineContent = session.state.doc.toString()
  ): SerializedEditorSession {
    return {
      version: SERIALIZED_EDITOR_SESSION_VERSION,
      state: session.state.toJSON({ history: historyField }),
      baselineContent,
      documentKind: session.documentKind,
      mode: this.modeForDocumentKind(session.mode, session.documentKind),
      lineWrapping: session.lineWrapping,
      caretVisible: session.caretVisible,
      viewport: { ...session.viewport },
      viewportInitialized: session.viewportInitialized,
      revision: session.revision,
    }
  }

  deserializeSession(
    session: SerializedEditorSession,
    documentPath: string | null = null,
    documentKind: DocumentKind = session.documentKind
  ): MarkdownEditorSession {
    const serializedMode = session.mode === "source" ? "source" : "live"
    const mode = this.modeForDocumentKind(serializedMode, documentKind)
    const lineWrapping = session.lineWrapping !== false
    const caretVisible = session.caretVisible === true
    const state = EditorState.fromJSON(
      session.state,
      {
        extensions: this.editorExtensions(
          mode,
          lineWrapping,
          caretVisible,
          documentPath,
          documentKind
        ),
      },
      { history: historyField }
    )
    const position = Math.max(
      0,
      Math.min(session.viewport.pos, state.doc.length)
    )
    return {
      state,
      documentKind,
      documentPath,
      mode,
      lineWrapping,
      caretVisible,
      viewport: {
        pos: position,
        screenOffset: Number.isFinite(session.viewport.screenOffset)
          ? session.viewport.screenOffset
          : 0,
        scrollLeft: Number.isFinite(session.viewport.scrollLeft)
          ? session.viewport.scrollLeft
          : 0,
        scrollTop: Number.isFinite(session.viewport.scrollTop)
          ? session.viewport.scrollTop
          : 0,
      },
      viewportInitialized: session.viewportInitialized,
      revision: Number.isInteger(session.revision) ? session.revision : 0,
    }
  }

  getStatus(): EditorStatus {
    return editorStatus(this.view.state)
  }

  setDocument(content: string, options: SetDocumentOptions = {}) {
    const normalized = normalizeEditorContent(content)
    const resetHistory = options.addToHistory === false
    if (normalized === this.getContent() && !resetHistory) return
    this.resetSemanticPointerInteraction()

    const annotations = []
    if (options.notify === false)
      annotations.push(suppressChangeNotification.of(true))
    if (resetHistory) annotations.push(Transaction.addToHistory.of(false))

    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: normalized },
      selection: { anchor: 0 },
      annotations,
      effects: resetHistory
        ? this.historyConfiguration.reconfigure([])
        : undefined,
    })
    if (resetHistory) {
      this.view.dispatch({
        effects: this.historyConfiguration.reconfigure(history()),
      })
    }
  }

  getMode() {
    return this.mode
  }

  getDocumentKind() {
    return this.documentKind
  }

  setMode(mode: MarkdownEditorMode) {
    if (this.destroyed) return
    const resolvedMode = this.modeForDocumentKind(mode)
    if (resolvedMode === this.mode) {
      this.pendingMode = null
      return
    }
    if (this.view.compositionStarted) {
      this.pendingMode = resolvedMode
      return
    }
    this.applyMode(resolvedMode)
  }

  toggleMode() {
    if (this.documentKind !== "markdown") return "source"
    const nextMode = this.mode === "live" ? "source" : "live"
    this.setMode(nextMode)
    return this.mode
  }

  getLineWrapping() {
    return this.lineWrapping
  }

  setLineWrapping(enabled: boolean) {
    if (enabled === this.lineWrapping || this.destroyed) return
    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    this.lineWrapping = enabled
    this.view.dispatch({
      effects: [
        this.wrapping.reconfigure(enabled ? EditorView.lineWrapping : []),
        this.layout.reconfigure(
          contentLayoutTheme(enabled, this.maxContentWidth)
        ),
        scrollSnapshot,
      ],
    })
    this.refreshContentGeometry()
    this.startScrollAnchorRestore(anchor)
    this.onLineWrappingChange?.(enabled)
  }

  toggleLineWrapping() {
    const enabled = !this.lineWrapping
    this.setLineWrapping(enabled)
    return enabled
  }

  setMaxContentWidth(width: number | undefined) {
    const nextWidth = this.validateMaxContentWidth(width)
    if (nextWidth === this.maxContentWidth || this.destroyed) return
    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    this.maxContentWidth = nextWidth
    this.view.dispatch({
      effects: [
        this.layout.reconfigure(
          contentLayoutTheme(this.lineWrapping, nextWidth)
        ),
        scrollSnapshot,
      ],
    })
    this.refreshContentGeometry()
    this.startScrollAnchorRestore(anchor)
  }

  setMarkdownExtensions(extensions: MarkdownExtensionSettings) {
    if (this.destroyed) return
    const next = normalizedMarkdownExtensions(extensions)
    if (markdownExtensionsEqual(next, this.markdownExtensions)) return

    const parserChanged = !markdownParserExtensionsEqual(
      next,
      this.markdownExtensions
    )
    const presentationChanged = !markdownPresentationExtensionsEqual(
      next,
      this.markdownExtensions
    )
    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    this.markdownExtensions = next
    if (parserChanged) {
      this.currentMarkdownLanguageExtension =
        this.memoizedMarkdownLanguageExtension()
    }
    if (parserChanged || presentationChanged) {
      // The live presentation owns syntax-dependent, full-document state such
      // as the link-reference index. Recreate it when the parser changes even
      // if none of the presentation-only settings did.
      this.currentPresentationExtensions = {
        live: this.memoizedPresentationExtension("live"),
        source: this.memoizedPresentationExtension("source"),
      }
    }
    const effects = [
      ...this.documentConfigurationEffects(
        this.view.state,
        this.mode,
        this.documentKind,
        this.documentPath
      ),
      scrollSnapshot,
    ]
    this.view.dispatch({ effects })
    this.refreshContentGeometry()
    this.startScrollAnchorRestore(anchor)
  }

  setOptionalLivePreviewSupport(support: OptionalLivePreviewSupport) {
    if (this.destroyed || support === this.optionalLivePreviewSupport) return
    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    this.optionalLivePreviewSupport = support
    this.livePresentationExtensionCache.clear()
    this.currentPresentationExtensions = {
      live: this.memoizedPresentationExtension("live"),
      source: this.memoizedPresentationExtension("source"),
    }
    this.view.dispatch({
      effects: [
        ...this.documentConfigurationEffects(
          this.view.state,
          this.mode,
          this.documentKind,
          this.documentPath
        ),
        scrollSnapshot,
      ],
    })
    this.refreshContentGeometry(true)
    this.startScrollAnchorRestore(anchor)
  }

  setPathCompletionExtension(extension: Extension) {
    if (this.destroyed || extension === this.currentPathCompletionExtension) {
      return
    }
    this.currentPathCompletionExtension = extension
    this.view.dispatch({
      effects: this.pathCompletionConfiguration.reconfigure(extension),
    })
  }

  setDocumentIdentity(filePath: string | null, documentKind: DocumentKind) {
    const nextPath = filePath || null
    const nextMode = this.modeForDocumentKind(this.mode, documentKind)
    if (
      this.destroyed ||
      (documentKind === this.documentKind &&
        nextPath === this.documentPath &&
        this.view.state.facet(markdownDocumentPath) === nextPath)
    ) {
      return
    }

    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    const modeChanged = nextMode !== this.mode
    this.topLevelLanguageRequest += 1
    this.pendingMode = null
    if (this.modeFrame !== null) {
      this.ownerWindow?.cancelAnimationFrame(this.modeFrame)
      this.modeFrame = null
    }
    this.clearLinkTooltip()
    this.documentKind = documentKind
    this.documentPath = nextPath
    this.mode = nextMode
    this.view.dispatch({
      effects: [
        ...this.documentConfigurationEffects(
          this.view.state,
          nextMode,
          documentKind,
          nextPath
        ),
        this.documentPathConfiguration.reconfigure(
          markdownDocumentPath.of(nextPath)
        ),
        ...(modeChanged
          ? [
              this.indentation.reconfigure(
                indentUnit.of(this.indentUnitFor(nextMode))
              ),
            ]
          : []),
        scrollSnapshot,
        refreshLivePreview.of(null),
      ],
    })
    requestContentGeometryRefresh(this.view)
    this.startScrollAnchorRestore(anchor)
    if (modeChanged) this.onModeChange?.(nextMode)
    this.refreshActiveTopLevelLanguage()
  }

  setDocumentPath(filePath: string | null) {
    this.setDocumentIdentity(filePath, this.documentKind)
  }

  setRemoteImagesEnabled(enabled: boolean) {
    if (this.destroyed || enabled === this.remoteImagesEnabled) return
    this.remoteImagesEnabled = enabled
    this.view.dispatch({
      effects: [
        this.remoteImagesConfiguration.reconfigure(
          markdownRemoteImagesEnabled.of(enabled)
        ),
        refreshLivePreview.of(null),
      ],
    })
  }

  setSourceIndentation(indentation: SourceIndentation, size: number) {
    const nextIndentation = this.validateSourceIndentation(indentation)
    const nextSize = this.validateSourceIndentSize(size)
    if (
      this.destroyed ||
      (nextIndentation === this.sourceIndentation &&
        nextSize === this.sourceIndentSize)
    ) {
      return
    }

    this.sourceIndentation = nextIndentation
    this.sourceIndentSize = nextSize
    if (this.mode === "source") {
      this.view.dispatch({
        effects: this.indentation.reconfigure(
          indentUnit.of(this.indentUnitFor("source"))
        ),
      })
    }
  }

  setAppearanceProfile(profile: AppearanceProfile) {
    if (
      this.destroyed ||
      (profile.syntaxThemeId === this.appearanceProfile.syntaxThemeId &&
        profile.backgroundId === this.appearanceProfile.backgroundId &&
        profile.customBackgroundColor ===
          this.appearanceProfile.customBackgroundColor)
    ) {
      return
    }

    this.appearanceProfile = { ...profile }
    const resolvedProfile = resolveAppearanceProfile(profile)
    this.view.dispatch({
      effects: [
        this.syntaxTheme.reconfigure(
          syntaxThemeExtension(
            this.appearanceProfile.syntaxThemeId,
            resolvedProfile.backgroundColor
          )
        ),
        this.surfaceTheme.reconfigure(
          EditorView.darkTheme.of(resolvedProfile.surfaceScheme === "dark")
        ),
      ],
    })
  }

  setWindowActive(active: boolean) {
    if (this.destroyed || active === this.windowActive) return
    this.windowActive = active
    this.view.dispatch({ effects: setSelectionWindowActive.of(active) })
  }

  setReadOnly(readOnly: boolean) {
    if (this.destroyed || readOnly === this.readOnly) return
    this.resetSemanticPointerInteraction()
    this.readOnly = readOnly
    if (readOnly) {
      this.hideCaret()
      if (this.view.hasFocus) this.view.contentDOM.blur()
    }
    this.view.dispatch({
      effects: [
        this.editability.reconfigure(this.editabilityExtension(readOnly)),
        refreshLivePreview.of(null),
      ],
    })
  }

  setSpellCheck(enabled: boolean) {
    if (this.destroyed || enabled === this.spellCheckEnabled) return
    this.spellCheckEnabled = enabled
    this.currentSpellCheckExtension = enabled
      ? spellCheckExtension(this.checkSpelling)
      : []
    this.view.dispatch({
      effects: this.spellCheckConfiguration.reconfigure(
        this.currentSpellCheckExtension
      ),
    })
  }

  refreshSpellCheck(word?: string) {
    if (this.destroyed || !this.spellCheckEnabled) return
    this.view.dispatch({
      effects: refreshSpellCheckEffect.of(word ?? null),
    })
  }

  setSearchQuery(query: string, options: MarkdownSearchOptions = {}) {
    const support = this.searchSupport
    if (!support) return false
    const state = this.view.state
    const searchQuery = support.createQuery({
      search: query,
      caseSensitive: options.caseSensitive,
      regexp: options.regexp,
      replace: options.replace,
      wholeWord: options.wholeWord,
    })
    const activeMatch = support.currentMatch(state)
    const issue = support.queryIssue(state, searchQuery)
    const retainedMatch =
      activeMatch &&
      searchQuery.valid &&
      !issue &&
      support.rangeIsMatch(state, searchQuery, activeMatch, [])
        ? activeMatch
        : null
    this.view.dispatch({
      effects: [
        ...support.queryEffects(searchQuery, issue),
        ...support.currentMatchEffects(retainedMatch),
      ],
    })
    return searchQuery.valid && !issue
  }

  getSearchStatus() {
    return this.searchStatus(this.view.state)
  }

  findNext() {
    const support = this.searchSupport
    if (!support) return false
    const query = support.query(this.view.state)
    if (!query?.valid || support.queryIssue(this.view.state, query)) {
      return false
    }
    return this.navigateSearch(1)
  }

  findPrevious() {
    const support = this.searchSupport
    if (!support) return false
    const query = support.query(this.view.state)
    if (!query?.valid || support.queryIssue(this.view.state, query)) {
      return false
    }
    return this.navigateSearch(-1)
  }

  replaceNext(options: MarkdownReplaceOptions = {}) {
    const support = this.searchSupport
    const query = support?.query(this.view.state)
    if (
      !support ||
      !query?.valid ||
      support.queryIssue(this.view.state, query)
    ) {
      return false
    }
    return this.replaceNextMatch(query, options.preserveCase === true)
  }

  replaceAll(options: MarkdownReplaceOptions = {}) {
    const support = this.searchSupport
    const query = support?.query(this.view.state)
    if (
      !support ||
      !query?.valid ||
      support.queryIssue(this.view.state, query)
    ) {
      return false
    }
    return options.preserveCase
      ? this.replaceAllPreservingCase(query)
      : support.replaceAll(this.view)
  }

  clearSearch() {
    const support = this.searchSupport
    if (!support) return
    this.view.dispatch({
      effects: [
        ...support.queryEffects(support.createQuery({ search: "" }), null),
        ...support.currentMatchEffects(null),
      ],
    })
  }

  getHeadings() {
    if (this.documentKind !== "markdown") return []
    return markdownHeadings(this.view.state)
  }

  getCurrentHeading() {
    if (this.documentKind !== "markdown") return null
    const headings = this.getHeadings()
    const selectionPosition = this.view.state.selection.main.head
    const position = headings.some(
      (heading) => heading.from === selectionPosition
    )
      ? selectionPosition
      : this.navigationPosition()
    let current: MarkdownHeading | null = null
    for (const heading of headings) {
      if (heading.from > position) break
      current = heading
    }
    return current
  }

  captureNavigationLocation(): MarkdownNavigationLocation {
    const selection = this.view.state.selection.main
    const viewport = this.captureScrollAnchor()
    return {
      caretVisible: this.caretVisible,
      selection: {
        anchor: selection.anchor,
        head: selection.head,
      },
      viewport: {
        pos: viewport.pos,
        screenOffset: viewport.screenOffset,
        scrollLeft: viewport.scrollLeft,
      },
    }
  }

  restoreNavigationLocation(location: MarkdownNavigationLocation) {
    if (this.destroyed) return false
    this.cancelScrollAnchorRestore()
    this.cancelPendingCaretActivation()

    const clamp = (position: number) =>
      Math.max(0, Math.min(position, this.view.state.doc.length))
    const selection = EditorSelection.single(
      clamp(location.selection.anchor),
      clamp(location.selection.head)
    )
    const caretVisible = location.caretVisible && !this.readOnly
    const effects = []
    if (caretVisible !== this.caretVisible) {
      this.caretVisible = caretVisible
      effects.push(
        this.caretVisibility.reconfigure(this.caretExtension(caretVisible)),
        refreshLivePreview.of(null)
      )
    }
    const viewportPos = clamp(location.viewport.pos)
    effects.push(EditorView.scrollIntoView(viewportPos, { y: "start" }))
    this.view.dispatch({
      selection,
      effects,
      userEvent: "select.navigation-history",
    })

    this.startScrollAnchorRestore({
      pos: viewportPos,
      screenOffset: location.viewport.screenOffset,
      scrollLeft: location.viewport.scrollLeft,
    })
    if (caretVisible) this.view.focus()
    else if (this.view.hasFocus) this.view.contentDOM.blur()
    return true
  }

  jumpToHeading(
    heading: MarkdownHeading | string,
    options: MarkdownNavigationOptions = {}
  ) {
    if (this.documentKind !== "markdown") return false
    const target =
      typeof heading === "string"
        ? this.getHeadings().find((candidate) => candidate.slug === heading)
        : heading
    if (!target || this.destroyed || target.from > this.view.state.doc.length) {
      return false
    }
    if (options.recordHistory !== false) {
      this.onNavigate?.(this.captureNavigationLocation())
    }
    this.view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, {
        y: "start",
        yMargin: this.navigationTopMargin(),
      }),
      userEvent: "select.heading",
    })
    return true
  }

  jumpToFragment(destination: string, options: MarkdownNavigationOptions = {}) {
    if (this.documentKind !== "markdown") return false
    if (destination === "#") {
      if (options.recordHistory !== false) {
        this.onNavigate?.(this.captureNavigationLocation())
      }
      this.view.dispatch({
        selection: { anchor: 0 },
        effects: EditorView.scrollIntoView(0, { y: "start" }),
        userEvent: "select.heading",
      })
      return true
    }
    const heading = headingForFragment(this.getHeadings(), destination)
    return heading ? this.jumpToHeading(heading, options) : false
  }

  navigateHeading(
    direction: -1 | 1,
    level?: MarkdownOutlineHeadingLevel,
    options: MarkdownNavigationOptions = {}
  ) {
    if (this.documentKind !== "markdown") return false
    const candidates = level
      ? this.getHeadings().filter((heading) => heading.level === level)
      : this.getHeadings()
    if (candidates.length === 0) return false

    const selectionPosition = this.view.state.selection.main.head
    const position = candidates.some(
      (heading) => heading.from === selectionPosition
    )
      ? selectionPosition
      : this.navigationPosition()
    const index =
      direction === 1
        ? candidates.findIndex((heading) => heading.from > position)
        : candidates.findLastIndex((heading) => heading.from < position)
    const target =
      index >= 0
        ? candidates[index]
        : direction === 1
          ? candidates[0]
          : candidates[candidates.length - 1]
    return this.jumpToHeading(target, options)
  }

  setCursorPosition(line: number, column: number) {
    if (this.destroyed) return false
    const position = this.clampedCursorPosition(this.view.state, line, column)
    this.cancelScrollAnchorRestore()
    this.view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
      userEvent: "select.goto",
    })
    return true
  }

  setSessionCursorPosition(
    session: MarkdownEditorSession,
    line: number,
    column: number
  ) {
    if (this.destroyed) return false
    if (session.state === this.view.state) {
      const positioned = this.setCursorPosition(line, column)
      if (positioned) session.state = this.view.state
      return positioned
    }

    const position = this.clampedCursorPosition(session.state, line, column)
    session.state = session.state.update({
      selection: { anchor: position },
      userEvent: "select.goto",
    }).state
    session.viewport = {
      ...session.viewport,
      pos: position,
      screenOffset:
        this.view.scrollDOM.clientHeight > 0
          ? this.view.scrollDOM.clientHeight / 2
          : this.navigationTopMargin(),
      scrollTop: 0,
    }
    session.scrollSnapshot = EditorView.scrollIntoView(position, {
      y: "center",
    })
    session.viewportInitialized = true
    return true
  }

  applyFormatting(command: MarkdownFormattingCommand) {
    if (this.documentKind !== "markdown") return false
    return applyMarkdownFormatting(this.view, command)
  }

  undo() {
    return undo(this.view)
  }

  redo() {
    return redo(this.view)
  }

  selectAll() {
    return selectAll(this.view)
  }

  focus() {
    this.showCaret()
    this.view.focus()
  }

  focusSurface() {
    if (this.destroyed) return
    this.view.focus()
  }

  restoreFocus() {
    if (this.destroyed || !this.caretVisible) return
    this.view.focus()
  }

  setContextMenuFocusRetained(retained: boolean) {
    if (this.destroyed || this.documentKind !== "markdown") return
    this.view.dispatch({
      effects: [
        setLivePreviewEditorFocused.of(this.view.hasFocus),
        setLivePreviewFocusRetained.of(retained),
        refreshLivePreview.of(null),
      ],
    })
  }

  requestMeasure() {
    this.view.requestMeasure()
  }

  refreshContentGeometry(refreshRenders = false) {
    this.optionalLivePreviewSupport?.refreshContentGeometry(
      this.view,
      refreshRenders
    )
    requestContentGeometryRefresh(this.view)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.topLevelLanguageRequest += 1
    this.cancelSearchScan()
    this.pendingMode = null
    this.pendingScrollAnchor = null
    this.cancelSemanticScrollRestore()
    this.resetSemanticPointerInteraction()
    this.view.dom.removeEventListener("mousedown", this.handleMouseDown, true)
    this.view.dom.removeEventListener("pointermove", this.handlePointerMove)
    this.view.dom.removeEventListener("pointerleave", this.handlePointerLeave)
    this.view.dom.classList.remove(textLanePointerClass)
    this.view.scrollDOM.removeEventListener("wheel", this.handleEditorWheel)
    this.view.scrollDOM.removeEventListener("scroll", this.clearLinkTooltip)
    this.ownerWindow?.removeEventListener(
      "keydown",
      this.handleOpenLinkModifierChange
    )
    this.ownerWindow?.removeEventListener(
      "keyup",
      this.handleOpenLinkModifierChange
    )
    this.ownerWindow?.removeEventListener(
      "keydown",
      this.handleCaretVisibilityKeyDown
    )
    this.ownerWindow?.removeEventListener("blur", this.handleWindowBlur)
    this.ownerWindow?.removeEventListener("resize", this.clearLinkTooltip)
    this.view.contentDOM.removeEventListener(
      "compositionstart",
      this.handleCompositionStart
    )
    this.view.contentDOM.removeEventListener(
      "compositionend",
      this.handleCompositionEnd
    )
    this.view.dom.ownerDocument.fonts.removeEventListener(
      "loadingdone",
      this.handleFontLoadingDone
    )
    this.view.dom.ownerDocument.removeEventListener(
      "copy",
      this.handleOwnedPointerClipboard,
      true
    )
    this.view.dom.ownerDocument.removeEventListener(
      "cut",
      this.handleOwnedPointerClipboard,
      true
    )
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    if (this.modeFrame != null)
      ownerWindow?.cancelAnimationFrame(this.modeFrame)
    this.cancelPendingCaretActivation()
    if (this.anchorFrame != null)
      ownerWindow?.cancelAnimationFrame(this.anchorFrame)
    if (this.pointerMoveFrame != null)
      ownerWindow?.cancelAnimationFrame(this.pointerMoveFrame)
    this.pointerMoveFrame = null
    this.pendingPointerMove = null
    this.clearLinkTooltip()
    this.view.destroy()
  }

  private searchMatches(state: EditorState, query: SearchQuery) {
    const cached = this.searchMatchCache
    if (
      cached &&
      cached.doc === state.doc &&
      matchingQueryEqual(cached.query, query)
    ) {
      return cached
    }

    this.cancelSearchScan()
    const matches: SearchMatchCache = {
      checkpointBuffer: [],
      checkpoints: new Float64Array(),
      complete: false,
      cursor: null,
      doc: state.doc,
      includeFrom: 0,
      includeTo: 0,
      nextLine: 1,
      nextOffset: 0,
      query,
      rangesExhausted: false,
      scanKind: !query.regexp
        ? "literal"
        : regexpMayCrossLines(query.search)
          ? "multiline-regexp"
          : "single-line-regexp",
      state,
      total: 0,
    }
    this.searchMatchCache = matches
    this.scheduleSearchScan(matches)
    return matches
  }

  private cancelSearchScan() {
    if (this.searchScanTimer == null) return
    clearTimeout(this.searchScanTimer)
    this.searchScanTimer = null
  }

  private scheduleSearchScan(matches: SearchMatchCache) {
    if (
      this.destroyed ||
      this.searchScanTimer != null ||
      matches.complete ||
      matches !== this.searchMatchCache
    ) {
      return
    }
    this.searchScanTimer = setTimeout(() => {
      this.searchScanTimer = null
      if (this.destroyed || matches !== this.searchMatchCache) return
      this.continueSearchScan(matches)
    }, 0)
  }

  private openNextSearchRange(matches: SearchMatchCache) {
    if (matches.rangesExhausted) return false

    const { doc, query, state } = matches
    if (matches.scanKind === "multiline-regexp") {
      matches.cursor = query.getCursor(state, 0, doc.length)
      matches.includeFrom = 0
      matches.includeTo = doc.length + 1
      matches.rangesExhausted = true
      return true
    }

    if (matches.scanKind === "single-line-regexp") {
      if (matches.nextLine > doc.lines) {
        matches.rangesExhausted = true
        return false
      }

      const firstLine = doc.line(matches.nextLine)
      let lastLine = firstLine
      while (lastLine.number < doc.lines) {
        const candidate = doc.line(lastLine.number + 1)
        if (
          candidate.to - firstLine.from > searchScanCharacterBudget &&
          lastLine.number > firstLine.number
        ) {
          break
        }
        lastLine = candidate
        if (lastLine.to - firstLine.from >= searchScanCharacterBudget) break
      }
      matches.nextLine = lastLine.number + 1
      matches.rangesExhausted = matches.nextLine > doc.lines
      matches.cursor = query.getCursor(state, firstLine.from, lastLine.to)
      matches.includeFrom = firstLine.from
      matches.includeTo = lastLine.to + 1
      return true
    }

    if (matches.nextOffset >= doc.length) {
      matches.rangesExhausted = true
      return false
    }

    const includeFrom = matches.nextOffset
    const includeTo = Math.min(
      doc.length,
      includeFrom + searchScanCharacterBudget
    )
    const overlap = literalSearchOverlap(query)
    matches.nextOffset = includeTo
    matches.rangesExhausted = includeTo === doc.length
    matches.cursor = query.getCursor(
      state,
      includeFrom,
      Math.min(doc.length, includeTo + overlap)
    )
    matches.includeFrom = includeFrom
    matches.includeTo = includeTo
    return true
  }

  private continueSearchScan(matches: SearchMatchCache) {
    const started = performance.now()
    let processedMatches = 0

    while (
      processedMatches < searchScanMatchBudget &&
      performance.now() - started < searchScanTimeBudget
    ) {
      if (!matches.cursor && !this.openNextSearchRange(matches)) {
        this.finishSearchScan(matches)
        return
      }

      const next = matches.cursor!.next()
      if (next.done) {
        matches.cursor = null
        continue
      }
      if (
        next.value.from < matches.includeFrom ||
        next.value.from >= matches.includeTo
      ) {
        continue
      }

      if (
        matches.scanKind === "literal" &&
        next.value.to > matches.nextOffset
      ) {
        // The right overlap lets this range finish a match that starts before
        // its boundary. Resume after that accepted match so the next cursor
        // preserves the full cursor's non-overlapping match phase.
        matches.nextOffset = next.value.to
      }

      if (matches.total % searchCheckpointStride === 0) {
        matches.checkpointBuffer!.push(next.value.from, next.value.to)
      }
      matches.total += 1
      processedMatches += 1
    }

    this.scheduleSearchScan(matches)
  }

  private finishSearchScan(matches: SearchMatchCache) {
    matches.checkpoints = Float64Array.from(matches.checkpointBuffer ?? [])
    matches.checkpointBuffer = null
    matches.complete = true
    matches.cursor = null

    if (
      this.destroyed ||
      matches !== this.searchMatchCache ||
      this.view.state.doc !== matches.doc
    ) {
      return
    }
    this.reportSearchStatus(this.view.state)
  }

  private navigateSearch(direction: -1 | 1) {
    const support = this.searchSupport
    if (!support) return false
    const state = this.view.state
    const query = support.query(state)
    const active = support.currentMatch(state)
    const match =
      direction === 1
        ? support.nextMatch(
            state,
            query,
            active?.to ?? state.selection.main.to,
            active
          )
        : support.previousMatch(
            state,
            query,
            active?.from ?? state.selection.main.from,
            active,
            this.searchMatchCache?.checkpointBuffer ??
              this.searchMatchCache?.checkpoints ??
              [],
            literalSearchOverlap(query)
          )
    if (!match) return false

    const next = { from: match.from, to: match.to }
    this.view.dispatch({
      effects: [
        ...support.currentMatchEffects(next),
        support.announce(state, next),
        support.scroll(next),
      ],
      userEvent: "select.search",
    })
    return true
  }

  private positionAfter(position: number, state: EditorState) {
    if (position >= state.doc.length) return state.doc.length
    const characters = state.sliceDoc(position, position + 2)
    const first = characters.charCodeAt(0)
    const second = characters.charCodeAt(1)
    return (
      position +
      (first >= 0xd800 &&
      first <= 0xdbff &&
      second >= 0xdc00 &&
      second <= 0xdfff
        ? 2
        : 1)
    )
  }

  private currentSearchMatch(
    state: EditorState,
    query: SearchQuery,
    matches: SearchMatchCache
  ) {
    if (matches.total === 0) return null

    const activeMatch = this.searchSupport?.currentMatch(state)
    if (!activeMatch) return null
    const { from: selectionFrom, to: selectionTo } = activeMatch
    const checkpointCount = matches.checkpoints.length / 2
    let low = 0
    let high = checkpointCount - 1
    let previousCheckpoint = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const from = matches.checkpoints[middle * 2]!
      const to = matches.checkpoints[middle * 2 + 1]!
      if (from === selectionFrom && to === selectionTo) {
        return middle * searchCheckpointStride + 1
      }
      if (
        from < selectionFrom ||
        (from === selectionFrom && to < selectionTo)
      ) {
        previousCheckpoint = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    if (previousCheckpoint < 0) return null

    const checkpointOffset = previousCheckpoint * 2
    const checkpointFrom = matches.checkpoints[checkpointOffset]!
    const checkpointTo = matches.checkpoints[checkpointOffset + 1]!
    let ordinal = previousCheckpoint * searchCheckpointStride + 1
    const lastOrdinal = Math.min(
      matches.total,
      (previousCheckpoint + 1) * searchCheckpointStride
    )
    if (ordinal >= lastOrdinal) return null

    const searchFrom =
      checkpointFrom === checkpointTo
        ? this.positionAfter(checkpointTo, state)
        : checkpointTo
    const cursor =
      matches.scanKind === "multiline-regexp"
        ? contextPreservingRegexpCursor(
            state,
            query,
            searchFrom,
            state.doc.length
          )
        : query.getCursor(state, searchFrom, state.doc.length)
    while (ordinal < lastOrdinal) {
      const next = cursor.next()
      if (next.done) return null
      ordinal += 1
      const { from, to } = next.value
      if (from === selectionFrom && to === selectionTo) return ordinal
      if (
        from > selectionFrom ||
        (from === selectionFrom && to > selectionTo)
      ) {
        return null
      }
    }
    return null
  }

  private searchStatus(state: EditorState): MarkdownSearchStatus {
    const support = this.searchSupport
    const query = support?.query(state)
    if (!support || !query) {
      this.cancelSearchScan()
      this.searchMatchCache = null
      return { valid: false, pending: false, current: null, total: 0 }
    }
    if (!query.valid) {
      this.cancelSearchScan()
      this.searchMatchCache = null
      return { valid: false, pending: false, current: null, total: 0 }
    }
    const issue = support.queryIssue(state, query)
    if (issue) {
      this.cancelSearchScan()
      this.searchMatchCache = null
      return {
        valid: false,
        pending: false,
        current: null,
        total: 0,
        issue,
      }
    }

    const matches = this.searchMatches(state, query)
    if (!matches.complete) {
      return { valid: true, pending: true, current: null, total: 0 }
    }
    return {
      valid: true,
      pending: false,
      current: this.currentSearchMatch(state, query, matches),
      total: matches.total,
    }
  }

  private reportSearchStatus(state: EditorState) {
    const status = this.searchStatus(state)
    if (searchStatusEqual(this.lastSearchStatus, status)) return
    this.lastSearchStatus = status
    this.onSearchStatusChange?.(status)
  }

  private replacementMatches(state: EditorState, query: SearchQuery) {
    const matches: ReplacementMatch[] = []
    const cursor = this.replacementCursor(state, query, 0, state.doc.length)
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      matches.push({
        from: next.value.from,
        to: next.value.to,
        precise: next.value.precise !== false,
        regexpMatch: query.regexp ? next.value.match : undefined,
      })
    }
    return matches
  }

  private replacementCursor(
    state: EditorState,
    query: SearchQuery,
    from: number,
    to: number
  ) {
    return searchCursorForRange(state, query, from, to)
  }

  private nextPreciseReplacementMatch(
    cursor: Iterator<SearchCursorMatch>,
    excluded: SearchMatchRange | null = null
  ) {
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (next.value.precise === false) continue
      if (excluded?.from === next.value.from && excluded.to === next.value.to) {
        continue
      }
      return {
        from: next.value.from,
        to: next.value.to,
        precise: true,
        regexpMatch: next.value.match,
      } satisfies ReplacementMatch
    }
    return null
  }

  private replacementMatchAt(
    state: EditorState,
    query: SearchQuery,
    range: SearchMatchRange
  ) {
    if (query.regexp) {
      const match = this.searchSupport?.canonicalRegexpMatchAt(
        state,
        query,
        range,
        this.searchMatchCache?.checkpointBuffer ??
          this.searchMatchCache?.checkpoints ??
          []
      )
      return match && match.precise !== false
        ? {
            from: match.from,
            to: match.to,
            precise: true,
            regexpMatch: match.match,
          }
        : null
    }
    const cursor = this.replacementCursor(
      state,
      query,
      range.from === 0 ? 0 : range.from - 1,
      state.doc.length
    )
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      const { from, to } = next.value
      if (
        from === range.from &&
        to === range.to &&
        next.value.precise !== false
      ) {
        return {
          from,
          to,
          precise: true,
          regexpMatch: next.value.match,
        } satisfies ReplacementMatch
      }
      if (from > range.from || (from === range.from && to > range.to)) break
    }
    return null
  }

  private nextReplacementMatch(
    state: EditorState,
    query: SearchQuery,
    from: number,
    excluded: SearchMatchRange | null
  ) {
    const next = this.nextPreciseReplacementMatch(
      this.replacementCursor(state, query, from, state.doc.length),
      excluded
    )
    if (next || from === 0) return next
    return this.nextPreciseReplacementMatch(
      this.replacementCursor(state, query, 0, state.doc.length),
      excluded
    )
  }

  private preservedReplacement(
    state: EditorState,
    query: SearchQuery,
    match: ReplacementMatch
  ) {
    const source = state.sliceDoc(match.from, match.to)
    const replacement =
      query.regexp && match.regexpMatch
        ? expandRegexpReplacement(query.replace, match.regexpMatch)
        : unquoteReplacement(query.replace)
    return preserveReplacementCase(source, replacement)
  }

  private replaceNextMatch(query: SearchQuery, preserveCase: boolean) {
    const support = this.searchSupport
    if (!support) return false
    const state = this.view.state
    if (state.readOnly) return false
    const active = support.currentMatch(state)
    const current = active
      ? this.replacementMatchAt(state, query, active)
      : null

    if (!current) {
      const next = this.nextReplacementMatch(
        state,
        query,
        active?.to ?? state.selection.main.from,
        active
      )
      if (!next) return false
      const nextMatch = { from: next.from, to: next.to }
      this.view.dispatch({
        effects: [
          ...support.currentMatchEffects(nextMatch),
          support.announce(state, nextMatch),
          support.scroll(nextMatch),
        ],
        userEvent: "select.search",
      })
      return true
    }

    const replacement = preserveCase
      ? this.preservedReplacement(state, query, current)
      : query.regexp && current.regexpMatch
        ? expandRegexpReplacement(query.replace, current.regexpMatch)
        : unquoteReplacement(query.replace)
    const changes = state.changes({
      from: current.from,
      to: current.to,
      insert: replacement,
    })
    const next = this.nextReplacementMatch(state, query, current.to, current)
    const nextMatch = next
      ? EditorSelection.single(next.from, next.to).map(changes).main
      : undefined
    const nextEffects =
      next && nextMatch
        ? [support.announce(state, next), support.scroll(nextMatch)]
        : []
    this.view.dispatch({
      changes,
      effects: [
        ...support.currentMatchEffects(
          nextMatch ? { from: nextMatch.from, to: nextMatch.to } : null
        ),
        EditorView.announce.of(
          `${state.phrase("replaced match on line $", state.doc.lineAt(current.from).number)}.`
        ),
        ...nextEffects,
      ],
      userEvent: "input.replace",
    })
    return true
  }

  private replaceAllPreservingCase(query: SearchQuery) {
    const state = this.view.state
    if (state.readOnly) return false
    const matches = this.replacementMatches(state, query).filter(
      (match) => match.precise
    )
    if (matches.length === 0) return false

    this.view.dispatch({
      changes: matches.map((match) => ({
        from: match.from,
        to: match.to,
        insert: this.preservedReplacement(state, query, match),
      })),
      effects: EditorView.announce.of(`Replaced ${matches.length} matches.`),
      userEvent: "input.replace.all",
    })
    return true
  }

  private createEditorState(
    content: string,
    mode: MarkdownEditorMode,
    lineWrapping: boolean,
    caretVisible: boolean,
    documentPath: string | null = this.documentPath,
    documentKind: DocumentKind = this.documentKind
  ) {
    const resolvedMode = this.modeForDocumentKind(mode, documentKind)
    return EditorState.create({
      doc: content,
      extensions: this.editorExtensions(
        resolvedMode,
        lineWrapping,
        caretVisible,
        documentPath,
        documentKind
      ),
    })
  }

  private editorExtensions(
    mode: MarkdownEditorMode,
    lineWrapping: boolean,
    caretVisible: boolean,
    documentPath: string | null = this.documentPath,
    documentKind: DocumentKind = this.documentKind
  ): Extension[] {
    const resolvedMode = this.modeForDocumentKind(mode, documentKind)
    const resolvedProfile = resolveAppearanceProfile(this.appearanceProfile)
    const markdownFormattingBindings = markdownFormattingKeymap.map(
      (binding) => {
        const run = binding.run
        const shift = binding.shift
        return {
          ...binding,
          run: (view: EditorView) =>
            this.documentKind === "markdown" && (run?.(view) ?? false),
          ...(shift
            ? {
                shift: (view: EditorView) =>
                  this.documentKind === "markdown" && shift(view),
              }
            : {}),
        }
      }
    )
    return [
      this.markdownLanguageConfiguration.of(
        this.topLevelLanguageExtension(documentKind, documentPath)
      ),
      this.documentPathConfiguration.of(markdownDocumentPath.of(documentPath)),
      this.remoteImagesConfiguration.of(
        markdownRemoteImagesEnabled.of(this.remoteImagesEnabled)
      ),
      this.syntaxTheme.of(
        syntaxThemeExtension(
          this.appearanceProfile.syntaxThemeId,
          resolvedProfile.backgroundColor
        )
      ),
      this.surfaceTheme.of(
        EditorView.darkTheme.of(resolvedProfile.surfaceScheme === "dark")
      ),
      this.historyConfiguration.of(history()),
      this.searchConfiguration.of(this.currentSearchExtension),
      this.spellCheckConfiguration.of(this.currentSpellCheckExtension),
      this.documentBehaviorConfiguration.of(
        this.documentBehaviorExtension(documentKind)
      ),
      this.pathCompletionConfiguration.of(this.currentPathCompletionExtension),
      EditorState.allowMultipleSelections.of(true),
      wordCountExtension,
      drawSelection(),
      selectionAppearanceExtension,
      dropCursor(),
      markdownEditorTheme,
      documentChromeScrollMargins,
      EditorView.editorAttributes.of({ class: "cm-md-editor" }),
      this.caretVisibility.of(this.caretExtension(caretVisible)),
      this.editability.of(this.editabilityExtension(this.readOnly)),
      EditorView.contentAttributes.of({
        "aria-label": this.ariaLabel,
        autocapitalize: "sentences",
        spellcheck: "false",
        tabindex: "0",
      }),
      this.presentation.of(
        this.presentationExtension(documentKind, resolvedMode)
      ),
      this.indentation.of(indentUnit.of(this.indentUnitFor(resolvedMode))),
      this.wrapping.of(lineWrapping ? EditorView.lineWrapping : []),
      this.layout.of(contentLayoutTheme(lineWrapping, this.maxContentWidth)),
      EditorView.domEventObservers({
        cut: () => {
          this.showCaret()
        },
        paste: () => {
          this.showCaret()
        },
      }),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event) => {
            if (event.key !== "Escape" || !event.repeat) return false
            event.preventDefault()
            return true
          },
        })
      ),
      EditorView.domEventHandlers({
        keydown: (event) => {
          this.cancelScrollAnchorRestore()
          if (
            event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            event.code === "KeyZ"
          ) {
            event.preventDefault()
            this.toggleLineWrapping()
            return true
          }
          if (keyShowsCaret(event)) this.showCaret()
          return false
        },
      }),
      keymap.of([
        {
          key: "Escape",
          run: () => {
            if (this.caretVisible) return this.dismissEditing()
            this.showCaret(true)
            this.view.focus()
            return true
          },
        },
        {
          key: "Enter",
          run: (view) =>
            this.documentKind === "markdown" && insertNewlineContinueList(view),
        },
        {
          key: "Shift-Enter",
          run: (view) =>
            this.documentKind === "markdown" && insertNewlineExitList(view),
        },
        {
          key: "Backspace",
          run: (view) =>
            this.documentKind === "markdown" && deleteListMarkupBackward(view),
        },
        {
          key: "Mod-Shift-v",
          run: () => {
            if (this.documentKind !== "markdown") return false
            this.toggleMode()
            return true
          },
        },
        {
          key: "Alt-z",
          preventDefault: true,
          run: () => {
            this.toggleLineWrapping()
            return true
          },
        },
        {
          key: "Tab",
          run: (view) =>
            (this.documentKind === "markdown" &&
              (moveSelectionToMarkdownLinkDestination(view) ||
                (this.mode === "live" && indentListItems(view)))) ||
            this.insertIndentUnit(view),
          shift: (view) =>
            (this.documentKind === "markdown" &&
              this.mode === "live" &&
              dedentListItems(view)) ||
            indentLess(view),
        },
        ...markdownFormattingBindings,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          (this.semanticPointerGesture ||
            this.semanticBoundaryFrame != null ||
            this.semanticBoundaryPointerFrame != null)
        ) {
          // Every source range and DOM endpoint held by an in-flight gesture
          // belongs to the pre-change document. Let the edit win instead of
          // dispatching or copying a stale pointer selection afterward.
          this.cancelSemanticPointerGesture(true)
        }
        if (this.linkTooltipAnchor && !this.linkTooltipAnchor.isConnected) {
          this.clearLinkTooltip()
        }
        if (this.pendingScrollAnchor && update.geometryChanged) {
          this.queueScrollAnchorRestore(this.pendingScrollAnchor)
        }
        const searchSupport = this.searchSupport
        if (searchSupport) {
          const queryChanged = !searchSupport
            .query(update.startState)
            .eq(searchSupport.query(update.state))
          const previousSearchMatch = searchSupport.currentMatch(
            update.startState
          )
          const nextSearchMatch = searchSupport.currentMatch(update.state)
          const currentSearchMatchChanged =
            previousSearchMatch?.from !== nextSearchMatch?.from ||
            previousSearchMatch?.to !== nextSearchMatch?.to
          if (
            queryChanged ||
            currentSearchMatchChanged ||
            update.docChanged ||
            update.selectionSet
          ) {
            this.reportSearchStatus(update.state)
          }
        }
        const wordCountChanged =
          update.startState.field(wordCountField) !==
          update.state.field(wordCountField)
        if (update.docChanged || update.selectionSet || wordCountChanged) {
          this.onStatusChange?.(editorStatus(update.state))
        }
        if (!update.docChanged) return
        this.clearLinkTooltip()
        const shouldNotify = update.transactions.some(
          (transaction) =>
            transaction.docChanged &&
            !transaction.annotation(suppressChangeNotification)
        )
        if (shouldNotify) {
          this.onChange?.((location) => {
            const selection = EditorSelection.single(
              location.selection.anchor,
              location.selection.head
            ).map(update.changes).main
            return {
              caretVisible: location.caretVisible,
              selection: {
                anchor: selection.anchor,
                head: selection.head,
              },
              viewport: {
                pos: update.changes.mapPos(location.viewport.pos, -1),
                screenOffset: location.viewport.screenOffset,
                scrollLeft: location.viewport.scrollLeft,
              },
            }
          })
        }
      }),
    ]
  }

  private presentationFor(mode: MarkdownEditorMode) {
    return mode === "live"
      ? [
          livePreviewExtension({
            codeBlock: this.markdownExtensions.mermaid
              ? {
                  filterKey: mermaidFencePresentationKey,
                  include: mermaidFenceUsesCodePresentation,
                }
              : undefined,
          }),
          ...(this.optionalLivePreviewSupport
            ? [
                this.optionalLivePreviewSupport.extensions({
                  onNavigate: () =>
                    this.onNavigate?.(this.captureNavigationLocation()),
                  selectionActive: livePreviewSelectionIsActive,
                  settings: this.markdownExtensions,
                  theme: (state) =>
                    state.facet(EditorView.darkTheme) ? "dark" : "default",
                }),
              ]
            : []),
        ]
      : sourcePresentation()
  }

  private markdownLanguageExtension() {
    return markdown({
      base: markdownBaseLanguage,
      codeLanguages: this.codeLanguages,
      addKeymap: false,
      extensions: createMarkdownParserExtensions(this.markdownExtensions),
      pasteURLAsLink: false,
    })
  }

  private memoizedMarkdownLanguageExtension() {
    const key = markdownParserConfigurationKey(this.markdownExtensions)
    const cached = this.markdownLanguageExtensionCache.get(key)
    if (cached) return cached
    const extension = this.markdownLanguageExtension()
    this.markdownLanguageExtensionCache.set(key, extension)
    return extension
  }

  private memoizedPresentationExtension(mode: MarkdownEditorMode) {
    if (mode === "source") return this.sourcePresentationExtension
    const key = markdownPresentationConfigurationKey(this.markdownExtensions)
    const cached = this.livePresentationExtensionCache.get(key)
    if (cached) return cached
    const extension = this.presentationFor("live")
    this.livePresentationExtensionCache.set(key, extension)
    return extension
  }

  private modeForDocumentKind(
    mode: MarkdownEditorMode,
    documentKind: DocumentKind = this.documentKind
  ): MarkdownEditorMode {
    return documentKind === "plain-text" ? "source" : mode
  }

  private presentationExtension(
    documentKind: DocumentKind,
    mode: MarkdownEditorMode
  ) {
    return documentKind === "markdown"
      ? this.currentPresentationExtensions[mode]
      : this.sourcePresentationExtension
  }

  private documentBehaviorExtension(documentKind: DocumentKind) {
    return documentKind === "markdown"
      ? this.markdownBehaviorExtension
      : this.plainTextBehaviorExtension
  }

  private matchingPlainTextLanguage(
    documentPath: string | null
  ): LanguageDescription | null {
    if (!this.codeLanguageSupportEnabled || !documentPath) return null
    const normalizedPath = documentPath.replaceAll("\\", "/")
    const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)
    return LanguageDescription.matchFilename(this.codeLanguages, filename)
  }

  private topLevelLanguageExtension(
    documentKind: DocumentKind,
    documentPath: string | null
  ) {
    if (documentKind === "markdown") {
      return this.currentMarkdownLanguageExtension
    }
    return (
      this.matchingPlainTextLanguage(documentPath)?.support ??
      this.plainTextLanguageFallback
    )
  }

  private refreshActiveTopLevelLanguage() {
    const request = ++this.topLevelLanguageRequest
    const documentKind = this.documentKind
    const documentPath = this.documentPath
    const description =
      documentKind === "plain-text"
        ? this.matchingPlainTextLanguage(documentPath)
        : null
    const extension =
      documentKind === "markdown"
        ? this.currentMarkdownLanguageExtension
        : (description?.support ?? this.plainTextLanguageFallback)

    if (this.markdownLanguageConfiguration.get(this.view.state) !== extension) {
      this.view.dispatch({
        effects: this.markdownLanguageConfiguration.reconfigure(extension),
      })
      requestContentGeometryRefresh(this.view)
    }

    if (
      this.destroyed ||
      documentKind !== "plain-text" ||
      !description ||
      description.support
    ) {
      return
    }

    void description
      .load()
      .then((support) => {
        if (
          this.destroyed ||
          request !== this.topLevelLanguageRequest ||
          this.documentKind !== "plain-text" ||
          this.documentPath !== documentPath ||
          this.matchingPlainTextLanguage(documentPath) !== description
        ) {
          return
        }
        if (
          this.markdownLanguageConfiguration.get(this.view.state) === support
        ) {
          return
        }
        this.view.dispatch({
          effects: this.markdownLanguageConfiguration.reconfigure(support),
        })
        requestContentGeometryRefresh(this.view)
      })
      .catch((error: unknown) => {
        if (
          !this.destroyed &&
          request === this.topLevelLanguageRequest &&
          this.documentKind === "plain-text" &&
          this.documentPath === documentPath
        ) {
          console.error(
            `Failed to load language support for ${documentPath ?? "document"}`,
            error
          )
        }
      })
  }

  private documentConfigurationEffects(
    state: EditorState,
    mode: MarkdownEditorMode,
    documentKind: DocumentKind,
    documentPath: string | null
  ) {
    const effects: StateEffect<unknown>[] = []
    const language = this.topLevelLanguageExtension(documentKind, documentPath)
    if (this.markdownLanguageConfiguration.get(state) !== language) {
      effects.push(this.markdownLanguageConfiguration.reconfigure(language))
    }

    const presentation = this.presentationExtension(documentKind, mode)
    if (this.presentation.get(state) !== presentation) {
      effects.push(this.presentation.reconfigure(presentation))
    }

    const documentBehavior = this.documentBehaviorExtension(documentKind)
    if (this.documentBehaviorConfiguration.get(state) !== documentBehavior) {
      effects.push(
        this.documentBehaviorConfiguration.reconfigure(documentBehavior)
      )
    }

    if (this.searchConfiguration.get(state) !== this.currentSearchExtension) {
      effects.push(
        this.searchConfiguration.reconfigure(this.currentSearchExtension)
      )
    }
    if (
      this.spellCheckConfiguration.get(state) !==
      this.currentSpellCheckExtension
    ) {
      effects.push(
        this.spellCheckConfiguration.reconfigure(
          this.currentSpellCheckExtension
        )
      )
    }
    if (
      this.pathCompletionConfiguration.get(state) !==
      this.currentPathCompletionExtension
    ) {
      effects.push(
        this.pathCompletionConfiguration.reconfigure(
          this.currentPathCompletionExtension
        )
      )
    }
    return effects
  }

  private clampedCursorPosition(
    state: EditorState,
    line: number,
    column: number
  ) {
    const lineNumber = Math.min(
      state.doc.lines,
      Math.max(1, Math.trunc(line) || 1)
    )
    const targetLine = state.doc.line(lineNumber)
    const columnNumber = Math.min(
      targetLine.length + 1,
      Math.max(1, Math.trunc(column) || 1)
    )
    return targetLine.from + columnNumber - 1
  }

  private indentUnitFor(mode: MarkdownEditorMode) {
    // Two spaces are the conventional live-Markdown fallback. Structural list
    // commands still adapt this to marker width and any nearby authored tabs.
    if (mode === "live") return "  "
    if (this.sourceIndentation === "tabs") return "\t"
    return " ".repeat(this.sourceIndentSize)
  }

  private insertIndentUnit(view: EditorView) {
    if (view.state.selection.ranges.some((range) => !range.empty)) {
      return indentMore(view)
    }

    const indentation =
      this.mode === "live" ? "\t" : view.state.facet(indentUnit)
    view.dispatch(
      view.state.update(view.state.replaceSelection(indentation), {
        scrollIntoView: true,
        userEvent: "input",
      })
    )
    return true
  }

  private showCaret(revealSelection = false) {
    this.cancelPendingCaretActivation()
    if (this.destroyed || this.readOnly || this.caretVisible) return
    revealSelection &&= this.revealCaretOnEscape
    this.revealCaretOnEscape = false
    const { scrollLeft, scrollTop } = this.view.scrollDOM
    const selection = this.view.state.selection.main
    const position = selection.head
    let selectionIsOffscreen = false
    if (revealSelection) {
      const coordinates = this.scrollAnchorCoordinates(
        this.view,
        position,
        selection.assoc
      )
      const scrollBounds = this.view.scrollDOM.getBoundingClientRect()
      const topMargin = documentChromeTopScrollMargin(this.view) ?? 0
      const bottomMargin = documentChromeBottomScrollMargin(this.view) ?? 0
      selectionIsOffscreen =
        !coordinates ||
        coordinates.top < scrollBounds.top + topMargin ||
        coordinates.bottom > scrollBounds.bottom - bottomMargin ||
        coordinates.left < scrollBounds.left ||
        coordinates.right > scrollBounds.right
    }
    this.caretVisible = true
    this.view.dispatch({
      effects: [
        ...(selectionIsOffscreen ? [EditorView.scrollIntoView(position)] : []),
        this.caretVisibility.reconfigure(this.caretExtension(true)),
        setLivePreviewEditorFocused.of(this.view.hasFocus),
        refreshLivePreview.of(null),
      ],
    })
    if (!selectionIsOffscreen) {
      // A visible caret-only presentation change does not authorize scrolling.
      // Preserve the owned viewport through replacement remapping.
      this.view.scrollDOM.scrollLeft = scrollLeft
      this.view.scrollDOM.scrollTop = scrollTop
    }
  }

  private hideCaret() {
    this.cancelPendingCaretActivation()
    if (this.destroyed || !this.caretVisible) return
    this.revealCaretOnEscape = false
    const { scrollLeft, scrollTop } = this.view.scrollDOM
    this.caretVisible = false
    this.view.dispatch({
      effects: [
        this.caretVisibility.reconfigure(this.caretExtension(false)),
        refreshLivePreview.of(null),
      ],
    })
    // See showCaret: dismissing editing must preserve the user's viewport.
    this.view.scrollDOM.scrollLeft = scrollLeft
    this.view.scrollDOM.scrollTop = scrollTop
  }

  private dismissEditing() {
    const selection = this.view.state.selection
    const semanticSelection = this.semanticPointerSelection
    const preserveSemanticScroll =
      semanticSelection != null &&
      selection.ranges.length === 1 &&
      selection.main.anchor === semanticSelection.anchor &&
      selection.main.head === semanticSelection.head
    const scrollPosition = preserveSemanticScroll
      ? semanticSelection.scroll
      : null
    const dismiss = () => {
      const selection = this.view.state.selection
      if (selection.ranges.length > 1 || !selection.main.empty) {
        this.view.dispatch({
          selection: { anchor: selection.main.head },
          // A semantic click already owns an exact physical scroll position.
          // A CodeMirror snapshot captured from the temporarily revealed raw
          // source would instead retain an interior source-line anchor. Once
          // that source remounts as one block widget, the stale anchor maps to
          // the widget edge and applies a delayed one-line scroll correction.
          effects: scrollPosition ? [] : this.view.scrollSnapshot(),
        })
      }
      this.hideCaret()
      this.revealCaretOnEscape = true
      if (this.view.hasFocus) this.view.contentDOM.blur()
    }
    if (scrollPosition) {
      this.preserveEditorScroll(dismiss, scrollPosition)
      this.queueSemanticScrollRestore(scrollPosition)
    } else {
      dismiss()
    }
    this.semanticPointerSelection = null
    return true
  }

  private readonly handleCaretVisibilityKeyDown = (event: KeyboardEvent) => {
    if (
      this.destroyed ||
      this.readOnly ||
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat
    ) {
      return
    }

    const primaryModifierPressed =
      this.platform === "darwin"
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
    if (
      !this.caretVisible &&
      !this.view.hasFocus &&
      primaryModifierPressed &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "a"
    ) {
      const editableTarget = event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement &&
            !this.view.dom.contains(target) &&
            (target.matches("input, textarea") || target.isContentEditable)
        )
      if (editableTarget) return
      // With CodeMirror blurred there is no editable select-all target. Keep
      // the browser's document selection from being adopted when Escape later
      // restores the editor focus and its retained collapsed caret.
      event.preventDefault()
      return
    }

    if (
      event.key !== "Escape" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return
    }

    // CodeMirror default-prevents Escape after handling it on the editable
    // surface. Every otherwise-unhandled Escape continues the same caret
    // visibility toggle at the editor's retained selection.
    event.preventDefault()
    if (this.caretVisible) {
      this.dismissEditing()
    } else {
      this.showCaret(true)
      this.view.focus()
    }
  }

  private showCaretAfterMouseDown(
    refreshAfterSelection = false,
    pointerScroll: EditorScrollPosition | null = null
  ) {
    if (
      this.destroyed ||
      this.readOnly ||
      (this.caretVisible && !refreshAfterSelection)
    ) {
      return
    }
    if (this.mode === "source") {
      this.showCaret()
      return
    }
    this.cancelPendingCaretActivation()
    if (!this.ownerWindow) {
      this.preserveEditorScroll(() => {
        if (this.caretVisible && refreshAfterSelection) {
          this.refreshAfterPointerSelection()
        } else {
          this.showCaret()
        }
        this.view.focus()
      }, pointerScroll)
      if (pointerScroll) this.queueSemanticScrollRestore(pointerScroll)
      return
    }

    this.caretPointerScroll = pointerScroll
    this.caretMouseUpPending = true
    this.ownerWindow.addEventListener("mouseup", this.handleCaretMouseUp)
  }

  private beginSemanticPointerGesture(
    event: MouseEvent,
    origin: SemanticPreviewSelection | null,
    startPosition: number | null,
    pointerScroll: EditorScrollPosition
  ) {
    this.cancelSemanticPointerGesture()
    this.setRenderedSemanticSelection(
      origin?.dragSelection === "rendered" ? origin.element : null
    )
    this.semanticPointerGesture = {
      boundaryEndpoint: null,
      boundarySemantic: null,
      dragged: false,
      nativeAnchor:
        origin?.dragSelection === "rendered"
          ? this.domSelectionPointAtPointer(
              origin.element,
              event.clientX,
              event.clientY,
              null,
              false
            )
          : null,
      nativeBoundaries: null,
      origin,
      pointerScroll,
      renderedSelection: false,
      startPosition,
      startX: event.clientX,
      startY: event.clientY,
    }
    this.ownerWindow?.addEventListener(
      "mousemove",
      this.handleSemanticPointerMouseMove,
      true
    )
    this.ownerWindow?.addEventListener(
      "mouseup",
      this.handleSemanticPointerMouseUp,
      true
    )
    this.ownerWindow?.addEventListener(
      "pointercancel",
      this.handleSemanticPointerCancel,
      true
    )
  }

  private cancelSemanticPointerGesture(clearNativeSelection = false) {
    this.ownerWindow?.removeEventListener(
      "mousemove",
      this.handleSemanticPointerMouseMove,
      true
    )
    this.ownerWindow?.removeEventListener(
      "mouseup",
      this.handleSemanticPointerMouseUp,
      true
    )
    this.ownerWindow?.removeEventListener(
      "pointercancel",
      this.handleSemanticPointerCancel,
      true
    )
    this.cancelSemanticBoundaryAutoScroll()
    this.semanticPointerGesture = null
    this.cancelSemanticBoundaryPointerUpdate()
    this.clearSemanticBoundaryCaret()
    if (this.semanticBoundaryFrame != null) {
      this.ownerWindow?.cancelAnimationFrame(this.semanticBoundaryFrame)
      this.semanticBoundaryFrame = null
    }
    if (clearNativeSelection) {
      this.view.dom.ownerDocument.getSelection()?.removeAllRanges()
      this.setRenderedSemanticSelection(null)
    }
  }

  private resetSemanticPointerInteraction() {
    this.cancelSemanticPointerGesture(true)
    this.setRenderedSemanticSelection(null)
    this.semanticDisjointSelection = null
    this.contextMenuPreservesRenderedSelection = false
  }

  private renderedSemanticSelectionText() {
    const element = this.renderedSemanticSelection
    const selection = element?.ownerDocument.getSelection()
    if (
      !element?.isConnected ||
      !selection ||
      selection.isCollapsed ||
      !element.contains(selection.anchorNode) ||
      !element.contains(selection.focusNode)
    ) {
      return null
    }
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    if (!range || selection.toString().length === 0) return null

    // A callout wraps source-backed CodeMirror lines, so the browser's plain
    // Selection string contains visually suppressed quote prefixes and fence
    // delimiters. Clone only the selected rendered DOM and remove those
    // presentation-only source lanes before asking the layout engine for its
    // visible text. Sanitized HTML uses the same path without special cases.
    const buffer = element.ownerDocument.createElement("div")
    buffer.className = "cm-md-rendered-selection-copy-buffer"
    buffer.setAttribute("aria-hidden", "true")
    buffer.contentEditable = "false"
    buffer.style.width = `${Math.max(1, element.getBoundingClientRect().width)}px`
    buffer.append(range.cloneContents())
    for (const hidden of buffer.querySelectorAll(
      [
        '[aria-hidden="true"]',
        ".cm-widgetBuffer",
        ".cm-md-list-quote-prefix-rendered",
        ".cm-md-list-marker-rendered",
        ".cm-md-definition-prefix-rendered",
        ".cm-md-code-indent-rendered",
        '.cm-md-code-block[data-code-kind="fenced"] .cm-md-code-tools-line',
        '.cm-md-code-block[data-code-kind="fenced"] .cm-md-code-line-last:not(.cm-md-code-content-line)',
      ].join(",")
    )) {
      hidden.remove()
    }
    this.view.dom.append(buffer)
    const text = buffer.innerText
    buffer.remove()
    return text || null
  }

  private setRenderedSemanticSelection(element: HTMLElement | null) {
    if (this.renderedSemanticSelection === element) return
    const previous = this.renderedSemanticSelection
    this.renderedSemanticSelection = element
    const observer = (this.view as unknown as PinnedEditorViewInternals)
      .observer
    observer.ignore(() => {
      previous?.removeAttribute("data-semantic-native-selection")
      element?.setAttribute("data-semantic-native-selection", "")
    })
  }

  private validSemanticDisjointSelectionText() {
    const disjoint = this.semanticDisjointSelection
    return disjoint &&
      this.view.state.doc === disjoint.doc &&
      this.view.state.selection.eq(disjoint.selection)
      ? disjoint.text
      : null
  }

  private externalEditableOwnsClipboard(event: ClipboardEvent) {
    const editable = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const candidate = target.closest(
        "input, textarea, select, [contenteditable]"
      )
      return candidate instanceof HTMLInputElement ||
        candidate instanceof HTMLTextAreaElement ||
        candidate instanceof HTMLSelectElement ||
        (candidate instanceof HTMLElement && candidate.isContentEditable)
        ? candidate
        : null
    }
    const pathEditable = event
      .composedPath()
      .map(editable)
      .find((candidate) => candidate != null)
    const activeEditable = editable(this.view.dom.ownerDocument.activeElement)
    const owner = pathEditable ?? activeEditable
    return owner != null && !this.view.dom.contains(owner)
  }

  private readonly handleOwnedPointerClipboard = (event: ClipboardEvent) => {
    if (this.externalEditableOwnsClipboard(event)) return
    const nativeText = this.renderedSemanticSelectionText()
    const validDisjointText = this.validSemanticDisjointSelectionText()
    const disjointText =
      validDisjointText &&
      (this.view.hasFocus ||
        event
          .composedPath()
          .some(
            (target) => target instanceof Node && this.view.dom.contains(target)
          ))
        ? validDisjointText
        : null
    const text = nativeText ?? disjointText
    if (!text || !event.clipboardData) return
    event.clipboardData.clearData()
    event.clipboardData.setData("text/plain", text)
    // A rendered selection and delimiter-free disjoint math selection own
    // clipboard serialization only. Cut must not mutate unrelated retained
    // Markdown source or leave unmatched math delimiters behind.
    event.preventDefault()
    event.stopPropagation()
  }

  private pointerPassedSemanticDragThreshold(
    gesture: SemanticPointerGesture,
    event: Pick<MouseEvent, "clientX" | "clientY">
  ) {
    return (
      Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY
      ) >= semanticDragThreshold
    )
  }

  private pointerNearSemanticStart(
    element: HTMLElement,
    pointer: Pick<MouseEvent, "clientX" | "clientY">,
    bounds = element.getBoundingClientRect(),
    blockLike = this.semanticBoundsAreBlockLike(bounds)
  ) {
    if (blockLike) return pointer.clientY < bounds.top + bounds.height / 2
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    return style?.direction === "rtl"
      ? pointer.clientX >= bounds.left + bounds.width / 2
      : pointer.clientX < bounds.left + bounds.width / 2
  }

  private semanticBoundsAreBlockLike(bounds: Pick<DOMRect, "height">) {
    return bounds.height > this.view.defaultLineHeight * this.view.scaleY * 1.5
  }

  private clearSemanticBoundaryCaret() {
    this.semanticBoundaryCaret?.remove()
    this.semanticBoundaryCaret = null
    const target = this.semanticBoundaryTarget
    this.semanticBoundaryTarget = null
    if (target) {
      const observer = (this.view as unknown as PinnedEditorViewInternals)
        .observer
      observer.ignore(() => {
        target.removeAttribute("data-semantic-boundary-target")
      })
    }
  }

  private showSemanticBoundaryCaret(
    endpoint: SemanticBoundaryEndpoint,
    elementBounds = endpoint.semantic.element.getBoundingClientRect()
  ) {
    const viewportBounds = this.view.scrollDOM.getBoundingClientRect()
    const editorBounds = this.view.dom.getBoundingClientRect()
    const top = Math.max(elementBounds.top, viewportBounds.top)
    const bottom = Math.min(elementBounds.bottom, viewportBounds.bottom)
    if (bottom <= top) {
      this.clearSemanticBoundaryCaret()
      return
    }

    const caret =
      this.semanticBoundaryCaret ??
      this.view.dom.ownerDocument.createElement("span")
    caret.className = "cm-md-semantic-boundary-caret"
    caret.dataset.edge = endpoint.nearStart ? "start" : "end"
    caret.setAttribute("aria-hidden", "true")
    caret.style.top = `${top - editorBounds.top}px`
    caret.style.height = `${bottom - top}px`
    caret.style.left = `${
      Math.min(
        viewportBounds.right,
        Math.max(
          viewportBounds.left,
          endpoint.nearStart ? elementBounds.left : elementBounds.right
        )
      ) - editorBounds.left
    }px`
    if (!caret.isConnected) this.view.dom.append(caret)
    this.semanticBoundaryCaret = caret
  }

  private updateSemanticBoundaryEndpoint(
    gesture: SemanticPointerGesture,
    event: SemanticPointerLocation,
    resolvedSemantic: SemanticPreviewSelection | null = null
  ) {
    const semantic = resolvedSemantic ?? this.semanticSelectionAtPointer(event)
    if (!semantic) {
      gesture.boundaryEndpoint = null
      gesture.boundarySemantic = null
      this.clearSemanticBoundaryCaret()
      return
    }
    const elementBounds = semantic.element.getBoundingClientRect()
    const blockLike = this.semanticBoundsAreBlockLike(elementBounds)
    const endpoint: SemanticBoundaryEndpoint = {
      clientX: event.clientX,
      clientY: event.clientY,
      nearStart: this.pointerNearSemanticStart(
        semantic.element,
        event,
        elementBounds,
        blockLike
      ),
      semantic,
    }
    if (this.semanticBoundaryTarget !== semantic.element) {
      const previous = this.semanticBoundaryTarget
      const observer = (this.view as unknown as PinnedEditorViewInternals)
        .observer
      observer.ignore(() => {
        previous?.removeAttribute("data-semantic-boundary-target")
        semantic.element.setAttribute("data-semantic-boundary-target", "")
      })
      this.semanticBoundaryTarget = semantic.element
    }
    const start = gesture.startPosition
    if (start != null) {
      // CodeMirror's active mouse session can otherwise advance through the
      // source-backed lines inside a rendered callout while the boundary
      // caret is showing. Rendered units move only between their complete
      // source edges, while atomic inner-bound previews remain clamped at the
      // edge where the drag entered them.
      const entryEdge = start <= semantic.from ? semantic.from : semantic.to
      const head =
        semantic.dragSelection === "rendered"
          ? endpoint.nearStart
            ? semantic.from
            : semantic.to
          : entryEdge
      const clamped = EditorSelection.single(start, head)
      if (!this.view.state.selection.eq(clamped)) {
        this.preserveEditorScroll(() => {
          this.view.dispatch({
            selection: clamped,
            userEvent: "select.pointer",
          })
        })
      }
    }
    gesture.boundaryEndpoint = endpoint
    this.showSemanticBoundaryCaret(endpoint, elementBounds)
  }

  private cancelSemanticBoundaryPointerUpdate() {
    if (this.semanticBoundaryPointerFrame != null) {
      this.ownerWindow?.cancelAnimationFrame(this.semanticBoundaryPointerFrame)
      this.semanticBoundaryPointerFrame = null
    }
    this.pendingSemanticBoundaryPointer = null
  }

  private queueSemanticBoundaryEndpoint(
    gesture: SemanticPointerGesture,
    event: SemanticPointerLocation,
    semantic: SemanticPreviewSelection | null = null
  ) {
    this.pendingSemanticBoundaryPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      gesture,
      semantic,
      target: event.target,
    }
    if (this.semanticBoundaryPointerFrame != null) return

    const update = () => {
      this.semanticBoundaryPointerFrame = null
      const pending = this.pendingSemanticBoundaryPointer
      this.pendingSemanticBoundaryPointer = null
      if (
        !pending ||
        this.destroyed ||
        this.semanticPointerGesture !== pending.gesture
      ) {
        return
      }
      this.updateSemanticBoundaryEndpoint(
        pending.gesture,
        pending,
        pending.semantic
      )
    }
    this.semanticBoundaryPointerFrame =
      this.ownerWindow?.requestAnimationFrame(update) ?? null
    if (this.semanticBoundaryPointerFrame == null) update()
  }

  private semanticTargetAtPointer(
    gesture: SemanticPointerGesture,
    event: SemanticPointerLocation
  ) {
    const target =
      this.view.dom.ownerDocument.elementFromPoint(
        event.clientX,
        event.clientY
      ) ?? (event.target instanceof Element ? event.target : null)
    const retained = gesture.boundarySemantic
    const semantic =
      retained &&
      target &&
      (target === retained.element || retained.element.contains(target))
        ? retained
        : target
          ? semanticPreviewSelectionAtTarget(this.view, target, {
              x: event.clientX,
              y: event.clientY,
            })
          : null
    return { semantic, target }
  }

  private semanticDragScrollSpeed(
    coordinate: number,
    start: number,
    end: number
  ) {
    if (coordinate <= start + semanticDragScrollMargin) {
      return -(Math.max(0, start - coordinate) * 0.7 + 8)
    }
    if (coordinate >= end - semanticDragScrollMargin) {
      return Math.max(0, coordinate - end) * 0.7 + 8
    }
    return 0
  }

  private semanticScrollMargins() {
    const margins = { bottom: 0, left: 0, right: 0, top: 0 }
    for (const source of this.view.state.facet(EditorView.scrollMargins)) {
      const resolved = source(this.view)
      if (!resolved) continue
      if (resolved.bottom != null)
        margins.bottom = Math.max(margins.bottom, resolved.bottom)
      if (resolved.left != null)
        margins.left = Math.max(margins.left, resolved.left)
      if (resolved.right != null)
        margins.right = Math.max(margins.right, resolved.right)
      if (resolved.top != null)
        margins.top = Math.max(margins.top, resolved.top)
    }
    return margins
  }

  private updateSemanticAutoScrollEndpoint(
    gesture: SemanticPointerGesture,
    event: SemanticPointerLocation
  ) {
    const { semantic, target } = this.semanticTargetAtPointer(gesture, event)
    if (semantic) {
      gesture.boundarySemantic = semantic
      this.updateSemanticBoundaryEndpoint(gesture, event, semantic)
      return
    }

    gesture.boundarySemantic = null
    gesture.boundaryEndpoint = null
    this.clearSemanticBoundaryCaret()
    const start = gesture.startPosition
    if (start == null) return
    const current = sourceLinePointerPosition(this.view, {
      clientX: event.clientX,
      clientY: event.clientY,
      target,
    })
    if (!current) return
    const selection = EditorSelection.single(start, current.pos)
    if (this.view.state.selection.eq(selection)) return
    this.preserveEditorScroll(() => {
      this.view.dispatch({
        selection,
        userEvent: "select.pointer",
      })
    })
  }

  private queueSemanticBoundaryAutoScroll(
    gesture: SemanticPointerGesture,
    event: SemanticPointerLocation
  ) {
    const ownerWindow = this.ownerWindow
    if (!ownerWindow) return
    this.semanticBoundaryAutoScrollPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      gesture,
      target: event.target,
    }
    if (this.semanticBoundaryAutoScrollFrame != null) return
    this.semanticBoundaryAutoScrollTimestamp = ownerWindow.performance.now()

    const scroll = (timestamp: number) => {
      this.semanticBoundaryAutoScrollFrame = null
      const pending = this.semanticBoundaryAutoScrollPointer
      if (
        !pending ||
        this.destroyed ||
        this.semanticPointerGesture !== pending.gesture
      ) {
        return
      }

      const bounds = this.view.scrollDOM.getBoundingClientRect()
      const margins = this.semanticScrollMargins()
      const speedX = this.semanticDragScrollSpeed(
        pending.clientX,
        bounds.left + margins.left,
        bounds.right - margins.right
      )
      const speedY = this.semanticDragScrollSpeed(
        pending.clientY,
        bounds.top + margins.top,
        bounds.bottom - margins.bottom
      )
      if (speedX === 0 && speedY === 0) return

      const elapsed = Math.max(
        1,
        Math.min(
          semanticDragScrollInterval,
          timestamp - this.semanticBoundaryAutoScrollTimestamp
        )
      )
      this.semanticBoundaryAutoScrollTimestamp = timestamp
      const scrollDOM = this.view.scrollDOM
      const previousLeft = scrollDOM.scrollLeft
      const previousTop = scrollDOM.scrollTop
      const scrollDelta = (speed: number) =>
        speed === 0
          ? 0
          : Math.sign(speed) *
            Math.max(
              1,
              Math.abs((speed * elapsed) / semanticDragScrollInterval)
            )
      scrollDOM.scrollLeft += scrollDelta(speedX)
      scrollDOM.scrollTop += scrollDelta(speedY)
      const advanced = !(
        scrollDOM.scrollLeft === previousLeft &&
        scrollDOM.scrollTop === previousTop
      )

      if (advanced) {
        // The gesture's scroll position is also the viewport baseline used by
        // the mouseup selection/caret refresh. Advance it with the custom drag
        // scroll so finishing the gesture cannot restore the viewport to where
        // the drag originally started.
        pending.gesture.pointerScroll.scrollLeft = scrollDOM.scrollLeft
        pending.gesture.pointerScroll.scrollTop = scrollDOM.scrollTop
      }

      // CodeMirror's own scroll loop also replays selection after each tick,
      // but that would enter source rows inside the callout. Re-hit-test the
      // stationary pointer and move only between complete semantic edges (or
      // resume an ordinary source endpoint once the card has passed it).
      // Cancel a mousemove measurement queued before this scroll first; that
      // frame still owns the pre-scroll callout and must not reinstate it after
      // this coordinate-based update. Re-hit-test even at the scroll limit so
      // the final source row under the pointer becomes the endpoint.
      this.cancelSemanticBoundaryPointerUpdate()
      this.updateSemanticAutoScrollEndpoint(pending.gesture, pending)
      if (!advanced) return
      this.semanticBoundaryAutoScrollFrame =
        ownerWindow.requestAnimationFrame(scroll)
    }
    this.semanticBoundaryAutoScrollFrame =
      ownerWindow.requestAnimationFrame(scroll)
  }

  private cancelSemanticBoundaryAutoScroll() {
    if (this.semanticBoundaryAutoScrollFrame != null) {
      this.ownerWindow?.cancelAnimationFrame(
        this.semanticBoundaryAutoScrollFrame
      )
      this.semanticBoundaryAutoScrollFrame = null
    }
    this.semanticBoundaryAutoScrollPointer = null
    this.semanticBoundaryAutoScrollTimestamp = 0
  }

  private domSelectionBoundaries(element: HTMLElement) {
    const ownerWindow = element.ownerDocument.defaultView
    const walker = element.ownerDocument.createTreeWalker(
      element,
      ownerWindow?.NodeFilter.SHOW_TEXT ?? 4,
      {
        acceptNode: (node) => {
          const text = node as Text
          const parent = text.parentElement
          if (!text.data || !parent) {
            return ownerWindow?.NodeFilter.FILTER_REJECT ?? 2
          }
          if (parent.closest('[aria-hidden="true"], script, style')) {
            return ownerWindow?.NodeFilter.FILTER_REJECT ?? 2
          }
          const style = ownerWindow?.getComputedStyle(parent)
          return style?.display === "none" || style?.userSelect === "none"
            ? (ownerWindow?.NodeFilter.FILTER_REJECT ?? 2)
            : (ownerWindow?.NodeFilter.FILTER_ACCEPT ?? 1)
        },
      }
    )
    let text = walker.nextNode() as Text | null
    const first = text
    let last = text
    while (text) {
      last = text
      text = walker.nextNode() as Text | null
    }
    if (first && last) {
      return {
        start: { node: first, offset: 0 },
        end: { node: last, offset: last.data.length },
      }
    }
    return {
      start: { node: element, offset: 0 },
      end: { node: element, offset: element.childNodes.length },
    }
  }

  private domSelectionPointAtPointer(
    element: HTMLElement,
    clientX: number,
    clientY: number,
    boundaries: SemanticPointerGesture["nativeBoundaries"] = null,
    allowBoundaryFallback = true
  ): DOMSelectionPoint | null {
    const ownerDocument = element.ownerDocument as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null
    }
    const caret = ownerDocument.caretRangeFromPoint?.(clientX, clientY)
    if (
      caret &&
      (caret.startContainer === element ||
        element.contains(caret.startContainer))
    ) {
      const parent =
        caret.startContainer instanceof Element
          ? caret.startContainer
          : caret.startContainer.parentElement
      if (!parent?.closest('[aria-hidden="true"]')) {
        return { node: caret.startContainer, offset: caret.startOffset }
      }
    }
    if (!allowBoundaryFallback) return null
    const resolvedBoundaries =
      boundaries ?? this.domSelectionBoundaries(element)
    return this.pointerNearSemanticStart(element, { clientX, clientY })
      ? resolvedBoundaries.start
      : resolvedBoundaries.end
  }

  private updateRenderedSemanticSelection(
    gesture: SemanticPointerGesture,
    event: Pick<MouseEvent, "clientX" | "clientY">
  ) {
    const origin = gesture.origin
    if (origin?.dragSelection !== "rendered" || !origin.element.isConnected) {
      return false
    }
    gesture.nativeAnchor ??= this.domSelectionPointAtPointer(
      origin.element,
      gesture.startX,
      gesture.startY,
      null,
      false
    )
    let focus = this.domSelectionPointAtPointer(
      origin.element,
      event.clientX,
      event.clientY,
      null,
      false
    )
    if (!gesture.nativeAnchor || !focus) {
      gesture.nativeBoundaries ??= this.domSelectionBoundaries(origin.element)
      gesture.nativeAnchor ??= this.domSelectionPointAtPointer(
        origin.element,
        gesture.startX,
        gesture.startY,
        gesture.nativeBoundaries
      )
      focus ??= this.domSelectionPointAtPointer(
        origin.element,
        event.clientX,
        event.clientY,
        gesture.nativeBoundaries
      )
    }
    const anchor = gesture.nativeAnchor
    if (!anchor) return false
    if (this.view.hasFocus) this.view.contentDOM.blur()
    if (!focus) return false
    const selection = origin.element.ownerDocument.getSelection()
    if (!selection) return false
    try {
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset
      )
    } catch {
      return false
    }
    // A rendered callout contains ordinary CodeMirror line DOM. Chromium can
    // focus that editable root when a Selection is placed in those lines,
    // even though the originating mousedown was canceled. Tell the pinned
    // CodeMirror observer that this DOM range is intentional before the
    // asynchronous selectionchange event arrives, so it never adopts the
    // rendered range as an editor source selection and reveals the callout on
    // a later transaction.
    const observedAnchor = selection.anchorNode
      ? { node: selection.anchorNode, offset: selection.anchorOffset }
      : anchor
    const observedFocus = selection.focusNode
      ? { node: selection.focusNode, offset: selection.focusOffset }
      : focus
    const observer = (this.view as unknown as PinnedEditorViewInternals)
      .observer
    observer.setSelectionRange(observedAnchor, observedFocus)
    if (this.view.hasFocus) this.view.contentDOM.blur()
    gesture.renderedSelection = !selection.isCollapsed
    return gesture.renderedSelection
  }

  private readonly handleSemanticPointerMouseMove = (event: MouseEvent) => {
    const gesture = this.semanticPointerGesture
    if (!gesture || (event.buttons & 1) === 0) return
    if (!gesture.dragged) {
      if (!this.pointerPassedSemanticDragThreshold(gesture, event)) return
      gesture.dragged = true
    }
    if (!gesture.origin) {
      const { semantic: targetSemantic } = this.semanticTargetAtPointer(
        gesture,
        event
      )
      // Queue the immediate semantic clamp before autoscroll. The scroll
      // frame then has final ownership of the endpoint if the card moves away
      // from the stationary pointer during the same animation frame.
      this.queueSemanticBoundaryEndpoint(gesture, event, targetSemantic)
      if (targetSemantic) {
        // The first opaque unit entered owns the rest of its nested DOM for
        // this source-origin gesture. Crossing a nested callout must not turn
        // one outer-card selection into a sequence of partial inner ranges.
        gesture.boundarySemantic = targetSemantic
        // Capturing this move bypasses CodeMirror's MouseSelection.move.
        // Neutralize any edge-autoscroll interval armed by the preceding
        // ordinary-source move so it cannot replay that stale endpoint.
        const inputState = (this.view as unknown as PinnedEditorViewInternals)
          .inputState
        inputState.mouseSelection?.setScrollSpeed(0, 0)
        // A callout contains ordinary editable line DOM, so CodeMirror can
        // otherwise select a partial source endpoint before the queued
        // semantic clamp runs. Stop that document-level mousemove while the
        // target-only resolver passes the complete unit to the next frame.
        event.preventDefault()
        event.stopPropagation()
        this.queueSemanticBoundaryAutoScroll(gesture, event)
      } else {
        this.cancelSemanticBoundaryAutoScroll()
      }
      return
    }
    if (gesture.origin.dragSelection !== "rendered") return
    event.preventDefault()
    event.stopPropagation()
    this.updateRenderedSemanticSelection(gesture, event)
  }

  private readonly handleSemanticPointerCancel = () => {
    this.cancelSemanticPointerGesture(true)
  }

  private semanticSelectionAtPointer(event: SemanticPointerLocation) {
    // CodeMirror's active mouse-selection session retargets mouseup to its
    // content root. Hit-test the actual release coordinates so a still-frozen
    // replacement widget remains discoverable.
    const hitTarget =
      this.view.dom.ownerDocument.elementFromPoint(
        event.clientX,
        event.clientY
      ) ?? (event.target instanceof Element ? event.target : null)
    if (!hitTarget) return null
    const position = this.view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    })
    return position == null
      ? null
      : semanticPreviewSelectionAtPointer(this.view, hitTarget, position, {
          x: event.clientX,
          y: event.clientY,
        })
  }

  private sourceLinePositionAtPointer(event: MouseEvent) {
    return sourceLinePointerPosition(this.view, event)?.pos ?? null
  }

  private selectSemanticSource(
    semantic: SemanticPreviewSelection,
    nearStart: boolean,
    pointerScroll: EditorScrollPosition
  ) {
    this.setRenderedSemanticSelection(null)
    this.semanticDisjointSelection = null
    const from = semantic.selectionFrom ?? semantic.from
    const to = semantic.selectionTo ?? semantic.to
    const head = nearStart ? from : to
    const anchor = nearStart ? to : from
    this.semanticPointerSelection = { anchor, head, scroll: pointerScroll }
    this.preserveEditorScroll(() => {
      this.view.dispatch({
        selection: EditorSelection.single(anchor, head),
        effects: this.view.scrollSnapshot(),
        userEvent: "select.pointer",
      })
    }, pointerScroll)
  }

  private selectThroughSemanticBoundary(
    gesture: SemanticPointerGesture,
    semantic: SemanticPreviewSelection,
    nearStart: boolean
  ) {
    const start = gesture.startPosition
    if (start == null) return false
    const selectionFrom = semantic.selectionFrom ?? semantic.from
    const selectionTo = semantic.selectionTo ?? semantic.to
    const startsBefore = start <= semantic.from
    const includesSemantic = startsBefore ? !nearStart : nearStart
    const hasInnerSelectionBounds =
      selectionFrom !== semantic.from || selectionTo !== semantic.to
    let selection: EditorSelection
    let ownsDisjointSelection = false

    if (includesSemantic && hasInnerSelectionBounds) {
      const external = startsBefore
        ? EditorSelection.range(start, semantic.from)
        : EditorSelection.range(start, semantic.to)
      const inner = startsBefore
        ? EditorSelection.range(selectionFrom, selectionTo)
        : EditorSelection.range(selectionTo, selectionFrom)
      selection = startsBefore
        ? EditorSelection.create([external, inner], 1)
        : EditorSelection.create([inner, external], 0)
      ownsDisjointSelection = true
    } else if (!includesSemantic && hasInnerSelectionBounds) {
      // The outer delimiter starts exactly at this boundary. Keeping one
      // intact range preserves every neighboring source character; inline
      // math presentation treats the range head at either outer boundary as
      // active so the source can still open without selecting a delimiter.
      selection = EditorSelection.single(
        start,
        startsBefore ? semantic.from : semantic.to
      )
    } else if (!includesSemantic) {
      // The source outside the rendered unit remains one ordinary range.
      // A separate cursor at the widget boundary creates a second visible
      // caret and gives both carets independent movement after pointerup.
      selection = EditorSelection.single(
        start,
        nearStart ? semantic.from : semantic.to
      )
    } else {
      selection = EditorSelection.single(
        start,
        nearStart ? semantic.from : semantic.to
      )
    }

    this.setRenderedSemanticSelection(null)
    this.preserveEditorScroll(() => {
      this.view.dispatch({
        selection,
        effects: this.view.scrollSnapshot(),
        userEvent: "select.pointer",
      })
    }, gesture.pointerScroll)
    const ownedSelection = this.view.state.selection
    this.semanticDisjointSelection = ownsDisjointSelection
      ? {
          doc: this.view.state.doc,
          selection: ownedSelection,
          text: ownedSelection.ranges
            .filter((range) => !range.empty)
            .map((range) => this.view.state.sliceDoc(range.from, range.to))
            .join(""),
        }
      : null
    return true
  }

  private readonly handleSemanticPointerMouseUp = (event: MouseEvent) => {
    const gesture = this.semanticPointerGesture
    if (!gesture) return
    if (!gesture.dragged) {
      gesture.dragged = this.pointerPassedSemanticDragThreshold(gesture, event)
    }

    const origin = gesture.origin
    if (origin) {
      if (gesture.dragged) {
        if (origin.dragSelection === "rendered") {
          event.preventDefault()
          event.stopPropagation()
          const ownsNativeSelection = this.updateRenderedSemanticSelection(
            gesture,
            event
          )
          if (ownsNativeSelection) {
            this.setRenderedSemanticSelection(origin.element)
            this.semanticDisjointSelection = null
          }
          this.cancelSemanticPointerGesture(!ownsNativeSelection)
          return
        }
        this.cancelSemanticPointerGesture()
        return
      }

      const nearStart = this.pointerNearSemanticStart(origin.element, event)
      this.selectSemanticSource(origin, nearStart, gesture.pointerScroll)
      this.cancelSemanticPointerGesture()
      this.activateCaretAfterPointerUp(true, gesture.pointerScroll)
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const releaseTarget =
      this.view.dom.ownerDocument.elementFromPoint(
        event.clientX,
        event.clientY
      ) ?? (event.target instanceof Element ? event.target : null)
    const retainedSemantic = gesture.boundarySemantic
    const resolvedEndpoint = gesture.dragged
      ? retainedSemantic &&
        releaseTarget &&
        (releaseTarget === retainedSemantic.element ||
          retainedSemantic.element.contains(releaseTarget))
        ? retainedSemantic
        : this.semanticSelectionAtPointer(event)
      : null
    const cachedEndpoint = gesture.boundaryEndpoint
    const cachedEndpointAtRelease =
      cachedEndpoint &&
      Math.hypot(
        event.clientX - cachedEndpoint.clientX,
        event.clientY - cachedEndpoint.clientY
      ) <= 2
        ? cachedEndpoint
        : null
    // Prefer the last live mousemove measurement. CodeMirror can detach the
    // frozen widget in an earlier mouseup listener, at which point the same
    // semantic resolver still succeeds but its element reports zero geometry.
    const endpoint =
      cachedEndpointAtRelease ??
      (resolvedEndpoint
        ? {
            clientX: event.clientX,
            clientY: event.clientY,
            nearStart: this.pointerNearSemanticStart(
              resolvedEndpoint.element,
              event
            ),
            semantic: resolvedEndpoint,
          }
        : null)
    if (endpoint) {
      if (gesture.startPosition != null) {
        const pointerScroll = gesture.pointerScroll
        this.cancelSemanticPointerGesture()
        this.caretPointerScroll = null
        this.clearPendingCaretMouseUp()
        // Let CodeMirror's document-level mouseup listener end its native
        // mouse-selection session first. That session can otherwise replay
        // its last edge selection after our semantic endpoint dispatch.
        const finish = () => {
          this.semanticBoundaryFrame = null
          if (this.destroyed) return
          this.selectThroughSemanticBoundary(
            gesture,
            endpoint.semantic,
            endpoint.nearStart
          )
          this.activateCaretAfterPointerUp(true, pointerScroll)
        }
        this.semanticBoundaryFrame =
          this.ownerWindow?.requestAnimationFrame(finish) ?? null
        if (this.semanticBoundaryFrame == null) finish()
        return
      }
    }
    this.cancelSemanticPointerGesture()
  }

  private clearPendingCaretMouseUp() {
    if (!this.caretMouseUpPending) return
    this.caretMouseUpPending = false
    this.ownerWindow?.removeEventListener("mouseup", this.handleCaretMouseUp)
  }

  private cancelPendingCaretActivation() {
    this.clearPendingCaretMouseUp()
    this.caretPointerScroll = null
    this.caretActivation += 1
  }

  private activateCaretAfterPointerUp(
    refreshAfterSelection: boolean,
    pointerScroll: EditorScrollPosition | null
  ) {
    if (this.view.dom.classList.contains("cm-md-table-range-selection")) {
      this.preserveEditorScroll(() => {
        if (this.caretVisible) this.hideCaret()
        else this.refreshAfterPointerSelection()
        this.view.focus()
      }, pointerScroll)
      if (pointerScroll) this.queueSemanticScrollRestore(pointerScroll)
      return
    }
    const activation = ++this.caretActivation
    queuePreviewRebuild(() => {
      if (this.destroyed || activation !== this.caretActivation) return
      this.preserveEditorScroll(() => {
        if (this.caretVisible && refreshAfterSelection) {
          this.refreshAfterPointerSelection()
        } else this.showCaret()
        this.view.focus()
      }, pointerScroll)
      if (pointerScroll) this.queueSemanticScrollRestore(pointerScroll)
    })
  }

  private readonly handleCaretMouseUp = () => {
    const pointerScroll = this.caretPointerScroll
    this.caretPointerScroll = null
    this.clearPendingCaretMouseUp()
    this.activateCaretAfterPointerUp(true, pointerScroll)
  }

  private refreshAfterPointerSelection() {
    if (this.destroyed) return
    this.view.dispatch({
      effects: [this.view.scrollSnapshot(), refreshLivePreview.of(null)],
    })
  }

  private preserveEditorScroll(
    operation: () => void,
    position: EditorScrollPosition | null = null
  ) {
    const preserved = position ?? this.view.scrollDOM
    const scrollLeft = preserved.scrollLeft
    const scrollTop = preserved.scrollTop
    try {
      operation()
    } finally {
      this.view.scrollDOM.scrollLeft = scrollLeft
      this.view.scrollDOM.scrollTop = scrollTop
    }
  }

  private queueSemanticScrollRestore(position: EditorScrollPosition) {
    const ownerWindow = this.ownerWindow
    if (!ownerWindow) return
    if (this.semanticScrollFrame != null) {
      ownerWindow.cancelAnimationFrame(this.semanticScrollFrame)
    }
    this.semanticScrollFrame = ownerWindow.requestAnimationFrame(() => {
      this.semanticScrollFrame = null
      if (this.destroyed) return
      this.view.scrollDOM.scrollLeft = position.scrollLeft
      this.view.scrollDOM.scrollTop = position.scrollTop
    })
  }

  private cancelSemanticScrollRestore() {
    if (this.semanticScrollFrame == null) return
    this.ownerWindow?.cancelAnimationFrame(this.semanticScrollFrame)
    this.semanticScrollFrame = null
  }

  private caretExtension(visible: boolean): Extension {
    return [
      livePreviewSelectionActive.of(visible),
      visible
        ? []
        : EditorView.editorAttributes.of({ class: hiddenMarkdownCaretClass }),
    ]
  }

  private editabilityExtension(readOnly: boolean): Extension {
    return [
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]
  }

  private clickIsInTextLane(event: Pick<MouseEvent, "clientX">) {
    const content = this.view.contentDOM
    const rect = content.getBoundingClientRect()
    const style = this.ownerWindow?.getComputedStyle(content)
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "0") || 0
    const paddingRight = Number.parseFloat(style?.paddingRight ?? "0") || 0
    const fontSize = Number.parseFloat(style?.fontSize ?? "0") || 0
    const hitSlop = fontSize * textLaneHitSlopEm
    const textLeft = rect.left + paddingLeft
    const textRight = rect.right - paddingRight
    return (
      event.clientX >= Math.max(rect.left, textLeft - hitSlop) &&
      event.clientX <= Math.min(rect.right, textRight + hitSlop)
    )
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.pendingPointerMove = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    }
    if (this.pointerMoveFrame !== null) return
    const update = () => {
      this.pointerMoveFrame = null
      const pending = this.pendingPointerMove
      this.pendingPointerMove = null
      if (!pending || this.destroyed) return
      this.updatePointerState(pending)
    }
    this.pointerMoveFrame =
      this.ownerWindow?.requestAnimationFrame(update) ?? null
    if (this.pointerMoveFrame === null) update()
  }

  private updatePointerState(event: {
    clientX: number
    clientY: number
    target: EventTarget | null
  }) {
    const target = event.target
    this.view.dom.classList.toggle(
      textLanePointerClass,
      target instanceof Node &&
        this.view.contentDOM.contains(target) &&
        this.clickIsInTextLane(event)
    )

    const link =
      this.documentKind === "markdown" &&
      this.mode === "live" &&
      target instanceof Element
        ? target.closest<HTMLElement>(
            "[data-markdown-link-title], .cm-md-openable-link"
          )
        : null
    if (link === this.linkTooltipAnchor) return
    this.linkTooltipAnchor = link
    this.linkTooltipDestination = null
    if (!link) {
      this.onLinkTooltipChange?.(null)
      return
    }

    if (link.classList.contains("cm-md-openable-link")) {
      const position = this.view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
      })
      const resolved =
        position == null
          ? null
          : markdownLinkTargetAt(this.view.state, position)
      if (resolved?.activation && resolved.destination) {
        this.linkTooltipDestination = resolved.destination
      }
    }
    this.publishLinkTooltip()
  }

  private publishLinkTooltip() {
    const link = this.linkTooltipAnchor
    if (!link) {
      this.onLinkTooltipChange?.(null)
      return
    }
    const title = link.dataset.markdownLinkTitle
    const text =
      this.openLinkModifierActive && this.linkTooltipDestination
        ? this.linkTooltipDestination
        : title
    if (!text) {
      this.onLinkTooltipChange?.(null)
      return
    }

    const bounds = link.getBoundingClientRect()
    this.onLinkTooltipChange?.({
      title: text,
      anchor: {
        height: bounds.height,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
      },
    })
  }

  private readonly handlePointerLeave = () => {
    this.clearPendingPointerMove()
    this.view.dom.classList.remove(textLanePointerClass)
    this.clearLinkTooltip()
  }

  private clearPendingPointerMove() {
    if (this.pointerMoveFrame !== null) {
      this.ownerWindow?.cancelAnimationFrame(this.pointerMoveFrame)
      this.pointerMoveFrame = null
    }
    this.pendingPointerMove = null
  }

  private readonly clearLinkTooltip = () => {
    if (!this.linkTooltipAnchor) return
    this.linkTooltipAnchor = null
    this.linkTooltipDestination = null
    this.onLinkTooltipChange?.(null)
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    const contextClick =
      event.button === 2 ||
      (this.platform === "darwin" && event.button === 0 && event.ctrlKey)
    if (contextClick) {
      this.contextMenuSelectionBeforePointer = null
      this.contextMenuPreservesRenderedSelection =
        event.target instanceof Node &&
        this.renderedSemanticSelection?.contains(event.target) === true &&
        this.renderedSemanticSelectionText() != null
      if (this.contextMenuPreservesRenderedSelection) {
        // Chromium otherwise collapses a native rendered selection to the
        // word under a secondary press before the contextmenu event opens.
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (
        this.documentKind === "markdown" &&
        tableCellRangeSelectionContainsCoordinates(
          this.view,
          event.clientX,
          event.clientY
        )
      ) {
        event.preventDefault()
        return
      }
      const position = this.view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
      })
      const selection = this.view.state.selection.main
      if (
        position != null &&
        !selection.empty &&
        position >= selection.from &&
        position <= selection.to
      ) {
        this.contextMenuSelectionBeforePointer = this.view.state.selection
      }
      return
    }
    this.contextMenuSelectionBeforePointer = null
    this.contextMenuPreservesRenderedSelection = false
    if (event.button !== 0) return
    this.clearPendingPointerMove()
    this.updatePointerState({
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    })
    this.clearLinkTooltip()
    this.semanticPointerSelection = null
    this.cancelSemanticPointerGesture()
    this.cancelScrollAnchorRestore()
    if (this.openLinkFromMouse(event)) return
    if (this.documentKind === "markdown" && event.target instanceof Element) {
      const interactiveWidget = event.target.closest(
        ".cm-md-task-checkbox, .cm-md-callout-toggle, .cm-md-code-tool, .cm-md-heading-anchor, .cm-md-html-block summary"
      )
      const footnoteNavigation = event.target.closest(
        ".cm-md-footnote-navigation, button.cm-md-footnote-definition-label"
      )
      if (
        interactiveWidget ||
        (footnoteNavigation && this.openLinkModifierPressed(event))
      ) {
        return
      }
    }
    if (
      event.target === this.view.scrollDOM &&
      pointHitsScrollbar(this.view.scrollDOM, event.clientX, event.clientY)
    ) {
      return
    }

    if (
      this.documentKind === "markdown" &&
      this.mode === "live" &&
      !this.readOnly &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.target instanceof Element
    ) {
      const position = this.view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
      })
      const semantic =
        position == null
          ? null
          : semanticPreviewSelectionAtPointer(
              this.view,
              event.target,
              position,
              { x: event.clientX, y: event.clientY }
            )
      if (semantic) {
        const pointerScroll = {
          scrollLeft: this.view.scrollDOM.scrollLeft,
          scrollTop: this.view.scrollDOM.scrollTop,
        }
        this.beginSemanticPointerGesture(
          event,
          semantic,
          position,
          pointerScroll
        )
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (this.clickIsInTextLane(event)) {
      if (
        this.documentKind === "markdown" &&
        this.mode === "live" &&
        !this.readOnly &&
        event.detail === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const startPosition = this.sourceLinePositionAtPointer(event)
        this.beginSemanticPointerGesture(event, null, startPosition, {
          scrollLeft: this.view.scrollDOM.scrollLeft,
          scrollTop: this.view.scrollDOM.scrollTop,
        })
      }
      // Let CodeMirror resolve the pointer to a document position before the
      // caret facet can switch a rendered callout into its raw editing state.
      // Reconfiguring during capture would remove the clicked DOM from under
      // CodeMirror and leave the old selection in place.
      this.showCaretAfterMouseDown(
        event.target instanceof Element &&
          event.target.closest(".cm-md-table-cell") != null
      )
      return
    }

    this.dismissEditing()

    // Only horizontal padding/margins dismiss the caret. Vertical whitespace
    // stays part of the editing lane so CodeMirror can map it to the nearest
    // document position like other text editors do.
    event.preventDefault()
    event.stopPropagation()
  }

  private openLinkFromMouse(event: MouseEvent) {
    if (
      this.documentKind !== "markdown" ||
      this.mode !== "live" ||
      !this.openLinkModifierPressed(event)
    ) {
      return false
    }

    const position = this.view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    })
    const activation =
      (event.target instanceof Element
        ? this.headingLinkActivationForElement(event.target)
        : null) ??
      (position == null
        ? null
        : markdownLinkActivationAt(this.view.state, position))
    if (!activation) return false

    if (activation.kind === "fragment") {
      event.preventDefault()
      event.stopPropagation()
      if (activation.fragment) this.jumpToHeading(activation.fragment)
      else this.jumpToFragment("#")
      return true
    }
    if (!this.openLink) return false

    event.preventDefault()
    event.stopPropagation()
    void Promise.resolve(this.openLink(activation)).catch((error: unknown) => {
      console.error("Failed to open link", error)
    })
    return true
  }

  private applyMode(mode: MarkdownEditorMode) {
    const resolvedMode = this.modeForDocumentKind(mode)
    if (resolvedMode === this.mode || this.destroyed) return
    this.resetSemanticPointerInteraction()
    const anchor = this.captureScrollAnchor()
    const scrollSnapshot = this.view.scrollSnapshot()
    const sourceSelection = this.view.state.selection
    this.clearLinkTooltip()
    this.mode = resolvedMode
    this.view.dispatch({
      selection:
        resolvedMode === "live" && sourceSelection.ranges.length > 1
          ? EditorSelection.single(
              sourceSelection.main.anchor,
              sourceSelection.main.head
            )
          : undefined,
      effects: [
        this.presentation.reconfigure(
          this.presentationExtension(this.documentKind, resolvedMode)
        ),
        this.indentation.reconfigure(
          indentUnit.of(this.indentUnitFor(resolvedMode))
        ),
        scrollSnapshot,
        EditorView.announce.of(
          resolvedMode === "live" ? "Rendered Markdown" : "Raw Markdown"
        ),
      ],
    })
    requestContentGeometryRefresh(this.view)
    this.startScrollAnchorRestore(anchor)
    this.onModeChange?.(resolvedMode)
  }

  private captureScrollAnchor(): ScrollAnchor {
    const selection = this.view.state.selection.main
    const selectionPos = selection.head
    const scrollRect = this.view.scrollDOM.getBoundingClientRect()
    const selectionCoordinates = this.scrollAnchorCoordinates(
      this.view,
      selectionPos,
      selection.assoc
    )
    const cursorVisible =
      selectionCoordinates != null &&
      selectionCoordinates.bottom >= scrollRect.top &&
      selectionCoordinates.top <= scrollRect.bottom

    let pos = selectionPos
    let assoc = selection.assoc
    if (!cursorVisible) {
      pos =
        this.view.posAtCoords(
          {
            x: scrollRect.left + scrollRect.width / 2,
            y: scrollRect.top + scrollRect.height / 2,
          },
          false
        ) ?? Math.floor((this.view.viewport.from + this.view.viewport.to) / 2)
      assoc = 0
    }

    const coordinates = cursorVisible
      ? selectionCoordinates
      : this.scrollAnchorCoordinates(this.view, pos, assoc)
    return {
      assoc,
      pos,
      screenOffset: coordinates
        ? coordinates.top - scrollRect.top
        : scrollRect.height / 2,
      scrollLeft: this.view.scrollDOM.scrollLeft,
    }
  }

  private navigationPosition() {
    const scrollRect = this.view.scrollDOM.getBoundingClientRect()
    const selection = this.view.state.selection.main
    const selectionPosition = selection.head
    const selectionCoordinates = this.scrollAnchorCoordinates(
      this.view,
      selectionPosition,
      selection.assoc
    )
    if (
      this.view.hasFocus &&
      selectionCoordinates &&
      selectionCoordinates.bottom >= scrollRect.top &&
      selectionCoordinates.top <= scrollRect.bottom
    ) {
      return selectionPosition
    }
    return (
      this.view.posAtCoords(
        {
          x: scrollRect.left + scrollRect.width / 2,
          y: scrollRect.top + this.navigationTopMargin(),
        },
        false
      ) ?? this.view.viewport.from
    )
  }

  private navigationTopMargin() {
    if (!this.ownerWindow) return 12
    const value = Number.parseFloat(
      this.ownerWindow
        .getComputedStyle(this.ownerWindow.document.documentElement)
        .getPropertyValue("--window-chrome-height")
    )
    return (Number.isFinite(value) ? value : 40) + 12
  }

  private restoreScrollAnchor(anchor: ScrollAnchor) {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const coordinates = this.scrollAnchorCoordinates(
          view,
          anchor.pos,
          anchor.assoc ?? 0
        )
        if (!coordinates) return null
        return (
          coordinates.top -
          view.scrollDOM.getBoundingClientRect().top -
          anchor.screenOffset
        )
      },
      write: (delta, view) => {
        if (this.pendingScrollAnchor !== anchor) return
        view.scrollDOM.scrollLeft = anchor.scrollLeft
        if (delta == null) {
          this.anchorRestoreAttempts += 1
          if (this.anchorRestoreAttempts >= 5) {
            this.pendingScrollAnchor = null
          } else {
            this.queueScrollAnchorRestore(anchor)
          }
          return
        }
        if (Math.abs(delta) <= 0.5) {
          this.pendingScrollAnchor = null
          return
        }

        view.scrollDOM.scrollTop += delta
        this.anchorRestoreAttempts += 1
        if (this.anchorRestoreAttempts >= 5) {
          this.pendingScrollAnchor = null
        } else {
          this.queueScrollAnchorRestore(anchor)
        }
      },
    })
  }

  private scrollAnchorCoordinates(
    view: EditorView,
    position: number,
    assoc: -1 | 0 | 1
  ) {
    const coordinates = view.coordsAtPos(
      position,
      assoc === 0 ? undefined : assoc
    )
    if (
      !coordinates ||
      (coordinates.left === 0 &&
        coordinates.right === 0 &&
        coordinates.top === 0 &&
        coordinates.bottom === 0)
    ) {
      return null
    }
    return coordinates
  }

  private startScrollAnchorRestore(anchor: ScrollAnchor) {
    this.pendingScrollAnchor = anchor
    this.anchorRestoreAttempts = 0
    this.queueScrollAnchorRestore(anchor)
  }

  private readonly cancelScrollAnchorRestore = () => {
    this.cancelSemanticScrollRestore()
    this.pendingScrollAnchor = null
    if (this.anchorFrame == null) return
    this.ownerWindow?.cancelAnimationFrame(this.anchorFrame)
    this.anchorFrame = null
  }

  private readonly handleEditorWheel = () => {
    this.semanticPointerSelection = null
    const gesture = this.semanticPointerGesture
    if (gesture?.origin?.dragSelection === "rendered") {
      // Wheel-assisted native selection is still clamped and claimed on
      // pointerup. Treat the wheel as drag intent so a stationary release can
      // never turn into source-opening click activation.
      gesture.dragged = true
    } else if (
      gesture ||
      this.semanticBoundaryFrame != null ||
      this.semanticBoundaryPointerFrame != null
    ) {
      // Non-rendered semantic gestures cannot own a native DOM selection.
      // Cancel them completely instead of leaving a partial browser range.
      this.cancelSemanticPointerGesture(true)
    }
    this.cancelScrollAnchorRestore()
  }

  private queueScrollAnchorRestore(anchor: ScrollAnchor) {
    if (this.destroyed || this.pendingScrollAnchor !== anchor) return
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    if (!ownerWindow) {
      this.restoreScrollAnchor(anchor)
      return
    }
    if (this.anchorFrame != null)
      ownerWindow.cancelAnimationFrame(this.anchorFrame)
    this.anchorFrame = ownerWindow.requestAnimationFrame(() => {
      this.anchorFrame = null
      if (!this.destroyed && this.pendingScrollAnchor === anchor)
        this.restoreScrollAnchor(anchor)
    })
  }

  private validateMaxContentWidth(width: number | undefined) {
    if (width == null) return undefined
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError("maxContentWidth must be a positive finite number")
    }
    return width
  }

  private validateSourceIndentSize(size: number) {
    if (
      !Number.isInteger(size) ||
      size < MIN_SOURCE_INDENT_SIZE ||
      size > MAX_SOURCE_INDENT_SIZE
    ) {
      throw new RangeError(
        `sourceIndentSize must be an integer from ${MIN_SOURCE_INDENT_SIZE} to ${MAX_SOURCE_INDENT_SIZE}`
      )
    }
    return size
  }

  private validateSourceIndentation(indentation: SourceIndentation) {
    if (indentation !== "spaces" && indentation !== "tabs") {
      throw new TypeError("sourceIndentation must be spaces or tabs")
    }
    return indentation
  }

  private readonly dispatchTransactions = (
    transactions: readonly Transaction[],
    view: EditorView
  ) => {
    const finalState = transactions.at(-1)?.state
    const restoresHistorySelection = transactions.some(
      (transaction) =>
        transaction.isUserEvent("undo") ||
        transaction.isUserEvent("redo") ||
        transaction.isUserEvent("select.undo") ||
        transaction.isUserEvent("select.redo")
    )
    if (
      this.mode !== "live" ||
      !restoresHistorySelection ||
      !finalState ||
      finalState.selection.ranges.length === 1
    ) {
      view.update(transactions)
      return
    }

    const normalizedSelection = finalState.update({
      selection: finalState.selection.asSingle(),
      annotations: Transaction.addToHistory.of(false),
    })
    view.update([...transactions, normalizedSelection])
  }

  private openLinkModifierPressed(
    event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  ) {
    const primary = this.platform === "darwin" ? event.metaKey : event.ctrlKey
    return primary && !event.altKey && !event.shiftKey
  }

  private readonly handleOpenLinkModifierChange = (event: KeyboardEvent) => {
    const active =
      this.documentKind === "markdown" && this.openLinkModifierPressed(event)
    this.view.dom.classList.toggle(openLinkModifierClass, active)
    if (active === this.openLinkModifierActive) return
    this.openLinkModifierActive = active
    this.publishLinkTooltip()
  }

  private readonly handleWindowBlur = () => {
    this.cancelPendingCaretActivation()
    this.cancelSemanticPointerGesture()
    this.view.dom.classList.remove(openLinkModifierClass)
    if (this.openLinkModifierActive) {
      this.openLinkModifierActive = false
      this.publishLinkTooltip()
    }
  }

  private readonly handleFontLoadingDone = () => {
    if (!this.destroyed) this.refreshContentGeometry(true)
  }

  private readonly handleCompositionStart = () => {
    this.showCaret()
  }

  private readonly handleCompositionEnd = () => {
    const pendingMode = this.pendingMode
    if (!pendingMode || this.destroyed) return
    this.pendingMode = null

    const ownerWindow = this.view.dom.ownerDocument.defaultView
    const apply = () => {
      this.modeFrame = null
      if (!this.destroyed && pendingMode !== this.mode)
        this.applyMode(pendingMode)
    }
    this.modeFrame = ownerWindow?.requestAnimationFrame(apply) ?? null
    if (this.modeFrame == null) apply()
  }
}
