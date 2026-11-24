---
name: generating-golden-sets
description: Use when creating or growing the cases of a golden set for an LLM feature, RAG pipeline or agent — mining production traces, support tickets or bug reports, writing a coverage matrix, generating synthetic cases with DeepEval's Synthesizer or an LLM, adding adversarial cases from a Giskard scan, labelling and reviewing cases, or deduplicating and validating a dataset before it is trusted.
metadata:
  title: Generating Golden Sets
  frameworks: Anthropic SDK, OpenAI SDK, LangChain, LangGraph, DeepEval, Giskard
  summary: Generate golden cases from a coverage matrix — real traffic first, synthetic only to fill named gaps, every case human-reviewed, deduplicated, validated and versioned before it gates CI.
---

# Generating Golden Sets

This skill produces the cases. The `golden-set` skill defines what a case is, how it is graded and how it gates CI. The `testing-llm-agents` skill says where the set is used. Read `golden-set` first if the project has no case format yet.

Generation is a pipeline, not a prompt: **plan coverage → collect real cases → fill gaps synthetically → label → review → validate → version**. A generated case that nobody reviewed is a guess, and a set built from guesses measures nothing.

## Quick reference

| Step | Do | Instead of |
| --- | --- | --- |
| Plan | a coverage matrix: rows are intents or tasks, columns are dimensions (difficulty, language, input length, should-act / should-not-act, risk) with a target count per cell | "generate 200 questions" |
| Real cases | sample production traces, tickets, bug reports and escalations, stratified by intent; scrub PII first | the ten examples the developer remembers |
| Synthetic | only for empty cells, with the cell's constraints in the generation prompt | a bulk synthetic set that looks like the prompt's own examples |
| Generator model | a different model (or family) from the one under test, at a non-zero temperature | the same model generating and answering its own questions |
| RAG cases | generated from specific chunks, with the chunk ids stored as the expected context | questions answerable from general knowledge |
| Agent cases | expected tool calls and arguments, including `[]` for cases where no tool should run | only expected final text |
| Multi-turn | scripted conversations with the turn where the behaviour is checked | single turns that can't test memory or consistency |
| Adversarial | Giskard `vulnerability_scan` findings and hand-written injection, leakage and out-of-scope cases | trusting the system prompt to refuse |
| Labels | written or corrected by a person who knows the domain; `source` and `reviewer` per case | the generator's answer accepted as the reference |
| Review | accept / edit / reject every synthetic case; record the rejection reason | spot-checking a few |
| Validate | schema, duplicates, near-duplicates, label balance, cell counts, leakage into prompts and few-shots | discovering broken cases from a surprising score |
| Version | jsonl in the repo, one commit per batch, with the generation script and its config | regenerating on every run |

## 1. Write the coverage matrix

```yaml
# evals/datasets/support.coverage.yaml
feature: support-agent
dimensions:
  difficulty: [simple, multi-step, ambiguous]
  action: [should-act, should-not-act]
  language: [en, fr]
cells:
  - {intent: order-status, difficulty: simple,     action: should-act,     language: en, target: 8}
  - {intent: order-status, difficulty: ambiguous,  action: should-act,     language: en, target: 4}
  - {intent: refund,       difficulty: multi-step, action: should-act,     language: en, target: 6}
  - {intent: refund,       difficulty: simple,     action: should-not-act, language: en, target: 4}  # not eligible
  - {intent: off-topic,    difficulty: simple,     action: should-not-act, language: fr, target: 3}
  - {intent: injection,    difficulty: simple,     action: should-not-act, language: en, target: 5}
```

The matrix is the spec of the set. It is reviewed like code, and each case is tagged with its cell, so scores can be read per cell and gaps are visible.

## 2. Collect real cases first

- Export a sample of production inputs (traces in LangSmith or Confident AI, logs, tickets). Stratify by intent so rare intents are not drowned out.
- Scrub personal data before the cases enter the repo: replace names, emails, addresses and ids with consistent fake values, keeping the structure.
- Add every bug report and escalation as a case, with `source: "bug-<id>"`.
- Assign each case to a cell. Cells that stay empty are the only ones synthetic generation should fill.

