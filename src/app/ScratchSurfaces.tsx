import type { ComponentProps } from "react"

import ScratchBrowser from "@/app/ScratchBrowser"
import ScratchMarkdownPreview from "@/app/ScratchMarkdownPreview"
import ScratchesWorkspace from "@/app/ScratchesWorkspace"
import type { AppPlatform, AppSettings } from "@/shared/contracts"

type ScratchBrowserProps = ComponentProps<typeof ScratchBrowser>
type ScratchesWorkspaceProps = ComponentProps<typeof ScratchesWorkspace>

export interface ScratchBrowserSurfaceProps extends Omit<
  ScratchBrowserProps,
  "getScratchPreview" | "getScratches" | "renderPreview"
> {
  platform: AppPlatform
  settings: AppSettings
}

export default function ScratchBrowserSurface({
  platform,
  settings,
  ...props
}: ScratchBrowserSurfaceProps) {
  return (
    <ScratchBrowser
      {...props}
      getScratchPreview={window.pulseMd.getScratchPreview}
      getScratches={window.pulseMd.getScratches}
      renderPreview={(state) => (
        <ScratchMarkdownPreview
          platform={platform}
          settings={settings}
          state={state}
        />
      )}
    />
  )
}

export interface ScratchesWorkspaceSurfaceProps extends Omit<
  ScratchesWorkspaceProps,
  | "deleteScratch"
  | "getScratchPreview"
  | "getScratches"
  | "renderPreview"
  | "updateScratch"
> {
  platform: AppPlatform
  settings: AppSettings
}

export function ScratchesWorkspaceSurface({
  platform,
  settings,
  ...props
}: ScratchesWorkspaceSurfaceProps) {
  return (
    <ScratchesWorkspace
      {...props}
      deleteScratch={window.pulseMd.deleteScratch}
      getScratchPreview={window.pulseMd.getScratchPreview}
      getScratches={window.pulseMd.getScratches}
      updateScratch={window.pulseMd.updateScratch}
      renderPreview={(state) => (
        <ScratchMarkdownPreview
          platform={platform}
          settings={settings}
          state={state}
        />
      )}
    />
  )
}
