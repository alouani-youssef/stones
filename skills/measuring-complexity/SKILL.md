---
name: measuring-complexity
description: Use when asked to measure, score, compare or report code complexity or code quality metrics — cyclomatic complexity, cc_mean, max nesting depth, lines per symbol, dependency graph entropy, violation percentage — when setting complexity thresholds or a quality gate, or when checking whether a refactor actually reduced complexity.
metadata:
  title: Measuring Complexity
  summary: One metric set and one 0-100 complexity index — cc_mean, max_nesting_depth, lines_per_symbol, graph_dependency_entropy and violation_pct — collected with real analyzers, scored by a bundled script, and compared against a baseline.
---

# Measuring Complexity

A complexity number is only useful when it is measured the same way every time and compared with something: a baseline, a threshold, or the code before the change. This skill defines the metric set, how to collect it, and how to turn it into one score. The metric skills hold the details:

| Metric | What it says | Skill |
| --- | --- | --- |
| `cc` (cyclomatic complexity) | independent paths through one function | `cyclomatic-complexity` |
| `cc_mean` | average `cc` over all functions in scope | `cyclomatic-complexity` |
| `max_nesting_depth` | deepest nesting of control blocks in any function | `cyclomatic-complexity` |
| `lines_per_symbol` | code lines per declared symbol: how much each name carries | `code-quality-metrics` |
| `violation_pct` | % of functions over any per-function limit | `code-quality-metrics` |
| `graph_dependency_entropy` | how evenly internal imports spread across modules (0-1) | `dependency-entropy` |

Cognitive complexity (what the complexity hook reports) and Big O reasoning are in `managing-complexity`. This skill is about measuring a codebase, not one function's readability.

## Workflow

1. **Fix the scope.** Name the directories measured and the exclusions (generated code, vendored code, migrations, tests unless asked). Different scopes give different numbers; write the scope next to every result.
2. **Collect per-function data** with the language's analyzer (table below) into `functions: [{ name, file, cc, nesting, loc }]`.
3. **Count lines and symbols** for the same scope: `loc` is non-blank, non-comment lines; `symbols` is declared functions, methods, classes, types and exported constants.
4. **Collect import edges** between internal modules, `[[from, to], ...]`. In a project with the code graph, use `--graph .claude/graph/project.json` instead.
5. **Score** with the bundled script and save the JSON as the baseline:

   ```sh
   node .claude/skills/measuring-complexity/complexity-score.mjs metrics.json --graph .claude/graph/project.json --json > .claude/quality/complexity.json
   ```

6. **Compare** later runs with `--baseline .claude/quality/complexity.json`. Report the deltas and the worst functions, not just the index.

Never estimate metrics by reading code. If an analyzer is missing, say which metric could not be measured; the script leaves it out of the index and reports a `measured_weight` below 1.

## Collecting data per language

| Language | Per-function `cc`, nesting, loc | Imports |
| --- | --- | --- |
| Python | `radon cc -j -s src/` (cc), `lizard -l python --csv src/` (cc, nloc), `lizard -ENS` (nesting) | `pydeps --show-deps --no-output`, or the code graph |
| JS / TS | `lizard -l javascript -l typescript --csv src/`; ESLint `complexity` and `max-depth` rules with `--format json` | `madge --json src/`, `dependency-cruiser --output-type json` |
| Go | `gocyclo -over 0 .`, `lizard -l go --csv .` | `go list -json ./...` (`Imports` filtered to the module path) |
| Java / Kotlin / C# / C / C++ | `lizard --csv` (all of them), or the SonarQube API (`complexity`, `functions`, `ncloc`) | jdeps, the build tool's module graph |

`lizard` covers most languages with one command and one output format; prefer it when a project mixes languages, so `cc` is counted the same way everywhere. SonarQube (`docker compose -f .claude/analyzers/compose.yaml --profile sonarqube up -d`) gives `complexity`, `ncloc`, `functions` and `violations` for the whole project when a server is available.

## The complexity index

Each metric becomes a penalty from 0 (at or below `good`) to 1 (at or above `limit`), linear in between. The index is the weighted mean of the measured penalties, × 100.

| Metric | good | limit | weight |
| --- | --- | --- | --- |
| `violation_pct` | 5 | 25 | 0.35 |
| `cc_mean` | 4 | 10 | 0.20 |
| `max_nesting_depth` | 3 | 6 | 0.15 |
| `lines_per_symbol` | 20 | 50 | 0.15 |
| `graph_dependency_entropy` | 0.6 | 0.9 | 0.15 |

A function violates when `cc > 10`, `nesting > 4` or `loc > 60`.

| Index | Grade | Meaning |
| --- | --- | --- |
| < 20 | A | within all targets |
| 20-40 | B | a few hot spots; fix them when touching that code |
| 40-60 | C | complexity is slowing changes; plan refactors |
| 60-80 | D | widespread; new code should not make it worse |
| ≥ 80 | E | most metrics at their limits |

`violation_pct` carries the most weight because it counts functions, so one huge function cannot hide behind many small ones, which is the weakness of `cc_mean`. The defaults follow common practice (McCabe's limit of 10, SonarQube's nesting limit). Change them in `THRESHOLDS` only after measuring the codebase and agreeing what "good" means for it, and record the change. An index computed with different thresholds is not comparable.

## Reporting

Report the scope, the analyzer and version, the metrics with their deltas from the baseline, the index and grade, and the ten worst functions with `file:function`. For example:

```text
Scope: src/ (excluding src/generated), lizard 1.17, 412 functions
Complexity index 34.2 (B), Δ -6.1 since a1b2c3d
  cc_mean 3.9 (Δ -0.4) · cc p90 9 · cc max 31
  max_nesting_depth 6 · violation_pct 7.3% (Δ -2.1)
  lines_per_symbol 18.4 · graph_dependency_entropy 0.71 (412 modules, 1,380 imports)
Worst: src/billing/invoice.py:apply_discounts cc=31 nesting=6 loc=140
```

## Reading the numbers

- **A lower index is not the goal; easier change is.** Splitting one function into five trivially named helpers lowers `cc_mean` and `violation_pct` and raises `lines_per_symbol` noise and graph edges. Check the metrics together.
- **Compare like with like.** Same scope, same analyzer, same thresholds. A tool upgrade can change `cc` counting; re-baseline when it does.
- **Clean as you code.** Gate on deltas for changed files (new or worsened violations), not on the absolute index of legacy code. The complexity hook works the same way.
- **Outliers matter more than means.** Always look at `cc_max`, `cc_p90` and the worst list before the mean.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Estimating `cc` by eye | run an analyzer; report the metric as not measured if none is available |
| Including generated or vendored code | exclude it and state the exclusions |
| Comparing an index across repos or tools | compare one codebase with its own baseline |
| Optimizing the score | fix the worst functions and confirm behavior with tests |
| Reporting only the index | always include the per-metric values and the worst functions |

## References

- [McCabe, A Complexity Measure (1976)](https://www.literateprogramming.com/mccabe.pdf)
- [lizard](https://github.com/terryyin/lizard) · [radon](https://radon.readthedocs.io/) · [gocyclo](https://github.com/fzipp/gocyclo)
- [SonarQube metric definitions](https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/)
