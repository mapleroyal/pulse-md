import { describe, expect, it } from "vitest"

import {
  DEVELOPMENT_PRODUCT_NAME,
  distributionShouldStartCliServer,
  PRODUCT_NAME,
  resolveDistributionIdentity,
  USER_DATA_DIRECTORY_NAME,
  WINDOWS_APP_USER_MODEL_ID,
} from "./distribution-identity"
import { developmentCheckoutIdentity } from "../scripts/development-checkout-identity.mjs"

const DEVELOPMENT_CHECKOUT = developmentCheckoutIdentity(
  "/workspace/pulse-md",
  { realpath: (value) => value }
)

describe("distribution identity", () => {
  it("uses the packaged Windows application identity", () => {
    expect(WINDOWS_APP_USER_MODEL_ID).toBe("io.github.mapleroyal.pulse-md")
  })

  it("gives source development a complete isolated identity", () => {
    expect(
      resolveDistributionIdentity(false, undefined, DEVELOPMENT_CHECKOUT)
    ).toEqual({
      channel: "development",
      cliCommandName: "pmd-dev",
      cliIdentity: DEVELOPMENT_CHECKOUT.cliIdentity,
      isDevelopment: true,
      isCanonicalPackage: false,
      productName: DEVELOPMENT_PRODUCT_NAME,
      scratchLinkScheme: "pulse-md-development",
      userDataDirectoryName: DEVELOPMENT_CHECKOUT.userDataDirectoryName,
    })
    expect(DEVELOPMENT_CHECKOUT.cliIdentity).toMatch(
      /^pulse-md-development-[0-9a-f]{12}$/u
    )
    expect(DEVELOPMENT_CHECKOUT.userDataDirectoryName).toContain(
      DEVELOPMENT_CHECKOUT.checkoutHash
    )
    expect(DEVELOPMENT_PRODUCT_NAME).not.toBe(PRODUCT_NAME)
  })

  it("fails closed when source development has no checkout identity", () => {
    expect(() => resolveDistributionIdentity(false)).toThrow(
      /checkout-scoped identity/u
    )
  })

  it("uses explicit package metadata rather than a display-name heuristic", () => {
    expect(resolveDistributionIdentity(true, "canonical")).toEqual({
      channel: "canonical",
      cliCommandName: "pmd",
      cliIdentity: "pulse-md",
      isDevelopment: false,
      isCanonicalPackage: true,
      productName: PRODUCT_NAME,
      scratchLinkScheme: "pulse-md",
      userDataDirectoryName: USER_DATA_DIRECTORY_NAME,
    })
  })

  it("fails closed when packaged channel metadata is absent or unknown", () => {
    expect(() => resolveDistributionIdentity(true)).toThrow(
      /pmdDistributionChannel/
    )
    expect(() => resolveDistributionIdentity(true, "local")).toThrow(
      /pmdDistributionChannel/
    )
  })

  it("starts each identity's CLI server except for isolated test launches", () => {
    expect(
      distributionShouldStartCliServer({
        explicitEndpoint: false,
        isolatedUserData: false,
      })
    ).toBe(true)
    expect(
      distributionShouldStartCliServer({
        explicitEndpoint: false,
        isolatedUserData: true,
      })
    ).toBe(false)
    expect(
      distributionShouldStartCliServer({
        explicitEndpoint: true,
        isolatedUserData: true,
      })
    ).toBe(true)
  })
})
