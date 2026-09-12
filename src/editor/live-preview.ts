import { syntaxTree } from "@codemirror/language"
import {
  countColumn,
  type ChangeDesc,
  EditorSelection,
  Facet,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  EditorState,
  type Line,
  type Range,
  type SelectionRange,
  type Text,
} from "@codemirror/state"
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common"
import {
  BlockWrapper,
  Decoration,
  Direction,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  type MouseSelectionStyle,
} from "@codemirror/view"

import {
  calloutBlockExtension,
  calloutEditingRange,
  isCalloutBlockquote,
  isCalloutHeaderMarker,
  type CalloutEditingRange,
} from "./callout-blocks"
import {
  codeBlockExtension,
  type CodeBlockExtensionOptions,
} from "./code-blocks"
import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  interactivePreviewWidgetSelector,
  livePreviewRefreshRequested,
  nearbyPreviewPositions,
  preservePreviewDuringPointerSelection,
  previewPositionAtDOM,
  queuePreviewRebuild,
  refreshLivePreview,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"
import {
  changedMarkdownLinkReferenceRanges,
  decodeMarkdownCharacterReferences,
  markdownLinkReferenceBlocks,
  markdownLinkReferenceIndexExtension,
  resolveMarkdownLinkNode,
  type MarkdownLinkReferenceBlock,
  type MarkdownLinkReferenceRange,
} from "./link-semantics"
import {
  definitionListSyntaxForList,
  type DefinitionListSyntax,
} from "./markdown-extensions"
import { parsePotentialOrderedListMarker } from "./list-markers"
import {
  tableCellRangeSelectionExtension,
  tableCellRangeSelectionState,
  tableSegments,
} from "./table-selection"
import {
  markdownDocumentPath,
  markdownImageSourceIsRemote,
  markdownRemoteImagesEnabled,
  resolveMarkdownImageSource,
} from "./media"
import {
  inlineCodeNormalization,
  inlineCodeNormalizationExtension,
  inlineCodeReplacementDecoration,
  MarkdownTextWidget,
} from "./inline-code"
import { nestedHorizontalSelectionScrollExtension } from "./nested-horizontal-scroll"
import { sourceLinePointerPosition } from "./semantic-preview-selection"

export {
  markdownLinkActivationAt,
  markdownLinkTargetAt,
} from "./link-semantics"

export { refreshLivePreview } from "./interactive-preview"
export const hiddenMarkdownCaretClass = "cm-md-caret-hidden"
export const livePreviewSelectionActive = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
})
export const setLivePreviewEditorFocused = StateEffect.define<boolean>()
export const setLivePreviewFocusRetained = StateEffect.define<boolean>()
const livePreviewEditorFocused = StateField.define<boolean>({
  create: () => false,
  update: (focused, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setLivePreviewEditorFocused)) focused = effect.value
    }
    return focused
  },
})
const livePreviewFocusRetained = StateField.define<boolean>({
  create: () => false,
  update: (retained, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setLivePreviewFocusRetained)) retained = effect.value
    }
    return retained
  },
})

interface YamlFrontMatterWrapperIndex {
  readonly tree: Tree
  readonly wrappers: RangeSet<BlockWrapper>
}

function yamlFrontMatterWrappers(tree: Tree) {
  const frontMatter = tree.topNode.firstChild
  return BlockWrapper.set(
    frontMatter?.name === "YAMLFrontMatter"
      ? [
          BlockWrapper.create({
            tagName: "div",
            attributes: { class: "cm-md-yaml-frontmatter" },
          }).range(frontMatter.from, frontMatter.to),
        ]
      : []
  )
}

function yamlFrontMatterWrapperIndex(tree: Tree): YamlFrontMatterWrapperIndex {
  return { tree, wrappers: yamlFrontMatterWrappers(tree) }
}

const yamlFrontMatterWrapperState =
  StateField.define<YamlFrontMatterWrapperIndex>({
    create(state) {
      return yamlFrontMatterWrapperIndex(completeMarkdownSyntaxTree(state))
    },
    update(value, transaction) {
      const publishedSyntaxChanged =
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      if (
        !transaction.docChanged &&
        !transaction.reconfigured &&
        !publishedSyntaxChanged
      ) {
        return value
      }
      const tree = transaction.docChanged
        ? updateCompleteMarkdownSyntaxTree(
            transaction.state,
            transaction.changes,
            value.tree
          )
        : completeMarkdownSyntaxTree(transaction.state)
      return yamlFrontMatterWrapperIndex(tree)
    },
    provide: (field) =>
      EditorView.blockWrappers.from(field, (value) => value.wrappers),
  })

export function livePreviewSelectionIsActive(state: EditorState) {
  return (
    (state.field(livePreviewEditorFocused) ||
      state.field(livePreviewFocusRetained)) &&
    state.facet(livePreviewSelectionActive)
  )
}

/** Tracks content focus outside the dynamically reconfigured presentation. */
export const livePreviewFocusTrackingExtension: Extension = [
  livePreviewEditorFocused,
  livePreviewFocusRetained,
  EditorView.focusChangeEffect.of((_state, focusing) =>
    setLivePreviewEditorFocused.of(focusing)
  ),
  EditorState.transactionFilter.of(normalizeTaskSelectionTransaction),
]

const hiddenDelimiter = Decoration.replace({ markdownPreviewKind: "delimiter" })
const hiddenUrl = Decoration.replace({ markdownPreviewKind: "url" })
const hiddenLinkReference = Decoration.replace({
  inclusive: false,
  markdownPreviewKind: "link-reference",
})

const strongMark = Decoration.mark({ tagName: "strong", class: "cm-md-strong" })
const emphasisMark = Decoration.mark({ tagName: "em", class: "cm-md-emphasis" })
const strikethroughMark = Decoration.mark({
  tagName: "s",
  class: "cm-md-strikethrough",
})
const superscriptMark = Decoration.mark({
  tagName: "sup",
  class: "cm-md-superscript",
})
const subscriptMark = Decoration.mark({
  tagName: "sub",
  class: "cm-md-subscript",
})
const inlineCodeMark = Decoration.mark({
  tagName: "code",
  class: "cm-md-inline-code",
})
const linkMark = Decoration.mark({ class: "cm-md-link", inclusive: true })
const webLinkMark = Decoration.mark({
  class: "cm-md-link cm-md-openable-link cm-md-web-link",
  inclusive: true,
})
const webLinkCursorMark = Decoration.mark({
  class: "cm-md-openable-link cm-md-web-link",
})
const tableCellMarks = new Map<string, Decoration>()

function tableCellMark(selectionClasses: string, prose: boolean) {
  const className = [
    "cm-md-table-cell",
    prose ? "cm-md-table-cell-prose" : "",
    selectionClasses,
  ]
    .filter(Boolean)
    .join(" ")
  const key = className
  let mark = tableCellMarks.get(key)
  if (!mark) {
    mark = Decoration.mark({
      class: className,
      // A cell may consist entirely of a replacement widget (math, an image,
      // emoji, and so on). Inclusive boundaries keep equal-range widgets
      // inside the semantic grid cell instead of turning them into a stray
      // item at the far edge of the row.
      inclusive: true,
    })
    tableCellMarks.set(key, mark)
  }
  return mark
}
const hiddenHorizontalRule = Decoration.replace({
  markdownPreviewKind: "horizontal-rule",
})
function listIndentSourceMark(columns: number) {
  return Decoration.mark({
    attributes: {
      style: `--cm-md-list-current-source-indent:${columns * 0.25}em`,
    },
    bidiIsolate: Direction.LTR,
    class: "cm-md-list-indent-source",
    markdownPreviewKind: "list-indent-source",
    stableMarkdownPrefix: true,
  })
}
const yamlFrontMatterMark = Decoration.mark({
  class: "cm-md-yaml-frontmatter-mark",
})

function taskMarkerOnLine(state: EditorState, position: number) {
  const candidates: Array<{ marker: SyntaxNode; distance: number }> = []
  const line = state.doc.lineAt(position)

  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name !== "TaskMarker") return
      const candidateDistance =
        position < node.from
          ? node.from - position
          : position > node.to
            ? position - node.to
            : 0
      candidates.push({ marker: node.node, distance: candidateDistance })
    },
  })

  candidates.sort((left, right) => left.distance - right.distance)
  return candidates[0]?.marker ?? null
}

export function taskCheckboxAccessibleName(checked: boolean, taskText: string) {
  const status = checked ? "Completed task" : "Incomplete task"
  return taskText ? `${status}: ${taskText}` : status
}

function updateTaskCheckbox(
  checkbox: HTMLInputElement,
  checked: boolean,
  taskText: string
) {
  checkbox.checked = checked
  checkbox.dataset.checked = String(checked)
  checkbox.setAttribute(
    "aria-label",
    taskCheckboxAccessibleName(checked, taskText)
  )
}

function restoreTaskCheckbox(checkbox: HTMLInputElement) {
  updateTaskCheckbox(
    checkbox,
    checkbox.dataset.checked === "true",
    checkbox.dataset.taskText ?? ""
  )
}

class TaskCheckboxWidget extends WidgetType {
  readonly checked: boolean
  readonly readOnly: boolean
  readonly sourceLength: number
  readonly taskText: string

  constructor(
    checked: boolean,
    readOnly: boolean,
    sourceLength: number,
    taskText: string
  ) {
    super()
    this.checked = checked
    this.readOnly = readOnly
    this.sourceLength = sourceLength
    this.taskText = taskText
  }

  eq(other: TaskCheckboxWidget) {
    return (
      this.checked === other.checked &&
      this.readOnly === other.readOnly &&
      this.sourceLength === other.sourceLength &&
      this.taskText === other.taskText
    )
  }

  ignoreEvent() {
    return true
  }

  updateDOM(dom: HTMLElement) {
    const checkbox = dom.querySelector<HTMLInputElement>(
      ":scope > .cm-md-task-checkbox"
    )
    if (!checkbox) return false
    dom.dataset.sourceLength = String(this.sourceLength)
    checkbox.dataset.taskText = this.taskText
    updateTaskCheckbox(checkbox, this.checked, this.taskText)
    checkbox.disabled = this.readOnly
    return true
  }

  toDOM(view: EditorView) {
    const lane = view.dom.ownerDocument.createElement("span")
    lane.className = "cm-md-task-checkbox-lane"
    lane.dataset.sourceLength = String(this.sourceLength)
    const checkbox = view.dom.ownerDocument.createElement("input")
    checkbox.className = "cm-md-task-checkbox"
    checkbox.type = "checkbox"
    checkbox.dataset.taskText = this.taskText
    updateTaskCheckbox(checkbox, this.checked, this.taskText)
    checkbox.disabled = this.readOnly
    checkbox.addEventListener("change", () => {
      if (view.state.readOnly) {
        checkbox.disabled = true
        restoreTaskCheckbox(checkbox)
        return
      }
      let position: number
      try {
        position = view.posAtDOM(checkbox)
      } catch {
        restoreTaskCheckbox(checkbox)
        return
      }

      const marker = taskMarkerOnLine(view.state, position)
      if (!marker) {
        restoreTaskCheckbox(checkbox)
        return
      }

      const source = view.state.sliceDoc(marker.from, marker.to)
      if (!/^\[[ xX]\]$/.test(source)) {
        restoreTaskCheckbox(checkbox)
        return
      }

      const checked = checkbox.checked
      if (/[xX]/.test(source) === checked) {
        updateTaskCheckbox(checkbox, checked, this.taskText)
        return
      }

      view.dispatch({
        changes: {
          from: marker.from + 1,
          to: marker.from + 2,
          insert: checked ? "x" : " ",
        },
      })
      updateTaskCheckbox(checkbox, checked, this.taskText)
    })
    lane.append(checkbox)
    return lane
  }
}

class MarkdownImageWidget extends WidgetType {
  readonly source: string
  readonly alt: readonly MarkdownImageAltPart[]
  readonly title: string | null
  readonly loadSource: boolean

  constructor(
    source: string,
    alt: readonly MarkdownImageAltPart[],
    title: string | null,
    loadSource: boolean
  ) {
    super()
    this.source = source
    this.alt = alt
    this.title = title
    this.loadSource = loadSource
  }

  eq(other: MarkdownImageWidget) {
    return (
      this.source === other.source &&
      this.title === other.title &&
      this.loadSource === other.loadSource &&
      imageAltPartsEqual(this.alt, other.alt)
    )
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const image = view.dom.ownerDocument.createElement("img")
    image.className = "cm-md-image"
    if (this.loadSource) image.src = this.source
    else image.dataset.remoteSourcePending = "true"
    image.alt = renderedImageAlt(view.dom.ownerDocument, this.alt)
    if (this.title) image.title = this.title
    image.decoding = "async"
    image.referrerPolicy = "no-referrer"
    image.draggable = false
    const requestMeasure = () => {
      if (image.isConnected) view.requestMeasure()
    }
    image.addEventListener("load", requestMeasure, { once: true })
    image.addEventListener("error", requestMeasure, { once: true })
    return image
  }
}

class HeadingAnchorWidget extends WidgetType {
  readonly headingFrom: number

  constructor(headingFrom: number) {
    super()
    this.headingFrom = headingFrom
  }

  eq(other: HeadingAnchorWidget) {
    return this.headingFrom === other.headingFrom
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const ownerDocument = view.dom.ownerDocument
    const anchor = ownerDocument.createElement("button")
    anchor.type = "button"
    anchor.className = "cm-md-heading-anchor"
    anchor.dataset.markdownHeadingFrom = String(this.headingFrom)
    anchor.dataset.markdownLinkTitle = "Heading link"
    anchor.setAttribute("aria-label", "Link to heading")
    anchor.setAttribute("contenteditable", "false")
    const openHeadingLinkMenu = () => {
      const bounds = anchor.getBoundingClientRect()
      anchor.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          detail: 0,
          view: ownerDocument.defaultView ?? undefined,
        })
      )
    }
    anchor.addEventListener("click", (event) => {
      // A programmatic/native keyboard click has no pointer detail. Pointer
      // gestures retain their established selection/modifier behavior.
      if (event.detail !== 0) return
      event.preventDefault()
      event.stopPropagation()
      openHeadingLinkMenu()
    })
    anchor.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return
      // CodeMirror owns editor key events and suppresses the browser's native
      // button click, so consume these two ordinary button activations at the
      // widget before they bubble into the editor keymap.
      event.preventDefault()
      event.stopPropagation()
      openHeadingLinkMenu()
    })

    const svg = ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    )
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("fill", "none")
    svg.setAttribute("stroke", "currentColor")
    svg.setAttribute("stroke-linecap", "round")
    svg.setAttribute("stroke-linejoin", "round")
    svg.setAttribute("stroke-width", "2")
    svg.setAttribute("viewBox", "0 0 24 24")
    const firstLink = ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    )
    firstLink.setAttribute(
      "d",
      "M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.9 5.03"
    )
    const secondLink = ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    )
    secondLink.setAttribute(
      "d",
      "M14 11a5 5 0 0 0-7.07 0l-2.12 2.12a5 5 0 0 0 7.07 7.07l1.18-1.18"
    )
    svg.append(firstLink, secondLink)
    anchor.append(svg)
    return anchor
  }
}

interface MarkdownImageAltPart {
  readonly entity: boolean
  readonly text: string
}

function imageAltPartsEqual(
  left: readonly MarkdownImageAltPart[],
  right: readonly MarkdownImageAltPart[]
) {
  return (
    left.length === right.length &&
    left.every(
      (part, index) =>
        part.entity === right[index]?.entity && part.text === right[index]?.text
    )
  )
}

function renderedImageAlt(
  ownerDocument: Document,
  parts: readonly MarkdownImageAltPart[]
) {
  const decoder = ownerDocument.createElement("textarea")
  return parts
    .map((part) => {
      if (!part.entity) return part.text
      decoder.innerHTML = part.text
      return decoder.value
    })
    .join("")
}

const unorderedListMarkers = ["•", "◦", "▪"] as const
const listIndentPerDepthRem = 1.5
const listMarkerSeparatorLaneEm = 0.25
const taskCheckboxLane = "1.4rem"

function orderedListMarkerLaneEm(source: string) {
  let width = listMarkerSeparatorLaneEm
  for (const character of source) {
    width += /[mwMW@%&]/.test(character)
      ? 1
      : /[A-Z]/.test(character)
        ? 0.8
        : /[0-9]/.test(character)
          ? 0.65
          : /[ilIjtfr]/.test(character)
            ? 0.4
            : /[a-z]/.test(character)
              ? 0.62
              : 0.45
  }
  return Math.max(1.25, width)
}

function orderedListMarkerLane(
  context: BuildContext,
  marker: SyntaxNode,
  source: string
) {
  const list = marker.parent?.parent
  if (list?.name !== "OrderedList") {
    return `${orderedListMarkerLaneEm(source)}em`
  }
  const cached = context.orderedListMarkerLanes?.get(list.from)
  if (cached) return cached

  let width = orderedListMarkerLaneEm(source)
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== "ListItem") continue
    const siblingMarker = item.getChild("ListMark")
    if (!siblingMarker) continue
    const siblingSource = context.state
      .sliceDoc(siblingMarker.from, siblingMarker.to)
      .trim()
    if (parsePotentialOrderedListMarker(siblingSource) == null) continue
    width = Math.max(width, orderedListMarkerLaneEm(siblingSource))
  }
  const lane = `${width}em`
  context.orderedListMarkerLanes?.set(list.from, lane)
  return lane
}

function listMarkerLineStyle(depth: number, totalPrefixLane: string) {
  const textColumn = depth * listIndentPerDepthRem
  return [
    `--cm-md-list-total-prefix-lane:${totalPrefixLane}`,
    `--cm-md-list-hanging-indent:${textColumn}rem`,
    `--cm-md-list-first-line-indent:calc(0px - var(--cm-md-list-total-prefix-lane))`,
  ].join(";")
}

function listMarkerSeparatorMark(source: string) {
  const sourceUnits = Math.max(1, source.length)
  const unitAdvance = listMarkerSeparatorLaneEm / sourceUnits
  return Decoration.mark({
    bidiIsolate: Direction.LTR,
    class: "cm-md-list-marker-separator-source",
    attributes: {
      style: `--cm-md-list-marker-separator-unit:${unitAdvance}em`,
    },
    markdownPreviewKind: "list-marker-separator-source",
    stableMarkdownPrefix: true,
  })
}

function listQuotePrefixSourceMark(
  columns: number,
  rendered: boolean,
  flowsInPrefix = false
) {
  const cellWidthEm = 0.5
  return Decoration.mark({
    class: [
      "cm-md-list-quote-prefix-source",
      flowsInPrefix ? "cm-md-list-quote-prefix-flow" : "",
      rendered ? "cm-md-list-quote-prefix-rendered" : "",
    ]
      .filter(Boolean)
      .join(" "),
    attributes: {
      style: [
        `--cm-md-list-quote-cell:${cellWidthEm}em`,
        `--cm-md-list-quote-prefix-width:${columns * cellWidthEm}em`,
      ].join(";"),
    },
    bidiIsolate: Direction.LTR,
    markdownPreviewKind: "list-quote-prefix",
    stableMarkdownPrefix: true,
  })
}

const definitionMarkerLaneEm = 1.1

function definitionMarkerSourceMark(rendered: boolean) {
  return Decoration.mark({
    bidiIsolate: Direction.LTR,
    class: [
      "cm-md-definition-source-mark",
      rendered ? "cm-md-definition-prefix-rendered" : "",
    ]
      .filter(Boolean)
      .join(" "),
    markdownPreviewKind: "definition-source-mark",
    stableMarkdownPrefix: true,
  })
}

