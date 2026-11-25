---
name: testing
description: Use when deciding how to prove a change works before calling it done, when a test is hard to write because code reaches for globals, time, network or randomness, when tests pass but the feature is broken, when a bug fix has no reproduction, or when shaping a module so its behavior can be checked.
metadata:
  title: Verification and Design for Testability
  summary: Proving behavior with evidence that matches the claim, and shaping code so that evidence is cheap to get.
---

# Verification and Design for Testability

Two halves of one job:

- **Verification** answers *"how do I know it works?"* You make a claim ("the export handles empty accounts"), and you produce evidence that would have failed if the claim were false.
- **Design for testability** answers *"why is that evidence so expensive?"* Code that hides its inputs, its effects or its outcomes forces slow, flaky, over-mocked tests. Fix the design and the evidence becomes cheap.

When a test is hard to write, treat it as a design finding, not a testing problem.

| You need to… | Read |
| --- | --- |
| Decide what evidence a claim needs, verify a fix, report results honestly | [verification.md](verification.md) |
| Make code controllable, observable and isolated; pick a seam; refactor hard-to-test code | [testability.md](testability.md) |
| Pick unit vs integration vs E2E, write the tests themselves | the `writing-tests` skill |
| Drive implementation test-first | the `test-first-development` skill |
| Swap collaborators through constructors or a container | the `dependency-injection` skill |

## The verification loop

1. **State the claim** in observable terms: input or condition → expected outcome. "Works" is not a claim.
2. **Choose the oracle:** what tells you the outcome is right? A known value, a spec rule, an invariant, a reference implementation, a previous version's output.
3. **Pick the cheapest evidence that can fail.** The narrowest test, command or check that exercises the real path for that claim.
4. **Prove the check can fail.** See it red first (missing behavior, reverted fix or broken input). A check that never failed proves nothing.
5. **Run it and read the output.** Exit code and the actual assertions, not a summary you expected.
6. **Report exactly what was shown,** at which level, in which environment, and what was not checked.

## Testability in four properties

| Property | Question | Typical fix |
| --- | --- | --- |
| **Controllable** | Can a test put the unit in any state and feed it any input? | Pass inputs and collaborators in; seams for time, IDs, randomness, config |
| **Observable** | Can a test see the outcome without peeking at internals? | Return results and typed errors; record effects through an interface |
| **Isolatable** | Can it run without the network, real clock, shared DB or other tests? | Functional core and imperative shell; adapters at the edges |
| **Deterministic** | Same inputs, same result, every run, any order? | Inject clock and randomness; await conditions, never sleep; own your test data |

A unit missing any of these will produce tests that are slow, flaky, or that assert on mocks instead of behavior.

## Red flags

| Thought or symptom | What it means |
| --- | --- |
| "Tests pass, so it's done" | Which claim did they cover? Did they run the real path? |
| "I fixed the bug" (no reproduction) | Without a failing repro first, you don't know you fixed *this* bug |
| "I'll just mock that" (fifth mock in one test) | The unit has too many collaborators; split policy from wiring |
| `sleep(2000)` in a test | Nondeterminism with no seam; await a condition or inject the clock |
| Test reads a private field or spies on an internal method | Outcome is not observable; return it or record it at a boundary |
| Test only fails when run with others | Shared state; isolate data and resources |
| "Should work" / "looks right" | That is a prediction, not evidence; run something |
