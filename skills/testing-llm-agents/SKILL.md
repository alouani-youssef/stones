---
name: testing-llm-agents
description: Use when deciding how to test an LLM feature, RAG pipeline or tool-calling agent (LangChain, LangGraph, Anthropic or OpenAI SDK); before adding DeepEval, Giskard or another eval tool; when setting up AI eval tests in CI; or when agent tests are flaky, slow, expensive, all mocked, or pass while users see wrong answers.
metadata:
  title: Testing LLM Agents
  frameworks: Anthropic SDK, OpenAI SDK, LangChain, LangGraph, DeepEval, Giskard
  summary: One test strategy for LLM agents — deterministic tests for the code, trajectory tests for tool use, a golden set with DeepEval metrics for quality, Giskard scans for safety — each layer with its own CI gate.
---

# Testing LLM Agents

An agent is ordinary code (tools, state, routing, parsing) wrapped around a model that is non-deterministic. Test the two parts differently. Most bugs live in the ordinary code, and those tests should be fast, free and deterministic. The model's behaviour is measured statistically against labelled cases, never asserted from one run.

This skill is the entry point. It chooses the layer and the tool, then hands off:

| Need | Skill |
| --- | --- |
| Agent and tool code in LangChain | `langchain` |
| Graph workflows, state, interrupts | `langgraph` |
| The dataset of cases and how to grade them | `golden-set` |
| Producing the cases: real traffic, synthetic generation, review, validation | `generating-golden-sets` |
| LLM-judge metrics, tool-correctness, component evals in pytest | `deepeval` |
| Scenario checks, multi-turn tests, vulnerability and red-team scans | `giskard` |
| Prompt and system-prompt changes | `prompts`, `system-prompts` |

## The layers

| Layer | What it proves | Model | Runs | Gate |
| --- | --- | --- | --- | --- |
| 1. Unit | tool functions, parsers, state reducers, routing functions are correct | none | every commit, seconds | all pass |
| 2. Contract | each tool's name, docstring and argument schema are what the model will see; tools reject bad or cross-tenant arguments | none | every commit | all pass |
| 3. Trajectory | the agent loop calls the right tools in the right order, stops, pauses on approvals, resumes without repeating side effects | fake model with scripted tool calls | every commit | all pass |
| 4. Quality eval | on real cases, with the real model, answers are correct, grounded and the tools chosen are right | real | PR touching prompts, models, tools or retrieval; nightly | pass rate ≥ baseline − noise |
| 5. Safety scan | prompt injection, data leakage, harmful or off-policy output, hallucination under pressure | real, adversarial inputs | before release; weekly | no new high-severity findings |
| 6. Production | live traces sampled and scored; failures become golden cases | real | continuous | alert on drift |

Layers 1–3 belong in the normal test suite (`pytest`) and must never call a paid API. Layers 4–5 are evals: marked, slower, cost money, and run separately.

## Choosing the tool

| Question | Use |
| --- | --- |
| Is the code right? | plain `pytest`; fake chat models (`GenericFakeChatModel`, `FakeListChatModel` from `langchain_core`) or an injected fake client |
| Did the agent pick the right tools with the right arguments? | layer 3 with a fake model for the loop; DeepEval `ToolCorrectnessMetric` on real runs |
| Is the answer correct / relevant / faithful to retrieved context? | code graders first (`golden-set`); then DeepEval `GEval`, `AnswerRelevancyMetric`, `FaithfulnessMetric` |
| Does a multi-turn conversation behave (keeps context, refuses consistently)? | Giskard `Scenario` with several `.interact()` turns, or DeepEval conversational metrics |
| Can it be attacked or made to leak, insult or hallucinate? | Giskard `vulnerability_scan`; add the findings as regression scenarios |
| Is it better than last week? | the golden set's baseline comparison in CI (`golden-set`) |
| Tracing and dataset management | LangSmith for LangChain/LangGraph apps, or Confident AI with DeepEval; pick one, not both |

Pick DeepEval **or** Giskard Checks as the primary quality-eval runner, not both for the same metric. A common split: DeepEval for metric-based quality evals on the golden set, Giskard Scan for adversarial safety scans.

## Example: one agent, three layers

