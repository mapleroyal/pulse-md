import { HighlightStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"

import { ensureColorContrast, type SyntaxThemeId } from "../../shared/contracts"
import {
  createHighlightStyle,
  type SyntaxPalette,
} from "./create-highlight-style"

type PaletteThemeId = Exclude<SyntaxThemeId, "default" | "one-dark">

// Syntax and semantic colors also appear on subtly tinted code, callout, and
// popover surfaces. A small buffer over the text minimum keeps those uses at
// or above 4.5:1 after surface tinting.
const MIN_PALETTE_COLOR_CONTRAST = 5

function readablePaletteColor(color: string, backgroundColor: string) {
  return ensureColorContrast(color, backgroundColor, MIN_PALETTE_COLOR_CONTRAST)
}

// These are syntax roles only. Palette surfaces are deliberately omitted so
// users can combine every syntax palette with every app background.
const PALETTES = {
  dracula: {
    atom: "#bd93f9",
    comment: "#6272a4",
    constant: "#bd93f9",
    definition: "#50fa7b",
    function: "#50fa7b",
    heading: "#ff79c6",
    invalid: "#ff5555",
    keyword: "#ff79c6",
    link: "#8be9fd",
    name: "#f8f8f2",
    number: "#bd93f9",
    operator: "#ff79c6",
    property: "#8be9fd",
    regexp: "#f1fa8c",
    string: "#f1fa8c",
    tag: "#ff79c6",
    type: "#8be9fd",
  },
  nord: {
    atom: "#d08770",
    comment: "#616e88",
    constant: "#5e81ac",
    definition: "#a3be8c",
    function: "#8fbcbb",
    heading: "#5e81ac",
    invalid: "#bf616a",
    keyword: "#81a1c1",
    link: "#a3be8c",
    name: "#88c0d0",
    number: "#b48ead",
    operator: "#a3be8c",
    property: "#88c0d0",
    regexp: "#5e81ac",
    string: "#a3be8c",
    tag: "#b48ead",
    type: "#ebcb8b",
    commentFontStyle: "italic",
  },
  "catppuccin-latte": {
    atom: "#d20f39",
    comment: "#7c7f93",
    constant: "#fe640b",
    function: "#1e66f5",
    heading: "#1e66f5",
    invalid: "#d20f39",
    keyword: "#8839ef",
    link: "#1e66f5",
    name: "#4c4f69",
    number: "#fe640b",
    operator: "#04a5e5",
    property: "#1e66f5",
    punctuation: "#7c7f93",
    regexp: "#ea76cb",
    specialVariable: "#7287fd",
    string: "#40a02b",
    tag: "#8839ef",
    type: "#df8e1d",
  },
  "catppuccin-frappe": {
    atom: "#e78284",
    comment: "#838ba7",
    constant: "#ef9f76",
    function: "#8caaee",
    heading: "#8caaee",
    invalid: "#e78284",
    keyword: "#ca9ee6",
    link: "#8caaee",
    name: "#c6d0f5",
    number: "#ef9f76",
    operator: "#99d1db",
    property: "#8caaee",
    punctuation: "#838ba7",
    regexp: "#f4b8e4",
    specialVariable: "#babbf1",
    string: "#a6d189",
    tag: "#ca9ee6",
    type: "#e5c890",
  },
  "catppuccin-macchiato": {
    atom: "#ed8796",
    comment: "#939ab7",
    constant: "#f5a97f",
    function: "#8aadf4",
    heading: "#8aadf4",
    invalid: "#ed8796",
    keyword: "#c6a0f6",
    link: "#8aadf4",
    name: "#cad3f5",
    number: "#f5a97f",
    operator: "#91d7e3",
    property: "#8aadf4",
    punctuation: "#939ab7",
    regexp: "#f5bde6",
    specialVariable: "#b7bdf8",
    string: "#a6da95",
    tag: "#c6a0f6",
    type: "#eed49f",
  },
  "catppuccin-mocha": {
    atom: "#f38ba8",
    comment: "#9399b2",
    constant: "#fab387",
    function: "#89b4fa",
    heading: "#89b4fa",
    invalid: "#f38ba8",
    keyword: "#cba6f7",
    link: "#89b4fa",
    name: "#cdd6f4",
    number: "#fab387",
    operator: "#89dceb",
    property: "#89b4fa",
    punctuation: "#9399b2",
    regexp: "#f5c2e7",
    specialVariable: "#b4befe",
    string: "#a6e3a1",
    tag: "#cba6f7",
    type: "#f9e2af",
  },
  "github-light": {
    atom: "#e36209",
    comment: "#6a737d",
    constant: "#005cc5",
    function: "#6f42c1",
    heading: "#24292e",
    invalid: "#cb2431",
    keyword: "#d73a49",
    link: "#032f62",
    name: "#22863a",
    number: "#005cc5",
    operator: "#005cc5",
    property: "#6f42c1",
    regexp: "#032f62",
    string: "#032f62",
    tag: "#116329",
    type: "#d73a49",
  },
  "github-dark": {
    atom: "#ffab70",
    comment: "#8b949e",
    constant: "#79c0ff",
    function: "#d2a8ff",
    heading: "#d2a8ff",
    invalid: "#f97583",
    keyword: "#ff7b72",
    link: "#a5d6ff",
    name: "#7ee787",
    number: "#79c0ff",
    operator: "#79c0ff",
    property: "#d2a8ff",
    regexp: "#a5d6ff",
    string: "#a5d6ff",
    tag: "#7ee787",
    type: "#ff7b72",
  },
  "solarized-light": {
    atom: "#268bd2",
    comment: "#839496",
    constant: "#cb4b16",
    function: "#268bd2",
    heading: "#268bd2",
    invalid: "#dc322f",
    keyword: "#859900",
    link: "#dc322f",
    name: "#268bd2",
    number: "#d33682",
    operator: "#859900",
    property: "#268bd2",
    regexp: "#dc322f",
    string: "#2aa198",
    tag: "#268bd2",
    type: "#859900",
  },
  "solarized-dark": {
    atom: "#268bd2",
    comment: "#657b83",
    constant: "#cb4b16",
    function: "#268bd2",
    heading: "#268bd2",
    invalid: "#dc322f",
    keyword: "#859900",
    link: "#dc322f",
    name: "#268bd2",
    number: "#d33682",
    operator: "#859900",
    property: "#268bd2",
    regexp: "#dc322f",
    string: "#2aa198",
    tag: "#268bd2",
    type: "#859900",
  },
  "gruvbox-light": {
    atom: "#8f3f71",
    comment: "#928374",
    constant: "#8f3f71",
    definition: "#3c3836",
    function: "#79740e",
    heading: "#79740e",
    invalid: "#9d0006",
    keyword: "#9d0006",
    link: "#7c6f64",
    name: "#427b58",
    number: "#8f3f71",
    operator: "#9d0006",
    property: "#427b58",
    regexp: "#427b58",
    string: "#3c3836",
    tag: "#427b58",
    type: "#b57614",
    commentFontStyle: "italic",
  },
  "gruvbox-dark": {
    atom: "#d3869b",
    comment: "#928374",
    constant: "#d3869b",
    definition: "#ebdbb2",
    function: "#b8bb26",
    heading: "#b8bb26",
    invalid: "#fb4934",
    keyword: "#fb4934",
    link: "#a89984",
    name: "#8ec07c",
    number: "#d3869b",
    operator: "#fb4934",
    property: "#8ec07c",
    regexp: "#8ec07c",
    string: "#ebdbb2",
    tag: "#8ec07c",
    type: "#fabd2f",
    commentFontStyle: "italic",
  },
  "rose-pine-dawn": {
    atom: "#b4637a",
    comment: "#9893a5",
    constant: "#ea9d34",
    function: "#d7827e",
    heading: "#907aa9",
    invalid: "#b4637a",
    keyword: "#286983",
    link: "#286983",
    name: "#575279",
    number: "#ea9d34",
    operator: "#797593",
    property: "#d7827e",
    regexp: "#907aa9",
    string: "#ea9d34",
    tag: "#286983",
    type: "#56949f",
  },
  "rose-pine-moon": {
    atom: "#eb6f92",
    comment: "#6e6a86",
    constant: "#f6c177",
    function: "#ea9a97",
    heading: "#c4a7e7",
    invalid: "#eb6f92",
    keyword: "#3e8fb0",
    link: "#9ccfd8",
    name: "#e0def4",
    number: "#f6c177",
    operator: "#908caa",
    property: "#ea9a97",
    regexp: "#c4a7e7",
    string: "#f6c177",
    tag: "#3e8fb0",
    type: "#9ccfd8",
  },
  "tokyo-day": {
    atom: "#3760bf",
    comment: "#848cb5",
    constant: "#3760bf",
    function: "#3760bf",
    heading: "#b15c00",
    invalid: "#f52a65",
    keyword: "#007197",
    link: "#587539",
    name: "#3760bf",
    number: "#b15c00",
    operator: "#007197",
    property: "#3760bf",
    regexp: "#587539",
    string: "#587539",
    tag: "#007197",
    type: "#007197",
  },
  "tokyo-night": {
    atom: "#c0caf5",
    comment: "#565f89",
    constant: "#bb9af7",
    function: "#7aa2f7",
    heading: "#89ddff",
    invalid: "#ff5370",
    keyword: "#bb9af7",
    link: "#b4f9f8",
    name: "#c0caf5",
    number: "#ff9e64",
    operator: "#bb9af7",
    property: "#7aa2f7",
    regexp: "#b4f9f8",
    string: "#9ece6a",
    tag: "#f7768e",
    type: "#0db9d7",
  },
  monokai: {
    atom: "#fd971f",
    comment: "#88846f",
    constant: "#ae81ff",
    function: "#66d9ef",
    heading: "#a6e22e",
    invalid: "#f44747",
    keyword: "#f92672",
    link: "#e6db74",
    name: "#fd971f",
    number: "#ae81ff",
    operator: "#f92672",
    property: "#66d9ef",
    regexp: "#e6db74",
    string: "#e6db74",
    tag: "#f92672",
    type: "#66d9ef",
  },
  xcode: {
    atom: "#aa0d91",
    comment: "#707f8d",
    constant: "#aa0d91",
    definition: "#327a9e",
    function: "#327a9e",
    heading: "#522bb2",
    invalid: "#d23423",
    keyword: "#aa0d91",
    link: "#0e0eff",
    name: "#032f62",
    number: "#23575c",
    operator: "#aa0d91",
    property: "#23575c",
    regexp: "#0e0eff",
    string: "#d23423",
    tag: "#032f62",
    type: "#522bb2",
  },
} as const satisfies Readonly<Record<PaletteThemeId, SyntaxPalette>>

function createDefaultHighlightStyle(backgroundColor: string) {
  const color = (value: string) => readablePaletteColor(value, backgroundColor)
  return HighlightStyle.define([
    { tag: tags.meta, color: color("#404740") },
    { tag: tags.link, textDecoration: "underline" },
    {
      tag: tags.heading,
      textDecoration: "underline",
      fontWeight: "bold",
    },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.keyword, color: color("#770088") },
    {
      tag: [
        tags.atom,
        tags.bool,
        tags.url,
        tags.contentSeparator,
        tags.labelName,
      ],
      color: color("#221199"),
    },
    { tag: [tags.literal, tags.inserted], color: color("#116644") },
    { tag: [tags.string, tags.deleted], color: color("#aa1111") },
    {
      tag: [tags.regexp, tags.escape, tags.special(tags.string)],
      color: color("#ee4400"),
    },
    {
      tag: tags.definition(tags.variableName),
      color: color("#0000ff"),
    },
    { tag: tags.local(tags.variableName), color: color("#3300aa") },
    { tag: [tags.typeName, tags.namespace], color: color("#008855") },
    { tag: tags.className, color: color("#116677") },
    {
      tag: [tags.special(tags.variableName), tags.macroName],
      color: color("#225566"),
    },
    {
      tag: tags.definition(tags.propertyName),
      color: color("#0000cc"),
    },
    { tag: tags.comment, color: color("#994400") },
    { tag: tags.invalid, color: color("#ff0000") },
  ])
}

