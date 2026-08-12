import * as React from "react"
import { HashIcon } from "lucide-react"

import { ActiveTabIndicator } from "@/app/ActiveTabIndicator"
import { PathLabel } from "@/app/PathLabel"
import { cn } from "@/lib/utils"
import type { FilePathDisplayMode, TabColor } from "@/shared/contracts"

export interface WindowProfileTabPreviewProps extends Omit<
  React.ComponentProps<"button">,
  "children"
> {
  active?: boolean
  color?: TabColor
  display?: FilePathDisplayMode
  displayName: string
  dragging?: boolean
  filePath?: string | null
  interactive?: boolean
  selected?: boolean
}

export function WindowProfileTabMark({ color }: { color: TabColor }) {
  return (
    <span
      aria-hidden="true"
      className="window-profile-tab-mark"
      data-colored={color || undefined}
      data-tab-color={color}
    >
      <HashIcon strokeWidth={3} />
    </span>
  )
}

export function WindowProfileTabPreview({
  active = false,
  className,
  color,
  display = "path",
  displayName,
  dragging = false,
  filePath = null,
  interactive = true,
  selected = false,
  type = "button",
  ...props
}: WindowProfileTabPreviewProps) {
  const content = (
    <>
      <ActiveTabIndicator />
      <span className="document-tab-content">
        {color ? <WindowProfileTabMark color={color} /> : null}
        <PathLabel
          className="tab-label"
          display={display}
          displayName={displayName}
          filePath={filePath}
        />
      </span>
    </>
  )
  const surfaceProps = {
    className: cn("document-tab window-profile-tab-preview", className),
    "data-active": active || undefined,
    "data-dragging": dragging || undefined,
    "data-selected": selected || undefined,
    "data-tab-color": color,
  }

  if (!interactive) {
    return (
      <div {...surfaceProps} aria-label={props["aria-label"]} role="img">
        {content}
      </div>
    )
  }

  return (
    <button
      {...surfaceProps}
      aria-pressed={selected}
      data-active={active || undefined}
      tabIndex={props.tabIndex}
      type={type}
      {...props}
    >
      {content}
    </button>
  )
}
