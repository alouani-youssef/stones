# claude-stones

Generate a Claude Code setup tailored to a project: a `.claude/` folder with
only the hooks, permissions and guides the project needs, an `AGENT.md` that
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
   hooks, guides and MCP servers to install.
3. **Writes the setup**:

```
AGENT.md                  project brief for Claude, from your answers
CLAUDE.md                 "@AGENT.md" (appended if CLAUDE.md already exists)
.mcp.json                 only the MCP servers you picked
.gitignore                + generated graph and local settings
.claude/
├── settings.json         selected hooks, permissions for your commands,
│                         sandbox limited to your package registries
├── hooks/                only the selected hooks
├── docs/                 only the selected guides and patterns
├── graph/                code graph (with the graph hook)
├── atomicity.json        atomicity hook config, detected defaults (with the atomicity hook)
├── danger/               specs for db, packages and network branches (atomicity hook)
├── commands/roadmap.md   the /roadmap command
└── stones.json           your answers and installed-file hashes
```

## Why it is efficient

- **Small always-loaded context.** `CLAUDE.md` only imports `AGENT.md`, a short
  brief. Guides in `.claude/docs/` and `ROADMAP.md` are linked, so Claude reads
  them when relevant instead of loading them every session.
- **Only what the stack uses.** Permissions come from your real commands
  (`pnpm run test`, `uv run pytest`, `go test`); sandbox domains from your
  ecosystems; nx rules only in nx repos; the format hook only when a formatter
  exists; the jq status line and `block-rm` hook only when jq is installed.
- **Pattern guides match the stack.** Repository for ORMs, dependency
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

## Options

```
-y, --yes         accept defaults and previous answers, no questions
--dry-run         show what init would change, write nothing
--force           overwrite files edited since they were installed
--no-roadmap      do not offer a roadmap session after init
--focus <text>    roadmap focus
--print-prompt    print the roadmap prompt instead of starting Claude
```

## Repository layout

| Path          | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `bin/`, `cli/`| the `claude-stones` command                                     |
| `AGENT.md`    | section template for the generated `AGENT.md`                   |
| `hooks/`      | hook scripts; any hook registered in `settings/hooks.json` is offered |
| `settings/`   | modular settings sources; `stacks.json` maps ecosystems to permissions and domains |
| `docs/`       | guides and pattern docs offered during setup                    |
| `graph/`      | code graph seed and documentation                               |
| `commands/`   | slash commands installed into `.claude/commands/`               |
| `mcps/`       | MCP servers offered for `.mcp.json`                             |

Adding a hook, guide, command or MCP server to these folders is enough for
`init` to offer it. `npm run build:settings` regenerates
`settings/settings.json` for this repository; `npm test` runs all tests.
