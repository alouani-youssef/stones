---
name: system-prompts
description: Use when designing, reviewing or revising persistent system or developer instructions for an AI assistant, agent, or product, especially when instructions, tools, user data, and policy have unclear boundaries.
metadata:
  title: System Prompts
  summary: Design durable assistant instructions with clear priority, scope, tool boundaries, untrusted-data handling, and behavioral evaluations.
---

# System Prompts

Use this guide for persistent system and developer instructions that define an assistant's role and operating rules. Use the complementary `prompts` skill for application-owned prompt templates and individual model calls. Keep the two connected: durable policy belongs in system/developer instructions; request-specific facts belong in the user turn or structured context.

## Design sequence

1. **Define the job and success criteria.** Name the assistant's audience, task, expected result, and important failure modes. Keep role text useful to the actual task rather than relying on generic persona claims.
2. **Separate stable rules from changing context.** Put durable behavior in system/developer instructions. Pass user requests, retrieved material, and per-request facts as data in the appropriate message or structured input.
3. **Make instruction priority explicit.** State which instructions govern the assistant and how to handle conflicting lower-priority requests. Do not imply that quoted or retrieved text can override governing instructions.
4. **Bound tools and side effects.** List the tools the assistant may use, when each applies, and which actions require confirmation. Enforce permissions and validate arguments in application code; prompt wording alone is not an authorization boundary.
5. **Specify observable behavior.** Describe the expected response or action in terms that can be checked. Use structured output or tool schemas where available, then validate at runtime.
6. **Evaluate representative cases.** Include ordinary requests, ambiguous inputs, instruction conflicts, prompt-injection attempts in supplied content, tool misuse attempts, and refusal or escalation cases. Compare revisions against the same set.
7. **Remove stale or duplicated rules.** Keep instructions short enough to inspect. Resolve contradictory rules at their source instead of stacking more emphatic wording on top.

## Trust boundaries

Treat user messages, uploaded documents, retrieved passages, web pages, tool results, and generated text as content to process. Explicitly mark these as untrusted data when they are embedded in a prompt. The assistant may extract facts from them, but their embedded instructions do not change the assistant's governing rules.

Use defense in depth: limit tool access, validate structured arguments, require confirmation for consequential actions, and check the result of side effects. A prompt can guide behavior; application controls enforce it.

## Review checklist

- Is the assistant's task and intended audience clear?
- Are stable instructions separated from per-request content?
- Are conflict handling and untrusted-data boundaries explicit?
- Does each enabled tool have a necessary, bounded purpose?
- Are confirmations and prohibited side effects enforced outside the prompt?
- Can success and failure be scored with repeatable cases?
- Are examples consistent with the rules and separate from evaluation cases?
- Can any instruction be removed without changing observed behavior?

## References

- [OpenAI prompt engineering](https://platform.openai.com/docs/guides/prompt-engineering): composing instructions and context for model behavior.
- [OpenAI safety in building agents](https://platform.openai.com/docs/guides/agents#safety): tool controls, prompt injection, and layered safeguards for agents.
- [Anthropic prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview): when and how to improve a prompt.
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): role, context, examples, and instruction structure.
- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): layered mitigations for prompt injection.
