import { markdown } from "@codemirror/lang-markdown"
import { syntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { IterMode, type Parser, type SyntaxNode } from "@lezer/common"
import { describe, expect, test, vi } from "vitest"

import {
  createMarkdownParserExtensions,
  createYamlParserLoader,
  definitionListSyntax,
  emojiShortcode,
  footnoteIdentifier,
  markdownBaseLanguage,
  optionalMarkdownNodeNames,
  type MarkdownParserExtensionOptions,
} from "./markdown-extensions"

function markdownState(
  doc: string,
  options: Partial<MarkdownParserExtensionOptions> = {}
) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        addKeymap: false,
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions(options),
      }),
    ],
  })
}

function nodesNamed(state: EditorState, name: string) {
  const nodes: SyntaxNode[] = []
  syntaxTree(state).iterate({
    mode: IterMode.IgnoreMounts,
    enter(node) {
      if (node.name === name) nodes.push(node.node)
    },
  })
  return nodes
}

function nodeTexts(state: EditorState, name: string) {
  return nodesNamed(state, name).map((node) =>
    state.sliceDoc(node.from, node.to)
  )
}

describe("Markdown parser extension composition", () => {
  test("keeps GFM in the strict CommonMark baseline and makes LaTeX optional", () => {
    const state = markdownState(
      [
        "~~deleted~~ and $x + y$",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n")
    )

    expect(nodesNamed(state, "Strikethrough")).toHaveLength(1)
    expect(nodesNamed(state, "InlineMath")).toHaveLength(0)
    expect(nodesNamed(state, "Table")).toHaveLength(1)

    const latexState = markdownState("$x + y$", { latex: true })
    expect(nodesNamed(latexState, "InlineMath")).toHaveLength(1)
  })

  test("omits every settings-controlled grammar by default", () => {
    const state = markdownState(
      [
        "H~2~O x^2^ :smile:",
        "",
        "A note[^note].",
        "",
        "[^note]: Definition",
        "",
        "Term",
        ": Definition",
      ].join("\n")
    )

    for (const name of [
      "Subscript",
      "Superscript",
      optionalMarkdownNodeNames.emojiToken,
      optionalMarkdownNodeNames.footnoteReference,
      optionalMarkdownNodeNames.footnoteDefinition,
      optionalMarkdownNodeNames.definitionTerm,
      optionalMarkdownNodeNames.definitionList,
    ]) {
      expect(nodesNamed(state, name), name).toHaveLength(0)
    }
  })

  test("enables Pandoc superscript and subscript together", () => {
    const state = markdownState("H~2~O and 2^10^", {
      superscriptAndSubscript: true,
    })

    expect(nodeTexts(state, "Subscript")).toEqual(["~2~"])
    expect(nodeTexts(state, "Superscript")).toEqual(["^10^"])
  })
})

describe("emoji token recognition", () => {
  test("recognizes GitHub-compatible punctuation without validating aliases", () => {
    const doc = ":smile: :+1: :-1: :face-with-tears: :snake_case: :100:"
    const state = markdownState(doc, { emojiRecognition: true })
    const tokens = nodesNamed(state, optionalMarkdownNodeNames.emojiToken)

    expect(tokens.map((node) => state.sliceDoc(node.from, node.to))).toEqual([
      ":smile:",
      ":+1:",
      ":-1:",
      ":face-with-tears:",
      ":snake_case:",
      ":100:",
    ])
    expect(tokens.map((node) => emojiShortcode(doc, node))).toEqual([
      "smile",
      "+1",
      "-1",
      "face-with-tears",
      "snake_case",
      "100",
    ])
  })

  test("leaves malformed, escaped, and code-contained tokens alone", () => {
    const state = markdownState(
      ":two words: :dot.name: :: \\:smile: `:smile:`",
      { emojiRecognition: true }
    )

    expect(
      nodesNamed(state, optionalMarkdownNodeNames.emojiToken)
    ).toHaveLength(0)
  })
})

describe("footnote parsing", () => {
  test("parses references and rich, indented definitions", () => {
    const doc = [
      "A statement[^Source-1].",
      "",
      "[^Source-1]: First **paragraph**.",
      "",
      "    Second paragraph.",
    ].join("\n")
    const state = markdownState(doc, { footnotes: true })
    const reference = nodesNamed(
      state,
      optionalMarkdownNodeNames.footnoteReference
    )[0]!
    const definition = nodesNamed(
      state,
      optionalMarkdownNodeNames.footnoteDefinition
    )[0]!

    expect(state.sliceDoc(reference.from, reference.to)).toBe("[^Source-1]")
    expect(state.sliceDoc(definition.from, definition.to)).toBe(
      "[^Source-1]: First **paragraph**.\n\n    Second paragraph."
    )
    expect(footnoteIdentifier(doc, reference)).toBe("source-1")
    expect(footnoteIdentifier(doc, definition)).toBe("source-1")
    expect(nodesNamed(state, "StrongEmphasis")).toHaveLength(1)
    expect(
      nodesNamed(state, "Paragraph").filter(
        (node) => node.from >= definition.from && node.to <= definition.to
      )
    ).toHaveLength(2)
  })

  test("definitions interrupt paragraphs but require a whitespace-separated body", () => {
    const valid = markdownState("Paragraph\n[^n]: note", { footnotes: true })
    const invalid = markdownState("[^n]:note", { footnotes: true })
    const indented = markdownState("    [^n]: note", { footnotes: true })

    expect(
      nodesNamed(valid, optionalMarkdownNodeNames.footnoteDefinition)
    ).toHaveLength(1)
    expect(
      nodesNamed(invalid, optionalMarkdownNodeNames.footnoteDefinition)
    ).toHaveLength(0)
    expect(nodesNamed(indented, "CodeBlock")).toHaveLength(1)
  })

  test("rejects empty, caret-bearing, or whitespace-bearing identifiers", () => {
    const state = markdownState("[^] [^^] [^two words] [^line\nwrap]", {
      footnotes: true,
    })
    expect(
      nodesNamed(state, optionalMarkdownNodeNames.footnoteReference)
    ).toHaveLength(0)
  })
})

describe("definition list parsing", () => {
  test("groups a term with colon and tilde definitions", () => {
    const doc = ["Apple", ": A **fruit**.", "~ A technology company."].join(
      "\n"
    )
    const state = markdownState(doc, { definitionLists: true })
    const lists = definitionListSyntax(syntaxTree(state))

    expect(lists).toHaveLength(1)
    expect(state.sliceDoc(lists[0]!.from, lists[0]!.to)).toBe(doc)
    expect(lists[0]!.descriptions).toHaveLength(2)
    expect(nodeTexts(state, optionalMarkdownNodeNames.definitionMark)).toEqual([
      ":",
      "~",
    ])
    expect(nodesNamed(state, "StrongEmphasis")).toHaveLength(1)
  })

  test("accepts markers indented by up to three spaces", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const doc = `Term\n${indent}: Definition`
      const state = markdownState(doc, { definitionLists: true })
      expect(
        definitionListSyntax(syntaxTree(state)),
        JSON.stringify(indent)
      ).toHaveLength(1)
    }

    const tooDeep = markdownState("Term\n    : Definition", {
      definitionLists: true,
    })
    expect(definitionListSyntax(syntaxTree(tooDeep))).toHaveLength(0)
  })

  test("uses the marker content column for continuation and nested blocks", () => {
    const doc = [
      "Term",
      ": First line",
      "  continuation at column two",
      "",
      "  - nested item",
    ].join("\n")
    const state = markdownState(doc, { definitionLists: true })
    const lists = definitionListSyntax(syntaxTree(state), (from, to) =>
      state.sliceDoc(from, to)
    )

    expect(lists).toHaveLength(1)
    expect(state.sliceDoc(lists[0]!.list.from, lists[0]!.list.to)).toBe(
      doc.slice(doc.indexOf(":"))
    )
    expect(nodesNamed(state, "BulletList")).toHaveLength(1)
  })

  test("supports one blank before a definition and nested block content", () => {
    const doc = [
      "Term",
      "",
      ": First paragraph.",
      "",
      "    Second **paragraph**.",
    ].join("\n")
    const state = markdownState(doc, { definitionLists: true })
    const lists = definitionListSyntax(syntaxTree(state), (from, to) =>
      state.sliceDoc(from, to)
    )

    expect(lists).toHaveLength(1)
    expect(lists[0]!.descriptions).toHaveLength(1)
    expect(nodesNamed(state, "StrongEmphasis")).toHaveLength(1)
    expect(
      nodesNamed(state, "Paragraph").filter(
        (node) =>
          node.from >= lists[0]!.list.from && node.to <= lists[0]!.list.to
      )
    ).toHaveLength(2)
  })

  test("works inside blockquotes and ignores unpaired or ordinary colon text", () => {
    const nested = markdownState("> Term\n>\n> ~ Definition", {
      definitionLists: true,
    })
    const ordinary = markdownState("Term\n:Not a definition", {
      definitionLists: true,
    })
    const unpaired = markdownState(
      "Term\n\n# Intervening block\n: Definition",
      { definitionLists: true }
    )

    expect(
      definitionListSyntax(syntaxTree(nested), (from, to) =>
        nested.sliceDoc(from, to)
      )
    ).toHaveLength(1)
    expect(definitionListSyntax(syntaxTree(ordinary))).toHaveLength(0)
    expect(
      definitionListSyntax(syntaxTree(unpaired), (from, to) =>
        unpaired.sliceDoc(from, to)
      )
    ).toHaveLength(0)
  })
})

