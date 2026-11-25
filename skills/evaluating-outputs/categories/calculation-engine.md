# Category: calculation-engine

Code whose output is a computed number: pricing, tax, interest, scoring, allocation, unit conversion or statistics. KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

Placeholders: `{{size}}` = 10 000 inputs; `{{tolerance}}` = 1e-9 relative. For money, the tolerance is zero: use exact decimal or integer minor units, and set an `Override:`.

## correctness

`calculation-engine.reference-diffs == 0 diffs`. Build a reference set of inputs with known results: from the business (worked examples, a spreadsheet the domain owner signed), a trusted independent implementation, or published tables. Run the engine over it and count results outside `{{tolerance}}`. Details: `cases` and `failures` (input id, expected, actual).

## consistency

`calculation-engine.nondeterministic-runs == 0 runs`. Run the same `{{size}}` 10 times, shuffling input order where order must not matter. Any differing output is a failure; floating-point summation order is the usual cause. Details: `runs` and `divergent`.

## latency

`calculation-engine.p95 <= 10 ms` per calculation over `{{size}}`, using `performance.now()` loops, pytest-benchmark, `go test -bench` or JMH. Details: `load` (inputs and iterations), `count`, `p50`, `p95`, `p99`.

## memory

`calculation-engine.peak-memory <= 200 MB` over `{{size}}`, measured with `/usr/bin/time -l` (macOS) or `-v` (Linux), `process.memoryUsage()`, or `memray`. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`calculation-engine.scaling <= 1.3 ratio`. Write the claimed complexity in the plan, time the engine at 10× and 100× the inputs, and divide the measured growth by the claimed growth. Calculation engines are where an accidental O(n²) hides, so the threshold is tighter. The human signs whether the claim fits (advisory). Details: `sizes`, `timings`, `claimed`.

## failure-recovery

`calculation-engine.failed-recoveries == 0 failures`. Make each external input missing or stale in turn: rate tables, configuration, reference data. The engine uses the designed fallback or raises the designed error, and never returns a partial or silently stale result. Details: `faults_injected` and `recovered`.

## exception-handling

`calculation-engine.undefined-errors == 0 errors`. Feed zero divisors, overflowing values, NaN, Infinity, negative values where invalid, and empty input. Each gives the defined error or the defined result. Details: `inputs` and `undefined_errors`.

## results

`calculation-engine.scenarios-failing == 0 scenarios`, checked by both. Run every task scenario through the engine's real caller (the invoice, the quote, the report), not the engine in isolation. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `calculation-engine.precision-violations == 0 values`: send half-way values (x.5), negative values, very small and very large values through every rounding point. Each follows the stated rule (half-even, half-up, truncate) at the stated step.
- `calculation-engine.non-finite-outputs == 0 values`: no NaN or Infinity in the outputs for `{{size}}` valid inputs.
- `calculation-engine.rounding-rule`, signed by the human: show the rounding and precision rule with three worked examples, and the reviewer confirms they match the business rule (advisory).
