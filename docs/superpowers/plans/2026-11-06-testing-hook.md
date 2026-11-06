# Testing Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require explicit verification scenarios before test runs and guard spec/test files against edits that only mask failures.

**Architecture:** Add a pure evaluator and a small Claude Code PreToolUse entry point in `hooks/testing.mjs`. The CLI will seed `context/tasks/active.md` when selected, and generated settings will register the hook for Bash and file edits.

**Tech Stack:** Node.js ES modules, built-in `node:test`, Claude Code command hooks.

**Spec:** `docs/superpowers/specs/2026-11-06-testing-hook-design.md`

## Global Constraints

- Require `## Expected behavior`, `## Scenarios`, and `## Contract change` in `context/tasks/active.md`.
- Require at least one scenario bullet containing an expected outcome.
- Require an explicit rationale in `Contract change` before test/spec edits; `none` permits test runs but does not permit those edits.
- Keep hook source under root `hooks/`; generated command paths target `.claude/hooks/`.
- Preserve unrelated working-tree changes.

## Review Focus

- A test-like command hidden in a compound shell command must still be guarded: test command detection traverses shell segments.
- Test/spec path variants must be recognized: unit test folders, suffix/prefix test names, OpenSpec specs, and feature specs.
- Missing or malformed active notes must block only test runs and protected file edits, not ordinary source edits or unrelated commands.
- Existing installer-managed user files must not be overwritten: seed the active task template with the normal managed-file conflict rules.
- A documented contract rationale must permit test/spec edits; an empty or `none` rationale must not.

---

### Task 1: Add the testing hook contract and unit coverage

**Files:**
- Create: `hooks/testing.test.mjs`
- Modify: `hooks/testing.mjs`

**Interfaces:**
- Export `evaluate(event, { projectDir } = {})`, returning `{ block: boolean, reason?: string }`.
- Read task scenarios from `<projectDir>/context/tasks/active.md`.

- [ ] **Step 1: Write failing tests** for complete/incomplete task notes, detected test commands, justified and unjustified protected-file edits, and normal source edits.
- [ ] **Step 2: Run `node --test hooks/testing.test.mjs`** and confirm expected failures because the evaluator is not implemented.
- [ ] **Step 3: Implement the smallest evaluator** that validates the three note sections, detects common test commands, classifies test/spec paths, and applies the contract-change gate.
- [ ] **Step 4: Run `node --test hooks/testing.test.mjs`** and confirm all cases pass.
- [ ] **Step 5: Add a CLI entry point** that reads the Claude hook event from stdin and exits 2 with the evaluator reason when blocked.

### Task 2: Add task-note template and wire installation

**Files:**
- Create: `context/tasks/active.md`
- Modify: `settings/hooks.json`
- Modify: `settings/settings.json`
- Modify: `cli/install.mjs`
- Modify: `cli/catalog.mjs`
- Modify: `package.json`
- Modify: `cli/stones.test.mjs`

**Interfaces:**
- The template uses the headings and scenario format validated by `evaluate`.
- The testing hook is selected through the existing hook catalog like other hooks.

- [ ] **Step 1: Add an installer test** proving that selecting `testing` installs the hook, active-task template, and generated settings entries, while not installing the template if the hook is not selected.
- [ ] **Step 2: Run the focused CLI test** and confirm it fails before installer/catalog wiring.
- [ ] **Step 3: Register the hook** in `settings/hooks.json`, add its catalog hint, seed the active task file only when selected, and include `context/tasks/active.md` in packaged files.
- [ ] **Step 4: Regenerate settings** with `node settings/build-settings.mjs`.
- [ ] **Step 5: Run the focused CLI tests** and confirm they pass.

### Task 3: Document the task scenario format and verify

**Files:**
- Modify: `docs/testings/README.md`
- Modify: `docs/superpowers/specs/2026-11-06-testing-hook-design.md`

- [ ] **Step 1: Document** the active task note headings, scenario bullet syntax, and contract-change rationale requirement.
- [ ] **Step 2: Run `npm test`** and confirm the full suite passes.
- [ ] **Step 3: Run `git diff --check`** and review the final diff to ensure unrelated working-tree changes remain untouched.
