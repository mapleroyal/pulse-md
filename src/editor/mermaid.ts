import { syntaxTree } from "@codemirror/language"
import {
  RangeSet,
  RangeValue,
  StateField,
  type EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view"
import type { SyntaxNode, Tree } from "@lezer/common"
import type { MermaidConfig } from "mermaid"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"

import {
  completeMarkdownSyntaxTree,
  markdownBlockPairingMayChange,
  updateCompleteMarkdownSyntaxTree,
} from "./complete-markdown-tree"
import { MemoryWeightedFragmentCache } from "./fragment-render-cache"
import {
  firstNearbyPreviewRange,
  preservePreviewDuringPointerSelection,
  previewPositionAtDOM,
  semanticPreviewSelectionResolvers,
} from "./interactive-preview"
import {
  optionalPreviewGeometryRefreshRequested,
  PreviewHeightCache,
} from "./optional-preview-geometry"
import { sanitizedFragment } from "./sanitized-dom"
import { boundedPreviewMaxWidth } from "./theme"
import { maximumMermaidSourceLength } from "./types"

export type MermaidTheme = NonNullable<MermaidConfig["theme"]>

export interface MermaidDiagram {
  readonly from: number
  readonly source: string
  readonly to: number
}

interface DocumentRange {
  readonly from: number
  readonly to: number
}

function directChildren(node: SyntaxNode) {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

interface MermaidDiagramCandidate extends DocumentRange {
  readonly codeText: readonly SyntaxNode[]
}

function mermaidDiagramCandidateFromNode(
  state: EditorState,
  node: SyntaxNode
): MermaidDiagramCandidate | null {
  const children = directChildren(node)
  const info = children.find((child) => child.name === "CodeInfo")
  if (!info) return null
  const language = state.sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0]
  if (language?.toLowerCase() !== "mermaid") return null

  const marks = children.filter((child) => child.name === "CodeMark")
  const openingLine = marks[0] ? state.doc.lineAt(marks[0].from).number : -1
  const closed = marks.some(
    (mark) => state.doc.lineAt(mark.from).number > openingLine
  )
  if (!closed) return null

  const codeText = children.filter((child) => child.name === "CodeText")
  const sourceLength = codeText.reduce(
    (length, child) => length + child.to - child.from,
    0
  )
  if (sourceLength === 0 || sourceLength > maximumMermaidSourceLength) {
    return null
  }

  return { codeText, from: node.from, to: node.to }
}

function mermaidDiagramFromNode(
  state: EditorState,
  node: SyntaxNode
): MermaidDiagram | null {
  const candidate = mermaidDiagramCandidateFromNode(state, node)
  if (!candidate) return null

  const source = candidate.codeText
    .map((child) => state.sliceDoc(child.from, child.to))
    .join("")
    .trim()
  if (!source) return null
  return { from: candidate.from, source, to: candidate.to }
}

function mermaidDiagramsInRanges(
  state: EditorState,
  ranges: readonly DocumentRange[] | null,
  tree: Tree = completeMarkdownSyntaxTree(state)
) {
  const diagrams: MermaidDiagram[] = []
  const seen = new Set<number>()
  const scan = (range: DocumentRange | null) => {
    tree.iterate({
      ...(range ? { from: range.from, to: range.to } : {}),
      enter(node) {
        if (node.name !== "FencedCode" || seen.has(node.from)) return
        if (range && (node.to <= range.from || node.from >= range.to)) {
          return false
        }
        seen.add(node.from)
        const diagram = mermaidDiagramFromNode(state, node.node)
        if (diagram) diagrams.push(diagram)
        return false
      },
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan(null)
  }
  return diagrams.sort((left, right) => left.from - right.from)
}

/** Extracts closed, nonempty `mermaid` fenced-code blocks. */
export function mermaidDiagrams(state: EditorState): readonly MermaidDiagram[] {
  return mermaidDiagramsInRanges(state, null)
}

/** Finds a rendered Mermaid fence containing a document position. */
export function mermaidDiagramAt(
  state: EditorState,
  position: number
): MermaidDiagram | null {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length))
  const tree = completeMarkdownSyntaxTree(state)
  const seen = new Set<number>()
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(boundedPosition, side)
    while (node) {
      if (node.name === "FencedCode" && !seen.has(node.from)) {
        seen.add(node.from)
        if (node.from <= boundedPosition && boundedPosition <= node.to) {
          const diagram = mermaidDiagramFromNode(state, node)
          if (diagram) return diagram
        }
      }
      node = node.parent
    }
  }
  return null
}

/**
 * Refuses input forms that can alter renderer configuration, attach behavior,
 * or request a resource. Mermaid strict mode remains a second security layer.
 */
