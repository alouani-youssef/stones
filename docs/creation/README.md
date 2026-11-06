# Creation Guidelines

Use these steps when adding a file, module, type, test, or other project artifact. The goal is to make each addition fit the project’s existing structure and have a clear reason to exist.

## Before creating something

1. Read the nearest related implementation, its callers, and its tests. Check whether the same responsibility already has an established owner.
2. Identify the behavior or contract the new artifact will provide. Prefer extending a cohesive existing module when that is clearer than adding another layer.
3. Decide which inputs are trusted, which can fail, and what the caller should observe when they do.
4. Choose the smallest useful boundary. A new module should have a distinct responsibility or a contract that callers benefit from using.
5. Pick the name and location using the project’s existing conventions. See [Naming Conventions](../naming/README.md).

## While implementing

- Keep one main responsibility per file. Group closely related types and helpers with the behavior that owns them.
- Make dependencies and side effects visible. Pass collaborators into a module when doing so clarifies its contract or makes behavior easier to exercise.
- Validate external data at the boundary, then pass validated values into domain logic. See [Type Definition Principles](../types/README.md).
- Handle expected errors deliberately. Preserve useful context, and avoid swallowing failures that callers need to act on.
- Avoid adding a dependency, abstraction, or configuration option without a concrete use case in the current change.
- Follow the project’s formatting and test conventions. Add or update focused tests when behavior changes, including important boundary and failure cases.
- Keep unrelated cleanup out of the change so reviewers can see what the new behavior requires.

## Before finishing

- Review the complete diff and remove temporary files, dead code, and debug output.
- Check that names, imports, types, and documentation match the final behavior.
- Run the relevant formatter, type checker, and focused tests available in the project. Report any checks that could not be run and why.
- Update the nearest documentation when the new behavior changes a contract, setup step, or project convention.

## When to split or reuse

Create a new file when the behavior has a stable responsibility, a different reason to change, or a useful independent contract. Keep code together when splitting it would add navigation without clarifying ownership. Reuse an existing helper when its meaning matches the new use; avoid stretching a helper across unrelated concepts just to reduce line count.

Tests and examples should use the same public behavior as production callers. For test structure and verification, see the [Testing Guides](../testings/README.md) and [TDD Guide](../tdd/README.md).
