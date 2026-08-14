import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const builderConfiguration = require("../electron-builder.config.cjs")

const installerEnvironmentVariable = "PMD_LOCAL_INSTALLER_PATH"
const canonicalGuidEnvironmentVariable = "PMD_WINDOWS_CANONICAL_GUID"
const legacyGuidEnvironmentVariable = "PMD_WINDOWS_LEGACY_GUID"
const registryViewEnvironmentVariable = "PMD_WINDOWS_REGISTRY_VIEW"
const canonicalAppId = "io.github.mapleroyal.pulse-md"
const legacyAppId = "io.github.mapleroyal.pulse-md.local"
const canonicalInstallerGuid = "102e1616-3f19-5f08-a24a-3a30fb60faaa"
const legacyInstallerGuid = "04ac6e71-2cf6-508e-a700-447b1cbe0bb4"
const markdownExtensions = ["md", "markdown", "mdown", "mkd"]

function normalizeGuid(value, description) {
  if (typeof value !== "string") {
    throw new TypeError(`${description} is unavailable`)
  }
  const normalized = value
    .trim()
    .replace(/^\{(.+)\}$/, "$1")
    .toLowerCase()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new TypeError(`${description} is invalid: ${value}`)
  }
  return normalized
}

function windowsRegistryView(architecture) {
  if (architecture === "ia32") return "Registry32"
  if (architecture === "arm64" || architecture === "x64") {
    return "Registry64"
  }
  throw new Error(`Unsupported Windows package architecture: ${architecture}`)
}

export function windowsInstallerIdentity({
  architecture = process.arch,
  configuration = builderConfiguration,
} = {}) {
  if (configuration?.appId !== canonicalAppId) {
    throw new Error(
      `Refusing non-canonical Windows appId: ${String(configuration?.appId)}`
    )
  }

  const effectiveGuid = normalizeGuid(
    configuration.nsis?.guid,
    "Configured NSIS GUID"
  )
  if (effectiveGuid === legacyInstallerGuid) {
    throw new Error(`Refusing the legacy Pulse MD Local NSIS GUID`)
  }
  if (effectiveGuid !== canonicalInstallerGuid) {
    throw new Error(`Unexpected canonical Pulse MD NSIS GUID: ${effectiveGuid}`)
  }

  return {
    canonicalGuid: effectiveGuid,
    expectedRegistryView: windowsRegistryView(architecture),
    legacyGuid: legacyInstallerGuid,
  }
}

export function windowsInstallerInvocation(
  installer,
  environment = process.env
) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$installer = $env:${installerEnvironmentVariable}`,
    "if (-not $installer) { throw 'Pulse MD installer path is unavailable' }",
    "$process = Start-Process -FilePath $installer -Verb RunAs -Wait -PassThru",
    "exit $process.ExitCode",
  ].join("; ")

  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    command: "powershell.exe",
    env: { ...environment, [installerEnvironmentVariable]: installer },
  }
}

export function windowsInstallInventoryInvocation({
  environment = process.env,
  identity = windowsInstallerIdentity(),
} = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$canonicalGuid = $env:${canonicalGuidEnvironmentVariable}`,
    `$legacyGuid = $env:${legacyGuidEnvironmentVariable}`,
    "if (-not $canonicalGuid -or -not $legacyGuid) { throw 'Pulse MD installer GUIDs are unavailable' }",
    "$identities = @(@{ name = 'canonical'; guid = $canonicalGuid }, @{ name = 'legacy'; guid = $legacyGuid })",
    "$scopes = @(@{ name = 'machine'; hive = [Microsoft.Win32.RegistryHive]::LocalMachine }, @{ name = 'user'; hive = [Microsoft.Win32.RegistryHive]::CurrentUser })",
    "$views = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)",
    "$records = [System.Collections.Generic.List[object]]::new()",
    "foreach ($identity in $identities) { foreach ($scope in $scopes) { foreach ($view in $views) { $baseKey = $null; try { $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($scope.hive, $view); foreach ($kind in @('install', 'uninstall')) { if ($kind -eq 'install') { $subKeyName = 'Software\\' + $identity.guid } else { $subKeyName = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $identity.guid }; $key = $baseKey.OpenSubKey($subKeyName); if ($null -eq $key) { continue }; try { $records.Add([pscustomobject]@{ identity = $identity.name; guid = $identity.guid; scope = $scope.name; view = $view.ToString(); kind = $kind; installLocation = [string]$key.GetValue('InstallLocation', ''); displayName = [string]$key.GetValue('DisplayName', ''); uninstallString = [string]$key.GetValue('UninstallString', '') }) } finally { $key.Dispose() } } } finally { if ($null -ne $baseKey) { $baseKey.Dispose() } } } } }",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $records.ToArray()))",
  ].join("; ")

  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    command: "powershell.exe",
    env: {
      ...environment,
      [canonicalGuidEnvironmentVariable]: identity.canonicalGuid,
      [legacyGuidEnvironmentVariable]: identity.legacyGuid,
    },
  }
}

