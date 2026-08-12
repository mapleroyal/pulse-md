import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
} from "../src/shared/contracts"
import {
  MAX_SETTINGS_TRANSFER_PROFILES,
  serializeSettingsExport,
  settingsTransferFromExport,
  validatedSettingsExportPath,
} from "./settings-transfer"

describe("settings transfer files", () => {
  it("requires the transfer format's filename extension", () => {
    expect(validatedSettingsExportPath("archive.ZIP", true)).toBe(
      path.resolve("archive.ZIP")
    )
    expect(validatedSettingsExportPath("settings.json", false)).toBe(
      path.resolve("settings.json")
    )
    expect(() => validatedSettingsExportPath("archive.json", true)).toThrow(
      "must end in .zip"
    )
    expect(() => validatedSettingsExportPath("settings.zip", false)).toThrow(
      "must end in .json"
    )
  })

  it("round-trips JSON settings with optional profiles", () => {
    const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    settings.lineWrapping = false
    const profile = {
      version: 2,
      id: "writing",
      name: "Writing",
      activeTab: "notes",
      tabVisibility: "always",
      tabs: [{ id: "notes", kind: "untitled" }],
    } as const

    const parsed = JSON.parse(
      serializeSettingsExport(settings, {
        profiles: [profile],
      })
    ) as unknown
    expect(settingsTransferFromExport(parsed)).toEqual({
      profiles: [profile],
      settings,
    })
    expect(parsed).toMatchObject({
      format: SETTINGS_EXPORT_FORMAT,
      version: SETTINGS_EXPORT_VERSION,
    })
  })

  it("rejects ordinary JSON and unsupported versions", () => {
    expect(() => settingsTransferFromExport(DEFAULT_APP_SETTINGS)).toThrow(
      "not a Pulse MD settings export"
    )
    expect(() =>
      settingsTransferFromExport({
        format: SETTINGS_EXPORT_FORMAT,
        version: SETTINGS_EXPORT_VERSION + 1,
        settings: DEFAULT_APP_SETTINGS,
      })
    ).toThrow("version is unsupported")
  })

  it("rejects scratch payloads in the JSON format", () => {
    const envelope = {
      format: SETTINGS_EXPORT_FORMAT,
      version: SETTINGS_EXPORT_VERSION,
      settings: DEFAULT_APP_SETTINGS,
    }
    expect(() =>
      settingsTransferFromExport({
        ...envelope,
        scratches: [],
      })
    ).toThrow("unsupported field scratches")
  })

  it("bounds resource arrays before normalizing their contents", () => {
    const envelope = {
      format: SETTINGS_EXPORT_FORMAT,
      version: SETTINGS_EXPORT_VERSION,
      settings: DEFAULT_APP_SETTINGS,
    }
    expect(() =>
      settingsTransferFromExport({
        ...envelope,
        profiles: new Array(MAX_SETTINGS_TRANSFER_PROFILES + 1).fill(null),
      })
    ).toThrow("too many profiles")
  })
})
