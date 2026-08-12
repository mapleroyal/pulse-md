import * as React from "react"

import SoftwareLicensesDialog from "@/app/SoftwareLicensesDialog"
import type { SoftwareLicenseInventory } from "@/app/software-license-data"

const CLOSE_SETTLE_MS = 150

export default function SoftwareLicensesSurface({
  inventory,
  onClosed,
}: {
  inventory: SoftwareLicenseInventory
  onClosed: () => void
}) {
  const [open, setOpen] = React.useState(true)

  React.useEffect(() => {
    if (open) return
    const timer = window.setTimeout(onClosed, CLOSE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [onClosed, open])

  return (
    <SoftwareLicensesDialog
      inventory={inventory}
      open={open}
      onOpenChange={setOpen}
    />
  )
}