function createOneDarkHighlightStyle(backgroundColor: string) {
  const color = (value: string) => readablePaletteColor(value, backgroundColor)
  return HighlightStyle.define([
    { tag: tags.keyword, color: color("#c678dd") },
    {
      tag: [
        tags.name,
        tags.deleted,
        tags.character,
        tags.propertyName,
        tags.macroName,
      ],
      color: color("#e06c75"),
    },
    {
      tag: [tags.function(tags.variableName), tags.labelName],
      color: color("#61afef"),
    },
    {
      tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
      color: color("#d19a66"),
    },
    {
      tag: [tags.definition(tags.name), tags.separator],
      color: color("#abb2bf"),
    },
    {
      tag: [
        tags.typeName,
        tags.className,
        tags.number,
        tags.changed,
        tags.annotation,
        tags.modifier,
        tags.self,
        tags.namespace,
      ],
      color: color("#e5c07b"),
    },
    {
      tag: [
        tags.operator,
        tags.operatorKeyword,
        tags.url,
        tags.escape,
        tags.regexp,
        tags.link,
        tags.special(tags.string),
      ],
      color: color("#56b6c2"),
    },
    { tag: [tags.meta, tags.comment], color: color("#7d8799") },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    {
      tag: tags.link,
      color: color("#7d8799"),
      textDecoration: "underline",
    },
    {
      tag: tags.heading,
      color: color("#e06c75"),
      fontWeight: "bold",
    },
    {
      tag: [tags.atom, tags.bool, tags.special(tags.variableName)],
      color: color("#d19a66"),
    },
    {
      tag: [tags.processingInstruction, tags.string, tags.inserted],
      color: color("#98c379"),
    },
    { tag: tags.invalid, color: color("#ffffff") },
  ])
}

