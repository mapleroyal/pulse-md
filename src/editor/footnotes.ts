import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode, Tree } from "@lezer/common"
import {
  StateEffect,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"

import {
  completeMarkdownSyntaxTree,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  firstNearbyPreviewRange,
  interactivePreviewWidgetSelector,
  previewPositionAtDOM,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"
import { optionalMarkdownNodeNames } from "./markdown-extensions"

interface DocumentRange {
  readonly from: number
  readonly to: number
}

export interface FootnoteReference {
  readonly definitionFrom: number
  readonly from: number
  readonly identifier: string
  readonly number: number
  readonly to: number
}

export interface FootnoteDefinition {
  readonly contentFrom: number
  readonly firstReferenceFrom: number | null
  readonly from: number
  readonly identifier: string
  readonly markerTo: number
  readonly number: number
  readonly to: number
}

export interface FootnoteIndex {
  readonly definitions: readonly FootnoteDefinition[]
  readonly references: readonly FootnoteReference[]
  /** Every parsed reference/definition, including unresolved and duplicate ones. */
  readonly syntaxRanges: readonly DocumentRange[]
}

function footnoteIdentifier(state: EditorState, node: SyntaxNode) {
  const label = node.getChild(optionalMarkdownNodeNames.footnoteLabel)
  return label
    ? state.sliceDoc(label.from, label.to).normalize("NFKC").toLowerCase()
    : null
}

function definitionMarkerTo(node: SyntaxNode) {
  let markerTo = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === optionalMarkdownNodeNames.footnoteMark) {
      markerTo = Math.max(markerTo, child.to)
    }
  }
  return markerTo
}

function definitionContentFrom(state: EditorState, markerTo: number) {
  const line = state.doc.lineAt(markerTo)
  const whitespace = /^[\t ]*/.exec(state.sliceDoc(markerTo, line.to))?.[0]
  return markerTo + (whitespace?.length ?? 0)
}

export type FootnotePreviewRangeKind = "definition-label" | "reference"

/** Resolves the exact source replaced by a rendered footnote affordance. */
export function footnotePreviewRangeAt(
  state: EditorState,
  position: number,
  kind: FootnotePreviewRangeKind
): DocumentRange | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const expectedNode =
    kind === "reference"
      ? optionalMarkdownNodeNames.footnoteReference
      : optionalMarkdownNodeNames.footnoteDefinition
  const tree = completeMarkdownSyntaxTree(state)
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (
        node.name === expectedNode &&
        node.from <= boundedPosition &&
        boundedPosition <= node.to
      ) {
        if (kind === "reference") return { from: node.from, to: node.to }
        const markerTo = definitionMarkerTo(node)
        return {
          from: node.from,
          to: Math.max(markerTo, definitionContentFrom(state, markerTo)),
        }
      }
      node = node.parent
    }
  }
  return null
}

