import type { TabBackingKind } from "@/shared/contracts"

export interface CliTabReplacementCandidate {
  active: boolean
  backing: TabBackingKind
  cleanDocumentLength: number
  descriptor: {
    backing: TabBackingKind
    dirty: boolean
    displayName: string
    fileMissing: boolean
    filePath: string | null
  }
  dirty: boolean
  documentFilePath: string | null
  editorDocumentLength: number
}

export function isDisposableCliTabReplacement(
  candidate: CliTabReplacementCandidate
): boolean {
  return (
    candidate.active &&
    candidate.backing === "untitled" &&
    candidate.descriptor.backing === "untitled" &&
    !candidate.dirty &&
    !candidate.descriptor.dirty &&
    candidate.documentFilePath === null &&
    candidate.descriptor.filePath === null &&
    !candidate.descriptor.fileMissing &&
    candidate.descriptor.displayName === "Untitled" &&
    candidate.cleanDocumentLength === 0 &&
    candidate.editorDocumentLength === 0
  )
}
