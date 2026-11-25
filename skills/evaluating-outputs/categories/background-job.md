# Category: background-job

Work that runs outside a request: queue consumers, scheduled jobs, workers and event handlers (BullMQ, Celery, Sidekiq, SQS, Kafka, cron). KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

Placeholder: `{{batch}}` = 10 000 jobs.

## correctness

`background-job.output-diffs == 0 diffs`. Process a batch of jobs with known outcomes, then compare the end state (rows, files, sent messages captured by a stand-in) with what is expected. Details: `cases` and `failures`.

## consistency

`background-job.rerun-divergence == 0 runs`. Run a sample of jobs twice on the same input. The end state is the same: jobs are deterministic and safe to re-run. Details: `runs` and `divergent`.

## latency

`background-job.p95-end-to-end <= 5 s`, from enqueue to done, with `{{batch}}` enqueued at the expected production rate. Record the enqueue and completion timestamps per job, and compute the percentiles. Details: `load` (rate and batch), `count`, `p50`, `p95`, `p99`.

## memory

`background-job.worker-growth <= 10 %`. Sample one worker's memory after warm-up and after `{{batch}}`. Growth means a leak per job. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`background-job.batch-scaling <= 1.5 ratio`. Time batches of 10× and 100× the jobs; the value is the measured growth ÷ the claimed growth (usually linear). The human signs whether the claim fits (advisory). Details: `sizes`, `timings`, `claimed`.

## failure-recovery

- `background-job.lost-messages == 0 failures`: kill workers (`SIGKILL`) in the middle of jobs, then restart them. Every job is completed or retried; none is lost or acknowledged unfinished.
- `background-job.partial-writes == 0 writes`: make a dependency fail halfway through each job type. No half-applied side effects remain (use a transaction, an outbox, or compensation).

Details: `faults_injected` and `recovered`.

## exception-handling

`background-job.unhandled-errors == 0 errors`. Enqueue malformed and unprocessable messages. Each ends in the dead-letter queue (or the designed failure state) after its retries, and the worker keeps processing other jobs, without a crash loop. Details: `inputs` and `undefined_errors`.

## results

`background-job.scenarios-failing == 0 scenarios`, checked by both. Run every task scenario through the real queue and workers, not by calling the handler directly. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `background-job.duplicate-side-effects == 0 effects`: deliver each message type twice (at-least-once delivery). Side effects such as emails, charges and rows are applied once.
- `background-job.throughput >= 100 jobs/s`: jobs completed per second by one worker over `{{batch}}`. Set the real number from the expected peak rate and worker count.
- `background-job.retries-without-backoff == 0 retries`: a dependency fails on every attempt. Retries follow the configured backoff schedule; compare the timestamps.
- `background-job.poison-redeliveries <= 3 deliveries`: a message that always fails is delivered at most the configured number of times, then dead-lettered.
