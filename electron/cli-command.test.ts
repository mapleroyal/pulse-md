import path from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import {
  MAX_CLI_ARGUMENT_LENGTH,
  MAX_CLI_ARGUMENTS,
  MAX_CLI_SOURCES,
  CliUsageError,
  cliCommandCanRunBeforeApplicationInitialization,
  parseCliCommand,
  type CliUsageErrorCode,
} from "./cli-command"
import { formatCliHelp } from "./cli-help"

const workingDirectory = path.resolve(path.sep, "cli-tests", "cwd")

function parse(arguments_: readonly string[]) {
  return parseCliCommand(arguments_, { workingDirectory })
}

function expectUsage(
  arguments_: readonly string[],
  code?: CliUsageErrorCode
): CliUsageError {
  try {
    parse(arguments_)
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError)
    const usageError = error as CliUsageError
    expect(usageError.exitCategory).toBe("usage")
    if (code !== undefined) {
      expect(usageError.code).toBe(code)
    }
    return usageError
  }
  throw new Error("Expected a CliUsageError")
}

describe("CLI initialization policy", () => {
  it.each([["--help"], ["--version"], ["doctor"]])(
    "allows initialization-independent command %j",
    (...arguments_: string[]) => {
      expect(
        cliCommandCanRunBeforeApplicationInitialization(parse(arguments_))
      ).toBe(true)
    }
  )

  it.each([
    ["profile", "list"],
    ["profile", "show", "writing"],
    ["profile", "export", "writing"],
    ["scratch", "list"],
    ["scratch", "export", "notes"],
    ["scratch", "delete", "notes"],
  ])(
    "waits for migration before store command %j",
    (...arguments_: string[]) => {
      expect(
        cliCommandCanRunBeforeApplicationInitialization(parse(arguments_))
      ).toBe(false)
    }
  )
})