```python
# tests/unit/test_support_agent.py
from langchain.messages import AIMessage, ToolCall
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

from app.orders import service
from app.support.agent import TOOLS, build_agent, find_order  # build_agent(model) injects the model


class ScriptedModel(GenericFakeChatModel):
    """Replays scripted turns. create_agent calls bind_tools, which the fake lacks."""

    def bind_tools(self, tools, **kwargs):
        return self


# layer 1: the code under the tool, no model
def test_find_order_returns_only_what_the_model_needs(orders_db):
    assert find_order.invoke({"order_id": "4411"}) == {"id": "4411", "status": "shipped", "eta": "2026-11-21"}


# layer 2: the contract the model sees
def test_refund_tool_takes_only_order_and_reason():
    refund = next(t for t in TOOLS if t.name == "refund_order")
    assert set(refund.args) == {"order_id", "reason"}


# layer 3: the loop, with a scripted model
def test_refund_request_looks_up_then_pauses_for_approval(orders_db):
    model = ScriptedModel(messages=iter([
        AIMessage("", tool_calls=[ToolCall(name="find_order", args={"order_id": "4411"}, id="1")]),
        AIMessage("", tool_calls=[ToolCall(name="refund_order", args={"order_id": "4411", "reason": "late"}, id="2")]),
    ]))
    result = build_agent(model).invoke(
        {"messages": [{"role": "user", "content": "Refund 4411, it was late"}]},
        config={"configurable": {"thread_id": "t-1"}},
    )
    called = [c["name"] for m in result["messages"] if isinstance(m, AIMessage) for c in m.tool_calls]
    assert called == ["find_order", "refund_order"]
    assert "__interrupt__" in result  # refunds pause for human approval
    assert service.refunds() == []    # and nothing was refunded yet
```

For trajectory checks on real runs, `agentevals` compares the message list with a reference trajectory: `create_trajectory_match_evaluator(trajectory_match_mode="strict" | "unordered" | "subset" | "superset")`. Layer 4 lives in `tests/evals/` (see `deepeval` or `giskard`).

## Layout and CI

```text
tests/
  unit/          layers 1–3: pytest, no network, runs on every commit
  evals/         layer 4: golden-set runs with DeepEval or Giskard Checks, marked `eval`
  redteam/       layer 5: Giskard scans and the regression scenarios they produced
evals/
  datasets/      versioned golden cases (jsonl), one file per feature
  baselines/     stored pass rates the CI gate compares against
```

- `pytest -m "not eval"` on every push. Block network in this job so an accidental live call fails loudly.
- Evals on PRs that touch `prompts/`, model config, tool definitions or retrieval, plus a nightly run. Keep the judge model pinned and the API key a CI secret.
- Publish a JUnit report and the per-case outputs as artifacts, so a failing eval can be read without rerunning it.
- Fail the eval job on a regression beyond the run-to-run spread, not on any single failed case.

## Rules

- **Never mock the model in a quality eval, never call it in a unit test.** Mixing them gives tests that are both flaky and meaningless.
- **Inject the model.** An agent built by `build_agent(model)` is testable; one that reads a global model at import time is not.
- **Assert trajectories, not wording.** Tool calls, arguments, order, interrupts and final state are stable; phrasing is not.
- **Judges are models too.** Pin the judge model, give it a rubric, and calibrate it on 20–30 human-graded outputs before trusting a threshold (see `golden-set`).
- **Every production failure becomes a case** in the golden set or a red-team scenario before it is fixed.
- **Separate errors from wrong answers.** Timeouts, rate limits and refusals are counted on their own, not as failed quality.
- **Budget the evals.** Record cost and duration per run; sample the golden set on PRs and run all of it nightly if it is large.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Unit suite is slow, flaky and needs API keys | tests call the real model | inject a fake chat model; move live calls to `tests/evals` |
| All tests pass, users report wrong answers | only mocked tests, no quality eval | add a golden set and a layer-4 job |
| Eval fails randomly on PRs | one run per case, threshold on single cases | several runs per case; gate on pass rate vs baseline |
| Judge scores drift without code changes | judge model unpinned or upgraded | pin the judge; re-calibrate when changing it |
| Agent passes evals, gets jailbroken in production | no adversarial testing | Giskard scan before release; turn findings into scenarios |
| Two eval tools disagree, nobody knows which to trust | the same metric measured twice | one primary runner per metric; document the choice |
| Evals cost more than the feature | full suite with an expensive judge on every push | path-filtered triggers, sampling on PRs, cheaper calibrated judge |

## References

- [LangChain testing](https://docs.langchain.com/oss/python/langchain/test): unit, integration and evaluation testing for agents
- [DeepEval docs](https://deepeval.com/docs/getting-started): metrics, datasets, `deepeval test run`
- [Giskard OSS docs](https://docs.giskard.ai/oss): Checks and Scan
- [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): test design and grading
