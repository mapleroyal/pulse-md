import assert from "node:assert/strict"
import { test } from "node:test"

import {
  canonicalAppId,
  canonicalGuidEnvironmentVariable,
  canonicalInstallerGuid,
  installerEnvironmentVariable,
  legacyGuidEnvironmentVariable,
  legacyInstallerGuid,
  markdownExtensions,
  parseWindowsInstallInventory,
  parseWindowsPathInventory,
  parseWindowsShellInventory,
  requireCanonicalWindowsCliPath,
  requireCanonicalWindowsInstallation,
  requireCanonicalWindowsShellRegistrations,
  registryViewEnvironmentVariable,
  windowsInstallerIdentity,
  windowsInstallerInvocation,
  windowsInstallInventoryInvocation,
  windowsPathInventoryInvocation,
  windowsShellInventoryInvocation,
} from "./windows-installer-launch.mjs"

const identity = windowsInstallerIdentity({ architecture: "x64" })

function inventoryRecord(overrides = {}) {
  return {
    displayName: "",
    guid: canonicalInstallerGuid,
    identity: "canonical",
    installLocation: "",
    kind: "install",
    scope: "machine",
    uninstallString: "",
    view: "Registry64",
    ...overrides,
  }
}

function canonicalInventory(installationRoot = "C:\\Program Files\\Pulse MD") {
  return [
    inventoryRecord({ installLocation: installationRoot }),
    inventoryRecord({
      displayName: "Pulse MD 1.0.0",
      kind: "uninstall",
      uninstallString: `"${installationRoot}\\Uninstall Pulse MD.exe" /allusers`,
    }),
  ]
}

function shellRecord(scope, overrides = {}) {
  const expectedCommand = '"C:\\Program Files\\Pulse MD\\Pulse MD.exe" "%1"'
  return {
    extensions: markdownExtensions.map((extension) => ({
      defaultValue: scope === "machine" ? "PulseMD.Markdown" : "",
      extension,
      openWithProgIdExists: scope === "machine",
    })),
    legacyMarkdown: {
      command: "",
      commandExists: false,
      exists: false,
    },
    markdown: {
      command: scope === "machine" ? expectedCommand : "",
      commandExists: scope === "machine",
      exists: scope === "machine",
    },
    protocol: {
      command: scope === "machine" ? expectedCommand : "",
      commandExists: scope === "machine",
      exists: scope === "machine",
      urlProtocolExists: scope === "machine",
    },
    scope,
    view: "Registry64",
    ...overrides,
  }
}

test("Windows installer identity follows the canonical builder appId", () => {
  assert.deepEqual(identity, {
    canonicalGuid: "102e1616-3f19-5f08-a24a-3a30fb60faaa",
    expectedRegistryView: "Registry64",
    legacyGuid: "04ac6e71-2cf6-508e-a700-447b1cbe0bb4",
  })
  assert.equal(identity.canonicalGuid, canonicalInstallerGuid)
  assert.equal(identity.legacyGuid, legacyInstallerGuid)
  assert.equal(
    windowsInstallerIdentity({ architecture: "ia32" }).expectedRegistryView,
    "Registry32"
  )
})

test("Windows installer identity rejects non-canonical and legacy configuration", () => {
  assert.throws(
    () =>
      windowsInstallerIdentity({
        architecture: "x64",
        configuration: { appId: "io.github.example.other" },
      }),
    /Refusing non-canonical Windows appId/
  )
  assert.throws(
    () =>
      windowsInstallerIdentity({
        architecture: "x64",
        configuration: { appId: canonicalAppId },
      }),
    /Configured NSIS GUID is unavailable/
  )
  assert.throws(
    () =>
      windowsInstallerIdentity({
        architecture: "x64",
        configuration: {
          appId: canonicalAppId,
          nsis: { guid: legacyInstallerGuid },
        },
      }),
    /legacy Pulse MD Local NSIS GUID/
  )
})

test("Windows installer invocation requests elevation and waits for completion", () => {
  const installer = "C:\\build output\\Pulse MD-1.0.0-x64.exe"
  const invocation = windowsInstallerInvocation(installer, {
    SYSTEMROOT: "C:\\Windows",
  })

  assert.equal(invocation.command, "powershell.exe")
  assert.deepEqual(invocation.args.slice(0, 3), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
  ])
  assert.equal(invocation.args[3], "-Command")
  assert.match(invocation.args[4], /Start-Process/)
  assert.match(invocation.args[4], /-Verb RunAs/)
  assert.match(invocation.args[4], /-Wait/)
  assert.match(invocation.args[4], /exit \$process\.ExitCode/)
  assert.equal(invocation.env[installerEnvironmentVariable], installer)
  assert.equal(invocation.env.SYSTEMROOT, "C:\\Windows")
})

