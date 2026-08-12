import { markdown } from "@codemirror/lang-markdown"
import { Compartment, EditorState } from "@codemirror/state"
import { expect, test } from "vitest"

import { markdownLinkDefinitions } from "./link-semantics"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

function markdownWithFootnotes(footnotes: boolean) {
  return markdown({
    addKeymap: false,
    base: markdownBaseLanguage,
    extensions: createMarkdownParserExtensions({ footnotes }),
  })
}

test("invalidates fallback link definitions when the parser changes", () => {
  const language = new Compartment()
  let state = EditorState.create({
    doc: "[value][^note]\n\n[^note]: /target",
    extensions: [language.of(markdownWithFootnotes(false))],
  })
  const document = state.doc

  expect(markdownLinkDefinitions(state).get("^note")?.destination).toBe(
    "/target"
  )

  state = state.update({
    effects: language.reconfigure(markdownWithFootnotes(true)),
  }).state

  expect(state.doc).toBe(document)
  expect(markdownLinkDefinitions(state).has("^note")).toBe(false)
})
