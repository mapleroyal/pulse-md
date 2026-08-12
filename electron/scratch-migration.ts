import { parser as markdownParser } from "@lezer/markdown"

import { isProfileIdentifier } from "../src/shared/profile-identifiers"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"
import {
  parseScratchLinkAddress,
  scratchLinkAddress,
  type ScratchLinkScheme,
} from "../src/shared/scratch-links"
import { legacyScratchIdentityKey, type ProfileStore } from "./profile-store"
import {
  type LegacyScratchIdentity,
  type LegacyScratchMigrationRequest,
  type LegacyScratchMigrationResult,
  type ScratchStore,
} from "./scratch-store"

export interface StandaloneScratchMigrationResult {
  readonly migratedProfileIds: readonly string[]
  readonly scratchIds: readonly string[]
  readonly status: "already-complete" | "migrated"
}

interface MarkdownReplacement {
  readonly from: number
  readonly to: number
  readonly value: string
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function legacyScratchLinkIdentity(destination: string): {
  readonly fragmentSuffix: string
  readonly identity: LegacyScratchIdentity
} | null {
  const hashIndex = destination.indexOf("#")
  const address = hashIndex < 0 ? destination : destination.slice(0, hashIndex)
  if (address.includes("?")) return null
  let parsed: URL
  try {
    parsed = new URL(destination)
  } catch {
    return null
  }
  if (
    parsed.protocol !== "pulse-md:" ||
    parsed.hostname !== "scratch" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== ""
  ) {
    return null
  }
  const components = parsed.pathname.split("/")
  let identity: LegacyScratchIdentity
  if (
    components.length === 3 &&
    components[0] === "" &&
    components[1] === "ad-hoc"
  ) {
    const tabId = decodedPathSegment(components[2]!)
    if (!isProfileIdentifier(tabId)) return null
    identity = { profileId: null, tabId }
  } else if (
    components.length === 4 &&
    components[0] === "" &&
    components[1] === "profile"
  ) {
    const profileId = decodedPathSegment(components[2]!)
    const tabId = decodedPathSegment(components[3]!)
    if (!isProfileIdentifier(profileId) || !isProfileIdentifier(tabId)) {
      return null
    }
    identity = { profileId, tabId }
  } else {
    return null
  }
  return {
    fragmentSuffix: hashIndex < 0 ? "" : destination.slice(hashIndex),
    identity,
  }
}

/** Rewrites only parser-recognized Markdown URL nodes, preserving other bytes. */
export function rewriteLegacyScratchMarkdownLinks(
  content: Buffer,
  scratchIdByLegacyIdentity: ReadonlyMap<string, string>,
  scratchLinkScheme: ScratchLinkScheme = "pulse-md"
): Buffer {
  const source = content.toString("utf8")
  if (!Buffer.from(source, "utf8").equals(content)) return content

  const replacements: MarkdownReplacement[] = []
  const cursor = markdownParser.parse(source).cursor()
  do {
    if (cursor.name !== "URL") continue
    const destination = source.slice(cursor.from, cursor.to)
    const enclosed = destination.startsWith("<") && destination.endsWith(">")
    const parsedDestination = enclosed ? destination.slice(1, -1) : destination
    const legacy = legacyScratchLinkIdentity(parsedDestination)
    if (!legacy) continue
    const scratchId = scratchIdByLegacyIdentity.get(
      legacyScratchIdentityKey(legacy.identity)
    )
    if (!scratchId || !isScratchIdentifier(scratchId)) continue
    replacements.push({
      from: cursor.from,
      to: cursor.to,
      value: `${enclosed ? "<" : ""}${scratchLinkScheme}://scratch/${scratchId}${legacy.fragmentSuffix}${enclosed ? ">" : ""}`,
    })
  } while (cursor.next())

  if (replacements.length === 0) return content
  let rewritten = source
  for (const replacement of replacements.reverse()) {
    rewritten = `${rewritten.slice(0, replacement.from)}${replacement.value}${rewritten.slice(replacement.to)}`
  }
  return Buffer.from(rewritten, "utf8")
}

/**
 * Rebinds only canonical standalone-scratch URLs. This is used when a settings
 * archive moves scratch Markdown between the Official, Local, and Development
 * data channels; unrelated URLs and malformed Markdown remain byte-exact.
 */
export function rewriteCanonicalScratchMarkdownLinkSchemes(
  content: Buffer,
  scratchLinkScheme: ScratchLinkScheme
): Buffer {
  const source = content.toString("utf8")
  if (!Buffer.from(source, "utf8").equals(content)) return content

  const replacements: MarkdownReplacement[] = []
  const cursor = markdownParser.parse(source).cursor()
  do {
    if (cursor.name !== "URL") continue
    const destination = source.slice(cursor.from, cursor.to)
    const enclosed = destination.startsWith("<") && destination.endsWith(">")
    const parsedDestination = enclosed ? destination.slice(1, -1) : destination
    const parsed = parseScratchLinkAddress(parsedDestination)
    if (!parsed || parsed.scheme === scratchLinkScheme) continue
    replacements.push({
      from: cursor.from,
      to: cursor.to,
      value: `${enclosed ? "<" : ""}${scratchLinkAddress(parsed.identity, parsed.fragment, scratchLinkScheme)}${enclosed ? ">" : ""}`,
    })
  } while (cursor.next())

  if (replacements.length === 0) return content
  let rewritten = source
  for (const replacement of replacements.reverse()) {
    rewritten = `${rewritten.slice(0, replacement.from)}${replacement.value}${rewritten.slice(replacement.to)}`
  }
  return Buffer.from(rewritten, "utf8")
}

async function rewriteManagedScratchLinks(
  scratchStore: ScratchStore,
  migrations: readonly LegacyScratchMigrationResult[],
  scratchLinkScheme: ScratchLinkScheme
): Promise<void> {
  const scratchIdByLegacyIdentity = new Map(
    migrations.map((migration) => [
      legacyScratchIdentityKey(migration.identity),
      migration.scratchId,
    ])
  )
  if (scratchIdByLegacyIdentity.size === 0) return
  for (const entry of await scratchStore.listCatalog()) {
    const snapshot = await scratchStore.readSnapshot(entry.id)
    const content = rewriteLegacyScratchMarkdownLinks(
      snapshot.content,
      scratchIdByLegacyIdentity,
      scratchLinkScheme
    )
    if (content === snapshot.content) continue
    await scratchStore.upsertSnapshot({ ...snapshot, content })
  }
}

/**
 * One-time, restart-safe promotion of namespaced scratch files into the flat
 * standalone store. The catalog's `migratedFrom` identities are durable
 * per-scratch checkpoints. The completion marker is published only after every
 * legacy profile reference is durable and every copied legacy file is removed.
 */
export async function migrateStandaloneScratchStorage(
  profileStore: ProfileStore,
  scratchStore: ScratchStore,
  scratchLinkScheme: ScratchLinkScheme = "pulse-md"
): Promise<StandaloneScratchMigrationResult> {
  if (await scratchStore.legacyMigrationIsComplete()) {
    return {
      migratedProfileIds: [],
      scratchIds: [],
      status: "already-complete",
    }
  }

  const [references, storedIdentities, checkpointIdentities] =
    await Promise.all([
      profileStore.listLegacyScratchReferences(),
      scratchStore.discoverLegacyScratchIdentities(),
      scratchStore.readLegacyMigrationCheckpoints(),
    ])
  const requestByIdentity = new Map<string, LegacyScratchMigrationRequest>()
  for (const reference of references) {
    const key = legacyScratchIdentityKey(reference.identity)
    const existing = requestByIdentity.get(key)
    if (!existing || (existing.title === undefined && reference.title)) {
      requestByIdentity.set(key, {
        identity: reference.identity,
        ...(reference.title === undefined ? {} : { title: reference.title }),
      })
    }
  }
  for (const identity of storedIdentities) {
    const key = legacyScratchIdentityKey(identity)
    if (!requestByIdentity.has(key)) {
      requestByIdentity.set(key, { identity })
    }
  }
  for (const identity of checkpointIdentities) {
    const key = legacyScratchIdentityKey(identity)
    if (!requestByIdentity.has(key)) {
      requestByIdentity.set(key, { identity })
    }
  }
  const requests = [...requestByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, request]) => request)

  // This is idempotent after a crash: catalog entries retain `migratedFrom`,
  // so repeated requests reuse the already-published id and raw Markdown file.
  const migrations = await scratchStore.migrateLegacyScratches(requests)
  const migratedProfileIds =
    await profileStore.migrateLegacyScratchReferences(migrations)
  const remainingReferences = await profileStore.listLegacyScratchReferences()
  if (remainingReferences.length > 0) {
    throw new Error(
      "Standalone scratch migration left legacy profile references"
    )
  }

  await rewriteManagedScratchLinks(scratchStore, migrations, scratchLinkScheme)

  await scratchStore.finalizeLegacyMigration(
    migrations.map((migration) => migration.identity)
  )
  const remainingStoredIdentities =
    await scratchStore.discoverLegacyScratchIdentities()
  if (remainingStoredIdentities.length > 0) {
    throw new Error("Standalone scratch migration left legacy scratch files")
  }
  await scratchStore.markLegacyMigrationComplete()

  return {
    migratedProfileIds,
    scratchIds: migrations.map((migration) => migration.scratchId),
    status: "migrated",
  }
}
