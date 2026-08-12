import { syntaxTree } from "@codemirror/language"
import {
  StateEffect,
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
import type { Tree } from "@lezer/common"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"
import { createRetryablePromiseLoader } from "../lib/retryable-promise"

import {
  completeMarkdownSyntaxTree,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  interactivePreviewWidgetSelector,
  nearbyPreviewPositions,
  previewPositionAtDOM,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"

interface DocumentRange {
  readonly from: number
  readonly to: number
}

export interface EmojiShortcode {
  readonly alias: string
  readonly from: number
  readonly source: string
  readonly to: number
}

const loadEmojiModule = createRetryableDynamicImport(() => import("gemoji"))
const aliasRefreshIdleDelay = 100
let loadedEmojiAliases: Record<string, string> | null = null
const loadEmojiAliases = createRetryablePromiseLoader(() =>
  loadEmojiModule().then(({ nameToEmoji }) => {
    loadedEmojiAliases = nameToEmoji
    return nameToEmoji
  })
)

function shortcodeAlias(source: string) {
  return source.length >= 3 && source.startsWith(":") && source.endsWith(":")
    ? source.slice(1, -1)
    : null
}

export function emojiShortcodes(
  state: EditorState,
  ranges: readonly DocumentRange[] = [{ from: 0, to: state.doc.length }],
  tree: Tree = syntaxTree(state)
): readonly EmojiShortcode[] {
  const shortcodes: EmojiShortcode[] = []
  const seen = new Set<number>()
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "EmojiToken" || seen.has(node.from)) return
        seen.add(node.from)
        const source = state.sliceDoc(node.from, node.to)
        const alias = shortcodeAlias(source)
        if (!alias) return
        shortcodes.push({ alias, from: node.from, source, to: node.to })
        return false
      },
    })
  }

  return shortcodes.sort((left, right) => left.from - right.from)
}

class EmojiWidget extends WidgetType {
  readonly alias: string
  readonly aliases: Record<string, string> | null
  readonly source: string

  constructor(
    alias: string,
    source: string,
    aliases: Record<string, string> | null
  ) {
    super()
    this.alias = alias
    this.source = source
    this.aliases = aliases
  }

  eq(other: EmojiWidget) {
    return (
      this.alias === other.alias &&
      this.source === other.source &&
      this.aliases === other.aliases
    )
  }

  ignoreEvent() {
    return false
  }

  toDOM(view: EditorView) {
    const emoji = view.dom.ownerDocument.createElement("span")
    emoji.className = "cm-md-emoji"
    emoji.dataset.emojiAlias = this.alias
    emoji.title = this.source

    if (this.aliases) {
      const expansion = Object.hasOwn(this.aliases, this.alias)
        ? this.aliases[this.alias]
        : undefined
      emoji.textContent = expansion ?? this.source
      emoji.classList.add(
        expansion ? "cm-md-emoji-expanded" : "cm-md-emoji-unknown"
      )
      return emoji
    }

    emoji.classList.add("cm-md-emoji-loading")
    emoji.textContent = this.source
    return emoji
  }
}

function selectionTouches(
  state: EditorState,
  shortcode: EmojiShortcode,
  selectionActive: boolean
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive &&
        range.head >= shortcode.from &&
        range.head <= shortcode.to
      : range.from < shortcode.to && range.to > shortcode.from
  )
}

export function buildEmojiPreviewDecorations(
  state: EditorState,
  visibleRanges: readonly DocumentRange[],
  selectionActive = true,
  tree: Tree = syntaxTree(state)
): DecorationSet {
  return emojiDecorationsForShortcodes(
    state,
    emojiShortcodes(state, visibleRanges, tree),
    selectionActive,
    loadedEmojiAliases
  )
}

