import path from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import {
  parseLaunchIntent,
  parseLaunchIntentAdditionalData,
  selectStartupLaunchIntent,
  type LaunchIntent,
} from "./launch-intents"

const workingDirectory = path.resolve(path.sep, "launch-intent-tests", "cwd")
const executablePath = path.resolve(path.sep, "Applications", "Markdown")
const scratchId = "11111111-1111-4111-8111-111111111111"

describe("parseLaunchIntent", () => {
  it("uses the packaged argv offset and ignores switches", () => {
    expect(
      parseLaunchIntent(
        [
          executablePath,
          "--new-window",
          "--user-data-dir=/tmp/profile",
          "notes/one.md",
          "-psn_0_12345",
          "",
        ],
        {
          expectedScratchLinkScheme: "pulse-md",
          isPackaged: true,
          workingDirectory,
        }
      )
    ).toEqual({
      kind: "new-window",
      filePaths: [path.join(workingDirectory, "notes", "one.md")],
    })
  })

  it("keeps operating-system scratch launches in their app channel", () => {
    expect(
      parseLaunchIntent(
        [
          executablePath,
          path.resolve(path.sep, "projects", "pulse-md"),
          `pulse-md-development://scratch/${scratchId}#Dev`,
        ],
        {
          expectedScratchLinkScheme: "pulse-md-development",
          isPackaged: false,
          workingDirectory,
        }
      )
    ).toMatchObject({ kind: "open-scratch", scratchId })
    expect(() =>
      parseLaunchIntent([executablePath, `pulse-md://scratch/${scratchId}`], {
        expectedScratchLinkScheme: "pulse-md-development",
        isPackaged: true,
        workingDirectory,
      })
    ).toThrow(/belongs to another Pulse MD channel/)
  })

  it("uses the development argv offset", () => {
    const appEntry = path.resolve(path.sep, "projects", "pulse-md")

    expect(
      parseLaunchIntent(
        [executablePath, appEntry, "draft.md", "--new-window"],
        { isPackaged: false, workingDirectory }
      )
    ).toEqual({
      kind: "new-window",
      filePaths: [path.join(workingDirectory, "draft.md")],
    })
  })

  it("resolves secondary-instance relative paths against its explicit cwd", () => {
    const secondaryWorkingDirectory = path.resolve(
      path.sep,
      "another-shell",
      "cwd"
    )

    expect(
      parseLaunchIntent([executablePath, "relative.md"], {
        isPackaged: true,
        workingDirectory: secondaryWorkingDirectory,
      })
    ).toEqual({
      kind: "new-window",
      filePaths: [path.join(secondaryWorkingDirectory, "relative.md")],
    })
  })

  it("decodes file URLs and preserves argument order", () => {
    const firstPath = path.join(workingDirectory, "first file.md")
    const secondPath = path.join(workingDirectory, "second.md")
    const mixedCaseFileUrl = pathToFileURL(firstPath).href.replace(
      /^file:/u,
      "FiLe:"
    )

    expect(
      parseLaunchIntent(
        [
          executablePath,
          mixedCaseFileUrl,
          path.relative(workingDirectory, secondPath),
        ],
        { isPackaged: true, workingDirectory }
      )
    ).toEqual({
      kind: "new-window",
      filePaths: [firstPath, secondPath],
    })
  })

  it("returns an empty new-window request when no files are present", () => {
    expect(
      parseLaunchIntent([executablePath, "--new-window"], {
        isPackaged: true,
        workingDirectory,
      })
    ).toEqual({ kind: "new-window", filePaths: [] })
  })

  it("parses an operating-system scratch URL launch", () => {
    expect(
      parseLaunchIntent(
        [
          executablePath,
          `pulse-md://scratch/${scratchId}#Today%20%26%20Tomorrow`,
        ],
        { isPackaged: true, workingDirectory }
      )
    ).toEqual({
      kind: "open-scratch",
      fragment: "Today & Tomorrow",
      scratchId,
    })
  })

  it("rejects malformed or mixed scratch URL launches", () => {
    expect(() =>
      parseLaunchIntent([executablePath, "pulse-md://scratch/a", "notes.md"], {
        isPackaged: true,
        workingDirectory,
      })
    ).toThrow("cannot be combined")
    expect(() =>
      parseLaunchIntent([executablePath, "pulse-md://scratch/a/b"], {
        isPackaged: true,
        workingDirectory,
      })
    ).toThrow("scratch link is invalid")
  })

  it("requires an absolute working directory", () => {
    expect(() =>
      parseLaunchIntent([executablePath, "document.md"], {
        isPackaged: true,
        workingDirectory: "relative/cwd",
      })
    ).toThrow("Launch working directory must be absolute")
  })
})

describe("parseLaunchIntentAdditionalData", () => {
  it("accepts and clones the exact structured launch intent", () => {
    const filePaths = [path.join(workingDirectory, "document.md")]
    const additionalData = { kind: "new-window", filePaths }
    const parsed = parseLaunchIntentAdditionalData(additionalData)

    expect(parsed).toEqual(additionalData)
    expect(parsed).not.toBe(additionalData)
    expect(parsed.kind).toBe("new-window")
    if (parsed.kind !== "new-window") throw new Error("Unexpected intent")
    expect(parsed.filePaths).not.toBe(filePaths)
  })

  it("accepts a structured scratch launch intent", () => {
    expect(
      parseLaunchIntentAdditionalData({
        kind: "open-scratch",
        fragment: "heading",
        scratchId,
      })
    ).toEqual({
      kind: "open-scratch",
      fragment: "heading",
      scratchId,
    })
  })

  it.each([
    null,
    [],
    {},
    { kind: "open-files", filePaths: [] },
    { kind: "new-window" },
    { kind: "new-window", filePaths: "document.md" },
    { kind: "new-window", filePaths: ["relative.md"] },
    { kind: "new-window", filePaths: [""] },
    { kind: "new-window", filePaths: [42] },
    { kind: "new-window", filePaths: [], argv: [] },
    { launchIntent: { kind: "new-window", filePaths: [] } },
  ])("rejects invalid or alternate additionalData shapes: %j", (value) => {
    expect(() => parseLaunchIntentAdditionalData(value)).toThrow(TypeError)
  })
})

describe("selectStartupLaunchIntent", () => {
  it("promotes the first queued scratch over an empty ordinary launch", () => {
    const queuedWindow: LaunchIntent = {
      kind: "new-window",
      filePaths: [path.join(workingDirectory, "queued.md")],
    }
    const queuedScratch: LaunchIntent = {
      kind: "open-scratch",
      fragment: "heading",
      scratchId,
    }

    expect(
      selectStartupLaunchIntent({ kind: "new-window", filePaths: [] }, [
        queuedWindow,
        queuedScratch,
      ])
    ).toEqual({
      pendingIntents: [queuedWindow],
      startupIntent: queuedScratch,
    })
  })

  it("preserves queued intents when the original launch has work", () => {
    const queuedScratch: LaunchIntent = {
      kind: "open-scratch",
      fragment: null,
      scratchId,
    }
    const initial: LaunchIntent = {
      kind: "new-window",
      filePaths: [path.join(workingDirectory, "initial.md")],
    }

    expect(selectStartupLaunchIntent(initial, [queuedScratch])).toEqual({
      pendingIntents: [queuedScratch],
      startupIntent: initial,
    })
  })
})
