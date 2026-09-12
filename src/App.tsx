import * as React from "react"
import { Text } from "@codemirror/state"
import { createPortal } from "react-dom"

import {
  loadInitialEditorFonts,
  serializedEditorContent,
  serializedEditorFontPositions,
} from "@/app/editor-font-readiness"
import { isDisposableCliTabReplacement } from "@/app/cli-tab-replacement"
import {
  createRetryableDeferredLoader,
  registerDeferredValueHandler,
  useDeferredValue,
} from "@/app/deferred-loader"
import {
  DeferredSearchOverlay as SearchOverlay,
  type SearchOverlayHandle,
} from "@/app/DeferredSearchOverlay"
import {
  DeferredDialogFailure,
  DeferredFeatureFailure,
  DeferredPopoverFailure,
  DeferredSurfaceErrorBoundary,
} from "@/app/DeferredSurface"
import type { EditorContextMenuHandoff } from "@/app/EditorContextMenu"
import type { EditorLinkTooltipHandle } from "@/app/EditorLinkTooltip"
import { fontFamilyCssStack } from "@/app/font-catalog"
import { loadIncludedFontFamilyStyles } from "@/app/font-styles"
import {
  clearSearchHandoff,
  EMPTY_SEARCH_STATUS,
  enqueueSearchHandoff,
  type SearchHandoffQueue,
  type SearchUiState,
} from "@/app/search-handoff"
import { prepareSearchOverlay } from "@/app/search-overlay-loader"
import { tabIndexForDigitShortcut } from "@/app/tab-shortcuts"
import { topControlGroupWidth } from "@/app/top-control-layout"
import type { StatusOverlayHandle } from "@/app/StatusOverlay"
import type { TabFocusPolicy } from "@/app/TopChrome"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import type { WindowProfileComposerState } from "@/app/WindowProfilesWorkspace"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"
import {
  MarkdownEditorController,
  type EditorStatus,
  type MarkdownFormattingCommand,
  type MarkdownHeading,
  type MarkdownEditorSession,
  type MarkdownEditorMode,
  type MarkdownLinkActivation,
  type MarkdownNavigationLocation,
  type MarkdownNavigationLocationMapper,
  type MarkdownOutlineHeadingLevel,
} from "@/editor/MarkdownEditorController"
import type {
  MarkdownSearchStatus,
  OptionalLivePreviewSupport,
} from "@/editor/types"
import {
  syntaxCalloutColors,
  syntaxPreviewColors,
} from "@/editor/syntax-themes/palettes"
import {
  activeTabIndicatorAdaptiveColor,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  launchTransitionCssEasing,
  resolveAppearanceProfile,
  type AppPlatform,
  type AppSettings,
  type BootstrapTab,
  type CliEditorFocusRequest,
  type CliTabsOpenRequest,
  type DocumentKind,
  type DocumentMetadata,
  type EditorCommand,
  type EditorContextMenuDetails,
  type EditorMenuState,
  type EditorViewport,
  type ExternalDocumentChange,
  type LaunchVisualEffectReady,
  type LocalLinkDisposition,
  type OpenExistingLocalLinkRequest,
  type OpenDocumentResult,
  type SettingsTransferOptions,
  type TabDescriptor,
  type TabId,
  type TopRightControlKey,
  type WindowProfileTabMode,
  type WindowProfileCaptureKind,
  type WindowProfilePickerRequest,
  type WindowTabsSnapshot,
} from "@/shared/contracts"

const TOP_DRAWER_TOP_EDGE_THRESHOLD = 12
const DOCUMENT_EDITOR_PANEL_ID = "document-editor-panel"
const NONESSENTIAL_PRELOAD_GRACE_MS = 1_500

function editorLinkAddress(activation: MarkdownLinkActivation) {
  if (activation.kind === "external" || activation.kind === "scratch") {
    return activation.href
  }
  if (activation.kind === "fragment") return `#${activation.fragment}`
  return `${activation.destination}${
    activation.fragment === null ? "" : `#${activation.fragment}`
  }`
}

function createEditorContextMenuHandoff(): EditorContextMenuHandoff {
  let contextMenuEvent: MouseEvent | null = null
  let keyDownEvent: KeyboardEvent | null = null
  let nativeDetails: EditorContextMenuDetails | null = null
  let ready = false

  return {
    activate(nextReady = true) {
      ready = nextReady
      const pending = { contextMenuEvent, keyDownEvent, nativeDetails }
      contextMenuEvent = null
      keyDownEvent = null
      nativeDetails = null
      return pending
    },
    queue(...request) {
      const [type, event] = request
      if (type === "ready") return ready
      if (ready) return false
      if (type === "contextmenu") {
        contextMenuEvent = event
        nativeDetails = null
      } else if (type === "keydown") {
        keyDownEvent = event
      } else if (
        contextMenuEvent &&
        Math.abs(event.x - contextMenuEvent.clientX) <= 1 &&
        Math.abs(event.y - contextMenuEvent.clientY) <= 1
      ) {
        nativeDetails = event
      }
      return true
    },
  }
}

interface TabFocusIntent {
  owner: Element | null
  policy: TabFocusPolicy
  revision: number
}

let loadedOptionalLivePreviewSupport: OptionalLivePreviewSupport | null = null
const loadPathCompletionModule = createRetryableDynamicImport(
  () => import("@/editor/path-completion")
)
const loadOptionalLivePreviewModule = createRetryableDynamicImport(
  () => import("@/editor/optional-live-preview")
)
const loadEditorContextMenuModule = createRetryableDynamicImport(
  () => import("@/app/EditorContextMenu")
)
const loadEditorLinkTooltipModule = createRetryableDynamicImport(
  () => import("@/app/EditorLinkTooltip")
)
const loadStatusOverlayModule = createRetryableDynamicImport(
  () => import("@/app/StatusOverlay")
)
const loadTopChromeModule = createRetryableDynamicImport(
  () => import("@/app/TopChrome")
)
const loadFormattingToolbarModule = createRetryableDynamicImport(
  () => import("@/app/FormattingToolbar")
)
const loadTypographyPreviewDocumentModule = createRetryableDynamicImport(
  () => import("@/app/typography-preview-document")
)
const loadSoftwareLicensesSurfaceModule = createRetryableDynamicImport(
  () => import("@/app/software-licenses-surface")
)
const loadSettingsScratchSnapshotModule = createRetryableDynamicImport(
  () => import("@/app/settings-scratch-snapshot")
)
const loadCodeLanguageDataModule = createRetryableDynamicImport(
  () => import("@codemirror/language-data")
)

function loadPathCompletionSupport() {
  return loadPathCompletionModule()
}

function markdownExtensionsNeedOptionalLivePreview(
  extensions: AppSettings["markdownExtensions"]
) {
  return (
    extensions.latex ||
    extensions.emojiExpansion ||
    extensions.footnotes ||
    extensions.mermaid ||
    extensions.sanitizedHtml
  )
}

function loadOptionalLivePreviewSupport() {
  return loadOptionalLivePreviewModule().then((module) => {
    loadedOptionalLivePreviewSupport = module.optionalLivePreviewSupport
    return module.optionalLivePreviewSupport
  })
}

function enableOptionalLivePreviewForDocument(
  controller: MarkdownEditorController,
  extensions: AppSettings["markdownExtensions"],
  documentKind: DocumentKind
) {
  if (
    documentKind !== "markdown" ||
    !markdownExtensionsNeedOptionalLivePreview(extensions)
  ) {
    return
  }
  if (loadedOptionalLivePreviewSupport) {
    controller.setOptionalLivePreviewSupport(loadedOptionalLivePreviewSupport)
    return
  }
  void loadOptionalLivePreviewSupport()
    .then((support) => {
      controller.setOptionalLivePreviewSupport(support)
    })
    .catch((error: unknown) => {
      console.error("Unable to load optional Markdown previews", error)
    })
}

const deferredEditorChromeLoader = createRetryableDeferredLoader(async () => {
  const [contextMenuModule, linkTooltipModule, statusOverlayModule] =
    await Promise.all([
      loadEditorContextMenuModule(),
      loadEditorLinkTooltipModule(),
      loadStatusOverlayModule(),
    ])
  return {
    EditorContextMenu: contextMenuModule.EditorContextMenu,
    EditorLinkTooltip: linkTooltipModule.EditorLinkTooltip,
    StatusOverlay: statusOverlayModule.StatusOverlay,
  }
})

const topChromeLoader = createRetryableDeferredLoader(() =>
  loadTopChromeModule().then((module) => module.TopChrome)
)

type TopChromeProps = React.ComponentProps<
  (typeof import("@/app/TopChrome"))["TopChrome"]
>

function DeferredTopChrome({
  failurePortalTarget,
  ...props
}: TopChromeProps & { failurePortalTarget: HTMLElement | null }) {
  const { error, retry, value: Surface } = useDeferredValue(topChromeLoader)
  const renderFailure = (retryAction: () => void) => {
    if (!failurePortalTarget) return null
    return createPortal(
      <DeferredFeatureFailure
        description="Tabs and window controls could not be loaded."
        title="Window controls unavailable"
        onRetry={retryAction}
      />,
      failurePortalTarget
    )
  }
  if (!Surface) return error ? renderFailure(retry) : null
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <Surface {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

function loadDeferredEditorChrome() {
  return deferredEditorChromeLoader.load()
}

function DeferredEditorChrome({
  chrome,
  contextMenuProps,
  failurePortalTarget,
  linkTooltipRef,
  showStatus,
  statusRef,
}: {
  chrome: AppSettings["chrome"]
  contextMenuProps: React.ComponentProps<
    (typeof import("@/app/EditorContextMenu"))["EditorContextMenu"]
  >
  failurePortalTarget: HTMLElement | null
  linkTooltipRef: React.Ref<EditorLinkTooltipHandle>
  showStatus: boolean
  statusRef: React.Ref<StatusOverlayHandle>
}) {
  const {
    error,
    retry,
    value: module,
  } = useDeferredValue(deferredEditorChromeLoader)
  const renderFailure = (retryAction: () => void) => {
    if (!failurePortalTarget) return null
    return createPortal(
      <DeferredFeatureFailure
        description="Context menus, link hints, and document status could not be loaded."
        title="Editor tools unavailable"
        onRetry={retryAction}
      />,
      failurePortalTarget
    )
  }
  if (!module) return error ? renderFailure(retry) : null

  const {
    EditorContextMenu: ContextMenuSurface,
    EditorLinkTooltip: LinkTooltipSurface,
    StatusOverlay: StatusSurface,
  } = module
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <ContextMenuSurface {...contextMenuProps} />
      <LinkTooltipSurface ref={linkTooltipRef} />
      {showStatus ? <StatusSurface ref={statusRef} chrome={chrome} /> : null}
    </DeferredSurfaceErrorBoundary>
  )
}

const formattingToolbarLoader = createRetryableDeferredLoader(() =>
  loadFormattingToolbarModule().then((module) => module.FormattingToolbar)
)

function loadFormattingToolbar() {
  return formattingToolbarLoader.load()
}

function FormattingToolbarFallback({
  error,
  position,
  visible,
  onRetry,
}: {
  error?: boolean
  position: AppSettings["chrome"]["formattingBarPosition"]
  visible: boolean
  onRetry?: () => void
}) {
  if (!visible) return null
  return (
    <div
      className="formatting-toolbar fixed top-[calc(var(--window-chrome-height)-var(--formatting-toolbar-overlap))] right-0 left-0 z-[41] h-[var(--formatting-toolbar-height)] overflow-hidden bg-transparent text-[var(--document-foreground)]"
      data-visible=""
    >
      <div className="formatting-toolbar-scroll relative z-[1] h-full overflow-hidden">
        <div
          aria-label="Formatting toolbar"
          className="flex h-full min-w-full items-center gap-2 px-3 data-[position=center]:justify-center data-[position=right]:justify-end"
          data-position={position}
          role={error ? "alert" : "status"}
        >
          <span className="rounded-lg bg-popover/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/60">
            {error
              ? "Formatting tools could not be loaded."
              : "Loading formatting tools…"}
          </span>
          {error && onRetry ? (
            <Button size="xs" type="button" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type FormattingToolbarProps = React.ComponentProps<
  (typeof import("@/app/FormattingToolbar"))["FormattingToolbar"]
>

function DeferredFormattingToolbar(props: FormattingToolbarProps) {
  const {
    error,
    retry,
    value: Toolbar,
  } = useDeferredValue(formattingToolbarLoader)
  const renderFallback = (failed: boolean, retryAction?: () => void) => (
    <FormattingToolbarFallback
      error={failed}
      position={props.position}
      visible={props.visible}
      onRetry={retryAction}
    />
  )
  if (!Toolbar) return renderFallback(Boolean(error), error ? retry : undefined)
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) =>
        renderFallback(true, retryRender)
      }
    >
      <Toolbar {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

const loadOutlinePopoverModule = createRetryableDynamicImport(
  () => import("@/app/OutlinePopover")
)
const outlinePopoverLoader = createRetryableDeferredLoader(() =>
  loadOutlinePopoverModule().then((module) => module.default)
)

function loadOutlinePopover() {
  return outlinePopoverLoader.load()
}

function OutlinePopover(
  props: React.ComponentProps<
    (typeof import("@/app/OutlinePopover"))["default"]
  >
) {
  const {
    error,
    retry,
    value: Popover,
  } = useDeferredValue(outlinePopoverLoader)
  const renderFailure = (retryAction: () => void) => (
    <DeferredPopoverFailure
      anchor={props.anchor}
      description="The document outline could not be loaded."
      open={props.open}
      title="Outline unavailable"
      trigger={props.trigger}
      onOpenChange={props.onOpenChange}
      onRetry={retryAction}
    />
  )
  if (!Popover) return error ? renderFailure(retry) : props.trigger
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <Popover {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

function createDeferredComponent<
  Props extends object,
  Module extends { default: React.ComponentType<Props> },
>(
  loader: () => Promise<Module>,
  renderFailure: (props: Props, retry: () => void) => React.ReactNode
) {
  const deferredLoader = createRetryableDeferredLoader(loader)
  const load = deferredLoader.load

  function Deferred(props: Props) {
    const { error, retry, value: module } = useDeferredValue(deferredLoader)
    if (!module) return error ? renderFailure(props, retry) : null
    const Surface = module.default
    return (
      <DeferredSurfaceErrorBoundary
        fallback={(_renderError, retryRender) =>
          renderFailure(props, retryRender)
        }
      >
        <Surface {...props} />
      </DeferredSurfaceErrorBoundary>
    )
  }
  return [Deferred, load] as const
}

type FileMissingNoticeComponent =
  (typeof import("@/app/FileMissingNotice"))["FileMissingNotice"]
const loadFileMissingNoticeModule = createRetryableDynamicImport(
  () => import("@/app/FileMissingNotice")
)
const [FileMissingNotice] = createDeferredComponent<
  React.ComponentProps<FileMissingNoticeComponent>,
  { default: FileMissingNoticeComponent }
>(
  () =>
    loadFileMissingNoticeModule().then((module) => ({
      default: module.FileMissingNotice,
    })),
  (_props, retry) => (
    <DeferredFeatureFailure
      description="File recovery controls could not be loaded."
      title="File recovery unavailable"
      onRetry={retry}
    />
  )
)

type PersistenceFailureNoticeComponent =
  (typeof import("@/app/PersistenceFailureNotice"))["PersistenceFailureNotice"]
const loadPersistenceFailureNoticeModule = createRetryableDynamicImport(
  () => import("@/app/PersistenceFailureNotice")
)
const [PersistenceFailureNotice] = createDeferredComponent<
  React.ComponentProps<PersistenceFailureNoticeComponent>,
  { default: PersistenceFailureNoticeComponent }
>(
  () =>
    loadPersistenceFailureNoticeModule().then((module) => ({
      default: module.PersistenceFailureNotice,
    })),
  (_props, retry) => (
    <DeferredFeatureFailure
      description="Persistence recovery controls could not be loaded."
      title="Persistence recovery unavailable"
      onRetry={retry}
    />
  )
)

type ScratchSaveFailureNoticeComponent =
  (typeof import("@/app/ScratchSaveFailureNotice"))["ScratchSaveFailureNotice"]
const loadScratchSaveFailureNoticeModule = createRetryableDynamicImport(
  () => import("@/app/ScratchSaveFailureNotice")
)
const [ScratchSaveFailureNotice] = createDeferredComponent<
  React.ComponentProps<ScratchSaveFailureNoticeComponent>,
  { default: ScratchSaveFailureNoticeComponent }
>(
  () =>
    loadScratchSaveFailureNoticeModule().then((module) => ({
      default: module.ScratchSaveFailureNotice,
    })),
  (_props, retry) => (
    <DeferredFeatureFailure
      description="Scratch recovery controls could not be loaded."
      title="Scratch recovery unavailable"
      onRetry={retry}
    />
  )
)

type DeferredSettingsDialogComponent =
  (typeof import("@/app/DeferredSettingsDialog"))["default"]
const loadDeferredSettingsDialogModule = createRetryableDynamicImport(
  () => import("@/app/DeferredSettingsDialog")
)
const [SettingsDialog, loadDeferredSettingsDialog] = createDeferredComponent<
  React.ComponentProps<DeferredSettingsDialogComponent>,
  typeof import("@/app/DeferredSettingsDialog")
>(loadDeferredSettingsDialogModule, (props, retry) => (
  <DeferredDialogFailure
    description="Settings could not be loaded."
    title="Settings"
    onCancel={props.onCancel}
    onRetry={retry}
  />
))

type DeferredSettingsWorkspaceComponent =
  (typeof import("@/app/DeferredSettingsWorkspace"))["default"]
const loadDeferredSettingsWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/DeferredSettingsWorkspace")
)
type DeferredSettingsWorkspaceProps =
  React.ComponentProps<DeferredSettingsWorkspaceComponent>

function cancelDeferredSettingsWorkspace({
  workspace,
}: DeferredSettingsWorkspaceProps) {
  switch (workspace.kind) {
    case "active-tab-indicator":
    case "launch-transition":
    case "typography":
      workspace.props.onCancel()
      break
    case "scratches":
    case "window-profiles":
      workspace.props.onBack()
      break
  }
}

const [DeferredSettingsWorkspace, loadDeferredSettingsWorkspace] =
  createDeferredComponent<
    DeferredSettingsWorkspaceProps,
    typeof import("@/app/DeferredSettingsWorkspace")
  >(loadDeferredSettingsWorkspaceModule, (props, retry) => (
    <DeferredDialogFailure
      description="The Settings workspace could not be loaded."
      title="Settings workspace unavailable"
      onCancel={() => cancelDeferredSettingsWorkspace(props)}
      onRetry={retry}
    />
  ))

function prepareDeferredSettingsDialog() {
  return loadDeferredSettingsDialog().then((module) => module.default.prepare())
}

function prepareTypographySettingsWorkspace() {
  return loadDeferredSettingsWorkspace().then((module) =>
    module.default.prepareTypography()
  )
}

type WindowProfilePickerComponent =
  (typeof import("@/app/WindowProfilePicker"))["default"]
const loadWindowProfilePickerModule = createRetryableDynamicImport(
  () => import("@/app/WindowProfilePicker")
)
const [WindowProfilePicker] = createDeferredComponent<
  React.ComponentProps<WindowProfilePickerComponent>,
  typeof import("@/app/WindowProfilePicker")
>(loadWindowProfilePickerModule, (props, retry) => (
  <DeferredDialogFailure
    description="The window profile picker could not be loaded."
    title="Launch Window Profile"
    onCancel={() => props.onOpenChange(false)}
    onRetry={retry}
  />
))

type WindowProfileCaptureDialogComponent =
  (typeof import("@/app/WindowProfileCaptureDialog"))["default"]
const loadWindowProfileCaptureDialogModule = createRetryableDynamicImport(
  () => import("@/app/WindowProfileCaptureDialog")
)
const [WindowProfileCaptureDialog] = createDeferredComponent<
  React.ComponentProps<WindowProfileCaptureDialogComponent>,
  typeof import("@/app/WindowProfileCaptureDialog")
>(loadWindowProfileCaptureDialogModule, (props, retry) => (
  <DeferredDialogFailure
    description="The window profile editor could not be loaded."
    title="Window Profile"
    onCancel={props.onClose}
    onRetry={retry}
  />
))

type ScratchBrowserSurfaceComponent =
  (typeof import("@/app/ScratchSurfaces"))["default"]
const loadScratchSurfacesModule = createRetryableDynamicImport(
  () => import("@/app/ScratchSurfaces")
)
type ScratchBrowserSurfaceProps =
  React.ComponentProps<ScratchBrowserSurfaceComponent>
const scratchBrowserSurfaceLoader = createRetryableDeferredLoader(
  loadScratchSurfacesModule
)

function ScratchBrowserSurface(props: ScratchBrowserSurfaceProps) {
  const {
    error,
    retry,
    value: module,
  } = useDeferredValue(scratchBrowserSurfaceLoader)
  const renderFailure = (retryAction: () => void) => (
    <DeferredDialogFailure
      description="The scratch browser could not be loaded."
      title="Open Scratch"
      onCancel={() => props.onOpenChange(false)}
      onRetry={retryAction}
    />
  )
  if (!module) {
    return error && props.open ? renderFailure(retry) : null
  }
  const Surface = module.default
  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => renderFailure(retryRender)}
    >
      <Surface {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

interface RendererTab {
  id: TabId
  backing: TabDescriptor["backing"]
  color: TabDescriptor["color"]
  document: DocumentMetadata
  dirty: boolean
  navigationDocumentId: string
  revision: number
  cleanDocument: Text
  editor: MarkdownEditorSession
}

interface PendingImport {
  tab: RendererTab
  timeout: number
}

interface PendingRendererTabHydration {
  interactive: boolean
  promise: Promise<RendererTab | null>
}

interface TypographyPreviewState {
  parentDraft: AppSettings
}

interface ActiveTabIndicatorPreviewState {
  parentDraft: AppSettings
}

interface LaunchTransitionPreviewState {
  parentDraft: AppSettings
}

interface WindowProfilesWorkspaceState {
  currentWindowTabModes: readonly WindowProfileTabMode[]
  parentDraft: AppSettings
}

interface ScratchesWorkspaceState {
  origin: "editor" | "scratch-browser" | "settings"
  parentDraft: AppSettings
  selectedScratchId?: string
}

interface WindowProfilePickerState {
  initialError?: string
  parent: "settings" | "surface"
  requestId: string | null
}

type SettingsNavigationRoute =
  | { kind: "settings" }
  | { kind: "keyboard-shortcuts" }
  | { kind: "window-profiles" }
  | { kind: "scratches" }
  | {
      kind: "window-profile-composer"
      composer: WindowProfileComposerState
    }

interface SettingsNavigationHistory {
  entries: SettingsNavigationRoute[]
  index: number
}

interface DocumentNavigationEntry {
  documentId: string
  filePath: string | null
  tabId: TabId
  location: MarkdownNavigationLocation
}

interface PendingLocalNavigation extends DocumentNavigationEntry {
  valid: boolean
}

function documentNavigationEntriesMatch(
  left: DocumentNavigationEntry,
  right: DocumentNavigationEntry
) {
  return (
    left.documentId === right.documentId &&
    left.filePath === right.filePath &&
    left.tabId === right.tabId &&
    left.location.caretVisible === right.location.caretVisible &&
    left.location.selection.anchor === right.location.selection.anchor &&
    left.location.selection.head === right.location.selection.head &&
    left.location.viewport.pos === right.location.viewport.pos &&
    left.location.viewport.screenOffset ===
      right.location.viewport.screenOffset &&
    left.location.viewport.scrollLeft === right.location.viewport.scrollLeft
  )
}

type SaveTrigger = "explicit" | "scratch-autosave" | "scratch-retry"

interface ScratchSaveCoordination {
  autosavePromise: Promise<boolean> | null
  generation: number
  handledGeneration: number
  inFlightCount: number
}

interface ScratchSaveTimer {
  generation: number
  timeout: number
}

interface ChromePersistenceFailure {
  change: Partial<AppSettings["chrome"]>
  message: string
}

interface LineWrappingPersistenceFailure {
  lineWrapping: boolean
  message: string
}

const SCRATCH_AUTOSAVE_DELAY_MS = 300
const SCRATCH_AUTOSAVE_FAILURE_NOTICE_THRESHOLD = 3
const SCRATCH_AUTOSAVE_MAX_DELAY_MS = 2_000
const SCRATCH_AUTOSAVE_RETRY_MAX_MS = 30_000
const DOCUMENT_NAVIGATION_HISTORY_LIMIT = 100
const SETTINGS_ROOT_ROUTE = { kind: "settings" } as const
const TAB_HYDRATION_IDLE_TIMEOUT_MS = 5_000

function scratchAutosaveDelay(documentLength: number) {
  const mebibytes = Math.floor(documentLength / (1024 * 1024))
  return Math.min(
    SCRATCH_AUTOSAVE_MAX_DELAY_MS,
    SCRATCH_AUTOSAVE_DELAY_MS + mebibytes * 200
  )
}

function isWindowProfilesSettingsRoute(route: SettingsNavigationRoute) {
  return (
    route.kind === "window-profiles" || route.kind === "window-profile-composer"
  )
}

function isScratchesSettingsRoute(route: SettingsNavigationRoute) {
  return route.kind === "scratches"
}

const EDITOR_FORMATTING_COMMANDS: Readonly<
  Partial<Record<EditorCommand, MarkdownFormattingCommand>>
> = {
  "format-bold": { type: "bold" },
  "format-italic": { type: "italic" },
  "format-strikethrough": { type: "strikethrough" },
  "format-inline-code": { type: "inline-code" },
  "format-link": { type: "link" },
  "format-image": { type: "image" },
  "format-heading-0": { type: "heading", level: 0 },
  "format-heading-1": { type: "heading", level: 1 },
  "format-heading-2": { type: "heading", level: 2 },
  "format-heading-3": { type: "heading", level: 3 },
  "format-heading-4": { type: "heading", level: 4 },
  "format-heading-5": { type: "heading", level: 5 },
  "format-heading-6": { type: "heading", level: 6 },
  "format-bullet-list": { type: "bullet-list" },
  "format-ordered-list": { type: "ordered-list" },
  "format-task-list": { type: "task-list" },
  "format-blockquote": { type: "blockquote" },
  "format-code-block": { type: "code-block" },
  "format-horizontal-rule": { type: "horizontal-rule" },
  "format-table": { type: "table", columns: 2, rows: 2 },
}

const selectableInputTypes = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
])

function selectAllInActiveTextControl(ownerDocument: Document) {
  const activeElement = ownerDocument.activeElement
  if (
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement &&
      selectableInputTypes.has(activeElement.type))
  ) {
    activeElement.select()
    return true
  }
  if (
    activeElement instanceof HTMLElement &&
    activeElement.isContentEditable &&
    !activeElement.closest(".cm-editor")
  ) {
    ownerDocument.execCommand("selectAll")
    return true
  }

  return false
}

function runEditCommandInActiveControl(
  ownerDocument: Document,
  command: "redo" | "undo"
) {
  const activeElement = ownerDocument.activeElement
  const editable =
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement &&
      selectableInputTypes.has(activeElement.type)) ||
    (activeElement instanceof HTMLElement &&
      activeElement.isContentEditable &&
      !activeElement.closest(".cm-editor"))
  if (!editable) return false
  window.pulseMd.editFocusedControl(command)
  return true
}

function selectAllInSurface(surface: HTMLElement) {
  const selection = surface.ownerDocument.getSelection()
  if (!selection) return
  const range = surface.ownerDocument.createRange()
  range.selectNodeContents(surface)
  selection.removeAllRanges()
  selection.addRange(range)
}

function documentMetadata(document: DocumentMetadata): DocumentMetadata {
  return {
    displayName: document.displayName,
    filePath: document.filePath,
    format: document.format,
    kind: document.kind,
    mtimeMs: document.mtimeMs,
  }
}

function applyInitialViewport(
  session: MarkdownEditorSession,
  viewport: EditorViewport | undefined
) {
  if (!viewport) return
  session.scrollSnapshot = undefined
  session.viewport = {
    ...viewport,
    pos: Math.min(viewport.pos, session.state.doc.length),
  }
  session.viewportInitialized = true
}

function rendererTabFromBootstrap(
  controller: MarkdownEditorController,
  bootstrap: BootstrapTab,
  initialEditorMode: AppSettings["initialEditorMode"],
  initialLineWrapping: boolean,
  navigationDocumentId: string = crypto.randomUUID()
): RendererTab {
  const editor = bootstrap.editorSession
    ? controller.deserializeSession(
        bootstrap.editorSession,
        bootstrap.document.filePath,
        bootstrap.document.kind
      )
    : controller.createSession(
        bootstrap.document.content,
        bootstrap.initialEditorMode ?? initialEditorMode,
        bootstrap.document.filePath,
        initialLineWrapping,
        bootstrap.document.kind
      )
  applyInitialViewport(editor, bootstrap.initialViewport)
  if (bootstrap.initialCursor) {
    controller.setSessionCursorPosition(
      editor,
      bootstrap.initialCursor.line,
      bootstrap.initialCursor.column
    )
  }
  const baselineContent =
    bootstrap.baselineContent ??
    bootstrap.editorSession?.baselineContent ??
    bootstrap.document.content
  return {
    id: bootstrap.tab.id,
    backing: bootstrap.tab.backing,
    color: bootstrap.tab.color,
    document: documentMetadata(bootstrap.document),
    dirty: bootstrap.tab.dirty,
    navigationDocumentId,
    revision: editor.revision,
    cleanDocument: bootstrap.tab.dirty
      ? Text.of(baselineContent.split("\n"))
      : editor.state.doc,
    editor,
  }
}

function settingsMatchExceptZoom(left: AppSettings, right: AppSettings) {
  const leftWithoutZoom = cloneAppSettings(left)
  const rightWithoutZoom = cloneAppSettings(right)
  leftWithoutZoom.zoomFactor = DEFAULT_APP_SETTINGS.zoomFactor
  rightWithoutZoom.zoomFactor = DEFAULT_APP_SETTINGS.zoomFactor
  return JSON.stringify(leftWithoutZoom) === JSON.stringify(rightWithoutZoom)
}

function settingsEqual(left: AppSettings, right: AppSettings) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function rebaseSettingsValue(
  base: unknown,
  draft: unknown,
  current: unknown
): unknown {
  if (JSON.stringify(base) === JSON.stringify(draft)) return current
  if (
    Array.isArray(base) ||
    Array.isArray(draft) ||
    Array.isArray(current) ||
    typeof base !== "object" ||
    base === null ||
    typeof draft !== "object" ||
    draft === null ||
    typeof current !== "object" ||
    current === null
  ) {
    return draft
  }

  const baseRecord = base as Record<string, unknown>
  const draftRecord = draft as Record<string, unknown>
  const currentRecord = current as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(draftRecord).map((key) => [
      key,
      rebaseSettingsValue(
        baseRecord[key],
        draftRecord[key],
        currentRecord[key]
      ),
    ])
  )
}

function rebaseSettingsDraft(
  base: AppSettings,
  draft: AppSettings,
  current: AppSettings
): AppSettings {
  return cloneAppSettings(
    rebaseSettingsValue(base, draft, current) as AppSettings
  )
}

function documentSurfaceBackground(
  backgroundColor: string,
  effect: AppSettings["backgroundEffect"],
  supported: boolean
) {
  if (!supported || !effect.enabled || effect.translucency <= 0) {
    return backgroundColor
  }
  const opacity = 1 - effect.translucency
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")
  return `${backgroundColor}${alpha}`
}

function documentWindowBackground(
  backgroundColor: string,
  effect: AppSettings["backgroundEffect"],
  backgroundCapability: string | undefined
) {
  const supported =
    backgroundCapability === "darwin" ||
    backgroundCapability === "win32" ||
    backgroundCapability === "linux"
  if (!supported || !effect.enabled || effect.translucency <= 0) {
    return backgroundColor
  }
  // macOS and Windows own their tint in the native backdrop. Linux exposes a
  // genuinely alpha renderer surface so Hyprland can blur behind it.
  return backgroundCapability === "linux"
    ? documentSurfaceBackground(backgroundColor, effect, true)
    : `${backgroundColor}00`
}

let colorResolutionCanvas: HTMLCanvasElement | null = null

function activeTabSurfaceColor(background: string, foreground: string) {
  colorResolutionCanvas ??= document.createElement("canvas")
  colorResolutionCanvas.width = 1
  colorResolutionCanvas.height = 1
  const context = colorResolutionCanvas.getContext("2d", {
    willReadFrequently: true,
  })
  if (!context) return background
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = background
  context.fillStyle = `color-mix(in oklab, ${background} 84%, ${foreground})`
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue]
    .map((channel) => channel!.toString(16).padStart(2, "0"))
    .join("")}`
}

