# Building and installing Pulse MD

Build Pulse MD on the operating system where it will run. Cross-compilation is
not supported, and this repository deliberately has no hosted build pipeline.

Install [Node.js](https://nodejs.org/) 24 LTS when possible (22.13 or newer is
supported), then install the native prerequisites for the host:

- **macOS:** Xcode Command Line Tools. Xcode 26 or newer is required only to
  rebuild the Icon Composer source or make an official package.
- **Windows:** Visual Studio 2022 Build Tools with **Desktop development with
  C++**.
- **Linux:** a C compiler available as `cc` (`build-essential` or the
  distribution equivalent).

## Personal and community build

Use the isolated Local channel for a noncommercial build from a clone or fork:

```sh
git clone https://github.com/mapleroyal/pulse-md.git
cd pulse-md
npm ci
npm run package
```

The command selects the host platform and writes installable artifacts to
`release/`: DMG and ZIP on macOS, an NSIS installer on Windows, and AppImage
and Debian packages on Linux. It neither uploads anything nor requires signing
or storefront credentials.

The resulting **Pulse MD Local** app has its own product and application
identity, user data, single-instance/CLI endpoint, and `pmd-local` helper. It
does not claim the official app's file associations or `pulse-md` URL scheme;
Local scratch links use the separate `pulse-md-local` scheme. It can therefore
coexist with an official installation. The JavaScript dependency
graph is pinned by `package-lock.json`, but builds are not promised to be
bit-for-bit reproducible across toolchains.

Keep only one installed copy of Pulse MD Local. Copies with the same Local
identity can compete for launch and CLI requests even when an official app is
unaffected:

- On macOS, quit Local, replace the stable
  `/Applications/Pulse MD Local.app`, and eject its DMG before launching it.
  Do not retain runnable Local app bundles in Downloads, Trash, staging, or an
  unpacked ZIP; retaining the DMG or ZIP itself is safe.
- On Windows, upgrade by running the new per-user NSIS installer rather than
  choosing another install location.
- On Linux, choose one installed Debian package or one AppImage at a stable
  path and replace the old copy when rebuilding.

For ordinary project delivery, use the same-OS installed verification wrapper:

```sh
npm run install:local
```

On macOS it builds the Local package, replaces
`/Applications/Pulse MD Local.app`, cleans stale Local registrations and
managed runnable copies, and verifies the installed app. On Windows it builds
and runs the per-user NSIS installer. On Linux it builds the Debian package and
prints the exact package-manager command for the user to review and run; it
does not invoke `sudo` itself. Windows and Linux must be verified on their
respective operating systems.

Packaged Local builds provide their isolated CLI as `pmd-local`. On macOS and
Linux, use **Install Command Line Tool…** in Pulse MD Local; the Windows Local
installer adds its command to the user's `PATH`. Open a new terminal if needed,
then verify the resolved identity with:

```sh
pmd-local doctor
pmd-local notes.md
```

See the [CLI reference](CLI.md) for all commands and the identity differences.

## Development run

```sh
npm ci
npm run dev
```

Development runs use **Pulse MD Development**, with state and a CLI endpoint
separate from both packaged identities. While developing, send commands to
that instance with:

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

Use this lane only when the project owner needs to exercise the production
identity and installed integrations without creating a distributable release:

```sh
npm run install:mac:dev
```

The command builds an ad-hoc-signed, explicitly non-distributable candidate,
replaces `/Applications/Pulse MD.app`, removes validated duplicate
production-identifier bundles from managed locations, and checks Launch
Services registration. It intentionally occupies the official app's identity;
quit Pulse MD first and do not distribute its output.

After installation, verify relevant Finder/file-association, `pulse-md`, and
`pmd` behavior against `/Applications/Pulse MD.app`. This installed-candidate
lane is separate from `npm run install:local`, which is used for ordinary
delivery checks.

## Official distribution builds

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

Each successful official build verifies its staged runnable package, removes
that duplicate installation candidate, and retains only distributable
artifacts plus SHA-256 checksums. Before distributing an artifact, run
`npm run check:full` and test the actual install, upgrade, integrations, and
uninstall on a clean machine. Store-specific packages are separate future
work and are not produced by these commands.

`private: true` in `package.json` prevents accidental npm publication. It does
not change the source license in [LICENSE](../LICENSE).

## Common failures

- `npm ci` exits when `package.json` and the committed lockfile disagree; do
  not replace the lockfile casually.
- A native compiler error usually means a platform prerequisite is missing.
- `release/`, `dist/`, `dist-electron/`, and `dist-native/` are generated and
  ignored by Git.
- An official macOS or Windows build that lacks release credentials is expected
  to fail; use `npm run package` for a locally ad-hoc-signed macOS build or the
  platform's ordinary unsigned Local package elsewhere.
