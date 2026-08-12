export const MAX_PROFILE_ID_LENGTH = 64

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_RESERVED_BASENAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Profile ids and profile-local tab ids share one filesystem-safe grammar.
 * Standalone scratch resources use canonical UUIDs instead.
 */
export function isProfileIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    IDENTIFIER_PATTERN.test(value) &&
    !WINDOWS_RESERVED_BASENAME_PATTERN.test(value)
  )
}
