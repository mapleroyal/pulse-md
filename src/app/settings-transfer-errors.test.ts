import { describe, expect, it } from "vitest"

import { SETTINGS_IMPORT_ACTIONABLE_ERRORS } from "../shared/contracts"

import { settingsSaveErrorMessage } from "./settings-transfer-errors"

describe("settings transfer errors", () => {
  it("surfaces allowlisted import conflicts through Electron's error wrapper", () => {
    expect(
      settingsSaveErrorMessage(
        new Error(
          `Error invoking remote method: ${SETTINGS_IMPORT_ACTIONABLE_ERRORS.scratchOpen}`
        )
      )
    ).toBe(SETTINGS_IMPORT_ACTIONABLE_ERRORS.scratchOpen)
  })

  it("does not expose unexpected main-process errors", () => {
    expect(settingsSaveErrorMessage(new Error("private/path failed"))).toBe(
      "Settings could not be saved. Check that the settings folder is writable, then try again."
    )
  })
})
