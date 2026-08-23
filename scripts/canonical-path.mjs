import { realpath } from "node:fs/promises"

export async function sameCanonicalPath(left, right) {
  if (!left || !right) return false
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ])
    return process.platform === "win32"
      ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
      : canonicalLeft === canonicalRight
  } catch {
    return false
  }
}
