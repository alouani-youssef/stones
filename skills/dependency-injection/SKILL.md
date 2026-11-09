---
name: dependency-injection
description: Use when a class or function constructs its own database, HTTP, email, clock or other infrastructure client, when tests cannot swap a collaborator, or when wiring services with constructors or a DI container (NestJS, Angular, Spring).
metadata:
  title: Dependency Injection
  kind: pattern
  summary: Collaborators passed in rather than constructed inside, with concrete choices made at the composition root.
---

# Dependency Injection

Dependency injection (DI) is a way to provide an object or function with the collaborators it needs instead of having it construct those collaborators itself. The code that wires the application together chooses concrete implementations; business logic depends on the capabilities it needs.

## The fundamentals

Suppose an order service needs to save an order and send a receipt. If it directly creates a database client and an email client, its business logic is tied to those technologies. Injecting a repository and a mailer lets the service express the workflow while the application supplies database-backed and SMTP-backed implementations.

Common injection forms are:

- **Constructor injection:** pass dependencies when creating an object. This makes required dependencies explicit and is usually the clearest default.
- **Function or parameter injection:** pass a dependency to a function for a one-off operation.
- **Property or setter injection:** assign a dependency after construction. This can represent optional dependencies, but allows objects to exist in an incomplete state.

DI is not the same as a dependency injection framework. A small application can wire dependencies with ordinary constructors and functions. A container is useful when a large application has many lifetimes, scopes, or composition rules, but it adds its own conventions and indirection.

## Example: TypeScript

```ts
type Order = { id: string; email: string };

interface OrderRepository {
  save(order: Order): Promise<void>;
}

interface Mailer {
  sendReceipt(address: string, orderId: string): Promise<void>;
}

class PlaceOrder {
  constructor(
    private readonly orders: OrderRepository,
    private readonly mailer: Mailer,
  ) {}

  async execute(order: Order): Promise<void> {
    await this.orders.save(order);
    await this.mailer.sendReceipt(order.email, order.id);
  }
}

// Composition root: choose implementations at the application boundary.
const placeOrder = new PlaceOrder(postgresOrders, smtpMailer);
```

The use case knows the interfaces it needs, not how PostgreSQL or SMTP is configured. A test can pass in small in-memory fakes.

## Example: Python

```python
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Order:
    id: str
    email: str


class OrderRepository(Protocol):
    def save(self, order: Order) -> None: ...


class Mailer(Protocol):
    def send_receipt(self, address: str, order_id: str) -> None: ...


class PlaceOrder:
    def __init__(self, orders: OrderRepository, mailer: Mailer) -> None:
        self.orders = orders
        self.mailer = mailer

    def execute(self, order: Order) -> None:
        self.orders.save(order)
        self.mailer.send_receipt(order.email, order.id)


# Application startup supplies concrete adapters.
place_order = PlaceOrder(postgres_orders, smtp_mailer)
```

Python protocols describe the required shape without forcing implementations to inherit from a base class. Duck-typed fakes can be injected in tests.

## Benefits and tradeoffs

DI makes dependencies visible, supports replacing infrastructure, and makes isolated tests easier. It also introduces interfaces and wiring code. Avoid injecting every value or wrapping a simple function in an abstraction without a real boundary. Keep object construction close to the application entry point, and keep domain logic free of service-locator lookups or global container access.

## When to use it

Use DI when behavior relies on replaceable infrastructure (storage, clocks, network clients), when tests need controlled collaborators, or when object construction otherwise leaks into business logic. For pure calculations with no collaborators, a plain function is often enough.
