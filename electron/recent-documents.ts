import path from "node:path"

export const RECENT_DOCUMENTS_VERSION = 1
export const MAX_RECENT_DOCUMENTS = 20
export const MAX_RECENT_DOCUMENT_PATH_LENGTH = 32_768

export interface RecentDocumentsFile {
  paths: string[]
  version: typeof RECENT_DOCUMENTS_VERSION
}

function pathImplementation(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix
}

function recentDocumentIdentity(
  filePath: string,
  platform: NodeJS.Platform
): string {
  return platform === "win32" ? filePath.toLowerCase() : filePath
}

export function normalizeRecentDocumentPaths(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!Array.isArray(value)) return []

  const platformPath = pathImplementation(platform)
  const paths: string[] = []
  const identities = new Set<string>()
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_RECENT_DOCUMENT_PATH_LENGTH ||
      entry.includes("\0") ||
      !platformPath.isAbsolute(entry)
    ) {
      continue
    }

    const normalized = platformPath.normalize(entry)
    const identity = recentDocumentIdentity(normalized, platform)
    if (identities.has(identity)) continue
    identities.add(identity)
    paths.push(normalized)
    if (paths.length === MAX_RECENT_DOCUMENTS) break
  }
  return paths
}

export function normalizeRecentDocuments(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<RecentDocumentsFile>).version !== RECENT_DOCUMENTS_VERSION
  ) {
    return []
  }
  return normalizeRecentDocumentPaths(
    (value as Partial<RecentDocumentsFile>).paths,
    platform
  )
}

export function addRecentDocumentPath(
  current: readonly string[],
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return normalizeRecentDocumentPaths([filePath, ...current], platform)
}

export function recentDocumentsFile(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform
): RecentDocumentsFile {
  return {
    paths: normalizeRecentDocumentPaths(paths, platform),
    version: RECENT_DOCUMENTS_VERSION,
  }
}
