import { describe, expect, it, vi } from "vitest"

import { reconcileAtomicWriteAfterRename } from "./atomic-write-reconciliation"

describe("atomic-write post-rename reconciliation", () => {
  it("returns the strict replacement verification without a second read", async () => {
    const strictResult = { mtimeMs: 10 }
    const verifyStableExpectedBytes = vi.fn(async () => ({ mtimeMs: 20 }))

    await expect(
      reconcileAtomicWriteAfterRename({
        acceptStableExpectedBytesAfterReplacementMismatch: true,
        verifyStableExpectedBytes,
        verifyStrictReplacement: async () => strictResult,
      })
    ).resolves.toBe(strictResult)
    expect(verifyStableExpectedBytes).not.toHaveBeenCalled()
  })

  it("does not reconcile an ordinary atomic-write mismatch", async () => {
    const replacementError = new Error("replacement identity changed")
    const verifyStableExpectedBytes = vi.fn(async () => ({ mtimeMs: 20 }))

    await expect(
      reconcileAtomicWriteAfterRename({
        acceptStableExpectedBytesAfterReplacementMismatch: false,
        verifyStableExpectedBytes,
        verifyStrictReplacement: async () => {
          throw replacementError
        },
      })
    ).rejects.toBe(replacementError)
    expect(verifyStableExpectedBytes).not.toHaveBeenCalled()
  })

  it("accepts imported settings after proving the renamed path has stable expected bytes", async () => {
    const reconciledFingerprint = { mtimeMs: 20 }
    const events: string[] = []

    await expect(
      reconcileAtomicWriteAfterRename({
        acceptStableExpectedBytesAfterReplacementMismatch: true,
        verifyStableExpectedBytes: async () => {
          events.push("verify-stable-expected-bytes")
          return reconciledFingerprint
        },
        verifyStrictReplacement: async () => {
          events.push("verify-strict-replacement")
          throw new Error("filesystem normalized post-rename metadata")
        },
      })
    ).resolves.toBe(reconciledFingerprint)
    expect(events).toEqual([
      "verify-strict-replacement",
      "verify-stable-expected-bytes",
    ])
  })

  it("preserves both failures when the renamed bytes cannot be reconciled", async () => {
    const replacementError = new Error("replacement identity changed")
    const verificationError = new Error("published bytes changed")

    const result = reconcileAtomicWriteAfterRename({
      acceptStableExpectedBytesAfterReplacementMismatch: true,
      verifyStableExpectedBytes: async () => {
        throw verificationError
      },
      verifyStrictReplacement: async () => {
        throw replacementError
      },
    })

    await expect(result).rejects.toMatchObject({
      cause: verificationError,
      errors: [replacementError, verificationError],
      message: "The save target changed after it was replaced",
    })
  })
})
