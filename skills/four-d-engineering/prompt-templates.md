# Prompt templates

Starting points for briefing an agent or subagent. Adapt them to the repository, task and risk level. Fill or delete every bracketed placeholder.

## Repository investigation prompt

```text
Role:
Act as a senior software engineer familiar with the
technology stack used in this repository.

Objective:
Investigate the following engineering problem:

[PROBLEM DESCRIPTION]

Context:
- Stack: [LANGUAGES, FRAMEWORKS, DATABASES]
- Relevant modules: [MODULES]
- Relevant files: [FILES]
- Current behavior: [CURRENT BEHAVIOR]
- Expected behavior: [EXPECTED BEHAVIOR]
- Evidence: [LOGS, ERRORS, TEST RESULTS]

Instructions:
1. Inspect the relevant implementation before proposing changes.
2. Trace the execution path and dependencies.
3. Distinguish observed facts from hypotheses.
4. Identify the most likely root cause.
5. Consider alternative explanations.
6. Identify missing information.

Constraints:
- Do not modify files.
- Do not assume undocumented behavior.
- Do not recommend a fix without explaining its impact.

Output:
1. Problem summary.
2. Relevant components and execution path.
3. Evidence.
4. Root-cause hypotheses.
5. Recommended investigation steps.
6. Risks and unresolved questions.
```

## Code-generation prompt

```text
Role:
Act as a senior [LANGUAGE/FRAMEWORK] engineer.

Objective:
Implement [FEATURE OR CHANGE].

Repository context:
[ARCHITECTURE, MODULES, RELEVANT FILES]

Current behavior:
[CURRENT BEHAVIOR]

Expected behavior:
[EXPECTED BEHAVIOR]

Requirements:
- [REQUIREMENT 1]
- [REQUIREMENT 2]
- [REQUIREMENT 3]

Constraints:
- Follow existing repository conventions.
- Preserve established public contracts.
- Do not modify unrelated components.
- Avoid unnecessary dependencies.
- Apply appropriate validation and error handling.
- Preserve security and data-integrity invariants.

Acceptance criteria:
- [CRITERION 1]
- [CRITERION 2]
- [CRITERION 3]

Testing:
- Add unit tests for relevant behavior.
- Add integration tests for component interactions.
- Include boundary and failure cases.
- Run relevant regression tests.

Completion report:
- Summarize changed files.
- Explain important design decisions.
- List tests and commands executed.
- Report actual results.
- Identify limitations and unresolved risks.

Do not claim a test passed unless it was actually executed.
```

## Debugging prompt

```text
Objective:
Find and explain the root cause of the following issue:

[ERROR / SYMPTOM]

Environment:
[VERSIONS, CONFIGURATION, DEPLOYMENT CONTEXT]

Evidence:
[LOGS, STACK TRACE, RELEVANT CODE, TEST RESULTS]

Instructions:
1. Trace the failure through the relevant execution path.
2. Identify observed facts and distinguish them from assumptions.
3. Form and rank plausible root-cause hypotheses.
4. Suggest experiments that can confirm or reject each hypothesis.
5. Identify the smallest safe correction.
6. Explain side effects and regression risks.
7. Define tests that demonstrate the fix.

Constraints:
- Do not assume the error message identifies the root cause.
- Do not suggest destructive commands without explaining their effects.
- Do not modify files until the investigation is complete.

Output:
Root cause, evidence, proposed correction, risks,
verification steps, and unresolved uncertainty.
```

## Test-generation prompt

```text
Objective:
Design tests for [COMPONENT / FEATURE].

Behavioral specification:
[REQUIREMENTS AND EXPECTED BEHAVIOR]

Existing implementation:
[RELEVANT CODE OR FILE REFERENCES]

Test environment:
[FRAMEWORK, DATABASE, MOCKING STRATEGY]

Instructions:
1. Derive test cases from requirements, not only from the implementation.
2. Cover happy paths, boundaries, and failure scenarios.
3. Identify security and authorization cases.
4. Include concurrency and data-integrity cases where relevant.
5. Prefer meaningful assertions over implementation-specific assertions.
6. Avoid unnecessary mocking.
7. Identify behaviors that cannot be tested with the available setup.

Output:
- Test case matrix.
- Unit tests.
- Integration tests where appropriate.
- Required fixtures and setup.
- Expected assertions.
- Coverage gaps and limitations.
```

## Code-review prompt

```text
Objective:
Review the proposed code change as an independent reviewer.

Context:
[REQUIREMENTS, ARCHITECTURE, RELEVANT INVARIANTS]

Change:
[DIFF OR FILE REFERENCES]

Review for:
- Functional defects.
- Requirement violations.
- Security vulnerabilities.
- Data-integrity risks.
- Concurrency defects.
- API and contract incompatibilities.
- Performance problems.
- Error-handling gaps.
- Maintainability issues.
- Missing or ineffective tests.

Instructions:
- Prioritize concrete defects over style preferences.
- Reference the affected file and relevant code.
- Explain the impact of each finding.
- Distinguish confirmed defects from possible risks.
- Do not invent issues.
- Do not assume tests passed unless execution evidence exists.

Output each finding with:
Severity, location, evidence, impact, and recommended fix.

Finish with:
- Blocking findings.
- Non-blocking findings.
- Missing tests.
- Overall review recommendation.
```
