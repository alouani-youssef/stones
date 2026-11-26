# Evaluating Outputs Design

## Intent

A task's output should be judged against requirements that were fixed before the work started, not against whatever the agent decides to check afterwards. This stone adds an evaluation step to planning. The task gets a category (API, DB query, calculation engine, cache, ...). A predefined mapping turns that category into dimensions, KPIs, thresholds and test cases, and those are injected into the plan. When the work is built, the output is scored against the same requirements. The agent records what it measured, and the task is not done until every agent-measured KPI passes. The human in the loop signs off on what only a person can judge; those sign-offs are advisory, so they are shown in the scorecard and in `done`'s output but never block it. The model's reasoning, the process it goes through to produce the output, is not evaluated: only the output is.

Who it serves: the agent, which gets concrete, measurable targets during planning instead of "make it fast", and the human reviewer, who gets one scorecard that says what was measured, how, by whom, and what is still waiting on them.

## Goals

- One fixed set of evaluation dimensions, the same for every task: correctness, consistency, latency, memory, Big O, failure recovery, exception handling, results, and task-specific KPIs. They are defined in a versioned registry with a schema, so dimensions can be added later without code changes and without breaking approved plans.
- A predefined, machine-readable mapping from each task category to its KPIs, thresholds, measurement method, verifier (`agent`, `human`, `both`) and case templates for each dimension.
- Requirements generated into the plan at planning time, so they go through the existing spec quiz and approval before implementation.
- A scorecard per task, built from recorded measurements and human sign-offs, that gates `tasks.mjs done`.
- Usable without the task board, on a plan file directly.

## Non-goals

- Automatic runtime profiling. The tool does not run load tests or profilers itself; the agent runs the commands the category file names and records the results. A profiling hook may come later.
- A weighted 0-100 quality index. The verdict is pass/fail per KPI; see A3.
- Evaluating the model's reasoning. It is the process the model goes through to produce the output, not an outcome, so no dimension, KPI or record covers it.
- Evaluating LLM output quality. That stays with `golden-set`, `deepeval` and `giskard`; the `llm-feature` category points there instead of redefining it.

## Anti-goals

- **Numbers without evidence.** A recorded value with no command, file or run behind it is rejected. Values are never estimated by reading code (same rule as `measuring-complexity` and `anti-slop`).
- **The agent signing for the human.** A `human` check is recorded only from the user's own answer, asked through AskUserQuestion, as with assumptions in `confirming-specs`.
- **Moving the goalposts.** A threshold changed after the plan was approved makes the approval stale, like a changed spec. Lowering a threshold to get a pass is a finding, not a fix.
- **Boilerplate requirements.** A dimension that does not apply to a task is marked `n/a` with a reason, rather than given a meaningless KPI.

## Constraints

- Node.js 22.13+, no new dependencies (matches the rest of `tools/`).
- Must fit the existing flow: `brainstorming` writes the spec, `confirming-specs` handles assumptions and the quiz, `writing-plans` writes the plan, and `tasks.mjs` gates `start`, `review` and `done`.
- Existing tasks and plans without a category keep working unchanged.

## Approaches

1. **Skill only.** SKILL.md plus a reference file per category, applied by hand. It is cheap, but nothing enforces it, and requirements drift between runs, which defeats "predefined".
2. **Skill + mapping file + tool (picked).** Approach 1 plus `categories.json` and `tools/evaluation.mjs`, which generates the plan section, records measurements and sign-offs, writes the scorecard and is checked by the task board. It follows the pattern of `spec-quiz.mjs` and `complexity-score.mjs`.
3. **Approach 2 plus automatic measurement.** A hook would profile latency and memory itself. That needs a profiler per stack, so it is deferred.

The user picked approach 2.

## Design

### Files

```text
skills/evaluating-outputs/
├── SKILL.md                    when and how to evaluate; the workflow below
├── dimensions.json             the dimension registry (schema below)
├── dimensions.md               each dimension: definition, what counts as evidence, how to measure it
├── categories.json             the predefined mapping (schema below)
└── categories/
    ├── api.md                  rationale and measurement commands per stack for each KPI
    ├── db-query.md
    ├── calculation-engine.md
    ├── caching.md
    ├── background-job.md
    ├── llm-feature.md          points to golden-set / deepeval for quality dimensions
    ├── ui-component.md
    ├── page.md
    └── general.md              fallback when no category fits
tools/evaluation.mjs            plan / record / sign / score / check
tools/evaluation.test.mjs
```

