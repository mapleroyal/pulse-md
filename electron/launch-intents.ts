import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  parseScratchLinkAddress,
  type ScratchLinkScheme,
} from "../src/shared/scratch-links"

export type LaunchIntent =
  | {
      kind: "new-window"
      filePaths: string[]
    }
  | {
      kind: "open-scratch"
      fragment: string | null
      scratchId: string
    }

export interface ParseLaunchIntentOptions {
  expectedScratchLinkScheme?: ScratchLinkScheme
  isPackaged: boolean
  workingDirectory: string
}

export interface StartupLaunchSelection {
  readonly pendingIntents: LaunchIntent[]
  readonly startupIntent: LaunchIntent
}

/**
 * Promotes a queued macOS open-url event over an otherwise empty ordinary
 * launch so startup does not create a blank window before opening the scratch.
 */
export function selectStartupLaunchIntent(
  initialIntent: LaunchIntent,
  pendingIntents: readonly LaunchIntent[]
): StartupLaunchSelection {
  if (
    initialIntent.kind !== "new-window" ||
    initialIntent.filePaths.length !== 0
  ) {
    return {
      pendingIntents: [...pendingIntents],
      startupIntent: initialIntent,
    }
  }
  const scratchIndex = pendingIntents.findIndex(
    (intent) => intent.kind === "open-scratch"
  )
  if (scratchIndex < 0) {
    return {
      pendingIntents: [...pendingIntents],
      startupIntent: initialIntent,
    }
  }
  return {
    pendingIntents: pendingIntents.filter((_intent, index) => {
      return index !== scratchIndex
    }),
    startupIntent: pendingIntents[scratchIndex]!,
  }
}

function launchArguments(
  argv: readonly string[],
  isPackaged: boolean
): readonly string[] {
  return argv.slice(isPackaged ? 1 : 2)
}

function resolveLaunchPath(argument: string, workingDirectory: string): string {
  if (argument.startsWith("file://")) {
    return path.resolve(fileURLToPath(argument))
  }

  return path.resolve(workingDirectory, argument)
}

/**
 * Parses argv from either the primary process or Electron's second-instance
 * event. The caller supplies that invocation's working directory so relative
 * paths never inherit the primary process's cwd accidentally.
 */
export function parseLaunchIntent(
  argv: readonly string[],
  options: ParseLaunchIntentOptions
): LaunchIntent {
  if (!path.isAbsolute(options.workingDirectory)) {
    throw new TypeError("Launch working directory must be absolute")
  }

  const arguments_ = launchArguments(argv, options.isPackaged).filter(
    (argument) =>
      argument.length > 0 &&
      argument !== "--new-window" &&
      !argument.startsWith("-")
  )
  const scratchArguments = arguments_.filter((argument) =>
    /^pulse-md(?:-local|-development)?:/i.test(argument)
  )
  if (scratchArguments.length > 0) {
    if (arguments_.length !== 1 || scratchArguments.length !== 1) {
      throw new TypeError(
        "A Pulse MD scratch link cannot be combined with file paths"
      )
    }
    const parsed = parseScratchLinkAddress(scratchArguments[0]!)
    if (!parsed) throw new TypeError("The Pulse MD scratch link is invalid")
    if (
      options.expectedScratchLinkScheme !== undefined &&
      parsed.scheme !== options.expectedScratchLinkScheme
    ) {
      throw new TypeError(
        `The ${parsed.scheme} scratch link belongs to another Pulse MD channel`
      )
    }
    return {
      kind: "open-scratch",
      fragment: parsed.fragment,
      scratchId: parsed.identity.scratchId,
    }
  }

  const filePaths = arguments_.map((argument) =>
    resolveLaunchPath(argument, options.workingDirectory)
  )

  return { kind: "new-window", filePaths }
}

/**
 * Validates the exact object passed through requestSingleInstanceLock's
 * additionalData. Invalid data is rejected instead of being reinterpreted as
 * argv or another historical shape.
 */
export function parseLaunchIntentAdditionalData(value: unknown): LaunchIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Launch intent additional data must be an object")
  }

  const candidate = value as Record<string, unknown>
  const keys = Object.keys(value)
  if (
    keys.length === 3 &&
    keys.includes("kind") &&
    keys.includes("fragment") &&
    keys.includes("scratchId") &&
    candidate.kind === "open-scratch" &&
    (candidate.fragment === null || typeof candidate.fragment === "string") &&
    typeof candidate.scratchId === "string"
  ) {
    const parsed = parseScratchLinkAddress(
      `pulse-md://scratch/${encodeURIComponent(candidate.scratchId)}${
        candidate.fragment === null
          ? ""
          : `#${encodeURIComponent(candidate.fragment)}`
      }`
    )
    if (!parsed) throw new TypeError("Invalid launch intent additional data")
    return {
      kind: "open-scratch",
      fragment: parsed.fragment,
      scratchId: parsed.identity.scratchId,
    }
  }
  if (
    keys.length !== 2 ||
    !keys.includes("kind") ||
    !keys.includes("filePaths") ||
    candidate.kind !== "new-window" ||
    !Array.isArray(candidate.filePaths) ||
    !candidate.filePaths.every(
      (filePath) =>
        typeof filePath === "string" &&
        filePath.length > 0 &&
        path.isAbsolute(filePath)
    )
  ) {
    throw new TypeError("Invalid launch intent additional data")
  }

  return {
    kind: "new-window",
    filePaths: [...candidate.filePaths] as string[],
  }
}
