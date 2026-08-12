import { EditorState, type TransactionSpec } from "@codemirror/state"
import { describe, expect, test, vi } from "vitest"

import { MarkdownEditorController } from "./controller"
import type { MarkdownEditorSession } from "./types"

interface PositionControllerInternals {
  cancelScrollAnchorRestore(): void
  destroyed: boolean
  setCursorPosition(line: number, column: number): boolean
  setSessionCursorPosition(
    session: MarkdownEditorSession,
    line: number,
    column: number
  ): boolean
  view: {
    dispatch(spec: TransactionSpec): void
    scrollDOM: { clientHeight: number }
    state: EditorState
  }
}

function positionController(content: string) {
  let state = EditorState.create({ doc: content })
  const controller = Object.create(
    MarkdownEditorController.prototype
  ) as PositionControllerInternals
  controller.destroyed = false
  controller.cancelScrollAnchorRestore = vi.fn()
  controller.view = {
    scrollDOM: { clientHeight: 600 },
    get state() {
      return state
    },
    dispatch(spec) {
      state = state.update(spec).state
    },
  }
  return controller
}

describe("editor cursor positioning", () => {
  test("uses one-based line and column values and clamps both to the document", () => {
    const controller = positionController("abc\nxy\nlast")

    expect(controller.setCursorPosition(2, 2)).toBe(true)
    expect(controller.view.state.selection.main.head).toBe(5)

    expect(controller.setCursorPosition(99, 99)).toBe(true)
    expect(controller.view.state.selection.main.head).toBe(11)

    expect(controller.setCursorPosition(-4, -2)).toBe(true)
    expect(controller.view.state.selection.main.head).toBe(0)
    expect(controller.cancelScrollAnchorRestore).toHaveBeenCalledTimes(3)
  })

  test("positions an inactive session without changing the mounted document", () => {
    const controller = positionController("mounted")
    const session: MarkdownEditorSession = {
      state: EditorState.create({ doc: "one\ntwo\nthree" }),
      documentKind: "markdown",
      documentPath: null,
      mode: "live",
      lineWrapping: true,
      caretVisible: false,
      viewport: { pos: 0, screenOffset: 12, scrollLeft: 0, scrollTop: 0 },
      viewportInitialized: true,
      revision: 0,
    }

    expect(controller.setSessionCursorPosition(session, 3, 3)).toBe(true)
    expect(session.state.selection.main.head).toBe(10)
    expect(session.viewport).toMatchObject({
      pos: 10,
      screenOffset: 300,
      scrollTop: 0,
    })
    expect(session.scrollSnapshot).toBeDefined()
    expect(controller.view.state.doc.toString()).toBe("mounted")
  })
})