`dimensions.json` and `categories.json` are the single source of truth. The `.md` files explain them and give the measurement commands; `scripts/check-repo.mjs` fails when a category in the JSON has no `.md` file, or the reverse.

### The dimensions

Dimensions are data, not a hard-coded list. They live in `dimensions.json`, a registry that every other part of the tool reads: categories, plan generation, `check`, `score` and the scorecard columns. No code in `evaluation.mjs` names a specific dimension. Adding a dimension later is one registry entry, plus coverage in each category, plus a section in `dimensions.md`. It is never a code change.

#### Registry schema (`dimensions.json`)

```json
{
  "version": 1,
  "dimensions": [
    {
      "id": "latency",
      "title": "Latency",
      "definition": "Time to result at stated percentiles under a stated load.",
      "question": "How long does the output take to produce, under the load it will see?",
      "evidence": "measured",
      "units": ["ms", "s"],
      "details": ["samples", "min", "p50", "p95", "p99", "max", "count", "load", "input_size", "tool", "tool_version", "environment", "run_at"],
      "verifier": "agent",
      "order": 30,
      "since": 1,
      "status": "active"
    }
  ]
}
```

| Field | Meaning | Rule |
| --- | --- | --- |
| `id` | stable key used in KPI ids, plans, recordings and scorecards | kebab-case; never renamed and never reused, even after removal |
| `title`, `definition`, `question` | what the dimension measures, in one sentence, and the question a KPI under it must answer | required; `definition` is what `check` shows when a KPI looks off-topic |
| `evidence` | `measured` (a number compared with a threshold) or `signed` (a pass/fail judgement) | decides whether `record` needs `--details` and which threshold ops are allowed (`<=`, `>=`, `==` for measured, `signed` for signed) |
| `units` | units a measured KPI under this dimension may use | `check` rejects a KPI whose unit is not listed |
| `details` | the result fields a `--details` file must contain for a measured KPI | `record` refuses a file missing a listed field; extra fields are kept |
| `verifier` | the default verifier: `agent`, `human` or `both` | a KPI may override it |
| `order` | the column and section order in plans and scorecards | integers with gaps (10, 20, 30, ...) so new dimensions slot in without renumbering |
| `since` | the registry version that introduced the dimension | see compatibility below |
| `status` | `active` or `deprecated` | a deprecated dimension is no longer required of new plans but still scores in old ones |

#### The initial registry (version 1)

| Order | Id | Title | Definition | Evidence | Default verifier |
| --- | --- | --- | --- | --- | --- |
| 10 | `correctness` | Correctness | outputs match expected values for valid inputs, including boundaries | measured (mismatch count) | agent |
| 20 | `consistency` | Consistency | the same input gives the same output across repeated runs, and the output follows the project's existing contracts (formats, error shapes, naming) | measured (divergent runs, contract violations) | agent |
| 30 | `latency` | Latency | time to result at stated percentiles under a stated load | measured (ms) | agent |
| 40 | `memory` | Memory consumption | peak and steady-state memory for a stated input size; no growth across repeated runs | measured (MB, growth %) | agent |
| 50 | `big-o` | Big O | stated time and space complexity, backed by measurements at two or more input sizes | measured (growth ratio) and signed | both |
| 60 | `failure-recovery` | Failure recovery | behaviour when a dependency is down, slow or returns errors: retries, fallbacks, no partial writes, recovery once it is back | measured (failed recoveries, partial writes) | agent |
| 70 | `exception-handling` | Exception handling | invalid input and internal errors produce defined errors; nothing is swallowed; no stack traces or secrets leak | measured (undefined errors, leaks) | agent |
| 90 | `results` | Results | the task's expected behaviour and scenarios hold end to end in the real app | measured (failing scenarios) and signed | both |
| 100 | `task-kpis` | Task-specific KPIs | the category's own KPIs (hit ratio, query plan, numeric precision, ...) | per KPI | per KPI |

