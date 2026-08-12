import { describe, expect, it, vi } from "vitest"

import {
  editorFontLoadSample,
  loadInitialEditorFonts,
  serializedEditorContent,
  serializedEditorFontPositions,
  type EditorFontLoader,
} from "./editor-font-readiness"

describe("editor font readiness", () => {
  it("samples the current serialized editor text instead of its disk baseline", () => {
    expect(
      serializedEditorContent(
        { state: { doc: "dirty text introduces 漢字" } },
        "clean disk text"
      )
    ).toBe("dirty text introduces 漢字")
    expect(serializedEditorContent({ state: { doc: "" } }, "disk text")).toBe(
      ""
    )
    expect(serializedEditorContent({ state: {} }, "disk text")).toBe(
      "disk text"
    )
  })

  it("builds a bounded unique-codepoint sample across a large document", () => {
    const content = "α" + "a".repeat(45_000) + "中" + "b".repeat(45_000) + "🙂"

    const sample = editorFontLoadSample(content)
    const codePoints = [...sample]

    expect(new Set(codePoints).size).toBe(codePoints.length)
    expect(codePoints.length).toBeLessThanOrEqual(256)
    expect(sample).toContain("A")
    expect(sample).toContain("α")
    expect(sample).toContain("中")
    expect(sample).toContain("🙂")
  })

  it("seeds exact restored-position glyphs before scanning nearby text", () => {
    const distinctPrefix = Array.from({ length: 180 }, (_value, index) =>
      String.fromCodePoint(0x400 + index)
    ).join("")
    const viewportPosition = 30_000 + distinctPrefix.length
    const content = `${"a".repeat(30_000)}${distinctPrefix}漢${"b".repeat(90_000)}`
    const positions = serializedEditorFontPositions(
      {
        state: {
          selection: { main: 0, ranges: [{ anchor: 75_000, head: 75_001 }] },
        },
        viewport: { pos: 12 },
      },
      { pos: viewportPosition }
    )

    expect(new Set(distinctPrefix).size).toBeGreaterThan(161)
    expect(positions).toEqual([viewportPosition, 75_000, 75_001])
    const sample = editorFontLoadSample(content, positions)
    expect(sample).toContain("漢")
    expect([...sample]).toHaveLength(256)
  })

  it("loads geometry-relevant regular and monospace faces", async () => {
    const load = vi.fn<EditorFontLoader["load"]>().mockResolvedValue([])

    await loadInitialEditorFonts(
      { load },
      {
        content: "Plain *italic* **bold** λ",
        monospaceFontSize: 18,
        monospaceFontStack: '"Example Mono", monospace',
        regularFontSize: 20,
        regularFontStack: '"Example Sans", sans-serif',
      }
    )

    expect(load.mock.calls.map(([font]) => font)).toEqual([
      'normal 400 20px "Example Sans", sans-serif',
      'italic 400 20px "Example Sans", sans-serif',
      'normal 700 20px "Example Sans", sans-serif',
      'normal 400 18px "Example Mono", monospace',
      'italic 400 18px "Example Mono", monospace',
      'normal 700 18px "Example Mono", monospace',
    ])
    expect(load.mock.calls.every(([, sample]) => sample?.includes("λ"))).toBe(
      true
    )
  })

  it("does not block startup when a face cannot be loaded", async () => {
    const load = vi
      .fn<EditorFontLoader["load"]>()
      .mockRejectedValueOnce(new Error("missing face"))
      .mockResolvedValue([])

    await expect(
      loadInitialEditorFonts(
        { load },
        {
          content: "Document",
          monospaceFontSize: 20,
          monospaceFontStack: "monospace",
          regularFontSize: 20,
          regularFontStack: "sans-serif",
        }
      )
    ).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(6)
  })
})
