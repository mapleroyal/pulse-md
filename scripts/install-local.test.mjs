import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  LinuxInstallTransaction,
  LinuxRemovalTransaction,
  archLinuxInstallLayout,
  archPacmanInstallInvocation,
  isArchLinuxRelease,
  linuxDesktopEntry,
  linuxInstallLayout,
  linuxMimePackage,
} from "./install-local.mjs"

test("Arch-family detection follows os-release ID and ID_LIKE", () => {
  assert.equal(isArchLinuxRelease('ID="arch"\n'), true)
  assert.equal(isArchLinuxRelease('ID=omarchy\nID_LIKE="arch"\n'), true)
  assert.equal(isArchLinuxRelease('ID=ubuntu\nID_LIKE="debian"\n'), false)
})

test("Arch installation uses package-owned system paths", () => {
  const layout = archLinuxInstallLayout()
  assert.equal(layout.installationRoot, "/opt/pulse-md")
  assert.equal(layout.executable, "/opt/pulse-md/pulse-md")
  assert.equal(layout.helper, "/opt/pulse-md/resources/bin/pmd")
  assert.equal(layout.command, "/usr/bin/pulse-md")
  assert.equal(layout.cli, "/usr/bin/pmd")
  assert.equal(
    layout.desktop,
    "/usr/share/applications/io.github.mapleroyal.pulse-md.desktop"
  )
  assert.equal(
    layout.mimePackage,
    "/usr/share/mime/packages/io.github.mapleroyal.pulse-md.xml"
  )
  assert.deepEqual(
    [...layout.icons.keys()],
    [16, 24, 32, 48, 64, 96, 128, 256, 512]
  )
})

test("Arch package installation uses pacman with an absolute artifact", () => {
  assert.deepEqual(
    archPacmanInstallInvocation("/tmp/pulse-md.pkg.tar.zst", {
      effectiveUserId: 0,
    }),
    ["/usr/bin/pacman", ["-U", "--noconfirm", "/tmp/pulse-md.pkg.tar.zst"]]
  )
  assert.deepEqual(
    archPacmanInstallInvocation("/tmp/pulse-md.pkg.tar.zst", {
      effectiveUserId: 1000,
      environment: {},
      interactive: true,
    }),
    [
      "/usr/bin/sudo",
      ["/usr/bin/pacman", "-U", "--noconfirm", "/tmp/pulse-md.pkg.tar.zst"],
    ]
  )
  assert.throws(
    () => archPacmanInstallInvocation("relative.pkg.tar.zst"),
    /must be absolute/
  )
})

test("Linux install layout uses one stable user-local application", () => {
  const layout = linuxInstallLayout({
    configHome: "/example/config",
    dataHome: "/example/data",
    homeDirectory: "/home/example",
  })

  assert.equal(layout.installationRoot, "/home/example/.local/lib/pulse-md")
  assert.equal(layout.executable, "/home/example/.local/lib/pulse-md/pulse-md")
  assert.equal(
    layout.helper,
    "/home/example/.local/lib/pulse-md/resources/bin/pmd"
  )
  assert.equal(layout.cli, "/home/example/.local/bin/pmd")
  assert.equal(
    layout.desktop,
    "/example/data/applications/io.github.mapleroyal.pulse-md.desktop"
  )
  assert.equal(
    layout.mimePackage,
    "/example/data/mime/packages/io.github.mapleroyal.pulse-md.xml"
  )
  assert.deepEqual(
    [...layout.icons.keys()],
    [16, 24, 32, 48, 64, 96, 128, 256, 512]
  )
})

test("Linux desktop entry has canonical Wayland and XDG integration", () => {
  const entry = linuxDesktopEntry(
    "/home/Example User/.local/lib/pulse-md/pulse-md"
  )

  assert.match(
    entry,
    /^Exec="\/home\/Example User\/\.local\/lib\/pulse-md\/pulse-md" %U$/m
  )
  assert.match(entry, /^StartupWMClass=io\.github\.mapleroyal\.pulse-md$/m)
  assert.match(entry, /^Categories=Utility;TextEditor;$/m)
  assert.match(entry, /^MimeType=text\/markdown;x-scheme-handler\/pulse-md;$/m)
  assert.match(entry, /^Icon=pulse-md$/m)

  const ordinaryEntry = linuxDesktopEntry(
    "/home/example/.local/lib/pulse-md/pulse-md"
  )
  assert.match(
    ordinaryEntry,
    /^Exec=\/home\/example\/\.local\/lib\/pulse-md\/pulse-md %U$/m
  )
})

