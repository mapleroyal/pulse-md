import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands"
import { Compartment, EditorSelection, EditorState } from "@codemirror/state"
import { EditorView, type ViewUpdate } from "@codemirror/view"
import { describe, expect, it, vi } from "vitest"

import {
  headingLinkPasteFallbackTransaction,
  mapPendingHeadingLinkPaste,
  pastedHeadingLinkExtension,
  resolvedHeadingLinkPasteChanges,
  resolvedHeadingLinkPasteTransaction,
} from "./heading-link-clipboard"
import { AsyncPasteTracker } from "./async-paste"

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
  it.each([EditorState.readOnly.of(true), EditorView.editable.of(false)])(
    "declines heading clipboard handling while editing is disabled",
    (extension) => {
      const handlers = vi.spyOn(EditorView, "domEventHandlers")
      try {
        const resolve = vi.fn()
        pastedHeadingLinkExtension(resolve)
        const paste = handlers.mock.calls[0]![0].paste!
        const getData = vi.fn()
        const event = {
          clipboardData: { getData },
          preventDefault: vi.fn(),
        } as unknown as ClipboardEvent
        const view = {
          state: EditorState.create({ extensions: extension }),
          dispatch: vi.fn(),
        } as unknown as EditorView

        expect(paste.call({}, event, view)).toBe(false)
        expect(getData).not.toHaveBeenCalled()
        expect(resolve).not.toHaveBeenCalled()
        expect(view.dispatch).not.toHaveBeenCalled()
      } finally {
        handlers.mockRestore()
      }
    }
  )

  it("tracks normalized Windows clipboard line endings by editor positions", () => {
    const initial = EditorState.create({
      doc: "before after",
      selection: { anchor: 7 },
    })
    const inserted = headingLinkPasteFallbackTransaction(
      initial,
      "first\r\nsecond"
    )
    expect(inserted.transaction.state.doc.toString()).toBe(
      "before first\nsecondafter"
    )
    expect(inserted.pending.ranges).toEqual([{ from: 7, to: 19 }])
    expect(
      resolvedHeadingLinkPasteTransaction(
        inserted.transaction.state,
        inserted.pending,
        "#heading"
      )?.state.doc.toString()
    ).toBe("before #headingafter")
  })

  it("cancels delayed upgrades across a temporary read-only lease", () => {
    const editability = new Compartment()
    const initial = EditorState.create({
      extensions: editability.of(EditorState.readOnly.of(false)),
    })
    const inserted = headingLinkPasteFallbackTransaction(initial, "fallback")
    const tracker = new AsyncPasteTracker()
    tracker.pastes.set({}, inserted.pending)
    const locked = inserted.transaction.state.update({
      effects: editability.reconfigure(EditorState.readOnly.of(true)),
    })

    expect(
      resolvedHeadingLinkPasteTransaction(
        locked.state,
        inserted.pending,
        "#heading"
      )
    ).toBeNull()
    tracker.update({
      state: locked.state,
      docChanged: false,
      selectionSet: false,
    } as ViewUpdate)
    expect(tracker.pastes.size).toBe(0)
  })

  it("does not revive an upgrade after an interior edit is undone", () => {
    const inserted = headingLinkPasteFallbackTransaction(
      EditorState.create(),
      "fallback"
    )
    const edited = inserted.transaction.state.update({
      changes: { from: 3, insert: "x" },
    })
    const pending = mapPendingHeadingLinkPaste(inserted.pending, edited.changes)
    const restored = edited.state.update({ changes: { from: 3, to: 4 } })
    expect(restored.state.doc.toString()).toBe("fallback")
    expect(
      resolvedHeadingLinkPasteChanges(
        restored.state,
        mapPendingHeadingLinkPaste(pending, restored.changes),
        "#heading"
      )
    ).toEqual([])
  })

  it("cancels an HTML-only empty fallback when authored text arrives there", () => {
    const inserted = headingLinkPasteFallbackTransaction(
      EditorState.create(),
      ""
    )
    const edited = inserted.transaction.state.update({
      changes: { from: 0, insert: "typed" },
    })
    const pending = mapPendingHeadingLinkPaste(inserted.pending, edited.changes)
    expect(
      resolvedHeadingLinkPasteChanges(edited.state, pending, "converted")
    ).toEqual([])
  })

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
