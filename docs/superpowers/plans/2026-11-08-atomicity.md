# Atomicity & Danger Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A blocking `atomicity` PreToolUse hook plus `docs/atomicity/` guides that make the agent keep commits/branches/PRs single-zone, put `db`/`packages`/`network` changes on dedicated prefixed branches with a spec, and generate migrations instead of hand-writing them. claude-stones installs all of it.

**Architecture:** One self-contained hook file `hooks/atomicity.mjs` (hooks are installed as single files, so no local imports), split into pure sections — config, classifier, command parser, spec checker — and a thin git layer that shells out to `git`. `evaluate(event, { projectDir })` returns `{ block, reason }` like `guard.mjs`/`testing.mjs`; the CLI entry exits 2 with the reason on block. The CLI detects the migration tool and seeds `.claude/atomicity.json`.

**Tech Stack:** Node.js ≥ 22.13, ESM, `node:test`, `node:child_process` (`spawnSync('git', …)`), no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-atomicity-design.md`

## Global Constraints

- Node ≥ 22.13; no new npm dependencies; ESM (`"type": "module"`).
- Hook file is standalone: imports only `node:*` modules.
- Block = exit code 2 with reason on stderr; any hook-internal error → allow (exit 0).
- Every block reason starts with `Atomicity guard (R<n>):`, names the files, and the next command to run.
- Danger zones: `db`, `packages`, `network`. Branch prefixes: `db/`, `deps/`, `net/`.
- Spec dir: `.claude/danger/`, file `<branch with "/" replaced by "--">.md`.
- Spec sections: `## Zone`, `## What changes`, `## Why`, `## Blast radius`, `## Rollback`, `## Verification`.
- Class precedence: `db` > `packages` > `network` > `neutral` > `code`.
- `network.incoming` defaults to `false`; `migrations.allowEdits` defaults to `false`.
- Do not modify `hooks/testing.mjs` (it has the user's uncommitted work).
- Work on branch `feat/atomicity-hook`; never stage `hooks/testing.mjs`.

## Review Focus

- **Paths with spaces / renames in git output** — `git diff --name-status -z` must be parsed so `src/my file.ts` and `R100 old new` classify the new path. Test in Task 4.
- **First commit in a repo / no `HEAD`** — staged diff and dependency comparison must work with no parent commit (compare against empty). Test in Task 4.
- **`git commit -am "..."` and `git -C dir commit`** — combined short flags and global options before the subcommand must still be recognised as a commit with `all: true`. Test in Task 3.
- **Chained commands** — `git add -A && git commit -m x` must evaluate the commit against what will be staged after `git add` runs; since PreToolUse runs before both, treat `git add <paths>`/`-A`/`.` in the same command as adding those paths to the staged set. Test in Task 6.
- **Non-ASCII / binary files** — binary files show no added lines; they classify by path only and never crash the content scan. Test in Task 2.

---

### Task 1: Config loading and path classification

**Files:**
- Create: `hooks/atomicity.mjs`
- Test: `hooks/atomicity.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULTS` — the config object from the spec's Configuration section, with built-in path lists filled in.
  - `loadConfig(project: string): Config` — reads `.claude/atomicity.json` if present; `extraPaths`/`extraPatterns` append to built-ins, `paths`/`patterns` replace them; invalid JSON → `DEFAULTS`.
  - `pathClass(file: string, config: Config): 'db'|'packages'|'network'|'neutral'|'code'|'manifest'` — `'manifest'` marks `package.json`/`pyproject.toml`/`Cargo.toml`, resolved later by Task 2.
  - `globToRegExp(glob: string): RegExp` (supports `**`, `*`, `?`).

- [ ] **Step 1: Write failing tests** (`describe('pathClass')`)
  - `prisma/migrations/2024_x/migration.sql` → `db`; `alembic/versions/a1.py` → `db`; `app/models.py` → `db`; `src/order.entity.ts` → `db`; `db/schema.rb` → `db`.
  - `pnpm-lock.yaml`, `go.sum`, `requirements-dev.txt` → `packages`; `package.json` → `manifest`.
  - `.mcp.json` → `network`.
  - `src/api.test.ts`, `tests/x.py`, `__mocks__/s.ts`, `.claude/danger/db--x.md`, `README.md` → `neutral`.
  - `src/index.ts` → `code`.
  - precedence: `tests/migrations/001.sql` → `db`.
  - config: `{ zones: { db: { extraPaths: ['sql/**'] } } }` makes `sql/a.sql` `db`; `{ zones: { db: { paths: ['only/**'] } } }` makes `prisma/migrations/x.sql` `code`.

- [ ] **Step 2: Run** `node --test hooks/atomicity.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `DEFAULTS`, `globToRegExp`, `loadConfig`, `pathClass` in `hooks/atomicity.mjs`. Use the path lists from the spec's "Zone classification" section verbatim.
- [ ] **Step 4: Run** `node --test hooks/atomicity.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** `git add hooks/atomicity.mjs hooks/atomicity.test.mjs && git commit -m "feat(atomicity): config and path classification"`

### Task 2: Content classification (network patterns, dependency sections)

**Files:** Modify `hooks/atomicity.mjs`, `hooks/atomicity.test.mjs`

**Interfaces:**
- Consumes: `pathClass`, `Config`.
- Produces:
  - `networkHit(addedLines: string[], config: Config): string|null` — the first matching line, or null.
  - `dependencyChanged(file: string, before: string, after: string): boolean` — JSON deep-compare of `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies` for `package.json`; text-compare of `[project]` `dependencies = [...]`, `[project.optional-dependencies]`, `[tool.poetry.*dependencies]`, `[dependency-groups]` for `pyproject.toml`; `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, `[workspace.dependencies]` for `Cargo.toml`. Unparseable → `true` (fail closed).
  - `classify(change: { file, added: string[], before?: string, after?: string }, config): Class` — `pathClass`, then `manifest` → `packages|code` via `dependencyChanged`, then `code` → `network` via `networkHit`.

- [ ] **Step 1: Write failing tests**
  - `networkHit(["const r = await fetch('https://api.stripe.com/v1')"])` → truthy.
  - `fetch('/api/orders')`, `fetch(url)`, `'http://localhost:3000'`, `'https://example.com'` → null.
  - `import Stripe from 'stripe'`, `import boto3`, `const ws = new WebSocket(u)`, `process.env.PAYMENTS_URL`, `os.environ["MAIL_HOST"]` → truthy.
  - `app.post('/orders', h)` → null by default; truthy with `{ zones: { network: { incoming: true } } }`.
  - `extraPatterns: ['\\bmyHttp\\(']` matches `myHttp(x)`; `ignore: ['src/legacy/**']` makes `classify` of `src/legacy/a.ts` with a Stripe import return `code`.
  - `dependencyChanged('package.json', '{"scripts":{"a":"x"}}', '{"scripts":{"a":"y"}}')` → false; adding `"dependencies":{"zod":"^3"}` → true; `'not json'` → true.
  - `classify` of a test file with `fetch('https://x.io')` → `neutral`.
  - binary: `classify({ file: 'logo.png', added: [] })` → `code`, no throw.
- [ ] **Step 2: Run** `node --test hooks/atomicity.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `networkHit`, `dependencyChanged`, `classify`. URL rule: match `\b(?:https?|wss?):\/\/([^/'"\s:]+)` and skip hosts `localhost`, `127.0.0.1`, `0.0.0.0`, `*.local`, `example.com`, `*.example.com`. Env rule: `(?:process\.env\.|os\.environ(?:\.get)?\(?\[?["']|os\.Getenv\(")[A-Z0-9_]*_(?:URL|HOST|ENDPOINT|API_KEY)\b`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(atomicity): network and dependency content checks"`

### Task 3: Bash command parsing

**Files:** Modify `hooks/atomicity.mjs`, `hooks/atomicity.test.mjs`

**Interfaces:**
- Produces:
  - `tokenize(command: string): string[][]` — shell words per simple command, split on `&&`, `||`, `;`, `|`, newline; respects single/double quotes and backslash; skips comments and heredoc bodies (copy the approach from `guard.mjs`).
  - `gitIntents(command: string): { adds: string[]|'all'|null, commit: { all: boolean, paths: string[] }|null, push: boolean, pr: { base: string|null }|null }` — skips git global options (`-C <dir>`, `-c <k=v>`, `--no-pager`…) before the subcommand; commit `all` from `-a`, `--all`, or any combined short flag containing `a` (`-am`); `git add -A|--all|.` → `'all'`.
  - `shellWriteTargets(command: string): string[]` — targets of `>`, `>>`, `tee [-a]`, `cp … <dst>`, `mv … <dst>`, `touch`.

- [ ] **Step 1: Write failing tests**
  - `gitIntents('git commit -am "x"').commit` → `{ all: true, paths: [] }`.
  - `gitIntents('git -C repo commit -m x -- src/a.ts').commit.paths` → `['src/a.ts']`.
  - `gitIntents('echo "git commit"').commit` → null.
  - `gitIntents('git add -A && git commit -m x').adds` → `'all'`.
  - `gitIntents('gh pr create --base deps/zod --title t').pr` → `{ base: 'deps/zod' }`; `gitIntents('git push origin HEAD').push` → true.
  - `shellWriteTargets('echo x > prisma/migrations/1/m.sql')` and `cp a.sql db/migrate/1.rb` include the migration path.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `tokenize`, `gitIntents`, `shellWriteTargets`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(atomicity): parse git and write intents from bash"`

### Task 4: Git layer

**Files:** Modify `hooks/atomicity.mjs`, `hooks/atomicity.test.mjs`

**Interfaces:**
- Consumes: `Config`.
- Produces (`Change = { file: string, added: string[], before?: string, after?: string }`):
  - `git(project: string, args: string[]): { ok: boolean, out: string }`.
  - `isRepo(project): boolean`, `currentBranch(project): string|null`.
  - `defaultBranch(project, config): string|null` — `config.defaultBranch` if that ref exists, else `origin/HEAD`, else `main`/`master` if present, else null.
  - `stagedChanges(project, extra: { all: boolean, paths: string[]|'all' }): Change[]` — index vs `HEAD` (or the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904` when no `HEAD`), parsed from `git diff --cached --name-status -z` and `-U0` added lines; `extra.all` adds tracked modified files (`git diff --name-only -z`), `extra.paths` adds those files (`'all'` adds tracked modified + untracked); `before`/`after` filled only for manifest files.
  - `branchBase(project, config, prBase: string|null): string|null` — `prBase` if given; else among the default branch and local branches matching a danger prefix (excluding the current one), the candidate whose `merge-base` with HEAD is nearest (fewest commits `git rev-list --count <mb>..HEAD`).
  - `branchChanges(project, base: string): Change[]` — `git diff <merge-base>..HEAD`, same parsing.
  - `readAtRef(project, ref: string|null, file): string|null` (`null` ref = index, via `git show :file`).

- [ ] **Step 1: Write failing tests** — helper `repo()` makes a temp dir, `git init -b main`, sets `user.email/name`, writes files, commits.
  - Fresh repo, no commit, `src/my file.ts` staged → one change with `file: 'src/my file.ts'`.
  - Rename `a.ts` → `b.ts` staged → change file `b.ts`.
  - `stagedChanges(p, { all: true, paths: [] })` includes a modified unstaged tracked file.
  - Stacked: `main` → `deps/zod` (package.json change) → `feat/use-zod` (src change); on `feat/use-zod`, `branchBase` → `deps/zod` and `branchChanges` contains only the src file.
  - `defaultBranch` in a repo with only `master` → `master`; with none of them → null.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the functions above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(atomicity): git readers for staged and branch changes"`

### Task 5: Spec checker

**Files:** Modify `hooks/atomicity.mjs`, `hooks/atomicity.test.mjs`

**Interfaces:**
- Produces:
  - `specPath(config, branch: string): string` — `${config.specDir}/${branch.replaceAll('/', '--')}.md`.
  - `inspectSpec(text: string|null, zone: Zone): { valid: true } | { valid: false, reason: string }` — reuses the `section` and `isPlaceholder` rules copied from `testing.mjs` (TODO/TBD/"replace me"/`[describe…]` brackets count as placeholders). `## Zone` must equal `zone`.

- [ ] **Step 1: Write failing tests** — `null` → invalid naming the path to create; missing `## Rollback` → reason names `Rollback`; `## Why\nTBD` → invalid; `## Zone\nnetwork` for `db` → invalid; complete spec → valid.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(atomicity): danger-zone spec checker"`

### Task 6: `evaluate` — rules R1–R4, exemptions, CLI entry

**Files:** Modify `hooks/atomicity.mjs`, `hooks/atomicity.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: `evaluate(event, { projectDir }?): { block: boolean, reason?: string, note?: string }`; CLI entry reads stdin, on block `console.error(reason)` + exit 2, prints `note` to stdout when present, swallows its own errors.

Rule order per event:
1. `enabled: false` → allow.
2. Edit/MultiEdit/Write, or Bash `shellWriteTargets`: path under `migrations.dirs` (or any built-in migration dir when `dirs` empty) and `!allowEdits` → block R4 with `migrations.generate` (fallback text: "run your ORM's migration generator"). Path `.claude/atomicity.json` → block ("only a human edits this file").
3. Bash with no commit/push/pr intent → allow. Not a repo → allow with note `atomicity: not a git repo, skipped`.
4. Current branch in `exempt` → allow.
5. Commit: changes = `stagedChanges` + `adds` from the same command. Classes = non-neutral classes present. >1 → block R1 listing files per class and `git restore --staged <files>` for every class but the largest danger class. Exactly one danger class `z`: on default branch → block R2 ("create `<prefix>…` branch"); branch lacks `prefixes[z]` → block R2; spec (index version, or working file if staged in this commit) fails `inspectSpec` → block R3.
6. Commit, push and pr: base = `branchBase` (null → allow with note `atomicity: no default branch, branch checks skipped`). Branch classes = classes of `branchChanges(base)` ∪ step-5 classes. >1 → block R2 listing files per class. One danger class → R3 spec check on `HEAD` version (for push/pr).

- [ ] **Step 1: Write failing tests** (temp repos from Task 4's helper, events built like `testing.test.mjs`)
  - `Write prisma/migrations/1/m.sql` → block, reason contains `R4` and the configured generate command.
  - `Write .claude/atomicity.json` → block.
  - Commit staging `prisma/migrations/1/m.sql` + `src/index.ts` → block `R1`, reason lists both.
  - Same db-only commit on `main` → block `R2`; on `feat/x` → block `R2` (prefix); on `db/orders` without spec → block `R3`; with valid spec staged in the same commit → allow.
  - `git add -A && git commit -m x` with an untracked `pnpm-lock.yaml` and modified `src/a.ts` → block `R1`.
  - `db/orders` branch already holding a migration commit, now committing `src/a.ts` → block `R2`.
  - `gh pr create` on `net/stripe` whose `HEAD` spec has `## Rollback\nTBD` → block `R3`.
  - `exempt: ['db/orders']` → the R2 case above is allowed.
  - Code-only commit on `feat/x` → allow; non-repo dir → allow with note.
  - CLI: `spawnSync('node', ['hooks/atomicity.mjs'])` with a blocking event on stdin → exit 2, stderr contains `Atomicity guard`; with `'garbage'` → exit 0.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm run test:hooks` — PASS (all hook suites).
- [ ] **Step 5: Commit** `git commit -m "feat(atomicity): enforce single-zone commits, dedicated branches, specs and generated migrations"`

### Task 7: Detect the migration tool

**Files:** Modify `cli/detect.mjs`; Test `cli/stones.test.mjs`

**Interfaces:**
- Produces: `stack.migrations: { tool: string, dirs: string[], models: string[], generate: string } | null` from `detect(root)`.

Detection (first match wins): `prisma` dep or `prisma/schema.prisma` → Prisma; `drizzle-kit` dep → Drizzle (dirs from `drizzle.config.*` `out:` if a simple string literal, else `drizzle`); `typeorm` → TypeORM (`src/migrations`); `sequelize-cli` → Sequelize (`migrations`); `knex` → Knex (`migrations`); `alembic.ini` → Alembic (`alembic/versions`, or `script_location` + `/versions`); `manage.py` + `django` → Django (`**/migrations`, models `**/models.py`, `**/models/**`); `Gemfile` with rails → Rails (`db/migrate`, models `app/models/**`). Generate commands exactly as the spec's table; use the detected package manager's exec (`pnpm exec`, `yarn`, `bunx`, `npx`) for Node tools.

- [ ] **Step 1: Write failing tests** — a temp project with `package.json` `{"devDependencies":{"prisma":"5"}}` + `pnpm-lock.yaml` → `{ tool: 'Prisma', dirs: ['prisma/migrations'], generate: 'pnpm exec prisma migrate dev --name <name>' }`; a project with `manage.py` and `django` in `requirements.txt` → tool `Django`, generate `python manage.py makemigrations`; an empty project → `null`.
- [ ] **Step 2: Run** `node --test cli/` — FAIL. **Step 3: Implement** `migrationStack(root, stack)` called from `detect`. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(detect): detect migration tool, dirs and generator"`

### Task 8: Install the hook

**Files:** Modify `settings/hooks.json`, `cli/catalog.mjs`, `cli/install.mjs`, `cli/agent-doc.mjs`, `README.md`; Create `settings/atomicity.json` (seed template); Test `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `stack.migrations` (Task 7), `stack.defaultBranch`.

- [ ] **Step 1: Write failing tests**
  - `hookCatalog()` contains id `atomicity` with events `['PreToolUse:Bash|Edit|MultiEdit|Write']`.
  - install plan with `atomicity` selected and a Prisma stack includes `.claude/hooks/atomicity.mjs` (managed), `.claude/atomicity.json` (seed) whose `migrations.generate` is the Prisma command and `defaultBranch` the detected one, and `.claude/danger/.gitkeep`.
  - generated `AGENT.md` contains `Danger zones` and `.claude/docs/atomicity/README.md` when the hook and the doc are installed.
- [ ] **Step 2: Run** `node --test cli/` — FAIL.
- [ ] **Step 3: Implement**
  - `settings/hooks.json`: new PreToolUse group `Bash|Edit|MultiEdit|Write` → `node "$CLAUDE_PROJECT_DIR/.claude/hooks/atomicity.mjs"`, placed after the `testing` group.
  - `cli/catalog.mjs` `HOOK_HINTS.atomicity`: `'blocks mixed commits/branches and requires dedicated, specced branches for db, packages and network changes'`.
  - `cli/install.mjs`: when selected, push the seed (template from `settings/atomicity.json` merged with detected values) and `.claude/danger/.gitkeep` (`kind: 'seed'`).
  - `cli/agent-doc.mjs` Workflow line when `has('atomicity')`: "Danger zones (db, packages, network) go on their own `db/`, `deps/`, `net/` branch and PR with a spec in `.claude/danger/`; never mix them with other changes; generate migrations with `<generate>`" plus the doc link.
  - `README.md`: add the hook to the hooks list and note `.claude/atomicity.json` in the re-run table as "Created once, then owned by you".
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(install): ship and configure the atomicity hook"`

### Task 9: Framework docs

**Files:** Create `docs/atomicity/README.md`, `docs/atomicity/BRANCHES.md`, `docs/atomicity/PR.md`, `docs/atomicity/SPEC_TEMPLATE.md`; Modify `frameworks/BRANCHES.md`, `frameworks/PR.md`; Test `cli/stones.test.mjs`

Content (from the spec, written for the agent):
- `README.md` — title `# Atomicity and Danger Zones`, first sentence is the one-line summary `docCatalog` shows; principles; the three zones and what counts (incl. "your own API is not network unless `incoming` is on"); table of R1–R4 with what the block message tells you to do; config keys; `exempt` is human-only.
- `BRANCHES.md` — one purpose per branch; prefixes; how to split a mixed working tree (`git restore --staged`, `git switch -c deps/…`); stacking (`feat/` on top of unmerged `deps/`).
- `PR.md` — one story per PR; danger PR order (deps → db → net → feature); PR description template with Summary / Zone / Spec link / Risk / Rollback / Verification.
- `SPEC_TEMPLATE.md` — the six sections with bracketed `[describe …]` prompts (which `inspectSpec` treats as placeholders, so an unfilled copy fails).
- `frameworks/BRANCHES.md`, `frameworks/PR.md` — one line each pointing to the docs file.

- [ ] **Step 1: Write failing test** — `docCatalog()` has topic `atomicity` with `main: 'atomicity/README.md'` and 4 files; `inspectSpec(readFileSync('docs/atomicity/SPEC_TEMPLATE.md'), 'db')` is invalid.
- [ ] **Step 2: Run** — FAIL. **Step 3: Write the docs.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "docs(atomicity): branch, PR and danger-zone spec guides"`

### Finish

- [ ] `npm test` green; `git status` shows `hooks/testing.mjs` still modified and unstaged.
- [ ] Use superpowers:finishing-a-development-branch.
