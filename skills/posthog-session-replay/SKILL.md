---
name: posthog-session-replay
description: Use when enabling or tuning PostHog session replay in a web UI — masking inputs and personal data, blocking sensitive elements, sampling, minimum duration and URL or event triggers, recording console and network activity, linking recordings to Sentry errors or experiment variants — or when reviewing recordings through the PostHog MCP server to find UX friction, or when recordings are missing, blank or show data they shouldn't.
metadata:
  title: PostHog session replay
  frameworks: PostHog
  summary: Recordings on with every input masked and sensitive elements blocked, sampling and triggers set so the budget goes to sessions that matter, errors and experiment variants linked to recordings, and recordings reviewed by question, not at random.
---

# PostHog session replay

Session replay records the DOM of a user's visit so you can watch what happened. It is the fastest way to see why a funnel step drops or an error happens. It is also the easiest way to leak personal data into a third-party system. Set privacy first. Then decide which sessions are worth recording, and link recordings to the errors and experiments you already track.

Set up the SDK first (see the posthog skill). To compare variants of an A/B test, see the posthog-experiments skill.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Turning it on | enable replay in project settings; keep `disable_session_recording` unset | starting recordings by hand on some pages and forgetting others |
| Inputs | `maskAllInputs: true` (the default) | unmasking inputs to "see what users type" |
| Text | `maskTextSelector` for areas showing personal data, or `'*'` in apps that are mostly user data | recording names, balances and messages in clear text |
| Sensitive elements | the `ph-no-capture` class on payment forms, documents, avatars | relying on masking alone for card fields and IDs |
| Network | `recordHeaders` / `recordBody` off unless needed; if on, strip auth headers and secrets | recording request bodies with tokens and passwords |
| Volume | sampling, minimum duration, and URL or event triggers in replay settings | recording every 2-second bounce and paying for it |
| Experiments | link recording to the experiment flag so every exposed session is kept | sampled-out sessions in the variant you want to study |
| Errors | `posthog.sentryIntegration()` in Sentry, so each Sentry event links to its recording | hunting for the recording by timestamp |
| Login / logout | `identify` and `reset` as in the posthog skill, so recordings belong to the right person | one recording stitched across two users |
| Environments | recordings off in local dev and CI | test runs filling the recordings list |
| Reviewing | a question first, then filters (event, URL, variant, error, rage clicks) via the UI or MCP | watching random recordings |

## Example: privacy-first configuration

```ts
posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
  api_host: '/ingest',
  person_profiles: 'identified_only',
  disable_session_recording: process.env.NODE_ENV !== 'production',
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '[data-private], .user-content',
    recordHeaders: false,
    recordBody: false,
  },
  enable_recording_console_log: true,
});
```

```tsx
// Never recorded: the element is replaced by a placeholder of the same size.
<div className="ph-no-capture">
  <CardNumberField />
</div>

// Text is masked, layout and clicks are kept.
<p data-private>{user.fullName}</p>
```

Check masking on a real recording after every change to a page with personal data. Open the replay and confirm nothing readable is left. Code review alone doesn't prove it.

## Example: link Sentry errors to recordings

```ts
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  integrations: [
    posthog.sentryIntegration({
      organization: 'your-sentry-org',
      projectId: 1234567, // the Sentry project ID
    }),
  ],
});
```

Each Sentry event now carries a link to the PostHog person and recording, and PostHog gets a `$exception` event. With both the `posthog` and `sentry` MCP servers connected, Claude can start from a Sentry issue, open the stack trace, find the linked session, and see what the user did right before the error.

## Recording only what you'll use

Configure these in the project's replay settings. They take effect without a deploy:

- **Sampling**: record a percentage of sessions. Start at 100% on low traffic and lower it as volume grows.
- **Minimum duration**: drop sessions shorter than a few seconds.
- **URL triggers**: record only sessions that reach the pages you care about (`/checkout`, `/onboarding`).
- **Event triggers**: start recording when an event happens (`checkout_started`, `$exception`).
- **Linked feature flag**: record only users with a flag, such as an experiment or a beta.

When the code knows a session matters, call `posthog.startSessionRecording()`. Use it after an error boundary catches something, or when a user opens a support chat. To get a link for a bug report or support ticket, use `posthog.get_session_replay_url({ withTimestamp: true })`.

## Reviewing recordings with the MCP server

Start from a question. Example: "Why do 40% of users drop between plan selection and payment in `test`?" Then:

1. Get the experiment or funnel through the PostHog MCP server to know the variant keys and steps.
2. List recordings filtered by the flag variant, the URL or event where users drop, and a date range. Compare 5–10 recordings per variant rather than one.
3. Look for rage clicks, dead clicks, console errors, layout shifts and long pauses before leaving.
4. Write down patterns with recording links, and turn each into a fix or a new hypothesis. A recording is evidence for a hypothesis. It doesn't prove the effect. The experiment metric does.

Recordings contain real user behaviour. Quote what users did, not personal details, in tickets and pull requests.

## Common mistakes

- **Blank or broken recordings.** Styles loaded from a domain PostHog can't reach, or canvas and cross-origin iframes not enabled (`recordCanvas`, `recordCrossOriginIframes`), replay as blank boxes.
- **No recordings at all.** Replay is off in project settings, the domain isn't in the authorized domains list, or the proxy doesn't forward `/ingest/static`.
- **Leaking data through text.** `maskAllInputs` covers inputs only. Rendered names, emails and messages need `maskTextSelector` or `ph-no-capture`.
- **Sampling away the experiment.** Low global sampling leaves too few recordings per variant. Link recording to the experiment's flag.
- **Recording internal staff.** Exclude internal users or recordings fill with your own team's testing.

## References

- [Session replay](https://posthog.com/docs/session-replay): overview
- [Installation](https://posthog.com/docs/session-replay/installation): enabling replay per SDK and framework
- [Privacy controls](https://posthog.com/docs/session-replay/privacy): masking inputs and text, blocking elements
- [Controlling which sessions are recorded](https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record): sampling, minimum duration, URL, event and flag triggers
- [Network and console recording](https://posthog.com/docs/session-replay/network-recording): headers, bodies, performance
- [Troubleshooting](https://posthog.com/docs/session-replay/troubleshooting): missing and broken recordings
- [Sentry integration](https://posthog.com/docs/libraries/sentry): linking Sentry errors and PostHog recordings
- [Sentry MCP server](https://docs.sentry.io/product/sentry-mcp/): issues, traces and root-cause analysis from Claude Code
- [PostHog MCP server](https://posthog.com/docs/model-context-protocol): experiments and recordings tools
