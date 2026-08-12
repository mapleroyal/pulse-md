import { MAX_FONT_FAMILY_NAME_LENGTH } from "../shared/contracts"

export type FontPickerPurpose = "regular" | "monospace"

export type FontFamilyOptionSource =
  "included" | "generic" | "system" | "current"

export interface FontFamilyOption {
  /** The value persisted in application settings. */
  value: string
  /** The human-readable family name shown by the picker. */
  label: string
  /** A valid CSS font-family expression for previewing this option. */
  cssFamily: string
  source: FontFamilyOptionSource
  purpose?: FontPickerPurpose
  /** Additional normalized text considered by the picker search. */
  searchText: string
  faceCount?: number
}

export interface LocalFontFace {
  family: string
  fullName?: string
  postscriptName?: string
  style?: string
}

export interface SystemFontFamily {
  family: string
  faceCount: number
  styles: readonly string[]
}

export type SystemFontCatalogStatus =
  "idle" | "loading" | "ready" | "denied" | "unsupported" | "error"

export interface SystemFontCatalogSnapshot {
  status: SystemFontCatalogStatus
  families: readonly SystemFontFamily[]
  message: string | null
}

type QueryLocalFonts = () => Promise<readonly LocalFontFace[]>

interface LocalFontAccessWindow extends Window {
  queryLocalFonts?: QueryLocalFonts
}

const familyCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

function quotedCssFamily(family: string) {
  return JSON.stringify(family)
}

function normalizedSearchText(...parts: Array<string | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase()
}

function normalizedFamilyName(value: unknown) {
  if (typeof value !== "string") return null
  const family = value.trim().replace(/\s+/g, " ")
  if (
    family.length === 0 ||
    family.length > MAX_FONT_FAMILY_NAME_LENGTH ||
    /\p{Cc}/u.test(family)
  ) {
    return null
  }
  return family
}

function familyKey(family: string) {
  return family.normalize("NFKC").toLocaleLowerCase()
}

function includedOption(
  value: string,
  label: string,
  searchTerms: string,
  purpose: FontPickerPurpose
): FontFamilyOption {
  return Object.freeze({
    value,
    label,
    cssFamily: quotedCssFamily(value),
    source: "included" as const,
    purpose,
    searchText: normalizedSearchText(label, searchTerms),
  })
}

function genericOption(
  value: string,
  label: string,
  searchTerms: string,
  purpose: FontPickerPurpose
): FontFamilyOption {
  return Object.freeze({
    value,
    label,
    cssFamily: value,
    source: "generic" as const,
    purpose,
    searchText: normalizedSearchText(label, value, searchTerms),
  })
}

/** Fonts shipped in the application bundle and therefore always available. */
export const INCLUDED_FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] =
  Object.freeze([
    includedOption(
      "Inter Variable",
      "Inter",
      "sans sans-serif variable",
      "regular"
    ),
    includedOption(
      "Geist Variable",
      "Geist",
      "sans sans-serif variable",
      "regular"
    ),
    includedOption(
      "Manrope Variable",
      "Manrope",
      "sans sans-serif geometric variable",
      "regular"
    ),
    includedOption(
      "DM Sans Variable",
      "DM Sans",
      "sans sans-serif humanist variable",
      "regular"
    ),
    includedOption(
      "Space Grotesk Variable",
      "Space Grotesk",
      "sans sans-serif grotesk variable",
      "regular"
    ),
    includedOption(
      "Atkinson Hyperlegible Next Variable",
      "Atkinson Hyperlegible Next",
      "sans sans-serif accessible legible variable",
      "regular"
    ),
    includedOption(
      "IBM Plex Sans Variable",
      "IBM Plex Sans",
      "sans sans-serif humanist variable",
      "regular"
    ),
    includedOption(
      "Newsreader Variable",
      "Newsreader",
      "serif reading editorial variable",
      "regular"
    ),
    includedOption(
      "Cascadia Code Variable",
      "Cascadia Code",
      "mono monospace code variable",
      "monospace"
    ),
    includedOption(
      "JetBrains Mono Variable",
      "JetBrains Mono",
      "mono monospace code programming ligatures variable",
      "monospace"
    ),
    includedOption(
      "Fira Code Variable",
      "Fira Code",
      "mono monospace code programming ligatures variable",
      "monospace"
    ),
    includedOption(
      "Geist Mono Variable",
      "Geist Mono",
      "mono monospace code variable",
      "monospace"
    ),
    includedOption(
      "Source Code Pro Variable",
      "Source Code Pro",
      "mono monospace code variable",
      "monospace"
    ),
    includedOption(
      "Google Sans Code Variable",
      "Google Sans Code",
      "mono monospace code programming variable",
      "monospace"
    ),
  ])

