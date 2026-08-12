import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  isProfileIdentifier,
  MAX_PROFILE_ID_LENGTH,
} from "../src/shared/profile-identifiers"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"

export { isProfileIdentifier, MAX_PROFILE_ID_LENGTH }

export const PROFILE_SCHEMA_VERSION = 2 as const
export const MAX_PROFILE_TABS = 100
export const MAX_PROFILE_NAME_LENGTH = 128
export const MAX_PROFILE_TAB_TITLE_LENGTH = 128
export const MAX_PROFILE_PATH_LENGTH = 4_096

export const PROFILE_TAB_VISIBILITIES = [
  "inherit",
  "always",
  "multiple-tabs",
  "mouseover",
  "formatting-bar",
  "hidden",
] as const
export type ProfileTabVisibility = (typeof PROFILE_TAB_VISIBILITIES)[number]

export const PROFILE_EDITOR_MODES = ["live", "source"] as const
export type ProfileEditorMode = (typeof PROFILE_EDITOR_MODES)[number]

export const PROFILE_TAB_KINDS = [
  "file",
  "untitled",
  "ephemeral",
  "scratch",
] as const
export type ProfileTabKind = (typeof PROFILE_TAB_KINDS)[number]

export const PROFILE_TAB_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
] as const
export type ProfileTabColor = (typeof PROFILE_TAB_COLORS)[number]

interface ProfileTabBase {
  readonly id: string
  readonly title?: string
  readonly color?: ProfileTabColor
  readonly mode?: ProfileEditorMode
}

export interface FileProfileTab extends ProfileTabBase {
  readonly kind: "file"
  readonly path: string
}

export interface UntitledProfileTab extends ProfileTabBase {
  readonly kind: "untitled"
}

export interface EphemeralProfileTab extends ProfileTabBase {
  readonly kind: "ephemeral"
}

export interface ScratchProfileTab extends ProfileTabBase {
  readonly kind: "scratch"
  readonly scratchId: string
}

export type ProfileTab =
  FileProfileTab | UntitledProfileTab | EphemeralProfileTab | ScratchProfileTab

export interface ProfileSchemaV2 {
  readonly version: typeof PROFILE_SCHEMA_VERSION
  readonly id: string
  readonly name: string
  readonly activeTab: string
  readonly tabVisibility: ProfileTabVisibility
  readonly mode?: ProfileEditorMode
  readonly tabs: readonly ProfileTab[]
}

export interface NormalizeProfileSchemaOptions {
  /** The absolute directory containing the imported profile document. */
  readonly sourceDirectory: string
}

export class ProfileSchemaError extends TypeError {
  readonly schemaPath: string

  constructor(schemaPath: string, message: string) {
    super(`${schemaPath}: ${message}`)
    this.name = "ProfileSchemaError"
    this.schemaPath = schemaPath
  }
}

type UnknownRecord = Record<string, unknown>

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, schemaPath: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new ProfileSchemaError(schemaPath, "must be an object")
  }
  return value
}

function assertExactKeys(
  value: UnknownRecord,
  schemaPath: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): void {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknownKey !== undefined) {
    throw new ProfileSchemaError(
      `${schemaPath}.${unknownKey}`,
      "is not a supported property"
    )
  }

  const missingKey = requiredKeys.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key)
  )
  if (missingKey !== undefined) {
    throw new ProfileSchemaError(`${schemaPath}.${missingKey}`, "is required")
  }
}

function normalizeIdentifier(value: unknown, schemaPath: string): string {
  if (!isProfileIdentifier(value)) {
    throw new ProfileSchemaError(
      schemaPath,
      `must be a lowercase hyphenated identifier of at most ${MAX_PROFILE_ID_LENGTH} characters and not a reserved Windows device name`
    )
  }
  return value
}

function normalizeDisplayString(
  value: unknown,
  schemaPath: string,
  maximumLength: number
): string {
  if (typeof value !== "string") {
    throw new ProfileSchemaError(schemaPath, "must be a string")
  }

  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new ProfileSchemaError(
      schemaPath,
      `must contain 1 to ${maximumLength} characters and no control characters`
    )
  }
  return normalized
}

function normalizeEnumValue<const Values extends readonly string[]>(
  value: unknown,
  schemaPath: string,
  values: Values
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ProfileSchemaError(
      schemaPath,
      `must be one of: ${values.join(", ")}`
    )
  }
  return value
}

function normalizeFilePath(
  value: unknown,
  schemaPath: string,
  sourceDirectory: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROFILE_PATH_LENGTH ||
    value.includes("\0")
  ) {
    throw new ProfileSchemaError(
      schemaPath,
      `must be a nonempty path of at most ${MAX_PROFILE_PATH_LENGTH} characters`
    )
  }

  let resolvedPath: string
  try {
    resolvedPath = value.startsWith("file://")
      ? path.resolve(fileURLToPath(value))
      : path.resolve(sourceDirectory, value)
  } catch {
    throw new ProfileSchemaError(schemaPath, "must be a valid file path or URL")
  }

  if (resolvedPath.length > MAX_PROFILE_PATH_LENGTH) {
    throw new ProfileSchemaError(
      schemaPath,
      `resolves to a path longer than ${MAX_PROFILE_PATH_LENGTH} characters`
    )
  }
  return resolvedPath
}

function normalizeScratchId(value: unknown, schemaPath: string): string {
  if (!isScratchIdentifier(value)) {
    throw new ProfileSchemaError(schemaPath, "must be a canonical UUID")
  }
  return value
}

