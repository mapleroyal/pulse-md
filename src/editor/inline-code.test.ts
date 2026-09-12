import { markdown } from "@codemirror/lang-markdown"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { calloutEditingRange } from "./callout-blocks"
import { completeMarkdownSyntaxTree } from "./complete-markdown-tree"
import { refreshLivePreview } from "./interactive-preview"
import {
  inlineCodeNormalization,
  inlineCodeNormalizationExtension,
  type InlineCodeReplacement,
} from "./inline-code"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

function markdownState(doc: string, extra: Extension = []) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions({
          footnotes: true,
          definitionLists: true,
        }),
      }),
      extra,
    ],
  })
}

function normalizedCode(doc: string) {
  const state = markdownState(doc)
  const tree = completeMarkdownSyntaxTree(state)
  let result:
    { text: string; replacements: readonly InlineCodeReplacement[] } | undefined
  tree.iterate({
    enter(node) {
      if (node.name !== "InlineCode") return
      const normalized = inlineCodeNormalization(state, node.node, tree)
      const marks = node.node.getChildren("CodeMark")
      let cursor = marks[0]!.to
      let text = ""
      for (const replacement of normalized.replacements) {
        text += state.sliceDoc(cursor, replacement.from) + replacement.text
        cursor = replacement.to
      }
      text += state.sliceDoc(cursor, marks.at(-1)!.from)
      result = { text, replacements: normalized.replacements }
      return false
    },
  })
  return result
}

function directReplacements(state: EditorState) {
  const ranges: Array<{ from: number; to: number; text: string }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind === "inline-code-normalization") {
        ranges.push({ from, to, text: value.spec.widget?.text ?? "" })
      }
    })
  }
  return ranges
}

describe("CommonMark code-span content", () => {
  test.each([
    ["` code `", "code"],
    ["`  code  `", " code "],
    ["` code`", " code"],
    ["`code `", "code "],
    ["`   `", "   "],
    ["`\tcode\t`", "\tcode\t"],
    ["`a\nb`", "a b"],
    ["`\na\n`", "a"],
    ["` \na\n `", " a "],
    ["` \n `", "   "],
    ["`` `literal` ``", "`literal`"],
    ["- `a\n  b`", "a b"],
    ["- `a\n    b`", "a   b"],
    ["> `a\n> b`", "a b"],
    ["> `a\n>   b`", "a   b"],
    ["> `a\nb`", "a b"],
    ["> - `a\n>   b`", "a b"],
    ["- > `a\n  > b`", "a b"],
    [">- `a\n>   b`", "a b"],
    ["- `a\n\tb`", "a   b"],
    ["> `a\n>\tb`", "a   b"],
    ["[^n]: `a\n    b`", "a b"],
    ["Term\n: `a\n  b`", "a b"],
  ])(
    "normalizes %j without consuming authored code spaces",
    (doc, expected) => {
      expect(normalizedCode(doc)?.text).toBe(expected)
    }
  )
})

describe("complete code-span geometry", () => {
  test("publishes every offscreen multiline boundary before viewport calculation", () => {
    const field = inlineCodeNormalizationExtension(() => false)
    const doc = "intro\n\n" + "ordinary\n\n".repeat(3000) + "`a\nb`"
    const state = markdownState(doc, field)
    expect(directReplacements(state)).toEqual([
      { from: doc.lastIndexOf("\n"), to: doc.lastIndexOf("\n") + 1, text: " " },
    ])
  })

  test("reveals code on selection and retains unrelated decoration state", () => {
    const field = inlineCodeNormalizationExtension(() => true)
    let state = markdownState("intro\n\n`a\nb`\n\nend", field)
    const original = state.field(field).decorations
    state = state.update({ selection: { anchor: 2 } }).state
    expect(state.field(field).decorations).toBe(original)
    state = state.update({ selection: { anchor: 10 } }).state
    expect(directReplacements(state)).toEqual([])
    state = state.update({ selection: { anchor: 0 } }).state
    expect(directReplacements(state)).toHaveLength(1)
  })

  test("preserves pointer layout until its shared refresh", () => {
    const field = inlineCodeNormalizationExtension(() => true)
    let state = markdownState("intro\n\n`a\nb`", field)
    const original = state.field(field).decorations
    state = state.update({
      selection: { anchor: 10 },
      userEvent: "select.pointer",
    }).state
    expect(state.field(field).decorations).toBe(original)
    state = state.update({ effects: refreshLivePreview.of(null) }).state
    expect(directReplacements(state)).toEqual([])
  })

  test("defers to revealed callout source", () => {
    const field = inlineCodeNormalizationExtension(() => false)
    const editing = new Compartment()
    let state = markdownState("> `a\n> b`", [
      field,
      editing.of(calloutEditingRange.of(null)),
    ])
    expect(directReplacements(state)).toHaveLength(1)
    state = state.update({
      effects: editing.reconfigure(
        calloutEditingRange.of({ from: 0, to: state.doc.length })
      ),
    }).state
    expect(directReplacements(state)).toEqual([])
    state = state.update({
      effects: editing.reconfigure(calloutEditingRange.of(null)),
    }).state
    expect(directReplacements(state)).toHaveLength(1)
  })

  test("keeps incremental geometry identical to a fresh state across syntax changes", () => {
    const field = inlineCodeNormalizationExtension(() => false)
    let state = markdownState("intro\n\n`a\nb`\n\n`c\nd`\n\nend", field)
    const change = (from: number, to: number, insert: string) => {
      state = state.update({ changes: { from, to, insert } }).state
      const fresh = markdownState(state.doc.toString(), field)
      expect(directReplacements(state)).toEqual(directReplacements(fresh))
    }
    change(2, 2, "suffix")
    change(
      state.doc.toString().indexOf("a"),
      state.doc.toString().indexOf("a") + 1,
      " x "
    )
    change(
      state.doc.toString().indexOf("b"),
      state.doc.toString().indexOf("b"),
      "\nextra"
    )
    change(
      state.doc.toString().indexOf("`"),
      state.doc.toString().indexOf("`") + 1,
      ""
    )
    change(0, 0, "```\n")
    change(0, 4, "")
    change(0, state.doc.length, "> `new\n> code`")
  })
})
