const configuration = structuredClone(require("./electron-builder.config.cjs"))

// This configuration deliberately keeps the production identity and desktop
// integrations so the maintainer can verify the exact installed-app behavior.
// It is ad-hoc signed, uses the portable icon, and must never be distributed.
configuration.mac.icon = "build/pulse-md.icns"
configuration.mac.identity = "-"
configuration.mac.target = ["dir"]

module.exports = configuration
