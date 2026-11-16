# Task Readiness Gate Design

## Goal

Require every board task to have a complete spec and implementation plan, including a test strategy and concrete test cases, before it can be started or resumed.

## Responsibilities

- The task board owns the readiness gate and refuses to move a task to `current` until its note and linked artifacts meet the required structure.
- Superpowers remains responsible for producing the spec, plan, and implementation workflow.
- The task note records the concise behavior contract, test strategy, test cases, and links. The spec and plan carry the design and execution detail.

## Required task note sections

- `Expected behavior`: non-placeholder behavior.
- `Scenarios`: at least one scenario with an observable expected outcome.
- `Contract change`: `none` or a reason for changed behavior.
- `Test strategy`: how the task's risk and behavior will be tested.
- `Test cases`: one or more `- Case: <condition>. Expected: <observable outcome>.` entries.
- `Spec and plan`: links to existing spec and plan files.

## Required spec and plan content

Both linked documents must contain non-placeholder `## Test Strategy` and `## Test Cases` sections. Each test-cases section must include at least one case bullet with an expected outcome. The plan should map the cases to test-first implementation and runnable verification steps.

## Gate behavior

`tasks start <id>` validates all requirements before changing task status, branch/base metadata, or board state. Missing links, files, sections, case outcomes, or placeholder content produce a direct fix instruction and leave the task queued or blocked as it was. Both new tasks and resumed blocked tasks use the same gate.

## Test Strategy

Use focused Node.js tests around `startTask` through the task CLI. Assert both the error message and persisted board/task state so a rejected start cannot partially move a task. Exercise a valid start and blocked-task resume as positive cases.

## Test Cases

- Case: a new task has no spec link. Expected: start is rejected and it remains queued with empty branch and base.
- Case: the note, spec, or plan lacks a test strategy or an expected test case. Expected: start is rejected and board state is unchanged.
- Case: the linked spec path escapes the project root. Expected: start is rejected without reading an outside file or changing task state.
- Case: a blocked task's plan is incomplete. Expected: resume is rejected and the task stays blocked with its original base.
- Case: the note, spec, and plan are complete. Expected: start succeeds and records current status, branch, and base.

## Acceptance criteria

- A task with missing spec or plan cannot be started, and the board state remains unchanged.
- A task whose note or linked docs lack test strategy or concrete expected test cases cannot be started.
- A complete task starts normally; resuming a blocked task applies the same checks and preserves its original base.
- Test coverage proves the readiness gate rejects each incomplete state and accepts a valid task.
- Existing task-board behavior remains unchanged after a task passes readiness validation.