/** CSS generic families that do not require local-font permission. */
export const GENERIC_FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] =
  Object.freeze([
    genericOption(
      "system-ui",
      "System UI",
      "interface sans sans-serif",
      "regular"
    ),
    genericOption("sans-serif", "Sans serif", "sans", "regular"),
    genericOption("serif", "Serif", "book prose", "regular"),
    genericOption(
      "ui-monospace",
      "System monospace",
      "mono code fixed",
      "monospace"
    ),
    genericOption("monospace", "Monospace", "mono code fixed", "monospace"),
  ])

const GENERIC_OPTIONS_BY_VALUE = new Map(
  GENERIC_FONT_FAMILY_OPTIONS.map((option) => [option.value, option])
)

/**
 * Produces the CSS stack used by the document and font-picker previews.
 * Generic values must remain unquoted or CSS will treat them as local names.
 */
export function fontFamilyCssStack(value: string, purpose: FontPickerPurpose) {
  const selected =
    GENERIC_OPTIONS_BY_VALUE.get(value)?.cssFamily ?? quotedCssFamily(value)
  const fallback =
    purpose === "monospace"
      ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
      : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  return `${selected}, ${fallback}`
}

/** Converts Local Font Access face records into one stable row per family. */
export function dedupeSystemFontFamilies(
  faces: readonly LocalFontFace[]
): readonly SystemFontFamily[] {
  const families = new Map<
    string,
    { family: string; faceCount: number; styles: Set<string> }
  >()

  for (const face of faces) {
    const family = normalizedFamilyName(face.family)
    if (!family) continue

    const key = familyKey(family)
    const existing = families.get(key)
    const style = normalizedFamilyName(face.style)

    if (existing) {
      existing.faceCount += 1
      if (style) existing.styles.add(style)
      continue
    }

    families.set(key, {
      family,
      faceCount: 1,
      styles: new Set(style ? [style] : []),
    })
  }

  return Array.from(families.values())
    .sort((left, right) => familyCollator.compare(left.family, right.family))
    .map(({ family, faceCount, styles }) =>
      Object.freeze({
        family,
        faceCount,
        styles: Object.freeze(
          Array.from(styles).sort((left, right) =>
            familyCollator.compare(left, right)
          )
        ),
      })
    )
}

function systemFamilyOption(family: SystemFontFamily): FontFamilyOption {
  return Object.freeze({
    value: family.family,
    label: family.family,
    cssFamily: quotedCssFamily(family.family),
    source: "system" as const,
    searchText: normalizedSearchText(family.family, ...family.styles),
    faceCount: family.faceCount,
  })
}

function prioritizedOptions(
  options: readonly FontFamilyOption[],
  firstValue: string
) {
  return [...options].sort((left, right) => {
    if (left.value === firstValue) return -1
    if (right.value === firstValue) return 1
    return 0
  })
}

