import { EditorSelection, EditorState } from "@codemirror/state"
import { describe, expect, test, vi } from "vitest"

import { MarkdownEditorController } from "./controller"

interface PlainTextControllerInternals {
  destroyed: boolean
  documentKind: "plain-text"
  mode: "source"
  pendingMode: "live" | "source" | null
  view: {
    compositionStarted: boolean
    state: EditorState
  }
  hasSelection(): boolean
  getSelectedText(): string
  getTableCellRangeSelection(): null
  copyTableCellRange(): Promise<boolean>
  cutTableCellRange(): Promise<boolean>
  linkActivationAtCoordinates(clientX: number, clientY: number): null
  linkActivationAtSelection(): null
  getHeadings(): readonly []
  getCurrentHeading(): null
  jumpToHeading(heading: string): boolean
  jumpToFragment(destination: string): boolean
  navigateHeading(direction: -1 | 1): boolean
  applyFormatting(command: { type: "bold" }): boolean
  setMode(mode: "live" | "source"): void
  toggleMode(): "live" | "source"
}

function plainTextController() {
  const controller = Object.create(
    MarkdownEditorController.prototype
  ) as PlainTextControllerInternals
  controller.destroyed = false
  controller.documentKind = "plain-text"
  controller.mode = "source"
  controller.pendingMode = null
  controller.view = {
    compositionStarted: false,
    state: EditorState.create({
      doc: "# heading\n[selected](https://example.com)",
      selection: EditorSelection.range(0, 9),
    }),
  }
  return controller
}

describe("plain-text controller boundaries", () => {
  test("keeps generic selection while disabling Markdown semantic APIs", async () => {
    const controller = plainTextController()

    expect(controller.getSelectedText()).toBe("# heading")
    expect(controller.getTableCellRangeSelection()).toBeNull()
    await expect(controller.copyTableCellRange()).resolves.toBe(false)
    await expect(controller.cutTableCellRange()).resolves.toBe(false)
    expect(controller.linkActivationAtCoordinates(0, 0)).toBeNull()
    expect(controller.linkActivationAtSelection()).toBeNull()
    expect(controller.getHeadings()).toEqual([])
    expect(controller.getCurrentHeading()).toBeNull()
    expect(controller.jumpToHeading("heading")).toBe(false)
    expect(controller.jumpToFragment("#heading")).toBe(false)
    expect(controller.navigateHeading(1)).toBe(false)
    expect(controller.applyFormatting({ type: "bold" })).toBe(false)
  })

  test("cannot enter live mode", () => {
    const controller = plainTextController()

    controller.setMode("live")
    expect(controller.mode).toBe("source")
    expect(controller.toggleMode()).toBe("source")
    expect(controller.mode).toBe("source")
  })

  test("checks selection presence without slicing selected content", () => {
    const controller = plainTextController()
    const sliceDoc = vi.spyOn(controller.view.state, "sliceDoc")

    expect(controller.hasSelection()).toBe(true)
    expect(sliceDoc).not.toHaveBeenCalled()
  })
})
