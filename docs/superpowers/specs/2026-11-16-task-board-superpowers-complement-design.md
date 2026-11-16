# Task Board and Superpowers Complement Design

## Goal

Make the existing task board and Superpowers work as complementary parts of one workflow.

## Responsibilities

- The task board is the source of truth for task identity, scope, expected behavior, scenarios, status, branch and base, blockers, and review traceability.
- Superpowers is the source of truth for how work is performed: brainstorming, planning, implementation, debugging, and verification.
- Task notes link to the Superpowers spec and plan so work can be resumed and reviewed without duplicating their content.

## Workflow

Starting or resuming a board task should present its note and the relevant Superpowers workflow. The implementer uses Superpowers to perform the work and records links and outcomes on the board. The board's task tools continue to manage status and review evidence; they do not replace or redefine Superpowers skills.

## Scope

Clarify the responsibilities and handoffs in `skills/tracking-tasks/SKILL.md`. Keep existing task commands, board files, hook behavior, and Superpowers skill sequence intact. Do not change task tooling or generated configuration.

## Acceptance Criteria

- The task skill clearly states which system owns task state and which owns execution guidance.
- The skill explains how the board note, Superpowers spec/plan, and review package relate.
- Existing board commands and task lifecycle requirements remain intact.
- No duplicate instructions are introduced for the contents of Superpowers skills.
