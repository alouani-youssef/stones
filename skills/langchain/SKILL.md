---
name: langchain
description: Use when building or reviewing a LangChain application — creating an agent with create_agent, defining tools, choosing or configuring a chat model, adding middleware, structured output, memory or human approval — or when code still uses LLMChain, AgentExecutor or initialize_agent, or an agent loops, calls the wrong tool, or is hard to test.
metadata:
  title: LangChain
  frameworks: LangChain
  summary: create_agent with small, well-described tools, structured output, middleware for retries, limits and approvals, a checkpointer for memory, and tests that don't depend on a live model.
---

# LangChain

LangChain 1.x builds agents with one entry point, `create_agent`, which runs on LangGraph underneath. Behaviour is added with **middleware** rather than custom chain classes. Most of the work is not LangChain code. It is the tools you give the agent, the instructions, and the checks around it. Keep that code yours, plain, and testable. Use LangChain for the model calls, the agent loop and the integrations.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Agent | `create_agent(model=..., tools=[...], system_prompt=...)` | `AgentExecutor`, `initialize_agent`, `LLMChain` (legacy; moved to `langchain-classic`) |
| Model | a `"provider:model"` string or one configured model instance, set in config | model names and keys hard-coded across modules |
| Tools | small functions with typed arguments and a docstring saying *when* to use them | one "do everything" tool, or tools whose names and docs overlap |
| Tool code | a thin `@tool` wrapper over your own service or repository function | business logic written inside the tool |
| Output | `response_format=MyModel`, read from `result["structured_response"]` | parsing JSON out of the final message text |
| Retries, fallbacks, limits | `ModelRetryMiddleware`, `ToolRetryMiddleware`, `ModelFallbackMiddleware`, `ModelCallLimitMiddleware`, `ToolCallLimitMiddleware` | hand-written retry loops around `invoke` |
| Risky actions | `HumanInTheLoopMiddleware(interrupt_on={...})` with a checkpointer | trusting the model to ask before sending, paying or deleting |
| Conversation memory | `checkpointer=` plus a `thread_id` in `config` | resending a hand-kept message list |
| Long conversations | `SummarizationMiddleware` or `ContextEditingMiddleware` | letting the context grow until requests fail |
| Per-run data (user id, tenant) | `context_schema` plus `context=` on invoke | pasting ids into the prompt, where the model can change them |
| Sensitive data | `PIIMiddleware`, and tools that only return what the model needs | returning whole database rows to the model |
| Observability | LangSmith tracing (`LANGSMITH_TRACING=true`) from day one | print-debugging agent runs |

## Example: an agent with typed tools, structured output and an approval gate

```python
# app/support/agent.py
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, ToolRetryMiddleware
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver  # a database-backed checkpointer in production
from pydantic import BaseModel

from app.orders import service  # plain, tested business code; the tools only adapt it


@tool
def find_order(order_id: str) -> dict:
    """Look up one order by its id (for example "4411"). Use this before answering any
    question about an order's status, items or delivery date."""
    order = service.get_order(order_id)
    return {"id": order.id, "status": order.status, "eta": order.eta.isoformat()} if order else {"error": "not found"}


@tool
def refund_order(order_id: str, reason: str) -> str:
    """Refund an order in full. Use only when the customer asks for a refund and the
    order is eligible according to find_order."""
    return service.refund(order_id, reason)


class Reply(BaseModel):
    answer: str
    order_id: str | None
    refunded: bool


agent = create_agent(
    model="anthropic:claude-opus-5-5",
    tools=[find_order, refund_order],
    system_prompt=(
        "You answer customer questions about their orders for an online bookshop. "
        "Look orders up before answering; never guess a status or date."
    ),
    response_format=Reply,
    middleware=[
        ToolRetryMiddleware(max_retries=2),
        # refunds move money: a person approves, edits or rejects each one
        HumanInTheLoopMiddleware(interrupt_on={
            "refund_order": {"allowed_decisions": ["approve", "edit", "reject"]},
            "find_order": False,
        }),
    ],
    checkpointer=InMemorySaver(),
)

config = {"configurable": {"thread_id": "ticket-4411"}}
result = agent.invoke({"messages": [{"role": "user", "content": "Where is order 4411?"}]}, config=config)
reply: Reply = result["structured_response"]
```

