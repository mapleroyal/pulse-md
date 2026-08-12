import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"

export const DEVELOPMENT_CHECKOUT_HASH_LENGTH = 12
export const DEVELOPMENT_CLI_IDENTITY_PREFIX = "pulse-md-development"
export const DEVELOPMENT_USER_DATA_DIRECTORY_PREFIX = "Pulse MD Development"
const DEVELOPMENT_SERVER_PORT_START = 20_000
const DEVELOPMENT_SERVER_PORT_COUNT = 30_000

export function developmentCheckoutIdentity(
  checkoutRoot,
  { realpath = realpathSync.native } = {}
) {
  if (typeof checkoutRoot !== "string" || checkoutRoot.length === 0) {
    throw new TypeError("The development checkout root must be a path")
  }

  const resolvedCheckoutRoot = path.resolve(
    realpath(path.resolve(checkoutRoot))
  )
  const checkoutHash = createHash("sha256")
    .update(resolvedCheckoutRoot)
    .digest("hex")
    .slice(0, DEVELOPMENT_CHECKOUT_HASH_LENGTH)

  return {
    checkoutHash,
    checkoutRoot: resolvedCheckoutRoot,
    cliIdentity: `${DEVELOPMENT_CLI_IDENTITY_PREFIX}-${checkoutHash}`,
    userDataDirectoryName: `${DEVELOPMENT_USER_DATA_DIRECTORY_PREFIX}-${checkoutHash}`,
  }
}

export function developmentServerPort(checkoutHash) {
  if (!/^[0-9a-f]{12}$/u.test(checkoutHash)) {
    throw new TypeError(
      "The development checkout hash must be 12 lowercase hex characters"
    )
  }
  return (
    DEVELOPMENT_SERVER_PORT_START +
    (Number.parseInt(checkoutHash.slice(0, 8), 16) %
      DEVELOPMENT_SERVER_PORT_COUNT)
  )
}
