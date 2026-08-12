import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_PATH_LENGTH,
  PROFILE_EDITOR_MODES,
  PROFILE_TAB_VISIBILITIES,
  isProfileIdentifier,
  type ProfileEditorMode,
  type ProfileTabVisibility,
} from "./profile-schema"

export const MAX_CLI_SOURCES = 100
export const MAX_CLI_ARGUMENTS = 512
export const MAX_CLI_ARGUMENT_LENGTH = 4_096
export const MAX_CLI_STDIN_NAME_LENGTH = 255
export const MAX_CLI_LOCATION_VALUE = 2_147_483_647

export const CLI_EDITOR_MODES = ["inherit", "live", "source"] as const
export type CliEditorMode = (typeof CLI_EDITOR_MODES)[number]

export type CliWindowMode = "new" | "reuse"
export type CliWindowPlacement = "active-window" | "mouse"

export type CliOpenSource =
  | { readonly kind: "file"; readonly filePath: string }
  | { readonly kind: "untitled" }
  | { readonly kind: "ephemeral" }
  | { readonly kind: "scratch"; readonly id: string }
  | { readonly kind: "stdin"; readonly name?: string }

export interface CliLocation {
  /** One-based line number. */
  readonly line: number
  /** One-based column number. */
  readonly column?: number
}

export interface CliTabOptions {
  /** Zero-based index into requested sources (or the implicit blank source). */
  readonly tabIndex: number
  readonly location?: CliLocation
  readonly mode?: ProfileEditorMode
}

export interface CliOpenCommand {
  readonly kind: "open"
  readonly windowMode: CliWindowMode
  readonly windowPlacement: CliWindowPlacement
  readonly wait: boolean
  readonly sources: readonly CliOpenSource[]
  /** Zero-based index into requested sources (or the implicit blank source). */
  readonly activeTabIndex: number
  readonly tabOptions: readonly CliTabOptions[]
  readonly tabVisibility: ProfileTabVisibility
  readonly mode: CliEditorMode
}

export interface CliProfileOpenCommand {
  readonly kind: "profile-open"
  readonly id: string
  readonly wait: boolean
  readonly windowPlacement: CliWindowPlacement
}

export interface CliProfilePickCommand {
  readonly kind: "profile-pick"
  readonly wait: boolean
  readonly windowPlacement: CliWindowPlacement
}

export interface CliProfileListCommand {
  readonly kind: "profile-list"
  readonly json: boolean
}

export interface CliProfileShowCommand {
  readonly kind: "profile-show"
  readonly id: string
}

export interface CliProfileImportCommand {
  readonly kind: "profile-import"
  readonly filePath: string
  readonly replace: boolean
}

export type CliProfileExportDestination =
  | { readonly kind: "stdout" }
  | { readonly kind: "file"; readonly filePath: string }

export interface CliProfileExportCommand {
  readonly kind: "profile-export"
  readonly id: string
  readonly destination: CliProfileExportDestination
  readonly replace: boolean
}

export interface CliProfileDeleteCommand {
  readonly kind: "profile-delete"
  readonly id: string
}

export interface CliScratchListCommand {
  readonly kind: "scratch-list"
  readonly json: boolean
}

export interface CliScratchExportCommand {
  readonly kind: "scratch-export"
  readonly id: string
  readonly destination: CliProfileExportDestination
}

export interface CliScratchDeleteCommand {
  readonly kind: "scratch-delete"
  readonly id: string
}

export interface CliDoctorCommand {
  readonly kind: "doctor"
}

export type CliHelpTopic =
  | "general"
  | "open"
  | "profile"
  | "profile-open"
  | "profile-list"
  | "profile-show"
  | "profile-import"
  | "profile-export"
  | "profile-delete"
  | "scratch"
  | "scratch-open"
  | "scratch-list"
  | "scratch-export"
  | "scratch-delete"
  | "doctor"

export interface CliHelpCommand {
  readonly kind: "help"
  readonly topic: CliHelpTopic
}

export interface CliVersionCommand {
  readonly kind: "version"
}

