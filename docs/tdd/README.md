# Test-Driven Development (TDD)

Test-driven development is a feedback loop for building behavior in small, checkable steps:

1. **Red:** write one test for a behavior that is not implemented yet, then run it and confirm it fails for the intended reason.
2. **Green:** write the smallest implementation that makes that test pass, then run it again.
3. **Refactor:** improve names and structure while keeping the test passing.

Repeat the loop for the next behavior. The test should describe an observable contract, not the exact implementation. A failing test caused by a typo, broken setup, or import error is not useful Red evidence; fix the setup until the intended assertion is what fails.

## Choosing the next test

Start with the smallest important example of the behavior, then add cases that could change the implementation or cause harm:

- Typical valid input and expected output.
- Boundary values: empty, minimum, maximum, and just outside limits.
- Invalid or missing input and the promised error behavior.
- State changes and side effects, including whether they happen once or not at all.
- Failure paths from collaborators such as storage or network services.

Do not enumerate every imaginable input. Choose cases from the contract, risks, and branches in the code. Parameterize cases when they assert the same rule; keep distinct behaviors in distinct tests.

## Example: TypeScript

Suppose the requirement is to reject negative prices and calculate the total in integer cents. Begin with the behavior, not the implementation:

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

Run the tests and verify the expected failure before implementing `lineTotal`. Then implement the simplest correct function, run the same tests to reach Green, and refactor only with the tests still passing. The import and test command depend on the repository's configured runner; Vitest here is illustrative.

## Example: Python

```python
import pytest

from pricing import line_total


def test_multiplies_unit_price_by_quantity():
    assert line_total(unit_price_cents=250, quantity=3) == 750


def test_rejects_negative_unit_price():
    with pytest.raises(ValueError, match="unit price must be non-negative"):
        line_total(unit_price_cents=-1, quantity=1)
```

First run these tests and observe a failure for the missing behavior. Then implement the smallest correct function and run them again. Add a zero-quantity test if the contract defines its behavior; do not silently invent a rule that product requirements have not specified.

## TDD for changes and bug fixes

For a bug, capture the externally visible failure in a regression test first. Ensure it fails against the current behavior, then make the smallest fix and verify the test passes. For a refactor, preserve existing behavior with tests before changing structure. If a behavior is difficult to test, identify the hidden dependency or unclear boundary before adding a large test harness.

## Good TDD habits

- Keep each loop small enough to understand the failure and fix.
- Assert outcomes users or callers rely on; avoid asserting private helper calls unless call count is itself part of the contract.
- Prefer deterministic tests with controlled time, randomness, and external responses.
- Keep tests independent so they work in isolation and in any order.
- Run the narrow test while iterating, then the relevant broader suite before finishing.
- Treat tests as executable examples of the contract, and update them when the contract intentionally changes.

TDD is a development technique, not proof that a feature is correct. It complements review, integration checks, security analysis, and validation against real requirements.

## Design the behavior to be testable

TDD works best when the design gives behavior a clear contract and keeps decisions distinguishable from external effects. Start by identifying the input, outcome, errors, state changes, and side effects that matter. Then place the rule where it can be exercised without unrelated infrastructure. Keep the production path and test path the same; control the boundary inputs (such as time or a provider response) rather than adding test-only branches.

When a test is hard to write, use that friction as design feedback. Check whether the component has too many responsibilities, hides dependencies in globals, mixes policy with I/O, or offers no meaningful observable result. Refactor around the smallest real boundary that resolves the problem. Do not add layers solely to satisfy a test that could be written more simply through the existing public contract.
