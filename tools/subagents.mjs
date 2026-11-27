// Which project subagent (.claude/agents/<name>.md) runs each step of a task.
// The task tool names an agent only when it is installed, so a deselected
// agent drops out of the workflow and its step stays with the main session.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS_DIR = '.claude/agents';

// step -> [agent, what to hand it]. `{{review}}` is the task's review package.
export const DISPATCH = {
  build: [
    ['developer', 'implement each plan step in its own context; give it the step, the task Scope and the scenarios the step serves, and check its report against the plan'],
    ['tester', 'write the tests for the task\'s scenarios and test cases, failing first, before the developer makes them pass'],
    ['devops', 'any change to CI workflows, containers, the dev container or release config'],
  ],
  review: [
    ['critic', 'review {{review}} against the task note; fix every blocker and major finding before `done`'],
    ['functional', 'check each scenario in the task note against the real behavior and report it met, not met or not verified'],
    ['hacker', 'security review of the diff in {{review}} when it touches auth, input handling, file access, secrets, dependencies or network calls'],
  ],
  done: [
    ['summarizer', 'condense {{review}} and the task\'s commits into the summary section of .claude/pr.md before opening the PR'],
  ],
};

const STEP_LEAD = {
  build: 'Delegate the build to these project subagents',
  review: 'Delegate the review to these project subagents',
  done: 'Delegate the PR summary to this project subagent',
};

// Agent names installed in the project, from `.claude/agents/*.md`.
export function installedAgents(root) {
  try {
    return readdirSync(join(root, AGENTS_DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

// The lines that tell Claude which installed agent runs `step`, or '' when none is installed.
export function dispatchText(agents, step, { review = 'the review package' } = {}) {
  const installed = new Set(agents);
  const lines = (DISPATCH[step] ?? [])
    .filter(([name]) => installed.has(name))
    .map(([name, what]) => `- \`${name}\`: ${what.replaceAll('{{review}}', review)} (\`subagent_type: "${name}"\`).`);
  if (!lines.length) return '';
  return [`${STEP_LEAD[step]} with the Agent tool:`, ...lines].join('\n');
}