export function unsafeMermaidSourceReason(source: string): string | null {
  if (source.length > maximumMermaidSourceLength) {
    return `Diagram source exceeds ${maximumMermaidSourceLength.toLocaleString()} characters.`
  }
  if (/%%\s*\{/i.test(source)) {
    return "Mermaid configuration directives are not rendered."
  }

  const trimmed = source.trimStart()
  let diagramSource = trimmed
  if (trimmed.startsWith("---")) {
    const frontMatter =
      /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
        trimmed
      )
    const metadata = frontMatter?.[1] ?? null
    const simpleTitle =
      metadata != null &&
      (metadata.trim() === "" ||
        /^[ \t]*title[ \t]*:[ \t]*[^\r\n{}\x5b\x5d&*!|>]*[ \t]*$/i.test(
          metadata
        ))
    if (!simpleTitle) {
      return "Only simple title metadata is rendered in Mermaid front matter."
    }
    diagramSource = trimmed.slice(frontMatter![0].length).trimStart()
  }
  if (/^eventmodeling\b/i.test(diagramSource)) {
    return "Mermaid Event Modeling diagrams require HTML labels and are not rendered."
  }
  if (
    /(?:^|;)\s*(?:classDef|linkStyle|style|UpdateElementStyle|UpdateRelStyle)\b/im.test(
      source
    )
  ) {
    return "User-defined Mermaid CSS is not rendered."
  }
  if (/@import\b|url\s*\(/i.test(source)) {
    return "External CSS resources are not rendered in Mermaid diagrams."
  }

  if (/(?:^|;)\s*click\s+\S+/im.test(source)) {
    return "Interactive Mermaid click directives are not rendered."
  }
  if (source.includes("![")) {
    return "Mermaid image references are not rendered."
  }
  if (
    /<\/?\s*(?:a|audio|embed|iframe|image|img|link|object|script|source|style|video)\b/i.test(
      source
    )
  ) {
    return "Active or resource-loading HTML is not rendered in Mermaid labels."
  }
  if (/@\{/s.test(source)) {
    return "Mermaid node metadata is not rendered."
  }
  return null
}

let mermaidRenderQueue: Promise<void> = Promise.resolve()
let nextMermaidRenderId = 1
const loadMermaid = createRetryableDynamicImport(() => import("mermaid"))

function renderId() {
  const id = nextMermaidRenderId
  nextMermaidRenderId =
    nextMermaidRenderId >= Number.MAX_SAFE_INTEGER ? 1 : id + 1
  return `cm-md-mermaid-${id}`
}

function enqueueMermaidRender<T>(render: () => Promise<T>) {
  const result = mermaidRenderQueue.then(render, render)
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

interface MermaidRenderColors {
  readonly background: string
  readonly dark: boolean
  readonly fontFamily: string
  readonly foreground: string
}

interface RgbColor {
  readonly blue: number
  readonly green: number
  readonly red: number
}

function parsedCssColor(value: string): RgbColor | null {
  const normalized = value.trim().toLowerCase()
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.exec(
    normalized
  )?.[1]
  if (hex) {
    const expanded =
      hex.length <= 4
        ? [...hex].map((character) => `${character}${character}`).join("")
        : hex
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
    }
  }

  if (!normalized.startsWith("rgb")) return null
  const channels = normalized.match(/[\d.]+%?/g)?.slice(0, 3)
  if (!channels || channels.length !== 3) return null
  const values = channels.map((channel) => {
    const number = Number.parseFloat(channel)
    return channel.endsWith("%") ? (number / 100) * 255 : number
  })
  if (values.some((channel) => !Number.isFinite(channel))) return null
  return {
    red: Math.max(0, Math.min(255, values[0] ?? 0)),
    green: Math.max(0, Math.min(255, values[1] ?? 0)),
    blue: Math.max(0, Math.min(255, values[2] ?? 0)),
  }
}

function hexColor(color: RgbColor) {
  const channel = (value: number) =>
    Math.round(value).toString(16).padStart(2, "0")
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`
}

function normalizedHexColor(value: string, fallback: string) {
  const parsed = parsedCssColor(value)
  return parsed ? hexColor(parsed) : fallback
}

function mixedHexColor(background: string, foreground: string, amount: number) {
  const from = parsedCssColor(background)
  const to = parsedCssColor(foreground)
  if (!from || !to) return foreground
  return hexColor({
    red: from.red + (to.red - from.red) * amount,
    green: from.green + (to.green - from.green) * amount,
    blue: from.blue + (to.blue - from.blue) * amount,
  })
}

function mermaidThemeIsDark(theme: MermaidTheme) {
  return theme === "dark" || theme === "neo-dark" || theme === "redux-dark"
}

function mermaidRenderColors(host: HTMLElement, theme: MermaidTheme) {
  const dark = mermaidThemeIsDark(theme)
  const fallbackBackground = dark ? "#181818" : "#ffffff"
  const fallbackForeground = dark ? "#f5f5f5" : "#171717"
  const styles = host.ownerDocument.defaultView?.getComputedStyle(host)
  return {
    background: normalizedHexColor(
      styles?.getPropertyValue("--document-background") ?? "",
      fallbackBackground
    ),
    dark,
    fontFamily:
      styles?.fontFamily.trim() ||
      "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    foreground: normalizedHexColor(
      styles?.getPropertyValue("--document-foreground") ?? "",
      fallbackForeground
    ),
  } satisfies MermaidRenderColors
}

function mermaidTonalPalette(colors: MermaidRenderColors) {
  const { background, foreground } = colors
  const tone = (amount: number) => mixedHexColor(background, foreground, amount)
  const surfaces = Array.from({ length: 12 }, (_value, index) =>
    tone(0.055 + (index % 6) * 0.035)
  )
  const surface = surfaces[0] ?? background
  const raised = surfaces[1] ?? surface
  const inset = surfaces[2] ?? raised
  return {
    border: tone(0.32),
    inset,
    line: tone(0.56),
    raised,
    surface,
    surfaces,
  }
}

/**
 * Mermaid's `base` theme is the only supported customizable theme. Keep its
 * complete palette tied to the document surface instead of inheriting the
 * colorful built-in light/dark palettes. All categorical colors are tonal
 * mixtures of the current document foreground and background.
 */
function mermaidThemeVariables(colors: MermaidRenderColors) {
  const { background, dark, fontFamily, foreground } = colors
  const { border, inset, line, raised, surface, surfaces } =
    mermaidTonalPalette(colors)

  const scales = Object.fromEntries(
    surfaces.flatMap((color, index) => [
      [`cScale${index}`, color],
      [`cScaleInv${index}`, foreground],
      [`cScaleLabel${index}`, foreground],
      [`cScalePeer${index}`, surfaces[(index + 1) % surfaces.length]],
    ])
  )
  const fills = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `fillType${index}`,
      surfaces[index % surfaces.length],
    ])
  )
  const pies = Object.fromEntries(
    surfaces.map((color, index) => [`pie${index + 1}`, color])
  )
  const venn = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `venn${index + 1}`,
      surfaces[index % surfaces.length],
    ])
  )
  const git = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `git${index}`,
      surfaces[index % surfaces.length],
    ])
  )
  const gitInverse = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [`gitInv${index}`, foreground])
  )
  const gitLabels = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `gitBranchLabel${index}`,
      foreground,
    ])
  )

  return {
    darkMode: dark,
    background,
    primaryColor: surface,
    primaryTextColor: foreground,
    primaryBorderColor: border,
    secondaryColor: raised,
    secondaryTextColor: foreground,
    secondaryBorderColor: border,
    tertiaryColor: inset,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: border,
    textColor: foreground,
    lineColor: line,
    arrowheadColor: line,
    mainBkg: surface,
    nodeBkg: surface,
    nodeBorder: border,
    nodeTextColor: foreground,
    clusterBkg: raised,
    clusterBorder: border,
    defaultLinkColor: line,
    edgeLabelBackground: background,
    titleColor: foreground,
    labelBackground: background,
    fontFamily,
    fontSize: "16px",
    useGradient: false,
    dropShadow: "none",

    actorBkg: surface,
    actorBorder: border,
    actorTextColor: foreground,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: foreground,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: border,
    labelTextColor: foreground,
    loopTextColor: foreground,
    activationBkgColor: inset,
    activationBorderColor: border,
    sequenceNumberColor: foreground,
    noteBkgColor: raised,
    noteBorderColor: border,
    noteTextColor: foreground,

    rectBkgColor: raised,
    sectionBkgColor: surface,
    sectionBkgColor2: inset,
    altSectionBkgColor: background,
    excludeBkgColor: raised,
    taskBkgColor: surface,
    taskBorderColor: border,
    activeTaskBkgColor: inset,
    activeTaskBorderColor: line,
    doneTaskBkgColor: raised,
    doneTaskBorderColor: border,
    critBkgColor: inset,
    critBorderColor: line,
    todayLineColor: line,
    vertLineColor: border,
    gridColor: border,
    taskTextColor: foreground,
    taskTextOutsideColor: foreground,
    taskTextLightColor: foreground,
    taskTextDarkColor: foreground,
    taskTextClickableColor: foreground,

    stateBkg: surface,
    stateLabelColor: foreground,
    transitionColor: line,
    transitionLabelColor: foreground,
    labelBackgroundColor: background,
    compositeBackground: raised,
    compositeTitleBackground: inset,
    compositeBorder: border,
    altBackground: background,
    innerEndBackground: line,
    specialStateColor: line,
    classText: foreground,
    errorBkgColor: raised,
    errorTextColor: foreground,

    ...scales,
    ...fills,
    ...pies,
    ...venn,
    ...git,
    ...gitInverse,
    ...gitLabels,
    scaleLabelColor: foreground,
    pieTitleTextColor: foreground,
    pieSectionTextColor: foreground,
    pieLegendTextColor: foreground,
    pieStrokeColor: border,
    pieOuterStrokeColor: border,
    vennTitleTextColor: foreground,
    vennSetTextColor: foreground,
    branchLabelColor: foreground,
    tagLabelColor: foreground,
    tagLabelBackground: raised,
    tagLabelBorder: border,
    commitLabelColor: foreground,
    commitLabelBackground: raised,

    quadrant1Fill: surfaces[0],
    quadrant2Fill: surfaces[1],
    quadrant3Fill: surfaces[2],
    quadrant4Fill: surfaces[3],
    quadrant1TextFill: foreground,
    quadrant2TextFill: foreground,
    quadrant3TextFill: foreground,
    quadrant4TextFill: foreground,
    quadrantPointFill: line,
    quadrantPointTextFill: foreground,
    quadrantXAxisTextFill: foreground,
    quadrantYAxisTextFill: foreground,
    quadrantInternalBorderStrokeFill: border,
    quadrantExternalBorderStrokeFill: border,
    quadrantTitleFill: foreground,

    requirementBackground: surface,
    requirementBorderColor: border,
    requirementTextColor: foreground,
    relationColor: line,
    relationLabelBackground: background,
    relationLabelColor: foreground,
    personBkg: surface,
    personBorder: border,
    rowOdd: surface,
    rowEven: raised,
    archEdgeColor: line,
    archEdgeArrowColor: line,
    archGroupBorderColor: border,

    cynefin: {
      domainFontSize: 16,
      itemFontSize: 12,
      boundaryColor: line,
      boundaryWidth: 2,
      cliffColor: line,
      cliffWidth: 4,
      arrowColor: line,
      arrowWidth: 2,
      complexBg: surfaces[0],
      complicatedBg: surfaces[1],
      chaoticBg: surfaces[2],
      clearBg: surfaces[3],
      confusionBg: surfaces[4],
      textColor: foreground,
      labelColor: foreground,
    },
    radar: {
      axisColor: line,
      axisStrokeWidth: 2,
      axisLabelFontSize: 12,
      curveOpacity: 0.5,
      curveStrokeWidth: 2,
      graticuleColor: border,
      graticuleStrokeWidth: 1,
      graticuleOpacity: 0.3,
      legendBoxSize: 12,
      legendFontSize: 12,
    },
    wardleyEvolutionColor: line,
    wardley: {
      backgroundColor: background,
      axisColor: line,
      axisTextColor: foreground,
      gridColor: border,
      componentFill: surface,
      componentStroke: line,
      componentLabelColor: foreground,
      linkStroke: line,
      evolutionStroke: line,
      annotationStroke: line,
      annotationTextColor: foreground,
      annotationFill: background,
    },
    xyChart: {
      backgroundColor: background,
      titleColor: foreground,
      dataLabelColor: foreground,
      xAxisTitleColor: foreground,
      xAxisLabelColor: foreground,
      xAxisTickColor: foreground,
      xAxisLineColor: line,
      yAxisTitleColor: foreground,
      yAxisLabelColor: foreground,
      yAxisTickColor: foreground,
      yAxisLineColor: line,
      plotColorPalette: surfaces.join(","),
    },

    emUiFill: surface,
    emUiStroke: border,
    emProcessorFill: surfaces[1],
    emProcessorStroke: border,
    emReadModelFill: surfaces[2],
    emReadModelStroke: border,
    emCommandFill: surfaces[3],
    emCommandStroke: border,
    emEventFill: surfaces[4],
    emEventStroke: border,
    emSwimlaneBackgroundOdd: background,
    emSwimlaneBackgroundStroke: raised,
    emArrowhead: line,
    emRelationStroke: line,
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: raised,
    gradientStart: border,
    gradientStop: border,
  }
}

function mermaidConfig(colors: MermaidRenderColors): MermaidConfig {
  return {
    arrowMarkerAbsolute: false,
    darkMode: colors.dark,
    deterministicIds: true,
    dompurifyConfig: {
      ALLOW_ARIA_ATTR: true,
      ALLOW_DATA_ATTR: false,
      FORBID_ATTR: ["href", "xlink:href", "src"],
      FORBID_TAGS: [
        "a",
        "audio",
        "embed",
        "foreignObject",
        "iframe",
        "image",
        "object",
        "script",
        "video",
      ],
    },
    flowchart: { htmlLabels: false },
    htmlLabels: false,
    maxEdges: 500,
    maxTextSize: maximumMermaidSourceLength,
    securityLevel: "strict",
    secure: [
      "darkMode",
      "dompurifyConfig",
      "fontFamily",
      "htmlLabels",
      "maxEdges",
      "maxTextSize",
      "securityLevel",
      "startOnLoad",
      "suppressErrorRendering",
      "theme",
      "themeCSS",
      "themeVariables",
    ],
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: mermaidThemeVariables(colors),
  }
}

function externalCssReference(value: string) {
  return (
    /@import\b/i.test(value) ||
    /url\s*\(\s*(?!["']?#[-\w.:]+["']?\s*\))/i.test(value)
  )
}

function removeExternalSvgReferences(fragment: DocumentFragment) {
  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith("on") ||
        name === "href" ||
        name === "xlink:href" ||
        name === "src" ||
        externalCssReference(attribute.value)
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  for (const style of fragment.querySelectorAll("style")) {
    if (externalCssReference(style.textContent ?? "")) style.remove()
  }
}

const sanitizedNamedPropertyPrefix = "user-content-"

/**
 * DOMPurify's strict named-property isolation prefixes SVG IDs, but it does
 * not rewrite the corresponding CSS selectors, marker URLs, or ARIA IDREFs.
 * Restore those local relationships without dropping the isolation prefix.
 */
function restoreSanitizedSvgReferences(fragment: DocumentFragment) {
  const references = [...fragment.querySelectorAll("[id]")]
    .map((element) => {
      const id = element.id
      return id.startsWith(sanitizedNamedPropertyPrefix)
        ? {
            original: id.slice(sanitizedNamedPropertyPrefix.length),
            sanitized: id,
          }
        : null
    })
    .filter(
      (
        reference
      ): reference is {
        readonly original: string
        readonly sanitized: string
      } => reference != null && reference.original.length > 0
    )
    .sort((left, right) => right.original.length - left.original.length)

  if (references.length === 0) return
  const idReferenceAttributes = new Set([
    "aria-activedescendant",
    "aria-controls",
    "aria-describedby",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
    "aria-labelledby",
    "aria-owns",
  ])
  const referenceByOriginal = new Map(
    references.map(({ original, sanitized }) => [original, sanitized])
  )
  const rewriteFragments = (value: string) => {
    let rewritten = value
    for (const { original, sanitized } of references) {
      rewritten = rewritten.split(`#${original}`).join(`#${sanitized}`)
    }
    return rewritten
  }

  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name === "id") continue
      const rewritten = idReferenceAttributes.has(name)
        ? attribute.value
            .split(/\s+/)
            .map((token) => referenceByOriginal.get(token) ?? token)
            .join(" ")
        : rewriteFragments(attribute.value)
      if (rewritten !== attribute.value) {
        element.setAttribute(attribute.name, rewritten)
      }
    }
  }
  for (const style of fragment.querySelectorAll("style")) {
    const css = style.textContent ?? ""
    const rewritten = rewriteFragments(css)
    if (rewritten !== css) style.textContent = rewritten
  }
}

