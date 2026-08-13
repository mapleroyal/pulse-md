import assert from "node:assert/strict"
import { test } from "node:test"

import { assertAdaptiveMacIconAssetInfo } from "./macos-icon-assets.mjs"

const stack = (Appearance) => ({
  Appearance,
  AssetType: "IconImageStack",
  Name: "Icon",
})

test("accepts the canonical Icon stack for light and dark appearances", () => {
  assert.doesNotThrow(() =>
    assertAdaptiveMacIconAssetInfo([
      stack("NSAppearanceNameDarkAqua"),
      stack("NSAppearanceNameAqua"),
      stack("ISAppearanceTintable"),
    ])
  )
})

test("rejects a catalog without both automatic appearance stacks", () => {
  assert.throws(
    () =>
      assertAdaptiveMacIconAssetInfo(
        [stack("NSAppearanceNameAqua")],
        "fixture Assets.car"
      ),
    /fixture Assets\.car is missing the Icon image stack for NSAppearanceNameDarkAqua/
  )
  assert.throws(
    () =>
      assertAdaptiveMacIconAssetInfo([
        {
          Appearance: "NSAppearanceNameDarkAqua",
          AssetType: "IconImageStack",
          Name: "AnotherIcon",
        },
      ]),
    /NSAppearanceNameAqua, NSAppearanceNameDarkAqua/
  )
})
