import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  MAX_SCRATCH_UTF8_STREAM_CHUNK_BYTES,
  SCRATCH_BATCH_JOURNAL_FILE_NAME,
  SCRATCH_CATALOG_FILE_NAME,
  ScratchStore,
  defaultScratchFileName,
  normalizeScratchFileName,
  summarizeScratchMarkdown,
} from "./scratch-store"

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
]
const now = new Date(2026, 7, 8, 14, 5, 9)

interface TestCatalogEntry {
  readonly fileName: string
  readonly id: string
  readonly [key: string]: unknown
}

interface TestCatalog {
  readonly entries: readonly TestCatalogEntry[]
  readonly version: 1
}

async function testCatalog(store: ScratchStore): Promise<TestCatalog> {
  return JSON.parse(await readFile(store.catalogPath, "utf8")) as TestCatalog
}

function testBatchArtifact(
  transactionId: string,
  id: string,
  kind: "backup" | "stage"
): string {
  return `.scratch-batch-${transactionId}.${id}.${kind}`
}

function testBatchJournal(
  originalCatalog: TestCatalog,
  finalCatalog: TestCatalog,
  affectedIds: readonly string[],
  transactionId: string,
  phase:
    | "preparing"
    | "prepared"
    | "backups-complete"
    | "installed"
    | "rolling-back-prepared"
    | "rolling-back-installed"
    | "rolled-back"
    | "committed"
): Record<string, unknown> {
  const originalById = new Map(
    originalCatalog.entries.map((entry) => [entry.id, entry])
  )
  const finalById = new Map(
    finalCatalog.entries.map((entry) => [entry.id, entry])
  )
  return {
    files: affectedIds.map((id) => {
      const originalFileName = originalById.get(id)?.fileName ?? null
      const destinationFileName = finalById.get(id)?.fileName ?? null
      return {
        backupFileName:
          originalFileName === null
            ? null
            : testBatchArtifact(transactionId, id, "backup"),
        destinationFileName,
        id,
        originalFileName,
        stageFileName:
          destinationFileName === null
            ? null
            : testBatchArtifact(transactionId, id, "stage"),
      }
    }),
    finalCatalog,
    originalCatalog,
    phase,
    transactionId,
    version: 1,
  }
}

async function writeTestBatchJournal(
  store: ScratchStore,
  journal: Record<string, unknown>
): Promise<void> {
  await writeFile(
    path.join(store.directory, SCRATCH_BATCH_JOURNAL_FILE_NAME),
    `${JSON.stringify(journal)}\n`
  )
}