A dimension whose evidence is "measured and signed" (`big-o`, `results`) is expressed through `"evidence": "measured"` with `"verifier": "both"`. The agent records the number and its details, which gate the verdict. The human signs the judgement, which is advisory.

#### Extending the registry

To add a dimension (for example `security` or `cost`):

1. Add an entry to `dimensions.json` with a new `id`, an `order` between existing ones, and `since` set to the next registry `version`. Then bump `version`.
2. Add its section to `dimensions.md`: the definition, what counts as evidence, and measurement guidance.
3. Cover it in every category, with KPIs or with `"na": "<reason>"`. `npm run check` fails until every category does, naming each gap.

Projects can add their own dimensions in `.claude/evaluation.json` under `dimensions`, with the same schema. Project ids must not clash with registry ids. A project dimension must be covered by every category the project uses. The registry's own dimensions cannot be removed or redefined by a project, only marked `na` per category with a reason.

Removing a dimension means setting `"status": "deprecated"`; entries are never deleted. That way, old plans and scorecards that mention it still resolve.

#### Compatibility

- `plan` writes `Dimensions: v<version> (<hash of the resolved registry>)` into the plan's Evaluation section, so a plan states the dimension set it was built and approved against.
- Adding a dimension does not invalidate approved plans. `check` and `score` hold a plan to the registry version it records, so tasks already in progress are not blocked by a dimension added after their approval. `check` reports that a newer registry exists, and regenerating the plan brings in the new dimension and needs approval again.
- A recorded KPI whose dimension is deprecated still scores. A plan generated after the deprecation no longer includes it.
- Only the registry's `version` decides compatibility. A change to the meaning of an existing dimension is not allowed; add a new dimension and deprecate the old one.

### `categories.json` schema

```json
{
  "version": 1,
  "categories": {
    "caching": {
      "title": "Caching",
      "match": ["cache", "redis", "memcached", "ttl", "invalidation"],
      "dimensions": {
        "latency": {
          "kpis": [
            {
              "id": "caching.hit-latency-p95",
              "metric": "p95 latency of a cache hit",
              "threshold": { "op": "<=", "value": 5, "unit": "ms" },
              "method": "load test with warm cache; see categories/caching.md#latency",
              "verifier": "agent",
              "case": "Case: a warm cache key is read under {{load}} concurrent requests. Expected: p95 latency <= {{value}}{{unit}}."
            }
          ]
        },
        "task-kpis": {
          "kpis": [
            { "id": "caching.hit-ratio", "metric": "hit ratio on the replayed workload", "threshold": { "op": ">=", "value": 0.9, "unit": "ratio" }, "verifier": "agent", "method": "...", "case": "..." },
            { "id": "caching.stale-after-write", "metric": "stale reads after a write", "threshold": { "op": "==", "value": 0, "unit": "reads" }, "verifier": "agent", "method": "...", "case": "..." }
          ]
        }
      }
    }
  }
}
```

`dimensions` in a category is keyed by registry dimension `id`. Every category must cover every active dimension in the registry, either with at least one KPI or with `"na": "<reason>"`. A key that is not a registry or project dimension is an error. A KPI's threshold op and unit must match its dimension's `evidence` and `units`. `{{...}}` placeholders in `case` are filled from the KPI and from a category's `defaults` (for example `load`).

Starting KPIs per category (the builder fills in the full set in the JSON and `.md` files, following this outline):

| Category | Task-specific KPIs |
| --- | --- |
| `api` | status codes and error body match the contract; p95/p99 latency at stated RPS; idempotency of retried writes; auth enforced on every route; pagination stable |
| `db-query` | query plan uses an index (no seq scan on large tables); rows scanned vs returned; N+1 absent; transaction isolation correct under concurrent writers; migration reversible |
| `calculation-engine` | numeric precision and rounding rule; results match a reference set; determinism across runs; overflow / division by zero handled; complexity measured at 2+ sizes |
| `caching` | hit ratio; stale reads after write; stampede protection; TTL honoured; behaviour when the cache is down (falls through, no errors) |
| `background-job` | at-least-once / exactly-once as stated; retry with backoff; poison message handling; throughput; no duplicate side effects |
| `llm-feature` | golden-set pass rate; tool correctness; refusal on negative cases (via `golden-set` / `deepeval`) |
| `ui-component` | renders correctly for each documented prop/state (default, loading, empty, error, disabled); zero axe accessibility violations; keyboard operable with visible focus; visual regression diff within tolerance; bundle size added; render time / re-renders for a stated prop change |
| `page` | LCP, INP and CLS at stated thresholds (lab run); loading, empty and error states present; responsive at stated breakpoints; zero axe violations; title/meta and route correct; no console errors |
| `general` | the nine dimensions with generic KPIs; the plan states the task-specific KPIs by hand |

