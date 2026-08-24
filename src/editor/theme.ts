import { EditorView } from "@codemirror/view"

const monoFontFamily =
  "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace)"
const monoFontLigatures = "var(--editor-font-ligatures, normal)"
const sansFontFamily =
  "var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)"
const appCornerShape = "var(--app-corner-shape, round)"
const appCornerRadius = (radius: string) =>
  `calc(${radius} * var(--app-corner-radius-scale, 1))`
export const boundedPreviewMaxWidth =
  "var(--cm-md-bounded-preview-max-width, calc(100vw - 4.5rem))"
const editorTextLineHeight = 1.4
const editorLinePaddingBlockPx = 2
const sourceGutterLineHeight = `calc(${editorTextLineHeight}em + ${editorLinePaddingBlockPx * 2}px)`

export const markdownEditorTheme = EditorView.baseTheme({
  "&": {
    "--cm-md-bounded-preview-max-width": "calc(100vw - 4.5rem)",
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--document-foreground, #171717)",
    fontSize: "var(--editor-font-size, 20px)",
    fontWeight: "445",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    cursor: "default",
    height: "100%",
    outline: "none",
    overflow: "auto",
    fontFamily: sansFontFamily,
    scrollPaddingTop:
      "max(var(--window-chrome-height, 46px), var(--editor-clip-top, 0px))",
  },
  ".cm-content": {
    boxSizing: "border-box",
    cursor: "default",
    minHeight: "100%",
    padding:
      "var(--editor-content-top-padding, var(--window-chrome-height, 46px)) clamp(0.75rem, 4vw, 2.25rem) 30vh",
    caretColor: "currentColor",
  },
  ".cm-line": {
    cursor: "text",
    padding: `${editorLinePaddingBlockPx}px 0`,
  },
  "&.cm-md-editor .cm-content .cm-app-spelling-error": {
    textDecorationColor: "#d1242f !important",
    textDecorationLine: "underline !important",
    textDecorationSkipInk: "none",
    textDecorationStyle: "wavy !important",
    textDecorationThickness: "1.15px",
    textUnderlineOffset: "0.14em",
  },
  "&.cm-md-pointer-in-text-lane .cm-content": {
    cursor: "text",
  },
  ".cm-gutters": {
    border: "none",
    backgroundColor: "transparent",
    color: "color-mix(in oklab, currentColor 42%, transparent)",
    cursor: "default",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.5rem",
    padding: "0 0.75rem 0 0.5rem",
  },
  "&.cm-md-source .cm-lineNumbers .cm-activeLineGutter": {
    backgroundColor: "transparent",
    color:
      "color-mix(in oklab, var(--document-foreground, #171717) 64%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "currentColor",
  },
  ".cm-md-semantic-boundary-caret": {
    position: "absolute",
    zIndex: "20",
    width: "2px",
    borderRadius: "1px",
    backgroundColor: "currentColor",
    pointerEvents: "none",
    transform: "translateX(-1px)",
  },
  ".cm-md-rendered-selection-copy-buffer": {
    position: "fixed",
    zIndex: "-1",
    top: "0",
    left: "-100000px",
    contain: "layout style paint",
    opacity: "0",
    pointerEvents: "none",
  },
  "&.cm-md-caret-hidden .cm-content": {
    caretColor: "transparent",
  },
  "&.cm-md-caret-hidden .cm-cursor": {
    display: "none !important",
  },
  "&.cm-md-table-range-selection .cm-content": {
    caretColor: "transparent",
  },
  "&.cm-md-table-range-selection .cm-cursor": {
    display: "none !important",
  },
  "&.cm-md-source .cm-content": {
    fontFamily: monoFontFamily,
    fontVariantLigatures: monoFontLigatures,
    fontSize: "var(--editor-code-font-size, 20px)",
    lineHeight: String(editorTextLineHeight),
  },
  "&.cm-md-source .cm-gutters": {
    fontFamily: monoFontFamily,
    fontVariantLigatures: monoFontLigatures,
    fontSize: "var(--editor-code-font-size, 20px)",
  },
  "&.cm-md-source .cm-lineNumbers .cm-gutterElement": {
    fontVariantNumeric: "tabular-nums",
    // CodeMirror gives the gutter the full logical-line height. Include the
    // content line's block padding in its first-row line box so the glyphs
    // share a baseline without vertically centering wrapped line numbers.
    lineHeight: sourceGutterLineHeight,
  },
  "&.cm-md-live .cm-content": {
    lineHeight: String(editorTextLineHeight),
  },
  "&.cm-md-live .cm-md-heading": {
    fontWeight: "normal",
    position: "relative",
  },
  "&.cm-md-live .cm-md-heading *": {
    color: "inherit !important",
    fontWeight: "inherit",
    textDecoration: "none !important",
  },
  "&.cm-md-live .cm-md-heading-anchor": {
    alignItems: "center",
    background: "none",
    border: "0",
    boxSizing: "border-box",
    color: "color-mix(in oklab, currentColor 58%, transparent) !important",
    cursor: "pointer",
    display: "inline-flex",
    height: `${editorTextLineHeight}em`,
    justifyContent: "flex-start",
    left: "-1.75rem",
    opacity: "0",
    padding: "0",
    position: "absolute",
    top: `calc(${editorLinePaddingBlockPx}px + ${editorTextLineHeight / 2}em)`,
    transform: "translateY(-50%)",
    transition: "opacity 120ms ease, color 120ms ease",
    width: "1.75rem",
    zIndex: "1",
  },
  "&.cm-md-live .cm-md-heading-anchor svg": {
    height: "1rem",
    pointerEvents: "none",
    width: "1rem",
  },
  "&.cm-md-live .cm-md-heading:hover .cm-md-heading-anchor, &.cm-md-live .cm-md-heading-anchor:hover, &.cm-md-live .cm-md-heading-anchor:focus-visible":
    {
      opacity: "0.82",
    },
  "&.cm-md-live .cm-md-heading-anchor:hover, &.cm-md-live .cm-md-heading-anchor:focus-visible":
    {
      color: "currentColor !important",
      opacity: "1",
    },
  "&.cm-md-live .cm-md-heading-1": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-1-font-scale, 2.3))",
    fontWeight: "var(--editor-heading-1-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-heading-2": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-2-font-scale, 1.9))",
    fontWeight: "var(--editor-heading-2-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-heading-3": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-3-font-scale, 1.6))",
    fontWeight: "var(--editor-heading-3-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-heading-4": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-4-font-scale, 1.3))",
    fontWeight: "var(--editor-heading-4-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-heading-5": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-5-font-scale, 1.15))",
    fontWeight: "var(--editor-heading-5-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-heading-6": {
    fontSize:
      "calc(var(--editor-font-size, 20px) * var(--editor-heading-6-font-scale, 1))",
    fontWeight: "var(--editor-heading-6-font-weight, 700)",
  },
  "&.cm-md-live .cm-md-strong": { fontWeight: "700" },
  "&.cm-md-live .cm-md-emphasis": { fontStyle: "italic" },
  "&.cm-md-live .cm-md-strikethrough": { textDecoration: "line-through" },
  "&.cm-md-live .cm-md-superscript, &.cm-md-live .cm-md-subscript": {
    fontSize: "0.72em",
    lineHeight: "0",
  },
  "&.cm-md-live .cm-md-superscript": { verticalAlign: "super" },
  "&.cm-md-live .cm-md-subscript": { verticalAlign: "sub" },
  "&.cm-md-editor .cm-md-strikethrough-delimiter, &.cm-md-editor .cm-md-strikethrough-delimiter *":
    { textDecoration: "none !important" },
  "&.cm-md-live .cm-md-link": {
    color: "color-mix(in oklab, #2563eb 86%, currentColor)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklab, currentColor 35%, transparent)",
    textUnderlineOffset: "0.16em",
  },
  "&.cm-md-live .cm-md-link *": {
    color: "inherit !important",
  },
  "&.cm-md-live.cm-md-open-link-modifier .cm-md-openable-link": {
    cursor: "pointer",
  },
  "&.cm-md-live .cm-md-inline-code": {
    borderRadius: "0.3rem",
    backgroundColor:
      "var(--inline-code-surface-background, color-mix(in oklab, currentColor 8%, transparent))",
    fontFamily: monoFontFamily,
    fontVariantLigatures: monoFontLigatures,
    fontSize: "var(--editor-code-font-size, 20px)",
    lineHeight: "1.65",
    padding: "0.12em 0.3em",
  },
  "&.cm-md-live .cm-md-image": {
    display: "inline-block",
    maxWidth: `min(100%, ${boundedPreviewMaxWidth})`,
    height: "auto",
    borderRadius: appCornerRadius("0.5rem"),
    cornerShape: appCornerShape,
    verticalAlign: "middle",
  },
  "&.cm-md-live .cm-md-list-line": {
    paddingInlineStart: "var(--cm-md-list-edge-indent, 1.5rem)",
  },
  "&.cm-md-live .cm-md-list-marker-line": {
    paddingInlineStart:
      "calc(var(--cm-md-list-edge-indent, 1.5rem) + var(--cm-md-list-hanging-indent, 1.4rem))",
    textIndent:
      "var(--cm-md-list-first-line-indent, calc(0px - var(--cm-md-list-hanging-indent, 1.4rem)))",
  },
  "&.cm-md-live .cm-md-list-marker-source": {
    boxSizing: "border-box",
    direction: "ltr",
    display: "inline-block",
    width: "calc(var(--cm-md-list-current-marker-lane, 1.4rem) - 0.25em)",
    textAlign: "end",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
  },
  "&.cm-md-live .cm-md-list-marker-ordered": {
    direction: "ltr",
    unicodeBidi: "isolate",
  },
  "&.cm-md-live .cm-md-list-marker-separator-source": {
    direction: "ltr",
    display: "inline-block",
    fontFamily: monoFontFamily,
    letterSpacing:
      "calc(var(--cm-md-list-marker-separator-unit, 0.25em) - 1ch)",
    tabSize: "1",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
    width: "0.25em",
  },
  "&.cm-md-live .cm-md-list-prefix-bidi-isolate": {
    direction: "ltr",
    unicodeBidi: "isolate",
  },
  "&.cm-md-live .cm-md-list-quote-prefix-source": {
    boxSizing: "border-box",
    display: "inline-block",
    fontFamily: monoFontFamily,
    letterSpacing: "calc(var(--cm-md-list-quote-cell, 0.5em) - 1ch)",
    marginInlineStart: "calc(0px - var(--cm-md-list-quote-prefix-width, 0px))",
    tabSize: "4",
    textIndent: "0",
    whiteSpace: "pre",
    width: "var(--cm-md-list-quote-prefix-width, 0px)",
  },
  "&.cm-md-live .cm-md-list-quote-prefix-flow": {
    marginInlineStart: "0",
  },
  "&.cm-md-live .cm-md-list-quote-prefix-rendered": {
    WebkitTextFillColor: "transparent",
  },
  "&.cm-md-live .cm-md-list-marker-rendered": {
    color: "color-mix(in oklab, currentColor 72%, transparent)",
  },
  "&.cm-md-live .cm-md-list-indent-source": {
    direction: "ltr",
    display: "inline-block",
    fontFamily: monoFontFamily,
    // Give every authored indentation column the same advance used by the
    // semantic prefix lane. This keeps deep prefixes source-mapped without
    // letting proportional spaces overflow backward into the marker.
    letterSpacing: "calc(0.25em - 1ch)",
    tabSize: "4",
    width: "var(--cm-md-list-current-source-indent, 0px)",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
  },
  "&.cm-md-live .cm-md-definition-term": {
    paddingBlockStart: "0.3rem",
    fontWeight: "600",
  },
  "&.cm-md-live .cm-md-definition-description": {
    paddingInlineStart: "1.5rem",
  },
  "&.cm-md-live .cm-md-definition-marker-line": {
    textIndent:
      "calc(0px - var(--cm-md-definition-source-indent, 0px) - var(--cm-md-definition-marker-lane, 1.1rem))",
  },
  "&.cm-md-live .cm-md-definition-indent-source": {
    direction: "ltr",
    display: "inline-block",
    fontFamily: monoFontFamily,
    letterSpacing: "calc(0.25em - 1ch)",
    tabSize: "4",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
    width: "var(--cm-md-definition-source-indent, 0px)",
  },
  "&.cm-md-live .cm-md-definition-source-mark": {
    boxSizing: "border-box",
    color: "color-mix(in oklab, currentColor 58%, transparent)",
    direction: "ltr",
    display: "inline-block",
    fontFamily: monoFontFamily,
    textAlign: "end",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
    width: "calc(var(--cm-md-definition-marker-lane, 1.1rem) - 0.25em)",
  },
  "&.cm-md-live .cm-md-definition-prefix-rendered": {
    WebkitTextFillColor: "transparent",
  },
  "&.cm-md-live .cm-md-definition-separator-source": {
    direction: "ltr",
    display: "inline-block",
    fontFamily: monoFontFamily,
    letterSpacing: "calc(var(--cm-md-definition-separator-unit, 0.25em) - 1ch)",
    tabSize: "1",
    textIndent: "0",
    unicodeBidi: "isolate",
    whiteSpace: "pre",
    width: "0.25em",
  },
  "&.cm-md-live .cm-md-yaml-frontmatter": {
    boxSizing: "border-box",
    backgroundColor:
      "var(--code-block-surface-background, color-mix(in oklab, currentColor 6%, transparent))",
    borderRadius: appCornerRadius("10px"),
    cornerShape: appCornerShape,
    maxWidth: boundedPreviewMaxWidth,
    minWidth: "0",
    overflowX: "auto",
    overflowY: "clip",
    overscrollBehaviorInline: "contain",
    scrollbarWidth: "thin",
    width: "100%",
  },
  "&.cm-md-live .cm-md-yaml-frontmatter-line": {
    boxSizing: "border-box",
    fontFamily: monoFontFamily,
    fontVariantLigatures: monoFontLigatures,
    fontSize: "calc(var(--editor-code-font-size, 20px) * 0.86)",
    lineHeight: "1.4",
    paddingInline: "12px",
  },
  "&.cm-md-live .cm-md-yaml-frontmatter-first": {
    paddingBlockStart: "8px",
  },
  "&.cm-md-live .cm-md-yaml-frontmatter-last": {
    paddingBlockEnd: "8px",
  },
  "&.cm-md-live .cm-md-yaml-frontmatter-mark": {
    color: "color-mix(in oklab, currentColor 42%, transparent)",
  },
  "&.cm-md-live .cm-md-list-marker-unordered": {
    display: "inline-block",
    height: "1em",
    fontSize: "1em",
    lineHeight: "1",
    paddingInlineEnd: "0",
    position: "relative",
    textAlign: "center",
    verticalAlign: "0",
  },
  "&.cm-md-live .cm-md-list-marker-unordered.cm-md-list-marker-rendered, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-unordered":
    {
      WebkitTextFillColor: "transparent",
    },
  "&.cm-md-live .cm-md-list-marker-source.cm-md-list-marker-unordered.cm-md-list-marker-rendered::selection, &.cm-md-live .cm-md-list-marker-source.cm-md-list-marker-unordered.cm-md-list-marker-rendered *::selection, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-source.cm-md-list-marker-unordered::selection, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-source.cm-md-list-marker-unordered *::selection":
    {
      color: "transparent !important",
      WebkitTextFillColor: "transparent !important",
    },
  "&.cm-md-live .cm-md-list-marker-unordered.cm-md-list-marker-rendered::before, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-unordered::before":
    {
      boxSizing: "border-box",
      width: "0.44em",
      height: "0.44em",
      borderRadius: "999px",
      backgroundColor: "currentColor",
      content: '""',
      cornerShape: "round",
      forcedColorAdjust: "none",
      inset: "0",
      margin: "auto",
      pointerEvents: "none",
      position: "absolute",
    },
  "&.cm-md-live .cm-md-list-marker-depth-2.cm-md-list-marker-rendered::before, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-depth-2::before":
    {
      width: "0.48em",
      height: "0.48em",
      border: "0.085em solid currentColor",
      backgroundColor: "transparent",
    },
  "&.cm-md-live .cm-md-list-marker-depth-3.cm-md-list-marker-rendered::before, &.cm-md-live .cm-md-list-marker-rendered .cm-md-list-marker-depth-3::before":
    {
      width: "0.4em",
      height: "0.4em",
      borderRadius: "0.035em",
    },
  "&.cm-md-live .cm-md-code-block": {
    "--cm-md-code-inline-padding": "12px",
    boxSizing: "border-box",
    width: "100%",
    maxWidth: boundedPreviewMaxWidth,
    minHeight: "40px",
    minWidth: "0",
    alignSelf: "stretch",
    overflowX: "auto",
    overflowY: "clip",
    borderRadius: appCornerRadius("10px"),
    backgroundColor:
      "var(--code-block-surface-background, color-mix(in oklab, currentColor 6%, transparent))",
    cornerShape: appCornerShape,
    scrollbarWidth: "thin",
  },
  "&.cm-md-live .cm-md-code-block[data-code-wrap=true]": {
    overflowX: "hidden",
  },
  "&.cm-md-editor > .cm-scroller > .cm-selectionLayer": {
    visibility: "hidden",
  },
  "&.cm-md-live[data-code-native-selection] > .cm-scroller > .cm-app-selectionLayer, &.cm-md-live[data-code-native-selection] > .cm-scroller > .cm-cursorLayer":
    {
      visibility: "hidden",
    },
  "&.cm-md-live[data-code-native-selection] .cm-line": {
    "&::selection, & ::selection": {
      backgroundColor: "#4c7096 !important",
      color: "#f8fafc !important",
    },
  },
  "&.cm-md-live[data-code-native-selection]:not(.cm-md-caret-hidden) .cm-md-code-line":
    {
      caretColor: "currentColor !important",
    },
  "&.cm-md-live.cm-window-inactive[data-code-native-selection] .cm-md-code-line":
    {
      "&::selection, & ::selection": {
        backgroundColor: "#59616a !important",
        color: "#f8fafc !important",
      },
    },
  "&.cm-md-live [data-semantic-native-selection]::selection, &.cm-md-live [data-semantic-native-selection] *::selection":
    {
      backgroundColor: "#4c7096 !important",
      color: "#f8fafc !important",
    },
  "&.cm-md-live.cm-window-inactive [data-semantic-native-selection]::selection, &.cm-md-live.cm-window-inactive [data-semantic-native-selection] *::selection":
    {
      backgroundColor: "#59616a !important",
      color: "#f8fafc !important",
    },
  "&.cm-md-live [data-semantic-boundary-target]::selection, &.cm-md-live [data-semantic-boundary-target] *::selection":
    {
      backgroundColor: "transparent !important",
      color: "inherit !important",
    },
  "&.cm-md-live .cm-md-code-line": {
    boxSizing: "border-box",
    backgroundColor: "transparent",
    fontFamily: monoFontFamily,
    fontVariantLigatures: monoFontLigatures,
    fontSize: "var(--editor-code-font-size, 20px)",
    lineHeight: "1.4",
    paddingInline: "var(--cm-md-code-inline-padding)",
    whiteSpace: "pre",
    wordBreak: "normal",
    overflowWrap: "normal",
  },
  "&.cm-md-live .cm-md-code-line-first, &.cm-md-live .cm-md-code-line-last": {
    paddingInlineStart:
      "calc(var(--cm-md-code-inline-padding) + var(--cm-md-code-number-lane, 3.1rem))",
  },
  "&.cm-md-live .cm-md-code-block[data-code-wrap=true] .cm-md-code-line": {
    whiteSpace: "break-spaces",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  "&.cm-md-live .cm-md-code-indent-source": {
    display: "inline-block",
    fontFamily: monoFontFamily,
    letterSpacing: "calc(0.25em - 1ch)",
    marginInlineStart: "calc(0px - var(--cm-md-code-indent-width, 0px))",
    tabSize: "4",
    textIndent: "0",
    whiteSpace: "pre",
    width: "var(--cm-md-code-indent-width, 0px)",
  },
  "&.cm-md-live .cm-md-code-indent-rendered": {
    WebkitTextFillColor: "transparent",
  },
  "&.cm-md-live .cm-md-code-content-line": {
    "--cm-md-code-number-lane": "3.1rem",
    position: "relative",
    paddingInlineStart:
      "calc(var(--cm-md-code-inline-padding) + var(--cm-md-code-number-lane))",
  },
  "&.cm-md-live .cm-md-code-content-line::before": {
    position: "absolute",
    insetBlockStart: "2px",
    insetInlineStart: "var(--cm-md-code-inline-padding)",
    display: "block",
    width: "2.25rem",
    color: "color-mix(in oklab, currentColor 36%, transparent)",
    content: "attr(data-code-line-number)",
    pointerEvents: "none",
    textAlign: "start",
    textIndent: "0",
    userSelect: "none",
  },
  "&.cm-md-live .cm-md-code-active-line::before": {
    color: "color-mix(in oklab, currentColor 64%, transparent)",
  },
  "&.cm-md-live .cm-md-code-tools-line": {
    minHeight: "36px",
    paddingBlock: "0",
    lineHeight: "36px",
    whiteSpace: "pre",
    wordBreak: "normal",
    overflowWrap: "normal",
  },
  "&.cm-md-live .cm-md-code-tools-host": {
    position: "sticky",
    zIndex: "2",
    insetInlineStart: "0",
    display: "block",
    width: "100%",
    height: "0",
    overflow: "visible",
  },
  "&.cm-md-live .cm-md-code-tools-host-indented": {
    height: "0",
    pointerEvents: "none",
  },
  "&.cm-md-live .cm-md-code-tools-host-indented .cm-md-code-tools": {
    insetBlockStart: "calc(var(--editor-code-font-size, 20px) * -1.4 + 4px)",
    paddingInlineStart: "0",
    pointerEvents: "auto",
  },
  "&.cm-md-live .cm-md-code-tools": {
    position: "absolute",
    zIndex: "2",
    insetBlockStart: "-28px",
    insetInlineEnd: "8px",
    display: "inline-flex",
    maxWidth: "calc(100% - 16px)",
    height: "28px",
    alignItems: "center",
    paddingInlineStart: "24px",
    borderRadius: appCornerRadius("5px"),
    background: "transparent",
    cornerShape: appCornerShape,
    pointerEvents: "auto",
    textIndent: "0",
    userSelect: "none",
  },
  "&.cm-md-live .cm-md-code-actions": {
    display: "inline-flex",
    width: "0",
    height: "28px",
    flex: "0 0 auto",
    alignItems: "center",
    gap: "4px",
    marginInlineStart: "0",
    overflow: "hidden",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 90ms ease",
  },
  "&.cm-md-live .cm-md-code-block:hover .cm-md-code-actions, &.cm-md-live .cm-md-code-block[data-code-pointer-selecting] .cm-md-code-actions, &.cm-md-live .cm-md-code-tools:focus-within .cm-md-code-actions":
    {
      width: "84px",
      marginInlineStart: "4px",
      opacity: "1",
      pointerEvents: "auto",
    },
  "&.cm-md-live .cm-md-code-block:hover .cm-md-code-language, &.cm-md-live .cm-md-code-block[data-code-pointer-selecting] .cm-md-code-language, &.cm-md-live .cm-md-code-tools:focus-within .cm-md-code-language":
    {
      marginInlineEnd: "0",
    },
  "&.cm-md-live .cm-md-code-language": {
    minWidth: "0",
    maxWidth: "14rem",
    marginInlineEnd: "7px",
    overflow: "hidden",
    color: "color-mix(in oklab, currentColor 58%, transparent)",
    fontFamily: monoFontFamily,
    fontSize: "20px",
    lineHeight: "1.2",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
  },
  "&.cm-md-live .cm-md-code-tool": {
    position: "relative",
    display: "inline-grid",
    width: "40px",
    height: "28px",
    flex: "0 0 auto",
    placeItems: "center",
    padding: "0",
    border: "0",
    borderRadius: appCornerRadius("4px"),
    appearance: "none",
    background: "transparent",
    color: "color-mix(in oklab, currentColor 66%, transparent)",
    cornerShape: appCornerShape,
    cursor: "default",
  },
  "&.cm-md-live .cm-md-code-block[data-code-kind=indented]:hover .cm-md-code-tool, &.cm-md-live .cm-md-code-block[data-code-kind=indented][data-code-pointer-selecting] .cm-md-code-tool, &.cm-md-live .cm-md-code-tools-host-indented .cm-md-code-tool:focus-visible":
    {
      backgroundColor:
        "color-mix(in oklab, var(--document-foreground, currentColor) 6%, var(--document-background, #fff))",
    },
  "&.cm-md-live .cm-md-code-tool:hover, &.cm-md-live .cm-md-code-tool:focus-visible":
    {
      color: "currentColor",
      outline: "none",
    },
  "&.cm-md-live .cm-md-code-tool:focus-visible": {
    boxShadow:
      "inset 0 0 0 2px var(--ring, var(--document-foreground, currentColor))",
  },
  "&.cm-md-live .cm-md-code-tool svg": {
    width: "26px",
    height: "26px",
  },
  "&.cm-md-live .cm-md-code-tooltip": {
    position: "fixed",
    zIndex: "50",
    display: "block",
    boxSizing: "border-box",
    width: "max-content",
    maxWidth: "min(20rem, calc(100vw - 5rem))",
    padding: "6px 12px",
    borderRadius: appCornerRadius("12px"),
    backgroundColor: "var(--foreground, #171717)",
    color: "var(--background, #fff)",
    cornerShape: appCornerShape,
    fontFamily: sansFontFamily,
    fontSize: "12px",
    fontWeight: "400",
    lineHeight: "16px",
    opacity: "0",
    pointerEvents: "none",
    textAlign: "center",
    textIndent: "0",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
    visibility: "hidden",
    transform: "translateY(-2px) scale(0.95)",
    transition: "opacity 80ms ease, transform 80ms ease",
  },
  "&.cm-md-live .cm-md-code-tooltip::after": {
    position: "absolute",
    left: "var(--cm-md-code-tooltip-arrow-left, calc(50% - 5px))",
    width: "10px",
    height: "10px",
    borderRadius: "2px",
    backgroundColor: "inherit",
    content: '""',
    transform: "rotate(45deg)",
  },
  "&.cm-md-live .cm-md-code-tooltip[data-side=bottom]::after": {
    top: "-4px",
  },
  "&.cm-md-live .cm-md-code-tooltip[data-side=top]::after": {
    bottom: "-4px",
  },
  "&.cm-md-live .cm-md-code-tooltip[data-visible]": {
    opacity: "1",
    visibility: "visible",
    transform: "translateY(0) scale(1)",
  },
  "&.cm-md-live .cm-md-code-copy[data-copied]": {
    color: "color-mix(in oklab, #22a06b 78%, currentColor)",
  },
  "&.cm-md-live .cm-md-table-scroll": {
    // Keep the prose floor tied to the actual cell padding. Eleven pixels per
    // side preserves a full 15ch content lane while allowing an otherwise
    // fitting three-column table to use the editor's narrow content viewport.
    "--cm-md-table-cell-inline-padding": "11px",
    display: "grid",
    gridTemplateColumns:
      "repeat(var(--cm-md-table-column-count), minmax(min-content, auto))",
    inlineSize: "100%",
    maxInlineSize: boundedPreviewMaxWidth,
    overflowX: "auto",
    overflowY: "hidden",
    overscrollBehaviorInline: "contain",
  },
  "&.cm-md-live .cm-md-table-line": {
    boxSizing: "border-box",
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    minInlineSize: "0",
    padding: "0",
    position: "relative",
  },
  "&.cm-md-live .cm-md-table-row .cm-md-table-cell": {
    borderTop: "1px solid color-mix(in oklab, currentColor 18%, transparent)",
  },
  "&.cm-md-live .cm-md-table-cell": {
    boxSizing: "border-box",
    minInlineSize: "0",
    overflowWrap: "normal",
    paddingBlock: "8px",
    paddingInline: "var(--cm-md-table-cell-inline-padding)",
    whiteSpace: "normal",
    wordBreak: "normal",
  },
  "&.cm-md-live .cm-md-table-cell-prose": {
    minInlineSize:
      "calc(15ch + var(--cm-md-table-cell-inline-padding) + var(--cm-md-table-cell-inline-padding))",
  },
  "&.cm-md-live .cm-md-table-cell-selected": {
    position: "relative",
    backgroundColor: "color-mix(in oklab, #4c7096 28%, transparent)",
  },
  "&.cm-md-live.cm-window-inactive .cm-md-table-cell-selected": {
    backgroundColor: "color-mix(in oklab, #59616a 28%, transparent)",
  },
  "&.cm-md-live .cm-md-table-cell-selected::after": {
    position: "absolute",
    inset: "0",
    zIndex: "1",
    borderColor: "#4c7096",
    borderStyle: "solid",
    borderWidth: "0",
    content: '""',
    pointerEvents: "none",
  },
  "&.cm-md-live.cm-window-inactive .cm-md-table-cell-selected::after": {
    borderColor: "#59616a",
  },
  "&.cm-md-live .cm-md-table-selection-top::after": {
    borderTopWidth: "2px",
  },
  "&.cm-md-live .cm-md-table-selection-bottom::after": {
    borderBottomWidth: "2px",
  },
  "&.cm-md-live .cm-md-table-selection-left::after": {
    borderLeftWidth: "2px",
  },
  "&.cm-md-live .cm-md-table-selection-right::after": {
    borderRightWidth: "2px",
  },
  "&.cm-md-live .cm-md-table-header .cm-md-table-cell": {
    fontWeight: "600",
  },
  "&.cm-md-live .cm-md-table-header > span:not(.cm-md-table-cell)": {
    // The GFM parser tags table headers as headings. CodeMirror's fallback
    // highlighter consequently wraps their surrounding spaces in underlined
    // spans, which become visible grid items. They are source padding, not
    // table content, so keep them out of the rendered row.
    display: "none",
  },
  "&.cm-md-live .cm-md-table-header .cm-md-table-cell > span": {
    // Undo the fallback heading style inside each rendered cell. Semantic
    // decorations such as links and strong text use their own wrapper nodes
    // and continue to style themselves normally.
    color: "inherit !important",
    fontWeight: "inherit",
    textDecoration: "none",
  },
  "&.cm-md-live .cm-md-table-line .cm-widgetBuffer": {
    display: "none",
  },
  "&.cm-md-live .cm-md-table-line > .cm-md-table-delimiter, &.cm-md-live .cm-md-table-line > .cm-md-table-prefix":
    {
      // Keep source-boundary geometry available to cursor motion at the
      // corresponding grid line without participating in track sizing.
      insetBlock: "0",
      insetInlineStart: "0",
      position: "absolute",
      width: "0",
    },
  '&.cm-md-live .cm-md-table-line > span[contenteditable="false"]:empty:not(.cm-md-table-cell):not(.cm-md-table-delimiter):not(.cm-md-table-prefix)':
    {
      display: "none",
    },
  "&.cm-md-live .cm-md-table-separator": {
    fontSize: "0",
    gridColumn: "1 / -1",
    lineHeight: "0",
    padding: "0",
  },
  "&.cm-md-live .cm-md-horizontal-rule-line": {
    background:
      "linear-gradient(color-mix(in oklab, currentColor 18%, transparent), color-mix(in oklab, currentColor 18%, transparent)) center / 100% 1px no-repeat",
  },
  "&.cm-md-live .cm-md-task-checkbox-lane": {
    display: "inline-flex",
    width: "1.4rem",
    height: "0.95rem",
    alignItems: "center",
    verticalAlign: "-0.12rem",
  },
  "&.cm-md-live .cm-md-task-checkbox": {
    width: "0.95rem",
    height: "0.95rem",
    margin: "0",
    accentColor: "currentColor",
    cursor: "default",
  },
  ".cm-app-selectionBackground, &.cm-focused .cm-app-selectionBackground": {
    backgroundColor: "#4c7096 !important",
  },
  "&.cm-window-inactive .cm-app-selectionBackground, &.cm-window-inactive.cm-focused .cm-app-selectionBackground":
    {
      backgroundColor: "#59616a !important",
    },
  "::selection": {
    backgroundColor: "#4c7096",
    color: "#f8fafc",
  },
  "&.cm-window-inactive ::selection": {
    backgroundColor: "#59616a",
    color: "#f8fafc",
  },
  "&.cm-md-editor .cm-content .cm-app-selection-foreground": {
    // The geometry layer sits below text so ordinary glyphs remain crisp, but
    // opaque semantic surfaces such as callouts would otherwise cover it.
    // Repeat the same fill on source-backed selected runs above those cards.
    backgroundColor: "#4c7096 !important",
  },
  "&.cm-window-inactive.cm-md-editor .cm-content .cm-app-selection-foreground":
    {
      backgroundColor: "#59616a !important",
    },
  "&.cm-md-editor .cm-content .cm-app-selection-foreground, &.cm-md-editor .cm-content .cm-app-selection-foreground *":
    {
      color: "#f8fafc !important",
    },
  ".cm-searchMatch": {
    backgroundColor: "#ffee2e !important",
    borderRadius: "0.15rem",
  },
  "&.cm-md-editor .cm-content .cm-searchMatch, &.cm-md-editor .cm-content .cm-searchMatch *":
    {
      color: "#111318 !important",
    },
  ".cm-searchMatch-selected": {
    backgroundColor: "#ff9500 !important",
  },
  "&.cm-md-editor .cm-content .cm-searchMatch-selected, &.cm-md-editor .cm-content .cm-searchMatch-selected *":
    {
      color: "#111318 !important",
    },
})

export function contentLayoutTheme(
  lineWrapping: boolean,
  maxContentWidth: number | undefined
) {
  const constrained = lineWrapping && maxContentWidth != null

  return EditorView.theme({
    ".cm-content": constrained
      ? {
          width: "100%",
          maxWidth: `${maxContentWidth}px`,
          marginInline: "auto",
        }
      : {
          width: lineWrapping ? "100%" : "max-content",
          minWidth: "100%",
          maxWidth: "none",
          marginInline: "0",
        },
  })
}
