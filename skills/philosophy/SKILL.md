---
name: philosophy
description: Use when designing a module, class, function or API, when reviewing code for design quality, when a change keeps touching many files, when a name or comment is hard to write, or when Clean Code rules (small functions, no comments) seem to conflict with deep modules and documented interfaces.
metadata:
  title: Design Philosophy
  kind: pattern
  summary: Clean Code and A Philosophy of Software Design as one practice — fight complexity with deep modules, hidden information and precise names.
---

# Design Philosophy

This skill combines two books: Robert C. Martin's *Clean Code* and John Ousterhout's *A Philosophy of Software Design*. They agree on the goal, which is code that the next reader can change safely. They disagree on some rules. Where they conflict, this skill says which rule to follow and when.

**The core idea:** complexity is anything in the structure of a system that makes it hard to understand or change. Every design decision should reduce it, or at least not add to it. The tactics below are means to that end. None of them is a goal in itself.

To measure complexity instead of reasoning about it, use `measuring-complexity`. For module boundaries specifically, use `modular-design`. For when to extract shared code, use `reusing-code`.

## Recognizing complexity

Complexity shows up in three ways:

| Symptom | What it looks like | Typical cause |
| --- | --- | --- |
| **Change amplification** | One simple change edits many places | A decision duplicated instead of owned by one place |
| **Cognitive load** | You must hold a lot in your head to make a change safely | Wide interfaces, hidden state, inconsistent names |
| **Unknown unknowns** | It is not obvious what to change, or what will break | Obscurity: dependencies and assumptions that the code does not show |

It has two causes. **Dependencies** mean code cannot be understood or changed on its own. **Obscurity** means important information is not visible where it is needed. Reduce dependencies where you can, and make the ones that remain obvious.

Complexity is incremental. It comes from many small "just this once" choices, not one big mistake. So the cost of a shortcut is never zero, even when it looks small.

## Strategic over tactical programming

*Tactical* programming means getting the feature working as fast as possible. *Strategic* programming means producing a good design that also works. Working code is not enough.

- Put a little time into design with every change. Ousterhout suggests 10–20% of development time.
- Leave each module a little better than you found it. Clean Code calls this the Boy Scout rule. Limit it to the code you are already changing. Unrelated cleanup belongs in a separate change (see `atomic-changes`).
- If the design no longer fits the requirements, refactor it so the change looks as if the design had planned for it. Do not bolt a special case onto the side.

## Deep modules

A module is anything with an interface and an implementation: a function, a class, a package or a service. Its **interface** is everything a caller must know to use it, including side effects, ordering rules and the errors it can raise. Its **implementation** is everything the caller does not need to know.

A **deep** module hides a lot of functionality behind a small interface. A **shallow** module has an interface almost as complex as what it does, so callers pay to learn it and get little in return.

```ts
// Shallow: every caller must know the cache layout, the TTL rule and the miss path.
cache.get(key); cache.isExpired(key, now); cache.set(key, value, now + TTL);

// Deep: one call; freshness, expiry and loading live behind the interface.
const user = await users.find(id);
```

- **Pull complexity downward.** When something has to be complex, the module should take that on, not its callers. A module has one implementer and many callers.
- **Prefer somewhat general-purpose interfaces.** Design the interface for the general need behind today's use case, and implement only what today needs. A general interface is usually simpler and hides more.
- **Different layer, different abstraction.** A layer that only passes calls through to the next layer adds interface without adding functionality. Merge it, or give it a real job.
- **Define errors out of existence.** Shape the semantics so the error case cannot happen. For example, `delete` of a missing key is a no-op, and a substring operation clamps its out-of-range indexes. Every exception a module throws becomes part of its interface.
- **Information hiding.** Each design decision, such as a file format, a protocol or a data layout, should live in exactly one module. If two modules both know it, they are coupled through that knowledge. That is *information leakage*, even when the two modules never call each other.
- **Avoid temporal decomposition.** Do not split code by the order things happen (read, then parse, then write). Split it by the knowledge each part needs. Steps that share knowledge belong together.

