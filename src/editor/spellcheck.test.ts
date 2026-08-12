import {
  EditorSelection,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state"
import type { EditorView, ViewUpdate } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  SpellCheckView,
  spellingCandidateAt,
  spellingCandidatesInText,
} from "./spellcheck"

function controlledSpellCheckView(
  initialState: EditorState,
  checkWords: (words: readonly string[]) => readonly boolean[] | null
) {
  let nextFrame = 1
  let nextTimer = 1
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  const dispatched: TransactionSpec[] = []
  const ownerWindow = {
    cancelAnimationFrame(frame: number) {
      frames.delete(frame)
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frame = nextFrame++
      frames.set(frame, callback)
      return frame
    },
    clearTimeout(timer: number) {
      timers.delete(timer)
    },
    setTimeout(callback: () => void) {
      const timer = nextTimer++
      timers.set(timer, callback)
      return timer
    },
  } as unknown as Window
  const mutableView = {
    compositionStarted: false,
    dispatch(spec: TransactionSpec) {
      dispatched.push(spec)
    },
    dom: {
      isConnected: true,
      ownerDocument: { defaultView: ownerWindow },
    },
    hasFocus: true,
    state: initialState,
    visibleRanges: [{ from: 0, to: initialState.doc.length }],
  }
  const view = mutableView as unknown as EditorView
  const spellCheck = new SpellCheckView(view, checkWords)

  const applyTransaction = (transaction: Transaction) => {
    const startState = mutableView.state
    mutableView.state = transaction.state
    mutableView.visibleRanges = [{ from: 0, to: transaction.state.doc.length }]
    spellCheck.update({
      changes: transaction.changes,
      docChanged: transaction.docChanged,
      startState,
      state: transaction.state,
      transactions: [transaction],
      view,
      viewportChanged: false,
      focusChanged: false,
      selectionSet: transaction.selection != null,
    } as unknown as ViewUpdate)
  }

  return {
    apply(spec: TransactionSpec) {
      applyTransaction(mutableView.state.update(spec))
    },
    applyFocus(focused: boolean) {
      mutableView.hasFocus = focused
      spellCheck.update({
        docChanged: false,
        focusChanged: true,
        selectionSet: false,
        startState: mutableView.state,
        state: mutableView.state,
        transactions: [],
        view,
        viewportChanged: false,
      } as unknown as ViewUpdate)
    },
    applyViewportRefresh() {
      spellCheck.update({
        docChanged: false,
        focusChanged: false,
        selectionSet: false,
        startState: mutableView.state,
        state: mutableView.state,
        transactions: [],
        view,
        viewportChanged: true,
      } as unknown as ViewUpdate)
    },
    decorationCount() {
      let count = 0
      spellCheck.decorations.between(0, mutableView.state.doc.length, () => {
        count += 1
      })
      return count
    },
    flushAllFrames() {
      let flushed = 0
      while (frames.size > 0) {
        if (flushed > 300) {
          throw new Error("Spelling scan did not converge")
        }
        const callbacks = [...frames.values()]
        frames.clear()
        for (const callback of callbacks) {
          callback(0)
          const spec = dispatched.shift()
          if (!spec) throw new Error("Expected a deferred spelling refresh")
          applyTransaction(mutableView.state.update(spec))
          flushed += 1
        }
      }
      return flushed
    },
    frameCount: () => frames.size,
    flushNextTimer() {
      const entry = timers.entries().next().value as
        [number, () => void] | undefined
      if (!entry) throw new Error("Expected a deferred spelling retry")
      const [timer, callback] = entry
      timers.delete(timer)
      callback()
      const spec = dispatched.shift()
      if (!spec) throw new Error("Expected a deferred spelling refresh")
      applyTransaction(mutableView.state.update(spec))
    },
    timerCount: () => timers.size,
    setCompositionStarted(composing: boolean) {
      mutableView.compositionStarted = composing
    },
    spellCheck,
  }
}

