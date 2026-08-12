import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron"

import {
  cloneAppSettings,
  isSpellingToken,
  MAX_SPELL_CHECK_WORD_COUNT,
  MAX_SPELLING_SUGGESTION_COUNT,
  MAX_SPELLING_WORD_LENGTH,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  ZOOM_FACTOR_STEP,
} from "../src/shared/contracts"
import type {
  AppearanceSettings,
  AppSettings,
  BootstrapPayload,
  BootstrapTab,
  CliEditorFocusAcknowledgement,
  CliEditorFocusRequest,
  CliTabsOpenAcknowledgement,
  CliTabsOpenRequest,
  CloseDecision,
  CopiedHeadingLinkMetadata,
  EditorCommand,
  EditorContextMenuDetails,
  EditorMenuState,
  EditorViewport,
  ExportSettingsResult,
  ExternalDocumentChange,
  FocusedEditCommand,
  ImportSettingsResult,
  LaunchVisualEffectReady,
  LocalLinkDisposition,
  PulseMdApi,
  NewTabResult,
  OpenExistingLocalLinkRequest,
  OpenDocumentResult,
  OpenLocalLinkResult,
  OpenScratchResult,
  PathCompletionEntry,
  PulseMdRecoveryApi,
  RecoveryAction,
  SaveDocumentRequest,
  SaveDocumentAcknowledgement,
  SaveDocumentResult,
  SettingsScratchSnapshotRequest,
  SettingsScratchSnapshotResponse,
  SettingsTransferOptions,
  ScratchDocumentIdentity,
  ScratchInventory,
  ScratchInventoryScope,
  ScratchLinkScheme,
  ScratchOpenDisposition,
  ScratchPreview,
  ScratchSortOrder,
  ScratchUpdate,
  TabExportRequest,
  TabExportResponse,
  TabDragEndDetails,
  TabDragGeometry,
  TabDetachSourceRetired,
  TabDetachSourceSettled,
  TabId,
  TabTransferCommitSettled,
  TabTransferImport,
  TransferId,
  WindowAction,
  WindowProfileCaptureKind,
  WindowProfile,
  WindowProfileFileChoice,
  WindowProfileLaunchResult,
  WindowProfilePickerRequest,
  WindowProfileSeed,
  WindowProfileTabMode,
  WindowProfilesSnapshot,
  WindowSettingsSnapshot,
  WindowTabsSnapshot,
} from "../src/shared/contracts"
import { ipcChannels } from "./channels"

let reportedZoomFactor = webFrame.getZoomFactor()
const windowZoomListeners = new Set<(zoomFactor: number) => void>()
const publishZoomFactor = (zoomFactor: number, persist: boolean) => {
  ipcRenderer.send(ipcChannels.windowZoomChanged, { persist, zoomFactor })
  for (const listener of windowZoomListeners) listener(zoomFactor)
}
const reportZoomFactor = (persist = true) => {
  const zoomFactor = webFrame.getZoomFactor()
  if (zoomFactor === reportedZoomFactor) return
  reportedZoomFactor = zoomFactor
  publishZoomFactor(zoomFactor, persist)
}

