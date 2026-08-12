import { describe, expect, it } from "vitest"
import domino from "@mixmark-io/domino"

import {
  renderedDomContainsBlock,
  renderedDomToMarkdown,
} from "./rendered-markdown-converter"

function renderedRoot(source: string) {
  const document = domino.createDocument(
    `<pulse-md-paste>${source}</pulse-md-paste>`
  )
  const root = document.querySelector("pulse-md-paste")
  if (!root) throw new Error("Unable to create rendered HTML fixture")
  return root as HTMLElement
}

function renderedHtml(source: string) {
  return renderedDomToMarkdown(renderedRoot(source))
}

describe("rendered HTML to Markdown", () => {
  it("converts the CommonMark structures produced by rendered documents", () => {
    const converted = renderedHtml(`
      <h1>Release notes</h1>
      <p>A <strong>bold</strong>, <em>careful</em> <a href="https://example.com/docs">link</a>.</p>
      <blockquote><p>Quoted text</p></blockquote>
      <ul><li>first</li><li>second</li></ul>
      <ol start="3"><li>third</li></ol>
      <hr>
      <pre><code class="language-ts">const fence = \`\`\`</code></pre>
    `)

    expect(converted).toContain("# Release notes")
    expect(converted).toContain(
      "A **bold**, *careful* [link](https://example.com/docs)."
    )
    expect(converted).toContain("> Quoted text")
    expect(converted).toContain("-   first\n-   second")
    expect(converted).toContain("3.  third")
    expect(converted).toContain("---")
    expect(converted).toContain("````ts\nconst fence = ```\n````")
  })

  it("preserves GFM tables, tasks, and double-tilde strikethrough", () => {
    const converted = renderedHtml(`
      <table>
        <thead><tr><th>Name</th><th>Done</th></tr></thead>
        <tbody><tr><td>Draft</td><td>Yes</td></tr></tbody>
      </table>
      <ul><li><input type="checkbox" checked> shipped</li></ul>
      <p><del>old</del> <span style="font-weight: 700; font-style: italic">new</span></p>
    `)

    expect(converted).toContain("| Name | Done |")
    expect(converted).toContain("| --- | --- |")
    expect(converted).toContain("| Draft | Yes |")
    expect(converted).toContain("-   [x]  shipped")
    expect(converted).toContain("~~old~~ ***new***")
  })

  it("converts headerless tables instead of retaining clipboard HTML", () => {
    expect(
      renderedHtml(
        "<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>"
      )
    ).toBe("|     |     |\n| --- | --- |\n| A   | B   |")
  })

  it("does not duplicate semantic formatting around styled spans", () => {
    expect(
      renderedHtml(
        '<strong><span style="font-weight:700">bold</span></strong> <em><span style="font-style:italic">italic</span></em>'
      )
    ).toBe("**bold** *italic*")
  })

  it("honors Google Docs style resets around explicitly formatted spans", () => {
    expect(
      renderedHtml(
        '<b id="docs-internal-guid" style="font-weight:normal"><p><span style="font-weight:700">Bold</span> normal <span style="font-style:italic">italic</span></p></b>'
      )
    ).toBe("**Bold** normal *italic*")
  })

  it("keeps entity-encoded literal tags visible instead of producing raw HTML", () => {
    expect(
      renderedHtml(
        "<p>&lt;em&gt;literal&lt;/em&gt; and &lt;script&gt;visible text&lt;/script&gt; plus &lt;!--visible comment--&gt; and &lt;!DOCTYPE html&gt;</p><p><code>&lt;b&gt;code&lt;/b&gt;</code></p>"
      )
    ).toBe(
      "\\<em>literal\\</em> and \\<script>visible text\\</script> plus \\<!--visible comment--> and \\<!DOCTYPE html>\n\n`<b>code</b>`"
    )
  })

  it("does not rewrite ordinary text that resembles internal markers", () => {
    expect(
      renderedHtml(
        '<p>PULSEMDLITERALTAG PULSEMDRESETSPACE PULSEMDRESETBOLD</p><p><strong>bold <span style="font-weight:normal">normal</span> bold</strong></p>'
      )
    ).toBe(
      "PULSEMDLITERALTAG PULSEMDRESETSPACE PULSEMDRESETBOLD\n\n**bold** normal **bold**"
    )
  })

  it("escapes literal tags assembled across inline DOM nodes", () => {
    expect(
      renderedHtml(
        "<p>&lt;<span>em</span>&gt;literal&lt;/<span>em</span>&gt;</p>"
      )
    ).toBe("\\<em\\>literal\\</em\\>")
  })

  it("keeps conversion placeholders distinct from clipboard attributes", () => {
    const converted = renderedHtml(`
      <p><a href="https://example.com/PULSEMDLITERALTAG">Link</a>
      <img alt="PULSEMDTABLE0" src="https://example.com/PULSEMDTABLE0.png"></p>
      <table><caption>&lt;em&gt;Caption&lt;/em&gt;</caption><tbody><tr><td>A</td><td>B</td></tr></tbody></table>
    `)

    expect(converted).toContain("[Link](https://example.com/PULSEMDLITERALTAG)")
    expect(converted).toContain(
      "![PULSEMDTABLE0](https://example.com/PULSEMDTABLE0.png)"
    )
    expect(converted).toContain("\\<em>Caption\\</em>\n\nA | B")
  })

  it("preserves nested inline-format resets from rich document editors", () => {
    expect(
      renderedHtml(
        '<p><strong>bold <span style="font-weight:normal">normal <span style="font-style:italic">italic</span></span> bold</strong></p><p><em>italic <span style="font-style:normal">normal</span> italic</em></p>'
      )
    ).toBe("**bold** normal *italic* **bold**\n\n*italic* normal *italic*")
  })

  it("keeps inline-format resets distinct across hard line breaks", () => {
    expect(
      renderedHtml(
        '<p><strong>A<br><span style="font-weight:normal">B</span><br>C</strong></p><p><em>X<br><span style="font-style:normal">Y</span><br>Z</em></p>'
      )
    ).toBe("**A**  \nB  \n**C**\n\n*X*  \nY  \n*Z*")
  })

  it("normalizes semantic wrappers that span block-level reset children", () => {
    expect(
      renderedHtml(
        '<strong><p>A</p><p style="font-weight:normal">B</p><p>C</p></strong><strong><em><p>D</p><p style="font-weight:normal;font-style:normal">E</p><p>F</p></em></strong>'
      )
    ).toBe("**A**\n\nB\n\n**C**\n\n***D***\n\nE\n\n***F***")
  })

  it("keeps block-container structure valid under semantic wrappers", () => {
    expect(
      renderedHtml(
        '<strong>Lead<p>Block</p>Tail</strong><strong><ul><li>A</li><li style="font-weight:normal">B</li></ul></strong><strong><blockquote><p>Quote</p></blockquote></strong><strong><table><tr><td>A</td><td>B</td></tr></table></strong>'
      )
    ).toBe(
      "**Lead**\n\n**Block**\n\n**Tail**\n\n-   **A**\n-   B\n\n> **Quote**\n\n|     |     |\n| --- | --- |\n| **A** | **B** |"
    )
  })

  it("composes inline resets with semantic wrappers and links", () => {
    expect(
      renderedHtml(
        '<p><strong>bold <em style="font-weight:normal">normal italic</em> bold</strong></p><p><strong><a href="https://example.com">bold <span style="font-weight:normal">normal</span> bold</a></strong></p>'
      )
    ).toBe(
      "**bold** *normal italic* **bold**\n\n**[bold](https://example.com)** [normal](https://example.com) **[bold](https://example.com)**"
    )
  })

  it("degrades tables with Markdown-inexpressible structure to readable rows", () => {
    expect(
      renderedHtml(`
        <table>
          <caption>Quarterly report</caption>
          <thead>
            <tr><th colspan="2">Sales</th></tr>
            <tr><th>Region</th><th>Total</th></tr>
          </thead>
          <tbody>
            <tr><td rowspan="2">North</td><td>$20</td></tr>
            <tr><td>$30</td></tr>
          </tbody>
        </table>
      `)
    ).toBe(
      "Quarterly report\n\nSales |  \nRegion | Total\nNorth | $20\n  | $30"
    )
  })

  it("degrades colspan-only tables without manufacturing a GFM header", () => {
    expect(
      renderedHtml(
        '<table><tbody><tr><td colspan="2">Wide</td></tr><tr><td>Left</td><td>Right</td></tr></tbody></table>'
      )
    ).toBe("Wide |  \nLeft | Right")
  })

  it("preserves every consecutive pipe in degraded table cells", () => {
    expect(
      renderedHtml(
        "<table><caption>X</caption><tr><td>A ||| B</td></tr></table>"
      )
    ).toBe("X\n\nA \\|\\|\\| B")
  })

  it("degrades repeated header rows outside a thead", () => {
    expect(
      renderedHtml(
        "<table><tbody><tr><th>A</th><th>B</th></tr><tr><th>C</th><th>D</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>"
      )
    ).toBe("A | B\nC | D\n1 | 2")
  })

  it("retains readable content from a nested table during degradation", () => {
    expect(
      renderedHtml(`
        <table>
          <caption>Outer</caption>
          <tbody><tr>
            <td>Before<table><tbody><tr><td>Nested A</td><td>Nested B</td></tr><tr><td>Nested C</td><td>Nested D</td></tr></tbody></table>After</td>
            <td>Right</td>
          </tr></tbody>
        </table>
      `)
    ).toBe(
      "Outer\n\nBefore<br>Nested A \\| Nested B<br>Nested C \\| Nested D<br>After | Right"
    )
  })

  it("degrades an otherwise simple outer table containing a nested table", () => {
    expect(
      renderedHtml(
        "<table><tr><th>Left</th><th>Right</th></tr><tr><td>Before<table><caption>Inner</caption><tr><td>A</td><td>B</td></tr></table>After</td><td>Z</td></tr></table>"
      )
    ).toBe("Left | Right\nBefore<br>Inner<br>A \\| B<br>After | Z")
  })

  it("preserves authored text resembling nested-line separators", () => {
    expect(
      renderedHtml(
        "<table><caption>Outer</caption><tr><td>Before\uE000<table><tr><td>A</td></tr></table>After\uE000</td></tr></table>"
      )
    ).toBe("Outer\n\nBefore\uE000<br>A<br>After\uE000")
  })

  it("preserves escaped literal tags while flattening a nested table", () => {
    expect(
      renderedHtml(
        "<table><caption>Outer</caption><tr><td>Before<table><caption>&lt;i&gt;Inner&lt;/i&gt;</caption><tr><td><strong>Bold</strong> &lt;em&gt;lit&lt;/em&gt;</td></tr></table>After</td></tr></table>"
      )
    ).toBe(
      "Outer\n\nBefore<br>\\<i>Inner\\</i><br>Bold \\<em>lit\\</em><br>After"
    )
  })

  it("separates deeper nested tables and disclosures into readable lines", () => {
    expect(
      renderedHtml(
        "<table><caption>Outer</caption><tr><td>X<table><caption>Inner</caption><tr><td>I<table><caption>Deep</caption><tr><td>One</td><td>Two</td></tr></table>Y</td></tr></table>Z<details><summary>Sum</summary>Body</details></td></tr></table>"
      )
    ).toBe(
      "Outer\n\nX<br>Inner<br>I<br>Deep<br>One \\| Two<br>Y<br>Z<br>Sum<br>Body"
    )
  })

  it("converts a large complex table in bounded time", () => {
    const rows = Array.from(
      { length: 1_000 },
      (_, index) => `<tr><td>${index}</td><td>value</td></tr>`
    ).join("")
    const started = performance.now()
    const converted = renderedHtml(
      `<table><caption>Large</caption><tbody>${rows}</tbody></table>`
    )
    expect(performance.now() - started).toBeLessThan(1_500)
    expect(converted).toContain("Large\n\n0 | value")
    expect(converted).toContain("999 | value")
  })

  it("separates disclosure summaries from their rendered bodies", () => {
    expect(
      renderedHtml(
        "<details><summary>More information</summary><p>First paragraph.</p><ul><li>One</li><li>Two</li></ul></details>"
      )
    ).toBe("**More information**\n\nFirst paragraph.\n\n-   One\n-   Two")
  })

  it("keeps literal tags visible in disclosures flattened inside tables", () => {
    expect(
      renderedHtml(
        "<table><caption>Outer</caption><tr><td><details><summary>&lt;em&gt;Sum&lt;/em&gt;</summary>&lt;b&gt;Body&lt;/b&gt;</details></td></tr></table>"
      )
    ).toBe("Outer\n\n\\<em>Sum\\</em><br>\\<b>Body\\</b>")
  })

  it("classifies disclosures as block content for contextual paste", () => {
    expect(
      renderedDomContainsBlock(
        renderedRoot("<details><summary>Sum</summary>inline body</details>")
      )
    ).toBe(true)
    expect(renderedDomContainsBlock(renderedRoot("<span>inline</span>"))).toBe(
      false
    )
  })

  it("does not create invalid delimiters around formatted summaries", () => {
    expect(
      renderedHtml(
        "<details><summary><strong>Bold</strong> title</summary><p>Body</p></details>"
      )
    ).toBe("**Bold** title\n\nBody")
  })

  it("handles a bounded code block with many separate backtick runs", () => {
    const source = "` x".repeat(100_000)
    expect(renderedHtml(`<pre><code>${source}</code></pre>`)).toContain(
      `\n${source}\n`
    )
  })

  it("discards executable and document metadata instead of pasting it", () => {
    expect(
      renderedHtml(
        "<style>.secret { color: red }</style><script>alert(1)</script><p>Visible</p>"
      )
    ).toBe("Visible")
  })
})
