import { describe, expect, it } from "vitest"

import {
  WINDOWS_MENU_DEFINITIONS,
  stepWindowsMenu,
  windowsMenuForMnemonic,
} from "./windows-menu"

describe("Windows menu keyboard navigation", () => {
  it("keeps the native application menu order and access mnemonics", () => {
    expect(WINDOWS_MENU_DEFINITIONS.map(({ id }) => id)).toEqual([
      "file",
      "edit",
      "format",
      "view",
      "window",
      "help",
    ])
    expect(windowsMenuForMnemonic("F")).toBe("file")
    expect(windowsMenuForMnemonic("o")).toBe("format")
    expect(windowsMenuForMnemonic("x")).toBeNull()
  })

  it("wraps arrows and skips a disabled top-level menu", () => {
    const enabled = (menu: string) => menu !== "format"
    expect(stepWindowsMenu("help", 1, enabled)).toBe("file")
    expect(stepWindowsMenu("view", -1, enabled)).toBe("edit")
  })
})
