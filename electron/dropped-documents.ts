import path from "node:path"

export const MAX_DROPPED_DOCUMENT_COUNT = 256

export function normalizeDroppedDocumentPaths(rawFilePaths: unknown): string[] {
  if (
    !Array.isArray(rawFilePaths) ||
    rawFilePaths.length > MAX_DROPPED_DOCUMENT_COUNT
  ) {
    throw new TypeError("Invalid dropped document list")
  }

  return rawFilePaths.map((rawFilePath) => {
    if (
      typeof rawFilePath !== "string" ||
      rawFilePath.length === 0 ||
      rawFilePath.includes("\0") ||
      !path.isAbsolute(rawFilePath)
    ) {
      throw new TypeError("Invalid dropped document path")
    }
    return path.resolve(rawFilePath)
  })
}
