# Category: caching

A cache in front of a slower source: an in-process LRU, Redis or Memcached, an HTTP cache or memoization. KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

Placeholders: `{{load}}` = 50 concurrent connections for 30 s; `{{concurrency}}` = 100 concurrent requests.

## correctness

`caching.read-matches-source == 0 diffs`. Read every key through the cache and directly from the source, and compare. Include keys with empty values, NULL and not-found results (negative caching). Details: `cases` and `failures`.

## consistency

`caching.hit-miss-divergence == 0 runs`. Read each key on a miss, then on a hit. The values and their shape (types, dates, ordering, key casing) must be identical; serialization round trips are the usual cause. Details: `runs` and `divergent`.

## latency

- `caching.hit-latency-p95 <= 5 ms`: a warm key under `{{load}}`.
- `caching.miss-overhead-p95 <= 2 ms`: cold keys under `{{load}}`, compared with the same call with the cache disabled. The value is the added p95.

Run autocannon or k6 against the route, or a `performance.now()` loop, with the cache server on the same network as production would have it. Details: `load`, `count`, `p50`, `p95`, `p99`.

## memory

`caching.memory-growth <= 5 %` above the configured bound. Fill an in-process cache to 10× its capacity, and check that memory stays at its bound (eviction works). For an external cache, mark it `NA:` with the reason, or measure the server's `used_memory` against `maxmemory`. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`caching.lookup-scaling <= 1.2 ratio`. Lookups should be O(1) in the number of keys. Time them with 10× and 100× the keys; the value is the measured growth ÷ the claimed growth. The human signs whether the claim fits (advisory). Details: `sizes`, `timings`, `claimed`.

## failure-recovery

`caching.cache-down-errors == 0 failures`. Stop the cache under load (`docker stop redis`, or toxiproxy), then restart it. While it is down, requests fall through to the source without errors, within the designed timeout. Once it is back, hits resume without a restart of the app. Details: `faults_injected` and `recovered`.

## exception-handling

`caching.undefined-errors == 0 errors`. Cache values that cannot be serialized (cycles, functions, BigInt in JSON) and values above the size limit. Each is skipped, logged or rejected as designed, never a 500 for the caller. Details: `inputs` and `undefined_errors`.

## results

`caching.scenarios-failing == 0 scenarios`, checked by both. Run every task scenario with the cache enabled, including the write-then-read ones. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `caching.hit-ratio >= 0.9 ratio`: replay a recorded or production-like workload after warm-up, then hits ÷ (hits + misses). Use Redis `INFO stats` (`keyspace_hits` and `keyspace_misses`) or the cache's own counters.
- `caching.stale-after-write == 0 reads`: write each key, then read it immediately from every app instance. With write-through or invalidation, nothing is stale; with a TTL-only design, the plan states the accepted staleness as an `Override:`.
- `caching.stampede-loads <= 1 loads`: `{{concurrency}}` miss the same cold key at once. The source is loaded once (single-flight, a lock, or request coalescing).
- `caching.ttl-violations == 0 reads`: read keys just before and just after their TTL; nothing is served after expiry.
