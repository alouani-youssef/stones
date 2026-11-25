---
name: evaluating-outputs
description: Use when planning a task whose output must be measured (an API, DB query, calculation engine, cache, background job, UI component, page or LLM feature), when writing a plan's test cases, when measuring latency, memory, Big O, failure recovery or exception handling, when scoring a task's output or a scorecard is FAIL or PENDING, when `tasks.mjs start` or `done` names the evaluation, or when adding an evaluation dimension or category.
metadata:
  title: Evaluating Outputs
  summary: Each task gets one category, whose predefined KPIs and thresholds are written into the plan before approval; the output is scored against them from measured runs with full results, human sign-offs are advisory, and done waits for a PASS.
---

# Evaluating Outputs

A task's output is judged against requirements fixed at planning time, not against whatever seems worth checking once the code exists. The task gets one **category**. The category maps every **dimension** to **KPIs** with thresholds, measurement methods and verifiers. Those are written into the plan, approved with it, measured on the built output, and scored.

- The **verdict** comes from the agent's measured KPIs. It is PASS when each one has a current record that meets its threshold.
- **Human sign-offs are advisory.** The user's Pass/Fail on `human` and `both` KPIs is listed on the scorecard and in the output of `done`, but it never changes the verdict.
- Only the **output** is evaluated. The model's reasoning is the process it goes through to produce the output, not a KPI.

## Dimensions

Defined in [`dimensions.json`](dimensions.json) and explained in [dimensions.md](dimensions.md):

| Dimension | Measures |
| --- | --- |
| `correctness` | outputs match the expected values, boundaries included |
| `consistency` | the same output across runs, in the project's existing shapes |
| `latency` | time to result at stated percentiles and load |
| `memory` | peak and steady memory; no growth across runs |
| `big-o` | claimed complexity, measured at 2+ input sizes |
| `failure-recovery` | behaviour when a dependency fails, and recovery |
| `exception-handling` | defined errors for bad input; nothing swallowed or leaked |
| `results` | the task's scenarios hold end to end |
| `task-kpis` | the category's own measures |

## Categories

One per task. A task is atomic: work that spans two categories, such as an endpoint plus its cache, is two tasks.

| Category | Guide |
| --- | --- |
| `api` | [categories/api.md](categories/api.md) |
| `db-query` | [categories/db-query.md](categories/db-query.md) |
| `calculation-engine` | [categories/calculation-engine.md](categories/calculation-engine.md) |
| `caching` | [categories/caching.md](categories/caching.md) |
| `background-job` | [categories/background-job.md](categories/background-job.md) |
| `ui-component` | [categories/ui-component.md](categories/ui-component.md) |
| `page` | [categories/page.md](categories/page.md) |
| `llm-feature` | [categories/llm-feature.md](categories/llm-feature.md) (with the `golden-set` and `deepeval` skills) |
| `general` | [categories/general.md](categories/general.md), when nothing else fits |

Each guide gives, per KPI, why it and its default threshold were chosen, the measurement command per stack, and the fields its results file must hold.

## Workflow

1. **Categorise, while writing the spec.** Run `node .claude/tools/evaluation.mjs suggest <spec.md>`, pick one category, and write `Category: <id>` under the spec's `## Evaluation`. Record the choice as an assumption in the spec's `## Assumptions` for the user to confirm. On the task board, set it on the note: `tasks.mjs add "<title>" --category <id>`, or edit the `Category:` line.
2. **Generate into the plan.** Run `node .claude/tools/evaluation.mjs plan <plan.md> --category <id>`. This writes the plan's `## Evaluation` section (the KPI table, `n/a` dimensions with reasons, and the registry version) and adds one `[eval:<kpi-id>]` case per KPI under `## Test Cases`.
   - Task-specific changes go above the generated part: `Override: <kpi-id> <op> <value> [unit] — <reason>` or `NA: <kpi-id> — <reason>`. Then rerun `plan`.
   - Every `Override:` and `NA:` line is an assumption: add it to the spec's `## Assumptions` and have the user confirm it.
   - Never edit between the markers; `check` detects it.
3. **Approve.** Run `node .claude/tools/evaluation.mjs check <plan.md> --category <id>`; it should print READY. Then run the spec quiz (`confirming-specs`), with at least one question on a threshold or verifier. The approval hash covers the Evaluation section, so a later threshold change needs approval again.
4. **Build, then measure each `agent` and `both` KPI** with the method in its category guide, on a production build at the stated size and load:

   ```sh
   node .claude/tools/evaluation.mjs record <task-id|plan.md> <kpi-id> <value> \
     --evidence "<the command or file it came from>" --details <results.json>
   ```

   `<value>` is the number compared with the threshold. `--details` is a JSON object with the run's full results. It must contain `tool`, `tool_version`, `environment` and `run_at`, plus the dimension's own fields (for example `load`, `count`, `p50`, `p95` and `p99` for latency); `record` names any that are missing.
5. **Ask the user** about each `human` and `both` KPI with AskUserQuestion (Pass / Fail, with Other for a note), then record their answer as given:

   ```sh
   node .claude/tools/evaluation.mjs sign <task-id|plan.md> <kpi-id> pass|fail --note "<their words>"
   ```

6. **Score.** `node .claude/tools/evaluation.mjs score <task-id|plan.md>` writes the scorecard: `context/tasks/evaluations/<id>.md` for a task (with the records in `<id>.json`, both committed), or `<plan>.eval.md` next to the plan. On the task board, `done` scores again and refuses unless the verdict is PASS; `review` reports anything else as a finding.

## Rules

- **Never estimate a value.** Every `record` comes from a run that just happened against the built output. If something cannot be measured here (no load-test tool, no browser), say so and leave the KPI waiting. Don't record a guess.
- **Never sign for the user.** `sign` records the user's own answer to the question you asked. It is not in the allow list, so the user sees each one.
- **Never move the goalposts.** Lowering a threshold, or marking a KPI `NA:`, to get a pass is a finding to report, not a fix. A changed threshold goes back through the user's confirmation and approval.
- **A plan edit makes records stale.** Records are tied to the plan's hash, so measure again after the plan changes.
- **FAIL means fix the output**, then record again. Rerunning until a number happens to pass is not a fix; report the spread.

## Extending

- **New category:** add it to `categories.json`, covering every active dimension with KPIs or `"na": "<reason>"`, and add `categories/<id>.md`.
- **New dimension:** add it to `dimensions.json` with the next registry `version`, document it in `dimensions.md`, and cover it in every category. Dimensions are never deleted or redefined; one is retired with `"status": "deprecated"`.

`npm run check` validates both in this repository. A project can add its own dimensions and categories, and change thresholds or mark KPIs `na`, in `.claude/evaluation.json`, using the same schema:

```json
{
  "thresholds": { "api.p95": { "op": "<=", "value": 120, "unit": "ms" } },
  "na": { "caching.memory-growth": "external Redis; the app holds no cache memory" },
  "dimensions": [],
  "categories": {}
}
```

Plans keep the registry version they were generated with, so a new dimension never blocks a task already approved; `check` notes it, and regenerating the plan brings it in.