describe("YAML front matter parsing", () => {
  test("retries the optional YAML parser after a transient module failure", async () => {
    const parser = {} as Parser
    const loadModule = vi
      .fn<() => Promise<{ yamlLanguage: { parser: Parser } }>>()
      .mockRejectedValueOnce(new Error("temporary YAML chunk failure"))
      .mockResolvedValue({ yamlLanguage: { parser } })
    const loader = createYamlParserLoader(loadModule)

    expect(loader.peek()).toBeNull()
    await expect(loader.load()).rejects.toThrow("temporary YAML chunk failure")
    await expect(loader.load()).resolves.toBe(parser)
    expect(loader.peek()).toBe(parser)
    await expect(loader.load()).resolves.toBe(parser)
    expect(loadModule).toHaveBeenCalledTimes(2)
  })

  test.each(["---", "..."])("accepts a %s closing delimiter", (closing) => {
    const doc = [
      "---",
      "title: Example",
      "tags:",
      "  - one",
      closing,
      "# Body",
    ].join("\n")
    const state = markdownState(doc, { yamlFrontMatter: true })

    expect(nodeTexts(state, optionalMarkdownNodeNames.yamlFrontMatter)).toEqual(
      [["---", "title: Example", "tags:", "  - one", closing].join("\n")]
    )
    expect(
      nodeTexts(state, optionalMarkdownNodeNames.yamlFrontMatterContent)
    ).toEqual(["title: Example\ntags:\n  - one"])
    expect(nodesNamed(state, "ATXHeading1")).toHaveLength(1)
  })

  test("accepts a BOM and keeps an unfinished opening block coherent", () => {
    const complete = markdownState("\uFEFF---\ntitle: Example\n---", {
      yamlFrontMatter: true,
    })
    const unfinished = markdownState("---\ntitle: Example", {
      yamlFrontMatter: true,
    })

    expect(
      nodesNamed(complete, optionalMarkdownNodeNames.yamlFrontMatter)
    ).toHaveLength(1)
    expect(
      nodesNamed(unfinished, optionalMarkdownNodeNames.yamlFrontMatter)
    ).toHaveLength(1)
    expect(
      nodeTexts(unfinished, optionalMarkdownNodeNames.yamlFrontMatterContent)
    ).toEqual(["title: Example"])
  })

  test("lazily mounts the YAML language parser over metadata content", async () => {
    const doc = "---\ntitle: Example\ntags:\n  - one\n---"
    const titlePosition = doc.indexOf("title") + 1

    // The first state starts the optional language chunk load. Once it has
    // resolved, a normal subsequent parse mounts YAML inside the content node.
    markdownState(doc, { yamlFrontMatter: true })
    await vi.waitFor(() => {
      const state = markdownState(doc, { yamlFrontMatter: true })
      expect(syntaxTree(state).resolveInner(titlePosition, 1).name).toBe(
        "Literal"
      )
    })
  })

  test("only recognizes an opening delimiter at the absolute start", () => {
    const state = markdownState("# Before\n\n---\ntitle: No\n---", {
      yamlFrontMatter: true,
    })

    expect(
      nodesNamed(state, optionalMarkdownNodeNames.yamlFrontMatter)
    ).toHaveLength(0)
    expect(nodesNamed(state, "HorizontalRule").length).toBeGreaterThan(0)
  })
})
