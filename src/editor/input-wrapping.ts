import { markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree } from "@codemirror/language"
import { EditorSelection, Prec, type Extension } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { EditorView } from "@codemirror/view"

import { completeMarkdownSyntaxTree } from "./complete-markdown-tree"

export interface SelectedTextWrapper {
  close: string
  open: string
}

const selectedTextWrappers: Readonly<Record<string, SelectedTextWrapper>> = {
  "'": { open: "'", close: "'" },
  '"': { open: '"', close: '"' },
  "(": { open: "(", close: ")" },
  "[": { open: "[", close: "]" },
  "{": { open: "{", close: "}" },
  "<": { open: "<", close: ">" },
  "`": { open: "`", close: "`" },
  "*": { open: "*", close: "*" },
  _: { open: "_", close: "_" },
  "~": { open: "~", close: "~" },
  $: { open: "$", close: "$" },
  "=": { open: "=", close: "=" },
  "^": { open: "^", close: "^" },
}

export function selectedTextWrapperFor(
  insertedText: string
): SelectedTextWrapper | null {
  const exactWrapper = selectedTextWrappers[insertedText]
  if (exactWrapper) return exactWrapper

  // Browsers and input methods may report a short run of typed characters as
  // one DOM change. Treat a homogeneous delimiter run like the same keys were
  // delivered individually, including asymmetric pairs such as `[[` / `]]`.
  const delimiter = insertedText[0]
  if (
    !delimiter ||
    insertedText.length === 1 ||
    !insertedText.split("").every((character) => character === delimiter)
  ) {
    return null
  }

  const repeatedWrapper = selectedTextWrappers[delimiter]
  return repeatedWrapper
    ? {
        open: repeatedWrapper.open.repeat(insertedText.length),
        close: repeatedWrapper.close.repeat(insertedText.length),
      }
    : null
}

const selectedTextInputHandler = EditorView.inputHandler.of(
  (view, from, to, insertedText) => {
    const state = view.state
    const main = state.selection.main
    const wrapper = selectedTextWrapperFor(insertedText)

    if (
      !wrapper ||
      state.readOnly ||
      // Never replace an active IME composition. After compositionend,
      // CodeMirror clears compositionStarted before flushing any pending DOM
      // change, so a finalized dead-key delimiter can still wrap a selection.
      view.compositionStarted ||
      main.empty ||
      from !== main.from ||
      to !== main.to ||
      state.selection.ranges.some((range) => range.empty)
    ) {
      return false
    }

    const changes = state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: wrapper.open },
        { from: range.to, insert: wrapper.close },
      ],
      range: EditorSelection.range(
        range.anchor + wrapper.open.length,
        range.head + wrapper.open.length
      ),
    }))

    view.dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: "input.type",
      })
    )
    return true
  }
)

export function normalizedPastedUrl(source: string) {
  const candidate = source.trim()
  if (!candidate) return null

  const target = /^www\./i.test(candidate) ? `https://${candidate}` : candidate
  try {
    const url = new URL(target)
    const protocol = url.protocol.toLowerCase()
    return protocol === "http:" ||
      protocol === "https:" ||
      protocol === "mailto:" ||
      protocol === "xmpp:"
      ? url.href
      : null
  } catch {
    return null
  }
}

export function escapedMarkdownLinkLabel(source: string) {
  return source.replace(/[\\[\]]/g, "\\$&")
}

export function escapedMarkdownLinkDestination(source: string) {
  return source.replace(/[\\()]/g, "\\$&")
}

export interface MarkdownLinkLikeSource {
  readonly destinationFrom: number
  readonly destinationTo: number
  readonly labelFrom: number
  readonly labelTo: number
  readonly source: string
}

/** Builds escaped Markdown and exposes exact post-insertion selection spans. */
export function markdownLinkLikeSource(
  label: string,
  target: string,
  image = false
): MarkdownLinkLikeSource {
  const escapedLabel = escapedMarkdownLinkLabel(label)
  const escapedTarget = escapedMarkdownLinkDestination(target)
  const prefix = image ? "![" : "["
  const labelFrom = prefix.length
  const labelTo = labelFrom + escapedLabel.length
  const destinationFrom = labelTo + 2
  const destinationTo = destinationFrom + escapedTarget.length
  return {
    destinationFrom,
    destinationTo,
    labelFrom,
    labelTo,
    source: `${prefix}${escapedLabel}](${escapedTarget})`,
  }
}

export function markdownLinkSource(label: string, target: string) {
  return markdownLinkLikeSource(label, target).source
}

function enclosingLinkLikeNode(
  state: EditorView["state"],
  from: number,
  to: number
) {
  const tree = syntaxTree(state)
  const candidates = [
    tree.resolveInner(from, 1),
    tree.resolveInner(Math.max(from, to - 1), -1),
  ]

  for (const candidate of candidates) {
    for (let node: SyntaxNode | null = candidate; node; node = node.parent) {
      if (
        (node.name === "Link" ||
          node.name === "Image" ||
          node.name === "Autolink" ||
          node.name === "LinkReference") &&
        from >= node.from &&
        to <= node.to
      ) {
        return node
      }
    }
  }
  return null
}

