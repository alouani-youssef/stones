# Testing Hook Design

## Intent

Require a small, explicit scenario set before test runs and prevent issue fixes
from changing specs or tests to hide a failure instead of correcting source
behavior.

## Goals

- Require `context/tasks/active.md` to describe the expected behavior and at
  least one concrete test scenario before a test command runs.
- Block edits to test and spec files by default during a task.
- Permit those edits only when the active task note explicitly says expected
  behavior is changing and gives a reason.
- Keep the rule in the existing Claude Code hook configuration and provide a
  clear block message describing how to proceed.

## Non-goals

- Decide whether a code change is semantically correct; the hook enforces a
  recorded rationale, not the quality of that rationale.
- Select a test framework or rewrite existing tests/specs.
- Change unrelated hook behavior.

## Approaches

1. **Task-note gate (recommended and selected):** use
   `context/tasks/active.md` as the source of task scope, scenarios, and any
   expected-behavior change. It gives the hook machine-checkable context and a
   reviewable record, at the cost of a small note per task.
2. **Reminder-only hook:** inject scenario guidance without blocking test/spec
   edits. It is less disruptive but cannot enforce the requested safeguard.
3. **Always block test/spec edits:** strongest protection, but prevents valid
   updates when the contract intentionally changes.

## Contract and constraints

The task note will include `## Expected behavior`, `## Scenarios`, and
`## Contract change` sections. Each scenario states a behavior and an expected
outcome. The contract-change section must say `none` or give a rationale for
updating tests/specs. The hook checks these sections before test commands and
before edits targeting test/spec files. Test/spec classification will cover
common test directories and filename conventions, plus OpenSpec spec paths.

The hook is advisory only when parsing an unrelated command or a non-target
file. It must fail closed for a test command or target test/spec edit if the
task note is missing or malformed. The hook will be wired to the root `hooks/`
directory, matching the repository layout.

## Verification

Unit scenarios will cover missing or incomplete task notes, valid scenario
notes, guarded test/spec edits, justified contract changes, ordinary source
edits, and representative test command detection. Hook configuration will be
checked by regenerating `settings/settings.json` and validating its hook path.
