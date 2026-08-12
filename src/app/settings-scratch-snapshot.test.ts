import { describe, expect, it, vi } from "vitest"

import {
  boundedEncodedDocumentByteLength,
  collectSettingsScratchSnapshot,
} from "./settings-scratch-snapshot"

describe("settings scratch snapshot byte accounting", () => {
  it.each([
    ["plain UTF-8", "notes", false, "\n"],
    ["control characters", '\0\b\t\n\f\r\\"', false, "\n"],
    ["CRLF and BOM", "one\ntwo\r\nthree\rfour", true, "\r\n"],
    ["multibyte text", "naïve 😀", false, "\n"],
    ["lone surrogates", "\ud800x\udc00", false, "\n"],
  ] as const)(
    "matches document encoding for %s",
    (_description, value, hasUtf8Bom, lineEnding) => {
      const normalized = value.replace(/\r\n?/g, "\n")
      const encoded =
        lineEnding === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized
      const expected =
        new TextEncoder().encode(encoded).length + (hasUtf8Bom ? 3 : 0)
      const format = { hasUtf8Bom, lineEnding }
      expect(boundedEncodedDocumentByteLength(value, format, expected)).toBe(
        expected
      )
      if (expected > 0) {
        expect(
          boundedEncodedDocumentByteLength(value, format, expected - 1)
        ).toBeNull()
      }
    }
  )

  it("stops resolving later tabs as soon as encoded content exhausts the budget", async () => {
    const resolved: string[] = []
    const result = await collectSettingsScratchSnapshot(
      ["first", "escaped", "must-not-resolve"],
      1,
      async (tabId) => {
        resolved.push(tabId)
        return {
          document: {
            length: 1,
            toString: () => (tabId === "escaped" ? "\0" : "a"),
          },
          format: { hasUtf8Bom: false, lineEnding: "\n" },
          revision: resolved.length,
        }
      }
    )

    expect(result).toEqual({ status: "too-large" })
    expect(resolved).toEqual(["first", "escaped"])
  })

  it("rejects an impossible document length before materializing text", async () => {
    const toString = vi.fn(() => "longer")
    const result = await collectSettingsScratchSnapshot(
      ["first", "must-not-resolve"],
      5,
      async () => ({
        document: { length: 6, toString },
        format: { hasUtf8Bom: false, lineEnding: "\n" },
        revision: 0,
      })
    )

    expect(result).toEqual({ status: "too-large" })
    expect(toString).not.toHaveBeenCalled()
  })
})