function definitionSeparatorSourceMark(source: string) {
  const unitAdvance = listMarkerSeparatorLaneEm / Math.max(1, source.length)
  return Decoration.mark({
    bidiIsolate: Direction.LTR,
    class: "cm-md-definition-separator-source",
    attributes: {
      style: `--cm-md-definition-separator-unit:${unitAdvance}em`,
    },
    markdownPreviewKind: "definition-separator-source",
    stableMarkdownPrefix: true,
  })
}

function definitionIndentSourceMark(columns: number) {
  return Decoration.mark({
    bidiIsolate: Direction.LTR,
    class: "cm-md-definition-indent-source",
    attributes: {
      style: `--cm-md-definition-source-indent:${columns * 0.25}em`,
    },
    markdownPreviewKind: "definition-indent-source",
    stableMarkdownPrefix: true,
  })
}

function listMarkerSourceMark(
  label: string,
  markerDepth: number,
  unordered: boolean,
  rendered: boolean,
  markerLane: string
) {
  // Ordinary list prefixes must keep one DOM position per source offset.
  // Painting over an authored marker is safe; replacing it would collapse
  // cursor motion and click hit-testing onto the replacement's two edges.
  return Decoration.mark({
    class: [
      "cm-md-list-marker-source",
      unordered ? "cm-md-list-marker-unordered" : "cm-md-list-marker-ordered",
      unordered ? `cm-md-list-marker-depth-${((markerDepth - 1) % 3) + 1}` : "",
      rendered ? "cm-md-list-marker-rendered" : "",
    ]
      .filter(Boolean)
      .join(" "),
    attributes: {
      "data-list-marker": label,
      style: `--cm-md-list-current-marker-lane:${markerLane}`,
    },
    bidiIsolate: Direction.LTR,
    markdownPreviewKind: "list-marker",
    stableMarkdownPrefix: true,
  })
}

function listDepth(node: SyntaxNode) {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") {
      depth += 1
    }
  }
  return Math.max(1, depth)
}

function unorderedListMarkerDepth(node: SyntaxNode) {
  let depth = 1
  let item = node.parent

  while (item?.name === "ListItem") {
    const list = item.parent
    const ancestorItem = list?.parent
    if (
      list?.name !== "BulletList" ||
      ancestorItem?.name !== "ListItem" ||
      ancestorItem.parent?.name !== "BulletList" ||
      ancestorItem.getChild("Task") != null
    ) {
      break
    }
    depth += 1
    item = ancestorItem
  }

  return depth
}

const tableAtomicRange = Decoration.mark({})

interface TableCellLayout {
  prose: boolean
}

interface TableLayoutSegment {
  content: { from: number; to: number } | null
  from: number
  to: number
}

function tableSegmentPaddingRanges(segment: TableLayoutSegment) {
  if (!segment.content) return []
  return [
    { from: segment.from, to: segment.content.from },
    { from: segment.content.to, to: segment.to },
  ].filter((range) => range.from < range.to)
}

interface TableLayoutRow {
  delimiters: readonly { from: number; to: number }[]
  from: number
  kind: "header" | "row"
  prefix: { from: number; to: number } | null
  segments: readonly TableLayoutSegment[]
  to: number
}

interface TableLayout {
  atomicRanges: readonly { from: number; to: number }[]
  columnCount: number
  from: number
  rows: readonly TableLayoutRow[]
  separator: { from: number; to: number } | null
  syntaxFrom: number
  to: number
}

type RelativeTableLayout = Omit<TableLayout, "from" | "to">

class TableLayoutValue extends RangeValue {
  readonly layout: RelativeTableLayout

  constructor(layout: RelativeTableLayout) {
    super()
    this.layout = layout
  }
}

interface TableLayoutIndex {
  atomicRanges: DecorationSet
  layouts: RangeSet<TableLayoutValue>
  refreshTableRanges: readonly { from: number; to: number }[]
  tree: Tree
  wrappers: RangeSet<BlockWrapper>
}

function isRenderedTableRow(node: SyntaxNode) {
  return node.name === "TableHeader" || node.name === "TableRow"
}

function tableCellLayout(source: string): TableCellLayout {
  const normalized = source
    .replace(/<br(?:\s[^>]*)?\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const words = normalized.split(/\s+/).filter(Boolean)
  return {
    // A modest floor keeps prose columns readable without making compact
    // numeric/label columns pay the same minimum width.
    prose: normalized.length >= 48 && words.length >= 6,
  }
}

function tableLayout(table: SyntaxNode, doc: Text): TableLayout {
  const rows: SyntaxNode[] = []
  let separator: { from: number; to: number } | null = null
  let child = table.firstChild
  while (child) {
    if (isRenderedTableRow(child)) rows.push(child)
    else if (child.name === "TableDelimiter") {
      separator = {
        from: doc.lineAt(child.from).from,
        to: child.to,
      }
    }
    child = child.nextSibling
  }

  const header = rows.find((row) => row.name === "TableHeader")
  const columnCount = header ? tableSegments(header).length : 0
  const atomicRanges: { from: number; to: number }[] = []
  const layoutRows: TableLayoutRow[] = []

  if (separator && separator.from < separator.to) {
    atomicRanges.push(separator)
  }

  for (const row of rows) {
    const lineFrom = doc.lineAt(row.from).from
    const prefix = lineFrom < row.from ? { from: lineFrom, to: row.from } : null
    if (prefix) atomicRanges.push(prefix)
    const delimiters: { from: number; to: number }[] = []
    let rowChild = row.firstChild
    while (rowChild) {
      if (rowChild.name === "TableDelimiter" && rowChild.from < rowChild.to) {
        const delimiter = { from: rowChild.from, to: rowChild.to }
        delimiters.push(delimiter)
        atomicRanges.push(delimiter)
      }
      rowChild = rowChild.nextSibling
    }

    const segments: TableLayoutSegment[] = tableSegments(row).map(
      (segment) => ({
        content: segment.content
          ? { from: segment.content.from, to: segment.content.to }
          : null,
        from: segment.from,
        to: segment.to,
      })
    )
    layoutRows.push({
      delimiters,
      from: row.from,
      kind: row.name === "TableHeader" ? "header" : "row",
      prefix,
      segments,
      to: row.to,
    })
    for (const segment of segments.slice(0, columnCount)) {
      atomicRanges.push(...tableSegmentPaddingRanges(segment))
    }
    for (const segment of segments.slice(columnCount)) {
      if (segment.from < segment.to) {
        atomicRanges.push({ from: segment.from, to: segment.to })
      }
    }
  }

  return {
    atomicRanges,
    columnCount,
    from: doc.lineAt(table.from).from,
    rows: layoutRows,
    separator,
    syntaxFrom: table.from,
    to: table.to,
  }
}

function tableLayoutRefreshRanges(state: EditorState, changes: ChangeDesc) {
  const ranges: Array<{ from: number; to: number }> = []
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const first = state.doc.lineAt(fromB)
    const last = state.doc.lineAt(Math.max(fromB, toB))
    const candidate = {
      from:
        first.number > 1 ? state.doc.line(first.number - 1).from : first.from,
      to:
        last.number < state.doc.lines
          ? state.doc.line(last.number + 1).to
          : last.to,
    }
    const previous = ranges.at(-1)
    if (previous && candidate.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, candidate.to)
    } else {
      ranges.push(candidate)
    }
  })
  return ranges
}

function mergeTableRanges(ranges: readonly { from: number; to: number }[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: Array<{ from: number; to: number }> = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function relativeTableLayout(layout: TableLayout) {
  const relativeRange = (range: { from: number; to: number }) => ({
    from: range.from - layout.from,
    to: range.to - layout.from,
  })
  return new TableLayoutValue({
    atomicRanges: layout.atomicRanges.map(relativeRange),
    columnCount: layout.columnCount,
    rows: layout.rows.map((row) => ({
      ...row,
      delimiters: row.delimiters.map(relativeRange),
      from: row.from - layout.from,
      prefix: row.prefix ? relativeRange(row.prefix) : null,
      segments: row.segments.map((segment) => ({
        ...relativeRange(segment),
        content: segment.content ? relativeRange(segment.content) : null,
      })),
      to: row.to - layout.from,
    })),
    separator: layout.separator ? relativeRange(layout.separator) : null,
    syntaxFrom: layout.syntaxFrom - layout.from,
  })
}

function resolvedTableLayout(
  from: number,
  to: number,
  value: TableLayoutValue
): TableLayout {
  const absoluteRange = (range: { from: number; to: number }) => ({
    from: from + range.from,
    to: from + range.to,
  })
  return {
    atomicRanges: value.layout.atomicRanges.map(absoluteRange),
    columnCount: value.layout.columnCount,
    from,
    rows: value.layout.rows.map((row) => ({
      ...row,
      delimiters: row.delimiters.map(absoluteRange),
      from: from + row.from,
      prefix: row.prefix ? absoluteRange(row.prefix) : null,
      segments: row.segments.map((segment) => ({
        ...absoluteRange(segment),
        content: segment.content ? absoluteRange(segment.content) : null,
      })),
      to: from + row.to,
    })),
    separator: value.layout.separator
      ? absoluteRange(value.layout.separator)
      : null,
    syntaxFrom: from + value.layout.syntaxFrom,
    to,
  }
}

function tableLayoutRange(layout: TableLayout) {
  return relativeTableLayout(layout).range(layout.from, layout.to)
}

function tableAtomicDecorationRanges(layout: TableLayout) {
  return layout.atomicRanges
    .filter((range) => range.from < range.to)
    .map((range) => tableAtomicRange.range(range.from, range.to))
}

function tableWrapperRange(layout: TableLayout) {
  return BlockWrapper.create({
    tagName: "div",
    attributes: {
      class: "cm-md-table-scroll",
      style: `--cm-md-table-column-count:${layout.columnCount}`,
    },
  }).range(layout.from, layout.to)
}

interface IndexedTableLayout {
  from: number
  to: number
  value: TableLayoutValue
}

function indexedTableLayoutsBetween(
  index: TableLayoutIndex,
  from: number,
  to: number
) {
  const layouts: IndexedTableLayout[] = []
  index.layouts.between(from, to, (layoutFrom, layoutTo, value) => {
    if (layoutFrom <= to && layoutTo >= from) {
      layouts.push({ from: layoutFrom, to: layoutTo, value })
    }
  })
  return layouts.sort((left, right) => left.from - right.from)
}

function tableLayoutsBetween(
  index: TableLayoutIndex,
  from: number,
  to: number
) {
  return indexedTableLayoutsBetween(index, from, to).map(
    ({ from: layoutFrom, to: layoutTo, value }) =>
      resolvedTableLayout(layoutFrom, layoutTo, value)
  )
}

function relativeTableRowOnLine(
  table: IndexedTableLayout,
  line: { from: number; to: number }
) {
  const rows = table.value.layout.rows
  const relativeFrom = line.from - table.from
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((rows[middle]?.from ?? Number.POSITIVE_INFINITY) < relativeFrom) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const row = rows[low]
  return row && table.from + row.from <= line.to ? row : undefined
}

function resolvedTableRow(tableFrom: number, row: TableLayoutRow) {
  const absoluteRange = (range: { from: number; to: number }) => ({
    from: tableFrom + range.from,
    to: tableFrom + range.to,
  })
  return {
    ...row,
    delimiters: row.delimiters.map(absoluteRange),
    from: tableFrom + row.from,
    prefix: row.prefix ? absoluteRange(row.prefix) : null,
    segments: row.segments.map((segment) => ({
      ...absoluteRange(segment),
      content: segment.content ? absoluteRange(segment.content) : null,
    })),
    to: tableFrom + row.to,
  }
}

function tableHiddenRangesOnLine(
  table: IndexedTableLayout,
  line: { from: number; to: number }
) {
  const row = relativeTableRowOnLine(table, line)
  if (row) {
    return [
      ...(row.prefix ? [row.prefix] : []),
      ...row.delimiters,
      ...row.segments
        .slice(0, table.value.layout.columnCount)
        .flatMap(tableSegmentPaddingRanges),
      ...row.segments.slice(table.value.layout.columnCount),
    ]
      .filter((range) => range.from < range.to)
      .map((range) => ({
        from: table.from + range.from,
        to: table.from + range.to,
      }))
  }
  const separator = table.value.layout.separator
  if (
    separator &&
    table.from + separator.from <= line.to &&
    table.from + separator.to >= line.from
  ) {
    return [
      {
        from: table.from + separator.from,
        to: table.from + separator.to,
      },
    ]
  }
  return []
}

function withoutTableRanges<T extends RangeValue>(
  set: RangeSet<T>,
  ranges: readonly { from: number; to: number }[]
) {
  let filtered = set
  for (const range of ranges) {
    const filter = (from: number, to: number) =>
      from === to
        ? from < range.from || from > range.to
        : range.from === range.to
          ? to < range.from || from > range.to
          : to <= range.from || from >= range.to
    filtered =
      range.from === range.to
        ? filtered.update({ filter })
        : filtered.update({
            filter,
            filterFrom: range.from,
            filterTo: range.to,
          })
  }
  return filtered
}

function tableLayoutIndex(
  tree: Tree,
  layouts: readonly TableLayout[],
  refreshTableRanges: readonly { from: number; to: number }[] = []
): TableLayoutIndex {
  return {
    atomicRanges:
      layouts.length === 0
        ? Decoration.none
        : Decoration.set(layouts.flatMap(tableAtomicDecorationRanges), true),
    layouts: RangeSet.of(layouts.map(tableLayoutRange), true),
    refreshTableRanges,
    tree,
    wrappers: BlockWrapper.set(layouts.map(tableWrapperRange), true),
  }
}

function completeTableLayoutIndex(state: EditorState, tree: Tree) {
  const layouts: TableLayout[] = []
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return
      layouts.push(tableLayout(node.node, state.doc))
      return false
    },
  })
  return tableLayoutIndex(tree, layouts)
}

const tableLayoutState = StateField.define<TableLayoutIndex>({
  create(state) {
    const tree = completeMarkdownSyntaxTree(state)
    return completeTableLayoutIndex(state, tree)
  },
  update(value, transaction) {
    if (transaction.reconfigured) {
      const tree = completeMarkdownSyntaxTree(transaction.state)
      return completeTableLayoutIndex(transaction.state, tree)
    }
    if (!transaction.docChanged) return value

    const tree = updateCompleteMarkdownSyntaxTree(
      transaction.state,
      transaction.changes,
      value.tree
    )
    const refreshRanges = tableLayoutRefreshRanges(
      transaction.state,
      transaction.changes
    )
    let layouts = value.layouts.map(transaction.changes)
    let atomicRanges = value.atomicRanges.map(transaction.changes)
    let wrappers = value.wrappers.map(transaction.changes)
    const staleTableRanges: { from: number; to: number }[] = []
    for (const range of refreshRanges) {
      layouts.between(range.from, range.to, (from, to) => {
        if (from <= range.to && to >= range.from) {
          staleTableRanges.push({ from, to })
        }
      })
    }

    const refreshedLayouts = new Map<number, TableLayout>()
    for (const range of refreshRanges) {
      tree.iterate({
        from: range.from,
        to: range.to,
        enter(node) {
          if (node.name !== "Table") return
          const layout = tableLayout(node.node, transaction.state.doc)
          refreshedLayouts.set(layout.from, layout)
          return false
        },
      })
    }
    const replacementRanges = mergeTableRanges(staleTableRanges)
    layouts = withoutTableRanges(layouts, replacementRanges)
    atomicRanges = withoutTableRanges(atomicRanges, replacementRanges)
    wrappers = withoutTableRanges(wrappers, replacementRanges)

    const additions = [...refreshedLayouts.values()]
    if (additions.length > 0) {
      layouts = layouts.update({
        add: additions.map(tableLayoutRange),
        sort: true,
      })
      atomicRanges = atomicRanges.update({
        add: additions.flatMap(tableAtomicDecorationRanges),
        sort: true,
      })
      wrappers = wrappers.update({
        add: additions.map(tableWrapperRange),
        sort: true,
      })
    }
    return {
      atomicRanges,
      layouts,
      refreshTableRanges: mergeTableRanges([
        ...refreshRanges,
        ...replacementRanges,
        ...additions.map(({ from, to }) => ({ from, to })),
      ]),
      tree,
      wrappers,
    }
  },
  provide: (field) => [
    EditorView.blockWrappers.from(
      field,
      (value) => (view) => tablePresentationRanges(view, value.wrappers)
    ),
    EditorView.atomicRanges.from(
      field,
      (value) => (view) => tablePresentationRanges(view, value.atomicRanges)
    ),
  ],
})

function calloutSourceIsActiveAt(state: EditorState, position: number) {
  const editing = state.facet(calloutEditingRange)
  return editing != null && position >= editing.from && position <= editing.to
}

function calloutSourceOwnsSelection(state: EditorState) {
  return state.selection.ranges.some((range) =>
    calloutSourceIsActiveAt(state, range.head)
  )
}

function tablePresentationRanges<T extends RangeValue>(
  view: EditorView,
  ranges: RangeSet<T>
) {
  const editing = view.state.facet(calloutEditingRange)
  return editing ? withoutTableRanges(ranges, [editing]) : ranges
}

function normalizeTableCaretAssociation(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange
) {
  if (!range.empty) return range
  const line = state.doc.lineAt(range.head)
  for (const table of indexedTableLayoutsBetween(index, line.from, line.to)) {
    const relativeRow = relativeTableRowOnLine(table, line)
    if (!relativeRow) continue
    const row = resolvedTableRow(table.from, relativeRow)
    for (const segment of row.segments.slice(
      0,
      table.value.layout.columnCount
    )) {
      const content = segment.content
      if (!content || content.from === content.to) continue
      const association =
        range.head === content.from
          ? 1
          : range.head === content.to
            ? -1
            : range.assoc
      if (association === range.assoc) return range
      return EditorSelection.cursor(
        range.head,
        association,
        range.bidiLevel ?? undefined,
        range.goalColumn
      )
    }
  }
  return range
}

const tableSelectionAssociationFilter = EditorState.transactionFilter.of(
  (transaction) => {
    if (
      !transaction.docChanged &&
      transaction.startState.selection.eq(transaction.newSelection)
    ) {
      return transaction
    }

    const previousIndex = transaction.startState.field(tableLayoutState, false)
    const changedHiddenRanges = new Map<string, { from: number; to: number }>()
    if (transaction.docChanged && previousIndex) {
      transaction.changes.iterChangedRanges((fromA, toA) => {
        const firstLine = transaction.startState.doc.lineAt(fromA)
        const lastLine = transaction.startState.doc.lineAt(Math.max(fromA, toA))
        for (
          let lineNumber = firstLine.number;
          lineNumber <= lastLine.number;
          lineNumber += 1
        ) {
          const line = transaction.startState.doc.line(lineNumber)
          for (const table of indexedTableLayoutsBetween(
            previousIndex,
            line.from,
            line.to
          )) {
            for (const hidden of tableHiddenRangesOnLine(table, line)) {
              changedHiddenRanges.set(`${hidden.from}:${hidden.to}`, hidden)
            }
          }
        }
      })
    }

    let changed = false
    let ranges = transaction.newSelection.ranges.map((range) => {
      if (!range.empty) return range
      if (calloutSourceIsActiveAt(transaction.state, range.head)) return range
      for (const hidden of changedHiddenRanges.values()) {
        const from = transaction.changes.mapPos(hidden.from, 1)
        const to = transaction.changes.mapPos(hidden.to, -1)
        if (
          from >= to ||
          (range.head !== from && range.head !== to) ||
          transaction.startState.sliceDoc(hidden.from, hidden.to) !==
            transaction.newDoc.sliceString(from, to)
        ) {
          continue
        }

        const assoc =
          range.head === from && range.assoc >= 0
            ? -1
            : range.head === to && range.assoc <= 0
              ? 1
              : range.assoc
        if (assoc === range.assoc) return range
        changed = true
        return EditorSelection.cursor(
          range.head,
          assoc,
          range.bidiLevel ?? undefined,
          range.goalColumn
        )
      }
      return range
    })

    const nextIndex = transaction.state.field(tableLayoutState, false)
    if (nextIndex) {
      ranges = ranges.map((range) => {
        const normalized = normalizeTableCaretAssociation(
          transaction.state,
          nextIndex,
          range
        )
        if (normalized !== range) changed = true
        return normalized
      })
    }
    if (!changed) return transaction

    return [
      transaction,
      {
        selection: EditorSelection.create(
          ranges,
          transaction.newSelection.mainIndex
        ),
        sequential: true,
      },
    ]
  }
)