interface RendererKeyboardEvent {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly key: string
  readonly metaKey: boolean
  readonly shiftKey: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

interface RendererEventTarget {
  addEventListener(type: "resize", listener: () => void): void
  addEventListener(
    type: "keydown",
    listener: (event: RendererKeyboardEvent) => void,
    options?: boolean | { capture?: boolean }
  ): void
}

const rendererWindow = globalThis as typeof globalThis &
  RendererEventTarget & {
    visualViewport?: Pick<RendererEventTarget, "addEventListener">
  }

// Page zoom changes the CSS viewport. Reporting from that viewport catches
// menu/keyboard zoom as well as the narrower main-process `zoom-changed`
// event, which Electron documents as mouse-wheel-only.
rendererWindow.addEventListener("resize", () => reportZoomFactor())
rendererWindow.visualViewport?.addEventListener("resize", () =>
  reportZoomFactor()
)

function onMessage<T>(
  channel: string,
  listener: (value: T) => void
): () => void {
  const handleMessage = (_event: Electron.IpcRendererEvent, value: T) => {
    listener(value)
  }
  ipcRenderer.on(channel, handleMessage)
  return () => ipcRenderer.removeListener(channel, handleMessage)
}

let persistedSettingsBaseline: AppSettings | null = null

function rememberBootstrapSettings(
  payload: BootstrapPayload
): BootstrapPayload {
  persistedSettingsBaseline = cloneAppSettings(payload.persistedSettings)
  return payload
}

function rememberSettingsSnapshot(
  snapshot: WindowSettingsSnapshot
): WindowSettingsSnapshot {
  persistedSettingsBaseline = cloneAppSettings(snapshot.persisted)
  return snapshot
}

interface EditorCommandEnvelope {
  command: EditorCommand
  requestId: string
}

function onCommand(
  listener: (command: EditorCommand) => Promise<void> | void
): () => void {
  const handleCommand = (
    _event: Electron.IpcRendererEvent,
    rawMessage: EditorCommand | EditorCommandEnvelope
  ) => {
    const envelope =
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      typeof rawMessage.requestId === "string"
        ? rawMessage
        : null
    const command = envelope ? envelope.command : rawMessage
    let completion: Promise<void>
    try {
      completion = Promise.resolve(listener(command as EditorCommand))
    } catch (error) {
      completion = Promise.reject(error)
    }
    void completion
      .catch((error) => console.error("Failed to handle editor command", error))
      .finally(() => {
        if (envelope) {
          ipcRenderer.send(ipcChannels.commandHandled, envelope.requestId)
        }
      })
  }
  ipcRenderer.on(ipcChannels.command, handleCommand)
  return () => ipcRenderer.removeListener(ipcChannels.command, handleCommand)
}

// Native input is intercepted in main before it can activate both the menu
// accelerator and the page. Some automation/embedded hosts inject only a DOM
// event, however, so forward that otherwise-unobservable startup input through
// the same main-process queue. Stop doing so as soon as App completes the
// editor-ready handshake; React owns keyboard policy from then on.
let editorReadySent = false
rendererWindow.addEventListener(
  "keydown",
  (event) => {
    if (editorReadySent) return
    const primaryModifier =
      process.platform === "darwin"
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
    if (
      !primaryModifier ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== "t"
    ) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    ipcRenderer.send(ipcChannels.startupCommand, "new-tab")
  },
  { capture: true }
)

let tabDragActive = false
const tabDragActivityListeners = new Set<(active: boolean) => void>()
ipcRenderer.on(ipcChannels.tabDragActivity, (_event, active: unknown): void => {
  if (typeof active !== "boolean") return
  tabDragActive = active
  for (const listener of tabDragActivityListeners) listener(active)
})

function assertSpellingWord(word: unknown): asserts word is string {
  if (!isSpellingToken(word)) {
    throw new TypeError("Invalid spelling word")
  }
}

// Chromium reports every word as correctly spelled for a short interval after
// the native checker is re-enabled. This deliberately nonsensical probe lets
// the synchronous renderer API distinguish that transition from a valid batch
// of correctly spelled words. macOS does not emit Electron's downloaded-
// Hunspell initialization event because it uses the platform checker.
const spellingReadinessProbe = "pulsemdzzzxqvblorp"

const pulseMd: PulseMdApi = {
  bootstrap: async () =>
    rememberBootstrapSettings(
      (await ipcRenderer.invoke(ipcChannels.bootstrap)) as BootstrapPayload
    ),
  hydrateTab: (tabId: TabId, interactive: boolean) =>
    ipcRenderer.invoke(
      ipcChannels.hydrateTab,
      tabId,
      interactive
    ) as Promise<BootstrapTab | null>,
  acknowledgeTabHydration: (tabId: TabId) =>
    ipcRenderer.send(ipcChannels.acknowledgeTabHydration, tabId),
  acknowledgeCliEditorFocus: (acknowledgement: CliEditorFocusAcknowledgement) =>
    ipcRenderer.send(ipcChannels.acknowledgeCliEditorFocus, acknowledgement),
  acknowledgeCliTabsOpen: (acknowledgement: CliTabsOpenAcknowledgement) =>
    ipcRenderer.send(ipcChannels.acknowledgeCliTabsOpen, acknowledgement),
  activateTab: (tabId: TabId) =>
    ipcRenderer.invoke(
      ipcChannels.activateTab,
      tabId
    ) as Promise<WindowTabsSnapshot>,
  acknowledgeDocumentSave: (acknowledgement: SaveDocumentAcknowledgement) =>
    ipcRenderer.send(ipcChannels.acknowledgeDocumentSave, acknowledgement),
  acknowledgeExternalDocumentChange: (changeId: string, applied: boolean) =>
    ipcRenderer.send(
      ipcChannels.acknowledgeExternalDocumentChange,
      changeId,
      applied
    ),
  acknowledgeTabDetachSourceRetired: (dragToken: string) =>
    ipcRenderer.send(ipcChannels.acknowledgeTabDetachSourceRetired, dragToken),
  acquireSettingsSession: () =>
    ipcRenderer.invoke(ipcChannels.acquireSettingsSession) as Promise<boolean>,
  beginTabDrag: (tabId: TabId, geometry?: TabDragGeometry) =>
    ipcRenderer.sendSync(ipcChannels.beginTabDrag, tabId, geometry) as string,
  closeReady: (allow: boolean) =>
    ipcRenderer.send(ipcChannels.closeReady, allow),
  windowClosePrepared: (allow: boolean) =>
    ipcRenderer.send(ipcChannels.windowClosePrepared, allow),
  commitTabTransfer: (transferId: TransferId) =>
    ipcRenderer.invoke(
      ipcChannels.commitTabTransfer,
      transferId
    ) as Promise<WindowTabsSnapshot>,
  confirmTabTransfer: (transferId: TransferId, valid: boolean) =>
    ipcRenderer.send(ipcChannels.confirmTabTransfer, transferId, valid),
  copyEditorLink: (address: string) =>
    ipcRenderer.invoke(ipcChannels.copyEditorLink, address) as Promise<void>,
  copyHeadingLink: (tabId: TabId, fragment: string) =>
    ipcRenderer.invoke(
      ipcChannels.copyHeadingLink,
      tabId,
      fragment
    ) as Promise<void>,
  copyPath: (tabId: TabId) =>
    ipcRenderer.invoke(ipcChannels.copyPath, tabId) as Promise<void>,
  endTabDrag: (details: TabDragEndDetails) =>
    ipcRenderer.send(ipcChannels.endTabDrag, details),
  editorReady: () => {
    editorReadySent = true
    ipcRenderer.send(ipcChannels.editorReady)
  },
  exitLaunchBenchmark: () => ipcRenderer.send(ipcChannels.exitLaunchBenchmark),
  finalizeCloseTab: (tabId: TabId, viewport: EditorViewport | null) =>
    ipcRenderer.invoke(
      ipcChannels.finalizeCloseTab,
      tabId,
      viewport
    ) as Promise<WindowTabsSnapshot | null>,
  deleteWindowProfile: (id: string) =>
    ipcRenderer.invoke(
      ipcChannels.deleteWindowProfile,
      id
    ) as Promise<WindowProfilesSnapshot>,
  deleteScratch: (scratchId: string) =>
    ipcRenderer.invoke(ipcChannels.deleteScratch, scratchId) as Promise<void>,
  addWordToSpellCheckerDictionary: (word: string) => {
    assertSpellingWord(word)
    return ipcRenderer.invoke(
      ipcChannels.addWordToSpellCheckerDictionary,
      word
    ) as Promise<boolean>
  },
  checkSpelling: (words: readonly string[]) => {
    if (!Array.isArray(words) || words.length > MAX_SPELL_CHECK_WORD_COUNT) {
      throw new TypeError("Invalid spelling word list")
    }
    for (const word of words) assertSpellingWord(word)
    const results = words.map((word) => webFrame.isWordMisspelled(word))
    if (
      results.length > 0 &&
      !results.includes(true) &&
      !webFrame.isWordMisspelled(spellingReadinessProbe)
    ) {
      return null
    }
    return results
  },
  completePath: (sourceTabId: TabId, path: string) =>
    ipcRenderer.invoke(ipcChannels.completePath, sourceTabId, path) as Promise<
      readonly PathCompletionEntry[]
    >,
  editFocusedControl: (command: FocusedEditCommand) =>
    ipcRenderer.send(ipcChannels.editFocusedControl, command),
  commitSettingsImport: async (
    importId: string,
    settings: AppSettings,
    options: SettingsTransferOptions
  ) =>
    rememberSettingsSnapshot(
      (await ipcRenderer.invoke(
        ipcChannels.commitSettingsImport,
        importId,
        settings,
        options
      )) as WindowSettingsSnapshot
    ),
  discardSettingsImport: (importId: string) =>
    ipcRenderer.send(ipcChannels.discardSettingsImport, importId),
  exportSettings: (settings: AppSettings, options: SettingsTransferOptions) =>
    ipcRenderer.invoke(
      ipcChannels.exportSettings,
      settings,
      options
    ) as Promise<ExportSettingsResult>,
  getSpellingSuggestions: (word: string) => {
    assertSpellingWord(word)
    return [
      ...new Set(
        webFrame
          .getWordSuggestions(word)
          .filter(
            (suggestion) =>
              suggestion.length > 0 &&
              suggestion.length <= MAX_SPELLING_WORD_LENGTH
          )
          .slice(0, MAX_SPELLING_SUGGESTION_COUNT)
      ),
    ]
  },
  getScratchPreview: (scratchId: string) =>
    ipcRenderer.invoke(
      ipcChannels.getScratchPreview,
      scratchId
    ) as Promise<ScratchPreview>,
  getScratches: (
    query: string,
    sort: ScratchSortOrder,
    scope: ScratchInventoryScope
  ) =>
    ipcRenderer.invoke(
      ipcChannels.getScratches,
      query,
      sort,
      scope
    ) as Promise<ScratchInventory>,
  getWindowProfiles: () =>
    ipcRenderer.invoke(
      ipcChannels.getWindowProfiles
    ) as Promise<WindowProfilesSnapshot>,
  getCurrentWindowProfileSeed: (
    tabModes: readonly WindowProfileTabMode[],
    kind: WindowProfileCaptureKind
  ) =>
    ipcRenderer.invoke(
      ipcChannels.getCurrentWindowProfileSeed,
      tabModes,
      kind
    ) as Promise<WindowProfileSeed>,
  completeWindowProfilePicker: (requestId: string, profileId: string | null) =>
    ipcRenderer.send(
      ipcChannels.completeWindowProfilePicker,
      requestId,
      profileId
    ),
  launchWindowProfile: (id: string) =>
    ipcRenderer.invoke(
      ipcChannels.launchWindowProfile,
      id
    ) as Promise<WindowProfileLaunchResult>,
  importSettings: () =>
    ipcRenderer.invoke(
      ipcChannels.importSettings
    ) as Promise<ImportSettingsResult>,
  newTab: () => ipcRenderer.invoke(ipcChannels.newTab) as Promise<NewTabResult>,
  newScratch: () =>
    ipcRenderer.invoke(
      ipcChannels.newScratch
    ) as Promise<OpenScratchResult | null>,
  openExternalLink: (url: string) =>
    ipcRenderer.invoke(ipcChannels.openExternalLink, url) as Promise<void>,
  openLocalLink: (
    sourceTabId: TabId,
    destination: string,
    fragment: string | null,
    disposition: LocalLinkDisposition
  ) =>
    ipcRenderer.invoke(
      ipcChannels.openLocalLink,
      sourceTabId,
      destination,
      fragment,
      disposition
    ) as Promise<OpenLocalLinkResult | null>,
  openScratchLink: (
    sourceTabId: TabId,
    identity: ScratchDocumentIdentity,
    fragment: string | null,
    scheme: ScratchLinkScheme
  ) =>
    ipcRenderer.invoke(
      ipcChannels.openScratchLink,
      sourceTabId,
      identity,
      fragment,
      scheme
    ) as Promise<OpenLocalLinkResult | null>,
  openScratch: (scratchId: string, disposition: ScratchOpenDisposition) =>
    ipcRenderer.invoke(
      ipcChannels.openScratch,
      scratchId,
      disposition
    ) as Promise<OpenScratchResult | null>,
  openDocument: (replaceActive: boolean) =>
    ipcRenderer.invoke(
      ipcChannels.openDocument,
      replaceActive
    ) as Promise<OpenDocumentResult | null>,
  openDroppedDocuments: (files: readonly File[], replaceActive: boolean) => {
    if (!Array.isArray(files) || typeof replaceActive !== "boolean") {
      return Promise.reject(new TypeError("Invalid dropped documents"))
    }
    const filePaths = files.map((file) => webUtils.getPathForFile(file))
    return ipcRenderer.invoke(
      ipcChannels.openDroppedDocuments,
      filePaths,
      replaceActive
    ) as Promise<OpenDocumentResult | null>
  },
  previewAppearance: (settings: AppearanceSettings | null) =>
    ipcRenderer.send(ipcChannels.previewAppearance, settings),
  provideSettingsScratchSnapshot: (response: SettingsScratchSnapshotResponse) =>
    ipcRenderer.send(ipcChannels.provideSettingsScratchSnapshot, response),
  previewWindowZoom: (zoomFactor: number) => {
    if (
      !Number.isFinite(zoomFactor) ||
      zoomFactor < MIN_ZOOM_FACTOR ||
      zoomFactor > MAX_ZOOM_FACTOR
    ) {
      throw new TypeError("Window zoom factor is outside the supported range")
    }
    // Chromium can synchronously emit a viewport resize from setZoomFactor.
    // Claim the requested factor first so that event cannot race ahead and
    // accidentally persist a Settings preview.
    reportedZoomFactor = zoomFactor
    webFrame.setZoomFactor(zoomFactor)
    const appliedZoomFactor = webFrame.getZoomFactor()
    reportedZoomFactor = appliedZoomFactor
    publishZoomFactor(appliedZoomFactor, false)
  },
  persistWindowZoom: (zoomFactor: number) => {
    if (
      !Number.isFinite(zoomFactor) ||
      zoomFactor < MIN_ZOOM_FACTOR ||
      zoomFactor > MAX_ZOOM_FACTOR
    ) {
      throw new TypeError("Window zoom factor is outside the supported range")
    }
    reportedZoomFactor = zoomFactor
    webFrame.setZoomFactor(zoomFactor)
    const appliedZoomFactor = webFrame.getZoomFactor()
    reportedZoomFactor = appliedZoomFactor
    publishZoomFactor(appliedZoomFactor, true)
  },
  reportEditorMenuState: (state: EditorMenuState) => {
    ipcRenderer.send(ipcChannels.reportEditorMenuState, state)
  },
  reportLineWrapping: (lineWrapping: boolean) => {
    if (typeof lineWrapping !== "boolean") {
      throw new TypeError("Line-wrapping state must be a boolean")
    }
    ipcRenderer.send(ipcChannels.reportLineWrapping, lineWrapping)
  },
  releaseSettingsSession: () =>
    ipcRenderer.send(ipcChannels.releaseSettingsSession),
  resolveHeadingLinkPaste: (
    tabId: TabId,
    metadata: CopiedHeadingLinkMetadata
  ) =>
    ipcRenderer.invoke(
      ipcChannels.resolveHeadingLinkPaste,
      tabId,
      metadata
    ) as Promise<string>,
  revealPath: (tabId: TabId) =>
    ipcRenderer.invoke(ipcChannels.revealPath, tabId) as Promise<void>,
  stepWindowZoom: (direction: -1 | 1) => {
    if (direction !== -1 && direction !== 1) {
      throw new TypeError("Window zoom direction must be -1 or 1")
    }
    const percent = Math.round(webFrame.getZoomFactor() * 100)
    const stepPercent = Math.round(ZOOM_FACTOR_STEP * 100)
    const zoomFactor = Math.min(
      MAX_ZOOM_FACTOR,
      Math.max(MIN_ZOOM_FACTOR, (percent + direction * stepPercent) / 100)
    )
    webFrame.setZoomFactor(zoomFactor)
    reportZoomFactor()
  },
  provideTabExport: (response: TabExportResponse) =>
    ipcRenderer.send(ipcChannels.provideTabExport, response),
  rendererReady: async (prefersReducedMotion: boolean) =>
    rememberSettingsSnapshot(
      (await ipcRenderer.invoke(
        ipcChannels.rendererReady,
        prefersReducedMotion
      )) as WindowSettingsSnapshot
    ),
  reorderTab: (tabId: TabId, index: number) =>
    ipcRenderer.invoke(
      ipcChannels.reorderTab,
      tabId,
      index
    ) as Promise<WindowTabsSnapshot>,
  requestCloseTab: (tabId: TabId) =>
    ipcRenderer.invoke(
      ipcChannels.requestCloseTab,
      tabId
    ) as Promise<CloseDecision>,
  requestTabTransfer: (dragToken: string, index: number) =>
    ipcRenderer.invoke(
      ipcChannels.requestTabTransfer,
      dragToken,
      index
    ) as Promise<TabTransferImport | null>,
  saveDocument: (request: SaveDocumentRequest) =>
    ipcRenderer.invoke(
      ipcChannels.saveDocument,
      request
    ) as Promise<SaveDocumentResult | null>,
  saveWindowProfile: (profile: WindowProfile, replace: boolean) =>
    ipcRenderer.invoke(
      ipcChannels.saveWindowProfile,
      profile,
      replace
    ) as Promise<WindowProfilesSnapshot>,
  selectWindowProfileFiles: () =>
    ipcRenderer.invoke(ipcChannels.selectWindowProfileFiles) as Promise<
      WindowProfileFileChoice[]
    >,
  setActiveTab: (tabId: TabId) =>
    ipcRenderer.send(ipcChannels.setActiveTab, tabId),
  setDirty: (tabId: TabId, dirty: boolean) =>
    ipcRenderer.send(ipcChannels.setDirty, tabId, dirty),
  setSettings: async (settings: AppSettings) => {
    if (!persistedSettingsBaseline) {
      throw new Error("The persisted Settings baseline is unavailable")
    }
    return rememberSettingsSnapshot(
      (await ipcRenderer.invoke(
        ipcChannels.setSettings,
        settings,
        persistedSettingsBaseline
      )) as WindowSettingsSnapshot
    )
  },
  showRecovery: (error: string) =>
    ipcRenderer.send(ipcChannels.showRecovery, error),
  setDefaultWindowProfile: (id: string | null) =>
    ipcRenderer.invoke(
      ipcChannels.setDefaultWindowProfile,
      id
    ) as Promise<WindowProfilesSnapshot>,
  updateScratch: (scratchId: string, update: ScratchUpdate) =>
    ipcRenderer.invoke(
      ipcChannels.updateScratch,
      scratchId,
      update
    ) as Promise<void>,
  windowAction: (action: WindowAction) =>
    ipcRenderer.send(ipcChannels.windowAction, action),
  onCliEditorFocusRequested: (
    listener: (request: CliEditorFocusRequest) => void
  ) => onMessage(ipcChannels.cliEditorFocusRequested, listener),
  onCliTabsOpenRequested: (listener: (request: CliTabsOpenRequest) => void) =>
    onMessage(ipcChannels.cliTabsOpenRequested, listener),
  onWindowProfilePickerRequested: (
    listener: (request: WindowProfilePickerRequest) => void
  ) => onMessage(ipcChannels.windowProfilePickerRequested, listener),
  onWindowProfilePickerCancelled: (
    listener: (request: WindowProfilePickerRequest) => void
  ) => onMessage(ipcChannels.windowProfilePickerCancelled, listener),
  onCommand,
  onEditorContextMenu: (
    listener: (details: EditorContextMenuDetails) => void
  ) => onMessage(ipcChannels.editorContextMenu, listener),
  onExternalDocumentChange: (
    listener: (change: ExternalDocumentChange) => void
  ) => onMessage(ipcChannels.externalDocumentChange, listener),
  onOpenExistingLocalLinkRequested: (
    listener: (request: OpenExistingLocalLinkRequest) => void
  ) => onMessage(ipcChannels.openExistingLocalLinkRequested, listener),
  onSettingsScratchSnapshotRequested: (
    listener: (request: SettingsScratchSnapshotRequest) => void
  ) => onMessage(ipcChannels.settingsScratchSnapshotRequested, listener),
  onTabExportRequested: (listener: (request: TabExportRequest) => void) =>
    onMessage(ipcChannels.tabExportRequested, listener),
  onTabDragActivity: (listener: (active: boolean) => void) => {
    tabDragActivityListeners.add(listener)
    listener(tabDragActive)
    return () => tabDragActivityListeners.delete(listener)
  },
  onTabDetachSourceRetired: (
    listener: (retired: TabDetachSourceRetired) => void
  ) => onMessage(ipcChannels.tabDetachSourceRetired, listener),
  onTabDetachSourceSettled: (
    listener: (settled: TabDetachSourceSettled) => void
  ) => onMessage(ipcChannels.tabDetachSourceSettled, listener),
  onTabTransferCommitRequested: (
    listener: (request: TabExportRequest & { revision: number }) => void
  ) => onMessage(ipcChannels.tabTransferCommitRequested, listener),
  onTabTransferCommitSettled: (
    listener: (result: TabTransferCommitSettled) => void
  ) => onMessage(ipcChannels.tabTransferCommitSettled, listener),
  onTabsChanged: (listener: (snapshot: WindowTabsSnapshot) => void) =>
    onMessage(ipcChannels.tabsChanged, listener),
  onSettingsChanged: (listener: (settings: WindowSettingsSnapshot) => void) =>
    onMessage(
      ipcChannels.settingsChanged,
      (snapshot: WindowSettingsSnapshot) => {
        listener(rememberSettingsSnapshot(snapshot))
      }
    ),
  onSpellCheckDictionaryChanged: (listener: () => void) =>
    onMessage<void>(ipcChannels.spellCheckDictionaryChanged, listener),
  onLaunchVisualEffectReady: (
    listener: (effect: LaunchVisualEffectReady) => void
  ) => onMessage(ipcChannels.launchVisualEffectReady, listener),
  onWindowActivationChanged: (listener: (active: boolean) => void) =>
    onMessage(ipcChannels.windowActivationChanged, listener),
  onWindowZoomChanged: (listener: (zoomFactor: number) => void) => {
    reportedZoomFactor = webFrame.getZoomFactor()
    windowZoomListeners.add(listener)
    listener(reportedZoomFactor)
    return () => windowZoomListeners.delete(listener)
  },
  onWindowZoomPersistenceFailed: (listener: (zoomFactor: number) => void) =>
    onMessage(ipcChannels.windowZoomPersistenceFailed, listener),
}

contextBridge.exposeInMainWorld("pulseMd", pulseMd)
contextBridge.exposeInMainWorld("pulseMdRecovery", {
  perform: (action: RecoveryAction) =>
    ipcRenderer.invoke(ipcChannels.recoveryAction, action) as Promise<void>,
} satisfies PulseMdRecoveryApi)