export function parseWindowsInstallInventory(output) {
  let parsed
  try {
    parsed = JSON.parse(output.trim() || "[]")
  } catch (error) {
    throw new Error("Windows install inventory is not valid JSON", {
      cause: error,
    })
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Windows install inventory must be an array")
  }

  return parsed.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(
        `Windows install inventory record ${index} is invalid`
      )
    }
    if (!["canonical", "legacy"].includes(record.identity)) {
      throw new TypeError(
        `Windows install inventory record ${index} has an invalid identity`
      )
    }
    if (!["machine", "user"].includes(record.scope)) {
      throw new TypeError(
        `Windows install inventory record ${index} has an invalid scope`
      )
    }
    if (!["Registry32", "Registry64"].includes(record.view)) {
      throw new TypeError(
        `Windows install inventory record ${index} has an invalid registry view`
      )
    }
    if (!["install", "uninstall"].includes(record.kind)) {
      throw new TypeError(
        `Windows install inventory record ${index} has an invalid key kind`
      )
    }

    return {
      displayName:
        typeof record.displayName === "string" ? record.displayName : "",
      guid: normalizeGuid(
        record.guid,
        `Windows install inventory record ${index} GUID`
      ),
      identity: record.identity,
      installLocation:
        typeof record.installLocation === "string"
          ? record.installLocation
          : "",
      kind: record.kind,
      scope: record.scope,
      uninstallString:
        typeof record.uninstallString === "string"
          ? record.uninstallString
          : "",
      view: record.view,
    }
  })
}

function normalizedWindowsPath(value) {
  return path.win32
    .resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase()
}

function describeInventoryRecord(record) {
  return `${record.identity} ${record.scope} ${record.view} ${record.kind}`
}

function uninstallLocation(record) {
  const match = /^\s*"([^"]+[\\/]Uninstall Pulse MD\.exe)"(?:\s|$)/i.exec(
    record.uninstallString
  )
  if (!match) {
    throw new Error(
      `Canonical Windows uninstall command is invalid: ${record.uninstallString}`
    )
  }
  return path.win32.dirname(match[1])
}

export function requireCanonicalWindowsInstallation(records, identity) {
  const unexpectedGuids = records.filter(
    (record) =>
      record.guid !== identity.canonicalGuid &&
      record.guid !== identity.legacyGuid
  )
  if (unexpectedGuids.length > 0) {
    throw new Error(
      `Windows install inventory contains an unexpected GUID:\n${unexpectedGuids
        .map(describeInventoryRecord)
        .join("\n")}`
    )
  }

  const legacy = records.filter(
    (record) =>
      record.identity === "legacy" || record.guid === identity.legacyGuid
  )
  if (legacy.length > 0) {
    throw new Error(
      `A legacy Pulse MD Local installation remains:\n${legacy
        .map(describeInventoryRecord)
        .join("\n")}`
    )
  }

  const canonical = records.filter(
    (record) =>
      record.identity === "canonical" && record.guid === identity.canonicalGuid
  )
  const expected = canonical.filter(
    (record) =>
      record.scope === "machine" &&
      record.view === identity.expectedRegistryView
  )
  const unexpected = canonical.filter((record) => !expected.includes(record))
  if (unexpected.length > 0) {
    throw new Error(
      `A duplicate or per-user Pulse MD installation remains:\n${unexpected
        .map(describeInventoryRecord)
        .join("\n")}`
    )
  }

  const installRecords = expected.filter((record) => record.kind === "install")
  const uninstallRecords = expected.filter(
    (record) => record.kind === "uninstall"
  )
  if (installRecords.length !== 1 || uninstallRecords.length !== 1) {
    throw new Error(
      `Expected one canonical machine install key and one uninstall key in ${identity.expectedRegistryView}; found ${installRecords.length} and ${uninstallRecords.length}`
    )
  }

  const installationRoot = installRecords[0].installLocation.trim()
  if (!installationRoot) {
    throw new Error("Canonical Windows InstallLocation is empty")
  }
  const uninstallerRoot = uninstallLocation(uninstallRecords[0])
  if (
    normalizedWindowsPath(installationRoot) !==
    normalizedWindowsPath(uninstallerRoot)
  ) {
    throw new Error(
      `Canonical install and uninstall keys disagree: ${installationRoot} versus ${uninstallerRoot}`
    )
  }

  return {
    installationRoot: path.win32.resolve(installationRoot),
    registryView: identity.expectedRegistryView,
  }
}