function emojiDecorationsForShortcodes(
  state: EditorState,
  shortcodes: readonly EmojiShortcode[],
  selectionActive: boolean,
  aliases: Record<string, string> | null
) {
  const ranges: Range<Decoration>[] = []
  for (const shortcode of shortcodes) {
    if (selectionTouches(state, shortcode, selectionActive)) continue
    ranges.push(
      Decoration.replace({
        inclusive: false,
        markdownPreviewKind: "emoji",
        widget: new EmojiWidget(shortcode.alias, shortcode.source, aliases),
      }).range(shortcode.from, shortcode.to)
    )
  }
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

export interface EmojiLivePreviewOptions {
  /** Mirrors live-preview focus so an inactive cursor stays rendered. */
  readonly selectionActive?: (state: EditorState) => boolean
}

const refreshEmojiPreview = StateEffect.define<null>()

export function emojiLivePreviewExtension(
  options: EmojiLivePreviewOptions = {}
): Extension {
  const selectionIsActive = (state: EditorState) =>
    options.selectionActive?.(state) ?? true

  class EmojiPreviewPlugin {
    decorations: DecorationSet

    private readonly view: EditorView
    private readonly ownerWindow: Window | null
    private aliases: Record<string, string> | null
    private pendingAliases: Record<string, string> | null = null
    private aliasRefreshTimer: number | null = null
    private shortcodes: readonly EmojiShortcode[]
    private tree: Tree
    private pointerSelecting = false
    private activePointerId: number | null = null
    private wasComposing = false
    private destroyed = false
    private refreshFrame: number | null = null

    constructor(view: EditorView) {
      this.view = view
      this.ownerWindow = view.dom.ownerDocument.defaultView
      this.aliases = loadedEmojiAliases
      this.tree = completeMarkdownSyntaxTree(view.state)
      this.shortcodes = emojiShortcodes(
        view.state,
        [{ from: 0, to: view.state.doc.length }],
        this.tree
      )
      this.decorations = this.buildDecorations(view.state)
      view.scrollDOM.addEventListener("scroll", this.handleScroll, {
        passive: true,
      })
      if (!this.aliases) {
        // The alias table remains a deferred chunk and is loaded only when
        // emoji expansion is enabled. Its source-sized placeholders keep the
        // complete document geometry stable until the user stops scrolling.
        void loadEmojiAliases()
          .then((aliases) => {
            if (this.destroyed) return
            this.pendingAliases = aliases
            this.scheduleAliasRefresh()
          })
          .catch(() => undefined)
      }
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
          this.tree = updateCompleteMarkdownSyntaxTree(
            update.state,
            update.changes,
            this.tree
          )
          this.shortcodes = emojiShortcodes(
            update.state,
            [{ from: 0, to: update.state.doc.length }],
            this.tree
          )
          this.decorations = this.buildDecorations(update.state)
        } else if (composing && !this.wasComposing) {
          this.decorations = this.buildDecorations(update.state)
        }
        this.wasComposing = composing
        return
      }

      if (update.docChanged) {
        this.tree = updateCompleteMarkdownSyntaxTree(
          update.state,
          update.changes,
          this.tree
        )
        this.shortcodes = emojiShortcodes(
          update.state,
          [{ from: 0, to: update.state.doc.length }],
          this.tree
        )
      }
      const selectionActivityChanged =
        selectionIsActive(update.startState) !== selectionIsActive(update.state)
      const requested = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(refreshEmojiPreview))
      )
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        selectionActivityChanged ||
        requested ||
        this.wasComposing !== composing
      ) {
        this.decorations = this.buildDecorations(update.state)
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
      this.view.scrollDOM.removeEventListener("scroll", this.handleScroll)
      if (this.refreshFrame != null) {
        this.ownerWindow?.cancelAnimationFrame(this.refreshFrame)
      }
      if (this.aliasRefreshTimer != null) {
        this.ownerWindow?.clearTimeout(this.aliasRefreshTimer)
      }
    }

    private buildDecorations(state: EditorState) {
      return emojiDecorationsForShortcodes(
        state,
        this.shortcodes,
        selectionIsActive(state),
        this.aliases
      )
    }

    private scheduleAliasRefresh() {
      if (!this.pendingAliases) return
      if (this.aliasRefreshTimer != null) {
        this.ownerWindow?.clearTimeout(this.aliasRefreshTimer)
        this.aliasRefreshTimer = null
      }
      const refresh = () => {
        this.aliasRefreshTimer = null
        if (this.destroyed || !this.pendingAliases) return
        if (this.pointerSelecting || this.view.compositionStarted) {
          this.scheduleAliasRefresh()
          return
        }
        const scrollSnapshot = this.view.scrollSnapshot()
        this.aliases = this.pendingAliases
        this.pendingAliases = null
        this.view.dispatch({
          effects: [scrollSnapshot, refreshEmojiPreview.of(null)],
        })
      }
      this.aliasRefreshTimer =
        this.ownerWindow?.setTimeout(refresh, aliasRefreshIdleDelay) ?? null
      if (this.aliasRefreshTimer == null) refresh()
    }

    private readonly handleScroll = () => {
      if (this.pendingAliases) this.scheduleAliasRefresh()
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
          this.view.dispatch({ effects: refreshEmojiPreview.of(null) })
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
      const element = target.closest<HTMLElement>(".cm-md-emoji")
      if (!element) return null
      const sourcePosition = previewPositionAtDOM(view, element, position)
      const source = element.title
      const candidates = nearbyPreviewPositions(view.state, sourcePosition)
      const scanFrom = Math.max(0, sourcePosition - source.length - 1)
      const scanTo = Math.min(
        view.state.doc.length,
        sourcePosition + source.length + 1
      )
      const matching = emojiShortcodes(view.state, [
        { from: scanFrom, to: scanTo },
      ]).filter(
        (shortcode) =>
          shortcode.alias === element.dataset.emojiAlias &&
          shortcode.source === source &&
          candidates.some(
            (candidate) =>
              shortcode.from <= candidate && candidate <= shortcode.to
          )
      )
      const shortcode =
        matching.find((item) => item.from === sourcePosition) ??
        matching.find(
          (item) => item.from < sourcePosition && sourcePosition < item.to
        ) ??
        matching.at(-1) ??
        null
      return shortcode
        ? {
            dragSelection: "atomic" as const,
            element,
            from: shortcode.from,
            to: shortcode.to,
          }
        : null
    },
  })

  return [
    ViewPlugin.fromClass(EmojiPreviewPlugin, {
      decorations: (plugin) => plugin.decorations,
    }),
    pointerSelection,
    EditorView.baseTheme({
      ".cm-md-emoji": {
        display: "inline-block",
        fontFamily:
          "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif",
        fontStyle: "normal",
        fontWeight: "normal",
        lineHeight: "1",
        verticalAlign: "-0.08em",
      },
      ".cm-md-emoji-loading, .cm-md-emoji-unknown": {
        fontFamily: "inherit",
        lineHeight: "inherit",
        verticalAlign: "baseline",
      },
    }),
  ]
}