function verticalMotionTouchesTable(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange,
  forward: boolean
) {
  if (indexedTableLayoutsBetween(index, range.head, range.head).length > 0) {
    return true
  }

  const line = state.doc.lineAt(range.head)
  const targetLineNumber = line.number + (forward ? 1 : -1)
  if (targetLineNumber < 1 || targetLineNumber > state.doc.lines) return false
  const targetLine = state.doc.line(targetLineNumber)
  return indexedTableLayoutsBetween(index, targetLine.from, targetLine.to).some(
    (table) => relativeTableRowOnLine(table, targetLine) != null
  )
}

function normalizedTableVerticalRange(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange
) {
  const line = state.doc.lineAt(range.head)
  let table: IndexedTableLayout | undefined
  let row: TableLayoutRow | undefined
  for (const candidate of indexedTableLayoutsBetween(
    index,
    line.from,
    line.to
  )) {
    const candidateRow = relativeTableRowOnLine(candidate, line)
    if (!candidateRow) continue
    table = candidate
    row = resolvedTableRow(candidate.from, candidateRow)
    break
  }
  if (!table || !row) return range

  const renderedSegments = row.segments.slice(0, table.value.layout.columnCount)
  const inVisibleContent = renderedSegments.some(
    (segment) =>
      segment.content &&
      ((range.head > segment.content.from && range.head < segment.content.to) ||
        (range.head === segment.content.from && range.assoc >= 0) ||
        (range.head === segment.content.to && range.assoc <= 0))
  )
  const inHiddenStructure = tableHiddenRangesOnLine(table, line).some(
    (hidden) =>
      (range.head > hidden.from && range.head < hidden.to) ||
      (range.head === hidden.from && range.assoc >= 0) ||
      (range.head === hidden.to && range.assoc <= 0)
  )
  const firstRendered = renderedSegments[0]
  const lastRendered = renderedSegments.at(-1)
  const outsideRenderedCells =
    (firstRendered != null && range.head < firstRendered.from) ||
    (lastRendered != null && range.head > lastRendered.to)
  if (inVisibleContent || (!inHiddenStructure && !outsideRenderedCells)) {
    return range
  }

  const candidates = renderedSegments.flatMap((segment) => {
    const from = segment.content?.from ?? segment.from
    const to = segment.content?.to ?? segment.to
    return [
      { assoc: 1 as const, position: from },
      { assoc: -1 as const, position: to },
    ]
  })
  let closest = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (
      closest == null ||
      Math.abs(candidate.position - range.head) <
        Math.abs(closest.position - range.head)
    ) {
      closest = candidate
    }
  }
  if (
    !closest ||
    (closest.position === range.head && closest.assoc === range.assoc)
  ) {
    return range
  }
  return EditorSelection.cursor(
    closest.position,
    closest.assoc,
    range.bidiLevel ?? undefined,
    range.goalColumn
  )
}

function adjacentRenderedTableRow(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange,
  forward: boolean
) {
  const line = state.doc.lineAt(range.head)
  for (const table of indexedTableLayoutsBetween(index, line.from, line.to)) {
    const row = relativeTableRowOnLine(table, line)
    if (!row) continue
    const rowIndex = table.value.layout.rows.indexOf(row)
    const adjacent = table.value.layout.rows[rowIndex + (forward ? 1 : -1)]
    return adjacent ? resolvedTableRow(table.from, adjacent) : undefined
  }

  const targetLineNumber = line.number + (forward ? 1 : -1)
  if (targetLineNumber < 1 || targetLineNumber > state.doc.lines) {
    return undefined
  }
  const targetLine = state.doc.line(targetLineNumber)
  for (const table of indexedTableLayoutsBetween(
    index,
    targetLine.from,
    targetLine.to
  )) {
    const row = relativeTableRowOnLine(table, targetLine)
    if (row) return resolvedTableRow(table.from, row)
  }
  return undefined
}

interface TableRowAtRange {
  readonly row: TableLayoutRow
  readonly table: IndexedTableLayout
}

function renderedTableRowAtRange(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange
): TableRowAtRange | null {
  const line = state.doc.lineAt(range.head)
  for (const table of indexedTableLayoutsBetween(index, line.from, line.to)) {
    const relativeRow = relativeTableRowOnLine(table, line)
    if (!relativeRow) continue
    return {
      row: resolvedTableRow(table.from, relativeRow),
      table,
    }
  }
  return null
}

function tableCellAtRange(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange
) {
  const rowAtRange = renderedTableRowAtRange(state, index, range)
  if (!rowAtRange) return null

  const segment = rowAtRange.row.segments
    .slice(0, rowAtRange.table.value.layout.columnCount)
    .find(
      (candidate) =>
        (range.head > candidate.from && range.head < candidate.to) ||
        (range.head === candidate.from && range.assoc >= 0) ||
        (range.head === candidate.to && range.assoc <= 0)
    )
  if (!segment || range.from < segment.from || range.to > segment.to) {
    return null
  }
  return segment
}

function positionInAdjacentTableRow(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange,
  adjacentRow: TableLayoutRow
) {
  const current = renderedTableRowAtRange(state, index, range)
  let position: number
  let association: -1 | 0 | 1 = 0

  if (current) {
    const renderedSourceSegments = current.row.segments.slice(
      0,
      current.table.value.layout.columnCount
    )
    const column = renderedSourceSegments.findIndex(
      (segment) =>
        (range.head > segment.from && range.head < segment.to) ||
        (range.head === segment.from && range.assoc >= 0) ||
        (range.head === segment.to && range.assoc <= 0)
    )
    const source = renderedSourceSegments[column]
    const target = adjacentRow.segments.slice(
      0,
      current.table.value.layout.columnCount
    )[column]
    if (source && target) {
      const sourceFrom = source.content?.from ?? source.from
      const sourceTo = source.content?.to ?? source.to
      const targetFrom = target.content?.from ?? target.from
      const targetTo = target.content?.to ?? target.to
      const offset =
        range.head >= sourceTo
          ? targetTo - targetFrom
          : Math.max(0, range.head - sourceFrom)
      position = Math.min(targetTo, targetFrom + offset)
      association = position === targetFrom ? 1 : position === targetTo ? -1 : 0
      return EditorSelection.cursor(
        position,
        association,
        range.bidiLevel ?? undefined,
        range.goalColumn
      )
    }
  }

  const sourceLine = state.doc.lineAt(range.head)
  const targetLine = state.doc.lineAt(adjacentRow.from)
  position =
    targetLine.from + Math.min(range.head - sourceLine.from, targetLine.length)
  return normalizedTableVerticalRange(
    state,
    index,
    EditorSelection.cursor(
      position,
      association,
      range.bidiLevel ?? undefined,
      range.goalColumn
    )
  )
}

function scrollTableSelectionIntoView(view: EditorView, expectedHead: number) {
  view.requestMeasure({
    key: scrollTableSelectionIntoView,
    read(currentView) {
      const range = currentView.state.selection.main
      if (range.head !== expectedHead) return null
      const coordinates = currentView.coordsAtPos(
        range.head,
        range.assoc === 0 ? undefined : range.assoc
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

      for (const element of currentView.contentDOM.querySelectorAll<HTMLElement>(
        ".cm-md-table-scroll"
      )) {
        const bounds = element.getBoundingClientRect()
        if (
          coordinates.bottom < bounds.top ||
          coordinates.top > bounds.bottom
        ) {
          continue
        }
        const margin = 8
        let scrollLeft = element.scrollLeft
        if (coordinates.left < bounds.left + margin) {
          scrollLeft += coordinates.left - bounds.left - margin
        } else if (coordinates.right > bounds.right - margin) {
          scrollLeft += coordinates.right - bounds.right + margin
        } else {
          return null
        }
        return {
          element,
          scrollLeft: Math.max(
            0,
            Math.min(element.scrollWidth - element.clientWidth, scrollLeft)
          ),
        }
      }
      return null
    },
    write(measure) {
      if (measure) measure.element.scrollLeft = measure.scrollLeft
    },
  })
}

function dispatchTableMotion(view: EditorView, selection: EditorSelection) {
  const head = selection.main
  const scrollTarget = normalizedTableVerticalRange(
    view.state,
    view.state.field(tableLayoutState),
    EditorSelection.cursor(
      head.head,
      head.assoc,
      head.bidiLevel ?? undefined,
      head.goalColumn
    )
  )
  view.dispatch({
    selection,
    // A selection may intentionally include hidden Markdown padding or a
    // delimiter. Scroll its corresponding rendered cell caret into view
    // without rewriting the source selection itself.
    effects: EditorView.scrollIntoView(scrollTarget),
    userEvent: "select",
  })
}

function moveTableLine(view: EditorView, forward: boolean, extend: boolean) {
  if (calloutSourceOwnsSelection(view.state)) return false
  const index = view.state.field(tableLayoutState)
  if (
    !view.state.selection.ranges.some((range) =>
      verticalMotionTouchesTable(view.state, index, range, forward)
    )
  ) {
    return false
  }

  const selection = EditorSelection.create(
    view.state.selection.ranges.map((originalRange) => {
      if (!extend && !originalRange.empty) {
        const position = forward ? originalRange.to : originalRange.from
        const ordinary = EditorSelection.cursor(position)
        if (!renderedTableRowAtRange(view.state, index, ordinary)) {
          return ordinary
        }
        return normalizedTableVerticalRange(
          view.state,
          index,
          EditorSelection.cursor(position, forward ? -1 : 1)
        )
      }

      let range = originalRange
      if (
        extend &&
        range.undirectional &&
        range.head >= range.anchor !== forward
      ) {
        range = EditorSelection.range(range.head, range.anchor)
      }
      const normalized = normalizedTableVerticalRange(
        view.state,
        index,
        EditorSelection.cursor(
          range.head,
          range.assoc,
          range.bidiLevel ?? undefined,
          range.goalColumn
        )
      )
      const adjacentRow = adjacentRenderedTableRow(
        view.state,
        index,
        normalized,
        forward
      )
      let moved: SelectionRange
      if (adjacentRow) {
        moved = positionInAdjacentTableRow(
          view.state,
          index,
          normalized,
          adjacentRow
        )
      } else {
        const sourceLine = view.state.doc.lineAt(normalized.head)
        const targetLineNumber = sourceLine.number + (forward ? 1 : -1)
        if (targetLineNumber < 1 || targetLineNumber > view.state.doc.lines) {
          moved = normalized
        } else {
          const targetLine = view.state.doc.line(targetLineNumber)
          const targetPosition =
            targetLine.from +
            Math.min(normalized.head - sourceLine.from, targetLine.length)
          moved = normalizedTableVerticalRange(
            view.state,
            index,
            EditorSelection.cursor(
              targetPosition,
              0,
              normalized.bidiLevel ?? undefined,
              normalized.goalColumn
            )
          )
        }
      }
      if (!extend) return moved
      return EditorSelection.range(
        range.anchor,
        moved.head,
        moved.goalColumn,
        moved.bidiLevel ?? undefined,
        moved.assoc
      )
    }),
    view.state.selection.mainIndex
  )
  if (!selection.eq(view.state.selection, !extend)) {
    dispatchTableMotion(view, selection)
  }
  return true
}

function moveToNativeLineBoundary(
  view: EditorView,
  range: SelectionRange,
  forward: boolean
) {
  const line = view.lineBlockAt(range.head)
  let moved = view.moveToLineBoundary(range, forward)
  if (
    moved.head === range.head &&
    moved.head !== (forward ? line.to : line.from)
  ) {
    moved = view.moveToLineBoundary(range, forward, false)
  }
  if (!forward && moved.head === line.from && line.length > 0) {
    const indentation =
      /^\s*/.exec(
        view.state.sliceDoc(line.from, Math.min(line.from + 100, line.to))
      )?.[0].length ?? 0
    if (indentation > 0 && range.head !== line.from + indentation) {
      moved = EditorSelection.cursor(line.from + indentation)
    }
  }
  return moved
}

function moveTableRowBoundary(
  view: EditorView,
  forward: boolean,
  extend: boolean
) {
  if (calloutSourceOwnsSelection(view.state)) return false
  const index = view.state.field(tableLayoutState)
  let touchesTable = false
  const ranges = view.state.selection.ranges.map((originalRange) => {
    let range = originalRange
    if (
      extend &&
      range.undirectional &&
      range.head >= range.anchor !== forward
    ) {
      range = EditorSelection.range(range.head, range.anchor)
    }

    const rowAtRange = renderedTableRowAtRange(
      view.state,
      index,
      EditorSelection.cursor(
        range.head,
        range.assoc,
        range.bidiLevel ?? undefined,
        range.goalColumn
      )
    )
    if (!rowAtRange) {
      const moved = moveToNativeLineBoundary(view, range, forward)
      return extend
        ? EditorSelection.range(
            range.anchor,
            moved.head,
            moved.goalColumn,
            moved.bidiLevel ?? undefined,
            moved.assoc
          )
        : moved
    }

    const renderedSegments = rowAtRange.row.segments.slice(
      0,
      rowAtRange.table.value.layout.columnCount
    )
    const segment = forward ? renderedSegments.at(-1) : renderedSegments[0]
    if (!segment) return range
    touchesTable = true

    const position = forward
      ? (segment.content?.to ?? segment.to)
      : (segment.content?.from ?? segment.from)
    const association = forward ? -1 : 1
    return extend
      ? EditorSelection.range(
          range.anchor,
          position,
          undefined,
          undefined,
          association
        )
      : EditorSelection.cursor(position, association)
  })
  if (!touchesTable) return false

  const selection = EditorSelection.create(
    ranges,
    view.state.selection.mainIndex
  )
  if (!selection.eq(view.state.selection, !extend)) {
    dispatchTableMotion(view, selection)
    scrollTableSelectionIntoView(view, selection.main.head)
  }
  // A repeated platform line-boundary command must stop at the rendered
  // Markdown row edge. Falling through would let CodeMirror derive a visual
  // line from the table's CSS-grid DOM and jump to an unrelated mounted line.
  return true
}

function selectCurrentTableCell(view: EditorView) {
  if (calloutSourceOwnsSelection(view.state)) return false
  const index = view.state.field(tableLayoutState)
  const ranges = view.state.selection.ranges.map((range) => {
    const segment = tableCellAtRange(view.state, index, range)
    if (!segment) return null
    const from = segment.content?.from ?? segment.from
    const to = segment.content?.to ?? from
    return EditorSelection.range(from, to)
  })
  if (ranges.some((range) => range == null)) return false

  const selection = EditorSelection.create(
    ranges as SelectionRange[],
    view.state.selection.mainIndex
  )
  if (!selection.eq(view.state.selection)) {
    view.dispatch({
      selection,
      scrollIntoView: true,
      userEvent: "select",
    })
  }
  return true
}

function insertTableCellBreak(view: EditorView) {
  if (view.state.readOnly) return false
  if (calloutSourceOwnsSelection(view.state)) return false
  const index = view.state.field(tableLayoutState)
  if (
    !view.state.selection.ranges.every(
      (range) => tableCellAtRange(view.state, index, range) != null
    )
  ) {
    return false
  }

  view.dispatch(view.state.replaceSelection("<br>"), {
    scrollIntoView: true,
    userEvent: "input",
  })
  return true
}

const tableExitInputHandler = Prec.highest(
  EditorView.inputHandler.of((view, from, to, insertedText, insertDefault) => {
    const main = view.state.selection.main
    if (
      view.state.readOnly ||
      calloutSourceIsActiveAt(view.state, main.head) ||
      view.compositionStarted ||
      !insertedText ||
      /[\r\n]/.test(insertedText) ||
      from !== to ||
      view.state.selection.ranges.length !== 1 ||
      !main.empty ||
      main.head !== from
    ) {
      return false
    }

    const line = view.state.doc.lineAt(from)
    if (line.length !== 0 || from !== line.from || line.number === 1) {
      return false
    }

    const previousLine = view.state.doc.line(line.number - 1)
    const index = view.state.field(tableLayoutState)
    const followsTable = indexedTableLayoutsBetween(
      index,
      previousLine.from,
      previousLine.to
    ).some(
      (table) =>
        table.to === previousLine.to &&
        relativeTableRowOnLine(table, previousLine) != null
    )
    if (!followsTable) return false

    const defaultTransaction = insertDefault()
    if (!defaultTransaction.isUserEvent("input.type")) return false
    const userEvent = defaultTransaction.annotation(Transaction.userEvent)
    if (!userEvent) return false

    const insert = `\n${insertedText}`
    view.dispatch({
      changes: { from, insert },
      selection: EditorSelection.cursor(from + insert.length),
      scrollIntoView: true,
      userEvent,
    })
    return true
  })
)

const tableMultilinePasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false
    if (calloutSourceOwnsSelection(view.state)) return false
    const source = event.clipboardData?.getData("text/plain") ?? ""
    if (!/[\r\n]/.test(source)) return false

    const index = view.state.field(tableLayoutState)
    if (
      !view.state.selection.ranges.every(
        (range) => tableCellAtRange(view.state, index, range) != null
      )
    ) {
      return false
    }

    event.preventDefault()
    let replacement = ""
    let precedingBackslashes = 0
    for (const character of source) {
      if (character === "\\") {
        replacement += character
        precedingBackslashes += 1
        continue
      }
      // An odd backslash run already escapes a pipe. Add one only when the
      // pipe would otherwise remain a structural table-cell delimiter.
      if (character === "|" && precedingBackslashes % 2 === 0) {
        replacement += "\\"
      }
      replacement += character
      precedingBackslashes = 0
    }
    view.dispatch(
      view.state.replaceSelection(replacement.replace(/\r\n?|\n/g, "<br>")),
      {
        scrollIntoView: true,
        userEvent: "input.paste",
      }
    )
    return true
  },
})

function normalizedTableHorizontalRange(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange,
  forward: boolean
) {
  for (const table of indexedTableLayoutsBetween(
    index,
    range.head,
    range.head
  )) {
    const line = state.doc.lineAt(range.head)
    const hiddenRanges = tableHiddenRangesOnLine(table, line)
    let normalized = range
    // Padding and a delimiter are adjacent in conventional spaced table
    // source. Keep walking until the caret reaches semantic cell content
    // rather than stopping between two invisible atomic ranges.
    for (let step = 0; step <= hiddenRanges.length; step += 1) {
      let next = normalized
      for (const hidden of hiddenRanges) {
        if (
          (!forward &&
            ((normalized.head > hidden.from && normalized.head < hidden.to) ||
              (normalized.head === hidden.to && normalized.assoc <= 0))) ||
          (forward &&
            ((normalized.head > hidden.from && normalized.head < hidden.to) ||
              (normalized.head === hidden.from && normalized.assoc >= 0)))
        ) {
          next = EditorSelection.cursor(
            forward ? hidden.to : hidden.from,
            forward ? 1 : -1,
            normalized.bidiLevel ?? undefined,
            normalized.goalColumn
          )
          break
        }
        if (
          !forward &&
          normalized.head === hidden.from &&
          normalized.assoc >= 0
        ) {
          next = EditorSelection.cursor(
            normalized.head,
            -1,
            normalized.bidiLevel ?? undefined,
            normalized.goalColumn
          )
          break
        }
        if (forward && normalized.head === hidden.to && normalized.assoc <= 0) {
          next = EditorSelection.cursor(
            normalized.head,
            1,
            normalized.bidiLevel ?? undefined,
            normalized.goalColumn
          )
          break
        }
      }
      if (next.head === normalized.head && next.assoc === normalized.assoc) {
        break
      }
      normalized = next
    }
    return normalized
  }
  return range
}