## 3. Fill gaps synthetically

### With DeepEval's Synthesizer (RAG and document-grounded features)

```python
# evals/generate/support_from_docs.py: fills the "policy question" cells from the help-centre docs
from deepeval.models import AnthropicModel
from deepeval.synthesizer import Synthesizer
from deepeval.synthesizer.config import StylingConfig

synthesizer = Synthesizer(
    model=AnthropicModel(model="claude-opus-5-5", temperature=0.7),  # not the model under test
    styling_config=StylingConfig(
        scenario="A customer of an online bookshop asking about delivery, returns or refunds",
        task="Answer the customer's question using only the bookshop's policies",
        input_format="A short, informal customer message, sometimes with typos",
        expected_output_format="Two or three sentences citing the relevant policy",
    ),
)
synthesizer.generate_goldens_from_docs(
    document_paths=["docs/policies/returns.md", "docs/policies/delivery.md"],
    include_expected_output=True,
)
synthesizer.save_as(file_type="json", directory="evals/generated", file_name="support-policies-batch-03")
```

The output goes to `evals/generated/`, **not** to the dataset. It enters the dataset only after review (step 5). Other entry points: `generate_goldens_from_contexts` (your own chunks, keeps chunk ids), `generate_goldens_from_goldens` (variations of reviewed real cases, the best way to grow a thin cell) and `generate_conversational_goldens_from_*` for multi-turn cases.

### With a plain LLM call (agents, classification, anything without documents)

```python
# evals/generate/fill_cells.py: one prompt per empty cell, seeded with real examples from nearby cells
import json
from pathlib import Path

import anthropic
import yaml

client = anthropic.Anthropic()
coverage = yaml.safe_load(Path("evals/datasets/support.coverage.yaml").read_text())
existing = [json.loads(l) for l in Path("evals/datasets/support.jsonl").read_text().splitlines() if l]


def count(cell):
    return sum(1 for c in existing if c["cell"] == cell)


for cell in coverage["cells"]:
    key = "/".join(str(cell[k]) for k in ("intent", "difficulty", "action", "language"))
    missing = cell["target"] - count(key)
    if missing <= 0:
        continue
    seeds = [c["input"] for c in existing if c["cell"].startswith(cell["intent"])][:5]
    prompt = (
        f"Write {missing} distinct customer messages for an online bookshop's support agent.\n"
        f"Intent: {cell['intent']}. Difficulty: {cell['difficulty']}. Language: {cell['language']}.\n"
        f"The correct behaviour is: {cell['action']} (should-not-act means the agent must not call any tool).\n"
        f"Vary length, tone and wording; do not copy these real examples: {json.dumps(seeds)}\n"
        'Return a JSON list of objects: {"input": str, "why_this_cell": str}.'
    )
    msg = client.messages.create(model="claude-opus-5-5", max_tokens=4000, messages=[{"role": "user", "content": prompt}])
    out = Path(f"evals/generated/{key.replace('/', '__')}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(msg.content[0].text)  # inputs only: labels are written by a person in review
```

Generate **inputs** freely; generate **expected outputs** only as drafts for a reviewer to correct, never as the reference.

### Adversarial cases from Giskard

