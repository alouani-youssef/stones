# Task Board and Superpowers Complement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clarify that the task board owns task state and Superpowers guides task execution.

**Architecture:** Keep the integration in the existing tracking-tasks skill. Explain the handoff and ownership boundaries without changing task tooling or restating Superpowers procedures.

**Tech Stack:** Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-11-16-task-board-superpowers-complement-design.md`

## Global Constraints

- Preserve existing task commands and lifecycle requirements.
- Do not change task tooling, hooks, or generated configuration.
- Avoid duplicating Superpowers skill instructions.

## Review Focus

- Resuming a task retains board state while using the linked Superpowers artifacts.
- Review remains grounded in task scenarios and board evidence.

---

### Task 1: Clarify the tracking-tasks integration

**Files:**
- Modify: `skills/tracking-tasks/SKILL.md`

**Interfaces:**
- Consumes: the board task note and current Superpowers workflow references.
- Produces: documented responsibility boundaries and handoffs.

- [x] **Step 1: Add a concise responsibilities section** stating that the board owns task state and traceability while Superpowers owns execution guidance.
- [x] **Step 2: Clarify the workflow handoff** so task notes link to Superpowers artifacts and the board remains the record for status and review outcomes.
- [x] **Step 3: Review the full skill** to confirm commands and lifecycle requirements are preserved and no Superpowers instructions are duplicated.
