export const DEVELOPMENT_CHECKOUT_HASH_LENGTH: 12
export const DEVELOPMENT_CLI_IDENTITY_PREFIX: "pulse-md-development"
export const DEVELOPMENT_USER_DATA_DIRECTORY_PREFIX: "Pulse MD Development"

export interface DevelopmentCheckoutIdentity {
  checkoutHash: string
  checkoutRoot: string
  cliIdentity: `pulse-md-development-${string}`
  userDataDirectoryName: string
}

export function developmentCheckoutIdentity(
  checkoutRoot: string,
  options?: { realpath?: (path: string) => string }
): DevelopmentCheckoutIdentity

export function developmentServerPort(checkoutHash: string): number
