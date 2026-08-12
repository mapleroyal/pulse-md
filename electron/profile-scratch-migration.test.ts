import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ProfileStore, legacyScratchIdentityKey } from "./profile-store"
import {
  migrateStandaloneScratchStorage,
  rewriteCanonicalScratchMarkdownLinkSchemes,
  rewriteLegacyScratchMarkdownLinks,
} from "./scratch-migration"
import {
  ScratchStore,
  type LegacyScratchMigrationRequest,
} from "./scratch-store"

const migratedIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
]

function legacyProfile(
  id: string,
  tabs: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return {
    activeTab: tabs[0]!.id,
    id,
    mode: "source",
    name: `${id} profile`,
    tabs,
    tabVisibility: "always",
    version: 1,
  }
}

describe("standalone scratch migration", () => {
  let rootDirectory: string
  let profileStore: ProfileStore
  let scratchStore: ScratchStore

  beforeEach(async () => {
    rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pulse-md-profile-scratch-migration-")
    )
    profileStore = new ProfileStore(rootDirectory)
    let nextId = 0
    scratchStore = new ScratchStore(rootDirectory, {
      clock: () => new Date("2026-08-08T12:00:00.000Z"),
      generateId: () => migratedIds[nextId++]!,
    })
    await mkdir(profileStore.profileDirectory, { recursive: true })
  })

  afterEach(async () => {
    await rm(rootDirectory, { force: true, recursive: true })
  })

  async function writeProfile(
    id: string,
    value: Record<string, unknown>
  ): Promise<void> {
    await writeFile(
      profileStore.profilePath(id),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8"
    )
  }

  it("rewrites only parsed inline and reference Markdown destinations", () => {
    const source = Buffer.from(
      "\uFEFF[inline](pulse-md://scratch/profile/owner/notes#Today%20Now)\r\n" +
        "[angle](<pulse-md://scratch/ad-hoc/ideas#part>)\r\n" +
        "\r\n" +
        "[ref]: pulse-md://scratch/ad-hoc/ideas#reference\r\n" +
        "`pulse-md://scratch/ad-hoc/ideas#code`\r\n" +
        "```md\r\n[no](pulse-md://scratch/ad-hoc/ideas#fence)\r\n```\r\n",
      "utf8"
    )
    const rewritten = rewriteLegacyScratchMarkdownLinks(
      source,
      new Map([
        [
          legacyScratchIdentityKey({ profileId: "owner", tabId: "notes" }),
          migratedIds[0]!,
        ],
        [
          legacyScratchIdentityKey({ profileId: null, tabId: "ideas" }),
          migratedIds[1]!,
        ],
      ])
    )

    expect(rewritten.toString("utf8")).toBe(
      "\uFEFF[inline](pulse-md://scratch/10000000-0000-4000-8000-000000000001#Today%20Now)\r\n" +
        "[angle](<pulse-md://scratch/10000000-0000-4000-8000-000000000002#part>)\r\n" +
        "\r\n" +
        "[ref]: pulse-md://scratch/10000000-0000-4000-8000-000000000002#reference\r\n" +
        "`pulse-md://scratch/ad-hoc/ideas#code`\r\n" +
        "```md\r\n[no](pulse-md://scratch/ad-hoc/ideas#fence)\r\n```\r\n"
    )
  })

  it("rebinds imported canonical scratch links to the destination channel", () => {
    const source = Buffer.from(
      `[official](pulse-md://scratch/${migratedIds[0]}#one)\n` +
        `[local](<pulse-md-local://scratch/${migratedIds[1]}#two>)\n` +
        `[malformed](pulse-md://scratch/${migratedIds[2]}/extra)\n` +
        `\`pulse-md://scratch/${migratedIds[2]}#code\`\n`,
      "utf8"
    )
    expect(
      rewriteCanonicalScratchMarkdownLinkSchemes(
        source,
        "pulse-md-development"
      ).toString("utf8")
    ).toBe(
      `[official](pulse-md-development://scratch/${migratedIds[0]}#one)\n` +
        `[local](<pulse-md-development://scratch/${migratedIds[1]}#two>)\n` +
        `[malformed](pulse-md://scratch/${migratedIds[2]}/extra)\n` +
        `\`pulse-md://scratch/${migratedIds[2]}#code\`\n`
    )
  })

  it("copies legacy bytes, rewrites every profile reference, then cleans up", async () => {
    await writeProfile(
      "owner",
      legacyProfile("owner", [
        { id: "notes", kind: "scratch", title: "Owner Notes" },
        {
          id: "ideas",
          kind: "scratch",
          scratch: { profileId: null, tabId: "ideas" },
        },
      ])
    )
    await writeProfile(
      "consumer",
      legacyProfile("consumer", [
        {
          id: "shared",
          kind: "scratch",
          scratch: { profileId: "owner", tabId: "notes" },
        },
      ])
    )
    const ownedPath = path.join(scratchStore.directory, "owner", "notes.md")
    const adHocPath = path.join(scratchStore.directory, "_ad-hoc", "ideas.md")
    await mkdir(path.dirname(ownedPath), { recursive: true })
    await mkdir(path.dirname(adHocPath), { recursive: true })
    const exactBytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff, 0x0d, 0x0a])
    await writeFile(ownedPath, exactBytes)
    await writeFile(adHocPath, "portable ideas", "utf8")

    const references = await profileStore.listLegacyScratchReferences()
    expect(references).toHaveLength(3)
    const requestByIdentity = new Map<string, LegacyScratchMigrationRequest>()
    for (const reference of references) {
      const key = legacyScratchIdentityKey(reference.identity)
      if (!requestByIdentity.has(key)) {
        requestByIdentity.set(key, {
          identity: reference.identity,
          ...(reference.title === undefined ? {} : { title: reference.title }),
        })
      }
    }
    const migrations = await scratchStore.migrateLegacyScratches([
      ...requestByIdentity.values(),
    ])
    await profileStore.migrateLegacyScratchReferences(migrations)

    const owner = await profileStore.read("owner")
    const consumer = await profileStore.read("consumer")
    expect(owner.version).toBe(2)
    expect(consumer.version).toBe(2)
    const ownerNotes = owner.tabs.find((tab) => tab.id === "notes")
    const sharedNotes = consumer.tabs.find((tab) => tab.id === "shared")
    expect(ownerNotes).toMatchObject({ kind: "scratch" })
    expect(sharedNotes).toMatchObject({ kind: "scratch" })
    if (ownerNotes?.kind !== "scratch" || sharedNotes?.kind !== "scratch") {
      throw new Error("Expected migrated scratch tabs")
    }
    expect(sharedNotes.scratchId).toBe(ownerNotes.scratchId)
    expect(await scratchStore.read(ownerNotes.scratchId)).toEqual(exactBytes)
    expect(await profileStore.listLegacyScratchReferences()).toEqual([])

    await scratchStore.finalizeLegacyMigration(
      migrations.map(({ identity }) => identity)
    )
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(adHocPath)).rejects.toMatchObject({ code: "ENOENT" })

    const standalonePath = await scratchStore.pathFor(ownerNotes.scratchId)
    await profileStore.delete("owner")
    expect(await readFile(standalonePath)).toEqual(exactBytes)
  })

  it("preflights missing mappings before changing a legacy profile", async () => {
    const original = `${JSON.stringify(
      legacyProfile("owner", [{ id: "notes", kind: "scratch" }]),
      null,
      2
    )}\n`
    await writeFile(profileStore.profilePath("owner"), original, "utf8")

    await expect(
      profileStore.migrateLegacyScratchReferences([])
    ).rejects.toThrow("No standalone scratch was prepared")
    expect(await readFile(profileStore.profilePath("owner"), "utf8")).toBe(
      original
    )
  })

  it("resumes cataloged work and publishes a completion marker last", async () => {
    await writeProfile(
      "owner",
      legacyProfile("owner", [{ id: "notes", kind: "scratch" }])
    )
    const sourcePath = path.join(scratchStore.directory, "owner", "notes.md")
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(
      sourcePath,
      "[Self](pulse-md://scratch/profile/owner/notes#Checkpoint)",
      "utf8"
    )
    const [reference] = await profileStore.listLegacyScratchReferences()
    const [checkpoint] = await scratchStore.migrateLegacyScratches([
      { identity: reference!.identity },
    ])

    const result = await migrateStandaloneScratchStorage(
      profileStore,
      scratchStore
    )
    expect(result).toEqual({
      migratedProfileIds: ["owner"],
      scratchIds: [checkpoint!.scratchId],
      status: "migrated",
    })
    expect(await scratchStore.legacyMigrationIsComplete()).toBe(true)
    expect(await scratchStore.readLegacyMigrationCheckpoints()).toEqual([])
    await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await scratchStore.readText(checkpoint!.scratchId)).toBe(
      `[Self](pulse-md://scratch/${checkpoint!.scratchId}#Checkpoint)`
    )

    await expect(
      migrateStandaloneScratchStorage(profileStore, scratchStore)
    ).resolves.toEqual({
      migratedProfileIds: [],
      scratchIds: [],
      status: "already-complete",
    })
  })

  it("rewrites migrated links into the owning distribution channel", async () => {
    await writeProfile(
      "owner",
      legacyProfile("owner", [{ id: "notes", kind: "scratch" }])
    )
    const sourcePath = path.join(scratchStore.directory, "owner", "notes.md")
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(
      sourcePath,
      "[Self](pulse-md://scratch/profile/owner/notes#Checkpoint)",
      "utf8"
    )

    const result = await migrateStandaloneScratchStorage(
      profileStore,
      scratchStore,
      "pulse-md-local"
    )
    expect(await scratchStore.readText(result.scratchIds[0]!)).toBe(
      `[Self](pulse-md-local://scratch/${result.scratchIds[0]}#Checkpoint)`
    )
  })
})
