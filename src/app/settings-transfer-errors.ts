import { SETTINGS_IMPORT_ACTIONABLE_ERRORS } from "../shared/contracts"

const GENERIC_SETTINGS_SAVE_ERROR =
  "Settings could not be saved. Check that the settings folder is writable, then try again."

export function settingsSaveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  return (
    Object.values(SETTINGS_IMPORT_ACTIONABLE_ERRORS).find((candidate) =>
      message.includes(candidate)
    ) ?? GENERIC_SETTINGS_SAVE_ERROR
  )
}
