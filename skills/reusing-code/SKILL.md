---
name: reusing-code
description: Use when the same rule or logic appears in more than one place, when tempted to extract a shared helper, utility or library, or when an existing helper is collecting flags and special cases.
metadata:
  title: Reusability
  kind: pattern
  summary: Share a rule once it has a real second use, with a small contract and only the variation callers need.
---

# Reusability

Reusability is the ability to apply a piece of behavior in more than one context without copying its implementation. Reusable code has a clear purpose, a stable contract, and only the variation points that real callers need.

## The fundamentals

Reuse can happen at several levels: a function shared by call sites, a module shared by features, a library shared by applications, or a service accessed over a network. Start with the narrowest level that serves the current need.

Good reuse removes duplicated knowledge. If the same business rule is copied in two places, the copies can drift; one named function or module gives that rule a single owner. But similar-looking code is not necessarily the same rule. Combining unrelated behavior behind a configurable abstraction can make every caller harder to understand.

Useful reusable components have:

- A focused responsibility and descriptive name.
- A small input/output contract, with behavior callers can predict.
- Few configuration options, added only for demonstrated use cases.
- No hidden dependence on a specific caller's global state or environment.

## Example: TypeScript

Instead of duplicating a pagination rule in several API handlers, share a small function:

```ts
type PageRequest = { page?: number; pageSize?: number };
type Page = { limit: number; offset: number };

export function toPage(request: PageRequest): Page {
  const page = Math.max(1, request.page ?? 1);
  const limit = Math.min(100, Math.max(1, request.pageSize ?? 20));
  return { limit, offset: (page - 1) * limit };
}
```

Each endpoint reuses the policy while supplying its own query:

```ts
const { limit, offset } = toPage(request.query);
const rows = await orders.list({ limit, offset });
```

The shared function centralizes defaults and bounds. If one endpoint genuinely has a different policy, make that difference explicit rather than adding speculative flags to this function.

## Example: Python

The same reusable rule can be expressed as a pure function:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Page:
    limit: int
    offset: int


def to_page(page: int | None = None, page_size: int | None = None) -> Page:
    current = max(1, page if page is not None else 1)
    limit = min(100, max(1, page_size if page_size is not None else 20))
    return Page(limit=limit, offset=(current - 1) * limit)
```

Handlers can call `to_page` and pass the result to their own repositories. Because the helper has no I/O or global state, it is easy to reuse and test.

## Benefits and tradeoffs

Reuse reduces duplication, keeps shared rules consistent, and can lower the cost of future changes. An abstraction also has a maintenance cost: it needs a contract, documentation, and compatibility decisions. Over-generalized utilities collect flags and special cases, while premature reuse can couple features that should evolve independently.

## When to use it

Extract a reusable component when a rule is repeated or when multiple callers clearly need the same capability. Keep it local until there is a real second use; generalize only after the shared requirements are understood. Prefer a little duplication over a misleading abstraction when the behaviors only look alike.
