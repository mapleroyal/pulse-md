import * as React from "react"

import type { ActiveTabIndicatorPreviewWorkspaceProps } from "@/app/ActiveTabIndicatorPreviewWorkspace"
import {
  createRetryableDeferredLoader,
  type RetryableDeferredLoader,
  useDeferredValue,
} from "@/app/deferred-loader"
import { DeferredSurfaceErrorBoundary } from "@/app/DeferredSurface"
import type { LaunchTransitionPreviewWorkspaceProps } from "@/app/LaunchTransitionPreviewWorkspace"
import type { TypographyPreviewWorkspaceProps } from "@/app/TypographyPreviewWorkspace"
import type { WindowProfilesWorkspaceProps } from "@/app/WindowProfilesWorkspace"
import type { ScratchesWorkspaceSurfaceProps } from "@/app/ScratchSurfaces"
import { Button } from "@/components/ui/button"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"

type SettingsWorkspace =
  | {
      kind: "active-tab-indicator"
      props: ActiveTabIndicatorPreviewWorkspaceProps
    }
  | {
      kind: "typography"
      props: TypographyPreviewWorkspaceProps
    }
  | {
      kind: "launch-transition"
      props: LaunchTransitionPreviewWorkspaceProps
    }
  | {
      kind: "window-profiles"
      props: WindowProfilesWorkspaceProps
    }
  | {
      kind: "scratches"
      props: ScratchesWorkspaceSurfaceProps
    }

export interface DeferredSettingsWorkspaceProps {
  workspace: SettingsWorkspace
}

function SettingsWorkspaceLoading({
  error = false,
  label,
  title,
  onCancel,
  onRetry,
}: {
  error?: boolean
  label: string
  title: string
  onCancel: () => void
  onRetry?: () => void
}) {
  const workspaceRef = React.useRef<HTMLElement>(null)

  React.useLayoutEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <section
      ref={workspaceRef}
      aria-busy={error ? undefined : "true"}
      aria-label={label}
      className="pointer-events-auto absolute inset-0 z-30 flex min-h-0 flex-col bg-[var(--document-background)] pt-[var(--window-chrome-height)] text-[var(--document-foreground)] outline-none"
      data-settings-workspace-loading=""
      data-settings-workspace-state={error ? "error" : "loading"}
      role="region"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <div className="grid min-h-0 flex-1 place-items-center p-4">
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-border/70 bg-popover px-4 py-3 text-popover-foreground shadow-sm">
          <p
            className={
              error
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
            role={error ? "alert" : "status"}
          >
            {error ? `${title} could not be loaded.` : `Loading ${title}…`}
          </p>
          {error ? (
            <Button size="sm" type="button" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </section>
  )
}

const loadTypographyWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/TypographyPreviewWorkspace")
)
const loadLaunchTransitionWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/LaunchTransitionPreviewWorkspace")
)
const loadActiveTabIndicatorWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/ActiveTabIndicatorPreviewWorkspace")
)
const loadWindowProfilesWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/WindowProfilesWorkspace")
)
const loadScratchesWorkspaceModule = createRetryableDynamicImport(
  () => import("@/app/ScratchSurfaces")
)

const typographyWorkspaceLoader = createRetryableDeferredLoader(() =>
  loadTypographyWorkspaceModule().then((module) => module.default)
)
const launchTransitionWorkspaceLoader = createRetryableDeferredLoader(() =>
  loadLaunchTransitionWorkspaceModule().then((module) => module.default)
)
const activeTabIndicatorWorkspaceLoader = createRetryableDeferredLoader(() =>
  loadActiveTabIndicatorWorkspaceModule().then((module) => module.default)
)
const windowProfilesWorkspaceLoader = createRetryableDeferredLoader(() =>
  loadWindowProfilesWorkspaceModule().then((module) => module.default)
)
const scratchesWorkspaceLoader = createRetryableDeferredLoader(() =>
  loadScratchesWorkspaceModule().then(
    (module) => module.ScratchesWorkspaceSurface
  )
)

function prepareTypographyWorkspace() {
  return typographyWorkspaceLoader.load()
}

function RetryableSettingsWorkspace<Props extends object>({
  label,
  loader,
  onCancel,
  props,
  title,
}: {
  label: string
  loader: RetryableDeferredLoader<React.ComponentType<Props>>
  onCancel: () => void
  props: Props
  title: string
}) {
  const { error, retry, value: Workspace } = useDeferredValue(loader)
  const failure = (retryLoad: () => void) => (
    <SettingsWorkspaceLoading
      error
      label={label}
      title={title}
      onCancel={onCancel}
      onRetry={retryLoad}
    />
  )

  if (!Workspace) {
    return error ? (
      failure(retry)
    ) : (
      <SettingsWorkspaceLoading
        label={label}
        title={title}
        onCancel={onCancel}
      />
    )
  }

  return (
    <DeferredSurfaceErrorBoundary
      fallback={(_renderError, retryRender) => failure(retryRender)}
    >
      <Workspace {...props} />
    </DeferredSurfaceErrorBoundary>
  )
}

function DeferredSettingsWorkspace({
  workspace,
}: DeferredSettingsWorkspaceProps) {
  switch (workspace.kind) {
    case "active-tab-indicator":
      return (
        <RetryableSettingsWorkspace
          label="Active tab indicator preview workspace"
          loader={activeTabIndicatorWorkspaceLoader}
          onCancel={workspace.props.onCancel}
          props={workspace.props}
          title="Active Tab Indicator Preview"
        />
      )
    case "typography":
      return (
        <RetryableSettingsWorkspace
          label="Typography preview workspace"
          loader={typographyWorkspaceLoader}
          onCancel={workspace.props.onCancel}
          props={workspace.props}
          title="Typography Preview"
        />
      )
    case "launch-transition":
      return (
        <RetryableSettingsWorkspace
          label="Launch transition preview workspace"
          loader={launchTransitionWorkspaceLoader}
          onCancel={workspace.props.onCancel}
          props={workspace.props}
          title="Launch Transition Preview"
        />
      )
    case "window-profiles":
      return (
        <RetryableSettingsWorkspace
          label="Window Profiles Workspace"
          loader={windowProfilesWorkspaceLoader}
          onCancel={workspace.props.onBack}
          props={workspace.props}
          title="Window Profiles"
        />
      )
    case "scratches":
      return (
        <RetryableSettingsWorkspace
          label="Scratches Workspace"
          loader={scratchesWorkspaceLoader}
          onCancel={workspace.props.onBack}
          props={workspace.props}
          title="Scratches"
        />
      )
  }
}

DeferredSettingsWorkspace.prepareTypography = prepareTypographyWorkspace

export default DeferredSettingsWorkspace
