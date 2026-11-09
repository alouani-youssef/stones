# claude-stones

Generate a Claude Code setup tailored to a project: a `.claude/` folder with
only the hooks, permissions and skills the project needs, an `AGENT.md` that
tells Claude what the project is and how to work in it, and a `ROADMAP.md`
written with you in a Claude session.

```sh
npx claude-stones init          # answer a few questions in your project root
npx claude-stones roadmap       # start a Claude session that writes ROADMAP.md
```

From a clone of this repository: `bash setup.bash init /path/to/project`.
Requires Node.js 22.13+ (the history hook uses the built-in `node:sqlite`).

## What `init` does

1. **Detects the stack** from the files already there: languages, frameworks,
   package manager, monorepo tool, test/lint/typecheck/build commands,
   formatters, commit style. Run `npx claude-stones detect` to see it.
2. **Asks about what it cannot detect**, with detected values as defaults:
   what the project is, what each top-level folder holds, architecture,
   design patterns, secrets and auth, conventions, branching, TDD, and which
   hooks, skills, plugins and MCP servers to install.
3. **Writes the setup**:

```
AGENT.md                  project brief for Claude, from your answers
CLAUDE.md                 "@AGENT.md" (appended if CLAUDE.md already exists)
.mcp.json                 only the MCP servers you picked
.gitignore                + generated graph and local settings
.claude/
├── settings.json         selected hooks, permissions for your commands,
│                         sandbox limited to your package registries,
│                         enabled plugins (official + stones marketplaces)
├── hooks/                only the selected hooks
├── skills/               only the selected skills and pattern skills
├── graph/                code graph (with the graph hook)
├── atomicity.json        atomicity hook config, detected defaults (with the atomicity hook)
├── danger/               specs for db, packages and network branches (atomicity hook)
├── commands/roadmap.md   the /roadmap command
├── tools/                list-packages, git-comments, worktree-history,
│                         quality-check, create-pr, roadmap, sync-docs;
│                         tasks.mjs + review.mjs (with the tracking-tasks skill)
└── stones.json           your answers and installed-file hashes
context/tasks/            task board (with the tracking-tasks skill)
├── list/                 one file per task
└── state/                current.md, next.md, blocked.md, done.md
```

## Why it is efficient

- **Small always-loaded context.** `CLAUDE.md` only imports `AGENT.md`, a short
  brief. Guides ship as Claude Code skills in `.claude/skills/`: only each
  skill's one-line "Use when…" description is in context, and Claude loads the
  body (and its reference files) when the task matches: committing, opening a
  PR, writing tests, naming a file, and so on. `ROADMAP.md` is linked, not loaded.
- **Only what the stack uses.** Permissions come from your real commands
  (`pnpm run test`, `uv run pytest`, `go test`); sandbox domains from your
  ecosystems; nx rules only in nx repos; the format hook only when a formatter
  exists; the jq status line and `block-rm` hook only when jq is installed.
- **Open-source plugins by default.** `superpowers`, `code-review`,
  `claude-md-management`, `security-guidance` and `context7` are enabled in
  every project; the language server, frontend and database plugins
  (`prisma`, `supabase`, `mongodb`, `neon`, `firebase`, `redis-development`)
  only when the stack uses them. They live in `enabledPlugins`, so Claude Code
  offers to install them when someone trusts the repo.
