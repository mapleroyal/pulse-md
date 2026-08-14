import { randomUUID } from "node:crypto"
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import { renameReplacingFile, syncParentDirectory } from "./file-durability"
import {
  isProfileIdentifier,
  normalizeProfileSchema,
  PROFILE_SCHEMA_VERSION,
  type ProfileSchemaV2,
} from "./profile-schema"
import type { LegacyScratchIdentity } from "./scratch-store"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"

const PROFILE_FILE_IDENTITY_CONCURRENCY = 8
const FILE_READ_CHUNK_BYTES = 1024 * 1024
const LEGACY_PROFILE_SCHEMA_VERSION = 1
export const MAX_PROFILE_FILE_BYTES = 1024 * 1024
export const MAX_PROFILE_STORE_BYTES = 64 * 1024 * 1024
export const MAX_PROFILE_FILES = 1_000

export interface StoredFileSnapshot {
  readonly content: Buffer
  readonly mode: number
}

export interface LegacyProfileScratchReference {
  readonly identity: LegacyScratchIdentity
  readonly profileId: string
  readonly profileTabId: string
  readonly title?: string
}

export interface ProfileScratchReferenceMigration {
  readonly identity: LegacyScratchIdentity
  readonly scratchId: string
}

export function legacyScratchIdentityKey(
  identity: LegacyScratchIdentity
): string {
  return `${identity.profileId ?? "\0"}\0${identity.tabId}`
}

export class ProfileStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProfileStoreError"
  }
}

export class ProfileNotFoundError extends ProfileStoreError {
  readonly profileId: string

  constructor(profileId: string, options?: ErrorOptions) {
    super(`Profile ${profileId} does not exist`, options)
    this.name = "ProfileNotFoundError"
    this.profileId = profileId
  }
}

/**
 * Resolves every existing component of a path without creating its missing
 * suffix so prospective profile file aliases have a stable identity.
 */
interface ProspectivePathResolution {
  readonly canonicalPath: string
  readonly existingAncestor: string
}

async function resolveProspectivePath(
  candidatePath: string
): Promise<ProspectivePathResolution> {
  const missingComponents: string[] = []
  let currentPath = path.resolve(candidatePath)

  for (;;) {
    try {
      const existingAncestor = await realpath(currentPath)
      return {
        canonicalPath: path.join(existingAncestor, ...missingComponents),
        existingAncestor,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      try {
        if ((await lstat(currentPath)).isSymbolicLink()) {
          throw new ProfileStoreError(
            `Path contains a dangling symbolic link: ${currentPath}`,
            { cause: error }
          )
        }
      } catch (entryError) {
        if (entryError instanceof ProfileStoreError) throw entryError
        if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw entryError
        }
      }
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) throw error
      missingComponents.unshift(path.basename(currentPath))
      currentPath = parentPath
    }
  }
}