export type CliCommand =
  | CliOpenCommand
  | CliProfileOpenCommand
  | CliProfilePickCommand
  | CliProfileListCommand
  | CliProfileShowCommand
  | CliProfileImportCommand
  | CliProfileExportCommand
  | CliProfileDeleteCommand
  | CliScratchListCommand
  | CliScratchExportCommand
  | CliScratchDeleteCommand
  | CliDoctorCommand
  | CliHelpCommand
  | CliVersionCommand

export function cliCommandCanRunBeforeApplicationInitialization(
  command: CliCommand
): boolean {
  return (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "doctor"
  )
}

export interface ParseCliCommandOptions {
  /** Absolute cwd of the process which invoked the CLI helper. */
  readonly workingDirectory: string
}

export type CliUsageErrorCode =
  | "unknown-option"
  | "missing-option-value"
  | "unexpected-option-value"
  | "invalid-option-value"
  | "duplicate-option"
  | "conflicting-options"
  | "missing-argument"
  | "unexpected-argument"
  | "too-many-arguments"
  | "argument-too-long"
  | "too-many-sources"
  | "invalid-path"

/** A parse failure which the executable should report using its usage exit. */
export class CliUsageError extends Error {
  readonly exitCategory = "usage" as const
  readonly code: CliUsageErrorCode
  readonly option?: string

  constructor(code: CliUsageErrorCode, message: string, option?: string) {
    super(message)
    this.name = "CliUsageError"
    this.code = code
    this.option = option
  }
}

interface ParsedOption {
  readonly name: string
  readonly inlineValue?: string
  readonly hasInlineValue: boolean
}

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

function isStringEnumValue<const Values extends readonly string[]>(
  value: string,
  values: Values
): value is Values[number] {
  return (values as readonly string[]).includes(value)
}

function usage(
  code: CliUsageErrorCode,
  message: string,
  option?: string
): never {
  throw new CliUsageError(code, message, option)
}

function parseLongOption(argument: string): ParsedOption {
  const equalsIndex = argument.indexOf("=")
  if (equalsIndex === -1) {
    return { name: argument, hasInlineValue: false }
  }
  return {
    name: argument.slice(0, equalsIndex),
    inlineValue: argument.slice(equalsIndex + 1),
    hasInlineValue: true,
  }
}

function rejectInlineValue(option: ParsedOption): void {
  if (option.hasInlineValue) {
    usage(
      "unexpected-option-value",
      `${option.name} does not accept a value`,
      option.name
    )
  }
}

function takeOptionValue(
  arguments_: readonly string[],
  index: number,
  option: ParsedOption
): { readonly value: string; readonly nextIndex: number } {
  if (option.hasInlineValue) {
    if (option.inlineValue === undefined || option.inlineValue.length === 0) {
      usage(
        "missing-option-value",
        `${option.name} requires a value`,
        option.name
      )
    }
    return { value: option.inlineValue, nextIndex: index }
  }

  const value = arguments_[index + 1]
  if (value === undefined || value === "--" || value.startsWith("-")) {
    usage(
      "missing-option-value",
      `${option.name} requires a value`,
      option.name
    )
  }
  return { value, nextIndex: index + 1 }
}

function validateProfileId(value: string, optionOrArgument: string): string {
  if (!isProfileIdentifier(value)) {
    usage(
      "invalid-option-value",
      `${optionOrArgument} must be a lowercase hyphenated identifier of at most ${MAX_PROFILE_ID_LENGTH} characters and not a reserved Windows device name`,
      optionOrArgument.startsWith("-") ? optionOrArgument : undefined
    )
  }
  return value
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    usage(
      "invalid-option-value",
      `${option} must be a positive integer`,
      option
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    usage(
      "invalid-option-value",
      `${option} is larger than the supported range`,
      option
    )
  }
  return parsed
}

function parseBoundedCount(value: string, option: string): number {
  const parsed = parsePositiveInteger(value, option)
  if (parsed > MAX_CLI_SOURCES) {
    usage(
      "invalid-option-value",
      `${option} cannot exceed ${MAX_CLI_SOURCES}`,
      option
    )
  }
  return parsed
}