test("Linux MIME package adds only the missing mdown Markdown alias", () => {
  const mimePackage = linuxMimePackage()

  assert.match(mimePackage, /mime-type type="text\/markdown"/)
  assert.match(mimePackage, /glob pattern="\*\.mdown" weight="80"/)
  assert.doesNotMatch(mimePackage, /\*\.md"/)
})

test("Linux install transaction restores every previous target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-md-install-test-"))
  const first = path.join(root, "first")
  const second = path.join(root, "nested", "second")
  const validateFile = (target) => {
    assert.equal(existsSync(target), true)
  }
  try {
    await writeFile(first, "previous\n")
    const transaction = new LinuxInstallTransaction("test-token")
    transaction.stage({
      create: (incoming) => writeFileSync(incoming, "replacement\n"),
      target: first,
      validateExisting: validateFile,
      validateIncoming: validateFile,
    })
    transaction.stage({
      create: (incoming) => writeFileSync(incoming, "new\n"),
      target: second,
      validateExisting: validateFile,
      validateIncoming: validateFile,
    })

    transaction.apply()
    assert.equal(await readFile(first, "utf8"), "replacement\n")
    assert.equal(await readFile(second, "utf8"), "new\n")

    transaction.rollback()
    assert.equal(await readFile(first, "utf8"), "previous\n")
    assert.equal(existsSync(second), false)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("Linux removal transaction restores managed targets until commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-md-removal-test-"))
  const runtime = path.join(root, "runtime")
  const command = path.join(root, "pmd")
  const validate = (target) => assert.equal(existsSync(target), true)
  try {
    await mkdir(runtime)
    await writeFile(path.join(runtime, "marker"), "runtime\n")
    await writeFile(command, "command\n")

    const rollback = new LinuxRemovalTransaction("rollback-token")
    rollback.stage({ target: runtime, validateExisting: validate })
    rollback.stage({ target: command, validateExisting: validate })
    rollback.apply()
    assert.equal(existsSync(runtime), false)
    assert.equal(existsSync(command), false)
    rollback.rollback()
    assert.equal(
      await readFile(path.join(runtime, "marker"), "utf8"),
      "runtime\n"
    )
    assert.equal(await readFile(command, "utf8"), "command\n")

    const committed = new LinuxRemovalTransaction("commit-token")
    committed.stage({ target: runtime, validateExisting: validate })
    committed.stage({ target: command, validateExisting: validate })
    committed.apply()
    committed.commit()
    assert.equal(existsSync(runtime), false)
    assert.equal(existsSync(command), false)
    assert.equal(
      readdirSync(root).some((entry) =>
        entry.includes("previous-commit-token")
      ),
      false
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test(
  "Linux upgrade caches ignore rollback backups",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pulse-md-upgrade-cache-test-")
    )
    const dataHome = path.join(root, "share")
    const applications = path.join(dataHome, "applications")
    const mimeRoot = path.join(dataHome, "mime")
    const mimePackages = path.join(mimeRoot, "packages")
    const iconRoot = path.join(dataHome, "icons", "hicolor")
    const iconDirectory = path.join(iconRoot, "16x16", "apps")
    const desktop = path.join(
      applications,
      "io.github.mapleroyal.pulse-md.desktop"
    )
    const mimePackage = path.join(
      mimePackages,
      "io.github.mapleroyal.pulse-md.xml"
    )
    const icon = path.join(iconDirectory, "pulse-md.png")
    const iconSource = path.resolve(
      import.meta.dirname,
      "..",
      "build",
      "icons",
      "linux",
      "16x16.png"
    )
    const desktopSource = (mimeType) =>
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Pulse MD",
        "Exec=/bin/true %U",
        `MimeType=${mimeType};`,
        "",
      ].join("\n")
    const mimeSource = (mimeType, extension) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
        `  <mime-type type="${mimeType}">`,
        "    <comment>Pulse MD cache test</comment>",
        `    <glob pattern="*.${extension}"/>`,
        "  </mime-type>",
        "</mime-info>",
        "",
      ].join("\n")

    try {
      await Promise.all([
        mkdir(applications, { recursive: true }),
        mkdir(mimePackages, { recursive: true }),
        mkdir(iconDirectory, { recursive: true }),
      ])
      await Promise.all([
        writeFile(desktop, desktopSource("application/x-pulse-old")),
        writeFile(
          mimePackage,
          mimeSource("application/x-pulse-old", "old-pulse-md")
        ),
      ])
      copyFileSync(iconSource, icon)

      const transaction = new LinuxInstallTransaction("cache-test")
      const stageFile = (target, contents) =>
        transaction.stage({
          create: (incoming) => writeFileSync(incoming, contents),
          target,
          validateExisting: (existing) =>
            assert.equal(existsSync(existing), true),
          validateIncoming: (incoming) =>
            assert.equal(existsSync(incoming), true),
        })
      stageFile(desktop, desktopSource("application/x-pulse-new"))
      stageFile(
        mimePackage,
        mimeSource("application/x-pulse-new", "new-pulse-md")
      )
      transaction.stage({
        create: (incoming) => copyFileSync(iconSource, incoming),
        target: icon,
        validateExisting: (existing) =>
          assert.equal(existsSync(existing), true),
        validateIncoming: (incoming) =>
          assert.equal(existsSync(incoming), true),
      })
      transaction.apply()

      const backups = readdirSync(dataHome, { recursive: true })
        .map((entry) => String(entry))
        .filter((entry) => entry.includes(".previous-cache-test"))
      assert.equal(backups.length, 3)
      assert.equal(
        backups.some((entry) => /\.(?:desktop|png|xml)$/u.test(entry)),
        false
      )

      const cacheEnvironment = { ...process.env, XDG_DATA_HOME: dataHome }
      execFileSync("update-mime-database", [mimeRoot], {
        env: cacheEnvironment,
      })
      execFileSync("update-desktop-database", [applications], {
        env: cacheEnvironment,
      })
      execFileSync("gtk-update-icon-cache", ["-f", "-t", iconRoot], {
        env: cacheEnvironment,
      })

      const desktopCache = await readFile(
        path.join(applications, "mimeinfo.cache"),
        "utf8"
      )
      assert.match(desktopCache, /application\/x-pulse-new=/u)
      assert.doesNotMatch(desktopCache, /application\/x-pulse-old=/u)
      const mimeGlobs = await readFile(path.join(mimeRoot, "globs2"), "utf8")
      assert.match(mimeGlobs, /\*\.new-pulse-md/u)
      assert.doesNotMatch(mimeGlobs, /\*\.old-pulse-md/u)
      const iconCache = await readFile(path.join(iconRoot, "icon-theme.cache"))
      assert.equal(
        iconCache.includes(Buffer.from("previous-cache-test")),
        false
      )

      transaction.commit()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
)

