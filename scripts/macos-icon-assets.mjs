const requiredIconAppearances = [
  "NSAppearanceNameAqua",
  "NSAppearanceNameDarkAqua",
]

export function assertAdaptiveMacIconAssetInfo(
  assetInfo,
  label = "macOS asset catalog"
) {
  if (!Array.isArray(assetInfo)) {
    throw new TypeError(`${label} metadata is not an array`)
  }

  const appearances = new Set(
    assetInfo
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.AssetType === "IconImageStack" &&
          entry.Name === "Icon"
      )
      .map((entry) => entry.Appearance)
      .filter((appearance) => typeof appearance === "string")
  )
  const missing = requiredIconAppearances.filter(
    (appearance) => !appearances.has(appearance)
  )
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing the Icon image stack for ${missing.join(", ")}`
    )
  }
}
