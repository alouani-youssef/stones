# Design for Testability

Testable code makes its inputs explicit, its effects replaceable and its outcomes visible. These are the same properties that make code easy to change and reason about. Testability isn't a separate concern you bolt on.

Decide how critical behavior will be checked while shaping the design, before it is coupled to infrastructure.

## Functional core, imperative shell

The highest-leverage pattern. Put decisions in pure functions that take data and return data. Keep I/O in a thin outer layer that gathers inputs, calls the core and applies the result.

```ts
// Core: pure policy. Unit-test exhaustively, no fakes needed.
type Invoice = { id: string; dueAt: Date; paidAt?: Date; reminders: number };
type Action = { kind: 'remind'; invoiceId: string } | { kind: 'escalate'; invoiceId: string };

export function overdueActions(invoices: Invoice[], now: Date): Action[] {
  return invoices
    .filter((i) => !i.paidAt && i.dueAt.getTime() < now.getTime())
    .map((i) => (i.reminders >= 3
      ? { kind: 'escalate', invoiceId: i.id }
      : { kind: 'remind', invoiceId: i.id }));
}

// Shell: wiring and effects. One integration test proves the wiring.
export async function runOverdueJob(deps: {
  invoices: { listUnpaid(): Promise<Invoice[]> };
  mailer: { remind(id: string): Promise<void> };
  escalations: { open(id: string): Promise<void> };
  clock: { now(): Date };
}) {
  const actions = overdueActions(await deps.invoices.listUnpaid(), deps.clock.now());
  for (const a of actions) {
    if (a.kind === 'remind') await deps.mailer.remind(a.invoiceId);
    else await deps.escalations.open(a.invoiceId);
  }
}
```

Why it works: every business case (due today, one ms overdue, paid late, third reminder) is a one-line unit test on `overdueActions`, with no mocks and no clock tricks. The shell has almost no branches, so one or two integration tests cover it.

## Seams: where to make code replaceable

A seam is a place where a test can substitute behavior without editing the code under test. Add them at real sources of variation and effects, nowhere else.

| Source | Seam | Test substitute |
| --- | --- | --- |
| Current time, timers | `Clock` parameter or injected `now` | Fixed or advanceable clock; framework fake timers if already used |
| Random values, UUIDs | `IdGenerator` / `Random` injected | Sequence or seeded generator |
| Database | Repository interface (see `repository-pattern`) | In-memory implementation for units; real engine for integration |
| HTTP / third-party APIs | Narrow client interface owned by you | Fake implementing that interface; contract or mock server at the boundary |
| Filesystem | Pass paths or a small storage interface | Temp directory per test |
| Environment / config | Parse once at startup into a typed config object | Construct config directly |
| Message queues, email, logging that matters | Port interface (`Publisher`, `Mailer`) | Recording fake that captures calls |

Inject through constructors or function parameters (see `dependency-injection`). Choose concrete implementations at the composition root. Don't reach for module-level mocking (`jest.mock`, monkey-patching) when a parameter would do. It couples tests to import paths and hides the dependency.

## Make outcomes observable

- **Return results, don't just cause effects.** `applyDiscount(cart) → Cart` beats mutating a global cart.
- **Use typed errors or result values** for expected failures, so tests can assert the reason and not just "it threw".
- **Record effects at a boundary.** A recording fake (`sent: Email[]`) lets a test assert *what* was sent, not *that a method was called with matching args*.
- **Prefer state over interaction checks.** Assert the saved order or the returned value. Verify calls only when the call *is* the contract (exactly one charge, no email on failure).
- **Never make something public only for a test.** If a test needs a private helper, that helper is probably its own unit with its own public interface.

## Control nondeterminism

- Inject the clock; never call `Date.now()` / `datetime.now()` deep in logic.
- Seed or inject randomness and ID generation.
- Wait for conditions, not durations: poll for the expected state with a timeout, or await the event. No `sleep`.
- Give each test its own data: unique IDs, a transaction rolled back, or a fresh schema or temp dir.
- Make ordering explicit. Don't depend on hash-map iteration order or unordered query results.
- Pin locale, timezone and floating-point tolerance where they affect output.

## Smells and refactors

| Smell | Why it hurts | Refactor |
| --- | --- | --- |
| Constructor does `new DbClient()` / reads env vars | Can't run without infrastructure | Pass the dependency in; build it at the composition root |
| Logic and I/O interleaved in one long function | Every test needs every fake | Extract the decision into a pure function; leave a thin shell |
| Test needs 4+ mocks | Unit has too many responsibilities | Split by responsibility; group collaborators behind one port |
| Singleton / global state | Tests leak into each other | Pass the instance; scope lifetime explicitly |
| Static helper calls the network | Can't substitute | Wrap in an interface you own; inject it |
| Behavior depends on a private field | Must poke internals to test | Return the value or expose a query method that's part of the contract |
| UI component fetches data and renders | Rendering tests need a server | Container/presentational split; test presentational with props |
| Framework handler holds business logic | Must boot the framework to test a rule | Humble object: handler parses and delegates to a plain function |

## Legacy code with no seams

1. **Pin current behavior** with characterization tests at the outermost practical level (run the CLI and compare output, hit the endpoint) before changing anything.
2. **Introduce one seam** at the point you need to change, e.g. extract a parameter defaulting to the current global: `function report(clock: Clock = systemClock)`.
3. **Extract the decision** into a pure function and unit-test it.
4. **Change behavior** test-first against the new seam.
5. Keep the characterization tests until the new unit tests cover the same cases, then delete the redundant ones.

## When not to add a seam

- Pure functions and value objects need no abstraction. Call them directly.
- Don't wrap a stable, fast, deterministic library (a date-formatting lib, a JSON parser) just to mock it.
- One implementation plus a fake is fine. Don't build a plugin system because tests needed a second implementation.
- If a seam exists only to verify a call your test made happen, you're testing the test.
