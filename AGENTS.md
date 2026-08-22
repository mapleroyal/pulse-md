# General

This is a dedicated lightweight markdown reader/editor that started with inspiration from the ChatGPT app's right sidebar's markdown renderer/editor (not the diff view) and Obsidian. It is meant to be ultra performant. Where implementation questions arise (layout/appearance, rendering markdown constructs, backend/stack-related considerations, etc.), check how major apps like ChatGPT, Obsidian, and VS Code handle it (all installed and inspectable on this machine), else check out how dominant/popular solutions, before considering custom implementations—however, we aren't opposed to custom implementations if we can genuinely do it better for the goals/intent of this app. Performance is a top priority, so I think we should carefully understand how important apps handle things where performance would be impacted.

Repository architecture and UI implementation conventions live in `ARCHITECTURE.md`; understand and update those boundaries when appropriate.

# Scope Control

- Don't work ahead of the current task. Let the implementers of future tasks own the design and implementation of those tasks.
- You may repair or improve work from before your task if it's tied to your task.
- Never build backwards compatibility or legacy support. I am the only user, and I don't want to support old versions/schemas etc.
- Prefer expected platform behavior when Electron or the OS provides it cheaply. Do not build complex platform-specific native implementations outside macOS; when built-in support ends, use a simple cross-platform behavior or a macOS idiom that remains intuitive and usable elsewhere.

# Tests

- If you're considering adding low-value or low-signal tests, don't. For example, no so-called "regression" tests unless things that were explicitly specified and definitely working correctly are now broken.

# Delivery Verification

- After the final code changes and before wrapping up an implementation task, run `npm run install:local` and complete any platform-specific install instruction it emits. Keep exactly one canonical **Pulse MD** copy at the stable platform location, then verify the relevant behavior in that installed copy. Development-server and project-directory Electron checks are useful while iterating, but they do not replace installed-build verification.
- On Windows, the current development and packaging baseline is x64, including on Windows-on-Arm. Confirm `node -p process.arch` reports `x64` before building or installing. When PowerShell execution policy blocks `npm.ps1`, use `npm.cmd` for the corresponding repository command.
- On macOS, use the explicit maintainer installed-candidate lane (`npm run install:mac:dev`) when a change needs stricter verification of installed integrations or Launch Services registration. That command creates a non-distributable ad-hoc-signed candidate and replaces the same canonical `/Applications/Pulse MD.app`; it does not create a second product identity. Do not distribute its output.
- If the current environment cannot package or install the target app, state that limitation explicitly when handing off the work.

## Troubleshooting & Problem-Solving

- **Root-Cause Fixes Only**: Diagnose and correct the causes of problems, not their symptoms; avoid workarounds or patching established, likely-stable packages. Prefer fixes that are idiomatic to the stack components involved. If there is any uncertainty, eagerly search the docs on the web for the most current best practices.
- **Log Before You Leap**: When the correct solution isn't obvious, add console logging to trace actual runtime behavior. Speculative attempts are allowed only when guided by logging rather than guesswork.
- **Cleanup**: Whenever an attempt doesn't work, remove it before trying the next one.
- Reference or use markdown-test.md in the project root for testing markdown rendering and editing behavior. You may also create your own demo files as needed.

## Accessibility

Do not build in accessibility beyond the minimum standard. I don't want to maintain accessibility features/functionality, and I don't use screen readers.

> [!Important] Computer Use Capability
> You can inspect code bases of installed apps, and obviously of this app. But don't bother with the Computer Use capability—it uses a lot of tokens. Verify stuff in other ways if necessary; I'll handle the manual checks.
