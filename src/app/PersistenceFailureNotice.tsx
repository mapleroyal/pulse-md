import * as React from "react"
import { CircleAlertIcon, XIcon } from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

interface PersistenceFailureNoticeProps {
  message: string
  onDismiss: () => void
  onRetry: () => Promise<void>
}

export function PersistenceFailureNotice({
  message,
  onDismiss,
  onRetry,
}: PersistenceFailureNoticeProps) {
  const [busy, setBusy] = React.useState(false)
  const [retryError, setRetryError] = React.useState<string | null>(null)

  const retry = React.useCallback(async () => {
    setBusy(true)
    setRetryError(null)
    try {
      await onRetry()
    } catch (error) {
      console.error("Unable to retry persisted setting", error)
      setRetryError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The change still could not be saved."
      )
    } finally {
      setBusy(false)
    }
  }, [onRetry])

  return (
    <Alert
      aria-live="assertive"
      className="pointer-events-auto flex w-full flex-wrap items-center gap-2 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-xl"
      data-recovery-notice="persistence"
      role="alert"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-destructive"
      />
      <span className="min-w-0 flex-1 text-sm">{message}</span>
      <Button
        disabled={busy}
        size="xs"
        type="button"
        variant="outline"
        onClick={() => void retry()}
      >
        {busy ? "Retrying…" : "Retry"}
      </Button>
      <Button
        aria-label="Dismiss"
        className="size-7"
        disabled={busy}
        size="icon-xs"
        type="button"
        variant="ghost"
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" />
      </Button>
      {retryError ? (
        <span className="w-full text-xs text-destructive">{retryError}</span>
      ) : null}
    </Alert>
  )
}
