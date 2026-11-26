// PreToolUse hook: blocks writing a plan under docs/design/plans/ until every assumption in its spec has been confirmed or denied by the user.
//
// The spec lists, under `## Assumptions`, each decision the agent made that
// the user did not state ("- A1: <assumption>. Status: open"). Planning on an
// unconfirmed assumption bakes a guess into every later step, so the plan
// waits until the user has answered each one (see the confirming-specs skill).
//
// The spec is the one the plan links (a docs/design/*.md path in
// the plan), else the current task's Spec: line, else the newest spec.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assumptionProblems } from '../tools/spec-quiz.mjs';

export const PLANS = 'docs/design/plans/';
export const SPECS = 'docs/design/';
const TASKS = 'docs/tasks/list';
const SPEC_LINK = /docs\/design\/[\w.-]+?\.md/;

const allow = () => ({ block: false });
const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

function projectPath(project, file) {
  const abs = isAbsolute(file) ? file : resolve(project, file);
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = relative(real(project), existsSync(abs) ? real(abs) : join(real(resolve(abs, '..')), abs.split(sep).pop()));
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

function currentTaskSpec(project) {
  const dir = join(project, TASKS);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = read(join(dir, name));
    if (/^Status:\s*current\s*$/m.test(text)) return SPEC_LINK.exec(/^Spec:[ \t]*(.*)$/m.exec(text)?.[1] ?? '')?.[0] ?? null;
  }
  return null;
}

function newestSpec(project) {
  const dir = join(project, SPECS);
  if (!existsSync(dir)) return null;
  const specs = readdirSync(dir).filter((n) => n.endsWith('.md'))
    .map((n) => ({ path: `${SPECS}${n}`, time: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return specs[0]?.path ?? null;
}

export function specFor(project, planText) {
  return SPEC_LINK.exec(planText)?.[0] ?? currentTaskSpec(project) ?? newestSpec(project);
}

export function evaluate(event, { projectDir } = {}) {
  const { tool_name, tool_input = {} } = event ?? {};
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool_name) || typeof tool_input.file_path !== 'string') return allow();
  const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const rel = projectPath(project, tool_input.file_path);
  if (!rel?.startsWith(PLANS) || !rel.endsWith('.md')) return allow();

  const planText = [tool_input.content, tool_input.new_string, ...(tool_input.edits ?? []).map((e) => e.new_string), read(join(project, rel))]
    .filter(Boolean).join('\n');
  const spec = specFor(project, planText);
  if (!spec || !existsSync(join(project, spec))) {
    return {
      block: true,
      reason: `[assumptions] Write the spec under ${SPECS} before the plan, with a ## Assumptions section listing every decision you made that the user did not state, and have the user confirm or deny each one (confirming-specs skill).`,
    };
  }
  const problems = assumptionProblems(read(join(project, spec)));
  if (!problems.length) return allow();
  return {
    block: true,
    reason: [
      `[assumptions] Not ready to plan: ${spec} has assumptions the user has not confirmed or denied.`,
      ...problems.map((p) => `  - ${p}`),
      'Ask the user about each open assumption (AskUserQuestion, up to 4 at a time: Confirm / Deny, and Other to say what instead).',
      'Record "Status: confirmed" or "Status: denied: <their decision>", update the spec for every denial, then write the plan.',
    ].join('\n'),
  };
}

const entryPath = () => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ?? '';
  }
};

if (import.meta.url === pathToFileURL(entryPath()).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = evaluate(JSON.parse(input));
    if (result.block) {
      console.error(result.reason);
      process.exit(2);
    }
  } catch {
    // A malformed hook event must not interrupt the user's work.
  }
}
