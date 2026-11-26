# System Prompts and Atomic Commits Design

## Goal

Add a reusable system-prompt design skill that complements the existing runtime prompt skill, and make atomic commit protection a default part of ai-stones setup. Clarify the commit workflow for semantic cases the hook cannot infer.

## Scope

- Add `skills/system-prompts/SKILL.md`, with references, for durable system and developer instructions, instruction hierarchy, tool boundaries, untrusted input, and evaluation.
- Add a cross-reference in `skills/prompts/SKILL.md` to distinguish runtime prompt templates from durable system/developer instructions.
- Extend `skills/atomic-changes/SKILL.md` with a concrete pre-commit workflow and a human semantic-scope rule for code-only changes.
- Select `atomicity` by default and update install, catalog, and README tests/docs accordingly.
- Preserve the existing R1–R4 hook behavior. Do not add a task-scope gate or alter danger-zone policy.

## Behavior

The new skill is available to all project types because system prompts are not tied to a framework. The atomicity hook is installed by default, including its detected `.claude/atomicity.json` seed config and danger directory. Users may still deselect the hook. Its existing rules remain unchanged.

Before creating a commit, the atomic-changes skill requires checking the task outcome, reviewing status and staged diff, staging only intended files, running relevant checks, and splitting unrelated purposes even when all files are ordinary code. The hook continues enforcing only its detectable R1–R4 cases.

## Test Strategy

Use focused CLI tests to assert system-prompts discovery and selection, atomicity default selection and catalog metadata, default hook/config installation, and updated README/skill guidance. Run the focused suite and inspect the final diff. Existing atomicity hook tests remain the regression coverage for R1–R4.

## Test Cases

- Case: a general project receives the system-prompts skill by default. Expected: interview defaults include `system-prompts` for projects with and without framework metadata.
- Case: the skill is packaged and discoverable. Expected: the catalog exposes `system-prompts/SKILL.md` and the skill provides reference links.
- Case: application prompts and system prompts have distinct scopes. Expected: the prompts skill points durable system/developer instructions to `system-prompts`.
- Case: default initialization installs atomicity. Expected: `answers.install.hooks` includes `atomicity`, and generated hook, config, and danger directory are present.
- Case: atomicity remains user-selectable. Expected: explicit deselection omits the hook and its config.
- Case: atomic commit instructions cover judgment beyond hook classification. Expected: the skill requires a staged-diff review and splitting unrelated code-only purposes.
- Case: R1–R4 remain intact. Expected: existing atomicity hook regression tests pass without changing enforcement logic.
- Case: README describes the new defaults accurately. Expected: atomicity is described as default while other process gates and logging remain opt-in.
