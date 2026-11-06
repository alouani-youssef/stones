# End-to-End (E2E) Testing

An end-to-end test exercises a user-visible workflow through the running application and its major layers. It provides evidence that routing, UI or API behavior, application logic, and configured dependencies work together for that flow.

## What to cover

Prioritize a small number of high-value paths: a primary user task, an important permission boundary, and a critical failure or recovery path where relevant. E2E tests are most valuable for failures caused by wiring and cross-layer assumptions. Keep detailed rule combinations at lower levels, where they are faster and easier to diagnose.

Examples include creating and retrieving a record through the public interface, completing a purchase with a controlled payment provider, or confirming that a user without access is denied. Choose flows based on product impact and risk rather than trying to automate every possible screen or API permutation.

## Test data and external services

Use a dedicated test environment and deterministic data. Give each run or test a unique namespace or identifier, and clean up even when the flow fails. Do not use production accounts or real payment, email, or customer data. Replace third-party effects with sandbox credentials or controlled test doubles at an explicit boundary.

Make tests repeatable: control clocks where expiration matters, avoid ordering dependencies, wait for observable state rather than arbitrary time, and ensure the application is ready before interaction. Parallel runs must not share mutable fixtures unintentionally.

## Assertions and failure diagnosis

Assert what the user or caller can observe: successful page/state, response content, persisted outcome, or denial of access. Include enough context in names and failure messages to locate the broken step. A test that only checks a page loaded may miss an incomplete workflow; assert the meaningful final result.

Avoid overfitting to layout details that change frequently unless visual layout itself is the requirement. Prefer accessible roles, labels, and stable public identifiers over fragile positional selectors. Keep browser-specific details in the test layer rather than production behavior.

## Role in the suite

E2E tests are generally slower and more failure-prone than unit and integration tests because they involve more components. Keep the suite small and purposeful. When an E2E test reveals a business-rule bug, add a focused lower-level regression test as well if that rule can be tested there; keep the E2E check for the cross-layer flow it uniquely verifies.

Report environment failures separately from product failures. A browser crash, missing test service, or unavailable dependency means the test did not provide a pass/fail result about the feature; do not describe it as passing.
