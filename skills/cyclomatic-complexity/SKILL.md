---
name: cyclomatic-complexity
description: Use when computing or interpreting cyclomatic complexity (McCabe cc) per function, cc_mean across a module or project, or max nesting depth, when an analyzer such as radon, lizard, gocyclo or ESLint complexity / max-depth flags a function, or when deciding how many tests a function needs.
metadata:
  title: Cyclomatic Complexity and Nesting
  summary: Counting McCabe cc and nesting depth correctly, why cc_mean hides outliers, and refactors that remove paths instead of hiding them.
---

# Cyclomatic Complexity and Nesting

Cyclomatic complexity (`cc`) counts the linearly independent paths through a function. It is also the minimum number of test cases that cover every branch. Nesting depth measures how many control blocks enclose the deepest statement. A high `cc` means many paths to test; deep nesting means a reader has to hold many conditions in mind at once. They often occur together, but they are different problems.

The combined metric set and the complexity index are in `measuring-complexity`.

## Counting `cc`

On the control-flow graph: `M = E − N + 2P` (edges, nodes, connected components; P = 1 for one function). In practice analyzers count **1 + one per decision point**:

| Adds 1 | Python | JS / TS | Go |
| --- | --- | --- | --- |
| condition | `if`, `elif` | `if`, `else if` | `if` |
| loop | `for`, `while`, comprehension `for` / `if` | `for`, `for…of/in`, `while`, `do` | `for` |
| case | `case` (match) | `case` | `case` (non-default) |
| exception | `except` | `catch` | — |
| boolean operator | `and`, `or` | `&&`, `\|\|`, `??` | `&&`, `\|\|` |
| conditional expression | `x if c else y` | `c ? x : y`, `?.` (some tools) | — |

`else`, `finally`, `default` and `try` add nothing. Tools differ on boolean operators, `?.` and `??`, which is why one analyzer must be used for a whole codebase. Example:

```python
def shipping_cost(order):            # 1
    if order.cancelled:              # +1 → 2
        return 0
    cost = 0
    for item in order.items:         # +1 → 3
        if item.fragile and item.heavy:  # +1 +1 → 5
            cost += 15
        elif item.heavy:             # +1 → 6
            cost += 10
    return cost                      # cc = 6, needs ≥ 6 tests for full branch coverage
```

| `cc` | Reading |
| --- | --- |
| 1-4 | simple |
| 5-10 | fine; test each branch |
| 11-20 | hard to test fully; split when you change it |
| > 20 | refactor before adding behavior |

## `cc_mean`

`cc_mean = Σ cc(f) / number of functions`, over the same scope and exclusions every time. It is a trend metric. Because most functions are small, a mean of 3 can hide a function with `cc = 60`. Always report it with `cc_p90` and `cc_max`. Don't compare means between codebases with different coding styles: many one-line getters pull the mean down without making anything simpler.

## Max nesting depth

Depth counts enclosing control blocks inside a function body: `if`, `for`, `while`, `switch` / `match`, `try`, `with`, and nested callbacks or closures that contain control flow. The function body is depth 0; a statement inside one `if` is depth 1.

```ts
function sync(users: User[]) {           // depth 0
  for (const u of users) {               // 1
    if (u.active) {                      // 2
      try {                              // 3
        if (u.email) send(u);            // 4 → max_nesting_depth = 4
      } catch (e) { log(e); }
    }
  }
}
```

`max_nesting_depth` for a scope is the maximum over its functions; report which function it comes from. Over 4 is hard to read (ESLint `max-depth` and SonarQube S134 default to 4 and 3 respectively, so configure them to the same limit).

Tools: `lizard -ENS` (nested structures), ESLint `max-depth`, `radon` doesn't measure it. For Python without lizard, an `ast.NodeVisitor` that increments on `If/For/While/Try/With/Match` and records the maximum is ten lines.

## Refactors that reduce it

| Smell | Refactor | Effect |
| --- | --- | --- |
| nested `if` precondition checks | guard clauses with early return | nesting −1 per guard; `cc` unchanged |
| long `if/elif` over a type or code | lookup table or polymorphism | `cc` drops to ~1 at the call site |
| loop body with branches | extract the body into a named function | splits `cc` between two testable units |
| compound conditions repeated | name the predicate (`is_billable(order)`) | readability; `cc` moves into one tested place |
| flag arguments that switch behavior | separate functions per behavior | removes a branch per flag |

Extracting code moves `cc` to another function, it doesn't remove it. That helps when each piece can be named, understood and tested on its own. Removing paths (a table instead of branches, a type that makes a state impossible) is the real reduction. Run the tests before and after; the refactor must not change behavior.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Counting `else` as a branch | only decisions add; `else` is the other edge of the `if` |
| Mixing analyzers between runs | pin one tool and version per codebase |
| Reporting `cc_mean` alone | add `cc_p90`, `cc_max` and the worst functions |
| Splitting functions to pass the gate | split only into units with a meaningful name and their own tests |

## References

- [McCabe, A Complexity Measure (1976)](https://www.literateprogramming.com/mccabe.pdf)
- [NIST SP 500-235: Structured Testing using cyclomatic complexity](https://www.nist.gov/publications/structured-testing-software-testing-methodology-using-cyclomatic-complexity-metric)
- [lizard](https://github.com/terryyin/lizard) · [radon cc](https://radon.readthedocs.io/en/latest/intro.html#cyclomatic-complexity) · [ESLint complexity](https://eslint.org/docs/latest/rules/complexity) · [ESLint max-depth](https://eslint.org/docs/latest/rules/max-depth)