const cssPaintToken =
  /url\([^)]*\)|var\([^)]*\)|#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b[a-z][\w-]*\b/gi

const cssNonColorPaintKeywords = new Set([
  "context-fill",
  "context-stroke",
  "currentcolor",
  "inherit",
  "initial",
  "none",
  "revert",
  "revert-layer",
  "unset",
])

function isMermaidPaintProperty(name: string) {
  const normalized = name.toLowerCase()
  return (
    normalized === "color" ||
    normalized === "fill" ||
    normalized === "stroke" ||
    normalized === "background" ||
    normalized === "border" ||
    normalized === "outline" ||
    normalized === "box-shadow" ||
    normalized === "text-shadow" ||
    normalized.endsWith("color") ||
    normalized.startsWith("background-") ||
    normalized.startsWith("border-") ||
    normalized.startsWith("outline-") ||
    normalized.startsWith("fill-") ||
    normalized.startsWith("stroke-")
  )
}

function rewriteCssDeclarationPaints(
  declaration: CSSStyleDeclaration,
  rewriteColors: (value: string) => string
) {
  const properties = Array.from({ length: declaration.length }, (_, index) =>
    declaration.item(index)
  )
  for (const property of properties) {
    if (!property || !isMermaidPaintProperty(property)) continue
    const value = declaration.getPropertyValue(property)
    const rewritten = rewriteColors(value)
    if (rewritten !== value) {
      declaration.setProperty(
        property,
        rewritten,
        declaration.getPropertyPriority(property)
      )
    }
  }
}

