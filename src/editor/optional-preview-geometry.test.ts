import { Compartment, EditorState, StateEffect } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, it, vi } from "vitest"

import { MarkdownEditorController } from "./controller"
import { optionalLivePreviewSupport } from "./optional-live-preview"
import {
  optionalPreviewGeometryRefreshRequested,
  PreviewHeightCache,
  refreshOptionalPreviewGeometry,
} from "./optional-preview-geometry"

describe("optional preview geometry", () => {
  it("invalidates measured heights before typography remeasurement", () => {
    const heights = new PreviewHeightCache(2)
    heights.set("math", 120)
    heights.set("html", 240)

    heights.invalidate()

    expect(heights.get("math")).toBeNull()
    expect(heights.get("html")).toBeNull()
  })

  it("marks the explicit typography refresh transaction", () => {
    const state = EditorState.create()
    const transaction = state.update({
      effects: refreshOptionalPreviewGeometry.of(null),
    })

    expect(optionalPreviewGeometryRefreshRequested(transaction)).toBe(true)
  })

  it("routes controller geometry refreshes through the lazy preview support", () => {
    const dispatch = vi.fn()

    optionalLivePreviewSupport.refreshContentGeometry({
      dispatch,
    } as unknown as EditorView)

    const [spec] = dispatch.mock.calls[0]!
    expect(
      (spec.effects as { is(effect: unknown): boolean }).is(
        refreshOptionalPreviewGeometry
      )
    ).toBe(true)
  })

  it("invalidates optional geometry before restoring anchors after width changes", () => {
    const controller = Object.create(
      MarkdownEditorController.prototype
    ) as MarkdownEditorController
    const restoreAnchor = vi.fn()
    const scrollSnapshot = StateEffect.appendConfig.of([])
    Object.assign(controller, {
      captureScrollAnchor: () => ({ pos: 0, screenOffset: 0 }),
      destroyed: false,
      layout: new Compartment(),
      lineWrapping: true,
      maxContentWidth: 960,
      startScrollAnchorRestore: restoreAnchor,
      view: {
        dispatch: vi.fn(),
        scrollSnapshot: () => scrollSnapshot,
      },
      wrapping: new Compartment(),
    })
    const refreshGeometry = vi
      .spyOn(controller, "refreshContentGeometry")
      .mockImplementation(() => undefined)

    controller.setLineWrapping(false)
    controller.setMaxContentWidth(800)

    expect(refreshGeometry).toHaveBeenCalledTimes(2)
    expect(restoreAnchor).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 2; index += 1) {
      expect(refreshGeometry.mock.invocationCallOrder[index]).toBeLessThan(
        restoreAnchor.mock.invocationCallOrder[index]!
      )
    }
  })
})
