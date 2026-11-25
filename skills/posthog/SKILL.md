---
name: posthog
description: Use when adding, changing or reviewing PostHog in a web or mobile UI or its backend — installing posthog-js, posthog-node or the Python SDK, initializing it in React or Next.js, identifying users, naming and capturing events, setting up a reverse proxy, keeping keys and personal data out of events — or when events are missing, duplicated, attributed to the wrong person, or blocked by ad blockers, or when querying PostHog data through its MCP server.
metadata:
  title: PostHog
  frameworks: PostHog
  summary: One client initialized once, a reverse proxy, identify on login and reset on logout, a small typed event catalog, no personal data in properties, and the PostHog MCP server for reading data instead of guessing.
---

# PostHog

PostHog is product analytics, feature flags, experiments and session replay behind one SDK. Most bugs come from setup, not from the analysis. The SDK is initialized twice, or a user is never identified, or a logout doesn't reset, or ad blockers drop events. Event names also drift across the codebase until no two dashboards agree. Get the client, the identity lifecycle and the event catalog right first. Then experiments (see the posthog-experiments skill) and recordings (see the posthog-session-replay skill) come almost for free.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Client | one `posthog.init` at app start (`instrumentation-client.ts` in Next.js 15.3+, a provider in React) | `init` inside components, re-run on every render or route |
| Keys | the project API key (`phc_…`) and host from public env vars; personal API keys only on the server | hard-coded keys; a personal API key (`phx_…`) shipped to the browser |
| Host | a reverse proxy (`/ingest`) on your own domain | `us.i.posthog.com` straight from the browser, which ad blockers drop |
| Person profiles | `person_profiles: 'identified_only'` | a person profile for every anonymous visitor |
| Identity | `posthog.identify(user.id, { plan })` after login; `posthog.reset()` on logout | email as distinct ID; no reset, so the next user on the device merges into the last |
| Accounts / teams | `posthog.group('company', orgId)` for B2B metrics | an `org_id` property copied onto every event |
| Pageviews in SPAs | the SDK's history-change pageview capture | manual `$pageview` calls next to automatic ones (double counting) |
| Event names | a typed catalog module, `object_verb` in snake_case past tense (`project_created`) | string literals scattered through components (`'Clicked Button'`, `'click_btn'`) |
| Properties | IDs, enums, counts, durations | emails, names, free text, tokens, full URLs with query secrets |
| Server events | `posthog-node` / Python with the same `distinct_id`, `await client.shutdown()` on exit | server events under a random ID; short-lived handlers that exit before the flush |
| Tests | a no-op or fake client in unit tests; `opt_out_capturing` in e2e | real events from CI polluting production data |
| Consent | `opt_out_capturing_by_default` plus `opt_in_capturing()` after consent where the law requires it | tracking before consent in the EU |
| Reading data | the PostHog MCP server (insights, HogQL, flags, errors) | guessing what users do from the code |

## Example: Next.js with a reverse proxy

```ts
// instrumentation-client.ts (Next.js 15.3+). Runs once on the client.
import posthog from 'posthog-js';

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
  api_host: '/ingest',
  ui_host: 'https://us.posthog.com', // eu.posthog.com for EU projects
  person_profiles: 'identified_only',
  capture_pageview: 'history_change',
  capture_exceptions: true,
  debug: process.env.NODE_ENV === 'development',
});
```

```ts
// next.config.ts: proxy ingestion through your own domain.
const nextConfig = {
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/ingest/static/:path*', destination: 'https://us-assets.i.posthog.com/static/:path*' },
      { source: '/ingest/:path*', destination: 'https://us.i.posthog.com/:path*' },
    ];
  },
};
export default nextConfig;
```

For a plain React app, wrap the tree once with `PostHogProvider` from `posthog-js/react` and read the client with `usePostHog()`.

## Example: identity and a typed event catalog

```ts
// analytics/events.ts: the only place event names are written.
import posthog from 'posthog-js';

type Events = {
  project_created: { project_id: string; template: 'blank' | 'starter' };
  invite_sent: { project_id: string; role: 'viewer' | 'editor' };
  checkout_completed: { plan: 'pro' | 'team'; seats: number };
};

export function track<E extends keyof Events>(event: E, props: Events[E]) {
  posthog.capture(event, props);
}

export function onLogin(user: { id: string; plan: string; orgId: string }) {
  posthog.identify(user.id, { plan: user.plan });
  posthog.group('company', user.orgId);
}

export function onLogout() {
  posthog.reset();
}
```

A type error now catches a misspelled event or a missing property. Reviewing a pull request shows every new event in one file.

## Server-side capture

```ts
import { PostHog } from 'posthog-node';

const posthog = new PostHog(process.env.POSTHOG_KEY!, { host: process.env.POSTHOG_HOST });

posthog.capture({ distinctId: user.id, event: 'subscription_renewed', properties: { plan } });
await posthog.shutdown(); // flush before a serverless handler or script exits
```

Use server events for facts the server owns, like payments, renewals and webhooks. Use the same `distinctId` as `identify` so they join the person's browser events.

## Using the PostHog MCP server

With the `posthog` MCP server (or the official PostHog plugin) connected, Claude can read the project instead of guessing. It can list and run insights, write HogQL queries, inspect feature flags and experiments, list errors and search session recordings. Use it to:

- check an event really arrives with the expected properties after you add it (query the last hour of that event)
- find the existing event name before inventing a new one
- answer product questions with numbers ("how many teams invited a second member last week?")

Authenticate through `/mcp` in Claude Code. The login picks the US or EU region from the account. Treat write tools (creating flags, experiments, dashboards) as changes to a shared production system. Say what you will create and confirm before you call them.

## Common mistakes

- **Initializing in a component.** React strict mode and route changes call `init` again. Initialize once, outside the render tree.
- **Forgetting `reset()`.** On shared devices the next user's events merge into the previous person.
- **Identifying with an email.** Emails change and are personal data. Use the stable user ID and set email as a person property only if you need it.
- **Capturing in a loop or on every keystroke.** Capture outcomes (`search_performed` with `result_count`), not input events.
- **Losing server events.** A serverless function returns before the queue flushes. Call `shutdown()` or `flush()`.
- **No proxy.** 10–30% of browser events disappear to ad blockers, and the funnels lie.

## References

- [PostHog docs](https://posthog.com/docs): product overview and SDK index
- [Next.js installation](https://posthog.com/docs/libraries/next-js): `instrumentation-client.ts`, provider, server components
- [React](https://posthog.com/docs/libraries/react): `PostHogProvider`, hooks, components
- [JavaScript configuration](https://posthog.com/docs/libraries/js/config): every `init` option
- [Reverse proxy](https://posthog.com/docs/advanced/proxy): Next.js rewrites, Vercel, Cloudflare and others
- [Identifying users](https://posthog.com/docs/product-analytics/identify): `identify`, `reset`, anonymous vs identified events
- [Group analytics](https://posthog.com/docs/product-analytics/group-analytics): company and team metrics
- [Node.js](https://posthog.com/docs/libraries/node) and [Python](https://posthog.com/docs/libraries/python) SDKs
- [PostHog MCP server](https://posthog.com/docs/model-context-protocol): setup, tools and Claude Code plugin
