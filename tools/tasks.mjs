#!/usr/bin/env node
// Task board for Claude Code projects.
//
//   context/tasks/list/NNNN-slug.md   one file per task: goal, scenarios, scope
//   context/tasks/state/current.md    the task in progress (the testing hook reads it)
//   context/tasks/state/next.md       queued tasks, in order
//   context/tasks/state/blocked.md    waiting tasks, with the reason
//   context/tasks/state/done.md       finished tasks, with commits and test result
//
// A task moves between the state files; only `done` moves it to done.md, and
// only when its tests pass. `review` builds one file a reviewer reads to judge
// the task against what it promised.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { reviewTask } from './review.mjs';

export const TASKS_DIR = 'context/tasks';
export const LIST_DIR = `${TASKS_DIR}/list`;
export const STATE_DIR = `${TASKS_DIR}/state`;
export const REVIEWS_DIR = '.claude/reviews';
export const STATES = ['current', 'next', 'blocked', 'done'];

export const STATE_HEADERS = {
  current: '# Current\n\nThe task in progress. The testing hook reads the task linked here.\n',
  next: '# Next\n\nQueued tasks, in order. Start one with `node .claude/tools/tasks.mjs start <id>`.\n',
  blocked: '# Blocked\n\nTasks waiting on something, with the reason.\n',
  done: '# Done\n\nFinished tasks: their tests passed when they were closed.\n',
};

export const TASK_TEMPLATE = `# {{id}} {{title}}

Status: next
Branch:
Base:
Scope: {{scope}}

## Expected behavior

TODO: Describe the behavior the source should provide.

## Scenarios

- Scenario: TODO: describe an input or condition. Expected: TODO: describe the observable result.

## Contract change

none

## Notes
`;

const META = ['Status', 'Branch', 'Base', 'Scope'];

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

export function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd(), err: (r.stderr ?? '').trim() };
}

export function projectRoot(cwd = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top.ok ? top.out : resolve(cwd);
}

class TaskError extends Error {}
const fail = (message) => {
  throw new TaskError(message);
};

// ------------------------------------------------------------------ files

export function ensureBoard(root) {
  mkdirSync(join(root, LIST_DIR), { recursive: true });
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  for (const state of STATES) {
    const file = join(root, STATE_DIR, `${state}.md`);
    if (!existsSync(file)) writeFileSync(file, `${STATE_HEADERS[state]}\n`);
  }
}

const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';

export function listTasks(root) {
  const dir = join(root, LIST_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.md$/.test(f))
    .sort()
    .map((file) => readTask(root, file));
}

export function readTask(root, file) {
  const path = `${LIST_DIR}/${file}`;
  const text = readFileSync(join(root, path), 'utf8');
  const id = /^(\d+)/.exec(file)[1];
  const title = /^#\s+\d+\s+(.*)$/m.exec(text)?.[1]?.trim() ?? file;
  const meta = {};
  for (const key of META) meta[key.toLowerCase()] = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  return { id, file, path, title, text, ...meta };
}

