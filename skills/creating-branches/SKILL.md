---
name: creating-branches
description: Use when starting new work, creating or switching branches, choosing a branch name, untangling a working tree that mixes a feature with a dependency, migration or external-call change, or building a feature on top of an unmerged branch.
metadata:
  title: Branches
  summary: One branch, one purpose — naming by intent, splitting mixed trees and stacking on unmerged danger branches.
---

# Branches

One branch has one purpose. If you cannot name the purpose in a few words without "and", split it.

## Naming

| Purpose | Branch |
|---|---|
| Database (migrations, schema, models, seeds) | `db/<name>` |
| Dependencies (manifests, lockfiles) | `deps/<name>` |
| External communication (hosts, SDKs, sockets, config) | `net/<name>` |
| Anything else | The project's usual prefix (`feat/`, `fix/`, `refactor/`...) |

The prefix tells the atomicity hook a branch's intent before its first commit. A danger-zone commit on the default branch or on a branch without the matching prefix is blocked (R2).

Each danger branch needs a spec at `.claude/danger/<branch with / as -->.md`, e.g. `db/add-orders-index` → `.claude/danger/db--add-orders-index.md`. Use the spec template from the `atomic-changes` skill and fill every section.

## Start danger work on a new branch

```sh
git switch -c deps/add-zod
```

Do this before you edit. Creating the branch in the same command as the commit also works (`git switch -c deps/add-zod && git commit ...`). Any other branch switch chained with a commit, push or PR is blocked: run it as its own command.

## Split a mixed working tree

Your tree holds a feature plus a new dependency (or a model change, or an external call):

1. Check what is staged: `git status`.
2. Unstage everything that is not the zone you commit first: `git restore --staged <files>`.
3. Move to the danger branch; staged and unstaged changes travel with you: `git switch -c deps/add-zod`.
4. Write the spec, `git add` it with the danger files, commit.
5. Return to the feature: `git switch <feature-branch>`, stage the rest, commit.

If the feature depends on the danger change, stack it instead of switching back to an older base.

## Stacking

A feature that needs an unmerged `deps/` change goes on top of that branch:

```sh
git switch deps/add-zod
git switch -c feat/use-zod
```

- The hook judges `feat/use-zod` only on its own commits; the parent `deps/` branch is its base.
- The first commit on a freshly stacked branch may use the parent at `HEAD`.
- `git push` compares against the nearest ancestor that is the default branch or has a danger prefix.
- Open the PRs in order and give the stacked one `--base deps/add-zod` (see the `opening-pull-requests` skill).

## Already mixed

A branch mixed before the hook existed can be listed in `exempt` in `.claude/atomicity.json`. Only a human edits that file: ask the user. Prefer splitting the branch.
