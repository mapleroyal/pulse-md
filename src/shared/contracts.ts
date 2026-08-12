export type EditorMode = "live" | "source"
export type DocumentKind = "markdown" | "plain-text"
export type AppPlatform = "darwin" | "linux" | "win32"
export type ScratchLinkScheme =
  "pulse-md" | "pulse-md-local" | "pulse-md-development"
export type TabId = string
export type WindowId = number
export type TransferId = string
export const SERIALIZED_EDITOR_SESSION_VERSION = 4
export const APPEARANCE_MODES = ["light", "system", "dark"] as const
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]
export type ResolvedAppearance = Exclude<AppearanceMode, "system">

export const SYNTAX_THEME_IDS = [
  "default",
  "one-dark",
  "dracula",
  "nord",
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "github-light",
  "github-dark",
  "solarized-light",
  "solarized-dark",
  "gruvbox-light",
  "gruvbox-dark",
  "rose-pine-dawn",
  "rose-pine-moon",
  "tokyo-day",
  "tokyo-night",
  "monokai",
  "xcode",
] as const
export type SyntaxThemeId = (typeof SYNTAX_THEME_IDS)[number]

export const THEME_BACKGROUND_IDS = SYNTAX_THEME_IDS
export const NEUTRAL_BACKGROUND_IDS = ["light", "dark", "black"] as const
export const BACKGROUND_IDS = [
  ...THEME_BACKGROUND_IDS,
  ...NEUTRAL_BACKGROUND_IDS,
  "custom",
] as const
export type BackgroundId = (typeof BACKGROUND_IDS)[number]
export type FixedBackgroundId = Exclude<BackgroundId, "custom">

export const BACKGROUND_COLORS: Readonly<Record<FixedBackgroundId, string>> = {
  default: "#ffffff",
  "one-dark": "#282c34",
  dracula: "#282a36",
  nord: "#2e3440",
  "catppuccin-latte": "#eff1f5",
  "catppuccin-frappe": "#303446",
  "catppuccin-macchiato": "#24273a",
  "catppuccin-mocha": "#1e1e2e",
  "github-light": "#ffffff",
  "github-dark": "#0d1117",
  "solarized-light": "#fdf6e3",
  "solarized-dark": "#002b36",
  "gruvbox-light": "#fbf1c7",
  "gruvbox-dark": "#282828",
  "rose-pine-dawn": "#faf4ed",
  "rose-pine-moon": "#232136",
  "tokyo-day": "#e1e2e7",
  "tokyo-night": "#1a1b26",
  monokai: "#272822",
  xcode: "#ffffff",
  light: "#ffffff",
  dark: "#181818",
  black: "#09090b",
}

export const BACKGROUND_FOREGROUNDS: Readonly<
  Record<FixedBackgroundId, string>
> = {
  default: "#171717",
  "one-dark": "#abb2bf",
  dracula: "#f8f8f2",
  nord: "#d8dee9",
  "catppuccin-latte": "#4c4f69",
  "catppuccin-frappe": "#c6d0f5",
  "catppuccin-macchiato": "#cad3f5",
  "catppuccin-mocha": "#cdd6f4",
  "github-light": "#24292e",
  "github-dark": "#c9d1d9",
  "solarized-light": "#657b83",
  "solarized-dark": "#839496",
  "gruvbox-light": "#3c3836",
  "gruvbox-dark": "#ebdbb2",
  "rose-pine-dawn": "#575279",
  "rose-pine-moon": "#e0def4",
  "tokyo-day": "#3760bf",
  "tokyo-night": "#c0caf5",
  monokai: "#f8f8f2",
  xcode: "#3d3d3d",
  light: "#171717",
  dark: "#f5f5f5",
  black: "#f5f5f5",
}

export const BACKGROUND_SURFACE_SCHEMES: Readonly<
  Record<FixedBackgroundId, ResolvedAppearance>
> = {
  default: "light",
  "one-dark": "dark",
  dracula: "dark",
  nord: "dark",
  "catppuccin-latte": "light",
  "catppuccin-frappe": "dark",
  "catppuccin-macchiato": "dark",
  "catppuccin-mocha": "dark",
  "github-light": "light",
  "github-dark": "dark",
  "solarized-light": "light",
  "solarized-dark": "dark",
  "gruvbox-light": "light",
  "gruvbox-dark": "dark",
  "rose-pine-dawn": "light",
  "rose-pine-moon": "dark",
  "tokyo-day": "light",
  "tokyo-night": "dark",
  monokai: "dark",
  xcode: "light",
  light: "light",
  dark: "dark",
  black: "dark",
}

export interface AppearanceProfile {
  backgroundId: BackgroundId
  customBackgroundColor: string
  syntaxThemeId: SyntaxThemeId
}

export interface ResolvedAppearanceProfile {
  backgroundColor: string
  foregroundColor: string
  mutedForegroundColor: string
  surfaceTintColor: string
  surfaceScheme: ResolvedAppearance
}

