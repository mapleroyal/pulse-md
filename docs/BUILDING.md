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
- **Linux:** a C compiler available as `cc` (`build-essential` or the
  distribution equivalent).

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
and Debian packages on Linux. It neither uploads anything nor requires signing
or storefront credentials. Before promoting the artifacts, it exercises the
unpacked package's metadata, fuses, bundled resources, CLI, and a focused
packaged Electron workflow.

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
- On Linux, choose one installed Debian package or one AppImage at a stable
  path and replace the old copy when rebuilding.

For ordinary project delivery, use the same-OS installed verification wrapper:

```sh
npm run install:local
```

On macOS it compiles the adaptive icon, builds the canonical package, replaces
`/Applications/Pulse MD.app`, cleans stale canonical registrations and managed
runnable copies, and verifies the installed app. On Windows it builds and runs
the all-users NSIS installer so normal file associations are installed. On
Linux it builds the Debian package and prints the exact package-manager command
for the user to review and run; it does not invoke `sudo` itself. Windows and
Linux must be verified on their respective operating systems.

Every packaged build provides the CLI as `pmd`. On macOS and Linux, use
**Install Command Line Tool…** in Pulse MD; the Windows installer adds its
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
- `build:linux` produces AppImage and Debian artifacts. Build on an
  intentionally chosen baseline and test every distribution and architecture
  you intend to claim.

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
