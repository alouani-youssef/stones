---
name: langgraph
description: Use when building or reviewing a LangGraph workflow or agent — designing graph state and reducers, nodes, conditional edges, checkpointers, threads, interrupts for human approval, subgraphs or long-term memory — or when a graph loops until GraphRecursionError, loses state between runs, repeats side effects after resume, or is hard to test.
metadata:
  title: LangGraph
  frameworks: LangGraph
  summary: Explicit typed state with reducers, small nodes that return updates, routing in code, durable checkpointers with thread ids, idempotent work around interrupts, and nodes tested as plain functions.
---

# LangGraph

LangGraph runs a workflow as a graph of **nodes**, which are functions that read state and return updates. **Edges** decide which node runs next. A **checkpointer** saves the state after every step, so a run can pause, resume, survive a crash, or wait days for a person.

Use it when you need control over the steps: fixed stages, branching decided by code, approvals, retries, long-running or resumable work. For a plain tool-calling agent, LangChain's `create_agent` (which is built on LangGraph) is less code.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| State | one `TypedDict` (or Pydantic model) with only the fields the workflow needs; `Annotated[list, add_messages]` or `operator.add` for fields that accumulate | an untyped dict, or storing whole API responses in state |
| Nodes | small functions that return a dict of the fields they change | nodes that mutate state in place, or return the whole state |
| Routing | `add_conditional_edges` with a function that reads state and returns a node name, as a `Literal` | asking the model which node to run when code can decide |
| LLM calls | inside nodes, with structured output, so routing reads typed fields | routing on substrings of model text |
| Persistence | `compile(checkpointer=...)`: `InMemorySaver` in tests, a database-backed saver (`PostgresSaver`) in production | `InMemorySaver` in production, where a restart forgets every thread |
| Threads | a stable `thread_id` per conversation or job in `config["configurable"]` | a new id per call, so nothing resumes |
| Human approval | `interrupt(payload)` in a node; resume with `Command(resume=value)` on the same `thread_id` | polling a database from inside a node |
| Side effects | after the `interrupt()` call, or idempotent (upsert, idempotency key) | sending an email or charging a card before an interrupt, which re-runs on resume |
| Loops | a counter in state, plus a conditional edge that exits; `recursion_limit` as a backstop | relying on `GraphRecursionError` to stop a loop |
| Long-term memory | a `Store` (`compile(store=...)`) for facts shared across threads | stuffing cross-conversation memory into thread state |
| Reuse | compiled subgraphs for self-contained stages | one giant graph |
| Streaming | `stream` / `stream_events` for progress and tokens | blocking `invoke` behind a spinner for minutes |

## Example: draft, review by a person, publish

```python
# app/announcements/graph.py
from typing import Literal, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from app.announcements import writer, publisher  # your own code: LLM call and side effect


class State(TypedDict):
    topic: str
    draft: str
    attempts: int
    decision: str  # "approve" or "revise"
    feedback: str


def write_draft(state: State) -> dict:
    draft = writer.draft(state["topic"], feedback=state.get("feedback", ""))
    return {"draft": draft, "attempts": state.get("attempts", 0) + 1}


def human_review(state: State) -> dict:
    # Pauses the run and returns this payload to the caller. On resume, the node starts
    # over and interrupt() returns the person's answer, so nothing above it may have side effects.
    answer = interrupt({"draft": state["draft"], "attempt": state["attempts"]})
    return {"decision": answer["decision"], "feedback": answer.get("feedback", "")}


def publish(state: State) -> dict:
    publisher.publish(state["draft"], idempotency_key=state["topic"])  # safe if retried
    return {}


def after_review(state: State) -> Literal["publish", "write_draft", "__end__"]:
    if state["decision"] == "approve":
        return "publish"
    return "write_draft" if state["attempts"] < 3 else END  # the loop has an exit in code


graph = (
    StateGraph(State)
    .add_node("write_draft", write_draft)
    .add_node("human_review", human_review)
    .add_node("publish", publish)
    .add_edge(START, "write_draft")
    .add_edge("write_draft", "human_review")
    .add_conditional_edges("human_review", after_review)
    .add_edge("publish", END)
    .compile(checkpointer=InMemorySaver())  # PostgresSaver in production
)

config = {"configurable": {"thread_id": "announcement-42"}}
result = graph.invoke({"topic": "Summer sale"}, config)
pending = result["__interrupt__"][0]                  # shown to the reviewer
result = graph.invoke(Command(resume={"decision": "approve"}), config)  # same thread_id
```

