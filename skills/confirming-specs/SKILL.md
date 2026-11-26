---
name: confirming-specs
description: Use when writing a spec, before writing a plan, or before implementation or drafting starts — to have the user confirm or deny every assumption you made, then check with a short multiple-choice quiz (QCM) that they understand and approve what will be built — when the assumptions hook blocks a plan, when the task board says a task needs an Approval, or when a spec changed after approval.
metadata:
  title: Confirming Specs
  summary: Every assumption in the spec confirmed or denied by the user before planning, then a short multiple-choice quiz on the spec and plan before any code is written, approved with a hash so a changed spec needs approval again.
---

# Confirming Specs

"Looks good" is not approval. A user who skims a spec approves the summary they expected, not the decisions it actually makes, and the difference turns up later as rework. Before implementing or drafting from a spec, ask the user a short multiple-choice quiz (QCM) about the decisions that are expensive to change. When an answer differs from the spec, you have found a misunderstanding or a disagreement before any code depends on it.

It happens in two stages:

1. **Before planning: every assumption confirmed or denied.** Each decision you made that the user did not state is listed in the spec and answered by the user. The plan is built only on decisions the user owns.
2. **Before implementation: the quiz.** The user shows they understand the spec and plan as written.

The quiz is not an exam for the user. A wrong answer is a finding about the spec or about how it was explained, never a failure of the user.

## Stage 1: assumptions, before planning

While brainstorming and writing the spec, write down every take you make that the user did not say: a default, a scope cut, an interpretation of a vague requirement, a technology choice, a behavior on failure, a limit or number, something left out. If you chose it, it is an assumption, however obvious it seems. Keep them in the spec:

```markdown
## Assumptions

- A1: Limits apply per account and per IP, not per IP only. Status: open
- A2: Accounts are locked after 5 failures. Status: open
- A3: Existing sessions stay valid when the limit is reached. Status: open
```

Then, before invoking `superpowers:writing-plans`:

1. **Ask about each open assumption** with AskUserQuestion, up to four per call: the assumption as the question, and the options "Confirm" and "Deny" (the user can pick Other to say what they want instead). Put the riskiest ones first. Don't bundle two decisions into one assumption.
2. **Record each answer** on its line: `Status: confirmed`, or `Status: denied: <what the user decided instead>`.
3. **Update the spec for every denial** so the body says what the user decided, not your original take. A denial that only changes the status line leaves the wrong decision in the spec.
4. **New assumptions found while doing this** go in as `Status: open` and get asked too.
5. **Check**: `node .claude/tools/spec-quiz.mjs assumptions <spec>` prints each assumption and exits 1 while any is open or a denial has no decision.

The assumptions hook enforces this: it blocks writing a plan under `docs/design/plans/` while the plan's spec has an open assumption, has a denial with no decision, or has no `## Assumptions` section. The plan's spec is the one the plan links, else the current task's `Spec:`, else the newest spec. `approve` refuses the quiz for the same reasons.

Never mark an assumption confirmed yourself, and never mark it confirmed because the user approved the spec as a whole or said "sounds good". Each one needs its own answer.

## Stage 2: the quiz, before implementation

### When

- After `superpowers:brainstorming` wrote the spec and `superpowers:writing-plans` wrote the plan, and before `tasks.mjs start`, `superpowers:executing-plans` or any implementation or drafting.
- Again when the spec or plan changes after approval. `status` reports the quiz as stale.
- Without the task board too: any spec the user is about to sign off.

Skip it only for changes with nothing to misunderstand: typo fixes, mechanical renames, a one-line fix the user described exactly.

### Workflow

1. **Create the quiz file** next to the docs it checks:

   ```sh
   node .claude/tools/spec-quiz.mjs new docs/design/2026-11-25-login-limits-design.md \
     --plan docs/design/plans/2026-11-25-login-limits.md
   ```