export function windowsPathInventoryInvocation(environment = process.env) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$inventory = [pscustomobject]@{ machine = [string][Environment]::GetEnvironmentVariable('Path', 'Machine'); user = [string][Environment]::GetEnvironmentVariable('Path', 'User') }",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $inventory))",
  ].join("; ")
  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    command: "powershell.exe",
    env: environment,
  }
}

export function parseWindowsPathInventory(output) {
  let parsed
  try {
    parsed = JSON.parse(output.trim())
  } catch (error) {
    throw new Error("Windows PATH inventory is not valid JSON", {
      cause: error,
    })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Windows PATH inventory must be an object")
  }
  return {
    machine: typeof parsed.machine === "string" ? parsed.machine : "",
    user: typeof parsed.user === "string" ? parsed.user : "",
  }
}

function expandWindowsEnvironmentVariables(value, environment) {
  const values = new Map(
    Object.entries(environment).map(([name, entry]) => [
      name.toLowerCase(),
      String(entry),
    ])
  )
  return value.replace(/%([^%]+)%/g, (match, name) => {
    return values.get(name.toLowerCase()) ?? match
  })
}

function windowsPathEntries(value, environment) {
  return value
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => expandWindowsEnvironmentVariables(entry, environment))
}

function isPulseMdCliDirectory(value) {
  return /(?:^|[\\/])(?:pulse[ -]md|pulse[ -]md[ -]local)[\\/]resources[\\/]bin[\\/]*$/i.test(
    value
  )
}

export function requireCanonicalWindowsCliPath(
  inventory,
  expectedDirectory,
  environment = process.env
) {
  const normalizedExpected = normalizedWindowsPath(expectedDirectory)
  const machineEntries = windowsPathEntries(inventory.machine, environment)
  const userEntries = windowsPathEntries(inventory.user, environment)
  const machineMatches = machineEntries.filter(
    (entry) => normalizedWindowsPath(entry) === normalizedExpected
  )
  const userMatches = userEntries.filter(
    (entry) => normalizedWindowsPath(entry) === normalizedExpected
  )
  const competing = [...machineEntries, ...userEntries].filter(
    (entry) =>
      isPulseMdCliDirectory(entry) &&
      normalizedWindowsPath(entry) !== normalizedExpected
  )

  if (machineMatches.length !== 1) {
    throw new Error(
      `Expected the canonical pmd directory once in the machine PATH; found ${machineMatches.length}`
    )
  }
  if (userMatches.length > 0 || competing.length > 0) {
    throw new Error(
      `A per-user or competing Pulse MD CLI PATH entry remains:\n${[
        ...userMatches,
        ...competing,
      ].join("\n")}`
    )
  }

  return normalizedExpected
}

