# Building and installing Pulse MD

Build Pulse MD on the operating system where it will run. Cross-compilation is
not supported, and this repository deliberately has no hosted build pipeline.

Install [Node.js](https://nodejs.org/) 24 LTS when possible (22.13 or newer is
supported), then install the native prerequisites for the host:

- **macOS:** Xcode 26 or newer. Every macOS package compiles the checked-in
  Icon Composer document so the installed icon follows the system appearance.
- **Windows:** the x64 Node.js distribution, including on Windows-on-Arm, plus
  Visual Studio 2022 Build Tools with **Desktop development with C++**. Confirm
  `node -p process.arch` prints `x64`; Windows ARM packages are not part of the
  current development baseline. If a Restricted PowerShell policy blocks
  `npm.ps1`, use `npm.cmd` for every documented `npm` command.
- **Linux:** a C compiler available as `cc` plus `xdg-mime`, `xdg-settings`,
  `desktop-file-validate`, `update-desktop-database`, `update-mime-database`,
  `gtk-update-icon-cache`, `xmllint`, GNU `tar` with Zstandard support, and
  `bsdtar` from the distribution's ordinary build and desktop-integration
  packages. Native Arch packaging additionally requires `makepkg` and `pacman`.
  On Arch and Omarchy, `libxcrypt-compat` is required only by the
  electron-builder FPM runtime used to build the Debian-family `.deb`; the
  native Arch package and `npm run install:local` bypass FPM and do not use it.

## Source and community build

Build the canonical Pulse MD package from a clone or fork:

```sh
git clone https://github.com/mapleroyal/pulse-md.git
cd pulse-md
npm ci
npm run package
```

The command selects the host platform and writes installable artifacts to
`release/`: DMG and ZIP on macOS, an NSIS installer on Windows, and AppImage
and Debian packages on Linux. The AppImage is the portable,
cross-distribution download; the `.deb` is only for Debian-family systems.
On Linux, use a narrower command when only one format is needed:

```sh
npm run package:linux            # AppImage plus DEB
npm run package:linux:appimage   # AppImage only
npm run package:linux:deb        # Debian-family package only
npm run package:linux:arch       # Native Arch package only
```

The Arch command packages the prepared runtime with the checked-in `PKGBUILD`
template and `makepkg`, verifies its metadata and complete payload, and writes a
conventional `.pkg.tar.zst` artifact to `release/`. It deliberately bypasses
electron-builder's FPM-backed `pacman` target so the dependencies, installed
paths, launcher, `pmd` command, and package metadata remain explicit and
auditable. RPM and Flatpak packaging remain future work.

These commands neither upload anything nor require signing or storefront
credentials. Before promoting their artifacts, they exercise the unpacked
package's metadata, fuses, bundled resources, CLI, and a focused packaged
Electron workflow.

Linux packages install the Pulse MD application icon and register the app as a
Markdown handler. They deliberately do not replace the shared `text/markdown`
document artwork; the active desktop icon theme owns that common file-type
icon.

Every packaged build uses the same **Pulse MD** product identity, `pmd` helper,
user data, single-instance endpoint, file associations, and `pulse-md` scratch
link scheme. This includes source/community builds, signed direct downloads,
and future platform-store builds. They are alternate sources for one installed
application, not applications that should coexist. The JavaScript dependency
graph is pinned by `package-lock.json`, but builds are not promised to be
bit-for-bit reproducible across toolchains.

Keep only one installed copy of Pulse MD. Runnable copies with the same
identity can compete for launch, link, file-association, and CLI requests:

- On macOS, quit Pulse MD, replace the stable
  `/Applications/Pulse MD.app`, and eject its DMG before launching it. Do not
  retain runnable Pulse MD app bundles in Downloads, Trash, staging, or an
  unpacked ZIP; retaining the DMG or ZIP itself is safe.
- On Windows, upgrade by running the new all-users NSIS installer rather than
  choosing another install location.
- On Arch and its derivatives, prefer one native `pulse-md` package tracked by
  `pacman`. On other Linux systems, use the stable user-local runtime at
  `~/.local/lib/pulse-md`, one independently installed Debian package, or one
  AppImage at a stable path. Replace the old copy rather than retaining
  multiple runnable packages.

For ordinary project delivery, use the same-OS installed verification wrapper:

```sh
npm run install:local
```

