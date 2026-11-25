e# Verification

Verification is producing evidence for a specific claim. The rule that matters: **the evidence must be capable of failing if the claim is false.**

## Verification vs validation

- **Verification:** did we build it right? Does it meet the stated contract (spec, scenarios, types, invariants)?
- **Validation:** did we build the right thing? Does the contract solve the user's problem?

Tests verify. Validation needs a person: a demo, a review of the spec, a check with whoever asked. When the contract itself looks wrong, stop and ask. Don't "fix" a test to match surprising behavior (see `writing-tests` on **Contract change**).

## Claims and the evidence they need

| Claim                                | Minimum evidence                                                                      | Not enough                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| "This function computes X correctly" | Unit tests over typical, boundary and invalid inputs against a known oracle           | One happy-path example                                                 |
| "The bug is fixed"                   | A test or script that reproduced the bug, failed before the fix and passes after      | The new code "looks right"; the old symptom just isn't visible locally |
| "It persists correctly"              | Integration test against the real database engine (container or test instance)        | Unit test with the repository mocked                                   |
| "The user can do Y"                  | E2E or a manual run of the actual flow, with the observed result stated               | Unit tests of each piece                                               |
| "Nothing else broke"                 | The affected area's suite plus typecheck and lint, as CI runs them                    | Only the new test                                                      |
| "It's fast enough"                   | A measurement with input size, environment and number stated                          | "It's O(n)"                                                            |
| "It handles failure Z"               | A test that injects Z (timeout, 5xx, partial write) and asserts the promised behavior | A try/catch existing in the code                                       |

Pick the cheapest row that actually covers the claim. If you can't produce the evidence, narrow the claim.

## Choosing an oracle

An oracle is how you know an output is correct. Without one, a test only checks that the code does what it does.

- **Known examples:** hand-computed input/output pairs from the spec. Best for business rules.
- **Invariants and properties:** facts that hold for every input: `decode(encode(x)) == x`, totals equal the sum of lines, output is sorted, balance never goes negative. Use property-based testing (fast-check, Hypothesis) when the input space is large.
- **Reference implementation:** compare against a slow, obviously correct version, or against the previous version during a refactor (characterization tests).
- **Metamorphic relations:** when the exact output is unknown, check relations: adding a filter never returns more rows; scaling every price by 2 doubles the total.
- **Golden files:** approved outputs for complex but stable results. Review every diff; never bulk-approve.

Avoid deriving the expected value with the same logic as the implementation. `expect(total(items)).toBe(items.reduce(...))` copying the code under test proves nothing.

## Prove the check can fail

A test that has never been red is unverified.

- **New behavior:** run the test before implementing. It must fail on the intended assertion, not on an import error or a typo.
- **Bug fix:** reproduce first. Write the failing test from the bug report, watch it fail, then fix. If you can't reproduce it, you haven't understood it yet.
- **Existing test you're relying on:** break the code briefly (flip a condition, return early) and confirm the test catches it, then restore. Mutation testing (Stryker, mutmut, PIT) automates this for critical modules.
- **Assertions present?** A test with no assertions, an un-awaited promise, or a `catch` that swallows the failure always passes.

## Verifying a change end to end

1. Write down the claims the change makes (usually the task's scenarios).
2. Map each claim to a row in the table above.
3. Run the narrowest check while iterating.
4. Before handoff, run what CI runs for the affected area: tests, typecheck, lint, build. Use the repository's documented commands.
5. For user-visible changes, exercise the real thing once: run the CLI, hit the endpoint, click the flow.
6. Read the output. A green summary with `0 tests ran` or skipped suites is not a pass.

## Reporting

Say what you showed, at what level, and what you didn't check:

> Added `parseDuration` with 9 unit tests (boundaries: empty, `0s`, max int, unknown unit); verified red before implementing. Ran `npm test -- duration`: 9 passed. Full suite and typecheck pass. Not verified: behavior under non-English locale (no test env for it).

Keep these claims apart: _written_ ≠ _ran_ ≠ _passed_ ≠ _passed in CI_. A local pass is evidence for that environment only. If something failed or was skipped, say so with the output.

## Common mistakes

- **Verifying the mock.** The test asserts the stub returned what the stub was told to return. Assert the unit's outcome instead.
- **Verifying at the wrong level.** Unit tests with every collaborator faked, offered as proof that the database query works.
- **Moving the goalposts.** Editing the assertion until it passes. If expected behavior really changed, record why before touching the test.
- **Silent skips.** `.only`, `.skip`, `xit`, conditional skips on missing env vars. Check the count of tests that ran.
- **Flake tolerance.** Rerunning until green. A flaky test is unverified; find the nondeterminism (see [testability.md](testability.md)).
