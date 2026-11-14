# ai-stones

[![CI](https://github.com/alouani-youssef/stones/actions/workflows/ci.yml/badge.svg)](https://github.com/alouani-youssef/stones/actions/workflows/ci.yml)
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
├── graph/                code graph, when selected
├── analyzers/            complexity analyzer, when selected
├── commands/             slash commands such as /roadmap
├── tools/                project and task-board tools
└── stones.json           saved answers and installed-file hashes
context/tasks/            task board, when selected
```

The exact files depend on your answers and detected stack. Use `--dry-run` to
preview the planned changes without writing files.

## Why use ai-stones

- **Relevant context, loaded when needed.** `CLAUDE.md` imports a short
  `AGENT.md` brief. Guides are installed as Claude Code skills, so their full
  instructions load when a task matches.
- **Useful defaults, optional process gates.** Lightweight guardrails are
  selected by default. Hooks that block work or add context to every prompt
  are opt-in, as are history recording and the code graph.
- **Settings based on the actual project.** Permissions and sandbox domains
  follow detected commands and ecosystems. Framework plugins and pattern
  skills are offered only when relevant.
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
reviews `AGENT.md`, the current roadmap, recent commits and any OpenSpec specs,
then interviews you and drafts or revises `ROADMAP.md`. In Claude Code, you can
also run `/roadmap [focus]`.

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
| `--focus <text>` | Set the focus for a roadmap session |
| `--print-prompt` | Print the roadmap prompt instead of starting Claude |
| `--check` | With `sync`, check for drift without writing |

## Included project tools

Depending on the selected skills, the setup can include tools to inspect
dependencies, review worktree history, store Git comments, run project quality
checks, draft pull requests, manage a roadmap, synchronize documentation and
track tasks. For example, the dependency listing tool reads manifests without
installing packages:

```sh
node .claude/tools/list-packages.mjs
node .claude/tools/list-packages.mjs --prod
node .claude/tools/list-packages.mjs --grep redis
node .claude/tools/list-packages.mjs --json
```

## Repository development

The repository contains the CLI, setup catalogs, hooks, skills, plugins,
settings and dev-container templates. After cloning it, run:

```sh
npm run check     # repository consistency checks
npm test          # unit and hook tests
npm run smoke     # exercise commands on throwaway projects
```

The CI workflow checks generated files and package contents, runs tests on
Linux and macOS, and smoke-tests the packed package against sample projects.
Releases are versioned from `package.json` and tagged as `v<version>`.

## License

[MIT](LICENSE) © 2026 ALOUANI YOUSSEF. The vendored plugins in `plugins/`
retain their upstream licenses: `nestjs-best-practices` is MIT (Kadajett),
while `gin-best-practices` and `flask-best-practices` are Apache-2.0. See each
plugin's `LICENSE` and `UPSTREAM.md`.