function normalizedTableHorizontalMotion(
  view: EditorView,
  index: TableLayoutIndex,
  range: SelectionRange,
  forward: boolean,
  semanticFallback: SelectionRange
) {
  let normalized = range
  for (let step = 0; step <= view.state.doc.length; step += 1) {
    normalized = normalizedTableHorizontalRange(
      view.state,
      index,
      normalized,
      forward
    )
    if (
      tableCellAtRange(view.state, index, normalized) ||
      indexedTableLayoutsBetween(index, normalized.head, normalized.head)
        .length === 0
    ) {
      return normalized
    }

    const moved = view.moveByChar(normalized, forward)
    if (moved.eq(normalized, true)) return semanticFallback
    normalized = moved
  }
  return semanticFallback
}

function normalizedTableExtendedHorizontalRange(
  state: EditorState,
  index: TableLayoutIndex,
  range: SelectionRange,
  forward: boolean
) {
  const normalized = normalizedTableHorizontalRange(
    state,
    index,
    range,
    forward
  )
  const rowAtRange = renderedTableRowAtRange(state, index, normalized)
  if (!rowAtRange) return normalized

  const renderedSegments = rowAtRange.row.segments.slice(
    0,
    rowAtRange.table.value.layout.columnCount
  )
  const first = renderedSegments[0]
  const last = renderedSegments.at(-1)
  const firstVisible = first?.content?.from ?? first?.from
  const lastVisible = last?.content?.to ?? last?.to
  const association =
    !forward && firstVisible != null && normalized.head < firstVisible
      ? 1
      : forward && lastVisible != null && normalized.head > lastVisible
        ? -1
        : normalized.assoc
  return association === normalized.assoc
    ? normalized
    : EditorSelection.cursor(
        normalized.head,
        association,
        normalized.bidiLevel ?? undefined,
        normalized.goalColumn
      )
}

function moveTableHorizontal(
  view: EditorView,
  forward: boolean,
  extend: boolean,
  byGroup: boolean
) {
  if (calloutSourceOwnsSelection(view.state)) return false
  const index = view.state.field(tableLayoutState)
  let touchesTable = false
  const ranges = view.state.selection.ranges.map((originalRange) => {
    let range = originalRange
    if (
      extend &&
      range.undirectional &&
      range.head >= range.anchor !== forward
    ) {
      range = EditorSelection.range(range.head, range.anchor)
    }

    const motionOrigin =
      !extend && !range.empty
        ? EditorSelection.cursor(
            forward ? range.to : range.from,
            forward ? -1 : 1
          )
        : EditorSelection.cursor(
            range.head,
            range.assoc,
            range.bidiLevel ?? undefined,
            range.goalColumn
          )
    let moved =
      !extend && !range.empty
        ? motionOrigin
        : byGroup
          ? view.moveByGroup(motionOrigin, forward)
          : view.moveByChar(motionOrigin, forward)
    const rangeTouchesTable =
      indexedTableLayoutsBetween(index, range.head, range.head).length > 0 ||
      indexedTableLayoutsBetween(index, moved.head, moved.head).length > 0
    if (!rangeTouchesTable) {
      return extend
        ? EditorSelection.range(
            range.anchor,
            moved.head,
            moved.goalColumn,
            moved.bidiLevel ?? undefined,
            moved.assoc
          )
        : moved
    }

    touchesTable = true
    moved =
      extend && !byGroup
        ? normalizedTableExtendedHorizontalRange(
            view.state,
            index,
            moved,
            forward
          )
        : normalizedTableHorizontalMotion(
            view,
            index,
            moved,
            forward,
            motionOrigin
          )
    return extend
      ? EditorSelection.range(
          range.anchor,
          moved.head,
          moved.goalColumn,
          moved.bidiLevel ?? undefined,
          moved.assoc
        )
      : moved
  })
  if (!touchesTable) return false

  const selection = EditorSelection.create(
    ranges,
    view.state.selection.mainIndex
  )
  if (!selection.eq(view.state.selection, !extend)) {
    dispatchTableMotion(view, selection)
  }
  return true
}

const tableMotionKeymap = Prec.highest(
  keymap.of([
    {
      key: "ArrowLeft",
      run: (view) => moveTableHorizontal(view, false, false, false),
      shift: (view) => moveTableHorizontal(view, false, true, false),
    },
    {
      key: "ArrowRight",
      run: (view) => moveTableHorizontal(view, true, false, false),
      shift: (view) => moveTableHorizontal(view, true, true, false),
    },
    {
      key: "Mod-ArrowLeft",
      mac: "Alt-ArrowLeft",
      run: (view) => moveTableHorizontal(view, false, false, true),
      shift: (view) => moveTableHorizontal(view, false, true, true),
    },
    {
      key: "Mod-ArrowRight",
      mac: "Alt-ArrowRight",
      run: (view) => moveTableHorizontal(view, true, false, true),
      shift: (view) => moveTableHorizontal(view, true, true, true),
    },
    {
      mac: "Cmd-ArrowLeft",
      run: (view) => moveTableRowBoundary(view, false, false),
      shift: (view) => moveTableRowBoundary(view, false, true),
    },
    {
      mac: "Cmd-ArrowRight",
      run: (view) => moveTableRowBoundary(view, true, false),
      shift: (view) => moveTableRowBoundary(view, true, true),
    },
    {
      key: "Home",
      run: (view) => moveTableRowBoundary(view, false, false),
      shift: (view) => moveTableRowBoundary(view, false, true),
    },
    {
      key: "End",
      run: (view) => moveTableRowBoundary(view, true, false),
      shift: (view) => moveTableRowBoundary(view, true, true),
    },
    {
      key: "ArrowUp",
      run: (view) => moveTableLine(view, false, false),
      shift: (view) => moveTableLine(view, false, true),
    },
    {
      key: "ArrowDown",
      run: (view) => moveTableLine(view, true, false),
      shift: (view) => moveTableLine(view, true, true),
    },
    {
      key: "Mod-a",
      run: selectCurrentTableCell,
    },
    {
      key: "Shift-Enter",
      run: insertTableCellBreak,
    },
  ])
)

class TableBoundaryWidget extends WidgetType {
  private readonly className: string
  private readonly gridLine: number

  constructor(className: string, gridLine: number) {
    super()
    this.className = className
    this.gridLine = gridLine
  }

  eq(other: TableBoundaryWidget) {
    return (
      this.className === other.className && this.gridLine === other.gridLine
    )
  }

  toDOM(view: EditorView) {
    const boundary = view.dom.ownerDocument.createElement("span")
    boundary.className = this.className
    boundary.style.gridColumnStart = String(this.gridLine)
    boundary.setAttribute("aria-hidden", "true")
    return boundary
  }
}

const tableDelimiterDecorations = new Map<number, Decoration>()

function hiddenTableDelimiter(gridLine: number) {
  let decoration = tableDelimiterDecorations.get(gridLine)
  if (!decoration) {
    decoration = Decoration.replace({
      markdownPreviewKind: "delimiter",
      widget: new TableBoundaryWidget("cm-md-table-delimiter", gridLine),
    })
    tableDelimiterDecorations.set(gridLine, decoration)
  }
  return decoration
}

const hiddenTablePrefix = Decoration.replace({
  markdownPreviewKind: "table-prefix",
  widget: new TableBoundaryWidget("cm-md-table-prefix", 1),
})

const hiddenTableCellPadding = Decoration.replace({
  markdownPreviewKind: "table-cell-padding",
})

class EmptyTableCellWidget extends WidgetType {
  private readonly selectionClasses: string

  constructor(selectionClasses: string) {
    super()
    this.selectionClasses = selectionClasses
  }

  eq(other: EmptyTableCellWidget) {
    return this.selectionClasses === other.selectionClasses
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const cell = view.dom.ownerDocument.createElement("span")
    cell.className = [
      "cm-md-table-cell",
      "cm-md-table-cell-empty",
      this.selectionClasses,
    ]
      .filter(Boolean)
      .join(" ")
    cell.setAttribute("aria-hidden", "true")
    return cell
  }
}

const emptyTableCellMarks = new Map<string, Decoration>()

function emptyTableCellMark(selectionClasses: string) {
  let mark = emptyTableCellMarks.get(selectionClasses)
  if (!mark) {
    mark = Decoration.mark({
      class: ["cm-md-table-cell", "cm-md-table-cell-empty", selectionClasses]
        .filter(Boolean)
        .join(" "),
    })
    emptyTableCellMarks.set(selectionClasses, mark)
  }
  return mark
}

interface VisibleRange {
  from: number
  to: number
}

interface BuildContext {
  definitionLists: Map<number, DefinitionListSyntax | null>
  editingCallout?: SyntaxNode | null
  editingCalloutQuoteMarks?: Map<number, SyntaxNode | null>
  editingCalloutTree?: Tree | null
  editingRange: CalloutEditingRange | null
  listContinuationProjections?: Map<number, ListContinuationProjection | null>
  listLineProjections?: Map<number, ListLineProjection | null>
  listMarkerLines?: Map<number, boolean>
  listSourceBackedQuoteLines?: Set<number>
  orderedListMarkerLanes?: Map<number, string>
  state: EditorState
  ranges: Range<Decoration>[]
  seen: Set<string>
  selection?: EditorSelection
  visible: VisibleRange
  selectionActive: boolean
  stateBackedTasks?: boolean
  taskPresentationBase?: boolean
  tree?: Tree
}

function editingCalloutBlockquote(
  state: EditorState,
  tree: Tree,
  editingRange: CalloutEditingRange | null
) {
  if (!editingRange) return null
  const header = state.doc.lineAt(editingRange.from)
  for (
    let node: SyntaxNode | null = tree.resolve(
      header.to > header.from ? header.to - 1 : header.from,
      1
    );
    node;
    node = node.parent
  ) {
    if (
      node.name === "Blockquote" &&
      state.doc.lineAt(node.from).from === editingRange.from &&
      node.to === editingRange.to &&
      isCalloutBlockquote(state, node)
    ) {
      return node
    }
  }
  return null
}

function nearestBlockquote(node: SyntaxNode) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") return parent
  }
  return null
}

function editingCalloutQuoteMark(context: BuildContext, line: Line) {
  const editingCallout = context.editingCallout
  if (!editingCallout) return null
  const cached = context.editingCalloutQuoteMarks?.get(line.from)
  if (cached !== undefined) return cached

  let match: SyntaxNode | null = null
  ;(
    context.editingCalloutTree ??
    context.tree ??
    syntaxTree(context.state)
  ).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name !== "QuoteMark") return
      const owner = nearestBlockquote(node.node)
      if (
        owner?.from === editingCallout.from &&
        owner.to === editingCallout.to
      ) {
        match = node.node
      }
    },
  })
  context.editingCalloutQuoteMarks?.set(line.from, match)
  return match
}

function definitionSyntax(
  context: BuildContext,
  list: SyntaxNode | null
): DefinitionListSyntax | null {
  if (!list || list.name !== "DefinitionList") return null
  const cached = context.definitionLists.get(list.from)
  if (cached !== undefined) return cached
  const syntax = definitionListSyntaxForList(list, (from, to) =>
    context.state.sliceDoc(from, to)
  )
  context.definitionLists.set(list.from, syntax)
  return syntax
}

function followingDefinitionList(node: SyntaxNode) {
  let sibling = node.nextSibling
  while (sibling && /Mark$/.test(sibling.name)) sibling = sibling.nextSibling
  return sibling?.name === "DefinitionList" ? sibling : null
}

function selectionTouchesLinkReference(
  state: EditorState,
  block: MarkdownLinkReferenceBlock,
  selectionActive: boolean
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive &&
        range.head >= block.from &&
        range.head <= block.revealTo
      : range.from < block.to && range.to > block.from
  )
}

export function buildLinkReferencePreviewDecorations(
  state: EditorState,
  selectionActive = true
) {
  return decorationsForLinkReferenceBlocks(
    state,
    markdownLinkReferenceBlocks(state),
    selectionActive
  )
}

function decorationsForLinkReferenceBlocks(
  state: EditorState,
  blocks: readonly MarkdownLinkReferenceBlock[],
  selectionActive: boolean
) {
  const ranges = decorationRangesForLinkReferenceBlocks(
    state,
    blocks,
    selectionActive
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function decorationRangesForLinkReferenceBlocks(
  state: EditorState,
  blocks: readonly MarkdownLinkReferenceBlock[],
  selectionActive: boolean
) {
  const ranges: Range<Decoration>[] = []
  const topLevelFolds: Array<{ from: number; to: number }> = []
  for (const block of blocks) {
    if (selectionTouchesLinkReference(state, block, selectionActive)) continue
    if (!block.topLevel) {
      ranges.push(hiddenLinkReference.range(block.from, block.to))
      continue
    }
    topLevelFolds.push({
      from:
        block.to === state.doc.length && block.from > 0
          ? block.from - 1
          : block.from,
      to: block.to,
    })
  }

  const mergedTopLevelFolds: Array<{ from: number; to: number }> = []
  for (const fold of topLevelFolds) {
    const previous = mergedTopLevelFolds.at(-1)
    if (previous && fold.from < previous.to) {
      previous.to = Math.max(previous.to, fold.to)
    } else {
      mergedTopLevelFolds.push({ ...fold })
    }
  }
  for (const fold of mergedTopLevelFolds) {
    ranges.push(hiddenLinkReference.range(fold.from, fold.to))
  }
  return ranges
}

function mergeLinkReferenceRanges(
  ranges: readonly MarkdownLinkReferenceRange[]
) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: MarkdownLinkReferenceRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.from > previous.to + 1) {
      merged.push(range)
    } else {
      previous.to = Math.max(previous.to, range.to)
    }
  }
  return merged
}

function selectionLinkReferenceRanges(
  state: EditorState,
  selectionActive: boolean
) {
  const selectionQueries = state.selection.ranges.flatMap((range) => {
    if (range.empty && !selectionActive) return []
    return [{ from: range.from, to: range.to }]
  })
  if (selectionQueries.length === 0) return []
  return markdownLinkReferenceBlocks(state, selectionQueries)
    .filter((block) =>
      selectionTouchesLinkReference(state, block, selectionActive)
    )
    .map(({ from, to }) => ({ from, to }))
}

function refreshLinkReferenceDecorations(
  decorations: DecorationSet,
  state: EditorState,
  refreshRanges: readonly MarkdownLinkReferenceRange[],
  selectionActive: boolean
) {
  if (refreshRanges.length === 0) return decorations

  // Include adjacent blocks because an EOF fold consumes its preceding line
  // break, and may therefore overlap the block immediately before it.
  const queryRanges = mergeLinkReferenceRanges(
    refreshRanges.map((range) => ({
      from: Math.max(0, range.from - 1),
      to: Math.min(state.doc.length, range.to + 1),
    }))
  )
  const blocks = markdownLinkReferenceBlocks(state, queryRanges)
  const affectedRanges = mergeLinkReferenceRanges([
    ...queryRanges,
    ...blocks.map((block) => ({
      from:
        block.topLevel && block.to === state.doc.length && block.from > 0
          ? block.from - 1
          : block.from,
      to: block.to,
    })),
  ])

  let updated = decorations
  for (const range of affectedRanges) {
    updated = updated.update({
      // CodeMirror considers an exact boundary touch part of the filter
      // window. Preserve adjacent folds because affectedRanges are half-open.
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  const additions = decorationRangesForLinkReferenceBlocks(
    state,
    blocks,
    selectionActive
  )
  return additions.length > 0
    ? updated.update({ add: additions, sort: true })
    : updated
}

function selectionTouches(context: BuildContext, from: number, to: number) {
  const selection = context.selection ?? context.state.selection
  return selection.ranges.some((range) => {
    if (range.empty) {
      return context.selectionActive && range.head >= from && range.head <= to
    }
    return range.from < to && range.to > from
  })
}

function addDecoration(
  context: BuildContext,
  from: number,
  to: number,
  decoration: Decoration,
  identity: string,
  preserveDuringCalloutEditing = false
) {
  if (from > to || from < 0 || to > context.state.doc.length) return
  if (
    context.editingRange &&
    from >= context.editingRange.from &&
    to <= context.editingRange.to &&
    !preserveDuringCalloutEditing
  ) {
    return
  }
  const key = `${identity}:${from}:${to}`
  if (context.seen.has(key)) return
  context.seen.add(key)
  context.ranges.push(decoration.range(from, to))
}

function addLineDecorations(
  context: BuildContext,
  from: number,
  to: number,
  className: string
) {
  const clippedFrom = Math.max(from, context.visible.from)
  const clippedTo = Math.min(to, context.visible.to)
  if (clippedFrom > clippedTo) return

  let line = context.state.doc.lineAt(clippedFrom)
  const lastLine = context.state.doc.lineAt(
    Math.max(clippedFrom, clippedTo - 1)
  ).number

  while (line.number <= lastLine) {
    addDecoration(
      context,
      line.from,
      line.from,
      Decoration.line({ class: className }),
      `line:${className}`
    )
    if (line.number === context.state.doc.lines) break
    line = context.state.doc.line(line.number + 1)
  }
}

function quoteContainerPrefix(
  source: string,
  maximumDepth = Number.POSITIVE_INFINITY
) {
  let depth = 0
  let length = 0
  while (depth < maximumDepth && length < source.length) {
    const quote = /^[\t ]{0,3}>[\t ]?/.exec(source.slice(length))?.[0]
    if (!quote) break
    length += quote.length
    depth += 1
  }
  return { depth, length }
}

interface ListLineMarkerProjection {
  depth: number
  from: number
  isTaskItem: boolean
  lane: string
  markerDepth: number
  node: SyntaxNode
  ordered: boolean
  separatorTo: number
  source: string
  taskFrom: number | null
  taskTo: number | null
  to: number
  unorderedTask: boolean
}

interface ListLineIndentProjection {
  columns: number
  from: number
  to: number
}

interface ListLineQuoteProjection {
  columns: number
  from: number
  nodes: readonly SyntaxNode[]
  to: number
}

interface ListLineProjection {
  depth: number
  indents: readonly ListLineIndentProjection[]
  markers: readonly ListLineMarkerProjection[]
  ownerMarkerFrom: number
  prefixTo: number
  quotes: readonly ListLineQuoteProjection[]
  totalPrefixLane: string
}

function taskMarkerForListMarker(marker: SyntaxNode) {
  const task = marker.parent?.getChild("Task")
  return task?.getChild("TaskMarker") ?? null
}

function quoteProjectionsOnLine(
  context: BuildContext,
  line: Line,
  quotes: readonly SyntaxNode[]
) {
  const projections: ListLineQuoteProjection[] = []
  let coveredTo = -1
  for (const quote of quotes) {
    if (quote.from < coveredTo) continue
    const leading = context.state.sliceDoc(line.from, quote.from)
    const from = /^[\t ]*$/.test(leading) ? line.from : quote.from
    const source = context.state.sliceDoc(from, line.to)
    const prefix = quoteContainerPrefix(source)
    const to = from + prefix.length
    if (to <= quote.from) continue
    const nodes = quotes.filter(
      (candidate) => candidate.from >= from && candidate.to <= to
    )
    projections.push({
      columns: countColumn(
        context.state.sliceDoc(from, to),
        context.state.tabSize
      ),
      from,
      nodes,
      to,
    })
    coveredTo = to
  }
  return projections
}

function listLineProjection(context: BuildContext, line: Line) {
  const cached = context.listLineProjections?.get(line.from)
  if (cached !== undefined) return cached

  const markerNodes: SyntaxNode[] = []
  const quoteNodes: SyntaxNode[] = []
  ;(context.tree ?? syntaxTree(context.state)).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (context.state.doc.lineAt(node.from).from !== line.from) return
      if (node.name === "ListMark") markerNodes.push(node.node)
      else if (node.name === "QuoteMark") quoteNodes.push(node.node)
    },
  })
  markerNodes.sort((left, right) => left.from - right.from)
  quoteNodes.sort((left, right) => left.from - right.from)
  if (markerNodes.length === 0) {
    context.listLineProjections?.set(line.from, null)
    return null
  }

  const markers = markerNodes.map<ListLineMarkerProjection>((marker) => {
    const source = context.state.sliceDoc(marker.from, marker.to).trim()
    const ordered = parsePotentialOrderedListMarker(source) != null
    const depth = listDepth(marker)
    const taskMarker = taskMarkerForListMarker(marker)
    const isTaskItem = taskMarker != null
    const unorderedTask = isTaskItem && !ordered
    const whitespace = /^[\t ]*/.exec(
      context.state.sliceDoc(marker.to, line.to)
    )?.[0]
    const separatorTo = marker.to + (whitespace?.length ?? 0)
    const taskFrom = taskMarker?.from ?? null
    let taskTo: number | null = null
    if (taskMarker) {
      const taskWhitespace = /^[\t ]*/.exec(
        context.state.sliceDoc(taskMarker.to, line.to)
      )?.[0]
      taskTo = taskMarker.to + (taskWhitespace?.length ?? 0)
    }
    return {
      depth,
      from: marker.from,
      isTaskItem,
      lane: unorderedTask
        ? "0px"
        : ordered
          ? orderedListMarkerLane(context, marker, source)
          : "1.1rem",
      markerDepth: ordered ? depth : unorderedListMarkerDepth(marker),
      node: marker,
      ordered,
      separatorTo,
      source,
      taskFrom,
      taskTo,
      to: marker.to,
      unorderedTask,
    }
  })
  const quotes = quoteProjectionsOnLine(context, line, quoteNodes)
  const covered = [
    ...quotes.map((quote) => ({ from: quote.from, to: quote.to })),
    ...markers.flatMap((marker) => {
      if (marker.unorderedTask && marker.taskTo != null) {
        return [{ from: marker.from, to: marker.taskTo }]
      }
      const ranges = [{ from: marker.from, to: marker.separatorTo }]
      if (marker.taskFrom != null && marker.taskTo != null) {
        ranges.push({ from: marker.taskFrom, to: marker.taskTo })
      }
      return ranges
    }),
  ].sort((left, right) => left.from - right.from || left.to - right.to)
  const prefixTo = Math.max(...covered.map((range) => range.to))
  const indents: ListLineIndentProjection[] = []
  let coveredTo = line.from
  for (const range of covered) {
    if (range.from > coveredTo) {
      const source = context.state.sliceDoc(coveredTo, range.from)
      if (/^[\t ]+$/.test(source)) {
        indents.push({
          columns: countColumn(source, context.state.tabSize),
          from: coveredTo,
          to: range.from,
        })
      }
    }
    coveredTo = Math.max(coveredTo, range.to)
  }
  if (coveredTo < prefixTo) {
    const source = context.state.sliceDoc(coveredTo, prefixTo)
    if (/^[\t ]+$/.test(source)) {
      indents.push({
        columns: countColumn(source, context.state.tabSize),
        from: coveredTo,
        to: prefixTo,
      })
    }
  }
  const laneParts: string[] = []
  for (const indent of indents) {
    laneParts.push(`${indent.columns * 0.25}em`)
  }
  for (const quote of quotes) {
    laneParts.push(`${quote.columns * 0.5}em`)
  }
  for (const marker of markers) {
    laneParts.push(marker.unorderedTask ? taskCheckboxLane : marker.lane)
    if (marker.ordered && marker.isTaskItem) laneParts.push(taskCheckboxLane)
  }
  const projection: ListLineProjection = {
    depth: Math.max(...markers.map((marker) => marker.depth)),
    indents,
    markers,
    ownerMarkerFrom: markers.at(-1)!.from,
    prefixTo,
    quotes,
    totalPrefixLane:
      laneParts.length === 1 ? laneParts[0]! : `calc(${laneParts.join(" + ")})`,
  }
  context.listLineProjections?.set(line.from, projection)
  return projection
}

