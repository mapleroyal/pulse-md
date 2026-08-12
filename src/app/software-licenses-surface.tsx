import { createRoot, type Root } from "react-dom/client"

import SoftwareLicensesSurface from "@/app/SoftwareLicensesSurface"
import { loadSoftwareLicenseInventory } from "@/app/software-license-data"

interface MountedSurface {
  container: HTMLDivElement
  onOpenChange: (open: boolean) => void
  returnFocus: HTMLElement | null
  root: Root | null
}

let mountedSurface: MountedSurface | null = null

function disposeSurface() {
  const surface = mountedSurface
  if (!surface) return
  mountedSurface = null
  let focusOwnershipTransferred = false
  const transferFocusOwnership = () => {
    focusOwnershipTransferred = true
  }
  document.addEventListener("focusin", transferFocusOwnership, true)
  document.addEventListener("keydown", transferFocusOwnership, true)
  document.addEventListener("pointerdown", transferFocusOwnership, true)
  surface.root?.unmount()
  surface.container.remove()
  surface.onOpenChange(false)
  requestAnimationFrame(() => {
    document.removeEventListener("focusin", transferFocusOwnership, true)
    document.removeEventListener("keydown", transferFocusOwnership, true)
    document.removeEventListener("pointerdown", transferFocusOwnership, true)
    const activeElement = document.activeElement
    const focusIsUnowned =
      !activeElement ||
      activeElement === document.body ||
      activeElement === document.documentElement ||
      !activeElement.isConnected
    if (
      !focusOwnershipTransferred &&
      focusIsUnowned &&
      surface.returnFocus?.isConnected
    ) {
      surface.returnFocus.focus({ preventScroll: true })
    }
  })
}

export function prepareSoftwareLicenses() {
  return loadSoftwareLicenseInventory()
}

export async function openSoftwareLicenses(
  onOpenChange: (open: boolean) => void
) {
  if (mountedSurface) return

  const container = document.createElement("div")
  container.dataset.softwareLicensesHost = ""
  document.body.append(container)
  const surface: MountedSurface = {
    container,
    onOpenChange,
    returnFocus:
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    root: null,
  }
  mountedSurface = surface
  onOpenChange(true)
  try {
    const inventory = await prepareSoftwareLicenses()
    if (mountedSurface !== surface || !container.isConnected) return
    surface.root = createRoot(container)
    surface.root.render(
      <SoftwareLicensesSurface
        inventory={inventory}
        onClosed={disposeSurface}
      />
    )
  } catch (error) {
    if (mountedSurface === surface) disposeSurface()
    throw error
  }
}