export function windowsShellInventoryInvocation({
  environment = process.env,
  identity = windowsInstallerIdentity(),
} = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$viewName = $env:${registryViewEnvironmentVariable}`,
    "if (-not $viewName) { throw 'Pulse MD registry view is unavailable' }",
    "$view = [Microsoft.Win32.RegistryView]([Enum]::Parse([Microsoft.Win32.RegistryView], $viewName))",
    "function Get-KeySnapshot { param($baseKey, [string]$subKeyName, [string]$trackedValueName = '') $key = $baseKey.OpenSubKey($subKeyName); if ($null -eq $key) { return [pscustomobject]@{ exists = $false; defaultValue = ''; trackedValueExists = $false } }; try { $valueNames = @($key.GetValueNames()); return [pscustomobject]@{ exists = $true; defaultValue = [string]$key.GetValue('', ''); trackedValueExists = $trackedValueName -ne '' -and $valueNames -contains $trackedValueName } } finally { $key.Dispose() } }",
    "$scopes = @(@{ name = 'machine'; hive = [Microsoft.Win32.RegistryHive]::LocalMachine }, @{ name = 'user'; hive = [Microsoft.Win32.RegistryHive]::CurrentUser })",
    "$records = [System.Collections.Generic.List[object]]::new()",
    "foreach ($scope in $scopes) { $baseKey = $null; try { $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($scope.hive, $view); $protocol = Get-KeySnapshot $baseKey 'Software\\Classes\\pulse-md' 'URL Protocol'; $protocolCommand = Get-KeySnapshot $baseKey 'Software\\Classes\\pulse-md\\shell\\open\\command'; $markdown = Get-KeySnapshot $baseKey 'Software\\Classes\\PulseMD.Markdown'; $markdownCommand = Get-KeySnapshot $baseKey 'Software\\Classes\\PulseMD.Markdown\\shell\\open\\command'; $legacyMarkdown = Get-KeySnapshot $baseKey 'Software\\Classes\\Markdown document'; $legacyMarkdownCommand = Get-KeySnapshot $baseKey 'Software\\Classes\\Markdown document\\shell\\open\\command'; $extensions = [System.Collections.Generic.List[object]]::new(); foreach ($extension in @('md', 'markdown', 'mdown', 'mkd')) { $extensionKey = Get-KeySnapshot $baseKey ('Software\\Classes\\.' + $extension); $openWithKey = Get-KeySnapshot $baseKey ('Software\\Classes\\.' + $extension + '\\OpenWithProgids') 'PulseMD.Markdown'; $extensions.Add([pscustomobject]@{ extension = $extension; defaultValue = $extensionKey.defaultValue; openWithProgIdExists = $openWithKey.trackedValueExists }) }; $records.Add([pscustomobject]@{ scope = $scope.name; view = $view.ToString(); protocol = [pscustomobject]@{ exists = $protocol.exists; urlProtocolExists = $protocol.trackedValueExists; commandExists = $protocolCommand.exists; command = $protocolCommand.defaultValue }; markdown = [pscustomobject]@{ exists = $markdown.exists; commandExists = $markdownCommand.exists; command = $markdownCommand.defaultValue }; legacyMarkdown = [pscustomobject]@{ exists = $legacyMarkdown.exists; commandExists = $legacyMarkdownCommand.exists; command = $legacyMarkdownCommand.defaultValue }; extensions = $extensions.ToArray() }) } finally { if ($null -ne $baseKey) { $baseKey.Dispose() } } }",
    "[Console]::Out.Write((ConvertTo-Json -Depth 5 -Compress -InputObject $records.ToArray()))",
  ].join("; ")

  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    command: "powershell.exe",
    env: {
      ...environment,
      [registryViewEnvironmentVariable]: identity.expectedRegistryView,
    },
  }
}

function parseBoolean(value, description) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${description} must be a boolean`)
  }
  return value
}

function parseShellRegistration(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} is invalid`)
  }
  return {
    command: typeof value.command === "string" ? value.command : "",
    commandExists: parseBoolean(
      value.commandExists,
      `${description} commandExists`
    ),
    exists: parseBoolean(value.exists, `${description} exists`),
    ...(Object.hasOwn(value, "urlProtocolExists")
      ? {
          urlProtocolExists: parseBoolean(
            value.urlProtocolExists,
            `${description} urlProtocolExists`
          ),
        }
      : {}),
  }
}

export function parseWindowsShellInventory(output) {
  let parsed
  try {
    parsed = JSON.parse(output.trim())
  } catch (error) {
    throw new Error("Windows shell inventory is not valid JSON", {
      cause: error,
    })
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Windows shell inventory must be an array")
  }

  return parsed.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Windows shell inventory record ${index} is invalid`)
    }
    if (!Array.isArray(record.extensions)) {
      throw new TypeError(
        `Windows shell inventory record ${index} extensions are invalid`
      )
    }
    return {
      extensions: record.extensions.map((extension, extensionIndex) => {
        if (
          !extension ||
          typeof extension !== "object" ||
          Array.isArray(extension) ||
          typeof extension.extension !== "string"
        ) {
          throw new TypeError(
            `Windows shell inventory record ${index} extension ${extensionIndex} is invalid`
          )
        }
        return {
          defaultValue:
            typeof extension.defaultValue === "string"
              ? extension.defaultValue
              : "",
          extension: extension.extension,
          openWithProgIdExists: parseBoolean(
            extension.openWithProgIdExists,
            `Windows shell inventory record ${index} extension ${extensionIndex} openWithProgIdExists`
          ),
        }
      }),
      legacyMarkdown: parseShellRegistration(
        record.legacyMarkdown,
        `Windows shell inventory record ${index} legacyMarkdown`
      ),
      markdown: parseShellRegistration(
        record.markdown,
        `Windows shell inventory record ${index} markdown`
      ),
      protocol: parseShellRegistration(
        record.protocol,
        `Windows shell inventory record ${index} protocol`
      ),
      scope: record.scope,
      view: record.view,
    }
  })
}

