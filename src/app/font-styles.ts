import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"

type FontStyleLoader = () => Promise<unknown>

const loadGeistWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/geist/wght.css")
)
const loadGeistItalicStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/geist/wght-italic.css")
)
const loadManropeWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/manrope/wght.css")
)
const loadDmSansWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/dm-sans/wght.css")
)
const loadDmSansItalicStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/dm-sans/wght-italic.css")
)
const loadSpaceGroteskWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/space-grotesk/wght.css")
)
const loadAtkinsonWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/atkinson-hyperlegible-next/wght.css")
)
const loadAtkinsonItalicStyle = createRetryableDynamicImport(
  () =>
    import("@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css")
)
const loadIbmPlexSansWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/ibm-plex-sans/wght.css")
)
const loadIbmPlexSansItalicStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/ibm-plex-sans/wght-italic.css")
)
const loadNewsreaderWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/newsreader/wght.css")
)
const loadNewsreaderItalicStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/newsreader/wght-italic.css")
)
const loadJetBrainsMonoWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/jetbrains-mono/wght.css")
)
const loadFiraCodeWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/fira-code/wght.css")
)
const loadGeistMonoWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/geist-mono/wght.css")
)
const loadSourceCodeProWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/source-code-pro/wght.css")
)
const loadGoogleSansCodeWeightStyle = createRetryableDynamicImport(
  () => import("@fontsource-variable/google-sans-code/wght.css")
)

const styleLoaders: Readonly<Record<string, FontStyleLoader>> = {
  "Geist Variable": () =>
    Promise.all([loadGeistWeightStyle(), loadGeistItalicStyle()]),
  "Manrope Variable": loadManropeWeightStyle,
  "DM Sans Variable": () =>
    Promise.all([loadDmSansWeightStyle(), loadDmSansItalicStyle()]),
  "Space Grotesk Variable": loadSpaceGroteskWeightStyle,
  "Atkinson Hyperlegible Next Variable": () =>
    Promise.all([loadAtkinsonWeightStyle(), loadAtkinsonItalicStyle()]),
  "IBM Plex Sans Variable": () =>
    Promise.all([loadIbmPlexSansWeightStyle(), loadIbmPlexSansItalicStyle()]),
  "Newsreader Variable": () =>
    Promise.all([loadNewsreaderWeightStyle(), loadNewsreaderItalicStyle()]),
  "JetBrains Mono Variable": loadJetBrainsMonoWeightStyle,
  "Fira Code Variable": loadFiraCodeWeightStyle,
  "Geist Mono Variable": loadGeistMonoWeightStyle,
  "Source Code Pro Variable": loadSourceCodeProWeightStyle,
  "Google Sans Code Variable": loadGoogleSansCodeWeightStyle,
}

const pendingStyles = new Map<string, Promise<void>>()

export function loadIncludedFontFamilyStyle(family: string): Promise<void> {
  const loader = styleLoaders[family]
  if (!loader) return Promise.resolve()
  const existing = pendingStyles.get(family)
  if (existing) return existing
  const pending = loader().then(() => undefined)
  pendingStyles.set(family, pending)
  void pending.catch(() => {
    if (pendingStyles.get(family) === pending) pendingStyles.delete(family)
  })
  return pending
}

export function loadIncludedFontFamilyStyles(
  regularFamily: string,
  monospaceFamily: string
) {
  return Promise.all([
    loadIncludedFontFamilyStyle(regularFamily),
    loadIncludedFontFamilyStyle(monospaceFamily),
  ]).then(() => undefined)
}
