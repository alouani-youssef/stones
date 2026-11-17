// Blocks merges and publishes until the project's GitHub Actions workflows
// have passed locally with act for the current code (HEAD plus uncommitted
// changes), as recorded by .claude/tools/workflows.mjs run.
//
// Gated commands: gh pr merge; git merge on the default branch; package
// publishes (npm/pnpm/yarn/bun publish, cargo publish, poetry/uv publish,
// twine upload, gem push); gh release create; git push of tags.
// Projects without .github/workflows are never gated.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hasWorkflows, projectRoot, runStatus } from '../tools/workflows.mjs';
import { parseShell } from './lib/shell.mjs';

const allow = (note) => ({ block: false, note });

// Drop leading VAR=value assignments and wrappers so `FOO=1 npm publish` still matches.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'npx', 'pnpx', 'bunx']);
function strip(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return words.slice(i);
}

const gitArgs = (words) => {
  // git -C dir / -c k=v options come before the subcommand
  const rest = words.slice(1);
  while (rest.length && rest[0].startsWith('-')) rest.splice(0, ['-C', '-c'].includes(rest[0]) ? 2 : 1);
  return rest;
};

/** What a simple command does that needs the gate, or null. */
export function gatedAction(words, { branch, defaultBranch = 'main' } = {}) {
  const w = strip(words);
  const [cmd, a, b] = w;
  if (!cmd) return null;
  if (cmd === 'gh' && a === 'pr' && b === 'merge') return 'merge a pull request';
  if (cmd === 'gh' && a === 'release' && b === 'create') return 'create a release';
  if (['npm', 'pnpm', 'bun'].includes(cmd) && a === 'publish') return 'publish a package';
  if (cmd === 'yarn' && (a === 'publish' || (a === 'npm' && b === 'publish'))) return 'publish a package';
  if (cmd === 'cargo' && a === 'publish') return 'publish a crate';
  if (['poetry', 'uv'].includes(cmd) && a === 'publish') return 'publish a package';
  if (cmd === 'twine' && a === 'upload') return 'publish a package';
  if (cmd === 'gem' && a === 'push') return 'publish a gem';
  if (cmd === 'git') {
    const [sub, ...rest] = gitArgs(w);
    if (sub === 'merge' && !rest.some((r) => ['--abort', '--continue', '--quit'].includes(r)) && branch && [defaultBranch, 'main', 'master'].includes(branch)) {
      return `merge into ${branch}`;
    }
    if (sub === 'push' && rest.some((r) => r === '--tags' || r === '--follow-tags' || /^(refs\/tags\/|v\d)/.test(r))) return 'push a release tag';
  }
  return null;
}

export function evaluate(event, { projectDir, branch } = {}) {
  try {
    if (event?.tool_name !== 'Bash') return allow();
    const command = event?.tool_input?.command;
    if (typeof command !== 'string' || !command.trim()) return allow();
    const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const cwd = typeof event.cwd === 'string' && event.cwd ? resolve(project, event.cwd) : project;
    const root = projectRoot(cwd);
    if (!hasWorkflows(root)) return allow();
    const head = branch ?? currentBranchOf(root);
    const actions = parseShell(command).commands.map((words) => gatedAction(words, { branch: head })).filter(Boolean);
    if (!actions.length) return allow();
    const status = runStatus(root);
    if (status.ok) return allow(`workflows: local run ${status.reason}`);
    return {
      block: true,
      reason: [
        `Blocked: about to ${actions[0]}, but the GitHub Actions workflows have not passed locally for this code (${status.reason}).`,
        '1. Run `node .claude/tools/workflows.mjs list` and show the user the workflows and jobs.',
        '2. Ask the user to confirm, then run `node .claude/tools/workflows.mjs run --yes` (act, in Docker).',
        '3. Retry once it passes. If a job cannot run under act, tell the user rather than working around this check.',
      ].join('\n'),
    };
  } catch (error) {
    return allow(`workflows: internal error, skipped: ${error?.message ?? error}`);
  }
}

function currentBranchOf(root) {
  const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
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
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const result = evaluate(event ?? {});
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
  if (result.note) console.log(result.note);
}
