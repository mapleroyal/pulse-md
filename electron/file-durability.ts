import { open, rename } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"

const UNSUPPORTED_DIRECTORY_SYNC_ERROR_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
])

const WINDOWS_TRANSIENT_RENAME_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
])
const WINDOWS_RENAME_RETRY_DELAYS_MS = [
  10, 20, 40, 80, 160, 320, 640, 1_280, 2_560,
] as const

type RenameFile = (sourcePath: string, destinationPath: string) => Promise<void>
type Wait = (milliseconds: number) => Promise<unknown>

interface RenameReplacingFileOptions {
  readonly beforeRetryAttempt?: () => Promise<void>
  readonly platform?: NodeJS.Platform
  readonly renameFile?: RenameFile
  readonly wait?: Wait
}

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return UNSUPPORTED_DIRECTORY_SYNC_ERROR_CODES.has(
    (error as NodeJS.ErrnoException).code ?? ""
  )
}

/**
 * Opens a regular file with the minimum access required for fsync. Node's
 * Windows implementation requires write access for FlushFileBuffers, while
 * Unix filesystems can sync a read-only descriptor without requiring the file
 * itself to remain writable.
 */
export async function openFileForSync(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<FileHandle> {
  return open(filePath, platform === "win32" ? "r+" : "r")
}

/**
 * Atomically publishes a same-directory replacement. Windows scanners can
 * briefly open the destination without delete sharing, causing rename to fail
 * with a sharing-style error even after all application handles are closed.
 * Retrying the native rename retains its atomic replace semantics; persistent
 * permission failures surface after the short, bounded backoff.
 */
export async function renameReplacingFile(
  sourcePath: string,
  destinationPath: string,
  options: RenameReplacingFileOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const renameFile = options.renameFile ?? rename
  const waitForRetry = options.wait ?? wait

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(sourcePath, destinationPath)
      return
    } catch (error) {
      const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
      if (
        platform !== "win32" ||
        retryDelay === undefined ||
        !WINDOWS_TRANSIENT_RENAME_ERROR_CODES.has(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        throw error
      }
      await waitForRetry(retryDelay)
      await options.beforeRetryAttempt?.()
    }
  }
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
