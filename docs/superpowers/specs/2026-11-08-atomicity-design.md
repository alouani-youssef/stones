# Atomicity & Danger Zones — Design

Date: 2026-11-08
Status: draft — review questions answered

## Intent

Agents working in a claude-stones project tend to produce sprawling commits
and PRs: a refactor mixed with a feature, a new dependency slipped in next to
the code that uses it, a hand-written migration bundled with app changes, a new
third-party call buried in a large diff. Those changes are the hardest to
review, revert and bisect, and the riskiest ones (database, packages, external
communication) are exactly the ones that hide best.

This adds a framework the agent must respect when it commits, branches and
opens PRs, and a hook that **blocks** violations rather than warning.

## The framework (user decisions)

1. **Atomicity.** One logical change per commit, one story per PR, one purpose
   per branch. Every commit builds and passes on its own.
2. **Danger zones** are `db`, `packages` and `network`.
   - `db`: migrations, schema files, seeds/backfills.
   - `packages`: dependency manifests and lockfiles.
   - `network`: external communication — calls to other hosts (HTTP to
     absolute external URLs, third-party SDKs, sockets, queues, mail), and the
     config that points at them (base URLs, hosts, sandbox domains,
     `.mcp.json`). Calls to the project's own backend (relative/same-origin
     URLs) and new incoming routes are **not** network by default; incoming
     routes are opt-in (`network.incoming: true`). *(Recommended in review,
     accepted by "proceed".)*
3. **A danger-zone change needs clear specs and a dedicated branch and PR.** It
   is never bundled with anything else.
4. **Migrations are generated, never hand-written.** The agent runs the stack's
   migration generator.
5. **Enforcement is a blocking hook.**

## Goals

- Block an agent commit whose staged files mix zones.
- Block an agent commit / PR whose *branch* mixes zones, so a danger change
  cannot reach a mixed PR via separate commits.
- Block a danger-zone change on a branch without a valid spec.
- Block hand-writing or hand-editing migration files; point at the generator.
- Write the framework down so the agent knows the rules before it hits the hook.
- Install it through `claude-stones init` like the other hooks, with the
  generator filled in from the detected stack.

## Non-goals

- Enforcing anything on humans. The hook only sees the agent's tool calls.
- Judging whether a non-danger commit is "one logical change". Atomicity of
  ordinary commits is guidance in the docs, not enforced (it can't be decided
  from a diff reliably).
- Running builds/tests per commit. Covered by the testing hook and CI.
- Forcing `npm install` over editing `package.json` by hand.
- Server-side enforcement (CI checks, branch protection). Possible later.

## Anti-goals

- A hook that blocks so much normal work that projects turn it off. False
  positives on `network` are the main risk; patterns must be tunable and the
  block message must say exactly which file/line triggered it.
- A silent pass. If the hook can't decide (no git, no default branch) it says
  so in its output rather than pretending the check ran.

## Rules the hook enforces

### Zone classification

Every changed file gets exactly one class: `db`, `packages`, `network`,
`neutral` or `code`.

- **db** (path): ORM model/entity sources the generator reads (`schema.prisma`,
  Drizzle schema files, Django `models.py` / `models/`, TypeORM `*.entity.ts`,
  Sequelize/Rails/Alembic model dirs — detected per stack, overridable), so a
  model change and the migration generated from it share one `db/` branch and
  PR *(recommended in review, accepted by "proceed")*; migration directories (`migrations/`, `prisma/migrations/`,
  `drizzle/`, `alembic/versions/`, `db/migrate/`, `*/migrations/` for Django),
  schema files (`schema.prisma`, `*.sql`, `db/schema.rb`, `structure.sql`),
  seed/backfill files (`seeds/`, `seed.*`).
