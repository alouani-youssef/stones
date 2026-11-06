# Reasoning About Complexity

Complexity describes how the work or resources required by an algorithm change as its input grows. It helps compare approaches and anticipate bottlenecks; it does not replace measurements of the real application.

## Cognitive complexity

Cognitive complexity is about how difficult code is for a person to follow. Deep nesting, many branches, implicit state changes, and long functions increase the mental work needed to understand a path. Splitting code into small named operations, using guard clauses, and making state explicit can help.

```ts
// A guard clause keeps the main path easy to scan.
function ship(order: Order): void {
  if (order.cancelled) return;
  if (!order.address) throw new Error("Missing address");
  sendToCarrier(order);
}
```

Do not split code just to shorten a function: a helper should have a clear name and meaningful responsibility. Excessive indirection can make control flow harder to discover.

## Time and space complexity

Big O notation describes how an algorithm scales as the input size `n` grows. It focuses on growth rather than exact runtime, and usually omits constant factors. Common growth rates include:

| Complexity | Typical example | Effect of doubling input |
| --- | --- | --- |
| `O(1)` | Read an array element by index | Roughly unchanged |
| `O(log n)` | Binary search in sorted data | Adds about one step |
| `O(n)` | Scan a list once | Roughly doubles work |
| `O(n log n)` | Efficient comparison sort | A little more than doubles work |
| `O(n²)` | Compare every pair | Roughly quadruples work |

Space complexity describes extra memory as input grows. For example, building a set from `n` values takes `O(n)` extra space but can reduce repeated membership checks from `O(n)` each to average `O(1)` each.

```python
def has_duplicate(values: list[str]) -> bool:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            return True
        seen.add(value)
    return False
```

This algorithm takes `O(n)` expected time and `O(n)` extra space. A nested scan could use constant extra space but take `O(n²)` time.

## Unknown unknowns

An unknown unknown is a factor that was not anticipated during design. In performance work, these often include production data sizes, skewed distributions, concurrency, network latency, cache behavior, and third-party service limits. Complexity analysis helps identify possible scaling risks, but profiling representative workloads reveals which risks matter in practice.

Design for observability: measure latency, throughput, memory, and the size/shape of inputs. Record assumptions (for example, “this list is bounded to a few dozen entries”) and revisit them when the system or data changes. Prefer robust algorithms when the cost is small; benchmark before adding complicated optimization.

## Change cost

Change cost is the total effort and risk involved in modifying a system. It includes locating the behavior, understanding it, changing it, checking related behavior, and safely releasing it. Tight coupling, duplicated rules, unclear names, broad side effects, and weak test seams increase that cost.

Patterns such as dependency injection and repositories can reduce change cost when they isolate a real boundary. They can raise it when they add layers without hiding meaningful complexity. Optimize for cohesive responsibilities, explicit contracts, and tests around important behavior—not for the number of abstractions.

## Practical approach

1. State the input size and workload assumptions.
2. Identify the dominant operations and their time and memory growth.
3. Consider edge cases such as empty, very large, or highly skewed inputs.
4. Measure with representative data before optimizing.
5. Re-check readability and change cost after an optimization.
