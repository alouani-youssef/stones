# Delegation: allocate engineering work deliberately

**Which parts of the task should be done by AI, by an engineer, or together?** Start by understanding what needs to change and why, not by asking for an implementation.

## Understand the problem

- **Problem:** what is broken, missing, slow, insecure or hard to maintain?
- **Objective:** what observable outcome should the change produce?
- **Scope:** which services, modules, APIs, data models or workflows are affected?
- **Current behavior** and **expected behavior.**
- **Dependencies:** components, contracts, libraries, services or teams involved.
- **Constraints:** architecture, performance, security, compatibility, operations.
- **Risk:** impact if the change is wrong.

A stack trace shows where a failure surfaced, not necessarily where it originated.

## What to delegate

| Activity | Useful AI contribution | Human responsibility |
|---|---|---|
| Requirements analysis | Find ambiguities, missing cases, dependencies | Confirm product intent and priorities |
| Repository exploration | Locate files, trace call paths, summarize patterns | Confirm actual system boundaries |
| Architecture | Compare options, explain trade-offs | Choose and own the direction |
| Code generation | Draft implementation, tests, types, docs | Review design and correctness |
| Debugging | Form hypotheses, inspect logs, suggest experiments | Verify root cause, choose remediation |
| Refactoring | Find duplication, propose safe transformations | Protect behavior, approve scope |
| Code review | Find likely defects, risky patterns, missing tests | Make the final decision |
| Testing | Generate cases, fixtures, test code | Define expected behavior, assess coverage |
| Operations | Draft runbooks and diagnostic commands | Authorize production-impacting actions |

- **Delegate drafts and bounded execution.**
- **Collaborate on investigation and design.**
- **Keep human ownership of requirements, risk acceptance and release.**

## Decompose into bounded tasks

Split large requests into units that can be understood, implemented and verified alone. Example — tenant-aware database access:

1. Inspect the tenant resolution flow.
2. Identify how connections are created and reused.
3. Trace authentication and tenant identity propagation.
4. Define isolation invariants.
5. Propose the smallest compatible design.
6. Implement the connection-resolution change.
7. Unit-test connection selection.
8. Integration-test cross-tenant isolation.
9. Run regression tests.
10. Document configuration and operational implications.

Each task has an input, an expected output, constraints and completion criteria. Avoid "fix the database architecture" when a sequence of smaller tasks exists.

## Success and failure criteria first

**Success:** requests resolve the correct tenant; connections are reused only within the isolation boundary; concurrent requests cannot cross tenants; API contracts stay compatible; tests pass; no new critical security issue.

**Failure:** tenant identity can be supplied by an untrusted client; a connection is shared across tenants; missing tenant context silently falls back to a default; existing behavior regresses; tests skip concurrent or cross-tenant scenarios.

A task is not complete because the code compiles or the model says so.

## Choosing models and tools

Judge on representative tasks, not reputation: coding accuracy, multi-step reasoning, repository understanding, context capacity, tool use, structured output, latency, cost **per accepted change**, and consistency across runs.

- Boilerplate and small transformations: speed and cost.
- Complex debugging: reasoning and repository understanding.
- Code generation: correctness and test performance.
- Code review: defect detection and precision.
- Large refactors: context handling, tool use, regression discipline.

A cheap model that needs heavy correction can cost more overall.