function parseLocation(value: string, option: string): CliLocation {
  const match = /^(\d+)(?::(\d+))?$/.exec(value)
  if (match === null) {
    usage(
      "invalid-option-value",
      `${option} must have the form LINE[:COLUMN]`,
      option
    )
  }

  const line = parsePositiveInteger(match[1], option)
  const column =
    match[2] === undefined ? undefined : parsePositiveInteger(match[2], option)
  if (
    line > MAX_CLI_LOCATION_VALUE ||
    (column !== undefined && column > MAX_CLI_LOCATION_VALUE)
  ) {
    usage(
      "invalid-option-value",
      `${option} line and column cannot exceed ${MAX_CLI_LOCATION_VALUE}`,
      option
    )
  }
  return column === undefined ? { line } : { line, column }
}

function splitTabOptionValue(
  value: string,
  option: string,
  expectedForm: string
): { readonly tabIndex: number; readonly value: string } {
  const separatorIndex = value.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    usage(
      "invalid-option-value",
      `${option} must have the form ${expectedForm}`,
      option
    )
  }
  return {
    tabIndex: parseBoundedCount(value.slice(0, separatorIndex), option) - 1,
    value: value.slice(separatorIndex + 1),
  }
}

function parseTabMode(
  value: string,
  option: string
): { readonly tabIndex: number; readonly mode: ProfileEditorMode } {
  const parsed = splitTabOptionValue(value, option, "TAB:MODE")
  if (!isStringEnumValue(parsed.value, PROFILE_EDITOR_MODES)) {
    usage(
      "invalid-option-value",
      `${option} mode must be one of: ${PROFILE_EDITOR_MODES.join(", ")}`,
      option
    )
  }
  return { tabIndex: parsed.tabIndex, mode: parsed.value }
}

function parseTabLocation(
  value: string,
  option: string
): { readonly tabIndex: number; readonly location: CliLocation } {
  const parsed = splitTabOptionValue(value, option, "TAB:LINE[:COLUMN]")
  return {
    tabIndex: parsed.tabIndex,
    location: parseLocation(parsed.value, option),
  }
}

function normalizePath(
  value: string,
  workingDirectory: string,
  description: string
): string {
  if (
    value.length === 0 ||
    value.length > MAX_PROFILE_PATH_LENGTH ||
    value.includes("\0")
  ) {
    usage(
      "invalid-path",
      `${description} must be a nonempty path of at most ${MAX_PROFILE_PATH_LENGTH} characters`
    )
  }

  let resolvedPath: string
  try {
    resolvedPath = value.startsWith("file://")
      ? path.resolve(fileURLToPath(value))
      : path.resolve(workingDirectory, value)
  } catch {
    usage("invalid-path", `${description} is not a valid file path or URL`)
  }
  if (resolvedPath.length > MAX_PROFILE_PATH_LENGTH) {
    usage(
      "invalid-path",
      `${description} resolves to a path longer than ${MAX_PROFILE_PATH_LENGTH} characters`
    )
  }
  return resolvedPath
}

function normalizeStdinName(value: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLI_STDIN_NAME_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    usage(
      "invalid-option-value",
      `--stdin-name must contain 1 to ${MAX_CLI_STDIN_NAME_LENGTH} characters and no control characters`,
      "--stdin-name"
    )
  }
  return normalized
}

function addSources(
  sources: CliOpenSource[],
  additions: readonly CliOpenSource[]
): void {
  if (sources.length + additions.length > MAX_CLI_SOURCES) {
    usage(
      "too-many-sources",
      `An open command cannot contain more than ${MAX_CLI_SOURCES} sources`
    )
  }
  sources.push(...additions)
}

