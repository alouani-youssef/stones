# Atomicity hook reference

## How the hook reads your command

- `git add -u` / `-A` / `.` chained with `git commit` is evaluated as already staged.
- Env prefixes and wrappers are seen through: `HUSKY=0 git commit`, `env git commit`, `command git commit`, `/usr/bin/git commit`.
- `git switch -c X` / `git checkout -b X` chained before a commit is evaluated as branch `X`. Any other branch switch in the same command as a commit, push or PR is blocked with "run the branch switch as its own command". Run it separately.
- `gh pr create` without `--base` is judged against the default branch. For a stacked PR pass `--base <parent-branch>`; the block message suggests it when a danger-prefixed parent is nearer.
- `git push` is judged against the nearest ancestor branch that is the default branch or has a danger prefix. The first commit on a freshly stacked branch may use the parent at `HEAD`.
- The default branch counts as its local copy, `origin/<default>` and its upstream, whichever is nearest, so a stale local `main` does not drag teammates' merged changes into your branch. `gh pr create --base X` likewise uses the nearer of `X` and `origin/X`.
- `git switch -c X && git push` pushes the current branch's history under a new name, so it is judged like a push of the current branch.
- Concluding a merge, cherry-pick or revert (`MERGE_HEAD`, `CHERRY_PICK_HEAD` or `REVERT_HEAD` exists) skips R1: the staged set is other commits being brought in. The branch's own history is still checked.
- Git runs in the tool call's working directory (`cwd`), so a commit in a worktree or subdirectory is judged on that checkout and branch, and R4 resolves relative paths from there. Configuration is always read from the project's `.claude/atomicity.json`.
- The spec is checked on the danger commit itself (it may be in the same commit) and again on push and PR.

## Network details

- Your own API is not network. Relative URLs (`fetch('/api/x')`), `localhost`, `127.0.0.1`, `*.local`, `example.com`, and client calls with a variable argument are not flagged.
- Identifiers that look like URLs are not network: XML namespaces and JSON schemas (`w3.org`, `json-schema.org`, `schemastore.org`, any `"$schema"` / `"$id"` key), and `package.json` metadata (`homepage`, `repository`, `bugs`, `url`, `funding`, `author`...).
- Comment-only lines (starting with `//`, `#`, `/*`, `*` or `<!--`) are not checked, so `// see https://github.com/...` stays code. A URL after code on the same line still counts.
- Hosts you trust (your own services, a docs site) go in `zones.network.allowHosts` as host globs, e.g. `["*.acme.io", "github.com"]`.
- When a file is network because of its content, the block message prints `<file>: <line>`.
- Defining incoming routes is not network unless `network.incoming` is `true`.
- The content check only looks at added lines of non-neutral files, so a test that adds `fetch(` stays neutral.

## Configuration

`.claude/atomicity.json` is written by `init` and owned by the project. Only a human edits it: the hook blocks agent writes to it, `exempt` included. Never work around the block; ask the user.

| Key | Meaning |
|---|---|
| `enabled` | `false` turns the hook off. |
| `exempt` | Branch names that skip R1-R3 (for branches already mixed when the hook was installed). Human-only. |
| `defaultBranch` | Branch treated as the base for judging (default `main` if present, else detected from `origin/HEAD`, then `master`). |
| `specDir` | Where specs live (default `.claude/danger`). |
| `prefixes` | Branch prefix per zone (`db/`, `deps/`, `net/`). |
| `zones.<zone>.paths` / `extraPaths` | `paths` replaces the built-in path list; `extraPaths` adds to it. |
| `zones.network.patterns` / `extraPatterns` | Content patterns, replace or add. |
| `zones.network.ignore` | Globs the network content check skips. It skips content checks only; a path-classified file (such as `.mcp.json`) stays network. |
| `zones.network.allowHosts` | Host globs the URL check trusts (default `[]`), e.g. `["*.acme.io"]`. |
| `zones.network.incoming` | `true` makes new incoming routes count as network (default `false`). |
| `migrations.dirs` | Directories treated as generated migrations. |
| `migrations.generate` | Generator command shown in block messages. Leave it empty only with `allowEdits: true` for hand-written migration tools. |
| `migrations.allowEdits` | `true` allows hand edits in migration dirs (default `false`). |

## When the hook cannot decide

It never blocks on its own failure. Internal errors, a non-git directory, a detached `HEAD` or no resolvable default branch allow the command with a one-line note such as `atomicity: not a git repo, skipped`. Branch checks are skipped with a stated reason; R1 and R4 still run where they can.
