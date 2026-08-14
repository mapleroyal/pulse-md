import { randomUUID } from "node:crypto"
import { constants as fsConstants, type Dirent, type Stats } from "node:fs"
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"

import { isProfileIdentifier } from "../src/shared/profile-identifiers"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"
import {
  openFileForSync,
  renameReplacingFile,
  syncParentDirectory,
} from "./file-durability"

export const SCRATCH_CATALOG_VERSION = 1 as const
export const SCRATCH_CATALOG_FILE_NAME = ".catalog.json"
export const SCRATCH_BATCH_JOURNAL_FILE_NAME = ".scratch-batch-transaction.json"
const SCRATCH_BATCH_JOURNAL_NEXT_FILE_NAME = ".scratch-batch-transaction.next"
export const LEGACY_SCRATCH_MIGRATION_MARKER_FILE_NAME =
  ".standalone-migration-v1"
export const LEGACY_AD_HOC_SCRATCH_NAMESPACE = "_ad-hoc"
export const MAX_SCRATCH_FILE_NAME_BYTES = 255
export const MAX_SCRATCH_TITLE_LENGTH = 256
export const MAX_SCRATCH_UTF8_STREAM_CHUNK_BYTES = 64 * 1024

const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const MAX_BATCH_JOURNAL_BYTES = 48 * 1024 * 1024
const INVENTORY_PREFIX_BYTES = 64 * 1024
const INVENTORY_READ_CONCURRENCY = 8
const SEARCH_STREAM_BYTES = 64 * 1024
const PREVIEW_COMPLETE_BYTES = 1024 * 1024
const PREVIEW_PREFIX_BYTES = 256 * 1024
const PREVIEW_READ_ATTEMPTS = 3
const MAX_EXCERPT_LENGTH = 280
const SCRATCH_UTF8_STREAM_READ_BYTES = MAX_SCRATCH_UTF8_STREAM_CHUNK_BYTES - 3
const LEGACY_SCRATCH_MIGRATION_MARKER_CONTENT =
  "pulse-md-standalone-scratches-v1\n"
const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const WINDOWS_FORBIDDEN_FILE_NAME_PATTERN = /[<>:"/\\|?*\p{Cc}]/u

export interface ScratchCatalogEntry {
  readonly createdAt: number
  readonly fileName: string
  readonly id: string
  readonly lastOpenedAt: number | null
  readonly title?: string
}

export interface ScratchInventoryEntry extends ScratchCatalogEntry {
  readonly byteLength: number
  readonly excerpt: string
  readonly firstHeading: string | null
  readonly modifiedAt: number
  readonly path: string
  readonly revision: string
}

export interface ScratchFileSnapshot {
  readonly content: Buffer
  readonly entry: ScratchCatalogEntry
  readonly mode: number
  readonly modifiedAt: number
}

export interface ScratchPreviewSnapshot {
  readonly content: Buffer
  readonly entry: ScratchCatalogEntry
  readonly modifiedAt: number
  readonly revision: string
  readonly truncated: boolean
}

export interface ScratchSnapshotBatchReplacement {
  readonly entries: readonly ScratchCatalogEntry[]
  readonly rollback: () => Promise<void>
}

export interface CreateScratchOptions {
  readonly content?: string | Uint8Array
  readonly fileName?: string
  readonly markOpened?: boolean
  readonly title?: string
}

export interface UpdateScratchOptions {
  readonly fileName?: string
  /** Pass null to remove an explicit title. */
  readonly title?: string | null
}

export interface LegacyScratchIdentity {
  /** Null identifies the old `_ad-hoc` namespace. */
  readonly profileId: string | null
  readonly tabId: string
}

export interface LegacyScratchMigrationRequest {
  readonly identity: LegacyScratchIdentity
  readonly preferredFileName?: string
  readonly title?: string
}

export interface LegacyScratchMigrationResult {
  readonly fileName: string
  readonly identity: LegacyScratchIdentity
  readonly scratchId: string
  readonly sourceExisted: boolean
}

export interface ScratchStoreOptions {
  readonly clock?: () => Date
  readonly generateId?: () => string
}

interface StoredScratchCatalogEntry extends ScratchCatalogEntry {
  readonly migratedFrom?: LegacyScratchIdentity
}

interface ScratchCatalogV1 {
  readonly entries: readonly StoredScratchCatalogEntry[]
  readonly version: typeof SCRATCH_CATALOG_VERSION
}

type ScratchBatchPhase =
  | "preparing"
  | "prepared"
  | "backups-complete"
  | "installed"
  | "rolling-back-prepared"
  | "rolling-back-installed"
  | "rolled-back"
  | "committed"

interface ScratchBatchJournalFile {
  readonly backupFileName: string | null
  readonly destinationFileName: string | null
  readonly id: string
  readonly originalFileName: string | null
  readonly stageFileName: string | null
}

interface ScratchBatchJournal {
  readonly files: readonly ScratchBatchJournalFile[]
  readonly finalCatalog: ScratchCatalogV1
  readonly originalCatalog: ScratchCatalogV1
  readonly phase: ScratchBatchPhase
  readonly transactionId: string
  readonly version: 1
}

interface ScratchBatchRollbackOriginalState {
  readonly backupPath: string
  readonly backupStats: Stats | null
  readonly file: ScratchBatchJournalFile
  readonly originalPath: string
  readonly originalStats: Stats | null
}

interface CachedInventorySummary {
  readonly excerpt: string
  readonly fileName: string
  readonly firstHeading: string | null
  readonly revision: string
}

export class ScratchStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ScratchStoreError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  description: string
): void {
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected !== undefined) {
    throw new ScratchStoreError(
      `${description} contains unsupported property ${unexpected}`
    )
  }
}

function normalizedTimestamp(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ScratchStoreError(`${description} must be epoch milliseconds`)
  }
  return value
}

function normalizedTitle(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new ScratchStoreError(`${description} must be a string`)
  }
  const title = value.normalize("NFC").trim()
  if (
    title.length === 0 ||
    title.length > MAX_SCRATCH_TITLE_LENGTH ||
    /\p{Cc}/u.test(title)
  ) {
    throw new ScratchStoreError(
      `${description} must be 1-${MAX_SCRATCH_TITLE_LENGTH} visible characters`
    )
  }
  return title
}

export function normalizeScratchFileName(value: string): string {
  if (typeof value !== "string") {
    throw new ScratchStoreError("Scratch filename must be a string")
  }
  let fileName = value.normalize("NFC")
  if (!fileName.toLocaleLowerCase("en-US").endsWith(".md")) {
    fileName += ".md"
  } else {
    fileName = `${fileName.slice(0, -3)}.md`
  }
  if (
    fileName !== path.basename(fileName) ||
    WINDOWS_FORBIDDEN_FILE_NAME_PATTERN.test(fileName)
  ) {
    throw new ScratchStoreError(
      "Scratch filename cannot contain path separators, control characters, or reserved filename characters"
    )
  }
  const stem = fileName.slice(0, -3)
  if (
    stem.length === 0 ||
    stem === "." ||
    stem === ".." ||
    stem.endsWith(".") ||
    stem.endsWith(" ") ||
    WINDOWS_RESERVED_NAME_PATTERN.test(stem)
  ) {
    throw new ScratchStoreError(
      "Scratch filename is not portable across supported filesystems"
    )
  }
  if (Buffer.byteLength(fileName, "utf8") > MAX_SCRATCH_FILE_NAME_BYTES) {
    throw new ScratchStoreError(
      `Scratch filename cannot exceed ${MAX_SCRATCH_FILE_NAME_BYTES} UTF-8 bytes`
    )
  }
  return fileName
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0")
}

export function defaultScratchFileName(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new ScratchStoreError("Scratch creation time is invalid")
  }
  return (
    [
      "scratch",
      now.getFullYear(),
      padDatePart(now.getMonth() + 1),
      padDatePart(now.getDate()),
      `${padDatePart(now.getHours())}${padDatePart(now.getMinutes())}${padDatePart(
        now.getSeconds()
      )}`,
    ].join("-") + ".md"
  )
}

function fileNameIdentity(fileName: string): string {
  return fileName.normalize("NFC").toLocaleLowerCase("en-US")
}

function isPathWithin(directoryPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath)
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  )
}

