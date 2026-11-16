---
name: tracking-tasks
description: Use when starting, resuming, blocking, finishing or reviewing a task, when asked what to work on next or what is in progress, when the testing hook says no task is in progress, or before handing work off for review.
metadata:
  title: Task Board
  summary: One file per task in context/tasks/list/, a board in context/tasks/state/, and a review package that checks the work against what the task promised.
---

# Task Board

Tasks live in the repository, next to the code they change:

```
context/tasks/
├── list/NNNN-slug.md   one task: Status, Branch, Base, Scope, expected behavior, scenarios, contract change
└── state/
    ├── current.md      the task in progress (the testing hook reads the task linked here)
    ├── next.md         queued tasks, in order
    ├── blocked.md      waiting tasks, with the reason
    └── done.md         finished tasks, with their commit range and test result
```

Always change the board through the tool, never by hand-editing the state files:

```sh
node .claude/tools/tasks.mjs list [current|next|blocked|done]  # the board, or one state of it
node .claude/tools/tasks.mjs current                       # the task in progress: board line + full note
node .claude/tools/tasks.mjs next                          # queued tasks, in order, flagging notes with TODOs
node .claude/tools/tasks.mjs blocked                       # blocked tasks with their reasons
node .claude/tools/tasks.mjs add "Rate limit logins" --scope "src/auth/**,tests/auth/**"
node .claude/tools/tasks.mjs start 7 [--no-session]        # records branch and base commit; from a terminal, opens a Claude Code session loaded with the task
node .claude/tools/tasks.mjs show                          # the current task
node .claude/tools/tasks.mjs block 7 "waiting for API keys"
node .claude/tools/tasks.mjs done 7 [-- <test command>]    # moves to done only if tests pass
node .claude/tools/tasks.mjs review 7 [--run-tests]        # writes .claude/reviews/0007.md
```

## Workflow

1. **Session start:** run `current`. If a task is in progress, continue it; do not start another. Otherwise `next` shows what to pick up.
2. **New work:** `add` the task, then fill its file in `list/`: **Expected behavior**, at least one `- Scenario: <condition>. Expected: <outcome>.`, **Contract change** (`none` or `behavior changed: <reason>`), and a **Scope** of globs for the files it may touch. Ask the user when the expected behavior is unclear.
3. **Start:** `start <id>` before editing code. One task is current at a time; finish or block the current one first. Run from a terminal, `start` opens a Claude Code session whose first prompt is the task note, the superpowers steps below, and the old block reason when resuming. Inside Claude Code it only updates the board (`--session` forces one, `--no-session` skips it).
4. **Spec and plan, with superpowers:** every task is designed and built with the superpowers skills, in this order:
   1. **Spec:** `superpowers:brainstorming`, with the task note as its input. It writes `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Copy the expected behavior, scenarios and contract change it settles into the note, and link the file as `Spec: <path>` under `## Spec and plan`.
   2. **Plan:** `superpowers:writing-plans` on that spec. It writes `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Link it as `Plan: <path>`.
   3. **Build:** `superpowers:subagent-driven-development` (or `superpowers:executing-plans` inline), test first with `superpowers:test-driven-development`.
   4. **Verify:** `superpowers:verification-before-completion` before `done`.

   The testing hook blocks test runs and test edits until the note is complete, including both links pointing to files that exist. `review` reports a missing spec or plan as an incomplete note, and counts the linked files as in scope. Notes written before `## Spec and plan` existed are not checked for it.
5. **Blocked:** `block <id> "<reason>"` names what it waits on. `start` resumes it later with its original base commit, so the review still covers all of its work.
6. **Finish:** commit the work, then `done <id>`. It runs the project's test command (or the one after `--`) and moves the task to done only when it passes. On failure, fix the source and run it again; never edit the task or the tests to get a pass.
7. **Review:** `review <id> --run-tests` before handing off or opening a pull request.

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
