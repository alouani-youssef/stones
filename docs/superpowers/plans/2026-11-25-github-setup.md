# GitHub Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ai-stones init` offers a Claude session (`/github-setup`) that generates git hooks, the user-selected GitHub workflows (0..n), issue templates and a PR template for the project, guided by two core skills that carry reference templates.

**Architecture:** The CLI only asks which workflows to generate, installs the skills, the command and a `ci-local.sh` wrapper, then starts `claude` with the command's prompt (same pattern as `cli/roadmap.mjs`). Claude does the generation. This repository's own CI (`github/`, `.actrc`, `ci:local` scripts) is removed.

**Tech Stack:** Node ≥ 22.13 ESM, `node:test`, bash, GitHub Actions YAML, lefthook YAML.

**Spec:** `docs/superpowers/specs/2026-11-25-github-setup-design.md`

## Global Constraints

- Node ≥ 22.13, no new npm dependencies.
- Workflow catalog ids, exactly: `ci`, `release`, `security`, `dependabot`. Default selection: `[]`.
- Answers key: `answers.github.workflows` (array of catalog ids); prompter id `github.workflows`.
- Both `git-hooks` and `github-actions` skills carry `metadata.core: true`.
- Hooks: pre-commit = format + lint on staged files only; pre-push = typecheck + tests.
- Never overwrite an existing hook, workflow or template without asking (command prompt rule).
- Actions in templates pinned by full commit SHA with the version in a comment.
- `ci-local.sh` is ask-first: it is not added to `permissions.allow`.
- Commit messages: Conventional Commits, no Claude attribution or co-author trailers.

## Review Focus

- **Non-git target directory**: `init` in a folder that is not a git repo — the GitHub setup offer must still work, and the command prompt must tell Claude to skip hook activation and say why. Test in Task 4 (prompt text).
- **Re-run of `init` with a previous selection**: the saved `github.workflows` must be the default on the next run, not `[]`. Test in Task 5.
- **Unknown id in a saved selection** (catalog changed): ignored, not passed to the prompt. Test in Task 5.
- **`--yes` / non-interactive init**: no session is started; the "Next:" hint names `npx ai-stones github-setup`. Test in Task 6.
- **`ci-local.sh` without act or Docker**: exits non-zero with an install hint, never calls node. Test in Task 7.

---

### Task 1: Remove this repository's CI

**Files:**
- Delete: `github/` (all of it, including untracked `github/templates/`), `.actrc`
- Modify: `package.json` (remove `ci:local`, `ci:local:list` scripts)
- Modify: `README.md` (remove CI badge line 3 and section "Run the CI workflow locally"; reword "The CI workflow checks…" paragraph to say checks run locally with `npm run check`, `npm test`, `npm run smoke`)
- Modify: `scripts/check-repo.mjs` (header comment says "run by CI" → "run before a commit or release"; add `shell` check)

**Interfaces:**
- Produces: `npm run check` runs `shellcheck` over tracked `*.sh` files plus `setup.bash` when `shellcheck` is on PATH; skipped with a note otherwise.

- [ ] **Step 1:** `git rm -r github .actrc && rm -rf github`
- [ ] **Step 2:** Edit `package.json`, `README.md` as listed. `grep -rn "ci:local\|\.actrc\|actions/workflows/ci.yml" README.md package.json` → no output.
- [ ] **Step 3:** Add `checkShell()` to `scripts/check-repo.mjs`: if `spawnSync('shellcheck', ['--version']).status !== 0`, print `check-repo: shellcheck not installed, shell check skipped`; else run `shellcheck` on `tracked.filter(f => f.endsWith('.sh')).concat('setup.bash')`, `fail('shell', stdout)` on non-zero. Add `shell` to the OK summary line.
- [ ] **Step 4:** Run `npm run check && npm test`. Expected: both pass.
- [ ] **Step 5:** Commit `chore: remove repository CI, check shell scripts locally`.

### Task 2: `git-hooks` core skill with templates

**Files:**
- Create: `skills/git-hooks/SKILL.md`
- Create: `skills/git-hooks/templates/githooks/pre-commit`, `commit-msg`, `pre-push` (bash, executable)
- Create: `skills/git-hooks/templates/lefthook/node.yml`, `python.yml`, `go.yml`
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Produces: skill id `git-hooks`, core. Installed to `.claude/skills/git-hooks/**` by the existing `skillFiles`.

- [ ] **Step 1: Failing test** in the skills `describe` of `cli/stones.test.mjs`:

