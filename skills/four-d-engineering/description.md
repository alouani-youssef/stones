# Description: give the work the context and instructions it needs

**How is an engineering objective turned into precise, actionable instructions?** Mostly context engineering plus task specification: the repository, its conventions, expected behavior and the boundaries of the change. Use this when briefing a subagent or writing any task prompt.

## Smallest sufficient context

- **Project:** purpose; language, framework, runtime, major dependencies; relevant modules; architecture and patterns; API and data contracts.
- **Task:** problem; current and expected behavior; relevant files, logs, stack traces or failing tests; what was tried; prior decisions that constrain the solution.
- **Constraints:** compatibility; coding and naming standards; module and dependency boundaries; security and privacy; performance; migration and deployment; dependencies that must not change.

Do not dump the repository. Name the relevant files and contracts; expand when investigation shows a need.

## Prompt structure

1. **Role** — perspective needed. 2. **Objective.** 3. **Repository context.** 4. **Current behavior** with evidence. 5. **Expected behavior.** 6. **Instructions** — sequence or deliverables. 7. **Constraints** — what must and must not change. 8. **Acceptance criteria.** 9. **Validation** — tests and commands. 10. **Uncertainty handling** — what to do when information is missing or contradictory.

Use as much structure as the task's complexity and risk need. A role sets a perspective but does not guarantee expertise; repository evidence and explicit constraints matter more.

## Deliverable and mode

Say what comes back: root-cause analysis with evidence, plan with trade-offs, focused code change, tests, review report with severity and file references, migration plan with rollback, docs, or a test report with commands and results. Say whether to inspect first, propose and wait, or implement immediately.

## Change boundaries

State which files may change, which interfaces must stay stable, which dependencies may be added, which generated files are off-limits, whether schema or public API changes are allowed, and that unrelated formatting or refactoring is out of scope.

```text
Change boundaries:
- Keep the existing module structure.
- Do not introduce cross-module entity imports.
- Do not change public API response shapes.
- Do not add dependencies without explaining why.
- Do not modify unrelated files.
- Do not alter database schema unless required and approved.
```

## Good vs weak instructions

```text
Implement a tenant-aware repository lookup.

Requirements:
- Resolve tenant identity from the authenticated request context,
  not from an untrusted request body.
- Reuse connections only for the same tenant.
- Fail explicitly when tenant context is missing.
- Preserve existing repository interfaces.
- Add tests for missing tenant context, connection reuse,
  concurrent requests, and cross-tenant isolation.
```

Weak: `Make the database work for multiple tenants.` — behavior, boundaries, security and validation are undefined.

For recurring tasks keep examples of accepted and rejected implementations, expected tests, error-handling conventions, response formats and patterns.

## Ask for evidence, not hidden reasoning

```text
Before implementation:
1. Summarize the relevant existing behavior.
2. Identify dependencies and constraints.
3. List assumptions and missing information.
4. Compare viable approaches and their trade-offs.
5. Recommend the smallest suitable change.

After implementation:
1. Summarize changed files and behavior.
2. Explain important design decisions.
3. List tests and commands executed.
4. Report actual test results.
5. Identify limitations and unresolved risks.
```

## Investigation first for uncertain tasks

- **A — Investigate:** inspect files, trace paths, reproduce, gather evidence and hypotheses, report gaps.
- **B — Propose:** likely root cause, candidate fixes, risks, affected components, tests and acceptance criteria.
- **C — Implement:** the approved, bounded change, following conventions.
- **D — Verify:** targeted and regression tests, diff review, honest failure reporting.

This stops an early unverified assumption from deciding the implementation.

## Prompts are versioned artifacts

For repeated use track: identifier and version, intended task and model, input/output schemas, examples and evaluation set, parameters, known limitations, evaluation results, change history. Compare variants on measured outcomes, not one nicer-looking response.
