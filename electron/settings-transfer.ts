import path from "node:path"

import {
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
  type AppSettings,
} from "../src/shared/contracts"
import type { ProfileSchemaV2 } from "./profile-schema"

export interface SettingsExportResources {
  readonly profiles?: readonly ProfileSchemaV2[]
}

export interface SettingsExportFile extends SettingsExportResources {
  format: typeof SETTINGS_EXPORT_FORMAT
  version: typeof SETTINGS_EXPORT_VERSION
  settings: AppSettings
}

export interface ParsedSettingsExport {
  readonly profiles: readonly unknown[]
  readonly settings: unknown
}

export const MAX_SETTINGS_TRANSFER_PROFILES = 1_000

export function validatedSettingsExportPath(
  filePath: string,
  includesScratches: boolean
): string {
  const requiredExtension = includesScratches ? ".zip" : ".json"
  if (path.extname(filePath).toLocaleLowerCase() !== requiredExtension) {
    throw new TypeError(
      `The settings export filename must end in ${requiredExtension}`
    )
  }
  return path.resolve(filePath)
}

function exactObjectKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  description: string
): void {
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(candidate).find((key) => !allowed.has(key))
  if (unexpected) {
    throw new TypeError(
      `${description} contains unsupported field ${unexpected}`
    )
  }
}

export function settingsExportFile(
  settings: AppSettings,
  resources: SettingsExportResources = {}
): SettingsExportFile {
  return {
    format: SETTINGS_EXPORT_FORMAT,
    version: SETTINGS_EXPORT_VERSION,
    settings,
    ...(resources.profiles === undefined
      ? {}
      : { profiles: resources.profiles }),
  }
}

export function serializeSettingsExport(
  settings: AppSettings,
  resources: SettingsExportResources = {}
) {
  return `${JSON.stringify(settingsExportFile(settings, resources), null, 2)}\n`
}

export function settingsTransferFromExport(
  value: unknown
): ParsedSettingsExport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Settings export must be an object")
  }

  const candidate = value as Record<string, unknown>
  if (candidate.format !== SETTINGS_EXPORT_FORMAT) {
    throw new TypeError("This is not a Pulse MD settings export")
  }
  if (candidate.version !== SETTINGS_EXPORT_VERSION) {
    throw new TypeError("This Pulse MD settings export version is unsupported")
  }
  exactObjectKeys(
    candidate,
    ["format", "profiles", "settings", "version"],
    "Settings export"
  )
  if (typeof candidate.settings !== "object" || candidate.settings === null) {
    throw new TypeError("Settings export does not contain settings")
  }
  if (candidate.profiles !== undefined && !Array.isArray(candidate.profiles)) {
    throw new TypeError("Settings export profiles must be an array")
  }
  if (
    candidate.profiles !== undefined &&
    candidate.profiles.length > MAX_SETTINGS_TRANSFER_PROFILES
  ) {
    throw new TypeError("The settings export contains too many profiles")
  }
  return {
    profiles: candidate.profiles ?? [],
    settings: candidate.settings,
  }
}