### Project overrides

An optional `.claude/evaluation.json` in the target project can change thresholds, mark a KPI `n/a` with a reason, or add categories and KPIs, using the same schema. The scorecard lists every override next to the value it replaced.

### Workflow

1. **Categorise, during brainstorming.** A task is atomic, so it has exactly one category. The spec names it in a `Category:` line under `## Evaluation`. `evaluation.mjs suggest <spec>` proposes the best match from `match` keywords, and the user confirms it as an assumption. A task that seems to need two categories (for example an API plus its cache) is split into two tasks.
2. **Generate into the plan.** `evaluation.mjs plan <plan.md> --category caching` writes a `## Evaluation` section into the plan and appends the generated cases to `## Test Cases`, each tagged with its KPI id: `- Case: ... Expected: ... [eval:caching.hit-ratio]`. Running it again replaces only the tool's own section and tagged cases. Per-task threshold changes go in the section as `Override: <kpi-id> <op> <value> — <reason>` and count as assumptions to confirm.
3. **Approve.** The plan, now with its Evaluation section, goes through the existing spec quiz. The quiz should include at least one question on a threshold or verifier.
4. **Build and measure.** For every `agent` or `both` KPI, the agent runs the measurement and records it:
   `evaluation.mjs record <plan|task> <kpi-id> <value> --evidence "<command, file or log path>" [--details <results.json>]`
   The value is the number compared with the threshold. The full results are stored with it, so the reviewer can see what produced the number. These include the raw samples or summary statistics (for example min, p50, p95, p99, max and sample count), the input size and load, the tool and its version, the environment, and the time of the run. For a measurable KPI, `--details` is required. A `signed` KPI takes a note instead.
5. **Human sign-off.** For every `human` or `both` KPI, the agent asks the user through AskUserQuestion (Pass / Fail, with Other for a note) and records the answer:
   `evaluation.mjs sign <plan|task> <kpi-id> pass|fail [--note "..."]`
6. **Score.** `evaluation.mjs score <plan|task>` writes the scorecard and exits 1 unless the verdict is PASS.

### Scorecard

Written to `docs/tasks/evaluations/NNNN.md` for a board task, or next to the plan as `<plan>.eval.md` otherwise, and committed. Measurements and sign-offs are stored in `<same name>.json` alongside it.

```text
Evaluation: 0007 Cache product lookups — caching
Plan: docs/design/plans/2026-11-25-product-cache.md (hash a1b2c3)
Verdict: FAIL — 1 KPI failing · human review (advisory): 1 waiting

Dimension           KPI                              Threshold   Value    By     Status
correctness         caching.read-matches-source      == 0 diffs  0        agent  pass
latency             caching.hit-latency-p95          <= 5 ms     3.8 ms   agent  pass
task-kpis           caching.hit-ratio                >= 0.9      0.84     agent  FAIL
task-kpis           caching.stale-after-write        == 0        0        agent  pass
results             caching.results-end-to-end       == 0 fail   0        both   pass · human: waiting (advisory)
memory              —                                n/a: cache is an external Redis; app memory unchanged
...
Evidence: one line per recorded value with its command or file.
Details: per measurable KPI, the stored results (samples or percentiles, input size, load,
         tool and version, environment, run time), from the .json file next to the scorecard.
Overrides: none.
```

The verdict comes from the agent side only. It is PASS when every `agent` and `both` KPI has a current record that meets its threshold, FAIL when any of them breaks its threshold, and PENDING when one has no current record. Human sign-offs (`human` KPIs, and the human half of `both`) are advisory: the scorecard lists them under "Human review (advisory)" as pass, fail or waiting, and `done` prints that list, but they never change the verdict. A recorded value with empty evidence is refused at `record` time.

### Task board integration

