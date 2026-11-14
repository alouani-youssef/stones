# Default Dev Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one dev container per stack (node-pnpm, python, go) whose `devcontainer.json` is generated from its Dockerfile, installed by default by `stones init`, and kept in sync by a hook, `stones sync`, and a drift test.

**Architecture:** The Dockerfile→JSON generator lives in `hooks/devcontainer.mjs`. Hooks are copied standalone into target projects and can't import from the stones package, so the generator has to live in the hook file. It exports pure functions and also runs as a PostToolUse hook. The CLI (`cli/devcontainer.mjs`, `stones sync`, install) imports those functions from `../hooks/devcontainer.mjs`, the same way the tests already import `inspectSpec` from `hooks/atomicity.mjs`.

**Tech Stack:** Node ≥ 22.13 ESM, `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-devcontainer-sandbox-design.md`

## Global Constraints

- Supported stacks, ids exactly: `node-pnpm`, `python`, `go`. No others.
- The Dockerfile is the single source of truth. `devcontainer.json` is always generated, never hand-edited.
- Generated file starts with exactly: `// Generated from Dockerfile by stones — edit the Dockerfile, not this file.\n`, followed by 2-space JSON with stable key order and a trailing newline.
- Metadata label key: `devcontainer.metadata` (JSON). Its fields win over derived ones.
- Claude Code sandbox (`settings/sandbox.json`) stays on. The container adds no firewall.
- Every image: Node ≥ 22.13, Claude Code CLI, `bubblewrap`, `socat`, `jq`, `git`, non-root `USER`. Versions pinned.
- No new npm dependencies.

## Review Focus

1. **`ENV` values that reference variables** (`ENV PATH=/x:$PATH`): copying them verbatim into `containerEnv` would break `PATH`. Expected: values containing `$` are skipped (the image already sets them). Test in Task 1.
2. **Multi-stage Dockerfile**: `USER`/`WORKDIR`/`EXPOSE` from a builder stage must not leak. Only the last stage counts. Test in Task 1.
3. **Agent hand-edits `devcontainer.json`**: expected: the hook regenerates it and tells the agent (stderr, exit 2) to edit the Dockerfile instead. Test in Task 2.
4. **Malformed `devcontainer.metadata` JSON** in the Dockerfile: expected: a clear error naming the label, and the existing `devcontainer.json` is left untouched (hook, sync and install). Tests in Tasks 1, 2, 5.
5. **Project already has its own `.devcontainer/`** not installed by stones: expected: init reports a conflict and doesn't touch it unless `--force`. Test in Task 4.

---

### Task 1: Dockerfile → devcontainer.json generator

**Files:**
- Create: `hooks/devcontainer.mjs`
- Test: `hooks/devcontainer.test.mjs`

**Interfaces:**
- Produces:
  - `parseDockerfile(text: string) → { from: string|null, user: string|null, workdir: string|null, env: Record<string,string>, expose: number[], metadata: object }`, covering the last stage only.
  - `renderDevcontainer(text: string, { name }: { name: string }) → string`, the full file content including the header.
  - `export const HEADER` (the header line above, with `\n`).
  - Throws `Error` whose message contains `devcontainer.metadata` when the label isn't valid JSON.