- **Framework best-practice plugins.** This repository is also the `stones`
  marketplace (`.claude-plugin/marketplace.json`), with Claude Code plugins in
  `plugins/`: `nestjs-best-practices`
  (from [Kadajett/agent-nestjs-skills](https://github.com/Kadajett/agent-nestjs-skills)),
  `gin-best-practices` and `flask-best-practices`
  (from [TerminalSkills/skills](https://github.com/TerminalSkills/skills)). Each
  vendors a community skill unchanged from a pinned commit, recorded in its
  `UPSTREAM.md`, and is enabled only when NestJS, Gin or Flask is detected.
- **Pattern skills match the stack.** Repository for ORMs, dependency
  injection for NestJS/Angular/JVM, summary-details for API frameworks.
- **Fast re-runs.** Previous answers become the defaults, so updating the
  setup is mostly pressing Enter, or `init --yes`.

## Re-running safely

`init` can be run again at any time, for example after upgrading the package
or changing your answers:

| File                                   | What happens                                       |
| -------------------------------------- | -------------------------------------------------- |
| Installed file you have not edited     | Updated                                            |
| Installed file you edited              | Left alone and reported (`--force` overwrites)     |
| `.claude/settings.json`, `.mcp.json`   | Merged: your keys and rules are kept               |
| `CLAUDE.md`, `.gitignore`              | Lines appended only if missing                     |
| `.claude/graph/project.json`           | Created once, then owned by the graph hook         |
| `.claude/atomicity.json`               | Created once, then owned by you                    |

Use `--dry-run` to see the plan without writing anything.

Setups made before guides became skills keep their choices: saved guide ids
map to the new skill names, and skills added since are offered. Old files in
`.claude/docs/` are not removed; delete that folder once `.claude/skills/` is in place.

## Roadmap sessions

`npx claude-stones roadmap` opens Claude Code with the `/roadmap` prompt. Claude
reads `AGENT.md`, the existing `ROADMAP.md`, recent commits and any OpenSpec
specs, interviews you in short rounds (outcome, the one milestone for *Now*,
*Next*/*Later*, constraints, risks), shows a draft, and writes `ROADMAP.md`.
Run it again to revise: finished milestones move out of *Now* and the reason
for each change is recorded under *Decisions*.

```sh
npx claude-stones roadmap --focus "plan the next milestone"
npx claude-stones roadmap --print-prompt   # just print the prompt
```

Inside Claude Code the same session is `/roadmap [focus]`.

## Task board

With the `tracking-tasks` skill, `init` installs a task board and two tools.
Each task is a file in `context/tasks/list/` (expected behavior, scenarios,
contract change, and a `Scope` of globs it may touch). The files in
`context/tasks/state/` list which tasks are current, next, blocked and done.

```sh
node .claude/tools/tasks.mjs add "Rate limit logins" --scope "src/auth/**,tests/auth/**"
node .claude/tools/tasks.mjs start 1        # records the branch and base commit
node .claude/tools/tasks.mjs done 1         # runs the tests; moves to done.md only if they pass
node .claude/tools/tasks.mjs review 1 --run-tests
```

- **One current task.** The testing hook reads the task linked from
  `state/current.md` and blocks test runs until its scenarios are filled in.
- **Done means tested.** `done` runs the project's test command and records
  the commit range and result in `state/done.md`; a failing run records nothing.
- **Review against the promise.** `review` writes `.claude/reviews/<id>.md`
  (git-ignored) and exits 1 when the task is not ready. The file holds the
  verdict, each scenario and whether a changed test covers it, commits, files
  and the diff. It flags failing or stale test runs, missing tests, changes
  outside the scope, db/packages/network changes mixed with others (atomicity
  hook), and functions the complexity hook rejects.

Without the skill, the testing hook keeps reading `context/tasks/active.md`.

## Listing packages

Every project gets `.claude/tools/list-packages.mjs`, and AGENT.md tells Claude
to run it before adding a dependency. It reads the manifests already in the
repository (`package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`,
`Cargo.toml`, in every package of a monorepo) without installing anything.

```sh
node .claude/tools/list-packages.mjs              # every manifest, grouped
node .claude/tools/list-packages.mjs --prod       # runtime dependencies only
node .claude/tools/list-packages.mjs --grep redis # is there already a client?
node .claude/tools/list-packages.mjs --json
```

## Git comments and worktree history

Two more tools in every project help a session pick work back up.
`git-comments.mjs` keeps comments on commits as git notes under
`refs/notes/comments`, so the commits themselves never change.
`worktree-history.mjs` shows what happened in a worktree: its branch, the
commit it started from, the commits since then (with their comments),
uncommitted changes and recent HEAD moves.

```sh
node .claude/tools/git-comments.mjs set HEAD "Verified with npm test; docs left"
node .claude/tools/git-comments.mjs append HEAD~1 "Reverted in a later commit"
node .claude/tools/git-comments.mjs get HEAD
node .claude/tools/git-comments.mjs list main..HEAD
node .claude/tools/worktree-history.mjs list            # every worktree
node .claude/tools/worktree-history.mjs show feature/x  # by branch or path; default: this one
```

Notes stay local until you share them:
`git push origin refs/notes/comments`, and
`git fetch origin refs/notes/comments:refs/notes/comments` on the other side.

## Quality, pull requests, roadmap and docs

Four more tools in every project, all plain Node with no dependencies:

```sh
node .claude/tools/quality-check.mjs                  # lint, typecheck, test, build from your init answers
node .claude/tools/quality-check.mjs --only test --cmd test="pytest -q"
node .claude/tools/create-pr.mjs draft > .claude/pr.md  # Summary/Zone/Spec/Risk/Rollback/Verification
node .claude/tools/create-pr.mjs create --body-file .claude/pr.md [--base deps/x] [--draft]
node .claude/tools/roadmap.mjs show                   # outcome, the Now milestone, Next
node .claude/tools/roadmap.mjs check                  # one Now milestone, 2-4 Next, revised recently
node .claude/tools/roadmap.mjs decide "Use git notes" "Commits stay unchanged"
node .claude/tools/sync-docs.mjs [--fix]              # broken links, missing scripts, stale AGENT.md
```

- `quality-check` skips the format step unless asked (`--only format`),
  because formatters rewrite files. It saves the run to
  `.claude/quality/last.json` with the commit it ran on.
- `create-pr` fills the sections the `opening-pull-requests` skill requires:
  commits and their git comments, the zone from the `db/`, `deps/` or `net/`
  prefix, the danger spec, and the last quality run (flagged if it ran on an
  older commit). `create` refuses a body with TODOs and never pushes: push
  the branch first. It is the one tool not pre-approved in settings, so
  Claude asks before opening a PR.
- `sync-docs --fix` only restores the `@AGENT.md` import in CLAUDE.md.
  Broken links and drifted commands are reported for a person to fix.

## Dev containers

For Node + pnpm, Python and Go projects, `init` adds a dev container (the
default dev sandbox) in `.devcontainer/`, unless you decline. Claude Code's own
sandbox stays on inside it.

- **The Dockerfile is the single source of truth.** `devcontainer.json` is
  generated from it: `USER`, `ENV`, `EXPOSE` and `WORKDIR` of the last stage become
  `remoteUser`, `containerEnv`, `forwardPorts` and `workspaceFolder`. Anything
  else (extensions, `postCreateCommand`, mounts...) goes in
  `LABEL devcontainer.metadata='{...}'`, which wins over derived fields.
  Lifecycle commands (`postCreateCommand`...) stay in the label only: dev
  container tools read it from the image, and copying them would run them twice.
- The Dockerfile is yours after install; re-running `init` never overwrites it,
  but always regenerates `devcontainer.json` from it.
- The `devcontainer` hook regenerates the JSON whenever Claude edits the
  Dockerfile, and undoes hand edits to the JSON.

```sh
npx claude-stones sync           # regenerate .devcontainer/devcontainer.json
npx claude-stones sync --check   # CI: fail if it is out of date
```

## Options

```
-y, --yes         accept defaults and previous answers, no questions
--dry-run         show what init would change, write nothing
--force           overwrite files edited since they were installed
--no-roadmap      do not offer a roadmap session after init
--focus <text>    roadmap focus
--print-prompt    print the roadmap prompt instead of starting Claude
--check           with sync: fail if devcontainer.json is out of date
```

## Repository layout

| Path          | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `bin/`, `cli/`| the `claude-stones` command                                     |
| `AGENT.md`    | section template for the generated `AGENT.md`                   |
| `hooks/`      | hook scripts; any hook registered in `settings/hooks.json` is offered |
| `settings/`   | modular settings sources; `stacks.json` maps ecosystems to permissions and domains |
| `skills/`     | skills offered during setup: `<name>/SKILL.md` plus reference files; `metadata.kind: pattern` marks pattern skills |
| `graph/`      | code graph seed and documentation                               |
| `commands/`   | slash commands installed into `.claude/commands/`               |
| `tools/`      | project tools (packages, git comments, worktree history, quality, PRs, roadmap, docs) and task board tools installed into `.claude/tools/` |
| `mcps/`       | MCP servers offered for `.mcp.json`                             |
| `settings/plugins.json` | plugins offered: `default: true` for every project, `when` to match detected languages/frameworks |
| `devcontainer/` | one dev container per stack (`node-pnpm`, `python`, `go`); `npm run build:devcontainers` regenerates their `devcontainer.json` |

Adding a hook, skill, command or MCP server to these folders is enough for
`init` to offer it. A skill folder without a `SKILL.md` is ignored. `npm run build:settings` regenerates
`settings/settings.json` for this repository; `npm test` runs all tests.