test("Windows install inventory queries only canonical and legacy GUID keys", () => {
  const invocation = windowsInstallInventoryInvocation({
    environment: { SYSTEMROOT: "C:\\Windows" },
    identity,
  })

  assert.equal(invocation.command, "powershell.exe")
  assert.match(invocation.args[4], /OpenBaseKey/)
  assert.match(invocation.args[4], /Registry64/)
  assert.match(invocation.args[4], /Registry32/)
  assert.doesNotMatch(invocation.args[4], /Software\\\*/)
  assert.equal(
    invocation.env[canonicalGuidEnvironmentVariable],
    canonicalInstallerGuid
  )
  assert.equal(
    invocation.env[legacyGuidEnvironmentVariable],
    legacyInstallerGuid
  )
})

test("Windows install inventory parser validates records", () => {
  const records = canonicalInventory()
  assert.deepEqual(
    parseWindowsInstallInventory(JSON.stringify(records)),
    records
  )
  assert.deepEqual(parseWindowsInstallInventory(""), [])
  assert.throws(
    () => parseWindowsInstallInventory('{"kind":"install"}'),
    /must be an array/
  )
  assert.throws(
    () =>
      parseWindowsInstallInventory(
        JSON.stringify([inventoryRecord({ scope: "somewhere" })])
      ),
    /invalid scope/
  )
})

test("Windows install verification requires one matching machine pair", () => {
  assert.deepEqual(
    requireCanonicalWindowsInstallation(canonicalInventory(), identity),
    {
      installationRoot: "C:\\Program Files\\Pulse MD",
      registryView: "Registry64",
    }
  )

  assert.throws(
    () =>
      requireCanonicalWindowsInstallation(
        [...canonicalInventory(), inventoryRecord({ scope: "user" })],
        identity
      ),
    /duplicate or per-user/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsInstallation(
        [...canonicalInventory(), inventoryRecord({ view: "Registry32" })],
        identity
      ),
    /duplicate or per-user/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsInstallation(
        [
          ...canonicalInventory(),
          inventoryRecord({
            guid: legacyInstallerGuid,
            identity: "legacy",
            scope: "user",
          }),
        ],
        identity
      ),
    /legacy Pulse MD Local installation/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsInstallation(
        canonicalInventory().slice(0, 1),
        identity
      ),
    /one canonical machine install key and one uninstall key/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsInstallation(
        canonicalInventory().map((record) =>
          record.kind === "uninstall"
            ? {
                ...record,
                uninstallString:
                  '"D:\\Other\\Uninstall Pulse MD.exe" /allusers',
              }
            : record
        ),
        identity
      ),
    /install and uninstall keys disagree/
  )
})

test("Windows PATH inventory requires one canonical machine entry", () => {
  const invocation = windowsPathInventoryInvocation({
    SYSTEMROOT: "C:\\Windows",
  })
  assert.equal(invocation.command, "powershell.exe")
  assert.match(
    invocation.args[4],
    /GetEnvironmentVariable\('Path', 'Machine'\)/
  )
  assert.deepEqual(
    parseWindowsPathInventory(
      '{"machine":"C:\\\\Windows;C:\\\\Program Files\\\\Pulse MD\\\\resources\\\\bin","user":""}'
    ),
    {
      machine: "C:\\Windows;C:\\Program Files\\Pulse MD\\resources\\bin",
      user: "",
    }
  )

  const expected = "C:\\Program Files\\Pulse MD\\resources\\bin"
  assert.equal(
    requireCanonicalWindowsCliPath(
      {
        machine: "%ProgramFiles%\\Pulse MD\\resources\\bin",
        user: "C:\\Users\\reader\\bin",
      },
      expected,
      { ProgramFiles: "C:\\Program Files" }
    ),
    expected.toLowerCase()
  )
  assert.throws(
    () =>
      requireCanonicalWindowsCliPath(
        { machine: `${expected};${expected}`, user: "" },
        expected
      ),
    /found 2/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsCliPath(
        {
          machine: expected,
          user: "C:\\Users\\reader\\AppData\\Local\\Programs\\Pulse MD Local\\resources\\bin",
        },
        expected
      ),
    /competing Pulse MD CLI PATH entry/
  )
})

test("Windows shell inventory reads both scopes in the expected registry view", () => {
  const invocation = windowsShellInventoryInvocation({
    environment: { SYSTEMROOT: "C:\\Windows" },
    identity,
  })
  assert.equal(invocation.command, "powershell.exe")
  assert.equal(
    invocation.env[registryViewEnvironmentVariable],
    identity.expectedRegistryView
  )
  assert.match(invocation.args[4], /Software\\Classes\\pulse-md/)
  assert.match(invocation.args[4], /Software\\Classes\\PulseMD\.Markdown/)
  assert.match(invocation.args[4], /Software\\Classes\\Markdown document/)
  for (const extension of markdownExtensions) {
    assert.match(invocation.args[4], new RegExp(`'${extension}'`))
  }
})

