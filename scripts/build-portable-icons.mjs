#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const iconDirectory = path.join(projectDirectory, "build", "icons")
const portableDirectory = path.join(iconDirectory, "portable")
const fullMaster = path.join(portableDirectory, "pulse-md.svg")
const smallMaster = path.join(portableDirectory, "pulse-md-small.svg")
const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const linuxSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512]

function render(source, destination, size) {
  const result = spawnSync(
    "rsvg-convert",
    [
      "--width",
      String(size),
      "--height",
      String(size),
      "--output",
      destination,
      source,
    ],
    { encoding: "utf8" }
  )
  if (result.error) {
    throw new Error(
      `Unable to run rsvg-convert. Install librsvg to rebuild portable icons: ${result.error.message}`
    )
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "rsvg-convert failed")
  }
}

function sourceFor(size) {
  return size <= 48 ? smallMaster : fullMaster
}

async function packIco(destination, frames) {
  const payloads = await Promise.all(
    frames.map(async ({ size, file }) => ({
      size,
      payload: await readFile(file),
    }))
  )
  const directory = Buffer.alloc(6 + payloads.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(payloads.length, 4)

  let offset = directory.length
  payloads.forEach(({ size, payload }, index) => {
    const entryOffset = 6 + index * 16
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset)
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
    directory.writeUInt8(0, entryOffset + 2)
    directory.writeUInt8(0, entryOffset + 3)
    directory.writeUInt16LE(1, entryOffset + 4)
    directory.writeUInt16LE(32, entryOffset + 6)
    directory.writeUInt32LE(payload.length, entryOffset + 8)
    directory.writeUInt32LE(offset, entryOffset + 12)
    offset += payload.length
  })

  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(
    destination,
    Buffer.concat([directory, ...payloads.map(({ payload }) => payload)])
  )
}

async function main() {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-portable-icons-")
  )
  try {
    const windowsFrames = []
    for (const size of windowsSizes) {
      const file = path.join(temporaryDirectory, `pulse-md-${size}.png`)
      render(sourceFor(size), file, size)
      windowsFrames.push({ size, file })
    }
    await packIco(
      path.join(iconDirectory, "windows", "pulse-md.ico"),
      windowsFrames
    )

    const linuxDirectory = path.join(iconDirectory, "linux")
    await mkdir(linuxDirectory, { recursive: true })
    const linuxEntries = (await readdir(linuxDirectory)).filter((entry) =>
      entry.endsWith(".png")
    )
    const expectedLinuxEntries = linuxSizes.map((size) => `${size}x${size}.png`)
    const unexpectedLinuxEntries = linuxEntries.filter(
      (entry) => !expectedLinuxEntries.includes(entry)
    )
    if (unexpectedLinuxEntries.length > 0) {
      throw new Error(
        `Refusing to leave unexpected PNGs in ${linuxDirectory}: ${unexpectedLinuxEntries.join(", ")}`
      )
    }
    for (const size of linuxSizes) {
      render(
        sourceFor(size),
        path.join(linuxDirectory, `${size}x${size}.png`),
        size
      )
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

await main()
