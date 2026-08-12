import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const linkRace = vi.hoisted(() => ({
  destinationBasename: null as string | null,
  existingContent: "concurrent profile",
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    link: async (
      source: Parameters<typeof actual.link>[0],
      destination: Parameters<typeof actual.link>[1]
    ) => {
      if (
        linkRace.destinationBasename !== null &&
        path.basename(destination.toString()) === linkRace.destinationBasename
      ) {
        linkRace.destinationBasename = null
        await actual.writeFile(destination, linkRace.existingContent, {
          flag: "wx",
        })
      }
      await actual.link(source, destination)
    },
  }
})

import { PROFILE_SCHEMA_VERSION } from "./profile-schema"
import {
  MAX_PROFILE_FILE_BYTES,
  ProfileNotFoundError,
  ProfileStore,
  validateProfileFileIdentities,
} from "./profile-store"

interface RawTab {
  id: string
  kind: "ephemeral" | "file" | "scratch" | "untitled"
  path?: string
  scratch?: { profileId: string | null; tabId: string }
  scratchId?: string
  title?: string
}

let nextScratchId = 1

function testScratchId(): string {
  const suffix = (nextScratchId++).toString(16).padStart(12, "0")
  return `10000000-0000-4000-8000-${suffix}`
}

function rawProfile(
  id: string,
  tabs: RawTab[] = [{ id: "notes", kind: "scratch" }]
) {
  const normalizedTabs = tabs.map((tab) => {
    if (tab.kind !== "scratch") return tab
    const standaloneTab = { ...tab }
    delete standaloneTab.scratch
    return {
      ...standaloneTab,
      scratchId: tab.scratchId ?? testScratchId(),
    }
  })
  return {
    version: PROFILE_SCHEMA_VERSION,
    id,
    name: `${id} profile`,
    activeTab: normalizedTabs[0].id,
    tabVisibility: "always",
    mode: "source",
    tabs: normalizedTabs,
  }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
}