2. **Write 3 to 8 questions** (rules below), each with 2 to 4 options and `Expected:` set to the option the spec and plan support.
3. **Ask them** with AskUserQuestion, up to four per call. Send the question and options only: never show `Expected`, and don't hint at which option the spec chose. Ask the user to answer from their understanding, not by opening the spec.
4. **Record** each choice as `Answer: <letter>`. A free-text answer ("Other") goes in as written, and counts as different from the spec.
5. **Resolve every answer that differs from `Expected`**, one at a time:
   - The user wants something else → change the spec (and plan) and record `Resolution: spec updated: <what changed>`.
   - The user misread it → explain that decision in one or two sentences, confirm they agree, and record `Resolution: clarified: <what was unclear>`. If several people would have misread it, also make the spec clearer.
6. **Approve**: `node .claude/tools/spec-quiz.mjs approve <quiz>`. It refuses while a question is unanswered or a mismatch has no resolution, then writes `Approved: <date> · 5/6 matched the spec, 1 resolved · sha256:<hash>`. If the spec changed in step 5, approve after the change. The hash covers the final text.
7. **Link it** in the task note under `## Spec and plan` as `Approval: docs/design/approvals/<topic>.md`. `tasks.mjs start` refuses to start the task until the quiz is approved, matches the linked spec and plan, and neither has changed since.

Tell the user the result in one line: how many answers matched, and what changed in the spec because of the others.

### Writing good questions

Ask about decisions, not wording. Good topics, in rough order of how much they cost when wrong:

| Topic | Example question |
| --- | --- |
| scope and non-goals | Which of these is **not** part of this change? |
| behavior on failure | What does the user see when the payment provider times out? |
| data and contracts | What happens to existing rows when the column becomes required? |
| irreversible steps | Which step can't be rolled back once deployed? |
| visible behavior | After 5 failed logins, what happens to the 6th attempt? |
| trade-offs taken | Which option did the design choose for storing sessions, and so what does it give up? |
| test cases | Which case proves the feature works? |

Rules:

- **One right answer, from the spec.** If the spec doesn't decide it, it is a gap: fix the spec instead of asking.
- **Wrong options are the real alternatives**: the approaches considered and rejected, the user's likely assumption, the behavior of the current system. Not jokes or obviously wrong options.
- **Don't give it away.** Similar length and style for every option; the correct one isn't always B; no "all of the above".
- **Ask about consequences, not section titles.** "What happens to a request when…", not "What does section 3 say?"
- **One decision per question**, short enough to read in one go.
- **Cover the risky parts first.** Where a spec has a contract change, a migration or an irreversible step, it gets a question.

A question in the quiz file:

```markdown
## What happens to the 6th login attempt within 10 minutes after 5 failures?

- A. The account is locked until an admin unlocks it
- B. The attempt gets a 429 with Retry-After, for that account and IP, for 15 minutes
- C. The user must solve a CAPTCHA, then can retry immediately
- D. It is allowed; failures are only logged

Expected: B
Answer: A
Resolution: spec updated: added "accounts are never locked; admins can only clear the limit" to Behavior
```

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Writing the plan before every assumption is answered | ask each one first; the hook blocks the plan otherwise |
| Marking assumptions confirmed because the user liked the spec | ask about each assumption on its own |
| Recording a denial without changing the spec body | rewrite the decision in the spec, then record it |
| Asking "Do you approve the spec?" | ask about the decisions; approval follows from the answers |
| Questions the user can answer without reading the spec, or trivia from it | ask about the decisions that would cost the most to change |
| Showing `Expected` or explaining before asking | ask first, explain only after a mismatch |
| Editing the answer to match the spec | keep the user's answer and add a Resolution |
| Approving before updating the spec | update the spec, then approve; the hash covers the final text |
| Changing the spec after approval without saying | `status` shows STALE: quiz the changed points and approve again |

## References

- `tracking-tasks`: where the Approval line sits in the readiness gate
- [superpowers:brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md) · [superpowers:writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)