export function findTask(root, ref) {
  const tasks = listTasks(root);
  const wanted = String(ref ?? '').replace(/^#/, '');
  const task = tasks.find((t) => t.id === wanted.padStart(t.id.length, '0') || t.file === wanted || t.file === `${wanted}.md`);
  return task ?? fail(`no task ${ref} in ${LIST_DIR}/`);
}

function setMeta(root, task, values) {
  let text = readFileSync(join(root, task.path), 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    const line = `${key}: ${value}`.trimEnd();
    text = re.test(text) ? text.replace(re, line) : text.replace(/^(#.*\n)/, `$1\n${line}\n`);
  }
  writeFileSync(join(root, task.path), text);
  return readTask(root, task.file);
}

const entryLine = (task, extra) => `- [${task.id} ${task.title}](../list/${task.file})${extra ? ` · ${extra}` : ''}`;
const isEntryFor = (line, task) => line.includes(`](../list/${task.file})`);

export function stateOf(root, task) {
  for (const state of STATES) {
    const text = readText(join(root, STATE_DIR, `${state}.md`)) ?? '';
    if (text.split('\n').some((l) => isEntryFor(l, task))) return state;
  }
  return null;
}

export function boardEntries(root, state) {
  const text = readText(join(root, STATE_DIR, `${state}.md`)) ?? '';
  return text.split('\n').filter((l) => /^- \[\d+ /.test(l));
}

// Removes the task from every state file, then adds it to `state`.
function moveTo(root, task, state, extra) {
  ensureBoard(root);
  for (const s of STATES) {
    const file = join(root, STATE_DIR, `${s}.md`);
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter((l) => !isEntryFor(l, task));
    if (s === state) {
      while (kept.length && kept.at(-1) === '') kept.pop();
      kept.push(entryLine(task, extra), '');
    }
    if (s === state || kept.length !== lines.length) writeFileSync(file, kept.join('\n'));
  }
}

// ---------------------------------------------------------------- commands

export function addTask(root, title, { scope = '' } = {}) {
  if (!title.trim()) fail('usage: tasks add <title> [--scope "src/a/**,tests/a/**"]');
  ensureBoard(root);
  const last = listTasks(root).reduce((max, t) => Math.max(max, Number(t.id)), 0);
  const id = String(last + 1).padStart(4, '0');
  const file = `${id}-${slugify(title)}.md`;
  const text = TASK_TEMPLATE.replace('{{id}}', id).replace('{{title}}', title.trim()).replace('{{scope}}', scope).replace(/^Scope: $/m, 'Scope:');
  writeFileSync(join(root, LIST_DIR, file), text);
  const task = readTask(root, file);
  moveTo(root, task, 'next');
  return task;
}

export function currentTaskOf(root) {
  const line = boardEntries(root, 'current')[0];
  const file = line && /\]\(\.\.\/list\/([^)]+)\)/.exec(line)?.[1];
  return file && existsSync(join(root, LIST_DIR, file)) ? readTask(root, file) : null;
}

export function startTask(root, ref) {
  const task = findTask(root, ref);
  const current = currentTaskOf(root);
  if (current && current.id !== task.id) {
    fail(`${current.id} is in progress: finish it (done) or block it before starting ${task.id}`);
  }
  if (task.status === 'done') fail(`${task.id} is already done`);
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']).out;
  // Resuming a blocked task keeps its original base, so the review covers all of it.
  const updated = setMeta(root, task, {
    Status: 'current',
    Branch: branch || task.branch,
    Base: task.base || (head.ok ? head.out : ''),
  });
  moveTo(root, updated, 'current', branch ? `branch ${branch}` : '');
  return updated;
}

export function blockTask(root, ref, reason) {
  if (!reason.trim()) fail('usage: tasks block <id> <reason>');
  const task = setMeta(root, findTask(root, ref), { Status: 'blocked' });
  moveTo(root, task, 'blocked', reason.trim());
  return task;
}

// The project's test command: what `init` recorded, else the package.json script.
export function defaultTestCommand(root) {
  const manifest = readText(join(root, '.claude/stones.json'));
  try {
    const cmd = JSON.parse(manifest).answers?.workflow?.commands?.test;
    if (cmd) return cmd;
  } catch {
    // no manifest
  }
  try {
    if (JSON.parse(readText(join(root, 'package.json'))).scripts?.test) return 'npm test';
  } catch {
    // no package.json
  }
  return null;
}

export function runTests(root, task, command) {
  const cmd = command || defaultTestCommand(root) || fail('no test command: pass one after --, e.g. tasks done 7 -- npm test');
  mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
  const log = `${REVIEWS_DIR}/${task.id}-tests.log`;
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(root, log), output);
  const last = output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '(no output)';
  return { ok: r.status === 0, status: r.status, command: cmd, log, last, tail: output.split('\n').slice(-6).join('\n') };
}

const short = (root, sha) => (sha ? git(root, ['rev-parse', '--short=7', sha]).out : '');

export function finishTask(root, ref, command) {
  const task = findTask(root, ref);
  const tests = runTests(root, task, command);
  if (!tests.ok) return { task, tests, finished: false };
  const head = git(root, ['rev-parse', 'HEAD']);
  const range = task.base && head.ok ? `commits ${short(root, task.base)}..${short(root, head.out)}` : 'no commits recorded';
  const updated = setMeta(root, task, { Status: 'done' });
  moveTo(root, updated, 'done', `${range} · tests: ${tests.command} → ${tests.last}`);
  return { task: updated, tests, finished: true };
}

export function boardText(root) {
  const out = [];
  for (const state of ['current', 'next', 'blocked', 'done']) {
    const entries = boardEntries(root, state);
    out.push(`${state} (${entries.length})`);
    for (const e of state === 'done' ? entries.slice(-5) : entries) out.push(`  ${e.replace(/^- /, '').replace(/\]\([^)]*\)/, ']')}`);
  }
  return out.join('\n');
}

// --------------------------------------------------------------------- cli

const USAGE = `usage: tasks <command>
  add <title> [--scope "glob,glob"]   create a task in list/ and queue it in next.md
  list                                show the board
  show [id]                           print a task (default: the current one)
  start <id>                          make it current (records branch and base commit)
  block <id> <reason>                 move it to blocked.md
  done <id> [-- test command]         run the tests; on success move it to done.md
  review [id] [--run-tests]           write the review package to ${REVIEWS_DIR}/<id>.md; exit 1 if not ready`;

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value ?? '';
}