function listLineMarkerProjection(
  projection: ListLineProjection,
  markerFrom: number
) {
  return projection.markers.find((marker) => marker.from === markerFrom) ?? null
}

function addListPrefixIsolate(
  context: BuildContext,
  line: Line,
  projection: ListLineProjection
) {
  if (projection.prefixTo <= line.from) return
  addDecoration(
    context,
    line.from,
    projection.prefixTo,
    Decoration.mark({
      bidiIsolate: Direction.LTR,
      class: "cm-md-list-prefix-bidi-isolate",
      markdownPreviewKind: "list-prefix-bidi-isolate",
      stableMarkdownPrefix: true,
    }),
    "list-prefix-bidi-isolate"
  )
}

function addListLineQuoteDecorations(
  context: BuildContext,
  projection: ListLineProjection
) {
  for (const quote of projection.quotes) {
    addDecoration(
      context,
      quote.from,
      quote.to,
      listQuotePrefixSourceMark(
        quote.columns,
        context.taskPresentationBase
          ? false
          : !selectionTouches(context, quote.from, quote.to),
        true
      ),
      "list-quote-prefix-source"
    )
  }
}

function addListLineIndentDecorations(
  context: BuildContext,
  projection: ListLineProjection
) {
  for (const indent of projection.indents) {
    addDecoration(
      context,
      indent.from,
      indent.to,
      listIndentSourceMark(indent.columns),
      "list-indent-source"
    )
  }
}

function addListLineQuotePaint(
  context: BuildContext,
  projection: ListLineProjection
) {
  for (const quote of projection.quotes) {
    if (selectionTouches(context, quote.from, quote.to)) continue
    addDecoration(
      context,
      quote.from,
      quote.to,
      Decoration.mark({
        class: "cm-md-list-quote-prefix-rendered",
        markdownPreviewKind: "list-quote-prefix-paint",
        stableMarkdownPrefix: true,
      }),
      "list-quote-prefix-paint"
    )
  }
}

function listLineOwnsQuoteMark(
  context: BuildContext,
  line: Line,
  quote: SyntaxNodeRef
) {
  return (
    listLineProjection(context, line)?.quotes.some((projection) =>
      projection.nodes.some(
        (node) => node.from === quote.from && node.to === quote.to
      )
    ) ?? false
  )
}

function lineContainsListMarker(context: BuildContext, lineFrom: number) {
  const cached = context.listMarkerLines?.get(lineFrom)
  if (cached != null) return cached

  const line = context.state.doc.lineAt(lineFrom)
  const contains = listLineProjection(context, line) != null
  context.listMarkerLines?.set(lineFrom, contains)
  return contains
}

function listItemSourceIndent(context: BuildContext, item: SyntaxNode) {
  const marker = item.getChild("ListMark")
  if (!marker) return null
  const line = context.state.doc.lineAt(marker.from)
  const prefix = context.state.sliceDoc(line.from, marker.from)
  const indentation = /[\t ]*$/.exec(prefix)?.[0] ?? ""
  let quoteDepth = 0
  for (let parent = item.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") quoteDepth += 1
  }
  return {
    columns: countColumn(indentation, context.state.tabSize),
    markerLine: line.number,
    quoteDepth,
  }
}

function continuationSourceIndent(
  context: BuildContext,
  lineNumber: number,
  quoteDepth: number
) {
  const line = context.state.doc.line(lineNumber)
  const quote = quoteContainerPrefix(line.text, quoteDepth)
  if (quote.depth !== quoteDepth) return null
  const indentation = /^[\t ]*/.exec(line.text.slice(quote.length))?.[0] ?? ""
  return countColumn(indentation, context.state.tabSize)
}

function renderedCalloutOwnsListLine(context: BuildContext, line: Line) {
  const tree = context.tree ?? syntaxTree(context.state)
  for (
    let node: SyntaxNode | null = tree.resolve(
      line.to > line.from ? line.to - 1 : line.from,
      1
    );
    node;
    node = node.parent
  ) {
    // A nearer list item belongs inside the callout and keeps ordinary list
    // layout. Only a callout encountered before the owning list item has a
    // wrapper that already occupies that outer list's content lane.
    if (node.name === "ListItem") return false
    if (!isCalloutBlockquote(context.state, node)) continue
    return !(
      context.editingRange &&
      context.editingRange.from <= line.from &&
      line.from <= context.editingRange.to
    )
  }
  return false
}

interface ListContinuationProjection {
  contentFrom: number
  depth: number
  editingPrefix: ListContinuationEditingPrefix | null
  indent: ListLineIndentProjection | null
  quote: ListLineQuoteProjection | null
  totalPrefixLane: string
}

interface ListContinuationEditingPrefix {
  depth: number
  indents: readonly ListLineIndentProjection[]
  quotes: readonly ListLineQuoteProjection[]
  to: number
  totalPrefixLane: string
}

function sourceColumnWidthOnLine(
  context: BuildContext,
  line: Line,
  from: number,
  to: number
) {
  const sourceFrom = Math.max(0, from - line.from)
  const sourceTo = Math.max(sourceFrom, to - line.from)
  return (
    countColumn(line.text.slice(0, sourceTo), context.state.tabSize) -
    countColumn(line.text.slice(0, sourceFrom), context.state.tabSize)
  )
}

function listContinuationEditingPrefix(
  context: BuildContext,
  line: Line,
  quote: ListLineQuoteProjection | null,
  indent: ListLineIndentProjection | null,
  depth: number
): ListContinuationEditingPrefix | null {
  if (
    !context.editingRange ||
    line.from < context.editingRange.from ||
    line.from > context.editingRange.to
  ) {
    return null
  }

  const activeQuote = editingCalloutQuoteMark(context, line)
  if (!activeQuote) {
    const quotes = quote ? [quote] : []
    const indents = indent ? [indent] : []
    const laneParts = [
      ...quotes.map((part) => ({
        from: part.from,
        width: `${part.columns * 0.5}em`,
      })),
      ...indents.map((part) => ({
        from: part.from,
        width: `${part.columns * 0.25}em`,
      })),
    ].sort((left, right) => left.from - right.from)
    return {
      depth,
      indents,
      quotes,
      to: Math.max(line.from, quote?.to ?? line.from, indent?.to ?? line.from),
      totalPrefixLane:
        laneParts.length === 0
          ? "0px"
          : laneParts.length === 1
            ? laneParts[0]!.width
            : `calc(${laneParts.map(({ width }) => width).join(" + ")})`,
    }
  }

  const precedingQuoteMarks: SyntaxNode[] = []
  ;(
    context.editingCalloutTree ??
    context.tree ??
    syntaxTree(context.state)
  ).iterate({
    from: line.from,
    to: activeQuote.from,
    enter(node) {
      if (node.name === "QuoteMark" && node.from < activeQuote.from) {
        precedingQuoteMarks.push(node.node)
      }
    },
  })
  precedingQuoteMarks.sort((left, right) => left.from - right.from)

  const quotes = precedingQuoteMarks.map<ListLineQuoteProjection>((mark) => {
    const separator = context.state.sliceDoc(mark.to, mark.to + 1)
    const to =
      mark.to < activeQuote.from && (separator === " " || separator === "\t")
        ? mark.to + 1
        : mark.to
    return {
      columns: sourceColumnWidthOnLine(context, line, mark.from, to),
      from: mark.from,
      nodes: [mark],
      to,
    }
  })
  const indents: ListLineIndentProjection[] = []
  let cursor = line.from
  for (const part of quotes) {
    if (
      cursor < part.from &&
      /^[\t ]+$/.test(context.state.sliceDoc(cursor, part.from))
    ) {
      indents.push({
        columns: sourceColumnWidthOnLine(context, line, cursor, part.from),
        from: cursor,
        to: part.from,
      })
    }
    cursor = Math.max(cursor, part.to)
  }
  if (
    cursor < activeQuote.from &&
    /^[\t ]+$/.test(context.state.sliceDoc(cursor, activeQuote.from))
  ) {
    indents.push({
      columns: sourceColumnWidthOnLine(context, line, cursor, activeQuote.from),
      from: cursor,
      to: activeQuote.from,
    })
  }
  const laneParts = [
    ...quotes.map((part) => ({
      from: part.from,
      width: `${part.columns * 0.5}em`,
    })),
    ...indents.map((part) => ({
      from: part.from,
      width: `${part.columns * 0.25}em`,
    })),
  ].sort((left, right) => left.from - right.from)

  return {
    depth,
    indents,
    quotes,
    to: activeQuote.from,
    totalPrefixLane:
      laneParts.length === 0
        ? "0px"
        : laneParts.length === 1
          ? laneParts[0]!.width
          : `calc(${laneParts.map(({ width }) => width).join(" + ")})`,
  }
}

function listContinuationProjection(context: BuildContext, line: Line) {
  const cached = context.listContinuationProjections?.get(line.from)
  if (cached !== undefined) return cached
  const editingLine =
    context.editingRange != null &&
    line.from >= context.editingRange.from &&
    line.from <= context.editingRange.to
  if (
    line.length === 0 ||
    (!editingLine && lineContainsListMarker(context, line.from))
  ) {
    context.listContinuationProjections?.set(line.from, null)
    return null
  }

  let depth = 0
  let editingDepth = 0
  const editingCallout = editingLine ? context.editingCallout : null
  const tree =
    (editingLine ? context.editingCalloutTree : null) ??
    context.tree ??
    syntaxTree(context.state)
  for (
    let node: SyntaxNode | null = tree.resolve(
      line.to > line.from ? line.to - 1 : line.from,
      1
    );
    node;
    node = node.parent
  ) {
    if (node.name === "ListItem") {
      const sourceIndent = listItemSourceIndent(context, node)
      if (!sourceIndent || line.number === sourceIndent.markerLine) continue
      const continuationIndent = continuationSourceIndent(
        context,
        line.number,
        sourceIndent.quoteDepth
      )
      if (
        continuationIndent == null ||
        continuationIndent <= sourceIndent.columns
      ) {
        continue
      }
      const marker = node.getChild("ListMark")
      if (marker) {
        const markerDepth = listDepth(marker)
        if (markerDepth >= depth) {
          depth = markerDepth
        }
        if (
          (!editingLine ||
            (editingCallout != null &&
              node.from <= editingCallout.from &&
              node.to >= editingCallout.to)) &&
          markerDepth >= editingDepth
        ) {
          editingDepth = markerDepth
        }
      }
    }
  }
  if (depth === 0) {
    context.listContinuationProjections?.set(line.from, null)
    return null
  }

  const quotePrefix = quoteContainerPrefix(line.text)
  const quoteTo = line.from + quotePrefix.length
  const indentation = /^[\t ]*/.exec(
    context.state.sliceDoc(quoteTo, line.to)
  )?.[0]
  const contentFrom = quoteTo + (indentation?.length ?? 0)
  const quote =
    quoteTo > line.from
      ? {
          columns: countColumn(
            context.state.sliceDoc(line.from, quoteTo),
            context.state.tabSize
          ),
          from: line.from,
          nodes: [] as readonly SyntaxNode[],
          to: quoteTo,
        }
      : null
  const indent =
    contentFrom > quoteTo
      ? {
          columns: countColumn(
            context.state.sliceDoc(quoteTo, contentFrom),
            context.state.tabSize
          ),
          from: quoteTo,
          to: contentFrom,
        }
      : null
  const laneParts = [
    ...(quote ? [`${quote.columns * 0.5}em`] : []),
    ...(indent ? [`${indent.columns * 0.25}em`] : []),
  ]
  const projection: ListContinuationProjection = {
    contentFrom,
    depth,
    editingPrefix: listContinuationEditingPrefix(
      context,
      line,
      quote,
      indent,
      editingDepth
    ),
    indent,
    quote,
    totalPrefixLane:
      laneParts.length === 1 ? laneParts[0]! : `calc(${laneParts.join(" + ")})`,
  }
  context.listContinuationProjections?.set(line.from, projection)
  return projection
}

function addListContinuationDecorations(
  context: BuildContext,
  line: Line,
  projection: ListContinuationProjection
) {
  const editingPrefix = projection.editingPrefix
  const depth = editingPrefix?.depth ?? projection.depth
  const kind = `list-continuation-line:${depth}`
  const prefixLane =
    editingPrefix?.totalPrefixLane ?? projection.totalPrefixLane
  if (depth > 0) {
    addDecoration(
      context,
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          style: listMarkerLineStyle(depth, prefixLane),
        },
        class: [
          "cm-md-list-line",
          "cm-md-list-marker-line",
          "cm-md-list-continuation-line",
          `cm-md-list-depth-${depth}`,
        ].join(" "),
        markdownPreviewKind: kind,
        stableMarkdownPrefix: true,
      }),
      kind,
      editingPrefix != null
    )
  }
  if (editingPrefix) {
    if (editingPrefix.to > line.from) {
      addDecoration(
        context,
        line.from,
        editingPrefix.to,
        Decoration.mark({
          bidiIsolate: Direction.LTR,
          class: "cm-md-list-prefix-bidi-isolate",
          markdownPreviewKind: "list-prefix-bidi-isolate",
          stableMarkdownPrefix: true,
        }),
        "list-editing-prefix-bidi-isolate",
        true
      )
    }
    for (const indent of editingPrefix.indents) {
      addDecoration(
        context,
        indent.from,
        indent.to,
        listIndentSourceMark(indent.columns),
        "list-editing-indent-source",
        true
      )
    }
    for (const quote of editingPrefix.quotes) {
      addDecoration(
        context,
        quote.from,
        quote.to,
        listQuotePrefixSourceMark(quote.columns, true, true),
        "list-editing-quote-prefix-source",
        true
      )
    }
    return
  }
  if (projection.contentFrom > line.from) {
    addDecoration(
      context,
      line.from,
      projection.contentFrom,
      Decoration.mark({
        bidiIsolate: Direction.LTR,
        class: "cm-md-list-prefix-bidi-isolate",
        markdownPreviewKind: "list-prefix-bidi-isolate",
        stableMarkdownPrefix: true,
      }),
      "list-prefix-bidi-isolate"
    )
  }
  if (projection.quote) {
    context.listSourceBackedQuoteLines?.add(line.from)
    addDecoration(
      context,
      projection.quote.from,
      projection.quote.to,
      listQuotePrefixSourceMark(
        projection.quote.columns,
        !selectionTouches(context, projection.quote.from, projection.quote.to),
        true
      ),
      "list-quote-prefix-source"
    )
  }
  if (projection.indent) {
    addDecoration(
      context,
      projection.indent.from,
      projection.indent.to,
      listIndentSourceMark(projection.indent.columns),
      "list-indent-source"
    )
  }
}

/**
 * CommonMark keeps an unindented line adjacent to a list item inside that
 * item's paragraph as a lazy continuation. Preserve that parse for Markdown
 * semantics, but don't visually pull a column-zero prose line into a list
 * lane. An authored continuation contributes a list level only when its
 * source indentation is deeper than that level's marker.
 */
