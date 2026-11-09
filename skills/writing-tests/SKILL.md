---
name: writing-tests
description: Use when writing, planning or reviewing unit, integration or end-to-end tests, choosing a test level, designing code for testability, running tests before handoff, or when the testing hook blocks a test command or a test/spec/snapshot edit.
metadata:
  title: Testing Guide
  summary: Choosing tests by risk and responsibility, designing for testability, and keeping the active task's scenarios current.
---

# Testing Guide

Tests are evidence that software meets its contract and keeps meeting it. Pick tests by risk and responsibility, use the fastest reliable feedback for each behavior, and keep a few checks through the whole system. Decide how critical behavior will be tested while shaping the feature, not after it is coupled.

## Active task scenarios (testing hook)

Keep the current task's note complete: the file in `context/tasks/list/` that `context/tasks/state/current.md` links to (see the tracking-tasks skill; projects without the task board use `context/tasks/active.md`). Before running tests, fill in:

- **Expected behavior:** what the task should provide.
- **Scenarios:** at least one `- Scenario: <condition or input>. Expected: <observable outcome>.` Add boundaries and failure paths.
- **Contract change:** `none` when existing behavior is still correct, or `behavior changed: <reason>` when the requirement changed.

The hook blocks test commands until these are filled. While the contract is `none`, it blocks edits to tests, specs, OpenSpec specifications and snapshots: **a failing test means fix the source, not the test.** Only when expected behavior truly changed, record why in **Contract change** before editing those files.

## Choosing the level

| Level | Question | Scope | Dependencies | Guide |
| --- | --- | --- | --- | --- |
| Unit | Does this rule behave correctly alone? | Function, class, small module | In-memory or controlled fakes | [unit.md](unit.md) |
| Integration | Do components work across a real boundary? | App + database, queue, filesystem, provider adapter | Real local/test dependency | [integration.md](integration.md) |
| End-to-end | Can a user complete a critical flow? | User-visible path through the running system | Full stack, controlled data | [end-to-end.md](end-to-end.md) |

- Detailed business rules at unit level when they need no infrastructure.
- Integration tests where configuration, serialization, transactions, queries or framework behavior can fail.
- A small set of E2E tests for high-value journeys and cross-layer wiring.
- Each level adds distinct evidence; do not test the same detail at every level.
- Classify a test by what it exercises, not its filename. A "unit" test that starts a database is not isolated; a route test with every collaborator stubbed does not prove the database integration.

Planning a strategy for a feature (risk mapping, decision tables, plan template): [planning.md](planning.md).

## Design for testability

- **Separate policy from mechanism.** Test domain decisions directly; test adapters at their boundaries.
- **Make effects visible.** Pass collaborators in or keep effects behind a narrow adapter; no hidden global clients.
- **Control nondeterminism.** Seams for time, randomness, IDs and scheduling. Production uses real ones; tests supply fixed ones.
- **Expose outcomes.** Return results or errors and persist through explicit interfaces, not private state or logs.
- **Define invariants and failure behavior** after invalid input, timeout, retry or partial failure.
- **Make state reproducible.** Explicit setup, isolated resources, reliable cleanup.

Add seams only at real sources of variation or effects. A pure function needs no abstraction.

```ts
interface Clock { now(): Date }

function isExpired(expiresAt: Date, clock: Clock): boolean {
  return clock.now().getTime() >= expiresAt.getTime();
}

const fixedClock: Clock = { now: () => new Date("2030-01-01T00:00:00Z") };
```

Tests cover before, at and after expiration without sleeping. If the codebase already has fake timers, use them instead.

## Test quality

Clear name, only necessary setup, one behavior, meaningful assertions. Deterministic, isolated, repeatable. Assert public results, persisted state or important side effects; avoid broad snapshots and implementation-detail assertions. Cover success and failure paths and requirement-driven boundaries. Test authorization at the boundary that enforces it. Use non-sensitive data and clean up.

## Running and reporting

- The repository's documented commands and CI config are the source of truth.
- Run the narrowest relevant test while working; run the required checks for the affected area before handoff.
- Report exactly what ran and what did not. "Generated", "executed" and "passed" are different claims; never claim a test passed that did not run.
- A local pass is evidence for that test in that environment only.

For the Red-Green-Refactor loop, see the `test-first-development` skill.
