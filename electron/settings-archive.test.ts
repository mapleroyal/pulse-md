import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"
import { fromBufferPromise } from "yauzl"
import { ZipFile } from "yazl"

import {
  createSettingsArchive,
  isSettingsArchive,
  MAX_SETTINGS_ARCHIVE_BYTES,
  MAX_SETTINGS_ARCHIVE_COMPRESSION_RATIO,
  MAX_SETTINGS_ARCHIVE_ENTRIES,
  parseSettingsArchive,
  SETTINGS_ARCHIVE_FORMAT,
  SETTINGS_ARCHIVE_VERSION,
} from "./settings-archive"

interface TestZipEntry {
  readonly path: string
  readonly content?: Buffer
  readonly compress?: boolean
  readonly mode?: number
}

const ZIP_DATE = new Date(1980, 0, 1)

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function testZip(entries: readonly TestZipEntry[]): Promise<Buffer> {
  const zipFile = new ZipFile()
  for (const entry of entries) {
    zipFile.addBuffer(entry.content ?? Buffer.alloc(0), entry.path, {
      compress: entry.compress ?? false,
      forceDosTimestamp: true,
      mode: entry.mode ?? 0o100600,
      mtime: ZIP_DATE,
    })
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    zipFile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zipFile.outputStream.once("error", reject)
    zipFile.outputStream.once("end", () => resolve(Buffer.concat(chunks)))
    zipFile.end({ comment: "", forceZip64Format: false })
  })
}

