import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import {
  mkdirSync,
  readFileSync,
  watch,
  type FSWatcher,
  type Stats,
} from "node:fs"
import {
  chmod,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { release as operatingSystemRelease } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify, TextDecoder } from "node:util"

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  utilityProcess,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItem,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron"

// Playwright's colorScheme launch option is renderer-only. Align Electron's
// native startup appearance synchronously so the test runner's system-mode
// windows do not expose a light native backing before their first dark paint.
if (!app.isPackaged && process.env.PMD_E2E_FORCE_DARK_MODE === "1") {
  nativeTheme.themeSource = "dark"
}

import {
  ACTIVE_TAB_INDICATOR_COLOR_SOURCES,
  ACTIVE_TAB_INDICATOR_POSITIONS,
  APPEARANCE_MODES,
  BACKGROUND_IDS,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  FILE_PATH_DISPLAY_MODES,
  FORMATTING_BAR_POSITIONS,
  isSpellingToken,
  LAUNCH_TRANSITION_EASINGS,
  LAUNCH_TRANSITION_STRATEGIES,
  MAX_BACKGROUND_BLUR_RADIUS,
  MAX_BACKGROUND_TRANSLUCENCY,
  MAX_ACTIVE_TAB_INDICATOR_THICKNESS,
  MAX_CUSTOM_THEME_PRESET_NAME_LENGTH,
  MAX_HEADING_FONT_SCALE,
  MAX_LAUNCH_TRANSITION_DELAY_MS,
  MAX_LAUNCH_TRANSITION_DURATION_MS,
  MAX_SPELLING_SUGGESTION_COUNT,
  MAX_SPELLING_WORD_LENGTH,
  MAX_TYPOGRAPHY_FONT_SIZE,
  MAX_SOURCE_INDENT_SIZE,
  MAX_ZOOM_FACTOR,
  MIN_BACKGROUND_BLUR_RADIUS,
  MIN_BACKGROUND_TRANSLUCENCY,
  MIN_ACTIVE_TAB_INDICATOR_THICKNESS,
  MIN_HEADING_FONT_SCALE,
  MIN_LAUNCH_TRANSITION_DELAY_MS,
  MIN_LAUNCH_TRANSITION_DURATION_MS,
  MIN_SOURCE_INDENT_SIZE,
  MIN_TYPOGRAPHY_FONT_SIZE,
  MIN_ZOOM_FACTOR,
  normalizeHexColor,
  normalizeCustomThemePresetName,
  normalizeFontFamilyName,
  launchTransitionBezier,
  launchTransitionHasAnimation,
  parseLaunchTransitionCubicBezier,
  rebaseAppSettings,
  resolveAppearanceProfile,
  SERIALIZED_EDITOR_SESSION_VERSION,
  SETTINGS_IMPORT_ACTIONABLE_ERRORS,
  SOURCE_INDENTATIONS,
  SYNTAX_THEME_IDS,
  TAB_VISIBILITY_MODES,
  TAB_WHEEL_SCROLL_DIRECTIONS,
  WINDOWS_MENU_IDS,
  ZOOM_FACTOR_STEP,
  type AppearanceMode,
  type AppearanceProfile,
  type AppearanceSettings,
  type ActiveTabIndicatorColorSource,
  type ActiveTabIndicatorPosition,
  type ActiveTabIndicatorSettings,
  type AppPlatform,
  type AppSettings,
  type BackgroundEffectSettings,
  type BackgroundId,
  type BootstrapPayload,
  type BootstrapTab,
  type ChromeSettings,
  type CliEditorFocusAcknowledgement,
  type CliEditorFocusRequest,
  type CliTabsOpenAcknowledgement,
  type CliTabsOpenRequest,
  type CloseDecision,
  type CopiedHeadingLinkMetadata,
  type DocumentFormat,
  type DocumentKind,
  type DocumentMetadata,
  type DocumentSnapshot,
  type EditorCommand,
  type EditorContextMenuDetails,
  type EditorMenuState,
  type EditorMode,
  type EditorViewport,
  type ExportSettingsResult,
  type ExternalDocumentChange,
  type FilePathDisplayMode,
  type FocusedEditCommand,
  type FormattingBarPosition,
  type LaunchTransitionEasing,
  type LaunchTransitionSettings,
  type LaunchTransitionStrategy,
  type LaunchVisualEffectReady,
  type LocalLinkDisposition,
  type ImportSettingsResult,
  type CustomThemePreset,
  type MarkdownExtensionSettings,
  type NewTabResult,
  type OpenExistingLocalLinkRequest,
  type OpenDocumentResult,
  type OpenLocalLinkResult,
  type OpenScratchResult,
  type PathCompletionEntry,
  type RecoveryAction,
  type ResolvedAppearance,
  type SaveDocumentRequest,
  type SaveDocumentAcknowledgement,
  type SaveDocumentResult,
  type ScratchDocumentIdentity,
  type ScratchEntry,
  type ScratchInventory,
  type ScratchInventoryScope,
  type ScratchOpenDisposition,
  type ScratchPreview,
  type ScratchSortOrder,
  type ScratchUpdate,
  type SerializedEditorSession,
  type SettingsTransferOptions,
  type SourceIndentation,
  type SyntaxThemeId,
  type TabBackingKind,
  type TabColor,
  type TabDescriptor,
  type TabDragEndDetails,
  type TabDragGeometry,
  type TabExportResponse,
  type TabId,
  type TabTransferImport,
  type TabVisibilityMode,
  type TabWheelScrollDirection,
  type TransferId,
  type WindowAction,
  type WindowId,
  type WindowsMenuId,
  type WindowsMenuItemSnapshot,
  type WindowsMenuSnapshot,
  type WindowProfileCaptureKind,
  type WindowProfileFileChoice,
  type WindowProfileLaunchResult,
  type WindowProfilePickerRequest,
  type WindowProfileSeed,
  type WindowProfileTabMode,
  type WindowProfilesSnapshot,
  type WindowSettingsSnapshot,
  type WindowTabsSnapshot,
} from "../src/shared/contracts"
import {
  COMMON_TEXT_DOCUMENT_EXTENSIONS,
  documentKindForPath,
  isInternalTextDocumentPath,
  MARKDOWN_DOCUMENT_EXTENSIONS,
} from "../src/shared/document-kind"
import {
  isScratchLinkScheme,
  isValidScratchLinkFragment,
  parseScratchLinkAddress,
} from "../src/shared/scratch-links"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"
import { ipcChannels } from "./channels"
import {
  applyKeepReadyLoginItem,
  currentKeepReadyLoginItemState,
  shouldQueueCliRequestDuringBackgroundClose,
  shouldKeepReadyAfterCommandQuit,
  shouldKeepReadyWithoutWindow,
} from "./background-readiness"
import {
  captureWindowProfileSeed,
  type CurrentWindowProfileTab,
} from "./profile-capture"
import {
  cliCommandCanRunBeforeApplicationInitialization as parsedCliCommandCanRunBeforeApplicationInitialization,
  CliUsageError,
  parseCliCommand,
  type CliCommand,
  type CliOpenCommand,
  type CliOpenSource,
  type CliWindowPlacement,
} from "./cli-command"
import { formatCliHelp } from "./cli-help"
import { encodeUtf8Bytes, hashDocumentBytes } from "./document-codec"
import { DocumentUtilityClient } from "./document-utility-client"
import { directoryWatchRetryDelay } from "./directory-watch-policy"
import { normalizeDroppedDocumentPaths } from "./dropped-documents"
import {
  modeForAtomicReplacement,
  preserveExistingFileMode,
} from "./file-permissions"
import { renameReplacingFile, syncParentDirectory } from "./file-durability"
import { reconcileAtomicWriteAfterRename } from "./atomic-write-reconciliation"
import {
  addRecentDocumentPath,
  normalizeRecentDocuments,
  recentDocumentsFile,
} from "./recent-documents"
import { filesystemPathCompletions } from "./path-completion"
import {
  copiedHeadingLinkHtml,
  externalHeadingLinkAddress,
  headingLinkForPaste,
  normalizeCopiedHeadingLinkMetadata,
} from "./heading-link-clipboard"
import {
  MAX_SETTINGS_TRANSFER_PROFILES,
  serializeSettingsExport,
  settingsTransferFromExport,
  validatedSettingsExportPath,
} from "./settings-transfer"
import {
  createSettingsArchive,
  isSettingsArchive,
  MAX_SETTINGS_ARCHIVE_BYTES,
  MAX_SETTINGS_ARCHIVE_SCRATCHES,
  parseSettingsArchive,
  type SettingsArchiveScratchInput,
} from "./settings-archive"
import {
  runSettingsImportTransaction,
  type SettingsImportReplacement,
} from "./settings-import-transaction"
import {
  loadSettingsFile,
  resetSettingsFilePreservingOriginal,
} from "./settings-load-recovery"
import {
  drainDeferredExternalRefreshes,
  trackDeferredExternalRefresh,
} from "./tab-mutation-effects"
import { runPendingHydration, type PendingHydration } from "./tab-hydration"
import { tabSizeAllowsIdleHydration } from "./tab-hydration-policy"
import { windowsSessionEndRequiresQuitTransaction } from "./windows-session-end"
import {
  CliResponder,
  CLI_PROTOCOL_VERSION,
  cliEndpointPath,
  startCliServer,
  type CliActiveWindowBounds,
  type CliRawRequest,
  type CliServer,
} from "./cli-server"
import {
  parseLaunchIntent,
  parseLaunchIntentAdditionalData,
  selectStartupLaunchIntent,
  type LaunchIntent,
} from "./launch-intents"
import {
  ProfileNotFoundError,
  ProfileStore,
  validateProfileFileIdentities,
} from "./profile-store"
import { runProfileDeleteTransaction } from "./profile-delete-transaction"
import {
  closeIngressAndDrainOperations,
  runQuiescedOperation,
} from "./quit-drain"
import {
  advanceScopedRequest,
  scopedRequestIsCurrent,
} from "./scoped-request-generation"
import { ScratchStore, type ScratchFileSnapshot } from "./scratch-store"
import {
  migrateStandaloneScratchStorage,
  rewriteCanonicalScratchMarkdownLinkSchemes,
} from "./scratch-migration"
import { acquireSaveTurn } from "./save-turn"
import {
  isProfileIdentifier,
  normalizeProfileSchema,
  type ProfileSchemaV2,
  type ProfileTab,
} from "./profile-schema"
import {
  cliWindowDisplaySelection,
  centeredWindowPosition,
  macWindowButtonPosition,
  minimizeWindowAccelerator,
  rectanglesIntersect,
  shouldPrepareTabTearOut,
  tabTearOutWindowPosition,
  TOP_CHROME_HEIGHT,
  windowsTitleBarOverlay,
  windowsWindowBlurSupported,
  type WindowsTitleBarOverlay,
} from "./window-chrome"
import {
  distributionShouldStartCliServer,
  resolveDistributionIdentity,
  WINDOWS_APP_USER_MODEL_ID,
} from "./distribution-identity"
import { developmentCheckoutIdentity } from "../scripts/development-checkout-identity.mjs"

function packagedDistributionChannel(): unknown {
  if (!app.isPackaged) return undefined
  const metadata = JSON.parse(
    readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")
  ) as { pmdDistributionChannel?: unknown }
  return metadata.pmdDistributionChannel
}

const distributionIdentity = resolveDistributionIdentity(
  app.isPackaged,
  packagedDistributionChannel(),
  app.isPackaged ? undefined : developmentCheckoutIdentity(app.getAppPath())
)
const PRODUCT_NAME = distributionIdentity.productName
const isCanonicalDistribution = distributionIdentity.isCanonicalPackage
const EXTERNAL_SCRATCH_LINK_SCHEME = distributionIdentity.scratchLinkScheme
const PRODUCT_DESCRIPTION = "A fast, polished Markdown reader and editor."
const PRODUCT_COPYRIGHT = "Copyright © 2026 mapleroyal"
const PROJECT_WEBSITE = "https://github.com/mapleroyal/pulse-md"
const REOPEN_CLOSED_DOCUMENT_MENU_ITEM_ID = "reopen-closed-document"
const FILE_NEW_WINDOW_MENU_ITEM_ID = "file-new-window"
const FILE_NEW_TAB_MENU_ITEM_ID = "file-new-tab"
const FILE_NEW_SCRATCH_MENU_ITEM_ID = "file-new-scratch"
const FILE_OPEN_MENU_ITEM_ID = "file-open"
const FILE_OPEN_SCRATCH_MENU_ITEM_ID = "file-open-scratch"
const FILE_OPEN_RECENT_MENU_ITEM_ID = "file-open-recent"
const FILE_WINDOW_PROFILES_MENU_ITEM_ID = "file-window-profiles"
const FILE_WINDOW_PROFILE_PICKER_MENU_ITEM_ID = "file-window-profile-picker"
const FILE_WINDOW_PROFILE_UPDATE_MENU_ITEM_ID = "file-window-profile-update"
const FILE_WINDOW_PROFILE_CREATE_MENU_ITEM_ID = "file-window-profile-create"
const FILE_SAVE_MENU_ITEM_ID = "file-save"
const FILE_SAVE_AS_MENU_ITEM_ID = "file-save-as"
const FILE_SAVE_AS_SCRATCH_MENU_ITEM_ID = "file-save-as-scratch"
const FILE_CLOSE_TAB_MENU_ITEM_ID = "file-close-tab"
const FILE_CLOSE_WINDOW_MENU_ITEM_ID = "file-close-window"
const APP_CLOSE_KEEP_READY_MENU_ITEM_ID = "app-close-keep-ready"
const APP_QUIT_COMPLETELY_MENU_ITEM_ID = "app-quit-completely"
const EDIT_UNDO_MENU_ITEM_ID = "edit-undo"
const EDIT_REDO_MENU_ITEM_ID = "edit-redo"
const EDIT_PASTE_PLAIN_MENU_ITEM_ID = "edit-paste-plain"
const EDIT_SELECT_ALL_MENU_ITEM_ID = "edit-select-all"
const EDIT_FIND_MENU_ITEM_ID = "edit-find"
const EDIT_USE_SELECTION_FOR_FIND_MENU_ITEM_ID = "edit-use-selection-for-find"
const FORMAT_MENU_ITEM_ID = "format-menu"
const SETTINGS_MENU_ITEM_ID = "app-settings"
const HELP_SHORTCUTS_MENU_ITEM_ID = "help-keyboard-shortcuts"
const HELP_SOFTWARE_LICENSES_MENU_ITEM_ID = "help-software-licenses"
const MAX_SETTINGS_TRANSFER_BYTES = MAX_SETTINGS_ARCHIVE_BYTES
const VIEW_MODE_MENU_ITEM_ID = "view-mode"
const VIEW_OUTLINE_MENU_ITEM_ID = "view-outline"
const VIEW_TABS_MENU_ITEM_ID = "view-tabs"
const ZOOM_RESET_MENU_ITEM_ID = "zoom-reset"
const ZOOM_IN_MENU_ITEM_ID = "zoom-in"
const ZOOM_OUT_MENU_ITEM_ID = "zoom-out"
const VIEW_TEXT_WRAPPING_MENU_ITEM_ID = "view-text-wrapping"
const VIEW_FORMATTING_BAR_MENU_ITEM_ID = "view-formatting-bar"
const VIEW_STATUS_BAR_MENU_ITEM_ID = "view-status-bar"
const VIEW_TAB_VISIBILITY_MENU_ITEM_IDS: Record<TabVisibilityMode, string> = {
  always: "view-tabs-always",
  "multiple-tabs": "view-tabs-multiple-tabs",
  mouseover: "view-tabs-mouseover",
  "formatting-bar": "view-tabs-formatting-bar",
  hidden: "view-tabs-hidden",
}
const WINDOWS_MENU_LABELS: Readonly<Record<WindowsMenuId, string>> = {
  file: "File",
  edit: "Edit",
  format: "Format",
  view: "View",
  window: "Window",
  help: "Help",
}
const DRAG_TOKEN_LIFETIME_MS = 30_000
const TAB_EXPORT_TIMEOUT_MS = 10_000
const SETTINGS_SCRATCH_SNAPSHOT_TIMEOUT_MS = 10_000
const DETACH_VALIDATION_TIMEOUT_MS = 1_500
const SOURCE_RETIREMENT_ACK_TIMEOUT_MS = 1_500
const TAB_DRAG_TRACKING_INTERVAL_MS = 16
const INTERNAL_TAB_DROP_CLAIM_GRACE_MS = 120
const DEFAULT_WINDOW_SIZE = { width: 900, height: 720 } as const
const MIN_WINDOW_SIZE = { width: 480, height: 320 } as const
const MAX_WINDOW_DIMENSION = 32_768
const WINDOW_SIZE_PERSIST_DELAY_MS = 250
const WINDOW_BACKGROUND_THROTTLING_ENABLED = true
const ZOOM_FACTOR_EPSILON = 1e-6
const MIN_VISUAL_ZOOM_SCALE = 1
const MAX_VISUAL_ZOOM_SCALE = 5
const WINDOWS_WM_DESTROY = 0x0002
const PULSE_MD_APP_SCHEME = "pulse-md"
const SCRATCH_SORT_ORDERS: readonly ScratchSortOrder[] = [
  "last-opened",
  "last-edited",
  "created",
  "title",
  "filename",
]
const SCRATCH_INVENTORY_SCOPES: readonly ScratchInventoryScope[] = [
  "scratch-browser",
  "window-profiles",
]
const PULSE_MD_IMAGE_SCHEME = "pulse-md-image"
const MAX_CUSTOM_THEME_PRESET_ID_LENGTH = 64
const EXTERNAL_CHANGE_DEBOUNCE_MS = 180
const EXTERNAL_CHANGE_RETRY_MS = 350
const DIRECTORY_WATCH_STABILITY_RESET_MS = 30_000
const SAVE_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000
const CLOSE_SAVE_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000
const WINDOW_CLOSE_PREPARATION_TIMEOUT_MS = 12_000
const RECOGNIZED_DOCUMENT_EXTENSIONS = new Set<string>([
  ...MARKDOWN_DOCUMENT_EXTENSIONS,
  ...COMMON_TEXT_DOCUMENT_EXTENSIONS,
])
const DOCUMENT_OPEN_FILTERS = [
  { name: "Markdown", extensions: [...MARKDOWN_DOCUMENT_EXTENSIONS] },
  {
    name: "Text and Code",
    extensions: [...COMMON_TEXT_DOCUMENT_EXTENSIONS],
  },
  { name: "All Files", extensions: ["*"] },
]
const tabTearOutPreviewSupported = !(
  process.platform === "linux" &&
  (app.commandLine.getSwitchValue("ozone-platform") === "wayland" ||
    (!app.commandLine.getSwitchValue("ozone-platform") &&
      process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland"))
)
const launchBenchmark = process.env.PMD_LAUNCH_BENCHMARK === "1"
const LAUNCH_VISUAL_BENCHMARK_PREFIX = "PMD_LAUNCH_VISUAL_BENCHMARK "
const LAUNCH_VISUAL_BENCHMARK_MODES = ["opaque", "deferred", "eager"] as const
type LaunchVisualBenchmarkMode = (typeof LAUNCH_VISUAL_BENCHMARK_MODES)[number]

function launchVisualBenchmarkMode(): LaunchVisualBenchmarkMode | null {
  if (!launchBenchmark) return null
  const value = process.env.PMD_LAUNCH_VISUAL_MODE
  if (value === undefined || value === "") return null
  if (
    LAUNCH_VISUAL_BENCHMARK_MODES.includes(value as LaunchVisualBenchmarkMode)
  ) {
    return value as LaunchVisualBenchmarkMode
  }
  throw new TypeError(`Invalid launch visual benchmark mode: ${value}`)
}

const launchVisualMode = launchVisualBenchmarkMode()
let launchVisualBenchmarkAddonLoadReadyEpochMs: number | null = null
let launchVisualBenchmarkAddonLoadStartedEpochMs: number | null = null

function launchBenchmarkEpochMs(): number {
  return performance.timeOrigin + performance.now()
}

const cliBootstrapLaunch = process.argv.includes("--pmd-cli-server")
const isolatedUserDataLaunch = process.argv.some(
  (argument) =>
    argument === "--user-data-dir" || argument.startsWith("--user-data-dir=")
)
const shouldStartCliServer = distributionShouldStartCliServer({
  explicitEndpoint: process.env.PMD_CLI_ENDPOINT !== undefined,
  isolatedUserData: isolatedUserDataLaunch,
})

interface TabState {
  backing: TabBackingKind
  color?: TabColor
  diskContentHash: string | null
  diskFingerprint: FileFingerprint | null
  fileMissing: boolean
  id: TabId
  dirty: boolean
  document: DocumentSnapshot
  ioPath: string | null
  ownerWindowId: WindowId
  profileOrigin: { profileId: string; tabId: string } | null
  pendingSaveCount: number
  pendingSaveTokens: Set<string>
  saveGeneration: number
  saveIdleWaiters: Set<() => void>
  saveQueue: Promise<void>
  scratchIdentity: ScratchDocumentIdentity | null
  title: string | null
}

interface PreparedTab {
  backing: TabBackingKind
  baselineContent?: string
  color?: TabColor
  contentHash: string | null
  deferredLoad?: () => Promise<PreparedTab>
  diskFingerprint: FileFingerprint | null
  dirty: boolean
  document: DocumentSnapshot
  fileMissing?: boolean
  initialCursor?: { line: number; column: number }
  initialEditorMode?: EditorMode
  ioPath: string | null
  profileOrigin?: { profileId: string; tabId: string }
  scratchIdentity?: ScratchDocumentIdentity
  title?: string
}

interface DirectoryWatchState {
  directoryPath: string
  tabIdsByFilenameKey: Map<string, Set<TabId>>
  tabIds: Set<TabId>
  watcher: FSWatcher
}

interface DirectoryWatchRecoveryState {
  consecutiveFailureCount: number
  pendingTabIds: Set<TabId>
  retryTimer: ReturnType<typeof setTimeout> | null
  stabilityTimer: ReturnType<typeof setTimeout> | null
}

interface LoadedDocument {
  contentHash: string
  document: DocumentSnapshot
  fingerprint: FileFingerprint
  ioPath: string
}

interface StableFileBytes {
  buffer: Buffer
  fingerprint: FileFingerprint
  ioPath: string
  mode: number
}

interface FileFingerprint {
  readonly ctimeMs: number
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
}

interface SaveTargetBaseline {
  readonly contentHash: string | null
  readonly mode: number | undefined
  readonly mtimeMs: number | null
}

interface SaveTargetApproval {
  readonly baseline: SaveTargetBaseline
  readonly replacementMode: number | undefined
}

interface AtomicWriteReplacementApproval {
  readonly mode: number | undefined
  validate(): Promise<boolean>
}

interface AtomicWriteOptions {
  readonly acceptStableExpectedBytesAfterReplacementMismatch?: boolean
}

interface PendingExternalDocumentChange {
  change: ExternalDocumentChange
  contentHash: string
  fingerprint: FileFingerprint
  ownerWindowId: WindowId
}

interface PendingCloseSave {
  tabId: TabId
  resolve: (allow: boolean) => void
  timeout: ReturnType<typeof setTimeout> | null
}

interface PendingWindowClosePreparation {
  resolve: (allow: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PendingTabHydration extends PendingHydration<BootstrapTab> {
  initialEditorMode?: EditorMode
  recordRecentDocument: boolean
}

interface CliWaitTracker {
  id: string
  remainingTabIds: Set<TabId>
  responder: CliResponder
  unsubscribeDisconnect: () => void
}

interface PendingCliTabsOpen {
  activeTabId: TabId
  ownerWindowId: WindowId
  resolve: (accepted: boolean) => void
  tabIds: TabId[]
  timeout: ReturnType<typeof setTimeout>
}

interface PendingCliEditorFocus {
  ownerWindowId: WindowId
  resolve: (accepted: boolean) => void
  tabId: TabId
  timeout: ReturnType<typeof setTimeout>
}

interface PendingWindowProfilePicker {
  ownerWindowId: WindowId
  resolve: (profileId: string | null) => void
  unsubscribeDisconnect: () => void
}

interface PendingEditorCommandAcknowledgement {
  ownerWindowId: WindowId
  resolve: (handled: boolean) => void
}

interface PendingSettingsImport {
  readonly filePath: string
  readonly id: string
  readonly ownerWindowId: WindowId
  readonly profiles: readonly ProfileSchemaV2[]
  readonly scratches: readonly SettingsArchiveScratchInput[]
}

interface PendingExternalScratchActivation {
  readonly fragment: string | null
  readonly scratchId: string
  readonly tabId: TabId
}

interface SettingsScratchSnapshotTarget {
  readonly ownerWindowId: WindowId
  readonly runtimeTabId: TabId
  readonly scratchId: string
}

interface SettingsScratchContentSnapshot {
  readonly content: Buffer
  readonly modifiedAt: number
  readonly scratchId: string
}

interface PendingSettingsScratchSnapshot {
  readonly expectedTargets: ReadonlyMap<TabId, SettingsScratchSnapshotTarget>
  readonly maximumBytes: number
  readonly ownerWindowId: WindowId
  readonly reject: (error: Error) => void
  readonly resolve: (scratches: SettingsScratchContentSnapshot[]) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

type TabCloseApproval = "clean" | "discard" | "save"

interface PendingSaveAcknowledgement {
  generation: number
  ownerWindowId: WindowId
  revision: number
  tabId: TabId
  timeout: ReturnType<typeof setTimeout>
  token: string
}

interface TrustedRendererLocation {
  host: string
  pathname: string
  protocol: string
}

interface WindowState {
  activeTabId: TabId
  allowClose: boolean
  appliedBackgroundBlurAnimationActive: boolean
  appliedBackgroundEffectSignature: string | null
  appliedBackgroundBlurRadius: number
  appliedWindowsAlphaBootstrap: boolean
  appliedWindowsTitleBarOverlaySignature: string | null
  appearancePreview: AppearanceSettings | null
  approvedTabCloses: Map<TabId, TabCloseApproval>
  bootstrapPending: boolean
  closeSequence: Promise<boolean> | null
  editorCommandDrainActive: boolean
  editorCommandHandlingReady: boolean
  editorMenuState: EditorMenuState
  editorReady: boolean
  editorReadyWaiters: Set<() => void>
  eagerLaunchVisualEffectApplied: boolean
  launchSettings: AppSettings
  launchVisualBenchmark: {
    browserWindowCreatedEpochMs: number
    browserWindowCreateStartedEpochMs: number
    editorReadyEpochMs: number | null
    emitted: boolean
    mode: LaunchVisualBenchmarkMode
    showRequestedEpochMs: number | null
    shownEpochMs: number | null
    visualEffectApplied: boolean | null
    visualEffectReadyEpochMs: number | null
    visualEffectStartedEpochMs: number | null
  } | null
  launchOverrides: {
    editorMode?: EditorMode
    tabVisibility?: TabVisibilityMode
  }
  lineWrapping: boolean
  pendingLaunchVisualEffect: {
    prefersReducedMotion: boolean
    settings: AppSettings
  } | null
  pendingWindowVisualEffectTask: ReturnType<typeof setImmediate> | null
  pendingEditorCommands: EditorCommand[]
  pendingCloseSave: PendingCloseSave | null
  pendingWindowClosePreparation: PendingWindowClosePreparation | null
  pathCompletionGeneration: number
  scratchInventoryGenerations: Map<ScratchInventoryScope, number>
  tabMutationExternalRefreshTabIds: Set<TabId>
  tabMutationLocked: boolean
  tabMutationMetadataChanged: boolean
  tabMutationWaiters: Set<() => void>
  tabHydrations: Map<TabId, PendingTabHydration>
  profileId: string | null
  profileInheritedEditorMode: EditorMode | null
  profileLaunchDefinition: ProfileSchemaV2 | null
  provisional: boolean
  recoveryInProgress: boolean
  recoverySurfaceActive: boolean
  rememberWhenClosed: boolean
  rendererReady: boolean
  tabIds: TabId[]
  trustedRendererLocation: TrustedRendererLocation
  visualEffectRevision: number
  win: BrowserWindow
  windowsMenuActions: Map<string, MenuItem>
}

interface MacWindowBlurAddon {
  animateWindowBackgroundBlur(
    nativeHandle: Buffer,
    radius: number,
    durationMs: number,
    delayMs: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): boolean
  setWindowBackgroundEffect(
    nativeHandle: Buffer,
    radius: number,
    red: number,
    green: number,
    blue: number,
    opacity: number
  ): boolean
  tabDragEscapeKeyPressed(): boolean
}

interface WindowsWindowBlurAddon {
  animateWindowBackgroundBlur(
    nativeHandle: Buffer,
    ownerId: number,
    radius: number,
    durationMs: number,
    delayMs: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): boolean
  clearWindowBackgroundEffect(nativeHandle: Buffer, ownerId: number): boolean
  setWindowBackgroundEffect(
    nativeHandle: Buffer,
    ownerId: number,
    radius: number,
    red: number,
    green: number,
    blue: number,
    opacity: number
  ): boolean
}

interface NativeWindowBackgroundEffect {
  backgroundColor: string
  blurRadius: number
  blue: number
  green: number
  opacity: number
  red: number
}

interface ClosedDocument {
  filePath: string | null
  originWindowId: WindowId
  viewport: EditorViewport | null
}

interface DragTokenState {
  cancelled: boolean
  claimedTransferId: TransferId | null
  createdAt: number
  editorSession: SerializedEditorSession | null
  exportRequestId: TransferId | null
  exportWaiters: Set<(session: SerializedEditorSession | null) => void>
  geometry: TabDragGeometry | null
  lastCursorPoint: { x: number; y: number } | null
  sourceWindowId: WindowId
  tabId: TabId
  timeout: ReturnType<typeof setTimeout>
  token: string
}

interface TabDetachBaseline {
  diskContentHash: string | null
  filePath: string | null
  ioPath: string | null
  mtimeMs: number | null
  saveGeneration: number
}

interface PendingTabDetach {
  baseline: TabDetachBaseline
  creatingTarget: boolean
  dragToken: string
  editorSession: SerializedEditorSession | null
  finalScreenPoint: { x: number; y: number } | null
  lastPreviewPosition: { x: number; y: number } | null
  previewVisible: boolean
  released: boolean
  retirementTimeout: ReturnType<typeof setTimeout> | null
  sourceBackgroundRenderingLeaseActive: boolean
  sourceVisuallyRetired: boolean
  sourceRetirementAcknowledged: boolean
  sourceWindowId: WindowId
  tabId: TabId
  targetRendererReady: boolean
  targetWindowId: WindowId | null
  timeout: ReturnType<typeof setTimeout> | null
  validationId: TransferId | null
  validationValid: boolean | null
  validating: boolean
}

interface PendingTransfer {
  dragToken: string
  editorSession: SerializedEditorSession | null
  sourceWindowId: WindowId
  tabId: TabId
  targetConfirmed: boolean
  targetIndex: number
  targetWindowId: WindowId
  timeout: ReturnType<typeof setTimeout> | null
  transferId: TransferId
}

interface PendingDetachValidation {
  resolve: (valid: boolean) => void
  sourceWindowId: WindowId
  tabId: TabId
  targetWindowId: WindowId
  timeout: ReturnType<typeof setTimeout>
  validationId: TransferId
}

interface CreateWindowOptions {
  activeIndex?: number
  existingTab?: {
    editorSession: SerializedEditorSession
    tabId: TabId
  }
  filePaths?: string[]
  initialViewports?: readonly (EditorViewport | null)[]
  launchOverrides?: {
    editorMode?: EditorMode
    tabVisibility?: TabVisibilityMode
  }
  onCreated?: (win: BrowserWindow, state: WindowState) => void
  position?: { x: number; y: number }
  preparedTabs?: PreparedTab[]
  profileDefinition?: ProfileSchemaV2
  provisional?: boolean
  showAfterLoad?: boolean
  size?: WindowSize
}

interface WindowSize {
  height: number
  width: number
}

const windowStates = new Map<WindowId, WindowState>()
const tabStates = new Map<TabId, TabState>()
const openScratchTabs = new Map<string, TabId>()
const closedDocumentHistory: ClosedDocument[] = []
const dragTokens = new Map<string, DragTokenState>()
const activeDragTokens = new Set<string>()
const pendingTransfers = new Map<TransferId, PendingTransfer>()
const pendingTabDetaches = new Map<string, PendingTabDetach>()
const backgroundRenderingLeaseCounts = new Map<WindowId, number>()
const pendingDetachValidations = new Map<TransferId, PendingDetachValidation>()
const pendingLaunchIntents: LaunchIntent[] = []
const pendingExternalScratchActivations = new Map<
  WindowId,
  PendingExternalScratchActivation
>()
const pendingOpenFiles: string[] = []
const pendingCliRequests: CliRawRequest[] = []
const directoryWatches = new Map<string, DirectoryWatchState>()
const directoryWatchRecoveries = new Map<string, DirectoryWatchRecoveryState>()
const watchedDirectoryByTab = new Map<TabId, string>()
const watchedFilenameKeyByTab = new Map<TabId, string>()
const recoveringWatchDirectoryByTab = new Map<TabId, string>()
const externalRefreshTimers = new Map<TabId, ReturnType<typeof setTimeout>>()
const forcedExternalRefreshes = new Set<TabId>()
const externalMissingFileRetries = new Set<TabId>()
const pendingExternalDocumentChanges = new Map<
  TabId,
  PendingExternalDocumentChange
>()
const pendingExternalChangeTabsByChangeId = new Map<string, TabId>()
const pendingSaveAcknowledgements = new Map<
  string,
  PendingSaveAcknowledgement
>()
const cliWaitTrackers = new Map<string, CliWaitTracker>()
const pendingCliEditorFocus = new Map<string, PendingCliEditorFocus>()
const pendingCliTabsOpen = new Map<string, PendingCliTabsOpen>()
const pendingWindowProfilePickers = new Map<
  string,
  PendingWindowProfilePicker
>()
const windowProfilePickerHostClaims = new Set<WindowId>()
const pendingEditorCommandAcknowledgements = new Map<
  string,
  PendingEditorCommandAcknowledgement
>()
const pendingSettingsScratchSnapshots = new Map<
  string,
  PendingSettingsScratchSnapshot
>()
const profileWindows = new Map<string, WindowId>()
const documentUtility = new DocumentUtilityClient(() =>
  utilityProcess.fork(path.join(__dirname, "document-utility.cjs"), [], {
    serviceName: "Markdown document processing",
    stdio: "ignore",
  })
)

let applicationInitialized = false
let applicationInitializationRequested = false
let activationRequestsBeforeApplicationInitialization = 0
let resolveApplicationInitializationRequest: (() => void) | null = null
const applicationInitializationRequest = new Promise<void>((resolve) => {
  resolveApplicationInitializationRequest = resolve
})
let queuedCliRequestCount = 0
let cliRequestQueue: Promise<void> = Promise.resolve()
const activeCliRequestOperations = new Set<Promise<void>>()
let managedResourceOperationQueue: Promise<void> = Promise.resolve()
let applicationPersistenceQuiescing = false
let cliServer: CliServer | null = null
let cliServerStartPromise: Promise<CliServer> | null = null
let cliServerClosePromise: Promise<void> | null = null

function serializeManagedResourceOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = managedResourceOperationQueue
    .catch(() => undefined)
    .then(operation)
  managedResourceOperationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function trackCliRequestOperation(operation: Promise<void>): Promise<void> {
  activeCliRequestOperations.add(operation)
  void operation.then(
    () => activeCliRequestOperations.delete(operation),
    () => activeCliRequestOperations.delete(operation)
  )
  return operation
}

async function drainCliRequestOperations(): Promise<void> {
  await cliRequestQueue.catch(() => undefined)
  while (activeCliRequestOperations.size > 0) {
    await Promise.allSettled([...activeCliRequestOperations])
  }
}

function closeCliServerIngress(): Promise<void> {
  cliServerClosePromise ??= (async () => {
    const server =
      cliServer ?? (await cliServerStartPromise?.catch(() => null)) ?? null
    if (!server) return
    await server.close()
    if (cliServer === server) cliServer = null
  })()
  return cliServerClosePromise
}
let allowApplicationQuit = false
let applicationQuitSequence: Promise<boolean> | null = null
let applicationCloseSequenceKind: "background" | "quit" | null = null
let completeQuitRequestedDuringBackgroundClose = false
let relaunchRequestedDuringBackgroundClose = false
let activationRequestedDuringApplicationClose = false
let activationWindowRequest: ReturnType<typeof setImmediate> | null = null
let pendingLaunchWindowCount = 0
let settings: AppSettings = cloneAppSettings(DEFAULT_APP_SETTINGS)
let settingsLoadPromise: Promise<AppSettings> | null = null
let settingsLoadFailure: { readonly error: unknown } | null = null
let settingsRecoveryPresented = false
let settingsRecoveryReleased = false
let releaseSettingsRecovery: (() => void) | null = null
const settingsRecovery = new Promise<void>((resolve) => {
  releaseSettingsRecovery = resolve
})
let windowSizeLoadPromise: Promise<void> | null = null
let initialDefaultWindowProfileLoadPromise: Promise<ProfileSchemaV2 | null> | null =
  null
let settingsWriteQueue: Promise<void> = Promise.resolve()
let settingsSessionOwnerWindowId: WindowId | null = null
let pendingSettingsImport: PendingSettingsImport | null = null
let zoomPersistenceRevision = 0
let rememberedWindowSize: WindowSize = { ...DEFAULT_WINDOW_SIZE }
let persistedWindowSize: WindowSize = { ...DEFAULT_WINDOW_SIZE }
let windowSizePersistTimer: ReturnType<typeof setTimeout> | null = null
let windowSizeWriteQueue: Promise<void> = Promise.resolve()
let recentDocuments: string[] = []
let persistedRecentDocuments: string[] = []
let recentDocumentsLoadPromise: Promise<void> | null = null
let recentDocumentsPersistenceTask: ReturnType<typeof setImmediate> | null =
  null
let recentDocumentsWriteQueue: Promise<void> = Promise.resolve()
let recentDocumentsMenuRefresh: ReturnType<typeof setImmediate> | null = null
let macWindowBlurAddon: MacWindowBlurAddon | null | undefined
let macWindowBlurWarningShown = false
let windowsWindowBlurAddon: WindowsWindowBlurAddon | null | undefined
let windowsWindowBlurWarningShown = false
let windowsNativeChromeWarningShown = false
let backgroundActivationPolicyActive = false

function enterBackgroundActivationPolicy(): void {
  if (process.platform !== "darwin" || backgroundActivationPolicyActive) return
  app.setActivationPolicy("accessory")
  backgroundActivationPolicyActive = true
}

function restoreForegroundActivationPolicy(): void {
  if (process.platform !== "darwin") return
  if (backgroundActivationPolicyActive) {
    app.setActivationPolicy("regular")
    backgroundActivationPolicyActive = false
  }
  if (app.isHidden()) app.show()
}

function requestApplicationInitialization(
  prefetchInitialDefaultWindowProfile = false
): void {
  if (
    prefetchInitialDefaultWindowProfile &&
    initialLaunchIntent.kind === "new-window" &&
    initialLaunchIntent.filePaths.length === 0
  ) {
    initialDefaultWindowProfileLoadPromise ??= ensureScratchMigration().then(
      configuredDefaultWindowProfile
    )
  }
  if (applicationInitializationRequested) return
  applicationInitializationRequested = true
  settingsLoadPromise ??= loadSettings()
  windowSizeLoadPromise ??= loadWindowSize()
  recentDocumentsLoadPromise ??= loadRecentDocuments()
  resolveApplicationInitializationRequest?.()
  resolveApplicationInitializationRequest = null
}
let lastFocusedWindowId: WindowId | null = null

const requireNativeModule = createRequire(__filename)
const execFileAsync = promisify(execFile)

protocol.registerSchemesAsPrivileged([
  {
    scheme: PULSE_MD_APP_SCHEME,
    privileges: {
      codeCache: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

if (process.platform === "win32" && app.isPackaged) {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
}
app.setName(PRODUCT_NAME)
if (!isCanonicalDistribution && !isolatedUserDataLaunch) {
  const distributionUserDataPath = path.join(
    app.getPath("appData"),
    distributionIdentity.userDataDirectoryName
  )
  if (distributionIdentity.isDevelopment) {
    mkdirSync(distributionUserDataPath, { recursive: true })
  }
  app.setPath("userData", distributionUserDataPath)
}
app.setAboutPanelOptions({
  applicationName: PRODUCT_NAME,
  applicationVersion: app.getVersion(),
  copyright: PRODUCT_COPYRIGHT,
  credits: PRODUCT_DESCRIPTION,
})
let wasOpenedAtLogin = false
const macLoginLaunchDetectionPending =
  process.platform === "darwin" && app.isPackaged
if (macLoginLaunchDetectionPending) {
  // Electron learns whether macOS supplied the login-item Apple event while
  // finishing application launch. Start without foreground presence until
  // that value is available so a real login launch cannot flash UI or a Dock
  // icon; ordinary launches restore the regular policy as soon as ready fires.
  enterBackgroundActivationPolicy()
}
if (
  app.isPackaged &&
  !isolatedUserDataLaunch &&
  !cliBootstrapLaunch &&
  !app.isDefaultProtocolClient(EXTERNAL_SCRATCH_LINK_SCHEME)
) {
  if (!app.setAsDefaultProtocolClient(EXTERNAL_SCRATCH_LINK_SCHEME)) {
    console.warn(
      `Unable to register ${PRODUCT_NAME} as the ${EXTERNAL_SCRATCH_LINK_SCHEME} URL handler`
    )
  }
}

const profileStore = new ProfileStore(app.getPath("userData"))
const scratchStore = new ScratchStore(app.getPath("userData"))
let scratchMigrationPromise: ReturnType<
  typeof migrateStandaloneScratchStorage
> | null = null
function ensureScratchMigration() {
  scratchMigrationPromise ??= migrateStandaloneScratchStorage(
    profileStore,
    scratchStore,
    EXTERNAL_SCRATCH_LINK_SCHEME
  )
  void scratchMigrationPromise.catch(() => undefined)
  return scratchMigrationPromise
}

let initialLaunchIntent: LaunchIntent
try {
  initialLaunchIntent = parseLaunchIntent(process.argv, {
    expectedScratchLinkScheme: EXTERNAL_SCRATCH_LINK_SCHEME,
    isPackaged: app.isPackaged,
    workingDirectory: process.cwd(),
  })
} catch (error) {
  console.warn("Ignoring invalid initial launch intent", error)
  initialLaunchIntent = { kind: "new-window", filePaths: [] }
}
const ownsSingleInstanceLock = app.requestSingleInstanceLock(
  cliBootstrapLaunch
    ? { kind: "cli-bootstrap", protocolVersion: 1 }
    : initialLaunchIntent
)

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return APPEARANCE_MODES.includes(value as AppearanceMode)
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === "live" || value === "source"
}

function isResolvedAppearance(value: unknown): value is ResolvedAppearance {
  return value === "light" || value === "dark"
}

function isBackgroundId(value: unknown): value is BackgroundId {
  return BACKGROUND_IDS.includes(value as BackgroundId)
}

function isSyntaxThemeId(value: unknown): value is SyntaxThemeId {
  return SYNTAX_THEME_IDS.includes(value as SyntaxThemeId)
}

function isSourceIndentation(value: unknown): value is SourceIndentation {
  return SOURCE_INDENTATIONS.includes(value as SourceIndentation)
}

function isFilePathDisplayMode(value: unknown): value is FilePathDisplayMode {
  return FILE_PATH_DISPLAY_MODES.includes(value as FilePathDisplayMode)
}

function isFormattingBarPosition(
  value: unknown
): value is FormattingBarPosition {
  return FORMATTING_BAR_POSITIONS.includes(value as FormattingBarPosition)
}

function isTabVisibilityMode(value: unknown): value is TabVisibilityMode {
  return TAB_VISIBILITY_MODES.includes(value as TabVisibilityMode)
}

function isTabWheelScrollDirection(
  value: unknown
): value is TabWheelScrollDirection {
  return TAB_WHEEL_SCROLL_DIRECTIONS.includes(value as TabWheelScrollDirection)
}

function isActiveTabIndicatorPosition(
  value: unknown
): value is ActiveTabIndicatorPosition {
  return ACTIVE_TAB_INDICATOR_POSITIONS.includes(
    value as ActiveTabIndicatorPosition
  )
}

function isActiveTabIndicatorColorSource(
  value: unknown
): value is ActiveTabIndicatorColorSource {
  return ACTIVE_TAB_INDICATOR_COLOR_SOURCES.includes(
    value as ActiveTabIndicatorColorSource
  )
}

function normalizeActiveTabIndicatorSettings(
  value: unknown
): ActiveTabIndicatorSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Active tab indicator settings must be an object")
  }

  const candidate = value as Partial<ActiveTabIndicatorSettings>
  const customColor =
    typeof candidate.customColor === "string"
      ? normalizeHexColor(candidate.customColor)
      : null
  if (
    !Array.isArray(candidate.positions) ||
    candidate.positions.some(
      (position) => !isActiveTabIndicatorPosition(position)
    ) ||
    new Set(candidate.positions).size !== candidate.positions.length ||
    !isActiveTabIndicatorColorSource(candidate.colorSource) ||
    !customColor ||
    typeof candidate.adaptCustomColor !== "boolean" ||
    typeof candidate.thickness !== "number" ||
    !Number.isInteger(candidate.thickness) ||
    candidate.thickness < MIN_ACTIVE_TAB_INDICATOR_THICKNESS ||
    candidate.thickness > MAX_ACTIVE_TAB_INDICATOR_THICKNESS
  ) {
    throw new TypeError("Invalid active tab indicator settings")
  }

  return {
    positions: ACTIVE_TAB_INDICATOR_POSITIONS.filter((position) =>
      candidate.positions!.includes(position)
    ),
    colorSource: candidate.colorSource,
    customColor,
    adaptCustomColor: candidate.adaptCustomColor,
    thickness: candidate.thickness,
  }
}

function isLaunchTransitionEasing(
  value: unknown
): value is LaunchTransitionEasing {
  return LAUNCH_TRANSITION_EASINGS.includes(value as LaunchTransitionEasing)
}

function isLaunchTransitionStrategy(
  value: unknown
): value is LaunchTransitionStrategy {
  return LAUNCH_TRANSITION_STRATEGIES.includes(
    value as LaunchTransitionStrategy
  )
}

function normalizeAppearanceProfile(value: unknown): AppearanceProfile {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Appearance profile must be an object")
  }

  const candidate = value as Partial<AppearanceProfile>
  const customBackgroundColor =
    typeof candidate.customBackgroundColor === "string"
      ? normalizeHexColor(candidate.customBackgroundColor)
      : null
  if (
    !isBackgroundId(candidate.backgroundId) ||
    !isSyntaxThemeId(candidate.syntaxThemeId) ||
    !customBackgroundColor
  ) {
    throw new TypeError("Invalid appearance profile")
  }

  return {
    backgroundId: candidate.backgroundId,
    customBackgroundColor,
    syntaxThemeId: candidate.syntaxThemeId,
  }
}

function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Appearance settings must be an object")
  }

  const candidate = value as Partial<AppearanceSettings>
  const rawBackgroundEffect =
    candidate.backgroundEffect ?? DEFAULT_APP_SETTINGS.backgroundEffect
  if (
    !isAppearanceMode(candidate.appearanceMode) ||
    typeof candidate.themeByScheme !== "object" ||
    candidate.themeByScheme === null
  ) {
    throw new TypeError("Invalid appearance settings")
  }

  if (typeof rawBackgroundEffect !== "object" || rawBackgroundEffect === null) {
    throw new TypeError("Invalid background effect settings")
  }
  const backgroundEffect =
    rawBackgroundEffect as Partial<BackgroundEffectSettings>
  const translucentCallouts =
    backgroundEffect.translucentCallouts ??
    DEFAULT_APP_SETTINGS.backgroundEffect.translucentCallouts
  const translucentCodeBlocks =
    backgroundEffect.translucentCodeBlocks ??
    DEFAULT_APP_SETTINGS.backgroundEffect.translucentCodeBlocks
  const translucentInlineCode =
    backgroundEffect.translucentInlineCode ??
    DEFAULT_APP_SETTINGS.backgroundEffect.translucentInlineCode
  if (
    typeof backgroundEffect.enabled !== "boolean" ||
    typeof translucentCallouts !== "boolean" ||
    typeof translucentCodeBlocks !== "boolean" ||
    typeof translucentInlineCode !== "boolean" ||
    typeof backgroundEffect.translucency !== "number" ||
    !Number.isFinite(backgroundEffect.translucency) ||
    backgroundEffect.translucency < MIN_BACKGROUND_TRANSLUCENCY ||
    backgroundEffect.translucency > MAX_BACKGROUND_TRANSLUCENCY ||
    typeof backgroundEffect.blurRadius !== "number" ||
    !Number.isInteger(backgroundEffect.blurRadius) ||
    backgroundEffect.blurRadius < MIN_BACKGROUND_BLUR_RADIUS ||
    backgroundEffect.blurRadius > MAX_BACKGROUND_BLUR_RADIUS
  ) {
    throw new TypeError("Invalid background effect settings")
  }

  return {
    appearanceMode: candidate.appearanceMode,
    backgroundEffect: {
      enabled: backgroundEffect.enabled,
      translucentCallouts,
      translucentCodeBlocks,
      translucentInlineCode,
      translucency: backgroundEffect.translucency,
      blurRadius: backgroundEffect.blurRadius,
    },
    themeByScheme: {
      light: normalizeAppearanceProfile(candidate.themeByScheme.light),
      dark: normalizeAppearanceProfile(candidate.themeByScheme.dark),
    },
  }
}

function normalizeCustomThemePresets(value: unknown): CustomThemePreset[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid custom theme presets")
  }

  const ids = new Set<string>()
  const names = new Set<string>()
  return value.map((rawPreset) => {
    if (typeof rawPreset !== "object" || rawPreset === null) {
      throw new TypeError("Custom theme preset must be an object")
    }

    const preset = rawPreset as Partial<CustomThemePreset>
    const name =
      typeof preset.name === "string"
        ? normalizeCustomThemePresetName(preset.name)
        : null
    if (
      typeof preset.id !== "string" ||
      preset.id.length === 0 ||
      preset.id.length > MAX_CUSTOM_THEME_PRESET_ID_LENGTH ||
      !/^[\w-]+$/.test(preset.id) ||
      !name ||
      name.length > MAX_CUSTOM_THEME_PRESET_NAME_LENGTH ||
      !isResolvedAppearance(preset.scheme)
    ) {
      throw new TypeError("Invalid custom theme preset")
    }

    if (ids.has(preset.id)) {
      throw new TypeError("Duplicate custom theme preset id")
    }
    ids.add(preset.id)

    const nameKey = `${preset.scheme}\0${name.toLowerCase()}`
    if (names.has(nameKey)) {
      throw new TypeError("Duplicate custom theme preset name")
    }
    names.add(nameKey)

    return {
      id: preset.id,
      name,
      scheme: preset.scheme,
      profile: normalizeAppearanceProfile(preset.profile),
    }
  })
}

function normalizeChromeSettings(value: unknown): ChromeSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Chrome settings must be an object")
  }

  const candidate = value as Partial<ChromeSettings>
  const activeTabIndicator =
    candidate.activeTabIndicator ??
    DEFAULT_APP_SETTINGS.chrome.activeTabIndicator
  const statusItems = candidate.statusItems
  const tabWheelScrollDirection =
    candidate.tabWheelScrollDirection ??
    DEFAULT_APP_SETTINGS.chrome.tabWheelScrollDirection
  const alwaysShowTopControls =
    candidate.alwaysShowTopControls ??
    DEFAULT_APP_SETTINGS.chrome.alwaysShowTopControls
  const topRightControls =
    candidate.topRightControls ?? DEFAULT_APP_SETTINGS.chrome.topRightControls
  if (
    !isTabVisibilityMode(candidate.tabVisibility) ||
    !isTabWheelScrollDirection(tabWheelScrollDirection) ||
    typeof alwaysShowTopControls !== "boolean" ||
    typeof topRightControls !== "object" ||
    topRightControls === null ||
    typeof topRightControls.navigation !== "boolean" ||
    typeof topRightControls.viewMode !== "boolean" ||
    typeof topRightControls.find !== "boolean" ||
    typeof topRightControls.outline !== "boolean" ||
    typeof topRightControls.formattingToolbar !== "boolean" ||
    typeof topRightControls.settings !== "boolean" ||
    typeof candidate.showFormattingBar !== "boolean" ||
    !isFormattingBarPosition(candidate.formattingBarPosition) ||
    typeof candidate.showCenteredPath !== "boolean" ||
    !isFilePathDisplayMode(candidate.centeredPathDisplay) ||
    !isFilePathDisplayMode(candidate.tabDisplay) ||
    typeof candidate.alwaysShowStatusBar !== "boolean" ||
    typeof statusItems !== "object" ||
    statusItems === null ||
    typeof statusItems.words !== "boolean" ||
    typeof statusItems.lines !== "boolean" ||
    typeof statusItems.characters !== "boolean" ||
    typeof statusItems.cursorPosition !== "boolean" ||
    typeof statusItems.encoding !== "boolean" ||
    typeof statusItems.lineEnding !== "boolean"
  ) {
    throw new TypeError("Invalid chrome settings")
  }

  return {
    activeTabIndicator: normalizeActiveTabIndicatorSettings(activeTabIndicator),
    tabVisibility: candidate.tabVisibility,
    tabWheelScrollDirection,
    alwaysShowTopControls,
    topRightControls: {
      navigation: topRightControls.navigation,
      viewMode: topRightControls.viewMode,
      find: topRightControls.find,
      outline: topRightControls.outline,
      formattingToolbar: topRightControls.formattingToolbar,
      settings: topRightControls.settings,
    },
    showFormattingBar: candidate.showFormattingBar,
    formattingBarPosition: candidate.formattingBarPosition,
    showCenteredPath: candidate.showCenteredPath,
    centeredPathDisplay: candidate.centeredPathDisplay,
    tabDisplay: candidate.tabDisplay,
    alwaysShowStatusBar: candidate.alwaysShowStatusBar,
    statusItems: {
      words: statusItems.words,
      lines: statusItems.lines,
      characters: statusItems.characters,
      cursorPosition: statusItems.cursorPosition,
      encoding: statusItems.encoding,
      lineEnding: statusItems.lineEnding,
    },
  }
}

function normalizeLaunchTransitionSettings(
  value: unknown
): LaunchTransitionSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Launch transition settings must be an object")
  }

  const candidate = value as Partial<LaunchTransitionSettings>
  if (
    typeof candidate.customEasing !== "string" ||
    !parseLaunchTransitionCubicBezier(candidate.customEasing) ||
    typeof candidate.delayMs !== "number" ||
    !Number.isInteger(candidate.delayMs) ||
    candidate.delayMs < MIN_LAUNCH_TRANSITION_DELAY_MS ||
    candidate.delayMs > MAX_LAUNCH_TRANSITION_DELAY_MS ||
    typeof candidate.durationMs !== "number" ||
    !Number.isInteger(candidate.durationMs) ||
    candidate.durationMs < MIN_LAUNCH_TRANSITION_DURATION_MS ||
    candidate.durationMs > MAX_LAUNCH_TRANSITION_DURATION_MS ||
    !isLaunchTransitionEasing(candidate.easing) ||
    typeof candidate.enabled !== "boolean" ||
    !isLaunchTransitionStrategy(candidate.strategy)
  ) {
    throw new TypeError("Invalid launch transition settings")
  }

  return {
    customEasing: candidate.customEasing.trim(),
    delayMs: candidate.delayMs,
    durationMs: candidate.durationMs,
    easing: candidate.easing,
    enabled: candidate.enabled,
    strategy: candidate.strategy,
  }
}

function normalizeMarkdownExtensionSettings(
  value: unknown
): MarkdownExtensionSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Markdown extension settings must be an object")
  }

  const candidate = value as Partial<MarkdownExtensionSettings>
  if (
    typeof candidate.superscriptAndSubscript !== "boolean" ||
    typeof candidate.emojiRecognition !== "boolean" ||
    typeof candidate.emojiExpansion !== "boolean" ||
    typeof candidate.footnotes !== "boolean" ||
    typeof candidate.definitionLists !== "boolean" ||
    typeof candidate.latex !== "boolean" ||
    typeof candidate.mermaid !== "boolean" ||
    typeof candidate.yamlFrontMatter !== "boolean" ||
    typeof candidate.sanitizedHtml !== "boolean" ||
    (candidate.emojiExpansion && !candidate.emojiRecognition)
  ) {
    throw new TypeError("Invalid Markdown extension settings")
  }

  return {
    superscriptAndSubscript: candidate.superscriptAndSubscript,
    emojiRecognition: candidate.emojiRecognition,
    emojiExpansion: candidate.emojiExpansion,
    footnotes: candidate.footnotes,
    definitionLists: candidate.definitionLists,
    latex: candidate.latex,
    mermaid: candidate.mermaid,
    yamlFrontMatter: candidate.yamlFrontMatter,
    sanitizedHtml: candidate.sanitizedHtml,
  }
}

function normalizeSettings(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Settings must be an object")
  }

  const candidate = value as Partial<AppSettings>
  const appearance = normalizeAppearanceSettings(value)
  const {
    customThemePresets = DEFAULT_APP_SETTINGS.customThemePresets,
    defaultWindowProfileId = DEFAULT_APP_SETTINGS.defaultWindowProfileId,
    initialEditorMode = DEFAULT_APP_SETTINGS.initialEditorMode,
    keepReadyInBackground = DEFAULT_APP_SETTINGS.keepReadyInBackground,
    lineWrapping = DEFAULT_APP_SETTINGS.lineWrapping,
    spellCheck = DEFAULT_APP_SETTINGS.spellCheck,
    markdownExtensions = DEFAULT_APP_SETTINGS.markdownExtensions,
    launchTransition = DEFAULT_APP_SETTINGS.launchTransition,
    zoomFactor,
    regularFontFamily = DEFAULT_APP_SETTINGS.regularFontFamily,
    monospaceFontFamily = DEFAULT_APP_SETTINGS.monospaceFontFamily,
    baseFontSize,
    codeFontSize,
    headingFontScales,
    headingFontBold,
    calloutTitleFontSize = DEFAULT_APP_SETTINGS.calloutTitleFontSize,
    fontLigatures,
    maxContentWidth,
    sourceIndentation,
    sourceIndentSize,
  } = candidate
  if (
    (defaultWindowProfileId !== null &&
      !isProfileIdentifier(defaultWindowProfileId)) ||
    !isEditorMode(initialEditorMode) ||
    typeof keepReadyInBackground !== "boolean" ||
    typeof lineWrapping !== "boolean" ||
    typeof spellCheck !== "boolean" ||
    typeof zoomFactor !== "number" ||
    !Number.isFinite(zoomFactor) ||
    zoomFactor < MIN_ZOOM_FACTOR ||
    zoomFactor > MAX_ZOOM_FACTOR ||
    typeof regularFontFamily !== "string" ||
    !normalizeFontFamilyName(regularFontFamily) ||
    typeof monospaceFontFamily !== "string" ||
    !normalizeFontFamilyName(monospaceFontFamily) ||
    typeof baseFontSize !== "number" ||
    !Number.isFinite(baseFontSize) ||
    baseFontSize < MIN_TYPOGRAPHY_FONT_SIZE ||
    baseFontSize > MAX_TYPOGRAPHY_FONT_SIZE ||
    typeof codeFontSize !== "number" ||
    !Number.isFinite(codeFontSize) ||
    codeFontSize < MIN_TYPOGRAPHY_FONT_SIZE ||
    codeFontSize > MAX_TYPOGRAPHY_FONT_SIZE ||
    !Array.isArray(headingFontScales) ||
    headingFontScales.length !== 6 ||
    headingFontScales.some(
      (fontScale) =>
        typeof fontScale !== "number" ||
        !Number.isFinite(fontScale) ||
        fontScale < MIN_HEADING_FONT_SCALE ||
        fontScale > MAX_HEADING_FONT_SCALE
    ) ||
    !Array.isArray(headingFontBold) ||
    headingFontBold.length !== 6 ||
    headingFontBold.some((bold) => typeof bold !== "boolean") ||
    typeof calloutTitleFontSize !== "number" ||
    !Number.isFinite(calloutTitleFontSize) ||
    calloutTitleFontSize < MIN_TYPOGRAPHY_FONT_SIZE ||
    calloutTitleFontSize > MAX_TYPOGRAPHY_FONT_SIZE ||
    typeof fontLigatures !== "boolean" ||
    typeof maxContentWidth !== "number" ||
    !Number.isFinite(maxContentWidth) ||
    maxContentWidth < 480 ||
    maxContentWidth > 1600 ||
    !isSourceIndentation(sourceIndentation) ||
    typeof sourceIndentSize !== "number" ||
    !Number.isInteger(sourceIndentSize) ||
    sourceIndentSize < MIN_SOURCE_INDENT_SIZE ||
    sourceIndentSize > MAX_SOURCE_INDENT_SIZE
  ) {
    throw new TypeError("Invalid application settings")
  }

  return {
    ...appearance,
    customThemePresets: normalizeCustomThemePresets(customThemePresets),
    defaultWindowProfileId,
    initialEditorMode,
    keepReadyInBackground,
    lineWrapping,
    spellCheck,
    markdownExtensions: normalizeMarkdownExtensionSettings(markdownExtensions),
    launchTransition: normalizeLaunchTransitionSettings(launchTransition),
    zoomFactor,
    regularFontFamily: normalizeFontFamilyName(regularFontFamily)!,
    monospaceFontFamily: normalizeFontFamilyName(monospaceFontFamily)!,
    baseFontSize,
    codeFontSize,
    headingFontScales: [
      headingFontScales[0]!,
      headingFontScales[1]!,
      headingFontScales[2]!,
      headingFontScales[3]!,
      headingFontScales[4]!,
      headingFontScales[5]!,
    ],
    headingFontBold: [
      headingFontBold[0]!,
      headingFontBold[1]!,
      headingFontBold[2]!,
      headingFontBold[3]!,
      headingFontBold[4]!,
      headingFontBold[5]!,
    ],
    calloutTitleFontSize,
    fontLigatures,
    maxContentWidth,
    sourceIndentation,
    sourceIndentSize,
    chrome: normalizeChromeSettings(candidate.chrome),
  }
}

function createEmptyDocument(): DocumentSnapshot {
  return {
    content: "",
    displayName: "Untitled",
    filePath: null,
    format: {
      hasUtf8Bom: false,
      lineEnding: process.platform === "win32" ? "\r\n" : "\n",
    },
    kind: "markdown",
    mtimeMs: null,
  }
}

function cloneDocument(document: DocumentSnapshot): DocumentSnapshot {
  return { ...document, format: { ...document.format } }
}

function documentMetadata(document: DocumentSnapshot): DocumentMetadata {
  return {
    displayName: document.displayName,
    filePath: document.filePath,
    format: { ...document.format },
    kind: document.kind,
    mtimeMs: document.mtimeMs,
  }
}

function tabDocumentMetadata(tab: TabState): DocumentMetadata {
  return {
    ...documentMetadata(tab.document),
    displayName: tab.title ?? tab.document.displayName,
  }
}

function encodeUtf8Document(content: string, format: DocumentFormat): Buffer {
  return encodeUtf8Bytes(content, format)
}

function contentHash(data: Buffer): string {
  return hashDocumentBytes(data)
}

function documentContentHash(document: DocumentSnapshot): string | null {
  return document.filePath
    ? contentHash(encodeUtf8Document(document.content, document.format))
    : null
}

function normalizeFormat(value: unknown): DocumentFormat {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Document format is required")
  }

  const candidate = value as Partial<DocumentFormat>
  if (
    typeof candidate.hasUtf8Bom !== "boolean" ||
    (candidate.lineEnding !== "\n" && candidate.lineEnding !== "\r\n")
  ) {
    throw new TypeError("Invalid document format")
  }

  return {
    hasUtf8Bom: candidate.hasUtf8Bom,
    lineEnding: candidate.lineEnding,
  }
}

function normalizeDocumentKind(value: unknown): DocumentKind {
  if (value !== "markdown" && value !== "plain-text") {
    throw new TypeError("Invalid document kind")
  }
  return value
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function normalizeSaveRequest(value: unknown): SaveDocumentRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Save request must be an object")
  }

  const candidate = value as Partial<SaveDocumentRequest>
  if (
    typeof candidate.content !== "string" ||
    (candidate.filePath !== null && typeof candidate.filePath !== "string") ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    (candidate.automatic !== undefined &&
      typeof candidate.automatic !== "boolean") ||
    (candidate.saveAs !== undefined && typeof candidate.saveAs !== "boolean") ||
    (candidate.saveAsScratch !== undefined &&
      typeof candidate.saveAsScratch !== "boolean") ||
    (candidate.saveAs === true && candidate.saveAsScratch === true) ||
    (candidate.automatic === true && candidate.saveAsScratch === true)
  ) {
    throw new TypeError("Invalid save request")
  }

  return {
    automatic: candidate.automatic,
    tabId: normalizeIdentifier(candidate.tabId, "Tab id"),
    content: candidate.content,
    filePath: candidate.filePath,
    format: normalizeFormat(candidate.format),
    revision: candidate.revision,
    saveAs: candidate.saveAs,
    saveAsScratch: candidate.saveAsScratch,
  }
}

function normalizeSaveAcknowledgement(
  value: unknown
): SaveDocumentAcknowledgement {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Save acknowledgement must be an object")
  }
  const candidate = value as Partial<SaveDocumentAcknowledgement>
  if (
    typeof candidate.current !== "boolean" ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0
  ) {
    throw new TypeError("Invalid save acknowledgement")
  }
  return {
    current: candidate.current,
    revision: candidate.revision,
    saveToken: normalizeIdentifier(candidate.saveToken, "Save token"),
    tabId: normalizeIdentifier(candidate.tabId, "Tab id"),
  }
}

function normalizeEditorViewport(value: unknown): EditorViewport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Editor viewport must be an object")
  }
  const viewport = value as Partial<EditorViewport>
  if (
    typeof viewport.pos !== "number" ||
    !Number.isSafeInteger(viewport.pos) ||
    viewport.pos < 0 ||
    typeof viewport.screenOffset !== "number" ||
    !Number.isFinite(viewport.screenOffset) ||
    typeof viewport.scrollLeft !== "number" ||
    !Number.isFinite(viewport.scrollLeft) ||
    viewport.scrollLeft < 0 ||
    typeof viewport.scrollTop !== "number" ||
    !Number.isFinite(viewport.scrollTop) ||
    viewport.scrollTop < 0
  ) {
    throw new TypeError("Invalid editor viewport")
  }
  return {
    pos: viewport.pos,
    screenOffset: viewport.screenOffset,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
  }
}

function normalizeSerializedEditorSession(
  value: unknown
): SerializedEditorSession {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Editor session must be an object")
  }

  const candidate = value as Partial<SerializedEditorSession>
  const viewport = normalizeEditorViewport(candidate.viewport)
  if (
    candidate.version !== SERIALIZED_EDITOR_SESSION_VERSION ||
    typeof candidate.state !== "object" ||
    candidate.state === null ||
    typeof candidate.baselineContent !== "string" ||
    (candidate.documentKind !== "markdown" &&
      candidate.documentKind !== "plain-text") ||
    (candidate.mode !== "live" && candidate.mode !== "source") ||
    typeof candidate.lineWrapping !== "boolean" ||
    typeof candidate.caretVisible !== "boolean" ||
    typeof candidate.viewportInitialized !== "boolean" ||
    typeof candidate.revision !== "number" ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision < 0
  ) {
    throw new TypeError("Invalid editor session")
  }

  return {
    version: SERIALIZED_EDITOR_SESSION_VERSION,
    state: candidate.state,
    baselineContent: candidate.baselineContent,
    documentKind: candidate.documentKind,
    mode: candidate.mode,
    lineWrapping: candidate.lineWrapping,
    caretVisible: candidate.caretVisible,
    revision: candidate.revision,
    viewport,
    viewportInitialized: candidate.viewportInitialized,
  }
}

function normalizeTabDragGeometry(value: unknown): TabDragGeometry | null {
  if (value === undefined) return null
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Tab drag geometry must be an object")
  }
  const candidate = value as Partial<TabDragGeometry>
  const cursorOffset = candidate.cursorOffset
  const sourceStripBounds = candidate.sourceStripBounds
  if (
    typeof cursorOffset !== "object" ||
    cursorOffset === null ||
    typeof cursorOffset.x !== "number" ||
    !Number.isFinite(cursorOffset.x) ||
    typeof cursorOffset.y !== "number" ||
    !Number.isFinite(cursorOffset.y) ||
    typeof sourceStripBounds !== "object" ||
    sourceStripBounds === null ||
    typeof sourceStripBounds.x !== "number" ||
    !Number.isFinite(sourceStripBounds.x) ||
    typeof sourceStripBounds.y !== "number" ||
    !Number.isFinite(sourceStripBounds.y) ||
    typeof sourceStripBounds.width !== "number" ||
    !Number.isFinite(sourceStripBounds.width) ||
    sourceStripBounds.width <= 0 ||
    typeof sourceStripBounds.height !== "number" ||
    !Number.isFinite(sourceStripBounds.height) ||
    sourceStripBounds.height <= 0
  ) {
    throw new TypeError("Invalid tab drag geometry")
  }
  return {
    cursorOffset: { x: cursorOffset.x, y: cursorOffset.y },
    sourceStripBounds: {
      x: sourceStripBounds.x,
      y: sourceStripBounds.y,
      width: sourceStripBounds.width,
      height: sourceStripBounds.height,
    },
  }
}

function normalizeTabDragEndDetails(value: unknown): TabDragEndDetails {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Tab drag result must be an object")
  }
  const candidate = value as Partial<TabDragEndDetails>
  const screenPoint = candidate.screenPoint
  if (
    typeof candidate.cancelled !== "boolean" ||
    typeof candidate.dropped !== "boolean" ||
    typeof screenPoint !== "object" ||
    screenPoint === null ||
    typeof screenPoint.x !== "number" ||
    !Number.isFinite(screenPoint.x) ||
    typeof screenPoint.y !== "number" ||
    !Number.isFinite(screenPoint.y)
  ) {
    throw new TypeError("Invalid tab drag result")
  }
  return {
    cancelled: candidate.cancelled,
    dragToken: normalizeIdentifier(candidate.dragToken, "Drag token"),
    dropped: candidate.dropped,
    screenPoint: { x: screenPoint.x, y: screenPoint.y },
  }
}

function normalizeTabExportResponse(value: unknown): TabExportResponse {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Tab export response must be an object")
  }
  const candidate = value as Partial<TabExportResponse>
  return {
    transferId: normalizeIdentifier(candidate.transferId, "Transfer id"),
    tabId: normalizeIdentifier(candidate.tabId, "Tab id"),
    editorSession: normalizeSerializedEditorSession(candidate.editorSession),
  }
}

function normalizeCliTabsOpenAcknowledgement(
  value: unknown
): CliTabsOpenAcknowledgement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("CLI tabs acknowledgement must be an object")
  }
  const candidate = value as Partial<CliTabsOpenAcknowledgement>
  if (
    Object.keys(value).length !== 2 ||
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    typeof candidate.accepted !== "boolean"
  ) {
    throw new TypeError("Invalid CLI tabs acknowledgement")
  }
  return {
    accepted: candidate.accepted,
    requestId: candidate.requestId,
  }
}

function normalizeCliEditorFocusAcknowledgement(
  value: unknown
): CliEditorFocusAcknowledgement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("CLI focus acknowledgement must be an object")
  }
  const candidate = value as Partial<CliEditorFocusAcknowledgement>
  if (
    Object.keys(value).length !== 2 ||
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    typeof candidate.accepted !== "boolean"
  ) {
    throw new TypeError("Invalid CLI focus acknowledgement")
  }
  return {
    accepted: candidate.accepted,
    requestId: candidate.requestId,
  }
}

function normalizeExternalLink(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("External link must be a string")
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError("External link must be a valid URL")
  }
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "mailto:" &&
    parsed.protocol !== "xmpp:"
  ) {
    throw new TypeError("The external link protocol is not allowed")
  }
  return parsed.href
}

function normalizeLocalLinkDisposition(value: unknown): LocalLinkDisposition {
  if (value !== "current-tab" && value !== "new-tab") {
    throw new TypeError("Local link disposition is invalid")
  }
  return value
}

function normalizeLocalLinkFragment(value: unknown): string | null {
  if (value === null) return null
  if (!isValidScratchLinkFragment(value)) {
    throw new TypeError("Local link fragment is invalid")
  }
  return value
}

function publicScratchIdentity(
  identity: TabState["scratchIdentity"]
): ScratchDocumentIdentity | null {
  return identity ? { scratchId: identity.scratchId } : null
}

function normalizeScratchLinkIdentity(value: unknown): ScratchDocumentIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Scratch link identity is invalid")
  }
  const candidate = value as Partial<ScratchDocumentIdentity>
  if (
    Object.keys(value).length !== 1 ||
    !isScratchIdentifier(candidate.scratchId)
  ) {
    throw new TypeError("Scratch link identity is invalid")
  }
  return { scratchId: candidate.scratchId }
}

function localLinkPath(tab: TabState, value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError("Local link destination is invalid")
  }

  const fileUrl = /^file:/i.test(value)
  const absolutePath = path.isAbsolute(value)
  const sourcePath = tab.document.filePath
  if (!fileUrl && !absolutePath && !sourcePath) {
    throw new Error("Save this document before opening a relative link")
  }

  let destination: URL
  try {
    if (fileUrl) {
      destination = new URL(value)
    } else if (absolutePath) {
      const normalized = value.replaceAll("\\", "/")
      destination =
        process.platform === "win32"
          ? new URL(
              normalized.startsWith("//")
                ? `file:${normalized}`
                : `file:///${normalized}`
            )
          : new URL(normalized, "file:///")
    } else {
      destination = new URL(value, pathToFileURL(sourcePath!))
    }
  } catch {
    throw new TypeError("Local link destination is invalid")
  }
  if (destination.protocol !== "file:") {
    throw new TypeError("Local links must resolve to a file")
  }
  destination.hash = ""
  destination.search = ""
  return fileURLToPath(destination)
}

function openLinkedFileTab(
  ioPath: string,
  sourceState: WindowState,
  displayPath?: string
): { state: WindowState; tab: TabState } | null {
  const focusedWindowId = BrowserWindow.getFocusedWindow()?.id
  const candidates: Array<{
    priority: number
    state: WindowState
    tab: TabState
  }> = []

  for (const tab of tabStates.values()) {
    if (
      tab.backing !== "file" ||
      (tab.ioPath !== ioPath && tab.document.filePath !== displayPath)
    ) {
      continue
    }
    const state = linkedTabState(tab)
    if (!state) continue

    const tabIndex = state.tabIds.indexOf(tab.id)
    const sameWindow = state.win.id === sourceState.win.id
    const priority = sameWindow
      ? tab.id === sourceState.activeTabId
        ? 0
        : 10 + tabIndex
      : state.win.id === focusedWindowId
        ? 100 + (tab.id === state.activeTabId ? 0 : 10 + tabIndex)
        : 200 + (tab.id === state.activeTabId ? 0 : 10 + tabIndex)
    candidates.push({ priority, state, tab })
  }

  candidates.sort((left, right) => left.priority - right.priority)
  return candidates[0] ?? null
}

function linkedTabBlockingSurfaceOpen(state: WindowState): boolean {
  return (
    state.editorMenuState.settingsDialogOpen ||
    state.editorMenuState.settingsWorkspaceOpen ||
    state.editorMenuState.softwareLicensesOpen
  )
}

function linkedTabOwnerState(tab: TabState): WindowState | null {
  const state = windowStates.get(tab.ownerWindowId)
  return !state ||
    state.win.isDestroyed() ||
    state.provisional ||
    state.closeSequence ||
    state.allowClose ||
    state.recoverySurfaceActive ||
    !state.rendererReady ||
    !state.editorReady ||
    !state.tabIds.includes(tab.id)
    ? null
    : state
}

function linkedTabBaseState(tab: TabState): WindowState | null {
  const state = linkedTabOwnerState(tab)
  return !state || state.tabMutationLocked ? null : state
}

function linkedTabState(tab: TabState): WindowState | null {
  const state = linkedTabBaseState(tab)
  return !state || linkedTabBlockingSurfaceOpen(state) ? null : state
}

function focusWindow(state: WindowState): void {
  if (state.win.isMinimized()) state.win.restore()
  state.win.show()
  state.win.focus()
}

function queueExternalScratchActivation(
  tab: TabState,
  fragment: string | null
): boolean {
  const state = linkedTabOwnerState(tab)
  const scratchId = tab.scratchIdentity?.scratchId
  if (!state || !scratchId || !linkedTabBlockingSurfaceOpen(state)) return false
  pendingExternalScratchActivations.set(state.win.id, {
    fragment,
    scratchId,
    tabId: tab.id,
  })
  focusWindow(state)
  return true
}

function deliverPendingExternalScratchActivation(state: WindowState): void {
  const pending = pendingExternalScratchActivations.get(state.win.id)
  if (!pending || linkedTabBlockingSurfaceOpen(state)) return
  const tab = tabStates.get(pending.tabId)
  if (
    !tab ||
    tab.ownerWindowId !== state.win.id ||
    tab.scratchIdentity?.scratchId !== pending.scratchId
  ) {
    pendingExternalScratchActivations.delete(state.win.id)
    return
  }
  if (linkedTabState(tab) !== state) return
  pendingExternalScratchActivations.delete(state.win.id)
  activateTabInState(state, tab.id)
  sendTabsChanged(state)
  focusWindow(state)
  state.win.webContents.send(ipcChannels.openExistingLocalLinkRequested, {
    fragment: pending.fragment,
    tabId: tab.id,
  } satisfies OpenExistingLocalLinkRequest)
  void scratchStore.markOpened(pending.scratchId).catch((error) => {
    console.warn("Unable to record queued scratch activation", error)
  })
}

function activateLinkedDocumentTab(
  existing: { state: WindowState; tab: TabState },
  sourceState: WindowState,
  fragment: string | null
): Extract<OpenLocalLinkResult, { kind: "existing-document" }> {
  const location =
    existing.state.win.id === sourceState.win.id
      ? "current-window"
      : "other-window"
  if (location === "other-window") {
    const request: OpenExistingLocalLinkRequest = {
      fragment,
      tabId: existing.tab.id,
    }
    if (existing.state.win.isMinimized()) existing.state.win.restore()
    existing.state.win.show()
    existing.state.win.focus()
    existing.state.win.webContents.send(
      ipcChannels.openExistingLocalLinkRequested,
      request
    )
  }
  return {
    kind: "existing-document",
    location,
    tabId: existing.tab.id,
  }
}

async function confirmExternalOverwrite(
  win: BrowserWindow,
  filePath: string,
  expected: SaveTargetBaseline
): Promise<SaveTargetApproval | null> {
  const actual = await readSaveTargetBaseline(filePath)
  if (actual.mtimeMs === null && actual.contentHash === null) {
    if (expected.mtimeMs === null && expected.contentHash === null) {
      return {
        baseline: actual,
        replacementMode: expected.mode,
      }
    }
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      title: "Document Deleted on Disk",
      message: `${path.basename(filePath)} has been deleted since it was opened or last saved.`,
      detail: "Saving will recreate the file with the application’s version.",
      buttons: ["Recreate", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return response === 0
      ? {
          baseline: actual,
          replacementMode: expected.mode,
        }
      : null
  }

  const changed =
    expected.mtimeMs === null ||
    expected.contentHash === null ||
    Math.abs(actual.mtimeMs! - expected.mtimeMs) > 1 ||
    actual.contentHash !== expected.contentHash
  if (!changed) {
    return {
      baseline: actual,
      replacementMode: actual.mode,
    }
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Document Changed on Disk",
    message: `${path.basename(filePath)} has changed since it was opened or last saved.`,
    detail:
      "Overwriting will discard the changes made by the other application.",
    buttons: ["Overwrite", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
    ? {
        baseline: actual,
        replacementMode: actual.mode,
      }
    : null
}

async function readSaveTargetBaseline(
  filePath: string
): Promise<SaveTargetBaseline> {
  const maximumAttempts = 3
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let stable: StableFileBytes
    try {
      stable = await readStableFileBytes(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { contentHash: null, mode: undefined, mtimeMs: null }
      }
      throw error
    }

    const contentHash = await documentUtility.hash(stable.buffer)
    try {
      const [currentStats, currentIoPath] = await Promise.all([
        stat(stable.ioPath),
        realpath(path.resolve(filePath)),
      ])
      if (
        currentStats.isFile() &&
        currentIoPath === stable.ioPath &&
        fileFingerprintsMatch(
          fileFingerprint(currentStats),
          stable.fingerprint
        ) &&
        currentStats.mode === stable.mode
      ) {
        return {
          contentHash,
          mode: stable.mode,
          mtimeMs: stable.fingerprint.mtimeMs,
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (attempt === maximumAttempts) {
      throw new Error("The save target changed repeatedly while it was read")
    }
  }
  throw new Error("The save target could not be read")
}

function saveTargetBaselinesMatch(
  left: SaveTargetBaseline,
  right: SaveTargetBaseline
): boolean {
  return (
    left.contentHash === right.contentHash &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs
  )
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function canonicalizeSavePath(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath)
  try {
    return await realpath(resolvedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const canonicalDirectory = await realpath(path.dirname(resolvedPath))
    return path.join(canonicalDirectory, path.basename(resolvedPath))
  }
}

const atomicWriteReplacementCancelled = new Error(
  "The save target changed before a replacement retry"
)

async function atomicWrite(
  filePath: string,
  data: string | Buffer,
  beforeReplace?: () => Promise<AtomicWriteReplacementApproval | null>,
  options: AtomicWriteOptions = {}
): Promise<FileFingerprint | null> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let temporaryFingerprint: FileFingerprint

  try {
    const initialMode = await existingMode(filePath)
    handle = await open(temporaryPath, "wx", initialMode)
    await handle.writeFile(data)
    // Creation modes are filtered through umask. Make the temporary bytes and
    // the transaction's starting mode durable before any conflict prompt.
    await preserveExistingFileMode(handle, initialMode)
    await handle.sync()

    let finalValidation: (() => Promise<boolean>) | null = null
    let commitMode: number | undefined
    if (beforeReplace) {
      const approval = await beforeReplace()
      if (!approval) {
        await handle.close()
        handle = null
        await unlink(temporaryPath).catch(() => undefined)
        return null
      }
      commitMode = modeForAtomicReplacement(initialMode, approval.mode)
      finalValidation = approval.validate
    } else {
      commitMode = modeForAtomicReplacement(
        initialMode,
        await existingMode(filePath)
      )
    }

    // A conflict prompt can outlive another process's chmod. Apply the
    // approved target mode and make that metadata durable before the final
    // stable-byte guard. Most saves keep the starting mode and avoid a second
    // fsync.
    if (commitMode !== initialMode) {
      await preserveExistingFileMode(handle, commitMode)
      await handle.sync()
    }
    const temporaryStats = await handle.stat()
    if (!temporaryStats.isFile()) {
      throw new Error("The temporary save target is not a regular file")
    }
    temporaryFingerprint = fileFingerprint(temporaryStats)
    await handle.close()
    handle = null
    if (finalValidation && !(await finalValidation())) {
      await unlink(temporaryPath).catch(() => undefined)
      return null
    }
    await renameReplacingFile(temporaryPath, filePath, {
      beforeRetryAttempt: finalValidation
        ? async () => {
            if (!(await finalValidation())) {
              throw atomicWriteReplacementCancelled
            }
          }
        : undefined,
    })
    await syncParentDirectory(filePath)
    return await reconcileAtomicWriteAfterRename({
      acceptStableExpectedBytesAfterReplacementMismatch:
        options.acceptStableExpectedBytesAfterReplacementMismatch === true,
      verifyStableExpectedBytes: () =>
        verifyAtomicWriteContents(filePath, data),
      verifyStrictReplacement: async () => {
        const committedFingerprint = fileFingerprint(await stat(filePath))
        const identityMatches =
          fileIdentitiesMatch(temporaryFingerprint, committedFingerprint) ||
          (temporaryFingerprint.dev === committedFingerprint.dev &&
            temporaryFingerprint.ino === 0 &&
            committedFingerprint.ino === 0)
        if (
          !identityMatches ||
          temporaryFingerprint.size !== committedFingerprint.size ||
          temporaryFingerprint.mtimeMs !== committedFingerprint.mtimeMs
        ) {
          throw new Error("The save target changed while it was being replaced")
        }
        return await verifyAtomicWriteContents(filePath, data)
      },
    })
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    if (error === atomicWriteReplacementCancelled) return null
    throw error
  }
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json")
}

function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json")
}

function recentDocumentsPath(): string {
  return path.join(app.getPath("userData"), "recent-documents.json")
}

function recentDocumentListsMatch(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((filePath, index) => filePath === right[index])
  )
}

async function loadRecentDocuments(): Promise<void> {
  try {
    const saved = JSON.parse(
      await readFile(recentDocumentsPath(), "utf8")
    ) as unknown
    recentDocuments = normalizeRecentDocuments(saved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "Unable to load recent documents; using an empty list",
        error
      )
    }
    recentDocuments = []
  }
  persistedRecentDocuments = [...recentDocuments]
}

function queueRecentDocumentsPersistence(): void {
  if (recentDocumentsPersistenceTask) {
    clearImmediate(recentDocumentsPersistenceTask)
    recentDocumentsPersistenceTask = null
  }

  const nextRecentDocuments = [...recentDocuments]
  const write = recentDocumentsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (
        recentDocumentListsMatch(persistedRecentDocuments, nextRecentDocuments)
      ) {
        return
      }
      await atomicWrite(
        recentDocumentsPath(),
        `${JSON.stringify(recentDocumentsFile(nextRecentDocuments), null, 2)}\n`
      )
      persistedRecentDocuments = nextRecentDocuments
    })
  recentDocumentsWriteQueue = write
  void write.catch((error) => {
    console.error("Unable to persist recent documents", error)
  })
}

function scheduleRecentDocumentsPersistence(): void {
  if (recentDocumentsPersistenceTask) return
  recentDocumentsPersistenceTask = setImmediate(() => {
    recentDocumentsPersistenceTask = null
    queueRecentDocumentsPersistence()
  })
}

async function flushRecentDocumentsPersistence(): Promise<void> {
  if (recentDocumentsPersistenceTask) queueRecentDocumentsPersistence()
  await recentDocumentsWriteQueue.catch(() => undefined)
}

function normalizeWindowSize(value: unknown): WindowSize {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Window state must be an object")
  }

  const { height, width } = value as Partial<WindowSize>
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_WINDOW_SIZE.width ||
    height < MIN_WINDOW_SIZE.height ||
    width > MAX_WINDOW_DIMENSION ||
    height > MAX_WINDOW_DIMENSION
  ) {
    throw new TypeError("Invalid window size")
  }

  return { width, height }
}

function windowSizesMatch(left: WindowSize, right: WindowSize): boolean {
  return left.width === right.width && left.height === right.height
}

async function loadWindowSize(): Promise<void> {
  try {
    const saved = JSON.parse(
      await readFile(windowStatePath(), "utf8")
    ) as unknown
    rememberedWindowSize = normalizeWindowSize(saved)
    persistedWindowSize = { ...rememberedWindowSize }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Unable to load window state; using defaults", error)
    }
    rememberedWindowSize = { ...DEFAULT_WINDOW_SIZE }
    persistedWindowSize = { ...DEFAULT_WINDOW_SIZE }
  }
}

function queueWindowSizePersistence(): void {
  if (windowSizePersistTimer) {
    clearTimeout(windowSizePersistTimer)
    windowSizePersistTimer = null
  }

  const nextWindowSize = { ...rememberedWindowSize }
  const write = windowSizeWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (windowSizesMatch(persistedWindowSize, nextWindowSize)) return
      await atomicWrite(
        windowStatePath(),
        `${JSON.stringify(nextWindowSize, null, 2)}\n`
      )
      persistedWindowSize = nextWindowSize
    })
  windowSizeWriteQueue = write
  void write.catch((error) => {
    console.error("Unable to persist window size", error)
  })
}

function scheduleWindowSizePersistence(): void {
  if (windowSizePersistTimer) clearTimeout(windowSizePersistTimer)
  windowSizePersistTimer = setTimeout(() => {
    windowSizePersistTimer = null
    queueWindowSizePersistence()
  }, WINDOW_SIZE_PERSIST_DELAY_MS)
}

function rememberWindowSize(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const nextWindowSize = normalizeWindowSize(win.getNormalBounds())
  if (windowSizesMatch(rememberedWindowSize, nextWindowSize)) return
  rememberedWindowSize = nextWindowSize
  scheduleWindowSizePersistence()
}

async function flushWindowSizePersistence(): Promise<void> {
  if (windowSizePersistTimer) queueWindowSizePersistence()
  await windowSizeWriteQueue.catch(() => undefined)
}

async function loadSettings(): Promise<AppSettings> {
  const result = await loadSettingsFile(settingsPath(), normalizeSettings)
  if (result.kind === "loaded") {
    settings = result.value
    settingsLoadFailure = null
  } else if (result.kind === "missing") {
    settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    settingsLoadFailure = null
  } else {
    settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    settingsLoadFailure = { error: result.error }
  }
  if (!settingsLoadFailure && !settingsRecoveryReleased) {
    settingsRecoveryReleased = true
    releaseSettingsRecovery?.()
    releaseSettingsRecovery = null
  }
  return cloneAppSettings(settings)
}

async function resolveSettingsLoadFailure(): Promise<boolean> {
  while (settingsLoadFailure) {
    settingsRecoveryPresented = true
    restoreForegroundActivationPolicy()
    const message =
      settingsLoadFailure.error instanceof Error
        ? settingsLoadFailure.error.message
        : String(settingsLoadFailure.error)
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "Settings Could Not Be Loaded",
      message: "Pulse MD couldn't load your Settings file.",
      detail: `${message}\n\nPulse MD has left the original file unchanged at:\n${settingsPath()}\n\nTry again after correcting a temporary filesystem problem, or preserve the original file and explicitly reset Settings to defaults.`,
      buttons: ["Try Again", "Preserve Original and Reset", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (response === 2) {
      await beginApplicationQuit()
      return false
    }
    if (response === 0) {
      settingsLoadPromise = loadSettings()
      await settingsLoadPromise
      continue
    }

    try {
      const defaults = cloneAppSettings(DEFAULT_APP_SETTINGS)
      const preservedPath = await resetSettingsFilePreservingOriginal(
        settingsPath(),
        async () => {
          const previousLoginItemState = currentKeepReadyLoginItemState(
            app,
            process.platform,
            isolatedUserDataLaunch
          )
          const loginItemApplied = applyKeepReadyLoginItem(
            app,
            process.platform,
            isolatedUserDataLaunch,
            false
          )
          try {
            await atomicWrite(
              settingsPath(),
              `${JSON.stringify(defaults, null, 2)}\n`
            )
          } catch (error) {
            if (loginItemApplied && previousLoginItemState !== null) {
              try {
                applyKeepReadyLoginItem(
                  app,
                  process.platform,
                  isolatedUserDataLaunch,
                  previousLoginItemState
                )
              } catch (rollbackError) {
                console.error(
                  "Unable to roll back the macOS login item after Settings reset failed",
                  rollbackError
                )
              }
            }
            throw error
          }
        }
      )
      settings = defaults
      settingsLoadFailure = null
      if (!settingsRecoveryReleased) {
        settingsRecoveryReleased = true
        releaseSettingsRecovery?.()
        releaseSettingsRecovery = null
      }
      if (preservedPath) {
        await dialog.showMessageBox({
          type: "info",
          title: "Settings Reset",
          message: "Settings were reset to defaults.",
          detail: `The original file was preserved at:\n${preservedPath}`,
          buttons: ["Continue"],
          defaultId: 0,
          noLink: true,
        })
      }
      return true
    } catch (error) {
      settingsLoadFailure = { error }
      dialog.showErrorBox(
        "Settings Reset Failed",
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return true
}

async function currentSettings(): Promise<AppSettings> {
  settingsLoadPromise ??= loadSettings()
  await settingsLoadPromise
  await settingsRecovery
  await settingsWriteQueue.catch(() => undefined)
  const current = cloneAppSettings(settings)
  if (!launchVisualMode) return current

  current.backgroundEffect.enabled = launchVisualMode !== "opaque"
  current.launchTransition.enabled = false
  return current
}

async function commitApplicationSettings(
  resolveNextSettings: (current: AppSettings) => AppSettings,
  sourceWindowId: WindowId | null,
  options: { importedTransaction?: boolean } = {}
): Promise<AppSettings> {
  settingsLoadPromise ??= loadSettings()
  await settingsLoadPromise
  await settingsRecovery
  let committedSettings: AppSettings | null = null
  const write = settingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const previousSettings = cloneAppSettings(settings)
      const nextSettings = cloneAppSettings(
        resolveNextSettings(cloneAppSettings(previousSettings))
      )
      const loginItemChanged =
        previousSettings.keepReadyInBackground !==
        nextSettings.keepReadyInBackground
      const previousLoginItemState = loginItemChanged
        ? currentKeepReadyLoginItemState(
            app,
            process.platform,
            isolatedUserDataLaunch
          )
        : null
      let loginItemApplied = false
      if (loginItemChanged) {
        loginItemApplied = applyKeepReadyLoginItem(
          app,
          process.platform,
          isolatedUserDataLaunch,
          nextSettings.keepReadyInBackground
        )
      }
      try {
        await atomicWrite(
          settingsPath(),
          `${JSON.stringify(nextSettings, null, 2)}\n`,
          undefined,
          {
            acceptStableExpectedBytesAfterReplacementMismatch:
              options.importedTransaction,
          }
        )
      } catch (error) {
        if (loginItemApplied && previousLoginItemState !== null) {
          try {
            applyKeepReadyLoginItem(
              app,
              process.platform,
              isolatedUserDataLaunch,
              previousLoginItemState
            )
          } catch (rollbackError) {
            console.error(
              "Unable to roll back the macOS login item after Settings persistence failed",
              rollbackError
            )
          }
        }
        throw error
      }
      settings = nextSettings
      committedSettings = nextSettings
      applyWindowsNativeThemeSource(nextSettings)
      if (applicationInitialized && loginItemChanged) {
        Menu.setApplicationMenu(createApplicationMenu())
        updateViewMenuItems()
      }
      try {
        session.defaultSession.setSpellCheckerEnabled(nextSettings.spellCheck)
      } catch (error) {
        console.warn("Unable to apply the committed spell-check setting", error)
      }
      for (const targetState of windowStates.values()) {
        const target = targetState.win
        if (target.isDestroyed()) continue
        try {
          applyWindowZoom(target, nextSettings.zoomFactor)
          if (!targetState.rendererReady) continue
          if (target.id !== settingsSessionOwnerWindowId) {
            targetState.appearancePreview = null
          }
          applyWindowVisualEffect(
            targetState,
            targetState.appearancePreview ?? nextSettings
          )
          if (target.id === sourceWindowId) continue
          target.webContents.send(
            ipcChannels.settingsChanged,
            settingsSnapshotForWindow(targetState, nextSettings)
          )
        } catch (error) {
          console.warn(
            `Unable to apply committed settings to window ${target.id}`,
            error
          )
        }
      }
    })
  settingsWriteQueue = write
  await write
  return cloneAppSettings(committedSettings ?? settings)
}

function settingsForWindow(
  state: Pick<WindowState, "launchOverrides">,
  baseSettings: AppSettings
): AppSettings {
  const resolved = cloneAppSettings(baseSettings)
  if (state.launchOverrides.editorMode) {
    resolved.initialEditorMode = state.launchOverrides.editorMode
  }
  if (state.launchOverrides.tabVisibility) {
    resolved.chrome.tabVisibility = state.launchOverrides.tabVisibility
  }
  return resolved
}

function settingsSnapshotForWindow(
  state: Pick<WindowState, "launchOverrides">,
  baseSettings: AppSettings
): WindowSettingsSnapshot {
  return {
    effective: settingsForWindow(state, baseSettings),
    persisted: cloneAppSettings(baseSettings),
  }
}

function fileFingerprint(stats: Stats): FileFingerprint {
  return {
    ctimeMs: stats.ctimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  }
}

function fileFingerprintsMatch(
  left: FileFingerprint | null,
  right: FileFingerprint | null
): boolean {
  return Boolean(
    left &&
    right &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  )
}

function fileIdentitiesMatch(
  left: FileFingerprint,
  right: FileFingerprint
): boolean {
  return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

async function verifyAtomicWriteContents(
  filePath: string,
  expectedData: string | Buffer
): Promise<FileFingerprint> {
  const handle = await open(filePath, "r")
  try {
    const before = await handle.stat()
    const expectedBuffer = Buffer.isBuffer(expectedData)
      ? expectedData
      : Buffer.from(expectedData)
    if (!before.isFile() || before.size !== expectedBuffer.length) {
      throw new Error("The save target changed while it was being replaced")
    }

    const comparisonBuffer = Buffer.allocUnsafe(
      Math.min(4 * 1024 * 1024, Math.max(1, expectedBuffer.length))
    )
    let position = 0
    while (position < expectedBuffer.length) {
      const length = Math.min(
        comparisonBuffer.length,
        expectedBuffer.length - position
      )
      const { bytesRead } = await handle.read(
        comparisonBuffer,
        0,
        length,
        position
      )
      if (
        bytesRead !== length ||
        !comparisonBuffer
          .subarray(0, bytesRead)
          .equals(expectedBuffer.subarray(position, position + bytesRead))
      ) {
        throw new Error("The save target changed while it was being replaced")
      }
      position += bytesRead
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat(),
      stat(filePath),
    ])
    const beforeFingerprint = fileFingerprint(before)
    const afterFingerprint = fileFingerprint(after)
    const pathFingerprint = fileFingerprint(pathAfter)
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      !fileFingerprintsMatch(beforeFingerprint, afterFingerprint) ||
      !fileFingerprintsMatch(afterFingerprint, pathFingerprint)
    ) {
      throw new Error("The save target changed while it was being replaced")
    }
    return afterFingerprint
  } finally {
    await handle.close()
  }
}

async function readFileHandleBytes(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes?: number
) {
  if (maximumBytes === undefined) return handle.readFile()

  const chunks: Buffer[] = []
  let position = 0
  while (position <= maximumBytes) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, maximumBytes + 1 - position)
    )
    const { bytesRead } = await handle.read(
      chunk,
      0,
      chunk.byteLength,
      position
    )
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
  if (position > maximumBytes) {
    throw new TypeError("The selected file is too large")
  }
  return Buffer.concat(chunks, position)
}

async function readStableFileBytes(
  filePath: string,
  maximumBytes?: number
): Promise<StableFileBytes> {
  const resolvedPath = path.resolve(filePath)
  const pathStats = await stat(resolvedPath)
  if (!pathStats.isFile()) throw new Error("The selected path is not a file")
  const ioPath = await realpath(resolvedPath)
  const maximumAttempts = 3
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const handle = await open(
      ioPath,
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    )
    try {
      const fileStatsBeforeRead = await handle.stat()
      if (!fileStatsBeforeRead.isFile()) {
        throw new Error("The selected path is not a file")
      }
      if (
        maximumBytes !== undefined &&
        fileStatsBeforeRead.size > maximumBytes
      ) {
        throw new TypeError("The selected file is too large")
      }
      const buffer = await readFileHandleBytes(handle, maximumBytes)
      const [fileStatsAfterRead, currentPathStats, currentIoPath] =
        await Promise.all([handle.stat(), stat(ioPath), realpath(resolvedPath)])
      if (!fileStatsAfterRead.isFile() || !currentPathStats.isFile()) {
        throw new Error("The selected path is not a file")
      }
      const before = fileFingerprint(fileStatsBeforeRead)
      const after = fileFingerprint(fileStatsAfterRead)
      const pathAfter = fileFingerprint(currentPathStats)
      if (
        currentIoPath !== ioPath ||
        !fileFingerprintsMatch(before, after) ||
        !fileFingerprintsMatch(after, pathAfter)
      ) {
        if (attempt < maximumAttempts) continue
        throw new Error("The document changed repeatedly while it was read")
      }
      return {
        buffer,
        fingerprint: after,
        ioPath,
        mode: fileStatsAfterRead.mode,
      }
    } finally {
      await handle.close()
    }
  }
  throw new Error("The document could not be read")
}

async function readDocument(
  filePath: string,
  displayPath = filePath
): Promise<LoadedDocument> {
  const resolvedDisplayPath = path.resolve(displayPath)
  const { buffer, fingerprint, ioPath } = await readStableFileBytes(filePath)
  const decoded = await documentUtility.decode(buffer)
  return {
    contentHash: decoded.contentHash,
    document: {
      content: decoded.content,
      displayName: path.basename(resolvedDisplayPath),
      filePath: resolvedDisplayPath,
      format: {
        hasUtf8Bom: decoded.hasUtf8Bom,
        lineEnding: decoded.lineEnding,
      },
      kind: documentKindForPath(resolvedDisplayPath),
      mtimeMs: fingerprint.mtimeMs,
    },
    fingerprint,
    ioPath,
  }
}

async function preparedFileTab(filePath: string): Promise<PreparedTab> {
  const displayPath = path.resolve(filePath)
  try {
    const loaded = await readDocument(displayPath)
    return {
      backing: "file",
      contentHash: loaded.contentHash,
      diskFingerprint: loaded.fingerprint,
      dirty: false,
      document: loaded.document,
      ioPath: loaded.ioPath,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error

    let entryExists = true
    try {
      await lstat(displayPath)
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code === "ENOENT") {
        entryExists = false
      } else {
        throw entryError
      }
    }
    if (entryExists) throw error

    const canonicalDirectory = await realpath(path.dirname(displayPath))
    const directoryStats = await stat(canonicalDirectory)
    if (!directoryStats.isDirectory()) {
      throw new Error("The target's parent path is not a directory", {
        cause: error,
      })
    }
    return {
      backing: "file",
      contentHash: null,
      diskFingerprint: null,
      dirty: false,
      document: {
        ...createEmptyDocument(),
        displayName: path.basename(displayPath),
        filePath: displayPath,
        kind: documentKindForPath(displayPath),
      },
      ioPath: path.join(canonicalDirectory, path.basename(displayPath)),
    }
  }
}

function memoizedPreparedLoad(
  load: () => Promise<PreparedTab>
): () => Promise<PreparedTab> {
  let pending: Promise<PreparedTab> | null = null
  return () => {
    if (pending) return pending
    const request = load()
    pending = request.catch((error: unknown) => {
      pending = null
      throw error
    })
    return pending
  }
}

function deferredFileTab(
  filePath: string,
  load: () => Promise<PreparedTab> = () => preparedFileTab(filePath)
): PreparedTab {
  const displayPath = path.resolve(filePath)
  return {
    backing: "file",
    contentHash: null,
    deferredLoad: memoizedPreparedLoad(load),
    diskFingerprint: null,
    dirty: false,
    document: {
      ...createEmptyDocument(),
      displayName: path.basename(displayPath),
      filePath: displayPath,
      kind: documentKindForPath(displayPath),
    },
    fileMissing: false,
    ioPath: displayPath,
  }
}

function preparedEmptyTab(
  backing: "ephemeral" | "untitled",
  options: { color?: TabColor; displayName?: string; title?: string } = {}
): PreparedTab {
  const displayName = options.title ?? options.displayName
  return {
    backing,
    ...(options.color ? { color: options.color } : {}),
    contentHash: null,
    diskFingerprint: null,
    dirty: false,
    document: {
      ...createEmptyDocument(),
      ...(displayName ? { displayName } : {}),
    },
    ioPath: null,
    ...(options.title ? { title: options.title } : {}),
  }
}

async function preparedStdinTab(
  stdinPath: string,
  name = "stdin.md"
): Promise<PreparedTab> {
  const decoded = await documentUtility.decodeFile(stdinPath)
  return {
    backing: "untitled",
    baselineContent: "",
    contentHash: null,
    diskFingerprint: null,
    dirty: true,
    document: {
      content: decoded.content,
      displayName: name,
      filePath: null,
      format: {
        hasUtf8Bom: decoded.hasUtf8Bom,
        lineEnding: decoded.lineEnding,
      },
      kind: "markdown",
      mtimeMs: null,
    },
    ioPath: null,
  }
}

async function preparedScratchTab(
  scratchId: string,
  options: {
    color?: TabColor
    title?: string
  } = {}
): Promise<PreparedTab> {
  const entry = await scratchStore.get(scratchId)
  const scratchPath = await scratchStore.pathFor(scratchId)
  const loaded = await readDocument(scratchPath)
  const displayName =
    options.title ?? entry.title ?? entry.fileName.replace(/\.md$/i, "")
  return {
    backing: "scratch",
    ...(options.color ? { color: options.color } : {}),
    contentHash: loaded.contentHash,
    diskFingerprint: loaded.fingerprint,
    dirty: false,
    document: {
      ...loaded.document,
      displayName,
      filePath: null,
      kind: "markdown",
    },
    ioPath: loaded.ioPath,
    scratchIdentity: { scratchId },
    ...(options.title ? { title: options.title } : {}),
  }
}

async function resolveCliScratchId(value: string): Promise<string> {
  const existing = await scratchStore.findByFileNameOrStem(value)
  if (existing) return existing.id
  return (await scratchStore.create({ fileName: value, markOpened: false })).id
}

async function preparedCliSource(
  source: CliOpenSource,
  stdinPath: string | null,
  resolvedScratchId?: string
): Promise<PreparedTab> {
  switch (source.kind) {
    case "file":
      return preparedFileTab(source.filePath)
    case "untitled":
      return preparedEmptyTab("untitled")
    case "ephemeral":
      return preparedEmptyTab("ephemeral")
    case "scratch": {
      if (!resolvedScratchId) {
        throw new Error("The CLI scratch source was not resolved")
      }
      return preparedScratchTab(resolvedScratchId, {
        title: source.id,
      })
    }
    case "stdin":
      if (!stdinPath) {
        throw new CliUsageError(
          "conflicting-options",
          "The standard-input (-) source requires piped input"
        )
      }
      return preparedStdinTab(stdinPath, source.name)
  }
}

interface PreparedCliTabs {
  preparedTabs: PreparedTab[]
  retainedLoads: Promise<PreparedTab>[]
}

function deferredCliSource(
  source: CliOpenSource,
  stdinPath: string | null,
  retainedLoads: Promise<PreparedTab>[],
  resolvedScratchId?: string
): PreparedTab {
  switch (source.kind) {
    case "file":
      return deferredFileTab(source.filePath)
    case "untitled":
      return preparedEmptyTab("untitled")
    case "ephemeral":
      return preparedEmptyTab("ephemeral")
    case "scratch": {
      if (!resolvedScratchId) {
        throw new Error("The deferred CLI scratch source was not resolved")
      }
      const deferredLoad = memoizedPreparedLoad(() =>
        preparedScratchTab(resolvedScratchId, { title: source.id })
      )
      return {
        backing: "scratch",
        contentHash: null,
        deferredLoad,
        diskFingerprint: null,
        dirty: false,
        document: {
          ...createEmptyDocument(),
          displayName: source.id,
          kind: "markdown",
        },
        ioPath: null,
        scratchIdentity: { scratchId: resolvedScratchId },
        title: source.id,
      }
    }
    case "stdin": {
      if (!stdinPath) {
        throw new CliUsageError(
          "conflicting-options",
          "The standard-input (-) source requires piped input"
        )
      }
      // The CLI server removes its private spool when this request settles.
      // Begin decoding after the active source is ready, retain the resulting
      // payload in this shared promise, and wait for it before permitting that
      // cleanup. Renderer hydration can join the same work at any time.
      const retainedLoad = preparedStdinTab(stdinPath, source.name)
      void retainedLoad.catch(() => undefined)
      retainedLoads.push(retainedLoad)
      return {
        ...preparedEmptyTab("untitled", { displayName: source.name }),
        baselineContent: "",
        deferredLoad: memoizedPreparedLoad(() => retainedLoad),
        dirty: true,
      }
    }
  }
}

async function prepareCliTabs(
  sources: readonly CliOpenSource[],
  activeIndex: number,
  stdinPath: string | null
): Promise<PreparedCliTabs> {
  const activeSource = sources[activeIndex]
  if (!activeSource) throw new Error("The active CLI source is unavailable")
  const resolvedScratchIds = new Array<string | undefined>(sources.length)
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!
    if (source.kind === "scratch") {
      resolvedScratchIds[index] = await resolveCliScratchId(source.id)
    }
  }
  const activeTab = await preparedCliSource(
    activeSource,
    stdinPath,
    resolvedScratchIds[activeIndex]
  )
  const retainedLoads: Promise<PreparedTab>[] = []
  const preparedTabs = sources.map((source, index) =>
    index === activeIndex
      ? activeTab
      : deferredCliSource(
          source,
          stdinPath,
          retainedLoads,
          resolvedScratchIds[index]
        )
  )
  return { preparedTabs, retainedLoads }
}

function preparedProfileTab(
  profile: ProfileSchemaV2,
  tab: ProfileTab
): Promise<PreparedTab> {
  const presentation = {
    ...(tab.color ? { color: tab.color as TabColor } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.mode ? { initialEditorMode: tab.mode } : {}),
    profileOrigin: { profileId: profile.id, tabId: tab.id },
  }
  const applyPresentation = (prepared: PreparedTab): PreparedTab => ({
    ...prepared,
    ...presentation,
  })
  switch (tab.kind) {
    case "file":
      return preparedFileTab(tab.path).then(applyPresentation)
    case "untitled":
      return Promise.resolve(applyPresentation(preparedEmptyTab("untitled")))
    case "ephemeral":
      return Promise.resolve(
        applyPresentation(
          preparedEmptyTab("ephemeral", {
            displayName: "Temporary",
          })
        )
      )
    case "scratch": {
      return preparedScratchTab(tab.scratchId, {
        ...presentation,
      }).then(applyPresentation)
    }
  }
}

function deferredProfileTab(
  profile: ProfileSchemaV2,
  tab: ProfileTab
): PreparedTab {
  const presentation = {
    ...(tab.color ? { color: tab.color as TabColor } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.mode ? { initialEditorMode: tab.mode } : {}),
    profileOrigin: { profileId: profile.id, tabId: tab.id },
  }
  const deferredLoad = () => preparedProfileTab(profile, tab)
  switch (tab.kind) {
    case "file": {
      const displayPath = path.resolve(tab.path)
      return {
        backing: "file",
        ...presentation,
        contentHash: null,
        deferredLoad,
        diskFingerprint: null,
        dirty: false,
        document: {
          ...createEmptyDocument(),
          displayName: path.basename(displayPath),
          filePath: displayPath,
          kind: documentKindForPath(displayPath),
        },
        fileMissing: false,
        ioPath: displayPath,
      }
    }
    case "untitled":
      return { ...preparedEmptyTab("untitled"), ...presentation }
    case "ephemeral":
      return {
        ...preparedEmptyTab("ephemeral", { displayName: "Temporary" }),
        ...presentation,
      }
    case "scratch": {
      return {
        backing: "scratch",
        ...presentation,
        contentHash: null,
        deferredLoad,
        diskFingerprint: null,
        dirty: false,
        document: {
          ...createEmptyDocument(),
          displayName: tab.title ?? "Untitled",
          kind: "markdown",
        },
        // The lexical recipe is enough for the tab descriptor. Actual I/O is
        // deferred until preparedScratchTab validates canonical containment.
        ioPath: null,
        scratchIdentity: { scratchId: tab.scratchId },
      }
    }
  }
}

function openScratchTab(scratchId: string): TabState | null {
  const openTabId = openScratchTabs.get(scratchId)
  if (!openTabId) return null
  const tab = tabStates.get(openTabId)
  if (tab?.scratchIdentity?.scratchId === scratchId) {
    return tab
  }
  openScratchTabs.delete(scratchId)
  return null
}

function registerOpenScratchTab(scratchId: string, tabId: TabId): void {
  if (openScratchTabs.has(scratchId)) {
    throw new Error(`Scratch document ${scratchId} is already open`)
  }
  openScratchTabs.set(scratchId, tabId)
  void scratchStore.markOpened(scratchId).catch((error) => {
    console.warn(`Unable to update scratch ${scratchId} opened time`, error)
  })
}

async function showOperationError(
  win: BrowserWindow,
  title: string,
  message: string,
  error: unknown
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error)
  await dialog.showMessageBox(win, {
    type: "error",
    title,
    message,
    detail,
    buttons: ["OK"],
  })
}

function addRecentDocument(filePath: string): void {
  const resolvedPath = path.resolve(filePath)
  const nextRecentDocuments = addRecentDocumentPath(
    recentDocuments,
    resolvedPath
  )
  if (!recentDocumentListsMatch(recentDocuments, nextRecentDocuments)) {
    recentDocuments = nextRecentDocuments
    scheduleRecentDocumentsPersistence()
    scheduleRecentDocumentsMenuRefresh()
  }

  if (process.platform !== "darwin" && process.platform !== "win32") return
  try {
    app.addRecentDocument(resolvedPath)
  } catch (error) {
    console.warn(`Unable to add ${filePath} to recent documents`, error)
  }
}

function clearRecentDocumentHistory(): void {
  if (recentDocuments.length > 0) {
    recentDocuments = []
    scheduleRecentDocumentsPersistence()
    scheduleRecentDocumentsMenuRefresh()
  }

  if (process.platform !== "darwin" && process.platform !== "win32") return
  try {
    app.clearRecentDocuments()
  } catch (error) {
    console.warn("Unable to clear system recent documents", error)
  }
}

function createTabState(
  ownerWindowId: WindowId,
  document = createEmptyDocument(),
  diskContentHash = documentContentHash(document),
  ioPath: string | null = document.filePath,
  options: {
    backing?: TabBackingKind
    color?: TabColor
    diskFingerprint?: FileFingerprint | null
    dirty?: boolean
    fileMissing?: boolean
    profileOrigin?: { profileId: string; tabId: string }
    scratchIdentity?: ScratchDocumentIdentity
    title?: string
  } = {}
): TabState {
  const backing =
    options.backing ?? (document.filePath === null ? "untitled" : "file")
  const diskFingerprint = options.diskFingerprint ?? null
  const tab: TabState = {
    backing,
    ...(options.color ? { color: options.color } : {}),
    diskContentHash,
    diskFingerprint,
    id: randomUUID(),
    dirty: options.dirty ?? false,
    document,
    fileMissing:
      options.fileMissing ??
      (backing === "file" && ioPath !== null && diskFingerprint === null),
    ioPath,
    ownerWindowId,
    profileOrigin: options.profileOrigin ?? null,
    pendingSaveCount: 0,
    pendingSaveTokens: new Set(),
    saveGeneration: 0,
    saveIdleWaiters: new Set(),
    saveQueue: Promise.resolve(),
    scratchIdentity: options.scratchIdentity ?? null,
    title: options.title ?? null,
  }
  if (tab.scratchIdentity) {
    const { scratchId } = tab.scratchIdentity
    registerOpenScratchTab(scratchId, tab.id)
  }
  tabStates.set(tab.id, tab)
  return tab
}

function tabSaveActive(tab: TabState): boolean {
  return tab.pendingSaveCount > 0 || tab.pendingSaveTokens.size > 0
}

function notifyTabSaveIdle(tab: TabState): void {
  if (tabSaveActive(tab)) return
  for (const resolve of tab.saveIdleWaiters) resolve()
  tab.saveIdleWaiters.clear()
}

async function waitForTabSaveIdle(tab: TabState): Promise<void> {
  while (tabSaveActive(tab)) {
    await new Promise<void>((resolve) => tab.saveIdleWaiters.add(resolve))
  }
}

async function acquireTabSaveTurn(tab: TabState): Promise<() => void> {
  return await acquireSaveTurn(tab, () => notifyTabSaveIdle(tab))
}

function clearPendingSaveAcknowledgement(token: string): void {
  const pending = pendingSaveAcknowledgements.get(token)
  if (!pending) return
  pendingSaveAcknowledgements.delete(token)
  clearTimeout(pending.timeout)
  const tab = tabStates.get(pending.tabId)
  tab?.pendingSaveTokens.delete(token)
  if (tab) notifyTabSaveIdle(tab)
}

function createPendingSaveAcknowledgement(
  tab: TabState,
  revision: number
): PendingSaveAcknowledgement {
  const token = randomUUID()
  const pending: PendingSaveAcknowledgement = {
    generation: tab.saveGeneration,
    ownerWindowId: tab.ownerWindowId,
    revision,
    tabId: tab.id,
    timeout: setTimeout(
      () => clearPendingSaveAcknowledgement(token),
      SAVE_ACKNOWLEDGEMENT_TIMEOUT_MS
    ),
    token,
  }
  pending.timeout.unref()
  pendingSaveAcknowledgements.set(token, pending)
  tab.pendingSaveTokens.add(token)
  return pending
}

function beginCliWait(tabIds: readonly TabId[], responder: CliResponder): void {
  const remainingTabIds = new Set(
    tabIds.filter((tabId) => tabStates.has(tabId))
  )
  responder.waiting()
  if (remainingTabIds.size === 0) {
    responder.complete()
    return
  }
  const id = randomUUID()
  const tracker: CliWaitTracker = {
    id,
    remainingTabIds,
    responder,
    unsubscribeDisconnect: () => undefined,
  }
  cliWaitTrackers.set(id, tracker)
  tracker.unsubscribeDisconnect = responder.onDisconnect(() => {
    cliWaitTrackers.delete(id)
  })
}

function completeCliWaitsForTab(tabId: TabId): void {
  for (const tracker of cliWaitTrackers.values()) {
    tracker.remainingTabIds.delete(tabId)
    if (tracker.remainingTabIds.size > 0) continue
    cliWaitTrackers.delete(tracker.id)
    tracker.unsubscribeDisconnect()
    tracker.responder.complete()
  }
}

function disposeTabState(tab: TabState): void {
  for (const state of windowStates.values()) {
    state.tabHydrations.delete(tab.id)
  }
  for (const token of [...tab.pendingSaveTokens]) {
    clearPendingSaveAcknowledgement(token)
  }
  unwatchTabDocument(tab.id)
  if (tab.scratchIdentity) {
    const { scratchId } = tab.scratchIdentity
    if (openScratchTabs.get(scratchId) === tab.id) {
      openScratchTabs.delete(scratchId)
    }
  }
  tabStates.delete(tab.id)
  completeCliWaitsForTab(tab.id)
  notifyTabSaveIdle(tab)
}

function watchedFilenameKey(fileName: string): string {
  const normalized = fileName.normalize("NFC")
  // Most macOS volumes are case-insensitive. Treat case aliases as the same
  // watch target there; on a case-sensitive macOS volume this can only cause
  // an extra fingerprint check for a colliding name, never a missed refresh.
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized
}

function clearExternalRefreshTimer(tabId: TabId): void {
  const timer = externalRefreshTimers.get(tabId)
  if (timer) clearTimeout(timer)
  externalRefreshTimers.delete(tabId)
}

function clearPendingExternalDocumentChange(tabId: TabId): void {
  const pending = pendingExternalDocumentChanges.get(tabId)
  if (pending) {
    pendingExternalChangeTabsByChangeId.delete(pending.change.changeId)
  }
  pendingExternalDocumentChanges.delete(tabId)
}

function setTabFileMissing(tab: TabState, missing: boolean): void {
  if (tab.fileMissing === missing) return
  tab.fileMissing = missing
  abortPendingTransfersForTab(tab.id)
  const owner = windowStates.get(tab.ownerWindowId)
  if (owner?.tabIds.includes(tab.id)) sendTabsChanged(owner)
}

function tabDirectoryWatchTarget(
  tab: TabState
): { directoryPath: string; filenameKey: string } | null {
  const filePath = tab.ioPath
  const owner = windowStates.get(tab.ownerWindowId)
  if (
    !filePath ||
    tab.backing === "scratch" ||
    !owner?.rendererReady ||
    owner.win.isDestroyed()
  ) {
    return null
  }
  return {
    directoryPath: path.dirname(filePath),
    filenameKey: watchedFilenameKey(path.basename(filePath)),
  }
}

function clearDirectoryWatchRecovery(
  directoryPath: string,
  recovery: DirectoryWatchRecoveryState
): void {
  if (directoryWatchRecoveries.get(directoryPath) !== recovery) return
  if (recovery.retryTimer) clearTimeout(recovery.retryTimer)
  if (recovery.stabilityTimer) clearTimeout(recovery.stabilityTimer)
  for (const tabId of recovery.pendingTabIds) {
    if (recoveringWatchDirectoryByTab.get(tabId) === directoryPath) {
      recoveringWatchDirectoryByTab.delete(tabId)
    }
  }
  directoryWatchRecoveries.delete(directoryPath)
}

function cleanupDirectoryWatchRecovery(directoryPath: string): void {
  const recovery = directoryWatchRecoveries.get(directoryPath)
  if (!recovery || recovery.pendingTabIds.size > 0) return
  if (recovery.retryTimer) {
    clearTimeout(recovery.retryTimer)
    recovery.retryTimer = null
  }
  if (directoryWatches.has(directoryPath)) return
  clearDirectoryWatchRecovery(directoryPath, recovery)
}

function removeTabFromDirectoryWatchRecovery(tabId: TabId): void {
  const directoryPath = recoveringWatchDirectoryByTab.get(tabId)
  if (!directoryPath) return
  recoveringWatchDirectoryByTab.delete(tabId)
  const recovery = directoryWatchRecoveries.get(directoryPath)
  recovery?.pendingTabIds.delete(tabId)
  cleanupDirectoryWatchRecovery(directoryPath)
}

function unwatchTabDocument(tabId: TabId, preservePendingChange = false): void {
  clearExternalRefreshTimer(tabId)
  forcedExternalRefreshes.delete(tabId)
  externalMissingFileRetries.delete(tabId)
  if (!preservePendingChange) {
    clearPendingExternalDocumentChange(tabId)
  }
  removeTabFromDirectoryWatchRecovery(tabId)
  const directoryPath = watchedDirectoryByTab.get(tabId)
  const filenameKey = watchedFilenameKeyByTab.get(tabId)
  watchedDirectoryByTab.delete(tabId)
  watchedFilenameKeyByTab.delete(tabId)
  if (!directoryPath) return

  const state = directoryWatches.get(directoryPath)
  if (!state) return
  state.tabIds.delete(tabId)
  if (filenameKey) {
    const matchingTabs = state.tabIdsByFilenameKey.get(filenameKey)
    matchingTabs?.delete(tabId)
    if (matchingTabs?.size === 0) {
      state.tabIdsByFilenameKey.delete(filenameKey)
    }
  }
  if (state.tabIds.size > 0) return
  state.watcher.close()
  directoryWatches.delete(directoryPath)
  cleanupDirectoryWatchRecovery(directoryPath)
}

function scheduleExternalRefresh(
  tabId: TabId,
  delay = EXTERNAL_CHANGE_DEBOUNCE_MS,
  forceRead = false
): void {
  clearExternalRefreshTimer(tabId)
  if (!tabStates.has(tabId)) {
    forcedExternalRefreshes.delete(tabId)
    return
  }
  if (forceRead) forcedExternalRefreshes.add(tabId)
  const timer = setTimeout(() => {
    externalRefreshTimers.delete(tabId)
    void refreshDocumentFromDisk(tabId)
  }, delay)
  timer.unref()
  externalRefreshTimers.set(tabId, timer)
}

function handleDirectoryWatchEvent(
  directoryPath: string,
  rawFileName: string | Buffer | null
): void {
  const state = directoryWatches.get(directoryPath)
  if (!state) return
  const changedKey =
    rawFileName === null
      ? null
      : watchedFilenameKey(
          typeof rawFileName === "string"
            ? rawFileName
            : rawFileName.toString("utf8")
        )

  const matchingTabIds =
    changedKey === null
      ? state.tabIds
      : (state.tabIdsByFilenameKey.get(changedKey) ?? [])
  for (const tabId of matchingTabIds) {
    const tab = tabStates.get(tabId)
    const filePath = tab?.ioPath
    if (filePath) {
      externalMissingFileRetries.delete(tabId)
      scheduleExternalRefresh(tabId, EXTERNAL_CHANGE_DEBOUNCE_MS, true)
    }
  }
}

function armDirectoryWatchStabilityReset(
  directoryPath: string,
  watchState: DirectoryWatchState
): void {
  const recovery = directoryWatchRecoveries.get(directoryPath)
  if (!recovery || recovery.consecutiveFailureCount === 0) return
  if (recovery.stabilityTimer) clearTimeout(recovery.stabilityTimer)
  const timer = setTimeout(() => {
    if (
      directoryWatchRecoveries.get(directoryPath) !== recovery ||
      directoryWatches.get(directoryPath) !== watchState
    ) {
      return
    }
    recovery.stabilityTimer = null
    recovery.consecutiveFailureCount = 0
    if (recovery.pendingTabIds.size === 0 && !recovery.retryTimer) {
      directoryWatchRecoveries.delete(directoryPath)
    }
  }, DIRECTORY_WATCH_STABILITY_RESET_MS)
  timer.unref()
  recovery.stabilityTimer = timer
}

function attachTabToDirectoryWatch(
  tab: TabState,
  state: DirectoryWatchState
): boolean {
  const target = tabDirectoryWatchTarget(tab)
  if (!target || target.directoryPath !== state.directoryPath) return false

  state.tabIds.add(tab.id)
  const matchingTabs =
    state.tabIdsByFilenameKey.get(target.filenameKey) ?? new Set<TabId>()
  matchingTabs.add(tab.id)
  state.tabIdsByFilenameKey.set(target.filenameKey, matchingTabs)
  watchedDirectoryByTab.set(tab.id, target.directoryPath)
  watchedFilenameKeyByTab.set(tab.id, target.filenameKey)
  removeTabFromDirectoryWatchRecovery(tab.id)
  void verifyDocumentBaseline(tab)
  return true
}

function createDirectoryWatch(directoryPath: string): DirectoryWatchState {
  const existing = directoryWatches.get(directoryPath)
  if (existing) return existing

  const watcher = watch(
    directoryPath,
    { encoding: "utf8", persistent: false },
    (_eventType, fileName) => handleDirectoryWatchEvent(directoryPath, fileName)
  )
  const state: DirectoryWatchState = {
    directoryPath,
    tabIdsByFilenameKey: new Map(),
    tabIds: new Set(),
    watcher,
  }
  directoryWatches.set(directoryPath, state)
  watcher.on("error", (error) => {
    if (directoryWatches.get(directoryPath) !== state) return
    const affectedTabIds = [...state.tabIds]
    directoryWatches.delete(directoryPath)
    watcher.close()
    for (const tabId of affectedTabIds) {
      if (watchedDirectoryByTab.get(tabId) === directoryPath) {
        watchedDirectoryByTab.delete(tabId)
        watchedFilenameKeyByTab.delete(tabId)
      }
    }
    recordDirectoryWatchFailure(directoryPath, affectedTabIds, error)
  })
  armDirectoryWatchStabilityReset(directoryPath, state)
  return state
}

function addPendingDirectoryWatchTab(
  directoryPath: string,
  recovery: DirectoryWatchRecoveryState,
  tabId: TabId
): void {
  const tab = tabStates.get(tabId)
  const target = tab ? tabDirectoryWatchTarget(tab) : null
  if (!target || target.directoryPath !== directoryPath) return

  const previousDirectory = recoveringWatchDirectoryByTab.get(tabId)
  if (previousDirectory && previousDirectory !== directoryPath) {
    const previousRecovery = directoryWatchRecoveries.get(previousDirectory)
    previousRecovery?.pendingTabIds.delete(tabId)
    cleanupDirectoryWatchRecovery(previousDirectory)
  }
  recovery.pendingTabIds.add(tabId)
  recoveringWatchDirectoryByTab.set(tabId, directoryPath)
}

function attemptDirectoryWatchRecovery(directoryPath: string): void {
  const recovery = directoryWatchRecoveries.get(directoryPath)
  if (!recovery) return
  recovery.retryTimer = null

  for (const tabId of [...recovery.pendingTabIds]) {
    const tab = tabStates.get(tabId)
    const target = tab ? tabDirectoryWatchTarget(tab) : null
    if (!target || target.directoryPath !== directoryPath) {
      recovery.pendingTabIds.delete(tabId)
      if (recoveringWatchDirectoryByTab.get(tabId) === directoryPath) {
        recoveringWatchDirectoryByTab.delete(tabId)
      }
    }
  }
  if (recovery.pendingTabIds.size === 0) {
    cleanupDirectoryWatchRecovery(directoryPath)
    return
  }

  let state: DirectoryWatchState
  try {
    state = createDirectoryWatch(directoryPath)
  } catch (error) {
    recordDirectoryWatchFailure(
      directoryPath,
      [...recovery.pendingTabIds],
      error
    )
    return
  }

  for (const tabId of [...recovery.pendingTabIds]) {
    const tab = tabStates.get(tabId)
    if (tab) attachTabToDirectoryWatch(tab, state)
  }
  armDirectoryWatchStabilityReset(directoryPath, state)
}

function recordDirectoryWatchFailure(
  directoryPath: string,
  affectedTabIds: readonly TabId[],
  error: unknown
): void {
  const recovery =
    directoryWatchRecoveries.get(directoryPath) ??
    ({
      consecutiveFailureCount: 0,
      pendingTabIds: new Set<TabId>(),
      retryTimer: null,
      stabilityTimer: null,
    } satisfies DirectoryWatchRecoveryState)
  directoryWatchRecoveries.set(directoryPath, recovery)
  if (recovery.stabilityTimer) {
    clearTimeout(recovery.stabilityTimer)
    recovery.stabilityTimer = null
  }
  for (const tabId of affectedTabIds) {
    addPendingDirectoryWatchTab(directoryPath, recovery, tabId)
  }
  recovery.consecutiveFailureCount += 1

  const retryDelay = directoryWatchRetryDelay(recovery.consecutiveFailureCount)
  console.warn(
    retryDelay === null
      ? `Unable to watch ${directoryPath}; automated retries exhausted`
      : `Unable to watch ${directoryPath}; retrying in ${retryDelay} ms`,
    error
  )
  if (recovery.pendingTabIds.size === 0) {
    cleanupDirectoryWatchRecovery(directoryPath)
    return
  }
  if (recovery.retryTimer) clearTimeout(recovery.retryTimer)
  recovery.retryTimer = null
  if (retryDelay === null) return

  const retryTimer = setTimeout(
    () => attemptDirectoryWatchRecovery(directoryPath),
    retryDelay
  )
  retryTimer.unref()
  recovery.retryTimer = retryTimer
}

async function verifyDocumentBaseline(tab: TabState): Promise<void> {
  const ioPath = tab.ioPath
  const initialFingerprint = tab.diskFingerprint
  if (!ioPath || tab.backing === "scratch") return
  try {
    const currentStats = await stat(ioPath)
    if (tabStates.get(tab.id) !== tab || tab.ioPath !== ioPath) return
    if (
      !currentStats.isFile() ||
      !fileFingerprintsMatch(initialFingerprint, fileFingerprint(currentStats))
    ) {
      scheduleExternalRefresh(tab.id, 0, true)
    }
  } catch (error) {
    if (tabStates.get(tab.id) !== tab || tab.ioPath !== ioPath) return
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (initialFingerprint !== null) {
        scheduleExternalRefresh(tab.id, 0, true)
      }
      return
    }
    console.warn(`Unable to verify ${ioPath} after watching it`, error)
  }
}

function watchTabDocument(tab: TabState, preservePendingChange = false): void {
  const target = tabDirectoryWatchTarget(tab)
  if (!target) {
    unwatchTabDocument(tab.id, preservePendingChange)
    return
  }

  if (
    watchedDirectoryByTab.get(tab.id) === target.directoryPath &&
    watchedFilenameKeyByTab.get(tab.id) === target.filenameKey
  ) {
    void verifyDocumentBaseline(tab)
    return
  }

  unwatchTabDocument(tab.id, preservePendingChange)
  const existing = directoryWatches.get(target.directoryPath)
  if (existing) {
    attachTabToDirectoryWatch(tab, existing)
    return
  }

  const recovery = directoryWatchRecoveries.get(target.directoryPath)
  if (recovery) {
    addPendingDirectoryWatchTab(target.directoryPath, recovery, tab.id)
    void verifyDocumentBaseline(tab)
    return
  }

  try {
    const state = createDirectoryWatch(target.directoryPath)
    attachTabToDirectoryWatch(tab, state)
  } catch (error) {
    recordDirectoryWatchFailure(target.directoryPath, [tab.id], error)
    void verifyDocumentBaseline(tab)
  }
}

function verifyActivatedTabDocument(state: WindowState): void {
  if (!state.rendererReady || state.win.isDestroyed()) return
  const tab = tabStates.get(state.activeTabId)
  if (!tab || tab.ownerWindowId !== state.win.id) return

  void verifyDocumentBaseline(tab)
  const target = tabDirectoryWatchTarget(tab)
  if (!target || watchedDirectoryByTab.has(tab.id)) return
  const recovery = directoryWatchRecoveries.get(target.directoryPath)
  if (!recovery) {
    watchTabDocument(tab, true)
    return
  }
  addPendingDirectoryWatchTab(target.directoryPath, recovery, tab.id)
  if (
    !recovery.retryTimer &&
    directoryWatchRetryDelay(recovery.consecutiveFailureCount) === null
  ) {
    recovery.consecutiveFailureCount = 0
    attemptDirectoryWatchRecovery(target.directoryPath)
  }
}

async function refreshDocumentFromDisk(tabId: TabId): Promise<void> {
  const initialTab = tabStates.get(tabId)
  const displayPath = initialTab?.document.filePath
  const ioPath = initialTab?.ioPath
  const initialContentHash = initialTab?.diskContentHash
  const initialFingerprint = initialTab?.diskFingerprint ?? null
  const initialMtimeMs = initialTab?.document.mtimeMs
  if (
    !initialTab ||
    !displayPath ||
    !ioPath ||
    initialTab.dirty ||
    initialTab.pendingSaveCount > 0 ||
    pendingExternalDocumentChanges.has(tabId)
  ) {
    return
  }
  const forceRead = forcedExternalRefreshes.delete(tabId)

  let loaded: LoadedDocument
  try {
    if (!forceRead) {
      const currentStats = await stat(ioPath)
      if (!currentStats.isFile()) {
        throw new Error("The selected path is not a file")
      }
      if (
        fileFingerprintsMatch(initialFingerprint, fileFingerprint(currentStats))
      ) {
        return
      }
    }
    loaded = await readDocument(ioPath, displayPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (!externalMissingFileRetries.has(tabId)) {
        externalMissingFileRetries.add(tabId)
        scheduleExternalRefresh(tabId, EXTERNAL_CHANGE_RETRY_MS, forceRead)
        return
      }
      const tab = tabStates.get(tabId)
      if (
        tab === initialTab &&
        tab.document.filePath === displayPath &&
        tab.ioPath === ioPath &&
        tab.document.mtimeMs === initialMtimeMs &&
        tab.diskContentHash === initialContentHash &&
        fileFingerprintsMatch(tab.diskFingerprint, initialFingerprint) &&
        !tab.dirty &&
        tab.pendingSaveCount === 0 &&
        !pendingExternalDocumentChanges.has(tabId)
      ) {
        setTabFileMissing(tab, true)
      }
      return
    }
    console.warn(`Unable to refresh ${ioPath}`, error)
    return
  }
  externalMissingFileRetries.delete(tabId)

  const tab = tabStates.get(tabId)
  if (
    tab !== initialTab ||
    tab.document.filePath !== displayPath ||
    tab.ioPath !== ioPath ||
    loaded.ioPath !== ioPath ||
    tab.document.mtimeMs !== initialMtimeMs ||
    tab.diskContentHash !== initialContentHash ||
    !fileFingerprintsMatch(tab.diskFingerprint, initialFingerprint) ||
    tab.dirty ||
    tab.pendingSaveCount > 0 ||
    pendingExternalDocumentChanges.has(tabId)
  ) {
    if (forceRead && tabStates.has(tabId)) {
      forcedExternalRefreshes.add(tabId)
    }
    return
  }

  const { contentHash: nextContentHash, document } = loaded
  if (nextContentHash === tab.diskContentHash) {
    tab.document.mtimeMs = document.mtimeMs
    tab.diskFingerprint = loaded.fingerprint
    setTabFileMissing(tab, false)
    return
  }

  const owner = windowStates.get(tab.ownerWindowId)
  if (
    !owner?.rendererReady ||
    owner.win.isDestroyed() ||
    owner.win.webContents.isDestroyed() ||
    !owner.tabIds.includes(tab.id)
  ) {
    return
  }

  const change: ExternalDocumentChange = {
    changeId: randomUUID(),
    document,
    expectedMtimeMs: tab.document.mtimeMs,
    tabId,
  }
  abortPendingTransfersForTab(tabId)
  clearPendingExternalDocumentChange(tabId)
  const pending = {
    change,
    contentHash: nextContentHash,
    fingerprint: loaded.fingerprint,
    ownerWindowId: owner.win.id,
  }
  pendingExternalDocumentChanges.set(tabId, pending)
  pendingExternalChangeTabsByChangeId.set(change.changeId, tabId)
  owner.win.webContents.send(ipcChannels.externalDocumentChange, change)
}

function tabDescriptor(tab: TabState): TabDescriptor {
  return {
    id: tab.id,
    backing: tab.backing,
    ...(tab.color ? { color: tab.color } : {}),
    dirty: tab.dirty,
    displayName: tab.title ?? tab.document.displayName,
    fileMissing: tab.fileMissing,
    filePath: tab.document.filePath,
    kind: tab.document.kind,
    ...(tab.scratchIdentity
      ? { scratchId: tab.scratchIdentity.scratchId }
      : {}),
  }
}

function suggestedSaveName(tab: TabState): string {
  const displayName = (tab.title ?? tab.document.displayName ?? "Untitled")
    .trim()
    .replaceAll(/[\\/]/g, "-")
  const safeName = displayName || "Untitled"
  const extension = path.extname(safeName).slice(1).toLowerCase()
  return extension && RECOGNIZED_DOCUMENT_EXTENSIONS.has(extension)
    ? safeName
    : `${safeName}.md`
}

function bootstrapTab(
  tab: TabState,
  editorSession?: SerializedEditorSession,
  options: {
    baselineContent?: string
    initialCursor?: { line: number; column: number }
    initialEditorMode?: EditorMode
    initialViewport?: EditorViewport
  } = {}
): BootstrapTab {
  return {
    tab: tabDescriptor(tab),
    document: {
      ...cloneDocument(tab.document),
      displayName: tab.title ?? tab.document.displayName,
    },
    ...(options.baselineContent !== undefined
      ? { baselineContent: options.baselineContent }
      : {}),
    ...(editorSession ? { editorSession } : {}),
    ...(options.initialEditorMode
      ? { initialEditorMode: options.initialEditorMode }
      : {}),
    ...(options.initialViewport
      ? { initialViewport: { ...options.initialViewport } }
      : {}),
    ...(options.initialCursor ? { initialCursor: options.initialCursor } : {}),
  }
}

function windowSnapshot(state: WindowState): WindowTabsSnapshot {
  if (state.tabIds.length === 0) {
    throw new Error("An empty window has no tabs snapshot")
  }
  return {
    windowId: state.win.id,
    activeTabId: state.activeTabId,
    tabDragSink: state.provisional,
    tabs: state.tabIds.map((tabId) => {
      const tab = tabStates.get(tabId)
      if (!tab) throw new Error("Window references an unknown tab")
      return tabDescriptor(tab)
    }),
  }
}

function trustedRendererLocation(url: URL): TrustedRendererLocation {
  return {
    host: url.host,
    pathname: url.pathname,
    protocol: url.protocol,
  }
}

function isTrustedRendererUrl(
  value: string,
  expected: TrustedRendererLocation
): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === expected.protocol &&
      url.host === expected.host &&
      url.pathname === expected.pathname
    )
  } catch {
    return false
  }
}

const TRUSTED_RENDERER_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "local-fonts",
])

function isTrustedRendererPermissionRequest(
  webContents: WebContents | null,
  permission: string,
  requestingUrl: string
) {
  if (!webContents || !TRUSTED_RENDERER_PERMISSIONS.has(permission)) {
    return false
  }
  const win = BrowserWindow.fromWebContents(webContents)
  const state = win ? windowStates.get(win.id) : undefined
  return Boolean(
    win &&
    state &&
    !win.isDestroyed() &&
    webContents.mainFrame.url === requestingUrl &&
    isTrustedRendererUrl(requestingUrl, state.trustedRendererLocation)
  )
}

function stateForSender(event: IpcMainEvent | IpcMainInvokeEvent): {
  state: WindowState
  win: BrowserWindow
} {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("IPC is only accepted from the main frame")
  }

  const win = BrowserWindow.fromWebContents(event.sender)
  const state = win ? windowStates.get(win.id) : undefined
  if (!win || !state || win.isDestroyed()) {
    throw new Error("IPC sender is not an application window")
  }
  if (
    state.recoverySurfaceActive ||
    !isTrustedRendererUrl(event.senderFrame.url, state.trustedRendererLocation)
  ) {
    throw new Error("IPC sender is not the trusted application renderer")
  }
  return { state, win }
}

function spellingWordFromUnknown(value: unknown): string {
  if (!isSpellingToken(value)) {
    throw new TypeError("Invalid spelling word")
  }
  return value
}

function broadcastSpellCheckDictionaryChanged(
  changedSession: Electron.Session
): void {
  for (const { win } of windowStates.values()) {
    if (
      win.isDestroyed() ||
      win.webContents.isDestroyed() ||
      win.webContents.session !== changedSession
    ) {
      continue
    }
    win.webContents.send(ipcChannels.spellCheckDictionaryChanged)
  }
}

function stateForRecoverySender(event: IpcMainEvent | IpcMainInvokeEvent): {
  state: WindowState
  win: BrowserWindow
} {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Recovery IPC is only accepted from the main frame")
  }
  const win = BrowserWindow.fromWebContents(event.sender)
  const state = win ? windowStates.get(win.id) : undefined
  if (
    !win ||
    !state ||
    win.isDestroyed() ||
    !state.recoverySurfaceActive ||
    !isTrustedRendererUrl(event.senderFrame.url, state.trustedRendererLocation)
  ) {
    throw new Error("IPC sender is not the active recovery surface")
  }
  return { state, win }
}

function ensureWindowMutable(state: WindowState): void {
  if (state.provisional) {
    throw new Error("Provisional windows cannot mutate application state")
  }
  if (state.closeSequence || state.allowClose || state.win.isDestroyed()) {
    throw new Error("Window is closing")
  }
  if (state.tabMutationLocked) {
    throw new Error("Window is completing another tab operation")
  }
}

function unlockTabMutation(state: WindowState): void {
  const metadataChanged = state.tabMutationMetadataChanged
  const externalRefreshTabIds = drainDeferredExternalRefreshes(
    state.tabMutationExternalRefreshTabIds
  )
  state.tabMutationLocked = false
  deliverPendingExternalScratchActivation(state)
  state.tabMutationMetadataChanged = false
  if (metadataChanged && !state.win.isDestroyed()) {
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    if (BrowserWindow.getFocusedWindow()?.id === state.win.id) {
      updateViewMenuItems(state)
    }
  }
  if (!state.win.isDestroyed()) {
    for (const tabId of externalRefreshTabIds) {
      scheduleExternalRefresh(tabId)
    }
  }
  for (const resolve of state.tabMutationWaiters) resolve()
  state.tabMutationWaiters.clear()
}

async function waitForTabMutation(state: WindowState): Promise<void> {
  if (!state.tabMutationLocked) return
  await new Promise<void>((resolve) => state.tabMutationWaiters.add(resolve))
}

function ownedTabForState(state: WindowState, value: unknown): TabState {
  const tabId = normalizeIdentifier(value, "Tab id")
  const tab = tabStates.get(tabId)
  if (
    !tab ||
    tab.ownerWindowId !== state.win.id ||
    !state.tabIds.includes(tabId)
  ) {
    throw new Error("Tab does not belong to the sender window")
  }
  return tab
}

function hydrationTabForState(state: WindowState, value: unknown): TabState {
  const tabId = normalizeIdentifier(value, "Tab id")
  const tab = tabStates.get(tabId)
  if (!tab || !tabCanHydrateInState(state, tab)) {
    throw new Error("Tab cannot hydrate in the sender window")
  }
  return tab
}

function tabStillOwnedByState(state: WindowState, tab: TabState): boolean {
  return (
    windowStates.get(state.win.id) === state &&
    !state.win.isDestroyed() &&
    tabStates.get(tab.id) === tab &&
    tab.ownerWindowId === state.win.id &&
    state.tabIds.includes(tab.id)
  )
}

function updateWindowNativeDocument(state: WindowState): void {
  const { win } = state
  if (win.isDestroyed() || state.tabIds.length === 0) return
  const activeTab = tabStates.get(state.activeTabId)
  if (!activeTab) return

  win.setTitle(
    `${activeTab.title ?? activeTab.document.displayName} — ${PRODUCT_NAME}`
  )
  if (process.platform === "darwin") {
    win.setDocumentEdited(
      state.tabIds.some((tabId) => tabStates.get(tabId)?.dirty === true)
    )
    win.setRepresentedFilename(activeTab.document.filePath ?? "")
  }
}

function sendTabsChanged(state: WindowState): void {
  if (
    !state.rendererReady ||
    state.win.isDestroyed() ||
    state.win.webContents.isDestroyed() ||
    state.tabIds.length === 0
  ) {
    return
  }
  state.win.webContents.send(ipcChannels.tabsChanged, windowSnapshot(state))
}

function tabDescriptorsMatch(
  left: TabDescriptor,
  right: TabDescriptor
): boolean {
  return (
    left.id === right.id &&
    left.backing === right.backing &&
    left.color === right.color &&
    left.dirty === right.dirty &&
    left.displayName === right.displayName &&
    left.fileMissing === right.fileMissing &&
    left.filePath === right.filePath &&
    left.kind === right.kind &&
    left.scratchId === right.scratchId
  )
}

function registerTabHydration(
  state: WindowState,
  tabId: TabId,
  load: PendingTabHydration["load"],
  options: {
    initialEditorMode?: EditorMode
    recordRecentDocument?: boolean
  } = {}
): void {
  state.tabHydrations.set(tabId, {
    inFlight: null,
    ...(options.initialEditorMode
      ? { initialEditorMode: options.initialEditorMode }
      : {}),
    load,
    recordRecentDocument: options.recordRecentDocument !== false,
  })
}

function tabCanHydrateInState(state: WindowState, tab: TabState): boolean {
  return (
    windowStates.get(state.win.id) === state &&
    !state.win.isDestroyed() &&
    tabStates.get(tab.id) === tab &&
    (state.provisional || tab.ownerWindowId === state.win.id) &&
    state.tabIds.includes(tab.id)
  )
}

async function tabCanHydrateDuringIdle(
  state: WindowState,
  tab: TabState
): Promise<boolean> {
  if (!tabSizeAllowsIdleHydration(tab.document.content.length, null)) {
    return false
  }
  let backingPath = tab.ioPath
  if (!backingPath && tab.backing === "scratch" && tab.scratchIdentity) {
    try {
      backingPath = await scratchStore.pathFor(tab.scratchIdentity.scratchId)
    } catch {
      // The ordinary hydration path owns actionable storage errors. Do not
      // turn a missing or invalid scratch into a permanently deferred tab.
      return true
    }
  }
  if (!backingPath) return true

  try {
    const currentStats = await stat(backingPath)
    if (!tabCanHydrateInState(state, tab)) return false
    return (
      !currentStats.isFile() ||
      tabSizeAllowsIdleHydration(tab.document.content.length, currentStats.size)
    )
  } catch {
    // Let the ordinary hydration path surface missing, inaccessible, or
    // non-file sources. Size policy must not turn a real open failure into a
    // permanently deferred tab.
    return true
  }
}

async function hydrateTabForRenderer(
  state: WindowState,
  tabId: TabId,
  interactive: boolean,
  allowEmptyFallback = false
): Promise<BootstrapTab | null> {
  const pending = state.tabHydrations.get(tabId)
  const tab = tabStates.get(tabId)
  if (!pending || !tab || !tabCanHydrateInState(state, tab)) return null
  if (
    !interactive &&
    (!(await tabCanHydrateDuringIdle(state, tab)) ||
      state.tabHydrations.get(tabId) !== pending ||
      !tabCanHydrateInState(state, tab))
  ) {
    return null
  }

  const descriptorBefore = tabDescriptor(tab)
  const bootstrap = await runPendingHydration(
    pending,
    interactive,
    allowEmptyFallback,
    () =>
      state.tabHydrations.get(tabId) === pending &&
      tabStates.get(tabId) === tab &&
      tabCanHydrateInState(state, tab)
  )
  if (!bootstrap || bootstrap.tab.id !== tabId) return null
  if (
    !interactive &&
    !tabSizeAllowsIdleHydration(
      bootstrap.document.content.length,
      tab.diskFingerprint?.size ?? null
    )
  ) {
    // The file can grow between the policy stat and the stable read. Keep the
    // hydration registered so a later interactive request reloads the current
    // bytes instead of synchronously materializing a very large EditorState in
    // background work.
    return null
  }
  const currentTab = tabStates.get(tabId)
  if (
    !currentTab ||
    currentTab !== tab ||
    !tabCanHydrateInState(state, currentTab) ||
    state.tabHydrations.get(tabId) !== pending
  ) {
    return null
  }

  if (
    state.rendererReady &&
    !tabDescriptorsMatch(descriptorBefore, tabDescriptor(currentTab))
  ) {
    sendTabsChanged(state)
  }
  return bootstrap
}

function acknowledgeTabHydration(state: WindowState, tabId: TabId): void {
  const pending = state.tabHydrations.get(tabId)
  const tab = tabStates.get(tabId)
  if (!pending || !tab || !tabCanHydrateInState(state, tab)) return

  state.tabHydrations.delete(tabId)
  tab.document.content = ""
  if (
    pending.recordRecentDocument &&
    tab.backing === "file" &&
    tab.document.filePath &&
    tab.diskFingerprint
  ) {
    addRecentDocument(tab.document.filePath)
  }
  if (state.rendererReady) watchTabDocument(tab)
  if (state.activeTabId === tabId) updateWindowNativeDocument(state)
}

function waitForEditorReady(
  state: WindowState,
  timeoutMs = 10_000
): Promise<boolean> {
  if (state.editorReady) return Promise.resolve(true)
  if (state.win.isDestroyed()) return Promise.resolve(false)
  return new Promise((resolve) => {
    function finish() {
      clearTimeout(timeout)
      state.editorReadyWaiters.delete(finish)
      resolve(state.editorReady && !state.win.isDestroyed())
    }
    const timeout = setTimeout(finish, timeoutMs)
    timeout.unref()
    state.editorReadyWaiters.add(finish)
  })
}

function finishPendingEditorCommand(requestId: string, handled: boolean): void {
  const pending = pendingEditorCommandAcknowledgements.get(requestId)
  if (!pending) return
  pendingEditorCommandAcknowledgements.delete(requestId)
  pending.resolve(handled)
}

function requestRendererHandleEditorCommand(
  state: WindowState,
  command: EditorCommand
): Promise<boolean> {
  if (state.win.isDestroyed() || state.win.webContents.isDestroyed()) {
    return Promise.resolve(false)
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pendingEditorCommandAcknowledgements.set(requestId, {
      ownerWindowId: state.win.id,
      resolve,
    })
    state.win.webContents.send(ipcChannels.command, { command, requestId })
  })
}

async function drainPendingEditorCommands(state: WindowState): Promise<void> {
  if (state.editorCommandDrainActive || state.editorReady) return
  state.editorCommandDrainActive = true
  try {
    while (state.pendingEditorCommands.length > 0) {
      const command = state.pendingEditorCommands.shift()!
      if (!(await requestRendererHandleEditorCommand(state, command))) return
    }
    if (state.win.isDestroyed() || state.win.webContents.isDestroyed()) return
    state.editorReady = true
  } finally {
    state.editorCommandDrainActive = false
  }
  if (!state.editorReady) return
  if (BrowserWindow.getFocusedWindow()?.id === state.win.id) {
    updateViewMenuItems(state)
  }
  for (const resolve of state.editorReadyWaiters) resolve()
  state.editorReadyWaiters.clear()
}

function markEditorReady(state: WindowState): void {
  if (state.editorCommandHandlingReady) return
  state.editorCommandHandlingReady = true
  void drainPendingEditorCommands(state)
}

function activateTabInState(state: WindowState, tabId: TabId): void {
  ownedTabForState(state, tabId)
  state.activeTabId = tabId
  updateWindowNativeDocument(state)
  verifyActivatedTabDocument(state)
}

function removeTabFromState(state: WindowState, tabId: TabId): number {
  const index = state.tabIds.indexOf(tabId)
  if (index < 0) throw new Error("Window does not contain the tab")
  state.tabIds.splice(index, 1)
  state.approvedTabCloses.delete(tabId)
  return index
}

function updateReopenClosedDocumentMenuItem(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(
    REOPEN_CLOSED_DOCUMENT_MENU_ITEM_ID
  )
  if (!item) return
  const focused = BrowserWindow.getFocusedWindow()
  const state = focused ? windowStates.get(focused.id) : undefined
  const liveState =
    state && !state.win.isDestroyed() && !state.recoverySurfaceActive
      ? state
      : undefined
  const settingsSurfaceOpen = Boolean(
    liveState?.editorMenuState.settingsDialogOpen ||
    liveState?.editorMenuState.settingsWorkspaceOpen
  )
  item.enabled =
    closedDocumentHistory.length > 0 &&
    (!focused || Boolean(liveState && !settingsSurfaceOpen))
}

function rememberClosedDocument(
  tab: TabState,
  viewport: EditorViewport | null = null
): void {
  if (tab.backing === "ephemeral" || tab.backing === "scratch") return
  closedDocumentHistory.push({
    filePath: tab.document.filePath,
    originWindowId: tab.ownerWindowId,
    viewport,
  })
  updateReopenClosedDocumentMenuItem()
}

function closedDocumentOriginState(
  document: ClosedDocument
): WindowState | null {
  const state = windowStates.get(document.originWindowId)
  return state &&
    windowStates.get(state.win.id) === state &&
    !state.win.isDestroyed() &&
    !state.provisional &&
    state.rendererReady &&
    state.editorReady &&
    !state.recoverySurfaceActive &&
    !state.editorMenuState.settingsDialogOpen &&
    !state.editorMenuState.settingsWorkspaceOpen &&
    !state.tabMutationLocked &&
    !state.closeSequence &&
    !state.allowClose
    ? state
    : null
}

async function reopenClosedDocumentInOrigin(
  document: ClosedDocument,
  state: WindowState
): Promise<boolean> {
  if (!state.rendererReady || !state.editorReady) return false

  const prepared = document.filePath
    ? await preparedFileTab(document.filePath)
    : preparedEmptyTab("untitled")
  if (
    !(await showAndWaitForCliWindow(state)) ||
    closedDocumentOriginState(document) !== state
  ) {
    return false
  }

  const previousActiveTabId = state.activeTabId
  const tab = createTabState(
    state.win.id,
    cloneDocument(prepared.document),
    prepared.contentHash,
    prepared.ioPath,
    {
      backing: prepared.backing,
      diskFingerprint: prepared.diskFingerprint,
      dirty: prepared.dirty,
    }
  )
  state.tabIds.push(tab.id)
  state.activeTabId = tab.id
  const accepted = await requestRendererOpenCliTabs(
    state,
    {
      requestId: randomUUID(),
      activeTabId: tab.id,
      tabs: [
        bootstrapTab(tab, undefined, {
          ...(document.viewport ? { initialViewport: document.viewport } : {}),
        }),
      ],
    },
    [tab.id]
  )
  if (!accepted) {
    const index = state.tabIds.indexOf(tab.id)
    if (index >= 0) state.tabIds.splice(index, 1)
    if (state.tabIds.includes(previousActiveTabId)) {
      state.activeTabId = previousActiveTabId
    }
    if (tabStates.get(tab.id) === tab) disposeTabState(tab)
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    return false
  }

  tab.document.content = ""
  watchTabDocument(tab)
  updateWindowNativeDocument(state)
  sendTabsChanged(state)
  return true
}

async function reopenClosedDocumentFromHistory(): Promise<void> {
  const document = closedDocumentHistory.pop()
  if (!document) return
  updateReopenClosedDocumentMenuItem()

  const origin = closedDocumentOriginState(document)
  if (origin) {
    try {
      if (await reopenClosedDocumentInOrigin(document, origin)) return
    } catch (error) {
      const survivingOrigin = closedDocumentOriginState(document)
      if (survivingOrigin) {
        closedDocumentHistory.push(document)
        updateReopenClosedDocumentMenuItem()
        await showOperationError(
          survivingOrigin.win,
          "Reopen Failed",
          "The document could not be reopened in its original window.",
          error
        )
        return
      }
      console.warn(
        "The original window closed while reopening its document; using a new window",
        error
      )
    }
    if (closedDocumentOriginState(document)) {
      closedDocumentHistory.push(document)
      updateReopenClosedDocumentMenuItem()
      return
    }
  }

  await createDocumentWindow({
    filePaths: document.filePath ? [document.filePath] : [],
    initialViewports: [document.viewport],
  })
}

function reopenClosedDocument(): void {
  void reopenClosedDocumentFromHistory()
}

function normalizeSettingsTransferOptions(
  value: unknown
): SettingsTransferOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Settings transfer options must be an object")
  }
  const candidate = value as Partial<SettingsTransferOptions>
  if (
    typeof candidate.profiles !== "boolean" ||
    typeof candidate.scratches !== "boolean"
  ) {
    throw new TypeError("Settings transfer options are invalid")
  }
  return {
    profiles: candidate.profiles,
    scratches: candidate.scratches,
  }
}

function missingProfileError(error: unknown, profileId: string): boolean {
  return error instanceof ProfileNotFoundError && error.profileId === profileId
}

function settingsImportProfileReplacement(
  profile: ProfileSchemaV2
): SettingsImportReplacement {
  return {
    apply: async () => {
      await profileStore.save(profile, true)
    },
    captureRollback: async () => {
      let original: Awaited<
        ReturnType<typeof profileStore.readStoredProfileSnapshot>
      >
      try {
        original = await profileStore.readStoredProfileSnapshot(profile.id)
      } catch (error) {
        if (!missingProfileError(error, profile.id)) throw error
        return async () => {
          try {
            await profileStore.deleteDefinition(profile.id)
          } catch (deleteError) {
            if (!missingProfileError(deleteError, profile.id)) {
              throw deleteError
            }
          }
        }
      }
      return async () => {
        await profileStore.restoreStoredProfileSnapshot(profile.id, original)
      }
    },
  }
}

function settingsImportScratchReplacement(
  scratches: readonly SettingsArchiveScratchInput[]
): SettingsImportReplacement {
  const importedSnapshots: ScratchFileSnapshot[] = scratches.map((scratch) => ({
    content: rewriteCanonicalScratchMarkdownLinkSchemes(
      Buffer.from(scratch.content),
      EXTERNAL_SCRATCH_LINK_SCHEME
    ),
    entry: {
      createdAt: scratch.createdAt,
      fileName: scratch.fileName,
      id: scratch.id,
      lastOpenedAt: scratch.lastOpenedAt,
      ...(scratch.title === null ? {} : { title: scratch.title }),
    },
    mode: 0o600,
    modifiedAt: scratch.modifiedAt,
  }))
  let rollback: (() => Promise<void>) | null = null
  return {
    apply: async () => {
      const replacement = await scratchStore.upsertSnapshots(importedSnapshots)
      rollback = replacement.rollback
    },
    captureRollback: async () => async () => await rollback?.(),
  }
}

function lastUsableCommandWindow(): BrowserWindow | null {
  if (lastFocusedWindowId === null) return null
  const win = windowStates.get(lastFocusedWindowId)?.win
  return win && !win.isDestroyed() ? win : null
}

function releaseSettingsSessionForWindow(windowId: WindowId): void {
  if (settingsSessionOwnerWindowId !== windowId) return
  const state = windowStates.get(windowId)
  const hadAppearancePreview = Boolean(state?.appearancePreview)
  if (state) state.appearancePreview = null
  applyWindowsNativeThemeSource(settings)
  if (hadAppearancePreview && state && windowCanReceiveVisualEffect(state)) {
    applyWindowVisualEffect(state, settings)
  }
  if (pendingSettingsImport?.ownerWindowId === windowId) {
    pendingSettingsImport = null
  }
  settingsSessionOwnerWindowId = null
}

function activeSettingsSessionOwner(): WindowState | null {
  if (settingsSessionOwnerWindowId === null) return null
  const state = windowStates.get(settingsSessionOwnerWindowId)
  if (
    !state ||
    state.win.isDestroyed() ||
    state.recoverySurfaceActive ||
    state.recoveryInProgress
  ) {
    releaseSettingsSessionForWindow(settingsSessionOwnerWindowId)
    return null
  }
  return state
}

function sendCommand(
  command: EditorCommand,
  target?: BrowserWindow | null
): void {
  const win =
    target ?? BrowserWindow.getFocusedWindow() ?? lastUsableCommandWindow()
  if (!win || win.isDestroyed()) return
  const state = windowStates.get(win.id)
  if (!state) return
  const settingsOwner =
    command === "settings" || command === "keyboard-shortcuts"
      ? activeSettingsSessionOwner()
      : null
  if (settingsOwner && settingsOwner.win.id !== win.id) {
    if (settingsOwner.win.isMinimized()) settingsOwner.win.restore()
    settingsOwner.win.show()
    settingsOwner.win.focus()
    if (
      command === "keyboard-shortcuts" &&
      settingsOwner.editorMenuState.settingsDialogOpen &&
      settingsOwner.editorReady
    ) {
      settingsOwner.win.webContents.send(ipcChannels.command, command)
    }
    return
  }
  if (!state.editorReady) {
    state.pendingEditorCommands.push(command)
    return
  }
  win.webContents.send(ipcChannels.command, command)
}

type NoWindowCommandBehavior = "create" | "create-and-send"

async function createWindowForCommand(
  command: EditorCommand,
  behavior: NoWindowCommandBehavior
): Promise<void> {
  const win = await createDocumentWindow()
  if (win && behavior === "create-and-send") sendCommand(command, win)
}

function commandMenuItem(
  label: string,
  command: EditorCommand,
  accelerator?: string,
  options: {
    id?: string
    noWindow?: NoWindowCommandBehavior
  } = {}
): MenuItemConstructorOptions {
  return {
    ...(options.id ? { id: options.id } : {}),
    label,
    accelerator,
    click: (_item, win) => {
      const target = win ? BrowserWindow.fromId(win.id) : null
      const remembered = lastUsableCommandWindow()
      if (target || BrowserWindow.getFocusedWindow() || remembered) {
        sendCommand(command, target)
        return
      }
      if (options.noWindow) {
        void createWindowForCommand(command, options.noWindow)
      }
    },
  }
}

function updateViewMenuItems(
  state = (() => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused ? windowStates.get(focused.id) : undefined
  })()
): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const liveState =
    state && !state.win.isDestroyed() && !state.recoverySurfaceActive
      ? state
      : undefined
  const effectiveSettings = liveState
    ? settingsForWindow(liveState, settings)
    : settings
  const setChecked = (id: string, checked: boolean) => {
    const item = menu.getMenuItemById(id)
    if (item) item.checked = checked
  }
  const setEnabled = (id: string, enabled: boolean) => {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
  const activeTab = liveState ? tabStates.get(liveState.activeTabId) : undefined
  const softwareLicensesOpen =
    liveState?.editorMenuState.softwareLicensesOpen === true
  const settingsSurfaceOpen = Boolean(
    liveState?.editorMenuState.settingsDialogOpen ||
    liveState?.editorMenuState.settingsWorkspaceOpen
  )
  const settingsOwner = activeSettingsSessionOwner()
  const hasWindow = Boolean(state && !state.win.isDestroyed())
  const documentReady = Boolean(liveState?.editorReady && activeTab)
  const documentCommandsEnabled = documentReady && !settingsSurfaceOpen
  const markdownCommandsEnabled =
    documentCommandsEnabled && activeTab?.document.kind === "markdown"
  const openingCommandsEnabled =
    !hasWindow || Boolean(liveState && !settingsSurfaceOpen)

  setEnabled(FILE_NEW_TAB_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_NEW_SCRATCH_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_NEW_WINDOW_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_OPEN_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_OPEN_SCRATCH_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_OPEN_RECENT_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_WINDOW_PROFILES_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(FILE_WINDOW_PROFILE_PICKER_MENU_ITEM_ID, openingCommandsEnabled)
  setEnabled(
    FILE_WINDOW_PROFILE_UPDATE_MENU_ITEM_ID,
    documentCommandsEnabled && liveState?.profileId !== null
  )
  setEnabled(FILE_WINDOW_PROFILE_CREATE_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(
    REOPEN_CLOSED_DOCUMENT_MENU_ITEM_ID,
    openingCommandsEnabled && closedDocumentHistory.length > 0
  )
  setEnabled(
    FILE_SAVE_MENU_ITEM_ID,
    documentCommandsEnabled && activeTab?.dirty === true
  )
  setEnabled(FILE_SAVE_AS_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(
    FILE_SAVE_AS_SCRATCH_MENU_ITEM_ID,
    documentCommandsEnabled && activeTab?.backing === "untitled"
  )
  setEnabled(FILE_CLOSE_TAB_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(FILE_CLOSE_WINDOW_MENU_ITEM_ID, hasWindow)
  setEnabled(
    EDIT_UNDO_MENU_ITEM_ID,
    hasWindow && liveState?.editorMenuState.canUndo === true
  )
  setEnabled(
    EDIT_REDO_MENU_ITEM_ID,
    hasWindow && liveState?.editorMenuState.canRedo === true
  )
  setEnabled(EDIT_SELECT_ALL_MENU_ITEM_ID, documentReady)
  setEnabled(EDIT_FIND_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(
    EDIT_USE_SELECTION_FOR_FIND_MENU_ITEM_ID,
    documentCommandsEnabled && liveState?.editorMenuState.hasSelection === true
  )
  setEnabled(
    FORMAT_MENU_ITEM_ID,
    markdownCommandsEnabled && liveState?.editorMenuState.editorFocused === true
  )
  setEnabled(
    SETTINGS_MENU_ITEM_ID,
    !hasWindow || Boolean(liveState && !settingsSurfaceOpen)
  )
  setEnabled(
    HELP_SHORTCUTS_MENU_ITEM_ID,
    !softwareLicensesOpen &&
      (!settingsOwner ||
        settingsOwner.editorMenuState.settingsWorkspaceOpen !== true) &&
      (!hasWindow ||
        Boolean(
          liveState && liveState.editorMenuState.settingsWorkspaceOpen !== true
        ))
  )
  setEnabled(
    HELP_SOFTWARE_LICENSES_MENU_ITEM_ID,
    !hasWindow || Boolean(liveState && !settingsSurfaceOpen)
  )
  setEnabled(VIEW_MODE_MENU_ITEM_ID, markdownCommandsEnabled)
  setEnabled(VIEW_OUTLINE_MENU_ITEM_ID, markdownCommandsEnabled)
  setEnabled(VIEW_TEXT_WRAPPING_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(VIEW_FORMATTING_BAR_MENU_ITEM_ID, markdownCommandsEnabled)
  setEnabled(VIEW_STATUS_BAR_MENU_ITEM_ID, documentCommandsEnabled)
  setEnabled(VIEW_TABS_MENU_ITEM_ID, documentCommandsEnabled)
  const currentZoomFactor = liveState?.win.webContents.getZoomFactor()
  const zoomEnabled =
    currentZoomFactor !== undefined &&
    liveState?.editorMenuState.settingsWorkspaceOpen !== true &&
    !softwareLicensesOpen
  setEnabled(
    ZOOM_RESET_MENU_ITEM_ID,
    zoomEnabled && !zoomFactorsMatch(currentZoomFactor, 1)
  )
  setEnabled(
    ZOOM_IN_MENU_ITEM_ID,
    zoomEnabled && currentZoomFactor < MAX_ZOOM_FACTOR
  )
  setEnabled(
    `${ZOOM_IN_MENU_ITEM_ID}-equal`,
    zoomEnabled && currentZoomFactor < MAX_ZOOM_FACTOR
  )
  setEnabled(
    ZOOM_OUT_MENU_ITEM_ID,
    zoomEnabled && currentZoomFactor > MIN_ZOOM_FACTOR
  )

  const modeItem = menu.getMenuItemById(VIEW_MODE_MENU_ITEM_ID)
  if (modeItem) {
    modeItem.label =
      liveState?.editorMenuState.mode === "source"
        ? "Show Rendered Markdown"
        : "Show Raw Markdown"
  }

  setChecked(VIEW_TEXT_WRAPPING_MENU_ITEM_ID, liveState?.lineWrapping ?? true)
  setChecked(
    VIEW_FORMATTING_BAR_MENU_ITEM_ID,
    effectiveSettings.chrome.showFormattingBar
  )
  setChecked(
    VIEW_STATUS_BAR_MENU_ITEM_ID,
    effectiveSettings.chrome.alwaysShowStatusBar
  )
  for (const tabVisibility of TAB_VISIBILITY_MODES) {
    setChecked(
      VIEW_TAB_VISIBILITY_MENU_ITEM_IDS[tabVisibility],
      effectiveSettings.chrome.tabVisibility === tabVisibility
    )
  }
}

function zoomStepMenuItem(
  id: string,
  label: string,
  accelerator: string,
  direction: -1 | 1
): MenuItemConstructorOptions {
  return {
    id,
    label,
    accelerator,
    click: (_item, win) => {
      const target = win
        ? BrowserWindow.fromId(win.id)
        : BrowserWindow.getFocusedWindow()
      if (target) adjustWindowZoomByStep(target, direction)
    },
  }
}

async function showAppMessage(
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  const win = BrowserWindow.getFocusedWindow()
  return win
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options)
}

async function installCliHelper(): Promise<void> {
  if (!app.isPackaged) {
    await showAppMessage({
      type: "info",
      title: "Development Command",
      message: "Use npm run cli:dev -- … from the source checkout.",
      detail: "Development commands are deliberately not installed globally.",
      buttons: ["OK"],
    })
    return
  }
  const commandName = distributionIdentity.cliCommandName
  if (process.platform === "win32") {
    await showAppMessage({
      type: "info",
      title: "Command Line Tool",
      message: `The Windows installer adds ${commandName} to PATH.`,
      detail: "Open a new terminal after installation to use it.",
      buttons: ["OK"],
    })
    return
  }

  const source = path.join(process.resourcesPath, "bin", commandName)
  const target =
    process.platform === "darwin"
      ? path.join("/usr/local/bin", commandName)
      : path.join(app.getPath("home"), ".local", "bin", commandName)
  let existingTarget: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    existingTarget = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const appImagePath =
    process.platform === "linux" ? process.env.APPIMAGE : undefined
  if (appImagePath) {
    if (
      !path.isAbsolute(appImagePath) ||
      !(await stat(appImagePath)).isFile()
    ) {
      throw new Error("APPIMAGE does not identify the running AppImage file")
    }
    const wrapperMarker = `# ${PRODUCT_NAME} ${commandName} AppImage launcher`
    let replaceTarget = existingTarget === null
    if (existingTarget?.isFile()) {
      const existingSource = await readFile(target, "utf8").catch(() => "")
      replaceTarget = existingSource.includes(wrapperMarker)
      if (!replaceTarget) {
        await showAppMessage({
          type: "error",
          title: "Cannot Install Command",
          message: `${target} already exists and belongs to another program.`,
          detail: "Move or remove that file yourself, then try again.",
          buttons: ["OK"],
        })
        return
      }
    } else if (existingTarget?.isSymbolicLink()) {
      const currentTarget = await readlink(target)
      const ownedMountedLink =
        path.resolve(path.dirname(target), currentTarget) === source
      if (!ownedMountedLink) {
        const { response } = await showAppMessage({
          type: "warning",
          title: "Replace Existing Command?",
          message: `${target} points somewhere else.`,
          detail: "Replace it with this AppImage's command-line launcher?",
          buttons: ["Replace", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (response !== 0) return
      }
      replaceTarget = true
    } else if (existingTarget) {
      await showAppMessage({
        type: "error",
        title: "Cannot Install Command",
        message: `${target} already exists and is not a replaceable launcher.`,
        detail: "Move or remove that path yourself, then try again.",
        buttons: ["OK"],
      })
      return
    }

    if (replaceTarget) {
      const helperTarget = path.join(
        app.getPath("home"),
        ".local",
        "lib",
        distributionIdentity.cliIdentity,
        `${commandName}-helper`
      )
      const shellQuote = (value: string) =>
        `'${value.replaceAll("'", "'\\''")}'`
      await mkdir(path.dirname(helperTarget), { mode: 0o755, recursive: true })
      await mkdir(path.dirname(target), { mode: 0o755, recursive: true })
      await atomicWrite(helperTarget, await readFile(source))
      await chmod(helperTarget, 0o755)
      await atomicWrite(
        target,
        [
          "#!/bin/sh",
          wrapperMarker,
          `PMD_APP_EXECUTABLE=${shellQuote(appImagePath)} exec ${shellQuote(helperTarget)} "$@"`,
          "",
        ].join("\n")
      )
      await chmod(target, 0o755)
    }

    await showAppMessage({
      type: "info",
      title: "Command Installed",
      message: `Installed ${commandName} at ${target}.`,
      detail:
        "The launcher is tied to this AppImage path. Ensure ~/.local/bin is in PATH and reinstall the command if the AppImage is moved.",
      buttons: ["OK"],
    })
    return
  }
  if (existingTarget && !existingTarget.isSymbolicLink()) {
    await showAppMessage({
      type: "error",
      title: "Cannot Install Command",
      message: `${target} already exists and is not a symbolic link.`,
      detail: "Move or remove that file yourself, then try again.",
      buttons: ["OK"],
    })
    return
  }
  if (existingTarget) {
    const currentTarget = await readlink(target)
    if (path.resolve(path.dirname(target), currentTarget) === source) {
      await showAppMessage({
        type: "info",
        title: "Command Already Installed",
        message: `${commandName} is already available at ${target}.`,
        buttons: ["OK"],
      })
      return
    }
    const { response } = await showAppMessage({
      type: "warning",
      title: "Replace Existing Command?",
      message: `${target} points somewhere else.`,
      detail: `Replace its symbolic link with the command from ${source}?`,
      buttons: ["Replace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return
  }

  try {
    await mkdir(path.dirname(target), { mode: 0o755, recursive: true })
    if (existingTarget) await unlink(target)
    await symlink(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      process.platform !== "darwin" ||
      (code !== "EACCES" && code !== "EPERM")
    ) {
      throw error
    }
    const script = [
      "on run argv",
      "set sourcePath to item 1 of argv",
      "set targetPath to item 2 of argv",
      "set targetDirectory to item 3 of argv",
      'set commandText to "/bin/mkdir -p " & quoted form of targetDirectory & " && if [ ! -e " & quoted form of targetPath & " ] || [ -L " & quoted form of targetPath & " ]; then /bin/ln -sfn " & quoted form of sourcePath & " " & quoted form of targetPath & "; else exit 73; fi"',
      "do shell script commandText with administrator privileges",
      "end run",
    ].join("\n")
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      script,
      source,
      target,
      path.dirname(target),
    ])
  }

  await showAppMessage({
    type: "info",
    title: "Command Installed",
    message: `Installed ${commandName} at ${target}.`,
    detail:
      process.platform === "darwin"
        ? `Open a new terminal, then run ${commandName} --help.`
        : `Ensure ~/.local/bin is in PATH, open a new terminal, then run ${commandName} --help.`,
    buttons: ["OK"],
  })
}

function beginInstallCliHelper(): void {
  void installCliHelper().catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error)
    await showAppMessage({
      type: "error",
      title: "Command Installation Failed",
      message: `The ${distributionIdentity.cliCommandName} command could not be installed.`,
      detail,
      buttons: ["OK"],
    })
  })
}

function recentDocumentMenuLabel(filePath: string): string {
  const label = path.basename(filePath)
  return process.platform === "win32" ? label.replaceAll("&", "&&") : label
}

function recentDocumentMenuItems(): MenuItemConstructorOptions[] {
  const entries: MenuItemConstructorOptions[] =
    recentDocuments.length === 0
      ? [{ enabled: false, label: "No Recent Documents" }]
      : recentDocuments.map((filePath, index) => ({
          id: `${FILE_OPEN_RECENT_MENU_ITEM_ID}-${index}`,
          label: recentDocumentMenuLabel(filePath),
          toolTip: filePath,
          click: (_item, win) =>
            void openRecentDocumentFromMenu(
              filePath,
              win ? BrowserWindow.fromId(win.id) : null
            ),
        }))

  entries.push(
    { type: "separator" },
    {
      enabled: recentDocuments.length > 0,
      label: "Clear Menu",
      click: clearRecentDocumentHistory,
    }
  )
  return entries
}

function scheduleRecentDocumentsMenuRefresh(): void {
  if (
    recentDocumentsMenuRefresh !== null ||
    !applicationInitialized ||
    allowApplicationQuit
  ) {
    return
  }
  recentDocumentsMenuRefresh = setImmediate(() => {
    recentDocumentsMenuRefresh = null
    if (!applicationInitialized || allowApplicationQuit) return
    Menu.setApplicationMenu(createApplicationMenu())
    updateViewMenuItems()
  })
}

function createApplicationMenu(): Menu {
  const keepReadyAfterCommandQuit = shouldKeepReadyAfterCommandQuit(
    process.platform,
    settings.keepReadyInBackground
  )
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        id: FILE_NEW_WINDOW_MENU_ITEM_ID,
        label: "New Window",
        accelerator: "CmdOrCtrl+N",
        click: () =>
          void routeLaunchIntent({ kind: "new-window", filePaths: [] }),
      },
      commandMenuItem("New Tab", "new-tab", "CmdOrCtrl+T", {
        id: FILE_NEW_TAB_MENU_ITEM_ID,
        noWindow: "create",
      }),
      commandMenuItem("New Scratch", "new-scratch", undefined, {
        id: FILE_NEW_SCRATCH_MENU_ITEM_ID,
        noWindow: "create-and-send",
      }),
      {
        id: REOPEN_CLOSED_DOCUMENT_MENU_ITEM_ID,
        label: "Reopen Closed Document",
        accelerator: "CmdOrCtrl+Shift+T",
        enabled: closedDocumentHistory.length > 0,
        click: reopenClosedDocument,
      },
      commandMenuItem("Open…", "open", "CmdOrCtrl+O", {
        id: FILE_OPEN_MENU_ITEM_ID,
        noWindow: "create-and-send",
      }),
      commandMenuItem("Open Scratch…", "open-scratch-picker", "CmdOrCtrl+P", {
        id: FILE_OPEN_SCRATCH_MENU_ITEM_ID,
        noWindow: "create-and-send",
      }),
      {
        id: FILE_OPEN_RECENT_MENU_ITEM_ID,
        label: "Open Recent",
        submenu: recentDocumentMenuItems(),
      },
      {
        id: FILE_WINDOW_PROFILES_MENU_ITEM_ID,
        label: "Window Profiles",
        submenu: [
          commandMenuItem(
            "Launch Profile…",
            "open-window-profile-picker",
            undefined,
            {
              id: FILE_WINDOW_PROFILE_PICKER_MENU_ITEM_ID,
              noWindow: "create-and-send",
            }
          ),
          { type: "separator" },
          commandMenuItem(
            "Update Current Profile from Tabs…",
            "update-current-window-profile",
            undefined,
            { id: FILE_WINDOW_PROFILE_UPDATE_MENU_ITEM_ID }
          ),
          commandMenuItem(
            "Create New Profile from Tabs…",
            "create-window-profile-from-tabs",
            undefined,
            { id: FILE_WINDOW_PROFILE_CREATE_MENU_ITEM_ID }
          ),
        ],
      },
      { type: "separator" },
      commandMenuItem("Save", "save", "CmdOrCtrl+S", {
        id: FILE_SAVE_MENU_ITEM_ID,
      }),
      commandMenuItem("Save As…", "save-as", "CmdOrCtrl+Shift+S", {
        id: FILE_SAVE_AS_MENU_ITEM_ID,
      }),
      commandMenuItem("Save as Scratch", "save-as-scratch", undefined, {
        id: FILE_SAVE_AS_SCRATCH_MENU_ITEM_ID,
      }),
      { type: "separator" },
      commandMenuItem("Close Tab", "close-tab", "CmdOrCtrl+W", {
        id: FILE_CLOSE_TAB_MENU_ITEM_ID,
      }),
      {
        id: FILE_CLOSE_WINDOW_MENU_ITEM_ID,
        label: "Close Window",
        accelerator: "CmdOrCtrl+Shift+W",
        click: (_item, win) => {
          const target =
            (win ? BrowserWindow.fromId(win.id) : null) ??
            BrowserWindow.getFocusedWindow() ??
            lastUsableCommandWindow()
          target?.close()
        },
      },
      ...(process.platform === "darwin" || !app.isPackaged
        ? []
        : ([
            { type: "separator" },
            {
              label: "Install Command Line Tool…",
              click: beginInstallCliHelper,
            },
            { type: "separator" },
            { label: "Quit", role: "quit" },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  }

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      commandMenuItem("Undo", "undo", "CmdOrCtrl+Z", {
        id: EDIT_UNDO_MENU_ITEM_ID,
      }),
      commandMenuItem(
        "Redo",
        "redo",
        process.platform === "darwin" ? "Cmd+Shift+Z" : "Ctrl+Y",
        { id: EDIT_REDO_MENU_ITEM_ID }
      ),
      { type: "separator" },
      { label: "Cut", role: "cut" },
      { label: "Copy", role: "copy" },
      { label: "Paste", role: "paste" },
      {
        id: EDIT_PASTE_PLAIN_MENU_ITEM_ID,
        label:
          process.platform === "darwin"
            ? "Paste and Match Style"
            : "Paste as Plain Text",
        role: "pasteAndMatchStyle",
        accelerator:
          process.platform === "darwin" ? "Cmd+Alt+Shift+V" : undefined,
      },
      commandMenuItem("Select All", "select-all", "CmdOrCtrl+A", {
        id: EDIT_SELECT_ALL_MENU_ITEM_ID,
      }),
      { type: "separator" },
      {
        id: EDIT_FIND_MENU_ITEM_ID,
        label: "Find",
        submenu: [
          commandMenuItem("Find…", "find", "CmdOrCtrl+F"),
          commandMenuItem(
            "Find Next",
            "find-next",
            process.platform === "darwin" ? "Cmd+G" : "F3"
          ),
          commandMenuItem(
            "Find Previous",
            "find-previous",
            process.platform === "darwin" ? "Cmd+Shift+G" : "Shift+F3"
          ),
          commandMenuItem(
            "Use Selection for Find",
            "use-selection-for-find",
            process.platform === "darwin" ? "Cmd+E" : undefined,
            { id: EDIT_USE_SELECTION_FOR_FIND_MENU_ITEM_ID }
          ),
          commandMenuItem(
            "Find and Replace…",
            "replace",
            process.platform === "darwin" ? "Cmd+Alt+F" : "CmdOrCtrl+H"
          ),
        ],
      },
      ...(process.platform === "darwin"
        ? []
        : ([
            { type: "separator" },
            commandMenuItem("Settings…", "settings", "CmdOrCtrl+,", {
              id: SETTINGS_MENU_ITEM_ID,
              noWindow: "create-and-send",
            }),
          ] satisfies MenuItemConstructorOptions[])),
    ],
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        id: ZOOM_RESET_MENU_ITEM_ID,
        role: "resetZoom",
        accelerator: process.platform === "darwin" ? "Cmd+0" : "Ctrl+Shift+0",
      },
      zoomStepMenuItem(ZOOM_IN_MENU_ITEM_ID, "Zoom In", "CmdOrCtrl+Plus", 1),
      {
        ...zoomStepMenuItem(
          `${ZOOM_IN_MENU_ITEM_ID}-equal`,
          "Zoom In",
          "CmdOrCtrl+=",
          1
        ),
        visible: false,
      },
      zoomStepMenuItem(ZOOM_OUT_MENU_ITEM_ID, "Zoom Out", "CmdOrCtrl+-", -1),
      { type: "separator" },
      commandMenuItem("Show Raw Markdown", "toggle-mode", "CmdOrCtrl+Shift+V", {
        id: VIEW_MODE_MENU_ITEM_ID,
      }),
      commandMenuItem("Outline", "open-outline", "CmdOrCtrl+Shift+O", {
        id: VIEW_OUTLINE_MENU_ITEM_ID,
      }),
      {
        ...commandMenuItem("Text Wrapping", "toggle-wrap", "Alt+Z"),
        id: VIEW_TEXT_WRAPPING_MENU_ITEM_ID,
        type: "checkbox",
        checked: true,
      },
      {
        ...commandMenuItem(
          "Formatting Toolbar",
          "toggle-formatting-bar",
          "CmdOrCtrl+Shift+B"
        ),
        id: VIEW_FORMATTING_BAR_MENU_ITEM_ID,
        type: "checkbox",
        checked: settings.chrome.showFormattingBar,
      },
      {
        ...commandMenuItem("Status Bar", "toggle-status-bar"),
        id: VIEW_STATUS_BAR_MENU_ITEM_ID,
        type: "checkbox",
        checked: settings.chrome.alwaysShowStatusBar,
      },
      {
        id: VIEW_TABS_MENU_ITEM_ID,
        label: "Tabs",
        submenu: [
          {
            ...commandMenuItem("Always", "set-tab-visibility-always"),
            id: VIEW_TAB_VISIBILITY_MENU_ITEM_IDS.always,
            type: "radio",
            checked: settings.chrome.tabVisibility === "always",
          },
          {
            ...commandMenuItem(
              "With Multiple Tabs",
              "set-tab-visibility-multiple-tabs"
            ),
            id: VIEW_TAB_VISIBILITY_MENU_ITEM_IDS["multiple-tabs"],
            type: "radio",
            checked: settings.chrome.tabVisibility === "multiple-tabs",
          },
          {
            ...commandMenuItem("On Mouseover", "set-tab-visibility-mouseover"),
            id: VIEW_TAB_VISIBILITY_MENU_ITEM_IDS.mouseover,
            type: "radio",
            checked: settings.chrome.tabVisibility === "mouseover",
          },
          {
            ...commandMenuItem(
              "With Formatting Toolbar",
              "set-tab-visibility-formatting-bar"
            ),
            id: VIEW_TAB_VISIBILITY_MENU_ITEM_IDS["formatting-bar"],
            type: "radio",
            checked: settings.chrome.tabVisibility === "formatting-bar",
          },
          {
            ...commandMenuItem("Hidden", "set-tab-visibility-hidden"),
            id: VIEW_TAB_VISIBILITY_MENU_ITEM_IDS.hidden,
            type: "radio",
            checked: settings.chrome.tabVisibility === "hidden",
          },
        ],
      },
    ],
  }

  const formatMenu: MenuItemConstructorOptions = {
    id: FORMAT_MENU_ITEM_ID,
    label: "Format",
    submenu: [
      commandMenuItem("Bold", "format-bold", "CmdOrCtrl+B"),
      commandMenuItem("Italic", "format-italic", "CmdOrCtrl+I"),
      commandMenuItem("Strikethrough", "format-strikethrough"),
      commandMenuItem("Inline Code", "format-inline-code"),
      { type: "separator" },
      commandMenuItem("Link", "format-link"),
      commandMenuItem("Image", "format-image"),
      { type: "separator" },
      {
        label: "Heading",
        submenu: [
          commandMenuItem("Paragraph", "format-heading-0"),
          { type: "separator" },
          ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
            commandMenuItem(`Heading ${level}`, `format-heading-${level}`)
          ),
        ],
      },
      {
        label: "List",
        submenu: [
          commandMenuItem("Bulleted List", "format-bullet-list"),
          commandMenuItem("Numbered List", "format-ordered-list"),
          commandMenuItem("Task List", "format-task-list"),
        ],
      },
      commandMenuItem("Block Quote", "format-blockquote"),
      commandMenuItem("Code Block", "format-code-block"),
      { type: "separator" },
      commandMenuItem("Horizontal Rule", "format-horizontal-rule"),
      commandMenuItem("Insert 2 × 2 Table", "format-table"),
    ],
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    role: "windowMenu",
    submenu: [
      {
        label: "Minimize",
        role: "minimize",
        accelerator: minimizeWindowAccelerator(process.platform),
      },
      ...(process.platform === "darwin"
        ? ([
            { type: "separator" },
            { label: "Bring All to Front", role: "front" },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    fileMenu,
    editMenu,
    formatMenu,
    viewMenu,
    windowMenu,
    {
      label: "Help",
      role: "help",
      submenu: [
        commandMenuItem("Keyboard Shortcuts", "keyboard-shortcuts", undefined, {
          id: HELP_SHORTCUTS_MENU_ITEM_ID,
          noWindow: "create-and-send",
        }),
        commandMenuItem("Software Licenses…", "software-licenses", undefined, {
          id: HELP_SOFTWARE_LICENSES_MENU_ITEM_ID,
          noWindow: "create-and-send",
        }),
        {
          label: "Project Website",
          click: () => {
            void shell.openExternal(PROJECT_WEBSITE).catch((error: unknown) => {
              console.error("Unable to open the project website", error)
            })
          },
        },
        ...(process.platform === "darwin"
          ? []
          : ([
              { type: "separator" },
              { label: `About ${PRODUCT_NAME}`, role: "about" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ]

  if (process.platform === "darwin") {
    template.unshift({
      label: PRODUCT_NAME,
      submenu: [
        { label: `About ${PRODUCT_NAME}`, role: "about" },
        { type: "separator" },
        commandMenuItem("Settings…", "settings", "CmdOrCtrl+,", {
          id: SETTINGS_MENU_ITEM_ID,
          noWindow: "create-and-send",
        }),
        { type: "separator" },
        ...(app.isPackaged
          ? ([
              {
                label: "Install Command Line Tool…",
                click: beginInstallCliHelper,
              },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        ...(keepReadyAfterCommandQuit
          ? ([
              {
                id: APP_CLOSE_KEEP_READY_MENU_ITEM_ID,
                label: "Close & Keep Ready",
                accelerator: "Cmd+Q",
                click: () => void beginKeepReadyClose(),
              },
              {
                id: APP_QUIT_COMPLETELY_MENU_ITEM_ID,
                label: `Quit ${PRODUCT_NAME} Completely`,
                accelerator: "Alt+Cmd+Q",
                click: () => void beginApplicationQuit(),
              },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              {
                id: APP_QUIT_COMPLETELY_MENU_ITEM_ID,
                label: `Quit ${PRODUCT_NAME}`,
                accelerator: "Cmd+Q",
                click: () => void beginApplicationQuit(),
              },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    })
  }

  const menu = Menu.buildFromTemplate(template)
  for (const label of ["File", "Edit", "Format", "View", "Help"]) {
    menu.items
      .find((item) => item.label === label)
      ?.submenu?.on("menu-will-show", () => updateViewMenuItems())
  }
  return menu
}

function windowsMenuDisplayLabel(label: string): string {
  const escapedAmpersand = "\u0000"
  return label
    .replaceAll("&&", escapedAmpersand)
    .replaceAll("&", "")
    .replaceAll(escapedAmpersand, "&")
}

function windowsMenuItemSnapshot(
  state: WindowState,
  item: MenuItem
): WindowsMenuItemSnapshot | null {
  if (!item.visible) return null

  if (item.type === "separator") {
    return {
      accelerator: null,
      actionToken: null,
      checked: false,
      enabled: false,
      label: "",
      submenu: [],
      type: "separator",
    }
  }

  const submenu = (item.submenu?.items ?? [])
    .map((child) => windowsMenuItemSnapshot(state, child))
    .filter((child): child is WindowsMenuItemSnapshot => child !== null)
  const type = item.submenu
    ? "submenu"
    : item.type === "checkbox" || item.type === "radio"
      ? item.type
      : "normal"
  const actionable =
    item.enabled &&
    (type === "normal" || type === "checkbox" || type === "radio")
  const actionToken = actionable ? randomUUID() : null
  if (actionToken) state.windowsMenuActions.set(actionToken, item)

  return {
    accelerator: item.accelerator,
    actionToken,
    checked: item.checked,
    enabled: item.enabled,
    label: windowsMenuDisplayLabel(item.label),
    submenu,
    type,
  }
}

function windowsMenuSnapshot(state: WindowState): WindowsMenuSnapshot {
  updateViewMenuItems(state)
  state.windowsMenuActions.clear()
  const applicationMenu = Menu.getApplicationMenu()
  if (!applicationMenu) throw new Error("The application menu is unavailable")

  return Object.fromEntries(
    WINDOWS_MENU_IDS.map((menu) => {
      const topLevelItem = applicationMenu.items.find(
        (item) => item.label === WINDOWS_MENU_LABELS[menu]
      )
      const items = (topLevelItem?.submenu?.items ?? [])
        .map((item) => windowsMenuItemSnapshot(state, item))
        .filter((item): item is WindowsMenuItemSnapshot => item !== null)
      return [
        menu,
        {
          enabled: Boolean(
            topLevelItem?.enabled && topLevelItem.visible && items.length > 0
          ),
          items,
        },
      ]
    })
  ) as unknown as WindowsMenuSnapshot
}

function activateWindowsMenuItem(
  state: WindowState,
  actionToken: string
): void {
  const item = state.windowsMenuActions.get(actionToken)
  // A snapshot is one menu session. Invalidating every token before invoking
  // the command prevents a stale renderer surface from replaying an action.
  state.windowsMenuActions.clear()
  if (!item || item.type === "separator" || item.submenu) {
    throw new Error("The Windows menu action is unavailable")
  }
  item.click({}, state.win, state.win.webContents)
}

async function initialDocumentForWindow(
  win: BrowserWindow,
  filePath?: string,
  interactive = true,
  allowEmptyFallback = true
): Promise<{
  contentHash: string | null
  document: DocumentSnapshot
  fingerprint: FileFingerprint | null
  ioPath: string | null
} | null> {
  if (!filePath) {
    return {
      contentHash: null,
      document: createEmptyDocument(),
      fingerprint: null,
      ioPath: null,
    }
  }
  try {
    const prepared = await preparedFileTab(filePath)
    return {
      contentHash: prepared.contentHash,
      document: prepared.document,
      fingerprint: prepared.diskFingerprint,
      ioPath: prepared.ioPath,
    }
  } catch (error) {
    if (interactive) {
      await showOperationError(
        win,
        "Open Failed",
        `Could not open ${path.basename(filePath)}.`,
        error
      )
    } else {
      console.warn(
        `Unable to hydrate inactive document ${path.basename(filePath)}`,
        error
      )
    }
    if (!allowEmptyFallback) {
      return null
    }
    return {
      contentHash: null,
      document: createEmptyDocument(),
      fingerprint: null,
      ioPath: null,
    }
  }
}

async function refreshPreparedFileForHydration(
  win: BrowserWindow,
  state: WindowState,
  tab: TabState,
  interactive: boolean,
  allowEmptyFallback: boolean
): Promise<boolean> {
  if (tab.backing !== "file" || !tab.ioPath) return true

  try {
    const currentStats = await stat(tab.ioPath)
    if (
      currentStats.isFile() &&
      fileFingerprintsMatch(tab.diskFingerprint, fileFingerprint(currentStats))
    ) {
      return true
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      tab.diskFingerprint === null
    ) {
      return true
    }
  }

  const loaded = await initialDocumentForWindow(
    win,
    tab.document.filePath ?? tab.ioPath,
    interactive,
    allowEmptyFallback
  )
  if (!loaded || !tabCanHydrateInState(state, tab)) return false
  tab.backing = loaded.document.filePath ? "file" : "untitled"
  tab.document = loaded.document
  tab.diskContentHash = loaded.contentHash
  tab.diskFingerprint = loaded.fingerprint
  tab.fileMissing =
    tab.backing === "file" &&
    loaded.ioPath !== null &&
    loaded.fingerprint === null
  tab.ioPath = loaded.ioPath
  return true
}

function registerPreparedTabHydration(
  state: WindowState,
  win: BrowserWindow,
  tab: TabState,
  prepared: PreparedTab,
  options: { recordRecentDocument?: boolean } = {}
): void {
  let deferredLoaded = prepared.deferredLoad === undefined
  registerTabHydration(
    state,
    tab.id,
    async (interactive, allowEmptyFallback) => {
      if (!deferredLoaded && prepared.deferredLoad) {
        let loaded: PreparedTab
        try {
          loaded = await prepared.deferredLoad()
        } catch (error) {
          if (interactive && !win.isDestroyed()) {
            await showOperationError(
              win,
              "Open Failed",
              `Could not open ${tab.title ?? tab.document.displayName}.`,
              error
            )
          } else {
            console.warn(
              `Unable to hydrate inactive profile tab ${tab.title ?? tab.document.displayName}`,
              error
            )
          }
          return null
        }
        if (!tabCanHydrateInState(state, tab)) return null
        applyRecoveredPreparedTab(tab, loaded)
        deferredLoaded = true
      } else if (
        !(await refreshPreparedFileForHydration(
          win,
          state,
          tab,
          interactive,
          allowEmptyFallback
        ))
      ) {
        return null
      }

      return bootstrapTab(tab, undefined, {
        ...(prepared.baselineContent !== undefined
          ? { baselineContent: prepared.baselineContent }
          : {}),
        ...(prepared.initialCursor
          ? { initialCursor: prepared.initialCursor }
          : {}),
        ...(prepared.initialEditorMode
          ? { initialEditorMode: prepared.initialEditorMode }
          : {}),
      })
    },
    {
      ...options,
      ...(prepared.initialEditorMode
        ? { initialEditorMode: prepared.initialEditorMode }
        : {}),
    }
  )
}

function installWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.webContents.on("will-redirect", (event) => event.preventDefault())
}

async function promptForTabClose(
  win: BrowserWindow,
  tab: TabState
): Promise<CloseDecision> {
  if (!tab.dirty) return "close"
  if (tab.backing === "ephemeral") return "close"
  if (tab.backing === "scratch") return "save"
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Unsaved Changes",
    message: `Save changes to ${tab.title ?? tab.document.displayName} before closing?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) return "save"
  if (response === 1) return "close"
  return "cancel"
}

async function promptForCurrentTabNavigation(
  win: BrowserWindow,
  tab: TabState
): Promise<CloseDecision> {
  if (!tab.dirty) return "close"
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Unsaved Changes",
    message: `Save changes to ${tab.title ?? tab.document.displayName} before following this link?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) return "save"
  if (response === 1) return "close"
  return "cancel"
}

function restoreActiveTab(state: WindowState, tabId: TabId): void {
  if (!state.tabIds.includes(tabId)) return
  state.activeTabId = tabId
  updateWindowNativeDocument(state)
  sendTabsChanged(state)
}

function finishPendingCloseSave(state: WindowState, allow: boolean): void {
  const pending = state.pendingCloseSave
  if (!pending) return
  state.pendingCloseSave = null
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.resolve(allow)
}

function suspendPendingCloseSaveTimeout(
  state: WindowState,
  tabId: TabId
): boolean {
  const pending = state.pendingCloseSave
  if (!pending || pending.tabId !== tabId) return false
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = null
  return true
}

function armPendingCloseSaveTimeout(state: WindowState, tabId: TabId): void {
  const pending = state.pendingCloseSave
  if (!pending || pending.tabId !== tabId) return
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = setTimeout(() => {
    if (state.pendingCloseSave === pending) finishPendingCloseSave(state, false)
  }, CLOSE_SAVE_ACKNOWLEDGEMENT_TIMEOUT_MS)
  pending.timeout.unref()
}

function finishPendingWindowClosePreparation(
  state: WindowState,
  allow: boolean
): void {
  const pending = state.pendingWindowClosePreparation
  if (!pending) return
  state.pendingWindowClosePreparation = null
  clearTimeout(pending.timeout)
  pending.resolve(allow)
}

function prepareWindowForClose(state: WindowState): Promise<boolean> {
  if (
    state.win.isDestroyed() ||
    state.win.webContents.isDestroyed() ||
    !state.editorReady
  ) {
    return Promise.resolve(true)
  }
  if (state.pendingWindowClosePreparation) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const pending: PendingWindowClosePreparation = {
      resolve,
      timeout: setTimeout(() => {
        if (state.pendingWindowClosePreparation === pending) {
          finishPendingWindowClosePreparation(state, false)
        }
      }, WINDOW_CLOSE_PREPARATION_TIMEOUT_MS),
    }
    pending.timeout.unref()
    state.pendingWindowClosePreparation = pending
    sendCommand("prepare-window-close", state.win)
  })
}

async function requestWindowClose(state: WindowState): Promise<boolean> {
  if (!(await prepareWindowForClose(state))) return false
  abortTransfersForWindow(state.win.id)
  await waitForTabMutation(state)
  if (state.win.isDestroyed()) return true
  if (state.recoverySurfaceActive) {
    const closed = new Promise<void>((resolve) => {
      state.win.once("closed", resolve)
    })
    state.allowClose = true
    state.win.close()
    if (!state.win.isDestroyed()) await closed
    return true
  }
  state.approvedTabCloses.clear()
  const originalActiveTabId = state.activeTabId
  const discardApprovals = new Set<TabId>()

  closeScan: while (true) {
    if (state.win.isDestroyed()) return true
    let tabToResolve: TabState | null = null

    for (const tabId of state.tabIds) {
      const tab = tabStates.get(tabId)
      if (!tab || tab.ownerWindowId !== state.win.id) continue
      if (tabSaveActive(tab)) {
        await waitForTabSaveIdle(tab)
        continue closeScan
      }
      if (tab.dirty && !discardApprovals.has(tab.id)) {
        tabToResolve = tab
        break
      }
    }

    if (!tabToResolve) break
    const tabId = tabToResolve.id
    state.activeTabId = tabId
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    const decision = await promptForTabClose(state.win, tabToResolve)
    if (state.win.isDestroyed()) return true
    const currentTab = tabStates.get(tabId)
    if (!currentTab || currentTab.ownerWindowId !== state.win.id) {
      continue
    }
    if (decision === "cancel") {
      restoreActiveTab(state, originalActiveTabId)
      return false
    }
    if (decision === "close") {
      discardApprovals.add(tabId)
      continue
    }
    if (decision === "save") {
      const saved = await new Promise<boolean>((resolve) => {
        state.pendingCloseSave = { tabId, resolve, timeout: null }
        armPendingCloseSaveTimeout(state, tabId)
        sendCommand("save-and-close", state.win)
      })
      if (!saved) {
        restoreActiveTab(state, originalActiveTabId)
        return false
      }
    }
  }

  if (!state.win.isDestroyed()) {
    const closed = new Promise<void>((resolve) => {
      state.win.once("closed", resolve)
    })
    state.allowClose = true
    state.win.close()
    if (!state.win.isDestroyed()) await closed
  }
  return true
}

function windowCanCloseWithoutInteraction(state: WindowState): boolean {
  return (
    !state.win.isDestroyed() &&
    state.closeSequence === null &&
    state.pendingCloseSave === null &&
    state.pendingWindowClosePreparation === null &&
    state.tabIds.every((tabId) => {
      const tab = tabStates.get(tabId)
      return (
        !tab ||
        (tab.ownerWindowId === state.win.id &&
          !tabSaveActive(tab) &&
          (!tab.dirty || tab.backing === "ephemeral"))
      )
    })
  )
}

async function closeWindowsTogether(states: readonly WindowState[]) {
  const liveStates = states.filter((state) => !state.win.isDestroyed())
  const closed = liveStates.map(
    (state) =>
      new Promise<void>((resolve) => {
        state.win.once("closed", resolve)
      })
  )
  for (const state of liveStates) state.allowClose = true
  for (const state of liveStates) state.win.close()
  await Promise.all(closed)
}

function beginWindowClose(state: WindowState): Promise<boolean> {
  if (state.closeSequence) return state.closeSequence
  const sequence = requestWindowClose(state).finally(() => {
    if (windowStates.get(state.win.id) === state) state.closeSequence = null
  })
  state.closeSequence = sequence
  return sequence
}

async function closeAllApplicationWindows(): Promise<boolean> {
  if (activationWindowRequest) {
    clearImmediate(activationWindowRequest)
    activationWindowRequest = null
  }
  const initialWindows = [...windowStates.values()]
  if (
    initialWindows.length > 0 &&
    initialWindows.every(windowCanCloseWithoutInteraction)
  ) {
    const prepared = await Promise.all(
      initialWindows.map(prepareWindowForClose)
    )
    if (!prepared.every(Boolean)) return false
    // Preparation can save Settings in another window and therefore remain
    // asynchronous long enough for an already-prepared document to receive a
    // new edit. Only retain the simultaneous AppKit close path if every
    // original window is still interaction-free after all acknowledgements.
    // Otherwise the ordinary close scan below must resolve the newly dirty
    // tab through its normal Save / Don't Save / Cancel decision.
    if (initialWindows.every(windowCanCloseWithoutInteraction)) {
      await closeWindowsTogether(initialWindows)
    }
  }

  while (true) {
    const liveStates = [...windowStates.values()].filter(
      (candidate) => !candidate.win.isDestroyed()
    )
    const state =
      liveStates.find((candidate) => !candidate.recoverySurfaceActive) ??
      liveStates[0]
    if (!state) return true
    if (!(await beginWindowClose(state))) return false
  }
}

async function finishApplicationQuit(relaunch: boolean): Promise<void> {
  for (const request of pendingCliRequests.splice(0)) {
    rejectCliRequestDuringQuit(request)
  }
  await closeIngressAndDrainOperations(
    () =>
      closeCliServerIngress().catch((error) => {
        console.error("Unable to close CLI ingress during quit", error)
      }),
    drainCliRequestOperations
  )
  await managedResourceOperationQueue.catch(() => undefined)
  await scratchStore.drainMutations().catch((error) => {
    console.error("Unable to drain scratch persistence during quit", error)
  })
  await Promise.all([
    settingsWriteQueue.catch(() => undefined),
    flushWindowSizePersistence(),
    flushRecentDocumentsPersistence(),
  ])
  allowApplicationQuit = true
  if (relaunch) app.relaunch()
  app.quit()
}

function releaseApplicationCloseQuiescence(quiescing: boolean): void {
  applicationPersistenceQuiescing = quiescing
  if (quiescing || allowApplicationQuit || !applicationInitialized) return

  for (const intent of pendingLaunchIntents.splice(0)) {
    void routeLaunchIntent(intent)
  }
  for (const request of pendingCliRequests.splice(0)) {
    enqueueCliRequest(request)
  }
  if (activationRequestedDuringApplicationClose) {
    activationRequestedDuringApplicationClose = false
    requestActivationWindow()
  }
}

async function requestApplicationQuit(relaunch = false): Promise<boolean> {
  return await runQuiescedOperation(
    releaseApplicationCloseQuiescence,
    async () => {
      if (!(await closeAllApplicationWindows())) return false
      await finishApplicationQuit(relaunch)
      return true
    },
    (completed) => completed && allowApplicationQuit
  )
}

async function requestKeepReadyClose(): Promise<boolean> {
  return await runQuiescedOperation(
    releaseApplicationCloseQuiescence,
    async () => {
      if (!(await closeAllApplicationWindows())) return false

      // A request accepted immediately before quiescence may already own a
      // dispatch turn. Let it either finish or transfer itself to the pending
      // queue before deciding whether the app can become windowless.
      await drainCliRequestOperations()
      if (BrowserWindow.getAllWindows().length > 0) {
        restoreForegroundActivationPolicy()
        return true
      }

      if (
        completeQuitRequestedDuringBackgroundClose ||
        !shouldKeepReadyAfterCommandQuit(
          process.platform,
          settings.keepReadyInBackground
        )
      ) {
        await finishApplicationQuit(relaunchRequestedDuringBackgroundClose)
        return true
      }

      app.hide()
      enterBackgroundActivationPolicy()
      return true
    },
    (completed) => completed && allowApplicationQuit
  )
}

function trackApplicationCloseSequence(
  kind: "background" | "quit",
  sequence: Promise<boolean>
): Promise<boolean> {
  applicationCloseSequenceKind = kind
  const tracked = sequence.finally(() => {
    if (applicationQuitSequence !== tracked) return
    applicationQuitSequence = null
    applicationCloseSequenceKind = null
    completeQuitRequestedDuringBackgroundClose = false
    relaunchRequestedDuringBackgroundClose = false
  })
  applicationQuitSequence = tracked
  return tracked
}

function beginKeepReadyClose(): Promise<boolean> {
  if (applicationQuitSequence) return applicationQuitSequence
  if (
    !shouldKeepReadyAfterCommandQuit(
      process.platform,
      settings.keepReadyInBackground
    )
  ) {
    return beginApplicationQuit()
  }
  return trackApplicationCloseSequence("background", requestKeepReadyClose())
}

function beginApplicationQuit(relaunch = false): Promise<boolean> {
  if (applicationQuitSequence) {
    if (applicationCloseSequenceKind === "background") {
      completeQuitRequestedDuringBackgroundClose = true
      relaunchRequestedDuringBackgroundClose ||= relaunch
    }
    return applicationQuitSequence
  }
  return trackApplicationCloseSequence("quit", requestApplicationQuit(relaunch))
}

function resolvedAppearance(mode: AppearanceMode): ResolvedAppearance {
  if (mode === "dark" || mode === "light") return mode
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function windowsNativeThemeSource(
  value: Pick<AppSettings, "appearanceMode" | "themeByScheme">
): "system" | ResolvedAppearance {
  if (value.appearanceMode === "system") return "system"
  return resolveAppearanceProfile(value.themeByScheme[value.appearanceMode])
    .surfaceScheme
}

function applyWindowsNativeThemeSource(
  value: Pick<AppSettings, "appearanceMode" | "themeByScheme">
): void {
  if (process.platform !== "win32") return
  const owner =
    settingsSessionOwnerWindowId === null
      ? null
      : windowStates.get(settingsSessionOwnerWindowId)
  const preview =
    owner &&
    !owner.win.isDestroyed() &&
    !owner.recoverySurfaceActive &&
    !owner.recoveryInProgress
      ? owner.appearancePreview
      : null
  // nativeTheme is process-wide. Keep the exclusive Settings owner's draft
  // authoritative across unrelated commits and additional window creation.
  const source = windowsNativeThemeSource(preview ?? value)
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
}

function windowBackgroundColor(value: AppearanceSettings): string {
  const profile = value.themeByScheme[resolvedAppearance(value.appearanceMode)]
  return resolveAppearanceProfile(profile).backgroundColor
}

function windowForegroundColor(value: AppearanceSettings): string {
  const profile = value.themeByScheme[resolvedAppearance(value.appearanceMode)]
  return resolveAppearanceProfile(profile).foregroundColor
}

function windowsTitleBarOverlaySignature(
  overlay: WindowsTitleBarOverlay
): string {
  return `${overlay.color}:${overlay.symbolColor}:${overlay.height}`
}

function windowsNativeBackgroundSupported(): boolean {
  return windowsWindowBlurSupported(process.platform, operatingSystemRelease())
}

function rendererBackgroundCapability(): NodeJS.Platform | "opaque" {
  if (process.platform === "win32" && !windowsNativeBackgroundSupported()) {
    return "opaque"
  }
  return process.platform
}

function nativeWindowBackgroundEffect(
  value: AppearanceSettings,
  blurRadius = value.backgroundEffect.blurRadius
): NativeWindowBackgroundEffect {
  const backgroundColor = windowBackgroundColor(value)
  return {
    backgroundColor,
    blurRadius,
    blue: Number.parseInt(backgroundColor.slice(5, 7), 16),
    green: Number.parseInt(backgroundColor.slice(3, 5), 16),
    opacity: Math.round((1 - value.backgroundEffect.translucency) * 255) / 255,
    red: Number.parseInt(backgroundColor.slice(1, 3), 16),
  }
}

function nativeWindowBackgroundEffectSignature(
  effect: NativeWindowBackgroundEffect
): string {
  return `${effect.blurRadius}:${effect.backgroundColor}:${effect.opacity}`
}

function nativeTranslucencyEnabled(value: AppearanceSettings): boolean {
  return (
    (process.platform === "darwin" || windowsNativeBackgroundSupported()) &&
    value.backgroundEffect.enabled &&
    value.backgroundEffect.translucency > 0 &&
    !nativeTheme.prefersReducedTransparency
  )
}

function windowCanReceiveVisualEffect(
  state: WindowState,
  revision?: number
): boolean {
  const { win } = state
  return (
    (revision === undefined || state.visualEffectRevision === revision) &&
    windowStates.get(win.id) === state &&
    BrowserWindow.fromId(win.id) === win &&
    !win.isDestroyed() &&
    !win.webContents.isDestroyed()
  )
}

function isDestroyedElectronObjectError(error: unknown): boolean {
  return error instanceof Error && error.message === "Object has been destroyed"
}

function setWindowBackgroundColor(
  state: WindowState,
  color: string,
  revision?: number
): boolean {
  if (!windowCanReceiveVisualEffect(state, revision)) return false
  try {
    if (process.platform === "win32") {
      const contentColor =
        color === "rgba(0, 0, 0, 0)"
          ? "#00000000"
          : /^#[\da-f]{6}$/i.test(color)
            ? `#ff${color.slice(1)}`
            : null
      if (contentColor === null) {
        throw new TypeError(`Unsupported Windows window background: ${color}`)
      }
      state.win.contentView.setBackgroundColor(contentColor)
    }
    state.win.setBackgroundColor(color)
    return true
  } catch (error) {
    // Native window teardown can finish between Electron's liveness query and
    // the method call. The visual-effect task is best-effort at that point;
    // only suppress the exact lifecycle error from the window we just checked.
    if (isDestroyedElectronObjectError(error)) {
      return false
    }
    throw error
  }
}

function updateWindowsTitleBarOverlay(
  win: BrowserWindow,
  value: AppearanceSettings,
  zoomFactor?: number
): void {
  if (
    process.platform !== "win32" ||
    win.isDestroyed() ||
    win.webContents.isDestroyed()
  ) {
    return
  }
  try {
    const resolvedZoomFactor = zoomFactor ?? win.webContents.getZoomFactor()
    const overlay = windowsTitleBarOverlay(
      windowForegroundColor(value),
      resolvedZoomFactor
    )
    const signature = windowsTitleBarOverlaySignature(overlay)
    const state = windowStates.get(win.id)
    if (state?.appliedWindowsTitleBarOverlaySignature === signature) return
    win.setTitleBarOverlay(overlay)
    if (state) state.appliedWindowsTitleBarOverlaySignature = signature
  } catch (error) {
    if (isDestroyedElectronObjectError(error)) return
    if (!windowsNativeChromeWarningShown) {
      windowsNativeChromeWarningShown = true
      console.warn("Unable to update Windows native window controls", error)
    }
  }
}

function cancelScheduledWindowVisualEffect(state: WindowState): void {
  if (state.pendingWindowVisualEffectTask === null) return
  clearImmediate(state.pendingWindowVisualEffectTask)
  state.pendingWindowVisualEffectTask = null
}

function retireWindowVisualEffects(state: WindowState): void {
  state.visualEffectRevision += 1
  state.pendingLaunchVisualEffect = null
  cancelScheduledWindowVisualEffect(state)
}

function macWindowBlurAddonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "macos-window-blur.node")
    : path.join(app.getAppPath(), "dist-native", "macos-window-blur.node")
}

function loadMacWindowBlurAddon(): MacWindowBlurAddon | null {
  if (process.platform !== "darwin") return null
  if (macWindowBlurAddon !== undefined) return macWindowBlurAddon

  if (launchVisualMode) {
    launchVisualBenchmarkAddonLoadStartedEpochMs = launchBenchmarkEpochMs()
  }

  try {
    const loaded = requireNativeModule(
      macWindowBlurAddonPath()
    ) as Partial<MacWindowBlurAddon>
    if (
      typeof loaded.setWindowBackgroundEffect !== "function" ||
      typeof loaded.animateWindowBackgroundBlur !== "function" ||
      typeof loaded.tabDragEscapeKeyPressed !== "function"
    ) {
      throw new TypeError("Native macOS module has an invalid API")
    }
    macWindowBlurAddon = loaded as MacWindowBlurAddon
  } catch (error) {
    macWindowBlurAddon = null
    if (!macWindowBlurWarningShown) {
      macWindowBlurWarningShown = true
      console.warn("Native macOS window support is unavailable", error)
    }
  } finally {
    if (launchVisualMode) {
      launchVisualBenchmarkAddonLoadReadyEpochMs = launchBenchmarkEpochMs()
    }
  }
  return macWindowBlurAddon
}

function windowsWindowBlurAddonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "windows-window-blur.node")
    : path.join(
        app.getAppPath(),
        "dist-native",
        "win32",
        "windows-window-blur.node"
      )
}

function loadWindowsWindowBlurAddon(): WindowsWindowBlurAddon | null {
  if (process.platform !== "win32") return null
  if (windowsWindowBlurAddon !== undefined) return windowsWindowBlurAddon

  if (launchVisualMode) {
    launchVisualBenchmarkAddonLoadStartedEpochMs = launchBenchmarkEpochMs()
  }

  try {
    const loaded = requireNativeModule(
      windowsWindowBlurAddonPath()
    ) as Partial<WindowsWindowBlurAddon>
    if (
      typeof loaded.setWindowBackgroundEffect !== "function" ||
      typeof loaded.animateWindowBackgroundBlur !== "function" ||
      typeof loaded.clearWindowBackgroundEffect !== "function"
    ) {
      throw new TypeError("Native Windows blur module has an invalid API")
    }
    windowsWindowBlurAddon = loaded as WindowsWindowBlurAddon
  } catch (error) {
    windowsWindowBlurAddon = null
    if (!windowsWindowBlurWarningShown) {
      windowsWindowBlurWarningShown = true
      console.warn("Native Windows window blur is unavailable", error)
    }
  } finally {
    if (launchVisualMode) {
      launchVisualBenchmarkAddonLoadReadyEpochMs = launchBenchmarkEpochMs()
    }
  }
  return windowsWindowBlurAddon
}

function setMacWindowBackgroundEffect(
  state: WindowState,
  effect: NativeWindowBackgroundEffect
): boolean {
  if (process.platform !== "darwin" || !windowCanReceiveVisualEffect(state)) {
    return false
  }
  if (
    effect.blurRadius === 0 &&
    effect.opacity === 0 &&
    macWindowBlurAddon === undefined
  ) {
    state.appliedBackgroundBlurRadius = 0
    state.appliedBackgroundEffectSignature =
      nativeWindowBackgroundEffectSignature(effect)
    return true
  }

  const addon = loadMacWindowBlurAddon()
  if (!addon) return false
  try {
    const applied = addon.setWindowBackgroundEffect(
      state.win.getNativeWindowHandle(),
      effect.blurRadius,
      effect.red,
      effect.green,
      effect.blue,
      effect.opacity
    )
    if (applied) {
      state.appliedBackgroundBlurAnimationActive = false
      state.appliedBackgroundBlurRadius = effect.blurRadius
      state.appliedBackgroundEffectSignature =
        nativeWindowBackgroundEffectSignature(effect)
    }
    return applied
  } catch (error) {
    if (!macWindowBlurWarningShown) {
      macWindowBlurWarningShown = true
      console.warn("Unable to update macOS background blur", error)
    }
    return false
  }
}

function clearMacWindowBackgroundEffect(
  state: WindowState,
  value: AppearanceSettings
): void {
  if (
    state.appliedBackgroundEffectSignature === null &&
    state.appliedBackgroundBlurRadius === 0
  ) {
    return
  }
  const cleared = setMacWindowBackgroundEffect(state, {
    ...nativeWindowBackgroundEffect(value, 0),
    opacity: 0,
  })
  if (cleared) state.appliedBackgroundEffectSignature = null
}

function animateMacWindowBackgroundBlur(
  state: WindowState,
  effect: NativeWindowBackgroundEffect,
  transition: LaunchTransitionSettings
): boolean {
  if (process.platform !== "darwin" || !windowCanReceiveVisualEffect(state)) {
    return false
  }
  const addon = loadMacWindowBlurAddon()
  if (!addon) return false
  const [x1, y1, x2, y2] = launchTransitionBezier(transition)
  try {
    const applied = addon.animateWindowBackgroundBlur(
      state.win.getNativeWindowHandle(),
      effect.blurRadius,
      transition.durationMs,
      transition.delayMs,
      x1,
      y1,
      x2,
      y2
    )
    if (applied) {
      state.appliedBackgroundBlurAnimationActive = true
      state.appliedBackgroundBlurRadius = effect.blurRadius
      state.appliedBackgroundEffectSignature =
        nativeWindowBackgroundEffectSignature(effect)
    }
    return applied
  } catch (error) {
    if (!macWindowBlurWarningShown) {
      macWindowBlurWarningShown = true
      console.warn("Unable to animate macOS background blur", error)
    }
    return false
  }
}

function setWindowsWindowBackgroundEffect(
  state: WindowState,
  effect: NativeWindowBackgroundEffect
): boolean {
  if (
    process.platform !== "win32" ||
    !windowsNativeBackgroundSupported() ||
    !windowCanReceiveVisualEffect(state)
  ) {
    return false
  }
  try {
    if (!state.appliedWindowsAlphaBootstrap) {
      // This flips Aura's backing surface into its alpha-capable mode. The
      // addon immediately suppresses the stock Acrylic visual while retaining
      // that plumbing for Chromium and the custom composition target.
      state.win.setBackgroundMaterial("acrylic")
      state.appliedWindowsAlphaBootstrap = true
    }
    const addon = loadWindowsWindowBlurAddon()
    if (!addon) {
      state.win.setBackgroundMaterial("none")
      state.appliedWindowsAlphaBootstrap = false
      return false
    }
    const applied = addon.setWindowBackgroundEffect(
      state.win.getNativeWindowHandle(),
      state.win.id,
      effect.blurRadius,
      effect.red,
      effect.green,
      effect.blue,
      effect.opacity
    )
    if (applied) {
      state.appliedBackgroundBlurAnimationActive = false
      state.appliedBackgroundBlurRadius = effect.blurRadius
      state.appliedBackgroundEffectSignature =
        nativeWindowBackgroundEffectSignature(effect)
    } else {
      clearWindowsWindowBackgroundEffect(state, effect.backgroundColor)
    }
    return applied
  } catch (error) {
    if (isDestroyedElectronObjectError(error)) return false
    clearWindowsWindowBackgroundEffect(state, effect.backgroundColor)
    if (!windowsWindowBlurWarningShown) {
      windowsWindowBlurWarningShown = true
      console.warn("Unable to update Windows background blur", error)
    }
    return false
  }
}

function clearWindowsWindowBackgroundEffect(
  state: WindowState,
  restoredBackgroundColor?: string
): void {
  if (process.platform !== "win32" || !windowCanReceiveVisualEffect(state)) {
    return
  }
  // Always cover Chromium before detaching the target. Electron also resets
  // its View backing when material mode returns to `none`, so reinforce the
  // same color afterward rather than accepting its default white surface.
  if (restoredBackgroundColor) {
    setWindowBackgroundColor(state, restoredBackgroundColor)
  }
  if (
    state.appliedBackgroundEffectSignature === null &&
    state.appliedBackgroundBlurRadius === 0 &&
    !state.appliedWindowsAlphaBootstrap
  ) {
    return
  }
  let cleanupError: unknown = null
  try {
    windowsWindowBlurAddon?.clearWindowBackgroundEffect(
      state.win.getNativeWindowHandle(),
      state.win.id
    )
  } catch (error) {
    cleanupError = error
  }
  try {
    if (state.appliedWindowsAlphaBootstrap) {
      state.win.setBackgroundMaterial("none")
    }
  } catch (error) {
    cleanupError ??= error
  }
  state.appliedWindowsAlphaBootstrap = false
  state.appliedBackgroundBlurAnimationActive = false
  state.appliedBackgroundBlurRadius = 0
  state.appliedBackgroundEffectSignature = null
  if (restoredBackgroundColor) {
    setWindowBackgroundColor(state, restoredBackgroundColor)
  }
  if (cleanupError && !isDestroyedElectronObjectError(cleanupError)) {
    if (!windowsWindowBlurWarningShown) {
      windowsWindowBlurWarningShown = true
      console.warn("Unable to clear Windows background blur", cleanupError)
    }
  }
}

function releaseWindowsWindowBackgroundEffect(
  nativeHandle: Buffer,
  ownerId: number
): void {
  if (process.platform !== "win32" || !windowsWindowBlurAddon) return
  try {
    windowsWindowBlurAddon.clearWindowBackgroundEffect(nativeHandle, ownerId)
  } catch (error) {
    if (!windowsWindowBlurWarningShown) {
      windowsWindowBlurWarningShown = true
      console.warn("Unable to release Windows background blur", error)
    }
  }
}

function animateWindowsWindowBackgroundBlur(
  state: WindowState,
  effect: NativeWindowBackgroundEffect,
  transition: LaunchTransitionSettings
): boolean {
  if (process.platform !== "win32" || !windowCanReceiveVisualEffect(state)) {
    return false
  }
  const addon = loadWindowsWindowBlurAddon()
  if (!addon) return false
  const [x1, y1, x2, y2] = launchTransitionBezier(transition)
  try {
    const applied = addon.animateWindowBackgroundBlur(
      state.win.getNativeWindowHandle(),
      state.win.id,
      effect.blurRadius,
      transition.durationMs,
      transition.delayMs,
      x1,
      y1,
      x2,
      y2
    )
    if (applied) {
      state.appliedBackgroundBlurAnimationActive = true
      state.appliedBackgroundBlurRadius = effect.blurRadius
      state.appliedBackgroundEffectSignature =
        nativeWindowBackgroundEffectSignature(effect)
    }
    return applied
  } catch (error) {
    if (!windowsWindowBlurWarningShown) {
      windowsWindowBlurWarningShown = true
      console.warn("Unable to animate Windows background blur", error)
    }
    return false
  }
}

function animateNativeWindowBackgroundBlur(
  state: WindowState,
  effect: NativeWindowBackgroundEffect,
  transition: LaunchTransitionSettings
): boolean {
  return process.platform === "win32"
    ? animateWindowsWindowBackgroundBlur(state, effect, transition)
    : animateMacWindowBackgroundBlur(state, effect, transition)
}

function setNativeWindowBackgroundEffect(
  state: WindowState,
  effect: NativeWindowBackgroundEffect
): boolean {
  return process.platform === "win32"
    ? setWindowsWindowBackgroundEffect(state, effect)
    : setMacWindowBackgroundEffect(state, effect)
}

function applyWindowVisualEffectAtRevision(
  state: WindowState,
  value: AppearanceSettings,
  allowTranslucency: boolean,
  revision: number
): boolean {
  if (!windowCanReceiveVisualEffect(state, revision)) return false
  updateWindowsTitleBarOverlay(state.win, value)

  if (allowTranslucency && nativeTranslucencyEnabled(value)) {
    const effect = nativeWindowBackgroundEffect(value)
    if (
      !state.appliedBackgroundBlurAnimationActive &&
      state.appliedBackgroundEffectSignature ===
        nativeWindowBackgroundEffectSignature(effect)
    ) {
      return setWindowBackgroundColor(state, "rgba(0, 0, 0, 0)", revision)
    }
    // Install the native backdrop and tint before exposing Chromium's clear
    // backing. A missing native effect therefore leaves the editor opaque.
    if (!setNativeWindowBackgroundEffect(state, effect)) {
      setWindowBackgroundColor(state, windowBackgroundColor(value), revision)
      return false
    }
    return setWindowBackgroundColor(state, "rgba(0, 0, 0, 0)", revision)
  }

  if (process.platform === "win32") {
    // Cover the compositor before removing its target so disabling the effect,
    // including through Reduce Transparency, cannot flash the desktop clear.
    clearWindowsWindowBackgroundEffect(state, windowBackgroundColor(value))
    return false
  }

  // Restore the opaque backing before removing the macOS blur so disabling
  // the effect, including through Reduce Transparency, cannot flash clear.
  if (
    !setWindowBackgroundColor(state, windowBackgroundColor(value), revision)
  ) {
    return false
  }
  clearMacWindowBackgroundEffect(state, value)
  return false
}

function usesEagerLaunchVisualEffect(
  state: Pick<WindowState, "launchVisualBenchmark">,
  value: AppSettings
): boolean {
  const benchmark = state.launchVisualBenchmark
  return (
    benchmark?.mode === "eager" ||
    (benchmark === null &&
      nativeTranslucencyEnabled(value) &&
      !launchTransitionHasAnimation(value.launchTransition))
  )
}

function applyPreEditorLaunchVisualEffect(
  state: WindowState,
  value: AppSettings
): void {
  const eagerEffectStillApplied =
    usesEagerLaunchVisualEffect(state, value) &&
    nativeTranslucencyEnabled(value) &&
    state.eagerLaunchVisualEffectApplied &&
    state.appliedBackgroundEffectSignature ===
      nativeWindowBackgroundEffectSignature(nativeWindowBackgroundEffect(value))
  if (eagerEffectStillApplied) {
    setWindowBackgroundColor(state, "rgba(0, 0, 0, 0)")
    return
  }

  const benchmark = state.launchVisualBenchmark
  if (benchmark?.mode === "eager") {
    benchmark.visualEffectStartedEpochMs = launchBenchmarkEpochMs()
  }

  const revision = ++state.visualEffectRevision
  const applied = applyWindowVisualEffectAtRevision(
    state,
    value,
    usesEagerLaunchVisualEffect(state, value),
    revision
  )
  state.eagerLaunchVisualEffectApplied = applied

  if (benchmark?.mode === "eager") {
    benchmark.visualEffectApplied = applied
    benchmark.visualEffectReadyEpochMs = launchBenchmarkEpochMs()
  }
}

function applyWindowVisualEffect(
  state: WindowState,
  value: AppearanceSettings,
  allowTranslucency = true
): void {
  cancelScheduledWindowVisualEffect(state)
  state.eagerLaunchVisualEffectApplied = false
  state.pendingLaunchVisualEffect = null
  const revision = ++state.visualEffectRevision
  applyWindowVisualEffectAtRevision(state, value, allowTranslucency, revision)
  sendLaunchVisualEffectReady(state, null)
}

function refreshMacWindowBackgroundShape(state: WindowState): void {
  if (process.platform !== "darwin" || state.win.isDestroyed()) return
  if (!state.editorReady) {
    const appearance =
      state.pendingLaunchVisualEffect?.settings ?? state.launchSettings
    if (
      state.appliedBackgroundEffectSignature === null &&
      !nativeTranslucencyEnabled(appearance)
    ) {
      return
    }
    state.appliedBackgroundEffectSignature = null
    applyPreEditorLaunchVisualEffect(state, appearance)
    return
  }

  const appearance = state.appearancePreview ?? settings
  if (
    state.appliedBackgroundEffectSignature === null &&
    !nativeTranslucencyEnabled(appearance)
  ) {
    return
  }

  // AppKit changes the content mask when entering native fullscreen. Force
  // the bridge to refresh its matching clip even when the visual signature is
  // otherwise unchanged.
  state.appliedBackgroundEffectSignature = null
  applyWindowVisualEffect(state, appearance)
}

function sendLaunchVisualEffectReady(
  state: WindowState,
  transition: LaunchTransitionSettings | null
): void {
  if (!state.rendererReady || !windowCanReceiveVisualEffect(state)) return
  const effect: LaunchVisualEffectReady = {
    transition: transition ? { ...transition } : null,
  }
  try {
    state.win.webContents.send(ipcChannels.launchVisualEffectReady, effect)
  } catch (error) {
    if (!isDestroyedElectronObjectError(error)) throw error
  }
}

function emitLaunchVisualBenchmark(state: WindowState): void {
  const benchmark = state.launchVisualBenchmark
  if (
    !benchmark ||
    benchmark.emitted ||
    benchmark.editorReadyEpochMs === null ||
    benchmark.visualEffectReadyEpochMs === null
  ) {
    return
  }
  benchmark.emitted = true
  console.error(
    `${LAUNCH_VISUAL_BENCHMARK_PREFIX}${JSON.stringify({
      ...benchmark,
      nativeAddonLoadReadyEpochMs: launchVisualBenchmarkAddonLoadReadyEpochMs,
      nativeAddonLoadStartedEpochMs:
        launchVisualBenchmarkAddonLoadStartedEpochMs,
    })}`
  )
}

function scheduleWindowVisualEffect(
  state: WindowState,
  value: AppSettings,
  prefersReducedMotion: boolean
): void {
  cancelScheduledWindowVisualEffect(state)
  const revision = ++state.visualEffectRevision
  const task = setImmediate(() => {
    if (state.pendingWindowVisualEffectTask === task) {
      state.pendingWindowVisualEffectTask = null
    }
    if (!windowCanReceiveVisualEffect(state, revision)) {
      return
    }

    const benchmark = state.launchVisualBenchmark
    if (
      benchmark?.mode === "eager" &&
      benchmark.visualEffectReadyEpochMs !== null
    ) {
      sendLaunchVisualEffectReady(state, null)
      emitLaunchVisualBenchmark(state)
      return
    }

    if (benchmark) {
      benchmark.visualEffectStartedEpochMs = launchBenchmarkEpochMs()
    }

    const configuredTransition = value.launchTransition
    const shouldTransition =
      nativeTranslucencyEnabled(value) &&
      launchTransitionHasAnimation(configuredTransition) &&
      !prefersReducedMotion
    if (!shouldTransition) {
      if (
        state.eagerLaunchVisualEffectApplied &&
        nativeTranslucencyEnabled(value) &&
        state.appliedBackgroundEffectSignature ===
          nativeWindowBackgroundEffectSignature(
            nativeWindowBackgroundEffect(value)
          )
      ) {
        state.eagerLaunchVisualEffectApplied = false
        sendLaunchVisualEffectReady(state, null)
        emitLaunchVisualBenchmark(state)
        return
      }
      state.eagerLaunchVisualEffectApplied = false
      applyWindowVisualEffectAtRevision(state, value, true, revision)
      if (benchmark) {
        benchmark.visualEffectApplied =
          !nativeTranslucencyEnabled(value) ||
          state.appliedBackgroundEffectSignature ===
            nativeWindowBackgroundEffectSignature(
              nativeWindowBackgroundEffect(value)
            )
        benchmark.visualEffectReadyEpochMs = launchBenchmarkEpochMs()
      }
      sendLaunchVisualEffectReady(state, null)
      emitLaunchVisualBenchmark(state)
      return
    }

    state.eagerLaunchVisualEffectApplied = false
    const targetRadius = value.backgroundEffect.blurRadius
    const targetEffect = nativeWindowBackgroundEffect(value, targetRadius)
    let effectiveTransition = { ...configuredTransition }
    let applied: boolean
    if (configuredTransition.strategy === "tint-blur" && targetRadius > 0) {
      applied =
        setNativeWindowBackgroundEffect(state, {
          ...targetEffect,
          blurRadius: 0,
        }) &&
        animateNativeWindowBackgroundBlur(
          state,
          targetEffect,
          configuredTransition
        )
      if (!applied) {
        applied = setNativeWindowBackgroundEffect(state, targetEffect)
        effectiveTransition = {
          ...effectiveTransition,
          strategy: "cover",
        }
      }
    } else {
      applied = setNativeWindowBackgroundEffect(state, targetEffect)
    }

    if (!applied) {
      if (
        !setWindowBackgroundColor(state, windowBackgroundColor(value), revision)
      ) {
        return
      }
      if (benchmark) {
        benchmark.visualEffectApplied = false
        benchmark.visualEffectReadyEpochMs = launchBenchmarkEpochMs()
      }
      sendLaunchVisualEffectReady(state, null)
      emitLaunchVisualBenchmark(state)
      return
    }

    if (!setWindowBackgroundColor(state, "rgba(0, 0, 0, 0)", revision)) {
      return
    }
    if (benchmark) {
      benchmark.visualEffectApplied = true
      benchmark.visualEffectReadyEpochMs = launchBenchmarkEpochMs()
    }
    sendLaunchVisualEffectReady(state, effectiveTransition)
    emitLaunchVisualBenchmark(state)
  })
  state.pendingWindowVisualEffectTask = task
}

function schedulePendingWindowVisualEffect(state: WindowState): void {
  const pending = state.pendingLaunchVisualEffect
  state.pendingLaunchVisualEffect = null
  if (!pending) return
  scheduleWindowVisualEffect(
    state,
    pending.settings,
    pending.prefersReducedMotion
  )
}

function rendererAppearanceQuery(value: AppSettings): Record<string, string> {
  const light = resolveAppearanceProfile(value.themeByScheme.light)
  const dark = resolveAppearanceProfile(value.themeByScheme.dark)
  return {
    appearanceMode: value.appearanceMode,
    lightBackground: light.backgroundColor,
    lightForeground: light.foregroundColor,
    lightSurfaceScheme: light.surfaceScheme,
    darkBackground: dark.backgroundColor,
    darkForeground: dark.foregroundColor,
    darkSurfaceScheme: dark.surfaceScheme,
    backgroundEffectEnabled: String(value.backgroundEffect.enabled),
    backgroundTranslucency: String(value.backgroundEffect.translucency),
    launchTransitionDuration: String(
      launchTransitionHasAnimation(value.launchTransition)
        ? value.launchTransition.durationMs
        : 0
    ),
  }
}

function rendererUrl(launchAppearance: AppSettings): URL {
  const developmentUrl = app.isPackaged
    ? undefined
    : process.env.VITE_DEV_SERVER_URL
  let url: URL
  if (developmentUrl) {
    url = new URL(developmentUrl)
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("VITE_DEV_SERVER_URL must be a local HTTP URL")
    }
  } else {
    url = new URL(`${PULSE_MD_APP_SCHEME}://bundle/index.html`)
  }

  for (const [name, value] of Object.entries(
    rendererAppearanceQuery(launchAppearance)
  )) {
    url.searchParams.set(name, value)
  }
  url.searchParams.set("backgroundCapability", rendererBackgroundCapability())
  return url
}

function recoveryRendererUrl(
  launchAppearance: AppSettings,
  reason: "bootstrap" | "crash"
): URL {
  const url = rendererUrl(launchAppearance)
  url.pathname = "/recovery.html"
  url.searchParams.set("reason", reason)
  return url
}

async function loadRenderer(win: BrowserWindow, url: URL): Promise<void> {
  await win.loadURL(url.href)
}

async function durablePreparedTabAfterRendererFailure(
  tab: TabState
): Promise<PreparedTab> {
  if (tab.backing === "scratch" && tab.scratchIdentity) {
    return preparedScratchTab(tab.scratchIdentity.scratchId, {
      ...(tab.color ? { color: tab.color } : {}),
      ...(tab.title ? { title: tab.title } : {}),
    })
  }
  if (tab.backing === "file" && tab.document.filePath) {
    const prepared = await preparedFileTab(tab.document.filePath)
    return {
      ...prepared,
      ...(tab.color ? { color: tab.color } : {}),
      ...(tab.title ? { title: tab.title } : {}),
    }
  }

  // Before the first hydration acknowledgement, the main process still owns
  // the complete initial payload (including CLI stdin). Preserve that payload.
  // Once acknowledged, ordinary untitled/ephemeral edits lived only in the
  // failed renderer and cannot be reconstructed.
  if (tab.document.content.length > 0) {
    return {
      backing: tab.backing === "ephemeral" ? "ephemeral" : "untitled",
      ...(tab.color ? { color: tab.color } : {}),
      contentHash: tab.diskContentHash,
      diskFingerprint: tab.diskFingerprint,
      dirty: tab.dirty,
      document: cloneDocument(tab.document),
      ioPath: null,
      ...(tab.title ? { title: tab.title } : {}),
    }
  }
  return preparedEmptyTab(
    tab.backing === "ephemeral" ? "ephemeral" : "untitled",
    {
      ...(tab.color ? { color: tab.color } : {}),
      ...(tab.title ? { title: tab.title } : {}),
    }
  )
}

function applyRecoveredPreparedTab(tab: TabState, prepared: PreparedTab): void {
  tab.backing = prepared.backing
  tab.color = prepared.color
  tab.diskContentHash = prepared.contentHash
  tab.diskFingerprint = prepared.diskFingerprint
  tab.dirty = prepared.dirty
  tab.document = cloneDocument(prepared.document)
  tab.fileMissing =
    prepared.backing === "file" &&
    prepared.ioPath !== null &&
    prepared.diskFingerprint === null
  tab.ioPath = prepared.ioPath
  tab.profileOrigin = prepared.profileOrigin ?? tab.profileOrigin
  tab.scratchIdentity = prepared.scratchIdentity ?? null
  tab.title = prepared.title ?? null
}

async function prepareWindowRendererReload(state: WindowState): Promise<void> {
  // A pending hydration owns launch-only semantics that are intentionally not
  // duplicated in TabState, including referenced-scratch existence and the
  // profile tab's initial mode. Keep the complete entry across renderer
  // replacement so an in-flight background read remains the sole writer; the
  // new renderer can join that promise and retry interactively after a null.
  for (const tabId of state.tabIds) {
    const tab = tabStates.get(tabId)
    if (!tab) continue
    for (const token of [...tab.pendingSaveTokens]) {
      clearPendingSaveAcknowledgement(token)
    }
    await waitForTabSaveIdle(tab)
    unwatchTabDocument(tab.id)
    abortPendingTransfersForTab(tab.id)
  }

  state.approvedTabCloses.clear()
  state.bootstrapPending = true
  state.editorCommandDrainActive = false
  state.editorCommandHandlingReady = false
  state.editorReady = false
  state.rendererReady = false
  state.pendingEditorCommands.length = 0
  state.pendingLaunchVisualEffect = null

  for (const tabId of state.tabIds) {
    const tab = tabStates.get(tabId)
    if (!tab) continue
    if (state.tabHydrations.has(tab.id)) continue
    registerTabHydration(state, tab.id, async () => {
      const current = tabStates.get(tab.id)
      if (!current || !tabCanHydrateInState(state, current)) return null
      const prepared = await durablePreparedTabAfterRendererFailure(current)
      if (!tabCanHydrateInState(state, current)) return null
      applyRecoveredPreparedTab(current, prepared)
      return bootstrapTab(current, undefined, {
        ...(prepared.baselineContent !== undefined
          ? { baselineContent: prepared.baselineContent }
          : {}),
        ...(prepared.initialCursor
          ? { initialCursor: prepared.initialCursor }
          : {}),
        ...(prepared.initialEditorMode
          ? { initialEditorMode: prepared.initialEditorMode }
          : {}),
      })
    })
  }
  updateWindowNativeDocument(state)
}

async function showWindowRecoverySurface(
  state: WindowState,
  reason: "bootstrap" | "crash",
  error?: unknown
): Promise<boolean> {
  const { win } = state
  if (win.isDestroyed() || state.allowClose) return false
  if (state.recoveryInProgress) return state.recoverySurfaceActive
  releaseSettingsSessionForWindow(win.id)
  state.recoveryInProgress = true
  state.editorReady = false
  state.rendererReady = false
  state.editorCommandHandlingReady = false
  finishPendingCloseSave(state, false)
  finishPendingWindowClosePreparation(state, false)
  for (const requestId of [...pendingEditorCommandAcknowledgements.keys()]) {
    const pending = pendingEditorCommandAcknowledgements.get(requestId)
    if (pending?.ownerWindowId === win.id) {
      finishPendingEditorCommand(requestId, false)
    }
  }

  const recoveryUrl = recoveryRendererUrl(state.launchSettings, reason)
  state.trustedRendererLocation = trustedRendererLocation(recoveryUrl)
  state.recoverySurfaceActive = true
  if (BrowserWindow.getFocusedWindow()?.id === win.id) {
    updateViewMenuItems(state)
  }
  try {
    // loadURL starts a replacement renderer after a crash. Navigating straight
    // to the recovery surface avoids first reloading the failed application
    // renderer only to discard it in a second navigation.
    await loadRenderer(win, recoveryUrl)
    if (win.isDestroyed()) return false
    win.show()
    return true
  } catch (recoveryError) {
    state.recoverySurfaceActive = false
    if (BrowserWindow.getFocusedWindow()?.id === win.id) {
      updateViewMenuItems(state)
    }
    console.error("Unable to load the in-window recovery surface", {
      error,
      recoveryError,
    })
    if (!win.isDestroyed()) {
      await showOperationError(
        win,
        "Recovery Failed",
        "The editor stopped unexpectedly and its recovery interface could not be loaded.",
        recoveryError
      )
      win.destroy()
    }
    return false
  } finally {
    state.recoveryInProgress = false
  }
}

async function reloadRecoveredWindow(state: WindowState): Promise<void> {
  if (state.recoveryInProgress) {
    throw new Error("Recovery is already in progress")
  }
  state.recoveryInProgress = true
  try {
    await prepareWindowRendererReload(state)
    const latestSettings = await currentSettings()
    state.launchSettings = cloneAppSettings(latestSettings)
    const url = rendererUrl(latestSettings)
    state.trustedRendererLocation = trustedRendererLocation(url)
    state.recoverySurfaceActive = false
    applyPreEditorLaunchVisualEffect(state, latestSettings)
    await loadRenderer(state.win, url)
    if (!state.win.isDestroyed() && !state.win.webContents.isDestroyed()) {
      await state.win.webContents.setVisualZoomLevelLimits(
        MIN_VISUAL_ZOOM_SCALE,
        MAX_VISUAL_ZOOM_SCALE
      )
    }
  } catch (error) {
    state.recoveryInProgress = false
    await showWindowRecoverySurface(state, "bootstrap", error)
    throw error
  } finally {
    state.recoveryInProgress = false
  }
}

function positionMacWindowButtons(
  win: BrowserWindow,
  zoomFactor?: number
): void {
  if (
    process.platform !== "darwin" ||
    win.isDestroyed() ||
    win.webContents.isDestroyed()
  ) {
    return
  }
  try {
    win.setWindowButtonPosition(
      macWindowButtonPosition(zoomFactor ?? win.webContents.getZoomFactor())
    )
  } catch (error) {
    if (!isDestroyedElectronObjectError(error)) throw error
  }
}

function positionNativeWindowButtons(
  win: BrowserWindow,
  zoomFactor?: number
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  positionMacWindowButtons(win, zoomFactor)
  if (process.platform !== "win32") return
  const state = windowStates.get(win.id)
  const appearance = state
    ? state.rendererReady
      ? (state.appearancePreview ?? settings)
      : state.launchSettings
    : settings
  updateWindowsTitleBarOverlay(win, appearance, zoomFactor)
}

function zoomFactorsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < ZOOM_FACTOR_EPSILON
}

function clampZoomFactor(zoomFactor: number): number {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor))
}

function adjustWindowZoomByStep(win: BrowserWindow, direction: -1 | 1): void {
  const percent = Math.round(win.webContents.getZoomFactor() * 100)
  const stepPercent = Math.round(ZOOM_FACTOR_STEP * 100)
  const nextZoomFactor = clampZoomFactor(
    (percent + direction * stepPercent) / 100
  )
  // The preload's viewport listener reports this page-zoom change through the
  // same persistence/broadcast path used by Electron's Actual Size role.
  applyWindowZoom(win, nextZoomFactor)
}

function applyWindowZoom(win: BrowserWindow, zoomFactor: number): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  if (!zoomFactorsMatch(win.webContents.getZoomFactor(), zoomFactor)) {
    win.webContents.setZoomFactor(zoomFactor)
  }
  positionNativeWindowButtons(win, zoomFactor)
}

function persistWindowZoomFactor(
  zoomFactor: number,
  sourceWindowId: WindowId
): void {
  const revision = ++zoomPersistenceRevision
  const write = settingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (revision !== zoomPersistenceRevision) return
      let nextSettings = settings
      if (!zoomFactorsMatch(settings.zoomFactor, zoomFactor)) {
        nextSettings = { ...settings, zoomFactor }
        await atomicWrite(
          settingsPath(),
          `${JSON.stringify(nextSettings, null, 2)}\n`
        )
        settings = nextSettings
      }
      if (revision !== zoomPersistenceRevision) return
      for (const state of windowStates.values()) {
        const { win } = state
        if (win.isDestroyed()) continue
        if (win.id !== sourceWindowId) applyWindowZoom(win, zoomFactor)
        if (!state.rendererReady || win.webContents.isDestroyed()) continue
        win.webContents.send(
          ipcChannels.settingsChanged,
          settingsSnapshotForWindow(state, nextSettings)
        )
      }
    })
  settingsWriteQueue = write
  void write.catch((error) => {
    if (revision !== zoomPersistenceRevision) return
    console.error("Unable to persist window zoom", error)
    for (const { win } of windowStates.values()) {
      applyWindowZoom(win, settings.zoomFactor)
    }
    const sourceState = windowStates.get(sourceWindowId)
    if (
      sourceState?.rendererReady &&
      !sourceState.win.isDestroyed() &&
      !sourceState.win.webContents.isDestroyed()
    ) {
      sourceState.win.webContents.send(
        ipcChannels.windowZoomPersistenceFailed,
        zoomFactor
      )
    }
  })
}

let lastBroadcastTabDragActivity: boolean | null = null
let tabDragTrackingTimer: ReturnType<typeof setInterval> | null = null
let macTabDragEscapePollingActive = false
let macTabDragEscapeArmed = false
let macTabDragEscapeWarningShown = false

function warnMacTabDragEscape(error: unknown): void {
  if (macTabDragEscapeWarningShown) return
  macTabDragEscapeWarningShown = true
  console.warn("Unable to read Escape during a native tab drag", error)
}

function beginMacTabDragEscapePolling(): void {
  if (process.platform !== "darwin" || macTabDragEscapePollingActive) return
  const addon = loadMacWindowBlurAddon()
  if (!addon) return
  try {
    macTabDragEscapePollingActive = true
    macTabDragEscapeArmed = !addon.tabDragEscapeKeyPressed()
  } catch (error) {
    macTabDragEscapePollingActive = false
    warnMacTabDragEscape(error)
  }
}

function consumeMacTabDragEscape(): boolean {
  if (!macTabDragEscapePollingActive) return false
  const addon = loadMacWindowBlurAddon()
  if (!addon) return false
  try {
    const pressed = addon.tabDragEscapeKeyPressed()
    if (!pressed) {
      macTabDragEscapeArmed = true
      return false
    }
    if (!macTabDragEscapeArmed) return false
    macTabDragEscapeArmed = false
    return true
  } catch (error) {
    macTabDragEscapePollingActive = false
    macTabDragEscapeArmed = false
    warnMacTabDragEscape(error)
    return false
  }
}

function endMacTabDragEscapePolling(): void {
  macTabDragEscapePollingActive = false
  macTabDragEscapeArmed = false
}

function broadcastTabDragActivity(): void {
  const active = activeDragTokens.size > 0
  if (active === lastBroadcastTabDragActivity) return
  lastBroadcastTabDragActivity = active
  for (const state of windowStates.values()) {
    if (
      !state.rendererReady ||
      state.win.isDestroyed() ||
      state.win.webContents.isDestroyed()
    ) {
      continue
    }
    state.win.webContents.send(ipcChannels.tabDragActivity, active)
  }
}

function deactivateTabDrag(dragToken: string): void {
  if (!activeDragTokens.delete(dragToken)) return
  broadcastTabDragActivity()
  updateTabDragTracking()
}

function cancelActiveTabDragsForWindow(windowId: WindowId): void {
  let deactivated = false
  for (const dragToken of [...activeDragTokens]) {
    const token = dragTokens.get(dragToken)
    if (!token || token.sourceWindowId !== windowId) continue
    token.cancelled = true
    token.geometry = null
    activeDragTokens.delete(dragToken)
    deactivated = true
    const pending = pendingTabDetaches.get(dragToken)
    if (pending) abortPendingTabDetach(pending, false)
  }
  if (deactivated) broadcastTabDragActivity()
  updateTabDragTracking()
}

function deleteDragToken(dragToken: string, broadcast = true): void {
  const pendingDetach = pendingTabDetaches.get(dragToken)
  if (pendingDetach) abortPendingTabDetach(pendingDetach, false)
  const token = dragTokens.get(dragToken)
  if (token) {
    clearTimeout(token.timeout)
    for (const resolve of token.exportWaiters) resolve(null)
    token.exportWaiters.clear()
  }
  dragTokens.delete(dragToken)
  const wasActive = activeDragTokens.delete(dragToken)
  if (broadcast && wasActive) broadcastTabDragActivity()
  updateTabDragTracking()
}

function sendTabTransferCommitSettled(
  sourceWindowId: WindowId,
  transferId: TransferId,
  committed: boolean
): void {
  const sourceState = windowStates.get(sourceWindowId)
  if (
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.win.webContents.isDestroyed()
  ) {
    return
  }
  sourceState.win.webContents.send(ipcChannels.tabTransferCommitSettled, {
    committed,
    transferId,
  })
}

function updateTabDragTracking(): void {
  const shouldTrack =
    tabTearOutPreviewSupported &&
    [...activeDragTokens].some((dragToken) =>
      Boolean(dragTokens.get(dragToken)?.geometry)
    )
  if (shouldTrack && !tabDragTrackingTimer) {
    beginMacTabDragEscapePolling()
    tabDragTrackingTimer = setInterval(
      trackActiveTabDrags,
      TAB_DRAG_TRACKING_INTERVAL_MS
    )
    tabDragTrackingTimer.unref()
  } else if (!shouldTrack && tabDragTrackingTimer) {
    clearInterval(tabDragTrackingTimer)
    tabDragTrackingTimer = null
    endMacTabDragEscapePolling()
  }
}

function tabDropTargetAtPoint(
  sourceWindowId: WindowId,
  point: { x: number; y: number }
): boolean {
  for (const state of windowStates.values()) {
    if (
      state.win.id === sourceWindowId ||
      state.provisional ||
      state.closeSequence ||
      state.allowClose ||
      state.win.isDestroyed() ||
      !state.win.isVisible()
    ) {
      continue
    }
    const bounds = state.win.getBounds()
    const chromeHeight =
      TOP_CHROME_HEIGHT * state.win.webContents.getZoomFactor()
    if (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + chromeHeight
    ) {
      return true
    }
  }
  return false
}

function updatePendingTabDetachPreview(
  pending: PendingTabDetach,
  point: { x: number; y: number }
): void {
  const targetState = pending.targetWindowId
    ? windowStates.get(pending.targetWindowId)
    : undefined
  if (!targetState || targetState.win.isDestroyed()) return
  const token = dragTokens.get(pending.dragToken)
  if (!token?.geometry) return

  const sourceState = windowStates.get(pending.sourceWindowId)
  const withinSourceThreshold =
    !sourceState ||
    sourceState.win.isDestroyed() ||
    !shouldPrepareTabTearOut(
      point,
      sourceState.win.getBounds(),
      token.geometry.sourceStripBounds
    )
  const hiddenForExistingTarget =
    !pending.released && tabDropTargetAtPoint(pending.sourceWindowId, point)
  if (withinSourceThreshold || hiddenForExistingTarget) {
    targetState.win.setIgnoreMouseEvents(true)
    if (pending.previewVisible && targetState.win.isVisible()) {
      targetState.win.hide()
    }
    pending.previewVisible = false
    return
  }

  const position = tabTearOutWindowPosition(point, token.geometry.cursorOffset)
  if (
    !pending.lastPreviewPosition ||
    pending.lastPreviewPosition.x !== position.x ||
    pending.lastPreviewPosition.y !== position.y
  ) {
    targetState.win.setPosition(position.x, position.y, false)
    pending.lastPreviewPosition = position
  }
  if (!pending.previewVisible || !targetState.win.isVisible()) {
    // The provisional window is the native drop sink outside app-owned tab
    // strips. Keeping it hit-testable prevents another application underneath
    // from accepting the opaque internal drag payload or stealing activation.
    targetState.win.setIgnoreMouseEvents(pending.released)
    targetState.win.showInactive()
  }
  pending.previewVisible = true
}

function tabDetachBaseline(tab: TabState): TabDetachBaseline {
  return {
    diskContentHash: tab.diskContentHash,
    filePath: tab.document.filePath,
    ioPath: tab.ioPath,
    mtimeMs: tab.document.mtimeMs,
    saveGeneration: tab.saveGeneration,
  }
}

function tabDetachBaselineMatches(
  tab: TabState,
  baseline: TabDetachBaseline
): boolean {
  return (
    tab.diskContentHash === baseline.diskContentHash &&
    tab.document.filePath === baseline.filePath &&
    tab.ioPath === baseline.ioPath &&
    tab.document.mtimeMs === baseline.mtimeMs &&
    tab.saveGeneration === baseline.saveGeneration
  )
}

function pendingTabDetachParticipants(pending: PendingTabDetach): {
  sourceState: WindowState
  tab: TabState
  targetState: WindowState | null
} | null {
  if (pendingTabDetaches.get(pending.dragToken) !== pending) return null
  const sourceState = windowStates.get(pending.sourceWindowId)
  const tab = tabStates.get(pending.tabId)
  const targetState = pending.targetWindowId
    ? (windowStates.get(pending.targetWindowId) ?? null)
    : null
  if (
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.closeSequence ||
    sourceState.allowClose ||
    sourceState.tabMutationLocked ||
    sourceState.tabIds.length <= 1 ||
    !tab ||
    tab.ownerWindowId !== sourceState.win.id ||
    tabSaveActive(tab) ||
    pendingExternalDocumentChanges.has(tab.id) ||
    !tabDetachBaselineMatches(tab, pending.baseline)
  ) {
    return null
  }
  if (targetState?.tabMutationLocked) return null
  return { sourceState, tab, targetState }
}

function retirePendingTabDetachSource(pending: PendingTabDetach): void {
  if (pending.sourceVisuallyRetired) return
  const sourceState = windowStates.get(pending.sourceWindowId)
  if (
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.win.webContents.isDestroyed()
  ) {
    return
  }
  pending.sourceVisuallyRetired = true
  acquireBackgroundRenderingLease(sourceState)
  pending.sourceBackgroundRenderingLeaseActive = true
  pending.retirementTimeout = setTimeout(
    () => abortPendingTabDetach(pending),
    SOURCE_RETIREMENT_ACK_TIMEOUT_MS
  )
  sourceState.win.webContents.send(ipcChannels.tabDetachSourceRetired, {
    dragToken: pending.dragToken,
    tabId: pending.tabId,
  })
}

function acquireBackgroundRenderingLease(state: WindowState): void {
  const leaseCount = backgroundRenderingLeaseCounts.get(state.win.id) ?? 0
  backgroundRenderingLeaseCounts.set(state.win.id, leaseCount + 1)
  if (leaseCount === 0 && !state.win.webContents.isDestroyed()) {
    state.win.webContents.setBackgroundThrottling(false)
  }
}

function releasePendingTabDetachSourceRenderingLease(
  pending: PendingTabDetach
): void {
  if (!pending.sourceBackgroundRenderingLeaseActive) return
  pending.sourceBackgroundRenderingLeaseActive = false
  const leaseCount = backgroundRenderingLeaseCounts.get(pending.sourceWindowId)
  if (!leaseCount) return
  if (leaseCount > 1) {
    backgroundRenderingLeaseCounts.set(pending.sourceWindowId, leaseCount - 1)
    return
  }
  backgroundRenderingLeaseCounts.delete(pending.sourceWindowId)
  const sourceState = windowStates.get(pending.sourceWindowId)
  if (
    sourceState &&
    !sourceState.win.isDestroyed() &&
    !sourceState.win.webContents.isDestroyed()
  ) {
    sourceState.win.webContents.setBackgroundThrottling(
      WINDOW_BACKGROUND_THROTTLING_ENABLED
    )
  }
}

function abortPendingTabDetach(
  pending: PendingTabDetach,
  deleteToken = true
): void {
  if (pendingTabDetaches.get(pending.dragToken) !== pending) return
  pendingTabDetaches.delete(pending.dragToken)
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = null
  if (pending.retirementTimeout) clearTimeout(pending.retirementTimeout)
  pending.retirementTimeout = null
  releasePendingTabDetachSourceRenderingLease(pending)
  if (pending.validationId) {
    finishDetachValidation(pending.validationId, false)
  }
  const targetState = pending.targetWindowId
    ? windowStates.get(pending.targetWindowId)
    : undefined
  if (targetState && !targetState.win.isDestroyed()) {
    targetState.rememberWhenClosed = false
    targetState.win.destroy()
  }
  if (pending.validationId) {
    sendTabTransferCommitSettled(
      pending.sourceWindowId,
      pending.validationId,
      false
    )
  }
  if (pending.sourceVisuallyRetired) {
    const sourceState = windowStates.get(pending.sourceWindowId)
    if (sourceState && !sourceState.win.isDestroyed()) {
      sourceState.win.webContents.send(ipcChannels.tabDetachSourceSettled, {
        committed: false,
        dragToken: pending.dragToken,
      })
      sendTabsChanged(sourceState)
    }
  }
  if (deleteToken) deleteDragToken(pending.dragToken)
}

function requestDragTokenExport(
  token: DragTokenState
): Promise<SerializedEditorSession | null> {
  if (token.editorSession) return Promise.resolve(token.editorSession)
  const sourceState = windowStates.get(token.sourceWindowId)
  if (
    dragTokens.get(token.token) !== token ||
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.win.webContents.isDestroyed()
  ) {
    return Promise.resolve(null)
  }
  const exported = new Promise<SerializedEditorSession | null>((resolve) => {
    token.exportWaiters.add(resolve)
  })
  if (!token.exportRequestId) {
    token.exportRequestId = randomUUID()
    sourceState.win.webContents.send(ipcChannels.tabExportRequested, {
      transferId: token.exportRequestId,
      tabId: token.tabId,
    })
  }
  return exported
}

function startPendingTabDetach(token: DragTokenState): void {
  if (pendingTabDetaches.has(token.token) || !token.geometry) return
  const sourceState = windowStates.get(token.sourceWindowId)
  const tab = tabStates.get(token.tabId)
  if (
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.closeSequence ||
    sourceState.allowClose ||
    sourceState.tabMutationLocked ||
    sourceState.tabIds.length <= 1 ||
    !tab ||
    tab.ownerWindowId !== sourceState.win.id ||
    tabSaveActive(tab) ||
    pendingExternalDocumentChanges.has(tab.id) ||
    [...pendingTransfers.values()].some((pending) => pending.tabId === tab.id)
  ) {
    return
  }

  const pending: PendingTabDetach = {
    baseline: tabDetachBaseline(tab),
    creatingTarget: false,
    dragToken: token.token,
    editorSession: null,
    finalScreenPoint: null,
    lastPreviewPosition: null,
    previewVisible: false,
    released: false,
    retirementTimeout: null,
    sourceBackgroundRenderingLeaseActive: false,
    sourceWindowId: sourceState.win.id,
    sourceVisuallyRetired: false,
    sourceRetirementAcknowledged: false,
    tabId: tab.id,
    targetRendererReady: false,
    targetWindowId: null,
    timeout: null,
    validationId: null,
    validationValid: null,
    validating: false,
  }
  pendingTabDetaches.set(token.token, pending)
  pending.timeout = setTimeout(
    () => abortPendingTabDetach(pending),
    TAB_EXPORT_TIMEOUT_MS
  )
  void requestDragTokenExport(token).then((editorSession) => {
    if (pendingTabDetaches.get(pending.dragToken) !== pending) return
    if (!editorSession) {
      abortPendingTabDetach(pending)
      return
    }
    acceptPendingTabDetachExport(pending, editorSession)
  })
}

function acceptPendingTabDetachExport(
  pending: PendingTabDetach,
  editorSession: SerializedEditorSession
): void {
  if (pending.editorSession || pending.creatingTarget) return
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = null
  const participants = pendingTabDetachParticipants(pending)
  const token = dragTokens.get(pending.dragToken)
  if (!participants || !token?.geometry) {
    abortPendingTabDetach(pending)
    return
  }

  pending.editorSession = editorSession
  pending.creatingTarget = true
  pending.timeout = setTimeout(
    () => abortPendingTabDetach(pending),
    TAB_EXPORT_TIMEOUT_MS
  )
  const point =
    pending.finalScreenPoint ??
    token.lastCursorPoint ??
    screen.getCursorScreenPoint()
  void createDocumentWindow({
    existingTab: { tabId: pending.tabId, editorSession },
    onCreated: (win, state) => {
      if (pendingTabDetaches.get(pending.dragToken) !== pending) {
        win.destroy()
        return
      }
      pending.targetWindowId = win.id
      state.rememberWhenClosed = false
      win.setIgnoreMouseEvents(true)
      win.setSkipTaskbar(true)
      const latestPoint =
        pending.finalScreenPoint ??
        dragTokens.get(pending.dragToken)?.lastCursorPoint ??
        point
      updatePendingTabDetachPreview(pending, latestPoint)
    },
    position: tabTearOutWindowPosition(point, token.geometry.cursorOffset),
    provisional: true,
    showAfterLoad: false,
  }).then((targetWindow) => {
    pending.creatingTarget = false
    if (pendingTabDetaches.get(pending.dragToken) !== pending) {
      if (targetWindow && !targetWindow.isDestroyed()) targetWindow.destroy()
      return
    }
    if (!targetWindow) {
      abortPendingTabDetach(pending)
      return
    }
    const targetState = windowStates.get(targetWindow.id)
    if (targetState?.rendererReady) {
      markPendingTabDetachRendererReady(targetState)
    }
  })
}

function markPendingTabDetachRendererReady(targetState: WindowState): void {
  for (const pending of pendingTabDetaches.values()) {
    if (pending.targetWindowId !== targetState.win.id) continue
    pending.targetRendererReady = true
    if (pending.timeout) clearTimeout(pending.timeout)
    pending.timeout = null
    beginPendingTabDetachValidation(pending)
    void maybeFinalizePendingTabDetach(pending)
  }
}

function beginPendingTabDetachValidation(pending: PendingTabDetach): void {
  if (
    !pending.editorSession ||
    !pending.targetRendererReady ||
    pending.validating ||
    pending.validationId
  ) {
    return
  }
  const participants = pendingTabDetachParticipants(pending)
  if (!participants?.targetState) {
    abortPendingTabDetach(pending)
    return
  }
  const validationId = randomUUID()
  pending.validationId = validationId
  pending.validating = true
  void requestDetachValidation(
    participants.sourceState,
    participants.targetState,
    pending.tabId,
    pending.editorSession.revision,
    validationId
  ).then((valid) => {
    if (pendingTabDetaches.get(pending.dragToken) !== pending) return
    pending.validating = false
    pending.validationValid = valid
    if (!valid) {
      abortPendingTabDetach(pending)
      return
    }
    maybeFinalizePendingTabDetach(pending)
  })
}

function maybeFinalizePendingTabDetach(pending: PendingTabDetach): void {
  if (
    !pending.released ||
    !pending.editorSession ||
    !pending.targetRendererReady ||
    pending.validating ||
    !pending.validationId ||
    pending.validationValid !== true ||
    !pending.sourceRetirementAcknowledged
  ) {
    return
  }
  const participants = pendingTabDetachParticipants(pending)
  if (!participants?.targetState) {
    abortPendingTabDetach(pending)
    return
  }
  const { sourceState, tab, targetState } = participants
  if (
    targetState.win.isDestroyed() ||
    targetState.closeSequence ||
    targetState.allowClose ||
    sourceState.tabMutationLocked ||
    targetState.tabMutationLocked ||
    !targetState.provisional
  ) {
    abortPendingTabDetach(pending)
    return
  }
  const sourceIndex = removeTabFromState(sourceState, tab.id)
  if (sourceState.activeTabId === tab.id) {
    sourceState.activeTabId =
      sourceState.tabIds[Math.min(sourceIndex, sourceState.tabIds.length - 1)]
  }
  tab.ownerWindowId = targetState.win.id
  watchTabDocument(tab)
  targetState.provisional = false
  targetState.rememberWhenClosed = true
  pendingTabDetaches.delete(pending.dragToken)
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = null
  if (pending.retirementTimeout) clearTimeout(pending.retirementTimeout)
  pending.retirementTimeout = null
  releasePendingTabDetachSourceRenderingLease(pending)
  deleteDragToken(pending.dragToken)
  updateWindowNativeDocument(sourceState)
  updateWindowNativeDocument(targetState)
  if (pending.sourceVisuallyRetired) {
    sourceState.win.webContents.send(ipcChannels.tabDetachSourceSettled, {
      committed: true,
      dragToken: pending.dragToken,
    })
  }
  sendTabsChanged(sourceState)
  sendTabsChanged(targetState)
  sendTabTransferCommitSettled(
    pending.sourceWindowId,
    pending.validationId,
    true
  )
  targetState.win.setIgnoreMouseEvents(false)
  targetState.win.setSkipTaskbar(false)
  targetState.win.show()
  targetState.win.focus()
}

function trackActiveTabDrags(): void {
  if (activeDragTokens.size === 0) {
    updateTabDragTracking()
    return
  }
  if (consumeMacTabDragEscape()) {
    const sourceWindowIds = new Set<WindowId>()
    for (const dragToken of activeDragTokens) {
      const token = dragTokens.get(dragToken)
      if (token?.geometry) sourceWindowIds.add(token.sourceWindowId)
    }
    for (const windowId of sourceWindowIds) {
      cancelActiveTabDragsForWindow(windowId)
    }
    return
  }
  const point = screen.getCursorScreenPoint()
  let trackingEligibilityChanged = false
  for (const dragToken of [...activeDragTokens]) {
    const token = dragTokens.get(dragToken)
    if (!token?.geometry) continue
    token.lastCursorPoint = point
    const sourceState = windowStates.get(token.sourceWindowId)
    const tab = tabStates.get(token.tabId)
    if (
      !sourceState ||
      sourceState.win.isDestroyed() ||
      !tab ||
      tab.ownerWindowId !== sourceState.win.id
    ) {
      deleteDragToken(dragToken)
      continue
    }
    if (
      sourceState.tabIds.length <= 1 ||
      tabSaveActive(tab) ||
      pendingExternalDocumentChanges.has(tab.id)
    ) {
      const pending = pendingTabDetaches.get(dragToken)
      if (pending) abortPendingTabDetach(pending, false)
      token.geometry = null
      trackingEligibilityChanged = true
      continue
    }
    if (
      !pendingTabDetaches.has(dragToken) &&
      shouldPrepareTabTearOut(
        point,
        sourceState.win.getBounds(),
        token.geometry.sourceStripBounds
      )
    ) {
      startPendingTabDetach(token)
    }
    const pending = pendingTabDetaches.get(dragToken)
    if (pending) updatePendingTabDetachPreview(pending, point)
  }
  if (trackingEligibilityChanged) updateTabDragTracking()
}

function releaseTabDragAsDetach(
  token: DragTokenState,
  point: { x: number; y: number }
): void {
  const sourceState = windowStates.get(token.sourceWindowId)
  if (
    dragTokens.get(token.token) !== token ||
    token.cancelled ||
    !token.geometry ||
    !sourceState ||
    sourceState.win.isDestroyed() ||
    sourceState.tabIds.length <= 1
  ) {
    deleteDragToken(token.token)
    return
  }
  if (!pendingTabDetaches.has(token.token)) startPendingTabDetach(token)
  const pending = pendingTabDetaches.get(token.token)
  if (!pending) {
    deleteDragToken(token.token)
    return
  }
  pending.finalScreenPoint = point
  pending.released = true
  updatePendingTabDetachPreview(pending, point)
  const targetState = pending.targetWindowId
    ? windowStates.get(pending.targetWindowId)
    : undefined
  if (targetState && !targetState.win.isDestroyed()) {
    targetState.win.setIgnoreMouseEvents(true)
  }
  retirePendingTabDetachSource(pending)
  maybeFinalizePendingTabDetach(pending)
}

function abortPendingTransfer(transferId: TransferId): void {
  const pending = pendingTransfers.get(transferId)
  if (!pending) return
  pendingTransfers.delete(transferId)
  sendTabTransferCommitSettled(
    pending.sourceWindowId,
    pending.transferId,
    false
  )
  deleteDragToken(pending.dragToken)
  if (pending.timeout) clearTimeout(pending.timeout)
}

function abortPendingTransfersForTab(tabId: TabId): void {
  for (const pending of pendingTransfers.values()) {
    if (pending.tabId === tabId) abortPendingTransfer(pending.transferId)
  }
  for (const pending of pendingDetachValidations.values()) {
    if (pending.tabId === tabId) {
      finishDetachValidation(pending.validationId, false)
    }
  }
  for (const pending of pendingTabDetaches.values()) {
    if (pending.tabId === tabId) abortPendingTabDetach(pending)
  }
}

function finishDetachValidation(
  validationId: TransferId,
  valid: boolean
): void {
  const pending = pendingDetachValidations.get(validationId)
  if (!pending) return
  pendingDetachValidations.delete(validationId)
  clearTimeout(pending.timeout)
  pending.resolve(valid)
}

function requestDetachValidation(
  sourceState: WindowState,
  targetState: WindowState,
  tabId: TabId,
  revision: number,
  validationId: TransferId
): Promise<boolean> {
  if (
    sourceState.win.isDestroyed() ||
    sourceState.win.webContents.isDestroyed()
  ) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(
      () => finishDetachValidation(validationId, false),
      DETACH_VALIDATION_TIMEOUT_MS
    )
    pendingDetachValidations.set(validationId, {
      resolve,
      sourceWindowId: sourceState.win.id,
      tabId,
      targetWindowId: targetState.win.id,
      timeout,
      validationId,
    })
    sourceState.win.webContents.send(ipcChannels.tabTransferCommitRequested, {
      transferId: validationId,
      tabId,
      revision,
    })
  })
}

function abortTransfersForWindow(windowId: WindowId): void {
  for (const pending of pendingTransfers.values()) {
    if (
      pending.sourceWindowId === windowId ||
      pending.targetWindowId === windowId
    ) {
      abortPendingTransfer(pending.transferId)
    }
  }
  for (const pending of pendingDetachValidations.values()) {
    if (
      pending.sourceWindowId === windowId ||
      pending.targetWindowId === windowId
    ) {
      finishDetachValidation(pending.validationId, false)
    }
  }
  for (const pending of pendingTabDetaches.values()) {
    if (
      pending.sourceWindowId === windowId ||
      pending.targetWindowId === windowId
    ) {
      abortPendingTabDetach(pending)
    }
  }
  for (const token of dragTokens.values()) {
    if (token.sourceWindowId === windowId) deleteDragToken(token.token)
  }
}

async function createDocumentWindow(
  options: CreateWindowOptions = {}
): Promise<BrowserWindow | null> {
  restoreForegroundActivationPolicy()
  const windowSize = { ...(options.size ?? rememberedWindowSize) }
  const launchAppearance = await currentSettings()
  // Keep native dialogs and caption affordances aligned with an explicit app
  // appearance before the window is constructed.
  applyWindowsNativeThemeSource(launchAppearance)
  if (options.launchOverrides?.editorMode) {
    launchAppearance.initialEditorMode = options.launchOverrides.editorMode
  }
  if (options.launchOverrides?.tabVisibility) {
    launchAppearance.chrome.tabVisibility =
      options.launchOverrides.tabVisibility
  }
  if (options.profileDefinition && options.preparedTabs) {
    for (const prepared of options.preparedTabs) {
      prepared.initialEditorMode ??= launchAppearance.initialEditorMode
    }
  }
  if (options.provisional) {
    launchAppearance.launchTransition.enabled = false
  }
  const launchRendererUrl = rendererUrl(launchAppearance)
  const launchWindowsTitleBarOverlay =
    process.platform === "win32"
      ? windowsTitleBarOverlay(
          windowForegroundColor(launchAppearance),
          launchAppearance.zoomFactor
        )
      : null
  const platformOptions: BrowserWindowConstructorOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hidden",
          trafficLightPosition: macWindowButtonPosition(
            launchAppearance.zoomFactor
          ),
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: launchWindowsTitleBarOverlay!,
          }
        : {
            frame: false,
            icon: app.isPackaged
              ? path.join(process.resourcesPath, "icons", "pulse-md.png")
              : path.join(
                  app.getAppPath(),
                  "build",
                  "icons",
                  "linux",
                  "512x512.png"
                ),
          }
  const browserWindowCreateStartedEpochMs = launchBenchmarkEpochMs()
  const win = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: PRODUCT_NAME,
    show: false,
    resizable: true,
    // The Windows compositor target sits behind Chromium without making the
    // HWND transparent, preserving WCO maximize, Snap, and native resizing.
    transparent: process.platform === "darwin",
    backgroundColor: windowBackgroundColor(launchAppearance),
    // Windows uses the renderer access strip for bare Alt. Keep Electron's
    // hidden native bar from competing for that key while retaining the
    // application Menu as the source of submenu actions and accelerators.
    autoHideMenuBar: process.platform === "linux",
    ...(options.position
      ? { x: Math.round(options.position.x), y: Math.round(options.position.y) }
      : {}),
    ...platformOptions,
    webPreferences: {
      backgroundThrottling: WINDOW_BACKGROUND_THROTTLING_ENABLED,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep each renderer capable of spellchecking so the session-level
      // setting can be turned back on without recreating the window.
      spellcheck: true,
      webviewTag: false,
      zoomFactor: launchAppearance.zoomFactor,
    },
  })
  const browserWindowCreatedEpochMs = launchBenchmarkEpochMs()
  const windowsNativeWindowHandle =
    process.platform === "win32"
      ? Buffer.from(win.getNativeWindowHandle())
      : null
  const windowsNativeWindowOwnerId =
    process.platform === "win32" ? win.id : null
  if (windowsNativeWindowHandle && windowsNativeWindowOwnerId !== null) {
    // `BrowserWindow.destroy()` skips Electron's `close` event. Release the
    // target from the native destruction boundary while the HWND still has its
    // original identity; `closed` keeps an idempotent fallback for teardown
    // paths that do not deliver this message hook.
    win.hookWindowMessage(WINDOWS_WM_DESTROY, () => {
      releaseWindowsWindowBackgroundEffect(
        windowsNativeWindowHandle,
        windowsNativeWindowOwnerId
      )
    })
  }

  let tabIds: TabId[]
  if (options.existingTab) {
    const tab = tabStates.get(options.existingTab.tabId)
    if (!tab) {
      win.destroy()
      return null
    }
    tabIds = [tab.id]
  } else if (options.preparedTabs?.length) {
    tabIds = options.preparedTabs.map(
      (prepared) =>
        createTabState(
          win.id,
          cloneDocument(prepared.document),
          prepared.contentHash,
          prepared.ioPath,
          {
            backing: prepared.backing,
            ...(prepared.color ? { color: prepared.color } : {}),
            diskFingerprint: prepared.diskFingerprint,
            dirty: prepared.dirty,
            ...(prepared.fileMissing !== undefined
              ? { fileMissing: prepared.fileMissing }
              : {}),
            ...(prepared.profileOrigin
              ? { profileOrigin: prepared.profileOrigin }
              : {}),
            ...(prepared.scratchIdentity
              ? { scratchIdentity: prepared.scratchIdentity }
              : {}),
            ...(prepared.title ? { title: prepared.title } : {}),
          }
        ).id
    )
  } else {
    const sources = options.filePaths?.length
      ? options.filePaths.map((filePath) => filePath)
      : [undefined]
    tabIds = sources.map((source) => {
      if (!source) return createTabState(win.id).id
      const displayPath = path.resolve(source)
      return createTabState(
        win.id,
        {
          ...createEmptyDocument(),
          displayName: path.basename(displayPath),
          filePath: displayPath,
          kind: documentKindForPath(displayPath),
        },
        null,
        displayPath,
        { backing: "file", fileMissing: false }
      ).id
    })
  }

  const initialActiveTabId =
    tabIds[Math.min(Math.max(0, options.activeIndex ?? 0), tabIds.length - 1)]!
  const state: WindowState = {
    activeTabId: initialActiveTabId,
    allowClose: false,
    appliedBackgroundBlurAnimationActive: false,
    appliedBackgroundEffectSignature: null,
    appliedBackgroundBlurRadius: 0,
    appliedWindowsAlphaBootstrap: false,
    appliedWindowsTitleBarOverlaySignature: launchWindowsTitleBarOverlay
      ? windowsTitleBarOverlaySignature(launchWindowsTitleBarOverlay)
      : null,
    appearancePreview: null,
    approvedTabCloses: new Map(),
    bootstrapPending: true,
    closeSequence: null,
    editorCommandDrainActive: false,
    editorCommandHandlingReady: false,
    editorMenuState: {
      canRedo: false,
      canUndo: false,
      documentKind:
        tabStates.get(initialActiveTabId)?.document.kind ?? "markdown",
      editorFocused: false,
      hasSelection: false,
      mode: launchAppearance.initialEditorMode,
      settingsDialogOpen: false,
      settingsWorkspaceOpen: false,
      softwareLicensesOpen: false,
    },
    editorReady: false,
    editorReadyWaiters: new Set(),
    eagerLaunchVisualEffectApplied: false,
    launchSettings: cloneAppSettings(launchAppearance),
    launchVisualBenchmark: launchVisualMode
      ? {
          browserWindowCreatedEpochMs,
          browserWindowCreateStartedEpochMs,
          editorReadyEpochMs: null,
          emitted: false,
          mode: launchVisualMode,
          showRequestedEpochMs: null,
          shownEpochMs: null,
          visualEffectApplied: null,
          visualEffectReadyEpochMs: null,
          visualEffectStartedEpochMs: null,
        }
      : null,
    launchOverrides: { ...options.launchOverrides },
    lineWrapping: launchAppearance.lineWrapping,
    pendingLaunchVisualEffect: null,
    pendingWindowVisualEffectTask: null,
    pendingEditorCommands: [],
    pendingCloseSave: null,
    pendingWindowClosePreparation: null,
    pathCompletionGeneration: 0,
    scratchInventoryGenerations: new Map(),
    profileId: options.profileDefinition?.id ?? null,
    profileInheritedEditorMode: options.profileDefinition
      ? launchAppearance.initialEditorMode
      : null,
    profileLaunchDefinition: options.profileDefinition ?? null,
    provisional: options.provisional === true,
    recoveryInProgress: false,
    recoverySurfaceActive: false,
    rememberWhenClosed: false,
    rendererReady: false,
    tabMutationExternalRefreshTabIds: new Set(),
    tabMutationLocked: false,
    tabMutationMetadataChanged: false,
    tabMutationWaiters: new Set(),
    tabHydrations: new Map(),
    tabIds,
    trustedRendererLocation: trustedRendererLocation(launchRendererUrl),
    visualEffectRevision: 0,
    win,
    windowsMenuActions: new Map(),
  }
  windowStates.set(win.id, state)
  win.webContents.on("context-menu", (_event, params) => {
    if (
      win.isDestroyed() ||
      state.recoverySurfaceActive ||
      windowStates.get(win.id) !== state
    ) {
      return
    }
    const misspelledWord = isSpellingToken(params.misspelledWord)
      ? params.misspelledWord
      : ""
    const dictionarySuggestions = misspelledWord
      ? [
          ...new Set(
            params.dictionarySuggestions
              .filter(
                (suggestion) =>
                  suggestion.length > 0 &&
                  suggestion.length <= MAX_SPELLING_WORD_LENGTH
              )
              .slice(0, MAX_SPELLING_SUGGESTION_COUNT)
          ),
        ]
      : []
    const details: EditorContextMenuDetails = {
      dictionarySuggestions,
      editFlags: {
        canCopy: params.editFlags.canCopy,
        canCut: params.editFlags.canCut,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
      misspelledWord,
      x: params.x,
      y: params.y,
    }
    win.webContents.send(ipcChannels.editorContextMenu, details)
  })
  if (state.profileId) profileWindows.set(state.profileId, win.id)
  installWindowSecurity(win)
  win.once("show", () => {
    if (state.launchVisualBenchmark?.shownEpochMs === null) {
      state.launchVisualBenchmark.shownEpochMs = launchBenchmarkEpochMs()
    }
  })

  // The native surface is visible before preload or React exists. Intercept
  // New Tab at webContents' earliest input boundary during that interval and
  // prevent the same keystroke from also activating the application-menu
  // accelerator. Once the editor handshake completes, normal renderer/menu
  // keyboard policy resumes unchanged.
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      (input.key === "Escape" || input.key === "Esc")
    ) {
      cancelActiveTabDragsForWindow(win.id)
    }
    if (state.editorReady || input.type !== "keyDown") return
    const primaryModifier =
      process.platform === "darwin"
        ? input.meta && !input.control
        : input.control && !input.meta
    if (
      !primaryModifier ||
      input.alt ||
      input.shift ||
      input.key.toLowerCase() !== "t"
    ) {
      return
    }
    event.preventDefault()
    sendCommand("new-tab", win)
  })

  if (options.existingTab) {
    const tab = tabStates.get(options.existingTab.tabId)
    if (!tab) throw new Error("Detached tab disappeared during window setup")
    registerTabHydration(state, tab.id, async () =>
      bootstrapTab(tab, options.existingTab!.editorSession)
    )
  } else if (options.preparedTabs?.length) {
    state.tabIds.forEach((tabId, index) => {
      const tab = tabStates.get(tabId)
      const prepared = options.preparedTabs![index]
      if (!tab || !prepared) throw new Error("Initial tab disappeared")
      registerPreparedTabHydration(state, win, tab, prepared)
    })
  } else {
    const sources = options.filePaths?.length
      ? options.filePaths.map((filePath) => filePath)
      : [undefined]
    state.tabIds.forEach((tabId, index) => {
      const tab = tabStates.get(tabId)
      if (!tab) throw new Error("Initial tab disappeared")
      registerTabHydration(
        state,
        tab.id,
        async (interactive, allowEmptyFallback) => {
          const loaded = await initialDocumentForWindow(
            win,
            sources[index],
            interactive,
            allowEmptyFallback
          )
          if (!loaded || !tabCanHydrateInState(state, tab)) return null
          tab.backing = loaded.document.filePath ? "file" : "untitled"
          tab.document = loaded.document
          tab.diskContentHash = loaded.contentHash
          tab.diskFingerprint = loaded.fingerprint
          tab.fileMissing =
            tab.backing === "file" &&
            loaded.ioPath !== null &&
            loaded.fingerprint === null
          tab.ioPath = loaded.ioPath
          const initialViewport = options.initialViewports?.[index]
          return bootstrapTab(tab, undefined, {
            ...(initialViewport ? { initialViewport } : {}),
          })
        }
      )
    })
  }
  updateWindowNativeDocument(state)

  const sendWindowActivation = (active: boolean) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(ipcChannels.windowActivationChanged, active)
    }
  }
  win.on("focus", () => {
    lastFocusedWindowId = win.id
    updateViewMenuItems(state)
    sendWindowActivation(true)
    verifyActivatedTabDocument(state)
  })
  win.on("blur", () => sendWindowActivation(false))
  win.on("resize", () => rememberWindowSize(win))
  if (process.platform === "darwin") {
    win.on("enter-full-screen", () => refreshMacWindowBackgroundShape(state))
    win.on("leave-full-screen", () => refreshMacWindowBackgroundShape(state))
  }
  if (process.platform !== "darwin") {
    win.on("app-command", (event, command) => {
      const navigationCommand =
        command === "browser-backward"
          ? "navigate-back"
          : command === "browser-forward"
            ? "navigate-forward"
            : null
      if (!navigationCommand) return
      event.preventDefault()
      sendCommand(navigationCommand, win)
    })
  }

  if (process.platform !== "darwin") {
    win.setAutoHideMenuBar(process.platform === "linux")
    win.setMenuBarVisibility(false)
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    positionNativeWindowButtons(win)
    win.webContents.on("zoom-changed", () => {
      setImmediate(() => {
        positionNativeWindowButtons(win)
        if (BrowserWindow.getFocusedWindow()?.id === win.id) {
          updateViewMenuItems(state)
        }
      })
    })
  }

  if (process.platform === "win32") {
    win.on("query-session-end", (event) => {
      if (
        !windowsSessionEndRequiresQuitTransaction(
          allowApplicationQuit,
          state.allowClose
        )
      ) {
        return
      }
      // Windows does not emit app.before-quit for shutdown, restart, or
      // logout. Hold the session open while the ordinary application-wide
      // close transaction flushes scratch state and resolves dirty tabs.
      event.preventDefault()
      void beginApplicationQuit().catch((error) => {
        console.error("Unable to finish before the Windows session ends", error)
      })
    })
  }

  win.on("close", (event) => {
    queueWindowSizePersistence()
    if (
      state.allowClose ||
      state.recoveryInProgress ||
      state.recoverySurfaceActive
    ) {
      if (process.platform === "win32") {
        const appearance =
          state.appearancePreview ??
          (state.editorReady ? settings : state.launchSettings)
        clearWindowsWindowBackgroundEffect(
          state,
          windowBackgroundColor(appearance)
        )
      }
      return
    }
    event.preventDefault()
    beginWindowClose(state)
  })

  win.webContents.on("render-process-gone", (_event, details) => {
    state.editorReady = false
    updateViewMenuItems(state)
    rejectSettingsScratchSnapshotsForWindow(
      win.id,
      new Error("A scratch-owning editor stopped during export")
    )
    finishPendingCloseSave(state, false)
    finishPendingWindowClosePreparation(state, false)
    finishPendingCliRendererRequestsForWindow(win.id)
    for (const [requestId, pending] of pendingWindowProfilePickers) {
      if (pending.ownerWindowId === win.id) {
        finishPendingWindowProfilePicker(requestId, null)
      }
    }
    if (state.allowClose || win.isDestroyed()) return
    void showWindowRecoverySurface(
      state,
      "crash",
      new Error(`Renderer process ended: ${details.reason}`)
    )
  })

  win.webContents.once("destroyed", () => {
    retireWindowVisualEffects(state)
  })

  win.on("closed", () => {
    if (windowsNativeWindowHandle && windowsNativeWindowOwnerId !== null) {
      releaseWindowsWindowBackgroundEffect(
        windowsNativeWindowHandle,
        windowsNativeWindowOwnerId
      )
    }
    retireWindowVisualEffects(state)
    releaseSettingsSessionForWindow(win.id)
    pendingExternalScratchActivations.delete(win.id)
    rejectSettingsScratchSnapshotsForWindow(
      win.id,
      new Error("A scratch-owning window closed during export")
    )
    unlockTabMutation(state)
    state.bootstrapPending = false
    state.tabHydrations.clear()
    for (const resolve of state.editorReadyWaiters) resolve()
    state.editorReadyWaiters.clear()
    finishPendingCloseSave(state, false)
    finishPendingWindowClosePreparation(state, false)
    finishPendingCliRendererRequestsForWindow(win.id)
    for (const [requestId, pending] of pendingWindowProfilePickers) {
      if (pending.ownerWindowId === win.id) {
        finishPendingWindowProfilePicker(requestId, null)
      }
    }
    for (const [requestId, pending] of pendingEditorCommandAcknowledgements) {
      if (pending.ownerWindowId === win.id) {
        finishPendingEditorCommand(requestId, false)
      }
    }
    abortTransfersForWindow(win.id)
    for (const tabId of state.tabIds) {
      const tab = tabStates.get(tabId)
      if (!tab || tab.ownerWindowId !== win.id) continue
      if (state.rememberWhenClosed) rememberClosedDocument(tab)
      disposeTabState(tab)
    }
    windowStates.delete(win.id)
    backgroundRenderingLeaseCounts.delete(win.id)
    if (state.profileId && profileWindows.get(state.profileId) === win.id) {
      profileWindows.delete(state.profileId)
    }
    if (lastFocusedWindowId === win.id) lastFocusedWindowId = null
    updateViewMenuItems()
  })

  try {
    const rendererLoad = loadRenderer(win, launchRendererUrl)
    // Explicit benchmark modes stay isolated from the production default so
    // opaque and deferred samples retain their original launch paths.
    if (usesEagerLaunchVisualEffect(state, launchAppearance)) {
      applyPreEditorLaunchVisualEffect(state, launchAppearance)
    }
    options.onCreated?.(win, state)
    // The launch surface is now settled: either the themed native backing is
    // still present or eager translucency is installed. Show it while Chromium
    // loads; yield once so the custom protocol can begin serving navigation.
    const showWindow = () => {
      if (!win.isDestroyed()) {
        if (state.launchVisualBenchmark) {
          state.launchVisualBenchmark.showRequestedEpochMs =
            launchBenchmarkEpochMs()
        }
        win.show()
      }
    }
    const windowShow =
      options.showAfterLoad === false
        ? null
        : new Promise<void>((resolve) => {
            setImmediate(() => {
              showWindow()
              resolve()
            })
          })
    await rendererLoad
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      // Viewport metadata is parsed after the preload runs and can replace
      // page-scale limits set there, so enable visual pinch zoom only after
      // navigation has completed.
      await win.webContents.setVisualZoomLevelLimits(
        MIN_VISUAL_ZOOM_SCALE,
        MAX_VISUAL_ZOOM_SCALE
      )
    }
    await windowShow
    if (win.isDestroyed()) return null
    state.rememberWhenClosed = !state.provisional
  } catch (error) {
    if (!win.isDestroyed()) {
      if (
        !state.provisional &&
        (await showWindowRecoverySurface(state, "bootstrap", error))
      ) {
        state.rememberWhenClosed = true
        return win
      }
      win.destroy()
    }
    return null
  }

  return win
}

async function configuredDefaultWindowProfile(): Promise<ProfileSchemaV2 | null> {
  const profileId = (await currentSettings()).defaultWindowProfileId
  if (!profileId) return null
  try {
    return await profileStore.read(profileId)
  } catch (error) {
    console.warn(
      `Default window profile ${profileId} is unavailable; using a blank window`,
      error
    )
    if (missingProfileError(error, profileId)) {
      await commitApplicationSettings(
        (current) => ({ ...current, defaultWindowProfileId: null }),
        null
      ).catch(() => undefined)
    }
    return null
  }
}

async function routeLaunchIntent(
  intent: LaunchIntent,
  prefetchedDefaultProfile?: Promise<ProfileSchemaV2 | null>
): Promise<void> {
  if (applicationPersistenceQuiescing) {
    pendingLaunchIntents.push(intent)
    return
  }
  restoreForegroundActivationPolicy()
  if (activationWindowRequest) {
    clearImmediate(activationWindowRequest)
    activationWindowRequest = null
  }
  pendingLaunchWindowCount += 1
  try {
    const windowSize = { ...rememberedWindowSize }
    const position =
      process.platform === "darwin"
        ? centeredWindowPosition(
            screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
              .workArea,
            windowSize
          )
        : undefined
    if (intent.kind === "open-scratch") {
      await serializeManagedResourceOperation(async () => {
        try {
          const existing = openScratchTab(intent.scratchId)
          if (existing) {
            if (queueExternalScratchActivation(existing, intent.fragment)) {
              return
            }
            const existingState = linkedTabState(existing)
            if (!existingState) {
              throw new Error(
                "The scratch is open in a window that is currently busy"
              )
            }
            activateTabInState(existingState, existing.id)
            sendTabsChanged(existingState)
            if (existingState.win.isMinimized()) existingState.win.restore()
            existingState.win.show()
            existingState.win.focus()
            existingState.win.webContents.send(
              ipcChannels.openExistingLocalLinkRequested,
              {
                fragment: intent.fragment,
                tabId: existing.id,
              } satisfies OpenExistingLocalLinkRequest
            )
            await scratchStore.markOpened(intent.scratchId)
            return
          }

          const prepared = await preparedScratchTab(intent.scratchId)
          const win = await createDocumentWindow({
            preparedTabs: [prepared],
            ...(position ? { position } : {}),
            size: windowSize,
          })
          if (!win) return
          const state = windowStates.get(win.id)
          if (state && (await waitForEditorReady(state))) {
            state.win.webContents.send(
              ipcChannels.openExistingLocalLinkRequested,
              {
                fragment: intent.fragment,
                tabId: state.activeTabId,
              } satisfies OpenExistingLocalLinkRequest
            )
          }
        } catch (error) {
          dialog.showErrorBox(
            "Open Scratch Failed",
            error instanceof Error ? error.message : String(error)
          )
        }
      })
      return
    }
    if (intent.filePaths.length === 0) {
      const openedDefaultProfile = await serializeManagedResourceOperation(
        async () => {
          const defaultProfile = await (prefetchedDefaultProfile ??
            configuredDefaultWindowProfile())
          if (!defaultProfile) return false
          const existingWindowId = profileWindows.get(defaultProfile.id)
          const existingState =
            existingWindowId === undefined
              ? undefined
              : windowStates.get(existingWindowId)
          if (existingState && !existingState.win.isDestroyed()) {
            try {
              ensureWindowMutable(existingState)
              if (existingState.win.isMinimized()) existingState.win.restore()
              existingState.win.show()
              existingState.win.focus()
              return true
            } catch (error) {
              console.warn(
                `Default window profile ${defaultProfile.id} is closing; using a blank window`,
                error
              )
              return false
            }
          }
          if (existingWindowId !== undefined) {
            profileWindows.delete(defaultProfile.id)
          }
          try {
            const prepared = await prepareWindowProfile(defaultProfile)
            await createWindowProfileWindow(prepared, {
              focusEditor: false,
              ...(position ? { position } : {}),
            })
            return true
          } catch (error) {
            console.warn(
              `Unable to launch default window profile ${defaultProfile.id}; using a blank window`,
              error
            )
            return false
          }
        }
      )
      if (openedDefaultProfile) return
    }
    await createDocumentWindow({
      filePaths: [...intent.filePaths],
      ...(position ? { position } : {}),
      size: windowSize,
    })
  } finally {
    pendingLaunchWindowCount -= 1
  }
}

function cliWindowPosition(
  windowSize: WindowSize,
  placement: CliWindowPlacement,
  activeWindowBounds: CliActiveWindowBounds | null
) {
  const activeWindowIsOnConnectedDisplay =
    activeWindowBounds !== null &&
    screen
      .getAllDisplays()
      .some((display) =>
        rectanglesIntersect(activeWindowBounds, display.bounds)
      )
  const displaySelection = cliWindowDisplaySelection(
    process.platform,
    placement,
    activeWindowIsOnConnectedDisplay
  )
  if (displaySelection === null) return undefined
  const display =
    displaySelection === "active-window"
      ? screen.getDisplayMatching(activeWindowBounds!)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return centeredWindowPosition(display.workArea, windowSize)
}

async function createCliWindow(
  preparedTabs: PreparedTab[],
  options: {
    activeIndex: number
    activeWindowBounds: CliActiveWindowBounds | null
    editorMode?: EditorMode
    profileDefinition?: ProfileSchemaV2
    tabVisibility?: TabVisibilityMode
    windowPlacement: CliWindowPlacement
  }
): Promise<WindowState> {
  const windowSize = { ...rememberedWindowSize }
  const position = cliWindowPosition(
    windowSize,
    options.windowPlacement,
    options.activeWindowBounds
  )
  const win = await createDocumentWindow({
    activeIndex: options.activeIndex,
    launchOverrides: {
      ...(options.editorMode ? { editorMode: options.editorMode } : {}),
      ...(options.tabVisibility
        ? { tabVisibility: options.tabVisibility }
        : {}),
    },
    ...(position ? { position } : {}),
    preparedTabs,
    ...(options.profileDefinition
      ? { profileDefinition: options.profileDefinition }
      : {}),
    size: windowSize,
  })
  const state = win ? windowStates.get(win.id) : undefined
  if (!win || !state) throw new Error("The editor window could not be created")
  if (!(await waitForEditorReady(state))) {
    if (!win.isDestroyed()) win.destroy()
    throw new Error("The editor did not become ready in time")
  }
  if (!(await focusCliEditor(state, state.activeTabId))) {
    if (!win.isDestroyed()) win.destroy()
    throw new Error("The editor could not establish keyboard focus")
  }
  return state
}

function assertNoDuplicatePreparedTabs(
  preparedTabs: readonly PreparedTab[],
  allowDuplicateFiles = false
) {
  const identities = new Map<string, number>()
  for (let index = 0; index < preparedTabs.length; index += 1) {
    const tab = preparedTabs[index]!
    if (allowDuplicateFiles && tab.backing === "file") continue
    const identity = tab.scratchIdentity
      ? `scratch:${tab.scratchIdentity.scratchId}`
      : tab.ioPath
        ? `file:${tab.ioPath}`
        : null
    if (!identity) continue
    const previousIndex = identities.get(identity)
    if (previousIndex !== undefined) {
      throw new Error(
        `Requested tabs ${previousIndex + 1} and ${index + 1} refer to the same document`
      )
    }
    identities.set(identity, index)
  }
}

interface PreparedWindowProfile {
  activeIndex: number
  preparedTabs: PreparedTab[]
  profile: ProfileSchemaV2
}

async function prepareWindowProfile(
  profileOrId: ProfileSchemaV2 | string
): Promise<PreparedWindowProfile> {
  const profile =
    typeof profileOrId === "string"
      ? await profileStore.read(profileOrId)
      : profileOrId
  const activeIndex = profile.tabs.findIndex(
    (tab) => tab.id === profile.activeTab
  )
  if (activeIndex < 0) {
    throw new Error(`Profile ${profile.id} has no active tab`)
  }
  // File aliases can be introduced after a profile is saved (for example by
  // replacing one path with a hard link), so revalidate every readable path
  // at launch. An inaccessible inactive leaf remains isolated to its eventual
  // hydration request instead of preventing the active document from opening.
  await validateProfileFileIdentities(profile, {
    ignoreUnreadableTabIndexes: new Set(
      profile.tabs.flatMap((_tab, index) =>
        index === activeIndex ? [] : [index]
      )
    ),
  })
  for (const tab of profile.tabs) {
    if (tab.kind !== "scratch") continue
    if (openScratchTab(tab.scratchId)) {
      throw new Error(
        `Scratch document ${tab.scratchId} is already open outside its profile window`
      )
    }
  }
  const preparedTabs = profile.tabs.map((tab) =>
    deferredProfileTab(profile, tab)
  )
  preparedTabs[activeIndex] = await preparedProfileTab(
    profile,
    profile.tabs[activeIndex]!
  )
  assertNoDuplicatePreparedTabs(preparedTabs)
  return {
    activeIndex,
    preparedTabs,
    profile,
  }
}

function windowProfileLaunchOverrides(profile: ProfileSchemaV2) {
  return {
    ...(profile.mode ? { editorMode: profile.mode } : {}),
    ...(profile.tabVisibility !== "inherit"
      ? { tabVisibility: profile.tabVisibility }
      : {}),
  }
}

async function focusExistingWindowProfile(profileId: string): Promise<boolean> {
  const windowId = profileWindows.get(profileId)
  const state = windowId === undefined ? undefined : windowStates.get(windowId)
  if (!state || state.win.isDestroyed()) {
    profileWindows.delete(profileId)
    return false
  }
  ensureWindowMutable(state)
  if (!(await waitForEditorReady(state))) {
    throw new Error("The profile window did not become ready in time")
  }
  if (!(await focusCliEditor(state, state.activeTabId))) {
    throw new Error(
      "The profile window is busy; close its dialog or active operation and try again"
    )
  }
  return true
}

async function createWindowProfileWindow(
  prepared: PreparedWindowProfile,
  options: {
    focusEditor: boolean
    position?: { x: number; y: number }
  }
): Promise<WindowState> {
  const win = await createDocumentWindow({
    activeIndex: prepared.activeIndex,
    launchOverrides: windowProfileLaunchOverrides(prepared.profile),
    ...(options.position ? { position: options.position } : {}),
    preparedTabs: prepared.preparedTabs,
    profileDefinition: prepared.profile,
    size: { ...rememberedWindowSize },
  })
  const state = win ? windowStates.get(win.id) : undefined
  if (!win || !state) throw new Error("The profile window could not be created")
  if (options.focusEditor) {
    if (!(await waitForEditorReady(state))) {
      if (!win.isDestroyed()) win.destroy()
      throw new Error("The profile window did not become ready in time")
    }
    if (!(await focusCliEditor(state, state.activeTabId))) {
      if (!win.isDestroyed()) win.destroy()
      throw new Error("The profile window could not establish keyboard focus")
    }
  }
  return state
}

function currentWindowProfileSeed(
  state: WindowState,
  value: unknown,
  rawKind: unknown
): WindowProfileSeed {
  if (!Array.isArray(value) || value.length !== state.tabIds.length) {
    throw new TypeError("Current-window tab modes must cover every tab")
  }
  if (rawKind !== "create" && rawKind !== "update") {
    throw new TypeError("Invalid window-profile capture kind")
  }
  const kind: WindowProfileCaptureKind = rawKind
  const modes: WindowProfileTabMode[] = []
  const seenModeTabIds = new Set<TabId>()
  for (const rawMode of value) {
    if (
      typeof rawMode !== "object" ||
      rawMode === null ||
      Array.isArray(rawMode)
    ) {
      throw new TypeError("Invalid current-window tab mode")
    }
    const keys = Object.keys(rawMode)
    const { mode, tabId } = rawMode as Partial<WindowProfileTabMode>
    if (
      keys.length !== 2 ||
      !keys.includes("mode") ||
      !keys.includes("tabId") ||
      typeof tabId !== "string" ||
      !isEditorMode(mode) ||
      seenModeTabIds.has(tabId)
    ) {
      throw new TypeError("Invalid current-window tab mode")
    }
    seenModeTabIds.add(tabId)
    modes.push({
      mode: state.tabHydrations.get(tabId)?.initialEditorMode ?? mode,
      tabId,
    })
  }
  if (state.tabIds.some((tabId) => !seenModeTabIds.has(tabId))) {
    throw new TypeError("Current-window tab modes do not match this window")
  }
  if (kind === "update" && !state.profileLaunchDefinition) {
    throw new Error("This window was not launched from a profile")
  }
  if (kind === "update" && !state.profileInheritedEditorMode) {
    throw new Error("This window has no profile launch mode")
  }

  const tabs = state.tabIds.map((tabId): CurrentWindowProfileTab => {
    const tab = tabStates.get(tabId)
    if (!tab || tab.ownerWindowId !== state.win.id) {
      throw new Error("A current-window tab disappeared")
    }
    return {
      backing: tab.backing,
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.color ? { color: tab.color } : {}),
      displayName: tab.document.displayName,
      filePath: tab.document.filePath,
      ...(tab.profileOrigin ? { origin: { ...tab.profileOrigin } } : {}),
      runtimeTabId: tab.id,
      ...(tab.scratchIdentity
        ? { scratch: { scratchId: tab.scratchIdentity.scratchId } }
        : {}),
    }
  })

  return captureWindowProfileSeed({
    activeRuntimeTabId: state.activeTabId,
    // This is the effective inherited mode at the profile launch/replacement
    // boundary. It deliberately does not follow later global Settings changes.
    inheritedEditorMode:
      state.profileInheritedEditorMode ??
      state.launchSettings.initialEditorMode,
    kind,
    ...(state.profileLaunchDefinition
      ? { originalProfile: state.profileLaunchDefinition }
      : {}),
    tabModes: modes,
    tabs,
  })
}

class SettingsScratchSnapshotInvalidatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsScratchSnapshotInvalidatedError"
  }
}

function settingsScratchSnapshotTargets(): SettingsScratchSnapshotTarget[] {
  return [...tabStates.values()]
    .flatMap((tab): SettingsScratchSnapshotTarget[] => {
      if (tab.backing !== "scratch") return []
      if (!tab.scratchIdentity) {
        throw new Error(`Scratch tab ${tab.id} has no durable identity`)
      }
      const state = windowStates.get(tab.ownerWindowId)
      if (
        !state ||
        state.win.isDestroyed() ||
        state.win.webContents.isDestroyed() ||
        !state.tabIds.includes(tab.id)
      ) {
        throw new SettingsScratchSnapshotInvalidatedError(
          `Scratch tab ${tab.id} changed owners while export was starting`
        )
      }
      return [
        {
          ownerWindowId: tab.ownerWindowId,
          runtimeTabId: tab.id,
          scratchId: tab.scratchIdentity.scratchId,
        },
      ]
    })
    .sort((left, right) => left.runtimeTabId.localeCompare(right.runtimeTabId))
}

function settingsScratchTargetStillOwned(
  target: SettingsScratchSnapshotTarget
): boolean {
  const tab = tabStates.get(target.runtimeTabId)
  const state = windowStates.get(target.ownerWindowId)
  return Boolean(
    tab &&
    state &&
    !state.win.isDestroyed() &&
    !state.win.webContents.isDestroyed() &&
    state.tabIds.includes(target.runtimeTabId) &&
    tab.backing === "scratch" &&
    tab.ownerWindowId === target.ownerWindowId &&
    tab.scratchIdentity?.scratchId === target.scratchId
  )
}

function settingsScratchSnapshotTargetsMatch(
  expected: readonly SettingsScratchSnapshotTarget[]
): boolean {
  let current: SettingsScratchSnapshotTarget[]
  try {
    current = settingsScratchSnapshotTargets()
  } catch {
    return false
  }
  return (
    current.length === expected.length &&
    current.every((target, index) => {
      const other = expected[index]
      return (
        other?.ownerWindowId === target.ownerWindowId &&
        other.runtimeTabId === target.runtimeTabId &&
        other.scratchId === target.scratchId
      )
    })
  )
}

function resolveSettingsScratchSnapshot(
  requestId: string,
  scratches: SettingsScratchContentSnapshot[]
): void {
  const pending = pendingSettingsScratchSnapshots.get(requestId)
  if (!pending) return
  pendingSettingsScratchSnapshots.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(scratches)
}

function rejectSettingsScratchSnapshot(requestId: string, error: Error): void {
  const pending = pendingSettingsScratchSnapshots.get(requestId)
  if (!pending) return
  pendingSettingsScratchSnapshots.delete(requestId)
  clearTimeout(pending.timeout)
  pending.reject(error)
}

function rejectSettingsScratchSnapshotsForWindow(
  ownerWindowId: WindowId,
  error: Error
): void {
  for (const [requestId, pending] of pendingSettingsScratchSnapshots) {
    if (pending.ownerWindowId === ownerWindowId) {
      rejectSettingsScratchSnapshot(requestId, error)
    }
  }
}

async function requestSettingsScratchSnapshot(
  targets: readonly SettingsScratchSnapshotTarget[],
  maximumBytes: number
): Promise<SettingsScratchContentSnapshot[]> {
  const ownerWindowId = targets[0]?.ownerWindowId
  if (
    ownerWindowId === undefined ||
    targets.some((target) => target.ownerWindowId !== ownerWindowId)
  ) {
    throw new TypeError("A scratch snapshot request must have one owner")
  }
  const state = windowStates.get(ownerWindowId)
  if (!state || !(await waitForEditorReady(state))) {
    throw new Error("A scratch-owning editor is not available for export")
  }
  if (targets.some((target) => !settingsScratchTargetStillOwned(target))) {
    throw new SettingsScratchSnapshotInvalidatedError(
      "Scratch ownership changed while export was starting"
    )
  }

  const requestId = randomUUID()
  const expectedTargets = new Map(
    targets.map((target) => [target.runtimeTabId, target] as const)
  )
  if (expectedTargets.size !== targets.length) {
    throw new TypeError("A scratch snapshot request contains duplicate tabs")
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("A scratch snapshot request has an invalid byte limit")
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        rejectSettingsScratchSnapshot(
          requestId,
          new Error("A scratch-owning editor did not respond during export")
        ),
      SETTINGS_SCRATCH_SNAPSHOT_TIMEOUT_MS
    )
    timeout.unref()
    pendingSettingsScratchSnapshots.set(requestId, {
      expectedTargets,
      maximumBytes,
      ownerWindowId,
      reject,
      resolve,
      timeout,
    })
    try {
      state.win.webContents.send(ipcChannels.settingsScratchSnapshotRequested, {
        maximumContentBytes: maximumBytes,
        requestId,
        tabIds: targets.map((target) => target.runtimeTabId),
      })
    } catch (error) {
      rejectSettingsScratchSnapshot(
        requestId,
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
}

async function snapshotOpenScratchEditors(
  maximumBytes: number
): Promise<SettingsScratchContentSnapshot[]> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("Invalid scratch export byte limit")
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let targets: SettingsScratchSnapshotTarget[]
    try {
      targets = settingsScratchSnapshotTargets()
    } catch (error) {
      if (
        error instanceof SettingsScratchSnapshotInvalidatedError &&
        attempt < 2
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        continue
      }
      throw error
    }
    if (targets.length === 0) return []

    const targetsByOwner = new Map<WindowId, SettingsScratchSnapshotTarget[]>()
    for (const target of targets) {
      const ownerTargets = targetsByOwner.get(target.ownerWindowId) ?? []
      ownerTargets.push(target)
      targetsByOwner.set(target.ownerWindowId, ownerTargets)
    }
    const scratches: SettingsScratchContentSnapshot[] = []
    let contentBytes = 0
    try {
      for (const ownerTargets of targetsByOwner.values()) {
        const response = await requestSettingsScratchSnapshot(
          ownerTargets,
          maximumBytes - contentBytes
        )
        for (const scratch of response) {
          contentBytes += scratch.content.byteLength
          if (contentBytes > maximumBytes) {
            throw new TypeError("The settings transfer is too large to export")
          }
          scratches.push(scratch)
        }
      }
    } catch (error) {
      if (
        error instanceof SettingsScratchSnapshotInvalidatedError &&
        attempt < 2
      ) {
        continue
      }
      throw error
    }
    if (!settingsScratchSnapshotTargetsMatch(targets)) {
      if (attempt < 2) continue
      throw new Error("Scratch ownership kept changing during export")
    }
    return scratches
  }
  throw new Error("Unable to capture the open scratches for export")
}

async function settingsExportResources(
  options: SettingsTransferOptions
): Promise<{
  profiles: ProfileSchemaV2[] | undefined
  scratches: SettingsArchiveScratchInput[] | undefined
}> {
  return serializeManagedResourceOperation(async () => {
    const profiles = options.profiles
      ? await profileStore.listBounded(
          MAX_SETTINGS_TRANSFER_BYTES,
          MAX_SETTINGS_TRANSFER_PROFILES
        )
      : undefined
    let scratches: SettingsArchiveScratchInput[] | undefined
    if (options.scratches) {
      const openScratches = await snapshotOpenScratchEditors(
        MAX_SETTINGS_TRANSFER_BYTES
      )
      const openScratchesById = new Map<
        string,
        SettingsScratchContentSnapshot
      >()
      for (const scratch of openScratches) {
        if (openScratchesById.has(scratch.scratchId)) {
          throw new Error(`Scratch ${scratch.scratchId} is open more than once`)
        }
        openScratchesById.set(scratch.scratchId, scratch)
      }
      const inventory = await scratchStore.list()
      if (inventory.length > MAX_SETTINGS_ARCHIVE_SCRATCHES) {
        throw new TypeError("The settings transfer contains too many scratches")
      }
      let scratchBytes = 0
      scratches = []
      for (const entry of inventory) {
        const openScratch = openScratchesById.get(entry.id)
        let content: Buffer
        let modifiedAt: number
        if (openScratch) {
          content = openScratch.content
          modifiedAt = openScratch.modifiedAt
          openScratchesById.delete(entry.id)
        } else {
          let stable: StableFileBytes
          try {
            stable = await readStableFileBytes(
              entry.path,
              MAX_SETTINGS_TRANSFER_BYTES - scratchBytes
            )
          } catch (error) {
            if (
              error instanceof TypeError &&
              error.message === "The selected file is too large"
            ) {
              throw new TypeError(
                "The settings transfer is too large to export",
                { cause: error }
              )
            }
            throw error
          }
          content = stable.buffer
          modifiedAt = Math.trunc(stable.fingerprint.mtimeMs)
        }
        scratchBytes += content.byteLength
        if (scratchBytes > MAX_SETTINGS_TRANSFER_BYTES) {
          throw new TypeError("The settings transfer is too large to export")
        }
        scratches.push({
          content,
          createdAt: entry.createdAt,
          fileName: entry.fileName,
          id: entry.id,
          lastOpenedAt: entry.lastOpenedAt,
          modifiedAt,
          title: entry.title ?? null,
        })
      }
      if (openScratchesById.size > 0) {
        throw new SettingsScratchSnapshotInvalidatedError(
          "A scratch changed while export was being assembled"
        )
      }
    }
    return { profiles, scratches }
  })
}

async function windowProfilesSnapshot(
  currentProfileId: string | null
): Promise<WindowProfilesSnapshot> {
  const [profiles, persistedSettings] = await Promise.all([
    profileStore.list(),
    currentSettings(),
  ])
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
  let defaultProfileId = persistedSettings.defaultWindowProfileId
  if (defaultProfileId && !profilesById.has(defaultProfileId)) {
    await commitApplicationSettings(
      (current) => ({ ...current, defaultWindowProfileId: null }),
      null
    )
    defaultProfileId = null
  }

  return {
    currentProfileId,
    defaultProfileId,
    profiles: profiles.map((profile) => ({
      open: profileWindows.has(profile.id),
      profile,
    })),
  }
}

async function deleteClosedWindowProfileDefinition(
  profileId: string
): Promise<void> {
  await runProfileDeleteTransaction({
    captureDefinition: () => profileStore.readStoredProfileSnapshot(profileId),
    clearDefaultProfile: async () => {
      await commitApplicationSettings(
        (current) => ({ ...current, defaultWindowProfileId: null }),
        null
      )
    },
    defaultProfileId: async () =>
      (await currentSettings()).defaultWindowProfileId,
    deleteDefinition: () => profileStore.deleteDefinition(profileId),
    profileId,
    profileIsOpen: () => profileWindows.has(profileId),
    restoreDefinition: (snapshot) =>
      profileStore.restoreStoredProfileSnapshot(profileId, snapshot),
  })
}

let scratchInventoryProfileWarningShown = false

async function profilesForScratchInventory(): Promise<{
  profileReferencesAvailable: boolean
  profiles: ProfileSchemaV2[]
}> {
  try {
    const profiles = await profileStore.list()
    scratchInventoryProfileWarningShown = false
    return { profileReferencesAvailable: true, profiles }
  } catch (error) {
    if (!scratchInventoryProfileWarningShown) {
      console.warn(
        "Profile references are unavailable in the scratch inventory",
        error
      )
      scratchInventoryProfileWarningShown = true
    }
    return { profileReferencesAvailable: false, profiles: [] }
  }
}

async function scratchInventory(
  query: string,
  sort: ScratchSortOrder,
  cancelled: () => boolean = () => false
): Promise<ScratchInventory> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const [stored, profileInventory] = await Promise.all([
    scratchStore.listAvailable(terms, { cancelled }),
    profilesForScratchInventory(),
  ])
  const { profileReferencesAvailable, profiles } = profileInventory
  const references = new Map<string, { id: string; name: string }[]>()
  for (const profile of profiles) {
    for (const tab of profile.tabs) {
      if (tab.kind !== "scratch") continue
      const current = references.get(tab.scratchId) ?? []
      if (!current.some(({ id }) => id === profile.id)) {
        current.push({ id: profile.id, name: profile.name })
        references.set(tab.scratchId, current)
      }
    }
  }
  const entries = stored.map((scratch): ScratchEntry => {
    const displayTitle =
      scratch.title ??
      scratch.firstHeading ??
      scratch.fileName.replace(/\.md$/i, "")
    return {
      byteLength: scratch.byteLength,
      createdAt: scratch.createdAt,
      displayTitle,
      excerpt: scratch.excerpt,
      fileName: scratch.fileName,
      firstHeading: scratch.firstHeading,
      lastOpenedAt: scratch.lastOpenedAt,
      modifiedAt: scratch.modifiedAt,
      open: openScratchTabs.has(scratch.id),
      profiles: references.get(scratch.id) ?? [],
      revision: scratch.revision,
      scratchId: scratch.id,
      title: scratch.title ?? null,
    }
  })

  const compareText = (left: string, right: string) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
  const descending = (left: number | null, right: number | null) =>
    (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY)
  entries.sort((left, right) => {
    const primary =
      sort === "last-opened"
        ? descending(left.lastOpenedAt, right.lastOpenedAt)
        : sort === "last-edited"
          ? descending(left.modifiedAt, right.modifiedAt)
          : sort === "created"
            ? descending(left.createdAt, right.createdAt)
            : sort === "title"
              ? compareText(left.displayTitle, right.displayTitle)
              : compareText(left.fileName, right.fileName)
    return (
      primary ||
      compareText(left.fileName, right.fileName) ||
      compareText(left.scratchId, right.scratchId)
    )
  })
  return { entries, profileReferencesAvailable }
}

function isDisposableUntitledTab(
  state: WindowState,
  tab: TabState | undefined
): tab is TabState {
  return Boolean(
    tab &&
    tab.ownerWindowId === state.win.id &&
    tab.backing === "untitled" &&
    !tab.dirty &&
    !tabSaveActive(tab) &&
    tab.document.filePath === null &&
    tab.ioPath === null &&
    tab.title === null &&
    tab.scratchIdentity === null
  )
}

function isDisposableUntitledWindow(state: WindowState): boolean {
  if (state.tabIds.length !== 1 || state.profileId !== null) return false
  return isDisposableUntitledTab(state, tabStates.get(state.tabIds[0]!))
}

async function replaceDisposableWindowWithProfile(
  state: WindowState,
  prepared: PreparedWindowProfile
): Promise<void> {
  ensureWindowMutable(state)
  if (!isDisposableUntitledWindow(state)) {
    throw new Error("The current window is no longer empty")
  }
  if (!state.rendererReady || !state.editorReady) {
    throw new Error("The current window is not ready")
  }
  const inheritedEditorMode =
    prepared.profile.mode ?? (await currentSettings()).initialEditorMode
  for (const tab of prepared.preparedTabs) {
    tab.initialEditorMode ??= inheritedEditorMode
  }
  abortTransfersForWindow(state.win.id)
  state.tabMutationLocked = true
  try {
    if (!(await showAndWaitForCliWindow(state))) {
      throw new Error("The current window could not become active")
    }

    const replacedTabId = state.tabIds[0]!
    const createdTabIds = prepared.preparedTabs.map(
      (tab) =>
        createTabState(
          state.win.id,
          cloneDocument(tab.document),
          tab.contentHash,
          tab.ioPath,
          {
            backing: tab.backing,
            ...(tab.color ? { color: tab.color } : {}),
            diskFingerprint: tab.diskFingerprint,
            dirty: tab.dirty,
            ...(tab.fileMissing !== undefined
              ? { fileMissing: tab.fileMissing }
              : {}),
            ...(tab.profileOrigin ? { profileOrigin: tab.profileOrigin } : {}),
            ...(tab.scratchIdentity
              ? { scratchIdentity: tab.scratchIdentity }
              : {}),
            ...(tab.title ? { title: tab.title } : {}),
          }
        ).id
    )
    const activeTabId = createdTabIds[prepared.activeIndex]!
    state.tabIds.push(...createdTabIds)
    createdTabIds.forEach((tabId, index) => {
      if (tabId === activeTabId) return
      const tab = tabStates.get(tabId)
      const source = prepared.preparedTabs[index]
      if (!tab || !source) throw new Error("A profile tab disappeared")
      registerPreparedTabHydration(state, state.win, tab, source)
    })
    // Publish every lightweight descriptor while the disposable tab remains
    // active. This keeps the renderer from trying to hydrate the new active
    // tab before the transactional replacement request supplies its payload.
    sendTabsChanged(state)
    state.activeTabId = activeTabId
    try {
      const activeTab = tabStates.get(activeTabId)
      const activeSource = prepared.preparedTabs[prepared.activeIndex]
      if (!activeTab || !activeSource || activeSource.deferredLoad) {
        throw new Error("The active profile tab was not prepared")
      }
      const request: CliTabsOpenRequest = {
        requestId: randomUUID(),
        activeTabId,
        ...(prepared.profile.mode ? { editorMode: prepared.profile.mode } : {}),
        replaceTabId: replacedTabId,
        tabs: [
          bootstrapTab(activeTab, undefined, {
            ...(activeSource.initialEditorMode
              ? { initialEditorMode: activeSource.initialEditorMode }
              : {}),
          }),
        ],
      }

      const accepted = await requestRendererOpenCliTabs(
        state,
        request,
        createdTabIds
      )
      if (!accepted) {
        throw new Error(
          "The current window is busy; close its dialog or active operation and try again"
        )
      }

      const membershipUnchanged =
        state.tabIds.length === createdTabIds.length + 1 &&
        state.tabIds[0] === replacedTabId &&
        createdTabIds.every((tabId, index) => state.tabIds[index + 1] === tabId)
      if (!membershipUnchanged) {
        throw new Error("The current window changed during profile replacement")
      }
    } catch (error) {
      state.activeTabId = replacedTabId
      state.tabIds = [replacedTabId]
      for (const tabId of createdTabIds) {
        const tab = tabStates.get(tabId)
        if (tab) disposeTabState(tab)
      }
      if (!state.win.isDestroyed()) {
        updateWindowNativeDocument(state)
        sendTabsChanged(state)
      }
      throw error
    }

    state.tabIds = createdTabIds
    state.launchOverrides = windowProfileLaunchOverrides(prepared.profile)
    state.profileId = prepared.profile.id
    state.profileInheritedEditorMode = inheritedEditorMode
    state.profileLaunchDefinition = prepared.profile
    profileWindows.set(prepared.profile.id, state.win.id)
    const replacedTab = tabStates.get(replacedTabId)
    if (replacedTab) disposeTabState(replacedTab)
    const activeTab = tabStates.get(activeTabId)
    if (activeTab) {
      activeTab.document.content = ""
      watchTabDocument(activeTab)
    }
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    state.win.webContents.send(
      ipcChannels.settingsChanged,
      settingsSnapshotForWindow(state, settings)
    )
  } finally {
    unlockTabMutation(state)
  }
}

async function launchWindowProfileFromState(
  sourceState: WindowState,
  profileId: string,
  requestedPosition?: { x: number; y: number }
): Promise<WindowProfileLaunchResult> {
  if (sourceState.profileId === profileId) {
    ensureWindowMutable(sourceState)
    if (sourceState.win.isMinimized()) sourceState.win.restore()
    sourceState.win.show()
    sourceState.win.focus()
    return "focused-existing"
  }
  if (await focusExistingWindowProfile(profileId)) return "focused-existing"
  const prepared = await prepareWindowProfile(profileId)
  if (isDisposableUntitledWindow(sourceState)) {
    await replaceDisposableWindowWithProfile(sourceState, prepared)
    return "reused-window"
  }

  const windowSize = { ...rememberedWindowSize }
  const position =
    requestedPosition ??
    (process.platform === "darwin"
      ? centeredWindowPosition(
          screen.getDisplayMatching(sourceState.win.getBounds()).workArea,
          windowSize
        )
      : undefined)
  await createWindowProfileWindow(prepared, {
    focusEditor: true,
    ...(position ? { position } : {}),
  })
  return "opened-window"
}

function completeCliOpen(
  state: WindowState,
  wait: boolean,
  responder: CliResponder
): void {
  if (wait) beginCliWait(state.tabIds, responder)
  else responder.accepted()
}

async function focusExistingProfile(
  profileId: string,
  wait: boolean,
  responder: CliResponder
): Promise<boolean> {
  if (!(await focusExistingWindowProfile(profileId))) return false
  const state = windowStates.get(profileWindows.get(profileId)!)
  if (!state) return false
  completeCliOpen(state, wait, responder)
  return true
}

async function processCliProfileOpen(
  command: Extract<CliCommand, { kind: "profile-open" }>,
  activeWindowBounds: CliActiveWindowBounds | null,
  responder: CliResponder
): Promise<void> {
  if (await focusExistingProfile(command.id, command.wait, responder)) return
  const prepared = await prepareWindowProfile(command.id)
  const state = await createCliWindow(prepared.preparedTabs, {
    activeIndex: prepared.activeIndex,
    activeWindowBounds,
    ...(prepared.profile.mode ? { editorMode: prepared.profile.mode } : {}),
    profileDefinition: prepared.profile,
    ...(prepared.profile.tabVisibility !== "inherit"
      ? { tabVisibility: prepared.profile.tabVisibility }
      : {}),
    windowPlacement: command.windowPlacement,
  })
  completeCliOpen(state, command.wait, responder)
}

async function cliProfilePickerHost(
  command: Extract<CliCommand, { kind: "profile-pick" }>,
  activeWindowBounds: CliActiveWindowBounds | null
): Promise<{
  createdForPicker: boolean
  release: () => void
  state: WindowState
}> {
  const focused = BrowserWindow.getFocusedWindow()
  const existing =
    (focused ? windowStates.get(focused.id) : undefined) ??
    (lastFocusedWindowId === null
      ? undefined
      : windowStates.get(lastFocusedWindowId)) ??
    [...windowStates.values()].find(
      (state) => !state.win.isDestroyed() && !state.provisional
    )
  let createdForPicker = false
  const state = (() => {
    if (
      existing &&
      windowStates.get(existing.win.id) === existing &&
      !existing.win.isDestroyed() &&
      !existing.win.webContents.isDestroyed() &&
      !existing.provisional &&
      !existing.bootstrapPending &&
      !existing.closeSequence &&
      !existing.allowClose &&
      !existing.pendingCloseSave &&
      !existing.pendingWindowClosePreparation &&
      !existing.tabMutationLocked &&
      !existing.recoveryInProgress &&
      !existing.recoverySurfaceActive &&
      existing.rendererReady &&
      existing.editorReady &&
      !existing.editorMenuState.settingsDialogOpen &&
      !existing.editorMenuState.settingsWorkspaceOpen &&
      !existing.editorMenuState.softwareLicensesOpen &&
      !windowProfilePickerHostClaims.has(existing.win.id) &&
      ![...pendingWindowProfilePickers.values()].some(
        (pending) => pending.ownerWindowId === existing.win.id
      )
    ) {
      windowProfilePickerHostClaims.add(existing.win.id)
      return Promise.resolve(existing)
    }
    const windowSize = { ...rememberedWindowSize }
    const position = cliWindowPosition(
      windowSize,
      command.windowPlacement,
      activeWindowBounds
    )
    return createDocumentWindow({
      ...(position ? { position } : {}),
      size: windowSize,
    }).then((win) => {
      const createdState = win ? windowStates.get(win.id) : undefined
      if (!createdState) {
        throw new Error("The profile picker window could not be created")
      }
      createdForPicker = true
      windowProfilePickerHostClaims.add(createdState.win.id)
      return createdState
    })
  })()
  let resolvedState: WindowState | null = null
  try {
    resolvedState = await state
    ensureWindowMutable(resolvedState)
    if (!(await waitForEditorReady(resolvedState))) {
      throw new Error("The profile picker window did not become ready in time")
    }
    if (!(await showAndWaitForCliWindow(resolvedState))) {
      throw new Error("The profile picker window could not become active")
    }
    return {
      createdForPicker,
      release: () =>
        windowProfilePickerHostClaims.delete(resolvedState!.win.id),
      state: resolvedState,
    }
  } catch (error) {
    if (resolvedState) {
      windowProfilePickerHostClaims.delete(resolvedState.win.id)
      if (createdForPicker && !resolvedState.win.isDestroyed()) {
        resolvedState.allowClose = true
        resolvedState.win.destroy()
      }
    }
    throw error
  }
}

async function processCliProfilePick(
  command: Extract<CliCommand, { kind: "profile-pick" }>,
  activeWindowBounds: CliActiveWindowBounds | null,
  responder: CliResponder
): Promise<void> {
  const host = await cliProfilePickerHost(command, activeWindowBounds)
  const { createdForPicker, state: sourceState } = host
  try {
    const profileId = await requestRendererWindowProfilePicker(
      sourceState,
      responder
    )
    if (profileId === null) {
      // A helper may disconnect as the fresh host closes on platforms where
      // that is the application's only window. Finish the protocol first.
      responder.accepted()
      if (createdForPicker) {
        await closeDisposableCliProfilePickerHost(sourceState)
      }
      return
    }
    // Re-enter the same serialized singleton/profile launch path used by
    // Settings and the native menu only after the user makes a choice, so an
    // open picker never blocks unrelated profile management.
    const requestedPosition = cliWindowPosition(
      { ...rememberedWindowSize },
      command.windowPlacement,
      activeWindowBounds
    )
    const ownerState = await serializeManagedResourceOperation(async () => {
      await launchWindowProfileFromState(
        sourceState,
        profileId,
        requestedPosition
      )
      const ownerWindowId = profileWindows.get(profileId)
      return ownerWindowId === undefined
        ? undefined
        : windowStates.get(ownerWindowId)
    })
    if (!ownerState) {
      throw new Error("The selected profile window could not be found")
    }
    if (!(await focusCliEditor(ownerState, ownerState.activeTabId))) {
      throw new Error("The selected profile window could not focus its editor")
    }
    if (
      createdForPicker &&
      ownerState.win.id !== sourceState.win.id &&
      !sourceState.win.isDestroyed()
    ) {
      await closeDisposableCliProfilePickerHost(sourceState)
    }
    completeCliOpen(ownerState, command.wait, responder)
  } catch (error) {
    if (createdForPicker) {
      try {
        await closeDisposableCliProfilePickerHost(sourceState)
      } catch (cleanupError) {
        console.warn(
          "Failed to close a disposable CLI profile picker window",
          cleanupError
        )
      }
    }
    throw error
  } finally {
    host.release()
  }
}

async function closeDisposableCliProfilePickerHost(
  state: WindowState
): Promise<void> {
  if (state.win.isDestroyed() || !isDisposableUntitledWindow(state)) return
  await new Promise<void>((resolve) => {
    state.win.once("closed", resolve)
    state.allowClose = true
    state.win.close()
  })
}

async function focusExistingScratch(
  command: CliOpenCommand,
  responder: CliResponder
): Promise<boolean> {
  if (
    command.sources.length !== 1 ||
    command.sources[0]?.kind !== "scratch" ||
    command.tabOptions.length > 0 ||
    command.mode !== "inherit" ||
    command.tabVisibility !== "inherit" ||
    command.windowMode !== "new"
  ) {
    return false
  }
  const stored = await scratchStore.findByFileNameOrStem(command.sources[0].id)
  const existing = stored ? openScratchTab(stored.id) : null
  if (!stored || !existing) return false
  const state = windowStates.get(existing.ownerWindowId)
  if (!state || state.win.isDestroyed()) return false
  ensureWindowMutable(state)
  const previousActiveTabId = state.activeTabId
  activateTabInState(state, existing.id)
  sendTabsChanged(state)
  if (!(await focusCliEditor(state, existing.id))) {
    state.activeTabId = previousActiveTabId
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    throw new Error(
      "The scratch window is busy; close its dialog or active operation and try again"
    )
  }
  await scratchStore.markOpened(stored.id)
  if (command.wait) beginCliWait([existing.id], responder)
  else responder.accepted()
  return true
}

async function processCliOpen(
  command: CliOpenCommand,
  stdinPath: string | null,
  activeWindowBounds: CliActiveWindowBounds | null,
  responder: CliResponder
): Promise<void> {
  const stdinSourceCount = command.sources.filter(
    (source) => source.kind === "stdin"
  ).length
  if ((stdinSourceCount === 1) !== (stdinPath !== null)) {
    throw new CliUsageError(
      "conflicting-options",
      stdinPath
        ? "Piped input is present, but no standard-input (-) source was requested"
        : "The standard-input (-) source requires piped input"
    )
  }
  if (await focusExistingScratch(command, responder)) return
  for (const source of command.sources) {
    if (source.kind === "scratch") {
      const stored = await scratchStore.findByFileNameOrStem(source.id)
      if (!stored || !openScratchTab(stored.id)) continue
      throw new Error(
        `Scratch document ${source.id} is already open; request it by itself to focus its existing tab`
      )
    }
  }

  const sources =
    command.sources.length > 0
      ? command.sources
      : ([{ kind: "untitled" }] satisfies CliOpenSource[])
  const { preparedTabs, retainedLoads } = await prepareCliTabs(
    sources,
    command.activeTabIndex,
    stdinPath
  )
  try {
    assertNoDuplicatePreparedTabs(preparedTabs, true)
    for (const options of command.tabOptions) {
      const prepared = preparedTabs[options.tabIndex]!
      if (options.location) {
        prepared.initialCursor = {
          line: options.location.line,
          column: options.location.column ?? 1,
        }
      }
      if (options.mode) prepared.initialEditorMode = options.mode
    }

    if (command.windowMode === "reuse") {
      await reuseWindowForCli(
        command,
        preparedTabs,
        activeWindowBounds,
        responder
      )
      return
    }
    const state = await createCliWindow(preparedTabs, {
      activeIndex: command.activeTabIndex,
      activeWindowBounds,
      ...(command.mode !== "inherit" ? { editorMode: command.mode } : {}),
      ...(command.tabVisibility !== "inherit"
        ? { tabVisibility: command.tabVisibility }
        : {}),
      windowPlacement: command.windowPlacement,
    })
    completeCliOpen(state, command.wait, responder)
  } finally {
    if (retainedLoads.length > 0) {
      const results = await Promise.allSettled(retainedLoads)
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn(
            "Unable to retain deferred standard input",
            result.reason
          )
        }
      }
    }
  }
}

function normalizedProfileJson(profile: ProfileSchemaV2): string {
  return `${JSON.stringify(profile, null, 2)}\n`
}

function cliDoctorReport(): string {
  const helperName =
    process.platform === "win32"
      ? `${distributionIdentity.cliCommandName}.exe`
      : distributionIdentity.cliCommandName
  const helperPath = distributionIdentity.isDevelopment
    ? path.join(
        app.getAppPath(),
        "dist-native",
        process.platform,
        "bin",
        helperName
      )
    : path.join(process.resourcesPath, "bin", helperName)
  return [
    `${PRODUCT_NAME} ${app.getVersion()}`,
    `CLI protocol: ${CLI_PROTOCOL_VERSION}`,
    `Application: ${process.execPath}`,
    `Packaged: ${app.isPackaged ? "yes" : "no"}`,
    `Helper: ${helperPath}`,
    `Endpoint: ${cliEndpointPath(distributionIdentity.cliIdentity)}`,
    `Profiles: ${profileStore.profileDirectory}`,
    `Scratch: ${scratchStore.directory}`,
    "Status: ready",
    "",
  ].join("\n")
}

async function processCliCommand(
  command: CliCommand,
  request: CliRawRequest
): Promise<void> {
  const { responder } = request
  switch (command.kind) {
    case "help":
      responder.output(
        formatCliHelp(command.topic, distributionIdentity.cliCommandName)
      )
      return
    case "version":
      responder.output(
        `${PRODUCT_NAME} ${app.getVersion()}\n${distributionIdentity.cliCommandName} protocol ${CLI_PROTOCOL_VERSION}\n`
      )
      return
    case "doctor":
      responder.output(cliDoctorReport())
      return
    case "open":
      await processCliOpen(
        command,
        request.stdinPath,
        request.activeWindowBounds,
        responder
      )
      return
    case "profile-open":
      await processCliProfileOpen(
        command,
        request.activeWindowBounds,
        responder
      )
      return
    case "profile-pick":
      await processCliProfilePick(
        command,
        request.activeWindowBounds,
        responder
      )
      return
    case "profile-list": {
      const profiles = await profileStore.list()
      responder.output(
        command.json
          ? `${JSON.stringify(
              profiles.map(({ id, name }) => ({ id, name })),
              null,
              2
            )}\n`
          : profiles.length > 0
            ? `${profiles.map(({ id, name }) => `${id}\t${name}`).join("\n")}\n`
            : ""
      )
      return
    }
    case "profile-show":
      responder.output(
        normalizedProfileJson(await profileStore.read(command.id))
      )
      return
    case "profile-import": {
      const profile = await profileStore.import(
        command.filePath,
        command.replace,
        async (candidate) => {
          if (profileWindows.has(candidate.id)) {
            throw new Error(`Close profile ${candidate.id} before importing it`)
          }
          await Promise.all(
            candidate.tabs.flatMap((tab) =>
              tab.kind === "scratch" ? [scratchStore.get(tab.scratchId)] : []
            )
          )
        }
      )
      responder.output(`Imported profile ${profile.id} (${profile.name}).\n`)
      return
    }
    case "profile-export": {
      if (command.destination.kind === "stdout") {
        responder.output(await profileStore.export(command.id))
      } else {
        await profileStore.export(
          command.id,
          command.destination.filePath,
          command.replace
        )
        responder.output(
          `Exported profile ${command.id} to ${command.destination.filePath}.\n`
        )
      }
      return
    }
    case "profile-delete": {
      await deleteClosedWindowProfileDefinition(command.id)
      responder.output(`Deleted profile ${command.id}.\n`)
      return
    }
    case "scratch-list": {
      const scratches = (await scratchStore.listCatalog())
        .map((scratch) => ({
          id: scratch.fileName.replace(/\.md$/i, ""),
          open: openScratchTabs.has(scratch.id),
          scratchId: scratch.id,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
      responder.output(
        command.json
          ? `${JSON.stringify(scratches, null, 2)}\n`
          : scratches.length > 0
            ? `${scratches.map(({ id }) => id).join("\n")}\n`
            : ""
      )
      return
    }
    case "scratch-export": {
      const scratch = await scratchStore.findByFileNameOrStem(command.id)
      if (!scratch) {
        throw new Error(`Scratch document ${command.id} does not exist`)
      }
      if (openScratchTab(scratch.id)) {
        throw new Error(
          `Close scratch document ${command.id} before exporting it`
        )
      }
      if (command.destination.kind === "stdout") {
        await responder.outputChunks(scratchStore.streamUtf8(scratch.id))
      } else {
        await scratchStore.exportFile(scratch.id, command.destination.filePath)
        responder.output(
          `Exported scratch document ${command.id} to ${command.destination.filePath}.\n`
        )
      }
      return
    }
    case "scratch-delete": {
      const scratch = await scratchStore.findByFileNameOrStem(command.id)
      if (!scratch) {
        throw new Error(`Scratch document ${command.id} does not exist`)
      }
      if (openScratchTab(scratch.id)) {
        throw new Error(
          `Close scratch document ${command.id} before deleting it`
        )
      }
      const referencing = (await profileStore.list()).filter((profile) =>
        profile.tabs.some(
          (tab) => tab.kind === "scratch" && tab.scratchId === scratch.id
        )
      )
      if (referencing.length > 0) {
        throw new Error(
          `Remove scratch document ${command.id} from ${referencing.map(({ name }) => name).join(", ")} before deleting it`
        )
      }
      await scratchStore.delete(scratch.id)
      responder.output(`Deleted scratch document ${command.id}.\n`)
      return
    }
  }
}

async function handleCliRequest(request: CliRawRequest): Promise<void> {
  let deferredForBackgroundClose = false
  try {
    if (!request.responder.connected) return
    if (applicationPersistenceQuiescing) {
      if (queueCliRequestDuringBackgroundClose(request)) {
        deferredForBackgroundClose = true
        return
      }
      throw new Error("Pulse MD is quitting")
    }
    const command = parseCliCommand(request.argv, {
      workingDirectory: request.cwd,
    })
    if (command.kind !== "open" && request.stdinPath) {
      throw new CliUsageError(
        "conflicting-options",
        "Piped input is accepted only by an open command containing '-'"
      )
    }
    if (command.kind === "profile-pick") {
      await processCliCommand(command, request)
    } else {
      await serializeManagedResourceOperation(async () => {
        // The request may have entered cliRequestQueue just before Command-Q
        // and then waited behind an unrelated resource mutation. Recheck at
        // the actual execution boundary so it resumes after the close instead
        // of racing the window transaction.
        if (applicationPersistenceQuiescing) {
          if (queueCliRequestDuringBackgroundClose(request)) {
            deferredForBackgroundClose = true
            return
          }
          throw new Error("Pulse MD is quitting")
        }
        await processCliCommand(command, request)
      })
    }
  } catch (error) {
    const usageError = error instanceof CliUsageError
    const message = error instanceof Error ? error.message : String(error)
    request.responder.fail(
      `${distributionIdentity.cliCommandName}: ${message}\n${usageError ? `Try '${distributionIdentity.cliCommandName} --help' for usage.\n` : ""}`,
      usageError ? 2 : 1
    )
  } finally {
    if (!deferredForBackgroundClose && request.stdinPath) {
      await unlink(request.stdinPath).catch(() => undefined)
    }
  }
}

function maybeQuitCliBootstrap(): void {
  const initialLaunchHasWork =
    initialLaunchIntent.kind === "open-scratch" ||
    initialLaunchIntent.filePaths.length !== 0
  if (
    !cliBootstrapLaunch ||
    queuedCliRequestCount !== 0 ||
    pendingCliRequests.length !== 0 ||
    pendingLaunchIntents.length !== 0 ||
    pendingOpenFiles.length !== 0 ||
    initialLaunchHasWork ||
    windowStates.size !== 0
  ) {
    return
  }
  setImmediate(() => {
    if (
      queuedCliRequestCount === 0 &&
      pendingCliRequests.length === 0 &&
      pendingLaunchIntents.length === 0 &&
      pendingOpenFiles.length === 0 &&
      !initialLaunchHasWork &&
      windowStates.size === 0
    ) {
      void beginApplicationQuit()
    }
  })
}

function cliCommandCanRunBeforeApplicationInitialization(
  request: CliRawRequest
): boolean {
  try {
    const command = parseCliCommand(request.argv, {
      workingDirectory: request.cwd,
    })
    return parsedCliCommandCanRunBeforeApplicationInitialization(command)
  } catch {
    // Usage errors do not need Chromium, application menus, or renderer IPC.
    return true
  }
}

function enqueueCliRequest(request: CliRawRequest): void {
  queuedCliRequestCount += 1
  const run = () =>
    trackCliRequestOperation(
      handleCliRequest(request).catch((error: unknown) => {
        console.error("Unhandled CLI request failure", error)
        request.responder.fail(
          `${distributionIdentity.cliCommandName}: An internal CLI error occurred.\n`,
          1
        )
      })
    )
  const finish = () => {
    queuedCliRequestCount -= 1
    maybeQuitCliBootstrap()
  }
  let opensInteractiveProfilePicker = false
  try {
    opensInteractiveProfilePicker =
      parseCliCommand(request.argv, { workingDirectory: request.cwd }).kind ===
      "profile-pick"
  } catch {
    // Ordinary queued handling owns usage errors and their CLI response.
  }

  if (opensInteractiveProfilePicker) {
    // Preserve arrival order through picker startup, then detach the
    // user-driven wait so unrelated later CLI requests remain responsive.
    cliRequestQueue = cliRequestQueue
      .catch(() => undefined)
      .then(() => {
        void run().finally(finish)
      })
    return
  }

  cliRequestQueue = cliRequestQueue.then(run).finally(finish)
}

function rejectCliRequestDuringQuit(request: CliRawRequest): void {
  request.responder.fail(
    `${distributionIdentity.cliCommandName}: ${PRODUCT_NAME} is quitting.\n`,
    1
  )
  trackCliRequestOperation(
    (async () => {
      if (request.stdinPath) {
        await unlink(request.stdinPath).catch(() => undefined)
      }
    })()
  )
}

function queueCliRequestDuringBackgroundClose(request: CliRawRequest): boolean {
  if (
    !shouldQueueCliRequestDuringBackgroundClose(
      applicationPersistenceQuiescing,
      applicationCloseSequenceKind,
      completeQuitRequestedDuringBackgroundClose
    )
  ) {
    return false
  }
  pendingCliRequests.push(request)
  return true
}

function acceptCliRequest(request: CliRawRequest): void {
  if (applicationPersistenceQuiescing) {
    if (queueCliRequestDuringBackgroundClose(request)) return
    rejectCliRequestDuringQuit(request)
    return
  }
  if (
    applicationInitialized ||
    cliCommandCanRunBeforeApplicationInitialization(request)
  ) {
    enqueueCliRequest(request)
  } else {
    pendingCliRequests.push(request)
    requestApplicationInitialization()
  }
}

function finishPendingCliEditorFocus(
  requestId: string,
  accepted: boolean
): void {
  const pending = pendingCliEditorFocus.get(requestId)
  if (!pending) return
  pendingCliEditorFocus.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(accepted)
}

function requestRendererCliEditorFocus(
  state: WindowState,
  tabId: TabId
): Promise<boolean> {
  if (
    state.win.isDestroyed() ||
    state.win.webContents.isDestroyed() ||
    !state.rendererReady ||
    !state.editorReady ||
    !state.tabIds.includes(tabId)
  ) {
    return Promise.resolve(false)
  }
  const request: CliEditorFocusRequest = {
    requestId: randomUUID(),
    tabId,
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => finishPendingCliEditorFocus(request.requestId, false),
      10_000
    )
    timeout.unref()
    pendingCliEditorFocus.set(request.requestId, {
      ownerWindowId: state.win.id,
      resolve,
      tabId,
      timeout,
    })
    state.win.webContents.send(ipcChannels.cliEditorFocusRequested, request)
  })
}

function showAndWaitForCliWindow(
  state: WindowState,
  timeoutMs = 10_000
): Promise<boolean> {
  const { win } = state
  if (win.isDestroyed()) return Promise.resolve(false)
  if (win.isMinimized()) win.restore()
  if (win.isFocused()) {
    win.show()
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (focused: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      win.removeListener("focus", handleFocus)
      win.removeListener("closed", handleClosed)
      resolve(focused && !win.isDestroyed())
    }
    const handleFocus = () => finish(true)
    const handleClosed = () => finish(false)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref()
    win.once("focus", handleFocus)
    win.once("closed", handleClosed)

    // BrowserWindow.show() targets this exact native window and requests
    // activation. macOS completes that request asynchronously when another
    // application currently owns focus, so do not ask the renderer to prove
    // document focus until the native focus event arrives.
    win.show()
    win.focus()
    if (win.isFocused()) finish(true)
  })
}

async function focusCliEditor(
  state: WindowState,
  tabId: TabId
): Promise<boolean> {
  return (
    (await showAndWaitForCliWindow(state)) &&
    (await requestRendererCliEditorFocus(state, tabId))
  )
}

function finishPendingCliTabsOpen(requestId: string, accepted: boolean): void {
  const pending = pendingCliTabsOpen.get(requestId)
  if (!pending) return
  pendingCliTabsOpen.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(accepted)
}

function finishPendingCliRendererRequestsForWindow(windowId: WindowId): void {
  for (const [requestId, pending] of pendingCliEditorFocus) {
    if (pending.ownerWindowId === windowId) {
      finishPendingCliEditorFocus(requestId, false)
    }
  }
  for (const [requestId, pending] of pendingCliTabsOpen) {
    if (pending.ownerWindowId === windowId) {
      finishPendingCliTabsOpen(requestId, false)
    }
  }
}

function requestRendererOpenCliTabs(
  state: WindowState,
  request: CliTabsOpenRequest,
  tabIds: TabId[]
): Promise<boolean> {
  if (
    state.win.isDestroyed() ||
    state.win.webContents.isDestroyed() ||
    !state.rendererReady
  ) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => finishPendingCliTabsOpen(request.requestId, false),
      10_000
    )
    timeout.unref()
    pendingCliTabsOpen.set(request.requestId, {
      activeTabId: request.activeTabId,
      ownerWindowId: state.win.id,
      resolve,
      tabIds,
      timeout,
    })
    state.win.webContents.send(ipcChannels.cliTabsOpenRequested, request)
  })
}

function finishPendingWindowProfilePicker(
  requestId: string,
  profileId: string | null,
  notifyRenderer = false
): void {
  const pending = pendingWindowProfilePickers.get(requestId)
  if (!pending) return
  pendingWindowProfilePickers.delete(requestId)
  pending.unsubscribeDisconnect()
  if (notifyRenderer) {
    const state = windowStates.get(pending.ownerWindowId)
    if (
      state &&
      !state.win.isDestroyed() &&
      !state.win.webContents.isDestroyed()
    ) {
      state.win.webContents.send(ipcChannels.windowProfilePickerCancelled, {
        requestId,
      } satisfies WindowProfilePickerRequest)
    }
  }
  pending.resolve(profileId)
}

function requestRendererWindowProfilePicker(
  state: WindowState,
  responder: CliResponder
): Promise<string | null> {
  if (!responder.connected) return Promise.resolve(null)
  if (
    state.win.isDestroyed() ||
    state.win.webContents.isDestroyed() ||
    !state.rendererReady ||
    !state.editorReady
  ) {
    return Promise.reject(
      new Error("The profile picker host is no longer available")
    )
  }
  if (
    [...pendingWindowProfilePickers.values()].some(
      (pending) => pending.ownerWindowId === state.win.id
    )
  ) {
    return Promise.reject(
      new Error("The profile picker host is already in use")
    )
  }
  const request: WindowProfilePickerRequest = { requestId: randomUUID() }
  return new Promise((resolve) => {
    const pending: PendingWindowProfilePicker = {
      ownerWindowId: state.win.id,
      resolve,
      unsubscribeDisconnect: () => undefined,
    }
    pendingWindowProfilePickers.set(request.requestId, pending)
    pending.unsubscribeDisconnect = responder.onDisconnect(() => {
      finishPendingWindowProfilePicker(request.requestId, null, true)
    })
    if (pendingWindowProfilePickers.get(request.requestId) !== pending) return
    state.win.webContents.send(
      ipcChannels.windowProfilePickerRequested,
      request
    )
  })
}

async function reuseWindowForCli(
  command: CliOpenCommand,
  preparedTabs: PreparedTab[],
  activeWindowBounds: CliActiveWindowBounds | null,
  responder: CliResponder
): Promise<void> {
  const preferred =
    lastFocusedWindowId === null
      ? null
      : (windowStates.get(lastFocusedWindowId) ?? null)
  const targetState =
    preferred && !preferred.win.isDestroyed()
      ? preferred
      : ([...windowStates.values()].find(
          (state) => !state.win.isDestroyed() && !state.provisional
        ) ?? null)

  if (!targetState) {
    const state = await createCliWindow(preparedTabs, {
      activeIndex: command.activeTabIndex,
      activeWindowBounds,
      ...(command.mode !== "inherit" ? { editorMode: command.mode } : {}),
      ...(command.tabVisibility !== "inherit"
        ? { tabVisibility: command.tabVisibility }
        : {}),
      windowPlacement: command.windowPlacement,
    })
    completeCliOpen(state, command.wait, responder)
    return
  }

  ensureWindowMutable(targetState)
  if (!targetState.rendererReady || !targetState.editorReady) {
    throw new Error("The target window is not ready to receive CLI tabs")
  }
  if (!(await showAndWaitForCliWindow(targetState))) {
    throw new Error("The target window could not become active")
  }

  const previousActiveTabId = targetState.activeTabId
  const createdTabIds = preparedTabs.map(
    (prepared) =>
      createTabState(
        targetState.win.id,
        cloneDocument(prepared.document),
        prepared.contentHash,
        prepared.ioPath,
        {
          backing: prepared.backing,
          ...(prepared.color ? { color: prepared.color } : {}),
          diskFingerprint: prepared.diskFingerprint,
          dirty: prepared.dirty,
          ...(prepared.fileMissing !== undefined
            ? { fileMissing: prepared.fileMissing }
            : {}),
          ...(prepared.profileOrigin
            ? { profileOrigin: prepared.profileOrigin }
            : {}),
          ...(prepared.scratchIdentity
            ? { scratchIdentity: prepared.scratchIdentity }
            : {}),
          ...(prepared.title ? { title: prepared.title } : {}),
        }
      ).id
  )
  targetState.tabIds.push(...createdTabIds)
  const activeTabId = createdTabIds[command.activeTabIndex]!
  createdTabIds.forEach((tabId, index) => {
    if (tabId === activeTabId) return
    const tab = tabStates.get(tabId)
    const prepared = preparedTabs[index]
    if (!tab || !prepared) throw new Error("A CLI tab disappeared")
    registerPreparedTabHydration(targetState, targetState.win, tab, prepared)
  })
  targetState.activeTabId = activeTabId
  const requestId = randomUUID()
  const activeTab = tabStates.get(activeTabId)
  const activePrepared = preparedTabs[command.activeTabIndex]
  if (!activeTab || !activePrepared || activePrepared.deferredLoad) {
    throw new Error("The active CLI tab was not prepared")
  }
  const request: CliTabsOpenRequest = {
    requestId,
    activeTabId,
    ...(command.mode !== "inherit" ? { editorMode: command.mode } : {}),
    tabs: [
      bootstrapTab(activeTab, undefined, {
        ...(activePrepared.baselineContent !== undefined
          ? { baselineContent: activePrepared.baselineContent }
          : {}),
        ...(activePrepared.initialCursor
          ? { initialCursor: activePrepared.initialCursor }
          : {}),
        ...(activePrepared.initialEditorMode
          ? { initialEditorMode: activePrepared.initialEditorMode }
          : {}),
      }),
    ],
  }

  const accepted = await requestRendererOpenCliTabs(
    targetState,
    request,
    createdTabIds
  )
  if (!accepted) {
    targetState.activeTabId = previousActiveTabId
    for (const tabId of createdTabIds) {
      const index = targetState.tabIds.indexOf(tabId)
      if (index >= 0) targetState.tabIds.splice(index, 1)
      const tab = tabStates.get(tabId)
      if (tab) disposeTabState(tab)
    }
    updateWindowNativeDocument(targetState)
    sendTabsChanged(targetState)
    throw new Error(
      "The target window is busy; close its dialog or active operation and try again"
    )
  }

  if (tabStates.get(activeTabId) === activeTab) {
    activeTab.document.content = ""
    watchTabDocument(activeTab)
  }
  if (command.tabVisibility !== "inherit") {
    targetState.launchOverrides.tabVisibility = command.tabVisibility
    targetState.win.webContents.send(
      ipcChannels.settingsChanged,
      settingsSnapshotForWindow(targetState, settings)
    )
  }
  updateWindowNativeDocument(targetState)
  sendTabsChanged(targetState)
  if (command.wait) beginCliWait(createdTabIds, responder)
  else responder.accepted()
}

function requestActivationWindow(): void {
  if (
    applicationPersistenceQuiescing ||
    activationWindowRequest ||
    pendingLaunchWindowCount > 0 ||
    BrowserWindow.getAllWindows().length > 0
  ) {
    return
  }

  activationWindowRequest = setImmediate(() => {
    activationWindowRequest = null
    if (
      !applicationPersistenceQuiescing &&
      pendingLaunchWindowCount === 0 &&
      BrowserWindow.getAllWindows().length === 0
    ) {
      void routeLaunchIntent({ kind: "new-window", filePaths: [] })
    }
  })
}

function clearExpiredDragTokens(broadcast = true): void {
  const cutoff = Date.now() - DRAG_TOKEN_LIFETIME_MS
  for (const token of dragTokens.values()) {
    if (token.createdAt < cutoff) deleteDragToken(token.token, broadcast)
  }
}

function registerOneWayIpcHandler<TArgs extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: TArgs) => Promise<void> | void,
  recover?: (event: IpcMainEvent) => void
): void {
  ipcMain.on(channel, (event, ...rawArgs) => {
    const handleError = (error: unknown) => {
      console.error(`Unable to handle one-way IPC on ${channel}`, error)
      if (!recover) return
      try {
        recover(event)
      } catch (recoveryError) {
        console.error(
          `Unable to recover from one-way IPC failure on ${channel}`,
          recoveryError
        )
      }
    }

    try {
      const pending = listener(event, ...(rawArgs as unknown as TArgs))
      if (pending) void pending.catch(handleError)
    } catch (error) {
      handleError(error)
    }
  })
}

function windowCanAcceptOpenedDocuments(
  state: WindowState,
  win: BrowserWindow
): boolean {
  return (
    windowStates.get(win.id) === state &&
    !state.closeSequence &&
    !state.allowClose &&
    !state.tabMutationLocked &&
    !win.isDestroyed()
  )
}

async function openDocumentsInWindow(
  state: WindowState,
  filePaths: readonly string[],
  replacementCandidateId: TabId | null
): Promise<OpenDocumentResult | null> {
  const { win } = state
  if (filePaths.length === 0) return null

  try {
    const activeLoaded = await readDocument(filePaths[0]!)
    if (!windowCanAcceptOpenedDocuments(state, win)) return null
    const preparedTabs: PreparedTab[] = [
      {
        backing: "file",
        contentHash: activeLoaded.contentHash,
        diskFingerprint: activeLoaded.fingerprint,
        dirty: false,
        document: activeLoaded.document,
        ioPath: activeLoaded.ioPath,
      },
      ...filePaths.slice(1).map((filePath) =>
        deferredFileTab(filePath, async () => {
          const loaded = await readDocument(filePath)
          return {
            backing: "file",
            contentHash: loaded.contentHash,
            diskFingerprint: loaded.fingerprint,
            dirty: false,
            document: loaded.document,
            ioPath: loaded.ioPath,
          }
        })
      ),
    ]

    const replacementCandidate =
      replacementCandidateId === null
        ? undefined
        : tabStates.get(replacementCandidateId)
    const mayReplace =
      replacementCandidateId !== null &&
      state.tabIds.includes(replacementCandidateId) &&
      isDisposableUntitledTab(state, replacementCandidate)
    const openedTabs = preparedTabs.map((prepared) =>
      createTabState(
        state.win.id,
        cloneDocument(prepared.document),
        prepared.contentHash,
        prepared.ioPath,
        {
          backing: prepared.backing,
          diskFingerprint: prepared.diskFingerprint,
          dirty: prepared.dirty,
          ...(prepared.fileMissing !== undefined
            ? { fileMissing: prepared.fileMissing }
            : {}),
        }
      )
    )
    const openedTabIds = openedTabs.map(({ id }) => id)
    let replacedTabId: TabId | null = null

    if (mayReplace) {
      replacedTabId = replacementCandidate.id
      const index = state.tabIds.indexOf(replacementCandidate.id)
      state.tabIds.splice(index, 1, ...openedTabIds)
      state.approvedTabCloses.delete(replacementCandidate.id)
      disposeTabState(replacementCandidate)
    } else {
      state.tabIds.push(...openedTabIds)
    }

    // Keep the first selected file visible while retaining every selected
    // path in its source order in the tab strip.
    state.activeTabId = openedTabIds[0]!
    updateWindowNativeDocument(state)
    const activeTab = openedTabs[0]!
    const openedBootstraps = [bootstrapTab(activeTab)]
    openedTabs.slice(1).forEach((tab, index) => {
      const prepared = preparedTabs[index + 1]
      if (!prepared) throw new Error("An opened tab recipe disappeared")
      registerPreparedTabHydration(state, win, tab, prepared, {
        recordRecentDocument: false,
      })
    })
    activeTab.document.content = ""
    watchTabDocument(activeTab)
    for (const tab of openedTabs) {
      if (tab.document.filePath) addRecentDocument(tab.document.filePath)
    }
    return {
      openedTabs: openedBootstraps,
      replacedTabId,
      window: windowSnapshot(state),
    }
  } catch (error) {
    if (windowCanAcceptOpenedDocuments(state, win)) {
      await showOperationError(
        win,
        "Open Failed",
        filePaths.length === 1
          ? "The selected document could not be opened."
          : "The selected documents could not be opened.",
        error
      )
    }
    return null
  }
}

async function openScratchInWindow(
  state: WindowState,
  scratchId: string,
  disposition: ScratchOpenDisposition,
  fragment: string | null = null
): Promise<OpenScratchResult | null> {
  const { win } = state
  try {
    const existing = openScratchTab(scratchId)
    if (existing) {
      const existingState =
        existing.ownerWindowId === state.win.id &&
        state.tabIds.includes(existing.id)
          ? state
          : linkedTabState(existing)
      if (!existingState) {
        throw new Error(
          "The scratch is open in a window that is currently busy"
        )
      }
      const result = await activateLinkedDocumentTab(
        { state: existingState, tab: existing },
        state,
        fragment
      )
      if (result) await scratchStore.markOpened(scratchId)
      return result
    }

    const prepared = await preparedScratchTab(scratchId)
    if (!windowCanAcceptOpenedDocuments(state, win)) return null
    const replacementCandidate = tabStates.get(state.activeTabId)
    const mayReplace =
      disposition === "default" &&
      isDisposableUntitledTab(state, replacementCandidate)
    const openedTab = createTabState(
      state.win.id,
      cloneDocument(prepared.document),
      prepared.contentHash,
      prepared.ioPath,
      {
        backing: "scratch",
        diskFingerprint: prepared.diskFingerprint,
        scratchIdentity: prepared.scratchIdentity,
        ...(prepared.title ? { title: prepared.title } : {}),
      }
    )
    let replacedTabId: TabId | null = null
    if (mayReplace) {
      replacedTabId = replacementCandidate.id
      const index = state.tabIds.indexOf(replacementCandidate.id)
      state.tabIds.splice(index, 1, openedTab.id)
      state.approvedTabCloses.delete(replacementCandidate.id)
      disposeTabState(replacementCandidate)
    } else {
      state.tabIds.push(openedTab.id)
    }
    state.activeTabId = openedTab.id
    updateWindowNativeDocument(state)
    const openedBootstrap = bootstrapTab(openedTab)
    openedTab.document.content = ""
    return {
      kind: "document",
      openedTab: openedBootstrap,
      replacedTabId,
      window: windowSnapshot(state),
    }
  } catch (error) {
    if (windowCanAcceptOpenedDocuments(state, win)) {
      await showOperationError(
        win,
        "Open Scratch Failed",
        "The scratch could not be opened.",
        error
      )
    }
    return null
  }
}

function windowCanBecomeRecentDocumentTarget(state: WindowState): boolean {
  return (
    windowStates.get(state.win.id) === state &&
    !state.closeSequence &&
    !state.allowClose &&
    !state.win.isDestroyed() &&
    !state.provisional &&
    !state.recoverySurfaceActive &&
    !state.recoveryInProgress
  )
}

function windowReadyForRecentDocumentTransaction(state: WindowState): boolean {
  return (
    windowCanBecomeRecentDocumentTarget(state) &&
    state.rendererReady &&
    state.editorReady &&
    !state.editorMenuState.settingsDialogOpen &&
    !state.editorMenuState.settingsWorkspaceOpen
  )
}

function recentDocumentTargetState(
  preferredWindow: BrowserWindow | null
): WindowState | null {
  const candidates: BrowserWindow[] = []
  const append = (win: BrowserWindow | null | undefined) => {
    if (
      win &&
      !win.isDestroyed() &&
      !candidates.some((candidate) => candidate.id === win.id)
    ) {
      candidates.push(win)
    }
  }
  append(preferredWindow)
  append(BrowserWindow.getFocusedWindow())
  append(
    lastFocusedWindowId === null
      ? null
      : windowStates.get(lastFocusedWindowId)?.win
  )
  for (const state of windowStates.values()) append(state.win)

  for (const win of candidates) {
    const state = windowStates.get(win.id)
    if (state && windowCanBecomeRecentDocumentTarget(state)) return state
  }
  return null
}

async function acquireRecentDocumentMutation(
  state: WindowState
): Promise<boolean> {
  while (windowCanBecomeRecentDocumentTarget(state)) {
    if (!state.tabMutationLocked) {
      state.tabMutationLocked = true
      return true
    }
    await waitForTabMutation(state)
  }
  return false
}

async function openRecentDocumentInWindow(
  state: WindowState,
  filePath: string
): Promise<boolean> {
  if (!(await acquireRecentDocumentMutation(state))) return false
  const previousActiveTabId = state.activeTabId
  let openedTab: TabState | null = null
  let committed = false
  const rollback = () => {
    if (!openedTab || committed) return
    const openedIndex = state.tabIds.indexOf(openedTab.id)
    if (openedIndex >= 0) state.tabIds.splice(openedIndex, 1)
    if (state.tabIds.includes(previousActiveTabId)) {
      state.activeTabId = previousActiveTabId
    }
    if (tabStates.get(openedTab.id) === openedTab) disposeTabState(openedTab)
    openedTab = null
    if (!state.win.isDestroyed()) {
      updateWindowNativeDocument(state)
      sendTabsChanged(state)
    }
  }
  try {
    const loaded = await readDocument(filePath)
    if (
      !(await waitForEditorReady(state)) ||
      !windowReadyForRecentDocumentTransaction(state) ||
      !(await showAndWaitForCliWindow(state)) ||
      !windowReadyForRecentDocumentTransaction(state)
    ) {
      return false
    }

    const activeTab = ownedTabForState(state, previousActiveTabId)
    const replacedTabId = isDisposableUntitledTab(state, activeTab)
      ? activeTab.id
      : undefined
    openedTab = createTabState(
      state.win.id,
      loaded.document,
      loaded.contentHash,
      loaded.ioPath,
      { diskFingerprint: loaded.fingerprint }
    )

    if (replacedTabId) {
      const replacedIndex = state.tabIds.indexOf(replacedTabId)
      state.tabIds.splice(replacedIndex + 1, 0, openedTab.id)
    } else {
      state.tabIds.push(openedTab.id)
    }
    state.activeTabId = openedTab.id
    updateWindowNativeDocument(state)

    const request: CliTabsOpenRequest = {
      requestId: randomUUID(),
      activeTabId: openedTab.id,
      ...(replacedTabId ? { replaceTabId: replacedTabId } : {}),
      tabs: [bootstrapTab(openedTab)],
    }
    const accepted = await requestRendererOpenCliTabs(state, request, [
      openedTab.id,
    ])
    if (!accepted) {
      rollback()
      return false
    }

    if (replacedTabId) {
      const replacedIndex = state.tabIds.indexOf(replacedTabId)
      if (replacedIndex < 0) {
        throw new Error("The disposable tab disappeared during Open Recent")
      }
      state.tabIds.splice(replacedIndex, 1)
      const replacedTab = tabStates.get(replacedTabId)
      if (replacedTab) disposeTabState(replacedTab)
    }
    committed = true
    openedTab.document.content = ""
    watchTabDocument(openedTab)
    addRecentDocument(filePath)
    updateWindowNativeDocument(state)
    sendTabsChanged(state)
    return true
  } catch (error) {
    rollback()
    throw error
  } finally {
    unlockTabMutation(state)
  }
}

async function openRecentDocumentFromMenu(
  filePath: string,
  preferredWindow: BrowserWindow | null
): Promise<void> {
  const resolvedPath = path.resolve(filePath)
  const target = recentDocumentTargetState(preferredWindow)
  if (!target) {
    await createDocumentWindow({ filePaths: [resolvedPath] })
    return
  }

  try {
    if (await openRecentDocumentInWindow(target, resolvedPath)) return
    if (!target.win.isDestroyed()) {
      await showOperationError(
        target.win,
        "Open Recent Failed",
        "The recent document could not be opened in the current window.",
        new Error("The window became unavailable while opening the document")
      )
    }
  } catch (error) {
    if (!target.win.isDestroyed()) {
      await showOperationError(
        target.win,
        "Open Recent Failed",
        "The recent document could not be opened.",
        error
      )
    } else {
      console.warn(`Unable to open recent document ${resolvedPath}`, error)
    }
  }
}

function registerIpc(): void {
  if (launchBenchmark) {
    // Probes intentionally edit disposable documents. Benchmark cleanup must
    // never enter the user's dirty-document close flow.
    registerOneWayIpcHandler(ipcChannels.exitLaunchBenchmark, (event): void => {
      stateForSender(event)
      for (const state of windowStates.values()) state.allowClose = true
      allowApplicationQuit = true
      app.quit()
    })
  }

  registerOneWayIpcHandler(
    ipcChannels.showRecovery,
    (event, rawError: unknown): void => {
      const { state } = stateForSender(event)
      if (
        typeof rawError !== "string" ||
        rawError.length === 0 ||
        rawError.length > 4_096
      ) {
        throw new TypeError("Invalid renderer recovery error")
      }
      void showWindowRecoverySurface(state, "bootstrap", new Error(rawError))
    }
  )

  ipcMain.handle(
    ipcChannels.recoveryAction,
    async (event, rawAction: unknown): Promise<void> => {
      const { state } = stateForRecoverySender(event)
      const action: RecoveryAction =
        rawAction === "reload" || rawAction === "reopen" || rawAction === "quit"
          ? rawAction
          : (() => {
              throw new TypeError("Invalid recovery action")
            })()
      if (action === "reload") {
        await reloadRecoveredWindow(state)
      } else {
        const quitting = await beginApplicationQuit(action === "reopen")
        if (!quitting) throw new Error("Quit was canceled.")
      }
    }
  )

  registerOneWayIpcHandler(ipcChannels.editorReady, (event): void => {
    const { state } = stateForSender(event)
    if (!state.rendererReady) {
      throw new Error("Editor readiness arrived before renderer readiness")
    }
    markEditorReady(state)
    if (state.launchVisualBenchmark) {
      state.launchVisualBenchmark.editorReadyEpochMs = launchBenchmarkEpochMs()
    }
    schedulePendingWindowVisualEffect(state)
  })

  registerOneWayIpcHandler(
    ipcChannels.editFocusedControl,
    (event, command: unknown): void => {
      const { win } = stateForSender(event)
      const action: FocusedEditCommand =
        command === "copy" ||
        command === "cut" ||
        command === "paste" ||
        command === "redo" ||
        command === "undo"
          ? command
          : (() => {
              throw new TypeError("Invalid focused edit command")
            })()
      if (action === "copy") win.webContents.copy()
      else if (action === "cut") win.webContents.cut()
      else if (action === "paste") win.webContents.paste()
      else if (action === "undo") win.webContents.undo()
      else win.webContents.redo()
    }
  )

  ipcMain.handle(
    ipcChannels.getWindowsMenuSnapshot,
    (event): WindowsMenuSnapshot => {
      const { state } = stateForSender(event)
      if (process.platform !== "win32") {
        throw new Error("The renderer application menu is Windows-only")
      }
      return windowsMenuSnapshot(state)
    }
  )

  ipcMain.handle(
    ipcChannels.activateWindowsMenuItem,
    (event, rawActionToken: unknown): void => {
      const { state } = stateForSender(event)
      if (process.platform !== "win32") {
        throw new Error("The renderer application menu is Windows-only")
      }
      if (
        typeof rawActionToken !== "string" ||
        rawActionToken.length < 1 ||
        rawActionToken.length > 128
      ) {
        throw new TypeError("Invalid Windows menu action")
      }
      activateWindowsMenuItem(state, rawActionToken)
    }
  )

  ipcMain.handle(
    ipcChannels.addWordToSpellCheckerDictionary,
    (event, rawWord: unknown): boolean => {
      const { win } = stateForSender(event)
      const word = spellingWordFromUnknown(rawWord)
      const spellCheckSession = win.webContents.session
      const added = spellCheckSession.addWordToSpellCheckerDictionary(word)
      if (added) broadcastSpellCheckDictionaryChanged(spellCheckSession)
      return added
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.commandHandled,
    (event, rawRequestId: unknown): void => {
      const { state } = stateForSender(event)
      if (typeof rawRequestId !== "string" || rawRequestId.length === 0) {
        throw new TypeError("Invalid editor command acknowledgement")
      }
      const pending = pendingEditorCommandAcknowledgements.get(rawRequestId)
      if (!pending || pending.ownerWindowId !== state.win.id) return
      finishPendingEditorCommand(rawRequestId, true)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.startupCommand,
    (event, rawCommand: unknown): void => {
      const { state, win } = stateForSender(event)
      if (state.editorReady) return
      if (rawCommand !== "new-tab") {
        throw new TypeError("Invalid startup editor command")
      }
      sendCommand(rawCommand, win)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeCliEditorFocus,
    (event, rawAcknowledgement: unknown): void => {
      const { state } = stateForSender(event)
      const acknowledgement =
        normalizeCliEditorFocusAcknowledgement(rawAcknowledgement)
      const pending = pendingCliEditorFocus.get(acknowledgement.requestId)
      if (
        !pending ||
        pending.ownerWindowId !== state.win.id ||
        state.activeTabId !== pending.tabId
      ) {
        return
      }
      finishPendingCliEditorFocus(
        acknowledgement.requestId,
        acknowledgement.accepted
      )
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeCliTabsOpen,
    (event, rawAcknowledgement: unknown): void => {
      const { state } = stateForSender(event)
      const acknowledgement =
        normalizeCliTabsOpenAcknowledgement(rawAcknowledgement)
      const pending = pendingCliTabsOpen.get(acknowledgement.requestId)
      if (!pending || pending.ownerWindowId !== state.win.id) return
      finishPendingCliTabsOpen(
        acknowledgement.requestId,
        acknowledgement.accepted && state.activeTabId === pending.activeTabId
      )
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.completeWindowProfilePicker,
    (event, rawRequestId: unknown, rawProfileId: unknown): void => {
      const { state } = stateForSender(event)
      if (
        typeof rawRequestId !== "string" ||
        rawRequestId.length === 0 ||
        (rawProfileId !== null && !isProfileIdentifier(rawProfileId))
      ) {
        throw new TypeError("Invalid window-profile picker result")
      }
      const pending = pendingWindowProfilePickers.get(rawRequestId)
      if (!pending || pending.ownerWindowId !== state.win.id) return
      finishPendingWindowProfilePicker(rawRequestId, rawProfileId)
    }
  )

  ipcMain.handle(
    ipcChannels.bootstrap,
    async (event): Promise<BootstrapPayload> => {
      const { state, win } = stateForSender(event)
      if (!state.bootstrapPending) {
        throw new Error("Window bootstrap was already read")
      }
      state.bootstrapPending = false
      const [activeTab, persistedSettings] = await Promise.all([
        hydrateTabForRenderer(state, state.activeTabId, true, true),
        currentSettings(),
      ])
      if (!activeTab) throw new Error("The active tab could not be hydrated")
      return {
        activeTabId: state.activeTabId,
        activeTab,
        platform: process.platform as AppPlatform,
        persistedSettings,
        settings: cloneAppSettings(state.launchSettings),
        tabDragSink: state.provisional,
        tabs: state.tabIds.map((tabId) => {
          const tab = tabStates.get(tabId)
          if (!tab) throw new Error("Initial tab disappeared")
          return tabDescriptor(tab)
        }),
        windowActive: win.isFocused(),
        windowId: win.id,
      }
    }
  )

  ipcMain.handle(ipcChannels.acquireSettingsSession, (event): boolean => {
    const { state, win } = stateForSender(event)
    if (
      state.recoverySurfaceActive ||
      state.recoveryInProgress ||
      !state.rendererReady ||
      win.isDestroyed()
    ) {
      return false
    }

    if (settingsSessionOwnerWindowId !== null) {
      const ownerState = windowStates.get(settingsSessionOwnerWindowId)
      if (
        !ownerState ||
        ownerState.win.isDestroyed() ||
        ownerState.recoverySurfaceActive ||
        ownerState.recoveryInProgress
      ) {
        releaseSettingsSessionForWindow(settingsSessionOwnerWindowId)
      } else if (ownerState.win.id !== win.id) {
        if (ownerState.win.isMinimized()) ownerState.win.restore()
        ownerState.win.show()
        ownerState.win.focus()
        return false
      }
    }

    settingsSessionOwnerWindowId = win.id
    return true
  })

  registerOneWayIpcHandler(
    ipcChannels.releaseSettingsSession,
    (event): void => {
      const { win } = stateForSender(event)
      releaseSettingsSessionForWindow(win.id)
    }
  )

  ipcMain.handle(
    ipcChannels.hydrateTab,
    async (
      event,
      rawTabId: unknown,
      rawInteractive: unknown
    ): Promise<BootstrapTab | null> => {
      const { state } = stateForSender(event)
      if (typeof rawInteractive !== "boolean") {
        throw new TypeError("Interactive hydration flag must be a boolean")
      }
      const tab = hydrationTabForState(state, rawTabId)
      return hydrateTabForRenderer(state, tab.id, rawInteractive)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeTabHydration,
    (event, rawTabId: unknown): void => {
      const { state } = stateForSender(event)
      const tab = hydrationTabForState(state, rawTabId)
      acknowledgeTabHydration(state, tab.id)
    }
  )

  ipcMain.handle(
    ipcChannels.rendererReady,
    async (
      event,
      rawPrefersReducedMotion: unknown
    ): Promise<WindowSettingsSnapshot> => {
      const { state, win } = stateForSender(event)
      if (typeof rawPrefersReducedMotion !== "boolean") {
        throw new TypeError("Reduced-motion preference must be a boolean")
      }
      const latestSettings = await currentSettings()
      state.appearancePreview = null
      state.rendererReady = true
      if (state.provisional) markPendingTabDetachRendererReady(state)
      for (const tabId of state.tabIds) {
        const tab = tabStates.get(tabId)
        if (tab && !state.tabHydrations.has(tabId)) watchTabDocument(tab)
      }
      if (!win.isDestroyed()) {
        applyWindowZoom(win, latestSettings.zoomFactor)
        // The renderer sends editorReady only after CodeMirror owns focus.
        // Animated reveals and any eager-setup fallback wait for that stricter
        // milestone so they cannot enter the time-to-first-input path.
        const launchVisualSettings = cloneAppSettings(latestSettings)
        launchVisualSettings.launchTransition = {
          ...state.launchSettings.launchTransition,
        }
        state.pendingLaunchVisualEffect = {
          prefersReducedMotion: rawPrefersReducedMotion,
          settings: launchVisualSettings,
        }
        updateWindowNativeDocument(state)
        win.webContents.send(
          ipcChannels.tabDragActivity,
          activeDragTokens.size > 0
        )
        win.webContents.send(
          ipcChannels.windowActivationChanged,
          win.isFocused()
        )
      }
      return settingsSnapshotForWindow(state, latestSettings)
    }
  )

  ipcMain.handle(ipcChannels.getWindowProfiles, (event) =>
    serializeManagedResourceOperation(async () => {
      const { state } = stateForSender(event)
      return windowProfilesSnapshot(state.profileId)
    })
  )

  ipcMain.handle(
    ipcChannels.getCurrentWindowProfileSeed,
    (event, rawTabModes: unknown, rawKind: unknown): WindowProfileSeed => {
      const { state } = stateForSender(event)
      return currentWindowProfileSeed(state, rawTabModes, rawKind)
    }
  )

  ipcMain.handle(
    ipcChannels.saveWindowProfile,
    (event, rawProfile: unknown, rawReplace: unknown) =>
      serializeManagedResourceOperation(async () => {
        const { state } = stateForSender(event)
        if (typeof rawReplace !== "boolean") {
          throw new TypeError("Profile replacement flag must be a boolean")
        }
        const profile = normalizeProfileSchema(rawProfile, {
          sourceDirectory: profileStore.profileDirectory,
        })
        await validateProfileFileIdentities(profile)
        const openWindowId = profileWindows.get(profile.id)
        if (openWindowId !== undefined && openWindowId !== state.win.id) {
          throw new Error(
            `Close profile ${profile.id} in its other window before saving it`
          )
        }
        await Promise.all(
          profile.tabs.flatMap((tab) =>
            tab.kind === "scratch" ? [scratchStore.get(tab.scratchId)] : []
          )
        )
        await profileStore.save(profile, rawReplace)
        return windowProfilesSnapshot(state.profileId)
      })
  )

  ipcMain.handle(
    ipcChannels.deleteWindowProfile,
    (event, rawProfileId: unknown) =>
      serializeManagedResourceOperation(async () => {
        const { state } = stateForSender(event)
        if (typeof rawProfileId !== "string") {
          throw new TypeError("Profile id must be a string")
        }
        await deleteClosedWindowProfileDefinition(rawProfileId)
        return windowProfilesSnapshot(state.profileId)
      })
  )

  ipcMain.handle(
    ipcChannels.getScratches,
    async (event, rawQuery: unknown, rawSort: unknown, rawScope: unknown) => {
      const { state } = stateForSender(event)
      if (
        typeof rawQuery !== "string" ||
        rawQuery.length > 4096 ||
        !SCRATCH_SORT_ORDERS.includes(rawSort as ScratchSortOrder) ||
        !SCRATCH_INVENTORY_SCOPES.includes(rawScope as ScratchInventoryScope)
      ) {
        throw new TypeError("Invalid scratch query")
      }
      const scope = rawScope as ScratchInventoryScope
      const generation = advanceScopedRequest(
        state.scratchInventoryGenerations,
        scope
      )
      const cancelled = () =>
        state.win.isDestroyed() ||
        windowStates.get(state.win.id) !== state ||
        !scopedRequestIsCurrent(
          state.scratchInventoryGenerations,
          scope,
          generation
        )
      return await scratchInventory(
        rawQuery,
        rawSort as ScratchSortOrder,
        cancelled
      )
    }
  )

  ipcMain.handle(
    ipcChannels.getScratchPreview,
    (event, rawScratchId: unknown) =>
      serializeManagedResourceOperation(async (): Promise<ScratchPreview> => {
        stateForSender(event)
        if (!isScratchIdentifier(rawScratchId)) {
          throw new TypeError("Invalid scratch id")
        }
        const snapshot = await scratchStore.readPreview(rawScratchId)
        const decoded = await documentUtility.decode(snapshot.content)
        return {
          content: decoded.content,
          displayTitle:
            snapshot.entry.title ??
            snapshot.entry.fileName.replace(/\.md$/i, ""),
          fileName: snapshot.entry.fileName,
          format: {
            hasUtf8Bom: decoded.hasUtf8Bom,
            lineEnding: decoded.lineEnding,
          },
          modifiedAt: snapshot.modifiedAt,
          revision: snapshot.revision,
          scratchId: rawScratchId,
          truncated: snapshot.truncated,
        }
      })
  )

  ipcMain.handle(
    ipcChannels.updateScratch,
    (event, rawScratchId: unknown, rawUpdate: unknown) =>
      serializeManagedResourceOperation(async (): Promise<void> => {
        stateForSender(event)
        if (
          !isScratchIdentifier(rawScratchId) ||
          typeof rawUpdate !== "object" ||
          rawUpdate === null ||
          Array.isArray(rawUpdate)
        ) {
          throw new TypeError("Invalid scratch update")
        }
        const update = rawUpdate as ScratchUpdate
        const keys = Object.keys(update)
        if (
          keys.length === 0 ||
          keys.some((key) => key !== "fileName" && key !== "title") ||
          (update.fileName !== undefined &&
            typeof update.fileName !== "string") ||
          (update.title !== undefined &&
            update.title !== null &&
            typeof update.title !== "string")
        ) {
          throw new TypeError("Invalid scratch update")
        }
        const openTab = openScratchTab(rawScratchId)
        const releaseSaveTurn = openTab
          ? await acquireTabSaveTurn(openTab)
          : null
        try {
          const entry = await scratchStore.update(rawScratchId, update)
          if (openTab) {
            openTab.ioPath = path.join(scratchStore.directory, entry.fileName)
            openTab.document.displayName =
              openTab.title ??
              entry.title ??
              entry.fileName.replace(/\.md$/i, "")
            const owner = windowStates.get(openTab.ownerWindowId)
            if (owner && !owner.win.isDestroyed()) {
              try {
                sendTabsChanged(owner)
              } catch (error) {
                console.warn(
                  "Unable to broadcast committed scratch metadata",
                  error
                )
              }
            }
          }
        } finally {
          releaseSaveTurn?.()
        }
      })
  )

  ipcMain.handle(ipcChannels.deleteScratch, (event, rawScratchId: unknown) =>
    serializeManagedResourceOperation(async (): Promise<void> => {
      stateForSender(event)
      if (!isScratchIdentifier(rawScratchId)) {
        throw new TypeError("Invalid scratch id")
      }
      if (openScratchTab(rawScratchId)) {
        throw new Error("Close this scratch before deleting it")
      }
      const profiles = (await profileStore.list()).filter((profile) =>
        profile.tabs.some(
          (tab) => tab.kind === "scratch" && tab.scratchId === rawScratchId
        )
      )
      if (profiles.length > 0) {
        throw new Error(
          `Remove this scratch from ${profiles.map(({ name }) => name).join(", ")} before deleting it`
        )
      }
      await scratchStore.delete(rawScratchId)
    })
  )

  ipcMain.handle(
    ipcChannels.setDefaultWindowProfile,
    (event, rawProfileId: unknown) =>
      serializeManagedResourceOperation(async () => {
        const { state } = stateForSender(event)
        if (rawProfileId !== null && typeof rawProfileId !== "string") {
          throw new TypeError("Default profile id must be a string or null")
        }
        if (rawProfileId !== null) await profileStore.read(rawProfileId)
        await commitApplicationSettings(
          (current) => ({
            ...current,
            defaultWindowProfileId: rawProfileId,
          }),
          null
        )
        return windowProfilesSnapshot(state.profileId)
      })
  )

  ipcMain.handle(
    ipcChannels.selectWindowProfileFiles,
    async (event): Promise<WindowProfileFileChoice[]> => {
      const { win } = stateForSender(event)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Add Files to Window Profile",
        properties: ["openFile", "multiSelections"],
        filters: DOCUMENT_OPEN_FILTERS,
      })
      return canceled
        ? []
        : filePaths.map((filePath) => ({
            displayName: path.basename(filePath),
            path: path.resolve(filePath),
          }))
    }
  )

  ipcMain.handle(
    ipcChannels.launchWindowProfile,
    (event, rawProfileId: unknown) =>
      serializeManagedResourceOperation(async () => {
        const { state } = stateForSender(event)
        if (typeof rawProfileId !== "string") {
          throw new TypeError("Profile id must be a string")
        }
        return launchWindowProfileFromState(state, rawProfileId)
      })
  )

  registerOneWayIpcHandler(
    ipcChannels.previewAppearance,
    (event, rawAppearance: unknown): void => {
      const { state, win } = stateForSender(event)
      if (settingsSessionOwnerWindowId !== win.id) return
      state.appearancePreview =
        rawAppearance === null
          ? null
          : normalizeAppearanceSettings(rawAppearance)
      const appearance = state.appearancePreview ?? settings
      // On Windows, nativeTheme controls both Electron chrome and Chromium's
      // prefers-color-scheme result. Let a live System draft release any
      // explicit source immediately; session teardown restores the commit.
      applyWindowsNativeThemeSource(appearance)
      applyWindowVisualEffect(state, appearance)
    }
  )

  ipcMain.handle(ipcChannels.copyPath, (event, rawTabId: unknown): void => {
    const { state } = stateForSender(event)
    const filePath = ownedTabForState(state, rawTabId).document.filePath
    if (filePath) clipboard.writeText(filePath)
  })

  ipcMain.handle(
    ipcChannels.copyEditorLink,
    (event, rawAddress: unknown): void => {
      stateForSender(event)
      if (
        typeof rawAddress !== "string" ||
        rawAddress.length === 0 ||
        rawAddress.length > 131_072 ||
        rawAddress.includes("\0")
      ) {
        throw new TypeError("Invalid editor link address")
      }
      clipboard.writeText(rawAddress)
    }
  )

  ipcMain.handle(
    ipcChannels.copyHeadingLink,
    (event, rawTabId: unknown, rawFragment: unknown): void => {
      const { state } = stateForSender(event)
      const sourceTab = ownedTabForState(state, rawTabId)
      const fragment = normalizeLocalLinkFragment(rawFragment)
      if (fragment === null) {
        throw new TypeError("Heading link fragment is invalid")
      }
      const metadata: CopiedHeadingLinkMetadata = {
        fragment,
        sourcePath: sourceTab.document.filePath,
        sourceScratch: publicScratchIdentity(sourceTab.scratchIdentity),
        sourceTabId: sourceTab.id,
        version: 3,
      }
      const address = externalHeadingLinkAddress(
        metadata.sourcePath,
        metadata.sourceScratch,
        fragment,
        EXTERNAL_SCRATCH_LINK_SCHEME
      )
      clipboard.write({
        html: copiedHeadingLinkHtml(metadata, address),
        text: address,
      })
    }
  )

  ipcMain.handle(
    ipcChannels.resolveHeadingLinkPaste,
    (event, rawTabId: unknown, rawMetadata: unknown): string => {
      const { state } = stateForSender(event)
      const targetTab = ownedTabForState(state, rawTabId)
      const metadata = normalizeCopiedHeadingLinkMetadata(rawMetadata)
      return headingLinkForPaste(
        targetTab.document.filePath,
        publicScratchIdentity(targetTab.scratchIdentity),
        targetTab.id,
        metadata,
        EXTERNAL_SCRATCH_LINK_SCHEME
      )
    }
  )

  ipcMain.handle(
    ipcChannels.revealPath,
    async (event, rawTabId: unknown): Promise<void> => {
      const { state, win } = stateForSender(event)
      const filePath = ownedTabForState(state, rawTabId).document.filePath
      if (!filePath) return
      try {
        try {
          await lstat(filePath)
          shell.showItemInFolder(filePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          const openError = await shell.openPath(path.dirname(filePath))
          if (openError) throw new Error(openError, { cause: error })
        }
      } catch (error) {
        if (!win.isDestroyed()) {
          await showOperationError(
            win,
            "Reveal Failed",
            "The document could not be shown in its folder.",
            error
          )
        }
      }
    }
  )

  ipcMain.handle(
    ipcChannels.openExternalLink,
    async (event, rawUrl: unknown): Promise<void> => {
      const { win } = stateForSender(event)
      const url = normalizeExternalLink(rawUrl)
      try {
        await shell.openExternal(url)
      } catch (error) {
        if (!win.isDestroyed()) {
          await showOperationError(
            win,
            "Open Link Failed",
            "The link could not be opened.",
            error
          )
        }
      }
    }
  )

  ipcMain.handle(
    ipcChannels.completePath,
    async (
      event,
      rawSourceTabId: unknown,
      rawPath: unknown
    ): Promise<readonly PathCompletionEntry[]> => {
      const { state } = stateForSender(event)
      const sourceTab = ownedTabForState(state, rawSourceTabId)
      const generation = ++state.pathCompletionGeneration
      const cancelled = () =>
        windowStates.get(state.win.id) !== state ||
        state.pathCompletionGeneration !== generation
      return filesystemPathCompletions({
        cancelled,
        homeDirectory: app.getPath("home"),
        query: rawPath,
        sourceFilePath: sourceTab.document.filePath,
      })
    }
  )

  ipcMain.handle(
    ipcChannels.openLocalLink,
    async (
      event,
      rawSourceTabId: unknown,
      rawDestination: unknown,
      rawFragment: unknown,
      rawDisposition: unknown
    ): Promise<OpenLocalLinkResult | null> => {
      const { state, win } = stateForSender(event)
      ensureWindowMutable(state)
      let sourceTab = ownedTabForState(state, rawSourceTabId)
      try {
        const requestedDisposition =
          normalizeLocalLinkDisposition(rawDisposition)
        const fragment = normalizeLocalLinkFragment(rawFragment)
        const destinationPath = localLinkPath(sourceTab, rawDestination)
        const destinationDisplayPath = path.resolve(destinationPath)
        let destinationIsFile = false
        try {
          destinationIsFile = (await stat(destinationPath)).isFile()
        } catch {
          // Let the platform opener report missing or inaccessible targets.
        }
        if (requestedDisposition === "new-tab") {
          const existing = destinationIsFile
            ? openLinkedFileTab(await realpath(destinationPath), state)
            : openLinkedFileTab(destinationPath, state, destinationDisplayPath)
          if (existing) {
            return activateLinkedDocumentTab(existing, state, fragment)
          }
        }
        if (
          !destinationIsFile ||
          !isInternalTextDocumentPath(destinationPath)
        ) {
          const error = await shell.openPath(destinationPath)
          if (error) throw new Error(error)
          return { kind: "external" }
        }

        const loaded = await readDocument(destinationPath)
        if (!windowCanAcceptOpenedDocuments(state, win)) {
          return null
        }

        if (requestedDisposition === "new-tab") {
          const existing = openLinkedFileTab(loaded.ioPath, state)
          if (existing) {
            return activateLinkedDocumentTab(existing, state, fragment)
          }
        }

        sourceTab = ownedTabForState(state, sourceTab.id)
        if (tabSaveActive(sourceTab)) {
          await waitForTabSaveIdle(sourceTab)
          if (!windowCanAcceptOpenedDocuments(state, win)) return null
          sourceTab = ownedTabForState(state, sourceTab.id)
        }

        // A scratch tab's storage identity must remain attached to its
        // document session. An absolute link can still be followed from one,
        // but it cannot replace that specialized session.
        const disposition =
          requestedDisposition === "current-tab" &&
          sourceTab.backing === "scratch"
            ? "new-tab"
            : requestedDisposition

        if (disposition === "current-tab") {
          if (state.activeTabId !== sourceTab.id) return null
          const decision = await promptForCurrentTabNavigation(win, sourceTab)
          if (decision === "cancel") return null
          if (decision === "save") return { kind: "save-required" }
          if (
            !windowCanAcceptOpenedDocuments(state, win) ||
            !tabStillOwnedByState(state, sourceTab) ||
            state.activeTabId !== sourceTab.id
          ) {
            return null
          }

          abortPendingTransfersForTab(sourceTab.id)
          unwatchTabDocument(sourceTab.id)
          state.approvedTabCloses.delete(sourceTab.id)
          sourceTab.backing = "file"
          sourceTab.diskContentHash = loaded.contentHash
          sourceTab.diskFingerprint = loaded.fingerprint
          sourceTab.dirty = false
          sourceTab.document = loaded.document
          sourceTab.fileMissing = false
          sourceTab.ioPath = loaded.ioPath
          sourceTab.saveGeneration += 1
          updateWindowNativeDocument(state)
          const openedBootstrap = bootstrapTab(sourceTab)
          sourceTab.document.content = ""
          watchTabDocument(sourceTab)
          if (sourceTab.document.filePath) {
            addRecentDocument(sourceTab.document.filePath)
          }
          return {
            kind: "document",
            disposition,
            openedTab: openedBootstrap,
            window: windowSnapshot(state),
          }
        }

        const openedTab = createTabState(
          state.win.id,
          loaded.document,
          loaded.contentHash,
          loaded.ioPath,
          { diskFingerprint: loaded.fingerprint }
        )
        state.tabIds.push(openedTab.id)
        state.activeTabId = openedTab.id
        updateWindowNativeDocument(state)
        const openedBootstrap = bootstrapTab(openedTab)
        openedTab.document.content = ""
        watchTabDocument(openedTab)
        if (openedTab.document.filePath) {
          addRecentDocument(openedTab.document.filePath)
        }
        return {
          kind: "document",
          disposition,
          openedTab: openedBootstrap,
          window: windowSnapshot(state),
        }
      } catch (error) {
        if (!win.isDestroyed()) {
          await showOperationError(
            win,
            "Open Link Failed",
            "The linked file could not be opened.",
            error
          )
        }
        return null
      }
    }
  )

  ipcMain.handle(
    ipcChannels.openScratchLink,
    (
      event,
      rawSourceTabId: unknown,
      rawIdentity: unknown,
      rawFragment: unknown,
      rawScheme: unknown
    ) =>
      serializeManagedResourceOperation(
        async (): Promise<OpenLocalLinkResult | null> => {
          const { state, win } = stateForSender(event)
          ensureWindowMutable(state)
          const sourceTab = ownedTabForState(state, rawSourceTabId)
          try {
            const identity = normalizeScratchLinkIdentity(rawIdentity)
            const fragment = normalizeLocalLinkFragment(rawFragment)
            if (
              !isScratchLinkScheme(rawScheme) ||
              rawScheme !== EXTERNAL_SCRATCH_LINK_SCHEME
            ) {
              throw new TypeError(
                "The scratch link belongs to another Pulse MD channel"
              )
            }
            const result = await openScratchInWindow(
              state,
              identity.scratchId,
              "new-tab",
              fragment
            )
            if (!result || !tabStillOwnedByState(state, sourceTab)) return null
            return result.kind === "document"
              ? {
                  kind: "document",
                  disposition: "new-tab",
                  openedTab: result.openedTab,
                  window: result.window,
                }
              : result
          } catch (error) {
            if (!win.isDestroyed()) {
              await showOperationError(
                win,
                "Open Link Failed",
                "The linked scratch could not be opened.",
                error
              )
            }
            return null
          }
        }
      )
  )

  ipcMain.handle(ipcChannels.newTab, async (event): Promise<NewTabResult> => {
    const { state } = stateForSender(event)
    await waitForTabMutation(state)
    ensureWindowMutable(state)
    const tab = createTabState(state.win.id)
    state.tabIds.push(tab.id)
    state.activeTabId = tab.id
    updateWindowNativeDocument(state)
    return {
      createdTab: bootstrapTab(tab),
      window: windowSnapshot(state),
    }
  })

  ipcMain.handle(
    ipcChannels.openScratch,
    (
      event,
      rawScratchId: unknown,
      rawDisposition: unknown
    ): Promise<OpenScratchResult | null> =>
      serializeManagedResourceOperation(async () => {
        const { state } = stateForSender(event)
        await waitForTabMutation(state)
        ensureWindowMutable(state)
        if (
          !isScratchIdentifier(rawScratchId) ||
          (rawDisposition !== "default" && rawDisposition !== "new-tab")
        ) {
          throw new TypeError("Invalid scratch open request")
        }
        return openScratchInWindow(state, rawScratchId, rawDisposition)
      })
  )

  ipcMain.handle(
    ipcChannels.newScratch,
    (event): Promise<OpenScratchResult | null> =>
      serializeManagedResourceOperation(async () => {
        const { state, win } = stateForSender(event)
        await waitForTabMutation(state)
        ensureWindowMutable(state)
        try {
          const scratch = await scratchStore.create({ markOpened: false })
          return await openScratchInWindow(state, scratch.id, "default")
        } catch (error) {
          if (!win.isDestroyed()) {
            await showOperationError(
              win,
              "New Scratch Failed",
              "The scratch could not be created.",
              error
            )
          }
          return null
        }
      })
  )

  ipcMain.handle(
    ipcChannels.openDocument,
    async (
      event,
      rawReplaceActive: unknown
    ): Promise<OpenDocumentResult | null> => {
      const { state, win } = stateForSender(event)
      ensureWindowMutable(state)
      if (typeof rawReplaceActive !== "boolean") {
        throw new TypeError("Open replacement flag must be boolean")
      }
      const replacementCandidateId = rawReplaceActive ? state.activeTabId : null
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Open Document",
        properties: ["openFile", "multiSelections"],
        filters: DOCUMENT_OPEN_FILTERS,
      })
      if (canceled || filePaths.length === 0) return null

      return openDocumentsInWindow(state, filePaths, replacementCandidateId)
    }
  )

  ipcMain.handle(
    ipcChannels.openDroppedDocuments,
    async (
      event,
      rawFilePaths: unknown,
      rawReplaceActive: unknown
    ): Promise<OpenDocumentResult | null> => {
      const { state, win } = stateForSender(event)
      ensureWindowMutable(state)
      if (typeof rawReplaceActive !== "boolean") {
        throw new TypeError("Open replacement flag must be boolean")
      }
      const replacementCandidateId = rawReplaceActive ? state.activeTabId : null
      let filePaths: string[]
      try {
        filePaths = normalizeDroppedDocumentPaths(rawFilePaths)
      } catch (error) {
        if (windowCanAcceptOpenedDocuments(state, win)) {
          await showOperationError(
            win,
            "Open Failed",
            "The dropped documents could not be opened.",
            error
          )
        }
        return null
      }
      return openDocumentsInWindow(state, filePaths, replacementCandidateId)
    }
  )

  ipcMain.handle(
    ipcChannels.activateTab,
    async (event, rawTabId: unknown): Promise<WindowTabsSnapshot> => {
      const { state } = stateForSender(event)
      ensureWindowMutable(state)
      const tab = ownedTabForState(state, rawTabId)
      activateTabInState(state, tab.id)
      return windowSnapshot(state)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.setActiveTab,
    (event, rawTabId: unknown) => {
      const { state } = stateForSender(event)
      if (state.closeSequence || state.allowClose || state.tabMutationLocked) {
        return
      }
      const tab = ownedTabForState(state, rawTabId)
      activateTabInState(state, tab.id)
    }
  )

  ipcMain.handle(
    ipcChannels.reorderTab,
    async (
      event,
      rawTabId: unknown,
      rawIndex: unknown
    ): Promise<WindowTabsSnapshot> => {
      const { state } = stateForSender(event)
      ensureWindowMutable(state)
      const tab = ownedTabForState(state, rawTabId)
      if (
        typeof rawIndex !== "number" ||
        !Number.isInteger(rawIndex) ||
        rawIndex < 0 ||
        rawIndex >= state.tabIds.length
      ) {
        throw new TypeError("Tab index is out of range")
      }
      removeTabFromState(state, tab.id)
      state.tabIds.splice(rawIndex, 0, tab.id)
      return windowSnapshot(state)
    }
  )

  ipcMain.handle(
    ipcChannels.requestCloseTab,
    async (event, rawTabId: unknown): Promise<CloseDecision> => {
      const { state, win } = stateForSender(event)
      if (state.closeSequence || state.tabMutationLocked) return "cancel"
      let tab = ownedTabForState(state, rawTabId)
      if (tabSaveActive(tab)) await waitForTabSaveIdle(tab)
      if (state.closeSequence || state.allowClose || state.tabMutationLocked) {
        return "cancel"
      }
      tab = ownedTabForState(state, tab.id)
      const dirtyBeforePrompt = tab.dirty
      const decision = await promptForTabClose(win, tab)
      if (
        state.closeSequence ||
        state.allowClose ||
        state.tabMutationLocked ||
        !tabStillOwnedByState(state, tab) ||
        decision === "cancel"
      ) {
        state.approvedTabCloses.delete(tab.id)
        return "cancel"
      }
      if (decision === "save") {
        state.approvedTabCloses.set(tab.id, "save")
      } else if (dirtyBeforePrompt) {
        state.approvedTabCloses.set(tab.id, "discard")
      } else {
        state.approvedTabCloses.set(tab.id, "clean")
      }
      return decision
    }
  )

  ipcMain.handle(
    ipcChannels.finalizeCloseTab,
    async (
      event,
      rawTabId: unknown,
      rawViewport: unknown
    ): Promise<WindowTabsSnapshot | null> => {
      const { state, win } = stateForSender(event)
      const tab = ownedTabForState(state, rawTabId)
      const viewport =
        rawViewport === null ? null : normalizeEditorViewport(rawViewport)
      if (
        state.closeSequence ||
        state.tabMutationLocked ||
        tabSaveActive(tab)
      ) {
        throw new Error("Tab cannot close during another operation")
      }
      const approval = state.approvedTabCloses.get(tab.id)
      if (!approval) throw new Error("Tab close has not been approved")
      if (approval !== "discard" && tab.dirty) {
        state.approvedTabCloses.delete(tab.id)
        throw new Error("The tab changed after its close was approved")
      }
      state.approvedTabCloses.delete(tab.id)

      if (state.tabIds.length === 1) {
        rememberClosedDocument(tab, viewport)
        state.rememberWhenClosed = false
        state.allowClose = true
        setImmediate(() => {
          if (!win.isDestroyed()) win.close()
        })
        return null
      }

      abortPendingTransfersForTab(tab.id)
      const index = removeTabFromState(state, tab.id)
      rememberClosedDocument(tab, viewport)
      disposeTabState(tab)
      if (state.activeTabId === tab.id) {
        state.activeTabId =
          state.tabIds[Math.min(index, state.tabIds.length - 1)]
      }
      updateWindowNativeDocument(state)
      return windowSnapshot(state)
    }
  )

  ipcMain.handle(
    ipcChannels.saveDocument,
    async (event, rawRequest: unknown): Promise<SaveDocumentResult | null> => {
      const { state, win } = stateForSender(event)
      const request = normalizeSaveRequest(rawRequest)
      const tab = ownedTabForState(state, request.tabId)
      if (
        state.tabMutationLocked ||
        state.allowClose ||
        (state.closeSequence && state.pendingCloseSave?.tabId !== tab.id)
      ) {
        return null
      }
      abortPendingTransfersForTab(tab.id)
      const pendingCloseSave = suspendPendingCloseSaveTimeout(state, tab.id)
      const releaseSaveTurn = await acquireTabSaveTurn(tab)
      let watcherSuspended = false

      try {
        if (!tabStillOwnedByState(state, tab)) return null
        if (request.saveAsScratch) {
          if (
            tab.backing !== "untitled" ||
            tab.document.filePath !== null ||
            tab.ioPath !== null ||
            tab.scratchIdentity !== null
          ) {
            throw new Error(
              "Only a pathless untitled tab can be saved as a scratch"
            )
          }
          const encodedDocument = await documentUtility.encode(
            request.content,
            request.format
          )
          return await serializeManagedResourceOperation(async () => {
            if (!tabStillOwnedByState(state, tab)) return null
            const entry = await scratchStore.create({
              content: encodedDocument.buffer,
              markOpened: false,
            })
            const scratchPath = await scratchStore.pathFor(entry.id)
            const loaded = await readDocument(scratchPath)
            if (!tabStillOwnedByState(state, tab)) return null
            tab.backing = "scratch"
            tab.diskContentHash = encodedDocument.contentHash
            tab.diskFingerprint = loaded.fingerprint
            tab.document = {
              content: "",
              displayName: entry.fileName.replace(/\.md$/i, ""),
              filePath: null,
              format: { ...request.format },
              kind: "markdown",
              mtimeMs: loaded.document.mtimeMs,
            }
            tab.fileMissing = false
            tab.ioPath = loaded.ioPath
            tab.scratchIdentity = { scratchId: entry.id }
            registerOpenScratchTab(entry.id, tab.id)
            tab.saveGeneration += 1
            clearPendingExternalDocumentChange(tab.id)
            updateWindowNativeDocument(state)
            sendTabsChanged(state)
            const pending = createPendingSaveAcknowledgement(
              tab,
              request.revision
            )
            return {
              document: tabDocumentMetadata(tab),
              revision: request.revision,
              saveToken: pending.token,
              tab: tabDescriptor(tab),
            }
          })
        }
        const scratchSave = tab.backing === "scratch"
        let displayPath = request.filePath
          ? path.resolve(request.filePath)
          : null
        let targetPath: string | null = null
        let copyPath: string | null = null
        let copyExpectedBaseline: SaveTargetBaseline = {
          contentHash: null,
          mode: undefined,
          mtimeMs: null,
        }
        const usedSaveDialog = request.saveAs || (!scratchSave && !displayPath)

        if (
          !usedSaveDialog &&
          (!tab.ioPath ||
            (!scratchSave &&
              (!displayPath ||
                !tab.document.filePath ||
                tab.document.filePath !== displayPath)))
        ) {
          throw new Error(
            "A document can only be saved to its current path without Save As"
          )
        }

        if (usedSaveDialog) {
          const result = await dialog.showSaveDialog(win, {
            title: scratchSave
              ? "Save a Copy of Scratch Document"
              : "Save Document",
            defaultPath:
              displayPath ?? tab.document.filePath ?? suggestedSaveName(tab),
          })
          if (result.canceled || !result.filePath) return null
          if (!tabStillOwnedByState(state, tab)) return null
          displayPath = path.resolve(result.filePath)
          const selectedPath = scratchSave
            ? await scratchStore.canonicalizeExportPath(displayPath)
            : await canonicalizeSavePath(displayPath)
          if (scratchSave) {
            copyPath = selectedPath
            targetPath = tab.ioPath
            copyExpectedBaseline = await readSaveTargetBaseline(copyPath)
          } else {
            targetPath = selectedPath
          }
        } else {
          targetPath = tab.ioPath
        }

        if ((!scratchSave && !displayPath) || !targetPath) {
          throw new Error("A save path was not selected")
        }
        if (scratchSave) {
          const identity = tab.scratchIdentity
          if (!identity) {
            throw new Error("The scratch document has no storage identity")
          }
          const validatedTarget = await scratchStore.pathFor(identity.scratchId)
          if (validatedTarget !== tab.ioPath || targetPath !== tab.ioPath) {
            throw new Error(
              "The scratch storage path changed while it was open"
            )
          }
          targetPath = validatedTarget
        }
        let expectedBaseline: SaveTargetBaseline = {
          contentHash: tab.diskContentHash,
          mode: undefined,
          mtimeMs: tab.document.mtimeMs,
        }
        if (usedSaveDialog && !scratchSave) {
          expectedBaseline = await readSaveTargetBaseline(targetPath)
        }
        if (
          !tabStillOwnedByState(state, tab) ||
          state.allowClose ||
          (!usedSaveDialog && tab.ioPath !== targetPath) ||
          (scratchSave && tab.ioPath !== targetPath)
        ) {
          return null
        }
        const encodedDocument = await documentUtility.encode(
          request.content,
          request.format
        )
        if (copyPath) {
          const committedCopy = await atomicWrite(
            copyPath,
            encodedDocument.buffer,
            async () => {
              const approval = await confirmExternalOverwrite(
                win,
                copyPath,
                copyExpectedBaseline
              )
              if (!approval || !tabStillOwnedByState(state, tab)) return null
              return {
                mode: approval.replacementMode,
                validate: async () =>
                  tabStillOwnedByState(state, tab) &&
                  saveTargetBaselinesMatch(
                    await readSaveTargetBaseline(copyPath),
                    approval.baseline
                  ),
              }
            }
          )
          if (!committedCopy) return null
        }
        const beforeReplace = scratchSave
          ? undefined
          : async () => {
              const approval = await confirmExternalOverwrite(
                win,
                targetPath,
                expectedBaseline
              )
              if (!approval || !tabStillOwnedByState(state, tab)) {
                return null
              }
              unwatchTabDocument(tab.id, true)
              watcherSuspended = true
              return {
                mode: approval.replacementMode,
                validate: async () =>
                  tabStillOwnedByState(state, tab) &&
                  saveTargetBaselinesMatch(
                    await readSaveTargetBaseline(targetPath),
                    approval.baseline
                  ),
              }
            }
        const committed = await atomicWrite(
          targetPath,
          encodedDocument.buffer,
          beforeReplace
        )
        if (!committed || !tabStillOwnedByState(state, tab)) return null
        tab.document = scratchSave
          ? {
              ...tab.document,
              content: "",
              filePath: null,
              format: { ...request.format },
              kind: "markdown",
              mtimeMs: committed.mtimeMs,
            }
          : {
              content: "",
              displayName: path.basename(displayPath!),
              filePath: displayPath,
              format: { ...request.format },
              kind: documentKindForPath(displayPath),
              mtimeMs: committed.mtimeMs,
            }
        if (!scratchSave) {
          tab.backing = "file"
          tab.fileMissing = false
          tab.scratchIdentity = null
        }
        tab.diskContentHash = encodedDocument.contentHash
        tab.diskFingerprint = committed
        tab.ioPath = targetPath
        tab.saveGeneration += 1
        clearPendingExternalDocumentChange(tab.id)
        watchTabDocument(tab)
        if (!scratchSave && tab.document.filePath) {
          addRecentDocument(tab.document.filePath)
        }
        watcherSuspended = false
        updateWindowNativeDocument(state)
        sendTabsChanged(state)
        const pending = createPendingSaveAcknowledgement(tab, request.revision)
        return {
          document: tabDocumentMetadata(tab),
          revision: request.revision,
          saveToken: pending.token,
          tab: tabDescriptor(tab),
        }
      } catch (error) {
        if (!request.automatic && !win.isDestroyed()) {
          await showOperationError(
            win,
            "Save Failed",
            "The document could not be saved.",
            error
          )
        }
        return null
      } finally {
        if (watcherSuspended && tabStates.get(tab.id) === tab) {
          watchTabDocument(tab, true)
        }
        releaseSaveTurn()
        if (pendingCloseSave) armPendingCloseSaveTimeout(state, tab.id)
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeDocumentSave,
    (event, rawAcknowledgement: unknown) => {
      const { state } = stateForSender(event)
      const acknowledgement = normalizeSaveAcknowledgement(rawAcknowledgement)
      const pending = pendingSaveAcknowledgements.get(acknowledgement.saveToken)
      if (
        !pending ||
        pending.ownerWindowId !== state.win.id ||
        pending.tabId !== acknowledgement.tabId ||
        pending.revision !== acknowledgement.revision
      ) {
        return
      }

      const tab = tabStates.get(pending.tabId)
      const mayMarkClean =
        acknowledgement.current &&
        tab?.ownerWindowId === state.win.id &&
        tab.saveGeneration === pending.generation
      clearPendingSaveAcknowledgement(pending.token)
      if (!mayMarkClean || !tab || !tab.dirty) return
      tab.dirty = false
      updateWindowNativeDocument(state)
      sendTabsChanged(state)
      if (BrowserWindow.getFocusedWindow()?.id === state.win.id) {
        updateViewMenuItems(state)
      }
      scheduleExternalRefresh(tab.id)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.setDirty,
    (event, rawTabId: unknown, dirty: unknown) => {
      const { state } = stateForSender(event)
      if (typeof dirty !== "boolean") {
        throw new TypeError("Dirty state must be boolean")
      }
      const tab = ownedTabForState(state, rawTabId)
      if (state.tabMutationLocked) {
        if (!dirty && tabSaveActive(tab)) return
        trackDeferredExternalRefresh(
          state.tabMutationExternalRefreshTabIds,
          tab.id,
          dirty
        )
        if (tab.dirty !== dirty) {
          tab.dirty = dirty
          state.tabMutationMetadataChanged = true
        }
        return
      }
      if (!dirty && tabSaveActive(tab)) return
      if (tab.dirty === dirty) {
        if (!dirty) scheduleExternalRefresh(tab.id)
        return
      }
      tab.dirty = dirty
      updateWindowNativeDocument(state)
      sendTabsChanged(state)
      if (BrowserWindow.getFocusedWindow()?.id === state.win.id) {
        updateViewMenuItems(state)
      }
      if (!dirty) scheduleExternalRefresh(tab.id)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeExternalDocumentChange,
    (event, rawChangeId: unknown, applied: unknown) => {
      const { state } = stateForSender(event)
      const changeId = normalizeIdentifier(rawChangeId, "Change id")
      if (typeof applied !== "boolean") {
        throw new TypeError("External document acknowledgement must be boolean")
      }

      const pendingTabId = pendingExternalChangeTabsByChangeId.get(changeId)
      const pending =
        pendingTabId === undefined
          ? undefined
          : pendingExternalDocumentChanges.get(pendingTabId)
      if (!pending || !pendingTabId || pending.ownerWindowId !== state.win.id) {
        return
      }
      clearPendingExternalDocumentChange(pendingTabId)

      const tab = tabStates.get(pendingTabId)
      abortPendingTransfersForTab(pendingTabId)
      if (
        applied &&
        tab?.ownerWindowId === state.win.id &&
        tab.document.filePath === pending.change.document.filePath &&
        tab.document.mtimeMs === pending.change.expectedMtimeMs
      ) {
        tab.document = {
          ...pending.change.document,
          content: "",
          format: { ...pending.change.document.format },
        }
        tab.diskContentHash = pending.contentHash
        tab.diskFingerprint = pending.fingerprint
        tab.fileMissing = false
        tab.dirty = false
        updateWindowNativeDocument(state)
        sendTabsChanged(state)
        scheduleExternalRefresh(tab.id, 0)
      } else if (tab && !tab.dirty) {
        scheduleExternalRefresh(tab.id, EXTERNAL_CHANGE_RETRY_MS)
      }
    }
  )

  registerOneWayIpcHandler(ipcChannels.closeReady, (event, allow: unknown) => {
    const { state } = stateForSender(event)
    if (typeof allow !== "boolean") {
      throw new TypeError("Close readiness must be boolean")
    }
    const pending = state.pendingCloseSave
    if (!pending) return
    const tab = tabStates.get(pending.tabId)
    finishPendingCloseSave(
      state,
      allow && tab?.ownerWindowId === state.win.id && tab.dirty === false
    )
  })

  registerOneWayIpcHandler(
    ipcChannels.windowClosePrepared,
    (event, allow: unknown) => {
      const { state } = stateForSender(event)
      if (typeof allow !== "boolean") {
        throw new TypeError(
          "Window close preparation readiness must be boolean"
        )
      }
      finishPendingWindowClosePreparation(state, allow)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.acknowledgeTabDetachSourceRetired,
    (event, rawDragToken: unknown) => {
      const { state } = stateForSender(event)
      const dragToken = normalizeIdentifier(rawDragToken, "Drag token")
      const pending = pendingTabDetaches.get(dragToken)
      if (
        !pending ||
        pending.sourceWindowId !== state.win.id ||
        !pending.released ||
        !pending.sourceVisuallyRetired
      ) {
        return
      }
      pending.sourceRetirementAcknowledged = true
      if (pending.retirementTimeout) clearTimeout(pending.retirementTimeout)
      pending.retirementTimeout = null
      releasePendingTabDetachSourceRenderingLease(pending)
      maybeFinalizePendingTabDetach(pending)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.beginTabDrag,
    (event, rawTabId: unknown, rawGeometry: unknown) => {
      const { state } = stateForSender(event)
      ensureWindowMutable(state)
      const tab = ownedTabForState(state, rawTabId)
      if (tabSaveActive(tab) || pendingExternalDocumentChanges.has(tab.id)) {
        event.returnValue = ""
        return
      }
      clearExpiredDragTokens(false)
      for (const token of dragTokens.values()) {
        if (token.tabId === tab.id) deleteDragToken(token.token, false)
      }
      const token = randomUUID()
      const candidateGeometry = normalizeTabDragGeometry(rawGeometry)
      const windowBounds = state.win.getBounds()
      const geometry =
        state.tabIds.length > 1 &&
        candidateGeometry &&
        candidateGeometry.sourceStripBounds.x >= windowBounds.x - 2 &&
        candidateGeometry.sourceStripBounds.y >= windowBounds.y - 2 &&
        candidateGeometry.sourceStripBounds.x +
          candidateGeometry.sourceStripBounds.width <=
          windowBounds.x + windowBounds.width + 2 &&
        candidateGeometry.sourceStripBounds.y +
          candidateGeometry.sourceStripBounds.height <=
          windowBounds.y + windowBounds.height + 2 &&
        candidateGeometry.cursorOffset.x >= 0 &&
        candidateGeometry.cursorOffset.x <= windowBounds.width &&
        candidateGeometry.cursorOffset.y >= 0 &&
        candidateGeometry.cursorOffset.y <= windowBounds.height
          ? candidateGeometry
          : null
      dragTokens.set(token, {
        cancelled: false,
        claimedTransferId: null,
        createdAt: Date.now(),
        editorSession: null,
        exportRequestId: null,
        exportWaiters: new Set(),
        geometry,
        lastCursorPoint: null,
        sourceWindowId: state.win.id,
        tabId: tab.id,
        timeout: setTimeout(
          () => deleteDragToken(token),
          DRAG_TOKEN_LIFETIME_MS
        ),
        token,
      })
      activeDragTokens.add(token)
      broadcastTabDragActivity()
      updateTabDragTracking()
      event.returnValue = token
    },
    (event) => {
      event.returnValue = ""
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.endTabDrag,
    (event, rawDetails: unknown) => {
      const { state } = stateForSender(event)
      const details = normalizeTabDragEndDetails(rawDetails)
      const token = dragTokens.get(details.dragToken)
      if (!token || token.sourceWindowId !== state.win.id) return
      if (token.geometry && consumeMacTabDragEscape()) token.cancelled = true
      deactivateTabDrag(details.dragToken)
      const pending = pendingTabDetaches.get(details.dragToken)
      if (details.cancelled || token.cancelled) {
        if (
          token.claimedTransferId &&
          pendingTransfers.has(token.claimedTransferId)
        ) {
          abortPendingTransfer(token.claimedTransferId)
        } else if (pending) abortPendingTabDetach(pending)
        else deleteDragToken(details.dragToken)
        return
      }
      const point =
        details.screenPoint.x === 0 && details.screenPoint.y === 0
          ? (token.lastCursorPoint ?? screen.getCursorScreenPoint())
          : details.screenPoint
      token.lastCursorPoint = point
      const existingTarget = tabDropTargetAtPoint(state.win.id, point)
      if (!token.geometry || state.tabIds.length <= 1) {
        if (
          token.claimedTransferId &&
          pendingTransfers.get(token.claimedTransferId)?.dragToken ===
            token.token
        ) {
          return
        }
        deleteDragToken(details.dragToken)
        return
      }
      const releasedOutsideSource = shouldPrepareTabTearOut(
        point,
        state.win.getBounds(),
        token.geometry.sourceStripBounds
      )
      if (!releasedOutsideSource) {
        if (pending) abortPendingTabDetach(pending)
        else deleteDragToken(details.dragToken)
        return
      }
      if (existingTarget) {
        const cleanup = setTimeout(() => {
          const liveToken = dragTokens.get(details.dragToken)
          if (!liveToken) return
          if (
            [...pendingTransfers.values()].some(
              (transfer) => transfer.dragToken === details.dragToken
            )
          ) {
            return
          }
          // Geometry alone cannot prove that an app window was the native
          // destination; another application's front window may overlap it.
          // Only requestTabTransfer is an internal-drop claim.
          releaseTabDragAsDetach(liveToken, point)
        }, INTERNAL_TAB_DROP_CLAIM_GRACE_MS)
        cleanup.unref()
        return
      }
      releaseTabDragAsDetach(token, point)
    }
  )

  ipcMain.handle(
    ipcChannels.requestTabTransfer,
    async (
      event,
      rawDragToken: unknown,
      rawIndex: unknown
    ): Promise<TabTransferImport | null> => {
      const { state: targetState } = stateForSender(event)
      const dragToken = normalizeIdentifier(rawDragToken, "Drag token")
      clearExpiredDragTokens()
      const token = dragTokens.get(dragToken)
      const provisionalDetach = token
        ? pendingTabDetaches.get(dragToken)
        : undefined
      if (targetState.provisional) {
        if (
          provisionalDetach?.targetWindowId === targetState.win.id &&
          !targetState.win.isDestroyed()
        ) {
          // This is the hit-testable provisional window consuming the native
          // drop so an external app underneath cannot claim it. Ownership is
          // still finalized only by the source drag-end transaction.
          targetState.win.setIgnoreMouseEvents(true)
        }
        return null
      }
      ensureWindowMutable(targetState)
      if (
        !token ||
        token.cancelled ||
        token.sourceWindowId === targetState.win.id
      ) {
        return null
      }
      token.geometry = null
      const pendingDetach = pendingTabDetaches.get(dragToken)
      if (pendingDetach) abortPendingTabDetach(pendingDetach, false)
      updateTabDragTracking()
      if (
        typeof rawIndex !== "number" ||
        !Number.isInteger(rawIndex) ||
        rawIndex < 0 ||
        rawIndex > targetState.tabIds.length
      ) {
        throw new TypeError("Transfer index is out of range")
      }
      const sourceState = windowStates.get(token.sourceWindowId)
      const tab = tabStates.get(token.tabId)
      if (
        !sourceState ||
        sourceState.win.isDestroyed() ||
        sourceState.closeSequence !== null ||
        sourceState.allowClose ||
        sourceState.tabMutationLocked ||
        !tab ||
        tab.ownerWindowId !== sourceState.win.id ||
        tabSaveActive(tab) ||
        pendingExternalDocumentChanges.has(tab.id) ||
        [...pendingTransfers.values()].some(
          (pending) => pending.tabId === token.tabId
        )
      ) {
        deleteDragToken(dragToken)
        return null
      }

      const transferId = randomUUID()
      const pending: PendingTransfer = {
        dragToken,
        editorSession: null,
        sourceWindowId: sourceState.win.id,
        tabId: tab.id,
        targetConfirmed: false,
        targetIndex: rawIndex,
        targetWindowId: targetState.win.id,
        timeout: null,
        transferId,
      }
      pendingTransfers.set(transferId, pending)
      token.claimedTransferId = transferId
      pending.timeout = setTimeout(
        () => abortPendingTransfer(transferId),
        TAB_EXPORT_TIMEOUT_MS
      )
      const editorSession = await requestDragTokenExport(token)
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.timeout = null
      if (!editorSession || pendingTransfers.get(transferId) !== pending) {
        abortPendingTransfer(transferId)
        return null
      }
      pending.editorSession = editorSession
      pending.timeout = setTimeout(
        () => abortPendingTransfer(transferId),
        TAB_EXPORT_TIMEOUT_MS
      )
      return {
        transferId,
        sourceWindowId: sourceState.win.id,
        tab: tabDescriptor(tab),
        document: documentMetadata(tab.document),
        editorSession,
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.provideTabExport,
    (event, rawResponse: unknown) => {
      const { state } = stateForSender(event)
      const response = normalizeTabExportResponse(rawResponse)
      const token = [...dragTokens.values()].find(
        (candidate) => candidate.exportRequestId === response.transferId
      )
      if (
        !token ||
        token.sourceWindowId !== state.win.id ||
        token.tabId !== response.tabId ||
        token.editorSession
      ) {
        return
      }
      token.editorSession = response.editorSession
      token.exportRequestId = null
      for (const resolve of token.exportWaiters) {
        resolve(response.editorSession)
      }
      token.exportWaiters.clear()
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.confirmTabTransfer,
    (event, rawTransferId: unknown, valid: unknown) => {
      const { state } = stateForSender(event)
      const transferId = normalizeIdentifier(rawTransferId, "Transfer id")
      if (typeof valid !== "boolean") {
        throw new TypeError("Transfer confirmation must be boolean")
      }
      const pending = pendingTransfers.get(transferId)
      if (!pending || pending.targetWindowId !== state.win.id) return
      if (
        !valid ||
        !pending.editorSession ||
        state.closeSequence ||
        state.allowClose ||
        state.tabMutationLocked
      ) {
        abortPendingTransfer(transferId)
        return
      }
      const sourceState = windowStates.get(pending.sourceWindowId)
      const tab = tabStates.get(pending.tabId)
      if (
        !sourceState ||
        sourceState.win.isDestroyed() ||
        sourceState.closeSequence ||
        sourceState.allowClose ||
        sourceState.tabMutationLocked ||
        !tab ||
        tab.ownerWindowId !== sourceState.win.id ||
        tabSaveActive(tab) ||
        pendingExternalDocumentChanges.has(tab.id)
      ) {
        abortPendingTransfer(transferId)
        return
      }
      pending.targetConfirmed = true
      sourceState.win.webContents.send(ipcChannels.tabTransferCommitRequested, {
        transferId,
        tabId: pending.tabId,
        revision: pending.editorSession.revision,
      })
    }
  )

  ipcMain.handle(
    ipcChannels.commitTabTransfer,
    async (event, rawTransferId: unknown): Promise<WindowTabsSnapshot> => {
      const { state: sourceState } = stateForSender(event)
      const transferId = normalizeIdentifier(rawTransferId, "Transfer id")
      const detachValidation = pendingDetachValidations.get(transferId)
      if (detachValidation) {
        const targetState = windowStates.get(detachValidation.targetWindowId)
        const tab = tabStates.get(detachValidation.tabId)
        const valid =
          detachValidation.sourceWindowId === sourceState.win.id &&
          !sourceState.closeSequence &&
          !sourceState.allowClose &&
          !sourceState.tabMutationLocked &&
          targetState !== undefined &&
          !targetState.win.isDestroyed() &&
          !targetState.closeSequence &&
          !targetState.allowClose &&
          !targetState.tabMutationLocked &&
          tab?.ownerWindowId === sourceState.win.id &&
          !tabSaveActive(tab) &&
          !pendingExternalDocumentChanges.has(tab.id)
        finishDetachValidation(transferId, valid)
        if (!valid) {
          throw new Error("Detached tab is no longer available")
        }
        return windowSnapshot(sourceState)
      }

      const pending = pendingTransfers.get(transferId)
      if (
        !pending ||
        pending.sourceWindowId !== sourceState.win.id ||
        !pending.targetConfirmed ||
        !pending.editorSession
      ) {
        throw new Error("Tab transfer is not ready to commit")
      }
      const targetState = windowStates.get(pending.targetWindowId)
      const tab = tabStates.get(pending.tabId)
      if (
        !targetState ||
        targetState.win.isDestroyed() ||
        sourceState.closeSequence ||
        targetState.closeSequence ||
        sourceState.allowClose ||
        targetState.allowClose ||
        sourceState.tabMutationLocked ||
        targetState.tabMutationLocked ||
        !tab ||
        tab.ownerWindowId !== sourceState.win.id ||
        tabSaveActive(tab) ||
        pendingExternalDocumentChanges.has(tab.id)
      ) {
        abortPendingTransfer(transferId)
        throw new Error("Tab transfer participants are no longer available")
      }

      const sourceIndex = removeTabFromState(sourceState, tab.id)
      const targetIndex = Math.min(
        pending.targetIndex,
        targetState.tabIds.length
      )
      targetState.tabIds.splice(targetIndex, 0, tab.id)
      targetState.activeTabId = tab.id
      tab.ownerWindowId = targetState.win.id
      watchTabDocument(tab)
      pendingTransfers.delete(transferId)
      deleteDragToken(pending.dragToken)
      if (pending.timeout) clearTimeout(pending.timeout)

      if (sourceState.tabIds.length > 0) {
        if (sourceState.activeTabId === tab.id) {
          sourceState.activeTabId =
            sourceState.tabIds[
              Math.min(sourceIndex, sourceState.tabIds.length - 1)
            ]
        }
        updateWindowNativeDocument(sourceState)
        sendTabsChanged(sourceState)
      }
      updateWindowNativeDocument(targetState)
      sendTabsChanged(targetState)
      sendTabTransferCommitSettled(
        pending.sourceWindowId,
        pending.transferId,
        true
      )

      if (sourceState.tabIds.length === 0) {
        sourceState.rememberWhenClosed = false
        sourceState.allowClose = true
        setImmediate(() => {
          if (!sourceState.win.isDestroyed()) sourceState.win.close()
        })
        return windowSnapshot(targetState)
      }
      return windowSnapshot(sourceState)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.windowAction,
    (event, rawAction: unknown) => {
      const { win } = stateForSender(event)
      const action: WindowAction =
        rawAction === "close" ||
        rawAction === "minimize" ||
        rawAction === "toggle-maximize"
          ? rawAction
          : (() => {
              throw new TypeError("Invalid window action")
            })()
      if (action === "close") {
        win.close()
      } else if (action === "minimize") {
        win.minimize()
      } else if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.reportEditorMenuState,
    (event, rawMenuState: unknown) => {
      const { state, win } = stateForSender(event)
      if (typeof rawMenuState !== "object" || rawMenuState === null) {
        throw new TypeError("Editor menu state must be an object")
      }
      const candidate = rawMenuState as Partial<EditorMenuState>
      if (
        typeof candidate.canRedo !== "boolean" ||
        typeof candidate.canUndo !== "boolean" ||
        (candidate.documentKind !== "markdown" &&
          candidate.documentKind !== "plain-text") ||
        typeof candidate.editorFocused !== "boolean" ||
        typeof candidate.hasSelection !== "boolean" ||
        (candidate.mode !== "live" && candidate.mode !== "source") ||
        typeof candidate.settingsDialogOpen !== "boolean" ||
        typeof candidate.settingsWorkspaceOpen !== "boolean" ||
        typeof candidate.softwareLicensesOpen !== "boolean"
      ) {
        throw new TypeError("Invalid editor menu state")
      }
      state.editorMenuState = {
        canRedo: candidate.canRedo,
        canUndo: candidate.canUndo,
        documentKind: normalizeDocumentKind(candidate.documentKind),
        editorFocused: candidate.editorFocused,
        hasSelection: candidate.hasSelection,
        mode: candidate.mode,
        settingsDialogOpen: candidate.settingsDialogOpen,
        settingsWorkspaceOpen: candidate.settingsWorkspaceOpen,
        softwareLicensesOpen: candidate.softwareLicensesOpen,
      }
      deliverPendingExternalScratchActivation(state)
      if (BrowserWindow.getFocusedWindow()?.id === win.id) {
        updateViewMenuItems(state)
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.reportLineWrapping,
    (event, rawLineWrapping: unknown) => {
      const { state, win } = stateForSender(event)
      if (typeof rawLineWrapping !== "boolean") {
        throw new TypeError("Line-wrapping state must be a boolean")
      }
      state.lineWrapping = rawLineWrapping
      if (BrowserWindow.getFocusedWindow()?.id === win.id) {
        updateViewMenuItems(state)
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.windowZoomChanged,
    (event, rawChange: unknown) => {
      const { win } = stateForSender(event)
      if (typeof rawChange !== "object" || rawChange === null) {
        throw new TypeError("Window zoom change must be an object")
      }
      const { persist, zoomFactor } = rawChange as {
        persist?: unknown
        zoomFactor?: unknown
      }
      if (
        typeof persist !== "boolean" ||
        typeof zoomFactor !== "number" ||
        !Number.isFinite(zoomFactor) ||
        zoomFactor <= 0
      ) {
        throw new TypeError("Invalid window zoom change")
      }
      const supportedZoomFactor = clampZoomFactor(zoomFactor)
      // Renderer resize reports can arrive after a newer native accelerator
      // step. Reapplying an already-supported report to its source window
      // would roll that newer step back; only correct the source when the
      // renderer actually reported an out-of-range factor.
      if (supportedZoomFactor !== zoomFactor) {
        applyWindowZoom(win, supportedZoomFactor)
      } else {
        positionNativeWindowButtons(win, supportedZoomFactor)
      }
      if (persist) persistWindowZoomFactor(supportedZoomFactor, win.id)
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.provideSettingsScratchSnapshot,
    (event, rawResponse: unknown): void => {
      const { win } = stateForSender(event)
      if (
        typeof rawResponse !== "object" ||
        rawResponse === null ||
        Array.isArray(rawResponse)
      ) {
        throw new TypeError("Invalid scratch snapshot response")
      }
      const candidate = rawResponse as Record<string, unknown>
      if (
        typeof candidate.requestId !== "string" ||
        (candidate.status !== "ok" && candidate.status !== "unavailable")
      ) {
        throw new TypeError("Invalid scratch snapshot response")
      }
      const pending = pendingSettingsScratchSnapshots.get(candidate.requestId)
      if (!pending) return
      if (pending.ownerWindowId !== win.id) {
        throw new TypeError(
          "Scratch snapshot response came from another window"
        )
      }
      if (candidate.status === "unavailable") {
        if (
          Object.keys(candidate).length !== 3 ||
          (candidate.reason !== "changed" &&
            candidate.reason !== "too-large") ||
          !("reason" in candidate) ||
          !("requestId" in candidate) ||
          !("status" in candidate)
        ) {
          throw new TypeError("Invalid unavailable scratch snapshot response")
        }
        if (candidate.reason === "too-large") {
          rejectSettingsScratchSnapshot(
            candidate.requestId,
            new TypeError("The settings transfer is too large to export")
          )
          return
        }
        rejectSettingsScratchSnapshot(
          candidate.requestId,
          new SettingsScratchSnapshotInvalidatedError(
            "A scratch changed while its editor was being captured"
          )
        )
        return
      }
      if (
        Object.keys(candidate).length !== 3 ||
        !("tabs" in candidate) ||
        !Array.isArray(candidate.tabs) ||
        candidate.tabs.length !== pending.expectedTargets.size
      ) {
        throw new TypeError("Invalid scratch snapshot tabs")
      }

      const seenTabIds = new Set<TabId>()
      const scratches: SettingsScratchContentSnapshot[] = []
      let contentBytes = 0
      for (const rawTab of candidate.tabs) {
        if (
          typeof rawTab !== "object" ||
          rawTab === null ||
          Array.isArray(rawTab)
        ) {
          throw new TypeError("Invalid scratch snapshot tab")
        }
        const snapshot = rawTab as Record<string, unknown>
        if (
          Object.keys(snapshot).length !== 3 ||
          !("content" in snapshot) ||
          !("revision" in snapshot) ||
          !("tabId" in snapshot) ||
          typeof snapshot.content !== "string" ||
          typeof snapshot.revision !== "number" ||
          !Number.isSafeInteger(snapshot.revision) ||
          snapshot.revision < 0 ||
          typeof snapshot.tabId !== "string" ||
          seenTabIds.has(snapshot.tabId)
        ) {
          throw new TypeError("Invalid scratch snapshot tab")
        }
        const target = pending.expectedTargets.get(snapshot.tabId)
        if (!target) {
          throw new TypeError("Scratch snapshot returned an unexpected tab")
        }
        if (!settingsScratchTargetStillOwned(target)) {
          rejectSettingsScratchSnapshot(
            candidate.requestId,
            new SettingsScratchSnapshotInvalidatedError(
              "Scratch ownership changed while its editor was being captured"
            )
          )
          return
        }
        seenTabIds.add(snapshot.tabId)
        const tab = tabStates.get(target.runtimeTabId)
        if (!tab) {
          throw new SettingsScratchSnapshotInvalidatedError(
            "A scratch disappeared while its editor was being captured"
          )
        }
        const content = encodeUtf8Document(
          snapshot.content,
          tab.document.format
        )
        const scratch: SettingsScratchContentSnapshot = {
          content,
          modifiedAt: tab.dirty
            ? Date.now()
            : Math.trunc(tab.document.mtimeMs ?? Date.now()),
          scratchId: target.scratchId,
        }
        contentBytes += content.byteLength
        if (contentBytes > pending.maximumBytes) {
          throw new TypeError("The scratch snapshot is too large to export")
        }
        scratches.push(scratch)
      }
      resolveSettingsScratchSnapshot(candidate.requestId, scratches)
    },
    (event): void => {
      try {
        const { win } = stateForSender(event)
        rejectSettingsScratchSnapshotsForWindow(
          win.id,
          new Error("An editor returned an invalid scratch export response")
        )
      } catch {
        // The sender no longer owns an application window. Its normal window
        // teardown path resolves any still-pending requests.
      }
    }
  )

  ipcMain.handle(
    ipcChannels.exportSettings,
    async (
      event,
      rawSettings: unknown,
      rawOptions: unknown
    ): Promise<ExportSettingsResult> => {
      const { win } = stateForSender(event)
      if (settingsSessionOwnerWindowId !== win.id) {
        throw new Error(
          "Settings transfer requires the active Settings session"
        )
      }
      const exportedSettings = normalizeSettings(rawSettings)
      const options = normalizeSettingsTransferOptions(rawOptions)
      const archiveExport = options.scratches
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Export Settings",
        defaultPath: path.join(
          app.getPath("documents"),
          `Pulse MD Settings.${archiveExport ? "zip" : "json"}`
        ),
        filters: [
          {
            name: "Pulse MD Settings",
            extensions: [archiveExport ? "zip" : "json"],
          },
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      })
      if (canceled || !filePath) return { status: "cancelled" }
      const resolvedFilePath = validatedSettingsExportPath(
        filePath,
        archiveExport
      )

      const { profiles, scratches } = await settingsExportResources(options)
      const serialized = archiveExport
        ? await createSettingsArchive({
            settings: exportedSettings,
            profiles: (profiles ?? []).map((profile) => ({
              data: profile,
              id: profile.id,
            })),
            scratches: scratches ?? [],
          })
        : serializeSettingsExport(exportedSettings, {
            ...(profiles === undefined ? {} : { profiles }),
          })
      if (
        typeof serialized === "string" &&
        Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_TRANSFER_BYTES
      ) {
        throw new TypeError("The settings transfer is too large to export")
      }
      await atomicWrite(resolvedFilePath, serialized)
      return {
        status: "exported",
        filePath: resolvedFilePath,
        profileCount: profiles?.length ?? 0,
        scratchCount: scratches?.length ?? 0,
      }
    }
  )

  ipcMain.handle(
    ipcChannels.importSettings,
    async (event): Promise<ImportSettingsResult> => {
      const { win } = stateForSender(event)
      if (settingsSessionOwnerWindowId !== win.id) {
        throw new Error(
          "Settings transfer requires the active Settings session"
        )
      }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Import Settings",
        filters: [{ name: "Pulse MD Settings", extensions: ["zip", "json"] }],
        properties: ["openFile"],
      })
      const filePath = filePaths[0]
      if (canceled || !filePath) return { status: "cancelled" }

      const selectedStats = await stat(filePath)
      if (!selectedStats.isFile()) {
        throw new TypeError("The selected settings export is not a file")
      }
      if (selectedStats.size > MAX_SETTINGS_TRANSFER_BYTES) {
        throw new TypeError("The selected settings export is too large")
      }
      const { buffer } = await readStableFileBytes(
        filePath,
        MAX_SETTINGS_TRANSFER_BYTES
      )
      if (buffer.byteLength > MAX_SETTINGS_TRANSFER_BYTES) {
        throw new TypeError("The selected settings export is too large")
      }
      let rawProfiles: readonly unknown[]
      let rawSettings: unknown
      let scratches: readonly SettingsArchiveScratchInput[]
      if (isSettingsArchive(buffer)) {
        const archive = await parseSettingsArchive(buffer)
        rawProfiles = archive.profiles.map(({ data }) => data)
        rawSettings = archive.settings
        scratches = archive.scratches
      } else {
        let source: string
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
        } catch (error) {
          throw new TypeError("The settings export is not valid UTF-8", {
            cause: error,
          })
        }
        const parsed = JSON.parse(source.replace(/^\uFEFF/u, "")) as unknown
        const transfer = settingsTransferFromExport(parsed)
        rawProfiles = transfer.profiles
        rawSettings = transfer.settings
        scratches = []
      }
      if (rawProfiles.length > MAX_SETTINGS_TRANSFER_PROFILES) {
        throw new TypeError("The settings export contains too many profiles")
      }
      if (scratches.length > MAX_SETTINGS_ARCHIVE_SCRATCHES) {
        throw new TypeError("The settings export contains too many scratches")
      }
      const resolvedFilePath = path.resolve(filePath)
      const profiles = rawProfiles.map((profile) =>
        normalizeProfileSchema(profile, {
          sourceDirectory: path.dirname(resolvedFilePath),
        })
      )
      const profileIds = new Set<string>()
      for (const profile of profiles) {
        if (profileIds.has(profile.id)) {
          throw new TypeError(
            `The settings export contains duplicate profile ${profile.id}`
          )
        }
        profileIds.add(profile.id)
        await validateProfileFileIdentities(profile)
      }
      const importedSettings = normalizeSettings(rawSettings)
      if (activeSettingsSessionOwner()?.win.id !== win.id) {
        throw new Error(
          "The Settings session closed before the import could be staged"
        )
      }
      const importId = randomUUID()
      pendingSettingsImport = {
        filePath: resolvedFilePath,
        id: importId,
        ownerWindowId: win.id,
        profiles,
        scratches,
      }
      return {
        status: "imported",
        filePath: resolvedFilePath,
        importId,
        profiles: profiles.map(({ id, name }) => ({ id, name })),
        scratchCount: scratches.length,
        settings: importedSettings,
      }
    }
  )

  registerOneWayIpcHandler(
    ipcChannels.discardSettingsImport,
    (event, rawImportId: unknown): void => {
      const { win } = stateForSender(event)
      if (typeof rawImportId !== "string") {
        throw new TypeError("Settings import id must be a string")
      }
      if (
        pendingSettingsImport?.id === rawImportId &&
        pendingSettingsImport.ownerWindowId === win.id
      ) {
        pendingSettingsImport = null
      }
    }
  )

  ipcMain.handle(
    ipcChannels.commitSettingsImport,
    (
      event,
      rawImportId: unknown,
      rawSettings: unknown,
      rawOptions: unknown
    ): Promise<WindowSettingsSnapshot> =>
      serializeManagedResourceOperation(async () => {
        const { state: sourceState, win: sourceWindow } = stateForSender(event)
        if (
          typeof rawImportId !== "string" ||
          pendingSettingsImport?.id !== rawImportId ||
          pendingSettingsImport.ownerWindowId !== sourceWindow.id ||
          settingsSessionOwnerWindowId !== sourceWindow.id
        ) {
          throw new Error(SETTINGS_IMPORT_ACTIONABLE_ERRORS.stageUnavailable)
        }
        const stagedImport = pendingSettingsImport
        const options = normalizeSettingsTransferOptions(rawOptions)
        const submittedSettings = normalizeSettings(rawSettings)
        const profiles = options.profiles ? stagedImport.profiles : []
        const scratches = options.scratches ? stagedImport.scratches : []

        for (const profile of profiles) {
          const openWindowId = profileWindows.get(profile.id)
          if (openWindowId !== undefined && openWindowId !== sourceWindow.id) {
            throw new Error(SETTINGS_IMPORT_ACTIONABLE_ERRORS.profileOpen)
          }
        }
        for (const scratch of scratches) {
          if (openScratchTab(scratch.id)) {
            throw new Error(SETTINGS_IMPORT_ACTIONABLE_ERRORS.scratchOpen)
          }
        }
        if (profiles.length > 0) {
          const availableScratchIds = new Set(
            (await scratchStore.listCatalog()).map(({ id }) => id)
          )
          for (const scratch of scratches) {
            availableScratchIds.add(scratch.id)
          }
          const missingScratchId = profiles
            .flatMap((profile) => profile.tabs)
            .find(
              (tab) =>
                tab.kind === "scratch" &&
                !availableScratchIds.has(tab.scratchId)
            )
          if (missingScratchId?.kind === "scratch") {
            throw new Error(
              `Include scratch ${missingScratchId.scratchId} or import it before importing the profiles that reference it.`
            )
          }
        }

        const replacements = [
          ...(scratches.length > 0
            ? [settingsImportScratchReplacement(scratches)]
            : []),
          ...profiles.map(settingsImportProfileReplacement),
        ]
        const committedSettings = await runSettingsImportTransaction(
          replacements,
          async () => {
            const availableProfileIds = new Set(
              (await profileStore.list()).map(({ id }) => id)
            )
            const committedCandidate =
              submittedSettings.defaultWindowProfileId !== null &&
              !availableProfileIds.has(submittedSettings.defaultWindowProfileId)
                ? { ...submittedSettings, defaultWindowProfileId: null }
                : submittedSettings
            return await commitApplicationSettings(
              () => committedCandidate,
              sourceWindow.id,
              { importedTransaction: true }
            )
          }
        )
        if (pendingSettingsImport?.id === stagedImport.id) {
          pendingSettingsImport = null
        }
        return settingsSnapshotForWindow(sourceState, committedSettings)
      })
  )

  ipcMain.handle(
    ipcChannels.setSettings,
    (
      event,
      rawSettings: unknown,
      rawBaselineSettings: unknown
    ): Promise<WindowSettingsSnapshot> =>
      serializeManagedResourceOperation(async () => {
        const { state: sourceState, win: sourceWindow } = stateForSender(event)
        const baselineSettings = normalizeSettings(rawBaselineSettings)
        const submittedSettings = normalizeSettings(rawSettings)
        if (
          submittedSettings.defaultWindowProfileId !==
            baselineSettings.defaultWindowProfileId &&
          submittedSettings.defaultWindowProfileId !== null
        ) {
          await profileStore.read(submittedSettings.defaultWindowProfileId)
        }
        const committedSettings = await commitApplicationSettings(
          (current) =>
            rebaseAppSettings(current, baselineSettings, submittedSettings),
          sourceWindow.id
        )
        return settingsSnapshotForWindow(sourceState, committedSettings)
      })
  )
}

function installApplicationLifecycle(): void {
  app.on("before-quit", (event) => {
    if (allowApplicationQuit) return
    event.preventDefault()
    beginApplicationQuit()
  })

  app.on("activate", () => {
    if (!applicationInitialized) {
      activationRequestsBeforeApplicationInitialization += 1
      requestApplicationInitialization()
      return
    }
    if (applicationPersistenceQuiescing) {
      activationRequestedDuringApplicationClose = true
    }
    requestActivationWindow()
  })

  app.on("second-instance", (_event, _commandLine, _workingDirectory, data) => {
    try {
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { kind?: unknown }).kind === "cli-bootstrap"
      ) {
        return
      }
      const intent = parseLaunchIntentAdditionalData(data)
      if (applicationInitialized) {
        void routeLaunchIntent(intent)
      } else {
        pendingLaunchIntents.push(intent)
        requestApplicationInitialization()
      }
    } catch (error) {
      console.warn("Ignoring invalid secondary launch intent", error)
    }
  })

  app.on("open-file", (event, filePath) => {
    event.preventDefault()
    if (applicationInitialized) {
      void routeLaunchIntent({ kind: "new-window", filePaths: [filePath] })
    } else {
      pendingOpenFiles.push(filePath)
      requestApplicationInitialization()
    }
  })

  app.on("open-url", (event, address) => {
    event.preventDefault()
    const parsed = parseScratchLinkAddress(address)
    if (!parsed || parsed.scheme !== EXTERNAL_SCRATCH_LINK_SCHEME) {
      console.warn("Ignoring invalid Pulse MD URL", address)
      return
    }
    const intent: LaunchIntent = {
      kind: "open-scratch",
      fragment: parsed.fragment,
      scratchId: parsed.identity.scratchId,
    }
    if (applicationInitialized) {
      void routeLaunchIntent(intent)
    } else {
      pendingLaunchIntents.push(intent)
      requestApplicationInitialization()
    }
  })

  app.whenReady().then(async () => {
    if (macLoginLaunchDetectionPending) {
      try {
        wasOpenedAtLogin = app.getLoginItemSettings({
          type: "mainAppService",
        }).wasOpenedAtLogin
      } catch (error) {
        console.warn("Unable to inspect the macOS login launch state", error)
      }
      if (!wasOpenedAtLogin) {
        restoreForegroundActivationPolicy()
      }
    }
    await applicationInitializationRequest
    if (allowApplicationQuit) return
    try {
      await ensureScratchMigration()
    } catch (error) {
      restoreForegroundActivationPolicy()
      dialog.showErrorBox(
        "Scratch Migration Failed",
        error instanceof Error ? error.message : String(error)
      )
      await beginApplicationQuit()
      return
    }
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) =>
        details.isMainFrame &&
        isTrustedRendererPermissionRequest(
          webContents,
          String(permission),
          details.requestingUrl ?? requestingOrigin
        )
    )
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        callback(
          details.isMainFrame &&
            isTrustedRendererPermissionRequest(
              webContents,
              String(permission),
              details.requestingUrl
            )
        )
      }
    )

    protocol.handle(PULSE_MD_APP_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        if (
          url.hostname !== "bundle" ||
          (request.method !== "GET" && request.method !== "HEAD")
        ) {
          return new Response(null, { status: 404 })
        }
        const bundleRoot = path.resolve(__dirname, "../dist")
        const relativePath = decodeURIComponent(url.pathname).replace(
          /^\/+/,
          ""
        )
        const requestedPath = path.resolve(
          bundleRoot,
          relativePath || "index.html"
        )
        const relativeToBundle = path.relative(bundleRoot, requestedPath)
        if (
          relativeToBundle.startsWith("..") ||
          path.isAbsolute(relativeToBundle)
        ) {
          return new Response(null, { status: 404 })
        }
        return await net.fetch(pathToFileURL(requestedPath).href)
      } catch {
        return new Response(null, { status: 404 })
      }
    })
    protocol.handle(PULSE_MD_IMAGE_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== "local") {
          return new Response(null, { status: 404 })
        }
        const filePath = decodeURIComponent(url.pathname.slice(1))
        if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
          return new Response(null, { status: 400 })
        }
        return await net.fetch(pathToFileURL(filePath).href)
      } catch {
        return new Response(null, { status: 404 })
      }
    })
    settingsLoadPromise ??= loadSettings()
    windowSizeLoadPromise ??= loadWindowSize()
    recentDocumentsLoadPromise ??= loadRecentDocuments()
    await Promise.all([
      settingsLoadPromise,
      windowSizeLoadPromise,
      recentDocumentsLoadPromise,
    ])
    if (!(await resolveSettingsLoadFailure())) return
    const spellCheckSession = session.defaultSession
    spellCheckSession.on("spellcheck-dictionary-initialized", () => {
      broadcastSpellCheckDictionaryChanged(spellCheckSession)
    })
    spellCheckSession.setSpellCheckerEnabled(settings.spellCheck)
    registerIpc()
    Menu.setApplicationMenu(createApplicationMenu())
    updateViewMenuItems()
    applicationInitialized = true

    const keepReadyWithoutWindow = shouldKeepReadyWithoutWindow({
      cliBootstrap: cliBootstrapLaunch,
      enabled: settings.keepReadyInBackground,
      initialIntent: initialLaunchIntent,
      isPackaged: app.isPackaged,
      pendingActivationCount:
        activationRequestsBeforeApplicationInitialization +
        (settingsRecoveryPresented ? 1 : 0),
      pendingIntentCount: pendingLaunchIntents.length,
      pendingOpenFileCount: pendingOpenFiles.length,
      platform: process.platform,
      wasOpenedAtLogin,
    })

    const startupSelection = selectStartupLaunchIntent(
      initialLaunchIntent,
      pendingLaunchIntents
    )
    pendingLaunchIntents.splice(
      0,
      pendingLaunchIntents.length,
      ...startupSelection.pendingIntents
    )
    const startupIntent = startupSelection.startupIntent

    if (keepReadyWithoutWindow) {
      initialDefaultWindowProfileLoadPromise = null
    } else if (startupIntent.kind === "open-scratch") {
      initialDefaultWindowProfileLoadPromise = null
      await routeLaunchIntent(startupIntent)
      if (pendingOpenFiles.length > 0) {
        await routeLaunchIntent({
          kind: "new-window",
          filePaths: pendingOpenFiles.splice(0),
        })
      }
    } else {
      const startupFiles = [
        ...startupIntent.filePaths,
        ...pendingOpenFiles.splice(0),
      ]
      if (!cliBootstrapLaunch || startupFiles.length > 0) {
        const prefetchedDefaultProfile =
          startupFiles.length === 0
            ? (initialDefaultWindowProfileLoadPromise ?? undefined)
            : undefined
        // This promise represents only the initial app launch. Never retain it
        // for later requests, which must observe the current default profile.
        initialDefaultWindowProfileLoadPromise = null
        await routeLaunchIntent(
          { kind: "new-window", filePaths: startupFiles },
          prefetchedDefaultProfile
        )
      }
    }
    for (const intent of pendingLaunchIntents.splice(0)) {
      void routeLaunchIntent(intent)
    }
    for (const request of pendingCliRequests.splice(0)) {
      enqueueCliRequest(request)
    }
    if (activationRequestsBeforeApplicationInitialization > 0) {
      activationRequestsBeforeApplicationInitialization = 0
      requestActivationWindow()
    }
  })

  nativeTheme.on("updated", () => {
    for (const state of windowStates.values()) {
      const { win } = state
      if (win.isDestroyed()) continue
      const appearance = state.rendererReady
        ? (state.appearancePreview ?? settings)
        : state.launchSettings
      if (!state.editorReady) {
        // Preserve the selected launch path until CodeMirror is ready. In
        // particular, a theme notification must not silently replace an eager
        // clear backing with the opaque deferred surface, or let benchmark
        // eager report a blur that is no longer installed.
        const preEditorAppearance =
          state.pendingLaunchVisualEffect?.settings ?? state.launchSettings
        applyPreEditorLaunchVisualEffect(state, preEditorAppearance)
        continue
      }
      applyWindowVisualEffect(state, appearance, true)
    }
  })

  app.on("window-all-closed", () => {
    if (launchBenchmark) {
      if (!allowApplicationQuit) app.exit(0)
      return
    }
    if (process.platform !== "darwin") app.quit()
  })
}

if (ownsSingleInstanceLock) {
  if (shouldStartCliServer) {
    cliServerStartPromise = startCliServer(
      app.getPath("temp"),
      acceptCliRequest,
      distributionIdentity.cliIdentity
    )
    void cliServerStartPromise.then(
      (server) => {
        cliServer = server
      },
      (error) => {
        console.error("Unable to start the CLI server", error)
        if (cliBootstrapLaunch) {
          allowApplicationQuit = true
          app.exit(1)
        }
      }
    )
  }
  if (!cliBootstrapLaunch) {
    requestApplicationInitialization(true)
  }
  installApplicationLifecycle()
} else {
  app.quit()
}
