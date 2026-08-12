import { opendir, stat } from "node:fs/promises"
import path from "node:path"

import type { PathCompletionEntry } from "../src/shared/contracts"

export const MAX_PATH_COMPLETION_QUERY_LENGTH = 32_768
export const MAX_PATH_COMPLETION_ENTRIES = 200
export const MAX_PATH_COMPLETION_SCANNED_ENTRIES = 50_000

const MAX_PATH_COMPLETION_SYMLINK_STATS = MAX_PATH_COMPLETION_ENTRIES * 2
const PATH_COMPLETION_CANDIDATE_TRIM_MULTIPLIER = 2

function validPathCompletionQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PATH_COMPLETION_QUERY_LENGTH &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

function safePathCompletionName(name: string) {
  return ![...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function completionDirectory(
  query: string,
  sourceFilePath: string | null,
  homeDirectory: string
) {
  const separatorIndex = Math.max(
    query.lastIndexOf("/"),
    query.lastIndexOf("\\")
  )
  const directoryPart =
    separatorIndex < 0 ? "" : query.slice(0, separatorIndex + 1)
  const prefix = query.slice(separatorIndex + 1)

  let directoryPath: string
  if (/^~[\\/]/.test(directoryPart)) {
    directoryPath = path.resolve(homeDirectory, directoryPart.slice(2))
  } else if (path.isAbsolute(directoryPart || query)) {
    directoryPath = path.resolve(directoryPart || path.parse(query).root)
  } else {
    if (!sourceFilePath) return null
    directoryPath = path.resolve(path.dirname(sourceFilePath), directoryPart)
  }
  return { directoryPath, prefix }
}

export async function filesystemPathCompletions(options: {
  cancelled?: () => boolean
  homeDirectory: string
  query: unknown
  sourceFilePath: string | null
}): Promise<readonly PathCompletionEntry[]> {
  if (!validPathCompletionQuery(options.query)) {
    throw new TypeError("Path completion query is invalid")
  }
  const target = completionDirectory(
    options.query,
    options.sourceFilePath,
    options.homeDirectory
  )
  if (!target) return []

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  })
  const retainCandidate = (
    candidates: string[],
    name: string,
    maximum: number
  ) => {
    candidates.push(name)
    if (
      candidates.length <
      maximum * PATH_COMPLETION_CANDIDATE_TRIM_MULTIPLIER
    ) {
      return
    }
    candidates.sort(collator.compare)
    candidates.length = maximum
  }
  const cancelled = options.cancelled ?? (() => false)
  if (cancelled()) return []

  const directoryNames: string[] = []
  const fileNames: string[] = []
  const symbolicLinkNames: string[] = []
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(target.directoryPath)
  } catch {
    return []
  }

  const normalizedPrefix = target.prefix.toLocaleLowerCase()
  const includeHidden = target.prefix.startsWith(".")
  let scannedEntries = 0
  try {
    for await (const entry of directory) {
      if (cancelled()) return []
      scannedEntries += 1
      if (
        safePathCompletionName(entry.name) &&
        (includeHidden || !entry.name.startsWith(".")) &&
        entry.name.toLocaleLowerCase().startsWith(normalizedPrefix)
      ) {
        if (entry.isDirectory()) {
          retainCandidate(
            directoryNames,
            entry.name,
            MAX_PATH_COMPLETION_ENTRIES
          )
        } else if (entry.isFile()) {
          retainCandidate(fileNames, entry.name, MAX_PATH_COMPLETION_ENTRIES)
        } else if (entry.isSymbolicLink()) {
          retainCandidate(
            symbolicLinkNames,
            entry.name,
            MAX_PATH_COMPLETION_SYMLINK_STATS
          )
        }
      }
      if (scannedEntries >= MAX_PATH_COMPLETION_SCANNED_ENTRIES) break
    }
  } catch {
    return []
  }

  directoryNames.sort(collator.compare)
  directoryNames.length = Math.min(
    directoryNames.length,
    MAX_PATH_COMPLETION_ENTRIES
  )
  fileNames.sort(collator.compare)
  fileNames.length = Math.min(fileNames.length, MAX_PATH_COMPLETION_ENTRIES)
  symbolicLinkNames.sort(collator.compare)
  symbolicLinkNames.length = Math.min(
    symbolicLinkNames.length,
    MAX_PATH_COMPLETION_SYMLINK_STATS
  )

  const resolved: PathCompletionEntry[] = [
    ...directoryNames.map((name) => ({
      kind: "directory" as const,
      name,
    })),
    ...fileNames.map((name) => ({ kind: "file" as const, name })),
  ]
  let nextSymbolicLink = 0
  await Promise.all(
    Array.from({ length: Math.min(8, symbolicLinkNames.length) }, async () => {
      while (nextSymbolicLink < symbolicLinkNames.length && !cancelled()) {
        const name = symbolicLinkNames[nextSymbolicLink++]!
        try {
          const targetStats = await stat(path.join(target.directoryPath, name))
          if (targetStats.isDirectory()) {
            resolved.push({ kind: "directory", name })
          } else if (targetStats.isFile()) {
            resolved.push({ kind: "file", name })
          }
        } catch {
          // Broken and inaccessible links are not useful completions.
        }
      }
    })
  )

  if (cancelled()) return []
  return resolved
    .sort(
      (left, right) =>
        (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
        collator.compare(left.name, right.name)
    )
    .slice(0, MAX_PATH_COMPLETION_ENTRIES)
}