export function buildFootnoteIndex(
  state: EditorState,
  tree: Tree = completeMarkdownSyntaxTree(state)
): FootnoteIndex {
  const rawReferences: Array<{
    from: number
    identifier: string
    to: number
  }> = []
  const rawDefinitions: Array<{
    contentFrom: number
    from: number
    identifier: string
    markerTo: number
    to: number
  }> = []
  const syntaxRanges: Array<{ from: number; to: number }> = []
  const addSyntaxRange = (from: number, to: number) => {
    const previous = syntaxRanges.at(-1)
    if (!previous || previous.to < from) syntaxRanges.push({ from, to })
    else if (previous.to < to) previous.to = to
  }

  tree.iterate({
    enter(node) {
      if (node.name === optionalMarkdownNodeNames.footnoteReference) {
        const identifier = footnoteIdentifier(state, node.node)
        if (identifier) {
          rawReferences.push({
            from: node.from,
            identifier,
            to: node.to,
          })
          addSyntaxRange(node.from, node.to)
        }
        return false
      }
      if (node.name === optionalMarkdownNodeNames.footnoteDefinition) {
        const identifier = footnoteIdentifier(state, node.node)
        if (identifier) {
          const markerTo = definitionMarkerTo(node.node)
          rawDefinitions.push({
            contentFrom: definitionContentFrom(state, markerTo),
            from: node.from,
            identifier,
            markerTo,
            to: node.to,
          })
          addSyntaxRange(node.from, node.to)
        }
      }
    },
  })

  const firstDefinitionByIdentifier = new Map<
    string,
    (typeof rawDefinitions)[number]
  >()
  for (const definition of rawDefinitions) {
    if (!firstDefinitionByIdentifier.has(definition.identifier)) {
      firstDefinitionByIdentifier.set(definition.identifier, definition)
    }
  }

  const numberByIdentifier = new Map<string, number>()
  const firstReferenceByIdentifier = new Map<string, number>()
  for (const reference of rawReferences) {
    if (!firstDefinitionByIdentifier.has(reference.identifier)) continue
    if (!numberByIdentifier.has(reference.identifier)) {
      numberByIdentifier.set(reference.identifier, numberByIdentifier.size + 1)
      firstReferenceByIdentifier.set(reference.identifier, reference.from)
    }
  }
  for (const definition of rawDefinitions) {
    if (!numberByIdentifier.has(definition.identifier)) {
      numberByIdentifier.set(definition.identifier, numberByIdentifier.size + 1)
    }
  }

  const references: FootnoteReference[] = []
  for (const reference of rawReferences) {
    const definition = firstDefinitionByIdentifier.get(reference.identifier)
    const number = numberByIdentifier.get(reference.identifier)
    if (!definition || number == null) continue
    references.push({
      ...reference,
      definitionFrom: definition.contentFrom,
      number,
    })
  }

  const definitions: FootnoteDefinition[] = []
  const includedIdentifiers = new Set<string>()
  for (const definition of rawDefinitions) {
    if (includedIdentifiers.has(definition.identifier)) continue
    includedIdentifiers.add(definition.identifier)
    definitions.push({
      ...definition,
      firstReferenceFrom:
        firstReferenceByIdentifier.get(definition.identifier) ?? null,
      number: numberByIdentifier.get(definition.identifier)!,
    })
  }

  return { definitions, references, syntaxRanges }
}

function mapRange<T extends DocumentRange>(range: T, changes: ChangeDesc): T {
  return {
    ...range,
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
  }
}

/** Map an unchanged footnote index through an ordinary document edit. */
export function mapFootnoteIndex(
  index: FootnoteIndex,
  changes: ChangeDesc
): FootnoteIndex {
  return {
    definitions: index.definitions.map((definition) => ({
      ...mapRange(definition, changes),
      contentFrom: changes.mapPos(definition.contentFrom, 1),
      firstReferenceFrom:
        definition.firstReferenceFrom == null
          ? null
          : changes.mapPos(definition.firstReferenceFrom, 1),
      markerTo: changes.mapPos(definition.markerTo, -1),
    })),
    references: index.references.map((reference) => ({
      ...mapRange(reference, changes),
      definitionFrom: changes.mapPos(reference.definitionFrom, 1),
    })),
    syntaxRanges: index.syntaxRanges.map((range) => mapRange(range, changes)),
  }
}

const plainMarkdownCharacter = /^[\p{L}\p{N}]$/u
const ordinaryIdentifierEdit = /^[\p{L}\p{N}\p{M}]*$/u

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

function ordinaryInlineChange(
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
  if (
    !ordinaryIdentifierEdit.test(oldChangedText) ||
    !ordinaryIdentifierEdit.test(newChangedText)
  ) {
    return false
  }

  // Parsed constructs—including unresolved references—are covered by
  // syntaxRanges. The remaining ordinary-character case that can create new
  // syntax is filling an empty `[^]` label, which has no parsed range yet.
  const fillsEmptyLabel =
    fromA === toA &&
    fromA >= oldLine.from + 2 &&
    startState.sliceDoc(fromA - 2, fromA + 1) === "[^]"
  return !fillsEmptyLabel
}

