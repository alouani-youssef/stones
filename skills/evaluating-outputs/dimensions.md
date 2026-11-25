# Evaluation dimensions

Every task output is judged on the same dimensions. They are defined in `dimensions.json`, which is the registry the tool reads; this file explains each one. A category in `categories.json` covers every active dimension, either with KPIs or with `na` and a reason.

Common rules for every dimension:

- **Evidence is a run, never a reading.** A value comes from a command that ran against the built output: a test run, a benchmark, a profiler, a load test, a query plan. Reading the code and estimating is not evidence. If something cannot be measured, say so and leave the KPI waiting.
- **Every measured value comes with its results.** `record` takes the value compared with the threshold, `--evidence` (the command or file), and `--details` (a JSON file with the fields listed below). Every measured dimension requires `tool`, `tool_version`, `environment` and `run_at` in that file, plus its own fields.
- **Measure what will ship.** Use a production build and production settings, and the input sizes and load the plan states, not a debug build on a toy input.
- **Human sign-offs are advisory.** A KPI whose verifier is `human` or `both` gets the user's own Pass/Fail through `sign`. The scorecard lists those answers, but the verdict comes from the agent's measured KPIs.

The model's reasoning, the process it goes through to produce the output, is not a dimension. Only the output is evaluated.

| Order | Id | Evidence | Default verifier | Extra `details` fields |
| --- | --- | --- | --- | --- |
| 10 | `correctness` | measured: `diffs`, `cases` | agent | `cases`, `failures` |
| 20 | `consistency` | measured: `runs`, `violations` | agent | `runs`, `divergent` |
| 30 | `latency` | measured: `ms`, `s` | agent | `load`, `count`, `p50`, `p95`, `p99` |
| 40 | `memory` | measured: `MB`, `%` | agent | `input_size`, `runs`, `peak_mb`, `steady_mb` |
| 50 | `big-o` | measured: `ratio` | both | `sizes`, `timings`, `claimed` |
| 60 | `failure-recovery` | measured: `failures`, `writes` | agent | `faults_injected`, `recovered` |
| 70 | `exception-handling` | measured: `errors`, `leaks` | agent | `inputs`, `undefined_errors` |
| 90 | `results` | measured: `scenarios` | both | `scenarios`, `failing` |
| 100 | `task-kpis` | per KPI (`any`) | per KPI | per KPI |

## correctness

**Definition:** outputs match the expected values for valid inputs, including boundaries.
**Question:** does the output equal what it should for every input in the cases, boundaries included?

- **Evidence:** a test run over the plan's cases plus boundary inputs (empty, one, maximum, just past a limit), comparing actual with expected. The value is the number of mismatches, usually with threshold `== 0 diffs`.
- **Not evidence:** "the tests pass" without saying which cases ran, or a single happy-path case.
- **Details:** `cases` (how many ran) and `failures` (the ids of the failing ones, or `[]`).

## consistency

**Definition:** the same input gives the same output across repeated runs, and the output follows the project's existing contracts (formats, error shapes, naming).
**Question:** run it again, or next to the code around it: does it give the same answer, in the same shape?

- **Evidence:** the same inputs run N times (N stated, at least 5), counting outputs that differ. Plus a contract check against existing examples: the response schema, the error body shape, date and number formats, and naming. The value is the number of divergent runs or contract violations.
- **Not evidence:** a single run, or "it follows the style".
- **Details:** `runs` and `divergent` (with the differing outputs when there are any).

## latency

**Definition:** time to result at stated percentiles under a stated load.
**Question:** how long does the output take to produce, under the load it will see?

- **Evidence:** a benchmark or load test with warm-up, at the load the plan states. Report percentiles, not a mean. The value is the percentile the KPI names, in `ms` or `s`.
- **Tools:**
  - HTTP: `autocannon`, `k6`, `wrk`, `hey`.
  - In-process: `node --test` with `performance.now()` over many iterations, `pytest-benchmark`, `go test -bench`, `hyperfine` for CLIs.
- **Not evidence:** one timed request, or a run on a cold, debug build.
- **Details:** `load` (for example "50 connections, 30 s" or "10 000 iterations"), `count` (samples), and `p50`, `p95` and `p99`. Add `samples` when they are small enough to keep.

## memory

**Definition:** peak and steady-state memory for a stated input size, with no growth across repeated runs.
**Question:** how much memory does it need at the stated size, and does that stay flat when it runs again and again?