function addListItemLineDecorations(context: BuildContext, item: SyntaxNode) {
  const sourceIndent = listItemSourceIndent(context, item)
  if (!sourceIndent) return

  const clippedFrom = Math.max(item.from, context.visible.from)
  const clippedTo = Math.min(item.to, context.visible.to)
  if (clippedFrom > clippedTo) return

  let line = context.state.doc.lineAt(clippedFrom)
  const lastLine = context.state.doc.lineAt(
    Math.max(clippedFrom, clippedTo - 1)
  ).number

  while (line.number <= lastLine) {
    if (
      line.number === sourceIndent.markerLine ||
      renderedCalloutOwnsListLine(context, line)
    ) {
      addDecoration(
        context,
        line.from,
        line.from,
        Decoration.line({
          class: "cm-md-list-line",
          markdownPreviewKind: "line:cm-md-list-line",
          stableMarkdownPrefix: true,
        }),
        "line:cm-md-list-line"
      )
    } else {
      const projection = listContinuationProjection(context, line)
      if (projection) addListContinuationDecorations(context, line, projection)
    }
    if (line.number === context.state.doc.lines) break
    line = context.state.doc.line(line.number + 1)
  }
}

function parentIsInactive(context: BuildContext, node: SyntaxNodeRef) {
  const parent = node.node.parent
  return parent != null && !selectionTouches(context, parent.from, parent.to)
}

function decorateLink(context: BuildContext, node: SyntaxNodeRef) {
  if (isCalloutHeaderMarker(context.state, node.from, node.to)) return
  const resolved = resolveMarkdownLinkNode(context.state, node.node)
  if (!resolved) return
  // Keep ordinary links quiet until the open-link modifier is held. An
  // explicitly authored Markdown title opts into the shared tooltip at rest.
  const renderedLinkMark = resolved.title
    ? Decoration.mark({
        inclusive: true,
        class: resolved.activation
          ? "cm-md-link cm-md-openable-link cm-md-web-link"
          : "cm-md-link",
        attributes: {
          "data-markdown-link-title": resolved.title,
        },
      })
    : resolved.activation
      ? webLinkMark
      : linkMark

  // Cmd/Ctrl-click resolves anywhere inside the Markdown link node, including
  // its delimiters and destination while source is revealed. Keep the cursor
  // affordance on that exact same clickable range.
  if (resolved.activation) {
    addDecoration(
      context,
      node.from,
      node.to,
      webLinkCursorMark,
      "web-link-target"
    )
  }

  const marks: Array<{ from: number; to: number }> = []
  let url: { from: number; to: number } | null = null
  let label: { from: number; to: number } | null = null
  let title: { from: number; to: number } | null = null
  let child = node.node.firstChild

  while (child) {
    if (child.name === "LinkMark")
      marks.push({ from: child.from, to: child.to })
    if (child.name === "URL") url = { from: child.from, to: child.to }
    if (child.name === "LinkLabel") label = { from: child.from, to: child.to }
    if (child.name === "LinkTitle") title = { from: child.from, to: child.to }
    child = child.nextSibling
  }

  if (
    marks.length >= 2 &&
    marks[0] &&
    marks[1] &&
    marks[0].to < marks[1].from
  ) {
    addDecoration(
      context,
      marks[0].to,
      marks[1].from,
      renderedLinkMark,
      "link-label"
    )
  }

  if (selectionTouches(context, node.from, node.to)) return
  for (const mark of marks) {
    addDecoration(context, mark.from, mark.to, hiddenDelimiter, "link-mark")
  }
  if (label)
    addDecoration(context, label.from, label.to, hiddenUrl, "link-label-url")
  if (node.name !== "Autolink") {
    const openingDestinationMark = marks.find(
      (mark, index) =>
        index >= 2 && context.state.sliceDoc(mark.from, mark.to) === "("
    )
    const closingDestinationMark = openingDestinationMark ? marks.at(-1) : null
    if (
      openingDestinationMark &&
      closingDestinationMark &&
      openingDestinationMark !== closingDestinationMark
    ) {
      // Hide the destination, optional title, and their separating whitespace
      // as one unit so titles never leak into the rendered label.
      // Empty destinations have adjacent `(` and `)` marks and therefore no
      // interior range. The marks are hidden individually above; attempting a
      // zero-width replacement for their empty interior crashes the view
      // plugin because replacement decorations require a non-empty range.
      if (openingDestinationMark.to < closingDestinationMark.from) {
        addDecoration(
          context,
          openingDestinationMark.to,
          closingDestinationMark.from,
          hiddenUrl,
          "link-inline-details"
        )
      }
    } else {
      if (url) addDecoration(context, url.from, url.to, hiddenUrl, "link-url")
      if (title)
        addDecoration(context, title.from, title.to, hiddenUrl, "link-title")
    }
  }
}

function delimitedContentRange(node: SyntaxNode, markName: string) {
  const marks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === markName) marks.push(child)
  }
  const opening = marks[0]
  const closing = marks.at(-1)
  return opening && closing && opening !== closing && opening.to <= closing.from
    ? { from: opening.to, to: closing.from }
    : { from: node.from, to: node.to }
}

const imageAltHiddenNodes = new Set([
  "CodeMark",
  "EmphasisMark",
  "LinkMark",
  "StrikethroughMark",
  "SubscriptMark",
  "SuperscriptMark",
])

function appendImageAltText(
  parts: MarkdownImageAltPart[],
  text: string,
  entity = false
) {
  if (!text) return
  const previous = parts.at(-1)
  if (previous && previous.entity === entity) {
    parts[parts.length - 1] = { entity, text: previous.text + text }
  } else {
    parts.push({ entity, text })
  }
}

function imageAltLabelRange(node: SyntaxNode) {
  const marks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push(child)
  }
  return marks[0] && marks[1] ? { from: marks[0].to, to: marks[1].from } : null
}

function imageAltPartsInRange(
  state: EditorState,
  node: SyntaxNode,
  from: number,
  to: number,
  parts: MarkdownImageAltPart[]
) {
  let cursor = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue
    const childFrom = Math.max(from, child.from)
    const childTo = Math.min(to, child.to)
    if (cursor < childFrom) {
      appendImageAltText(parts, state.sliceDoc(cursor, childFrom))
    }

    if (imageAltHiddenNodes.has(child.name)) {
      // Delimiter syntax has no rendered textual representation.
    } else if (child.name === "Entity") {
      appendImageAltText(parts, state.sliceDoc(childFrom, childTo), true)
    } else if (child.name === "Escape") {
      appendImageAltText(
        parts,
        state.sliceDoc(childFrom, childTo).replace(/^\\/, "")
      )
    } else if (child.name === "Image" || child.name === "Link") {
      const label = imageAltLabelRange(child)
      if (label) {
        imageAltPartsInRange(state, child, label.from, label.to, parts)
      }
    } else if (child.firstChild) {
      imageAltPartsInRange(state, child, childFrom, childTo, parts)
    } else {
      appendImageAltText(parts, state.sliceDoc(childFrom, childTo))
    }
    cursor = Math.max(cursor, childTo)
  }
  if (cursor < to) appendImageAltText(parts, state.sliceDoc(cursor, to))
}

function markdownImageAlt(state: EditorState, image: SyntaxNode) {
  const label = imageAltLabelRange(image)
  if (!label) return []
  const parts: MarkdownImageAltPart[] = []
  imageAltPartsInRange(state, image, label.from, label.to, parts)
  return parts
}

function markdownImageDetails(state: EditorState, image: SyntaxNode) {
  const children: SyntaxNode[] = []
  for (let child = image.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  const marks = children.filter((child) => child.name === "LinkMark")
  if (!marks[0] || !marks[1]) return null

  const resolved = resolveMarkdownLinkNode(state, image)
  if (!resolved?.destination) return null
  const source = resolveMarkdownImageSource(
    resolved.destination,
    state.facet(markdownDocumentPath)
  )
  if (!source) return null

  const remote = markdownImageSourceIsRemote(source)
  return {
    alt: markdownImageAlt(state, image),
    loadSource: !remote || state.facet(markdownRemoteImagesEnabled),
    source,
    title: resolved.title,
  }
}

function decorateImage(context: BuildContext, node: SyntaxNodeRef) {
  if (selectionTouches(context, node.from, node.to)) return
  const details = markdownImageDetails(context.state, node.node)
  if (!details) return
  addDecoration(
    context,
    node.from,
    node.to,
    Decoration.replace({
      widget: new MarkdownImageWidget(
        details.source,
        details.alt,
        details.title,
        details.loadSource
      ),
      markdownPreviewKind: "image",
    }),
    "image"
  )
}

function headingLevel(name: string) {
  const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
  return match?.[1]
}

function decorateHeaderMark(context: BuildContext, node: SyntaxNodeRef) {
  const hiddenTo =
    context.state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to
  const revealed =
    context.selectionActive &&
    context.state.selection.ranges.some((range) =>
      range.empty
        ? range.head >= node.from && range.head <= hiddenTo
        : range.from < node.to && range.to > node.from
    )

  if (!revealed) {
    // Hiding the single separator space with the marker avoids an artificial
    // indent while keeping the first content character at its source position.
    addDecoration(
      context,
      node.from,
      hiddenTo,
      hiddenDelimiter,
      "hidden:HeaderMark"
    )
  }
}

function tableSelectionClasses(
  state: EditorState,
  table: TableLayout,
  row: TableLayoutRow,
  column: number
) {
  const selection = state.field(tableCellRangeSelectionState, false)
  if (
    !selection ||
    table.syntaxFrom !== selection.tableFrom ||
    table.to !== selection.tableTo
  ) {
    return ""
  }

  const firstRowFrom = Math.min(selection.anchorRowFrom, selection.headRowFrom)
  const lastRowFrom = Math.max(selection.anchorRowFrom, selection.headRowFrom)
  const firstColumn = Math.min(selection.anchorColumn, selection.headColumn)
  const lastColumn = Math.max(selection.anchorColumn, selection.headColumn)
  if (
    row.from < firstRowFrom ||
    row.from > lastRowFrom ||
    column < firstColumn ||
    column > lastColumn
  ) {
    return ""
  }

  return [
    "cm-md-table-cell-selected",
    ...(row.from === firstRowFrom ? ["cm-md-table-selection-top"] : []),
    ...(row.from === lastRowFrom ? ["cm-md-table-selection-bottom"] : []),
    ...(column === firstColumn ? ["cm-md-table-selection-left"] : []),
    ...(column === lastColumn ? ["cm-md-table-selection-right"] : []),
  ].join(" ")
}

function decorateTableStructure(
  context: BuildContext,
  table: TableLayout,
  row: TableLayoutRow
) {
  const lineFrom = context.state.doc.lineAt(row.from).from
  addDecoration(
    context,
    lineFrom,
    lineFrom,
    Decoration.line({
      class:
        row.kind === "header"
          ? "cm-md-table-line cm-md-table-header"
          : "cm-md-table-line cm-md-table-row",
    }),
    `table-line:${row.kind}`
  )
  if (row.prefix) {
    addDecoration(
      context,
      row.prefix.from,
      row.prefix.to,
      hiddenTablePrefix,
      "hidden:table-prefix"
    )
  }
  for (const delimiter of row.delimiters) {
    const gridLine = Math.min(
      1 + row.segments.filter((segment) => segment.to <= delimiter.from).length,
      table.columnCount + 1
    )
    addDecoration(
      context,
      delimiter.from,
      delimiter.to,
      hiddenTableDelimiter(gridLine),
      "hidden:table-delimiter"
    )
  }

  const segments = [...row.segments]
  const expectedColumns = table.columnCount
  const excessSegments = segments.splice(expectedColumns)
  for (const [index, segment] of excessSegments.entries()) {
    if (segment.from === segment.to) continue
    addDecoration(
      context,
      segment.from,
      segment.to,
      Decoration.replace({ markdownPreviewKind: "table-excess-cell" }),
      `table-excess-cell:${expectedColumns + index}`
    )
  }

  while (segments.length < expectedColumns) {
    segments.push({ from: row.to, to: row.to, content: null })
  }

  for (const [index, segment] of segments.entries()) {
    const selectionClasses = tableSelectionClasses(
      context.state,
      table,
      row,
      index
    )
    const source = segment.content
      ? context.state.sliceDoc(segment.content.from, segment.content.to)
      : ""
    const cellLayout = tableCellLayout(source)
    if (segment.content) {
      for (const [paddingIndex, padding] of tableSegmentPaddingRanges(
        segment
      ).entries()) {
        addDecoration(
          context,
          padding.from,
          padding.to,
          hiddenTableCellPadding,
          `hidden:table-cell-padding:${index}:${paddingIndex}`
        )
      }
      addDecoration(
        context,
        segment.from,
        segment.to,
        tableCellMark(selectionClasses, cellLayout.prose),
        `table-cell:${index}`
      )
      continue
    }

    const widget = new EmptyTableCellWidget(selectionClasses)
    addDecoration(
      context,
      segment.from,
      segment.to,
      segment.from === segment.to
        ? Decoration.widget({
            widget,
            side: index + 1,
            markdownPreviewKind: "table-empty-cell",
          })
        : emptyTableCellMark(selectionClasses),
      `table-empty-cell:${index}`
    )
  }
}

export function buildTableStructureDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[]
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  const editingRange = state.facet(calloutEditingRange)
  const definitionLists = new Map<number, DefinitionListSyntax | null>()
  const index =
    state.field(tableLayoutState, false) ??
    completeTableLayoutIndex(state, completeMarkdownSyntaxTree(state))

  for (const visible of visibleRanges) {
    for (const table of tableLayoutsBetween(index, visible.from, visible.to)) {
      const context = {
        definitionLists,
        editingRange,
        state,
        ranges,
        seen,
        visible,
        selectionActive: false,
      }
      if (
        table.separator &&
        table.separator.from >= visible.from &&
        table.separator.from <= visible.to
      ) {
        addDecoration(
          context,
          table.separator.from,
          table.separator.from,
          Decoration.line({ class: "cm-md-table-separator" }),
          "table-separator-line"
        )
        addDecoration(
          context,
          table.separator.from,
          table.separator.to,
          hiddenDelimiter,
          "hidden:table-separator"
        )
      }
      for (const row of table.rows) {
        if (row.to >= visible.from && row.from <= visible.to) {
          decorateTableStructure(context, table, row)
        }
      }
    }
  }

  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function decorateNode(context: BuildContext, node: SyntaxNodeRef) {
  const level = headingLevel(node.name)
  if (level) {
    addLineDecorations(
      context,
      node.from,
      node.to,
      `cm-md-heading cm-md-heading-${level}`
    )
    addDecoration(
      context,
      node.from,
      node.from,
      Decoration.widget({
        markdownPreviewKind: "heading-anchor",
        side: -1,
        widget: new HeadingAnchorWidget(node.from),
      }),
      "heading-anchor"
    )
    return
  }

  switch (node.name) {
    case "StrongEmphasis":
      addDecoration(context, node.from, node.to, strongMark, "strong")
      return
    case "Emphasis":
      addDecoration(context, node.from, node.to, emphasisMark, "emphasis")
      return
    case "Strikethrough":
      {
        const content = delimitedContentRange(node.node, "StrikethroughMark")
        addDecoration(
          context,
          content.from,
          content.to,
          strikethroughMark,
          "strike"
        )
      }
      return
    case "Superscript":
      {
        const content = delimitedContentRange(node.node, "SuperscriptMark")
        addDecoration(
          context,
          content.from,
          content.to,
          superscriptMark,
          "superscript"
        )
      }
      return
    case "Subscript":
      {
        const content = delimitedContentRange(node.node, "SubscriptMark")
        addDecoration(
          context,
          content.from,
          content.to,
          subscriptMark,
          "subscript"
        )
      }
      return
    case "Escape":
      if (!selectionTouches(context, node.from, node.to)) {
        addDecoration(
          context,
          node.from,
          node.from + 1,
          hiddenDelimiter,
          "escape-marker"
        )
      }
      return
    case "Entity": {
      if (selectionTouches(context, node.from, node.to)) return
      const source = context.state.sliceDoc(node.from, node.to)
      const decoded = decodeMarkdownCharacterReferences(source)
      if (decoded !== source) {
        addDecoration(
          context,
          node.from,
          node.to,
          Decoration.replace({
            inclusive: false,
            markdownPreviewKind: "character-reference",
            widget: new MarkdownTextWidget(
              decoded,
              "cm-md-character-reference",
              true
            ),
          }),
          "character-reference"
        )
      }
      return
    }
    case "HardBreak": {
      if (selectionTouches(context, node.from, node.to)) return
      // Preserve the physical newline; only its backslash/two-space marker
      // disappears. Viewport decorations must never replace a line boundary.
      const to =
        context.state.sliceDoc(node.to - 1, node.to) === "\n"
          ? node.to - 1
          : node.to
      if (node.from < to) {
        addDecoration(
          context,
          node.from,
          to,
          hiddenDelimiter,
          "hard-break-marker"
        )
      }
      return
    }
    case "InlineCode":
      addDecoration(context, node.from, node.to, inlineCodeMark, "inline-code")
      if (
        !selectionTouches(context, node.from, node.to) &&
        context.state.doc.lineAt(node.from).number ===
          context.state.doc.lineAt(node.to).number
      ) {
        for (const replacement of inlineCodeNormalization(
          context.state,
          node.node,
          context.tree
        ).replacements) {
          addDecoration(
            context,
            replacement.from,
            replacement.to,
            inlineCodeReplacementDecoration(replacement),
            "inline-code-normalization"
          )
        }
      }
      return
    case "Link":
    case "Autolink":
      decorateLink(context, node)
      return
    case "Image":
      decorateImage(context, node)
      return
    case "LinkReference":
      return
    case "ListItem":
      addListItemLineDecorations(context, node.node)
      return
    case "Paragraph":
      if (
        definitionSyntax(context, followingDefinitionList(node.node))?.term
          .from === node.from
      ) {
        addLineDecorations(context, node.from, node.to, "cm-md-definition-term")
      }
      return
    case "DefinitionTerm":
      if (
        definitionSyntax(context, followingDefinitionList(node.node))?.term
          .from !== node.from
      ) {
        return
      }
      addLineDecorations(context, node.from, node.to, "cm-md-definition-term")
      return
    case "DefinitionDescription":
      if (
        !definitionSyntax(context, node.node.parent)?.descriptions.some(
          (description) => description.from === node.from
        )
      ) {
        return
      }
      addLineDecorations(
        context,
        node.from,
        node.to,
        "cm-md-definition-description"
      )
      return
    case "DefinitionMark": {
      if (
        !node.node.parent ||
        !definitionSyntax(context, node.node.parent.parent)?.descriptions.some(
          (description) => description.from === node.node.parent!.from
        )
      ) {
        return
      }
      const line = context.state.doc.lineAt(node.from)
      const whitespace = /^[\t ]*/.exec(
        context.state.sliceDoc(node.to, line.to)
      )?.[0]
      const markerTo = node.to + (whitespace?.length ?? 0)
      const indentation = context.state.sliceDoc(line.from, node.from)
      const indentationColumns = countColumn(indentation, context.state.tabSize)
      addDecoration(
        context,
        line.from,
        line.from,
        Decoration.line({
          class: "cm-md-definition-marker-line",
          attributes: {
            style: [
              `--cm-md-definition-source-indent:${indentationColumns * 0.25}em`,
              `--cm-md-definition-marker-lane:${definitionMarkerLaneEm}em`,
            ].join(";"),
          },
          markdownPreviewKind: "definition-marker-line",
          stableMarkdownPrefix: true,
        }),
        "definition-marker-line"
      )
      if (node.from > line.from) {
        addDecoration(
          context,
          line.from,
          node.from,
          definitionIndentSourceMark(indentationColumns),
          "definition-indent-source"
        )
      }
      addDecoration(
        context,
        node.from,
        node.to,
        definitionMarkerSourceMark(
          !selectionTouches(context, node.from, node.to)
        ),
        "definition-source-mark"
      )
      if (markerTo > node.to) {
        addDecoration(
          context,
          node.to,
          markerTo,
          definitionSeparatorSourceMark(whitespace ?? ""),
          "definition-separator-source"
        )
      }
      return
    }
    case "YAMLFrontMatter": {
      addLineDecorations(
        context,
        node.from,
        node.to,
        "cm-md-yaml-frontmatter-line"
      )
      const firstLine = context.state.doc.lineAt(node.from)
      const lastLine = context.state.doc.lineAt(
        Math.max(node.from, node.to - 1)
      )
      if (
        firstLine.from >= context.visible.from &&
        firstLine.from <= context.visible.to
      ) {
        addDecoration(
          context,
          firstLine.from,
          firstLine.from,
          Decoration.line({ class: "cm-md-yaml-frontmatter-first" }),
          "yaml-frontmatter-first"
        )
      }
      if (
        lastLine.from >= context.visible.from &&
        lastLine.from <= context.visible.to
      ) {
        addDecoration(
          context,
          lastLine.from,
          lastLine.from,
          Decoration.line({ class: "cm-md-yaml-frontmatter-last" }),
          "yaml-frontmatter-last"
        )
      }
      return
    }
    case "YAMLFrontMatterMark":
      addDecoration(
        context,
        node.from,
        node.to,
        yamlFrontMatterMark,
        "yaml-frontmatter-mark"
      )
      return
    case "CodeBlock":
    case "FencedCode":
      // The code-card extension owns every code row, including fence
      // boundaries. Those rows must survive when a containing callout reveals
      // its complete source and suppresses ordinary live-preview decorations.
      return
    case "Table":
    case "TableHeader":
    case "TableRow":
    case "TableCell":
    case "TableDelimiter":
      return
    case "HorizontalRule":
      if (!selectionTouches(context, node.from, node.to)) {
        const line = context.state.doc.lineAt(node.from)
        addDecoration(
          context,
          line.from,
          line.from,
          Decoration.line({
            class: "cm-md-horizontal-rule-line",
            attributes: { role: "separator" },
          }),
          "horizontal-rule-line"
        )
        addDecoration(
          context,
          node.from,
          node.to,
          hiddenHorizontalRule,
          "horizontal-rule"
        )
      }
      return
    case "TaskMarker":
      if (context.stateBackedTasks) return
      {
        const marker = context.state.sliceDoc(node.from, node.to)
        const line = context.state.doc.lineAt(node.to)
        const followingWhitespace = /^[\t ]*/.exec(
          context.state.sliceDoc(node.to, line.to)
        )?.[0]
        let item = node.node.parent
        while (item && item.name !== "ListItem") item = item.parent
        const listMark = item?.getChild("ListMark")
        const listMarkSource = listMark
          ? context.state.sliceDoc(listMark.from, listMark.to).trim()
          : ""
        const ordered = parsePotentialOrderedListMarker(listMarkSource) != null
        const taskFrom = !ordered && listMark ? listMark.from : node.from
        const taskTo = node.to + (followingWhitespace?.length ?? 0)
        const taskText = context.state.sliceDoc(taskTo, line.to).trim()
        addDecoration(
          context,
          taskFrom,
          taskTo,
          Decoration.replace({
            widget: new TaskCheckboxWidget(
              /[xX]/.test(marker),
              context.state.readOnly,
              taskTo - taskFrom,
              taskText
            ),
            markdownPreviewKind: "task",
          }),
          "task-marker"
        )
      }
      return
    case "ListMark":
      {
        const line = context.state.doc.lineAt(node.from)
        const projection = listLineProjection(context, line)
        if (!projection) return
        const marker = listLineMarkerProjection(projection, node.from)
        if (!marker) return
        const owner = projection.ownerMarkerFrom === node.from
        const label = marker.ordered
          ? marker.source
          : unorderedListMarkers[
              (marker.markerDepth - 1) % unorderedListMarkers.length
            ]
        const stateOwnedTaskLine = projection.markers.some(
          (candidate) => candidate.isTaskItem
        )
        if (stateOwnedTaskLine && context.stateBackedTasks) {
          if (owner) addListLineQuotePaint(context, projection)
          if (
            !marker.unorderedTask &&
            !selectionTouches(context, node.from, node.to)
          ) {
            addDecoration(
              context,
              node.from,
              node.to,
              Decoration.mark({
                class: "cm-md-list-marker-rendered",
                markdownPreviewKind: "list-marker-paint",
                stableMarkdownPrefix: true,
              }),
              "list-marker-paint"
            )
          }
          return
        }
        if (owner) {
          addListPrefixIsolate(context, line, projection)
          addListLineQuoteDecorations(context, projection)
          addListLineIndentDecorations(context, projection)
          const taskLine = projection.markers.some(
            (candidate) => candidate.isTaskItem
          )
          const kind = taskLine
            ? `task-list-marker-line:${projection.depth}`
            : `list-marker-line:${projection.depth}`
          addDecoration(
            context,
            line.from,
            line.from,
            Decoration.line({
              class: [
                "cm-md-list-marker-line",
                `cm-md-list-depth-${projection.depth}`,
                taskLine ? "cm-md-task-list-marker-line" : "",
              ]
                .filter(Boolean)
                .join(" "),
              attributes: {
                style: listMarkerLineStyle(
                  projection.depth,
                  projection.totalPrefixLane
                ),
              },
              markdownPreviewKind: kind,
              stableMarkdownPrefix: true,
            }),
            kind
          )
        }
        if (!marker.unorderedTask) {
          addDecoration(
            context,
            node.from,
            node.to,
            listMarkerSourceMark(
              label,
              marker.markerDepth,
              !marker.ordered,
              context.taskPresentationBase
                ? false
                : !selectionTouches(context, node.from, node.to),
              marker.lane
            ),
            "list-marker-source"
          )
          if (marker.separatorTo > node.to) {
            addDecoration(
              context,
              node.to,
              marker.separatorTo,
              listMarkerSeparatorMark(
                context.state.sliceDoc(node.to, marker.separatorTo)
              ),
              "list-marker-separator-source"
            )
          }
        }
      }
      return
    case "CodeInfo":
      if (parentIsInactive(context, node)) {
        addDecoration(
          context,
          node.from,
          node.to,
          hiddenUrl,
          `hidden:${node.name}`
        )
      }
      return
    case "URL":
      if (
        node.node.parent?.name !== "Link" &&
        node.node.parent?.name !== "Image" &&
        node.node.parent?.name !== "Autolink" &&
        node.node.parent?.name !== "LinkReference"
      ) {
        const resolved = resolveMarkdownLinkNode(context.state, node.node)
        if (!resolved) return
        addDecoration(
          context,
          node.from,
          node.to,
          resolved.activation ? webLinkMark : linkMark,
          "bare-link"
        )
        if (resolved.activation) {
          addDecoration(
            context,
            node.from,
            node.to,
            webLinkCursorMark,
            "bare-link-target"
          )
        }
      }
      return
    case "LinkMark":
      // Link and image children are handled together by decorateLink so the
      // label, marks, and destination stay in one coherent reveal unit.
      return
    case "EmphasisMark":
    case "StrikethroughMark":
    case "SuperscriptMark":
    case "SubscriptMark":
    case "CodeMark":
      if (parentIsInactive(context, node)) {
        addDecoration(
          context,
          node.from,
          node.to,
          hiddenDelimiter,
          `hidden:${node.name}`
        )
      }
      return
    case "QuoteMark":
      {
        const line = context.state.doc.lineAt(node.from)
        // A list line owns its complete quote container as one stable,
        // source-backed prefix. Replacing these marks independently would
        // collapse caret stops and make the list jump when the quote activates.
        if (
          context.listSourceBackedQuoteLines?.has(line.from) ||
          listLineOwnsQuoteMark(context, line, node)
        ) {
          return
        }
      }
      if (context.editingRange || parentIsInactive(context, node)) {
        const line = context.state.doc.lineAt(node.from)
        const leadingSource = context.state.sliceDoc(line.from, node.from)
        const hiddenFrom = /^[\t ]*$/.test(leadingSource)
          ? line.from
          : node.from
        const hiddenTo =
          context.state.sliceDoc(node.to, node.to + 1) === " "
            ? node.to + 1
            : node.to
        addDecoration(
          context,
          hiddenFrom,
          hiddenTo,
          hiddenDelimiter,
          `hidden:${node.name}`
        )
      }
      return
    case "HeaderMark":
      decorateHeaderMark(context, node)
  }
}

export function buildLivePreviewDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  selectionActive = true,
  stateBackedTasks = false
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  // Layout-owning callout/task indexes already publish the complete tree for
  // this immutable document before the view plugin builds its visible
  // decorations. Use that same cached tree so a newly visible callout never
  // waits for CodeMirror's background viewport parse before its quote marks
  // are hidden.
  const tree = completeMarkdownSyntaxTree(state)
  const editingRange = state.facet(calloutEditingRange)
  const editingCalloutTree = editingRange
    ? completeMarkdownSyntaxTree(state)
    : null
  const editingCallout = editingCalloutTree
    ? editingCalloutBlockquote(state, editingCalloutTree, editingRange)
    : null
  const editingCalloutQuoteMarks = new Map<number, SyntaxNode | null>()
  const definitionLists = new Map<number, DefinitionListSyntax | null>()
  const listContinuationProjections = new Map<
    number,
    ListContinuationProjection | null
  >()
  const listLineProjections = new Map<number, ListLineProjection | null>()
  const listMarkerLines = new Map<number, boolean>()
  const listSourceBackedQuoteLines = new Set<number>()
  const orderedListMarkerLanes = new Map<number, string>()

  for (const visible of visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        decorateNode(
          {
            definitionLists,
            editingCallout,
            editingCalloutQuoteMarks,
            editingCalloutTree,
            editingRange,
            listContinuationProjections,
            listLineProjections,
            listMarkerLines,
            listSourceBackedQuoteLines,
            orderedListMarkerLanes,
            state,
            ranges,
            seen,
            visible,
            selectionActive,
            stateBackedTasks,
            tree,
          },
          node
        )
      },
    })
  }

  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

