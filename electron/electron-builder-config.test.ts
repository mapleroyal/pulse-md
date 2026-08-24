import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"

import { describe, expect, it } from "vitest"

import { WINDOWS_APP_USER_MODEL_ID } from "./distribution-identity"
import {
  COMMON_TEXT_DOCUMENT_EXTENSIONS,
  MARKDOWN_DOCUMENT_EXTENSIONS,
} from "../src/shared/document-kind"

interface FileAssociation {
  description?: string
  ext: string[]
  name?: string
  rank?: string
  role?: string
}

interface ExtraResource {
  from: string
  to: string
}

interface TargetConfiguration {
  arch?: string | string[]
  target: string
}

interface BuilderConfiguration {
  appId?: string
  afterExtract?: string
  afterPack?: string
  dmg?: { icon?: string }
  deb?: { packageName?: string }
  executableName?: string
  electronDownload?: {
    checksums?: Record<string, string>
    unsafelyDisableChecksums?: boolean
  }
  extraMetadata?: Record<string, unknown>
  fileAssociations?: FileAssociation[]
  files?: string[]
  linux?: {
    desktop?: { entry?: Record<string, string> }
    executableName?: string
    extraResources?: ExtraResource[]
    icon?: string
    syncDesktopName?: boolean
  }
  protocols?: Array<{ name?: string; schemes?: string[] }>
  mac?: {
    binaries?: string[]
    extraResources?: ExtraResource[]
    fileAssociations?: FileAssociation[]
    icon?: string
    identity?: string | null
  }
  nsis?: {
    guid?: string
    include?: string
    perMachine?: boolean
    runAfterFinish?: boolean
  }
  productName?: string
  win?: {
    extraResources?: ExtraResource[]
    icon?: string
    signExts?: string[]
    target?: string | TargetConfiguration | Array<string | TargetConfiguration>
  }
}

const require = createRequire(import.meta.url)

function builderConfiguration(): BuilderConfiguration {
  return require("../electron-builder.config.cjs") as BuilderConfiguration
}

function localBuilderConfiguration(): BuilderConfiguration {
  return require("../electron-builder.local.cjs") as BuilderConfiguration
}

