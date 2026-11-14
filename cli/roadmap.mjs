// Starts an interactive Claude Code session that interviews the user and
// writes ROADMAP.md. The prompt is the `/roadmap` command, so the session
// and the slash command never drift apart.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE_ROOT } from './catalog.mjs';
import { onPath } from './detect.mjs';

export function roadmapPrompt(target, focus = '') {
  const installed = join(target, '.claude', 'commands', 'roadmap.md');
  const source = existsSync(installed) ? installed : join(PACKAGE_ROOT, 'commands', 'roadmap.md');
  const body = readFileSync(source, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const fallback = existsSync(join(target, 'ROADMAP.md'))
    ? 'review progress and revise the roadmap'
    : 'create the first roadmap';
  return body.replaceAll('$ARGUMENTS', focus.trim() || fallback);
}

export function startRoadmapSession(target, { focus = '', claude = 'claude' } = {}) {
  const prompt = roadmapPrompt(target, focus);
  if (!onPath(claude)) {
    return Promise.resolve({
      started: false,
      message:
        'Claude Code is not on PATH. Install it (https://claude.com/claude-code), then run '
        + '`npx ai-stones roadmap`, or open Claude Code here and type /roadmap.',
    });
  }
  return new Promise((done) => {
    const child = spawn(claude, [prompt], { cwd: target, stdio: 'inherit' });
    child.on('exit', (code) => done({ started: true, code }));
    child.on('error', (error) => done({ started: false, message: error.message }));
  });
}