function rewriteCssRulePaints(
  rules: CSSRuleList,
  rewriteColors: (value: string) => string
) {
  for (const rule of [...rules]) {
    const style = (rule as CSSRule & { style?: CSSStyleDeclaration }).style
    if (style) rewriteCssDeclarationPaints(style, rewriteColors)
    const nestedRules = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules
    if (nestedRules) rewriteCssRulePaints(nestedRules, rewriteColors)
  }
}

function rewrittenMermaidStyleSheet(
  ownerDocument: Document,
  css: string,
  rewriteColors: (value: string) => string
) {
  try {
    // Parsing in a detached document gives us the browser's CSS grammar
    // without briefly applying Mermaid's generated rules to the live editor.
    const parserDocument = ownerDocument.implementation.createHTMLDocument("")
    const parserStyle = parserDocument.createElement("style")
    parserStyle.textContent = css
    parserDocument.head.append(parserStyle)
    const sheet = parserStyle.sheet
    if (!sheet) return css
    rewriteCssRulePaints(sheet.cssRules, rewriteColors)
    return [...sheet.cssRules].map((rule) => rule.cssText).join("\n")
  } catch {
    return css
  }
}

function cssColorAlpha(value: string) {
  const normalized = value.trim().toLowerCase()
  const hex = /^#([\da-f]{4}|[\da-f]{8})$/.exec(normalized)?.[1]
  if (hex) {
    const alpha = hex.length === 4 ? `${hex[3]}${hex[3]}` : hex.slice(6, 8)
    return Number.parseInt(alpha, 16) / 255
  }
  if (!normalized.startsWith("rgb")) return 1
  const channels = normalized.match(/[\d.]+%?/g)
  const alpha = channels?.[3]
  if (!alpha) return 1
  const parsed = Number.parseFloat(alpha)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(0, Math.min(1, alpha.endsWith("%") ? parsed / 100 : parsed))
}

function colorWithAlpha(color: string, alpha: number) {
  if (alpha >= 0.999) return color
  const parsed = parsedCssColor(color)
  if (!parsed) return color
  return `rgba(${Math.round(parsed.red)}, ${Math.round(parsed.green)}, ${Math.round(parsed.blue)}, ${Number(alpha.toFixed(3))})`
}

/**
 * A few Mermaid renderers (notably Sankey) bypass theme variables and write
 * categorical D3 colors directly into the SVG. Replace only those residual
 * chromatic literals, retaining neutral paints and every color produced by
 * the current document-derived tonal palette.
 */
function neutralizeMermaidPaints(
  fragment: DocumentFragment,
  colors: MermaidRenderColors
) {
  const palette = mermaidTonalPalette(colors)
  const allowed = new Set(
    [
      colors.background,
      colors.foreground,
      palette.border,
      palette.line,
      ...palette.surfaces,
    ].map((color) => normalizedHexColor(color, color).toLowerCase())
  )
  const colorProbe = fragment.ownerDocument
    .createElement("canvas")
    .getContext("2d")
  const resolvedCssColor = (value: string) => {
    const parsed = parsedCssColor(value)
    if (parsed) return { alpha: cssColorAlpha(value), color: parsed }
    if (!colorProbe) return null
    const normalized = value.trim().toLowerCase()
    if (
      cssNonColorPaintKeywords.has(normalized) ||
      normalized.startsWith("url(") ||
      normalized.startsWith("var(")
    ) {
      return null
    }

    // Invalid assignments leave CanvasRenderingContext2D.fillStyle intact.
    // Two probes distinguish that case from a valid color matching a sentinel.
    colorProbe.fillStyle = "#010203"
    colorProbe.fillStyle = value
    const first = colorProbe.fillStyle
    colorProbe.fillStyle = "#040506"
    colorProbe.fillStyle = value
    const second = colorProbe.fillStyle
    if (first !== second) return null
    const resolved = parsedCssColor(first)
    return resolved ? { alpha: cssColorAlpha(first), color: resolved } : null
  }
  const replacements = new Map<string, string>()
  let nextTone = 0
  const replaceColor = (value: string) => {
    const resolved = resolvedCssColor(value)
    if (!resolved) return value
    const normalized = hexColor(resolved.color).toLowerCase()
    const chroma =
      Math.max(resolved.color.red, resolved.color.green, resolved.color.blue) -
      Math.min(resolved.color.red, resolved.color.green, resolved.color.blue)
    if (chroma <= 1 || allowed.has(normalized)) return value
    let replacement = replacements.get(normalized)
    if (!replacement) {
      replacement =
        palette.surfaces[nextTone % palette.surfaces.length] ?? palette.surface
      replacements.set(normalized, replacement)
      nextTone += 1
    }
    return colorWithAlpha(replacement, resolved.alpha)
  }
  const rewriteColors = (value: string) =>
    value.replace(cssPaintToken, replaceColor)
  const paintAttributes = new Set([
    "color",
    "fill",
    "flood-color",
    "lighting-color",
    "stop-color",
    "stroke",
  ])

  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (!paintAttributes.has(attribute.name.toLowerCase())) continue
      const rewritten = rewriteColors(attribute.value)
      if (rewritten !== attribute.value) {
        element.setAttribute(attribute.name, rewritten)
      }
    }
    const declaration = (element as SVGElement | HTMLElement).style
    if (declaration) rewriteCssDeclarationPaints(declaration, rewriteColors)
  }
  for (const style of fragment.querySelectorAll("style")) {
    const css = style.textContent ?? ""
    const rewritten = rewrittenMermaidStyleSheet(
      fragment.ownerDocument,
      css,
      rewriteColors
    )
    if (rewritten !== css) style.textContent = rewritten
  }
}

