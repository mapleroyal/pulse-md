import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"

import type { WindowProfileComposerState } from "@/app/WindowProfilesWorkspace"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type {
  WindowProfile,
  WindowProfileCaptureKind,
  WindowProfileEntry,
  WindowProfileSeed,
  WindowProfileTab,
  WindowProfileTabMode,
  WindowProfilesSnapshot,
} from "@/shared/contracts"

const MAX_PROFILE_ID_LENGTH = 64
const MAX_PROFILE_NAME_LENGTH = 128

export interface WindowProfileCaptureDialogProps {
  kind: WindowProfileCaptureKind
  tabModes: readonly WindowProfileTabMode[]
  onClose: () => void
  onPendingChange: (pending: boolean) => void
  onReview: (composer: WindowProfileComposerState) => Promise<void> | void
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function slugIdentifier(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROFILE_ID_LENGTH)
    .replace(/-+$/g, "")
  const candidate = normalized || "new-profile"
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate)
    ? `profile-${candidate}`
    : candidate
}

function uniqueIdentifier(base: string, snapshot: WindowProfilesSnapshot) {
  const used = new Set(snapshot.profiles.map(({ profile }) => profile.id))
  if (!used.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`
    const candidate = `${base
      .slice(0, MAX_PROFILE_ID_LENGTH - suffixText.length)
      .replace(/-+$/g, "")}${suffixText}`
    if (!used.has(candidate)) return candidate
  }
}

function cloneTab(tab: WindowProfileTab): WindowProfileTab {
  return { ...tab }
}

function profileFromCapture(
  kind: WindowProfileCaptureKind,
  name: string,
  seed: WindowProfileSeed,
  snapshot: WindowProfilesSnapshot
): { entry: WindowProfileEntry | null; profile: WindowProfile } {
  if (kind === "update") {
    const entry =
      snapshot.profiles.find(
        ({ profile }) => profile.id === snapshot.currentProfileId
      ) ?? null
    if (!entry) throw new Error("This window is not using a saved profile.")
    return {
      entry,
      profile: {
        ...entry.profile,
        activeTab: seed.activeTab,
        tabs: seed.tabs.map(cloneTab),
      },
    }
  }

  const id = uniqueIdentifier(slugIdentifier(name), snapshot)
  return {
    entry: null,
    profile: {
      version: 2,
      id,
      name: name.trim(),
      activeTab: seed.activeTab,
      tabVisibility: "inherit",
      tabs: seed.tabs.map(cloneTab),
    },
  }
}

function composerForProfile(
  profile: WindowProfile,
  replace: boolean
): WindowProfileComposerState {
  return {
    replace,
    selectedTabId: profile.activeTab,
    draft: {
      version: 2,
      id: profile.id,
      name: profile.name,
      activeTab: profile.activeTab,
      tabVisibility: profile.tabVisibility,
      ...(profile.mode === undefined ? {} : { mode: profile.mode }),
      tabs: profile.tabs.map(cloneTab),
    },
  }
}

export default function WindowProfileCaptureDialog({
  kind,
  tabModes,
  onClose,
  onPendingChange,
  onReview,
}: WindowProfileCaptureDialogProps) {
  const [snapshot, setSnapshot] = React.useState<WindowProfilesSnapshot | null>(
    null
  )
  const [name, setName] = React.useState("")
  const [pendingAction, setPendingAction] = React.useState<
    "save" | "review" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void window.pulseMd
      .getWindowProfiles()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            messageFromError(loadError, "Window profiles could not be loaded.")
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const currentEntry = snapshot?.profiles.find(
    ({ profile }) => profile.id === snapshot.currentProfileId
  )
  const nameRequired = kind === "create" && name.trim().length === 0
  const updateUnavailable =
    kind === "update" && snapshot !== null && currentEntry === undefined
  const busy = pendingAction !== null

  const capture = async (action: "save" | "review") => {
    if (!snapshot || busy || nameRequired) return
    setPendingAction(action)
    onPendingChange(true)
    setError(null)
    try {
      const seed = await window.pulseMd.getCurrentWindowProfileSeed(
        tabModes,
        kind
      )
      const { profile } = profileFromCapture(kind, name, seed, snapshot)
      if (action === "review") {
        await onReview(composerForProfile(profile, kind === "update"))
      } else {
        await window.pulseMd.saveWindowProfile(profile, kind === "update")
        onClose()
      }
    } catch (captureError) {
      console.error("Unable to capture window profile", captureError)
      setError(
        messageFromError(
          captureError,
          kind === "update"
            ? "The current profile could not be updated."
            : "The new profile could not be created."
        )
      )
    } finally {
      onPendingChange(false)
      setPendingAction(null)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "update"
              ? "Update Current Profile?"
              : "Create Profile from Current Tabs?"}
          </DialogTitle>
          <DialogDescription>
            {kind === "update"
              ? `Replace ${currentEntry ? `“${currentEntry.profile.name}”` : "the current profile"} with this window’s tabs, or review the captured definition first. Changes affect future launches and do not rearrange this window.`
              : "Save this window’s current tabs as a reusable profile, or review and customize the captured definition first."}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Profiles save the tab setup, not untitled or temporary tab text.
          Scratch text remains stored separately.
        </p>

        {kind === "create" ? (
          <label className="grid gap-1.5 text-sm font-medium">
            Profile Name
            <Input
              autoFocus
              autoComplete="off"
              disabled={busy}
              maxLength={MAX_PROFILE_NAME_LENGTH}
              placeholder="Writing Workspace"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
        ) : null}

        {error || updateUnavailable ? (
          <p className="text-sm text-destructive" role="alert">
            {error ?? "This window is not using an available saved profile."}
          </p>
        ) : !snapshot ? (
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircleIcon className="size-4 animate-spin" />
            Loading profile details…
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={!snapshot || busy || nameRequired || updateUnavailable}
            type="button"
            variant="outline"
            onClick={() => void capture("review")}
          >
            {pendingAction === "review" ? "Opening…" : "Review & Edit…"}
          </Button>
          <Button
            disabled={!snapshot || busy || nameRequired || updateUnavailable}
            type="button"
            onClick={() => void capture("save")}
          >
            {pendingAction === "save"
              ? kind === "update"
                ? "Updating…"
                : "Creating…"
              : kind === "update"
                ? "Update"
                : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