function parseOpenCommand(
  arguments_: readonly string[],
  workingDirectory: string
): CliOpenCommand | CliProfileOpenCommand | CliProfilePickCommand {
  const sources: CliOpenSource[] = []
  const scratchIds = new Set<string>()
  let endOfOptions = false
  let windowMode: CliWindowMode = "new"
  let windowPlacement: CliWindowPlacement = "active-window"
  let windowPlacementWasSet = false
  let explicitWindowMode: CliWindowMode | null = null
  let wait = false
  let activeTab = 1
  let activeWasSet = false
  let location: CliLocation | null = null
  const tabLocations = new Map<number, CliLocation>()
  const tabModes = new Map<number, ProfileEditorMode>()
  let tabVisibility: ProfileTabVisibility = "inherit"
  let tabVisibilityWasSet = false
  let mode: CliEditorMode = "inherit"
  let modeWasSet = false
  let stdinName: string | undefined
  let profileId: string | null = null
  let profileRequested = false
  let profileIncompatibleOption: string | null = null

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!endOfOptions && argument === "--") {
      endOfOptions = true
      continue
    }

    if (!endOfOptions && argument.startsWith("-") && argument !== "-") {
      const option = argument.startsWith("--")
        ? parseLongOption(argument)
        : { name: argument, hasInlineValue: false }

      if (option.name === "-n" || option.name === "--new-window") {
        rejectInlineValue(option)
        if (explicitWindowMode !== null) {
          usage(
            explicitWindowMode === "new"
              ? "duplicate-option"
              : "conflicting-options",
            explicitWindowMode === "new"
              ? `${option.name} was provided more than once`
              : `${option.name} conflicts with --reuse-window`,
            option.name
          )
        }
        explicitWindowMode = "new"
        windowMode = "new"
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "-r" || option.name === "--reuse-window") {
        rejectInlineValue(option)
        if (explicitWindowMode !== null) {
          usage(
            explicitWindowMode === "reuse"
              ? "duplicate-option"
              : "conflicting-options",
            explicitWindowMode === "reuse"
              ? `${option.name} was provided more than once`
              : `${option.name} conflicts with --new-window`,
            option.name
          )
        }
        explicitWindowMode = "reuse"
        windowMode = "reuse"
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "-w" || option.name === "--wait") {
        rejectInlineValue(option)
        if (wait) {
          usage(
            "duplicate-option",
            `${option.name} was provided more than once`,
            option.name
          )
        }
        wait = true
        continue
      }

      if (option.name === "--mouse-monitor") {
        rejectInlineValue(option)
        if (windowPlacementWasSet) {
          usage(
            "duplicate-option",
            "--mouse-monitor was provided more than once",
            option.name
          )
        }
        windowPlacement = "mouse"
        windowPlacementWasSet = true
        continue
      }

      if (option.name === "--blank" || option.name === "--ephemeral") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        const count = parseBoundedCount(result.value, option.name)
        const kind = option.name === "--blank" ? "untitled" : "ephemeral"
        addSources(
          sources,
          Array.from({ length: count }, () => ({ kind }))
        )
        continue
      }

      if (option.name === "--scratch") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        const id = validateProfileId(result.value, option.name)
        if (scratchIds.has(id)) {
          usage(
            "duplicate-option",
            `Scratch id ${JSON.stringify(id)} was provided more than once`,
            option.name
          )
        }
        scratchIds.add(id)
        addSources(sources, [{ kind: "scratch", id }])
        continue
      }

      if (option.name === "--active") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (activeWasSet) {
          usage(
            "duplicate-option",
            "--active was provided more than once",
            option.name
          )
        }
        activeTab = parseBoundedCount(result.value, option.name)
        activeWasSet = true
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "-g" || option.name === "--goto") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (location !== null) {
          usage(
            "duplicate-option",
            `${option.name} was provided more than once`,
            option.name
          )
        }
        location = parseLocation(result.value, option.name)
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--tab-goto") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        const parsed = parseTabLocation(result.value, option.name)
        if (tabLocations.has(parsed.tabIndex)) {
          usage(
            "duplicate-option",
            `${option.name} targets tab ${parsed.tabIndex + 1} more than once`,
            option.name
          )
        }
        tabLocations.set(parsed.tabIndex, parsed.location)
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--tabs") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (tabVisibilityWasSet) {
          usage(
            "duplicate-option",
            "--tabs was provided more than once",
            option.name
          )
        }
        if (!isStringEnumValue(result.value, PROFILE_TAB_VISIBILITIES)) {
          usage(
            "invalid-option-value",
            `--tabs must be one of: ${PROFILE_TAB_VISIBILITIES.join(", ")}`,
            option.name
          )
        }
        tabVisibility = result.value
        tabVisibilityWasSet = true
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--mode") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (modeWasSet) {
          usage(
            "duplicate-option",
            "--mode was provided more than once",
            option.name
          )
        }
        if (!isStringEnumValue(result.value, CLI_EDITOR_MODES)) {
          usage(
            "invalid-option-value",
            `--mode must be one of: ${CLI_EDITOR_MODES.join(", ")}`,
            option.name
          )
        }
        mode = result.value
        modeWasSet = true
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--tab-mode") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        const parsed = parseTabMode(result.value, option.name)
        if (tabModes.has(parsed.tabIndex)) {
          usage(
            "duplicate-option",
            `${option.name} targets tab ${parsed.tabIndex + 1} more than once`,
            option.name
          )
        }
        tabModes.set(parsed.tabIndex, parsed.mode)
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--stdin-name") {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (stdinName !== undefined) {
          usage(
            "duplicate-option",
            "--stdin-name was provided more than once",
            option.name
          )
        }
        stdinName = normalizeStdinName(result.value)
        profileIncompatibleOption ??= option.name
        continue
      }

      if (option.name === "--profile") {
        if (profileRequested) {
          usage(
            "duplicate-option",
            "--profile was provided more than once",
            option.name
          )
        }
        profileRequested = true
        if (option.hasInlineValue) {
          if (!option.inlineValue) {
            usage(
              "missing-option-value",
              "--profile requires a nonempty inline id or no value",
              option.name
            )
          }
          profileId = validateProfileId(option.inlineValue, option.name)
        } else {
          const candidate = arguments_[index + 1]
          if (
            candidate !== undefined &&
            candidate !== "--" &&
            candidate !== "-" &&
            !candidate.startsWith("-")
          ) {
            profileId = validateProfileId(candidate, option.name)
            index += 1
          }
        }
        continue
      }

      usage("unknown-option", `Unknown option: ${option.name}`, option.name)
    }

    if (argument === "-") {
      if (sources.some((source) => source.kind === "stdin")) {
        usage(
          "conflicting-options",
          "Standard input may be used as a source only once"
        )
      }
      addSources(sources, [{ kind: "stdin" }])
    } else {
      addSources(sources, [
        {
          kind: "file",
          filePath: normalizePath(argument, workingDirectory, "Open path"),
        },
      ])
    }
  }

  if (profileRequested) {
    if (sources.length > 0) {
      usage(
        "conflicting-options",
        "--profile cannot be combined with paths, stdin, or direct tab inputs",
        "--profile"
      )
    }
    if (profileIncompatibleOption !== null) {
      usage(
        "conflicting-options",
        `--profile cannot be combined with ${profileIncompatibleOption}`,
        "--profile"
      )
    }
    return profileId === null
      ? { kind: "profile-pick", wait, windowPlacement }
      : {
          kind: "profile-open",
          id: profileId,
          wait,
          windowPlacement,
        }
  }

  const stdinIndex = sources.findIndex((source) => source.kind === "stdin")
  if (stdinName !== undefined && stdinIndex === -1) {
    usage(
      "conflicting-options",
      "--stdin-name requires a standard-input (-) source",
      "--stdin-name"
    )
  }
  if (stdinName !== undefined) {
    sources[stdinIndex] = { kind: "stdin", name: stdinName }
  }

  const effectiveSourceCount = Math.max(1, sources.length)
  if (activeTab > effectiveSourceCount) {
    usage(
      "invalid-option-value",
      `--active ${activeTab} exceeds the ${effectiveSourceCount} requested tab${effectiveSourceCount === 1 ? "" : "s"}`,
      "--active"
    )
  }

  for (const tabIndex of new Set([
    ...tabModes.keys(),
    ...tabLocations.keys(),
  ])) {
    if (tabIndex >= effectiveSourceCount) {
      usage(
        "invalid-option-value",
        `Tab ${tabIndex + 1} exceeds the ${effectiveSourceCount} requested tab${effectiveSourceCount === 1 ? "" : "s"}`
      )
    }
  }

  const activeTabIndex = activeTab - 1
  if (location !== null) {
    if (tabLocations.has(activeTabIndex)) {
      usage(
        "conflicting-options",
        `--goto and --tab-goto both target tab ${activeTab}`,
        "--goto"
      )
    }
    tabLocations.set(activeTabIndex, location)
  }

  const tabOptions = [...new Set([...tabModes.keys(), ...tabLocations.keys()])]
    .sort((left, right) => left - right)
    .map((tabIndex) => ({
      tabIndex,
      ...(tabLocations.has(tabIndex)
        ? { location: tabLocations.get(tabIndex)! }
        : {}),
      ...(tabModes.has(tabIndex) ? { mode: tabModes.get(tabIndex)! } : {}),
    }))

  return {
    kind: "open",
    windowMode,
    windowPlacement,
    wait,
    sources,
    activeTabIndex,
    tabOptions,
    tabVisibility,
    mode,
  }
}

