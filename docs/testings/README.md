# Testing Guide

Testing provides evidence that software meets its contract and continues to do so as it changes. A useful strategy selects tests by risk and responsibility, uses the fastest reliable feedback for each behavior, and includes a small number of checks through the complete system.

Testing is part of design. A system that exposes clear boundaries, controls side effects, and makes important state observable is easier to verify and safer to change. Decide how critical behavior will be tested while shaping the feature, rather than adding test seams after implementation has become tightly coupled.

## Active task scenarios

When the testing hook is installed, keep `context/tasks/active.md` current for the task being worked on. Before running tests, fill in:

- **Expected behavior:** the source behavior the task should provide.
- **Scenarios:** at least one bullet in the form `- Scenario: <condition or input>. Expected: <observable outcome>.` Add cases for relevant boundaries and failure paths.
- **Contract change:** write `none` when existing behavior is still correct, or `behavior changed: <reason>` when the requirement or expected behavior has changed.

The hook blocks test commands until these sections are complete. It blocks edits to test and spec files, OpenSpec specifications, and snapshots while the contract is unchanged, directing fixes toward the source. If expected behavior changes, record why in **Contract change** before updating those files. The hook checks that the rationale is present; review is still needed to decide whether it is valid.

## Design for testability

Testability is a design quality: how easily a system can be placed into a known state, stimulated with a relevant input, and observed for the expected result. Design decisions should make those three steps explicit.

- **Separate policy from mechanism.** Keep domain decisions distinct from database, network, clock, filesystem, and framework details. Test policy directly; test adapters and wiring at their boundaries.
- **Make effects visible.** Pass required collaborators into a component or keep effectful work behind a narrow adapter. Avoid hidden global clients and service-locator lookups that make dependencies and setup unpredictable.
- **Control nondeterminism.** Provide a seam for time, randomness, identifiers, and scheduling when behavior depends on them. Production uses real implementations; tests can supply fixed ones.
- **Expose meaningful outcomes.** Return results or errors and persist state through explicit interfaces. Avoid behavior that can only be inferred from private mutable state or incidental logs.
- **Define invariants and failure behavior.** Specify what must remain true after invalid input, timeout, retry, or partial failure, then design transaction and idempotency boundaries accordingly.
- **Make state reproducible.** Use explicit data setup, isolated resources, and reliable cleanup. Important workflows should not depend on execution order or developer-local state.

These are design goals, not a mandate to add an interface or injection framework around every function. Add seams at genuine sources of variation or effects. Prefer a simple pure function over an abstraction when there is no dependency to replace.

### Example: controlling time

Avoid embedding the system clock in business decisions when the exact boundary matters:

```ts
interface Clock {
  now(): Date;
}

function isExpired(expiresAt: Date, clock: Clock): boolean {
  return clock.now().getTime() >= expiresAt.getTime();
}

const fixedClock: Clock = { now: () => new Date("2030-01-01T00:00:00Z") };
```

The test can verify the instant before, at, and after expiration without sleeping or depending on the machine clock. If the codebase already has a supported fake-timer facility, use it instead of introducing a new clock abstraction solely for one test.

## Test levels

| Level | Main question | Typical scope | Dependencies |
| --- | --- | --- | --- |
| Unit | Does this rule or component behave correctly by itself? | Function, class, or small module | In-memory collaborators or controlled fakes |
| Integration | Do important components work together across a real boundary? | Application plus database, queue, filesystem, or provider adapter | Real local/test dependency or faithful test instance |
| End-to-end (E2E) | Can a user complete a critical flow through the running application? | User-visible path across deployed or test system | Real application stack, with controlled test data |

These names vary by codebase. Classify a test by what it exercises and what it proves, not by its filename. A “unit” test that starts a database is not isolated; a route test with all collaborators stubbed does not prove the database integration.

## Choosing the level

Put detailed business-rule coverage at the unit level when it can be tested without infrastructure. Add integration tests for boundaries where configuration, serialization, transactions, queries, or framework behavior can fail. Add E2E tests for a small set of high-value user journeys and cross-layer wiring. Avoid testing the same detail at every level; each level should add distinct evidence.

Use the fastest test that can prove the behavior. Use a higher level when the failure risk is specifically in the integration between parts. For third-party systems, unit tests can use fakes, while contract or integration tests verify the adapter's assumptions; avoid making the entire suite depend on an unstable external service.

## Test quality

A reliable test has a clear name, arranges only the necessary state, performs one behavior, and checks meaningful outcomes. Tests should be deterministic, isolated, and repeatable. Assert public results, persisted state, or important side effects. Avoid broad snapshots or implementation-detail assertions that fail during harmless refactoring.

Test both success and failure paths. Include boundary cases based on requirements and risk. Verify security-sensitive behavior such as authorization at the boundary that enforces it. Use representative, non-sensitive test data and clean it up reliably.

## Running tests

Use the repository's documented commands and CI configuration as the source of truth. During development, run the narrowest relevant test first; before handoff, run the required checks for the affected area and report what ran and what did not. A test passing locally is evidence only for that test and environment; it does not establish that all requirements or production conditions are covered.

See [Planning a Test Strategy](PLANNING.md), [Unit Testing](UNIT_TESTING.md), [Integration Testing](INTEGRATION_TESTING.md), and [End-to-End Testing](END_TO_END.md). For the Red-Green-Refactor workflow, see [TDD](../tdd/README.md).
