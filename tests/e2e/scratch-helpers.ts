import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

export interface StoredScratchFixture {
  readonly content: string | Uint8Array
  readonly createdAt?: number
  readonly fileName: string
  readonly id: string
  readonly lastOpenedAt?: number | null
  readonly title?: string | null
}

const DEFAULT_CREATED_AT = 1_725_000_000_000

export async function seedScratchStore(
  userData: string,
  scratches: readonly StoredScratchFixture[]
) {
  const directory = path.join(userData, "scratch")
  await mkdir(directory, { recursive: true })
  await Promise.all(
    scratches.map((scratch) =>
      writeFile(path.join(directory, scratch.fileName), scratch.content)
    )
  )
  await writeFile(
    path.join(directory, ".catalog.json"),
    `${JSON.stringify(
      {
        entries: scratches.map((scratch, index) => ({
          createdAt: scratch.createdAt ?? DEFAULT_CREATED_AT + index,
          fileName: scratch.fileName,
          id: scratch.id,
          lastOpenedAt: scratch.lastOpenedAt ?? null,
          ...(scratch.title ? { title: scratch.title } : {}),
        })),
        version: 1,
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  return directory
}