describe("ScratchStore", () => {
  let rootDirectory: string
  let nextId: number
  let store: ScratchStore

  beforeEach(async () => {
    rootDirectory = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "pulse-md-scratch-store-"))
    )
    nextId = 0
    store = new ScratchStore(rootDirectory, {
      clock: () => new Date(now),
      generateId: () => ids[nextId++]!,
    })
  })

  afterEach(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(rootDirectory, { force: true, recursive: true })
    )
  })

  it("normalizes portable markdown filenames and makes timestamp defaults", () => {
    expect(normalizeScratchFileName("Cafe\u0301 Notes")).toBe("Café Notes.md")
    expect(normalizeScratchFileName("notes.MD")).toBe("notes.md")
    expect(defaultScratchFileName(now)).toBe("scratch-2026-08-08-140509.md")

    for (const invalid of [
      "../notes",
      "folder/notes",
      "notes\\child",
      "con",
      "NUL.archive",
      "notes .md",
      "bad\0name",
      ".md",
      `${"a".repeat(253)}.md`,
    ]) {
      expect(() => normalizeScratchFileName(invalid), invalid).toThrow()
    }
  })

  it("creates flat raw markdown files and preserves exact bytes", async () => {
    const content = Buffer.from([0, 0xff, 0x61, 0x0d, 0x0a])
    const entry = await store.create({ content, fileName: "Exact bytes" })

    expect(entry).toEqual({
      createdAt: now.getTime(),
      fileName: "Exact bytes.md",
      id: ids[0],
      lastOpenedAt: now.getTime(),
    })
    expect(await store.read(entry.id)).toEqual(content)
    expect(await readFile(path.join(store.directory, entry.fileName))).toEqual(
      content
    )
    expect((await readdir(store.directory)).sort()).toEqual([
      SCRATCH_CATALOG_FILE_NAME,
      "Exact bytes.md",
    ])

    await store.replace(entry.id, Buffer.from([0xfe, 0, 0xfd]))
    expect(await store.read(entry.id)).toEqual(Buffer.from([0xfe, 0, 0xfd]))
  })

  it("streams bounded UTF-8-safe chunks without dropping a leading BOM", async () => {
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        `${"a".repeat(MAX_SCRATCH_UTF8_STREAM_CHUNK_BYTES - 8)}😀 café\n`,
        "utf8"
      ),
    ])
    const entry = await store.create({ content, fileName: "streamed" })
    const chunks: string[] = []
    for await (const chunk of store.streamUtf8(entry.id)) chunks.push(chunk)

    expect(chunks.length).toBeGreaterThan(1)
    expect(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(chunk, "utf8") <=
          MAX_SCRATCH_UTF8_STREAM_CHUNK_BYTES
      )
    ).toBe(true)
    expect(Buffer.from(chunks.join(""), "utf8")).toEqual(content)
  })

  it("rejects invalid UTF-8 before yielding stdout content", async () => {
    const entry = await store.create({
      content: Buffer.from([0x61, 0x62, 0x80]),
      fileName: "invalid utf8",
    })
    const chunks: string[] = []
    await expect(
      (async () => {
        for await (const chunk of store.streamUtf8(entry.id)) chunks.push(chunk)
      })()
    ).rejects.toThrow("requires valid UTF-8")
    expect(chunks).toEqual([])
  })

  it("keeps ids stable across metadata and filename changes", async () => {
    const first = await store.create({ fileName: "Notes", title: "First" })
    const second = await store.create({ fileName: "notes" })
    expect(second.fileName).toBe("notes-2.md")

    const updated = await store.update(first.id, {
      fileName: "Journal.MD",
      title: "  Daily Journal  ",
    })
    expect(updated).toMatchObject({
      fileName: "Journal.md",
      id: first.id,
      title: "Daily Journal",
    })
    await expect(
      stat(path.join(store.directory, "Notes.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await store.pathFor(first.id)).toBe(
      path.join(store.directory, "Journal.md")
    )
    await expect(
      store.update(second.id, { fileName: "JOURNAL.md" })
    ).rejects.toThrow("filename already exists")
    expect(
      (await store.update(first.id, { title: null })).title
    ).toBeUndefined()
  })

  it("keeps scratch copy destinations outside managed storage", async () => {
    await store.create({ fileName: "private" })
    await expect(
      store.canonicalizeExportPath(path.join(store.directory, "copy.md"))
    ).rejects.toThrow("inside the app's scratch storage")

    const alias = path.join(rootDirectory, "scratch-alias")
    await symlink(
      store.directory,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(
      store.canonicalizeExportPath(path.join(alias, "copy.md"))
    ).rejects.toThrow("resolve inside the app's scratch storage")

    const destination = path.join(rootDirectory, "exports", "copy.md")
    const expectedDestination = path.join(
      await realpath(rootDirectory),
      "exports",
      "copy.md"
    )
    await expect(store.canonicalizeExportPath(destination, true)).resolves.toBe(
      expectedDestination
    )

    await writeFile(destination, "existing", "utf8")
    const entry = (await store.listCatalog())[0]!
    await expect(store.exportFile(entry.id, destination)).rejects.toThrow(
      "already exists"
    )
    expect(await readFile(destination, "utf8")).toBe("existing")

    const exportedPath = path.join(rootDirectory, "exports", "new-copy.md")
    await expect(store.exportFile(entry.id, exportedPath)).resolves.toBe(
      path.join(await realpath(path.dirname(exportedPath)), "new-copy.md")
    )
    expect(await readFile(exportedPath, "utf8")).toBe("")
  })

  it("finishes an interrupted hard-link rename idempotently", async () => {
    const entry = await store.create({ content: "safe", fileName: "before" })
    const sourcePath = await store.pathFor(entry.id)
    const destinationPath = path.join(store.directory, "after.md")
    await link(sourcePath, destinationPath)

    await expect(
      store.update(entry.id, { fileName: "after.md" })
    ).resolves.toMatchObject({ fileName: "after.md", id: entry.id })
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(destinationPath, "utf8")).toBe("safe")
  })

  it("marks opens without touching content and resolves CLI-friendly names", async () => {
    const entry = await store.create({
      content: "unchanged",
      fileName: "Quick Notes",
      markOpened: false,
    })
    expect(entry.lastOpenedAt).toBeNull()
    const openedAt = new Date("2027-01-02T03:04:05.000Z").getTime()
    await store.markOpened(entry.id, openedAt)
    expect((await store.get(entry.id)).lastOpenedAt).toBe(openedAt)
    expect((await store.findByFileNameOrStem("quick notes"))?.id).toBe(entry.id)
    expect((await store.findByFileNameOrStem("Quick Notes.md"))?.id).toBe(
      entry.id
    )
    expect((await store.findByFileNameOrStem(entry.id))?.id).toBe(entry.id)
    expect(await store.readText(entry.id)).toBe("unchanged")
  })

  it("builds bounded, useful inventory summaries", async () => {
    const entry = await store.create({
      content: [
        "---",
        "category: metadata",
        "---",
        "```md",
        "# Not this heading",
        "```",
        "# **Release** Checklist",
        "A [compact](https://example.com) first line.",
        "Second line with `code`.",
      ].join("\n"),
      fileName: "trainer",
      title: "Training Notes",
    })
    const [inventory] = await store.list()
    expect(inventory).toMatchObject({
      excerpt: "A compact first line. Second line with code.",
      fileName: "trainer.md",
      firstHeading: "Release Checklist",
      id: entry.id,
      title: "Training Notes",
    })
    expect(inventory.byteLength).toBeGreaterThan(0)
    expect(inventory.path).toBe(path.join(store.directory, "trainer.md"))
  })

  it("reuses unchanged inventory summaries and prunes deleted entries", async () => {
    const entry = await store.create({
      content: "# Cached\n\nInventory text.",
      fileName: "cached",
    })
    const cache = (
      store as unknown as {
        inventorySummaryCache: Map<string, unknown>
      }
    ).inventorySummaryCache

    await store.list()
    const firstSummary = cache.get(entry.id)
    expect(firstSummary).toBeDefined()

    await store.list()
    expect(cache.get(entry.id)).toBe(firstSummary)

    await store.replace(entry.id, "# Changed\n\nNew inventory text.")
    await store.list()
    expect(cache.get(entry.id)).not.toBe(firstSummary)

    await store.delete(entry.id)
    await store.list()
    expect(cache.has(entry.id)).toBe(false)
  })

  it("returns complete small previews and UTF-8-safe bounded large prefixes", async () => {
    const smallBytes = Buffer.from("\uFEFFfirst\r\nsecond\r\n", "utf8")
    const small = await store.create({ content: smallBytes, fileName: "small" })
    await expect(store.readPreview(small.id)).resolves.toMatchObject({
      content: smallBytes,
      truncated: false,
    })

    const prefixBytes = 256 * 1024
    const largeBytes = Buffer.concat([
      Buffer.alloc(prefixBytes - 1, 0x61),
      Buffer.from("😀", "utf8"),
      Buffer.alloc(1024 * 1024, 0x62),
    ])
    const large = await store.create({ content: largeBytes, fileName: "large" })
    const preview = await store.readPreview(large.id)

    expect(preview.truncated).toBe(true)
    expect(preview.content).toEqual(Buffer.alloc(prefixBytes - 1, 0x61))
    expect(preview.content.toString("utf8")).not.toContain("�")
  })

  it("deletes and restores byte- and mode-exact snapshots", async () => {
    const entry = await store.create({
      content: "private",
      fileName: "private",
    })
    const filePath = await store.pathFor(entry.id)
    await chmod(filePath, 0o640)

    const snapshot = await store.delete(entry.id)
    await expect(store.get(entry.id)).rejects.toThrow("does not exist")
    await store.restoreSnapshot(snapshot)
    expect(await store.readText(entry.id)).toBe("private")
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o640)
    }
  })

  it("upserts imported snapshots across filename changes", async () => {
    const entry = await store.create({ content: "old", fileName: "old-name" })
    const modifiedAt = 1_700_000_123_000
    const restored = await store.upsertSnapshot({
      content: Buffer.from("imported\r\nbytes", "utf8"),
      entry: {
        ...entry,
        createdAt: 1_600_000_000_000,
        fileName: "portable-name.md",
        lastOpenedAt: null,
        title: "Imported",
      },
      mode: 0o600,
      modifiedAt,
    })

    expect(restored).toMatchObject({
      fileName: "portable-name.md",
      id: entry.id,
      title: "Imported",
    })
    expect(await store.readText(entry.id)).toBe("imported\r\nbytes")
    await expect(
      stat(path.join(store.directory, "old-name.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(await store.pathFor(entry.id))).mtimeMs).toBeCloseTo(
      modifiedAt,
      -2
    )
  })

  it("replaces filename cycles as one batch and rolls the whole batch back", async () => {
    const first = await store.create({ content: "original-a", fileName: "a" })
    const second = await store.create({ content: "original-b", fileName: "b" })
    const third = await store.create({ content: "original-c", fileName: "c" })
    const replacement = await store.upsertSnapshots([
      {
        content: Buffer.from("imported-a"),
        entry: { ...first, fileName: "b.md" },
        mode: 0o600,
        modifiedAt: 100,
      },
      {
        content: Buffer.from("imported-b"),
        entry: { ...second, fileName: "c.md" },
        mode: 0o600,
        modifiedAt: 200,
      },
      {
        content: Buffer.from("imported-c"),
        entry: { ...third, fileName: "a.md" },
        mode: 0o600,
        modifiedAt: 300,
      },
    ])

    expect((await store.get(first.id)).fileName).toBe("b.md")
    expect((await store.get(second.id)).fileName).toBe("c.md")
    expect((await store.get(third.id)).fileName).toBe("a.md")
    expect(await store.read(first.id)).toEqual(Buffer.from("imported-a"))
    expect(await store.read(second.id)).toEqual(Buffer.from("imported-b"))
    expect(await store.read(third.id)).toEqual(Buffer.from("imported-c"))

    await replacement.rollback()
    expect((await store.get(first.id)).fileName).toBe("a.md")
    expect((await store.get(second.id)).fileName).toBe("b.md")
    expect((await store.get(third.id)).fileName).toBe("c.md")
    expect(await store.read(first.id)).toEqual(Buffer.from("original-a"))
    expect(await store.read(second.id)).toEqual(Buffer.from("original-b"))
    expect(await store.read(third.id)).toEqual(Buffer.from("original-c"))
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("restores every original file when batch catalog publication fails", async () => {
    const first = await store.create({ content: "original-a", fileName: "a" })
    const second = await store.create({ content: "original-b", fileName: "b" })
    const writableStore = store as unknown as {
      writeCatalog: (entries: readonly unknown[]) => Promise<void>
    }
    const originalWriteCatalog = writableStore.writeCatalog.bind(store)
    writableStore.writeCatalog = async () => {
      throw new Error("catalog publication failed")
    }

    await expect(
      store.upsertSnapshots([
        {
          content: Buffer.from("imported-a"),
          entry: { ...first, fileName: "b.md" },
          mode: 0o600,
          modifiedAt: 100,
        },
        {
          content: Buffer.from("imported-b"),
          entry: { ...second, fileName: "a.md" },
          mode: 0o600,
          modifiedAt: 200,
        },
      ])
    ).rejects.toThrow("catalog publication failed")
    writableStore.writeCatalog = originalWriteCatalog

    expect((await store.get(first.id)).fileName).toBe("a.md")
    expect((await store.get(second.id)).fileName).toBe("b.md")
    expect(await store.readText(first.id)).toBe("original-a")
    expect(await store.readText(second.id)).toBe("original-b")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("cleans staged files from a transaction interrupted while preparing", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const catalog = await testCatalog(store)
    const transactionId = "30000000-0000-4000-8000-000000000001"
    await writeTestBatchJournal(
      store,
      testBatchJournal(catalog, catalog, [entry.id], transactionId, "preparing")
    )
    await writeFile(
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "stage")
      ),
      "replacement"
    )

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("original")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("removes an unpublished journal write without exposing partial metadata", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const nextJournalPath = path.join(
      store.directory,
      ".scratch-batch-transaction.next"
    )
    await writeFile(nextJournalPath, '{"partial":')

    const recovered = new ScratchStore(rootDirectory)
    expect((await recovered.list()).map(({ id }) => id)).toEqual([entry.id])
    await expect(stat(nextJournalPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("restores a transaction interrupted partway through backing up originals", async () => {
    const first = await store.create({ content: "original-a", fileName: "a" })
    const second = await store.create({ content: "original-b", fileName: "b" })
    const catalog = await testCatalog(store)
    const transactionId = "30000000-0000-4000-8000-000000000002"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        catalog,
        catalog,
        [first.id, second.id],
        transactionId,
        "prepared"
      )
    )
    for (const entry of [first, second]) {
      await writeFile(
        path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "stage")
        ),
        `replacement-${entry.id}`
      )
    }
    await rename(
      path.join(store.directory, first.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, first.id, "backup")
      )
    )

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(first.id)).toBe("original-a")
    expect(await recovered.readText(second.id)).toBe("original-b")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("rolls back a transaction interrupted partway through installing replacements", async () => {
    const first = await store.create({ content: "original-a", fileName: "a" })
    const second = await store.create({ content: "original-b", fileName: "b" })
    const catalog = await testCatalog(store)
    const transactionId = "30000000-0000-4000-8000-000000000003"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        catalog,
        catalog,
        [first.id, second.id],
        transactionId,
        "backups-complete"
      )
    )
    for (const entry of [first, second]) {
      const stagePath = path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "stage")
      )
      await writeFile(stagePath, `replacement-${entry.id}`)
      await rename(
        path.join(store.directory, entry.fileName),
        path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "backup")
        )
      )
    }
    const firstStage = path.join(
      store.directory,
      testBatchArtifact(transactionId, first.id, "stage")
    )
    await link(firstStage, path.join(store.directory, first.fileName))

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(first.id)).toBe("original-a")
    expect(await recovered.readText(second.id)).toBe("original-b")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("rolls back fully installed files when the final catalog was not committed", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const finalCatalog: TestCatalog = {
      entries: originalCatalog.entries.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, fileName: "renamed.md" }
          : candidate
      ),
      version: 1,
    }
    const transactionId = "30000000-0000-4000-8000-000000000004"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        originalCatalog,
        finalCatalog,
        [entry.id],
        transactionId,
        "installed"
      )
    )
    const stagePath = path.join(
      store.directory,
      testBatchArtifact(transactionId, entry.id, "stage")
    )
    await writeFile(stagePath, "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "backup")
      )
    )
    await link(stagePath, path.join(store.directory, "renamed.md"))

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("original")
    expect((await recovered.get(entry.id)).fileName).toBe("old.md")
    await expect(
      stat(path.join(store.directory, "renamed.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([1, 2])(
    "resumes an installed rollback interrupted after restoring %s backups",
    async (restoredCount) => {
      const entries = [
        await store.create({ content: "original-a", fileName: "a" }),
        await store.create({ content: "original-b", fileName: "b" }),
      ]
      const catalog = await testCatalog(store)
      const transactionId = "30000000-0000-4000-8000-000000000010"
      await writeTestBatchJournal(
        store,
        testBatchJournal(
          catalog,
          catalog,
          entries.map(({ id }) => id),
          transactionId,
          "rolling-back-installed"
        )
      )

      for (const [index, entry] of entries.entries()) {
        const stagePath = path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "stage")
        )
        const backupPath = path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "backup")
        )
        const originalPath = path.join(store.directory, entry.fileName)
        await writeFile(stagePath, `replacement-${index}`)
        await rename(originalPath, backupPath)
        await link(stagePath, originalPath)
      }

      for (const entry of entries) {
        await unlink(path.join(store.directory, entry.fileName))
      }
      for (const entry of entries.slice(0, restoredCount)) {
        await link(
          path.join(
            store.directory,
            testBatchArtifact(transactionId, entry.id, "backup")
          ),
          path.join(store.directory, entry.fileName)
        )
      }

      const recovered = new ScratchStore(rootDirectory)
      expect(await recovered.readText(entries[0]!.id)).toBe("original-a")
      expect(await recovered.readText(entries[1]!.id)).toBe("original-b")
      expect(
        (await readdir(store.directory)).filter((name) =>
          name.startsWith(".scratch-batch-")
        )
      ).toEqual([])
    }
  )

  it.each([0, 1, 2, 3, 4])(
    "resumes rolled-back cleanup after removing %s transaction artifacts",
    async (removedArtifactCount) => {
      const entries = [
        await store.create({ content: "original-a", fileName: "a" }),
        await store.create({ content: "original-b", fileName: "b" }),
      ]
      const originalCatalog = await testCatalog(store)
      const finalCatalog: TestCatalog = {
        entries: originalCatalog.entries.map((entry, index) => ({
          ...entry,
          fileName: `replacement-${index}.md`,
        })),
        version: 1,
      }
      const transactionId = "30000000-0000-4000-8000-000000000011"
      await writeTestBatchJournal(
        store,
        testBatchJournal(
          originalCatalog,
          finalCatalog,
          entries.map(({ id }) => id),
          transactionId,
          "rolled-back"
        )
      )

      const cleanupOrder: string[] = []
      for (const [index, entry] of entries.entries()) {
        const stagePath = path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "stage")
        )
        const backupPath = path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "backup")
        )
        const originalPath = path.join(store.directory, entry.fileName)
        await writeFile(stagePath, `replacement-${index}`)
        await rename(originalPath, backupPath)
        await link(backupPath, originalPath)
        cleanupOrder.push(stagePath, backupPath)
      }
      for (const artifactPath of cleanupOrder.slice(0, removedArtifactCount)) {
        await unlink(artifactPath)
      }

      const recovered = new ScratchStore(rootDirectory)
      expect(await recovered.readText(entries[0]!.id)).toBe("original-a")
      expect(await recovered.readText(entries[1]!.id)).toBe("original-b")
      expect(
        (await readdir(store.directory)).filter((name) =>
          name.startsWith(".scratch-batch-")
        )
      ).toEqual([])
    }
  )

  it("finishes committed cleanup despite a stale unpublished journal update", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const finalCatalog: TestCatalog = {
      entries: originalCatalog.entries.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, fileName: "renamed.md" }
          : candidate
      ),
      version: 1,
    }
    const transactionId = "30000000-0000-4000-8000-000000000005"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        originalCatalog,
        finalCatalog,
        [entry.id],
        transactionId,
        "installed"
      )
    )
    const stagePath = path.join(
      store.directory,
      testBatchArtifact(transactionId, entry.id, "stage")
    )
    await writeFile(stagePath, "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "backup")
      )
    )
    await link(stagePath, path.join(store.directory, "renamed.md"))
    await writeFile(store.catalogPath, `${JSON.stringify(finalCatalog)}\n`)
    await writeFile(
      path.join(store.directory, ".scratch-batch-transaction.next"),
      '{"phase":"committed"}'
    )

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("replacement")
    expect((await recovered.get(entry.id)).fileName).toBe("renamed.md")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("does not report a new batch as applied after reconciling an older committed journal", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const committed = await store.upsertSnapshot({
      content: Buffer.from("committed"),
      entry: { ...entry, fileName: "committed.md" },
      mode: 0o600,
      modifiedAt: 100,
    })
    const committedCatalog = await testCatalog(store)
    const retainedTransactionId = "30000000-0000-4000-8000-000000000010"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        originalCatalog,
        committedCatalog,
        [entry.id],
        retainedTransactionId,
        "committed"
      )
    )
    const requested = {
      content: Buffer.from("requested"),
      entry: { ...committed, fileName: "requested.md" },
      mode: 0o600,
      modifiedAt: 200,
    }

    await expect(store.upsertSnapshots([requested])).rejects.toThrow(
      "A scratch batch transaction is already in progress"
    )
    expect((await store.get(entry.id)).fileName).toBe("committed.md")
    expect(await store.readText(entry.id)).toBe("committed")
    await expect(
      stat(path.join(store.directory, SCRATCH_BATCH_JOURNAL_FILE_NAME))
    ).rejects.toMatchObject({ code: "ENOENT" })

    await expect(store.upsertSnapshots([requested])).resolves.toMatchObject({
      entries: [{ fileName: "requested.md", id: entry.id }],
    })
    expect(await store.readText(entry.id)).toBe("requested")
  })

  it("fails closed when a committed destination is missing before cleanup", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const finalCatalog: TestCatalog = {
      entries: originalCatalog.entries.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, fileName: "renamed.md" }
          : candidate
      ),
      version: 1,
    }
    const transactionId = "30000000-0000-4000-8000-000000000007"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        originalCatalog,
        finalCatalog,
        [entry.id],
        transactionId,
        "installed"
      )
    )
    const stagePath = path.join(
      store.directory,
      testBatchArtifact(transactionId, entry.id, "stage")
    )
    const destinationPath = path.join(store.directory, "renamed.md")
    await writeFile(stagePath, "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "backup")
      )
    )
    await link(stagePath, destinationPath)
    await writeFile(store.catalogPath, `${JSON.stringify(finalCatalog)}\n`)
    await unlink(destinationPath)

    const recovered = new ScratchStore(rootDirectory)
    await expect(recovered.list()).rejects.toThrow(
      "destination cannot be verified"
    )
    expect(await readFile(stagePath, "utf8")).toBe("replacement")
    expect(
      await readFile(
        path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "backup")
        ),
        "utf8"
      )
    ).toBe("original")
  })

  it("resumes committed cleanup after the retained stage was removed", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const finalCatalog: TestCatalog = {
      entries: originalCatalog.entries.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, fileName: "renamed.md" }
          : candidate
      ),
      version: 1,
    }
    const transactionId = "30000000-0000-4000-8000-000000000009"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        originalCatalog,
        finalCatalog,
        [entry.id],
        transactionId,
        "committed"
      )
    )
    const stagePath = path.join(
      store.directory,
      testBatchArtifact(transactionId, entry.id, "stage")
    )
    await writeFile(stagePath, "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "backup")
      )
    )
    await link(stagePath, path.join(store.directory, "renamed.md"))
    await unlink(stagePath)
    await writeFile(store.catalogPath, `${JSON.stringify(finalCatalog)}\n`)

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("replacement")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("fails closed without modifying files when the recovery journal is malformed", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const journalPath = path.join(
      store.directory,
      SCRATCH_BATCH_JOURNAL_FILE_NAME
    )
    await writeFile(journalPath, '{"unsupported":true}\n')

    const recovered = new ScratchStore(rootDirectory)
    await expect(recovered.list()).rejects.toThrow(
      "Scratch batch journal contains unsupported property"
    )
    expect(
      await readFile(path.join(store.directory, entry.fileName), "utf8")
    ).toBe("original")
    await expect(stat(journalPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    })
  })

  it("rejects a journal that omits a catalog delta", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const originalCatalog = await testCatalog(store)
    const finalCatalog: TestCatalog = {
      entries: originalCatalog.entries.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, fileName: "renamed.md" }
          : candidate
      ),
      version: 1,
    }
    await writeTestBatchJournal(store, {
      files: [],
      finalCatalog,
      originalCatalog,
      phase: "preparing",
      transactionId: "30000000-0000-4000-8000-000000000008",
      version: 1,
    })

    const recovered = new ScratchStore(rootDirectory)
    await expect(recovered.list()).rejects.toThrow(
      `omits changed scratch ${entry.id}`
    )
    expect(
      await readFile(path.join(store.directory, entry.fileName), "utf8")
    ).toBe("original")
  })

  it("preserves a foreign destination collision and leaves the original recoverable", async () => {
    const entry = await store.create({ content: "original", fileName: "old" })
    const collisionPath = path.join(store.directory, "collision.md")
    const writableStore = store as unknown as {
      writeBatchJournal: (
        journal: { readonly phase: string },
        create: boolean
      ) => Promise<void>
    }
    const originalWriteBatchJournal =
      writableStore.writeBatchJournal.bind(store)
    let collisionCreated = false
    writableStore.writeBatchJournal = async (journal, create) => {
      await originalWriteBatchJournal(journal, create)
      if (journal.phase === "backups-complete" && !collisionCreated) {
        collisionCreated = true
        await writeFile(collisionPath, "foreign")
      }
    }

    await expect(
      store.upsertSnapshots([
        {
          content: Buffer.from("replacement"),
          entry: { ...entry, fileName: "collision.md" },
          mode: 0o600,
          modifiedAt: 100,
        },
      ])
    ).rejects.toThrow("could not fully roll back")
    expect(await readFile(collisionPath, "utf8")).toBe("foreign")
    expect(
      (await readdir(store.directory)).some((name) =>
        name.endsWith(`.${entry.id}.backup`)
      )
    ).toBe(true)

    await unlink(collisionPath)
    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("original")
    expect((await recovered.get(entry.id)).fileName).toBe("old.md")
  })

  it("fails closed when a recovery destination does not match its retained stage", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const catalog = await testCatalog(store)
    const transactionId = "30000000-0000-4000-8000-000000000006"
    await writeTestBatchJournal(
      store,
      testBatchJournal(
        catalog,
        catalog,
        [entry.id],
        transactionId,
        "backups-complete"
      )
    )
    await writeFile(
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "stage")
      ),
      "replacement"
    )
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(
        store.directory,
        testBatchArtifact(transactionId, entry.id, "backup")
      )
    )
    await writeFile(path.join(store.directory, entry.fileName), "foreign")

    const recovered = new ScratchStore(rootDirectory)
    await expect(recovered.list()).rejects.toThrow(
      "does not match its staged replacement"
    )
    expect(
      await readFile(path.join(store.directory, entry.fileName), "utf8")
    ).toBe("foreign")
    expect(
      await readFile(
        path.join(
          store.directory,
          testBatchArtifact(transactionId, entry.id, "backup")
        ),
        "utf8"
      )
    ).toBe("original")
  })

  it("reconciles an interrupted batch before exposing the store", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const transactionId = "20000000-0000-4000-8000-000000000001"
    const catalog = JSON.parse(
      await readFile(store.catalogPath, "utf8")
    ) as unknown
    const stageFileName = `.scratch-batch-${transactionId}.${entry.id}.stage`
    const backupFileName = `.scratch-batch-${transactionId}.${entry.id}.backup`
    const journal = {
      files: [
        {
          backupFileName,
          destinationFileName: entry.fileName,
          id: entry.id,
          originalFileName: entry.fileName,
          stageFileName,
        },
      ],
      finalCatalog: catalog,
      originalCatalog: catalog,
      phase: "backups-complete",
      transactionId,
      version: 1,
    }
    await writeFile(
      path.join(store.directory, SCRATCH_BATCH_JOURNAL_FILE_NAME),
      `${JSON.stringify(journal)}\n`
    )
    await writeFile(path.join(store.directory, stageFileName), "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(store.directory, backupFileName)
    )

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("original")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("finishes cleanup when an installed batch committed before interruption", async () => {
    const entry = await store.create({ content: "original", fileName: "same" })
    const transactionId = "20000000-0000-4000-8000-000000000002"
    const catalog = JSON.parse(
      await readFile(store.catalogPath, "utf8")
    ) as unknown
    const stageFileName = `.scratch-batch-${transactionId}.${entry.id}.stage`
    const backupFileName = `.scratch-batch-${transactionId}.${entry.id}.backup`
    const journal = {
      files: [
        {
          backupFileName,
          destinationFileName: entry.fileName,
          id: entry.id,
          originalFileName: entry.fileName,
          stageFileName,
        },
      ],
      finalCatalog: catalog,
      originalCatalog: catalog,
      phase: "installed",
      transactionId,
      version: 1,
    }
    await writeFile(
      path.join(store.directory, SCRATCH_BATCH_JOURNAL_FILE_NAME),
      `${JSON.stringify(journal)}\n`
    )
    await writeFile(path.join(store.directory, stageFileName), "replacement")
    await rename(
      path.join(store.directory, entry.fileName),
      path.join(store.directory, backupFileName)
    )
    await link(
      path.join(store.directory, stageFileName),
      path.join(store.directory, entry.fileName)
    )

    const recovered = new ScratchStore(rootDirectory)
    expect(await recovered.readText(entry.id)).toBe("replacement")
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith(".scratch-batch-")
      )
    ).toEqual([])
  })

  it("rolls back newly created scratches from a batch replacement", async () => {
    const existing = await store.create({ content: "old", fileName: "old" })
    const replacement = await store.upsertSnapshots([
      {
        content: Buffer.from("updated"),
        entry: { ...existing, fileName: "renamed.md" },
        mode: 0o600,
        modifiedAt: 100,
      },
      {
        content: Buffer.from("created"),
        entry: {
          createdAt: 10,
          fileName: "created.md",
          id: ids[1]!,
          lastOpenedAt: null,
        },
        mode: 0o600,
        modifiedAt: 200,
      },
    ])

    await replacement.rollback()
    expect(await store.readText(existing.id)).toBe("old")
    expect((await store.get(existing.id)).fileName).toBe("old.md")
    await expect(store.get(ids[1]!)).rejects.toThrow("does not exist")
  })

  it("invalidates summaries and revisions across metadata-preserving replacement", async () => {
    const entry = await store.create({ content: "# Old", fileName: "cached" })
    const modifiedAt = 1_700_000_000_000
    const filePath = await store.pathFor(entry.id)
    await utimes(filePath, new Date(modifiedAt), new Date(modifiedAt))
    const [before] = await store.list()

    await store.upsertSnapshot({
      content: Buffer.from("# New"),
      entry,
      mode: 0o600,
      modifiedAt,
    })
    const [after] = await store.list()
    expect(after).toMatchObject({ firstHeading: "New", modifiedAt })
    expect(after!.revision).not.toBe(before!.revision)
  })

  it("streams full-content searches across chunk boundaries and omits unavailable rows", async () => {
    const prefix = "# Searchable\n\n"
    const boundaryPadding = "x".repeat(64 * 1024 - prefix.length - 4)
    const searchable = await store.create({
      content: `${prefix}${boundaryPadding}deep-needle\n`,
      fileName: "searchable",
    })
    const missing = await store.create({
      content: "missing",
      fileName: "missing",
    })
    await unlink(await store.pathFor(missing.id))

    const available = await store.listAvailable(["deep-needle"])
    expect(available.map(({ id }) => id)).toEqual([searchable.id])
    await expect(store.list()).rejects.toThrow("does not exist")
  })

  it("case-folds context-sensitive Unicode across a search chunk boundary", async () => {
    const boundaryPadding = "x".repeat(64 * 1024 - Buffer.byteLength("Ο"))
    const searchable = await store.create({
      content: `${boundaryPadding}ΟΣ`,
      fileName: "unicode",
    })

    const [finalSigma, ordinarySigma] = await Promise.all([
      store.listAvailable(["ος"]),
      store.listAvailable(["οσ"]),
    ])

    expect(finalSigma.map(({ id }) => id)).toEqual([searchable.id])
    expect(ordinarySigma.map(({ id }) => id)).toEqual([searchable.id])
  })

  it("cancels an in-progress streamed search without returning partial rows", async () => {
    await store.create({
      content: "x".repeat(4 * 1024 * 1024),
      fileName: "large",
    })
    let cancellationChecks = 0

    const available = await store.listAvailable(["absent"], {
      cancelled: () => {
        cancellationChecks += 1
        return cancellationChecks > 5
      },
    })

    expect(cancellationChecks).toBeGreaterThan(5)
    expect(available).toEqual([])
  })

  it("serializes concurrent filename allocation", async () => {
    const created = await Promise.all(
      Array.from({ length: 3 }, () => store.create({ fileName: "same" }))
    )
    expect(created.map((entry) => entry.fileName)).toEqual([
      "same.md",
      "same-2.md",
      "same-3.md",
    ])
  })

  it("migrates legacy namespaces idempotently before explicit cleanup", async () => {
    const ownedDirectory = path.join(store.directory, "writing")
    const adHocDirectory = path.join(store.directory, "_ad-hoc")
    await mkdir(ownedDirectory, { recursive: true })
    await mkdir(adHocDirectory, { recursive: true })
    const exactContent = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff])
    await writeFile(path.join(ownedDirectory, "notes.md"), exactContent)
    await writeFile(path.join(adHocDirectory, "ideas.md"), "ideas")

    expect(await store.discoverLegacyScratchIdentities()).toEqual([
      { profileId: null, tabId: "ideas" },
      { profileId: "writing", tabId: "notes" },
    ])
    const requests = [
      { identity: { profileId: "writing", tabId: "notes" } },
      { identity: { profileId: null, tabId: "ideas" } },
      { identity: { profileId: "writing", tabId: "never-saved" } },
    ] as const
    const first = await store.migrateLegacyScratches(requests)
    const second = await store.migrateLegacyScratches(requests)
    expect(second.map((entry) => entry.scratchId)).toEqual(
      first.map((entry) => entry.scratchId)
    )
    expect(await store.read(first[0]!.scratchId)).toEqual(exactContent)
    expect(await store.readText(first[1]!.scratchId)).toBe("ideas")
    expect(await store.readText(first[2]!.scratchId)).toBe("")
    expect((await store.findByFileNameOrStem("ideas"))?.id).toBe(
      first[1]!.scratchId
    )
    expect(await readFile(path.join(ownedDirectory, "notes.md"))).toEqual(
      exactContent
    )

    await store.finalizeLegacyMigration(
      requests.map(({ identity }) => identity)
    )
    expect(await store.readLegacyMigrationCheckpoints()).toEqual([])
    expect(await store.findByFileNameOrStem("notes")).toBeNull()
    expect(
      JSON.parse(
        await readFile(
          path.join(store.directory, SCRATCH_CATALOG_FILE_NAME),
          "utf8"
        )
      )
    ).not.toHaveProperty("entries.0.migratedFrom")
    await expect(
      stat(path.join(ownedDirectory, "notes.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await store.read(first[0]!.scratchId)).toEqual(exactContent)
  })
})

describe("summarizeScratchMarkdown", () => {
  it("recognizes setext headings", () => {
    expect(summarizeScratchMarkdown("Heading\n=======\nBody text")).toEqual({
      excerpt: "Body text",
      firstHeading: "Heading",
    })
  })

  it("uses the first code line for code-only scratches", () => {
    expect(
      summarizeScratchMarkdown(
        "```ts\nconst answer = 42\nconsole.log(answer)\n```"
      )
    ).toEqual({
      excerpt: "const answer = 42",
      firstHeading: null,
    })
  })
})