```js
it('ships git-hooks as a core skill with templates', () => {
  const skill = skillCatalog().find((s) => s.id === 'git-hooks');
  assert.ok(skill?.core);
  for (const f of ['templates/githooks/pre-commit', 'templates/githooks/pre-push', 'templates/githooks/commit-msg', 'templates/lefthook/node.yml', 'templates/lefthook/python.yml', 'templates/lefthook/go.yml']) {
    assert.ok(skill.files.includes(`git-hooks/${f}`), f);
  }
});
```

- [ ] **Step 2:** `node --test cli/stones.test.mjs` → FAIL (skill missing).
- [ ] **Step 3: Write the skill.** Frontmatter: `name: git-hooks`, `description` starting "Use when adding, changing or debugging git hooks…", `metadata: { title: Git Hooks, summary: …, core: true }`. Body sections: what each hook runs and its time budget (pre-commit < ~10 s, staged files only; pre-push may run the test suite); choosing the mechanism (lefthook if `lefthook.yml` exists or `lefthook` is on PATH → `lefthook install`; otherwise copy `templates/githooks/*` to `.githooks/`, `chmod +x`, `git config core.hooksPath .githooks`); never replace an existing `.git/hooks/*`, `.githooks/*` or `lefthook.yml` without asking; commit-msg enforces Conventional Commits only if `conventions.commits` is `conventional` in `.claude/stones.json`; verifying (`git hook run pre-commit` on git ≥ 2.36, or `lefthook run pre-commit`); `--no-verify` is for emergencies, and hooks never replace CI or the workflows gate. Templates: shell scripts start with `set -euo pipefail` and a block of variables (`FORMAT_CMD`, `LINT_CMD`, `TYPECHECK_CMD`, `TEST_CMD`) Claude fills from the project's commands; an empty variable skips that step. pre-commit passes staged files (`git diff --cached --name-only --diff-filter=ACMR`) and re-stages formatted files. lefthook files use `{staged_files}` and `stage_fixed: true`, with the stack's usual commands (node: `npm run …`; python: `ruff format`, `ruff check`, `mypy`, `pytest`; go: `gofmt -l -w`, `go vet ./...`, `go test ./...`).
- [ ] **Step 4:** `chmod +x skills/git-hooks/templates/githooks/*`; `node --test cli/stones.test.mjs` → PASS; `npm run check` → PASS (shellcheck covers the templates only if they end in `.sh`, so also run `shellcheck skills/git-hooks/templates/githooks/*` by hand when available).
- [ ] **Step 5:** Commit `feat(skills): add git-hooks core skill with hook templates`.

### Task 3: `github-actions` becomes core, gains templates

**Files:**
- Modify: `skills/github-actions/SKILL.md` (frontmatter `core: true`; new section "Templates")
- Create under `skills/github-actions/templates/`: `workflows/ci-node.yml`, `ci-python.yml`, `ci-go.yml`, `release-node.yml`, `release-python.yml`, `release-go.yml`, `security.yml`, `dependabot.yml`, `ISSUE_TEMPLATE/bug_report.yml`, `ISSUE_TEMPLATE/feature_request.yml`, `ISSUE_TEMPLATE/config.yml`, `pull_request_template.md`
- Modify: `cli/stones.test.mjs:266-275` (test "matches skills against detected tools")

**Interfaces:**
- Produces: template paths above, referenced by name from `commands/github-setup.md` (Task 4). Catalog id → template: `ci` → `workflows/ci-<stack>.yml`, `release` → `workflows/release-<stack>.yml`, `security` → `workflows/security.yml`, `dependabot` → `dependabot.yml`.

- [ ] **Step 1: Update the test:** `github-actions` is now included both with and without `GitHub Actions` detected (`assert.ok(without.includes('github-actions'))`), and add an assertion that `skillCatalog().find((s) => s.id === 'github-actions').files` contains `github-actions/templates/workflows/security.yml` and `github-actions/templates/pull_request_template.md`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Write templates and the section.** Every workflow: top-level `permissions: contents: read`, `concurrency` cancelling superseded PR runs, `timeout-minutes` on every job, `persist-credentials: false` on checkout, actions pinned by SHA (resolve with `gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object.sha`; keep the SHAs already in the skill for checkout/setup-node/upload-artifact). `ci-*`: format check → lint → typecheck → test → build, with a comment that Claude replaces commands with the project's. `release-*`: on tag push `v*`, `workflow_call` of CI first, publish with environment `release` and OIDC/trusted publishing where the registry supports it. `security.yml`: actionlint, zizmor, `actions/dependency-review-action` on `pull_request`. Issue forms use GitHub issue-form YAML; `config.yml` sets `blank_issues_enabled: false`. PR template: Summary, Why, How tested, Checklist (tests, docs, no secrets). SKILL.md "Templates" section: the table from Interfaces, "adapt, don't copy", and "a workflow is not done until `node .claude/tools/workflows.mjs run --workflow <file>` passes locally (act cannot run macOS jobs)".
- [ ] **Step 4:** `node --test cli/stones.test.mjs` → PASS. Lint templates: `docker run --rm -v "$PWD:/repo" -w /repo/skills/github-actions/templates rhysd/actionlint:1.7.7 workflows/*.yml` → no findings (or `actionlint` if installed).
- [ ] **Step 5:** Commit `feat(skills): make github-actions core and add workflow, issue and PR templates`.

