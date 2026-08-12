import { markdown } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import { type Decoration, EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { buildLivePreviewDecorations } from "./live-preview"
import { sanitizedHtmlLivePreviewExtension } from "./html-preview"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
  type MarkdownParserExtensionOptions,
} from "./markdown-extensions"
import { mathLivePreviewExtension } from "./math"
import { mermaidLivePreviewExtension } from "./mermaid"

test.each([
  ["math", mathLivePreviewExtension()],
  ["sanitized HTML", sanitizedHtmlLivePreviewExtension()],
  ["Mermaid", mermaidLivePreviewExtension()],
])(
  "provides %s block replacements through a direct state field",
  (_name, extension) => {
    const state = EditorState.create({ extensions: [extension] })
    const decorationSources = state.facet(EditorView.decorations)

    expect(decorationSources.length).toBeGreaterThan(0)
    expect(
      decorationSources.every((source) => typeof source !== "function")
    ).toBe(true)
  }
)

function optionalState(
  doc: string,
  options: Partial<MarkdownParserExtensionOptions>,
  cursor = 0
) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({
        addKeymap: false,
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions(options),
      }),
    ],
  })
}

function previewValues(state: EditorState, selectionActive = true) {
  const values: Array<{
    className: unknown
    from: number
    kind: unknown
    text: string
    to: number
  }> = []
  buildLivePreviewDecorations(
    state,
    [{ from: 0, to: state.doc.length }],
    selectionActive
  ).between(0, state.doc.length, (from, to, value: Decoration) => {
    values.push({
      className: value.spec.class,
      from,
      kind: value.spec.markdownPreviewKind,
      text: state.sliceDoc(from, to),
      to,
    })
  })
  return values
}

describe("optional inline live preview", () => {
  test("renders superscript and subscript while hiding their delimiters", () => {
    const state = optionalState("H~2~O and x^10^", {
      superscriptAndSubscript: true,
    })
    const values = previewValues(state, false)

    expect(
      values.filter(({ kind }) => kind === "delimiter").map(({ text }) => text)
    ).toEqual(["~", "~", "^", "^"])
    expect(
      values.find(({ className }) => className === "cm-md-subscript")?.text
    ).toBe("2")
    expect(
      values.find(({ className }) => className === "cm-md-superscript")?.text
    ).toBe("10")
  })
})

describe("definition-list live preview", () => {
  test.each([["Term\n: Definition"], ["Term\n\n: Definition"]])(
    "renders a paired term and definition",
    (doc) => {
      const state = optionalState(doc, { definitionLists: true })
      const values = previewValues(state, false)

      expect(
        values.some(({ className }) => className === "cm-md-definition-term")
      ).toBe(true)
      expect(
        values.some(
          ({ className }) => className === "cm-md-definition-description"
        )
      ).toBe(true)
      expect(
        values.some(
          ({ kind, text }) => kind === "definition-source-mark" && text === ":"
        )
      ).toBe(true)
      expect(
        values.some(
          ({ kind, text }) =>
            kind === "definition-separator-source" && text === " "
        )
      ).toBe(true)
    }
  )

  test("leaves an unpaired colon block as source", () => {
    const state = optionalState("Term\n\n# Break\n: Not a definition", {
      definitionLists: true,
    })
    const values = previewValues(state, false)

    expect(
      values.some(({ className }) =>
        String(className).includes("cm-md-definition")
      )
    ).toBe(false)
    expect(
      values.some(
        ({ kind, text }) => kind === "delimiter" && text.includes(":")
      )
    ).toBe(false)
  })

  test("keeps indented marker and separator offsets source-mapped", () => {
    const doc = "Term\n  ~\tDefinition"
    const state = optionalState(doc, { definitionLists: true })
    const line = state.doc.line(2)
    const prefix = previewValues(state, false)
      .filter(
        ({ from, kind, to }) =>
          from >= line.from &&
          to <= line.to &&
          [
            "definition-indent-source",
            "definition-separator-source",
            "definition-source-mark",
          ].includes(String(kind))
      )
      .sort((left, right) => left.from - right.from)

    expect(prefix.map(({ text }) => text).join("")).toBe("  ~\t")
    expect(prefix[0]?.from).toBe(line.from)
    expect(prefix.at(-1)?.to).toBe(line.from + 4)
  })
})

describe("YAML front-matter live preview", () => {
  test("styles metadata lines and keeps delimiters visibly inert", () => {
    const doc = "---\ntitle: Example\ntags:\n  - one\n---\n# Body"
    const state = optionalState(doc, { yamlFrontMatter: true })
    const values = previewValues(state, false)

    expect(
      values.filter(
        ({ className }) => className === "cm-md-yaml-frontmatter-line"
      )
    ).toHaveLength(5)
    expect(
      values
        .filter(({ className }) => className === "cm-md-yaml-frontmatter-mark")
        .map(({ text }) => text)
    ).toEqual(["---", "---"])
    expect(
      values.some(({ className }) =>
        String(className).includes("cm-md-yaml-frontmatter-first")
      )
    ).toBe(true)
    expect(
      values.some(({ className }) =>
        String(className).includes("cm-md-yaml-frontmatter-last")
      )
    ).toBe(true)
  })
})
