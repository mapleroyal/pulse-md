import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"

import { type Entry, fromBufferPromise } from "yauzl"
import { ZipFile } from "yazl"

import { isProfileIdentifier } from "../src/shared/profile-identifiers"

export const SETTINGS_ARCHIVE_FORMAT = "pulse-md-settings-archive" as const
export const SETTINGS_ARCHIVE_VERSION = 1 as const

export const MAX_SETTINGS_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_SETTINGS_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_SETTINGS_ARCHIVE_PROFILES = 1_000
export const MAX_SETTINGS_ARCHIVE_SCRATCHES = 10_000
export const MAX_SETTINGS_ARCHIVE_ENTRIES =
  MAX_SETTINGS_ARCHIVE_PROFILES + MAX_SETTINGS_ARCHIVE_SCRATCHES + 2
export const MAX_SETTINGS_ARCHIVE_COMPRESSION_RATIO = 200

const MAX_ARCHIVE_PATH_BYTES = 1_024
const MAX_SCRATCH_FILE_NAME_BYTES = 255
const MAX_SCRATCH_TITLE_LENGTH = 256
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u
const SCRATCH_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const WINDOWS_FORBIDDEN_FILE_NAME_PATTERN = /[<>:"/\\|?*\p{Cc}]/u
const WINDOWS_RESERVED_FILE_STEM_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu
const ZIP_SIGNATURES = new Set([0x04034b50, 0x06054b50, 0x08074b50])
const ZIP_TIMESTAMP = new Date(1980, 0, 1)
const ZIP_FILE_MODE = 0o100600

type UnknownRecord = Record<string, unknown>

export interface SettingsArchiveProfileInput {
  readonly id: string
  readonly data: unknown
}

export interface SettingsArchiveScratchInput {
  readonly id: string
  readonly fileName: string
  readonly title: string | null
  readonly createdAt: number
  readonly modifiedAt: number
  readonly lastOpenedAt: number | null
  readonly content: Uint8Array
}

export interface CreateSettingsArchiveInput {
  readonly settings: unknown
  readonly profiles?: readonly SettingsArchiveProfileInput[]
  readonly scratches?: readonly SettingsArchiveScratchInput[]
}

export interface SettingsArchivePayloadDescriptor {
  readonly path: string
  readonly sha256: string
}

export interface SettingsArchiveProfileDescriptor extends SettingsArchivePayloadDescriptor {
  readonly id: string
}

export interface SettingsArchiveScratchDescriptor extends SettingsArchivePayloadDescriptor {
  readonly id: string
  readonly fileName: string
  readonly title: string | null
  readonly createdAt: number
  readonly modifiedAt: number
  readonly lastOpenedAt: number | null
}

export interface SettingsArchiveManifestV1 {
  readonly format: typeof SETTINGS_ARCHIVE_FORMAT
  readonly version: typeof SETTINGS_ARCHIVE_VERSION
  readonly settings: SettingsArchivePayloadDescriptor
  readonly profiles: readonly SettingsArchiveProfileDescriptor[]
  readonly scratches: readonly SettingsArchiveScratchDescriptor[]
}

export interface ParsedSettingsArchiveProfile {
  readonly id: string
  readonly data: UnknownRecord
}

export interface ParsedSettingsArchiveScratch {
  readonly id: string
  readonly fileName: string
  readonly title: string | null
  readonly createdAt: number
  readonly modifiedAt: number
  readonly lastOpenedAt: number | null
  readonly content: Buffer
}

export interface ParsedSettingsArchive {
  readonly manifest: SettingsArchiveManifestV1
  readonly settings: UnknownRecord
  readonly profiles: readonly ParsedSettingsArchiveProfile[]
  readonly scratches: readonly ParsedSettingsArchiveScratch[]
}

export class SettingsArchiveError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SettingsArchiveError"
  }
}

interface BufferedArchiveEntry {
  readonly entry: Entry
  readonly path: string
}

interface WritableArchiveEntry {
  readonly path: string
  readonly content: Buffer
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, schemaPath: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new SettingsArchiveError(`${schemaPath} must be an object`)
  }
  return value
}

