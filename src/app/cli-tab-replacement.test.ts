import { describe, expect, it } from "vitest"

import {
  isDisposableCliTabReplacement,
  type CliTabReplacementCandidate,
} from "./cli-tab-replacement"

function disposableCandidate(
  overrides: Partial<CliTabReplacementCandidate> = {}
): CliTabReplacementCandidate {
  return {
    active: true,
    backing: "untitled",
    cleanDocumentLength: 0,
    descriptor: {
      backing: "untitled",
      dirty: false,
      displayName: "Untitled",
      fileMissing: false,
      filePath: null,
    },
    dirty: false,
    documentFilePath: null,
    editorDocumentLength: 0,
    ...overrides,
  }
}

describe("CLI tab replacement", () => {
  it("accepts only the active ordinary clean empty untitled tab", () => {
    expect(isDisposableCliTabReplacement(disposableCandidate())).toBe(true)
  })

  it.each([
    ["inactive", { active: false }],
    ["file-backed", { backing: "file" as const }],
    ["locally dirty", { dirty: true }],
    ["locally path-backed", { documentFilePath: "/work/notes.md" }],
    ["non-empty baseline", { cleanDocumentLength: 1 }],
    ["non-empty editor", { editorDocumentLength: 1 }],
    [
      "descriptor dirty",
      { descriptor: { ...disposableCandidate().descriptor, dirty: true } },
    ],
    [
      "descriptor file-backed",
      {
        descriptor: {
          ...disposableCandidate().descriptor,
          backing: "file" as const,
        },
      },
    ],
    [
      "descriptor path-backed",
      {
        descriptor: {
          ...disposableCandidate().descriptor,
          filePath: "/work/notes.md",
        },
      },
    ],
    [
      "missing file",
      {
        descriptor: {
          ...disposableCandidate().descriptor,
          fileMissing: true,
        },
      },
    ],
    [
      "titled",
      {
        descriptor: {
          ...disposableCandidate().descriptor,
          displayName: "Pinned notes",
        },
      },
    ],
  ])("rejects a %s replacement candidate", (_label, overrides) => {
    expect(
      isDisposableCliTabReplacement(
        disposableCandidate(overrides as Partial<CliTabReplacementCandidate>)
      )
    ).toBe(false)
  })
})
