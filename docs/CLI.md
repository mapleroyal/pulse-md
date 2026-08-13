# Pulse MD CLI

Pulse MD's native command-line client starts its matching application when
necessary, talks directly to an already-running copy, forwards standard input
without placing document contents in process arguments, reports errors to the
terminal, and returns only after the requested editor has keyboard focus.

The two application identities use separate commands and endpoints:

| App                           | Command                      | Purpose                                      |
| ----------------------------- | ---------------------------- | -------------------------------------------- |
| Packaged Pulse MD             | `pmd`                        | Source, direct-download, or storefront build |
| Pulse MD Development checkout | `npm run cli:dev -- <args…>` | Isolated checkout-development run            |

On macOS and Linux, install a packaged app's command from **Install Command
Line Tool…** in that app. Every packaged build installs `pmd` and uses the same
application data. The all-users Windows installer adds the helper to the
machine-wide `PATH`; open a new terminal afterward.

Examples below use `pmd`. Prefix development arguments with
`npm run cli:dev --` to use the same interface against the isolated Development
identity. Do not rename one helper to the other identity's command.

Use `pmd --help`, `pmd COMMAND --help`, or
`pmd help [COMMAND [SUBCOMMAND]]` for terminal help. `pmd --version` prints the
application and CLI protocol version, and `pmd doctor` reports the resolved
application, helper, endpoint, profile, scratch, and protocol details.

## Opening documents

```text
pmd [open] [OPTIONS] [--] [PATH...]

-n, --new-window          Open a new window (default)
-r, --reuse-window        Add tabs to the most recently focused usable window
    --mouse-monitor       Place a new window on the pointer's display
-w, --wait                Wait until every requested tab is closed
    --blank N             Add N ordinary untitled tabs
    --ephemeral N         Add N discard-on-close tabs
    --scratch ID          Add an auto-saved standalone scratch tab
    --active N            Activate the Nth requested tab (one-based)
-g, --goto LINE[:COLUMN]  Place the cursor in the active tab (one-based)
    --tab-goto N:LINE[:COLUMN]
                          Place the cursor in a requested tab
    --tabs MODE           inherit, always, multiple-tabs, mouseover,
                          formatting-bar, hidden
    --mode MODE           inherit, live, source
    --tab-mode N:MODE     Override one requested tab with live or source
    --stdin-name NAME     Name the single standard-input (-) tab
    --profile [ID]        Pick a profile, or open ID directly
-                         Read one UTF-8 document from standard input
--                        End option parsing
```

`open` is optional:

```sh
pmd notes.md
pmd open notes.md
```

Each open request creates a focused window unless `--reuse-window` is present.
On macOS, a new CLI window is centered on the display containing the system's
active window. If that window cannot be determined, Pulse MD uses the display
under the mouse pointer. `--mouse-monitor` requests the pointer's display
directly. Profiles and scratch documents that are already open are focused
rather than duplicated.

Positional paths and `file://` URLs retain their order and resolve against the
invoking shell's working directory. A missing filename opens as a clean,
path-bound document and is created only when saved; its parent directory must
already exist. Existing files and piped input must be valid UTF-8.

Options can be interspersed with sources, so the order written is the requested
tab order. `--active`, `--tab-mode`, and `--tab-goto` use one-based positions in
that order. Numbered overrides may appear anywhere and may be repeated for
different tabs. `--mode` supplies the request default; `--tab-mode` overrides
only its numbered tab.

Source-producing options—`--blank`, `--ephemeral`, and `--scratch` with distinct
IDs—may be repeated. Repeating a single-use option, repeating the same numbered
override, using conflicting options, or supplying malformed input is an error.
`-h`/`--help` and `-V`/`--version` are global anywhere before `--`.

### Examples

```sh
# Open files as ordered tabs and start in the second file.
pmd notes.md todo.md --active 2 --goto 18:4

# Put a new window on the display under the pointer.
pmd --mouse-monitor notes.md

# Append tabs to the most recently focused usable Pulse MD window.
pmd --reuse-window notes.md

# Combine tab backing types.
pmd --blank 2 --ephemeral 1 --scratch work-notes --active 4

# Set a window mode and override one tab.
pmd --mode live left.md --ephemeral 1 right.md \
  --active 2 --tab-mode 2:source

# Keep the tab strip visible and target a location in a particular tab.
pmd --tabs always --tab-goto 2:18:4 left.md right.md

# Name a document read from standard input.
printf '# Quick note\n' | pmd - --stdin-name thought.md

# Wait until the requested editor tab closes.
pmd --wait .git/COMMIT_EDITMSG
```

### Tab backing

- An ordinary untitled tab prompts if dirty and becomes a file when saved.
- An ephemeral tab never auto-saves or prompts; Save As converts it to a normal
  file.
- A scratch tab uses private app-managed storage, saves atomically and
  automatically, and closes without a prompt. Save As writes a copy while
  retaining the scratch tab.
- A file tab follows normal save and external-change behavior.

## Scratch documents

Scratch documents are standalone, app-managed Markdown files. Profiles may
reference them, but never own their content or lifecycle:

```text
pmd scratch open ID [--wait] [--mouse-monitor]
pmd scratch list [--json]
pmd scratch export ID [FILE|-]
pmd scratch delete ID
```