function applyEditorTypography(settings: AppSettings) {
  const root = document.documentElement
  root.style.setProperty(
    "--font-sans",
    fontFamilyCssStack(settings.regularFontFamily, "regular")
  )
  root.style.setProperty(
    "--font-mono",
    fontFamilyCssStack(settings.monospaceFontFamily, "monospace")
  )
  root.style.setProperty("--editor-font-size", `${settings.baseFontSize}px`)
  root.style.setProperty(
    "--editor-code-font-size",
    `${settings.codeFontSize}px`
  )
  settings.headingFontScales.forEach((fontScale, index) => {
    root.style.setProperty(
      `--editor-heading-${index + 1}-font-scale`,
      String(fontScale)
    )
    root.style.setProperty(
      `--editor-heading-${index + 1}-font-weight`,
      settings.headingFontBold[index] ? "700" : "400"
    )
  })
  root.style.setProperty(
    "--editor-callout-title-font-size",
    `${settings.calloutTitleFontSize}px`
  )
  root.style.setProperty(
    "--editor-font-ligatures",
    settings.fontLigatures ? "normal" : "none"
  )
}

function editorTypographyGeometryChanged(
  previous: AppSettings,
  next: AppSettings
) {
  return (
    previous.regularFontFamily !== next.regularFontFamily ||
    previous.monospaceFontFamily !== next.monospaceFontFamily ||
    previous.baseFontSize !== next.baseFontSize ||
    previous.codeFontSize !== next.codeFontSize ||
    previous.calloutTitleFontSize !== next.calloutTitleFontSize ||
    previous.fontLigatures !== next.fontLigatures ||
    previous.headingFontScales.some(
      (fontScale, index) => fontScale !== next.headingFontScales[index]
    ) ||
    previous.headingFontBold.some(
      (bold, index) => bold !== next.headingFontBold[index]
    )
  )
}

function setBooleanDataAttribute(
  element: HTMLElement,
  name: string,
  enabled: boolean
) {
  if (enabled) element.dataset[name] = "true"
  else delete element.dataset[name]
}

function withTypographySettings(base: AppSettings, typography: AppSettings) {
  const next = cloneAppSettings(base)
  next.regularFontFamily = typography.regularFontFamily
  next.monospaceFontFamily = typography.monospaceFontFamily
  next.baseFontSize = typography.baseFontSize
  next.codeFontSize = typography.codeFontSize
  next.headingFontScales = [...typography.headingFontScales]
  next.headingFontBold = [...typography.headingFontBold]
  next.calloutTitleFontSize = typography.calloutTitleFontSize
  next.fontLigatures = typography.fontLigatures
  return next
}

function withActiveTabIndicatorSettings(
  base: AppSettings,
  indicator: AppSettings
) {
  const next = cloneAppSettings(base)
  next.chrome.activeTabIndicator = {
    ...indicator.chrome.activeTabIndicator,
    positions: [...indicator.chrome.activeTabIndicator.positions],
  }
  return next
}

function withLaunchTransitionSettings(
  base: AppSettings,
  transition: AppSettings
) {
  const next = cloneAppSettings(base)
  next.launchTransition = { ...transition.launchTransition }
  return next
}

