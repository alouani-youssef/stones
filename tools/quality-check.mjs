#!/usr/bin/env node
// Runs the project's quality gates — lint, typecheck, test, build — with the
// commands recorded by `claude-stones init` in .claude/stones.json, and says
// plainly which passed. The last result is saved to .claude/quality/last.json
// (with the commit it ran on) so create-pr can quote it as verification.
//
//   node .claude/tools/quality-check.mjs [--only lint,test] [--skip build] [--fail-fast] [--json]
//   node .claude/tools/quality-check.mjs --cmd test="pytest -q"     override or add a step
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { git, projectRoot } from './git-comments.mjs';

export const STEPS = ['format', 'lint', 'typecheck', 'test', 'build'];
export const QUALITY_DIR = '.claude/quality';
// Formatters rewrite files, so the format step only runs when asked for.
const OPT_IN = new Set(['format']);
const TAIL_LINES = 25;

const USAGE = `quality-check: run the project's lint, typecheck, test and build commands

Usage
  node .claude/tools/quality-check.mjs [options]

Options
  --only <a,b>          Run only these steps (format, lint, typecheck, test, build)
  --skip <a,b>          Skip these steps
  --cmd <step>=<cmd>    Override or add a step's command
  --fail-fast           Stop at the first failing step
  --json                Print the result as JSON
  -h, --help            Show this help

Commands come from .claude/stones.json (written by \`npx claude-stones init\`).
The format step rewrites files, so it runs only with --only format.`;

class QualityError extends Error {}
const fail = (message) => {
  throw new QualityError(message);
};

export function configuredCommands(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, '.claude', 'stones.json'), 'utf8'));
    return { ...(manifest.answers?.workflow?.commands ?? {}) };
  } catch {
    return {};
  }
}

export function planSteps(commands, { only = [], skip = [] } = {}) {
  const names = [...STEPS, ...Object.keys(commands).filter((k) => !STEPS.includes(k))];
  return names
    .filter((name) => commands[name])
    .filter((name) => (only.length ? only.includes(name) : !OPT_IN.has(name)))
    .filter((name) => !skip.includes(name))
    .map((name) => ({ name, command: commands[name] }));
}

function runStep(root, step) {
  const started = Date.now();
  const r = spawnSync(step.command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' } });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const log = `${QUALITY_DIR}/${step.name}.log`;
  writeFileSync(join(root, log), `$ ${step.command}\n\n${output}`);
  return {
    ...step,
    passed: r.status === 0,
    status: r.status ?? (r.signal ? `signal ${r.signal}` : 'error'),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    log,
    tail: output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
  };
}

export function qualityCheck(root, { only = [], skip = [], overrides = {}, failFast = false } = {}) {
  const steps = planSteps({ ...configuredCommands(root), ...overrides }, { only, skip });
  if (!steps.length) fail('no commands to run; run `npx claude-stones init` or pass --cmd test="..."');
  mkdirSync(join(root, QUALITY_DIR), { recursive: true });
  const results = [];
  for (const step of steps) {
    const result = runStep(root, step);
    results.push(result);
    if (!result.passed && failFast) break;
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const summary = {
    passed: results.every((r) => r.passed) && results.length === steps.length,
    commit: head.ok ? head.out : null,
    dirty: dirty.ok ? Boolean(dirty.out) : null,
    ranAt: new Date().toISOString(),
    steps: results.map(({ tail, ...r }) => r),
    skipped: steps.slice(results.length).map((s) => s.name),
  };
  writeFileSync(join(root, QUALITY_DIR, 'last.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, results };
}

export function formatResult(result) {
  const lines = result.results.map((r) => `${r.passed ? 'PASS' : 'FAIL'}  ${r.name.padEnd(9)} ${String(r.seconds).padStart(6)}s  ${r.command}`);
  for (const name of result.skipped) lines.push(`SKIP  ${name}`);
  for (const r of result.results.filter((x) => !x.passed)) {
    lines.push('', `--- ${r.name} failed (exit ${r.status}); last lines, full log in ${r.log}`, r.tail || '(no output)');
  }
  lines.push('', result.passed ? 'All checks passed.' : 'Checks failed.');
  return lines.join('\n');
}

const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const opts = { only: [], skip: [], overrides: {}, failFast: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') opts.only = list(argv[++i]);
    else if (a === '--skip') opts.skip = list(argv[++i]);
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--cmd') {
      const m = /^([\w-]+)=(.+)$/s.exec(argv[++i] ?? '');
      if (!m) fail('--cmd needs <step>=<command>');
      opts.overrides[m[1]] = m[2];
    } else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else fail(`unknown argument ${a}`);
  }
  const result = qualityCheck(projectRoot(cwd), opts);
  log(opts.json ? JSON.stringify({ ...result, results: undefined }, null, 2) : formatResult(result));
  return result.passed ? 0 : 1;
}

export function run(argv, options) {
  try {
    return main(argv, options);
  } catch (error) {
    if (!(error instanceof QualityError)) throw error;
    (options?.error ?? console.error)(`quality-check: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = run(process.argv.slice(2));
