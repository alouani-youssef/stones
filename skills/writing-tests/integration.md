# Integration Testing

An integration test checks that multiple parts work together across a real boundary. Examples include application code with a database, an HTTP handler with middleware and serialization, or a message consumer with its broker adapter. It complements unit tests by exercising behavior that isolated fakes cannot prove.

## What to verify

Choose boundaries where framework, configuration, data format, or infrastructure semantics matter:

- Database queries, constraints, migrations, transactions, and persistence mapping.
- HTTP routing, validation, middleware, serialization, and status behavior.
- Queue serialization, acknowledgement, retry, and idempotency behavior.
- Filesystem or cloud-storage adapter behavior relevant to the contract.
- Wiring and configuration needed to construct a real application component.

Prefer the actual supported engine when behavior is engine-specific. An in-memory substitute can be useful for speed, but may differ in SQL support, transaction behavior, constraints, collation, or concurrency. State which differences matter and retain at least focused coverage against the real dependency where risk warrants it.

## Setup and cleanup

Use an isolated test database, schema, bucket, or namespace. Create only the data needed for the case and clean it up reliably. Tests should not depend on developer data or test execution order. Ensure parallel tests cannot mutate the same records or shared resource unexpectedly.

Make external effects controllable. For a third-party API, the adapter test can use a local stub server or recorded contract fixture; do not make routine CI success depend on a public service's availability. Keep credentials and real customer data out of tests.

## Assertions

Assert behavior across the boundary: for example, a saved record can be read back with the expected fields, a transaction rolls back after failure, or an HTTP request produces the documented response and persisted change. Avoid asserting irrelevant implementation details such as the exact number of internal SQL statements unless query count is itself a performance requirement.

```python
def test_order_is_persisted_and_can_be_loaded(order_repository, database):
    order = Order(id="order-1", status="open")

    order_repository.save(order)

    loaded = order_repository.find_by_id("order-1")
    assert loaded == order
```

This example is meaningful only if `order_repository` uses the test database and the fixture isolates and cleans the relevant data.

## Reliability and diagnosis

Prefer explicit readiness checks over fixed startup sleeps. Set reasonable timeouts, report the dependency and operation on failure, and distinguish unavailable test infrastructure from an application assertion failure. Keep integration tests focused so failures point to a boundary rather than an entire environment.

Integration suites are slower than unit suites, so run a focused subset during iteration and the relevant full suite in CI or before handoff according to repository practice. Record any test that was skipped because its dependency was unavailable.
