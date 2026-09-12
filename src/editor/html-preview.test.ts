import {
  commonmarkLanguage,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown"
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import {
  type Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view"
import { describe, expect, test, vi } from "vitest"

import {
  basicHtmlSourceIsSupported,
  buildSanitizedHtmlPreviewDecorations,
  HtmlDetailsState,
  sanitizedHtmlBlockAt,
  sanitizedHtmlLivePreviewExtension,
  sanitizedHtmlPreviews,
} from "./html-preview"

function detailsRoot(states: boolean[]) {
  const details = states.map((open) => ({ open }))
  return {
    details,
    root: {
      querySelectorAll: () => details,
    } as unknown as ParentNode,
  }
}

function markdownState(doc: string, cursor = 0, extra: Extension = []) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({ addKeymap: false, base: commonmarkLanguage }),
      extra,
    ],
  })
}

function htmlDecorations(state: EditorState, selectionActive = true) {
  const decorations: Array<{
    readonly from: number
    readonly kind: unknown
    readonly tagName: unknown
    readonly text: string
    readonly to: number
  }> = []
  buildSanitizedHtmlPreviewDecorations(state, selectionActive).between(
    0,
    state.doc.length,
    (from, to, value: Decoration) => {
      decorations.push({
        from,
        kind: value.spec.markdownPreviewKind,
        tagName: value.spec.tagName,
        text: state.sliceDoc(from, to),
        to,
      })
    }
  )
  return decorations
}

function stateHtmlDecorations(state: EditorState) {
  const decorations: Array<{
    readonly from: number
    readonly kind: unknown
    readonly text: string
    readonly to: number
  }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        const kind = value.spec.markdownPreviewKind
        if (typeof kind !== "string" || !kind.startsWith("sanitized-html")) {
          return
        }
        decorations.push({
          from,
          kind,
          text:
            typeof (value.spec.widget as { source?: unknown } | undefined)
              ?.source === "string"
              ? String(
                  (value.spec.widget as { source: string } | undefined)?.source
                )
              : state.sliceDoc(from, to),
          to,
        })
      }
    )
  }
  return decorations
}

function directHtmlBlockDecorationSet(state: EditorState) {
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    let found = false
    source.between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-block") {
        found = true
      }
    })
    if (found) return source as DecorationSet
  }
  throw new Error("Direct sanitized-HTML block decorations are unavailable")
}

function directHtmlBlockDecoration(state: EditorState, text: string) {
  let result: Decoration | null = null
  directHtmlBlockDecorationSet(state).between(
    0,
    state.doc.length,
    (_from, _to, value) => {
      if (
        value.spec.markdownPreviewKind === "sanitized-html-block" &&
        (value.spec.widget as { source?: unknown } | undefined)?.source === text
      ) {
        result = value
      }
    }
  )
  if (!result) throw new Error(`Sanitized HTML block is unavailable: ${text}`)
  return result
}

describe("sanitized basic HTML policy", () => {
  test.each([
    "<div><strong>Safe</strong><br></div>",
    '<div style="color:red"><strong onclick="alert(1)">Safe</strong></div>',
    "<p>Safe<script>alert(1)</script></p>",
    "<table><tbody><tr><th>A</th><td>B</td></tr></tbody></table>",
    "<figure><figcaption>Caption</figcaption></figure>",
    "<details open><summary>More</summary><p>Safe content</p></details>",
  ])("accepts safe structure for sanitization: %s", (source) => {
    expect(basicHtmlSourceIsSupported(source)).toBe(true)
  })

  test.each([
    '<a href="https://example.com">link</a>',
    '<img src="https://example.com/a.png">',
    "<script>alert(1)</script>",
    "<iframe></iframe>",
    "<form><input></form>",
    '<svg><use href="https://example.com/x"></use></svg>',
    "<strong />",
    "<div><em>mismatched</div></em>",
    "<!-- hidden -->",
  ])("rejects unsupported-only or malformed HTML: %s", (source) => {
    expect(basicHtmlSourceIsSupported(source)).toBe(false)
  })
})