- **Evidence:** peak resident or heap memory at the stated input size, plus the change over many repeated runs, to find leaks. The value is peak memory in `MB`, or growth in `%`.
- **Tools:** `process.memoryUsage()` and `--expose-gc` in Node, `/usr/bin/time -l` (macOS) or `-v` (Linux), `tracemalloc` or `memray` in Python, `go test -benchmem` or `pprof`.
- **Details:** `input_size`, `runs`, `peak_mb` and `steady_mb`.

## big-o

**Definition:** the stated time and space complexity, backed by measurements at two or more input sizes.
**Question:** when the input grows, does the cost grow the way the plan says it does?

- **Evidence:** the claimed complexity written in the plan (for example `O(n log n)`), and timings at two or more input sizes at least 10× apart. The value is the measured growth ratio divided by the ratio the claim predicts; about 1 means the claim holds. The human signs whether the claim is reasonable for the job (advisory).
- **Not evidence:** a complexity stated from reading the code alone. The `managing-complexity` skill covers the reasoning; this dimension needs the measurement.
- **Details:** `sizes` (for example `[1000, 10000, 100000]`), `timings` (same order, with units in the key or the value) and `claimed`.

## failure-recovery

**Definition:** behaviour when a dependency is down, slow or returns errors: retries, fallbacks, no partial writes, and recovery once it is back.
**Question:** when something it depends on fails, does it degrade as designed and come back cleanly?

- **Evidence:** faults injected one at a time: the dependency is down, it times out, it returns a 5xx or 429, or the connection drops mid-write. Check the behaviour against the design, then restore the dependency and confirm recovery. The value is the number of failed recoveries or partial writes.
- **Tools:** stand-in services (the Postman `api-simulation` skill), toxiproxy, killing the container, test doubles that throw.
- **Details:** `faults_injected` (the list) and `recovered` (count or per-fault result).

## exception-handling

**Definition:** invalid input and internal errors produce defined errors; nothing is swallowed, and no stack trace or secret leaks.
**Question:** when given bad input or hitting an internal error, does it fail in the defined way and only that way?

- **Evidence:** a run over invalid inputs (wrong type, missing field, out of range, oversized, malformed encoding) and forced internal errors. Count the responses that are not the defined error, and any stack trace, internal path or secret in the output or logs. The value is the number of undefined errors or leaks.
- **Details:** `inputs` (how many or which) and `undefined_errors`.

## results

**Definition:** the task's expected behaviour and scenarios hold end to end in the real app.
**Question:** used for real, end to end, does it do what the task promised?

- **Evidence:** every scenario in the task note run against the running app (or the built library, in its consumer), not a unit test. The value is the number of failing scenarios. The human also signs whether the outcome is what they wanted (advisory).
- **Details:** `scenarios` (how many ran) and `failing` (their names, or `[]`).

## task-kpis

**Definition:** the category's own KPIs: hit ratio, query plan, numeric precision, accessibility and the like.
**Question:** does it meet the measures that matter for this kind of work in particular?

Each KPI under this dimension sets its own `evidence` (`measured` or `signed`) and any unit; its category file explains how to measure it.

## Extending the registry

To add a dimension (for example `security` or `cost`):

1. Add an entry to `dimensions.json` with a new `id`, an `order` between existing ones, and `since` set to the next registry `version`. Then bump `version`.
2. Add its section to this file: the definition, what counts as evidence, and measurement guidance.
3. Cover it in every category, with KPIs or with `"na": "<reason>"`. `npm run check` fails until every category does, naming each gap.

Projects can add their own dimensions in `.claude/evaluation.json` under `dimensions`, with the same schema. Project ids must not clash with registry ids. A project dimension must be covered by every category the project uses. The registry's own dimensions cannot be removed or redefined by a project, only marked `na` per KPI with a reason.

Removing a dimension means setting `"status": "deprecated"`; entries are never deleted. That way, old plans and scorecards that mention it still resolve. A change to the meaning of an existing dimension is not allowed: add a new dimension and deprecate the old one.

## Compatibility

- `plan` writes `Dimensions: v<version> (sha <hash>)` into the plan's Evaluation section, so a plan states the dimension set it was built and approved against.
- Adding a dimension does not invalidate approved plans. `check` and `score` hold a plan to the registry version it records, so tasks already in progress are not blocked by a dimension added after their approval. `check` reports that a newer registry exists, and regenerating the plan brings in the new dimension and needs approval again.
- A recorded KPI whose dimension is deprecated still scores. A plan generated after the deprecation no longer includes it.
