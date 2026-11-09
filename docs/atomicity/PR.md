# Pull Requests

One story per PR. A reviewer should be able to say what it does, why, and how to undo it in one sentence each.

## Danger-zone order

Land danger changes first, each as its own PR, then the feature that uses them:

1. `deps/` - the package is added and merged.
2. `db/` - the migration is generated and merged.
3. `net/` - the new external call or config is merged.
4. `feat/` - the feature that uses them.

The hook checks the PR before it opens. `gh pr create` without `--base` is judged against the default branch, so a stacked PR must pass the parent explicitly:

```
gh pr create --base deps/add-zod --title "..." --body "..."
```

Without `--base`, a feature branch stacked on an unmerged `deps/` branch looks like it mixes zones and is blocked (R2). A danger-zone PR must have its valid spec committed on the branch (R3).

## Shape

- Title states the single change, in the project's commit style.
- Small enough to review in one sitting; no drive-by refactors or formatting churn.
- Every commit builds and passes on its own.
- Never mix a danger zone with other changes. Tests and docs for the change may ride along.

## Description template

```
## Summary
[What changes and why, in two or three sentences.]

## Zone
[db | packages | network | none]

## Spec link
[.claude/danger/<branch with / as -->.md, or "n/a" for a non-danger PR]

## Risk
[What can break and for whom.]

## Rollback
[How to undo it. For db: reversible? what happens to existing data. For packages: how to pin back. For network: how to turn the call off.]

## Verification
[Commands run and results; what was checked by hand.]
```

For a danger PR, Zone, Risk, Rollback and Verification repeat the spec; keep them consistent.
