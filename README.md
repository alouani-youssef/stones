# ai-stones

[![npm version](https://img.shields.io/npm/v/ai-stones)](https://www.npmjs.com/package/ai-stones)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://alouani-youssef.github.io/stones/)

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
   which hooks, skills, subagents, plugins and MCP servers to include. Detected values
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
├── agents/               selected subagents (developer, tester, critic...)
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
- **Useful defaults, optional process gates.** Safety guardrails, atomic
  commit protection, the assumptions gate on plans and the local-CI gate on
  merges are selected by default. The testing gate, the complexity check,
  context added to every prompt, history recording and the code graph are
  opt-in.
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

## Getting the most out of it

The stones work best as one loop. Each step below adds a stone that checks the
step before it.

1. **Give `init` real answers.** `AGENT.md` is built from them and loaded
   into every session. A one-line purpose, the role of each top-level folder,
   and the things Claude must never touch save more correction later than
   any skill. Re-run `init` whenever they change; your previous answers are
   the defaults.
2. **Record decisions in `docs/decisions/`.** Product, scope, actors, system
   design, technical choices, integrations and exposed elements. The
   `answers` skill reads them before it answers a project question or starts
   a task that could contradict a decision. A decision recorded there won't
   need to be argued again.
3. **Set direction with `/roadmap`** and the repository with
   `/github-setup` (git hooks, the workflows you picked, issue and PR
   templates). Both are offered at the end of `init`.
4. **For each task, spec first.** The superpowers plugin writes the design
   to `docs/design/`. The `assumptions` hook blocks the plan until you have
   confirmed or denied every assumption in it, and `confirming-specs` runs a
   short quiz to check that you approve what will be built.
5. **Put measurable targets in the plan.** `evaluating-outputs` picks the
   task's category and writes its KPIs and thresholds into the plan before
   you approve it.
6. **Track it on the board.** `tracking-tasks` gives each task a note in
   `docs/tasks/list/` with its expected behavior and scenarios. `tasks.mjs
   done` refuses a categorised task until its scorecard is PASS.
7. **Build in small, verified steps.** `test-first-development`,
   `writing-tests` and `testing` guide the work. `anti-slop` keeps the diff
   lean. The `format`, `naming` and, if enabled, `complexity` hooks check
   each edit as it lands.
8. **Commit and ship atomically.** The `atomicity` hook keeps each commit to
   one zone and moves database, dependency and network changes onto their
   own specced branch. `quality-check.mjs` runs your gates, `ci-local.sh`
   runs the GitHub workflows locally, and `create-pr.mjs` drafts the PR from
   what the branch recorded. The `workflows` hook blocks merges and publishes
   until that local run has passed.

Further tips:

- On a large codebase, enable the `graph` hook. Claude then gets a file's
  purpose and its links before it reads the file, so it reads fewer files.
- Use `--dry-run` after upgrading ai-stones to see what would change before
  you apply it.
- Leave `git-comments.mjs` notes on commits (why the commit exists, what was
  verified, what is left). `worktree-history.mjs` and `create-pr.mjs` read
  them back in the next session.
- Keep the skill list close to the stack. Skills cost nothing until their
  task comes up, but a skill for a framework you don't use is noise.

## The stones

Each stone is a hook, a skill, a subagent, a tool, a slash command, a plugin or an MCP
server. `init` offers only the stones that fit the detected stack.

### Hooks

Hooks run on every matching tool call, so they enforce a rule rather than
suggest it.

| Hook | Default | Runs on | What it does |
| --- | --- | --- | --- |
| `access_guard` | yes | every file and shell tool | Blocks paths outside the project root, secrets (`.env*`, `private/`) and `git push` |
| `block-rm` | yes | Bash | Blocks `rm` commands (needs `jq`) |
| `atomicity` | yes | Bash, edits | One zone per commit; danger-zone changes (migrations, dependencies, external calls) go on a specced branch; guards generated migrations |
| `assumptions` | yes | edits | Blocks writing a plan until every assumption in its spec is confirmed or denied |
| `workflows` | yes | Bash | Blocks merges, publishes, releases and tag pushes until the GitHub workflows pass locally with act |
| `naming` | yes | Write | Enforces the project's naming convention on new files |
| `format` | yes, with a formatter | after edits | Formats edited files with the project formatter |
| `devcontainer` | yes | after edits | Regenerates `devcontainer.json` when its Dockerfile changes |
| `testing` | opt-in | Bash, edits | Requires clear test scenarios before tests run; guards spec and test edits unless expected behavior changed |
| `complexity` | opt-in | after edits | Flags functions an edit pushed over SonarQube's cognitive-complexity limit (Python, JS/TS, Go) |
| `graph` | opt-in | Read, edits | Gives Claude file summaries from `docs/specs` and keeps the code graph current |
| `four-d` | opt-in | each prompt | Adds 4D guardrails matched to the prompt's task and risk |
| `history` | opt-in | each prompt and reply | Logs the session to a local, git-ignored SQLite database |

### Skills

Skills are installed in `.claude/skills/`. Claude loads one only when its task
comes up, so an installed skill costs nothing until it is needed.

**Core: installed in every setup**

| Skill | What it is for |
| --- | --- |
| `anti-slop` | Each line of code, test, comment and prose earns its place, and nothing is reported done without evidence |
| `git-hooks` | Fast pre-commit checks, tests before push, and commit-message checks when the project uses Conventional Commits |
| `github-actions` | Least-privilege, SHA-pinned, cached workflows that are tried locally with act before they are pushed |

**Workflow and process**

| Skill | What it is for |
| --- | --- |
| `answers` | Answers project questions from recorded answers, decisions and the code graph, citing sources |
| `confirming-specs` | Gets every assumption confirmed or denied, then runs a short quiz before code is written |
| `evaluating-outputs` | Predefined KPIs per task category, written into the plan and scored from measured runs |
| `tracking-tasks` | One note per task, a generated board, and a review package that checks work against the task |
| `atomic-changes` | One purpose per commit, branch and PR; what to do when the atomicity hook blocks |
| `creating-branches` | Naming branches by intent, splitting mixed trees, stacking on unmerged branches |
| `opening-pull-requests` | One story per PR, danger-zone PRs first, risk and rollback in every description |
| `four-d-engineering` | Delegation, Description, Discernment, Diligence for non-trivial tasks and subagent briefs |
| `ci-cd` | A releasable main branch, ordered gates, one promoted artifact, reversible deploys and migrations |

**Code design**

| Skill | What it is for |
| --- | --- |
| `philosophy` | Clean Code and A Philosophy of Software Design: deep modules, hidden information, precise names |
| `creating-files-and-modules` | Adding a file, module, type or test so it fits the existing structure |
| `naming-files` | Choosing file and directory names; configuring `.claude/naming.json` |
| `defining-types` | Types that rule out invalid states, with untrusted data validated at the boundary |
| `modular-design` *(pattern)* | Cohesive modules with small interfaces and hidden internals |
| `reusing-code` *(pattern)* | Sharing a rule once it has a real second use, not before |
| `managing-complexity` *(pattern)* | Cognitive complexity, Big O and change cost, measured before optimizing |
| `repository-pattern` *(pattern, ORMs)* | A persistence boundary in domain language |
| `dependency-injection` *(pattern, DI frameworks)* | Collaborators passed in, wired at the composition root |
| `summary-details-responses` *(pattern, APIs)* | Compact list shapes and fuller detail shapes, each an explicit DTO |

**Testing and verification**

| Skill | What it is for |
| --- | --- |
| `testing` | Proving a change with evidence that matches the claim, and designing code so that evidence is cheap to get |
| `writing-tests` | Choosing unit, integration or end-to-end tests by risk, and keeping task scenarios current |
| `test-first-development` | Red, green, refactor: one failing test for one behavior at a time |

**Metrics**

| Skill | What it is for |
| --- | --- |
| `measuring-complexity` | One 0-100 complexity index from real analyzers, compared against a baseline |
| `cyclomatic-complexity` | McCabe cc and nesting depth, counted correctly and reduced by removing paths |
| `code-quality-metrics` | Lines per symbol and violation percentage, read as trends |
| `dependency-entropy` | How tangled the import graph is: entropy, cycles, fan-in and fan-out |

**Stack-specific: offered when the stack uses them**

| Skill | Offered for | What it is for |
| --- | --- | --- |
| `fastapi` | FastAPI | Feature routers, separate input and output schemas, lifespan resources, dependency overrides in tests |
| `factory-eslint-rules` | TypeScript | Turning conventions into lint rules agents can follow |
| `opentelemetry` | OpenTelemetry | Tracing, metrics and propagation with low-cardinality names and no personal data |
| `posthog` | PostHog | One client, a reverse proxy, identify and reset, a typed event catalog |
| `posthog-experiments` | PostHog | Flags and A/B tests with a metric decided before launch and flags removed after |
| `posthog-session-replay` | PostHog | Masked recordings, sampling and triggers, recordings reviewed by question |

**LLM applications: offered for Anthropic or OpenAI SDKs, LangChain, LangGraph, DeepEval or Giskard**

| Skill | What it is for |
| --- | --- |
| `prompts` | Prompts as versioned code with explicit output contracts, changed only against a golden set |
| `system-prompts` | Durable assistant instructions with clear priority, scope and tool boundaries (offered for every stack) |
| `langchain` | `create_agent`, small tools, middleware, structured output, tests without a live model |
| `langgraph` | Typed state, small nodes, durable checkpointers, idempotent work around interrupts |
| `testing-llm-agents` | The test strategy: deterministic, trajectory, golden-set and safety layers, each gated in CI |
| `golden-set` | A versioned set of labelled cases, run on every change |
| `generating-golden-sets` | Building that set from real traffic first, with every case reviewed |
| `deepeval` | Pytest-style evals with calibrated judges, gated in CI |
| `giskard` | Scenario checks and vulnerability scans whose findings become regression tests |

### Subagents

Subagents are installed in `.claude/agents/`, where Claude Code registers them
for delegation (`@critic`, or automatically when a task fits the role). Each
runs in its own context with only the tools its role needs. All are selected
by default; deselected ones are removed on the next `init` unless you edited
them.

| Agent | Tools | What it is for |
| --- | --- | --- |
| `developer` | read, edit, shell | Implements one scoped change test-first and reports what it verified |
| `tester` | read, edit, shell | Writes and runs the tests that prove a behavior; edits tests only |
| `critic` | read, shell | Reviews a diff, branch or plan and reports verified problems by severity |
| `functional` | read, shell | Checks a change against its spec or acceptance criteria, as a user would |
| `hacker` | read, shell | Security review of the project's own code, config and dependencies |
| `researcher` | read, web | Answers a question with sourced evidence before a decision |
| `summarizer` | read, shell | Condenses branches, diffs, PR threads and logs into a short report |
| `devops` | read, edit, shell | CI/CD, containers, dev container and release config, verified locally |
| `automator` | read, edit, shell | Turns a repeated manual step into a script, hook, command or CI job |

With the task board (`tracking-tasks`), the task tool dispatches them: the
session `tasks start` opens hands the build to `developer`, `tester` and
`devops`; the session prompt and `tasks review` hand the review package to
`critic`, `functional` and `hacker`; `tasks done` hands the PR summary to
`summarizer`. Only installed agents are named, so a deselected one leaves its
step to the main session.

### Project tools

Installed in `.claude/tools/` and run with `node .claude/tools/<tool>`.
Everything except `create-pr`, `workflows run` and `evaluation.mjs sign` is
pre-allowed in `settings.json`. The first two open a PR or start containers,
and `sign` records your own sign-off, so Claude asks first.

| Tool | What it does |
| --- | --- |
| `quality-check.mjs` | Runs lint, typecheck, test, build (and spec validation) and saves the result for the PR |
| `workflows.mjs` / `scripts/ci-local.sh` | Lists and runs the GitHub workflows locally with act |
| `create-pr.mjs` | Drafts a PR from commits, git-comments, the danger-zone spec, the board task and the last quality run |
| `git-comments.mjs` | Notes on commits, kept as git notes so hashes never change |
| `worktree-history.mjs` | A worktree's branch, base, commits, comments and uncommitted changes, for resuming work |
| `list-packages.mjs` | Lists dependencies from manifests without installing anything |
| `roadmap.mjs` | Shows the current milestone of `ROADMAP.md`, checks it and records decisions |
| `sync-docs.mjs` | Finds Markdown that no longer matches the repository: dead links, missing scripts |
| `spec-quiz.mjs` | The quiz `confirming-specs` runs before implementation |
| `validate-specs.mjs` | Validates `docs/specs/` with the OpenSpec CLI |
| `tasks.mjs` / `review.mjs` / `subagents.mjs` | The task board, the review package and which subagent runs each step (with `tracking-tasks`) |
| `evaluation.mjs` | Category KPIs, recorded measurements and the scorecard (with `evaluating-outputs`) |

### Slash commands, plugins and MCP servers

- **Commands:** `/roadmap [focus]` interviews you and writes `ROADMAP.md`.
  `/github-setup [workflows]` writes git hooks, workflows and templates.
- **Plugins**, suggested for every project: `superpowers` (brainstorming,
  plans, subagent-driven development, debugging, TDD), `code-review`,
  `claude-md-management`, `security-guidance` and `context7`. Suggested by
  stack: language servers, `frontend-design` for UI frameworks, `playwright`,
  database plugins (Prisma, Supabase, MongoDB, Neon, Firebase, Redis), the
  official PostHog and Sentry plugins, and pinned NestJS, Gin and Flask
  best-practice plugins. Others such as `code-simplifier`, `commit-commands`,
  `pr-review-toolkit`, `feature-dev`, `show-me-the-work` and `caveman`
  (terse, token-saving replies) are one keypress away.
- **MCP servers** for `.mcp.json`, none selected by default: `context7`,
  `postman`, `notion`, `posthog`, `sentry` and `playwright`.

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

The tools are listed in [Project tools](#project-tools).

OpenSpec only reads an `openspec/` folder, so `validate-specs.mjs` copies
`docs/specs/` into a temporary `openspec/specs/` and `docs/specs/changes/`
into `openspec/changes/`, runs `openspec validate --all --strict`, and reports
paths under `docs/specs/`. `quality-check` runs it as its `specs` step when
`docs/specs/` exists.

The dependency listing tool reads manifests without installing packages:

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

The repository has no CI for tests: run these checks before a commit or a
release. The only workflow, `.github/workflows/pages.yml`, publishes this README
to [GitHub Pages](https://alouani-youssef.github.io/stones/) whenever
`README.md` changes on `main`.
`npm run check` also runs shellcheck on the shell scripts when it is installed.
Releases are versioned from `package.json` and tagged as `v<version>`.

## License

[MIT](LICENSE) © 2026 ALOUANI YOUSSEF. The vendored plugins in `plugins/`
retain their upstream licenses: `nestjs-best-practices` is MIT (Kadajett),
while `gin-best-practices` and `flask-best-practices` are Apache-2.0. See each
plugin's `LICENSE` and `UPSTREAM.md`.
