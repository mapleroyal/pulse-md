import type { EditorState, Extension, StateEffect } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

import type { TableCellRangeSelectionSnapshot } from "./table-selection"

import type { MarkdownFormattingCommand } from "./formatting"
import type { MarkdownHeading, MarkdownOutlineHeadingLevel } from "./headings"
import type { MarkdownLinkActivation } from "./link-semantics"
import type { SpellCheckWords, SpellingCandidate } from "./spellcheck"
import type {
  AppearanceProfile,
  AppPlatform,
  CopiedHeadingLinkMetadata,
  DocumentKind,
  EditorViewport,
  MarkdownExtensionSettings,
  SerializedEditorSession,
  SourceIndentation,
} from "../shared/contracts"

export type MarkdownEditorMode = "live" | "source"
export const maximumMermaidSourceLength = 50_000

export interface OptionalLivePreviewSupport {
  blockAt(
    state: EditorState,
    position: number,
    settings: MarkdownExtensionSettings
  ): { from: number; to: number } | null
  extensions(options: {
    onNavigate: () => void
    selectionActive: (state: EditorState) => boolean
    settings: MarkdownExtensionSettings
    theme: (state: EditorState) => "dark" | "default"
  }): Extension
  refreshContentGeometry(view: EditorView, refreshRenders?: boolean): void
}

export interface MarkdownSearchOptions {
  caseSensitive?: boolean
  regexp?: boolean
  replace?: string
  wholeWord?: boolean
}

export interface MarkdownReplaceOptions {
  preserveCase?: boolean
}

export interface MarkdownNavigationLocation {
  caretVisible: boolean
  selection: {
    anchor: number
    head: number
  }
  viewport: {
    pos: number
    screenOffset: number
    scrollLeft: number
  }
}

export interface MarkdownNavigationOptions {
  recordHistory?: boolean
}

export type MarkdownNavigationLocationMapper = (
  location: MarkdownNavigationLocation
) => MarkdownNavigationLocation

export type MarkdownSearchIssue =
  "multiline-regexp-complexity-limit" | "multiline-regexp-document-limit"

export interface MarkdownSearchStatus {
  valid: boolean
  pending: boolean
  current: number | null
  total: number
  issue?: MarkdownSearchIssue
}

export interface EditorStatus {
  words: number | null
  lines: number
  characters: number
  line: number
  column: number
}

export interface MarkdownLinkTooltip {
  title: string
  anchor: {
    height: number
    left: number
    top: number
    width: number
  }
}

export interface MarkdownEditorSession {
  state: EditorState
  documentKind: DocumentKind
  documentPath: string | null
  scrollSnapshot?: StateEffect<unknown>
  mode: MarkdownEditorMode
  lineWrapping: boolean
  caretVisible: boolean
  viewport: EditorViewport
  viewportInitialized: boolean
  revision: number
}

export interface SetDocumentOptions {
  /** Whether this replacement should notify `onChange`. Defaults to true. */
  notify?: boolean
  /** Whether this replacement should be undoable. Defaults to true. */
  addToHistory?: boolean
}

export interface MarkdownEditorControllerOptions {
  parent: HTMLElement
  content?: string
  mode?: MarkdownEditorMode
  lineWrapping?: boolean
  documentKind?: DocumentKind
  /** Filesystem path used to resolve relative local image destinations. */
  documentPath?: string | null
  /** Maximum content width in pixels. Only applies while wrapping is enabled. */
  maxContentWidth?: number
  markdownExtensions?: MarkdownExtensionSettings
  optionalLivePreviewSupport?: OptionalLivePreviewSupport
  sourceIndentation?: SourceIndentation
  sourceIndentSize?: number
  appearanceProfile?: AppearanceProfile
  windowActive?: boolean
  ariaLabel?: string
  autofocus?: boolean
  /** Empty primary documents focus their caret by default; auxiliary previews opt out. */
  focusWhenEmpty?: boolean
  initialCursor?: { line: number; column: number }
  platform?: AppPlatform
  spellCheck?: boolean
  checkSpelling?: SpellCheckWords
  openLink?: (activation: MarkdownLinkActivation) => void | Promise<void>
  resolveHeadingLinkPaste?: (
    metadata: CopiedHeadingLinkMetadata
  ) => Promise<string>
  onLinkTooltipChange?: (tooltip: MarkdownLinkTooltip | null) => void
  /**
   * Fires after document changes, including undo/redo and notified setDocument calls.
   * Read content lazily with `getContent()` when it is actually needed for saving.
   */
  onChange?: (mapNavigationLocation: MarkdownNavigationLocationMapper) => void
  onModeChange?: (mode: MarkdownEditorMode) => void
  onLineWrappingChange?: (enabled: boolean) => void
  onNavigate?: (origin: MarkdownNavigationLocation) => void
  onSearchStatusChange?: (status: MarkdownSearchStatus) => void
  onStatusChange?: (status: EditorStatus) => void
}

