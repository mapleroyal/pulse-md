import * as React from "react"
import { FileWarningIcon } from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

interface FileMissingNoticeProps {
  displayName: string
  onRecreate: () => Promise<boolean>
  onSaveAs: () => Promise<boolean>
}

export function FileMissingNotice({
  displayName,
  onRecreate,
  onSaveAs,
}: FileMissingNoticeProps) {
  const [busyAction, setBusyAction] = React.useState<
    "recreate" | "save-as" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = React.useCallback(
    async (
      actionName: "recreate" | "save-as",
      action: () => Promise<boolean>
    ) => {
      setBusyAction(actionName)
      setError(null)
      try {
        await action()
      } catch (actionError) {
        console.error("Unable to recover missing file", actionError)
        setError(
          actionError instanceof Error && actionError.message.trim()
            ? actionError.message
            : "The file could not be saved. Try again or choose another location."
        )
      } finally {
        setBusyAction(null)
      }
    },
    []
  )

  return (
    <Alert
      aria-live="polite"
      className="pointer-events-auto flex w-full flex-wrap items-center gap-2 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-xl"
      data-recovery-notice="file-missing"
      role={error ? "alert" : "status"}
    >
      <FileWarningIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-destructive"
      />
      <span className="min-w-32 flex-1 text-sm">
        <strong className="font-medium">{displayName}</strong> was deleted or
        moved.
      </span>
      <span className="ml-auto flex shrink-0 gap-1.5">
        <Button
          disabled={busyAction !== null}
          size="xs"
          type="button"
          variant="outline"
          onClick={() => void run("recreate", onRecreate)}
        >
          {busyAction === "recreate" ? "Recreating…" : "Recreate File"}
        </Button>
        <Button
          disabled={busyAction !== null}
          size="xs"
          type="button"
          onClick={() => void run("save-as", onSaveAs)}
        >
          {busyAction === "save-as" ? "Saving…" : "Save As…"}
        </Button>
      </span>
      {error ? (
        <span className="w-full text-xs text-destructive">{error}</span>
      ) : null}
    </Alert>
  )
}
