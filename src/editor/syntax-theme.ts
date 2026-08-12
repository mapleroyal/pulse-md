import { syntaxHighlighting } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import type { ResolvedAppearance, SyntaxThemeId } from "../shared/contracts"
import {
  createPaletteHighlightStyle,
  syntaxCalloutColors,
} from "./syntax-themes/palettes"

export interface SyntaxThemeMetadata {
  readonly id: SyntaxThemeId
  readonly label: string
  /** The preset's canonical surface. Backgrounds remain independently selectable. */
  readonly backgroundId: SyntaxThemeId
}

export const SYNTAX_THEMES = [
  { id: "default", label: "Default", backgroundId: "default" },
  { id: "one-dark", label: "One Dark", backgroundId: "one-dark" },
  { id: "dracula", label: "Dracula", backgroundId: "dracula" },
  { id: "nord", label: "Nord", backgroundId: "nord" },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    backgroundId: "catppuccin-latte",
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    backgroundId: "catppuccin-frappe",
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    backgroundId: "catppuccin-macchiato",
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    backgroundId: "catppuccin-mocha",
  },
  {
    id: "github-light",
    label: "GitHub Light",
    backgroundId: "github-light",
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    backgroundId: "github-dark",
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    backgroundId: "solarized-light",
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    backgroundId: "solarized-dark",
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    backgroundId: "gruvbox-light",
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    backgroundId: "gruvbox-dark",
  },
  {
    id: "rose-pine-dawn",
    label: "Rosé Pine Dawn",
    backgroundId: "rose-pine-dawn",
  },
  {
    id: "rose-pine-moon",
    label: "Rosé Pine Moon",
    backgroundId: "rose-pine-moon",
  },
  {
    id: "tokyo-day",
    label: "Tokyo Day",
    backgroundId: "tokyo-day",
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    backgroundId: "tokyo-night",
  },
  { id: "monokai", label: "Monokai", backgroundId: "monokai" },
  { id: "xcode", label: "Xcode", backgroundId: "xcode" },
] as const satisfies readonly SyntaxThemeMetadata[]

export const DEFAULT_SYNTAX_THEME_BY_SCHEME: Readonly<
  Record<ResolvedAppearance, SyntaxThemeId>
> = {
  light: "default",
  dark: "one-dark",
}

const MAX_SYNTAX_THEME_CACHE_ENTRIES = 64
const syntaxThemeExtensionCache = new Map<string, Extension>()

// Keep syntax themes separate from editor themes. This extension colors Lezer
// tags without replacing app-owned typography, surfaces, gutters, or selection.
export function syntaxThemeExtension(
  themeId: SyntaxThemeId,
  backgroundColor: string
): Extension {
  const cacheKey = `${themeId}:${backgroundColor.toLowerCase()}`
  const cached = syntaxThemeExtensionCache.get(cacheKey)
  if (cached) return cached

  const callout = syntaxCalloutColors(themeId, backgroundColor)
  const extension: Extension = [
    syntaxHighlighting(createPaletteHighlightStyle(themeId, backgroundColor)),
    EditorView.theme({
      "&": {
        "--cm-md-syntax-callout-danger": callout.danger,
        "--cm-md-syntax-callout-example": callout.example,
        "--cm-md-syntax-callout-info": callout.info,
        "--cm-md-syntax-callout-quote": callout.quote,
        "--cm-md-syntax-callout-success": callout.success,
        "--cm-md-syntax-callout-tip": callout.tip,
      },
    }),
  ]
  if (syntaxThemeExtensionCache.size >= MAX_SYNTAX_THEME_CACHE_ENTRIES) {
    const oldestKey = syntaxThemeExtensionCache.keys().next().value
    if (oldestKey) syntaxThemeExtensionCache.delete(oldestKey)
  }
  syntaxThemeExtensionCache.set(cacheKey, extension)
  return extension
}

export type { SyntaxThemeId } from "../shared/contracts"
