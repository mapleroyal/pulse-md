import { describe, expect, it } from "vitest"

import {
  estimatedFragmentRetainedBytes,
  MemoryWeightedFragmentCache,
} from "./fragment-render-cache"

interface FakeNode {
  attributes?: {
    readonly length: number
    item(index: number): { name: string; value: string } | null
  }
  childNodes: FakeNode[]
  cloneNode?(deep?: boolean): unknown
  data?: string
  firstChild: FakeNode | null
  nextSibling: FakeNode | null
  nodeType: number
  tagName?: string
}

function connectChildren(children: FakeNode[]) {
  for (let index = 0; index < children.length; index += 1) {
    children[index]!.nextSibling = children[index + 1] ?? null
  }
  return children[0] ?? null
}

function textNode(data: string): FakeNode {
  return {
    childNodes: [],
    data,
    firstChild: null,
    nextSibling: null,
    nodeType: 3,
  }
}

function elementNode(
  tagName: string,
  attributes: ReadonlyArray<{ name: string; value: string }>,
  children: FakeNode[] = []
): FakeNode {
  return {
    attributes: {
      length: attributes.length,
      item: (index) => attributes[index] ?? null,
    },
    childNodes: children,
    firstChild: connectChildren(children),
    nextSibling: null,
    nodeType: 1,
    tagName,
  }
}

function fragment(...children: FakeNode[]) {
  const value: FakeNode = {
    childNodes: children,
    cloneNode: () => fragment(...children),
    firstChild: connectChildren(children),
    nextSibling: null,
    nodeType: 11,
  }
  return value as unknown as DocumentFragment
}

describe("memory-weighted fragment cache", () => {
  it("accounts for text and attribute payloads", () => {
    const small = fragment(elementNode("svg", [], [textNode("x")]))
    const large = fragment(
      elementNode(
        "svg",
        [{ name: "d", value: "x".repeat(4_096) }],
        [textNode("y".repeat(4_096))]
      )
    )

    expect(estimatedFragmentRetainedBytes("key", large)).toBeGreaterThan(
      estimatedFragmentRetainedBytes("key", small) + 16_000
    )
  })

  it("evicts least-recently-used entries at the count limit", () => {
    const cache = new MemoryWeightedFragmentCache(2, 1_000_000)
    cache.set("a", fragment(textNode("a")))
    cache.set("b", fragment(textNode("b")))
    expect(cache.get("a")).not.toBeNull()

    cache.set("c", fragment(textNode("c")))

    expect(cache.get("b")).toBeNull()
    expect(cache.get("a")).not.toBeNull()
    expect(cache.get("c")).not.toBeNull()
  })

  it("evicts by retained bytes and skips a single oversized fragment", () => {
    const candidate = fragment(textNode("payload"))
    const entryBytes = estimatedFragmentRetainedBytes("a", candidate)
    const cache = new MemoryWeightedFragmentCache(10, entryBytes * 2 - 1)
    cache.set("a", candidate)
    cache.set("b", candidate)

    expect(cache.size).toBe(1)
    expect(cache.retainedBytes).toBeLessThanOrEqual(entryBytes * 2 - 1)
    expect(cache.get("a")).toBeNull()
    expect(cache.get("b")).not.toBeNull()

    const oversized = new MemoryWeightedFragmentCache(10, entryBytes - 1)
    expect(oversized.set("a", candidate)).toBeNull()
    expect(oversized.size).toBe(0)
    expect(oversized.retainedBytes).toBe(0)
  })
})