/**
 * Whether an edit cannot create, remove, relabel, or re-order a footnote.
 * The deliberately narrow fast path covers normal letter/number typing while
 * every edit near footnote syntax stays on the exact incremental-parse path.
 */
export function canMapFootnoteIndex(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  index: FootnoteIndex
) {
  let touchesFootnoteSyntax = false
  changes.iterChangedRanges((fromA, toA) => {
    if (touchesFootnoteSyntax) return

    // syntaxRanges are sorted and non-overlapping. Find the first range whose
    // end reaches this inclusive change boundary instead of checking every
    // footnote in a reference-dense document.
    let low = 0
    let high = index.syntaxRanges.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (index.syntaxRanges[middle]!.to < fromA) low = middle + 1
      else high = middle
    }
    const candidate = index.syntaxRanges[low]
    if (candidate && candidate.from <= toA) touchesFootnoteSyntax = true
  })
  if (touchesFootnoteSyntax) return false

  let safe = true
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (
      safe &&
      !ordinaryInlineChange(startState, state, fromA, toA, fromB, toB)
    ) {
      safe = false
    }
  })
  return safe
}

type FootnoteNavigateCallback = (view: EditorView) => void

function openLinkModifierPressed(event: MouseEvent) {
  const platform = event.view?.navigator.platform ?? ""
  const primary = /Mac|iPhone|iPad/.test(platform)
    ? event.metaKey
    : event.ctrlKey
  return primary && !event.altKey && !event.shiftKey
}

function widgetDocumentPosition(view: EditorView, element: HTMLElement) {
  try {
    return view.posAtDOM(element)
  } catch {
    return null
  }
}

function selectWidgetSource(view: EditorView, element: HTMLElement) {
  const position = widgetDocumentPosition(view, element)
  if (position == null) return
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
}

function navigateTo(
  view: EditorView,
  position: number,
  onNavigate: FootnoteNavigateCallback | undefined
) {
  onNavigate?.(view)
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
    userEvent: "select.goto",
  })
  view.focus()
}

class FootnoteReferenceWidget extends WidgetType {
  readonly definitionFrom: number
  readonly identifier: string
  readonly number: number
  readonly onNavigate: FootnoteNavigateCallback | undefined

  constructor(
    identifier: string,
    number: number,
    definitionFrom: number,
    onNavigate: FootnoteNavigateCallback | undefined
  ) {
    super()
    this.identifier = identifier
    this.number = number
    this.definitionFrom = definitionFrom
    this.onNavigate = onNavigate
  }

  eq(other: FootnoteReferenceWidget) {
    return (
      this.identifier === other.identifier &&
      this.number === other.number &&
      this.definitionFrom === other.definitionFrom &&
      this.onNavigate === other.onNavigate
    )
  }

  ignoreEvent() {
    return true
  }

  toDOM(view: EditorView) {
    const reference = view.dom.ownerDocument.createElement("sup")
    reference.className = "cm-md-footnote-reference"
    const button = view.dom.ownerDocument.createElement("button")
    button.type = "button"
    button.className = "cm-md-footnote-navigation cm-md-openable-link"
    button.textContent = String(this.number)
    const label = `Go to footnote ${this.number}: ${this.identifier}`
    button.dataset.markdownLinkTitle = label
    button.setAttribute("aria-label", label)
    button.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return
      if (openLinkModifierPressed(event)) event.preventDefault()
      else selectWidgetSource(view, button)
    })
    button.addEventListener("click", (event) => {
      if (event.detail !== 0 && !openLinkModifierPressed(event)) return
      navigateTo(view, this.definitionFrom, this.onNavigate)
    })
    reference.append(button)
    return reference
  }
}

class FootnoteDefinitionLabelWidget extends WidgetType {
  readonly firstReferenceFrom: number | null
  readonly identifier: string
  readonly number: number
  readonly onNavigate: FootnoteNavigateCallback | undefined