- **packages** (path): `package.json`, `package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `bun.lockb`, `requirements*.txt`, `pyproject.toml`,
  `poetry.lock`, `uv.lock`, `Pipfile*`, `go.mod`, `go.sum`, `Cargo.toml`,
  `Cargo.lock`, `Gemfile*`, `composer.*`, `pom.xml`, `build.gradle*`.
  - `package.json` / `pyproject.toml` / `Cargo.toml` also hold non-dependency
    settings (scripts, tool config). They count as `packages` only when the
    staged diff touches a dependency section (`dependencies`,
    `devDependencies`, `peerDependencies`, `optionalDependencies`,
    `[project.dependencies]`, `[tool.poetry.dependencies]`, `[dependencies]`…).
    Otherwise they are `code`.
- **network** (path): `.mcp.json`, `.claude/settings*.json` sandbox network
  section, `.env.example` URL/host keys, proxy/ingress/nginx config.
- **network** (content): a `code` file becomes `network` when an **added**
  line in its staged diff matches a network pattern:
  - absolute `http(s)://` / `ws(s)://` URL literals whose host is not
    `localhost`, `127.0.0.1`, `0.0.0.0`, `*.local`, `example.com` — anywhere,
    including as arguments to `fetch`/`axios`/`requests`/`http.Get`…
    Relative URLs (`fetch('/api/x')`) and client calls with a variable
    argument are not flagged on their own;
  - imports/requires of third-party SDKs and external-transport libraries
    (`stripe`, `@aws-sdk/*`, `boto3`, `twilio`, `openai`, `@anthropic-ai/sdk`,
    `@sendgrid/*`, `firebase`, `nodemailer`, `smtplib`, `amqplib`/`pika`,
    `kafkajs`/`confluent_kafka`, `@grpc/*`/`grpc`, `ws`, `socket.io-client`);
  - raw sockets / transports: `new WebSocket(`, `net.connect`/`net.Dial`,
    `tls.connect`, `dgram`;
  - new env keys named `*_URL`, `*_HOST`, `*_ENDPOINT`, `*_API_KEY` read in
    code (`process.env.X`, `os.environ[...]`, `os.Getenv`).
  - incoming (off by default, `network.incoming: true` turns it on):
    `app.get|post|put|patch|delete(`, `router.<verb>(`, Nest `@Get(`/`@Post(`…,
    `@app.route`, `@router.<verb>`, FastAPI `@app.<verb>`, `http.HandleFunc`,
    Rails `routes.rb`, Next.js `app/**/route.ts` / `pages/api/**`.
- **neutral**: test files (`*.test.*`, `*.spec.*`, `test_*.py`, `__tests__/`,
  `tests/`, `__mocks__/`, `fixtures/`), the spec files themselves, and docs
  (`*.md` outside the spec dir). Neutral files may ride along with any zone, so
  a network PR can carry its tests.
- **code**: everything else.

Precedence when a file matches several: `db` > `packages` > `network` >
`neutral` > `code`. A test file that adds `fetch(` stays neutral.

### R1 — commit is single-zone

On an agent `git commit`, the staged set (plus what `-a`/`--all` or pathspecs
would add) must contain at most one non-neutral class. Mixing two danger zones,
or a danger zone with `code`, is blocked. The message lists files per class and
the `git restore --staged …` that would split them.

### R2 — danger zones live on dedicated branches

- A commit containing a danger zone on the default branch is blocked.
- A danger branch is named with its zone prefix: `db/…`, `deps/…`, `net/…`.
  A danger-zone commit on a branch without the matching prefix is blocked.
  *(My call: the prefix makes the dedicated branch visible in `git branch`, in
  PR lists, and lets the hook know the branch's intent before the first
  commit.)*
- The branch as a whole (files changed between the branch's base and HEAD,
  plus what is being committed) must be single-zone too. The base is the
  nearest ancestor among the default branch and local branches with a danger
  prefix (or the `--base` passed to `gh pr create`), so a feature branch
  stacked on an unmerged `deps/` branch is only judged on its own commits.
  *(My call, from review.)* Checked on
  `git commit`, `git push` and `gh pr create`. A `code` branch that picks up a
  danger file, or a `db/` branch that picks up a `code` file, is blocked.

### Exempt branches

`exempt: ["branch-name", ...]` in `.claude/atomicity.json` skips R1–R3 for
those branches, so a project can finish branches that were already mixed when
the hook was installed. Only humans edit it: the hook blocks agent writes to
`.claude/atomicity.json` (same mechanism as R4). *(My call, from review.)*

### R3 — danger branches carry a spec

A danger branch must contain a spec at `.claude/danger/<branch-with-/-as-->.md`
(e.g. `db/add-orders-index` → `.claude/danger/db--add-orders-index.md`),
committed on the branch. Required `##` sections, non-empty and free of
placeholders (same placeholder rule as `testing.mjs`):

- `## Zone` — `db`, `packages` or `network`, matching the branch prefix
- `## What changes`
- `## Why`
- `## Blast radius` — what can break, for whom
- `## Rollback` — for `db`: whether the migration is reversible and what
  happens to existing data; for `packages`: how to pin back; for `network`:
  how to turn the call/endpoint off
- `## Verification` — how it was proven to work

The spec is checked on the danger-zone commit itself (it may be in the same
commit) and again on `git push` / `gh pr create`. A template ships in the docs.
*(My call: `.claude/danger/` over OpenSpec — not `.claude/specs/`, which `testing.mjs` would treat as test specs, since not every project uses
OpenSpec. If `openspec/changes/<name>/` exists for the branch, a later version
can accept it instead.)*

### R4 — migrations are generated