function normalizeMermaidSvgSize(svg: SVGSVGElement) {
  const values = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const width = values[2]
  const height = values[3]
  if (
    values.length !== 4 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width == null ||
    height == null ||
    width <= 0 ||
    height <= 0
  ) {
    return
  }
  svg.setAttribute("width", String(width))
  svg.setAttribute("height", String(height))
  svg.setAttribute("preserveAspectRatio", "xMidYMin meet")
  // Mermaid writes an inline pixel max-width on the root SVG. That inline
  // declaration otherwise wins over the preview theme and lets wide diagrams
  // overflow their host instead of scaling down with the document column.
  svg.style.maxWidth = "100%"
}

async function sanitizedMermaidSvg(
  host: HTMLElement,
  source: string,
  colors: MermaidRenderColors,
  isLive: () => boolean
) {
  const ownerDocument = host.ownerDocument
  const { default: mermaid } = await loadMermaid()
  const rendered = await enqueueMermaidRender(async () => {
    if (!isLive()) return null
    mermaid.initialize(mermaidConfig(colors))
    return mermaid.render(renderId(), source)
  })
  if (!rendered) return null
  const fragment = await sanitizedFragment(ownerDocument, rendered.svg, {
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["href", "xlink:href", "src"],
    FORBID_TAGS: [
      "a",
      "audio",
      "embed",
      "foreignObject",
      "iframe",
      "image",
      "object",
      "script",
      "video",
    ],
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    USE_PROFILES: { svg: true, svgFilters: false },
  })
  removeExternalSvgReferences(fragment)
  restoreSanitizedSvgReferences(fragment)
  neutralizeMermaidPaints(fragment, colors)
  const svg = fragment.querySelector("svg")
  if (!svg) throw new Error("Mermaid did not produce a safe SVG")
  normalizeMermaidSvgSize(svg)
  return fragment
}

const maximumCachedMermaidRenders = 32
const maximumCachedMermaidRenderBytes = 16 * 1024 * 1024
const maximumCachedMermaidHeights = 64
const initialMermaidLoadingHeight = 180
const mermaidRenderCaches = new WeakMap<Document, MemoryWeightedFragmentCache>()
const mermaidHeightCache = new PreviewHeightCache(maximumCachedMermaidHeights)
let mermaidRenderGeneration = 0

function mermaidIdentityKey(source: string, occurrence: string) {
  return JSON.stringify([occurrence, source])
}

export function mermaidCacheKey(
  source: string,
  occurrence: string,
  theme: MermaidTheme,
  colors: MermaidRenderColors
) {
  return JSON.stringify([
    occurrence,
    source,
    theme,
    colors.background,
    colors.dark,
    colors.fontFamily,
    colors.foreground,
    mermaidRenderGeneration,
  ])
}

export function mermaidStyleRefreshRequested(transaction: Transaction) {
  return (
    transaction.reconfigured ||
    optionalPreviewGeometryRefreshRequested(transaction)
  )
}

function mermaidRenderCache(ownerDocument: Document) {
  let cache = mermaidRenderCaches.get(ownerDocument)
  if (!cache) {
    cache = new MemoryWeightedFragmentCache(
      maximumCachedMermaidRenders,
      maximumCachedMermaidRenderBytes
    )
    mermaidRenderCaches.set(ownerDocument, cache)
  }
  return cache
}

function cachedMermaidRender(ownerDocument: Document, key: string) {
  const cache = mermaidRenderCache(ownerDocument)
  return cache.get(key)
}

function cacheMermaidRender(
  ownerDocument: Document,
  key: string,
  fragment: DocumentFragment
) {
  return mermaidRenderCache(ownerDocument).set(key, fragment)
}

function cachedMermaidHeight(identity: string) {
  return mermaidHeightCache.get(identity)
}

function rememberMermaidHeight(identity: string, height: number) {
  mermaidHeightCache.set(identity, height)
}

export function invalidateMermaidPreviewGeometry(refreshRenders = false) {
  mermaidHeightCache.invalidate()
  if (refreshRenders) mermaidRenderGeneration += 1
}

function requestMermaidMeasure(
  diagram: HTMLElement,
  view: EditorView,
  identity: string
) {
  view.requestMeasure({
    key: diagram,
    read: (currentView) =>
      diagram.isConnected
        ? diagram.getBoundingClientRect().height / currentView.scaleY
        : null,
    write: (height) => {
      if (height != null) {
        rememberMermaidHeight(identity, height)
      }
    },
  })
}

const mermaidRenderTokens = new WeakMap<HTMLElement, object>()
const mermaidRenderSources = new WeakMap<HTMLElement, string>()
const mermaidRenderOccurrences = new WeakMap<HTMLElement, string>()

function mermaidFallback(
  ownerDocument: Document,
  source: string,
  message: string
) {
  const fallback = ownerDocument.createElement("div")
  fallback.className = "cm-md-mermaid-fallback"
  fallback.setAttribute("role", "note")

  const label = ownerDocument.createElement("div")
  label.className = "cm-md-mermaid-error-label"
  label.textContent = message
  const pre = ownerDocument.createElement("pre")
  const code = ownerDocument.createElement("code")
  code.textContent = source
  pre.append(code)
  fallback.append(label, pre)
  return fallback
}

function renderMermaidInto(
  diagram: HTMLElement,
  view: EditorView,
  source: string,
  occurrence: string,
  theme: MermaidTheme,
  retainOnFailure: boolean
) {
  const ownerDocument = view.dom.ownerDocument
  const identity = mermaidIdentityKey(source, occurrence)
  const colors = mermaidRenderColors(view.contentDOM, theme)
  const renderKey = mermaidCacheKey(source, occurrence, theme, colors)
  mermaidRenderSources.set(diagram, source)
  mermaidRenderOccurrences.set(diagram, occurrence)

  const reason = unsafeMermaidSourceReason(source)
  if (reason) {
    mermaidRenderTokens.delete(diagram)
    diagram.replaceChildren(mermaidFallback(ownerDocument, source, reason))
    diagram.style.minHeight = ""
    diagram.removeAttribute("aria-busy")
    diagram.classList.remove("cm-md-mermaid-loading")
    diagram.classList.add("cm-md-mermaid-error")
    return
  }

  const cached = cachedMermaidRender(ownerDocument, renderKey)
  if (cached) {
    mermaidRenderTokens.delete(diagram)
    diagram.replaceChildren(cached.fragment.cloneNode(true))
    diagram.style.minHeight = ""
    diagram.removeAttribute("aria-busy")
    diagram.classList.remove("cm-md-mermaid-loading", "cm-md-mermaid-error")
    requestMermaidMeasure(diagram, view, identity)
    return
  }

  const retainedSvg = retainOnFailure
    ? diagram.querySelector(":scope > svg")
    : null
  if (!retainedSvg) {
    const loading = ownerDocument.createElement("span")
    loading.className = "cm-md-mermaid-loading-label"
    loading.textContent = "Rendering diagram…"
    diagram.replaceChildren(loading)
    diagram.style.minHeight = `${cachedMermaidHeight(identity) ?? initialMermaidLoadingHeight}px`
    diagram.classList.add("cm-md-mermaid-loading")
  }
  diagram.classList.remove("cm-md-mermaid-error")
  diagram.setAttribute("aria-busy", "true")
  const token = {}
  mermaidRenderTokens.set(diagram, token)
  const isLive = () =>
    diagram.isConnected && mermaidRenderTokens.get(diagram) === token

  void sanitizedMermaidSvg(diagram, source, colors, isLive)
    .then((fragment) => {
      if (!fragment) return
      cacheMermaidRender(ownerDocument, renderKey, fragment)
      if (!isLive()) return
      diagram.replaceChildren(fragment)
      diagram.style.minHeight = ""
      diagram.removeAttribute("aria-busy")
      diagram.classList.remove("cm-md-mermaid-loading", "cm-md-mermaid-error")
      requestMermaidMeasure(diagram, view, identity)
    })
    .catch(() => {
      if (!isLive()) return
      diagram.removeAttribute("aria-busy")
      if (retainedSvg?.isConnected) return
      diagram.replaceChildren(
        mermaidFallback(
          ownerDocument,
          source,
          "Unable to render this Mermaid diagram."
        )
      )
      diagram.style.minHeight = ""
      diagram.classList.remove("cm-md-mermaid-loading")
      diagram.classList.add("cm-md-mermaid-error")
      view.requestMeasure()
    })
}

