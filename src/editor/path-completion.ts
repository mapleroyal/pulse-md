import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  moveCompletionSelection,
  selectedCompletionIndex,
  setSelectedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete"
import { syntaxTree } from "@codemirror/language"
import { Prec, type Extension } from "@codemirror/state"
import {
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import type { PathCompletionEntry } from "../shared/contracts"

const maximumInspectedLineLength = 4_096
const windowsAbsolutePath = /^[A-Za-z]:[\\/]/
const uriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/
const obviousPathStart =
  /(?:^|[\s([{"'`=:])((?:~[\\/]|\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])[^<>"|?*)\]}\n]*)$/
const explicitRelativePath = /(?:^|[\s([{"'`=:])([^\s()[\]{}<>"'`|?*\n]*)$/
const sansFontFamily =
  "var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)"
const appCornerShape = "var(--app-corner-shape, round)"
const completionIconMask = (body: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  )}")`
const folderCompletionIconMask = completionIconMask(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
)
const fileCompletionIconMask = completionIconMask(
  '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/>'
)

// CodeMirror must own completion state and caret-relative positioning, but
// this surface intentionally mirrors the checked-in shadcn Combobox:
// rounded-3xl popup, shadow-lg + subtle ring, a no-scrollbar list, and
// rounded-2xl items with the same spacing and selected-state tokens.
const pathCompletionTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup": {
    "--cm-path-completion-ring":
      "color-mix(in oklab, var(--popover-foreground) 5%, transparent)",
    WebkitAppRegion: "no-drag",
    overflow: "hidden",
    borderRadius: "calc(var(--radius, 0.625rem) * 2.2)",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    cornerShape: appCornerShape,
    isolation: "isolate",
    boxShadow:
      "0 0 0 1px var(--cm-path-completion-ring), 0 10px 15px -3px color-mix(in oklab, #000 10%, transparent), 0 4px 6px -4px color-mix(in oklab, #000 10%, transparent)",
    fontFamily: sansFontFamily,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    outline: "none",
  },
  "&light .cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup": {
    border: "0",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
  "&dark .cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup": {
    "--cm-path-completion-ring":
      "color-mix(in oklab, var(--popover-foreground) 10%, transparent)",
    border: "0",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup > ul": {
    fontFamily: sansFontFamily,
    height: "auto",
    maxHeight: "min(15.75rem, 42vh)",
    maxWidth: "min(32rem, calc(100vw - 1rem))",
    minWidth: "min(19rem, calc(100vw - 1rem))",
    overscrollBehavior: "contain",
    padding: "0.375rem",
    scrollPaddingBlock: "0.375rem",
    scrollbarWidth: "none",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup > ul::-webkit-scrollbar":
    {
      display: "none",
    },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-path-completion-popup > ul > li": {
    alignItems: "center",
    borderRadius: "calc(var(--radius, 0.625rem) * 1.8)",
    boxSizing: "border-box",
    cornerShape: appCornerShape,
    cursor: "default",
    display: "flex",
    fontWeight: "500",
    gap: "0.625rem",
    minHeight: "2.25rem",
    padding: "0.5rem 0.75rem",
  },
  "&light .cm-tooltip-autocomplete.cm-path-completion-popup > ul > li[aria-selected], &dark .cm-tooltip-autocomplete.cm-path-completion-popup > ul > li[aria-selected]":
    {
      backgroundColor: "var(--accent)",
      color: "var(--accent-foreground)",
    },
  "&light .cm-tooltip-autocomplete-disabled.cm-path-completion-popup > ul > li[aria-selected], &dark .cm-tooltip-autocomplete-disabled.cm-path-completion-popup > ul > li[aria-selected]":
    {
      backgroundColor: "var(--muted)",
      color: "var(--muted-foreground)",
    },
  ".cm-tooltip-autocomplete.cm-path-completion-popup > ul > li[aria-selected] .cm-completionIcon":
    {
      color: "var(--accent-foreground)",
    },
  ".cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionIcon": {
    alignItems: "center",
    boxSizing: "border-box",
    color: "var(--muted-foreground)",
    display: "inline-flex",
    flex: "0 0 1rem",
    height: "1rem",
    justifyContent: "center",
    opacity: "1",
    paddingRight: "0",
    width: "1rem",
  },
  ".cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionIcon-folder::after, .cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionIcon-file::after":
    {
      backgroundColor: "currentColor",
      content: '""',
      display: "block",
      height: "1rem",
      maskPosition: "center",
      maskRepeat: "no-repeat",
      maskSize: "contain",
      width: "1rem",
    },
  ".cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionIcon-folder::after":
    {
      maskImage: folderCompletionIconMask,
    },
  ".cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionIcon-file::after":
    {
      maskImage: fileCompletionIconMask,
    },
  ".cm-tooltip-autocomplete.cm-path-completion-popup .cm-completionLabel": {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
})

const pathCompletionPopupSelector =
  ".cm-tooltip-autocomplete.cm-path-completion-popup"

const pathCompletionInteraction = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView

    constructor(view: EditorView) {
      this.view = view
      view.dom.addEventListener("pointermove", this.handlePointerMove, true)
      if (completionStatus(view.state) === "active") {
        this.scheduleInsetCorrection()
      }
    }

    update(update: ViewUpdate) {
      if (completionStatus(update.state) === "active") {
        this.scheduleInsetCorrection()
      }
    }

    destroy() {
      this.view.dom.removeEventListener(
        "pointermove",
        this.handlePointerMove,
        true
      )
    }

    private readonly handlePointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const option = target?.closest<HTMLElement>(
        `${pathCompletionPopupSelector} li[role="option"]`
      )
      if (!option || !this.view.dom.contains(option)) return
      const match = /-(\d+)$/.exec(option.id)
      if (!match) return
      const index = Number(match[1])
      if (
        !Number.isSafeInteger(index) ||
        selectedCompletionIndex(this.view.state) === index
      ) {
        return
      }
      this.view.dispatch({ effects: setSelectedCompletion(index) })
    }

    private scheduleInsetCorrection() {
      this.view.requestMeasure(this.selectedInsetMeasure)
    }

    private readonly selectedInsetMeasure = {
      key: this,
      read: (view: EditorView) => {
        if (completionStatus(view.state) !== "active") return null
        const popup = view.dom.querySelector<HTMLElement>(
          pathCompletionPopupSelector
        )
        const list = popup?.querySelector<HTMLElement>(":scope > ul")
        const selected = list?.querySelector<HTMLElement>(
          ':scope > li[aria-selected="true"]'
        )
        if (!list || !selected || list.offsetHeight === 0) return null

        const ownerWindow = list.ownerDocument.defaultView
        if (!ownerWindow) return null
        const listBounds = list.getBoundingClientRect()
        const selectedBounds = selected.getBoundingClientRect()
        const scaleY = listBounds.height / list.offsetHeight || 1
        const style = ownerWindow.getComputedStyle(list)
        const topInset = (Number.parseFloat(style.paddingTop) || 0) * scaleY
        const bottomInset =
          (Number.parseFloat(style.paddingBottom) || 0) * scaleY
        const desiredTop = listBounds.top + topInset
        const desiredBottom = listBounds.bottom - bottomInset
        let delta = 0
        if (selectedBounds.top < desiredTop - 0.5) {
          delta = -(desiredTop - selectedBounds.top) / scaleY
        } else if (selectedBounds.bottom > desiredBottom + 0.5) {
          delta = (selectedBounds.bottom - desiredBottom) / scaleY
        }
        return delta === 0 ? null : { list, scrollTop: list.scrollTop + delta }
      },
      write: (
        measurement: { list: HTMLElement; scrollTop: number } | null,
        view: EditorView
      ) => {
        if (!measurement || !view.dom.contains(measurement.list)) return
        measurement.list.scrollTop = measurement.scrollTop
      },
    }
  }
)

const pendingCompletionCommands = new WeakMap<
  EditorView,
  {
    commands: Array<(view: EditorView) => boolean>
    deadline: number
    doc: EditorView["state"]["doc"]
    selection: EditorView["state"]["selection"]
  }
>()

function completionCommandWithPendingHandoff(
  command: (view: EditorView) => boolean
) {
  return (view: EditorView) => {
    const queued = pendingCompletionCommands.get(view)
    if (queued) {
      if (
        Date.now() < queued.deadline &&
        view.state.doc === queued.doc &&
        view.state.selection.eq(queued.selection)
      ) {
        queued.commands.push(command)
        return true
      }
      pendingCompletionCommands.delete(view)
    }
    if (command(view)) return true
    if (completionStatus(view.state) !== "pending") return false

    // An async completion source briefly enters the pending state even when it
    // will return null. Only hold the key for a real path target; otherwise Tab
    // must remain available to link/image field navigation and normal editing.
    const cursor = view.state.selection.main.head
    const line = view.state.doc.lineAt(cursor)
    if (!pathCompletionTarget(line.text, cursor - line.from)) return false

    const pending = {
      commands: [command],
      deadline: Date.now() + 1_000,
      doc: view.state.doc,
      selection: view.state.selection,
    }
    pendingCompletionCommands.set(view, pending)
    const ownerWindow = view.dom.ownerDocument.defaultView
    const schedule = (callback: () => void, delay: number) => {
      if (ownerWindow) ownerWindow.setTimeout(callback, delay)
      else setTimeout(callback, delay)
    }
    const retry = () => {
      if (
        pendingCompletionCommands.get(view) !== pending ||
        !view.dom.isConnected ||
        view.state.doc !== pending.doc ||
        !view.state.selection.eq(pending.selection)
      ) {
        pendingCompletionCommands.delete(view)
        return
      }
      const status = completionStatus(view.state)
      if (status === "active") {
        pendingCompletionCommands.delete(view)
        for (const queuedCommand of pending.commands) queuedCommand(view)
      } else if (status === "pending" && Date.now() < pending.deadline) {
        schedule(retry, 8)
      } else {
        pendingCompletionCommands.delete(view)
      }
    }
    schedule(retry, 0)
    return true
  }
}

export type PathCompletionStyle = "markdown" | "markdown-angle" | "plain"

export interface PathCompletionTarget {
  /** Start of the unfinished final path segment. */
  from: number
  /** Full path through the cursor, used to enumerate the containing directory. */
  query: string
  separator: "/" | "\\"
  style: PathCompletionStyle
}

function unfinishedMarkdownDestination(source: string) {
  let depth = 0
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    if (escaped) {
      escaped = false
      continue
    }
    if (source[index] === "\\") {
      escaped = true
      continue
    }
    if (source[index] === "(") {
      depth += 1
    } else if (source[index] === ")") {
      if (depth === 0) return false
      depth -= 1
    }
  }
  return true
}