describe("parseCliCommand open", () => {
  it("returns the complete default open command", () => {
    expect(parse([])).toEqual({
      kind: "open",
      windowMode: "new",
      windowPlacement: "active-window",
      wait: false,
      sources: [],
      activeTabIndex: 0,
      tabOptions: [],
      tabVisibility: "inherit",
      mode: "inherit",
    })
    expect(parse(["open"])).toEqual(parse([]))
  })

  it("normalizes ordered, interspersed sources and all presentation options", () => {
    const fileUrlPath = path.join(workingDirectory, "URL file.md")

    expect(
      parse([
        "open",
        "first.md",
        "--blank",
        "2",
        "--scratch=work-notes",
        "-",
        "--stdin-name",
        "Piped notes",
        "--ephemeral",
        "1",
        pathToFileURL(fileUrlPath).href,
        "--active=7",
        "--goto",
        "42:9",
        "--tab-goto=2:4",
        "--tabs",
        "formatting-bar",
        "--mode=source",
        "--tab-mode",
        "2:live",
        "--wait",
        "--reuse-window",
      ])
    ).toEqual({
      kind: "open",
      windowMode: "reuse",
      windowPlacement: "active-window",
      wait: true,
      sources: [
        { kind: "file", filePath: path.join(workingDirectory, "first.md") },
        { kind: "untitled" },
        { kind: "untitled" },
        { kind: "scratch", id: "work-notes" },
        { kind: "stdin", name: "Piped notes" },
        { kind: "ephemeral" },
        { kind: "file", filePath: fileUrlPath },
      ],
      activeTabIndex: 6,
      tabOptions: [
        {
          tabIndex: 1,
          location: { line: 4 },
          mode: "live",
        },
        { tabIndex: 6, location: { line: 42, column: 9 } },
      ],
      tabVisibility: "formatting-bar",
      mode: "source",
    })
  })

  it.each(["FILE:", "FiLe:"])(
    "accepts the case-insensitive %s URL scheme",
    (scheme) => {
      const filePath = path.join(workingDirectory, "mixed scheme.md")
      const fileUrl = pathToFileURL(filePath).href.replace(/^file:/u, scheme)

      expect(parse([fileUrl])).toMatchObject({
        sources: [{ kind: "file", filePath }],
      })
    }
  )

  it("supports every tabs visibility and editor mode value", () => {
    for (const tabVisibility of [
      "inherit",
      "always",
      "multiple-tabs",
      "mouseover",
      "formatting-bar",
      "hidden",
    ]) {
      expect(parse(["--tabs", tabVisibility])).toMatchObject({ tabVisibility })
    }
    for (const mode of ["inherit", "live", "source"]) {
      expect(parse(["--mode", mode])).toMatchObject({ mode })
    }
    for (const mode of ["live", "source"]) {
      expect(parse(["--tab-mode", `1:${mode}`])).toMatchObject({
        tabOptions: [{ tabIndex: 0, mode }],
      })
    }
  })

  it("uses one-based CLI locations and a zero-based normalized active index", () => {
    expect(parse(["--blank", "3", "--active", "2", "-g", "8"])).toMatchObject({
      activeTabIndex: 1,
      tabOptions: [{ tabIndex: 1, location: { line: 8 } }],
    })
  })

  it("targets modes and cursor positions independently by requested tab", () => {
    expect(
      parse([
        "--tab-mode=3:live",
        "left.md",
        "--ephemeral",
        "1",
        "right.md",
        "--active",
        "2",
        "--tab-mode",
        "2:source",
        "--tab-goto",
        "1:18:4",
        "--tab-goto=3:9",
      ])
    ).toMatchObject({
      activeTabIndex: 1,
      tabOptions: [
        { tabIndex: 0, location: { line: 18, column: 4 } },
        { tabIndex: 1, mode: "source" },
        { tabIndex: 2, location: { line: 9 }, mode: "live" },
      ],
    })
  })

  it("supports the documented short window and wait flags", () => {
    expect(parse(["-n", "-w", "notes.md"])).toMatchObject({
      windowMode: "new",
      wait: true,
    })
    expect(parse(["-r", "notes.md"])).toMatchObject({
      windowMode: "reuse",
      wait: false,
    })
  })

  it("uses the active-window monitor by default and accepts the pointer-monitor override", () => {
    expect(parse(["notes.md"])).toMatchObject({
      windowPlacement: "active-window",
    })
    expect(parse(["--mouse-monitor", "notes.md"])).toMatchObject({
      windowPlacement: "mouse",
    })
    expectUsage(["--mouse-monitor", "--mouse-monitor"], "duplicate-option")
  })

  it("treats option-looking operands after -- as paths while retaining - as stdin", () => {
    expect(parse(["--", "-notes.md", "-"])).toMatchObject({
      sources: [
        { kind: "file", filePath: path.join(workingDirectory, "-notes.md") },
        { kind: "stdin" },
      ],
    })
  })

  it("allows a missing path because creation is deferred until Save", () => {
    expect(parse(["not-created-yet.md"])).toMatchObject({
      sources: [
        {
          kind: "file",
          filePath: path.join(workingDirectory, "not-created-yet.md"),
        },
      ],
    })
  })

  it("normalizes --profile to the profile-open command", () => {
    expect(parse(["--profile", "quick-notes", "--wait"])).toEqual({
      kind: "profile-open",
      id: "quick-notes",
      wait: true,
      windowPlacement: "active-window",
    })
    expect(
      parse(["--profile", "quick-notes", "--mouse-monitor"])
    ).toMatchObject({ windowPlacement: "mouse" })
  })

  it("opens the app picker when --profile has no id", () => {
    expect(parse(["--profile"])).toEqual({
      kind: "profile-pick",
      wait: false,
      windowPlacement: "active-window",
    })
    expect(parse(["--profile", "--wait", "--mouse-monitor"])).toEqual({
      kind: "profile-pick",
      wait: true,
      windowPlacement: "mouse",
    })
  })

  it.each([
    [["--unknown"], "unknown-option"],
    [["--blank"], "missing-option-value"],
    [["--blank="], "missing-option-value"],
    [["--blank", "0"], "invalid-option-value"],
    [["--blank", "1.5"], "invalid-option-value"],
    [["--blank", String(MAX_CLI_SOURCES + 1)], "invalid-option-value"],
    [["--goto", "0"], "invalid-option-value"],
    [["--goto", "3:0"], "invalid-option-value"],
    [["--goto", "line"], "invalid-option-value"],
    [["--tab-goto", "1"], "invalid-option-value"],
    [["--tab-goto", "0:1"], "invalid-option-value"],
    [["--tab-goto", "1:0"], "invalid-option-value"],
    [["--tab-goto", "2:1"], "invalid-option-value"],
    [["--tabs", "sometimes"], "invalid-option-value"],
    [["--mode", "wysiwyg"], "invalid-option-value"],
    [["--tab-mode", "1"], "invalid-option-value"],
    [["--tab-mode", "0:live"], "invalid-option-value"],
    [["--tab-mode", "1:inherit"], "invalid-option-value"],
    [["--tab-mode", "1:preview"], "invalid-option-value"],
    [["--tab-mode", "2:live"], "invalid-option-value"],
    [["--scratch", "Not_A_Slug"], "invalid-option-value"],
    [["--stdin-name", "bad\nname", "-"], "invalid-option-value"],
    [["--stdin-name", "notes"], "conflicting-options"],
    [["-", "-"], "conflicting-options"],
    [["--active", "2"], "invalid-option-value"],
    [["--blank", "1", "--active", "2"], "invalid-option-value"],
    [["--new-window", "--reuse-window"], "conflicting-options"],
    [["--wait", "--wait"], "duplicate-option"],
    [["--tabs=always", "--tabs=hidden"], "duplicate-option"],
    [["--tab-mode", "1:live", "--tab-mode", "1:source"], "duplicate-option"],
    [["--tab-goto", "1:2", "--tab-goto", "1:3"], "duplicate-option"],
    [["--goto", "2", "--tab-goto", "1:3"], "conflicting-options"],
    [["--scratch", "notes", "--scratch", "notes"], "duplicate-option"],
    [["--wait=yes"], "unexpected-option-value"],
    [["file://%"], "invalid-path"],
    [["bad\0path"], "invalid-path"],
  ] as const)("classifies invalid open argv %j as %s", (arguments_, code) => {
    expectUsage(arguments_, code)
  })

  it("caps the total source count across different source forms", () => {
    const arguments_ = ["--blank", String(MAX_CLI_SOURCES), "extra.md"]
    expectUsage(arguments_, "too-many-sources")
  })

  it("caps raw argument counts and lengths before parsing", () => {
    expectUsage(
      Array.from({ length: MAX_CLI_ARGUMENTS + 1 }, () => "file.md"),
      "too-many-arguments"
    )
    expectUsage(["x".repeat(MAX_CLI_ARGUMENT_LENGTH + 1)], "argument-too-long")
  })

  it("keeps profile opening mutually exclusive with direct and override inputs", () => {
    for (const arguments_ of [
      ["--profile", "notes", "file.md"],
      ["--profile", "notes", "--blank", "1"],
      ["--profile", "notes", "--scratch", "scratch"],
      ["--profile", "notes", "-"],
      ["--profile", "notes", "--active", "1"],
      ["--profile", "notes", "--mode", "source"],
      ["--profile", "notes", "--tab-mode", "1:source"],
      ["--profile", "notes", "--tab-goto", "1:4"],
      ["--profile", "notes", "--reuse-window"],
    ]) {
      expectUsage(arguments_, "conflicting-options")
    }
  })

  it("requires an absolute invocation cwd", () => {
    expect(() =>
      parseCliCommand(["notes.md"], { workingDirectory: "relative" })
    ).toThrow("CLI working directory must be absolute")
  })

  it("explains the cross-platform reserved-name restriction", () => {
    expect(
      expectUsage(["--scratch", "con"], "invalid-option-value").message
    ).toContain("reserved Windows device name")
  })
})

