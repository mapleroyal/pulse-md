import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

interface DeferredSurfaceErrorBoundaryProps {
  children: React.ReactNode
  fallback: (error: unknown, retry: () => void) => React.ReactNode
  resetKey?: unknown
}

interface DeferredSurfaceErrorBoundaryState {
  error: unknown
  revision: number
}

export class DeferredSurfaceErrorBoundary extends React.Component<
  DeferredSurfaceErrorBoundaryProps,
  DeferredSurfaceErrorBoundaryState
> {
  state: DeferredSurfaceErrorBoundaryState = {
    error: null,
    revision: 0,
  }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    console.error("Deferred feature failed to render", error)
  }

  componentDidUpdate(previousProps: DeferredSurfaceErrorBoundaryProps) {
    if (
      this.state.error &&
      !Object.is(previousProps.resetKey, this.props.resetKey)
    ) {
      this.setState({ error: null })
    }
  }

  private retry = () => {
    this.setState((current) => ({
      error: null,
      revision: current.revision + 1,
    }))
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.retry)
    }
    return (
      <React.Fragment key={this.state.revision}>
        {this.props.children}
      </React.Fragment>
    )
  }
}

export function DeferredFeatureFailure({
  description,
  title,
  onRetry,
}: {
  description: string
  title: string
  onRetry: () => void
}) {
  return (
    <Alert
      className="pointer-events-auto gap-2 bg-popover/95 shadow-lg backdrop-blur-md"
      data-deferred-feature-failure=""
      variant="destructive"
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <div className="mt-1 flex justify-end">
        <Button size="sm" type="button" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </Alert>
  )
}

export function DeferredPopoverFailure({
  align = "end",
  anchor,
  description,
  open,
  side = "bottom",
  title,
  trigger,
  onOpenChange,
  onRetry,
}: {
  align?: React.ComponentProps<typeof PopoverContent>["align"]
  anchor?: React.ComponentProps<typeof PopoverContent>["anchor"]
  description: string
  open: boolean
  side?: React.ComponentProps<typeof PopoverContent>["side"]
  title: string
  trigger?: React.ReactElement
  onOpenChange: (open: boolean) => void
  onRetry: () => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger ? <PopoverTrigger render={trigger} /> : null}
      <PopoverContent
        align={align}
        anchor={anchor}
        className="w-[min(22rem,calc(100vw-1rem))] gap-3 rounded-2xl p-4"
        collisionPadding={8}
        positionMethod="fixed"
        side={side}
      >
        <PopoverTitle>{title}</PopoverTitle>
        <p className="text-sm text-destructive" role="alert">
          {description}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button size="sm" type="button" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DeferredDialogFailure({
  description,
  title,
  onCancel,
  onRetry,
}: {
  description: string
  title: string
  onCancel: () => void
  onRetry: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent aria-label={title} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-destructive" role="alert">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onRetry}>
            Retry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
