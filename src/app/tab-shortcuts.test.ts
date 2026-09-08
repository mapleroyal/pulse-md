import { describe, expect, it } from "vitest"

import type { AppPlatform } from "@/shared/contracts"

import { tabIndexForDigitShortcut } from "./tab-shortcuts"

const platforms: (AppPlatform | null)[] = ["darwin", "linux", "win32", null]
const digitTabIndices = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8]
const unmodified = {
  altKey: false,
  code: "Digit2",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
}

describe.each(platforms)("numbered tab shortcuts on %s", (platform) => {
  it("selects tabs 1–10 with exact Control and either digit key bank", () => {
    for (const prefix of ["Digit", "Numpad"]) {
      for (const [digit, expectedIndex] of digitTabIndices.entries()) {
        const code = `${prefix}${digit}`
        expect(
          tabIndexForDigitShortcut(
            { ...unmodified, code, ctrlKey: true },
            platform
          ),
          `Control+${code}`
        ).toBe(expectedIndex)
      }
    }
  })

  it("limits exact Meta aliases to the platform's supported tab numbers", () => {
    const expectedIndices =
      platform === "linux"
        ? digitTabIndices
        : platform === "darwin"
          ? [null, 0, 1, 2, 3, 4, 5, 6, 7, 8]
          : Array<null>(10).fill(null)

    for (const prefix of ["Digit", "Numpad"]) {
      for (const [digit, expectedIndex] of expectedIndices.entries()) {
        const code = `${prefix}${digit}`
        expect(
          tabIndexForDigitShortcut(
            { ...unmodified, code, metaKey: true },
            platform
          ),
          `Meta+${code}`
        ).toBe(expectedIndex)
      }
    }
  })

  it.each([
    ["unmodified", {}],
    ["Control+Alt", { ctrlKey: true, altKey: true }],
    ["Control+Shift", { ctrlKey: true, shiftKey: true }],
    ["Meta+Alt", { metaKey: true, altKey: true }],
    ["Meta+Shift", { metaKey: true, shiftKey: true }],
    ["Control+Meta", { ctrlKey: true, metaKey: true }],
  ])("ignores %s digit keys", (_description, modifiers) => {
    expect(
      tabIndexForDigitShortcut({ ...unmodified, ...modifiers }, platform)
    ).toBeNull()
  })

  it("ignores keys outside the digit and numeric keypad rows", () => {
    for (const code of ["Tab", "Key2", "Digit10", "NumpadAdd", ""]) {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        expect(
          tabIndexForDigitShortcut(
            { ...unmodified, code, ...modifier },
            platform
          ),
          code
        ).toBeNull()
      }
    }
  })
})