On macOS it compiles the adaptive icon, builds the canonical package, replaces
`/Applications/Pulse MD.app`, cleans stale canonical registrations and managed
runnable copies, and verifies the installed app. On Windows it builds and runs
the all-users NSIS installer so normal file associations are installed. On
Arch and Omarchy it builds the native `.pkg.tar.zst`, installs it through
`pacman`, verifies package ownership plus the installed runtime and CLI, and
removes only validated files from the superseded user-local Linux layout. A
terminal invocation uses `sudo`; a noninteractive graphical invocation may use
the desktop authorization prompt. On other Linux systems the command retains
the user-local lane: it transactionally replaces `~/.local/lib/pulse-md`,
installs `pmd` in `~/.local/bin`, and registers desktop integration under the
user's XDG directories without privilege. Windows and Linux must be verified on
their respective operating systems.

Every packaged build provides the CLI as `pmd`. The native Arch package owns
`/usr/bin/pmd`, and `install:local` installs it automatically on Linux.
Independently installed AppImages, Debian packages, and macOS builds provide
**Install Command Line Tool…** in Pulse MD. The Windows installer adds its
command to the machine-wide `PATH`. Open a new terminal if needed, then verify
it:

```sh
pmd doctor
pmd notes.md
```

See the [CLI reference](CLI.md) for all commands.

## Development run

```sh
npm ci
npm run dev
```

Development runs use **Pulse MD Development**, with state and a CLI endpoint
separate from the packaged identity. While developing, send commands to that
checkout-scoped instance with:

```sh
npm run cli:dev -- doctor
npm run cli:dev -- notes.md
```

Run the narrow tests relevant to a change while iterating, then use:

```sh
npm run check       # formatting, lint, tests, build, and bundle budgets
npm run check:full  # the above plus Electron end-to-end tests
```

## Maintainer installed candidate on macOS

Use this macOS-specific lane when the project owner needs the stricter
installed-integration and Launch Services audit without creating a
distributable release:

```sh
npm run install:mac:dev
```

The command compiles the adaptive icon, builds an ad-hoc-signed, explicitly
non-distributable candidate, replaces `/Applications/Pulse MD.app`, removes
validated duplicate canonical-identifier bundles from managed locations, and
checks Launch Services registration. Quit Pulse MD first and do not distribute
its output.

After installation, verify relevant Finder/file-association, `pulse-md`, and
`pmd` behavior against `/Applications/Pulse MD.app`. This command and
`npm run install:local` deliberately converge on the same installed app; the
maintainer lane does not create or preserve a second product identity.

## Signed direct-distribution builds

The direct-distribution commands run only on their matching operating system,
never publish automatically, stage output in a fresh directory, validate it,
and promote successful artifacts to a versioned
`release/official-<platform>-<architecture>-<version>/` directory:

```sh
npm run build:mac
npm run build:win
npm run build:linux
```

- `build:mac` requires Xcode 26 or newer, a **Developer ID Application**
  identity, and exactly one complete `notarytool` credential method: the
  `APPLE_API_*` triplet, the `APPLE_ID` triplet, or
  `APPLE_KEYCHAIN_PROFILE`. It signs, notarizes, staples, and verifies the app,
  DMG, and ZIP; missing credentials are a hard failure.
- `build:win` requires `WIN_CSC_LINK` (or `CSC_LINK`), signs all shipped native
  executables and the NSIS installer, and rejects missing, invalid, or
  untimestamped signatures.
- `build:linux` produces AppImage and Debian artifacts. The native Arch
  source/community artifact is produced separately with
  `npm run package:linux:arch`, using `PKGBUILD` and `makepkg` so the installed
  package is tracked by `pacman`. Build on an intentionally chosen baseline and
  test every distribution and architecture you intend to claim. No current
  command produces RPM or Flatpak artifacts.

Each successful direct-distribution build verifies the contents of its
distributable artifacts, removes duplicate staging candidates, and retains only
the artifacts plus SHA-256 checksums. Before distributing an artifact, run
`npm run check:full` and test the actual install, upgrade, integrations, and
uninstall on a clean machine. Store-specific packages are separate future work
and are not produced by these commands.

`private: true` in `package.json` prevents accidental npm publication. It does
not change the source license in [LICENSE](../LICENSE).

## Common failures

- `npm ci` exits when `package.json` and the committed lockfile disagree; do
  not replace the lockfile casually.
- A native compiler error usually means a platform prerequisite is missing.
- `release/`, `dist/`, `dist-electron/`, and `dist-native/` are generated and
  ignored by Git.
- A signed macOS or Windows build that lacks release credentials is expected
  to fail; use `npm run package` for a locally ad-hoc-signed macOS build or the
  platform's ordinary unsigned source package elsewhere.
