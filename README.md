# ai-stones

[![npm version](https://img.shields.io/npm/v/ai-stones)](https://www.npmjs.com/package/ai-stones)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**ai-stones creates a project-aware Claude Code setup.** It detects your
language, framework, tooling and conventions, then builds a focused `.claude/`
configuration, an `AGENT.md` project brief and an optional `ROADMAP.md`.

It is published publicly on npm. You can run it with Node.js 22.13 or newer;
the history hook uses the built-in `node:sqlite` module.

```sh
npx ai-stones init       # run in your project root
npx ai-stones detect     # inspect the detected stack
npx ai-stones roadmap    # start a Claude session to write ROADMAP.md
npx ai-stones github-setup  # start a Claude session for git hooks and GitHub files
```

## Install

Run a command directly with `npx`:

```sh
npx ai-stones init
```

Or install globally. The package is named `ai-stones`; its executable is
`ai-stones`:

```sh
npm install --global ai-stones
ai-stones init
```

No GitHub Packages registry or package token is needed. To run from a source
checkout instead, use `bash setup.bash init /path/to/project`.

## What `init` creates

Run `init` from the project directory. ai-stones detects the stack first, asks
about project context it cannot infer, and then writes a tailored setup.

1. **Detects the stack:** languages, frameworks, package manager, monorepo
   tooling, test/lint/typecheck/build commands, formatters and commit style.
   Use `npx ai-stones detect` to inspect the result as JSON.
2. **Asks for project context:** purpose, top-level folders, architecture,
   design patterns, security conventions, branching and TDD preferences, and
   which hooks, skills, plugins and MCP servers to include. Detected values
   become defaults.
3. **Installs only the selected setup:**

```text
AGENT.md                  project brief based on your answers
CLAUDE.md                 imports AGENT.md (appended if CLAUDE.md exists)
.mcp.json                 selected MCP servers
.claude/
├── settings.json         selected hooks, permissions and plugins
├── hooks/                selected hooks
├── skills/               selected and stack-specific skills
├── analyzers/            complexity analyzer, when selected
├── commands/             slash commands such as /roadmap
├── tools/                project and task-board tools
├── scripts/              ci-local.sh, to run the GitHub workflows locally
└── stones.json           saved answers and installed-file hashes
docs/
├── specs/                capability specs and file summaries (specs/changes/ for proposals)
├── tasks/                task board, when selected
├── graph/                code graph, when selected
├── decisions/            product, scope, design, integration and reference decisions
├── design/               superpowers design specs, with plans/ and approvals/
└── logs/                 git-ignored run output: four-d.log, reviews/, quality/
```

Re-running `init` on a project set up with an earlier version moves the old
`openspec/specs`, `context/*`, `.claude/graph`, `docs/superpowers/*`,
`.claude/reviews`, `.claude/quality` and `.claude/four-d.log` into `docs/`; an
entry whose new path is already taken is left in place and reported.

The exact files depend on your answers and detected stack. Use `--dry-run` to
preview the planned changes without writing files.

## Why use ai-stones

- **No slop, by default.** The `anti-slop` skill is a core stone, installed
  in every setup and linked from `AGENT.md`. It holds every change to one
  rule: each line of code, test, comment and prose must earn its place, and
  nothing is reported done without evidence. That rules out narrating
  comments, guards for impossible states, speculative abstractions, tests that
  cannot fail, filler prose and unverified claims.
- **Relevant context, loaded when needed.** `CLAUDE.md` imports a short
  `AGENT.md` brief. Guides are installed as Claude Code skills, so their full
  instructions load when a task matches.
- **Useful defaults, optional process gates.** Lightweight guardrails and
  atomic commit protection are selected by default. Other process gates and
  context added to every prompt are opt-in, as are history recording and the
  code graph.
- **Settings based on the actual project.** Permissions and sandbox domains
  follow detected commands and ecosystems. Framework plugins and pattern
  skills are offered only when relevant. For example, a UI that uses
  `posthog-js` gets the PostHog setup, experiments and session replay skills.
  A project that uses `@sentry/*` gets the official Sentry plugin, and one that
  uses OpenTelemetry gets its tracing, metrics and propagation principles. The PostHog
  and Sentry MCP servers can be added to `.mcp.json` for any project.
- **Safe to rerun.** Previous answers become defaults. Unedited generated
  files update; edited files are preserved and reported unless `--force` is
  used. Settings are merged, and user-authored files are left in place.

## Commands

### Initialize or update a setup

```sh
npx ai-stones init
npx ai-stones init /path/to/project --dry-run
npx ai-stones init --yes
```

`init` can be run again after upgrading ai-stones or changing project answers.
Use `--dry-run` to preview changes and `--force` to overwrite files that were
edited after installation.

### Detect the project stack

```sh
npx ai-stones detect
```

Prints the detected languages, frameworks, tools and commands as JSON.

### Create or revise a roadmap

```sh
npx ai-stones roadmap
npx ai-stones roadmap --focus "plan the next milestone"
npx ai-stones roadmap --print-prompt
```

The roadmap command starts Claude Code with the `/roadmap` prompt. Claude
reviews `AGENT.md`, the current roadmap, recent commits and the specs in `docs/specs/`,
then interviews you and drafts or revises `ROADMAP.md`. In Claude Code, you can
also run `/roadmap [focus]`.

### Set up git hooks and GitHub files

```sh
npx ai-stones github-setup
npx ai-stones github-setup --print-prompt
```

During `init` you choose which GitHub workflows to generate, from none to all
of `ci`, `release`, `security` (actionlint, zizmor, dependency review) and
`dependabot`. `init` then offers a Claude Code session with the `/github-setup`
prompt. Claude reads the project and uses the `git-hooks` and `github-actions`
skills to write:

- git hooks: format and lint staged files before a commit, typecheck and test
  before a push, and check commit messages when you use Conventional Commits.
  It uses lefthook when the project has it, and `.githooks/` with
  `core.hooksPath` otherwise.
- the workflows you selected, in `.github/workflows/`, plus `dependabot.yml`
- issue forms in `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`

Claude asks before it replaces any of these files that already exist. Run
`/github-setup [workflows]` in Claude Code, or the command above, to run it
again later.

### Sync a dev container

```sh
npx ai-stones sync
npx ai-stones sync --check
```

Regenerates `.devcontainer/devcontainer.json` from its Dockerfile. `--check`
exits with an error when the generated file is out of date.

### Useful options

| Option | Effect |
| --- | --- |
| `-y`, `--yes` | Accept detected defaults and saved answers without prompts |
| `--dry-run` | Show planned `init` changes without writing them |
| `--force` | Overwrite files edited since installation |
| `--no-roadmap` | Do not offer to start a roadmap session after `init` |
| `--no-github-setup` | Do not offer to start a GitHub setup session after `init` |
| `--focus <text>` | Set the focus for a roadmap session |
| `--print-prompt` | Print the roadmap or github-setup prompt instead of starting Claude |
| `--check` | With `sync`, check for drift without writing |

## Included project tools

Depending on the selected skills, the setup can include tools to inspect
dependencies, review worktree history, store Git comments, run project quality
checks, draft pull requests, manage a roadmap, synchronize documentation,
track tasks, and quiz you on a spec before implementation starts
(`spec-quiz.mjs`, used by the `confirming-specs` skill), and validate
`docs/specs/` with the OpenSpec CLI (`validate-specs.mjs`). OpenSpec only reads
an `openspec/` folder, so the tool copies `docs/specs/` into a temporary
`openspec/specs/` and `docs/specs/changes/` into `openspec/changes/`, runs
`openspec validate --all --strict`, and reports paths under `docs/specs/`;
`quality-check` runs it as its `specs` step when `docs/specs/` exists. For example, the dependency listing tool reads manifests without
installing packages:

```sh
node .claude/tools/list-packages.mjs
node .claude/tools/list-packages.mjs --prod
node .claude/tools/list-packages.mjs --grep redis
node .claude/tools/list-packages.mjs --json
```

### Evaluate task outputs against predefined KPIs

The `evaluating-outputs` skill gives each task one category: `api`, `db-query`, `calculation-engine`, `caching`, `background-job`, `ui-component`, `page`, `llm-feature` or `general`. The category maps every evaluation dimension to KPIs with thresholds. The dimensions are correctness, consistency, latency, memory, Big O, failure recovery, exception handling, results, and task-specific KPIs.

The KPIs are written into the plan before it is approved, then the built output is scored against them:

```sh
node .claude/tools/evaluation.mjs suggest docs/design/<spec>.md   # which category fits
node .claude/tools/evaluation.mjs plan <plan.md> --category caching          # KPIs and cases into the plan
node .claude/tools/evaluation.mjs record 7 caching.hit-ratio 0.94 \
  --evidence "replay of prod-sample.har" --details results/hit-ratio.json     # a measured value with its full results
node .claude/tools/evaluation.mjs score 7                                    # the scorecard; exit 0 only on PASS
```

The verdict comes from the measured KPIs. The user's sign-offs (`evaluation.mjs sign`, which always asks first) are listed on the scorecard as advisory. With the task board, `tasks.mjs done` refuses a categorised task until its scorecard is PASS. Dimensions and categories are a versioned registry, so new ones need no code change. Projects can override thresholds in `.claude/evaluation.json`.

### Run GitHub Actions workflows before a merge or publish

In projects with `.github/workflows`, the workflows tool lists them and runs
them locally with [act](https://nektosact.com) in Docker. It runs only after
you confirm. In a terminal it asks y/N. When Claude runs it, Claude shows you
the plan first and passes `--yes` only after you agree.

```sh
node .claude/tools/workflows.mjs list                       # workflows, jobs and their events
node .claude/tools/workflows.mjs run                        # every workflow that runs on pull requests
node .claude/tools/workflows.mjs run --workflow ci.yml --job test
node .claude/tools/workflows.mjs status                     # does the current code have a passing run?
```

`.claude/scripts/ci-local.sh` wraps the tool for any stack. It runs `run` by
default, takes `list` and `status`, and passes the other options through. It
stops with an install hint when act is missing or Docker isn't running.
Claude asks before running it, as it does for the tool.

```sh
.claude/scripts/ci-local.sh                       # confirm, then run the pull-request workflows
.claude/scripts/ci-local.sh --workflow ci.yml --job test
.claude/scripts/ci-local.sh status
```

The `workflows` hook is selected by default. It blocks these commands until a
full run has passed for the current code, meaning `HEAD` plus any uncommitted
changes:

- `gh pr merge`, and `git merge` on the default branch
- package publishes: `npm`, `pnpm`, `yarn` and `bun publish`, `cargo publish`,
  `poetry` and `uv publish`, `twine upload`, `gem push`
- `gh release create` and tag pushes

Any later edit makes the recorded run stale. A run of a single job or a single
workflow is recorded, but it doesn't unlock the gate. The tool needs act
(`brew install act`) and a running Docker engine.

## Repository development

The repository contains the CLI, setup catalogs, hooks, skills, plugins,
settings and dev-container templates. After cloning it, run:

```sh
npm run check     # repository consistency checks
npm test          # unit and hook tests
npm run smoke     # exercise commands on throwaway projects
```

The repository has no CI: run these checks before a commit or a release.
`npm run check` also runs shellcheck on the shell scripts when it is installed.
Releases are versioned from `package.json` and tagged as `v<version>`.

## License

[MIT](LICENSE) © 2026 ALOUANI YOUSSEF. The vendored plugins in `plugins/`
retain their upstream licenses: `nestjs-best-practices` is MIT (Kadajett),
while `gin-best-practices` and `flask-best-practices` are Apache-2.0. See each
plugin's `LICENSE` and `UPSTREAM.md`.
