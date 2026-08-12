import type { CliHelpTopic } from "./cli-command"

const GENERAL_HELP = `Usage:
  pmd [open] [OPTIONS] [--] [PATH...]
  pmd profile COMMAND [OPTIONS]
  pmd scratch COMMAND [OPTIONS]
  pmd doctor

Open Markdown files and automation-friendly tabs in a focused editor window.
Existing files must be UTF-8. A missing file path is created only when saved.

Open options:
  -n, --new-window          Open a new window (the default)
  -r, --reuse-window        Add tabs to the most recently focused window
      --mouse-monitor       Place a new window on the pointer's monitor
  -w, --wait                Wait until every requested tab is closed
      --blank N             Insert N ordinary untitled tabs
      --ephemeral N         Insert N discard-on-close tabs
      --scratch ID          Insert an auto-saved standalone scratch tab
      --active N            Activate the Nth requested tab (one-based)
  -g, --goto LINE[:COLUMN]  Place the cursor in the active tab
      --tab-goto N:LINE[:COLUMN]
                            Place the cursor in a specific requested tab
      --tabs MODE           inherit, always, multiple-tabs, mouseover,
                            formatting-bar, hidden
      --mode MODE           inherit, live, or source
      --tab-mode N:MODE     Override one requested tab with live or source
      --stdin-name NAME     Name the single standard-input (-) tab
      --profile [ID]        Pick a profile, or open ID directly
  -                         Read one UTF-8 document from standard input
  --                        End option parsing

Tab numbers are one-based in source order. --tab-mode and --tab-goto may be
repeated for different tabs; --mode supplies the default for the request.
On macOS, new windows use the active system window's monitor by default and
fall back to the pointer's monitor when that window cannot be determined.

Other options:
  -h, --help                Show this help
  -V, --version             Show the application and CLI protocol version
  pmd help [COMMAND [SUBCOMMAND]]
                            Show general or command-specific help

Help and version flags are global anywhere before --.

Profile commands:
  pmd profile open [ID] [--wait] [--mouse-monitor]
  pmd profile list [--json]
  pmd profile show ID
  pmd profile import FILE [--replace]
  pmd profile export ID [FILE|-] [--replace]
  pmd profile delete ID

Scratch commands:
  pmd scratch open ID [--wait] [--mouse-monitor]
  pmd scratch list [--json]
  pmd scratch export ID [FILE|-]
  pmd scratch delete ID

Examples:
  pmd notes.md todo.md --active 2 --goto 18:4
  pmd --mode live left.md --ephemeral 1 right.md --active 2 --tab-mode 2:source
  printf '# Quick note\\n' | pmd - --stdin-name thought.md
  pmd --blank 2 --scratch work-notes --tabs always
  pmd scratch export work-notes > work-notes.md
  pmd --wait .git/COMMIT_EDITMSG
  pmd --profile
  pmd --profile quick-notes

Run 'pmd profile --help' for the profile JSON schema and workflow.
`

const PROFILE_HELP = `Usage:
  pmd profile open [ID] [--wait] [--mouse-monitor]
  pmd profile list [--json]
  pmd profile show ID
  pmd profile import FILE [--replace]
  pmd profile export ID [FILE|-] [--replace]
  pmd profile delete ID

Profiles describe an ordered reusable window. Import validates the whole file
and resolves relative file-tab paths against the imported JSON file. Scratch
tabs reference independently managed scratches by canonical UUID.

Schema version 2:
{
  "version": 2,
  "id": "quick-notes",
  "name": "Quick Notes",
  "activeTab": "throwaway",
  "tabVisibility": "always",
  "mode": "live",
  "tabs": [
    { "id": "throwaway", "kind": "ephemeral", "mode": "source" },
    { "id": "remembered", "kind": "scratch", "scratchId": "019fe216-2b96-7511-8cf4-a35483924181" },
    { "id": "work", "kind": "scratch", "scratchId": "019fe216-2b96-7511-8cf4-a35483924182", "title": "Work Notes", "color": "blue" },
    { "id": "todo", "kind": "scratch", "scratchId": "019fe216-2b96-7511-8cf4-a35483924183", "title": "TODO", "color": "orange" }
  ]
}

Tab kinds: file (requires "path"), untitled, ephemeral, scratch.
Tabs visibility: inherit, always, multiple-tabs, mouseover, formatting-bar,
hidden.
Optional root mode: live or source; omit it to inherit the app setting. A tab's
optional mode overrides the root mode for that tab.
Colors: red, orange, yellow, green, blue, purple, pink, gray.
Profile tab IDs are local to the profile. Each scratch tab requires a canonical
scratchId UUID. Scratch content is never embedded in profile JSON, and deleting
a profile never deletes the standalone scratches it references.
`

const SCRATCH_HELP = `Usage:
  pmd scratch open ID [--wait] [--mouse-monitor]
  pmd scratch list [--json]
  pmd scratch export ID [FILE|-]
  pmd scratch delete ID

Manage standalone app-managed Markdown documents. Each scratch is a literal
.md file with a stable UUID independent of its editable filename and title.
Existing scratches can be addressed by UUID or by their portable filename
stem; new CLI stems use lowercase letters and numbers separated by single
hyphens and exclude reserved Windows device names. A scratch must be closed
before it can be exported or deleted, so its atomically saved content is
authoritative. File export creates a new file and refuses to overwrite an
existing path or write anywhere inside the app's scratch storage. Deletion is
also refused while a profile references the scratch.
`

const TOPIC_HELP: Record<CliHelpTopic, string> = {
  general: GENERAL_HELP,
  open: GENERAL_HELP,
  profile: PROFILE_HELP,
  "profile-open": `Usage: pmd profile open [ID] [--wait] [--mouse-monitor]\n\nOpen the searchable app profile picker, or open/refocus ID directly. A newly created window uses the active system window's monitor on macOS; --mouse-monitor uses the pointer's monitor instead.\n`,
  "profile-list": `Usage: pmd profile list [--json]\n\nList installed profiles.\n`,
  "profile-show": `Usage: pmd profile show ID\n\nPrint normalized profile JSON.\n`,
  "profile-import": `Usage: pmd profile import FILE [--replace]\n\nValidate and install a versioned profile JSON file.\n`,
  "profile-export": `Usage: pmd profile export ID [FILE|-] [--replace]\n\nExport normalized profile JSON; stdout is the default. File export refuses to overwrite unless --replace is passed.\n`,
  "profile-delete": `Usage: pmd profile delete ID\n\nDelete a closed profile definition. Standalone scratches referenced by it are unchanged.\n`,
  scratch: SCRATCH_HELP,
  "scratch-open": `Usage: pmd scratch open ID [--wait] [--mouse-monitor]\n\nOpen or focus the single live tab for a standalone scratch document. A newly created window uses the active system window's monitor on macOS; --mouse-monitor uses the pointer's monitor instead.\n`,
  "scratch-list": `Usage: pmd scratch list [--json]\n\nList standalone scratches and their open state.\n`,
  "scratch-export": `Usage: pmd scratch export ID [FILE|-]\n\nExport a closed scratch document; stdout is the default and file export never overwrites.\n`,
  "scratch-delete": `Usage: pmd scratch delete ID\n\nPermanently delete a closed, unreferenced scratch document.\n`,
  doctor: `Usage: pmd doctor\n\nReport helper, endpoint, app, profile, and protocol diagnostics.\n`,
}

export function formatCliHelp(
  topic: CliHelpTopic,
  commandName = "pmd"
): string {
  return TOPIC_HELP[topic].replace(/\bpmd\b/g, commandName)
}
