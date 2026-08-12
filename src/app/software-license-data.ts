import electronLicense from "../../node_modules/electron/LICENSE?raw"
import electronPackageSource from "../../node_modules/electron/package.json?raw"
import khromaLicense from "../../node_modules/khroma/license?raw"
import khromaPackageSource from "../../node_modules/khroma/package.json?raw"
import tailwindLicense from "../../node_modules/tailwindcss/LICENSE?raw"
import tailwindPackageSource from "../../node_modules/tailwindcss/package.json?raw"
import twAnimateLicense from "../../node_modules/tw-animate-css/LICENSE?raw"
import twAnimatePackageSource from "../../node_modules/tw-animate-css/package.json?raw"
import projectLicense from "../../LICENSE?raw"
import projectPackageSource from "../../package.json?raw"
import manualNotices from "../../THIRD_PARTY_NOTICES.md?raw"
import fontNotices from "../../public/THIRD_PARTY_FONT_LICENSES.txt?raw"

export interface SoftwareLicenseEntry {
  id: string
  license: string
  name: string
  text: string
  version: string
}

export interface SoftwareLicenseInventory {
  developmentPreview?: true
  entries: SoftwareLicenseEntry[]
}

interface GeneratedLicenseEntry {
  identifier?: string
  name: string
  text?: string
  version: string
}

interface ProjectPackage {
  copyright: string
  dependencies: Record<string, string>
  license: string
  productName: string
  version: string
}

interface LicensedPackage {
  license: string
  name: string
  version: string
}

const projectPackage = JSON.parse(projectPackageSource) as ProjectPackage
const electronPackage = JSON.parse(electronPackageSource) as LicensedPackage
const khromaPackage = JSON.parse(khromaPackageSource) as Omit<
  LicensedPackage,
  "license"
>
const tailwindPackage = JSON.parse(tailwindPackageSource) as LicensedPackage
const twAnimatePackage = JSON.parse(twAnimatePackageSource) as LicensedPackage
const directDependencies = new Set(Object.keys(projectPackage.dependencies))
const staticallyListedPackages = new Set([
  electronPackage.name,
  khromaPackage.name,
  tailwindPackage.name,
  twAnimatePackage.name,
])
const packageEntry = (
  packageJson: LicensedPackage,
  text: string,
  name = packageJson.name
): SoftwareLicenseEntry => ({
  id: `${packageJson.name}@${packageJson.version}`,
  license: packageJson.license,
  name,
  text: text.trim(),
  version: packageJson.version,
})
const alwaysVisibleEntries: SoftwareLicenseEntry[] = [
  {
    id: `${projectPackage.productName}@${projectPackage.version}`,
    license: "PolyForm Noncommercial 1.0.0",
    name: projectPackage.productName,
    text: projectLicense.trim(),
    version: projectPackage.version,
  },
  packageEntry(electronPackage, electronLicense, "Electron"),
  {
    id: `${khromaPackage.name}@${khromaPackage.version}`,
    license: "MIT",
    name: khromaPackage.name,
    text: khromaLicense.trim(),
    version: khromaPackage.version,
  },
  packageEntry(tailwindPackage, tailwindLicense, "Tailwind CSS"),
  packageEntry(twAnimatePackage, twAnimateLicense),
  {
    id: "bundled-assets",
    license: "OFL-1.1 and MIT",
    name: "Bundled software, fonts, and UI assets",
    text: `${manualNotices.trim()}\n\n${fontNotices.trim()}`,
    version: "Included assets",
  },
]

let inventoryPromise: Promise<SoftwareLicenseInventory> | null = null

function assetUrl(relativePath: string) {
  return new URL(relativePath, document.baseURI).href
}

function isGeneratedLicenseEntry(
  value: unknown
): value is GeneratedLicenseEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Partial<GeneratedLicenseEntry>
  return (
    typeof entry.name === "string" &&
    typeof entry.version === "string" &&
    (entry.identifier === undefined || typeof entry.identifier === "string") &&
    (entry.text === undefined || typeof entry.text === "string")
  )
}

function visibleGeneratedEntries(entries: readonly GeneratedLicenseEntry[]) {
  return entries
    .filter(
      ({ name }) =>
        directDependencies.has(name) && !staticallyListedPackages.has(name)
    )
    .map(({ identifier, name, text, version }): SoftwareLicenseEntry => ({
      id: `${name}@${version}`,
      license: identifier || "See included license text",
      name,
      text: text?.trim() || `License: ${identifier || "not specified"}`,
      version,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version)
    )
}

export function loadSoftwareLicenseInventory() {
  if (inventoryPromise) return inventoryPromise
  if (import.meta.env.DEV) {
    inventoryPromise = Promise.resolve({
      developmentPreview: true,
      entries: alwaysVisibleEntries,
    })
    return inventoryPromise
  }
  const request = fetch(assetUrl("licenses/third-party.json"), {
    cache: "force-cache",
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `Unable to load the software license notices (${response.status})`
      )
    }
    const value: unknown = await response.json()
    if (!Array.isArray(value) || !value.every(isGeneratedLicenseEntry)) {
      throw new Error("The generated software license notices are invalid")
    }
    return {
      entries: [...alwaysVisibleEntries, ...visibleGeneratedEntries(value)],
    }
  })
  inventoryPromise = request.catch((error: unknown) => {
    inventoryPromise = null
    throw error
  })
  return inventoryPromise
}
