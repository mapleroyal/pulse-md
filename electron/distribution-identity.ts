import type { ScratchLinkScheme } from "../src/shared/scratch-links"
import type { DevelopmentCheckoutIdentity } from "../scripts/development-checkout-identity.mjs"

export const OFFICIAL_PRODUCT_NAME = "Pulse MD"
export const LOCAL_PRODUCT_NAME = "Pulse MD Local"
export const DEVELOPMENT_PRODUCT_NAME = "Pulse MD Development"

export const OFFICIAL_USER_DATA_DIRECTORY_NAME = OFFICIAL_PRODUCT_NAME
export const LOCAL_USER_DATA_DIRECTORY_NAME = LOCAL_PRODUCT_NAME

export type PackagedDistributionChannel = "official" | "local"
export type DistributionChannel = PackagedDistributionChannel | "development"

export type CliIdentity =
  "pulse-md" | "pulse-md-local" | `pulse-md-development-${string}`

export interface DistributionIdentity {
  channel: DistributionChannel
  cliCommandName: "pmd" | "pmd-local" | "pmd-dev"
  cliIdentity: CliIdentity
  isDevelopment: boolean
  isOfficialPackage: boolean
  productName: string
  scratchLinkScheme: ScratchLinkScheme
  userDataDirectoryName: string
}

const PACKAGED_IDENTITIES: Record<
  PackagedDistributionChannel,
  DistributionIdentity
> = {
  official: {
    channel: "official",
    cliCommandName: "pmd",
    cliIdentity: "pulse-md",
    isDevelopment: false,
    isOfficialPackage: true,
    productName: OFFICIAL_PRODUCT_NAME,
    scratchLinkScheme: "pulse-md",
    userDataDirectoryName: OFFICIAL_USER_DATA_DIRECTORY_NAME,
  },
  local: {
    channel: "local",
    cliCommandName: "pmd-local",
    cliIdentity: "pulse-md-local",
    isDevelopment: false,
    isOfficialPackage: false,
    productName: LOCAL_PRODUCT_NAME,
    scratchLinkScheme: "pulse-md-local",
    userDataDirectoryName: LOCAL_USER_DATA_DIRECTORY_NAME,
  },
}

/**
 * Resolve identity from explicit package metadata. Product display names are
 * deliberately not an authority: electron-builder can change the outer bundle
 * name without changing the package.json Electron reads at runtime.
 */
export function resolveDistributionIdentity(
  isPackaged: boolean,
  packagedChannel?: unknown,
  developmentCheckout?: DevelopmentCheckoutIdentity
): DistributionIdentity {
  if (!isPackaged) {
    if (!developmentCheckout) {
      throw new TypeError(
        "Source development is missing its checkout-scoped identity"
      )
    }
    return {
      channel: "development",
      cliCommandName: "pmd-dev",
      cliIdentity: developmentCheckout.cliIdentity,
      isDevelopment: true,
      isOfficialPackage: false,
      productName: DEVELOPMENT_PRODUCT_NAME,
      scratchLinkScheme: "pulse-md-development",
      userDataDirectoryName: developmentCheckout.userDataDirectoryName,
    }
  }
  if (packagedChannel === "official" || packagedChannel === "local") {
    return PACKAGED_IDENTITIES[packagedChannel]
  }
  throw new TypeError(
    "Packaged Pulse MD is missing a valid pmdDistributionChannel"
  )
}

export function distributionShouldStartCliServer(options: {
  explicitEndpoint: boolean
  isolatedUserData: boolean
}): boolean {
  return options.explicitEndpoint || !options.isolatedUserData
}