class MermaidWidget extends WidgetType {
  readonly occurrence: string
  readonly source: string
  readonly themeFor: (state: EditorState) => MermaidTheme

  constructor(
    source: string,
    occurrence: string,
    themeFor: (state: EditorState) => MermaidTheme
  ) {
    super()
    this.source = source
    this.occurrence = occurrence
    this.themeFor = themeFor
  }

  eq(other: WidgetType) {
    return (
      other instanceof MermaidWidget &&
      this.source === other.source &&
      this.occurrence === other.occurrence
    )
  }

  get estimatedHeight() {
    return (
      cachedMermaidHeight(mermaidIdentityKey(this.source, this.occurrence)) ??
      initialMermaidLoadingHeight
    )
  }

  ignoreEvent() {
    return false
  }

  destroy(dom: HTMLElement) {
    mermaidRenderTokens.delete(dom)
    mermaidRenderSources.delete(dom)
    mermaidRenderOccurrences.delete(dom)
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    renderMermaidInto(
      dom,
      view,
      this.source,
      this.occurrence,
      this.themeFor(view.state),
      mermaidRenderSources.get(dom) === this.source &&
        mermaidRenderOccurrences.get(dom) === this.occurrence
    )
    return true
  }

  toDOM(view: EditorView) {
    const ownerDocument = view.dom.ownerDocument
    const diagram = ownerDocument.createElement("div")
    diagram.className = "cm-md-mermaid"
    diagram.setAttribute("aria-label", "Mermaid diagram")
    renderMermaidInto(
      diagram,
      view,
      this.source,
      this.occurrence,
      this.themeFor(view.state),
      false
    )

    return diagram
  }
}

function selectionTouches(
  state: EditorState,
  diagram: MermaidDiagram,
  selectionActive: boolean
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? selectionActive &&
        range.head >= diagram.from &&
        range.head <= diagram.to
      : range.from < diagram.to && range.to > diagram.from
  )
}

function decorationRangesForDiagrams(
  state: EditorState,
  diagrams: readonly IdentifiedMermaidDiagram[],
  selectionActive: boolean,
  themeFor: (state: EditorState) => MermaidTheme,
  reuseFrom: DecorationSet | null = null
) {
  const ranges: Range<Decoration>[] = []
  for (const diagram of diagrams) {
    if (selectionTouches(state, diagram, selectionActive)) continue
    let reusable: Decoration | null = null
    reuseFrom?.between(diagram.from, diagram.to, (from, to, value) => {
      const widget = value.spec.widget
      if (
        from === diagram.from &&
        to === diagram.to &&
        value.spec.markdownPreviewKind === "mermaid" &&
        widget instanceof MermaidWidget &&
        widget.source === diagram.source &&
        widget.occurrence === diagram.occurrence
      ) {
        reusable = value
      }
    })
    ranges.push(
      (
        reusable ??
        Decoration.replace({
          block: true,
          inclusive: false,
          markdownPreviewKind: "mermaid",
          widget: new MermaidWidget(
            diagram.source,
            diagram.occurrence,
            themeFor
          ),
        })
      ).range(diagram.from, diagram.to)
    )
  }
  return ranges
}

function decorationsForDiagrams(
  state: EditorState,
  diagrams: readonly IdentifiedMermaidDiagram[],
  selectionActive: boolean,
  themeFor: (state: EditorState) => MermaidTheme
) {
  const ranges = decorationRangesForDiagrams(
    state,
    diagrams,
    selectionActive,
    themeFor
  )
  return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true)
}

/** Builds Mermaid replacements without loading Mermaid itself. */
export function buildMermaidPreviewDecorations(
  state: EditorState,
  selectionActive = true,
  theme: MermaidTheme = "default"
): DecorationSet {
  const themeFor = () => theme
  return decorationsForDiagrams(
    state,
    mermaidDiagrams(state).map((diagram, index) => ({
      ...diagram,
      occurrence: `static-${index}`,
    })),
    selectionActive,
    themeFor
  )
}

interface IdentifiedMermaidDiagram extends MermaidDiagram {
  readonly occurrence: string
}

let nextMermaidOccurrence = 1

function mermaidOccurrence() {
  const occurrence = nextMermaidOccurrence
  nextMermaidOccurrence =
    nextMermaidOccurrence >= Number.MAX_SAFE_INTEGER ? 1 : occurrence + 1
  return `diagram-${occurrence}`
}

class IndexedMermaidOccurrence extends RangeValue {
  readonly occurrence: string
  readonly source: string

  constructor(source: string, occurrence = mermaidOccurrence()) {
    super()
    this.occurrence = occurrence
    this.source = source
  }

  eq(other: RangeValue) {
    return (
      other instanceof IndexedMermaidOccurrence &&
      other.occurrence === this.occurrence &&
      other.source === this.source
    )
  }

  materialize(from: number, to: number): IdentifiedMermaidDiagram {
    return {
      from,
      occurrence: this.occurrence,
      source: this.source,
      to,
    }
  }
}

function indexedOccurrenceForDiagram(
  index: RangeSet<IndexedMermaidOccurrence> | null,
  diagram: MermaidDiagram
) {
  if (!index) return null
  let occurrence: string | null = null
  index.between(diagram.from, diagram.to, (from, to, value) => {
    if (
      from === diagram.from &&
      to === diagram.to &&
      value.source === diagram.source
    ) {
      occurrence = value.occurrence
    }
  })
  return occurrence
}

function buildDiagramIndex(
  diagrams: readonly MermaidDiagram[],
  previous: RangeSet<IndexedMermaidOccurrence> | null = null
) {
  return RangeSet.of(
    diagrams.map((diagram) => {
      const occurrence = indexedOccurrenceForDiagram(previous, diagram)
      return new IndexedMermaidOccurrence(
        diagram.source,
        occurrence ?? undefined
      ).range(diagram.from, diagram.to)
    }),
    true
  )
}

function indexedDiagrams(
  state: EditorState,
  index: RangeSet<IndexedMermaidOccurrence>,
  ranges: readonly DocumentRange[] | null = null
) {
  const diagrams: IdentifiedMermaidDiagram[] = []
  const seen = new Set<IndexedMermaidOccurrence>()
  const scan = (range: DocumentRange) => {
    index.between(range.from, range.to, (from, to, value) => {
      if (to <= range.from || from >= range.to) return
      if (seen.has(value)) return
      seen.add(value)
      diagrams.push(value.materialize(from, to))
    })
  }
  if (ranges) {
    for (const range of ranges) scan(range)
  } else {
    scan({ from: 0, to: state.doc.length })
  }
  return diagrams
}

