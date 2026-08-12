import * as React from "react"
import {
  ArrowLeftIcon,
  LoaderCircleIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"

import { ProfileComposerTabs } from "@/app/ProfileComposerTabs"
import { SavedProfileTabsPreview } from "@/app/SavedProfileTabsPreview"
import { WindowProfileTabInspector } from "@/app/WindowProfileTabInspector"
import {
  fileNameFromPath,
  resolvedWindowProfileScratchIdentity,
  windowProfileScratchIdentityKey,
} from "@/app/window-profile-tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { LongTextPopover } from "@/components/ui/long-text-popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useLongTextPopover } from "@/components/ui/use-long-text-popover"
import {
  type EditorMode,
  type ScratchEntry,
  type WindowProfile,
  type WindowProfileEntry,
  type WindowProfileFileChoice,
  type WindowProfilesSnapshot,
  type WindowProfileTab,
  type WindowProfileTabMode,
  type WindowProfileTabVisibility,
} from "@/shared/contracts"

const MAX_PROFILE_ID_LENGTH = 64
const MAX_PROFILE_NAME_LENGTH = 128
const MAX_PROFILE_TABS = 100
const INHERIT_MODE = "__inherit-mode__"
const PROFILE_OPEN_GUIDANCE =
  "Switch to this profile’s window to edit it. Close that window before deleting it."
const CURRENT_PROFILE_DELETE_GUIDANCE =
  "Close this profile’s window before deleting it."

const tabVisibilityLabels: Record<WindowProfileTabVisibility, string> = {
  inherit: "App Setting",
  always: "Always",
  "multiple-tabs": "With Multiple Tabs",
  mouseover: "On Mouseover",
  "formatting-bar": "With Formatting Toolbar",
  hidden: "Hidden",
}

const editorModeLabels: Record<EditorMode, string> = {
  live: "Rendered",
  source: "Raw Markdown",
}

export interface EditableWindowProfile {
  activeTab: string
  id: string
  mode?: EditorMode
  name: string
  tabs: WindowProfileTab[]
  tabVisibility: WindowProfileTabVisibility
  version: 2
}

export interface WindowProfileComposerState {
  draft: EditableWindowProfile
  replace: boolean
  selectedTabId: string | null
}

type ComposerReturnFocusTarget =
  { kind: "new-profile" } | { kind: "edit-profile"; profileId: string }

export interface WindowProfilesWorkspaceProps {
  composerRoute: WindowProfileComposerState | null
  currentWindowTabModes: readonly WindowProfileTabMode[]
  onBack: () => void
  onComposerRouteChange: (composer: WindowProfileComposerState) => void
  onComposerRouteOpen: (composer: WindowProfileComposerState) => void
  onComposerRouteSaved: () => void
  onLaunchProfile: (id: string) => Promise<void> | void
  onNavigationBlockedChange: (blocked: boolean) => void
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback
}

function slugIdentifier(value: string, fallback: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROFILE_ID_LENGTH)
    .replace(/-+$/g, "")
  const candidate = normalized || fallback
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate)
    ? `profile-${candidate}`
    : candidate
}

