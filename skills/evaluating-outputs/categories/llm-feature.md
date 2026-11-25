# Category: llm-feature

A feature whose output comes from a language model: a prompt, chain, RAG pipeline or agent. This category does not redefine LLM evaluation. Its cases and graders come from the project's golden set (`golden-set` skill), and its metrics come from DeepEval or the project's own graders (`deepeval` skill). KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

Placeholders: `{{golden}}` = the versioned golden set; `{{runs}}` = 5.

## correctness

`llm-feature.deterministic-failures == 0 cases`. Run the golden set through the feature's real entry point with code graders only: output schema, exact labels, a required citation present, and the expected tool called. These are the checks a model must never fail. Details: `cases` and `failures` (case ids).

## consistency

`llm-feature.repeat-divergence <= 1 runs`. Run a sample of golden cases `{{runs}}` times with the production model, prompt and temperature. Count cases whose graded outcome (pass or fail, label, tool choice) changes between runs. Details: `runs` and `divergent`.

## latency

`llm-feature.p95 <= 5 s`, end to end per request, including retrieval and tool calls, through the real entry point. Details: `load`, `count`, `p50`, `p95`, `p99`; add token counts to the details when they are available.

## memory

Not applicable: the model runs out of process. The app's own memory is covered by the `api` or `background-job` task that hosts the feature.

## big-o

Not applicable: cost grows with tokens and tool calls, which latency and the task KPIs measure.

## failure-recovery

`llm-feature.provider-failures == 0 failures`. Make the model provider return 429 and 500, and time out (stub the HTTP client, or use the Postman `api-simulation` skill). The feature retries with backoff or falls back as designed, and tells the user when it cannot answer. Details: `faults_injected` and `recovered`.

## exception-handling

- `llm-feature.malformed-output-errors == 0 errors`: feed the parser truncated, invalid-JSON and off-schema model outputs. Each is caught and handled (retry, repair or a defined error).
- `llm-feature.leaks == 0 leaks`: run the prompt-injection cases in the golden set. The system prompt, secrets and other users' data never appear in the output.

Details: `inputs` and `undefined_errors`.

## results

`llm-feature.scenarios-failing == 0 scenarios`, checked by both. Run every task scenario through the feature's real entry point. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `llm-feature.golden-pass-rate >= 0.9 ratio`: the share of golden cases graded pass, by code graders first and a calibrated judge (`GEval` with written steps and a pinned judge model) only for what code cannot check. Record the judge model and version in the details.
- `llm-feature.tool-correctness >= 0.95 ratio`: DeepEval `ToolCorrectnessMetric`, or an equivalent code check, on the cases with `expected_tools`.
- `llm-feature.negative-case-failures == 0 cases`: the negative cases (should refuse, should not search, should escalate) where the feature acted anyway.

Set thresholds from a baseline run of the current version, not from a guess: a new version must not score below the old one.
