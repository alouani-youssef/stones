---
name: deepeval
description: Use when writing or reviewing DeepEval tests for an LLM app, RAG pipeline or agent — LLMTestCase, ToolCall, GEval, ToolCorrectnessMetric, TaskCompletionMetric, faithfulness or relevancy metrics, Golden and EvaluationDataset, @observe tracing, deepeval test run — or when DeepEval scores are flaky, all pass, or disagree with human review.
metadata:
  title: DeepEval
  frameworks: DeepEval
  summary: Pytest-style LLM evals with DeepEval — goldens from a versioned dataset, deterministic tool-correctness checks, calibrated GEval rubrics with a pinned judge, and `deepeval test run` gated in CI.
---

# DeepEval

DeepEval runs LLM evals as pytest tests. A **golden** is a labelled case (input, expected output, expected tools). Your app turns it into a **test case** (actual output, retrieved context, tools called). **Metrics** score the test case; most are LLM judges, some are deterministic. `assert_test` fails the test when a metric falls below its threshold.

DeepEval is layer 4 of `testing-llm-agents`: quality evals with the real model. Cases and grading rules come from `golden-set`; generating cases with DeepEval's `Synthesizer` is in `generating-golden-sets`. Unit and trajectory tests with a fake model don't need DeepEval.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Cases | `Golden`s loaded from the repo's versioned jsonl (or a pulled, versioned dataset) | inputs hard-coded inside test functions |
| What runs | the app's real entry point, with production prompt, model and tools | a re-implemented LLM call inside the test |
| Tool use | `ToolCorrectnessMetric` on `tools_called` vs `expected_tools` (deterministic) | asking a judge whether the tools "look right" |
| Exact facts | a plain `assert` or a deterministic check before any judge | `GEval` for things code can check |
| Open-ended quality | `GEval` with explicit `evaluation_steps` and only the params it needs | a one-line `criteria` like "is the answer good?" |
| RAG | `FaithfulnessMetric` (answer vs `retrieval_context`), `ContextualRecallMetric` / `ContextualPrecisionMetric` (retriever) | one end-to-end score that hides which half failed |
| Agents end-to-end | `@observe` on the agent and its components, `TaskCompletionMetric` on the trace | only scoring the final message |
| Judge model | pinned and set once (`model=AnthropicModel(model=..., temperature=0)` or a pinned OpenAI name) | the library default, which changes between releases |
| Thresholds | set from a calibration against human grades, written next to the metric | 0.5 everywhere because it is the default |
| Running | `deepeval test run tests/evals/` in a marked, separate CI job | plain `pytest` mixed into the unit suite |
| Reading failures | `include_reason=True`, saved per-case outputs, `deepeval inspect` for traces | rerunning until it passes |

## Example: an agent eval with a deterministic and a judged metric

```jsonl
{"id": "refund-late-01", "input": "Order 4411 arrived 3 weeks late, refund it", "expected_output": "Refund requested for 4411 and sent for approval", "expected_tools": ["find_order", "refund_order"], "tags": ["refund"]}
{"id": "status-01", "input": "Where is order 5120?", "expected_output": "Order 5120 has shipped, expected 21 November", "expected_tools": ["find_order"], "tags": ["status"]}
{"id": "offtopic-01", "input": "Write me a poem about cats", "expected_output": "Polite refusal; only order questions are handled", "expected_tools": [], "tags": ["negative"]}
```

```python
# tests/evals/test_support_agent_eval.py
import json
from pathlib import Path

import pytest
from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden
from deepeval.metrics import GEval, ToolCorrectnessMetric
from deepeval.models import AnthropicModel
from deepeval.test_case import LLMTestCase, SingleTurnParams, ToolCall

from app.support.runner import run_support_agent  # production entry point; returns answer + tool calls

pytestmark = pytest.mark.eval

rows = [json.loads(l) for l in Path("evals/datasets/support.jsonl").read_text().splitlines() if l]
dataset = EvaluationDataset(goldens=[
    Golden(
        input=r["input"],
        expected_output=r["expected_output"],
        expected_tools=[ToolCall(name=t) for t in r["expected_tools"]],
        additional_metadata={"id": r["id"], "tags": r["tags"]},
    )
    for r in rows
])

JUDGE = AnthropicModel(model="claude-sonnet-5-5", temperature=0)  # pinned; recalibrate when changed

tools_metric = ToolCorrectnessMetric(threshold=1.0, should_consider_ordering=True)
correctness = GEval(
    name="Answer correctness",
    evaluation_steps=[
        "Check that every fact in 'expected output' (order id, status, date, refund state) appears in 'actual output'.",
        "Penalise any order id, date or status in 'actual output' that is not in 'expected output'.",
        "A refusal is correct only if 'expected output' is a refusal.",
    ],
    evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT],
    threshold=0.7,  # calibrated on 30 human-graded outputs, 2026-11
    model=JUDGE,
)


@pytest.mark.parametrize("golden", dataset.goldens, ids=lambda g: g.additional_metadata["id"])
def test_support_agent(golden: Golden):
    run = run_support_agent(golden.input)
    test_case = LLMTestCase(
        input=golden.input,
        actual_output=run.answer,
        expected_output=golden.expected_output,
        tools_called=[ToolCall(name=c.name, input_parameters=c.args) for c in run.tool_calls],
        expected_tools=golden.expected_tools,
    )
    assert_test(test_case, [tools_metric, correctness])
```