function normalizeProfileTab(
  value: unknown,
  index: number,
  sourceDirectory: string
): ProfileTab {
  const schemaPath = `profile.tabs[${index}]`
  const candidate = assertRecord(value, schemaPath)
  const kind = normalizeEnumValue(
    candidate.kind,
    `${schemaPath}.kind`,
    PROFILE_TAB_KINDS
  )
  const requiredKeys =
    kind === "file"
      ? ["id", "kind", "path"]
      : kind === "scratch"
        ? ["id", "kind", "scratchId"]
        : ["id", "kind"]
  assertExactKeys(candidate, schemaPath, requiredKeys, [
    "title",
    "color",
    "mode",
  ])

  const id = normalizeIdentifier(candidate.id, `${schemaPath}.id`)
  const title = Object.prototype.hasOwnProperty.call(candidate, "title")
    ? normalizeDisplayString(
        candidate.title,
        `${schemaPath}.title`,
        MAX_PROFILE_TAB_TITLE_LENGTH
      )
    : undefined
  const color = Object.prototype.hasOwnProperty.call(candidate, "color")
    ? normalizeEnumValue(
        candidate.color,
        `${schemaPath}.color`,
        PROFILE_TAB_COLORS
      )
    : undefined
  const mode = Object.prototype.hasOwnProperty.call(candidate, "mode")
    ? normalizeEnumValue(
        candidate.mode,
        `${schemaPath}.mode`,
        PROFILE_EDITOR_MODES
      )
    : undefined
  const presentation = {
    ...(title === undefined ? {} : { title }),
    ...(color === undefined ? {} : { color }),
    ...(mode === undefined ? {} : { mode }),
  }

  if (kind === "file") {
    return {
      id,
      kind,
      path: normalizeFilePath(
        candidate.path,
        `${schemaPath}.path`,
        sourceDirectory
      ),
      ...presentation,
    }
  }

  if (kind === "scratch") {
    return {
      id,
      kind,
      scratchId: normalizeScratchId(
        candidate.scratchId,
        `${schemaPath}.scratchId`
      ),
      ...presentation,
    }
  }

  return { id, kind, ...presentation }
}

/**
 * Strictly validates and normalizes a version-2 imported profile. Relative
 * file-tab paths are resolved against the explicitly supplied source directory.
 */
export function normalizeProfileSchema(
  value: unknown,
  options: NormalizeProfileSchemaOptions
): ProfileSchemaV2 {
  if (!path.isAbsolute(options.sourceDirectory)) {
    throw new TypeError("Profile source directory must be absolute")
  }

  const candidate = assertRecord(value, "profile")
  assertExactKeys(
    candidate,
    "profile",
    ["version", "id", "name", "activeTab", "tabVisibility", "tabs"],
    ["mode"]
  )

  if (candidate.version !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileSchemaError(
      "profile.version",
      `must equal ${PROFILE_SCHEMA_VERSION}`
    )
  }
  if (!Array.isArray(candidate.tabs)) {
    throw new ProfileSchemaError("profile.tabs", "must be an array")
  }
  if (candidate.tabs.length === 0 || candidate.tabs.length > MAX_PROFILE_TABS) {
    throw new ProfileSchemaError(
      "profile.tabs",
      `must contain 1 to ${MAX_PROFILE_TABS} tabs`
    )
  }

  const profileId = normalizeIdentifier(candidate.id, "profile.id")
  const tabs = candidate.tabs.map((tab, index) =>
    normalizeProfileTab(tab, index, options.sourceDirectory)
  )
  const seenIds = new Set<string>()
  const seenFilePaths = new Set<string>()
  const seenScratchIds = new Set<string>()
  for (const tab of tabs) {
    if (seenIds.has(tab.id)) {
      throw new ProfileSchemaError(
        "profile.tabs",
        `contains duplicate tab id ${JSON.stringify(tab.id)}`
      )
    }
    seenIds.add(tab.id)
    if (tab.kind === "file") {
      if (seenFilePaths.has(tab.path)) {
        throw new ProfileSchemaError(
          "profile.tabs",
          `contains duplicate file path ${JSON.stringify(tab.path)}`
        )
      }
      seenFilePaths.add(tab.path)
    }
    if (tab.kind === "scratch") {
      if (seenScratchIds.has(tab.scratchId)) {
        throw new ProfileSchemaError(
          "profile.tabs",
          `contains duplicate scratch id ${JSON.stringify(tab.scratchId)}`
        )
      }
      seenScratchIds.add(tab.scratchId)
    }
  }

  const activeTab = normalizeIdentifier(
    candidate.activeTab,
    "profile.activeTab"
  )
  if (!seenIds.has(activeTab)) {
    throw new ProfileSchemaError(
      "profile.activeTab",
      "must reference one of the profile's tabs"
    )
  }

  const mode = Object.prototype.hasOwnProperty.call(candidate, "mode")
    ? normalizeEnumValue(candidate.mode, "profile.mode", PROFILE_EDITOR_MODES)
    : undefined

  return {
    version: PROFILE_SCHEMA_VERSION,
    id: profileId,
    name: normalizeDisplayString(
      candidate.name,
      "profile.name",
      MAX_PROFILE_NAME_LENGTH
    ),
    activeTab,
    tabVisibility: normalizeEnumValue(
      candidate.tabVisibility,
      "profile.tabVisibility",
      PROFILE_TAB_VISIBILITIES
    ),
    ...(mode === undefined ? {} : { mode }),
    tabs,
  }
}