- [ ] **Step 1: Write failing tests** in `hooks/devcontainer.test.mjs` (`describe('devcontainer generator')`):
  - `joins line continuations and ignores comments`: `RUN a \\\n  b` plus `# USER root` → `user` is `null`.
  - `uses only the last stage`: `FROM golang AS build\nUSER builder\nWORKDIR /src\nEXPOSE 9000\nFROM debian\nUSER dev` → `{ from: 'debian', user: 'dev', workdir: null, expose: [] }`.
  - `parses ENV in both forms and skips $ references`: `ENV A=1 B="x y"\nENV C 3\nENV PATH=/x:$PATH` → `env` deep-equals `{ A: '1', B: 'x y', C: '3' }`.
  - `parses EXPOSE with protocols`: `EXPOSE 3000/tcp 5432` → `[3000, 5432]`.
  - `maps instructions to devcontainer fields`: Dockerfile with `FROM node:22`, `USER node`, `WORKDIR /workspace`, `ENV A=1`, `EXPOSE 3000`, rendered with `{ name: 'node-pnpm' }`. Parse the output after stripping `HEADER` and assert `build` equals `{ dockerfile: 'Dockerfile', context: '.' }`, `name === 'node-pnpm'`, `remoteUser === 'node'`, `containerEnv` equals `{ A: '1' }`, `forwardPorts` equals `[3000]`, `workspaceFolder === '/workspace'`, `workspaceMount === 'source=${localWorkspaceFolder},target=/workspace,type=bind'`.
  - `omits fields with no source`: no USER/ENV/EXPOSE/WORKDIR → keys `remoteUser`, `containerEnv`, `forwardPorts`, `workspaceFolder`, `workspaceMount` absent.
  - `metadata label wins over derived fields`: `LABEL devcontainer.metadata='{"name":"custom","remoteUser":"x","postCreateCommand":"pnpm i"}'` plus `USER node` → `name === 'custom'`, `remoteUser === 'x'`, `postCreateCommand === 'pnpm i'`.
  - `output is deterministic and headed`: render twice → identical, `startsWith(HEADER)`, `endsWith('}\n')`.
  - `rejects malformed metadata`: `LABEL devcontainer.metadata='{bad'` → `assert.throws(..., /devcontainer\.metadata/)`.

- [ ] **Step 2: Run** `node --test hooks/devcontainer.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `parseDockerfile`, `renderDevcontainer` and `HEADER` in `hooks/devcontainer.mjs`. Open the file with a one-line comment (`catalog.mjs` reads it as the hint). Key order of the output: `name, build, remoteUser, containerEnv, forwardPorts, workspaceFolder, workspaceMount`, then metadata keys in their own order (a metadata key that matches a derived key replaces it in place). Handle the `LABEL` value in both quoted and unquoted forms.

- [ ] **Step 4: Run** `node --test hooks/devcontainer.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: add Dockerfile to devcontainer.json generator`.

---

### Task 2: Sync hook

**Files:**
- Modify: `hooks/devcontainer.mjs` (add `syncDevcontainer` and the stdin entry point)
- Modify: `settings/hooks.json` (add to the existing `PostToolUse` `Edit|MultiEdit|Write` group: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/devcontainer.mjs"`)
- Modify: `cli/catalog.mjs` `HOOK_HINTS` (`devcontainer: 'regenerates .devcontainer/devcontainer.json whenever its Dockerfile is edited'`)
- Test: `hooks/devcontainer.test.mjs`

**Interfaces:**
- Consumes: `renderDevcontainer`, `HEADER` (Task 1).
- Produces: `syncDevcontainer(dir: string, { check?: boolean, name?: string }) → { status: 'written'|'same'|'drift'|'missing' }`. `dir` is the folder containing `Dockerfile`. `name` defaults to `metadata.name ?? basename(projectRoot)`, where the hook passes the project root's basename. `check: true` never writes and returns `'drift'` when the file differs. It throws on malformed metadata without writing.
- Run as a script, it reads hook JSON from stdin (`tool_input.file_path`) and acts only when the path, relative to `CLAUDE_PROJECT_DIR`, is `.devcontainer/Dockerfile` or `.devcontainer/devcontainer.json`. Use the `import.meta.url`/`process.argv[1]` main guard so tests can import it without running it.

- [ ] **Step 1: Write failing tests.** Spawn the hook with `execFileSync('node', [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: root } })` in a temp project:
  - `regenerates after a Dockerfile edit`: json missing → after the run, the file equals `renderDevcontainer(dockerfile, { name: basename(root) })` and the exit code is 0.
  - `reverts a hand edit to devcontainer.json and tells the agent`: write `{}` to the json, run with that path → the process exits 2, stderr contains `edit .devcontainer/Dockerfile`, and the file is regenerated.
  - `ignores other paths`: `src/index.ts` → exit 0, no `.devcontainer/devcontainer.json` created.
  - `ignores a project without a Dockerfile`: path `.devcontainer/devcontainer.json` with no Dockerfile → exit 0, nothing written.
  - `leaves the json alone on malformed metadata`: existing json `X`, Dockerfile with a bad label → exit 2, stderr mentions `devcontainer.metadata`, the file is still `X`.
  - `syncDevcontainer check mode reports drift without writing`: returns `{ status: 'drift' }` and the file is unchanged.