describe("sanitized HTML detection", () => {
  test("finds semantic inline pairs, breaks, and static blocks", () => {
    const doc = [
      "A <strong>bold and <em>emphasized</em></strong><br>line.",
      "",
      "<div>",
      "<p>Static block</p>",
      "</div>",
      "",
      "<details open>",
      "<summary>More</summary>",
      "<p>Disclosure body</p>",
      "</details>",
    ].join("\n")
    const previews = sanitizedHtmlPreviews(markdownState(doc))

    expect(previews).toMatchObject([
      { block: false, kind: "element", tagName: "strong" },
      { block: false, kind: "element", tagName: "em" },
      { block: false, kind: "break", tagName: "br" },
      { block: true, source: "<div>\n<p>Static block</p>\n</div>" },
      {
        block: true,
        source:
          "<details open>\n<summary>More</summary>\n<p>Disclosure body</p>\n</details>",
      },
    ])
  })

  test("strips attributes from safe tags and leaves unsupported-only HTML literal", () => {
    const state = markdownState(
      'A <strong title="tooltip">text</strong> <a href="https://example.com">link</a>.\n\n<p onclick="alert(1)">safe<script>alert(2)</script></p>\n\n<script>alert(3)</script>'
    )

    expect(sanitizedHtmlPreviews(state)).toMatchObject([
      { block: false, kind: "element", tagName: "strong" },
      { block: true, source: expect.stringContaining("onclick") },
    ])
    expect(buildSanitizedHtmlPreviewDecorations(state).size).toBeGreaterThan(0)
  })

  test.each([
    ["> <pre>\n> > literal\n> </pre>", "<pre>\n> literal\n</pre>"],
    ["> <pre>\n>\ttext\n> </pre>", "<pre>\n  text\n</pre>"],
    ["- <pre>\n\ttext\n  </pre>", "<pre>\n  text\n</pre>"],
    ["> - <pre>\n>\t  text\n>   </pre>", "<pre>\n  text\n</pre>"],
    [
      "- <pre>\n  text\n    indented\n  </pre>",
      "<pre>\ntext\n  indented\n</pre>",
    ],
    [
      "> - <pre>\n>   text\n>     indented\n>   </pre>",
      "<pre>\ntext\n  indented\n</pre>",
    ],
    [
      "- > - <pre>\n  >   text\n  >     indented\n  >   </pre>",
      "<pre>\ntext\n  indented\n</pre>",
    ],
    [
      "-\t<pre>\n\ttext\n\t  indented\n\t</pre>",
      "<pre>\ntext\n  indented\n</pre>",
    ],
    [
      "> [!TIP]\n> > <pre>\n> > > literal\n> > </pre>",
      "<pre>\n> literal\n</pre>",
    ],
    ["- > <pre>\n  >   indented\n  > </pre>", "<pre>\n  indented\n</pre>"],
  ])(
    "removes parsed quote containers from HTML payloads: %s",
    (doc, source) => {
      const state = markdownState(
        doc,
        0,
        sanitizedHtmlLivePreviewExtension({
          selectionActive: () => false,
        })
      )
      const from = doc.indexOf("<pre>")
      const expected = { block: true, from, source, to: doc.length }

      expect(sanitizedHtmlPreviews(state)).toContainEqual(expected)
      expect(sanitizedHtmlBlockAt(state, from)).toEqual(expected)
      expect(stateHtmlDecorations(state)).toContainEqual(
        expect.objectContaining({
          kind: "sanitized-html-block",
          text: source,
        })
      )
      expect(state.sliceDoc(from, doc.length)).toMatch(/\n[\t >]/)
    }
  )

  test("finds inline HTML in headings and keeps each table cell independent", () => {
    const doc = [
      "# <em>ATX</em><br>next",
      "",
      "Setext <sup>title</sup>",
      "---------------------",
      "",
      "| <strong>Header</strong> | Other |",
      "| --- | --- |",
      "| <em>left | right</em> |",
      "| <sub>cell</sub><br>next | value |",
    ].join("\n")
    const state = EditorState.create({
      doc,
      extensions: markdown({ addKeymap: false, base: markdownLanguage }),
    })
    const previews = sanitizedHtmlPreviews(state)
    expect(
      previews.map((preview) => (preview.block ? "block" : preview.tagName))
    ).toEqual(["em", "br", "sup", "strong", "sub", "br"])
    for (const text of ["ATX", "title", "Header", "cell"]) {
      const from = doc.indexOf(text)
      const decorations = buildSanitizedHtmlPreviewDecorations(state, false, [
        { from, to: from + text.length },
      ])
      const rendered: string[] = []
      decorations.between(0, doc.length, (start, end, value) => {
        if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
          rendered.push(state.sliceDoc(start, end))
        }
      })
      expect(rendered).toEqual([text])
    }
  })

  test("finds a far block outside the published syntax tree for caret anchoring", () => {
    const filler = Array.from(
      { length: 4_000 },
      (_value, index) => `paragraph ${index}`
    ).join("\n\n")
    const block = "<div><p>Far block</p></div>"
    const doc = [filler, "", block].join("\n")
    const state = markdownState(doc)

    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
    expect(sanitizedHtmlBlockAt(state, doc.indexOf("Far block"))).toEqual({
      block: true,
      from: doc.indexOf(block),
      source: block,
      to: doc.length,
    })
  })
})

