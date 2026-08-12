import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import { expect, test } from "vitest"

import {
  completeMarkdownSyntaxTree,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

test("builds a complete index tree without advancing CodeMirror's parse context", () => {
  const doc = [
    "[Reference][target]",
    "",
    Array.from({ length: 4_000 }, (_, index) => `paragraph ${index}`).join(
      "\n\n"
    ),
    "",
    "[target]: /destination",
  ].join("\n")
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
  const publishedTree = syntaxTree(state)

  expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
  expect(completeMarkdownSyntaxTree(state).length).toBe(state.doc.length)
  expect(syntaxTree(state)).toBe(publishedTree)
  expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
})

test("incrementally updates a complete tree after distant edits", () => {
  const doc = [
    "[Reference][target]",
    "",
    Array.from({ length: 4_000 }, (_, index) => `paragraph ${index}`).join(
      "\n\n"
    ),
    "",
    "[target]: /destination",
  ].join("\n")
  const extensions = [markdown({ base: markdownLanguage })]
  const state = EditorState.create({ doc, extensions })
  const tree = completeMarkdownSyntaxTree(state)
  const ordinaryEdit = state.update({
    changes: { from: doc.indexOf("paragraph 2000") + 10, insert: " updated" },
  })
  const definitionEnd =
    ordinaryEdit.state.doc.toString().indexOf("/destination") +
    "/destination".length
  const definitionEdit = ordinaryEdit.state.update({
    changes: { from: definitionEnd, insert: " trailing text" },
  })
  const changes = ordinaryEdit.changes.composeDesc(definitionEdit.changes)
  const updated = updateCompleteMarkdownSyntaxTree(
    definitionEdit.state,
    changes,
    tree
  )
  const freshlyParsed = completeMarkdownSyntaxTree(
    EditorState.create({ doc: definitionEdit.state.doc.toString(), extensions })
  )

  expect(updated.length).toBe(definitionEdit.state.doc.length)
  expect(updated.toString()).toBe(freshlyParsed.toString())
  expect(updated.toString()).not.toContain("LinkReference")
})

test("does not reuse a published tree across parser reconfiguration", () => {
  const parser = new Compartment()
  const language = (emojiRecognition: boolean) =>
    markdown({
      addKeymap: false,
      base: markdownBaseLanguage,
      extensions: createMarkdownParserExtensions({ emojiRecognition }),
    })
  const initial = EditorState.create({
    doc: "Emoji :rocket: stays parser-controlled.",
    extensions: [parser.of(language(true))],
  })

  expect(completeMarkdownSyntaxTree(initial).toString()).toContain("EmojiToken")

  const disabled = initial.update({
    effects: parser.reconfigure(language(false)),
  }).state
  expect(completeMarkdownSyntaxTree(disabled).toString()).not.toContain(
    "EmojiToken"
  )

  const restored = disabled.update({
    effects: parser.reconfigure(language(true)),
  }).state
  expect(syntaxTree(restored).toString()).toContain("EmojiToken")
  expect(completeMarkdownSyntaxTree(restored).toString()).toContain(
    "EmojiToken"
  )
})