function toggleAsciiCase(value: string): string | null {
  const index = value.search(/[A-Za-z]/)
  if (index < 0) return null
  const character = value[index]!
  const toggled =
    character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase()
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`
}

async function entryLookupIsCaseInsensitive(
  parentPath: string,
  entryName: string,
  canonicalEntryPath: string
): Promise<boolean | null> {
  const toggledName = toggleAsciiCase(entryName)
  if (!toggledName) return null

  let toggledPath: string
  try {
    toggledPath = await realpath(path.join(parentPath, toggledName))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }

  try {
    const foldedName = entryName.toLocaleLowerCase("en-US")
    const variants = (await readdir(parentPath)).filter(
      (name) => name.toLocaleLowerCase("en-US") === foldedName
    )
    if (variants.length === 1) return true
    if (variants.length > 1) return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EACCES" && code !== "EPERM") throw error
  }

  return toggledPath === canonicalEntryPath
}

/**
 * Uses existing directory entries as a read-only case-sensitivity probe and
 * avoids assuming every macOS volume is case-insensitive. Probing each path
 * also respects filesystems whose case behavior can vary by directory.
 */
async function volumeIsCaseInsensitive(existingPath: string): Promise<boolean> {
  let currentPath = existingPath
  for (;;) {
    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) break
    const result = await entryLookupIsCaseInsensitive(
      parentPath,
      path.basename(currentPath),
      currentPath
    )
    if (result !== null) return result
    currentPath = parentPath
  }

  // A prospective child directly under a volume root has no basename above
  // it to toggle. Probe a real root child instead so `C:\Missing.md` and
  // `C:\missing.md` (and their macOS equivalents) cannot evade identity
  // validation merely because the rest of their path is absent.
  try {
    const entries = await readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !toggleAsciiCase(entry.name)) continue
      const entryPath = path.join(currentPath, entry.name)
      let canonicalEntryPath: string
      try {
        canonicalEntryPath = await realpath(entryPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      const result = await entryLookupIsCaseInsensitive(
        currentPath,
        entry.name,
        canonicalEntryPath
      )
      if (result !== null) return result
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EACCES" && code !== "EPERM") throw error
  }

  // Empty or unreadable roots provide no read-only probe. The supported
  // desktop defaults on macOS and Windows are case-insensitive, so fail safe
  // against duplicate identities there; Linux keeps its usual case-sensitive
  // behavior.
  return process.platform === "darwin" || process.platform === "win32"
}

function parseProfileJson(source: string, sourcePath: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    throw new ProfileStoreError(
      `Profile ${sourcePath} does not contain valid JSON`,
      { cause: error }
    )
  }
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function legacyScratchIdentityFromRawTab(
  profileId: string,
  tab: Record<string, unknown>,
  description: string
): LegacyScratchIdentity | null {
  if (tab.kind !== "scratch" || Object.hasOwn(tab, "scratchId")) return null
  if (!isProfileIdentifier(tab.id)) {
    throw new ProfileStoreError(`${description} has an invalid tab id`)
  }
  if (!Object.hasOwn(tab, "scratch")) {
    return { profileId, tabId: tab.id }
  }
  const scratch = rawRecord(tab.scratch)
  if (
    !scratch ||
    Object.keys(scratch).some(
      (key) => key !== "profileId" && key !== "tabId"
    ) ||
    !Object.hasOwn(scratch, "profileId") ||
    !Object.hasOwn(scratch, "tabId") ||
    (scratch.profileId !== null && !isProfileIdentifier(scratch.profileId)) ||
    !isProfileIdentifier(scratch.tabId)
  ) {
    throw new ProfileStoreError(
      `${description} has an invalid legacy scratch identity`
    )
  }
  return { profileId: scratch.profileId, tabId: scratch.tabId }
}

function serializedProfile(profile: ProfileSchemaV2): string {
  return `${JSON.stringify(profile, null, 2)}\n`
}

async function atomicWriteText(
  filePath: string,
  content: string | Buffer,
  mode?: number
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, "wx", mode ?? 0o600)
    if (typeof content === "string") await handle.writeFile(content, "utf8")
    else await handle.writeFile(content)
    if (mode !== undefined) await handle.chmod(mode & 0o777)
    await handle.sync()
    await handle.close()
    handle = null
    await renameReplacingFile(temporaryPath, filePath)
    await syncParentDirectory(filePath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

async function readFileSnapshot(
  filePath: string,
  missingProfileId: string,
  maximumBytes = MAX_PROFILE_FILE_BYTES
): Promise<StoredFileSnapshot> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProfileNotFoundError(missingProfileId, { cause: error })
    }
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new ProfileStoreError(`Stored resource is not a file: ${filePath}`)
    }
    if (stats.size > maximumBytes) {
      throw new ProfileStoreError(`Profile file is too large: ${filePath}`)
    }
    const chunks: Buffer[] = []
    let byteLength = 0
    const bytes = Buffer.allocUnsafe(
      Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, maximumBytes + 1))
    )
    for (;;) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > maximumBytes) {
        throw new ProfileStoreError(`Profile file is too large: ${filePath}`)
      }
      chunks.push(Buffer.from(bytes.subarray(0, bytesRead)))
    }
    return {
      content: Buffer.concat(chunks, byteLength),
      mode: stats.mode & 0o777,
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readBoundedTextFile(
  filePath: string,
  maximumBytes: number,
  tooLargeMessage = "Stored profiles are too large"
): Promise<{ byteLength: number; source: string }> {
  const handle = await open(filePath, "r")
  const chunks: Buffer[] = []
  let byteLength = 0
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new ProfileStoreError(`Stored resource is not a file: ${filePath}`)
    }
    if (stats.size > maximumBytes) {
      throw new ProfileStoreError(tooLargeMessage)
    }
    const bytes = Buffer.allocUnsafe(
      Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, maximumBytes + 1))
    )
    for (;;) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > maximumBytes) {
        throw new ProfileStoreError(tooLargeMessage)
      }
      chunks.push(Buffer.from(bytes.subarray(0, bytesRead)))
    }
    return {
      byteLength,
      source: Buffer.concat(chunks, byteLength).toString("utf8"),
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Publishes a fully written file without any check-then-write overwrite race.
 * A hard link is the atomic no-replace commit; an interrupted commit can leave
 * only a private dot-prefixed temporary sibling, never a partial destination.
 */
async function atomicCreateText(
  filePath: string,
  content: string,
  existingMessage = `Refusing to overwrite existing file ${filePath}`
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporaryPath, filePath)
    await syncParentDirectory(filePath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProfileStoreError(existingMessage, { cause: error })
    }
    throw error
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * Resolves existing aliases (including symlinks and case aliases) and the
 * existing prefix of missing paths before a profile is made durable.
 */
export async function validateProfileFileIdentities(
  profile: ProfileSchemaV2,
  options: {
    ignoreUnreadableTabIndexes?: ReadonlySet<number>
  } = {}
): Promise<void> {
  const fileTabs = profile.tabs.flatMap((tab, index) =>
    tab.kind === "file" ? [{ index, tab }] : []
  )
  const resolvedIdentities: Array<readonly string[] | undefined> = new Array(
    profile.tabs.length
  )
  const caseSensitivityByAncestor = new Map<string, Promise<boolean>>()
  let nextFileTabIndex = 0

  const resolveNextIdentity = async () => {
    for (;;) {
      const workIndex = nextFileTabIndex
      nextFileTabIndex += 1
      const entry = fileTabs[workIndex]
      if (!entry) return
      try {
        const resolved = await resolveProspectivePath(entry.tab.path)
        let caseInsensitive = caseSensitivityByAncestor.get(
          resolved.existingAncestor
        )
        if (!caseInsensitive) {
          caseInsensitive = volumeIsCaseInsensitive(resolved.existingAncestor)
          caseSensitivityByAncestor.set(
            resolved.existingAncestor,
            caseInsensitive
          )
        }
        // APFS and HFS+ compare composed and decomposed Unicode spellings as
        // the same name even on case-sensitive volumes. Conservatively apply
        // that host behavior to prospective paths on macOS; other hosts
        // preserve native code-unit identity so ext4 can keep both names.
        const normalizationIdentity =
          process.platform === "darwin"
            ? resolved.canonicalPath.normalize("NFC")
            : resolved.canonicalPath
        const pathIdentity = `path:${
          (await caseInsensitive)
            ? normalizationIdentity.toLocaleLowerCase("en-US")
            : normalizationIdentity
        }`
        let inodeIdentity: string | null = null
        try {
          const fileStats = await stat(resolved.canonicalPath, { bigint: true })
          if (fileStats.ino !== 0n) {
            inodeIdentity = `inode:${fileStats.dev}:${fileStats.ino}`
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        resolvedIdentities[entry.index] = inodeIdentity
          ? [pathIdentity, inodeIdentity]
          : [pathIdentity]
      } catch (error) {
        if (!options.ignoreUnreadableTabIndexes?.has(entry.index)) throw error
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(PROFILE_FILE_IDENTITY_CONCURRENCY, fileTabs.length),
      },
      resolveNextIdentity
    )
  )

  const seenIdentities = new Map<string, number>()
  for (let index = 0; index < resolvedIdentities.length; index += 1) {
    const identities = resolvedIdentities[index]
    if (!identities) continue
    const previousIndex = identities.reduce<number | undefined>(
      (found, identity) => found ?? seenIdentities.get(identity),
      undefined
    )
    if (previousIndex !== undefined) {
      throw new ProfileStoreError(
        `Profile tabs ${previousIndex + 1} and ${index + 1} refer to the same file`
      )
    }
    for (const identity of identities) seenIdentities.set(identity, index)
  }
}

export class ProfileStore {
  readonly profileDirectory: string

  constructor(userDataDirectory: string) {
    this.profileDirectory = path.join(userDataDirectory, "cli-profiles")
  }

  profilePath(id: string): string {
    if (!isProfileIdentifier(id)) {
      throw new ProfileStoreError(`Invalid profile id: ${id}`)
    }
    return path.join(this.profileDirectory, `${id}.json`)
  }

  private async profileIds(
    maximumProfiles = MAX_PROFILE_FILES
  ): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.profileDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const ids = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter(isProfileIdentifier)
      .sort((left, right) => left.localeCompare(right))
    if (ids.length > Math.min(maximumProfiles, MAX_PROFILE_FILES)) {
      throw new ProfileStoreError("There are too many profiles to load")
    }
    return ids
  }

  private async rawProfileDocuments(): Promise<
    Array<{
      readonly filePath: string
      readonly id: string
      readonly value: unknown
    }>
  > {
    const documents: Array<{
      readonly filePath: string
      readonly id: string
      readonly value: unknown
    }> = []
    let remainingBytes = MAX_PROFILE_STORE_BYTES
    for (const id of await this.profileIds()) {
      const filePath = this.profilePath(id)
      const { byteLength, source } = await readBoundedTextFile(
        filePath,
        Math.min(MAX_PROFILE_FILE_BYTES, remainingBytes),
        "Stored profiles are too large"
      )
      remainingBytes -= byteLength
      documents.push({
        filePath,
        id,
        value: parseProfileJson(source, filePath),
      })
    }
    return documents
  }

  /**
   * Reads the pre-standalone profile shape without asking the current schema
   * normalizer to accept it. This is intentionally the only compatibility path
   * for profile-owned and `_ad-hoc` scratch identities.
   */
  async listLegacyScratchReferences(): Promise<
    LegacyProfileScratchReference[]
  > {
    const references: LegacyProfileScratchReference[] = []
    for (const document of await this.rawProfileDocuments()) {
      const profile = rawRecord(document.value)
      if (
        !profile ||
        profile.id !== document.id ||
        !Array.isArray(profile.tabs)
      ) {
        throw new ProfileStoreError(
          `Profile file ${document.filePath} does not have a migratable shape`
        )
      }
      if (profile.version === PROFILE_SCHEMA_VERSION) {
        normalizeProfileSchema(profile, {
          sourceDirectory: this.profileDirectory,
        })
        continue
      }
      if (profile.version !== LEGACY_PROFILE_SCHEMA_VERSION) {
        throw new ProfileStoreError(
          `Profile file ${document.filePath} is not schema version ${LEGACY_PROFILE_SCHEMA_VERSION} or ${PROFILE_SCHEMA_VERSION}`
        )
      }
      for (let index = 0; index < profile.tabs.length; index += 1) {
        const tab = rawRecord(profile.tabs[index])
        if (!tab) continue
        const identity = legacyScratchIdentityFromRawTab(
          document.id,
          tab,
          `Profile ${document.id} tab ${index + 1}`
        )
        if (!identity) continue
        references.push({
          identity,
          profileId: document.id,
          profileTabId: tab.id as string,
          ...(typeof tab.title === "string" && tab.title.trim().length > 0
            ? { title: tab.title.trim() }
            : {}),
        })
      }
    }
    return references
  }

  /**
   * Rewrites all legacy references as required global scratch ids. Every file
   * is normalized before the first write, and already-written profiles are
   * restored byte-for-byte if a later atomic replacement fails.
   */
  async migrateLegacyScratchReferences(
    migrations: readonly ProfileScratchReferenceMigration[]
  ): Promise<string[]> {
    const scratchIdByLegacyIdentity = new Map<string, string>()
    for (const migration of migrations) {
      const key = legacyScratchIdentityKey(migration.identity)
      if (!isScratchIdentifier(migration.scratchId)) {
        throw new ProfileStoreError(
          `Invalid migrated scratch id: ${migration.scratchId}`
        )
      }
      const existing = scratchIdByLegacyIdentity.get(key)
      if (existing !== undefined && existing !== migration.scratchId) {
        throw new ProfileStoreError(
          "A legacy scratch identity maps to multiple scratch ids"
        )
      }
      scratchIdByLegacyIdentity.set(key, migration.scratchId)
    }

    const prepared: Array<{
      readonly content: string
      readonly filePath: string
      readonly id: string
      readonly snapshot: StoredFileSnapshot
    }> = []
    for (const document of await this.rawProfileDocuments()) {
      const profile = rawRecord(document.value)
      if (
        !profile ||
        profile.id !== document.id ||
        !Array.isArray(profile.tabs)
      ) {
        throw new ProfileStoreError(
          `Profile file ${document.filePath} does not have a migratable shape`
        )
      }
      if (profile.version === PROFILE_SCHEMA_VERSION) {
        normalizeProfileSchema(profile, {
          sourceDirectory: this.profileDirectory,
        })
        continue
      }
      if (profile.version !== LEGACY_PROFILE_SCHEMA_VERSION) {
        throw new ProfileStoreError(
          `Profile file ${document.filePath} is not schema version ${LEGACY_PROFILE_SCHEMA_VERSION} or ${PROFILE_SCHEMA_VERSION}`
        )
      }
      const tabs = profile.tabs.map((rawTab, index) => {
        const tab = rawRecord(rawTab)
        if (!tab) return rawTab
        const identity = legacyScratchIdentityFromRawTab(
          document.id,
          tab,
          `Profile ${document.id} tab ${index + 1}`
        )
        if (!identity) return rawTab
        const scratchId = scratchIdByLegacyIdentity.get(
          legacyScratchIdentityKey(identity)
        )
        if (!scratchId) {
          throw new ProfileStoreError(
            `No standalone scratch was prepared for ${identity.profileId ?? "_ad-hoc"}/${identity.tabId}`
          )
        }
        const migrated: Record<string, unknown> = { ...tab, scratchId }
        delete migrated.scratch
        return migrated
      })
      const normalized = normalizeProfileSchema(
        { ...profile, tabs, version: PROFILE_SCHEMA_VERSION },
        { sourceDirectory: this.profileDirectory }
      )
      const snapshot = await readFileSnapshot(document.filePath, document.id)
      prepared.push({
        content: serializedProfile(normalized),
        filePath: document.filePath,
        id: document.id,
        snapshot,
      })
    }

    const written: typeof prepared = []
    try {
      for (const profile of prepared) {
        await atomicWriteText(
          profile.filePath,
          profile.content,
          profile.snapshot.mode
        )
        written.push(profile)
      }
    } catch (error) {
      const rollbackFailures: unknown[] = []
      for (const profile of written.reverse()) {
        try {
          await atomicWriteText(
            profile.filePath,
            profile.snapshot.content,
            profile.snapshot.mode
          )
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
        }
      }
      if (rollbackFailures.length > 0) {
        throw new ProfileStoreError(
          "Profile scratch migration failed and could not fully roll back",
          { cause: new AggregateError([error, ...rollbackFailures]) }
        )
      }
      throw error
    }
    return prepared.map((profile) => profile.id)
  }

  async read(id: string): Promise<ProfileSchemaV2> {
    const filePath = this.profilePath(id)
    let source: string
    try {
      const bounded = await readBoundedTextFile(
        filePath,
        MAX_PROFILE_FILE_BYTES,
        `Profile ${id} is too large`
      )
      source = bounded.source
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProfileNotFoundError(id, { cause: error })
      }
      throw error
    }
    const profile = normalizeProfileSchema(parseProfileJson(source, filePath), {
      sourceDirectory: this.profileDirectory,
    })
    if (profile.id !== id) {
      throw new ProfileStoreError(
        `Profile file ${filePath} declares id ${profile.id}`
      )
    }
    return profile
  }

  async readStoredProfileSnapshot(id: string): Promise<StoredFileSnapshot> {
    return await readFileSnapshot(this.profilePath(id), id)
  }

  async list(): Promise<ProfileSchemaV2[]> {
    return await this.listBounded(MAX_PROFILE_STORE_BYTES, MAX_PROFILE_FILES)
  }

  async listBounded(
    maximumSourceBytes: number,
    maximumProfiles: number
  ): Promise<ProfileSchemaV2[]> {
    if (
      !Number.isSafeInteger(maximumSourceBytes) ||
      maximumSourceBytes < 0 ||
      !Number.isSafeInteger(maximumProfiles) ||
      maximumProfiles < 0
    ) {
      throw new ProfileStoreError("Invalid profile export bounds")
    }
    const ids = await this.profileIds(maximumProfiles)

    const profiles: ProfileSchemaV2[] = []
    let remainingBytes = Math.min(maximumSourceBytes, MAX_PROFILE_STORE_BYTES)
    for (const id of ids) {
      const filePath = this.profilePath(id)
      const { byteLength, source } = await readBoundedTextFile(
        filePath,
        Math.min(MAX_PROFILE_FILE_BYTES, remainingBytes),
        "Stored profiles are too large to export"
      )
      remainingBytes -= byteLength
      const profile = normalizeProfileSchema(
        parseProfileJson(source, filePath),
        {
          sourceDirectory: this.profileDirectory,
        }
      )
      if (profile.id !== id) {
        throw new ProfileStoreError(
          `Profile file ${filePath} declares id ${profile.id}`
        )
      }
      profiles.push(profile)
    }
    return profiles
  }

  async save(value: unknown, replace: boolean): Promise<ProfileSchemaV2> {
    const profile = normalizeProfileSchema(value, {
      sourceDirectory: this.profileDirectory,
    })
    await validateProfileFileIdentities(profile)
    await mkdir(this.profileDirectory, { mode: 0o700, recursive: true })
    const destinationPath = this.profilePath(profile.id)
    const content = serializedProfile(profile)
    if (replace) await atomicWriteText(destinationPath, content)
    else {
      await atomicCreateText(
        destinationPath,
        content,
        `Profile ${profile.id} already exists`
      )
    }
    return profile
  }

  async restoreStoredProfileSnapshot(
    id: string,
    snapshot: StoredFileSnapshot
  ): Promise<void> {
    await mkdir(this.profileDirectory, { mode: 0o700, recursive: true })
    await atomicWriteText(this.profilePath(id), snapshot.content, snapshot.mode)
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.read(id)
    await unlink(this.profilePath(id))
  }

  async import(
    sourcePath: string,
    replace: boolean,
    beforeWrite?: (profile: ProfileSchemaV2) => Promise<void> | void
  ): Promise<ProfileSchemaV2> {
    const resolvedSourcePath = path.resolve(sourcePath)
    const { source } = await readBoundedTextFile(
      resolvedSourcePath,
      MAX_PROFILE_FILE_BYTES,
      "Profile import is too large"
    )
    const profile = normalizeProfileSchema(
      parseProfileJson(source, resolvedSourcePath),
      { sourceDirectory: path.dirname(resolvedSourcePath) }
    )
    await validateProfileFileIdentities(profile)
    await beforeWrite?.(profile)
    await mkdir(this.profileDirectory, { mode: 0o700, recursive: true })
    const destinationPath = this.profilePath(profile.id)
    const content = serializedProfile(profile)
    if (replace) await atomicWriteText(destinationPath, content)
    else {
      await atomicCreateText(
        destinationPath,
        content,
        `Profile ${profile.id} already exists; pass --replace to overwrite it`
      )
    }
    return profile
  }

  async export(
    id: string,
    destinationPath?: string,
    replace = false
  ): Promise<string> {
    const content = serializedProfile(await this.read(id))
    if (!destinationPath) return content
    const resolvedDestination = path.resolve(destinationPath)
    await mkdir(path.dirname(resolvedDestination), {
      mode: 0o700,
      recursive: true,
    })
    if (replace) await atomicWriteText(resolvedDestination, content)
    else {
      await atomicCreateText(
        resolvedDestination,
        content,
        `Profile export destination already exists; pass --replace to overwrite it: ${resolvedDestination}`
      )
    }
    return content
  }

  async delete(id: string): Promise<void> {
    await this.deleteDefinition(id)
  }
}