describe("ProfileStore", () => {
  let rootDirectory: string
  let userDataDirectory: string
  let sourceDirectory: string
  let store: ProfileStore

  beforeEach(async () => {
    linkRace.destinationBasename = null
    rootDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pmd-profile-store-test-")
    )
    userDataDirectory = path.join(rootDirectory, "user-data")
    sourceDirectory = path.join(rootDirectory, "imports")
    await mkdir(sourceDirectory, { recursive: true })
    store = new ProfileStore(userDataDirectory)
  })

  afterEach(async () => {
    linkRace.destinationBasename = null
    await rm(rootDirectory, { force: true, recursive: true })
  })

  async function importProfile(
    profile: ReturnType<typeof rawProfile>,
    fileName = `${profile.id}.json`,
    replace = false
  ) {
    const sourcePath = path.join(sourceDirectory, fileName)
    await writeFile(sourcePath, JSON.stringify(profile), "utf8")
    return store.import(sourcePath, replace)
  }

  it("imports, normalizes, lists, reads, and exports profiles", async () => {
    const relativeFilePath = path.join("documents", "notes.md")
    await importProfile(
      rawProfile("zeta", [
        { id: "file", kind: "file", path: relativeFilePath },
        { id: "scratch", kind: "scratch", title: "Scratch" },
      ])
    )
    await importProfile(rawProfile("alpha"))

    const zeta = await store.read("zeta")
    expect(zeta.tabs[0]).toEqual({
      id: "file",
      kind: "file",
      path: path.resolve(sourceDirectory, relativeFilePath),
    })
    expect((await store.list()).map((profile) => profile.id)).toEqual([
      "alpha",
      "zeta",
    ])

    const stdoutExport = await store.export("zeta")
    expect(JSON.parse(stdoutExport)).toEqual(zeta)
    expect(stdoutExport.endsWith("\n")).toBe(true)

    const destination = path.join(rootDirectory, "exports", "zeta.json")
    expect(await store.export("zeta", destination)).toBe(stdoutExport)
    expect(await readFile(destination, "utf8")).toBe(stdoutExport)

    await writeFile(destination, "unrelated", "utf8")
    await expect(store.export("zeta", destination)).rejects.toThrow(
      "pass --replace"
    )
    expect(await readFile(destination, "utf8")).toBe("unrelated")
    await expect(store.export("zeta", destination, true)).resolves.toBe(
      stdoutExport
    )
    expect(await readFile(destination, "utf8")).toBe(stdoutExport)
  })

  it("classifies only confirmed missing profiles as not found", async () => {
    await expect(store.read("missing-profile")).rejects.toMatchObject({
      name: "ProfileNotFoundError",
      profileId: "missing-profile",
    })
    await expect(
      store.readStoredProfileSnapshot("missing-snapshot")
    ).rejects.toBeInstanceOf(ProfileNotFoundError)

    await mkdir(store.profilePath("not-a-file"), { recursive: true })
    await expect(store.read("not-a-file")).rejects.not.toBeInstanceOf(
      ProfileNotFoundError
    )
  })

  it("bounds imported and stored profile files before JSON decoding", async () => {
    const oversizedImport = path.join(sourceDirectory, "oversized.json")
    await writeFile(oversizedImport, Buffer.alloc(MAX_PROFILE_FILE_BYTES + 1))
    await expect(store.import(oversizedImport, false)).rejects.toThrow(
      "Profile import is too large"
    )

    await mkdir(store.profileDirectory, { recursive: true })
    await writeFile(
      store.profilePath("oversized"),
      Buffer.alloc(MAX_PROFILE_FILE_BYTES + 1)
    )
    await expect(store.read("oversized")).rejects.toThrow(
      "Profile oversized is too large"
    )
    await expect(store.list()).rejects.toThrow("Stored profiles are too large")
  })

  it("lists profiles sequentially within explicit export bounds", async () => {
    await store.save(rawProfile("alpha"), false)
    await store.save(rawProfile("beta"), false)
    await expect(store.listBounded(64 * 1024, 2)).resolves.toHaveLength(2)
    await expect(store.listBounded(64 * 1024, 1)).rejects.toThrow(
      "too many profiles"
    )
    await expect(store.listBounded(1, 2)).rejects.toThrow(
      "profiles are too large"
    )
  })

  it("refuses an import overwrite unless replace is explicit", async () => {
    await importProfile(rawProfile("daily"))
    const replacement = {
      ...rawProfile("daily"),
      name: "Replacement profile",
    }

    await expect(importProfile(replacement)).rejects.toThrow(
      "Profile daily already exists; pass --replace to overwrite it"
    )
    expect((await store.read("daily")).name).toBe("daily profile")

    await importProfile(replacement, "daily-replacement.json", true)
    expect((await store.read("daily")).name).toBe("Replacement profile")
  })

  it("saves GUI profiles and deletes only their definitions", async () => {
    await store.save(rawProfile("writing"), false)
    const scratchPath = path.join(
      userDataDirectory,
      "scratch",
      "writing",
      "notes.md"
    )
    await mkdir(path.dirname(scratchPath), { recursive: true })
    await writeFile(scratchPath, "keep this", "utf8")

    await expect(store.save(rawProfile("writing"), false)).rejects.toThrow(
      "Profile writing already exists"
    )
    await store.save(
      { ...rawProfile("writing"), name: "Updated Writing" },
      true
    )
    expect((await store.read("writing")).name).toBe("Updated Writing")

    await store.delete("writing")
    await expect(store.read("writing")).rejects.toThrow("does not exist")
    expect(await readFile(scratchPath, "utf8")).toBe("keep this")
  })

  it("atomically refuses a profile created during a non-replacing save", async () => {
    linkRace.destinationBasename = "raced-save.json"

    await expect(store.save(rawProfile("raced-save"), false)).rejects.toThrow(
      "Profile raced-save already exists"
    )
    expect(await readFile(store.profilePath("raced-save"), "utf8")).toBe(
      linkRace.existingContent
    )
  })

  it("atomically refuses a profile created during a non-replacing import", async () => {
    linkRace.destinationBasename = "raced-import.json"

    await expect(importProfile(rawProfile("raced-import"))).rejects.toThrow(
      "pass --replace"
    )
    expect(await readFile(store.profilePath("raced-import"), "utf8")).toBe(
      linkRace.existingContent
    )
  })

  it("rejects file aliases before saving or importing a profile", async () => {
    if (process.platform === "win32") return
    const targetPath = path.join(rootDirectory, "document.md")
    const aliasPath = path.join(rootDirectory, "document-alias.md")
    await writeFile(targetPath, "document", "utf8")
    await symlink(targetPath, aliasPath)
    const aliasedProfile = rawProfile("aliased-files", [
      { id: "target", kind: "file", path: targetPath },
      { id: "alias", kind: "file", path: aliasPath },
    ])

    await expect(store.save(aliasedProfile, false)).rejects.toThrow(
      "refer to the same file"
    )
    await expectMissing(store.profilePath("aliased-files"))
    await expect(importProfile(aliasedProfile)).rejects.toThrow(
      "refer to the same file"
    )
    await expectMissing(store.profilePath("aliased-files"))
  })

  it("rejects dangling symbolic links that cannot be opened as profile files", async () => {
    if (process.platform === "win32") return
    const missingTarget = path.join(rootDirectory, "missing-target.md")
    const danglingPath = path.join(rootDirectory, "dangling-document.md")
    await symlink(missingTarget, danglingPath)
    const profile = rawProfile("dangling-file", [
      { id: "dangling", kind: "file", path: danglingPath },
    ])

    await expect(store.save(profile, false)).rejects.toThrow(
      "dangling symbolic link"
    )
    await expectMissing(store.profilePath("dangling-file"))
    await expect(importProfile(profile)).rejects.toThrow(
      "dangling symbolic link"
    )
    await expectMissing(store.profilePath("dangling-file"))
  })

  it("can isolate an unreadable inactive file during launch revalidation", async () => {
    if (process.platform === "win32") return
    const activePath = path.join(rootDirectory, "active.md")
    const danglingPath = path.join(rootDirectory, "inactive-dangling.md")
    await writeFile(activePath, "active", "utf8")
    await symlink(path.join(rootDirectory, "missing.md"), danglingPath)
    const profile = rawProfile("isolated-inactive", [
      { id: "active", kind: "file", path: activePath },
      { id: "inactive", kind: "file", path: danglingPath },
    ])

    await expect(
      validateProfileFileIdentities(
        profile as Parameters<typeof validateProfileFileIdentities>[0],
        { ignoreUnreadableTabIndexes: new Set([1]) }
      )
    ).resolves.toBeUndefined()
    await expect(
      validateProfileFileIdentities(
        profile as Parameters<typeof validateProfileFileIdentities>[0]
      )
    ).rejects.toThrow("dangling symbolic link")
  })

  it("rejects hard-linked file identities before saving or importing", async () => {
    const targetPath = path.join(rootDirectory, "hard-link-target.md")
    const aliasPath = path.join(rootDirectory, "hard-link-alias.md")
    await writeFile(targetPath, "document", "utf8")
    await link(targetPath, aliasPath)
    const aliasedProfile = rawProfile("hard-linked-files", [
      { id: "target", kind: "file", path: targetPath },
      { id: "alias", kind: "file", path: aliasPath },
    ])

    await expect(store.save(aliasedProfile, false)).rejects.toThrow(
      "refer to the same file"
    )
    await expectMissing(store.profilePath("hard-linked-files"))
    await expect(importProfile(aliasedProfile)).rejects.toThrow(
      "refer to the same file"
    )
    await expectMissing(store.profilePath("hard-linked-files"))
  })

  it("uses the current volume's case behavior for missing file identities", async () => {
    const probePath = path.join(rootDirectory, "case-probe")
    const probeAliasPath = path.join(rootDirectory, "CASE-PROBE")
    await writeFile(probePath, "probe", "utf8")
    const caseInsensitive = await stat(probeAliasPath).then(
      () => true,
      () => false
    )
    const profile = rawProfile("missing-case", [
      {
        id: "upper",
        kind: "file",
        path: path.join(rootDirectory, "Missing.md"),
      },
      {
        id: "lower",
        kind: "file",
        path: path.join(rootDirectory, "missing.md"),
      },
    ])

    if (caseInsensitive) {
      await expect(store.save(profile, false)).rejects.toThrow(
        "refer to the same file"
      )
      await expectMissing(store.profilePath("missing-case"))
    } else {
      await expect(store.save(profile, false)).resolves.toMatchObject({
        id: "missing-case",
      })
    }

    const unicodeProfile = rawProfile("missing-unicode", [
      {
        id: "composed",
        kind: "file",
        path: path.join(rootDirectory, "caf\u00e9.md"),
      },
      {
        id: "decomposed",
        kind: "file",
        path: path.join(rootDirectory, "cafe\u0301.md"),
      },
    ])
    if (process.platform === "darwin") {
      await expect(store.save(unicodeProfile, false)).rejects.toThrow(
        "refer to the same file"
      )
      await expectMissing(store.profilePath("missing-unicode"))
    } else {
      await expect(store.save(unicodeProfile, false)).resolves.toMatchObject({
        id: "missing-unicode",
      })
    }
  })

  it("uses the volume root's case behavior for missing direct children", async () => {
    const volumeRoot = path.parse(rootDirectory).root
    const entries = await readdir(volumeRoot, { withFileTypes: true })
    const probe = entries.find(
      (entry) => !entry.isSymbolicLink() && /[A-Za-z]/.test(entry.name)
    )
    if (!probe) return

    const index = probe.name.search(/[A-Za-z]/)
    const character = probe.name[index]!
    const toggledName = `${probe.name.slice(0, index)}${
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase()
    }${probe.name.slice(index + 1)}`
    const canonicalProbe = await realpath(path.join(volumeRoot, probe.name))
    const caseInsensitive = await realpath(
      path.join(volumeRoot, toggledName)
    ).then(
      (resolved) => resolved === canonicalProbe,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      }
    )
    const missingName = `pmd-root-case-${process.pid}-${Date.now()}.md`
    const profile = rawProfile("missing-root-case", [
      {
        id: "lower",
        kind: "file",
        path: path.join(volumeRoot, missingName),
      },
      {
        id: "upper",
        kind: "file",
        path: path.join(volumeRoot, missingName.toUpperCase()),
      },
    ])

    if (caseInsensitive) {
      await expect(store.save(profile, false)).rejects.toThrow(
        "refer to the same file"
      )
      await expectMissing(store.profilePath("missing-root-case"))
    } else {
      await expect(store.save(profile, false)).resolves.toMatchObject({
        id: "missing-root-case",
      })
    }
  })
})
