---
description: Generate git hooks, GitHub workflows, issue and PR templates for this project
argument-hint: "[workflows, e.g. 'ci security']"
---

You are setting up this project's local harness: git hooks, the GitHub
workflows the user selected, issue templates and a pull request template.
Generate every file from the project itself. The skills' templates are
starting points, not files to copy unchanged.

Workflows to generate: $ARGUMENTS

If that line says "none selected", generate no workflows. If it is empty
(the command was typed by hand), ask which of `ci`, `release`, `security`
and `dependabot` to generate, using the AskUserQuestion tool with multiple
selection. Choosing none is a valid answer. Never generate a workflow that
wasn't selected.

## 1. Read the project first

- Read `AGENT.md` and `.claude/stones.json`: the stack, the package manager,
  `workflow.commands` (format, lint, typecheck, test, build) and
  `conventions.commits`.
- Check the manifests (`package.json` scripts, `pyproject.toml`, `go.mod`)
  for the commands the project actually has.
- List what already exists: `.github/workflows/`, `.github/ISSUE_TEMPLATE/`,
  `.github/pull_request_template.md`, `.github/dependabot.yml`, `.githooks/`,
  `lefthook.yml`, `.husky/`, `.git/hooks/` (ignore `*.sample`) and
  `git config core.hooksPath`.
- Run `git rev-parse --is-inside-work-tree`. If the folder is
  not a git repository, write the hook files but skip activation, and say so.

Then tell the user, in a few lines, what you will create and what you will
leave alone. Ask before replacing or changing any file that already exists.

## 2. Git hooks

Follow the `git-hooks` skill (`.claude/skills/git-hooks/SKILL.md`):

- pre-commit: format, then lint, on staged files only
- pre-push: typecheck, then tests
- commit-msg: only if `conventions.commits` is `conventional`

Pick lefthook or `.githooks/` with `core.hooksPath` as the skill describes,
and fill the commands from step 1. Then show that each hook runs, with its
output.

## 3. Workflows

For each selected workflow, follow the `github-actions` skill
(`.claude/skills/github-actions/SKILL.md`) and its Templates section:
`ci` → `.github/workflows/ci.yml`, `release` → `.github/workflows/release.yml`,
`security` → `.github/workflows/security.yml`,
`dependabot` → `.github/dependabot.yml`.

Lint the workflow files with actionlint when it's available, through Docker
or the binary. Then run `node .claude/tools/workflows.mjs list`. Offer a
local run with `.claude/scripts/ci-local.sh`, and run it only if the user
agrees: the tool shows its plan and asks before it starts any container.

## 4. Issue and pull request templates

Write `.github/ISSUE_TEMPLATE/bug_report.yml`,
`.github/ISSUE_TEMPLATE/feature_request.yml`,
`.github/ISSUE_TEMPLATE/config.yml` and `.github/pull_request_template.md`
from the `github-actions` skill's templates. Adjust the wording and fields to
this project, for example the version field of a library or the browser
field of a web app.

## 5. Finish

List every file you created or changed, how each hook was activated, and
what you checked, with the results. Say that `/github-setup` (or
`npx ai-stones github-setup`) can be run again later to add workflows.
