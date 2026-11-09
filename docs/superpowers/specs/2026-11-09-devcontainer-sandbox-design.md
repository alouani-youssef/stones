# Default dev containers per stack — design

Date: 2026-11-09 · Status: draft, awaiting approval

## Intent

Every project stones installs into should get a ready-to-use **dev sandbox** by
default: a dev container the developer and the agent work inside. stones ships one
general dev container per supported stack. In each, the **Dockerfile is the single
source of truth**; `devcontainer.json` is never edited by hand, it is generated from
the Dockerfile and kept in sync with it.

## Decided (by the user)

- Three general dev containers, one per stack, no mixing:
  - **node-pnpm** (Node + pnpm)
  - **python**
  - **go**
- Other stacks (npm/yarn/bun Node, rust, jvm, ruby, php) get no dev container for now.
- The Dockerfile is the single source of truth; `devcontainer.json` is generated from it
  and never hand-edited.
- A dev sandbox is on by default.
- Claude Code's own sandbox (`settings/sandbox.json`) **stays on** inside the container —
  the container and the Claude Code sandbox both apply.

## Goals

- `stones install` on a node-pnpm / python / go project writes `.devcontainer/Dockerfile`
  and a generated `.devcontainer/devcontainer.json`, by default.
- Editing the Dockerfile (by a human or the agent) is all it takes to change the container;
  `devcontainer.json` follows.
- Drift between the two is detectable and fails loudly.

## Non-goals

- No dev container for stacks outside the three.
- No composing several stacks into one image.
- No container-level firewall in v1 — network limiting stays with the Claude Code sandbox
  (`allowedDomains` from `settings/stacks.json`), which stays on. *(Claude's call.)*
- No publishing prebuilt images to a registry.

## Anti-goals

- A `devcontainer.json` that someone has to edit by hand to make things work.
- A generated file that silently disagrees with its Dockerfile.
- A container in which the installed stones hooks or the Claude Code sandbox can't run.

## Layout in the stones package

```
devcontainer/
  node-pnpm/Dockerfile        source of truth (hand-written)
  node-pnpm/devcontainer.json generated, committed
  python/Dockerfile
  python/devcontainer.json
  go/Dockerfile
  go/devcontainer.json
```

`package.json` `files` gains `devcontainer/`.

## Dockerfile → devcontainer.json mapping

A new module `cli/devcontainer.mjs` parses a Dockerfile (handling line continuations,
comments, multi-stage — **the last stage** is the one that counts) and emits the JSON:

| Dockerfile | devcontainer.json |
|---|---|
| (always) | `"build": { "dockerfile": "Dockerfile", "context": "." }` |
| `FROM` (last stage) | `name` derived from the stack dir / image when not set by metadata |
| `USER` (last) | `remoteUser` |
| `ENV k=v` | `containerEnv` |
| `EXPOSE p` | `forwardPorts` (numbers) |
| `WORKDIR` (last) | `workspaceFolder` + matching `workspaceMount` |
| `LABEL devcontainer.metadata='{…}'` | merged in as-is (`customizations`, `postCreateCommand`, `features`, `mounts`, `capAdd`, …) |

`devcontainer.metadata` is the label the dev container spec already defines, so the
Dockerfile stays valid Docker and tools that read the label understand it too. Fields set
explicitly in the metadata label win over derived ones.

Output is deterministic (stable key order, 2-space JSON), starts with a JSONC header
comment: `// Generated from Dockerfile by stones — edit the Dockerfile, not this file.`

## What every container must contain

Because stones' hooks and Claude Code run inside it:

- Node ≥ 22.13 (hooks are `.mjs`; also the stones CLI) — even in python and go images.
- Claude Code CLI.
- `bubblewrap` and `socat` (required by the Claude Code sandbox on Linux).
- `jq` (status line), `git`.
- A non-root user (`USER` set) — the sandbox and file ownership expect it.
- Per stack: node-pnpm → pnpm via corepack; python → python3 + pip/venv (uv is the
  builder's call); go → go toolchain.

Exact base images and versions are left to the builder; pin versions.

## Install flow

- `cli/questions.mjs`: new confirm `install.devcontainer` — "Add a dev container (the
  default dev sandbox)?" — default **yes**, asked only when a supported stack is detected.
- Stack selection from `detect.mjs` output, first match wins: pnpm → `node-pnpm`,
  else `python` ecosystem → `python`, else `go` → `go`. *(Claude's call for multi-stack
  repos; the developer extends their own Dockerfile for the rest.)*
- Files written into the target:
  - `.devcontainer/Dockerfile` — kind `seed` (the user owns it after install; never
    overwritten on re-run).
  - `.devcontainer/devcontainer.json` — new kind `generated`: always regenerated from the
    **target's** `.devcontainer/Dockerfile` (not from the package copy), so a re-run never
    reports a conflict on it.
- If the target already has a `.devcontainer/` that stones did not install (not in the
  manifest), report it and leave it alone unless `--force`.
- AGENT.md mentions the dev container and that the Dockerfile is what to edit.

## Keeping it in sync

1. **`stones sync`** — regenerates `.devcontainer/devcontainer.json` from
   `.devcontainer/Dockerfile` in the current project. `stones sync --check` regenerates in
   memory and exits non-zero with a diff summary if the file differs (for CI).
2. **Hook** — new `hooks/devcontainer.mjs` on `PostToolUse` (`Edit|MultiEdit|Write`): when
   the edited path is `.devcontainer/Dockerfile`, regenerate; when it is
   `.devcontainer/devcontainer.json`, regenerate (overwriting the hand edit) and tell the
   agent to edit the Dockerfile instead. Selectable like other hooks; on by default when a
   dev container is installed.
3. **Drift test in stones itself** — `cli/stones.test.mjs` asserts each shipped
   `devcontainer/<stack>/devcontainer.json` equals the generator's output for its
   Dockerfile. `npm run build:devcontainers` regenerates them.

## Tests

- Parser: continuations, comments, multi-stage, `ENV` both forms, `EXPOSE 3000/tcp`,
  malformed metadata JSON (clear error, nothing written).
- Mapping table rows, metadata precedence, deterministic output.
- Install plan: devcontainer files planned only for the three stacks; `seed` vs `generated`
  behaviour on re-run; existing unmanaged `.devcontainer/`.
- Hook: fires only on the two paths; no-op otherwise.
- Shipped files in sync (drift test).

## Left to the builder

Base images and versions, Claude Code install method in the image, python tooling (pip vs
uv), extension list in each metadata label, exact `stones sync` output wording.
