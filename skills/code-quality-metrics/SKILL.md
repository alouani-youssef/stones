---
name: code-quality-metrics
description: Use when computing or interpreting code quality metrics beyond complexity — lines per symbol, violation percentage, lint or SonarQube violation density, function length, duplication — when defining per-function limits for a quality gate, or when reporting how much of a codebase breaks its own rules.
metadata:
  title: Code Quality Metrics
  summary: lines_per_symbol and violation_pct defined precisely, counted from analyzer output, and read as trends against a baseline rather than targets to game.
---

# Code Quality Metrics

Two metrics describe how code is distributed and how much of it breaks agreed limits: `lines_per_symbol` (how much code each named unit carries) and `violation_pct` (what share of functions exceed a limit). Both are cheap to compute and are easy to game, so define them precisely and report them with the data behind them.

The combined metric set and the complexity index are in `measuring-complexity`; `cc` and nesting are in `cyclomatic-complexity`.

## `lines_per_symbol`

```text
lines_per_symbol = loc / symbols
loc     = non-blank, non-comment lines in scope (NLOC / SonarQube ncloc)
symbols = declared functions, methods, classes, interfaces / types, and exported constants
```

Local variables, parameters and imports are not symbols. Count with the same tool every time: `lizard` (`nloc` and function count), `cloc --json` for `loc` plus the analyzer's function and class count, or SonarQube's `ncloc` / (`functions` + `classes`).

| Value | Reading |
| --- | --- |
| < 5 | fragmented: many tiny wrappers; check for indirection without purpose |
| 5-20 | typical for readable code |
| 20-50 | large units; look at the longest functions and classes |
| > 50 | a few names carry most of the code (god functions or classes) |

Also compute it per file and list the top files; the project value is a mean and hides them, like `cc_mean`. Data tables, fixtures and generated code inflate it — exclude them.

## `violation_pct`

```text
violation_pct = 100 × functions violating at least one limit / functions measured
```

The default per-function limits, shared with `complexity-score.mjs`:

| Limit | Default | Why |
| --- | --- | --- |
| `cc` | > 10 | McCabe's original limit; above it, full branch testing gets impractical |
| nesting | > 4 | beyond this, readers lose track of the enclosing conditions |
| `loc` | > 60 | about one screen; longer functions usually do several things |
| cognitive complexity (optional) | > 15 | SonarQube S3776 default; what the complexity hook checks |

A function counts once however many limits it breaks, so the metric reads as "share of the code that needs attention". Keep the list of violating functions: the percentage is the summary, the list is what gets fixed.

### Lint violation density

When the question is about linter or SonarQube issues rather than function limits, use density instead: `issues per 1,000 loc`, split by severity. Count from machine output (`eslint -f json`, `ruff check --output-format json`, `golangci-lint run --out-format json`, SonarQube `violations` / `ncloc`). Don't add style-only rules (formatting, import order) to a quality metric; a formatter fixes those.

## Gates that work

- **Gate on new code.** Fail a change that adds a violating function or makes a violating one worse. Legacy violations stay visible in the report, not in the gate. SonarQube's "new code" quality gate and the complexity hook both do this.
- **Agree on limits once.** Record them with the baseline; an edited limit starts a new baseline.
- **Report the list, not just the percentage.** `violation_pct` can drop because many small functions were added; the worst offenders may be untouched.
- **Suppressions are visible.** Count `# noqa`, `eslint-disable` and `//nolint` lines and report them next to the metric.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Counting comments and blank lines as `loc` | use NLOC / ncloc |
| Counting a function once per broken limit | at least one limit → one violating function |
| Mixing style lint with quality violations | count quality rules only |
| Lowering `lines_per_symbol` by adding wrappers | split only where the new name says something the code didn't |

## References

- [SonarQube metric definitions](https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/)
- [SonarQube Clean as You Code](https://docs.sonarsource.com/sonarqube-server/latest/core-concepts/clean-as-you-code/introduction/)
- [lizard](https://github.com/terryyin/lizard) · [cloc](https://github.com/AlDanial/cloc)