Each scratch has a canonical UUID that remains stable when its filename or title
changes. For CLI convenience, `ID` may select an existing scratch by that UUID
or by its Markdown filename stem. A new CLI stem contains lowercase letters and
numbers separated by single hyphens; Windows-reserved device basenames are
excluded. Each canonical UUID has at most one live tab across the application.
Both `pmd --scratch ID` and `pmd scratch open ID` focus an existing tab rather
than creating a competing writer. Add `--wait` to wait for that tab to close.

```sh
pmd scratch open work-notes
pmd scratch list
pmd scratch list --json
pmd scratch export work-notes > work-notes.md
pmd scratch export work-notes ./archive/work-notes.md
pmd scratch delete work-notes
```

Human-readable `scratch list` output uses filename stems. JSON output adds the
stable identity as `scratchId`, for example:

```json
[
  {
    "id": "work-notes",
    "open": false,
    "scratchId": "019fe216-2b96-7511-8cf4-a35483924181"
  }
]
```

Canonical Markdown links use the UUID. Every packaged build uses and registers
`pulse-md://scratch/019fe216-2b96-7511-8cf4-a35483924181#next-actions`.
Checkout Development uses `pulse-md-development://scratch/…` internally but
does not register a global handler. Each scheme resolves only against its
matching app data, and settings import rebinds included scratch links to the
destination identity. The link does not expose the private backing path and
remains valid after a filename or title change.

Export writes to standard output when the destination is omitted or `-`. A
scratch must be closed before export or deletion so pending auto-save work
cannot make the result stale. File export atomically creates a new file,
creates missing parent directories, and refuses to overwrite an existing path
or target anything inside Pulse MD's scratch storage, including through a
symbolic link. Deleting a nonexistent scratch is an error, as is deleting a
scratch that is still referenced by a profile.

## Profiles

Profiles define reusable, ordered windows with a name, active tab, tab
visibility, editor modes, titles, colors, and backing types:

```text
pmd profile open [ID] [--wait] [--mouse-monitor]
pmd profile list [--json]
pmd profile show ID
pmd profile import FILE [--replace]
pmd profile export ID [FILE|-]
pmd profile delete ID
```

Example profile:

```json
{
  "version": 2,
  "id": "quick-notes",
  "name": "Quick Notes",
  "activeTab": "throwaway",
  "tabVisibility": "always",
  "mode": "live",
  "tabs": [
    { "id": "throwaway", "kind": "ephemeral", "mode": "source" },
    {
      "id": "remembered",
      "kind": "scratch",
      "scratchId": "019fe216-2b96-7511-8cf4-a35483924181"
    },
    {
      "id": "work",
      "kind": "scratch",
      "scratchId": "019fe216-2b96-7511-8cf4-a35483924182",
      "title": "Work Notes",
      "color": "blue"
    },
    {
      "id": "todo",
      "kind": "file",
      "path": "./todo.md",
      "color": "orange"
    }
  ]
}
```

Profile and tab IDs use lowercase letters and numbers separated by single
hyphens; Windows-reserved device basenames such as `con`, `com1`, and `lpt1`
are excluded.

Supported tab kinds are:

- `file`, which requires `path`; relative paths resolve against the imported
  profile JSON's directory
- `untitled`
- `ephemeral`
- `scratch`, which requires the canonical UUID in `scratchId`

`tabVisibility` is required and accepts `inherit`, `always`, `multiple-tabs`,
`mouseover`, `formatting-bar`, or `hidden`. Optional root `mode` accepts `live`
or `source`; omit it to inherit the app setting. An optional mode on a tab
overrides the root mode. Optional colors are `red`, `orange`, `yellow`, `green`,
`blue`, `purple`, `pink`, and `gray`.

Tab IDs are profile-local identities, not scratch storage identities or display
labels. A profile's optional tab title can override the referenced scratch's
own title or filename for that window. Scratch content is stored separately and
is never embedded in exported profile JSON. A profile has one live window;
opening it again focuses that window.

### Profile workflow

```sh
pmd profile import quick-notes.json
pmd --profile
pmd profile open quick-notes
pmd --profile quick-notes
pmd profile list
pmd profile list --json
pmd profile show quick-notes
pmd profile export quick-notes > quick-notes.json
pmd profile export quick-notes ./backup/quick-notes.json
pmd profile delete quick-notes
```

Import validates the complete document and refuses replacement unless
`--replace` is supplied. Standard input is not supported for import.

Export prints normalized JSON to standard output by default. Pass a file path
to export to a file.

Deleting a profile removes only its reusable window definition. Every
standalone scratch it referenced remains available. Profile deletion will not
run while that profile has a live window; scratch export and deletion remain
separate `pmd scratch` operations.

## Editor integration

`--wait` makes `pmd` suitable for tools that expect an editor process to remain
until editing is complete. It tracks exactly the tabs selected or created by
that request, even if they are later moved between Pulse MD windows.

```sh
git config --global core.editor 'pmd --wait'
export VISUAL='pmd --wait'
export EDITOR='pmd --wait'
```

Some programs require `EDITOR` to contain only an executable path rather than a
command plus arguments. Configure those programs directly or use a small
wrapper that executes `pmd --wait "$@"`.

The development npm command is intended for repository work rather than a
durable global editor configuration.

## Output and exit status

Metadata and storage-management commands do not require a visible editor
window. Human-readable lists go to standard output; `--json` provides stable
machine-readable output where supported.

- Exit status `0`: success
- Exit status `1`: operational failure
- Exit status `2`: unknown, conflicting, duplicate, or malformed command usage

Errors and diagnostics are written to standard error.
