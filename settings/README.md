Claude Code accepts one settings JSON file, so keep the settings split into
focused source files here and compose them into `settings.json` after edits.

- `global.json`: general preferences and status line
- `permissions.json`: allow, ask, and deny rules
- `hooks.json`: tool hooks
- `sandbox.json`: sandbox configuration

Run `node settings/build-settings.mjs` from the repository root to regenerate
`settings/settings.json`. Commit both the source files and generated settings
file so the configured settings remain directly usable.
