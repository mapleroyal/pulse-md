import * as React from "react"
import { createPortal } from "react-dom"

import {
  createRetryableDeferredLoader,
  useDeferredValue,
} from "@/app/deferred-loader"
import { DeferredSurfaceErrorBoundary } from "@/app/DeferredSurface"
import { Button } from "@/components/ui/button"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"

type SettingsDialogComponent =
  (typeof import("@/app/SettingsDialog"))["default"]

const loadSettingsDialogModule = createRetryableDynamicImport(
  () => import("@/app/SettingsDialog")
)
const loadTypographyPreviewWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/TypographyPreviewWorkspace")
)

const settingsDialogLoader = createRetryableDeferredLoader(() =>
  Promise.all([
    loadSettingsDialogModule(),
    loadTypographyPreviewWorkspaceModule(),
  ]).then(([module]) => {
    return module.default
  })
)

function prepareSettingsDialog() {
  return settingsDialogLoader.load()
}

function DeferredSettingsDialog(
  props: React.ComponentProps<SettingsDialogComponent>
) {
  const {
    error,
    retry,
    value: Dialog,
  } = useDeferredValue(settingsDialogLoader, props.open)

  if (!Dialog) {
    return (
      <SettingsDialogFallback
        {...props}
        loadError={error !== null}
        onRetryLoad={retry}
      />
    )
  }

  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_error, retryRender) => (
        <SettingsDialogFallback
          {...props}
          loadError
          onRetryLoad={retryRender}
        />
      )}
    >
      <Dialog {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

DeferredSettingsDialog.prepare = prepareSettingsDialog

export default DeferredSettingsDialog

function SettingsDialogFallback({
  loadError = false,
  open,
  settings,
  onCancel,
  onSave,
  onSaveHandlerChange,
  onRetryLoad,
}: React.ComponentProps<SettingsDialogComponent> & {
  loadError?: boolean
  onRetryLoad?: () => void
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const retryButtonRef = React.useRef<HTMLButtonElement>(null)
  const savePromiseRef = React.useRef<Promise<boolean> | null>(null)
  const savingRef = React.useRef(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const save = React.useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current

    const operation = (async () => {
      savingRef.current = true
      setIsSaving(true)
      setSaveError(null)
      try {
        await onSave(settings)
        return true
      } catch (error) {
        console.error("Unable to save settings while loading", error)
        setSaveError(
          "Settings could not be saved. Check that the settings folder is writable, then try again."
        )
        return false
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    })()

    savePromiseRef.current = operation
    void operation.finally(() => {
      if (savePromiseRef.current === operation) {
        savePromiseRef.current = null
      }
    })
    return operation
  }, [onSave, settings])

  React.useLayoutEffect(() => {
    onSaveHandlerChange(save)
    return () => onSaveHandlerChange(null)
  }, [onSaveHandlerChange, save])

  React.useLayoutEffect(() => {
    if (open) dialogRef.current?.focus({ preventScroll: true })
  }, [open])

  React.useLayoutEffect(() => {
    if (!open) return
    const shell = document.querySelector<HTMLElement>(".app-shell")
    if (!shell) return
    const wasInert = shell.inert
    shell.inert = true
    return () => {
      shell.inert = wasInert
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-transparent"
      data-settings-loading=""
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !savingRef.current) {
          onCancel()
        }
      }}
    >
      <div
        ref={dialogRef}
        aria-label="Settings"
        aria-modal="true"
        className="relative grid min-h-36 w-[min(28rem,calc(100vw-2rem))] content-center gap-3 rounded-4xl bg-popover p-6 text-center text-popover-foreground shadow-xl ring-1 ring-foreground/5 outline-none"
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault()
            const focusable = [
              closeButtonRef.current,
              retryButtonRef.current,
            ].filter(
              (element): element is HTMLButtonElement =>
                element !== null && !element.disabled
            )
            const currentIndex = focusable.indexOf(
              document.activeElement as HTMLButtonElement
            )
            const direction = event.shiftKey ? -1 : 1
            const nextIndex =
              currentIndex < 0
                ? 0
                : (currentIndex + direction + focusable.length) %
                  focusable.length
            focusable[nextIndex]?.focus({ preventScroll: true })
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (!savingRef.current) onCancel()
          }
        }}
      >
        <button
          ref={closeButtonRef}
          aria-label="Close"
          className="close-icon-button absolute top-4 right-4 grid size-8 place-items-center rounded-full text-lg text-muted-foreground"
          disabled={isSaving}
          type="button"
          onClick={onCancel}
        >
          ×
        </button>
        <h1 className="font-heading text-base font-medium">Settings</h1>
        {loadError ? (
          <>
            <p className="text-sm text-destructive" role="alert">
              Settings could not be loaded.
            </p>
            <Button
              ref={retryButtonRef}
              className="justify-self-center"
              size="sm"
              type="button"
              variant="outline"
              onClick={onRetryLoad}
            >
              Retry
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading settings…
          </p>
        )}
        {saveError ? (
          <p className="text-sm text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
