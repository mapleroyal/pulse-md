import * as React from "react"

import { Popover, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type LongTextPopoverProps = {
  anchor: HTMLElement | null
  children: React.ReactNode
  className?: string
  label: string
  open: boolean
  side?: React.ComponentProps<typeof PopoverContent>["side"]
  onOpenChange: (open: boolean) => void
}

export function LongTextPopover({
  anchor,
  children,
  className,
  label,
  open,
  side = "top",
  onOpenChange,
}: LongTextPopoverProps) {
  return (
    <Popover open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <PopoverContent
        anchor={anchor}
        aria-label={label}
        className={cn(
          "pointer-events-none w-max max-w-[min(36rem,var(--available-width))] gap-0 rounded-xl bg-foreground px-3 py-1.5 text-left text-xs leading-normal [overflow-wrap:anywhere] whitespace-normal text-background shadow-none ring-0",
          className
        )}
        collisionPadding={8}
        data-long-text-popover=""
        finalFocus={false}
        initialFocus={false}
        positionerClassName="pointer-events-none"
        role="tooltip"
        side={side}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export default LongTextPopover
