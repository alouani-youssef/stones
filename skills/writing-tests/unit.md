# Unit Testing

A unit test checks a small unit of behavior in isolation, usually a function, class, or cohesive module. It should be fast and local enough to help diagnose a failure without starting the full application or relying on external infrastructure.

## What belongs in a unit test

Use unit tests for business rules, calculations, state transitions, input validation, mapping, and branching behavior that can be exercised through a small public interface. Verify return values, exceptions, resulting state, or a meaningful interaction with a collaborator.

Keep real logic in the unit under test. Replace slow or nondeterministic boundaries—network, database, clock, random source—with controlled fakes or injected collaborators when those boundaries are not the subject of the test. Do not mock every function call: excessive mocks couple tests to implementation and can make them pass while real components disagree.

## Structure

Arrange the required input and collaborators, act once, and assert the observable result. One test can contain several assertions when they describe one outcome, such as the resulting state and emitted event. Use names that explain the condition and expected behavior.

```ts
it("rejects a payment larger than the remaining balance", () => {
  const account = new Account(500);

  expect(() => account.charge(600)).toThrow("insufficient funds");
  expect(account.balance).toBe(500); // failed operation has no partial effect
});
```

```python
import pytest


def test_rejected_charge_does_not_change_balance():
    account = Account(balance_cents=500)

    with pytest.raises(ValueError, match="insufficient funds"):
        account.charge(600)

    assert account.balance_cents == 500
```

These are illustrative APIs; adapt names, error types, and runner syntax to the implementation's contract.

## Test data and isolation

Prefer small explicit inputs over large shared fixtures. A fixture should make intent clearer, not hide important setup. Avoid mutable global state and tests whose result depends on execution order. If a test changes process-level state, restore it even when an assertion fails.

Control time, randomness, generated identifiers, and asynchronous scheduling through injectable seams or supported fake utilities. Do not use arbitrary sleeps to wait for behavior; wait on a specific signal or use a controllable scheduler.

## Common failure modes

- Testing private helpers instead of the public behavior, making harmless refactors costly.
- Mocking the unit itself or so many collaborators that the test only repeats its setup assumptions.
- Checking only a happy path while ignoring a promised boundary or failure behavior.
- Combining unrelated scenarios in one test with conditional setup.
- Using snapshots for complex output without reviewing what the snapshot actually guarantees.
- Duplicating identical cases where a parameterized test would communicate one shared rule.

## Coverage

Coverage reports which code was executed, not whether assertions would catch incorrect behavior. Use it to find unvisited areas and ask whether those areas contain important behavior. Do not treat line coverage as a quality score in isolation or add low-value assertions solely to raise a percentage.