function windowsCommandExecutable(command) {
  const trimmed = command.trimStart()
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1)
    return closingQuote === -1 ? null : trimmed.slice(1, closingQuote)
  }
  return /^(.*?\.exe)(?=\s|$)/i.exec(trimmed)?.[1] ?? null
}

function legacyMarkdownRegistrationIsPulseMdOwned(registration) {
  if (!registration.exists || !registration.commandExists) return false
  const executable = windowsCommandExecutable(registration.command)
  return (
    executable !== null &&
    /(?:^|[\\/])Pulse MD(?: Local)?\.exe$/i.test(executable)
  )
}

export function requireCanonicalWindowsShellRegistrations(
  records,
  installationRoot,
  identity
) {
  if (records.length !== 2) {
    throw new Error(
      `Expected machine and user Windows shell inventory records; found ${records.length}`
    )
  }
  const expectedCommand = `"${path.win32.join(
    installationRoot,
    "Pulse MD.exe"
  )}" "%1"`
  const recordFor = (scope) =>
    records.filter(
      (record) =>
        record.scope === scope && record.view === identity.expectedRegistryView
    )
  const machineRecords = recordFor("machine")
  const userRecords = recordFor("user")
  if (machineRecords.length !== 1 || userRecords.length !== 1) {
    throw new Error(
      `Windows shell inventory does not contain one machine and one user ${identity.expectedRegistryView} record`
    )
  }

  const machine = machineRecords[0]
  if (
    !machine.protocol.exists ||
    !machine.protocol.urlProtocolExists ||
    !machine.protocol.commandExists ||
    machine.protocol.command !== expectedCommand
  ) {
    throw new Error(
      `Canonical pulse-md URL registration is invalid: ${machine.protocol.command}`
    )
  }
  if (
    !machine.markdown.exists ||
    !machine.markdown.commandExists ||
    machine.markdown.command !== expectedCommand
  ) {
    throw new Error(
      `Canonical PulseMD.Markdown registration is invalid: ${machine.markdown.command}`
    )
  }

  const extensions = new Map(
    machine.extensions.map((extension) => [extension.extension, extension])
  )
  if (
    extensions.size !== markdownExtensions.length ||
    markdownExtensions.some((extension) => {
      const record = extensions.get(extension)
      return (
        !record ||
        record.defaultValue !== "PulseMD.Markdown" ||
        !record.openWithProgIdExists
      )
    })
  ) {
    throw new Error(
      "Canonical PulseMD.Markdown extension registrations are incomplete"
    )
  }
  if (legacyMarkdownRegistrationIsPulseMdOwned(machine.legacyMarkdown)) {
    throw new Error(
      "A Pulse MD-owned legacy Markdown document ProgID remains machine-wide"
    )
  }

  const user = userRecords[0]
  const userOverrides =
    user.protocol.exists ||
    user.markdown.exists ||
    legacyMarkdownRegistrationIsPulseMdOwned(user.legacyMarkdown) ||
    user.extensions.some(
      (extension) =>
        extension.defaultValue === "PulseMD.Markdown" ||
        extension.openWithProgIdExists
    )
  if (userOverrides) {
    throw new Error("A per-user Pulse MD shell registration remains")
  }

  return expectedCommand
}

export {
  canonicalAppId,
  canonicalGuidEnvironmentVariable,
  canonicalInstallerGuid,
  installerEnvironmentVariable,
  legacyAppId,
  legacyGuidEnvironmentVariable,
  legacyInstallerGuid,
  markdownExtensions,
  registryViewEnvironmentVariable,
}
