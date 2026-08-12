import type {
  ScratchDocumentIdentity,
  WindowProfileTab,
} from "@/shared/contracts"

const tabKindFallbacks = {
  ephemeral: "Temporary",
  file: "File",
  scratch: "Scratch",
  untitled: "Untitled",
} as const

export function fileNameFromPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/g, "")
  return normalized.slice(normalized.lastIndexOf("/") + 1) || filePath
}

export function windowProfileTabDisplayName(tab: WindowProfileTab) {
  if (tab.title) return tab.title
  if (tab.kind === "file") return fileNameFromPath(tab.path)
  return tabKindFallbacks[tab.kind]
}

export function windowProfileTabDisplayPath(tab: WindowProfileTab) {
  return tab.kind === "file" && !tab.title ? tab.path : null
}

export function resolvedWindowProfileScratchIdentity(
  _profileId: string,
  tab: WindowProfileTab
): ScratchDocumentIdentity | null {
  if (tab.kind !== "scratch") return null
  return { scratchId: tab.scratchId }
}

export function windowProfileScratchIdentityKey(
  identity: ScratchDocumentIdentity
) {
  return identity.scratchId
}
