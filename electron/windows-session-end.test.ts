import { describe, expect, it } from "vitest"

import { windowsSessionEndRequiresQuitTransaction } from "./windows-session-end"

describe("Windows session-end policy", () => {
  it("runs the quit transaction until application or window close is authorized", () => {
    expect(windowsSessionEndRequiresQuitTransaction(false, false)).toBe(true)
    expect(windowsSessionEndRequiresQuitTransaction(true, false)).toBe(false)
    expect(windowsSessionEndRequiresQuitTransaction(false, true)).toBe(false)
  })
})
