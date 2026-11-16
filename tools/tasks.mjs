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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

## Test Strategy

TODO: Describe the test levels and checks that give confidence for this task.

## Test Cases

- Case: TODO: describe an input or condition. Expected: TODO: describe the observable result.

## Spec and plan

Spec: TODO: the spec written with superpowers:brainstorming (docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md)
Plan: TODO: the plan written with superpowers:writing-plans (docs/superpowers/plans/YYYY-MM-DD-<feature>.md)

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

function markdownSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

const PLACEHOLDER = /\b(?:TODO|TBD|replace me)\b|\[(?:describe|write|add|replace|reason|expected|condition)\b[^\]]*\]/i;

function hasExpectedCase(section) {
  return section.split(/\r?\n/).some((line) => {
    const match = /^\s*[-*]\s+(?:Case|Test case):\s*(.+?)\s+Expected:\s*(.+)$/i.exec(line);
    return match && match[1].trim().length >= 8 && match[2].trim().length >= 8 && !PLACEHOLDER.test(line);
  });
}

function validateTestSections(text, label, task) {
  const strategy = markdownSection(text, 'Test Strategy');
  if (!strategy || strategy.trim().length < 20 || PLACEHOLDER.test(strategy)) {
    fail(`${task.id} is not ready to start: add a meaningful ## Test Strategy section to the ${label}; describe which checks and test levels cover the task's risks.`);
  }
  const cases = markdownSection(text, 'Test Cases');
  if (!hasExpectedCase(cases)) {
    fail(`${task.id} is not ready to start: add at least one concrete Case with an Expected outcome under ## Test Cases in the ${label}.`);
  }
}

function linkedDocument(root, task, label, folder, skill) {
  const links = markdownSection(task.text, 'Spec and plan');
  const path = new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(links)?.[1].trim() ?? '';
  if (!path || PLACEHOLDER.test(path)) {
    fail(`${task.id} is not ready to start: create the ${label.toLowerCase()} with ${skill} and link it under ## Spec and plan in ${task.path}.`);
  }
  const rootPath = realpathSync(root);
  const target = resolve(rootPath, path);
  const relativePath = relative(rootPath, target);
  if (isAbsolute(path) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    fail(`${task.id} is not ready to start: the ${label.toLowerCase()} path must stay inside the project.`);
  }
  if (!path.startsWith(folder) || !path.endsWith('.md')) {
    fail(`${task.id} is not ready to start: link the ${label.toLowerCase()} under ${folder} as a Markdown file.`);
  }
  if (!existsSync(target)) {
    fail(`${task.id} is not ready to start: ${path} does not exist; create the ${label.toLowerCase()} with ${skill}.`);
  }
  const realTarget = realpathSync(target);
  const realRelative = relative(rootPath, realTarget);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
    fail(`${task.id} is not ready to start: the ${label.toLowerCase()} must resolve inside the project.`);
  }
  if (!statSync(realTarget).isFile()) {
    fail(`${task.id} is not ready to start: ${path} must link to a Markdown file.`);
  }
  const content = readFileSync(realTarget, 'utf8');
  validateTestSections(content, label === 'Spec' ? 'spec' : 'plan', task);
}

export function validateTaskReadiness(root, task) {
  const behavior = markdownSection(task.text, 'Expected behavior');
  if (!behavior || PLACEHOLDER.test(behavior)) {
    fail(`${task.id} is not ready to start: complete ## Expected behavior in ${task.path}.`);
  }
  const scenarios = markdownSection(task.text, 'Scenarios');
  if (!scenarios.split(/\r?\n/).some((line) =>
    /^\s*[-*]\s+.+?\bExpected:\s*\S.+$/i.test(line) && !PLACEHOLDER.test(line))) {
    fail(`${task.id} is not ready to start: add a Scenario with an Expected outcome in ${task.path}.`);
  }
  const contract = markdownSection(task.text, 'Contract change');
  const unchanged = /^(?:none|no|unchanged|no contract change)\.?$/i.test(contract);
  const changed = /^behavior changed:\s*\S.{7,}$/i.test(contract) && !PLACEHOLDER.test(contract);
  if (!unchanged && !changed) {
    fail(`${task.id} is not ready to start: set ## Contract change to "none" or "behavior changed: <reason>" in ${task.path}.`);
  }
  validateTestSections(task.text, 'task note', task);
  linkedDocument(root, task, 'Spec', 'docs/superpowers/specs/', 'superpowers:brainstorming');
  linkedDocument(root, task, 'Plan', 'docs/superpowers/plans/', 'superpowers:writing-plans');
}

