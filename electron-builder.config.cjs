const { readFileSync } = require("node:fs")
const path = require("node:path")
const { load } = require("js-yaml")

const configuration = load(
  readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8")
)
const electronMetadata = require("electron/package.json")
const electronChecksums = require("electron/checksums.json")
const expectedPrefix = `electron-v${electronMetadata.version}-`

if (
  !Object.keys(electronChecksums).some((name) =>
    name.startsWith(expectedPrefix)
  )
) {
  throw new Error(
    `Electron ${electronMetadata.version} has no matching checksums in electron/checksums.json`
  )
}

// Supplying the checksum manifest from the pinned Electron package avoids a
// separate request for SHASUMS256.txt. Downloads remain SHA-256 verified, and
// an already cached runtime can be packaged without another network request.
configuration.electronDownload = {
  checksums: electronChecksums,
  // This discriminator keeps electron-builder's @electron/get adapter from
  // converting the options back to its legacy download shape and dropping the
  // bundled checksums. It does not disable verification.
  unsafelyDisableChecksums: false,
}

module.exports = configuration