function assertExactKeys(
  value: UnknownRecord,
  schemaPath: string,
  requiredKeys: readonly string[]
): void {
  const required = new Set(requiredKeys)
  const unsupportedKey = Object.keys(value).find((key) => !required.has(key))
  if (unsupportedKey !== undefined) {
    throw new SettingsArchiveError(
      `${schemaPath}.${unsupportedKey} is not a supported property`
    )
  }
  const missingKey = requiredKeys.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key)
  )
  if (missingKey !== undefined) {
    throw new SettingsArchiveError(`${schemaPath}.${missingKey} is required`)
  }
}

function canonicalKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US")
}

function assertUnique(
  seen: Set<string>,
  value: string,
  description: string
): void {
  const key = canonicalKey(value)
  if (seen.has(key)) {
    throw new SettingsArchiveError(
      `Settings archive contains duplicate ${description}`
    )
  }
  seen.add(key)
}

function normalizedScratchId(value: unknown, schemaPath: string): string {
  if (typeof value !== "string" || !SCRATCH_IDENTIFIER_PATTERN.test(value)) {
    throw new SettingsArchiveError(`${schemaPath} must be a scratch UUID`)
  }
  return value
}

function normalizedProfileId(value: unknown, schemaPath: string): string {
  if (!isProfileIdentifier(value)) {
    throw new SettingsArchiveError(
      `${schemaPath} is not a valid profile identifier`
    )
  }
  return value
}

function normalizedScratchFileName(value: unknown, schemaPath: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > MAX_SCRATCH_FILE_NAME_BYTES ||
    WINDOWS_FORBIDDEN_FILE_NAME_PATTERN.test(value) ||
    !value.endsWith(".md")
  ) {
    throw new SettingsArchiveError(
      `${schemaPath} must be a portable Markdown file name`
    )
  }
  const stem = value.slice(0, -3)
  if (
    stem.length === 0 ||
    stem === "." ||
    stem === ".." ||
    stem.endsWith(".") ||
    stem.endsWith(" ")
  ) {
    throw new SettingsArchiveError(
      `${schemaPath} must be a portable Markdown file name`
    )
  }
  if (WINDOWS_RESERVED_FILE_STEM_PATTERN.test(stem.split(".", 1)[0]!)) {
    throw new SettingsArchiveError(
      `${schemaPath} must not use a reserved Windows file name`
    )
  }
  return value
}

function normalizedTitle(value: unknown, schemaPath: string): string | null {
  if (value === null) return null
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SCRATCH_TITLE_LENGTH ||
    value !== value.normalize("NFC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new SettingsArchiveError(
      `${schemaPath} must be null or a nonempty title of at most ${MAX_SCRATCH_TITLE_LENGTH} characters`
    )
  }
  return value
}

function normalizedTimestamp(value: unknown, schemaPath: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SettingsArchiveError(
      `${schemaPath} must be a nonnegative epoch-millisecond timestamp`
    )
  }
  return value as number
}

function normalizedNullableTimestamp(
  value: unknown,
  schemaPath: string
): number | null {
  return value === null ? null : normalizedTimestamp(value, schemaPath)
}

function normalizedSha256(value: unknown, schemaPath: string): string {
  if (typeof value !== "string" || !SHA_256_PATTERN.test(value)) {
    throw new SettingsArchiveError(
      `${schemaPath} must be a lowercase SHA-256 digest`
    )
  }
  return value
}

function validateArchivePath(value: string): void {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > MAX_ARCHIVE_PATH_BYTES ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /\p{Cc}/u.test(value) ||
    value.endsWith("/")
  ) {
    throw new SettingsArchiveError(
      `Settings archive contains unsafe path ${JSON.stringify(value)}`
    )
  }
  const segments = value.split("/")
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new SettingsArchiveError(
      `Settings archive contains unsafe path ${JSON.stringify(value)}`
    )
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