export function createPaletteHighlightStyle(
  themeId: SyntaxThemeId,
  backgroundColor: string
): HighlightStyle {
  if (themeId === "default") {
    return createDefaultHighlightStyle(backgroundColor)
  }
  if (themeId === "one-dark") {
    return createOneDarkHighlightStyle(backgroundColor)
  }
  return createHighlightStyle(PALETTES[themeId], (color) =>
    readablePaletteColor(color, backgroundColor)
  )
}

export interface SyntaxCalloutColors {
  readonly danger: string
  readonly example: string
  readonly info: string
  readonly quote: string
  readonly success: string
  readonly tip: string
}

const BUILT_IN_CALLOUT_COLORS: Readonly<
  Record<"default" | "one-dark", SyntaxCalloutColors>
> = {
  default: {
    danger: "#ff0000",
    example: "#770088",
    info: "#0000ff",
    quote: "#221199",
    success: "#116644",
    tip: "#008855",
  },
  "one-dark": {
    danger: "#e06c75",
    example: "#c678dd",
    info: "#61afef",
    quote: "#d19a66",
    success: "#98c379",
    tip: "#e5c07b",
  },
}

/**
 * Resolve semantic callout accents from the same role colors used to build the
 * active code highlighter. Built-in CodeMirror themes do not expose their
 * palettes, so their canonical values are recorded above.
 */