function pathSeparator(query: string): "/" | "\\" {
  return query.includes("\\") && !query.includes("/") ? "\\" : "/"
}

function targetForPath(
  rawQuery: string,
  absoluteQueryStart: number,
  style: PathCompletionStyle
): PathCompletionTarget | null {
  if (
    rawQuery.includes("\0") ||
    rawQuery.startsWith("//") ||
    rawQuery.startsWith("#") ||
    rawQuery.includes("#") ||
    rawQuery.includes("?") ||
    (uriScheme.test(rawQuery) && !windowsAbsolutePath.test(rawQuery))
  ) {
    return null
  }

  const separatorIndex = Math.max(
    rawQuery.lastIndexOf("/"),
    rawQuery.lastIndexOf("\\")
  )
  return {
    from: absoluteQueryStart + separatorIndex + 1,
    query: decodedPathQuery(rawQuery, style),
    separator: pathSeparator(rawQuery),
    style,
  }
}

function markdownDestinationTarget(
  linePrefix: string,
  lineStart: number
): PathCompletionTarget | null {
  const opener = linePrefix.lastIndexOf("](")
  if (opener >= 0) {
    const destinationStart = opener + 2
    const remainder = linePrefix.slice(destinationStart)
    if (remainder.startsWith("<")) {
      const query = remainder.slice(1)
      if (!query.includes(">")) {
        return targetForPath(
          query,
          lineStart + destinationStart + 1,
          "markdown-angle"
        )
      }
    } else if (
      unfinishedMarkdownDestination(remainder) &&
      !/(^|[^\\])\s/.test(remainder)
    ) {
      return targetForPath(remainder, lineStart + destinationStart, "markdown")
    }
  }

  const definition = /^(?: {0,3})\[[^\]\n]+\]:[ \t]*(<?)([^\n]*)$/.exec(
    linePrefix
  )
  if (!definition) return null
  const angle = definition[1] === "<"
  const query = definition[2] ?? ""
  if ((angle && query.includes(">")) || (!angle && /(^|[^\\])\s/.test(query))) {
    return null
  }
  const queryStart = linePrefix.length - query.length
  return targetForPath(
    query,
    lineStart + queryStart,
    angle ? "markdown-angle" : "markdown"
  )
}