- `tasks.mjs add` writes a `Category:` line in the note template (`Category: none` allowed).
- **Readiness (`start`)**: when the note's category is not `none`, the plan must have a `## Evaluation` section with `[eval:...]` cases for every required KPI of that category (`evaluation.mjs check <plan>`). With `Category: none`, or with no Category line (older notes), nothing changes.
- **Approval staleness**: the plan hash already covers the Evaluation section, so a changed threshold makes the approval stale.
- **`review`** includes the scorecard and adds a finding when it is not PASS.
- **`done`** refuses when the scorecard is not PASS, with the failing or waiting KPIs in the message.

### Installation

`evaluating-outputs` is an optional skill in `init`, selected by default when the task board is selected. Installing it copies the skill's mapping and docs. `tools/evaluation.mjs` ships with the task-board tools, and permissions get `Bash(node .claude/tools/evaluation.mjs <subcommand>:*)` rules. The allow rule covers every subcommand except `sign` (see the decisions below), so the user sees each sign-off being written.

## Decisions from the builder check

These are design calls made after the review, not stated by the user:

- **Tool always ships with the board.** `evaluation.mjs` is added to the task-board tools, so `tasks.mjs` can import it statically. `categories.json` is read from `.claude/skills/evaluating-outputs/`. If a note has a category but the skill is not installed, `start` fails with "install the evaluating-outputs skill (npx ai-stones init)".
- **The note's `Category:` line is authoritative.** The spec only proposes the category. `plan` writes `Category: caching` into the plan's Evaluation section, and `check` fails when that line disagrees with the note.
- **Thresholds are resolved at plan time.** `plan` merges `categories.json`, `.claude/evaluation.json` and per-task overrides, then writes the resolved threshold into each KPI line of the plan. The approval hash covers them. Editing `.claude/evaluation.json` later changes only plans generated after the edit, and `check` reports a plan whose thresholds differ from the current resolution, so it can be regenerated and re-approved.
- **Every KPI of a category is required.** A task can opt out of one with `NA: <kpi-id> — <reason>` in the plan's Evaluation section. Each such line is an assumption the user confirms (A11).
- **Recordings are tied to the plan.** Each `record` and `sign` stores the plan hash. `score` treats entries recorded against an older hash as missing. `done` runs `score` again rather than trusting the committed file.
- **`both` means two steps.** A `both` KPI needs an agent `record` with evidence, which gates the verdict, and gets a human `sign`, which is advisory.
- **`sign` asks first.** The allow rule lists the subcommands `plan`, `check`, `suggest`, `record` and `score`. It does not list `sign`, so every sign-off goes through a permission prompt the user sees.

## Assumptions

- A1: The first category set is api, db-query, calculation-engine, caching, background-job, llm-feature and general. Status: denied: add ui-component and page; the set is api, db-query, calculation-engine, caching, background-job, llm-feature, ui-component, page and general
- A2: A task can have more than one category, and their KPIs are combined. Status: denied: a task is atomic and has exactly one category; work spanning two categories is split into two tasks
- A3: The verdict is pass/fail per KPI with no weighted overall score. Status: confirmed (plus: measurable KPIs store their full results alongside the value)
- A4: Consistency means repeatable output across runs plus conformance to the project's existing contracts. Status: confirmed
- A5: Reasoning means the agent's written design justification, judged by the human. Results means the task's scenarios hold end to end, checked by both. Status: denied: reasoning is the process the model goes through to produce the output, not a KPI, and it is out of evaluation entirely; the reasoning dimension is removed. Results stays as stated
- A6: The agent runs measurements itself and records them with evidence; the tool does not profile. Status: confirmed
- A7: `done` is blocked until the scorecard is PASS for any task with a category. Status: confirmed (PASS is decided by the agent-measured KPIs; human checks are advisory, per the spec quiz)
- A8: Tasks with no category, or `Category: none`, are not affected by any new gate. Status: confirmed
- A9: The skill is optional in `init` and selected by default when the task board is selected. Status: confirmed
- A10: Scorecards and their JSON are committed under `docs/tasks/evaluations/`. Status: confirmed
- A11: Every KPI of a category is required; a task opts out of one only with an `NA:` line and a reason, confirmed by the user. Status: confirmed
- A12: A dimension added to the registry after a plan was approved does not block that task; the plan stays on the registry version it records until it is regenerated. Status: confirmed
- A13: Projects can add their own dimensions in `.claude/evaluation.json`, but cannot remove or redefine the built-in ones (only mark them `na` per category with a reason). Status: confirmed
- A14: Dimensions are never deleted or redefined; one is retired by marking it `deprecated`, and a changed meaning becomes a new dimension. Status: confirmed

