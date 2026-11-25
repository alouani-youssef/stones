# Category: page

A page or screen: a route in a web app, with its data loading, layout and states. KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line.

The Core Web Vitals defaults are the "good" thresholds published on web.dev: LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1. Placeholder: `{{breakpoints}}` = 360, 768 and 1280 px wide.

## correctness

`page.state-render-failures == 0 cases`. Load the page with slow data (loading state), empty data, failing data and normal data, intercepting requests with Playwright `page.route()` or MSW. Each state renders what the spec says. Details: `cases` and `failures`.

## consistency

`page.layout-violations == 0 violations`. The page uses the app's shared layout, navigation, headings hierarchy and design tokens, rather than a one-off copy of them. Details: `runs` (checks made) and `divergent` (the departures).

## latency

- `page.lcp <= 2500 ms`: a Lighthouse lab run with mobile throttling (`npx lighthouse <url> --output json`, or Lighthouse CI with `lhci autorun`). Take the median of 3 runs.
- `page.inp <= 200 ms`: play the main interactions in Playwright with the `web-vitals` library's `onINP` attached, or use the Lighthouse timespan mode.

Details: `load` (throttling, device and run count), `count`, `p50`, `p95`, `p99`. For lab metrics with few runs, put the median in `p50` and the worst in `p99`.

## memory

`page.navigation-growth <= 10 %`. Navigate to the page and away 20 times in one session, then compare `performance.memory` or a CDP heap snapshot (`HeapProfiler`) before and after, with GC forced. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

Not applicable: a page's cost is measured as LCP and INP, and a list that must scale is its own `ui-component` task.

## failure-recovery

`page.failed-call-recoveries == 0 failures`. Make each API the page calls fail (abort, 500 or timeout through `page.route()`), then recover. The page shows its error state, keeps the rest usable, and recovers on retry or refresh. Details: `faults_injected` and `recovered`.

## exception-handling

`page.console-errors == 0 errors`. Capture `page.on('console')` (type `error`) and `page.on('pageerror')` while playing every scenario. Details: `inputs` (scenarios played) and `undefined_errors` (the messages).

## results

`page.scenarios-failing == 0 scenarios`, checked by both. Play every task scenario end to end in a real browser (Playwright), against the running app. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `page.cls <= 0.1 score`: from the same Lighthouse run as LCP.
- `page.axe-violations == 0 violations`: `@axe-core/playwright` on the page in each state.
- `page.breakpoint-failures == 0 breakpoints`: render at `{{breakpoints}}`. Check that nothing overflows horizontally (`document.documentElement.scrollWidth <= innerWidth`), nothing overlaps, and every control is reachable. Add screenshots per breakpoint.
- `page.meta-failures == 0 checks`: the route answers 200, and the page has a `<title>`, a meta description and a canonical link when it is public.
