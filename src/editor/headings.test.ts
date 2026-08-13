import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { Compartment, EditorState } from "@codemirror/state"
import { describe, expect, test } from "vitest"

import {
  githubHeadingSlug,
  headingForFragment,
  markdownHeadings,
} from "./headings"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

function markdownState(doc: string) {
  return EditorState.create({
    doc,
    extensions: markdown({ base: markdownLanguage }),
  })
}

describe("Markdown heading index", () => {
  test("extracts rendered ATX and Setext heading text", () => {
    const headings = markdownHeadings(
      markdownState(
        [
          "# Hello *world* [label](destination) `code` ![alt](image.png) #",
          "",
          "Setext **heading**",
          "===",
          "",
          "## Escaped \\* &amp; <i>tag</i>",
          "",
          "### [shown][missing]",
        ].join("\n")
      )
    )

    expect(
      headings.map(({ level, plainText }) => ({ level, plainText }))
    ).toEqual([
      { level: 1, plainText: "Hello world label code alt" },
      { level: 1, plainText: "Setext heading" },
      { level: 2, plainText: "Escaped * & tag" },
      { level: 3, plainText: "[shown][missing]" },
    ])
  })

  test("matches GitHub slugs and disambiguates every collision", () => {
    const headings = markdownHeadings(
      markdownState(
        [
          "# Hello, World!",
          "# Hello World",
          "# hello-world-1",
          "# Héllo 💯",
        ].join("\n")
      )
    )

    expect(headings.map(({ slug }) => slug)).toEqual([
      "hello-world",
      "hello-world-1",
      "hello-world-1-1",
      "héllo-💯",
    ])
    expect(githubHeadingSlug("A & B / C?")).toBe("a--b--c")
  })

  test("uses HTML numeric character-reference replacement rules", () => {
    const headings = markdownHeadings(
      markdownState("# Cost &#x80; &#128; invalid &#xD800; &#55296;")
    )

    expect(headings[0]?.plainText).toBe("Cost € € invalid � �")
    expect(headings[0]?.slug).toBe("cost-€-€-invalid-�-�")
  })

  test("resolves percent-encoded fragments against generated ids", () => {
    const headings = markdownHeadings(markdownState("# Café notes"))
    expect(headingForFragment(headings, "#caf%C3%A9-notes")?.plainText).toBe(
      "Café notes"
    )
    expect(headingForFragment(headings, "#missing")).toBeNull()
  })

  test("invalidates the cached outline when only the parser changes", () => {
    const parser = new Compartment()
    let state = EditorState.create({
      doc: ["---", "# Metadata heading", "---", "", "# Document heading"].join(
        "\n"
      ),
      extensions: [
        parser.of(
          markdown({
            base: markdownBaseLanguage,
            extensions: createMarkdownParserExtensions(),
          })
        ),
      ],
    })
    const document = state.doc

    expect(markdownHeadings(state).map(({ plainText }) => plainText)).toEqual([
      "Metadata heading",
      "Document heading",
    ])

    state = state.update({
      effects: parser.reconfigure(
        markdown({
          base: markdownBaseLanguage,
          extensions: createMarkdownParserExtensions({
            yamlFrontMatter: true,
          }),
        })
      ),
    }).state

    expect(state.doc).toBe(document)
    expect(markdownHeadings(state).map(({ plainText }) => plainText)).toEqual([
      "Document heading",
    ])
  })
})
