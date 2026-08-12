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
  private readonly values = new Map<string, number>()

  constructor(maximumSize: number) {
    this.maximumSize = maximumSize
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
    this.values.delete(key)
    this.values.set(key, height)
    while (this.values.size > this.maximumSize) {
      const oldest = this.values.keys().next().value
      if (oldest == null) break
      this.values.delete(oldest)
    }
  }

  invalidate() {
    this.values.clear()
  }
}