function serializeJsonObject(value: unknown, description: string): Buffer {
  if (!isRecord(value)) {
    throw new SettingsArchiveError(`${description} must be an object`)
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch (error) {
    throw new SettingsArchiveError(`${description} is not JSON serializable`, {
      cause: error,
    })
  }
  return Buffer.from(`${serialized}\n`, "utf8")
}

function parseJsonObject(content: Buffer, description: string): UnknownRecord {
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch (error) {
    throw new SettingsArchiveError(`${description} is not valid UTF-8`, {
      cause: error,
    })
  }
  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch (error) {
    throw new SettingsArchiveError(`${description} is not valid JSON`, {
      cause: error,
    })
  }
  return assertRecord(value, description)
}

function assertValidUtf8(content: Buffer, description: string): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch (error) {
    throw new SettingsArchiveError(`${description} is not valid UTF-8`, {
      cause: error,
    })
  }
}

function assertEntrySize(content: Uint8Array, description: string): void {
  if (content.byteLength > MAX_SETTINGS_ARCHIVE_ENTRY_BYTES) {
    throw new SettingsArchiveError(
      `${description} exceeds the ${MAX_SETTINGS_ARCHIVE_ENTRY_BYTES}-byte entry limit`
    )
  }
}

function accountUncompressedBytes(
  total: number,
  content: Uint8Array,
  description: string
): number {
  assertEntrySize(content, description)
  const nextTotal = total + content.byteLength
  if (nextTotal > MAX_SETTINGS_ARCHIVE_BYTES) {
    throw new SettingsArchiveError(
      `Settings archive exceeds the ${MAX_SETTINGS_ARCHIVE_BYTES}-byte uncompressed limit`
    )
  }
  return nextTotal
}