### Task 4: `/github-setup` command and session starter

**Files:**
- Create: `commands/github-setup.md`
- Create: `cli/github-setup.mjs`
- Test: `cli/stones.test.mjs` (new `describe('github-setup')`, and the fresh-install test)

**Interfaces:**
- Consumes: `PACKAGE_ROOT` (`cli/catalog.mjs`), `onPath` (`cli/detect.mjs`).
- Produces:
  - `export const WORKFLOW_CATALOG: { value: 'ci'|'release'|'security'|'dependabot', label: string, hint: string }[]`
  - `export function githubSetupPrompt(target: string, workflows: string[] = []): string`
  - `export function startGithubSetupSession(target: string, { workflows = [], claude = 'claude' } = {}): Promise<{ started: boolean, code?: number, message?: string }>`

- [ ] **Step 1: Failing tests:**

```js
describe('github-setup', () => {
  it('puts the selected workflows in the prompt', () => {
    const prompt = githubSetupPrompt(project(), ['ci', 'security']);
    assert.match(prompt, /Workflows to generate: ci, security/);
    assert.doesNotMatch(prompt, /\$ARGUMENTS/);
  });
  it('says none were selected', () => {
    assert.match(githubSetupPrompt(project(), []), /Workflows to generate: none selected/);
  });
  it('drops ids outside the catalog', () => {
    assert.match(githubSetupPrompt(project(), ['ci', 'deploy']), /Workflows to generate: ci\n/);
  });
  it('covers hooks, templates and non-git folders', () => {
    const prompt = githubSetupPrompt(project());
    for (const word of ['git-hooks', 'github-actions', 'pull_request_template.md', 'ISSUE_TEMPLATE', 'not a git repository']) assert.ok(prompt.includes(word), word);
  });
  it('reports when Claude is not on PATH', async () => {
    const result = await startGithubSetupSession(project(), { claude: 'no-such-claude-binary' });
    assert.equal(result.started, false);
    assert.match(result.message, /npx ai-stones github-setup/);
  });
});
```