  constructor(
    identifier: string,
    number: number,
    firstReferenceFrom: number | null,
    onNavigate: FootnoteNavigateCallback | undefined
  ) {
    super()
    this.identifier = identifier
    this.number = number
    this.firstReferenceFrom = firstReferenceFrom
    this.onNavigate = onNavigate
  }

  eq(other: FootnoteDefinitionLabelWidget) {
    return (
      this.identifier === other.identifier &&
      this.number === other.number &&
      this.firstReferenceFrom === other.firstReferenceFrom &&
      this.onNavigate === other.onNavigate
    )
  }

  ignoreEvent() {
    return true
  }

  toDOM(view: EditorView) {
    const label = view.dom.ownerDocument.createElement(
      this.firstReferenceFrom == null ? "span" : "button"
    )
    label.className =
      this.firstReferenceFrom == null
        ? "cm-md-footnote-definition-label"
        : "cm-md-footnote-definition-label cm-md-openable-link"
    label.textContent = `${this.number}.`
    if (label instanceof HTMLButtonElement) {
      label.type = "button"
      const navigationLabel = `Return to footnote reference ${this.number}`
      label.dataset.markdownLinkTitle = navigationLabel
      label.setAttribute("aria-label", navigationLabel)
      label.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return
        if (openLinkModifierPressed(event)) event.preventDefault()
        else selectWidgetSource(view, label)
      })
      label.addEventListener("click", (event) => {
        if (event.detail !== 0 && !openLinkModifierPressed(event)) return
        navigateTo(view, this.firstReferenceFrom!, this.onNavigate)
      })
    }
    return label
  }
}

function intersectsVisible(
  range: DocumentRange,
  visibleRanges: readonly DocumentRange[]
) {
  return visibleRanges.some(
    (visible) => visible.from <= range.to && visible.to >= range.from
  )
}

function selectionTouches(
  state: EditorState,
  range: DocumentRange,
  selectionActive: boolean
) {
  return state.selection.ranges.some((selection) =>
    selection.empty
      ? selectionActive &&
        selection.head >= range.from &&
        selection.head <= range.to
      : selection.from < range.to && selection.to > range.from
  )
}

function addVisibleLineDecorations(
  state: EditorState,
  visibleRanges: readonly DocumentRange[],
  from: number,
  to: number,
  ranges: Range<Decoration>[]
) {
  const decorated = new Set<number>()
  for (const visible of visibleRanges) {
    const clippedFrom = Math.max(from, visible.from)
    const clippedTo = Math.min(to, visible.to)
    if (clippedFrom > clippedTo) continue
    let line = state.doc.lineAt(clippedFrom)
    const lastLine = state.doc.lineAt(
      Math.max(clippedFrom, clippedTo > clippedFrom ? clippedTo - 1 : clippedTo)
    ).number
    while (line.number <= lastLine) {
      if (!decorated.has(line.from)) {
        decorated.add(line.from)
        ranges.push(
          Decoration.line({ class: "cm-md-footnote-definition-line" }).range(
            line.from
          )
        )
      }
      if (line.number === state.doc.lines) break
      line = state.doc.line(line.number + 1)
    }
  }
}

