import type {
  EditorMode,
  ScratchDocumentIdentity,
  TabBackingKind,
  TabColor,
  TabId,
  WindowProfile,
  WindowProfileSeed,
  WindowProfileTab,
  WindowProfileTabMode,
} from "../src/shared/contracts"
import { isProfileIdentifier } from "./profile-schema"

export type WindowProfileCaptureKind = "create" | "update"

export interface CurrentWindowProfileTab {
  readonly backing: TabBackingKind
  readonly color?: TabColor
  readonly displayName: string
  readonly filePath: string | null
  readonly origin?: {
    readonly profileId: string
    readonly tabId: string
  }
  readonly runtimeTabId: TabId
  readonly scratch?: ScratchDocumentIdentity
  readonly title?: string
}

export interface CaptureWindowProfileSeedOptions {
  readonly activeRuntimeTabId: TabId
  readonly inheritedEditorMode: EditorMode
  readonly kind: WindowProfileCaptureKind
  readonly originalProfile?: WindowProfile
  readonly tabModes: readonly WindowProfileTabMode[]
  readonly tabs: readonly CurrentWindowProfileTab[]
}

function uniqueProfileTabId(
  preferredId: string | null,
  label: string,
  index: number,
  usedIds: Set<string>
): string {
  let base =
    preferredId && isProfileIdentifier(preferredId)
      ? preferredId
      : label
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48)
  if (!isProfileIdentifier(base)) base = `tab-${index + 1}`
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    const suffixText = `-${suffix}`
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

/**
 * Captures the main-process tab registry as a reusable profile seed.
 *
 * Creating a profile deliberately snapshots current modes and refers to any
 * existing scratch by its durable identity. Updating a profile instead keeps
 * the identity and inheritance choices made by its launch definition whenever
 * the live tab still represents that original profile tab.
 */
export function captureWindowProfileSeed(
  options: CaptureWindowProfileSeedOptions
): WindowProfileSeed {
  if (options.tabs.length === 0) {
    throw new TypeError("A window profile seed requires at least one tab")
  }
  if (options.tabModes.length !== options.tabs.length) {
    throw new TypeError("Current-window tab modes must cover every tab")
  }

  const modeByRuntimeTabId = new Map<TabId, EditorMode>()
  for (const entry of options.tabModes) {
    if (modeByRuntimeTabId.has(entry.tabId)) {
      throw new TypeError("Current-window tab modes contain a duplicate tab")
    }
    modeByRuntimeTabId.set(entry.tabId, entry.mode)
  }
  if (
    options.tabs.some((tab) => !modeByRuntimeTabId.has(tab.runtimeTabId)) ||
    [...modeByRuntimeTabId].some(
      ([runtimeTabId]) =>
        !options.tabs.some((tab) => tab.runtimeTabId === runtimeTabId)
    )
  ) {
    throw new TypeError("Current-window tab modes do not match this window")
  }

  const originalProfile =
    options.kind === "update" ? options.originalProfile : undefined
  if (options.kind === "update" && !originalProfile) {
    throw new TypeError("Updating tabs requires their launch profile")
  }
  const originalTabs = new Map(
    originalProfile?.tabs.map((tab) => [tab.id, tab]) ?? []
  )
  const claimedOriginalIds = new Set<string>()
  const originalByRuntimeId = new Map<TabId, WindowProfileTab>()
  for (const tab of options.tabs) {
    if (
      !originalProfile ||
      tab.origin?.profileId !== originalProfile.id ||
      claimedOriginalIds.has(tab.origin.tabId)
    ) {
      continue
    }
    const original = originalTabs.get(tab.origin.tabId)
    if (!original) continue
    claimedOriginalIds.add(original.id)
    originalByRuntimeId.set(tab.runtimeTabId, original)
  }
  // New/reordered tabs must not take an original tab's durable profile id
  // before that original is encountered later in the current tab order.
  const usedIds = new Set(
    [...originalByRuntimeId.values()].map((tab) => tab.id)
  )
  const capturedIdByRuntimeId = new Map<TabId, string>()

  const tabs = options.tabs.map((tab, index): WindowProfileTab => {
    const original = originalByRuntimeId.get(tab.runtimeTabId)
    const id = original
      ? original.id
      : uniqueProfileTabId(null, tab.title ?? tab.displayName, index, usedIds)
    capturedIdByRuntimeId.set(tab.runtimeTabId, id)

    const currentMode = modeByRuntimeTabId.get(tab.runtimeTabId)!
    const originalEffectiveMode = original
      ? (original.mode ?? originalProfile?.mode ?? options.inheritedEditorMode)
      : undefined
    const mode =
      original && currentMode === originalEffectiveMode
        ? original.mode
        : currentMode
    const presentation = {
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.color ? { color: tab.color } : {}),
      ...(mode ? { mode } : {}),
    }

    if (tab.backing === "file") {
      if (!tab.filePath) {
        throw new TypeError("A file-backed tab has no file path")
      }
      return { id, kind: "file", path: tab.filePath, ...presentation }
    }
    if (tab.backing === "scratch") {
      if (!tab.scratch) {
        throw new TypeError("A scratch-backed tab has no scratch identity")
      }
      return {
        id,
        kind: "scratch",
        scratchId: tab.scratch.scratchId,
        ...presentation,
      }
    }
    return { id, kind: tab.backing, ...presentation }
  })

  const activeTab = capturedIdByRuntimeId.get(options.activeRuntimeTabId)
  if (!activeTab) {
    throw new TypeError("The active tab is not part of this window")
  }
  return { activeTab, tabs }
}
