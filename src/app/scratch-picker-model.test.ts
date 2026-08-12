import { describe, expect, it } from "vitest"

import {
  SCRATCH_SORT_OPTIONS,
  nextScratchIndex,
  normalizedScratchFilename,
  scratchPickerActionAllowed,
  scratchPickerKeyAction,
  scratchPreviewRevisionMatches,
  scratchFilenameError,
  scratchTitle,
  type ScratchSummary,
} from "./scratch-picker-model"

const scratches: readonly ScratchSummary[] = [
  {
    scratchId: "alpha",
    fileName: "2026-08-08-090000.md",
    title: "Project Alpha",
    displayTitle: "Project Alpha",
    firstHeading: "Ignored Heading",
    excerpt: "The release checklist and launch notes.",
    createdAt: 10,
    modifiedAt: 30,
    lastOpenedAt: 50,
    open: false,
    profiles: [],
    revision: "alpha-r1",
    byteLength: 44,
  },
  {
    scratchId: "beta",
    fileName: "beta.md",
    title: null,
    displayTitle: "Beta Notes",
    firstHeading: "Beta Notes",
    excerpt: "Follow up with the design team.",
    createdAt: 20,
    modifiedAt: 40,
    lastOpenedAt: null,
    open: false,
    profiles: [],
    revision: "beta-r1",
    byteLength: 36,
  },
  {
    scratchId: "gamma",
    fileName: "gamma.md",
    title: null,
    displayTitle: "gamma",
    firstHeading: null,
    excerpt: "Project launch questions.",
    createdAt: 30,
    modifiedAt: 20,
    lastOpenedAt: 60,
    open: false,
    profiles: [],
    revision: "gamma-r1",
    byteLength: 25,
  },
]

describe("scratch picker model", () => {
  it("uses explicit title, heading, then filename for display", () => {
    expect(scratchTitle(scratches[0]!)).toBe("Project Alpha")
    expect(scratchTitle(scratches[1]!)).toBe("Beta Notes")
    expect(scratchTitle(scratches[2]!)).toBe("gamma")
  })

  it("offers the complete scratch sort set", () => {
    expect(SCRATCH_SORT_OPTIONS).toEqual([
      "last-opened",
      "last-edited",
      "created",
      "title",
      "filename",
    ])
  })

  it("normalizes markdown filenames and rejects path fragments", () => {
    expect(normalizedScratchFilename(" quick-notes ")).toBe("quick-notes.md")
    expect(normalizedScratchFilename("QUICK-NOTES.MD")).toBe("QUICK-NOTES.md")
    expect(scratchFilenameError("folder/notes")).toBe(
      "Remove reserved filename characters."
    )
  })

  it("cycles only with unmodified Up and Down keys", () => {
    expect(nextScratchIndex(3, 0, 1)).toBe(1)
    expect(nextScratchIndex(3, 2, 1)).toBe(0)
    expect(nextScratchIndex(3, 0, -1)).toBe(2)
    expect(nextScratchIndex(3, -1, -1)).toBe(2)
    expect(
      scratchPickerKeyAction(
        {
          altKey: false,
          ctrlKey: false,
          isComposing: false,
          key: "ArrowDown",
          metaKey: false,
          shiftKey: false,
        },
        false
      )
    ).toEqual({ direction: 1, kind: "cycle" })
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(
        scratchPickerKeyAction(
          {
            altKey: false,
            ctrlKey: false,
            isComposing: false,
            key,
            metaKey: false,
            shiftKey: false,
          },
          false
        )
      ).toBeNull()
    }
  })

  it("clears Escape before closing and distinguishes open dispositions", () => {
    const keyStroke = {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      metaKey: false,
      shiftKey: false,
    }
    expect(
      scratchPickerKeyAction({ ...keyStroke, key: "Escape" }, true)
    ).toEqual({ kind: "clear-query" })
    expect(
      scratchPickerKeyAction({ ...keyStroke, key: "Escape" }, false)
    ).toEqual({ kind: "close" })
    expect(
      scratchPickerKeyAction({ ...keyStroke, key: "Enter" }, false)
    ).toEqual({ disposition: "default", kind: "activate" })
    expect(
      scratchPickerKeyAction(
        { ...keyStroke, key: "Enter", metaKey: true },
        false
      )
    ).toEqual({ disposition: "new-tab", kind: "activate" })
    expect(
      scratchPickerKeyAction(
        { ...keyStroke, ctrlKey: true, key: "Enter" },
        false
      )
    ).toEqual({ disposition: "new-tab", kind: "activate" })
  })

  it("allows dismissals but blocks stale-result selection and activation", () => {
    expect(
      scratchPickerActionAllowed({ direction: 1, kind: "cycle" }, false)
    ).toBe(false)
    expect(
      scratchPickerActionAllowed(
        { disposition: "default", kind: "activate" },
        false
      )
    ).toBe(false)
    expect(scratchPickerActionAllowed({ kind: "clear-query" }, false)).toBe(
      true
    )
    expect(scratchPickerActionAllowed({ kind: "close" }, false)).toBe(true)
    expect(
      scratchPickerActionAllowed(
        { disposition: "new-tab", kind: "activate" },
        true
      )
    ).toBe(true)
  })

  it("invalidates previews by revision even when timestamps collide", () => {
    const cached = {
      previewRevision: "replacement-r2",
      requestedRevision: "original-r1",
    }
    expect(scratchPreviewRevisionMatches("original-r1", cached)).toBe(true)
    expect(scratchPreviewRevisionMatches("replacement-r2", cached)).toBe(true)
    expect(scratchPreviewRevisionMatches("newer-r3", cached)).toBe(false)
    expect(scratchPreviewRevisionMatches("original-r1", null)).toBe(false)
  })
})
