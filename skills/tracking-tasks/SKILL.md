---
name: tracking-tasks
description: Use when starting, resuming, blocking, finishing or reviewing a task, when asked what to work on next or what is in progress, when the testing hook says no task is in progress, or before handing work off for review.
metadata:
  title: Task Board
  summary: One file per task in context/tasks/list/ that holds the task's state, a board in context/tasks/state/ rewritten from those notes, and a review package that checks the work against what the task promised.
---

# Task Board

Tasks live in the repository, next to the code they change:

```
context/tasks/
├── list/NNNN-slug.md   one task: Status, Branch, Base, Scope, Blocked, Result,
│                       expected behavior, scenarios, contract change
└── state/              the board, rebuilt from the notes by every command (git-ignored)
    ├── current.md      the task in progress
    ├── next.md         queued tasks, in the order `done` starts them
    ├── blocked.md      waiting tasks, with the reason
    └── done.md         finished tasks, with their commit range and test result
```

The notes are the source of truth; each holds its task's state:

| Line | Set by | Meaning |
| --- | --- | --- |
| `Status: next\|current\|blocked\|done` | `add`, `start`, `block`, `done` | where the task is on the board |
| `Branch:` / `Base:` | `start` | the branch and commit the task started from |
| `Category: <id>\|none` | `add --category` (default `none`) | the evaluation category (`evaluating-outputs` skill); anything but `none` gates `start` and `done` on the evaluation |
| `Blocked: <reason>` | `block` (cleared by `start`) | what a blocked task waits on |
| `Result: commits a..b · tests: <cmd> → <last line>` | `done` | the passing test run the task closed with |

Every command changes the note of the task it acts on, then rebuilds
`state/*.md` from the notes, so the two never disagree. The notes are
committed; `context/tasks/state/` is in `.gitignore`, so the state files never
reach a commit and task branches never conflict over them. After a checkout,
pull or merge, run `sync` (or any command) to rebuild them; the testing hook
reads the notes, so it is right even before that. Don't edit the state files
by hand, with one exception: move lines in `next.md` to reorder your local
queue (that order is not shared through git). If `list` reports that
`state/` is still committed, follow its hint to stop tracking it.

## How the board and Superpowers fit together

The board is the source of truth for **task state and traceability**: what is
in scope, the expected behavior and scenarios, status, branch and base,
blockers, and review evidence. It also enforces that task readiness artifacts
exist before a task can become current. Superpowers is the source of truth for
**how to do the work**: exploring the problem, shaping a design, planning,
implementing, debugging, and verifying.

Use the board to find, start, resume, block, finish, and review a task. Use
the relevant Superpowers skills to carry out each phase. Keep the task note
focused on the task contract and links to its spec and plan; do not copy the
full Superpowers procedures into the note. The board records task status and
review outcomes, while Superpowers guides the work that produces them.

Change task state through the tool, never by hand-editing the Status, Blocked or Result lines:

```sh
node .claude/tools/tasks.mjs list [current|next|blocked|done]  # the board, or one state of it
node .claude/tools/tasks.mjs current                       # the task in progress: board line + full note
node .claude/tools/tasks.mjs next                          # queued tasks, in order, flagging notes with TODOs
node .claude/tools/tasks.mjs blocked                       # blocked tasks with their reasons
node .claude/tools/tasks.mjs add "Rate limit logins" --scope "src/auth/**,tests/auth/**"
node .claude/tools/tasks.mjs start 7 [--no-session]        # records branch and base commit; from a terminal, opens a Claude Code session loaded with the task
node .claude/tools/tasks.mjs show                          # the current task
node .claude/tools/tasks.mjs block 7 "waiting for API keys"
node .claude/tools/tasks.mjs done 7 [-- <test command>]    # done only if tests pass, then starts the next ready task
node .claude/tools/tasks.mjs done 7 --no-advance          # done, without starting the next task
node .claude/tools/tasks.mjs done 7 --no-pr               # done, without writing the PR draft
node .claude/tools/tasks.mjs review 7 [--run-tests]        # writes .claude/reviews/0007.md
node .claude/tools/tasks.mjs sync                          # rewrite state/*.md from the notes, e.g. after a merge
```

## Workflow

