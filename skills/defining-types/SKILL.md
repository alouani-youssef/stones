---
name: defining-types
description: Use when defining or changing types, interfaces, schemas, DTOs or data models, typing a public function or module boundary, or handling JSON, env vars, user input, database rows or other untrusted data.
metadata:
  title: Type Definition Principles
  summary: Types that make valid states easy to express, invalid states hard to represent, and untrusted data validated at the boundary.
---

# Type Definition Principles

Types describe the values a program accepts and the guarantees callers can rely on. Make valid states easy to express, invalid states hard to represent, and assumptions visible at the point of use.

## Make contracts explicit

- Type public functions, module boundaries, and data crossing a network, persistence or process boundary.
- Names carry domain meaning and units (`timeout_ms`, `price_cents`), not just storage shape.
- Keep types next to the behavior they describe. Export only what consumers need.
- Use the narrowest useful type: a literal, enum or union for a small known set instead of a free string.
- Represent optional values explicitly; distinguish "not provided" from `null` or empty when behavior differs.

## Model states, not bags of optionals

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };
```

A discriminant records which fields belong together. Prefer composition; use inheritance only when the subtype relationship matters to callers. Avoid broad base types that force consumers to handle fields they do not need.

## Validate untrusted data

Static types do not validate JSON, env vars, user input, database rows or another process's output. Treat it as unknown, check it at runtime at the boundary, then convert it to a trusted domain type.

```ts
const raw: unknown = JSON.parse(text);
if (!isUser(raw)) throw new Error('Invalid user payload');
// `raw` can now be used as a User.
```

## Per language

| Language | Rules |
|---|---|
| TypeScript / JavaScript | `unknown` over `any`, narrowed by validation. Match the surrounding `interface`/`type` style. Unions for exclusive states, `readonly` when mutation isn't in the contract. No assertions that silence the compiler without a check. Explicit types on exports when inference would widen the contract. |
| Python | Annotate public functions, returns and key structures with the project's Python version syntax. Use `None` explicitly and handle it before use. Dataclasses or typed models over loose dicts for stable shapes. Annotations do not validate at runtime. |
| Go | Named types for domain concepts that must not mix. Return and check errors; no sentinel values that look like data. Pointers only for absence, mutation or avoiding copies; document nil behavior. Small interfaces defined next to the consumer. |

## Keep types maintainable

- One authoritative definition when sharing does not create unwanted coupling.
- No speculative generics; add type parameters when they remove real duplication.
- Do not mirror implementation details callers should not depend on.
- Change types and runtime validation together when a data contract changes.
