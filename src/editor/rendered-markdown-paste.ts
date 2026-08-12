import { markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree } from "@codemirror/language"
import { Prec, type EditorState, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"
import {
  type AsyncPasteRange,
  AsyncPasteTracker,
  asyncPasteFallbackTransaction,
  resolvedAsyncPasteTransaction,
} from "./async-paste"
import { normalizeEditorContent } from "./content"

const MAX_RICH_CLIPBOARD_LENGTH = 1024 * 1024
const protectedMarkdownNodes = new Set([
  "CodeBlock",
  "CodeInfo",
  "CodeText",
  "FencedCode",
  "InlineCode",
  "InlineDisplayMath",
  "InlineMath",
  "InlineMathMark",
  "BlockMath",
  "BlockMathMark",
  "MathText",
  "URL",
  "YAMLFrontMatter",
  "YAMLFrontMatterContent",
  "YAMLFrontMatterMark",
])

const loadRenderedMarkdownConverter = createRetryableDynamicImport(
  () => import("./rendered-markdown-converter")
)

function markdownPasteAllowedAt(state: EditorState, position: number) {
  if (!markdownLanguage.isActiveAt(state, position, 1)) return false
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);
    node;
    node = node.parent
  ) {
    if (protectedMarkdownNodes.has(node.name)) return false
  }
  return true
}

export function markdownSelectionAcceptsRenderedPaste(state: EditorState) {
  return state.selection.ranges.every((range) => {
    if (!markdownPasteAllowedAt(state, range.from)) return false
    return (
      range.empty ||
      markdownPasteAllowedAt(state, Math.max(range.from, range.to - 1))
    )
  })
}

function blankLineBefore(state: EditorState, position: number) {
  if (position === 0) return ""
  const before = state.sliceDoc(Math.max(0, position - 2), position)
  if (before.endsWith("\n\n")) return ""
  return before.endsWith("\n") ? "\n" : "\n\n"
}

function blankLineAfter(state: EditorState, position: number) {
  if (position === state.doc.length) return ""
  const after = state.sliceDoc(
    position,
    Math.min(state.doc.length, position + 2)
  )
  if (after.startsWith("\n\n")) return ""
  return after.startsWith("\n") ? "\n" : "\n\n"
}

export function markdownBlockPasteReplacement(
  state: EditorState,
  range: AsyncPasteRange,
  markdown: string
) {
  return `${blankLineBefore(state, range.from)}${markdown}${blankLineAfter(
    state,
    range.to
  )}`
}

export function renderedMarkdownPasteExtension(): Extension {
  const pendingPastes = ViewPlugin.define(() => new AsyncPasteTracker())
  return [
    pendingPastes,
    Prec.low(
      EditorView.domEventHandlers({
        paste(event, view) {
          const data = event.clipboardData
          if (
            !data ||
            view.state.readOnly ||
            !view.state.facet(EditorView.editable) ||
            !markdownSelectionAcceptsRenderedPaste(view.state)
          ) {
            return false
          }

          const markdown = normalizeEditorContent(data.getData("text/markdown"))
          if (markdown) {
            event.preventDefault()
            view.dispatch(
              asyncPasteFallbackTransaction(view.state, markdown).transaction
            )
            return true
          }

          const html = data.getData("text/html")
          const fallback = normalizeEditorContent(data.getData("text/plain"))
          if (
            !html ||
            html.length > MAX_RICH_CLIPBOARD_LENGTH ||
            fallback.length > MAX_RICH_CLIPBOARD_LENGTH
          ) {
            return false
          }

          event.preventDefault()
          const { pending, transaction } = asyncPasteFallbackTransaction(
            view.state,
            fallback
          )
          const token = {}
          view.dispatch(transaction)
          view.plugin(pendingPastes)?.pastes.set(token, pending)
          const ownerDocument = view.dom.ownerDocument

          void loadRenderedMarkdownConverter()
            .then(({ renderedHtmlToMarkdown }) =>
              renderedHtmlToMarkdown(ownerDocument, html)
            )
            .then(
              ({ block, markdown: converted }) => {
                const tracker = view.plugin(pendingPastes)
                const current = tracker?.pastes.get(token)
                if (!tracker || !current) return
                tracker.pastes.delete(token)
                const replacement = normalizeEditorContent(converted)
                const resolved = resolvedAsyncPasteTransaction(
                  view.state,
                  current,
                  block
                    ? (range) =>
                        markdownBlockPasteReplacement(
                          view.state,
                          range,
                          replacement || fallback
                        )
                    : replacement || fallback
                )
                if (resolved) view.dispatch(resolved)
              },
              (error: unknown) => {
                view.plugin(pendingPastes)?.pastes.delete(token)
                console.error(
                  "Unable to convert pasted HTML to Markdown",
                  error
                )
              }
            )
          return true
        },
      })
    ),
  ]
}