function mergeDocumentRanges(ranges: readonly DocumentRange[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )
  const merged: DocumentRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.from > previous.to + 1) {
      merged.push(range)
      continue
    }
    merged[merged.length - 1] = {
      from: previous.from,
      to: Math.max(previous.to, range.to),
    }
  }
  return merged
}

function lineNeighborhood(
  state: EditorState,
  from: number,
  to: number
): DocumentRange {
  const clampedFrom = Math.max(0, Math.min(state.doc.length, from))
  const clampedTo = Math.max(clampedFrom, Math.min(state.doc.length, to))
  const first = state.doc.lineAt(clampedFrom)
  const last = state.doc.lineAt(
    clampedTo > clampedFrom ? clampedTo - 1 : clampedTo
  )
  return {
    from: first.number > 1 ? state.doc.line(first.number - 1).from : first.from,
    to:
      last.number < state.doc.lines
        ? state.doc.line(last.number + 1).to
        : last.to,
  }
}

function expandToTopLevelSyntax(
  state: EditorState,
  range: DocumentRange,
  tree: Tree
): DocumentRange {
  const neighborhood = lineNeighborhood(state, range.from, range.to)
  let from = neighborhood.from
  let to = neighborhood.to
  tree.iterate({
    from: neighborhood.from,
    to: neighborhood.to,
    enter(node) {
      if (node.node.parent?.parent != null || node.node.parent == null) return
      from = Math.min(from, node.from)
      to = Math.max(to, node.to)
      return false
    },
  })
  return { from, to }
}

function changedSyntaxRanges(
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  const candidates: DocumentRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const previous = expandToTopLevelSyntax(
      transaction.startState,
      {
        from: fromA,
        to: toA,
      },
      previousTree
    )
    candidates.push({
      from: transaction.changes.mapPos(previous.from, -1),
      to: transaction.changes.mapPos(previous.to, 1),
    })
    candidates.push(
      expandToTopLevelSyntax(
        transaction.state,
        { from: fromB, to: toB },
        nextTree
      )
    )
  })
  return mergeDocumentRanges(
    mergeDocumentRanges(candidates).map((range) =>
      expandToTopLevelSyntax(transaction.state, range, nextTree)
    )
  )
}

function removeIndexedDiagrams(
  index: RangeSet<IndexedMermaidOccurrence>,
  ranges: readonly DocumentRange[]
) {
  let updated = index
  for (const range of ranges) {
    updated = updated.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  return updated
}

function refreshDiagramIndex(
  previous: RangeSet<IndexedMermaidOccurrence>,
  transaction: Transaction,
  previousTree: Tree,
  nextTree: Tree
) {
  const mapped = previous.map(transaction.changes)
  if (markdownBlockPairingMayChange(transaction)) {
    return {
      index: buildDiagramIndex(
        mermaidDiagramsInRanges(transaction.state, null, nextTree),
        mapped
      ),
      ranges: [{ from: 0, to: transaction.state.doc.length }],
    }
  }

  const ranges = changedSyntaxRanges(transaction, previousTree, nextTree)
  const retained = removeIndexedDiagrams(mapped, ranges)
  const additions = mermaidDiagramsInRanges(
    transaction.state,
    ranges,
    nextTree
  ).map((diagram) =>
    new IndexedMermaidOccurrence(
      diagram.source,
      indexedOccurrenceForDiagram(mapped, diagram) ?? undefined
    ).range(diagram.from, diagram.to)
  )
  return {
    index: additions.length
      ? retained.update({ add: additions, sort: true })
      : retained,
    ranges,
  }
}

function selectionTouchesDiagramIndex(
  index: RangeSet<IndexedMermaidOccurrence>,
  selection: EditorSelection,
  selectionActive: boolean,
  documentLength: number
) {
  return selection.ranges.some((range) => {
    if (range.empty && !selectionActive) return false
    const probeFrom = range.empty ? Math.max(0, range.head - 1) : range.from
    const probeTo = range.empty
      ? Math.min(documentLength, range.head + 1)
      : range.to
    let touches = false
    index.between(probeFrom, probeTo, (from, to) => {
      if (
        range.empty
          ? range.head >= from && range.head <= to
          : range.from < to && range.to > from
      ) {
        touches = true
      }
    })
    return touches
  })
}

function diagramRangesForSelection(
  index: RangeSet<IndexedMermaidOccurrence>,
  selection: EditorSelection,
  selectionActive: boolean,
  documentLength: number
) {
  const ranges: DocumentRange[] = []
  for (const range of selection.ranges) {
    if (range.empty && !selectionActive) continue
    const probeFrom = range.empty ? Math.max(0, range.head - 1) : range.from
    const probeTo = range.empty
      ? Math.min(documentLength, range.head + 1)
      : range.to
    index.between(probeFrom, probeTo, (from, to) => {
      if (
        range.empty
          ? range.head >= from && range.head <= to
          : range.from < to && range.to > from
      ) {
        ranges.push({ from, to })
      }
    })
  }
  return mergeDocumentRanges(ranges)
}

function refreshDiagramDecorations(
  previous: DecorationSet,
  state: EditorState,
  index: RangeSet<IndexedMermaidOccurrence>,
  ranges: readonly DocumentRange[],
  selectionActive: boolean,
  themeFor: (state: EditorState) => MermaidTheme
) {
  let decorations = previous
  for (const range of ranges) {
    decorations = decorations.update({
      filter: (from, to) => to <= range.from || from >= range.to,
      filterFrom: range.from,
      filterTo: range.to,
    })
  }
  const additions = decorationRangesForDiagrams(
    state,
    indexedDiagrams(state, index, ranges),
    selectionActive,
    themeFor,
    previous
  )
  return additions.length
    ? decorations.update({ add: additions, sort: true })
    : decorations
}

interface MermaidPreviewState {
  readonly decorations: DecorationSet
  readonly diagramIndex: RangeSet<IndexedMermaidOccurrence>
  readonly presentedSelection: EditorSelection
  readonly selectionActive: boolean
  readonly tree: Tree
}

export interface MermaidLivePreviewOptions {
  /** Mirrors live-preview focus so an inactive cursor stays rendered. */
  readonly selectionActive?: (state: EditorState) => boolean
  /** Resolves the current Mermaid theme without coupling to app settings. */
  readonly theme?: MermaidTheme | ((state: EditorState) => MermaidTheme)
}

const mermaidTheme = EditorView.baseTheme({
  ".cm-md-mermaid": {
    boxSizing: "border-box",
    display: "block",
    maxWidth: boundedPreviewMaxWidth,
    minHeight: "3.5rem",
    overflowX: "auto",
    padding: "0.75rem 0",
    textAlign: "center",
    width: "100%",
  },
  ".cm-md-mermaid > svg": {
    display: "block",
    height: "auto",
    margin: "0 auto",
    maxWidth: "100%",
  },
  ".cm-md-mermaid-loading": {
    alignItems: "center",
    display: "flex",
    justifyContent: "center",
    opacity: "0.7",
  },
  ".cm-md-mermaid-loading-label, .cm-md-mermaid-error-label": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
  },
  ".cm-md-mermaid-error": {
    color: "var(--destructive)",
    textAlign: "start",
  },
  ".cm-md-mermaid-fallback pre": {
    color: "inherit",
    fontFamily: "var(--font-mono)",
    margin: "0.5rem 0 0",
    overflowX: "auto",
    whiteSpace: "pre",
  },
})

