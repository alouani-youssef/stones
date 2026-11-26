# Evaluating Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `evaluating-outputs` stone. A versioned dimension registry and a per-category KPI mapping are injected into a task's plan. The output is then scored against them, from agent measurements (with full results) and human sign-offs, and `tasks.mjs done` is gated on a PASS scorecard.

**Architecture:** The data lives in `skills/evaluating-outputs/` (`dimensions.json`, `categories.json` and their `.md` explanations). Two dependency-free tools read it:
- `tools/evaluation-registry.mjs` loads, merges and validates the registry and project overrides, and resolves a category into concrete KPIs.
- `tools/evaluation.mjs` writes the plan's `## Evaluation` section, checks it, stores records and sign-offs, scores, writes the scorecard, and exposes the CLI.

`tasks.mjs` and `review.mjs` call `evaluation.mjs` for the readiness, `done` and review gates. No code names a specific dimension.

**Tech Stack:** Node.js ≥ 22.13 ESM (`.mjs`), `node:test` and `node:assert/strict`, no dependencies.

**Spec:** `docs/design/2026-11-25-evaluating-outputs-design.md`

## Global Constraints

- Node.js 22.13+, no new dependencies; only `node:` built-ins.
- Tools are flat `.mjs` files in `tools/`. Each CLI exports `run(argv, { root, log, error }) -> exitCode` like `tools/spec-quiz.mjs` and is run as `node .claude/tools/<file>`.
- Hashes are `createHash('sha256').update(text).digest('hex').slice(0, 16)` (same as `cli/install.mjs` and `spec-quiz.mjs`).
- Dimension ids are kebab-case, never renamed or reused. Removing one means `"status": "deprecated"`; entries are never deleted (A14).
- A task has exactly one category; `plan` with two `--category` flags exits 1 with "a task is atomic: split it into one task per category" (A2).
- The verdict is pass/fail per KPI, with no aggregate score (A3). Every measurable KPI is recorded with `--evidence` and a `--details` JSON file.
- Thresholds are resolved at plan time and written into the plan. `check` and `score` read the plan, never the current registry, so a later registry version does not block an approved plan (A12).
- Tasks with no `Category:` line, or with `Category: none`, are unaffected by every new gate (A8).
- `sign` is never added to `permissions.allow`.
- Commit messages: conventional (`feat:`, `test:`, `docs:`), with no Co-authored-by trailer and no mention of Claude.

## Review Focus

