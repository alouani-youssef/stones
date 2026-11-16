# System Prompts and Atomic Commits Plan

## Test Strategy

Start with failing focused CLI assertions for skill discovery/defaults and default atomicity installation. After implementation, run the focused CLI suite and inspect generated artifacts plus the diff.

## Test Cases

- Case: `system-prompts` is catalogued and selected on general and framework projects. Expected: it appears in interview defaults and resolves to its `SKILL.md`.
- Case: runtime prompt guidance points to the system-prompt skill for persistent instructions. Expected: an explicit cross-reference exists.
- Case: atomicity is a default hook. Expected: catalog metadata and default answers mark it selected.
- Case: standard init installs atomicity artifacts. Expected: the hook script, seed config, and danger directory are created.
- Case: opting out remains possible. Expected: explicit deselection still removes atomicity artifacts.
- Case: atomic commit workflow catches semantic splits. Expected: atomic-changes documents reviewing staged changes and separating unrelated code-only work.
- Case: user docs match behavior. Expected: README says atomicity is a default and other blocking gates/logging remain opt-in.

## Steps

- [x] Add focused failing tests for system-prompt skill catalog/default selection and default atomicity artifacts.
- [x] Add `skills/system-prompts/SKILL.md` with actionable guidance and authoritative references.
- [x] Cross-reference the new skill from `skills/prompts/SKILL.md`.
- [x] Add the pre-commit checklist and code-only semantic atomicity guidance to `skills/atomic-changes/SKILL.md`.
- [x] Add atomicity to default hooks; update catalog hint and README wording.
- [x] Run focused tests, inspect output and final diff.
