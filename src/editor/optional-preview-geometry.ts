import { StateEffect, type Transaction } from "@codemirror/state"

export const refreshOptionalPreviewGeometry = StateEffect.define<null>()

export function optionalPreviewGeometryRefreshRequested(
  transaction: Transaction
) {
  return transaction.effects.some((effect) =>
    effect.is(refreshOptionalPreviewGeometry)
  )
}

export class PreviewHeightCache {
  private readonly maximumSize: number
  private readonly maximumKeyBytes: number
  private keyBytes = 0
  private readonly values = new Map<string, number>()

  constructor(maximumSize: number, maximumKeyBytes = 2 * 1024 * 1024) {
    this.maximumSize = maximumSize
    this.maximumKeyBytes = maximumKeyBytes
  }

  get(key: string) {
    const height = this.values.get(key)
    if (height == null) return null
    this.values.delete(key)
    this.values.set(key, height)
    return height
  }

  set(key: string, height: number) {
    if (!Number.isFinite(height) || height <= 0) return
    if (this.values.delete(key)) this.keyBytes -= key.length * 2
    // HTML keys contain authored source, whose size is independent of the
    // rendered height. A count cap alone can retain entire closed documents.
    if (key.length * 2 > this.maximumKeyBytes) return
    this.values.set(key, height)
    this.keyBytes += key.length * 2
    while (
      this.values.size > this.maximumSize ||
      this.keyBytes > this.maximumKeyBytes
    ) {
      const oldest = this.values.keys().next().value
      if (oldest == null) break
      this.values.delete(oldest)
      this.keyBytes -= oldest.length * 2
    }
  }

  invalidate() {
    this.values.clear()
    this.keyBytes = 0
  }
}
