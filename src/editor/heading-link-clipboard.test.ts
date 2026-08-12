import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands"
import { EditorSelection, EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, it, vi } from "vitest"

import {
  headingLinkPasteFallbackTransaction,
  mapPendingHeadingLinkPaste,
  resolvedHeadingLinkPasteChanges,
  resolvedHeadingLinkPasteTransaction,
} from "./heading-link-clipboard"

function runHistoryCommand(
  state: EditorState,
  command: (view: EditorView) => boolean
) {
  let current = state
  const view = {
    get state() {
      return current
    },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
      current = current.update(spec).state
    },
  } as EditorView
  expect(command(view)).toBe(true)
  return current
}

describe("async heading-link paste", () => {
  it("keeps the synchronous fallback and maps its upgrade through later edits", () => {
    const initial = EditorState.create({
      doc: "before selection after",
      selection: { anchor: 7, head: 16 },
    })
    const fallback = "[Heading](copied.md#heading)"
    const inserted = headingLinkPasteFallbackTransaction(initial, fallback)
    let state = inserted.transaction.state

    expect(state.doc.toString()).toBe(`before ${fallback} after`)

    const beforeEdit = state.update({ changes: { from: 0, insert: "x" } })
    let pending = mapPendingHeadingLinkPaste(
      inserted.pending,
      beforeEdit.changes
    )
    state = beforeEdit.state
    const afterEdit = state.update({
      changes: { from: pending.ranges[0]!.to, insert: "!" },
    })
    pending = mapPendingHeadingLinkPaste(pending, afterEdit.changes)
    state = afterEdit.state

    state = state.update({
      changes: resolvedHeadingLinkPasteChanges(state, pending, "#heading"),
    }).state
    expect(state.doc.toString()).toBe("xbefore #heading! after")
  })

  it("leaves a fallback intact when the user edits inside it before resolution", () => {
    const initial = EditorState.create({ doc: "", selection: { anchor: 0 } })
    const inserted = headingLinkPasteFallbackTransaction(
      initial,
      "[Heading](copied.md#heading)"
    )
    const edit = inserted.transaction.state.update({
      changes: { from: 1, to: 8, insert: "Renamed" },
    })
    const pending = mapPendingHeadingLinkPaste(inserted.pending, edit.changes)

    expect(
      resolvedHeadingLinkPasteChanges(edit.state, pending, "#heading")
    ).toEqual([])
    expect(edit.state.doc.toString()).toBe("[Renamed](copied.md#heading)")
  })

  it("upgrades each still-unchanged fallback independently", () => {
    const initial = EditorState.create({
      doc: "one two",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    })
    const inserted = headingLinkPasteFallbackTransaction(initial, "fallback")
    const edit = inserted.transaction.state.update({
      changes: { from: inserted.pending.ranges[1]!.from + 1, insert: "x" },
    })
    const pending = mapPendingHeadingLinkPaste(inserted.pending, edit.changes)
    const changes = resolvedHeadingLinkPasteChanges(
      edit.state,
      pending,
      "#heading"
    )

    expect(changes).toHaveLength(1)
    expect(edit.state.update({ changes }).state.doc.toString()).toBe(
      "#heading fxallback"
    )
  })

  it("undoes and redoes a resolved selected-text paste as one history item", () => {
    const initial = EditorState.create({
      doc: "before selection after",
      selection: { anchor: 7, head: 16 },
      extensions: history(),
    })
    const fallback = "[Heading](copied.md#heading)"
    const inserted = headingLinkPasteFallbackTransaction(initial, fallback)
    const resolved = resolvedHeadingLinkPasteTransaction(
      inserted.transaction.state,
      inserted.pending,
      "#heading"
    )

    expect(resolved).not.toBeNull()
    let state = resolved!.state
    expect(state.doc.toString()).toBe("before #heading after")
    expect(undoDepth(state)).toBe(1)

    state = runHistoryCommand(state, undo)
    expect(state.doc.toString()).toBe(initial.doc.toString())
    expect(state.selection).toEqual(initial.selection)
    expect(redoDepth(state)).toBe(1)

    state = runHistoryCommand(state, redo)
    expect(state.doc.toString()).toBe("before #heading after")
  })

  it("keeps a delayed resolution grouped with an otherwise untouched paste", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-09T12:00:00Z"))
      const initial = EditorState.create({
        doc: "selection",
        selection: { anchor: 0, head: 9 },
        extensions: history(),
      })
      const inserted = headingLinkPasteFallbackTransaction(initial, "fallback")
      vi.advanceTimersByTime(5_000)
      const resolved = resolvedHeadingLinkPasteTransaction(
        inserted.transaction.state,
        inserted.pending,
        "#heading"
      )

      expect(resolved).not.toBeNull()
      expect(undoDepth(resolved!.state)).toBe(1)
      expect(runHistoryCommand(resolved!.state, undo).doc.toString()).toBe(
        "selection"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("isolates resolution after an intervening edit without corrupting history", () => {
    const initial = EditorState.create({
      doc: "before selection after",
      selection: { anchor: 7, head: 16 },
      extensions: history(),
    })
    const fallback = "[Heading](copied.md#heading)"
    const inserted = headingLinkPasteFallbackTransaction(initial, fallback)
    const edit = inserted.transaction.state.update({
      changes: { from: inserted.transaction.state.doc.length, insert: "!" },
      userEvent: "input.type",
    })
    const pending = mapPendingHeadingLinkPaste(inserted.pending, edit.changes)
    const resolved = resolvedHeadingLinkPasteTransaction(
      edit.state,
      pending,
      "#heading"
    )

    expect(resolved).not.toBeNull()
    let state = resolved!.state
    expect(state.doc.toString()).toBe("before #heading after!")
    expect(undoDepth(state)).toBe(3)

    state = runHistoryCommand(state, undo)
    expect(state.doc.toString()).toBe(`before ${fallback} after!`)
    state = runHistoryCommand(state, undo)
    expect(state.doc.toString()).toBe(`before ${fallback} after`)
    state = runHistoryCommand(state, undo)
    expect(state.doc.toString()).toBe(initial.doc.toString())

    state = runHistoryCommand(state, redo)
    state = runHistoryCommand(state, redo)
    state = runHistoryCommand(state, redo)
    expect(state.doc.toString()).toBe("before #heading after!")
  })
})