export function normalizeHexColor(value: string): string | null {
  const source = value.trim().replace(/^#/, "")
  if (/^[\da-f]{3}$/i.test(source)) {
    return `#${[...source]
      .map((character) => character.repeat(2))
      .join("")}`.toLowerCase()
  }
  return /^[\da-f]{6}$/i.test(source) ? `#${source.toLowerCase()}` : null
}

function channelLuminance(channel: number) {
  const value = channel / 255
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(color: string) {
  const source = color.slice(1)
  const red = Number.parseInt(source.slice(0, 2), 16)
  const green = Number.parseInt(source.slice(2, 4), 16)
  const blue = Number.parseInt(source.slice(4, 6), 16)
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  )
}

export function colorContrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function mixHexColors(from: string, to: string, amount: number) {
  const channels = (color: string) => [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]
  const fromChannels = channels(from)
  const toChannels = channels(to)
  const mixed = fromChannels.map((channel, index) =>
    Math.round(channel + (toChannels[index]! - channel) * amount)
  )
  return `#${mixed
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`
}

interface ContrastCandidate {
  amount: number
  color: string
}

function contrastCandidate(
  color: string,
  background: string,
  target: string,
  minimumRatio: number
): ContrastCandidate | null {
  if (colorContrastRatio(target, background) < minimumRatio) return null

  // A palette color may start on either luminance side of its background, so
  // the contrast curve is not necessarily monotonic over the entire mix.
  // Locate the first passing interval before refining it.
  const steps = 100
  let lower = 0
  let upper = 1
  let found = false
  for (let step = 1; step <= steps; step += 1) {
    const amount = step / steps
    const candidate = mixHexColors(color, target, amount)
    if (colorContrastRatio(candidate, background) < minimumRatio) {
      lower = amount
      continue
    }
    upper = amount
    found = true
    break
  }
  if (!found) return null

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const amount = (lower + upper) / 2
    const candidate = mixHexColors(color, target, amount)
    if (colorContrastRatio(candidate, background) >= minimumRatio) {
      upper = amount
    } else {
      lower = amount
    }
  }

  return {
    amount: upper,
    color: mixHexColors(color, target, upper),
  }
}

/**
 * Retain a theme color exactly when it is readable. Otherwise, move it the
 * shortest distance toward black or white that reaches the requested
 * contrast. This keeps independently selectable syntax palettes recognizable
 * without allowing a palette/background pairing to make text disappear.
 */
export function ensureColorContrast(
  color: string,
  background: string,
  minimumRatio = 4.5
) {
  const normalizedColor = normalizeHexColor(color)
  const normalizedBackground = normalizeHexColor(background)
  if (!normalizedColor || !normalizedBackground) return color
  if (
    colorContrastRatio(normalizedColor, normalizedBackground) >= minimumRatio
  ) {
    return normalizedColor
  }

  const maximumRatio = Math.max(
    colorContrastRatio("#000000", normalizedBackground),
    colorContrastRatio("#ffffff", normalizedBackground)
  )
  // Mid-tone backgrounds cannot reach enhanced contrast ratios. Fall back to
  // the normal-text target in that narrow range instead of abandoning the
  // correction and returning an unreadable palette color.
  const reachableMinimum =
    maximumRatio >= minimumRatio ? minimumRatio : Math.min(minimumRatio, 4.5)
  const candidates = [
    contrastCandidate(
      normalizedColor,
      normalizedBackground,
      "#000000",
      reachableMinimum
    ),
    contrastCandidate(
      normalizedColor,
      normalizedBackground,
      "#ffffff",
      reachableMinimum
    ),
  ].filter((candidate): candidate is ContrastCandidate => candidate !== null)

  candidates.sort((left, right) => left.amount - right.amount)
  return candidates[0]?.color ?? normalizedColor
}

function readableForeground(backgroundColor: string, preferredColor: string) {
  return ensureColorContrast(preferredColor, backgroundColor)
}

function mutedForeground(backgroundColor: string, foregroundColor: string) {
  const preferredColor = mixHexColors(backgroundColor, foregroundColor, 0.62)
  return ensureColorContrast(preferredColor, backgroundColor)
}

function surfaceTint(backgroundColor: string, foregroundColor: string) {
  if (colorContrastRatio(foregroundColor, backgroundColor) >= 7) {
    return foregroundColor
  }
  return relativeLuminance(foregroundColor) < relativeLuminance(backgroundColor)
    ? "#ffffff"
    : "#000000"
}

function customSurface(color: string): ResolvedAppearanceProfile {
  const lightForeground = "#171717"
  const darkForeground = "#f5f5f5"
  const lightContrast = colorContrastRatio(lightForeground, color)
  const darkContrast = colorContrastRatio(darkForeground, color)
  const surfaceScheme = lightContrast >= darkContrast ? "light" : "dark"
  const foregroundColor = readableForeground(
    color,
    surfaceScheme === "light" ? lightForeground : darkForeground
  )
  return {
    backgroundColor: color,
    foregroundColor,
    mutedForegroundColor: mutedForeground(color, foregroundColor),
    surfaceTintColor: surfaceTint(color, foregroundColor),
    surfaceScheme,
  }
}

export function resolveAppearanceProfile(
  profile: AppearanceProfile
): ResolvedAppearanceProfile {
  if (profile.backgroundId === "custom") {
    return customSurface(
      normalizeHexColor(profile.customBackgroundColor) ?? "#ffffff"
    )
  }

  const backgroundColor = BACKGROUND_COLORS[profile.backgroundId]
  const foregroundColor = readableForeground(
    backgroundColor,
    BACKGROUND_FOREGROUNDS[profile.backgroundId]
  )
  return {
    backgroundColor,
    foregroundColor,
    mutedForegroundColor: mutedForeground(backgroundColor, foregroundColor),
    surfaceTintColor: surfaceTint(backgroundColor, foregroundColor),
    surfaceScheme: BACKGROUND_SURFACE_SCHEMES[profile.backgroundId],
  }
}

export type ThemeByScheme = Readonly<
  Record<ResolvedAppearance, AppearanceProfile>
>

export const MAX_CUSTOM_THEME_PRESET_NAME_LENGTH = 40
export const MIN_BACKGROUND_BLUR_RADIUS = 0
export const MAX_BACKGROUND_BLUR_RADIUS = 50
export const BACKGROUND_BLUR_RADIUS_STEP = 1
export const MIN_BACKGROUND_TRANSLUCENCY = 0
export const MAX_BACKGROUND_TRANSLUCENCY = 1
export const BACKGROUND_TRANSLUCENCY_STEP = 0.05

export const LAUNCH_TRANSITION_EASINGS = [
  "gentle-ease-out",
  "material-ease-out",
  "ease-out",
  "ease-in-out",
  "ease",
  "linear",
  "custom",
] as const
export type LaunchTransitionEasing = (typeof LAUNCH_TRANSITION_EASINGS)[number]

