import { describe, expect, it } from "vitest"

import { runProfileDeleteTransaction } from "./profile-delete-transaction"

function transaction(options: {
  clearDefaultProfile?: () => Promise<void>
  defaultProfileId: string | null
  events: string[]
  profileIsOpen?: boolean
  restoreDefinition?: () => Promise<void>
}) {
  return runProfileDeleteTransaction({
    captureDefinition: async () => {
      options.events.push("capture")
      return "stored-profile"
    },
    clearDefaultProfile:
      options.clearDefaultProfile ??
      (async () => {
        options.events.push("clear-default")
      }),
    defaultProfileId: async () => options.defaultProfileId,
    deleteDefinition: async () => {
      options.events.push("delete")
    },
    profileId: "notes",
    profileIsOpen: () => options.profileIsOpen ?? false,
    restoreDefinition: async (snapshot) => {
      expect(snapshot).toBe("stored-profile")
      options.events.push("restore")
      await options.restoreDefinition?.()
    },
  })
}

describe("profile delete transaction", () => {
  it("deletes a non-default profile without touching settings", async () => {
    const events: string[] = []
    await transaction({ defaultProfileId: "other", events })
    expect(events).toEqual(["delete"])
  })

  it("captures and deletes the default before clearing its setting", async () => {
    const events: string[] = []
    await transaction({ defaultProfileId: "notes", events })
    expect(events).toEqual(["capture", "delete", "clear-default"])
  })

  it("restores the default profile when its settings commit fails", async () => {
    const settingsError = new Error("settings write failed")
    const events: string[] = []
    await expect(
      transaction({
        clearDefaultProfile: async () => {
          events.push("clear-default")
          throw settingsError
        },
        defaultProfileId: "notes",
        events,
      })
    ).rejects.toBe(settingsError)
    expect(events).toEqual(["capture", "delete", "clear-default", "restore"])
  })

  it("reports both the settings and restoration failures", async () => {
    const settingsError = new Error("settings write failed")
    const restoreError = new Error("profile restore failed")
    const events: string[] = []
    const failure = await transaction({
      clearDefaultProfile: async () => {
        throw settingsError
      },
      defaultProfileId: "notes",
      events,
      restoreDefinition: async () => {
        throw restoreError
      },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      settingsError,
      restoreError,
    ])
  })

  it("refuses to delete an open profile before touching storage", async () => {
    const events: string[] = []
    await expect(
      transaction({ defaultProfileId: "notes", events, profileIsOpen: true })
    ).rejects.toThrow("Close profile notes")
    expect(events).toEqual([])
  })
})