interface SimpleArguments {
  readonly positionals: readonly string[]
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlyMap<string, string>
}

function parseSimpleArguments(
  arguments_: readonly string[],
  booleanOptions: readonly string[],
  valueOptions: readonly string[]
): SimpleArguments {
  const positionals: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  let endOfOptions = false

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!endOfOptions && argument === "--") {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && argument.startsWith("-") && argument !== "-") {
      const option = argument.startsWith("--")
        ? parseLongOption(argument)
        : { name: argument, hasInlineValue: false }
      if (booleanOptions.includes(option.name)) {
        rejectInlineValue(option)
        if (flags.has(option.name)) {
          usage(
            "duplicate-option",
            `${option.name} was provided more than once`,
            option.name
          )
        }
        flags.add(option.name)
        continue
      }
      if (valueOptions.includes(option.name)) {
        const result = takeOptionValue(arguments_, index, option)
        index = result.nextIndex
        if (values.has(option.name)) {
          usage(
            "duplicate-option",
            `${option.name} was provided more than once`,
            option.name
          )
        }
        values.set(option.name, result.value)
        continue
      }
      usage("unknown-option", `Unknown option: ${option.name}`, option.name)
    }
    positionals.push(argument)
  }

  return { positionals, flags, values }
}

function requireExactPositionals(
  positionals: readonly string[],
  minimum: number,
  maximum: number,
  description: string
): void {
  if (positionals.length < minimum) {
    usage("missing-argument", `${description} requires an argument`)
  }
  if (positionals.length > maximum) {
    usage(
      "unexpected-argument",
      `${description} received an unexpected argument: ${positionals[maximum]}`
    )
  }
}