export function startTask(root, ref) {
  const task = findTask(root, ref);
  const current = currentTaskOf(root);
  if (current && current.id !== task.id) {
    fail(`${current.id} is in progress: finish it (done) or block it before starting ${task.id}`);
  }
  if (task.status === 'done') fail(`${task.id} is already done`);
  validateTaskReadiness(root, task);
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

// After readiness validation, Superpowers guides implementation and verification.
export const SUPERPOWERS_WORKFLOW = [
  'The board has already checked that the task note, spec, and plan are complete before this task was started. Read the linked spec and plan first; keep their behavior, scenarios, test strategy, and test cases aligned with the task note.',
  'Build: carry out the plan with superpowers:subagent-driven-development (or superpowers:executing-plans when working inline), test first with superpowers:test-driven-development.',
  'Finish: use superpowers:verification-before-completion before claiming it works.',
].join('\n');

// The opening prompt of a task's session: the task note plus how to work it.
export function taskPrompt(task, { blockedReason = '' } = {}) {
  const todo = /TODO:/.test(task.text);
  const where = [task.branch && `branch ${task.branch}`, task.base && `base ${task.base.slice(0, 7)}`].filter(Boolean).join(', ');
  return [
    `Work on task ${task.id} "${task.title}". It is now the current task on the board${where ? ` (${where})` : ''}.`,
    blockedReason ? `It was blocked before: ${blockedReason}. Check that this is resolved before continuing.` : '',
    `The task note, ${task.path}:`,
    '<task>',
    task.text.trim(),
    '</task>',
    todo
      ? 'The note still has TODOs: fill them in before writing code, asking me when the expected behavior is unclear. Task start and the testing hook both enforce the required task details.'
      : '',
    SUPERPOWERS_WORKFLOW,
    `Only change files inside its Scope. Commit the work, then finish with \`node .claude/tools/tasks.mjs done ${task.id}\``
      + ` and check it with \`node .claude/tools/tasks.mjs review ${task.id} --run-tests\`.`
      + ` If it cannot be finished, \`node .claude/tools/tasks.mjs block ${task.id} "<reason>"\`.`,
    'Start by summarizing the task, then follow the steps above in order.',
  ].filter(Boolean).join('\n\n');
}

// Inside Claude Code, or without a terminal, an interactive session cannot run.
export const canOpenSession = (env = process.env) => !env.CLAUDECODE && Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Opens an interactive Claude Code session in `root` with the task's prompt.
export function startSession(root, task, { claude = process.env.STONES_CLAUDE || 'claude', blockedReason = '', run = spawn } = {}) {
  const prompt = taskPrompt(task, { blockedReason });
  return new Promise((done) => {
    const child = run(claude, [prompt], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => done({ started: true, code: code ?? 1 }));
    child.on('error', (error) =>
      done({
        started: false,
        message: error.code === 'ENOENT'
          ? `${claude} is not on PATH; install Claude Code (https://claude.com/claude-code) or open it here and run \`tasks show\``
          : error.message,
      }));
  });
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
  // A hung test run must not hang the tool: STONES_COMMAND_TIMEOUT seconds, 30 minutes by default.
  const timeout = (Number(process.env.STONES_COMMAND_TIMEOUT) || 1800) * 1000;
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${timedOut ? `\ntimed out after ${timeout / 1000}s (STONES_COMMAND_TIMEOUT)\n` : ''}`;
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

// The tasks in one state file, in board order, with the text after `·` on their line.
export function tasksIn(root, state) {
  return boardEntries(root, state).flatMap((line) => {
    const file = /\]\(\.\.\/list\/([^)]+)\)/.exec(line)?.[1];
    if (!file || !existsSync(join(root, LIST_DIR, file))) return [];
    return [{ ...readTask(root, file), extra: line.split(' · ').slice(1).join(' · ') }];
  });
}

const DRAFT = /TODO:/;

// One state as text: each task's id, title, scope, what its board line says,
// and whether its note still has TODOs.
export function stateText(root, state) {
  const tasks = tasksIn(root, state);
  if (!tasks.length) return `${state}: none`;
  const rows = tasks.map((t, i) => {
    const order = state === 'next' ? `${i + 1}. ` : '';
    const details = [t.scope && `scope ${t.scope}`, t.extra, state !== 'done' && DRAFT.test(t.text) && 'note has TODOs'].filter(Boolean);
    return `  ${order}${t.id} ${t.title}${details.length ? `\n     ${details.join(' · ')}` : ''}`;
  });
  return [`${state} (${tasks.length})`, ...rows].join('\n');
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
  list [current|next|blocked|done]    show the board, or one state of it
  current                             print the task in progress (its note and board line)
  next                                the queued tasks, in order
  blocked                             the blocked tasks, with their reasons
  show [id]                           print a task (default: the current one)
  start <id> [--no-session]           validate the note, spec and plan, then make it current
                                      and open its Claude Code session
  block <id> <reason>                 move it to blocked.md
  done <id> [-- test command]         run the tests; on success move it to done.md
  review [id] [--run-tests]           write the review package to ${REVIEWS_DIR}/<id>.md; exit 1 if not ready`;

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value ?? '';
}

async function handleStart(root, rest, { log, session, claude, run }) {
  const noSession = rest.includes('--no-session');
  const forceSession = rest.includes('--session');
  const ref = rest.find((a) => !a.startsWith('--')) ?? fail('usage: tasks start <id> [--no-session]');
  const blocked = boardEntries(root, 'blocked').find((l) => isEntryFor(l, findTask(root, ref)));
  const task = startTask(root, ref);
  log(`started ${task.id} ${task.title}\nbase: ${task.base}\nbranch: ${task.branch}\nfile: ${task.path}`);
  if (noSession || !(session || forceSession)) return 0;
  const blockedReason = blocked?.split(' · ').slice(1).join(' · ') ?? '';
  log(`opening a Claude Code session for ${task.id}`);
  const result = await startSession(root, task, { blockedReason, ...(claude && { claude }), ...(run && { run }) });
  if (!result.started) log(`no session: ${result.message}`);
  return result.started ? result.code : 0;
}

function handleDone(root, rest, after, { log, refOrCurrent }) {
  const { task, tests, finished } = finishTask(root, refOrCurrent(rest[0]), after);
  log(tests.tail);
  if (!finished) {
    log(`tests failed (exit ${tests.status}); ${task.id} NOT done. Full output: ${tests.log}`);
    return tests.status || 1;
  }
  log(`done ${task.id} ${task.title}`);
  return 0;
}

async function handleReview(root, rest, after, { log, refOrCurrent }) {
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

export async function main(argv, { root = projectRoot(), log = console.log, session = canOpenSession(), claude, run } = {}) {
  const sep = argv.indexOf('--');
  const args = sep < 0 ? [...argv] : argv.slice(0, sep);
  const after = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
  const [command, ...rest] = args;
  const refOrCurrent = (ref) => ref ?? currentTaskOf(root)?.id ?? fail('no task is in progress; pass an id');

  switch (command) {
    case 'add': {
      const scope = option(rest, '--scope') ?? '';
      const task = addTask(root, rest.join(' '), { scope });
      log(`added ${task.path} (queued in ${STATE_DIR}/next.md); complete the behavior, scenarios, test strategy and cases, create the spec and plan, then start it`);
      return 0;
    }
    case 'list':
    case 'board': {
      ensureBoard(root);
      const state = rest[0];
      if (state && !STATES.includes(state)) fail(`unknown state ${state}: use ${STATES.join(', ')}`);
      log(state ? stateText(root, state) : boardText(root));
      return 0;
    }
    case 'current': {
      ensureBoard(root);
      const [task] = tasksIn(root, 'current');
      if (!task) {
        log(`no task is in progress; start one with \`tasks start <id>\`\n\n${stateText(root, 'next')}`);
        return 0;
      }
      log(`current: ${task.id} ${task.title}${task.extra ? ` · ${task.extra}` : ''}\nfile: ${task.path}\n\n${task.text.trim()}`);
      return 0;
    }
    case 'next':
    case 'blocked':
      ensureBoard(root);
      log(stateText(root, command));
      return 0;
    case 'show':
      log(findTask(root, refOrCurrent(rest[0])).text);
      return 0;
    case 'start':
      return handleStart(root, rest, { log, session, claude, run });
    case 'block': {
      const task = blockTask(root, rest[0] ?? fail('usage: tasks block <id> <reason>'), rest.slice(1).join(' '));
      log(`blocked ${task.id}`);
      return 0;
    }
    case 'done':
      return handleDone(root, rest, after, { log, refOrCurrent });
    case 'review':
      return handleReview(root, rest, after, { log, refOrCurrent });
    default:
      log(USAGE);
      return command && command !== 'help' ? 2 : 0;
  }
}

// Node resolves symlinks in import.meta.url but not in argv[1]; compare real
// paths so this still runs when the project path goes through a symlink.
const entryPath = () => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ?? '';
  }
};

if (import.meta.url === pathToFileURL(entryPath()).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    console.error(`tasks: ${error.message}`);
    process.exitCode = 2;
  }
}