/**
 * Renders fenced Mermaid diagrams through a direct decoration field. Mermaid
 * itself is imported only when CodeMirror mounts a diagram widget.
 */
export function mermaidLivePreviewExtension(
  options: MermaidLivePreviewOptions = {}
): Extension {
  const selectionIsActive = (state: EditorState) =>
    options.selectionActive?.(state) ?? true
  const themeFor = (state: EditorState): MermaidTheme =>
    typeof options.theme === "function"
      ? options.theme(state)
      : (options.theme ?? "default")

  const previewField = StateField.define<MermaidPreviewState>({
    create(state) {
      const tree = completeMarkdownSyntaxTree(state)
      const diagrams = mermaidDiagramsInRanges(state, null, tree)
      const diagramIndex = buildDiagramIndex(diagrams)
      const selectionActive = selectionIsActive(state)
      return {
        decorations: decorationsForDiagrams(
          state,
          indexedDiagrams(state, diagramIndex),
          selectionActive,
          themeFor
        ),
        diagramIndex,
        presentedSelection: state.selection,
        selectionActive,
        tree,
      }
    },
    update(value, transaction) {
      const publishedSyntaxChanged =
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      const completeTreeAfterSyntaxChange =
        !transaction.docChanged &&
        (publishedSyntaxChanged || transaction.reconfigured)
          ? completeMarkdownSyntaxTree(transaction.state)
          : null
      const syntaxChanged =
        transaction.docChanged ||
        (completeTreeAfterSyntaxChange !== null &&
          completeTreeAfterSyntaxChange !== value.tree)
      if (
        !syntaxChanged &&
        preservePreviewDuringPointerSelection(transaction)
      ) {
        return value
      }

      const selectionActive = selectionIsActive(transaction.state)
      const presentedSelection = transaction.state.selection
      const selectionPresentationChanged =
        selectionActive !== value.selectionActive ||
        !presentedSelection.eq(value.presentedSelection)
      if (!syntaxChanged && !selectionPresentationChanged) {
        return value
      }

      if (!syntaxChanged) {
        const previousTouches = selectionTouchesDiagramIndex(
          value.diagramIndex,
          value.presentedSelection,
          value.selectionActive,
          transaction.state.doc.length
        )
        const nextTouches = selectionTouchesDiagramIndex(
          value.diagramIndex,
          presentedSelection,
          selectionActive,
          transaction.state.doc.length
        )
        if (!previousTouches && !nextTouches) return value

        const ranges = mergeDocumentRanges([
          ...diagramRangesForSelection(
            value.diagramIndex,
            value.presentedSelection,
            value.selectionActive,
            transaction.state.doc.length
          ),
          ...diagramRangesForSelection(
            value.diagramIndex,
            presentedSelection,
            selectionActive,
            transaction.state.doc.length
          ),
        ])
        return {
          ...value,
          decorations: refreshDiagramDecorations(
            value.decorations,
            transaction.state,
            value.diagramIndex,
            ranges,
            selectionActive,
            themeFor
          ),
          presentedSelection,
          selectionActive,
        }
      }

      const tree = transaction.docChanged
        ? updateCompleteMarkdownSyntaxTree(
            transaction.state,
            transaction.changes,
            value.tree
          )
        : syntaxChanged
          ? completeTreeAfterSyntaxChange!
          : value.tree
      if (!transaction.docChanged) {
        const diagramIndex = buildDiagramIndex(
          mermaidDiagramsInRanges(transaction.state, null, tree),
          value.diagramIndex
        )
        return {
          decorations: decorationsForDiagrams(
            transaction.state,
            indexedDiagrams(transaction.state, diagramIndex),
            selectionActive,
            themeFor
          ),
          diagramIndex,
          presentedSelection,
          selectionActive,
          tree,
        }
      }

      const refreshed = refreshDiagramIndex(
        value.diagramIndex,
        transaction,
        value.tree,
        tree
      )
      const diagramIndex = refreshed.index
      const mappedPresentedSelection = value.presentedSelection.map(
        transaction.changes
      )
      const ranges = mergeDocumentRanges([
        ...refreshed.ranges,
        ...diagramRangesForSelection(
          diagramIndex,
          mappedPresentedSelection,
          value.selectionActive,
          transaction.state.doc.length
        ),
        ...diagramRangesForSelection(
          diagramIndex,
          presentedSelection,
          selectionActive,
          transaction.state.doc.length
        ),
      ])
      return {
        decorations: refreshDiagramDecorations(
          value.decorations.map(transaction.changes),
          transaction.state,
          diagramIndex,
          ranges,
          selectionActive,
          themeFor
        ),
        diagramIndex,
        presentedSelection,
        selectionActive,
        tree,
      }
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  })

  const themeRefreshPlugin = ViewPlugin.fromClass(
    class {
      private frame: number | null = null
      private readonly ownerWindow: Window | null
      private theme: MermaidTheme

      constructor(view: EditorView) {
        this.ownerWindow = view.dom.ownerDocument.defaultView
        this.theme = themeFor(view.state)
      }

      private schedule(view: EditorView) {
        const ownerWindow = view.dom.ownerDocument.defaultView
        if (!ownerWindow) return
        if (this.frame != null) ownerWindow.cancelAnimationFrame(this.frame)
        this.frame = ownerWindow.requestAnimationFrame(() => {
          this.frame = null
          for (const diagram of view.dom.querySelectorAll<HTMLElement>(
            ".cm-md-mermaid"
          )) {
            const source = mermaidRenderSources.get(diagram)
            const occurrence = mermaidRenderOccurrences.get(diagram)
            if (!source || !occurrence) continue
            renderMermaidInto(
              diagram,
              view,
              source,
              occurrence,
              this.theme,
              true
            )
          }
        })
      }

      update(update: ViewUpdate) {
        const theme = themeFor(update.state)
        const stylingChanged = update.transactions.some(
          mermaidStyleRefreshRequested
        )
        if (!stylingChanged && theme === this.theme) return
        this.theme = theme
        this.schedule(update.view)
      }

      destroy() {
        if (this.frame != null) {
          this.ownerWindow?.cancelAnimationFrame(this.frame)
        }
      }
    }
  )

  const pointerSelection = semanticPreviewSelectionResolvers.of({
    priority: 50,
    resolve(view, target, position) {
      const element = target.closest<HTMLElement>(".cm-md-mermaid")
      if (!element) return null
      const sourcePosition = previewPositionAtDOM(view, element, position)
      const renderedSource = mermaidRenderSources.get(element)
      const diagram = firstNearbyPreviewRange(
        view.state,
        sourcePosition,
        (candidate) => {
          const resolved = mermaidDiagramAt(view.state, candidate)
          return !renderedSource || resolved?.source === renderedSource
            ? resolved
            : null
        }
      )
      return diagram
        ? {
            dragSelection: "atomic" as const,
            element,
            from: diagram.from,
            to: diagram.to,
          }
        : null
    },
  })

  return [previewField, themeRefreshPlugin, pointerSelection, mermaidTheme]
}
