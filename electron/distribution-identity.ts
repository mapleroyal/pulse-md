import type { ScratchLinkScheme } from "../src/shared/scratch-links"
import type { DevelopmentCheckoutIdentity } from "../scripts/development-checkout-identity.mjs"

export const PRODUCT_NAME = "Pulse MD"
export const DEVELOPMENT_PRODUCT_NAME = "Pulse MD Development"
export const WINDOWS_APP_USER_MODEL_ID = "io.github.mapleroyal.pulse-md"
export const LINUX_DESKTOP_NAME = "io.github.mapleroyal.pulse-md.desktop"

export const USER_DATA_DIRECTORY_NAME = PRODUCT_NAME

export type PackagedDistributionChannel = "canonical"
export type DistributionChannel = PackagedDistributionChannel | "development"

export type CliIdentity = "pulse-md" | `pulse-md-development-${string}`

export interface DistributionIdentity {
  channel: DistributionChannel
  cliCommandName: "pmd" | "pmd-dev"
  cliIdentity: CliIdentity
  isDevelopment: boolean
  isCanonicalPackage: boolean
  linuxDesktopName: string
  productName: string
  scratchLinkScheme: ScratchLinkScheme
  userDataDirectoryName: string
}

const PACKAGED_IDENTITY: DistributionIdentity = {
  channel: "canonical",
  cliCommandName: "pmd",
  cliIdentity: "pulse-md",
  isDevelopment: false,
  isCanonicalPackage: true,
  linuxDesktopName: LINUX_DESKTOP_NAME,
  productName: PRODUCT_NAME,
  scratchLinkScheme: "pulse-md",
  userDataDirectoryName: USER_DATA_DIRECTORY_NAME,
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
      isCanonicalPackage: false,
      linuxDesktopName: `io.github.mapleroyal.pulse-md-development-${developmentCheckout.checkoutHash}.desktop`,
      productName: DEVELOPMENT_PRODUCT_NAME,
      scratchLinkScheme: "pulse-md-development",
      userDataDirectoryName: developmentCheckout.userDataDirectoryName,
    }
  }
  if (packagedChannel === "canonical") return PACKAGED_IDENTITY
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