const stablePrefixKinds = new Set([
  "definition-indent-source",
  "definition-marker-line",
  "definition-separator-source",
  "definition-source-mark",
  "line:cm-md-list-line",
  "list-indent-source",
  "list-marker-paint",
  "list-marker-separator-source",
  "list-marker-source",
  "list-marker",
  "list-quote-prefix-paint",
  "list-quote-prefix",
  "list-quote-prefix-source",
])

function stablePrefixDecoration(decoration: Decoration) {
  const kind = String(decoration.spec.markdownPreviewKind ?? "")
  return (
    decoration.spec.stableMarkdownPrefix === true ||
    stablePrefixKinds.has(kind) ||
    /^(?:task-)?list-marker-line:/.test(kind)
  )
}

function buildStablePrefixDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  tree: Tree,
  selection: EditorSelection,
  selectionActive: boolean
) {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  const definitionLists = new Map<number, DefinitionListSyntax | null>()
  const listContinuationProjections = new Map<
    number,
    ListContinuationProjection | null
  >()
  const listLineProjections = new Map<number, ListLineProjection | null>()
  const listMarkerLines = new Map<number, boolean>()
  const listSourceBackedQuoteLines = new Set<number>()
  const orderedListMarkerLanes = new Map<number, string>()
  const editingRange = state.facet(calloutEditingRange)
  const editingCalloutTree = editingRange
    ? completeMarkdownSyntaxTree(state)
    : null
  const editingCallout = editingCalloutTree
    ? editingCalloutBlockquote(state, editingCalloutTree, editingRange)
    : null
  const editingCalloutQuoteMarks = new Map<number, SyntaxNode | null>()
  for (const visible of visibleRanges) {
    const context: BuildContext = {
      definitionLists,
      editingCallout,
      editingCalloutQuoteMarks,
      editingCalloutTree,
      editingRange,
      listContinuationProjections,
      listLineProjections,
      listMarkerLines,
      listSourceBackedQuoteLines,
      orderedListMarkerLanes,
      ranges,
      seen,
      selection,
      selectionActive,
      state,
      stateBackedTasks: true,
      tree,
      visible,
    }
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (
          node.name === "ListItem" ||
          node.name === "ListMark" ||
          node.name === "DefinitionMark"
        ) {
          decorateNode(context, node)
        }
      },
    })
  }
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function rangeIntersectsVisibleRanges(
  from: number,
  to: number,
  visibleRanges: readonly VisibleRange[]
) {
  return visibleRanges.some((visible) =>
    from === to
      ? from >= visible.from && from <= visible.to
      : to > visible.from && from < visible.to
  )
}

function refreshStablePrefixDecorations(
  decorations: DecorationSet,
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  tree: Tree,
  selection: EditorSelection,
  selectionActive: boolean
) {
  const retained = decorations.update({
    filter: (from, to, decoration) =>
      !stablePrefixDecoration(decoration) ||
      !rangeIntersectsVisibleRanges(from, to, visibleRanges),
  })
  const additions = buildStablePrefixDecorations(
    state,
    visibleRanges,
    tree,
    selection,
    selectionActive
  )
  return additions.size === 0 ? retained : RangeSet.join([retained, additions])
}

const taskAtomicRange = Decoration.mark({})

function taskAtomicRanges(decorations: DecorationSet) {
  const ranges: Range<Decoration>[] = []
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    if (
      cursor.from < cursor.to &&
      cursor.value.spec.markdownPreviewKind === "task"
    ) {
      ranges.push(taskAtomicRange.range(cursor.from, cursor.to))
    }
  }
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

interface TaskPresentationIndex {
  allAtomicRanges: DecorationSet
  allDecorations: DecorationSet
  atomicRanges: DecorationSet
  decorations: DecorationSet
  editingRange: CalloutEditingRange | null
  readOnly: boolean
  tree: Tree
}

interface TaskRefreshRange {
  from: number
  to: number
}

function taskLineNeighborhood(
  state: EditorState,
  from: number,
  to: number
): TaskRefreshRange {
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

function expandTaskRefreshRange(
  state: EditorState,
  range: TaskRefreshRange,
  tree: Tree
) {
  const neighborhood = taskLineNeighborhood(state, range.from, range.to)
  let from = neighborhood.from
  let to = neighborhood.to
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.node.parent == null || node.node.parent.parent != null) return
      from = Math.min(from, node.from)
      to = Math.max(to, node.to)
      return false
    },
  })
  return { from, to }
}

function mergeTaskRefreshRanges(ranges: readonly TaskRefreshRange[]) {
  return mergeTableRanges(ranges)
}

function changedTaskSyntaxRanges(
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  const candidates: TaskRefreshRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const previous = expandTaskRefreshRange(
      transaction.startState,
      { from: fromA, to: toA },
      previousTree
    )
    candidates.push({
      from: transaction.changes.mapPos(previous.from, -1),
      to: transaction.changes.mapPos(previous.to, 1),
    })
    candidates.push(
      expandTaskRefreshRange(
        transaction.state,
        { from: fromB, to: toB },
        nextTree
      )
    )
  })
  return mergeTaskRefreshRanges(
    mergeTaskRefreshRanges(candidates).map((range) =>
      expandTaskRefreshRange(transaction.state, range, nextTree)
    )
  )
}

function taskPresentationDecorations(
  state: EditorState,
  tree: Tree,
  visibleRanges: readonly TaskRefreshRange[]
) {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  const definitionLists = new Map<number, DefinitionListSyntax | null>()
  const listContinuationProjections = new Map<
    number,
    ListContinuationProjection | null
  >()
  const listLineProjections = new Map<number, ListLineProjection | null>()
  const listMarkerLines = new Map<number, boolean>()
  const orderedListMarkerLanes = new Map<number, string>()
  for (const visible of visibleRanges) {
    const context: BuildContext = {
      definitionLists,
      editingCallout: null,
      editingCalloutTree: null,
      editingRange: null,
      listContinuationProjections,
      listLineProjections,
      listMarkerLines,
      orderedListMarkerLanes,
      ranges,
      seen,
      selectionActive: false,
      state,
      taskPresentationBase: true,
      tree,
      visible,
    }
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name === "TaskMarker") {
          decorateNode(context, node)
          return
        }
        if (node.name === "ListMark") {
          const line = state.doc.lineAt(node.from)
          const projection = listLineProjection(context, line)
          if (
            projection?.markers.some((marker) => marker.isTaskItem) === true
          ) {
            decorateNode(context, node)
          }
        }
      },
    })
  }
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

function presentedTaskRanges(
  ranges: DecorationSet,
  editingRange: CalloutEditingRange | null
) {
  return editingRange ? withoutTableRanges(ranges, [editingRange]) : ranges
}

function taskPresentationIndex(state: EditorState, tree: Tree) {
  const allDecorations = taskPresentationDecorations(state, tree, [
    { from: 0, to: state.doc.length },
  ])
  const allAtomicRanges = taskAtomicRanges(allDecorations)
  const editingRange = state.facet(calloutEditingRange)
  return {
    allAtomicRanges,
    allDecorations,
    atomicRanges: presentedTaskRanges(allAtomicRanges, editingRange),
    decorations: presentedTaskRanges(allDecorations, editingRange),
    editingRange,
    readOnly: state.readOnly,
    tree,
  }
}

const taskPresentationState = StateField.define<TaskPresentationIndex>({
  create(state) {
    const tree = completeMarkdownSyntaxTree(state)
    return taskPresentationIndex(state, tree)
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
      (completeTreeAfterSyntaxChange != null &&
        completeTreeAfterSyntaxChange !== value.tree)
    const readOnlyChanged = value.readOnly !== transaction.state.readOnly
    const nextEditingRange = transaction.state.facet(calloutEditingRange)
    const editingChanged =
      value.editingRange?.from !== nextEditingRange?.from ||
      value.editingRange?.to !== nextEditingRange?.to

    if (!syntaxChanged && !readOnlyChanged && !editingChanged) return value

    const tree = transaction.docChanged
      ? updateCompleteMarkdownSyntaxTree(
          transaction.state,
          transaction.changes,
          value.tree
        )
      : (completeTreeAfterSyntaxChange ?? value.tree)
    if (!transaction.docChanged || readOnlyChanged) {
      return taskPresentationIndex(transaction.state, tree)
    }

    const refreshRanges = markdownBlockPairingMayChange(transaction)
      ? [{ from: 0, to: transaction.state.doc.length }]
      : changedTaskSyntaxRanges(transaction, value.tree, tree)
    let allDecorations = withoutTableRanges(
      value.allDecorations.map(transaction.changes),
      refreshRanges
    )
    let allAtomicRanges = withoutTableRanges(
      value.allAtomicRanges.map(transaction.changes),
      refreshRanges
    )
    const additions = taskPresentationDecorations(
      transaction.state,
      tree,
      refreshRanges
    )
    if (additions.size > 0) {
      allDecorations = RangeSet.join([allDecorations, additions])
      allAtomicRanges = RangeSet.join([
        allAtomicRanges,
        taskAtomicRanges(additions),
      ])
    }
    return {
      allAtomicRanges,
      allDecorations,
      atomicRanges: presentedTaskRanges(allAtomicRanges, nextEditingRange),
      decorations: presentedTaskRanges(allDecorations, nextEditingRange),
      editingRange: nextEditingRange,
      readOnly: transaction.state.readOnly,
      tree,
    }
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.from(field, (value) => () => value.atomicRanges),
    EditorView.bidiIsolatedRanges.from(
      field,
      (value) => () => value.decorations
    ),
  ],
})

function taskAtomContaining(
  ranges: DecorationSet,
  position: number
): { from: number; to: number } | null {
  let containing: { from: number; to: number } | null = null
  ranges.between(Math.max(0, position - 1), position + 1, (from, to) => {
    if (position > from && position < to) containing = { from, to }
  })
  return containing
}

