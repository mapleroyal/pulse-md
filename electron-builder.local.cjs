const configuration = structuredClone(require("./electron-builder.config.cjs"))

// A source-built package is the same Pulse MD product as a GitHub release.
// Keep only the signing/installer differences that make a local build usable
// without release credentials.
configuration.mac.identity = "-"

configuration.nsis.include = "build/installer.nsh"
configuration.nsis.runAfterFinish = false

module.exports = configuration