test("Windows shell inventory parser validates nested records", () => {
  const records = [shellRecord("machine"), shellRecord("user")]
  assert.deepEqual(parseWindowsShellInventory(JSON.stringify(records)), records)
  assert.throws(() => parseWindowsShellInventory("{}"), /must be an array/)
  assert.throws(
    () =>
      parseWindowsShellInventory(
        JSON.stringify([
          shellRecord("machine", {
            protocol: { ...shellRecord("machine").protocol, exists: "yes" },
          }),
        ])
      ),
    /must be a boolean/
  )
  assert.throws(
    () =>
      parseWindowsShellInventory(
        JSON.stringify([
          shellRecord("machine", {
            legacyMarkdown: {
              command: "",
              commandExists: "yes",
              exists: true,
            },
          }),
        ])
      ),
    /must be a boolean/
  )
})

test("Windows shell verification requires exact canonical registrations", () => {
  const records = [shellRecord("machine"), shellRecord("user")]
  assert.equal(
    requireCanonicalWindowsShellRegistrations(
      records,
      "C:\\Program Files\\Pulse MD",
      identity
    ),
    '"C:\\Program Files\\Pulse MD\\Pulse MD.exe" "%1"'
  )

  assert.throws(
    () =>
      requireCanonicalWindowsShellRegistrations(
        [
          shellRecord("machine", {
            protocol: {
              ...shellRecord("machine").protocol,
              command: 'C:\\Program Files\\Pulse MD\\Pulse MD.exe "%1"',
            },
          }),
          shellRecord("user"),
        ],
        "C:\\Program Files\\Pulse MD",
        identity
      ),
    /URL registration is invalid/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsShellRegistrations(
        [
          shellRecord("machine", {
            protocol: {
              ...shellRecord("machine").protocol,
              urlProtocolExists: false,
            },
          }),
          shellRecord("user"),
        ],
        "C:\\Program Files\\Pulse MD",
        identity
      ),
    /URL registration is invalid/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsShellRegistrations(
        [
          shellRecord("machine", {
            extensions: shellRecord("machine").extensions.map((extension) =>
              extension.extension === "mdown"
                ? { ...extension, openWithProgIdExists: false }
                : extension
            ),
          }),
          shellRecord("user"),
        ],
        "C:\\Program Files\\Pulse MD",
        identity
      ),
    /extension registrations are incomplete/
  )
  for (const command of [
    'C:\\Program Files\\Pulse MD\\Pulse MD.exe "%1"',
    '"C:\\Users\\reader\\AppData\\Local\\Programs\\Pulse MD Local\\Pulse MD Local.exe" "%1"',
  ]) {
    assert.throws(
      () =>
        requireCanonicalWindowsShellRegistrations(
          [
            shellRecord("machine", {
              legacyMarkdown: {
                command,
                commandExists: true,
                exists: true,
              },
            }),
            shellRecord("user"),
          ],
          "C:\\Program Files\\Pulse MD",
          identity
        ),
      /Pulse MD-owned legacy Markdown document ProgID remains/
    )
  }

  assert.equal(
    requireCanonicalWindowsShellRegistrations(
      [
        shellRecord("machine", {
          legacyMarkdown: {
            command: '"C:\\Program Files\\Typora\\Typora.exe" "%1"',
            commandExists: true,
            exists: true,
          },
        }),
        shellRecord("user", {
          legacyMarkdown: {
            command: '"C:\\Program Files\\Typora\\Typora.exe" "%1"',
            commandExists: true,
            exists: true,
          },
        }),
      ],
      "C:\\Program Files\\Pulse MD",
      identity
    ),
    '"C:\\Program Files\\Pulse MD\\Pulse MD.exe" "%1"'
  )
  assert.throws(
    () =>
      requireCanonicalWindowsShellRegistrations(
        [
          shellRecord("machine"),
          shellRecord("user", {
            legacyMarkdown: {
              command:
                '"C:\\Users\\reader\\AppData\\Local\\Programs\\Pulse MD Local\\Pulse MD.exe" "%1"',
              commandExists: true,
              exists: true,
            },
          }),
        ],
        "C:\\Program Files\\Pulse MD",
        identity
      ),
    /per-user Pulse MD shell registration remains/
  )
  assert.throws(
    () =>
      requireCanonicalWindowsShellRegistrations(
        [
          shellRecord("machine"),
          shellRecord("user", {
            markdown: {
              command: '"C:\\Other\\Pulse MD.exe" "%1"',
              commandExists: true,
              exists: true,
            },
          }),
        ],
        "C:\\Program Files\\Pulse MD",
        identity
      ),
    /per-user Pulse MD shell registration remains/
  )
})
