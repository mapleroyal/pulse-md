const bytesPerCodeUnit = 2
const retainedNodeOverheadBytes = 128
const retainedAttributeOverheadBytes = 64

export interface CachedFragmentRender {
  readonly fragment: DocumentFragment
  readonly retainedBytes: number
}

function characterDataBytes(node: Node) {
  const data = (node as CharacterData).data
  return typeof data === "string" ? data.length * bytesPerCodeUnit : 0
}

/**
 * A conservative retained-size estimate for a detached DOM tree. Browser DOM
 * allocations are opaque, so account for every node/attribute plus the UTF-16
 * payloads the cache definitely keeps alive. The estimate is stable and
 * intentionally favors eviction over pretending every entry costs one slot.
 */
export function estimatedFragmentRetainedBytes(
  key: string,
  fragment: DocumentFragment
) {
  let bytes = key.length * bytesPerCodeUnit + retainedNodeOverheadBytes
  const pending = Array.from(fragment.childNodes)
  while (pending.length > 0) {
    const node = pending.pop()!
    bytes += retainedNodeOverheadBytes
    if (node.nodeType === 1) {
      const element = node as Element
      bytes += element.tagName.length * bytesPerCodeUnit
      for (let index = 0; index < element.attributes.length; index += 1) {
        const attribute = element.attributes.item(index)
        if (!attribute) continue
        bytes +=
          retainedAttributeOverheadBytes +
          (attribute.name.length + attribute.value.length) * bytesPerCodeUnit
      }
    } else if (
      node.nodeType === 3 ||
      node.nodeType === 4 ||
      node.nodeType === 8
    ) {
      bytes += characterDataBytes(node)
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      pending.push(child)
    }
  }
  return bytes
}

/** A cloned-fragment LRU bounded by both entry count and retained memory. */
export class MemoryWeightedFragmentCache {
  readonly #entries = new Map<string, CachedFragmentRender>()
  #retainedBytes = 0
  readonly maximumEntries: number
  readonly maximumRetainedBytes: number

  constructor(maximumEntries: number, maximumRetainedBytes: number) {
    if (maximumEntries < 1 || maximumRetainedBytes < 1) {
      throw new RangeError("Fragment cache limits must be positive")
    }
    this.maximumEntries = maximumEntries
    this.maximumRetainedBytes = maximumRetainedBytes
  }

  get size() {
    return this.#entries.size
  }

  get retainedBytes() {
    return this.#retainedBytes
  }

  get(key: string) {
    const cached = this.#entries.get(key)
    if (!cached) return null
    this.#entries.delete(key)
    this.#entries.set(key, cached)
    return cached
  }

  set(key: string, fragment: DocumentFragment) {
    const existing = this.#entries.get(key)
    if (existing) {
      this.#entries.delete(key)
      this.#retainedBytes -= existing.retainedBytes
    }

    const retainedBytes = estimatedFragmentRetainedBytes(key, fragment)
    if (retainedBytes > this.maximumRetainedBytes) return null
    const entry: CachedFragmentRender = {
      fragment: fragment.cloneNode(true) as DocumentFragment,
      retainedBytes,
    }
    this.#entries.set(key, entry)
    this.#retainedBytes += retainedBytes

    while (
      this.#entries.size > this.maximumEntries ||
      this.#retainedBytes > this.maximumRetainedBytes
    ) {
      const oldestKey = this.#entries.keys().next().value
      if (oldestKey == null) break
      const oldest = this.#entries.get(oldestKey)
      if (oldest) this.#retainedBytes -= oldest.retainedBytes
      this.#entries.delete(oldestKey)
    }
    return entry
  }
}
