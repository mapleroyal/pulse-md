const configuration = structuredClone(require("./electron-builder.config.cjs"))

// This configuration deliberately keeps the canonical product identity,
// desktop integrations, and adaptive Icon Composer asset so the maintainer can
// verify the exact installed-app behavior. It is ad-hoc signed and must never
// be distributed.
configuration.mac.identity = "-"
configuration.mac.target = ["dir"]

module.exports = configuration
