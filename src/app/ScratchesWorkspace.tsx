import * as React from "react"
import {
  ArrowLeftIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"

import {
  normalizedScratchFilename,
  scratchFilenameError,
  scratchTitle,
  type ScratchOpenDisposition,
  type ScratchPreviewDocument,
  type ScratchSort,
  type ScratchSummary,
} from "@/app/scratch-picker-model"
import {
  ScratchPicker,
  type ScratchPreviewRenderState,
} from "@/app/ScratchPicker"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { ScratchUpdate } from "@/shared/contracts"
import {
  useScratchInventory,
  type GetScratchInventory,
} from "@/app/use-scratch-inventory"

const MAX_SCRATCH_TITLE_LENGTH = 256

export interface ScratchesWorkspaceProps {
  getScratches: GetScratchInventory
  getScratchPreview: (scratchId: string) => Promise<ScratchPreviewDocument>
  newScratch: () => Promise<unknown> | unknown
  updateScratch: (
    scratchId: string,
    update: ScratchUpdate
  ) => Promise<unknown> | unknown
  deleteScratch: (scratchId: string) => Promise<unknown> | unknown
  openScratch: (
    scratchId: string,
    disposition: ScratchOpenDisposition
  ) => Promise<unknown> | unknown
  onBack: () => void
  onNavigationBlockedChange: (blocked: boolean) => void
  renderPreview?: (state: ScratchPreviewRenderState) => React.ReactNode
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function ScratchDetailsForm({
  busy,
  fileName,
  pendingAction,
  profileReferencesAvailable,
  scratch,
  title,
  onChange,
  onSave,
}: {
  busy: boolean
  fileName: string
  pendingAction: string | null
  profileReferencesAvailable: boolean
  scratch: ScratchSummary
  title: string
  onChange: (fileName: string, title: string) => void
  onSave: (fileName: string, title: string | null) => void
}) {
  const fileNameInputId = React.useId()
  const titleInputId = React.useId()
  const filenameError = scratchFilenameError(fileName)
  const normalizedFileName = normalizedScratchFilename(fileName)
  const normalizedTitle = title.trim() || null
  const detailsChanged =
    normalizedFileName !== scratch.fileName || normalizedTitle !== scratch.title
  const deleteGuard = !profileReferencesAvailable
    ? "Profile references could not be checked. Refresh the list before deleting."
    : scratch.open
      ? "Close this scratch before deleting it."
      : scratch.profiles.length > 0
        ? `Remove this scratch from ${scratch.profiles.length === 1 ? "the profile below" : "the profiles below"} before deleting it.`
        : null

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <label
          className="grid min-w-0 gap-1.5 text-xs font-medium"
          htmlFor={fileNameInputId}
        >
          Filename
          <Input
            id={fileNameInputId}
            aria-invalid={filenameError ? true : undefined}
            autoComplete="off"
            disabled={busy}
            maxLength={255}
            value={fileName}
            onChange={(event) => onChange(event.currentTarget.value, title)}
          />
        </label>
        <label
          className="grid min-w-0 gap-1.5 text-xs font-medium"
          htmlFor={titleInputId}
        >
          Title
          <Input
            id={titleInputId}
            autoComplete="off"
            disabled={busy}
            maxLength={MAX_SCRATCH_TITLE_LENGTH}
            placeholder="Optional"
            value={title}
            onChange={(event) => onChange(fileName, event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          {filenameError ? (
            <p className="text-destructive" role="alert">
              {filenameError}
            </p>
          ) : deleteGuard ? (
            <p id={`scratch-delete-guard-${scratch.scratchId}`}>
              {deleteGuard}
            </p>
          ) : null}
          {scratch.profiles.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {scratch.profiles.map((profile) => (
                <Tooltip key={profile.id}>
                  <TooltipTrigger
                    render={<Badge tabIndex={0} variant="outline" />}
                  >
                    {profile.name}
                  </TooltipTrigger>
                  <TooltipContent>
                    Used in the “{profile.name}” window profile
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          ) : null}
        </div>
        <Button
          disabled={busy || !detailsChanged || !!filenameError}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => onSave(normalizedFileName, normalizedTitle)}
        >
          <SaveIcon data-icon="inline-start" />
          {pendingAction === `save:${scratch.scratchId}`
            ? "Saving…"
            : "Save Details"}
        </Button>
      </div>
    </div>
  )
}

export function ScratchesWorkspace({
  getScratches,
  getScratchPreview,
  newScratch,
  updateScratch,
  deleteScratch,
  openScratch,
  onBack,
  onNavigationBlockedChange,
  renderPreview,
}: ScratchesWorkspaceProps) {
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const didInitialFocusRef = React.useRef(false)
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<ScratchSort>("last-opened")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [pendingAction, setPendingAction] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [detailsDrafts, setDetailsDrafts] = React.useState(
    () => new Map<string, { fileName: string; title: string }>()
  )
  const [discardDialogOpen, setDiscardDialogOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<ScratchSummary | null>(
    null
  )
  const {
    entries,
    error: inventoryError,
    loaded,
    loading,
    profileReferencesAvailable,
    current: resultsCurrent,
    refresh,
  } = useScratchInventory({ getScratches, query, sort })

  const busy = pendingAction !== null
  const initialLoading = loading && !loaded
  const operationBlocked = busy || deleteTarget !== null || initialLoading
  const hasDetailsDrafts = detailsDrafts.size > 0
  const navigationBlocked =
    operationBlocked || hasDetailsDrafts || discardDialogOpen

  React.useLayoutEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true })
  }, [])

  React.useEffect(() => {
    const refreshAfterActivation = () => void refresh().catch(() => undefined)
    window.addEventListener("focus", refreshAfterActivation)
    return () => {
      window.removeEventListener("focus", refreshAfterActivation)
    }
  }, [refresh])

  React.useEffect(() => {
    if (!loaded || didInitialFocusRef.current) return
    didInitialFocusRef.current = true
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })
  }, [loaded])

  React.useEffect(() => {
    onNavigationBlockedChange(navigationBlocked)
    return () => onNavigationBlockedChange(false)
  }, [navigationBlocked, onNavigationBlockedChange])

  const createNewScratch = async () => {
    if (busy) return
    setPendingAction("create")
    setError(null)
    try {
      await newScratch()
    } catch (nextError) {
      setError(errorText(nextError, "A new scratch could not be created."))
      setPendingAction(null)
      return
    }
    setQuery("")
    setSort("last-opened")
    try {
      const nextInventory = await refresh("", "last-opened")
      setSelectedId(nextInventory.entries[0]?.scratchId ?? null)
    } catch {
      setError("The scratch was created, but the list could not be refreshed.")
    }
    setPendingAction(null)
  }

  const saveDetails = async (
    scratch: ScratchSummary,
    fileName: string,
    title: string | null
  ) => {
    if (busy) return
    const scratchId = scratch.scratchId
    setPendingAction(`save:${scratchId}`)
    setError(null)
    try {
      await updateScratch(scratchId, {
        ...(fileName === scratch.fileName ? {} : { fileName }),
        ...(title === scratch.title ? {} : { title }),
      })
      await refresh()
      setDetailsDrafts((current) => {
        if (!current.has(scratchId)) return current
        const next = new Map(current)
        next.delete(scratchId)
        return next
      })
    } catch (nextError) {
      setError(errorText(nextError, "The scratch details could not be saved."))
      try {
        await refresh()
      } catch {
        // Retain the actionable mutation error if the recovery refresh fails.
      }
    } finally {
      setPendingAction(null)
    }
  }

  const openSelectedScratch = async (
    scratch: ScratchSummary,
    disposition: ScratchOpenDisposition
  ) => {
    if (busy) return
    setPendingAction(`open:${scratch.scratchId}`)
    setError(null)
    try {
      await openScratch(scratch.scratchId, disposition)
      await refresh()
    } catch (nextError) {
      setError(errorText(nextError, "The scratch could not be opened."))
    } finally {
      setPendingAction(null)
    }
  }

  const confirmDelete = async () => {
    if (
      !deleteTarget ||
      !profileReferencesAvailable ||
      deleteTarget.open ||
      deleteTarget.profiles.length > 0 ||
      busy
    ) {
      return
    }
    const scratchId = deleteTarget.scratchId
    const deletedIndex = entries.findIndex(
      (scratch) => scratch.scratchId === scratchId
    )
    setPendingAction(`delete:${scratchId}`)
    setError(null)
    setDeleteError(null)
    try {
      await deleteScratch(scratchId)
    } catch (nextError) {
      const message = errorText(nextError, "The scratch could not be deleted.")
      setDeleteError(message)
      setError(message)
      setPendingAction(null)
      return
    }
    setDeleteTarget(null)
    setSelectedId(null)
    setDetailsDrafts((current) => {
      if (!current.has(scratchId)) return current
      const next = new Map(current)
      next.delete(scratchId)
      return next
    })
    try {
      const nextScratches = (await refresh()).entries
      const nextSelection =
        nextScratches[
          Math.min(Math.max(0, deletedIndex), nextScratches.length - 1)
        ] ?? null
      setSelectedId(nextSelection?.scratchId ?? null)
    } catch {
      setError("The scratch was deleted, but the list could not be refreshed.")
    }
    setPendingAction(null)
  }

  const handleBack = () => {
    if (operationBlocked) return
    if (hasDetailsDrafts) {
      setDiscardDialogOpen(true)
      return
    }
    onBack()
  }

  const updateDetailsDraft = (
    scratch: ScratchSummary,
    fileName: string,
    title: string
  ) => {
    const normalizedTitle = title.trim() || null
    const unchanged =
      normalizedScratchFilename(fileName) === scratch.fileName &&
      normalizedTitle === scratch.title
    setDetailsDrafts((current) => {
      const next = new Map(current)
      if (unchanged) next.delete(scratch.scratchId)
      else next.set(scratch.scratchId, { fileName, title })
      return next
    })
  }

  const discardDraftsAndGoBack = () => {
    setDetailsDrafts(new Map())
    setDiscardDialogOpen(false)
    onNavigationBlockedChange(false)
    onBack()
  }

  return (
    <TooltipProvider>
      <div
        ref={workspaceRef}
        aria-label="Scratches Workspace"
        className="absolute inset-0 z-50 flex min-h-0 flex-col bg-[var(--document-background)] pt-[var(--window-chrome-height)] text-[var(--document-foreground)] outline-none"
        data-scratches-workspace=""
        role="region"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            deleteTarget !== null
          ) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          if (query) {
            setQuery("")
            inputRef.current?.focus({ preventScroll: true })
          } else {
            handleBack()
          }
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[var(--window-chrome-height)] [-webkit-app-region:drag]"
        />
        <header className="shrink-0 border-b border-border/70 bg-[var(--document-background)]">
          <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-3 px-5 py-2">
            <Button
              aria-label="Back to Settings"
              className="-ml-2"
              disabled={operationBlocked}
              size="sm"
              type="button"
              variant="ghost"
              onClick={handleBack}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-base font-medium">
              Scratches
            </h1>
            <Button
              aria-label="New Scratch"
              className="max-sm:size-8 max-sm:pr-0 max-sm:has-data-[icon=inline-start]:pl-0"
              disabled={busy || initialLoading}
              size="sm"
              type="button"
              onClick={() => void createNewScratch()}
            >
              <PlusIcon data-icon="inline-start" />
              <span className="hidden sm:inline">
                {pendingAction === "create" ? "Creating…" : "New Scratch"}
              </span>
            </Button>
          </div>
        </header>

        <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-5 py-5">
          {initialLoading ? (
            <div
              className="grid min-h-64 flex-1 place-items-center text-sm text-muted-foreground"
              role="status"
            >
              Loading Scratches…
            </div>
          ) : (
            <ScratchPicker
              errorMessage={
                error ??
                (!inventoryError && !profileReferencesAvailable
                  ? "Profile references could not be checked. Delete is unavailable until the list is refreshed."
                  : null)
              }
              inputRef={inputRef}
              inventoryError={inventoryError}
              loadPreview={getScratchPreview}
              loading={loading}
              query={query}
              renderPreview={renderPreview}
              resultsCurrent={resultsCurrent}
              scratches={entries}
              selectedId={selectedId}
              sort={sort}
              onActivate={(scratch, disposition) =>
                void openSelectedScratch(scratch, disposition)
              }
              onEscapeWhenEmpty={handleBack}
              onQueryChange={setQuery}
              onRetryInventory={() => void refresh().catch(() => undefined)}
              onSelectedIdChange={setSelectedId}
              onSortChange={setSort}
              renderActions={(scratch, interactionDisabled) => (
                <>
                  <Button
                    disabled={busy || interactionDisabled}
                    size="sm"
                    type="button"
                    onClick={() => void openSelectedScratch(scratch, "default")}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    Open
                  </Button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Open Scratch in New Tab"
                          disabled={busy || interactionDisabled}
                          size="icon-sm"
                          type="button"
                          variant="outline"
                          onClick={() =>
                            void openSelectedScratch(scratch, "new-tab")
                          }
                        />
                      }
                    >
                      <FilePlus2Icon />
                    </TooltipTrigger>
                    <TooltipContent>Open in New Tab</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label={`Delete ${scratchTitle(scratch)}`}
                          aria-describedby={
                            !profileReferencesAvailable ||
                            scratch.open ||
                            scratch.profiles.length > 0
                              ? `scratch-delete-guard-${scratch.scratchId}`
                              : undefined
                          }
                          disabled={
                            busy ||
                            interactionDisabled ||
                            !profileReferencesAvailable ||
                            scratch.open ||
                            scratch.profiles.length > 0
                          }
                          size="icon-sm"
                          type="button"
                          variant="destructive"
                          onClick={() => {
                            setDeleteError(null)
                            setDeleteTarget(scratch)
                          }}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipContent>
                      {!profileReferencesAvailable
                        ? "Refresh profile references before deleting"
                        : scratch.open
                          ? "Close before deleting"
                          : scratch.profiles.length > 0
                            ? "Remove profile references before deleting"
                            : "Delete Scratch"}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
              renderDetails={(scratch, interactionDisabled) =>
                (() => {
                  const draft = detailsDrafts.get(scratch.scratchId)
                  return (
                    <ScratchDetailsForm
                      key={scratch.scratchId}
                      busy={busy || interactionDisabled}
                      fileName={draft?.fileName ?? scratch.fileName}
                      pendingAction={pendingAction}
                      profileReferencesAvailable={profileReferencesAvailable}
                      scratch={scratch}
                      title={draft?.title ?? scratch.title ?? ""}
                      onChange={(fileName, title) =>
                        updateDetailsDraft(scratch, fileName, title)
                      }
                      onSave={(fileName, title) =>
                        void saveDetails(scratch, fileName, title)
                      }
                    />
                  )
                })()
              }
            />
          )}
        </main>

        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !busy) {
              setDeleteError(null)
              setDeleteTarget(null)
            }
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Permanently Delete Scratch?</AlertDialogTitle>
              <AlertDialogDescription>
                Delete “{deleteTarget ? scratchTitle(deleteTarget) : ""}” and
                its Markdown file? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? (
              <p
                className="rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {deleteError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || !profileReferencesAvailable}
                variant="destructive"
                onClick={() => void confirmDelete()}
              >
                {pendingAction?.startsWith("delete:")
                  ? "Deleting…"
                  : "Delete Scratch"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={discardDialogOpen}
          onOpenChange={(nextOpen) => setDiscardDialogOpen(nextOpen)}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Discard Unsaved Details?</AlertDialogTitle>
              <AlertDialogDescription>
                Filename or title changes have not been saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={discardDraftsAndGoBack}
              >
                Discard Changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}

export default ScratchesWorkspace
