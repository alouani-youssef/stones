# Category: ui-component

A reusable UI component: a button, form control, dialog, table or widget, in React, Vue, Svelte or similar. KPIs and thresholds live in `../categories.json`. Defaults are starting points; change them per project in `.claude/evaluation.json`, or per task with a confirmed `Override:` line or `NA:` line. For example, mark `failure-recovery` `NA:` for a component that makes no calls.

Placeholder: `{{states}}` = default, loading, empty, error and disabled. List the component's real states in the spec.

## correctness

`ui-component.state-render-failures == 0 cases`. Render the component in every state with Testing Library, Vitest or Jest, or with Storybook stories plus the test runner. Assert what the user sees: text, roles and enabled or disabled controls, not implementation details. Details: `cases` (states and props combinations) and `failures`.

## consistency

`ui-component.design-system-violations == 0 violations`. Check that colours, spacing and type come from the design tokens (Stylelint rules, or grep for hex values and pixel literals), and that prop names follow sibling components (`onChange`, not `handleChange`; `disabled`, not `isDisabled`, if that is the house style). Details: `runs` (files checked) and `divergent` (the violations).

## latency

`ui-component.render-p95 <= 16 ms`: one frame at 60 Hz, after the main prop change. Use a production build with the React Profiler `onRender` (`actualDuration`), Vue devtools performance, or `performance.now()` around updates, over 100 changes. Details: `load` (which prop and how many changes), `count`, `p50`, `p95`, `p99`.

## memory

`ui-component.mount-growth <= 5 %`. Mount and unmount the component 100 times, force a GC (`--expose-gc` in the test runner, or Chrome DevTools in Playwright with `page.evaluate(() => gc())` and `--js-flags=--expose-gc`), and compare the heap before and after. Growth means listeners, timers or subscriptions are left behind. Details: `input_size`, `runs`, `peak_mb`, `steady_mb`.

## big-o

`ui-component.list-scaling <= 1.5 ratio`, for components that render collections. Render 10× and 100× the items and compare the growth with the claim (linear, or constant with virtualization). Mark `NA:` for components without a collection. Details: `sizes`, `timings`, `claimed`.

## failure-recovery

`ui-component.failed-call-recoveries == 0 failures`. Make each call the component makes fail (MSW or a stand-in), then succeed. The error state shows, and retry (or the next attempt) recovers. Details: `faults_injected` and `recovered`.

## exception-handling

`ui-component.uncaught-errors == 0 errors`. Pass missing, null and malformed props and data. The component renders a defined fallback, or its error boundary catches the error; nothing reaches the page as an uncaught error. Details: `inputs` and `undefined_errors`.

## results

`ui-component.scenarios-failing == 0 scenarios`, checked by both. Play every task scenario in the running app (Playwright), where the component is actually used. The user signs the outcome (advisory). Details: `scenarios` and `failing`.

## task-kpis

- `ui-component.axe-violations == 0 violations`: run `@axe-core/playwright` (`new AxeBuilder({ page }).analyze()`) or `jest-axe` in every state, counting violations of all impacts.
- `ui-component.keyboard-operable`, signed by the human: the reviewer uses the component with the keyboard only (Tab, Shift+Tab, Enter, Space, Escape and arrow keys where the pattern calls for them). Every action works and focus is always visible (advisory).
- `ui-component.visual-diff <= 0.1 %`: Playwright `expect(locator).toHaveScreenshot()` per state against the approved baseline (or Chromatic or Percy), recording the differing-pixel ratio.
- `ui-component.bundle-added <= 10 KB` gzipped: build the production bundle with and without the component (`vite build` with `rollup-plugin-visualizer`, `size-limit`, or `source-map-explorer`), and compare.
- `ui-component.rerenders <= 1 renders` per single prop change: React Profiler or why-did-you-render, counting renders of the component and its children.