function parseProfileCommand(
  arguments_: readonly string[],
  workingDirectory: string
): Exclude<
  CliCommand,
  CliOpenCommand | CliDoctorCommand | CliHelpCommand | CliVersionCommand
> {
  const subcommand = arguments_[0]
  if (subcommand === undefined) {
    usage("missing-argument", "profile requires a subcommand")
  }
  const rest = arguments_.slice(1)

  if (subcommand === "open") {
    const parsed = parseSimpleArguments(rest, ["--wait", "--mouse-monitor"], [])
    requireExactPositionals(parsed.positionals, 0, 1, "profile open")
    const common = {
      wait: parsed.flags.has("--wait"),
      windowPlacement: parsed.flags.has("--mouse-monitor")
        ? ("mouse" as const)
        : ("active-window" as const),
    }
    return parsed.positionals[0] === undefined
      ? { kind: "profile-pick", ...common }
      : {
          kind: "profile-open",
          id: validateProfileId(parsed.positionals[0], "Profile id"),
          ...common,
        }
  }

  if (subcommand === "list") {
    const parsed = parseSimpleArguments(rest, ["--json"], [])
    requireExactPositionals(parsed.positionals, 0, 0, "profile list")
    return { kind: "profile-list", json: parsed.flags.has("--json") }
  }

  if (subcommand === "show") {
    const parsed = parseSimpleArguments(rest, [], [])
    requireExactPositionals(parsed.positionals, 1, 1, "profile show")
    return {
      kind: "profile-show",
      id: validateProfileId(parsed.positionals[0], "Profile id"),
    }
  }

  if (subcommand === "import") {
    const parsed = parseSimpleArguments(rest, ["--replace"], [])
    requireExactPositionals(parsed.positionals, 1, 1, "profile import")
    if (parsed.positionals[0] === "-") {
      usage(
        "invalid-path",
        "profile import requires a file path; standard input is not supported"
      )
    }
    return {
      kind: "profile-import",
      filePath: normalizePath(
        parsed.positionals[0],
        workingDirectory,
        "Profile import path"
      ),
      replace: parsed.flags.has("--replace"),
    }
  }

  if (subcommand === "export") {
    const parsed = parseSimpleArguments(rest, ["--replace"], [])
    requireExactPositionals(parsed.positionals, 1, 2, "profile export")
    const destinationArgument = parsed.positionals[1]
    const destination: CliProfileExportDestination =
      destinationArgument === undefined || destinationArgument === "-"
        ? { kind: "stdout" }
        : {
            kind: "file",
            filePath: normalizePath(
              destinationArgument,
              workingDirectory,
              "Profile export path"
            ),
          }
    if (destination.kind === "stdout" && parsed.flags.has("--replace")) {
      usage(
        "conflicting-options",
        "--replace requires a profile export file destination",
        "--replace"
      )
    }
    return {
      kind: "profile-export",
      id: validateProfileId(parsed.positionals[0], "Profile id"),
      destination,
      replace: parsed.flags.has("--replace"),
    }
  }

  if (subcommand === "delete") {
    const parsed = parseSimpleArguments(rest, [], [])
    requireExactPositionals(parsed.positionals, 1, 1, "profile delete")
    return {
      kind: "profile-delete",
      id: validateProfileId(parsed.positionals[0], "Profile id"),
    }
  }

  usage("unexpected-argument", `Unknown profile subcommand: ${subcommand}`)
}