describe("parseCliCommand profile", () => {
  it("parses profile open, list, and show", () => {
    expect(parse(["profile", "open", "--wait"])).toEqual({
      kind: "profile-pick",
      wait: true,
      windowPlacement: "active-window",
    })
    expect(parse(["profile", "open", "--wait", "daily-notes"])).toEqual({
      kind: "profile-open",
      id: "daily-notes",
      wait: true,
      windowPlacement: "active-window",
    })
    expect(
      parse(["profile", "open", "daily-notes", "--mouse-monitor"])
    ).toMatchObject({ windowPlacement: "mouse" })
    expect(parse(["profile", "list"])).toEqual({
      kind: "profile-list",
      json: false,
    })
    expect(parse(["profile", "list", "--json"])).toEqual({
      kind: "profile-list",
      json: true,
    })
    expect(parse(["profile", "show", "daily-notes"])).toEqual({
      kind: "profile-show",
      id: "daily-notes",
    })
  })

  it("parses import with explicit cwd-based and file-URL paths", () => {
    expect(
      parse(["profile", "import", "profiles/work.json", "--replace"])
    ).toEqual({
      kind: "profile-import",
      filePath: path.join(workingDirectory, "profiles", "work.json"),
      replace: true,
    })

    const importPath = path.join(workingDirectory, "profile with spaces.json")
    expect(
      parse(["profile", "import", pathToFileURL(importPath).href])
    ).toMatchObject({ filePath: importPath, replace: false })
  })

  it("parses stdout and file export destinations", () => {
    expect(parse(["profile", "export", "notes"])).toEqual({
      kind: "profile-export",
      id: "notes",
      destination: { kind: "stdout" },
      replace: false,
    })
    expect(parse(["profile", "export", "notes", "-"])).toEqual(
      parse(["profile", "export", "notes"])
    )
    expect(parse(["profile", "export", "notes", "exports/notes.json"])).toEqual(
      {
        kind: "profile-export",
        id: "notes",
        destination: {
          kind: "file",
          filePath: path.join(workingDirectory, "exports", "notes.json"),
        },
        replace: false,
      }
    )
    expect(
      parse(["profile", "export", "notes", "exports/notes.json", "--replace"])
    ).toMatchObject({ replace: true })
    expect(() => parse(["profile", "export", "notes", "--replace"])).toThrow(
      "requires a profile export file destination"
    )
  })

  it("supports -- for dash-leading profile paths", () => {
    expect(
      parse(["profile", "export", "notes", "--", "-profile.json"])
    ).toMatchObject({
      destination: {
        kind: "file",
        filePath: path.join(workingDirectory, "-profile.json"),
      },
    })
  })

  it("deletes a profile independently of its scratch references", () => {
    expect(parse(["profile", "delete", "notes"])).toEqual({
      kind: "profile-delete",
      id: "notes",
    })
    expectUsage(
      ["profile", "delete", "notes", "--delete-scratch"],
      "unknown-option"
    )
    expectUsage(
      ["profile", "delete", "notes", "--export-scratch", "archive"],
      "unknown-option"
    )
  })

  it.each([
    [["profile"], "missing-argument"],
    [["profile", "unknown"], "unexpected-argument"],
    [["profile", "open", "UPPER"], "invalid-option-value"],
    [["profile", "open", "notes", "extra"], "unexpected-argument"],
    [["profile", "open", "notes", "--json"], "unknown-option"],
    [["profile", "list", "notes"], "unexpected-argument"],
    [["profile", "show"], "missing-argument"],
    [["profile", "import", "-"], "invalid-path"],
    [["profile", "import", "a", "b"], "unexpected-argument"],
    [["profile", "export"], "missing-argument"],
    [["profile", "export", "id", "a", "b"], "unexpected-argument"],
    [["profile", "delete", "id", "extra"], "unexpected-argument"],
  ] as const)(
    "classifies invalid profile argv %j as %s",
    (arguments_, code) => {
      expectUsage(arguments_, code)
    }
  )
})