function comparePortableStrings(left: string, right: string): number {
  const normalizedLeft = canonicalKey(left)
  const normalizedRight = canonicalKey(right)
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizedPayloadDescriptor(
  value: unknown,
  schemaPath: string
): SettingsArchivePayloadDescriptor {
  const candidate = assertRecord(value, schemaPath)
  assertExactKeys(candidate, schemaPath, ["path", "sha256"])
  if (candidate.path !== "settings.json") {
    throw new SettingsArchiveError(
      `${schemaPath}.path must equal settings.json`
    )
  }
  return {
    path: candidate.path,
    sha256: normalizedSha256(candidate.sha256, `${schemaPath}.sha256`),
  }
}

function normalizedProfileDescriptor(
  value: unknown,
  index: number
): SettingsArchiveProfileDescriptor {
  const schemaPath = `manifest.profiles[${index}]`
  const candidate = assertRecord(value, schemaPath)
  assertExactKeys(candidate, schemaPath, ["id", "path", "sha256"])
  const id = normalizedProfileId(candidate.id, `${schemaPath}.id`)
  const expectedPath = `profiles/${id}.json`
  if (candidate.path !== expectedPath) {
    throw new SettingsArchiveError(
      `${schemaPath}.path must equal ${expectedPath}`
    )
  }
  return {
    id,
    path: expectedPath,
    sha256: normalizedSha256(candidate.sha256, `${schemaPath}.sha256`),
  }
}

function normalizedScratchDescriptor(
  value: unknown,
  index: number
): SettingsArchiveScratchDescriptor {
  const schemaPath = `manifest.scratches[${index}]`
  const candidate = assertRecord(value, schemaPath)
  assertExactKeys(candidate, schemaPath, [
    "id",
    "path",
    "fileName",
    "title",
    "createdAt",
    "modifiedAt",
    "lastOpenedAt",
    "sha256",
  ])
  const id = normalizedScratchId(candidate.id, `${schemaPath}.id`)
  const fileName = normalizedScratchFileName(
    candidate.fileName,
    `${schemaPath}.fileName`
  )
  const expectedPath = `scratches/${fileName}`
  if (candidate.path !== expectedPath) {
    throw new SettingsArchiveError(
      `${schemaPath}.path must equal ${expectedPath}`
    )
  }
  return {
    id,
    path: expectedPath,
    fileName,
    title: normalizedTitle(candidate.title, `${schemaPath}.title`),
    createdAt: normalizedTimestamp(
      candidate.createdAt,
      `${schemaPath}.createdAt`
    ),
    modifiedAt: normalizedTimestamp(
      candidate.modifiedAt,
      `${schemaPath}.modifiedAt`
    ),
    lastOpenedAt: normalizedNullableTimestamp(
      candidate.lastOpenedAt,
      `${schemaPath}.lastOpenedAt`
    ),
    sha256: normalizedSha256(candidate.sha256, `${schemaPath}.sha256`),
  }
}

function normalizedManifest(value: unknown): SettingsArchiveManifestV1 {
  const candidate = assertRecord(value, "manifest")
  assertExactKeys(candidate, "manifest", [
    "format",
    "version",
    "settings",
    "profiles",
    "scratches",
  ])
  if (candidate.format !== SETTINGS_ARCHIVE_FORMAT) {
    throw new SettingsArchiveError("This is not a Pulse MD settings archive")
  }
  if (candidate.version !== SETTINGS_ARCHIVE_VERSION) {
    throw new SettingsArchiveError(
      "This Pulse MD settings archive version is unsupported"
    )
  }
  if (!Array.isArray(candidate.profiles)) {
    throw new SettingsArchiveError("manifest.profiles must be an array")
  }
  if (!Array.isArray(candidate.scratches)) {
    throw new SettingsArchiveError("manifest.scratches must be an array")
  }
  if (candidate.profiles.length > MAX_SETTINGS_ARCHIVE_PROFILES) {
    throw new SettingsArchiveError(
      "Settings archive contains too many profiles"
    )
  }
  if (candidate.scratches.length > MAX_SETTINGS_ARCHIVE_SCRATCHES) {
    throw new SettingsArchiveError(
      "Settings archive contains too many scratches"
    )
  }

  const profiles = candidate.profiles.map(normalizedProfileDescriptor)
  const scratches = candidate.scratches.map(normalizedScratchDescriptor)
  const profileIds = new Set<string>()
  const scratchIds = new Set<string>()
  const paths = new Set<string>()
  paths.add(canonicalKey("manifest.json"))
  const settings = normalizedPayloadDescriptor(
    candidate.settings,
    "manifest.settings"
  )
  assertUnique(paths, settings.path, "manifest path")
  for (const profile of profiles) {
    assertUnique(profileIds, profile.id, "profile id")
    assertUnique(paths, profile.path, "manifest path")
  }
  for (const scratch of scratches) {
    assertUnique(scratchIds, scratch.id, "scratch id")
    assertUnique(paths, scratch.path, "manifest path")
  }

  return {
    format: SETTINGS_ARCHIVE_FORMAT,
    version: SETTINGS_ARCHIVE_VERSION,
    settings,
    profiles,
    scratches,
  }
}

function isSymlink(entry: Entry): boolean {
  const hostSystem = entry.versionMadeBy >>> 8
  if (hostSystem !== 3) return false
  const mode = entry.externalFileAttributes >>> 16
  return (mode & 0o170000) === 0o120000
}

function validateCentralDirectoryEntry(entry: Entry): void {
  validateArchivePath(entry.fileName)
  if ((entry.generalPurposeBitFlag & (0x1 | 0x40 | 0x2000)) !== 0) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} is encrypted`
    )
  }
  if ((entry.generalPurposeBitFlag & 0x800) === 0) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} does not use a UTF-8 path`
    )
  }
  if (
    new TextDecoder("utf-8", { fatal: true }).decode(entry.fileNameRaw) !==
    entry.fileName
  ) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} has an invalid UTF-8 path`
    )
  }
  if (entry.fileComment.length > 0) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} has an unsupported comment`
    )
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} uses an unsupported compression method`
    )
  }
  if (isSymlink(entry)) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} must not be a symbolic link`
    )
  }
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    !Number.isSafeInteger(entry.compressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize > MAX_SETTINGS_ARCHIVE_ENTRY_BYTES ||
    entry.compressedSize > MAX_SETTINGS_ARCHIVE_ENTRY_BYTES
  ) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} has an invalid size`
    )
  }
  if (
    entry.uncompressedSize > 0 &&
    entry.uncompressedSize / Math.max(1, entry.compressedSize) >
      MAX_SETTINGS_ARCHIVE_COMPRESSION_RATIO
  ) {
    throw new SettingsArchiveError(
      `Settings archive entry ${entry.fileName} exceeds the compression ratio limit`
    )
  }
}

async function readArchiveEntry(
  zipFile: Awaited<ReturnType<typeof fromBufferPromise>>,
  bufferedEntry: BufferedArchiveEntry
): Promise<Buffer> {
  const stream = await zipFile.openReadStreamPromise(bufferedEntry.entry)
  const chunks: Buffer[] = []
  let bytesRead = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytesRead += buffer.byteLength
    if (
      bytesRead > bufferedEntry.entry.uncompressedSize ||
      bytesRead > MAX_SETTINGS_ARCHIVE_ENTRY_BYTES
    ) {
      throw new SettingsArchiveError(
        `Settings archive entry ${bufferedEntry.path} expanded beyond its declared size`
      )
    }
    chunks.push(buffer)
  }
  if (bytesRead !== bufferedEntry.entry.uncompressedSize) {
    throw new SettingsArchiveError(
      `Settings archive entry ${bufferedEntry.path} did not match its declared size`
    )
  }
  return Buffer.concat(chunks, bytesRead)
}

function assertHash(
  content: Buffer,
  expectedHash: string,
  archivePath: string
): void {
  if (sha256(content) !== expectedHash) {
    throw new SettingsArchiveError(
      `Settings archive entry ${archivePath} does not match its SHA-256 digest`
    )
  }
}

async function zipEntries(
  entries: readonly WritableArchiveEntry[]
): Promise<Buffer> {
  const zipFile = new ZipFile()
  for (const entry of entries) {
    zipFile.addBuffer(entry.content, entry.path, {
      // STORE keeps export behavior bounded without a second compression pass.
      compress: false,
      forceDosTimestamp: true,
      mode: ZIP_FILE_MODE,
      mtime: ZIP_TIMESTAMP,
    })
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const output = zipFile.outputStream
    output.on("data", (chunk: Buffer) => {
      if (settled) return
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_SETTINGS_ARCHIVE_BYTES) {
        settled = true
        reject(
          new SettingsArchiveError(
            `Settings archive exceeds the ${MAX_SETTINGS_ARCHIVE_BYTES}-byte archive limit`
          )
        )
        return
      }
      chunks.push(chunk)
    })
    output.once("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    output.once("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, totalBytes))
    })
    zipFile.end({ comment: "", forceZip64Format: false })
  })
}

export function isSettingsArchive(value: Uint8Array): boolean {
  if (value.byteLength < 4) return false
  const signature =
    value[0]! | (value[1]! << 8) | (value[2]! << 16) | (value[3]! << 24)
  return ZIP_SIGNATURES.has(signature >>> 0)
}

export async function createSettingsArchive(
  input: CreateSettingsArchiveInput
): Promise<Buffer> {
  const profiles = [...(input.profiles ?? [])]
  const scratches = [...(input.scratches ?? [])]
  if (profiles.length > MAX_SETTINGS_ARCHIVE_PROFILES) {
    throw new SettingsArchiveError(
      "Settings archive contains too many profiles"
    )
  }
  if (scratches.length > MAX_SETTINGS_ARCHIVE_SCRATCHES) {
    throw new SettingsArchiveError(
      "Settings archive contains too many scratches"
    )
  }

  const profileIds = new Set<string>()
  const scratchIds = new Set<string>()
  const paths = new Set<string>()
  paths.add(canonicalKey("manifest.json"))

  const settingsContent = serializeJsonObject(input.settings, "Settings")
  let totalUncompressedBytes = accountUncompressedBytes(
    0,
    settingsContent,
    "Settings"
  )
  const settingsDescriptor: SettingsArchivePayloadDescriptor = {
    path: "settings.json",
    sha256: sha256(settingsContent),
  }
  assertUnique(paths, settingsDescriptor.path, "archive path")

  const profileResources = profiles.map((profile, index) => {
    const id = normalizedProfileId(profile.id, `profiles[${index}].id`)
    assertUnique(profileIds, id, "profile id")
    const content = serializeJsonObject(profile.data, `Profile ${id}`)
    if ((profile.data as UnknownRecord).id !== id) {
      throw new SettingsArchiveError(`Profile ${id} data has a mismatched id`)
    }
    totalUncompressedBytes = accountUncompressedBytes(
      totalUncompressedBytes,
      content,
      `Profile ${id}`
    )
    const descriptor: SettingsArchiveProfileDescriptor = {
      id,
      path: `profiles/${id}.json`,
      sha256: sha256(content),
    }
    assertUnique(paths, descriptor.path, "archive path")
    return { content, descriptor }
  })

  const scratchResources = scratches.map((scratch, index) => {
    const id = normalizedScratchId(scratch.id, `scratches[${index}].id`)
    assertUnique(scratchIds, id, "scratch id")
    const fileName = normalizedScratchFileName(
      scratch.fileName,
      `scratches[${index}].fileName`
    )
    if (!(scratch.content instanceof Uint8Array)) {
      throw new SettingsArchiveError(
        `scratches[${index}].content must be binary data`
      )
    }
    totalUncompressedBytes = accountUncompressedBytes(
      totalUncompressedBytes,
      scratch.content,
      `Scratch ${id}`
    )
    const content = Buffer.from(scratch.content)
    assertValidUtf8(
      content,
      `Scratch ${JSON.stringify(fileName)} cannot be exported because it`
    )
    const descriptor: SettingsArchiveScratchDescriptor = {
      id,
      path: `scratches/${fileName}`,
      fileName,
      title: normalizedTitle(scratch.title, `scratches[${index}].title`),
      createdAt: normalizedTimestamp(
        scratch.createdAt,
        `scratches[${index}].createdAt`
      ),
      modifiedAt: normalizedTimestamp(
        scratch.modifiedAt,
        `scratches[${index}].modifiedAt`
      ),
      lastOpenedAt: normalizedNullableTimestamp(
        scratch.lastOpenedAt,
        `scratches[${index}].lastOpenedAt`
      ),
      sha256: sha256(content),
    }
    assertUnique(paths, descriptor.path, "archive path")
    return { content, descriptor }
  })

  profileResources.sort((left, right) =>
    comparePortableStrings(left.descriptor.id, right.descriptor.id)
  )
  scratchResources.sort(
    (left, right) =>
      comparePortableStrings(
        left.descriptor.fileName,
        right.descriptor.fileName
      ) || comparePortableStrings(left.descriptor.id, right.descriptor.id)
  )

  const manifest: SettingsArchiveManifestV1 = {
    format: SETTINGS_ARCHIVE_FORMAT,
    version: SETTINGS_ARCHIVE_VERSION,
    settings: settingsDescriptor,
    profiles: profileResources.map(({ descriptor }) => descriptor),
    scratches: scratchResources.map(({ descriptor }) => descriptor),
  }
  const manifestContent = serializeJsonObject(manifest, "Manifest")
  accountUncompressedBytes(totalUncompressedBytes, manifestContent, "Manifest")

  const writableEntries: WritableArchiveEntry[] = [
    { path: "manifest.json", content: manifestContent },
    { path: settingsDescriptor.path, content: settingsContent },
    ...profileResources.map(({ content, descriptor }) => ({
      path: descriptor.path,
      content,
    })),
    ...scratchResources.map(({ content, descriptor }) => ({
      path: descriptor.path,
      content,
    })),
  ]
  return await zipEntries(writableEntries)
}

async function parseSettingsArchiveInternal(
  archiveBytes: Buffer
): Promise<ParsedSettingsArchive> {
  if (archiveBytes.byteLength > MAX_SETTINGS_ARCHIVE_BYTES) {
    throw new SettingsArchiveError(
      `Settings archive exceeds the ${MAX_SETTINGS_ARCHIVE_BYTES}-byte archive limit`
    )
  }
  if (!isSettingsArchive(archiveBytes)) {
    throw new SettingsArchiveError("This is not a ZIP settings archive")
  }

  const zipFile = await fromBufferPromise(archiveBytes, {
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  if (zipFile.comment.length > 0) {
    throw new SettingsArchiveError("Settings archive comments are unsupported")
  }
  if (zipFile.entryCount > MAX_SETTINGS_ARCHIVE_ENTRIES) {
    throw new SettingsArchiveError("Settings archive contains too many entries")
  }

  const entries = new Map<string, BufferedArchiveEntry>()
  const canonicalPaths = new Set<string>()
  let totalUncompressedBytes = 0
  // Establish the complete declared budget before inflating even the manifest.
  for await (const entry of zipFile.eachEntry()) {
    assertUnique(canonicalPaths, entry.fileName, "archive path")
    validateCentralDirectoryEntry(entry)
    totalUncompressedBytes += entry.uncompressedSize
    if (totalUncompressedBytes > MAX_SETTINGS_ARCHIVE_BYTES) {
      throw new SettingsArchiveError(
        `Settings archive exceeds the ${MAX_SETTINGS_ARCHIVE_BYTES}-byte uncompressed limit`
      )
    }
    entries.set(entry.fileName, { entry, path: entry.fileName })
  }

  const manifestEntry = entries.get("manifest.json")
  if (manifestEntry === undefined) {
    throw new SettingsArchiveError("Settings archive is missing manifest.json")
  }
  const manifestContent = await readArchiveEntry(zipFile, manifestEntry)
  const manifest = normalizedManifest(
    parseJsonObject(manifestContent, "manifest.json")
  )

  const expectedPaths = new Set<string>([
    "manifest.json",
    manifest.settings.path,
    ...manifest.profiles.map((profile) => profile.path),
    ...manifest.scratches.map((scratch) => scratch.path),
  ])
  const unlistedPath = [...entries.keys()].find(
    (archivePath) => !expectedPaths.has(archivePath)
  )
  if (unlistedPath !== undefined) {
    throw new SettingsArchiveError(
      `Settings archive contains unlisted entry ${unlistedPath}`
    )
  }
  const missingPath = [...expectedPaths].find(
    (archivePath) => !entries.has(archivePath)
  )
  if (missingPath !== undefined) {
    throw new SettingsArchiveError(
      `Settings archive is missing listed entry ${missingPath}`
    )
  }

  const settingsContent = await readArchiveEntry(
    zipFile,
    entries.get(manifest.settings.path)!
  )
  assertHash(settingsContent, manifest.settings.sha256, manifest.settings.path)
  const settings = parseJsonObject(settingsContent, manifest.settings.path)

  const parsedProfiles: ParsedSettingsArchiveProfile[] = []
  for (const profile of manifest.profiles) {
    const content = await readArchiveEntry(zipFile, entries.get(profile.path)!)
    assertHash(content, profile.sha256, profile.path)
    const data = parseJsonObject(content, profile.path)
    if (data.id !== profile.id) {
      throw new SettingsArchiveError(
        `Settings archive profile ${profile.path} has a mismatched id`
      )
    }
    parsedProfiles.push({ id: profile.id, data })
  }

  const parsedScratches: ParsedSettingsArchiveScratch[] = []
  for (const scratch of manifest.scratches) {
    const content = await readArchiveEntry(zipFile, entries.get(scratch.path)!)
    assertHash(content, scratch.sha256, scratch.path)
    assertValidUtf8(content, scratch.path)
    parsedScratches.push({
      id: scratch.id,
      fileName: scratch.fileName,
      title: scratch.title,
      createdAt: scratch.createdAt,
      modifiedAt: scratch.modifiedAt,
      lastOpenedAt: scratch.lastOpenedAt,
      content,
    })
  }

  return {
    manifest,
    settings,
    profiles: parsedProfiles,
    scratches: parsedScratches,
  }
}

export async function parseSettingsArchive(
  value: Uint8Array
): Promise<ParsedSettingsArchive> {
  if (!(value instanceof Uint8Array)) {
    throw new SettingsArchiveError("Settings archive must be binary data")
  }
  if (value.byteLength > MAX_SETTINGS_ARCHIVE_BYTES) {
    throw new SettingsArchiveError(
      `Settings archive exceeds the ${MAX_SETTINGS_ARCHIVE_BYTES}-byte archive limit`
    )
  }
  const archiveBytes = Buffer.from(value)
  try {
    return await parseSettingsArchiveInternal(archiveBytes)
  } catch (error) {
    if (error instanceof SettingsArchiveError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SettingsArchiveError(`Invalid settings archive: ${message}`, {
      cause: error,
    })
  }
}