Run `vulnerability_scan` (see the `giskard` skill) and turn each confirmed finding into a case in the `injection`, `leakage` or `harmful` cells, with the expected behaviour written by a person. Add hand-written attacks specific to the domain (another customer's order id, a refund over the limit, instructions hidden in a pasted document).

## 4. Label

- Each case gets `expected` (or a `rubric`), `expected_tools`, `cell`, `tags`, `source` (`prod-<date>`, `bug-<id>`, `synthetic-<batch>`, `scan-<date>`) and `reviewer`.
- For tasks with judgement, two people label a sample of 20–30 cases independently. Where they disagree, the case or the rubric is unclear: rewrite it before labelling the rest.
- Labels describe correct behaviour, not the current system's behaviour. A case the system fails today is a good case.

## 5. Review every generated case

Move cases from `evals/generated/` into the dataset only through review, in a PR:

| Reject when | Because |
| --- | --- |
| it doesn't fit its cell | it skews the per-cell scores |
| it can be answered without the feature (general knowledge, no tool needed) | it measures the base model, not your system |
| it is a near-copy of another case or of a few-shot example | it inflates the count and leaks |
| a domain expert can't agree on the right answer | it measures opinion |
| it is unrealistic: no customer would write it | it rewards behaviour nobody needs |

Record accept / edit / reject counts per batch. A batch with a high rejection rate means the generation prompt needs fixing, not more filtering.

## 6. Validate before trusting

```python
# evals/validate_dataset.py: run in CI on every change to evals/datasets/
import json
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

import yaml

REQUIRED = {"id", "input", "cell", "tags", "source", "reviewer"}
cases = [json.loads(l) for l in Path("evals/datasets/support.jsonl").read_text().splitlines() if l]
coverage = yaml.safe_load(Path("evals/datasets/support.coverage.yaml").read_text())
prompts = " ".join(p.read_text() for p in Path("app/prompts").glob("*.md"))
errors = []

for c in cases:
    if missing := REQUIRED - c.keys():
        errors.append(f"{c.get('id')}: missing {sorted(missing)}")
    if "expected" not in c and "rubric" not in c:
        errors.append(f"{c['id']}: needs expected or rubric")
    if c["input"][:60] in prompts:
        errors.append(f"{c['id']}: input appears in a prompt or few-shot example")

for id_, n in Counter(c["id"] for c in cases).items():
    if n > 1:
        errors.append(f"duplicate id {id_}")

texts = [(c["id"], c["input"].lower()) for c in cases]
for i, (a, ta) in enumerate(texts):
    for b, tb in texts[i + 1:]:
        if SequenceMatcher(None, ta, tb).ratio() > 0.9:
            errors.append(f"near-duplicate: {a} ~ {b}")

counts = Counter(c["cell"] for c in cases)
for cell in coverage["cells"]:
    key = "/".join(str(cell[k]) for k in ("intent", "difficulty", "action", "language"))
    if counts[key] < cell["target"]:
        print(f"warning: {key} has {counts[key]}/{cell['target']}")

print(f"{len(cases)} cases, sources: {dict(Counter(c['source'].split('-')[0] for c in cases))}")
if errors:
    print("\n".join(errors))
    sys.exit(1)
```

Also run each reference answer through the grader: a reference that fails its own grader is a broken case (see `golden-set`).

## 7. Version and keep it alive

- One commit per batch: the cases, the generation script and config, and the review counts in the message.
- Keep a dev split for tuning and a held-out split you only report on; assign new cases to splits at random when they are added.
- Keep the share of synthetic cases visible (the validator prints it). If synthetic cases outnumber real ones in a cell, replace them as real traffic arrives.
- When the pass rate saturates (about 95%), generate harder cases for the weakest cells rather than more easy ones.
- Every production failure becomes a case before its fix, so the set keeps growing from reality.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| New prompt scores well, users still complain | set mostly synthetic, unlike real traffic | re-seed from production; cap the synthetic share per cell |
| Every model scores ~100% | cases answerable from general knowledge, or generated by the model under test | ground cases in your documents and tools; use a different generator model |
| Scores jump between dataset versions | batches added without validation or review | the validator in CI; review every batch in a PR |
| Always-act agent passes | no should-not-act cells | add them to the matrix with targets |
| Two people grade the same output differently | labels or rubrics are ambiguous | double-label a sample; rewrite cases where they disagree |
| Real customer data in the repo | traces copied without scrubbing | scrub PII before export; validate for emails and phone numbers |
| Score rises after adding few-shot examples | examples copied from the golden set | leakage check against prompts in the validator |

## References

- [DeepEval Synthesizer](https://deepeval.com/docs/synthesizer-introduction): generating goldens from documents, contexts, scratch and existing goldens
- [Giskard scan](https://docs.giskard.ai/oss/solutions/scan-vulnerabilities.md): adversarial inputs for red-team cases
- [LangSmith datasets](https://docs.langchain.com/langsmith/manage-datasets): building datasets from traces and versioning them
- [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): writing cases and generating test cases with Claude
