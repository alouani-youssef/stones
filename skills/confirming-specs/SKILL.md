---
name: confirming-specs
description: Use when a spec or plan is written and implementation or drafting is about to start — to check with a short multiple-choice quiz (QCM) that the user understands and approves what will be built — when the task board says a task needs an Approval, when a spec changed after approval, or when the user is about to approve a spec they may not have read.
metadata:
  title: Confirming Specs
  summary: A short multiple-choice quiz on the decisions in a spec and plan, answered by the user before any code is written, recorded and approved with a hash so a changed spec needs approval again.
---

# Confirming Specs

"Looks good" is not approval. A user who skims a spec approves the summary they expected, not the decisions it actually makes, and the difference turns up later as rework. Before implementing or drafting from a spec, ask the user a short multiple-choice quiz (QCM) about the decisions that are expensive to change. When an answer differs from the spec, you have found a misunderstanding or a disagreement before any code depends on it.

The quiz is not an exam for the user. A wrong answer is a finding about the spec or about how it was explained, never a failure of the user.

## When

- After `superpowers:brainstorming` wrote the spec and `superpowers:writing-plans` wrote the plan, and before `tasks.mjs start`, `superpowers:executing-plans` or any implementation or drafting.
- Again when the spec or plan changes after approval. `status` reports the quiz as stale.
- Without the task board too: any spec the user is about to sign off.

Skip it only for changes with nothing to misunderstand: typo fixes, mechanical renames, a one-line fix the user described exactly.

## Workflow

1. **Create the quiz file** next to the docs it checks:

   ```sh
   node .claude/tools/spec-quiz.mjs new docs/superpowers/specs/2026-11-25-login-limits-design.md \
     --plan docs/superpowers/plans/2026-11-25-login-limits.md
   ```

2. **Write 3 to 8 questions** (rules below), each with 2 to 4 options and `Expected:` set to the option the spec and plan support.
3. **Ask them** with AskUserQuestion, up to four per call. Send the question and options only: never show `Expected`, and don't hint at which option the spec chose. Ask the user to answer from their understanding, not by opening the spec.
4. **Record** each choice as `Answer: <letter>`. A free-text answer ("Other") goes in as written, and counts as different from the spec.
5. **Resolve every answer that differs from `Expected`**, one at a time:
   - The user wants something else → change the spec (and plan) and record `Resolution: spec updated: <what changed>`.
   - The user misread it → explain that decision in one or two sentences, confirm they agree, and record `Resolution: clarified: <what was unclear>`. If several people would have misread it, also make the spec clearer.
6. **Approve**: `node .claude/tools/spec-quiz.mjs approve <quiz>`. It refuses while a question is unanswered or a mismatch has no resolution, then writes `Approved: <date> · 5/6 matched the spec, 1 resolved · sha256:<hash>`. If the spec changed in step 5, approve after the change. The hash covers the final text.
7. **Link it** in the task note under `## Spec and plan` as `Approval: docs/superpowers/approvals/<topic>.md`. `tasks.mjs start` refuses to start the task until the quiz is approved, matches the linked spec and plan, and neither has changed since.

Tell the user the result in one line: how many answers matched, and what changed in the spec because of the others.

## Writing good questions

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
| Asking "Do you approve the spec?" | ask about the decisions; approval follows from the answers |
| Questions the user can answer without reading the spec, or trivia from it | ask about the decisions that would cost the most to change |
| Showing `Expected` or explaining before asking | ask first, explain only after a mismatch |
| Editing the answer to match the spec | keep the user's answer and add a Resolution |
| Approving before updating the spec | update the spec, then approve; the hash covers the final text |
| Changing the spec after approval without saying | `status` shows STALE: quiz the changed points and approve again |

## References

- `tracking-tasks`: where the Approval line sits in the readiness gate
- [superpowers:brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md) · [superpowers:writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)