When a refund is requested, the run pauses with an interrupt instead of refunding. Your application shows the pending call to a person, then resumes the same `thread_id` with their decision (`Command(resume=...)`, see the human-in-the-loop reference).

## Tools are the interface

The model chooses what to do from the tool names, docstrings and argument types alone, so treat them as an API designed for a reader who can't see your code.

- **One job per tool.** Name it with a verb and an object (`find_order`, `refund_order`). The docstring says what the tool does, *when* to use it, and what the arguments look like.
- **Typed, narrow arguments.** Use `str`, `int`, `Literal[...]` or a Pydantic model, not a free-form `query: str` that the tool then has to parse.
- **Return what the model needs, not everything.** Small dicts or short text, with ids the model can pass to the next tool. Return errors as values the model can act on (`{"error": "not found"}`) rather than raising for expected cases.
- **Enforce permissions in the tool**, using the run's context (user, tenant), never using arguments the model supplies. The model can be talked into passing someone else's id.
- **Side effects are explicit.** Tools that write, send or pay are separate from read tools, and go behind `HumanInTheLoopMiddleware` or a call limit.

## Testing

- **Unit-test the code under the tools** like any other code. A tool can be called directly too: `find_order.invoke({"order_id": "4411"})`.
- **Test the agent's behaviour** with a golden set: real questions, expected tool calls and expected answers, run against the real model (see the golden-set skill). For a test that does not call the model, swap in a fake chat model from `langchain_core`, or emulate tools with `LLMToolEmulator`.
- **Check trajectories, not only final text.** Assert that the refund question led to `find_order` before `refund_order`, and that an off-topic question led to no tool calls.
- **Trace every run** in LangSmith during development, so a wrong answer can be traced to the tool call or prompt that caused it.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Agent calls the wrong tool or none | vague or overlapping tool docstrings | rename; say *when* to use each tool; remove tools the task doesn't need |
| Agent loops until the recursion limit | tool errors raised instead of returned, or no stop condition | return actionable errors; add `ModelCallLimitMiddleware` / `ToolCallLimitMiddleware` |
| Output parsing fails | JSON requested in the prompt | `response_format=` with a Pydantic model |
| Agent forgets earlier turns | no checkpointer, or a new `thread_id` each call | checkpointer plus a stable `thread_id` per conversation |
| `ImportError` for `LLMChain` / `initialize_agent` | legacy APIs moved out in 1.x | rewrite with `create_agent`; use `langchain-classic` only as a bridge |
| Model acts on another user's data | ids taken from tool arguments | read the user from the run context inside the tool |
| Tests are slow, flaky and cost money | every test calls a live model | unit-test tool code; keep live-model checks in the golden set |

## References

- [LangChain overview](https://docs.langchain.com/oss/python/langchain/overview): what LangChain 1.x is and how it relates to LangGraph
- [Agents](https://docs.langchain.com/oss/python/langchain/agents): `create_agent`, models, tools, system prompts, invocation
- [Tools](https://docs.langchain.com/oss/python/langchain/tools): defining tools, arguments, runtime context
- [Structured output](https://docs.langchain.com/oss/python/langchain/structured-output): `response_format` strategies
- [Built-in middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in): retries, fallbacks, limits, summarization, PII, human-in-the-loop
- [Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop): interrupting on tool calls and resuming with decisions
- [Short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory): checkpointers and threads
- [Testing](https://docs.langchain.com/oss/python/langchain/test): unit, integration and evaluation testing for agents
- [LangSmith observability](https://docs.langchain.com/langsmith/observability): tracing runs
- [LangChain v1 migration guide](https://docs.langchain.com/oss/python/migrate/langchain-v1): moving from chains and `AgentExecutor`