function parseScratchCommand(
  arguments_: readonly string[],
  workingDirectory: string
):
  | CliOpenCommand
  | CliScratchListCommand
  | CliScratchExportCommand
  | CliScratchDeleteCommand {
  const subcommand = arguments_[0]
  if (subcommand === undefined) {
    usage("missing-argument", "scratch requires a subcommand")
  }
  const rest = arguments_.slice(1)

  if (subcommand === "open") {
    const parsed = parseSimpleArguments(rest, ["--wait", "--mouse-monitor"], [])
    requireExactPositionals(parsed.positionals, 1, 1, "scratch open")
    const id = validateProfileId(parsed.positionals[0], "Scratch id")
    return {
      kind: "open",
      windowMode: "new",
      windowPlacement: parsed.flags.has("--mouse-monitor")
        ? "mouse"
        : "active-window",
      wait: parsed.flags.has("--wait"),
      sources: [{ kind: "scratch", id }],
      activeTabIndex: 0,
      tabOptions: [],
      tabVisibility: "inherit",
      mode: "inherit",
    }
  }

  if (subcommand === "list") {
    const parsed = parseSimpleArguments(rest, ["--json"], [])
    requireExactPositionals(parsed.positionals, 0, 0, "scratch list")
    return { kind: "scratch-list", json: parsed.flags.has("--json") }
  }

  if (subcommand === "export") {
    const parsed = parseSimpleArguments(rest, [], [])
    requireExactPositionals(parsed.positionals, 1, 2, "scratch export")
    const destinationArgument = parsed.positionals[1]
    const destination: CliProfileExportDestination =
      destinationArgument === undefined || destinationArgument === "-"
        ? { kind: "stdout" }
        : {
            kind: "file",
            filePath: normalizePath(
              destinationArgument,
              workingDirectory,
              "Scratch export path"
            ),
          }
    return {
      kind: "scratch-export",
      id: validateProfileId(parsed.positionals[0], "Scratch id"),
      destination,
    }
  }

  if (subcommand === "delete") {
    const parsed = parseSimpleArguments(rest, [], [])
    requireExactPositionals(parsed.positionals, 1, 1, "scratch delete")
    return {
      kind: "scratch-delete",
      id: validateProfileId(parsed.positionals[0], "Scratch id"),
    }
  }

  usage("unexpected-argument", `Unknown scratch subcommand: ${subcommand}`)
}

