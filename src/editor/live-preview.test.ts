import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state"
import { type Decoration, EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { calloutBlockExtension, calloutEditingRange } from "./callout-blocks"
import { normalizeEditorContent } from "./content"
import {
  decodeMarkdownCharacterReferences,
  markdownLinkDefinitions,
} from "./link-semantics"
import {
  buildLinkReferencePreviewDecorations,
  buildLivePreviewDecorations,
  buildTableStructureDecorations,
  livePreviewExtension,
  livePreviewFocusTrackingExtension,
  markdownLinkTargetAt,
  taskCheckboxAccessibleName,
} from "./live-preview"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

import { mathMarkdownExtension } from "./math"
import { markdownRemoteImagesEnabled } from "./media"

const scratchId = "11111111-1111-4111-8111-111111111111"

function markdownState(
  doc: string,
  cursor = 0,
  head = cursor,
  extra: Extension = []
) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor, head },
    extensions: [
      markdown({
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions(),
      }),
      extra,
    ],
  })
}

function decorationRanges(state: EditorState, selectionActive = true) {
  const result: Array<{
    from: number
    to: number
    text: string
    kind: unknown
    className: unknown
    attributes: unknown
    widgetLabel: unknown
    widgetTaskText: unknown
    widgetTitle: unknown
  }> = []
  const visibleRanges = [{ from: 0, to: state.doc.length }]
  const decorationSets = [
    buildLivePreviewDecorations(state, visibleRanges, selectionActive),
    buildTableStructureDecorations(state, visibleRanges),
    buildLinkReferencePreviewDecorations(state, selectionActive),
  ]

  for (const decorations of decorationSets) {
    decorations.between(0, state.doc.length, (from, to, value: Decoration) => {
      result.push({
        from,
        to,
        text: state.sliceDoc(from, to),
        kind: value.spec.markdownPreviewKind,
        className: value.spec.class,
        attributes: value.spec.attributes,
        widgetLabel:
          (value.spec.attributes as Record<string, unknown> | undefined)?.[
            "data-list-marker"
          ] ?? (value.spec.widget as { label?: unknown } | undefined)?.label,
        widgetTaskText: (
          value.spec.widget as { taskText?: unknown } | undefined
        )?.taskText,
        widgetTitle: (value.spec.widget as { title?: unknown } | undefined)
          ?.title,
      })
    })
  }
  return result
}

function listLineNumbers(state: EditorState) {
  return decorationRanges(state, false)
    .filter(({ className }) =>
      String(className).split(/\s+/).includes("cm-md-list-line")
    )
    .map(({ from }) => state.doc.lineAt(from).number)
}

function stateBackedLinkReferenceRanges(state: EditorState) {
  const result: Array<{ from: number; to: number; text: string }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, decoration: Decoration) => {
      if (decoration.spec.markdownPreviewKind !== "link-reference") return
      result.push({ from, to, text: state.sliceDoc(from, to) })
    })
  }
  return result
}

function stateBackedLinkReferenceDecorationSource(state: EditorState) {
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    let includesLinkReference = false
    source.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.markdownPreviewKind === "link-reference") {
        includesLinkReference = true
      }
    })
    if (includesLinkReference) return source
  }
  return null
}

function stateBackedTableWrapperRanges(state: EditorState) {
  const ranges: Array<{ from: number; to: number }> = []
  for (const source of state.facet(EditorView.blockWrappers)) {
    const wrappers =
      typeof source === "function"
        ? source({ state } as unknown as EditorView)
        : source
    wrappers.between(0, state.doc.length, (from, to, wrapper) => {
      const attributes = (
        wrapper as unknown as { attributes: Record<string, string> }
      ).attributes
      if (attributes.class === "cm-md-table-scroll") ranges.push({ from, to })
    })
  }
  return ranges
}

function stateBackedTableWrapperCount(state: EditorState) {
  return stateBackedTableWrapperRanges(state).length
}