describe("parseCliCommand scratch", () => {
  it("normalizes scratch open to the ordinary singleton open path", () => {
    expect(parse(["scratch", "open", "work-notes"])).toEqual(
      parse(["--scratch", "work-notes"])
    )
    expect(parse(["scratch", "open", "work-notes", "--wait"])).toEqual(
      parse(["--scratch", "work-notes", "--wait"])
    )
    expect(parse(["scratch", "open", "work-notes", "--mouse-monitor"])).toEqual(
      parse(["--scratch", "work-notes", "--mouse-monitor"])
    )

    const scratchId = "019fe216-2b96-7511-8cf4-a35483924181"
    expect(parse(["scratch", "open", scratchId])).toEqual(
      parse(["--scratch", scratchId])
    )
  })

  it("parses plain and JSON scratch listings", () => {
    expect(parse(["scratch", "list"])).toEqual({
      kind: "scratch-list",
      json: false,
    })
    expect(parse(["scratch", "list", "--json"])).toEqual({
      kind: "scratch-list",
      json: true,
    })
  })

  it("parses stdout and non-overwriting file exports", () => {
    expect(parse(["scratch", "export", "work-notes"])).toEqual({
      kind: "scratch-export",
      id: "work-notes",
      destination: { kind: "stdout" },
    })
    expect(parse(["scratch", "export", "work-notes", "-"])).toEqual(
      parse(["scratch", "export", "work-notes"])
    )
    expect(
      parse(["scratch", "export", "work-notes", "exports/notes.md"])
    ).toEqual({
      kind: "scratch-export",
      id: "work-notes",
      destination: {
        kind: "file",
        filePath: path.join(workingDirectory, "exports", "notes.md"),
      },
    })
  })

  it("supports a dash-leading export path after --", () => {
    expect(
      parse(["scratch", "export", "work-notes", "--", "-notes.md"])
    ).toMatchObject({
      destination: {
        kind: "file",
        filePath: path.join(workingDirectory, "-notes.md"),
      },
    })
  })

  it("parses deletion as an explicit single-id operation", () => {
    expect(parse(["scratch", "delete", "work-notes"])).toEqual({
      kind: "scratch-delete",
      id: "work-notes",
    })
  })

  it.each([
    [["scratch"], "missing-argument"],
    [["scratch", "unknown"], "unexpected-argument"],
    [["scratch", "open"], "missing-argument"],
    [["scratch", "open", "Not_Valid"], "invalid-option-value"],
    [["scratch", "open", "notes", "extra"], "unexpected-argument"],
    [["scratch", "open", "notes", "--json"], "unknown-option"],
    [["scratch", "list", "notes"], "unexpected-argument"],
    [["scratch", "list", "--json", "--json"], "duplicate-option"],
    [["scratch", "export"], "missing-argument"],
    [["scratch", "export", "Not_Valid"], "invalid-option-value"],
    [["scratch", "export", "notes", "a", "b"], "unexpected-argument"],
    [["scratch", "delete"], "missing-argument"],
    [["scratch", "delete", "notes", "extra"], "unexpected-argument"],
  ] as const)(
    "classifies invalid scratch argv %j as %s",
    (arguments_, code) => {
      expectUsage(arguments_, code)
    }
  )
})