/** Builds a deduplicated picker list with useful choices before system fonts. */
export function buildFontFamilyOptions(
  systemFamilies: readonly SystemFontFamily[],
  purpose: FontPickerPurpose,
  additionalOptions: readonly FontFamilyOption[] = []
): readonly FontFamilyOption[] {
  const included = prioritizedOptions(
    INCLUDED_FONT_FAMILY_OPTIONS.filter((option) => option.purpose === purpose),
    purpose === "monospace" ? "Cascadia Code Variable" : "Inter Variable"
  )
  const generic = prioritizedOptions(
    GENERIC_FONT_FAMILY_OPTIONS.filter((option) => option.purpose === purpose),
    purpose === "monospace" ? "ui-monospace" : "system-ui"
  )
  const combined = [
    ...additionalOptions,
    ...included,
    ...generic,
    ...systemFamilies.map(systemFamilyOption),
  ]
  const seen = new Set<string>()

  return combined.filter((option) => {
    const key = familyKey(option.value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function currentFontFamilyOption(value: string): FontFamilyOption {
  return {
    value,
    label: value,
    cssFamily:
      GENERIC_OPTIONS_BY_VALUE.get(value)?.cssFamily ?? quotedCssFamily(value),
    source: "current",
    searchText: normalizedSearchText(value),
  }
}

export function fontFamilyOptionMatches(
  option: FontFamilyOption,
  query: string
) {
  const terms = normalizedSearchText(query).split(/\s+/).filter(Boolean)
  return terms.every((term) => option.searchText.includes(term))
}

const IDLE_SNAPSHOT: SystemFontCatalogSnapshot = Object.freeze({
  status: "idle",
  families: Object.freeze([]),
  message: null,
})

let catalogSnapshot = IDLE_SNAPSHOT
let pendingRequest: Promise<SystemFontCatalogSnapshot> | null = null
const catalogListeners = new Set<() => void>()

function publishCatalogSnapshot(snapshot: SystemFontCatalogSnapshot) {
  catalogSnapshot = Object.freeze(snapshot)
  for (const listener of catalogListeners) listener()
}

export function getSystemFontCatalogSnapshot() {
  return catalogSnapshot
}

export function subscribeToSystemFontCatalog(listener: () => void) {
  catalogListeners.add(listener)
  return () => catalogListeners.delete(listener)
}

function failedSnapshot(error: unknown): SystemFontCatalogSnapshot {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return {
      status: "denied",
      families: Object.freeze([]),
      message: "Access to installed fonts was not allowed.",
    }
  }

  return {
    status: "error",
    families: Object.freeze([]),
    message:
      error instanceof DOMException && error.name === "SecurityError"
        ? "Installed fonts are unavailable in this window."
        : "Installed fonts could not be loaded.",
  }
}

/**
 * Requests and caches the local family list for this renderer session.
 * Call this synchronously from a user interaction; Local Font Access requires
 * transient user activation when permission has not been granted yet.
 */
export function loadSystemFontCatalog(): Promise<SystemFontCatalogSnapshot> {
  if (catalogSnapshot.status === "ready") {
    return Promise.resolve(catalogSnapshot)
  }
  if (pendingRequest) return pendingRequest

  const localFontWindow = window as LocalFontAccessWindow
  const queryLocalFonts = localFontWindow.queryLocalFonts
  if (typeof queryLocalFonts !== "function") {
    const unsupported: SystemFontCatalogSnapshot = {
      status: "unsupported",
      families: Object.freeze([]),
      message: "This version of Chromium cannot list installed fonts.",
    }
    publishCatalogSnapshot(unsupported)
    return Promise.resolve(catalogSnapshot)
  }

  publishCatalogSnapshot({
    status: "loading",
    families: catalogSnapshot.families,
    message: null,
  })

  let fontQuery: Promise<readonly LocalFontFace[]>
  try {
    // Start the powerful-feature request before yielding user activation.
    fontQuery = queryLocalFonts.call(localFontWindow)
  } catch (error) {
    const failed = failedSnapshot(error)
    publishCatalogSnapshot(failed)
    return Promise.resolve(catalogSnapshot)
  }

  pendingRequest = fontQuery
    .then((faces) => {
      const ready: SystemFontCatalogSnapshot = {
        status: "ready",
        families: dedupeSystemFontFamilies(faces),
        message: null,
      }
      publishCatalogSnapshot(ready)
      return catalogSnapshot
    })
    .catch((error: unknown) => {
      const failed = failedSnapshot(error)
      publishCatalogSnapshot(failed)
      return catalogSnapshot
    })
    .finally(() => {
      pendingRequest = null
    })

  return pendingRequest
}