## Clean Code at the line level

These rules make individual lines and functions easy to read:

- **Meaningful names.** Names should reveal intent, be pronounceable and searchable, and use one word per concept across the codebase. Avoid encodings and Hungarian prefixes. Name classes with nouns and functions with verbs.
- **Functions do one thing at one level of abstraction.** The body reads top-down, each step one level below the function's name. This is the stepdown rule.
- **Few arguments.** Zero to two is ideal. A boolean flag argument usually means the function does two things, so split it.
- **No hidden side effects.** A function named `checkPassword` must not also start a session.
- **Command–query separation.** A function either changes state or returns information, not both.
- **Errors.** Prefer exceptions or result types to error codes. Do not return `null` and do not pass `null`. Use an empty collection, an optional type or a Null Object.
- **Law of Demeter.** Talk to your direct collaborators only. Long chains like `a.getB().getC().doIt()` mean the caller knows too much about the structure behind them.
- **SOLID** for classes, and **F.I.R.S.T.** tests: fast, independent, repeatable, self-validating and timely (see `writing-tests`).
- **Formatting is communication.** Keep related code close together and put callers above callees. Follow the project's formatter.

## When the books disagree

| Question | Clean Code says | Philosophy of Software Design says | Follow this |
| --- | --- | --- | --- |
| How long should a function be? | Very small, a few lines | Depth matters more than length | Split a function when the new piece has a name that hides real work and can be read on its own. Keep it whole when a split would only make pieces that must be read together. |
| Should code have comments? | A comment means the code failed to explain itself | Comments carry what code cannot say | If the code can be made to say it with a better name or structure, change the code. Otherwise, write the comment (see below). |
| How many small classes? | Many small classes, each with one reason to change | Too many classes cause *classitis*: lots of shallow interfaces | Each class should hide a decision. If a class only forwards calls, merge it. |
| Exceptions? | Use them instead of error codes | Each one widens the interface, so define errors out | Define the error out first. Throw only for a condition the caller can actually handle. |

## Comments that earn their place

Code shows *what* and *how*. Only comments can give the *why*, the units and invariants, and the caller-facing contract.

- **Interface comments** describe what the module does for the caller: its inputs, outputs, side effects, errors and preconditions. They should not mention how it is built.
- **Implementation comments** explain why non-obvious code is written the way it is.
- **Never repeat the code.** If a comment can be written from the line next to it, delete it.
- **Write the interface comment before the implementation.** If it is hard to write, the abstraction is wrong. Fix the abstraction before you write the code.

## Design it twice

For any module or interface that matters, sketch at least two very different designs before you pick one. Compare them on interface simplicity, generality and how much they hide. The first idea is rarely the best one. Writing the alternative down also makes the trade-off explicit for reviewers.

## Review checklist

Ask these questions about each module you touch:

1. Can I state what it does in one sentence, without "and"?
2. Is its interface much simpler than its implementation?
3. Is each design decision owned by exactly one module?
4. Could a caller misuse it without the type system or a clear error stopping them?
5. Are the names precise and consistent? If a name is hard to choose, the design is probably unclear.
6. Does every comment say something the code cannot?
7. Did I consider a second design?

For the full list of warning signs and their fixes, see [red-flags.md](red-flags.md).

## Common mistakes

- **Splitting functions until they are shallow.** Ten three-line helpers that must be read in sequence are harder to follow than one cohesive 30-line function.
- **Treating "no comments" as a rule.** Deleting interface documentation pushes the cost onto every caller.
- **Adding configuration parameters.** Each one exports a decision to the caller. Compute a sensible default inside the module instead.
- **Generalizing for imagined callers.** Make the interface general and keep the implementation specific to today's needs (see `reusing-code`).
- **Refactoring code unrelated to the task** in the name of the Boy Scout rule.
