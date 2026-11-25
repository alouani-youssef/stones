// Starts an interactive Claude Code session that generates the project's git
// hooks, the selected GitHub workflows, and issue and PR templates. The prompt
// is the `/github-setup` command, so the session and the slash command never
// drift apart.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE_ROOT } from './catalog.mjs';
import { onPath } from './detect.mjs';

// Workflows Claude can generate; the user picks zero or more during init.
export const WORKFLOW_CATALOG = [
  { value: 'ci', label: 'ci', hint: 'format, lint, typecheck, test and build on every push and pull request' },
  { value: 'release', label: 'release', hint: 'publish on a v* tag, after CI passes' },
  { value: 'security', label: 'security', hint: 'actionlint, zizmor and dependency review' },
  { value: 'dependabot', label: 'dependabot', hint: 'weekly grouped dependency and action updates' },
];

const known = (ids) => ids.filter((id) => WORKFLOW_CATALOG.some((w) => w.value === id));

/** Drops ids no longer in the catalog, so a stale saved selection is never passed on. */
export const knownWorkflows = (ids = []) => known(Array.isArray(ids) ? ids : []);

export function githubSetupPrompt(target, workflows = []) {
  const installed = join(target, '.claude', 'commands', 'github-setup.md');
  const source = existsSync(installed) ? installed : join(PACKAGE_ROOT, 'commands', 'github-setup.md');
  const body = readFileSync(source, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const selected = knownWorkflows(workflows);
  return body.replaceAll('$ARGUMENTS', selected.length ? selected.join(', ') : 'none selected');
}

export function startGithubSetupSession(target, { workflows = [], claude = 'claude' } = {}) {
  if (!onPath(claude)) {
    return Promise.resolve({
      started: false,
      message:
        'Claude Code is not on PATH. Install it (https://claude.com/claude-code), then run '
        + '`npx ai-stones github-setup`, or open Claude Code here and type /github-setup.',
    });
  }
  const prompt = githubSetupPrompt(target, workflows);
  return new Promise((done) => {
    const child = spawn(claude, [prompt], { cwd: target, stdio: 'inherit' });
    child.on('exit', (code) => done({ started: true, code }));
    child.on('error', (error) => done({ started: false, message: error.message }));
  });
}
