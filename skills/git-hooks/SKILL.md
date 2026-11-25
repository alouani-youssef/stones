---
name: git-hooks
description: Use when adding, changing or debugging git hooks (pre-commit, commit-msg, pre-push), choosing between lefthook and plain scripts in .githooks, when hooks are slow, skipped, not running, or get bypassed with --no-verify, or when running /github-setup.
metadata:
  title: Git Hooks
  summary: Fast pre-commit checks on staged files, tests before push, commit messages checked only when the project uses Conventional Commits, activated with lefthook or core.hooksPath, never clobbering hooks the project already has.
  core: true
---

# Git Hooks

Git hooks run the project's own checks on the developer's machine, before a commit or a push leaves it. They are the first layer of the local harness. The workflows gate (`.claude/tools/workflows.mjs`) and CI come after them; hooks never replace those.

A hook that is slow gets bypassed with `--no-verify`, and a bypassed hook checks nothing. Keep each one inside its budget.

## Which hook runs what

| Hook | Runs | Budget | Template |
| --- | --- | --- | --- |
| `pre-commit` | format, then lint, on **staged files only**; formatted files are re-staged | under ~10 s | `templates/githooks/pre-commit` |
| `commit-msg` | Conventional Commits check, only when `conventions.commits` is `conventional` in `.claude/stones.json` | instant | `templates/githooks/commit-msg` |
| `pre-push` | typecheck, then the test suite | under ~2 min | `templates/githooks/pre-push` |

Use the project's own commands: the `workflow.commands` answers in `.claude/stones.json` (`format`, `lint`, `typecheck`, `test`), then the manifest scripts. A command the project doesn't have is left empty, and the hook skips that step. Don't invent tooling to fill a slot. In `pre-commit`, set `FILE_PATTERN` to the files the tools handle (`\.go$`, `\.py$`), so a docs-only commit doesn't run `gofmt` on a README. A file with unstaged changes is formatted but not re-staged, and the hook says so.

## Choosing the mechanism

1. **lefthook**, if `lefthook.yml` already exists or `lefthook` is on PATH. Start from `templates/lefthook/<stack>.yml` (`node`, `python`, `go`), then run `lefthook install`. It gives parallel jobs and `{staged_files}`. The templates' `commit-msg` job calls `.githooks/commit-msg`, so copy that one script too (without setting `core.hooksPath`), or drop the job.
2. **Plain scripts** otherwise. Copy `templates/githooks/*` to `.githooks/`, fill the command variables at the top of each script, then run `chmod +x .githooks/*` and `git config core.hooksPath .githooks`. Nothing extra to install.

Don't activate both in one project. If `.husky/` or `pre-commit` (`.pre-commit-config.yaml`) is already set up, extend that instead, and say so.

If the folder isn't a git repository, write the files but skip activation, and tell the user to run the activation command after `git init`.

## Existing hooks

Before you write anything, look at `.git/hooks/` (ignore `*.sample`), `.githooks/`, `lefthook.yml`, `.husky/` and `git config core.hooksPath`. Never replace an existing hook without asking. Show what it runs and propose a merge.

## Verify the hooks run

Show that each hook you installed ran, with its output:

- `git hook run pre-commit` (git 2.36 or later) or `lefthook run pre-commit`
- `git hook run commit-msg -- <file>` with a bad message must fail
- `git hook run pre-push` (or `lefthook run pre-push`)

A hook that exits 0 without running its commands (wrong path, not executable, `core.hooksPath` unset) checks nothing. Read the output before you report it as working.

## Quick reference

| Do | Instead of |
| --- | --- |
| check staged files in pre-commit | linting the whole repository on every commit |
| put tests in pre-push | the full suite in pre-commit |
| `set -euo pipefail` and quoted variables | scripts that ignore failures |
| commit `.githooks/` or `lefthook.yml` | hooks only in `.git/hooks`, which aren't shared |
| keep `--no-verify` for emergencies, then fix the hook | a hook so slow everyone skips it |
