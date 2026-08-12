import { CompletionContext } from "@codemirror/autocomplete"
import { markdown } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import { describe, expect, it, vi } from "vitest"

import {
  decodedPathQuery,
  encodedPathSegment,
  pathCompletionSource,
  pathCompletionTarget,
} from "./path-completion"

describe("path completion target", () => {
  it("recognizes unfinished inline link and image destinations", () => {
    expect(pathCompletionTarget("Read [notes](./docs/cha")).toEqual({
      from: 20,
      query: "./docs/cha",
      separator: "/",
      style: "markdown",
    })
    expect(pathCompletionTarget("![cover](<art work/cov")).toEqual({
      from: 19,
      query: "art work/cov",
      separator: "/",
      style: "markdown-angle",
    })
    expect(pathCompletionTarget("[chapter](./docs(old)/cha")).toEqual({
      from: 22,
      query: "./docs(old)/cha",
      separator: "/",
      style: "markdown",
    })
  })

  it("recognizes obvious paths without activating for prose", () => {
    expect(pathCompletionTarget("Open ../drafts/aug")).toEqual({
      from: 15,
      query: "../drafts/aug",
      separator: "/",
      style: "plain",
    })
    expect(pathCompletionTarget("Just ordinary words")).toBeNull()
    expect(pathCompletionTarget("Just ord", undefined, true)).toEqual({
      from: 5,
      query: "ord",
      separator: "/",
      style: "plain",
    })
  })

  it("rejects remote URLs and completed destinations", () => {
    expect(pathCompletionTarget("[site](https://exa")).toBeNull()
    expect(pathCompletionTarget("[done](./notes.md) ")).toBeNull()
    expect(
      pathCompletionTarget("[typed link](https://)", "[typed link".length)
    ).toBeNull()
  })
})

describe("path completion encoding", () => {
  it("decodes filesystem queries and safely encodes Markdown segments", () => {
    expect(decodedPathQuery("./My%20Docs/", "markdown")).toBe("./My Docs/")
    expect(decodedPathQuery("./My\\ Docs/", "markdown")).toBe("./My Docs/")
    expect(encodedPathSegment("My Notes #1.md", "markdown")).toBe(
      "My%20Notes%20%231.md"
    )
    expect(encodedPathSegment("draft (final).md", "markdown")).toBe(
      "draft%20%28final%29.md"
    )
    expect(encodedPathSegment("My Notes #1.md", "markdown-angle")).toBe(
      "My Notes %231.md"
    )
  })
})

describe("path completion source", () => {
  it("asks for the full path and replaces only the final segment", async () => {
    const completePath = vi.fn().mockResolvedValue([
      { kind: "directory", name: "chapters" },
      { kind: "file", name: "chart.md" },
    ])
    const state = EditorState.create({
      doc: "[notes](./docs/cha",
      extensions: [markdown()],
    })
    const result = await pathCompletionSource(completePath)(
      new CompletionContext(state, state.doc.length, false)
    )

    expect(completePath).toHaveBeenCalledWith("./docs/cha")
    expect(result).toMatchObject({ from: 15, filter: false })
    expect(result?.options).toEqual([
      {
        apply: "chapters/",
        label: "chapters",
        type: "folder",
      },
      {
        apply: "chart.md",
        label: "chart.md",
        type: "file",
      },
    ])
  })

  it("completes a destination after balanced inner parentheses", async () => {
    const completePath = vi
      .fn()
      .mockResolvedValue([{ kind: "file", name: "chapter.md" }])
    const doc = "[chapter](./docs(old)/cha"
    const state = EditorState.create({ doc, extensions: [markdown()] })
    const result = await pathCompletionSource(completePath)(
      new CompletionContext(state, doc.length, false)
    )

    expect(completePath).toHaveBeenCalledWith("./docs(old)/cha")
    expect(result).toMatchObject({ from: 22, filter: false })
  })

  it("keeps angle-bracketed reference destinations completable", async () => {
    const completePath = vi
      .fn()
      .mockResolvedValue([{ kind: "file", name: "cover.png" }])
    const doc = "[target]: <art work/cov"
    const state = EditorState.create({ doc, extensions: [markdown()] })
    const result = await pathCompletionSource(completePath)(
      new CompletionContext(state, doc.length, false)
    )

    expect(completePath).toHaveBeenCalledWith("art work/cov")
    expect(result).toMatchObject({ from: 20, filter: false })
  })

  it("rejects literal, escaped, and code-bound destination tokens", async () => {
    const completePath = vi
      .fn()
      .mockResolvedValue([{ kind: "file", name: "chapter.md" }])
    const examples = [
      {
        cursor: "plain ](./docs/cha".length,
        doc: "plain ](./docs/cha",
      },
      {
        cursor: String.raw`[notes\](./docs/cha`.length,
        doc: String.raw`[notes\](./docs/cha`,
      },
      {
        cursor: String.raw`\[notes](./docs/cha`.length,
        doc: String.raw`\[notes](./docs/cha`,
      },
      {
        cursor: "`[notes](./docs/cha".length,
        doc: "`[notes](./docs/cha`",
      },
      {
        cursor: "```md\n[notes](./docs/cha".length,
        doc: "```md\n[notes](./docs/cha\n```",
      },
      {
        cursor: "    [notes](./docs/cha".length,
        doc: "    [notes](./docs/cha",
      },
    ]

    for (const { cursor, doc } of examples) {
      const state = EditorState.create({ doc, extensions: [markdown()] })
      const result = await pathCompletionSource(completePath)(
        new CompletionContext(state, cursor, false)
      )
      expect(result).toBeNull()
    }
    expect(completePath).not.toHaveBeenCalled()
  })
})