async function canonicalizeProspectivePath(
  candidatePath: string
): Promise<string> {
  const missingComponents: string[] = []
  let currentPath = path.resolve(candidatePath)
  for (;;) {
    try {
      return path.join(await realpath(currentPath), ...missingComponents)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      try {
        if ((await lstat(currentPath)).isSymbolicLink()) {
          throw new ScratchStoreError(
            `Path contains a dangling symbolic link: ${currentPath}`,
            { cause: error }
          )
        }
      } catch (entryError) {
        if (entryError instanceof ScratchStoreError) throw entryError
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

function legacyIdentityKey(identity: LegacyScratchIdentity): string {
  return `${identity.profileId ?? "\0"}\0${identity.tabId}`
}

function normalizeLegacyIdentity(
  value: unknown,
  description: string
): LegacyScratchIdentity {
  if (!isRecord(value)) {
    throw new ScratchStoreError(`${description} must be an object`)
  }
  assertExactKeys(value, ["profileId", "tabId"], description)
  if (
    value.profileId !== null &&
    (typeof value.profileId !== "string" ||
      !isProfileIdentifier(value.profileId))
  ) {
    throw new ScratchStoreError(`${description}.profileId is invalid`)
  }
  if (typeof value.tabId !== "string" || !isProfileIdentifier(value.tabId)) {
    throw new ScratchStoreError(`${description}.tabId is invalid`)
  }
  return { profileId: value.profileId, tabId: value.tabId }
}

function publicEntry(entry: StoredScratchCatalogEntry): ScratchCatalogEntry {
  return {
    createdAt: entry.createdAt,
    fileName: entry.fileName,
    id: entry.id,
    lastOpenedAt: entry.lastOpenedAt,
    ...(entry.title === undefined ? {} : { title: entry.title }),
  }
}

function parseCatalog(source: string, catalogPath: string): ScratchCatalogV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch (error) {
    throw new ScratchStoreError(
      `Scratch catalog ${catalogPath} does not contain valid JSON`,
      { cause: error }
    )
  }
  if (!isRecord(parsed)) {
    throw new ScratchStoreError("Scratch catalog must be an object")
  }
  assertExactKeys(parsed, ["entries", "version"], "Scratch catalog")
  if (parsed.version !== SCRATCH_CATALOG_VERSION) {
    throw new ScratchStoreError(
      `Unsupported scratch catalog version: ${String(parsed.version)}`
    )
  }
  if (!Array.isArray(parsed.entries)) {
    throw new ScratchStoreError("Scratch catalog entries must be an array")
  }

  const seenIds = new Set<string>()
  const seenFileNames = new Set<string>()
  const seenLegacyIdentities = new Set<string>()
  const entries = parsed.entries.map((rawEntry, index) => {
    const description = `Scratch catalog entry ${index + 1}`
    if (!isRecord(rawEntry)) {
      throw new ScratchStoreError(`${description} must be an object`)
    }
    assertExactKeys(
      rawEntry,
      ["createdAt", "fileName", "id", "lastOpenedAt", "migratedFrom", "title"],
      description
    )
    if (!isScratchIdentifier(rawEntry.id)) {
      throw new ScratchStoreError(`${description}.id is invalid`)
    }
    if (seenIds.has(rawEntry.id)) {
      throw new ScratchStoreError(
        `Scratch catalog contains duplicate id ${rawEntry.id}`
      )
    }
    seenIds.add(rawEntry.id)
    if (typeof rawEntry.fileName !== "string") {
      throw new ScratchStoreError(`${description}.fileName is invalid`)
    }
    const fileName = normalizeScratchFileName(rawEntry.fileName)
    if (fileName !== rawEntry.fileName) {
      throw new ScratchStoreError(`${description}.fileName is not normalized`)
    }
    const fileNameKey = fileNameIdentity(fileName)
    if (seenFileNames.has(fileNameKey)) {
      throw new ScratchStoreError(
        `Scratch catalog contains duplicate filename ${fileName}`
      )
    }
    seenFileNames.add(fileNameKey)
    const createdAt = normalizedTimestamp(
      rawEntry.createdAt,
      `${description}.createdAt`
    )
    const lastOpenedAt =
      rawEntry.lastOpenedAt === null
        ? null
        : normalizedTimestamp(
            rawEntry.lastOpenedAt,
            `${description}.lastOpenedAt`
          )
    const title =
      rawEntry.title === undefined
        ? undefined
        : normalizedTitle(rawEntry.title, `${description}.title`)
    const migratedFrom =
      rawEntry.migratedFrom === undefined
        ? undefined
        : normalizeLegacyIdentity(
            rawEntry.migratedFrom,
            `${description}.migratedFrom`
          )
    if (migratedFrom) {
      const migrationKey = legacyIdentityKey(migratedFrom)
      if (seenLegacyIdentities.has(migrationKey)) {
        throw new ScratchStoreError(
          `${description}.migratedFrom duplicates another migration`
        )
      }
      seenLegacyIdentities.add(migrationKey)
    }
    return {
      createdAt,
      fileName,
      id: rawEntry.id,
      lastOpenedAt,
      ...(migratedFrom === undefined ? {} : { migratedFrom }),
      ...(title === undefined ? {} : { title }),
    }
  })
  return { entries, version: SCRATCH_CATALOG_VERSION }
}

function serializedCatalog(
  entries: readonly StoredScratchCatalogEntry[]
): string {
  return `${JSON.stringify(
    {
      entries: [...entries].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
      version: SCRATCH_CATALOG_VERSION,
    },
    null,
    2
  )}\n`
}

function scratchBatchArtifactFileName(
  transactionId: string,
  id: string,
  kind: "backup" | "stage"
): string {
  return `.scratch-batch-${transactionId}.${id}.${kind}`
}

function parseScratchBatchJournal(
  source: string,
  journalPath: string
): ScratchBatchJournal {
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch (error) {
    throw new ScratchStoreError(
      `Scratch batch journal ${journalPath} does not contain valid JSON`,
      { cause: error }
    )
  }
  if (!isRecord(parsed)) {
    throw new ScratchStoreError("Scratch batch journal must be an object")
  }
  assertExactKeys(
    parsed,
    [
      "files",
      "finalCatalog",
      "originalCatalog",
      "phase",
      "transactionId",
      "version",
    ],
    "Scratch batch journal"
  )
  if (parsed.version !== 1) {
    throw new ScratchStoreError(
      `Unsupported scratch batch journal version: ${String(parsed.version)}`
    )
  }
  if (!isScratchIdentifier(parsed.transactionId)) {
    throw new ScratchStoreError(
      "Scratch batch journal transaction id is invalid"
    )
  }
  const transactionId = parsed.transactionId
  if (
    parsed.phase !== "preparing" &&
    parsed.phase !== "prepared" &&
    parsed.phase !== "backups-complete" &&
    parsed.phase !== "installed" &&
    parsed.phase !== "rolling-back-prepared" &&
    parsed.phase !== "rolling-back-installed" &&
    parsed.phase !== "rolled-back" &&
    parsed.phase !== "committed"
  ) {
    throw new ScratchStoreError("Scratch batch journal phase is invalid")
  }
  if (!Array.isArray(parsed.files)) {
    throw new ScratchStoreError("Scratch batch journal files must be an array")
  }

  const originalCatalog = parseCatalog(
    JSON.stringify(parsed.originalCatalog),
    `${journalPath} original catalog`
  )
  const finalCatalog = parseCatalog(
    JSON.stringify(parsed.finalCatalog),
    `${journalPath} final catalog`
  )
  const originalById = new Map(
    originalCatalog.entries.map((entry) => [entry.id, entry])
  )
  const finalById = new Map(
    finalCatalog.entries.map((entry) => [entry.id, entry])
  )
  const seenIds = new Set<string>()
  const files = parsed.files.map((rawFile, index) => {
    const description = `Scratch batch journal file ${index + 1}`
    if (!isRecord(rawFile)) {
      throw new ScratchStoreError(`${description} must be an object`)
    }
    assertExactKeys(
      rawFile,
      [
        "backupFileName",
        "destinationFileName",
        "id",
        "originalFileName",
        "stageFileName",
      ],
      description
    )
    if (!isScratchIdentifier(rawFile.id) || seenIds.has(rawFile.id)) {
      throw new ScratchStoreError(`${description}.id is invalid or duplicated`)
    }
    seenIds.add(rawFile.id)
    const originalFileName = originalById.get(rawFile.id)?.fileName ?? null
    const destinationFileName = finalById.get(rawFile.id)?.fileName ?? null
    const backupFileName =
      originalFileName === null
        ? null
        : scratchBatchArtifactFileName(transactionId, rawFile.id, "backup")
    const stageFileName =
      destinationFileName === null
        ? null
        : scratchBatchArtifactFileName(transactionId, rawFile.id, "stage")
    if (
      rawFile.originalFileName !== originalFileName ||
      rawFile.destinationFileName !== destinationFileName ||
      rawFile.backupFileName !== backupFileName ||
      rawFile.stageFileName !== stageFileName ||
      (originalFileName === null && destinationFileName === null)
    ) {
      throw new ScratchStoreError(`${description} does not match its catalogs`)
    }
    return {
      backupFileName,
      destinationFileName,
      id: rawFile.id,
      originalFileName,
      stageFileName,
    }
  })
  const catalogIds = new Set([...originalById.keys(), ...finalById.keys()])
  for (const id of catalogIds) {
    if (
      JSON.stringify(originalById.get(id) ?? null) !==
        JSON.stringify(finalById.get(id) ?? null) &&
      !seenIds.has(id)
    ) {
      throw new ScratchStoreError(
        `Scratch batch journal omits changed scratch ${id}`
      )
    }
  }

  return {
    files,
    finalCatalog,
    originalCatalog,
    phase: parsed.phase,
    transactionId,
    version: 1,
  }
}

function serializedScratchBatchJournal(journal: ScratchBatchJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`
}

async function syncRegularFile(filePath: string): Promise<void> {
  const handle = await openFileForSync(filePath)
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ScratchStoreError(
        `Scratch transaction artifact is not a regular file: ${path.basename(filePath)}`
      )
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function createJournaledBuffer(
  filePath: string,
  content: Uint8Array,
  mode: number
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, "wx", mode)
    await handle.writeFile(content)
    await handle.chmod(mode & 0o777)
    await handle.sync()
    await handle.close()
    handle = null
    await syncParentDirectory(filePath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    throw error
  }
}

async function atomicCreateBuffer(
  destinationPath: string,
  content: Uint8Array,
  mode = 0o600,
  existingMessage = `Scratch file already exists: ${path.basename(destinationPath)}`
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, "wx", mode)
    await handle.writeFile(content)
    await handle.chmod(mode & 0o777)
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporaryPath, destinationPath)
    await syncParentDirectory(destinationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ScratchStoreError(existingMessage, { cause: error })
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function atomicReplaceBuffer(
  destinationPath: string,
  content: Uint8Array,
  mode = 0o600
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, "wx", mode)
    await handle.writeFile(content)
    await handle.chmod(mode & 0o777)
    await handle.sync()
    await handle.close()
    handle = null
    await renameReplacingFile(temporaryPath, destinationPath)
    await syncParentDirectory(destinationPath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function contentBuffer(content: string | Uint8Array | undefined): Buffer {
  if (content === undefined) return Buffer.alloc(0)
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(content)
}

function fileStatsMatch(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function fileIdentitiesMatch(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino
}

function fileRevision(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(
    ":"
  )
}

export function foldScratchSearchText(value: string): string {
  // Normalize the context-sensitive Greek final sigma to the ordinary sigma
  // after lowercasing so independently streamed chunks use the same fold as
  // the complete query.
  return value.toLocaleLowerCase().replace(/\u03c2/g, "\u03c3")
}

async function fileHandleContainsTerms(
  handle: Awaited<ReturnType<typeof open>>,
  byteLength: number,
  searchTerms: readonly string[],
  cancelled: () => boolean
): Promise<boolean> {
  const unmatched = new Set(searchTerms)
  if (unmatched.size === 0) return true

  const maximumTermLength = Math.max(
    1,
    ...searchTerms.map((term) => term.length)
  )
  const decoder = new TextDecoder("utf-8")
  const bytes = Buffer.allocUnsafe(SEARCH_STREAM_BYTES)
  let position = 0
  let rawOverlap = ""

  while (position < byteLength) {
    if (cancelled()) return false
    const { bytesRead } = await handle.read(
      bytes,
      0,
      Math.min(bytes.length, byteLength - position),
      position
    )
    if (bytesRead === 0) {
      throw new ScratchStoreError(
        "Scratch document changed while its search text was read"
      )
    }
    position += bytesRead
    const rawSearchable = `${rawOverlap}${decoder.decode(
      bytes.subarray(0, bytesRead),
      { stream: position < byteLength }
    )}`
    const searchable = foldScratchSearchText(rawSearchable)
    for (const term of unmatched) {
      if (searchable.includes(term)) unmatched.delete(term)
    }
    if (unmatched.size === 0) return true
    rawOverlap = rawSearchable.slice(-(maximumTermLength - 1))
  }

  const searchable = foldScratchSearchText(`${rawOverlap}${decoder.decode()}`)
  for (const term of unmatched) {
    if (searchable.includes(term)) unmatched.delete(term)
  }
  return unmatched.size === 0
}

function scratchUtf8Decoder(): TextDecoder {
  // `ignoreBOM: true` keeps a leading UTF-8 BOM as U+FEFF so re-encoding each
  // CLI content frame reproduces the scratch's exact bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
}

async function validateUtf8FileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  byteLength: number
): Promise<void> {
  const decoder = scratchUtf8Decoder()
  const bytes = Buffer.allocUnsafe(SCRATCH_UTF8_STREAM_READ_BYTES)
  let position = 0
  while (position < byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      0,
      Math.min(bytes.length, byteLength - position),
      position
    )
    if (bytesRead === 0) {
      throw new ScratchStoreError(
        "Scratch document changed while it was being streamed"
      )
    }
    decoder.decode(bytes.subarray(0, bytesRead), { stream: true })
    position += bytesRead
  }
  decoder.decode()
}

function utf8SafePrefix(content: Buffer): Buffer {
  if (content.length === 0) return content
  let leadIndex = content.length - 1
  while (
    leadIndex >= 0 &&
    content.length - leadIndex <= 4 &&
    (content[leadIndex]! & 0xc0) === 0x80
  ) {
    leadIndex -= 1
  }
  if (leadIndex < 0) return content
  const lead = content[leadIndex]!
  const expectedLength =
    (lead & 0x80) === 0
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 1
  return content.length - leadIndex < expectedLength
    ? content.subarray(0, leadIndex)
    : content
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function summarizeScratchMarkdown(source: string): {
  excerpt: string
  firstHeading: string | null
} {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/)
  let firstHeading: string | null = null
  let firstCodeLine: string | null = null
  const excerptLines: string[] = []
  let fenced = false
  let frontMatter = lines[0]?.trim() === "---"
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (frontMatter) {
      if (index > 0 && (trimmed === "---" || trimmed === "...")) {
        frontMatter = false
      }
      continue
    }
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      if (firstCodeLine === null && trimmed.length > 0) {
        firstCodeLine = trimmed.replace(/\s+/g, " ")
      }
      continue
    }
    if (trimmed.length === 0) continue

    const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    const nextLine = lines[index + 1]
    const setext =
      nextLine !== undefined && /^\s{0,3}(?:=+|-+)\s*$/.test(nextLine)
        ? stripInlineMarkdown(trimmed)
        : null
    if (atx || setext) {
      if (firstHeading === null) {
        firstHeading = stripInlineMarkdown(atx?.[1] ?? setext ?? "") || null
      }
      if (setext) index += 1
      continue
    }

    if (excerptLines.length < 2) {
      const plain = stripInlineMarkdown(
        trimmed.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "")
      )
      if (plain) excerptLines.push(plain)
    }
    if (firstHeading !== null && excerptLines.length >= 2) break
  }
  const excerpt = excerptLines.join(" ") || firstCodeLine || ""
  return {
    excerpt:
      excerpt.length <= MAX_EXCERPT_LENGTH
        ? excerpt
        : `${excerpt.slice(0, MAX_EXCERPT_LENGTH - 3).trimEnd()}...`,
    firstHeading,
  }
}

export class ScratchStore {
  readonly catalogPath: string
  readonly directory: string

  private readonly clock: () => Date
  private readonly generateId: () => string
  private readonly inventorySummaryCache = new Map<
    string,
    CachedInventorySummary
  >()
  private readonly initialization: Promise<void>
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string, options: ScratchStoreOptions = {}) {
    this.directory = path.join(userDataDirectory, "scratch")
    this.catalogPath = path.join(this.directory, SCRATCH_CATALOG_FILE_NAME)
    this.clock = options.clock ?? (() => new Date())
    this.generateId = options.generateId ?? randomUUID
    this.initialization = this.reconcileBatchJournal().then(() => undefined)
    // Public operations observe this rejection. Attaching a passive handler
    // also prevents a corrupt journal from becoming an unhandled rejection
    // before the first operation reaches the store.
    void this.initialization.catch(() => undefined)
  }

  private get legacyMigrationMarkerPath(): string {
    return path.join(this.directory, LEGACY_SCRATCH_MIGRATION_MARKER_FILE_NAME)
  }

  private get batchJournalPath(): string {
    return path.join(this.directory, SCRATCH_BATCH_JOURNAL_FILE_NAME)
  }

  private get batchJournalNextPath(): string {
    return path.join(this.directory, SCRATCH_BATCH_JOURNAL_NEXT_FILE_NAME)
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const initializedOperation = async () => {
      await this.initialization
      return await operation()
    }
    const result = this.mutationQueue.then(
      initializedOperation,
      initializedOperation
    )
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }

  private async waitForMutations(): Promise<void> {
    await this.initialization
    await this.mutationQueue
  }

  async drainMutations(): Promise<void> {
    await this.waitForMutations()
  }

  private invalidateCaches(id: string): void {
    this.inventorySummaryCache.delete(id)
  }

  private timestamp(): number {
    const now = this.clock()
    if (!Number.isFinite(now.getTime())) {
      throw new ScratchStoreError(
        "Scratch store clock returned an invalid date"
      )
    }
    return now.getTime()
  }

  private nextId(existingIds: ReadonlySet<string>): string {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const id = this.generateId()
      if (!isScratchIdentifier(id)) {
        throw new ScratchStoreError(
          "Scratch id generator returned an invalid id"
        )
      }
      if (!existingIds.has(id)) return id
    }
    throw new ScratchStoreError("Could not allocate a unique scratch id")
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const entry = await lstat(this.directory)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ScratchStoreError(
          `Scratch storage is not a private directory: ${this.directory}`
        )
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(this.directory, { mode: 0o700, recursive: true })
    const entry = await lstat(this.directory)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ScratchStoreError(
        `Scratch storage is not a private directory: ${this.directory}`
      )
    }
  }

  private async readBatchJournal(): Promise<ScratchBatchJournal | null> {
    try {
      const entry = await lstat(this.batchJournalPath)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ScratchStoreError(
          "Scratch batch journal is not a regular file"
        )
      }
      if (entry.size > MAX_BATCH_JOURNAL_BYTES) {
        throw new ScratchStoreError(
          "Scratch batch journal is unexpectedly large"
        )
      }
      return parseScratchBatchJournal(
        await readFile(this.batchJournalPath, "utf8"),
        this.batchJournalPath
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  private async writeBatchJournal(
    journal: ScratchBatchJournal,
    create: boolean
  ): Promise<void> {
    const content = Buffer.from(serializedScratchBatchJournal(journal), "utf8")
    if (content.byteLength > MAX_BATCH_JOURNAL_BYTES) {
      throw new ScratchStoreError("Scratch batch journal is unexpectedly large")
    }
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.batchJournalNextPath, "wx", 0o600)
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      handle = null
      if (create) {
        try {
          await link(this.batchJournalNextPath, this.batchJournalPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ScratchStoreError(
              "A scratch batch transaction is already in progress",
              { cause: error }
            )
          }
          throw error
        }
      } else {
        await renameReplacingFile(
          this.batchJournalNextPath,
          this.batchJournalPath
        )
      }
      await syncParentDirectory(this.batchJournalPath)
      if (create) {
        await unlink(this.batchJournalNextPath)
        await syncParentDirectory(this.batchJournalPath)
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(this.batchJournalNextPath).catch(() => undefined)
      throw error
    }
  }

  private async removeIfPresent(filePath: string): Promise<boolean> {
    try {
      await unlink(filePath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  private async finishBatchJournal(
    journal: ScratchBatchJournal
  ): Promise<void> {
    await this.removeIfPresent(this.batchJournalNextPath)
    for (const file of journal.files) {
      if (file.stageFileName) {
        await this.removeIfPresent(
          path.join(this.directory, file.stageFileName)
        )
      }
      if (file.backupFileName) {
        await this.removeIfPresent(
          path.join(this.directory, file.backupFileName)
        )
      }
    }
    await syncParentDirectory(this.batchJournalPath)
    await this.removeIfPresent(this.batchJournalPath)
    await syncParentDirectory(this.batchJournalPath)
  }

  private async verifiedBatchDestinations(
    journal: ScratchBatchJournal,
    requireEveryDestination: boolean
  ): Promise<string[]> {
    const verified: string[] = []
    for (const file of journal.files) {
      if (!file.destinationFileName || !file.stageFileName) continue
      const destinationPath = path.join(
        this.directory,
        file.destinationFileName
      )
      let destinationStats: Stats
      try {
        destinationStats = await lstat(destinationPath)
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          !requireEveryDestination
        ) {
          continue
        }
        throw new ScratchStoreError(
          `Scratch transaction destination cannot be verified: ${file.destinationFileName}`,
          { cause: error }
        )
      }
      const stagePath = path.join(this.directory, file.stageFileName)
      let stageStats: Stats
      try {
        stageStats = await lstat(stagePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ScratchStoreError(
            `Scratch transaction destination cannot be verified: ${file.destinationFileName}`,
            { cause: error }
          )
        }
        throw error
      }
      if (
        destinationStats.isSymbolicLink() ||
        !destinationStats.isFile() ||
        stageStats.isSymbolicLink() ||
        !stageStats.isFile() ||
        !fileIdentitiesMatch(destinationStats, stageStats)
      ) {
        throw new ScratchStoreError(
          `Scratch transaction destination does not match its staged replacement: ${file.destinationFileName}`
        )
      }
      verified.push(destinationPath)
    }
    return verified
  }

  private async finishCommittedBatchJournal(
    journal: ScratchBatchJournal
  ): Promise<void> {
    await this.verifiedBatchDestinations(journal, true)
    for (const file of journal.files) {
      if (file.backupFileName) {
        await this.removeIfPresent(
          path.join(this.directory, file.backupFileName)
        )
      }
    }
    await syncParentDirectory(this.batchJournalPath)
    const committedJournal: ScratchBatchJournal = {
      ...journal,
      phase: "committed",
    }
    await this.writeBatchJournal(committedJournal, false)
    await this.finishBatchJournal(committedJournal)
  }

  private async regularFileStatsIfPresent(
    filePath: string,
    description: string
  ): Promise<Stats | null> {
    try {
      const stats = await lstat(filePath)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new ScratchStoreError(`${description} is not a regular file`)
      }
      return stats
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  private async rollbackOriginalStates(
    journal: ScratchBatchJournal,
    requireEveryBackup: boolean
  ): Promise<ScratchBatchRollbackOriginalState[]> {
    const states: ScratchBatchRollbackOriginalState[] = []
    for (const file of journal.files) {
      if (!file.originalFileName || !file.backupFileName) continue
      const originalPath = path.join(this.directory, file.originalFileName)
      const backupPath = path.join(this.directory, file.backupFileName)
      const [backupStats, originalStats] = await Promise.all([
        this.regularFileStatsIfPresent(
          backupPath,
          `Scratch transaction backup ${file.backupFileName}`
        ),
        this.regularFileStatsIfPresent(
          originalPath,
          `Recovered scratch document ${file.originalFileName}`
        ),
      ])
      if (!backupStats && requireEveryBackup) {
        throw new ScratchStoreError(
          `Scratch transaction backup is missing during rollback: ${file.backupFileName}`
        )
      }
      if (!backupStats && !originalStats) {
        throw new ScratchStoreError(
          `Scratch transaction original cannot be verified: ${file.originalFileName}`
        )
      }
      states.push({
        backupPath,
        backupStats,
        file,
        originalPath,
        originalStats,
      })
    }
    return states
  }

  private async linkRollbackOriginals(
    states: readonly ScratchBatchRollbackOriginalState[]
  ): Promise<void> {
    for (const state of states) {
      if (!state.backupStats) continue
      const currentStats = await this.regularFileStatsIfPresent(
        state.originalPath,
        `Recovered scratch document ${state.file.originalFileName}`
      )
      if (currentStats) {
        if (fileIdentitiesMatch(currentStats, state.backupStats)) continue
        throw new ScratchStoreError(
          `Scratch transaction cannot overwrite an unexpected file: ${state.file.originalFileName}`
        )
      }
      try {
        await link(state.backupPath, state.originalPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const racedStats = await this.regularFileStatsIfPresent(
          state.originalPath,
          `Recovered scratch document ${state.file.originalFileName}`
        )
        if (racedStats && fileIdentitiesMatch(racedStats, state.backupStats)) {
          continue
        }
        throw new ScratchStoreError(
          `Scratch transaction cannot overwrite an unexpected file: ${state.file.originalFileName}`,
          { cause: error }
        )
      }
    }
    await syncParentDirectory(this.batchJournalPath)
  }

  private async restorePreparedBatchOriginals(
    journal: ScratchBatchJournal
  ): Promise<void> {
    const states = await this.rollbackOriginalStates(journal, false)
    for (const state of states) {
      if (
        state.backupStats &&
        state.originalStats &&
        !fileIdentitiesMatch(state.backupStats, state.originalStats)
      ) {
        throw new ScratchStoreError(
          `Scratch transaction cannot overwrite an unexpected file: ${state.file.originalFileName}`
        )
      }
    }
    await this.linkRollbackOriginals(states)
  }

  private async restoreInstalledBatchOriginals(
    journal: ScratchBatchJournal
  ): Promise<void> {
    const states = await this.rollbackOriginalStates(journal, true)
    const originalByFileName = new Map(
      states.map((state) => [
        fileNameIdentity(state.file.originalFileName!),
        state,
      ])
    )
    const destinationIdentitiesToRemove = new Set<string>()
    const destinationPathsToRemove: string[] = []

    for (const file of journal.files) {
      if (!file.destinationFileName || !file.stageFileName) continue
      const destinationPath = path.join(
        this.directory,
        file.destinationFileName
      )
      const destinationStats = await this.regularFileStatsIfPresent(
        destinationPath,
        `Scratch transaction destination ${file.destinationFileName}`
      )
      if (!destinationStats) continue
      const stageStats = await this.regularFileStatsIfPresent(
        path.join(this.directory, file.stageFileName),
        `Scratch transaction stage ${file.stageFileName}`
      )
      if (stageStats && fileIdentitiesMatch(destinationStats, stageStats)) {
        destinationIdentitiesToRemove.add(
          fileNameIdentity(file.destinationFileName)
        )
        destinationPathsToRemove.push(destinationPath)
        continue
      }
      const restoredOriginal = originalByFileName.get(
        fileNameIdentity(file.destinationFileName)
      )
      if (
        restoredOriginal?.backupStats &&
        fileIdentitiesMatch(destinationStats, restoredOriginal.backupStats)
      ) {
        continue
      }
      throw new ScratchStoreError(
        `Scratch transaction destination does not match its staged replacement or a restored original: ${file.destinationFileName}`
      )
    }

    for (const state of states) {
      if (!state.originalStats || !state.backupStats) continue
      if (fileIdentitiesMatch(state.originalStats, state.backupStats)) continue
      if (
        destinationIdentitiesToRemove.has(
          fileNameIdentity(state.file.originalFileName!)
        )
      ) {
        continue
      }
      throw new ScratchStoreError(
        `Scratch transaction cannot overwrite an unexpected file: ${state.file.originalFileName}`
      )
    }

    for (const destinationPath of destinationPathsToRemove) {
      await unlink(destinationPath)
    }
    if (destinationPathsToRemove.length > 0) {
      await syncParentDirectory(this.batchJournalPath)
    }
    await this.linkRollbackOriginals(states)
  }

  private async finishRolledBackBatchJournal(
    journal: ScratchBatchJournal
  ): Promise<void> {
    for (const file of journal.files) {
      if (!file.originalFileName || !file.backupFileName) continue
      const originalStats = await this.regularFileStatsIfPresent(
        path.join(this.directory, file.originalFileName),
        `Recovered scratch document ${file.originalFileName}`
      )
      if (!originalStats) {
        throw new ScratchStoreError(
          `Rolled-back scratch document is missing: ${file.originalFileName}`
        )
      }
      const backupStats = await this.regularFileStatsIfPresent(
        path.join(this.directory, file.backupFileName),
        `Scratch transaction backup ${file.backupFileName}`
      )
      if (backupStats && !fileIdentitiesMatch(originalStats, backupStats)) {
        throw new ScratchStoreError(
          `Rolled-back scratch document does not match its retained backup: ${file.originalFileName}`
        )
      }
    }
    await this.finishBatchJournal(journal)
  }

  private async restoreBatchJournal(
    journal: ScratchBatchJournal,
    currentCatalog: ScratchCatalogV1
  ): Promise<void> {
    if (journal.phase === "preparing") {
      if (
        serializedCatalog(currentCatalog.entries) !==
        serializedCatalog(journal.originalCatalog.entries)
      ) {
        throw new ScratchStoreError(
          "Preparing scratch batch journal does not match the current catalog"
        )
      }
      await this.finishBatchJournal(journal)
      return
    }

    let rollbackJournal = journal
    if (journal.phase === "prepared") {
      rollbackJournal = { ...journal, phase: "rolling-back-prepared" }
      await this.writeBatchJournal(rollbackJournal, false)
    } else if (
      journal.phase === "backups-complete" ||
      journal.phase === "installed"
    ) {
      rollbackJournal = { ...journal, phase: "rolling-back-installed" }
      await this.writeBatchJournal(rollbackJournal, false)
    }

    if (rollbackJournal.phase === "rolling-back-prepared") {
      await this.restorePreparedBatchOriginals(rollbackJournal)
    } else if (rollbackJournal.phase === "rolling-back-installed") {
      await this.restoreInstalledBatchOriginals(rollbackJournal)
    } else {
      throw new ScratchStoreError(
        `Scratch batch journal cannot be rolled back from phase ${rollbackJournal.phase}`
      )
    }

    if (
      serializedCatalog(currentCatalog.entries) !==
      serializedCatalog(rollbackJournal.originalCatalog.entries)
    ) {
      await this.writeCatalog(rollbackJournal.originalCatalog.entries)
    }
    const rolledBackJournal: ScratchBatchJournal = {
      ...rollbackJournal,
      phase: "rolled-back",
    }
    await this.writeBatchJournal(rolledBackJournal, false)
    await this.finishRolledBackBatchJournal(rolledBackJournal)
  }

  private async reconcileBatchJournal(): Promise<{
    readonly outcome: "committed" | "none" | "rolled-back"
    readonly transactionId: string | null
  }> {
    const journal = await this.readBatchJournal()
    if (!journal) {
      if (await this.removeIfPresent(this.batchJournalNextPath)) {
        await syncParentDirectory(this.batchJournalNextPath)
      }
      return { outcome: "none", transactionId: null }
    }
    // The published journal is the only authoritative transaction record.
    // A crash can leave the next-slot behind after it was synced but before
    // its rename; remove that unpublished state before any recovery rewrite.
    if (await this.removeIfPresent(this.batchJournalNextPath)) {
      await syncParentDirectory(this.batchJournalNextPath)
    }
    const currentCatalog = await this.readCatalog()
    const catalogIsFinal =
      serializedCatalog(currentCatalog.entries) ===
      serializedCatalog(journal.finalCatalog.entries)
    const catalogIsOriginal =
      serializedCatalog(currentCatalog.entries) ===
      serializedCatalog(journal.originalCatalog.entries)
    if (journal.phase === "committed") {
      if (!catalogIsFinal) {
        throw new ScratchStoreError(
          "Committed scratch batch journal does not match the current catalog"
        )
      }
      await this.finishBatchJournal(journal)
      return { outcome: "committed", transactionId: journal.transactionId }
    }
    if (journal.phase === "installed" && catalogIsFinal) {
      await this.finishCommittedBatchJournal(journal)
      return { outcome: "committed", transactionId: journal.transactionId }
    }
    if (journal.phase === "rolled-back") {
      if (!catalogIsOriginal) {
        throw new ScratchStoreError(
          "Rolled-back scratch batch journal does not match the current catalog"
        )
      }
      await this.finishRolledBackBatchJournal(journal)
      return { outcome: "rolled-back", transactionId: journal.transactionId }
    }
    await this.restoreBatchJournal(journal, currentCatalog)
    return { outcome: "rolled-back", transactionId: journal.transactionId }
  }

  private filePath(fileName: string): string {
    const normalized = normalizeScratchFileName(fileName)
    if (normalized !== fileName) {
      throw new ScratchStoreError("Scratch filename is not normalized")
    }
    return path.join(this.directory, fileName)
  }

  private async inspectFile(fileName: string): Promise<{
    readonly filePath: string
    readonly stats: Stats
  }> {
    const filePath = this.filePath(fileName)
    try {
      const entry = await lstat(filePath)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ScratchStoreError(
          `Scratch document is not a regular file: ${fileName}`
        )
      }
      return { filePath, stats: entry }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScratchStoreError(
          `Scratch file does not exist: ${fileName}`,
          {
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private async validateFile(fileName: string): Promise<string> {
    return (await this.inspectFile(fileName)).filePath
  }

  private async readCatalog(): Promise<ScratchCatalogV1> {
    try {
      const entry = await lstat(this.catalogPath)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ScratchStoreError("Scratch catalog is not a regular file")
      }
      if (entry.size > MAX_CATALOG_BYTES) {
        throw new ScratchStoreError("Scratch catalog is unexpectedly large")
      }
      return parseCatalog(
        await readFile(this.catalogPath, "utf8"),
        this.catalogPath
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [], version: SCRATCH_CATALOG_VERSION }
      }
      throw error
    }
  }

  private async writeCatalog(
    entries: readonly StoredScratchCatalogEntry[]
  ): Promise<void> {
    await this.ensureDirectory()
    try {
      const current = await lstat(this.catalogPath)
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new ScratchStoreError("Scratch catalog is not a regular file")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await atomicReplaceBuffer(
      this.catalogPath,
      Buffer.from(serializedCatalog(entries), "utf8")
    )
  }

  private async readLegacyMigrationMarker(): Promise<boolean> {
    try {
      const marker = await lstat(this.legacyMigrationMarkerPath)
      if (marker.isSymbolicLink() || !marker.isFile()) {
        throw new ScratchStoreError(
          "Scratch migration marker is not a regular file"
        )
      }
      const content = await readFile(this.legacyMigrationMarkerPath, "utf8")
      if (content !== LEGACY_SCRATCH_MIGRATION_MARKER_CONTENT) {
        throw new ScratchStoreError("Scratch migration marker is invalid")
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async legacyMigrationIsComplete(): Promise<boolean> {
    await this.waitForMutations()
    return await this.readLegacyMigrationMarker()
  }

  async markLegacyMigrationComplete(): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.ensureDirectory()
      if (await this.readLegacyMigrationMarker()) return
      try {
        await atomicCreateBuffer(
          this.legacyMigrationMarkerPath,
          Buffer.from(LEGACY_SCRATCH_MIGRATION_MARKER_CONTENT, "utf8")
        )
      } catch (error) {
        if (
          error instanceof ScratchStoreError &&
          (error.cause as NodeJS.ErrnoException | undefined)?.code ===
            "EEXIST" &&
          (await this.readLegacyMigrationMarker())
        ) {
          return
        }
        throw error
      }
    })
  }

  private entryById(
    catalog: ScratchCatalogV1,
    id: string
  ): StoredScratchCatalogEntry {
    if (!isScratchIdentifier(id)) {
      throw new ScratchStoreError(`Invalid scratch id: ${id}`)
    }
    const entry = catalog.entries.find((candidate) => candidate.id === id)
    if (!entry) throw new ScratchStoreError(`Scratch ${id} does not exist`)
    return entry
  }

  private async uniqueFileName(
    preferred: string,
    entries: readonly StoredScratchCatalogEntry[],
    excludingId?: string
  ): Promise<string> {
    const normalized = normalizeScratchFileName(preferred)
    const stem = normalized.slice(0, -3)
    const occupied = new Set(
      entries
        .filter((entry) => entry.id !== excludingId)
        .map((entry) => fileNameIdentity(entry.fileName))
    )
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`
      let candidateStem = stem
      while (
        Buffer.byteLength(`${candidateStem}${suffixText}.md`, "utf8") >
        MAX_SCRATCH_FILE_NAME_BYTES
      ) {
        candidateStem = candidateStem.slice(0, -1)
      }
      if (!candidateStem) {
        throw new ScratchStoreError("Scratch filename cannot be made unique")
      }
      const candidate = normalizeScratchFileName(
        `${candidateStem}${suffixText}.md`
      )
      if (occupied.has(fileNameIdentity(candidate))) continue
      try {
        await lstat(this.filePath(candidate))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate
        throw error
      }
    }
    throw new ScratchStoreError("Could not allocate a unique scratch filename")
  }

  async create(
    options: CreateScratchOptions = {}
  ): Promise<ScratchCatalogEntry> {
    return await this.enqueueMutation(async () => {
      await this.ensureDirectory()
      const catalog = await this.readCatalog()
      const id = this.nextId(new Set(catalog.entries.map((entry) => entry.id)))
      const fileName = await this.uniqueFileName(
        options.fileName ?? defaultScratchFileName(this.clock()),
        catalog.entries
      )
      const createdAt = this.timestamp()
      const title =
        options.title === undefined
          ? undefined
          : normalizedTitle(options.title, "Scratch title")
      const entry: StoredScratchCatalogEntry = {
        createdAt,
        fileName,
        id,
        lastOpenedAt: options.markOpened === false ? null : createdAt,
        ...(title === undefined ? {} : { title }),
      }
      const filePath = this.filePath(fileName)
      await atomicCreateBuffer(filePath, contentBuffer(options.content))
      try {
        await this.writeCatalog([...catalog.entries, entry])
      } catch (error) {
        await unlink(filePath).catch(() => undefined)
        throw error
      }
      return publicEntry(entry)
    })
  }

  async get(id: string): Promise<ScratchCatalogEntry> {
    await this.waitForMutations()
    return publicEntry(this.entryById(await this.readCatalog(), id))
  }

  async listCatalog(): Promise<ScratchCatalogEntry[]> {
    await this.waitForMutations()
    const catalog = await this.readCatalog()
    return catalog.entries
      .map(publicEntry)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async findByFileNameOrStem(
    value: string
  ): Promise<ScratchCatalogEntry | null> {
    await this.waitForMutations()
    const catalog = await this.readCatalog()
    if (isScratchIdentifier(value)) {
      const byId = catalog.entries.find((entry) => entry.id === value)
      if (byId) return publicEntry(byId)
    }
    let normalized: string
    try {
      normalized = normalizeScratchFileName(value)
    } catch {
      return null
    }
    const key = fileNameIdentity(normalized)
    const entry = catalog.entries.find(
      (candidate) => fileNameIdentity(candidate.fileName) === key
    )
    return entry ? publicEntry(entry) : null
  }

  async pathFor(id: string): Promise<string> {
    await this.waitForMutations()
    const entry = this.entryById(await this.readCatalog(), id)
    return await this.validateFile(entry.fileName)
  }

  /** Returns a stable destination outside the app-managed scratch directory. */
  async canonicalizeExportPath(
    destinationPath: string,
    createParent = false
  ): Promise<string> {
    await this.ensureDirectory()
    const resolvedDestination = path.resolve(destinationPath)
    const resolvedScratchDirectory = path.resolve(this.directory)
    if (isPathWithin(resolvedScratchDirectory, resolvedDestination)) {
      throw new ScratchStoreError(
        "A scratch export cannot be created inside the app's scratch storage"
      )
    }
    const [prospectiveDestination, prospectiveScratchDirectory] =
      await Promise.all([
        canonicalizeProspectivePath(resolvedDestination),
        canonicalizeProspectivePath(resolvedScratchDirectory),
      ])
    if (isPathWithin(prospectiveScratchDirectory, prospectiveDestination)) {
      throw new ScratchStoreError(
        "A scratch export cannot resolve inside the app's scratch storage"
      )
    }
    if (createParent) {
      await mkdir(path.dirname(prospectiveDestination), {
        mode: 0o700,
        recursive: true,
      })
    }
    const [canonicalDestination, canonicalScratchDirectory] = await Promise.all(
      [
        canonicalizeProspectivePath(prospectiveDestination),
        realpath(this.directory),
      ]
    )
    if (isPathWithin(canonicalScratchDirectory, canonicalDestination)) {
      throw new ScratchStoreError(
        "A scratch export cannot resolve inside the app's scratch storage"
      )
    }
    return canonicalDestination
  }

  async exportFile(id: string, destinationPath: string): Promise<string> {
    const [snapshot, canonicalDestination] = await Promise.all([
      this.readSnapshot(id),
      this.canonicalizeExportPath(destinationPath, true),
    ])
    await atomicCreateBuffer(
      canonicalDestination,
      snapshot.content,
      0o600,
      `Refusing to overwrite existing scratch export because the destination already exists: ${canonicalDestination}`
    )
    return canonicalDestination
  }

  async read(id: string): Promise<Buffer> {
    return Buffer.from((await this.readSnapshot(id)).content)
  }

  async readText(id: string): Promise<string> {
    return (await this.read(id)).toString("utf8")
  }

  async *streamUtf8(id: string): AsyncGenerator<string> {
    await this.waitForMutations()
    const entry = this.entryById(await this.readCatalog(), id)
    const inspection = await this.inspectFile(entry.fileName)
    const handle = await open(
      inspection.filePath,
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    )
    try {
      const before = await handle.stat()
      if (!before.isFile() || !fileStatsMatch(inspection.stats, before)) {
        throw new ScratchStoreError(
          `Scratch document changed before it could be streamed: ${entry.fileName}`
        )
      }
      try {
        // Validate before emitting the first frame so malformed UTF-8 produces
        // one ordinary CLI error rather than partial stdout followed by error.
        await validateUtf8FileHandle(handle, before.size)
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ScratchStoreError(
            "Scratch stdout export requires valid UTF-8; export to a file to preserve its raw bytes",
            { cause: error }
          )
        }
        throw error
      }

      const [afterValidation, finalInspection] = await Promise.all([
        handle.stat(),
        this.inspectFile(entry.fileName),
      ])
      if (
        !fileStatsMatch(before, afterValidation) ||
        !fileStatsMatch(afterValidation, finalInspection.stats)
      ) {
        throw new ScratchStoreError(
          `Scratch document changed while it was being validated: ${entry.fileName}`
        )
      }

      const decoder = scratchUtf8Decoder()
      const bytes = Buffer.allocUnsafe(SCRATCH_UTF8_STREAM_READ_BYTES)
      let position = 0
      while (position < before.size) {
        const { bytesRead } = await handle.read(
          bytes,
          0,
          Math.min(bytes.length, before.size - position),
          position
        )
        if (bytesRead === 0) {
          throw new ScratchStoreError(
            `Scratch document changed while it was being streamed: ${entry.fileName}`
          )
        }
        const text = decoder.decode(bytes.subarray(0, bytesRead), {
          stream: true,
        })
        if (text.length > 0) yield text
        position += bytesRead
      }
      const trailingText = decoder.decode()
      if (trailingText.length > 0) yield trailingText
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  async readSnapshot(id: string): Promise<ScratchFileSnapshot> {
    await this.waitForMutations()
    const entry = this.entryById(await this.readCatalog(), id)
    const filePath = await this.validateFile(entry.fileName)
    const handle = await open(filePath, "r")
    try {
      const fileStats = await handle.stat()
      if (!fileStats.isFile()) {
        throw new ScratchStoreError(
          `Scratch document is not a regular file: ${entry.fileName}`
        )
      }
      return {
        content: await handle.readFile(),
        entry: publicEntry(entry),
        mode: fileStats.mode & 0o777,
        modifiedAt: Math.trunc(fileStats.mtimeMs),
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  async readPreview(id: string): Promise<ScratchPreviewSnapshot> {
    await this.waitForMutations()
    const entry = this.entryById(await this.readCatalog(), id)
    for (let attempt = 1; attempt <= PREVIEW_READ_ATTEMPTS; attempt += 1) {
      const inspection = await this.inspectFile(entry.fileName)
      const handle = await open(inspection.filePath, "r")
      try {
        const before = await handle.stat()
        if (!before.isFile() || !fileStatsMatch(inspection.stats, before)) {
          continue
        }
        const truncated = before.size > PREVIEW_COMPLETE_BYTES
        const maximumBytes = truncated
          ? PREVIEW_PREFIX_BYTES
          : PREVIEW_COMPLETE_BYTES
        const bytes = Buffer.allocUnsafe(Math.min(before.size, maximumBytes))
        let bytesRead = 0
        while (bytesRead < bytes.length) {
          const result = await handle.read(
            bytes,
            bytesRead,
            bytes.length - bytesRead,
            bytesRead
          )
          if (result.bytesRead === 0) break
          bytesRead += result.bytesRead
        }
        const after = await handle.stat()
        const finalInspection = await this.inspectFile(entry.fileName)
        if (
          bytesRead !== bytes.length ||
          !fileStatsMatch(before, after) ||
          !fileStatsMatch(after, finalInspection.stats)
        ) {
          continue
        }
        const content = bytes.subarray(0, bytesRead)
        return {
          content: truncated ? utf8SafePrefix(content) : content,
          entry: publicEntry(entry),
          modifiedAt: Math.trunc(after.mtimeMs),
          revision: fileRevision(after),
          truncated,
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    throw new ScratchStoreError(
      `Scratch document ${entry.fileName} changed repeatedly while its preview was read`
    )
  }

  async replace(id: string, content: string | Uint8Array): Promise<void> {
    await this.enqueueMutation(async () => {
      const entry = this.entryById(await this.readCatalog(), id)
      const filePath = await this.validateFile(entry.fileName)
      const mode = (await stat(filePath)).mode & 0o777
      await atomicReplaceBuffer(filePath, contentBuffer(content), mode)
      this.invalidateCaches(id)
    })
  }

  async restoreSnapshot(snapshot: ScratchFileSnapshot): Promise<void> {
    await this.upsertSnapshot(snapshot)
  }

  private async storedSnapshot(
    entry: StoredScratchCatalogEntry
  ): Promise<ScratchFileSnapshot> {
    const filePath = await this.validateFile(entry.fileName)
    const handle = await open(filePath, "r")
    try {
      const fileStats = await handle.stat()
      if (!fileStats.isFile()) {
        throw new ScratchStoreError(
          `Scratch document is not a regular file: ${entry.fileName}`
        )
      }
      return {
        content: await handle.readFile(),
        entry: publicEntry(entry),
        mode: fileStats.mode & 0o777,
        modifiedAt: Math.trunc(fileStats.mtimeMs),
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private async applySnapshotBatch(
    catalog: ScratchCatalogV1,
    snapshots: readonly ScratchFileSnapshot[],
    deleteIds: ReadonlySet<string>
  ): Promise<ScratchCatalogEntry[]> {
    const currentById = new Map(
      catalog.entries.map((entry) => [entry.id, entry])
    )
    const normalizedSnapshots: Array<{
      readonly content: Buffer
      readonly entry: StoredScratchCatalogEntry
      readonly mode: number
      readonly modifiedAt: number
    }> = []
    const snapshotIds = new Set<string>()
    for (const snapshot of snapshots) {
      if (!isScratchIdentifier(snapshot.entry.id)) {
        throw new ScratchStoreError(
          "Cannot restore a snapshot with an invalid id"
        )
      }
      if (snapshotIds.has(snapshot.entry.id)) {
        throw new ScratchStoreError(
          `Cannot restore duplicate scratch ${snapshot.entry.id}`
        )
      }
      snapshotIds.add(snapshot.entry.id)
      const fileName = normalizeScratchFileName(snapshot.entry.fileName)
      if (fileName !== snapshot.entry.fileName) {
        throw new ScratchStoreError(
          "Cannot restore a snapshot with a non-normalized filename"
        )
      }
      const createdAt = normalizedTimestamp(
        snapshot.entry.createdAt,
        "Scratch snapshot creation time"
      )
      const lastOpenedAt =
        snapshot.entry.lastOpenedAt === null
          ? null
          : normalizedTimestamp(
              snapshot.entry.lastOpenedAt,
              "Scratch snapshot opened time"
            )
      const modifiedAt = normalizedTimestamp(
        snapshot.modifiedAt,
        "Scratch snapshot modification time"
      )
      if (
        !Number.isSafeInteger(snapshot.mode) ||
        snapshot.mode < 0 ||
        snapshot.mode > 0o777
      ) {
        throw new ScratchStoreError("Scratch snapshot mode is invalid")
      }
      const title =
        snapshot.entry.title === undefined
          ? undefined
          : normalizedTitle(snapshot.entry.title, "Scratch snapshot title")
      const current = currentById.get(snapshot.entry.id)
      normalizedSnapshots.push({
        content: Buffer.from(snapshot.content),
        entry: {
          createdAt,
          fileName,
          id: snapshot.entry.id,
          lastOpenedAt,
          ...(current?.migratedFrom === undefined
            ? {}
            : { migratedFrom: current.migratedFrom }),
          ...(title === undefined ? {} : { title }),
        },
        mode: snapshot.mode,
        modifiedAt,
      })
    }
    for (const id of deleteIds) {
      if (!isScratchIdentifier(id)) {
        throw new ScratchStoreError(`Cannot delete invalid scratch ${id}`)
      }
      if (snapshotIds.has(id)) {
        throw new ScratchStoreError(
          `Scratch ${id} cannot be restored and deleted in the same batch`
        )
      }
    }

    const replacementById = new Map(
      normalizedSnapshots.map((snapshot) => [snapshot.entry.id, snapshot.entry])
    )
    const finalEntries = catalog.entries
      .filter((entry) => !deleteIds.has(entry.id))
      .map((entry) => replacementById.get(entry.id) ?? entry)
    for (const snapshot of normalizedSnapshots) {
      if (!currentById.has(snapshot.entry.id)) finalEntries.push(snapshot.entry)
    }
    const finalFileNames = new Map<string, string>()
    for (const entry of finalEntries) {
      const key = fileNameIdentity(entry.fileName)
      const existingId = finalFileNames.get(key)
      if (existingId) {
        throw new ScratchStoreError(
          `Scratch filename already exists: ${entry.fileName}`
        )
      }
      finalFileNames.set(key, entry.id)
    }

    await this.ensureDirectory()
    const affectedIds = new Set([...snapshotIds, ...deleteIds])
    const affectedEntries = catalog.entries.filter((entry) =>
      affectedIds.has(entry.id)
    )
    const currentByFileName = new Map(
      catalog.entries.map((entry) => [fileNameIdentity(entry.fileName), entry])
    )
    for (const entry of affectedEntries) {
      await this.validateFile(entry.fileName)
    }
    for (const snapshot of normalizedSnapshots) {
      const owner = currentByFileName.get(
        fileNameIdentity(snapshot.entry.fileName)
      )
      if (owner) continue
      try {
        await lstat(this.filePath(snapshot.entry.fileName))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      throw new ScratchStoreError(
        `Scratch filename already exists: ${snapshot.entry.fileName}`
      )
    }

    if (affectedIds.size === 0) return []
    const transactionId = randomUUID()
    const finalById = new Map(finalEntries.map((entry) => [entry.id, entry]))
    const files = [...affectedIds]
      .sort((left, right) => left.localeCompare(right))
      .map((id): ScratchBatchJournalFile => {
        const originalFileName = currentById.get(id)?.fileName ?? null
        const destinationFileName = finalById.get(id)?.fileName ?? null
        return {
          backupFileName:
            originalFileName === null
              ? null
              : scratchBatchArtifactFileName(transactionId, id, "backup"),
          destinationFileName,
          id,
          originalFileName,
          stageFileName:
            destinationFileName === null
              ? null
              : scratchBatchArtifactFileName(transactionId, id, "stage"),
        }
      })
    let journal: ScratchBatchJournal = {
      files,
      finalCatalog: {
        entries: finalEntries,
        version: SCRATCH_CATALOG_VERSION,
      },
      originalCatalog: catalog,
      phase: "preparing",
      transactionId,
      version: 1,
    }
    let journalCreated = false
    try {
      journalCreated = true
      await this.writeBatchJournal(journal, true)
      for (const snapshot of normalizedSnapshots) {
        const stageFileName = files.find(
          (file) => file.id === snapshot.entry.id
        )!.stageFileName!
        const stagePath = path.join(this.directory, stageFileName)
        await createJournaledBuffer(stagePath, snapshot.content, snapshot.mode)
        const modifiedDate = new Date(snapshot.modifiedAt)
        await utimes(stagePath, modifiedDate, modifiedDate)
        await syncRegularFile(stagePath)
      }
      journal = { ...journal, phase: "prepared" }
      await this.writeBatchJournal(journal, false)

      for (const file of files) {
        if (!file.originalFileName || !file.backupFileName) continue
        await rename(
          path.join(this.directory, file.originalFileName),
          path.join(this.directory, file.backupFileName)
        )
      }
      await syncParentDirectory(this.batchJournalPath)
      journal = { ...journal, phase: "backups-complete" }
      await this.writeBatchJournal(journal, false)

      for (const snapshot of normalizedSnapshots) {
        const stageFileName = files.find(
          (file) => file.id === snapshot.entry.id
        )!.stageFileName!
        const stagePath = path.join(this.directory, stageFileName)
        const destinationPath = this.filePath(snapshot.entry.fileName)
        try {
          await link(stagePath, destinationPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ScratchStoreError(
              `Scratch filename already exists: ${snapshot.entry.fileName}`,
              { cause: error }
            )
          }
          throw error
        }
      }
      await syncParentDirectory(this.batchJournalPath)
      journal = { ...journal, phase: "installed" }
      await this.writeBatchJournal(journal, false)
      await this.writeCatalog(finalEntries)
      await this.finishCommittedBatchJournal(journal)
    } catch (error) {
      if (!journalCreated) throw error
      let recovery: {
        readonly outcome: "committed" | "none" | "rolled-back"
        readonly transactionId: string | null
      }
      try {
        recovery = await this.reconcileBatchJournal()
      } catch (recoveryError) {
        throw new ScratchStoreError(
          "Scratch batch replacement failed and could not fully roll back",
          { cause: new AggregateError([error, recoveryError]) }
        )
      }
      if (
        recovery.outcome !== "committed" ||
        recovery.transactionId !== transactionId
      ) {
        throw error
      }
    }
    for (const id of affectedIds) this.invalidateCaches(id)
    return normalizedSnapshots.map(({ entry }) => publicEntry(entry))
  }

  async upsertSnapshots(
    snapshots: readonly ScratchFileSnapshot[]
  ): Promise<ScratchSnapshotBatchReplacement> {
    const result = await this.enqueueMutation(async () => {
      const catalog = await this.readCatalog()
      const ids = new Set<string>()
      for (const snapshot of snapshots) {
        if (!isScratchIdentifier(snapshot.entry.id)) {
          throw new ScratchStoreError(
            "Cannot restore a snapshot with an invalid id"
          )
        }
        if (ids.has(snapshot.entry.id)) {
          throw new ScratchStoreError(
            `Cannot restore duplicate scratch ${snapshot.entry.id}`
          )
        }
        ids.add(snapshot.entry.id)
      }
      const originals: ScratchFileSnapshot[] = []
      const createdIds = new Set<string>()
      for (const id of ids) {
        const current = catalog.entries.find((entry) => entry.id === id)
        if (current) originals.push(await this.storedSnapshot(current))
        else createdIds.add(id)
      }
      const entries = await this.applySnapshotBatch(
        catalog,
        snapshots,
        new Set()
      )
      return { createdIds, entries, originals }
    })
    let rolledBack = false
    return {
      entries: result.entries,
      rollback: async () => {
        if (rolledBack) return
        await this.enqueueMutation(async () => {
          if (rolledBack) return
          await this.applySnapshotBatch(
            await this.readCatalog(),
            result.originals,
            result.createdIds
          )
          rolledBack = true
        })
      },
    }
  }

  async upsertSnapshot(
    snapshot: ScratchFileSnapshot
  ): Promise<ScratchCatalogEntry> {
    return await this.enqueueMutation(async () => {
      if (!isScratchIdentifier(snapshot.entry.id)) {
        throw new ScratchStoreError(
          "Cannot restore a snapshot with an invalid id"
        )
      }
      const fileName = normalizeScratchFileName(snapshot.entry.fileName)
      if (fileName !== snapshot.entry.fileName) {
        throw new ScratchStoreError(
          "Cannot restore a snapshot with a non-normalized filename"
        )
      }
      const createdAt = normalizedTimestamp(
        snapshot.entry.createdAt,
        "Scratch snapshot creation time"
      )
      const lastOpenedAt =
        snapshot.entry.lastOpenedAt === null
          ? null
          : normalizedTimestamp(
              snapshot.entry.lastOpenedAt,
              "Scratch snapshot opened time"
            )
      const modifiedAt = normalizedTimestamp(
        snapshot.modifiedAt,
        "Scratch snapshot modification time"
      )
      if (
        !Number.isSafeInteger(snapshot.mode) ||
        snapshot.mode < 0 ||
        snapshot.mode > 0o777
      ) {
        throw new ScratchStoreError("Scratch snapshot mode is invalid")
      }
      const title =
        snapshot.entry.title === undefined
          ? undefined
          : normalizedTitle(snapshot.entry.title, "Scratch snapshot title")

      await this.ensureDirectory()
      const catalog = await this.readCatalog()
      const current = catalog.entries.find(
        (entry) => entry.id === snapshot.entry.id
      )
      const duplicateFileName = catalog.entries.find(
        (entry) =>
          entry.id !== snapshot.entry.id &&
          fileNameIdentity(entry.fileName) === fileNameIdentity(fileName)
      )
      if (duplicateFileName) {
        throw new ScratchStoreError(
          `Scratch filename already exists: ${snapshot.entry.fileName}`
        )
      }
      const restored: StoredScratchCatalogEntry = {
        createdAt,
        fileName,
        id: snapshot.entry.id,
        lastOpenedAt,
        ...(current?.migratedFrom === undefined
          ? {}
          : { migratedFrom: current.migratedFrom }),
        ...(title === undefined ? {} : { title }),
      }
      const updatedCatalog = current
        ? catalog.entries.map((entry) =>
            entry.id === restored.id ? restored : entry
          )
        : [...catalog.entries, restored]
      const destinationPath = this.filePath(fileName)
      const modifiedDate = new Date(modifiedAt)

      if (!current) {
        await atomicCreateBuffer(
          destinationPath,
          snapshot.content,
          snapshot.mode
        )
        try {
          await utimes(destinationPath, modifiedDate, modifiedDate)
          await this.writeCatalog(updatedCatalog)
        } catch (error) {
          await unlink(destinationPath).catch(() => undefined)
          throw error
        }
        this.invalidateCaches(restored.id)
        return publicEntry(restored)
      }

      const sourcePath = await this.validateFile(current.fileName)
      let sameFile = sourcePath === destinationPath
      if (!sameFile) {
        try {
          const [sourceStats, destinationStats] = await Promise.all([
            lstat(sourcePath),
            lstat(destinationPath),
          ])
          if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
            throw new ScratchStoreError(
              `Scratch document is not a regular file: ${fileName}`
            )
          }
          sameFile =
            sourceStats.dev === destinationStats.dev &&
            sourceStats.ino === destinationStats.ino
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }

      if (!sameFile) {
        await atomicCreateBuffer(
          destinationPath,
          snapshot.content,
          snapshot.mode
        )
        try {
          await utimes(destinationPath, modifiedDate, modifiedDate)
          await this.writeCatalog(updatedCatalog)
        } catch (error) {
          await unlink(destinationPath).catch(() => undefined)
          throw error
        }
        try {
          await unlink(sourcePath)
        } catch (cleanupError) {
          const rollbackErrors: unknown[] = []
          try {
            await this.writeCatalog(catalog.entries)
          } catch (catalogRollbackError) {
            rollbackErrors.push(catalogRollbackError)
          }
          try {
            await unlink(destinationPath)
          } catch (destinationRollbackError) {
            rollbackErrors.push(destinationRollbackError)
          }
          if (rollbackErrors.length > 0) {
            throw new ScratchStoreError(
              "Scratch filename replacement failed and could not fully roll back",
              {
                cause: new AggregateError([cleanupError, ...rollbackErrors]),
              }
            )
          }
          throw cleanupError
        }
        this.invalidateCaches(restored.id)
        return publicEntry(restored)
      }

      const originalHandle = await open(sourcePath, "r")
      let originalContent: Buffer
      let originalMode: number
      let originalModifiedAt: number
      try {
        const originalStats = await originalHandle.stat()
        originalContent = await originalHandle.readFile()
        originalMode = originalStats.mode & 0o777
        originalModifiedAt = Math.trunc(originalStats.mtimeMs)
      } finally {
        await originalHandle.close().catch(() => undefined)
      }
      await atomicReplaceBuffer(
        destinationPath,
        snapshot.content,
        snapshot.mode
      )
      try {
        await utimes(destinationPath, modifiedDate, modifiedDate)
        await this.writeCatalog(updatedCatalog)
      } catch (error) {
        try {
          await atomicReplaceBuffer(sourcePath, originalContent, originalMode)
          const originalDate = new Date(originalModifiedAt)
          await utimes(sourcePath, originalDate, originalDate)
        } catch (rollbackError) {
          throw new ScratchStoreError(
            "Scratch snapshot restore failed and could not roll back",
            { cause: new AggregateError([error, rollbackError]) }
          )
        }
        throw error
      }
      this.invalidateCaches(restored.id)
      return publicEntry(restored)
    })
  }

  async update(
    id: string,
    options: UpdateScratchOptions
  ): Promise<ScratchCatalogEntry> {
    return await this.enqueueMutation(async () => {
      const catalog = await this.readCatalog()
      const current = this.entryById(catalog, id)
      const currentPath = await this.validateFile(current.fileName)
      const fileName =
        options.fileName === undefined
          ? current.fileName
          : normalizeScratchFileName(options.fileName)
      const duplicate = catalog.entries.find(
        (entry) =>
          entry.id !== id &&
          fileNameIdentity(entry.fileName) === fileNameIdentity(fileName)
      )
      if (duplicate) {
        throw new ScratchStoreError(
          `Scratch filename already exists: ${fileName}`
        )
      }
      const hasTitle = Object.prototype.hasOwnProperty.call(options, "title")
      const title =
        !hasTitle || options.title === null
          ? undefined
          : normalizedTitle(options.title, "Scratch title")
      const updated: StoredScratchCatalogEntry = {
        ...current,
        fileName,
        ...(!hasTitle
          ? current.title === undefined
            ? {}
            : { title: current.title }
          : title === undefined
            ? { title: undefined }
            : { title }),
      }

      if (fileName !== current.fileName) {
        const sourcePath = currentPath
        const destinationPath = this.filePath(fileName)
        const samePortableName =
          fileNameIdentity(fileName) === fileNameIdentity(current.fileName)
        if (samePortableName) {
          try {
            const [sourceStats, destinationStats] = await Promise.all([
              lstat(sourcePath),
              lstat(destinationPath),
            ])
            if (
              !destinationStats.isFile() ||
              destinationStats.isSymbolicLink()
            ) {
              throw new ScratchStoreError(
                `Scratch document is not a regular file: ${fileName}`
              )
            }
            if (
              sourceStats.dev !== destinationStats.dev ||
              sourceStats.ino !== destinationStats.ino
            ) {
              throw new ScratchStoreError(
                `Scratch filename already exists: ${fileName}`
              )
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
          await rename(sourcePath, destinationPath)
          try {
            await this.writeCatalog(
              catalog.entries.map((entry) =>
                entry.id === id ? updated : entry
              )
            )
          } catch (error) {
            await rename(destinationPath, sourcePath).catch(() => undefined)
            throw error
          }
        } else {
          try {
            await link(sourcePath, destinationPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              const [sourceStats, destinationStats] = await Promise.all([
                lstat(sourcePath),
                lstat(destinationPath),
              ])
              if (
                !destinationStats.isFile() ||
                destinationStats.isSymbolicLink()
              ) {
                throw new ScratchStoreError(
                  `Scratch document is not a regular file: ${fileName}`
                )
              }
              if (
                sourceStats.dev !== destinationStats.dev ||
                sourceStats.ino !== destinationStats.ino
              ) {
                throw new ScratchStoreError(
                  `Scratch filename already exists: ${fileName}`,
                  { cause: error }
                )
              }
            } else {
              throw error
            }
          }
          try {
            await this.writeCatalog(
              catalog.entries.map((entry) =>
                entry.id === id ? updated : entry
              )
            )
          } catch (error) {
            await unlink(destinationPath).catch(() => undefined)
            throw error
          }
          try {
            await unlink(sourcePath)
          } catch (cleanupError) {
            const rollbackErrors: unknown[] = []
            try {
              await this.writeCatalog(catalog.entries)
            } catch (catalogRollbackError) {
              rollbackErrors.push(catalogRollbackError)
            }
            try {
              await unlink(destinationPath)
            } catch (destinationRollbackError) {
              rollbackErrors.push(destinationRollbackError)
            }
            if (rollbackErrors.length > 0) {
              throw new ScratchStoreError(
                "Scratch rename failed and could not fully roll back",
                {
                  cause: new AggregateError([cleanupError, ...rollbackErrors]),
                }
              )
            }
            throw cleanupError
          }
        }
      } else {
        await this.writeCatalog(
          catalog.entries.map((entry) => (entry.id === id ? updated : entry))
        )
      }
      this.invalidateCaches(id)
      return publicEntry(updated)
    })
  }

  async markOpened(id: string, openedAt = this.timestamp()): Promise<void> {
    await this.enqueueMutation(async () => {
      const normalized = normalizedTimestamp(openedAt, "Scratch opened time")
      const catalog = await this.readCatalog()
      const entry = this.entryById(catalog, id)
      await this.validateFile(entry.fileName)
      await this.writeCatalog(
        catalog.entries.map((entry) =>
          entry.id === id ? { ...entry, lastOpenedAt: normalized } : entry
        )
      )
    })
  }

  async delete(id: string): Promise<ScratchFileSnapshot> {
    return await this.enqueueMutation(async () => {
      const catalog = await this.readCatalog()
      const entry = this.entryById(catalog, id)
      const filePath = await this.validateFile(entry.fileName)
      const handle = await open(filePath, "r")
      let snapshot: ScratchFileSnapshot
      try {
        const fileStats = await handle.stat()
        snapshot = {
          content: await handle.readFile(),
          entry: publicEntry(entry),
          mode: fileStats.mode & 0o777,
          modifiedAt: Math.trunc(fileStats.mtimeMs),
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
      await this.writeCatalog(
        catalog.entries.filter((candidate) => candidate.id !== id)
      )
      try {
        await unlink(filePath)
      } catch (cleanupError) {
        try {
          await this.writeCatalog(catalog.entries)
        } catch (catalogRollbackError) {
          throw new ScratchStoreError(
            "Scratch deletion failed and could not roll back",
            {
              cause: new AggregateError([cleanupError, catalogRollbackError]),
            }
          )
        }
        throw cleanupError
      }
      this.invalidateCaches(id)
      return snapshot
    })
  }

  private async listInventory(
    searchTerms: readonly string[],
    skipUnavailable: boolean,
    cancelled: () => boolean
  ): Promise<ScratchInventoryEntry[]> {
    await this.waitForMutations()
    if (cancelled()) return []
    const catalog = await this.readCatalog()
    const currentIds = new Set(catalog.entries.map((entry) => entry.id))
    for (const id of this.inventorySummaryCache.keys()) {
      if (!currentIds.has(id)) this.inventorySummaryCache.delete(id)
    }
    const inventory = new Array<ScratchInventoryEntry | null>(
      catalog.entries.length
    ).fill(null)
    let nextIndex = 0
    const readNext = async (): Promise<void> => {
      for (;;) {
        if (cancelled()) return
        const index = nextIndex
        nextIndex += 1
        const entry = catalog.entries[index]
        if (!entry) return
        try {
          const inspection = await this.inspectFile(entry.fileName)
          let fileStats = inspection.stats
          let revision = fileRevision(fileStats)
          let summary = this.inventorySummaryCache.get(entry.id)
          if (
            summary?.fileName !== entry.fileName ||
            summary.revision !== revision
          ) {
            summary = undefined
          }
          if (!summary) {
            const handle = await open(inspection.filePath, "r")
            try {
              const before = await handle.stat()
              if (
                !before.isFile() ||
                !fileStatsMatch(inspection.stats, before)
              ) {
                throw new ScratchStoreError(
                  `Scratch document ${entry.fileName} changed while its inventory was read`
                )
              }
              const prefix = Buffer.allocUnsafe(
                Math.min(before.size, INVENTORY_PREFIX_BYTES)
              )
              let bytesRead = 0
              while (bytesRead < prefix.length) {
                if (cancelled()) return
                const result = await handle.read(
                  prefix,
                  bytesRead,
                  prefix.length - bytesRead,
                  bytesRead
                )
                if (result.bytesRead === 0) break
                bytesRead += result.bytesRead
              }
              const after = await handle.stat()
              const finalInspection = await this.inspectFile(entry.fileName)
              if (
                !fileStatsMatch(before, after) ||
                !fileStatsMatch(after, finalInspection.stats)
              ) {
                throw new ScratchStoreError(
                  `Scratch document ${entry.fileName} changed while its inventory was read`
                )
              }
              fileStats = after
              revision = fileRevision(after)
              const parsed = summarizeScratchMarkdown(
                prefix.subarray(0, bytesRead).toString("utf8")
              )
              summary = {
                excerpt: parsed.excerpt,
                fileName: entry.fileName,
                firstHeading: parsed.firstHeading,
                revision,
              }
              this.inventorySummaryCache.set(entry.id, summary)
            } finally {
              await handle.close().catch(() => undefined)
            }
          }
          if (!summary) {
            throw new ScratchStoreError(
              `Scratch inventory could not summarize ${entry.fileName}`
            )
          }
          if (searchTerms.length > 0) {
            const metadata = foldScratchSearchText(
              [
                entry.title,
                summary.firstHeading,
                entry.fileName,
                summary.excerpt,
              ]
                .filter((value): value is string => typeof value === "string")
                .join("\n")
            )
            const contentTerms = searchTerms.filter(
              (term) => !metadata.includes(term)
            )
            if (contentTerms.length > 0) {
              const handle = await open(inspection.filePath, "r")
              try {
                const before = await handle.stat()
                if (!before.isFile() || !fileStatsMatch(fileStats, before)) {
                  throw new ScratchStoreError(
                    `Scratch document ${entry.fileName} changed while its inventory was read`
                  )
                }
                const matches = await fileHandleContainsTerms(
                  handle,
                  before.size,
                  contentTerms,
                  cancelled
                )
                if (cancelled()) return
                const after = await handle.stat()
                const finalInspection = await this.inspectFile(entry.fileName)
                if (
                  !fileStatsMatch(before, after) ||
                  !fileStatsMatch(after, finalInspection.stats)
                ) {
                  throw new ScratchStoreError(
                    `Scratch document ${entry.fileName} changed while its inventory was read`
                  )
                }
                if (!matches) continue
              } finally {
                await handle.close().catch(() => undefined)
              }
            }
          }
          inventory[index] = {
            ...publicEntry(entry),
            byteLength: fileStats.size,
            excerpt: summary.excerpt,
            firstHeading: summary.firstHeading,
            modifiedAt: Math.trunc(fileStats.mtimeMs),
            path: inspection.filePath,
            revision,
          }
        } catch (error) {
          if (!skipUnavailable) throw error
          this.invalidateCaches(entry.id)
        }
      }
    }
    await Promise.all(
      Array.from(
        {
          length: Math.min(INVENTORY_READ_CONCURRENCY, catalog.entries.length),
        },
        readNext
      )
    )
    if (cancelled()) return []
    return inventory.filter(
      (entry): entry is ScratchInventoryEntry => entry !== null
    )
  }

  async list(): Promise<ScratchInventoryEntry[]> {
    return await this.listInventory([], false, () => false)
  }

  async listAvailable(
    searchTerms: readonly string[] = [],
    options: { readonly cancelled?: () => boolean } = {}
  ): Promise<ScratchInventoryEntry[]> {
    return await this.listInventory(
      searchTerms.map(foldScratchSearchText),
      true,
      options.cancelled ?? (() => false)
    )
  }

  private legacyPath(identity: LegacyScratchIdentity): string {
    const normalized = normalizeLegacyIdentity(
      identity,
      "Legacy scratch identity"
    )
    const namespace = normalized.profileId ?? LEGACY_AD_HOC_SCRATCH_NAMESPACE
    return path.join(this.directory, namespace, `${normalized.tabId}.md`)
  }

  async discoverLegacyScratchIdentities(): Promise<LegacyScratchIdentity[]> {
    await this.waitForMutations()
    let namespaces: Dirent[]
    try {
      namespaces = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const identities: LegacyScratchIdentity[] = []
    for (const namespace of namespaces) {
      if (!namespace.isDirectory()) continue
      const profileId =
        namespace.name === LEGACY_AD_HOC_SCRATCH_NAMESPACE
          ? null
          : isProfileIdentifier(namespace.name)
            ? namespace.name
            : undefined
      if (profileId === undefined) continue
      const namespacePath = path.join(this.directory, namespace.name)
      const entries = await readdir(namespacePath, { withFileTypes: true })
      for (const entry of entries) {
        if (
          entry.isFile() &&
          /^\.[a-z0-9]+(?:-[a-z0-9]+)*\.md\.\d+\.[0-9a-f-]+\.tmp$/.test(
            entry.name
          )
        ) {
          continue
        }
        const tabId = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : ""
        if (!entry.isFile() || !isProfileIdentifier(tabId)) {
          throw new ScratchStoreError(
            `Unexpected entry in legacy scratch storage: ${path.join(
              namespace.name,
              entry.name
            )}`
          )
        }
        identities.push({ profileId, tabId })
      }
    }
    return identities.sort((left, right) =>
      legacyIdentityKey(left).localeCompare(legacyIdentityKey(right))
    )
  }

  /** Internal restart checkpoint reader for the one-time migration. */
  async readLegacyMigrationCheckpoints(): Promise<LegacyScratchIdentity[]> {
    await this.waitForMutations()
    const catalog = await this.readCatalog()
    return catalog.entries.flatMap((entry) =>
      entry.migratedFrom
        ? [
            {
              profileId: entry.migratedFrom.profileId,
              tabId: entry.migratedFrom.tabId,
            },
          ]
        : []
    )
  }

  async migrateLegacyScratches(
    requests: readonly LegacyScratchMigrationRequest[]
  ): Promise<LegacyScratchMigrationResult[]> {
    return await this.enqueueMutation(async () => {
      await this.ensureDirectory()
      const normalizedRequests = requests.map((request, index) => ({
        identity: normalizeLegacyIdentity(
          request.identity,
          `Legacy scratch migration ${index + 1}`
        ),
        ...(request.preferredFileName === undefined
          ? {}
          : { preferredFileName: request.preferredFileName }),
        ...(request.title === undefined
          ? {}
          : { title: normalizedTitle(request.title, "Legacy scratch title") }),
      }))
      const requestKeys = new Set<string>()
      for (const request of normalizedRequests) {
        const key = legacyIdentityKey(request.identity)
        if (requestKeys.has(key)) {
          throw new ScratchStoreError(
            "Legacy scratch migration contains a duplicate identity"
          )
        }
        requestKeys.add(key)
      }

      const catalog = await this.readCatalog()
      const existingByMigration = new Map(
        catalog.entries.flatMap((entry) =>
          entry.migratedFrom
            ? [[legacyIdentityKey(entry.migratedFrom), entry] as const]
            : []
        )
      )
      const entries = [...catalog.entries]
      const createdPaths: string[] = []
      const existingIds = new Set(entries.map((entry) => entry.id))
      const results: LegacyScratchMigrationResult[] = []

      try {
        for (const request of normalizedRequests) {
          const key = legacyIdentityKey(request.identity)
          const existing = existingByMigration.get(key)
          const sourcePath = this.legacyPath(request.identity)
          let sourceExisted = false
          let sourceContent = Buffer.alloc(0)
          let sourceMode = 0o600
          let sourceCreatedAt: number | null = null
          try {
            const sourceEntry = await lstat(sourcePath)
            if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
              throw new ScratchStoreError(
                `Legacy scratch is not a regular file: ${sourcePath}`
              )
            }
            sourceExisted = true
            const handle = await open(sourcePath, "r")
            try {
              const sourceStats = await handle.stat()
              sourceContent = await handle.readFile()
              sourceMode = sourceStats.mode & 0o777
              const createdTime =
                sourceStats.birthtimeMs > 0
                  ? sourceStats.birthtime
                  : sourceStats.mtime
              sourceCreatedAt = createdTime.getTime()
            } finally {
              await handle.close().catch(() => undefined)
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }

          if (existing) {
            await this.validateFile(existing.fileName)
            results.push({
              fileName: existing.fileName,
              identity: request.identity,
              scratchId: existing.id,
              sourceExisted,
            })
            continue
          }

          const preferredFileName =
            request.preferredFileName ??
            (request.identity.profileId === null
              ? `${request.identity.tabId}.md`
              : `${request.identity.profileId}-${request.identity.tabId}.md`)
          const fileName = await this.uniqueFileName(preferredFileName, entries)
          const id = this.nextId(existingIds)
          existingIds.add(id)
          const entry: StoredScratchCatalogEntry = {
            createdAt: sourceCreatedAt ?? this.timestamp(),
            fileName,
            id,
            lastOpenedAt: null,
            migratedFrom: request.identity,
            ...(request.title === undefined ? {} : { title: request.title }),
          }
          const destinationPath = this.filePath(fileName)
          await atomicCreateBuffer(destinationPath, sourceContent, sourceMode)
          createdPaths.push(destinationPath)
          entries.push(entry)
          existingByMigration.set(key, entry)
          results.push({
            fileName,
            identity: request.identity,
            scratchId: id,
            sourceExisted,
          })
        }
        if (entries.length !== catalog.entries.length) {
          await this.writeCatalog(entries)
        }
      } catch (error) {
        await Promise.all(
          createdPaths.map((filePath) =>
            unlink(filePath).catch(() => undefined)
          )
        )
        throw error
      }
      return results
    })
  }

  async finalizeLegacyMigration(
    identities: readonly LegacyScratchIdentity[]
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      const catalog = await this.readCatalog()
      const migrated = new Set(
        catalog.entries.flatMap((entry) =>
          entry.migratedFrom ? [legacyIdentityKey(entry.migratedFrom)] : []
        )
      )
      const normalized = identities.map((identity, index) =>
        normalizeLegacyIdentity(identity, `Legacy scratch cleanup ${index + 1}`)
      )
      const cleanupKeys = new Set(normalized.map(legacyIdentityKey))
      const omittedCheckpoint = catalog.entries.find(
        (entry) =>
          entry.migratedFrom &&
          !cleanupKeys.has(legacyIdentityKey(entry.migratedFrom))
      )
      if (omittedCheckpoint) {
        throw new ScratchStoreError(
          "Legacy scratch cleanup omitted a cataloged migration"
        )
      }
      for (const identity of normalized) {
        if (!migrated.has(legacyIdentityKey(identity))) {
          throw new ScratchStoreError(
            "Refusing to remove a legacy scratch before it is cataloged"
          )
        }
      }
      for (const identity of normalized) {
        const sourcePath = this.legacyPath(identity)
        try {
          const entry = await lstat(sourcePath)
          if (entry.isSymbolicLink() || !entry.isFile()) {
            throw new ScratchStoreError(
              `Legacy scratch is not a regular file: ${sourcePath}`
            )
          }
          await unlink(sourcePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        try {
          await rmdir(path.dirname(sourcePath))
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
            throw error
          }
        }
      }
      await this.writeCatalog(catalog.entries.map(publicEntry))
    })
  }
}