export const LAUNCH_TRANSITION_STRATEGIES = [
  "tint",
  "tint-blur",
  "cover",
] as const
export type LaunchTransitionStrategy =
  (typeof LAUNCH_TRANSITION_STRATEGIES)[number]

export const MIN_LAUNCH_TRANSITION_DURATION_MS = 0
export const MAX_LAUNCH_TRANSITION_DURATION_MS = 10_000
export const MIN_LAUNCH_TRANSITION_DELAY_MS = 0
export const MAX_LAUNCH_TRANSITION_DELAY_MS = 10_000
export const LAUNCH_TRANSITION_TIME_STEP_MS = 50
export const DEFAULT_CUSTOM_LAUNCH_TRANSITION_EASING =
  "cubic-bezier(0.22, 1, 0.36, 1)"

export type CubicBezier = readonly [number, number, number, number]

const launchTransitionEasingCurves: Readonly<
  Record<Exclude<LaunchTransitionEasing, "custom">, CubicBezier>
> = {
  "gentle-ease-out": [0.22, 1, 0.36, 1],
  "material-ease-out": [0.2, 0, 0, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  ease: [0.25, 0.1, 0.25, 1],
  linear: [0, 0, 1, 1],
}

export interface LaunchTransitionSettings {
  customEasing: string
  delayMs: number
  durationMs: number
  easing: LaunchTransitionEasing
  enabled: boolean
  strategy: LaunchTransitionStrategy
}

export function parseLaunchTransitionCubicBezier(
  value: string
): CubicBezier | null {
  const number = "([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))"
  const match = new RegExp(
    `^cubic-bezier\\(\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}\\s*\\)$`,
    "i"
  ).exec(value.trim())
  if (!match) return null
  const points = match.slice(1).map(Number)
  if (
    points.some((point) => !Number.isFinite(point)) ||
    points[0]! < 0 ||
    points[0]! > 1 ||
    points[1]! < 0 ||
    points[1]! > 1 ||
    points[2]! < 0 ||
    points[2]! > 1 ||
    points[3]! < 0 ||
    points[3]! > 1
  ) {
    return null
  }
  return [points[0]!, points[1]!, points[2]!, points[3]!]
}

export function launchTransitionBezier(
  settings: LaunchTransitionSettings
): CubicBezier {
  if (settings.easing !== "custom") {
    return launchTransitionEasingCurves[settings.easing]
  }
  return (
    parseLaunchTransitionCubicBezier(settings.customEasing) ??
    launchTransitionEasingCurves["ease-out"]
  )
}

export function launchTransitionCssEasing(
  settings: LaunchTransitionSettings
): string {
  const [x1, y1, x2, y2] = launchTransitionBezier(settings)
  return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`
}

export function launchTransitionHasAnimation(
  settings: LaunchTransitionSettings
): boolean {
  return settings.enabled && settings.durationMs > 0
}

export interface BackgroundEffectSettings {
  enabled: boolean
  translucentCallouts: boolean
  translucentCodeBlocks: boolean
  translucentInlineCode: boolean
  translucency: number
  blurRadius: number
}

export interface CustomThemePreset {
  id: string
  name: string
  scheme: ResolvedAppearance
  profile: AppearanceProfile
}

export function normalizeCustomThemePresetName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length > 0 &&
    normalized.length <= MAX_CUSTOM_THEME_PRESET_NAME_LENGTH
    ? normalized
    : null
}

export interface AppearanceSettings {
  appearanceMode: AppearanceMode
  themeByScheme: ThemeByScheme
  backgroundEffect: BackgroundEffectSettings
}
export const SOURCE_INDENTATIONS = ["spaces", "tabs"] as const
export type SourceIndentation = (typeof SOURCE_INDENTATIONS)[number]
export const MIN_SOURCE_INDENT_SIZE = 1
export const MAX_SOURCE_INDENT_SIZE = 8
export const MIN_ZOOM_FACTOR = 0.75
export const MAX_ZOOM_FACTOR = 2
export const ZOOM_FACTOR_STEP = 0.05
export const MIN_TYPOGRAPHY_FONT_SIZE = 8
export const MAX_TYPOGRAPHY_FONT_SIZE = 72
export const MIN_HEADING_FONT_SCALE = 0.5
export const MAX_HEADING_FONT_SCALE = 5
export const MAX_FONT_FAMILY_NAME_LENGTH = 120

export type HeadingFontScales = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
]

export type HeadingFontBold = readonly [
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
]

export function normalizeFontFamilyName(value: string): string | null {
  const normalized = value.trim()
  return normalized.length > 0 &&
    normalized.length <= MAX_FONT_FAMILY_NAME_LENGTH &&
    !/\p{Cc}/u.test(normalized)
    ? normalized
    : null
}

export const FILE_PATH_DISPLAY_MODES = ["path", "filename"] as const
export type FilePathDisplayMode = (typeof FILE_PATH_DISPLAY_MODES)[number]
export const FORMATTING_BAR_POSITIONS = ["left", "center", "right"] as const
export type FormattingBarPosition = (typeof FORMATTING_BAR_POSITIONS)[number]
export const TAB_VISIBILITY_MODES = [
  "always",
  "multiple-tabs",
  "mouseover",
  "formatting-bar",
  "hidden",
] as const
export type TabVisibilityMode = (typeof TAB_VISIBILITY_MODES)[number]
export const TAB_WHEEL_SCROLL_DIRECTIONS = ["down-right", "down-left"] as const
export type TabWheelScrollDirection =
  (typeof TAB_WHEEL_SCROLL_DIRECTIONS)[number]
export const ACTIVE_TAB_INDICATOR_POSITIONS = [
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "top-left",
] as const
export type ActiveTabIndicatorPosition =
  (typeof ACTIVE_TAB_INDICATOR_POSITIONS)[number]
export const ACTIVE_TAB_INDICATOR_COLOR_SOURCES = [
  "theme-accent",
  "foreground",
  "focus-ring",
  "custom",
] as const
export type ActiveTabIndicatorColorSource =
  (typeof ACTIVE_TAB_INDICATOR_COLOR_SOURCES)[number]
export const MIN_ACTIVE_TAB_INDICATOR_THICKNESS = 1
export const MAX_ACTIVE_TAB_INDICATOR_THICKNESS = 10
export const MIN_ACTIVE_TAB_INDICATOR_ADAPTIVE_CONTRAST = 3

export function activeTabIndicatorAdaptiveColor(
  color: string,
  activeTabSurface: string
) {
  return ensureColorContrast(
    color,
    activeTabSurface,
    MIN_ACTIVE_TAB_INDICATOR_ADAPTIVE_CONTRAST
  )
}

export interface ActiveTabIndicatorSettings {
  positions: ActiveTabIndicatorPosition[]
  colorSource: ActiveTabIndicatorColorSource
  customColor: string
  adaptCustomColor: boolean
  thickness: number
}

export interface StatusBarItems {
  words: boolean
  lines: boolean
  characters: boolean
  cursorPosition: boolean
  encoding: boolean
  lineEnding: boolean
}

export const TOP_RIGHT_CONTROL_KEYS = [
  "navigation",
  "viewMode",
  "find",
  "outline",
  "formattingToolbar",
  "settings",
] as const
export type TopRightControlKey = (typeof TOP_RIGHT_CONTROL_KEYS)[number]

export type TopRightControls = Record<TopRightControlKey, boolean>

export interface ChromeSettings {
  activeTabIndicator: ActiveTabIndicatorSettings
  tabVisibility: TabVisibilityMode
  tabWheelScrollDirection: TabWheelScrollDirection
  alwaysShowTopControls: boolean
  topRightControls: TopRightControls
  showFormattingBar: boolean
  formattingBarPosition: FormattingBarPosition
  showCenteredPath: boolean
  centeredPathDisplay: FilePathDisplayMode
  tabDisplay: FilePathDisplayMode
  alwaysShowStatusBar: boolean
  statusItems: StatusBarItems
}

export type EditorCommand =
  | "find"
  | "find-next"
  | "find-previous"
  | "replace"
  | "use-selection-for-find"
  | "focus-editor"
  | "open-outline"
  | "keyboard-shortcuts"
  | "software-licenses"
  | "settings"
  | "open-window-profile-picker"
  | "open-scratch-picker"
  | "new-scratch"
  | "save-as-scratch"
  | "update-current-window-profile"
  | "create-window-profile-from-tabs"
  | "toggle-mode"
  | "toggle-wrap"
  | "toggle-formatting-bar"
  | "toggle-status-bar"
  | `set-tab-visibility-${TabVisibilityMode}`
  | "save"
  | "save-as"
  | "open"
  | "new-tab"
  | "navigate-back"
  | "navigate-forward"
  | "close-tab"
  | "close-window"
  | "undo"
  | "redo"
  | "select-all"
  | "format-bold"
  | "format-italic"
  | "format-strikethrough"
  | "format-inline-code"
  | "format-link"
  | "format-image"
  | `format-heading-${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | "format-bullet-list"
  | "format-ordered-list"
  | "format-task-list"
  | "format-blockquote"
  | "format-code-block"
  | "format-horizontal-rule"
  | "format-table"
  | "prepare-window-close"
  | "save-and-close"

export interface EditorMenuState {
  canRedo: boolean
  canUndo: boolean
  documentKind: DocumentKind
  editorFocused: boolean
  hasSelection: boolean
  mode: EditorMode
  settingsDialogOpen: boolean
  settingsWorkspaceOpen: boolean
  softwareLicensesOpen: boolean
}

export interface MarkdownExtensionSettings {
  superscriptAndSubscript: boolean
  emojiRecognition: boolean
  emojiExpansion: boolean
  footnotes: boolean
  definitionLists: boolean
  latex: boolean
  mermaid: boolean
  yamlFrontMatter: boolean
  sanitizedHtml: boolean
}

export interface AppSettings extends AppearanceSettings {
  customThemePresets: CustomThemePreset[]
  defaultWindowProfileId: string | null
  initialEditorMode: EditorMode
  keepReadyInBackground: boolean
  lineWrapping: boolean
  spellCheck: boolean
  markdownExtensions: MarkdownExtensionSettings
  launchTransition: LaunchTransitionSettings
  zoomFactor: number
  regularFontFamily: string
  monospaceFontFamily: string
  baseFontSize: number
  codeFontSize: number
  headingFontScales: HeadingFontScales
  headingFontBold: HeadingFontBold
  calloutTitleFontSize: number
  fontLigatures: boolean
  maxContentWidth: number
  sourceIndentation: SourceIndentation
  sourceIndentSize: number
  chrome: ChromeSettings
}

export const SETTINGS_EXPORT_FORMAT = "pulse-md-settings"
export const SETTINGS_EXPORT_VERSION = 3

export interface SettingsTransferOptions {
  profiles: boolean
  scratches: boolean
}

export const DEFAULT_SETTINGS_TRANSFER_OPTIONS: SettingsTransferOptions = {
  profiles: true,
  scratches: true,
}

export const SETTINGS_IMPORT_ACTIONABLE_ERRORS = {
  profileOpen:
    "Close every window using an imported Window Profile before importing it.",
  scratchOpen: "Close the scratches in this transfer before importing them.",
  stageUnavailable: "The staged Settings import is no longer available.",
} as const

export interface SettingsTransferProfileSummary {
  id: string
  name: string
}

export interface SettingsScratchSnapshotRequest {
  maximumContentBytes: number
  requestId: string
  tabIds: readonly TabId[]
}

export interface SettingsScratchSnapshotEntry {
  content: string
  revision: number
  tabId: TabId
}

export type SettingsScratchSnapshotResponse =
  | {
      requestId: string
      status: "ok"
      tabs: readonly SettingsScratchSnapshotEntry[]
    }
  | {
      reason: "changed" | "too-large"
      requestId: string
      status: "unavailable"
    }

export type ExportSettingsResult =
  | { status: "cancelled" }
  | {
      status: "exported"
      filePath: string
      profileCount: number
      scratchCount: number
    }

export type ImportSettingsResult =
  | { status: "cancelled" }
  | {
      status: "imported"
      filePath: string
      importId: string
      profiles: readonly SettingsTransferProfileSummary[]
      scratchCount: number
      settings: AppSettings
    }

export interface PathCompletionEntry {
  kind: "directory" | "file"
  name: string
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  appearanceMode: "system",
  themeByScheme: {
    light: {
      backgroundId: "default",
      customBackgroundColor: "#ffffff",
      syntaxThemeId: "default",
    },
    dark: {
      backgroundId: "dark",
      customBackgroundColor: "#181818",
      syntaxThemeId: "one-dark",
    },
  },
  backgroundEffect: {
    enabled: false,
    translucentCallouts: true,
    translucentCodeBlocks: true,
    translucentInlineCode: false,
    translucency: 0.15,
    blurRadius: 25,
  },
  customThemePresets: [],
  defaultWindowProfileId: null,
  initialEditorMode: "live",
  keepReadyInBackground: false,
  lineWrapping: true,
  spellCheck: true,
  markdownExtensions: {
    superscriptAndSubscript: false,
    emojiRecognition: false,
    emojiExpansion: false,
    footnotes: false,
    definitionLists: false,
    latex: false,
    mermaid: false,
    yamlFrontMatter: false,
    sanitizedHtml: false,
  },
  launchTransition: {
    customEasing: DEFAULT_CUSTOM_LAUNCH_TRANSITION_EASING,
    delayMs: 150,
    durationMs: 2_000,
    easing: "ease-out",
    enabled: false,
    strategy: "tint-blur",
  },
  zoomFactor: 1,
  regularFontFamily: "Inter Variable",
  monospaceFontFamily: "Cascadia Code Variable",
  baseFontSize: 20,
  codeFontSize: 20,
  headingFontScales: [2.3, 1.9, 1.6, 1.3, 1.15, 1],
  headingFontBold: [true, true, true, true, true, true],
  calloutTitleFontSize: 20,
  fontLigatures: true,
  maxContentWidth: 960,
  sourceIndentation: "spaces",
  sourceIndentSize: 2,
  chrome: {
    activeTabIndicator: {
      positions: ["left"],
      colorSource: "focus-ring",
      customColor: "#3b82f6",
      adaptCustomColor: false,
      thickness: 5,
    },
    tabVisibility: "multiple-tabs",
    tabWheelScrollDirection: "down-right",
    alwaysShowTopControls: false,
    topRightControls: {
      navigation: true,
      viewMode: true,
      find: true,
      outline: true,
      formattingToolbar: true,
      settings: true,
    },
    showFormattingBar: false,
    formattingBarPosition: "center",
    showCenteredPath: true,
    centeredPathDisplay: "path",
    tabDisplay: "path",
    alwaysShowStatusBar: false,
    statusItems: {
      words: true,
      lines: true,
      characters: true,
      cursorPosition: true,
      encoding: true,
      lineEnding: true,
    },
  },
}

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    backgroundEffect: { ...settings.backgroundEffect },
    themeByScheme: {
      light: { ...settings.themeByScheme.light },
      dark: { ...settings.themeByScheme.dark },
    },
    customThemePresets: settings.customThemePresets.map((preset) => ({
      ...preset,
      profile: { ...preset.profile },
    })),
    markdownExtensions: { ...settings.markdownExtensions },
    launchTransition: { ...settings.launchTransition },
    headingFontScales: [...settings.headingFontScales],
    headingFontBold: [...settings.headingFontBold],
    chrome: {
      ...settings.chrome,
      activeTabIndicator: {
        ...settings.chrome.activeTabIndicator,
        positions: [...settings.chrome.activeTabIndicator.positions],
      },
      topRightControls: { ...settings.chrome.topRightControls },
      statusItems: { ...settings.chrome.statusItems },
    },
  }
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function settingsValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => settingsValuesEqual(value, right[index]))
    )
  }
  if (!isSettingsRecord(left) || !isSettingsRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && settingsValuesEqual(left[key], right[key])
    )
  )
}