describe("formatCliHelp standalone scratches", () => {
  it("documents profile references without profile-owned deletion flags", () => {
    expect(formatCliHelp("general")).toContain("pmd profile delete ID")
    expect(formatCliHelp("profile")).toContain('"version": 2')
    expect(formatCliHelp("profile")).toContain('"scratchId"')
    expect(formatCliHelp("profile-delete")).toContain(
      "Standalone scratches referenced by it are unchanged."
    )
    expect(formatCliHelp("general")).not.toContain("--delete-scratch")
    expect(formatCliHelp("profile")).not.toContain("--export-scratch")
    expect(formatCliHelp("profile")).not.toContain('"version": 1')
  })

  it("renders an isolated command name throughout help", () => {
    expect(formatCliHelp("general", "pmd-custom")).toContain(
      "pmd-custom profile delete ID"
    )
    expect(formatCliHelp("general", "pmd-custom")).not.toMatch(
      /(^|\s)pmd(?=\s|$)/
    )
  })
})

describe("parseCliCommand metadata commands", () => {
  it.each([
    [["--help"], "general"],
    [["-h"], "general"],
    [["help"], "general"],
    [["open", "--help"], "open"],
    [["help", "open"], "open"],
    [["profile", "--help"], "profile"],
    [["help", "profile"], "profile"],
    [["profile", "open", "--help"], "profile-open"],
    [["profile", "list", "--help"], "profile-list"],
    [["profile", "show", "--help"], "profile-show"],
    [["profile", "import", "--help"], "profile-import"],
    [["profile", "export", "--help"], "profile-export"],
    [["profile", "delete", "--help"], "profile-delete"],
    [["help", "profile", "delete"], "profile-delete"],
    [["scratch", "--help"], "scratch"],
    [["help", "scratch"], "scratch"],
    [["scratch", "open", "--help"], "scratch-open"],
    [["scratch", "list", "--help"], "scratch-list"],
    [["scratch", "export", "--help"], "scratch-export"],
    [["scratch", "delete", "--help"], "scratch-delete"],
    [["help", "scratch", "export"], "scratch-export"],
    [["doctor", "--help"], "doctor"],
    [["open", "file.md", "--help"], "open"],
    [["profile", "open", "daily-notes", "--help"], "profile-open"],
    [["profile", "open", "daily-notes", "-h"], "profile-open"],
    [["scratch", "export", "work-notes", "--help"], "scratch-export"],
    [["help", "profile", "delete", "--help"], "profile-delete"],
  ] as const)("returns typed help for %j", (arguments_, topic) => {
    expect(parse(arguments_)).toEqual({ kind: "help", topic })
  })

  it("returns typed version and doctor commands", () => {
    expect(parse(["--version"])).toEqual({ kind: "version" })
    expect(parse(["-V"])).toEqual({ kind: "version" })
    expect(parse(["open", "file.md", "--version"])).toEqual({
      kind: "version",
    })
    expect(parse(["profile", "show", "daily-notes", "-V"])).toEqual({
      kind: "version",
    })
    expect(parse(["doctor"])).toEqual({ kind: "doctor" })
  })

  it("keeps metadata flags global before -- and literal after it", () => {
    expect(parse(["--version", "extra"])).toEqual({ kind: "version" })
    expect(parse(["--", "--help"])).toMatchObject({
      kind: "open",
      sources: [
        { kind: "file", filePath: path.join(workingDirectory, "--help") },
      ],
    })
    expect(parse(["open", "--", "--version"])).toMatchObject({
      kind: "open",
      sources: [
        { kind: "file", filePath: path.join(workingDirectory, "--version") },
      ],
    })
  })

  it("does not turn unrelated command errors into metadata output", () => {
    expectUsage(["doctor", "--unknown"], "unknown-option")
    expectUsage(["help", "unknown"], "unexpected-argument")
  })
})
