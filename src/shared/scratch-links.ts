import type { ScratchDocumentIdentity } from "./contracts"
import { isScratchIdentifier } from "./scratch-identifiers"

export const SCRATCH_LINK_SCHEMES = [
  "pulse-md",
  "pulse-md-local",
  "pulse-md-development",
] as const
export type ScratchLinkScheme = (typeof SCRATCH_LINK_SCHEMES)[number]

const SCRATCH_LINK_HOST = "scratch"
export const MAX_SCRATCH_LINK_FRAGMENT_LENGTH = 32_768

export function isScratchLinkScheme(
  value: unknown
): value is ScratchLinkScheme {
  return SCRATCH_LINK_SCHEMES.includes(value as ScratchLinkScheme)
}

function encodedPathSegment(segment: string) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function decodedPathSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function isValidScratchLinkFragment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SCRATCH_LINK_FRAGMENT_LENGTH &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

export function scratchLinkAddress(
  identity: ScratchDocumentIdentity,
  fragment: string | null,
  scheme: ScratchLinkScheme = "pulse-md"
) {
  if (!isScratchIdentifier(identity.scratchId)) {
    throw new TypeError("Scratch link identity is invalid")
  }
  if (fragment !== null && !isValidScratchLinkFragment(fragment)) {
    throw new TypeError("Scratch link fragment is invalid")
  }
  const fragmentSuffix =
    fragment === null ? "" : `#${encodeURIComponent(fragment)}`
  return `${scheme}://${SCRATCH_LINK_HOST}/${encodedPathSegment(identity.scratchId)}${fragmentSuffix}`
}

export interface ParsedScratchLink {
  readonly fragment: string | null
  readonly href: string
  readonly identity: ScratchDocumentIdentity
  readonly scheme: ScratchLinkScheme
}

export function parseScratchLinkAddress(
  destination: string
): ParsedScratchLink | null {
  const hashIndex = destination.indexOf("#")
  const address = hashIndex < 0 ? destination : destination.slice(0, hashIndex)
  // URL.search cannot distinguish no query from a trailing empty `?`.
  if (address.includes("?")) return null

  let parsed: URL
  try {
    parsed = new URL(destination)
  } catch {
    return null
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  if (
    !isScratchLinkScheme(scheme) ||
    parsed.hostname !== SCRATCH_LINK_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== ""
  ) {
    return null
  }

  const components = parsed.pathname.split("/")
  if (components[0] !== "" || components.length !== 2) return null
  const scratchId = decodedPathSegment(components[1]!)
  if (!isScratchIdentifier(scratchId)) return null
  const identity: ScratchDocumentIdentity = { scratchId }

  const fragment =
    hashIndex >= 0
      ? (() => {
          try {
            return decodeURIComponent(parsed.hash.slice(1))
          } catch {
            return parsed.hash.slice(1)
          }
        })()
      : null
  if (fragment !== null && !isValidScratchLinkFragment(fragment)) return null
  return {
    fragment,
    href: scratchLinkAddress(identity, fragment, scheme),
    identity,
    scheme,
  }
}
