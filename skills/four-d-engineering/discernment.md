# Discernment: evaluate generated code and decisions

**Is the generated code correct, maintainable, secure and appropriate for this system?** A convincing explanation is not proof. Evaluate against requirements, repository contracts, runtime behavior and tests.

## Dimensions

| Dimension | Question |
|---|---|
| Functional correctness | Does it implement the required behavior? |
| Requirement alignment | Does it meet every acceptance criterion? |
| Completeness | Are edge cases, errors and dependencies handled? |
| Type and contract correctness | Are interfaces, schemas and API contracts respected? |
| Architectural consistency | Does it follow module boundaries and patterns? |
| Maintainability | Is it understandable, cohesive, reasonably simple? |
| Security | Does it introduce vulnerabilities or weaken controls? |
| Performance | Are queries, allocations, network calls and algorithms appropriate? |
| Reliability | Are failures, retries, concurrency and partial states handled? |
| Testability | Can behavior be tested deterministically? |
| Documentation | Are behavior and operational changes documented? |

Code can compile while violating business rules, security boundaries or architecture.

## Inspect the implementation, not the explanation

Review the diff and every modified file, new dependencies, public interfaces, queries and migrations, error handling, logging and sensitive data, concurrency and transactions, configuration changes, and test quality.

Ask: does it solve the original problem? Is it consistent with neighboring code? Unnecessary abstractions? Hidden side effects? Can it break callers? Are failures explicit? Is it simpler than the alternatives?

## Common failures in generated code

| Failure | Looks like |
|---|---|
| Hallucinated APIs | Methods, options or library features that do not exist |
| Incorrect assumptions | Behavior inferred from incomplete context |
| Interface drift | Contracts changed unexpectedly |
| Overengineering | Abstractions and dependencies without need |
| Underengineering | Missing validation, error handling or edge cases |
| Insecure defaults | Trusting input, exposing secrets, weakening access control |
| Concurrency defects | Races, unsafe shared state, wrong locking |
| Data integrity defects | Broken transaction boundaries or migration assumptions |
| Test theater | Tests that pass without validating meaningful behavior |
| Scope drift | Refactoring or changing unrelated modules |
| False completion | Claiming tests passed without running them |

## Evaluate the approach

- **Technical:** APIs used correctly; compiles against installed versions; fitting algorithms and data structures; correct database operations.
- **Architectural:** respects module ownership and dependency direction; no unnecessary coupling; fits the deployment model.
- **Operational:** configurable and deployable; safe migrations; rollback possible; enough logs and metrics; failure modes understood.
- **Security:** authn/authz enforced; input validated; secrets protected; tenant boundaries kept; external calls and tool permissions constrained.

## Useful feedback

Each correction names: the defect, the evidence, the violated requirement or invariant, the required correction, and the test that will prove it.

```text
Defect:
The repository resolves a database connection using a tenant
identifier supplied in the request body.

Why this is incorrect:
The request body is not a trusted source of tenant identity.
This can allow tenant-context manipulation.

Required correction:
Resolve tenant identity from the authenticated request context and
enforce the tenant isolation invariant at the repository boundary.

Required validation:
Add integration tests proving that a user authenticated for tenant A
cannot read or modify tenant B's records.
```
