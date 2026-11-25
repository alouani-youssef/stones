# Category: general

The fallback for a task that fits no other category: a CLI, a library function, a script or a configuration change. Its KPIs are generic. Two things are expected of the plan:

1. Replace the placeholder targets for latency and memory with the task's own, using `Override:` lines the user confirms, or mark them `NA:` with a reason.
2. State the task's own KPIs as hand-written cases under `## Test Cases`. The `general.task-kpis-stated` KPI asks the user to confirm those are the right ones (advisory).

If a task keeps landing here with the same kind of KPIs, that is a new category: add it to `categories.json` with its own file.

## correctness

`general.case-failures == 0 cases`. Every test case in the plan runs and passes. Details: `cases` and `failures`.

## consistency

`general.repeat-divergence == 0 runs`. Run the main path 5 times on the same input; the outputs match, and they follow the project's existing formats. Details: `runs` and `divergent`.

## latency

`general.p95 <= 1000 ms`, a placeholder: set the real target with `Override:`. Use `hyperfine --export-json` for CLIs, or the language's benchmark tool for functions. Details: `load`, `count`, `p50`, `p95`, `p99`.

## memory

`general.peak-memory <= 512 MB`, a placeholder: set the real target with `Override:`. Measure with `/usr/bin/time -l` (macOS) or `-v` (Linux). Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`general.scaling <= 1.5 ratio`. Time the main operation at 10× and 100× the input, and compare with the claimed complexity. Details: `sizes`, `timings`, `claimed`.

## failure-recovery

`general.fault-failures == 0 failures`. Make each dependency (file system, network, subprocess) fail, then restore it. The behaviour matches the design. Details: `faults_injected` and `recovered`.

## exception-handling

`general.undefined-errors == 0 errors`. Send invalid inputs and force internal errors; each produces the defined error and exit code. Details: `inputs` and `undefined_errors`.

## results

`general.scenarios-failing == 0 scenarios`, checked by both. Every task scenario holds end to end. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

`general.task-kpis-stated`, signed by the human: the plan lists this task's own KPIs as cases, and the reviewer agrees they measure what matters.