function rebaseSettingsValue(
  current: unknown,
  baseline: unknown,
  submitted: unknown
): unknown {
  if (settingsValuesEqual(baseline, submitted)) return current
  if (
    !isSettingsRecord(current) ||
    !isSettingsRecord(baseline) ||
    !isSettingsRecord(submitted)
  ) {
    return submitted
  }

  const rebased: Record<string, unknown> = { ...current }
  for (const key of Object.keys(submitted)) {
    rebased[key] = rebaseSettingsValue(
      current[key],
      baseline[key],
      submitted[key]
    )
  }
  return rebased
}

/**
 * Applies only the settings fields changed by one renderer to the latest
 * application settings. Arrays are atomic settings values; nested settings
 * objects retain unrelated changes committed by sibling windows.
 */
export function rebaseAppSettings(
  current: AppSettings,
  baseline: AppSettings,
  submitted: AppSettings
): AppSettings {
  return cloneAppSettings(
    rebaseSettingsValue(current, baseline, submitted) as AppSettings
  )
}

export interface DocumentFormat {
  hasUtf8Bom: boolean
  lineEnding: "\n" | "\r\n"
}

export interface DocumentSnapshot {
  content: string
  displayName: string
  filePath: string | null
  format: DocumentFormat
  kind: DocumentKind
  mtimeMs: number | null
}

