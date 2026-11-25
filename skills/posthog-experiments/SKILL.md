---
name: posthog-experiments
description: Use when adding a feature flag or an A/B test to a UI with PostHog, choosing experiment variants, goal and guardrail metrics, rendering a variant in React or Next.js without flicker, evaluating flags on the server, testing variants locally, reading or shipping experiment results, or cleaning up a flag after rollout — or when an experiment shows no exposures, uneven variants or results that look too good.
metadata:
  title: PostHog experiments
  frameworks: PostHog
  summary: A hypothesis and one primary metric decided before launch, flags read once at the decision point so exposure is tracked, variants bootstrapped to avoid flicker, results read at the planned sample size, and every flag removed after the decision.
---

# PostHog experiments

An experiment in PostHog is a multivariate feature flag plus metrics. The flag splits users into `control` and test variants. Reading the flag records an exposure (`$feature_flag_called`). The metrics compare what exposed users did next. Results are only as good as three things. The hypothesis and metric must be fixed before launch. Exposure must be recorded where the user actually sees the difference. And the code must render the same variant on every visit.

Set up the SDK first (see the posthog skill). To watch how users in each variant behave, see the posthog-session-replay skill.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Hypothesis | written down first: "Changing X will move metric Y by Z for audience A" | launching and then looking for any metric that moved |
| Primary metric | one funnel or mean metric tied to the hypothesis, plus 1–3 guardrails (errors, churn, revenue) | ten primary metrics, so one wins by chance |
| Flag key | `exp-<area>-<change>` (`exp-checkout-one-page`), variants `control` and `test` | reusing a release flag as an experiment |
| Reading the flag | `useFeatureFlagVariantKey('key')` or `getFeatureFlag('key')` in the component that renders the difference | reading every flag at app start, which marks users exposed who never saw the change |
| Flicker | `bootstrap` flags from the server, or render a neutral skeleton until flags load | rendering control, then swapping to test a moment later |
| Server rendering | evaluate on the server with `posthog-node` and the same distinct ID, pass the variant to the client | client and server evaluating with different IDs and disagreeing |
| Unknown flag | treat `undefined` (not loaded, flag off, or error) as control | an `if (variant === 'control')` branch that shows test to everyone else |
| Local testing | `posthog.featureFlags.overrideFeatureFlags({ flags: { key: 'test' } })` or the toolbar | editing the rollout in production to see a variant |
| Sample size | the duration and sample PostHog's calculator suggests; decide at that point | stopping the first day a variant looks significant |
| Changes mid-test | none; a changed variant or metric is a new experiment | editing the test variant while it runs |
| After the decision | ship the winner, then delete the flag and the losing branch in code | flags still in the code a year later |
| Creating via MCP | describe the flag, variants, metrics and rollout; confirm before creating | the agent creating and launching experiments on its own |

## Example: a variant in React without flicker

```tsx
import { useFeatureFlagVariantKey } from 'posthog-js/react';

export function CheckoutPage() {
  // Read the flag where the difference is rendered: this is what records the exposure.
  const variant = useFeatureFlagVariantKey('exp-checkout-one-page');

  if (variant === undefined) return <CheckoutSkeleton />; // flags not loaded yet
  return variant === 'test' ? <OnePageCheckout /> : <MultiStepCheckout />;
}
```

For pages the user sees before flags load, bootstrap them. Evaluate on the server and pass the result to `init`:

```ts
// server (route handler, middleware or server component)
const flags = await posthogNode.getAllFlags(distinctId);

// client
posthog.init(key, {
  api_host: '/ingest',
  bootstrap: { distinctID: distinctId, featureFlags: flags },
});
```

The distinct ID must be the same on both sides: the logged-in user's ID, or an anonymous ID you set in a cookie before evaluating.

## Example: server-side flag in an API

```ts
const variant = await posthog.getFeatureFlag('exp-pricing-annual-default', user.id);
const defaultInterval = variant === 'test' ? 'annual' : 'monthly';
```

Server evaluation calls PostHog on every check unless you enable local evaluation. Local evaluation needs a feature flags secure API key (or a personal API key) on the server and polls flag definitions. Use it for hot paths.

## Planning and reading an experiment

1. **Write the hypothesis and the decision rule** in the pull request or ticket. Example: "Ship `test` if checkout conversion improves, and error rate and refund rate don't get worse."
2. **Pick metrics from events that already exist.** Check them through the PostHog MCP server (query the event over the last 30 days) so the baseline is real.
3. **Create the experiment** in PostHog, or through the MCP server after confirming the setup. Leave it in draft until the code is merged and deployed.
4. **Verify exposures** right after launch. Exposures for both variants should appear within minutes, split roughly as configured. A heavily uneven split usually means the flag is read in only one branch of the code.
5. **Wait for the planned sample.** PostHog uses a Bayesian engine by default and reports the chance each variant is best. Don't stop early because a number looks good.
6. **Decide, ship and clean up.** "Ship variant" in PostHog rolls the winner out to everyone. Then remove the flag check and the losing code path in a follow-up change.

## Common mistakes

- **Exposure recorded too early.** Calling `getFeatureFlag` in a global layout marks every visitor exposed, which dilutes the effect toward zero.
- **No exposure at all.** Reading flags with `getAllFlags` on the client or from a cached object doesn't send `$feature_flag_called`. Use the single-flag functions or hooks, or `PostHogFeature`.
- **Different users per variant.** Anonymous users who log in mid-funnel get a new distinct ID unless `identify` links them. Identify before the step you measure.
- **Peeking and stopping.** Repeatedly checking and stopping at the first significant result inflates false positives.
- **Test traffic in results.** Internal users and test accounts should be filtered out (PostHog's "filter out internal and test users" setting).
- **Flag debt.** Every experiment flag left in the code is a branch nobody tests. Track the cleanup as part of the experiment.

## References

- [Experiments](https://posthog.com/docs/experiments): overview and lifecycle
- [Creating an experiment](https://posthog.com/docs/experiments/creating-an-experiment): variants, metrics, rollout
- [Adding experiment code](https://posthog.com/docs/experiments/adding-experiment-code): client and server snippets per SDK
- [Experiment metrics](https://posthog.com/docs/experiments/metrics): funnel, mean and ratio metrics, guardrails
- [Statistics](https://posthog.com/docs/experiments/statistics): Bayesian and frequentist engines
- [Feature flags](https://posthog.com/docs/feature-flags): flags, payloads and rollout conditions
- [Bootstrapping flags](https://posthog.com/docs/feature-flags/bootstrapping): avoiding flicker on first load
- [Local evaluation](https://posthog.com/docs/feature-flags/local-evaluation): fast server-side flag checks
- [Testing flags](https://posthog.com/docs/feature-flags/testing): overrides and the toolbar
