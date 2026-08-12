import { describe, expect, it } from "vitest"

import {
  runSettingsImportTransaction,
  type SettingsImportReplacement,
} from "./settings-import-transaction"

function replacement(
  values: Map<string, string>,
  key: string,
  nextValue: string,
  events: string[],
  failBeforeApply = false
): SettingsImportReplacement {
  return {
    apply: async () => {
      events.push(`apply:${key}`)
      if (failBeforeApply) throw new Error(`write:${key}`)
      values.set(key, nextValue)
    },
    captureRollback: async () => {
      const original = values.has(key) ? values.get(key)! : null
      events.push(`capture:${key}`)
      return async () => {
        events.push(`rollback:${key}`)
        if (original === null) values.delete(key)
        else values.set(key, original)
      }
    },
  }
}

describe("settings import transaction", () => {
  it("publishes every resource before committing settings", async () => {
    const values = new Map<string, string>([["profile", "old"]])
    const events: string[] = []
    const result = await runSettingsImportTransaction(
      [replacement(values, "profile", "new", events)],
      async () => {
        events.push("commit")
        expect(values.get("profile")).toBe("new")
        return "saved"
      }
    )

    expect(result).toBe("saved")
    expect(events).toEqual(["capture:profile", "apply:profile", "commit"])
  })

  it("restores existing and newly created resources after a write fails", async () => {
    const values = new Map<string, string>([["first", "old"]])
    const events: string[] = []

    await expect(
      runSettingsImportTransaction(
        [
          replacement(values, "first", "new", events),
          replacement(values, "second", "created", events, true),
        ],
        async () => undefined
      )
    ).rejects.toThrow("write:second")

    expect(values).toEqual(new Map([["first", "old"]]))
    expect(events).toEqual([
      "capture:first",
      "capture:second",
      "apply:first",
      "apply:second",
      "rollback:first",
    ])
  })

  it("restores resources when the final settings commit fails", async () => {
    const values = new Map<string, string>([["profile", "old"]])
    const events: string[] = []

    await expect(
      runSettingsImportTransaction(
        [replacement(values, "profile", "new", events)],
        async () => {
          throw new Error("settings write")
        }
      )
    ).rejects.toThrow("settings write")
    expect(values.get("profile")).toBe("old")
  })
})
