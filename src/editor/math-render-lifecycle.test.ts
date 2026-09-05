import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import type { EditorView, WidgetType } from "@codemirror/view"
import { expect, it, vi } from "vitest"

import { buildMathPreviewDecorations, mathMarkdownExtension } from "./math"

const { renderToString } = vi.hoisted(() => ({
  renderToString: vi.fn(() => "<span>rendered</span>"),
}))
vi.mock("katex", () => ({ renderToString }))
vi.mock("katex/dist/katex.min.css", () => ({}))

it("renders only math widgets that survive the deferred engine load", async () => {
  const state = EditorState.create({
    doc: "$offscreen$ $visible$",
    extensions: markdown({
      base: markdownLanguage,
      extensions: [mathMarkdownExtension],
    }),
  })
  const widgets: WidgetType[] = []
  buildMathPreviewDecorations(state, false).between(
    0,
    state.doc.length,
    (_from, _to, decoration) => {
      widgets.push(decoration.spec.widget as WidgetType)
    }
  )
  const view = {
    dom: {
      ownerDocument: {
        createElement: () => ({
          classList: { remove: vi.fn() },
          dataset: {},
          isConnected: true,
          style: {},
        }),
      },
    },
    requestMeasure: vi.fn(),
  } as unknown as EditorView
  const stale = widgets[0]!.toDOM(view)
  Object.assign(stale, { isConnected: false })
  const visible = widgets[1]!.toDOM(view)

  await vi.dynamicImportSettled()

  expect(renderToString).toHaveBeenCalledOnce()
  expect(renderToString).toHaveBeenCalledWith(
    "visible",
    expect.objectContaining({ trust: false })
  )
  expect(visible.innerHTML).toBe("<span>rendered</span>")
  expect(view.requestMeasure).toHaveBeenCalledOnce()
})
