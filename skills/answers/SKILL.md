---
name: answers
description: Use when the user asks a question about this project (why it is built a certain way, what was decided, what is in or out of scope, where a behavior lives, what depends on a file, which conventions, commands or guardrails apply), when asked to load the project answers or context, or before a task that could contradict a recorded decision.
metadata:
  title: Answering From Project Context
  summary: Answer project questions from the recorded setup answers, decisions, system design and code graph, with sources, instead of guessing.
---

# Answering From Project Context

The project already records why it is built the way it is. Answer from those records first. Read code to confirm what it does now. Never invent a reason that was not recorded.

## Where the answers live

The sources are listed from most to least authoritative for *intent*. The code is the authority for *current behavior*.

| Source | Holds | How to load it |
| --- | --- | --- |
| This conversation | What the user has just said or decided | It is already in context |
| `ROADMAP.md` → Decisions | Dated decisions with their reasons, the Now milestone and what is out of scope | `node .claude/tools/roadmap.mjs show --json` |
| `context/decisions/*.md` | `PRODUCT`, `SCOPE`, `ACTORS`, `SYSTEM_DESIGN`, `EXPOSED_ELEMENTS`, `TECHNICAL_CHOICES` | Read the file that matches the question |
| `context/references/`, `context/integrations/` | External docs and third-party services | Read the file that matches the question |
| `.claude/stones.json` → `answers` | The setup interview: `project`, `stack`, `architecture`, `patterns`, `security`, `conventions`, `workflow`, `guardrails`, `install` | Read the file and use only `answers` and `stack`. `files` and `generated` are install hashes |
| `AGENT.md` | The project brief, rendered from the setup answers | Usually already in context through `CLAUDE.md` |
| `openspec/specs/<capability>/` | `spec.md` Purpose and requirements, and `files.md` with one-line file summaries | Read them, or search them (commands below) |
| `.claude/graph/project.json` | Imports, exports and packages for each file | Query it (commands below). Do not edit it |
| Source code | What actually runs | Read the file. The graph hook adds its capability, summary and dependents |

Skip a source that does not exist. A decision file that contains only its heading records nothing.

## Question → first place to look

| The user asks… | Look first in | Then confirm in |
| --- | --- | --- |
| "Why did we…", "Did we decide…" | Roadmap Decisions, `TECHNICAL_CHOICES.md`, `SYSTEM_DESIGN.md` | The code, to check the decision still holds |
| "Is X in scope?", "Should we build X?" | `SCOPE.md`, roadmap Out of scope and Now | `PRODUCT.md` |
| "Who uses it?", "What can users or other systems call?" | `ACTORS.md`, `EXPOSED_ELEMENTS.md` | The routes and handlers in the code |
| "How is it structured?", "How do the parts talk?" | `SYSTEM_DESIGN.md`, `answers.architecture` | `graph.mjs mermaid`, spec Purposes |
| "Where does X happen?" | `files.md` summaries, spec Purposes | Read the file it points to |
| "What breaks if I change this file?" | The graph's dependents of the file | Read those dependents |
| "How do we test, lint or commit?" | `answers.workflow`, `answers.conventions` | `package.json` and CI config |
| "What must Claude never do?" | `answers.security`, `answers.guardrails` | `.claude/settings.json` permissions |
| "Load the answers", "load context" | Everything above, summarized as a briefing (see the answer shape) | — |

## Commands

Run these from the project root.

```sh
# Roadmap: Outcome, Now, Next, Out of scope and Decisions, as JSON
node .claude/tools/roadmap.mjs show --json

# Which capability and which file summaries mention a term
grep -rn -i "invoice" openspec/specs/*/spec.md openspec/specs/*/files.md context/

# How capabilities depend on each other (Mermaid)
node .claude/hooks/graph.mjs mermaid

# Files that import a given file. When the graph is incomplete, run `build` first
node -e "const g=require('./.claude/graph/project.json');const f=process.argv[1];if(!g.complete)console.error('graph incomplete: run node .claude/hooks/graph.mjs build');console.log(Object.keys(g.files).filter((p)=>(g.files[p].imports??[]).includes(f)).join('\n'))" src/auth/session.ts
```

Reading a source file with the Read tool returns its graph block: capability, summary, exports, imports and used-by. Prefer this over reading neighboring files blindly.

## Procedure

1. **Classify the question** with the table above and load only the sources it names. A question about one decision does not need the whole graph.
2. **Separate intent from behavior.** Records say what was intended, and code says what happens. When a question is about current behavior, confirm the recorded answer in the code before stating it.
3. **Check freshness.** A newer roadmap decision overrides an older one, or a decision file. The graph hook marks a summary stale when the file's exports or imports changed after the summary was written. Treat a stale summary as a lead to check, not as the answer.
4. **Answer in the shape below.**
5. **Offer to record new decisions.** When the user makes a decision during the conversation, offer to record it with `node .claude/tools/roadmap.mjs decide "<decision>" "<why>"`. Write it only after the user agrees.

## Answer shape

1. **Answer:** one to three sentences that answer the question directly.
2. **Sources:** each source the answer rests on, as `path:line`, or as a JSON path such as `.claude/stones.json answers.architecture.style`.
3. **Conflicts:** include this only when a record and the code disagree, or when two records disagree. Quote both sides, say which one is newer, and ask which one should win.
4. **Not recorded:** include this only when part of the question has no record. Say so plainly, give what the code shows instead, and offer to record the missing decision.

For "load the answers", the answer is a briefing instead: what the project is, its architecture and patterns, the Now milestone, the five most relevant decisions, the guardrails, and which sources are empty or missing.

## Common mistakes

- **Making up a reason.** "It probably uses Postgres for reliability" is a guess. If no reason is recorded, say that no reason is recorded.
- **Answering from `AGENT.md` alone.** The brief is a summary. Decisions and specs hold the reasons and the details.
- **Trusting a summary over the code** when the summary is stale or the question is about current behavior.
- **Silently following an old decision** that a newer roadmap row has replaced.
- **Contradicting a decision without saying so.** If the requested work goes against a recorded decision, name the decision and ask before you proceed.
- **Reading `stones.json` `files` hashes** as if they were project information.