1. A non-numeric value given to `record` (`"3.8ms"`, `""`, `"NaN"`) is rejected with "value must be a number in <unit>", and nothing is stored. Test in Task 3.
2. An unknown KPI id given to `record` or `sign` exits 1 and lists the plan's KPI ids. Test in Task 3.
3. A hand-edited generated section (a row deleted or a threshold changed between the markers) makes `check` fail with "the generated Evaluation section was edited by hand; rerun `evaluation.mjs plan`". Test in Task 2.
4. A `--details` path that is missing or is not valid JSON exits 1 naming the file, and nothing is stored. Test in Task 3.
5. A task note with `Category: <unknown>` fails `start` with a message listing the available categories, and the board is unchanged. Test in Task 7.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tools/evaluation-registry.mjs` | load `dimensions.json`, `categories.json` and `<root>/.claude/evaluation.json`; validate them; resolve a category into KPIs |
| `tools/evaluation-registry.test.mjs` | registry tests on fixture registries in temp dirs |
| `tools/evaluation.mjs` | plan section write and parse, `check`, `suggest`, target resolution, record, sign, score, scorecard, CLI |
| `tools/evaluation.test.mjs` | tool tests on temp projects with a fixture registry |
| `skills/evaluating-outputs/SKILL.md` | when and how to evaluate: the workflow, the rules for evidence and sign-off |
| `skills/evaluating-outputs/dimensions.json` / `dimensions.md` | the registry v1 and each dimension's definition, evidence and measurement guidance |
| `skills/evaluating-outputs/categories.json` / `categories/*.md` | 9 categories with KPIs, and per-category rationale and measurement commands per stack |
| `scripts/check-repo.mjs` | add the `evaluation` check |
| `tools/tasks.mjs`, `tools/review.mjs`, `tools/tasks.test.mjs` | Category meta, readiness, `done` and review gates |
| `cli/install.mjs`, `cli/stones.test.mjs` | ship the tools and permissions |
| `skills/tracking-tasks/SKILL.md`, `README.md` | document the flow |

## Shared types (referenced by every task)

```js
// Dimension (dimensions.json → dimensions[])
{ id, title, definition, question, evidence: 'measured'|'signed'|'any', units?: string[], details?: string[],
  verifier: 'agent'|'human'|'both', order: number, since: number, status: 'active'|'deprecated' }
// Category KPI (categories.json → categories[c].dimensions[d].kpis[])
{ id: '<category>.<slug>', metric, threshold: { op: '<='|'>='|'=='|'signed', value?: number, unit?: string },
  method, verifier?, evidence?, case: 'Case: ... Expected: ...' }   // evidence only when the dimension's evidence is 'any'
// Resolved KPI (what the plan carries)
{ id, dimension, metric, op, value, unit, verifier, evidence: 'measured'|'signed', method, case }
// Store (<store>.json)
{ plan: '<path>', entries: { '<kpi-id>': { record?: { value, unit, evidence, details, planHash, at },
                                            sign?: { verdict: 'pass'|'fail', note, planHash, at } } } }
```

A dimension with `"evidence": "any"` (only `task-kpis` in v1) lets each KPI set its own `evidence` and any unit. This extends the spec's `measured`/`signed` pair to express "per KPI" for task-specific KPIs; it is a plan-time call.

---

### Task 1: Registry loader and validator

**Files:**
- Create: `tools/evaluation-registry.mjs`
- Test: `tools/evaluation-registry.test.mjs`

**Interfaces:**
- Produces:
  - `export class EvaluationError extends Error`
  - `export const REGISTRY_DIR` = `join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'evaluating-outputs')`. This resolves to `skills/evaluating-outputs` in the repo and to `.claude/skills/evaluating-outputs` when installed in `.claude/tools/`.
  - `export function loadRegistry({ dir = REGISTRY_DIR, root } = {}) -> Registry`. `Registry = { version, dimensions: Dimension[], categories: Record<string, Category>, project: object|null }`. It reads `dimensions.json` and `categories.json` from `dir`, and `<root>/.claude/evaluation.json` when `root` is given and the file exists. Project `dimensions` are appended and project `categories` are merged in. It throws `EvaluationError('install the evaluating-outputs skill (npx ai-stones init)')` when `dir` has no `dimensions.json`, and `EvaluationError('<file>: <JSON error>')` on bad JSON.
  - `export function registryProblems(registry) -> string[]`, empty when valid.
  - `export function activeDimensions(registry) -> Dimension[]`, active only, sorted by `order`.
  - `export function resolveCategory(registry, categoryId, { overrides = [], na = [] } = {}) -> Resolved`. `Resolved = { category, title, version, kpis: ResolvedKpi[], na: {dimension, reason}[], applied: {id, source: 'project'|'task', from, to, reason}[] }`, with `kpis` ordered by dimension `order`. `overrides` are `{ id, op, value, unit, reason }`; `na` are `{ id, reason }`. Project `thresholds` and `na` are applied first, then the task's. It throws `EvaluationError("unknown category '<id>'; available: <sorted ids>")`.

- [ ] **Step 1: Write the failing tests** in `tools/evaluation-registry.test.mjs`. Use a `fixture(dir, { dimensions, categories, project })` helper that writes a two-dimension registry (`correctness` measured `units: ['diffs']`, `details: ['tool', 'run_at']`; `review` signed, `verifier: 'human'`) and one category `cache` into a temp dir.
  - `it('loads a valid registry with no problems')`: `assert.deepEqual(registryProblems(loadRegistry({ dir })), [])`.
  - `it('names each category that does not cover an active dimension')`: remove `review` from `cache`; expect a problem matching `/cache: dimension 'review' needs kpis or na/`.
  - `it('rejects a dimension key that is not in the registry')`: add key `speed`; expect `/cache: unknown dimension 'speed'/`.
  - `it('rejects a threshold op or unit that does not fit the dimension')`: `signed` op on `correctness` gives `/cache.x: op 'signed' not allowed for measured dimension 'correctness'/`; unit `ms` gives `/cache.x: unit 'ms' not in correctness units \(diffs\)/`.
  - `it('rejects duplicate dimension ids, duplicate orders, duplicate kpi ids and since > version')`: one assertion per message.
  - `it('rejects a project dimension that reuses a registry id')`: project `dimensions: [{ id: 'correctness', ... }]` gives `/project dimension 'correctness' clashes with the registry/`.
  - `it('accepts a new dimension without code changes')`: add `security` (`order: 15`, `since: 2`, version 2) and cover it in `cache`; expect `[]` from `registryProblems`, and `activeDimensions(...).map(d => d.id)` equal to `['correctness', 'security', 'review']`.
  - `it('drops deprecated dimensions from resolution but keeps them loadable')`: mark `review` deprecated; `resolveCategory(r, 'cache').kpis` has no `review` KPI; `registryProblems` is `[]` even with `cache` not covering it.
  - `it('applies project then task overrides and records each one')`: project `thresholds: { 'cache.diffs': { op: '==', value: 1, unit: 'diffs' } }`, then a task override to `0`; expect the resolved value `0` and `applied` to have two entries with sources `project` and `task`.
  - `it('fills {{...}} placeholders in cases from the kpi and category defaults')`: the case `Expected: <= {{value}}{{unit}} under {{load}}` with `defaults: { load: '50 rps' }` resolves to `Expected: <= 0diffs under 50 rps`, and an unknown placeholder is a `registryProblems` entry.
  - `it('throws a clear error when the skill is not installed or a file is not JSON')`: `assert.throws(() => loadRegistry({ dir: empty }), /install the evaluating-outputs skill/)`.

- [ ] **Step 2: Run and confirm the tests fail**
  Run: `node --test tools/evaluation-registry.test.mjs`
  Expected: FAIL with `Cannot find module` for `evaluation-registry.mjs`.

- [ ] **Step 3: Implement `tools/evaluation-registry.mjs`** to the interfaces above. These are the validation rules, and each gives one message as in the tests:
  - **Dimension fields:** required fields present; `evidence ∈ measured|signed|any`; `verifier ∈ agent|human|both`; `status ∈ active|deprecated`; `order` is an integer and unique; `since` is ≤ `version`; `measured` requires a non-empty `units` and a `details` array.
  - **Category coverage:** every category key is a known dimension, and every active dimension is a key with a non-empty `kpis` or a non-empty `na` string.
  - **KPIs:** each id is unique across all categories and starts with `<category>.`; `method` is non-empty; `case` matches `/^Case: .{8,} Expected: .{8,}$/` after filling.
  - **Thresholds:** `<=`, `>=` and `==` need a numeric `value` and a unit within the dimension's `units` (any unit when `units` is absent); `signed` only on a `signed` dimension, or on an `any` dimension with KPI `evidence: 'signed'`.

- [ ] **Step 4: Run and confirm the tests pass**
  Run: `node --test tools/evaluation-registry.test.mjs`
  Expected: PASS, all tests.

- [ ] **Step 5: Commit**
  `git add tools/evaluation-registry.mjs tools/evaluation-registry.test.mjs && git commit -m "feat: add evaluation registry loader and validator"`

---

### Task 2: Plan section, `check` and `suggest`

**Files:**
- Create: `tools/evaluation.mjs`
- Test: `tools/evaluation.test.mjs`

**Interfaces:**
- Consumes: `loadRegistry`, `resolveCategory`, `EvaluationError` (Task 1).
- Produces:
  - `export const EVALUATIONS_DIR = 'docs/tasks/evaluations'`
  - `export function parseEvaluation(planText) -> Parsed | null`, null when there is no `## Evaluation`. `Parsed = { category, version, hash, kpis: ResolvedKpi[], na: {dimension, reason}[], overrides: {id, op, value, unit, reason}[], naLines: {id, reason}[], cases: Map<kpiId, string>, edited: boolean }`.
  - `export function writePlanEvaluation(root, planPath, categoryIds, { registry } = {}) -> Parsed`. `categoryIds` is an array, and its length must be 1.
  - `export function checkPlan(root, planPath, { category, registry } = {}) -> { problems: string[], notes: string[] }`
  - `export function suggestCategory(text, registry) -> { category, hits }[]`, sorted by hits; it returns `[{ category: 'general', hits: 0 }]` when nothing matches.
  - `export function run(argv, { root = process.cwd(), log = console.log, error = console.error } = {}) -> number`, with subcommands `plan <plan.md> --category <id>`, `check <plan.md> [--category <id>]` and `suggest <spec.md>`.

The generated section's exact shape. Lines above the begin marker are the user's `Override:`/`NA:` lines, kept on every regeneration. Everything between the markers is replaced.

```markdown
## Evaluation

Override: caching.hit-ratio >= 0.95 ratio — checkout traffic is read-heavy
NA: caching.stampede-lock — single-instance internal tool

<!-- evaluation:begin — generated by `node .claude/tools/evaluation.mjs plan`; edit Override:/NA: lines above, then rerun -->
Category: caching
Dimensions: v1 (sha 0123456789abcdef)

| Dimension | KPI | Metric | Threshold | Verifier | Evidence |
| --- | --- | --- | --- | --- | --- |
| latency | caching.hit-latency-p95 | p95 latency of a cache hit | <= 5 ms | agent | measured |
| results | caching.results-end-to-end | failing scenarios end to end | == 0 scenarios | both | measured |

- memory: n/a — cache is an external Redis; app memory unchanged
- task-kpis / caching.stampede-lock: n/a (task) — single-instance internal tool

Applied: caching.hit-ratio >= 0.9 → >= 0.95 (task: checkout traffic is read-heavy)
<!-- evaluation:end -->
```

`sha` is the hash of the generated table rows. `parseEvaluation` recomputes it and sets `edited: true` on a mismatch. `writePlanEvaluation` removes every `## Test Cases` line containing `[eval:` and appends one `- <case> [eval:<kpi-id>]` per KPI. When the section is missing, it creates `## Test Cases` at the end of the plan. When `## Evaluation` is missing, it inserts the section before `## Test Strategy`, or at the end.

- [ ] **Step 1: Write the failing tests** in `tools/evaluation.test.mjs`, using a temp project, a fixture registry dir (as in Task 1, with a 3-KPI `cache` category), and a plan with `## Test Strategy` and `## Test Cases` containing one hand-written case.
  - `it('writes the Evaluation section and one tagged case per KPI')`: after `writePlanEvaluation(root, PLAN, ['cache'], { registry })`, the plan has `## Evaluation`, `Category: cache`, one table row per KPI, every `n/a` dimension with its reason, three `[eval:` lines, and the hand-written case unchanged.
  - `it('is byte-identical when run twice')`: read, write again, and compare.
  - `it('keeps Override: and NA: lines and applies them')`: with `Override: cache.diffs == 1 diffs — legacy rows`, the table row shows `== 1 diffs` and the `Applied:` line names the override. An `NA:` line removes that KPI's row and tagged case and lists it as `n/a (task)`.
  - `it('refuses more than one category')`: `run(['plan', PLAN, '--category', 'cache', '--category', 'api'])` returns 1, and the output matches `/a task is atomic: split it into one task per category/`.
  - `it('check passes on a generated plan and names each problem otherwise')`. It expects:
    - `[]` problems for a generated plan;
    - `/no ## Evaluation section; run .* plan/` when the section is missing;
    - `/Category: cache in the plan, but the task says api/` with `{ category: 'api' }`;
    - `/cache.diffs has no \[eval:cache.diffs\] case under ## Test Cases/` after deleting one tagged case;
    - `/NA: cache.nope is not a KPI of cache/`;
    - `/Override: cache.diffs needs a reason after —/`.
  - `it('check fails when the generated section was edited by hand')` (Review Focus 3): change `== 0` to `== 5` in a row and expect `/edited by hand; rerun `evaluation.mjs plan`/`.
  - `it('check holds a plan to its recorded registry version')`: generate at v1, then add a v2 dimension to the fixture. `checkPlan` returns `problems: []`, and `notes` matches `/registry v2 is newer than the plan's v1; rerun plan and re-approve to include it/`.
  - `it('suggests the category whose keywords the spec mentions most')`: a spec mentioning "redis" and "ttl" ranks `cache` first; a spec with no keywords returns `general`.

- [ ] **Step 2: Run and confirm the tests fail**
  Run: `node --test tools/evaluation.test.mjs`
  Expected: FAIL with `Cannot find module` for `evaluation.mjs`.

- [ ] **Step 3: Implement the interfaces above in `tools/evaluation.mjs`.** Parse `Override:` as `/^Override:\s+(\S+)\s+(<=|>=|==)\s+(-?\d+(?:\.\d+)?)\s*(\S+)?\s+—\s+(.+)$/` and `NA:` as `/^NA:\s+(\S+)\s+—\s+(.+)$/`; a line starting with either keyword that does not match is a `check` problem. `suggest` counts case-insensitive whole-word matches of each category's `match` keywords. `check` compares the plan's `Dimensions: v<n>` with `registry.version`, and the plan's rows with a fresh `resolveCategory` (which picks up `.claude/evaluation.json` changes). Either difference adds only a note, never a problem: `registry v2 is newer…` or `thresholds differ from the current registry or .claude/evaluation.json; rerun plan and re-approve to adopt them`. `run` prints each problem as `- <problem>`, then `READY` or `NOT READY`, and exits 0 or 1.

- [ ] **Step 4: Run and confirm the tests pass**
  Run: `node --test tools/evaluation.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add tools/evaluation.mjs tools/evaluation.test.mjs && git commit -m "feat: generate and check the plan's evaluation section"`

---

### Task 3: Record, sign, score and the scorecard

**Files:**
- Modify: `tools/evaluation.mjs`
- Test: `tools/evaluation.test.mjs`

**Interfaces:**
- Consumes: `parseEvaluation`, `checkPlan` (Task 2); `loadRegistry` (Task 1), used only to read each dimension's `details` field list.
- Produces:
  - `export function resolveTarget(root, ref) -> { plan, category, store, scorecard, taskId }`. A `ref` matching `/^\d+$/` is a task: the tool finds `docs/tasks/list/<ref padded to 4>-*.md` and reads its `Plan:` and `Category:` lines. The store is then `docs/tasks/evaluations/<id>.json` and the scorecard is `<id>.md`. Any other `ref` is a plan path: the store is `<plan minus .md>.eval.json`, the scorecard is `.eval.md`, and `category` comes from the plan's `Category:` line. The tool does not import `tasks.mjs`.
  - `export function recordKpi(root, ref, kpiId, value, { evidence, details } = {}) -> entry`. `details` is a path to a JSON file.
  - `export function signKpi(root, ref, kpiId, verdict, { note = '' } = {}) -> entry`
  - `export function scoreTarget(root, ref, { registry, write = true } = {}) -> { verdict: 'PASS'|'FAIL'|'PENDING', rows: Row[], problems: string[], scorecard: string, markdown: string }`. `Row = { dimension, id, threshold, value, by, status: 'pass'|'fail'|'waiting'|'stale'|'n/a', human?: 'pass'|'fail'|'waiting' }`. `status` is the agent side (`n/a` for a `human` KPI); `human` is the advisory sign-off, set for `human` and `both` KPIs.
  - CLI subcommands `record <ref> <kpi-id> <value> --evidence <text> [--details <file>]`, `sign <ref> <kpi-id> pass|fail [--note <text>]` and `score <ref> [--json]`. `score` exits 0 only on PASS.

The rules, each pinned by a test:
- `record` refuses:
  - a KPI whose evidence is `signed` ("<id> is signed: use `sign`");
  - an empty `--evidence`;
  - a missing `--details` on a measured KPI;
  - a details file that is missing or is not JSON (named);
  - a details object missing any field in its dimension's `details` list ("<id>: details missing p95, count");
  - a non-numeric value ("value must be a number in <unit>").
  It stores `{ value: Number(value), unit, evidence, details: <parsed object>, planHash, at: ISO }`, where `planHash` is the hash of the plan file text.
- `sign` refuses a KPI whose verifier is `agent`, and a verdict other than `pass`/`fail`. It stores `{ verdict, note, planHash, at }`.
- Per KPI, in `score`:
  - An entry whose `planHash` differs from the current plan hash is `stale`, and counts as waiting.
  - An `agent` KPI is `pass` or `fail` from its threshold, else `waiting` on the agent.
  - A `human` KPI takes the sign's verdict, else `waiting` on the human.
  - A `both` KPI is `fail` if either part fails, `pass` if both pass, else `waiting` on whichever is missing.
- The verdict comes from the agent side only. It is `FAIL` if any `agent`/`both` row fails, `PASS` if every one passes, else `PENDING` (some are waiting or stale). Human sign-offs never change the verdict. `checkPlan` problems are added to `problems` and force `FAIL`.
- The scorecard uses the spec's layout:
  - a header with the task id and title (or the plan path), the category, the plan path and hash, and the verdict with counts (`FAIL — 1 KPI failing · human review (advisory): 1 waiting`);
  - one row per agent-side KPI and one line per `n/a`;
  - `Human review (advisory):`, one line per `human`/`both` KPI with pass, fail or waiting, and the note;
  - `Evidence:`, one line per record;
  - `Details:`, each record's details as `key: value` lines, with arrays summarised as `[n values]`;
  - `Overrides:`, the plan's `Applied:` lines, or `none`.

- [ ] **Step 1: Write the failing tests** in `tools/evaluation.test.mjs`, on a generated plan from Task 2's fixture. The fixture's `cache` category needs three KPIs: `cache.diffs` (measured, `agent`, `== 0 diffs`), `cache.p95` (measured, `both`, `<= 5 ms`, details `['tool', 'run_at', 'p95', 'count']`) and `cache.signoff` (signed, `human`).
  - `it('refuses a record without evidence, without details, or with a non-number')` (Review Focus 1): try `''`, `'3.8ms'` and `'NaN'`. Each throws its message, and the store file does not exist afterwards.
  - `it('refuses details files that are missing, not JSON, or lack the dimension fields')` (Review Focus 4): expect `/details missing p95, count/`.
  - `it('refuses unknown KPI ids and lists the valid ones')` (Review Focus 2): `run(['record', PLAN, 'cache.nope', '1', ...])` returns 1, and the output includes `cache.diffs, cache.p95, cache.signoff`.
  - `it('stores the value with its full details')`: after recording `cache.p95` with details `{ tool: 'autocannon', tool_version: '7.15.0', run_at: '2026-11-25T10:00:00Z', p50: 2.1, p95: 3.8, p99: 4.6, count: 5000, environment: 'm2 / node 22' }`, the store has `value: 3.8`, and `details.count === 5000`. The scorecard markdown includes `p95: 3.8` and `tool: autocannon`.
  - `it('is PENDING while an agent KPI has no record, and names it')`: record only `cache.diffs = 0`. `verdict === 'PENDING'`, and the markdown names `cache.p95` as waiting.
  - `it('is PASS with human checks unsigned or failed, and lists them as advisory')`: record `cache.diffs = 0` and `cache.p95 = 3.8`, and sign `cache.signoff` `fail`. `verdict === 'PASS'`, and the markdown matches `/Human review \(advisory\)/`, listing `cache.p95` as waiting and `cache.signoff` as fail.
  - `it('is FAIL when a value breaks its threshold, with threshold and value')`: `cache.p95 = 7.2` gives `FAIL`, and the row shows `<= 5 ms` and `7.2 ms`.
  - `it('refuses to sign an agent-only KPI')`.
  - `it('treats entries recorded against an older plan as stale')`: record, edit the plan text, and score. The rows are `stale`, and the verdict is `PENDING`.
  - `it('scores a deprecated dimension still present in an old plan')`: deprecate a dimension in the fixture after generating. Its KPI still scores from the plan.
  - `it('resolves a task id to its plan, category and evaluation files')`: write `docs/tasks/list/0007-cache.md` with `Plan:` and `Category: cache`. `resolveTarget(root, '7').store === 'docs/tasks/evaluations/0007.json'`.

- [ ] **Step 2: Run and confirm the new tests fail**
  Run: `node --test tools/evaluation.test.mjs`
  Expected: FAIL on the new tests (`recordKpi is not a function`).

- [ ] **Step 3: Implement the interfaces and rules above in `tools/evaluation.mjs`.** Write the store with `JSON.stringify(store, null, 2) + '\n'`, creating its directory.

- [ ] **Step 4: Run and confirm the tests pass**
  Run: `node --test tools/evaluation.test.mjs tools/evaluation-registry.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add tools/evaluation.mjs tools/evaluation.test.mjs && git commit -m "feat: record measurements and sign-offs and score the output"`

---

### Task 4: Dimension registry v1 and the repository check

**Files:**
- Create: `skills/evaluating-outputs/dimensions.json`, `skills/evaluating-outputs/dimensions.md`
- Modify: `scripts/check-repo.mjs`

**Interfaces:**
- Consumes: `loadRegistry`, `registryProblems` (Task 1).
- Produces: registry `version: 1` with the nine dimensions of the spec's "initial registry" table: the same ids, titles, definitions and `order` values (10 to 70, then 90 and 100; 80 stays free), `since: 1` and `status: active`, with the evidence types below. A `checkEvaluation()` function in `check-repo.mjs`.

Evidence, units and `details` per dimension. Every measured dimension's `details` starts with `tool`, `tool_version`, `environment` and `run_at`. The list below gives the additional fields.
- `correctness`: measured; `diffs`, `cases`; `cases`, `failures`
- `consistency`: measured; `runs`, `violations`; `runs`, `divergent`
- `latency`: measured; `ms`, `s`; `load`, `count`, `p50`, `p95`, `p99`
- `memory`: measured; `MB`, `%`; `input_size`, `runs`, `peak_mb`, `steady_mb`
- `big-o`: measured, verifier `both`; `ratio`; `sizes` (≥ 2 input sizes), `timings`, `claimed`
- `failure-recovery`: measured; `failures`, `writes`; `faults_injected`, `recovered`
- `exception-handling`: measured; `errors`, `leaks`; `inputs`, `undefined_errors`
- `results`: measured, verifier `both`; `scenarios`; `scenarios`, `failing`
- `task-kpis`: `any`, no `units` or `details`

`dimensions.md` has one section per dimension: the definition, the question, what counts as evidence, what does not (estimates, reading the code), how to measure it in general, and the verifier. It ends with the "Extending the registry" and "Compatibility" rules from the spec, verbatim in substance.

- [ ] **Step 1: Add `checkEvaluation()` to `scripts/check-repo.mjs` first**, so it fails: it calls `registryProblems(loadRegistry({ dir: join(root, 'skills/evaluating-outputs') }))` and reports each problem as `fail('evaluation', p)`. It also fails when a key in `categories` has no `skills/evaluating-outputs/categories/<id>.md`, or a `.md` there has no key. Update the header comment and the success line to include `evaluation`.
- [ ] **Step 2: Run and confirm the check fails**
  Run: `npm run check`
  Expected: exit 1, with `evaluation: install the evaluating-outputs skill` (no registry yet).
- [ ] **Step 3: Write `dimensions.json`, `dimensions.md`, and a `categories.json` with `"version": 1, "categories": {}`.**
- [ ] **Step 4: Run and confirm the check passes**
  Run: `npm run check`
  Expected: `check-repo: ... OK (syntax, json, license, secrets, paths, shell, evaluation)`.
- [ ] **Step 5: Commit**
  `git add skills/evaluating-outputs scripts/check-repo.mjs && git commit -m "feat: add the evaluation dimension registry v1"`

---

### Task 5: Backend categories

**Files:**
- Modify: `skills/evaluating-outputs/categories.json`
- Create: `skills/evaluating-outputs/categories/{api,db-query,calculation-engine,caching,background-job}.md`

**Interfaces:**
- Consumes: dimension ids and units (Task 4).
- Produces: categories `api`, `db-query`, `calculation-engine`, `caching` and `background-job`, each covering all nine dimensions, with the task-specific KPIs in the spec's "Starting KPIs per category" table. Each also has `match` keywords and `defaults` for its placeholders. Pinned from the spec: `caching.hit-latency-p95 <= 5 ms`, `caching.hit-ratio >= 0.9 ratio`, and `caching.stale-after-write == 0 reads`.

Each `.md` file has one section per dimension, with anchors matching the KPIs' `method` links. Each section covers why the KPI and threshold were chosen (with a source for each default), the measurement command per stack, and what the `--details` file must contain. The stacks are Node, Python and Go, using for example autocannon or k6, `EXPLAIN (ANALYZE, BUFFERS)`, `process.memoryUsage()` or `/usr/bin/time -l`, pytest-benchmark and `go test -bench`.

- [ ] **Step 1: Run `npm run check` after adding only the category keys with empty `dimensions`.**
  Expected: exit 1, with one `evaluation: <cat>: dimension '<d>' needs kpis or na` per gap.
- [ ] **Step 2: Fill in the KPIs and the `.md` files until the check is clean.**
  Run: `npm run check`
  Expected: OK, including `evaluation`.
- [ ] **Step 3: Generate a plan for each category to prove the cases read well.** For each `c` of `api db-query calculation-engine caching background-job`, write a scratch plan with `## Test Cases`, run `node tools/evaluation.mjs plan <scratch>.md --category $c`, then `node tools/evaluation.mjs check <scratch>.md --category $c`.
  Expected: `READY` for each, with no `{{` left in the file.
- [ ] **Step 4: Commit**
  `git add skills/evaluating-outputs && git commit -m "feat: add backend evaluation categories"`

---

### Task 6: UI, page, LLM and general categories

**Files:**
- Modify: `skills/evaluating-outputs/categories.json`
- Create: `skills/evaluating-outputs/categories/{ui-component,page,llm-feature,general}.md`

**Interfaces:**
- Consumes: as in Task 5.
- Produces:
  - `ui-component`: KPIs for each state the spec lists (default, loading, empty, error, disabled), `== 0 violations` from axe, keyboard operability (signed, `both`), a visual diff within tolerance, bundle size added, and re-renders per prop change.
  - `page`: LCP, INP and CLS (lab run), loading/empty/error states, responsive breakpoints, axe, title/meta and route, `== 0 errors` in the console.
  - `llm-feature`: golden-set pass rate, tool correctness and refusal on negative cases, with methods pointing to the `golden-set` and `deepeval` skills.
  - `general`: one generic KPI per dimension; its `task-kpis` entry is one signed KPI, `general.task-kpis-stated`: "the plan states this task's own KPIs as hand-written cases, and the human agrees they are the right ones".

  Dimensions that don't apply are `na` with a reason, for example `ui-component` `failure-recovery` when the component makes no calls.

- [ ] **Step 1: Add the four keys with empty `dimensions`, run `npm run check`, and confirm it fails per gap.**
- [ ] **Step 2: Fill in the KPIs and the `.md` files.** The page and ui-component files name Lighthouse CI or `web-vitals`, `@axe-core/playwright`, Playwright `toHaveScreenshot`, and a bundle analyzer, each with the `--details` fields.
  Run: `npm run check`
  Expected: OK.
- [ ] **Step 3: Run the scratch-plan check from Task 5 Step 3 for the four new categories.**
  Expected: `READY` for each.
- [ ] **Step 4: Commit**
  `git add skills/evaluating-outputs && git commit -m "feat: add ui, page, llm and general evaluation categories"`

---

### Task 7: Task board gates

**Files:**
- Modify: `tools/tasks.mjs` (`TASK_TEMPLATE`, `META`, `addTask`, `validateTaskReadiness`, `finishTask`, `handleAdd`, `handleDone`, `USAGE`)
- Modify: `tools/review.mjs` (`reviewTask`)
- Test: `tools/tasks.test.mjs`

**Interfaces:**
- Consumes: `checkPlan`, `scoreTarget`, `EVALUATIONS_DIR` (Tasks 2 and 3); `loadRegistry`, `EvaluationError` (Task 1).
- Produces:
  - **The note template:** `TASK_TEMPLATE` gains `Category: {{category}}` after `Scope:`, and `'Category'` joins `META` after `'Scope'`.
  - **`add`:** `addTask(root, title, { scope = '', category = 'none' } = {})`, and `tasks add "<title>" --category <id>`.
  - **`start`:** `validateTaskReadiness` ends with `validateEvaluation(root, task)`. That function returns at once when the note has no `Category:` line or it is `none`. Otherwise it loads the registry: a missing skill fails with the install message, and an unknown category fails with the `resolveCategory` message listing the categories. It then fails with `${task.id} is not ready to start: ${problem}` for the first `checkPlan(root, planPath, { category })` problem.
  - **`done`:** `finishTask` runs `scoreTarget(root, task.id)` after the tests pass, for a categorised task. Unless the verdict is `PASS`, it returns `{ task, tests, finished: false, evaluation }`. `handleDone` then logs `evaluation <verdict>: <task.id> NOT done — <scorecard path>`, followed by one `- <id>: <status>` per row that is not passing, and returns 1.
  - **`review`:** for a categorised task, `reviewTask` adds the finding `evaluation <verdict>: <n> KPI(s) failing, <m> waiting (<scorecard path>)` when the verdict is not PASS, and appends a `## Evaluation` section with the scorecard markdown.
  - **Unchanged:** `review.mjs`'s `BOOKKEEPING` already excludes `docs/tasks/`, so scorecard files never count as scope creep.

- [ ] **Step 1: Write the failing tests** in `tools/tasks.test.mjs`. Add a `fillEvaluatedTask(root, task, category = 'caching')` helper that calls `fillTask`, sets `Category: caching`, runs `writePlanEvaluation` on `PLAN`, and re-approves the quiz.
  - `it('leaves tasks with no category or Category: none unchanged')`: an old-style note without the line, and a `none` note, both start and finish exactly as before (Spec case "no Category line").
  - `it('refuses to start a categorised task whose plan has no Evaluation section')`: the message matches `/no ## Evaluation section/`, `Status: next` is unchanged, and `Branch:`/`Base:` are empty.
  - `it('refuses an unknown category and lists the available ones')` (Review Focus 5).
  - `it('refuses to start when the plan names a different category than the note')`.
  - `it('starts a categorised task whose plan passes check')`.
  - `it('refuses done while the scorecard is PENDING and lists what waits')`: the task stays `current`, the output lists the waiting agent KPIs, and `docs/tasks/evaluations/<id>.md` exists.
  - `it('finishes with human checks waiting or failed, and lists them')`: every agent KPI is recorded and passing, and one human KPI is unsigned. The task is done, and the output includes `human review (advisory):` with that KPI as waiting.
  - `it('finishes when the scorecard is PASS')`: record every agent KPI with details through `evaluation.mjs`'s `recordKpi`, then call `done`. The task is done.
  - `it('reports a non-PASS evaluation as a review finding')`.
  - `it('makes the approval stale when a threshold in the plan changes')`: edit an `Override:` line and rerun `plan`. `start` fails with the approval-stale message (existing behaviour, now covering the Evaluation section).

- [ ] **Step 2: Run and confirm the new tests fail**
  Run: `node --test tools/tasks.test.mjs`
  Expected: the new tests FAIL; the existing ones PASS.

- [ ] **Step 3: Implement the interfaces above.**

- [ ] **Step 4: Run the full suite**
  Run: `npm test`
  Expected: PASS, all suites.

- [ ] **Step 5: Commit**
  `git add tools/tasks.mjs tools/review.mjs tools/tasks.test.mjs && git commit -m "feat: gate task start, done and review on the evaluation"`

---

### Task 8: Install, permissions and docs

**Files:**
- Modify: `cli/install.mjs` (`TASK_TOOLS` and `toolFiles`, `settingsFile`)
- Create: `skills/evaluating-outputs/SKILL.md`
- Modify: `skills/tracking-tasks/SKILL.md`, `README.md`
- Test: `cli/stones.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - **Tool files:** `EVALUATION_TOOLS = ['evaluation.mjs', 'evaluation-registry.mjs']`, shipped as `managed` files to `.claude/tools/` when the task board is selected or `evaluating-outputs` is in `answers.install.skills`.
  - **Permissions** for the same condition: `Bash(node .claude/tools/evaluation.mjs plan:*)`, `… check:*`, `… suggest:*`, `… record:*` and `… score:*`. `sign` is never added.
  - **Default selection:** the skill has no `frameworks` in its metadata, so `previousSkills` selects it by default in a first `init` (A9); no change to `cli/questions.mjs`.

`SKILL.md` has a frontmatter `name: evaluating-outputs`, a `description` that triggers on planning a task, writing a plan's test cases, measuring latency, memory or Big O, scoring a task's output, a failing or pending scorecard, and adding a dimension or category, plus `metadata.title` and `metadata.summary`. Its body covers:
- the workflow (spec workflow steps 1 to 6, with the exact commands);
- the dimension table, linking `dimensions.md`;
- the category list, linking each `categories/<id>.md`;
- the rules:
  - never estimate a value, and never `record` without the run that produced it;
  - ask every `human` or `both` KPI with AskUserQuestion (Pass/Fail) and run `sign` only with the user's answer;
  - every `Override:` and `NA:` line goes in the spec's `## Assumptions` and is confirmed;
  - the spec quiz includes one question on a threshold or verifier;
  - lowering a threshold to pass is a finding;
- how to extend the registry (the spec's three steps).

`tracking-tasks/SKILL.md`: Workflow step 2 adds "set **Category** (`add --category <id>`; `node .claude/tools/evaluation.mjs suggest <spec>`)". Step 3 adds "run `evaluation.mjs plan <plan> --category <id>` before the spec quiz". Step 8 adds "`done` also requires a PASS scorecard for a categorised task (evaluating-outputs skill)". The `Line | Set by | Meaning` table gains a `Category:` row.

`README.md`: a short "Evaluate task outputs" subsection under "Included project tools", with the four commands.

- [ ] **Step 1: Write the failing tests** in `cli/stones.test.mjs`, beside the existing task-board install test (around line 520):
  - `it('installs the evaluation tools with the task board and allows every subcommand but sign')`: the files `.claude/tools/evaluation.mjs` and `.claude/tools/evaluation-registry.mjs` exist; `.claude/skills/evaluating-outputs/dimensions.json` exists; `permissions.allow` includes `Bash(node .claude/tools/evaluation.mjs record:*)`; and no allow entry matches `/evaluation\.mjs( sign)?:\*/`.
  - `it('installs the evaluation tools with the skill alone, without the board')`.
  - `it('does not install the evaluation tools when neither is selected')`.
- [ ] **Step 2: Run and confirm the tests fail**
  Run: `node --test cli/stones.test.mjs`
  Expected: the three new tests FAIL.
- [ ] **Step 3: Implement the install changes and write the three docs.**
- [ ] **Step 4: Verify the whole repo**
  Run: `npm test && npm run check && npm run smoke`
  Expected: all three succeed. Then run the installed tool once in a temp project: `node bin/stones.mjs init <tmp> --yes`, then `node <tmp>/.claude/tools/evaluation.mjs suggest <tmp>/AGENT.md`. It prints a category (`general` for an empty brief) and exits 0.
- [ ] **Step 5: Commit**
  `git add cli/install.mjs cli/stones.test.mjs skills/evaluating-outputs/SKILL.md skills/tracking-tasks/SKILL.md README.md && git commit -m "feat: install the evaluating-outputs stone and document it"`

---

## Test Strategy

Unit tests (`node:test`) cover the two new tools on temp directories with fixture registries, so code behaviour never depends on the shipped KPI content:
- `evaluation-registry.test.mjs` covers validation, extension, deprecation, overrides and placeholders.
- `evaluation.test.mjs` covers plan generation, idempotency, `check`, `suggest`, record and sign refusals, scoring, staleness and task resolution.

The shipped content (dimensions and nine categories) is validated by `npm run check` through the same `registryProblems` function, plus a per-category scratch-plan `plan` and `check` run.

Integration tests through `tasks.mjs main` cover the start, done and review gates, asserting the message and the unchanged board state. Install tests in `cli/stones.test.mjs` cover files and permissions. `npm test`, `npm run check` and `npm run smoke` all pass before the work is called done.

## Test Cases

- Case: `plan` is run on a plan with `--category caching`. Expected: the plan gains a `## Evaluation` section and one `[eval:<kpi-id>]` case per KPI, with `n/a` dimensions listed with reasons (Task 2).
- Case: `plan` is run twice on the same plan. Expected: the file is byte-identical after the second run (Task 2).
- Case: `plan` is given two `--category` flags. Expected: exit 1 with "a task is atomic: split it into one task per category" (Task 2).
- Case: a row inside the generated section is edited by hand. Expected: `check` fails with "edited by hand; rerun `evaluation.mjs plan`" (Task 2).
- Case: a plan generated at registry v1 is checked after v2 adds a dimension. Expected: no problems, and a note that v2 is newer (Task 2).
- Case: `record` is given an empty `--evidence`, a non-number, or a measured KPI without `--details`. Expected: exit 1 and nothing stored (Task 3).
- Case: a details file lacks a field its dimension lists. Expected: exit 1, naming the missing fields (Task 3).
- Case: a p95 record carries p50/p95/p99, the sample count, the tool and the environment. Expected: the scorecard shows the value, and its Details section shows each field (Task 3).
- Case: every agent KPI passes but a human KPI is unsigned or signed fail. Expected: `score` is PASS and lists it under "Human review (advisory)" (Task 3).
- Case: an agent KPI has no record. Expected: `score` is PENDING, names it, and exits 1 (Task 3).
- Case: one value breaks its threshold. Expected: `score` is FAIL, showing the threshold and the value (Task 3).
- Case: the plan changes after a value was recorded. Expected: that row is stale and the verdict is PENDING (Task 3).
- Case: a category in `categories.json` misses a dimension. Expected: `npm run check` fails, naming the category and dimension (Task 4).
- Case: a new dimension is added to the fixture registry and covered by every category. Expected: no registry problems, and the dimension resolves in `order` position with no code change (Task 1).
- Case: a task note has `Category: caching` and its plan has no Evaluation section. Expected: `start` is rejected and the task stays queued with no branch or base (Task 7).
- Case: a task note has no Category line. Expected: `start` and `done` behave exactly as before (Task 7).
- Case: `done` is run on a categorised task whose scorecard is PENDING. Expected: it refuses, lists the waiting agent KPIs, and the task stays current (Task 7).
- Case: `done` is run with every agent KPI passing and a human check waiting. Expected: the task is done, and the output lists the advisory check (Task 7).
- Case: `init` with the task board selected. Expected: the evaluation tools are installed, and every subcommand except `sign` is in `permissions.allow` (Task 8).
