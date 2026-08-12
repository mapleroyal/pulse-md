import { open } from "node:fs/promises"
import path from "node:path"

const UNSUPPORTED_DIRECTORY_SYNC_ERROR_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
])

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return UNSUPPORTED_DIRECTORY_SYNC_ERROR_CODES.has(
    (error as NodeJS.ErrnoException).code ?? ""
  )
}

/**
 * Makes a previously published directory entry durable on platforms that
 * support syncing directory handles. Windows does not expose directory fsync
 * through Node, while a small number of filesystems report the operation as
 * unsupported; all other failures remain actionable I/O errors.
 */
export async function syncParentDirectory(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === "win32") return

  const handle = await open(path.dirname(filePath), "r")
  try {
    await handle.sync()
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error
  } finally {
    await handle.close()
  }
}