export function App() {
  const { applySurfaceTheme, resolvedTheme, setTheme } = useTheme()
  const appShellRef = React.useRef<HTMLElement>(null)
  const [recoveryNoticeStackElement, setRecoveryNoticeStackElement] =
    React.useState<HTMLDivElement | null>(null)
  const editorHostRef = React.useRef<HTMLDivElement>(null)
  const launchTintCoverRef = React.useRef<HTMLDivElement>(null)
  const outlineAnchorRef = React.useRef<HTMLDivElement>(null)
  const topChromeTabScrollerRef = React.useRef<HTMLDivElement>(null)
  const controllerRef = React.useRef<MarkdownEditorController | null>(null)
  const [editorContextMenuHandoff] = React.useState(
    createEditorContextMenuHandoff
  )
  const statusRef = React.useRef<StatusOverlayHandle>(null)
  const linkTooltipRef = React.useRef<EditorLinkTooltipHandle>(null)
  const searchOverlayRef = React.useRef<SearchOverlayHandle>(null)
  const tabsRef = React.useRef(new Map<TabId, RendererTab>())
  const tabHydrationsRef = React.useRef(
    new Map<TabId, PendingRendererTabHydration>()
  )
  const tabActivationRevisionRef = React.useRef(0)
  const focusOwnershipRevisionRef = React.useRef(0)
  const activeTabIdRef = React.useRef<TabId | null>(null)
  const tabDescriptorsRef = React.useRef<TabDescriptor[]>([])
  const pendingImportsRef = React.useRef(new Map<TabId, PendingImport>())
  const localDragTokensRef = React.useRef(new Map<string, TabId>())
  const retiredTabDragsRef = React.useRef(new Map<string, TabId>())
  const tabTransferCommitLeasesRef = React.useRef(new Map<string, TabId>())
  const documentOpenLeaseCountRef = React.useRef(0)
  const closingTabsRef = React.useRef(new Set<TabId>())
  const scratchSaveTimersRef = React.useRef(new Map<TabId, ScratchSaveTimer>())
  const scratchSaveCoordinationsRef = React.useRef(
    new Map<TabId, ScratchSaveCoordination>()
  )
  const scratchSaveFailureCountsRef = React.useRef(new Map<TabId, number>())
  const saveTabRef = React.useRef<
    (tabId: TabId, saveAs?: boolean, trigger?: SaveTrigger) => Promise<boolean>
  >(async () => false)
  const settingsRef = React.useRef<AppSettings>(
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const settingsDialogDraftRef = React.useRef<AppSettings>(
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const settingsDialogBaseRef = React.useRef<AppSettings>(
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const persistedSettingsRef = React.useRef<AppSettings>(
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const appliedSettingsRef = React.useRef<AppSettings>(
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const resolvedThemeRef = React.useRef(resolvedTheme)
  const platformRef = React.useRef<AppPlatform | null>(null)
  const windowActiveRef = React.useRef(true)
  const initialEditorFocusPendingRef = React.useRef(true)
  const initialEditorFocusFrameRef = React.useRef<number | null>(null)
  const editorReadyFrameRef = React.useRef<number | null>(null)
  const editorMenuReportFrameRef = React.useRef<number | null>(null)
  const lastReportedEditorMenuStateRef = React.useRef<EditorMenuState | null>(
    null
  )
  const launchTransitionCleanupTimerRef = React.useRef<number | null>(null)
  const firstDocumentChangePendingRef = React.useRef(true)
  const settingsMeasureFrameRef = React.useRef<number | null>(null)
  const settingsContentRefreshPendingRef = React.useRef(false)
  const rendererReadyRef = React.useRef(false)
  const settingsHydratedRef = React.useRef(false)
  const settingsOpeningRef = React.useRef(false)
  const settingsReturnFocusRef = React.useRef(false)
  const settingsOpenRef = React.useRef(false)
  const softwareLicensesOpenRef = React.useRef(false)
  const outlineOpenRef = React.useRef(false)
  const settingsWorkspaceOpenRef = React.useRef(false)
  const scratchBrowserOpenRef = React.useRef(false)
  const scratchesWorkspaceOpenRef = React.useRef(false)
  const scratchesNavigationBlockedRef = React.useRef(false)
  const windowProfilesWorkspaceOpenRef = React.useRef(false)
  const windowProfilesNavigationBlockedRef = React.useRef(false)
  const windowProfileLaunchPendingRef = React.useRef(false)
  const windowProfilePickerOpenRef = React.useRef(false)
  const windowProfilePickerRequestIdRef = React.useRef<string | null>(null)
  const windowProfilePickerSettingsDraftRef = React.useRef<AppSettings | null>(
    null
  )
  const windowProfileCaptureOpenRef = React.useRef(false)
  const windowProfileCapturePendingRef = React.useRef(false)
  const settingsNavigationRouteRef =
    React.useRef<SettingsNavigationRoute>(SETTINGS_ROOT_ROUTE)
  const settingsNavigationHistoryRef = React.useRef<SettingsNavigationHistory>({
    entries: [SETTINGS_ROOT_ROUTE],
    index: 0,
  })
  const chromeCommandQueueRef = React.useRef<Promise<void>>(Promise.resolve())
  const settingsZoomHandlerRef = React.useRef<
    ((zoomFactor: number) => void) | null
  >(null)
  const settingsSaveHandlerRef = React.useRef<(() => Promise<boolean>) | null>(
    null
  )
  const settingsWorkspaceSavePendingRef = React.useRef(false)
  const windowZoomFactorRef = React.useRef<number | null>(null)
  const searchStatusRef =
    React.useRef<MarkdownSearchStatus>(EMPTY_SEARCH_STATUS)
  const [searchHandoffQueue] = React.useState<SearchHandoffQueue>(() => ({
    actions: [],
  }))
  const searchVisibilityRevisionRef = React.useRef(0)
  const navigationBackRef = React.useRef<DocumentNavigationEntry[]>([])
  const navigationForwardRef = React.useRef<DocumentNavigationEntry[]>([])
  const pendingLocalNavigationRef = React.useRef<PendingLocalNavigation | null>(
    null
  )
  const localNavigationQueueRef = React.useRef<Promise<void>>(Promise.resolve())

  const [appSettings, setAppSettings] = React.useState<AppSettings>(() =>
    cloneAppSettings(DEFAULT_APP_SETTINGS)
  )
  const [settingsDialogSettings, setSettingsDialogSettings] =
    React.useState<AppSettings>(() => cloneAppSettings(DEFAULT_APP_SETTINGS))
  const [platform, setPlatform] = React.useState<AppPlatform | null>(null)
  const [tabDescriptors, setTabDescriptors] = React.useState<TabDescriptor[]>(
    []
  )
  const [activeTabId, setActiveTabId] = React.useState<TabId | null>(null)
  const [hydratingTabIds, setHydratingTabIds] = React.useState<
    ReadonlySet<TabId>
  >(() => new Set())
  const [searchFocusRequest, setSearchFocusRequest] = React.useState(0)
  const [searchActivated, setSearchActivated] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [activeEditorMode, setActiveEditorMode] =
    React.useState<MarkdownEditorMode>("live")
  const [outlineOpen, setOutlineOpen] = React.useState(false)
  const [outlineHeadings, setOutlineHeadings] = React.useState<
    readonly MarkdownHeading[]
  >([])
  const [outlineActiveSlug, setOutlineActiveSlug] = React.useState<
    string | null
  >(null)
  const [deferredEditorChromeActivated, setDeferredEditorChromeActivated] =
    React.useState(false)
  const [formattingToolbarActivated, setFormattingToolbarActivated] =
    React.useState(false)
  const [chromePersistenceFailure, setChromePersistenceFailure] =
    React.useState<ChromePersistenceFailure | null>(null)
  const [lineWrappingPersistenceFailure, setLineWrappingPersistenceFailure] =
    React.useState<LineWrappingPersistenceFailure | null>(null)
  const [zoomPersistenceFailure, setZoomPersistenceFailure] = React.useState<
    number | null
  >(null)
  const [scratchSaveFailureTabIds, setScratchSaveFailureTabIds] =
    React.useState<ReadonlySet<TabId>>(() => new Set())
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsSession, setSettingsSession] = React.useState(0)
  const [settingsNavigationRoute, setSettingsNavigationRoute] =
    React.useState<SettingsNavigationRoute>(SETTINGS_ROOT_ROUTE)
  const [typographyPreview, setTypographyPreview] =
    React.useState<TypographyPreviewState | null>(null)
  const [activeTabIndicatorPreview, setActiveTabIndicatorPreview] =
    React.useState<ActiveTabIndicatorPreviewState | null>(null)
  const [launchTransitionPreview, setLaunchTransitionPreview] =
    React.useState<LaunchTransitionPreviewState | null>(null)
  const [windowProfilesWorkspace, setWindowProfilesWorkspace] =
    React.useState<WindowProfilesWorkspaceState | null>(null)
  const [scratchesWorkspace, setScratchesWorkspace] =
    React.useState<ScratchesWorkspaceState | null>(null)
  const [scratchBrowserOpen, setScratchBrowserOpen] = React.useState(false)
  const [windowProfilePicker, setWindowProfilePicker] =
    React.useState<WindowProfilePickerState | null>(null)
  const [windowProfileCaptureKind, setWindowProfileCaptureKind] =
    React.useState<WindowProfileCaptureKind | null>(null)
  const [windowProfileCaptureTabModes, setWindowProfileCaptureTabModes] =
    React.useState<readonly WindowProfileTabMode[]>([])
  const [tabDragActive, setTabDragActive] = React.useState(false)
  const [tabDragSink, setTabDragSink] = React.useState(false)
  const [topChromeHoverLatched, setTopChromeHoverLatched] =
    React.useState(false)
  const [tabDragShelfHoverContext, setTabDragShelfHoverContext] =
    React.useState<object | null>(null)
  const [topDrawerCompensated, setTopDrawerCompensated] = React.useState(false)
  const [windowsControlDrawerNarrow, setWindowsControlDrawerNarrow] =
    React.useState(() => window.matchMedia("(max-width: 520px)").matches)
  const [topDrawerPresence, setTopDrawerPresence] = React.useState<{
    tabId: TabId | null
    visible: boolean
  }>({ tabId: null, visible: false })
  const topDrawerCompensationContextRef = React.useRef({
    active: false,
    tabId: null as TabId | null,
  })
  const [windowZoomFactor, setWindowZoomFactor] = React.useState(1)
  const [windowMaximized, setWindowMaximized] = React.useState(false)
  const [navigationAvailability, setNavigationAvailability] = React.useState({
    back: false,
    forward: false,
  })

  const getController = React.useCallback(() => controllerRef.current, [])
  const captureTabFocusIntent = React.useCallback(
    (policy: TabFocusPolicy): TabFocusIntent => ({
      owner: document.activeElement,
      policy,
      revision: focusOwnershipRevisionRef.current,
    }),
    []
  )

  React.useEffect(() => {
    const transferFocusOwnership = () => {
      focusOwnershipRevisionRef.current += 1
    }
    document.addEventListener("focusin", transferFocusOwnership, true)
    document.addEventListener("focusout", transferFocusOwnership, true)
    document.addEventListener("keydown", transferFocusOwnership, true)
    document.addEventListener("pointerdown", transferFocusOwnership, true)
    return () => {
      document.removeEventListener("focusin", transferFocusOwnership, true)
      document.removeEventListener("focusout", transferFocusOwnership, true)
      document.removeEventListener("keydown", transferFocusOwnership, true)
      document.removeEventListener("pointerdown", transferFocusOwnership, true)
    }
  }, [])

  const commitSettingsNavigationHistory = React.useCallback(
    (history: SettingsNavigationHistory) => {
      const route = history.entries[history.index]
      if (!route) return false
      settingsNavigationHistoryRef.current = history
      settingsNavigationRouteRef.current = route
      setSettingsNavigationRoute(route)
      return true
    },
    []
  )

  const resetSettingsNavigationHistory = React.useCallback(() => {
    windowProfilesNavigationBlockedRef.current = false
    scratchesNavigationBlockedRef.current = false
    commitSettingsNavigationHistory({
      entries: [SETTINGS_ROOT_ROUTE],
      index: 0,
    })
  }, [commitSettingsNavigationHistory])

  const pushSettingsNavigationRoute = React.useCallback(
    (route: SettingsNavigationRoute) => {
      const history = settingsNavigationHistoryRef.current
      commitSettingsNavigationHistory({
        entries: [...history.entries.slice(0, history.index + 1), route],
        index: history.index + 1,
      })
    },
    [commitSettingsNavigationHistory]
  )

  const openKeyboardShortcuts = React.useCallback(() => {
    if (
      !settingsOpenRef.current ||
      settingsNavigationRouteRef.current.kind === "keyboard-shortcuts"
    ) {
      return
    }
    pushSettingsNavigationRoute({ kind: "keyboard-shortcuts" })
  }, [pushSettingsNavigationRoute])

  const openWindowProfileComposer = React.useCallback(
    (composer: WindowProfileComposerState) => {
      if (
        !windowProfilesWorkspaceOpenRef.current ||
        settingsNavigationRouteRef.current.kind === "window-profile-composer"
      ) {
        return
      }
      pushSettingsNavigationRoute({
        kind: "window-profile-composer",
        composer,
      })
    },
    [pushSettingsNavigationRoute]
  )

  const recordWindowProfileComposer = React.useCallback(
    (composer: WindowProfileComposerState) => {
      const history = settingsNavigationHistoryRef.current
      const current = history.entries[history.index]
      if (current?.kind !== "window-profile-composer") return
      const route: SettingsNavigationRoute = { ...current, composer }
      const entries = history.entries.slice()
      entries[history.index] = route
      settingsNavigationHistoryRef.current = { ...history, entries }
      settingsNavigationRouteRef.current = route
      // Keep high-frequency profile form edits local to the workspace. The
      // latest immutable snapshot lives in the history ref and is published to
      // React state only when navigation actually changes the active route.
    },
    []
  )

  const finishWindowProfileComposer = React.useCallback(() => {
    const history = settingsNavigationHistoryRef.current
    const previous = history.entries[history.index - 1]
    if (previous?.kind === "window-profiles") {
      commitSettingsNavigationHistory({
        entries: history.entries.slice(0, history.index),
        index: history.index - 1,
      })
      return
    }
    const entries = history.entries.slice(0, history.index + 1)
    entries[history.index] = { kind: "window-profiles" }
    commitSettingsNavigationHistory({ entries, index: history.index })
  }, [commitSettingsNavigationHistory])

  const handleWindowProfilesNavigationBlockedChange = React.useCallback(
    (blocked: boolean) => {
      windowProfilesNavigationBlockedRef.current = blocked
    },
    []
  )

  const shouldCompensateTopDrawer = React.useCallback(
    () =>
      (controllerRef.current?.view.scrollDOM.scrollTop ?? Infinity) <=
      TOP_DRAWER_TOP_EDGE_THRESHOLD,
    []
  )
  const subscribeTopDrawerPosition = React.useCallback(
    (onStoreChange: () => void) => {
      void activeTabId
      const scrollDOM = controllerRef.current?.view.scrollDOM
      if (!scrollDOM) return () => undefined
      scrollDOM.addEventListener("scroll", onStoreChange, { passive: true })
      return () => scrollDOM.removeEventListener("scroll", onStoreChange)
    },
    [activeTabId]
  )
  const topDrawerAtTopEdge = React.useSyncExternalStore(
    subscribeTopDrawerPosition,
    shouldCompensateTopDrawer,
    () => false
  )

  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 520px)")
    const update = () => setWindowsControlDrawerNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  React.useEffect(() => {
    if (!platform || !activeTabId) return
    const frame = requestAnimationFrame(() => {
      document.documentElement.dataset.formattingAnimations = "true"
    })
    return () => cancelAnimationFrame(frame)
  }, [activeTabId, platform])

  React.useEffect(
    () => () => {
      delete document.documentElement.dataset.formattingAnimations
    },
    []
  )

  const handleSettingsZoomHandlerChange = React.useCallback(
    (handler: ((zoomFactor: number) => void) | null) => {
      registerDeferredValueHandler(
        settingsZoomHandlerRef,
        handler,
        settingsOpenRef.current,
        windowZoomFactorRef.current
      )
    },
    []
  )

  const handleSettingsSaveHandlerChange = React.useCallback(
    (handler: (() => Promise<boolean>) | null) => {
      settingsSaveHandlerRef.current = handler
    },
    []
  )

  const updateSettingsWorkspaceZoom = React.useCallback(
    (zoomFactor: number) => {
      const updateParentDraft = <T extends { parentDraft: AppSettings }>(
        workspace: T | null
      ): T | null => {
        if (
          !workspace ||
          Object.is(workspace.parentDraft.zoomFactor, zoomFactor)
        ) {
          return workspace
        }
        const parentDraft = cloneAppSettings(workspace.parentDraft)
        parentDraft.zoomFactor = zoomFactor
        return { ...workspace, parentDraft }
      }

      setActiveTabIndicatorPreview(updateParentDraft)
      setTypographyPreview(updateParentDraft)
      setLaunchTransitionPreview(updateParentDraft)
      setWindowProfilesWorkspace(updateParentDraft)
      setScratchesWorkspace(updateParentDraft)
    },
    []
  )

  const handleWindowZoomChanged = React.useCallback(
    (zoomFactor: number) => {
      windowZoomFactorRef.current = zoomFactor
      setWindowZoomFactor(zoomFactor)
      if (settingsOpenRef.current || settingsWorkspaceOpenRef.current) {
        const settingsDraft = cloneAppSettings(settingsDialogDraftRef.current)
        settingsDraft.zoomFactor = zoomFactor
        settingsDialogDraftRef.current = settingsDraft
      }
      if (settingsOpenRef.current) {
        settingsZoomHandlerRef.current?.(zoomFactor)
      } else if (settingsWorkspaceOpenRef.current) {
        updateSettingsWorkspaceZoom(zoomFactor)
      }
    },
    [updateSettingsWorkspaceZoom]
  )

  const setScratchSaveFailed = React.useCallback(
    (tabId: TabId, failed: boolean) => {
      setScratchSaveFailureTabIds((current) => {
        if (current.has(tabId) === failed) return current
        const next = new Set(current)
        if (failed) next.add(tabId)
        else next.delete(tabId)
        return next
      })
    },
    []
  )

  const setDescriptors = React.useCallback((tabs: TabDescriptor[]) => {
    const retiredTabIds = new Set(retiredTabDragsRef.current.values())
    const next = tabs
      .filter((tab) => !retiredTabIds.has(tab.id))
      .map((tab) => ({ ...tab }))
    tabDescriptorsRef.current = next
    setTabDescriptors(next)
    const nextIds = new Set(next.map(({ id }) => id))
    setScratchSaveFailureTabIds((current) => {
      const retained = new Set(
        [...current].filter((tabId) => nextIds.has(tabId))
      )
      return retained.size === current.size ? current : retained
    })
    setHydratingTabIds((current) => {
      const retained = new Set(
        [...current].filter((tabId) => nextIds.has(tabId))
      )
      return retained.size === current.size ? current : retained
    })
  }, [])

  const setTabHydrating = React.useCallback(
    (tabId: TabId, hydrating: boolean) => {
      setHydratingTabIds((current) => {
        if (current.has(tabId) === hydrating) return current
        const next = new Set(current)
        if (hydrating) next.add(tabId)
        else next.delete(tabId)
        return next
      })
    },
    []
  )

  const updateDescriptor = React.useCallback(
    (tabId: TabId, change: Partial<TabDescriptor>) => {
      const next = tabDescriptorsRef.current.map((tab) =>
        tab.id === tabId ? { ...tab, ...change } : tab
      )
      setDescriptors(next)
    },
    [setDescriptors]
  )

  const currentDocumentKind = React.useCallback((): DocumentKind => {
    const activeId = activeTabIdRef.current
    if (!activeId) return "markdown"
    return (
      tabsRef.current.get(activeId)?.document.kind ??
      tabDescriptorsRef.current.find(({ id }) => id === activeId)?.kind ??
      "markdown"
    )
  }, [])

  const prepareFormattingToolbarForDocument = React.useCallback(
    (documentKind: DocumentKind) => {
      if (
        documentKind !== "markdown" ||
        !settingsRef.current.chrome.showFormattingBar
      ) {
        return
      }
      setFormattingToolbarActivated(true)
      void loadFormattingToolbar().catch(() => undefined)
    },
    []
  )

  const clearScratchSaveTimer = React.useCallback((tabId: TabId) => {
    const timer = scratchSaveTimersRef.current.get(tabId)
    if (timer) window.clearTimeout(timer.timeout)
    scratchSaveTimersRef.current.delete(tabId)
    const coordination = scratchSaveCoordinationsRef.current.get(tabId)
    if (coordination) {
      coordination.handledGeneration = coordination.generation
    }
  }, [])

  const scheduleScratchSave = React.useCallback(
    (tabId: TabId, delay = SCRATCH_AUTOSAVE_DELAY_MS) => {
      clearScratchSaveTimer(tabId)
      const coordination =
        scratchSaveCoordinationsRef.current.get(tabId) ??
        ({
          autosavePromise: null,
          generation: 0,
          handledGeneration: 0,
          inFlightCount: 0,
        } satisfies ScratchSaveCoordination)
      scratchSaveCoordinationsRef.current.set(tabId, coordination)
      const generation = coordination.generation + 1
      coordination.generation = generation
      const timer: ScratchSaveTimer = {
        generation,
        timeout: window.setTimeout(() => {
          if (
            scratchSaveTimersRef.current.get(tabId)?.generation !== generation
          ) {
            return
          }
          scratchSaveTimersRef.current.delete(tabId)
          const tab = tabsRef.current.get(tabId)
          if (!tab || tab.backing !== "scratch" || !tab.dirty) {
            coordination.handledGeneration = Math.max(
              coordination.handledGeneration,
              generation
            )
            return
          }
          void saveTabRef
            .current(tabId, false, "scratch-autosave")
            .catch((error) =>
              console.error("Failed to autosave scratch tab", error)
            )
        }, delay),
      }
      scratchSaveTimersRef.current.set(tabId, timer)
    },
    [clearScratchSaveTimer]
  )

  const reportEditorMenuState = React.useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    const activeId = activeTabIdRef.current
    const tab = activeId ? tabsRef.current.get(activeId) : undefined
    const nextEditorFocused = controller.view.hasFocus
    const queryCommandEnabled = (command: "redo" | "undo") => {
      try {
        return document.queryCommandEnabled(command)
      } catch {
        return false
      }
    }
    const softwareLicensesOpen = softwareLicensesOpenRef.current
    const next: EditorMenuState = {
      canRedo: nextEditorFocused
        ? controller.canRedo()
        : queryCommandEnabled("redo"),
      canUndo: nextEditorFocused
        ? controller.canUndo()
        : queryCommandEnabled("undo"),
      documentKind: tab?.document.kind ?? "markdown",
      editorFocused: nextEditorFocused,
      hasSelection: controller.hasSelection(),
      mode: controller.getMode(),
      settingsDialogOpen:
        settingsOpenRef.current ||
        softwareLicensesOpen ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current ||
        scratchBrowserOpenRef.current,
      settingsWorkspaceOpen: settingsWorkspaceOpenRef.current,
      softwareLicensesOpen,
    }
    const previous = lastReportedEditorMenuStateRef.current
    if (
      previous &&
      previous.canRedo === next.canRedo &&
      previous.canUndo === next.canUndo &&
      previous.documentKind === next.documentKind &&
      previous.editorFocused === next.editorFocused &&
      previous.hasSelection === next.hasSelection &&
      previous.mode === next.mode &&
      previous.settingsDialogOpen === next.settingsDialogOpen &&
      previous.settingsWorkspaceOpen === next.settingsWorkspaceOpen &&
      previous.softwareLicensesOpen === next.softwareLicensesOpen
    ) {
      return
    }
    lastReportedEditorMenuStateRef.current = next
    window.pulseMd.reportEditorMenuState(next)
  }, [])

  const setSoftwareLicensesOpen = React.useCallback(
    (open: boolean) => {
      if (softwareLicensesOpenRef.current === open) return
      softwareLicensesOpenRef.current = open
      reportEditorMenuState()
    },
    [reportEditorMenuState]
  )

  const updateStatus = React.useCallback(
    (status?: EditorStatus) => {
      const controller = controllerRef.current
      const activeId = activeTabIdRef.current
      const tab = activeId ? tabsRef.current.get(activeId) : undefined
      if (!controller || !tab) return
      const mode = controller.getMode()
      setActiveEditorMode((currentMode) =>
        currentMode === mode ? currentMode : mode
      )
      statusRef.current?.update(
        status ?? controller.getStatus(),
        tab.document.format,
        mode,
        tab.document.kind
      )
      reportEditorMenuState()
    },
    [reportEditorMenuState]
  )

  const setStatusOverlayHandle = React.useCallback(
    (handle: StatusOverlayHandle | null) => {
      statusRef.current = handle
      if (!handle) return
      queueMicrotask(() => {
        if (statusRef.current === handle) updateStatus()
      })
    },
    [updateStatus]
  )

  React.useEffect(() => {
    const scheduleReport = () => {
      if (editorMenuReportFrameRef.current !== null) return
      editorMenuReportFrameRef.current = window.requestAnimationFrame(() => {
        editorMenuReportFrameRef.current = null
        reportEditorMenuState()
      })
    }
    document.addEventListener("focusin", scheduleReport, true)
    document.addEventListener("focusout", scheduleReport, true)
    document.addEventListener("input", scheduleReport, true)
    return () => {
      document.removeEventListener("focusin", scheduleReport, true)
      document.removeEventListener("focusout", scheduleReport, true)
      document.removeEventListener("input", scheduleReport, true)
      if (editorMenuReportFrameRef.current !== null) {
        window.cancelAnimationFrame(editorMenuReportFrameRef.current)
        editorMenuReportFrameRef.current = null
      }
    }
  }, [reportEditorMenuState])

  React.useEffect(() => {
    reportEditorMenuState()
  }, [
    activeTabIndicatorPreview,
    launchTransitionPreview,
    reportEditorMenuState,
    settingsOpen,
    typographyPreview,
    windowProfileCaptureKind,
    windowProfilePicker,
    windowProfilesWorkspace,
  ])

  const publishNavigationAvailability = React.useCallback(() => {
    const next = {
      back: navigationBackRef.current.length > 0,
      forward: navigationForwardRef.current.length > 0,
    }
    setNavigationAvailability((current) =>
      current.back === next.back && current.forward === next.forward
        ? current
        : next
    )
  }, [])

  const rememberNavigationEntry = React.useCallback(
    (entry: DocumentNavigationEntry) => {
      const previous = navigationBackRef.current.at(-1)
      if (!previous || !documentNavigationEntriesMatch(previous, entry)) {
        navigationBackRef.current.push(entry)
      }
      if (
        navigationBackRef.current.length > DOCUMENT_NAVIGATION_HISTORY_LIMIT
      ) {
        navigationBackRef.current.splice(
          0,
          navigationBackRef.current.length - DOCUMENT_NAVIGATION_HISTORY_LIMIT
        )
      }
      navigationForwardRef.current = []
      publishNavigationAvailability()
    },
    [publishNavigationAvailability]
  )

  const rememberActiveNavigationOrigin = React.useCallback(
    (location: MarkdownNavigationLocation) => {
      const tabId = activeTabIdRef.current
      const tab = tabId ? tabsRef.current.get(tabId) : undefined
      if (!tab) return
      rememberNavigationEntry({
        documentId: tab.navigationDocumentId,
        filePath: tab.document.filePath,
        tabId: tab.id,
        location,
      })
    },
    [rememberNavigationEntry]
  )

  const pruneNavigationHistory = React.useCallback(
    (tabIds: ReadonlySet<TabId>) => {
      const pending = pendingLocalNavigationRef.current
      if (pending && !tabIds.has(pending.tabId)) pending.valid = false
      const filter = (entries: DocumentNavigationEntry[]) =>
        entries.filter((entry) => tabIds.has(entry.tabId))
      const back = filter(navigationBackRef.current)
      const forward = filter(navigationForwardRef.current)
      if (
        back.length === navigationBackRef.current.length &&
        forward.length === navigationForwardRef.current.length
      ) {
        return
      }
      navigationBackRef.current = back
      navigationForwardRef.current = forward
      publishNavigationAvailability()
    },
    [publishNavigationAvailability]
  )

  const invalidateNavigationHistoryForTab = React.useCallback(
    (tabId: TabId, documentId?: string) => {
      const pending = pendingLocalNavigationRef.current
      if (
        pending?.tabId === tabId &&
        (documentId === undefined || pending.documentId === documentId)
      ) {
        pending.valid = false
      }
      const retained = (entry: DocumentNavigationEntry) =>
        entry.tabId !== tabId ||
        (documentId !== undefined && entry.documentId !== documentId)
      const back = navigationBackRef.current.filter(retained)
      const forward = navigationForwardRef.current.filter(retained)
      if (
        back.length === navigationBackRef.current.length &&
        forward.length === navigationForwardRef.current.length
      ) {
        return
      }
      navigationBackRef.current = back
      navigationForwardRef.current = forward
      publishNavigationAvailability()
    },
    [publishNavigationAvailability]
  )

  const mapNavigationHistoryForTab = React.useCallback(
    (
      tabId: TabId,
      documentId: string,
      mapLocation: MarkdownNavigationLocationMapper
    ) => {
      const mapEntries = (entries: DocumentNavigationEntry[]) =>
        entries.map((entry) =>
          entry.tabId === tabId && entry.documentId === documentId
            ? { ...entry, location: mapLocation(entry.location) }
            : entry
        )
      navigationBackRef.current = mapEntries(navigationBackRef.current)
      navigationForwardRef.current = mapEntries(navigationForwardRef.current)
      const pending = pendingLocalNavigationRef.current
      if (
        pending?.valid &&
        pending.tabId === tabId &&
        pending.documentId === documentId
      ) {
        pending.location = mapLocation(pending.location)
      }
    },
    []
  )

  const updateNavigationHistoryPath = React.useCallback(
    (tabId: TabId, documentId: string, filePath: string | null) => {
      const updateEntries = (entries: DocumentNavigationEntry[]) =>
        entries.map((entry) =>
          entry.tabId === tabId && entry.documentId === documentId
            ? { ...entry, filePath }
            : entry
        )
      navigationBackRef.current = updateEntries(navigationBackRef.current)
      navigationForwardRef.current = updateEntries(navigationForwardRef.current)
      const pending = pendingLocalNavigationRef.current
      if (
        pending?.valid &&
        pending.tabId === tabId &&
        pending.documentId === documentId
      ) {
        pending.filePath = filePath
      }
    },
    []
  )

  const focusInitialEditorIfReady = React.useCallback(() => {
    const controller = controllerRef.current
    if (
      !initialEditorFocusPendingRef.current ||
      initialEditorFocusFrameRef.current !== null ||
      !windowActiveRef.current ||
      !controller
    ) {
      return
    }
    initialEditorFocusFrameRef.current = requestAnimationFrame(() => {
      initialEditorFocusFrameRef.current = null
      if (
        !initialEditorFocusPendingRef.current ||
        controllerRef.current !== controller ||
        !windowActiveRef.current
      ) {
        return
      }

      const activeElement = document.activeElement
      const focusRemainsNeutral =
        activeElement === null ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        activeElement === controller.view.contentDOM
      initialEditorFocusPendingRef.current = false
      if (focusRemainsNeutral) controller.focusSurface()
      if (controller.view.hasFocus) performance.mark("pmd:editor-focused")
    })
  }, [])

  const applySettings = React.useCallback(
    (nextSettings: AppSettings) => {
      void loadIncludedFontFamilyStyles(
        nextSettings.regularFontFamily,
        nextSettings.monospaceFontFamily
      ).catch((error: unknown) => {
        console.error("Unable to load the selected editor fonts", error)
      })
      const controller = controllerRef.current
      if (controller) {
        enableOptionalLivePreviewForDocument(
          controller,
          nextSettings.markdownExtensions,
          controller.getDocumentKind()
        )
      }
      const appliedSettings = cloneAppSettings(nextSettings)
      const typographyGeometryChanged = editorTypographyGeometryChanged(
        appliedSettingsRef.current,
        appliedSettings
      )
      const profile = appliedSettings.themeByScheme[resolvedThemeRef.current]
      const resolvedProfile = resolveAppearanceProfile(profile)
      appliedSettingsRef.current = appliedSettings

      document.documentElement.dataset.activeTabIndicatorPositions =
        nextSettings.chrome.activeTabIndicator.positions.join(" ")
      document.documentElement.dataset.activeTabIndicatorColorSource =
        nextSettings.chrome.activeTabIndicator.colorSource
      document.documentElement.dataset.activeTabIndicatorAdaptive = String(
        nextSettings.chrome.activeTabIndicator.adaptCustomColor
      )
      document.documentElement.style.setProperty(
        "--active-tab-indicator-thickness",
        `${nextSettings.chrome.activeTabIndicator.thickness}px`
      )
      document.documentElement.style.setProperty(
        "--active-tab-indicator-custom-color",
        nextSettings.chrome.activeTabIndicator.customColor
      )
      document.documentElement.style.setProperty(
        "--active-tab-indicator-adaptive-color",
        nextSettings.chrome.activeTabIndicator.adaptCustomColor
          ? activeTabIndicatorAdaptiveColor(
              nextSettings.chrome.activeTabIndicator.customColor,
              activeTabSurfaceColor(
                resolvedProfile.backgroundColor,
                resolvedProfile.foregroundColor
              )
            )
          : nextSettings.chrome.activeTabIndicator.customColor
      )

      controllerRef.current?.setAppearanceProfile(profile)
      controllerRef.current?.setMaxContentWidth(nextSettings.maxContentWidth)
      controllerRef.current?.setMarkdownExtensions(
        nextSettings.markdownExtensions
      )
      controllerRef.current?.setSpellCheck(nextSettings.spellCheck)
      controllerRef.current?.setSourceIndentation(
        nextSettings.sourceIndentation,
        nextSettings.sourceIndentSize
      )
      applyEditorTypography(nextSettings)
      document.documentElement.style.setProperty(
        "--document-background",
        resolvedProfile.backgroundColor
      )
      const backgroundCapability =
        document.documentElement.dataset.backgroundCapability
      const supportsBackgroundEffect =
        backgroundCapability === "darwin" ||
        backgroundCapability === "win32" ||
        backgroundCapability === "linux"
      const backgroundEffectEnabled =
        supportsBackgroundEffect &&
        nextSettings.backgroundEffect.enabled &&
        nextSettings.backgroundEffect.translucency > 0
      document.documentElement.dataset.backgroundEffect =
        backgroundEffectEnabled ? "translucent" : "opaque"
      setBooleanDataAttribute(
        document.documentElement,
        "translucentCallouts",
        backgroundEffectEnabled &&
          nextSettings.backgroundEffect.translucentCallouts
      )
      setBooleanDataAttribute(
        document.documentElement,
        "translucentCodeBlocks",
        backgroundEffectEnabled &&
          nextSettings.backgroundEffect.translucentCodeBlocks
      )
      setBooleanDataAttribute(
        document.documentElement,
        "translucentInlineCode",
        backgroundEffectEnabled &&
          nextSettings.backgroundEffect.translucentInlineCode
      )
      const surfaceBackground = documentSurfaceBackground(
        resolvedProfile.backgroundColor,
        nextSettings.backgroundEffect,
        supportsBackgroundEffect
      )
      document.documentElement.style.setProperty(
        "--document-surface-background",
        surfaceBackground
      )
      const windowBackground = documentWindowBackground(
        resolvedProfile.backgroundColor,
        nextSettings.backgroundEffect,
        backgroundCapability
      )
      document.documentElement.style.setProperty(
        "--document-window-final-background",
        windowBackground
      )
      if (document.documentElement.dataset.launchTransition !== "pending") {
        document.documentElement.style.setProperty(
          "--document-window-background",
          windowBackground
        )
      }
      document.documentElement.style.setProperty(
        "--document-foreground",
        resolvedProfile.foregroundColor
      )
      document.documentElement.style.setProperty(
        "--document-muted-foreground",
        resolvedProfile.mutedForegroundColor
      )
      document.documentElement.style.setProperty(
        "--document-surface-tint",
        resolvedProfile.surfaceTintColor
      )
      const syntaxColors = syntaxPreviewColors(
        profile.syntaxThemeId,
        resolvedProfile.backgroundColor
      )
      for (const [role, color] of Object.entries(syntaxColors)) {
        document.documentElement.style.setProperty(
          `--syntax-${role}-color`,
          color
        )
      }
      document.documentElement.style.setProperty(
        "--syntax-danger-color",
        syntaxCalloutColors(
          profile.syntaxThemeId,
          resolvedProfile.backgroundColor
        ).danger
      )
      applySurfaceTheme(resolvedProfile.surfaceScheme)
      setTheme(nextSettings.appearanceMode)
      settingsContentRefreshPendingRef.current ||= typographyGeometryChanged
      settingsMeasureFrameRef.current ??= requestAnimationFrame(() => {
        settingsMeasureFrameRef.current = null
        if (settingsContentRefreshPendingRef.current) {
          settingsContentRefreshPendingRef.current = false
          controllerRef.current?.refreshContentGeometry(true)
        }
        updateStatus()
      })
    },
    [applySurfaceTheme, setTheme, updateStatus]
  )

  React.useLayoutEffect(() => {
    resolvedThemeRef.current = resolvedTheme
    if (!settingsHydratedRef.current) return
    applySettings(appliedSettingsRef.current)
  }, [applySettings, resolvedTheme])

  const handleLaunchVisualEffectReady = React.useCallback(
    (effect: LaunchVisualEffectReady) => {
      const root = document.documentElement
      const shell = appShellRef.current
      const cover = launchTintCoverRef.current
      if (!shell || !cover) return
      if (launchTransitionCleanupTimerRef.current !== null) {
        window.clearTimeout(launchTransitionCleanupTimerRef.current)
        launchTransitionCleanupTimerRef.current = null
      }

      const settle = () => {
        root.dataset.launchTransition = "settled"
        root.style.setProperty(
          "--document-window-background",
          "var(--document-window-final-background)"
        )
        shell.style.removeProperty("transition")
        cover.style.removeProperty("transition")
        cover.style.opacity = "0"
        performance.mark("pmd:launch-transition-settled")
      }

      const transition = effect.transition
      if (!transition || transition.durationMs === 0) {
        settle()
        return
      }

      const easing = launchTransitionCssEasing(transition)
      root.dataset.launchTransition = "running"
      performance.mark("pmd:launch-transition-started")
      if (transition.strategy === "tint") {
        cover.style.transition = "none"
        cover.style.opacity = "0"
        root.style.setProperty(
          "--document-window-background",
          "var(--document-background)"
        )
        shell.getBoundingClientRect()
        shell.style.transition = `background-color ${transition.durationMs}ms ${easing} ${transition.delayMs}ms`
        root.style.setProperty(
          "--document-window-background",
          "var(--document-window-final-background)"
        )
      } else {
        root.style.setProperty(
          "--document-window-background",
          "var(--document-window-final-background)"
        )
        cover.style.transition = "none"
        cover.style.opacity = "1"
        cover.getBoundingClientRect()
        cover.style.transition = `opacity ${transition.durationMs}ms ${easing} ${transition.delayMs}ms`
        cover.style.opacity = "0"
      }

      launchTransitionCleanupTimerRef.current = window.setTimeout(
        () => {
          launchTransitionCleanupTimerRef.current = null
          settle()
        },
        transition.delayMs + transition.durationMs + 50
      )
    },
    []
  )

  const acceptSettings = React.useCallback(
    (
      nextSettings: AppSettings,
      persistedSettings?: AppSettings,
      finishPreview = false
    ) => {
      const previousCommittedSettings = settingsRef.current
      const effectiveChanged = !settingsEqual(
        previousCommittedSettings,
        nextSettings
      )
      const persistedChanged =
        persistedSettings !== undefined &&
        !settingsEqual(persistedSettingsRef.current, persistedSettings)
      if (!effectiveChanged && !persistedChanged && !finishPreview) return

      const committedSettings = effectiveChanged
        ? cloneAppSettings(nextSettings)
        : previousCommittedSettings
      settingsRef.current = committedSettings
      if (persistedSettings && persistedChanged) {
        const committedPersistedSettings = cloneAppSettings(persistedSettings)
        persistedSettingsRef.current = committedPersistedSettings
        // An open Settings surface owns a local transaction. A commit from
        // another window may update the running app, but it must not replace
        // this window's draft or the parent draft of a specialized workspace.
        if (!settingsOpenRef.current && !settingsWorkspaceOpenRef.current) {
          setSettingsDialogSettings(committedPersistedSettings)
        }
      }
      if (!effectiveChanged && !finishPreview) return

      // The Settings transaction owns both its draft and its visible preview.
      // Sibling commits advance the baseline for merge/cancel without replacing
      // that preview. Native page zoom alone also updates the current draft.
      if (
        !finishPreview &&
        (settingsOpenRef.current || settingsWorkspaceOpenRef.current)
      ) {
        if (
          settingsMatchExceptZoom(previousCommittedSettings, committedSettings)
        ) {
          const mergedSettings = cloneAppSettings(appliedSettingsRef.current)
          mergedSettings.zoomFactor = committedSettings.zoomFactor
          setAppSettings(mergedSettings)
          applySettings(mergedSettings)
          if (settingsOpenRef.current) {
            settingsZoomHandlerRef.current?.(committedSettings.zoomFactor)
          } else {
            updateSettingsWorkspaceZoom(committedSettings.zoomFactor)
          }
        }
        return
      }

      const previousAppliedSettings = appliedSettingsRef.current
      if (
        previousAppliedSettings.chrome.showFormattingBar !==
        committedSettings.chrome.showFormattingBar
      ) {
        setTopDrawerCompensated(
          committedSettings.chrome.showFormattingBar &&
            currentDocumentKind() === "markdown" &&
            shouldCompensateTopDrawer()
        )
      }
      if (
        committedSettings.chrome.showFormattingBar &&
        currentDocumentKind() === "markdown" &&
        !previousAppliedSettings.chrome.showFormattingBar
      ) {
        setFormattingToolbarActivated(true)
        void loadFormattingToolbar().catch(() => undefined)
      }

      setAppSettings(committedSettings)
      applySettings(committedSettings)
    },
    [
      applySettings,
      currentDocumentKind,
      shouldCompensateTopDrawer,
      updateSettingsWorkspaceZoom,
    ]
  )

  const previewSettings = React.useCallback(
    (nextSettings: AppSettings) => {
      settingsDialogDraftRef.current = cloneAppSettings(nextSettings)
      if (
        appliedSettingsRef.current.chrome.showFormattingBar !==
        nextSettings.chrome.showFormattingBar
      ) {
        setTopDrawerCompensated(
          nextSettings.chrome.showFormattingBar &&
            currentDocumentKind() === "markdown" &&
            shouldCompensateTopDrawer()
        )
      }
      if (
        nextSettings.chrome.showFormattingBar &&
        currentDocumentKind() === "markdown"
      ) {
        setFormattingToolbarActivated(true)
        void loadFormattingToolbar().catch(() => undefined)
      }
      setAppSettings(cloneAppSettings(nextSettings))
      applySettings(nextSettings)
      window.pulseMd.previewAppearance({
        appearanceMode: nextSettings.appearanceMode,
        backgroundEffect: { ...nextSettings.backgroundEffect },
        themeByScheme: nextSettings.themeByScheme,
      })
      window.pulseMd.previewWindowZoom(nextSettings.zoomFactor)
    },
    [applySettings, currentDocumentKind, shouldCompensateTopDrawer]
  )

  const syncActiveSession = React.useCallback(() => {
    const controller = controllerRef.current
    const tabId = activeTabIdRef.current
    const tab = tabId ? tabsRef.current.get(tabId) : undefined
    if (!controller || !tab) return tab
    tab.editor = controller.captureSession(tab.revision)
    return tab
  }, [])

  const setControllerReadOnlyRespectingLocks = React.useCallback(
    (
      controller: MarkdownEditorController,
      readOnly: boolean,
      tabId: TabId | null = activeTabIdRef.current
    ) => {
      const transferLeased = [
        ...tabTransferCommitLeasesRef.current.values(),
      ].some((leaseTabId) => leaseTabId === tabId)
      controller.setReadOnly(
        readOnly ||
          transferLeased ||
          documentOpenLeaseCountRef.current > 0 ||
          settingsWorkspaceOpenRef.current
      )
    },
    []
  )

  const beginDocumentOpenLease = React.useCallback(() => {
    documentOpenLeaseCountRef.current += 1
    const controller = controllerRef.current
    if (controller) {
      setControllerReadOnlyRespectingLocks(controller, true)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      documentOpenLeaseCountRef.current = Math.max(
        0,
        documentOpenLeaseCountRef.current - 1
      )
      if (documentOpenLeaseCountRef.current > 0) return
      const controller = controllerRef.current
      if (controller) {
        setControllerReadOnlyRespectingLocks(controller, false)
      }
    }
  }, [setControllerReadOnlyRespectingLocks])

  const restoreActiveDocumentSession = React.useCallback(() => {
    const controller = controllerRef.current
    const tabId = activeTabIdRef.current
    const tab = tabId ? tabsRef.current.get(tabId) : undefined
    if (!controller || !tab) return
    setControllerReadOnlyRespectingLocks(controller, false)
    controller.activateSession(tab.editor)
    enableOptionalLivePreviewForDocument(
      controller,
      settingsRef.current.markdownExtensions,
      tab.document.kind
    )
    prepareFormattingToolbarForDocument(tab.document.kind)
    window.pulseMd.reportLineWrapping(controller.getLineWrapping())
    updateStatus()
  }, [
    prepareFormattingToolbarForDocument,
    setControllerReadOnlyRespectingLocks,
    updateStatus,
  ])

  const resumeActiveDocumentSession = React.useCallback(() => {
    const controller = controllerRef.current
    const tabId = activeTabIdRef.current
    const tab = tabId ? tabsRef.current.get(tabId) : undefined
    if (!controller || !tab) return
    setControllerReadOnlyRespectingLocks(controller, false)
    window.pulseMd.reportLineWrapping(controller.getLineWrapping())
    controller.setDocumentIdentity(tab.document.filePath, tab.document.kind)
    updateStatus()
  }, [setControllerReadOnlyRespectingLocks, updateStatus])

  const openTypographyPreview = React.useCallback(
    async (settingsDraft: AppSettings) => {
      if (settingsWorkspaceOpenRef.current) return
      let typographyPreviewMarkdown: string
      try {
        const { TYPOGRAPHY_PREVIEW_MARKDOWN } =
          await loadTypographyPreviewDocumentModule()
        typographyPreviewMarkdown = TYPOGRAPHY_PREVIEW_MARKDOWN
      } catch (error) {
        console.error("Unable to load the typography preview document", error)
        return
      }
      if (!settingsOpenRef.current || settingsWorkspaceOpenRef.current) {
        return
      }
      const controller = controllerRef.current
      const activeTab = syncActiveSession()
      if (!controller || !activeTab) return

      const parentDraft = cloneAppSettings(settingsDraft)
      const previewSession = controller.createSession(
        typographyPreviewMarkdown,
        "live"
      )
      controller.clearSearch()
      setSearchOpen(false)
      controller.activateSession(previewSession)
      controller.setReadOnly(true)

      settingsWorkspaceOpenRef.current = true
      windowProfileLaunchPendingRef.current = false
      settingsOpenRef.current = false
      setSettingsOpen(false)
      setTypographyPreview({ parentDraft })
      previewSettings(parentDraft)
    },
    [previewSettings, syncActiveSession]
  )

  const returnFromTypographyPreview = React.useCallback(
    (settingsDraft: AppSettings) => {
      settingsWorkspaceOpenRef.current = false
      restoreActiveDocumentSession()
      setTypographyPreview(null)
      setSettingsDialogSettings(cloneAppSettings(settingsDraft))
      previewSettings(settingsDraft)
      settingsOpenRef.current = true
      setSettingsOpen(true)
    },
    [previewSettings, restoreActiveDocumentSession]
  )

  const cancelTypographyPreview = React.useCallback(() => {
    const preview = typographyPreview
    if (!preview) return
    returnFromTypographyPreview(preview.parentDraft)
  }, [returnFromTypographyPreview, typographyPreview])

  const saveTypographyPreview = React.useCallback(
    async (typographyDraft: AppSettings) => {
      const preview = typographyPreview
      if (!preview) return
      settingsWorkspaceSavePendingRef.current = true
      try {
        const committedCandidate = withTypographySettings(
          persistedSettingsRef.current,
          typographyDraft
        )
        const savedSettings =
          await window.pulseMd.setSettings(committedCandidate)
        acceptSettings(savedSettings.effective, savedSettings.persisted)
        returnFromTypographyPreview(
          withTypographySettings(preview.parentDraft, savedSettings.persisted)
        )
      } catch (error) {
        console.error("Failed to save typography settings", error)
        throw error
      } finally {
        settingsWorkspaceSavePendingRef.current = false
      }
    },
    [acceptSettings, returnFromTypographyPreview, typographyPreview]
  )

  const openActiveTabIndicatorPreview = React.useCallback(
    (settingsDraft: AppSettings) => {
      if (settingsWorkspaceOpenRef.current) return
      const controller = controllerRef.current
      const activeTab = syncActiveSession()
      if (!controller || !activeTab) return

      controller.clearSearch()
      setSearchOpen(false)
      controller.setReadOnly(true)

      settingsWorkspaceOpenRef.current = true
      settingsOpenRef.current = false
      setSettingsOpen(false)
      setActiveTabIndicatorPreview({
        parentDraft: cloneAppSettings(settingsDraft),
      })
      previewSettings(settingsDraft)
    },
    [previewSettings, syncActiveSession]
  )

  const returnFromActiveTabIndicatorPreview = React.useCallback(
    (settingsDraft: AppSettings) => {
      settingsWorkspaceOpenRef.current = false
      restoreActiveDocumentSession()
      setActiveTabIndicatorPreview(null)
      setSettingsDialogSettings(cloneAppSettings(settingsDraft))
      previewSettings(settingsDraft)
      settingsOpenRef.current = true
      setSettingsOpen(true)
    },
    [previewSettings, restoreActiveDocumentSession]
  )

  const cancelActiveTabIndicatorPreview = React.useCallback(() => {
    const preview = activeTabIndicatorPreview
    if (!preview) return
    returnFromActiveTabIndicatorPreview(preview.parentDraft)
  }, [activeTabIndicatorPreview, returnFromActiveTabIndicatorPreview])

  const saveActiveTabIndicatorPreview = React.useCallback(
    async (indicatorDraft: AppSettings) => {
      const preview = activeTabIndicatorPreview
      if (!preview) return
      settingsWorkspaceSavePendingRef.current = true
      try {
        const committedCandidate = withActiveTabIndicatorSettings(
          persistedSettingsRef.current,
          indicatorDraft
        )
        const savedSettings =
          await window.pulseMd.setSettings(committedCandidate)
        acceptSettings(savedSettings.effective, savedSettings.persisted)
        returnFromActiveTabIndicatorPreview(
          withActiveTabIndicatorSettings(
            preview.parentDraft,
            savedSettings.persisted
          )
        )
      } catch (error) {
        console.error("Failed to save active tab indicator settings", error)
        throw error
      } finally {
        settingsWorkspaceSavePendingRef.current = false
      }
    },
    [
      acceptSettings,
      activeTabIndicatorPreview,
      returnFromActiveTabIndicatorPreview,
    ]
  )

  const openLaunchTransitionPreview = React.useCallback(
    (settingsDraft: AppSettings) => {
      if (settingsWorkspaceOpenRef.current) return
      const controller = controllerRef.current
      const activeTab = syncActiveSession()
      if (!controller || !activeTab) return

      controller.clearSearch()
      setSearchOpen(false)
      controller.setReadOnly(true)

      settingsWorkspaceOpenRef.current = true
      settingsOpenRef.current = false
      setSettingsOpen(false)
      setLaunchTransitionPreview({
        parentDraft: cloneAppSettings(settingsDraft),
      })
    },
    [syncActiveSession]
  )

  const returnFromLaunchTransitionPreview = React.useCallback(
    (settingsDraft: AppSettings) => {
      settingsWorkspaceOpenRef.current = false
      restoreActiveDocumentSession()
      setLaunchTransitionPreview(null)
      setSettingsDialogSettings(cloneAppSettings(settingsDraft))
      previewSettings(settingsDraft)
      settingsOpenRef.current = true
      setSettingsOpen(true)
    },
    [previewSettings, restoreActiveDocumentSession]
  )

  const cancelLaunchTransitionPreview = React.useCallback(() => {
    const preview = launchTransitionPreview
    if (!preview) return
    returnFromLaunchTransitionPreview(preview.parentDraft)
  }, [launchTransitionPreview, returnFromLaunchTransitionPreview])

  const saveLaunchTransitionPreview = React.useCallback(
    async (transitionDraft: AppSettings) => {
      const preview = launchTransitionPreview
      if (!preview) return
      settingsWorkspaceSavePendingRef.current = true
      try {
        const committedCandidate = withLaunchTransitionSettings(
          persistedSettingsRef.current,
          transitionDraft
        )
        const savedSettings =
          await window.pulseMd.setSettings(committedCandidate)
        acceptSettings(savedSettings.effective, savedSettings.persisted)
        returnFromLaunchTransitionPreview(
          withLaunchTransitionSettings(
            preview.parentDraft,
            savedSettings.persisted
          )
        )
      } catch (error) {
        console.error("Failed to save launch transition settings", error)
        throw error
      } finally {
        settingsWorkspaceSavePendingRef.current = false
      }
    },
    [acceptSettings, launchTransitionPreview, returnFromLaunchTransitionPreview]
  )

  const activateScratchesWorkspace = React.useCallback(
    (workspace: ScratchesWorkspaceState) => {
      if (settingsWorkspaceOpenRef.current) return false
      const controller = controllerRef.current
      const activeTab = syncActiveSession()
      if (!controller || !activeTab) return false

      controller.clearSearch()
      setSearchOpen(false)
      controller.setReadOnly(true)
      settingsWorkspaceOpenRef.current = true
      scratchesWorkspaceOpenRef.current = true
      settingsOpenRef.current = false
      setSettingsOpen(false)
      setScratchesWorkspace({
        origin: workspace.origin,
        parentDraft: cloneAppSettings(workspace.parentDraft),
        ...(workspace.selectedScratchId
          ? { selectedScratchId: workspace.selectedScratchId }
          : {}),
      })
      return true
    },
    [syncActiveSession]
  )

  const openScratchesWorkspace = React.useCallback(
    (settingsDraft: AppSettings) => {
      settingsDialogDraftRef.current = cloneAppSettings(settingsDraft)
      const parentDraft = cloneAppSettings(settingsDraft)
      if (windowZoomFactorRef.current !== null) {
        parentDraft.zoomFactor = windowZoomFactorRef.current
      }
      if (!activateScratchesWorkspace({ origin: "settings", parentDraft })) {
        return
      }
      pushSettingsNavigationRoute({ kind: "scratches" })
    },
    [activateScratchesWorkspace, pushSettingsNavigationRoute]
  )

  const editScratchFromBrowser = React.useCallback(
    (scratchId: string) => {
      if (!scratchBrowserOpenRef.current) return
      const parentDraft = cloneAppSettings(settingsRef.current)
      if (windowZoomFactorRef.current !== null) {
        parentDraft.zoomFactor = windowZoomFactorRef.current
      }
      if (
        !activateScratchesWorkspace({
          origin: "scratch-browser",
          parentDraft,
          selectedScratchId: scratchId,
        })
      ) {
        return
      }
      scratchBrowserOpenRef.current = false
      setScratchBrowserOpen(false)
      reportEditorMenuState()
      resetSettingsNavigationHistory()
      pushSettingsNavigationRoute({ kind: "scratches" })
    },
    [
      activateScratchesWorkspace,
      pushSettingsNavigationRoute,
      reportEditorMenuState,
      resetSettingsNavigationHistory,
    ]
  )

  const editScratchFromTab = React.useCallback(
    (scratchId: string) => {
      if (
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        return
      }
      const parentDraft = cloneAppSettings(settingsRef.current)
      if (windowZoomFactorRef.current !== null) {
        parentDraft.zoomFactor = windowZoomFactorRef.current
      }
      if (
        !activateScratchesWorkspace({
          origin: "editor",
          parentDraft,
          selectedScratchId: scratchId,
        })
      ) {
        return
      }
      resetSettingsNavigationHistory()
      pushSettingsNavigationRoute({ kind: "scratches" })
    },
    [
      activateScratchesWorkspace,
      pushSettingsNavigationRoute,
      resetSettingsNavigationHistory,
    ]
  )

  const returnFromScratchesWorkspace = React.useCallback(() => {
    const workspace = scratchesWorkspace
    if (!workspace) return false
    settingsWorkspaceOpenRef.current = false
    scratchesWorkspaceOpenRef.current = false
    scratchesNavigationBlockedRef.current = false
    restoreActiveDocumentSession()
    const parentDraft = cloneAppSettings(workspace.parentDraft)
    if (windowZoomFactorRef.current !== null) {
      parentDraft.zoomFactor = windowZoomFactorRef.current
    }
    if (workspace.origin === "settings") {
      setSettingsDialogSettings(parentDraft)
      previewSettings(parentDraft)
      settingsOpenRef.current = true
      setSettingsOpen(true)
      return true
    }

    setScratchesWorkspace(null)
    resetSettingsNavigationHistory()
    if (workspace.origin === "scratch-browser") {
      scratchBrowserOpenRef.current = true
      setScratchBrowserOpen(true)
      reportEditorMenuState()
    } else {
      window.requestAnimationFrame(() => controllerRef.current?.focusSurface())
    }
    return true
  }, [
    previewSettings,
    reportEditorMenuState,
    resetSettingsNavigationHistory,
    restoreActiveDocumentSession,
    scratchesWorkspace,
  ])

  const handleScratchesNavigationBlockedChange = React.useCallback(
    (blocked: boolean) => {
      scratchesNavigationBlockedRef.current = blocked
    },
    []
  )

  const activateWindowProfilesWorkspace = React.useCallback(
    (workspace: WindowProfilesWorkspaceState) => {
      if (settingsWorkspaceOpenRef.current) return
      const controller = controllerRef.current
      const activeTab = syncActiveSession()
      if (!controller || !activeTab) return false

      controller.clearSearch()
      setSearchOpen(false)
      controller.setReadOnly(true)
      settingsWorkspaceOpenRef.current = true
      windowProfilesWorkspaceOpenRef.current = true
      windowProfileLaunchPendingRef.current = false
      settingsOpenRef.current = false
      setSettingsOpen(false)
      setWindowProfilesWorkspace({
        ...workspace,
        parentDraft: cloneAppSettings(settingsDialogDraftRef.current),
      })
      return true
    },
    [syncActiveSession]
  )

  const currentWindowProfileTabModes = React.useCallback(
    () =>
      tabDescriptorsRef.current.map(({ id }) => {
        const tab = tabsRef.current.get(id)
        return {
          mode: tab?.editor.mode ?? settingsRef.current.initialEditorMode,
          tabId: id,
        }
      }),
    []
  )

  const openWindowProfiles = React.useCallback(
    (settingsDraft: AppSettings) => {
      settingsDialogDraftRef.current = cloneAppSettings(settingsDraft)
      const currentWindowTabModes = currentWindowProfileTabModes()
      const parentDraft = cloneAppSettings(settingsDraft)
      if (windowZoomFactorRef.current !== null) {
        parentDraft.zoomFactor = windowZoomFactorRef.current
      }
      const workspace = {
        currentWindowTabModes,
        parentDraft,
      }
      if (!activateWindowProfilesWorkspace(workspace)) return
      pushSettingsNavigationRoute({ kind: "window-profiles" })
    },
    [
      activateWindowProfilesWorkspace,
      currentWindowProfileTabModes,
      pushSettingsNavigationRoute,
    ]
  )

  const returnFromWindowProfiles = React.useCallback(() => {
    const workspace = windowProfilesWorkspace
    if (!workspace) return false
    settingsWorkspaceOpenRef.current = false
    windowProfilesWorkspaceOpenRef.current = false
    windowProfilesNavigationBlockedRef.current = false
    windowProfileLaunchPendingRef.current = false
    restoreActiveDocumentSession()
    const parentDraft = cloneAppSettings(workspace.parentDraft)
    if (windowZoomFactorRef.current !== null) {
      parentDraft.zoomFactor = windowZoomFactorRef.current
    }
    setSettingsDialogSettings(parentDraft)
    previewSettings(parentDraft)
    settingsOpenRef.current = true
    setSettingsOpen(true)
    return true
  }, [previewSettings, restoreActiveDocumentSession, windowProfilesWorkspace])

  const launchWindowProfile = React.useCallback(
    async (profileId: string) => {
      const workspace = windowProfilesWorkspace
      if (!workspace) return

      windowProfileLaunchPendingRef.current = true
      const committedSettings = cloneAppSettings(settingsRef.current)
      setAppSettings(committedSettings)
      applySettings(committedSettings)
      window.pulseMd.previewAppearance(null)
      window.pulseMd.previewWindowZoom(committedSettings.zoomFactor)

      try {
        const rebasedSettings = rebaseSettingsDraft(
          settingsDialogBaseRef.current,
          workspace.parentDraft,
          persistedSettingsRef.current
        )
        const savedSettings = await window.pulseMd.setSettings(rebasedSettings)
        acceptSettings(savedSettings.effective, savedSettings.persisted, true)
        await window.pulseMd.launchWindowProfile(profileId)
        settingsWorkspaceOpenRef.current = false
        windowProfilesWorkspaceOpenRef.current = false
        windowProfileLaunchPendingRef.current = false
        resumeActiveDocumentSession()
        setWindowProfilesWorkspace(null)
        resetSettingsNavigationHistory()
        settingsReturnFocusRef.current = false
        window.pulseMd.releaseSettingsSession()
        window.requestAnimationFrame(() =>
          controllerRef.current?.focusSurface()
        )
      } catch (error) {
        windowProfileLaunchPendingRef.current = false
        controllerRef.current?.setReadOnly(true)
        previewSettings(workspace.parentDraft)
        throw error
      }
    },
    [
      acceptSettings,
      applySettings,
      previewSettings,
      resetSettingsNavigationHistory,
      resumeActiveDocumentSession,
      windowProfilesWorkspace,
    ]
  )

  const handleTypographyDockHeightChange = React.useCallback(
    (height: number) => {
      document.documentElement.style.setProperty(
        "--typography-dock-height",
        `${Math.max(0, height)}px`
      )
      controllerRef.current?.requestMeasure()
    },
    []
  )

  const resetSearchForTabChange = React.useCallback(() => {
    controllerRef.current?.clearSearch()
    searchStatusRef.current = EMPTY_SEARCH_STATUS
    searchOverlayRef.current?.reset()
    setSearchOpen(false)
    outlineOpenRef.current = false
    setOutlineOpen(false)
  }, [])

  const hydrateRendererTab: (
    tabId: TabId,
    interactive: boolean
  ) => Promise<RendererTab | null> = React.useCallback(
    async (tabId: TabId, interactive: boolean): Promise<RendererTab | null> => {
      const existing = tabsRef.current.get(tabId)
      if (existing) return existing
      if (!tabDescriptorsRef.current.some(({ id }) => id === tabId)) return null

      const startHydration = (
        requestIsInteractive: boolean
      ): PendingRendererTabHydration => {
        const promise = (async () => {
          try {
            const bootstrap = await window.pulseMd.hydrateTab(
              tabId,
              requestIsInteractive
            )
            if (!bootstrap) return null
            if (bootstrap.tab.id !== tabId) {
              throw new Error("Hydrated tab identity did not match its request")
            }
            const controller = controllerRef.current
            const descriptor = tabDescriptorsRef.current.find(
              ({ id }) => id === tabId
            )
            if (!controller || !descriptor) return null

            const alreadyHydrated = tabsRef.current.get(tabId)
            if (alreadyHydrated) {
              window.pulseMd.acknowledgeTabHydration(tabId)
              return alreadyHydrated
            }
            const hydrated = rendererTabFromBootstrap(
              controller,
              bootstrap,
              settingsRef.current.initialEditorMode,
              settingsRef.current.lineWrapping
            )
            hydrated.backing = descriptor.backing
            hydrated.color = descriptor.color
            hydrated.dirty = descriptor.dirty
            hydrated.document = {
              ...hydrated.document,
              displayName: descriptor.displayName,
              filePath: descriptor.filePath,
            }
            if (!descriptor.dirty) {
              hydrated.cleanDocument = hydrated.editor.state.doc
            }
            tabsRef.current.set(tabId, hydrated)
            window.pulseMd.acknowledgeTabHydration(tabId)
            if (hydrated.backing === "scratch" && hydrated.dirty) {
              scheduleScratchSave(
                tabId,
                scratchAutosaveDelay(hydrated.editor.state.doc.length)
              )
            }
            return hydrated
          } catch (error) {
            console.error(`Unable to hydrate tab ${tabId}`, error)
            return null
          }
        })()
        const entry = { interactive: requestIsInteractive, promise }
        tabHydrationsRef.current.set(tabId, entry)
        const clearPending = () => {
          if (tabHydrationsRef.current.get(tabId) === entry) {
            tabHydrationsRef.current.delete(tabId)
          }
          setTabHydrating(tabId, false)
        }
        void promise.then(clearPending, clearPending)
        return entry
      }

      let pending = tabHydrationsRef.current.get(tabId)
      const joinedBackgroundHydration = Boolean(
        interactive && pending && !pending.interactive
      )
      pending ??= startHydration(interactive)

      if (interactive) setTabHydrating(tabId, true)
      let hydrated = await pending.promise
      if (
        !hydrated &&
        joinedBackgroundHydration &&
        tabDescriptorsRef.current.some(({ id }) => id === tabId)
      ) {
        if (tabHydrationsRef.current.get(tabId) === pending) {
          tabHydrationsRef.current.delete(tabId)
        }
        pending = startHydration(true)
        setTabHydrating(tabId, true)
        hydrated = await pending.promise
      }
      return hydrated
    },
    [scheduleScratchSave, setTabHydrating]
  )

  const activateLocalTab = React.useCallback(
    (tabId: TabId, notifyMain: boolean, focusIntent: TabFocusIntent) => {
      const controller = controllerRef.current
      const next = tabsRef.current.get(tabId)
      if (!controller || !next) return false
      if (activeTabIdRef.current === tabId) {
        setControllerReadOnlyRespectingLocks(controller, false, tabId)
        enableOptionalLivePreviewForDocument(
          controller,
          settingsRef.current.markdownExtensions,
          next.document.kind
        )
        prepareFormattingToolbarForDocument(next.document.kind)
        if (notifyMain) window.pulseMd.setActiveTab(tabId)
        return true
      }

      resetSearchForTabChange()
      syncActiveSession()
      if (!controller.activateSession(next.editor)) return false
      enableOptionalLivePreviewForDocument(
        controller,
        settingsRef.current.markdownExtensions,
        next.document.kind
      )
      prepareFormattingToolbarForDocument(next.document.kind)
      setControllerReadOnlyRespectingLocks(controller, false, tabId)
      window.pulseMd.reportLineWrapping(controller.getLineWrapping())
      if (
        next.document.kind === "markdown" &&
        settingsRef.current.chrome.showFormattingBar
      ) {
        setTopDrawerCompensated(shouldCompensateTopDrawer())
      }
      controller.clearSearch()
      activeTabIdRef.current = tabId
      setActiveTabId(tabId)
      window.document.title = next.document.displayName
      updateStatus()
      if (notifyMain) window.pulseMd.setActiveTab(tabId)
      if (focusIntent.policy === "editor") {
        requestAnimationFrame(() => {
          if (
            focusOwnershipRevisionRef.current === focusIntent.revision &&
            document.activeElement === focusIntent.owner
          ) {
            controller.focusSurface()
          }
        })
      }
      return true
    },
    [
      resetSearchForTabChange,
      prepareFormattingToolbarForDocument,
      setControllerReadOnlyRespectingLocks,
      shouldCompensateTopDrawer,
      syncActiveSession,
      updateStatus,
    ]
  )

  const activateTab = React.useCallback(
    async (
      tabId: TabId,
      notifyMain: boolean,
      focusPolicy: TabFocusPolicy = "editor"
    ) => {
      const activationRevision = ++tabActivationRevisionRef.current
      const focusIntent = captureTabFocusIntent(focusPolicy)
      const tab =
        tabsRef.current.get(tabId) ?? (await hydrateRendererTab(tabId, true))
      if (
        !tab ||
        activationRevision !== tabActivationRevisionRef.current ||
        !tabDescriptorsRef.current.some(({ id }) => id === tabId)
      ) {
        return false
      }
      return activateLocalTab(tabId, notifyMain, focusIntent)
    },
    [activateLocalTab, captureTabFocusIntent, hydrateRendererTab]
  )

  const applyTabsSnapshot = React.useCallback(
    (
      snapshot: WindowTabsSnapshot,
      focusPolicy: TabFocusPolicy = "preserve"
    ) => {
      setTabDragSink(snapshot.tabDragSink)
      const ids = new Set(snapshot.tabs.map((tab) => tab.id))
      pruneNavigationHistory(ids)
      for (const descriptor of snapshot.tabs) {
        const pending = pendingImportsRef.current.get(descriptor.id)
        if (pending) {
          window.clearTimeout(pending.timeout)
          pendingImportsRef.current.delete(descriptor.id)
          tabsRef.current.set(descriptor.id, pending.tab)
        }
        const local = tabsRef.current.get(descriptor.id)
        if (local) {
          local.backing = descriptor.backing
          local.color = descriptor.color
          local.dirty = descriptor.dirty
          local.document = {
            ...local.document,
            displayName: descriptor.displayName,
            filePath: descriptor.filePath,
            kind: descriptor.kind,
          }
          local.editor.documentPath = descriptor.filePath
          local.editor.documentKind = descriptor.kind
          if (descriptor.backing !== "scratch") {
            clearScratchSaveTimer(descriptor.id)
          } else if (
            descriptor.dirty &&
            !scratchSaveTimersRef.current.has(descriptor.id) &&
            (scratchSaveCoordinationsRef.current.get(descriptor.id)
              ?.inFlightCount ?? 0) === 0
          ) {
            // A dirty scratch session can arrive through a cross-window tab
            // transfer after its source renderer has canceled the debounce.
            // Re-establish autosave ownership in the destination window.
            scheduleScratchSave(descriptor.id)
          }
        }
      }
      for (const tabId of tabsRef.current.keys()) {
        if (!ids.has(tabId)) {
          clearScratchSaveTimer(tabId)
          tabsRef.current.delete(tabId)
        }
      }
      setDescriptors(snapshot.tabs)
      const retiredTabIds = new Set(retiredTabDragsRef.current.values())
      let visibleActiveTabId = snapshot.activeTabId
      if (retiredTabIds.has(visibleActiveTabId)) {
        const sourceIndex = snapshot.tabs.findIndex(
          (tab) => tab.id === visibleActiveTabId
        )
        const visibleTabs = snapshot.tabs.filter(
          (tab) => !retiredTabIds.has(tab.id)
        )
        visibleActiveTabId =
          visibleTabs[Math.min(sourceIndex, visibleTabs.length - 1)]?.id ??
          visibleActiveTabId
      }
      if (visibleActiveTabId !== activeTabIdRef.current) {
        void activateTab(visibleActiveTabId, false, focusPolicy)
      } else {
        const active = tabsRef.current.get(visibleActiveTabId)
        if (active) window.document.title = active.document.displayName
        updateStatus()
      }
    },
    [
      activateTab,
      clearScratchSaveTimer,
      pruneNavigationHistory,
      scheduleScratchSave,
      setDescriptors,
      updateStatus,
    ]
  )

  const settleControllerCommitLease = React.useCallback(
    (transferId: string) => {
      const leaseTabId = tabTransferCommitLeasesRef.current.get(transferId)
      if (!leaseTabId) return null
      tabTransferCommitLeasesRef.current.delete(transferId)
      const controller = controllerRef.current
      if (controller) {
        setControllerReadOnlyRespectingLocks(controller, false)
      }
      return leaseTabId
    },
    [setControllerReadOnlyRespectingLocks]
  )

  const handleCliTabsOpenRequest = React.useCallback(
    (request: CliTabsOpenRequest) => {
      const reject = () =>
        window.pulseMd.acknowledgeCliTabsOpen({
          requestId: request.requestId,
          accepted: false,
        })
      const controller = controllerRef.current
      if (
        !rendererReadyRef.current ||
        !controller ||
        controller.view.compositionStarted ||
        settingsOpenRef.current ||
        softwareLicensesOpenRef.current ||
        (settingsWorkspaceOpenRef.current &&
          !(
            request.replaceTabId !== undefined &&
            windowProfileLaunchPendingRef.current
          )) ||
        closingTabsRef.current.size > 0 ||
        request.tabs.length === 0
      ) {
        reject()
        return
      }

      const requestTabIds = new Set(request.tabs.map(({ tab }) => tab.id))
      const replaceTabId = request.replaceTabId
      if (
        requestTabIds.size !== request.tabs.length ||
        !requestTabIds.has(request.activeTabId) ||
        [...requestTabIds].some((tabId) => tabsRef.current.has(tabId)) ||
        (replaceTabId !== undefined &&
          (!tabsRef.current.has(replaceTabId) ||
            requestTabIds.has(replaceTabId)))
      ) {
        reject()
        return
      }

      const previousDescriptors = tabDescriptorsRef.current
      const previousActiveTabId = activeTabIdRef.current
      if (replaceTabId !== undefined) {
        const replacementTab = tabsRef.current.get(replaceTabId)
        const replacementDescriptor = previousDescriptors.find(
          ({ id }) => id === replaceTabId
        )
        if (
          !replacementTab ||
          !replacementDescriptor ||
          !isDisposableCliTabReplacement({
            active: previousActiveTabId === replaceTabId,
            backing: replacementTab.backing,
            cleanDocumentLength: replacementTab.cleanDocument.length,
            descriptor: replacementDescriptor,
            dirty: replacementTab.dirty,
            documentFilePath: replacementTab.document.filePath,
            editorDocumentLength: controller.view.state.doc.length,
          })
        ) {
          reject()
          return
        }
      }
      const rollback = () => {
        for (const tabId of requestTabIds) {
          clearScratchSaveTimer(tabId)
          tabsRef.current.delete(tabId)
        }
        setDescriptors(previousDescriptors)
        if (
          controllerRef.current === controller &&
          previousActiveTabId &&
          tabsRef.current.has(previousActiveTabId)
        ) {
          activateLocalTab(
            previousActiveTabId,
            false,
            captureTabFocusIntent("preserve")
          )
          if (replaceTabId !== undefined) {
            setControllerReadOnlyRespectingLocks(controller, false)
          }
        }
      }
      try {
        if (replaceTabId !== undefined) {
          setControllerReadOnlyRespectingLocks(controller, false)
        }
        const createdTabs = request.tabs.map((bootstrap) =>
          rendererTabFromBootstrap(
            controller,
            bootstrap,
            request.editorMode ?? settingsRef.current.initialEditorMode,
            settingsRef.current.lineWrapping
          )
        )
        for (const tab of createdTabs) tabsRef.current.set(tab.id, tab)
        const requestedDescriptors = new Map(
          request.tabs.map(({ tab }) => [tab.id, tab])
        )
        const existingDescriptorIds = new Set(
          previousDescriptors.map(({ id }) => id)
        )
        const nextDescriptors = previousDescriptors.map(
          (descriptor) => requestedDescriptors.get(descriptor.id) ?? descriptor
        )
        const newDescriptors = request.tabs
          .map(({ tab }) => tab)
          .filter(({ id }) => !existingDescriptorIds.has(id))
        const replaceDescriptorIndex =
          replaceTabId === undefined
            ? -1
            : nextDescriptors.findIndex(({ id }) => id === replaceTabId)
        if (replaceDescriptorIndex >= 0) {
          nextDescriptors.splice(
            replaceDescriptorIndex + 1,
            0,
            ...newDescriptors
          )
        } else {
          nextDescriptors.push(...newDescriptors)
        }
        setDescriptors(nextDescriptors)

        if (
          !activateLocalTab(
            request.activeTabId,
            false,
            captureTabFocusIntent("preserve")
          )
        ) {
          throw new Error("The requested CLI tab could not be activated")
        }

        const focusIntent = captureTabFocusIntent("editor")
        window.requestAnimationFrame(() => {
          const profileLaunchWorkspaceStillOwnsRequest =
            request.replaceTabId !== undefined &&
            windowProfileLaunchPendingRef.current
          if (
            controllerRef.current !== controller ||
            activeTabIdRef.current !== request.activeTabId ||
            settingsOpenRef.current ||
            softwareLicensesOpenRef.current ||
            (settingsWorkspaceOpenRef.current &&
              !profileLaunchWorkspaceStillOwnsRequest) ||
            focusOwnershipRevisionRef.current !== focusIntent.revision ||
            document.activeElement !== focusIntent.owner
          ) {
            rollback()
            reject()
            return
          }
          const activeRequest = request.tabs.find(
            ({ tab }) => tab.id === request.activeTabId
          )
          if (activeRequest?.initialCursor) controller.focus()
          else controller.focusSurface()
          const accepted = controller.view.hasFocus && document.hasFocus()
          if (!accepted) {
            rollback()
          } else if (replaceTabId !== undefined) {
            clearScratchSaveTimer(replaceTabId)
            tabsRef.current.delete(replaceTabId)
            setDescriptors(
              tabDescriptorsRef.current.filter(
                (descriptor) => descriptor.id !== replaceTabId
              )
            )
          }
          window.pulseMd.acknowledgeCliTabsOpen({
            requestId: request.requestId,
            accepted,
          })
        })
      } catch (error) {
        rollback()
        console.error("Failed to accept CLI tabs", error)
        reject()
      }
    },
    [
      activateLocalTab,
      captureTabFocusIntent,
      clearScratchSaveTimer,
      setControllerReadOnlyRespectingLocks,
      setDescriptors,
    ]
  )

  const markActiveDirty = React.useCallback(
    (mapNavigationLocation: MarkdownNavigationLocationMapper) => {
      if (firstDocumentChangePendingRef.current) {
        firstDocumentChangePendingRef.current = false
        performance.mark("pmd:first-document-change")
      }
      const controller = controllerRef.current
      const tabId = activeTabIdRef.current
      const tab = tabId ? tabsRef.current.get(tabId) : undefined
      if (!controller || !tab) return
      mapNavigationHistoryForTab(
        tab.id,
        tab.navigationDocumentId,
        mapNavigationLocation
      )
      tab.revision += 1
      const dirty = !controller.view.state.doc.eq(tab.cleanDocument)
      if (tab.backing === "scratch") {
        if (dirty) {
          scheduleScratchSave(
            tab.id,
            scratchAutosaveDelay(controller.view.state.doc.length)
          )
        } else {
          clearScratchSaveTimer(tab.id)
          scratchSaveFailureCountsRef.current.delete(tab.id)
          setScratchSaveFailed(tab.id, false)
        }
      }
      if (tab.dirty === dirty) return
      tab.dirty = dirty
      updateDescriptor(tab.id, { dirty })
      window.pulseMd.setDirty(tab.id, dirty)
    },
    [
      clearScratchSaveTimer,
      mapNavigationHistoryForTab,
      scheduleScratchSave,
      setScratchSaveFailed,
      updateDescriptor,
    ]
  )

  const applyExternalDocumentChange = React.useCallback(
    (change: ExternalDocumentChange) => {
      let applied = false
      try {
        const controller = controllerRef.current
        const tab = tabsRef.current.get(change.tabId)
        if (
          !controller ||
          !tab ||
          tab.dirty ||
          tab.document.filePath !== change.document.filePath ||
          tab.document.mtimeMs !== change.expectedMtimeMs
        ) {
          return
        }

        if (activeTabIdRef.current === tab.id) syncActiveSession()
        if (
          !controller.replaceSessionDocument(
            tab.editor,
            change.document.content
          )
        ) {
          return
        }

        tab.revision += 1
        invalidateNavigationHistoryForTab(tab.id, tab.navigationDocumentId)
        tab.navigationDocumentId = crypto.randomUUID()
        tab.editor.revision = tab.revision
        tab.editor.documentKind = change.document.kind
        tab.editor.documentPath = change.document.filePath
        tab.cleanDocument = tab.editor.state.doc
        tab.document = documentMetadata(change.document)
        tab.dirty = false
        if (activeTabIdRef.current === tab.id) {
          controller.setDocumentIdentity(
            change.document.filePath,
            change.document.kind
          )
          window.document.title = change.document.displayName
          updateStatus()
        }
        applied = true
      } catch (error) {
        console.error("Unable to apply an external document change", error)
      } finally {
        window.pulseMd.acknowledgeExternalDocumentChange(
          change.changeId,
          applied
        )
      }
    },
    [invalidateNavigationHistoryForTab, syncActiveSession, updateStatus]
  )

  const saveTab = React.useCallback(
    async (
      tabId: TabId,
      saveAs = false,
      trigger: SaveTrigger = "explicit",
      saveAsScratch = false
    ) => {
      const controller = controllerRef.current
      const tab = tabsRef.current.get(tabId)
      if (!controller || !tab) return false
      if (trigger !== "scratch-autosave") clearScratchSaveTimer(tabId)
      if (activeTabIdRef.current === tabId) syncActiveSession()

      const scratchSave = tab.backing === "scratch"
      const scratchCoordination = scratchSave
        ? (scratchSaveCoordinationsRef.current.get(tabId) ??
          ({
            autosavePromise: null,
            generation: 0,
            handledGeneration: 0,
            inFlightCount: 0,
          } satisfies ScratchSaveCoordination))
        : null
      if (scratchCoordination) {
        scratchSaveCoordinationsRef.current.set(tabId, scratchCoordination)
      }
      if (scratchCoordination && trigger === "scratch-autosave") {
        if (!tab.dirty) {
          scratchCoordination.handledGeneration = scratchCoordination.generation
          return false
        }
        if (scratchCoordination.autosavePromise) {
          return scratchCoordination.autosavePromise
        }
        if (scratchCoordination.inFlightCount > 0) {
          return false
        }
        scratchCoordination.handledGeneration = scratchCoordination.generation
      }

      const savedDocument = tab.editor.state.doc
      const contentToSave = savedDocument.toString()
      const savedRevision = tab.revision
      let persisted = false
      const scheduleScratchRetry = () => {
        if (
          trigger === "explicit" ||
          tabsRef.current.get(tabId) !== tab ||
          tab.backing !== "scratch" ||
          !tab.dirty
        ) {
          return
        }
        const failures = Math.min(
          (scratchSaveFailureCountsRef.current.get(tabId) ?? 0) + 1,
          6
        )
        scratchSaveFailureCountsRef.current.set(tabId, failures)
        if (failures >= SCRATCH_AUTOSAVE_FAILURE_NOTICE_THRESHOLD) {
          setScratchSaveFailed(tabId, true)
        }
        scheduleScratchSave(
          tabId,
          Math.min(SCRATCH_AUTOSAVE_RETRY_MAX_MS, 1_000 * 2 ** (failures - 1))
        )
      }

      const persist = async () => {
        let result
        try {
          result = await window.pulseMd.saveDocument({
            automatic: trigger !== "explicit",
            tabId,
            content: contentToSave,
            filePath: tab.document.filePath,
            format: tab.document.format,
            revision: savedRevision,
            saveAs,
            saveAsScratch,
          })
        } catch (error) {
          scheduleScratchRetry()
          throw error
        }
        if (result === null) {
          scheduleScratchRetry()
          return false
        }
        persisted = true
        if (scratchSave) {
          scratchSaveFailureCountsRef.current.delete(tabId)
          setScratchSaveFailed(tabId, false)
        }

        let current = false
        try {
          if (tabsRef.current.get(tabId) !== tab) return false
          const savedMetadata = result.document
          const savedDescriptor = result.tab
          updateNavigationHistoryPath(
            tab.id,
            tab.navigationDocumentId,
            savedDescriptor.filePath
          )
          tab.backing = savedDescriptor.backing
          tab.color = savedDescriptor.color
          tab.document = {
            ...savedMetadata,
            displayName: savedDescriptor.displayName,
            filePath: savedDescriptor.filePath,
          }
          if (savedDescriptor.backing !== "scratch") {
            clearScratchSaveTimer(tabId)
            setScratchSaveFailed(tabId, false)
          }
          if (activeTabIdRef.current === tabId) {
            controller.setDocumentIdentity(
              savedDescriptor.filePath,
              savedDescriptor.kind
            )
            enableOptionalLivePreviewForDocument(
              controller,
              settingsRef.current.markdownExtensions,
              savedDescriptor.kind
            )
            prepareFormattingToolbarForDocument(savedDescriptor.kind)
            if (
              savedDescriptor.kind === "markdown" &&
              settingsRef.current.chrome.showFormattingBar
            ) {
              setTopDrawerCompensated(shouldCompensateTopDrawer())
            } else if (savedDescriptor.kind === "plain-text") {
              outlineOpenRef.current = false
              setOutlineOpen(false)
            }
          }
          tab.editor.documentPath = savedDescriptor.filePath
          tab.editor.documentKind = savedDescriptor.kind
          const currentDocument =
            activeTabIdRef.current === tabId
              ? controller.view.state.doc
              : tab.editor.state.doc
          current =
            result.revision === savedRevision &&
            tab.revision === savedRevision &&
            currentDocument.eq(savedDocument)
          tab.cleanDocument = current ? currentDocument : savedDocument
          tab.dirty = !current
          updateDescriptor(tab.id, {
            backing: savedDescriptor.backing,
            color: savedDescriptor.color,
            dirty: !current,
            displayName: savedDescriptor.displayName,
            fileMissing: savedDescriptor.fileMissing,
            filePath: savedDescriptor.filePath,
            kind: savedDescriptor.kind,
            scratchId: savedDescriptor.scratchId,
          })
          if (!current) window.pulseMd.setDirty(tab.id, true)
          if (activeTabIdRef.current === tab.id) {
            window.document.title = savedDescriptor.displayName
            updateStatus()
          }
          return current
        } finally {
          window.pulseMd.acknowledgeDocumentSave({
            current,
            revision: result.revision,
            saveToken: result.saveToken,
            tabId,
          })
        }
      }

      if (!scratchCoordination) return persist()

      const coordinatedPersist = async () => {
        scratchCoordination.inFlightCount += 1
        try {
          return await persist()
        } finally {
          scratchCoordination.inFlightCount -= 1
          if (
            trigger === "scratch-autosave" &&
            scratchCoordination.autosavePromise !== null
          ) {
            scratchCoordination.autosavePromise = null
          }

          const currentTab = tabsRef.current.get(tabId)
          if (
            trigger === "explicit" &&
            !persisted &&
            currentTab === tab &&
            tab.backing === "scratch" &&
            tab.dirty &&
            !scratchSaveTimersRef.current.has(tabId)
          ) {
            scheduleScratchSave(
              tabId,
              scratchAutosaveDelay(tab.editor.state.doc.length)
            )
          }
          if (
            scratchCoordination.inFlightCount === 0 &&
            scratchCoordination.autosavePromise === null &&
            currentTab === tab &&
            tab.backing === "scratch" &&
            tab.dirty &&
            scratchCoordination.handledGeneration <
              scratchCoordination.generation &&
            !scratchSaveTimersRef.current.has(tabId)
          ) {
            scheduleScratchSave(
              tabId,
              scratchAutosaveDelay(tab.editor.state.doc.length)
            )
          }
          if (
            scratchCoordination.inFlightCount === 0 &&
            scratchCoordination.autosavePromise === null &&
            !scratchSaveTimersRef.current.has(tabId) &&
            scratchCoordination.handledGeneration >=
              scratchCoordination.generation
          ) {
            scratchSaveCoordinationsRef.current.delete(tabId)
          }
        }
      }
      const savePromise = coordinatedPersist()
      if (trigger === "scratch-autosave") {
        scratchCoordination.autosavePromise = savePromise
      }
      return savePromise
    },
    [
      clearScratchSaveTimer,
      prepareFormattingToolbarForDocument,
      scheduleScratchSave,
      setScratchSaveFailed,
      shouldCompensateTopDrawer,
      syncActiveSession,
      updateNavigationHistoryPath,
      updateDescriptor,
      updateStatus,
    ]
  )
  React.useLayoutEffect(() => {
    saveTabRef.current = saveTab
  }, [saveTab])

  const acceptLinkedDocument = React.useCallback(
    async (
      opened: BootstrapTab,
      snapshot: WindowTabsSnapshot,
      navigationDocumentId?: string
    ) => {
      const controller = controllerRef.current
      if (!controller) return false
      const next = rendererTabFromBootstrap(
        controller,
        opened,
        settingsRef.current.initialEditorMode,
        settingsRef.current.lineWrapping,
        navigationDocumentId
      )
      const replacingActive = activeTabIdRef.current === next.id
      tabsRef.current.set(next.id, next)

      let activated: boolean
      if (replacingActive) {
        resetSearchForTabChange()
        activated = controller.activateSession(next.editor)
        if (!activated) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
          if (tabsRef.current.get(next.id) === next) {
            activated = controller.activateSession(next.editor)
          }
        }
        if (activated) {
          setControllerReadOnlyRespectingLocks(controller, false, next.id)
          enableOptionalLivePreviewForDocument(
            controller,
            settingsRef.current.markdownExtensions,
            next.document.kind
          )
          prepareFormattingToolbarForDocument(next.document.kind)
          window.pulseMd.reportLineWrapping(controller.getLineWrapping())
          if (
            next.document.kind === "markdown" &&
            settingsRef.current.chrome.showFormattingBar
          ) {
            setTopDrawerCompensated(shouldCompensateTopDrawer())
          }
          controller.clearSearch()
          window.document.title = next.document.displayName
          updateStatus()
          requestAnimationFrame(() => controller.focusSurface())
        }
      } else {
        activated = activateLocalTab(
          next.id,
          false,
          captureTabFocusIntent("editor")
        )
      }

      applyTabsSnapshot(snapshot)
      return activated
    },
    [
      activateLocalTab,
      applyTabsSnapshot,
      captureTabFocusIntent,
      prepareFormattingToolbarForDocument,
      resetSearchForTabChange,
      setControllerReadOnlyRespectingLocks,
      shouldCompensateTopDrawer,
      updateStatus,
    ]
  )

  const locateDocument = React.useCallback(
    async (tabId: TabId) => {
      const tab = syncActiveSession()
      if (!tab || tab.id !== tabId) return false
      const releaseDocumentOpenLease = beginDocumentOpenLease()
      try {
        const result = await window.pulseMd.locateDocument(tabId)
        if (!result || tabsRef.current.get(tabId) !== tab) return false
        invalidateNavigationHistoryForTab(tabId, tab.navigationDocumentId)
        return await acceptLinkedDocument(
          { ...result.openedTab, initialEditorMode: tab.editor.mode },
          result.window
        )
      } finally {
        releaseDocumentOpenLease()
      }
    },
    [
      acceptLinkedDocument,
      beginDocumentOpenLease,
      invalidateNavigationHistoryForTab,
      syncActiveSession,
    ]
  )

  const requestLocalLink = React.useCallback(
    async (
      sourceTabId: TabId,
      destination: string,
      fragment: string | null,
      disposition: LocalLinkDisposition
    ) => {
      let result = await window.pulseMd.openLocalLink(
        sourceTabId,
        destination,
        fragment,
        disposition
      )
      if (result?.kind !== "save-required") return result
      if (!(await saveTab(sourceTabId))) return null
      result = await window.pulseMd.openLocalLink(
        sourceTabId,
        destination,
        fragment,
        disposition
      )
      return result?.kind === "save-required" ? null : result
    },
    [saveTab]
  )

  const newTab = React.useCallback(async () => {
    if (softwareLicensesOpenRef.current) return
    const controller = controllerRef.current
    if (!controller) return
    syncActiveSession()
    const result = await window.pulseMd.newTab()
    const created = result.createdTab
    tabsRef.current.set(
      created.tab.id,
      rendererTabFromBootstrap(
        controller,
        created,
        settingsRef.current.initialEditorMode,
        settingsRef.current.lineWrapping
      )
    )
    applyTabsSnapshot(result.window, "editor")
  }, [applyTabsSnapshot, syncActiveSession])

  const acceptOpenedDocuments = React.useCallback(
    (result: OpenDocumentResult) => {
      const controller = controllerRef.current
      if (!controller) return
      if (result.replacedTabId) {
        clearScratchSaveTimer(result.replacedTabId)
        tabsRef.current.delete(result.replacedTabId)
      }
      for (const opened of result.openedTabs) {
        tabsRef.current.set(
          opened.tab.id,
          rendererTabFromBootstrap(
            controller,
            opened,
            settingsRef.current.initialEditorMode,
            settingsRef.current.lineWrapping
          )
        )
      }
      applyTabsSnapshot(result.window, "editor")
    },
    [applyTabsSnapshot, clearScratchSaveTimer]
  )

  const acceptScratchOpen = React.useCallback(
    async (result: Awaited<ReturnType<typeof window.pulseMd.openScratch>>) => {
      if (!result) return false
      if (result.kind === "existing-document") {
        if (result.location === "other-window") return true
        return activateTab(result.tabId, true, "editor")
      }
      acceptOpenedDocuments({
        openedTabs: [result.openedTab],
        replacedTabId: result.replacedTabId,
        window: result.window,
      })
      return true
    },
    [acceptOpenedDocuments, activateTab]
  )

  const openScratchById = React.useCallback(
    async (scratchId: string, disposition: "default" | "new-tab") => {
      const controller = controllerRef.current
      if (!controller) {
        throw new Error("Return to the editor and try again.")
      }
      syncActiveSession()
      const result = await window.pulseMd.openScratch(scratchId, disposition)
      if (!(await acceptScratchOpen(result))) {
        throw new Error(
          "The scratch could not be opened. Refresh the list and try again."
        )
      }
    },
    [acceptScratchOpen, syncActiveSession]
  )

  const createScratch = React.useCallback(async () => {
    const controller = controllerRef.current
    if (!controller) return false
    syncActiveSession()
    const result = await window.pulseMd.newScratch()
    return await acceptScratchOpen(result)
  }, [acceptScratchOpen, syncActiveSession])

  const createScratchFromSettings = React.useCallback(async () => {
    if (!(await createScratch())) {
      throw new Error("The scratch could not be created. Try again.")
    }
  }, [createScratch])

  const setScratchBrowserVisibility = React.useCallback(
    (open: boolean) => {
      scratchBrowserOpenRef.current = open
      setScratchBrowserOpen(open)
      reportEditorMenuState()
      if (!open) {
        window.requestAnimationFrame(() =>
          controllerRef.current?.focusSurface()
        )
      }
    },
    [reportEditorMenuState]
  )

  const openScratchBrowser = React.useCallback(() => {
    if (
      settingsOpenRef.current ||
      settingsWorkspaceOpenRef.current ||
      softwareLicensesOpenRef.current ||
      scratchBrowserOpenRef.current
    ) {
      return
    }
    outlineOpenRef.current = false
    setOutlineOpen(false)
    controllerRef.current?.clearSearch()
    setSearchOpen(false)
    setScratchBrowserVisibility(true)
  }, [setScratchBrowserVisibility])

  const openDocument = React.useCallback(async () => {
    if (softwareLicensesOpenRef.current) return
    const controller = controllerRef.current
    if (!controller) return
    const active = syncActiveSession()
    if (!active) return
    const disposable =
      active.backing === "untitled" &&
      !active.dirty &&
      active.editor.state.doc.length === 0
    const releaseDocumentOpenLease = beginDocumentOpenLease()
    try {
      const result = await window.pulseMd.openDocument(disposable)
      if (result) acceptOpenedDocuments(result)
    } finally {
      releaseDocumentOpenLease()
    }
  }, [acceptOpenedDocuments, beginDocumentOpenLease, syncActiveSession])

  const openDroppedDocuments = React.useCallback(
    async (files: readonly File[]) => {
      if (
        files.length === 0 ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        return
      }
      const controller = controllerRef.current
      if (!controller) return
      const active = syncActiveSession()
      if (!active) return
      const disposable =
        active.backing === "untitled" &&
        !active.dirty &&
        active.editor.state.doc.length === 0
      const releaseDocumentOpenLease = beginDocumentOpenLease()
      try {
        const result = await window.pulseMd.openDroppedDocuments(
          files,
          disposable
        )
        if (result) acceptOpenedDocuments(result)
      } finally {
        releaseDocumentOpenLease()
      }
    },
    [acceptOpenedDocuments, beginDocumentOpenLease, syncActiveSession]
  )

  React.useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer &&
      Array.from(event.dataTransfer.types).includes("Files")
    const handleDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const handleDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      const files = event.dataTransfer
        ? Array.from(event.dataTransfer.files)
        : []
      void openDroppedDocuments(files)
    }

    window.addEventListener("dragover", handleDragOver, true)
    window.addEventListener("drop", handleDrop, true)
    return () => {
      window.removeEventListener("dragover", handleDragOver, true)
      window.removeEventListener("drop", handleDrop, true)
    }
  }, [openDroppedDocuments])

  const navigateDocumentHistory = React.useCallback(
    async (direction: "back" | "forward") => {
      const navigate = async () => {
        if (settingsOpenRef.current || settingsWorkspaceOpenRef.current) {
          return false
        }
        const controller = controllerRef.current
        const originalTabId = activeTabIdRef.current
        const originalTab = originalTabId
          ? tabsRef.current.get(originalTabId)
          : undefined
        if (!controller || !originalTabId || !originalTab) return false

        const source =
          direction === "back"
            ? navigationBackRef.current
            : navigationForwardRef.current
        const destination =
          direction === "back"
            ? navigationForwardRef.current
            : navigationBackRef.current
        let target: DocumentNavigationEntry | undefined
        while (source.length > 0) {
          const candidate = source.pop()!
          const candidateTab = tabsRef.current.get(candidate.tabId)
          if (
            candidateTab &&
            (candidateTab.navigationDocumentId === candidate.documentId ||
              candidate.filePath !== null)
          ) {
            target = candidate
            break
          }
        }
        if (!target) {
          publishNavigationAvailability()
          return false
        }

        const current: DocumentNavigationEntry = {
          documentId: originalTab.navigationDocumentId,
          filePath: originalTab.document.filePath,
          tabId: originalTabId,
          location: controller.captureNavigationLocation(),
        }
        const restoreOriginalTab = async () => {
          if (
            activeTabIdRef.current !== originalTabId &&
            tabsRef.current.has(originalTabId)
          ) {
            await activateTab(originalTabId, true, "preserve")
            controller.restoreNavigationLocation(current.location)
          }
        }

        if (
          target.tabId !== originalTabId &&
          !(await activateTab(target.tabId, true, "preserve"))
        ) {
          source.push(target)
          publishNavigationAvailability()
          return false
        }

        let targetTab = tabsRef.current.get(target.tabId)
        if (!targetTab) {
          await restoreOriginalTab()
          source.push(target)
          publishNavigationAvailability()
          return false
        }
        if (targetTab.navigationDocumentId !== target.documentId) {
          if (!target.filePath) {
            await restoreOriginalTab()
            source.push(target)
            publishNavigationAvailability()
            return false
          }
          syncActiveSession()
          const releaseDocumentOpenLease = beginDocumentOpenLease()
          try {
            const result = await requestLocalLink(
              target.tabId,
              target.filePath,
              null,
              "current-tab"
            )
            if (target.tabId === originalTabId) {
              const refreshedCurrent = tabsRef.current.get(originalTabId)
              if (
                refreshedCurrent?.navigationDocumentId === current.documentId
              ) {
                current.filePath = refreshedCurrent.document.filePath
              }
            }
            if (
              !result ||
              result.kind !== "document" ||
              result.disposition !== "current-tab" ||
              !(await acceptLinkedDocument(
                result.openedTab,
                result.window,
                target.documentId
              ))
            ) {
              await restoreOriginalTab()
              source.push(target)
              publishNavigationAvailability()
              return false
            }
            targetTab = tabsRef.current.get(target.tabId)
          } finally {
            releaseDocumentOpenLease()
          }
        }

        if (
          !targetTab ||
          targetTab.navigationDocumentId !== target.documentId ||
          !controller.restoreNavigationLocation(target.location)
        ) {
          source.push(target)
          publishNavigationAvailability()
          return false
        }

        destination.push(current)
        if (destination.length > DOCUMENT_NAVIGATION_HISTORY_LIMIT) {
          destination.splice(
            0,
            destination.length - DOCUMENT_NAVIGATION_HISTORY_LIMIT
          )
        }
        publishNavigationAvailability()
        return true
      }

      const completion = localNavigationQueueRef.current.then(
        navigate,
        navigate
      )
      localNavigationQueueRef.current = completion.then(
        () => undefined,
        () => undefined
      )
      return completion
    },
    [
      acceptLinkedDocument,
      activateTab,
      beginDocumentOpenLease,
      publishNavigationAvailability,
      requestLocalLink,
      syncActiveSession,
    ]
  )

  const openLink = React.useCallback(
    async (
      activation: MarkdownLinkActivation,
      disposition: LocalLinkDisposition = "new-tab"
    ) => {
      if (activation.kind === "external") {
        await window.pulseMd.openExternalLink(activation.href)
        return
      }
      if (activation.kind === "fragment") {
        const controller = controllerRef.current
        if (activation.fragment) controller?.jumpToHeading(activation.fragment)
        else controller?.jumpToFragment("#")
        return
      }

      const requestedSourceTabId = activeTabIdRef.current
      const originController = controllerRef.current
      const originTab = requestedSourceTabId
        ? tabsRef.current.get(requestedSourceTabId)
        : undefined
      if (!requestedSourceTabId || !originController || !originTab) return
      const origin: DocumentNavigationEntry = {
        documentId: originTab.navigationDocumentId,
        filePath: originTab.document.filePath,
        location: originController.captureNavigationLocation(),
        tabId: originTab.id,
      }
      syncActiveSession()
      const navigate = async () => {
        if (
          !tabsRef.current.has(requestedSourceTabId) ||
          (disposition === "current-tab" &&
            activeTabIdRef.current !== requestedSourceTabId)
        ) {
          return
        }

        const pending: PendingLocalNavigation | null =
          disposition === "current-tab" && activation.kind === "local"
            ? {
                ...origin,
                valid: true,
              }
            : null
        pendingLocalNavigationRef.current = pending
        const releaseDocumentOpenLease = pending
          ? beginDocumentOpenLease()
          : null
        try {
          const result =
            activation.kind === "scratch"
              ? await window.pulseMd.openScratchLink(
                  requestedSourceTabId,
                  activation.identity,
                  activation.fragment,
                  activation.scheme
                )
              : await requestLocalLink(
                  requestedSourceTabId,
                  activation.destination,
                  activation.fragment,
                  disposition
                )
          if (!result) return
          if (result.kind === "existing-document") {
            if (result.location === "other-window") return
            const alreadyActive = result.tabId === activeTabIdRef.current
            if (
              !alreadyActive &&
              !(await activateTab(result.tabId, true, "editor"))
            ) {
              return
            }
            const sameDocument = result.tabId === origin.tabId
            if (!sameDocument) rememberNavigationEntry(origin)
            const activeController = controllerRef.current
            if (activation.fragment !== null) {
              if (activation.fragment) {
                activeController?.jumpToHeading(activation.fragment, {
                  recordHistory: sameDocument,
                })
              } else {
                activeController?.jumpToFragment("#", {
                  recordHistory: sameDocument,
                })
              }
            }
            return
          }
          if (result.kind !== "document") return
          if (!(await acceptLinkedDocument(result.openedTab, result.window))) {
            return
          }
          if (
            pending?.valid &&
            pending.filePath !== null &&
            result.disposition === "current-tab" &&
            tabsRef.current.has(pending.tabId)
          ) {
            rememberNavigationEntry(pending)
          } else if (result.disposition === "new-tab") {
            rememberNavigationEntry(origin)
          }

          if (activation.fragment !== null) {
            const activeController = controllerRef.current
            if (activation.fragment) {
              activeController?.jumpToHeading(activation.fragment, {
                recordHistory: false,
              })
            } else {
              activeController?.jumpToFragment("#", { recordHistory: false })
            }
          }
        } finally {
          releaseDocumentOpenLease?.()
          if (pendingLocalNavigationRef.current === pending) {
            pendingLocalNavigationRef.current = null
          }
        }
      }

      const completion = localNavigationQueueRef.current.then(
        navigate,
        navigate
      )
      localNavigationQueueRef.current = completion.then(
        () => undefined,
        () => undefined
      )
      await completion
    },
    [
      acceptLinkedDocument,
      activateTab,
      beginDocumentOpenLease,
      rememberNavigationEntry,
      requestLocalLink,
      syncActiveSession,
    ]
  )

  const openLinkInNewTab = React.useCallback(
    (activation: MarkdownLinkActivation) => openLink(activation, "new-tab"),
    [openLink]
  )

  const copyEditorLink = React.useCallback(
    (activation: MarkdownLinkActivation) => {
      if (activation.kind === "fragment") {
        const activeId = activeTabIdRef.current
        if (!activeId) {
          return Promise.reject(new Error("No active document is available"))
        }
        return window.pulseMd.copyHeadingLink(activeId, activation.fragment)
      }
      return window.pulseMd.copyEditorLink(editorLinkAddress(activation))
    },
    []
  )

  const handleOpenExistingLocalLinkRequest = React.useCallback(
    (request: OpenExistingLocalLinkRequest) => {
      const navigate = async () => {
        if (
          !rendererReadyRef.current ||
          settingsOpenRef.current ||
          settingsWorkspaceOpenRef.current ||
          softwareLicensesOpenRef.current ||
          closingTabsRef.current.size > 0 ||
          !tabsRef.current.has(request.tabId)
        ) {
          return
        }
        if (
          activeTabIdRef.current !== request.tabId &&
          !(await activateTab(request.tabId, true, "editor"))
        ) {
          return
        }

        const controller = controllerRef.current
        if (request.fragment === null) {
          controller?.focusSurface()
        } else if (request.fragment) {
          controller?.jumpToHeading(request.fragment)
        } else {
          controller?.jumpToFragment("#")
        }
      }

      const completion = localNavigationQueueRef.current.then(
        navigate,
        navigate
      )
      localNavigationQueueRef.current = completion.then(
        () => undefined,
        () => undefined
      )
    },
    [activateTab]
  )

  const closeTab = React.useCallback(
    async (tabId: TabId) => {
      if (closingTabsRef.current.has(tabId)) return
      closingTabsRef.current.add(tabId)
      try {
        const decision = await window.pulseMd.requestCloseTab(tabId)
        if (decision === "cancel") return
        if (decision === "save" && !(await saveTab(tabId))) return
        if (activeTabIdRef.current === tabId) syncActiveSession()
        const closingTab = tabsRef.current.get(tabId)
        const viewport = closingTab?.editor.viewportInitialized
          ? { ...closingTab.editor.viewport }
          : null
        const snapshot = await window.pulseMd.finalizeCloseTab(tabId, viewport)
        if (!snapshot) return
        clearScratchSaveTimer(tabId)
        tabsRef.current.delete(tabId)
        applyTabsSnapshot(snapshot)
      } finally {
        closingTabsRef.current.delete(tabId)
      }
    },
    [applyTabsSnapshot, clearScratchSaveTimer, saveTab, syncActiveSession]
  )

  const openSearch = React.useCallback(
    (change?: Partial<SearchUiState>, navigate?: "next" | "previous") => {
      if (
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        return
      }
      searchVisibilityRevisionRef.current += 1
      if (change) {
        enqueueSearchHandoff(searchHandoffQueue, {
          change,
          synchronize: true,
          type: "configure",
        })
      }
      if (navigate) {
        enqueueSearchHandoff(searchHandoffQueue, {
          direction: navigate,
          type: "navigate",
        })
      }
      outlineOpenRef.current = false
      setOutlineOpen(false)
      setSearchActivated(true)
      void prepareSearchOverlay().catch(() => undefined)
      setSearchOpen(true)
      setSearchFocusRequest((request) => request + 1)
    },
    [searchHandoffQueue]
  )

  const findAgain = React.useCallback(
    (direction: "next" | "previous") => {
      const controller = controllerRef.current
      const found =
        direction === "next"
          ? controller?.findNext()
          : controller?.findPrevious()
      if (found) return
      const overlay = searchOverlayRef.current
      if (searchOpen && overlay) overlay.navigate(direction)
      else openSearch(undefined, direction)
    },
    [openSearch, searchOpen]
  )

  const findUsingSelection = React.useCallback(() => {
    const query = controllerRef.current?.getSelectedText() ?? ""
    if (!query) return
    openSearch({ query, regexp: false })
  }, [openSearch])

  const closeSearch = React.useCallback(() => {
    const visibilityRevision = ++searchVisibilityRevisionRef.current
    clearSearchHandoff(searchHandoffQueue)
    controllerRef.current?.clearSearch()
    setSearchOpen(false)
    requestAnimationFrame(() => {
      if (searchVisibilityRevisionRef.current === visibilityRevision) {
        controllerRef.current?.focusSurface()
      }
    })
  }, [searchHandoffQueue])

  const closeOutline = React.useCallback(() => {
    outlineOpenRef.current = false
    setOutlineOpen(false)
  }, [])

  const openOutline = React.useCallback(() => {
    if (
      !rendererReadyRef.current ||
      settingsOpenRef.current ||
      settingsWorkspaceOpenRef.current ||
      softwareLicensesOpenRef.current ||
      outlineOpenRef.current
    ) {
      return
    }
    const controller = controllerRef.current
    const activeId = activeTabIdRef.current
    const tab = activeId ? tabsRef.current.get(activeId) : undefined
    if (!controller || tab?.document.kind !== "markdown") return
    controller.clearSearch()
    setSearchOpen(false)
    const headings = controller.getHeadings()
    setOutlineHeadings(headings)
    setOutlineActiveSlug(controller.getCurrentHeading()?.slug ?? null)
    outlineOpenRef.current = true
    setOutlineOpen(true)
  }, [])

  const closeSettings = React.useCallback(() => {
    settingsOpenRef.current = false
    setSettingsOpen(false)
    setWindowProfilesWorkspace(null)
    setScratchesWorkspace(null)
    resetSettingsNavigationHistory()
    window.pulseMd.releaseSettingsSession()
    if (settingsReturnFocusRef.current) {
      requestAnimationFrame(() => controllerRef.current?.focusSurface())
    }
    settingsReturnFocusRef.current = false
  }, [resetSettingsNavigationHistory])

  const openSettings = React.useCallback(async (): Promise<boolean> => {
    if (
      !rendererReadyRef.current ||
      settingsOpeningRef.current ||
      settingsOpenRef.current ||
      settingsWorkspaceOpenRef.current ||
      softwareLicensesOpenRef.current ||
      scratchBrowserOpenRef.current
    ) {
      return false
    }
    settingsOpeningRef.current = true
    try {
      if (!(await window.pulseMd.acquireSettingsSession())) return false
      if (
        !rendererReadyRef.current ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        window.pulseMd.releaseSettingsSession()
        return false
      }
      closeOutline()
      settingsReturnFocusRef.current =
        controllerRef.current?.view.hasFocus ?? false
      const dialogSettings = cloneAppSettings(persistedSettingsRef.current)
      if (windowZoomFactorRef.current !== null) {
        dialogSettings.zoomFactor = windowZoomFactorRef.current
      }
      setSettingsDialogSettings(dialogSettings)
      settingsDialogBaseRef.current = cloneAppSettings(dialogSettings)
      settingsDialogDraftRef.current = cloneAppSettings(dialogSettings)
      setSettingsSession((session) => session + 1)
      setWindowProfilesWorkspace(null)
      setScratchesWorkspace(null)
      resetSettingsNavigationHistory()
      settingsOpenRef.current = true
      setSettingsOpen(true)
      return true
    } catch (error) {
      console.error("Unable to open Settings", error)
      window.pulseMd.releaseSettingsSession()
      return false
    } finally {
      settingsOpeningRef.current = false
    }
  }, [closeOutline, resetSettingsNavigationHistory])

  const cancelSettings = React.useCallback(() => {
    setTopDrawerCompensated(
      settingsRef.current.chrome.showFormattingBar &&
        currentDocumentKind() === "markdown" &&
        shouldCompensateTopDrawer()
    )
    acceptSettings(settingsRef.current, undefined, true)
    window.pulseMd.previewAppearance(null)
    window.pulseMd.previewWindowZoom(settingsRef.current.zoomFactor)
    closeSettings()
  }, [
    acceptSettings,
    closeSettings,
    currentDocumentKind,
    shouldCompensateTopDrawer,
  ])

  const saveSettings = React.useCallback(
    async (
      nextSettings: AppSettings,
      strategy: "merge" | "replace" = "merge",
      settingsImport?: {
        importId: string
        options: SettingsTransferOptions
      }
    ) => {
      const settingsToSave =
        strategy === "replace"
          ? cloneAppSettings(nextSettings)
          : rebaseSettingsDraft(
              settingsDialogBaseRef.current,
              nextSettings,
              persistedSettingsRef.current
            )
      const savedSettings = settingsImport
        ? await window.pulseMd.commitSettingsImport(
            settingsImport.importId,
            settingsToSave,
            settingsImport.options
          )
        : await window.pulseMd.setSettings(settingsToSave)
      acceptSettings(savedSettings.effective, savedSettings.persisted, true)
      if (savedSettings.effective.spellCheck) {
        controllerRef.current?.refreshSpellCheck()
      }
      closeSettings()
    },
    [acceptSettings, closeSettings]
  )

  const openWindowProfilePicker = React.useCallback(() => {
    if (
      !rendererReadyRef.current ||
      settingsOpenRef.current ||
      settingsWorkspaceOpenRef.current ||
      softwareLicensesOpenRef.current ||
      windowProfilePickerOpenRef.current ||
      windowProfileCaptureOpenRef.current
    ) {
      return false
    }
    closeOutline()
    controllerRef.current?.clearSearch()
    setSearchOpen(false)
    windowProfilePickerOpenRef.current = true
    windowProfilePickerRequestIdRef.current = null
    windowProfilePickerSettingsDraftRef.current = null
    setWindowProfilePicker({ parent: "surface", requestId: null })
    return true
  }, [closeOutline])

  const closeWindowProfilePicker = React.useCallback(() => {
    const requestId = windowProfilePickerRequestIdRef.current
    const openedFromSettings =
      windowProfilePickerSettingsDraftRef.current !== null
    windowProfilePickerRequestIdRef.current = null
    windowProfilePickerSettingsDraftRef.current = null
    windowProfilePickerOpenRef.current = false
    setWindowProfilePicker(null)
    if (requestId) {
      window.pulseMd.completeWindowProfilePicker(requestId, null)
    }
    if (!openedFromSettings) {
      requestAnimationFrame(() => controllerRef.current?.focusSurface())
    }
  }, [])

  const selectWindowProfileFromPicker = React.useCallback(
    async (profileId: string) => {
      const requestId = windowProfilePickerRequestIdRef.current
      const settingsDraft = windowProfilePickerSettingsDraftRef.current
      if (settingsDraft) {
        await saveSettings(settingsDraft)
      }
      windowProfilePickerRequestIdRef.current = null
      windowProfilePickerSettingsDraftRef.current = null
      windowProfilePickerOpenRef.current = false
      setWindowProfilePicker(null)
      if (requestId) {
        window.pulseMd.completeWindowProfilePicker(requestId, profileId)
        return
      }
      // Let the modal restore inert/focus state before a disposable host is
      // transactionally replaced by the selected profile.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      try {
        await window.pulseMd.launchWindowProfile(profileId)
      } catch (error) {
        windowProfilePickerOpenRef.current = true
        windowProfilePickerRequestIdRef.current = null
        windowProfilePickerSettingsDraftRef.current = null
        setWindowProfilePicker({
          initialError:
            error instanceof Error && error.message.trim()
              ? error.message
              : "The selected window profile could not be launched.",
          parent: "surface",
          requestId: null,
        })
        throw error
      }
    },
    [saveSettings]
  )

  const openWindowProfileCapture = React.useCallback(
    (kind: WindowProfileCaptureKind) => {
      if (
        !rendererReadyRef.current ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current
      ) {
        return
      }
      if (kind === "update" && windowProfilesWorkspaceOpenRef.current) return
      syncActiveSession()
      closeOutline()
      controllerRef.current?.clearSearch()
      setSearchOpen(false)
      windowProfileCaptureOpenRef.current = true
      setWindowProfileCaptureTabModes(currentWindowProfileTabModes())
      setWindowProfileCaptureKind(kind)
    },
    [closeOutline, currentWindowProfileTabModes, syncActiveSession]
  )

  const closeWindowProfileCapture = React.useCallback(() => {
    windowProfileCaptureOpenRef.current = false
    setWindowProfileCaptureKind(null)
    requestAnimationFrame(() => controllerRef.current?.focusSurface())
  }, [])

  const reviewCapturedWindowProfile = React.useCallback(
    async (composer: WindowProfileComposerState) => {
      if (!(await openSettings())) {
        throw new Error("Settings are already open in another window.")
      }
      windowProfileCaptureOpenRef.current = false
      setWindowProfileCaptureKind(null)
      openWindowProfiles(persistedSettingsRef.current)
      openWindowProfileComposer(composer)
    },
    [openSettings, openWindowProfileComposer, openWindowProfiles]
  )

  const launchWindowProfileFromSettings = React.useCallback(
    (settingsDraft: AppSettings) => {
      if (
        !rendererReadyRef.current ||
        !settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current
      ) {
        return
      }
      windowProfilePickerOpenRef.current = true
      windowProfilePickerRequestIdRef.current = null
      windowProfilePickerSettingsDraftRef.current =
        cloneAppSettings(settingsDraft)
      setWindowProfilePicker({ parent: "settings", requestId: null })
    },
    []
  )

  const handleWindowProfilePickerRequest = React.useCallback(
    (request: WindowProfilePickerRequest) => {
      if (
        !rendererReadyRef.current ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current
      ) {
        window.pulseMd.completeWindowProfilePicker(request.requestId, null)
        return
      }
      closeOutline()
      controllerRef.current?.clearSearch()
      setSearchOpen(false)
      windowProfilePickerOpenRef.current = true
      windowProfilePickerRequestIdRef.current = request.requestId
      windowProfilePickerSettingsDraftRef.current = null
      setWindowProfilePicker({
        parent: "surface",
        requestId: request.requestId,
      })
    },
    [closeOutline]
  )

  const handleWindowProfilePickerCancellation = React.useCallback(
    (request: WindowProfilePickerRequest) => {
      if (windowProfilePickerRequestIdRef.current !== request.requestId) return
      windowProfilePickerRequestIdRef.current = null
      windowProfilePickerSettingsDraftRef.current = null
      windowProfilePickerOpenRef.current = false
      setWindowProfilePicker(null)
      requestAnimationFrame(() => controllerRef.current?.focusSurface())
    },
    []
  )

  const abortSettingsWorkspaceForWindowClose = React.useCallback(() => {
    if (!settingsWorkspaceOpenRef.current) return true
    if (
      settingsWorkspaceSavePendingRef.current ||
      windowProfileLaunchPendingRef.current ||
      windowProfilesNavigationBlockedRef.current ||
      scratchesNavigationBlockedRef.current
    ) {
      return false
    }
    if (typographyPreview) {
      returnFromTypographyPreview(typographyPreview.parentDraft)
      return true
    }
    if (activeTabIndicatorPreview) {
      returnFromActiveTabIndicatorPreview(activeTabIndicatorPreview.parentDraft)
      return true
    }
    if (launchTransitionPreview) {
      returnFromLaunchTransitionPreview(launchTransitionPreview.parentDraft)
      return true
    }
    if (
      isWindowProfilesSettingsRoute(settingsNavigationRouteRef.current) &&
      windowProfilesWorkspace
    ) {
      return returnFromWindowProfiles()
    }
    if (
      isScratchesSettingsRoute(settingsNavigationRouteRef.current) &&
      scratchesWorkspace
    ) {
      return returnFromScratchesWorkspace()
    }
    return false
  }, [
    activeTabIndicatorPreview,
    launchTransitionPreview,
    returnFromActiveTabIndicatorPreview,
    returnFromLaunchTransitionPreview,
    returnFromTypographyPreview,
    returnFromScratchesWorkspace,
    returnFromWindowProfiles,
    typographyPreview,
    scratchesWorkspace,
    windowProfilesWorkspace,
  ])

  const prepareWindowClose = React.useCallback(async () => {
    let allow = false
    try {
      if (windowProfileCapturePendingRef.current) return
      if (!abortSettingsWorkspaceForWindowClose()) return
      if (!settingsOpenRef.current) {
        allow = true
        return
      }

      const save = settingsSaveHandlerRef.current
      if (save) {
        allow = await save()
      } else {
        await saveSettings(cloneAppSettings(settingsDialogDraftRef.current))
        allow = true
      }
    } catch (error) {
      console.error("Unable to prepare Settings for window close", error)
    } finally {
      window.pulseMd.windowClosePrepared(allow)
    }
  }, [abortSettingsWorkspaceForWindowClose, saveSettings])

  const activateSettingsNavigationRoute = React.useCallback(
    (target: SettingsNavigationRoute) => {
      const current = settingsNavigationRouteRef.current
      const currentIsWindowProfiles = isWindowProfilesSettingsRoute(current)
      const targetIsWindowProfiles = isWindowProfilesSettingsRoute(target)
      const currentIsScratches = isScratchesSettingsRoute(current)
      const targetIsScratches = isScratchesSettingsRoute(target)
      if (
        currentIsWindowProfiles === targetIsWindowProfiles &&
        currentIsScratches === targetIsScratches
      ) {
        return true
      }
      if (currentIsWindowProfiles && !returnFromWindowProfiles()) return false
      if (currentIsScratches && !returnFromScratchesWorkspace()) return false
      if (targetIsWindowProfiles) {
        return Boolean(
          windowProfilesWorkspace &&
          activateWindowProfilesWorkspace(windowProfilesWorkspace)
        )
      }
      if (targetIsScratches) {
        return Boolean(
          scratchesWorkspace && activateScratchesWorkspace(scratchesWorkspace)
        )
      }
      return true
    },
    [
      activateScratchesWorkspace,
      activateWindowProfilesWorkspace,
      returnFromScratchesWorkspace,
      returnFromWindowProfiles,
      scratchesWorkspace,
      windowProfilesWorkspace,
    ]
  )

  const navigateSettingsHistory = React.useCallback(
    (direction: "back" | "forward") => {
      if (
        !settingsOpenRef.current &&
        !windowProfilesWorkspaceOpenRef.current &&
        !scratchesWorkspaceOpenRef.current
      ) {
        return false
      }
      const current = settingsNavigationRouteRef.current
      if (
        isWindowProfilesSettingsRoute(current) &&
        windowProfilesNavigationBlockedRef.current
      ) {
        return false
      }
      if (
        isScratchesSettingsRoute(current) &&
        scratchesNavigationBlockedRef.current
      ) {
        return false
      }
      const history = settingsNavigationHistoryRef.current
      const nextIndex = history.index + (direction === "back" ? -1 : 1)
      const target = history.entries[nextIndex]
      if (!target || !activateSettingsNavigationRoute(target)) return false
      return commitSettingsNavigationHistory({ ...history, index: nextIndex })
    },
    [activateSettingsNavigationRoute, commitSettingsNavigationHistory]
  )

  const navigateAppHistory = React.useCallback(
    (direction: "back" | "forward") => {
      if (
        scratchesWorkspaceOpenRef.current &&
        scratchesWorkspace?.origin !== "settings"
      ) {
        if (direction !== "back" || scratchesNavigationBlockedRef.current) {
          return false
        }
        return returnFromScratchesWorkspace()
      }
      if (
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        return navigateSettingsHistory(direction)
      }
      return navigateDocumentHistory(direction)
    },
    [
      navigateDocumentHistory,
      navigateSettingsHistory,
      returnFromScratchesWorkspace,
      scratchesWorkspace,
    ]
  )

  const focusEditor = React.useCallback(
    (timing: "immediate" | "next-frame" = "next-frame") => {
      if (windowProfileLaunchPendingRef.current) return
      const controller = controllerRef.current
      controller?.clearSearch()
      setSearchOpen(false)
      closeOutline()

      const previewWasOpen = settingsWorkspaceOpenRef.current
      if (previewWasOpen) {
        settingsWorkspaceOpenRef.current = false
        windowProfilesWorkspaceOpenRef.current = false
        scratchesWorkspaceOpenRef.current = false
        windowProfileLaunchPendingRef.current = false
        restoreActiveDocumentSession()
        setActiveTabIndicatorPreview(null)
        setTypographyPreview(null)
        setLaunchTransitionPreview(null)
        setWindowProfilesWorkspace(null)
        setScratchesWorkspace(null)
        resetSettingsNavigationHistory()
      }

      if (previewWasOpen || settingsOpenRef.current) {
        const committedSettings = cloneAppSettings(settingsRef.current)
        acceptSettings(committedSettings, undefined, true)
        window.pulseMd.previewAppearance(null)
        window.pulseMd.previewWindowZoom(committedSettings.zoomFactor)
      }
      settingsOpenRef.current = false
      settingsReturnFocusRef.current = false
      setSettingsOpen(false)
      window.pulseMd.releaseSettingsSession()

      if (timing === "immediate") {
        controllerRef.current?.focusSurface()
      } else {
        requestAnimationFrame(() => controllerRef.current?.focusSurface())
      }
    },
    [
      acceptSettings,
      closeOutline,
      resetSettingsNavigationHistory,
      restoreActiveDocumentSession,
    ]
  )

  const handleCliEditorFocusRequest = React.useCallback(
    async (request: CliEditorFocusRequest) => {
      const reject = () =>
        window.pulseMd.acknowledgeCliEditorFocus({
          requestId: request.requestId,
          accepted: false,
        })
      const controller = controllerRef.current
      if (
        !rendererReadyRef.current ||
        !controller ||
        controller.view.compositionStarted ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        closingTabsRef.current.size > 0
      ) {
        reject()
        return
      }
      const activationFocusIntent = captureTabFocusIntent("preserve")
      if (!(await activateTab(request.tabId, false, "preserve"))) {
        reject()
        return
      }
      if (
        controllerRef.current !== controller ||
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        focusOwnershipRevisionRef.current !== activationFocusIntent.revision ||
        document.activeElement !== activationFocusIntent.owner
      ) {
        reject()
        return
      }

      focusEditor("immediate")
      const completionFocusIntent = captureTabFocusIntent("editor")
      window.requestAnimationFrame(() => {
        if (
          controllerRef.current !== controller ||
          activeTabIdRef.current !== request.tabId ||
          settingsOpenRef.current ||
          settingsWorkspaceOpenRef.current ||
          softwareLicensesOpenRef.current ||
          focusOwnershipRevisionRef.current !==
            completionFocusIntent.revision ||
          document.activeElement !== completionFocusIntent.owner
        ) {
          reject()
          return
        }
        controller.focusSurface()
        window.pulseMd.acknowledgeCliEditorFocus({
          requestId: request.requestId,
          accepted: controller.view.hasFocus && document.hasFocus(),
        })
      })
    },
    [activateTab, captureTabFocusIntent, focusEditor]
  )

  const updateChromeFromCommand = React.useCallback(
    (
      change:
        | Partial<AppSettings["chrome"]>
        | ((chrome: AppSettings["chrome"]) => Partial<AppSettings["chrome"]>),
      failureMessage: string
    ) => {
      const run = async () => {
        // Settings owns a local draft while it is open. Ignore the application-
        // level shortcut/menu command so accepting a chrome change cannot remount
        // the dialog and discard unrelated unsaved edits.
        if (
          settingsOpenRef.current ||
          settingsWorkspaceOpenRef.current ||
          softwareLicensesOpenRef.current
        ) {
          return
        }
        const previousSettings = cloneAppSettings(settingsRef.current)
        const nextSettings = cloneAppSettings(settingsRef.current)
        const nextPersistedSettings = cloneAppSettings(
          persistedSettingsRef.current
        )
        const resolvedChange =
          typeof change === "function" ? change(nextSettings.chrome) : change
        Object.assign(nextSettings.chrome, resolvedChange)
        Object.assign(nextPersistedSettings.chrome, resolvedChange)
        acceptSettings(nextSettings)
        try {
          const savedSettings = await window.pulseMd.setSettings(
            nextPersistedSettings
          )
          acceptSettings(savedSettings.effective, savedSettings.persisted)
          setChromePersistenceFailure(null)
        } catch (error) {
          console.error(failureMessage, error)
          acceptSettings(previousSettings)
          setChromePersistenceFailure({
            change: { ...resolvedChange },
            message: failureMessage,
          })
        }
      }

      const operation = chromeCommandQueueRef.current.then(run, run)
      chromeCommandQueueRef.current = operation.then(
        () => undefined,
        () => undefined
      )
      return operation
    },
    [acceptSettings]
  )

  const persistLineWrapping = React.useCallback(
    (lineWrapping: boolean) => {
      const run = async () => {
        if (
          settingsOpenRef.current ||
          settingsWorkspaceOpenRef.current ||
          softwareLicensesOpenRef.current
        ) {
          return
        }
        const previousSettings = cloneAppSettings(settingsRef.current)
        const nextSettings = cloneAppSettings(settingsRef.current)
        const nextPersistedSettings = cloneAppSettings(
          persistedSettingsRef.current
        )
        nextSettings.lineWrapping = lineWrapping
        nextPersistedSettings.lineWrapping = lineWrapping
        acceptSettings(nextSettings)
        try {
          const savedSettings = await window.pulseMd.setSettings(
            nextPersistedSettings
          )
          acceptSettings(savedSettings.effective, savedSettings.persisted)
          setLineWrappingPersistenceFailure(null)
        } catch (error) {
          const message = "The Text Wrapping setting could not be saved."
          console.error(message, error)
          acceptSettings(previousSettings)
          setLineWrappingPersistenceFailure({ lineWrapping, message })
        }
      }

      const operation = chromeCommandQueueRef.current.then(run, run)
      chromeCommandQueueRef.current = operation.then(
        () => undefined,
        () => undefined
      )
      return operation
    },
    [acceptSettings]
  )

  const toggleFormattingBar = React.useCallback(
    () =>
      updateChromeFromCommand(
        (chrome) => ({ showFormattingBar: !chrome.showFormattingBar }),
        "The Formatting Toolbar setting could not be saved."
      ),
    [updateChromeFromCommand]
  )

  const hideTopControls = React.useCallback(
    (controls: readonly TopRightControlKey[]) =>
      updateChromeFromCommand((chrome) => {
        const topRightControls = { ...chrome.topRightControls }
        for (const control of controls) topRightControls[control] = false
        return { topRightControls }
      }, "The top-right controls setting could not be saved."),
    [updateChromeFromCommand]
  )

  const toggleStatusBar = React.useCallback(
    () =>
      updateChromeFromCommand(
        (chrome) => ({ alwaysShowStatusBar: !chrome.alwaysShowStatusBar }),
        "The Status Bar setting could not be saved."
      ),
    [updateChromeFromCommand]
  )

  const setTabVisibility = React.useCallback(
    (tabVisibility: AppSettings["chrome"]["tabVisibility"]) =>
      updateChromeFromCommand(
        { tabVisibility },
        "The tab visibility setting could not be saved."
      ),
    [updateChromeFromCommand]
  )

  const formatMarkdown = React.useCallback(
    (command: MarkdownFormattingCommand) => {
      const controller = controllerRef.current
      if (!controller || controller.getDocumentKind() !== "markdown") return
      controller.applyFormatting(command)
      // Popovers restore focus to their trigger as they close. Refocus after
      // that cleanup as well as the React commit so toolbar actions always
      // hand typing back to the editor.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => controller.focus())
      )
    },
    []
  )

  const handleCommand = React.useCallback(
    async (command: EditorCommand) => {
      const controller = controllerRef.current
      const activeId = activeTabIdRef.current
      const settingsSurfaceOpen =
        settingsOpenRef.current || settingsWorkspaceOpenRef.current
      const softwareLicensesOpen = softwareLicensesOpenRef.current
      const profileModalOpen =
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current
      const modalSurfaceOpen =
        settingsSurfaceOpen ||
        softwareLicensesOpen ||
        profileModalOpen ||
        scratchBrowserOpenRef.current
      const formattingCommand = EDITOR_FORMATTING_COMMANDS[command]

      if (
        modalSurfaceOpen &&
        (!settingsSurfaceOpen ||
          (command !== "navigate-back" &&
            command !== "navigate-forward" &&
            command !== "keyboard-shortcuts")) &&
        command !== "close-window" &&
        command !== "undo" &&
        command !== "redo" &&
        command !== "select-all" &&
        command !== "prepare-window-close"
      ) {
        return
      }

      if (formattingCommand) {
        if (!controller?.view.hasFocus) return
        formatMarkdown(formattingCommand)
        return
      }

      switch (command) {
        case "find":
          openSearch()
          break
        case "find-next":
          findAgain("next")
          break
        case "find-previous":
          findAgain("previous")
          break
        case "replace":
          openSearch({ expanded: true })
          break
        case "use-selection-for-find":
          findUsingSelection()
          break
        case "focus-editor":
          focusEditor()
          break
        case "open-outline":
          openOutline()
          break
        case "keyboard-shortcuts":
          if (!settingsWorkspaceOpenRef.current) {
            if (settingsOpenRef.current || (await openSettings())) {
              openKeyboardShortcuts()
            }
          }
          break
        case "software-licenses": {
          setSoftwareLicensesOpen(true)
          try {
            const { openSoftwareLicenses } =
              await loadSoftwareLicensesSurfaceModule()
            await openSoftwareLicenses(setSoftwareLicensesOpen)
          } catch (error) {
            setSoftwareLicensesOpen(false)
            console.error("Unable to open Software Licenses", error)
          }
          break
        }
        case "settings":
          await openSettings()
          break
        case "open-window-profile-picker":
          openWindowProfilePicker()
          break
        case "update-current-window-profile":
          openWindowProfileCapture("update")
          break
        case "create-window-profile-from-tabs":
          openWindowProfileCapture("create")
          break
        case "toggle-mode":
          controller?.toggleMode()
          break
        case "toggle-wrap":
          controller?.toggleLineWrapping()
          break
        case "toggle-formatting-bar":
          await toggleFormattingBar()
          break
        case "toggle-status-bar":
          await toggleStatusBar()
          break
        case "set-tab-visibility-always":
          await setTabVisibility("always")
          break
        case "set-tab-visibility-multiple-tabs":
          await setTabVisibility("multiple-tabs")
          break
        case "set-tab-visibility-mouseover":
          await setTabVisibility("mouseover")
          break
        case "set-tab-visibility-formatting-bar":
          await setTabVisibility("formatting-bar")
          break
        case "set-tab-visibility-hidden":
          await setTabVisibility("hidden")
          break
        case "save":
          if (activeId) await saveTab(activeId)
          break
        case "save-as":
          if (activeId) await saveTab(activeId, true)
          break
        case "save-as-scratch":
          if (activeId) await saveTab(activeId, false, "explicit", true)
          break
        case "open":
          await openDocument()
          break
        case "open-scratch-picker":
          openScratchBrowser()
          break
        case "new-tab":
          await newTab()
          break
        case "new-scratch":
          await createScratch()
          break
        case "navigate-back":
          navigateAppHistory("back")
          break
        case "navigate-forward":
          navigateAppHistory("forward")
          break
        case "close-tab":
          if (activeId) await closeTab(activeId)
          break
        case "close-window":
          window.pulseMd.windowAction("close")
          break
        case "undo":
          if (!modalSurfaceOpen && controller?.view.hasFocus) {
            controller.undo()
          } else {
            runEditCommandInActiveControl(document, "undo")
          }
          break
        case "redo":
          if (!modalSurfaceOpen && controller?.view.hasFocus) {
            controller.redo()
          } else {
            runEditCommandInActiveControl(document, "redo")
          }
          break
        case "select-all": {
          if (!modalSurfaceOpen && controller?.view.hasFocus) {
            controller.selectAll()
            break
          }
          if (selectAllInActiveTextControl(document)) break
          const settingsSurface = document.querySelector<HTMLElement>(
            '[data-slot="dialog-content"], [aria-label="Active tab indicator preview workspace"], [aria-label="Typography preview workspace"], [aria-label="Launch transition preview workspace"], [aria-label="Window Profiles Workspace"], [aria-label="Scratches Workspace"], [data-software-licenses-dialog]'
          )
          if (settingsSurface) selectAllInSurface(settingsSurface)
          break
        }
        case "prepare-window-close":
          await prepareWindowClose()
          break
        case "save-and-close": {
          if (settingsWorkspaceOpenRef.current) {
            settingsWorkspaceOpenRef.current = false
            windowProfilesWorkspaceOpenRef.current = false
            scratchesWorkspaceOpenRef.current = false
            windowProfileLaunchPendingRef.current = false
            restoreActiveDocumentSession()
            setActiveTabIndicatorPreview(null)
            setTypographyPreview(null)
            setLaunchTransitionPreview(null)
            setWindowProfilesWorkspace(null)
            setScratchesWorkspace(null)
            resetSettingsNavigationHistory()
            acceptSettings(settingsRef.current, undefined, true)
            window.pulseMd.previewAppearance(null)
            window.pulseMd.previewWindowZoom(settingsRef.current.zoomFactor)
          }
          const saved = activeId ? await saveTab(activeId) : false
          window.pulseMd.closeReady(saved)
          break
        }
      }
    },
    [
      closeTab,
      createScratch,
      findAgain,
      focusEditor,
      formatMarkdown,
      navigateAppHistory,
      newTab,
      openDocument,
      openScratchBrowser,
      openKeyboardShortcuts,
      openOutline,
      openSearch,
      openSettings,
      openWindowProfileCapture,
      openWindowProfilePicker,
      acceptSettings,
      prepareWindowClose,
      resetSettingsNavigationHistory,
      restoreActiveDocumentSession,
      saveTab,
      setSoftwareLicensesOpen,
      setTabVisibility,
      toggleFormattingBar,
      toggleStatusBar,
      findUsingSelection,
    ]
  )

  const activateTabAtIndex = React.useCallback(
    (index: number) => {
      const descriptor = tabDescriptorsRef.current[index]
      if (!descriptor) return false
      const activeElement = document.activeElement
      const focusPolicy: TabFocusPolicy = activeElement?.closest(
        '[role="tablist"]'
      )
        ? "tablist"
        : activeElement &&
            controllerRef.current?.view.dom.contains(activeElement)
          ? "editor"
          : "preserve"
      void activateTab(descriptor.id, true, focusPolicy)
      return true
    },
    [activateTab]
  )

  const cycleTab = React.useCallback(
    (direction: -1 | 1) => {
      const descriptors = tabDescriptorsRef.current
      if (descriptors.length < 2) return false
      const currentIndex = descriptors.findIndex(
        (tab) => tab.id === activeTabIdRef.current
      )
      const nextIndex =
        (Math.max(0, currentIndex) + direction + descriptors.length) %
        descriptors.length
      return activateTabAtIndex(nextIndex)
    },
    [activateTabAtIndex]
  )

  const navigateHeading = React.useCallback(
    (direction: -1 | 1, level?: MarkdownOutlineHeadingLevel) => {
      const controller = controllerRef.current
      if (!controller?.navigateHeading(direction, level)) return false
      requestAnimationFrame(() => controller.focus())
      return true
    },
    []
  )

  React.useEffect(() => {
    let pendingHeadingChord: {
      direction: -1 | 1
      timeout: number
    } | null = null

    const clearHeadingChord = () => {
      if (!pendingHeadingChord) return
      window.clearTimeout(pendingHeadingChord.timeout)
      pendingHeadingChord = null
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const primaryModifierPressed =
        platformRef.current === "darwin"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey
      const tabDigitIndex = tabIndexForDigitShortcut(event, platformRef.current)
      if (
        settingsOpenRef.current ||
        settingsWorkspaceOpenRef.current ||
        softwareLicensesOpenRef.current ||
        windowProfilePickerOpenRef.current ||
        windowProfileCaptureOpenRef.current ||
        scratchBrowserOpenRef.current
      ) {
        clearHeadingChord()
        const key = event.key.toLowerCase()
        if (
          primaryModifierPressed &&
          !event.altKey &&
          event.shiftKey &&
          key === "w"
        ) {
          event.preventDefault()
          event.stopPropagation()
          window.pulseMd.windowAction("close")
          return
        }
        if (primaryModifierPressed && !event.altKey) {
          if (event.code === "Equal") {
            event.preventDefault()
            event.stopPropagation()
            if (settingsOpenRef.current) {
              window.pulseMd.stepWindowZoom(1)
            }
            return
          }
          if (event.code === "Minus") {
            event.preventDefault()
            event.stopPropagation()
            if (settingsOpenRef.current) {
              window.pulseMd.stepWindowZoom(-1)
            }
            return
          }
          if (event.code === "Digit0" || event.code === "Numpad0") {
            if (settingsWorkspaceOpenRef.current) {
              event.preventDefault()
              event.stopPropagation()
            }
            return
          }
        }

        const controlTabSwitchShortcut =
          event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          event.code === "Tab"
        const headingShortcut =
          (platformRef.current === "darwin"
            ? event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey
            : event.ctrlKey &&
              event.altKey &&
              !event.metaKey &&
              !event.shiftKey) &&
          (event.code === "KeyN" || event.code === "KeyP")
        const exactHeadingShortcut =
          /^(?:Digit)[1-6]$/.test(event.code) &&
          (platformRef.current === "darwin"
            ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
            : event.ctrlKey &&
              event.altKey &&
              !event.metaKey &&
              !event.shiftKey)
        const documentShortcut =
          (event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            event.code === "KeyZ") ||
          (primaryModifierPressed &&
            !event.altKey &&
            (key === "f" ||
              key === "s" ||
              key === "o" ||
              key === "p" ||
              key === "t" ||
              key === "w" ||
              key === "b" ||
              key === "i" ||
              (key === "v" && event.shiftKey) ||
              event.key === "," ||
              event.code === "Comma"))
        if (
          controlTabSwitchShortcut ||
          tabDigitIndex !== null ||
          headingShortcut ||
          exactHeadingShortcut ||
          documentShortcut
        ) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === "Tab"
      ) {
        event.preventDefault()
        event.stopPropagation()
        clearHeadingChord()
        cycleTab(event.shiftKey ? -1 : 1)
        return
      }

      if (tabDigitIndex !== null) {
        event.preventDefault()
        event.stopPropagation()
        clearHeadingChord()
        activateTabAtIndex(tabDigitIndex)
        return
      }

      const markdownDocument =
        controllerRef.current?.getDocumentKind() === "markdown"
      if (!markdownDocument) clearHeadingChord()

      // The open outline owns its exact-level navigation keys and list
      // movement. Tab switching above remains global and closes it naturally.
      if (outlineOpenRef.current) return

      if (markdownDocument && pendingHeadingChord) {
        if (
          event.key !== "Alt" &&
          event.key !== "Control" &&
          event.key !== "Meta" &&
          event.key !== "Shift"
        ) {
          const chord = pendingHeadingChord
          clearHeadingChord()
          const chordLevel = /^Digit([1-6])$/.exec(event.code)
          if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            (event.code === "KeyH" || chordLevel)
          ) {
            event.preventDefault()
            event.stopPropagation()
            navigateHeading(
              chord.direction,
              chordLevel
                ? (Number(chordLevel[1]) as MarkdownOutlineHeadingLevel)
                : undefined
            )
            return
          }
        }
      }

      const chordModifierPressed =
        platformRef.current === "darwin"
          ? event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey
          : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
      if (
        markdownDocument &&
        chordModifierPressed &&
        (event.code === "KeyN" || event.code === "KeyP")
      ) {
        event.preventDefault()
        event.stopPropagation()
        clearHeadingChord()
        pendingHeadingChord = {
          direction: event.code === "KeyN" ? 1 : -1,
          timeout: window.setTimeout(clearHeadingChord, 3_000),
        }
        return
      }

      const headingDigit = /^Digit([1-6])$/.exec(event.code)
      const exactHeadingModifierPressed =
        platformRef.current === "darwin"
          ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
          : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
      if (markdownDocument && headingDigit && exactHeadingModifierPressed) {
        event.preventDefault()
        event.stopPropagation()
        navigateHeading(
          1,
          Number(headingDigit[1]) as MarkdownOutlineHeadingLevel
        )
        return
      }

      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.code === "KeyZ"
      ) {
        event.preventDefault()
        event.stopPropagation()
        controllerRef.current?.toggleLineWrapping()
        return
      }
      const replaceShortcut =
        platformRef.current === "darwin"
          ? primaryModifierPressed &&
            event.altKey &&
            !event.shiftKey &&
            event.code === "KeyF"
          : primaryModifierPressed &&
            !event.altKey &&
            !event.shiftKey &&
            event.code === "KeyH"
      if (replaceShortcut) {
        event.preventDefault()
        event.stopPropagation()
        openSearch({ expanded: true })
        return
      }
      if (!primaryModifierPressed || event.altKey) return

      const key = event.key.toLowerCase()
      if (markdownDocument && event.shiftKey && key === "o") {
        event.preventDefault()
        openOutline()
      } else if (markdownDocument && event.shiftKey && key === "v") {
        event.preventDefault()
        controllerRef.current?.toggleMode()
      } else if (markdownDocument && event.shiftKey && key === "b") {
        event.preventDefault()
        void toggleFormattingBar()
      } else if (key === "f") {
        event.preventDefault()
        openSearch()
      } else if (key === "s") {
        event.preventDefault()
        const activeId = activeTabIdRef.current
        if (activeId) void saveTab(activeId, event.shiftKey)
      } else if (key === "o") {
        event.preventDefault()
        void openDocument()
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault()
        openScratchBrowser()
      } else if (key === "t" && !event.shiftKey) {
        event.preventDefault()
        void newTab()
      } else if (key === "w") {
        event.preventDefault()
        const activeId = activeTabIdRef.current
        if (event.shiftKey) window.pulseMd.windowAction("close")
        else if (activeId) void closeTab(activeId)
      } else if (event.code === "Equal") {
        event.preventDefault()
        window.pulseMd.stepWindowZoom(1)
      } else if (event.code === "Minus") {
        event.preventDefault()
        window.pulseMd.stepWindowZoom(-1)
      } else if (event.key === "," || event.code === "Comma") {
        event.preventDefault()
        void openSettings()
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => {
      clearHeadingChord()
      window.removeEventListener("keydown", handleKeyDown, { capture: true })
    }
  }, [
    activateTabAtIndex,
    closeTab,
    cycleTab,
    navigateHeading,
    newTab,
    openDocument,
    openScratchBrowser,
    openOutline,
    openSearch,
    openSettings,
    saveTab,
    toggleFormattingBar,
  ])

  React.useEffect(() => {
    const handleNavigationMouseButton = (event: MouseEvent) => {
      // Windows and Linux surface these buttons through BrowserWindow's
      // native app-command event. Chromium exposes them as ordinary extra
      // mouse buttons on macOS.
      if (
        platformRef.current !== "darwin" ||
        (event.button !== 3 && event.button !== 4)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      navigateAppHistory(event.button === 3 ? "back" : "forward")
    }
    window.addEventListener("mousedown", handleNavigationMouseButton, true)
    return () =>
      window.removeEventListener("mousedown", handleNavigationMouseButton, true)
  }, [navigateAppHistory])

  React.useEffect(
    () => window.pulseMd.onCommand(handleCommand),
    [handleCommand]
  )
  React.useEffect(
    () =>
      window.pulseMd.onLaunchVisualEffectReady(handleLaunchVisualEffectReady),
    [handleLaunchVisualEffectReady]
  )
  React.useEffect(
    () => () => {
      if (launchTransitionCleanupTimerRef.current !== null) {
        window.clearTimeout(launchTransitionCleanupTimerRef.current)
      }
    },
    []
  )
  React.useEffect(
    () => window.pulseMd.onCliTabsOpenRequested(handleCliTabsOpenRequest),
    [handleCliTabsOpenRequest]
  )
  React.useEffect(
    () => window.pulseMd.onCliEditorFocusRequested(handleCliEditorFocusRequest),
    [handleCliEditorFocusRequest]
  )
  React.useEffect(
    () =>
      window.pulseMd.onWindowProfilePickerRequested(
        handleWindowProfilePickerRequest
      ),
    [handleWindowProfilePickerRequest]
  )
  React.useEffect(
    () =>
      window.pulseMd.onWindowProfilePickerCancelled(
        handleWindowProfilePickerCancellation
      ),
    [handleWindowProfilePickerCancellation]
  )
  React.useEffect(
    () =>
      window.pulseMd.onSettingsChanged((snapshot) =>
        acceptSettings(snapshot.effective, snapshot.persisted)
      ),
    [acceptSettings]
  )
  React.useEffect(
    () => window.pulseMd.onTabsChanged(applyTabsSnapshot),
    [applyTabsSnapshot]
  )
  React.useEffect(
    () =>
      window.pulseMd.onOpenExistingLocalLinkRequested(
        handleOpenExistingLocalLinkRequest
      ),
    [handleOpenExistingLocalLinkRequest]
  )
  React.useEffect(
    () => window.pulseMd.onExternalDocumentChange(applyExternalDocumentChange),
    [applyExternalDocumentChange]
  )
  React.useEffect(() => window.pulseMd.onTabDragActivity(setTabDragActive), [])
  React.useEffect(
    () =>
      window.pulseMd.onSpellCheckDictionaryChanged(() => {
        controllerRef.current?.refreshSpellCheck()
      }),
    []
  )
  React.useEffect(
    () => window.pulseMd.onWindowZoomChanged(handleWindowZoomChanged),
    [handleWindowZoomChanged]
  )
  React.useEffect(() => {
    let active = true
    const unsubscribe =
      window.pulseMd.onWindowMaximizedChanged(setWindowMaximized)
    void window.pulseMd.getWindowMaximized().then((maximized) => {
      if (active) setWindowMaximized(maximized)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  React.useEffect(
    () =>
      window.pulseMd.onWindowZoomPersistenceFailed((zoomFactor) => {
        setZoomPersistenceFailure(zoomFactor)
      }),
    []
  )
  React.useEffect(
    () =>
      window.pulseMd.onWindowActivationChanged((active) => {
        windowActiveRef.current = active
        document.documentElement.dataset.windowActive = String(active)
        controllerRef.current?.setWindowActive(active)
        if (active) focusInitialEditorIfReady()
      }),
    [focusInitialEditorIfReady]
  )
  React.useEffect(
    () =>
      window.pulseMd.onTabExportRequested((request) => {
        const controller = controllerRef.current
        const tab = tabsRef.current.get(request.tabId)
        if (!controller || !tab) return
        if (activeTabIdRef.current === tab.id) syncActiveSession()
        window.pulseMd.provideTabExport({
          ...request,
          editorSession: controller.serializeSession(
            tab.editor,
            tab.cleanDocument.toString()
          ),
        })
      }),
    [syncActiveSession]
  )
  React.useEffect(
    () =>
      window.pulseMd.onSettingsScratchSnapshotRequested((request) => {
        const provideSnapshot = async () => {
          if (
            !Number.isSafeInteger(request.maximumContentBytes) ||
            request.maximumContentBytes < 0
          ) {
            throw new Error("Scratch snapshot requested an invalid byte limit")
          }
          const seenTabIds = new Set<TabId>()
          for (const tabId of request.tabIds) {
            if (seenTabIds.has(tabId)) {
              throw new Error("Scratch snapshot requested a duplicate tab")
            }
            seenTabIds.add(tabId)
            const descriptor = tabDescriptorsRef.current.find(
              (candidate) => candidate.id === tabId
            )
            if (!descriptor || descriptor.backing !== "scratch") {
              throw new Error("Scratch snapshot requested an unavailable tab")
            }
          }

          const { collectSettingsScratchSnapshot } =
            await loadSettingsScratchSnapshotModule()
          const collected = await collectSettingsScratchSnapshot(
            request.tabIds,
            request.maximumContentBytes,
            async (tabId) => {
              let tab: RendererTab | null | undefined =
                tabsRef.current.get(tabId)
              if (!tab) tab = await hydrateRendererTab(tabId, true)
              if (activeTabIdRef.current === tabId) tab = syncActiveSession()
              if (
                !tab ||
                tab.backing !== "scratch" ||
                !tabDescriptorsRef.current.some(
                  (candidate) =>
                    candidate.id === tabId && candidate.backing === "scratch"
                )
              ) {
                throw new Error(
                  "Scratch tab changed while it was being captured"
                )
              }
              return {
                document: tab.editor.state.doc,
                format: tab.document.format,
                revision: tab.revision,
              }
            }
          )
          if (collected.status === "too-large") {
            window.pulseMd.provideSettingsScratchSnapshot({
              reason: "too-large",
              requestId: request.requestId,
              status: "unavailable",
            })
            return
          }

          syncActiveSession()
          for (const captured of collected.tabs) {
            const tab = tabsRef.current.get(captured.tabId)
            if (
              !tab ||
              tab.backing !== "scratch" ||
              tab.revision !== captured.revision ||
              !tabDescriptorsRef.current.some(
                (candidate) =>
                  candidate.id === captured.tabId &&
                  candidate.backing === "scratch"
              )
            ) {
              throw new Error("Scratch tab changed after it was captured")
            }
          }
          window.pulseMd.provideSettingsScratchSnapshot({
            requestId: request.requestId,
            status: "ok",
            tabs: collected.tabs,
          })
        }

        void provideSnapshot().catch((error: unknown) => {
          console.error("Unable to provide scratch snapshot for export", error)
          window.pulseMd.provideSettingsScratchSnapshot({
            reason: "changed",
            requestId: request.requestId,
            status: "unavailable",
          })
        })
      }),
    [hydrateRendererTab, syncActiveSession]
  )
  React.useEffect(
    () =>
      window.pulseMd.onTabTransferCommitRequested((request) => {
        const controller = controllerRef.current
        let tab = tabsRef.current.get(request.tabId)
        if (!tab || tab.revision !== request.revision) return
        if (activeTabIdRef.current === tab.id) {
          tab = syncActiveSession()
          if (!controller || !tab || tab.revision !== request.revision) return
          controller.setReadOnly(true)
        }
        const leaseTabId = tab.id
        tabTransferCommitLeasesRef.current.set(request.transferId, leaseTabId)
        queueMicrotask(() => {
          if (
            tabTransferCommitLeasesRef.current.get(request.transferId) !==
            leaseTabId
          ) {
            return
          }
          void window.pulseMd
            .commitTabTransfer(request.transferId)
            .catch(() => {
              if (
                tabTransferCommitLeasesRef.current.get(request.transferId) !==
                leaseTabId
              ) {
                return
              }
              settleControllerCommitLease(request.transferId)
              const currentController = controllerRef.current
              if (
                currentController &&
                activeTabIdRef.current === leaseTabId &&
                windowActiveRef.current
              ) {
                requestAnimationFrame(() => currentController.restoreFocus())
              }
            })
        })
      }),
    [settleControllerCommitLease, syncActiveSession]
  )
  React.useEffect(
    () =>
      window.pulseMd.onTabTransferCommitSettled((result) => {
        const leaseTabId = settleControllerCommitLease(result.transferId)
        if (!leaseTabId) return
        const controller = controllerRef.current
        if (
          !result.committed &&
          controller &&
          activeTabIdRef.current === leaseTabId &&
          windowActiveRef.current
        ) {
          requestAnimationFrame(() => controller.restoreFocus())
        }
      }),
    [settleControllerCommitLease]
  )
  React.useEffect(
    () =>
      window.pulseMd.onTabDetachSourceRetired(({ dragToken, tabId }) => {
        void (async () => {
          if (
            !tabsRef.current.has(tabId) ||
            tabDescriptorsRef.current.length <= 1
          ) {
            return
          }
          retiredTabDragsRef.current.set(dragToken, tabId)
          const descriptors = tabDescriptorsRef.current
          const sourceIndex = descriptors.findIndex((tab) => tab.id === tabId)
          if (sourceIndex < 0) return
          const remaining = descriptors.filter((tab) => tab.id !== tabId)
          setDescriptors(remaining)
          let sessionRetired = activeTabIdRef.current !== tabId
          if (activeTabIdRef.current === tabId) {
            const next = remaining[Math.min(sourceIndex, remaining.length - 1)]
            sessionRetired = Boolean(
              next && (await activateTab(next.id, false, "preserve"))
            )
          }
          // Once the detached session is inactive it cannot change, so the
          // neighboring source tab need not inherit the short commit lease.
          if (
            ![...tabTransferCommitLeasesRef.current.values()].some(
              (leaseTabId) => leaseTabId === activeTabIdRef.current
            )
          ) {
            const currentController = controllerRef.current
            if (currentController) {
              setControllerReadOnlyRespectingLocks(currentController, false)
            }
          }
          if (!sessionRetired) return
          const waitForRetirementCommit = () => {
            if (retiredTabDragsRef.current.get(dragToken) !== tabId) return
            const tabStillRendered = [
              ...document.querySelectorAll<HTMLElement>(
                ".document-tab[data-tab-id]"
              ),
            ].some((element) => element.dataset.tabId === tabId)
            if (tabStillRendered) {
              requestAnimationFrame(waitForRetirementCommit)
              return
            }
            // A second frame leaves one compositor paint between the committed
            // source retirement and the target window becoming interactive.
            requestAnimationFrame(() => {
              if (retiredTabDragsRef.current.get(dragToken) !== tabId) return
              window.pulseMd.acknowledgeTabDetachSourceRetired(dragToken)
            })
          }
          requestAnimationFrame(waitForRetirementCommit)
        })()
      }),
    [activateTab, setControllerReadOnlyRespectingLocks, setDescriptors]
  )
  React.useEffect(
    () =>
      window.pulseMd.onTabDetachSourceSettled(({ dragToken }) => {
        retiredTabDragsRef.current.delete(dragToken)
      }),
    []
  )

  React.useEffect(() => {
    const parent = editorHostRef.current
    if (!parent) return
    const pendingImports = pendingImportsRef.current
    const scratchSaveTimers = scratchSaveTimersRef.current
    const scratchSaveCoordinations = scratchSaveCoordinationsRef.current
    const tabHydrations = tabHydrationsRef.current
    const tabs = tabsRef.current
    let disposed = false
    let settingsPreloadIdleCallback: number | null = null
    let settingsPreloadGraceTimer: number | null = null
    let tabHydrationIdleCallback: number | null = null
    let codeLanguageSupportIdleCallback: number | null = null
    let editorContextMenuHandoffCleanup: (() => void) | null = null
    let remoteImageIntentCleanup: (() => void) | null = null

    const bootstrap = async () => {
      try {
        performance.mark("pmd:bootstrap-request")
        const payload = await window.pulseMd.bootstrap()
        performance.mark("pmd:bootstrap-received")
        if (disposed || payload.tabs.length === 0) return
        const activeBootstrap = payload.activeTab
        const activeDescriptor = payload.tabs.find(
          ({ id }) => id === payload.activeTabId
        )
        if (
          !activeDescriptor ||
          activeBootstrap.tab.id !== payload.activeTabId
        ) {
          throw new Error("The active bootstrap tab is not in its window")
        }

        // Begin fetching completion support alongside font preparation, but do
        // not put its parsing or setup on the launch-critical path.
        const pathCompletionSupportPromise = loadPathCompletionSupport().catch(
          (error: unknown) => {
            console.error("Unable to load path completion support", error)
            return null
          }
        )

        const optionalLivePreviewSupportPromise =
          activeBootstrap.document.kind === "markdown" &&
          markdownExtensionsNeedOptionalLivePreview(
            payload.settings.markdownExtensions
          )
            ? loadOptionalLivePreviewSupport().catch((error: unknown) => {
                console.error(
                  "Unable to load optional Markdown previews",
                  error
                )
                return null
              })
            : Promise.resolve(null)
        const editorFontStylesPromise = loadIncludedFontFamilyStyles(
          payload.settings.regularFontFamily,
          payload.settings.monospaceFontFamily
        ).catch((error: unknown) => {
          console.error("Unable to load the selected editor fonts", error)
        })
        const [, optionalLivePreviewSupport] = await Promise.all([
          editorFontStylesPromise,
          optionalLivePreviewSupportPromise,
        ])
        if (disposed) return
        applyEditorTypography(payload.settings)
        await loadInitialEditorFonts(document.fonts, {
          content: serializedEditorContent(
            activeBootstrap.editorSession,
            activeBootstrap.document.content
          ),
          monospaceFontSize: payload.settings.codeFontSize,
          monospaceFontStack: fontFamilyCssStack(
            payload.settings.monospaceFontFamily,
            "monospace"
          ),
          samplePositions: serializedEditorFontPositions(
            activeBootstrap.editorSession,
            activeBootstrap.initialViewport
          ),
          regularFontSize: payload.settings.baseFontSize,
          regularFontStack: fontFamilyCssStack(
            payload.settings.regularFontFamily,
            "regular"
          ),
        })
        performance.mark("pmd:editor-fonts-ready")
        if (disposed) return

        platformRef.current = payload.platform
        setPlatform(payload.platform)
        setTabDragSink(payload.tabDragSink)
        activeTabIdRef.current = activeBootstrap.tab.id
        setActiveTabId(activeBootstrap.tab.id)
        setDescriptors(payload.tabs)
        settingsHydratedRef.current = true
        acceptSettings(payload.settings, payload.persistedSettings)
        windowActiveRef.current = payload.windowActive
        document.documentElement.dataset.windowActive = String(
          payload.windowActive
        )
        window.document.title = activeDescriptor.displayName

        performance.mark("pmd:editor-create-start")
        const controller = new MarkdownEditorController({
          ariaLabel: "Document editor",
          autofocus: false,
          content: activeBootstrap.document.content,
          documentPath: activeBootstrap.document.filePath,
          documentKind: activeBootstrap.document.kind,
          initialCursor: activeBootstrap.initialCursor,
          lineWrapping: payload.settings.lineWrapping,
          mode:
            activeBootstrap.initialEditorMode ??
            payload.settings.initialEditorMode,
          maxContentWidth: payload.settings.maxContentWidth,
          markdownExtensions: payload.settings.markdownExtensions,
          optionalLivePreviewSupport: optionalLivePreviewSupport ?? undefined,
          spellCheck: payload.settings.spellCheck,
          checkSpelling: window.pulseMd.checkSpelling,
          onChange: markActiveDirty,
          onModeChange: (mode) => {
            const active = activeTabIdRef.current
            const tab = active ? tabsRef.current.get(active) : undefined
            if (tab) tab.editor.mode = mode
            updateStatus()
          },
          onLineWrappingChange: (lineWrapping) => {
            const active = activeTabIdRef.current
            const tab = active ? tabsRef.current.get(active) : undefined
            if (tab) tab.editor.lineWrapping = lineWrapping
            window.pulseMd.reportLineWrapping(lineWrapping)
            void persistLineWrapping(lineWrapping)
          },
          onLinkTooltipChange: (tooltip) =>
            linkTooltipRef.current?.update(tooltip),
          onNavigate: rememberActiveNavigationOrigin,
          onSearchStatusChange: (status) => {
            searchStatusRef.current = status
            searchOverlayRef.current?.updateStatus(status)
          },
          onStatusChange: updateStatus,
          openLink,
          resolveHeadingLinkPaste: (metadata) => {
            const targetTabId = activeTabIdRef.current
            if (!targetTabId) {
              return Promise.reject(
                new Error("No active document is available for paste")
              )
            }
            return window.pulseMd.resolveHeadingLinkPaste(targetTabId, metadata)
          },
          parent,
          platform: payload.platform,
          appearanceProfile:
            payload.settings.themeByScheme[resolvedThemeRef.current],
          sourceIndentation: payload.settings.sourceIndentation,
          sourceIndentSize: payload.settings.sourceIndentSize,
          windowActive: payload.windowActive,
        })
        performance.mark("pmd:editor-created")
        controllerRef.current = controller
        void pathCompletionSupportPromise
          .then((module) => {
            if (!module) return
            const { pathCompletionExtension } = module
            if (disposed || controllerRef.current !== controller) return
            controller.setPathCompletionExtension(
              pathCompletionExtension(async (path) => {
                const tabId = activeTabIdRef.current
                return tabId ? window.pulseMd.completePath(tabId, path) : []
              })
            )
          })
          .catch((error: unknown) => {
            if (!disposed) {
              console.error("Unable to install path completion support", error)
            }
          })
        const contextMenuHandoff = editorContextMenuHandoff
        contextMenuHandoff.activate(false)
        const queueContextMenu = (event: MouseEvent) => {
          contextMenuHandoff.queue("contextmenu", event)
        }
        const queueContextMenuKeyDown = (event: KeyboardEvent) => {
          if (
            contextMenuHandoff.queue("ready") ||
            (event.key !== "ContextMenu" &&
              (event.key !== "F10" ||
                !event.shiftKey ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey))
          ) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          contextMenuHandoff.queue("keydown", event)
        }
        const stopQueuedNativeContextMenu = window.pulseMd.onEditorContextMenu(
          (details: EditorContextMenuDetails) =>
            contextMenuHandoff.queue("native", details)
        )
        controller.view.dom.addEventListener(
          "contextmenu",
          queueContextMenu,
          true
        )
        controller.view.dom.addEventListener(
          "keydown",
          queueContextMenuKeyDown,
          true
        )
        editorContextMenuHandoffCleanup = () => {
          stopQueuedNativeContextMenu()
          controller.view.dom.removeEventListener(
            "contextmenu",
            queueContextMenu,
            true
          )
          controller.view.dom.removeEventListener(
            "keydown",
            queueContextMenuKeyDown,
            true
          )
          contextMenuHandoff.activate(false)
        }
        const remoteImageIntentEvents = [
          "keydown",
          "pointerdown",
          "wheel",
        ] as const
        const activateDeferredEditorChrome = () => {
          if (disposed || controllerRef.current !== controller) return
          setDeferredEditorChromeActivated(true)
          void loadDeferredEditorChrome().catch(() => undefined)
        }
        const enableRemoteImages = (event: Event) => {
          if (
            !event.isTrusted ||
            disposed ||
            controllerRef.current !== controller
          ) {
            return
          }
          remoteImageIntentCleanup?.()
          activateDeferredEditorChrome()
          controller.setRemoteImagesEnabled(true)
        }
        const cleanupRemoteImageIntent = () => {
          for (const eventName of remoteImageIntentEvents) {
            parent.removeEventListener(eventName, enableRemoteImages, true)
          }
          if (remoteImageIntentCleanup === cleanupRemoteImageIntent) {
            remoteImageIntentCleanup = null
          }
        }
        remoteImageIntentCleanup = cleanupRemoteImageIntent
        for (const eventName of remoteImageIntentEvents) {
          parent.addEventListener(eventName, enableRemoteImages, {
            capture: true,
            passive: eventName === "wheel",
          })
        }
        if (
          activeBootstrap.document.kind === "markdown" &&
          payload.settings.chrome.showFormattingBar &&
          shouldCompensateTopDrawer()
        ) {
          setTopDrawerCompensated(true)
        }

        let activeEditor: MarkdownEditorSession
        if (activeBootstrap.editorSession) {
          activeEditor = controller.deserializeSession(
            activeBootstrap.editorSession,
            activeBootstrap.document.filePath,
            activeBootstrap.document.kind
          )
          controller.activateSession(activeEditor)
        } else {
          activeEditor = controller.captureSession(0)
          if (activeBootstrap.initialViewport) {
            applyInitialViewport(activeEditor, activeBootstrap.initialViewport)
            controller.activateSession(activeEditor)
          }
        }
        const activeBaselineContent =
          activeBootstrap.baselineContent ??
          activeBootstrap.editorSession?.baselineContent ??
          activeBootstrap.document.content
        tabsRef.current.set(activeBootstrap.tab.id, {
          id: activeBootstrap.tab.id,
          backing: activeDescriptor.backing,
          color: activeDescriptor.color,
          document: {
            ...documentMetadata(activeBootstrap.document),
            displayName: activeDescriptor.displayName,
            filePath: activeDescriptor.filePath,
          },
          dirty: activeDescriptor.dirty,
          navigationDocumentId: crypto.randomUUID(),
          revision: activeEditor.revision,
          cleanDocument: activeDescriptor.dirty
            ? Text.of(activeBaselineContent.split("\n"))
            : activeEditor.state.doc,
          editor: activeEditor,
        })
        window.pulseMd.acknowledgeTabHydration(activeBootstrap.tab.id)
        window.pulseMd.reportLineWrapping(controller.getLineWrapping())

        if (activeBootstrap.initialCursor) {
          if (activeBootstrap.editorSession) {
            controller.setCursorPosition(
              activeBootstrap.initialCursor.line,
              activeBootstrap.initialCursor.column
            )
          }
          controller.focus()
        }
        focusInitialEditorIfReady()

        updateStatus()
        const synchronizedSettings = await window.pulseMd.rendererReady(
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
        if (disposed) return
        rendererReadyRef.current = true
        acceptSettings(
          synchronizedSettings.effective,
          synchronizedSettings.persisted
        )
        editorReadyFrameRef.current = window.requestAnimationFrame(() => {
          editorReadyFrameRef.current = null
          if (disposed || controllerRef.current !== controller) return
          focusInitialEditorIfReady()
          window.pulseMd.editorReady()
          activateDeferredEditorChrome()
          codeLanguageSupportIdleCallback = window.requestIdleCallback(() => {
            codeLanguageSupportIdleCallback = null
            if (disposed || controllerRef.current !== controller) return
            void loadCodeLanguageDataModule()
              .then(({ languages }) => {
                if (disposed || controllerRef.current !== controller) return
                controller.enableCodeLanguageSupport(languages)
              })
              .catch((error: unknown) => {
                if (!disposed) {
                  console.error("Unable to load code language support", error)
                }
              })
          })
          const pendingTabIds = payload.tabs
            .map(({ id }) => id)
            .filter((tabId) => tabId !== activeBootstrap.tab.id)
          let nextTabIndex = 0
          const scheduleNextTabHydration = () => {
            if (disposed || controllerRef.current !== controller) return
            while (
              nextTabIndex < pendingTabIds.length &&
              (!tabDescriptorsRef.current.some(
                ({ id }) => id === pendingTabIds[nextTabIndex]
              ) ||
                tabsRef.current.has(pendingTabIds[nextTabIndex]!))
            ) {
              nextTabIndex += 1
            }
            const tabId = pendingTabIds[nextTabIndex]
            if (!tabId) return
            tabHydrationIdleCallback = window.requestIdleCallback(
              (deadline) => {
                tabHydrationIdleCallback = null
                if (disposed || controllerRef.current !== controller) return
                if (!deadline.didTimeout && deadline.timeRemaining() < 4) {
                  scheduleNextTabHydration()
                  return
                }
                nextTabIndex += 1
                void hydrateRendererTab(tabId, false).then(
                  scheduleNextTabHydration
                )
              },
              { timeout: TAB_HYDRATION_IDLE_TIMEOUT_MS }
            )
          }
          scheduleNextTabHydration()
        })

        settingsPreloadGraceTimer = window.setTimeout(() => {
          settingsPreloadGraceTimer = null
          if (disposed) return
          settingsPreloadIdleCallback = window.requestIdleCallback(async () => {
            settingsPreloadIdleCallback = null
            const preloadResults = await Promise.allSettled([
              prepareDeferredSettingsDialog(),
              prepareTypographySettingsWorkspace(),
            ])
            for (const result of preloadResults) {
              if (result.status === "rejected" && !disposed) {
                console.error("Unable to preload Settings", result.reason)
              }
            }
            if (disposed) return
            settingsPreloadIdleCallback = window.requestIdleCallback(
              async () => {
                settingsPreloadIdleCallback = null
                await loadOutlinePopover().catch((error: unknown) => {
                  if (!disposed) {
                    console.error(
                      "Unable to preload the document outline",
                      error
                    )
                  }
                })
                if (disposed) return
                settingsPreloadIdleCallback = window.requestIdleCallback(() => {
                  settingsPreloadIdleCallback = null
                  void loadSoftwareLicensesSurfaceModule()
                    .then(({ prepareSoftwareLicenses }) =>
                      prepareSoftwareLicenses()
                    )
                    .catch((error: unknown) => {
                      if (!disposed) {
                        console.error(
                          "Unable to preload Software Licenses",
                          error
                        )
                      }
                    })
                })
              }
            )
          })
        }, NONESSENTIAL_PRELOAD_GRACE_MS)
      } catch (error) {
        console.error("Failed to initialize the editor", error)
        window.pulseMd.showRecovery(
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    void bootstrap()
    return () => {
      disposed = true
      rendererReadyRef.current = false
      if (initialEditorFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(initialEditorFocusFrameRef.current)
        initialEditorFocusFrameRef.current = null
      }
      if (editorReadyFrameRef.current !== null) {
        window.cancelAnimationFrame(editorReadyFrameRef.current)
        editorReadyFrameRef.current = null
      }
      if (settingsMeasureFrameRef.current !== null) {
        window.cancelAnimationFrame(settingsMeasureFrameRef.current)
        settingsMeasureFrameRef.current = null
      }
      settingsContentRefreshPendingRef.current = false
      if (settingsPreloadIdleCallback !== null) {
        window.cancelIdleCallback(settingsPreloadIdleCallback)
      }
      if (settingsPreloadGraceTimer !== null) {
        window.clearTimeout(settingsPreloadGraceTimer)
      }
      if (tabHydrationIdleCallback !== null) {
        window.cancelIdleCallback(tabHydrationIdleCallback)
      }
      if (codeLanguageSupportIdleCallback !== null) {
        window.cancelIdleCallback(codeLanguageSupportIdleCallback)
      }
      editorContextMenuHandoffCleanup?.()
      remoteImageIntentCleanup?.()
      for (const pending of pendingImports.values()) {
        window.clearTimeout(pending.timeout)
      }
      pendingImports.clear()
      for (const timer of scratchSaveTimers.values()) {
        window.clearTimeout(timer.timeout)
      }
      scratchSaveTimers.clear()
      scratchSaveCoordinations.clear()
      tabActivationRevisionRef.current += 1
      tabHydrations.clear()
      controllerRef.current?.destroy()
      controllerRef.current = null
      tabs.clear()
    }
  }, [
    acceptSettings,
    applySettings,
    editorContextMenuHandoff,
    focusInitialEditorIfReady,
    hydrateRendererTab,
    markActiveDirty,
    openLink,
    persistLineWrapping,
    rememberActiveNavigationOrigin,
    setDescriptors,
    shouldCompensateTopDrawer,
    updateStatus,
  ])

  const dropTab = React.useCallback(
    async (dragToken: string, index: number) => {
      const controller = controllerRef.current
      if (!controller) return false
      const localTabId = localDragTokensRef.current.get(dragToken)
      if (localTabId) {
        const snapshot = await window.pulseMd.reorderTab(localTabId, index)
        applyTabsSnapshot(snapshot)
        return true
      }

      const imported = await window.pulseMd.requestTabTransfer(dragToken, index)
      if (!imported) return false
      try {
        const editor = controller.deserializeSession(
          imported.editorSession,
          imported.document.filePath,
          imported.document.kind
        )
        const baselineContent = imported.editorSession.baselineContent
        const tab: RendererTab = {
          id: imported.tab.id,
          backing: imported.tab.backing,
          color: imported.tab.color,
          document: documentMetadata(imported.document),
          dirty: imported.tab.dirty,
          navigationDocumentId: crypto.randomUUID(),
          revision: editor.revision,
          cleanDocument: imported.tab.dirty
            ? Text.of(baselineContent.split("\n"))
            : editor.state.doc,
          editor,
        }
        const timeout = window.setTimeout(() => {
          pendingImportsRef.current.delete(tab.id)
        }, 12_000)
        pendingImportsRef.current.set(tab.id, { tab, timeout })
        window.pulseMd.confirmTabTransfer(imported.transferId, true)
        return true
      } catch (error) {
        console.error("Unable to import tab", error)
        window.pulseMd.confirmTabTransfer(imported.transferId, false)
        return false
      }
    },
    [applyTabsSnapshot]
  )

  const endTabDrag = React.useCallback(
    (
      _tabId: TabId,
      dragToken: string,
      details: {
        cancelled: boolean
        dropped: boolean
        screenPoint: { x: number; y: number }
      }
    ) => {
      localDragTokensRef.current.delete(dragToken)
      if (dragToken) {
        window.pulseMd.endTabDrag({ dragToken, ...details })
      }
    },
    []
  )

  React.useEffect(() => {
    requestAnimationFrame(() => updateStatus())
  }, [activeTabId, appSettings.chrome, updateStatus])

  const windowProfilesWorkspaceVisible = isWindowProfilesSettingsRoute(
    settingsNavigationRoute
  )
  const scratchesWorkspaceVisible = isScratchesSettingsRoute(
    settingsNavigationRoute
  )
  const windowProfileComposerRoute =
    settingsNavigationRoute.kind === "window-profile-composer"
      ? settingsNavigationRoute.composer
      : null
  const settingsWorkspacePreviewOpen =
    activeTabIndicatorPreview !== null ||
    typographyPreview !== null ||
    launchTransitionPreview !== null ||
    windowProfilesWorkspaceVisible ||
    scratchesWorkspaceVisible
  const settingsWorkspacePreviewTitle = activeTabIndicatorPreview
    ? "Active Tab Indicator Preview"
    : typographyPreview
      ? "Typography Preview"
      : launchTransitionPreview
        ? "Launch Transition Preview"
        : windowProfilesWorkspaceVisible
          ? "Window Profiles"
          : scratchesWorkspaceVisible
            ? "Scratches"
            : undefined

  React.useEffect(() => {
    if (!settingsWorkspacePreviewOpen) return
    const workspaceSelector =
      '[aria-label="Active tab indicator preview workspace"], [aria-label="Typography preview workspace"], [aria-label="Launch transition preview workspace"], [aria-label="Window Profiles Workspace"], [aria-label="Scratches Workspace"]'
    const getWorkspace = () =>
      document.querySelector<HTMLElement>(workspaceSelector)
    const portalSelector =
      '[data-slot="select-content"], [data-slot="combobox-content"], [data-slot="alert-dialog-content"]'
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[href]:not([aria-disabled="true"])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(",")
    const focusableElements = () => {
      const currentWorkspace = getWorkspace()
      if (!currentWorkspace) return []
      return [
        ...currentWorkspace.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter(
        (element) =>
          !element.hidden &&
          element.getAttribute("aria-hidden") !== "true" &&
          element.getClientRects().length > 0
      )
    }
    const focusWorkspace = (backward = false) => {
      const currentWorkspace = getWorkspace()
      if (!currentWorkspace) return
      const focusable = focusableElements()
      const target = backward ? focusable.at(-1) : focusable[0]
      ;(target ?? currentWorkspace).focus({ preventScroll: true })
    }
    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return
      const currentWorkspace = getWorkspace()
      if (!currentWorkspace) return
      if (
        currentWorkspace.contains(event.target) ||
        event.target.closest(portalSelector)
      ) {
        return
      }
      focusWorkspace()
    }
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return
      if (
        event.target instanceof Element &&
        event.target.closest(portalSelector)
      ) {
        return
      }
      const focusable = focusableElements()
      if (focusable.length === 0) {
        event.preventDefault()
        getWorkspace()?.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement
      const index =
        active instanceof HTMLElement ? focusable.indexOf(active) : -1
      if (
        (!event.shiftKey && index === focusable.length - 1) ||
        (event.shiftKey && index <= 0)
      ) {
        event.preventDefault()
        focusWorkspace(event.shiftKey)
      }
    }

    document.addEventListener("focusin", handleFocusIn, true)
    window.addEventListener("keydown", handleTab, true)
    return () => {
      document.removeEventListener("focusin", handleFocusIn, true)
      window.removeEventListener("keydown", handleTab, true)
    }
  }, [settingsWorkspacePreviewOpen])

  const editorPanelTabLabelId =
    !settingsWorkspacePreviewOpen &&
    appSettings.chrome.tabVisibility !== "hidden" &&
    activeTabId
      ? `document-tab-${activeTabId}`
      : undefined
  const activeTabDescriptor =
    tabDescriptors.find(({ id }) => id === activeTabId) ?? null
  const activeDocumentKind: DocumentKind =
    activeTabDescriptor?.kind ?? "markdown"
  const markdownControlsEnabled = activeDocumentKind === "markdown"
  const formattingBarEnabled =
    markdownControlsEnabled && appSettings.chrome.showFormattingBar
  const tabDragShelfAllowed =
    !settingsWorkspacePreviewOpen &&
    !formattingBarEnabled &&
    (appSettings.chrome.tabVisibility === "always" ||
      appSettings.chrome.tabVisibility === "mouseover" ||
      appSettings.chrome.tabVisibility === "multiple-tabs")
  const tabDragShelfContext = React.useMemo(
    () => (tabDragShelfAllowed ? {} : null),
    [tabDragShelfAllowed]
  )
  const tabDragShelfVisible =
    tabDragShelfContext !== null &&
    tabDragShelfHoverContext === tabDragShelfContext
  const formattingDrawerVisible = Boolean(
    !settingsWorkspacePreviewOpen &&
    platform &&
    activeTabId &&
    formattingBarEnabled
  )
  const windowsControlDrawerMetrics = React.useMemo(() => {
    if (
      (platform !== "win32" && platform !== "linux") ||
      settingsWorkspacePreviewOpen ||
      !activeTabId
    ) {
      return null
    }

    const showNavigation =
      appSettings.chrome.topRightControls.navigation &&
      (navigationAvailability.back || navigationAvailability.forward)
    const navigationButtonCount = showNavigation ? 2 : 0
    const showViewMode =
      markdownControlsEnabled && appSettings.chrome.topRightControls.viewMode
    const showFind = appSettings.chrome.topRightControls.find
    const showOutline =
      markdownControlsEnabled && appSettings.chrome.topRightControls.outline
    const showFormattingToolbar =
      markdownControlsEnabled &&
      appSettings.chrome.topRightControls.formattingToolbar
    const showSettings = appSettings.chrome.topRightControls.settings
    const documentActionCount =
      Number(showViewMode) +
      Number(showFind) +
      Number(showOutline) +
      Number(showFormattingToolbar)
    const wideActionCount = documentActionCount + Number(showSettings)
    const wideWidth = topControlGroupWidth(
      navigationButtonCount + wideActionCount,
      navigationButtonCount > 0 && wideActionCount > 0
    )
    const compactWidth = topControlGroupWidth(
      Number(showNavigation || documentActionCount > 0) + Number(showSettings),
      false
    )
    return wideWidth > 0 || compactWidth > 0
      ? { compactWidth, wideWidth }
      : null
  }, [
    activeTabId,
    appSettings.chrome.topRightControls,
    markdownControlsEnabled,
    navigationAvailability.back,
    navigationAvailability.forward,
    platform,
    settingsWorkspacePreviewOpen,
  ])
  const windowsControlDrawerVisible = Boolean(
    windowsControlDrawerMetrics && windowsControlDrawerNarrow
  )
  const topDrawerVisible =
    formattingDrawerVisible ||
    tabDragShelfVisible ||
    windowsControlDrawerVisible
  if (
    topDrawerPresence.tabId !== activeTabId ||
    topDrawerPresence.visible !== topDrawerVisible
  ) {
    setTopDrawerPresence({ tabId: activeTabId, visible: topDrawerVisible })
    setTopDrawerCompensated(topDrawerVisible && topDrawerAtTopEdge)
  }
  const topDrawerCompensationActive = topDrawerVisible && topDrawerCompensated

  React.useLayoutEffect(() => {
    const previous = topDrawerCompensationContextRef.current
    topDrawerCompensationContextRef.current = {
      active: topDrawerCompensationActive,
      tabId: activeTabId,
    }
    if (
      !previous.active ||
      topDrawerCompensationActive ||
      previous.tabId !== activeTabId
    ) {
      return
    }

    const scrollDOM = controllerRef.current?.view.scrollDOM
    const content = controllerRef.current?.view.contentDOM
    if (
      !scrollDOM ||
      !content ||
      scrollDOM.scrollTop <= TOP_DRAWER_TOP_EDGE_THRESHOLD
    ) {
      return
    }

    const paddingAnimation = content
      .getAnimations()
      .find((animation) =>
        (animation.effect as KeyframeEffect | null)
          ?.getKeyframes()
          .some((keyframe) => keyframe.paddingTop != null)
      )
    const keyframes = (
      paddingAnimation?.effect as KeyframeEffect | null
    )?.getKeyframes()
    const startPadding = Number.parseFloat(String(keyframes?.[0]?.paddingTop))
    const endPadding = Number.parseFloat(String(keyframes?.at(-1)?.paddingTop))
    if (
      !paddingAnimation ||
      !Number.isFinite(startPadding) ||
      !Number.isFinite(endPadding) ||
      startPadding <= endPadding
    ) {
      return
    }

    // Away from the document start, collapsing the drawer should reveal more
    // viewport without moving the line the user is reading. Resolve the
    // padding transition immediately and offset the removed space before the
    // browser paints this render; the drawer line can continue its own motion.
    paddingAnimation.cancel()
    scrollDOM.scrollTo({
      behavior: "auto",
      top: Math.max(0, scrollDOM.scrollTop - (startPadding - endPadding)),
    })
  }, [activeTabId, topDrawerCompensationActive])

  React.useLayoutEffect(() => {
    const controller = controllerRef.current
    const content = controller?.view.contentDOM
    if (!controller || !content) return

    let frame: number | null = null
    let settledFrames = 0
    const updateDrawnGeometry = () => {
      controller.requestMeasure()
      const paddingAnimation = content
        .getAnimations()
        .find((animation) =>
          (animation.effect as KeyframeEffect | null)
            ?.getKeyframes()
            .some((keyframe) => keyframe.paddingTop != null)
        )
      if (
        paddingAnimation?.pending ||
        paddingAnimation?.playState === "running"
      ) {
        settledFrames = 0
        frame = requestAnimationFrame(updateDrawnGeometry)
      } else if (settledFrames < 1) {
        settledFrames += 1
        frame = requestAnimationFrame(updateDrawnGeometry)
      } else {
        frame = null
      }
    }

    frame = requestAnimationFrame(updateDrawnGeometry)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [activeTabId, topDrawerCompensationActive])

  React.useEffect(() => {
    if (!topDrawerVisible) return
    const scrollDOM = controllerRef.current?.view.scrollDOM
    if (!scrollDOM) return

    const revealTopContent = () => {
      if (scrollDOM.scrollTop <= TOP_DRAWER_TOP_EDGE_THRESHOLD) {
        // Once the open drawer has made room for the document start, keep that
        // space latched. Removing it merely because the user scrolled past the
        // threshold would itself move the document under their pointer.
        setTopDrawerCompensated(true)
      }
    }

    scrollDOM.addEventListener("scroll", revealTopContent, {
      passive: true,
    })
    return () => scrollDOM.removeEventListener("scroll", revealTopContent)
  }, [activeTabId, topDrawerVisible])

  const handleTopChromeHoverLatchedChange = React.useCallback(
    (latched: boolean) => {
      setTopChromeHoverLatched(latched)
      if (!latched) {
        setTabDragShelfHoverContext(null)
        if (!formattingBarEnabled && !windowsControlDrawerVisible) {
          setTopDrawerCompensated(false)
        }
      }
    },
    [formattingBarEnabled, windowsControlDrawerVisible]
  )
  const handleTabDragShelfVisibleChange = React.useCallback(
    (visible: boolean) => {
      setTopDrawerCompensated(visible && shouldCompensateTopDrawer())
      setTabDragShelfHoverContext(visible ? tabDragShelfContext : null)
    },
    [shouldCompensateTopDrawer, tabDragShelfContext]
  )
  const activeScratchSaveFailed =
    activeTabDescriptor?.backing === "scratch" &&
    scratchSaveFailureTabIds.has(activeTabDescriptor.id)
  const windowProfilePickerDialog =
    platform && windowProfilePicker ? (
      <WindowProfilePicker
        key={windowProfilePicker.requestId ?? "local"}
        initialError={windowProfilePicker.initialError}
        open
        onOpenChange={(open) => {
          if (!open) closeWindowProfilePicker()
        }}
        onSelect={selectWindowProfileFromPicker}
      />
    ) : null

  return (
    <main
      ref={appShellRef}
      className={
        platform === "win32" || platform === "linux"
          ? "app-shell desktop-chrome"
          : "app-shell"
      }
      data-platform={platform ?? undefined}
      data-windows-controls-drawer={
        windowsControlDrawerMetrics ? true : undefined
      }
      data-top-drawer-compensated={topDrawerCompensationActive || undefined}
      data-typography-preview={typographyPreview ? true : undefined}
      data-formatting-bar={formattingDrawerVisible || undefined}
      data-tab-drag-shelf={tabDragShelfVisible || undefined}
      style={
        windowsControlDrawerMetrics
          ? ({
              "--windows-compact-control-drawer-reserved-width": `${
                windowsControlDrawerMetrics.compactWidth + 16
              }px`,
              "--windows-control-drawer-reserved-width": `${
                windowsControlDrawerMetrics.wideWidth + 16
              }px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <div
        ref={launchTintCoverRef}
        aria-hidden="true"
        className="launch-tint-cover"
      />
      <div
        ref={editorHostRef}
        id={DOCUMENT_EDITOR_PANEL_ID}
        aria-label={
          editorPanelTabLabelId
            ? undefined
            : (settingsWorkspacePreviewTitle ?? "Document editor")
        }
        aria-labelledby={editorPanelTabLabelId}
        className="editor-mount select-auto"
        role="tabpanel"
      />

      {platform && activeTabId ? (
        <DeferredTopChrome
          activeTabId={activeTabId}
          canNavigateBack={navigationAvailability.back}
          canNavigateForward={navigationAvailability.forward}
          chrome={appSettings.chrome}
          dragShelfVisible={tabDragShelfVisible}
          editorMode={activeEditorMode}
          editorPanelId={DOCUMENT_EDITOR_PANEL_ID}
          hoverLatched={topChromeHoverLatched}
          hydratingTabIds={hydratingTabIds}
          markdownControlsEnabled={markdownControlsEnabled}
          platform={platform}
          tabDragActive={tabDragActive}
          tabDragSink={tabDragSink}
          tabScrollerRef={topChromeTabScrollerRef}
          tabs={tabDescriptors}
          windowZoomFactor={windowZoomFactor}
          windowMaximized={windowMaximized}
          failurePortalTarget={recoveryNoticeStackElement}
          previewTitle={settingsWorkspacePreviewTitle}
          onActivateTab={(tabId, focusPolicy) =>
            void activateTab(tabId, true, focusPolicy)
          }
          onBeginTabDrag={(tabId, geometry) => {
            syncActiveSession()
            const token = window.pulseMd.beginTabDrag(tabId, geometry)
            if (token) localDragTokensRef.current.set(token, tabId)
            return token
          }}
          onCloseTab={(tabId) => void closeTab(tabId)}
          onDropTab={dropTab}
          onEndTabDrag={endTabDrag}
          onDragShelfVisibleChange={handleTabDragShelfVisibleChange}
          onFind={() => openSearch()}
          onHoverLatchedChange={handleTopChromeHoverLatchedChange}
          onHideTopControls={(controls) => void hideTopControls(controls)}
          onNavigateBack={() => navigateDocumentHistory("back")}
          onNavigateForward={() => navigateDocumentHistory("forward")}
          onEditScratch={editScratchFromTab}
          onOpenOutline={openOutline}
          onOpenSettings={openSettings}
          outlineAnchorRef={outlineAnchorRef}
          outlineOpen={outlineOpen}
          renderOutlinePopover={
            outlineOpen
              ? (trigger) => (
                  <OutlinePopover
                    activeHeading={
                      outlineHeadings.find(
                        (heading) => heading.slug === outlineActiveSlug
                      ) ?? null
                    }
                    anchor={outlineAnchorRef}
                    headings={outlineHeadings}
                    open={outlineOpen}
                    platform={platform}
                    restoreFocus={() => controllerRef.current?.restoreFocus()}
                    trigger={trigger}
                    onHeadingSelect={(heading) => {
                      controllerRef.current?.jumpToHeading(heading)
                    }}
                    onOpenChange={(nextOpen) => {
                      if (nextOpen) openOutline()
                      else closeOutline()
                    }}
                  />
                )
              : undefined
          }
          onCopyPath={(tabId) => void window.pulseMd.copyPath(tabId)}
          onRevealPath={(tabId) => void window.pulseMd.revealPath(tabId)}
          onToggleFormattingToolbar={() => void toggleFormattingBar()}
          onToggleMode={() => controllerRef.current?.toggleMode()}
          onWindowAction={(action) => window.pulseMd.windowAction(action)}
        />
      ) : null}

      {!settingsWorkspacePreviewOpen &&
      platform &&
      activeTabId &&
      formattingToolbarActivated ? (
        <DeferredFormattingToolbar
          fallbackWheelScrollerRef={topChromeTabScrollerRef}
          hoverLatched={topChromeHoverLatched}
          position={appSettings.chrome.formattingBarPosition}
          visible={formattingBarEnabled}
          wheelScrollDirection={appSettings.chrome.tabWheelScrollDirection}
          onHoverLatchedChange={setTopChromeHoverLatched}
          onFormat={formatMarkdown}
        />
      ) : null}

      {deferredEditorChromeActivated ? (
        <DeferredEditorChrome
          chrome={appSettings.chrome}
          contextMenuProps={{
            getController,
            handoff: editorContextMenuHandoff,
            onCopyLink: copyEditorLink,
            onOpenLink: openLink,
            onOpenLinkInNewTab: openLinkInNewTab,
            platform: platform ?? "darwin",
          }}
          failurePortalTarget={recoveryNoticeStackElement}
          linkTooltipRef={linkTooltipRef}
          showStatus={!settingsWorkspacePreviewOpen}
          statusRef={setStatusOverlayHandle}
        />
      ) : null}

      <div
        ref={setRecoveryNoticeStackElement}
        className="recovery-notice-stack pointer-events-none fixed right-2 bottom-8 left-2 z-40 mx-auto flex max-w-[42rem] flex-col items-stretch gap-2"
        data-recovery-notice-stack=""
      >
        {!settingsWorkspacePreviewOpen && activeTabDescriptor?.fileMissing ? (
          <FileMissingNotice
            key={activeTabDescriptor.id}
            displayName={activeTabDescriptor.displayName}
            canSaveContents={
              activeTabDescriptor.dirty ||
              activeTabDescriptor.fileContentsRetained === true
            }
            onLocate={() => locateDocument(activeTabDescriptor.id)}
            onRecreate={() => saveTab(activeTabDescriptor.id)}
            onSaveAs={() => saveTab(activeTabDescriptor.id, true)}
          />
        ) : null}

        {!settingsWorkspacePreviewOpen &&
        activeScratchSaveFailed &&
        activeTabDescriptor ? (
          <ScratchSaveFailureNotice
            key={activeTabDescriptor.id}
            displayName={activeTabDescriptor.displayName}
            onRetry={() =>
              saveTab(activeTabDescriptor.id, false, "scratch-retry")
            }
            onSaveCopy={() => saveTab(activeTabDescriptor.id, true)}
          />
        ) : null}

        {chromePersistenceFailure ? (
          <PersistenceFailureNotice
            message={chromePersistenceFailure.message}
            onDismiss={() => setChromePersistenceFailure(null)}
            onRetry={() =>
              updateChromeFromCommand(
                chromePersistenceFailure.change,
                chromePersistenceFailure.message
              )
            }
          />
        ) : null}

        {!chromePersistenceFailure && lineWrappingPersistenceFailure ? (
          <PersistenceFailureNotice
            message={lineWrappingPersistenceFailure.message}
            onDismiss={() => setLineWrappingPersistenceFailure(null)}
            onRetry={() =>
              persistLineWrapping(lineWrappingPersistenceFailure.lineWrapping)
            }
          />
        ) : null}

        {!chromePersistenceFailure &&
        !lineWrappingPersistenceFailure &&
        zoomPersistenceFailure !== null ? (
          <PersistenceFailureNotice
            message="The zoom change could not be saved and was reverted."
            onDismiss={() => setZoomPersistenceFailure(null)}
            onRetry={async () => {
              const zoomFactor = zoomPersistenceFailure
              setZoomPersistenceFailure(null)
              window.pulseMd.persistWindowZoom(zoomFactor)
            }}
          />
        ) : null}
      </div>

      {!settingsWorkspacePreviewOpen && searchActivated ? (
        <SearchOverlay
          ref={searchOverlayRef}
          focusRequest={searchFocusRequest}
          getController={getController}
          handoffQueue={searchHandoffQueue}
          open={searchOpen}
          onClose={closeSearch}
        />
      ) : null}

      {platform && (settingsOpen || settingsWorkspacePreviewOpen) ? (
        <SettingsDialog
          key={settingsSession}
          activeScheme={resolvedTheme}
          backgroundEffectSupported={
            document.documentElement.dataset.backgroundCapability === platform
          }
          keyboardShortcutsOpen={
            settingsNavigationRoute.kind === "keyboard-shortcuts"
          }
          nestedDialog={
            windowProfilePicker?.parent === "settings"
              ? windowProfilePickerDialog
              : null
          }
          open={settingsOpen}
          platform={platform}
          settings={settingsDialogSettings}
          onCancel={cancelSettings}
          onCustomizeActiveTabIndicator={openActiveTabIndicatorPreview}
          onCustomizeLaunchTransition={openLaunchTransitionPreview}
          onCustomizeTypography={openTypographyPreview}
          onExternalZoomHandlerChange={handleSettingsZoomHandlerChange}
          onLaunchWindowProfile={launchWindowProfileFromSettings}
          onManageScratches={openScratchesWorkspace}
          onManageWindowProfiles={openWindowProfiles}
          onNavigateBack={() => navigateSettingsHistory("back")}
          onOpenKeyboardShortcuts={openKeyboardShortcuts}
          onPreview={previewSettings}
          onSave={saveSettings}
          onSaveHandlerChange={handleSettingsSaveHandlerChange}
        />
      ) : null}

      {platform &&
      (scratchBrowserOpen ||
        scratchesWorkspace?.origin === "scratch-browser") ? (
        <ScratchBrowserSurface
          editScratch={editScratchFromBrowser}
          open={scratchBrowserOpen}
          openScratch={openScratchById}
          platform={platform}
          settings={appSettings}
          onOpenChange={setScratchBrowserVisibility}
        />
      ) : null}

      {windowProfilePicker?.parent === "surface"
        ? windowProfilePickerDialog
        : null}

      {platform && windowProfileCaptureKind ? (
        <WindowProfileCaptureDialog
          key={windowProfileCaptureKind}
          kind={windowProfileCaptureKind}
          tabModes={windowProfileCaptureTabModes}
          onClose={closeWindowProfileCapture}
          onPendingChange={(pending) => {
            windowProfileCapturePendingRef.current = pending
          }}
          onReview={reviewCapturedWindowProfile}
        />
      ) : null}

      {platform && typographyPreview ? (
        <DeferredSettingsWorkspace
          workspace={{
            kind: "typography",
            props: {
              settings: typographyPreview.parentDraft,
              onCancel: cancelTypographyPreview,
              onDockHeightChange: handleTypographyDockHeightChange,
              onDraftChange: previewSettings,
              onSave: saveTypographyPreview,
            },
          }}
        />
      ) : null}

      {platform && activeTabIndicatorPreview ? (
        <DeferredSettingsWorkspace
          workspace={{
            kind: "active-tab-indicator",
            props: {
              settings: activeTabIndicatorPreview.parentDraft,
              onCancel: cancelActiveTabIndicatorPreview,
              onDraftChange: previewSettings,
              onSave: saveActiveTabIndicatorPreview,
            },
          }}
        />
      ) : null}

      {platform && launchTransitionPreview ? (
        <DeferredSettingsWorkspace
          workspace={{
            kind: "launch-transition",
            props: {
              platform,
              settings: launchTransitionPreview.parentDraft,
              onCancel: cancelLaunchTransitionPreview,
              onSave: saveLaunchTransitionPreview,
            },
          }}
        />
      ) : null}

      {platform && windowProfilesWorkspace && windowProfilesWorkspaceVisible ? (
        <DeferredSettingsWorkspace
          workspace={{
            kind: "window-profiles",
            props: {
              composerRoute: windowProfileComposerRoute,
              currentWindowTabModes:
                windowProfilesWorkspace.currentWindowTabModes,
              onBack: () => navigateSettingsHistory("back"),
              onComposerRouteChange: recordWindowProfileComposer,
              onComposerRouteOpen: openWindowProfileComposer,
              onComposerRouteSaved: finishWindowProfileComposer,
              onLaunchProfile: launchWindowProfile,
              onNavigationBlockedChange:
                handleWindowProfilesNavigationBlockedChange,
            },
          }}
        />
      ) : null}

      {platform && scratchesWorkspace && scratchesWorkspaceVisible ? (
        <DeferredSettingsWorkspace
          workspace={{
            kind: "scratches",
            props: {
              backLabel:
                scratchesWorkspace.origin === "settings"
                  ? "Back to Settings"
                  : scratchesWorkspace.origin === "scratch-browser"
                    ? "Back to Open Scratch"
                    : "Back to Editor",
              newScratch: createScratchFromSettings,
              openScratch: openScratchById,
              platform,
              initialSelectedId: scratchesWorkspace.selectedScratchId,
              settings: scratchesWorkspace.parentDraft,
              onBack:
                scratchesWorkspace.origin === "settings"
                  ? () => navigateSettingsHistory("back")
                  : () => returnFromScratchesWorkspace(),
              onNavigationBlockedChange: handleScratchesNavigationBlockedChange,
            },
          }}
        />
      ) : null}
    </main>
  )
}

export default App
