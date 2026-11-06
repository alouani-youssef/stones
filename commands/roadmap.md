---
description: Create or revise ROADMAP.md through a short interview
argument-hint: "[focus, e.g. 'plan the next milestone' or 'review progress']"
---

You are running a roadmap session for this project. Your job is to interview
me and then write or revise `ROADMAP.md` at the project root.

Focus for this session: $ARGUMENTS

## 1. Gather context first (do not ask me what you can read)

- Read `AGENT.md` for what the project is, its stack and architecture.
- Read `ROADMAP.md` if it exists: this session revises it rather than
  starting over.
- Skim `git log --oneline -30` and the top-level layout to see what already
  exists and what is moving.
- If `openspec/` exists, list its capabilities (`openspec/specs/*`) and active
  changes (`openspec/changes/*`).

Then tell me in three or four lines what you understood, including what looks
done, in progress, or missing.

## 2. Interview me

Ask in small rounds, at most three questions per round, using the
AskUserQuestion tool with concrete options where possible. Skip anything the
context already answers. Cover:

1. **Outcome**: what must be true in 3–6 months for this to be a success, and
   for whom.
2. **Now**: the single most important milestone to finish next, and why it
   comes first.
3. **Next / Later**: what follows, and what is explicitly out of scope.
4. **Constraints**: deadlines, team size, budget, dependencies on other teams
   or services.
5. **Risks**: the unknowns that could break the plan, and how we would find
   out early.

When revising, ask what changed since the last version and which milestones
are done.

## 3. Write ROADMAP.md

Use exactly this structure. Keep it short enough to read in two minutes;
link to specs and docs instead of copying them.

```md
# Roadmap

_Last revised: YYYY-MM-DD_

## Outcome

One paragraph: who benefits and what success looks like, with a measurable
signal where possible.

## Now

### <Milestone name>

- **Goal:** one sentence.
- **Scope:** the few deliverables that make it done.
- **Done when:** observable exit criteria (tests, demo, metric).
- **Risks:** what could block it and the mitigation.

## Next

- **<Milestone>** — goal in one line.

## Later

- **<Idea>** — why it is parked.

## Out of scope

- What we decided not to do, and why.

## Decisions

| Date | Decision | Why |
| ---- | -------- | --- |
```

Rules:

- Exactly one milestone under **Now**. Two to four under **Next**.
- Every milestone is an outcome ("users can reset their password"), not an
  activity ("work on auth").
- When revising, move finished milestones out of **Now**, record why the plan
  changed in **Decisions**, and keep earlier decisions.
- Show me the draft, apply my corrections, then write the file.