function uniqueIdentifier(base: string, usedIdentifiers: ReadonlySet<string>) {
  if (!usedIdentifiers.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`
    const candidate = `${base
      .slice(0, MAX_PROFILE_ID_LENGTH - suffixText.length)
      .replace(/-+$/g, "")}${suffixText}`
    if (!usedIdentifiers.has(candidate)) return candidate
  }
}

function duplicateFilePath(tabs: readonly WindowProfileTab[]) {
  const paths = new Set<string>()
  for (const tab of tabs) {
    if (tab.kind !== "file") continue
    if (paths.has(tab.path)) return tab.path
    paths.add(tab.path)
  }
  return null
}

function duplicateScratchIdentity(
  profileId: string,
  tabs: readonly WindowProfileTab[]
) {
  const identities = new Set<string>()
  for (const tab of tabs) {
    const identity = resolvedWindowProfileScratchIdentity(profileId, tab)
    if (!identity) continue
    const key = windowProfileScratchIdentityKey(identity)
    if (identities.has(key)) return identity
    identities.add(key)
  }
  return null
}

function cloneTab(tab: WindowProfileTab): WindowProfileTab {
  const presentation = {
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.color === undefined ? {} : { color: tab.color }),
    ...(tab.mode === undefined ? {} : { mode: tab.mode }),
  }
  if (tab.kind === "file") {
    return { id: tab.id, kind: tab.kind, path: tab.path, ...presentation }
  }
  if (tab.kind === "scratch") {
    return {
      id: tab.id,
      kind: tab.kind,
      scratchId: tab.scratchId,
      ...presentation,
    }
  }
  return { id: tab.id, kind: tab.kind, ...presentation }
}

function editableProfile(profile: WindowProfile): EditableWindowProfile {
  return {
    version: 2,
    id: profile.id,
    name: profile.name,
    activeTab: profile.activeTab,
    tabVisibility: profile.tabVisibility,
    ...(profile.mode === undefined ? {} : { mode: profile.mode }),
    tabs: profile.tabs.map(cloneTab),
  }
}

function normalizedTab(tab: WindowProfileTab): WindowProfileTab {
  const title = tab.title?.trim()
  const presentation = {
    ...(title ? { title } : {}),
    ...(tab.color === undefined ? {} : { color: tab.color }),
    ...(tab.mode === undefined ? {} : { mode: tab.mode }),
  }
  if (tab.kind === "file") {
    return { id: tab.id, kind: tab.kind, path: tab.path, ...presentation }
  }
  if (tab.kind === "scratch") {
    return {
      id: tab.id,
      kind: tab.kind,
      scratchId: tab.scratchId,
      ...presentation,
    }
  }
  return { id: tab.id, kind: tab.kind, ...presentation }
}

function normalizedProfile(draft: EditableWindowProfile): WindowProfile {
  return {
    version: 2,
    id: draft.id,
    name: draft.name.trim(),
    activeTab: draft.activeTab,
    tabVisibility: draft.tabVisibility,
    ...(draft.mode === undefined ? {} : { mode: draft.mode }),
    tabs: draft.tabs.map(normalizedTab),
  }
}

function createEmptyComposer(
  snapshot: WindowProfilesSnapshot
): WindowProfileComposerState {
  const profileIds = new Set(snapshot.profiles.map(({ profile }) => profile.id))
  return {
    replace: false,
    selectedTabId: null,
    draft: {
      version: 2,
      id: uniqueIdentifier("new-profile", profileIds),
      name: "",
      activeTab: "",
      tabVisibility: "inherit",
      tabs: [],
    },
  }
}

function fileTabFromChoice(
  choice: WindowProfileFileChoice,
  id: string,
  source?: WindowProfileTab
): WindowProfileTab {
  return {
    id,
    kind: "file",
    path: choice.path,
    ...(source?.title === undefined ? {} : { title: source.title }),
    ...(source?.color === undefined ? {} : { color: source.color }),
    ...(source?.mode === undefined ? {} : { mode: source.mode }),
  }
}

function ProfileSummary({ entry }: { entry: WindowProfileEntry }) {
  const { profile } = entry
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <p>
        <span className="font-medium text-foreground/80">Default Mode:</span>{" "}
        {profile.mode === undefined
          ? "App Setting"
          : editorModeLabels[profile.mode]}
      </p>
      <p>
        <span className="font-medium text-foreground/80">Tabs Visibility:</span>{" "}
        {tabVisibilityLabels[profile.tabVisibility]}
      </p>
    </div>
  )
}

function OpenProfileEditAction({
  guidanceId,
  profileId,
}: {
  guidanceId: string
  profileId: string
}) {
  const guidancePopover = useLongTextPopover<HTMLSpanElement>()

  return (
    <>
      <span
        {...guidancePopover.anchorProps}
        aria-describedby={guidanceId}
        aria-disabled="true"
        aria-label="Edit"
        className={buttonVariants({
          className:
            "cursor-not-allowed opacity-50 hover:bg-background hover:text-foreground active:translate-y-0 dark:hover:bg-transparent",
          size: "sm",
          variant: "outline",
        })}
        data-window-profile-edit={profileId}
        role="button"
        tabIndex={0}
      >
        Edit
      </span>
      <LongTextPopover
        anchor={guidancePopover.anchor}
        label="Profile editing unavailable"
        open={guidancePopover.open}
        onOpenChange={(open) => {
          if (!open) guidancePopover.close()
        }}
      >
        <span data-profile-open-popover-text="">{PROFILE_OPEN_GUIDANCE}</span>
      </LongTextPopover>
    </>
  )
}

export function WindowProfilesWorkspace({
  composerRoute,
  currentWindowTabModes,
  onBack,
  onComposerRouteChange,
  onComposerRouteOpen,
  onComposerRouteSaved,
  onLaunchProfile,
  onNavigationBlockedChange,
}: WindowProfilesWorkspaceProps) {
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const nameInputRef = React.useRef<HTMLInputElement>(null)
  const composerReturnFocusRef = React.useRef<ComposerReturnFocusTarget | null>(
    null
  )
  const focusComposerNameRef = React.useRef(false)
  const [snapshot, setSnapshot] = React.useState<WindowProfilesSnapshot | null>(
    null
  )
  const [scratches, setScratches] = React.useState<readonly ScratchEntry[]>([])
  const [syncedComposerRoute, setSyncedComposerRoute] =
    React.useState(composerRoute)
  const [composer, setComposer] =
    React.useState<WindowProfileComposerState | null>(composerRoute)
  if (syncedComposerRoute !== composerRoute) {
    setSyncedComposerRoute(composerRoute)
    setComposer(composerRoute)
  }
  const [pendingAction, setPendingAction] = React.useState<string | null>(
    "load"
  )
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(
    null
  )
  const [profileDeleteTarget, setProfileDeleteTarget] =
    React.useState<WindowProfileEntry | null>(null)
  const [profileDeleteError, setProfileDeleteError] = React.useState<
    string | null
  >(null)
  const nameInputId = React.useId()
  const defaultModeId = React.useId()
  const tabVisibilityId = React.useId()

  React.useLayoutEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true })
  }, [])

  const busy = pendingAction !== null
  const navigationBlocked = busy || profileDeleteTarget !== null
  const composerOpen = composer !== null

  React.useLayoutEffect(() => {
    if (composer) onComposerRouteChange(composer)
  }, [composer, onComposerRouteChange])

  React.useEffect(() => {
    onNavigationBlockedChange(navigationBlocked)
    return () => onNavigationBlockedChange(false)
  }, [navigationBlocked, onNavigationBlockedChange])

  React.useLayoutEffect(() => {
    if (composerOpen) {
      if (focusComposerNameRef.current) {
        focusComposerNameRef.current = false
        nameInputRef.current?.focus({ preventScroll: true })
      }
      return
    }
    if (busy) return
    const focusTarget = composerReturnFocusRef.current
    composerReturnFocusRef.current = null
    if (!focusTarget) return
    const selector =
      focusTarget.kind === "new-profile"
        ? "[data-window-profile-new]"
        : `[data-window-profile-edit="${focusTarget.profileId}"]`
    workspaceRef.current
      ?.querySelector<HTMLElement>(selector)
      ?.focus({ preventScroll: true })
  }, [busy, composerOpen])

  React.useEffect(() => {
    let cancelled = false
    let request = 0
    const loadSnapshot = () => {
      const currentRequest = ++request
      let profilesFailed = false
      setWorkspaceError(null)
      void window.pulseMd
        .getScratches("", "title", "window-profiles")
        .then((inventory) => {
          if (!cancelled && currentRequest === request) {
            setScratches(inventory.entries)
          }
        })
        .catch((error: unknown) => {
          if (cancelled || currentRequest !== request) return
          console.error("Unable to load scratches for window profiles", error)
          setScratches([])
          if (!profilesFailed) {
            setWorkspaceError("Scratch choices could not be loaded.")
          }
        })
      void window.pulseMd
        .getWindowProfiles()
        .then((nextSnapshot) => {
          if (!cancelled && currentRequest === request)
            setSnapshot(nextSnapshot)
        })
        .catch((error: unknown) => {
          if (cancelled || currentRequest !== request) return
          profilesFailed = true
          console.error("Unable to load window profiles", error)
          setWorkspaceError(
            errorMessage(error, "Window profiles could not be loaded.")
          )
        })
        .finally(() => {
          if (!cancelled && currentRequest === request) {
            setPendingAction((current) => (current === "load" ? null : current))
          }
        })
    }
    const refreshAfterActivation = () => loadSnapshot()
    loadSnapshot()
    window.addEventListener("focus", refreshAfterActivation)
    return () => {
      cancelled = true
      window.removeEventListener("focus", refreshAfterActivation)
    }
  }, [])

  const selectedTab =
    composer?.draft.tabs.find((tab) => tab.id === composer.selectedTabId) ??
    null
  const duplicatePath = composer ? duplicateFilePath(composer.draft.tabs) : null
  const duplicateScratch = composer
    ? duplicateScratchIdentity(composer.draft.id, composer.draft.tabs)
    : null
  const usedScratchIdentityKeys = new Set(
    composer?.draft.tabs.flatMap((tab) => {
      if (tab.id === composer.selectedTabId) return []
      const identity = resolvedWindowProfileScratchIdentity(
        composer.draft.id,
        tab
      )
      return identity ? [windowProfileScratchIdentityKey(identity)] : []
    }) ?? []
  )
  const canSave =
    composer !== null &&
    composer.draft.name.trim().length > 0 &&
    composer.draft.tabs.length > 0 &&
    duplicatePath === null &&
    duplicateScratch === null &&
    composer.draft.tabs.some((tab) => tab.id === composer.draft.activeTab)

  const updateComposerDraft = (
    updater: (draft: EditableWindowProfile) => EditableWindowProfile
  ) => {
    setComposer((current) =>
      current === null ? null : { ...current, draft: updater(current.draft) }
    )
  }

  const updateTab = (
    tabId: string,
    updater: (tab: WindowProfileTab) => WindowProfileTab
  ) => {
    updateComposerDraft((draft) => ({
      ...draft,
      tabs: draft.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    }))
  }

  const handleBack = () => {
    if (navigationBlocked) return
    setWorkspaceError(null)
    onBack()
  }

  const openComposer = (entry?: WindowProfileEntry) => {
    if (!snapshot) return
    composerReturnFocusRef.current = entry
      ? { kind: "edit-profile", profileId: entry.profile.id }
      : { kind: "new-profile" }
    focusComposerNameRef.current = true
    setWorkspaceError(null)
    if (!entry) {
      onComposerRouteOpen(createEmptyComposer(snapshot))
      return
    }
    onComposerRouteOpen({
      replace: true,
      selectedTabId: entry.profile.activeTab,
      draft: editableProfile(entry.profile),
    })
  }

  const addUntitledTab = () => {
    setComposer((current) => {
      if (!current || current.draft.tabs.length >= MAX_PROFILE_TABS) {
        return current
      }
      const usedIds = new Set(current.draft.tabs.map((tab) => tab.id))
      const id = uniqueIdentifier("untitled", usedIds)
      const tabs: WindowProfileTab[] = [
        ...current.draft.tabs,
        { id, kind: "untitled" },
      ]
      return {
        ...current,
        selectedTabId: id,
        draft: {
          ...current.draft,
          activeTab: current.draft.activeTab || id,
          tabs,
        },
      }
    })
  }

  const selectFiles = async (replaceTabId?: string) => {
    if (!composer || busy) return
    setWorkspaceError(null)
    setPendingAction("select-files")
    try {
      const choices = await window.pulseMd.selectWindowProfileFiles()
      if (choices.length === 0) return
      const existingPaths = new Set(
        composer.draft.tabs
          .filter(
            (tab): tab is Extract<WindowProfileTab, { kind: "file" }> =>
              tab.kind === "file" && tab.id !== replaceTabId
          )
          .map((tab) => tab.path)
      )
      let duplicateChoiceSkipped = false
      const uniqueChoices = choices.filter((choice) => {
        if (existingPaths.has(choice.path)) {
          duplicateChoiceSkipped = true
          return false
        }
        existingPaths.add(choice.path)
        return true
      })
      const additionalCapacity = MAX_PROFILE_TABS - composer.draft.tabs.length
      const acceptedChoices = replaceTabId
        ? uniqueChoices.slice(0, additionalCapacity + 1)
        : uniqueChoices.slice(0, additionalCapacity)
      const selectionMessages: string[] = []
      if (duplicateChoiceSkipped) {
        selectionMessages.push(
          "Each file can appear only once in a window profile; duplicate selections were skipped."
        )
      }
      if (acceptedChoices.length < uniqueChoices.length) {
        selectionMessages.push(
          `A profile can contain at most ${MAX_PROFILE_TABS} tabs.`
        )
      }
      if (selectionMessages.length > 0) {
        setWorkspaceError(selectionMessages.join(" "))
      }
      setComposer((current) => {
        if (!current || acceptedChoices.length === 0) return current
        const tabs = [...current.draft.tabs]
        const usedIds = new Set(tabs.map((tab) => tab.id))
        let firstAddedId: string | null = null
        let remainingChoices = acceptedChoices

        if (replaceTabId) {
          const replaceIndex = tabs.findIndex((tab) => tab.id === replaceTabId)
          const replacementChoice = acceptedChoices[0]
          if (replaceIndex >= 0 && replacementChoice) {
            const source = tabs[replaceIndex]!
            tabs[replaceIndex] = fileTabFromChoice(
              replacementChoice,
              source.id,
              source
            )
            firstAddedId = source.id
            remainingChoices = acceptedChoices.slice(1)
          }
        }

        for (const choice of remainingChoices) {
          const base = slugIdentifier(
            fileNameFromPath(choice.displayName).replace(/\.[^.]+$/g, ""),
            "file"
          )
          const id = uniqueIdentifier(base, usedIds)
          usedIds.add(id)
          tabs.push(fileTabFromChoice(choice, id))
          firstAddedId ??= id
        }

        return {
          ...current,
          selectedTabId: firstAddedId ?? current.selectedTabId,
          draft: {
            ...current.draft,
            activeTab: current.draft.activeTab || firstAddedId || "",
            tabs,
          },
        }
      })
    } catch (error) {
      console.error("Unable to select window profile files", error)
      setWorkspaceError(
        errorMessage(error, "Files could not be added to the profile.")
      )
    } finally {
      setPendingAction(null)
    }
  }

  const copyCurrentWindowTabs = async () => {
    if (!composer || busy) return
    setWorkspaceError(null)
    setPendingAction("current-window-tabs")
    try {
      const seed = await window.pulseMd.getCurrentWindowProfileSeed(
        currentWindowTabModes,
        "create"
      )
      if (seed.tabs.length > MAX_PROFILE_TABS) {
        setWorkspaceError(
          `The current window has ${seed.tabs.length} tabs. A profile can contain at most ${MAX_PROFILE_TABS}; close some tabs before copying it.`
        )
        return
      }
      if (duplicateFilePath(seed.tabs)) {
        setWorkspaceError(
          "The current window contains the same file more than once. Each file can appear only once in a window profile."
        )
        return
      }
      setComposer((current) =>
        current === null
          ? null
          : {
              ...current,
              selectedTabId: seed.activeTab || seed.tabs[0]?.id || null,
              draft: {
                ...current.draft,
                activeTab: seed.activeTab,
                tabs: seed.tabs.map(cloneTab),
              },
            }
      )
    } catch (error) {
      console.error("Unable to copy the current window tabs", error)
      setWorkspaceError(
        errorMessage(error, "The current window tabs could not be copied.")
      )
    } finally {
      setPendingAction(null)
    }
  }

  const saveProfile = async () => {
    if (!composer || busy) return
    if (duplicatePath) {
      setWorkspaceError(
        `“${fileNameFromPath(duplicatePath)}” appears more than once. Remove a duplicate file tab before saving.`
      )
      return
    }
    if (!canSave) return
    setWorkspaceError(null)
    setPendingAction("save-profile")
    try {
      const nextSnapshot = await window.pulseMd.saveWindowProfile(
        normalizedProfile(composer.draft),
        composer.replace
      )
      setSnapshot(nextSnapshot)
      onComposerRouteSaved()
    } catch (error) {
      console.error("Unable to save window profile", error)
      setWorkspaceError(
        errorMessage(error, "The window profile could not be saved.")
      )
    } finally {
      setPendingAction(null)
    }
  }

  const launchProfile = async (profileId: string) => {
    if (busy) return
    setWorkspaceError(null)
    setPendingAction(`launch-${profileId}`)
    try {
      await onLaunchProfile(profileId)
    } catch (error) {
      console.error("Unable to launch window profile", error)
      setWorkspaceError(
        errorMessage(error, "The window profile could not be launched.")
      )
    } finally {
      setPendingAction(null)
    }
  }

  const deleteProfile = async () => {
    if (!profileDeleteTarget || profileDeleteTarget.open || busy) return
    setWorkspaceError(null)
    setProfileDeleteError(null)
    setPendingAction(`delete-profile-${profileDeleteTarget.profile.id}`)
    try {
      setSnapshot(
        await window.pulseMd.deleteWindowProfile(profileDeleteTarget.profile.id)
      )
      setProfileDeleteTarget(null)
    } catch (error) {
      console.error("Unable to delete window profile", error)
      const message = errorMessage(
        error,
        "The window profile could not be deleted."
      )
      setProfileDeleteError(message)
      setWorkspaceError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const removeSelectedTab = () => {
    setComposer((current) => {
      if (!current?.selectedTabId) return current
      const index = current.draft.tabs.findIndex(
        (tab) => tab.id === current.selectedTabId
      )
      if (index < 0) return current
      const tabs = current.draft.tabs.filter(
        (tab) => tab.id !== current.selectedTabId
      )
      const nextSelected = tabs[Math.min(index, tabs.length - 1)] ?? null
      return {
        ...current,
        selectedTabId: nextSelected?.id ?? null,
        draft: {
          ...current.draft,
          activeTab:
            current.draft.activeTab === current.selectedTabId
              ? (nextSelected?.id ?? "")
              : current.draft.activeTab,
          tabs,
        },
      }
    })
  }

  return (
    <TooltipProvider>
      <div
        ref={workspaceRef}
        aria-label="Window Profiles Workspace"
        className="absolute inset-0 z-50 flex min-h-0 flex-col bg-[var(--document-background)] pt-[var(--window-chrome-height)] text-[var(--document-foreground)] outline-none"
        role="region"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            profileDeleteTarget !== null
          ) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          handleBack()
        }}
        onPointerDownCapture={(event) => {
          if (!composer?.selectedTabId || !(event.target instanceof Element)) {
            return
          }
          if (
            event.target.closest(
              '[data-profile-tab-id], [data-profile-starting-rail], [data-tab-inspector], [data-profile-tab-actions], [data-slot="select-content"]'
            )
          ) {
            return
          }
          const inspector = workspaceRef.current?.querySelector<HTMLElement>(
            "[data-tab-inspector]"
          )
          const activeElement = document.activeElement
          const openInspectorSelect = inspector?.querySelector<HTMLElement>(
            '[data-slot="select-trigger"][aria-expanded="true"]'
          )
          if (
            (activeElement instanceof Element &&
              inspector?.contains(activeElement)) ||
            openInspectorSelect
          ) {
            const blurInspectorControl = () => {
              const focusedElement = document.activeElement
              if (
                focusedElement instanceof HTMLElement &&
                (inspector?.contains(focusedElement) ||
                  focusedElement.closest('[data-slot="select-content"]'))
              ) {
                focusedElement.blur()
              }
            }
            blurInspectorControl()
            window.requestAnimationFrame(blurInspectorControl)
            return
          }
          setComposer((current) =>
            current ? { ...current, selectedTabId: null } : current
          )
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[var(--window-chrome-height)] [-webkit-app-region:drag]"
        />
        <header className="shrink-0 border-b border-border/70 bg-[var(--document-background)]">
          <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-3 px-5 py-2">
            <Button
              aria-label={
                composer ? "Back to Window Profiles" : "Back to Settings"
              }
              className="-ml-2"
              disabled={navigationBlocked}
              size="sm"
              type="button"
              variant="ghost"
              onClick={handleBack}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-heading text-base font-medium">
                {composer ? "Compose Window Profile" : "Window Profiles"}
              </h1>
              {composer ? (
                <p className="truncate text-xs text-muted-foreground">
                  {composer.replace ? "Edit Saved Profile" : "New Profile"}
                </p>
              ) : null}
            </div>
            {composer ? (
              <Button
                aria-label="Save Profile"
                className="max-sm:size-8 max-sm:pr-0 max-sm:has-data-[icon=inline-start]:pl-0"
                disabled={!canSave || busy}
                size="sm"
                type="button"
                onClick={() => void saveProfile()}
              >
                {pendingAction === "save-profile" ? (
                  <LoaderCircleIcon
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <SaveIcon data-icon="inline-start" />
                )}
                <span className="hidden sm:inline">Save Profile</span>
              </Button>
            ) : (
              <Button
                aria-label="New Profile"
                className="max-sm:size-8 max-sm:pr-0 max-sm:has-data-[icon=inline-start]:pl-0"
                data-window-profile-new=""
                disabled={!snapshot || busy}
                size="sm"
                type="button"
                onClick={() => openComposer()}
              >
                <PlusIcon data-icon="inline-start" />
                <span className="hidden sm:inline">New Profile</span>
              </Button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <main className="mx-auto grid w-full max-w-6xl content-start items-start gap-6 px-5 py-6">
            {workspaceError ? (
              <div
                className="flex items-start justify-between gap-4 rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                <span>{workspaceError}</span>
                <Button
                  aria-label="Dismiss Error"
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() => setWorkspaceError(null)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}

            {composer && duplicatePath ? (
              <div
                className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                “{fileNameFromPath(duplicatePath)}” appears more than once.
                Remove a duplicate file tab before saving.
              </div>
            ) : null}

            {composer && duplicateScratch ? (
              <div
                className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                The same scratch is assigned to more than one tab. Choose a
                different scratch before saving.
              </div>
            ) : null}

            {!snapshot && pendingAction === "load" ? (
              <div
                className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading Window Profiles…
              </div>
            ) : composer && snapshot ? (
              <fieldset className="contents" disabled={busy}>
                <legend className="sr-only">Window Profile Composer</legend>
                <div className="grid items-start gap-8">
                  <section
                    aria-labelledby="profile-details-title"
                    className="grid gap-4"
                  >
                    <h2
                      id="profile-details-title"
                      className="font-heading text-base font-medium"
                    >
                      Profile Details
                    </h2>
                    <div className="flex flex-wrap items-end gap-3">
                      <label
                        className="grid w-full max-w-sm gap-1.5 text-sm font-medium"
                        htmlFor={nameInputId}
                      >
                        Profile Name
                        <Input
                          ref={nameInputRef}
                          id={nameInputId}
                          autoComplete="off"
                          maxLength={MAX_PROFILE_NAME_LENGTH}
                          placeholder="Writing Workspace"
                          value={composer.draft.name}
                          onChange={(event) => {
                            const name = event.currentTarget.value
                            updateComposerDraft((draft) => {
                              if (composer.replace) return { ...draft, name }
                              const usedIds = new Set(
                                snapshot.profiles.map(
                                  ({ profile }) => profile.id
                                )
                              )
                              return {
                                ...draft,
                                name,
                                id: uniqueIdentifier(
                                  slugIdentifier(name, "new-profile"),
                                  usedIds
                                ),
                              }
                            })
                          }}
                        />
                      </label>
                      <label
                        className="grid w-44 gap-1.5 text-sm font-medium"
                        htmlFor={defaultModeId}
                      >
                        Default Mode
                        <Select
                          value={composer.draft.mode ?? INHERIT_MODE}
                          onValueChange={(value) => {
                            if (value === null) return
                            updateComposerDraft((draft) => ({
                              ...draft,
                              mode:
                                value === INHERIT_MODE
                                  ? undefined
                                  : (value as EditorMode),
                            }))
                          }}
                        >
                          <SelectTrigger id={defaultModeId} className="w-full">
                            <SelectValue>
                              {composer.draft.mode === undefined
                                ? "App Setting"
                                : editorModeLabels[composer.draft.mode]}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value={INHERIT_MODE}>
                                App Setting
                              </SelectItem>
                              <SelectItem value="live">Rendered</SelectItem>
                              <SelectItem value="source">
                                Raw Markdown
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </label>
                      <label
                        className="grid w-60 gap-1.5 text-sm font-medium"
                        htmlFor={tabVisibilityId}
                      >
                        Tabs Visibility
                        <Select
                          value={composer.draft.tabVisibility}
                          onValueChange={(value) => {
                            if (value === null) return
                            updateComposerDraft((draft) => ({
                              ...draft,
                              tabVisibility:
                                value as WindowProfileTabVisibility,
                            }))
                          }}
                        >
                          <SelectTrigger
                            id={tabVisibilityId}
                            className="w-full"
                          >
                            <SelectValue>
                              {
                                tabVisibilityLabels[
                                  composer.draft.tabVisibility
                                ]
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {(
                                [
                                  "inherit",
                                  "always",
                                  "multiple-tabs",
                                  "mouseover",
                                  "formatting-bar",
                                  "hidden",
                                ] as const
                              ).map((visibility) => (
                                <SelectItem key={visibility} value={visibility}>
                                  {tabVisibilityLabels[visibility]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </label>
                    </div>
                  </section>

                  <section
                    aria-labelledby="compose-tabs-title"
                    className="grid gap-5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2
                        id="compose-tabs-title"
                        className="font-heading text-base font-medium"
                      >
                        Compose Tabs
                      </h2>
                      <div
                        className="flex items-center gap-2"
                        data-profile-tab-actions=""
                      >
                        <Button
                          disabled={
                            busy ||
                            composer.draft.tabs.length >= MAX_PROFILE_TABS
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={addUntitledTab}
                        >
                          <PlusIcon data-icon="inline-start" />
                          Add Tab
                        </Button>
                        <Button
                          disabled={busy || !selectedTab}
                          size="sm"
                          type="button"
                          variant="destructive"
                          onClick={removeSelectedTab}
                        >
                          <Trash2Icon data-icon="inline-start" />
                          Remove Tab
                        </Button>
                      </div>
                    </div>

                    <div
                      className="grid w-full items-start gap-8 md:mx-auto md:w-fit md:max-w-full md:grid-cols-[auto_minmax(17rem,20rem)]"
                      data-profile-composer-columns=""
                    >
                      <div className="min-w-0">
                        {composer.draft.tabs.length > 0 ? (
                          <ProfileComposerTabs
                            activeTabId={composer.draft.activeTab}
                            disabled={busy}
                            selectedTabId={composer.selectedTabId}
                            tabs={composer.draft.tabs}
                            onActiveTabChange={(activeTab) =>
                              updateComposerDraft((draft) => ({
                                ...draft,
                                activeTab,
                              }))
                            }
                            onReorder={(tabs) =>
                              updateComposerDraft((draft) => ({
                                ...draft,
                                tabs,
                              }))
                            }
                            onSelect={(selectedTabId) =>
                              setComposer((current) =>
                                current
                                  ? { ...current, selectedTabId }
                                  : current
                              )
                            }
                          />
                        ) : (
                          <div className="grid max-w-md gap-3 text-sm text-muted-foreground">
                            <p>No tabs have been added yet.</p>
                            <Button
                              className="w-fit text-foreground"
                              disabled={busy}
                              size="sm"
                              type="button"
                              variant="outline"
                              onClick={() => void copyCurrentWindowTabs()}
                            >
                              {pendingAction === "current-window-tabs"
                                ? "Loading Current Tabs…"
                                : "Use Current Window’s Tabs"}
                            </Button>
                          </div>
                        )}
                      </div>

                      <WindowProfileTabInspector
                        disabled={busy}
                        profileId={composer.draft.id}
                        scratches={scratches}
                        selectedTab={selectedTab}
                        usedScratchIdentityKeys={usedScratchIdentityKeys}
                        onChange={(tab) =>
                          selectedTab && updateTab(selectedTab.id, () => tab)
                        }
                        onSelectFile={() => {
                          if (selectedTab) void selectFiles(selectedTab.id)
                        }}
                      />
                    </div>
                  </section>
                </div>
              </fieldset>
            ) : snapshot ? (
              <>
                <section
                  aria-labelledby="saved-profiles-title"
                  className="grid gap-3"
                >
                  <div>
                    <h2
                      id="saved-profiles-title"
                      className="font-heading text-base font-medium"
                    >
                      Saved Profiles
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Launch or edit a reusable window-tabs configuration.
                    </p>
                  </div>
                  {snapshot.profiles.length === 0 ? (
                    <div className="rounded-3xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
                      No saved profiles yet.
                    </div>
                  ) : (
                    <div
                      className="flex flex-wrap items-start gap-3"
                      data-saved-profile-list=""
                    >
                      {snapshot.profiles.map((entry) => (
                        <Card
                          key={entry.profile.id}
                          className="w-fit max-w-full self-start rounded-3xl p-4 shadow-none ring-border/70"
                          size="sm"
                        >
                          <CardContent className="grid max-w-full min-w-0 items-start gap-4 p-0">
                            <div className="min-w-0">
                              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                                <h3 className="truncate font-heading text-sm font-medium">
                                  {entry.profile.name}
                                </h3>
                                {snapshot.currentProfileId ===
                                entry.profile.id ? (
                                  <Badge>Current Window</Badge>
                                ) : entry.open ? (
                                  <Badge variant="secondary">Open</Badge>
                                ) : null}
                                {snapshot.defaultProfileId ===
                                entry.profile.id ? (
                                  <Badge variant="outline">
                                    Launch Default
                                  </Badge>
                                ) : null}
                              </div>
                              <ProfileSummary entry={entry} />
                            </div>
                            <SavedProfileTabsPreview profile={entry.profile} />
                            <div
                              className="flex shrink-0 flex-wrap items-center justify-end gap-2"
                              data-saved-profile-actions=""
                            >
                              <Button
                                disabled={busy}
                                size="sm"
                                type="button"
                                onClick={() =>
                                  void launchProfile(entry.profile.id)
                                }
                              >
                                {pendingAction === `launch-${entry.profile.id}`
                                  ? "Launching…"
                                  : "Launch"}
                              </Button>
                              {entry.open &&
                              snapshot.currentProfileId !== entry.profile.id ? (
                                <OpenProfileEditAction
                                  guidanceId={`profile-${entry.profile.id}-open-guidance`}
                                  profileId={entry.profile.id}
                                />
                              ) : (
                                <Button
                                  data-window-profile-edit={entry.profile.id}
                                  disabled={busy}
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                  onClick={() => openComposer(entry)}
                                >
                                  Edit
                                </Button>
                              )}
                              <span
                                className="sr-only"
                                id={`profile-${entry.profile.id}-open-guidance`}
                              >
                                {snapshot.currentProfileId === entry.profile.id
                                  ? CURRENT_PROFILE_DELETE_GUIDANCE
                                  : PROFILE_OPEN_GUIDANCE}
                              </span>
                              <Button
                                aria-label={`Delete Profile ${entry.profile.name}`}
                                aria-describedby={
                                  entry.open
                                    ? `profile-${entry.profile.id}-open-guidance`
                                    : undefined
                                }
                                disabled={busy || entry.open}
                                size="icon-sm"
                                type="button"
                                variant="destructive"
                                onClick={() => {
                                  setProfileDeleteError(null)
                                  setProfileDeleteTarget(entry)
                                }}
                              >
                                <Trash2Icon />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <div className="rounded-3xl border border-dashed border-border px-5 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Window profiles are unavailable.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={onBack}
                >
                  Back to Settings
                </Button>
              </div>
            )}
          </main>
        </div>

        <AlertDialog
          open={profileDeleteTarget !== null}
          onOpenChange={(open) => {
            if (!open && !busy) {
              setProfileDeleteError(null)
              setProfileDeleteTarget(null)
            }
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Profile?</AlertDialogTitle>
              <AlertDialogDescription>
                Delete “{profileDeleteTarget?.profile.name}”? Documents and
                scratches are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {profileDeleteError ? (
              <p
                className="rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {profileDeleteError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                variant="destructive"
                onClick={() => void deleteProfile()}
              >
                {pendingAction?.startsWith("delete-profile-")
                  ? "Deleting…"
                  : "Delete Profile"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}

export default WindowProfilesWorkspace
