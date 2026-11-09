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
node .claude/tools/tasks.mjs list                          # the board
node .claude/tools/tasks.mjs add "Rate limit logins" --scope "src/auth/**,tests/auth/**"
node .claude/tools/tasks.mjs start 7                       # records branch and base commit
node .claude/tools/tasks.mjs show                          # the current task
node .claude/tools/tasks.mjs block 7 "waiting for API keys"
node .claude/tools/tasks.mjs done 7 [-- <test command>]    # moves to done only if tests pass
node .claude/tools/tasks.mjs review 7 [--run-tests]        # writes .claude/reviews/0007.md
```

## Workflow

1. **Session start:** run `list`. If a task is current, `show` it and continue it; do not start another.
2. **New work:** `add` the task, then fill its file in `list/`: **Expected behavior**, at least one `- Scenario: <condition>. Expected: <outcome>.`, **Contract change** (`none` or `behavior changed: <reason>`), and a **Scope** of globs for the files it may touch. Ask the user when the expected behavior is unclear.
3. **Start:** `start <id>` before editing code. One task is current at a time; finish or block the current one first. The testing hook blocks test runs until the current task's note is complete.
4. **Blocked:** `block <id> "<reason>"` names what it waits on. `start` resumes it later with its original base commit, so the review still covers all of its work.
5. **Finish:** commit the work, then `done <id>`. It runs the project's test command (or the one after `--`) and moves the task to done only when it passes. On failure, fix the source and run it again; never edit the task or the tests to get a pass.
6. **Review:** `review <id> --run-tests` before handing off or opening a pull request.

## Reviewing a task

`review` writes one file for the reviewer, `.claude/reviews/<id>.md` (git-ignored): verdict, findings, what the task promised, each scenario with whether a changed test mentions it, commits, files changed with their change kind, and the full diff. It exits 1 when the task is **NOT READY**. Findings:

| Finding | Fix |
| --- | --- |
| task note incomplete | fill expected behavior, scenarios and contract change |
| tests fail / no passing run recorded / commits after the tests passed | fix the source, then `done` or `review --run-tests` |
| no test files changed / scenarios with no matching test changes | add tests for those scenarios (keyword match; check it, do not game it) |
| changes outside the task's scope | revert them, move them to their own task, or widen Scope if the task truly needs them |
| mixes db/packages/network with other changes | split them onto their own branch (see the atomic-changes skill) |
| complexity | refactor the named functions (see the managing-complexity skill) |
| uncommitted changes / no commits | commit the task's work; the review only covers commits since the task started |

When reviewing someone else's task, read the package first, then judge whether the diff delivers each scenario and nothing beyond the task. The findings are checks, not the whole review.