export type DocumentMetadata = Omit<DocumentSnapshot, "content">

export const TAB_BACKING_KINDS = [
  "file",
  "untitled",
  "ephemeral",
  "scratch",
] as const
export type TabBackingKind = (typeof TAB_BACKING_KINDS)[number]

export const TAB_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
] as const
export type TabColor = (typeof TAB_COLORS)[number]

export interface ExternalDocumentChange {
  changeId: string
  document: DocumentSnapshot
  expectedMtimeMs: number | null
  tabId: TabId
}

export interface TabDescriptor {
  id: TabId
  backing: TabBackingKind
  color?: TabColor
  dirty: boolean
  displayName: string
  fileMissing: boolean
  filePath: string | null
  kind: DocumentKind
}

export type WindowProfileTabVisibility = TabVisibilityMode | "inherit"
export type WindowProfileTabKind = TabBackingKind

interface WindowProfileTabBase {
  readonly id: string
  readonly title?: string
  readonly color?: TabColor
  readonly mode?: EditorMode
}

export interface WindowProfileFileTab extends WindowProfileTabBase {
  readonly kind: "file"
  readonly path: string
}

export interface WindowProfileUntitledTab extends WindowProfileTabBase {
  readonly kind: "untitled"
}

export interface WindowProfileEphemeralTab extends WindowProfileTabBase {
  readonly kind: "ephemeral"
}

