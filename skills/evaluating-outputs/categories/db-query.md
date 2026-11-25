# Category: db-query

A database query, a schema change or migration, or the data-access code around them. KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

Placeholder: `{{rows}}` = 1 000 000 rows. Use the table sizes production will have, from real data or a generator.

## correctness

`db-query.result-diffs == 0 diffs`. Run the query on a fixture dataset with known answers, including empty sets, NULLs, ties in `ORDER BY`, time zones and boundaries. Compare the rows with the reference (`EXCEPT` both ways in SQL, or a sorted diff in the test). Details: `cases` and `failures`.

## consistency

`db-query.repeat-divergence == 0 runs`. Run the query 5 times on one snapshot (in a `REPEATABLE READ` transaction, or a restored dump). Rows and order must match; a differing order means the `ORDER BY` is not total. Details: `runs` and `divergent`.

## latency

`db-query.p95 <= 50 ms` on `{{rows}}`. Run the query repeatedly with representative parameters, with the cache warm and then cold. Report percentiles.

- PostgreSQL: `pgbench -f query.sql -T 30 -r`, or `EXPLAIN (ANALYZE, BUFFERS)` timings over 100 runs.
- MySQL: `mysqlslap`.
- Python: pytest-benchmark around the repository call.

Details: `load`, `count`, `p50`, `p95`, `p99`.

## memory

`db-query.result-memory <= 100 MB` for the caller reading the full result from `{{rows}}`. This catches loading everything into memory where streaming or a cursor was needed. Measure the caller's peak memory with `/usr/bin/time -l` (macOS) or `-v` (Linux), `process.memoryUsage()`, or `tracemalloc`. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`db-query.scaling <= 1.5 ratio`. Write the claimed growth in the plan (for example O(log n) with the index, or O(k) in rows returned). Time the query at 10× and 100× the rows. The value is the measured growth ÷ the claimed growth. The human signs whether the claim fits (advisory). Details: `sizes`, `timings`, `claimed`.

## failure-recovery

- `db-query.failed-recoveries == 0 failures`: kill the connection inside each transaction (`pg_terminate_backend`, or stop the container), then restore it. The transaction rolls back, and the caller's retry succeeds or fails as designed.
- `db-query.partial-writes == 0 writes`: make a statement fail halfway through a multi-statement write. No rows from that transaction remain.

Details: `faults_injected` and `recovered`.

## exception-handling

- `db-query.undefined-errors == 0 errors`: violate unique, foreign key, not-null and check constraints, and send wrong types. Each maps to a defined application error, not a raw driver error.
- `db-query.leaks == 0 leaks`: the errors and logs contain no SQL text with values, no connection string and no credentials.

Details: `inputs` and `undefined_errors`.

## results

`db-query.scenarios-failing == 0 scenarios`, checked by both. Run every task scenario against a freshly migrated database through the application's own code path. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `db-query.seq-scans == 0 scans`: in `EXPLAIN (ANALYZE, BUFFERS)` on `{{rows}}` (MySQL: `EXPLAIN ANALYZE`; SQLite: `EXPLAIN QUERY PLAN`), no sequential scan on a large table. Attach the plan text in the details.
- `db-query.scan-ratio <= 10 ratio`: rows scanned (`Rows Removed by Filter` + returned, or `rows_examined`) ÷ rows returned.
- `db-query.n-plus-one == 0 queries`: load a page of 50 items with their relations, and count the extra queries per item (query log or ORM debug logging).
- `db-query.isolation-anomalies == 0 anomalies`: 20 concurrent writers update overlapping rows. No lost update and no phantom read beyond what the isolation level allows.
- `db-query.migration-rollback-failures == 0 failures`: on seeded data, apply each new migration, roll it back and apply it again. Nothing fails and no data is lost.
