---
name: dependency-entropy
description: Use when measuring how tangled a codebase's internal dependencies are — graph_dependency_entropy, import graphs, fan-in and fan-out, hub modules, dependency cycles — when building a module graph with madge, pydeps, dependency-cruiser, go list or the code graph, or when judging whether a restructuring reduced coupling.
metadata:
  title: Dependency Graph Entropy
  summary: Normalized Shannon entropy of the internal import graph, read together with cycles, fan-in and fan-out to tell clear layering from a tangle.
---

# Dependency Graph Entropy

`graph_dependency_entropy` measures how evenly internal imports spread across the modules of a codebase. Low entropy means imports concentrate on a few modules (a core that most code depends on). High entropy means every module is imported about as often as every other, so the graph has no clear center or layers. It is one number for the shape of the graph; cycles and fan-out give the detail.

The combined metric set and the complexity index are in `measuring-complexity`.

## Building the graph

Nodes are internal modules (files, or packages when files are too fine). Edges are imports from one internal module to another. Exclude third-party packages, the standard library, tests and generated code, and choose one granularity for the whole run.

| Source | Command |
| --- | --- |
| Code graph (ai-stones) | `.claude/graph/project.json`: `files[path].imports` are internal edges; pass it with `--graph` |
| JS / TS | `npx madge --json src/` (object of `file: [imports]`), or `dependency-cruiser --output-type json` |
| Python | `pydeps src/pkg --show-deps --no-output --only pkg` (JSON of `imports`) |
| Go | `go list -json ./...`, keep `Imports` that start with the module path |

Convert any of these to `edges: [["from", "to"], ...]` for `complexity-score.mjs`. Drop self-imports and duplicate edges.

## The formula

With `E` unique edges and `in(i)` the number of edges pointing at module `i`:

```text
p_i = in(i) / E
H   = −Σ p_i · log2 p_i                 (bits)
graph_dependency_entropy = H / log2 |V|  (0 to 1, V = all modules in the graph)
```

Normalizing by `log2 |V|` makes graphs of different sizes comparable: 1.0 means imports land evenly on every module, 0 means they all land on one. Small worked example, edges `a→core, b→core, c→core, c→b` over 4 modules: `p = (3/4, 1/4)`, `H = 0.811` bits, normalized `0.811 / 2 = 0.41`. A clear core; low entropy.

| Normalized entropy | Typical shape |
| --- | --- |
| < 0.4 | strongly centered: a few modules everyone uses (check those hubs are stable) |
| 0.4-0.6 | layered: shared core plus feature modules |
| 0.6-0.8 | spreading: features import each other, not only the core |
| > 0.8 | no structure: imports spread evenly, changes ripple unpredictably |

These bands are a starting point. Compare a codebase with its own baseline, at the same granularity, rather than with other projects.

## Read it with these

Entropy says how spread the edges are, not whether they are wrong. Report it with:

- **Cycles**: strongly connected components with more than one module (`madge --circular`, `dependency-cruiser` `no-circular`). Any cycle is worth fixing regardless of entropy.
- **Fan-in hubs**: the top modules by `in(i)`. A hub that changes often is a risk even when entropy is low.
- **Fan-out**: modules that import many others are doing too much or sit at the top of a layer.
- **Instability** per module, `I = out / (in + out)`: stable (low I) modules should not depend on unstable (high I) ones.

A low score with a cycle through the core is worse than a medium score with no cycles.

## Reducing it

| Finding | Change |
| --- | --- |
| features importing each other | move the shared piece into the core, or depend on an interface the core owns |
| a cycle | extract the shared part into a third module, or invert one edge with dependency injection (`dependency-injection`) |
| one hub that every change touches | split it by responsibility; keep the stable part in the hub (`modular-design`) |
| deep relative imports across features | expose a public entry module per feature and import only that |

Measure again after the change: entropy, cycles and the top hubs. A move that lowers entropy by adding a giant "utils" hub has only hidden the coupling.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Counting third-party imports | internal edges only |
| Mixing file and package nodes | one granularity per run |
| Raw entropy compared between repos | use the normalized value and the repo's own baseline |
| Treating low entropy as always good | check hubs and cycles too |

## References

- [Shannon, A Mathematical Theory of Communication (1948)](https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf)
- [Robert C. Martin, OO Design Quality Metrics (instability)](https://linux.ime.usp.br/~joaomm/mac499/arquivos/referencias/oodmetrics.pdf)
- [madge](https://github.com/pahen/madge) · [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) · [pydeps](https://github.com/thebjorn/pydeps)