and in "generates .claude, AGENT.md and CLAUDE.md for a fresh project": `assert.ok(read(root, '.claude/commands/github-setup.md').includes('github-actions'))`.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Write `commands/github-setup.md`.** Frontmatter `description: Generate git hooks, GitHub workflows, issue and PR templates for this project`, `argument-hint: "[workflows, e.g. 'ci security']"`. Body contains the line `Workflows to generate: $ARGUMENTS` and the six steps from the spec's Command section, naming the `git-hooks` and `github-actions` skills, `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`; rule: if `$ARGUMENTS` is "none selected", skip workflows; if empty (typed by hand), ask which of `ci, release, security, dependabot` to generate; if the folder is not a git repository, write the hook files but skip activation and say so.
- [ ] **Step 4: Implement `cli/github-setup.mjs`** mirroring `cli/roadmap.mjs`: prefer `.claude/commands/github-setup.md`, strip frontmatter, replace `$ARGUMENTS` with the catalog-filtered ids joined by `, ` or `none selected`. Missing-Claude message: ``Claude Code is not on PATH. Install it (https://claude.com/claude-code), then run `npx ai-stones github-setup`, or open Claude Code here and type /github-setup.``
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(cli): add /github-setup command and session starter`.

### Task 5: Workflow selection in the interview

**Files:**
- Modify: `cli/questions.mjs` (after the plugins/MCP questions, before sandbox; returned object gains `github: { workflows }`)
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `WORKFLOW_CATALOG` (Task 4).
- Produces: `answers.github.workflows: string[]`, stored in `.claude/stones.json` with the other answers.

- [ ] **Step 1: Failing tests:**

```js
it('asks which workflows to generate, none by default', async () => {
  const { answers } = await runInit(nextApp());
  assert.deepEqual(answers.github.workflows, []);
});
it('keeps the previous workflow selection and drops unknown ids', async () => {
  const root = nextApp();
  await runInit(root, { 'github.workflows': ['ci', 'release'] });
  const again = await runInit(root);
  assert.deepEqual(again.answers.github.workflows, ['ci', 'release']);
  const stale = await interview(createScriptedPrompter({}), detect(root), { github: { workflows: ['ci', 'deploy'] } });
  assert.deepEqual(stale.github.workflows, ['ci']);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `ask.multi('github.workflows', 'GitHub workflows to generate (Claude writes them in the GitHub setup session; none is fine)', WORKFLOW_CATALOG, p('github.workflows', []).filter(id => WORKFLOW_CATALOG.some(w => w.value === id)))` under a `ask.note('\n— Git hooks and GitHub')` heading.
- [ ] **Step 4:** Run `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(cli): ask which GitHub workflows to generate`.

### Task 6: `init` step and `github-setup` subcommand

**Files:**
- Modify: `bin/stones.mjs`
- Test: `cli/stones.test.mjs` (spawn `bin/stones.mjs` like existing CLI tests) and `scripts/smoke.mjs`

**Interfaces:**
- Consumes: `githubSetupPrompt`, `startGithubSetupSession` (Task 4); `answers.github.workflows` (Task 5).
- Produces: `npx ai-stones github-setup [dir] [--print-prompt]`; init flag `--no-github-setup`.

- [ ] **Step 1: Failing tests:** `node bin/stones.mjs github-setup <dir> --print-prompt` prints text containing `Workflows to generate:` and, after an init that saved `['ci']`, `Workflows to generate: ci`; `node bin/stones.mjs init <dir> --yes` stdout contains ``npx ai-stones github-setup``; `--help` lists `github-setup` and `--no-github-setup`. In `scripts/smoke.mjs`, add `.claude/commands/github-setup.md`, `.claude/skills/git-hooks/SKILL.md` and `.claude/skills/github-actions/SKILL.md` to the expected paths list (line 95).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `parseArgs`: `githubSetup: true`, `--no-github-setup` sets it false. `maybeStartGithubSetup(target, args, ask, stack, answers, out)` mirrors `maybeStartRoadmap` (prompter id `github-setup.start`, question `Start a Claude session now to set up git hooks and GitHub files?`, default true; hint line ``Next: run `npx ai-stones github-setup` (or /github-setup in Claude Code) to generate git hooks and GitHub files.``). Called in `init` before `maybeStartRoadmap`. Move `ask.close()` out of `maybeStartRoadmap` so both offers can ask; the `finally` already closes. `handleGithubSetup(target, args)` reads `loadManifest(target).answers?.github?.workflows ?? []`, honours `--print-prompt`, else starts the session; register in `COMMANDS` and `HELP`.
- [ ] **Step 4:** Run `npm test && npm run smoke` → PASS.
- [ ] **Step 5:** Commit `feat(cli): offer the GitHub setup session during init`.

### Task 7: `ci-local.sh` in the installed harness

**Files:**
- Create: `scripts/ci-local.sh` (executable)
- Modify: `cli/install.mjs` (install it to `.claude/scripts/ci-local.sh`, kind `managed`, mode executable like `block-rm.sh`)
- Modify: `package.json` `files` (add `"scripts/ci-local.sh"`)
- Modify: `README.md` section "Run GitHub Actions workflows before a merge or publish" (add `.claude/scripts/ci-local.sh` usage) and the install tree (add `scripts/`)
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: `.claude/tools/workflows.mjs` subcommands `list | run | status`.
- Produces: `.claude/scripts/ci-local.sh [list|run|status] [options]`; no subcommand → `run`.

- [ ] **Step 1: Failing tests:** after `runInit`, `.claude/scripts/ci-local.sh` exists and is executable and is absent from `settings.permissions.allow`; running it with `PATH` set to a temp dir containing only `node` and `git` symlinks exits non-zero with stderr matching `/act/` and `/brew install act/`; with a stub `act` and `docker` that succeed (`docker info` exit 0) and a stub `node` script that echoes its args, `ci-local.sh status` prints `.claude/tools/workflows.mjs status`, and `ci-local.sh` alone prints `.claude/tools/workflows.mjs run`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `set -euo pipefail`; `cd "$(git rev-parse --show-toplevel)"`; `command -v act` else `echo "ci-local: act is not installed (brew install act, or gh extension install nektos/gh-act)" >&2; exit 1`; `docker info >/dev/null 2>&1` else `echo "ci-local: Docker is not running" >&2; exit 1`; first arg in `list|run|status` is the subcommand, otherwise `run`; `exec node .claude/tools/workflows.mjs "$sub" "$@"`. Skip the act/docker checks for `status` (it only reads the record).
- [ ] **Step 4:** Run `npm test && npm run check && npm run smoke` → PASS.
- [ ] **Step 5:** Commit `feat(harness): install ci-local.sh to run workflows locally`.