1. **Session start:** run `current`. If a task is in progress, continue it; do not start another. Otherwise `next` shows what to pick up.
2. **Define the task:** run `add`, then complete its note in `list/`: **Expected behavior**, at least one `- Scenario: <condition>. Expected: <outcome>.`, **Contract change** (`none` or `behavior changed: <reason>`), and **Scope** globs. Set **Category** when the output can be measured (`add --category <id>`; `node .claude/tools/evaluation.mjs suggest <spec>` proposes one; see the `evaluating-outputs` skill), else leave `none`. Also fill in **Test Strategy** and at least one **Test Cases** bullet in the format `- Case: <condition>. Expected: <observable outcome>.` Ask the user when expected behavior is unclear.
3. **Design and plan before starting:** use [`superpowers:brainstorming`](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md) with the task note as input; save the spec under `docs/superpowers/specs/` and link it as `Spec: <path>`. List every decision you made that the user did not state under the spec's `## Assumptions`, and have the user confirm or deny each one before planning (`confirming-specs` skill; the assumptions hook blocks the plan until then). The spec must have non-placeholder `## Test Strategy` and `## Test Cases` sections, with at least one `- Case: <condition>. Expected: <observable outcome>.` bullet. Then use [`superpowers:writing-plans`](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md) on the spec; save the plan under `docs/superpowers/plans/` and link it as `Plan: <path>`. The plan must also have non-placeholder `## Test Strategy` and `## Test Cases` sections with expected outcomes, and map cases to test-first implementation and verification steps. For a categorised task, run `node .claude/tools/evaluation.mjs plan <plan> --category <id>` before the quiz; `start` refuses a plan whose `## Evaluation` section is missing, edited by hand, or for another category. Then confirm the user understood and approves them: ask the spec quiz from the `confirming-specs` skill, approve it with `node .claude/tools/spec-quiz.mjs approve <quiz>`, and link it as `Approval: <path>`. **Do not run `start` until the note, spec, plan and approval meet these requirements.**
4. **Start:** run `start <id>` only after the readiness artifacts exist. The task tool checks the note, links, files, test strategy, cases and, when the note has an `Approval:` line, that the spec quiz is approved and the spec and plan haven't changed since, before changing task status, branch/base metadata, or board state. If validation fails, fix the named item and retry. One task is current at a time; finish or block the current one first. Starting a blocked task applies the same gate and retains its original base. From a terminal, `start` opens a Claude Code session with the note and implementation workflow; inside Claude Code it only updates the board (`--session` forces one, `--no-session` skips it).
5. **Build and verify:** follow the linked plan with [`superpowers:subagent-driven-development`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md) or [`superpowers:executing-plans`](https://github.com/obra/superpowers/blob/main/skills/executing-plans/SKILL.md), and use [`superpowers:test-driven-development`](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md) when implementing behavior. Use [`superpowers:verification-before-completion`](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md) before marking the task done. Keep the board note as the concise contract and status record; the linked spec and plan contain design and execution detail.
6. **Blocked:** `block <id> "<reason>"` names what it waits on. `start` resumes it later with its original base commit, after readiness validation.
7. **Review:** commit the work, then `review <id> --run-tests`. It reports missing specs/plans and checks the changed work against the task's scenarios. Fix every finding before finishing.
8. **Finish and move on:** `done <id>` runs the project's test command (or the one after `--`) and sets the task done only when it passes, recording the commit range and test result in its `Result:` line. It writes the pull request draft to `.claude/pr.md` from the task (summary, scenarios, risk from its contract change, rollback, test result and review verdict; a `## Risk` or `## Rollback` section in the note overrides the defaults) and prints the commands that open it: commit the task bookkeeping, push, then `create-pr.mjs create`. Run them in order, after filling any TODOs it reports; opening the PR stays an explicit step. It then starts the next queued task (in `next.md` order) that passes the readiness gate, skipping and naming any queued task that is not ready, and prints the new current task; continue with it (`current` shows its note). From a terminal it opens that task's Claude Code session. Pass `--no-advance` to stop after closing the task, e.g. when tasks are worked on in parallel branches. For a categorised task, `done` also scores the output (`evaluation.mjs score`) and refuses unless the verdict is PASS: record every measured KPI with `evaluation.mjs record` first. Human sign-offs on the scorecard are advisory and listed, never blocking. On test failure, fix the source and run it again; never edit the task or tests to get a pass.

## Reviewing a task

`review` writes one file for the reviewer, `.claude/reviews/<id>.md` (git-ignored): verdict, findings, what the task promised, each scenario with whether a changed test mentions it, commits, files changed with their change kind, and the full diff. It exits 1 when the task is **NOT READY**. Findings:

| Finding | Fix |
| --- | --- |
| task note incomplete | fill expected behavior, scenarios and contract change; write and link the spec and plan with the superpowers skills |
| tests fail / no passing run recorded / commits after the tests passed | fix the source, then `done` or `review --run-tests` |
| no test files changed / scenarios with no matching test changes | add tests for those scenarios (keyword match; check it, do not game it) |
| changes outside the task's scope | revert them, move them to their own task, or widen Scope if the task truly needs them |
| mixes db/packages/network with other changes | split them onto their own branch (see the atomic-changes skill) |
| complexity | refactor the named functions (see the managing-complexity skill) |
| uncommitted changes / no commits | commit the task's work; the review only covers commits since the task started |

When reviewing someone else's task, read the package first, then judge whether the diff delivers each scenario and nothing beyond the task. The findings are checks, not the whole review.