```sh
deepeval test run tests/evals/test_support_agent_eval.py -n 4   # -n runs cases in parallel
```

The tool metric is deterministic, so a wrong tool is a hard failure. The judged metric has a calibrated threshold. The negative case (`offtopic-01`) expects no tools, which catches an agent that always searches.

## Tracing agents and components

For multi-step agents, decorate the agent and its parts with `@observe` from `deepeval.tracing`. A metric can then score the whole trace (`TaskCompletionMetric`) or a single span, for example the retriever or a sub-agent (`@observe(type="agent", metrics=[...])`). During development, `dataset.evals_iterator(metrics=[...])` runs every golden through the traced app without pytest. Use `deepeval inspect` to read the trace tree with per-span scores and reasons.

For LangChain and LangGraph apps, DeepEval's callback integration builds the trace from the run, so the agent code needs no decorators.

## Rules

- **Deterministic before judged.** Tool names, arguments, JSON schema, ids and numbers are checked with code or `ToolCorrectnessMetric`. Judges only score what code cannot.
- **One criterion per `GEval`.** Correctness, tone and safety are separate metrics with separate thresholds, so a failure says what went wrong.
- **Pass only the params the criterion reads.** Extra `retrieval_context` or `expected_output` in `evaluation_params` lets the judge drift onto other qualities.
- **Calibrate thresholds.** Score 20–30 outputs that people graded; pick the threshold that best separates their passes from their fails; record the date and judge model next to it.
- **Separate infrastructure failures.** A timeout or rate limit in `run_support_agent` should error the test (or be retried), not be scored as a wrong answer.
- **Keep keys out of the repo.** The judge's API key is a CI secret; the eval job is skipped, not failed, on forks without it.
- **Cost is a metric.** Note the number of judge calls per run (cases × metrics × repetitions) and sample on PRs when it grows.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every case passes at 0.5 | default threshold, vague criteria | `evaluation_steps`, calibrated threshold |
| Scores change with no code change | unpinned judge model or temperature | pin the judge, `temperature=0` |
| Tool metric always passes | `expected_tools` empty or not set from the golden | fill expected tools in the dataset, including `[]` for negative cases |
| Faithfulness passes on wrong answers | `retrieval_context` not what the app actually retrieved | pass the retrieved chunks from the real run |
| Evals run in the unit job and fail without keys | eval tests not marked or separated | `tests/evals/`, `pytest.mark.eval`, `deepeval test run` in its own job |
| A whole run fails after one API error | errors scored as failures | catch and report infrastructure errors separately |
| `ImportError` for `LLMTestCaseParams` or `SingleTurnParams` | renamed between DeepEval versions | use the name your pinned version exports; pin `deepeval` in dev dependencies |

## References

- [Getting started with agents](https://deepeval.com/docs/getting-started-agents): `@observe`, goldens, `assert_test`, `deepeval test run`
- [Tool correctness](https://deepeval.com/docs/metrics-tool-correctness): deterministic tool-call scoring
- [G-Eval](https://deepeval.com/docs/metrics-llm-evals): custom judged criteria
- [Task completion](https://deepeval.com/docs/metrics-task-completion): end-to-end agent metric on traces
- [Faithfulness](https://deepeval.com/docs/metrics-faithfulness): answers vs retrieved context
- [Anthropic as the judge](https://deepeval.com/integrations/models/anthropic): `AnthropicModel`
- [Datasets](https://deepeval.com/docs/evaluation-datasets): goldens and `EvaluationDataset`
