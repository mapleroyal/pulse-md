import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  archArchitectureFromElfHeader,
  archArtifactName,
  archIconSizes,
  archPackageEntryAllowed,
  archPackageIconPath,
  archPackageLayout,
  archPackageVersion,
  archRuntimeDependencies,
  renderArchPkgbuild,
} from "./package-arch.mjs"

const projectRoot = path.resolve(import.meta.dirname, "..")

function elfHeader(machine) {
  const header = Buffer.alloc(20)
  header.set([0x7f, 0x45, 0x4c, 0x46])
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(machine, 18)
  return header
}

test("Arch package metadata follows makepkg naming conventions", () => {
  assert.equal(archPackageVersion("1.2.3-beta.1"), "1.2.3_beta.1")
  assert.equal(
    archArtifactName("1.2.3-beta.1", "x86_64"),
    "pulse-md-1.2.3_beta.1-1-x86_64.pkg.tar.zst"
  )
})

test("Arch package architecture is derived from the prepared ELF runtime", () => {
  assert.equal(archArchitectureFromElfHeader(elfHeader(62)), "x86_64")
  assert.equal(archArchitectureFromElfHeader(elfHeader(183)), "aarch64")
  assert.throws(
    () => archArchitectureFromElfHeader(elfHeader(40)),
    /Unsupported Arch ELF machine/
  )
})

test("Arch PKGBUILD pins checked source archives and package-owned launchers", () => {
  const rendered = renderArchPkgbuild({
    architecture: "x86_64",
    packagingSha256: "b".repeat(64),
    runtimeSha256: "a".repeat(64),
    version: "1.0.0",
  })

  assert.doesNotMatch(rendered, /@[A-Z0-9_]+@/)
  assert.match(rendered, /^pkgver=1\.0\.0$/m)
  assert.match(rendered, /^arch=\('x86_64'\)$/m)
  assert.match(rendered, /ln -s \/opt\/pulse-md\/pulse-md/)
  assert.match(rendered, /ln -s \/opt\/pulse-md\/resources\/bin\/pmd/)
  assert.match(rendered, /options=\('!debug' '!emptydirs' '!strip'\)/)
  const dependencies = rendered
    .match(/depends=\(\n(?<contents>[\s\S]*?)\n\)/)
    .groups.contents.split(/\r?\n/)
    .map((line) => line.trim())
  assert.deepEqual(dependencies, archRuntimeDependencies)
  assert.deepEqual(archIconSizes, [16, 24, 32, 48, 64, 96, 128, 256, 512])
  assert.equal(archPackageLayout.runtimeRoot, "/opt/pulse-md")
  assert.equal(archPackageLayout.guiCommand, "/usr/bin/pulse-md")
  assert.equal(archPackageLayout.cli, "/usr/bin/pmd")
  assert.equal(
    archPackageIconPath(512),
    "/usr/share/icons/hicolor/512x512/apps/pulse-md.png"
  )
})

test("Arch package manifest is confined to its owned system layout", () => {
  assert.equal(archPackageEntryAllowed("opt/pulse-md/resources/app.asar"), true)
  assert.equal(archPackageEntryAllowed("usr/bin/pulse-md"), true)
  assert.equal(
    archPackageEntryAllowed(
      "usr/share/icons/hicolor/512x512/apps/pulse-md.png"
    ),
    true
  )
  assert.equal(archPackageEntryAllowed("etc/pulse-md.conf"), false)
  assert.equal(archPackageEntryAllowed("usr/bin/unrelated"), false)
  assert.equal(
    archPackageEntryAllowed(
      "usr/share/icons/hicolor/512x512/mimetypes/text-markdown.png"
    ),
    false
  )
})

test("Arch desktop and MIME metadata use app artwork but theme-owned documents", () => {
  const desktop = readFileSync(
    path.join(
      projectRoot,
      "packaging",
      "arch",
      "io.github.mapleroyal.pulse-md.desktop"
    ),
    "utf8"
  )
  const mime = readFileSync(
    path.join(
      projectRoot,
      "packaging",
      "arch",
      "io.github.mapleroyal.pulse-md.xml"
    ),
    "utf8"
  )

  assert.match(desktop, /^Exec=\/usr\/bin\/pulse-md %U$/m)
  assert.match(desktop, /^Icon=pulse-md$/m)
  assert.match(
    desktop,
    /^MimeType=text\/markdown;x-scheme-handler\/pulse-md;$/m
  )
  assert.match(mime, /mime-type type="text\/markdown"/)
  assert.match(mime, /glob pattern="\*\.mdown" weight="80"/)
  assert.doesNotMatch(mime, /<icon(?:\s|>)/)
})
