import * as React from "react"
import { CloudAlertIcon } from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

interface ScratchSaveFailureNoticeProps {
  displayName: string
  onRetry: () => Promise<boolean>
  onSaveCopy: () => Promise<boolean>
}

export function ScratchSaveFailureNotice({
  displayName,
  onRetry,
  onSaveCopy,
}: ScratchSaveFailureNoticeProps) {
  const [busyAction, setBusyAction] = React.useState<
    "retry" | "save-copy" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = React.useCallback(
    async (
      actionName: "retry" | "save-copy",
      action: () => Promise<boolean>
    ) => {
      setBusyAction(actionName)
      setError(null)
      try {
        const saved = await action()
        if (!saved && actionName === "retry") {
          setError(
            "The scratch still could not be saved. Fix the storage problem, then retry or save a copy."
          )
        }
      } catch (actionError) {
        console.error("Unable to recover unsaved scratch", actionError)
        setError(
          actionError instanceof Error && actionError.message.trim()
            ? actionError.message
            : "The scratch still could not be saved. Try again or save a copy."
        )
      } finally {
        setBusyAction(null)
      }
    },
    []
  )

  return (
    <Alert
      aria-live="assertive"
      className="pointer-events-auto flex w-full flex-wrap items-center gap-2 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-xl"
      data-recovery-notice="scratch-save"
      role="alert"
    >
      <CloudAlertIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-destructive"
      />
      <span className="min-w-32 flex-1 text-sm">
        Changes to <strong className="font-medium">{displayName}</strong> have
        not been saved. Automatic saving will keep retrying.
      </span>
      <span className="ml-auto flex shrink-0 gap-1.5">
        <Button
          disabled={busyAction !== null}
          size="xs"
          type="button"
          variant="outline"
          onClick={() => void run("retry", onRetry)}
        >
          {busyAction === "retry" ? "Retrying…" : "Retry Now"}
        </Button>
        <Button
          disabled={busyAction !== null}
          size="xs"
          type="button"
          onClick={() => void run("save-copy", onSaveCopy)}
        >
          {busyAction === "save-copy" ? "Saving…" : "Save a Copy…"}
        </Button>
      </span>
      {error ? (
        <span className="w-full text-xs text-destructive">{error}</span>
      ) : null}
    </Alert>
  )
}