export interface MarkdownEditorHandle {
  readonly view: EditorView
  canUndo(): boolean
  canRedo(): boolean
  hasSelection(): boolean
  getSelectedText(): string
  getOwnedPointerSelection(): string | null
  copyOwnedPointerSelection(): Promise<boolean>
  getTableCellRangeSelection(): TableCellRangeSelectionSnapshot | null
  copyTableCellRange(): Promise<boolean>
  cutTableCellRange(): Promise<boolean>
  linkActivationAtCoordinates(
    clientX: number,
    clientY: number,
    target?: Element | null
  ): MarkdownLinkActivation | null
  linkActivationAtSelection(): MarkdownLinkActivation | null
  spellingAtCoordinates(
    clientX: number,
    clientY: number
  ): SpellingCandidate | null
  replaceSpellingSelection(word: string, replacement: string): boolean
  createSession(
    content?: string,
    mode?: MarkdownEditorMode,
    documentPath?: string | null,
    lineWrapping?: boolean,
    documentKind?: DocumentKind
  ): MarkdownEditorSession
  captureSession(revision?: number): MarkdownEditorSession
  activateSession(session: MarkdownEditorSession): boolean
  replaceSessionDocument(
    session: MarkdownEditorSession,
    content: string
  ): boolean
  serializeSession(
    session: MarkdownEditorSession,
    baselineContent?: string
  ): SerializedEditorSession
  deserializeSession(
    session: SerializedEditorSession,
    documentPath?: string | null,
    documentKind?: DocumentKind
  ): MarkdownEditorSession
  getStatus(): EditorStatus
  getContent(): string
  setDocument(content: string, options?: SetDocumentOptions): void
  getMode(): MarkdownEditorMode
  getDocumentKind(): DocumentKind
  setMode(mode: MarkdownEditorMode): void
  toggleMode(): MarkdownEditorMode
  getLineWrapping(): boolean
  setLineWrapping(enabled: boolean): void
  toggleLineWrapping(): boolean
  setMaxContentWidth(width: number | undefined): void
  setMarkdownExtensions(extensions: MarkdownExtensionSettings): void
  setOptionalLivePreviewSupport(support: OptionalLivePreviewSupport): void
  setPathCompletionExtension(extension: Extension): void
  setDocumentIdentity(filePath: string | null, documentKind: DocumentKind): void
  setDocumentPath(filePath: string | null): void
  setRemoteImagesEnabled(enabled: boolean): void
  setSourceIndentation(indentation: SourceIndentation, size: number): void
  setAppearanceProfile(profile: AppearanceProfile): void
  setWindowActive(active: boolean): void
  setReadOnly(readOnly: boolean): void
  setSpellCheck(enabled: boolean): void
  setContextMenuFocusRetained(retained: boolean): void
  refreshSpellCheck(word?: string): void
  refreshContentGeometry(refreshRenders?: boolean): void
  setSearchQuery(query: string, options?: MarkdownSearchOptions): boolean
  getSearchStatus(): MarkdownSearchStatus
  findNext(): boolean
  findPrevious(): boolean
  replaceNext(options?: MarkdownReplaceOptions): boolean
  replaceAll(options?: MarkdownReplaceOptions): boolean
  clearSearch(): void
  getHeadings(): readonly MarkdownHeading[]
  getCurrentHeading(): MarkdownHeading | null
  captureNavigationLocation(): MarkdownNavigationLocation
  restoreNavigationLocation(location: MarkdownNavigationLocation): boolean
  jumpToHeading(
    heading: MarkdownHeading | string,
    options?: MarkdownNavigationOptions
  ): boolean
  jumpToFragment(
    destination: string,
    options?: MarkdownNavigationOptions
  ): boolean
  navigateHeading(
    direction: -1 | 1,
    level?: MarkdownOutlineHeadingLevel,
    options?: MarkdownNavigationOptions
  ): boolean
  setCursorPosition(line: number, column: number): boolean
  setSessionCursorPosition(
    session: MarkdownEditorSession,
    line: number,
    column: number
  ): boolean
  applyFormatting(command: MarkdownFormattingCommand): boolean
  undo(): boolean
  redo(): boolean
  selectAll(): boolean
  focus(): void
  /** Focuses the editor without changing its visible-caret state. */
  focusSurface(): void
  /** Restores editor focus only when the document was already being edited. */
  restoreFocus(): void
  requestMeasure(): void
  destroy(): void
}