describe("electron-builder configuration", () => {
  it("uses each platform's native icon asset pipeline", async () => {
    const configuration = await builderConfiguration()
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { desktopName?: string }

    expect(configuration).toMatchObject({
      afterExtract: "scripts/after-extract.mjs",
      afterPack: "scripts/after-pack.mjs",
      dmg: { icon: "build/pulse-md.icns" },
      linux: {
        icon: "build/icons/linux",
        syncDesktopName: true,
      },
      mac: { icon: "build/pulse-md.icon" },
      win: { icon: "build/icons/windows/pulse-md.ico" },
    })
    expect(configuration.linux?.extraResources).toContainEqual({
      from: "build/icons/linux/512x512.png",
      to: "icons/pulse-md.png",
    })
    expect(metadata.desktopName).toBe("pulse-md.desktop")
  })

  it("ships complete native Windows and Linux icon sets", async () => {
    const ico = await readFile(
      new URL("../build/icons/windows/pulse-md.ico", import.meta.url)
    )
    expect([
      ico.readUInt16LE(0),
      ico.readUInt16LE(2),
      ico.readUInt16LE(4),
    ]).toEqual([0, 1, 9])
    expect(
      Array.from({ length: 9 }, (_, index) => {
        const encodedSize = ico.readUInt8(6 + index * 16)
        return encodedSize === 0 ? 256 : encodedSize
      })
    ).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256])

    const linuxDirectory = new URL("../build/icons/linux/", import.meta.url)
    const expectedSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512]
    const filenames = (await readdir(linuxDirectory))
      .filter((filename) => filename.endsWith(".png"))
      .sort(
        (left, right) =>
          Number(left.split("x")[0]) - Number(right.split("x")[0])
      )
    expect(filenames).toEqual(
      expectedSizes.map((size) => `${size}x${size}.png`)
    )

    for (const [index, filename] of filenames.entries()) {
      const png = await readFile(new URL(filename, linuxDirectory))
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        expectedSizes[index],
        expectedSizes[index],
      ])
      expect([png.readUInt8(24), png.readUInt8(25)]).toEqual([8, 6])
    }
  })

  it("pins every Windows package to x64", () => {
    const expectedTarget = [{ arch: ["x64"], target: "nsis" }]

    expect(builderConfiguration().win?.target).toEqual(expectedTarget)
    expect(localBuilderConfiguration().win?.target).toEqual(expectedTarget)
  })

  it("keeps Markdown global and adds alternate text/code editing on macOS", async () => {
    const configuration = await builderConfiguration()
    const markdown = configuration.fileAssociations?.find(
      ({ name }) => name === "PulseMD.Markdown"
    )
    const macText = configuration.mac?.fileAssociations?.find(
      ({ name }) => name === "Plain text and code document"
    )

    expect(markdown?.ext).toEqual([...MARKDOWN_DOCUMENT_EXTENSIONS])
    expect(markdown?.description).toBe("Markdown document")
    expect(markdown?.role).toBe("Editor")
    expect(macText).toMatchObject({
      rank: "Alternate",
      role: "Editor",
    })
    expect(macText?.ext).toEqual([...COMMON_TEXT_DOCUMENT_EXTENSIONS])
  })

  it("owns and safely removes its Windows shell registrations", async () => {
    const configuration = await builderConfiguration()
    const markdown = configuration.fileAssociations?.find(
      ({ name }) => name === "PulseMD.Markdown"
    )
    const installerInclude = await readFile(
      new URL("../build/installer.nsh", import.meta.url),
      "utf8"
    )

    expect(configuration.nsis?.guid).toBe(
      "102e1616-3f19-5f08-a24a-3a30fb60faaa"
    )
    expect(configuration.appId).toBe(WINDOWS_APP_USER_MODEL_ID)
    expect(markdown).toMatchObject({
      description: "Markdown document",
      name: "PulseMD.Markdown",
    })
    expect(
      configuration.fileAssociations?.map(({ name }) => name)
    ).not.toContain("Markdown document")
    expect(installerInclude).toContain(
      'WriteRegStr SHCTX "Software\\Classes\\PulseMD.Markdown\\shell\\open\\command" "" \'$\\"$appExe$\\" $\\"%1$\\"\''
    )
    expect(installerInclude).toContain(
      'WriteRegStr SHCTX "Software\\Classes\\pulse-md\\shell\\open\\command" "" \'$\\"$appExe$\\" $\\"%1$\\"\''
    )
    expect(installerInclude).not.toContain(
      'DeleteRegKey SHCTX "Software\\Classes\\Markdown document"'
    )

    const cleanedExtensions = [
      ...installerInclude.matchAll(
        /!insertmacro removePmdFileAssociation "([^"]+)"/g
      ),
    ].map((match) => match[1])
    expect(cleanedExtensions).toEqual(markdown?.ext)
    expect(installerInclude).toContain(
      'ReadRegStr $R6 SHCTX "Software\\Classes\\.${extension}" ""'
    )
    expect(installerInclude).toContain('${If} $R6 == "PulseMD.Markdown"')
    expect(installerInclude).toContain(
      'DeleteRegValue SHCTX "Software\\Classes\\.${extension}" ""'
    )
    expect(installerInclude).toContain(
      'DeleteRegValue SHCTX "Software\\Classes\\.${extension}\\OpenWithProgids" "PulseMD.Markdown"'
    )
    expect(installerInclude).toContain(
      'DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${extension}"'
    )
    expect(installerInclude).toContain(
      'DeleteRegKey SHCTX "Software\\Classes\\PulseMD.Markdown"'
    )
    expect(installerInclude).toContain('${If} $installMode == "all"')
    expect(installerInclude).toContain(
      'DeleteRegKey HKCU "Software\\Classes\\PulseMD.Markdown"'
    )
    expect(installerInclude).toContain(
      'DeleteRegKey HKCU "Software\\Classes\\pulse-md"'
    )
    expect(installerInclude).toContain(
      'DeleteRegValue HKCU "Software\\Classes\\.${extension}\\OpenWithProgids" "PulseMD.Markdown"'
    )
    expect(installerInclude).toContain("!insertmacro UPDATEFILEASSOC")
  })

  it("verifies Electron downloads from the package's pinned checksums", () => {
    const configuration = builderConfiguration()
    const metadata = require("electron/package.json") as { version: string }
    const artifactPrefix = `electron-v${metadata.version}-`

    expect(configuration.electronDownload?.unsafelyDisableChecksums).toBe(false)
    expect(
      Object.keys(configuration.electronDownload?.checksums ?? {}).some(
        (name) => name.startsWith(artifactPrefix)
      )
    ).toBe(true)
  })

  it("signs every shipped Windows PE file in official builds", async () => {
    const configuration = await builderConfiguration()

    expect(configuration.win?.signExts).toEqual([".exe", ".dll", ".node"])
  })

  it("packages exact notices for the bundled main-process ZIP stack", async () => {
    const configuration = await builderConfiguration()
    const notices = await readFile(
      new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
      "utf8"
    )

    expect(configuration.files).toContain("THIRD_PARTY_NOTICES.md")
    for (const packageName of ["yauzl", "yazl", "buffer-crc32", "pend"]) {
      const packageRoot = new URL(
        `../node_modules/${packageName}/`,
        import.meta.url
      )
      const metadata = JSON.parse(
        await readFile(new URL("package.json", packageRoot), "utf8")
      ) as { name: string; version: string }
      const license = await readFile(new URL("LICENSE", packageRoot), "utf8")

      expect(metadata.name).toBe(packageName)
      expect(notices).toContain(`\`${packageName}\` ${metadata.version}`)
      expect(notices).toContain(license.trim())
    }
  })

  it("registers scratch links with the operating system", async () => {
    const configuration = await builderConfiguration()

    expect(configuration.protocols).toContainEqual({
      name: "Pulse MD Scratch Link",
      schemes: ["pulse-md"],
    })
    expect(configuration.extraMetadata?.pmdDistributionChannel).toBe(
      "canonical"
    )
  })

  it("keeps source packages on the canonical product identity", () => {
    const configuration = localBuilderConfiguration()

    expect(configuration).toMatchObject({
      appId: WINDOWS_APP_USER_MODEL_ID,
      extraMetadata: {
        pmdDistributionChannel: "canonical",
      },
      productName: "Pulse MD",
      protocols: [
        {
          name: "Pulse MD Scratch Link",
          schemes: ["pulse-md"],
        },
      ],
      nsis: {
        guid: "102e1616-3f19-5f08-a24a-3a30fb60faaa",
        include: "build/installer.nsh",
        perMachine: true,
        runAfterFinish: false,
      },
    })
    expect(configuration.mac?.identity).toBe("-")
    expect(configuration.mac?.icon).toBe("build/pulse-md.icon")
    expect(configuration.mac?.extraResources).toEqual([
      {
        from: "dist-native/macos-window-blur.node",
        to: "native/macos-window-blur.node",
      },
      {
        from: "dist-native/darwin/bin/pmd",
        to: "bin/pmd",
      },
    ])
    expect(configuration.mac?.binaries).toEqual([
      "Contents/Resources/native/macos-window-blur.node",
      "Contents/Resources/bin/pmd",
    ])
    expect(configuration.win?.extraResources).toEqual([
      {
        from: "dist-native/win32/windows-window-blur.node",
        to: "native/windows-window-blur.node",
      },
      {
        from: "dist-native/win32/bin/pmd.exe",
        to: "bin/pmd.exe",
      },
    ])
    expect(configuration.linux?.extraResources).toEqual([
      {
        from: "build/icons/linux/512x512.png",
        to: "icons/pulse-md.png",
      },
      {
        from: "dist-native/linux/bin/pmd",
        to: "bin/pmd",
      },
    ])
    expect(configuration.linux?.executableName).toBe("pulse-md")
    expect(configuration.deb?.packageName).toBe("pulse-md")
    expect(configuration.linux?.desktop?.entry).toMatchObject({
      Name: "Pulse MD",
      StartupWMClass: "pulse-md",
    })
    expect(JSON.stringify(configuration)).not.toContain("pmd-local")
  })
})