export function syntaxCalloutColors(
  themeId: SyntaxThemeId,
  backgroundColor: string
): SyntaxCalloutColors {
  const colors =
    themeId === "default" || themeId === "one-dark"
      ? BUILT_IN_CALLOUT_COLORS[themeId]
      : (() => {
          const palette: SyntaxPalette = PALETTES[themeId]
          return {
            danger: palette.invalid,
            example: palette.keyword,
            info: palette.function,
            quote: palette.number,
            success: palette.string,
            tip: palette.type,
          }
        })()
  return {
    danger: readablePaletteColor(colors.danger, backgroundColor),
    example: readablePaletteColor(colors.example, backgroundColor),
    info: readablePaletteColor(colors.info, backgroundColor),
    quote: readablePaletteColor(colors.quote, backgroundColor),
    success: readablePaletteColor(colors.success, backgroundColor),
    tip: readablePaletteColor(colors.tip, backgroundColor),
  }
}

export interface SyntaxPreviewColors {
  readonly comment: string
  readonly definition: string
  readonly function: string
  readonly keyword: string
  readonly number: string
  readonly string: string
}

const BUILT_IN_PREVIEW_COLORS: Readonly<
  Record<"default" | "one-dark", SyntaxPreviewColors>
> = {
  default: {
    comment: "#994400",
    definition: "#0000ff",
    function: "#0000ff",
    keyword: "#770088",
    number: "#221199",
    string: "#aa1111",
  },
  "one-dark": {
    comment: "#7d8799",
    definition: "#abb2bf",
    function: "#61afef",
    keyword: "#c678dd",
    number: "#e5c07b",
    string: "#98c379",
  },
}

export function syntaxPreviewColors(
  themeId: SyntaxThemeId,
  backgroundColor: string
): SyntaxPreviewColors {
  const colors =
    themeId === "default" || themeId === "one-dark"
      ? BUILT_IN_PREVIEW_COLORS[themeId]
      : (() => {
          const palette: SyntaxPalette = PALETTES[themeId]
          return {
            comment: palette.comment,
            definition: palette.definition ?? palette.name,
            function: palette.function,
            keyword: palette.keyword,
            number: palette.number,
            string: palette.string,
          }
        })()
  return {
    comment: readablePaletteColor(colors.comment, backgroundColor),
    definition: readablePaletteColor(colors.definition, backgroundColor),
    function: readablePaletteColor(colors.function, backgroundColor),
    keyword: readablePaletteColor(colors.keyword, backgroundColor),
    number: readablePaletteColor(colors.number, backgroundColor),
    string: readablePaletteColor(colors.string, backgroundColor),
  }
}
