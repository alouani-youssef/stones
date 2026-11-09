# Planning a Test Strategy

Test planning turns a feature's behavior and risks into a set of checks with clear evidence. The goal is not to maximize test count or chase a universal coverage percentage. The goal is to make important failures likely to be detected at a maintainable cost.

Testing is designed into the feature. Before implementation, decide which behavior is policy, which parts perform external effects, what state must be observable, and how tests can control nondeterministic inputs. If a critical requirement cannot be checked without starting the entire system or reaching production services, revisit the design boundary before coding further.

## Design review for testability

For each feature, answer these questions as part of design and implementation planning:

1. **What is the contract?** Identify the source of truth for outputs, errors, state transitions, permissions, and side effects. Separate confirmed requirements from assumptions and open questions.
2. **Where are decisions made?** Locate business policy and validation. Can those rules be exercised without HTTP, database, UI, or network setup?
3. **Where do effects happen?** Identify reads and writes to storage, calls to providers, event publication, time, randomness, and filesystem access. Define narrow boundaries where the behavior needs independent verification or a controlled test double.
4. **What must remain true?** State invariants across success and failure: no partial mutation, one charge per request, tenant isolation, transaction consistency, or retry safety, as applicable.
5. **How is state created and observed?** Determine how tests establish initial state, observe the final result, and clean up. Avoid requiring private state inspection when a public result or persisted outcome can prove the contract.
6. **What can vary?** Plan how tests control clocks, generated IDs, random values, asynchronous work, concurrency, and external responses. Use existing framework tools where they fit.
7. **What is the minimum valuable seam?** Add a boundary only where it isolates a real effect, variation, or independently owned responsibility. Do not create generic test-only abstractions or inject every pure helper.

This review should inform the production design. A test should not require a second implementation path or special behavior that production never uses. If setup is difficult, diagnose whether the cause is a real architecture boundary, missing contract, or merely a test fixture problem before changing the design.

## Planning steps

1. **Understand the change.** Read the requirement, affected code, interfaces, data model, and existing tests. Record ambiguities rather than silently deciding product behavior.
2. **List observable behaviors.** Include successful outcomes, validation, state transitions, permissions, error handling, and relevant side effects.
3. **Assess risk.** Consider user impact, likelihood, complexity, data loss or corruption, security/privacy, concurrency, external dependencies, and difficulty of recovery.
4. **Choose the lowest useful test level.** Use unit tests for isolated rules, integration tests for real boundaries, and E2E tests for critical cross-system user flows.
5. **Select representative cases.** Cover normal behavior, important boundaries, invalid inputs, and failure paths. Use equivalence classes and decision tables where many inputs share one rule.
6. **Define evidence.** State what assertion or observable result proves each behavior, and what command or environment runs it.
7. **Check gaps and cost.** Look for untested high-risk behavior, duplicated tests that add no evidence, nondeterministic dependencies, and cleanup needs.

## Risk-to-test mapping

| Risk or behavior | Likely evidence |
| --- | --- |
| Deterministic calculation or validation | Unit tests for representative values and boundaries |
| Database mapping, constraints, transaction, or query semantics | Integration test against the supported database engine |
| HTTP request parsing, serialization, middleware, or status codes | Application integration test through the real framework boundary |
| Authorization or tenant isolation | Tests at the enforcement boundary, including denied and cross-tenant cases |
| Third-party adapter assumptions | Unit tests with controlled responses plus a focused contract/integration check where feasible |
| Critical user journey across layers | A small number of E2E tests with isolated test data |
| Timeout, retry, race, or concurrent update behavior | Focused tests with controllable timing/concurrency; avoid sleep-based assertions |

The mapping is a starting point, not a substitute for inspecting the actual architecture. A test at one level may be insufficient if it bypasses the component that enforces the behavior.

## Useful planning techniques

### Equivalence classes and boundaries

Group inputs expected to behave the same, then select a representative from each group. Test just below, at, and just above meaningful limits. For a page size constrained to 1–100, useful values might include 0, 1, 100, and 101, plus the documented default when omitted.

### Decision tables

For behavior dependent on multiple conditions, enumerate meaningful combinations rather than writing arbitrary examples. For example, access might depend on resource ownership and role; include allowed owner, allowed privileged role, unrelated user, and unauthenticated caller when those cases exist in the contract.

### State transitions

For workflows, identify valid transitions, forbidden transitions, and retry behavior. Assert both the resulting state and important side effects. Check that a rejected transition does not partially mutate state.

## Plan template

```markdown
## Behaviors
- [Observable behavior and requirement/source]

## Risks
- [Impact, likelihood, and relevant failure mode]

## Testability design
- Policy and effect boundaries: [where decisions end and external effects begin]
- Controlled inputs: [clock, randomness, IDs, scheduling, provider responses]
- Observable outcomes and invariants: [what can be asserted, including failure behavior]
- State setup and cleanup: [fixtures/resources and isolation]
- Design seams: [existing or proposed boundary, and why it is needed]

## Tests
- Unit: [case, assertion, command]
- Integration: [boundary, real dependency, setup/cleanup]
- E2E: [critical flow, isolated data, assertion]

## Not covered and why
- [Known limitation or low-risk behavior]

## Test data and determinism
- [Fixtures, clock/randomness control, cleanup, external services]
```

## Guidance for LLM-generated test plans

An LLM should inspect the implementation and repository before proposing commands or test cases. It should identify the contract source, test framework and naming conventions, nearby tests, available test infrastructure, and affected boundaries. It must not invent requirements, assume unavailable services, or claim a test ran when it did not.

For each proposed test, state the behavior, level, setup, assertion, and why that level is appropriate. Also explain whether the current design makes the behavior controllable and observable. If not, propose the smallest production design change that creates a real boundary or observable contract; do not recommend broad mockability as an end in itself. Prefer a small set of discriminating cases over many near-duplicates. Call out unresolved product decisions separately. Map every high-risk behavior to evidence, and explain any high-risk gap. Reuse existing helpers only after verifying what they set up and clean up.