export interface ScratchDocumentIdentity {
  readonly scratchId: string
}

export interface WindowProfileScratchTab extends WindowProfileTabBase {
  readonly kind: "scratch"
  readonly scratchId: string
}

export type WindowProfileTab =
  | WindowProfileFileTab
  | WindowProfileUntitledTab
  | WindowProfileEphemeralTab
  | WindowProfileScratchTab

export interface WindowProfile {
  readonly version: 2
  readonly id: string
  readonly name: string
  readonly activeTab: string
  readonly tabVisibility: WindowProfileTabVisibility
  readonly mode?: EditorMode
  readonly tabs: readonly WindowProfileTab[]
}

export interface WindowProfileEntry {
  readonly open: boolean
  readonly profile: WindowProfile
}

export interface WindowProfilesSnapshot {
  readonly currentProfileId: string | null
  readonly defaultProfileId: string | null
  readonly profiles: readonly WindowProfileEntry[]
}

export type ScratchSortOrder =
  "last-opened" | "last-edited" | "created" | "title" | "filename"

export type ScratchInventoryScope = "scratch-browser" | "window-profiles"

export interface ScratchProfileReference {
  readonly id: string
  readonly name: string
}

export interface ScratchEntry {
  readonly byteLength: number
  readonly createdAt: number
  readonly displayTitle: string
  readonly excerpt: string
  readonly fileName: string
  readonly firstHeading: string | null
  readonly lastOpenedAt: number | null
  readonly modifiedAt: number
  readonly open: boolean
  readonly profiles: readonly ScratchProfileReference[]
  readonly revision: string
  readonly scratchId: string
  readonly title: string | null
}

export interface ScratchInventory {
  readonly entries: readonly ScratchEntry[]
  readonly profileReferencesAvailable: boolean
}

export interface ScratchPreview {
  readonly content: string
  readonly displayTitle: string
  readonly fileName: string
  readonly format: DocumentFormat
  readonly modifiedAt: number
  readonly revision: string
  readonly scratchId: string
  readonly truncated: boolean
}

export interface ScratchUpdate {
  readonly fileName?: string
  readonly title?: string | null
}

export type ScratchOpenDisposition = "default" | "new-tab"

export interface WindowProfileFileChoice {
  readonly displayName: string
  readonly path: string
}

export interface WindowProfileTabMode {
  readonly mode: EditorMode
  readonly tabId: TabId
}

export interface WindowProfileSeed {
  readonly activeTab: string
  readonly tabs: readonly WindowProfileTab[]
}

export type WindowProfileCaptureKind = "create" | "update"

export interface WindowProfilePickerRequest {
  readonly requestId: string
}

export type WindowProfileLaunchResult =
  "focused-existing" | "opened-window" | "reused-window"

export interface EditorViewport {
  pos: number
  screenOffset: number
  scrollLeft: number
  scrollTop: number
}

export interface SerializedEditorSession {
  version: typeof SERIALIZED_EDITOR_SESSION_VERSION
  state: unknown
  baselineContent: string
  documentKind: DocumentKind
  mode: EditorMode
  lineWrapping: boolean
  caretVisible: boolean
  viewport: EditorViewport
  viewportInitialized: boolean
  revision: number
}

export interface BootstrapTab {
  tab: TabDescriptor
  document: DocumentSnapshot
  baselineContent?: string
  editorSession?: SerializedEditorSession
  initialViewport?: EditorViewport
  initialEditorMode?: EditorMode
  initialCursor?: { line: number; column: number }
}

export interface WindowTabsSnapshot {
  windowId: WindowId
  activeTabId: TabId
  tabDragSink: boolean
  tabs: TabDescriptor[]
}

export interface BootstrapPayload {
  activeTabId: TabId
  activeTab: BootstrapTab
  platform: AppPlatform
  persistedSettings: AppSettings
  settings: AppSettings
  tabDragSink: boolean
  tabs: TabDescriptor[]
  windowActive: boolean
  windowId: WindowId
}

export interface WindowSettingsSnapshot {
  effective: AppSettings
  persisted: AppSettings
}

export interface LaunchVisualEffectReady {
  transition: LaunchTransitionSettings | null
}

export interface CliTabsOpenRequest {
  requestId: string
  tabs: BootstrapTab[]
  activeTabId: TabId
  editorMode?: EditorMode
  replaceTabId?: TabId
}

export interface CliTabsOpenAcknowledgement {
  requestId: string
  accepted: boolean
}

export interface CliEditorFocusRequest {
  requestId: string
  tabId: TabId
}

export interface CliEditorFocusAcknowledgement {
  requestId: string
  accepted: boolean
}

export interface SaveDocumentRequest {
  automatic?: boolean
  tabId: TabId
  content: string
  filePath: string | null
  format: DocumentFormat
  revision: number
  saveAs?: boolean
  saveAsScratch?: boolean
}

export interface SaveDocumentResult {
  document: DocumentMetadata
  revision: number
  saveToken: string
  tab: TabDescriptor
}