function helpTopic(arguments_: readonly string[]): CliHelpTopic | null {
  const endOfOptions = arguments_.indexOf("--")
  const optionArguments = arguments_.slice(
    0,
    endOfOptions === -1 ? arguments_.length : endOfOptions
  )
  if (
    !optionArguments.some(
      (argument) => argument === "-h" || argument === "--help"
    )
  ) {
    return null
  }

  const command = optionArguments[0]
  if (command === "profile") {
    const subcommand = optionArguments[1]
    return isStringEnumValue(subcommand ?? "", [
      "open",
      "list",
      "show",
      "import",
      "export",
      "delete",
    ] as const)
      ? (`profile-${subcommand}` as CliHelpTopic)
      : "profile"
  }
  if (command === "scratch") {
    const subcommand = optionArguments[1]
    return isStringEnumValue(subcommand ?? "", [
      "open",
      "list",
      "export",
      "delete",
    ] as const)
      ? (`scratch-${subcommand}` as CliHelpTopic)
      : "scratch"
  }
  if (command === "doctor") return "doctor"
  if (command === "open") return "open"
  if (command === "help") {
    const namedArguments = optionArguments
      .slice(1)
      .filter((argument) => argument !== "-h" && argument !== "--help")
    return namedHelpTopic(namedArguments) ?? "general"
  }
  return command === "-h" || command === "--help" ? "general" : "open"
}

function versionRequested(arguments_: readonly string[]): boolean {
  const endOfOptions = arguments_.indexOf("--")
  return arguments_
    .slice(0, endOfOptions === -1 ? arguments_.length : endOfOptions)
    .some((argument) => argument === "-V" || argument === "--version")
}

function namedHelpTopic(arguments_: readonly string[]): CliHelpTopic | null {
  const topics: Readonly<Record<string, CliHelpTopic>> = {
    "": "general",
    open: "open",
    profile: "profile",
    "profile\0open": "profile-open",
    "profile\0list": "profile-list",
    "profile\0show": "profile-show",
    "profile\0import": "profile-import",
    "profile\0export": "profile-export",
    "profile\0delete": "profile-delete",
    scratch: "scratch",
    "scratch\0open": "scratch-open",
    "scratch\0list": "scratch-list",
    "scratch\0export": "scratch-export",
    "scratch\0delete": "scratch-delete",
    doctor: "doctor",
  }
  return topics[arguments_.join("\0")] ?? null
}

/**
 * Parses argv after the `pmd` executable name. The function performs no I/O,
 * reads no process globals, and never exits; usage failures are typed errors.
 */
export function parseCliCommand(
  arguments_: readonly string[],
  options: ParseCliCommandOptions
): CliCommand {
  if (!path.isAbsolute(options.workingDirectory)) {
    throw new TypeError("CLI working directory must be absolute")
  }
  if (arguments_.length > MAX_CLI_ARGUMENTS) {
    usage(
      "too-many-arguments",
      `A command cannot contain more than ${MAX_CLI_ARGUMENTS} arguments`
    )
  }
  if (
    arguments_.some((argument) => argument.length > MAX_CLI_ARGUMENT_LENGTH)
  ) {
    usage(
      "argument-too-long",
      `Command arguments cannot exceed ${MAX_CLI_ARGUMENT_LENGTH} characters`
    )
  }

  const requestedHelpTopic = helpTopic(arguments_)
  if (requestedHelpTopic !== null) {
    return { kind: "help", topic: requestedHelpTopic }
  }
  if (versionRequested(arguments_)) {
    return { kind: "version" }
  }

  const command = arguments_[0]
  if (command === "help") {
    const topic = namedHelpTopic(arguments_.slice(1))
    if (topic === null) {
      usage(
        "unexpected-argument",
        `Unknown help topic: ${arguments_.slice(1).join(" ")}`
      )
    }
    return { kind: "help", topic }
  }
  if (command === "profile") {
    return parseProfileCommand(arguments_.slice(1), options.workingDirectory)
  }
  if (command === "scratch") {
    return parseScratchCommand(arguments_.slice(1), options.workingDirectory)
  }
  if (command === "doctor") {
    if (arguments_.length > 1) {
      const argument = arguments_[1]
      usage(
        argument.startsWith("-") ? "unknown-option" : "unexpected-argument",
        argument.startsWith("-")
          ? `Unknown option: ${argument}`
          : `doctor received an unexpected argument: ${argument}`,
        argument.startsWith("-") ? argument : undefined
      )
    }
    return { kind: "doctor" }
  }

  const openArguments = command === "open" ? arguments_.slice(1) : arguments_
  return parseOpenCommand(openArguments, options.workingDirectory)
}
