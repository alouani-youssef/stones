# Category: api

An HTTP API endpoint: a new or changed route, handler, or GraphQL resolver. KPIs and thresholds live in `../categories.json`; this file says why they were chosen and how to measure each one. Defaults are starting points. Change them per project in `.claude/evaluation.json`, or per task with an `Override:` line the user confirms.

Placeholders: `{{load}}` = 50 concurrent connections for 30 s; `{{soak}}` = 10 000 requests.

## correctness

`api.contract-mismatches == 0 diffs`. The contract (OpenAPI spec, Postman collection or schema) is the expected value. Run the contract tests against the running service: `postman collection run`, `schemathesis run`, `dredd`, or the project's own integration tests. Count responses whose status, headers or body schema differ. Details: `cases` (requests sent) and `failures` (the failing request names).

## consistency

- `api.error-shape-violations == 0 violations`: every error body follows the shape the project already uses (for example `{ "error": { "code", "message" } }` or RFC 9457 problem details). Trigger each documented error once and validate the body against the existing shape.
- `api.repeat-divergence == 0 runs`: the same GET with the same state returns the same body 5 times (ignore fields documented as volatile, such as timestamps or request ids).

Details: `runs` and `divergent`.

## latency

`api.p95 <= 200 ms` and `api.p99 <= 500 ms` at `{{load}}`, on a production build with production-like data. These defaults follow common interactive-API targets; set real ones from the service's SLO when it has one.

- Node: `npx autocannon -c 50 -d 30 --json <url> > results.json`. Map `latency.p50`, `p97_5` or `p99`; autocannon has no p95, so use k6 when the KPI needs it.
- Any stack: `k6 run --summary-export results.json script.js` (`http_req_duration` p(95), p(99)), or `hey -z 30s -c 50 <url>`.
- Warm up first; report the load and sample count.

Details: `load`, `count`, `p50`, `p95`, `p99`.

## memory

`api.heap-growth <= 10 %` after `{{soak}}`. Sample memory after warm-up and after the soak: `process.memoryUsage().heapUsed` with `--expose-gc` and a forced GC before each sample (Node), `tracemalloc` snapshots (Python), or `runtime.ReadMemStats` and pprof (Go). Growth = (after − before) / before × 100. Details: `input_size` (requests), `runs`, `peak_mb`, `steady_mb`.

## big-o

`api.list-scaling <= 1.5 ratio`. For the slowest collection route, write the claimed complexity in the plan (for example O(n) in stored items, or O(page) with an index). Time it at 10× and 100× the stored items. The value is the measured growth ÷ the claimed growth. The human signs whether the claim fits (advisory). Details: `sizes`, `timings`, `claimed`.

## failure-recovery

- `api.dependency-failures == 0 failures`: make each downstream dependency time out, return a 5xx and refuse connections, one at a time. The route answers with the designed status (usually 503 or 504, with `Retry-After` where designed) within its timeout, and serves normally once the dependency is back. Tools: the Postman `api-simulation` skill, toxiproxy, `docker stop`.
- `api.partial-writes == 0 writes`: drop the connection or kill the dependency in the middle of each write route, then check the stored state. Nothing is half-written.

Details: `faults_injected` and `recovered`.

## exception-handling

- `api.undefined-errors == 0 errors`: send wrong types, missing fields, unknown fields where strict, oversized bodies and malformed JSON. Each gets the defined 4xx with the error shape. A 500 is an undefined error.
- `api.leaks == 0 leaks`: force internal errors and grep responses and logs for stack traces, file paths, SQL, tokens and environment values.

Details: `inputs` and `undefined_errors`.

## results

`api.scenarios-failing == 0 scenarios`, checked by both. Run every scenario from the task note against the running service, using real HTTP requests, not handler unit tests. The user then signs that the behaviour is what they wanted (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `api.unprotected-routes == 0 routes`: call every new or changed route without credentials, with expired credentials and with a role that should be refused. Any 2xx is a failure.
- `api.duplicate-writes == 0 duplicates`: send each write twice with the same idempotency key (or the same natural key) and count the side effects.
- `api.pagination-drift == 0 items`: page through a list to the end while inserting items, and count missed or repeated ids (cursor pagination should give zero).

Each needs `tool`, `tool_version`, `environment` and `run_at` in `--details`, plus the counts.
