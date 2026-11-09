---
name: repository-pattern
description: Use when code loads or saves domain objects through an ORM, SQL or a document store, when business logic imports a database client directly, or when deciding whether a repository layer is worth adding.
metadata:
  title: Repository Pattern
  kind: pattern
  summary: A collection-like persistence boundary expressed in domain language, keeping storage details out of use cases.
---

# Repository Pattern

The repository pattern gives application or domain logic a collection-like interface for loading and saving domain objects. A repository hides the details of persistence—SQL, a document store, or an in-memory collection—behind operations expressed in the language of the application.

## The fundamentals

A repository is responsible for persistence access, not for the business rules that decide whether an operation is valid. A useful boundary commonly includes operations such as `findById`, `save`, and `delete`, or a domain-specific query such as `findOpenOrdersForCustomer`.

The application service coordinates a use case, the repository performs persistence, and a mapper or ORM translates between stored rows and domain objects when needed. Keep the interface as small as the callers need. Avoid generic CRUD abstractions that force every entity into the same operations or expose database query builders to the domain.

## Example: TypeScript

```ts
type CustomerId = string;

type Order = {
  id: string;
  customerId: CustomerId;
  status: "open" | "paid";
};

interface OrderRepository {
  findById(id: string): Promise<Order | null>;
  save(order: Order): Promise<void>;
}

class PayOrder {
  constructor(private readonly orders: OrderRepository) {}

  async execute(id: string): Promise<void> {
    const order = await this.orders.findById(id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "open") throw new Error("Order is not open");

    await this.orders.save({ ...order, status: "paid" });
  }
}
```

`PayOrder` owns the use-case rule; an adapter implements `OrderRepository` with SQL, while a test can use an in-memory implementation.

## Example: Python

```python
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Order:
    id: str
    customer_id: str
    status: str


class OrderRepository(Protocol):
    def find_by_id(self, order_id: str) -> Order | None: ...
    def save(self, order: Order) -> None: ...


class PayOrder:
    def __init__(self, orders: OrderRepository) -> None:
        self.orders = orders

    def execute(self, order_id: str) -> None:
        order = self.orders.find_by_id(order_id)
        if order is None:
            raise ValueError("Order not found")
        if order.status != "open":
            raise ValueError("Order is not open")

        order.status = "paid"
        self.orders.save(order)
```

The protocol is the persistence boundary. A concrete adapter can use a database session; a dictionary-backed fake can support fast unit tests.

## Benefits and tradeoffs

Repositories reduce persistence coupling and give application code a stable place to express domain-oriented queries. They can also add unnecessary indirection when an application is a thin CRUD layer or when an ORM already provides the needed abstraction. Keep complex filtering and pagination in the persistence adapter rather than loading entire tables into memory. Define transaction boundaries at the use-case or unit-of-work level when several writes must succeed together.

## When to use it

Use a repository when domain/application behavior should remain independent of storage, when persistence needs a focused test seam, or when queries have meaningful domain names. Do not create one mechanically for every table if it only forwards every ORM method unchanged.