`Write`, `Edit`, `MultiEdit` on a path inside a configured migration directory
is blocked, as are Bash redirections / `tee` / `cp` / `mv` into it
(best-effort, same approach as `testing.mjs`'s write detection). The message
gives the generator command for the stack, e.g.:

| Stack | Generator |
|---|---|
| Prisma | `npx prisma migrate dev --name <name>` |
| Drizzle | `npx drizzle-kit generate` |
| TypeORM | `npx typeorm migration:generate` |
| Sequelize | `npx sequelize-cli migration:generate` |
| Knex | `npx knex migrate:make <name>` |
| Alembic | `alembic revision --autogenerate -m "<msg>"` |
| Django | `python manage.py makemigrations` |
| Rails | `bin/rails generate migration <Name>` |

Editing `schema.prisma` / models is allowed (that's the source the generator
reads). Hand-editing a generated migration (e.g. to add a data backfill) is
blocked by default; `migrations.allowEdits: true` opens it per project.

### What triggers the hook

`PreToolUse`, matcher `Bash|Edit|MultiEdit|Write`.
- Bash: commands containing `git commit`, `git push`, `gh pr create` (found by
  tokenizing, not substring, so `echo "git commit"` doesn't trigger), plus
  writes into migration dirs.
- Edit/MultiEdit/Write: R4 only.

Blocks use the same output shape as the other PreToolUse hooks in this repo.

### When it can't decide

- Not a git repo → allow, and say "atomicity: not a git repo, skipped".
- No resolvable default branch → R1 and R4 still run; R2/R3 branch checks are
  skipped with a stated reason.
- `git` call fails → allow with the reason; never block on the hook's own error.

## Configuration

Optional `.claude/atomicity.json`, written by `init` with detected values:

```json
{
  "enabled": true,
  "exempt": [],
  "defaultBranch": "main",
  "specDir": ".claude/danger",
  "prefixes": { "db": "db/", "packages": "deps/", "network": "net/" },
  "zones": {
    "db": { "paths": ["..."], "extraPaths": [] },
    "packages": { "paths": ["..."], "extraPaths": [] },
    "network": { "paths": ["..."], "patterns": ["..."], "extraPatterns": [], "ignore": [], "incoming": false }
  },
  "migrations": { "dirs": ["prisma/migrations"], "generate": "npx prisma migrate dev --name <name>", "allowEdits": false }
}
```

`extra*` adds to the built-in lists; setting `paths`/`patterns` replaces them.
`ignore` is a list of globs the network content check skips.

## Docs

`frameworks/BRANCHES.md` and `frameworks/PR.md` are empty in the repo today,
but `frameworks/` is not shipped or installed. The framework is written to
`docs/atomicity/` so the existing `docCatalog` installs it into
`.claude/docs/atomicity/`:

- `README.md` — the principles and danger zones, and what the hook blocks
- `BRANCHES.md` — branch purpose, naming, prefixes, how to split work
- `PR.md` — PR shape, ordering (e.g. `deps/` PR merges before the feature PR
  that uses the package), description template
- `SPEC_TEMPLATE.md` — the danger-zone spec skeleton

`frameworks/BRANCHES.md` and `frameworks/PR.md` get a one-line pointer to the
docs. *(My call; if you want `frameworks/` to be the source of truth instead,
it needs adding to the installer and `package.json` `files`.)*

## Installer changes

- `hooks/atomicity.mjs` + `hooks/atomicity.test.mjs` (node:test, like the
  other hooks).
- Register in `settings/hooks.json` under PreToolUse `Bash|Edit|MultiEdit|Write`.
- Hint in `cli/catalog.mjs`.
- `cli/detect.mjs`: detect the migration tool (Prisma, Drizzle, TypeORM,
  Sequelize, Knex, Alembic, Django, Rails), its migration dirs and its
  model/entity paths.
- `cli/install.mjs`: when the hook is selected, write `.claude/atomicity.json`
  as a seed file (created once, then owned by the project, like
  `graph/project.json`) and create `.claude/danger/`.
- `AGENT.md` generation mentions the rule and the docs path when the hook is
  installed.
- README hooks table updated.

## Interaction with existing hooks

- `guard.mjs` already blocks `git push`. In projects with both, R2/R3 still run
  on `git commit` and `gh pr create`, so nothing is lost.
- `testing.mjs` guards spec/test edits; the spec dir is `.claude/danger/` so it is not treated
  as one of its test/spec files (`testing.mjs` is left untouched).

## Left to the builder

- Exact regexes, as long as each listed pattern is covered by a test, plus at
  least one false-positive test per zone (e.g. a comment mentioning `fetch`
  in a `.md`, `localhost` URL, `package.json` scripts change).
- Whether to share a command tokenizer with `guard.mjs`/`testing.mjs` or copy
  it (hooks are installed as single files, so copying is acceptable).
- Wording of block messages, as long as each names the rule, the files, and the
  next command to run.
