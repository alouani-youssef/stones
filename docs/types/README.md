# Type Definition Principles

Types describe the values a program accepts and the guarantees its callers can rely on. Prefer definitions that make valid states easy to express, invalid states hard to represent, and important assumptions visible at the point of use.

## Make contracts explicit

- Add types to public functions, module boundaries, and data that crosses a network, persistence, or process boundary.
- Use names that communicate the domain meaning and units of a value (`timeout_ms`, `price_cents`), rather than its storage shape alone.
- Keep types close to the behavior they describe. Export a type when consumers need it; keep implementation-only types private.
- Prefer the narrowest useful type. Use a literal, enum, or union for a small known set of values instead of an unconstrained string.
- Represent optional values explicitly, and distinguish “not provided” from `null` or an empty value when the behavior differs.

## Model states and relationships

Use a type that records which fields belong together. A discriminant is often clearer than a group of unrelated optional fields:

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };
```

Prefer composition for reusable, independent pieces. Use inheritance or embedding only when the subtype relationship is meaningful to callers. Avoid broad base types that force consumers to handle fields or behaviors they do not need.

## Validate untrusted data

Static types do not validate JSON, environment variables, user input, database rows, or values received from another process. Treat external data as unknown until it has been checked at runtime, then convert it into a trusted domain type. Keep parsing and validation near the boundary so the rest of the code can rely on the validated contract.

```ts
const raw: unknown = JSON.parse(text);
if (!isUser(raw)) throw new Error('Invalid user payload');
// `raw` can now be used as a User.
```

## Language guidance

### TypeScript and JavaScript

- Prefer `unknown` over `any`; narrow it with validation before use.
- Use `interface` or `type` consistently with the surrounding code. Use unions for mutually exclusive states and `readonly` when mutation is not part of the contract.
- Avoid assertions that silence the compiler without checking the value. Assertions are appropriate only when a boundary or invariant has already established the fact.
- Give exported functions and shared data explicit types when inference would hide or widen the public contract.

### Python

- Annotate public functions, return values, and important data structures. Use standard collection and union types supported by the project’s Python version.
- Use `None` explicitly for nullable values, and handle it before dereferencing.
- Prefer dataclasses or typed models for structured domain data over unstructured dictionaries when the shape is stable.
- Keep runtime validation for external inputs; annotations alone do not enforce types at runtime.

### Go

- Use named types for domain concepts when they prevent accidental mixing or give a concept meaningful methods.
- Return errors explicitly and check them at the call site. Avoid sentinel values that can be confused with valid data.
- Use pointers only when absence, mutation, or avoiding a copy is part of the design; document nil behavior where it matters.
- Keep interfaces small and define them near the consumer that needs them.

## Keep types maintainable

- Do not duplicate a type definition when one authoritative definition can be shared without creating unwanted coupling.
- Avoid speculative generic abstractions. Introduce type parameters when they remove real duplication while preserving clear constraints.
- Do not use types to mirror implementation details that callers should not depend on.
- Update types and runtime validation together when a data contract changes.

For creating a new module, see [Creation Guidelines](../creation/README.md). For file and directory conventions, see [Naming Conventions](../naming/README.md).