describe("editor spelling candidates", () => {
  test("keeps compound model names, apostrophes, and combining marks intact", () => {
    const text =
      "retranscribing Qwen3-TTS Qwen3-TTS-12Hz-0.6B-Base-4bit l’esprit cafe\u0301 1234 0.6"

    expect(
      spellingCandidatesInText(text, 0).map((candidate) => candidate.word)
    ).toEqual([
      "retranscribing",
      "Qwen3-TTS",
      "Qwen3-TTS-12Hz-0.6B-Base-4bit",
      "l’esprit",
      "cafe\u0301",
    ])
  })

  test("resolves the whole candidate at either visual edge of a word", () => {
    const word = "Qwen3-TTS-12Hz-0.6B-Base-4bit"
    const state = EditorState.create({ doc: `before ${word} after` })
    const from = state.doc.toString().indexOf(word)

    expect(spellingCandidateAt(state, from)).toEqual({
      from,
      to: from + word.length,
      word,
    })
    expect(spellingCandidateAt(state, from + word.length)).toEqual({
      from,
      to: from + word.length,
      word,
    })
  })

  test("does not split an overlong identifier into a false candidate", () => {
    const word = `Q${"x".repeat(256)}`
    const state = EditorState.create({ doc: word })

    expect(spellingCandidatesInText(word, 0)).toEqual([])
    expect(spellingCandidateAt(state, 128)).toBeNull()
  })

  test("converges when the visible vocabulary exceeds the ordinary cache budget", () => {
    const words = Array.from(
      { length: 9_000 },
      (_, index) => `w${index.toString(36).padStart(3, "0")}`
    )
    const checkedBatches: string[][] = []
    const state = EditorState.create({ doc: words.join(" ") })
    const harness = controlledSpellCheckView(state, (batch) => {
      checkedBatches.push([...batch])
      return batch.map(() => true)
    })

    expect(harness.frameCount()).toBe(1)
    expect(harness.flushAllFrames()).toBe(Math.ceil(words.length / 128))
    expect(checkedBatches.flat()).toEqual(words)
    expect(harness.decorationCount()).toBe(words.length)

    checkedBatches.length = 0
    harness.applyViewportRefresh()
    expect(harness.frameCount()).toBe(0)
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(words.length)
    harness.spellCheck.destroy()
  })

  test("retries a temporarily unavailable platform checker without caching false", () => {
    const word = "zzzxqvblorp"
    let checks = 0
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: word }),
      (batch) => {
        checks += 1
        return checks < 3 ? null : batch.map(() => true)
      }
    )

    harness.flushAllFrames()
    expect(harness.decorationCount()).toBe(0)
    expect(harness.timerCount()).toBe(1)
    harness.flushNextTimer()
    expect(harness.decorationCount()).toBe(0)
    expect(harness.timerCount()).toBe(1)
    harness.flushNextTimer()
    expect(harness.decorationCount()).toBe(1)
    expect(harness.timerCount()).toBe(0)
    expect(checks).toBe(3)
    harness.spellCheck.destroy()
  })

  test("bounds retries while the platform checker remains unavailable", () => {
    let checks = 0
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: "zzzxqvblorp" }),
      () => {
        checks += 1
        return null
      }
    )

    harness.flushAllFrames()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(harness.timerCount()).toBe(1)
      harness.flushNextTimer()
    }
    expect(harness.timerCount()).toBe(0)
    expect(checks).toBe(6)
    expect(harness.decorationCount()).toBe(0)
    harness.spellCheck.destroy()
  })

  test("cancels an unavailable-checker retry on teardown", () => {
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: "zzzxqvblorp" }),
      () => null
    )

    harness.flushAllFrames()
    expect(harness.timerCount()).toBe(1)
    harness.spellCheck.destroy()
    expect(harness.timerCount()).toBe(0)
  })

  test("checks a typed word only after whitespace commits it", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(EditorState.create(), (batch) => {
      checkedBatches.push([...batch])
      return batch.map(() => true)
    })
    harness.flushAllFrames()

    for (const [index, character] of [...word].entries()) {
      harness.apply({
        changes: { from: index, insert: character },
        selection: { anchor: index + 1 },
        userEvent: "input.type",
      })
    }
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    harness.apply({
      changes: { from: word.length, insert: " " },
      selection: { anchor: word.length + 1 },
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([[word]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("commits on terminal punctuation but not an incomplete word joiner", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(EditorState.create(), (batch) => {
      checkedBatches.push([...batch])
      return batch.map(() => true)
    })
    harness.flushAllFrames()

    harness.apply({
      changes: { from: 0, insert: word },
      selection: { anchor: word.length },
      userEvent: "input.type",
    })
    harness.apply({
      changes: { from: word.length, insert: "'" },
      selection: { anchor: word.length + 1 },
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    harness.apply({
      changes: { from: word.length + 1, insert: "." },
      selection: { anchor: word.length + 2 },
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([[word]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("keeps a word deferred while navigating within it and checks on exit", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: "\n" }),
      (batch) => {
        checkedBatches.push([...batch])
        return batch.map(() => true)
      }
    )
    harness.flushAllFrames()

    harness.apply({
      changes: { from: 0, insert: word },
      selection: { anchor: word.length },
      userEvent: "input.type",
    })
    harness.apply({
      selection: { anchor: 3 },
      userEvent: "select",
    })
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    harness.apply({
      selection: { anchor: word.length + 1 },
      userEvent: "select",
    })
    expect(checkedBatches).toEqual([[word]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("does not hide a pre-existing error until the word is edited", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: word }),
      (batch) => {
        checkedBatches.push([...batch])
        return batch.map(() => true)
      }
    )
    harness.flushAllFrames()
    expect(harness.decorationCount()).toBe(1)

    harness.apply({
      selection: { anchor: 3 },
      userEvent: "select.pointer",
    })
    expect(harness.decorationCount()).toBe(1)

    harness.apply({
      selection: { anchor: word.length },
      userEvent: "select",
    })
    harness.apply({
      changes: { from: word.length, insert: "'" },
      selection: { anchor: word.length + 1 },
      userEvent: "input.type",
    })
    expect(harness.decorationCount()).toBe(0)
    expect(checkedBatches).toEqual([[word]])
    harness.spellCheck.destroy()
  })

  test("keeps finalized composition text deferred until it is committed", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(EditorState.create(), (batch) => {
      checkedBatches.push([...batch])
      return batch.map(() => true)
    })
    harness.flushAllFrames()

    harness.setCompositionStarted(true)
    harness.apply({
      changes: { from: 0, insert: word },
      selection: { anchor: word.length },
      userEvent: "input.type.compose",
    })
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    harness.setCompositionStarted(false)
    harness.apply({
      selection: { anchor: word.length },
      userEvent: "select",
    })
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    harness.apply({
      changes: { from: word.length, insert: " " },
      selection: { anchor: word.length + 1 },
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([[word]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("commits an active word when the editor loses focus", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(EditorState.create(), (batch) => {
      checkedBatches.push([...batch])
      return batch.map(() => true)
    })
    harness.flushAllFrames()
    harness.apply({
      changes: { from: 0, insert: word },
      selection: { anchor: word.length },
      userEvent: "input.type",
    })

    harness.applyFocus(false)
    expect(checkedBatches).toEqual([[word]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("defers every word being typed with multiple carets", () => {
    const checkedBatches: string[][] = []
    const first = "zzzxqvone"
    const second = "zzzxqvtwo"
    const harness = controlledSpellCheckView(
      EditorState.create({
        doc: "\n",
        extensions: EditorState.allowMultipleSelections.of(true),
      }),
      (batch) => {
        checkedBatches.push([...batch])
        return batch.map(() => true)
      }
    )
    harness.flushAllFrames()

    harness.apply({
      changes: [
        { from: 0, insert: first },
        { from: 1, insert: second },
      ],
      selection: EditorSelection.create([
        EditorSelection.cursor(first.length),
        EditorSelection.cursor(first.length + 1 + second.length),
      ]),
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([])
    expect(harness.decorationCount()).toBe(0)

    const secondEnd = first.length + 1 + second.length
    harness.apply({
      changes: [
        { from: first.length, insert: " " },
        { from: secondEnd, insert: " " },
      ],
      selection: EditorSelection.create([
        EditorSelection.cursor(first.length + 1),
        EditorSelection.cursor(secondEnd + 2),
      ]),
      userEvent: "input.type",
    })
    expect(checkedBatches).toEqual([[first, second]])
    expect(harness.decorationCount()).toBe(2)
    harness.spellCheck.destroy()
  })

  test("keeps an unchanged word marked when deletion only relocates it", () => {
    const checkedBatches: string[][] = []
    const first = "zzzxqvone"
    const second = "zzzxqvtwo"
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: `${first} ${second}` }),
      (batch) => {
        checkedBatches.push([...batch])
        return batch.map(() => true)
      }
    )
    harness.flushAllFrames()
    expect(harness.decorationCount()).toBe(2)

    harness.apply({
      changes: { from: 0, to: first.length + 1 },
      selection: { anchor: 0 },
      userEvent: "delete.selection",
    })
    expect(checkedBatches).toEqual([[first, second]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test("checks the remaining word immediately after a cut", () => {
    const checkedBatches: string[][] = []
    const word = "zzzxqvblorp"
    const harness = controlledSpellCheckView(
      EditorState.create({ doc: word }),
      (batch) => {
        checkedBatches.push([...batch])
        return batch.map(() => true)
      }
    )
    harness.flushAllFrames()

    harness.apply({
      changes: { from: 3, to: 4 },
      selection: { anchor: 3 },
      userEvent: "delete.cut",
    })
    expect(checkedBatches).toEqual([[word], [word.slice(0, 3) + word.slice(4)]])
    expect(harness.decorationCount()).toBe(1)
    harness.spellCheck.destroy()
  })

  test.each(["-", "_", "'"])(
    "commits after an invalid doubled %s joiner",
    (joiner) => {
      const checkedBatches: string[][] = []
      const word = "zzzxqvblorp"
      const harness = controlledSpellCheckView(
        EditorState.create(),
        (batch) => {
          checkedBatches.push([...batch])
          return batch.map(() => true)
        }
      )
      harness.flushAllFrames()
      harness.apply({
        changes: { from: 0, insert: word },
        selection: { anchor: word.length },
        userEvent: "input.type",
      })
      harness.apply({
        changes: { from: word.length, insert: joiner },
        selection: { anchor: word.length + 1 },
        userEvent: "input.type",
      })
      expect(checkedBatches).toEqual([])

      harness.apply({
        changes: { from: word.length + 1, insert: joiner },
        selection: { anchor: word.length + 2 },
        userEvent: "input.type",
      })
      expect(checkedBatches).toEqual([[word]])
      expect(harness.decorationCount()).toBe(1)
      harness.spellCheck.destroy()
    }
  )
})
