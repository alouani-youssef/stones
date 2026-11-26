# Task Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a board task from starting until its task note, spec, and plan contain clear test strategy and concrete expected test cases.

**Architecture:** Add a readiness validator used by `startTask` before any state mutation. Validate task-note sections and safely resolve linked document paths within the project, then check required sections and case bullets in both documents. Expand the task template and Superpowers prompt to establish the required format.

**Tech Stack:** Node.js ESM, `node:test`, Markdown.

**Spec:** `docs/design/2026-11-16-task-readiness-gate-design.md`

## Global Constraints

- A failed start must not change task metadata or state-board files.
- Both starting and resuming tasks require the same readiness check.
- Do not add dependencies.
- Preserve the task board's role as state/traceability and Superpowers' role as execution guidance.

## Review Focus

- A linked document path that escapes the repository root must be rejected.
- A section containing only placeholder text must be rejected.
- A blocked task with missing or stale artifacts must remain blocked and retain its original base until corrected.
- Existing task tests and review behavior must continue after valid start.
- Error output should name the missing requirement and the next action.

## Test Strategy

Run `node --test tools/tasks.test.mjs` for the focused gate and state-transition cases. Then run `npm test` and `npm run check` to check repository behavior and generated-file consistency.

## Test Cases

- Case: incomplete note, spec, or plan. Expected: focused test asserts start rejects before any board or task metadata changes.
- Case: linked document escapes the project. Expected: focused test asserts safe rejection.
- Case: incomplete blocked-task plan. Expected: focused test asserts the task stays blocked and its base is preserved.
- Case: complete task artifacts. Expected: existing start/session/resume tests pass with the task entering current state.

---

### Task 1: Add readiness validation before starting tasks

**Files:**
- Modify: `tools/tasks.mjs`
- Test: `tools/tasks.test.mjs`

**Interfaces:**
- Consumes: a task note and its linked spec and plan files.
- Produces: a readiness validator that returns a clear error or allows `startTask` to mutate board state.

- [x] **Step 1: Write failing tests** for missing spec, missing plan, missing strategy/cases in task note, missing strategy/cases in either linked document, placeholder cases, and paths outside the project.
- [x] **Step 2: Run the focused task tests** and confirm the failures were caused by `startTask` accepting incomplete tasks.
- [x] **Step 3: Implement the validator** and call it before `setMeta` and `moveTo` in `startTask`.
- [x] **Step 4: Re-run the focused tests** and confirm incomplete tasks are rejected without state changes while complete tasks start successfully.

### Task 2: Make the required artifacts clear at task creation and in the session prompt

**Files:**
- Modify: `tools/tasks.mjs`
- Modify: `skills/tracking-tasks/SKILL.md`
- Test: `tools/tasks.test.mjs`

**Interfaces:**
- Consumes: the readiness rules from Task 1.
- Produces: task templates and instructions that lead users to create compliant specs and plans before invoking `start`.

- [x] **Step 1: Add failing tests** for the task template, task prompt sequence, and clear start-gate error guidance.
- [x] **Step 2: Run the focused tests** and confirm the new expectations fail.
- [x] **Step 3: Update the template, prompt, and skill** so spec and plan creation plus test strategy/cases happen before `start`.
- [x] **Step 4: Re-run focused tests**, then run the full repository test suite and `npm run check`.