async function zipContents(archive: Buffer): Promise<Map<string, Buffer>> {
  const zipFile = await fromBufferPromise(archive, {
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  const contents = new Map<string, Buffer>()
  for await (const entry of zipFile.eachEntry()) {
    const chunks: Buffer[] = []
    const stream = await zipFile.openReadStreamPromise(entry)
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    contents.set(entry.fileName, Buffer.concat(chunks))
  }
  return contents
}

function minimalManifest(settingsContent: Buffer): Record<string, unknown> {
  return {
    format: SETTINGS_ARCHIVE_FORMAT,
    version: SETTINGS_ARCHIVE_VERSION,
    settings: { path: "settings.json", sha256: sha256(settingsContent) },
    profiles: [],
    scratches: [],
  }
}

async function minimalArchive(
  options: {
    readonly manifest?: Record<string, unknown> | Buffer
    readonly additionalEntries?: readonly TestZipEntry[]
    readonly includeSettings?: boolean
  } = {}
): Promise<Buffer> {
  const settingsContent = json({ lineWrapping: false })
  const manifest = options.manifest ?? minimalManifest(settingsContent)
  return await testZip([
    {
      path: "manifest.json",
      content: Buffer.isBuffer(manifest) ? manifest : json(manifest),
    },
    ...(options.includeSettings === false
      ? []
      : [{ path: "settings.json", content: settingsContent }]),
    ...(options.additionalEntries ?? []),
  ])
}

function centralDirectoryOffsets(archive: Buffer): number[] {
  const offsets: number[] = []
  for (let offset = 0; offset <= archive.byteLength - 4; offset += 1) {
    if (archive.readUInt32LE(offset) === 0x02014b50) offsets.push(offset)
  }
  return offsets
}

describe("settings archives", () => {
  it("round-trips raw scratch bytes and manifest metadata", async () => {
    const scratchContent = Buffer.from(
      "\uFEFF# Notes\r\nCaf\u00e9 and \ud83d\ude80\r\n",
      "utf8"
    )
    const archive = await createSettingsArchive({
      settings: { lineWrapping: false },
      profiles: [
        {
          id: "writing",
          data: { id: "writing", name: "Writing", version: 2 },
        },
      ],
      scratches: [
        {
          id: "019fe216-2b96-7511-8cf4-a35483924181",
          fileName: "Quick Notes.md",
          title: "Quick Notes",
          createdAt: 1_700_000_000_000,
          modifiedAt: 1_700_000_100_000,
          lastOpenedAt: null,
          content: scratchContent,
        },
      ],
    })

    expect(isSettingsArchive(archive)).toBe(true)
    expect(isSettingsArchive(Buffer.from("{}"))).toBe(false)
    const parsed = await parseSettingsArchive(archive)
    expect(parsed.settings).toEqual({ lineWrapping: false })
    expect(parsed.profiles).toEqual([
      {
        id: "writing",
        data: { id: "writing", name: "Writing", version: 2 },
      },
    ])
    expect(parsed.scratches).toHaveLength(1)
    expect(parsed.scratches[0]).toMatchObject({
      id: "019fe216-2b96-7511-8cf4-a35483924181",
      fileName: "Quick Notes.md",
      title: "Quick Notes",
      createdAt: 1_700_000_000_000,
      modifiedAt: 1_700_000_100_000,
      lastOpenedAt: null,
    })
    expect(parsed.scratches[0]!.content.equals(scratchContent)).toBe(true)

    const contents = await zipContents(archive)
    expect([...contents.keys()]).toEqual([
      "manifest.json",
      "settings.json",
      "profiles/writing.json",
      "scratches/Quick Notes.md",
    ])
    expect(
      contents.get("scratches/Quick Notes.md")!.equals(scratchContent)
    ).toBe(true)
  })

  it("rejects a hash-matching scratch payload that is not valid UTF-8", async () => {
    const settingsContent = json({ lineWrapping: false })
    const scratchContent = Buffer.from([0x23, 0x20, 0xff, 0xfe])
    const scratchPath = "scratches/invalid.md"
    const archive = await minimalArchive({
      manifest: {
        ...minimalManifest(settingsContent),
        scratches: [
          {
            id: "019fe216-2b96-7511-8cf4-a35483924181",
            path: scratchPath,
            fileName: "invalid.md",
            title: null,
            createdAt: 1,
            modifiedAt: 2,
            lastOpenedAt: null,
            sha256: sha256(scratchContent),
          },
        ],
      },
      additionalEntries: [{ path: scratchPath, content: scratchContent }],
    })

    await expect(parseSettingsArchive(archive)).rejects.toThrow(
      `${scratchPath} is not valid UTF-8`
    )
  })

  it("rejects non-UTF-8 scratch bytes before creating an archive", async () => {
    await expect(
      createSettingsArchive({
        settings: { lineWrapping: false },
        scratches: [
          {
            id: "019fe216-2b96-7511-8cf4-a35483924181",
            fileName: "invalid.md",
            title: null,
            createdAt: 1,
            modifiedAt: 2,
            lastOpenedAt: null,
            content: Buffer.from([0x23, 0x20, 0xff, 0xfe]),
          },
        ],
      })
    ).rejects.toThrow(
      'Scratch "invalid.md" cannot be exported because it is not valid UTF-8'
    )
  })

  it("produces deterministic archives independent of resource input order", async () => {
    const input = {
      settings: { lineWrapping: true },
      scratches: [
        {
          id: "019fe216-2b96-7511-8cf4-a35483924182",
          fileName: "z.md",
          title: null,
          createdAt: 2,
          modifiedAt: 3,
          lastOpenedAt: 4,
          content: Buffer.from("z"),
        },
        {
          id: "019fe216-2b96-7511-8cf4-a35483924181",
          fileName: "a.md",
          title: null,
          createdAt: 1,
          modifiedAt: 2,
          lastOpenedAt: null,
          content: Buffer.from("a"),
        },
      ],
    } as const
    const first = await createSettingsArchive(input)
    const second = await createSettingsArchive({
      ...input,
      scratches: [...input.scratches].reverse(),
    })
    expect(second.equals(first)).toBe(true)
  })

  it("accepts ordinary deflated entries within the compression budget", async () => {
    const settingsContent = json({ lineWrapping: true })
    const archive = await testZip([
      {
        path: "manifest.json",
        content: json(minimalManifest(settingsContent)),
        compress: true,
      },
      { path: "settings.json", content: settingsContent, compress: true },
    ])
    await expect(parseSettingsArchive(archive)).resolves.toMatchObject({
      settings: { lineWrapping: true },
    })
  })

  it("rejects scratch metadata that is not store-portable", async () => {
    const baseScratch = {
      id: "019fe216-2b96-7511-8cf4-a35483924181",
      title: null,
      createdAt: 1,
      modifiedAt: 1,
      lastOpenedAt: null,
      content: Buffer.alloc(0),
    } as const
    for (const fileName of [
      "notes .md",
      "CON.md",
      "../notes.md",
      ".md",
      "notes.MD",
    ]) {
      await expect(
        createSettingsArchive({
          settings: {},
          scratches: [{ ...baseScratch, fileName }],
        })
      ).rejects.toThrow(/portable Markdown file name|reserved Windows/u)
    }
  })

  it("requires a strict, versioned manifest and valid UTF-8 JSON", async () => {
    const settingsContent = json({ lineWrapping: true })
    await expect(
      parseSettingsArchive(
        await minimalArchive({
          manifest: {
            ...minimalManifest(settingsContent),
            unsupported: true,
          },
        })
      )
    ).rejects.toThrow("unsupported is not a supported property")

    await expect(
      parseSettingsArchive(
        await minimalArchive({
          manifest: {
            ...minimalManifest(settingsContent),
            version: SETTINGS_ARCHIVE_VERSION + 1,
          },
        })
      )
    ).rejects.toThrow("version is unsupported")

    await expect(
      parseSettingsArchive(
        await minimalArchive({ manifest: Buffer.from([0xff, 0xfe]) })
      )
    ).rejects.toThrow("not valid UTF-8")
  })

  it("rejects unlisted, missing, mismatched, and modified payloads", async () => {
    await expect(
      parseSettingsArchive(
        await minimalArchive({
          additionalEntries: [{ path: "extra.json", content: json({}) }],
        })
      )
    ).rejects.toThrow("unlisted entry extra.json")

    await expect(
      parseSettingsArchive(await minimalArchive({ includeSettings: false }))
    ).rejects.toThrow("missing listed entry settings.json")

    const settingsContent = json({ lineWrapping: false })
    await expect(
      parseSettingsArchive(
        await minimalArchive({
          manifest: {
            ...minimalManifest(settingsContent),
            settings: { path: "settings.json", sha256: "0".repeat(64) },
          },
        })
      )
    ).rejects.toThrow("does not match its SHA-256 digest")

    await expect(
      createSettingsArchive({
        settings: {},
        profiles: [{ id: "writing", data: { id: "other" } }],
      })
    ).rejects.toThrow("mismatched id")
  })

  it("rejects duplicate case-folded paths, normalized paths, and ids", async () => {
    await expect(
      parseSettingsArchive(
        await testZip([
          { path: "A.md" },
          { path: "a.md" },
          { path: "manifest.json", content: json({}) },
        ])
      )
    ).rejects.toThrow("duplicate archive path")

    await expect(
      parseSettingsArchive(
        await testZip([
          { path: "é.md" },
          { path: "e\u0301.md" },
          { path: "manifest.json", content: json({}) },
        ])
      )
    ).rejects.toThrow("duplicate archive path")

    const settingsContent = json({})
    const firstContent = Buffer.from("first")
    const secondContent = Buffer.from("second")
    const manifest = {
      ...minimalManifest(settingsContent),
      scratches: [
        {
          id: "019fe216-2b96-7511-8cf4-a35483924181",
          path: "scratches/first.md",
          fileName: "first.md",
          title: null,
          createdAt: 1,
          modifiedAt: 1,
          lastOpenedAt: null,
          sha256: sha256(firstContent),
        },
        {
          id: "019fe216-2b96-7511-8cf4-a35483924181",
          path: "scratches/second.md",
          fileName: "second.md",
          title: null,
          createdAt: 1,
          modifiedAt: 1,
          lastOpenedAt: null,
          sha256: sha256(secondContent),
        },
      ],
    }
    await expect(
      parseSettingsArchive(
        await minimalArchive({
          manifest,
          additionalEntries: [
            { path: "scratches/first.md", content: firstContent },
            { path: "scratches/second.md", content: secondContent },
          ],
        })
      )
    ).rejects.toThrow("duplicate scratch id")
  })

  it("rejects traversal, absolute, backslash, and dot-segment paths", async () => {
    for (const path of ["../escape", "/absolute", "C:/absolute", "a/./b"]) {
      let archive: Buffer
      if (path === "a/./b") {
        archive = await testZip([{ path }])
      } else {
        const safePath = "x".repeat(Buffer.byteLength(path, "utf8"))
        archive = await testZip([{ path: safePath }])
        const centralOffset = centralDirectoryOffsets(archive)[0]!
        Buffer.from(path).copy(archive, centralOffset + 46)
      }
      await expect(parseSettingsArchive(archive)).rejects.toThrow(
        /unsafe path|Invalid settings archive/u
      )
    }

    const archive = await testZip([{ path: "back/slash" }])
    const centralOffset = centralDirectoryOffsets(archive)[0]!
    archive[centralOffset + 46 + 4] = 0x5c
    await expect(parseSettingsArchive(archive)).rejects.toThrow(
      /backslash|Invalid settings archive/u
    )
  })

  it("rejects encryption, symlinks, and unsupported compression methods", async () => {
    const encrypted = await minimalArchive()
    const encryptedCentralOffset = centralDirectoryOffsets(encrypted)[0]!
    encrypted.writeUInt16LE(
      encrypted.readUInt16LE(encryptedCentralOffset + 8) | 0x1,
      encryptedCentralOffset + 8
    )
    encrypted.writeUInt32LE(
      encrypted.readUInt32LE(encryptedCentralOffset + 20) + 12,
      encryptedCentralOffset + 20
    )
    await expect(parseSettingsArchive(encrypted)).rejects.toThrow(
      "is encrypted"
    )

    const symlink = await testZip([
      { path: "manifest.json", content: json({}), mode: 0o120777 },
    ])
    await expect(parseSettingsArchive(symlink)).rejects.toThrow(
      "must not be a symbolic link"
    )

    const unsupported = await minimalArchive()
    const unsupportedCentralOffset = centralDirectoryOffsets(unsupported)[0]!
    unsupported.writeUInt16LE(99, unsupportedCentralOffset + 10)
    await expect(parseSettingsArchive(unsupported)).rejects.toThrow(
      "unsupported compression method"
    )
  })

  it("bounds entry count, uncompressed size, and compression ratio", async () => {
    const tooManyEntries = Array.from(
      { length: MAX_SETTINGS_ARCHIVE_ENTRIES + 1 },
      (_, index): TestZipEntry => ({ path: `entry-${index}` })
    )
    await expect(
      parseSettingsArchive(await testZip(tooManyEntries))
    ).rejects.toThrow("too many entries")

    await expect(
      createSettingsArchive({
        settings: {},
        scratches: [
          {
            id: "019fe216-2b96-7511-8cf4-a35483924181",
            fileName: "oversized.md",
            title: null,
            createdAt: 1,
            modifiedAt: 1,
            lastOpenedAt: null,
            content: Buffer.alloc(MAX_SETTINGS_ARCHIVE_BYTES + 1),
          },
        ],
      })
    ).rejects.toThrow("entry limit")

    const highlyCompressed = Buffer.alloc(1024 * 1024, 0x61)
    expect(highlyCompressed.byteLength).toBeGreaterThan(
      MAX_SETTINGS_ARCHIVE_COMPRESSION_RATIO
    )
    await expect(
      parseSettingsArchive(
        await testZip([
          {
            path: "compressed.md",
            content: highlyCompressed,
            compress: true,
          },
        ])
      )
    ).rejects.toThrow("compression ratio limit")
  })
})
