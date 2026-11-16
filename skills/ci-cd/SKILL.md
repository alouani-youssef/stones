---
name: ci-cd
description: Use when setting up or changing a CI or CD pipeline on any platform, deciding which checks gate a merge or a release, planning a deployment, release, rollback or database migration rollout, or when the pipeline is slow, flaky, skipped, or lets broken builds reach main or production.
metadata:
  title: CI/CD
  summary: A main branch that is always releasable, fast ordered quality gates, one immutable artifact promoted through environments, backward-compatible migrations, and deploys that are gradual, observed and reversible.
---

# CI/CD

**Continuous integration** means everyone merges small changes into main often, and every merge is built and checked automatically, so main is always in a releasable state. **Continuous delivery** means any commit on main can go to production by pressing a button, and **continuous deployment** presses it automatically. Both need the same foundation: a trusted pipeline, one artifact, and deploys that are cheap to undo.

For writing the workflows on GitHub, see the github-actions skill.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Branching | short-lived branches (hours to a few days) merged to main behind required checks | long-running feature branches and merge weeks |
| Unfinished work | feature flags, so code can merge before it is switched on | holding a branch open until "it's done" |
| Feedback time | under ~10 minutes for PR checks; slow suites in parallel or after merge | a 45-minute pipeline that people learn to ignore |
| Gate order | cheapest and most likely to fail first: format → lint → typecheck → unit → build → integration → e2e | e2e first, so a typo costs 30 minutes |
| Same checks everywhere | CI runs the same commands developers run locally (`make check`, `npm run check`, `.claude/tools/quality-check.mjs`) | CI-only scripts nobody can reproduce |
| Reproducibility | lockfiles, pinned tool versions, `npm ci` / `uv sync --locked` | resolving dependencies fresh on every build |
| Artifacts | build once per commit; version it (git SHA); promote that same artifact through staging and production | rebuilding per environment, so production runs something untested |
| Configuration | per-environment config and secrets injected at deploy or run time | environment-specific builds, or secrets in the repository |
| Database changes | expand → migrate → contract, with each step deployable and reversible on its own | a migration that breaks the previous app version mid-deploy |
| Rollout | rolling, blue-green or canary, with health checks and automatic rollback | stopping everything and replacing it in place |
| After deploy | smoke tests plus error-rate and latency alerts tied to the release | "deployed" meaning "the command exited 0" |
| Flaky tests | quarantine with an owner and a deadline; fix the cause | retry-until-green, which hides real races |
| Supply chain | dependency and secret scanning, an SBOM, signed provenance for released artifacts | trusting whatever the registry served today |
| Measuring | the four DORA metrics: deploy frequency, lead time, change failure rate, time to restore | counting pipeline runs |

## A pipeline, stage by stage

| Stage | Runs on | Gate | Typical checks |
| --- | --- | --- | --- |
| Pre-merge | every PR push | required to merge | format, lint, typecheck, unit tests, build, fast integration tests, dependency and secret scan, task scope (see the tracking-tasks skill) |
| Post-merge | every push to main | blocks promotion | the full test suite, e2e, build and publish of the versioned artifact, provenance |
| Staging | each new artifact | automatic | deploy the artifact, run migrations, smoke tests, contract tests against real neighbours |
| Production | approval or automatic | health checks | canary or rolling deploy of the *same* artifact, smoke tests, watch error rate and latency, roll back automatically on regression |
| Release | tags or a release job | — | version from commits (semver), changelog, publish packages, attach SBOM and attestations |

Main must stay green. A failing main is the team's first priority: revert the change first and investigate afterwards.

## Example: a breaking schema change, shipped without downtime

The app and the database deploy separately, so for a while the old and new app versions both run against the same schema. Every step must work with both versions.

| Release | Database | Application |
| --- | --- | --- |
| 1. Expand | add the `email_normalized` column (nullable) | writes both `email` and `email_normalized`; reads `email` |
| 2. Migrate | backfill `email_normalized` in batches | unchanged |
| 3. Switch | add the constraint or index now that the data is complete | reads `email_normalized` |
| 4. Contract | drop `email`, once no running version reads it | stops writing `email` |

Each row is its own change, pipeline run and deploy, and each can be rolled back on its own. Keep migrations in separate changes from feature code (see the atomic-changes skill).

## Deploys that can be undone

- **Rollback is a pipeline path, not a plan.** Redeploy the previous artifact with one command, and practise it. Forward-only fixes are fine when they are just as fast.
- **Progressive delivery.** Send a canary or a small percentage of traffic first, compare its error rate and latency with the baseline, then widen. Use feature flags to separate *deploying* code from *releasing* behaviour.
- **Health checks gate traffic.** Use readiness checks that test real dependencies, so a broken instance never receives traffic.
- **Every deploy is visible.** Record which artifact, commit, author and time, and mark it on your dashboards, so "what changed?" takes seconds to answer.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Works on my machine", fails in CI | different commands, versions or unpinned dependencies | one shared check command; lockfiles; pinned tool versions |
| Production differs from staging | artifact rebuilt per environment | build once, promote the same artifact |
| Deploy breaks during rollout | schema change incompatible with the running version | expand / migrate / contract |
| People merge on red "because it's flaky" | flaky tests tolerated | quarantine with an owner; fix the cause; keep the gate strict |
| PRs wait an hour for checks | slow tests on every push, run serially | parallelise; move slow suites after merge; cache dependencies |
| Rollback takes an incident call | rollback never automated or practised | one-command redeploy of the previous artifact, rehearsed |
| Secrets leak through build logs | secrets baked into builds or printed | inject at runtime; mask; rotate on exposure |

## References

- [Continuous Integration](https://martinfowler.com/articles/continuousIntegration.html): Martin Fowler's description of the practice and why it works
- [Trunk-Based Development](https://trunkbaseddevelopment.com/): short-lived branches, release strategies, feature flags
- [DORA capabilities and metrics](https://dora.dev/guides/): the measures that predict delivery performance
- [Feature Toggles](https://martinfowler.com/articles/feature-toggles.html): types of flags and how to retire them
- [Canarying releases](https://sre.google/workbook/canarying-releases/): Google SRE guidance on progressive rollout
- [Evolutionary Database Design](https://martinfowler.com/articles/evodb.html): migrations that keep the app and schema deployable together
- [The Twelve-Factor App: Config](https://12factor.net/config): configuration in the environment, not in the build
- [SLSA](https://slsa.dev/): supply-chain levels for build integrity and provenance