export interface SaveDocumentAcknowledgement {
  current: boolean
  revision: number
  saveToken: string
  tabId: TabId
}

export interface OpenDocumentResult {
  openedTabs: BootstrapTab[]
  replacedTabId: TabId | null
  window: WindowTabsSnapshot
}

export type OpenScratchResult =
  | {
      kind: "document"
      openedTab: BootstrapTab
      replacedTabId: TabId | null
      window: WindowTabsSnapshot
    }
  | {
      kind: "existing-document"
      location: "current-window" | "other-window"
      tabId: TabId
    }

export type LocalLinkDisposition = "current-tab" | "new-tab"

export type OpenLocalLinkResult =
  | {
      kind: "document"
      disposition: LocalLinkDisposition
      openedTab: BootstrapTab
      window: WindowTabsSnapshot
    }
  | {
      kind: "existing-document"
      location: "current-window" | "other-window"
      tabId: TabId
    }
  | { kind: "external" }
  | { kind: "save-required" }

export interface OpenExistingLocalLinkRequest {
  fragment: string | null
  tabId: TabId
}

export interface CopiedHeadingLinkMetadata {
  fragment: string
  sourcePath: string | null
  sourceScratch: ScratchDocumentIdentity | null
  sourceTabId: TabId
  version: 3
}

export interface NewTabResult {
  createdTab: BootstrapTab
  window: WindowTabsSnapshot
}

export type CloseDecision = "close" | "save" | "cancel"
export const MAX_SPELL_CHECK_WORD_COUNT = 8_192
export const MAX_SPELLING_SUGGESTION_COUNT = 8
export const MAX_SPELLING_WORD_LENGTH = 256
export const SPELLING_TOKEN_PATTERN_SOURCE = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[.'’_-][\p{L}\p{M}\p{N}]+)*`
const exactSpellingTokenPattern = new RegExp(
  `^(?:${SPELLING_TOKEN_PATTERN_SOURCE})$`,
  "u"
)

export function isSpellingToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= MAX_SPELLING_WORD_LENGTH &&
    /\p{L}/u.test(value) &&
    exactSpellingTokenPattern.test(value)
  )
}

