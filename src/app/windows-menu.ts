import type { WindowsMenuId } from "@/shared/contracts"

export interface WindowsMenuDefinition {
  id: WindowsMenuId
  label: string
  mnemonic: string
}

export const WINDOWS_MENU_DEFINITIONS = [
  { id: "file", label: "File", mnemonic: "f" },
  { id: "edit", label: "Edit", mnemonic: "e" },
  { id: "format", label: "Format", mnemonic: "o" },
  { id: "view", label: "View", mnemonic: "v" },
  { id: "window", label: "Window", mnemonic: "w" },
  { id: "help", label: "Help", mnemonic: "h" },
] as const satisfies readonly WindowsMenuDefinition[]

export function windowsMenuForMnemonic(key: string): WindowsMenuId | null {
  const mnemonic = key.toLowerCase()
  return (
    WINDOWS_MENU_DEFINITIONS.find((item) => item.mnemonic === mnemonic)?.id ??
    null
  )
}

export function stepWindowsMenu(
  current: WindowsMenuId,
  direction: -1 | 1,
  enabled: (menu: WindowsMenuId) => boolean = () => true
): WindowsMenuId {
  const currentIndex = WINDOWS_MENU_DEFINITIONS.findIndex(
    (item) => item.id === current
  )
  for (let offset = 1; offset <= WINDOWS_MENU_DEFINITIONS.length; offset += 1) {
    const index =
      (currentIndex + offset * direction + WINDOWS_MENU_DEFINITIONS.length) %
      WINDOWS_MENU_DEFINITIONS.length
    const candidate = WINDOWS_MENU_DEFINITIONS[index]!.id
    if (enabled(candidate)) return candidate
  }
  return current
}
