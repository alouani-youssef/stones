# Branches

One branch has one purpose. If you cannot name the purpose in a few words without "and", split it.

## Naming

| Purpose | Branch |
|---|---|
| Database (migrations, schema, models, seeds) | `db/<name>` |
| Dependencies (manifests, lockfiles) | `deps/<name>` |
| External communication (hosts, SDKs, sockets, config) | `net/<name>` |
| Anything else | The project's usual prefix (`feat/`, `fix/`, `refactor/`...). |

The prefix is how the hook knows a branch's intent before its first commit. A danger-zone commit on the default branch or on a branch without the matching prefix is blocked (R2).

Each danger branch needs a spec at `.claude/danger/<branch with / as -->.md`, for example `db/add-orders-index` -> `.claude/danger/db--add-orders-index.md`. Copy [SPEC_TEMPLATE.md](SPEC_TEMPLATE.md) and fill every section.

## Start danger work on a new branch

```
git switch -c deps/add-zod
```

Do this before you edit. Creating the branch in the same command as the commit also works (`git switch -c deps/add-zod && git commit ...`); any other branch switch chained with a commit, push or PR is blocked, so run it as its own command.

## Split a mixed working tree

Your tree holds a feature plus a new dependency (or a model change, or an external call). Separate them before committing:

1. Check what is staged: `git status`.
2. Unstage everything that is not the zone you commit first: `git restore --staged <files>`.
3. Move the danger files to their own branch; staged and unstaged changes travel with you:
   `git switch -c deps/add-zod`
4. Write the spec, `git add` it with the danger files, and commit.
5. Return to the feature work: `git switch <feature-branch>`, stage the rest, commit.

If the feature depends on the danger change, stack it (below) instead of switching back to an older base.

## Stacking

A feature that needs an unmerged `deps/` change goes on top of that branch:

```
git switch deps/add-zod
git switch -c feat/use-zod
```

- The hook judges `feat/use-zod` only on its own commits; the parent `deps/` branch is its base.
- The first commit on a freshly stacked branch may use the parent at `HEAD`.
- `git push` compares against the nearest ancestor that is the default branch or has a danger prefix.
- Open the PRs in order and give the stacked one `--base deps/add-zod` (see [PR.md](PR.md)).

## Already mixed

A branch that was mixed before the hook existed can be listed in `exempt` in `.claude/atomicity.json`. Only a human edits that file; ask the user. Prefer splitting the branch.
