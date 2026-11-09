---
name: creating-files-and-modules
description: Use when adding a new file, module, class, type, helper, test or other artifact to the project, or when deciding whether to extend existing code, split it, or reuse a helper.
metadata:
  title: Creation Guidelines
  summary: Steps for adding a file, module, type or test so it fits the existing structure and has a clear reason to exist.
---

# Creation Guidelines

Make each addition fit the project's existing structure and have a clear reason to exist.

## Before creating something

1. Read the nearest related implementation, its callers and its tests. Check whether the responsibility already has an owner.
2. Identify the behavior or contract the new artifact provides. Prefer extending a cohesive existing module when that is clearer than adding another layer.
3. Decide which inputs are trusted, which can fail, and what the caller observes when they do.
4. Choose the smallest useful boundary. A new module needs a distinct responsibility or a contract callers benefit from.
5. Pick name and location from the project's conventions (`naming-files` skill).

## While implementing

- One main responsibility per file. Keep closely related types and helpers with the behavior that owns them.
- Make dependencies and side effects visible. Pass collaborators in when it clarifies the contract or makes behavior easier to exercise.
- Validate external data at the boundary, then pass validated values into domain logic (`defining-types` skill).
- Handle expected errors deliberately. Preserve context; do not swallow failures callers must act on.
- No new dependency, abstraction or config option without a concrete use in the current change.
- Follow the project's formatting and test conventions. Add focused tests when behavior changes, including boundary and failure cases.
- Keep unrelated cleanup out of the change.

## Before finishing

- Review the complete diff; remove temporary files, dead code and debug output.
- Check that names, imports, types and docs match the final behavior.
- Run the formatter, type checker and focused tests. Report any check that could not run, and why.
- Update the nearest docs when the change alters a contract, setup step or convention.

## Split, keep together, or reuse

| Situation | Do |
|---|---|
| Stable responsibility, different reason to change, or useful independent contract | New file |
| Splitting would add navigation without clarifying ownership | Keep together |
| Existing helper's meaning matches the new use | Reuse it |
| Helper would be stretched across unrelated concepts | Write a separate one |

Tests and examples use the same public behavior as production callers. For tests see the `writing-tests` and `test-first-development` skills.