describe("live Markdown decorations", () => {
  test("renders parsed punctuation escapes, character references and hard-break markers", () => {
    const doc =
      String.raw`Escaped \* and &amp; &#65; &notARealEntity;.` +
      "\n\nhard\\\nbreak"
    const state = markdownState(doc)
    const replacements: Array<{ from: number; to: number; text: string }> = []
    buildLivePreviewDecorations(
      state,
      [{ from: 0, to: doc.length }],
      false
    ).between(0, doc.length, (from, to, decoration) => {
      if (decoration.spec.markdownPreviewKind) {
        replacements.push({
          from,
          to,
          text: decoration.spec.widget?.text ?? "",
        })
      }
    })
    let rendered = ""
    let cursor = 0
    for (const replacement of replacements) {
      rendered += doc.slice(cursor, replacement.from) + replacement.text
      cursor = replacement.to
    }
    rendered += doc.slice(cursor)
    expect(rendered).toBe("Escaped * and & A &notARealEntity;.\n\nhard\nbreak")
    expect(
      replacements.every(({ from, to }) => !doc.slice(from, to).includes("\n"))
    ).toBe(true)
  })

  test("keeps literal code and active inline-token source editable", () => {
    for (const doc of [String.raw`\*`, "&amp;", "hard\\\nbreak"]) {
      const state = markdownState(doc, doc.includes("hard") ? 4 : 1)
      expect(
        decorationRanges(state).some(
          ({ kind }) => kind === "character-reference" || kind === "delimiter"
        )
      ).toBe(false)
    }
    const source = "`" + String.raw`\* &amp;` + "`"
    expect(
      decorationRanges(markdownState(source), false).some(
        ({ kind }) => kind === "character-reference"
      )
    ).toBe(false)
  })

  test("removes only one matching space from inactive code-span boundaries", () => {
    const doc = "`  code  `"
    const hiddenPadding = decorationRanges(markdownState(doc), false).filter(
      ({ kind }) => kind === "inline-code-normalization"
    )
    expect(hiddenPadding.map(({ text }) => text)).toEqual([" ", " "])
    expect(
      decorationRanges(markdownState(doc, 4)).some(
        ({ kind }) => kind === "inline-code-normalization"
      )
    ).toBe(false)
  })

  test("uses rendered alt text and defers remote image loading", () => {
    const doc = "![*foo* &amp;](https://images.example.test/pixel.png)"
    const imageWidget = (state: EditorState) => {
      let widget:
        | {
            alt: readonly { entity: boolean; text: string }[]
            loadSource: boolean
          }
        | undefined
      buildLivePreviewDecorations(
        state,
        [{ from: 0, to: state.doc.length }],
        false
      ).between(0, state.doc.length, (_from, _to, value) => {
        if (value.spec.markdownPreviewKind === "image") {
          widget = value.spec.widget as typeof widget
        }
      })
      return widget
    }

    expect(imageWidget(markdownState(doc))).toMatchObject({
      alt: [
        { entity: false, text: "foo " },
        { entity: true, text: "&amp;" },
      ],
      loadSource: false,
    })
    expect(
      imageWidget(
        markdownState(doc, 0, 0, markdownRemoteImagesEnabled.of(true))
      )?.loadSource
    ).toBe(true)
  })

  test("reveals a heading marker only at the marker boundary", () => {
    const doc = "## Heading"
    const insideHeading = decorationRanges(
      markdownState(doc, doc.indexOf("Heading") + 2)
    )
    expect(
      insideHeading.find(
        ({ kind, text }) => kind === "delimiter" && text.startsWith("##")
      )?.text
    ).toBe("## ")

    const atFirstContent = decorationRanges(
      markdownState(doc, doc.indexOf("Heading"))
    )
    expect(
      atFirstContent.some(
        ({ kind, text }) => kind === "delimiter" && text === "## "
      )
    ).toBe(false)

    const contentSelection = decorationRanges(
      markdownState(doc, doc.indexOf("Heading"), doc.length)
    )
    expect(
      contentSelection.some(
        ({ kind, text }) => kind === "delimiter" && text === "## "
      )
    ).toBe(true)

    const markerSelection = decorationRanges(markdownState(doc, 1, 4))
    expect(
      markerSelection.some(
        ({ kind, text }) => kind === "delimiter" && text === "## "
      )
    ).toBe(false)
  })

  test("keeps heading source hidden while the editor selection is inactive", () => {
    const decorations = decorationRanges(markdownState("# Heading"), false)
    expect(
      decorations.some(
        ({ kind, text }) => kind === "delimiter" && text === "# "
      )
    ).toBe(true)
  })

  test("keeps source revealed for an inactive nonempty selection", () => {
    const doc = "![alt](https://example.com/image.png)"
    const inactive = decorationRanges(markdownState(doc), false)
    expect(inactive.some(({ kind }) => kind === "image")).toBe(true)

    const decorations = decorationRanges(markdownState(doc, 2, 5), false)
    expect(decorations.some(({ kind }) => kind === "image")).toBe(false)
  })

  test("hides inactive inline source while retaining rendered text marks", () => {
    const state = markdownState("A **bold** [link](url) ~~gone~~ `code`.")
    const decorations = decorationRanges(state)
    const hidden = decorations
      .filter(({ kind }) => kind === "delimiter" || kind === "url")
      .map(({ text }) => text)

    expect(hidden).toEqual([
      "**",
      "**",
      "[",
      "]",
      "(",
      "url",
      ")",
      "~~",
      "~~",
      "`",
      "`",
    ])
    expect(
      decorations.some(({ className }) => className === "cm-md-strong")
    ).toBe(true)
    expect(
      decorations.some(({ className }) =>
        String(className).includes("cm-md-link")
      )
    ).toBe(true)
    expect(
      decorations.find(({ className }) => className === "cm-md-strikethrough")
        ?.text
    ).toBe("gone")
    expect(
      decorations.some(({ className }) => className === "cm-md-inline-code")
    ).toBe(true)
  })

  test("reveals the complete construct touched by the selection", () => {
    const doc = "A **bold** [link](url)"
    const state = markdownState(doc, doc.indexOf("bold") + 1)
    const hidden = decorationRanges(state)
      .filter(({ kind }) => kind === "delimiter" || kind === "url")
      .map(({ text }) => text)

    expect(hidden).not.toContain("**")
    expect(hidden).toEqual(["[", "]", "(", "url", ")"])
  })

  test("keeps a task marker rendered as one semantic checkbox prefix", () => {
    const doc = "intro\n\n- [x] completed"
    const inactive = decorationRanges(markdownState(doc))
    expect(inactive.find(({ kind }) => kind === "task")).toMatchObject({
      text: "- [x] ",
      widgetTaskText: "completed",
    })
    expect(taskCheckboxAccessibleName(true, "completed")).toBe(
      "Completed task: completed"
    )
    expect(taskCheckboxAccessibleName(false, "write release notes")).toBe(
      "Incomplete task: write release notes"
    )
    expect(inactive.some(({ kind }) => kind === "list-marker")).toBe(false)

    const active = decorationRanges(markdownState(doc, doc.indexOf("x")))
    expect(active.find(({ kind }) => kind === "task")).toMatchObject({
      text: "- [x] ",
      widgetTaskText: "completed",
    })
  })

  test("keeps ordered markers visible beside ordered-task checkboxes", () => {
    const doc = "intro\n\n1. [x] completed\n2) [ ] open"
    const inactive = decorationRanges(markdownState(doc))

    expect(
      inactive
        .filter(({ kind }) => kind === "list-marker")
        .map(({ text, widgetLabel }) => ({ text, widgetLabel }))
    ).toEqual([
      { text: "1.", widgetLabel: "1." },
      { text: "2)", widgetLabel: "2)" },
    ])
    expect(
      inactive
        .filter(({ kind }) => kind === "task")
        .map(({ text, widgetTaskText }) => ({ text, widgetTaskText }))
    ).toEqual([
      { text: "[x] ", widgetTaskText: "completed" },
      { text: "[ ] ", widgetTaskText: "open" },
    ])
  })

  test("normalizes direct selections to complete task atoms in live mode", () => {
    const doc = "- [ ] alpha\n1. [x] beta"
    const create = (anchor = 0, head = anchor) =>
      markdownState(doc, anchor, head, [
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ])

    for (const [position, expected] of [
      [1, 0],
      [3, 6],
      [5, 6],
      [16, 15],
      [17, 19],
      [18, 19],
    ] as const) {
      const updated = create().update({ selection: { anchor: position } }).state
      expect(updated.selection.main.head).toBe(expected)
    }

    const forward = create().update({
      selection: { anchor: 2, head: 17 },
    }).state.selection.main
    expect({ anchor: forward.anchor, head: forward.head }).toEqual({
      anchor: 0,
      head: 19,
    })

    const backward = create().update({
      selection: { anchor: 18, head: 1 },
    }).state.selection.main
    expect({ anchor: backward.anchor, head: backward.head }).toEqual({
      anchor: 19,
      head: 0,
    })

    const source = markdownState(
      doc,
      0,
      0,
      livePreviewFocusTrackingExtension
    ).update({ selection: { anchor: 3 } }).state
    expect(source.selection.main.head).toBe(3)
  })

  test("publishes task replacements for the complete document", () => {
    const doc = Array.from(
      { length: 300 },
      (_, index) => `- [ ] task ${index + 1}`
    ).join("\n")
    const state = markdownState(doc, 0, 0, [
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ])
    let tasks = 0
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === "function") continue
      source.between(0, state.doc.length, (_from, _to, decoration) => {
        if (decoration.spec.markdownPreviewKind === "task") tasks += 1
      })
    }
    expect(tasks).toBe(300)
  })

  test("renders an inactive thematic break as a semantic line", () => {
    const doc = "intro\n\n---"
    const state = markdownState(doc)
    const decorations = decorationRanges(state)

    expect(
      decorations.some(
        ({ kind, text }) => kind === "horizontal-rule" && text === "---"
      )
    ).toBe(true)
    expect(
      decorations.some(
        ({ className }) => className === "cm-md-horizontal-rule-line"
      )
    ).toBe(true)

    const active = decorationRanges(markdownState(doc, doc.length - 1))
    expect(active.some(({ kind }) => kind === "horizontal-rule")).toBe(false)
    expect(
      active.some(({ className }) => className === "cm-md-horizontal-rule-line")
    ).toBe(false)
  })

  test("keeps a visible marker for unordered and ordered list items", () => {
    const state = markdownState("intro\n\n- first\n\n2. second")
    const markers = decorationRanges(state).filter(
      ({ kind }) => kind === "list-marker"
    )

    expect(markers.map(({ text }) => text)).toEqual(["-", "2."])
  })

  test("keeps every allowed list-marker separator source-mapped", () => {
    const doc = ["-   bullet", "1.    ordered", "-\ttabbed"].join("\n")
    const decorations = decorationRanges(markdownState(doc), false)

    expect(
      decorations
        .filter(
          ({ className }) => className === "cm-md-list-marker-separator-source"
        )
        .map(({ text }) => text)
    ).toEqual(["   ", "    ", "\t"])
    expect(
      decorations
        .filter(({ kind }) => kind === "list-marker")
        .map(({ text }) => text)
    ).toEqual(["-", "1.", "-"])
  })

  test("keeps quote containers source-mapped on nested list lines", () => {
    const doc = [
      "intro",
      "",
      "> 1. ordered",
      ">    - bullet",
      "> > 2. nested",
    ].join("\n")
    const inactive = decorationRanges(markdownState(doc), false)
    const active = decorationRanges(
      markdownState(doc, doc.indexOf("bullet") + 1),
      true
    )
    const quotePrefixes = (decorations: ReturnType<typeof decorationRanges>) =>
      decorations
        .filter(({ kind }) => kind === "list-quote-prefix")
        .map(({ from, text, to }) => ({ from, text, to }))

    expect(quotePrefixes(inactive).map(({ text }) => text)).toEqual([
      "> ",
      "> ",
      "> > ",
    ])
    expect(quotePrefixes(active)).toEqual(quotePrefixes(inactive))
    expect(
      inactive.some(
        ({ kind, text }) => kind === "delimiter" && text.includes(">")
      )
    ).toBe(false)
  })

  test("cancels only outer list indentation while editing a nested callout", () => {
    const doc = [
      "1. parent",
      "",
      "   > [!success] Nested card",
      "   > ```typescript",
      "   > const combined = true;",
      "   > ```",
    ].join("\n")
    const state = markdownState(
      doc,
      doc.indexOf("combined"),
      doc.indexOf("combined"),
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const decorations = decorationRanges(state)
    const continuationLines = decorations
      .filter(({ className }) =>
        String(className).includes("cm-md-list-continuation-line")
      )
      .map(({ from }) => state.doc.lineAt(from).number)

    expect(state.facet(calloutEditingRange)).not.toBeNull()
    expect(continuationLines).toEqual([3, 4, 5, 6])
    expect(
      decorations
        .filter(({ kind }) => kind === "list-indent-source")
        .map(({ text }) => text)
    ).toEqual(["   ", "   ", "   ", "   "])
    expect(
      decorations.filter(({ kind }) => kind === "list-quote-prefix")
    ).toEqual([])
  })

  test("preserves outer quote and list lanes before the active callout mark", () => {
    const doc = [
      "> [!note] Outer",
      "> 1. parent",
      ">",
      ">    > [!success] Inner",
      ">    > ```ts",
      ">    > value",
      ">    > ````",
    ].join("\n")
    const state = markdownState(
      doc,
      doc.indexOf("value"),
      doc.indexOf("value"),
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const editing = state.facet(calloutEditingRange)
    const decorations = decorationRanges(state).filter(
      ({ from }) => editing != null && from >= editing.from
    )
    const locations = (kind: string) =>
      decorations
        .filter((decoration) => decoration.kind === kind)
        .map(({ from, text, to }) => {
          const line = state.doc.lineAt(from)
          return {
            from: from - line.from,
            line: line.number,
            text,
            to: to - line.from,
          }
        })

    expect(editing).toEqual({ from: state.doc.line(4).from, to: doc.length })
    expect(locations("list-quote-prefix")).toEqual([
      { from: 0, line: 4, text: "> ", to: 2 },
      { from: 0, line: 5, text: "> ", to: 2 },
      { from: 0, line: 6, text: "> ", to: 2 },
      { from: 0, line: 7, text: "> ", to: 2 },
    ])
    expect(locations("list-indent-source")).toEqual([
      { from: 2, line: 4, text: "   ", to: 5 },
      { from: 2, line: 5, text: "   ", to: 5 },
      { from: 2, line: 6, text: "   ", to: 5 },
      { from: 2, line: 7, text: "   ", to: 5 },
    ])
  })

  test("keeps inner list continuation geometry raw while a callout is edited", () => {
    const doc = [
      "1. outer",
      "",
      "   > [!note] Active",
      "   > - child",
      "   >   authored continuation",
    ].join("\n")
    const state = markdownState(
      doc,
      doc.indexOf("authored"),
      doc.indexOf("authored"),
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const editing = state.facet(calloutEditingRange)
    const decorations = decorationRanges(state)
    const innerListLines = decorations.filter(
      ({ className, from }) =>
        [4, 5].includes(state.doc.lineAt(from).number) &&
        String(className).includes("cm-md-list-continuation-line")
    )

    expect(editing).toEqual({ from: state.doc.line(3).from, to: doc.length })
    expect(
      innerListLines.map(({ from, kind }) => ({
        kind,
        line: state.doc.lineAt(from).number,
      }))
    ).toEqual([
      { kind: "list-continuation-line:1", line: 4 },
      { kind: "list-continuation-line:1", line: 5 },
    ])
    for (const continuation of innerListLines) {
      expect(String(continuation.className)).toContain("cm-md-list-depth-1")
      expect(String(continuation.className)).not.toContain("cm-md-list-depth-2")
      expect(
        (continuation.attributes as { style?: string } | undefined)?.style
      ).toContain("--cm-md-list-hanging-indent:1.5rem")
    }
    expect(
      decorations.some(
        ({ from, kind }) =>
          editing != null && from >= editing.from && kind === "list-marker"
      )
    ).toBe(false)
  })

  test("keeps a tab separator in a preceding quote lane", () => {
    const doc = [
      "> [!note] Outer",
      "> 1. parent",
      ">",
      ">\t   > [!success] Inner",
      ">\t   > value",
    ].join("\n")
    const state = markdownState(
      doc,
      doc.indexOf("value"),
      doc.indexOf("value"),
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const editing = state.facet(calloutEditingRange)
    const bodyLine = state.doc.line(5)
    const decorations = decorationRanges(state).filter(
      ({ from }) => from >= bodyLine.from && from <= bodyLine.to
    )

    expect(editing).toEqual({ from: state.doc.line(4).from, to: doc.length })
    expect(
      decorations
        .filter(({ kind }) => kind === "list-quote-prefix")
        .map(({ text }) => text)
    ).toEqual([">\t"])
    expect(
      decorations
        .filter(({ kind }) => kind === "list-indent-source")
        .map(({ text }) => text)
    ).toEqual(["   "])
  })

  test("uses the complete callout tree when its body exceeds the viewport tree", () => {
    const trailingBody = Array.from(
      { length: 1_000 },
      (_, index) => `>    > trailing ${index}`
    )
    const doc = [
      "> [!note] Outer",
      "> 1. parent",
      ">",
      ">    > [!success] Inner",
      ...trailingBody,
    ].join("\n")
    const state = markdownState(
      doc,
      doc.lastIndexOf("trailing"),
      doc.lastIndexOf("trailing"),
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const header = state.doc.line(4)
    const decorations: Array<{ kind: unknown; text: string }> = []
    buildLivePreviewDecorations(state, [
      { from: header.from, to: header.to },
    ]).between(header.from, header.to, (from, to, value: Decoration) => {
      decorations.push({
        kind: value.spec.markdownPreviewKind,
        text: state.sliceDoc(from, to),
      })
    })

    expect(state.facet(calloutEditingRange)).toEqual({
      from: header.from,
      to: doc.length,
    })
    expect(
      decorations
        .filter(({ kind }) => kind === "list-quote-prefix")
        .map(({ text }) => text)
    ).toEqual(["> "])
    expect(
      decorations
        .filter(({ kind }) => kind === "list-indent-source")
        .map(({ text }) => text)
    ).toEqual(["   "])
  })

  test("uses the complete tree when a trailing rendered callout first becomes visible", () => {
    const doc = [
      ...Array.from({ length: 1_000 }, (_, index) => `Prose row ${index}`),
      "",
      "> [!Important] Rendering invariant",
      "> 1. Keep the rendered callout coherent without exposing source prefixes.",
    ].join("\n")
    const state = markdownState(
      doc,
      0,
      0,
      calloutBlockExtension({ selectionActiveState: () => true })
    )
    const header = state.doc.line(state.doc.lines - 1)
    const body = state.doc.line(state.doc.lines)
    const decorations: Array<{ kind: unknown; text: string }> = []

    buildLivePreviewDecorations(
      state,
      [{ from: header.from, to: body.to }],
      false
    ).between(header.from, body.to, (from, to, value: Decoration) => {
      decorations.push({
        kind: value.spec.markdownPreviewKind,
        text: state.sliceDoc(from, to),
      })
    })

    expect(
      decorations.some(
        ({ kind, text }) => kind === "delimiter" && text === "> "
      )
    ).toBe(true)
    expect(
      decorations.some(
        ({ kind, text }) => kind === "list-quote-prefix" && text === "> "
      )
    ).toBe(true)
  })

  test("partitions alternating list and quote stacks into one ordered prefix", () => {
    const sources = [
      "- > quote",
      "- >   - nested",
      "> - > - mixed",
      "> - outer",
      ">   > - inner",
    ]
    const doc = sources.join("\n")
    const state = markdownState(doc)
    const decorations = decorationRanges(state, false)
    const sourcePrefixKinds = new Set([
      "list-indent-source",
      "list-marker",
      "list-marker-separator-source",
      "list-quote-prefix",
    ])

    for (let lineNumber = 1; lineNumber <= sources.length; lineNumber += 1) {
      const line = state.doc.line(lineNumber)
      const content = /(?:quote|nested|mixed|outer|inner)$/.exec(line.text)!
      const prefix = line.text.slice(0, content.index)
      const ranges = decorations
        .filter(
          ({ from, kind, to }) =>
            sourcePrefixKinds.has(String(kind)) &&
            from >= line.from &&
            to <= line.to
        )
        .sort((left, right) => left.from - right.from || left.to - right.to)

      expect(ranges.map(({ text }) => text).join(""), line.text).toBe(prefix)
      expect(ranges[0]?.from, line.text).toBe(line.from)
      expect(ranges.at(-1)?.to, line.text).toBe(line.from + prefix.length)
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index]!.from, line.text).toBe(ranges[index - 1]!.to)
      }
    }
  })

  test("uses one ordered-marker lane for every sibling in a list", () => {
    const state = markdownState("1. one\n999999999. nine\n2. two")
    const markerLanes = decorationRanges(state, false)
      .filter(({ kind }) => kind === "list-marker")
      .map(
        ({ attributes }) =>
          (attributes as { style: string }).style.match(
            /--cm-md-list-current-marker-lane:([^;]+)/
          )?.[1]
      )

    expect(markerLanes).toHaveLength(3)
    expect(new Set(markerLanes).size).toBe(1)
  })

  test("keeps ordinary list prefix ranges stable when the item becomes active", () => {
    const doc = [
      "1. root",
      "   a. alpha",
      "   b. beta",
      "",
      "123456. mixed root",
      "        - [ ] task child",
      "          - bullet child",
      "            123456. ordered child",
      "                    - deep",
      "",
      "- tab root",
      "\t- tab child",
    ].join("\n")
    const inactive = decorationRanges(markdownState(doc), false)
    const active = decorationRanges(
      markdownState(doc, doc.indexOf("deep") + 1),
      true
    )
    const prefixRanges = (decorations: ReturnType<typeof decorationRanges>) =>
      decorations
        .filter(
          ({ className, kind }) =>
            kind === "list-marker" ||
            className === "cm-md-list-indent-source" ||
            className === "cm-md-list-marker-separator-source"
        )
        .map(({ from, text, to }) => ({ from, text, to }))

    expect(prefixRanges(active)).toEqual(prefixRanges(inactive))
    expect(prefixRanges(active).map(({ text }) => text)).toContain(
      "                    "
    )
    expect(prefixRanges(active).map(({ text }) => text)).toContain("\t")
  })

  test("renders alphabetic and Roman markers as authored ordered lists", () => {
    const state = markdownState(
      [
        "intro",
        "",
        "1. parent",
        "   a. alpha",
        "   b. beta",
        "   iv. roman",
        "z. rollover",
        "aa. continued",
      ].join("\n")
    )
    const markers = decorationRanges(state, false).filter(
      ({ kind }) => kind === "list-marker"
    )

    expect(markers.map(({ text }) => text)).toEqual([
      "1.",
      "a.",
      "b.",
      "iv.",
      "z.",
      "aa.",
    ])
    expect(markers.map(({ widgetLabel }) => widgetLabel)).toEqual([
      "1.",
      "a.",
      "b.",
      "iv.",
      "z.",
      "aa.",
    ])
  })

  test.each([
    ["bullet", "- first\nordinary prose\n- second"],
    ["decimal", "1. first\nordinary prose\n2. second"],
    ["alphabetic", "a. first\nordinary prose\nb. second"],
    ["quoted", "> 1. first\n> ordinary prose\n> 2. second"],
  ])(
    "leaves unindented prose between %s list markers at the document margin",
    (_kind, doc) => {
      const state = markdownState(doc)
      expect(listLineNumbers(state)).toEqual([1, 3])
    }
  )

  test("keeps a post-list line at the document margin as prose is typed", () => {
    let state = markdownState("- item\n", 7)
    expect(listLineNumbers(state)).toEqual([1])

    state = state.update({
      changes: { from: state.doc.length, insert: "ordinary prose" },
      selection: { anchor: state.doc.length + "ordinary prose".length },
      userEvent: "input.type",
    }).state

    expect(listLineNumbers(state)).toEqual([1])
  })

  test("renders authored indentation instead of CommonMark lazy ownership", () => {
    const state = markdownState(
      ["- item", "lazy continuation", "  authored continuation"].join("\n")
    )

    expect(listLineNumbers(state)).toEqual([1, 3])
  })

  test("retains semantic continuations through alternating containers", () => {
    const state = markdownState(
      [
        "- > - inner",
        "  >   continuation",
        "> - > - nested",
        ">   >   continuation",
      ].join("\n")
    )

    expect(listLineNumbers(state)).toEqual([1, 2, 3, 4])
    const quotePrefixesByLine = Map.groupBy(
      decorationRanges(state, false).filter(
        ({ kind }) => kind === "list-quote-prefix"
      ),
      ({ from }) => state.doc.lineAt(from).number
    )
    expect(
      [...quotePrefixesByLine]
        .sort(([left], [right]) => left - right)
        .map(([line, prefixes]) => [line, prefixes.map(({ text }) => text)])
    ).toEqual([
      [1, ["> "]],
      [2, ["  > "]],
      [3, ["> ", "> "]],
      [4, [">   > "]],
    ])
  })

  test("uses authored indentation to retain only the applicable list depth", () => {
    const doc = [
      "- outer",
      "  - inner",
      "ordinary prose",
      "  parent continuation",
      "    child continuation",
      "- next",
    ].join("\n")
    const state = markdownState(doc)
    expect(listLineNumbers(state)).toEqual([1, 2, 4, 5, 6])
  })

  test("restarts unordered marker cycles after ordered and task items", () => {
    const state = markdownState(
      [
        "- root",
        "  - nested",
        "    - deep",
        "1. number",
        "   - fresh after number",
        "     - nested after number",
        "- [ ] task",
        "  - fresh after task",
        "    - nested after task",
      ].join("\n")
    )
    const markerLabels = decorationRanges(state, false)
      .filter(({ kind }) => kind === "list-marker")
      .map(({ widgetLabel }) => widgetLabel)

    expect(markerLabels).toEqual(["•", "◦", "▪", "1.", "•", "◦", "•", "◦"])
  })

  test("indents a restarted filled bullet beneath its ordered parent", () => {
    const state = markdownState(
      [
        "1. First step",
        "2. Second step",
        "   1. Sub-step 2a",
        "      - nested filled bullet",
        "        - nested open bullet",
        "   2. Sub-step 2b",
        "3. Third step",
      ].join("\n")
    )
    const decorations = decorationRanges(state, false)
    const markerLabels = decorations
      .filter(({ kind }) => kind === "list-marker")
      .map(({ widgetLabel }) => widgetLabel)
    const markerLines = decorations.filter(
      ({ className }) =>
        typeof className === "string" &&
        className.includes("cm-md-list-marker-line")
    )

    expect(markerLabels).toEqual(["1.", "2.", "1.", "•", "◦", "2.", "3."])
    expect(
      markerLines.map(
        ({ attributes }) =>
          (attributes as { style: string }).style.match(
            /--cm-md-list-hanging-indent:([^;]+)/
          )?.[1]
      )
    ).toEqual(["1.5rem", "1.5rem", "3rem", "4.5rem", "6rem", "3rem", "1.5rem"])
  })

  test("hides inactive table pipes and the separator source row", () => {
    const state = markdownState("intro\n\n| A | B |\n|---|---|\n| x | y |")
    const decorations = decorationRanges(state)
    const hiddenTableSource = decorations
      .filter(({ kind }) => kind === "delimiter")
      .map(({ text }) => text)

    expect(hiddenTableSource).toContain("|---|---|")
    expect(hiddenTableSource.filter((text) => text === "|")).toHaveLength(6)
    expect(
      decorations
        .filter(({ className }) =>
          String(className).includes("cm-md-table-cell")
        )
        .map(({ text }) => text.trim())
    ).toEqual(["A", "B", "x", "y"])
    expect(
      decorations.some(({ className }) =>
        String(className).includes("cm-md-table-header")
      )
    ).toBe(true)
    expect(
      decorations.some(({ className }) =>
        String(className).includes("cm-md-table-row")
      )
    ).toBe(true)
    expect(
      decorations.some(({ className }) => className === "cm-md-table-separator")
    ).toBe(true)
  })

  test("starts nested table wrappers and row decorations at the source line", () => {
    const doc = [
      "- item",
      "",
      "  | A | B |",
      "  |---|---|",
      "  | x | y |",
    ].join("\n")
    const headerLineFrom = doc.indexOf("  | A")
    const bodyLineFrom = doc.indexOf("  | x")
    const decorations = decorationRanges(markdownState(doc))
    const tableLines = decorations.filter(({ className }) =>
      String(className).includes("cm-md-table-line")
    )
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })

    expect(
      tableLines.map(({ className, from }) => ({ className, from }))
    ).toEqual([
      {
        className: "cm-md-table-line cm-md-table-header",
        from: headerLineFrom,
      },
      {
        className: "cm-md-table-line cm-md-table-row",
        from: bodyLineFrom,
      },
    ])
    expect(stateBackedTableWrapperRanges(state)).toEqual([
      { from: headerLineFrom, to: doc.length },
    ])
  })

  test("keeps the table layout invariant when its selection moves", () => {
    const doc = "| A | B |\n|---|---|\n| x | y |"
    const decorations = decorationRanges(markdownState(doc, doc.indexOf("x")))
    const hidden = decorations
      .filter(({ kind }) => kind === "delimiter")
      .map(({ text }) => text)

    expect(hidden.filter((text) => text === "|")).toHaveLength(6)
    expect(hidden).toContain("|---|---|")
    expect(
      decorations
        .filter(({ className }) =>
          String(className).includes("cm-md-table-cell")
        )
        .map(({ text }) => text.trim())
    ).toEqual(["A", "B", "x", "y"])
    expect(
      decorations.some(({ className }) =>
        String(className).includes("cm-md-table-row")
      )
    ).toBe(true)
  })

  test("keeps a typing cursor on the visible side of a mapped table pipe", () => {
    const doc = "| A | B |\n|---|---|\n| one | two |"
    const finalPipe = doc.lastIndexOf("|")
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(finalPipe, -1),
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })
    const typed = state.update({
      changes: { from: finalPipe, insert: "A" },
      selection: EditorSelection.cursor(finalPipe + 1),
    }).state

    expect(typed.sliceDoc(finalPipe + 1, finalPipe + 2)).toBe("|")
    expect(typed.selection.main).toMatchObject({
      assoc: -1,
      head: finalPipe + 1,
    })
  })

  test("drops table layout ranges when the whole table is deleted or replaced", () => {
    const doc = "| A | B |\n|---|---|\n| one | two |"
    const extensions = [
      markdown({ base: markdownLanguage }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    const state = EditorState.create({ doc, extensions })
    expect(stateBackedTableWrapperCount(state)).toBe(1)

    const deleted = state.update({
      changes: { from: 0, to: state.doc.length },
    }).state
    expect(deleted.doc.length).toBe(0)
    expect(stateBackedTableWrapperCount(deleted)).toBe(0)

    const replaced = state.update({
      changes: { from: 0, to: state.doc.length, insert: "plain" },
    }).state
    expect(replaced.doc.toString()).toBe("plain")
    expect(stateBackedTableWrapperCount(replaced)).toBe(0)
  })

  test("creates stable structural cells for empty and whole-cell inline syntax", () => {
    const doc =
      "| **bold** | [link](url) | `code` |   |\n" +
      "|---|---|---|---|\n" +
      "| plain | | ~~gone~~ | x |\n" +
      "| short |"
    const decorations = decorationRanges(markdownState(doc))
    const cells = decorations.filter(({ className }) => {
      const classes = String(className)
      return (
        classes.includes("cm-md-table-cell") &&
        !classes.includes("cm-md-table-cell-empty")
      )
    })
    const emptyCells = decorations.filter(
      ({ kind }) => kind === "table-empty-cell"
    )
    const sourceEmptyCells = decorations.filter(({ className, kind }) => {
      return (
        kind !== "table-empty-cell" &&
        String(className).includes("cm-md-table-cell-empty")
      )
    })

    expect(cells.map(({ text }) => text.trim())).toEqual([
      "**bold**",
      "[link](url)",
      "`code`",
      "plain",
      "~~gone~~",
      "x",
      "short",
    ])
    expect(sourceEmptyCells.map(({ text }) => text)).toEqual(["   ", " "])
    expect(emptyCells.map(({ text }) => text)).toEqual(["", "", ""])
  })

  test("omits body cells beyond the header column count", () => {
    const doc = "| A | B |\n|---|---|\n| one | two | three |"
    const decorations = decorationRanges(markdownState(doc))
    const cells = decorations.filter(({ className }) =>
      String(className).includes("cm-md-table-cell")
    )
    const excess = decorations.filter(
      ({ kind }) => kind === "table-excess-cell"
    )

    expect(cells.map(({ text }) => text.trim())).toEqual([
      "A",
      "B",
      "one",
      "two",
    ])
    expect(excess.map(({ text }) => text)).toEqual([" three "])
  })

  test("limits block line decorations to the requested visible range", () => {
    const doc = Array.from(
      { length: 40 },
      (_, index) => `- item ${index}`
    ).join("\n")
    const state = markdownState(doc)
    const visibleLine = state.doc.line(20)
    const decorations = buildLivePreviewDecorations(state, [
      { from: visibleLine.from, to: visibleLine.to },
    ])
    const listLines: number[] = []

    decorations.between(0, state.doc.length, (from, _to, value: Decoration) => {
      if (value.spec.class === "cm-md-list-line") listLines.push(from)
    })

    expect(listLines).toEqual([visibleLine.from])
  })

  test("gives every rendered list depth the same visual step", () => {
    const doc = Array.from(
      { length: 6 },
      (_, depth) => `${"  ".repeat(depth)}- level ${depth + 1}`
    ).join("\n")
    const markerLines = decorationRanges(markdownState(doc), false).filter(
      ({ className }) =>
        typeof className === "string" &&
        className.includes("cm-md-list-marker-line")
    )

    expect(markerLines).toHaveLength(6)
    expect(
      markerLines.map(
        ({ attributes }) =>
          (attributes as { style: string }).style.match(
            /--cm-md-list-hanging-indent:([^;]+)/
          )?.[1]
      )
    ).toEqual(["1.5rem", "3rem", "4.5rem", "6rem", "7.5rem", "9rem"])
  })

  test("resolves canonical local, fragment, email, and GFM autolink targets", () => {
    const doc = [
      '[local](other.md#Details "Local title")',
      "[empty]()",
      "[fragment](#section%20name)",
      "[email](mailto:inline@example.com)",
      "<angle@example.com>",
      "www.example.com/docs",
      "bare@example.com",
      "mailto:protocol@example.com",
      "xmpp:chat@example.com",
      `[scratch](pulse-md://scratch/${scratchId}#Notes%20Here)`,
      "<custom:opaque>",
      "[unsafe](javascript:payload)",
      "[entity](https://example.com/?a=1&amp;b=2)",
      "[escaped](https://example.com?find=\\*)",
      "<https://example.com?find=\\*>",
      "[full][TaRgEt]",
      "[collapsed][]",
      "[shortcut]",
      "[unresolved]",
      "",
      '[target]: <other file.md> "Reference title"',
      "[collapsed]: https://example.com/collapsed",
      "[shortcut]: https://example.com/shortcut",
    ].join("\n")
    const state = markdownState(doc)
    const target = (text: string) =>
      markdownLinkTargetAt(state, doc.indexOf(text) + 1)

    expect(target("local")).toMatchObject({
      destination: "other.md#Details",
      title: "Local title",
      activation: {
        kind: "local",
        destination: "other.md",
        fragment: "Details",
      },
    })
    expect(target("empty")?.activation).toEqual({
      kind: "fragment",
      fragment: "",
    })
    expect(target("fragment")?.activation).toEqual({
      kind: "fragment",
      fragment: "section name",
    })
    expect(target("email")?.activation).toMatchObject({
      kind: "external",
      protocol: "mailto:",
    })
    expect(target("angle@example.com")?.activation).toMatchObject({
      kind: "external",
      href: "mailto:angle@example.com",
    })
    expect(target("bare@example.com")?.activation).toMatchObject({
      kind: "external",
      href: "mailto:bare@example.com",
    })
    expect(target("www.example.com")?.activation).toMatchObject({
      kind: "external",
      href: "http://www.example.com/docs",
    })
    expect(target("mailto:protocol")?.activation).toMatchObject({
      kind: "external",
      protocol: "mailto:",
    })
    expect(target("xmpp:chat")?.activation).toMatchObject({
      kind: "external",
      protocol: "xmpp:",
    })
    expect(target("scratch")?.activation).toEqual({
      kind: "scratch",
      fragment: "Notes Here",
      href: `pulse-md://scratch/${scratchId}#Notes%20Here`,
      identity: { scratchId },
      scheme: "pulse-md",
    })
    expect(target("custom:opaque")).toMatchObject({
      destination: "custom:opaque",
      activation: null,
    })
    expect(target("unsafe")).toMatchObject({ activation: null })
    expect(target("entity")).toMatchObject({
      destination: "https://example.com/?a=1&b=2",
      activation: {
        kind: "external",
        href: "https://example.com/?a=1&b=2",
      },
    })
    expect(target("escaped")?.activation).toMatchObject({
      href: "https://example.com/?find=*",
    })
    expect(target("<https://example.com?find")?.activation).toMatchObject({
      href: "https://example.com/?find=%5C*",
    })
    expect(target("full")).toMatchObject({
      destination: "other file.md",
      title: "Reference title",
    })
    expect(target("collapsed")?.destination).toBe(
      "https://example.com/collapsed"
    )
    expect(target("shortcut")?.destination).toBe("https://example.com/shortcut")
    expect(target("unresolved")).toBeNull()
  })

  test("renders an empty inline destination without a zero-width replacement", () => {
    const doc = "Before\n\n[Empty destination]()\n\nAfter"
    const decorations = decorationRanges(markdownState(doc))

    expect(
      decorations.find(
        ({ className, text }) =>
          String(className).includes("cm-md-link") &&
          text === "Empty destination"
      )
    ).toBeDefined()
    expect(
      decorations
        .filter(
          ({ kind, from }) => kind === "delimiter" && from >= doc.indexOf("[")
        )
        .map(({ text }) => text)
    ).toEqual(["[", "]", "(", ")"])
  })

  test("normalizes reference labels without parsing their inline source", () => {
    const doc = [
      "[unicode][STRASSE]",
      "[escaped][foo\\!]",
      "[literal][foo!]",
      "[first][duplicate]",
      "",
      "[Straße]: /unicode",
      "[foo!]: /literal",
      "[duplicate]: /first",
      "[DUPLICATE]: /second",
    ].join("\n")
    const state = markdownState(doc)
    const target = (text: string) =>
      markdownLinkTargetAt(state, doc.indexOf(text) + 1)

    expect(target("unicode")?.destination).toBe("/unicode")
    expect(target("escaped")).toBeNull()
    expect(target("literal")?.destination).toBe("/literal")
    expect(target("first")?.destination).toBe("/first")
  })

  test("indexes a reference definition beyond the incremental parse window", () => {
    const doc = [
      "[far reference][target]",
      "",
      "x".repeat(250_000),
      "",
      "[target]: other.md#destination",
    ].join("\n")
    const state = markdownState(doc)

    expect(
      markdownLinkTargetAt(state, doc.indexOf("far reference") + 1)
    ).toMatchObject({
      destination: "other.md#destination",
      activation: {
        kind: "local",
        destination: "other.md",
        fragment: "destination",
      },
    })
  })

  test("decodes only numeric references allowed by CommonMark", () => {
    expect(
      decodeMarkdownCharacterReferences("&#65; &#x41; &#00000065; &#x0000041;")
    ).toBe("A A &#00000065; &#x0000041;")
  })

  test("keeps unresolved brackets literal and hides rendered titles and definitions", () => {
    const doc = [
      'Intro [inline](destination "Inline title")',
      "[resolved][target]",
      "[unresolved]",
      "",
      '[target]: /reference "Reference title"',
      "[unused]: /unused",
    ].join("\n")
    const state = markdownState(doc)
    const decorations = decorationRanges(state)
    const hidden = decorations.filter(
      ({ kind }) => kind === "delimiter" || kind === "url"
    )

    expect(
      hidden.some(({ text }) => text === 'destination "Inline title"')
    ).toBe(true)
    expect(
      decorations.find(
        ({ className, text }) =>
          String(className).includes("cm-md-link") && text === "inline"
      )?.attributes
    ).toMatchObject({ "data-markdown-link-title": "Inline title" })
    expect(
      decorations
        .filter(({ kind }) => kind === "link-reference")
        .map(({ text }) => text)
    ).toEqual(['[target]: /reference "Reference title"\n[unused]: /unused'])
    expect(hidden.some(({ text }) => text === "[" || text === "]")).toBe(true)
    const unresolvedFrom = doc.indexOf("[unresolved]")
    expect(
      hidden.some(
        ({ from, to }) => from >= unresolvedFrom && to <= unresolvedFrom + 12
      )
    ).toBe(false)

    const definitionCursor = doc.indexOf("/reference") + 2
    expect(
      decorationRanges(markdownState(doc, definitionCursor)).some(
        ({ kind, text }) =>
          kind === "link-reference" && text.includes("/reference")
      )
    ).toBe(false)
  })

  test("collapses complete definition blocks but keeps inline lookalikes visible", () => {
    const doc = [
      "Before",
      "",
      "   [single]: /one",
      "[multi]:",
      "  /two",
      '  "Multiline title"',
      "",
      "Inline [literal]: /not-a-definition text",
      "",
      "After",
    ].join("\n")
    const state = markdownState(doc)
    const hidden = decorationRanges(state).filter(
      ({ kind }) => kind === "link-reference"
    )

    expect(hidden.map(({ text }) => text)).toEqual([
      "   [single]: /one\n",
      '[multi]:\n  /two\n  "Multiline title"\n',
    ])
    expect(hidden.some(({ text }) => text.includes("not-a-definition"))).toBe(
      false
    )

    const blankAfterDefinitions = state.doc.line(7).from
    expect(
      decorationRanges(markdownState(doc, blankAfterDefinitions)).filter(
        ({ kind }) => kind === "link-reference"
      )
    ).toHaveLength(2)

    const acrossDefinitions = decorationRanges(
      markdownState(doc, doc.indexOf("Before"), doc.indexOf("Inline"))
    )
    expect(
      acrossDefinitions.some(({ kind }) => kind === "link-reference")
    ).toBe(false)
  })

  test("preserves list and quote containers around nested definitions", () => {
    const doc = [
      "- [nested]: /one",
      "  visible item",
      "",
      "> [quoted]: /two",
      "> visible quote",
    ].join("\n")
    const hidden = decorationRanges(markdownState(doc)).filter(
      ({ kind }) => kind === "link-reference"
    )

    expect(hidden.map(({ text }) => text)).toEqual([
      "[nested]: /one",
      "[quoted]: /two",
    ])
  })

  test("folds definitions beyond CodeMirror's initial parse window", () => {
    const doc = [
      "Before",
      "",
      "x".repeat(250_000),
      "",
      "[far]: /destination",
    ].join("\n")
    const hidden = decorationRanges(markdownState(doc)).filter(
      ({ kind }) => kind === "link-reference"
    )

    expect(hidden).toHaveLength(1)
    expect(hidden[0]?.text).toContain("[far]: /destination")
  })

  test("maps definitions across ordinary typing and refreshes syntax-sensitive edits", () => {
    const doc = [
      `Ordinary paragraph ${"x".repeat(10_000)}`,
      "",
      "[target]: /destination",
    ].join("\n")
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })
    const ordinaryEdit = state.update({
      changes: { from: doc.indexOf("paragraph") + 5, insert: " updated" },
    })
    expect(
      stateBackedLinkReferenceRanges(ordinaryEdit.state).map(({ text }) => text)
    ).toEqual(["\n[target]: /destination"])

    const destinationEnd =
      ordinaryEdit.state.doc.toString().indexOf("/destination") +
      "/destination".length
    const definitionEdit = ordinaryEdit.state.update({
      changes: { from: destinationEnd, insert: " trailing text" },
    })
    expect(stateBackedLinkReferenceRanges(definitionEdit.state)).toEqual([])
  })

  test("reuses indexed definitions and folds across unrelated edits and selections", () => {
    const doc = [
      "[visible][target]",
      "",
      "[target]: /destination",
      "[unused]: /unused",
      "",
      `Ordinary paragraph ${"x".repeat(10_000)}`,
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })
    const definitions = markdownLinkDefinitions(state)

    state = state.update({
      changes: { from: doc.indexOf("paragraph") + 5, insert: " updated" },
    }).state
    expect(markdownLinkDefinitions(state)).toBe(definitions)
    expect(
      markdownLinkTargetAt(state, state.doc.toString().indexOf("visible") + 1)
        ?.destination
    ).toBe("/destination")

    const mappedFolds = stateBackedLinkReferenceDecorationSource(state)
    state = state.update({ selection: { anchor: 3 } }).state
    expect(stateBackedLinkReferenceDecorationSource(state)).toBe(mappedFolds)

    const destination = state.doc.toString().indexOf("/destination")
    state = state.update({
      changes: {
        from: destination,
        to: destination + "/destination".length,
        insert: "/updated",
      },
    }).state
    expect(markdownLinkDefinitions(state)).not.toBe(definitions)
    expect(markdownLinkDefinitions(state).get("target")?.destination).toBe(
      "/updated"
    )
  })

  test("retains a definition fold that only touches an incremental refresh boundary", () => {
    const extensions = [
      markdown({ base: markdownLanguage }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    let state = EditorState.create({
      doc: [
        "[visible][target]",
        "",
        "[target]: /one",
        "",
        "ordinary paragraph abcdef",
        "",
      ].join("\n"),
      extensions,
    })

    state = state.update({ changes: { from: 54, to: 58, insert: "[" } }).state
    state = state.update({ changes: { from: 39, insert: "\n" } }).state
    state = state.update({
      changes: { from: 51, to: 55, insert: "\\]" },
    }).state

    const fresh = EditorState.create({
      doc: state.doc,
      extensions,
    })
    const incrementalFolds = stateBackedLinkReferenceRanges(state)
    expect(incrementalFolds).toEqual(stateBackedLinkReferenceRanges(fresh))
    expect(incrementalFolds).toHaveLength(1)
  })

  test("updates an affected definition while retaining distant duplicates", () => {
    const doc = [
      "[visible][target]",
      "",
      "[target]: /first",
      "",
      `Ordinary paragraph ${"x".repeat(10_000)}`,
      "",
      "[TARGET]: /second",
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })

    const firstDestination = state.doc.toString().indexOf("/first")
    state = state.update({
      changes: {
        from: firstDestination,
        to: firstDestination + "/first".length,
        insert: "/changed",
      },
    }).state
    expect(markdownLinkDefinitions(state).get("target")?.destination).toBe(
      "/changed"
    )

    const firstDefinition = state.doc.line(3)
    state = state.update({
      changes: {
        from: firstDefinition.from,
        to: state.doc.line(4).from,
      },
    }).state
    expect(markdownLinkDefinitions(state).get("target")?.destination).toBe(
      "/second"
    )
  })

  test("rebuilds the definition index after a parser grammar reconfiguration", () => {
    const doc = [
      "---",
      "[metadata]: /not-a-definition",
      "---",
      "",
      "[visible]: /destination",
    ].join("\n")
    const language = new Compartment()
    const presentation = new Compartment()
    const markdownLanguageWithYaml = markdown({
      addKeymap: false,
      base: markdownBaseLanguage,
      extensions: createMarkdownParserExtensions({ yamlFrontMatter: true }),
    })
    const freshPresentation = () => [
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    let state = EditorState.create({
      doc,
      extensions: [
        language.of(
          markdown({
            addKeymap: false,
            base: markdownBaseLanguage,
            extensions: createMarkdownParserExtensions(),
          })
        ),
        presentation.of(freshPresentation()),
      ],
    })

    expect(
      stateBackedLinkReferenceRanges(state).some(({ text }) =>
        text.includes("[metadata]")
      )
    ).toBe(true)

    // A language-only compartment update retains the presentation field and
    // therefore its old full-document index.
    state = state.update({
      effects: language.reconfigure(markdownLanguageWithYaml),
    }).state
    expect(
      stateBackedLinkReferenceRanges(state).some(({ text }) =>
        text.includes("[metadata]")
      )
    ).toBe(true)

    state = state.update({
      effects: presentation.reconfigure(freshPresentation()),
    }).state
    expect(
      stateBackedLinkReferenceRanges(state).map(({ text }) => text.trim())
    ).toEqual(["[visible]: /destination"])
  })

  test("folds a malformed definition as soon as an edit completes it", () => {
    const doc = '[target]: /destination "unfinished'
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })

    expect(stateBackedLinkReferenceRanges(state)).toEqual([])
    const completed = state.update({
      changes: { from: doc.length, insert: '"' },
    }).state
    expect(
      stateBackedLinkReferenceRanges(completed).map(({ text }) => text)
    ).toEqual(['[target]: /destination "unfinished"'])
  })

  test("rechecks a malformed multiline paragraph when it becomes a definition", () => {
    const extensions = [
      markdown({ base: markdownLanguage }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    const doc = [
      "[visible][get]",
      "",
      "[",
      "get]:: /one",
      "",
      "ordinary paragraph",
    ].join("\n")
    let state = EditorState.create({ doc, extensions })
    expect(markdownLinkDefinitions(state).has("get")).toBe(false)

    const secondColon = doc.indexOf(":: ") + 1
    state = state.update({
      changes: { from: secondColon, to: secondColon + 2, insert: '"' },
    }).state
    const fresh = EditorState.create({ doc: state.doc, extensions })

    expect(markdownLinkDefinitions(state)).toEqual(
      markdownLinkDefinitions(fresh)
    )
    expect(markdownLinkDefinitions(state).get("get")?.destination).toBe('"/one')
  })

  test("refreshes distant definitions when a fence changes block context", () => {
    const doc = [
      "Before",
      "",
      "```",
      "code",
      "```",
      "",
      "[target]: /destination",
      "",
    ].join("\n")
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })
    const ordinaryEdit = state.update({
      changes: { from: 3, insert: " updated" },
    }).state
    expect(stateBackedLinkReferenceRanges(ordinaryEdit)).toHaveLength(1)

    const closingFence = ordinaryEdit.doc
      .toString()
      .indexOf("```", ordinaryEdit.doc.toString().indexOf("```") + 3)
    const unclosed = ordinaryEdit.update({
      changes: { from: closingFence, to: closingFence + 4 },
    }).state
    expect(stateBackedLinkReferenceRanges(unclosed)).toEqual([])

    const reclosed = unclosed.update({
      changes: { from: closingFence, insert: "```\n" },
    }).state
    expect(stateBackedLinkReferenceRanges(reclosed)).toHaveLength(1)
  })

  test("rebuilds definitions when an earlier fence re-pairs later delimiters", () => {
    const extensions = [
      markdown({ base: markdownLanguage }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    const doc = [
      "Before",
      "",
      "```",
      "code",
      "```",
      "",
      "[target]: /destination",
      "After",
    ].join("\n")
    const state = EditorState.create({ doc, extensions })
    expect(markdownLinkDefinitions(state).has("target")).toBe(true)

    const incremental = state.update({
      changes: { from: 0, to: 2, insert: "```" },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(markdownLinkDefinitions(incremental)).toEqual(
      markdownLinkDefinitions(fresh)
    )
    expect(markdownLinkDefinitions(incremental).has("target")).toBe(false)
    expect(stateBackedLinkReferenceRanges(incremental)).toEqual(
      stateBackedLinkReferenceRanges(fresh)
    )
  })

  test("refreshes definitions when an inline display-math closer changes context", () => {
    const doc = ["$$", "some math", "[target]: /destination"].join("\n")
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [mathMarkdownExtension],
        }),
        livePreviewFocusTrackingExtension,
        livePreviewExtension(),
      ],
    })

    expect(stateBackedLinkReferenceRanges(state)).toEqual([])
    const closer = doc.indexOf("some math") + "some math".length
    const closed = state.update({
      changes: { from: closer, insert: " $$" },
    }).state
    expect(stateBackedLinkReferenceRanges(closed)).toHaveLength(1)

    const reopened = closed.update({
      changes: { from: closer, to: closer + 3 },
    }).state
    expect(stateBackedLinkReferenceRanges(reopened)).toEqual([])
  })

  test("rebuilds definitions when earlier display math re-pairs later delimiters", () => {
    const extensions = [
      markdown({
        base: markdownLanguage,
        extensions: [mathMarkdownExtension],
      }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    const doc = [
      "Before",
      "",
      "$$",
      "math",
      "$$",
      "",
      "[target]: /destination",
      "After",
    ].join("\n")
    const state = EditorState.create({ doc, extensions })
    expect(markdownLinkDefinitions(state).has("target")).toBe(true)

    const incremental = state.update({
      changes: { from: 0, to: 4, insert: "$$" },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(markdownLinkDefinitions(incremental)).toEqual(
      markdownLinkDefinitions(fresh)
    )
    expect(markdownLinkDefinitions(incremental).has("target")).toBe(false)
    expect(stateBackedLinkReferenceRanges(incremental)).toEqual(
      stateBackedLinkReferenceRanges(fresh)
    )
  })

  test("rechecks display math when a line split activates an existing delimiter", () => {
    const extensions = [
      markdown({
        base: markdownLanguage,
        extensions: [mathMarkdownExtension],
      }),
      livePreviewFocusTrackingExtension,
      livePreviewExtension(),
    ]
    const doc = [
      "Before",
      "",
      "$$",
      "math",
      "$$",
      "",
      "[target]: /destination",
    ].join("\n")
    let state = EditorState.create({ doc, extensions })
    const mathLineEnd = doc.indexOf("\nmath")
    state = state.update({
      changes: { from: 3, to: mathLineEnd, insert: "> $$" },
    }).state
    expect(markdownLinkDefinitions(state).has("target")).toBe(false)

    state = state.update({
      changes: { from: 2, to: 4, insert: "\n" },
    }).state
    const fresh = EditorState.create({ doc: state.doc, extensions })

    expect(markdownLinkDefinitions(state)).toEqual(
      markdownLinkDefinitions(fresh)
    )
    expect(markdownLinkDefinitions(state).has("target")).toBe(true)
  })

  test("activates a link wrapped around a rendered image", () => {
    const doc = [
      '[![image](https://example.com/image.png "Image title")](#destination)',
      "![reference image][asset]",
      "",
      '[asset]: https://example.com/reference.png "Reference image title"',
    ].join("\n")
    const state = markdownState(doc)
    const target = markdownLinkTargetAt(state, doc.indexOf("image") + 1)
    const imageDecorations = decorationRanges(state).filter(
      ({ kind }) => kind === "image"
    )

    expect(target?.activation).toEqual({
      kind: "fragment",
      fragment: "destination",
    })
    expect(
      new Set(imageDecorations.map(({ widgetTitle }) => widgetTitle))
    ).toEqual(new Set(["Image title", "Reference image title"]))
  })

  test("marks every safe activation, while unknown schemes stay inert", () => {
    const doc = [
      "[web](https://example.com)",
      "[email](mailto:reader@example.com)",
      "[local](other.md)",
      "[fragment](#heading)",
      `[scratch](pulse-md://scratch/${scratchId}#heading)`,
      "[unknown](custom:opaque)",
      "[reference][target]",
      "",
      "[target]: http://example.com/reference",
    ].join("\n")
    const decorations = decorationRanges(markdownState(doc))
    const links = decorations.filter(({ className }) =>
      String(className).includes("cm-md-link")
    )
    const classFor = (text: string) =>
      String(links.find((link) => link.text === text)?.className)

    for (const label of [
      "web",
      "email",
      "local",
      "fragment",
      "scratch",
      "reference",
    ]) {
      expect(classFor(label)).toContain("cm-md-openable-link")
    }
    expect(classFor("unknown")).not.toContain("cm-md-openable-link")
  })
})

describe("editor content normalization", () => {
  test("strips a leading BOM and normalizes external line endings to LF", () => {
    expect(normalizeEditorContent("\ufeffone\r\ntwo\rthree")).toBe(
      "one\ntwo\nthree"
    )
  })
})