export async function main(argv, { root = projectRoot(), log = console.log } = {}) {
  const sep = argv.indexOf('--');
  const args = sep < 0 ? [...argv] : argv.slice(0, sep);
  const after = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
  const [command, ...rest] = args;
  const refOrCurrent = (ref) => ref ?? currentTaskOf(root)?.id ?? fail('no task is in progress; pass an id');

  switch (command) {
    case 'add': {
      const scope = option(rest, '--scope') ?? '';
      const task = addTask(root, rest.join(' '), { scope });
      log(`added ${task.path} (queued in ${STATE_DIR}/next.md); fill in its expected behavior and scenarios`);
      return 0;
    }
    case 'list':
    case 'board':
      ensureBoard(root);
      log(boardText(root));
      return 0;
    case 'show':
      log(findTask(root, refOrCurrent(rest[0])).text);
      return 0;
    case 'start': {
      const task = startTask(root, rest[0] ?? fail('usage: tasks start <id>'));
      log(`started ${task.id} ${task.title}\nbase: ${task.base}\nbranch: ${task.branch}\nfile: ${task.path}`);
      return 0;
    }
    case 'block': {
      const task = blockTask(root, rest[0] ?? fail('usage: tasks block <id> <reason>'), rest.slice(1).join(' '));
      log(`blocked ${task.id}`);
      return 0;
    }
    case 'done': {
      const { task, tests, finished } = finishTask(root, refOrCurrent(rest[0]), after);
      log(tests.tail);
      if (!finished) {
        log(`tests failed (exit ${tests.status}); ${task.id} NOT done. Full output: ${tests.log}`);
        return tests.status || 1;
      }
      log(`done ${task.id} ${task.title}`);
      return 0;
    }
    case 'review': {
      const runTestsFlag = rest.includes('--run-tests');
      const ref = refOrCurrent(rest.find((a) => !a.startsWith('--')));
      const task = findTask(root, ref);
      const tests = runTestsFlag ? runTests(root, task, after) : null;
      const result = await reviewTask(root, task, { tests, doneLine: boardEntries(root, 'done').find((l) => isEntryFor(l, task)) });
      mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
      const out = `${REVIEWS_DIR}/${task.id}.md`;
      writeFileSync(join(root, out), result.markdown);
      log(`${result.ready ? 'READY' : 'NOT READY'}: ${task.id} ${task.title}`);
      for (const f of result.findings) log(`- ${f}`);
      log(`review package: ${out}`);
      return result.ready ? 0 : 1;
    }
    default:
      log(USAGE);
      return command && command !== 'help' ? 2 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    console.error(`tasks: ${error.message}`);
    process.exitCode = 2;
  }
}
