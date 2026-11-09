# Modularity

Modularity is the practice of organizing a system into parts with clear responsibilities and explicit boundaries. A module groups related behavior and hides implementation details behind a small interface. Other parts of the system should need to know what the module promises, not how it fulfills that promise.

## The fundamentals

A well-shaped module aims for:

- **High cohesion:** its contents work together to support one responsibility.
- **Low coupling:** changes inside it have limited impact on other modules.
- **Explicit boundaries:** inputs, outputs, errors, and side effects are visible.
- **Information hiding:** internal data structures and implementation choices stay private unless callers need them.

Modules can be files, packages, services, or independently deployed components. Splitting code into many files does not automatically make it modular. A boundary is useful when it localizes a reason to change; too many tiny modules can scatter a simple workflow and make navigation harder.

## Example: TypeScript

Keep pricing rules in a focused module and expose a small public function:

```ts
// pricing.ts
export type LineItem = { unitPrice: number; quantity: number };

export function calculateSubtotal(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}
```

Callers depend on the exported contract:

```ts
// checkout.ts
import { calculateSubtotal, type LineItem } from "./pricing";

export function checkout(items: readonly LineItem[]) {
  const subtotal = calculateSubtotal(items);
  return { subtotal, tax: subtotal * 0.1, total: subtotal * 1.1 };
}
```

Checkout does not need to know how subtotal calculation is implemented. If pricing later gains discounts, its own module is the natural place to change the behavior and tests.

## Example: Python

Use a package module to encapsulate the same responsibility:

```python
# pricing.py
from dataclasses import dataclass


@dataclass(frozen=True)
class LineItem:
    unit_price: int  # cents
    quantity: int


def calculate_subtotal(items: list[LineItem]) -> int:
    return sum(item.unit_price * item.quantity for item in items)
```

Another module imports the public function rather than duplicating the rule:

```python
# checkout.py
from pricing import LineItem, calculate_subtotal


def checkout(items: list[LineItem]) -> dict[str, int]:
    subtotal = calculate_subtotal(items)
    tax = subtotal // 10
    return {"subtotal": subtotal, "tax": tax, "total": subtotal + tax}
```

Using integer cents avoids floating-point rounding surprises for currency. The module boundary also gives tests a focused place to verify pricing rules.

## Benefits and tradeoffs

Modularity makes code easier to understand, test, and change when boundaries follow real responsibilities. It can limit the blast radius of changes and allow teams to work independently. Poorly chosen boundaries add indirection, duplicate data transfer, and coordination overhead. Avoid circular dependencies and modules that expose their entire internal state.

## When to use it

Create a module when behavior has a cohesive responsibility, a distinct reason to change, or a useful contract that callers can rely on. Keep closely related behavior together, and split only when the new boundary reduces coupling or clarifies ownership.
