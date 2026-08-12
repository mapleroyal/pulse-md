import type { FileHandle } from "node:fs/promises"

const POSIX_PERMISSION_BITS = 0o7777

/**
 * Prefer the target mode observed immediately before replacement. If a target
 * that existed when the transaction began was deleted, an approved recreate
 * retains that original mode instead of falling back to the process umask.
 */
export function modeForAtomicReplacement(
  initialMode: number | undefined,
  commitMode: number | undefined
): number | undefined {
  return commitMode ?? initialMode
}

/**
 * Creation modes are filtered through the process umask. Reapply an existing
 * target's permission bits to the private temporary file before it is renamed
 * into place so an atomic save does not silently narrow shared-file access.
 */
export async function preserveExistingFileMode(
  handle: FileHandle,
  existingMode: number | undefined,
  platform = process.platform
): Promise<void> {
  if (platform === "win32" || existingMode === undefined) return
  await handle.chmod(existingMode & POSIX_PERMISSION_BITS)
}