test(
  "commit cleanup failure cannot roll back targets with deleted backups",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pulse-md-commit-failure-test-")
    )
    const firstDirectory = path.join(root, "first")
    const secondDirectory = path.join(root, "second")
    const first = path.join(firstDirectory, "target")
    const second = path.join(secondDirectory, "target")
    try {
      await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
      await Promise.all([
        writeFile(first, "old first\n"),
        writeFile(second, "old second\n"),
      ])
      const transaction = new LinuxInstallTransaction("commit-test")
      for (const [target, contents] of [
        [first, "new first\n"],
        [second, "new second\n"],
      ]) {
        transaction.stage({
          create: (incoming) => writeFileSync(incoming, contents),
          target,
          validateExisting: (existing) =>
            assert.equal(existsSync(existing), true),
          validateIncoming: (incoming) =>
            assert.equal(existsSync(incoming), true),
        })
      }
      transaction.apply()
      await chmod(secondDirectory, 0o500)
      assert.throws(
        () => transaction.commit(),
        /Committed installation cleanup failed/u
      )
      transaction.rollback()
      assert.equal(await readFile(first, "utf8"), "new first\n")
      assert.equal(await readFile(second, "utf8"), "new second\n")

      await chmod(secondDirectory, 0o700)
      transaction.commit()
      assert.equal(
        readdirSync(root, { recursive: true }).some((entry) =>
          String(entry).includes(".previous-commit-test")
        ),
        false
      )
    } finally {
      await chmod(secondDirectory, 0o700).catch(() => {})
      await rm(root, { force: true, recursive: true })
    }
  }
)
