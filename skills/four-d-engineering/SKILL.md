---
name: four-d-engineering
description: Use when taking on a non-trivial engineering task (feature, bug, refactor, review, migration), when scoping or decomposing work, writing a prompt or brief for a subagent, judging generated code, or before reporting a change as done; also when the four-d hook injects "[4D guardrails]".
metadata:
  title: The 4D Framework
  summary: Delegation, Description, Discernment, Diligence — scope the work, brief it precisely, judge output on evidence, and deliver it safely.
---

# The 4D Framework

AI-assisted engineering as a discipline, not prompt-writing. **Delegate** bounded execution, **describe** enough context to constrain it, **discern** output with evidence, and keep **diligence** over consequential decisions.

**AI output is a proposed change, not proof that the task is complete.**

| Dimension | Question | Reference |
|---|---|---|
| Delegation | What should the engineer do, what can AI do, what must stay human-controlled? | [delegation.md](delegation.md) |
| Description | How are requirements, repo context, constraints and acceptance criteria communicated? | [description.md](description.md) |
| Discernment | Is the generated code and explanation correct and fit for purpose? | [discernment.md](discernment.md) |
| Diligence | Is the change safe, traceable, maintainable and accountable? | [diligence.md](diligence.md) |

Testing generated code: [testing-ai-code.md](testing-ai-code.md). Prompt templates for investigation, implementation, debugging, tests and review: [prompt-templates.md](prompt-templates.md).

## Workflow

| Phase | Do | Deliverable |
|---|---|---|
| 1. Understand and delegate | Find the actual problem (symptom vs root cause), outcome, scope, dependencies, risk. Define success **and failure** criteria. | A bounded task |
| 2. Describe | Gather the relevant files, conventions, current vs expected behavior, contracts, change boundaries, validation commands. Name what is missing. | An actionable brief |
| 3. Investigate and design | Inspect code, trace dependencies, reproduce. Separate facts from hypotheses. Compare options; pick the smallest suitable one. | A proposal or plan |
| 4. Implement | Make the approved change following conventions. Focused diff, tests added, no unrelated refactors. | A reviewable change |
| 5. Verify | Read the diff. Run format, lint, typecheck, unit, integration and regression tests. Check security and performance. Compare against acceptance criteria. | Evidence-backed results |
| 6. Deliver | Human review and approvals, migration and rollback plan, then merge through normal controls. | A traceable change |
| 7. Learn | Record what failed and where it came from (requirements, context, prompt, model, code, tests). Update guidelines. | A better process |

For unfamiliar code, production bugs or architectural changes, finish phase 3 before writing code.

## Keep human control when

- Requirements are unclear or disputed.
- The change touches authentication, authorization, cryptography or tenant isolation.
- An operation can delete or irreversibly modify data.
- The workflow is financial, safety-critical or regulated.
- The source of truth is not available to you.
- The change crosses boundaries nobody has explained.

Stop and ask; do not decide these alone.

## Reject regardless of how good the rest looks

- Violates a critical security invariant, or allows unauthorized or cross-tenant access.
- Causes unacceptable data loss or corruption.
- Breaks a mandatory API or data contract.
- Fails a required acceptance test.
- Contains unreviewed destructive production operations.
- Claims validation or test results that were not actually produced.

## Before saying "done"

- [ ] The original problem is solved, every acceptance criterion checked.
- [ ] The diff is limited to the intended scope; it follows neighboring conventions.
- [ ] Edge cases, errors, security and data integrity reviewed.
- [ ] Tests assert meaningful behavior and were **executed**; results reported as they are.
- [ ] Format, lint and typecheck run.
- [ ] Migrations and destructive operations reviewed; rollback known.
- [ ] Limitations and unresolved risks stated.

"Tests generated", "inspected", "executed", "passed" and "passed in the target environment" are different claims. Report the exact commands run, their results, and the checks you did not perform.
