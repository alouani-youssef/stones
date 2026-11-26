# Spec check: Evaluating Outputs Design

Spec: docs/design/2026-11-25-evaluating-outputs-design.md
Plan: docs/design/plans/2026-11-25-evaluating-outputs.md
Approved: 2026-11-25 · 3/4 matched the spec, 1 resolved · sha256:5a5e0d1fc474358d

## A `security` dimension is added to the registry while task 0007 is in progress with an approved plan. What happens to 0007?

- A. `start` and `done` block 0007 until its plan covers `security`
- B. 0007 keeps its approved dimensions; `check` notes a newer registry, and only a regenerated, re-approved plan adds `security`
- C. `security` is added to 0007's plan automatically and needs no new approval
- D. The registry refuses the new dimension until every in-progress task is done

Expected: B
Answer: B

## All agent KPIs of a caching task pass, but you have not signed the end-to-end results check yet. What does `tasks.mjs done` do?

- A. Finishes the task and lists the unsigned check in the PR draft
- B. Finishes the task, because a human check is advisory
- C. Refuses: the scorecard is PENDING, the task stays current, and the waiting KPI is listed
- D. Asks the agent to sign the check on your behalf, then finishes

Expected: C
Answer: B
Resolution: spec updated: human sign-offs are advisory; the verdict and the done gate use only agent-measured KPIs, and done lists waiting or failed human checks. Also from this question: reasoning is the model's process, not a KPI, so the reasoning dimension was removed (A5 denied)

## The agent records p95 latency = 3.8 ms for a measured KPI. What must come with it for `record` to accept it?

- A. Nothing else; the value is compared with the threshold
- B. A one-line note describing how it was measured
- C. Evidence (the command or file) and a details JSON with the dimension's fields: tool and version, environment, run time, load, sample count, p50/p95/p99
- D. A screenshot of the load-test output

Expected: C
Answer: C

## A feature needs a new API endpoint and a Redis cache in front of it. How is it planned?

- A. One task with `--category api --category caching`; their KPIs are combined
- B. One task with category `api`; caching KPIs are added by hand
- C. One task with category `general`, which covers both
- D. Two tasks, one with category `api` and one with `caching`, each with its own evaluation

Expected: D
Answer: D