function directChildren(node: SyntaxNode) {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

export function markdownLinkDestinationForSelection(
  state: EditorView["state"],
  from: number,
  to: number
) {
  const link = enclosingLinkLikeNode(state, from, to)
  if (!link) return null
  const url = directChildren(link).find((child) => child.name === "URL")
  if (!url || from < url.from || to > url.to) return null
  return { from: url.from, to: url.to }
}

export function moveSelectionToMarkdownLinkDestination(view: EditorView) {
  const { state } = view
  const destinations = state.selection.ranges.map((range) => {
    const link = enclosingLinkLikeNode(state, range.from, range.to)
    if (!link) return null
    const children = directChildren(link)
    const url = children.find((child) => child.name === "URL")
    const marks = children.filter((child) => child.name === "LinkMark")
    const labelFrom = marks[0]?.to
    const labelTo = marks[1]?.from
    const selectsWholeLabel =
      !range.empty && range.from === labelFrom && range.to === labelTo
    const caretIsInLabel =
      range.empty &&
      labelFrom != null &&
      labelTo != null &&
      range.from >= labelFrom &&
      range.from <= labelTo
    if (
      !url ||
      labelFrom == null ||
      labelTo == null ||
      (!selectsWholeLabel && !caretIsInLabel)
    ) {
      return null
    }
    return EditorSelection.range(url.from, url.to)
  })
  if (destinations.some((destination) => destination === null)) return false

  view.dispatch({
    selection: EditorSelection.create(
      destinations as EditorSelection["ranges"],
      state.selection.mainIndex
    ),
    scrollIntoView: true,
    userEvent: "select",
  })
  return true
}

const urlWrappingProtectedNodes = new Set([
  "CodeBlock",
  "FencedCode",
  "InlineCode",
  "InlineDisplayMath",
  "InlineMath",
  "BlockMath",
  "YAMLFrontMatter",
  "Link",
  "Image",
  "Autolink",
  "LinkReference",
])

function selectionAllowsUrlWrapping(state: EditorView["state"]) {
  if (
    state.selection.ranges.some(
      (range) =>
        range.empty ||
        !markdownLanguage.isActiveAt(state, range.from, 1) ||
        !markdownLanguage.isActiveAt(state, range.to, -1)
    )
  ) {
    return false
  }
  const tree = completeMarkdownSyntaxTree(state)
  return state.selection.ranges.every((range) => {
    for (const position of [range.from, range.to - 1]) {
      for (
        let node: SyntaxNode | null = tree.resolveInner(position, 1);
        node;
        node = node.parent
      ) {
        if (urlWrappingProtectedNodes.has(node.name)) return false
      }
    }
    return true
  })
}

const pastedUrlWrappingHandler = EditorView.domEventHandlers({
  paste: (event, view) => {
    const { state } = view
    const target = normalizedPastedUrl(
      event.clipboardData?.getData("text/plain") ?? ""
    )
    if (!target || state.readOnly) return false

    const destinationPaste = state.selection.ranges.every(
      (range) =>
        !range.empty &&
        markdownLinkDestinationForSelection(state, range.from, range.to) != null
    )
    if (destinationPaste) {
      event.preventDefault()
      const destination = escapedMarkdownLinkDestination(target)
      const changes = state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: destination },
        range: EditorSelection.cursor(range.from + destination.length),
      }))
      view.dispatch(
        state.update(changes, {
          scrollIntoView: true,
          userEvent: "input.paste",
        })
      )
      return true
    }

    if (!selectionAllowsUrlWrapping(state)) return false

    const changes = state.changeByRange((range) => {
      const source = state.sliceDoc(range.from, range.to)
      const label = escapedMarkdownLinkLabel(source)
      const labelFrom = range.from + 1
      const labelTo = labelFrom + label.length
      return {
        changes: {
          from: range.from,
          to: range.to,
          insert: markdownLinkSource(source, target),
        },
        range:
          range.anchor <= range.head
            ? EditorSelection.range(labelFrom, labelTo)
            : EditorSelection.range(labelTo, labelFrom),
      }
    })
    view.dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: "input.paste",
      })
    )
    return true
  },
})

/**
 * Wraps selected text when a delimiter is typed. Empty selections deliberately
 * fall through so an opening character remains a literal single character.
 */
export const selectedTextWrappingExtension: Extension = Prec.high(
  selectedTextInputHandler
)

/** Turns a URL paste into a Markdown link when every selection has text. */
export const pastedUrlWrappingExtension: Extension = Prec.high(
  pastedUrlWrappingHandler
)