function parsedMarkdownCompletion(
  context: CompletionContext,
  lineText: string
) {
  const line = context.state.doc.lineAt(context.pos)
  const opener = lineText.lastIndexOf("](", context.pos - line.from)
  const position =
    opener < 0 ? line.from + lineText.indexOf("[") : line.from + opener
  const owner = syntaxTree(context.state).resolveInner(position, 1).parent?.name
  return owner === "Image" || owner === "Link" || owner === "LinkReference"
}

/**
 * Locate a path that ends at the cursor without treating ordinary prose as a
 * completion request. Markdown destinations may be relative names; elsewhere
 * a path must have a recognizable path prefix unless completion was explicit.
 */
export function pathCompletionTarget(
  source: string,
  cursor = source.length,
  explicit = false
): PathCompletionTarget | null {
  const boundedCursor = Math.max(0, Math.min(cursor, source.length))
  const lineStart = source.lastIndexOf("\n", boundedCursor - 1) + 1
  const inspectedStart = Math.max(
    lineStart,
    boundedCursor - maximumInspectedLineLength
  )
  const linePrefix = source.slice(inspectedStart, boundedCursor)

  const markdownTarget = markdownDestinationTarget(linePrefix, inspectedStart)
  if (markdownTarget) return markdownTarget

  const match = (explicit ? explicitRelativePath : obviousPathStart).exec(
    linePrefix
  )
  if (!match) return null
  const query = match[1] ?? ""
  if (!query && !explicit) return null
  return targetForPath(
    query,
    inspectedStart + linePrefix.length - query.length,
    "plain"
  )
}

