import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { MarkdownLinkTooltip as MarkdownLinkTooltipState } from "@/editor/types"

export interface EditorLinkTooltipHandle {
  update(tooltip: MarkdownLinkTooltipState | null): void
}

export const EditorLinkTooltip = React.forwardRef<EditorLinkTooltipHandle>(
  function EditorLinkTooltip(_props, ref) {
    const [tooltip, setTooltip] =
      React.useState<MarkdownLinkTooltipState | null>(null)
    React.useImperativeHandle(ref, () => ({ update: setTooltip }), [])

    if (!tooltip) return null

    return (
      <TooltipProvider>
        <Tooltip
          key={`${tooltip.title}:${tooltip.anchor.left}:${tooltip.anchor.top}`}
          open
        >
          <TooltipTrigger
            render={
              <span
                aria-hidden="true"
                className="pointer-events-none fixed z-40"
                style={{
                  height: tooltip.anchor.height,
                  left: tooltip.anchor.left,
                  top: tooltip.anchor.top,
                  width: tooltip.anchor.width,
                }}
              />
            }
          />
          <TooltipContent className="[overflow-wrap:anywhere] whitespace-normal">
            {tooltip.title}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
)
