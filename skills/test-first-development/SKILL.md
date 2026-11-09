---
name: test-first-development
description: Use when implementing a feature, fixing a bug or refactoring in a project that works test-first, before writing implementation code, or when a test is hard to write and the design may need a clearer boundary.
metadata:
  title: Test-Driven Development
  summary: The Red-Green-Refactor loop — one failing test for one behavior, the smallest passing change, then cleanup with tests green.
---

# Test-Driven Development

A feedback loop for building behavior in small, checkable steps:

1. **Red:** write one test for a behavior that does not exist yet. Run it and confirm it fails **for the intended reason**.
2. **Green:** write the smallest implementation that passes. Run it again.
3. **Refactor:** improve names and structure with the test still passing.

Repeat for the next behavior. A failure caused by a typo, broken setup or import error is not Red evidence: fix the setup until the intended assertion is what fails.

## Choosing the next test

Start with the smallest important example, then add cases that could change the implementation or cause harm:

- Typical valid input and expected output.
- Boundaries: empty, minimum, maximum, just outside limits.
- Invalid or missing input and the promised error.
- State changes and side effects, including once vs not at all.
- Collaborator failures (storage, network).

Choose cases from the contract, risks and branches, not every imaginable input. Parameterize cases that assert one rule; keep distinct behaviors in distinct tests. Do not invent a rule (e.g. for zero quantity) the requirements do not define: ask.

## Example

```ts
import { describe, expect, it } from "vitest";
import { lineTotal } from "./line-total";

describe("lineTotal", () => {
  it("multiplies unit price by quantity", () => {
    expect(lineTotal({ unitPriceCents: 250, quantity: 3 })).toBe(750);
  });

  it("rejects a negative unit price", () => {
    expect(() => lineTotal({ unitPriceCents: -1, quantity: 1 }))
      .toThrow("unit price must be non-negative");
  });
});
```

Run it, see it fail because `lineTotal` is missing, implement the simplest correct function, run again. Use the repository's configured runner; Vitest is illustrative.

## Bugs and refactors

- **Bug:** capture the visible failure in a regression test, watch it fail against current code, make the smallest fix, watch it pass.
- **Refactor:** pin existing behavior with tests before changing structure.

## Habits

- Loops small enough to understand each failure.
- Assert outcomes callers rely on, not private helper calls (unless call count is the contract).
- Deterministic: control time, randomness and external responses.
- Independent tests that pass alone and in any order.
- Run the narrow test while iterating; the relevant broader suite before finishing.
- Update tests only when the contract intentionally changes.

## Hard to test = design feedback

Check whether the component has too many responsibilities, hides dependencies in globals, mixes policy with I/O, or has no observable result. Refactor around the smallest real boundary. Production and test paths stay the same: control boundary inputs (time, provider responses) instead of adding test-only branches. Do not add layers just to satisfy a test the public contract could support.

TDD is a technique, not proof of correctness. It complements review, integration checks and validation against real requirements. For choosing test levels see the `writing-tests` skill.