## Left to the builder

- The full KPI list and default thresholds per category, following the outline above, with sources for the defaults written in each category `.md`.
- Measurement commands per stack in the category files (for example autocannon or k6 for latency, `EXPLAIN (ANALYZE, BUFFERS)` for query plans, `process.memoryUsage` or `/usr/bin/time -l` for memory).
- The exact keyword lists for `suggest`.
- Output formatting details of the scorecard.

## Test Strategy

Unit tests with `node:test` for `tools/evaluation.mjs`: mapping validation, plan generation and idempotent regeneration, record, sign and scoring rules, and overrides. These run on temporary project directories, like `spec-quiz.test.mjs`. Integration tests through the task CLI in `tools/tasks.test.mjs` cover the readiness and `done` gates, asserting both the error message and the unchanged board state. `scripts/check-repo.mjs` validates `categories.json` against the schema and checks that it matches the category `.md` files.

## Test Cases

- Case: `plan` is run on a plan with `--category caching`. Expected: the plan gains a `## Evaluation` section and one `[eval:<kpi-id>]` case under `## Test Cases` for every caching KPI, and `n/a` dimensions are listed with their reasons.
- Case: `plan` is run twice on the same plan. Expected: the second run leaves the file byte-identical.
- Case: `record` is called with an empty `--evidence`. Expected: it exits 1 and nothing is stored.
- Case: `record` is called for a measurable KPI without `--details`. Expected: it exits 1 and nothing is stored.
- Case: `record` is called with a details file holding p50/p95/p99 and the sample count. Expected: the scorecard shows the value, and its Details section shows those statistics with the tool and environment.
- Case: `plan` is called with two `--category` flags. Expected: it exits 1 with a message to split the task.
- Case: every agent KPI passes but one human KPI is unsigned. Expected: `score` reports PASS and lists that KPI as waiting under "Human review (advisory)".
- Case: an agent KPI has no record yet. Expected: `score` reports PENDING, names that KPI, and exits 1.
- Case: one recorded value breaks its threshold. Expected: `score` reports FAIL with that KPI, its threshold and its value.
- Case: a task note has `Category: api` and its plan has no Evaluation section. Expected: `tasks.mjs start` is rejected and the task stays queued with no branch or base.
- Case: a task note has no Category line. Expected: `start` and `done` behave exactly as before.
- Case: `done` is run on a categorised task whose scorecard is PENDING. Expected: it refuses, lists the waiting agent KPIs, and the task stays current.
- Case: `done` is run when every agent KPI passes but a human sign-off is waiting or `fail`. Expected: the task is done, and the output lists the advisory human checks with their status.
- Case: `.claude/evaluation.json` raises a threshold. Expected: the generated case and the scorecard use the new value and list the override.
- Case: `categories.json` has a category missing a dimension. Expected: `npm run check` fails and names the category and dimension.
- Case: a new dimension is added to `dimensions.json` with `since: 2` and covered by every category. Expected: `npm run check` passes, newly generated plans include it in `order` position, and the scorecard shows its column, with no change to `evaluation.mjs`.
- Case: a plan approved at registry v1 is checked after v2 adds a dimension. Expected: `check` and `score` pass on v1's dimensions and report that a newer registry exists.
- Case: a category uses a dimension key that is not in the registry or the project file. Expected: `npm run check` (or `check` in a project) fails, naming the key.
- Case: a project dimension reuses a registry id. Expected: `check` fails, naming the clash.
- Case: a measured KPI's `--details` file lacks a field its dimension lists in `details`. Expected: `record` exits 1, names the missing field, and stores nothing.
- Case: a dimension is marked `deprecated`. Expected: new plans omit it, and an old scorecard that recorded it still scores it.
- Case: a threshold in the plan changes after approval. Expected: the approval is reported stale and `start` is rejected.
