import path from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import {
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_PATH_LENGTH,
  MAX_PROFILE_TABS,
  MAX_PROFILE_TAB_TITLE_LENGTH,
  PROFILE_SCHEMA_VERSION,
  ProfileSchemaError,
  isProfileIdentifier,
  normalizeProfileSchema,
} from "./profile-schema"

const sourceDirectory = path.resolve(path.sep, "profile-tests", "profiles")

function scratchId(index = 1): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

function validProfile(): Record<string, unknown> {
  return {
    version: PROFILE_SCHEMA_VERSION,
    id: "quick-notes",
    name: "Quick Notes",
    activeTab: "remembered",
    tabVisibility: "always",
    mode: "live",
    tabs: [
      { id: "temporary", kind: "untitled" },
      {
        id: "discardable",
        kind: "ephemeral",
        title: "Temporary Notes",
        color: "orange",
        mode: "source",
      },
      {
        id: "remembered",
        kind: "scratch",
        scratchId: scratchId(),
        title: "Remembered Notes",
        color: "blue",
      },
      { id: "todo", kind: "file", path: "documents/todo.md" },
    ],
  }
}

function normalize(value: unknown) {
  return normalizeProfileSchema(value, { sourceDirectory })
}

function expectSchemaError(value: unknown, schemaPath?: string) {
  try {
    normalize(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileSchemaError)
    const schemaError = error as ProfileSchemaError
    if (schemaPath !== undefined) {
      expect(schemaError.schemaPath).toBe(schemaPath)
    }
    return schemaError
  }
  throw new Error("Expected a ProfileSchemaError")
}