## Interrupts: the rules

These follow from the fact that a resumed node **starts again from its first line**:

- Code before `interrupt()` runs again on resume. Keep it free of side effects, or make it idempotent.
- Never wrap `interrupt()` in a broad `try/except`. It pauses the run by raising, and a bare `except` swallows the pause.
- Resume values are matched to interrupts by their order within the node. Don't skip interrupts conditionally, reorder them, or loop over data that may change between runs.
- To ask again, return from the node and route back to it with a conditional edge. Don't use a `while True:` loop around `interrupt()`.
- Pass JSON-serialisable values to `interrupt()` and `Command(resume=...)`.

## Production

- **Checkpointer:** `PostgresSaver` from `langgraph-checkpoint-postgres` (`AsyncPostgresSaver` for async apps). Call `setup()` once in a migration or deploy step, not on every request.
- **Thread ids** come from your domain (`ticket-4411`, `job-<uuid>`), so you can find, inspect and resume a run later. Use the checkpointer's state history to debug a run step by step.
- **State is stored and replayed**, so keep it small and serialisable. Store references (ids, URLs) to large documents, not the documents.
- **Changing the state schema** affects threads already in progress. Add fields with defaults, and avoid renaming or retyping fields that saved threads use.

## Testing

The `testing-llm-agents` skill sets the overall strategy and routes quality evals to `deepeval` or `giskard`.

- **Nodes and routing functions are plain functions.** Unit-test them with a hand-built state dict, with no graph and no model.
- **Test the graph's paths** by compiling with `InMemorySaver` and replacing the LLM-backed code with fakes (inject them, or patch your own `writer` module). Assert the order of nodes visited and the final state, including the interrupt and resume path.
- **Test the LLM-backed steps** against a golden set with the real model (see the golden-set skill), scored with DeepEval metrics or Giskard Checks in a separate eval job.
- **Test multi-turn and resume behaviour** with a Giskard multi-turn `Scenario` against the compiled graph, and red-team it with a Giskard scan before release.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GraphRecursionError` | a cycle with no exit condition in code | counter in state, plus a conditional edge to `END` |
| Messages overwritten instead of appended | list field without a reducer | `Annotated[list[AnyMessage], add_messages]` |
| Email sent twice after approval | side effect before `interrupt()` | move it after the interrupt, or make it idempotent |
| Resume starts a fresh run | different `thread_id`, or no checkpointer | same `thread_id`; compile with a checkpointer |
| All threads lost on restart | `InMemorySaver` in production | `PostgresSaver` (or another durable saver) |
| Run never pauses | `interrupt()` inside `try/except Exception` | catch specific exceptions only |
| Routing breaks on wording changes | edges decided from free model text | structured output into typed state fields; route on those |

## References

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview): when to use LangGraph, and its core ideas
- [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api): state, reducers, nodes, edges, `Command`, recursion limit
- [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence): checkpointers, threads, stores
- [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers): durable savers, and inspecting thread state
- [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts): human-in-the-loop, resume values, the re-run rules
- [Stores](https://docs.langchain.com/oss/python/langgraph/stores): long-term memory across threads
- [Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution): resuming after failures, and determinism requirements
- [Streaming](https://docs.langchain.com/oss/python/langgraph/streaming): progress, tokens and events
- [Subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs): composing graphs
