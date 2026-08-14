import { randomUUID } from "node:crypto"
import { link, lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { openFileForSync, syncParentDirectory } from "./file-durability"

export type SettingsFileLoadResult<T> =
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "loaded"; readonly value: T }
  | { readonly kind: "missing" }

export async function loadSettingsFile<T>(
  filePath: string,
  normalize: (value: unknown) => T
): Promise<SettingsFileLoadResult<T>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
    return { kind: "loaded", value: normalize(parsed) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" }
    }
    return { error, kind: "failed" }
  }
}

export async function preserveSettingsFileForReset(
  filePath: string,
  timestamp = Date.now(),
  uniqueId = randomUUID()
): Promise<string | null> {
  try {
    await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const extension = path.extname(filePath)
  const baseName = path.basename(filePath, extension)
  const preservedPath = path.join(
    path.dirname(filePath),
    `${baseName}.preserved-${timestamp}-${uniqueId}${extension}`
  )
  await link(filePath, preservedPath)
  const preservedHandle = await openFileForSync(preservedPath)
  try {
    await preservedHandle.sync()
  } finally {
    await preservedHandle.close()
  }
  await syncParentDirectory(filePath)
  return preservedPath
}

export async function resetSettingsFilePreservingOriginal(
  filePath: string,
  reset: () => Promise<void>
): Promise<string | null> {
  const preservedPath = await preserveSettingsFileForReset(filePath)
  await reset()
  return preservedPath
}
