# Testing AI-generated code

Executable verification is the bridge between generated code and confidence. A model's explanation or self-assessment is not a substitute.

## Tests come from requirements, not from the generated code

The common failure: generate an implementation, then generate tests that confirm its own assumptions. Instead:

1. Define requirements and expected behavior independently.
2. Identify invariants and failure scenarios.
3. Write acceptance criteria.
4. Create representative cases.
5. Implement.
6. Run the tests against the implementation.

Derive expected outcomes from specifications, domain rules, existing behavior and independent oracles.

## Layers

| Level | Verifies | Examples |
|---|---|---|
| Static checks | Structural and language-level correctness | Compiler, linter, formatter, static analysis |
| Unit | Isolated behavior | Services, functions, validators, domain logic |
| Integration | Component interactions | Database, queues, APIs, authentication |
| Contract | Compatibility between components | API schemas, events, service interfaces |
| End-to-end | User-visible workflows | Registration, checkout, payment |
| Security | Resistance to misuse | Authorization, injection, tenant isolation |
| Performance | Behavior under load | Throughput, latency, concurrency, resources |
| Human acceptance | Business and operational fit | Domain review, usability, release approval |

Match the effort to the change: a docs change does not need what a database isolation change needs.

## Cases to consider

- **Happy:** valid input, expected permissions, normal dependencies, successful external calls.
- **Boundary:** empty input, min/max, large payloads, duplicates, concurrent requests, missing optional fields.
- **Failure:** invalid input, missing authorization, database down, timeout, partial failure, duplicate event delivery, external errors, retry exhaustion.
- **Adversarial:** malformed input, injection, privilege escalation, cross-tenant access, unexpected content, resource exhaustion.

## Properties and invariants

Check general properties across generated inputs: normalizing twice equals normalizing once; a tenant-scoped lookup never returns another tenant's rows; non-overlapping pages never share records; a retry-safe operation never duplicates business effects; serialize then deserialize preserves supported data. Invariants are most valuable for security and data integrity.

## Migrations and data changes

Test from the previous supported schema, on representative data. Check constraints and indexes, data preservation, rollback or recovery, cost of expensive operations, compatibility between app and schema versions, and concurrent instances where relevant. A migration is not safe just because the ORM generated it.

## Test the tests

Tests must assert meaningful behavior, **fail when the implementation is deliberately broken**, exercise the real path, use realistic fixtures, avoid excessive mocking, check error paths and side effects, be order-independent, deterministic and isolated, clean up, and never silently skip assertions. Use mutation testing, fault injection or a deliberately introduced defect to prove they catch failures.

## Regression

Keep a suite over core workflows, public APIs and contracts, authn/authz, database invariants, known historical defects and critical integrations. A locally correct generated change can break a distant dependency.

## Report execution evidence

"Tests were generated", "inspected", "executed", "passed" and "passed in the target environment" are not equivalent. A completion report lists the exact commands, results, failures and checks not performed.