function decodedPercentEncoding(source: string) {
  try {
    return decodeURIComponent(source)
  } catch {
    return source
  }
}

export function decodedPathQuery(source: string, style: PathCompletionStyle) {
  const decoded = decodedPercentEncoding(source)
  if (style === "plain" || windowsAbsolutePath.test(decoded)) return decoded
  return decoded.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~ ])/g, "$1")
}

function encodedAnglePathSegment(name: string) {
  return name.replace(/[%#?<>]/g, (character) => encodeURIComponent(character))
}

export function encodedPathSegment(name: string, style: PathCompletionStyle) {
  if (style === "markdown") {
    // encodeURIComponent intentionally leaves parentheses and several other
    // punctuation characters alone. Parentheses would terminate or rebalance
    // an unbracketed Markdown destination, so encode the remaining RFC 3986
    // punctuation as well.
    return encodeURIComponent(name).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
  }
  if (style === "markdown-angle") return encodedAnglePathSegment(name)
  return name
}

function completionOptions(
  entries: readonly PathCompletionEntry[],
  target: PathCompletionTarget
): readonly Completion[] {
  return entries.map((entry) => ({
    apply: `${encodedPathSegment(entry.name, target.style)}${
      entry.kind === "directory" ? target.separator : ""
    }`,
    label: entry.name,
    type: entry.kind === "directory" ? "folder" : "file",
  }))
}

export function pathCompletionSource(
  completePath: (path: string) => Promise<readonly PathCompletionEntry[]>
) {
  return async (
    context: CompletionContext
  ): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos)
    const lineTarget = pathCompletionTarget(
      line.text,
      context.pos - line.from,
      context.explicit
    )
    if (!lineTarget) return null
    const target = { ...lineTarget, from: line.from + lineTarget.from }
    if (
      target.style !== "plain" &&
      !parsedMarkdownCompletion(context, line.text)
    ) {
      return null
    }

    let entries: readonly PathCompletionEntry[]
    try {
      entries = await completePath(target.query)
    } catch {
      return null
    }
    if (context.aborted || entries.length === 0) return null

    return {
      filter: false,
      from: target.from,
      options: completionOptions(entries, target),
    }
  }
}

export function pathCompletionExtension(
  completePath: (path: string) => Promise<readonly PathCompletionEntry[]>
): Extension {
  return [
    pathCompletionTheme,
    pathCompletionInteraction,
    autocompletion({
      activateOnCompletion: (completion) => completion.type === "folder",
      activateOnTypingDelay: 80,
      interactionDelay: 0,
      maxRenderedOptions: 100,
      override: [pathCompletionSource(completePath)],
      selectOnOpen: true,
      tooltipClass: () => "cm-path-completion-popup",
    }),
    // Completion owns Tab only while its popup has a selectable option. The
    // controller's normal Tab behavior still runs when this command declines.
    Prec.highest(
      keymap.of([
        {
          key: "ArrowDown",
          run: completionCommandWithPendingHandoff(
            moveCompletionSelection(true)
          ),
        },
        {
          key: "ArrowUp",
          run: completionCommandWithPendingHandoff(
            moveCompletionSelection(false)
          ),
        },
        {
          key: "PageDown",
          run: completionCommandWithPendingHandoff(
            moveCompletionSelection(true, "page")
          ),
        },
        {
          key: "PageUp",
          run: completionCommandWithPendingHandoff(
            moveCompletionSelection(false, "page")
          ),
        },
        {
          key: "Tab",
          run: completionCommandWithPendingHandoff(acceptCompletion),
        },
      ])
    ),
  ]
}