- [ ] **Step 2: Run** `node --test hooks/devcontainer.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `syncDevcontainer` and the entry point. Register the hook in `settings/hooks.json` and add the hint.

- [ ] **Step 4: Run** `npm test`. Expected: PASS. The existing catalog/settings tests should now list `devcontainer` as a hook. Update any test that asserts the full hook list.

- [ ] **Step 5: Commit** `feat: add devcontainer sync hook`.

---

### Task 3: The three shipped dev containers + drift test

**Files:**
- Create: `devcontainer/node-pnpm/Dockerfile`, `devcontainer/python/Dockerfile`, `devcontainer/go/Dockerfile`
- Create (generated): `devcontainer/{node-pnpm,python,go}/devcontainer.json`
- Create: `cli/devcontainer.mjs`
- Modify: `package.json` (`files` += `"devcontainer/"`; `scripts` += `"build:devcontainers": "node cli/devcontainer.mjs"`)
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `renderDevcontainer` (Task 1).
- Produces (in `cli/devcontainer.mjs`):
  - `export const DEVCONTAINER_STACKS = ['node-pnpm', 'python', 'go']`
  - `devcontainerStack(stack) → 'node-pnpm'|'python'|'go'|null`, where `stack` is a `detect()` result. First match wins: `packageManagers` includes `'pnpm'` → `node-pnpm`; else `ecosystems` includes `'python'` → `python`; else includes `'go'` → `go`; else `null`.
  - `buildShipped(root = PACKAGE_ROOT) → void` writes each `devcontainer/<id>/devcontainer.json` with `name: <id>`. It runs when the file is executed directly.

- [ ] **Step 1: Write failing tests** (`describe('devcontainers')`):
  - `shipped devcontainer.json files match their Dockerfiles`: for each id, the file content equals `renderDevcontainer(dockerfile, { name: id })`.
  - `every image has what stones and the Claude sandbox need`: each Dockerfile matches `/bubblewrap/`, `/socat/`, `/\bjq\b/`, `/\bgit\b/`, `/claude-code/`, and a last `USER` that isn't `root`. Python and go also match `/node/i`.
  - `picks the stack`: pnpm+python → `node-pnpm`; npm-only node → `null`; python → `python`; go → `go`; rust → `null`. Use `detect()` on `project()` fixtures, e.g. `pnpm-lock.yaml` vs `package-lock.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`.

- [ ] **Step 2: Run** `node --test cli/`. Expected: FAIL.

- [ ] **Step 3: Write the three Dockerfiles.** Use pinned Debian-based official images: `node:22-bookworm` with pnpm via `corepack enable`; `python:3.13-bookworm` with Node 22 from NodeSource or a copy of the node binary; `golang:1.25-bookworm` with Node 22 the same way. `apt-get install` `bubblewrap socat jq git`. Install Claude Code with `npm install -g @anthropic-ai/claude-code`. Set a non-root `USER` and `WORKDIR /workspace`. Put a `LABEL devcontainer.metadata` with the stack's VS Code extensions and a `postCreateCommand` (`pnpm install` / `pip install -e .` if `pyproject.toml` exists / `go mod download`). Implement `cli/devcontainer.mjs`, then run `npm run build:devcontainers`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS. If Docker is available, also run `docker build devcontainer/<id>` for each image and confirm all three build. If not, say so in the task report.

- [ ] **Step 5: Commit** `feat: ship node-pnpm, python and go dev containers`.

---

### Task 4: Install the dev container by default

**Files:**
- Modify: `cli/questions.mjs` (new confirm after the sandbox question)
- Modify: `cli/install.mjs` (`desiredFiles`, `plan`, `apply`, `SYMBOLS` unchanged)
- Modify: `cli/agent-doc.mjs` (one line when installed)
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `devcontainerStack` (Task 3), `renderDevcontainer` (Task 1).
- Produces: `answers.install.devcontainer: 'node-pnpm'|'python'|'go'|null`.

Behaviour:
- Question key `install.devcontainer`, text `Add a dev container (the default dev sandbox)?`, default `p('install.devcontainer', true)`. It's asked only when `devcontainerStack(stack)` isn't `null`. The stored answer is the stack id when yes, otherwise `null`.
- `desiredFiles` adds:
  - `.devcontainer/Dockerfile`: the package's Dockerfile, kind `seed`.
  - `.devcontainer/devcontainer.json`: kind `generated`, content `renderDevcontainer(<target's Dockerfile if present, else package's>, { name: basename(target) })`. `desiredFiles` needs `target` passed through from `plan`.
- `plan`: a `generated` file is `create`/`same`/`update` whatever was edited by hand. Exception: when `.devcontainer/` exists and `.devcontainer/Dockerfile` isn't in the manifest, both files become `conflict` with reason `existing .devcontainer not installed by stones` unless `force`. Malformed metadata → the json op is `conflict` with the error message as the reason.
- `apply`: record the `seed` Dockerfile's sha on create, so that a later run recognises it as stones-installed, and record `generated` files the same way as `managed` ones.
- AGENT.md: when `answers.install.devcontainer` is set, add the line `Dev container: .devcontainer/ (\`<id>\`). Edit .devcontainer/Dockerfile only — devcontainer.json is generated from it.`

- [ ] **Step 1: Write failing tests** with `createScriptedPrompter` and the existing `nextApp()` (pnpm) fixture:
  - `installs the node-pnpm dev container by default`: the plan has `create` for both paths, and the json content equals `renderDevcontainer(pkgDockerfile, { name: basename(root) })`.
  - `does not offer a dev container for unsupported stacks`: an npm-only fixture has no `.devcontainer/` ops, and `answers.install.devcontainer === null`.
  - `regenerates json from the project's edited Dockerfile on re-run`: apply, append `ENV X=1` to the target Dockerfile, re-plan → Dockerfile `keep`, json `update`, and the content's `containerEnv.X === '1'`.
  - `leaves an existing unmanaged .devcontainer alone`: a fixture with `.devcontainer/Dockerfile` already present → both ops are `conflict` with the reason. With `force: true` the Dockerfile is still `keep` (seed) and the json is `update`.
  - `AGENT.md mentions the dev container`.

- [ ] **Step 2: Run** `node --test cli/`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the behaviour above.

- [ ] **Step 4: Run** `npm test`. Expected: PASS. Fix any existing test whose scripted answers need `install.devcontainer`.

- [ ] **Step 5: Commit** `feat: install a dev container by default for supported stacks`.

---

### Task 5: `stones sync` command

**Files:**
- Modify: `bin/stones.mjs` (`sync` command, `--check` option, HELP lines)
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `syncDevcontainer` (Task 2).

Behaviour: `stones sync [dir]` calls `syncDevcontainer(join(target, '.devcontainer'), { name: basename(target) })` and prints `devcontainer.json <status>`. `--check` passes `check: true` and exits 1 on `drift`. `missing` prints `no .devcontainer/Dockerfile` and exits 0. Malformed metadata prints the error and exits 1. HELP gets these lines:
```
  npx ai-stones sync [dir]      Regenerate .devcontainer/devcontainer.json from its Dockerfile
  --check            With sync: fail if devcontainer.json is out of date, write nothing
```

- [ ] **Step 1: Write failing tests.** Spawn `node bin/stones.mjs sync <root>` on temp projects:
  - `sync writes devcontainer.json`: exit 0, the file exists.
  - `sync --check fails on drift without writing`: json `{}` → exit 1, still `{}`.
  - `sync --check passes when in sync`: exit 0.
  - `sync reports bad metadata`: exit 1, stderr matches `/devcontainer\.metadata/`, the file is untouched.

- [ ] **Step 2: Run** `node --test cli/`. Expected: FAIL.

- [ ] **Step 3: Implement** it in `bin/stones.mjs`.

- [ ] **Step 4: Run** `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat: add stones sync for dev containers`. Also update `README.md` with a short "Dev containers" section covering the three stacks, the Dockerfile as source of truth, `stones sync`/`--check`, and the hook.