export interface EditorContextMenuDetails {
  dictionarySuggestions: string[]
  editFlags: {
    canCopy: boolean
    canCut: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
  misspelledWord: string
  x: number
  y: number
}
export type FocusedEditCommand = "copy" | "cut" | "paste" | "redo" | "undo"
export type RecoveryAction = "quit" | "reload" | "reopen"
export type WindowAction = "close" | "minimize" | "toggle-maximize"

export interface TabExportRequest {
  transferId: TransferId
  tabId: TabId
}

export interface TabExportResponse extends TabExportRequest {
  editorSession: SerializedEditorSession
}

export interface TabTransferCommitSettled {
  committed: boolean
  transferId: TransferId
}

export interface TabTransferImport {
  transferId: TransferId
  sourceWindowId: WindowId
  tab: TabDescriptor
  document: DocumentMetadata
  editorSession: SerializedEditorSession
}

export interface TabDragGeometry {
  cursorOffset: { x: number; y: number }
  sourceStripBounds: { x: number; y: number; width: number; height: number }
}

export interface TabDragEndDetails {
  cancelled: boolean
  dropped: boolean
  dragToken: string
  screenPoint: { x: number; y: number }
}

export interface TabDetachSourceRetired {
  dragToken: string
  tabId: TabId
}

export interface TabDetachSourceSettled {
  committed: boolean
  dragToken: string
}

export interface PulseMdApi {
  bootstrap(): Promise<BootstrapPayload>
  hydrateTab(tabId: TabId, interactive: boolean): Promise<BootstrapTab | null>
  acknowledgeTabHydration(tabId: TabId): void
  acknowledgeCliEditorFocus(
    acknowledgement: CliEditorFocusAcknowledgement
  ): void
  acknowledgeCliTabsOpen(acknowledgement: CliTabsOpenAcknowledgement): void
  activateTab(tabId: TabId): Promise<WindowTabsSnapshot>
  acknowledgeDocumentSave(acknowledgement: SaveDocumentAcknowledgement): void
  acknowledgeExternalDocumentChange(changeId: string, applied: boolean): void
  acknowledgeTabDetachSourceRetired(dragToken: string): void
  acquireSettingsSession(): Promise<boolean>
  beginTabDrag(tabId: TabId, geometry?: TabDragGeometry): string
  endTabDrag(details: TabDragEndDetails): void
  exitLaunchBenchmark(): void
  closeReady(allow: boolean): void
  windowClosePrepared(allow: boolean): void
  commitTabTransfer(transferId: TransferId): Promise<WindowTabsSnapshot>
  confirmTabTransfer(transferId: TransferId, valid: boolean): void
  copyEditorLink(address: string): Promise<void>
  copyHeadingLink(tabId: TabId, fragment: string): Promise<void>
  copyPath(tabId: TabId): Promise<void>
  finalizeCloseTab(
    tabId: TabId,
    viewport: EditorViewport | null
  ): Promise<WindowTabsSnapshot | null>
  editorReady(): void
  newTab(): Promise<NewTabResult>
  deleteWindowProfile(id: string): Promise<WindowProfilesSnapshot>
  deleteScratch(scratchId: string): Promise<void>
  addWordToSpellCheckerDictionary(word: string): Promise<boolean>
  checkSpelling(words: readonly string[]): readonly boolean[] | null
  completePath(
    sourceTabId: TabId,
    path: string
  ): Promise<readonly PathCompletionEntry[]>
  editFocusedControl(command: FocusedEditCommand): void
  commitSettingsImport(
    importId: string,
    settings: AppSettings,
    options: SettingsTransferOptions
  ): Promise<WindowSettingsSnapshot>
  discardSettingsImport(importId: string): void
  exportSettings(
    settings: AppSettings,
    options: SettingsTransferOptions
  ): Promise<ExportSettingsResult>
  getSpellingSuggestions(word: string): string[]
  getScratchPreview(scratchId: string): Promise<ScratchPreview>
  getScratches(
    query: string,
    sort: ScratchSortOrder,
    scope: ScratchInventoryScope
  ): Promise<ScratchInventory>
  getWindowProfiles(): Promise<WindowProfilesSnapshot>
  getCurrentWindowProfileSeed(
    tabModes: readonly WindowProfileTabMode[],
    kind: WindowProfileCaptureKind
  ): Promise<WindowProfileSeed>
  completeWindowProfilePicker(requestId: string, profileId: string | null): void
  launchWindowProfile(id: string): Promise<WindowProfileLaunchResult>
  importSettings(): Promise<ImportSettingsResult>
  newScratch(): Promise<OpenScratchResult | null>
  openExternalLink(url: string): Promise<void>
  openLocalLink(
    sourceTabId: TabId,
    destination: string,
    fragment: string | null,
    disposition: LocalLinkDisposition
  ): Promise<OpenLocalLinkResult | null>
  openScratchLink(
    sourceTabId: TabId,
    identity: ScratchDocumentIdentity,
    fragment: string | null,
    scheme: ScratchLinkScheme
  ): Promise<OpenLocalLinkResult | null>
  openScratch(
    scratchId: string,
    disposition: ScratchOpenDisposition
  ): Promise<OpenScratchResult | null>
  openDocument(replaceActive: boolean): Promise<OpenDocumentResult | null>
  openDroppedDocuments(
    files: readonly File[],
    replaceActive: boolean
  ): Promise<OpenDocumentResult | null>
  previewAppearance(settings: AppearanceSettings | null): void
  provideSettingsScratchSnapshot(
    response: SettingsScratchSnapshotResponse
  ): void
  previewWindowZoom(zoomFactor: number): void
  persistWindowZoom(zoomFactor: number): void
  reportEditorMenuState(state: EditorMenuState): void
  reportLineWrapping(lineWrapping: boolean): void
  releaseSettingsSession(): void
  resolveHeadingLinkPaste(
    tabId: TabId,
    metadata: CopiedHeadingLinkMetadata
  ): Promise<string>
  revealPath(tabId: TabId): Promise<void>
  stepWindowZoom(direction: -1 | 1): void
  provideTabExport(response: TabExportResponse): void
  rendererReady(prefersReducedMotion: boolean): Promise<WindowSettingsSnapshot>
  reorderTab(tabId: TabId, index: number): Promise<WindowTabsSnapshot>
  requestCloseTab(tabId: TabId): Promise<CloseDecision>
  requestTabTransfer(
    dragToken: string,
    index: number
  ): Promise<TabTransferImport | null>
  saveDocument(request: SaveDocumentRequest): Promise<SaveDocumentResult | null>
  saveWindowProfile(
    profile: WindowProfile,
    replace: boolean
  ): Promise<WindowProfilesSnapshot>
  selectWindowProfileFiles(): Promise<WindowProfileFileChoice[]>
  setActiveTab(tabId: TabId): void
  setDirty(tabId: TabId, dirty: boolean): void
  setSettings(settings: AppSettings): Promise<WindowSettingsSnapshot>
  showRecovery(error: string): void
  setDefaultWindowProfile(id: string | null): Promise<WindowProfilesSnapshot>
  updateScratch(scratchId: string, update: ScratchUpdate): Promise<void>
  windowAction(action: WindowAction): void
  onCliEditorFocusRequested(
    listener: (request: CliEditorFocusRequest) => void
  ): () => void
  onCliTabsOpenRequested(
    listener: (request: CliTabsOpenRequest) => void
  ): () => void
  onWindowProfilePickerRequested(
    listener: (request: WindowProfilePickerRequest) => void
  ): () => void
  onWindowProfilePickerCancelled(
    listener: (request: WindowProfilePickerRequest) => void
  ): () => void
  onCommand(
    listener: (command: EditorCommand) => Promise<void> | void
  ): () => void
  onEditorContextMenu(
    listener: (details: EditorContextMenuDetails) => void
  ): () => void
  onExternalDocumentChange(
    listener: (change: ExternalDocumentChange) => void
  ): () => void
  onOpenExistingLocalLinkRequested(
    listener: (request: OpenExistingLocalLinkRequest) => void
  ): () => void
  onSettingsScratchSnapshotRequested(
    listener: (request: SettingsScratchSnapshotRequest) => void
  ): () => void
  onTabExportRequested(
    listener: (request: TabExportRequest) => void
  ): () => void
  onTabDragActivity(listener: (active: boolean) => void): () => void
  onTabDetachSourceRetired(
    listener: (retired: TabDetachSourceRetired) => void
  ): () => void
  onTabDetachSourceSettled(
    listener: (settled: TabDetachSourceSettled) => void
  ): () => void
  onTabTransferCommitRequested(
    listener: (request: TabExportRequest & { revision: number }) => void
  ): () => void
  onTabTransferCommitSettled(
    listener: (result: TabTransferCommitSettled) => void
  ): () => void
  onTabsChanged(listener: (snapshot: WindowTabsSnapshot) => void): () => void
  onSettingsChanged(
    listener: (settings: WindowSettingsSnapshot) => void
  ): () => void
  onSpellCheckDictionaryChanged(listener: () => void): () => void
  onLaunchVisualEffectReady(
    listener: (effect: LaunchVisualEffectReady) => void
  ): () => void
  onWindowActivationChanged(listener: (active: boolean) => void): () => void
  onWindowZoomChanged(listener: (zoomFactor: number) => void): () => void
  onWindowZoomPersistenceFailed(
    listener: (zoomFactor: number) => void
  ): () => void
}

export interface PulseMdRecoveryApi {
  perform(action: RecoveryAction): Promise<void>
}

declare global {
  interface Window {
    pulseMd: PulseMdApi
    pulseMdRecovery: PulseMdRecoveryApi
  }
}