function normalizeTaskSelectionTransaction(transaction: Transaction) {
  const presentation = transaction.state.field(taskPresentationState, false)
  if (!presentation) return transaction
  let changed = false
  const ranges = transaction.newSelection.ranges.map((range) => {
    if (range.empty) {
      const atom = taskAtomContaining(presentation.atomicRanges, range.head)
      if (!atom) return range
      changed = true
      const position =
        range.head - atom.from < atom.to - range.head ? atom.from : atom.to
      return EditorSelection.cursor(position, position === atom.from ? 1 : -1)
    }

    const fromAtom = taskAtomContaining(presentation.atomicRanges, range.from)
    const toAtom = taskAtomContaining(presentation.atomicRanges, range.to)
    const from = fromAtom?.from ?? range.from
    const to = toAtom?.to ?? range.to
    if (from === range.from && to === range.to) return range
    changed = true
    return EditorSelection.range(
      range.anchor === range.from ? from : to,
      range.head === range.from ? from : to
    )
  })
  if (!changed) return transaction
  return [
    transaction,
    {
      selection: EditorSelection.create(
        ranges,
        transaction.newSelection.mainIndex
      ),
      sequential: true,
    },
  ]
}

class LivePreviewPlugin {
  decorations: DecorationSet = Decoration.none

  private readonly view: EditorView
  private readonly ownerWindow: Window | null
  private pointerSelecting = false
  private pointerSelection: EditorSelection | null = null
  private pointerSelectionActive = false
  private activePointerId: number | null = null
  private wasComposing = false
  private destroyed = false
  private refreshFrame: number | null = null

  constructor(view: EditorView) {
    this.view = view
    this.ownerWindow = view.dom.ownerDocument.defaultView
    this.setDecorations(
      buildLivePreviewDecorations(
        view.state,
        view.visibleRanges,
        livePreviewSelectionIsActive(view.state),
        true
      )
    )
    view.contentDOM.addEventListener("pointerdown", this.handlePointerDown)
    view.contentDOM.addEventListener(
      "lostpointercapture",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.addEventListener("pointermove", this.handlePointerMove)
    this.ownerWindow?.addEventListener(
      "pointerup",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.addEventListener(
      "pointercancel",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.addEventListener("blur", this.handlePointerSelectionEnd)
    this.reconcileFocus(view)
  }

  update(update: ViewUpdate) {
    const composing = update.view.compositionStarted
    this.reconcileFocus(update.view)

    if (this.pointerSelecting || composing) {
      let decorations = this.decorations
      if (update.docChanged) {
        decorations = decorations.map(update.changes)
        if (this.pointerSelection) {
          this.pointerSelection = this.pointerSelection.map(update.changes)
        }
      } else if (composing && !this.wasComposing) {
        decorations = buildLivePreviewDecorations(
          update.state,
          update.view.visibleRanges,
          livePreviewSelectionIsActive(update.state),
          true
        )
      }
      if (this.pointerSelecting && update.viewportChanged) {
        const taskPresentation = update.state.field(
          taskPresentationState,
          false
        )
        decorations = refreshStablePrefixDecorations(
          decorations,
          update.state,
          update.view.visibleRanges,
          taskPresentation?.tree ?? completeMarkdownSyntaxTree(update.state),
          this.pointerSelection ?? update.state.selection,
          this.pointerSelectionActive
        )
      }
      this.setDecorations(decorations)
      this.wasComposing = composing
      return
    }

    const syntaxChanged =
      syntaxTree(update.startState) !== syntaxTree(update.state)
    const readOnlyChanged = update.startState.readOnly !== update.state.readOnly
    const requested = update.transactions.some(livePreviewRefreshRequested)

    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      update.focusChanged ||
      syntaxChanged ||
      readOnlyChanged ||
      requested ||
      this.wasComposing !== composing
    ) {
      this.setDecorations(
        buildLivePreviewDecorations(
          update.state,
          update.view.visibleRanges,
          livePreviewSelectionIsActive(update.state),
          true
        )
      )
    }

    this.wasComposing = composing
  }

  destroy() {
    this.destroyed = true
    this.view.contentDOM.removeEventListener(
      "pointerdown",
      this.handlePointerDown
    )
    this.view.contentDOM.removeEventListener(
      "lostpointercapture",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.removeEventListener("pointermove", this.handlePointerMove)
    this.ownerWindow?.removeEventListener(
      "pointerup",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.removeEventListener(
      "pointercancel",
      this.handlePointerSelectionEnd
    )
    this.ownerWindow?.removeEventListener(
      "blur",
      this.handlePointerSelectionEnd
    )
    if (this.refreshFrame != null)
      this.ownerWindow?.cancelAnimationFrame(this.refreshFrame)
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (
      event.target instanceof Element &&
      (event.target.closest(interactivePreviewWidgetSelector) ||
        event.target.closest(".cm-md-table-cell"))
    ) {
      return
    }
    this.pointerSelecting = true
    this.pointerSelection = this.view.state.selection
    this.pointerSelectionActive = livePreviewSelectionIsActive(this.view.state)
    this.activePointerId = event.pointerId
    try {
      this.view.contentDOM.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic input and a pointer canceled by the OS before this handler
      // can reject capture. Window blur/move remain recovery paths.
    }
  }

  private setDecorations(decorations: DecorationSet) {
    this.decorations = decorations
  }

  private reconcileFocus(view: EditorView, deferred = false) {
    const focused = view.hasFocus
    if (
      this.destroyed ||
      this.pointerSelecting ||
      view.compositionStarted ||
      focused === view.state.field(livePreviewEditorFocused)
    ) {
      return
    }
    if (!deferred) {
      queuePreviewRebuild(() => this.reconcileFocus(view, true))
      return
    }
    view.dispatch({
      effects: [
        setLivePreviewEditorFocused.of(focused),
        refreshLivePreview.of(null),
      ],
    })
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (this.pointerSelecting && (event.buttons & 1) === 0) {
      this.finishPointerSelection()
    }
  }

  private readonly handlePointerSelectionEnd = () => {
    this.finishPointerSelection()
  }

  private finishPointerSelection() {
    if (!this.pointerSelecting || this.destroyed) return
    this.pointerSelecting = false
    this.pointerSelection = null
    this.pointerSelectionActive = false
    const pointerId = this.activePointerId
    this.activePointerId = null
    if (
      pointerId != null &&
      this.view.contentDOM.hasPointerCapture(pointerId)
    ) {
      this.view.contentDOM.releasePointerCapture(pointerId)
    }

    const refresh = () => {
      this.refreshFrame = null
      if (!this.destroyed)
        this.view.dispatch({
          effects: [
            this.view.scrollSnapshot(),
            setLivePreviewEditorFocused.of(this.view.hasFocus),
            refreshLivePreview.of(null),
          ],
        })
    }

    this.refreshFrame = this.ownerWindow?.requestAnimationFrame(refresh) ?? null
    if (this.refreshFrame == null) refresh()
  }
}

class TableStructurePlugin {
  decorations: DecorationSet

  private wasComposing = false

  constructor(view: EditorView) {
    this.decorations = buildTableStructureDecorations(view.state, [
      { from: 0, to: view.state.doc.length },
    ])
  }

  update(update: ViewUpdate) {
    const composing = update.view.compositionStarted
    if (composing) {
      if (update.docChanged)
        this.decorations = this.decorations.map(update.changes)
      this.wasComposing = true
      return
    }

    const previousEditing = update.startState.facet(calloutEditingRange)
    const editing = update.state.facet(calloutEditingRange)
    const editingChanged =
      previousEditing?.from !== editing?.from ||
      previousEditing?.to !== editing?.to
    const tableSelectionChanged =
      update.startState.field(tableCellRangeSelectionState, false) !==
      update.state.field(tableCellRangeSelectionState, false)
    if (this.wasComposing) {
      this.decorations = buildTableStructureDecorations(update.state, [
        { from: 0, to: update.state.doc.length },
      ])
      this.wasComposing = false
      return
    }

    const refreshRanges: { from: number; to: number }[] = []
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
      refreshRanges.push(
        ...update.state.field(tableLayoutState).refreshTableRanges
      )
    }
    if (tableSelectionChanged) {
      const previousSelection = update.startState.field(
        tableCellRangeSelectionState,
        false
      )
      const selection = update.state.field(tableCellRangeSelectionState, false)
      if (previousSelection) {
        refreshRanges.push({
          from: update.changes.mapPos(previousSelection.tableFrom, 1),
          to: update.changes.mapPos(previousSelection.tableTo, -1),
        })
      }
      if (selection) {
        refreshRanges.push({
          from: selection.tableFrom,
          to: selection.tableTo,
        })
      }
    }
    if (editingChanged) {
      const previousIndex = update.startState.field(tableLayoutState)
      const index = update.state.field(tableLayoutState)
      if (previousEditing) {
        refreshRanges.push(
          ...tableLayoutsBetween(
            previousIndex,
            previousEditing.from,
            previousEditing.to
          ).map((layout) => ({
            from: update.changes.mapPos(layout.from, 1),
            to: update.changes.mapPos(layout.to, -1),
          }))
        )
      }
      if (editing) {
        refreshRanges.push(
          ...tableLayoutsBetween(index, editing.from, editing.to).map(
            (layout) => ({ from: layout.from, to: layout.to })
          )
        )
      }
    }
    for (const range of mergeTableRanges(refreshRanges)) {
      this.decorations = this.decorations.update({
        filter: (from, to) =>
          from === to
            ? from < range.from || from > range.to
            : to <= range.from || from >= range.to,
        filterFrom: range.from,
        filterTo: range.to,
      })
      const additions = buildTableStructureDecorations(update.state, [range])
      this.decorations = RangeSet.join([this.decorations, additions])
    }
    if (update.selectionSet) {
      scrollTableSelectionIntoView(
        update.view,
        update.state.selection.main.head
      )
    }
    this.wasComposing = false
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.bidiIsolatedRanges.of(
      (view) => view.plugin(plugin)?.decorations ?? Decoration.none
    ),
})

const tableStructurePlugin = ViewPlugin.fromClass(TableStructurePlugin, {
  decorations: (plugin) => plugin.decorations,
})

interface LinkReferencePreviewState {
  decorations: DecorationSet
  selectionActive: boolean
}

function linkReferencePreviewExtension() {
  return StateField.define<LinkReferencePreviewState>({
    create(state) {
      const selectionActive = livePreviewSelectionIsActive(state)
      return {
        decorations: decorationsForLinkReferenceBlocks(
          state,
          markdownLinkReferenceBlocks(state),
          selectionActive
        ),
        selectionActive,
      }
    },
    update(value, transaction) {
      const selectionActive = livePreviewSelectionIsActive(transaction.state)
      const selectionChanged = !transaction.startState.selection.eq(
        transaction.state.selection
      )
      const requested = livePreviewRefreshRequested(transaction)
      if (preservePreviewDuringPointerSelection(transaction)) {
        return transaction.docChanged
          ? {
              ...value,
              decorations: value.decorations.map(transaction.changes),
            }
          : value
      }
      if (
        !transaction.docChanged &&
        !requested &&
        !selectionChanged &&
        selectionActive === value.selectionActive
      ) {
        return value
      }

      let decorations = transaction.docChanged
        ? value.decorations.map(transaction.changes)
        : value.decorations
      const refreshRanges: MarkdownLinkReferenceRange[] = []
      if (transaction.docChanged) {
        refreshRanges.push(
          ...changedMarkdownLinkReferenceRanges(transaction.state)
        )
      } else if (
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ) {
        refreshRanges.push(
          ...changedMarkdownLinkReferenceRanges(transaction.state)
        )
      }
      if (requested) {
        refreshRanges.push({ from: 0, to: transaction.state.doc.length })
      }

      if (selectionChanged || selectionActive !== value.selectionActive) {
        refreshRanges.push(
          ...selectionLinkReferenceRanges(
            transaction.startState,
            value.selectionActive
          ).map((range) => ({
            from: transaction.changes.mapPos(range.from, -1),
            to: transaction.changes.mapPos(range.to, 1),
          })),
          ...selectionLinkReferenceRanges(transaction.state, selectionActive)
        )
      }

      decorations = refreshLinkReferenceDecorations(
        decorations,
        transaction.state,
        mergeLinkReferenceRanges(refreshRanges),
        selectionActive
      )
      return { decorations, selectionActive }
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  })
}

export interface LivePreviewExtensionOptions {
  readonly codeBlock?: CodeBlockExtensionOptions
}

function renderedSyntaxRangeAt(
  state: EditorState,
  position: number,
  nodeName: string
) {
  const tree = completeMarkdownSyntaxTree(state)
  for (const candidate of nearbyPreviewPositions(state, position)) {
    for (const side of [1, -1] as const) {
      let node: SyntaxNode | null = tree.resolveInner(candidate, side)
      while (node) {
        if (
          node.name === nodeName &&
          node.from <= candidate &&
          candidate <= node.to
        ) {
          return { from: node.from, to: node.to }
        }
        node = node.parent
      }
    }
  }
  return null
}

function renderedLinkAtPointer(
  view: EditorView,
  event: Pick<MouseEvent, "clientX" | "clientY">
) {
  const ownerDocument = view.dom.ownerDocument
  for (const offset of [0, -2 * view.scaleX, 2 * view.scaleX]) {
    const link = ownerDocument
      .elementsFromPoint(event.clientX + offset, event.clientY)
      .map((target) => target.closest<HTMLElement>(".cm-md-link"))
      .find(
        (candidate): candidate is HTMLElement =>
          candidate != null && view.contentDOM.contains(candidate)
      )
    if (link) return link
  }
  return null
}

function renderedLinkRangeAt(state: EditorState, position: number) {
  const tree = completeMarkdownSyntaxTree(state)
  for (const candidate of nearbyPreviewPositions(state, position)) {
    for (const side of [1, -1] as const) {
      let node: SyntaxNode | null = tree.resolveInner(candidate, side)
      while (node) {
        if (
          (node.name === "Link" || node.name === "Autolink") &&
          node.from <= position &&
          position <= node.to
        ) {
          let firstMark: SyntaxNode | null = null
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name !== "LinkMark") continue
            if (!firstMark) firstMark = child
            else {
              return {
                from: node.from,
                labelFrom: firstMark.to,
                labelTo: child.from,
                to: node.to,
              }
            }
          }
        }
        node = node.parent
      }
    }
  }
  return null
}

function renderedLinkEdgeAtPointer(
  view: EditorView,
  range: { readonly labelFrom: number; readonly labelTo: number },
  event: Pick<MouseEvent, "clientX" | "clientY">
) {
  let closest: { distance: number; position: number } | null = null
  for (const [position, side] of [
    [range.labelFrom, 1],
    [range.labelTo, -1],
  ] as const) {
    const bounds = view.coordsAtPos(position, side)
    if (
      !bounds ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      continue
    }
    const distance = Math.min(
      Math.abs(event.clientX - bounds.left),
      Math.abs(event.clientX - bounds.right)
    )
    if (
      distance <= 2 * view.scaleX &&
      (!closest || distance < closest.distance)
    ) {
      closest = { distance, position }
    }
  }
  return closest?.position ?? null
}

function collapsedLinkSourceAt(
  view: EditorView,
  range: {
    readonly from: number
    readonly labelFrom: number
    readonly labelTo: number
    readonly to: number
  },
  position: number
) {
  const probe =
    position <= range.labelFrom && range.from < range.labelFrom
      ? range.labelFrom - 1
      : position >= range.labelTo && range.labelTo < range.to
        ? Math.min(Math.max(position, range.labelTo), range.to - 1)
        : null
  return probe != null && view.coordsForChar(probe) == null
}

function livePreviewPointerPosition(
  view: EditorView,
  event: Pick<MouseEvent, "clientX" | "clientY" | "target">
) {
  const raw = sourceLinePointerPosition(view, event)
  if (!raw) return null
  const rawRange = renderedLinkRangeAt(view.state, raw.pos)
  const link = renderedLinkAtPointer(view, event)
  const range =
    rawRange ??
    (link
      ? renderedLinkRangeAt(
          view.state,
          previewPositionAtDOM(view, link, raw.pos)
        )
      : null)
  if (!range) return raw
  if (!link && !collapsedLinkSourceAt(view, range, raw.pos)) {
    // The source is intentionally revealed, so retain precise positions in
    // its delimiters and destination. Character geometry remains aligned with
    // the mounted decorations while pointer-selection updates are frozen; a
    // state-only reveal check can be one drag event ahead of the rendered DOM.
    return raw
  }
  const edgePosition = renderedLinkEdgeAtPointer(view, range, event)

  // The label's logical end is immediately followed by its hidden destination.
  // Use CodeMirror's bidi-aware source coordinates to map either visual edge
  // to the complete construct while retaining interior precision.
  if (
    (raw.pos <= range.labelFrom || edgePosition === range.labelFrom) &&
    range.from < range.labelFrom
  ) {
    return { assoc: 1 as const, clamped: true, pos: range.from }
  }
  if (
    (raw.pos >= range.labelTo || edgePosition === range.labelTo) &&
    range.to > range.labelTo
  ) {
    return { assoc: -1 as const, clamped: true, pos: range.to }
  }
  return raw
}

const livePreviewPointerSelection = semanticPreviewSelectionResolvers.of({
  priority: 50,
  resolve(view, target, position) {
    const image = target.closest<HTMLElement>(".cm-md-image")
    if (image) {
      const sourcePosition = previewPositionAtDOM(view, image, position)
      const range = renderedSyntaxRangeAt(view.state, sourcePosition, "Image")
      return range
        ? { dragSelection: "atomic" as const, element: image, ...range }
        : null
    }
    return null
  },
})

function livePreviewSourceLineMouseSelectionStyle(
  view: EditorView,
  event: MouseEvent
): MouseSelectionStyle | null {
  if (
    event.button !== 0 ||
    event.detail !== 1 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return null
  }
  const start = livePreviewPointerPosition(view, event)
  if (!start) return null

  let startPosition = start.pos
  let startSelection = view.state.selection
  return {
    update(update) {
      if (!update.docChanged) return
      startPosition = update.changes.mapPos(startPosition, start.assoc)
      startSelection = startSelection.map(update.changes)
    },
    get(currentEvent, extend, multiple) {
      const current =
        livePreviewPointerPosition(view, currentEvent) ??
        view.posAndSideAtCoords(
          { x: currentEvent.clientX, y: currentEvent.clientY },
          false
        )
      const range =
        extend || current.pos === startPosition
          ? EditorSelection.cursor(current.pos, current.assoc)
          : EditorSelection.range(
              startPosition,
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
    },
  }
}

const livePreviewSourceLineMouseSelection = EditorView.mouseSelectionStyle.of(
  livePreviewSourceLineMouseSelectionStyle
)

export function livePreviewExtension(
  options: LivePreviewExtensionOptions = {}
) {
  return [
    EditorView.editorAttributes.of({ class: "cm-md-live" }),
    yamlFrontMatterWrapperState,
    markdownLinkReferenceIndexExtension(),
    linkReferencePreviewExtension(),
    inlineCodeNormalizationExtension(livePreviewSelectionIsActive),
    codeBlockExtension(options.codeBlock),
    livePreviewSourceLineMouseSelection,
    // A table can live inside a quote/callout wrapper. Block-wrapper facet
    // precedence outranks each wrapper's local rank, so keep the narrower
    // table wrapper inside every enclosing semantic block.
    Prec.highest(tableLayoutState),
    calloutBlockExtension({
      selectionActiveState: livePreviewSelectionIsActive,
    }),
    Prec.high(nestedHorizontalSelectionScrollExtension),
    taskPresentationState,
    tableCellRangeSelectionExtension,
    tableExitInputHandler,
    tableMultilinePasteHandler,
    tableSelectionAssociationFilter,
    tableMotionKeymap,
    livePreviewPointerSelection,
    Prec.lowest(tableStructurePlugin),
    livePreviewPlugin,
  ]
}
