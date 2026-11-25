---
name: anti-slop
description: Use when writing or editing any code, test, comment, doc, commit message, PR description or report; before handing work back as done; and when reviewing generated output. Applies to every change, not only large ones.
metadata:
  title: Anti-Slop
  summary: Ship only what earns its place — no filler code, comments, tests, abstractions or prose, and no claim without evidence.
  core: true
---

# Anti-Slop

Slop is output that looks like work but adds nothing: code nobody asked for, comments that repeat the code, tests that cannot fail, prose that pads, and claims nobody checked. It costs the reader time and hides the parts that matter.

**Every line must earn its place. If removing it loses nothing, remove it.**

This is a core stone: it applies to every change, alongside the project's other skills.

## The deletion test

Before handing anything back, read each added line, sentence and file and ask: *what breaks or becomes unclear if this goes?* If the answer is "nothing", delete it.

## Code

| Slop | Do instead |
|---|---|
| Comments that narrate the code (`// increment i`, `// call the API`) | Comment only the *why*: a constraint, a non-obvious decision, a workaround with its cause. |
| Guards for states that cannot happen (null checks on values the type or caller guarantees, `try/catch` around code that cannot throw) | Validate at trust boundaries (input, network, disk). Trust internal contracts. |
| Swallowed or re-wrapped errors (`catch (e) { console.log(e) }`, `except Exception: pass`) | Let errors propagate, or handle a specific one with a specific recovery. |
| Speculative abstraction: interfaces with one implementation, factories for one type, config options nobody set, "for future flexibility" | Write the concrete thing. Abstract on the second real use. |
| New helpers that duplicate existing ones | Search first (`grep`, the code graph, `list-packages.mjs`) and reuse. |
| Placeholder code: `TODO: implement`, stubs that return fake data, `pass`, mocked logic presented as real | Implement it, or say plainly in the report that it is not done. |
| Drive-by edits: reformatting, renames, reordered imports, "cleanups" outside the task | Keep the diff to the task. Propose other changes separately. |
| Invented APIs, flags, options or package names | Check the source, docs or installed version before using one. |
| Generic names (`data`, `result`, `handleStuff`, `utils2`, `helper`) | Name by what the value is or the function does in this domain. |
| Logging everything, debug prints left in | Log what an operator needs; remove the rest before committing. |

## Tests

| Slop | Do instead |
|---|---|
| Tests that assert the mock returned what the mock was told to return | Assert observable behavior of the code under test. |
| Tests that pass with the implementation deleted | Watch each new test fail first, for the right reason. |
| Snapshot or `toBeTruthy()` assertions that accept almost anything | Assert the specific value or outcome that matters. |
| Many near-identical tests with no new case | One test per distinct behavior; table-drive the variants. |
| Skipped, weakened or deleted tests to get green | Fix the code, or report the failing test as failing. |

## Prose (docs, comments, commits, PRs, reports)

| Slop | Do instead |
|---|---|
| Openers and closers: "Great question", "I hope this helps", "Let me know if…" | Start with the answer. Stop when done. |
| Restating the request back | Say what changed and what to do next. |
| Inflated words: "comprehensive", "robust", "seamless", "leverage", "powerful", "elegant" | Use the plain word, or a concrete fact instead of an adjective. |
| Hedging every sentence ("might", "potentially", "it seems") | State what you verified as fact; flag what you did not verify once, specifically. |
| Bullet lists of everything touched, headings for three lines, emoji | Short paragraphs; list only parallel items; headings only when a document needs navigation. |
| README or docs sections nobody asked for (Features, Benefits, Conclusion) | Document what a user needs to run, use or change it. |
| Commit or PR text describing *what* the diff already shows | Say *why*, what was verified, and what is left. |

## Claims

- Never say "done", "fixed", "works" or "tests pass" without having run the check in this session and seen the output.
- Report failures, skipped steps and unverified parts plainly. A short honest report beats a long confident one.
- Do not claim coverage, performance or security properties you did not measure.

## Before handing back

1. Read the full diff (`git diff`, `git diff --cached`). Apply the deletion test to every hunk.
2. Remove debug output, dead code, unused imports, placeholder comments and edits outside the task.
3. Check each new test fails without the change.
4. Check every new name, API and flag exists and means what you think.
5. Cut the report to: what changed, how it was verified, what is not done.

## Related skills

- `reusing-code` before writing anything new.
- `managing-complexity` when the cut leaves code that is still hard to follow.
- `writing-tests` and `test-first-development` for tests that can fail.
- `four-d-engineering` (Discernment, Diligence) for judging output on evidence.