describe("normalizeProfileSchema", () => {
  it("normalizes every backing kind and resolves relative file paths", () => {
    const profile = validProfile()
    profile.name = "  Quick Notes  "
    const tabs = profile.tabs as Array<Record<string, unknown>>
    tabs[1].title = "  Temporary Notes  "

    expect(normalize(profile)).toEqual({
      version: PROFILE_SCHEMA_VERSION,
      id: "quick-notes",
      name: "Quick Notes",
      activeTab: "remembered",
      tabVisibility: "always",
      mode: "live",
      tabs: [
        { id: "temporary", kind: "untitled" },
        {
          id: "discardable",
          kind: "ephemeral",
          title: "Temporary Notes",
          color: "orange",
          mode: "source",
        },
        {
          id: "remembered",
          kind: "scratch",
          scratchId: scratchId(),
          title: "Remembered Notes",
          color: "blue",
        },
        {
          id: "todo",
          kind: "file",
          path: path.join(sourceDirectory, "documents", "todo.md"),
        },
      ],
    })
  })

  it("preserves absolute paths and decodes file URLs", () => {
    const absolutePath = path.resolve(path.sep, "notes", "one.md")
    const fileUrlPath = path.resolve(path.sep, "notes", "two words.md")
    const mixedCaseFileUrlPath = path.resolve(
      path.sep,
      "notes",
      "mixed scheme.md"
    )
    const profile = validProfile()
    profile.tabs = [
      { id: "one", kind: "file", path: absolutePath },
      { id: "two", kind: "file", path: pathToFileURL(fileUrlPath).href },
      {
        id: "three",
        kind: "file",
        path: pathToFileURL(mixedCaseFileUrlPath).href.replace(
          /^file:/u,
          "FiLe:"
        ),
      },
    ]
    profile.activeTab = "one"

    expect(normalize(profile).tabs).toEqual([
      { id: "one", kind: "file", path: absolutePath },
      { id: "two", kind: "file", path: fileUrlPath },
      { id: "three", kind: "file", path: mixedCaseFileUrlPath },
    ])
  })

  it("allows every semantic color and tabs visibility", () => {
    const colors = [
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "gray",
    ]
    for (const color of colors) {
      const profile = validProfile()
      profile.tabs = [
        { id: "tab", kind: "scratch", scratchId: scratchId(), color },
      ]
      profile.activeTab = "tab"
      expect(normalize(profile).tabs[0]).toMatchObject({ color })
    }

    for (const tabVisibility of [
      "inherit",
      "always",
      "multiple-tabs",
      "mouseover",
      "formatting-bar",
      "hidden",
    ]) {
      const profile = validProfile()
      profile.tabVisibility = tabVisibility
      expect(normalize(profile).tabVisibility).toBe(tabVisibility)
    }
  })

  it("allows root and per-tab modes to be omitted and rejects inherit", () => {
    const profile = validProfile()
    delete profile.mode
    expect(normalize(profile)).not.toHaveProperty("mode")

    const tabs = profile.tabs as Array<Record<string, unknown>>
    delete tabs[1].mode
    expect(normalize(profile).tabs[1]).not.toHaveProperty("mode")

    profile.mode = "inherit"
    expectSchemaError(profile, "profile.mode")

    profile.mode = "live"
    tabs[1].mode = "inherit"
    expectSchemaError(profile, "profile.tabs[1].mode")
  })

  it("normalizes references to separately stored scratch documents", () => {
    const profile = validProfile()
    profile.tabs = [
      {
        id: "notes-tab",
        kind: "scratch",
        scratchId: scratchId(2),
      },
      {
        id: "archive-tab",
        kind: "scratch",
        scratchId: scratchId(3),
      },
    ]
    profile.activeTab = "notes-tab"

    expect(normalize(profile).tabs).toEqual(profile.tabs)
  })

  it("does not mutate the imported object", () => {
    const profile = validProfile()
    const before = structuredClone(profile)
    normalize(profile)
    expect(profile).toEqual(before)
  })

  it("requires an absolute, explicit source directory", () => {
    expect(() =>
      normalizeProfileSchema(validProfile(), { sourceDirectory: "relative" })
    ).toThrow("Profile source directory must be absolute")
  })

  it.each([
    [null, "profile"],
    [[], "profile"],
    [{}, "profile.version"],
    [{ ...validProfile(), version: 1 }, "profile.version"],
    [{ ...validProfile(), extra: true }, "profile.extra"],
    [{ ...validProfile(), tabs: "tabs" }, "profile.tabs"],
    [{ ...validProfile(), tabs: [] }, "profile.tabs"],
    [{ ...validProfile(), tabVisibility: "hover" }, "profile.tabVisibility"],
    [{ ...validProfile(), mode: "preview" }, "profile.mode"],
  ] as const)("rejects invalid root shape %#", (value, schemaPath) => {
    expectSchemaError(value, schemaPath)
  })

  it("caps the profile tab count", () => {
    const profile = validProfile()
    profile.tabs = Array.from({ length: MAX_PROFILE_TABS + 1 }, (_, index) => ({
      id: `tab-${index}`,
      kind: "scratch",
      scratchId: scratchId(index + 1),
    }))
    expectSchemaError(profile, "profile.tabs")
  })

  it.each([
    ["UPPER", false],
    ["with_underscore", false],
    ["-leading", false],
    ["trailing-", false],
    ["two--hyphens", false],
    ["", false],
    ["con", false],
    ["com1", false],
    ["lpt9", false],
    ["a".repeat(MAX_PROFILE_ID_LENGTH + 1), false],
    ["a", true],
    ["work-notes-2", true],
  ] as const)("validates slug identifiers %j", (value, expected) => {
    expect(isProfileIdentifier(value)).toBe(expected)
  })

  it("rejects invalid root and tab identifiers", () => {
    const invalidRoot = validProfile()
    invalidRoot.id = "Quick Notes"
    expectSchemaError(invalidRoot, "profile.id")

    const invalidTab = validProfile()
    invalidTab.tabs = [
      { id: "not_valid", kind: "scratch", scratchId: scratchId() },
    ]
    invalidTab.activeTab = "not_valid"
    expectSchemaError(invalidTab, "profile.tabs[0].id")
  })

  it("explains the cross-platform reserved-name restriction", () => {
    const profile = validProfile()
    profile.id = "con"
    expect(expectSchemaError(profile, "profile.id").message).toContain(
      "reserved Windows device name"
    )
  })

  it("rejects duplicate tab ids and dangling active-tab references", () => {
    const duplicate = validProfile()
    duplicate.tabs = [
      { id: "same", kind: "scratch", scratchId: scratchId() },
      { id: "same", kind: "ephemeral" },
    ]
    duplicate.activeTab = "same"
    expectSchemaError(duplicate, "profile.tabs")

    const dangling = validProfile()
    dangling.activeTab = "missing"
    expectSchemaError(dangling, "profile.activeTab")
  })

  it("rejects duplicate normalized file paths", () => {
    const duplicate = validProfile()
    duplicate.tabs = [
      { id: "first", kind: "file", path: "notes/../same.md" },
      { id: "second", kind: "file", path: "same.md" },
    ]
    duplicate.activeTab = "first"

    expect(expectSchemaError(duplicate, "profile.tabs").message).toContain(
      "duplicate file path"
    )
  })

  it("rejects duplicate standalone scratch ids", () => {
    const duplicate = validProfile()
    duplicate.tabs = [
      { id: "first", kind: "scratch", scratchId: scratchId() },
      {
        id: "second",
        kind: "scratch",
        scratchId: scratchId(),
      },
    ]
    duplicate.activeTab = "first"

    expect(expectSchemaError(duplicate, "profile.tabs").message).toContain(
      "duplicate scratch id"
    )
  })

  it("enforces kind-specific exact keys and file path requirements", () => {
    const missingPath = validProfile()
    missingPath.tabs = [{ id: "file", kind: "file" }]
    missingPath.activeTab = "file"
    expectSchemaError(missingPath, "profile.tabs[0].path")

    for (const kind of ["untitled", "ephemeral", "scratch"]) {
      const extraPath = validProfile()
      extraPath.tabs = [{ id: "tab", kind, path: "not-allowed.md" }]
      extraPath.activeTab = "tab"
      expectSchemaError(extraPath, "profile.tabs[0].path")
    }

    const extraKey = validProfile()
    extraKey.tabs = [{ id: "tab", kind: "scratch", autosave: true }]
    extraKey.activeTab = "tab"
    expectSchemaError(extraKey, "profile.tabs[0].autosave")

    const nonScratchReference = validProfile()
    nonScratchReference.tabs = [
      {
        id: "tab",
        kind: "untitled",
        scratchId: scratchId(),
      },
    ]
    nonScratchReference.activeTab = "tab"
    expectSchemaError(nonScratchReference, "profile.tabs[0].scratchId")
  })

  it("requires canonical standalone scratch ids", () => {
    for (const storedScratchId of [
      null,
      {},
      "daily-notes",
      "abcdefab-cdef-4abc-8abc-abcdefabcdef".toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
    ]) {
      const profile = validProfile()
      profile.tabs = [
        { id: "tab", kind: "scratch", scratchId: storedScratchId },
      ]
      profile.activeTab = "tab"
      expectSchemaError(profile, "profile.tabs[0].scratchId")
    }

    const missing = validProfile()
    missing.tabs = [{ id: "tab", kind: "scratch" }]
    missing.activeTab = "tab"
    expectSchemaError(missing, "profile.tabs[0].scratchId")
  })

  it("rejects unknown kinds, colors, and invalid tab records", () => {
    for (const tab of [
      null,
      { id: "tab", kind: "unknown" },
      {
        id: "tab",
        kind: "scratch",
        scratchId: scratchId(),
        color: "teal",
      },
      {
        id: "tab",
        kind: "scratch",
        scratchId: scratchId(),
        mode: "preview",
      },
    ]) {
      const profile = validProfile()
      profile.tabs = [tab]
      profile.activeTab = "tab"
      expectSchemaError(profile)
    }
  })

  it("normalizes bounded display strings and rejects empty/control values", () => {
    for (const name of [
      "",
      "   ",
      "bad\nname",
      "x".repeat(MAX_PROFILE_NAME_LENGTH + 1),
    ]) {
      const profile = validProfile()
      profile.name = name
      expectSchemaError(profile, "profile.name")
    }

    for (const title of [
      "",
      "bad\ttitle",
      "x".repeat(MAX_PROFILE_TAB_TITLE_LENGTH + 1),
    ]) {
      const profile = validProfile()
      profile.tabs = [
        { id: "tab", kind: "scratch", scratchId: scratchId(), title },
      ]
      profile.activeTab = "tab"
      expectSchemaError(profile, "profile.tabs[0].title")
    }
  })

  it("rejects invalid and overlong file paths", () => {
    for (const filePath of [
      "",
      "bad\0path",
      "x".repeat(MAX_PROFILE_PATH_LENGTH + 1),
      "file://%",
    ]) {
      const profile = validProfile()
      profile.tabs = [{ id: "file", kind: "file", path: filePath }]
      profile.activeTab = "file"
      expectSchemaError(profile, "profile.tabs[0].path")
    }
  })
})