export function buildFootnotePreviewDecorations(
  state: EditorState,
  index: FootnoteIndex,
  visibleRanges: readonly DocumentRange[],
  selectionActive = true,
  onNavigate?: FootnoteNavigateCallback
): DecorationSet {
  const ranges: Range<Decoration>[] = []

  for (const reference of index.references) {
    if (
      !intersectsVisible(reference, visibleRanges) ||
      selectionTouches(state, reference, selectionActive)
    ) {
      continue
    }
    ranges.push(
      Decoration.replace({
        inclusive: false,
        markdownPreviewKind: "footnote-reference",
        widget: new FootnoteReferenceWidget(
          reference.identifier,
          reference.number,
          reference.definitionFrom,
          onNavigate
        ),
      }).range(reference.from, reference.to)
    )
  }

  for (const definition of index.definitions) {
    if (!intersectsVisible(definition, visibleRanges)) continue
    addVisibleLineDecorations(
      state,
      visibleRanges,
      definition.from,
      definition.to,
      ranges
    )
    const firstLine = state.doc.lineAt(definition.from)
    if (
      intersectsVisible(firstLine, visibleRanges) &&
      !selectionTouches(state, definition, selectionActive)
    ) {
      const markerTo = Math.max(definition.markerTo, definition.contentFrom)
      ranges.push(
        Decoration.replace({
          inclusive: false,
          markdownPreviewKind: "footnote-definition-label",
          widget: new FootnoteDefinitionLabelWidget(
            definition.identifier,
            definition.number,
            definition.firstReferenceFrom,
            onNavigate
          ),
        }).range(definition.from, markerTo)
      )
      ranges.push(
        Decoration.line({ class: "cm-md-footnote-definition-first" }).range(
          firstLine.from
        )
      )
    }
  }

  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

export interface FootnoteLivePreviewOptions {
  readonly selectionActive?: (state: EditorState) => boolean
  /** Records the current editor location immediately before a footnote jump. */
  readonly onNavigate?: FootnoteNavigateCallback
}

const refreshFootnotePreview = StateEffect.define<null>()

export function footnoteLivePreviewExtension(
  options: FootnoteLivePreviewOptions = {}
): Extension {
  const selectionIsActive = (state: EditorState) =>
    options.selectionActive?.(state) ?? true

  class FootnotePreviewPlugin {
    decorations: DecorationSet
    index: FootnoteIndex
    tree: Tree

    private readonly view: EditorView
    private readonly ownerWindow: Window | null
    private pendingTreeChanges: ChangeDesc | null = null
    private indexDirty = false
    private pointerSelecting = false
    private activePointerId: number | null = null
    private wasComposing = false
    private destroyed = false
    private refreshFrame: number | null = null

    constructor(view: EditorView) {
      this.view = view
      this.ownerWindow = view.dom.ownerDocument.defaultView
      this.tree = completeMarkdownSyntaxTree(view.state)
      this.index = buildFootnoteIndex(view.state, this.tree)
      this.decorations = this.build(view)
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
    }

    update(update: ViewUpdate) {
      const composing = update.view.compositionStarted
      if (this.pointerSelecting || composing) {
        if (update.docChanged) {
          this.pendingTreeChanges = this.pendingTreeChanges
            ? this.pendingTreeChanges.composeDesc(update.changes)
            : update.changes
          this.index = mapFootnoteIndex(this.index, update.changes)
          this.indexDirty = true
          this.decorations = this.decorations.map(update.changes)
        } else if (composing && !this.wasComposing) {
          this.decorations = this.build(update.view)
        }
        this.wasComposing = composing
        return
      }

      const syntaxChanged =
        syntaxTree(update.startState) !== syntaxTree(update.state)
      const selectionActivityChanged =
        selectionIsActive(update.startState) !== selectionIsActive(update.state)
      const requested = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(refreshFootnotePreview))
      )
      if (update.docChanged) {
        const changesFromTree = this.pendingTreeChanges
          ? this.pendingTreeChanges.composeDesc(update.changes)
          : update.changes
        if (
          !this.indexDirty &&
          canMapFootnoteIndex(
            update.startState,
            update.state,
            update.changes,
            this.index
          )
        ) {
          this.index = mapFootnoteIndex(this.index, update.changes)
          this.pendingTreeChanges = changesFromTree
        } else {
          this.tree = updateCompleteMarkdownSyntaxTree(
            update.state,
            changesFromTree,
            this.tree
          )
          this.index = buildFootnoteIndex(update.state, this.tree)
          this.pendingTreeChanges = null
          this.indexDirty = false
        }
      } else if (this.indexDirty) {
        this.tree = this.pendingTreeChanges
          ? updateCompleteMarkdownSyntaxTree(
              update.state,
              this.pendingTreeChanges,
              this.tree
            )
          : completeMarkdownSyntaxTree(update.state)
        this.index = buildFootnoteIndex(update.state, this.tree)
        this.pendingTreeChanges = null
        this.indexDirty = false
      }
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxChanged ||
        selectionActivityChanged ||
        requested ||
        this.wasComposing !== composing
      ) {
        this.decorations = this.build(update.view)
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
      this.ownerWindow?.removeEventListener(
        "pointermove",
        this.handlePointerMove
      )
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
      if (this.refreshFrame != null) {
        this.ownerWindow?.cancelAnimationFrame(this.refreshFrame)
      }
    }

    private build(view: EditorView) {
      return buildFootnotePreviewDecorations(
        view.state,
        this.index,
        view.visibleRanges,
        selectionIsActive(view.state),
        options.onNavigate
      )
    }

    private readonly handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (
        event.target instanceof Element &&
        event.target.closest(interactivePreviewWidgetSelector)
      ) {
        return
      }
      this.pointerSelecting = true
      this.activePointerId = event.pointerId
      try {
        this.view.contentDOM.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic input and an OS-canceled pointer can reject capture.
      }
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
        if (!this.destroyed) {
          this.view.dispatch({ effects: refreshFootnotePreview.of(null) })
        }
      }
      this.refreshFrame =
        this.ownerWindow?.requestAnimationFrame(refresh) ?? null
      if (this.refreshFrame == null) refresh()
    }
  }

  const pointerSelection = semanticPreviewSelectionResolvers.of({
    priority: 50,
    resolve(view, target, position) {
      const reference = target.closest<HTMLElement>(".cm-md-footnote-reference")
      const definition = target.closest<HTMLElement>(
        ".cm-md-footnote-definition-label"
      )
      const element = reference ?? definition
      if (!element) return null
      const sourcePosition = previewPositionAtDOM(view, element, position)
      const range = firstNearbyPreviewRange(
        view.state,
        sourcePosition,
        (candidate) =>
          footnotePreviewRangeAt(
            view.state,
            candidate,
            reference ? "reference" : "definition-label"
          )
      )
      return range
        ? {
            dragSelection: "atomic" as const,
            element,
            from: range.from,
            to: range.to,
          }
        : null
    },
  })

  return [
    ViewPlugin.fromClass(FootnotePreviewPlugin, {
      decorations: (plugin) => plugin.decorations,
    }),
    pointerSelection,
    EditorView.baseTheme({
      ".cm-md-footnote-reference": {
        fontSize: "0.72em",
        lineHeight: "0",
        verticalAlign: "super",
      },
      ".cm-md-footnote-navigation, .cm-md-footnote-definition-label": {
        minWidth: "0",
        padding: "0",
        border: "0",
        appearance: "none",
        background: "transparent",
        color: "color-mix(in oklab, #2563eb 86%, currentColor)",
        cursor: "text",
        font: "inherit",
        textDecoration: "underline",
        textDecorationColor:
          "color-mix(in oklab, currentColor 35%, transparent)",
        textUnderlineOffset: "0.16em",
      },
      ".cm-md-footnote-navigation": {
        lineHeight: "1",
      },
      ".cm-line.cm-md-footnote-definition-line": {
        boxSizing: "border-box",
        paddingInlineStart: "1.65rem",
        color: "color-mix(in oklab, currentColor 76%, transparent)",
        fontSize: "0.9em",
      },
      ".cm-line.cm-md-footnote-definition-first": {
        paddingBlockStart: "0.35rem",
      },
      ".cm-md-footnote-definition-label": {
        display: "inline-block",
        width: "1.45rem",
        marginInlineStart: "-1.45rem",
        paddingInlineEnd: "0.35rem",
        boxSizing: "border-box",
        textAlign: "end",
        textDecoration: "none",
      },
    }),
  ]
}