describe("sanitized HTML live preview", () => {
  test("restores disclosure state when a block widget is remounted", () => {
    const mounted = detailsRoot([true, false])
    const state = new HtmlDetailsState()
    state.capture(mounted.root)
    const remounted = detailsRoot([false, true])

    state.restore(remounted.root)

    expect(remounted.details.map(({ open }) => open)).toEqual([true, false])
  })

  test("uses semantic elements while replacing only validated source tags", () => {
    const state = markdownState(
      "A <b>bold</b>, <i>italic</i>, <s>gone</s>, <kbd>K</kbd>.<br>Next"
    )
    const decorations = htmlDecorations(state)

    expect(
      decorations
        .filter(({ kind }) => kind === "sanitized-html-inline")
        .map(({ tagName, text }) => ({ tagName, text }))
    ).toEqual([
      { tagName: "strong", text: "bold" },
      { tagName: "em", text: "italic" },
      { tagName: "del", text: "gone" },
      { tagName: "kbd", text: "K" },
    ])
    expect(
      decorations.filter(({ kind }) => kind === "sanitized-html-tag")
    ).toHaveLength(8)
    expect(
      decorations.some(({ kind }) => kind === "sanitized-html-break")
    ).toBe(true)
  })

  test("reveals a complete construct for an active caret or selection", () => {
    const doc = "Before <strong>bold</strong> after"
    const inside = doc.indexOf("bold") + 1
    const state = markdownState(doc, inside)

    expect(htmlDecorations(state)).toEqual([])
    expect(htmlDecorations(state, false)).not.toEqual([])

    const selected = state.update({
      selection: { anchor: inside, head: inside + 2 },
    }).state
    expect(htmlDecorations(selected, false)).toEqual([])
  })

  test("limits previews to materialized ranges and refreshes edited HTML", () => {
    let state = markdownState("A <strong>one</strong>.\n\nB <em>two</em>.")
    const renderedText = () => {
      const values: string[] = []
      buildSanitizedHtmlPreviewDecorations(state, false).between(
        0,
        state.doc.length,
        (from, to, value) => {
          if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
            values.push(state.sliceDoc(from, to))
          }
        }
      )
      return values
    }

    expect(renderedText()).toEqual(["one", "two"])
    const firstOnly = buildSanitizedHtmlPreviewDecorations(state, false, [
      { from: 0, to: state.doc.toString().indexOf("B") },
    ])
    const firstOnlyText: string[] = []
    firstOnly.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
        firstOnlyText.push(state.sliceDoc(from, to))
      }
    })
    expect(firstOnlyText).toEqual(["one"])
    const one = state.doc.toString().indexOf("one")
    state = state.update({
      changes: { from: one, to: one + 3, insert: "first" },
    }).state
    expect(renderedText()).toEqual(["first", "two"])

    const opening = state.doc.toString().indexOf("<strong>")
    state = state.update({
      changes: { from: opening, to: opening + "<strong>".length },
    }).state
    expect(renderedText()).toEqual(["two"])
  })

  test("keeps every block replacement in state while inline HTML stays viewport-scoped", () => {
    const near = "<div><p>Near block</p></div>"
    const far = [
      "<details open>",
      "<summary>Far block</summary>",
      "<p>Far body</p>",
      "</details>",
    ].join("\n")
    const filler = Array.from(
      { length: 2_000 },
      (_value, index) => `Paragraph ${index}. Inline <mark>value</mark>.`
    ).join("\n\n")
    const doc = [near, "", filler, "", far].join("\n")
    const extension = sanitizedHtmlLivePreviewExtension({
      selectionActive: () => false,
    })
    let state = markdownState(doc, 0, extension)

    expect(stateHtmlDecorations(state)).toEqual([
      {
        from: 0,
        kind: "sanitized-html-block",
        text: near,
        to: near.length + 1,
      },
      {
        from: doc.indexOf(far) - 1,
        kind: "sanitized-html-block",
        text: far,
        to: doc.length,
      },
    ])

    const farDecoration = directHtmlBlockDecoration(state, far)
    state = state.update({
      changes: { from: 0, insert: "Preface\n\n" },
    }).state
    expect(directHtmlBlockDecoration(state, far)).toBe(farDecoration)
    const nearDecoration = directHtmlBlockDecoration(state, near)
    const updatedSummary = state.doc.toString().indexOf("Far block")
    state = state.update({
      changes: {
        from: updatedSummary,
        to: updatedSummary + "Far block".length,
        insert: "Updated far block",
      },
    }).state
    const fresh = markdownState(state.doc.toString(), 0, extension)

    expect(directHtmlBlockDecoration(state, near)).toBe(nearDecoration)
    expect(stateHtmlDecorations(state)).toEqual(stateHtmlDecorations(fresh))
    expect(
      stateHtmlDecorations(state).map(({ kind, text }) => ({ kind, text }))
    ).toEqual([
      { kind: "sanitized-html-block", text: near },
      {
        kind: "sanitized-html-block",
        text: far.replace("Far block", "Updated far block"),
      },
    ])
  })

  test("reuses complete decoration state for selections outside HTML blocks", () => {
    const block = "<div><p>Block</p></div>"
    const doc = ["before one", "before two", "", block, "", "after"].join("\n")
    let state = markdownState(doc, 0, sanitizedHtmlLivePreviewExtension())
    const decorations = directHtmlBlockDecorationSet(state)

    state = state.update({
      selection: { anchor: doc.indexOf("before two") },
    }).state

    expect(directHtmlBlockDecorationSet(state)).toBe(decorations)
  })

  test("reveals block source from its expanded presentation boundary", () => {
    const block = "<div><p>Block</p></div>"
    const doc = ["before", "", block, "", "after"].join("\n")
    let state = markdownState(doc, 0, sanitizedHtmlLivePreviewExtension())
    const blockTo = doc.indexOf(block) + block.length

    expect(stateHtmlDecorations(state)).toHaveLength(1)
    state = state.update({ selection: { anchor: blockTo + 1 } }).state

    expect(stateHtmlDecorations(state)).toEqual([])
  })

  test("fully refreshes distant HTML blocks when fenced-code pairing changes", () => {
    const block = "<div>A</div>"
    const doc = [
      "before",
      "",
      "```mermaid",
      "graph TD",
      "A --> B",
      "```",
      "",
      block,
      "",
      "```",
      block,
      "```",
      "",
      block,
      "after",
    ].join("\n")
    const extension = sanitizedHtmlLivePreviewExtension({
      selectionActive: () => false,
    })
    let state = markdownState(doc, 0, extension)

    const openingFence = doc.indexOf("```mermaid")
    state = state.update({
      changes: { from: openingFence, to: openingFence + 1 },
    }).state
    const fresh = markdownState(state.doc.toString(), 0, extension)

    expect(stateHtmlDecorations(state)).toEqual(stateHtmlDecorations(fresh))
    expect(stateHtmlDecorations(state).map(({ text }) => text)).toEqual([
      `${block}\n\`\`\``,
      `${block}\nafter`,
    ])
  })

  test("bounds inline-tag work inside one huge soft-wrapped paragraph", () => {
    const first = "<strong>value-0</strong>"
    const doc = Array.from(
      { length: 4_000 },
      (_, index) => `<strong>value-${index}</strong>`
    ).join(" ")
    const state = markdownState(doc)
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)?.length).toBe(
      state.doc.length
    )
    const sliceDoc = vi.spyOn(state, "sliceDoc")

    const decorations = buildSanitizedHtmlPreviewDecorations(state, false, [
      { from: 0, to: first.length },
    ])
    const rendered: string[] = []
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
        rendered.push(state.sliceDoc(from, to))
      }
    })

    expect(rendered).toEqual(["value-0"])
    expect(sliceDoc).toHaveBeenCalledTimes(3)
  })

  test("recovers an inline pair whose tags are outside the visible range", () => {
    const content = `${"prefix ".repeat(8_000)}visible${" suffix".repeat(8_000)}`
    const doc = `Before <strong>${content}</strong> after`
    const state = markdownState(doc)
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)?.length).toBe(
      state.doc.length
    )
    const visible = doc.indexOf("visible")
    const sliceDoc = vi.spyOn(state, "sliceDoc")

    const decorations = buildSanitizedHtmlPreviewDecorations(state, false, [
      { from: visible, to: visible + "visible".length },
    ])
    const inline: Array<{ from: number; tagName: unknown; to: number }> = []
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
        inline.push({ from, tagName: value.spec.tagName, to })
      }
    })

    expect(inline).toEqual([
      {
        from: doc.indexOf(">") + 1,
        tagName: "strong",
        to: doc.lastIndexOf("</strong>"),
      },
    ])
    expect(sliceDoc.mock.calls.length).toBeLessThanOrEqual(4)
  })

  test("keeps an outer semantic element around a visible complete inner pair", () => {
    const prefix = "prefix ".repeat(4_000)
    const suffix = " suffix".repeat(4_000)
    const doc = `<strong>${prefix}<em>visible</em>${suffix}</strong>`
    const state = markdownState(doc)
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)?.length).toBe(
      state.doc.length
    )
    const from = doc.indexOf("<em>")
    const to = from + "<em>visible</em>".length
    const sliceDoc = vi.spyOn(state, "sliceDoc")

    const decorations = buildSanitizedHtmlPreviewDecorations(state, false, [
      { from, to },
    ])
    const marks: Array<{ from: number; tagName: unknown; to: number }> = []
    decorations.between(0, state.doc.length, (markFrom, markTo, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
        marks.push({ from: markFrom, tagName: value.spec.tagName, to: markTo })
      }
    })

    expect(marks).toEqual([
      {
        from: "<strong>".length,
        tagName: "strong",
        to: doc.lastIndexOf("</strong>"),
      },
      {
        from: doc.indexOf("visible"),
        tagName: "em",
        to: doc.indexOf("visible") + "visible".length,
      },
    ])
    expect(sliceDoc.mock.calls.length).toBeLessThanOrEqual(12)
  })

  test("suppresses a visible inner pair inside malformed outer source", () => {
    const doc = `<strong>${"prefix ".repeat(4_000)}<em>visible</em>${" suffix".repeat(4_000)}</b>`
    const state = markdownState(doc)
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)?.length).toBe(
      state.doc.length
    )
    const from = doc.indexOf("<em>")
    const to = doc.indexOf("</em>") + "</em>".length

    const decorations = buildSanitizedHtmlPreviewDecorations(state, false, [
      { from, to },
    ])
    const inline: unknown[] = []
    decorations.between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.markdownPreviewKind === "sanitized-html-inline") {
        inline.push(value)
      }
    })

    expect(inline).toEqual([])
  })
})
